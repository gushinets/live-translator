import { coalesceUsage, type UsageReport, type QueuedUsage } from "../metrics/UsageTypes";
export type CleanupReason = "response_not_received" | "primary_startup_failed" | "abandoned_connect" | "hidden" | "user_end" | "cancelled" | "replacement";
export type ProducerOutcome = "no_provider" | "provider_closed" | "lost";
export interface CloseMetadata { seconds?: number; reason?: string; }
export interface MetadataEnvelope {
  localId: string; conversationId: string; producerId: string; reservedAt: number;
  dispatchStartedAt: number | null; producerFinalized: boolean; producerOutcome: ProducerOutcome | null; producerCloseDeadlineAt?: number;
  cleanup: { reason: CleanupReason; createdAt: number; expiresAt: number } | null;
  cleanupAcknowledged?: boolean;
  closeObservation: CloseMetadata | null; usagePending: boolean; usage?: QueuedUsage | null; usageRevision?: number; usageProducerFinalized?: boolean;
}
export interface EndIntent {
  conversationId: string; expectedVersion: number; reason: "user_end" | "setup_cancel"; expiresAt: number; cleanupLocalIds?: string[];
  noProviderPolicyVersion?: string;
  // Cleanup ACK removes cleanupLocalIds; only definitive no_provider proof removes these IDs.
  noProviderPendingLocalIds?: string[];
}
// Legacy rows used the attempt ID as the key; new rows key by conversation and attempt.
interface NoProviderProof { localId: string | [string, string]; attemptLocalId?: string; conversationId: string; expiresAt: number; }
const proofAttemptId = (proof: NoProviderProof) => proof.attemptLocalId ??
  (typeof proof.localId === "string" ? proof.localId : proof.localId[1]);
export const METADATA_TTL_MS = 7 * 86400000;
export const attemptKey = (conversationId: string, localId: string): string => JSON.stringify([conversationId, localId]);
export const noProviderProofDatabaseName = (metadataName: string) => `${metadataName}-no-provider-proofs`;

