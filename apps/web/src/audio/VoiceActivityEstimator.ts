/**
 * Adaptive source-energy estimator for VoiceActivityMonitor
 * (binding spec 1.2.1 §9.1). Spike-tunable configuration, not final
 * product constants.
 */
export const VAM_SAMPLE_INTERVAL_MS = 50;
export const VAM_NOISE_FLOOR_EMA_ALPHA = 0.05;
export const VAM_ACTIVE_FLOOR = 0.015;
export const VAM_ACTIVE_NOISE_MULTIPLIER = 2.8;
export const VAM_QUIET_FLOOR = 0.01;
export const VAM_QUIET_NOISE_MULTIPLIER = 1.6;
export const VAM_ENTER_CONSECUTIVE_FRAMES = 2;
export const VAM_EXIT_QUIET_MS = 450;
export const VAM_PLAYBACK_THRESHOLD_MULTIPLIER = 1.35;
/** Analyser warmup / all-zero frames must not seed the noise floor. */
export const VAM_WARMUP_RMS_MAX = 0.0001;

export class VoiceActivityEstimator {
  private isActive = false;
  private noiseFloor: number | null = null;
  private consecutiveEnterFrames = 0;
  private quietStartedAtMs: number | null = null;

  get active(): boolean {
    return this.isActive;
  }

  resetBaseline(): void {
    this.isActive = false;
    this.noiseFloor = null;
    this.consecutiveEnterFrames = 0;
    this.quietStartedAtMs = null;
  }

  pushRms(rms: number, playbackActive: boolean, atMs: number): void {
    if (!Number.isFinite(rms) || rms < 0) {
      throw new Error(`RMS must be a finite non-negative number, received ${String(rms)}`);
    }

    const isRepresentative = rms > VAM_WARMUP_RMS_MAX;

    if (this.noiseFloor === null) {
      if (playbackActive || !isRepresentative) {
        return;
      }
      // The first representative frame after reset can already be speech.
      // Treat it as a provisional quiet baseline, not as authoritative
      // ambient noise, otherwise a speech frame can raise the adaptive
      // enter threshold above the rest of the same utterance and VAD will
      // never enter active. Inactive EMA learning is still free to raise
      // this baseline toward genuinely steady ambient noise on later frames.
      this.noiseFloor = Math.min(rms, VAM_QUIET_FLOOR);
      return;
    }

    const activeThreshold = Math.max(
      VAM_ACTIVE_FLOOR,
      this.noiseFloor * VAM_ACTIVE_NOISE_MULTIPLIER,
    );
    const quietThreshold = Math.max(
      VAM_QUIET_FLOOR,
      this.noiseFloor * VAM_QUIET_NOISE_MULTIPLIER,
    );
    const enterThreshold = playbackActive
      ? activeThreshold * VAM_PLAYBACK_THRESHOLD_MULTIPLIER
      : activeThreshold;

    if (this.isActive) {
      if (rms < quietThreshold) {
        if (this.quietStartedAtMs === null) {
          this.quietStartedAtMs = atMs;
        }
        if (atMs - this.quietStartedAtMs >= VAM_EXIT_QUIET_MS) {
          this.isActive = false;
          this.consecutiveEnterFrames = 0;
          this.quietStartedAtMs = null;
        }
      } else {
        this.quietStartedAtMs = null;
      }
    } else if (isRepresentative && rms >= enterThreshold) {
      this.consecutiveEnterFrames += 1;
      if (this.consecutiveEnterFrames >= VAM_ENTER_CONSECUTIVE_FRAMES) {
        this.isActive = true;
        this.quietStartedAtMs = null;
      }
    } else {
      this.consecutiveEnterFrames = 0;
    }

    // Once a frame has started a speech candidate, keep the baseline fixed
    // until that candidate is either confirmed by the next frame or rejected
    // by a below-threshold frame. Otherwise the first candidate itself raises
    // the adaptive threshold and can prevent an equally loud second frame
    // from ever confirming speech.
    if (
      !this.isActive &&
      !playbackActive &&
      isRepresentative &&
      this.consecutiveEnterFrames === 0
    ) {
      this.noiseFloor =
        (1 - VAM_NOISE_FLOOR_EMA_ALPHA) * this.noiseFloor +
        VAM_NOISE_FLOOR_EMA_ALPHA * rms;
    }
  }
}
