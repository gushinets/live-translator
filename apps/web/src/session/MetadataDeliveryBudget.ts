export type CleanupReason = "response_not_received" | "primary_startup_failed" | "abandoned_connect" | "hidden" | "user_end" | "cancelled" | "replacement";
export type ProducerOutcome = "no_provider" | "provider_closed" | "lost";
export interface CloseMetadata { seconds?: number; reason?: string; }
export interface MetadataEnvelope {
  localId: string; conversationId: string; producerId: string; reservedAt: number;
  dispatchStartedAt: number | null; producerFinalized: boolean; producerOutcome: ProducerOutcome | null;
  cleanup: { reason: CleanupReason; createdAt: number; expiresAt: number } | null;
  closeObservation: CloseMetadata | null; usagePending: boolean;
}
export interface EndIntent { conversationId: string; expectedVersion: number; reason: "user_end" | "setup_cancel"; expiresAt: number; }
const TTL = 7 * 86400000;

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
  private database(): Promise<IDBDatabase> {
    if (!this.factory) return Promise.reject(new Error("Metadata storage unavailable"));
    this.opening ??= new Promise<IDBDatabase>((resolve, reject) => {
      let settled = false;
      const request = this.factory!.open(this.name, 1);
      const fail = () => { if (!settled) { settled = true; clearTimeout(timer); reject(new Error("Metadata storage unavailable")); } };
      const timer = setTimeout(fail, this.timeoutMs);
      request.onupgradeneeded = () => {
        request.result.createObjectStore("envelopes", { keyPath: "localId" });
        request.result.createObjectStore("lifecycle", { keyPath: "conversationId" });
      };
      request.onsuccess = () => {
        if (settled) { request.result.close(); return; }
        settled = true; clearTimeout(timer); request.result.onversionchange = () => request.result.close(); resolve(request.result);
      };
      request.onerror = request.onblocked = fail;
    }).catch(error => { this.opening = undefined; throw error; });
    return this.opening;
  }
  private async transaction<T>(mode: IDBTransactionMode, work: (store: IDBObjectStore, result: (value: T) => void, fail: (error: Error) => void) => void, storeName = "envelopes"): Promise<T> {
    const db = await this.database();
    return new Promise((resolve, reject) => {
      const tx = db.transaction(storeName, mode); let value: T; let failure: Error | undefined;
      const fail = (error: Error) => { failure = error; try { tx.abort(); } catch { reject(error); } };
      const timer = setTimeout(() => fail(new Error("Metadata storage transaction timed out")), this.timeoutMs);
      tx.oncomplete = () => { clearTimeout(timer); resolve(value); };
      tx.onabort = tx.onerror = () => { clearTimeout(timer); reject(failure ?? new Error("Metadata storage transaction failed")); };
      try { work(tx.objectStore(storeName), v => { value = v; }, fail); }
      catch (error) { fail(error instanceof Error ? error : new Error("Metadata storage failure")); }
    });
  }
  reserve(localId: string, conversationId: string): Promise<void> {
    return this.transaction("readwrite", (store, result, fail) => {
      const get = store.get(localId);
      get.onsuccess = () => {
        const existing = get.result as MetadataEnvelope | undefined;
        if (existing) { if (existing.conversationId !== conversationId) fail(new Error("Metadata identity conflict")); else result(undefined); return; }
        const count = store.count();
        count.onsuccess = () => {
          if (count.result >= this.capacity) { fail(new Error("Metadata delivery storage is full")); return; }
          const row: MetadataEnvelope = { localId, conversationId, producerId: this.producerId, reservedAt: Date.now(), dispatchStartedAt: null,
            producerFinalized: false, producerOutcome: null, cleanup: null, closeObservation: null, usagePending: false };
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
    return this.change(localId, row => ({ ...row, cleanup: row.cleanup ?? { reason, createdAt: Date.now(), expiresAt: Date.now() + TTL } }));
  }
  enqueueClose(localId: string, observation: CloseMetadata): Promise<void> {
    return this.change(localId, row => ({ ...row, closeObservation: row.closeObservation ?? observation, producerFinalized: true, producerOutcome: "provider_closed" }));
  }
  acknowledgeCleanup(localId: string): Promise<void> { return this.change(localId, row => ({ ...row, cleanup: null })); }
  acknowledgeClose(localId: string): Promise<void> { return this.change(localId, row => ({ ...row, cleanup: null, closeObservation: null })); }
  finishProducer(localId: string, outcome: ProducerOutcome): Promise<void> { return this.change(localId, row => ({ ...row, producerFinalized: true, producerOutcome: outcome })); }
  releaseIfSafe(localId: string): Promise<void> {
    return this.change(localId, row => row.producerFinalized && row.producerOutcome !== null && !row.cleanup && !row.closeObservation && !row.usagePending ? null : row);
  }
  /** Caller must hold the old producer's exclusive Web Lock to prove its document is gone. */
  reclaimUndispatched(producerId: string): Promise<void> {
    return this.transaction("readwrite", (store, result) => {
      const get = store.getAll(); get.onsuccess = () => {
        for (const row of get.result as MetadataEnvelope[]) if (row.producerId === producerId && row.dispatchStartedAt === null && !row.usagePending && !row.cleanup && !row.closeObservation) store.delete(row.localId);
        result(undefined);
      };
    });
  }
  get(localId: string): Promise<MetadataEnvelope | null> {
    return this.transaction("readonly", (store, result) => { const r = store.get(localId); r.onsuccess = () => result((r.result as MetadataEnvelope | undefined) ?? null); });
  }
  entries(): Promise<MetadataEnvelope[]> {
    return this.transaction("readonly", (store, result) => { const r = store.getAll(); r.onsuccess = () => result(r.result as MetadataEnvelope[]); });
  }
  enqueueEnd(conversationId: string, expectedVersion: number, reason: EndIntent["reason"]): Promise<void> {
    return this.transaction("readwrite", (store, result, fail) => {
      const get = store.get(conversationId); get.onsuccess = () => {
        const old = get.result as EndIntent | undefined;
        if (old) { if (old.expectedVersion < expectedVersion) store.put({ conversationId, expectedVersion, reason, expiresAt: Date.now() + TTL }); result(undefined); return; }
        const count = store.count(); count.onsuccess = () => {
          if (count.result >= 1000) { fail(new Error("Lifecycle metadata storage is full")); return; }
          store.put({ conversationId, expectedVersion, reason, expiresAt: Date.now() + TTL }); result(undefined);
        };
      };
    }, "lifecycle");
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
