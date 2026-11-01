import { IDBFactory, IDBObjectStore, IDBCursor, IDBDatabase } from "fake-indexeddb";
import { beforeEach, afterEach, describe, expect, it, vi } from "vitest";
import { DiagnosticOutbox, IndexedDiagnosticQueue, DIAGNOSTIC_TEXT_KEY, type DiagnosticQueue, type DiagnosticQueueRow } from "./DiagnosticOutbox";
import type { DiagnosticEvent } from "../../../../types/diagnostics.js";

const active = { enabled: true, textEnabled: false, schemaVersion: 1 as const };
beforeEach(() => { vi.stubGlobal("indexedDB", new IDBFactory()); sessionStorage.clear(); });
afterEach(() => { vi.unstubAllGlobals(); vi.restoreAllMocks(); vi.useRealTimers(); });
function fixture(options: { queue?: DiagnosticQueue; textEnabled?: boolean; producerId?: string; storage?: Storage; now?: () => number } = {}) {
  const requests: DiagnosticEvent[][] = [];
  const send = vi.fn(async (_url: string | URL | Request, init?: RequestInit) => {
    const events = (JSON.parse(String(init?.body)) as { events: DiagnosticEvent[] }).events; requests.push(events);
    return new Response(JSON.stringify({ schemaVersion: 1, serverTime: Date.now(), accepted: events.map(({ streamId, seq }) => ({ streamId, seq })) }));
  });
  const queue = options.queue ?? new IndexedDiagnosticQueue(), outbox = new DiagnosticOutbox({ queue, fetch: send, automatic: false,
    producerId: options.producerId ? Promise.resolve(options.producerId) : undefined, storage: options.storage, now: options.now });
  outbox.configure({ ...active, textEnabled: options.textEnabled ?? false });
  return { outbox, queue, send, requests };
}
describe("diagnostic delivery", () => {
  it("gates disabled maintenance before taking a lock, still purges later expiry/peer rows and resets on policy changes", async () => {
    vi.useFakeTimers(); const now = Date.now();
    const event = { schemaVersion: 1, source: "browser", conversationId: crypto.randomUUID(), streamId: crypto.randomUUID(), seq: 1, wallMs: now, monoMs: 0,
      type: "transcript.fragment", data: { kind: "input", fragmentId: "private", charCount: 7 }, text: "PRIVATE" } as DiagnosticEvent;
    let rows: DiagnosticQueueRow[] = [{ key: "old", event, queuedAt: now - 86400000 + 30000, bytes: 600 }];
    const queue: DiagnosticQueue = {
      put: async () => ({ expired: [], overflow: [] }), read: vi.fn(async () => structuredClone(rows)),
      remove: async keys => { rows = rows.filter(row => !keys.includes(row.key)); },
      scrubText: vi.fn(async () => { for (const row of rows) { delete row.event.text; delete row.event.textTruncated; } }),
    };
    const request = vi.fn(async (_name: string, _options: unknown, callback: (lock: object) => Promise<void>) => callback({}));
    vi.stubGlobal("navigator", { locks: { request } });
    const send = vi.fn(async () => new Response(JSON.stringify({ schemaVersion: 1, serverTime: now, accepted: [] })));
    const outbox = new DiagnosticOutbox({ queue, fetch: send });
    try {
      outbox.configure({ ...active, enabled: false }); await outbox.flush();
      expect(request).toHaveBeenCalledOnce(); expect(queue.read).toHaveBeenCalledOnce(); expect(rows[0]!.event).not.toHaveProperty("text");
      await vi.advanceTimersByTimeAsync(20000);
      rows.push({ key: "peer", event: { ...event, seq: 2, text: "PEER_PRIVATE" }, queuedAt: now + 20000, bytes: 600 });
      await outbox.flush(); expect(request).toHaveBeenCalledOnce();
      await vi.advanceTimersByTimeAsync(40000); await outbox.flush();
      expect(request).toHaveBeenCalledTimes(2); expect(rows.map(row => row.key)).toEqual(["peer"]);
      expect(JSON.stringify(rows)).not.toContain("PEER_PRIVATE"); expect(send).not.toHaveBeenCalled();
      outbox.configure(active); outbox.configure({ ...active, enabled: false }); await outbox.flush();
      expect(request).toHaveBeenCalledTimes(3);
    } finally { outbox.stop(); }
  });
  it("preserves another tab's opted-in text and scopes revocation to the producing tab across reload", async () => {
    const optedIn = vi.fn<Storage["getItem"]>(() => "1"), optedOut = vi.fn<Storage["getItem"]>(() => null);
    const a = fixture({ textEnabled: true, producerId: "tab-A", storage: { getItem: optedIn } as unknown as Storage });
    const b = fixture({ textEnabled: true, producerId: "tab-B", storage: { getItem: optedOut } as unknown as Storage });
    const stream = a.outbox.stream(); stream.bind(crypto.randomUUID());
    stream.emit("transcript.fragment", { kind: "input", fragmentId: "first", charCount: 7 }, "PRIVATE");
    a.send.mockRejectedValueOnce(new Error("offline")); await a.outbox.flush();
    const persisted = await a.queue.read(); expect(persisted[0]!.textProducerId).toBe("tab-A");
    await b.outbox.flush();
    expect(b.requests.flat()).toContainEqual(expect.objectContaining({ text: "PRIVATE" }));
    expect(JSON.stringify(b.requests)).not.toContain("tab-A");
    stream.emit("transcript.fragment", { kind: "input", fragmentId: "second", charCount: 7 }, "REVOKED");
    a.send.mockRejectedValueOnce(new Error("offline")); await a.outbox.flush();
    const reloaded = fixture({ queue: a.queue, textEnabled: true, producerId: "tab-A", storage: { getItem: optedOut } as unknown as Storage });
    await reloaded.outbox.flush();
    expect(reloaded.requests.flat().find(event => event.type === "transcript.fragment")).not.toHaveProperty("text");
    expect(JSON.stringify(await a.queue.read())).not.toContain("REVOKED");
  });
  it("coordinates shared delivery across two outboxes with a non-blocking origin lock", async () => {
    let held = false;
    const request = vi.fn(async (_name: string, _options: unknown, callback: (lock: object | null) => Promise<void>) => {
      if (held) return callback(null);
      held = true; try { await callback({}); } finally { held = false; }
    });
    vi.stubGlobal("navigator", { locks: { request } });
    const a = fixture(), b = fixture(), stream = a.outbox.stream(); stream.bind(crypto.randomUUID());
    stream.emit("app.lifecycle", { phase: "start", generation: 1 });
    let release!: (response: Response) => void;
    a.send.mockImplementationOnce(() => new Promise<Response>(resolve => { release = resolve; }));
    const sending = a.outbox.flush();
    await vi.waitFor(() => expect(a.send).toHaveBeenCalledOnce());
    await b.outbox.flush(); expect(b.send).not.toHaveBeenCalled();
    const events = JSON.parse(String(a.send.mock.calls[0]![1]!.body)).events as DiagnosticEvent[];
    release(new Response(JSON.stringify({ schemaVersion: 1, serverTime: Date.now(), accepted: events.map(({ streamId, seq }) => ({ streamId, seq })) })));
    await sending; await b.outbox.flush();
    expect(b.requests.flat().some(event => event.streamId === stream.id && event.seq === 1)).toBe(false);
    expect(held).toBe(false);
  });
  it.each(["invalid_diagnostic_event", "diagnostics_text_not_allowed"])("refreshes a live tab after %s and retries technical rows without discarding them", async code => {
    sessionStorage.setItem(DIAGNOSTIC_TEXT_KEY, "1");
    const f = fixture({ textEnabled: true }), load = vi.fn(async () => active);
    f.outbox.start(load);
    const stream = f.outbox.stream(); stream.bind(crypto.randomUUID());
    stream.emit("transcript.fragment", { kind: "input", fragmentId: "private", charCount: 7 }, "PRIVATE");
    stream.emit("audio.state", { phase: "capture_ready" });
    f.send.mockResolvedValueOnce(new Response(JSON.stringify({ code }), { status: 400 }));
    await f.outbox.flush();
    expect(load).toHaveBeenCalledOnce();
    const rows = await f.queue.read();
    expect(rows.map(row => row.event.type)).toEqual(["transcript.fragment", "audio.state"]);
    expect(JSON.stringify(rows)).not.toContain("PRIVATE");
    await f.outbox.flush();
    expect(f.requests.flat().filter(event => ["transcript.fragment", "audio.state"].includes(event.type))).toHaveLength(2);
    expect(JSON.stringify(f.requests)).not.toContain("PRIVATE");
  });
  it("refreshes server policy before replay once a live tab's cached policy expires", async () => {
    sessionStorage.setItem(DIAGNOSTIC_TEXT_KEY, "1"); let now = Date.now();
    const f = fixture({ textEnabled: true, now: () => now }), load = vi.fn(async () => active);
    f.outbox.start(load);
    const stream = f.outbox.stream(); stream.bind(crypto.randomUUID());
    stream.emit("transcript.fragment", { kind: "input", fragmentId: "private", charCount: 7 }, "PRIVATE");
    now += 60001; await f.outbox.flush();
    expect(load).toHaveBeenCalledOnce(); expect(JSON.stringify(f.requests)).not.toContain("PRIVATE");
    expect(f.requests.flat()).toContainEqual(expect.objectContaining({ type: "transcript.fragment" }));
  });
  it("appends into a large backlog without full-store reads or walks and updates the byte budget atomically", async () => {
    const queue = new IndexedDiagnosticQueue(400000, () => 0), streamId = crypto.randomUUID();
    const event = { schemaVersion: 1, source: "browser", conversationId: crypto.randomUUID(), streamId, seq: 1, wallMs: 0, monoMs: 0,
      type: "app.lifecycle", data: { phase: "start", generation: 1 } } as DiagnosticEvent;
    await queue.put({ key: "seed", event, queuedAt: 0, bytes: 400 });
    const getAll = vi.spyOn(IDBObjectStore.prototype, "getAll"), next = vi.spyOn(IDBCursor.prototype, "continue");
    await Promise.all(Array.from({ length: 500 }, (_, i) => queue.put({ key: `row-${i}`, event: { ...event, seq: i + 2 }, queuedAt: i + 1, bytes: 400 })));
    expect(getAll).not.toHaveBeenCalled(); expect(next.mock.calls.length).toBeLessThanOrEqual(500);
    expect(await queue.read()).toHaveLength(501);
    await queue.remove(Array.from({ length: 500 }, (_, i) => `row-${i}`));
    await queue.remove(["seed", "seed"]);
    await queue.put({ key: "new", event, queuedAt: 1000, bytes: 400000 });
    expect((await queue.read()).map(row => row.key)).toEqual(["new"]);
  });
  it("upgrades legacy rows once, bulk-scrubs text in one transaction and releases the corresponding byte budget", async () => {
    const event = { schemaVersion: 1, source: "browser", conversationId: crypto.randomUUID(), streamId: crypto.randomUUID(), seq: 1, wallMs: 0, monoMs: 0,
      type: "transcript.fragment", data: { kind: "input", fragmentId: "old", charCount: 200 }, text: "x".repeat(200) } as DiagnosticEvent;
    await new Promise<void>((resolve, reject) => {
      const request = indexedDB.open("live-translator-diagnostics-v1", 1);
      request.onupgradeneeded = () => request.result.createObjectStore("events", { keyPath: "key" });
      request.onerror = () => reject(request.error);
      request.onsuccess = () => {
        const db = request.result, tx = db.transaction("events", "readwrite");
        tx.objectStore("events").put({ key: "legacy", event, queuedAt: 0, bytes: 1000 });
        tx.oncomplete = () => { db.close(); resolve(); }; tx.onerror = () => reject(tx.error);
      };
    });
    const queue = new IndexedDiagnosticQueue(1100, () => 0);
    expect((await queue.read())[0]).toMatchObject({ key: "legacy", textProducerId: "legacy", event: { text: "x".repeat(200) } });
    const write = vi.spyOn(IDBDatabase.prototype, "transaction");
    await queue.scrubText();
    expect(write).toHaveBeenCalledOnce();
    await queue.put({ key: "new", event: { ...event, seq: 2, text: undefined }, queuedAt: 1, bytes: 400 });
    const rows = await queue.read(); expect(rows.map(row => row.key)).toEqual(["legacy", "new"]);
    expect(rows[0]!.event).not.toHaveProperty("text");
  });
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
    const queue: DiagnosticQueue = { put: async () => { throw new Error("denied"); }, read: async () => { throw new Error("denied"); }, remove: async () => {}, scrubText: async () => {} };
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
