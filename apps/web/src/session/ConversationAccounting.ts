import { UsageReporter, type ProductObservation } from "../metrics/UsageReporter";
import { UsageOutbox } from "../metrics/UsageOutbox";
import type { UsageObservation } from "../metrics/UsageTypes";
import { AccountingBackend, AccountingRequestError, type LedgerApi, type ConversationMetadata, type ResumeClaimMetadata, type ResumeAbortReason, type ProviderCreateBody } from "../api/AccountingBackend";
import { BackendClient, type CreateLiveSessionResponse } from "../api/BackendClient";
import { CleanupIntentOutbox, cleanupProofReceived, producerLeaseKey } from "./CleanupIntentOutbox";
import { MetadataDeliveryBudget, type CleanupReason } from "./MetadataDeliveryBudget";
import type { LiveCloseResult } from "../live/LiveClient";

const DEFINITIVE_NO_PROVIDER_CODES = new Set([
  "new_creations_paused", "client_upgrade_required", "invalid_request", "unexpected_origin",
  "identity_required", "not_found", "provider_key_missing", "server_shutting_down_before_dispatch",
  "attempt_registration_unavailable",
  "concurrent_session_limit", "conversation_expired", "conversation_version_conflict",
  "attempt_in_progress", "attempt_conflict", "invalid_start_reason",
  "attempt_not_dispatchable", "conversation_not_activatable", "attempt_cancelled",
]);
function isDefinitiveNoProviderError(error: unknown): boolean {
  if (!(error instanceof AccountingRequestError)) return false;
  return [400, 401, 403, 404, 410, 429].includes(error.status) || DEFINITIVE_NO_PROVIDER_CODES.has(error.code);
}

interface PendingDirectEnd {
  conversationId: string; version: number; reason: "user_end" | "setup_cancel"; epoch: number; cleanupLocalIds: string[]; inFlight?: Promise<void>;
}

interface PendingEndBoundary {
  epoch: number;
  reason: "user_end" | "setup_cancel";
  attempts: ProviderAccounting[];
  conversation: ConversationMetadata | undefined;
  creating: Promise<ConversationMetadata> | undefined;
  inFlight?: Promise<void>;
}

