import { randomUUID } from "node:crypto";
import type { DatabaseSync } from "node:sqlite";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { openUsageDatabase } from "../src/persistence/database.js";
import { UsageLedger } from "../src/accounting/UsageLedger.js";
import { DEFAULT_LEDGER_POLICY, type AttemptInput } from "../src/accounting/types.js";

let db: DatabaseSync;
let ledger: UsageLedger;
let now: number;
let owner: string;
beforeEach(() => {
  db = openUsageDatabase(":memory:"); now = 1800000000000; owner = randomUUID();
  ledger = new UsageLedger(db, { now: () => now });
});
afterEach(() => { vi.restoreAllMocks(); db.close(); });
function registered() {
  const c = ledger.createConversation(owner, randomUUID(), "test");
  const input: AttemptInput = { liveSessionId: randomUUID(), conversationId: c.id, conversationVersion: c.version,
    initialMode: "setup", startReason: "initial", fingerprint: "sdp-hash" };
  const row = ledger.registerAttempt(owner, input); return { c, input, row };
}
function dispatched() {
  const r = registered(); ledger.dispatchProviderAttempt(owner, r.row.id, r.c.version, randomUUID(), now + 900000); return r;
}
function created() {
  const r = dispatched(); ledger.recordProviderCreated(r.row.id, "provider-" + r.row.id); return r;
}
function resumed() {
  const c = ledger.createConversation(owner, randomUUID(), "test");
  const p = ledger.pauseConversation(owner, c.id, c.version);
  const id = randomUUID(), claim = ledger.claimResume(owner, c.id, p.version, id, "setup"), v = claim.conversation.version;
  ledger.registerAttempt(owner, { liveSessionId: id, conversationId: c.id, conversationVersion: v, initialMode: "setup", startReason: "resume", fingerprint: "resume-sdp" });
  ledger.dispatchProviderAttempt(owner, id, v, randomUUID(), now + 900000); ledger.recordProviderCreated(id, "provider-" + id);
  return { c, p, id, v, claim };
}

