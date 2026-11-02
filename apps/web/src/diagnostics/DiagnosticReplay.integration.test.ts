// @vitest-environment node
import { once } from "node:events";
import { IDBFactory } from "fake-indexeddb";
import { afterEach, expect, it, vi } from "vitest";
import { DiagnosticOutbox, IndexedDiagnosticQueue } from "./DiagnosticOutbox";
import { AccountingBackend } from "../api/AccountingBackend";
import { ConversationAccounting } from "../session/ConversationAccounting";
import { MetadataDeliveryBudget } from "../session/MetadataDeliveryBudget";
import { createApp } from "../../../api/src/app";
import { apiConfig } from "../../../api/src/config";
import { UsageLedger } from "../../../api/src/accounting/UsageLedger";
import { openUsageDatabase } from "../../../api/src/persistence/database";
import { DiagnosticJournal } from "../../../api/src/diagnostics/DiagnosticJournal";
import { buildDiagnosticReport, formatDiagnosticReport } from "../../../api/src/reports/diagnostics";
import type { DiagnosticEvent } from "../../../../types/diagnostics.js";

const cleanup: Array<() => void | Promise<void>> = [];
afterEach(async () => {
  for (const close of cleanup.splice(0).reverse()) await close();
  vi.unstubAllGlobals();
  vi.useRealTimers();
});

async function fixture() {
  const indexedDB = new IDBFactory(); vi.stubGlobal("indexedDB", indexedDB);
  const db = openUsageDatabase(":memory:"); cleanup.push(() => db.close());
  const ledger = new UsageLedger(db), journal = new DiagnosticJournal(":memory:", { textEnabled: true, automatic: false });
  cleanup.push(async () => { await journal.flushServerEvents(); journal.close(); });
  const creator = vi.fn(async () => { throw new Error("Provider must not be called"); });
  const app = createApp({ ledger, diagnostics: journal, startWorker: false, createLiveSession: creator });
  const server = app.listen(0, "127.0.0.1");
  cleanup.push(() => new Promise<void>((resolve, reject) => server.close(error => error ? reject(error) : resolve())));
  await once(server, "listening");
  const address = server.address() as { port: number }, owner = crypto.randomUUID(), nativeFetch = globalThis.fetch;
  const state = { offline: false, readbackOffline: true, consent: true, loseReceipt: false }, statuses: number[] = [], batches: DiagnosticEvent[][] = [];
  vi.stubGlobal("fetch", async (url: string, init?: RequestInit) => {
    if (state.offline && (url.startsWith("/api/live/session") && (init?.method === "POST" || state.readbackOffline) || url.endsWith("/diagnostics"))) throw new TypeError("offline");
    const headers = new Headers(init?.headers);
    headers.set("Origin", apiConfig.webOrigin); headers.set("Cookie", `live-translator-dev=${owner}`);
    const response = await nativeFetch(`http://127.0.0.1:${address.port}${url}`, { ...init, headers });
    if (url.endsWith("/diagnostics")) {
      batches.push((JSON.parse(String(init?.body)) as { events: DiagnosticEvent[] }).events);
      statuses.push(response.status);
      if (response.ok && state.loseReceipt) { state.loseReceipt = false; throw new TypeError("receipt lost"); }
    }
    return response;
  });
  const api = new AccountingBackend(), queue = new IndexedDiagnosticQueue();
  const options = { queue, automatic: false, producerId: Promise.resolve("test-tab"),
    storage: { getItem: () => state.consent ? "1" : null } as unknown as Storage };
  const outbox = new DiagnosticOutbox(options); cleanup.push(() => outbox.stop());
  outbox.start(async () => (await api.policy()).diagnostics);
  outbox.configure((await api.policy()).diagnostics);
  const budget = new MetadataDeliveryBudget({ indexedDB, name: crypto.randomUUID() }); cleanup.push(() => budget.close());
  const scope = new ConversationAccounting({ api, budget, diagnostics: outbox, autoDelivery: false });
  return { db, ledger, journal, creator, owner, state, statuses, batches, api, queue, options, outbox, scope, budget };
}

async function committedTextWithoutReceipt() {
  const f = await fixture(), c = await f.api.createConversation(crypto.randomUUID()), stream = f.outbox.stream();
  stream.bind(c.conversationId);
  stream.emit("transcript.fragment", { kind: "input", fragmentId: "private", charCount: 14 }, "PRIVATE_CANARY");
  f.state.loseReceipt = true; await f.outbox.flush(); await f.journal.flushServerEvents();
  expect(f.journal.db.prepare("SELECT text FROM diagnostic_text WHERE stream_id=? AND seq=1").get(stream.id)!.text).toBe("PRIVATE_CANARY");
  return { ...f, c, stream };
}

