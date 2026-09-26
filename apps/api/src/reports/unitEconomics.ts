import type { DatabaseSync } from "node:sqlite";
import { counterNames } from "../accounting/mergeUsage.js";
import type { ConversationRow, SessionRow } from "../accounting/types.js";
import { conversationSummary } from "./conversationSummary.js";
import { estimateCurrentPriceScenario, estimateHistoricalCost, PRICING_POLICIES, type PricingPolicy } from "./pricingPolicy.js";

export type DatasetClass = "product" | "experimental" | "synthetic";
export type UnitEconomicsOptions = Readonly<{
  from: number;
  to: number;
  asOf: number;
  generatedAt: number;
  dataClass: DatasetClass;
  pricingPolicies?: readonly PricingPolicy[];
}>;

export class UnitEconomicsReportError extends Error {
  constructor(readonly code: "invalid_range" | "invalid_metadata") {
    super(code);
    this.name = "UnitEconomicsReportError";
  }
}

const count = (values: readonly (string | null | undefined)[]): Record<string, number> => {
  const result: Record<string, number> = Object.create(null) as Record<string, number>;
  for (const value of values) {
    const key = value ?? "unknown";
    result[key] = (result[key] ?? 0) + 1;
  }
  return result;
};
const sum = (values: readonly number[]) => values.reduce((total, value) => total + value, 0);
const iso = (value: number) => new Date(value).toISOString();
const dispatched = (row: SessionRow) => row.provider_request_dispatched_at !== null;
const terminal = (row: SessionRow) => row.state === "closed" || row.state === "failed";

function metadataObject(raw: string, code: "invalid_metadata"): Record<string, unknown> {
  try {
    const value: unknown = JSON.parse(raw);
    if (value === null || typeof value !== "object" || Array.isArray(value)) throw new Error();
    return value as Record<string, unknown>;
  } catch { throw new UnitEconomicsReportError(code); }
}

function validateMetadata(conversations: readonly ConversationRow[], rows: readonly SessionRow[]): Map<string, Record<string, unknown>> {
  const policies = new Map<string, Record<string, unknown>>();
  for (const conversation of conversations) policies.set(conversation.id, metadataObject(conversation.policy_json, "invalid_metadata"));
  const knownCounters = new Set<string>(counterNames);
  for (const row of rows) {
    if (row.metrics_json !== null) {
      const metrics = metadataObject(row.metrics_json, "invalid_metadata");
      if (Object.entries(metrics).some(([key, value]) => !knownCounters.has(key) || typeof value !== "number" || !Number.isFinite(value) || value < 0)) {
        throw new UnitEconomicsReportError("invalid_metadata");
      }
    }
    if (row.usage_conflict_details !== null) metadataObject(row.usage_conflict_details, "invalid_metadata");
  }
  return policies;
}

function quality(row: SessionRow): "not_dispatched" | "final" | "partial" | "unknown" | "conflict" {
  if (!dispatched(row)) return "not_dispatched";
  if (row.usage_conflict !== 0) return "conflict";
  if (row.provider_final_seconds !== null) return "final";
  if (row.provider_checkpoint_seconds !== null) return "partial";
  return "unknown";
}

const durationColumns = {
  setupMs: "setup_ms",
  activeInterpreterMs: "active_interpreter_ms",
  acceptedSourceSpeechMs: "accepted_source_speech_ms",
  completedSourceSpeechMs: "completed_source_speech_ms",
} as const;

function distribution(conversations: readonly { summary: ReturnType<typeof conversationSummary>; rows: readonly SessionRow[] }[]) {
  const values: number[] = [];
  const excluded: string[] = [];
  for (const { summary, rows } of conversations) {
    if (!rows.some(dispatched)) excluded.push("no_dispatched_provider_attempt");
    else if (summary.usage.conflictCount) excluded.push("conflicting_provider_usage");
    else if (summary.usage.partialCount) excluded.push("partial_provider_usage");
    else if (summary.usage.unknownCount) excluded.push("unknown_provider_usage");
    else if (summary.usage.totalProviderSeconds === null) excluded.push("incomplete_provider_usage");
    else values.push(summary.usage.totalProviderSeconds);
  }
  values.sort((a, b) => a - b);
  const middle = Math.floor(values.length / 2);
  const median = values.length === 0 ? null : values.length % 2 ? values[middle]! : (values[middle - 1]! + values[middle]!) / 2;
  const p95 = values.length === 0 ? null : values[Math.ceil(0.95 * values.length) - 1]!;
  return { mean: values.length ? sum(values) / values.length : null, median, p95, sampleSize: values.length,
    percentileMethod: "nearest_rank_ceil_0.95n", excludedReasons: count(excluded) };
}

