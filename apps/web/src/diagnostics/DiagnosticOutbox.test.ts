import { IDBFactory, IDBObjectStore, IDBCursor, IDBDatabase } from "fake-indexeddb";
import { beforeEach, afterEach, describe, expect, it, vi } from "vitest";
import { DiagnosticOutbox, IndexedDiagnosticQueue, DIAGNOSTIC_TEXT_KEY, type DiagnosticQueue, type DiagnosticQueueRow } from "./DiagnosticOutbox";
import type { DiagnosticEvent } from "../../../../types/diagnostics.js";

const active = { enabled: true, textEnabled: false, schemaVersion: 1 as const };
beforeEach(() => { vi.stubGlobal("indexedDB", new IDBFactory()); sessionStorage.clear(); });
afterEach(() => { vi.unstubAllGlobals(); vi.restoreAllMocks(); vi.useRealTimers(); });
function fixture(options: { queue?: DiagnosticQueue; textEnabled?: boolean; producerId?: string | null; storage?: Storage; now?: () => number } = {}) {
  const requests: DiagnosticEvent[][] = [];
  const send = vi.fn(async (_url: string | URL | Request, init?: RequestInit) => {
    const events = (JSON.parse(String(init?.body)) as { events: DiagnosticEvent[] }).events; requests.push(events);
    return new Response(JSON.stringify({ schemaVersion: 1, serverTime: Date.now(), accepted: events.map(({ streamId, seq }) => ({ streamId, seq })) }));
  });
  const queue = options.queue ?? new IndexedDiagnosticQueue(), outbox = new DiagnosticOutbox({ queue, fetch: send, automatic: false,
    producerId: options.producerId !== undefined ? Promise.resolve(options.producerId) : undefined, storage: options.storage, now: options.now });
  outbox.configure({ ...active, textEnabled: options.textEnabled ?? false });
  return { outbox, queue, send, requests };
}
describe("diagnostic delivery", () => {
  it.each(["tab", "server"].flatMap(revoke => [false, true].map(reload => ({ revoke, reload }))))(
    "keeps failed $revoke revocation sticky across re-opt-in, reload=$reload", async ({ revoke, reload }) => {
      sessionStorage.setItem(DIAGNOSTIC_TEXT_KEY, "1");
      const f = fixture({ textEnabled: true, producerId: "same-tab" }), stream = f.outbox.stream();
      stream.bind(crypto.randomUUID()); await Promise.resolve();
      stream.emit("transcript.fragment", { kind: "input", fragmentId: "old", charCount: 7 }, "PRIVATE");
      f.send.mockRejectedValue(new Error("offline")); await f.outbox.flush();
      const scrub = vi.spyOn(f.queue, "scrubText").mockRejectedValueOnce(new Error("write denied"));
      if (revoke === "tab") sessionStorage.removeItem(DIAGNOSTIC_TEXT_KEY);
      else f.outbox.configure(active);
      await f.outbox.flush();
      expect((await f.queue.read())[0]!.event.text).toBe("PRIVATE");
      sessionStorage.setItem(DIAGNOSTIC_TEXT_KEY, "1");
      const next = reload ? fixture({ queue: f.queue, textEnabled: true, producerId: "same-tab" }) : f;
      next.outbox.configure({ ...active, textEnabled: true });
      if (!reload) f.send.mockImplementation(async (_url, init) => {
        const events = (JSON.parse(String(init?.body)) as { events: DiagnosticEvent[] }).events; f.requests.push(events);
        return new Response(JSON.stringify({ schemaVersion: 1, serverTime: Date.now(), accepted: events.map(({ streamId, seq }) => ({ streamId, seq })) }));
      });
      await next.outbox.flush(); await next.outbox.flush();
      expect(next.requests.flat()).toContainEqual(expect.objectContaining({ streamId: stream.id, seq: 1, textRemoved: true }));
      expect(JSON.stringify(next.requests)).not.toContain("PRIVATE"); expect(await f.queue.read()).toEqual([]);
      expect(scrub).toHaveBeenCalledTimes(2);
      const current = next.outbox.stream(); current.bind(crypto.randomUUID());
      current.emit("transcript.fragment", { kind: "input", fragmentId: "new", charCount: 7 }, "CURRENT");
      await next.outbox.flush();
      expect(next.requests.flat()).toContainEqual(expect.objectContaining({ text: "CURRENT" }));
    },
  );
  it("preserves disabled-maintenance expiry without inventing a historical collection interval", async () => {
    const queue = new IndexedDiagnosticQueue(), event = { schemaVersion: 1, source: "browser", conversationId: crypto.randomUUID(),
      liveSessionId: crypto.randomUUID(), streamId: crypto.randomUUID(), seq: 1, wallMs: 0, monoMs: 0,
      type: "app.lifecycle", data: { phase: "end", generation: 0 } } as DiagnosticEvent;
    await queue.put({ key: `${event.streamId}:1`, event, queuedAt: 0, bytes: 400 });
    const f = fixture({ queue }); f.outbox.configure({ ...active, enabled: false });
    await f.outbox.flush();
    await vi.waitFor(async () => expect((await queue.read()).some(row => row.event.type === "diagnostic.loss")).toBe(true));
    expect(f.send).not.toHaveBeenCalled();
    const reloaded = fixture({ queue });
    f.outbox.configure(active);
    for (let i = 0; i < 3; i++) { await f.outbox.flush(); await reloaded.outbox.flush(); }
    const events = [...f.requests, ...reloaded.requests].flat();
    expect(events).toContainEqual(expect.objectContaining({ conversationId: event.conversationId, liveSessionId: event.liveSessionId,
      type: "diagnostic.loss", data: { reason: "expired", count: 1, affectedStreamId: event.streamId } }));
    expect(events.some(row => row.type === "diagnostic.collection" && row.conversationId === event.conversationId)).toBe(false);
  });
  it("sanitizes unrecoverable producer text before replay even after the new document opts in", async () => {
    sessionStorage.setItem(DIAGNOSTIC_TEXT_KEY, "1");
    const f = fixture({ textEnabled: true, producerId: "old-document" }), stream = f.outbox.stream();
    stream.bind(crypto.randomUUID()); await Promise.resolve();
    stream.emit("transcript.fragment", { kind: "input", fragmentId: "old", charCount: 7 }, "PRIVATE");
    f.send.mockRejectedValueOnce(new Error("offline")); await f.outbox.flush();
    expect((await f.queue.read())[0]!.event.text).toBe("PRIVATE");
    const reload = fixture({ queue: f.queue, textEnabled: true, producerId: null });
    await reload.outbox.flush();
    expect(reload.requests.flat()).toEqual([expect.objectContaining({ streamId: stream.id, seq: 1, textRemoved: true })]);
    expect(JSON.stringify(reload.requests)).not.toContain("PRIVATE"); expect(await f.queue.read()).toEqual([]);
    const current = reload.outbox.stream(); current.bind(crypto.randomUUID());
    current.emit("transcript.fragment", { kind: "input", fragmentId: "current", charCount: 7 }, "CURRENT");
    await reload.outbox.flush();
    expect(reload.requests.flat()).toContainEqual(expect.objectContaining({ text: "CURRENT" }));
  });
  it("retains text-bearing rows on 507 so a later revocation can still remove committed text", async () => {
    sessionStorage.setItem(DIAGNOSTIC_TEXT_KEY, "1");
    const f = fixture({ textEnabled: true }), stream = f.outbox.stream(); stream.bind(crypto.randomUUID());
    stream.emit("transcript.fragment", { kind: "input", fragmentId: "private", charCount: 7 }, "PRIVATE");
    f.send.mockResolvedValueOnce(new Response(null, { status: 507 }));
    await f.outbox.flush();
    expect((await f.queue.read())[0]!.event.text).toBe("PRIVATE"); expect(stream.enabled).toBe(true);
    sessionStorage.removeItem(DIAGNOSTIC_TEXT_KEY);
    await f.outbox.flush(); await f.outbox.flush();
    expect(f.requests.flat()).toContainEqual(expect.objectContaining({ textRemoved: true }));
    expect(await f.queue.read()).toEqual([]);
  });
  it.each([false, true, "unavailable"] as const)("rechecks an ambiguous 404 against collection policy: %s", async enabled => {
    const f = fixture(), stream = f.outbox.stream(), conversationId = crypto.randomUUID();
    stream.bind(conversationId);
    const load = vi.fn(async () => { if (enabled === "unavailable") throw new Error("offline"); return { ...active, enabled }; });
    f.outbox.start(load);
    stream.emit("app.lifecycle", { phase: "start", generation: 0 });
    f.send.mockResolvedValueOnce(new Response(null, { status: 404 }));
    await f.outbox.flush();
    expect(load).toHaveBeenCalledOnce();
    if (enabled === true) {
      expect(stream.enabled).toBe(false);
      expect((await f.queue.read()).some(row => row.event.type === "app.lifecycle")).toBe(false);
      return;
    }
    expect((await f.queue.read()).some(row => row.event.type === "app.lifecycle")).toBe(true);
    f.outbox.configure(active);
    expect(stream.enabled).toBe(true);
    stream.emit("app.lifecycle", { phase: "resume", generation: 1 });
    await f.outbox.flush();
    expect(f.requests.flat().filter(event => event.type === "app.lifecycle").map(event => event.data.phase)).toEqual(["start", "resume"]);
  });
  it("does not capture text before the producing tab's ownership is established", async () => {
    sessionStorage.setItem(DIAGNOSTIC_TEXT_KEY, "1");
    let ready!: (id: string) => void;
    const queue = new IndexedDiagnosticQueue(), outbox = new DiagnosticOutbox({ queue, automatic: false, fetch: async () => new Response(null, { status: 503 }),
      producerId: new Promise(resolve => { ready = resolve; }) });
    outbox.configure({ ...active, textEnabled: true });
    const stream = outbox.stream(); stream.bind(crypto.randomUUID());
    stream.emit("transcript.fragment", { kind: "input", fragmentId: "before", charCount: 7 }, "PRIVATE");
    ready("owned-tab"); await Promise.resolve();
    stream.emit("transcript.fragment", { kind: "input", fragmentId: "after", charCount: 7 }, "ALLOWED");
    await outbox.flush();
    const rows = await queue.read();
    expect(rows.find(row => row.event.type === "transcript.fragment" && row.event.data.fragmentId === "before")!.event).not.toHaveProperty("text");
    expect(rows.find(row => row.event.type === "transcript.fragment" && row.event.data.fragmentId === "after")!.event.text).toBe("ALLOWED");
  });
  it("avoids writer transactions for text scrubs with no matching rows, including another tab's text", async () => {
    const queue = new IndexedDiagnosticQueue(); await queue.read();
    const transactions = vi.spyOn(IDBDatabase.prototype, "transaction");
    await queue.scrubText(); await queue.scrubText("tab-A");
    expect(transactions.mock.calls.every(([, mode]) => mode !== "readwrite")).toBe(true);
    const event = { schemaVersion: 1, source: "browser", conversationId: crypto.randomUUID(), streamId: crypto.randomUUID(), seq: 1,
      wallMs: Date.now(), monoMs: 0, type: "transcript.fragment", data: { kind: "input", fragmentId: "text", charCount: 7 }, text: "PRIVATE" } as DiagnosticEvent;
    await queue.put({ key: "peer", event, queuedAt: Date.now(), bytes: 700, textProducerId: "tab-B" });
    transactions.mockClear(); await queue.scrubText("tab-A");
    expect(transactions.mock.calls.every(([, mode]) => mode !== "readwrite")).toBe(true);
    expect((await queue.read())[0]!.event.text).toBe("PRIVATE");
    await queue.scrubText();
    expect((await queue.read())[0]!.event).not.toHaveProperty("text");
  });
  it("resumes the same bound stream after collection is disabled and enabled again", async () => {
    let now = Date.now();
    const f = fixture({ now: () => now }), stream = f.outbox.stream();
    const conversationId = crypto.randomUUID(), liveSessionId = crypto.randomUUID();
    stream.bind(conversationId, liveSessionId);
    stream.emit("app.lifecycle", { phase: "start", generation: 0 });
    await f.outbox.flush();
    const disabledAtMs = now;
    f.outbox.configure({ ...active, enabled: false });
    stream.emit("app.lifecycle", { phase: "hidden", generation: 1 });
    await f.outbox.flush();
    now += 60000;
    f.outbox.configure({ ...active, enabled: false });
    f.outbox.configure(active);
    expect(stream.enabled).toBe(true);
    stream.emit("app.lifecycle", { phase: "resume", generation: 2 });
    await f.outbox.flush();
    const events = f.requests.flat().filter(event => event.type === "app.lifecycle");
    expect(events.map(event => event.data.phase)).toEqual(["start", "resume"]);
    expect(events.every(event => event.streamId === stream.id && event.conversationId === conversationId && event.liveSessionId === liveSessionId)).toBe(true);
    expect(events[1]!.seq).toBeGreaterThan(events[0]!.seq);
    expect(f.requests.flat().filter(event => event.type === "diagnostic.collection")).toEqual([
      expect.objectContaining({ streamId: stream.id, liveSessionId, data: { disabledAtMs, resumedAtMs: now, discardedCount: 1 } }),
    ]);
    stream.bind(crypto.randomUUID(), liveSessionId);
    f.outbox.configure({ ...active, enabled: false }); f.outbox.configure(active);
    expect(stream.enabled).toBe(false);
  });
  it("does not add policy boundaries to retired attempts while keeping their late observations", async () => {
    const f = fixture(), old = f.outbox.stream(), current = f.outbox.stream();
    const conversationId = crypto.randomUUID(), oldId = crypto.randomUUID();
    old.bind(conversationId, oldId); current.bind(conversationId, crypto.randomUUID());
    old.emit("app.lifecycle", { phase: "end", generation: 0 });
    await f.outbox.flush();
    old.retire();
    f.outbox.configure({ ...active, enabled: false }); f.outbox.configure(active);
    await f.outbox.flush();
    expect(f.requests.flat().filter(e => e.type === "diagnostic.collection").map(e => e.streamId)).toEqual([current.id]);
    old.emit("transport.event", { type: "session.output_transcript.delta", phase: "dropped", reason: "stale_generation" });
    await f.outbox.flush();
    expect(f.requests.flat()).toContainEqual(expect.objectContaining({ type: "transport.event", streamId: old.id, liveSessionId: oldId }));
    f.outbox.configure({ ...active, enabled: false });
    old.emit("transport.event", { type: "session.closed", phase: "received" });
    f.outbox.configure(active);
    await f.outbox.flush();
    expect(f.requests.flat()).toContainEqual(expect.objectContaining({ type: "diagnostic.collection", streamId: old.id,
      data: expect.objectContaining({ discardedCount: 1 }) }));
    f.outbox.configure(active);
    f.outbox.configure({ ...active, enabled: false }); f.outbox.configure(active);
    await f.outbox.flush();
    expect(f.requests.flat().filter(e => e.type === "diagnostic.collection" && e.streamId === old.id)).toHaveLength(1);
  });
  it("marks pre-policy losses and a disabled interval before identity is bound without retaining content", async () => {
    let now = Date.now();
    const queue = new IndexedDiagnosticQueue(), outbox = new DiagnosticOutbox({ queue, automatic: false, now: () => now });
    const stream = outbox.stream();
    for (let index = 0; index < 201; index++) stream.emit("app.lifecycle", { phase: "start", generation: index });
    const disabledAtMs = now;
    outbox.configure({ ...active, enabled: false });
    stream.emit("transcript.fragment", { kind: "input", fragmentId: "private", charCount: 14 }, "PRIVATE_CANARY");
    expect(await queue.read()).toEqual([]);
    now += 5000; outbox.configure(active);
    now += 5000; stream.bind(crypto.randomUUID());
    await vi.waitFor(async () => expect(await queue.read()).toHaveLength(1));
    expect((await queue.read())[0]!.event).toMatchObject({ type: "diagnostic.collection", seq: 202,
      data: { disabledAtMs, resumedAtMs: now - 5000, discardedCount: 202 } });
    expect(JSON.stringify(await queue.read())).not.toContain("PRIVATE_CANARY");
    outbox.configure(active);
    expect(await queue.read()).toHaveLength(1);
  });
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
  it.each([false, true])("only the producing tab replays its text and checks revocation across reload, peer opted in: %s", async peerOptedIn => {
    const optedIn = vi.fn<Storage["getItem"]>(() => "1"), optedOut = vi.fn<Storage["getItem"]>(() => null);
    const a = fixture({ textEnabled: true, producerId: "tab-A", storage: { getItem: optedIn } as unknown as Storage });
    const b = fixture({ textEnabled: true, producerId: "tab-B", storage: { getItem: () => peerOptedIn ? "1" : null } as unknown as Storage });
    await Promise.resolve();
    const stream = a.outbox.stream(); stream.bind(crypto.randomUUID());
    stream.emit("transcript.fragment", { kind: "input", fragmentId: "first", charCount: 7 }, "PRIVATE");
    a.send.mockRejectedValueOnce(new Error("offline")); await a.outbox.flush();
    const persisted = await a.queue.read(); expect(persisted[0]!.textProducerId).toBe("tab-A");
    await b.outbox.flush();
    expect(b.requests.flat()).not.toContainEqual(expect.objectContaining({ text: "PRIVATE" }));
    expect((await a.queue.read())[0]!.event.text).toBe("PRIVATE");
    await a.outbox.flush();
    expect(a.requests.flat()).toContainEqual(expect.objectContaining({ text: "PRIVATE" }));
    expect(JSON.stringify(b.requests)).not.toContain("tab-A");
    stream.emit("transcript.fragment", { kind: "input", fragmentId: "second", charCount: 7 }, "REVOKED");
    stream.emit("audio.state", { phase: "capture_ready" });
    a.send.mockRejectedValueOnce(new Error("offline")); await a.outbox.flush();
    optedIn.mockReturnValue(null);
    await b.outbox.flush();
    expect(b.requests.flat()).toContainEqual(expect.objectContaining({ type: "audio.state" }));
    expect(JSON.stringify(b.requests)).not.toMatch(/PRIVATE|REVOKED/);
    expect((await a.queue.read()).some(row => row.event.text === "REVOKED")).toBe(true);
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
    await f.outbox.flush(); await f.outbox.flush();
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
    expect(write.mock.calls.filter(([, mode]) => mode === "readwrite")).toHaveLength(1);
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
    f.outbox.configure({ ...active, enabled: false }); f.outbox.configure(active);
    await f.outbox.flush(); await f.outbox.flush(); await f.outbox.flush();
    const boundaries = f.requests.flat().filter(event => event.type === "diagnostic.collection");
    expect(boundaries).toContainEqual(expect.objectContaining({ conversationId: incoming.conversationId }));
    expect(boundaries.filter(event => event.conversationId !== incoming.conversationId)).toEqual([]);
  });
  it("reports an IndexedDB observation displaced by the first overflow marker", async () => {
    const limit = 5 * 1024 * 1024, queue = new IndexedDiagnosticQueue(limit, () => 0);
    const victims = [0, 1].map(index => ({ key: `victim-${index}`, queuedAt: index, bytes: 800, event: {
      schemaVersion: 1, source: "browser", conversationId: crypto.randomUUID(), liveSessionId: crypto.randomUUID(), streamId: crypto.randomUUID(),
      seq: 1, wallMs: 0, monoMs: 0, type: "app.lifecycle", data: { phase: "end", generation: 0 },
    } as DiagnosticEvent }));
    for (const row of victims) await queue.put(row);
    const filler = { ...victims[0]!.event, conversationId: crypto.randomUUID(), streamId: crypto.randomUUID() };
    await queue.put({ key: `${filler.streamId}:${filler.seq}`, queuedAt: 2, bytes: limit - 1600, event: filler });
    const put = vi.spyOn(queue, "put"), f = fixture({ queue, now: () => 3 }), incoming = f.outbox.stream();
    incoming.bind(crypto.randomUUID()); incoming.emit("app.lifecycle", { phase: "start", generation: 0 });
    await vi.waitFor(() => expect(put.mock.calls.filter(([row]) => row.event.type === "diagnostic.loss" && row.event.data.reason === "queue_overflow")).toHaveLength(2));
    const retained = await queue.read();
    expect(retained.reduce((sum, row) => sum + row.bytes, 0)).toBeLessThanOrEqual(limit);
    expect(put).toHaveBeenCalledTimes(3);
    for (let i = 0; i < 6; i++) await f.outbox.flush();
    for (const row of victims) expect(f.requests.flat()).toContainEqual(expect.objectContaining({ conversationId: row.event.conversationId,
      liveSessionId: row.event.liveSessionId, type: "diagnostic.loss", data: { reason: "queue_overflow", count: 1, affectedStreamId: row.event.streamId } }));
  });
  it("reports a volatile observation displaced by a loss marker without recursive marker churn", async () => {
    sessionStorage.setItem(DIAGNOSTIC_TEXT_KEY, "1");
    const limit = 5 * 1024 * 1024, queue = new IndexedDiagnosticQueue();
    const put = vi.spyOn(queue, "put").mockRejectedValue(new Error("storage denied"));
    vi.spyOn(queue, "read").mockRejectedValue(new Error("storage denied"));
    const f = fixture({ queue, textEnabled: true, now: () => 0 }), deliver = f.send.getMockImplementation()!;
    f.send.mockRejectedValue(new Error("offline"));
    const make = (conversationId: string, seq: number, text: string) => ({ schemaVersion: 1 as const, source: "browser" as const,
      conversationId, liveSessionId: conversationId, streamId: conversationId, seq, wallMs: 0, monoMs: 0, type: "transcript.fragment" as const,
      data: { kind: "input" as const, fragmentId: String(seq), charCount: text.length }, text });
    const bytes = (event: DiagnosticEvent) => new TextEncoder().encode(JSON.stringify(event)).byteLength + 128;
    const victims = [make(crypto.randomUUID(), 1, "a".repeat(700)), make(crypto.randomUUID(), 1, "b".repeat(700))];
    for (const event of victims) f.outbox.enqueue(event);
    await f.outbox.flush();
    await vi.waitFor(() => expect(put).toHaveBeenCalledTimes(3));
    let size = put.mock.calls.reduce((sum, [row]) => sum + row.bytes, 0), seq = 0;
    const filler = crypto.randomUUID();
    while (limit - size > 8192) {
      const event = make(filler, ++seq, "x".repeat(4096)); size += bytes(event); f.outbox.enqueue(event);
    }
    const tail = make(filler, ++seq, "x".repeat(Math.floor((limit - size) / 2) - 512));
    size += bytes(tail); f.outbox.enqueue(tail);
    const last = make(filler, seq + 1, "");
    last.text = "x".repeat(limit - size - bytes(last)); last.data.charCount = last.text.length;
    while (size + bytes(last) > limit) { last.text = last.text.slice(0, -1); last.data.charCount = last.text.length; }
    f.outbox.enqueue(last); await f.outbox.flush();
    expect(put.mock.calls.filter(([row]) => row.event.type === "diagnostic.loss" && row.event.data.reason === "queue_overflow")).toHaveLength(0);
    f.outbox.enqueue(make(crypto.randomUUID(), 1, "new".repeat(160))); await f.outbox.flush();
    await vi.waitFor(() => expect(put.mock.calls.filter(([row]) => row.event.type === "diagnostic.loss" && row.event.data.reason === "queue_overflow")).toHaveLength(2));
    f.send.mockImplementation(async (url, init) => String(url).includes(filler) ? new Response(null, { status: 507 }) : deliver(url, init));
    for (let i = 0; i < 8; i++) await f.outbox.flush();
    for (const event of victims) expect(f.requests.flat()).toContainEqual(expect.objectContaining({ conversationId: event.conversationId,
      liveSessionId: event.liveSessionId, type: "diagnostic.loss", data: { reason: "queue_overflow", count: 1, affectedStreamId: event.streamId } }));
  });
  it("keeps existing loss markers at capacity and stops reporting recursion with a bounded warning", async () => {
    const queue = new IndexedDiagnosticQueue(1000, () => 0);
    for (let i = 0; i < 2; i++) {
      const event = { schemaVersion: 1, source: "browser", conversationId: crypto.randomUUID(), streamId: crypto.randomUUID(), seq: 1,
        wallMs: 0, monoMs: 0, type: "diagnostic.loss", data: { reason: "queue_overflow", count: 1 } } as DiagnosticEvent;
      await queue.put({ key: `${event.streamId}:1`, queuedAt: 0, bytes: 500, event });
    }
    const existing = await queue.read(), put = vi.spyOn(queue, "put"), error = vi.spyOn(console, "error").mockImplementation(() => {});
    const f = fixture({ queue, now: () => 1 }), stream = f.outbox.stream(); stream.bind(crypto.randomUUID());
    for (let i = 0; i < 2; i++) {
      stream.emit("app.lifecycle", { phase: "start", generation: i });
      await vi.waitFor(() => expect(put).toHaveBeenCalledTimes((i + 1) * 2));
    }
    expect(await queue.read()).toEqual(existing);
    expect(error).toHaveBeenCalledExactlyOnceWith("Conversation diagnostics incomplete", { reason: "loss_marker_dropped" });
    await queue.remove(existing.map(row => row.key));
    stream.emit("app.lifecycle", { phase: "end", generation: 0 }); await f.outbox.flush();
    expect(f.requests.flat()).toContainEqual(expect.objectContaining({ streamId: stream.id, type: "app.lifecycle" }));
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
  it("calibrates after re-enabling collection when an earlier in-flight receipt arrived while disabled", async () => {
    const f = fixture(), stream = f.outbox.stream(); stream.bind(crypto.randomUUID(), crypto.randomUUID());
    let release!: () => void;
    const pending = new Promise<void>(resolve => { release = resolve; }), send = f.send.getMockImplementation()!;
    f.send.mockImplementationOnce(async (url, init) => { const response = await send(url, init); await pending; return response; });
    stream.emit("app.lifecycle", { phase: "start", generation: 0 });
    const inFlight = f.outbox.flush();
    await vi.waitFor(() => expect(f.requests).toHaveLength(1));
    f.outbox.configure({ ...active, enabled: false });
    release(); await inFlight;
    expect((await f.queue.read()).some(row => row.event.type === "diagnostic.clock")).toBe(false);
    f.outbox.configure(active);
    stream.emit("app.lifecycle", { phase: "resume", generation: 1 });
    await f.outbox.flush(); await f.outbox.flush(); await f.outbox.flush();
    const clocks = f.requests.flat().filter(event => event.type === "diagnostic.clock");
    expect(clocks).toEqual([expect.objectContaining({ streamId: stream.id, data: { offsetMs: expect.any(Number), uncertaintyMs: expect.any(Number) } })]);
    expect(await f.queue.read()).toEqual([]);
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
    await replay.flush(); await replay.flush();
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
    const rows = await f.queue.read();
    expect(rows.map(row => row.event)).toEqual([expect.objectContaining({ type: "diagnostic.loss", data: {
      reason: "expired", count: 1, affectedStreamId: event.streamId,
    } })]);
    expect(JSON.stringify(rows)).not.toContain("PRIVATE_CANARY"); expect(f.send).not.toHaveBeenCalled();
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
    const f = fixture({ textEnabled: true, producerId: "reloaded-tab" }), stream = f.outbox.stream();
    await Promise.resolve();
    const conversationId = crypto.randomUUID(), attemptId = crypto.randomUUID();
    stream.emit("transcript.fragment", { kind: "input", fragmentId: crypto.randomUUID(), charCount: 14 }, "PRIVATE_CANARY");
    stream.bind(conversationId, attemptId);
    f.send.mockRejectedValueOnce(new Error("offline"));
    await f.outbox.flush();
    const reloaded = new DiagnosticOutbox({ queue: f.queue, fetch: f.send, automatic: false, producerId: Promise.resolve("reloaded-tab") }); reloaded.configure({ ...active, textEnabled: true });
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
