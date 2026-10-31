import { IDBFactory } from "fake-indexeddb";
import { beforeEach, afterEach, describe, expect, it, vi } from "vitest";
import { DiagnosticOutbox, IndexedDiagnosticQueue, DIAGNOSTIC_TEXT_KEY, type DiagnosticQueue, type DiagnosticQueueRow } from "./DiagnosticOutbox";
import type { DiagnosticEvent } from "../../../../types/diagnostics.js";

const active = { enabled: true, textEnabled: false, schemaVersion: 1 as const };
beforeEach(() => { vi.stubGlobal("indexedDB", new IDBFactory()); sessionStorage.clear(); });
afterEach(() => { vi.unstubAllGlobals(); vi.restoreAllMocks(); vi.useRealTimers(); });
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
  it("replays an existing queue at document startup without starting a conversation and stops all wakeups", async () => {
    const f = fixture(), stream = f.outbox.stream(); stream.bind(crypto.randomUUID()); stream.emit("app.lifecycle", { phase: "end", generation: 1 });
    f.send.mockRejectedValueOnce(new Error("offline")); await f.outbox.flush();
    vi.useFakeTimers();
    const replay = new DiagnosticOutbox({ queue: f.queue, fetch: f.send });
    const load = vi.fn(async () => active);
    try {
      replay.start(load);
      await vi.waitFor(() => expect(load).toHaveBeenCalledOnce());
      await vi.advanceTimersByTimeAsync(2500);
      await vi.waitFor(() => expect(f.requests.flat().some(event => event.streamId === stream.id)).toBe(true));
      expect(f.requests.flat().some(event => event.type === "diagnostic.clock" && event.streamId === stream.id)).toBe(false);
      replay.stop();
      const count = f.send.mock.calls.length;
      window.dispatchEvent(new Event("online")); document.dispatchEvent(new Event("visibilitychange"));
      await vi.advanceTimersByTimeAsync(10000);
      expect(f.send).toHaveBeenCalledTimes(count); expect(vi.getTimerCount()).toBe(0);
    } finally { replay.stop(); }
  });
  it("attributes evicted and expired rows to each victim's original conversation and stream", async () => {
    let queueNow = 0;
    const queue = new IndexedDiagnosticQueue(5 * 1024 * 1024, () => queueNow);
    const old = [0, 1].map(seq => ({ key: `old-${seq}`, queuedAt: seq, bytes: 400, event: {
      schemaVersion: 1, source: "browser", conversationId: crypto.randomUUID(), liveSessionId: crypto.randomUUID(), streamId: crypto.randomUUID(), seq: 1,
      wallMs: 1, monoMs: 1, type: "app.lifecycle", data: { phase: "end", generation: 1 },
    } as DiagnosticEvent }));
    for (const row of old) await queue.put(row);
    queueNow = Date.now();
    const f = fixture({ queue }), incoming = f.outbox.stream(); incoming.bind(crypto.randomUUID()); incoming.emit("app.lifecycle", { phase: "start", generation: 0 });
    await f.outbox.flush(); await f.outbox.flush(); await f.outbox.flush();
    for (const row of old) expect(f.requests.flat()).toContainEqual(expect.objectContaining({
      conversationId: row.event.conversationId, liveSessionId: row.event.liveSessionId,
      type: "diagnostic.loss", data: { reason: "expired", count: 1, affectedStreamId: row.event.streamId },
    }));
    expect(f.requests.flat().filter(event => event.type === "diagnostic.loss" && event.conversationId === incoming.conversationId)).toEqual([]);
  });
  it("groups expiry during replay separately from expiry during enqueue", async () => {
    const queue = new IndexedDiagnosticQueue(5 * 1024 * 1024, () => 0), f = fixture({ queue });
    const owners = [crypto.randomUUID(), crypto.randomUUID()];
    for (const conversationId of owners) {
      const event = { schemaVersion: 1, source: "browser", conversationId, streamId: crypto.randomUUID(), seq: 1, wallMs: 0, monoMs: 0, type: "app.lifecycle", data: { phase: "end", generation: 0 } } as DiagnosticEvent;
      await queue.put({ key: event.streamId, queuedAt: 0, bytes: 400, event });
    }
    await f.outbox.flush(); await f.outbox.flush(); await f.outbox.flush();
    expect(new Set(f.requests.flat().filter(event => event.type === "diagnostic.loss").map(event => event.conversationId))).toEqual(new Set(owners));
  });
  it("logs acknowledgement-storage failures without dropping the retryable rows", async () => {
    const queue = new IndexedDiagnosticQueue(), remove = vi.spyOn(queue, "remove").mockRejectedValueOnce(new Error("unavailable"));
    const error = vi.spyOn(console, "error").mockImplementation(() => {}), f = fixture({ queue }), stream = f.outbox.stream(); stream.bind(crypto.randomUUID());
    stream.emit("app.lifecycle", { phase: "start", generation: 0 }); await f.outbox.flush();
    expect(error).toHaveBeenCalledWith("Conversation diagnostics retry scheduled", { code: "diagnostics_ack_storage_failed" });
    expect(await queue.read()).toHaveLength(1);
    remove.mockRestore(); await f.outbox.flush();
    expect(f.requests[0]![0]).toEqual(f.requests[1]![0]);
  });
  it("calibrates both current-document streams acknowledged in one conversation batch", async () => {
    const f = fixture(), conversationId = crypto.randomUUID();
    const streams = [f.outbox.stream(), f.outbox.stream()];
    for (const stream of streams) { stream.bind(conversationId, crypto.randomUUID()); stream.emit("app.lifecycle", { phase: "start", generation: 1 }); }
    await f.outbox.flush(); await f.outbox.flush();
    expect(new Set(f.requests.flat().filter(event => event.type === "diagnostic.clock").map(event => event.streamId))).toEqual(new Set(streams.map(stream => stream.id)));
  });
  it("honors text enablement after idle events and revocation during a conversation", async () => {
    const f = fixture({ textEnabled: true }), stream = f.outbox.stream(); stream.bind(crypto.randomUUID());
    stream.emit("app.lifecycle", { phase: "visible", generation: 0 });
    sessionStorage.setItem(DIAGNOSTIC_TEXT_KEY, "1");
    stream.emit("transcript.fragment", { kind: "input", fragmentId: "first", charCount: 5 }, "first");
    await f.outbox.flush();
    expect(f.requests.flat()).toContainEqual(expect.objectContaining({ type: "transcript.fragment", text: "first" }));
    sessionStorage.removeItem(DIAGNOSTIC_TEXT_KEY);
    stream.emit("transcript.fragment", { kind: "input", fragmentId: "second", charCount: 6 }, "second");
    await f.outbox.flush();
    expect(f.requests.flat().find(event => event.type === "transcript.fragment" && event.data.fragmentId === "second")).not.toHaveProperty("text");
  });
  it("strips persisted text under the current policy without losing technical metadata", async () => {
    sessionStorage.setItem(DIAGNOSTIC_TEXT_KEY, "1");
    const f = fixture({ textEnabled: true }), stream = f.outbox.stream(); stream.bind(crypto.randomUUID(), crypto.randomUUID());
    stream.emit("transcript.fragment", { kind: "input", fragmentId: "private", charCount: 14 }, "PRIVATE_CANARY");
    stream.emit("audio.state", { phase: "capture_ready" });
    f.send.mockRejectedValueOnce(new Error("offline")); await f.outbox.flush();
    const replay = new DiagnosticOutbox({ queue: f.queue, fetch: f.send, automatic: false }); replay.configure(active);
    await replay.flush();
    expect(JSON.stringify(f.requests)).not.toContain("PRIVATE_CANARY");
    expect(f.requests.flat().filter(event => ["transcript.fragment", "audio.state"].includes(event.type))).toHaveLength(2);
    expect(await f.queue.read()).toEqual([]);
  });
  it("purges an expired text backlog even when collection is disabled", async () => {
    const f = fixture();
    const event = { schemaVersion: 1, source: "browser", conversationId: crypto.randomUUID(), streamId: crypto.randomUUID(), seq: 1, wallMs: 0, monoMs: 0,
      type: "transcript.fragment", data: { kind: "input", fragmentId: "old", charCount: 14 }, text: "PRIVATE_CANARY" } as DiagnosticEvent;
    await f.queue.put({ key: "old", queuedAt: 0, bytes: 500, event });
    f.outbox.configure({ ...active, enabled: false }); await f.outbox.flush();
    expect(await f.queue.read()).toEqual([]); expect(f.send).not.toHaveBeenCalled();
  });
  it("logs a bounded safe reason when delivery retries instead of exposing the error or content", async () => {
    const error = vi.spyOn(console, "error").mockImplementation(() => {}), f = fixture(), stream = f.outbox.stream(); stream.bind(crypto.randomUUID());
    stream.emit("app.lifecycle", { phase: "start", generation: 0 });
    f.send.mockRejectedValue(new Error("PRIVATE_CANARY")); await f.outbox.flush(); await f.outbox.flush();
    expect(error).toHaveBeenCalledTimes(1); expect(JSON.stringify(error.mock.calls)).not.toContain("PRIVATE_CANARY");
  });
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
    expect(await queue.put({ ...row, key: "two", queuedAt: 86400001 })).toEqual({ expired: [row], overflow: [] });
    expect(await queue.put({ ...row, key: "three", queuedAt: 86400001 })).toEqual({ expired: [], overflow: [{ ...row, key: "two", queuedAt: 86400001 }] });
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
