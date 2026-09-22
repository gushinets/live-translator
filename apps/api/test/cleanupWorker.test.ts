import { randomUUID } from "node:crypto";
import { afterEach, describe, expect, it, vi } from "vitest";
import { openUsageDatabase } from "../src/persistence/database.js";
import { UsageLedger } from "../src/accounting/UsageLedger.js";
import { CleanupWorker, type CleanupOutcome, type OrphanCloser } from "../src/accounting/CleanupWorker.js";
const dbs: ReturnType<typeof openUsageDatabase>[] = [];
afterEach(() => { for (const db of dbs.splice(0)) db.close(); });
function setup() {
  const db = openUsageDatabase(":memory:"); dbs.push(db); let now = 1800000000000;
  const ledger = new UsageLedger(db, { now: () => now });
  const add = (known = true) => {
    const owner = randomUUID(), c = ledger.createConversation(owner, randomUUID(), "test"), id = randomUUID();
    ledger.registerAttempt(owner, { liveSessionId: id, conversationId: c.id, conversationVersion: 1, initialMode: "setup", startReason: "initial", fingerprint: id });
    ledger.dispatchProviderAttempt(owner, id, 1, id, now + 900000); if (known) ledger.recordProviderCreated(id, "p-" + id);
    ledger.requestCleanup(id, "primary_startup_failed"); return id;
  };
  return { ledger, add, advance: (ms: number) => { now += ms; } };
}
describe("bounded durable cleanup worker", () => {
  it("serializes repeated wakeups per ID", async () => {
    const f = setup(), id = f.add(); let resolve!: (r: CleanupOutcome) => void;
    const closer = vi.fn<OrphanCloser>(() => new Promise(r => { resolve = r; }));
    const worker = new CleanupWorker(f.ledger, closer), work = worker.drain();
    await vi.waitFor(() => expect(closer).toHaveBeenCalledTimes(1)); void worker.drain(); void worker.drain();
    resolve({ kind: "closed_observed", observation: { seconds: 16 } }); await work;
    expect(closer).toHaveBeenCalledTimes(1); expect(f.ledger.getAttemptInternal(id).cleanup_attempt_count).toBe(1); await worker.stop(0);
  });
  it("bounds global concurrency and eventually drains overflow", async () => {
    const f = setup(); for (let i = 0; i < 7; i++) f.add(); let running = 0, peak = 0;
    const closer = vi.fn<OrphanCloser>(async () => { peak = Math.max(peak, ++running); await new Promise(r => setTimeout(r, 2)); running--; return { kind: "closed_observed", observation: {} }; });
    const worker = new CleanupWorker(f.ledger, closer, { concurrency: 2, batchSize: 3 }); await worker.drain();
    expect(peak).toBe(2); expect(closer).toHaveBeenCalledTimes(7); await worker.stop(0);
  });
  it("parks auth failures across ordinary drains and re-arms only explicitly", async () => {
    const f = setup(); f.add(); const closer = vi.fn<OrphanCloser>(async () => ({ kind: "blocked_auth_config", code: "unauthorized" }));
    const worker = new CleanupWorker(f.ledger, closer); for (let i = 0; i < 4; i++) await worker.drain();
    expect(closer).toHaveBeenCalledTimes(1); f.ledger.rearmBlockedCleanup("operator_retry"); await worker.drain(); expect(closer).toHaveBeenCalledTimes(2); await worker.stop(0);
  });
  it("expires ID-less attempts without contacting the provider", async () => {
    const f = setup(), id = f.add(false); f.advance(7 * 86400000); const closer = vi.fn<OrphanCloser>();
    const worker = new CleanupWorker(f.ledger, closer); await worker.drain();
    expect(closer).not.toHaveBeenCalled(); expect(f.ledger.getAttemptInternal(id).cleanup_retry_exhausted_at).not.toBeNull(); await worker.stop(0);
  });
  it("lets a running success settle before expiry", async () => {
    const f = setup(), id = f.add(); let resolve!: (r: CleanupOutcome) => void;
    const worker = new CleanupWorker(f.ledger, () => new Promise(r => { resolve = r; })), work = worker.drain();
    await vi.waitFor(() => expect(resolve).toBeDefined()); f.advance(7 * 86400000); void worker.drain();
    resolve({ kind: "closed_observed", observation: {} }); await work;
    expect(f.ledger.getAttemptInternal(id).cleanup_retry_exhausted_at).toBeNull(); expect(f.ledger.getAttemptInternal(id).state).toBe("closed"); await worker.stop(0);
  });
  it("does not invent outcome/count/backoff on process shutdown abort", async () => {
    const f = setup(), id = f.add();
    const worker = new CleanupWorker(f.ledger, (_id, signal) => new Promise((_r, reject) => signal.addEventListener("abort", () => reject(new Error("shutdown")), { once: true })));
    const work = worker.drain(); await new Promise(r => setTimeout(r, 1)); await worker.stop(0); await work;
    const s = f.ledger.getAttemptInternal(id); expect(s.cleanup_attempt_count).toBe(0); expect(s.cleanup_last_result).toBeNull(); expect(s.cleanup_next_attempt_at).not.toBeNull();
  });
  it("allows a real result to commit during a nonzero shutdown grace", async () => {
    const f = setup(), id = f.add();
    const worker = new CleanupWorker(f.ledger, async () => { await new Promise(r => setTimeout(r, 5)); return { kind: "closed_observed", observation: {} }; });
    const work = worker.drain(); await new Promise(r => setTimeout(r, 1)); await worker.stop(100); await work;
    expect(f.ledger.getAttemptInternal(id).close_confirmed).toBe(1);
  });
  it.each([undefined, 16, 12])("preserves a late Sideband final after browser closure (browser seconds=%s)", async browserSeconds => {
    const f = setup(), id = f.add();
    let resolve!: (result: CleanupOutcome) => void;
    const closer = vi.fn<OrphanCloser>(() => new Promise(done => { resolve = done; }));
    const worker = new CleanupWorker(f.ledger, closer);
    const work = worker.drain();
    await vi.waitFor(() => expect(closer).toHaveBeenCalledTimes(1));
    const first = f.ledger.recordProviderClosed(id,
      browserSeconds === undefined ? {} : { seconds: browserSeconds }, "browser");
    f.advance(10);
    resolve({ kind: "closed_observed", observation: { seconds: 16, reason: "client_request" } });
    await work;
    const result = f.ledger.getAttemptInternal(id);
    expect(result.close_confirmation_source).toBe("sideband");
    expect(result.provider_final_seconds).toBe(browserSeconds ?? 16);
    expect(result.provider_final_source).toBe(browserSeconds === 12 ? "browser" : "sideband");
    expect(result.usage_conflict).toBe(browserSeconds === 12 ? 1 : 0);
    expect(result.provider_close_reason_source).toBe("sideband");
    expect(result.lease_released_at).toBe(first.lease_released_at);
    expect(result.closed_observed_at).toBe(first.closed_observed_at);
    expect(result.cleanup_attempt_count).toBe(1);
    expect(f.ledger.reservations()).toHaveLength(0);
    await worker.stop(0);
  });

});
