import type { ConversationMetadata } from "../api/AccountingBackend";
import { APPEND_CHAR_BUDGET, assertAppendWithinBudget } from "../live/LiveEvents";
import { buildAuthoritativeContext } from "../live/LivePrompts";
import { COUNTER_NAMES, type MetricCounters } from "../metrics/UsageTypes";

const TAB_KEY = "live-translator-client-instance-v1";
const CONVERSATION_KEY = "live-translator-retained-conversation-v1";
const CONVERSATION_VERSION_KEY = "live-translator-retained-conversation-version-v1";
const PENDING_CREATE = "pending-create";
const PROMPT_VERSION = "fixed-language-interpreter-v1";
const ID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

export interface ResumeSnapshotInput {
  conversationId: string;
  conversationVersion: number;
  policyVersion: string;
  participantA: { language?: string; hasAcceptedConversationSpeech: boolean };
  participantB: { language?: string; hasAcceptedConversationSpeech: boolean };
  contextText: string;
  setupStage: "context" | "bootstrap" | "interpreter";
  enteredInterpreter: boolean;
  interruptedUtterance: boolean;
  productDeadlineAt: number | null;
  counters: MetricCounters;
}

export interface ResumeSnapshot extends ResumeSnapshotInput {
  schemaVersion: 1;
  promptVersion: string;
  clientInstanceId: string;
  localResumeDeadlineAt: number | null;
  serverResumeExpiresAt: number | null;
  resumeAttemptId: string | null;
}

export interface ResumeSnapshotOptions {
  indexedDB?: IDBFactory | null;
  sessionStorage?: Storage;
  locks?: LockManager | null;
  name?: string;
  now?: () => number;
}

export type ReloadInspection =
  | { kind: "paused" | "pending"; snapshot: ResumeSnapshot; conversation: ConversationMetadata }
  | { kind: "active"; conversationId: string; conversationVersion: number };

function timestamp(value: unknown): value is number {
  return typeof value === "number" && Number.isSafeInteger(value) && value > 0;
}

function record(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === "object" && !Array.isArray(value);
}

function only(value: Record<string, unknown>, keys: readonly string[]): boolean {
  return Object.keys(value).every(key => keys.includes(key));
}

function validParticipant(value: unknown): boolean {
  return record(value) && only(value, ["language", "hasAcceptedConversationSpeech"]) &&
    (value.language === undefined || (typeof value.language === "string" && value.language.length > 0 && value.language.length <= 32)) &&
    typeof value.hasAcceptedConversationSpeech === "boolean";
}

function validSnapshot(value: unknown, clientInstanceId: string, conversationId: string): value is ResumeSnapshot {
  if (!record(value) || !only(value, ["schemaVersion", "promptVersion", "clientInstanceId", "conversationId",
    "conversationVersion", "policyVersion", "participantA", "participantB", "contextText", "setupStage",
    "enteredInterpreter", "interruptedUtterance", "productDeadlineAt", "counters", "localResumeDeadlineAt",
    "serverResumeExpiresAt", "resumeAttemptId"])) return false;
  if (value.schemaVersion !== 1 || value.promptVersion !== PROMPT_VERSION || value.clientInstanceId !== clientInstanceId ||
    value.conversationId !== conversationId || !conversationId || conversationId.length > 128 ||
    !Number.isSafeInteger(value.conversationVersion) || (value.conversationVersion as number) < 1 ||
    typeof value.policyVersion !== "string" || !value.policyVersion || value.policyVersion.length > 128 ||
    !validParticipant(value.participantA) || !validParticipant(value.participantB) || typeof value.contextText !== "string" ||
    value.contextText.length > APPEND_CHAR_BUDGET ||
    !["context", "bootstrap", "interpreter"].includes(value.setupStage as string) ||
    typeof value.enteredInterpreter !== "boolean" || typeof value.interruptedUtterance !== "boolean" ||
    (value.productDeadlineAt !== null && !timestamp(value.productDeadlineAt)) ||
    (value.localResumeDeadlineAt !== null && !timestamp(value.localResumeDeadlineAt)) ||
    (value.serverResumeExpiresAt !== null && !timestamp(value.serverResumeExpiresAt)) ||
    (value.resumeAttemptId !== null && (typeof value.resumeAttemptId !== "string" || !ID.test(value.resumeAttemptId))) ||
    !record(value.counters) || !only(value.counters, COUNTER_NAMES) ||
    !Object.values(value.counters).every(count => Number.isSafeInteger(count) && (count as number) >= 0)) return false;
  if (value.setupStage === "interpreter" && (!value.enteredInterpreter ||
    !(value.participantA as Record<string, unknown>).language || !(value.participantB as Record<string, unknown>).language ||
    (value.participantA as Record<string, unknown>).language === (value.participantB as Record<string, unknown>).language)) return false;
  if (value.setupStage !== "interpreter" && value.enteredInterpreter) return false;
  try {
    if (value.contextText.trim()) assertAppendWithinBudget(buildAuthoritativeContext(value.contextText.trim()));
  } catch { return false; }
  return true;
}

