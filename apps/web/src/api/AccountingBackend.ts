import type { UsageReport, UsageReceipt } from "../metrics/UsageTypes";
import type { CreateLiveSessionResponse } from "./BackendClient";
import type { CleanupReason, CloseMetadata } from "../session/MetadataDeliveryBudget";
import { MANAGED_SESSION_CREATE_TIMEOUT_MS, type AttemptProof, type CleanupTransport } from "../session/CleanupIntentOutbox";
export interface ConversationMetadata {
  conversationId: string; version: number; status: "active" | "paused" | "resuming" | "ended";
  productDeadlineAt: number | null; resumeExpiresAt: number | null; resumeAttemptId: string | null;
  serverTime: number; policy: { sessionCloseTimeoutMs: number; backgroundSessionCloseEnabled: boolean;
    conversationRetentionMs: number; maxProviderSessionMs: number; maxConversationElapsedMs: number;
    sessionHandoffAckTimeoutMs: number; resumeClaimTimeoutMs: number; policyVersion: string };
}
export interface ProviderCreateBody {
  sdp: string; liveSessionId: string; conversationId: string; conversationVersion: number;
  initialMode: "setup" | "interpreter"; startReason: "initial" | "bootstrap_replacement" | "resume";
}
export interface AttemptMetadata extends AttemptProof {
  liveSessionId: string; handoffAcknowledgedAt: number | null; conversation: ConversationMetadata;
  startReason?: ProviderCreateBody["startReason"];
  resumeOutcome?: "pending" | "committed" | "aborted" | "expired" | null;
  resumeClaimVersion?: number | null;
  resumeClaimExpiresAt?: number | null;
}
export interface ResumeClaimMetadata extends ConversationMetadata {
  attempt: { liveSessionId: string; state: "creating" | "active" | "closing" | "closed" | "failed" | "unknown";
    initialMode: ProviderCreateBody["initialMode"]; resumeOutcome: "pending" | "committed" | "aborted" | "expired";
    resumeClaimVersion: number; resumeClaimExpiresAt: number };
}
export type ResumeAbortReason = "media_not_ready" | "provider_creation_failed" | "webrtc_failed" |
  "restore_ack_failed" | "hidden" | "claim_timeout" | "interrupted_by_restart" | "user_end";