it.each(["tab", "server"])("delivers %s revocation before a new ordinary row hits storage quota", async revoke => {
  const f = await committedTextWithoutReceipt();
  f.journal.options.maxBytes = Number(f.journal.db.prepare("SELECT SUM(bytes) AS n FROM diagnostic_conversations").get()!.n) / 0.9 + 1;
  f.stream.emit("audio.state", { phase: "capture_ready" });
  if (revoke === "tab") f.state.consent = false; else f.journal.options.textEnabled = false;
  f.outbox.configure((await f.api.policy()).diagnostics);
  await f.outbox.flush(); await f.outbox.flush(); await f.outbox.flush();
  expect(f.batches[1]).toEqual([expect.objectContaining({ streamId: f.stream.id, seq: 1, textRemoved: true })]);
  expect(f.statuses[1]).toBe(200); expect(f.statuses).toContain(507);
  expect(f.journal.db.prepare("SELECT 1 FROM diagnostic_text WHERE stream_id=?").get(f.stream.id)).toBeUndefined();
  const report = buildDiagnosticReport(f.db, f.journal.db, { conversationId: f.c.conversationId });
  expect(report.events).toContainEqual(expect.objectContaining({ streamId: f.stream.id, seq: 1, textStatus: "removed" }));
});

it("keeps an ingress-blocked removal until the network quota resets without losing or duplicating its intent", async () => {
  vi.useFakeTimers({ toFake: ["Date"] }); vi.setSystemTime(Date.UTC(2026, 10, 2, 23, 59));
  const f = await committedTextWithoutReceipt();
  f.state.consent = false;
  f.journal.db.prepare("UPDATE diagnostic_ingress SET bytes=?").run(20971520);
  await f.outbox.flush(); await f.outbox.flush();
  expect(f.statuses.slice(-2)).toEqual([507, 507]); expect(f.stream.enabled).toBe(true);
  expect((await f.queue.read()).map(row => row.event)).toEqual([expect.objectContaining({ seq: 1, textRemoved: true })]);
  vi.setSystemTime(Date.UTC(2026, 10, 3, 0, 0, 1));
  await f.outbox.flush(); await f.outbox.flush();
  expect(f.statuses.at(-1)).toBe(200); expect(await f.queue.read()).toEqual([]);
  expect(f.journal.db.prepare("SELECT 1 FROM diagnostic_text WHERE stream_id=?").get(f.stream.id)).toBeUndefined();
});

it("does not let an uncommitted removal at capacity block removal of already committed text", async () => {
  const f = await committedTextWithoutReceipt();
  f.stream.emit("transcript.fragment", { kind: "input", fragmentId: "unsent", charCount: 14 }, "UNSENT_CANARY");
  await vi.waitFor(async () => expect(await f.queue.read()).toHaveLength(2));
  const rows = await f.queue.read(), committed = rows.find(row => row.event.seq === 1)!;
  await f.queue.put({ ...committed, queuedAt: Math.max(...rows.map(row => row.queuedAt)) + 1 });
  f.journal.options.maxBytes = Number(f.journal.db.prepare("SELECT SUM(bytes) AS n FROM diagnostic_conversations").get()!.n) / 0.9 + 1;
  f.state.consent = false;
  await f.outbox.flush(); await f.outbox.flush(); await f.outbox.flush();
  expect(f.statuses.slice(-2)).toEqual([507, 200]);
  expect(f.journal.db.prepare("SELECT 1 FROM diagnostic_text WHERE stream_id=?").get(f.stream.id)).toBeUndefined();
  f.journal.options.maxBytes = 1073741824;
  await f.outbox.flush(); await f.outbox.flush();
  expect(await f.queue.read()).toEqual([]);
});

