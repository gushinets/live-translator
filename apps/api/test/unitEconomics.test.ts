import { randomUUID } from "node:crypto";
import { afterEach, describe, expect, it } from "vitest";
import { UsageLedger } from "../src/accounting/UsageLedger.js";
import { DEFAULT_LEDGER_POLICY } from "../src/accounting/types.js";
import { usageReportSchema } from "../src/accounting/mergeUsage.js";
import { openUsageDatabase } from "../src/persistence/database.js";
import { buildUnitEconomicsReport } from "../src/reports/unitEconomics.js";
import { estimateCurrentPriceScenario, estimateHistoricalCost, type PricingPolicy } from "../src/reports/pricingPolicy.js";

const databases: ReturnType<typeof openUsageDatabase>[] = [];
afterEach(() => { for (const db of databases.splice(0)) if (db.isOpen) db.close(); });

const owner = randomUUID();
const appMetrics = {
  activityReportSeq: 1, measurementVersion: "active-time-v1", observedWallMs: 120000,
  setupMs: 60000, activeInterpreterMs: 60000, visiblePausedMs: 0,
  acceptedSourceSpeechMs: 30000, completedSourceSpeechMs: 20000,
  speechMeasurementVersion: "vam-pre-tail-v1", speechMeasurementStatus: "complete" as const,
  appMetricsFinalized: true,
  counters: { audioCompletedTurnCount: 1, textOnlyCompletedTurnCount: 0, failedTurnCount: 0, discardedTurnCount: 0 },
};

function fixture(pricingPolicies: readonly PricingPolicy[] = []) {
  const db = openUsageDatabase(":memory:"); databases.push(db);
  let now = Date.UTC(2026, 8, 25);
  const ledger = new UsageLedger(db, { now: () => now, pricingPolicies,
    policy: { ...DEFAULT_LEDGER_POLICY, conversationRetentionMs: 300000 } });
  const conversation = () => ledger.createConversation(owner, randomUUID(), "synthetic-app-v1");
  const dispatched = (c: ReturnType<typeof conversation>) => {
    const id = randomUUID();
    ledger.registerAttempt(owner, { liveSessionId: id, conversationId: c.id, conversationVersion: c.version,
      initialMode: "setup", startReason: "initial", fingerprint: `synthetic-${id}`, usageIdentityVersion: 1 });
    ledger.dispatchProviderAttempt(owner, id, c.version, `lease-${id}`, now + 900000);
    ledger.recordProviderCreated(id, `provider-${id}`);
    ledger.acknowledgeHandoff(owner, id);
    return id;
  };
  const report = (id: string, conversationId: string, value: Record<string, unknown>) =>
    ledger.recordUsage(owner, id, conversationId, usageReportSchema.parse({ schemaVersion: 1, ...value }));
  return { db, ledger, conversation, dispatched, report, now: () => now, setNow: (value: number) => { now = value; } };
}

