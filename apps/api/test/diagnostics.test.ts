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
  it.each(["window", "owner"])("shows collection gaps in %s candidate-only text and JSONL reports", mode => {
    const f = fixture(), first = f.event();
    f.journal.append(f.c, [{ ...first, type: "diagnostic.collection", data: { disabledAtMs: f.clock.now - 1000, resumedAtMs: f.clock.now, discardedCount: 0 } }]);
    const report = buildDiagnosticReport(f.db, f.journal.db, mode === "window" ? { from: f.c.created_at, to: f.clock.now } : { owner: diagnosticOwnerId(f.owner) });
    expect(report.candidates[0]).toMatchObject({ collectionGaps: 1, errors: 0, lossEvents: 0 });
    expect(report.warnings).toContain(`${f.c.id}: collection_disabled`);
    expect(formatDiagnosticReport(report, "text")).toContain("collection_gaps=1");
    expect(formatDiagnosticReport(report, "text")).toContain(`INCOMPLETE: ${f.c.id}: collection_disabled`);
    expect(JSON.parse(formatDiagnosticReport(report, "jsonl").trim()).warnings).toContain(`${f.c.id}: collection_disabled`);
  });
  it.each(["clock", "wall", "monotonic"])("keeps schema-valid unrenderable %s times from breaking reports", async mode => {
    const f = fixture(), first = f.event(1, mode === "wall" ? { wallMs: Number.MAX_SAFE_INTEGER } :
      mode === "clock" ? { type: "diagnostic.clock", data: { offsetMs: 1e308, uncertaintyMs: 0 } } : {});
    const second = { ...f.event(2), streamId: first.streamId, ...(mode === "monotonic" ? { monoMs: Number.MAX_SAFE_INTEGER } : {}) };
    await f.post([first, second]).expect(200);
    const report = buildDiagnosticReport(f.db, f.journal.db, { conversationId: f.c.id });
    expect(report.events!.filter(e => e.streamId === first.streamId)).toHaveLength(2);
    expect(report.warnings.some(w => w.endsWith(": time_estimate_invalid"))).toBe(true);
    const text = formatDiagnosticReport(report, "text");
    expect(text).toContain("time=unknown"); expect(text).toContain("transcript.fragment");
    const events = formatDiagnosticReport(report, "jsonl").trim().split("\n").slice(1).map(line => JSON.parse(line));
    expect(events.some(e => e.estimatedAt === null && e.relativeMs === null)).toBe(true);
  });
  it("reclaims retained text quota after seven days and does not charge text arriving after expiry", () => {
    const f = fixture({ textEnabled: true, maxBytes: 17000, conversationMaxBytes: 16000, logger: { error() {} } });
    const events = Array.from({ length: 3 }, (_, i) => f.event(i + 1, { text: "Ж".repeat(1800) }));
    f.journal.append(f.c, events);
    expect(() => f.journal.append(f.c, [f.event(4, { text: "Ж".repeat(1800) })])).toThrow("diagnostics_limit");
    const before = f.journal.db.prepare("SELECT bytes,browser_bytes FROM diagnostic_conversations WHERE id=?").get(f.c.id)!;
    f.clock.now += DIAGNOSTIC_TEXT_RETENTION_MS + 1;
    f.journal.db.exec("CREATE TRIGGER reject_text_purge BEFORE DELETE ON diagnostic_text BEGIN SELECT RAISE(ABORT,'purge rollback'); END");
    expect(() => f.journal.prune()).toThrow("purge rollback");
    expect(f.journal.db.prepare("SELECT bytes,browser_bytes FROM diagnostic_conversations WHERE id=?").get(f.c.id)).toEqual(before);
    expect(f.journal.db.prepare("SELECT COUNT(*) AS n FROM diagnostic_text").get()!.n).toBe(3);
    f.journal.db.exec("DROP TRIGGER reject_text_purge"); f.journal.prune();
    const after = f.journal.db.prepare("SELECT bytes,browser_bytes FROM diagnostic_conversations WHERE id=?").get(f.c.id)!;
    expect(Number(before.bytes) - Number(after.bytes)).toBe(3 * (Buffer.byteLength(JSON.stringify(events[0]!.text)) + 8));
    expect(after.bytes).toBe(after.browser_bytes);
    f.journal.prune();
    expect(f.journal.db.prepare("SELECT bytes FROM diagnostic_conversations WHERE id=?").get(f.c.id)!.bytes).toBe(after.bytes);
    expect(() => f.journal.append(f.c, [f.event(5, { text: "Ж".repeat(5000) })])).not.toThrow();
    expect(f.journal.db.prepare("SELECT COUNT(*) AS n FROM diagnostic_text").get()!.n).toBe(0);
    expect(() => f.journal.append(f.c, [f.event(6, { source: "server", type: "server.conversation", data: { status: "ended", version: 2 } })])).not.toThrow();
  });
  it.each([false, true])("reconciles legacy quota with text already removed=%s on migration and reopen", removed => {
    const directory = mkdtempSync(join(tmpdir(), "diagnostics-quota-migration-")); resources.push(() => rmSync(directory, { recursive: true, force: true }));
    const f = fixture(), path = join(directory, "events.sqlite"), event = f.event(1, { text: "MIGRATION_CANARY".repeat(100) });
    const old = new DiagnosticJournal(path, { textEnabled: true, automatic: false, now: () => f.clock.now });
    old.append(f.c, [event]); old.close();
    const legacy = new DatabaseSync(path);
    if (legacy.prepare("SELECT 1 FROM pragma_table_info('diagnostic_text') WHERE name='bytes'").get()) legacy.exec("ALTER TABLE diagnostic_text DROP COLUMN bytes");
    if (removed) legacy.exec("DELETE FROM diagnostic_text");
    legacy.close();
    f.clock.now += DIAGNOSTIC_TEXT_RETENTION_MS + 1;
    const technical = { ...event }; delete technical.text;
    const expected = Buffer.byteLength(JSON.stringify(technical)) + 256;
    for (let reopen = 0; reopen < 2; reopen++) {
      const disk = new DiagnosticJournal(path, { textEnabled: true, automatic: false, now: () => f.clock.now });
      try {
        expect(disk.db.prepare("SELECT bytes,browser_bytes FROM diagnostic_conversations WHERE id=?").get(f.c.id)).toEqual({ bytes: expected, browser_bytes: expected });
        expect(disk.db.prepare("SELECT COUNT(*) AS n FROM diagnostic_text").get()!.n).toBe(0);
      } finally { disk.close(); }
    }
  });
  it("records committed provider dispatch without a creation result and discards rolled-back dispatch", async () => {
    const f = fixture();
    f.db.exec("CREATE TRIGGER reject_dispatch BEFORE UPDATE OF provider_request_dispatched_at ON live_sessions BEGIN SELECT RAISE(ABORT,'test rollback'); END");
    expect(() => f.ledger.dispatchProviderAttempt(f.owner, f.id, f.c.version, randomUUID(), f.clock.now + 900000)).toThrow("test rollback");
    await f.journal.flushServerEvents();
    expect(f.journal.db.prepare("SELECT 1 FROM diagnostic_events WHERE json_extract(data_json,'$.phase')='dispatched'").get()).toBeUndefined();
    f.db.exec("DROP TRIGGER reject_dispatch");
    f.ledger.dispatchProviderAttempt(f.owner, f.id, f.c.version, randomUUID(), f.clock.now + 900000);
    await f.journal.flushServerEvents();
    const report = buildDiagnosticReport(f.db, f.journal.db, { conversationId: f.c.id });
    expect(report.events!.filter(event => event.type === "server.attempt").at(-1)).toMatchObject({ liveSessionId: f.id, data: { state: "creating", phase: "dispatched" } });
    expect(f.ledger.getAttemptInternal(f.id).openai_session_id).toBeNull();
  });
  it("shows recorded losses and no-output timeouts in search-only text and JSONL reports", () => {
    const f = fixture(), first = f.event();
    f.journal.append(f.c, [
      { ...first, type: "diagnostic.loss", data: { reason: "queue_overflow", count: 4 } },
      { ...first, seq: 2, type: "turn.timer", data: { timer: "no_output", phase: "fired" } },
    ]);
    const report = buildDiagnosticReport(f.db, f.journal.db, { from: f.c.created_at, to: f.clock.now });
    expect(report.candidates[0]).toMatchObject({ errors: 2, lossEvents: 1, noOutputTimeouts: 1 });
    expect(report.warnings).toContain(`${f.c.id}: events_lost`);
    expect(formatDiagnosticReport(report, "text")).toContain("loss_events=1 no_output_timeouts=1");
    expect(JSON.parse(formatDiagnosticReport(report, "jsonl").trim()).warnings).toContain(`${f.c.id}: events_lost`);
  });
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
    vi.useFakeTimers({ toFake: ["setTimeout", "clearTimeout"] }); resources.push(() => { vi.useRealTimers(); });
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
  it("distinguishes retryable cleanup from the committed exhaustion transition", async () => {
    const f = fixture();
    f.ledger.dispatchProviderAttempt(f.owner, f.id, f.c.version, randomUUID(), f.clock.now + 900000);
    f.ledger.recordProviderCreated(f.id, randomUUID()); f.ledger.requestCleanup(f.id, "abandoned_connect");
    f.ledger.recordCleanupFailure(f.id, "retryable_error", "temporary");
    f.clock.now = f.ledger.getAttemptInternal(f.id).cleanup_retry_expires_at! + 1;
    f.ledger.exhaustCleanup(f.id); await f.journal.flushServerEvents();
    const report = buildDiagnosticReport(f.db, f.journal.db, { conversationId: f.c.id, now: f.clock.now });
    const records = report.events!.filter(event => event.type === "server.attempt" && event.liveSessionId === f.id);
    expect(records.at(-2)!.data).toMatchObject({ state: "unknown", cleanupResult: "retryable_error", cleanupExhausted: false });
    expect(records.at(-1)!.data).toMatchObject({ state: "unknown", cleanupResult: "retryable_error", cleanupExhausted: true });
    expect(formatDiagnosticReport(report, "text")).toContain('"cleanupExhausted":true');
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
  it("charges duplicate traffic until the network budget is exhausted without duplicating storage, then resets at UTC midnight", async () => {
    const f = fixture({ maxBytes: 15000, conversationMaxBytes: 4000, logger: { error() {} } }); await f.journal.flushServerEvents();
    const first = f.event(), source = "same-network", size = Buffer.byteLength(JSON.stringify(first)) + 256;
    f.journal.append(f.c, [first], source);
    const storage = f.journal.db.prepare("SELECT bytes,browser_bytes FROM diagnostic_conversations WHERE id=?").get(f.c.id);
    let accepted = 1;
    for (; accepted < 20; accepted++) {
      try { f.journal.append(f.c, [first], source); }
      catch (error) { expect(error).toHaveProperty("code", "diagnostics_limit"); break; }
    }
    expect(accepted).toBe(Math.floor(4000 / size));
    expect(f.journal.db.prepare("SELECT bytes FROM diagnostic_ingress WHERE source_key=?").get(source)!.bytes).toBe((accepted + 1) * size);
    expect(f.journal.db.prepare("SELECT bytes,browser_bytes FROM diagnostic_conversations WHERE id=?").get(f.c.id)).toEqual(storage);
    expect(f.journal.db.prepare("SELECT COUNT(*) AS n FROM diagnostic_events WHERE stream_id=?").get(first.streamId)!.n).toBe(1);
    f.clock.now += 86400000;
    expect(f.journal.append(f.c, [first], source).accepted).toEqual([{ streamId: first.streamId, seq: first.seq }]);
    expect(f.journal.db.prepare("SELECT bytes FROM diagnostic_ingress WHERE source_key=? AND window_start=?")
      .get(source, Math.floor(f.clock.now / 86400000) * 86400000)!.bytes).toBe(size);
  });
  it("keeps received-traffic charges when a new stored event is rolled back by capacity", async () => {
    const f = fixture({ logger: { error() {} } }); await f.journal.flushServerEvents();
    f.journal.options.maxBytes = 1;
    const event = f.event(), source = "received-but-not-stored";
    expect(() => f.journal.append(f.c, [event], source)).toThrow("diagnostics_limit");
    expect(f.journal.db.prepare("SELECT bytes FROM diagnostic_ingress WHERE source_key=?").get(source)!.bytes).toBe(Buffer.byteLength(JSON.stringify(event)) + 256);
    expect(f.journal.db.prepare("SELECT 1 FROM diagnostic_events WHERE stream_id=?").get(event.streamId)).toBeUndefined();
  });
  it.each(["data", "wall", "mono", "build"])("rejects duplicate %s changes before applying a text removal", async field => {
    const f = fixture({ textEnabled: true }), first = f.event(1, { text: "PRIVATE_CANARY" });
    await f.post([first]).expect(200);
    const scrubbed = { ...first, textRemoved: true }; delete scrubbed.text;
    const changed = field === "data" ? { data: { ...first.data, charCount: 8 } } : field === "wall" ? { wallMs: first.wallMs + 1 }
      : field === "mono" ? { monoMs: first.monoMs + 1 } : { clientBuildId: "different-build" };
    await f.post([{ ...scrubbed, ...changed }]).expect(409);
    expect(f.journal.db.prepare("SELECT text FROM diagnostic_text WHERE stream_id=? AND seq=1").get(first.streamId)!.text).toBe("PRIVATE_CANARY");
    expect(f.journal.db.prepare("SELECT text_expected FROM diagnostic_events WHERE stream_id=? AND seq=1").get(first.streamId)!.text_expected).toBe(1);
  });
  it.each([undefined, false, true])("rejects duplicate truncation changes from %s without altering stored evidence", async textTruncated => {
    const f = fixture({ textEnabled: true }), first = f.event(1, { text: "PRIVATE_CANARY", textTruncated });
    await f.post([first]).expect(200);
    const stored = f.journal.db.prepare("SELECT * FROM diagnostic_events WHERE stream_id=? AND seq=1").get(first.streamId);
    await f.post([{ ...first, textTruncated: Boolean(textTruncated) }]).expect(200);
    await f.post([{ ...first, textTruncated: textTruncated || undefined }]).expect(200);
    const next = { ...first, seq: 2 };
    for (const changed of textTruncated ? [false, undefined] : [true]) {
      const response = await f.post([next, { ...first, textTruncated: changed }]).expect(409);
      expect(response.body.code).toBe("diagnostics_identity_conflict");
    }
    expect(f.journal.db.prepare("SELECT * FROM diagnostic_events WHERE stream_id=? AND seq=1").get(first.streamId)).toEqual(stored);
    expect(f.journal.db.prepare("SELECT 1 FROM diagnostic_events WHERE stream_id=? AND seq=2").get(first.streamId)).toBeUndefined();
    expect(f.journal.db.prepare("SELECT text FROM diagnostic_text WHERE stream_id=? AND seq=1").get(first.streamId)!.text).toBe("PRIVATE_CANARY");
    const report = buildDiagnosticReport(f.db, f.journal.db, { conversationId: f.c.id });
    expect(report.warnings.includes(`${first.streamId}:1: text_truncated`)).toBe(Boolean(textTruncated));
  });
  it("atomically removes duplicate text and releases its quota once without changing technical evidence", async () => {
    const f = fixture({ textEnabled: true }); await f.journal.flushServerEvents();
    const first = f.event(1, { text: "PRIVATE_CANARY".repeat(100), textTruncated: true });
    await f.post([first]).expect(200);
    const stored = f.journal.db.prepare("SELECT * FROM diagnostic_events WHERE stream_id=? AND seq=1").get(first.streamId)!;
    const charge = Number(f.journal.db.prepare("SELECT bytes FROM diagnostic_text WHERE stream_id=? AND seq=1").get(first.streamId)!.bytes);
    const counters = () => f.journal.db.prepare("SELECT bytes,browser_bytes FROM diagnostic_conversations WHERE id=?").get(f.c.id)!;
    const before = counters(), scrubbed = { ...first, textRemoved: true }; delete scrubbed.text; delete scrubbed.textTruncated;
    f.journal.options.maxBytes = Number(before.bytes) / 0.9 + 1;
    await f.post([scrubbed, { ...scrubbed, monoMs: first.monoMs + 1 }]).expect(409);
    expect(counters()).toEqual(before);
    expect(f.journal.db.prepare("SELECT * FROM diagnostic_events WHERE stream_id=? AND seq=1").get(first.streamId)).toEqual(stored);
    expect(f.journal.db.prepare("SELECT 1 FROM diagnostic_text WHERE stream_id=? AND seq=1").get(first.streamId)).toBeTruthy();
    const next = { ...f.event(2), streamId: first.streamId, type: "audio.state", data: { phase: "capture_ready" } };
    await f.post([scrubbed, next]).expect(200);
    const added = Buffer.byteLength(JSON.stringify(next)) + 256, after = counters();
    expect(after).toEqual({ bytes: Number(before.bytes) - charge + added, browser_bytes: Number(before.browser_bytes) - charge + added });
    expect(f.journal.db.prepare("SELECT * FROM diagnostic_events WHERE stream_id=? AND seq=1").get(first.streamId)).toEqual({ ...stored, text_expected: 2, text_truncated: 0 });
    await f.post([scrubbed, first]).expect(200);
    expect(counters()).toEqual(after);
    expect(f.journal.db.prepare("SELECT 1 FROM diagnostic_text WHERE stream_id=? AND seq=1").get(first.streamId)).toBeUndefined();
    const report = buildDiagnosticReport(f.db, f.journal.db, { conversationId: f.c.id });
    expect(report.events).toContainEqual(expect.objectContaining({ streamId: first.streamId, seq: 1, textStatus: "removed", textRemoved: true }));
    expect(report.warnings).not.toContain(`${first.streamId}:1: text_truncated`);
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
    const otherOwner = randomUUID(), other = f.ledger.createConversation(otherOwner, randomUUID(), "other"), otherAttempt = randomUUID();
    f.ledger.registerAttempt(otherOwner, { conversationId: other.id, conversationVersion: other.version, liveSessionId: otherAttempt,
      initialMode: "interpreter", startReason: "initial", fingerprint: "other" });
    await f.post([f.event(1, { liveSessionId: otherAttempt })]).expect(404);
    await f.post([f.event(1, { conversationId: other.id })]).expect(404);
    await f.post([f.event(1, { source: "server" })]).expect(400);
    await request(f.app).post(`/api/conversations/${f.c.id}/diagnostics`).set("Origin", origin).set("Cookie", `live-translator-dev=${f.owner}`)
      .set("Content-Type", "application/json").send('{"text":"PRIVATE_CANARY"').expect(400);
    await f.post([{ ...f.event(), sdp: "SECRET" }]).expect(400);
    await f.post([{ ...f.event(), attemptStatus: "registered" }]).expect(400);
    await f.post([{ ...f.event(), data: { kind: "input", fragmentId: randomUUID(), charCount: 1, raw: "SECRET" } }]).expect(400);
    await f.post([f.event(1, { type: "server.conversation", data: { status: "ended", version: 2 } })]).expect(400);
    expect(f.journal.db.prepare("SELECT COUNT(*) AS n FROM diagnostic_events WHERE source='browser'").get()!.n).toBe(0);
  });
  it("keeps technical mode content-free, permits only explicit text event types, and freezes stream identity", async () => {
    const f = fixture();
    await f.post([f.event(1, { text: "PRIVATE_CANARY" })]).expect(400);
    await f.post([f.event(1, { textRemoved: true, text: "PRIVATE_CANARY" })]).expect(400);
    await f.post([f.event(1, { textRemoved: true, type: "audio.state", data: { phase: "capture_ready" } })]).expect(400);
    await f.post([{ ...f.event(), textRemoved: "PRIVATE_CANARY" }]).expect(400);
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
