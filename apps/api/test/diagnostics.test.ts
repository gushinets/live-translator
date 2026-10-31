import { randomUUID } from "node:crypto";
import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import request from "supertest";
import { afterEach, describe, expect, it } from "vitest";
import { createApp } from "../src/app.js";
import { UsageLedger } from "../src/accounting/UsageLedger.js";
import { openUsageDatabase } from "../src/persistence/database.js";
import { DiagnosticJournal, diagnosticOwnerId, DIAGNOSTIC_RETENTION_MS, DIAGNOSTIC_TEXT_RETENTION_MS } from "../src/diagnostics/DiagnosticJournal.js";
import { buildDiagnosticReport, formatDiagnosticReport } from "../src/reports/diagnostics.js";
import type { DiagnosticEvent } from "../../../types/diagnostics.js";

const origin = "http://localhost:5173", resources: Array<() => void> = [];
afterEach(() => { for (const close of resources.splice(0).reverse()) close(); });
function fixture(options: ConstructorParameters<typeof DiagnosticJournal>[1] = {}) {
  const clock = { now: Date.now() };
  const db = openUsageDatabase(":memory:"); resources.push(() => db.close());
  const ledger = new UsageLedger(db, { now: () => clock.now });
  const journal = new DiagnosticJournal(":memory:", { automatic: false, now: () => clock.now, ...options }); resources.push(() => journal.close());
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
  it("emits committed watchdog expiry, never rolled-back transitions or observer failures into product results", () => {
    const f = fixture();
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