type RatioMetric = "active" | "accepted" | "completed";
type ConversationInfo = { rows: SessionRow[]; summary: ReturnType<typeof conversationSummary>; backgroundPolicy: boolean | null; policyVersion: string };
function ratioReason(info: ConversationInfo, metric: RatioMetric): string | null {
  const rows = info.rows.filter(dispatched);
  if (!rows.length) return "no_dispatched_provider_attempt";
  if (rows.some(row => row.usage_conflict !== 0)) return "conflicting_provider_usage";
  if (rows.some(row => row.provider_final_seconds === null)) {
    return rows.some(row => row.provider_checkpoint_seconds !== null) ? "partial_provider_usage" : "unknown_provider_usage";
  }
  if (!info.summary.durations.completeApp) return "incomplete_app_measurement";
  if (new Set(rows.map(row => row.app_version)).size !== 1) return "incompatible_app_versions";
  if (new Set(rows.map(row => row.model)).size !== 1) return "incompatible_models";
  if (!info.policyVersion) return "missing_conversation_policy_version";
  if (info.backgroundPolicy === null) return "missing_background_policy_version";
  if (info.summary.durations.measurementVersions.length !== 1) return "incompatible_measurement_versions";
  if (metric !== "active") {
    if (!info.summary.durations.completeSpeech) return "incomplete_speech_coverage";
    if (info.summary.durations.speechMeasurementVersions.length !== 1) return "incompatible_speech_versions";
  }
  const duration = metric === "active" ? info.summary.durations.activeInterpreterMs
    : metric === "accepted" ? info.summary.durations.acceptedSourceSpeechMs : info.summary.durations.completedSourceSpeechMs;
  if (duration === null) return "missing_duration";
  if (duration === 0) return metric === "active" ? "zero_active_duration"
    : metric === "accepted" ? "zero_accepted_speech_duration" : "zero_completed_speech_duration";
  return null;
}

function dimensions(info: ConversationInfo, metric: RatioMetric): Record<string, string> | null {
  const rows = info.rows.filter(dispatched);
  const one = (values: readonly (string | null)[]): string | null => {
    const present = [...new Set(values)];
    return present.length === 1 ? present[0]! : null;
  };
  const appVersion = one(rows.map(row => row.app_version));
  const model = one(rows.map(row => row.model));
  const measurementVersion = one(rows.map(row => row.measurement_version));
  if (!appVersion || !model || !measurementVersion) return null;
  const result: Record<string, string> = { appVersion, model, conversationPolicyVersion: info.policyVersion,
    backgroundSessionCloseEnabled: String(info.backgroundPolicy), measurementVersion };
  if (metric !== "active") {
    const speechVersion = one(rows.map(row => row.speech_measurement_version));
    if (!speechVersion) return null;
    result.speechMeasurementVersion = speechVersion;
  }
  return result;
}

