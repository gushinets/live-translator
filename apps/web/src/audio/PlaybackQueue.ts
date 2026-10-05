import { runtime } from "../config/runtime";
import { VAM_ACTIVE_FLOOR } from "./VoiceActivityEstimator";

// -60 dBFS peak gate; the existing 60 ms preroll / 250 ms tail retain quieter phonemes.
// ponytail: a fixed decoder-noise floor; calibrate from recorded PCM if receivers exceed it.
const CAPTURE_NOISE_FLOOR = .001;

/** PCM stays in memory for this media generation only. No transcript-based timing. */
export class PlaybackQueue {
  onPlaybackTurn: ((turnId: string | undefined, active: boolean) => void) | null = null;
  private readonly owners: Array<{ turnId: string | undefined; count: number; span: number }> = [];
  private readonly captionTurns = new Set<string>();
  private inputTurnId: string | undefined;
  private inputSpan = 0;
  private lastIncomingSpan: number | undefined;
  private incomingQuiet = 0;
  private playedTurnId: string | undefined;
  private playing = false;
  private playedQuiet = 0;
  private readonly samples: Float32Array;
  private readonly preroll: Float32Array;
  private readonly tailSamples: number;
  private read = 0;
  private count = 0;
  private prerollWrite = 0;
  private prerollCount = 0;
  private tail = 0;
  private quiet = 0;
  private audible = false;
  private enabled = false;
  private speaking = false;
  private failed = false;

  constructor(private readonly sampleRate: number, capacity = sampleRate * 120) {
    this.samples = new Float32Array(capacity);
    this.preroll = new Float32Array(Math.ceil(sampleRate * .06));
    this.tailSamples = Math.ceil(sampleRate * .25);
  }

  get pending(): boolean { return this.count > 0; }
  setTurn(turnId: string | undefined): void {
    if (turnId !== undefined) {
      // Caption continuations and historical corrections never claim another PCM span.
      if (this.captionTurns.has(turnId)) return;
      this.captionTurns.add(turnId);
    }
    // Only the initial span can be recovered from a delayed first caption. After a
    // pause, PCM may be this turn continuing OR the next turn arriving early.
    // ponytail: keep that ambiguity unknown until provider audio boundaries exist.
    const pending = turnId !== undefined && this.captionTurns.size === 1
      ? this.owners.find(owner => owner.span === 0 && owner.turnId === undefined) : undefined;
    if (pending) {
      // Never relabel a post-pause span using a later caption.
      for (const owner of this.owners) if (owner.span === pending.span) owner.turnId = turnId;
      if (pending.span === this.inputSpan) this.inputTurnId = turnId;
      return;
    }
    if (this.inputTurnId !== turnId) {
      this.inputSpan++;
      this.inputTurnId = turnId;
    }
  }
  setEnabled(enabled: boolean): void { this.enabled = enabled; }
  setSpeaking(speaking: boolean): void {
    this.speaking = speaking;
    if (speaking) this.quiet = 0;
  }
  setAudible(audible: boolean): void {
    this.audible = audible;
    if (!audible) this.clear();
  }
  clear(): void {
    this.read = this.count = this.prerollWrite = this.prerollCount = this.tail = this.quiet = 0;
    this.owners.length = 0;
    this.captionTurns.clear();
    this.inputTurnId = this.playedTurnId = undefined;
    this.playing = false;
    this.playedQuiet = this.incomingQuiet = this.inputSpan = 0;
    this.lastIncomingSpan = undefined;
  }

  process(input: Float32Array | undefined, output: Float32Array = new Float32Array(input?.length ?? 0)): Float32Array {
    output.fill(0);
    if (!this.audible || this.failed) return output;
    for (let i = 0; i < output.length; i++) {
      const value = input?.[i] ?? 0;
      const voiced = Math.abs(value) >= CAPTURE_NOISE_FLOOR;
      this.observeIncoming(voiced);
      const held = this.enabled && (this.speaking || this.quiet < this.sampleRate * .3);
      if (!this.speaking) this.quiet++;
      if (!this.enabled && this.count === 0) {
        // Default streaming path: no noise gate or added delay.
        output[i] = value;
        this.observePlayed(value, this.inputTurnId);
        this.prerollCount = this.tail = 0;
        continue;
      }
      // Free the outgoing slot before receiving another sample, including a synthetic silent tail.
      let dequeued = false;
      if (!held && this.count > 0) {
        output[i] = this.shift();
        dequeued = true;
      }
      // Keep quiet phonemes around speech, but don't queue minutes of dead air.
      if (voiced) {
        for (let n = this.prerollCount; n > 0; n--)
          this.push(this.preroll[(this.prerollWrite - n + this.preroll.length) % this.preroll.length]!);
        this.prerollCount = 0;
        this.tail = this.tailSamples;
        this.push(value);
      } else if (this.tail > 0) {
        this.tail--;
        this.push(value);
      } else {
        this.preroll[this.prerollWrite] = value;
        this.prerollWrite = (this.prerollWrite + 1) % this.preroll.length;
        this.prerollCount = Math.min(this.prerollCount + 1, this.preroll.length);
      }
      if (!held && !dequeued && this.count > 0) {
        output[i] = this.shift();
        dequeued = true;
      }
      if (!dequeued) this.observePlayed(0, undefined);
    }
    return output;
  }

  private observeIncoming(voiced: boolean): void {
    if (voiced) {
      this.incomingQuiet = 0;
      this.lastIncomingSpan = this.inputSpan;
    } else if (this.lastIncomingSpan !== undefined &&
        ++this.incomingQuiet === this.tailSamples &&
        this.lastIncomingSpan === this.inputSpan) {
      // The captured tail ends here; played-idle timing must not join the next phrase to this owner.
      // ponytail: raw gaps shorter than the capture tail need provider turn IDs for exact ownership.
      this.inputSpan++;
      this.inputTurnId = undefined;
    }
  }

  private shift(): number {
    const value = this.samples[this.read]!;
    this.read = (this.read + 1) % this.samples.length;
    this.count--;
    const owner = this.owners[0]!;
    if (--owner.count === 0) this.owners.shift();
    this.observePlayed(value, owner.turnId);
    return value;
  }

  private observePlayed(value: number, turnId: string | undefined): void {
    if (Math.abs(value) >= VAM_ACTIVE_FLOOR) {
      this.playedQuiet = 0;
      if (!this.playing || this.playedTurnId !== turnId) {
        this.playing = true;
        this.playedTurnId = turnId;
        this.onPlaybackTurn?.(turnId, true);
      }
    } else if (this.playing && ++this.playedQuiet >= this.sampleRate * runtime.playbackIdleMs / 1000) {
      this.playing = false;
      this.onPlaybackTurn?.(this.playedTurnId, false);
    }
  }

  private push(value: number): void {
    if (this.count === this.samples.length) {
      this.clear();
      this.failed = true;
      throw new Error("Playback buffer full");
    }
    this.samples[(this.read + this.count) % this.samples.length] = value;
    this.count++;
    const owner = this.owners.at(-1);
    if (owner && owner.span === this.inputSpan) owner.count++;
    else this.owners.push({ turnId: this.inputTurnId, count: 1, span: this.inputSpan });
  }
}
