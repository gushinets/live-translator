/**
 * In-memory non-content conversation metrics (binding spec 1.2.1 §26).
 * Never records transcript text or sends analytics.
 */
import { ATTRIBUTION_COUNTER_NAMES, type MetricCounters } from "./UsageTypes";

export interface TurnTimingInput {
  sourceIdleAtMs: number;
  firstOutputTextAtMs: number;
  firstAudibleOutputAtMs?: number;
  playbackEndAtMs?: number;
  turnCompletedAtMs?: number;
  listeningRestoredAtMs?: number;
  audioOutputStarted?: boolean;
}

export interface TurnMetrics {
  t1Ms: number;
  earlyOutputLeadMs: number;
  t2Ms?: number;
  t3Ms?: number;
}

export interface ConversationMetricsSnapshot {
  noObservedOutputDeadlineCount: number;
  unresolvedSourceOutcomeCount: number;
  lateOutputAfterDeadlineCount: number;
  attributionRevokedCount: number;
  earlyOutputCount: number;
  completedTurnCount: number;
  earlyOutputRate: number;
  sourceTailClippingReports: number;
  noOutputWatchdogCount: number;
  textOnlyCompletionCount: number;
  vamFalseActiveCount: number;
  audioCompletedTurnCount: number;
  textOnlyCompletedTurnCount: number;
  failedTurnCount: number;
  discardedTurnCount: number;
  poorOutputRoute: boolean;
  lastTurn: TurnMetrics | undefined;
}

export function calculateMetrics(input: TurnTimingInput): TurnMetrics {
  const result: TurnMetrics = {
    t1Ms: Math.max(0, input.firstOutputTextAtMs - input.sourceIdleAtMs),
    earlyOutputLeadMs: Math.max(0, input.sourceIdleAtMs - input.firstOutputTextAtMs),
  };

  if (input.firstAudibleOutputAtMs !== undefined) {
    result.t2Ms = Math.max(0, input.firstAudibleOutputAtMs - input.sourceIdleAtMs);
  }

  if (input.listeningRestoredAtMs !== undefined) {
    if (input.audioOutputStarted === true) {
      if (input.playbackEndAtMs === undefined) {
        throw new Error("playbackEndAtMs is required to compute audio-turn T3");
      }
      result.t3Ms = Math.max(0, input.listeningRestoredAtMs - input.playbackEndAtMs);
    } else {
      if (input.turnCompletedAtMs === undefined) {
        throw new Error("turnCompletedAtMs is required to compute text-only T3");
      }
      result.t3Ms = Math.max(0, input.listeningRestoredAtMs - input.turnCompletedAtMs);
    }
  }

  return result;
}

export class ConversationMetrics {
  private readonly attributionEvents = new Map<string, Set<string>>();
  private readonly restoredAttribution: MetricCounters = {};
  /** Deadlines dedupe by source; decisions by stable output ID and revision. Historical, never current success. */
  recordAttributionEvent(name: typeof ATTRIBUTION_COUNTER_NAMES[number], id: string): void {
    let events = this.attributionEvents.get(name);
    if (!events) this.attributionEvents.set(name, events = new Set());
    events.add(id);
  }
  private readonly technicalTurns = { audio: new Set<string>(), text_only: new Set<string>(), failed: new Set<string>(), discarded: new Set<string>() };
  private readonly restoredTurns = { audio: 0, text_only: 0, failed: 0, discarded: 0 };
  recordTechnicalOutcome(id: string, kind: keyof ConversationMetrics["technicalTurns"]): boolean {
    const set = this.technicalTurns[kind]; if (set.has(id)) return false; set.add(id); return true;
  }
  private earlyOutputCount = 0;
  private completedTurnCount = 0;
  private sourceTailClippingReports = 0;
  private noOutputWatchdogCount = 0;
  private textOnlyCompletionCount = 0;
  private vamFalseActiveCount = 0;
  private poorOutputRoute = false;
  private lastTurn: TurnMetrics | undefined;

