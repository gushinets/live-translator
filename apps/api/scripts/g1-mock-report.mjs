/** Deterministic G1 fixture. No HTTP, OpenAI key, audio or production database is used. */
import assert from "node:assert/strict";
import { log } from "node:console";
import { openUsageDatabase } from "../dist/persistence/database.js";
import { UsageLedger } from "../dist/accounting/UsageLedger.js";
import { usageReportSchema } from "../dist/accounting/mergeUsage.js";
import { conversationSummary } from "../dist/reports/conversationSummary.js";

const db = openUsageDatabase(":memory:");
try {
  let now = 1000000;
  const ledger = new UsageLedger(db, { now: () => now });
  const owner = "11111111-1111-4111-8111-111111111111";
  const localId = "22222222-2222-4222-8222-222222222222";
  const conversation = ledger.createConversation(owner, "33333333-3333-4333-8333-333333333333", "g1-synthetic-v1");
  ledger.registerAttempt(owner, { liveSessionId: localId, conversationId: conversation.id,
    conversationVersion: conversation.version, initialMode: "setup", startReason: "initial", fingerprint: "synthetic-not-sdp" });
  ledger.dispatchProviderAttempt(owner, localId, conversation.version, "test-lease", now + 900000);
  ledger.recordProviderCreated(localId, "synthetic-provider-id");
  ledger.acknowledgeHandoff(owner, localId);
  now += 120000;
  ledger.recordUsage(owner, localId, usageReportSchema.parse({ schemaVersion: 1, checkpointSeconds: 105,
    providerClosed: { seconds: 120, reason: "user_requested" }, app: {
      activityReportSeq: 1, measurementVersion: "active-time-v1", observedWallMs: 120000,
      setupMs: 60000, activeInterpreterMs: 60000, visiblePausedMs: 0,
      acceptedSourceSpeechMs: 30000, completedSourceSpeechMs: 20000,
      speechMeasurementVersion: "vam-pre-tail-v1", speechMeasurementStatus: "complete", appMetricsFinalized: true,
      counters: { audioCompletedTurnCount: 1, textOnlyCompletedTurnCount: 0, failedTurnCount: 0, discardedTurnCount: 0 },
    } }));
  const report = conversationSummary(ledger.listAttempts(owner, conversation.id));
  assert.deepEqual(report.ratios, { providerSecondsPerActiveMinute: 120,
    providerSecondsPerAcceptedSpeechMinute: 240, providerSecondsPerCompletedSpeechMinute: 360 });
  assert.equal(report.usage.totalProviderSeconds, 120);
  log(JSON.stringify({ evidence: "synthetic; not provider measurements or billing calibration", report }, null, 2));
} finally { db.close(); }
