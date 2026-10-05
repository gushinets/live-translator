import { PlaybackQueue } from "./PlaybackQueue";

declare const sampleRate: number;
declare abstract class AudioWorkletProcessor {
  readonly port: MessagePort;
}
declare function registerProcessor(name: string, processor: typeof AudioWorkletProcessor): void;

class BufferedPlaybackProcessor extends AudioWorkletProcessor {
  private readonly queue = new PlaybackQueue(sampleRate);
  private pending = false;
  private failed = false;
  private disposed = false;
  constructor() {
    super();
    this.port.onmessage = ({ data }: MessageEvent<{ type: string; value: boolean }>) => {
      if (data.type === "dispose") {
        this.disposed = true;
        this.queue.clear();
        this.port.onmessage = null;
        this.port.close();
        return;
      }
      if (data.type === "enabled") this.queue.setEnabled(data.value);
      if (data.type === "speaking") this.queue.setSpeaking(data.value);
      if (data.type === "audible") this.queue.setAudible(data.value);
      if (data.type === "clear") this.queue.clear();
      this.reportPending();
    };
  }
  private reportPending(): void {
    if (this.pending === this.queue.pending) return;
    this.pending = this.queue.pending;
    this.port.postMessage({ type: "pending", value: this.pending });
  }
  process(inputs: Float32Array[][], outputs: Float32Array[][]): boolean {
    const output = outputs[0]?.[0];
    if (this.disposed) { output?.fill(0); return false; }
    if (!output) return true;
    const input = inputs[0]?.[0];
    if (!input || this.failed) { output.fill(0); return true; }
    try { this.queue.process(input, output); }
    catch {
      output.fill(0);
      this.failed = true;
      this.port.postMessage({ type: "error" });
    }
    this.reportPending();
    return true;
  }
}
registerProcessor("buffered-playback", BufferedPlaybackProcessor);
