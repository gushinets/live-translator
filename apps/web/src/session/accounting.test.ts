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
  it("releases a local envelope after a definitive pre-provider create rejection", async () => {
    const f = fixture(); const attempt = f.scope.newAttempt();
    f.api.createSession.mockRejectedValue(new AccountingRequestError(429, "accounting_request_failed"));
    await expect(attempt.create("offer")).rejects.toThrow("accounting_request_failed");
    expect(f.api.cleanup).not.toHaveBeenCalled();
    expect(await f.budget.entries()).toHaveLength(0);
    await f.budget.close();
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