  restoreCounters(counters: MetricCounters): void {
    for (const name of ATTRIBUTION_COUNTER_NAMES) this.restoredAttribution[name] = counters[name] ?? 0;
    this.earlyOutputCount = counters.earlyOutputCount ?? 0;
    this.completedTurnCount = counters.completedTurnCount ?? 0;
    this.sourceTailClippingReports = counters.sourceTailClippingReports ?? 0;
    this.noOutputWatchdogCount = counters.noOutputWatchdogCount ?? 0;
    this.textOnlyCompletionCount = counters.textOnlyCompletionCount ?? 0;
    this.poorOutputRoute = this.textOnlyCompletionCount > 0;
    this.vamFalseActiveCount = counters.vamFalseActiveCount ?? 0;
    this.restoredTurns.audio = counters.audioCompletedTurnCount ?? 0;
    this.restoredTurns.text_only = counters.textOnlyCompletedTurnCount ?? 0;
    this.restoredTurns.failed = counters.failedTurnCount ?? 0;
    this.restoredTurns.discarded = counters.discardedTurnCount ?? 0;
  }

  recordTurn(input: TurnTimingInput): TurnMetrics {
    const turn = calculateMetrics(input);
    this.completedTurnCount += 1;
    if (turn.earlyOutputLeadMs > 0) {
      this.earlyOutputCount += 1;
    }
    if (input.audioOutputStarted !== true) {
      this.textOnlyCompletionCount += 1;
      this.poorOutputRoute = true;
    }
    this.lastTurn = turn;
    return turn;
  }

  reportSourceTailClipping(): void {
    this.sourceTailClippingReports += 1;
  }

  recordNoOutputWatchdog(): void {
    this.noOutputWatchdogCount += 1;
  }

  recordVamFalseActive(): void {
    this.vamFalseActiveCount += 1;
  }

  snapshot(): ConversationMetricsSnapshot {
    return {
      noObservedOutputDeadlineCount: (this.restoredAttribution.noObservedOutputDeadlineCount ?? 0) + (this.attributionEvents.get("noObservedOutputDeadlineCount")?.size ?? 0),
      unresolvedSourceOutcomeCount: (this.restoredAttribution.unresolvedSourceOutcomeCount ?? 0) + (this.attributionEvents.get("unresolvedSourceOutcomeCount")?.size ?? 0),
      lateOutputAfterDeadlineCount: (this.restoredAttribution.lateOutputAfterDeadlineCount ?? 0) + (this.attributionEvents.get("lateOutputAfterDeadlineCount")?.size ?? 0),
      attributionRevokedCount: (this.restoredAttribution.attributionRevokedCount ?? 0) + (this.attributionEvents.get("attributionRevokedCount")?.size ?? 0),
      earlyOutputCount: this.earlyOutputCount,
      completedTurnCount: this.completedTurnCount,
      earlyOutputRate:
        this.completedTurnCount === 0
          ? 0
          : this.earlyOutputCount / this.completedTurnCount,
      sourceTailClippingReports: this.sourceTailClippingReports,
      noOutputWatchdogCount: this.noOutputWatchdogCount,
      textOnlyCompletionCount: this.textOnlyCompletionCount,
      vamFalseActiveCount: this.vamFalseActiveCount,
      audioCompletedTurnCount: this.restoredTurns.audio + this.technicalTurns.audio.size,
      textOnlyCompletedTurnCount: this.restoredTurns.text_only + this.technicalTurns.text_only.size,
      failedTurnCount: this.restoredTurns.failed + this.technicalTurns.failed.size,
      discardedTurnCount: this.restoredTurns.discarded + this.technicalTurns.discarded.size,
      poorOutputRoute: this.poorOutputRoute,
      lastTurn: this.lastTurn === undefined ? undefined : { ...this.lastTurn },
    };
  }
}