it("replays startup under the known conversation after accounting reservation fails", async () => {
  const f = await fixture(), stream = f.outbox.stream(), attempt = f.scope.newAttempt();
  attempt.diagnostics = stream;
  stream.emit("app.lifecycle", { phase: "start", generation: 0 });
  stream.emit("audio.state", { phase: "capture_ready" });
  vi.spyOn(f.budget, "reserve").mockRejectedValueOnce(new Error("Metadata storage unavailable"));
  const create = vi.spyOn(f.api, "createSession");
  f.state.offline = true;
  await expect(attempt.create("never-sent-offer")).rejects.toThrow("Metadata storage unavailable");
  const conversationId = f.scope.conversationId!;
  expect(f.ledger.getConversation(f.owner, conversationId).id).toBe(conversationId);
  stream.retire(); await f.outbox.flush();
  expect((await f.queue.read()).map(row => row.event)).toEqual([
    expect.objectContaining({ conversationId, liveSessionId: attempt.localId, type: "app.lifecycle" }),
    expect.objectContaining({ conversationId, liveSessionId: attempt.localId, type: "audio.state" }),
  ]);
  f.outbox.stop(); f.state.offline = false;
  const replay = new DiagnosticOutbox(f.options); replay.configure((await f.api.policy()).diagnostics);
  await replay.flush(); replay.stop();
  expect(f.statuses).toEqual([200]); expect(await f.queue.read()).toEqual([]);
  const report = buildDiagnosticReport(f.db, f.journal.db, { conversationId });
  expect(report.events).toContainEqual(expect.objectContaining({ streamId: stream.id, liveSessionId: attempt.localId,
    attemptStatus: "unconfirmed", type: "audio.state", data: { phase: "capture_ready" } }));
  expect(f.db.prepare("SELECT 1 FROM live_sessions WHERE id=?").get(attempt.localId)).toBeUndefined();
  expect(attempt.dispatched).toBe(false); expect(create).not.toHaveBeenCalled(); expect(f.creator).not.toHaveBeenCalled();
});

it.each([true, false])("replays unsent startup and reconciles late registration, read-back offline=%s", async readbackOffline => {
  const f = await fixture(), stream = f.outbox.stream(), attempt = f.scope.newAttempt();
  attempt.diagnostics = stream;
  stream.emit("app.lifecycle", { phase: "start", generation: 0 });
  f.state.offline = true; f.state.readbackOffline = readbackOffline;
  await expect(attempt.create("not-sent-offer")).rejects.toThrow("offline");
  await vi.waitFor(() => expect(stream.conversationId).toBeTruthy());
  await f.outbox.flush();
  expect(f.db.prepare("SELECT 1 FROM live_sessions WHERE id=?").get(attempt.localId)).toBeUndefined();
  expect((await f.queue.read())[0]!.event.liveSessionId).toBe(attempt.localId);
  f.outbox.stop();
  f.state.offline = false;
  const replay = new DiagnosticOutbox(f.options); replay.configure((await f.api.policy()).diagnostics);
  await replay.flush(); replay.stop();
  expect(f.statuses).toEqual([200]); expect(await f.queue.read()).toEqual([]);
  const report = buildDiagnosticReport(f.db, f.journal.db, { liveSessionId: attempt.localId });
  expect(report.candidates).toHaveLength(1);
  expect(report.events).toContainEqual(expect.objectContaining({ liveSessionId: attempt.localId, attemptStatus: "unconfirmed", type: "app.lifecycle" }));
  expect(report.warnings).toContain(`${attempt.localId}: attempt_unconfirmed`);
  const c = f.ledger.getConversation(f.owner, stream.conversationId!);
  f.ledger.registerAttempt(f.owner, { conversationId: c.id, conversationVersion: c.version, liveSessionId: attempt.localId,
    initialMode: "interpreter", startReason: "initial", fingerprint: "late-registration" });
  const reconciled = buildDiagnosticReport(f.db, f.journal.db, { liveSessionId: attempt.localId });
  expect(reconciled.events).toContainEqual(expect.objectContaining({ liveSessionId: attempt.localId, attemptStatus: "registered", type: "app.lifecycle" }));
  expect(reconciled.warnings).not.toContain(`${attempt.localId}: attempt_unconfirmed`);
  expect(f.creator).not.toHaveBeenCalled();
});

it.each([0, 1])("reports a collection-disabled interval with %s observed/discarded events", async discardedCount => {
  const f = await fixture(), c = await f.api.createConversation(crypto.randomUUID()), stream = f.outbox.stream();
  stream.bind(c.conversationId);
  const policy = (await f.api.policy()).diagnostics!;
  f.outbox.configure({ ...policy, enabled: false });
  if (discardedCount) stream.emit("transcript.fragment", { kind: "input", fragmentId: "disabled", charCount: 14 }, "PRIVATE_CANARY");
  f.outbox.configure(policy);
  await f.outbox.flush();
  expect(f.statuses).toEqual([200]);
  const report = buildDiagnosticReport(f.db, f.journal.db, { conversationId: c.conversationId });
  expect(report.events).toContainEqual(expect.objectContaining({ type: "diagnostic.collection", data: {
    disabledAtMs: expect.any(Number), resumedAtMs: expect.any(Number), discardedCount,
  } }));
  expect(report.warnings).toContain(`${stream.id}:1: collection_disabled`);
  for (const format of ["text", "jsonl"] as const) {
    const output = formatDiagnosticReport(report, format);
    expect(output).toContain("collection_disabled"); expect(output).not.toContain("PRIVATE_CANARY");
  }
});

