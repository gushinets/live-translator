import { IDBFactory } from "fake-indexeddb";
import { beforeEach, afterEach, describe, expect, it, vi } from "vitest";
import { DiagnosticOutbox, IndexedDiagnosticQueue, DIAGNOSTIC_TEXT_KEY, type DiagnosticQueue, type DiagnosticQueueRow } from "./DiagnosticOutbox";
import type { DiagnosticEvent } from "../../../../types/diagnostics.js";

const active = { enabled: true, textEnabled: false, schemaVersion: 1 as const };
beforeEach(() => { vi.stubGlobal("indexedDB", new IDBFactory()); sessionStorage.clear(); });
afterEach(() => vi.unstubAllGlobals());
function fixture(options: { queue?: DiagnosticQueue; textEnabled?: boolean } = {}) {
  const requests: DiagnosticEvent[][] = [];
  const send = vi.fn(async (_url: string | URL | Request, init?: RequestInit) => {
    const events = (JSON.parse(String(init?.body)) as { events: DiagnosticEvent[] }).events; requests.push(events);
    return new Response(JSON.stringify({ schemaVersion: 1, serverTime: Date.now(), accepted: events.map(({ streamId, seq }) => ({ streamId, seq })) }));
  });
  const queue = options.queue ?? new IndexedDiagnosticQueue(), outbox = new DiagnosticOutbox({ queue, fetch: send, automatic: false });
  outbox.configure({ ...active, textEnabled: options.textEnabled ?? false });
  return { outbox, queue, send, requests };
}
describe("diagnostic delivery", () => {
  it("removes content before any queue/request in technical mode, including startup buffers", async () => {
    sessionStorage.setItem(DIAGNOSTIC_TEXT_KEY, "1");
    const f = fixture(), stream = f.outbox.stream();
    stream.emit("transcript.fragment", { kind: "input", fragmentId: crypto.randomUUID(), charCount: 14 }, "PRIVATE_CANARY");
    stream.bind(crypto.randomUUID(), crypto.randomUUID());
    await f.outbox.flush();
    expect(JSON.stringify(f.requests)).not.toContain("PRIVATE_CANARY");
    expect(JSON.stringify(await f.queue.read())).not.toContain("PRIVATE_CANARY");
  });
  it("requires both switches for text, preserves immutable identities and retries after reload without duplication", async () => {
    sessionStorage.setItem(DIAGNOSTIC_TEXT_KEY, "1");
    const f = fixture({ textEnabled: true }), stream = f.outbox.stream();
    const conversationId = crypto.randomUUID(), attemptId = crypto.randomUUID();
    stream.emit("transcript.fragment", { kind: "input", fragmentId: crypto.randomUUID(), charCount: 14 }, "PRIVATE_CANARY");
    stream.bind(conversationId, attemptId);
    f.send.mockRejectedValueOnce(new Error("offline"));
    await f.outbox.flush();
    const reloaded = new DiagnosticOutbox({ queue: f.queue, fetch: f.send, automatic: false }); reloaded.configure({ ...active, textEnabled: true });
    await reloaded.flush();
    expect(f.requests[0]![0]).toMatchObject({ conversationId, liveSessionId: attemptId, seq: 1, text: "PRIVATE_CANARY" });
    expect(await f.queue.read()).toEqual([]);
    stream.bind(crypto.randomUUID(), crypto.randomUUID());
    stream.emit("app.lifecycle", { phase: "reset", generation: 1 });
    await f.outbox.flush();
    expect(f.requests.flat().some(e => e.type === "app.lifecycle")).toBe(false);
  });
  it("caps batches by bytes and event count, then leaves remaining events queued", async () => {
    const f = fixture(), stream = f.outbox.stream(); stream.bind(crypto.randomUUID());
    for (let i = 0; i < 110; i++) stream.emit("app.lifecycle", { phase: "start", generation: i });
    await f.outbox.flush();
    expect(f.requests[0]!.length).toBeLessThanOrEqual(100);
    expect(new TextEncoder().encode(JSON.stringify({ schemaVersion: 1, events: f.requests[0] })).length).toBeLessThanOrEqual(32768);
    expect((await f.queue.read()).length).toBeGreaterThan(0);
  });
  it("uses bounded volatile delivery when IndexedDB is unavailable and records the degradation", async () => {
    const queue: DiagnosticQueue = { put: async () => { throw new Error("denied"); }, read: async () => { throw new Error("denied"); }, remove: async () => {} };
    const f = fixture({ queue }), stream = f.outbox.stream(); stream.bind(crypto.randomUUID());
    stream.emit("app.lifecycle", { phase: "start", generation: 0 });
    await f.outbox.flush(); await f.outbox.flush();
    expect(f.requests.flat().some(e => e.type === "diagnostic.loss" && e.data.reason === "storage_unavailable")).toBe(true);
  });
  it("evicts expired and oversized queues and reports loss instead of blocking producers", async () => {
    const queue = new IndexedDiagnosticQueue(700, () => 86400001);
    const event = { schemaVersion: 1, source: "browser", conversationId: crypto.randomUUID(), streamId: crypto.randomUUID(), seq: 1, wallMs: 1, monoMs: 1, type: "app.lifecycle", data: { phase: "start", generation: 0 } } as DiagnosticEvent;
    const row: DiagnosticQueueRow = { key: "one", event, queuedAt: 0, bytes: 400 };
    await queue.put(row);
    expect(await queue.put({ ...row, key: "two", queuedAt: 86400001 })).toEqual({ expired: 1, overflow: 0 });
    expect(await queue.put({ ...row, key: "three", queuedAt: 86400001 })).toEqual({ expired: 0, overflow: 1 });
    expect((await queue.read()).map(row => row.key)).toEqual(["three"]);
  });
  it("disables a lost owner's stream without rebinding old events to a new identity", async () => {
    const f = fixture(), stream = f.outbox.stream(); stream.bind(crypto.randomUUID());
    stream.emit("app.lifecycle", { phase: "start", generation: 0 });
    f.send.mockResolvedValueOnce(new Response("{}", { status: 401 }));
    await f.outbox.flush();
    stream.emit("app.lifecycle", { phase: "resume", generation: 1 });
    await f.outbox.flush();
    expect(f.requests.flat().some(e => e.type === "app.lifecycle" && e.data.phase === "resume")).toBe(false);
  });
  it("reports an expired previous document's backlog using its original conversation identity", async () => {
    const queue = new IndexedDiagnosticQueue(), conversationId = crypto.randomUUID(), streamId = crypto.randomUUID();
    const event = { schemaVersion: 1, source: "browser", conversationId, streamId, seq: 1, wallMs: 1, monoMs: 1,
      type: "app.lifecycle", data: { phase: "start", generation: 0 } } as DiagnosticEvent;
    await queue.put({ key: "expired", queuedAt: 0, bytes: 400, event });
    const f = fixture({ queue });
    await f.outbox.flush(); await f.outbox.flush();
    expect(f.requests.flat()).toContainEqual(expect.objectContaining({ conversationId, type: "diagnostic.loss",
      data: { reason: "expired", count: 1, affectedStreamId: streamId } }));
  });
  it("disables delivery against an old policy and reads developer opt-in at the start of a preallocated stream", async () => {
    const f = fixture({ textEnabled: true }), stream = f.outbox.stream();
    sessionStorage.setItem(DIAGNOSTIC_TEXT_KEY, "1");
    stream.bind(crypto.randomUUID());
    stream.emit("transcript.fragment", { kind: "input", fragmentId: crypto.randomUUID(), charCount: 5 }, "hello");
    await f.outbox.flush();
    expect(f.requests.flat()).toContainEqual(expect.objectContaining({ text: "hello" }));
    f.outbox.configure(undefined);
    stream.emit("app.lifecycle", { phase: "end", generation: 1 });
    const count = f.send.mock.calls.length; await f.outbox.flush(); expect(f.send).toHaveBeenCalledTimes(count);
  });
});
