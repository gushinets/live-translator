/** Versioned metadata-only wire contract. No transcript, context, SDP or audio fields. */
export const COUNTER_NAMES = ["earlyOutputCount", "completedTurnCount", "sourceTailClippingReports", "noOutputWatchdogCount", "textOnlyCompletionCount", "vamFalseActiveCount", "wrongSideCorrectionCount", "correctionSuccessCount", "audioCompletedTurnCount", "textOnlyCompletedTurnCount", "failedTurnCount", "discardedTurnCount", "correctionAttemptCount", "deliveryDegradedCount"] as const;
export type MetricCounters = Partial<Record<typeof COUNTER_NAMES[number], number>>;
export interface AppMetricsReport {
  activityReportSeq: number; measurementVersion: "active-time-v1";
  observedWallMs: number; setupMs: number; activeInterpreterMs: number; visiblePausedMs: number;
  acceptedSourceSpeechMs: number | null; completedSourceSpeechMs: number | null;
  speechMeasurementVersion: "vam-pre-tail-v1"; speechMeasurementStatus: "complete" | "partial" | "unavailable";
  appMetricsFinalized: boolean; counters: MetricCounters;
  providerStartedObservedAt?: number; interpreterReadyObservedAt?: number; lastCheckpointAtInterpreterReady?: number;
}
export interface CloseUsage { seconds?: number; reason?: string; }
export type UsageObservation = { kind: "checkpoint"; seconds?: number } | { kind: "provider_closed"; seconds?: number; reason?: string } | { kind: "local_close_unconfirmed" };
export interface UsageReport {
  schemaVersion: 1; checkpointSeconds?: number; providerClosed?: CloseUsage;
  conflictingProviderClosed?: CloseUsage; localCloseUnconfirmed?: true; app?: AppMetricsReport;
}
export interface UsageReceipt { schemaVersion: 1; appAccepted: boolean; appRejection?: string; activityReportSeq: number | null; appMetricsFinalized: boolean; }
export interface QueuedUsage { revision: number; expiresAt: number; report: UsageReport; }
const validSeconds = (value: unknown): value is number => typeof value === "number" && Number.isFinite(value) && value >= 0;
const validReason = (value: unknown): value is string => typeof value === "string" && value.length > 0 && value.length <= 256 && !Array.from(value).some(c => c.charCodeAt(0) < 32 || c.charCodeAt(0) === 127);
/** Bounded coalescing: retain the first final and one contradicting observation, never sum snapshots. */
export function coalesceUsage(old: UsageReport | undefined, update: UsageReport): UsageReport {
  const result: UsageReport = { schemaVersion: 1 };
  for (const item of [old, update]) {
    if (!item) continue;
    if (validSeconds(item.checkpointSeconds)) result.checkpointSeconds = Math.max(result.checkpointSeconds ?? 0, item.checkpointSeconds);
    for (const close of [item.providerClosed, item.conflictingProviderClosed]) {
      if (!close) continue;
      result.providerClosed ??= {};
      if (validSeconds(close.seconds)) {
        if (result.providerClosed.seconds === undefined) result.providerClosed.seconds = close.seconds;
        else if (result.providerClosed.seconds !== close.seconds) result.conflictingProviderClosed ??= { seconds: close.seconds };
      }
      if (validReason(close.reason)) result.providerClosed.reason ??= close.reason;
    }
    if (item.localCloseUnconfirmed) result.localCloseUnconfirmed = true;
    if (item.app && (!result.app || item.app.activityReportSeq > result.app.activityReportSeq)) result.app = structuredClone(item.app);
  }
  return result;
}
