export type ConversationStatus = "active" | "paused" | "resuming" | "ended";
export type AttemptState = "creating" | "active" | "closing" | "closed" | "failed" | "unknown";
export type InitialMode = "setup" | "interpreter";
export type StartReason = "initial" | "bootstrap_replacement" | "resume";
export type ObservationSource = "browser" | "sideband";
export type ResumeOutcome = "pending" | "committed" | "aborted" | "expired";
export type CleanupResult = "closed_observed" | "terminal_not_live" | "retryable_error" | "blocked_auth_config";
export const CLIENT_CLEANUP_REASONS = ["response_not_received", "primary_startup_failed", "abandoned_connect", "hidden", "user_end", "cancelled", "replacement"] as const;
export const INTERNAL_CLEANUP_REASONS = ["server_shutdown", "client_disconnected", "handoff_timeout", "handoff_not_activatable", "resume_claim_expired"] as const;
export type CleanupReason = typeof CLIENT_CLEANUP_REASONS[number] | typeof INTERNAL_CLEANUP_REASONS[number];
export const END_REASONS = ["user_end", "setup_cancel", "background_timeout", "max_duration", "transport_failure", "abandoned"] as const;
export type EndReason = typeof END_REASONS[number];
export const RESUME_ABORT_REASONS = ["media_not_ready", "provider_creation_failed", "webrtc_failed", "restore_ack_failed", "hidden", "claim_timeout", "interrupted_by_restart", "user_end"] as const;
export type ResumeAbortReason = typeof RESUME_ABORT_REASONS[number];
export interface LedgerPolicy {
  policyVersion: string;
  conversationRetentionMs: number;
  maxProviderSessionMs: number;
  maxConversationElapsedMs: number;
  sessionCloseTimeoutMs: number;
  sessionHandoffAckTimeoutMs: number;
  resumeClaimTimeoutMs: number;
  backgroundSessionCloseEnabled: boolean;
}
export const DEFAULT_LEDGER_POLICY: Readonly<LedgerPolicy> = Object.freeze({
  policyVersion: "unit-economics-v1.1", conversationRetentionMs: 300000,
  maxProviderSessionMs: 900000, maxConversationElapsedMs: 900000,
  sessionCloseTimeoutMs: 15000, sessionHandoffAckTimeoutMs: 30000,
  resumeClaimTimeoutMs: 60000, backgroundSessionCloseEnabled: false,
});
export const CLEANUP_RETRY_TTL_MS = 7 * 86400000;
export interface ConversationRow {
  id: string; anonymous_user_id: string; create_request_id: string; version: number;
  status: ConversationStatus; end_reason: EndReason | null; resume_attempt_id: string | null;
  created_at: number; first_provider_dispatch_at: number | null; first_interpreter_observed_at: number | null;
  last_product_activity_received_at: number | null; paused_at: number | null; resume_expires_at: number | null;
  ended_at: number | null; product_deadline_at: number | null; app_version: string;
  conversation_policy_version: string; policy_json: string;
}
export interface SessionRow {
  id: string; conversation_id: string; generation: number; openai_session_id: string | null;
  usage_identity_version: 1 | null;
  state: AttemptState; initial_mode: InitialMode; start_reason: StartReason;
  request_fingerprint: string | null; request_conversation_version: number | null;
  resume_claimed_at: number | null; resume_claim_expires_at: number | null; resume_claim_version: number | null;
  resume_outcome: ResumeOutcome | null; model: string; transport: string; prompt_version: string; app_version: string;
  creation_requested_at: number; provider_request_dispatched_at: number | null; creation_completed_at: number | null;
  handoff_ack_deadline_at: number | null; handoff_acknowledged_at: number | null;
  cleanup_requested_at: number | null; cleanup_reason: CleanupReason | null; cleanup_attempt_count: number;
  cleanup_last_attempt_at: number | null; cleanup_next_attempt_at: number | null; cleanup_retry_expires_at: number | null;
  cleanup_retry_exhausted_at: number | null; cleanup_last_result: CleanupResult | null;
  cleanup_last_error_code: string | null; cleanup_blocked_at: number | null;
  provider_started_observed_at: number | null; interpreter_ready_observed_at: number | null; provider_expires_at: number | null;
  lease_id: string | null; lease_expires_at: number | null; lease_released_at: number | null;
  close_requested_at: number | null; closed_observed_at: number | null; last_report_received_at: number | null;
  close_confirmed: number; close_confirmation_source: ObservationSource | null;
  provider_close_reason: string | null; provider_close_reason_source: ObservationSource | null; app_end_reason: string | null;
  provider_checkpoint_seconds: number | null; provider_final_seconds: number | null;
  provider_checkpoint_source: ObservationSource | null; provider_final_source: ObservationSource | null;
  usage_conflict: number; usage_conflict_details: string | null;
  observed_wall_ms: number | null; setup_ms: number | null; active_interpreter_ms: number | null; visible_paused_ms: number | null;
  last_checkpoint_at_interpreter_ready: number | null; last_checkpoint_received_at: number | null;
  estimated_total_seconds: number | null; estimate_method_version: string | null; estimate_as_of: number | null;
  measurement_version: string | null; activity_report_seq: number | null;
  speech_measurement_version: string | null; speech_measurement_status: "complete" | "partial" | "unavailable" | null;
  metrics_json: string | null; pricing_policy_version: string | null;
  usage_quality: "final" | "partial" | "unknown" | "conflict";
  accepted_source_speech_ms: number | null; completed_source_speech_ms: number | null; app_metrics_finalized: number;
}
export interface AttemptInput {
  liveSessionId: string; conversationId: string; conversationVersion: number;
  initialMode: InitialMode; startReason: StartReason; fingerprint: string; usageIdentityVersion?: 1;
}
export interface CloseObservation { seconds?: number; reason?: string; invalidSeconds?: boolean; }
export class LedgerError extends Error {
  constructor(public readonly code: string, public readonly status = 409) { super(code); this.name = "LedgerError"; }
}
