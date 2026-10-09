/** Unfiltered PCM FIFO. Hold changes only the read cursor, discard is explicit. */
export class RealtimePcmQueue {
  private readonly samples:Float32Array;
  private read=0;
  private size=0;
  held=false;
  capturing=false;
  constructor(capacity:number) { this.samples=new Float32Array(capacity); }
  get pendingSamples() { return this.size; }
  begin() { if (this.size || this.capturing) throw new Error("playback_not_drained"); this.capturing=true; }
  seal() { this.capturing=false; }
  discard() { this.read=this.size=0; this.capturing=false; }
  process(input:Float32Array|undefined,output:Float32Array) {
    output.fill(0);
    for (let i=0;i<output.length;i++) {
      // Dequeue first to make room when the FIFO is full and resumed.
      const hadPending=this.size>0;
      if (!this.held && hadPending) {
        output[i]=this.samples[this.read]!; this.read=(this.read+1)%this.samples.length; this.size--;
      }
      if (this.capturing && input && i<input.length) {
        if (!this.held && !hadPending) output[i]=input[i]!;
        else {
          if (this.size===this.samples.length) throw new Error("pcm_limit");
          this.samples[(this.read+this.size)%this.samples.length]=input[i]!; this.size++;
        }
      }
    }
  }
}