export class ResumeSnapshotStore {
  private databasePromise: Promise<IDBDatabase> | undefined;
  private owned = false;
  private releaseLock: (() => void) | undefined;
  private lockLifetime: Promise<unknown> | undefined;
  get available(): boolean { return this.owned && this.storage !== null && this.factory !== null; }
  private constructor(readonly clientInstanceId: string, private readonly storage: Storage | null,
    private readonly factory: IDBFactory | null, private readonly name: string, private readonly now: () => number) {}

  static async open(options: ResumeSnapshotOptions = {}): Promise<ResumeSnapshotStore> {
    const storage = options.sessionStorage ?? globalThis.sessionStorage ?? null;
    const locks = options.locks === undefined ? globalThis.navigator?.locks ?? null : options.locks;
    const existing = storage?.getItem(TAB_KEY);
    let id = existing && ID.test(existing) ? existing : crypto.randomUUID();
    const store = new ResumeSnapshotStore(id, storage, options.indexedDB === undefined ? globalThis.indexedDB ?? null : options.indexedDB,
      options.name ?? "live-translator-resume-v1", options.now ?? Date.now);
    const disabled = () => {
      id = crypto.randomUUID();
      storage?.setItem(TAB_KEY, id);
      return new ResumeSnapshotStore(id, storage, store.factory, store.name, store.now);
    };
    if (!locks) return disabled();
    let collided = false;
    while (true) {
      let releaseLock: (() => void) | undefined;
      let lockLifetime: Promise<unknown> | undefined;
      const acquired = await new Promise<boolean | null>(resolve => {
        try {
          lockLifetime = locks.request(`client-instance:${id}`, { mode: "exclusive", ifAvailable: true }, lock => {
            if (!lock) { resolve(false); return; }
            const lifetime = new Promise<void>(release => { releaseLock = release; });
            resolve(true);
            return lifetime;
          });
          void lockLifetime.catch(() => resolve(null));
        } catch { resolve(null); }
      });
      if (acquired === null) return disabled();
      if (acquired) {
        store.releaseLock = releaseLock;
        store.lockLifetime = lockLifetime;
        break;
      }
      collided = true;
      id = crypto.randomUUID();
    }
    try {
      if (collided || existing !== id) {
        storage?.removeItem(CONVERSATION_KEY);
        storage?.removeItem(CONVERSATION_VERSION_KEY);
      }
      storage?.setItem(TAB_KEY, id);
    } catch (error) {
      store.releaseLock?.();
      await store.lockLifetime?.catch(() => undefined);
      throw error;
    }
    const owner = new ResumeSnapshotStore(id, storage, store.factory, store.name, store.now);
    owner.owned = true;
    owner.releaseLock = store.releaseLock;
    owner.lockLifetime = store.lockLifetime;
    return owner;
  }

