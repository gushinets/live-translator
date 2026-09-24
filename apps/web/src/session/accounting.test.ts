import { IDBFactory } from "fake-indexeddb";
import { describe, expect, it, vi } from "vitest";
import { MetadataDeliveryBudget } from "./MetadataDeliveryBudget";
import type { CleanupTransport } from "./CleanupIntentOutbox";
import { ConversationAccounting } from "./ConversationAccounting";
import { AccountingRequestError, type LedgerApi, type ConversationMetadata } from "../api/AccountingBackend";

function budget(capacity = 1000) { return new MetadataDeliveryBudget({ indexedDB: new IDBFactory(), name: crypto.randomUUID(), capacity }); }
function fixture(store = budget()) {
  const c: ConversationMetadata = { conversationId: "conversation", version: 1, status: "active", productDeadlineAt: null, serverTime: Date.now(), policy: { sessionCloseTimeoutMs: 10 } };
  const api = {
    policy: vi.fn<LedgerApi["policy"]>(async () => ({ usageLedgerEnabled: true })),
    createConversation: vi.fn<LedgerApi["createConversation"]>(async () => c),
    createSession: vi.fn<LedgerApi["createSession"]>(async () => ({ session: { id: "provider" }, transport: { type: "webrtc", sdp: "answer" } })),
    handoff: vi.fn<LedgerApi["handoff"]>(async id => ({ liveSessionId: id, state: "active", handoffAcknowledgedAt: Date.now(), cleanupRequestedAt: null, conversation: c })),
    readAttempt: vi.fn<LedgerApi["readAttempt"]>(async id => ({ liveSessionId: id, state: "closed", handoffAcknowledgedAt: Date.now(), conversation: c })),
    cleanup: vi.fn<CleanupTransport["cleanup"]>(async () => ({ cleanupRequestedAt: Date.now() })),
    closed: vi.fn<CleanupTransport["closed"]>(async () => ({ state: "closed", closeConfirmed: true })),
    readConversation: vi.fn<LedgerApi["readConversation"]>(async () => c),
    end: vi.fn<LedgerApi["end"]>(async () => ({ ...c, status: "ended" })),
  };
  const scope = new ConversationAccounting({ api, budget: store, autoDelivery: false });
  return { budget: store, scope, api, c };
}

