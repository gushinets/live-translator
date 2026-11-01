import { randomUUID } from "node:crypto";
import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { DatabaseSync } from "node:sqlite";
import request from "supertest";
import { afterEach, describe, expect, it, vi } from "vitest";
import { createApp } from "../src/app.js";
import { UsageLedger } from "../src/accounting/UsageLedger.js";
import { openUsageDatabase } from "../src/persistence/database.js";
import { DiagnosticJournal, diagnosticOwnerId, DIAGNOSTIC_RETENTION_MS, DIAGNOSTIC_TEXT_RETENTION_MS } from "../src/diagnostics/DiagnosticJournal.js";
import { buildDiagnosticReport, formatDiagnosticReport } from "../src/reports/diagnostics.js";
import type { DiagnosticEvent } from "../../../types/diagnostics.js";
import { apiConfig } from "../src/config.js";

const origin = "http://localhost:5173", resources: Array<() => void | Promise<void>> = [];
afterEach(async () => { for (const close of resources.splice(0).reverse()) await close(); });
function fixture(options: ConstructorParameters<typeof DiagnosticJournal>[1] = {}) {
  const clock = { now: Date.now() };
  const db = openUsageDatabase(":memory:"); resources.push(() => db.close());
  const ledger = new UsageLedger(db, { now: () => clock.now });
  const journal = new DiagnosticJournal(":memory:", { automatic: false, now: () => clock.now, ...options }); resources.push(async () => { await journal.flushServerEvents(); journal.close(); });
  const app = createApp({ ledger, diagnostics: journal, startWorker: false });
  const owner = randomUUID(), c = ledger.createConversation(owner, randomUUID(), "diagnostic-test");
  const id = randomUUID();
  ledger.registerAttempt(owner, { conversationId: c.id, conversationVersion: c.version, liveSessionId: id, initialMode: "interpreter", startReason: "initial", fingerprint: "test" });
  const event = (seq = 1, extra: Partial<DiagnosticEvent> = {}): DiagnosticEvent => ({ schemaVersion: 1, source: "browser", conversationId: c.id,
    liveSessionId: id, streamId: randomUUID(), seq, wallMs: clock.now, monoMs: seq, type: "transcript.fragment",
    data: { kind: "input", fragmentId: randomUUID(), charCount: 7, startMs: 100, endMs: 200 }, ...extra } as DiagnosticEvent);
  const post = (events: unknown[], cookie = `live-translator-dev=${owner}`, endpoint = c.id) => request(app).post(`/api/conversations/${endpoint}/diagnostics`).set("Origin", origin).set("Cookie", cookie).send({ schemaVersion: 1, events });
  return { clock, db, ledger, journal, app, owner, c, id, event, post };
}
describe("conversation diagnostic ingestion", () => {
  it("returns committed ledger results before diagnostic SQLite writes and preserves transition snapshots", async () => {
    const f = fixture(); await f.journal.flushServerEvents();
    const append = vi.spyOn(f.journal, "append"), before = f.clock.now;
    const paused = f.ledger.pauseConversation(f.owner, f.c.id, f.c.version);
    f.clock.now += 100; f.ledger.endConversation(f.owner, f.c.id, paused.version, "user_end");
    expect(append).not.toHaveBeenCalled();
    expect(f.ledger.getConversation(f.owner, f.c.id).status).toBe("ended");
    await f.journal.flushServerEvents();
    const records = f.journal.db.prepare("SELECT wall_ms,data_json FROM diagnostic_events WHERE type='server.conversation' ORDER BY seq").all();
    expect(records.slice(-2).map(row => JSON.parse(String(row.data_json)))).toMatchObject([{ status: "paused" }, { status: "ended" }]);
    expect(records.at(-2)!.wall_ms).toBe(before); expect(records.at(-1)!.wall_ms).toBe(before + 100);
  });
  it("bounds server observations and persists overflow counts on the affected stream", async () => {
    const error = vi.fn(), f = fixture({ logger: { error } }); await f.journal.flushServerEvents();
    for (let version = 1; version <= 1002; version++) f.journal.record(f.c, "server.conversation", { status: "active", version });
    await f.journal.flushServerEvents();
    const loss = f.journal.db.prepare("SELECT stream_id,data_json FROM diagnostic_events WHERE type='diagnostic.loss'").get()!;
    expect(JSON.parse(String(loss.data_json))).toEqual({ reason: "queue_overflow", count: 2, affectedStreamId: loss.stream_id });
    expect(error).toHaveBeenCalled();
  });
  it("retries the final server loss after a transient lock without another observation", async () => {
    vi.useFakeTimers({ toFake: ["setTimeout", "clearTimeout"] }); resources.push(() => vi.useRealTimers());
    const directory = mkdtempSync(join(tmpdir(), "diagnostic-lock-")); resources.push(() => rmSync(directory, { recursive: true, force: true }));
    const path = join(directory, "events.sqlite"), journal = new DiagnosticJournal(path, { automatic: false, logger: { error() {} } }); resources.push(() => journal.close());
    const locked = new DatabaseSync(path); resources.push(() => locked.close());
    expect(journal.db.prepare("PRAGMA busy_timeout").get()!.timeout).toBe(0);
    const conversation = { id: randomUUID(), anonymous_user_id: randomUUID(), created_at: Date.now() };
    const append = vi.spyOn(journal, "append");
    locked.exec("BEGIN IMMEDIATE"); journal.record(conversation, "server.conversation", { status: "active", version: 1 });
    const drain = journal.flushServerEvents();
    let drained = false; void drain.then(() => { drained = true; });
    await new Promise<void>(resolve => setImmediate(resolve));
    await new Promise<void>(resolve => setImmediate(resolve));
    await vi.advanceTimersByTimeAsync(249);
    expect(drained).toBe(false); expect(append).toHaveBeenCalledTimes(2);
    locked.exec("COMMIT");
    await vi.advanceTimersByTimeAsync(1);
    await drain;
    const loss = journal.db.prepare("SELECT data_json FROM diagnostic_events WHERE type='diagnostic.loss'").get()!;
    expect(JSON.parse(String(loss.data_json))).toMatchObject({ reason: "storage_unavailable", count: 1 });
    expect(append).toHaveBeenCalledTimes(3);
    expect(append.mock.calls[2]![1]).toEqual(append.mock.calls[1]![1]);
  });
  it("marks missing and limited readable journals when listing text-mode candidates", async () => {
    const f = fixture();
    const missing = buildDiagnosticReport(f.db, f.journal.db, { from: f.c.created_at - 1, to: f.c.created_at + 1 });
    expect(formatDiagnosticReport(missing, "text")).toContain(`INCOMPLETE: ${f.c.id}: journal_missing`);
    await f.journal.flushServerEvents();
    f.journal.db.prepare("UPDATE diagnostic_conversations SET limited=1 WHERE id=?").run(f.c.id);
    const limited = buildDiagnosticReport(f.db, f.journal.db, { from: f.c.created_at - 1, to: f.c.created_at + 1 });
    expect(formatDiagnosticReport(limited, "text")).toContain(`INCOMPLETE: ${f.c.id}: storage_limit_reached`);
  });
  it("continues retention maintenance of an existing database while collection is disabled", async () => {
    const directory = mkdtempSync(join(tmpdir(), "diagnostics-disabled-")); resources.push(() => rmSync(directory, { recursive: true, force: true }));
    const f = fixture(), path = join(directory, "events.sqlite"), now = Date.now(); let clock = now - 31 * 86400000;
    const disk = new DiagnosticJournal(path, { automatic: false, textEnabled: true, now: () => clock });
    const stale = { ...f.c, created_at: clock }, older = f.event(1, { text: "PRIVATE_CANARY", wallMs: clock });
    disk.append(stale, [older]);
    clock = now - 8 * 86400000;
    const recent = { ...f.c, id: randomUUID(), created_at: clock };
    disk.append(recent, [f.event(1, { conversationId: recent.id, text: "PRIVATE_CANARY", wallMs: clock })]); disk.close();
    const original = apiConfig.diagnosticsDbPath; let app: ReturnType<typeof createApp>;
    try { apiConfig.diagnosticsDbPath = path; app = createApp({ ledger: f.ledger, diagnosticsEnabled: false, startWorker: false }); }
    finally { apiConfig.diagnosticsDbPath = original; }
    const maintenance = app.locals.diagnostics as DiagnosticJournal; resources.push(() => maintenance.close());
    expect((await request(app).get("/api/policy")).body.diagnostics.enabled).toBe(false);
    expect(maintenance.db.prepare("SELECT COUNT(*) AS n FROM diagnostic_text").get()!.n).toBe(0);
    expect(maintenance.db.prepare("SELECT id FROM diagnostic_conversations").all()).toEqual([{ id: recent.id }]);
    expect(f.ledger.diagnosticJournal).toBeUndefined();
    await request(app).post(`/api/conversations/${f.c.id}/diagnostics`).set("Origin", origin).send({}).expect(404);
  });
  it("observes committed cleanup rearming including its cause", async () => {
    const f = fixture();
    f.ledger.dispatchProviderAttempt(f.owner, f.id, f.c.version, randomUUID(), f.clock.now + 900000);
    f.ledger.recordProviderCreated(f.id, randomUUID()); f.ledger.requestCleanup(f.id, "abandoned_connect");
    f.ledger.recordCleanupFailure(f.id, "blocked_auth_config", "auth");
    f.ledger.rearmBlockedCleanup("credential_refresh");
    await f.journal.flushServerEvents();
    const records = f.journal.db.prepare("SELECT data_json FROM diagnostic_events WHERE live_session_id=? ORDER BY seq").all(f.id).map(row => JSON.parse(String(row.data_json)));
    expect(records.at(-1)).toMatchObject({ phase: "rearmed", rearmCause: "credential_refresh" });
    expect(records.at(-1)).not.toHaveProperty("cleanupResult");
  });
  it("limits an owner's aggregate browser traffic and a rotating-cookie network source, preserving server capacity", async () => {
    const f = fixture({ maxBytes: 15000, conversationMaxBytes: 4000, logger: { error() {} } });
    const make = (owner: string) => f.ledger.createConversation(owner, randomUUID(), "quota-test");
    const send = (c: typeof f.c, seq: number, sourceKey?: string) => f.journal.append(c, [f.event(seq, { conversationId: c.id,
      liveSessionId: undefined, streamId: randomUUID(), text: undefined, data: { kind: "input", fragmentId: randomUUID(), charCount: 7 } })], sourceKey);
    const first = make(f.owner), second = make(f.owner);
    for (let i = 1; i <= 4; i++) send(first, i);
    for (let i = 1; i <= 3; i++) send(second, i);
    expect(() => send(second, 4)).toThrow("diagnostics_limit");
    const network = "hashed-network", distinct = [make(randomUUID()), make(randomUUID())];
    for (let i = 1; i <= 4; i++) send(distinct[0]!, i, network);
    for (let i = 1; i <= 3; i++) send(distinct[1]!, i, network);
    expect(() => send(distinct[1]!, 4, network)).toThrow("diagnostics_limit");
    f.journal.record(distinct[1]!, "server.conversation", { status: "ended", version: 2, reason: "user_end" });
    await f.journal.flushServerEvents();
    expect(f.journal.db.prepare("SELECT 1 FROM diagnostic_events WHERE conversation_id=? AND source='server' AND json_extract(data_json,'$.status')='ended'").get(distinct[1]!.id)).toBeTruthy();
  });
  it("publishes capability, acknowledges only committed events, deduplicates and accepts out-of-order delivery", async () => {
    const f = fixture();
    expect((await request(f.app).get("/api/policy")).body.diagnostics).toEqual({ enabled: true, textEnabled: false, schemaVersion: 1 });
    const first = f.event(1), second = { ...first, seq: 2 };
    await f.post([second, first]).expect(200);
    await f.post([first, second]).expect(200);
    expect(f.journal.db.prepare("SELECT COUNT(*) AS n FROM diagnostic_events WHERE source='browser'").get()!.n).toBe(2);
    expect(f.ledger.getAttemptInternal(f.id).state).toBe("creating");
    expect(f.journal.db.prepare("SELECT owner FROM diagnostic_conversations WHERE id=?").get(f.c.id)!.owner).toBe(diagnosticOwnerId(f.owner));
  });
  it.each([{ maxBytes: 10000, conversationMaxBytes: 20000 }, { maxBytes: 20000, conversationMaxBytes: 10000 }])("reserves lifecycle capacity when browser traffic reaches a journal or conversation limit: %j", async limits => {
    const journal = new DiagnosticJournal(":memory:", { ...limits, automatic: false, logger: { error() {} } }); resources.push(() => journal.close());
    const conversation = { id: randomUUID(), anonymous_user_id: randomUUID(), created_at: Date.now() }, streamId = randomUUID();
    let limited = false;
    for (let seq = 1; seq < 100; seq++) {
      try { journal.append(conversation, [{ schemaVersion: 1, source: "browser", conversationId: conversation.id,
        streamId, seq, wallMs: Date.now(), monoMs: seq, type: "app.lifecycle", data: { phase: "end", generation: 1 } }]); }
      catch (error) { expect(error).toHaveProperty("code", "diagnostics_limit"); limited = true; break; }
    }
    expect(limited).toBe(true);
    journal.record(conversation, "server.conversation", { status: "ended", version: 2, reason: "user_end" });
    await journal.flushServerEvents();
    expect(journal.db.prepare("SELECT COUNT(*) AS n FROM diagnostic_events WHERE source='server'").get()!.n).toBe(1);
  });
  it("keeps the final global reserve free after server events already occupy more than ten percent", async () => {
    const journal = new DiagnosticJournal(":memory:", { maxBytes: 10000, conversationMaxBytes: 20000, automatic: false, logger: { error() {} } }); resources.push(() => journal.close());
    const conversation = { id: randomUUID(), anonymous_user_id: randomUUID(), created_at: Date.now() }, streamId = randomUUID();
    for (let i = 0; i < 5; i++) journal.record(conversation, "server.conversation", { status: "active", version: 1 });
    await journal.flushServerEvents();
    for (let seq = 1; seq < 100; seq++) {
      try { journal.append(conversation, [{ schemaVersion: 1, source: "browser", conversationId: conversation.id, streamId, seq,
        wallMs: Date.now(), monoMs: seq, type: "app.lifecycle", data: { phase: "start", generation: 1 } }]); }
      catch (error) { expect(error).toHaveProperty("code", "diagnostics_limit"); break; }
    }
    expect(Number(journal.db.prepare("SELECT SUM(bytes) AS n FROM diagnostic_conversations").get()!.n)).toBeLessThanOrEqual(9000);
    journal.record(conversation, "server.conversation", { status: "ended", version: 2 });
    await journal.flushServerEvents();
    expect(journal.db.prepare("SELECT COUNT(*) AS n FROM diagnostic_events WHERE source='server'").get()!.n).toBe(6);
  });
  it("rejects wrong owner/origin/attempt, server provenance and unknown fields without persisting a batch", async () => {
    const f = fixture();
    await f.post([f.event()], `live-translator-dev=${randomUUID()}`).expect(404);
    await request(f.app).post(`/api/conversations/${f.c.id}/diagnostics`).set("Origin", "https://evil.example").send({}).expect(403);
    await f.post([f.event(1, { liveSessionId: randomUUID() })]).expect(404);
    await f.post([f.event(1, { source: "server" })]).expect(400);
    await request(f.app).post(`/api/conversations/${f.c.id}/diagnostics`).set("Origin", origin).set("Cookie", `live-translator-dev=${f.owner}`)
      .set("Content-Type", "application/json").send('{"text":"PRIVATE_CANARY"').expect(400);
    await f.post([{ ...f.event(), sdp: "SECRET" }]).expect(400);
    await f.post([{ ...f.event(), data: { kind: "input", fragmentId: randomUUID(), charCount: 1, raw: "SECRET" } }]).expect(400);
    await f.post([f.event(1, { type: "server.conversation", data: { status: "ended", version: 2 } })]).expect(400);
    expect(f.journal.db.prepare("SELECT COUNT(*) AS n FROM diagnostic_events WHERE source='browser'").get()!.n).toBe(0);
  });
  it("keeps technical mode content-free, permits only explicit text event types, and freezes stream identity", async () => {
    const f = fixture();
    await f.post([f.event(1, { text: "PRIVATE_CANARY" })]).expect(400);
    const text = fixture({ textEnabled: true }), event = text.event(1, { text: "PRIVATE_CANARY" });
    await text.post([event]).expect(200);
    await text.post([{ ...event, seq: 2, type: "transport.event", data: { type: "error", phase: "received" } }]).expect(400);
    await text.post([{ ...event, seq: 2, liveSessionId: undefined }]).expect(409);
    const metadata = text.journal.db.prepare("SELECT * FROM diagnostic_events WHERE source='browser'").get()!;
    expect(JSON.stringify(metadata)).not.toContain("PRIVATE_CANARY");
    expect(text.journal.db.prepare("SELECT text FROM diagnostic_text").get()!.text).toBe("PRIVATE_CANARY");
  });
  it("bounds batches and retains an explicit marker at a conversation budget limit", async () => {
    const f = fixture({ conversationMaxBytes: 2500 });
    const event = f.event();
    await f.post([event]).expect(200);
    await f.post([{ ...event, seq: 2 }, { ...event, seq: 3 }, { ...event, seq: 4 }]).expect(507);
    expect(f.journal.db.prepare("SELECT limited FROM diagnostic_conversations WHERE id=?").get(f.c.id)!.limited).toBe(1);
    expect(f.journal.db.prepare("SELECT COUNT(*) AS n FROM diagnostic_events WHERE source='browser'").get()!.n).toBe(1);
    await f.post(Array.from({ length: 101 }, () => event)).expect(413);
    await f.post(Array.from({ length: 100 }, () => ({ ...event, text: "x".repeat(500) }))).expect(413);
  });
  it("emits committed watchdog expiry, never rolled-back transitions or observer failures into product results", async () => {
    const f = fixture();
    await f.journal.flushServerEvents();
    const count = () => Number(f.journal.db.prepare("SELECT COUNT(*) AS n FROM diagnostic_events").get()!.n);
    const before = count();
    f.db.exec("CREATE TRIGGER reject_cleanup BEFORE UPDATE ON live_sessions BEGIN SELECT RAISE(ABORT,'test'); END;");
    expect(() => f.ledger.endConversation(f.owner, f.c.id, f.c.version, "user_end")).toThrow();
    expect(count()).toBe(before);
    expect(f.ledger.getConversation(f.owner, f.c.id).status).toBe("active");
    f.db.exec("DROP TRIGGER reject_cleanup");
    f.ledger.pauseConversation(f.owner, f.c.id, f.c.version);
    f.clock.now += 300001;
    f.ledger.watchdog();
    await f.journal.flushServerEvents();
    const phases = f.journal.db.prepare("SELECT data_json FROM diagnostic_events WHERE type='server.conversation' ORDER BY seq").all().map(r => JSON.parse(String(r.data_json)));
    expect(phases.at(-1)).toMatchObject({ status: "ended", reason: "background_timeout" });
    f.journal.db.close();
    expect(() => f.ledger.createConversation(f.owner, randomUUID(), "still-works")).not.toThrow();
  });
  it("expires text and WAL contents after seven days, metadata after thirty, and retries never extend retention", async () => {
    const directory = mkdtempSync(join(tmpdir(), "diagnostics-retention-"));
    resources.push(() => rmSync(directory, { recursive: true, force: true }));
    const f = fixture({ textEnabled: true });
    const disk = new DiagnosticJournal(join(directory, "events.sqlite"), { now: () => f.clock.now, textEnabled: true, automatic: false });
    resources.push(() => disk.close());
    const event = f.event(1, { text: "RETENTION_PRIVATE_CANARY" });
    disk.append(f.c, [event]);
    f.clock.now += DIAGNOSTIC_TEXT_RETENTION_MS + 1;
    disk.prune(); disk.append(f.c, [event, { ...event, seq: 2 }]); disk.prune();
    expect(disk.db.prepare("SELECT COUNT(*) AS n FROM diagnostic_text").get()!.n).toBe(0);
    expect(readFileSync(join(directory, "events.sqlite")).includes(Buffer.from("RETENTION_PRIVATE_CANARY"))).toBe(false);
    expect(readFileSync(join(directory, "events.sqlite-wal")).includes(Buffer.from("RETENTION_PRIVATE_CANARY"))).toBe(false);
    f.clock.now = f.c.created_at + DIAGNOSTIC_RETENTION_MS + 1;
    expect(() => disk.append(f.c, [event])).toThrow("diagnostics_expired");
    disk.prune(); expect(disk.db.prepare("SELECT COUNT(*) AS n FROM diagnostic_events").get()!.n).toBe(0);
  });
  it("finds conversations overlapping a time window and exports gaps, uncertain links and missing completion", () => {
    const f = fixture({ textEnabled: true });
    const first = f.event(2), stream = first.streamId;
    f.journal.append(f.c, [first, { ...first, seq: 3, type: "attribution.decision", data: { generation: randomUUID(), kind: "decision", atMs: f.clock.now, outputId: randomUUID(), basis: "uncertain" } }]);
    const candidates = buildDiagnosticReport(f.db, f.journal.db, { from: f.c.created_at + 5000, to: f.c.created_at + 6000, now: f.clock.now + 10000 });
    expect(candidates.candidates.map(c => c.conversationId)).toContain(f.c.id);
    expect(JSON.stringify(candidates)).not.toContain(f.owner);
    expect(buildDiagnosticReport(f.db, f.journal.db, { owner: diagnosticOwnerId(f.owner), now: f.clock.now }).candidates.map(c => c.conversationId)).toEqual([f.c.id]);
    const report = buildDiagnosticReport(f.db, f.journal.db, { liveSessionId: f.id, now: f.clock.now + 10000 });
    expect(report.warnings).toContain(`${stream}: missing_sequence_1_1`);
    expect(report.warnings?.some(w => w.includes("source_attribution_uncertain"))).toBe(true);
    expect(report.warnings).toContain(`${f.c.id}: journal_end_missing`);
    expect(formatDiagnosticReport(report, "jsonl").split("\n").filter(Boolean).map(line => JSON.parse(line))).toHaveLength(report.events!.length + 1);
  });
});
