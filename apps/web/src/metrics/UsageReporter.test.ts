import { describe, expect, it, vi } from "vitest";
import { UsageReporter, type ProductObservation } from "./UsageReporter";
const ready: ProductObservation = { atMs: 0, visible: true, state: "listening", interpreterReady: true, mediaReady: true, speechEligible: true, counters: {} };
it("binds immutable attempt identity, freezes app metrics and still sends a late final", async () => {
  let now = 0;
  const out = { enqueue: vi.fn().mockResolvedValue(undefined), finishProducer: vi.fn().mockResolvedValue(undefined), noProvider: vi.fn().mockResolvedValue(undefined) };
  const r = new UsageReporter("old-id", "c", out, { now: () => now, automatic: false, initial: ready });
  now = 10000; r.observeUsage({ kind: "checkpoint", seconds: 15 });
  now = 20000; r.observeUsage({ kind: "local_close_unconfirmed" }); await r.idle();
  const finalApp = out.enqueue.mock.calls.at(-1)![2].app;
  expect(finalApp).toMatchObject({ activeInterpreterMs: 20000, appMetricsFinalized: true });
  now = 90000; r.observeUsage({ kind: "provider_closed", seconds: 46 }); await r.idle();
  expect(out.enqueue.mock.calls.at(-1)).toEqual(["old-id", "c", { schemaVersion: 1, providerClosed: { seconds: 46 } }]);
});
describe("per-provider application totals", () => {
  it("counts source speech before tail grace and only the completed logical-turn subset", async () => {
    let now = 0;
    const out = { enqueue: vi.fn().mockResolvedValue(undefined), finishProducer: vi.fn().mockResolvedValue(undefined), noProvider: vi.fn() };
    const r = new UsageReporter("id", "c", out, { now: () => now, automatic: false, initial: ready });
    for (now = 0; now <= 5000; now += 50) r.observeProduct({ ...ready, atMs: now, turnId: "one", sample: { atMs: now, active: now < 5000 } });
    r.observeProduct({ ...ready, atMs: 5050, completedTurnId: "one", counters: { audioCompletedTurnCount: 1 } });
    r.observeProduct({ ...ready, atMs: 5100, completedTurnId: "one", counters: { audioCompletedTurnCount: 1 } });
    now = 6000; r.observeUsage({ kind: "provider_closed", seconds: 15 }); await r.idle();
    expect(out.enqueue.mock.calls.at(-1)![2].app).toMatchObject({ acceptedSourceSpeechMs: 5000, completedSourceSpeechMs: 5000, counters: { audioCompletedTurnCount: 1 } });
  });
  it("subtracts the previous provider's conversation counters without duplicating the engine", async () => {
    const out = { enqueue: vi.fn().mockResolvedValue(undefined), finishProducer: vi.fn(), noProvider: vi.fn() };
    const r = new UsageReporter("next", "c", out, { now: () => 0, automatic: false, initial: { ...ready, counters: { audioCompletedTurnCount: 3 } } });
    r.observeProduct({ ...ready, counters: { audioCompletedTurnCount: 4 } }); r.observeUsage({ kind: "local_close_unconfirmed" }); await r.idle();
    expect(out.enqueue.mock.calls.at(-1)![2].app.counters.audioCompletedTurnCount).toBe(1);
  });
});

it("takes terminal product counters after teardown callbacks without extending the measured duration", async () => {
  let now = 0;
  const out = { enqueue: vi.fn().mockResolvedValue(undefined), finishProducer: vi.fn(), noProvider: vi.fn() };
  const r = new UsageReporter("id", "c", out, { now: () => now, automatic: false, initial: ready });
  now = 10000; r.observeUsage({ kind: "local_close_unconfirmed" });
  now = 10001; r.observeProduct({ ...ready, atMs: now, state: "error", counters: { failedTurnCount: 1 } });
  await r.idle();
  expect(out.enqueue.mock.calls.at(-1)![2].app).toMatchObject({ activeInterpreterMs: 10000, appMetricsFinalized: true, counters: { failedTurnCount: 1 } });
});

it("measures new counters from a fresh attempt baseline without changing legacy reports", async () => {
  const out = { enqueue: vi.fn().mockResolvedValue(undefined), finishProducer: vi.fn(), noProvider: vi.fn() };
  const old = new UsageReporter("old", "conversation", out, { now: () => 0, automatic: false, initial: ready });
  old.observeUsage({ kind: "local_close_unconfirmed" }); await old.idle();
  const legacy = structuredClone(out.enqueue.mock.calls[0]![2]);
  const next = new UsageReporter("new", "conversation", out, { now: () => 0, automatic: false,
    initial: { ...ready, counters: { noObservedOutputDeadlineCount: 3, attributionRevokedCount: 0 } } });
  next.observeProduct({ ...ready, counters: { noObservedOutputDeadlineCount: 4 } });
  next.observeUsage({ kind: "checkpoint", seconds: 15 }); await next.idle();
  const intermediate = structuredClone(out.enqueue.mock.calls.at(-1)![2]);
  next.observeProduct({ ...ready, counters: { noObservedOutputDeadlineCount: 4, attributionRevokedCount: 1 } });
  next.observeUsage({ kind: "local_close_unconfirmed" }); await next.idle();
  const final = out.enqueue.mock.calls.at(-1)![2];
  expect(final.app.counters).toEqual({ noObservedOutputDeadlineCount: 1, attributionRevokedCount: 1 });
  expect(final.app.activityReportSeq).toBe(2);
  expect(intermediate.app.counters).toEqual({ noObservedOutputDeadlineCount: 1, attributionRevokedCount: 0 });
  expect(out.enqueue.mock.calls[0]![2]).toEqual(legacy);
  expect(legacy.app.counters).toEqual({});
  old.observeProduct({ ...ready, counters: { noObservedOutputDeadlineCount: 0 } });
  old.observeUsage({ kind: "provider_closed", seconds: 15 }); await old.idle();
  expect(out.enqueue.mock.calls.at(-1)![2].app).toBeUndefined();
});
