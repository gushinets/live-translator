import type { ProductObservation } from "../metrics/UsageReporter";
import type { UsageObservation } from "../metrics/UsageTypes";
import { BackendClient } from "../api/BackendClient";
import { AudioController } from "../audio/AudioController";
import { LiveClient, type LiveCloseResult, type LiveClientDeps } from "../live/LiveClient";
import { SessionController, type SessionControllerDeps } from "./SessionController";
import { ConversationAccounting, type ProviderAccounting } from "./ConversationAccounting";
import type { CleanupReason } from "./MetadataDeliveryBudget";

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
  constructor(deps: SessionControllerDeps, private readonly accounting: ConversationAccounting) { super(deps); }
  get conversationId() { return this.accounting.conversationId; }
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
