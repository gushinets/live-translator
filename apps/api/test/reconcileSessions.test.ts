import { randomUUID } from "node:crypto";
import { afterEach, describe, expect, it, vi } from "vitest";
import { conversationSummary } from "../src/reports/conversationSummary.js";
import { openUsageDatabase } from "../src/persistence/database.js";
import { UsageLedger } from "../src/accounting/UsageLedger.js";
import { LedgerRuntime } from "../src/accounting/LedgerRuntime.js";
import { DEFAULT_LEDGER_POLICY } from "../src/accounting/types.js";
import { usageReportSchema } from "../src/accounting/mergeUsage.js";

const databases: ReturnType<typeof openUsageDatabase>[] = [];
afterEach(() => { for (const db of databases.splice(0)) if (db.isOpen) db.close(); });

function fixture(policy = DEFAULT_LEDGER_POLICY) {
  const db = openUsageDatabase(":memory:"); databases.push(db);
  let now = Date.UTC(2026, 8, 25);
  const owner = randomUUID(), ledger = new UsageLedger(db, { now: () => now, policy });
  const runtimeDependencies = { creator: vi.fn(), closeOrphan: vi.fn(async () => ({ kind: "terminal_not_live" as const })) };
  const start = (conversationId: string, version: number) => {
    const id = randomUUID();
    ledger.registerAttempt(owner, { liveSessionId: id, conversationId, conversationVersion: version,
      initialMode: "setup", startReason: "initial", fingerprint: `synthetic-${id}` });
    ledger.dispatchProviderAttempt(owner, id, version, `lease-${id}`, now + policy.maxProviderSessionMs);
    ledger.recordProviderCreated(id, `provider-${id}`);
    ledger.acknowledgeHandoff(owner, id);
    return id;
  };
  return { db, owner, ledger, start, now: () => now, setNow: (value: number) => { now = value; }, runtimeDependencies };
}