it.each(["tab", "server"].flatMap(revoke => ["receipt", "queue_remove"].map(lost => ({ revoke, lost }))))(
  "scrubs committed text after losing $lost and revoking $revoke consent", async ({ revoke, lost }) => {
    const f = await fixture(), c = await f.api.createConversation(crypto.randomUUID()), stream = f.outbox.stream();
    stream.bind(c.conversationId);
    stream.emit("transcript.fragment", { kind: "input", fragmentId: "private", charCount: 14 }, "PRIVATE_CANARY");
    stream.emit("audio.state", { phase: "capture_ready" });
    const remove = vi.spyOn(f.queue, "remove");
    if (lost === "receipt") f.state.loseReceipt = true; else remove.mockRejectedValueOnce(new Error("IDB removal failed"));
    await f.outbox.flush(); remove.mockRestore();
    expect(f.journal.db.prepare("SELECT text FROM diagnostic_text WHERE stream_id=? AND seq=1").get(stream.id)!.text).toBe("PRIVATE_CANARY");
    expect(JSON.stringify(await f.queue.read())).toContain("PRIVATE_CANARY");
    if (revoke === "tab") f.state.consent = false; else f.journal.options.textEnabled = false;
    f.outbox.stop();
    const replay = new DiagnosticOutbox(f.options); replay.configure((await f.api.policy()).diagnostics);
    await replay.flush(); await replay.flush(); replay.stop();
    expect(f.statuses).toEqual([200, 200, 200]); expect(await f.queue.read()).toEqual([]);
    expect(f.journal.db.prepare("SELECT COUNT(*) AS n FROM diagnostic_text WHERE stream_id=?").get(stream.id)!.n).toBe(0);
    expect(f.journal.db.prepare("SELECT COUNT(*) AS n FROM diagnostic_events WHERE stream_id=?").get(stream.id)!.n).toBe(2);
    const report = buildDiagnosticReport(f.db, f.journal.db, { conversationId: c.conversationId });
    expect(report.events).toContainEqual(expect.objectContaining({ streamId: stream.id, seq: 1, textRemoved: true, textStatus: "removed" }));
    for (const format of ["text", "jsonl"] as const) {
      const output = formatDiagnosticReport(report, format);
      expect(output).toContain("text_removed"); expect(output).not.toContain("PRIVATE_CANARY");
    }
  },
);

it.each(["tab", "server"])("reports text removed by %s revocation after offline queue and replay", async revoke => {
  const f = await fixture(), c = await f.api.createConversation(crypto.randomUUID()), stream = f.outbox.stream();
  stream.bind(c.conversationId); f.state.offline = true;
  stream.emit("transcript.fragment", { kind: "input", fragmentId: "private", charCount: 14 }, "PRIVATE_CANARY");
  stream.emit("audio.state", { phase: "capture_ready" });
  await f.outbox.flush();
  expect(JSON.stringify(await f.queue.read())).toContain("PRIVATE_CANARY");
  if (revoke === "tab") f.state.consent = false; else f.journal.options.textEnabled = false;
  f.state.offline = false;
  await f.outbox.flush(); await f.outbox.flush(); await f.outbox.flush();
  expect(f.statuses.at(-1)).toBe(200);
  expect(JSON.stringify(await f.queue.read())).not.toContain("PRIVATE_CANARY");
  expect(f.journal.db.prepare("SELECT COUNT(*) AS n FROM diagnostic_text").get()!.n).toBe(0);
  const report = buildDiagnosticReport(f.db, f.journal.db, { conversationId: c.conversationId });
  expect(report.events).toContainEqual(expect.objectContaining({ type: "transcript.fragment", textRemoved: true, textStatus: "removed" }));
  expect(report.events).toContainEqual(expect.objectContaining({ type: "audio.state", textStatus: "not_recorded" }));
  expect(report.warnings).toContain(`${stream.id}:1: text_removed`);
  for (const format of ["text", "jsonl"] as const) {
    const output = formatDiagnosticReport(report, format);
    expect(output).toContain("text_removed"); expect(output).not.toContain("PRIVATE_CANARY");
  }
});