  hasRetainedIdentity(): boolean {
    if (!this.storage) throw new Error("Retained conversation storage unavailable");
    return this.storage.getItem(CONVERSATION_KEY) !== null;
  }

  hasPendingCreate(): boolean {
    if (!this.storage) throw new Error("Retained conversation storage unavailable");
    return this.storage.getItem(CONVERSATION_KEY) === PENDING_CREATE;
  }

  retainedConversationId(): string | null {
    if (!this.storage) throw new Error("Retained conversation storage unavailable");
    const id = this.storage.getItem(CONVERSATION_KEY);
    return id && id !== PENDING_CREATE ? id : null;
  }

  retainedConversationVersion(): number {
    if (!this.storage) throw new Error("Retained conversation storage unavailable");
    const version = Number(this.storage.getItem(CONVERSATION_VERSION_KEY));
    return Number.isSafeInteger(version) && version > 0 ? version : 0;
  }

  retainIdentity(conversationId: string, version?: number): void {
    if (!this.storage) throw new Error("Retained conversation storage unavailable");
    const previous = this.storage.getItem(CONVERSATION_KEY);
    this.storage.setItem(CONVERSATION_KEY, conversationId);
    if (Number.isSafeInteger(version) && version! > 0) {
      const old = previous === conversationId ? Number(this.storage.getItem(CONVERSATION_VERSION_KEY)) : 0;
      this.storage.setItem(CONVERSATION_VERSION_KEY, String(Math.max(version!, old)));
    } else if (previous !== conversationId) this.storage.removeItem(CONVERSATION_VERSION_KEY);
  }

  retainPendingCreate(): void {
    if (!this.storage) throw new Error("Retained conversation storage unavailable");
    this.storage.setItem(CONVERSATION_KEY, PENDING_CREATE);
    this.storage.removeItem(CONVERSATION_VERSION_KEY);
  }

  async dispose(): Promise<void> {
    if (!this.owned) return;
    this.owned = false;
    this.releaseLock?.();
    this.releaseLock = undefined;
    await this.lockLifetime?.catch(() => undefined);
    void this.databasePromise?.then(db => db.close(), () => undefined);
  }

  private database(): Promise<IDBDatabase> {
    if (!this.owned || !this.factory) throw new Error("Retained conversation storage unavailable");
    this.databasePromise ??= new Promise<IDBDatabase>((resolve, reject) => {
      const request = this.factory!.open(this.name, 1);
      request.onupgradeneeded = () => request.result.createObjectStore("snapshots", { keyPath: ["clientInstanceId", "conversationId"] });
      request.onsuccess = () => {
        const db = request.result;
        db.onversionchange = () => db.close();
        resolve(db);
      };
      request.onerror = request.onblocked = () => reject(request.error ?? new Error("Retained conversation storage unavailable"));
    }).catch(error => { this.databasePromise = undefined; throw error; });
    return this.databasePromise;
  }

  private async transaction<T>(mode: IDBTransactionMode, work: (store: IDBObjectStore, done: (value: T) => void,
    fail: (error: Error) => void) => void): Promise<T> {
    const db = await this.database();
    return new Promise((resolve, reject) => {
      const tx = db.transaction("snapshots", mode);
      let value: T;
      tx.oncomplete = () => resolve(value);
      tx.onerror = tx.onabort = () => reject(tx.error ?? new Error("Retained conversation transaction failed"));
      const fail = (error: Error) => { tx.abort(); reject(error); };
      try { work(tx.objectStore("snapshots"), result => { value = result; }, fail); }
      catch (error) { fail(error instanceof Error ? error : new Error("Retained conversation transaction failed")); }
    });
  }

  private get(conversationId: string): Promise<unknown> {
    return this.transaction("readonly", (store, done) => {
      const request = store.get([this.clientInstanceId, conversationId]);
      request.onsuccess = () => done(request.result);
    });
  }

