import { RealtimePcmQueue } from "./RealtimePcmQueue";
declare const sampleRate:number;
declare abstract class AudioWorkletProcessor { readonly port:MessagePort; }
declare function registerProcessor(name:string,processor:typeof AudioWorkletProcessor):void;
class RealtimePlaybackProcessor extends AudioWorkletProcessor {
  private readonly queue=new RealtimePcmQueue(sampleRate*120);
  private responseId:string|undefined;
  private drained=true;
  private started=false;
  private failed=false;
  private disposed=false;
  private lastSize=-1;
  private frames=0;
  constructor() {
    super();
    this.port.onmessage=({data}:MessageEvent<{type:string;responseId?:string;value?:boolean}>)=> {
      try {
        if (data.type==="begin") { this.queue.begin(); this.responseId=data.responseId; this.drained=false; this.started=false; }
        if (data.type==="hold") this.queue.held=data.value===true;
        if (data.type==="seal") this.queue.seal();
        if (data.type==="dispose") { this.queue.discard(); this.disposed=true; this.port.onmessage=null; this.port.close(); }
      } catch { this.fail(); }
    };
  }
  private fail() { this.failed=true; this.queue.discard(); this.port.postMessage({type:"error"}); }
  process(inputs:Float32Array[][],outputs:Float32Array[][]) {
    const output=outputs[0]?.[0]; if (!output) return !this.disposed;
    if (this.disposed || this.failed) {output.fill(0);return !this.disposed;}
    try {this.queue.process(inputs[0]?.[0],output);} catch {output.fill(0);this.fail();}
    if (!this.drained && !this.queue.held && !this.started && (this.queue.capturing || this.queue.pendingSamples)) {
      this.started=true;this.port.postMessage({type:"started",responseId:this.responseId});
    }
    if (!this.drained && !this.queue.capturing && !this.queue.pendingSamples) {
      this.drained=true;this.port.postMessage({type:"drained",responseId:this.responseId});
    }
    if (++this.frames%32===0 && this.lastSize!==this.queue.pendingSamples) {
      this.lastSize=this.queue.pendingSamples;this.port.postMessage({type:"size",value:this.lastSize});
    }
    return true;
  }
}
registerProcessor("realtime-playback",RealtimePlaybackProcessor);
