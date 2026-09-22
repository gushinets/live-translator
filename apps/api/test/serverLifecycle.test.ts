import { randomUUID } from "node:crypto";
import { afterEach, describe, expect, it, vi } from "vitest";
import { openUsageDatabase } from "../src/persistence/database.js";
import { UsageLedger } from "../src/accounting/UsageLedger.js";
import { LedgerRuntime } from "../src/accounting/LedgerRuntime.js";

const databases: ReturnType<typeof openUsageDatabase>[] = [];
afterEach(() => { for (const db of databases.splice(0)) if (db.isOpen) db.close(); });
function fixture() {
  const db = openUsageDatabase(":memory:"); databases.push(db);
  const ledger = new UsageLedger(db), owner = randomUUID(), c = ledger.createConversation(owner, randomUUID(), "test");
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
  it("shares one global Sideband budget between worker and emergency paths", async () => {
    const modulePath = "../src/accounting/BoundedOrphanCloser.js";
    const module = await import(modulePath).catch(() => undefined); expect(module, "shared network budget").toBeDefined();
    let count = 0, peak = 0;
    const closer = module!.boundOrphanCloser(async () => { peak = Math.max(peak, ++count); await new Promise(r => setTimeout(r, 3)); count--; return { kind: "closed_observed", observation: {} }; }, 2);
    await Promise.all(Array.from({ length: 8 }, (_, i) => closer(String(i), new AbortController().signal)));
    expect(peak).toBe(2);
  });
});
