import { IDBFactory } from "fake-indexeddb";
import { describe, expect, it } from "vitest";
import { AccountingRequestError, type ConversationMetadata } from "../api/AccountingBackend";
import { ResumeSnapshotStore, type ResumeSnapshotInput } from "./ResumeSnapshotStore";

class TabStorage implements Storage {
  private values = new Map<string, string>();
  get length() { return this.values.size; }
  key(index: number) { return [...this.values.keys()][index] ?? null; }
  getItem(key: string) { return this.values.get(key) ?? null; }
  setItem(key: string, value: string) { this.values.set(key, value); }
  removeItem(key: string) { this.values.delete(key); }
  clear() { this.values.clear(); }
  clone() { const copy = new TabStorage(); for (const [key, value] of this.values) copy.setItem(key, value); return copy; }
}

class DocumentLocks {
  private held = new Set<string>();
  request<T>(name: string, options: LockOptions, callback: (lock: Lock | null) => T | PromiseLike<T>): Promise<T> {
    if (options.mode !== "exclusive" || options.ifAvailable !== true) throw new Error("blocking lock request");
    if (this.held.has(name)) return Promise.resolve(callback(null));
    this.held.add(name);
    return Promise.resolve(callback({ name, mode: "exclusive" } as Lock)).finally(() => this.held.delete(name));
  }
  discardDocument(name: string) { this.held.delete(name); }
}

class RejectOnceLocks extends DocumentLocks {
  private failed = false;
  override request<T>(name: string, options: LockOptions, callback: (lock: Lock | null) => T | PromiseLike<T>): Promise<T> {
    if (!this.failed) { this.failed = true; return Promise.reject(new Error("Web Locks denied")); }
    return super.request(name, options, callback);
  }
}

const input: ResumeSnapshotInput = {
  conversationId: "conversation-1", conversationVersion: 3, policyVersion: "unit-economics-v1.1",
  participantA: { language: "en", hasAcceptedConversationSpeech: true },
  participantB: { language: "es", hasAcceptedConversationSpeech: false },
  contextText: "Edited context", setupStage: "interpreter", enteredInterpreter: true,
  interruptedUtterance: false, productDeadlineAt: 800_000, counters: { completedTurnCount: 2 },
};
const paused = (patch: Partial<ConversationMetadata> = {}): ConversationMetadata => ({
  conversationId: "conversation-1", version: 3, status: "paused", productDeadlineAt: 800_000,
  resumeExpiresAt: 400_000, resumeAttemptId: null, serverTime: 100_000,
  policy: { sessionCloseTimeoutMs: 15_000, backgroundSessionCloseEnabled: true, conversationRetentionMs: 300_000,
    maxProviderSessionMs: 900_000, maxConversationElapsedMs: 900_000, sessionHandoffAckTimeoutMs: 30_000,
    resumeClaimTimeoutMs: 60_000, policyVersion: "unit-economics-v1.1" }, ...patch,
});

function fixture() {
  const indexedDB = new IDBFactory(), name = crypto.randomUUID(), locks = new DocumentLocks(), tab = new TabStorage();
  let time = 100_000;
  const open = (storage = tab, lockManager: DocumentLocks | null = locks) => ResumeSnapshotStore.open({
    indexedDB, name, sessionStorage: storage, locks: lockManager as unknown as LockManager, now: () => time,
  });
  return { indexedDB, name, locks, tab, open, at: (value: number) => { time = value; } };
}

async function seed(store: ResumeSnapshotStore) {
  await store.save(input);
  await store.markHidden(input.conversationId, 100_000, 300_000);
  await store.confirmPause(paused());
}

