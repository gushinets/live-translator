import { z } from "zod";
import type { CloseObservation, ObservationSource, SessionRow } from "./types.js";

const nonNegative = z.number().finite().nonnegative();
const integer = nonNegative.int().max(Number.MAX_SAFE_INTEGER);
export const counterNames = [
  "earlyOutputCount", "completedTurnCount", "sourceTailClippingReports", "noOutputWatchdogCount",
  "textOnlyCompletionCount", "vamFalseActiveCount", "wrongSideCorrectionCount", "correctionSuccessCount",
  "audioCompletedTurnCount", "textOnlyCompletedTurnCount", "failedTurnCount", "discardedTurnCount",
  "correctionAttemptCount", "deliveryDegradedCount",
] as const;
export const counterSchema = z.object(Object.fromEntries(counterNames.map(key => [key, integer.optional()])) as Record<typeof counterNames[number], z.ZodOptional<typeof integer>>).strict();
export const appMetricsSchema = z.object({
  activityReportSeq: integer,
  measurementVersion: z.string().min(1).max(64),
  observedWallMs: integer, setupMs: integer, activeInterpreterMs: integer, visiblePausedMs: integer,
  acceptedSourceSpeechMs: integer.nullable(), completedSourceSpeechMs: integer.nullable(),
  speechMeasurementVersion: z.string().min(1).max(64),
  speechMeasurementStatus: z.enum(["complete", "partial", "unavailable"]),
  appMetricsFinalized: z.boolean(), counters: counterSchema,
  providerStartedObservedAt: integer.optional(), interpreterReadyObservedAt: integer.optional(),
  lastCheckpointAtInterpreterReady: nonNegative.optional(),
}).strict().refine(a => a.setupMs + a.activeInterpreterMs + a.visiblePausedMs <= a.observedWallMs, "Phase durations exceed observed wall time")
  .refine(a => a.speechMeasurementStatus === "unavailable"
    ? a.acceptedSourceSpeechMs === null && a.completedSourceSpeechMs === null
    : a.acceptedSourceSpeechMs !== null && a.completedSourceSpeechMs !== null && a.completedSourceSpeechMs <= a.acceptedSourceSpeechMs,
  "Invalid speech coverage or subset");
export type AppMetricsReport = z.infer<typeof appMetricsSchema>;
export function validSeconds(value: unknown): value is number { return typeof value === "number" && Number.isFinite(value) && value >= 0; }
export function validReason(value: unknown): value is string {
  return typeof value === "string" && value.length > 0 && value.length <= 256 && !Array.from(value).some(c => c.charCodeAt(0) < 32 || c.charCodeAt(0) === 127);
}
// Corrupt numeric metering never discards an otherwise valid close observation.
const closeSchema = z.object({ seconds: z.unknown().optional(), reason: z.unknown().optional() }).strict().transform(value => ({
  ...(validSeconds(value.seconds) ? { seconds: value.seconds } : {}),
  ...(validReason(value.reason) ? { reason: value.reason } : {}),
  ...(value.seconds !== undefined && !validSeconds(value.seconds) ? { invalidSeconds: true } : {}),
}));
type UsageCloseReport = z.output<typeof closeSchema>;
export interface UsageReport {
  schemaVersion: 1;
  checkpointSeconds?: number;
  providerClosed?: UsageCloseReport;
  conflictingProviderClosed?: UsageCloseReport;
  localCloseUnconfirmed?: true;
  app?: AppMetricsReport;
  invalidAppMetrics?: true;
}
export const usageReportSchema = z.object({
  schemaVersion: z.literal(1), checkpointSeconds: nonNegative.optional(),
  providerClosed: closeSchema.optional(), conflictingProviderClosed: closeSchema.optional(),
  localCloseUnconfirmed: z.literal(true).optional(), app: z.unknown().optional(),
}).strict().refine(value => value.checkpointSeconds !== undefined || value.providerClosed !== undefined || value.localCloseUnconfirmed || value.app !== undefined,
  "Empty usage report").refine(value => !value.conflictingProviderClosed || value.providerClosed, "Conflict requires original close observation")
  .transform(value => {
    const { app: rawApp, ...report } = value;
    if (rawApp === undefined) return report;
    const app = appMetricsSchema.safeParse(rawApp);
    return app.success ? { ...report, app: app.data } : { ...report, invalidAppMetrics: true as const };
  }) as unknown as z.ZodType<UsageReport>;
const strength = (source: ObservationSource | null) => source === "sideband" ? 2 : source === "browser" ? 1 : 0;