  async save(input: ResumeSnapshotInput): Promise<void> {
    if (!this.storage) throw new Error("Retained conversation storage unavailable");
    const previous = this.storage.getItem(CONVERSATION_KEY);
    this.retainIdentity(input.conversationId, input.conversationVersion);
    if (!this.available) throw new Error("Retained conversation storage unavailable");
    const counters: MetricCounters = {};
    for (const name of COUNTER_NAMES) if (name in input.counters) counters[name] = input.counters[name];
    const base: ResumeSnapshot = {
      schemaVersion: 1, promptVersion: PROMPT_VERSION, clientInstanceId: this.clientInstanceId,
      conversationId: input.conversationId, conversationVersion: input.conversationVersion, policyVersion: input.policyVersion,
      participantA: { ...(input.participantA.language === undefined ? {} : { language: input.participantA.language }),
        hasAcceptedConversationSpeech: input.participantA.hasAcceptedConversationSpeech },
      participantB: { ...(input.participantB.language === undefined ? {} : { language: input.participantB.language }),
        hasAcceptedConversationSpeech: input.participantB.hasAcceptedConversationSpeech },
      contextText: input.contextText, setupStage: input.setupStage, enteredInterpreter: input.enteredInterpreter,
      interruptedUtterance: input.interruptedUtterance, productDeadlineAt: input.productDeadlineAt, counters,
      localResumeDeadlineAt: null, serverResumeExpiresAt: null, resumeAttemptId: null,
    };
    if (!validSnapshot(base, this.clientInstanceId, input.conversationId)) throw new Error("Invalid retained conversation snapshot");
    await this.transaction("readwrite", (store, done) => {
      if (previous && previous !== input.conversationId) store.delete([this.clientInstanceId, previous]);
      const request = store.get([this.clientInstanceId, input.conversationId]);
      request.onsuccess = () => {
        const old = validSnapshot(request.result, this.clientInstanceId, input.conversationId) &&
          request.result.policyVersion === base.policyVersion ? request.result : null;
        store.put({ ...base, conversationVersion: Math.max(base.conversationVersion, old?.conversationVersion ?? 0),
          productDeadlineAt: old?.productDeadlineAt ?? base.productDeadlineAt,
          localResumeDeadlineAt: old?.localResumeDeadlineAt ?? null,
          serverResumeExpiresAt: old?.serverResumeExpiresAt ?? null,
          resumeAttemptId: old?.resumeAttemptId ?? null });
        done(undefined);
      };
    });
  }

  async markHidden(conversationId: string, at: number, retentionMs: number): Promise<void> {
    if (!timestamp(at) || !timestamp(retentionMs) || !timestamp(at + retentionMs)) throw new Error("Invalid retention deadline");
    await this.update(conversationId, row => ({ ...row,
      localResumeDeadlineAt: Math.min(row.localResumeDeadlineAt ?? Infinity, at + retentionMs) }));
  }

  async confirmPause(conversation: ConversationMetadata): Promise<void> {
    if (conversation.status !== "paused" || !timestamp(conversation.resumeExpiresAt)) return;
    await this.update(conversation.conversationId, row => {
      if (conversation.version < row.conversationVersion || conversation.policy.policyVersion !== row.policyVersion) return row;
      return { ...row, conversationVersion: conversation.version, serverResumeExpiresAt: conversation.resumeExpiresAt,
        productDeadlineAt: conversation.productDeadlineAt };
    });
    if (this.storage?.getItem(CONVERSATION_KEY) === conversation.conversationId)
      this.retainIdentity(conversation.conversationId, conversation.version);
  }