describe("persistent provider ledger", () => {
  it("deduplicates conversation keys only for the same owner", () => {
    const key = randomUUID(), a = ledger.createConversation(owner, key, "test");
    expect(ledger.createConversation(owner, key, "test").id).toBe(a.id);
    expect(ledger.createConversation(randomUUID(), key, "test").id).not.toBe(a.id);
    expect(() => ledger.getConversation(randomUUID(), a.id)).toThrow("not_found");
  });
  it("registers once and rejects mismatched payloads and two progressing attempts", () => {
    const { c, row, input } = registered();
    expect(ledger.registerAttempt(owner, input).id).toBe(row.id);
    expect(() => ledger.registerAttempt(owner, { ...input, fingerprint: "different" })).toThrow("attempt_conflict");
    expect(() => ledger.registerAttempt(owner, { ...input, liveSessionId: randomUUID() })).toThrow("attempt_in_progress");
    expect(ledger.listAttempts(owner, c.id)).toHaveLength(1);
  });
  it("rejects foreign attempt reads and releases", () => {
    const { row } = created();
    expect(() => ledger.getAttempt(randomUUID(), row.id)).toThrow("not_found");
    expect(() => ledger.releaseAdmission(randomUUID(), "provider-" + row.id)).toThrow("not_found");
  });
  it("cleanup-first prevents subsequent dispatch and preserves NULL usage", () => {
    const { c, row } = registered(); ledger.requestCleanup(row.id, "cancelled");
    expect(() => ledger.dispatchProviderAttempt(owner, row.id, c.version, "lease", now + 1000)).toThrow();
    const current = ledger.getAttempt(owner, row.id);
    expect(current.state).toBe("failed"); expect(current.provider_request_dispatched_at).toBeNull(); expect(current.provider_final_seconds).toBeNull();
  });
  it("dispatch-first reserves once and cleanup does not prove closure", () => {
    const { c, row } = dispatched();
    expect(() => ledger.dispatchProviderAttempt(owner, row.id, c.version, "twice", now + 1000)).toThrow("attempt_already_dispatched");
    const s = ledger.requestCleanup(row.id, "cancelled");
    expect(s.state).toBe("closing"); expect(s.lease_released_at).toBeNull(); expect(s.close_confirmed).toBe(0);
  });
  it("keeps first cleanup reason and immutable seven-day expiry", () => {
    const { row } = dispatched(), first = ledger.requestCleanup(row.id, "hidden"); now += 10000;
    const second = ledger.requestCleanup(row.id, "user_end");
    expect(second.cleanup_reason).toBe("hidden"); expect(second.cleanup_retry_expires_at).toBe(first.cleanup_retry_expires_at);
  });
  it("late provider ID schedules already committed cleanup, never activation", () => {
    const { row } = dispatched(); ledger.requestCleanup(row.id, "abandoned_connect"); now += 100;
    const s = ledger.recordProviderCreated(row.id, "late-provider");
    expect(s.state).toBe("closing"); expect(s.cleanup_next_attempt_at).toBe(now);
    expect(() => ledger.acknowledgeHandoff(owner, row.id)).toThrow();
  });
  it("keeps result provisional until an idempotent handoff ACK", () => {
    const { row } = created(); expect(ledger.getAttempt(owner, row.id).state).toBe("creating");
    const ack = ledger.acknowledgeHandoff(owner, row.id);
    expect(ack.state).toBe("active"); expect(ledger.acknowledgeHandoff(owner, row.id).handoff_acknowledged_at).toBe(ack.handoff_acknowledged_at);
  });
  it("commits handoff-timeout fence even though the ACK returns a conflict", () => {
    const { row } = created(); now += 30000;
    expect(() => ledger.acknowledgeHandoff(owner, row.id)).toThrow("handoff_not_activatable");
    expect(ledger.getAttempt(owner, row.id).cleanup_reason).toBe("handoff_timeout");
  });
  it("product deadline fences initial handoff and ends the conversation", () => {
    const { c, row } = dispatched(); now += 899999; ledger.recordProviderCreated(row.id, "slow-provider"); now++;
    expect(() => ledger.acknowledgeHandoff(owner, row.id)).toThrow();
    expect(ledger.getConversation(owner, c.id).end_reason).toBe("max_duration");
    expect(ledger.getAttempt(owner, row.id).cleanup_reason).toBe("handoff_not_activatable");
  });
  it("watchdog ends an active conversation at its product deadline", () => {
    const { c, row } = created(); ledger.acknowledgeHandoff(owner, row.id); now += 900000;
    ledger.watchdog();
    expect(ledger.getConversation(owner, c.id).end_reason).toBe("max_duration");
    const s = ledger.getAttempt(owner, row.id);
    expect(s.cleanup_reason).toBe("handoff_not_activatable");
    expect(s.close_confirmed).toBe(0); expect(s.lease_released_at).toBeNull();
  });
  it("enforces the configured provider-session cap independently of the conversation cap", () => {
    ledger = new UsageLedger(db, { now: () => now, policy: {
      ...ledger.policy, maxProviderSessionMs: 1000, maxConversationElapsedMs: 900000,
    } });
    const { c, row } = created(); ledger.acknowledgeHandoff(owner, row.id); now += 1000;
    ledger.watchdog();
    expect(ledger.getConversation(owner, c.id).end_reason).toBe("max_duration");
    expect(ledger.getAttempt(owner, row.id).cleanup_reason).toBe("handoff_not_activatable");
  });
  it("ignores browser close metadata for never-dispatched and failed attempts", () => {
    const { row } = registered();
    let current = ledger.recordProviderClosed(row.id, { seconds: 99, reason: "fabricated" }, "browser");
    expect(current.close_confirmed).toBe(0); expect(current.provider_final_seconds).toBeNull();
    ledger.requestCleanup(row.id, "cancelled");
    current = ledger.recordProviderClosed(row.id, { seconds: 99 }, "browser");
    expect(current.state).toBe("failed"); expect(current.close_confirmed).toBe(0); expect(current.provider_final_seconds).toBeNull();
  });

  it("End wins over provisional handoff and is terminal", () => {
    const { c, row } = created(); ledger.endConversation(owner, c.id, c.version, "user_end");
    expect(() => ledger.acknowledgeHandoff(owner, row.id)).toThrow();
    expect(ledger.endConversation(owner, c.id, c.version, "abandoned").end_reason).toBe("user_end");
  });
  it("observed close releases a reservation without inventing zero final seconds", () => {
    const { row } = created(); const s = ledger.recordProviderClosed(row.id, { reason: "client_request" }, "sideband");
    expect(s.close_confirmed).toBe(1); expect(s.provider_final_seconds).toBeNull(); expect(s.usage_quality).toBe("unknown");
    expect(ledger.reservations()).toHaveLength(0);
  });
  it("tracks close, reason, and numeric provenance independently", () => {
    const { row } = created(); ledger.recordProviderClosed(row.id, { seconds: 15, reason: "first" }, "browser");
    ledger.recordProviderClosed(row.id, {}, "sideband");
    let s = ledger.getAttempt(owner, row.id);
    expect(s.close_confirmation_source).toBe("sideband"); expect(s.provider_final_source).toBe("browser"); expect(s.provider_close_reason_source).toBe("browser");
    ledger.recordProviderClosed(row.id, { seconds: 15 }, "sideband"); ledger.recordProviderClosed(row.id, { seconds: 15 }, "browser");
    s = ledger.getAttempt(owner, row.id); expect(s.provider_final_source).toBe("sideband");
  });
  it("preserves conflicting finals and marks the conflict", () => {
    const { row } = created(); ledger.recordProviderClosed(row.id, { seconds: 15 }, "browser");
    const s = ledger.recordProviderClosed(row.id, { seconds: 19 }, "sideband");
    expect(s.provider_final_seconds).toBe(15); expect(s.usage_conflict).toBe(1); expect(s.usage_quality).toBe("conflict");
  });
  it("terminal-not-live is not an observed session.closed", () => {
    const { row } = created(); ledger.requestCleanup(row.id, "cancelled"); const s = ledger.recordProviderTerminalNotLive(row.id);
    expect(s.state).toBe("closed"); expect(s.close_confirmed).toBe(0); expect(s.closed_observed_at).toBeNull(); expect(s.provider_final_seconds).toBeNull();
    expect(s.cleanup_attempt_count).toBe(1); expect(s.cleanup_last_attempt_at).toBe(now);
    expect(s.cleanup_last_error_code).toBeNull(); expect(ledger.reservations()).toHaveLength(0);
  });
  it.each([true, false])("distinguishes definitive failure=%s from an ambiguous abort", definitive => {
    const { row } = dispatched(); ledger.requestCleanup(row.id, "client_disconnected"); const s = ledger.recordCreateFailure(row.id, definitive);
    expect(s.state).toBe(definitive ? "failed" : "closing"); expect(s.lease_released_at).toBe(definitive ? now : null); expect(s.provider_final_seconds).toBeNull();
  });
  it("parks auth/config failures until an explicit re-arm", () => {
    const { row } = created(); ledger.requestCleanup(row.id, "cancelled"); ledger.recordCleanupFailure(row.id, "blocked_auth_config", "unauthorized");
    expect(ledger.dueCleanup(20)).toHaveLength(0); ledger.rearmBlockedCleanup("startup"); expect(ledger.dueCleanup(20)[0]!.id).toBe(row.id);
  });
  it("expires ID-less cleanup without fake close or immediate lease release", () => {
    const { row } = dispatched(); ledger.requestCleanup(row.id, "cancelled"); now += 7 * 86400000;
    const s = ledger.exhaustCleanup(row.id); expect(s.state).toBe("unknown"); expect(s.cleanup_retry_exhausted_at).toBe(now);
    expect(s.close_confirmed).toBe(0); expect(s.lease_released_at).toBeNull();
  });
  it("recovers future provisional and handed-off sessions, not synthetic creates", () => {
    const { row } = created(); ledger.recover(); expect(ledger.getAttempt(owner, row.id).state).toBe("creating");
    ledger.acknowledgeHandoff(owner, row.id); ledger.recover(); expect(ledger.getAttempt(owner, row.id).state).toBe("active");
  });
  it.each([false, true])("preserves crash/graceful no-result split (shutdown=%s)", shutdown => {
    const { row } = dispatched(); if (shutdown) ledger.requestCleanup(row.id, "server_shutdown"); ledger.recover();
    const s = ledger.getAttempt(owner, row.id); expect(s.state).toBe(shutdown ? "closing" : "unknown"); expect(s.provider_final_seconds).toBeNull();
  });
  it("does not extend retention on pause retries or failed resume", () => {
    const c = ledger.createConversation(owner, randomUUID(), "test"), p = ledger.pauseConversation(owner, c.id, c.version);
    now += 10; expect(ledger.pauseConversation(owner, c.id, c.version).resume_expires_at).toBe(p.resume_expires_at);
    const id = randomUUID(), claim = ledger.claimResume(owner, c.id, p.version, id, "setup");
    const aborted = ledger.abortResume(owner, c.id, claim.conversation.version, id, "media_not_ready");
    expect(aborted.status).toBe("paused"); expect(aborted.resume_expires_at).toBe(p.resume_expires_at); expect(ledger.reservations()).toHaveLength(0);
  });
  it("deduplicates resume claims but rejects a second claimant", () => {
    const c = ledger.createConversation(owner, randomUUID(), "test"), p = ledger.pauseConversation(owner, c.id, c.version), id = randomUUID();
    ledger.claimResume(owner, c.id, p.version, id, "setup");
    expect(ledger.claimResume(owner, c.id, p.version, id, "setup").attempt.id).toBe(id);
    expect(() => ledger.claimResume(owner, c.id, p.version, randomUUID(), "setup")).toThrow();
  });
  it("requires handoff before resume completion and keeps duplicate receipts", () => {
    const { c, id, v } = resumed(); expect(() => ledger.completeResume(owner, c.id, v, id, now, "setup")).toThrow();
    ledger.acknowledgeHandoff(owner, id); const done = ledger.completeResume(owner, c.id, v, id, now, "setup");
    expect(ledger.completeResume(owner, c.id, v, id, now, "setup").version).toBe(done.version);
    expect(() => ledger.completeResume(owner, c.id, v, id, now + 1, "setup")).toThrow("resume_claim_conflict");
    expect(ledger.acknowledgeHandoff(owner, id).state).toBe("active");
    expect(() => ledger.abortResume(owner, c.id, v, id, "hidden")).toThrow();
  });
  it("accepts only the original reason for duplicate resume abort receipts", () => {
    const { c, id, v } = resumed();
    expect(ledger.abortResume(owner, c.id, v, id, "media_not_ready").status).toBe("paused");
    expect(ledger.abortResume(owner, c.id, v, id, "media_not_ready").status).toBe("paused");
    expect(() => ledger.abortResume(owner, c.id, v, id, "user_end")).toThrow("resume_claim_conflict");
  });
  it("expires acknowledged pending resume atomically with provider cleanup", () => {
    const { c, id } = resumed(); ledger.acknowledgeHandoff(owner, id); now += 60000; ledger.watchdog();
    expect(ledger.getConversation(owner, c.id).status).toBe("paused");
    const s = ledger.getAttempt(owner, id); expect(s.resume_outcome).toBe("expired"); expect(s.cleanup_reason).toBe("resume_claim_expired"); expect(s.cleanup_next_attempt_at).toBe(now); expect(s.lease_released_at).toBeNull();
  });
  it.each([false, true])("recovers a future resume claim and fences it at the exact deadline (handoff=%s)", handedOff => {
    ledger = new UsageLedger(db, { now: () => now, policy: { ...DEFAULT_LEDGER_POLICY, sessionHandoffAckTimeoutMs: 120000 } });
    const { c, id, v } = resumed();
    if (handedOff) ledger.acknowledgeHandoff(owner, id);
    now += 59999;
    ledger.recover();
    expect(ledger.getConversation(owner, c.id)).toMatchObject({ status: "resuming", resume_attempt_id: id });
    expect(ledger.getAttempt(owner, id)).toMatchObject({ state: handedOff ? "active" : "creating", cleanup_requested_at: null });
    now += 1;
    if (handedOff) expect(() => ledger.completeResume(owner, c.id, v, id, now, "setup")).toThrow("resume_not_activatable");
    else expect(() => ledger.acknowledgeHandoff(owner, id)).toThrow("handoff_not_activatable");
    expect(ledger.getConversation(owner, c.id).status).toBe("paused");
    expect(ledger.getAttempt(owner, id)).toMatchObject({ state: "closing", resume_outcome: "expired",
      cleanup_reason: "resume_claim_expired", cleanup_next_attempt_at: now, lease_released_at: null });
  });
  it("rolls all provider/claim changes back if expiry commit fails", () => {
    const { c, id } = resumed(); ledger.acknowledgeHandoff(owner, id); now += 60000;
    const exec = db.exec.bind(db); const spy = vi.spyOn(db, "exec").mockImplementation(sql => { if (sql === "COMMIT") throw new Error("commit unavailable"); exec(sql); });
    expect(() => ledger.watchdog()).toThrow("commit unavailable"); spy.mockRestore();
    expect(ledger.getAttemptInternal(id).state).toBe("active"); expect(ledger.getAttemptInternal(id).resume_outcome).toBe("pending");
    expect(db.prepare("SELECT status FROM conversations WHERE id=?").get(c.id)!.status).toBe("resuming");
    ledger.watchdog(); expect(ledger.getAttemptInternal(id).state).toBe("closing");
  });
});
