import { PlaybackQueue } from "./PlaybackQueue";
import { runtime } from "../config/runtime";

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
  private enabled = false;
  private audible = false;
  private requested = false;
  private permitted = false;
  private quietSamples = 0;
  private held = false;
  private holdEpoch = 0;
  private permissionToken = 0;
  constructor() {
    super();
    this.queue.onPlaybackTurn = (turnId, active) => this.port.postMessage({ type: "turn", turnId, value: active });
    this.port.onmessage = ({ data }: MessageEvent<{ type: string; value: boolean; turnId?: string; epoch?: number; token?: number }>) => {
      if (data.type === "dispose") {
        this.disposed = true;
        this.queue.clear();
        this.port.onmessage = null;
        this.port.close();
        return;
      }
      if (data.type === "turn") this.queue.setTurn(data.turnId);
      if (data.type === "enabled") {
        this.enabled = data.value;
        this.queue.setEnabled(data.value);
        this.resetPermission();
      }
      if (data.type === "speaking" && !this.permitted) this.queue.setSpeaking(data.value);
      if (data.type === "audible") {
        this.audible = data.value;
        this.queue.setAudible(data.value);
        if (!data.value) this.resetPermission();
      }
      if (data.type === "clear") { this.queue.clear(); this.resetPermission(); }
      if (data.type === "hold" && data.epoch !== undefined && data.epoch >= this.holdEpoch) {
        this.holdEpoch = data.epoch;
        this.held = data.value;
        this.resetPermission();
      }
      if (data.type === "playback" && this.requested && data.token === this.permissionToken && (data.epoch ?? 0) === this.holdEpoch) {
        this.permitted = data.value && this.enabled && this.audible && !this.held;
        if (this.permitted) this.queue.setSpeaking(false);
        else this.requested = false;
        this.queue.setPlaybackAllowed(!this.held && (this.permitted || !this.enabled));
      }
      this.reportPending();
    };
  }
  private resetPermission(): void {
    if (this.requested) this.port.postMessage({ type: "playback", value: false, token: this.permissionToken, epoch: this.holdEpoch });
    this.requested = this.permitted = false;
    this.quietSamples = 0;
    this.queue.setPlaybackAllowed(!this.held && !this.enabled);
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
    if (this.failed) { output.fill(0); return true; }
    // A muted receiver may supply no channels; queued PCM still advances through silence.
    try { this.queue.process(input, output); }
    catch {
      output.fill(0);
      this.failed = true;
      this.resetPermission();
      this.port.postMessage({ type: "error" });
    }
    this.reportPending();
    if (this.enabled && !this.held && !this.requested && this.queue.readyForPlayback) {
      this.requested = true;
      this.permissionToken++;
      // PCM remains held until the main thread has closed microphone capture.
      this.port.postMessage({ type: "playback", value: true, token: this.permissionToken, epoch: this.holdEpoch });
    }
    if (this.permitted) {
      this.quietSamples = this.queue.pending || output.some(value => value !== 0) ? 0 : this.quietSamples + output.length;
      // shortcut: infer output end from quiet; replace when the provider exposes an audio-end event.
      if (this.quietSamples >= sampleRate * runtime.postSourceOutputGraceMs / 1000) this.resetPermission();
    }
    return true;
  }
}
registerProcessor("buffered-playback", BufferedPlaybackProcessor);