  async confirmResume(conversation: ConversationMetadata, attemptId: string): Promise<void> {
    if (conversation.status !== "active" || conversation.resumeExpiresAt !== null || conversation.resumeAttemptId !== null) return;
    await this.update(conversation.conversationId, row => {
      if (row.resumeAttemptId !== attemptId || conversation.version <= row.conversationVersion ||
        conversation.policy.policyVersion !== row.policyVersion) return row;
      return { ...row, conversationVersion: conversation.version, productDeadlineAt: conversation.productDeadlineAt,
        localResumeDeadlineAt: null, serverResumeExpiresAt: null, resumeAttemptId: null };
    });
    if (this.storage?.getItem(CONVERSATION_KEY) === conversation.conversationId)
      this.retainIdentity(conversation.conversationId, conversation.version);
  }

  async rememberResumeAttempt(conversationId: string, attemptId: string): Promise<void> {
    if (!ID.test(attemptId) || !this.owned || this.storage?.getItem(CONVERSATION_KEY) !== conversationId)
      throw new Error("Retained conversation ownership unavailable");
    await this.transaction("readwrite", (store, done, fail) => {
      const request = store.get([this.clientInstanceId, conversationId]);
      request.onsuccess = () => {
        const row = request.result;
        if (!validSnapshot(row, this.clientInstanceId, conversationId) || row.localResumeDeadlineAt === null ||
          row.serverResumeExpiresAt === null || this.now() >= row.localResumeDeadlineAt ||
          this.now() >= row.serverResumeExpiresAt || (row.productDeadlineAt !== null && this.now() >= row.productDeadlineAt) ||
          (row.resumeAttemptId !== null && row.resumeAttemptId !== attemptId)) {
          fail(new Error("Retained conversation is not eligible for this resume attempt")); return;
        }
        store.put({ ...row, resumeAttemptId: attemptId }); done(undefined);
      };
    });
  }

  async clearResumeAttempt(conversationId: string, attemptId: string): Promise<void> {
    await this.update(conversationId, row => row.resumeAttemptId === attemptId ? { ...row, resumeAttemptId: null } : row);
  }

  private async update(conversationId: string, change: (row: ResumeSnapshot) => ResumeSnapshot): Promise<void> {
    if (!this.owned || this.storage?.getItem(CONVERSATION_KEY) !== conversationId) return;
    await this.transaction("readwrite", (store, done) => {
      const request = store.get([this.clientInstanceId, conversationId]);
      request.onsuccess = () => {
        if (!validSnapshot(request.result, this.clientInstanceId, conversationId)) { done(undefined); return; }
        const next = change(request.result);
        if (!validSnapshot(next, this.clientInstanceId, conversationId)) { done(undefined); return; }
        store.put(next); done(undefined);
      };
    });
  }