/** One product controller owns this scope; provider attempts keep immutable local IDs. */
export class ConversationAccounting {
  readonly api: LedgerApi;
  readonly budget: MetadataDeliveryBudget;
  readonly outbox: CleanupIntentOutbox;
  readonly usageOutbox: UsageOutbox | undefined;
  private enabled: Promise<boolean> | undefined;
  private backgroundPolicy = false;
  private pausing = false;
  private resume: { id: string; version: number; mode: ProviderCreateBody["initialMode"] } | undefined;
  private creating: Promise<ConversationMetadata> | undefined;
  private current: ConversationMetadata | undefined;
  private last: ProviderAccounting | undefined;
  private readonly previousDispatch = new WeakMap<ProviderAccounting, ProviderAccounting | undefined>();
  private attempts = new Set<ProviderAccounting>();
  private epoch = 0;
  private dispatchCount = 0;
  private requestId = crypto.randomUUID();
  private stagedEndConversationId: string | undefined;
  private readonly autoDelivery: boolean;
  private readonly producerId: string;
  private producerLock: Promise<void> | undefined;
  private readonly pendingEndBoundaries = new Map<number, PendingEndBoundary>();
  private readonly pendingDirectEnds = new Map<number, PendingDirectEnd>();
  private readonly pendingDirectCleanupAcks = new Set<string>();
  private readonly pendingDirectCloseAcks = new Set<string>();
  private readonly pendingNoProviderFinalizations = new Set<string>();
  private readonly directRetirementProofs = new Set<string>();
  constructor(options: { api?: LedgerApi; budget?: MetadataDeliveryBudget; autoDelivery?: boolean } = {}) {
    this.api = options.api ?? new AccountingBackend();
    this.producerId = options.budget?.ownerProducerId ?? crypto.randomUUID();
    this.budget = options.budget ?? new MetadataDeliveryBudget({ producerId: this.producerId });
    this.outbox = new CleanupIntentOutbox(this.budget, this.api, () => this.flushPendingNoProviderFinalizations()); this.autoDelivery = options.autoDelivery ?? true;
    if (this.api.usage) this.usageOutbox = new UsageOutbox(this.budget, { usage: this.api.usage.bind(this.api), readConversation: this.api.readConversation.bind(this.api) });
    if (this.autoDelivery) { this.outbox.start(); this.usageOutbox?.start(); }
  }
  get revision() { return this.epoch; }
  get isPausing() { return this.pausing; }
  get conversationId(): string | null { return this.current?.conversationId ?? null; }
  get conversationStatus(): ConversationMetadata["status"] | null { return this.current?.status ?? null; }
  get resumeDispatched(): boolean { return [...this.attempts].some(attempt => attempt.localId === this.resume?.id && attempt.dispatched); }
  get isCreating(): boolean { return this.creating !== undefined; }
  clearIdleBackgroundPause(): boolean {
    if (this.current || this.creating) return false;
    this.pausing = false;
    return true;
  }
  keepUnpausedConversation(conversation: ConversationMetadata): void {
    if (conversation.status !== "active" || conversation.policy.backgroundSessionCloseEnabled)
      throw new Error("Conversation policy does not permit legacy continuation");
    this.current = conversation;
    this.pausing = false;
  }
  async pendingConversation(): Promise<ConversationMetadata | null> { return this.current ?? await this.creating?.catch(() => undefined) ?? null; }
  get backgroundSessionCloseEnabled(): boolean { return this.current?.policy.backgroundSessionCloseEnabled ?? this.backgroundPolicy; }
  async loadPolicy(): Promise<void> {
    this.enabled ??= this.api.policy().then(p => {
      if (p.creationPaused) throw new Error("New sessions are temporarily paused");
      if (typeof p.usageLedgerEnabled !== "boolean") throw new Error("Invalid accounting policy");
      if (p.backgroundSessionCloseEnabled && !p.usageLedgerEnabled) throw new Error("Background close requires the usage ledger");
      this.backgroundPolicy = p.backgroundSessionCloseEnabled;
      return p.usageLedgerEnabled;
    }).catch(error => { this.enabled = undefined; throw error; });
    await this.enabled;
  }
  beginBackgroundPause(): void { this.pausing = true; }
  beginResume(claim: ResumeClaimMetadata): void {
    if (claim.status !== "resuming" || claim.resumeAttemptId !== claim.attempt.liveSessionId || claim.attempt.resumeOutcome !== "pending")
      throw new Error("Resume claim was not confirmed");
    this.current = claim;
    this.resume = { id: claim.attempt.liveSessionId, version: claim.attempt.resumeClaimVersion, mode: claim.attempt.initialMode };
    this.pausing = false;
  }
  adoptRetained(conversation: ConversationMetadata): void {
    if (this.current || this.creating || [...this.attempts].some(attempt => attempt.dispatched) || conversation.status === "ended")
      throw new Error("Retained conversation cannot be adopted for End");
    this.current = conversation;
    this.pausing = true;
  }
  isResumeAttempt(attempt: ProviderAccounting): boolean { return this.resume?.id === attempt.localId; }
  resumeMode(attempt: ProviderAccounting): ProviderCreateBody["initialMode"] {
    return this.isResumeAttempt(attempt) ? this.resume!.mode : "setup";
  }
  async completeResume(startedAt: number): Promise<ConversationMetadata> {
    const resume = this.resume, c = this.current;
    if (!resume || !c) throw new Error("Resume claim unavailable");
    let result: ConversationMetadata;
    try { result = await this.api.completeResume(c.conversationId, resume.version, resume.id, startedAt, resume.mode); }
    catch (error) {
      // A lost response may follow a committed transaction. Read this immutable claim before any retry.
      const receipt = await this.api.claimResume(c.conversationId, resume.version - 1, resume.id, resume.mode)
        .catch(() => { throw error; });
      if (receipt.attempt.liveSessionId !== resume.id || receipt.attempt.resumeClaimVersion !== resume.version ||
        receipt.attempt.resumeOutcome !== "committed" || receipt.status !== "active" || receipt.version !== resume.version + 1)
        throw error;
      result = receipt;
    }
    if (result.status !== "active" || result.conversationId !== c.conversationId ||
      result.version !== resume.version + 1 || result.resumeAttemptId !== null)
      throw new Error("Resume completion was not confirmed");
    this.current = result; this.resume = undefined;
    return result;
  }
  async abortResume(reason: ResumeAbortReason): Promise<ConversationMetadata | null> {
    const resume = this.resume, c = this.current;
    this.pausing = true;
    if (!resume || !c) return null;
    const result = await this.api.abortResume(c.conversationId, resume.version, resume.id, reason);
    if (result.conversationId !== c.conversationId || !["paused", "ended"].includes(result.status))
      throw new Error("Resume abort was not confirmed");
    this.current = result; this.resume = undefined;
    return result;
  }
  async pause(close: Promise<unknown>): Promise<ConversationMetadata | null> {
    const c = await this.pendingConversation();
    await close.catch(() => undefined);
    const attempts = [...this.attempts];
    const results = await Promise.allSettled(attempts.map(a => a.finished ? a.waitForRetirement() : a.abandon("hidden")));
    const failure = results.find((r, i) => r.status === "rejected" && attempts[i]!.dispatched);
    if (failure?.status === "rejected") throw failure.reason;
    if (!c) return null;
    const paused = await this.api.pause(c.conversationId, c.version);
    if (paused.status !== "paused" || paused.conversationId !== c.conversationId) throw new Error("Conversation pause was not confirmed");
    this.current = paused;
    return paused;
  }
  newAttempt(): ProviderAccounting {
    const attempt = new ProviderAccounting(this, this.epoch, this.resume?.id); this.attempts.add(attempt); return attempt;
  }
  isCurrent(epoch: number) { return epoch === this.epoch; }
  private async holdProducerLock(): Promise<void> {
    if (this.producerLock || !globalThis.navigator?.locks) return this.producerLock;
    const lock = this.producerLock = new Promise((resolve, reject) => {
      void navigator.locks.request(producerLeaseKey(this.producerId), { ifAvailable: true }, lock => {
        if (!lock) { reject(new Error("Metadata producer ownership unavailable")); return; }
        resolve(); return new Promise<void>(() => {});
      }).catch(reject);
    });
    try { await lock; }
    catch (error) {
      if (this.producerLock === lock) this.producerLock = undefined;
      throw error;
    }
    const producers = new Set((await this.budget.entries()).map(e => e.producerId));
    for (const id of producers) {
      if (id === this.producerId) continue;
      await navigator.locks.request(`live-metadata-producer:${id}`, { ifAvailable: true }, async lock => {
        if (!lock) return; // Never take over a live/frozen producer in another tab.
        await this.budget.reclaimUndispatched(id);
        for (const row of await this.budget.entries()) {
          if (row.producerId !== id || row.dispatchStartedAt === null) continue;
          if (!row.producerFinalized && !row.cleanup && !row.closeObservation) await this.outbox.enqueue(row.localId, "response_not_received");
          // The exclusive producer lock proves the app producer died, not that its metrics are complete.
          // Keep its last partial report for delivery; release the producer hold only.
          if (row.usageProducerFinalized === false) await this.budget.finishUsageProducer(row.localId);
        }
      });
    }
  }
  async prepare(attempt: ProviderAccounting): Promise<ConversationMetadata | null> {
    await this.loadPolicy();
    if (this.pausing) throw new Error("Provider attempt cancelled");
    if (!await this.enabled) return null;
    await this.flushPendingNoProviderFinalizations();
    for (const boundary of [...this.pendingEndBoundaries.values()]) await this.finishEndBoundary(boundary);
    await this.flushPendingDirectEnds();
    await this.flushPendingDirectCleanupAcks();
    await this.flushPendingDirectCloseAcks();
    attempt.managed = true; attempt.assertCurrent();
    await this.holdProducerLock();
    await this.outbox.flush();
    const ends = await this.budget.ends();
    if (this.stagedEndConversationId &&
        this.stagedEndConversationId === (this.current ?? await this.creating?.catch(() => undefined))?.conversationId &&
        !ends.some(end => end.conversationId === this.stagedEndConversationId)) {
      const ended = await this.api.readConversation(this.stagedEndConversationId) as ConversationMetadata;
      attempt.assertCurrent();
      if (ended.conversationId !== this.stagedEndConversationId || ended.status !== "ended") throw new Error("Previous conversation End is pending");
      this.resetConversation(attempt);
      await this.loadPolicy();
      attempt.assertCurrent();
      if (!await this.enabled) { attempt.managed = false; return null; }
    }
    if (ends.length) throw new Error("Previous conversation End is pending");
    if (!this.current) this.creating ??= this.api.createConversation(this.requestId).catch(error => { this.creating = undefined; throw error; });
    const c = this.current ?? await this.creating!; attempt.assertCurrent(); this.current = c;
    if (c.status !== "active" && !(c.status === "resuming" && this.resume?.id === attempt.localId))
      throw new Error("Conversation is not activatable");
    // close() only joins local media retirement; do not race its pending durable write.
    if (this.last && this.last !== attempt && this.last.dispatched) await this.last.waitForRetirement();
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
  noteDispatch(attempt: ProviderAccounting): ProviderCreateBody["startReason"] {
    this.previousDispatch.set(attempt, this.last);
    this.last = attempt;
    this.dispatchCount++;
    return this.resume?.id === attempt.localId ? "resume" : this.dispatchCount === 1 ? "initial" : "bootstrap_replacement";
  }
  noteNoProvider(attempt: ProviderAccounting): void {
    const previous = this.previousDispatch.get(attempt);
    if (!this.previousDispatch.delete(attempt)) return;
    this.dispatchCount = Math.max(0, this.dispatchCount - 1);
    if (this.last === attempt) this.last = previous;
  }
  private resetConversation(nextAttempt?: ProviderAccounting): void {
    this.epoch++;
    nextAttempt?.rebase(this.epoch);
    this.current = undefined; this.creating = undefined; this.last = undefined;
    this.pausing = false; this.enabled = undefined; this.backgroundPolicy = false;
    this.resume = undefined;
    this.dispatchCount = 0; this.requestId = crypto.randomUUID(); this.attempts = new Set(nextAttempt ? [nextAttempt] : []);
    this.stagedEndConversationId = undefined;
  }
  private async deliverDirectEnd(intent: PendingDirectEnd): Promise<void> {
    if (intent.inFlight) return intent.inFlight;
    const operation = (async () => {
      const pending = intent.cleanupLocalIds.filter(localId => !this.directRetirementProofs.has(localId));
      if (pending.length) await this.outbox.flush();
      for (const localId of pending) {
        const row = await this.budget.get(localId);
        if (row?.cleanup || row?.closeObservation) throw new Error("Provider cleanup delivery is pending");
      }
      const result = await this.api.end(intent.conversationId, intent.version, intent.reason);
      if (result.status !== "ended") throw new Error("Conversation End was not confirmed");
      if (this.pendingDirectEnds.get(intent.epoch) === intent) this.pendingDirectEnds.delete(intent.epoch);
    })();
    intent.inFlight = operation;
    try { await operation; }
    catch (error) { if (intent.inFlight === operation) intent.inFlight = undefined; throw error; }
  }
  private async flushPendingDirectEnds(): Promise<void> {
    for (const intent of [...this.pendingDirectEnds.values()]) await this.deliverDirectEnd(intent);
  }
  async acknowledgeDirectCleanup(localId: string): Promise<void> {
    this.directRetirementProofs.add(localId);
    this.outbox.confirmRetirement(localId);
    try {
      await this.budget.acknowledgeDirectCleanupAndRelease(localId);
      this.pendingDirectCleanupAcks.delete(localId);
    } catch {
      this.pendingDirectCleanupAcks.add(localId);
    }
  }
  private async flushPendingDirectCleanupAcks(): Promise<void> {
    for (const localId of [...this.pendingDirectCleanupAcks]) {
      await this.budget.acknowledgeDirectCleanupAndRelease(localId);
      this.pendingDirectCleanupAcks.delete(localId);
    }
  }
  async acknowledgeDirectClose(localId: string): Promise<void> {
    this.directRetirementProofs.add(localId);
    this.outbox.confirmRetirement(localId);
    try {
      await this.budget.finishProducerAndRelease(localId, "provider_closed");
      this.pendingDirectCloseAcks.delete(localId);
    } catch {
      this.pendingDirectCloseAcks.add(localId);
    }
  }
  private async flushPendingDirectCloseAcks(): Promise<void> {
    for (const localId of [...this.pendingDirectCloseAcks]) {
      await this.budget.finishProducerAndRelease(localId, "provider_closed");
      this.pendingDirectCloseAcks.delete(localId);
    }
  }
  async finalizeNoProvider(localId: string): Promise<void> {
    this.directRetirementProofs.add(localId);
    this.pendingNoProviderFinalizations.add(localId);
    try { await this.flushPendingNoProviderFinalizations(); }
    catch (error) { this.outbox.wake(); throw error; }
  }
  private async flushPendingNoProviderFinalizations(): Promise<void> {
    for (const localId of [...this.pendingNoProviderFinalizations]) {
      try { await this.budget.finishProducerAndRelease(localId, "no_provider"); }
      catch (error) {
        try { await this.budget.finishProducer(localId, "no_provider"); } catch { /* Preserve the confirmed outcome if IDB permits. */ }
        throw error;
      }
      this.outbox.confirmRetirement(localId);
      this.pendingNoProviderFinalizations.delete(localId);
    }
  }
  async stageEnd(reason: "user_end" | "setup_cancel", expectedEpoch = this.epoch): Promise<void> {
    if (expectedEpoch !== this.epoch) return;
    const attempts = [...this.attempts];
    const c = this.current ?? await this.creating?.catch(() => undefined);
    if (!c) return;
    // Persist intent before waiting for provider final. Do not terminate the usage producer
    // or enqueue HTTP here: a crash can replay both stores, and a late final remains valid.
    const dispatched = attempts.filter(a => a.dispatched);
    this.outbox.deferCleanup(dispatched.filter(a => !a.finished).map(a => a.localId));
    await this.outbox.enqueueEnd(c.conversationId, c.version, reason, dispatched.map(a => a.localId), c.policy.sessionCloseTimeoutMs);
    this.stagedEndConversationId = c.conversationId;
  }

  async end(reason: "user_end" | "setup_cancel", expectedEpoch = this.epoch): Promise<void> {
    let boundary = this.pendingEndBoundaries.get(expectedEpoch);
    if (!boundary && expectedEpoch === this.epoch) {
      boundary = { epoch: expectedEpoch, reason, attempts: [...this.attempts], conversation: this.current, creating: this.creating };
      this.pendingEndBoundaries.set(expectedEpoch, boundary);
      this.resetConversation();
    }
    if (boundary) return this.finishEndBoundary(boundary); // First reason/version wins across retries.
    const pending = this.pendingDirectEnds.get(expectedEpoch);
    if (pending) await this.deliverDirectEnd(pending);
  }

  private async finishEndBoundary(boundary: PendingEndBoundary): Promise<void> {
    if (boundary.inFlight) return boundary.inFlight;
    const operation = this.deliverEndBoundary(boundary);
    boundary.inFlight = operation;
    try { await operation; }
    finally { if (boundary.inFlight === operation) boundary.inFlight = undefined; }
  }

  private async deliverEndBoundary(boundary: PendingEndBoundary): Promise<void> {
    try { await this.flushPendingNoProviderFinalizations(); }
    catch { console.error("No-provider finalization storage degraded"); }
    const c = boundary.conversation ?? await boundary.creating?.catch(() => undefined);
    let persisted = false;
    if (c) {
      try {
        await this.outbox.enqueueEnd(c.conversationId, c.version, boundary.reason,
          boundary.attempts.filter(a => a.dispatched && !this.directRetirementProofs.has(a.localId)).map(a => a.localId), c.policy.sessionCloseTimeoutMs);
        persisted = true;
      } catch { console.error("Conversation end storage degraded", { conversationId: c.conversationId }); }
    }
    const results = await Promise.allSettled(boundary.attempts.map(a => a.finished ? Promise.resolve() : a.abandon(boundary.reason === "setup_cancel" ? "cancelled" : "user_end")));
    // A failed local transaction plus failed direct cleanup must never fall through to End/new create.
    const dispatchedFailure = results.find((r, i) => r.status === "rejected" && boundary.attempts[i]!.dispatched);
    if (!persisted && dispatchedFailure?.status === "rejected") throw dispatchedFailure.reason;
    if (c) {
      const dispatched = boundary.attempts.filter(a => a.dispatched);
      if (!persisted || dispatched.every(a => this.directRetirementProofs.has(a.localId))) {
        const intent = this.pendingDirectEnds.get(boundary.epoch) ?? {
          conversationId: c.conversationId, version: c.version, reason: boundary.reason, epoch: boundary.epoch,
          cleanupLocalIds: dispatched.map(a => a.localId),
        };
        this.pendingDirectEnds.set(boundary.epoch, intent);
        await this.deliverDirectEnd(intent);
      } else void this.outbox.flush().catch(() => console.error("Conversation end delivery pending"));
    }
    this.pendingEndBoundaries.delete(boundary.epoch);
    const failure = results.find(r => r.status === "rejected");
    if (failure?.status === "rejected") throw failure.reason;
  }
}
export class ProviderAccounting {
  readonly localId: string;
  managed = false;
  dispatched = false;
  finished = false;
  private cancelled = false;
  private cleanupReason: CleanupReason | undefined;
  private reservation: Promise<void> | undefined;
  private hasReservation = false;
  private controller: AbortController | undefined;
  private conversation: ConversationMetadata | undefined;
  private finishing: Promise<void> | undefined;
  private reporter: UsageReporter | undefined;
  private lastProduct: ProductObservation | undefined;
  get closeTimeoutMs(): number | undefined { return this.conversation?.policy.sessionCloseTimeoutMs; }
  observeProduct(observation: ProductObservation): void { this.lastProduct = observation; this.reporter?.observeProduct(observation); }
  observeUsage(observation: UsageObservation): void { this.reporter?.observeUsage(observation); }
  providerStarted(): void { this.reporter?.providerStarted(); }
  constructor(private readonly scope: ConversationAccounting, private epoch: number, id?: string) { this.localId = id ?? crypto.randomUUID(); }
  rebase(epoch: number): void { this.epoch = epoch; }
  assertCurrent(): void {
    if (this.cancelled || this.scope.isPausing || !this.scope.isCurrent(this.epoch) || (typeof document !== "undefined" && document.visibilityState === "hidden" && this.managed)) throw new Error("Provider attempt cancelled");
  }
  async create(sdp: string, beforeManagedCreate?: () => void): Promise<CreateLiveSessionResponse> {
    const c = await this.scope.prepare(this); this.assertCurrent();
    if (!c) return new BackendClient().createLiveSession(sdp);
    this.conversation = c; beforeManagedCreate?.();
    this.reservation = this.scope.budget.reserve(this.localId, c.conversationId, this.scope.usageOutbox !== undefined);
    await this.reservation; this.hasReservation = true;
    try {
      this.assertCurrent(); await this.scope.budget.markDispatchStarted(this.localId); this.assertCurrent();
      if (this.scope.usageOutbox) this.reporter = new UsageReporter(this.localId, c.conversationId, this.scope.usageOutbox, { initial: this.lastProduct });
      this.controller = new AbortController(); this.dispatched = true;
      return await this.scope.api.createSession({ sdp, liveSessionId: this.localId, conversationId: c.conversationId,
        conversationVersion: c.version, initialMode: this.scope.resumeMode(this), startReason: this.scope.noteDispatch(this) }, this.controller.signal);
    } catch (error) {
      if (isDefinitiveNoProviderError(error)) {
        this.cancelled = true;
        await this.reporter?.noProvider();
        if (!this.reporter && this.scope.usageOutbox) await this.scope.usageOutbox.noProvider(this.localId);
        this.scope.noteNoProvider(this);
        this.finished = true;
        await this.scope.finalizeNoProvider(this.localId);
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
    if (receipt.state !== "active" || receipt.handoffAcknowledgedAt == null || receipt.cleanupRequestedAt != null ||
        receipt.conversation.status !== (this.scope.isResumeAttempt(this) ? "resuming" : "active") ||
        receipt.conversation.version !== this.conversation?.version || (receipt.conversation.productDeadlineAt !== null && receipt.conversation.serverTime >= receipt.conversation.productDeadlineAt)) throw new Error("Provider handoff was not confirmed");
  }
  async waitForRetirement(): Promise<void> {
    if (this.finishing) await this.finishing;
    if (!this.finished) throw new Error("Previous provider retirement is not confirmed");
  }
  async abandon(reason: CleanupReason): Promise<void> {
    this.cleanupReason ??= reason;
    const committedReason = this.cleanupReason;
    this.observeUsage({ kind: "local_close_unconfirmed" });
    this.cancelled = true;
    if (this.finished) return this.finishing;
    if (this.reservation && !this.hasReservation) { try { await this.reservation; this.hasReservation = true; } catch { return; } }
    if (!this.hasReservation) return;
    if (this.finishing) return this.finishing;
    const operation = (async () => {
      try {
        if (this.dispatched) { await this.scope.outbox.enqueue(this.localId, committedReason); this.controller?.abort(); }
        else {
          await this.scope.usageOutbox?.noProvider(this.localId);
          await this.scope.finalizeNoProvider(this.localId);
        }
        this.finished = true;
      } catch (error) {
        // Existing-session storage failure cannot keep audio alive. This is an explicitly degraded path.
        console.error("Existing session cleanup storage degraded", { localId: this.localId }); this.controller?.abort();
        if (!this.dispatched) throw error;
        const proof = await this.scope.api.cleanup(this.localId, committedReason);
        if (!cleanupProofReceived(proof)) throw new Error("Provider cleanup was not confirmed", { cause: error });
        await this.scope.acknowledgeDirectCleanup(this.localId);
        this.finished = true;
      }
    })();
    this.finishing = operation;
    try { await operation; }
    catch (error) { if (this.finishing === operation) this.finishing = undefined; throw error; }
  }
  async finish(result: LiveCloseResult): Promise<void> {
    // Must precede the PR2 finished guard: late usage still belongs to this immutable attempt.
    this.observeUsage(result.finalized ? { kind: "provider_closed", seconds: result.usageSeconds, reason: result.reason } : { kind: "local_close_unconfirmed" });
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
        const proof = await this.scope.api.closed(this.localId, observation);
        if (proof.closeConfirmed !== true && proof.state !== "closed" && !(proof.state === "failed" && !proof.openaiSessionId)) {
          throw new Error("Provider close was not confirmed");
        }
        await this.scope.acknowledgeDirectClose(this.localId);
      }
      this.finished = true;
    })();
    this.finishing = operation;
    try { await operation; }
    catch (error) { if (this.finishing === operation) this.finishing = undefined; throw error; }
  }
}
