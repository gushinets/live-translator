export interface ActivityState { visible: boolean; state: string; interpreterReady: boolean; mediaReady: boolean; }
/** Monotonic per-provider wall intervals, independent of the UI's inputReady flag. */
export class ActiveTimeMetrics {
  private at: number;
  private end: number | undefined;
  private state: ActivityState = { visible: false, state: "connecting", interpreterReady: false, mediaReady: false };
  private setup = 0;
  private active = 0;
  private paused = 0;
  constructor(private readonly start: number) { this.at = start; }
  private advance(at: number): void {
    if (this.end !== undefined || !Number.isFinite(at) || at < this.at) return;
    const duration = at - this.at;
    if (this.state.visible) {
      if (!this.state.interpreterReady && ["connecting", "bootstrap", "context", "detecting"].includes(this.state.state)) this.setup += duration;
      else if (this.state.interpreterReady && this.state.mediaReady && ["listening", "outputting"].includes(this.state.state)) this.active += duration;
      else this.paused += duration;
    }
    this.at = at;
  }
  update(state: ActivityState, at: number): void { this.advance(at); if (this.end === undefined) this.state = { ...state }; }
  finish(at: number): void { if (this.end === undefined) { this.advance(at); this.end = this.at; } }
  snapshot(at: number) {
    this.advance(at);
    return { observedWallMs: Math.floor(this.at - this.start), setupMs: Math.floor(this.setup), activeInterpreterMs: Math.floor(this.active), visiblePausedMs: Math.floor(this.paused) };
  }
}
