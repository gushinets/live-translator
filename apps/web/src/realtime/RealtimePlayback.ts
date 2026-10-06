import workletUrl from "./RealtimePlaybackProcessor.ts?worker&url";
export interface RealtimeAudioOutput {
  onStarted:((id:string)=>void)|null;
  onDrained:((id:string)=>void)|null;
  onFailure:((category:string)=>void)|null;
  readonly pendingSamples:number;
  prime():Promise<void>;
  attach(stream:MediaStream):Promise<void>;
  begin(id:string):void;
  hold(value:boolean):void;
  seal():void;
  dispose():void;
}
export class RealtimePlayback implements RealtimeAudioOutput {
  onStarted:((id:string)=>void)|null=null;
  onDrained:((id:string)=>void)|null=null;
  onFailure:((category:string)=>void)|null=null;
  pendingSamples=0;
  private context:AudioContext|null=null;
  private node:AudioWorkletNode|null=null;
  private source:MediaStreamAudioSourceNode|null=null;
  private decoder:HTMLAudioElement|null=null;
  private stream:MediaStream|null=null;
  private preparation:Promise<void>|undefined;
  private disposed=false;
  private held=false;
  async prime() {
    if (this.disposed) throw new Error("playback_retired");
    const context=this.context??=new AudioContext();
    context.onstatechange=()=> {if (!this.disposed && context.state!=="running") this.onFailure?.("audio_context_interrupted");};
    // Resume starts in the Start gesture, before any network or microphone await.
    this.preparation??=(async()=> {
      await context.resume();
      await context.audioWorklet.addModule(workletUrl);
      if (this.disposed) return;
      const node=new AudioWorkletNode(context,"realtime-playback",{numberOfInputs:1,numberOfOutputs:1,
        outputChannelCount:[1],channelCount:1,channelCountMode:"explicit"});
      this.node=node;node.connect(context.destination);
      node.onprocessorerror=()=>this.onFailure?.("pcm_processor_failed");
      node.port.onmessage=({data}:MessageEvent<{type:string;responseId?:string;value?:number}>)=> {
        if (this.disposed) return;
        if (data.type==="started" && data.responseId) this.onStarted?.(data.responseId);
        if (data.type==="drained" && data.responseId) this.onDrained?.(data.responseId);
        if (data.type==="size") this.pendingSamples=data.value??0;
        if (data.type==="error") this.onFailure?.("pcm_limit");
      };
      this.hold(this.held);
    })();
    await this.preparation;
  }
  async attach(stream:MediaStream) {
    if(this.disposed || this.stream) {
      for(const track of stream.getTracks())track.stop();
      throw new Error(this.disposed?"playback_retired":"remote_stream_replaced");
    }
    // Own the remote tracks before preparation can yield or fail.
    this.stream=stream;
    await this.prime(); if (this.disposed || !this.context || !this.node) throw new Error("playback_retired");
    this.source=this.context.createMediaStreamSource(stream);this.source.connect(this.node);
    const decoder=document.createElement("audio");this.decoder=decoder;
    decoder.muted=decoder.defaultMuted=true;decoder.volume=0;decoder.autoplay=true;decoder.srcObject=stream;
    decoder.onerror=()=>this.onFailure?.("remote_decoder_failed");
    for (const track of stream.getAudioTracks()) track.onended=()=>this.onFailure?.("remote_track_ended");
    await decoder.play();
    if (this.disposed) throw new Error("playback_retired");
  }
  begin(id:string) {if (!this.node || this.disposed) throw new Error("playback_unavailable");this.node.port.postMessage({type:"begin",responseId:id});}
  hold(value:boolean) {this.held=value;this.node?.port.postMessage({type:"hold",value});}
  seal() {this.node?.port.postMessage({type:"seal"});}
  dispose() {
    if (this.disposed) return;this.disposed=true;
    this.onStarted=this.onDrained=this.onFailure=null;
    if (this.decoder) {this.decoder.onerror=null;this.decoder.pause();this.decoder.srcObject=null;this.decoder=null;}
    this.source?.disconnect();this.source=null;
    if (this.stream) for (const track of this.stream.getTracks()) {track.onended=null;track.stop();}
    this.stream=null;
    if (this.node) {this.node.port.onmessage=null;this.node.onprocessorerror=null;this.node.port.postMessage({type:"dispose"});this.node.port.close();this.node.disconnect();this.node=null;}
    if (this.context) {this.context.onstatechange=null;void this.context.close();this.context=null;}
    this.pendingSamples=0;
  }
}
