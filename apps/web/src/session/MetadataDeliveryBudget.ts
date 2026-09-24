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
export interface EndIntent { conversationId: string; expectedVersion: number; reason: "user_end" | "setup_cancel"; expiresAt: number; cleanupLocalIds?: string[]; }
export const METADATA_TTL_MS = 7 * 86400000;

/** One origin-wide envelope per localId. Every pre-dispatch mutation waits for IDB commit. */
export class MetadataDeliveryBudget {
  private readonly factory: IDBFactory | null;
  private readonly name: string;
  private readonly capacity: number;
  private readonly producerId: string;
  private readonly timeoutMs: number;
  private opening: Promise<IDBDatabase> | undefined;
  constructor(options: { indexedDB?: IDBFactory | null; name?: string; capacity?: number; producerId?: string; timeoutMs?: number } = {}) {
    this.factory = options.indexedDB === undefined ? globalThis.indexedDB ?? null : options.indexedDB;
    this.name = options.name ?? "live-translator-metadata-v1"; this.capacity = options.capacity ?? 1000;
    this.producerId = options.producerId ?? crypto.randomUUID(); this.timeoutMs = options.timeoutMs ?? 5000;
  }
  get ownerProducerId(): string { return this.producerId; }
  private database(): Promise<IDBDatabase> {
    if (!this.factory) return Promise.reject(new Error("Metadata storage unavailable"));
    this.opening ??= new Promise<IDBDatabase>((resolve, reject) => {
      let settled = false;
      const request = this.factory!.open(this.name, 2);
      const fail = () => { if (!settled) { settled = true; clearTimeout(timer); reject(new Error("Metadata storage unavailable")); } };
      const timer = setTimeout(fail, this.timeoutMs);
      request.onupgradeneeded = () => {
        const db = request.result;
        if (!db.objectStoreNames.contains("envelopes")) db.createObjectStore("envelopes", { keyPath: "localId" });
        if (!db.objectStoreNames.contains("lifecycle")) db.createObjectStore("lifecycle", { keyPath: "conversationId" });
      };
      request.onsuccess = () => {
        if (settled) { request.result.close(); return; }
        settled = true; clearTimeout(timer); request.result.onversionchange = () => request.result.close(); resolve(request.result);
      };
      request.onerror = request.onblocked = fail;
    }).catch(error => { this.opening = undefined; throw error; });
    return this.opening;
  }
  private async transaction<T>(mode: IDBTransactionMode, work: (store: IDBObjectStore, result: (value: T) => void, fail: (error: Error) => void, tx: IDBTransaction) => void, storeName: string | string[] = "envelopes"): Promise<T> {
    const db = await this.database();
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
  private change(localId: string, update: (row: MetadataEnvelope) => MetadataEnvelope | null): Promise<void> {
    return this.transaction("readwrite", (store, result, fail) => {
      const get = store.get(localId);
      get.onsuccess = () => {
        if (!get.result) { fail(new Error("Metadata storage reservation missing")); return; }
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
  enqueueCleanup(localId: string, reason: CleanupReason): Promise<void> {
    return this.change(localId, row => ({ ...row, producerCloseDeadlineAt: row.producerCloseDeadlineAt ?? Date.now(),
      cleanupAcknowledged: false, cleanup: row.cleanup ?? { reason, createdAt: Date.now(), expiresAt: Date.now() + METADATA_TTL_MS } }));
  }
  enqueueClose(localId: string, observation: CloseMetadata): Promise<void> {
    return this.change(localId, row => ({ ...row, closeObservation: row.closeObservation ?? observation, producerFinalized: true, producerOutcome: "provider_closed" }));
  }
  acknowledgeCleanup(localId: string): Promise<void> { return this.change(localId, row => ({ ...row, cleanup: null, cleanupAcknowledged: true })); }
  acknowledgeClose(localId: string): Promise<void> { return this.change(localId, row => ({ ...row, cleanup: null, closeObservation: null })); }
  finishProducer(localId: string, outcome: ProducerOutcome): Promise<void> { return this.change(localId, row => ({ ...row, producerFinalized: true, producerOutcome: outcome })); }
  private releasable(row: MetadataEnvelope): boolean {
    return row.producerFinalized && row.producerOutcome !== null && !row.cleanup && !row.closeObservation && !row.usagePending;
  }
  private releaseAndRemoveEndDependency(localId: string, update: (row: MetadataEnvelope) => MetadataEnvelope): Promise<void> {
    return this.transaction("readwrite", (store, result, _fail, tx) => {
      const get = store.get(localId);
      get.onsuccess = () => {
        const row = get.result as MetadataEnvelope | undefined;
        if (row) {
          const next = update(row);
          if (this.releasable(next)) store.delete(localId); else store.put(next);
        }
        const ends = tx.objectStore("lifecycle").getAll();
        ends.onsuccess = () => {
          const lifecycle = tx.objectStore("lifecycle");
          for (const intent of ends.result as EndIntent[]) {
            if (intent.cleanupLocalIds?.includes(localId)) lifecycle.put({ ...intent, cleanupLocalIds: intent.cleanupLocalIds.filter(id => id !== localId) });
          }
          result(undefined);
        };
      };
    }, ["envelopes", "lifecycle"]);
  }
  acknowledgeCleanupAndRelease(localId: string): Promise<void> {
    return this.releaseAndRemoveEndDependency(localId, row => ({ ...row, cleanup: null, cleanupAcknowledged: true }));
  }
  acknowledgeForeignCleanupFence(localId: string): Promise<void> {
    return this.releaseAndRemoveEndDependency(localId, row => {
      const next: MetadataEnvelope = { ...row, cleanup: null, cleanupAcknowledged: true };
      if (!row.closeObservation && row.producerOutcome !== "provider_closed" && row.producerOutcome !== "no_provider") {
        next.producerFinalized = false; next.producerOutcome = null;
      }
      return next;
    });
  }
  acknowledgeDirectCleanupAndRelease(localId: string): Promise<void> {
    return this.releaseAndRemoveEndDependency(localId, row => ({ ...row, cleanup: null, cleanupAcknowledged: true, producerFinalized: true, producerOutcome: "lost" }));
  }
  acknowledgeCloseAndRelease(localId: string): Promise<void> {
    return this.releaseAndRemoveEndDependency(localId, row => ({ ...row, cleanup: null, closeObservation: null, producerFinalized: true, producerOutcome: "provider_closed" }));
  }
  finishProducerAndRelease(localId: string, outcome: ProducerOutcome): Promise<void> {
    if (outcome === "provider_closed") return this.acknowledgeCloseAndRelease(localId);
    if (outcome === "no_provider") return this.releaseAndRemoveEndDependency(localId, row => ({ ...row, cleanup: null, producerFinalized: true, producerOutcome: outcome }));
    return this.change(localId, row => {
      const next = { ...row, producerFinalized: true, producerOutcome: outcome };
      return this.releasable(next) ? null : next;
    });
  }
  discardDelivery(localId: string): Promise<void> {
    return this.releaseAndRemoveEndDependency(localId, row => ({ ...row, cleanup: null, closeObservation: null, producerFinalized: true, producerOutcome: "lost" }));
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
  enqueueUsage(localId: string, report: UsageReport): Promise<void> {
    return this.change(localId, row => ({ ...row, usagePending: true, usageRevision: (row.usageRevision ?? 0) + 1,
      usage: { revision: (row.usageRevision ?? 0) + 1, expiresAt: row.usage?.expiresAt ?? row.reservedAt + METADATA_TTL_MS,
        report: coalesceUsage(row.usage?.report, report) } }));
  }
  acknowledgeUsage(localId: string, revision: number): Promise<void> {
    return this.change(localId, row => {
      if (row.usage?.revision !== revision) return row;
      const next = { ...row, usage: null, usagePending: row.usageProducerFinalized === false };
      return this.releasable(next) ? null : next;
    });
  }
  finishUsageProducer(localId: string): Promise<void> {
    return this.change(localId, row => {
      const next = { ...row, usageProducerFinalized: true, usagePending: Boolean(row.usage) };
      return this.releasable(next) ? null : next;
    });
  }
  /** Drops usage only, never cleanup. Callers diagnose expiry, identity loss, or definitive no-provider. */
  discardUsage(localId: string, revision?: number): Promise<void> {
    return this.change(localId, row => {
      if (revision !== undefined && row.usage?.revision !== revision) return row;
      const next = { ...row, usage: null, usagePending: false, usageProducerFinalized: true };
      return this.releasable(next) ? null : next;
    });
  }
  get(localId: string): Promise<MetadataEnvelope | null> {
    return this.transaction("readonly", (store, result) => { const r = store.get(localId); r.onsuccess = () => result((r.result as MetadataEnvelope | undefined) ?? null); });
  }
  entries(): Promise<MetadataEnvelope[]> {
    return this.transaction("readonly", (store, result) => { const r = store.getAll(); r.onsuccess = () => result(r.result as MetadataEnvelope[]); });
  }
  enqueueEnd(conversationId: string, expectedVersion: number, reason: EndIntent["reason"], cleanupLocalIds: readonly string[] = [], closeTimeoutMs = 0): Promise<void> {
    // One transaction removes the crash gap between saving cleanup and saving user intent.
    // Cleanup remains first-reason-wins, and no usage/close obligation is removed here.
    const safeTimeout = Number.isFinite(closeTimeoutMs) ? Math.min(2_147_483_647, Math.max(0, closeTimeoutMs)) : 2_147_483_647;
    return this.transaction("readwrite", (store, result, fail, tx) => {
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
          if (old) { if (old.expectedVersion <= expectedVersion) store.put({ conversationId, expectedVersion, reason: sameEnd ? old.reason : reason, expiresAt, cleanupLocalIds: dependencies }); result(undefined); return; }
          const count = store.count(); count.onsuccess = () => {
            if (count.result >= 1000) { fail(new Error("Lifecycle metadata storage is full")); return; }
            store.put({ conversationId, expectedVersion, reason, expiresAt, cleanupLocalIds: dependencies }); result(undefined);
          };
        };
      };
    }, ["lifecycle", "envelopes"]);
  }
  ends(): Promise<EndIntent[]> {
    return this.transaction("readonly", (store, result) => { const r = store.getAll(); r.onsuccess = () => result(r.result as EndIntent[]); }, "lifecycle");
  }
  acknowledgeEnd(id: string, version: number): Promise<void> {
    return this.transaction("readwrite", (store, result) => {
      const r = store.get(id); r.onsuccess = () => { if ((r.result as EndIntent | undefined)?.expectedVersion === version) store.delete(id); result(undefined); };
    }, "lifecycle");
  }
  async close(): Promise<void> { if (this.opening) (await this.opening).close(); this.opening = undefined; }
}
