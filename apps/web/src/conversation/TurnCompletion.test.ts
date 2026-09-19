import { describe, expect, it } from "vitest";
import { runtime } from "../config/runtime";
import { createTurn } from "./TurnBuffer";
import {
  buildTurnCompletionSnapshot,
  evaluateTurnCompletion,
  type TurnCompletionSnapshot,
} from "./TurnCompletion";

function textOnlySnapshot(): TurnCompletionSnapshot {
  return {
    sourceIdle: true,
    sourceIdleAtMs: 3_000,
    audioStarted: false,
    playbackIdle: true,
    captionIdle: true,
    hasOutputText: true,
    lastOutputActivityAtMs: 3_200,
  };
}

function noOutputSnapshot(): TurnCompletionSnapshot {
  return {
    sourceIdle: true,
    sourceIdleAtMs: 2_000,
    audioStarted: false,
    playbackIdle: true,
    captionIdle: true,
    hasOutputText: false,
  };
}

function earlyPlaybackIdleSnapshot(): TurnCompletionSnapshot {
  return {
    sourceIdle: true,
    sourceIdleAtMs: 10_000,
    audioStarted: true,
    playbackIdle: true,
    playbackIdleAtMs: 8_000,
    captionIdle: true,
    hasOutputText: true,
    lastOutputActivityAtMs: 8_000,
  };
}

describe("evaluateTurnCompletion", () => {
  it("does not close while source remains active even if playback is idle", () => {
    expect(
      evaluateTurnCompletion(
        {
          sourceIdle: false,
          audioStarted: true,
          playbackIdle: true,
          captionIdle: true,
          hasOutputText: true,
        },
        10_000,
      ).kind,
    ).toBe("continue");
  });

  it("closes text-only after source idle and audio grace", () => {
    expect(evaluateTurnCompletion(textOnlySnapshot(), 5_000).kind).toBe("complete");
  });

  it("fails instead of hanging when no output arrives", () => {
    expect(evaluateTurnCompletion(noOutputSnapshot(), 8_000).kind).toBe("fail-retry");
  });

  it("waits POST_SOURCE_OUTPUT_GRACE_MS when playback went idle before source idle", () => {
    const justBefore =
      10_000 + runtime.postSourceOutputGraceMs - 1;
    const atGrace = 10_000 + runtime.postSourceOutputGraceMs;

    expect(evaluateTurnCompletion(earlyPlaybackIdleSnapshot(), justBefore).kind).toBe(
      "continue",
    );
    expect(evaluateTurnCompletion(earlyPlaybackIdleSnapshot(), atGrace).kind).toBe(
      "complete",
    );
  });

  it("does not wait post-source grace when playback idle happens after source idle", () => {
    const snapshot: TurnCompletionSnapshot = {
      sourceIdle: true,
      sourceIdleAtMs: 10_000,
      audioStarted: true,
      playbackIdle: true,
      playbackIdleAtMs: 10_100,
      captionIdle: true,
      hasOutputText: true,
      lastOutputActivityAtMs: 10_100,
    };
    const settleAt = 10_100 + runtime.outputSettleGraceMs;

    expect(evaluateTurnCompletion(snapshot, settleAt - 1).kind).toBe("continue");
    expect(evaluateTurnCompletion(snapshot, settleAt).kind).toBe("complete");
    expect(evaluateTurnCompletion(snapshot, 10_000 + runtime.postSourceOutputGraceMs - 1).kind).toBe(
      "complete",
    );
  });

  it("does not close audio-started turns while playback is still active", () => {
    expect(
      evaluateTurnCompletion(
        {
          sourceIdle: true,
          sourceIdleAtMs: 4_000,
          audioStarted: true,
          playbackIdle: false,
          captionIdle: true,
          hasOutputText: true,
          lastOutputActivityAtMs: 4_500,
        },
        20_000,
      ).kind,
    ).toBe("continue");
  });

  it("does not take the text-only path until AUDIO_START_GRACE_MS elapses", () => {
    const snapshot = textOnlySnapshot();
    const audioGraceAt = 3_000 + runtime.audioStartGraceMs;

    expect(evaluateTurnCompletion(snapshot, audioGraceAt - 1).kind).toBe("continue");
    expect(evaluateTurnCompletion(snapshot, audioGraceAt).kind).toBe("complete");
  });

  it("does not complete text-only while captions are still active", () => {
    expect(
      evaluateTurnCompletion(
        {
          ...textOnlySnapshot(),
          captionIdle: false,
        },
        5_000,
      ).kind,
    ).toBe("continue");
  });

  it("does not fail-retry when usable text exists", () => {
    expect(evaluateTurnCompletion(textOnlySnapshot(), 20_000).kind).toBe("complete");
  });

  it("does not fail-retry before NO_OUTPUT_TIMEOUT_MS", () => {
    const timeoutAt = 2_000 + runtime.noOutputTimeoutMs;
    expect(evaluateTurnCompletion(noOutputSnapshot(), timeoutAt - 1).kind).toBe("continue");
    expect(evaluateTurnCompletion(noOutputSnapshot(), timeoutAt).kind).toBe("fail-retry");
  });

  it("fails fast when source idle is claimed without sourceIdleAtMs", () => {
    expect(() =>
      evaluateTurnCompletion(
        {
          sourceIdle: true,
          audioStarted: false,
          playbackIdle: true,
          captionIdle: true,
          hasOutputText: false,
        },
        8_000,
      ),
    ).toThrow(/sourceIdleAtMs/);
  });
});

describe("buildTurnCompletionSnapshot", () => {
  it("derives caption idle from output-transcript inactivity, not missing input deltas", () => {
    const turn = {
      ...createTurn({ id: "t1", speaker: "A" as const, sideSource: "language" as const, nowMs: 1_000 }),
      sourceIdleAtMs: 2_000,
      translatedText: "Hola",
      firstOutputTextAtMs: 1_500,
      outputTextEndAtMs: 1_500,
    };

    const stillCaptioning = buildTurnCompletionSnapshot({
      turn,
      playbackActive: false,
      nowMs: 1_500 + runtime.captionIdleMs - 1,
    });
    expect(stillCaptioning.captionIdle).toBe(false);
    expect(stillCaptioning.sourceIdle).toBe(true);

    const captionIdle = buildTurnCompletionSnapshot({
      turn,
      playbackActive: false,
      nowMs: 1_500 + runtime.captionIdleMs,
    });
    expect(captionIdle.captionIdle).toBe(true);
  });
});
