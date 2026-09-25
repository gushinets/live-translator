import type { ProductObservation } from "../metrics/UsageReporter";
import type { UsageObservation } from "../metrics/UsageTypes";
import { BackendClient } from "../api/BackendClient";
import { AudioController } from "../audio/AudioController";
import { LiveClient, type LiveCloseResult, type LiveClientDeps } from "../live/LiveClient";
import { SessionController, type SessionControllerDeps } from "./SessionController";
import { AccountingRequestError, type ConversationMetadata, type ResumeAbortReason } from "../api/AccountingBackend";
import { ConversationAccounting, type ProviderAccounting } from "./ConversationAccounting";
import type { CleanupReason } from "./MetadataDeliveryBudget";
import { ResumeSnapshotStore, type ResumeSnapshotInput } from "./ResumeSnapshotStore";

/** Materialize the attempt at connect, not when resetToIdle preallocates its next LiveClient. */
class LazyAccounting implements NonNullable<LiveClientDeps["accounting"]> {
  private attempt: ProviderAccounting | undefined;
  private cancelled = false;
  private lastProduct: ProductObservation | undefined;
  observeProduct(value: ProductObservation) { this.lastProduct = value; this.attempt?.observeProduct(value); }
  observeUsage(value: UsageObservation) { this.attempt?.observeUsage(value); }
  providerStarted() { this.attempt?.providerStarted(); }
  constructor(private readonly scope: ConversationAccounting) {}
  get closeTimeoutMs() { return this.attempt?.closeTimeoutMs; }
  get managed() { return this.attempt?.managed ?? false; }
  create(sdp: string, beforeDispatch?: () => void) {
    if (this.cancelled) return Promise.reject(new Error("Provider attempt cancelled"));
    this.attempt ??= this.scope.newAttempt();
    if (this.lastProduct) this.attempt.observeProduct(this.lastProduct);
    return this.attempt.create(sdp, beforeDispatch);
  }
  async handoff() { await this.attempt?.handoff(); }
  async finish(result: LiveCloseResult) { this.cancelled = true; await this.attempt?.finish(result); }
  async abandon(reason: CleanupReason) { this.cancelled = true; await this.attempt?.abandon(reason); }
}
export class AccountedSessionController extends SessionController {
  private resumeWork: Promise<void> | null = null;
  private recoveryProbe: Promise<void> | null = null;
  private verificationWork: Promise<void> | null = null;
  private recoveryChecking = false;
  private started = false;
  private resumeFailed = false;
  private retainedActive = false;
  private pendingEnd = false;
  private pendingClaim = false;
  private recoveryBlocked = false;
  private retainedEndWork: Promise<void> | null = null;
  constructor(deps: SessionControllerDeps, private readonly accounting: ConversationAccounting,
    private readonly snapshotStore: Promise<ResumeSnapshotStore> = ResumeSnapshotStore.open()) {
    super(deps);
  }
  start(): void {
    if (this.started) return;
    this.started = true;
    this.startEarlyVisibility();
    this.recoveryChecking = true;
    this.notify();
    const probe = (async () => {
      const store = await this.snapshotStore;
      if ((await this.accounting.budget.ends()).length) { this.pendingEnd = true; return; }
      if (!store.hasRetainedIdentity()) return;
      const result = await store.inspectReload(id => this.accounting.api.readConversation(id) as Promise<ConversationMetadata>);
      if (result?.kind === "paused" || result?.kind === "pending") this.adoptRetainedPause();
      if (result?.kind === "pending") this.pendingClaim = true;
      if (result?.kind === "active") this.retainedActive = true;
    })().catch(error => {
      this.recoveryBlocked = true;
      console.error("Retained conversation inspection failed", { error });
    }).finally(() => {
      this.recoveryChecking = false;
      if (this.recoveryProbe === probe) this.recoveryProbe = null;
      this.notify();
    });
    this.recoveryProbe = probe;
  }
  get retainedRecoveryState(): "checking" | "paused" | "resuming" | "ending" | "failed" | "active" | "pending_end" | "pending_claim" | "blocked" | undefined {
    if (this.retainedEndWork || this.session.state === "ending") return "ending";
    if (this.recoveryChecking || this.verificationWork) return "checking";
    if (this.resumeWork) return "resuming";
    if (this.pendingEnd) return "pending_end";
    if (this.retainedActive) return "active";
    if (this.recoveryBlocked) return "blocked";
    if (this.pendingClaim) return "pending_claim";
    if (this.resumeFailed) return "failed";
    return this.retainedPaused ? "paused" : undefined;
  }
  verifyRetainedConversation(): Promise<void> {
    if (this.verificationWork) return this.verificationWork;
    const work = (async () => {
      try { await this.runRecoveryVerification(); }
      catch (error) { this.recoveryBlocked = true; throw error; }
      finally {
        this.verificationWork = null;
        this.notify();
      }
    })();
    this.verificationWork = work;
    this.notify();
    return work;
  }
  private async runRecoveryVerification(): Promise<void> {
    await this.recoveryProbe;
    await this.accounting.outbox.flush();
    this.pendingEnd = (await this.accounting.budget.ends()).length > 0;
    if (this.pendingEnd) return;
    const store = await this.snapshotStore;
    if (!store.hasRetainedIdentity()) {
      if (this.accounting.conversationId) throw new Error("Retained conversation identity is unavailable");
      this.recoveryBlocked = false;
      this.retainedActive = false;
      this.pendingClaim = false;
      this.resumeFailed = false;
      if (this.retainedPaused) this.clearRetainedAfterEnd();
      return;
    }
    const result = await store.inspectReload(id => this.accounting.api.readConversation(id) as Promise<ConversationMetadata>);
    this.recoveryBlocked = false;
    this.retainedActive = result?.kind === "active";
    this.pendingClaim = result?.kind === "pending";
    if (result?.kind === "paused" || result?.kind === "pending") this.adoptRetainedPause();
    if (!result && this.retainedPaused) this.clearRetainedAfterEnd();
  }
  async dispose(): Promise<void> {
    this.fenceRetainedResumeForDisposal();
    this.stopEarlyVisibility();
    try {
      await this.resumeWork?.catch(() => undefined);
      await this.awaitBackgroundPause();
      this.accounting.beginBackgroundPause();
      if (this.accounting.conversationId || this.accounting.isCreating) {
        let store: ResumeSnapshotStore | undefined;
        try {
          store = await this.snapshotStore;
          if (this.accounting.isCreating && !this.accounting.conversationId) store.retainPendingCreate();
        } catch { console.error("Conversation identity storage unavailable during disposal"); }
        const conversation = await this.accounting.pendingConversation();
        if (!conversation) return;
        const id = conversation.conversationId;
        // ponytail: if both local stores reject writes and End fails, crash recovery needs an owner-scoped server lookup.
        try { store?.retainIdentity(id, conversation.version); }
        catch { console.error("Conversation identity storage unavailable during disposal"); }
        if (conversation.status === "paused") return;
        if (this.session.state === "idle" || this.session.state === "ended")
          await this.accounting.end("setup_cancel", this.accounting.revision);
        else await this.endConversation();
        try { store?.retainIdentity(id, conversation.version); }
        catch { console.error("Conversation identity storage unavailable during disposal"); }
        await this.accounting.outbox.flush();
        const ended = await this.accounting.api.readConversation(id);
        if (typeof ended !== "object" || ended === null || !("status" in ended) || ended.status !== "ended")
          throw new Error("Conversation End was not confirmed during disposal");
        await store?.discard(id);
        return;
      }
      for (const intent of await this.accounting.budget.ends()) {
        let store: ResumeSnapshotStore | undefined;
        try {
          store = await this.snapshotStore;
          store.retainIdentity(intent.conversationId, intent.expectedVersion);
        } catch { console.error("Conversation identity storage unavailable during disposal"); }
        await this.accounting.outbox.flush();
        const ended = await this.accounting.api.readConversation(intent.conversationId);
        if (typeof ended !== "object" || ended === null || !("status" in ended) || ended.status !== "ended")
          throw new Error("Conversation End was not confirmed during disposal");
        await store?.discard(intent.conversationId);
      }
    } finally {
      this.accounting.outbox.stop();
      this.accounting.usageOutbox?.stop();
      await this.snapshotStore.then(store => store.dispose(), () => undefined);
    }
  }
  get conversationId() { return this.accounting.conversationId; }
  protected override get backgroundCloseEnabled() { return this.accounting.backgroundSessionCloseEnabled; }
  protected override clearIdleBackgroundPause() { return this.accounting.clearIdleBackgroundPause(); }
  protected override async resumeBackground(): Promise<void> {
    if (this.resumeFailed) return;
    try { await this.resumeRetainedConversation(false); }
    catch (error) { console.error("Retained conversation resume failed", { error }); }
  }
  async resumeRetainedConversation(explicit = true): Promise<void> {
    if (this.pendingEnd || this.recoveryBlocked) throw new Error("Retained conversation requires verification");
    if (this.retainedEndWork) return this.retainedEndWork;
    if (this.resumeWork) return this.resumeWork;
    if (explicit) { this.resumeFailed = false; this.pendingClaim = false; }
    const work = (async () => {
      await this.recoveryProbe;
      await this.runRetainedResume(explicit);
    })();
    this.resumeWork = work;
    this.notify();
    try { await work; }
    catch (error) {
      if (explicit || this.retainedPaused && document.visibilityState !== "hidden") this.resumeFailed = true;
      throw error;
    }
    finally {
      if (this.resumeWork === work) this.resumeWork = null;
      this.notify();
    }
  }
  override endConversation(): Promise<void> {
    if (this.retainedEndWork) return this.retainedEndWork;
    if (this.resumeWork && this.accounting.conversationId) return super.endConversation();
    if (!this.resumeWork && (this.accounting.conversationId ||
      !this.retainedPaused && !this.retainedActive && !this.resumeFailed && !this.recoveryChecking &&
      !this.pendingEnd && !this.pendingClaim && !this.recoveryBlocked))
      return super.endConversation();
    const resume = this.resumeWork;
    if (resume) this.fenceRetainedRecoveryForEnd();
    const work = (async () => {
      try {
        await resume?.catch(() => undefined);
        await this.runRetainedEnd();
      } catch (error) {
        this.recoveryBlocked = true;
        this.retainedActive = false;
        throw error;
      } finally {
        this.retainedEndWork = null;
        this.notify();
      }
    })();
    this.retainedEndWork = work;
    this.notify();
    return work;
  }
  private async runRetainedEnd(): Promise<void> {
    await this.recoveryProbe;
    const store = await this.snapshotStore;
    if (this.pendingEnd) { await this.runRecoveryVerification(); if (this.pendingEnd) return; }
    const retainedId = store.retainedConversationId();
    if (retainedId) {
      // A server read can safely End an expired/corrupt snapshot without claiming or restoring it.
      const conversation = await this.accounting.api.readConversation(retainedId) as ConversationMetadata;
      if (conversation.conversationId !== retainedId || !Number.isSafeInteger(conversation.version) ||
        conversation.version < store.retainedConversationVersion() || !["active", "paused", "resuming", "ended"].includes(conversation.status))
        throw new Error("Retained conversation status unavailable");
      if (conversation.status === "ended") await store.discard(retainedId);
      else {
        const local = await this.accounting.pendingConversation();
        if (local) {
          if (local.conversationId !== conversation.conversationId || local.version !== conversation.version ||
            local.status !== conversation.status) throw new Error("Retained End version changed");
        } else this.accounting.adoptRetained(conversation);
        await this.accounting.stageEnd("user_end", this.accounting.revision);
        await this.accounting.end("user_end", this.accounting.revision);
        await this.accounting.outbox.flush();
        await store.inspectReload(id => this.accounting.api.readConversation(id) as Promise<ConversationMetadata>);
      }
    }
    this.pendingEnd = (await this.accounting.budget.ends()).length > 0;
    if (this.pendingEnd || store.hasRetainedIdentity()) throw new Error("Conversation End is not confirmed");
    this.retainedActive = false;
    this.resumeFailed = false;
    this.recoveryBlocked = false;
    this.pendingClaim = false;
    this.clearRetainedAfterEnd();
  }
  private pausedOrUnloaded(): boolean {
    return this.accounting.conversationStatus === null || this.accounting.conversationStatus === "paused";
  }
  private async runRetainedResume(explicit: boolean): Promise<void> {
    if (this.retainedActive) throw new Error("Active retained conversation must be ended before a new conversation");
    if (explicit && this.session.state === "idle" && this.accounting.conversationStatus === null) {
      const store = await this.snapshotStore;
      const result = await store.inspectReload(id => this.accounting.api.readConversation(id) as Promise<ConversationMetadata>);
      if (!result || result.kind === "active") throw new Error("Retained conversation requires explicit End");
      this.adoptRetainedPause();
    }
    const generation = this.backgroundResumeGeneration;
    await this.awaitBackgroundPause();
    if (!this.backgroundResumeCurrent(generation)) return;
    if (!this.pausedOrUnloaded()) return;
    const store = await this.snapshotStore;
    let inspected = await store.inspectReload(id => this.accounting.api.readConversation(id) as Promise<ConversationMetadata>);
    if (inspected?.kind === "pending" && explicit) {
      const { snapshot, conversation } = inspected;
      const attemptId = snapshot.resumeAttemptId!;
      const claimVersion = snapshot.conversationVersion + 1;
      const reason = "interrupted_by_restart";
      let aborted: ConversationMetadata;
      try { aborted = await this.accounting.api.abortResume(conversation.conversationId, claimVersion, attemptId, reason); }
      catch (error) {
        aborted = await this.accounting.api.abortResume(conversation.conversationId, claimVersion, attemptId, reason)
          .catch(() => { throw error; });
      }
      if (aborted.conversationId !== conversation.conversationId || aborted.version < claimVersion + 1 ||
        !["paused", "ended"].includes(aborted.status) || aborted.resumeAttemptId !== null)
        throw new Error("Previous resume abort was not confirmed");
      const receipt = await this.accounting.api.readAttempt(attemptId);
      if (receipt.liveSessionId !== attemptId || receipt.conversation.conversationId !== conversation.conversationId ||
        !["failed", "closed"].includes(receipt.state ?? "") || receipt.cleanupRequestedAt == null)
        throw new Error("Previous resume cleanup is still pending");
      if (aborted.status === "paused") {
        await store.confirmPause(aborted);
        await store.clearResumeAttempt(conversation.conversationId, attemptId);
      }
      inspected = await store.inspectReload(id => this.accounting.api.readConversation(id) as Promise<ConversationMetadata>);
    }
    if (!inspected && !store.hasRetainedIdentity()) {
      if (this.accounting.conversationId) {
        this.recoveryBlocked = true;
        throw new Error("Retained conversation identity is unavailable");
      }
      this.accounting.clearIdleBackgroundPause();
      this.resumeFailed = false;
      this.clearRetainedAfterEnd();
      return;
    }
    if (!inspected || inspected.kind === "active" || inspected.kind === "pending") {
      if (explicit && inspected) throw new Error("Retained conversation status requires explicit recovery");
      return;
    }
    if (!this.backgroundResumeCurrent(generation)) return;
    const { snapshot, conversation } = inspected;
    if (snapshot.resumeAttemptId !== null) return; // An uncertain prior claim requires explicit server reconciliation.
    const id = crypto.randomUUID();
    await store.rememberResumeAttempt(conversation.conversationId, id);
    let claimed = false;
    let claimRequested = false;
    let settled = false;
    try {
      if (!this.backgroundResumeCurrent(generation)) return;
      claimRequested = true;
      const mode = snapshot.setupStage === "interpreter" ? "interpreter" : "setup";
      let claim;
      try { claim = await this.accounting.api.claimResume(conversation.conversationId, conversation.version, id, mode); }
      catch (error) {
        if (error instanceof AccountingRequestError) throw error;
        claim = await this.accounting.api.claimResume(conversation.conversationId, conversation.version, id, mode)
          .catch(() => { throw error; });
      }
      claimed = true;
      this.accounting.beginResume(claim);
      if (!this.backgroundResumeCurrent(generation)) throw new Error("Resume cancelled");
      await this.restoreRetained(snapshot, async startedAt => {
        const completed = await this.accounting.completeResume(startedAt);
        await store.confirmResume(completed, id);
      });
      settled = true;
      this.resumeFailed = false;
    } catch (error) {
      const cancelled = !this.backgroundResumeCurrent(generation);
      this.resumeFailed = !cancelled;
      this.notify();
      if (claimed) {
        const cleanup = this.abandonRetainedMedia(this.backgroundResumeCurrent(generation) ? "abandoned_connect" : "hidden");
        const reason: ResumeAbortReason = cancelled && document.visibilityState === "hidden" ? "hidden" :
          this.retainedResumePhase === "media" || !this.accounting.resumeDispatched ||
          error instanceof Error && /Microphone|audio|playback|media/i.test(error.message) ? "media_not_ready" :
          this.retainedResumePhase === "create" ? "provider_creation_failed" : "restore_ack_failed";
        if (this.accounting.conversationStatus === "active") {
          void cleanup.catch(() => console.error("Retained transport cleanup incomplete"));
          try { await this.accounting.end("setup_cancel", this.accounting.revision); settled = true; }
          catch { console.error("Committed resume retirement pending"); }
        } else {
          try { await cleanup; }
          catch { console.error("Retained transport cleanup incomplete"); }
          try {
            const aborted = await this.accounting.abortResume(reason);
            if (aborted?.status === "paused") await store.confirmPause(aborted);
            settled = aborted !== null;
          } catch { console.error("Resume abort delivery pending"); }
        }
      }
      throw error;
    } finally {
      if (!claimRequested || settled) await store.clearResumeAttempt(conversation.conversationId, id).catch(() => undefined);
    }
  }
  private async mayStart(): Promise<boolean> {
    await this.accounting.loadPolicy();
    await this.recoveryProbe;
    await this.awaitBackgroundPause();
    if ((await this.accounting.budget.ends()).length) {
      this.pendingEnd = true; this.notify();
      throw new Error("Previous conversation End is pending");
    }
    if (this.sampleInitialHidden()) return false;
    if (this.accounting.conversationId !== null) return true;
    const store = await this.snapshotStore;
    if (store.hasRetainedIdentity()) {
      const retained = await store.inspectReload(id => this.accounting.api.readConversation(id) as Promise<ConversationMetadata>);
      if (retained || store.hasRetainedIdentity()) throw new Error("Retained conversation requires explicit recovery");
    }
    if (!this.backgroundCloseEnabled) return true;
    return !this.sampleInitialHidden();
  }
  override async startContextCapture(): Promise<void> {
    if (!await this.mayStart()) return;
    await super.startContextCapture();
  }
  override async startBootstrap(): Promise<void> {
    if (!await this.mayStart()) return;
    await super.startBootstrap();
  }
  protected override beginBackgroundPause(): void { this.accounting.beginBackgroundPause(); }
  protected override async pauseBackground(state: Omit<ResumeSnapshotInput,
    "conversationId" | "conversationVersion" | "policyVersion" | "productDeadlineAt">,
  hiddenAt: number, close: Promise<unknown>): Promise<void> {
    const conversation = await this.accounting.pendingConversation();
    if (conversation) {
      if (!conversation.policy.backgroundSessionCloseEnabled) {
        await close.catch(() => undefined);
        this.accounting.keepUnpausedConversation(conversation);
        this.resetAfterUnpausedBackground();
        return;
      }
      let retainedIdentity = false;
      try {
        const store = await this.snapshotStore;
        store.retainIdentity(conversation.conversationId, conversation.version);
        retainedIdentity = true;
        await store.save({ ...state, conversationId: conversation.conversationId,
          conversationVersion: conversation.version, policyVersion: conversation.policy.policyVersion,
          productDeadlineAt: conversation.productDeadlineAt });
        await store.markHidden(conversation.conversationId, hiddenAt, conversation.policy.conversationRetentionMs);
      } catch (error) {
        if (!retainedIdentity) {
          await close.catch(() => undefined);
          await this.accounting.end("setup_cancel", this.accounting.revision);
          await this.accounting.outbox.flush();
          const ended = await this.accounting.api.readConversation(conversation.conversationId);
          if (typeof ended !== "object" || ended === null || !("status" in ended) || ended.status !== "ended")
            throw new Error("Retained conversation could not be safely ended", { cause: error });
          return;
        }
        console.error("Retained conversation snapshot unavailable", { error });
      }
    }
    const paused = await this.accounting.pause(close);
    if (paused) {
      try { await (await this.snapshotStore).confirmPause(paused); }
      catch { console.error("Retained conversation pause snapshot unavailable"); }
    }
  }
  protected override async prepareConversationRetirement(reason: "user_end" | "setup_cancel"): Promise<void> {
    const conversation = await this.accounting.pendingConversation();
    if (conversation) {
      try { (await this.snapshotStore).retainIdentity(conversation.conversationId, conversation.version); }
      catch { console.error("Conversation identity storage unavailable before End"); }
    }
    await this.accounting.stageEnd(reason, this.accounting.revision);
  }
  protected override async finishConversationRetirement(reason: "user_end" | "setup_cancel"): Promise<void> {
    const conversation = await this.accounting.pendingConversation();
    await this.accounting.end(reason, this.accounting.revision);
    if (!conversation) return;
    try {
      await this.accounting.outbox.flush();
      await (await this.snapshotStore).inspectReload(id => this.accounting.api.readConversation(id) as Promise<ConversationMetadata>);
    } catch { /* Keep the pointer until a later server read confirms termination. */ }
    try {
      this.pendingEnd = (await this.accounting.budget.ends()).length > 0;
      if (!this.pendingEnd && (await this.snapshotStore).hasRetainedIdentity()) this.recoveryBlocked = true;
    } catch {
      this.recoveryBlocked = true;
    }
  }
}
export function createAccountedSessionController(): AccountedSessionController {
  const audio = new AudioController(), scope = new ConversationAccounting();
  const controller = new AccountedSessionController({
    createLive: () => new LiveClient({ backend: new BackendClient(), accounting: new LazyAccounting(scope),
      peerFactory: () => new RTCPeerConnection(), onRemoteStream: (stream, source) => controller.handleRemoteStream(stream, source) }),
    audio,
  }, scope);
  return controller;
}
