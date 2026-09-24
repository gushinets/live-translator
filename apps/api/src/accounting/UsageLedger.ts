import { mergeUsage, mergeAppMetrics, type UsageReport } from "./mergeUsage.js";
import { randomUUID } from "node:crypto";
import type { DatabaseSync, SQLInputValue } from "node:sqlite";
import { transaction } from "../persistence/database.js";
import { CLEANUP_RETRY_TTL_MS, DEFAULT_LEDGER_POLICY, LedgerError,
  type AttemptInput, type CleanupReason, type CloseObservation, type ConversationRow,
  type EndReason, type InitialMode, type LedgerPolicy, type ObservationSource,
  type ResumeAbortReason, type SessionRow } from "./types.js";

const terminal = (s: SessionRow) => s.state === "closed" || s.state === "failed";
const elapsed = (deadline: number | null, now: number) => deadline !== null && now >= deadline;
const strength = (s: ObservationSource | null) => s === "sideband" ? 2 : s === "browser" ? 1 : 0;

/** SQL is authoritative for lifecycle and recovery; network work is outside transactions. */
export class UsageLedger {
  private readonly clock: () => number;
  readonly policy: LedgerPolicy;
  constructor(readonly db: DatabaseSync, options: { now?: () => number; policy?: LedgerPolicy } = {}) {
    this.clock = options.now ?? Date.now;
    this.policy = { ...DEFAULT_LEDGER_POLICY, ...options.policy };
  }
  now() { return this.clock(); }
  private atomic<T>(work: () => T | LedgerError): T {
    // Domain rejection may follow a committed expiry/fence. Throwing inside would undo that fence.
    const result = transaction(this.db, work);
    if (result instanceof LedgerError) throw result;
    return result;
  }
  private conversation(id: string): ConversationRow {
    const row = this.db.prepare("SELECT * FROM conversations WHERE id=?").get(id);
    if (!row) throw new LedgerError("not_found", 404);
    return row as unknown as ConversationRow;
  }
  private attempt(id: string): SessionRow {
    const row = this.db.prepare("SELECT * FROM live_sessions WHERE id=?").get(id);
    if (!row) throw new LedgerError("not_found", 404);
    return row as unknown as SessionRow;
  }
  private owned(owner: string, id: string): ConversationRow {
    const c = this.conversation(id);
    if (c.anonymous_user_id !== owner) throw new LedgerError("not_found", 404);
    return c;
  }
  private ownedAttempt(owner: string, id: string): SessionRow {
    const row = this.attempt(id); this.owned(owner, row.conversation_id); return row;
  }
  private sessions(id: string): SessionRow[] {
    return this.db.prepare("SELECT * FROM live_sessions WHERE conversation_id=? ORDER BY generation").all(id) as unknown as SessionRow[];
  }
  private policyFor(c: ConversationRow): LedgerPolicy { return JSON.parse(c.policy_json) as LedgerPolicy; }
  private updateAttempt(id: string, fields: Partial<SessionRow>): void {
    const entries = Object.entries(fields);
    if (!entries.length) return;
    // Keys are typed literals from server transition code, never request body keys.
    this.db.prepare(`UPDATE live_sessions SET ${entries.map(([key]) => `${key}=?`).join(",")} WHERE id=?`)
      .run(...entries.map(([, value]) => value as SQLInputValue), id);
  }
  private updateConversation(id: string, fields: Partial<ConversationRow>): void {
    const entries = Object.entries(fields);
    this.db.prepare(`UPDATE conversations SET ${entries.map(([key]) => `${key}=?`).join(",")} WHERE id=?`)
      .run(...entries.map(([, value]) => value as SQLInputValue), id);
  }
  getConversation(owner: string, id: string): ConversationRow {
    this.owned(owner, id); this.atomic(() => this.expireConversationInternal(id, this.now()));
    return this.owned(owner, id);
  }
  getAttempt(owner: string, id: string): SessionRow { return this.ownedAttempt(owner, id); }
  getAttemptInternal(id: string): SessionRow { return this.attempt(id); }
  getAttemptByProvider(owner: string, providerId: string): SessionRow {
    const row = this.db.prepare("SELECT id FROM live_sessions WHERE openai_session_id=?").get(providerId);
    if (!row) throw new LedgerError("not_found", 404);
    return this.ownedAttempt(owner, String(row.id));
  }
  listAttempts(owner: string, id: string): SessionRow[] { this.owned(owner, id); return this.sessions(id); }
  createConversation(owner: string, requestId: string, appVersion: string): ConversationRow {
    return this.atomic(() => {
      const old = this.db.prepare("SELECT * FROM conversations WHERE anonymous_user_id=? AND create_request_id=?").get(owner, requestId) as unknown as ConversationRow | undefined;
      if (old) return old.app_version === appVersion ? old : new LedgerError("conversation_request_conflict");
      const id = randomUUID();
      this.db.prepare("INSERT INTO conversations(id,anonymous_user_id,create_request_id,status,created_at,app_version,conversation_policy_version,policy_json) VALUES(?,?,?,'active',?,?,?,?)")
        .run(id, owner, requestId, this.now(), appVersion, this.policy.policyVersion, JSON.stringify(this.policy));
      return this.conversation(id);
    });
  }
  private progressing(id: string, except = ""): boolean {
    return Boolean(this.db.prepare("SELECT 1 FROM live_sessions WHERE conversation_id=? AND state IN ('creating','active','closing') AND id<>? LIMIT 1").get(id, except));
  }
  private insertAttempt(c: ConversationRow, id: string, mode: InitialMode, reason: AttemptInput["startReason"], resume?: { version: number; expires: number }): SessionRow {
    const fence = this.db.prepare("SELECT conversation_id FROM live_session_recovery_fences WHERE id=?").get(id) as { conversation_id: string } | undefined;
    if (fence) {
      if (fence.conversation_id !== c.id) throw new LedgerError("attempt_conflict");
      throw new LedgerError("attempt_retired", 410);
    }
    const generation = Number(this.db.prepare("SELECT COALESCE(MAX(generation),0)+1 AS n FROM live_sessions WHERE conversation_id=?").get(c.id)!.n);
    this.db.prepare(`INSERT INTO live_sessions(id,conversation_id,generation,state,initial_mode,start_reason,model,transport,prompt_version,app_version,creation_requested_at,resume_claimed_at,resume_claim_expires_at,resume_claim_version,resume_outcome)
      VALUES(?,?,?,'creating',?,?,'gpt-live-1','webrtc','silent-pre-interpreter-v1',?,?,?,?,?,?)`)
      .run(id, c.id, generation, mode, reason, c.app_version, this.now(), resume ? this.now() : null, resume?.expires ?? null, resume?.version ?? null, resume ? "pending" : null);
    return this.attempt(id);
  }
  registerAttempt(owner: string, input: AttemptInput): SessionRow {
    if (!["initial", "bootstrap_replacement", "resume"].includes(input.startReason)) throw new LedgerError("invalid_start_reason", 400);
    return this.atomic(() => {
      this.owned(owner, input.conversationId); this.expireConversationInternal(input.conversationId, this.now());
      const c = this.conversation(input.conversationId);
      const old = this.db.prepare("SELECT * FROM live_sessions WHERE id=?").get(input.liveSessionId) as unknown as SessionRow | undefined;
      if (old) {
        this.ownedAttempt(owner, old.id);
        if (old.conversation_id !== c.id || old.initial_mode !== input.initialMode || old.start_reason !== input.startReason ||
            (old.request_conversation_version !== null && old.request_conversation_version !== input.conversationVersion) ||
            (old.request_fingerprint !== null && old.request_fingerprint !== input.fingerprint)) return new LedgerError("attempt_conflict");
        if (old.request_fingerprint === null && old.start_reason === "resume") {
          if (!this.validClaim(c, old, this.now()) || input.conversationVersion !== old.resume_claim_version) return new LedgerError("resume_not_activatable");
          this.updateAttempt(old.id, { request_fingerprint: input.fingerprint, request_conversation_version: input.conversationVersion });
        }
        return this.attempt(old.id);
      }
      if (c.status === "ended") return new LedgerError("conversation_expired", 410);
      if (c.status !== "active" || c.version !== input.conversationVersion || input.startReason === "resume") return new LedgerError("conversation_version_conflict");
      if (this.progressing(c.id)) return new LedgerError("attempt_in_progress");
      const row = this.insertAttempt(c, input.liveSessionId, input.initialMode, input.startReason);
      this.updateAttempt(row.id, { request_fingerprint: input.fingerprint, request_conversation_version: input.conversationVersion });
      return this.attempt(row.id);
    });
  }
  dispatchProviderAttempt(owner: string, id: string, version: number, leaseId: string, leaseExpiresAt: number): SessionRow {
    return this.atomic(() => {
      const before = this.ownedAttempt(owner, id);
      this.expireConversationInternal(before.conversation_id, this.now());
      const s = this.attempt(id), c = this.conversation(s.conversation_id);
      if (s.provider_request_dispatched_at !== null) return new LedgerError("attempt_already_dispatched");
      if (s.cleanup_requested_at !== null || s.state !== "creating" || !s.request_fingerprint) return new LedgerError("attempt_not_dispatchable");
      if (c.version !== version || (s.start_reason === "resume" ? !this.validClaim(c, s, this.now()) : c.status !== "active")) {
        this.cleanupInternal(s, "handoff_not_activatable", this.now()); return new LedgerError("conversation_not_activatable");
      }
      if (c.first_provider_dispatch_at === null) {
        const deadline = this.now() + this.policyFor(c).maxConversationElapsedMs;
        this.updateConversation(c.id, { first_provider_dispatch_at: this.now(), product_deadline_at: deadline });
        if (s.resume_claim_expires_at !== null) this.updateAttempt(id, { resume_claim_expires_at: Math.min(s.resume_claim_expires_at, deadline) });
      }
      this.updateAttempt(id, { provider_request_dispatched_at: this.now(), lease_id: leaseId, lease_expires_at: leaseExpiresAt });
      return this.attempt(id);
    });
  }
  recordProviderCreated(id: string, providerId: string, expiresAt?: number): SessionRow {
    return this.atomic(() => {
      const s = this.attempt(id), now = this.now();
      if (s.provider_request_dispatched_at === null) return new LedgerError("result_without_dispatch");
      if (s.openai_session_id !== null && s.openai_session_id !== providerId) return new LedgerError("provider_id_conflict");
      const c = this.conversation(s.conversation_id);
      this.updateAttempt(id, { openai_session_id: providerId, creation_completed_at: s.creation_completed_at ?? now,
        handoff_ack_deadline_at: s.handoff_ack_deadline_at ?? now + this.policyFor(c).sessionHandoffAckTimeoutMs,
        provider_expires_at: expiresAt ?? s.provider_expires_at });
      const current = this.attempt(id);
      if (current.cleanup_requested_at !== null && !terminal(current)) this.updateAttempt(id, {
        state: this.progressing(c.id, id) ? "unknown" : "closing",
        cleanup_next_attempt_at: current.cleanup_retry_exhausted_at === null && current.cleanup_blocked_at === null ? now : null });
      this.guardHandoffInternal(id, now); return this.attempt(id);
    });
  }
  private validClaim(c: ConversationRow, s: SessionRow, now: number): boolean {
    return c.status === "resuming" && c.resume_attempt_id === s.id && s.resume_outcome === "pending" && s.cleanup_requested_at === null &&
      s.resume_claim_expires_at !== null && !elapsed(s.resume_claim_expires_at, now) &&
      c.resume_expires_at !== null && !elapsed(c.resume_expires_at, now) && !elapsed(c.product_deadline_at, now);
  }
  private guardHandoffInternal(id: string, now: number): boolean {
    let s = this.attempt(id); const c = this.conversation(s.conversation_id);
    if (terminal(s) || s.cleanup_requested_at !== null) return false;
    if (s.start_reason === "resume" && s.resume_outcome === "committed" && s.handoff_acknowledged_at !== null) {
      if (c.status === "active" && !elapsed(c.product_deadline_at, now)) return true;
      if (c.status === "active") this.endInternal(c, "max_duration", now);
      this.cleanupInternal(this.attempt(id), "handoff_not_activatable", now); return false;
    }
    if (s.start_reason === "resume" && !this.validClaim(c, s, now)) {
      this.expireResumeInternal(c, s, now, true); return false;
    }
    if (s.start_reason !== "resume" && (c.status !== "active" || elapsed(c.product_deadline_at, now))) {
      if (c.status === "active" && elapsed(c.product_deadline_at, now)) this.endInternal(c, "max_duration", now);
      this.cleanupInternal(this.attempt(id), "handoff_not_activatable", now); return false;
    }
    s = this.attempt(id);
    if (s.handoff_acknowledged_at === null && elapsed(s.handoff_ack_deadline_at, now)) {
      this.cleanupInternal(s, "handoff_timeout", now); return false;
    }
    return true;
  }
  acknowledgeHandoff(owner: string, id: string): SessionRow {
    return this.atomic(() => {
      this.ownedAttempt(owner, id);
      if (!this.guardHandoffInternal(id, this.now())) return new LedgerError("handoff_not_activatable");
      const s = this.attempt(id);
      if (!s.openai_session_id || s.creation_completed_at === null || s.handoff_ack_deadline_at === null) return new LedgerError("handoff_result_missing");
      if (s.handoff_acknowledged_at !== null) return s;
      if (s.state !== "creating") return new LedgerError("handoff_not_activatable");
      this.updateAttempt(id, { handoff_acknowledged_at: this.now(), state: "active" }); return this.attempt(id);
    });
  }
  private cleanupInternal(s: SessionRow, reason: CleanupReason, now: number): void {
    if (terminal(s)) return;
    if (s.provider_request_dispatched_at === null) {
      this.updateAttempt(s.id, { cleanup_requested_at: s.cleanup_requested_at ?? now, cleanup_reason: s.cleanup_reason ?? reason,
        state: "failed", lease_released_at: s.lease_released_at ?? now, cleanup_next_attempt_at: null }); return;
    }
    this.updateAttempt(s.id, { cleanup_requested_at: s.cleanup_requested_at ?? now, cleanup_reason: s.cleanup_reason ?? reason,
      cleanup_retry_expires_at: s.cleanup_retry_expires_at ?? (s.cleanup_requested_at ?? now) + CLEANUP_RETRY_TTL_MS,
      state: this.progressing(s.conversation_id, s.id) ? "unknown" : "closing", close_requested_at: s.close_requested_at ?? now,
      cleanup_next_attempt_at: s.cleanup_requested_at === null && s.openai_session_id !== null && s.cleanup_blocked_at === null ? now : s.cleanup_next_attempt_at });
  }
  requestCleanup(id: string, reason: CleanupReason): SessionRow {
    return this.atomic(() => { this.cleanupInternal(this.attempt(id), reason, this.now()); return this.attempt(id); });
  }
  fenceRecovery(owner: string, conversationId: string, id: string, reason: CleanupReason): { attempt: SessionRow | null; fencedAt: number } {
    return this.atomic(() => {
      this.owned(owner, conversationId);
      const existing = this.db.prepare("SELECT * FROM live_sessions WHERE id=?").get(id) as unknown as SessionRow | undefined;
      if (existing) {
        this.ownedAttempt(owner, id);
        if (existing.conversation_id !== conversationId) return new LedgerError("not_found", 404);
        const now = this.now();
        this.cleanupInternal(existing, reason, now);
        return { attempt: this.attempt(id), fencedAt: now };
      }
      const old = this.db.prepare("SELECT conversation_id,created_at FROM live_session_recovery_fences WHERE id=?").get(id) as
        { conversation_id: string; created_at: number } | undefined;
      if (old) {
        if (old.conversation_id !== conversationId) return new LedgerError("not_found", 404);
        return { attempt: null, fencedAt: Number(old.created_at) };
      }
      const now = this.now();
      this.db.prepare("INSERT INTO live_session_recovery_fences(id,conversation_id,cleanup_reason,created_at) VALUES(?,?,?,?)")
        .run(id, conversationId, reason, now);
      return { attempt: null, fencedAt: now };
    });
  }
  recordCreateFailure(id: string, definitive: boolean): SessionRow {
    return this.atomic(() => {
      const s = this.attempt(id);
      if (terminal(s) || s.creation_completed_at !== null) return s;
      if (definitive && s.openai_session_id === null) this.updateAttempt(id, { state: "failed", lease_released_at: s.lease_released_at ?? this.now(), cleanup_next_attempt_at: null });
      else {
        const providerExpiresAt = s.provider_request_dispatched_at === null ? s.provider_expires_at :
          s.provider_expires_at ?? s.provider_request_dispatched_at + this.policyFor(this.conversation(s.conversation_id)).maxProviderSessionMs;
        this.updateAttempt(id, { state: s.cleanup_requested_at !== null && !this.progressing(s.conversation_id, id) ? "closing" : "unknown",
          provider_expires_at: providerExpiresAt });
      }
      return this.attempt(id);
    });
  }
  private closeInternal(id: string, observation: CloseObservation, source: ObservationSource): SessionRow {
    const s = this.attempt(id), now = this.now();
    const fields: Partial<SessionRow> = { state: "closed", close_confirmed: 1, closed_observed_at: s.closed_observed_at ?? now,
      lease_released_at: s.lease_released_at ?? now, last_report_received_at: now, cleanup_next_attempt_at: null, cleanup_blocked_at: null,
      close_confirmation_source: strength(source) > strength(s.close_confirmation_source) ? source : s.close_confirmation_source };
    Object.assign(fields, mergeUsage(s, { closed: observation }, source, now));
    this.updateAttempt(id, fields); return this.attempt(id);
  }
  recordProviderClosed(id: string, observation: CloseObservation, source: ObservationSource): SessionRow {
    return this.atomic(() => {
      const s = this.attempt(id);
      if (s.state === "failed" || s.provider_request_dispatched_at === null) return s;
      return this.closeInternal(id, observation, source);
    });
  }
  /** One commit for the whole report; close uses the same primitive as PR-2 observers. */
  recordUsage(owner: string, id: string, report: UsageReport, source: ObservationSource = "browser") {
    return this.atomic(() => {
      let row = this.ownedAttempt(owner, id);
      const now = this.now();
      if (row.provider_request_dispatched_at !== null && row.state !== "failed") {
        this.updateAttempt(id, mergeUsage(row, { checkpointSeconds: report.checkpointSeconds }, source, now));
        for (const closed of [report.providerClosed, report.conflictingProviderClosed]) if (closed) this.closeInternal(id, closed, source);
      }
      row = this.attempt(id);
      const app = report.invalidAppMetrics ? { accepted: false, reason: "invalid_app_metrics", fields: {} }
        : report.app ? mergeAppMetrics(row, report.app) : { accepted: true, fields: {} };
      this.updateAttempt(id, { ...app.fields, last_report_received_at: now });
      if (report.app && app.accepted && Object.keys(app.fields).length) {
        const c = this.conversation(row.conversation_id);
        this.updateConversation(c.id, { last_product_activity_received_at: now,
          first_interpreter_observed_at: c.first_interpreter_observed_at ?? report.app.interpreterReadyObservedAt ?? null });
      }
      return { row: this.attempt(id), appAccepted: app.accepted, appRejection: app.reason };
    });
  }
  recordProviderTerminalNotLive(id: string): SessionRow {
    return this.atomic(() => {
      const s = this.attempt(id); if (terminal(s)) return s;
      const now = this.now();
      this.updateAttempt(id, { state: "closed", cleanup_attempt_count: s.cleanup_attempt_count + 1, cleanup_last_attempt_at: now,
        cleanup_last_result: "terminal_not_live", cleanup_last_error_code: null, cleanup_next_attempt_at: null,
        cleanup_blocked_at: null, lease_released_at: s.lease_released_at ?? now }); return this.attempt(id);
    });
  }
  releaseAdmission(owner: string, providerId: string): SessionRow {
    return this.atomic(() => {
      const s = this.getAttemptByProvider(owner, providerId);
      // Local cooperative release is not proof of provider closure or cost finality.
      this.updateAttempt(s.id, { lease_released_at: s.lease_released_at ?? this.now(), state: terminal(s) ? s.state : "unknown" }); return this.attempt(s.id);
    });
  }
  reservations(): SessionRow[] {
    return this.db.prepare("SELECT * FROM live_sessions WHERE lease_id IS NOT NULL AND lease_released_at IS NULL AND lease_expires_at>? AND state NOT IN ('closed','failed')").all(this.now()) as unknown as SessionRow[];
  }
  dueCleanup(limit: number): SessionRow[] {
    return this.db.prepare(`SELECT * FROM live_sessions WHERE cleanup_requested_at IS NOT NULL AND openai_session_id IS NOT NULL
      AND state NOT IN ('closed','failed') AND cleanup_retry_exhausted_at IS NULL AND cleanup_retry_expires_at>?
      AND cleanup_blocked_at IS NULL AND (cleanup_next_attempt_at IS NULL OR cleanup_next_attempt_at<=?)
      ORDER BY COALESCE(cleanup_next_attempt_at,cleanup_requested_at),cleanup_requested_at,id LIMIT ?`).all(this.now(), this.now(), limit) as unknown as SessionRow[];
  }
  expiredCleanup(limit: number): SessionRow[] {
    return this.db.prepare("SELECT * FROM live_sessions WHERE cleanup_requested_at IS NOT NULL AND state NOT IN ('closed','failed') AND cleanup_retry_exhausted_at IS NULL AND cleanup_retry_expires_at<=? ORDER BY cleanup_retry_expires_at,id LIMIT ?").all(this.now(), limit) as unknown as SessionRow[];
  }
  exhaustCleanup(id: string): SessionRow {
    return this.atomic(() => {
      const s = this.attempt(id);
      if (!terminal(s) && s.cleanup_retry_exhausted_at === null && elapsed(s.cleanup_retry_expires_at, this.now())) this.updateAttempt(id, { cleanup_retry_exhausted_at: this.now(), cleanup_next_attempt_at: null, state: "unknown" });
      return this.attempt(id);
    });
  }
  recordCleanupFailure(id: string, kind: "retryable_error" | "blocked_auth_config", code: string): SessionRow {
    return this.atomic(() => {
      const s = this.attempt(id), now = this.now(); if (terminal(s)) return s;
      const count = s.cleanup_attempt_count + 1, expired = elapsed(s.cleanup_retry_expires_at, now);
      this.updateAttempt(id, { cleanup_attempt_count: count, cleanup_last_attempt_at: now, cleanup_last_result: kind,
        cleanup_last_error_code: code.replace(/[^a-zA-Z0-9_-]/g, "_").slice(0, 64),
        cleanup_next_attempt_at: expired || kind === "blocked_auth_config" ? null : now + Math.min(30000, 1000 * 2 ** Math.min(count - 1, 5)),
        cleanup_blocked_at: kind === "blocked_auth_config" ? now : null,
        cleanup_retry_exhausted_at: expired ? s.cleanup_retry_exhausted_at ?? now : s.cleanup_retry_exhausted_at, state: "unknown" });
      return this.attempt(id);
    });
  }
  recordCleanupClosed(id: string, observation: CloseObservation): SessionRow {
    return this.atomic(() => {
      const s = this.attempt(id); if (s.state === "failed") return s;
      // The primary transport may have reported close while Sideband was in flight.
      // Still merge its final/provenance; closeInternal preserves the original release.
      this.closeInternal(id, observation, "sideband");
      this.updateAttempt(id, { cleanup_attempt_count: s.cleanup_attempt_count + 1, cleanup_last_attempt_at: this.now(), cleanup_last_result: "closed_observed", cleanup_last_error_code: null }); return this.attempt(id);
    });
  }
  rearmBlockedCleanup(cause: "startup" | "config_reload" | "credential_refresh" | "operator_retry"): void {
    if (!["startup", "config_reload", "credential_refresh", "operator_retry"].includes(cause)) throw new LedgerError("invalid_rearm_cause", 400);
    this.atomic(() => { this.db.prepare("UPDATE live_sessions SET cleanup_blocked_at=NULL,cleanup_last_result=NULL,cleanup_last_error_code=NULL,cleanup_next_attempt_at=? WHERE cleanup_blocked_at IS NOT NULL AND cleanup_retry_exhausted_at IS NULL AND cleanup_retry_expires_at>? AND state NOT IN ('closed','failed')").run(this.now(), this.now()); });
  }
  private endInternal(c: ConversationRow, reason: EndReason, now: number): void {
    if (c.status === "ended") return;
    if (c.resume_attempt_id !== null) this.updateAttempt(c.resume_attempt_id, { resume_outcome: "aborted", app_end_reason: reason });
    this.updateConversation(c.id, { status: "ended", end_reason: reason, ended_at: now, version: c.version + 1, resume_attempt_id: null });
    for (const s of this.sessions(c.id)) if (!terminal(s)) this.cleanupInternal(s, reason === "max_duration" ? "handoff_not_activatable" : "user_end", now);
  }
  endConversation(owner: string, id: string, version: number, reason: EndReason): ConversationRow {
    return this.atomic(() => {
      const c = this.owned(owner, id); if (c.status === "ended") return c;
      if (c.version !== version) return new LedgerError("conversation_version_conflict");
      this.endInternal(c, reason, this.now()); return this.conversation(id);
    });
  }
  pauseConversation(owner: string, id: string, version: number): ConversationRow {
    return this.atomic(() => {
      this.owned(owner, id); this.expireConversationInternal(id, this.now()); const c = this.conversation(id);
      if (c.status === "paused" && c.version === version + 1) return c;
      if (c.status === "ended") return new LedgerError("conversation_expired", 410);
      if (c.status !== "active" || c.version !== version) return new LedgerError("conversation_version_conflict");
      this.updateConversation(id, { status: "paused", version: c.version + 1, paused_at: this.now(), resume_expires_at: this.now() + this.policyFor(c).conversationRetentionMs });
      for (const s of this.sessions(id)) if (!terminal(s)) this.cleanupInternal(s, "hidden", this.now());
      return this.conversation(id);
    });
  }
  claimResume(owner: string, id: string, version: number, attemptId: string, mode: InitialMode): { conversation: ConversationRow; attempt: SessionRow } {
    return this.atomic(() => {
      this.owned(owner, id); this.expireConversationInternal(id, this.now()); const c = this.conversation(id);
      const old = this.db.prepare("SELECT * FROM live_sessions WHERE id=?").get(attemptId) as unknown as SessionRow | undefined;
      if (old) {
        this.ownedAttempt(owner, attemptId);
        if (old.conversation_id !== id || old.start_reason !== "resume" || old.resume_claim_version !== version + 1 || old.initial_mode !== mode) return new LedgerError("resume_claim_conflict");
        return { conversation: c, attempt: old };
      }
      if (c.status === "ended") return new LedgerError("conversation_expired", 410);
      if (c.status !== "paused" || c.version !== version) return new LedgerError("conversation_version_conflict");
      if (this.progressing(id)) return new LedgerError("attempt_in_progress");
      const expires = Math.min(c.resume_expires_at!, c.product_deadline_at ?? Infinity, this.now() + this.policyFor(c).resumeClaimTimeoutMs);
      const s = this.insertAttempt(c, attemptId, mode, "resume", { version: version + 1, expires });
      this.updateConversation(id, { status: "resuming", version: version + 1, resume_attempt_id: attemptId }); return { conversation: this.conversation(id), attempt: s };
    });
  }
  completeResume(owner: string, id: string, version: number, attemptId: string, startedAt: number, stage: InitialMode): ConversationRow {
    return this.atomic(() => {
      this.owned(owner, id); const s = this.ownedAttempt(owner, attemptId);
      if (s.conversation_id !== id || s.resume_claim_version !== version || s.initial_mode !== stage) return new LedgerError("resume_claim_conflict");
      this.expireConversationInternal(id, this.now()); const c = this.conversation(id), current = this.attempt(attemptId);
      if (current.resume_outcome === "committed") {
        if (current.provider_started_observed_at !== startedAt || (stage === "interpreter" && current.interpreter_ready_observed_at !== startedAt)) return new LedgerError("resume_claim_conflict");
        return c;
      }
      if (!this.validClaim(c, current, this.now()) || current.state !== "active" || current.handoff_acknowledged_at === null) return new LedgerError("resume_not_activatable");
      this.updateAttempt(attemptId, { resume_outcome: "committed", provider_started_observed_at: startedAt, interpreter_ready_observed_at: stage === "interpreter" ? startedAt : null });
      this.updateConversation(id, { status: "active", resume_attempt_id: null, version: c.version + 1, paused_at: null, resume_expires_at: null }); return this.conversation(id);
    });
  }
  private rollbackResume(c: ConversationRow, s: SessionRow, now: number, outcome: "aborted" | "expired", reason: ResumeAbortReason): void {
    if (s.resume_outcome !== "pending") return;
    this.cleanupInternal(s, "resume_claim_expired", now); this.updateAttempt(s.id, { resume_outcome: outcome, app_end_reason: reason });
    if (c.status !== "resuming" || c.resume_attempt_id !== s.id) return;
    const endReason = elapsed(c.product_deadline_at, now) ? "max_duration" : elapsed(c.resume_expires_at, now) ? "background_timeout" : null;
    this.updateConversation(c.id, { status: endReason ? "ended" : "paused", resume_attempt_id: null, version: c.version + 1, end_reason: endReason, ended_at: endReason ? now : null });
  }
  private expireResumeInternal(c: ConversationRow, s: SessionRow, now: number, invalid = false): void {
    if (s.resume_outcome === "pending" && (invalid || elapsed(s.resume_claim_expires_at, now) || elapsed(c.resume_expires_at, now) || elapsed(c.product_deadline_at, now))) this.rollbackResume(c, s, now, "expired", "claim_timeout");
  }
  abortResume(owner: string, id: string, version: number, attemptId: string, reason: ResumeAbortReason): ConversationRow {
    return this.atomic(() => {
      const c = this.owned(owner, id), s = this.ownedAttempt(owner, attemptId);
      if (s.conversation_id !== id || s.resume_claim_version !== version) return new LedgerError("resume_claim_conflict");
      if (s.resume_outcome === "aborted") return s.app_end_reason === reason ? c : new LedgerError("resume_claim_conflict");
      if (s.resume_outcome !== "pending" || c.resume_attempt_id !== s.id) return new LedgerError("resume_claim_conflict");
      this.rollbackResume(c, s, this.now(), "aborted", reason); return this.conversation(id);
    });
  }
  private expireConversationInternal(id: string, now: number): void {
    const c = this.conversation(id);
    if (c.status === "resuming" && c.resume_attempt_id !== null) { this.expireResumeInternal(c, this.attempt(c.resume_attempt_id), now); return; }
    if (c.status === "ended") return;
    if (elapsed(c.product_deadline_at, now)) this.endInternal(c, "max_duration", now);
    else if (c.status === "paused" && elapsed(c.resume_expires_at, now)) this.endInternal(c, "background_timeout", now);
  }
  private expireAmbiguousCreateInternal(id: string, now: number): void {
    const s = this.attempt(id);
    if (terminal(s) || s.cleanup_requested_at === null || s.openai_session_id !== null || s.creation_completed_at !== null ||
        !elapsed(s.provider_expires_at, now)) return;
    // The local create has already settled ambiguously (or the process restarted), and the
    // persisted provider lifetime bound has elapsed. This is terminal-not-live proof, not an observed close.
    this.updateAttempt(id, { state: "closed", lease_released_at: s.lease_released_at ?? now,
      cleanup_next_attempt_at: null, cleanup_blocked_at: null });
  }
  private expireProviderSessionInternal(id: string, now: number): void {
    const s = this.attempt(id);
    if (terminal(s) || s.provider_request_dispatched_at === null || s.cleanup_requested_at !== null) return;
    const c = this.conversation(s.conversation_id);
    const providerDeadline = s.provider_request_dispatched_at + this.policyFor(c).maxProviderSessionMs;
    if (now < providerDeadline) return;
    if (c.status !== "ended") this.endInternal(c, "max_duration", now);
    else this.cleanupInternal(s, "handoff_not_activatable", now);
  }
  watchdog(): void {
    this.atomic(() => {
      const now = this.now();
      for (const c of this.db.prepare("SELECT id FROM conversations WHERE status='resuming' OR (status<>'ended' AND product_deadline_at IS NOT NULL AND product_deadline_at<=?) OR (status='paused' AND resume_expires_at<=?)").all(now, now)) this.expireConversationInternal(String(c.id), now);
      for (const s of this.db.prepare("SELECT id FROM live_sessions WHERE provider_request_dispatched_at IS NOT NULL AND state NOT IN ('closed','failed') AND cleanup_requested_at IS NULL").all()) this.expireProviderSessionInternal(String(s.id), now);
      for (const s of this.db.prepare("SELECT id FROM live_sessions WHERE cleanup_requested_at IS NOT NULL AND openai_session_id IS NULL AND creation_completed_at IS NULL AND provider_expires_at IS NOT NULL AND provider_expires_at<=? AND state NOT IN ('closed','failed')").all(now)) this.expireAmbiguousCreateInternal(String(s.id), now);
      for (const s of this.db.prepare("SELECT id FROM live_sessions WHERE creation_completed_at IS NOT NULL AND handoff_acknowledged_at IS NULL AND state NOT IN ('closed','failed') AND cleanup_requested_at IS NULL").all()) this.guardHandoffInternal(String(s.id), now);
    });
  }
  recover(): void {
    this.atomic(() => {
      const now = this.now();
      for (const s of this.db.prepare("SELECT * FROM live_sessions WHERE state NOT IN ('closed','failed')").all() as unknown as SessionRow[]) {
        if (s.provider_request_dispatched_at === null) {
          if (s.start_reason === "resume") this.rollbackResume(this.conversation(s.conversation_id), s, now, "aborted", "interrupted_by_restart");
          else this.cleanupInternal(s, "server_shutdown", now);
        } else if (s.creation_completed_at === null) {
          const providerExpiresAt = s.provider_expires_at ??
            s.provider_request_dispatched_at + this.policyFor(this.conversation(s.conversation_id)).maxProviderSessionMs;
          this.updateAttempt(s.id, { state: s.cleanup_requested_at !== null && !this.progressing(s.conversation_id, s.id) ? "closing" : "unknown",
            provider_expires_at: providerExpiresAt });
          if (s.resume_outcome === "pending") this.rollbackResume(this.conversation(s.conversation_id), this.attempt(s.id), now, "aborted", "interrupted_by_restart");
          this.expireAmbiguousCreateInternal(s.id, now);
        } else if (s.handoff_acknowledged_at === null) this.guardHandoffInternal(s.id, now);
      }
      for (const c of this.db.prepare("SELECT id FROM conversations WHERE status IN ('paused','resuming')").all()) this.expireConversationInternal(String(c.id), now);
    });
  }
}
