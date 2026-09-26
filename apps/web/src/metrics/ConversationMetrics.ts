/**
 * In-memory non-content conversation metrics (binding spec 1.2.1 §26).
 * Never records transcript text or sends analytics.
 */
import type { MetricCounters } from "./UsageTypes";

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
  earlyOutputCount: number;
  completedTurnCount: number;
  earlyOutputRate: number;
  sourceTailClippingReports: number;
  noOutputWatchdogCount: number;
  textOnlyCompletionCount: number;
  vamFalseActiveCount: number;
  wrongSideCorrectionCount: number;
  correctionSuccessCount: number;
  audioCompletedTurnCount: number;
  textOnlyCompletedTurnCount: number;
  failedTurnCount: number;
  discardedTurnCount: number;
  correctionAttemptCount: number;
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
  private readonly technicalTurns = { audio: new Set<string>(), text_only: new Set<string>(), failed: new Set<string>(), discarded: new Set<string>() };
  private readonly restoredTurns = { audio: 0, text_only: 0, failed: 0, discarded: 0 };
  private correctionAttemptCount = 0;
  recordTechnicalOutcome(id: string, kind: keyof ConversationMetrics["technicalTurns"]): boolean {
    const set = this.technicalTurns[kind]; if (set.has(id)) return false; set.add(id); return true;
  }
  recordCorrectionAttempt(): void { this.correctionAttemptCount++; }
  private earlyOutputCount = 0;
  private completedTurnCount = 0;
  private sourceTailClippingReports = 0;
  private noOutputWatchdogCount = 0;
  private textOnlyCompletionCount = 0;
  private vamFalseActiveCount = 0;
  private wrongSideCorrectionCount = 0;
  private correctionSuccessCount = 0;
  private poorOutputRoute = false;
  private lastTurn: TurnMetrics | undefined;

  restoreCounters(counters: MetricCounters): void {
    this.earlyOutputCount = counters.earlyOutputCount ?? 0;
    this.completedTurnCount = counters.completedTurnCount ?? 0;
    this.sourceTailClippingReports = counters.sourceTailClippingReports ?? 0;
    this.noOutputWatchdogCount = counters.noOutputWatchdogCount ?? 0;
    this.textOnlyCompletionCount = counters.textOnlyCompletionCount ?? 0;
    this.poorOutputRoute = this.textOnlyCompletionCount > 0;
    this.vamFalseActiveCount = counters.vamFalseActiveCount ?? 0;
    this.wrongSideCorrectionCount = counters.wrongSideCorrectionCount ?? 0;
    this.correctionSuccessCount = counters.correctionSuccessCount ?? 0;
    this.correctionAttemptCount = counters.correctionAttemptCount ?? 0;
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

  recordWrongSideCorrection(): void {
    this.wrongSideCorrectionCount += 1;
  }

  recordCorrectionSuccess(): void {
    this.correctionSuccessCount += 1;
  }

  snapshot(): ConversationMetricsSnapshot {
    return {
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
      wrongSideCorrectionCount: this.wrongSideCorrectionCount,
      correctionSuccessCount: this.correctionSuccessCount,
      audioCompletedTurnCount: this.restoredTurns.audio + this.technicalTurns.audio.size,
      textOnlyCompletedTurnCount: this.restoredTurns.text_only + this.technicalTurns.text_only.size,
      failedTurnCount: this.restoredTurns.failed + this.technicalTurns.failed.size,
      discardedTurnCount: this.restoredTurns.discarded + this.technicalTurns.discarded.size,
      correctionAttemptCount: this.correctionAttemptCount,
      poorOutputRoute: this.poorOutputRoute,
      lastTurn: this.lastTurn === undefined ? undefined : { ...this.lastTurn },
    };
  }
}