async function rawRow(factory: IDBFactory, name: string, key: [string, string], change?: (row: Record<string, unknown>) => Record<string, unknown>) {
  const db = await new Promise<IDBDatabase>((resolve, reject) => {
    const request = factory.open(name); request.onsuccess = () => resolve(request.result); request.onerror = () => reject(request.error);
  });
  const value = await new Promise<Record<string, unknown> | undefined>((resolve, reject) => {
    const tx = db.transaction("snapshots", change ? "readwrite" : "readonly"), object = tx.objectStore("snapshots"), request = object.get(key);
    request.onsuccess = () => { const row = request.result as Record<string, unknown> | undefined; if (row && change) object.put(change(row)); resolve(row); };
    request.onerror = () => reject(request.error);
  });
  db.close(); return value;
}

describe("retained conversation snapshot", () => {
  it("reloads its own paused conversation and persists only the allowlist", async () => {
    const f = fixture(), first = await f.open();
    await first.save({ ...input, secretToken: "never", transcript: "private speech" } as ResumeSnapshotInput);
    await first.markHidden(input.conversationId, 100_000, 300_000);
    await first.confirmPause(paused());
    const key: [string, string] = [first.clientInstanceId, input.conversationId];
    expect(JSON.stringify(await rawRow(f.indexedDB, f.name, key))).not.toMatch(/secretToken|transcript|private speech|never/);
    f.locks.discardDocument(`client-instance:${first.clientInstanceId}`);
    const reload = await f.open();
    expect(reload.clientInstanceId).toBe(first.clientInstanceId);
    expect(await reload.readForResume(async () => paused())).toMatchObject({
      conversationId: "conversation-1", conversationVersion: 3, contextText: "Edited context",
      participantA: { language: "en" }, counters: { completedTurnCount: 2 }, localResumeDeadlineAt: 400_000,
    });
  });

  it("uses the hidden timestamp, never the later pause ACK, and rejects the exact TTL boundary", async () => {
    const f = fixture(), store = await f.open(); await seed(store);
    await store.confirmPause(paused({ resumeExpiresAt: 900_000 }));
    f.at(399_999); expect(await store.readForResume(async () => paused({ resumeExpiresAt: 900_000 }))).not.toBeNull();
    f.at(400_000); expect(await store.readForResume(async () => paused({ resumeExpiresAt: 900_000 }))).toBeNull();
    expect(await rawRow(f.indexedDB, f.name, [store.clientInstanceId, input.conversationId])).toBeUndefined();
  });

  it("discards corrupt and unknown-version rows before server lookup", async () => {
    for (const mutate of [(row: Record<string, unknown>) => ({ ...row, schemaVersion: 99 }),
      (row: Record<string, unknown>) => ({ ...row, contextText: { text: "wrong shape" } })]) {
      const f = fixture(), store = await f.open(); await seed(store);
      const key: [string, string] = [store.clientInstanceId, input.conversationId];
      await rawRow(f.indexedDB, f.name, key, mutate);
      expect(await store.readForResume(async () => { throw new Error("should not reach server"); })).toBeNull();
      expect(await rawRow(f.indexedDB, f.name, key)).toBeUndefined();
    }
  });

  it("rejects active, changed-version, lost-cookie and mismatched-identity records", async () => {
    for (const read of [
      async () => paused({ status: "active" }),
      async () => paused({ version: 4 }),
      async () => { throw new AccountingRequestError(401, "identity_required"); },
      async () => paused({ conversationId: "someone-else" }),
      async () => ({ conversationId: input.conversationId, status: "paused", version: 3 } as ConversationMetadata),
    ]) {
      const f = fixture(), store = await f.open(); await seed(store);
      expect(await store.readForResume(read)).toBeNull();
      expect(await rawRow(f.indexedDB, f.name, [store.clientInstanceId, input.conversationId])).toBeUndefined();
    }
  });

  it("rotates a duplicated or opener tab immediately while the original document is frozen", async () => {
    const f = fixture(), owner = await f.open(); await seed(owner);
    const clone = await f.open(f.tab.clone());
    expect(clone.clientInstanceId).not.toBe(owner.clientInstanceId);
    expect(await clone.readForResume(async () => paused())).toBeNull();
    expect(await owner.readForResume(async () => paused())).not.toBeNull();
  });

  it("fails closed without Web Locks and never reads the inherited snapshot", async () => {
    const f = fixture(), owner = await f.open(); await seed(owner);
    const unsupported = await f.open(f.tab.clone(), null);
    expect(unsupported.clientInstanceId).not.toBe(owner.clientInstanceId);
    expect(await unsupported.readForResume(async () => paused())).toBeNull();
    await expect(unsupported.save(input)).resolves.toBeUndefined();
    expect(await rawRow(f.indexedDB, f.name, [unsupported.clientInstanceId, input.conversationId])).toBeUndefined();
  });

  it("treats a rejected Web Locks probe as unavailable instead of rotating into a retry loop", async () => {
    const f = fixture(), store = await f.open(f.tab, new RejectOnceLocks());
    expect(store.available).toBe(false);
    await expect(store.save(input)).resolves.toBeUndefined();
  });

  it("keeps the first local deadline and rejects a stale pause ACK", async () => {
    const f = fixture(), store = await f.open(); await seed(store);
    await store.markHidden(input.conversationId, 110_000, 300_000);
    await store.confirmPause(paused({ version: 2, resumeExpiresAt: 900_000 }));
    await store.save({ ...input, contextText: "Latest confirmed edit" });
    expect(await store.readForResume(async () => paused())).toMatchObject({ localResumeDeadlineAt: 400_000,
      conversationVersion: 3, contextText: "Latest confirmed edit" });
  });

  it("does not let a late confirmed-state write roll back the pause version", async () => {
    const f = fixture(), store = await f.open(); await seed(store);
    await store.confirmPause(paused({ version: 4 }));
    await store.save(input);
    expect(await store.readForResume(async () => paused({ version: 4 }))).toMatchObject({ conversationVersion: 4 });
  });

  it("persists one claim ID before dispatch and refuses a competing ID", async () => {
    const f = fixture(), store = await f.open(); await seed(store);
    const id = crypto.randomUUID();
    await store.rememberResumeAttempt(input.conversationId, id);
    await expect(store.rememberResumeAttempt(input.conversationId, crypto.randomUUID())).rejects.toThrow();
    expect(await store.readForResume(async () => paused())).toMatchObject({ localResumeDeadlineAt: 400_000, conversationVersion: 3 });
    f.locks.discardDocument(`client-instance:${store.clientInstanceId}`);
    const reload = await f.open();
    expect(await reload.readForResume(async () => paused())).toMatchObject({ resumeAttemptId: id });
    await reload.clearResumeAttempt(input.conversationId, crypto.randomUUID());
    expect(await reload.readForResume(async () => paused())).toMatchObject({ resumeAttemptId: id });
    await reload.clearResumeAttempt(input.conversationId, id);
    expect(await reload.readForResume(async () => paused())).toMatchObject({ resumeAttemptId: null });
  });

  it("exposes an interrupted matching claim for abort without making it resumable", async () => {
    const f = fixture(), store = await f.open(); await seed(store);
    const id = crypto.randomUUID();
    await store.rememberResumeAttempt(input.conversationId, id);
    const server = paused({ version: 4, status: "resuming", resumeAttemptId: id });
    expect(await store.inspectReload(async () => server)).toMatchObject({ kind: "pending", snapshot: { resumeAttemptId: id },
      conversation: { version: 4, status: "resuming" } });
    expect(await store.readForResume(async () => server)).toBeNull();
    expect(await rawRow(f.indexedDB, f.name, [store.clientInstanceId, input.conversationId])).toBeDefined();
  });

  it("discards an impossible interpreter stage instead of restoring invented language assignments", async () => {
    const f = fixture(), store = await f.open(); await seed(store);
    const key: [string, string] = [store.clientInstanceId, input.conversationId];
    await rawRow(f.indexedDB, f.name, key, row => ({ ...row, participantB: { hasAcceptedConversationSpeech: false } }));
    expect(await store.readForResume(async () => paused())).toBeNull();
  });
});