function ratioReport(infos: readonly ConversationInfo[], metric: RatioMetric) {
  const excluded: string[] = [];
  const groups = new Map<string, { dimensions: Record<string, string>; numerator: number[]; denominatorMs: number[]; included: number }>();
  for (const info of infos) {
    const reason = ratioReason(info, metric);
    if (reason) { excluded.push(reason); continue; }
    const versionKey = dimensions(info, metric);
    if (!versionKey) { excluded.push("incompatible_measurement_versions"); continue; }
    const rows = info.rows.filter(dispatched);
    const key = JSON.stringify(versionKey);
    const group = groups.get(key) ?? { dimensions: versionKey, numerator: [], denominatorMs: [], included: 0 };
    group.numerator.push(...rows.map(row => row.provider_final_seconds!));
    const denominator = metric === "active" ? info.summary.durations.activeInterpreterMs!
      : metric === "accepted" ? info.summary.durations.acceptedSourceSpeechMs! : info.summary.durations.completedSourceSpeechMs!;
    group.denominatorMs.push(denominator);
    group.included++;
    groups.set(key, group);
  }
  const denominatorFor = (values: readonly number[]) => sum(values);
  const multiplier = metric === "active" || metric === "accepted" || metric === "completed" ? 60000 : 1000;
  const segments = [...groups.values()].map(group => {
    const numeratorSeconds = sum(group.numerator), denominatorMs = denominatorFor(group.denominatorMs);
    return { dimensions: group.dimensions, includedConversations: group.included, numeratorProviderSeconds: numeratorSeconds,
      denominatorMs, value: denominatorMs > 0 ? numeratorSeconds * multiplier / denominatorMs : null,
      nullReason: denominatorMs > 0 ? null : "zero_denominator" };
  });
  const included = segments.reduce((total, segment) => total + segment.includedConversations, 0);
  const selected = infos.length;
  const unique = segments.length === 1 ? segments[0]! : null;
  return { value: unique?.value ?? null, includedConversations: included, selectedConversations: selected,
    countCoverage: selected ? included / selected : null, numeratorProviderSeconds: unique?.numeratorProviderSeconds ?? null,
    denominatorMs: unique?.denominatorMs ?? null, method: "ratio_of_sums_v1", excludedReasons: count(excluded), segments,
    nullReason: unique ? unique.nullReason : segments.length ? "multiple_compatible_segments" : "no_comparable_conversations" };
}

function estimatedUsage(rows: readonly SessionRow[]) {
  const groups = new Map<string, { method: string; asOf: number | null; count: number; seconds: number }>();
  for (const row of rows) {
    if (row.estimated_total_seconds === null) continue;
    const method = row.estimate_method_version ?? "unknown";
    const key = `${method}\0${row.estimate_as_of ?? "unknown"}`;
    const group = groups.get(key) ?? { method, asOf: row.estimate_as_of, count: 0, seconds: 0 };
    group.count++;
    group.seconds += row.estimated_total_seconds;
    groups.set(key, group);
  }
  return [...groups.values()].map(group => ({ ...group, asOf: group.asOf === null ? null : iso(group.asOf) }));
}

function pricingSummary(rows: readonly SessionRow[], asOf: number, policies: readonly PricingPolicy[]) {
  const byMode = (mode: "historical" | "current") => {
    const results = rows.filter(dispatched).map(row => {
      if (row.usage_conflict !== 0) return { status: "unavailable" as const, reason: "conflicting_provider_usage" };
      const seconds = row.provider_final_seconds;
      return mode === "historical"
        ? estimateHistoricalCost(seconds, row.model, row.provider_request_dispatched_at!, row.pricing_policy_version, policies)
        : estimateCurrentPriceScenario(seconds, row.model, asOf, policies);
    });
    const unavailable: string[] = [];
    const byPolicy = new Map<string, { policyVersion: string; model: string; currency: string; amountMinorUnits: bigint; count: number }>();
    for (const result of results) {
      if (result.status === "unavailable") { unavailable.push(result.reason); continue; }
      const key = `${result.policyVersion}\0${result.currency}\0${result.model}`;
      const group = byPolicy.get(key) ?? { policyVersion: result.policyVersion, model: result.model, currency: result.currency, amountMinorUnits: 0n, count: 0 };
      group.amountMinorUnits += BigInt(result.amountMinorUnits);
      group.count++;
      byPolicy.set(key, group);
    }
    return { basis: "provider_final_seconds_only", estimatedCount: results.length - unavailable.length,
      unavailableReasons: count(unavailable), byPolicy: [...byPolicy.values()].map(group => ({ ...group, amountMinorUnits: group.amountMinorUnits.toString() })) };
  };
  return { rawUsageUnchanged: true, historicalFinal: byMode("historical"), currentPriceScenario: byMode("current"),
    invoiceTotal: null };
}

