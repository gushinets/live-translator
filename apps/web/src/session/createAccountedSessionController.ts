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
    this.startEarlyVisibility();
  }
  get conversationId() { return this.accounting.conversationId; }
  protected override get backgroundCloseEnabled() { return this.accounting.backgroundSessionCloseEnabled; }
  private async mayStart(): Promise<boolean> {
    await this.accounting.loadPolicy();
    if (this.sampleInitialHidden()) return false;
    if (!this.backgroundCloseEnabled) return true;
    if (this.accounting.conversationId !== null) return true;
    const retained = await (await this.snapshotStore).inspectReload(id =>
      this.accounting.api.readConversation(id) as Promise<ConversationMetadata>);
    if (retained) throw new Error("Retained conversation requires explicit recovery");
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
      try {
        const store = await this.snapshotStore;
        await store.save({ ...state, conversationId: conversation.conversationId,
          conversationVersion: conversation.version, policyVersion: conversation.policy.policyVersion,
          productDeadlineAt: conversation.productDeadlineAt });
        await store.markHidden(conversation.conversationId, hiddenAt, conversation.policy.conversationRetentionMs);
      } catch { console.error("Retained conversation snapshot unavailable"); }
    }
    const paused = await this.accounting.pause(close);
    if (paused) {
      try { await (await this.snapshotStore).confirmPause(paused); }
      catch { console.error("Retained conversation pause snapshot unavailable"); }
    }
  }
  protected override prepareConversationRetirement(reason: "user_end" | "setup_cancel"): Promise<void> {
    return this.accounting.stageEnd(reason, this.accounting.revision);
  }
  protected override finishConversationRetirement(reason: "user_end" | "setup_cancel"): Promise<void> {
    return this.accounting.end(reason, this.accounting.revision);
  }
}
export function createAccountedSessionController(): SessionController {
  const audio = new AudioController(), scope = new ConversationAccounting();
  const controller = new AccountedSessionController({
    createLive: () => new LiveClient({ backend: new BackendClient(), accounting: new LazyAccounting(scope),
      peerFactory: () => new RTCPeerConnection(), onRemoteStream: (stream, source) => controller.handleRemoteStream(stream, source) }),
    audio,
  }, scope);
  return controller;
}
