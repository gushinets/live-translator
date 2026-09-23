import type { SessionRow } from "../accounting/types.js";
import { counterNames } from "../accounting/mergeUsage.js";
const sum = (values: number[]) => values.reduce((total, value) => total + value, 0);
const counts = (values: (string | null)[]) => {
  const result: Record<string, number> = Object.create(null) as Record<string, number>;
  for (const value of values) result[value ?? "unknown"] = (result[value ?? "unknown"] ?? 0) + 1;
  return result;
};
const durationColumns = {
  observedWallMs: "observed_wall_ms", setupMs: "setup_ms", activeInterpreterMs: "active_interpreter_ms",
  visiblePausedMs: "visible_paused_ms", acceptedSourceSpeechMs: "accepted_source_speech_ms", completedSourceSpeechMs: "completed_source_speech_ms",
} as const;
/** Pure projection of owner-checked rows. NULLs and quality are part of the report, not missing defaults. */
export function conversationSummary(rows: SessionRow[]) {
  const dispatched = rows.filter(row => row.provider_request_dispatched_at !== null);
  const final = dispatched.filter(row => row.usage_conflict === 0 && row.provider_final_seconds !== null);
  const partial = dispatched.filter(row => row.usage_conflict === 0 && row.provider_final_seconds === null && row.provider_checkpoint_seconds !== null);
  const conflict = dispatched.filter(row => row.usage_conflict === 1);
  const unknownCount = dispatched.length - final.length - partial.length - conflict.length;
  const finalSeconds = sum(final.map(row => row.provider_final_seconds!)), partialSeconds = sum(partial.map(row => row.provider_checkpoint_seconds!));
  const completeProvider = dispatched.length > 0 && final.length === dispatched.length;
  const totalProviderSeconds = completeProvider ? finalSeconds : null;
  const appFinalizedCount = dispatched.filter(row => row.app_metrics_finalized === 1).length;
  const versions = [...new Set(dispatched.map(row => row.measurement_version).filter(v => v !== null))];
  const speechVersions = [...new Set(dispatched.map(row => row.speech_measurement_version).filter(v => v !== null))];
  const completeApp = dispatched.length > 0 && appFinalizedCount === dispatched.length && versions.length === 1;
  const completeSpeech = completeApp && speechVersions.length === 1 && dispatched.every(row => row.speech_measurement_status === "complete");
  const observedSubtotals = Object.fromEntries(Object.entries(durationColumns).map(([key, column]) => [key, sum(dispatched.flatMap(row => row[column] === null ? [] : [row[column]]))])) as Record<keyof typeof durationColumns, number>;
  const durations = Object.fromEntries(Object.entries(durationColumns).map(([key, column]) => [key,
    dispatched.length > 0 && dispatched.every(row => row[column] !== null) ? observedSubtotals[key as keyof typeof durationColumns] : null,
  ])) as Record<keyof typeof durationColumns, number | null>;
  const ratio = (duration: number | null, covered: boolean) => completeProvider && covered && duration !== null && duration > 0 ? finalSeconds * 60000 / duration : null;
  const metrics: Record<string, number> = {};
  for (const row of rows) {
    const data = row.metrics_json ? JSON.parse(row.metrics_json) as Record<string, unknown> : {};
    for (const name of counterNames) if (typeof data[name] === "number" && Number.isFinite(data[name])) metrics[name] = (metrics[name] ?? 0) + data[name];
  }
  return {
    summaryVersion: 1, cohort: "dispatched_provider_attempts",
    attempts: { total: rows.length, dispatched: dispatched.length, notDispatched: rows.length - dispatched.length,
      states: counts(rows.map(row => row.state)), startReasons: counts(rows.map(row => row.start_reason)),
      committedResumes: rows.filter(row => row.resume_outcome === "committed").length },
    usage: { finalSeconds, partialSeconds, observedNonConflictingSeconds: finalSeconds + partialSeconds,
      totalProviderSeconds, finalCount: final.length, partialCount: partial.length, unknownCount, conflictCount: conflict.length,
      finalCountCoverage: dispatched.length ? final.length / dispatched.length : null,
      finalShareOfKnownSeconds: finalSeconds + partialSeconds > 0 ? finalSeconds / (finalSeconds + partialSeconds) : null,
      checkpointSources: counts(dispatched.map(row => row.provider_checkpoint_source)), finalSources: counts(dispatched.map(row => row.provider_final_source)),
      estimates: rows.filter(row => row.estimated_total_seconds !== null).map(row => ({ liveSessionId: row.id, seconds: row.estimated_total_seconds, method: row.estimate_method_version, asOf: row.estimate_as_of })) },
    durations: { ...durations, observedSubtotals, reportedSessionCount: dispatched.filter(row => row.activity_report_seq !== null).length,
      appFinalizedCount, completeApp, completeSpeech, measurementVersions: versions, speechMeasurementVersions: speechVersions,
      speechCoverage: counts(dispatched.map(row => row.speech_measurement_status)) },
    ratios: { providerSecondsPerActiveMinute: ratio(durations.activeInterpreterMs, completeApp),
      providerSecondsPerAcceptedSpeechMinute: ratio(durations.acceptedSourceSpeechMs, completeSpeech),
      providerSecondsPerCompletedSpeechMinute: ratio(durations.completedSourceSpeechMs, completeSpeech) },
    providerSecondsByPhase: null, phaseAllocation: "not_measured", metrics,
    closeConfirmationSources: counts(dispatched.map(row => row.close_confirmation_source)),
    providerCloseReasons: counts(dispatched.map(row => row.provider_close_reason)), appEndReasons: counts(rows.map(row => row.app_end_reason)),
    limitations: ["Browser-forwarded usage is not independently verified billing.", "Completed-source speech is a technical audio-delivery proxy, not semantic translation quality.", "Phase wall times are not provider phase costs. Estimates are never added to observations.", "Ratios require complete comparable provider/application coverage; monetary calibration is separate."],
  };
}
