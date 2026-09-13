import { runtime } from "../config/runtime";
import type { Turn } from "./Turn";

export type CompletionDecision =
  | { kind: "continue"; retryAtMs?: number }
  | { kind: "complete" }
  | { kind: "fail-retry" };

/**
 * Inputs for the §10.1 branched completion predicate. Idle flags are
 * derived by the controller from VAM/playback/caption activity; this
 * function does not treat missing transcript deltas as silence.
 */
export interface TurnCompletionSnapshot {
  sourceIdle: boolean;
  audioStarted: boolean;
  playbackIdle: boolean;
  captionIdle: boolean;
  hasOutputText: boolean;
  sourceIdleAtMs?: number;
  playbackIdleAtMs?: number;
  lastOutputActivityAtMs?: number;
}

function requireSourceIdleAtMs(snapshot: TurnCompletionSnapshot): number {
  if (snapshot.sourceIdleAtMs === undefined) {
    throw new Error("sourceIdleAtMs is required when sourceIdle is true");
  }
  return snapshot.sourceIdleAtMs;
}

function requireLastOutputActivityAtMs(snapshot: TurnCompletionSnapshot): number {
  if (snapshot.lastOutputActivityAtMs === undefined) {
    throw new Error("lastOutputActivityAtMs is required to apply output settle grace");
  }
  return snapshot.lastOutputActivityAtMs;
}

function continueAt(retryAtMs: number, nowMs: number): CompletionDecision {
  if (nowMs >= retryAtMs) {
    return { kind: "complete" };
  }
  return { kind: "continue", retryAtMs };
}

function evaluateAudioStartedBranch(
  snapshot: TurnCompletionSnapshot,
  sourceIdleAtMs: number,
  nowMs: number,
): CompletionDecision {
  if (!snapshot.playbackIdle) {
    return { kind: "continue" };
  }
  if (snapshot.playbackIdleAtMs === undefined) {
    throw new Error("playbackIdleAtMs is required when audio started and playback is idle");
  }
  const settleAtMs =
    requireLastOutputActivityAtMs(snapshot) + runtime.outputSettleGraceMs;
  let closeAtMs = settleAtMs;
  if (snapshot.playbackIdleAtMs < sourceIdleAtMs) {
    closeAtMs = Math.max(
      closeAtMs,
      sourceIdleAtMs + runtime.postSourceOutputGraceMs,
    );
  }
  return continueAt(closeAtMs, nowMs);
}

function evaluateTextOnlyBranch(
  snapshot: TurnCompletionSnapshot,
  sourceIdleAtMs: number,
  nowMs: number,
): CompletionDecision {
  if (!snapshot.captionIdle) {
    return { kind: "continue" };
  }
  const closeAtMs = Math.max(
    sourceIdleAtMs + runtime.audioStartGraceMs,
    requireLastOutputActivityAtMs(snapshot) + runtime.outputSettleGraceMs,
  );
  return continueAt(closeAtMs, nowMs);
}

/**
 * Pure §10.1 turn-completion predicate. Model output ending is never
 * sufficient while the source remains active.
 */
export function evaluateTurnCompletion(
  snapshot: TurnCompletionSnapshot,
  nowMs: number,
): CompletionDecision {
  if (!snapshot.sourceIdle) {
    return { kind: "continue" };
  }
  const sourceIdleAtMs = requireSourceIdleAtMs(snapshot);
  if (snapshot.audioStarted) {
    return evaluateAudioStartedBranch(snapshot, sourceIdleAtMs, nowMs);
  }
  if (snapshot.hasOutputText) {
    return evaluateTextOnlyBranch(snapshot, sourceIdleAtMs, nowMs);
  }
  const failAtMs = sourceIdleAtMs + runtime.noOutputTimeoutMs;
  if (nowMs >= failAtMs) {
    return { kind: "fail-retry" };
  }
  return { kind: "continue", retryAtMs: failAtMs };
}

function lastOutputActivityAtMs(turn: Turn): number | undefined {
  const candidates = [
    turn.outputTextEndAtMs,
    turn.playbackEndAtMs,
    turn.firstAudibleOutputAtMs,
  ].filter((value): value is number => value !== undefined);
  if (candidates.length === 0) {
    return undefined;
  }
  return Math.max(...candidates);
}

/**
 * Derives a completion snapshot from the active turn plus live playback
 * activity. Caption idle uses CAPTION_IDLE_MS after the last output
 * transcript; missing input transcripts are ignored.
 */
export function buildTurnCompletionSnapshot(input: {
  turn: Turn;
  playbackActive: boolean;
  nowMs: number;
}): TurnCompletionSnapshot {
  const { turn, playbackActive, nowMs } = input;
  const lastOutput = lastOutputActivityAtMs(turn);
  const hasOutputText = (turn.translatedText ?? "").length > 0;
  const captionIdle =
    turn.outputTextEndAtMs === undefined ||
    nowMs - turn.outputTextEndAtMs >= runtime.captionIdleMs;
  return {
    sourceIdle: turn.sourceIdleAtMs !== undefined,
    sourceIdleAtMs: turn.sourceIdleAtMs,
    audioStarted: turn.audioOutputStarted,
    playbackIdle: !playbackActive,
    playbackIdleAtMs: turn.playbackEndAtMs,
    captionIdle,
    hasOutputText,
    lastOutputActivityAtMs: lastOutput,
  };
}