describe("shared IndexedDB metadata budget", () => {
  it("serializes two connections reserving the last slot and deduplicates IDs", async () => {
    const indexedDB = new IDBFactory(), name = crypto.randomUUID();
    const a = new MetadataDeliveryBudget({ indexedDB, name, capacity: 2 }), b = new MetadataDeliveryBudget({ indexedDB, name, capacity: 2 });
    await a.reserve("first", "c"); await b.reserve("first", "c");
    const results = await Promise.allSettled([a.reserve("second", "c"), b.reserve("third", "c")]);
    expect(results.filter(r => r.status === "fulfilled")).toHaveLength(1); expect(await a.entries()).toHaveLength(2);
    await a.close(); await b.close();
  });
  it("does not reclaim ambiguous dispatch or pending cleanup; marker proof then permits reclaim", async () => {
    const b = budget(1); await b.reserve("id", "c"); await b.markDispatchStarted("id"); await b.releaseIfSafe("id");
    expect(await b.entries()).toHaveLength(1); await b.enqueueCleanup("id", "hidden"); await b.enqueueCleanup("id", "user_end");
    expect((await b.get("id"))!.cleanup!.reason).toBe("hidden");
    await b.finishProducer("id", "lost"); await b.releaseIfSafe("id"); expect(await b.entries()).toHaveLength(1);
    await b.acknowledgeCleanup("id"); await b.releaseIfSafe("id"); expect(await b.entries()).toHaveLength(0); await b.close();
  });
  it("reclaims a proven never-dispatched cancelled attempt", async () => {
    const b = budget(); await b.reserve("id", "c"); await b.finishProducer("id", "no_provider"); await b.releaseIfSafe("id");
    expect(await b.entries()).toHaveLength(0); await b.close();
  });
});
describe("cleanup and End delivery", () => {
  it("does not replay another live scope's staged cleanup", async () => {
    const indexedDB = new IDBFactory(), name = crypto.randomUUID();
    const ownerBudget = new MetadataDeliveryBudget({ indexedDB, name }), followerBudget = new MetadataDeliveryBudget({ indexedDB, name });
    const owner = fixture(ownerBudget), follower = fixture(followerBudget), held = new Set<string>(), ownerLock = `live-metadata-producer:${ownerBudget.ownerProducerId}`;
    let ownerHasLock = false;
    Object.defineProperty(navigator, "locks", { configurable: true, value: { request: vi.fn((key: string, _options: { ifAvailable: boolean }, callback: (lock: object | null) => unknown) => {
      if (held.has(key)) return Promise.resolve(callback(null));
      held.add(key);
      const result = callback({});
      if (key === ownerLock && !ownerHasLock) { ownerHasLock = true; return new Promise(() => {}); }
      return Promise.resolve(result).finally(() => held.delete(key));
    }) } });
    try {
      const attempt = owner.scope.newAttempt(); await attempt.create("offer");
      await owner.scope.stageEnd("setup_cancel");
      expect(held.has(ownerLock)).toBe(true);

      await follower.scope.outbox.flush();
      expect(follower.api.cleanup).not.toHaveBeenCalled();

      await attempt.abandon("cancelled"); await owner.scope.outbox.flush();
      expect(owner.api.cleanup).toHaveBeenCalledOnce();
      expect(follower.api.cleanup).not.toHaveBeenCalled();

      await ownerBudget.reserve("orphan", "conversation"); await ownerBudget.markDispatchStarted("orphan");
      await ownerBudget.enqueueCleanup("orphan", "cancelled"); await ownerBudget.finishProducer("orphan", "lost");
      held.delete(ownerLock);
      await follower.scope.outbox.flush();
      expect(follower.api.cleanup).toHaveBeenCalledWith("orphan", "cancelled");
    } finally {
      Reflect.deleteProperty(navigator, "locks");
      await ownerBudget.close(); await followerBudget.close();
    }
  });

  it("persists before HTTP, and admission release alone is not a cleanup ACK", async () => {
    const f = fixture(); await f.budget.reserve("id", "c"); await f.budget.markDispatchStarted("id");
    f.api.cleanup.mockImplementation(async () => {
      expect((await f.budget.get("id"))!.cleanup!.reason).toBe("hidden"); return { leaseReleasedAt: 123 };
    });
    await f.scope.outbox.enqueue("id", "hidden"); await f.scope.outbox.flush(); expect(await f.budget.entries()).toHaveLength(1);
    f.api.cleanup.mockResolvedValue({ cleanupRequestedAt: 123 }); await f.scope.outbox.flush(); expect(await f.budget.entries()).toHaveLength(0); await f.budget.close();
  });
  it("commits cleanup ACK and safe release atomically", async () => {
    const f = fixture(); await f.budget.reserve("id", "c"); await f.budget.markDispatchStarted("id");
    await f.scope.outbox.enqueue("id", "hidden");
    const legacyRelease = vi.spyOn(f.budget, "releaseIfSafe").mockRejectedValue(new Error("simulated crash boundary"));
    f.api.cleanup.mockResolvedValue({ cleanupRequestedAt: 123 });
    await f.scope.outbox.flush();
    expect(legacyRelease).not.toHaveBeenCalled();
    expect(await f.budget.entries()).toHaveLength(0);
    await f.budget.close();
  });
  it("releases a cleanup-only envelope when producer finalization was lost", async () => {
    const f = fixture(); await f.budget.reserve("id", "c"); await f.budget.markDispatchStarted("id");
    await f.budget.enqueueCleanup("id", "hidden");
    f.api.cleanup.mockResolvedValue({ cleanupRequestedAt: 123 });

    await f.scope.outbox.flush();

    expect(await f.budget.entries()).toHaveLength(0); await f.budget.close();
  });

  it("keeps registration-race 404 retryable while owner conversation still exists", async () => {
    const f = fixture(); await f.budget.reserve("id", "c"); await f.budget.markDispatchStarted("id");
    f.api.cleanup.mockRejectedValue({ status: 404 }); await f.scope.outbox.enqueue("id", "abandoned_connect"); await f.scope.outbox.flush();
    expect(f.api.readConversation).toHaveBeenCalledWith("c"); expect(await f.budget.entries()).toHaveLength(1);
    f.api.cleanup.mockResolvedValue({ cleanupRequestedAt: 1 }); await f.scope.outbox.flush(); expect(await f.budget.entries()).toHaveLength(0); await f.budget.close();
  });
  it("persists failed product End and retries it without changing the expected version", async () => {
    const f = fixture(); f.api.end.mockRejectedValue(new Error("offline"));
    await f.scope.outbox.enqueueEnd("c", 2, "user_end"); await f.scope.outbox.flush(); expect(await f.budget.ends()).toHaveLength(1);
    f.api.end.mockResolvedValue({ ...f.c, status: "ended" }); await f.scope.outbox.flush();
    expect(f.api.end).toHaveBeenLastCalledWith("c", 2, "user_end"); expect(await f.budget.ends()).toHaveLength(0); await f.budget.close();
  });
  it("holds setup-cancel End until its cleanup receives proof", async () => {
    const f = fixture();
    await f.budget.reserve("attempt", "c");
    await f.budget.markDispatchStarted("attempt");
    await f.scope.outbox.enqueueEnd("c", 1, "setup_cancel", ["attempt"]);
    await f.scope.outbox.enqueue("attempt", "cancelled");
    f.api.cleanup.mockRejectedValueOnce(new Error("offline"));

    await f.scope.outbox.flush();

    expect(f.api.end).not.toHaveBeenCalled();
    expect(await f.budget.ends()).toHaveLength(1);
    f.api.cleanup.mockResolvedValueOnce({ cleanupRequestedAt: Date.now() });
    await f.scope.outbox.flush();
    expect(f.api.end).toHaveBeenCalledWith("c", 1, "setup_cancel");
    expect(await f.budget.ends()).toHaveLength(0);
    await f.budget.close();
  });
  it("delivers staged End after session.closed confirms its cleanup", async () => {
    const f = fixture();
    const attempt = f.scope.newAttempt();
    await attempt.create("offer");

    await f.scope.stageEnd("user_end");
    await attempt.finish({ finalized: true, usageSeconds: 7 });
    await f.scope.outbox.flush();

    expect(f.api.closed).toHaveBeenCalledWith(attempt.localId, { seconds: 7 });
    expect(f.api.end).toHaveBeenCalledWith(f.c.conversationId, f.c.version, "user_end");
    expect(await f.budget.ends()).toHaveLength(0);
    await f.budget.close();
  });
  it("removes an End dependency after direct cleanup proof", async () => {
    const f = fixture();
    await f.budget.reserve("attempt", "c");
    await f.budget.markDispatchStarted("attempt");
    await f.budget.enqueueEnd("c", 1, "user_end", ["attempt"]);

    await f.scope.acknowledgeDirectCleanup("attempt");

    expect((await f.budget.ends())[0]?.cleanupLocalIds).toEqual([]);
    await f.budget.close();
  });
  it("sends direct End after direct cleanup proof even when IndexedDB remains unavailable", async () => {
    const f = fixture(), attempt = f.scope.newAttempt(); await attempt.create("offer");
    vi.spyOn(f.scope.outbox, "enqueueEnd").mockRejectedValue(new Error("storage unavailable"));
    vi.spyOn(f.scope.outbox, "enqueue").mockRejectedValue(new Error("storage unavailable"));
    vi.spyOn(f.budget, "acknowledgeDirectCleanupAndRelease").mockRejectedValue(new Error("storage unavailable"));
    vi.spyOn(f.budget, "entries").mockRejectedValue(new Error("storage unavailable"));
    vi.spyOn(f.budget, "get").mockRejectedValue(new Error("storage unavailable"));

    await f.scope.end("user_end");

    expect(f.api.cleanup).toHaveBeenCalledWith(attempt.localId, "user_end");
    expect(f.api.end).toHaveBeenCalledWith(f.c.conversationId, f.c.version, "user_end");
    await f.budget.close();
  });
  it("sends a persisted End after direct cleanup proof when IndexedDB later fails", async () => {
    const f = fixture(), attempt = f.scope.newAttempt(); await attempt.create("offer");
    await f.scope.stageEnd("user_end");
    const enqueueEnd = f.scope.outbox.enqueueEnd.bind(f.scope.outbox);
    vi.spyOn(f.scope.outbox, "enqueueEnd").mockImplementation(async (...args) => {
      await enqueueEnd(...args);
      vi.spyOn(f.scope.outbox, "enqueue").mockRejectedValue(new Error("storage unavailable"));
      vi.spyOn(f.budget, "acknowledgeDirectCleanupAndRelease").mockRejectedValue(new Error("storage unavailable"));
      vi.spyOn(f.budget, "entries").mockRejectedValue(new Error("storage unavailable"));
      vi.spyOn(f.budget, "get").mockRejectedValue(new Error("storage unavailable"));
    });

    await f.scope.end("user_end");

    expect(f.api.cleanup).toHaveBeenCalledWith(attempt.localId, "user_end");
    expect(f.api.end).toHaveBeenCalledWith(f.c.conversationId, f.c.version, "user_end");
    await f.budget.close();
  });
  it("flushes a failed degraded direct End before the next managed create", async () => {
    const f = fixture(); const attempt = f.scope.newAttempt(); await attempt.create("offer");
    const revision = f.scope.revision;
    vi.spyOn(f.scope.outbox, "enqueueEnd").mockRejectedValue(new Error("storage unavailable"));
    f.api.end.mockRejectedValueOnce(new Error("offline"));

    await expect(f.scope.end("user_end", revision)).rejects.toThrow("offline");
    expect(f.api.end).toHaveBeenCalledTimes(1);

    f.api.end.mockResolvedValueOnce({ ...f.c, status: "ended" });
    const next = f.scope.newAttempt();
    await expect(next.create("next-offer")).resolves.toBeDefined();
    expect(f.api.end).toHaveBeenCalledTimes(2);
    expect(f.api.end).toHaveBeenLastCalledWith(f.c.conversationId, f.c.version, "user_end");

    await next.abandon("cancelled"); await f.scope.outbox.flush(); await f.budget.close();
  });
  it("drops stale End after conflict instead of taking over a newer conversation version", async () => {
    const f = fixture(); f.api.end.mockRejectedValue({ status: 409 }); f.api.readConversation.mockResolvedValue({ ...f.c, version: 3 });
    await f.scope.outbox.enqueueEnd("c", 2, "user_end"); await f.scope.outbox.flush(); expect(await f.budget.ends()).toHaveLength(0);
    expect(f.api.end).toHaveBeenCalledTimes(1); await f.budget.close();
  });
});
describe("controller-owned conversation accounting", () => {
  it("creates only after committed reserve and dispatch marker", async () => {
    const f = fixture(); const attempt = f.scope.newAttempt();
    f.api.createSession.mockImplementation(async body => {
      expect((await f.budget.get(body.liveSessionId))!.dispatchStartedAt).not.toBeNull();
      return { session: { id: "provider" }, transport: { type: "webrtc", sdp: "answer" } };
    });
    await attempt.create("offer"); expect(f.api.createSession).toHaveBeenCalledTimes(1);
    await attempt.abandon("cancelled"); await f.scope.outbox.flush(); await f.budget.close();
  });
  it("releases a local envelope and preserves initial semantics after a definitive pre-provider rejection", async () => {
    const f = fixture(); const attempt = f.scope.newAttempt();
    f.api.createSession.mockRejectedValueOnce(new AccountingRequestError(429, "accounting_request_failed"));
    await expect(attempt.create("offer")).rejects.toThrow("accounting_request_failed");
    expect(f.api.cleanup).not.toHaveBeenCalled();
    expect(await f.budget.entries()).toHaveLength(0);

    f.api.createSession.mockResolvedValueOnce({ session: { id: "provider-retry" }, transport: { type: "webrtc", sdp: "answer" } });
    const retry = f.scope.newAttempt();
    await expect(retry.create("retry-offer")).resolves.toBeDefined();
    expect(f.api.readAttempt).not.toHaveBeenCalled();
    expect(f.api.createSession.mock.calls[1]![0].startReason).toBe("initial");

    await retry.abandon("cancelled"); await f.scope.outbox.flush(); await f.budget.close();
  });

  it("removes staged cleanup dependency when a pending create definitively creates no provider", async () => {
    const f = fixture(), attempt = f.scope.newAttempt();
    let rejectCreate!: (error: Error) => void;
    f.api.createSession.mockImplementationOnce(() => new Promise((_resolve, reject) => { rejectCreate = reject; }));
    const creating = attempt.create("offer").catch(error => error);
    await vi.waitFor(() => expect(rejectCreate).toBeDefined());
    const staging = f.scope.stageEnd("setup_cancel");
    await vi.waitFor(async () => expect((await f.budget.get(attempt.localId))?.cleanup?.reason).toBe("cancelled"));
    rejectCreate(new AccountingRequestError(404, "attempt_registration_unavailable"));
    await Promise.all([creating, staging]);

    expect((await f.budget.get(attempt.localId))?.cleanup ?? null).toBeNull();
    expect((await f.budget.ends())[0]?.cleanupLocalIds).toEqual([]);
    await f.scope.outbox.flush();
    expect(f.api.cleanup).not.toHaveBeenCalled();
    expect(f.api.end).toHaveBeenCalledWith(f.c.conversationId, f.c.version, "setup_cancel");
    await f.budget.close();
  });

  it("sends a staged End after definitive no-provider proof when IndexedDB later fails", async () => {
    const f = fixture(), attempt = f.scope.newAttempt();
    let rejectCreate!: (error: Error) => void;
    f.api.createSession.mockImplementationOnce(() => new Promise((_resolve, reject) => { rejectCreate = reject; }));
    const creating = attempt.create("offer").catch(error => error);
    await vi.waitFor(() => expect(rejectCreate).toBeDefined());
    await f.scope.stageEnd("setup_cancel");
    rejectCreate(new AccountingRequestError(404, "attempt_registration_unavailable"));
    await creating;
    vi.spyOn(f.budget, "entries").mockRejectedValue(new Error("storage unavailable"));

    await f.scope.end("setup_cancel");

    expect(f.api.cleanup).not.toHaveBeenCalled();
    expect(f.api.end).toHaveBeenCalledWith(f.c.conversationId, f.c.version, "setup_cancel");
    await f.budget.close();
  });

  it("treats only the distinct pre-dispatch shutdown code as no-provider", async () => {
    const f = fixture(); const attempt = f.scope.newAttempt();
    f.api.createSession.mockRejectedValueOnce(new AccountingRequestError(503, "server_shutting_down_before_dispatch"));
    await expect(attempt.create("offer")).rejects.toThrow("server_shutting_down_before_dispatch");
    expect(await f.budget.entries()).toHaveLength(0);

    f.api.createSession.mockResolvedValueOnce({ session: { id: "provider-retry" }, transport: { type: "webrtc", sdp: "answer" } });
    const retry = f.scope.newAttempt(); await retry.create("retry");
    expect(f.api.createSession.mock.calls[1]![0].startReason).toBe("initial");
    await retry.abandon("cancelled"); await f.scope.outbox.flush(); await f.budget.close();
  });
  it.each(["server_shutting_down", "attempt_not_activatable"])("keeps post-provider %s ambiguous until cleanup ACK", async code => {
    const f = fixture(); const attempt = f.scope.newAttempt();
    f.api.createSession.mockRejectedValueOnce(new AccountingRequestError(code === "server_shutting_down" ? 503 : 409, code));
    await expect(attempt.create("offer")).rejects.toThrow(code);
    const pending = await f.budget.get(attempt.localId);
    expect(pending?.cleanup?.reason).toBe("response_not_received");
    expect(pending?.producerOutcome).toBe("lost");

    await f.scope.outbox.flush();
    f.api.createSession.mockResolvedValueOnce({ session: { id: "provider-retry" }, transport: { type: "webrtc", sdp: "answer" } });
    const retry = f.scope.newAttempt(); await retry.create("retry");
    expect(f.api.createSession.mock.calls[1]![0].startReason).toBe("bootstrap_replacement");
    await retry.abandon("cancelled"); await f.scope.outbox.flush(); await f.budget.close();
  });

  it("does not create any paid session when local storage is unavailable", async () => {
    const f = fixture(new MetadataDeliveryBudget({ indexedDB: null })); await expect(f.scope.newAttempt().create("offer")).rejects.toThrow("storage");
    expect(f.api.createSession).not.toHaveBeenCalled();
  });
  it("does not dispatch while marker commit is pending, or after it fails", async () => {
    const f = fixture(); let reject!: (reason: Error) => void;
    vi.spyOn(f.budget, "markDispatchStarted").mockImplementation(() => new Promise((_resolve, no) => { reject = no; }));
    const creation = f.scope.newAttempt().create("offer").catch((e: unknown) => e);
    await vi.waitFor(() => expect(reject).toBeDefined()); expect(f.api.createSession).not.toHaveBeenCalled();
    reject(new Error("QuotaExceeded")); await creation; expect(f.api.createSession).not.toHaveBeenCalled(); expect(await f.budget.entries()).toHaveLength(0); await f.budget.close();
  });
  it("retries degraded direct cleanup instead of resolving after an HTTP failure", async () => {
    const f = fixture(); const attempt = f.scope.newAttempt(); await attempt.create("offer");
    vi.spyOn(f.scope.outbox, "enqueue").mockRejectedValue(new Error("storage unavailable"));
    f.api.cleanup.mockRejectedValueOnce(new Error("offline"));
    await expect(attempt.abandon("replacement")).rejects.toThrow("offline");
    expect(attempt.finished).toBe(false);

    f.api.cleanup.mockResolvedValueOnce({ cleanupRequestedAt: Date.now() });
    await expect(attempt.abandon("replacement")).resolves.toBeUndefined();
    expect(f.api.cleanup).toHaveBeenCalledTimes(2);
    expect(attempt.finished).toBe(true);
    await f.budget.close();
  });

  it("sweeps a server-ACKed degraded cleanup envelope before the next create", async () => {
    const f = fixture(); const attempt = f.scope.newAttempt(); await attempt.create("offer");
    const enqueue = vi.spyOn(f.scope.outbox, "enqueue").mockImplementation(async (localId, reason) => {
      await f.budget.enqueueCleanup(localId, reason);
      throw new Error("storage unavailable after cleanup intent commit");
    });
    const localAck = vi.spyOn(f.budget, "acknowledgeDirectCleanupAndRelease")
      .mockRejectedValueOnce(new Error("storage still unavailable"));

    await expect(attempt.abandon("replacement")).resolves.toBeUndefined();
    expect(attempt.finished).toBe(true);
    expect((await f.budget.get(attempt.localId))?.cleanup?.reason).toBe("replacement");

    enqueue.mockRestore();
    const next = f.scope.newAttempt();
    await expect(next.create("next-offer")).resolves.toBeDefined();
    expect(localAck).toHaveBeenCalledTimes(2);
    expect(await f.budget.get(attempt.localId)).toBeNull();

    await next.abandon("cancelled"); await f.scope.outbox.flush(); await f.budget.close();
  });

  it("falls back to direct close delivery when durable close storage is unavailable", async () => {
    const f = fixture(); const attempt = f.scope.newAttempt(); await attempt.create("offer");
    vi.spyOn(f.scope.outbox, "observeClosed").mockRejectedValue(new Error("storage unavailable"));
    await attempt.finish({ finalized: true, reason: "user_requested", usageSeconds: 7 });
    expect(f.api.closed).toHaveBeenCalledWith(attempt.localId, { seconds: 7, reason: "user_requested" });
    expect(await f.budget.entries()).toHaveLength(0);
    await f.budget.close();
  });
  it("retries direct close delivery after a degraded-path HTTP failure", async () => {
    const f = fixture(); const attempt = f.scope.newAttempt(); await attempt.create("offer");
    vi.spyOn(f.scope.outbox, "observeClosed").mockRejectedValue(new Error("storage unavailable"));
    f.api.closed.mockRejectedValueOnce(new Error("offline"));
    await expect(attempt.finish({ finalized: true, usageSeconds: 9 })).rejects.toThrow("offline");
    f.api.closed.mockResolvedValue({ state: "closed", closeConfirmed: true });
    await expect(attempt.finish({ finalized: true, usageSeconds: 9 })).resolves.toBeUndefined();
    expect(f.api.closed).toHaveBeenCalledTimes(2);
    await f.budget.close();
  });
  it("retains End delivery when undispatched cleanup release fails", async () => {
    const f = fixture(), attempt = f.scope.newAttempt();
    vi.spyOn(f.budget, "markDispatchStarted").mockRejectedValueOnce(new Error("marker unavailable"));
    vi.spyOn(f.budget, "finishProducerAndRelease").mockRejectedValue(new Error("release unavailable"));
    await expect(attempt.create("offer")).rejects.toThrow("release unavailable");

    await expect(f.scope.end("user_end", f.scope.revision)).rejects.toThrow("release unavailable");
    expect(await f.budget.ends()).toHaveLength(1);
    await f.budget.close();
  });
  it("retries a direct close envelope release before the next create", async () => {
    const f = fixture(), attempt = f.scope.newAttempt(); await attempt.create("offer");
    vi.spyOn(f.scope.outbox, "observeClosed").mockRejectedValue(new Error("storage unavailable"));
    const release = vi.spyOn(f.budget, "finishProducerAndRelease").mockRejectedValueOnce(new Error("release unavailable"));

    await attempt.finish({ finalized: true, usageSeconds: 9 });
    expect(await f.budget.get(attempt.localId)).not.toBeNull();
    const next = f.scope.newAttempt(); await next.create("next-offer");
    expect(release).toHaveBeenCalledTimes(2);
    expect(await f.budget.get(attempt.localId)).toBeNull();
    await next.abandon("cancelled"); await f.scope.outbox.flush(); await f.budget.close();
  });
  it("releases a pre-dispatch registration failure and preserves initial semantics", async () => {
    const f = fixture(), attempt = f.scope.newAttempt();
    f.api.createSession.mockRejectedValueOnce(new AccountingRequestError(503, "attempt_registration_unavailable"));
    await expect(attempt.create("offer")).rejects.toThrow("attempt_registration_unavailable");
    expect(await f.budget.entries()).toHaveLength(0);

    f.api.createSession.mockResolvedValueOnce({ session: { id: "provider-retry" }, transport: { type: "webrtc", sdp: "answer" } });
    const retry = f.scope.newAttempt(); await retry.create("retry-offer");
    expect(f.api.createSession.mock.calls[1]![0].startReason).toBe("initial");
    await retry.abandon("cancelled"); await f.scope.outbox.flush(); await f.budget.close();
  });

  it("ends without cleanup when no-provider finalization storage fails", async () => {
    const f = fixture(), attempt = f.scope.newAttempt();
    let rejectCreate!: (error: Error) => void;
    f.api.createSession.mockImplementationOnce(() => new Promise((_resolve, reject) => { rejectCreate = reject; }));
    const creating = attempt.create("offer").catch(error => error);
    await vi.waitFor(() => expect(rejectCreate).toBeDefined());
    await f.scope.stageEnd("setup_cancel");
    f.api.cleanup.mockRejectedValue({ status: 404 });
    vi.spyOn(f.budget, "finishProducerAndRelease").mockRejectedValueOnce(new Error("finalization storage failed"));

    rejectCreate(new AccountingRequestError(404, "attempt_not_found"));
    await expect(creating).resolves.toMatchObject({ message: "finalization storage failed" });
    await f.scope.end("setup_cancel", f.scope.revision);
    await f.scope.outbox.flush();

    expect(f.api.cleanup).not.toHaveBeenCalled();
    expect(f.api.end).toHaveBeenCalledWith(f.c.conversationId, f.c.version, "setup_cancel");
    expect(await f.budget.ends()).toHaveLength(0);
    await f.budget.close();
  });

  it("does not cache an unavailable producer lock", async () => {
    const f = fixture(); let available = false;
    const locks = { request: vi.fn((_name: string, _options: { ifAvailable: boolean }, callback: (lock: object | null) => unknown) =>
      Promise.resolve(callback(available ? {} : null))) };
    Object.defineProperty(navigator, "locks", { configurable: true, value: locks });
    try {
      await expect(f.scope.newAttempt().create("blocked")).rejects.toThrow("ownership unavailable");
      available = true;
      const retry = f.scope.newAttempt();
      await expect(retry.create("retry")).resolves.toBeDefined();
      expect(locks.request).toHaveBeenCalledTimes(2);
      await retry.abandon("cancelled"); await f.scope.outbox.flush();
    } finally {
      Reflect.deleteProperty(navigator, "locks");
      await f.budget.close();
    }
  });

  it("keeps the same conversation across bootstrap replacements without duplicate rows for interpreter phase", async () => {
    const f = fixture(); const first = f.scope.newAttempt(); await first.create("first"); await first.finish({ finalized: true, usageSeconds: 15 }); await f.scope.outbox.flush();
    const second = f.scope.newAttempt(); await second.create("next");
    expect(f.api.createConversation).toHaveBeenCalledTimes(1);
    const a = f.api.createSession.mock.calls[0]![0], b = f.api.createSession.mock.calls[1]![0];
    expect(a.conversationId).toBe(b.conversationId); expect(a.liveSessionId).not.toBe(b.liveSessionId); expect(b.startReason).toBe("bootstrap_replacement");
    await second.abandon("cancelled"); await f.scope.outbox.flush(); await f.budget.close();
  });
  it("cancels an in-flight policy lookup before any provider can be created", async () => {
    const f = fixture(); let resolve!: (value: { usageLedgerEnabled: boolean }) => void;
    f.api.policy.mockImplementation(() => new Promise(ok => { resolve = ok; })); const a = f.scope.newAttempt(); const create = a.create("offer").catch((e: unknown) => e);
    await vi.waitFor(() => expect(resolve).toBeDefined()); await a.abandon("cancelled"); resolve({ usageLedgerEnabled: true }); await create;
    expect(f.api.createSession).not.toHaveBeenCalled(); await f.budget.close();
  });
  it("recovers a lost handoff ACK from read-back without creating a second provider", async () => {
    const f = fixture(); const a = f.scope.newAttempt(); await a.create("offer"); const receipt = await f.api.handoff(a.localId);
    f.api.handoff.mockRejectedValue(new Error("lost ACK")); f.api.readAttempt.mockResolvedValue(receipt); await a.handoff();
    expect(f.api.createSession).toHaveBeenCalledTimes(1); expect(f.api.readAttempt).toHaveBeenCalledTimes(1);
    await a.abandon("cancelled"); await f.scope.outbox.flush(); await f.budget.close();
  });
});