describe("startup and periodic reconciliation", () => {
  it("expires a pending resume that never dispatched as a definitive no-provider failure", () => {
    const f = fixture(), c = f.ledger.createConversation(f.owner, randomUUID(), "test");
    const paused = f.ledger.pauseConversation(f.owner, c.id, c.version), attemptId = randomUUID();
    const claim = f.ledger.claimResume(f.owner, c.id, paused.version, attemptId, "setup", 1);
    f.ledger.registerAttempt(f.owner, { liveSessionId: attemptId, conversationId: c.id,
      conversationVersion: claim.conversation.version, initialMode: "setup", startReason: "resume",
      fingerprint: "synthetic-no-dispatch-resume", usageIdentityVersion: 1 });
    const claimDeadline = claim.attempt.resume_claim_expires_at!;
    f.setNow(claimDeadline);
    f.ledger.watchdog();

    expect(f.ledger.getAttemptInternal(attemptId)).toMatchObject({ state: "failed", resume_outcome: "expired",
      cleanup_reason: "resume_claim_expired", provider_request_dispatched_at: null, lease_released_at: claimDeadline,
      provider_final_seconds: null, close_confirmed: 0 });
    expect(f.db.prepare("SELECT status,resume_attempt_id,resume_expires_at FROM conversations WHERE id=?").get(c.id))
      .toEqual({ status: "paused", resume_attempt_id: null, resume_expires_at: paused.resume_expires_at });
    expect(f.ledger.reservations()).toHaveLength(0);
    expect(() => f.ledger.completeResume(f.owner, c.id, claim.conversation.version, attemptId, claimDeadline, "setup"))
      .toThrow("resume_not_activatable");
    expect(f.runtimeDependencies.creator).not.toHaveBeenCalled();
  });

  it("preserves a committed pending resume through repeated restarts until its original claim deadline", () => {
    const f = fixture({ ...DEFAULT_LEDGER_POLICY, sessionHandoffAckTimeoutMs: 120000 });
    const c = f.ledger.createConversation(f.owner, randomUUID(), "test");
    const paused = f.ledger.pauseConversation(f.owner, c.id, c.version);
    const attemptId = randomUUID();
    const claim = f.ledger.claimResume(f.owner, c.id, paused.version, attemptId, "setup", 1);
    f.ledger.registerAttempt(f.owner, { liveSessionId: attemptId, conversationId: c.id,
      conversationVersion: claim.conversation.version, initialMode: "setup", startReason: "resume",
      fingerprint: "synthetic-resume", usageIdentityVersion: 1 });
    f.ledger.dispatchProviderAttempt(f.owner, attemptId, claim.conversation.version, "resume-lease", f.now() + 900000);
    f.ledger.recordProviderCreated(attemptId, "synthetic-resume-provider");
    f.ledger.acknowledgeHandoff(f.owner, attemptId);
    const claimDeadline = f.ledger.getAttemptInternal(attemptId).resume_claim_expires_at!;
    f.setNow(claimDeadline - 1);

    new LedgerRuntime(f.ledger, { ...f.runtimeDependencies, startWorker: false });
    new LedgerRuntime(f.ledger, { ...f.runtimeDependencies, startWorker: false });

    expect(f.ledger.getAttemptInternal(attemptId)).toMatchObject({ state: "active", resume_outcome: "pending",
      cleanup_requested_at: null, lease_released_at: null });
    expect(f.db.prepare("SELECT status,resume_attempt_id FROM conversations WHERE id=?").get(c.id))
      .toEqual({ status: "resuming", resume_attempt_id: attemptId });
    expect(f.ledger.reservations()).toHaveLength(1);
    expect(f.runtimeDependencies.creator).not.toHaveBeenCalled();

    f.setNow(claimDeadline);
    f.ledger.watchdog();
    const expired = f.ledger.getAttemptInternal(attemptId);
    expect(expired).toMatchObject({ state: "closing", resume_outcome: "expired", cleanup_reason: "resume_claim_expired",
      cleanup_next_attempt_at: claimDeadline, lease_released_at: null, provider_final_seconds: null, close_confirmed: 0 });
    expect(f.db.prepare("SELECT status,resume_attempt_id FROM conversations WHERE id=?").get(c.id))
      .toEqual({ status: "paused", resume_attempt_id: null });
    expect(() => f.ledger.completeResume(f.owner, c.id, claim.conversation.version, attemptId, claimDeadline, "setup"))
      .toThrow("resume_not_activatable");
    expect(f.runtimeDependencies.creator).not.toHaveBeenCalled();
  });

  it("expires paused conversations on restart without inventing provider close or final usage", () => {
    const f = fixture();
    const c = f.ledger.createConversation(f.owner, randomUUID(), "test"), attemptId = f.start(c.id, c.version);
    const paused = f.ledger.pauseConversation(f.owner, c.id, c.version);
    const cleanupDeadline = f.ledger.getAttemptInternal(attemptId).cleanup_retry_expires_at;
    f.setNow(paused.resume_expires_at!);

    new LedgerRuntime(f.ledger, { ...f.runtimeDependencies, startWorker: false });
    const first = f.db.prepare("SELECT status,end_reason,ended_at FROM conversations WHERE id=?").get(c.id) as Record<string, unknown>;
    const row = f.ledger.getAttemptInternal(attemptId);
    new LedgerRuntime(f.ledger, { ...f.runtimeDependencies, startWorker: false });
    const second = f.db.prepare("SELECT status,end_reason,ended_at FROM conversations WHERE id=?").get(c.id);

    expect(first).toMatchObject({ status: "ended", end_reason: "background_timeout", ended_at: paused.resume_expires_at });
    expect(second).toEqual(first);
    expect(row).toMatchObject({ cleanup_reason: "hidden", cleanup_retry_expires_at: cleanupDeadline,
      cleanup_next_attempt_at: paused.paused_at, provider_final_seconds: null, close_confirmed: 0,
      closed_observed_at: null, lease_released_at: null });
    expect(f.ledger.reservations()).toHaveLength(1);
    expect(f.runtimeDependencies.creator).not.toHaveBeenCalled();
    expect(f.runtimeDependencies.closeOrphan).not.toHaveBeenCalled();
  });
});

describe("late final reconciliation", () => {
  it("updates cumulative usage after End without changing the ended conversation", () => {
    const f = fixture();
    const c = f.ledger.createConversation(f.owner, randomUUID(), "test"), attemptId = f.start(c.id, c.version);
    const ended = f.ledger.endConversation(f.owner, c.id, c.version, "user_end");
    f.setNow(f.now() + 1000);
    f.ledger.recordUsage(f.owner, attemptId, c.id, usageReportSchema.parse({ schemaVersion: 1,
      checkpointSeconds: 105, providerClosed: { seconds: 120, reason: "user_requested" } }));

    const current = f.db.prepare("SELECT status,end_reason,ended_at FROM conversations WHERE id=?").get(c.id);
    const summary = conversationSummary(f.ledger.listAttempts(f.owner, c.id));
    expect(current).toEqual({ status: "ended", end_reason: "user_end", ended_at: ended.ended_at });
    expect(summary.usage).toMatchObject({ finalSeconds: 120, partialSeconds: 0, totalProviderSeconds: 120,
      finalCount: 1, unknownCount: 0, conflictCount: 0 });
    expect(f.ledger.getAttemptInternal(attemptId)).toMatchObject({ provider_checkpoint_seconds: 105,
      provider_final_seconds: 120, cleanup_reason: "user_end", close_confirmed: 1 });
  });
});
