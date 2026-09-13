import { describe, expect, it } from "vitest";
import { VoiceActivityEstimator } from "./VoiceActivityEstimator";

function pushQuiet(
  estimator: VoiceActivityEstimator,
  rms: number,
  frames: number,
): void {
  for (let i = 0; i < frames; i++) {
    estimator.pushRms(rms, false, i * 50);
  }
}

describe("VoiceActivityEstimator", () => {
  it("does not mark steady ambient noise as speech forever", () => {
    const estimator = new VoiceActivityEstimator();
    for (let i = 0; i < 200; i++) estimator.pushRms(0.02, false, i * 50);
    expect(estimator.active).toBe(false);
  });

  it("does not latch active after a zero warmup frame then steady ambient", () => {
    const estimator = new VoiceActivityEstimator();
    estimator.pushRms(0, false, 0);
    for (let i = 1; i <= 200; i++) estimator.pushRms(0.02, false, i * 50);
    expect(estimator.active).toBe(false);
  });

  it("does not latch active after a near-zero warmup frame then steady ambient", () => {
    const estimator = new VoiceActivityEstimator();
    estimator.pushRms(0.0001, false, 0);
    for (let i = 1; i <= 200; i++) estimator.pushRms(0.02, false, i * 50);
    expect(estimator.active).toBe(false);
  });

  it("raises speech state above adaptive floor", () => {
    const estimator = new VoiceActivityEstimator();
    for (let i = 0; i < 100; i++) estimator.pushRms(0.01, false, i * 50);
    estimator.pushRms(0.08, false, 5_100);
    estimator.pushRms(0.09, false, 5_150);
    expect(estimator.active).toBe(true);
  });

  it("does not enter active on a single frame above threshold", () => {
    const estimator = new VoiceActivityEstimator();
    pushQuiet(estimator, 0.01, 100);
    estimator.pushRms(0.09, false, 5_100);
    expect(estimator.active).toBe(false);
  });

  it("stays active until 450ms below the quiet threshold", () => {
    const estimator = new VoiceActivityEstimator();
    pushQuiet(estimator, 0.01, 100);
    estimator.pushRms(0.08, false, 5_100);
    estimator.pushRms(0.09, false, 5_150);
    expect(estimator.active).toBe(true);

    estimator.pushRms(0.001, false, 5_200);
    estimator.pushRms(0.001, false, 5_600);
    expect(estimator.active).toBe(true);

    estimator.pushRms(0.001, false, 5_650);
    expect(estimator.active).toBe(false);
  });

  it("freezes noise-floor learning while local playback is active", () => {
    const estimator = new VoiceActivityEstimator();
    pushQuiet(estimator, 0.01, 100);

    for (let i = 0; i < 200; i++) {
      estimator.pushRms(0.02, true, 5_000 + i * 50);
    }
    expect(estimator.active).toBe(false);

    estimator.pushRms(0.04, false, 15_100);
    estimator.pushRms(0.04, false, 15_150);
    expect(estimator.active).toBe(true);
  });

  it("raises the enter threshold while local playback is active", () => {
    const estimator = new VoiceActivityEstimator();
    pushQuiet(estimator, 0.01, 100);

    estimator.pushRms(0.032, true, 5_100);
    estimator.pushRms(0.032, true, 5_150);
    expect(estimator.active).toBe(false);

    estimator.pushRms(0.06, true, 5_200);
    estimator.pushRms(0.06, true, 5_250);
    expect(estimator.active).toBe(true);
  });

  it("resetBaseline clears active speech so a resume can re-learn the noise floor", () => {
    const estimator = new VoiceActivityEstimator();
    pushQuiet(estimator, 0.01, 100);
    estimator.pushRms(0.08, false, 5_100);
    estimator.pushRms(0.09, false, 5_150);
    expect(estimator.active).toBe(true);

    estimator.resetBaseline();
    expect(estimator.active).toBe(false);

    for (let i = 0; i < 200; i++) estimator.pushRms(0.02, false, 6_000 + i * 50);
    expect(estimator.active).toBe(false);
  });
});
