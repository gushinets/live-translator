import { describe, expect, it, vi } from "vitest";
import { runtime } from "../config/runtime";
import { PlaybackActivityDetector } from "./PlaybackActivityDetector";

describe("PlaybackActivityDetector", () => {
  it("enters active when remote energy is above the floor", () => {
    const detector = new PlaybackActivityDetector();
    const onActivity = vi.fn();
    detector.onActivity = onActivity;

    detector.pushRms(0.08, 100);

    expect(detector.active).toBe(true);
    expect(onActivity).toHaveBeenCalledWith({ active: true, atMs: 100 });
  });

  it("stays active across a dip shorter than playbackIdleMs", () => {
    const detector = new PlaybackActivityDetector();
    detector.pushRms(0.08, 0);

    detector.pushRms(0, runtime.playbackIdleMs - 1);

    expect(detector.active).toBe(true);
  });

  it("emits idle after playbackIdleMs below the floor", () => {
    const detector = new PlaybackActivityDetector();
    const onActivity = vi.fn();
    detector.onActivity = onActivity;
    detector.pushRms(0.08, 0);

    detector.pushRms(0, runtime.playbackIdleMs);

    expect(detector.active).toBe(false);
    expect(onActivity).toHaveBeenCalledWith({
      active: false,
      atMs: runtime.playbackIdleMs,
    });
  });
});