describe("cross-conversation unit economics", () => {
  it("reports a mixed cohort without hiding partial, unknown, conflict or no-dispatch records", () => {
    const f = fixture();
    const final = f.conversation(), finalId = f.dispatched(final);
    f.report(finalId, final.id, { checkpointSeconds: 105, providerClosed: { seconds: 120 }, app: appMetrics });

    const partial = f.conversation(), partialId = f.dispatched(partial);
    f.report(partialId, partial.id, { checkpointSeconds: 43 });

    const unknown = f.conversation(); f.dispatched(unknown);

    const conflict = f.conversation(), conflictId = f.dispatched(conflict);
    f.report(conflictId, conflict.id, { providerClosed: { seconds: 90 }, conflictingProviderClosed: { seconds: 88 }, app: appMetrics });

    const notSent = f.conversation(), notSentId = randomUUID();
    f.ledger.registerAttempt(owner, { liveSessionId: notSentId, conversationId: notSent.id, conversationVersion: notSent.version,
      initialMode: "setup", startReason: "initial", fingerprint: `synthetic-${notSentId}` });
    f.ledger.recordCreateFailure(notSentId, true);

    const from = Date.UTC(2026, 8, 24), to = Date.UTC(2026, 8, 26), asOf = Date.UTC(2026, 8, 27);
    const result = buildUnitEconomicsReport(f.db, { from, to, asOf, generatedAt: asOf, dataClass: "synthetic" });

    expect(result).toMatchObject({ reportVersion: "unit-economics-v1", dataClass: "synthetic",
      selection: { timezone: "UTC", lowerInclusive: true, upperExclusive: true },
      sample: { conversations: 5, attempts: 5, dispatchedAttempts: 4, notDispatchedAttempts: 1 },
      usage: { finalCount: 1, partialCount: 1, unknownCount: 1, conflictCount: 1,
        finalSeconds: 120, partialCheckpointSeconds: 43, observedNonConflictingSeconds: 163,
        finalCountCoverage: 0.25 },
      ratios: {
        providerSecondsPerActiveMinute: { value: 120, includedConversations: 1, selectedConversations: 5 },
        providerSecondsPerAcceptedSpeechMinute: { value: 240, includedConversations: 1 },
        providerSecondsPerCompletedSpeechMinute: { value: 360, includedConversations: 1 },
        providerSecondsPerAcceptedSpeechSecond: { value: 4, includedConversations: 1 },
      },
      distributions: { providerSecondsPerConversation: { mean: 120, median: 120, p95: 120, sampleSize: 1,
        percentileMethod: "nearest_rank_ceil_0.95n" } },
    });
    expect(result.usage.finalShareOfKnownSeconds).toBeCloseTo(120 / 163);
    expect(result.ratios.providerSecondsPerActiveMinute.excludedReasons).toMatchObject({
      partial_provider_usage: 1, unknown_provider_usage: 1, conflicting_provider_usage: 1,
    });
    expect(JSON.stringify(result)).not.toMatch(/anonymous_user_id|request_fingerprint|provider-[a-f0-9-]+/);
  });

  it("keeps missing, zero and incomplete measurements distinct and does not reconcile during reads", () => {
    const f = fixture();
    const c = f.conversation(), id = f.dispatched(c);
    f.report(id, c.id, { providerClosed: { seconds: 120 }, app: { ...appMetrics, activeInterpreterMs: 0,
      speechMeasurementStatus: "partial" } });
    const paused = f.conversation();
    f.ledger.pauseConversation(owner, paused.id, paused.version);
    f.setNow(f.now() + 300001);

    const result = buildUnitEconomicsReport(f.db, { from: Date.UTC(2026, 8, 24), to: Date.UTC(2026, 8, 27),
      asOf: f.now(), generatedAt: f.now(), dataClass: "synthetic" });

    expect(result.ratios.providerSecondsPerActiveMinute).toMatchObject({ value: null, excludedReasons: { zero_active_duration: 1 } });
    expect(result.ratios.providerSecondsPerAcceptedSpeechMinute).toMatchObject({ value: null, excludedReasons: { incomplete_speech_coverage: 1 } });
    expect(result.usage.finalCount).toBe(1);
    expect(f.db.prepare("SELECT status FROM conversations WHERE id=?").get(paused.id)!.status).toBe("paused");
  });

  it("fails diagnostically on corrupted metadata without echoing it", () => {
    const f = fixture(), c = f.conversation(), id = f.dispatched(c);
    f.report(id, c.id, { providerClosed: { seconds: 120 }, app: appMetrics });
    f.db.exec("PRAGMA ignore_check_constraints=ON");
    f.db.prepare("UPDATE live_sessions SET metrics_json=? WHERE id=?").run("private transcript", id);

    expect(() => buildUnitEconomicsReport(f.db, { from: 0, to: Date.UTC(2027, 0), asOf: 1,
      generatedAt: 1, dataClass: "synthetic" })).toThrowError(expect.objectContaining({ code: "invalid_metadata" }));
    try {
      buildUnitEconomicsReport(f.db, { from: 0, to: Date.UTC(2027, 0), asOf: 1, generatedAt: 1, dataClass: "synthetic" });
    } catch (error) { expect(String(error)).not.toContain("private transcript"); }
  });
});

