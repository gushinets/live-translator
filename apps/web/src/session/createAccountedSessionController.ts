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
  constructor(private readonly scope: ConversationAccounting) {}
  get managed() { return this.attempt?.managed ?? false; }
  create(sdp: string, beforeDispatch?: () => void) {
    if (this.cancelled) return Promise.reject(new Error("Provider attempt cancelled"));
    this.attempt ??= this.scope.newAttempt(); return this.attempt.create(sdp, beforeDispatch);
  }
  async handoff() { await this.attempt?.handoff(); }
  async finish(result: LiveCloseResult) { this.cancelled = true; await this.attempt?.finish(result); }
  async abandon(reason: CleanupReason) { this.cancelled = true; await this.attempt?.abandon(reason); }
}
export class AccountedSessionController extends SessionController {
  constructor(deps: SessionControllerDeps, private readonly accounting: ConversationAccounting) { super(deps); }
  get conversationId() { return this.accounting.conversationId; }
  override async endConversation(): Promise<void> {
    const revision = this.accounting.revision; await super.endConversation(); await this.accounting.end("user_end", revision);
  }
  override async cancel(): Promise<void> {
    const revision = this.accounting.revision; await super.cancel(); await this.accounting.end("setup_cancel", revision);
  }
}
export function createAccountedSessionController(): SessionController {
  const audio = new AudioController(), scope = new ConversationAccounting();
  const controller = new AccountedSessionController({
    createLive: () => new LiveClient({ backend: new BackendClient(), accounting: new LazyAccounting(scope),
      peerFactory: () => new RTCPeerConnection(), onRemoteStream: stream => controller.handleRemoteStream(stream) }),
    audio,
  }, scope);
  return controller;
}