/** Pure numeric/reason merge. Lifecycle and cooperative release remain in UsageLedger.closeInternal. */
export function mergeUsage(row: SessionRow, incoming: { checkpointSeconds?: number; closed?: CloseObservation & { invalidSeconds?: boolean } }, source: ObservationSource, now: number): Partial<SessionRow> {
  const fields: Partial<SessionRow> = {};
  const details: Record<string, unknown> = row.usage_conflict_details ? JSON.parse(row.usage_conflict_details) as Record<string, unknown> : {};
  const conflict = (kind: string, existing: number, existingSource: ObservationSource | null, value: number) => {
    fields.usage_conflict = 1;
    details.numeric ??= { kind, existing, existingSource, incoming: value, incomingSource: source, receivedAt: now };
  };
  const checkpoint = incoming.checkpointSeconds;
  if (validSeconds(checkpoint)) {
    if (row.provider_checkpoint_seconds === null || checkpoint > row.provider_checkpoint_seconds) {
      fields.provider_checkpoint_seconds = checkpoint; fields.provider_checkpoint_source = source;
      fields.last_checkpoint_received_at = now;
    } else if (checkpoint === row.provider_checkpoint_seconds && strength(source) > strength(row.provider_checkpoint_source)) fields.provider_checkpoint_source = source;
    if (row.provider_final_seconds !== null && checkpoint > row.provider_final_seconds) conflict("checkpoint_above_final", row.provider_final_seconds, row.provider_final_source, checkpoint);
  }
  const closed = incoming.closed;
  if (closed) {
    if (closed.invalidSeconds || (closed.seconds !== undefined && !validSeconds(closed.seconds))) details.invalidSeconds = true;
    if (validSeconds(closed.seconds)) {
      if (row.provider_final_seconds === null) { fields.provider_final_seconds = closed.seconds; fields.provider_final_source = source; }
      else if (row.provider_final_seconds === closed.seconds && strength(source) > strength(row.provider_final_source)) fields.provider_final_source = source;
      if (row.provider_final_seconds !== null && row.provider_final_seconds !== closed.seconds) conflict("conflicting_final", row.provider_final_seconds, row.provider_final_source, closed.seconds);
      const maxCheckpoint = fields.provider_checkpoint_seconds ?? row.provider_checkpoint_seconds;
      if (maxCheckpoint !== null && closed.seconds < maxCheckpoint) conflict("final_below_checkpoint", maxCheckpoint, fields.provider_checkpoint_source ?? row.provider_checkpoint_source, closed.seconds);
    }
    if (validReason(closed.reason)) {
      if (row.provider_close_reason !== null && row.provider_close_reason !== closed.reason && strength(source) === strength(row.provider_close_reason_source)) {
        // The stored reason is retained; no unbounded collection of provider strings.
        details.reason ??= { kind: "conflicting_reason", source, receivedAt: now };
      }
      if (row.provider_close_reason === null || strength(source) > strength(row.provider_close_reason_source)) {
        fields.provider_close_reason = closed.reason; fields.provider_close_reason_source = source;
      }
    }
  }
  if (Object.keys(details).length) fields.usage_conflict_details = JSON.stringify(details);
  fields.usage_quality = fields.usage_conflict === 1 || row.usage_conflict === 1 ? "conflict"
    : (fields.provider_final_seconds ?? row.provider_final_seconds) !== null ? "final"
      : (fields.provider_checkpoint_seconds ?? row.provider_checkpoint_seconds) !== null ? "partial" : "unknown";
  return fields;
}

const durationFields = {
  observedWallMs: "observed_wall_ms", setupMs: "setup_ms", activeInterpreterMs: "active_interpreter_ms",
  visiblePausedMs: "visible_paused_ms", acceptedSourceSpeechMs: "accepted_source_speech_ms", completedSourceSpeechMs: "completed_source_speech_ms",
} as const;
export function mergeAppMetrics(row: SessionRow, app: AppMetricsReport): { accepted: boolean; reason?: string; fields: Partial<SessionRow> } {
  if (row.activity_report_seq !== null && app.activityReportSeq <= row.activity_report_seq) return { accepted: true, fields: {} };
  if (app.measurementVersion !== "active-time-v1" || app.speechMeasurementVersion !== "vam-pre-tail-v1") return { accepted: false, reason: "unsupported_measurement_version", fields: {} };
  if ((row.measurement_version !== null && row.measurement_version !== app.measurementVersion) ||
      (row.speech_measurement_version !== null && row.speech_measurement_version !== app.speechMeasurementVersion)) return { accepted: false, reason: "measurement_version_conflict", fields: {} };
  if (row.app_metrics_finalized === 1) return { accepted: false, reason: "app_metrics_already_finalized", fields: {} };
  for (const [key, column] of Object.entries(durationFields)) {
    const before = row[column], after = app[key as keyof typeof durationFields];
    if (before !== null && (after === null || after < before)) return { accepted: false, reason: "regressive_app_totals", fields: {} };
  }
  const previous = row.metrics_json ? JSON.parse(row.metrics_json) as Record<string, number> : {};
  for (const key of counterNames) if ((app.counters[key] ?? 0) < (previous[key] ?? 0)) return { accepted: false, reason: "regressive_app_counters", fields: {} };
  return { accepted: true, fields: {
    ...Object.fromEntries(Object.entries(durationFields).map(([key, column]) => [column, app[key as keyof typeof durationFields]])),
    activity_report_seq: app.activityReportSeq, measurement_version: app.measurementVersion,
    speech_measurement_version: app.speechMeasurementVersion,
    speech_measurement_status: row.speech_measurement_status === "partial" ? "partial" : app.speechMeasurementStatus,
    app_metrics_finalized: app.appMetricsFinalized ? 1 : 0, metrics_json: JSON.stringify(app.counters),
    provider_started_observed_at: row.provider_started_observed_at ?? app.providerStartedObservedAt ?? null,
    interpreter_ready_observed_at: row.interpreter_ready_observed_at ?? app.interpreterReadyObservedAt ?? null,
    last_checkpoint_at_interpreter_ready: row.last_checkpoint_at_interpreter_ready ?? app.lastCheckpointAtInterpreterReady ?? null,
  } };
}