describe("stage 4 durable lifecycle boundary", () => {
  it("replays staged cleanup before End when a fresh accounting scope opens", async () => {
    const indexedDB = new IDBFactory(), name = crypto.randomUUID();
    const originalBudget = new MetadataDeliveryBudget({ indexedDB, name });
    const original = fixture(originalBudget);
    const attempt = original.scope.newAttempt();
    await attempt.create("offer");
    await original.scope.stageEnd("setup_cancel");
    await originalBudget.close();

    const recoveredBudget = new MetadataDeliveryBudget({ indexedDB, name });
    const order: string[] = [];
    original.api.cleanup.mockImplementation(async () => {
      order.push("cleanup");
      return { cleanupRequestedAt: Date.now() };
    });
    original.api.end.mockImplementation(async () => {
      order.push("end");
      return { ...original.c, status: "ended" };
    });
    const recovered = new ConversationAccounting({ api: original.api, budget: recoveredBudget });

    await vi.waitFor(() => expect(order).toEqual(["cleanup", "end"]));
    recovered.outbox.stop();
    recovered.usageOutbox?.stop();
    await recoveredBudget.close();
  });
  it("keeps cleanup from an already finished attempt as an End dependency", async () => {
    const f = fixture();
    const attempt = f.scope.newAttempt();
    await attempt.create("offer");
    await attempt.abandon("hidden");

    await f.scope.stageEnd("user_end");

    expect((await f.budget.ends())[0]?.cleanupLocalIds).toEqual([attempt.localId]);
    await f.budget.close();
  });
  it("requires proof before treating a direct closed response as retirement", async () => {
    const f = fixture(), attempt = f.scope.newAttempt(); await attempt.create("offer");
    vi.spyOn(f.scope.outbox, "observeClosed").mockRejectedValue(new Error("storage unavailable"));
    f.api.closed.mockResolvedValue({ state: "creating", closeConfirmed: false });

    await expect(attempt.finish({ finalized: true, usageSeconds: 7 })).rejects.toThrow("close was not confirmed");
    expect(attempt.finished).toBe(false);
    await f.budget.close();
  });
  it("delivers cleanup already committed before End instead of deferring it forever", async () => {
    const f = fixture(), attempt = f.scope.newAttempt();
    await attempt.create("offer");
    await attempt.abandon("hidden");
    await f.scope.stageEnd("user_end");
    await f.scope.end("user_end");
    await f.scope.outbox.flush();

    expect(f.api.cleanup).toHaveBeenCalledWith(attempt.localId, "hidden");
    expect(f.api.end).toHaveBeenCalledWith(f.c.conversationId, f.c.version, "user_end");
    await f.budget.close();
  });

  it("does not auto-deliver staged cleanup until graceful close has confirmation", async () => {
    const f = fixture(), attempt = f.scope.newAttempt(); await attempt.create("offer");
    f.scope.outbox.start();
    await f.scope.stageEnd("user_end");
    globalThis.dispatchEvent(new Event("online"));
    await f.scope.outbox.flush();
    expect(f.api.cleanup).not.toHaveBeenCalled();
    expect(f.api.closed).not.toHaveBeenCalled();
    expect(f.api.end).not.toHaveBeenCalled();

    await attempt.finish({ finalized: true, usageSeconds: 46 });
    await f.scope.outbox.flush();
    expect(f.api.closed).toHaveBeenCalledWith(attempt.localId, { seconds: 46 });
    expect(f.api.cleanup).not.toHaveBeenCalled();
    expect(f.api.end).toHaveBeenCalledWith(f.c.conversationId, f.c.version, "user_end");
    f.scope.outbox.stop(); await f.budget.close();
  });

  it("does not re-enqueue cleanup after its proof while usage remains pending", async () => {
    const f = fixture();
    await f.budget.reserve("attempt", f.c.conversationId, true);
    await f.budget.markDispatchStarted("attempt");
    await f.budget.enqueueUsage("attempt", { schemaVersion: 1, checkpointSeconds: 10 });
    await f.scope.outbox.enqueue("attempt", "response_not_received");
    await f.scope.outbox.flush();
    expect(await f.budget.get("attempt")).toMatchObject({ cleanup: null, usagePending: true, producerOutcome: "lost" });

    f.api.cleanup.mockRejectedValue(new Error("offline"));
    await f.scope.outbox.enqueueEnd(f.c.conversationId, f.c.version, "setup_cancel", ["attempt"]);
    expect((await f.budget.get("attempt"))?.cleanup).toBeNull();
    expect((await f.budget.ends())[0]?.cleanupLocalIds).toEqual([]);
    await f.scope.outbox.flush();
    expect(f.api.cleanup).toHaveBeenCalledTimes(1);
    expect(f.api.end).toHaveBeenCalledWith(f.c.conversationId, f.c.version, "setup_cancel");
    await f.budget.close();
  });

  it("does not send direct End or allow a new create before queued cleanup proof", async () => {
    const f = fixture(), attempt = f.scope.newAttempt(); await attempt.create("offer");
    const epoch = f.scope.revision;
    vi.spyOn(f.scope.outbox, "enqueueEnd").mockRejectedValue(new Error("quota"));
    f.api.cleanup.mockRejectedValue(new Error("offline"));
    await expect(f.scope.end("user_end", epoch)).rejects.toThrow("cleanup delivery is pending");
    expect(f.api.end).not.toHaveBeenCalled();
    await expect(f.scope.newAttempt().create("next")).rejects.toThrow("cleanup delivery is pending");
    expect(f.api.createSession).toHaveBeenCalledTimes(1);
    f.api.cleanup.mockResolvedValue({ cleanupRequestedAt: Date.now() });
    await f.scope.end("user_end", epoch);
    expect(f.api.end).toHaveBeenCalledTimes(1);
    expect(f.api.end).toHaveBeenCalledWith(f.c.conversationId, 1, "user_end"); await f.budget.close();
  });

  it("does not treat a release-only degraded response as a cleanup proof", async () => {
    const f = fixture(), attempt = f.scope.newAttempt(); await attempt.create("offer");
    vi.spyOn(f.scope.outbox, "enqueue").mockRejectedValue(new Error("quota"));
    f.api.cleanup.mockResolvedValue({ leaseReleasedAt: 123 });
    await expect(attempt.abandon("replacement")).rejects.toThrow("confirmed");
    expect(attempt.finished).toBe(false);
    f.api.cleanup.mockResolvedValue({ cleanupRequestedAt: 123 });
    await attempt.abandon("cancelled");
    expect(f.api.cleanup).toHaveBeenLastCalledWith(attempt.localId, "replacement"); await f.budget.close();
  });

  it("waits for the previous terminal metadata write before dispatching a replacement", async () => {
    const f = fixture(), first = f.scope.newAttempt(); await first.create("first");
    let resume!: () => void;
    const observe = f.scope.outbox.observeClosed.bind(f.scope.outbox);
    vi.spyOn(f.scope.outbox, "observeClosed").mockImplementationOnce(async (id, value) => {
      await new Promise<void>(r => { resume = r; }); await observe(id, value);
    });
    const finishing = first.finish({ finalized: true, usageSeconds: 46 });
    const next = f.scope.newAttempt(), creating = next.create("next");
    await new Promise(r => setTimeout(r, 30));
    expect(f.api.createSession).toHaveBeenCalledTimes(1);
    resume(); await finishing; await creating;
    expect(f.api.createSession).toHaveBeenCalledTimes(2);
    await next.abandon("cancelled"); await f.scope.outbox.flush(); await f.budget.close();
  });

  it("atomically stores user End with dispatched cleanup for recovery after a crash", async () => {
    const indexedDB = new IDBFactory(), name = crypto.randomUUID();
    const store = new MetadataDeliveryBudget({ indexedDB, name });
    await store.reserve("attempt", "c", true); await store.markDispatchStarted("attempt");
    await store.enqueueUsage("attempt", { schemaVersion: 1, checkpointSeconds: 43 });
    const enqueue = store.enqueueEnd.bind(store) as (id: string, version: number, reason: "user_end", cleanupIds: string[]) => Promise<void>;
    await enqueue("c", 1, "user_end", ["attempt"]); await store.close();
    const reloaded = new MetadataDeliveryBudget({ indexedDB, name });
    expect((await reloaded.get("attempt"))?.cleanup?.reason).toBe("user_end");
    expect((await reloaded.get("attempt"))?.usage?.report.checkpointSeconds).toBe(43);
    expect(await reloaded.ends()).toMatchObject([{ conversationId: "c", expectedVersion: 1 }]);
    const f = fixture(reloaded), order: string[] = [];
    f.api.cleanup.mockImplementation(async () => { order.push("cleanup"); return { cleanupRequestedAt: 1 }; });
    f.api.end.mockImplementation(async () => { order.push("end"); return { ...f.c, status: "ended" }; });
    await f.scope.outbox.flush(); expect(order).toEqual(["cleanup", "end"]);
    expect((await reloaded.get("attempt"))?.usage?.report.checkpointSeconds).toBe(43); await reloaded.close();
  });
  it("holds a legacy End until its matching cleanup receives proof", async () => {
    const indexedDB = new IDBFactory(), name = crypto.randomUUID();
    const store = new MetadataDeliveryBudget({ indexedDB, name });
    await store.reserve("attempt", "c"); await store.markDispatchStarted("attempt");
    await store.enqueueCleanup("attempt", "cancelled"); await store.enqueueEnd("c", 1, "setup_cancel");
    const db = await new Promise<IDBDatabase>((resolve, reject) => {
      const request = indexedDB.open(name); request.onsuccess = () => resolve(request.result); request.onerror = () => reject(request.error);
    });
    await new Promise<void>((resolve, reject) => {
      const tx = db.transaction("lifecycle", "readwrite"), lifecycle = tx.objectStore("lifecycle"), get = lifecycle.get("c");
      get.onsuccess = () => { const legacy = get.result as { cleanupLocalIds?: string[] }; delete legacy.cleanupLocalIds; lifecycle.put(legacy); };
      tx.oncomplete = () => resolve(); tx.onerror = () => reject(tx.error);
    });
    db.close();
    const f = fixture(store); f.api.cleanup.mockRejectedValue(new Error("offline"));
    await f.scope.outbox.flush(); expect(f.api.end).not.toHaveBeenCalled();
    f.api.cleanup.mockResolvedValue({ cleanupRequestedAt: Date.now() });
    await f.scope.outbox.flush(); expect(f.api.end).toHaveBeenCalledWith("c", 1, "setup_cancel"); await store.close();
  });
  it("rolls back cleanup markers when the atomic End transaction cannot be stored", async () => {
    const f = fixture(); await f.budget.reserve("attempt", "c", true); await f.budget.markDispatchStarted("attempt");
    // Fill the existing bounded lifecycle store: its rejection must abort both stores.
    for (let i = 0; i < 1000; i++) await f.budget.enqueueEnd(`old-${i}`, 1, "user_end");
    await expect(f.budget.enqueueEnd("c", 1, "user_end", ["attempt"])).rejects.toThrow("full");
    expect((await f.budget.get("attempt"))?.cleanup).toBeNull();
    expect((await f.budget.ends()).some(e => e.conversationId === "c")).toBe(false); await f.budget.close();
  });

});