describe("versioned pricing policy", () => {
  const policies: readonly PricingPolicy[] = [
    { version: "synthetic-gpt-live-v1", model: "gpt-live-1", currency: "USD", minorUnitDigits: 2, unit: "provider_minute",
      rateMinorUnitsPerMinute: 30, effectiveFrom: 1000, rounding: "half_up_minor_unit", evidence: { kind: "synthetic" } },
    { version: "synthetic-gpt-live-v2", model: "gpt-live-1", currency: "USD", minorUnitDigits: 2, unit: "provider_minute",
      rateMinorUnitsPerMinute: 90, effectiveFrom: 2000, rounding: "half_up_minor_unit", evidence: { kind: "synthetic" } },
  ];

  it("uses the effective historical version and keeps an explicit current-price scenario separate", () => {
    const source = { providerFinalSeconds: 120 };
    const historical = estimateHistoricalCost(source.providerFinalSeconds, "gpt-live-1", 1500, null, policies);
    const current = estimateCurrentPriceScenario(source.providerFinalSeconds, "gpt-live-1", 2500, policies);

    expect(historical).toMatchObject({ status: "estimated", policyVersion: "synthetic-gpt-live-v1", currency: "USD", amountMinorUnits: "60" });
    expect(estimateHistoricalCost(1, "gpt-live-1", 1500, null, policies)).toMatchObject({ amountMinorUnits: "1" });
    expect(current).toMatchObject({ status: "estimated", policyVersion: "synthetic-gpt-live-v2", currency: "USD", amountMinorUnits: "180" });
    expect(source.providerFinalSeconds).toBe(120);
  });

  it("keeps the dispatch-time policy for a late final and reports current price separately", () => {
    const policyChangesAt = Date.UTC(2026, 8, 26);
    const datedPolicies: readonly PricingPolicy[] = [
      { ...policies[0]!, effectiveFrom: Date.UTC(2026, 8, 24) },
      { ...policies[1]!, effectiveFrom: policyChangesAt },
    ];
    const f = fixture(datedPolicies), c = f.conversation(), id = f.dispatched(c);
    expect(f.ledger.getAttemptInternal(id).pricing_policy_version).toBe(policies[0]!.version);
    f.setNow(policyChangesAt + 1000);
    f.report(id, c.id, { providerClosed: { seconds: 120 } });

    const report = buildUnitEconomicsReport(f.db, { from: Date.UTC(2026, 8, 24), to: Date.UTC(2026, 8, 27),
      asOf: f.now(), generatedAt: f.now(), dataClass: "synthetic", pricingPolicies: datedPolicies });
    expect(report.pricing).toMatchObject({ invoiceTotal: null, rawUsageUnchanged: true,
      historicalFinal: { basis: "provider_final_seconds_only", byPolicy: [
        { policyVersion: policies[0]!.version, amountMinorUnits: "60" },
      ] },
      currentPriceScenario: { basis: "provider_final_seconds_only", byPolicy: [
        { policyVersion: policies[1]!.version, amountMinorUnits: "180" },
      ] },
    });
    expect(f.ledger.getAttemptInternal(id).provider_final_seconds).toBe(120);
  });

  it("does not fall forward when a saved historical policy is missing and never treats unknown usage as free", () => {
    expect(estimateHistoricalCost(120, "gpt-live-1", 1500, "removed-policy", policies))
      .toMatchObject({ status: "unavailable", reason: "missing_policy" });
    expect(estimateHistoricalCost(null, "gpt-live-1", 1500, null, policies))
      .toMatchObject({ status: "unavailable", reason: "unknown_usage" });
    expect(estimateCurrentPriceScenario(120, "other-model", 2500, policies))
      .toMatchObject({ status: "unavailable", reason: "missing_policy" });
  });
});
