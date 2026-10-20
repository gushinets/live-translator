import { randomUUID } from "node:crypto";
import { once } from "node:events";
import { setImmediate } from "node:timers/promises";
import express from "express";
import { afterEach, describe, expect, it, vi } from "vitest";
import { openUsageDatabase } from "../src/persistence/database.js";
import { UsageLedger } from "../src/accounting/UsageLedger.js";
import { LedgerRuntime } from "../src/accounting/LedgerRuntime.js";
import { boundOrphanCloser } from "../src/accounting/BoundedOrphanCloser.js";
import type { CleanupOutcome, OrphanCloser } from "../src/accounting/CleanupWorker.js";
import type { CleanupReason } from "../src/accounting/types.js";
import { startApiServer } from "../src/serverLifecycle.js";

const databases: ReturnType<typeof openUsageDatabase>[] = [];
afterEach(() => { for (const db of databases.splice(0)) if (db.isOpen) db.close(); });
function fixture(now?: () => number) {
  const db = openUsageDatabase(":memory:"); databases.push(db);
  const ledger = new UsageLedger(db, { now }), owner = randomUUID(), c = ledger.createConversation(owner, randomUUID(), "test");
  const input = { conversationId: c.id, conversationVersion: c.version, liveSessionId: randomUUID(), initialMode: "setup" as const, startReason: "initial" as const, fingerprint: "test" };
  return { ledger, owner, c, input };
}
describe("bounded API shutdown ownership", () => {
  it("stops registered work before dispatch and performs zero external creates", async () => {
    const f = fixture(), creator = vi.fn();
    const runtime = new LedgerRuntime(f.ledger, { creator, startWorker: false });
    const pending = runtime.create(f.owner, f.input, "offer", () => false).catch(e => e);
    await runtime.shutdown({ drainMs: 10, timeoutMs: 100 }); await pending;
    expect(creator).not.toHaveBeenCalled();
    expect(f.ledger.getAttemptInternal(f.input.liveSessionId).provider_request_dispatched_at).toBeNull();
  });
  it("commits a shutdown fence before abort and preserves ambiguous reservation", async () => {
    const f = fixture(); let observed: AbortSignal | undefined;
    const runtime = new LedgerRuntime(f.ledger, { startWorker: false, creator: (_sdp, ctx) => new Promise((_resolve, reject) => {
      observed = ctx!.signal; observed.addEventListener("abort", () => {
        expect(f.ledger.getAttemptInternal(f.input.liveSessionId).cleanup_reason).toBe("server_shutdown"); reject(new Error("aborted"));
      });
    }) });
    const pending = runtime.create(f.owner, f.input, "offer", () => false).catch(e => e);
    await vi.waitFor(() => expect(observed).toBeDefined()); await runtime.shutdown({ drainMs: 0, timeoutMs: 100 }); await pending;
    expect(observed!.aborted).toBe(true); expect(f.ledger.getAttemptInternal(f.input.liveSessionId).lease_released_at).toBeNull();
  });
  it("preserves a committed future handoff through graceful restart", async () => {
    const f = fixture(); const runtime = new LedgerRuntime(f.ledger, { startWorker: false,
      creator: async () => ({ session: { id: "provider" }, transport: { type: "webrtc", sdp: "answer" } }) });
    await runtime.create(f.owner, f.input, "offer", () => false); await runtime.shutdown({ drainMs: 0, timeoutMs: 100 }); f.ledger.recover();
    expect(f.ledger.getAttemptInternal(f.input.liveSessionId).cleanup_requested_at).toBeNull();
    expect(f.ledger.acknowledgeHandoff(f.owner, f.input.liveSessionId).state).toBe("active");
  });
  it("keeps SQLite open until a late create result is durably classified", async () => {
    const f = fixture(); let finish!: (value: { session: { id: string }; transport: { type: "webrtc"; sdp: string } }) => void;
    const runtime = new LedgerRuntime(f.ledger, { startWorker: false,
      creator: () => new Promise(resolve => { finish = resolve; }) });
    const app = express(); app.locals.ledgerRuntime = runtime;
    const lifecycle = startApiServer(app, { port: 0, host: "127.0.0.1", drainMs: 0, timeoutMs: 1000 });
    await once(lifecycle.server, "listening");

    let persistedProviderId: string | null = null;
    const recordProviderCreated = f.ledger.recordProviderCreated.bind(f.ledger);
    vi.spyOn(f.ledger, "recordProviderCreated").mockImplementation((id, providerId, expiresAt) => {
      const row = recordProviderCreated(id, providerId, expiresAt); persistedProviderId = row.openai_session_id; return row;
    });
    const creation = runtime.create(f.owner, f.input, "offer", () => false).catch(error => error);
    await vi.waitFor(() => expect(runtime.inflightCount).toBe(1));

    let runtimeStopped!: () => void;
    const runtimeStoppedPromise = new Promise<void>(resolve => { runtimeStopped = resolve; });
    const shutdownRuntime = runtime.shutdown.bind(runtime);
    vi.spyOn(runtime, "shutdown").mockImplementation(async options => {
      await shutdownRuntime(options); runtimeStopped();
    });
    const stopping = lifecycle.shutdown();
    await runtimeStoppedPromise;
    expect(f.ledger.db.isOpen).toBe(true);

    finish({ session: { id: "late-provider" }, transport: { type: "webrtc", sdp: "answer" } });
    await creation; await stopping;
    expect(persistedProviderId).toBe("late-provider");
    expect(f.ledger.db.isOpen).toBe(false);
  });

  it("retries emergency provider-result persistence during the shutdown tail", async () => {
    const f = fixture(); let storageAvailable = false, persistAttempts = 0, persistedProviderId: string | null = null;
    const realRecord = f.ledger.recordProviderCreated.bind(f.ledger);
    vi.spyOn(f.ledger, "recordProviderCreated").mockImplementation((id, providerId, expiresAt) => {
      persistAttempts++;
      if (!storageAvailable) throw new Error("simulated transient storage failure");
      const row = realRecord(id, providerId, expiresAt); persistedProviderId = row.openai_session_id; return row;
    });
    const runtime = new LedgerRuntime(f.ledger, {
      startWorker: false,
      creator: async () => ({ session: { id: "emergency-provider" }, transport: { type: "webrtc", sdp: "answer" } }),
      closeOrphan: async () => ({ kind: "retryable_error", code: "test_retry" }),
    });
    const app = express(); app.locals.ledgerRuntime = runtime;
    const lifecycle = startApiServer(app, { port: 0, host: "127.0.0.1", drainMs: 0, timeoutMs: 1000 });
    await once(lifecycle.server, "listening");

    const creation = runtime.create(f.owner, f.input, "offer", () => false).catch(error => error);
    await creation;
    expect(persistAttempts).toBeGreaterThanOrEqual(2);
    expect(f.ledger.getAttemptInternal(f.input.liveSessionId).openai_session_id).toBeNull();

    storageAvailable = true;
    await lifecycle.shutdown();

    expect(persistedProviderId).toBe("emergency-provider");
    expect(persistAttempts).toBeGreaterThanOrEqual(3);
    expect(f.ledger.db.isOpen).toBe(false);
  });

  it("bounds concurrent orphan-close calls", async () => {
    let count = 0, peak = 0;
    const closer = boundOrphanCloser(async () => { peak = Math.max(peak, ++count); await new Promise(r => setTimeout(r, 3)); count--; return { kind: "closed_observed", observation: {} }; }, 2);
    await Promise.all(Array.from({ length: 8 }, (_, i) => closer(String(i), new AbortController().signal)));
    expect(peak).toBe(2);
  });

  it("shares one Sideband budget between durable worker and emergency storage-failure cleanup", async () => {
    const f = fixture();
    let releaseWorker!: () => void, workerStarted!: () => void;
    const workerGate = new Promise<void>(resolve => { releaseWorker = resolve; });
    const started = new Promise<void>(resolve => { workerStarted = resolve; });
    const calls: string[] = [];
    let active = 0, peak = 0;
    const c = f.ledger.createConversation(f.owner, randomUUID(), "test");
    const input = { ...f.input, conversationId: c.id, conversationVersion: c.version, liveSessionId: randomUUID() };
    const runtime = new LedgerRuntime(f.ledger, {
      startWorker: false, workerConcurrency: 1, logger: { error: () => undefined },
      closeOrphan: async providerId => {
        calls.push(providerId); peak = Math.max(peak, ++active);
        try {
          if (providerId === "worker-provider") { workerStarted(); await workerGate; }
          return { kind: "closed_observed", observation: {} };
        } finally { active--; }
      },
      creator: async () => {
        f.ledger.db.exec(`CREATE TEMP TRIGGER fail_emergency_provider BEFORE UPDATE ON live_sessions
          WHEN NEW.id = '${input.liveSessionId}' AND NEW.openai_session_id IS NOT NULL
          BEGIN SELECT RAISE(FAIL, 'simulated provider persistence outage'); END`);
        return { session: { id: "emergency-provider" }, transport: { type: "webrtc", sdp: "answer" } };
      },
    });
    f.ledger.registerAttempt(f.owner, f.input);
    f.ledger.dispatchProviderAttempt(f.owner, f.input.liveSessionId, f.input.conversationVersion, randomUUID(), f.ledger.now() + 900000);
    f.ledger.recordProviderCreated(f.input.liveSessionId, "worker-provider");
    f.ledger.requestCleanup(f.input.liveSessionId, "primary_startup_failed");
    const work = runtime.worker.drain();
    let creation: Promise<unknown> | undefined;
    try {
      await started;
      creation = runtime.create(f.owner, input, "offer", () => false).catch(error => error);
      await vi.waitFor(() => expect(f.ledger.getAttemptInternal(input.liveSessionId).cleanup_requested_at).not.toBeNull());
      await setImmediate();
      expect(calls).toEqual(["worker-provider"]);
      releaseWorker();
      await work;
      expect(await creation).toMatchObject({ code: "provider_result_unpersisted" });
      expect(calls).toEqual(["worker-provider", "emergency-provider"]);
      expect(peak).toBe(1);

      f.ledger.db.exec("DROP TRIGGER fail_emergency_provider");
      await runtime.reconcileEmergency();
      expect(f.ledger.getAttemptInternal(input.liveSessionId)).toMatchObject({ openai_session_id: "emergency-provider", close_confirmed: 1 });
      expect(calls).toHaveLength(2);
    } finally {
      releaseWorker();
      f.ledger.db.exec("DROP TRIGGER IF EXISTS fail_emergency_provider");
      await Promise.allSettled([work, creation]);
      await runtime.shutdown({ drainMs: 0, timeoutMs: 100 });
    }
  });
});

