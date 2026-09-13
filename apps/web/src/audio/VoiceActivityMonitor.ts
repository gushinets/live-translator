import { VoiceActivityEstimator } from "./VoiceActivityEstimator";

export interface AudioActivityEvent {
  active: boolean;
  atMs: number;
}

/**
 * Emits source-energy transitions from the adaptive estimator. Does not
 * decide language, speaker identity, or turn completion
 * (binding spec 1.2.1 §9.1).
 */
export class VoiceActivityMonitor {
  onActivity: ((event: AudioActivityEvent) => void) | null = null;

  constructor(private readonly estimator = new VoiceActivityEstimator()) {}

  get active(): boolean {
    return this.estimator.active;
  }

  pushRms(rms: number, playbackActive: boolean, atMs: number): void {
    const wasActive = this.estimator.active;
    this.estimator.pushRms(rms, playbackActive, atMs);
    if (this.estimator.active !== wasActive) {
      this.onActivity?.({ active: this.estimator.active, atMs });
    }
  }
}