function readReport(db: DatabaseSync, options: UnitEconomicsOptions) {
  if (![options.from, options.to, options.asOf, options.generatedAt].every(value => Number.isSafeInteger(value) && value >= 0) ||
      options.from >= options.to || !["product", "experimental", "synthetic"].includes(options.dataClass)) {
    throw new UnitEconomicsReportError("invalid_range");
  }
  const conversations = db.prepare("SELECT * FROM conversations WHERE created_at>=? AND created_at<? ORDER BY created_at,id")
    .all(options.from, options.to) as unknown as ConversationRow[];
  const allAttempts = db.prepare(`SELECT s.* FROM live_sessions AS s JOIN conversations AS c ON c.id=s.conversation_id
    WHERE c.created_at>=? AND c.created_at<? AND s.creation_requested_at>=? AND s.creation_requested_at<?
    ORDER BY s.conversation_id,s.generation`).all(options.from, options.to, options.from, options.to) as unknown as SessionRow[];
  const policyMetadata = validateMetadata(conversations, allAttempts);
  const byConversation = new Map<string, SessionRow[]>();
  for (const row of allAttempts) {
    const group = byConversation.get(row.conversation_id) ?? [];
    group.push(row);
    byConversation.set(row.conversation_id, group);
  }
  const infos: ConversationInfo[] = conversations.map(conversation => {
    const rows = byConversation.get(conversation.id) ?? [];
    const policy = policyMetadata.get(conversation.id)!;
    return { rows, summary: conversationSummary(rows),
      backgroundPolicy: typeof policy.backgroundSessionCloseEnabled === "boolean" ? policy.backgroundSessionCloseEnabled : null,
      policyVersion: conversation.conversation_policy_version };
  });
  const dispatchedRows = allAttempts.filter(dispatched);
  const qualities = count(allAttempts.map(quality));
  const finalRows = dispatchedRows.filter(row => row.usage_conflict === 0 && row.provider_final_seconds !== null);
  const partialRows = dispatchedRows.filter(row => quality(row) === "partial");
  const finalSeconds = sum(finalRows.map(row => row.provider_final_seconds!));
  const partialCheckpointSeconds = sum(partialRows.map(row => row.provider_checkpoint_seconds!));
  const knownSeconds = finalSeconds + partialCheckpointSeconds;
  const durationCoverage = Object.fromEntries(Object.entries(durationColumns).map(([name, column]) => {
    const present = dispatchedRows.filter(row => row[column] !== null).length;
    return [name, { observedAttempts: present, dispatchedAttempts: dispatchedRows.length,
      countCoverage: dispatchedRows.length ? present / dispatchedRows.length : null,
      observedSubtotalMs: sum(dispatchedRows.flatMap(row => row[column] === null ? [] : [row[column]!])) }];
  }));
  const cleanup = {
    pending: allAttempts.filter(row => row.cleanup_requested_at !== null && !terminal(row) && row.cleanup_retry_exhausted_at === null && row.cleanup_blocked_at === null).length,
    retryExhausted: allAttempts.filter(row => row.cleanup_retry_exhausted_at !== null).length,
    blockedAuthConfig: allAttempts.filter(row => row.cleanup_last_result === "blocked_auth_config" && row.cleanup_blocked_at !== null).length,
    terminalNotLive: allAttempts.filter(row => row.cleanup_last_result === "terminal_not_live").length,
    closedObserved: allAttempts.filter(row => row.cleanup_last_result === "closed_observed" || row.close_confirmed === 1).length,
    retryableError: allAttempts.filter(row => row.cleanup_last_result === "retryable_error").length,
    states: count(allAttempts.map(row => row.state)),
    lastResults: count(allAttempts.map(row => row.cleanup_last_result)),
  };
  const policies = options.pricingPolicies ?? PRICING_POLICIES;
  return {
    reportVersion: "unit-economics-v1", generatedAt: iso(options.generatedAt), asOf: iso(options.asOf), dataClass: options.dataClass,
    selection: { timezone: "UTC", interval: { from: iso(options.from), to: iso(options.to) }, lowerInclusive: true, upperExclusive: true,
      conversations: "created_at in [from,to)", attempts: "creation_requested_at in [from,to) for selected conversations",
      databaseScope: "one explicitly supplied SQLite database; product and experimental databases are reported separately" },
    sample: { conversations: conversations.length, attempts: allAttempts.length, dispatchedAttempts: dispatchedRows.length,
      notDispatchedAttempts: allAttempts.length - dispatchedRows.length },
    attempts: { states: count(allAttempts.map(row => row.state)), startReasons: count(allAttempts.map(row => row.start_reason)),
      committedResumes: allAttempts.filter(row => row.resume_outcome === "committed").length,
      resumeOutcomes: count(allAttempts.map(row => row.resume_outcome)), providerAttempts: dispatchedRows.length },
    usage: { byQuality: qualities, finalCount: qualities.final ?? 0, partialCount: qualities.partial ?? 0,
      unknownCount: qualities.unknown ?? 0, conflictCount: qualities.conflict ?? 0, notDispatchedCount: qualities.not_dispatched ?? 0,
      finalSeconds, partialCheckpointSeconds, observedNonConflictingSeconds: knownSeconds,
      finalCountCoverage: dispatchedRows.length ? finalRows.length / dispatchedRows.length : null,
      knownCountCoverage: dispatchedRows.length ? (finalRows.length + partialRows.length) / dispatchedRows.length : null,
      finalShareOfKnownSeconds: knownSeconds > 0 ? finalSeconds / knownSeconds : null,
      estimates: estimatedUsage(dispatchedRows),
      checkpointSources: count(dispatchedRows.map(row => row.provider_checkpoint_source)),
      finalSources: count(dispatchedRows.map(row => row.provider_final_source)),
      closeConfirmationSources: count(dispatchedRows.map(row => row.close_confirmation_source)),
      closeReasonObservedCount: dispatchedRows.filter(row => row.provider_close_reason !== null).length,
      browserTrust: "browser observations are client-reported; sideband observations are server-observed" },
    durations: { coverage: durationCoverage,
      appFinalizedAttempts: dispatchedRows.filter(row => row.app_metrics_finalized === 1).length,
      measurementVersions: count(dispatchedRows.map(row => row.measurement_version)),
      speechMeasurementVersions: count(dispatchedRows.map(row => row.speech_measurement_version)),
      speechCoverage: count(dispatchedRows.map(row => row.speech_measurement_status)),
      appFinalized: dispatchedRows.length > 0 && dispatchedRows.every(row => row.app_metrics_finalized === 1) },
    ratios: {
      providerSecondsPerActiveMinute: ratioReport(infos, "active"),
      providerSecondsPerAcceptedSpeechMinute: ratioReport(infos, "accepted"),
      providerSecondsPerCompletedSpeechMinute: ratioReport(infos, "completed"),
      providerSecondsPerAcceptedSpeechSecond: (() => {
        const report = ratioReport(infos, "accepted");
        return { ...report, value: report.value === null ? null : report.value / 60, unit: "provider_seconds_per_accepted_speech_second" };
      })(),
    },
    distributions: { providerSecondsPerConversation: distribution(infos) },
    cleanup,
    versions: { app: count(allAttempts.map(row => row.app_version)), model: count(allAttempts.map(row => row.model)),
      conversationPolicy: count(conversations.map(row => row.conversation_policy_version)),
      pricingPolicy: count(allAttempts.map(row => row.pricing_policy_version)) },
    pricing: pricingSummary(allAttempts, options.asOf, policies),
    phaseAllocation: { providerSecondsByPhase: null, method: "not_measured" },
  };
}

/** Reads one SQLite snapshot only; maintenance and server bootstrap remain owned elsewhere. */
export function buildUnitEconomicsReport(db: DatabaseSync, options: UnitEconomicsOptions) {
  let open = false;
  try {
    db.exec("BEGIN DEFERRED");
    open = true;
    const report = readReport(db, options);
    db.exec("COMMIT");
    open = false;
    return report;
  } catch (error) {
    if (open) { try { db.exec("ROLLBACK"); } catch { /* Keep the original report error. */ } }
    throw error;
  }
}
