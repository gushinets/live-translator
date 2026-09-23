import { VAM_SAMPLE_INTERVAL_MS } from "../audio/VoiceActivityEstimator";
export interface SpeechSample { active: boolean; atMs: number; }
/** Integrates estimator samples, not the delayed onActivity product edges. No audio/text is retained. */
export class SourceSpeechMetrics {
  private previous: (SpeechSample & { eligible: boolean; turnId?: string }) | undefined;
  private observed = false;
  private partial = false;
  private accepted = 0;
  private completed = 0;
  private readonly turns = new Map<string, number>();
  private readonly completedTurns = new Set<string>();
  private advance(at: number): void {
    const prev = this.previous;
    if (!prev || !prev.eligible) return;
    const delta = at - prev.atMs;
    if (!Number.isFinite(delta) || delta < 0 || delta > 2 * VAM_SAMPLE_INTERVAL_MS) { this.partial = true; return; }
    if (prev.active) {
      this.accepted += delta;
      if (prev.turnId) this.turns.set(prev.turnId, (this.turns.get(prev.turnId) ?? 0) + delta);
      else this.partial = true; // Speech observed but not attributable to a logical turn.
    }
  }
  sample(sample: SpeechSample, eligible: boolean, turnId?: string): void {
    if (this.previous && sample.atMs < this.previous.atMs) { this.partial = true; this.previous = undefined; return; }
    if (!Number.isFinite(sample.atMs)) { this.partial = true; this.previous = undefined; return; }
    this.advance(sample.atMs);
    if (eligible) this.observed = true;
    this.previous = { ...sample, eligible, turnId };
  }
  transition(eligible: boolean, atMs: number): void {
    if (!eligible) { this.advance(atMs); this.previous = undefined; }
  }
  reset(atMs: number): void { this.transition(false, atMs); }
  markPartial(): void { this.partial = true; }
  complete(turnId: string): void {
    if (this.completedTurns.has(turnId)) return;
    this.completedTurns.add(turnId); this.completed += this.turns.get(turnId) ?? 0;
  }
  snapshot() {
    return { acceptedSourceSpeechMs: this.observed ? Math.floor(this.accepted) : null,
      completedSourceSpeechMs: this.observed ? Math.floor(this.completed) : null,
      speechMeasurementStatus: !this.observed ? "unavailable" as const : this.partial ? "partial" as const : "complete" as const };
  }
}
