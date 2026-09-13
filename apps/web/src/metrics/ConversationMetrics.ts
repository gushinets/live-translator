/**
 * In-memory non-content conversation metrics (binding spec 1.2.1 §26).
 * Never records transcript text or sends analytics.
 */

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
      poorOutputRoute: this.poorOutputRoute,
      lastTurn: this.lastTurn === undefined ? undefined : { ...this.lastTurn },
    };
  }
}
