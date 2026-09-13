import { runtime } from "../config/runtime";
import type { AudioActivityEvent } from "./VoiceActivityMonitor";
import { VAM_ACTIVE_FLOOR } from "./VoiceActivityEstimator";

/**
 * Observes remote-output energy and derives playbackActive / playbackIdle
 * using PLAYBACK_IDLE_MS (binding spec 1.2.1 §10.2). The RMS enter floor is
 * the same spike-tunable minimum as VAM, not a second invented threshold.
 */
export class PlaybackActivityDetector {
  onActivity: ((event: AudioActivityEvent) => void) | null = null;
  private isActive = false;
  private lastAboveThresholdAtMs: number | null = null;

  get active(): boolean {
    return this.isActive;
  }

  pushRms(rms: number, atMs: number): void {
    if (!Number.isFinite(rms) || rms < 0) {
      throw new Error(`RMS must be a finite non-negative number, received ${String(rms)}`);
    }

    const wasActive = this.isActive;
    if (rms >= VAM_ACTIVE_FLOOR) {
      this.lastAboveThresholdAtMs = atMs;
      this.isActive = true;
    } else if (
      this.lastAboveThresholdAtMs !== null &&
      atMs - this.lastAboveThresholdAtMs >= runtime.playbackIdleMs
    ) {
      this.isActive = false;
    }

    if (this.isActive !== wasActive) {
      this.onActivity?.({ active: this.isActive, atMs });
    }
  }
}