  async inspectReload(read: (id: string) => Promise<ConversationMetadata>): Promise<ReloadInspection | null> {
    if (!this.owned) {
      if (this.hasRetainedIdentity()) throw new Error("Retained conversation ownership unavailable");
      return null;
    }
    const conversationId = this.storage?.getItem(CONVERSATION_KEY);
    if (!conversationId) return null;
    if (conversationId === PENDING_CREATE) throw new Error("Retained conversation create remains unresolved");
    let row = await this.get(conversationId);
    let purged = false;
    const purgeExpired = async () => {
      if (purged || !validSnapshot(row, this.clientInstanceId, conversationId) ||
        !(row.localResumeDeadlineAt !== null && this.now() >= row.localResumeDeadlineAt ||
          row.serverResumeExpiresAt !== null && this.now() >= row.serverResumeExpiresAt ||
          row.productDeadlineAt !== null && this.now() >= row.productDeadlineAt)) return;
      await this.transaction("readwrite", (store, done) => {
        store.delete([this.clientInstanceId, conversationId]); done(undefined);
      });
      purged = true;
    };
    await purgeExpired();
    const server = await read(conversationId).finally(purgeExpired);
    const retainedVersion = Number(this.storage?.getItem(CONVERSATION_VERSION_KEY));
    if (record(server) && server.conversationId === conversationId && server.status === "ended" &&
      Number.isSafeInteger(server.version) && server.version >= Math.max(1, retainedVersion,
        validSnapshot(row, this.clientInstanceId, conversationId) ? row.conversationVersion : 0) &&
      timestamp(server.serverTime)) {
      await this.discard(conversationId); return null;
    }
    if (!validSnapshot(row, this.clientInstanceId, conversationId))
      throw new Error("Retained conversation snapshot unavailable");
    if (!record(server) || server.conversationId !== conversationId || !Number.isSafeInteger(server.version) ||
      server.version < row.conversationVersion || !record(server.policy) ||
      server.policy.policyVersion !== row.policyVersion || !timestamp(server.serverTime)) {
      throw new Error("Retained conversation status unavailable");
    }
    if (server.status === "active") {
      this.retainIdentity(conversationId, server.version);
      return { kind: "active", conversationId, conversationVersion: server.version };
    }
    if (server.status === "paused" && row.serverResumeExpiresAt === null) {
      if (row.resumeAttemptId !== null || row.localResumeDeadlineAt === null ||
        this.now() >= row.localResumeDeadlineAt || server.version !== row.conversationVersion + 1 ||
        server.resumeAttemptId !== null || !timestamp(server.resumeExpiresAt) ||
        this.now() >= server.resumeExpiresAt || server.serverTime >= server.resumeExpiresAt ||
        server.productDeadlineAt !== row.productDeadlineAt ||
        (row.productDeadlineAt !== null && (this.now() >= row.productDeadlineAt || server.serverTime >= row.productDeadlineAt)))
        throw new Error("Retained conversation pause snapshot unavailable");
      await this.confirmPause(server);
      row = await this.get(conversationId);
      if (!validSnapshot(row, this.clientInstanceId, conversationId))
        throw new Error("Retained conversation pause snapshot unavailable");
    }
    if (row.localResumeDeadlineAt === null || row.serverResumeExpiresAt === null ||
      this.now() >= row.localResumeDeadlineAt || this.now() >= row.serverResumeExpiresAt ||
      (row.productDeadlineAt !== null && this.now() >= row.productDeadlineAt) ||
      !timestamp(server.resumeExpiresAt) ||
      server.resumeExpiresAt !== row.serverResumeExpiresAt || server.productDeadlineAt !== row.productDeadlineAt ||
      this.now() >= server.resumeExpiresAt || server.serverTime >= server.resumeExpiresAt ||
      (server.productDeadlineAt !== null && (this.now() >= server.productDeadlineAt || server.serverTime >= server.productDeadlineAt))) {
      throw new Error("Retained conversation is not eligible for automatic resume");
    }
    if (server.status === "paused" && server.version === row.conversationVersion) {
      return { kind: "paused", snapshot: row, conversation: server };
    }
    if (server.status === "resuming" && row.resumeAttemptId !== null &&
      server.resumeAttemptId === row.resumeAttemptId && server.version === row.conversationVersion + 1) {
      return { kind: "pending", snapshot: row, conversation: server };
    }
    if (server.status === "paused" && row.resumeAttemptId !== null && server.resumeAttemptId === null &&
      server.version === row.conversationVersion + 2) {
      return { kind: "pending", snapshot: row, conversation: server };
    }
    throw new Error("Retained conversation status requires explicit recovery");
  }

  async readForResume(read: (id: string) => Promise<ConversationMetadata>): Promise<ResumeSnapshot | null> {
    const result = await this.inspectReload(read);
    return result?.kind === "paused" ? result.snapshot : null;
  }

  async discard(conversationId: string): Promise<void> {
    if (this.owned) await this.transaction("readwrite", (store, done) => {
      store.delete([this.clientInstanceId, conversationId]); done(undefined);
    });
    if (this.storage?.getItem(CONVERSATION_KEY) === conversationId) {
      this.storage.removeItem(CONVERSATION_KEY);
      this.storage.removeItem(CONVERSATION_VERSION_KEY);
    }
  }
}
