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
  it("does not report an empty reload when the identity survived but its row did not", async () => {
    const f = fixture(), store = await f.open();
    store.retainIdentity(input.conversationId);
    await store.dispose();
    const reload = await f.open();
    await expect(reload.inspectReload(async () => paused())).rejects.toThrow("Retained conversation");
    expect(f.tab.getItem("live-translator-retained-conversation-v1")).toBe(input.conversationId);
  });
  it("clears a missing-row pointer after verified End", async () => {
    for (const read of [async () => paused({ status: "ended", resumeExpiresAt: null })]) {
      const f = fixture(), store = await f.open();
      await store.save(input);
      await store.dispose();
      const reload = await f.open();
      expect(await reload.inspectReload(read)).toBeNull();
      expect(reload.hasRetainedIdentity()).toBe(false);
      await reload.dispose();
    }
  });
  it("keeps a retained identity blocked when the owner cookie or server status is unavailable", async () => {
    for (const error of [new AccountingRequestError(401, "identity_required"),
      new AccountingRequestError(403, "forbidden"), new AccountingRequestError(404, "not_found")]) {
      const f = fixture(), store = await f.open(); await seed(store);
      await expect(store.inspectReload(async () => { throw error; })).rejects.toBe(error);
      expect(store.hasRetainedIdentity()).toBe(true);
      await store.dispose();
    }
  });
  it("keeps a corrupt-row pointer when the server cannot confirm termination", async () => {
    const f = fixture(), store = await f.open(); await seed(store);
    await rawRow(f.indexedDB, f.name, [store.clientInstanceId, input.conversationId], row => ({ ...row, schemaVersion: 99 }));
    await expect(store.inspectReload(async () => paused())).rejects.toThrow("Retained conversation snapshot unavailable");
    await expect(store.inspectReload(async () => { throw new AccountingRequestError(503, "unavailable"); })).rejects.toThrow();
    expect(store.hasRetainedIdentity()).toBe(true);
  });
  it("clears a corrupt snapshot row only after matching server End", async () => {
    const f = fixture(), store = await f.open(); await seed(store);
    await rawRow(f.indexedDB, f.name, [store.clientInstanceId, input.conversationId], row => ({ ...row, schemaVersion: 99 }));
    expect(await store.inspectReload(async () => paused({ status: "ended", resumeExpiresAt: null }))).toBeNull();
    expect(store.hasRetainedIdentity()).toBe(false);
  });
  it("keeps a missing-row pointer when server identity or version does not match", async () => {
    const f = fixture(), store = await f.open(); await store.save(input);
    await expect(store.inspectReload(async () => paused({ conversationId: "someone-else", status: "ended" }))).rejects.toThrow();
    await expect(store.inspectReload(async () => paused({ version: 2, status: "ended" }))).rejects.toThrow();
    expect(store.hasRetainedIdentity()).toBe(true);
  });
  it("keeps a saved identity fail closed after a pause ACK cannot be persisted", async () => {
    const f = fixture(), store = await f.open();
    await store.save(input);
    await store.markHidden(input.conversationId, 100_000, 300_000);
    await store.dispose();
    const reload = await f.open();
    expect(reload.clientInstanceId).toBe(store.clientInstanceId);
    await expect(reload.inspectReload(async () => paused())).rejects.toThrow("Retained conversation");
    expect(f.tab.getItem("live-translator-retained-conversation-v1")).toBe(input.conversationId);
  });

  it("releases the document lock on idempotent disposal", async () => {
    const f = fixture(), owner = await f.open();
    await owner.dispose(); await owner.dispose();
    const next = await f.open();
    expect(next.clientInstanceId).toBe(owner.clientInstanceId);
  });
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

  it("uses the hidden timestamp, never the later pause ACK, and blocks the exact TTL boundary", async () => {
    const f = fixture(), store = await f.open(); await seed(store);
    await store.confirmPause(paused({ resumeExpiresAt: 900_000 }));
    f.at(399_999); expect(await store.readForResume(async () => paused({ resumeExpiresAt: 900_000 }))).not.toBeNull();
    f.at(400_000);
    await expect(store.readForResume(async () => paused({ resumeExpiresAt: 900_000 }))).rejects.toThrow();
    expect(f.tab.getItem("live-translator-retained-conversation-v1")).toBe(input.conversationId);
  });

  it("blocks corrupt and unknown-version rows when the server remains active", async () => {
    for (const mutate of [(row: Record<string, unknown>) => ({ ...row, schemaVersion: 99 }),
      (row: Record<string, unknown>) => ({ ...row, contextText: { text: "wrong shape" } })]) {
      const f = fixture(), store = await f.open(); await seed(store);
      const key: [string, string] = [store.clientInstanceId, input.conversationId];
      await rawRow(f.indexedDB, f.name, key, mutate);
      await expect(store.readForResume(async () => paused({ status: "active", resumeExpiresAt: null })))
        .rejects.toThrow("Retained conversation snapshot unavailable");
      expect(f.tab.getItem("live-translator-retained-conversation-v1")).toBe(input.conversationId);
    }
  });

  it("rejects changed-version and mismatched-identity records", async () => {
    for (const read of [
      async () => paused({ version: 4 }),
      async () => paused({ conversationId: "someone-else" }),
      async () => ({ conversationId: input.conversationId, status: "paused", version: 3 } as ConversationMetadata),
    ]) {
      const f = fixture(), store = await f.open(); await seed(store);
      await expect(store.readForResume(read)).rejects.toThrow();
      expect(f.tab.getItem("live-translator-retained-conversation-v1")).toBe(input.conversationId);
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
    await expect(unsupported.readForResume(async () => paused())).rejects.toThrow("ownership unavailable");
    await expect(unsupported.save(input)).rejects.toThrow("storage unavailable");
    expect(unsupported.hasRetainedIdentity()).toBe(true);
    expect(await rawRow(f.indexedDB, f.name, [unsupported.clientInstanceId, input.conversationId])).toBeUndefined();
  });

  it("treats a rejected Web Locks probe as unavailable instead of rotating into a retry loop", async () => {
    const f = fixture(), store = await f.open(f.tab, new RejectOnceLocks());
    expect(store.available).toBe(false);
    await expect(store.save(input)).rejects.toThrow("storage unavailable");
    expect(store.hasRetainedIdentity()).toBe(true);
  });

  it("keeps the first local deadline and rejects a stale pause ACK", async () => {
    const f = fixture(), store = await f.open(); await seed(store);
    await store.markHidden(input.conversationId, 110_000, 300_000);
    await store.confirmPause(paused({ version: 2, resumeExpiresAt: 900_000 }));
    await store.save({ ...input, contextText: "Latest confirmed edit" });
    expect(await store.readForResume(async () => paused())).toMatchObject({ localResumeDeadlineAt: 400_000,
      conversationVersion: 3, contextText: "Latest confirmed edit" });
  });

  it("starts fresh retention after each confirmed resume and fences old completion", async () => {
    const f = fixture(), store = await f.open(); await seed(store);
    const firstAttemptId = crypto.randomUUID();
    await store.rememberResumeAttempt(input.conversationId, firstAttemptId);
    await store.confirmResume(paused({ status: "active", version: 5, resumeExpiresAt: null }), firstAttemptId);
    await store.save({ ...input, conversationVersion: 5 });
    f.at(200_000);
    await store.markHidden(input.conversationId, 200_000, 300_000);
    await store.confirmPause(paused({ version: 6, resumeExpiresAt: 500_000 }));
    expect(await store.readForResume(async () => paused({ version: 6, resumeExpiresAt: 500_000 })))
      .toMatchObject({ conversationVersion: 6, localResumeDeadlineAt: 500_000 });

    const secondAttemptId = crypto.randomUUID();
    await store.rememberResumeAttempt(input.conversationId, secondAttemptId);
    await store.confirmResume(paused({ status: "active", version: 8, resumeExpiresAt: null }), secondAttemptId);
    await store.save({ ...input, conversationVersion: 8 });
    f.at(300_000);
    await store.markHidden(input.conversationId, 300_000, 300_000);
    await store.confirmPause(paused({ version: 9, resumeExpiresAt: 600_000 }));
    await store.confirmResume(paused({ status: "active", version: 5, resumeExpiresAt: null }), firstAttemptId);
    expect(await store.readForResume(async () => paused({ version: 9, resumeExpiresAt: 600_000 })))
      .toMatchObject({ conversationVersion: 9, localResumeDeadlineAt: 600_000, serverResumeExpiresAt: 600_000 });
  });

  it("preserves its pointer and snapshot when conversation GET is unverified", async () => {
    for (const error of [new Error("timeout"), new AccountingRequestError(503, "unavailable")]) {
      const f = fixture(), store = await f.open(); await seed(store);
      const key: [string, string] = [store.clientInstanceId, input.conversationId];
      await expect(store.inspectReload(async () => { throw error; })).rejects.toBe(error);
      await expect(store.readForResume(async () => { throw error; })).rejects.toBe(error);
      expect(f.tab.getItem("live-translator-retained-conversation-v1")).toBe(input.conversationId);
      expect(await rawRow(f.indexedDB, f.name, key)).toBeDefined();
      expect(await store.inspectReload(async () => paused())).toMatchObject({ kind: "paused" });
    }
  });

  it("retains an active reload's ID and current version for an explicit user choice", async () => {
    const f = fixture(), store = await f.open(); await seed(store);
    f.at(400_000);
    const active = paused({ status: "active", version: 5, resumeExpiresAt: null, resumeAttemptId: null });
    expect(await store.inspectReload(async () => active)).toEqual({
      kind: "active", conversationId: input.conversationId, conversationVersion: 5,
    });
    expect(f.tab.getItem("live-translator-retained-conversation-v1")).toBe(input.conversationId);
    expect(await rawRow(f.indexedDB, f.name, [store.clientInstanceId, input.conversationId])).toBeDefined();
    expect(await store.readForResume(async () => active)).toBeNull();

    const fresh = fixture(), unpaused = await fresh.open();
    await unpaused.save(input);
    expect(await unpaused.inspectReload(async () => paused({ status: "active", resumeExpiresAt: null })))
      .toEqual({ kind: "active", conversationId: input.conversationId, conversationVersion: 3 });
  });

  it("clears the retained identity only after the server confirms End", async () => {
    const f = fixture(), store = await f.open(); await seed(store);
    expect(await store.inspectReload(async () => paused({ status: "ended", resumeExpiresAt: null }))).toBeNull();
    expect(f.tab.getItem("live-translator-retained-conversation-v1")).toBeNull();
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
  it("keeps an uncertain abort tied to the same claim after the server returns to paused", async () => {
    const f = fixture(), store = await f.open(); await seed(store);
    const id = crypto.randomUUID();
    await store.rememberResumeAttempt(input.conversationId, id);
    const server = paused({ version: 5, status: "paused", resumeAttemptId: null });
    expect(await store.inspectReload(async () => server)).toMatchObject({ kind: "pending", snapshot: { resumeAttemptId: id } });
    expect(await store.readForResume(async () => server)).toBeNull();
  });

  it("blocks an impossible interpreter stage instead of restoring invented language assignments", async () => {
    const f = fixture(), store = await f.open(); await seed(store);
    const key: [string, string] = [store.clientInstanceId, input.conversationId];
    await rawRow(f.indexedDB, f.name, key, row => ({ ...row, participantB: { hasAcceptedConversationSpeech: false } }));
    await expect(store.readForResume(async () => paused())).rejects.toThrow("Retained conversation snapshot unavailable");
  });
});
