import { describe, expect, it } from "vitest";
import { calculateMetrics, ConversationMetrics } from "./ConversationMetrics";

describe("calculateMetrics", () => {
  it("clamps T1 at zero and records early output lead", () => {
    const result = calculateMetrics({
      sourceIdleAtMs: 2_000,
      firstOutputTextAtMs: 1_700,
    });
    expect(result.t1Ms).toBe(0);
    expect(result.earlyOutputLeadMs).toBe(300);
  });

  it("records T1 when first output text arrives after source idle", () => {
    const result = calculateMetrics({
      sourceIdleAtMs: 2_000,
      firstOutputTextAtMs: 2_400,
    });
    expect(result.t1Ms).toBe(400);
    expect(result.earlyOutputLeadMs).toBe(0);
  });

  it("records T2 from source idle to first audible output", () => {
    const result = calculateMetrics({
      sourceIdleAtMs: 2_000,
      firstOutputTextAtMs: 2_100,
      firstAudibleOutputAtMs: 2_450,
    });
    expect(result.t2Ms).toBe(450);
  });

  it("records T3 from playback end to listening for audio turns", () => {
    const result = calculateMetrics({
      sourceIdleAtMs: 2_000,
      firstOutputTextAtMs: 2_100,
      firstAudibleOutputAtMs: 2_200,
      audioOutputStarted: true,
      playbackEndAtMs: 3_000,
      listeningRestoredAtMs: 3_400,
    });
    expect(result.t3Ms).toBe(400);
  });

  it("records T3 from turn completed to listening for text-only turns", () => {
    const result = calculateMetrics({
      sourceIdleAtMs: 2_000,
      firstOutputTextAtMs: 2_100,
      audioOutputStarted: false,
      turnCompletedAtMs: 3_200,
      listeningRestoredAtMs: 3_550,
    });
    expect(result.t3Ms).toBe(350);
  });
});

describe("ConversationMetrics", () => {
  it("records early-output rate without transcript text", () => {
    const metrics = new ConversationMetrics();
    metrics.recordTurn({
      sourceIdleAtMs: 2_000,
      firstOutputTextAtMs: 1_700,
    });
    metrics.recordTurn({
      sourceIdleAtMs: 5_000,
      firstOutputTextAtMs: 5_400,
    });

    const snapshot = metrics.snapshot();
    expect(snapshot.earlyOutputCount).toBe(1);
    expect(snapshot.completedTurnCount).toBe(2);
    expect(snapshot.earlyOutputRate).toBe(0.5);
    expect(snapshot.lastTurn?.t1Ms).toBe(400);
    expect(JSON.stringify(snapshot)).not.toMatch(/Hola|Hello/);
  });

  it("records source-tail clipping reports from the test harness", () => {
    const metrics = new ConversationMetrics();
    metrics.reportSourceTailClipping();
    metrics.reportSourceTailClipping();
    expect(metrics.snapshot().sourceTailClippingReports).toBe(2);
  });

  it("records no-output watchdog, text-only completion, and poor-output-route", () => {
    const metrics = new ConversationMetrics();
    metrics.recordNoOutputWatchdog();
    metrics.recordTurn({
      sourceIdleAtMs: 1_000,
      firstOutputTextAtMs: 1_200,
      audioOutputStarted: false,
      turnCompletedAtMs: 2_000,
      listeningRestoredAtMs: 2_100,
    });

    const snapshot = metrics.snapshot();
    expect(snapshot.noOutputWatchdogCount).toBe(1);
    expect(snapshot.textOnlyCompletionCount).toBe(1);
    expect(snapshot.poorOutputRoute).toBe(true);
  });

  it("records VAM false-active and correction counters", () => {
    const metrics = new ConversationMetrics();
    metrics.recordVamFalseActive();
    metrics.recordWrongSideCorrection();
    metrics.recordCorrectionSuccess();

    const snapshot = metrics.snapshot();
    expect(snapshot.vamFalseActiveCount).toBe(1);
    expect(snapshot.wrongSideCorrectionCount).toBe(1);
    expect(snapshot.correctionSuccessCount).toBe(1);
  });
});

it("keeps technical outcomes distinct and deduplicates correction of one logical turn", () => {
  const metrics = new ConversationMetrics();
  metrics.recordTechnicalOutcome("one", "audio"); metrics.recordTechnicalOutcome("one", "audio");
  metrics.recordTechnicalOutcome("two", "text_only"); metrics.recordTechnicalOutcome("three", "failed");
  metrics.recordTechnicalOutcome("four", "discarded"); metrics.recordCorrectionAttempt();
  expect(metrics.snapshot()).toMatchObject({ audioCompletedTurnCount: 1, textOnlyCompletedTurnCount: 1, failedTurnCount: 1, discardedTurnCount: 1, correctionAttemptCount: 1 });
});
