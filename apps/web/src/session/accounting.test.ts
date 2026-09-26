import { IDBFactory } from "fake-indexeddb";
import { existsSync, readFileSync } from "node:fs";
import { resolve } from "node:path";
import { DatabaseSync } from "node:sqlite";
import { describe, expect, it, vi } from "vitest";
import { MetadataDeliveryBudget, METADATA_TTL_MS, noProviderProofDatabaseName } from "./MetadataDeliveryBudget";
import { ATTEMPT_REGISTRATION_GRACE_MS, CleanupIntentOutbox, type CleanupTransport } from "./CleanupIntentOutbox";
import { ConversationAccounting } from "./ConversationAccounting";
import { AccountingRequestError, type LedgerApi, type ConversationMetadata } from "../api/AccountingBackend";
import type { ResumeSnapshotStore } from "./ResumeSnapshotStore";
import { UsageLedger } from "../../../api/src/accounting/UsageLedger";
import { LedgerError } from "../../../api/src/accounting/types";

function budget(capacity = 1000) { return new MetadataDeliveryBudget({ indexedDB: new IDBFactory(), name: crypto.randomUUID(), capacity }); }
function fixture(store = budget()) {
  const c: ConversationMetadata = { conversationId: "conversation", version: 1, status: "active", productDeadlineAt: null,
    resumeExpiresAt: null, resumeAttemptId: null, serverTime: Date.now(), policy: { sessionCloseTimeoutMs: 10,
      backgroundSessionCloseEnabled: false, conversationRetentionMs: 300000, maxProviderSessionMs: 900000,
      maxConversationElapsedMs: 900000, sessionHandoffAckTimeoutMs: 30000, resumeClaimTimeoutMs: 60000,
      policyVersion: "unit-economics-v1.1" } };
  const api = {
    policy: vi.fn<LedgerApi["policy"]>(async () => ({ usageLedgerEnabled: true, backgroundSessionCloseEnabled: false })),
    createConversation: vi.fn<LedgerApi["createConversation"]>(async () => c),
    createSession: vi.fn<LedgerApi["createSession"]>(async () => ({ session: { id: "provider" }, transport: { type: "webrtc", sdp: "answer" } })),
    handoff: vi.fn<LedgerApi["handoff"]>(async id => ({ liveSessionId: id, state: "active", handoffAcknowledgedAt: Date.now(), cleanupRequestedAt: null, conversation: c })),
    readAttempt: vi.fn<LedgerApi["readAttempt"]>(async id => ({ liveSessionId: id, state: "closed", handoffAcknowledgedAt: Date.now(), conversation: c })),
    cleanup: vi.fn<CleanupTransport["cleanup"]>(async () => ({ cleanupRequestedAt: Date.now() })),
    recover: vi.fn(async (...args: [string, string, string]): Promise<{ cleanupRequestedAt?: number; state: string; openaiSessionId: string | null }> => {
      void args; return { cleanupRequestedAt: Date.now(), state: "closing", openaiSessionId: "provider" };
    }),
    closed: vi.fn<CleanupTransport["closed"]>(async () => ({ state: "closed", closeConfirmed: true })),
    readConversation: vi.fn<LedgerApi["readConversation"]>(async () => c),
    pause: vi.fn<LedgerApi["pause"]>(),
    claimResume: vi.fn<LedgerApi["claimResume"]>(),
    completeResume: vi.fn<LedgerApi["completeResume"]>(),
    abortResume: vi.fn<LedgerApi["abortResume"]>(),
    end: vi.fn<LedgerApi["end"]>(async () => ({ ...c, status: "ended" })),
  };
  const scope = new ConversationAccounting({ api, budget: store, autoDelivery: false });
  return { budget: store, scope, api, c };
}
async function updateEnvelope(indexedDB: IDBFactory, name: string, id: string, patch: Record<string, unknown>) {
  const db = await new Promise<IDBDatabase>((resolve, reject) => {
    const request = indexedDB.open(name); request.onsuccess = () => resolve(request.result); request.onerror = () => reject(request.error);
  });
  await new Promise<void>((resolve, reject) => {
    const tx = db.transaction("envelopes", "readwrite"), store = tx.objectStore("envelopes"), get = store.get(id);
    get.onsuccess = () => store.put({ ...get.result, ...patch });
    tx.oncomplete = () => resolve(); tx.onerror = () => reject(tx.error);
  });
  db.close();
}
async function expireEnd(indexedDB: IDBFactory, name: string, id: string) {
  const db = await new Promise<IDBDatabase>((resolve, reject) => {
    const request = indexedDB.open(name); request.onsuccess = () => resolve(request.result); request.onerror = () => reject(request.error);
  });
  await new Promise<void>((resolve, reject) => {
    const tx = db.transaction("lifecycle", "readwrite"), store = tx.objectStore("lifecycle"), get = store.get(id);
    get.onsuccess = () => store.put({ ...get.result, expiresAt: Date.now() - 1 });
    tx.oncomplete = () => resolve(); tx.onerror = () => reject(tx.error);
  });
  db.close();
}
async function seedV1(database: IDBFactory, name: string, row: Record<string, unknown>, end: Record<string, unknown>) {
  const db = await new Promise<IDBDatabase>((resolve, reject) => {
    const request = database.open(name, 1);
    request.onupgradeneeded = () => { request.result.createObjectStore("envelopes", { keyPath: "localId" }); request.result.createObjectStore("lifecycle", { keyPath: "conversationId" }); };
    request.onsuccess = () => resolve(request.result); request.onerror = () => reject(request.error);
  });
  await new Promise<void>((resolve, reject) => {
    const tx = db.transaction(["envelopes", "lifecycle"], "readwrite");
    tx.objectStore("envelopes").put(row); tx.objectStore("lifecycle").put(end);
    tx.oncomplete = () => resolve(); tx.onerror = () => reject(tx.error);
  });
  db.close();
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
  it("keeps proof for one attempt separate from another attempt's cleanup ACK", async () => {
    const b = budget();
    for (const id of ["proven", "uncertain"]) { await b.reserve(id, "c"); await b.markDispatchStarted(id); }
    await b.finishProducerAndRelease("proven", "no_provider");
    await b.enqueueEnd("c", 1, "setup_cancel", ["proven", "uncertain"], 0, "policy");
    expect((await b.ends())[0]).toMatchObject({ cleanupLocalIds: ["uncertain"], noProviderPendingLocalIds: ["uncertain"] });
    await b.acknowledgeCleanupAndRelease("uncertain");
    expect((await b.ends())[0]).toMatchObject({ cleanupLocalIds: [], noProviderPendingLocalIds: ["uncertain"] });
    await b.close();
  });
  it("drops a no-provider id proven after End snapshots proofs and before End commits", async () => {
    const indexedDB = new IDBFactory(), name = crypto.randomUUID();
    const b = new MetadataDeliveryBudget({ indexedDB, name });
    await b.reserve("attempt", "c");
    await b.markDispatchStarted("attempt");
    const target = b as unknown as { listProofs(): Promise<Array<{ localId: string | [string, string] }>> };
    const readProofs = target.listProofs.bind(target);
    let release!: () => void;
    const gate = new Promise<void>(resolve => { release = resolve; });
    let listed!: () => void;
    const sawList = new Promise<void>(resolve => { listed = resolve; });
    vi.spyOn(target, "listProofs").mockImplementationOnce(async () => {
      const proofs = await readProofs();
      listed();
      await gate;
      return proofs;
    });
    const ending = b.enqueueEnd("c", 1, "setup_cancel", [], 0, "policy", ["attempt"]);
    await sawList;
    await b.finishProducerAndRelease("attempt", "no_provider", "c");
    release();
    await ending;
    expect((await b.ends())[0]?.noProviderPendingLocalIds).toEqual([]);
    const remaining = await new Promise<unknown[]>((resolve, reject) => {
      const request = indexedDB.open(noProviderProofDatabaseName(name));
      request.onerror = () => reject(request.error ?? new Error("proof database unavailable"));
      request.onsuccess = () => {
        const db = request.result;
        const tx = db.transaction("noProviderProofs", "readonly");
        const all = tx.objectStore("noProviderProofs").getAll();
        all.onsuccess = () => { db.close(); resolve(all.result as unknown[]); };
        tx.onerror = () => { db.close(); reject(tx.error ?? new Error("proof read failed")); };
      };
    });
    expect(remaining).toEqual([]);
    await b.close();
  });
  it("applies an unexpired version-3 no-provider proof once and does not copy it back", async () => {
    const indexedDB = new IDBFactory(), name = crypto.randomUUID(), now = Date.now();
    const created = await new Promise<IDBDatabase>((resolve, reject) => {
      const request = indexedDB.open(name, 3);
      request.onupgradeneeded = () => {
        request.result.createObjectStore("envelopes", { keyPath: "localId" });
        request.result.createObjectStore("lifecycle", { keyPath: "conversationId" });
        request.result.createObjectStore("noProviderProofs", { keyPath: "localId" });
      };
      request.onsuccess = () => resolve(request.result);
      request.onerror = () => reject(request.error ?? new Error("seed failed"));
    });
    await new Promise<void>((resolve, reject) => {
      const tx = created.transaction("noProviderProofs", "readwrite");
      const proofs = tx.objectStore("noProviderProofs");
      proofs.put({ localId: ["c", "attempt"], attemptLocalId: "attempt", conversationId: "c", expiresAt: now + METADATA_TTL_MS });
      proofs.put({ localId: ["c", "stale"], attemptLocalId: "stale", conversationId: "c", expiresAt: now - 1 });
      tx.oncomplete = () => resolve();
      tx.onerror = () => reject(tx.error ?? new Error("proof seed failed"));
    });
    created.close();
    const store = new MetadataDeliveryBudget({ indexedDB, name });
    await store.enqueueEnd("c", 1, "setup_cancel", [], 0, "policy", ["attempt", "stale"]);
    expect((await store.ends())[0]?.noProviderPendingLocalIds).toEqual(["stale"]);
    await store.close();
    const legacy = await new Promise<unknown[]>((resolve, reject) => {
      const request = indexedDB.open(name);
      request.onerror = () => reject(request.error ?? new Error("legacy reopen failed"));
      request.onsuccess = () => {
        const db = request.result;
        const tx = db.transaction("noProviderProofs", "readonly");
        const all = tx.objectStore("noProviderProofs").getAll();
        all.onsuccess = () => { db.close(); resolve(all.result as unknown[]); };
        tx.onerror = () => { db.close(); reject(tx.error ?? new Error("legacy proof read failed")); };
      };
    });
    expect(legacy).toEqual([]);
    const again = new MetadataDeliveryBudget({ indexedDB, name });
    await again.enqueueEnd("c", 2, "setup_cancel", [], 0, "policy", ["attempt", "stale"]);
    expect((await again.ends())[0]?.noProviderPendingLocalIds).toEqual(["attempt", "stale"]);
    await again.close();
  });
  it("replays an expired End when a no-provider proof survives an interrupted reconcile", async () => {
    vi.useFakeTimers({ toFake: ["Date"] });
    const b = budget();
    try {
    await b.reserve("attempt", "c");
    await b.markDispatchStarted("attempt");
    const target = b as unknown as {
      listProofs(): Promise<unknown[]>;
      reconcileLaterProofs(conversationId: string, expectedVersion: number, consumed: unknown[]): Promise<void>;
    };
    const readProofs = target.listProofs.bind(target);
    let release!: () => void;
    const gate = new Promise<void>(resolve => { release = resolve; });
    let listed!: () => void;
    const sawList = new Promise<void>(resolve => { listed = resolve; });
    vi.spyOn(target, "listProofs").mockImplementationOnce(async () => {
      const proofs = await readProofs();
      listed();
      await gate;
      return proofs;
    });
    vi.spyOn(target, "reconcileLaterProofs").mockRejectedValueOnce(new Error("reconcile did not commit"));
    const ending = b.enqueueEnd("c", 1, "setup_cancel", [], 0, "policy", ["attempt"]);
    await sawList;
    await b.finishProducerAndRelease("attempt", "no_provider", "c");
    release();
    await expect(ending).rejects.toThrow("reconcile did not commit");
    expect((await b.ends())[0]?.noProviderPendingLocalIds).toEqual(["attempt"]);
    vi.mocked(target.reconcileLaterProofs).mockRestore();
    const ended = vi.fn()
      .mockRejectedValueOnce(new Error("offline"))
      .mockResolvedValueOnce({ status: "ended" });
    const outbox = new CleanupIntentOutbox(b, {
      cleanup: async () => ({}), closed: async () => ({}),
      readConversation: async () => ({ conversationId: "c", version: 1, status: "active", productDeadlineAt: null,
        resumeAttemptId: null, serverTime: Date.now(),
        policy: { policyVersion: "policy", backgroundSessionCloseEnabled: true } }),
      end: ended,
    });
    await outbox.flush();
    expect((await b.ends())[0]?.noProviderPendingLocalIds).toEqual([]);
    vi.setSystemTime(Date.now() + METADATA_TTL_MS + 1);
    await outbox.flush();
    expect(ended).toHaveBeenNthCalledWith(2, "c", 1, "setup_cancel");
    expect(await b.ends()).toEqual([]);
    } finally { await b.close(); vi.useRealTimers(); }
  });
  it("opens a metadata database left at version 3 when envelope stores exist", async () => {
    const indexedDB = new IDBFactory(), name = crypto.randomUUID();
    const created = await new Promise<IDBDatabase>((resolve, reject) => {
      const request = indexedDB.open(name, 3);
      request.onupgradeneeded = () => {
        request.result.createObjectStore("envelopes", { keyPath: "localId" });
        request.result.createObjectStore("lifecycle", { keyPath: "conversationId" });
        request.result.createObjectStore("noProviderProofs", { keyPath: "localId" });
      };
      request.onsuccess = () => resolve(request.result);
      request.onerror = () => reject(request.error ?? new Error("seed failed"));
    });
    created.close();
    const store = new MetadataDeliveryBudget({ indexedDB, name });
    await store.enqueueEnd("c", 1, "user_end");
    expect(await store.ends()).toMatchObject([{ conversationId: "c", expectedVersion: 1 }]);
    await store.close();
  });
  it("rejects a higher metadata version that lacks envelope stores", async () => {
    const indexedDB = new IDBFactory(), name = crypto.randomUUID();
    const created = await new Promise<IDBDatabase>((resolve, reject) => {
      const request = indexedDB.open(name, 3);
      request.onupgradeneeded = () => { request.result.createObjectStore("other", { keyPath: "id" }); };
      request.onsuccess = () => resolve(request.result);
      request.onerror = () => reject(request.error ?? new Error("seed failed"));
    });
    created.close();
    const store = new MetadataDeliveryBudget({ indexedDB, name });
    await expect(store.enqueueEnd("c", 1, "user_end")).rejects.toThrow("Metadata storage unavailable");
    await store.close();
  });
  it("does not apply a no-provider proof to another conversation", async () => {
    const b = budget(); await b.reserve("attempt", "original"); await b.markDispatchStarted("attempt");
    await b.finishProducerAndRelease("attempt", "no_provider");
    await b.enqueueEnd("foreign", 1, "setup_cancel", [], 0, "policy", ["attempt"]);
    expect((await b.ends())[0]?.noProviderPendingLocalIds).toEqual(["attempt"]);
    await b.close();
  });
  it.each([
    { order: "End before proof", releaseEnvelope: false },
    { order: "End before proof", releaseEnvelope: true },
    { order: "proof before End", releaseEnvelope: false },
  ])("does not release a foreign End sharing an attempt ID: $order, envelope released $releaseEnvelope", async ({ order, releaseEnvelope }) => {
    vi.useFakeTimers({ toFake: ["Date"] });
    const b = budget();
    try {
      await b.reserve("shared", "original"); await b.markDispatchStarted("shared");
      const enqueueBothEnds = async () => {
        await b.enqueueEnd("original", 1, "setup_cancel", ["shared"], 0, "policy", ["shared"]);
        await b.enqueueEnd("foreign", 1, "setup_cancel", [], 0, "policy", ["shared"]);
      };
      if (order === "End before proof") await enqueueBothEnds();
      if (releaseEnvelope) {
        await b.enqueueCleanup("shared", "cancelled"); await b.acknowledgeDirectCleanupAndRelease("shared");
        expect(await b.get("shared")).toBeNull();
      }
      await b.finishProducerAndRelease("shared", "no_provider", "original");
      if (order === "proof before End") await enqueueBothEnds();
      const ends = new Map((await b.ends()).map(end => [end.conversationId, end]));
      expect(ends.get("original")?.noProviderPendingLocalIds).toEqual([]);
      expect(ends.get("foreign")?.noProviderPendingLocalIds).toEqual(["shared"]);

      vi.setSystemTime(Date.now() + METADATA_TTL_MS + 1);
      const end = vi.fn<NonNullable<CleanupTransport["end"]>>(async () => ({ status: "ended" }));
      const outbox = new CleanupIntentOutbox(b, {
        cleanup: async () => ({}), closed: async () => ({}), end,
        readConversation: async conversationId => ({ conversationId, version: 1, status: "active", productDeadlineAt: null,
          resumeAttemptId: null, serverTime: Date.now(), policy: { policyVersion: "policy", backgroundSessionCloseEnabled: true } }),
      });
      await outbox.flush();
      expect(end).toHaveBeenCalledExactlyOnceWith("original", 1, "setup_cancel");
      expect((await b.ends())[0]).toMatchObject({ conversationId: "foreign", noProviderPendingLocalIds: ["shared"] });
    } finally { await b.close(); vi.useRealTimers(); }
  });
  it("preserves a late original proof without changing a reused local ID", async () => {
    const b = budget();
    await b.reserve("shared", "original"); await b.markDispatchStarted("shared");
    await b.finishProducerAndRelease("shared", "no_provider", "original");
    await b.reserve("shared", "foreign"); await b.markDispatchStarted("shared");
    await b.enqueueEnd("foreign", 1, "setup_cancel", ["shared"], 0, "policy", ["shared"]);
    await b.finishProducerAndRelease("shared", "no_provider", "original");
    await expect(b.finishProducer("shared", "no_provider", "original")).rejects.toThrow("Metadata identity conflict");
    expect((await b.ends())[0]).toMatchObject({ cleanupLocalIds: ["shared"], noProviderPendingLocalIds: ["shared"] });
    expect(await b.get("shared")).toMatchObject({ conversationId: "foreign", producerFinalized: false });
    await b.enqueueEnd("original", 1, "setup_cancel", [], 0, "policy", ["shared"]);
    expect((await b.ends()).find(end => end.conversationId === "original")?.noProviderPendingLocalIds).toEqual([]);
    await b.close();
  });
  it("keeps simultaneous no-provider proofs for different conversations sharing a local ID", async () => {
    const b = budget();
    await b.reserve("shared", "original"); await b.markDispatchStarted("shared");
    await b.finishProducerAndRelease("shared", "no_provider", "original");
    await b.reserve("shared", "foreign"); await b.markDispatchStarted("shared");
    await b.finishProducerAndRelease("shared", "no_provider", "foreign");
    for (const id of ["original", "foreign"]) await b.enqueueEnd(id, 1, "setup_cancel", [], 0, "policy", ["shared"]);
    const ends = new Map((await b.ends()).map(end => [end.conversationId, end]));
    expect(ends.get("original")?.noProviderPendingLocalIds).toEqual([]);
    expect(ends.get("foreign")?.noProviderPendingLocalIds).toEqual([]);
    await b.close();
  });
  it("keeps an open version-2 metadata tab usable when a new tab stores no-provider proof", async () => {
    const indexedDB = new IDBFactory(), name = crypto.randomUUID();
    const legacy = await new Promise<IDBDatabase>((resolve, reject) => {
      const request = indexedDB.open(name, 2);
      request.onupgradeneeded = () => {
        const db = request.result;
        if (!db.objectStoreNames.contains("envelopes")) db.createObjectStore("envelopes", { keyPath: "localId" });
        if (!db.objectStoreNames.contains("lifecycle")) db.createObjectStore("lifecycle", { keyPath: "conversationId" });
      };
      request.onsuccess = () => resolve(request.result);
      request.onerror = () => reject(request.error ?? new Error("legacy metadata open failed"));
    });
    let upgraded = false;
    legacy.onversionchange = () => { upgraded = true; legacy.close(); };
    const next = new MetadataDeliveryBudget({ indexedDB, name });
    await next.reserve("attempt", "conversation");
    await next.markDispatchStarted("attempt");
    await next.finishProducerAndRelease("attempt", "no_provider", "conversation");
    expect(upgraded).toBe(false);
    await new Promise<void>((resolve, reject) => {
      const tx = legacy.transaction("envelopes", "readonly");
      tx.oncomplete = () => resolve();
      tx.onerror = () => reject(tx.error ?? new Error("legacy metadata transaction failed"));
      tx.objectStore("envelopes").get("attempt");
    });
    const reopened = await new Promise<IDBDatabase>((resolve, reject) => {
      const request = indexedDB.open(name, 2);
      request.onsuccess = () => resolve(request.result);
      request.onerror = () => reject(request.error ?? new Error("version-2 metadata reopen failed"));
    });
    expect(reopened.version).toBe(2);
    reopened.close();
    legacy.close();
    await next.close();
  });
  it("keeps a legacy string-keyed no-provider proof when a new conversation reuses its local ID", async () => {
    const indexedDB = new IDBFactory(), name = crypto.randomUUID();
    const b = new MetadataDeliveryBudget({ indexedDB, name });
    await b.reserve("shared", "foreign"); await b.markDispatchStarted("shared");
    const db = await new Promise<IDBDatabase>((resolve, reject) => {
      const request = indexedDB.open(noProviderProofDatabaseName(name), 1);
      request.onupgradeneeded = () => {
        if (!request.result.objectStoreNames.contains("noProviderProofs"))
          request.result.createObjectStore("noProviderProofs", { keyPath: "localId" });
      };
      request.onsuccess = () => resolve(request.result);
      request.onerror = () => reject(request.error);
    });
    await new Promise<void>((resolve, reject) => {
      const tx = db.transaction("noProviderProofs", "readwrite");
      tx.objectStore("noProviderProofs").put({ localId: "shared", conversationId: "original", expiresAt: Date.now() + METADATA_TTL_MS });
      tx.oncomplete = () => resolve(); tx.onerror = () => reject(tx.error);
    });
    db.close();
    await b.finishProducerAndRelease("shared", "no_provider", "foreign");
    for (const id of ["original", "foreign"]) await b.enqueueEnd(id, 1, "setup_cancel", [], 0, "policy", ["shared"]);
    for (const end of await b.ends()) expect(end.noProviderPendingLocalIds).toEqual([]);
    await b.close();
  });
  it.each([
    { route: "readAttempt", reuseId: false }, { route: "readAttempt", reuseId: true }, { route: "recover", reuseId: true },
  ])("keeps a delayed $route no-provider proof after the old row is ACKed, reused ID $reuseId", async ({ route, reuseId }) => {
    vi.useFakeTimers({ toFake: ["Date"] });
    const indexedDB = new IDBFactory(), name = crypto.randomUUID();
    const owner = new MetadataDeliveryBudget({ indexedDB, name, producerId: "owner" });
    const otherTab = new MetadataDeliveryBudget({ indexedDB, name, producerId: "other" });
    const reloadedBudget = new MetadataDeliveryBudget({ indexedDB, name, producerId: "reload" });
    try {
      await owner.reserve("shared", "original"); await owner.markDispatchStarted("shared");
      await owner.enqueueCleanup("shared", "cancelled");
      if (route === "readAttempt") await owner.acknowledgeCleanup("shared");
      await owner.enqueueEnd("original", 1, "setup_cancel", route === "recover" ? ["shared"] : [], 0, "policy", ["shared"]);
      let proofRequested!: () => void, releaseProof!: () => void;
      const requested = new Promise<void>(resolve => { proofRequested = resolve; });
      const gate = new Promise<void>(resolve => { releaseProof = resolve; });
      const delayedProof = async () => { proofRequested(); await gate; return { state: "failed", openaiSessionId: null, cleanupRequestedAt: Date.now() }; };
      const offline = new CleanupIntentOutbox(otherTab, {
        cleanup: async () => ({}), closed: async () => ({}),
        readAttempt: route === "readAttempt" ? delayedProof : undefined,
        recover: route === "recover" ? delayedProof : undefined,
        readConversation: async () => ({}), end: async () => { throw new Error("offline"); },
      });
      const flushing = offline.flush();
      await requested;
      await owner.acknowledgeDirectCleanupAndRelease("shared");
      expect(await owner.get("shared")).toBeNull();
      if (reuseId) { await owner.reserve("shared", "foreign", true); await owner.markDispatchStarted("shared"); }
      releaseProof();
      await flushing;
      expect((await owner.ends())[0]).toMatchObject({ conversationId: "original", noProviderPendingLocalIds: [] });
      if (reuseId) expect(await owner.get("shared")).toMatchObject({ conversationId: "foreign", producerFinalized: false, usagePending: true });

      vi.setSystemTime(Date.now() + METADATA_TTL_MS + 1);
      const end = vi.fn<NonNullable<CleanupTransport["end"]>>(async () => ({ status: "ended" }));
      const reloaded = new CleanupIntentOutbox(reloadedBudget, {
        cleanup: async () => ({}), closed: async () => ({}), end,
        readConversation: async conversationId => ({ conversationId, version: 1, status: "active", productDeadlineAt: null,
          resumeAttemptId: null, serverTime: Date.now(), policy: { policyVersion: "policy", backgroundSessionCloseEnabled: true } }),
      });
      await reloaded.flush();
      expect(end).toHaveBeenCalledExactlyOnceWith("original", 1, "setup_cancel");
    } finally { await owner.close(); await otherTab.close(); await reloadedBudget.close(); vi.useRealTimers(); }
  });
  it.each(["cleanup", "closed"])("does not apply a delayed %s ACK to a reused local ID", async route => {
    const indexedDB = new IDBFactory(), name = crypto.randomUUID();
    const owner = new MetadataDeliveryBudget({ indexedDB, name, producerId: "owner" });
    const otherTab = new MetadataDeliveryBudget({ indexedDB, name, producerId: "other" });
    await owner.reserve("shared", "original"); await owner.markDispatchStarted("shared");
    if (route === "cleanup") await owner.enqueueCleanup("shared", "user_end");
    else await owner.enqueueClose("shared", {});
    await owner.enqueueEnd("original", 1, "user_end", ["shared"]);
    let proofRequested!: () => void, releaseProof!: () => void;
    const requested = new Promise<void>(resolve => { proofRequested = resolve; });
    const gate = new Promise<void>(resolve => { releaseProof = resolve; });
    const delayedProof = async () => { proofRequested(); await gate; return { state: "closed", closeConfirmed: true, cleanupRequestedAt: Date.now() }; };
    const outbox = new CleanupIntentOutbox(owner, {
      cleanup: delayedProof, closed: delayedProof, readConversation: async () => ({}), end: async () => { throw new Error("offline"); },
    });
    const flushing = outbox.flush();
    await requested;
    if (route === "cleanup") await otherTab.acknowledgeDirectCleanupAndRelease("shared");
    else await otherTab.acknowledgeCloseAndRelease("shared");
    await otherTab.reserve("shared", "foreign", true); await otherTab.markDispatchStarted("shared");
    releaseProof();
    await flushing;
    expect((await owner.ends())[0]).toMatchObject({ conversationId: "original", cleanupLocalIds: [] });
    expect(await owner.get("shared")).toMatchObject({ conversationId: "foreign", producerFinalized: false,
      usagePending: true, cleanup: null, closeObservation: null });
    expect((await owner.get("shared"))?.cleanupAcknowledged).toBeUndefined();
    await owner.close(); await otherTab.close();
  });
  it("retains definitive proof after direct cleanup removed the original envelope", async () => {
    const b = budget(); await b.reserve("attempt", "c"); await b.markDispatchStarted("attempt");
    await b.enqueueCleanup("attempt", "cancelled"); await b.acknowledgeDirectCleanupAndRelease("attempt");
    expect(await b.get("attempt")).toBeNull();
    await b.finishProducerAndRelease("attempt", "no_provider", "c");
    await b.enqueueEnd("c", 1, "setup_cancel", [], 0, "policy", ["attempt"]);
    expect((await b.ends())[0]?.noProviderPendingLocalIds).toEqual([]);
    await b.close();
  });
  it("bounds unconsumed no-provider proofs and reclaims them after TTL", async () => {
    vi.useFakeTimers({ toFake: ["Date"] });
    try {
      const b = budget(1);
      await b.reserve("first", "c"); await b.markDispatchStarted("first");
      await b.finishProducerAndRelease("first", "no_provider");
      await b.reserve("second", "c"); await b.markDispatchStarted("second");
      await expect(b.finishProducerAndRelease("second", "no_provider")).rejects.toThrow("proof storage is full");
      expect(await b.get("second")).not.toBeNull();
      vi.setSystemTime(Date.now() + METADATA_TTL_MS + 1);
      await b.finishProducerAndRelease("second", "no_provider");
      expect(await b.entries()).toEqual([]);
      await b.close();
    } finally { vi.useRealTimers(); }
  });
  it("reclaims a late no-provider proof when End is acknowledged", async () => {
    const b = budget(1);
    await b.reserve("first", "c"); await b.markDispatchStarted("first");
    await b.enqueueEnd("c", 1, "setup_cancel", ["first"], 0, "policy");
    await b.finishProducerAndRelease("first", "no_provider");
    await b.acknowledgeEnd("c", 1);
    await b.reserve("second", "next"); await b.markDispatchStarted("second");
    await b.finishProducerAndRelease("second", "no_provider");
    expect(await b.entries()).toEqual([]);
    await b.close();
  });
});
describe("cleanup and End delivery", () => {
  it("keeps a preexisting close observation as a dependency on the first End", async () => {
    const f = fixture(), attempt = f.scope.newAttempt();
    await attempt.create("offer");
    f.api.closed.mockRejectedValue(new Error("offline"));
    await attempt.finish({ finalized: true, usageSeconds: 7 });

    await f.scope.stageEnd("user_end");
    await f.scope.outbox.flush();

    expect((await f.budget.ends())[0]?.cleanupLocalIds).toEqual([attempt.localId]);
    expect(f.api.end).not.toHaveBeenCalled();
    await f.budget.close();
  });

  it("preserves an ordinary abandoned v1 cleanup without guessing producer liveness", async () => {
    const indexedDB = new IDBFactory(), name = crypto.randomUUID(), now = Date.now();
    await seedV1(indexedDB, name, {
      localId: "legacy", conversationId: "c", producerId: "old-producer", reservedAt: now - 1000, dispatchStartedAt: now - 900,
      producerFinalized: true, producerOutcome: "lost", cleanup: { reason: "hidden", createdAt: now - 100, expiresAt: now + 7 * 86400000 - 100 },
      closeObservation: null, usagePending: false, usage: null,
    }, { conversationId: "c", expectedVersion: 1, reason: "user_end", expiresAt: now + 7 * 86400000, cleanupLocalIds: [] });
    const store = new MetadataDeliveryBudget({ indexedDB, name });
    try {
      expect(await store.get("legacy")).toMatchObject({ producerFinalized: true, producerOutcome: "lost" });
      expect((await store.get("legacy"))?.producerCloseDeadlineAt).toBeUndefined();
    } finally { await store.close(); }
  });
  it("does not reinterpret a completed v1 cleanup just because End depends on it", async () => {
    const indexedDB = new IDBFactory(), name = crypto.randomUUID(), now = Date.now();
    await seedV1(indexedDB, name, {
      localId: "legacy-complete", conversationId: "c", producerId: "old-producer", reservedAt: now - 1000, dispatchStartedAt: now - 900,
      producerFinalized: true, producerOutcome: "lost", cleanup: { reason: "hidden", createdAt: now - 100, expiresAt: now + 7 * 86400000 - 100 },
      closeObservation: null, usagePending: false, usage: null,
    }, { conversationId: "c", expectedVersion: 1, reason: "user_end", expiresAt: now + 7 * 86400000, cleanupLocalIds: ["legacy-complete"] });

    const store = new MetadataDeliveryBudget({ indexedDB, name });
    try {
      expect(await store.get("legacy-complete")).toMatchObject({ producerFinalized: true, producerOutcome: "lost" });
    } finally { await store.close(); }
  });

  it("replays a legacy staged cleanup through the server fence without semantic migration", async () => {
    const indexedDB = new IDBFactory(), name = crypto.randomUUID(), now = Date.now();
    const locks = Object.getOwnPropertyDescriptor(navigator, "locks");
    await seedV1(indexedDB, name, {
      localId: "legacy", conversationId: "c", producerId: "old-producer", reservedAt: now - 1000, dispatchStartedAt: now - 900,
      producerFinalized: true, producerOutcome: "lost", cleanup: { reason: "user_end", createdAt: now - 100, expiresAt: now + 7 * 86400000 - 100 },
      closeObservation: null, usagePending: false, usage: null,
    }, { conversationId: "c", expectedVersion: 1, reason: "user_end", expiresAt: now + 7 * 86400000, cleanupLocalIds: ["legacy"] });
    Reflect.deleteProperty(navigator, "locks");
    const f = fixture(new MetadataDeliveryBudget({ indexedDB, name }));
    f.api.recover.mockResolvedValue({ cleanupRequestedAt: Date.now(), state: "closing", openaiSessionId: "provider" });
    f.api.readAttempt.mockResolvedValue({ liveSessionId: "legacy", state: "closing", handoffAcknowledgedAt: null,
      cleanupRequestedAt: Date.now(), openaiSessionId: "provider", conversation: f.c });
    try {
      await f.scope.outbox.flush();
      expect(f.api.recover).toHaveBeenCalledWith("legacy", "c", "user_end");
      expect(await f.budget.get("legacy")).toMatchObject({ cleanup: null, producerFinalized: false, producerOutcome: null });
      expect(f.api.end).toHaveBeenCalledWith("c", 1, "user_end");
    } finally {
      if (locks) Object.defineProperty(navigator, "locks", locks); else Reflect.deleteProperty(navigator, "locks");
      await f.budget.close();
    }
  });
  it("waits for the graceful-close deadline before no-lock cleanup recovery", async () => {
    const indexedDB = new IDBFactory(), name = crypto.randomUUID();
    const owner = fixture(new MetadataDeliveryBudget({ indexedDB, name }));
    const follower = fixture(new MetadataDeliveryBudget({ indexedDB, name }));
    const attempt = owner.scope.newAttempt();
    const locks = Object.getOwnPropertyDescriptor(navigator, "locks");
    await attempt.create("offer"); await owner.scope.stageEnd("user_end");
    const deadline = (await owner.budget.get(attempt.localId))!.producerCloseDeadlineAt!;
    const clock = vi.spyOn(Date, "now").mockReturnValue(deadline - 1);
    Reflect.deleteProperty(navigator, "locks");
    try {
      follower.api.recover.mockResolvedValue({ cleanupRequestedAt: Date.now(), state: "closing", openaiSessionId: "provider" });
      follower.api.readAttempt.mockResolvedValue({ liveSessionId: attempt.localId, state: "closing", handoffAcknowledgedAt: Date.now(),
        cleanupRequestedAt: Date.now(), openaiSessionId: "provider", conversation: follower.c });
      await follower.scope.outbox.flush();

      expect(follower.api.recover).not.toHaveBeenCalled();
      expect(follower.api.end).not.toHaveBeenCalled();
      expect(await follower.budget.get(attempt.localId)).toMatchObject({ cleanup: { reason: "user_end" } });

      clock.mockReturnValue(deadline);
      await follower.scope.outbox.flush();
      expect(follower.api.recover).toHaveBeenCalledWith(attempt.localId, owner.c.conversationId, "user_end");
      expect(follower.api.end).toHaveBeenCalledWith(owner.c.conversationId, owner.c.version, "user_end");
      expect(await follower.budget.get(attempt.localId)).toMatchObject({ cleanup: null, producerFinalized: false, producerOutcome: null });

      follower.api.readAttempt.mockResolvedValue({ liveSessionId: attempt.localId, state: "closed", closeConfirmed: true,
        handoffAcknowledgedAt: Date.now(), cleanupRequestedAt: Date.now(), openaiSessionId: "provider", conversation: follower.c });
      await follower.scope.outbox.flush();
      expect(await follower.budget.get(attempt.localId)).toBeNull();
    } finally {
      clock.mockRestore();
      if (locks) Object.defineProperty(navigator, "locks", locks); else Reflect.deleteProperty(navigator, "locks");
      await owner.budget.close(); await follower.budget.close();
    }
  });
  it("recovers a dispatched orphan without Web Locks after the server fences it", async () => {
    const indexedDB = new IDBFactory(), name = crypto.randomUUID();
    const producer = fixture(new MetadataDeliveryBudget({ indexedDB, name }));
    const recovery = fixture(new MetadataDeliveryBudget({ indexedDB, name }));
    const attempt = producer.scope.newAttempt();
    const locks = Object.getOwnPropertyDescriptor(navigator, "locks");
    await attempt.create("offer");
    await producer.budget.close();
    Reflect.deleteProperty(navigator, "locks");
    try {
      recovery.api.readAttempt.mockResolvedValue({ liveSessionId: attempt.localId, state: "active", handoffAcknowledgedAt: Date.now(), cleanupRequestedAt: null, conversation: recovery.c });
      await recovery.scope.outbox.flush();
      expect(await recovery.budget.get(attempt.localId)).not.toBeNull();
      expect(recovery.api.cleanup).not.toHaveBeenCalled();

      recovery.api.readAttempt.mockResolvedValue({ liveSessionId: attempt.localId, state: "closing", handoffAcknowledgedAt: Date.now(), cleanupRequestedAt: Date.now(), conversation: recovery.c });
      await recovery.scope.outbox.flush();
      expect(await recovery.budget.get(attempt.localId)).not.toBeNull();
      recovery.api.readAttempt.mockResolvedValue({ liveSessionId: attempt.localId, state: "closed", closeConfirmed: true,
        handoffAcknowledgedAt: Date.now(), cleanupRequestedAt: Date.now(), openaiSessionId: "provider", conversation: recovery.c });
      await recovery.scope.outbox.flush();
      expect(await recovery.budget.get(attempt.localId)).toBeNull();

      await producer.budget.reserve("request-never-arrived", producer.c.conversationId);
      await producer.budget.markDispatchStarted("request-never-arrived");
      await updateEnvelope(indexedDB, name, "request-never-arrived", { dispatchStartedAt: Date.now() - ATTEMPT_REGISTRATION_GRACE_MS });
      recovery.api.readAttempt.mockRejectedValue(Object.assign(new Error("not found"), { status: 404 }));
      recovery.api.recover.mockResolvedValue({ state: "failed", openaiSessionId: null });
      await recovery.scope.outbox.flush();
      expect(recovery.api.recover).toHaveBeenCalledWith("request-never-arrived", producer.c.conversationId, "response_not_received");
      expect(await recovery.budget.get("request-never-arrived")).toBeNull();
    } finally {
      if (locks) Object.defineProperty(navigator, "locks", locks); else Reflect.deleteProperty(navigator, "locks");
      await recovery.budget.close();
    }
  });

  it("does not fence a foreign create on a pre-registration 404 before the no-lock grace expires", async () => {
    const indexedDB = new IDBFactory(), name = crypto.randomUUID();
    const ownerBudget = new MetadataDeliveryBudget({ indexedDB, name });
    const followerBudget = new MetadataDeliveryBudget({ indexedDB, name });
    const follower = fixture(followerBudget);
    const locks = Object.getOwnPropertyDescriptor(navigator, "locks");
    await ownerBudget.reserve("in-flight-create", follower.c.conversationId);
    await ownerBudget.markDispatchStarted("in-flight-create");
    const startedAt = (await ownerBudget.get("in-flight-create"))!.dispatchStartedAt!;
    const clock = vi.spyOn(Date, "now").mockReturnValue(startedAt + ATTEMPT_REGISTRATION_GRACE_MS - 1);
    Reflect.deleteProperty(navigator, "locks");
    try {
      follower.api.readAttempt.mockRejectedValue(Object.assign(new Error("not found"), { status: 404 }));
      follower.api.recover.mockResolvedValue({ state: "failed", openaiSessionId: null });

      await follower.scope.outbox.flush();
      expect(follower.api.recover).not.toHaveBeenCalled();
      expect(await follower.budget.get("in-flight-create")).not.toBeNull();

      clock.mockReturnValue(startedAt + ATTEMPT_REGISTRATION_GRACE_MS);
      await follower.scope.outbox.flush();
      expect(follower.api.recover).toHaveBeenCalledWith("in-flight-create", follower.c.conversationId, "response_not_received");
      expect(await follower.budget.get("in-flight-create")).toBeNull();
    } finally {
      clock.mockRestore();
      if (locks) Object.defineProperty(navigator, "locks", locks); else Reflect.deleteProperty(navigator, "locks");
      await ownerBudget.close(); await followerBudget.close();
    }
  });

  it("keeps a foreign usage producer after cleanup fencing until terminal retirement proof", async () => {
    const indexedDB = new IDBFactory(), name = crypto.randomUUID();
    const owner = fixture(new MetadataDeliveryBudget({ indexedDB, name }));
    const recovery = fixture(new MetadataDeliveryBudget({ indexedDB, name }));
    const locks = Object.getOwnPropertyDescriptor(navigator, "locks");
    await owner.budget.reserve("foreign-usage", owner.c.conversationId, true);
    await owner.budget.markDispatchStarted("foreign-usage");
    await owner.budget.enqueueCleanup("foreign-usage", "hidden");
    await owner.budget.finishProducer("foreign-usage", "lost");
    Reflect.deleteProperty(navigator, "locks");
    try {
      recovery.api.recover.mockResolvedValue({ cleanupRequestedAt: Date.now(), state: "closing", openaiSessionId: "provider" });
      recovery.api.readAttempt.mockResolvedValue({ liveSessionId: "foreign-usage", state: "closing", handoffAcknowledgedAt: Date.now(),
        cleanupRequestedAt: Date.now(), openaiSessionId: "provider", conversation: recovery.c });

      await recovery.scope.outbox.flush();
      await recovery.scope.outbox.flush();

      expect(recovery.api.recover).toHaveBeenCalledWith("foreign-usage", owner.c.conversationId, "hidden");
      expect(await recovery.budget.get("foreign-usage")).toMatchObject({
        cleanup: null, producerFinalized: false, producerOutcome: null, usageProducerFinalized: false,
      });

      recovery.api.readAttempt.mockResolvedValue({ liveSessionId: "foreign-usage", state: "closed", closeConfirmed: true,
        handoffAcknowledgedAt: Date.now(), cleanupRequestedAt: Date.now(), openaiSessionId: "provider", conversation: recovery.c });
      await recovery.scope.outbox.flush();
      expect(await recovery.budget.get("foreign-usage")).toBeNull();
    } finally {
      if (locks) Object.defineProperty(navigator, "locks", locks); else Reflect.deleteProperty(navigator, "locks");
      await owner.budget.close(); await recovery.budget.close();
    }
  });

  it("fences legacy staged cleanup instead of trusting a synthesized close deadline", async () => {
    const indexedDB = new IDBFactory(), name = crypto.randomUUID();
    const owner = fixture(new MetadataDeliveryBudget({ indexedDB, name }));
    const follower = fixture(new MetadataDeliveryBudget({ indexedDB, name }));
    const attempt = owner.scope.newAttempt();
    const locks = Object.getOwnPropertyDescriptor(navigator, "locks");
    await attempt.create("offer"); await owner.scope.stageEnd("user_end");
    const row = await owner.budget.get(attempt.localId);
    await updateEnvelope(indexedDB, name, attempt.localId, {
      producerCloseDeadlineAt: undefined, producerFinalized: true, producerOutcome: "lost",
      cleanup: { ...row!.cleanup!, createdAt: Date.now(), expiresAt: Date.now() + 7 * 86400000 + 120000 },
    });
    Reflect.deleteProperty(navigator, "locks");

    try {
      follower.api.recover.mockResolvedValue({ cleanupRequestedAt: Date.now(), state: "closing", openaiSessionId: "provider" });
      await follower.scope.outbox.flush();
      expect(follower.api.recover).toHaveBeenCalledWith(attempt.localId, owner.c.conversationId, "user_end");
      expect(follower.api.cleanup).not.toHaveBeenCalled();
      expect(await follower.budget.get(attempt.localId)).toMatchObject({ cleanup: null, producerFinalized: false, producerOutcome: null });
    } finally {
      if (locks) Object.defineProperty(navigator, "locks", locks); else Reflect.deleteProperty(navigator, "locks");
      await owner.budget.close(); await follower.budget.close();
    }
  });
  it("drops a legacy cleanup envelope at its seven-day expiry", async () => {
    const indexedDB = new IDBFactory(), name = crypto.randomUUID();
    const f = fixture(new MetadataDeliveryBudget({ indexedDB, name }));
    const locks = Object.getOwnPropertyDescriptor(navigator, "locks");
    await f.budget.reserve("old", "c"); await f.budget.markDispatchStarted("old"); await f.budget.enqueueCleanup("old", "user_end");
    const old = Date.now() - 8 * 86400000;
    await updateEnvelope(indexedDB, name, "old", {
      producerCloseDeadlineAt: undefined, reservedAt: old, producerFinalized: false, producerOutcome: null,
      cleanup: { reason: "user_end", createdAt: old, expiresAt: old + 7 * 86400000 },
    });

    Reflect.deleteProperty(navigator, "locks");
    try {
      await f.scope.outbox.flush();

      expect(await f.budget.get("old")).toBeNull();
      expect(f.api.cleanup).not.toHaveBeenCalled();
    } finally {
      if (locks) Object.defineProperty(navigator, "locks", locks); else Reflect.deleteProperty(navigator, "locks");
      await f.budget.close();
    }
  });

  it("retains an unfinalized dispatched producer after the metadata retention window", async () => {
    const indexedDB = new IDBFactory(), name = crypto.randomUUID();
    const f = fixture(new MetadataDeliveryBudget({ indexedDB, name }));
    await f.budget.reserve("active", "c"); await f.budget.markDispatchStarted("active");
    await updateEnvelope(indexedDB, name, "active", { reservedAt: Date.now() - 8 * 86400000 });

    await f.scope.outbox.flush();

    expect(await f.budget.get("active")).toMatchObject({ producerFinalized: false, producerOutcome: null });
    await f.budget.close();
  });

  it("does not restage cleanup after its proof on a later End enqueue", async () => {
    const f = fixture();
    await f.budget.reserve("attempt", f.c.conversationId);
    await f.budget.markDispatchStarted("attempt");
    await f.scope.outbox.enqueueEnd(f.c.conversationId, f.c.version, "setup_cancel", ["attempt"]);
    await f.scope.outbox.flush();
    expect((await f.budget.get("attempt"))?.cleanup).toBeNull();

    await f.scope.outbox.enqueueEnd(f.c.conversationId, f.c.version, "setup_cancel", ["attempt"]);

    expect((await f.budget.get("attempt"))?.cleanup).toBeNull();
    expect((await f.budget.ends())[0]?.cleanupLocalIds).toEqual([]);
    expect(f.api.cleanup).toHaveBeenCalledTimes(1);
    await f.budget.close();
  });

  it("preserves the first graceful-close deadline when End is persisted again", async () => {
    let now = 1000;
    vi.spyOn(Date, "now").mockImplementation(() => now);
    const f = fixture();
    try {
      await f.budget.reserve("attempt", f.c.conversationId);
      await f.budget.markDispatchStarted("attempt");
      await f.budget.enqueueEnd(f.c.conversationId, f.c.version, "user_end", ["attempt"], 100);
      const firstDeadline = (await f.budget.get("attempt"))?.producerCloseDeadlineAt;

      now += 101;
      await f.budget.enqueueEnd(f.c.conversationId, f.c.version, "user_end", ["attempt"], 100);

      expect((await f.budget.get("attempt"))?.producerCloseDeadlineAt).toBe(firstDeadline);
    } finally {
      vi.restoreAllMocks();
      await f.budget.close();
    }
  });

  it("keeps a pending close observation as a dependency when the same End is persisted again", async () => {
    const f = fixture();
    await f.budget.reserve("attempt", f.c.conversationId);
    await f.budget.markDispatchStarted("attempt");
    await f.scope.outbox.enqueueEnd(f.c.conversationId, f.c.version, "user_end", ["attempt"]);
    await f.scope.outbox.observeClosed("attempt", { seconds: 7 });
    await f.scope.outbox.enqueueEnd(f.c.conversationId, f.c.version, "user_end", ["attempt"]);
    f.api.closed.mockRejectedValue(new Error("offline"));

    await f.scope.outbox.flush();

    expect((await f.budget.ends())[0]?.cleanupLocalIds).toEqual(["attempt"]);
    expect(f.api.end).not.toHaveBeenCalled();
    await f.budget.close();
  });

  it("delivers a persisted close observation even while its foreign producer lock is held", async () => {
    const indexedDB = new IDBFactory(), name = crypto.randomUUID();
    const ownerBudget = new MetadataDeliveryBudget({ indexedDB, name }), followerBudget = new MetadataDeliveryBudget({ indexedDB, name });
    const owner = fixture(ownerBudget), follower = fixture(followerBudget), held = new Set<string>();
    let ownerHasLock = false;
    Object.defineProperty(navigator, "locks", { configurable: true, value: { request: vi.fn((key: string, _options: { ifAvailable: boolean }, callback: (lock: object | null) => unknown) => {
      if (held.has(key)) return Promise.resolve(callback(null));
      held.add(key); const result = callback({});
      if (key === `live-metadata-producer:${ownerBudget.ownerProducerId}` && !ownerHasLock) { ownerHasLock = true; return new Promise(() => {}); }
      return Promise.resolve(result).finally(() => held.delete(key));
    }) } });
    try {
      const attempt = owner.scope.newAttempt(); await attempt.create("offer"); await owner.scope.stageEnd("user_end");
      await attempt.finish({ finalized: true, usageSeconds: 7 });

      await follower.scope.outbox.flush();

      expect(follower.api.closed).toHaveBeenCalledWith(attempt.localId, { seconds: 7 });
      expect(await follower.budget.get(attempt.localId)).toBeNull();
    } finally {
      Reflect.deleteProperty(navigator, "locks");
      await ownerBudget.close(); await followerBudget.close();
    }
  });

  it("routes dead-producer cleanup through recovery when the server attempt is missing", async () => {
    const indexedDB = new IDBFactory(), name = crypto.randomUUID();
    const ownerBudget = new MetadataDeliveryBudget({ indexedDB, name }), followerBudget = new MetadataDeliveryBudget({ indexedDB, name });
    const follower = fixture(followerBudget);
    const locks = Object.getOwnPropertyDescriptor(navigator, "locks");
    Object.defineProperty(navigator, "locks", { configurable: true, value: {
      request: vi.fn((_key: string, _options: { ifAvailable: boolean }, callback: (lock: object | null) => unknown) => Promise.resolve(callback({}))),
    } });
    try {
      await ownerBudget.reserve("missing", follower.c.conversationId);
      await ownerBudget.markDispatchStarted("missing");
      await ownerBudget.enqueueCleanup("missing", "user_end");
      await ownerBudget.finishProducer("missing", "lost");
      await ownerBudget.enqueueEnd(follower.c.conversationId, follower.c.version, "user_end", ["missing"]);

      follower.api.cleanup.mockRejectedValue(Object.assign(new Error("not found"), { status: 404 }));
      follower.api.recover.mockResolvedValue({ state: "failed", openaiSessionId: null });

      await follower.scope.outbox.flush();

      expect(follower.api.recover).toHaveBeenCalledWith("missing", follower.c.conversationId, "user_end");
      expect(await follower.budget.get("missing")).toBeNull();
      expect(follower.api.end).toHaveBeenCalledWith(follower.c.conversationId, follower.c.version, "user_end");
    } finally {
      if (locks) Object.defineProperty(navigator, "locks", locks); else Reflect.deleteProperty(navigator, "locks");
      await ownerBudget.close(); await followerBudget.close();
    }
  });

  it("waits for a live producer lock before replaying staged cleanup", async () => {
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

      await attempt.finish({ finalized: true, usageSeconds: 7 }); await owner.scope.outbox.flush();
      expect(owner.api.closed).toHaveBeenCalledWith(attempt.localId, { seconds: 7 });
      expect(owner.api.cleanup).not.toHaveBeenCalled();
      expect(follower.api.cleanup).not.toHaveBeenCalled();

      await ownerBudget.reserve("orphan", "conversation"); await ownerBudget.markDispatchStarted("orphan");
      await ownerBudget.enqueueCleanup("orphan", "cancelled"); await ownerBudget.finishProducer("orphan", "lost");
      held.delete(ownerLock);
      await follower.scope.outbox.flush();
      expect(follower.api.recover).toHaveBeenLastCalledWith("orphan", "conversation", "cancelled");
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
  it("retains a cleanup-only envelope until producer finalization is recovered", async () => {
    const f = fixture(); await f.budget.reserve("id", "c"); await f.budget.markDispatchStarted("id");
    await f.budget.enqueueCleanup("id", "hidden");
    f.api.cleanup.mockResolvedValue({ cleanupRequestedAt: 123 });

    await f.scope.outbox.flush();

    expect(await f.budget.get("id")).toMatchObject({ cleanup: null, producerFinalized: false }); await f.budget.close();
  });
  it("releases a reconciled suspended producer after the metadata retention window", async () => {
    const indexedDB = new IDBFactory(), name = crypto.randomUUID();
    const f = fixture(new MetadataDeliveryBudget({ indexedDB, name }));
    await f.budget.reserve("id", f.c.conversationId); await f.budget.markDispatchStarted("id");
    await f.budget.enqueueEnd(f.c.conversationId, f.c.version, "user_end", ["id"]);
    await f.scope.outbox.flush();
    expect(await f.budget.get("id")).toMatchObject({ cleanup: null, cleanupAcknowledged: true, producerFinalized: false });

    const db = await new Promise<IDBDatabase>((resolve, reject) => {
      const request = indexedDB.open(name); request.onsuccess = () => resolve(request.result); request.onerror = () => reject(request.error);
    });
    await new Promise<void>((resolve, reject) => {
      const tx = db.transaction("envelopes", "readwrite"), store = tx.objectStore("envelopes"), get = store.get("id");
      get.onsuccess = () => store.put({ ...get.result, reservedAt: Date.now() - 8 * 86400000 });
      tx.oncomplete = () => resolve(); tx.onerror = () => reject(tx.error);
    });
    db.close();
    await f.scope.outbox.flush();
    expect(await f.budget.get("id")).toBeNull(); await f.budget.close();
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

    await f.scope.acknowledgeDirectCleanup("attempt", "c");

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
  it("keeps stale End as an admission barrier without taking over a newer conversation version", async () => {
    const f = fixture(); f.api.end.mockRejectedValue({ status: 409 }); f.api.readConversation.mockResolvedValue({ ...f.c, version: 3 });
    await f.scope.outbox.enqueueEnd("c", 2, "user_end"); await f.scope.outbox.flush(); expect(await f.budget.ends()).toHaveLength(1);
    expect(f.api.end).toHaveBeenCalledTimes(1); await f.budget.close();
  });
  it.each(["cleanup", "closed"])("does not apply a late direct %s ACK to a reused attempt ID", async kind => {
    const f = fixture(), attempt = f.scope.newAttempt(); await attempt.create("offer");
    const localId = attempt.localId;
    if (kind === "cleanup") vi.spyOn(f.scope.outbox, "enqueue").mockRejectedValue(new Error("storage unavailable"));
    else vi.spyOn(f.scope.outbox, "observeClosed").mockRejectedValue(new Error("storage unavailable"));
    let releaseProof!: () => void;
    const proofGate = new Promise<void>(resolve => { releaseProof = resolve; });
    let proofStarted!: () => void;
    const started = new Promise<void>(resolve => { proofStarted = resolve; });
    if (kind === "cleanup") f.api.cleanup.mockImplementation(async () => { proofStarted(); await proofGate; return { cleanupRequestedAt: Date.now() }; });
    else f.api.closed.mockImplementation(async () => { proofStarted(); await proofGate; return { state: "closed", closeConfirmed: true }; });
    const retiring = kind === "cleanup" ? attempt.abandon("user_end") : attempt.finish({ finalized: true, usageSeconds: 7 });
    await started;
    await f.budget.finishUsageProducer(localId, "conversation");
    await f.budget.finishProducerAndRelease(localId, "provider_closed", "conversation");
    expect(await f.budget.get(localId)).toBeNull();
    await f.budget.reserve(localId, "foreign"); await f.budget.markDispatchStarted(localId);
    await f.budget.enqueueEnd("foreign", 1, "setup_cancel", [localId], 0, "policy");
    releaseProof(); await retiring;
    expect(await f.budget.get(localId)).toMatchObject({ conversationId: "foreign", producerFinalized: false });
    expect((await f.budget.ends())[0]?.cleanupLocalIds).toEqual([localId]);
    await f.budget.close();
  });
  it.each(["cleanup", "closed"])("does not retry an old direct %s ACK against a reused attempt ID", async kind => {
    const f = fixture(), attempt = f.scope.newAttempt(); await attempt.create("offer");
    const localId = attempt.localId;
    if (kind === "cleanup") {
      vi.spyOn(f.scope.outbox, "enqueue").mockRejectedValue(new Error("storage unavailable"));
      vi.spyOn(f.budget, "acknowledgeDirectCleanupAndRelease").mockRejectedValueOnce(new Error("ACK write failed"));
      await attempt.abandon("user_end");
    } else {
      vi.spyOn(f.scope.outbox, "observeClosed").mockRejectedValue(new Error("storage unavailable"));
      vi.spyOn(f.budget, "finishProducerAndRelease").mockRejectedValueOnce(new Error("ACK write failed"));
      await attempt.finish({ finalized: true, usageSeconds: 7 });
    }
    await f.budget.finishProducerAndRelease(localId, "provider_closed", "conversation");
    await f.budget.reserve(localId, "foreign"); await f.budget.markDispatchStarted(localId);
    await f.scope.prepare(f.scope.newAttempt());
    expect(await f.budget.get(localId)).toMatchObject({ conversationId: "foreign", producerFinalized: false });
    await f.budget.close();
  });
  it.each(["cleanup", "closed"])("does not enqueue stale %s metadata onto a reused attempt ID", async kind => {
    const f = fixture(), localId = "shared";
    await f.budget.reserve(localId, "original"); await f.budget.markDispatchStarted(localId);
    let release!: () => void, entered!: () => void;
    const gate = new Promise<void>(resolve => { release = resolve; });
    const started = new Promise<void>(resolve => { entered = resolve; });
    if (kind === "cleanup") {
      const original = f.budget.enqueueCleanup.bind(f.budget);
      vi.spyOn(f.budget, "enqueueCleanup").mockImplementation(async (...args) => { entered(); await gate; return original(...args); });
    } else {
      const original = f.budget.enqueueClose.bind(f.budget);
      vi.spyOn(f.budget, "enqueueClose").mockImplementation(async (...args) => { entered(); await gate; return original(...args); });
    }
    const operation = kind === "cleanup" ? f.scope.outbox.enqueue(localId, "user_end", "original") :
      f.scope.outbox.observeClosed(localId, { seconds: 7 }, "original");
    await started;
    await f.budget.finishProducerAndRelease(localId, "provider_closed", "original");
    await f.budget.reserve(localId, "foreign"); await f.budget.markDispatchStarted(localId);
    release();
    if (kind === "cleanup") await expect(operation).rejects.toThrow("Metadata identity conflict");
    else await operation;
    expect(await f.budget.get(localId)).toMatchObject({ conversationId: "foreign", producerFinalized: false, cleanup: null, closeObservation: null });
    await f.budget.close();
  });
  it("does not let an old direct proof suppress a new conversation's End dependency", async () => {
    const f = fixture(), first = f.scope.newAttempt(); await first.create("first");
    const degraded = vi.spyOn(f.scope.outbox, "enqueue").mockRejectedValue(new Error("storage unavailable"));
    await first.abandon("user_end"); degraded.mockRestore();
    await f.scope.end("user_end"); await f.scope.outbox.flush();
    const foreign = { ...f.c, conversationId: "foreign" };
    f.api.createConversation.mockResolvedValueOnce(foreign);
    const uuid = vi.spyOn(crypto, "randomUUID").mockReturnValueOnce(first.localId as `${string}-${string}-${string}-${string}-${string}`);
    const next = f.scope.newAttempt(); uuid.mockRestore();
    expect(next.localId).toBe(first.localId);
    await next.create("second");
    let release!: () => void, entered!: () => void;
    const gate = new Promise<void>(resolve => { release = resolve; });
    const started = new Promise<void>(resolve => { entered = resolve; });
    vi.spyOn(f.scope.outbox, "enqueue").mockImplementation(async () => { entered(); await gate; });
    const ending = f.scope.end("setup_cancel"); await started;
    expect((await f.budget.ends()).find(end => end.conversationId === "foreign")?.cleanupLocalIds).toEqual([first.localId]);
    release(); await ending; await f.budget.close();
  });
  it("does not defer a reused attempt's cleanup because an older conversation staged End", async () => {
    const f = fixture(), localId = "shared";
    await f.budget.reserve(localId, "original"); await f.budget.markDispatchStarted(localId);
    f.scope.outbox.deferCleanup("original", [localId]);
    await f.budget.finishProducerAndRelease(localId, "provider_closed", "original");
    await f.budget.reserve(localId, "foreign"); await f.budget.markDispatchStarted(localId);
    await f.budget.enqueueCleanup(localId, "user_end", "foreign");
    await f.budget.finishProducer(localId, "lost", "foreign");
    await f.scope.outbox.flush();
    expect(f.api.cleanup).toHaveBeenCalledWith(localId, "user_end");
    expect(await f.budget.get(localId)).toBeNull();
    await f.budget.close();
  });
  it("clears a stale End only after read-back confirms that conversation ended", async () => {
    const f = fixture(); f.api.end.mockRejectedValue(new AccountingRequestError(409, "conversation_version_conflict"));
    f.api.readConversation.mockResolvedValue({ ...f.c, status: "ended", version: 3 });
    await f.scope.outbox.enqueueEnd(f.c.conversationId, 1, "user_end");
    await f.scope.outbox.flush();
    expect(await f.budget.ends()).toHaveLength(0);
    await f.budget.close();
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
  it("does not discard a reused conversation's usage after definitive pre-registration rejection", async () => {
    const f = fixture();
    const api = { ...f.api, usage: vi.fn<NonNullable<LedgerApi["usage"]>>(async () => ({ schemaVersion: 1, appAccepted: true, activityReportSeq: null, appMetricsFinalized: false })) };
    const scope = new ConversationAccounting({ api, budget: f.budget, autoDelivery: false });
    const attempt = scope.newAttempt();
    let rejectCreate!: (error: Error) => void;
    api.createSession.mockImplementationOnce(() => new Promise((_resolve, reject) => { rejectCreate = reject; }));
    const creating = attempt.create("offer").catch(error => error);
    await vi.waitFor(() => expect(rejectCreate).toBeDefined());
    attempt.observeUsage({ kind: "checkpoint", seconds: 15 });
    await vi.waitFor(async () => expect((await f.budget.get(attempt.localId))?.usage?.report.checkpointSeconds).toBe(15));
    let entered!: () => void, release!: () => void;
    const started = new Promise<void>(resolve => { entered = resolve; });
    const gate = new Promise<void>(resolve => { release = resolve; });
    vi.spyOn(f.budget, "discardUsage").mockImplementationOnce(async (...args) => { entered(); await gate; return MetadataDeliveryBudget.prototype.discardUsage.call(f.budget, ...args); });
    rejectCreate(new AccountingRequestError(503, "provider_key_missing")); await started;
    await MetadataDeliveryBudget.prototype.discardUsage.call(f.budget, attempt.localId, f.c.conversationId);
    await f.budget.finishProducerAndRelease(attempt.localId, "no_provider", f.c.conversationId);
    await f.budget.reserve(attempt.localId, "foreign", true);
    await f.budget.enqueueUsage(attempt.localId, "foreign", { schemaVersion: 1, checkpointSeconds: 33 });
    release(); await creating;
    expect((await f.budget.get(attempt.localId))?.usage?.report.checkpointSeconds).toBe(33);
    expect(api.cleanup).not.toHaveBeenCalled();
    await f.budget.close();
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

  it("delivers a cleanup marker if producer finalization and direct cleanup both fail", async () => {
    const f = fixture(); const attempt = f.scope.newAttempt(); await attempt.create("offer");
    await f.scope.stageEnd("user_end");
    vi.spyOn(f.budget, "finishProducer").mockRejectedValueOnce(new Error("IDB finalize failed"));
    f.api.cleanup.mockRejectedValueOnce(new Error("offline"));

    await expect(attempt.abandon("user_end")).rejects.toThrow("offline");
    expect((await f.budget.get(attempt.localId))?.cleanup?.reason).toBe("user_end");
    await f.scope.outbox.flush();

    expect(f.api.cleanup).toHaveBeenCalledTimes(2);
    expect(attempt.finished).toBe(false);
    expect(await f.budget.get(attempt.localId)).not.toBeNull();
    await f.budget.close();
  });

  it("ends without cleanup when no-provider finalization storage fails", async () => {
    const f = fixture(), attempt = f.scope.newAttempt();
    let rejectCreate!: (error: Error) => void;
    f.api.createSession.mockImplementationOnce(() => new Promise((_resolve, reject) => { rejectCreate = reject; }));
    const creating = attempt.create("offer").catch(error => error);
    await vi.waitFor(() => expect(rejectCreate).toBeDefined());
    await f.scope.stageEnd("setup_cancel");
    f.api.cleanup.mockRejectedValue({ status: 404 });
    const finalize = vi.spyOn(f.budget, "finishProducerAndRelease").mockRejectedValueOnce(new Error("finalization storage failed"));

    rejectCreate(new AccountingRequestError(404, "attempt_not_found"));
    await expect(creating).resolves.toMatchObject({ message: "finalization storage failed" });
    await f.scope.end("setup_cancel", f.scope.revision);
    await f.scope.outbox.flush();

    expect(finalize).toHaveBeenCalled();
    expect(f.api.cleanup).not.toHaveBeenCalled();
    expect(f.api.end).toHaveBeenCalledWith(f.c.conversationId, f.c.version, "setup_cancel");
    expect(await f.budget.ends()).toHaveLength(0);
    expect(await f.budget.get(attempt.localId)).toBeNull();
    await f.budget.close();
  });
  it("recovers a persisted no-provider outcome without replaying cleanup or usage", async () => {
    const indexedDB = new IDBFactory(), name = crypto.randomUUID();
    const locks = Object.getOwnPropertyDescriptor(navigator, "locks");
    const originalBudget = new MetadataDeliveryBudget({ indexedDB, name });
    const f = fixture(originalBudget), attempt = f.scope.newAttempt();
    let rejectCreate!: (error: Error) => void;
    f.api.createSession.mockImplementationOnce(() => new Promise((_resolve, reject) => { rejectCreate = reject; }));
    const creating = attempt.create("offer").catch(error => error);
    await vi.waitFor(() => expect(rejectCreate).toBeDefined());
    await f.scope.stageEnd("setup_cancel");
    await originalBudget.enqueueUsage(attempt.localId, f.c.conversationId, { schemaVersion: 1, checkpointSeconds: 12 });
    vi.spyOn(originalBudget, "finishProducerAndRelease").mockRejectedValueOnce(new Error("finalization storage failed"));
    rejectCreate(new AccountingRequestError(404, "attempt_not_found"));
    await expect(creating).resolves.toMatchObject({ message: "finalization storage failed" });
    await originalBudget.close();

    const usage = vi.fn(async () => ({ schemaVersion: 1 as const, appAccepted: true, activityReportSeq: null, appMetricsFinalized: true }));
    const api = f.api as LedgerApi;
    api.usage = usage;
    const recoveredBudget = new MetadataDeliveryBudget({ indexedDB, name });
    Object.defineProperty(navigator, "locks", { configurable: true, value: { request: vi.fn((_key: string, _options: { ifAvailable: boolean }, callback: (lock: object | null) => unknown) => Promise.resolve(callback({}))) } });
    try {
      const recovered = new ConversationAccounting({ api, budget: recoveredBudget, autoDelivery: false });
      await recovered.outbox.flush();
      await recovered.usageOutbox?.flush();

      expect(f.api.cleanup).not.toHaveBeenCalled();
      expect(usage).not.toHaveBeenCalled();
      expect(f.api.end).toHaveBeenCalledWith(f.c.conversationId, f.c.version, "setup_cancel");
      expect(await recoveredBudget.get(attempt.localId)).toBeNull();
    } finally {
      if (locks) Object.defineProperty(navigator, "locks", locks); else Reflect.deleteProperty(navigator, "locks");
      await recoveredBudget.close();
    }
  });
  it("retries both failed no-provider finalization writes on an outbox wake", async () => {
    const indexedDB = new IDBFactory(), name = crypto.randomUUID();
    const store = new MetadataDeliveryBudget({ indexedDB, name });
    const f = fixture(store), scope = f.scope;
    const attempt = scope.newAttempt();
    let rejectCreate!: (error: Error) => void;
    f.api.createSession.mockImplementationOnce(() => new Promise((_resolve, reject) => { rejectCreate = reject; }));
    const creating = attempt.create("offer").catch(error => error);
    await vi.waitFor(() => expect(rejectCreate).toBeDefined());
    await scope.stageEnd("setup_cancel");
    const release = vi.spyOn(store, "finishProducerAndRelease").mockRejectedValue(new Error("storage unavailable"));
    const finalize = vi.spyOn(store, "finishProducer").mockRejectedValue(new Error("storage unavailable"));

    rejectCreate(new AccountingRequestError(404, "attempt_not_found"));
    await expect(creating).resolves.toMatchObject({ message: "storage unavailable" });
    expect(await store.get(attempt.localId)).toMatchObject({ producerOutcome: null, producerFinalized: false, cleanup: { reason: "cancelled" } });
    expect(finalize).toHaveBeenCalled();

    release.mockImplementation((id, outcome) => MetadataDeliveryBudget.prototype.finishProducerAndRelease.call(store, id, outcome));
    finalize.mockImplementation((id, outcome) => MetadataDeliveryBudget.prototype.finishProducer.call(store, id, outcome));
    scope.outbox.start();
    scope.outbox.wake();
    await scope.outbox.flush();
    await scope.outbox.flush();
    await vi.waitFor(async () => expect(await store.get(attempt.localId)).toBeNull());

    expect(release).toHaveBeenCalled();
    expect(release).toHaveBeenLastCalledWith(attempt.localId, "no_provider", f.c.conversationId);
    expect(f.api.cleanup).not.toHaveBeenCalled();
    await scope.outbox.stop(); await scope.usageOutbox?.stop(); await store.close();
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
    const f = fixture(); let resolve!: (value: { usageLedgerEnabled: boolean; backgroundSessionCloseEnabled: boolean }) => void;
    f.api.policy.mockImplementation(() => new Promise(ok => { resolve = ok; })); const a = f.scope.newAttempt(); const create = a.create("offer").catch((e: unknown) => e);
    await vi.waitFor(() => expect(resolve).toBeDefined()); await a.abandon("cancelled"); resolve({ usageLedgerEnabled: true, backgroundSessionCloseEnabled: false }); await create;
    expect(f.api.createSession).not.toHaveBeenCalled(); await f.budget.close();
  });
  it("rejects background close policy when the ledger is disabled", async () => {
    const f = fixture();
    f.api.policy.mockResolvedValue({ usageLedgerEnabled: false, backgroundSessionCloseEnabled: true });
    await expect(f.scope.prepare(f.scope.newAttempt())).rejects.toThrow("ledger");
    expect(f.api.createConversation).not.toHaveBeenCalled();
    await f.budget.close();
  });
  it("exposes the conversation's retained background policy to its owner", async () => {
    const f = fixture();
    f.c.policy.backgroundSessionCloseEnabled = true;
    f.scope.setSnapshotStore(Promise.resolve({ available: true } as ResumeSnapshotStore));
    await f.scope.prepare(f.scope.newAttempt());
    expect(f.scope.backgroundSessionCloseEnabled).toBe(true);
    await f.budget.close();
  });
  it("recovers a lost handoff ACK from read-back without creating a second provider", async () => {
    const f = fixture(); const a = f.scope.newAttempt(); await a.create("offer"); const receipt = await f.api.handoff(a.localId);
    f.api.handoff.mockRejectedValue(new Error("lost ACK")); f.api.readAttempt.mockResolvedValue(receipt); await a.handoff();
    expect(f.api.createSession).toHaveBeenCalledTimes(1); expect(f.api.readAttempt).toHaveBeenCalledTimes(1);
    await a.abandon("cancelled"); await f.scope.outbox.flush(); await f.budget.close();
  });
});

describe("stage 4 durable lifecycle boundary", () => {
  it.each(["expired", "identity_401", "identity_403", "identity_404"])("keeps an unproven %s End across reload and blocks new provider admission", async outcome => {
    const indexedDB = new IDBFactory(), name = crypto.randomUUID();
    const original = fixture(new MetadataDeliveryBudget({ indexedDB, name }));
    await original.scope.prepare(original.scope.newAttempt());
    await original.scope.stageEnd("user_end");
    if (outcome === "expired") await expireEnd(indexedDB, name, original.c.conversationId);
    else {
      const status = Number(outcome.slice(-3));
      original.api.end.mockRejectedValue(new AccountingRequestError(status, "identity_required"));
      original.api.readConversation.mockRejectedValue(new AccountingRequestError(status, "identity_required"));
    }
    await original.scope.outbox.flush();
    if (outcome === "expired") expect(original.api.end).not.toHaveBeenCalled();
    expect(await original.budget.ends()).toHaveLength(1);
    await original.budget.close();

    const recoveredBudget = new MetadataDeliveryBudget({ indexedDB, name });
    const recovered = new ConversationAccounting({ api: original.api, budget: recoveredBudget, autoDelivery: false });
    await expect(recovered.newAttempt().create("offer")).rejects.toThrow("End is pending");
    expect(original.api.createConversation).toHaveBeenCalledTimes(1);
    expect(original.api.createSession).not.toHaveBeenCalled();
    await recoveredBudget.close();
  });

  it.each([false, true])("does not rotate after a staged End loses to a server pause (preflushed=%s)", async preflushed => {
    const db = new DatabaseSync(":memory:");
    const root = resolve(process.cwd(), "apps/api/src/persistence/migrations");
    const migrations = existsSync(root) ? root : resolve(process.cwd(), "../api/src/persistence/migrations");
    for (const name of ["001-usage-ledger.sql", "002-live-session-recovery-fences.sql", "003-usage-identity.sql"])
      db.exec(readFileSync(resolve(migrations, name), "utf8"));
    const ledger = new UsageLedger(db), owner = crypto.randomUUID(), f = fixture();
    const metadata = (row: ReturnType<typeof ledger.createConversation>): ConversationMetadata => ({
      ...f.c, conversationId: row.id, version: row.version, status: row.status,
    });
    f.api.createConversation.mockImplementation(async requestId => metadata(ledger.createConversation(owner, requestId, "test")));
    f.api.readConversation.mockImplementation(async id => metadata(ledger.getConversation(owner, id)));
    f.api.end.mockImplementation(async (id, version, reason) => {
      try { return metadata(ledger.endConversation(owner, id, version, reason)); }
      catch (error) {
        if (!(error instanceof LedgerError)) throw error;
        throw new AccountingRequestError(error.status, error.code);
      }
    });
    try {
      const first = await f.scope.prepare(f.scope.newAttempt());
      await f.scope.stageEnd("user_end");
      expect(ledger.pauseConversation(owner, first!.conversationId, first!.version).status).toBe("paused");
      if (preflushed) await f.scope.outbox.flush();

      await expect(f.scope.newAttempt().create("offer")).rejects.toThrow("End is pending");
      expect(ledger.getConversation(owner, first!.conversationId).status).toBe("paused");
      expect(f.api.createConversation).toHaveBeenCalledTimes(1);
      expect(f.api.createSession).not.toHaveBeenCalled();
    } finally { await f.budget.close(); db.close(); }
  });

  it.each([false, true])("starts a new ledger conversation after its own staged End is confirmed (preflushed=%s)", async preflushed => {
    const db = new DatabaseSync(":memory:");
    const root = resolve(process.cwd(), "apps/api/src/persistence/migrations");
    const migrations = existsSync(root) ? root : resolve(process.cwd(), "../api/src/persistence/migrations");
    for (const name of ["001-usage-ledger.sql", "002-live-session-recovery-fences.sql", "003-usage-identity.sql"])
      db.exec(readFileSync(resolve(migrations, name), "utf8"));
    const ledger = new UsageLedger(db), owner = crypto.randomUUID(), f = fixture();
    const metadata = (row: ReturnType<typeof ledger.createConversation>): ConversationMetadata => ({
      ...f.c, conversationId: row.id, version: row.version, status: row.status,
    });
    f.api.createConversation.mockImplementation(async requestId => metadata(ledger.createConversation(owner, requestId, "test")));
    f.api.readConversation.mockImplementation(async id => metadata(ledger.getConversation(owner, id)));
    f.api.end.mockImplementation(async (id, version, reason) => metadata(ledger.endConversation(owner, id, version, reason)));
    f.api.createSession.mockImplementation(async body => {
      ledger.registerAttempt(owner, { liveSessionId: body.liveSessionId, conversationId: body.conversationId,
        conversationVersion: body.conversationVersion, initialMode: body.initialMode,
        startReason: body.startReason, fingerprint: "sdp-hash" });
      return { session: { id: "provider" }, transport: { type: "webrtc", sdp: "answer" } };
    });
    try {
      const oldAttempt = f.scope.newAttempt();
      const first = await f.scope.prepare(oldAttempt);
      expect(first).not.toBeNull();
      await f.scope.stageEnd("user_end");
      if (preflushed) await f.scope.outbox.flush();
      await f.scope.newAttempt().create("offer");
      expect(ledger.getConversation(owner, first!.conversationId).status).toBe("ended");
      expect(f.api.createConversation).toHaveBeenCalledTimes(2);
      expect(f.api.createSession.mock.calls[0]![0]).toMatchObject({ startReason: "initial" });
      expect(f.api.createSession.mock.calls[0]![0].conversationId).not.toBe(first!.conversationId);
      expect(() => oldAttempt.assertCurrent()).toThrow("Provider attempt cancelled");
    } finally { await f.budget.close(); db.close(); }
  });

  it("retries a confirmed End from another scope before replacing an active conversation", async () => {
    const indexedDB = new IDBFactory(), name = crypto.randomUUID();
    const a = fixture(new MetadataDeliveryBudget({ indexedDB, name }));
    const b = fixture(new MetadataDeliveryBudget({ indexedDB, name }));
    b.c.conversationId = "conversation-b";
    await a.scope.prepare(a.scope.newAttempt());
    const first = b.scope.newAttempt();
    await first.create("first");
    await first.finish({ finalized: true });
    await b.scope.outbox.flush();

    await a.scope.stageEnd("user_end");
    vi.spyOn(a.budget, "acknowledgeEnd").mockRejectedValueOnce(new Error("storage unavailable"));
    await a.scope.outbox.flush();
    expect(a.api.end).toHaveBeenCalledWith(a.c.conversationId, a.c.version, "user_end");
    expect(await a.budget.ends()).toHaveLength(1);

    b.api.end.mockRejectedValueOnce(new Error("offline"));
    await expect(b.scope.newAttempt().create("blocked")).rejects.toThrow("End is pending");
    expect(b.api.end).toHaveBeenCalledTimes(1);
    expect(b.api.createSession).toHaveBeenCalledTimes(1);
    expect(await b.budget.ends()).toHaveLength(1);

    const replacement = b.scope.newAttempt();
    await replacement.create("replacement");
    expect(b.api.end).toHaveBeenCalledTimes(2);
    expect(await b.budget.ends()).toHaveLength(0);
    expect(b.api.createConversation).toHaveBeenCalledTimes(1);
    expect(b.api.createSession).toHaveBeenCalledTimes(2);
    expect(b.api.createSession.mock.calls[1]![0]).toMatchObject({ conversationId: b.c.conversationId, startReason: "bootstrap_replacement" });
    await a.budget.close(); await b.budget.close();
  });

  it("blocks provider dispatch while the current conversation has a staged End", async () => {
    const f = fixture();
    await f.scope.prepare(f.scope.newAttempt());
    f.api.end.mockRejectedValue(new Error("offline"));
    await f.scope.stageEnd("user_end");

    await expect(f.scope.newAttempt().create("offer")).rejects.toThrow("End is pending");
    expect(f.api.createConversation).toHaveBeenCalledTimes(1);
    expect(f.api.createSession).not.toHaveBeenCalled();
    await f.budget.close();
  });

  it("keeps a background pause that begins while the staged End is flushed", async () => {
    const f = fixture();
    await f.scope.prepare(f.scope.newAttempt());
    await f.scope.stageEnd("user_end");
    const flush = f.scope.outbox.flush.bind(f.scope.outbox);
    vi.spyOn(f.scope.outbox, "flush").mockImplementationOnce(async () => { await flush(); f.scope.beginBackgroundPause(); });
    await expect(f.scope.newAttempt().create("offer")).rejects.toThrow("Provider attempt cancelled");
    expect(f.api.createSession).not.toHaveBeenCalled();
    await f.budget.close();
  });

  it("blocks a fresh scope with a lost identity pointer until its durable End is confirmed", async () => {
    const indexedDB = new IDBFactory(), name = crypto.randomUUID();
    const originalBudget = new MetadataDeliveryBudget({ indexedDB, name });
    const original = fixture(originalBudget);
    await original.scope.prepare(original.scope.newAttempt());
    sessionStorage.setItem("live-translator-retained-conversation-v1", original.c.conversationId);
    original.api.end.mockRejectedValue(new Error("offline"));
    await original.scope.stageEnd("user_end");
    await expect(original.scope.end("user_end")).rejects.toThrow("offline");
    expect(await originalBudget.ends()).toHaveLength(1);
    sessionStorage.removeItem("live-translator-retained-conversation-v1");
    expect(sessionStorage.getItem("live-translator-retained-conversation-v1")).toBeNull();
    await originalBudget.close();

    const reloadedBudget = new MetadataDeliveryBudget({ indexedDB, name });
    const reloaded = new ConversationAccounting({ api: original.api, budget: reloadedBudget, autoDelivery: false });
    await expect(reloaded.newAttempt().create("offer")).rejects.toThrow("End is pending");
    expect(original.api.createConversation).toHaveBeenCalledTimes(1);
    expect(original.api.createSession).not.toHaveBeenCalled();
    expect(await reloadedBudget.ends()).toHaveLength(1);

    original.api.end.mockResolvedValue({ ...original.c, status: "ended" });
    await reloaded.newAttempt().create("offer");
    expect(await reloadedBudget.ends()).toHaveLength(0);
    expect(original.api.createConversation).toHaveBeenCalledTimes(2);
    expect(original.api.createSession).toHaveBeenCalledTimes(1);
    await reloadedBudget.close();
  });

  it("reruns pending no-provider finalization when its wake coalesces with an in-flight flush", async () => {
    const f = fixture();
    await f.budget.reserve("attempt", f.c.conversationId);
    let entered!: () => void, releaseRead!: () => void;
    const atRead = new Promise<void>(resolve => { entered = resolve; });
    const readGate = new Promise<void>(resolve => { releaseRead = resolve; });
    const entries = vi.spyOn(f.budget, "entries").mockImplementationOnce(async () => { entered(); await readGate; return MetadataDeliveryBudget.prototype.entries.call(f.budget); });
    f.scope.outbox.start();
    await atRead; // This flush has already passed retryPendingFinalizations.
    const finish = vi.spyOn(f.budget, "finishProducerAndRelease").mockRejectedValueOnce(new Error("IDB write failed"));
    const fallback = vi.spyOn(f.budget, "finishProducer").mockRejectedValueOnce(new Error("IDB write failed"));
    await expect(f.scope.finalizeNoProvider("attempt", f.c.conversationId)).rejects.toThrow("IDB write failed");
    finish.mockImplementation((id, outcome) => MetadataDeliveryBudget.prototype.finishProducerAndRelease.call(f.budget, id, outcome));
    fallback.mockImplementation((id, outcome) => MetadataDeliveryBudget.prototype.finishProducer.call(f.budget, id, outcome));
    releaseRead();

    await vi.waitFor(async () => expect(await f.budget.get("attempt")).toBeNull());
    expect(entries).toHaveBeenCalledTimes(2);
    await f.scope.outbox.stop(); await f.budget.close();
  });

  it("schedules a retry after an outbox wake cannot read IndexedDB", async () => {
    const f = fixture();
    try {
      await f.budget.reserve("attempt", f.c.conversationId);
      f.scope.outbox.start();
      await f.scope.outbox.flush();
      const release = vi.spyOn(f.budget, "finishProducerAndRelease").mockRejectedValue(new Error("IDB unavailable"));
      const finalize = vi.spyOn(f.budget, "finishProducer").mockRejectedValue(new Error("IDB unavailable"));
      vi.spyOn(f.budget, "entries").mockRejectedValueOnce(new Error("IDB unavailable"));

      await expect(f.scope.finalizeNoProvider("attempt", f.c.conversationId)).rejects.toThrow("IDB unavailable");
      release.mockRestore(); finalize.mockRestore();
      await vi.waitFor(async () => expect(await f.budget.get("attempt")).toBeNull(), { timeout: 7000, interval: 50 });
    } finally {
      f.scope.outbox.stop(); await f.budget.close();
    }
  }, 9000);

  it("wakes the idle outbox to retry failed no-provider finalization", async () => {
    const f = fixture();
    await f.budget.reserve("attempt", f.c.conversationId);
    const release = vi.spyOn(f.budget, "finishProducerAndRelease").mockRejectedValueOnce(new Error("IDB write failed"));
    const finalize = vi.spyOn(f.budget, "finishProducer").mockRejectedValueOnce(new Error("IDB write failed"));
    f.scope.outbox.start();
    await f.scope.outbox.flush();

    await expect(f.scope.finalizeNoProvider("attempt", f.c.conversationId)).rejects.toThrow("IDB write failed");
    release.mockRestore(); finalize.mockRestore();
    await vi.waitFor(async () => expect(await f.budget.get("attempt")).toBeNull());
    expect(await f.budget.ends()).toEqual([]);
    f.scope.outbox.stop(); await f.budget.close();
  });

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
    original.api.recover.mockImplementation(async () => {
      order.push("recover");
      return { cleanupRequestedAt: Date.now(), state: "closing", openaiSessionId: "provider" };
    });
    original.api.end.mockImplementation(async () => {
      order.push("end");
      return { ...original.c, status: "ended" };
    });
    Object.defineProperty(navigator, "locks", { configurable: true, value: { request: vi.fn((_key: string, _options: { ifAvailable: boolean }, callback: (lock: object | null) => unknown) => Promise.resolve(callback({}))) } });
    const recovered = new ConversationAccounting({ api: original.api, budget: recoveredBudget });

    await vi.waitFor(() => expect(order).toEqual(["recover", "end"]));
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
    await f.budget.enqueueUsage("attempt", f.c.conversationId, { schemaVersion: 1, checkpointSeconds: 10 });
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

  it("does not turn a direct cleanup ACK into no-provider proof after staging fails", async () => {
    const f = fixture();
    f.c.policy.backgroundSessionCloseEnabled = true;
    f.api.policy.mockResolvedValue({ usageLedgerEnabled: true, backgroundSessionCloseEnabled: true });
    f.scope.setSnapshotStore(Promise.resolve({ available: true } as ResumeSnapshotStore));
    const attempt = f.scope.newAttempt(); await attempt.create("offer");
    vi.spyOn(f.scope.outbox, "enqueueEnd").mockRejectedValueOnce(new Error("storage unavailable"));
    await expect(f.scope.stageEnd("setup_cancel")).rejects.toThrow("storage unavailable");
    await f.api.cleanup(attempt.localId, "cancelled");
    await f.scope.acknowledgeDirectCleanup(attempt.localId, f.c.conversationId);
    f.api.end.mockRejectedValue(new Error("offline"));
    await expect(f.scope.end("setup_cancel")).rejects.toThrow("offline");

    expect((await f.budget.ends())[0]).toMatchObject({ cleanupLocalIds: [],
      noProviderPendingLocalIds: [attempt.localId] });
    await f.budget.close();
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
    await store.enqueueUsage("attempt", "c", { schemaVersion: 1, checkpointSeconds: 43 });
    const enqueue = store.enqueueEnd.bind(store) as (id: string, version: number, reason: "user_end", cleanupIds: string[]) => Promise<void>;
    await enqueue("c", 1, "user_end", ["attempt"]); await store.close();
    const reloaded = new MetadataDeliveryBudget({ indexedDB, name });
    expect((await reloaded.get("attempt"))?.cleanup?.reason).toBe("user_end");
    expect((await reloaded.get("attempt"))?.usage?.report.checkpointSeconds).toBe(43);
    expect(await reloaded.ends()).toMatchObject([{ conversationId: "c", expectedVersion: 1 }]);
    const f = fixture(reloaded), order: string[] = [];
    f.api.recover.mockImplementation(async () => {
      order.push("recover"); return { cleanupRequestedAt: 1, state: "closing", openaiSessionId: "provider" };
    });
    f.api.end.mockImplementation(async () => { order.push("end"); return { ...f.c, status: "ended" }; });
    Object.defineProperty(navigator, "locks", { configurable: true, value: { request: vi.fn((_key: string, _options: { ifAvailable: boolean }, callback: (lock: object | null) => unknown) => Promise.resolve(callback({}))) } });
    await f.scope.outbox.flush(); expect(order).toEqual(["recover", "end"]);
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
