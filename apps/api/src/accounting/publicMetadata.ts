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
    providerCheckpointSeconds: s.provider_checkpoint_seconds, providerCheckpointSource: s.provider_checkpoint_source,
    closeConfirmationSource: s.close_confirmation_source, providerCloseReason: s.provider_close_reason, providerCloseReasonSource: s.provider_close_reason_source,
    usageConflict: Boolean(s.usage_conflict), usageConflictDetails: s.usage_conflict_details ? JSON.parse(s.usage_conflict_details) as unknown : null,
    applicationMetrics: { observedWallMs: s.observed_wall_ms, setupMs: s.setup_ms, activeInterpreterMs: s.active_interpreter_ms,
      visiblePausedMs: s.visible_paused_ms, acceptedSourceSpeechMs: s.accepted_source_speech_ms, completedSourceSpeechMs: s.completed_source_speech_ms,
      activityReportSeq: s.activity_report_seq, appMetricsFinalized: Boolean(s.app_metrics_finalized), measurementVersion: s.measurement_version,
      speechMeasurementVersion: s.speech_measurement_version, speechMeasurementStatus: s.speech_measurement_status,
      counters: s.metrics_json ? JSON.parse(s.metrics_json) as unknown : null },
    providerFinalSeconds: s.provider_final_seconds, providerFinalSource: s.provider_final_source, usageQuality: s.usage_quality,
    resumeOutcome: s.resume_outcome, resumeClaimVersion: s.resume_claim_version, resumeClaimExpiresAt: s.resume_claim_expires_at };
}