export interface LedgerApi extends CleanupTransport {
  usage?(id: string, conversationId: string, report: UsageReport, keepalive?: boolean): Promise<UsageReceipt>;
  policy(): Promise<{ usageLedgerEnabled: boolean; backgroundSessionCloseEnabled: boolean; creationPaused?: boolean }>;
  createConversation(requestId: string): Promise<ConversationMetadata>;
  createSession(body: ProviderCreateBody, signal: AbortSignal): Promise<CreateLiveSessionResponse>;
  handoff(id: string): Promise<AttemptMetadata>;
  readAttempt(id: string): Promise<AttemptMetadata>;
  pause(id: string, expectedVersion: number): Promise<ConversationMetadata>;
  claimResume(id: string, expectedVersion: number, resumeAttemptId: string, initialMode: ProviderCreateBody["initialMode"]): Promise<ResumeClaimMetadata>;
  completeResume(id: string, expectedVersion: number, resumeAttemptId: string, providerStartedObservedAt: number, readyStage: ProviderCreateBody["initialMode"]): Promise<ConversationMetadata>;
  abortResume(id: string, expectedVersion: number, resumeAttemptId: string, reason: ResumeAbortReason): Promise<ConversationMetadata>;
  end(id: string, version: number, reason: "user_end" | "setup_cancel"): Promise<ConversationMetadata>;
}
export class AccountingRequestError extends Error {
  constructor(readonly status: number, readonly code: string) { super(code); }
}
export class AccountingBackend implements LedgerApi {
  private async json<T>(url: string, method = "GET", body?: unknown, signal?: AbortSignal, timeoutMs = 10000, keepalive = false): Promise<T> {
    const controller = new AbortController(), abort = () => controller.abort();
    if (signal?.aborted) abort(); else signal?.addEventListener("abort", abort, { once: true });
    const timer = setTimeout(abort, timeoutMs);
    try {
      const response = await fetch(url, { method, keepalive, credentials: "same-origin", signal: controller.signal,
        ...(body !== undefined ? { headers: { "Content-Type": "application/json" }, body: JSON.stringify(body) } : {}) });
      if (!response.ok) {
        const data = await response.json().catch(() => ({})) as { code?: string };
        throw new AccountingRequestError(response.status, data.code ?? "accounting_request_failed");
      }
      return await response.json() as T;
    } finally { clearTimeout(timer); signal?.removeEventListener("abort", abort); }
  }
  usage(id: string, conversationId: string, report: UsageReport, keepalive = false): Promise<UsageReceipt> {
    return this.json(`/api/live/session/${encodeURIComponent(id)}/usage`, "PUT", { conversationId, ...report }, undefined, 10000, keepalive);
  }
  async policy(): Promise<{ usageLedgerEnabled: boolean; backgroundSessionCloseEnabled: boolean; creationPaused?: boolean }> {
    try { return await this.json("/api/policy"); }
    catch (error) {
      // Only an explicitly older deployment may use the legacy protocol; 5xx/network is fail-closed.
      if (error instanceof AccountingRequestError && error.status === 404) return { usageLedgerEnabled: false, backgroundSessionCloseEnabled: false };
      throw error;
    }
  }
  createConversation(createRequestId: string): Promise<ConversationMetadata> { return this.json("/api/conversations", "POST", { createRequestId, appVersion: "ledger-client-v1" }); }
  createSession(body: ProviderCreateBody, signal: AbortSignal): Promise<CreateLiveSessionResponse> { return this.json("/api/live/session", "POST", body, signal, MANAGED_SESSION_CREATE_TIMEOUT_MS); }
  handoff(id: string): Promise<AttemptMetadata> { return this.json(`/api/live/session/${encodeURIComponent(id)}/handoff`, "POST", {}); }
  readAttempt(id: string): Promise<AttemptMetadata> { return this.json(`/api/live/session/${encodeURIComponent(id)}`); }
  readConversation(id: string): Promise<ConversationMetadata> { return this.json(`/api/conversations/${encodeURIComponent(id)}`); }
  pause(id: string, expectedVersion: number): Promise<ConversationMetadata> { return this.json(`/api/conversations/${encodeURIComponent(id)}/pause`, "POST", { expectedVersion }); }
  claimResume(id: string, expectedVersion: number, resumeAttemptId: string, initialMode: ProviderCreateBody["initialMode"]): Promise<ResumeClaimMetadata> {
    return this.json(`/api/conversations/${encodeURIComponent(id)}/resume`, "POST", { expectedVersion, resumeAttemptId, initialMode });
  }
  completeResume(id: string, expectedVersion: number, resumeAttemptId: string, providerStartedObservedAt: number, readyStage: ProviderCreateBody["initialMode"]): Promise<ConversationMetadata> {
    return this.json(`/api/conversations/${encodeURIComponent(id)}/resume/complete`, "POST", { expectedVersion, resumeAttemptId, providerStartedObservedAt, readyStage });
  }
  abortResume(id: string, expectedVersion: number, resumeAttemptId: string, reason: ResumeAbortReason): Promise<ConversationMetadata> {
    return this.json(`/api/conversations/${encodeURIComponent(id)}/resume/abort`, "POST", { expectedVersion, resumeAttemptId, reason });
  }
  cleanup(id: string, reason: CleanupReason): Promise<AttemptProof> { return this.json(`/api/live/session/${encodeURIComponent(id)}/cleanup`, "POST", { reason }); }
  recover(id: string, conversationId: string, reason: CleanupReason): Promise<AttemptProof> {
    return this.json(`/api/live/session/${encodeURIComponent(id)}/recover`, "POST", { conversationId, reason });
  }
  closed(id: string, observation: CloseMetadata): Promise<AttemptProof> { return this.json(`/api/live/session/${encodeURIComponent(id)}/closed`, "POST", observation); }
  end(id: string, expectedVersion: number, reason: "user_end" | "setup_cancel"): Promise<ConversationMetadata> { return this.json(`/api/conversations/${encodeURIComponent(id)}/end`, "POST", { expectedVersion, reason }); }
}
