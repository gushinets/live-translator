import { boundOrphanCloser } from "./BoundedOrphanCloser.js";
import OpenAI from "openai";
import { makeLiveSessionCreator, type LiveSessionCreator, type LiveSessionResponse } from "../openai/createLiveSession.js";
import { makeOrphanCloser } from "../openai/closeOrphanSession.js";
import { SessionLeaseRegistry } from "../security/SessionLeaseRegistry.js";
import { CleanupWorker, type OrphanCloser, type CleanupOutcome } from "./CleanupWorker.js";
import { UsageLedger } from "./UsageLedger.js";
import { LedgerError, type AttemptInput, type CleanupReason } from "./types.js";

type Creation = { controller: AbortController; promise: Promise<LiveSessionResponse>; safe: boolean; settled: boolean };
async function boundedWait(work: Promise<unknown>, ms: number) {
  if (ms <= 0) return;
  let timer: ReturnType<typeof setTimeout> | undefined;
  await Promise.race([work, new Promise<void>(r => { timer = setTimeout(r, ms); })]);
  if (timer) clearTimeout(timer);
}
/** Coordinates SQL commit boundaries, request ownership and fallible provider calls. */
export class LedgerRuntime {
  readonly registry: SessionLeaseRegistry;
  readonly worker: CleanupWorker;
  private readonly network = new Map<string, Creation>();
  private readonly createWaiters = new Map<string, number>();
  private readonly pendingFences = new Map<string, CleanupReason>();
  private readonly emergencyResults = new Map<string, { providerId: string; expiresAt?: number; outcome?: CleanupOutcome }>();
  private readonly logger: Pick<Console, "error">;
  private readonly closer: OrphanCloser;
  private accepting = true;
  private disposed = false;
  private timer: ReturnType<typeof setInterval> | undefined;
  private creator: LiveSessionCreator | undefined;
  constructor(readonly ledger: UsageLedger, private readonly options: {
    creator?: LiveSessionCreator; closeOrphan?: OrphanCloser; maxConcurrent?: number; leaseMs?: number;
    workerConcurrency?: number; workerBatchSize?: number; logger?: Pick<Console, "error">; startWorker?: boolean;
  } = {}) {
    this.logger = options.logger ?? console; this.creator = options.creator;
    this.closer = boundOrphanCloser(options.closeOrphan ?? makeOrphanCloser(undefined, ledger.policy.sessionCloseTimeoutMs), options.workerConcurrency ?? 2);
    this.registry = new SessionLeaseRegistry(options.maxConcurrent ?? 5, options.leaseMs ?? 900000);
    ledger.recover(); ledger.rearmBlockedCleanup("startup"); this.syncAdmission();
    this.worker = new CleanupWorker(ledger, this.closer, { concurrency: options.workerConcurrency,
      batchSize: options.workerBatchSize, onChange: () => this.syncAdmission(), logger: this.logger });
    if (options.startWorker !== false) {
      this.worker.start(); this.timer = setInterval(() => { void this.reconcileEmergency(); }, 1000); this.timer.unref();
    }
  }
  get acceptingCreates() { return this.accepting; }
  get inflightCount() { return this.network.size; }
  activationBlocked(id: string): boolean { return this.pendingFences.has(id); }
  registerCreateWaiter(id: string): void {
    this.createWaiters.set(id, (this.createWaiters.get(id) ?? 0) + 1);
  }
  releaseCreateWaiter(id: string): number {
    const next = Math.max(0, (this.createWaiters.get(id) ?? 0) - 1);
    if (next === 0) this.createWaiters.delete(id); else this.createWaiters.set(id, next);
    return next;
  }
  createWaiterCount(id: string): number { return this.createWaiters.get(id) ?? 0; }
  hasCreateWaiters(id: string): boolean { return this.createWaiterCount(id) > 0; }
  waitForCreates(): Promise<void> {
    return Promise.allSettled([...this.network.values()].map(entry => entry.promise)).then(() => undefined);
  }
  syncAdmission(): void {
    this.registry.restoreReservations(this.ledger.reservations().map(s => ({ leaseId: s.lease_id!, expiresAt: s.lease_expires_at!, sessionId: s.openai_session_id })), this.ledger.now());
  }
  wake(): void { if (this.options.startWorker !== false) this.worker.wake(); }
  cleanup(id: string, reason: CleanupReason): void {
    this.pendingFences.set(id, this.pendingFences.get(id) ?? reason);
    this.ledger.requestCleanup(id, this.pendingFences.get(id)!);
    this.pendingFences.delete(id);
    this.network.get(id)?.controller.abort(); // Only AFTER durable fence commit.
    this.syncAdmission(); this.wake();
  }
  create(owner: string, input: AttemptInput, sdp: string, disconnected: () => boolean): Promise<LiveSessionResponse> {
    if (!this.accepting) throw new LedgerError("server_shutting_down_before_dispatch", 503);
    const row = this.ledger.registerAttempt(owner, input);
    const existing = this.network.get(row.id); if (existing) return existing.promise;
    if (row.provider_request_dispatched_at !== null) throw new LedgerError("attempt_already_exists");
    const entry: Creation = { controller: new AbortController(), safe: false, settled: false, promise: Promise.resolve(null as unknown as LiveSessionResponse) };
    entry.promise = Promise.resolve().then(() => this.dispatch(owner, input, sdp, disconnected, entry)).finally(() => {
      entry.settled = true;
      if (entry.safe) this.network.delete(row.id);
    });
    this.network.set(row.id, entry); return entry.promise;
  }
  private async dispatch(owner: string, input: AttemptInput, sdp: string, disconnected: () => boolean, entry: Creation): Promise<LiveSessionResponse> {
    const id = input.liveSessionId;
    if (!this.accepting || disconnected() || entry.controller.signal.aborted || this.activationBlocked(id)) {
      this.cleanup(id, this.accepting ? "client_disconnected" : "server_shutdown"); entry.safe = true;
      throw new LedgerError("attempt_cancelled");
    }
    this.syncAdmission(); const lease = this.registry.acquire(this.ledger.now());
    if (!lease) { this.ledger.recordCreateFailure(id, true); entry.safe = true; throw new LedgerError("concurrent_session_limit", 429); }
    try {
      this.ledger.dispatchProviderAttempt(owner, id, input.conversationVersion, lease.leaseId, this.ledger.now() + (this.options.leaseMs ?? 900000));
    } catch (error) { lease.release(); entry.safe = true; throw error; }
    let result: LiveSessionResponse;
    try {
      // No await between the shared dispatch gate/CAS and invocation of the creator.
      this.creator ??= makeLiveSessionCreator();
      result = await this.creator(sdp, { signal: entry.controller.signal, localId: id });
    } catch (error) {
      if (!this.disposed) {
        try {
          const definitive = error instanceof OpenAI.APIError && error.status !== undefined &&
            [400, 401, 403, 404, 422, 429].includes(error.status) && !entry.controller.signal.aborted;
          this.ledger.recordCreateFailure(id, definitive);
          if (!definitive) this.cleanup(id, this.pendingFences.get(id) ?? "response_not_received");
          entry.safe = true; this.syncAdmission(); this.wake();
        } catch { this.logger.error("Provider create outcome could not be persisted", { localId: id }); }
      }
      throw error instanceof LedgerError ? error : new LedgerError("provider_creation_failed", 502);
    }
    try {
      if (this.pendingFences.has(id)) this.cleanup(id, this.pendingFences.get(id)!);
      const row = this.ledger.recordProviderCreated(id, result.session.id,
        typeof result.session.expires_at === "number" ? result.session.expires_at * 1000 : undefined);
      entry.safe = true; this.syncAdmission(); this.wake();
      if (this.disposed) throw new LedgerError("server_shutting_down", 503);
      if (row.cleanup_requested_at !== null || row.state !== "creating" || entry.controller.signal.aborted) throw new LedgerError("attempt_not_activatable");
      return result;
    } catch (error) {
      if (error instanceof LedgerError) throw error;
      this.pendingFences.set(id, this.pendingFences.get(id) ?? "response_not_received");
      this.emergencyResults.set(id, { providerId: result.session.id,
        ...(result.session.expires_at !== undefined ? { expiresAt: result.session.expires_at * 1000 } : {}) });
      await this.reconcileEmergency();
      entry.safe = !this.emergencyResults.has(id) && !this.pendingFences.has(id);
      throw new LedgerError("provider_result_unpersisted", 503);
    }
  }
  private repairing: Promise<void> | null = null;
  reconcileEmergency(): Promise<void> {
    this.repairing ??= this.repair().finally(() => { this.repairing = null; }); return this.repairing;
  }
  private async repair(): Promise<void> {
    for (const [id, reason] of this.pendingFences) {
      try {
        this.cleanup(id, reason);
        const entry = this.network.get(id);
        if (entry?.settled && !this.emergencyResults.has(id)) { entry.safe = true; this.network.delete(id); }
      }
      catch { /* Remains a volatile activation fence until storage recovers. */ }
    }
    for (const [id, value] of this.emergencyResults) {
      try {
        this.cleanup(id, this.pendingFences.get(id) ?? "response_not_received");
        this.ledger.recordProviderCreated(id, value.providerId, value.expiresAt);
        if (value.outcome?.kind === "closed_observed") this.ledger.recordProviderClosed(id, value.outcome.observation, "sideband");
        this.emergencyResults.delete(id); const entry = this.network.get(id); if (entry) entry.safe = true;
        this.network.delete(id); this.syncAdmission(); this.wake();
      } catch {
        if (!value.outcome) {
          try { value.outcome = await this.closer(value.providerId, AbortSignal.timeout(this.ledger.policy.sessionCloseTimeoutMs)); }
          catch { value.outcome = { kind: "retryable_error", code: "emergency_transport" }; }
        }
        this.logger.error("Ambiguous provider result awaiting ledger recovery", { localId: id });
      }
    }
  }
  async shutdown(options: { drainMs: number; timeoutMs: number }): Promise<void> {
    const deadline = performance.now() + options.timeoutMs;
    this.accepting = false; if (this.timer) clearInterval(this.timer);
    for (const [id] of this.network) {
      try {
        const row = this.ledger.getAttemptInternal(id);
        if (row.creation_completed_at === null) {
          this.pendingFences.set(id, this.pendingFences.get(id) ?? "server_shutdown");
          this.ledger.requestCleanup(id, this.pendingFences.get(id)!); this.pendingFences.delete(id);
        }
      } catch { this.logger.error("Shutdown cleanup fence unavailable", { localId: id }); }
    }
    try { this.ledger.watchdog(); this.wake(); } catch { /* Retry only within remaining global budget. */ }
    const work = Promise.allSettled([...this.network.values()].map(r => r.promise));
    await boundedWait(work, Math.min(options.drainMs, Math.max(0, deadline - performance.now())));
    for (const [id, request] of this.network) {
      try { if (this.ledger.getAttemptInternal(id).cleanup_requested_at !== null) request.controller.abort(); }
      catch { /* Never call abort as a substitute for committing the cleanup fence. */ }
    }
    await boundedWait(work, Math.min(100, Math.max(0, deadline - performance.now())));
    await this.worker.stop(Math.min(this.ledger.policy.sessionCloseTimeoutMs, Math.max(0, deadline - performance.now())));
    this.createWaiters.clear();
    this.disposed = true;
  }
}
