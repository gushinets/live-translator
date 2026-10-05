/** PCM stays in memory for this media generation only. No transcript-based timing. */
export class PlaybackQueue {
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
      }
    }
    return output;
  }

  private push(value: number): void {
    if (this.count === this.samples.length) {
      this.clear();
      this.failed = true;
      throw new Error("Playback buffer full");
    }
    this.samples[(this.read + this.count) % this.samples.length] = value;
    this.count++;
  }
}