/** One origin-wide envelope per localId. Every pre-dispatch mutation waits for IDB commit. */
export class MetadataDeliveryBudget {
  private readonly factory: IDBFactory | null;
  private readonly name: string;
  private readonly capacity: number;
  private readonly producerId: string;
  private readonly timeoutMs: number;
  private opening: Promise<IDBDatabase> | undefined;
  private proofOpening: Promise<IDBDatabase> | undefined;
  constructor(options: { indexedDB?: IDBFactory | null; name?: string; capacity?: number; producerId?: string; timeoutMs?: number } = {}) {
    this.factory = options.indexedDB === undefined ? globalThis.indexedDB ?? null : options.indexedDB;
    this.name = options.name ?? "live-translator-metadata-v1"; this.capacity = options.capacity ?? 1000;
    this.producerId = options.producerId ?? crypto.randomUUID(); this.timeoutMs = options.timeoutMs ?? 5000;
  }
  get ownerProducerId(): string { return this.producerId; }
  private openDatabase(name: string, version: number | undefined, create: (db: IDBDatabase) => void,
    opening: "metadata" | "proofs"): Promise<IDBDatabase> {
    if (!this.factory) return Promise.reject(new Error("Metadata storage unavailable"));
    const current = opening === "metadata" ? this.opening : this.proofOpening;
    if (current) return current;
    const pending = new Promise<IDBDatabase>((resolve, reject) => {
      let settled = false;
      const request = version === undefined ? this.factory!.open(name) : this.factory!.open(name, version);
      const fail = (error?: DOMException | null) => {
        if (settled) return;
        settled = true; clearTimeout(timer);
        reject(error?.name === "VersionError" ? error : new Error("Metadata storage unavailable"));
      };
      const timer = setTimeout(() => fail(null), this.timeoutMs);
      request.onupgradeneeded = () => create(request.result);
      request.onsuccess = () => {
        if (settled) { request.result.close(); return; }
        settled = true; clearTimeout(timer); request.result.onversionchange = () => request.result.close(); resolve(request.result);
      };
      request.onerror = () => fail(request.error);
      request.onblocked = () => fail(null);
    }).catch(error => {
      if (opening === "metadata") this.opening = undefined; else this.proofOpening = undefined;
      throw error;
    });
    if (opening === "metadata") this.opening = pending; else this.proofOpening = pending;
    return pending;
  }
  private database(): Promise<IDBDatabase> {
    const upgrade = (db: IDBDatabase) => {
      if (!db.objectStoreNames.contains("envelopes")) db.createObjectStore("envelopes", { keyPath: "localId" });
      if (!db.objectStoreNames.contains("lifecycle")) db.createObjectStore("lifecycle", { keyPath: "conversationId" });
    };
    return this.openDatabase(this.name, 2, upgrade, "metadata").catch(error => {
      if (!(error instanceof DOMException) || error.name !== "VersionError") throw error;
      return this.openExistingMetadata();
    });
  }
  private async openExistingMetadata(): Promise<IDBDatabase> {
    const db = await this.openDatabase(this.name, undefined, () => undefined, "metadata");
    if (db.objectStoreNames.contains("envelopes") && db.objectStoreNames.contains("lifecycle")) return db;
    db.close();
    this.opening = undefined;
    throw new Error("Metadata storage unavailable");
  }
  private proofDatabase(): Promise<IDBDatabase> {
    return this.openDatabase(noProviderProofDatabaseName(this.name), 1, db => {
      if (!db.objectStoreNames.contains("noProviderProofs")) db.createObjectStore("noProviderProofs", { keyPath: "localId" });
    }, "proofs");
  }
  private proofTransaction<T>(mode: IDBTransactionMode, work: (store: IDBObjectStore, result: (value: T) => void, fail: (error: Error) => void) => void): Promise<T> {
    return this.transaction(mode, (store, result, fail) => work(store, result, fail), "noProviderProofs", () => this.proofDatabase());
  }
  private listProofs(): Promise<NoProviderProof[]> {
    return this.proofTransaction("readonly", (store, result) => {
      const all = store.getAll(); all.onsuccess = () => result(all.result as NoProviderProof[]);
    });
  }
  private retainNoProviderProof(conversationId: string, localId: string): Promise<void> {
    return this.proofTransaction("readwrite", (store, result, fail) => {
      const all = store.getAll();
      all.onsuccess = () => {
        const now = Date.now(), key: [string, string] = [conversationId, localId];
        let live = 0;
        for (const proof of all.result as NoProviderProof[]) {
          const sameAttempt = proof.conversationId === conversationId && proofAttemptId(proof) === localId;
          if (proof.expiresAt <= now || sameAttempt && typeof proof.localId === "string") store.delete(proof.localId);
          else if (!sameAttempt) live++;
        }
        if (live >= this.capacity) { fail(new Error("No-provider proof storage is full")); return; }
        store.put({ localId: key, attemptLocalId: localId, conversationId, expiresAt: now + METADATA_TTL_MS } satisfies NoProviderProof);
        result(undefined);
      };
    });
  }
  private deleteProofKeys(keys: ReadonlyArray<NoProviderProof["localId"]>): Promise<void> {
    if (!keys.length) return Promise.resolve();
    return this.proofTransaction("readwrite", (store, result) => { for (const key of keys) store.delete(key); result(undefined); });
  }
  private deleteConversationProofs(conversationId: string): Promise<void> {
    return this.proofTransaction("readwrite", (store, result) => {
      const all = store.getAll();
      all.onsuccess = () => {
        for (const proof of all.result as NoProviderProof[]) if (proof.conversationId === conversationId) store.delete(proof.localId);
        result(undefined);
      };
    });
  }
  private async transaction<T>(mode: IDBTransactionMode, work: (store: IDBObjectStore, result: (value: T) => void, fail: (error: Error) => void, tx: IDBTransaction) => void, storeName: string | string[] = "envelopes", open: () => Promise<IDBDatabase> = () => this.database()): Promise<T> {
    const db = await open();
    return new Promise((resolve, reject) => {
      const tx = db.transaction(storeName, mode); let value: T; let failure: Error | undefined;
      const fail = (error: Error) => { failure = error; try { tx.abort(); } catch { reject(error); } };
      const timer = setTimeout(() => fail(new Error("Metadata storage transaction timed out")), this.timeoutMs);
      tx.oncomplete = () => { clearTimeout(timer); resolve(value); };
      tx.onabort = tx.onerror = () => { clearTimeout(timer); reject(failure ?? new Error("Metadata storage transaction failed")); };
      try { work(tx.objectStore(typeof storeName === "string" ? storeName : storeName[0]!), v => { value = v; }, fail, tx); }
      catch (error) { fail(error instanceof Error ? error : new Error("Metadata storage failure")); }
    });
  }
  reserve(localId: string, conversationId: string, usageEnabled = false): Promise<void> {
    return this.transaction("readwrite", (store, result, fail) => {
      const get = store.get(localId);
      get.onsuccess = () => {
        const existing = get.result as MetadataEnvelope | undefined;
        if (existing) { if (existing.conversationId !== conversationId) fail(new Error("Metadata identity conflict")); else result(undefined); return; }
        const count = store.count();
        count.onsuccess = () => {
          if (count.result >= this.capacity) { fail(new Error("Metadata delivery storage is full")); return; }
          const row: MetadataEnvelope = { localId, conversationId, producerId: this.producerId, reservedAt: Date.now(), dispatchStartedAt: null,
            producerFinalized: false, producerOutcome: null, cleanup: null, closeObservation: null, usagePending: usageEnabled, usageProducerFinalized: !usageEnabled, usage: null, usageRevision: 0 };
          store.add(row); result(undefined);
        };
      };
    });
  }
  private change(localId: string, update: (row: MetadataEnvelope) => MetadataEnvelope | null, conversationId?: string): Promise<void> {
    return this.transaction("readwrite", (store, result, fail) => {
      const get = store.get(localId);
      get.onsuccess = () => {
        if (!get.result) { if (conversationId) result(undefined); else fail(new Error("Metadata storage reservation missing")); return; }
        if (conversationId && (get.result as MetadataEnvelope).conversationId !== conversationId) { result(undefined); return; }
        try { const next = update(get.result as MetadataEnvelope); if (next) store.put(next); else store.delete(localId); result(undefined); }
        catch (error) { fail(error instanceof Error ? error : new Error("Metadata storage failure")); }
      };
    });
  }
  markDispatchStarted(localId: string): Promise<void> {
    return this.change(localId, row => {
      if (row.producerFinalized || row.cleanup) throw new Error("Metadata producer already terminated");
      return { ...row, dispatchStartedAt: row.dispatchStartedAt ?? Date.now() };
    });
  }
  enqueueCleanup(localId: string, reason: CleanupReason, conversationId?: string): Promise<void> {
    return this.change(localId, row => ({ ...row, producerCloseDeadlineAt: row.producerCloseDeadlineAt ?? Date.now(),
      cleanupAcknowledged: false, cleanup: row.cleanup ?? { reason, createdAt: Date.now(), expiresAt: Date.now() + METADATA_TTL_MS } }), conversationId);
  }
  enqueueClose(localId: string, observation: CloseMetadata, conversationId?: string): Promise<void> {
    return this.change(localId, row => ({ ...row, closeObservation: row.closeObservation ?? observation, producerFinalized: true, producerOutcome: "provider_closed" }), conversationId);
  }
  acknowledgeCleanup(localId: string): Promise<void> { return this.change(localId, row => ({ ...row, cleanup: null, cleanupAcknowledged: true })); }
  acknowledgeClose(localId: string): Promise<void> { return this.change(localId, row => ({ ...row, cleanup: null, closeObservation: null })); }
  finishProducer(localId: string, outcome: ProducerOutcome, conversationId?: string): Promise<void> {
    return this.change(localId, row => {
      if (conversationId && row.conversationId !== conversationId) throw new Error("Metadata identity conflict");
      return { ...row, producerFinalized: true, producerOutcome: outcome };
    });
  }
  private releasable(row: MetadataEnvelope): boolean {
    return row.producerFinalized && row.producerOutcome !== null && !row.cleanup && !row.closeObservation && !row.usagePending;
  }
  private async releaseAndRemoveEndDependency(localId: string, update: (row: MetadataEnvelope) => MetadataEnvelope,
    noProvider = false, knownConversationId?: string): Promise<void> {
    if (noProvider) {
      const stored = await this.get(localId);
      const visible = knownConversationId && stored?.conversationId !== knownConversationId ? undefined : stored;
      const conversationId = knownConversationId ?? visible?.conversationId;
      if (conversationId && !(visible?.dispatchStartedAt === null && !knownConversationId))
        await this.retainNoProviderProof(conversationId, localId);
    }
    return this.transaction("readwrite", (store, result, _fail, tx) => {
      const get = store.get(localId);
      get.onsuccess = () => {
        const storedRow = get.result as MetadataEnvelope | undefined;
        const row = knownConversationId && storedRow?.conversationId !== knownConversationId ? undefined : storedRow;
        const conversationId = knownConversationId ?? row?.conversationId;
        if (row) {
          const next = update(row);
          if (this.releasable(next)) store.delete(localId); else store.put(next);
        }
        const ends = tx.objectStore("lifecycle").getAll();
        ends.onsuccess = () => {
          const lifecycle = tx.objectStore("lifecycle");
          for (const intent of ends.result as EndIntent[]) {
            if (intent.conversationId === conversationId &&
              (intent.cleanupLocalIds?.includes(localId) || noProvider && intent.noProviderPendingLocalIds?.includes(localId)))
              lifecycle.put({ ...intent,
                cleanupLocalIds: intent.cleanupLocalIds?.filter(id => id !== localId),
                noProviderPendingLocalIds: noProvider ? intent.noProviderPendingLocalIds?.filter(id => id !== localId) : intent.noProviderPendingLocalIds });
          }
          result(undefined);
        };
      };
    }, ["envelopes", "lifecycle"]);
  }
  acknowledgeCleanupAndRelease(localId: string, conversationId?: string): Promise<void> {
    return this.releaseAndRemoveEndDependency(localId, row => ({ ...row, cleanup: null, cleanupAcknowledged: true }), false, conversationId);
  }
  acknowledgeForeignCleanupFence(localId: string, conversationId?: string): Promise<void> {
    return this.releaseAndRemoveEndDependency(localId, row => {
      const next: MetadataEnvelope = { ...row, cleanup: null, cleanupAcknowledged: true };
      if (!row.closeObservation && row.producerOutcome !== "provider_closed" && row.producerOutcome !== "no_provider") {
        next.producerFinalized = false; next.producerOutcome = null;
      }
      return next;
    }, false, conversationId);
  }
  acknowledgeDirectCleanupAndRelease(localId: string, conversationId?: string): Promise<void> {
    return this.releaseAndRemoveEndDependency(localId, row => ({ ...row, cleanup: null, cleanupAcknowledged: true, producerFinalized: true, producerOutcome: "lost" }), false, conversationId);
  }
  acknowledgeCloseAndRelease(localId: string, conversationId?: string): Promise<void> {
    return this.releaseAndRemoveEndDependency(localId, row => ({ ...row, cleanup: null, closeObservation: null, producerFinalized: true, producerOutcome: "provider_closed" }), false, conversationId);
  }
  finishProducerAndRelease(localId: string, outcome: ProducerOutcome, conversationId?: string): Promise<void> {
    if (outcome === "provider_closed") return this.acknowledgeCloseAndRelease(localId, conversationId);
    if (outcome === "no_provider") return this.releaseAndRemoveEndDependency(localId, row => ({ ...row, cleanup: null, producerFinalized: true, producerOutcome: outcome }), true, conversationId);
    return this.change(localId, row => {
      const next = { ...row, producerFinalized: true, producerOutcome: outcome };
      return this.releasable(next) ? null : next;
    }, conversationId);
  }
  discardDelivery(localId: string, conversationId?: string): Promise<void> {
    return this.releaseAndRemoveEndDependency(localId, row => ({ ...row, cleanup: null, closeObservation: null, producerFinalized: true, producerOutcome: "lost" }), false, conversationId);
  }
  releaseIfSafe(localId: string): Promise<void> {
    return this.change(localId, row => this.releasable(row) ? null : row);
  }
  /** Caller must hold the old producer's exclusive Web Lock to prove its document is gone. */
  reclaimUndispatched(producerId: string): Promise<void> {
    return this.transaction("readwrite", (store, result) => {
      const get = store.getAll(); get.onsuccess = () => {
        for (const row of get.result as MetadataEnvelope[]) if (row.producerId === producerId && row.dispatchStartedAt === null && !row.usage && !row.cleanup && !row.closeObservation) store.delete(row.localId);
        result(undefined);
      };
    });
  }
  enqueueUsage(localId: string, conversationId: string, report: UsageReport): Promise<void> {
    return this.change(localId, row => {
      if (row.conversationId !== conversationId) throw new Error("Metadata identity conflict");
      return { ...row, usagePending: true, usageRevision: (row.usageRevision ?? 0) + 1,
      usage: { revision: (row.usageRevision ?? 0) + 1, expiresAt: row.usage?.expiresAt ?? row.reservedAt + METADATA_TTL_MS,
        report: coalesceUsage(row.usage?.report, report) } };
    });
  }
  acknowledgeUsage(localId: string, conversationId: string, revision: number): Promise<void> {
    return this.change(localId, row => {
      if (row.usage?.revision !== revision) return row;
      const next = { ...row, usage: null, usagePending: row.usageProducerFinalized === false };
      return this.releasable(next) ? null : next;
    }, conversationId);
  }
  finishUsageProducer(localId: string, conversationId: string): Promise<void> {
    return this.change(localId, row => {
      const next = { ...row, usageProducerFinalized: true, usagePending: Boolean(row.usage) };
      return this.releasable(next) ? null : next;
    }, conversationId);
  }
  /** Drops usage only, never cleanup. Callers diagnose expiry, identity loss, or definitive no-provider. */
  discardUsage(localId: string, conversationId: string, revision?: number): Promise<void> {
    return this.change(localId, row => {
      if (revision !== undefined && row.usage?.revision !== revision) return row;
      const next = { ...row, usage: null, usagePending: false, usageProducerFinalized: true };
      return this.releasable(next) ? null : next;
    }, conversationId);
  }
  get(localId: string): Promise<MetadataEnvelope | null> {
    return this.transaction("readonly", (store, result) => { const r = store.get(localId); r.onsuccess = () => result((r.result as MetadataEnvelope | undefined) ?? null); });
  }
  entries(): Promise<MetadataEnvelope[]> {
    return this.transaction("readonly", (store, result) => { const r = store.getAll(); r.onsuccess = () => result(r.result as MetadataEnvelope[]); });
  }
  private async reconcileLaterProofs(conversationId: string, expectedVersion: number,
    consumed: Array<NoProviderProof["localId"]>): Promise<void> {
    const now = Date.now();
    const known = new Set(consumed.map(key => JSON.stringify(key)));
    const later = (await this.listProofs()).filter(proof => proof.conversationId === conversationId &&
      proof.expiresAt > now && !known.has(JSON.stringify(proof.localId)));
    if (!later.length) return;
    const proven = new Set(later.map(proofAttemptId));
    await this.transaction("readwrite", (store, result) => {
      const get = store.get(conversationId);
      get.onsuccess = () => {
        const intent = get.result as EndIntent | undefined;
        const pending = intent?.noProviderPendingLocalIds;
        if (intent?.expectedVersion !== expectedVersion || !pending?.some(id => proven.has(id))) { result(undefined); return; }
        const removed = new Set(pending.filter(id => proven.has(id)));
        consumed.push(...later.filter(proof => removed.has(proofAttemptId(proof))).map(proof => proof.localId));
        store.put({ ...intent, noProviderPendingLocalIds: pending.filter(id => !removed.has(id)) });
        result(undefined);
      };
    }, "lifecycle");
  }
  async enqueueEnd(conversationId: string, expectedVersion: number, reason: EndIntent["reason"], cleanupLocalIds: readonly string[] = [], closeTimeoutMs = 0,
    noProviderPolicyVersion?: string, noProviderAttemptIds: readonly string[] = cleanupLocalIds): Promise<void> {
    // One transaction removes the crash gap between saving cleanup and saving user intent.
    // Cleanup remains first-reason-wins, and no usage/close obligation is removed here.
    const safeTimeout = Number.isFinite(closeTimeoutMs) ? Math.min(2_147_483_647, Math.max(0, closeTimeoutMs)) : 2_147_483_647;
    const storedProofs = await this.listProofs();
    const consumed: Array<NoProviderProof["localId"]> = [];
    let reconcileProofs = false;
    await this.transaction("readwrite", (store, result, fail, tx) => {
      const now = Date.now(), requestedCloseDeadlineAt = now + safeTimeout;
      let expiresAt = now + METADATA_TTL_MS;
      const envelopes = tx.objectStore("envelopes");
      const rows = envelopes.getAll(); rows.onsuccess = () => {
        const byId = new Map((rows.result as MetadataEnvelope[]).map(row => [row.localId, row]));
        const get = store.get(conversationId); get.onsuccess = () => {
          const old = get.result as EndIntent | undefined;
          const sameEnd = old?.expectedVersion === expectedVersion;
          const applicable = [...new Set(cleanupLocalIds)].filter(id => {
            const row = byId.get(id);
            return row?.conversationId === conversationId && row.dispatchStartedAt !== null && (row.closeObservation || (
              !row.cleanupAcknowledged &&
              !(row.producerFinalized && row.producerOutcome === "lost" && !row.cleanup) &&
              row.producerOutcome !== "provider_closed" && row.producerOutcome !== "no_provider"));
          });
          const retained = sameEnd ? (old?.cleanupLocalIds ?? []).filter(id => {
            const row = byId.get(id);
            return Boolean(row && (row.cleanup || row.closeObservation));
          }) : [];
          const dependencies = [...new Set([...retained, ...applicable])];
          const replayPolicyVersion = (sameEnd ? old?.reason : reason) === "setup_cancel"
            ? (sameEnd ? old?.noProviderPolicyVersion : noProviderPolicyVersion) : undefined;
          const pendingIds = sameEnd ? old?.noProviderPendingLocalIds ?? [] : [...new Set(noProviderAttemptIds)];
          const proofIds = new Set(pendingIds);
          const matchingProofs = storedProofs
            .filter(proof => proof.conversationId === conversationId && proof.expiresAt > now && proofIds.has(proofAttemptId(proof)));
          const proven = new Set(matchingProofs.map(proofAttemptId));
          const noProviderPendingLocalIds = replayPolicyVersion
            ? pendingIds.filter(id => !proven.has(id)) : undefined;
          const consumeProofs = () => {
            if (!replayPolicyVersion) return;
            reconcileProofs = true;
            consumed.push(...matchingProofs.map(proof => proof.localId));
          };
          for (const id of applicable) {
            const row = byId.get(id)!;
            if (row.closeObservation) continue;
            const legacyDeadline = row.cleanup ? Math.max(row.cleanup.createdAt, row.cleanup.expiresAt - METADATA_TTL_MS) : 0;
            const existingDeadline = row.producerCloseDeadlineAt ?? (row.cleanup ? legacyDeadline : requestedCloseDeadlineAt);
            const producerCloseDeadlineAt = sameEnd ? existingDeadline : row.producerFinalized
              ? (row.producerCloseDeadlineAt ?? (row.cleanup ? legacyDeadline : now))
              : Math.max(row.producerCloseDeadlineAt ?? legacyDeadline, requestedCloseDeadlineAt);
            const cleanupExpiresAt = Math.max(row.cleanup?.expiresAt ?? 0, now + METADATA_TTL_MS, producerCloseDeadlineAt + METADATA_TTL_MS);
            expiresAt = Math.max(expiresAt, cleanupExpiresAt);
            envelopes.put({ ...row, producerCloseDeadlineAt,
              cleanup: row.cleanup ? { ...row.cleanup, expiresAt: cleanupExpiresAt } : { reason: reason === "setup_cancel" ? "cancelled" : "user_end", createdAt: now, expiresAt: cleanupExpiresAt } });
          }
          if (old) { if (old.expectedVersion <= expectedVersion) { consumeProofs(); store.put({ conversationId, expectedVersion, reason: sameEnd ? old.reason : reason,
            expiresAt, cleanupLocalIds: dependencies, noProviderPolicyVersion: replayPolicyVersion,
            noProviderPendingLocalIds }); } result(undefined); return; }
          const count = store.count(); count.onsuccess = () => {
            if (count.result >= 1000) { fail(new Error("Lifecycle metadata storage is full")); return; }
            consumeProofs();
            store.put({ conversationId, expectedVersion, reason, expiresAt, cleanupLocalIds: dependencies,
              noProviderPolicyVersion: replayPolicyVersion, noProviderPendingLocalIds }); result(undefined);
          };
        };
      };
    }, ["lifecycle", "envelopes"]);
    if (reconcileProofs) await this.reconcileLaterProofs(conversationId, expectedVersion, consumed);
    await this.deleteProofKeys(consumed);
  }
  ends(): Promise<EndIntent[]> {
    return this.transaction("readonly", (store, result) => { const r = store.getAll(); r.onsuccess = () => result(r.result as EndIntent[]); }, "lifecycle");
  }
  async acknowledgeEnd(id: string, version: number): Promise<void> {
    const clearProofs = await this.transaction("readwrite", (store, result) => {
      const r = store.get(id); r.onsuccess = () => {
        const row = r.result as EndIntent | undefined;
        if (row && row.expectedVersion !== version) { result(false); return; }
        if (row) store.delete(id);
        result(true);
      };
    }, "lifecycle");
    if (clearProofs) await this.deleteConversationProofs(id);
  }
  async close(): Promise<void> {
    if (this.opening) (await this.opening).close();
    this.opening = undefined;
    if (this.proofOpening) (await this.proofOpening).close();
    this.proofOpening = undefined;
  }
}
