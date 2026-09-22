import type { ConversationRow, SessionRow } from "./types.js";
export function publicConversation(c: ConversationRow, serverTime: number) {
  return { conversationId: c.id, version: c.version, status: c.status, endReason: c.end_reason,
    createdAt: c.created_at, pausedAt: c.paused_at, endedAt: c.ended_at, resumeExpiresAt: c.resume_expires_at,
    productDeadlineAt: c.product_deadline_at, resumeAttemptId: c.resume_attempt_id, policy: JSON.parse(c.policy_json) as unknown, serverTime };
}
export function publicAttempt(s: SessionRow) {
  return { liveSessionId: s.id, conversationId: s.conversation_id, generation: s.generation, openaiSessionId: s.openai_session_id,
    state: s.state, initialMode: s.initial_mode, startReason: s.start_reason,
    providerRequestDispatchedAt: s.provider_request_dispatched_at, creationCompletedAt: s.creation_completed_at,
    handoffAckDeadlineAt: s.handoff_ack_deadline_at, handoffAcknowledgedAt: s.handoff_acknowledged_at,
    cleanupRequestedAt: s.cleanup_requested_at, cleanupReason: s.cleanup_reason,
    cleanupRetryExhaustedAt: s.cleanup_retry_exhausted_at, cleanupLastResult: s.cleanup_last_result,
    closeConfirmed: Boolean(s.close_confirmed), leaseReleasedAt: s.lease_released_at,
    providerFinalSeconds: s.provider_final_seconds, providerFinalSource: s.provider_final_source, usageQuality: s.usage_quality,
    resumeOutcome: s.resume_outcome, resumeClaimVersion: s.resume_claim_version, resumeClaimExpiresAt: s.resume_claim_expires_at };
}