describe("emergency provider cleanup during storage outage", () => {
  function emergencyFixture(closeOrphan: OrphanCloser, cleanupReason?: CleanupReason) {
    let now = Date.parse("2026-10-19T00:00:00Z");
    const f = fixture(() => now);
    const runtime = new LedgerRuntime(f.ledger, {
      startWorker: false, closeOrphan, logger: { error: () => undefined },
      creator: async () => {
        f.ledger.db.exec(`CREATE TEMP TRIGGER fail_ledger_updates BEFORE UPDATE ON live_sessions
          BEGIN SELECT RAISE(FAIL, 'simulated storage outage'); END`);
        if (cleanupReason) expect(() => runtime.cleanup(f.input.liveSessionId, cleanupReason)).toThrow("simulated storage outage");
        return { session: { id: "orphan-provider" }, transport: { type: "webrtc", sdp: "answer" } };
      },
    });
    return { ...f, runtime, advance: (ms: number) => { now += ms; },
      restore: () => f.ledger.db.exec("DROP TRIGGER fail_ledger_updates") };
  }

  it.each(["retryable result", "thrown error"])("retries a %s before SQL recovers and persists closure without another close", async failure => {
    let attempts = 0;
    const f = emergencyFixture(async providerId => {
      expect(providerId).toBe("orphan-provider");
      if (++attempts === 1) {
        if (failure === "thrown error") throw new Error("transient transport error");
        return { kind: "retryable_error", code: "temporary" };
      }
      return { kind: "closed_observed", observation: {} };
    });
    await expect(f.runtime.create(f.owner, f.input, "offer", () => false)).rejects.toThrow("provider_result_unpersisted");
    expect(attempts).toBe(1);
    expect(f.runtime.activationBlocked(f.input.liveSessionId)).toBe(true);
    expect(f.ledger.getAttemptInternal(f.input.liveSessionId).openai_session_id).toBeNull();
    await Promise.all(Array.from({ length: 10 }, () => f.runtime.reconcileEmergency()));
    f.advance(999); await f.runtime.reconcileEmergency(); expect(attempts).toBe(1);
    f.advance(1); await f.runtime.reconcileEmergency(); expect(attempts).toBe(2);
    f.advance(30000); await f.runtime.reconcileEmergency(); expect(attempts).toBe(2);

    f.restore(); await f.runtime.reconcileEmergency(); await f.runtime.worker.drain();
    const row = f.ledger.getAttemptInternal(f.input.liveSessionId);
    expect(row.openai_session_id).toBe("orphan-provider");
    expect(row.state).toBe("closed"); expect(row.close_confirmed).toBe(1);
    expect(row.close_confirmation_source).toBe("sideband");
    expect(row.provider_final_seconds).toBeNull();
    expect(row.cleanup_reason).toBe("response_not_received");
    expect(f.runtime.activationBlocked(row.id)).toBe(false); expect(f.runtime.inflightCount).toBe(0);
    expect(attempts).toBe(2);
  });

  it("caps exponential retries at 30 seconds even when reconciliation runs tightly", async () => {
    let attempts = 0;
    const f = emergencyFixture(async () => { attempts++; return { kind: "retryable_error", code: "temporary" }; });
    await expect(f.runtime.create(f.owner, f.input, "offer", () => false)).rejects.toThrow("provider_result_unpersisted");
    let expectedAttempts = 1;
    for (const delay of [1000, 2000, 4000, 8000, 16000, 30000, 30000]) {
      f.advance(delay - 1);
      await Promise.all(Array.from({ length: 10 }, () => f.runtime.reconcileEmergency()));
      expect(attempts).toBe(expectedAttempts);
      f.advance(1); await f.runtime.reconcileEmergency(); expect(attempts).toBe(++expectedAttempts);
    }
  });

  it.each<CleanupOutcome>([
    { kind: "closed_observed", observation: {} }, { kind: "terminal_not_live" },
  ])("keeps $kind through recovery without duplicate provider calls", async outcome => {
    let attempts = 0;
    const f = emergencyFixture(async () => { attempts++; return outcome; }, "server_shutdown");
    await expect(f.runtime.create(f.owner, f.input, "offer", () => false)).rejects.toThrow("provider_result_unpersisted");
    f.advance(30000); await f.runtime.reconcileEmergency(); expect(attempts).toBe(1);
    f.restore(); await f.runtime.reconcileEmergency(); await f.runtime.worker.drain();
    const row = f.ledger.getAttemptInternal(f.input.liveSessionId);
    expect(row.state).toBe("closed");
    expect(row.cleanup_reason).toBe("server_shutdown");
    expect(row.close_confirmed).toBe(outcome.kind === "closed_observed" ? 1 : 0);
    expect(row.provider_final_seconds).toBeNull(); expect(row.cleanup_next_attempt_at).toBeNull();
    if (outcome.kind === "terminal_not_live") expect(row.cleanup_last_result).toBe("terminal_not_live");
    expect(attempts).toBe(1);
  });

  it("parks auth failures during outage and hands unresolved cleanup to the durable worker", async () => {
    let attempts = 0;
    const f = emergencyFixture(async () => { attempts++; return { kind: "blocked_auth_config", code: "auth" }; });
    await expect(f.runtime.create(f.owner, f.input, "offer", () => false)).rejects.toThrow("provider_result_unpersisted");
    f.advance(60000); await f.runtime.reconcileEmergency(); expect(attempts).toBe(1);
    f.restore(); await f.runtime.reconcileEmergency(); expect(attempts).toBe(1);
    expect(f.ledger.getAttemptInternal(f.input.liveSessionId).cleanup_reason).toBe("response_not_received");
    await f.runtime.worker.drain();
    const row = f.ledger.getAttemptInternal(f.input.liveSessionId);
    expect(row.cleanup_last_result).toBe("blocked_auth_config"); expect(row.cleanup_blocked_at).not.toBeNull();
    expect(row.close_confirmed).toBe(0); expect(row.provider_final_seconds).toBeNull();
    f.advance(60000); await f.runtime.reconcileEmergency(); await f.runtime.worker.drain(); expect(attempts).toBe(2);
  });

  it("hands retryable cleanup to the durable worker as soon as SQL recovers", async () => {
    let attempts = 0;
    const f = emergencyFixture(async () => ++attempts === 1
      ? { kind: "retryable_error", code: "temporary" }
      : { kind: "closed_observed", observation: {} });
    await expect(f.runtime.create(f.owner, f.input, "offer", () => false)).rejects.toThrow("provider_result_unpersisted");
    f.restore(); await f.runtime.reconcileEmergency(); expect(attempts).toBe(1);
    expect(f.ledger.getAttemptInternal(f.input.liveSessionId).cleanup_next_attempt_at).toBe(f.ledger.now());
    await f.runtime.worker.drain();
    expect(f.ledger.getAttemptInternal(f.input.liveSessionId).close_confirmed).toBe(1); expect(attempts).toBe(2);
    await f.runtime.reconcileEmergency(); await f.runtime.worker.drain(); expect(attempts).toBe(2);
  });
});
