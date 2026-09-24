import type { ProductObservation } from "../metrics/UsageReporter";
import type { UsageObservation } from "../metrics/UsageTypes";
import { BackendClient } from "../api/BackendClient";
import { AudioController } from "../audio/AudioController";
import { LiveClient, type LiveCloseResult, type LiveClientDeps } from "../live/LiveClient";
import { SessionController, type SessionControllerDeps } from "./SessionController";
import type { ConversationMetadata } from "../api/AccountingBackend";
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
  constructor(deps: SessionControllerDeps, private readonly accounting: ConversationAccounting,
    private readonly snapshotStore: Promise<ResumeSnapshotStore> = ResumeSnapshotStore.open()) {
    super(deps);
  }
  start(): void { this.startEarlyVisibility(); }
  async dispose(): Promise<void> {
    this.stopEarlyVisibility();
    try {
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
  private async mayStart(): Promise<boolean> {
    await this.accounting.loadPolicy();
    await this.awaitBackgroundPause();
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
