import { runtime } from "../config/runtime";
import { VAM_ACTIVE_FLOOR } from "./VoiceActivityEstimator";

/** PCM stays in memory for this media generation only. No transcript-based timing. */
export class PlaybackQueue {
  onPlaybackTurn: ((turnId: string | undefined, active: boolean) => void) | null = null;
  private readonly owners: Array<{ turnId: string | undefined; count: number }> = [];
  private inputTurnId: string | undefined;
  private playedTurnId: string | undefined;
  private playing = false;
  private playedQuiet = 0;
  private readonly samples: Float32Array;
  private readonly preroll: Float32Array;
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
  }

  get pending(): boolean { return this.count > 0; }
  setTurn(turnId: string | undefined): void {
    // A first caption may arrive after PCM. Claim only the still-unowned prefix.
    if (this.inputTurnId === undefined && turnId !== undefined) {
      for (const owner of this.owners) if (owner.turnId === undefined) owner.turnId = turnId;
    }
    this.inputTurnId = turnId;
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
    this.inputTurnId = this.playedTurnId = undefined;
    this.playing = false;
    this.playedQuiet = 0;
  }

  process(input: Float32Array | undefined, output: Float32Array = new Float32Array(input?.length ?? 0)): Float32Array {
    output.fill(0);
    if (!this.audible || this.failed) return output;
    for (let i = 0; i < output.length; i++) {
      const value = input?.[i] ?? 0;
      const held = this.enabled && (this.speaking || this.quiet < this.sampleRate * .3);
      if (!this.speaking) this.quiet++;
      if (!this.enabled && this.count === 0) {
        // Default streaming path: no noise gate or added delay.
        output[i] = value;
        this.observePlayed(value, this.inputTurnId);
        this.prerollCount = this.tail = 0;
        continue;
      }
      // Keep quiet phonemes around speech, but don't queue minutes of dead air.
      if (Math.abs(value) >= .0001) {
        for (let n = this.prerollCount; n > 0; n--)
          this.push(this.preroll[(this.prerollWrite - n + this.preroll.length) % this.preroll.length]!);
        this.prerollCount = 0;
        this.tail = Math.ceil(this.sampleRate * .25);
        this.push(value);
      } else if (this.tail > 0) {
        this.tail--;
        this.push(value);
      } else {
        this.preroll[this.prerollWrite] = value;
        this.prerollWrite = (this.prerollWrite + 1) % this.preroll.length;
        this.prerollCount = Math.min(this.prerollCount + 1, this.preroll.length);
      }
      if (!held && this.count > 0) {
        output[i] = this.samples[this.read]!;
        this.read = (this.read + 1) % this.samples.length;
        this.count--;
        const owner = this.owners[0]!;
        this.observePlayed(output[i]!, owner.turnId);
        if (--owner.count === 0) this.owners.shift();
      } else {
        this.observePlayed(0, undefined);
      }
    }
    return output;
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
    if (owner && owner.turnId === this.inputTurnId) owner.count++;
    else this.owners.push({ turnId: this.inputTurnId, count: 1 });
  }
}
