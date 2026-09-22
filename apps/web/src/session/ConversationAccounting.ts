import { AccountingBackend, AccountingRequestError, type LedgerApi, type ConversationMetadata } from "../api/AccountingBackend";
import { BackendClient, type CreateLiveSessionResponse } from "../api/BackendClient";
import { CleanupIntentOutbox } from "./CleanupIntentOutbox";
import { MetadataDeliveryBudget, type CleanupReason } from "./MetadataDeliveryBudget";
import type { LiveCloseResult } from "../live/LiveClient";

const DEFINITIVE_NO_PROVIDER_CODES = new Set([
  "new_creations_paused", "client_upgrade_required", "invalid_request", "unexpected_origin",
  "identity_required", "not_found", "provider_key_missing", "server_shutting_down_before_dispatch",
  "concurrent_session_limit", "conversation_expired", "conversation_version_conflict",
  "attempt_in_progress", "attempt_conflict", "invalid_start_reason",
  "attempt_not_dispatchable", "conversation_not_activatable", "attempt_cancelled",
]);
function isDefinitiveNoProviderError(error: unknown): boolean {
  if (!(error instanceof AccountingRequestError)) return false;
  return [400, 401, 403, 404, 410, 429].includes(error.status) || DEFINITIVE_NO_PROVIDER_CODES.has(error.code);
}

