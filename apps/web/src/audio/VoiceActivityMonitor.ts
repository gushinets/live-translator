import { runtime } from "../config/runtime";
import { VoiceActivityEstimator } from "./VoiceActivityEstimator";

export interface AudioActivityEvent {
  active: boolean;
  atMs: number;
}

/**
 * Emits source-energy transitions from the adaptive estimator. Does not
 * decide language, speaker identity, or turn completion
 * (binding spec 1.2.1 §9.1).
 *
 * A local quiet decision is held for `sourceTailGraceMs` before the external
 * idle edge is emitted. This keeps Gate B open long enough for the final
 * source-audio tail to reach the Live session instead of racing input mute.
 */
export class VoiceActivityMonitor {
  onSample: ((event: AudioActivityEvent) => void) | null = null;
  onActivity: ((event: AudioActivityEvent) => void) | null = null;

  private reportedActive = false;
  private tailStartedAtMs: number | null = null;

  constructor(private readonly estimator = new VoiceActivityEstimator()) {}

  get active(): boolean {
    return this.reportedActive;
  }

  resetBaseline(): void {
    this.estimator.resetBaseline();
    this.reportedActive = false;
    this.tailStartedAtMs = null;
  }

  pushRms(rms: number, playbackActive: boolean, atMs: number): void {
    try { this.pushProductRms(rms, playbackActive, atMs); }
    finally {
      try { this.onSample?.({ active: this.estimator.active, atMs }); }
      catch { console.error("Source sample metadata observer failed"); }
    }
  }
  private pushProductRms(rms: number, playbackActive: boolean, atMs: number): void {
    this.estimator.pushRms(rms, playbackActive, atMs);

    if (this.estimator.active) {
      this.tailStartedAtMs = null;
      if (!this.reportedActive) {
        this.reportedActive = true;
        this.onActivity?.({ active: true, atMs });
      }
      return;
    }

    if (!this.reportedActive) {
      this.tailStartedAtMs = null;
      return;
    }

    if (this.tailStartedAtMs === null) {
      this.tailStartedAtMs = atMs;
      return;
    }

    if (atMs - this.tailStartedAtMs < runtime.sourceTailGraceMs) {
      return;
    }

    this.reportedActive = false;
    this.tailStartedAtMs = null;
    this.onActivity?.({ active: false, atMs });
  }
}