/** One product controller owns this scope; provider attempts keep immutable local IDs. */
export class ConversationAccounting {
  readonly api: LedgerApi;
  readonly budget: MetadataDeliveryBudget;
  readonly outbox: CleanupIntentOutbox;
  private enabled: Promise<boolean> | undefined;
  private creating: Promise<ConversationMetadata> | undefined;
  private current: ConversationMetadata | undefined;
  private last: ProviderAccounting | undefined;
  private readonly previousDispatch = new WeakMap<ProviderAccounting, ProviderAccounting | undefined>();
  private attempts = new Set<ProviderAccounting>();
  private epoch = 0;
  private dispatchCount = 0;
  private requestId = crypto.randomUUID();
  private readonly autoDelivery: boolean;
  private readonly producerId = crypto.randomUUID();
  private producerLock: Promise<void> | undefined;
  constructor(options: { api?: LedgerApi; budget?: MetadataDeliveryBudget; autoDelivery?: boolean } = {}) {
    this.api = options.api ?? new AccountingBackend();
    this.budget = options.budget ?? new MetadataDeliveryBudget({ producerId: this.producerId });
    this.outbox = new CleanupIntentOutbox(this.budget, this.api); this.autoDelivery = options.autoDelivery ?? true;
  }
  get revision() { return this.epoch; }
  get conversationId(): string | null { return this.current?.conversationId ?? null; }
  newAttempt(): ProviderAccounting {
    const attempt = new ProviderAccounting(this, this.epoch); this.attempts.add(attempt); return attempt;
  }
  isCurrent(epoch: number) { return epoch === this.epoch; }
  private async holdProducerLock(): Promise<void> {
    if (this.producerLock || !globalThis.navigator?.locks) return this.producerLock;
    this.producerLock = new Promise((resolve, reject) => {
      void navigator.locks.request(`live-metadata-producer:${this.producerId}`, { ifAvailable: true }, lock => {
        if (!lock) { reject(new Error("Metadata producer ownership unavailable")); return; }
        resolve(); return new Promise<void>(() => {});
      }).catch(reject);
    });
    await this.producerLock;
    const producers = new Set((await this.budget.entries()).map(e => e.producerId));
    for (const id of producers) {
      if (id === this.producerId) continue;
      await navigator.locks.request(`live-metadata-producer:${id}`, { ifAvailable: true }, async lock => {
        if (!lock) return; // Never take over a live/frozen producer in another tab.
        await this.budget.reclaimUndispatched(id);
        for (const row of await this.budget.entries()) {
          if (row.producerId === id && row.dispatchStartedAt !== null && !row.producerFinalized && !row.cleanup && !row.closeObservation) {
            await this.outbox.enqueue(row.localId, "response_not_received");
          }
        }
      });
    }
  }
  async prepare(attempt: ProviderAccounting): Promise<ConversationMetadata | null> {
    this.enabled ??= this.api.policy().then(p => {
      if (p.creationPaused) throw new Error("New sessions are temporarily paused");
      if (typeof p.usageLedgerEnabled !== "boolean") throw new Error("Invalid accounting policy");
      return p.usageLedgerEnabled;
    }).catch(error => { this.enabled = undefined; throw error; });
    if (!await this.enabled) return null;
    attempt.managed = true; attempt.assertCurrent();
    await this.holdProducerLock();
    this.creating ??= this.api.createConversation(this.requestId).catch(error => { this.creating = undefined; throw error; });
    const c = await this.creating; attempt.assertCurrent(); this.current = c;
    if (this.autoDelivery) this.outbox.start();
    await this.outbox.flush(); attempt.assertCurrent();
    if ((await this.budget.entries()).some(row => row.conversationId === c.conversationId && (row.cleanup || row.closeObservation))) throw new Error("Previous session cleanup delivery is pending");
    if (this.last && this.last !== attempt && this.last.dispatched) {
      const deadline = performance.now() + c.policy.sessionCloseTimeoutMs;
      for (;;) {
        const previous = await this.api.readAttempt(this.last.localId);
        if (!["creating", "active", "closing"].includes(previous.state ?? "unknown")) break;
        if (performance.now() >= deadline) throw new Error("Previous provider cleanup is still pending");
        await new Promise(r => setTimeout(r, 200)); attempt.assertCurrent();
      }
    }
    return c;
  }
  noteDispatch(attempt: ProviderAccounting): "initial" | "bootstrap_replacement" {
    this.previousDispatch.set(attempt, this.last);
    this.last = attempt;
    return this.dispatchCount++ === 0 ? "initial" : "bootstrap_replacement";
  }
  noteNoProvider(attempt: ProviderAccounting): void {
    const previous = this.previousDispatch.get(attempt);
    if (!this.previousDispatch.delete(attempt)) return;
    this.dispatchCount = Math.max(0, this.dispatchCount - 1);
    if (this.last === attempt) this.last = previous;
  }
  async end(reason: "user_end" | "setup_cancel", expectedEpoch = this.epoch): Promise<void> {
    if (expectedEpoch !== this.epoch) return; // A late duplicate End must not terminate a newer product scope.
    const ending = [...this.attempts], current = this.current, creating = this.creating;
    this.epoch++; this.current = undefined; this.creating = undefined; this.last = undefined;
    this.dispatchCount = 0; this.requestId = crypto.randomUUID(); this.attempts = new Set();
    await Promise.all(ending.map(a => a.finished ? Promise.resolve() : a.abandon(reason === "setup_cancel" ? "cancelled" : "user_end")));
    const c = current ?? await creating?.catch(() => undefined);
    if (c) {
      try {
        // Cleanup intent is committed locally before queuing the version-checked product End.
        await this.outbox.enqueueEnd(c.conversationId, c.version, reason);
        void this.outbox.flush().catch(() => console.error("Conversation end delivery pending"));
      } catch {
        console.error("Conversation end storage degraded", { conversationId: c.conversationId });
        void this.api.end(c.conversationId, c.version, reason).catch(() => undefined);
      }
    }
  }
}
export class ProviderAccounting {
  readonly localId = crypto.randomUUID();
  managed = false;
  dispatched = false;
  finished = false;
  private cancelled = false;
  private reservation: Promise<void> | undefined;
  private hasReservation = false;
  private controller: AbortController | undefined;
  private conversation: ConversationMetadata | undefined;
  private finishing: Promise<void> | undefined;
  constructor(private readonly scope: ConversationAccounting, private readonly epoch: number) {}
  assertCurrent(): void {
    if (this.cancelled || !this.scope.isCurrent(this.epoch) || (typeof document !== "undefined" && document.visibilityState === "hidden" && this.managed)) throw new Error("Provider attempt cancelled");
  }
  async create(sdp: string, beforeManagedCreate?: () => void): Promise<CreateLiveSessionResponse> {
    const c = await this.scope.prepare(this); this.assertCurrent();
    if (!c) return new BackendClient().createLiveSession(sdp);
    this.conversation = c; beforeManagedCreate?.();
    this.reservation = this.scope.budget.reserve(this.localId, c.conversationId);
    await this.reservation; this.hasReservation = true;
    try {
      this.assertCurrent(); await this.scope.budget.markDispatchStarted(this.localId); this.assertCurrent();
      this.controller = new AbortController(); this.dispatched = true;
      return await this.scope.api.createSession({ sdp, liveSessionId: this.localId, conversationId: c.conversationId,
        conversationVersion: c.version, initialMode: "setup", startReason: this.scope.noteDispatch(this) }, this.controller.signal);
    } catch (error) {
      if (isDefinitiveNoProviderError(error)) {
        this.cancelled = true;
        await this.scope.budget.finishProducerAndRelease(this.localId, "no_provider");
        this.scope.noteNoProvider(this);
        this.finished = true;
      } else {
        await this.abandon("response_not_received");
      }
      throw error;
    }
  }
  async handoff(): Promise<void> {
    if (!this.managed) return; this.assertCurrent();
    let receipt;
    try { receipt = await this.scope.api.handoff(this.localId); }
    catch { receipt = await this.scope.api.readAttempt(this.localId); }
    this.assertCurrent();
    if (receipt.state !== "active" || receipt.handoffAcknowledgedAt == null || receipt.cleanupRequestedAt != null || receipt.conversation.status !== "active" ||
        receipt.conversation.version !== this.conversation?.version || (receipt.conversation.productDeadlineAt !== null && receipt.conversation.serverTime >= receipt.conversation.productDeadlineAt)) throw new Error("Provider handoff was not confirmed");
  }
  async abandon(reason: CleanupReason): Promise<void> {
    this.cancelled = true;
    if (this.finished) return this.finishing;
    if (this.reservation && !this.hasReservation) { try { await this.reservation; this.hasReservation = true; } catch { return; } }
    if (!this.hasReservation) return;
    if (this.finishing) return this.finishing;
    const operation = (async () => {
      try {
        if (this.dispatched) { await this.scope.outbox.enqueue(this.localId, reason); this.controller?.abort(); }
        else { await this.scope.budget.finishProducerAndRelease(this.localId, "no_provider"); }
        this.finished = true;
      } catch (error) {
        // Existing-session storage failure cannot keep audio alive. This is an explicitly degraded path.
        console.error("Existing session cleanup storage degraded", { localId: this.localId }); this.controller?.abort();
        if (!this.dispatched) throw error;
        await this.scope.api.cleanup(this.localId, reason);
        this.finished = true;
      }
    })();
    this.finishing = operation;
    try { await operation; }
    catch (error) { if (this.finishing === operation) this.finishing = undefined; throw error; }
  }
  async finish(result: LiveCloseResult): Promise<void> {
    if (!this.managed) { this.cancelled = true; return; }
    if (!result.finalized) return this.abandon("primary_startup_failed");
    if (!this.hasReservation || this.finished) return this.finishing;
    const observation = {
      ...(typeof result.usageSeconds === "number" && Number.isFinite(result.usageSeconds) && result.usageSeconds >= 0 ? { seconds: result.usageSeconds } : {}),
      ...(result.reason && result.reason.length <= 256 ? { reason: result.reason } : {}),
    };
    if (this.finishing) return this.finishing;
    const operation = (async () => {
      try {
        await this.scope.outbox.observeClosed(this.localId, observation);
      } catch {
        console.error("Provider close metadata storage degraded", { localId: this.localId });
        await this.scope.api.closed(this.localId, observation);
        try { await this.scope.budget.finishProducerAndRelease(this.localId, "provider_closed"); }
        catch { console.error("Provider close envelope release degraded", { localId: this.localId }); }
      }
      this.finished = true;
    })();
    this.finishing = operation;
    try { await operation; }
    catch (error) { if (this.finishing === operation) this.finishing = undefined; throw error; }
  }
}
