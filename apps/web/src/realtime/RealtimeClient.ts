import { waitForIceComplete } from "../live/waitForIceComplete";
import { acceptsConfiguration,parseRealtimeEvent,type RealtimeEvent,type RealtimePolicy,type RealtimeUsageObservation } from "./RealtimeEvents";

export class RealtimeBackend {
  async request<T>(path:string,method:string,body?:unknown,signal?:AbortSignal,keepalive=false):Promise<T> {
    const response = await fetch(`/api/realtime${path}`,{method,headers:{"Content-Type":"application/json"},
      body:body === undefined ? undefined : JSON.stringify(body),signal:signal ?? AbortSignal.timeout(20000),keepalive});
    if (!response.ok) {
      const error = await response.json().catch(() => ({})) as {code?:string};
      throw new Error(error.code === "realtime_disabled" ? "Экспериментальный Realtime выключен сервером." :
        error.code === "concurrent_session_limit" || error.code === "attempt_in_progress" ? "Достигнут лимит активных разговоров." : "Realtime недоступен. Проверьте доступ к выбранной модели и соединение.");
    }
    return (response.status === 204 ? undefined : await response.json()) as T;
  }
  identity(attemptId:string,generation:number,signal:AbortSignal) { return this.request<{admissionToken:string}>("/identity","POST",{attemptId,generation},signal); }
  create(body:{attemptId:string;generation:number;admissionToken:string;sdp:string;languages:{A:string;B:string}},signal:AbortSignal) {
    return this.request<{attemptId:string;sdp:string;expiresAt:number}>("/session","POST",body,signal);
  }
  cleanup(id:string) { return this.request<{state:string;closeConfirmed:boolean}>(`/session/${encodeURIComponent(id)}/cleanup`,"POST",{},undefined,true); }
  usage(id:string,observation:RealtimeUsageObservation) { return this.request<void>(`/session/${encodeURIComponent(id)}/usage`,"PUT",observation,undefined,true); }
  handoff(id:string,signal:AbortSignal) {return this.request<void>(`/session/${encodeURIComponent(id)}/handoff`,"POST",{},signal);}
}
export interface RealtimeTransport {
  onEvent:((event:RealtimeEvent)=>void)|null;
  onFailure:((category:string)=>void)|null;
  connect(stream:MediaStream,languages:{A:string;B:string}):Promise<void>;
  send(event:object):void;
  close():Promise<{closeConfirmed:boolean;state:string}>;
  reportUsage(observation:RealtimeUsageObservation):Promise<void>;
}

/** One immutable attempt owns all callbacks, SDP, peer and server cleanup. */
export class RealtimeClient implements RealtimeTransport {
  onEvent:((event:RealtimeEvent)=>void)|null = null;
  onFailure:((category:string)=>void)|null = null;
  private peer:RTCPeerConnection|null = null;
  private channel:RTCDataChannel|null = null;
  private readonly abort = new AbortController();
  private started = false;
  private closed = false;
  private identity:Promise<{admissionToken:string}>|undefined;
  private closeWork:Promise<{closeConfirmed:boolean;state:string}>|undefined;
  constructor(readonly attemptId:string,readonly generation:number,private readonly policy:RealtimePolicy,
    private readonly onRemote:(stream:MediaStream)=>Promise<void>,private readonly backend = new RealtimeBackend(),
    private readonly peerFactory = () => new RTCPeerConnection()) {}

  async connect(stream:MediaStream,languages:{A:string;B:string}):Promise<void> {
    if (this.started || this.closed) throw new Error("attempt_retired"); this.started = true;
    // No microphone bytes reach the provider until effective configuration is accepted.
    for (const track of stream.getAudioTracks()) track.enabled = false;
    const timer = setTimeout(() => this.abort.abort(),30000);
    let rejectReady!:(error:Error)=>void, resolveReady!:()=>void;
    const configured = new Promise<void>((resolve,reject) => { resolveReady=resolve; rejectReady=reject; });
    let resolveMedia!:()=>void;
    const media = new Promise<void>(resolve => { resolveMedia=resolve; });
    // Observe both rejections even when an earlier signaling step fails.
    void configured.catch(() => undefined);
    const aborted = new Promise<never>((_resolve,reject) => {
      const fail = () => reject(new Error("Realtime connection cancelled or timed out"));
      if (this.abort.signal.aborted) fail(); else this.abort.signal.addEventListener("abort",fail,{once:true});
    });
    void aborted.catch(() => undefined);
    const wait = <T>(work:Promise<T>) => Promise.race([work,aborted]);
    try {
      this.identity = this.backend.identity(this.attemptId,this.generation,this.abort.signal); const prepared=await wait(this.identity);
      const peer = this.peerFactory(); this.peer=peer;
      peer.onconnectionstatechange=()=> {
        if (!this.closed && ["failed","disconnected","closed"].includes(peer.connectionState)) {
          rejectReady(new Error("webrtc_failed")); this.abort.abort(); this.onFailure?.("webrtc_failed");
        }
      };
      peer.ontrack=event => {
        if (this.closed) {event.track.stop();return;}
        if (event.track.kind !== "audio") return;
        void this.onRemote(event.streams[0] ?? new MediaStream([event.track])).then(resolveMedia).catch(() => {
          rejectReady(new Error("playback_failed")); this.abort.abort(); this.onFailure?.("playback_failed");
        });
      };
      for (const track of stream.getAudioTracks()) peer.addTrack(track,stream);
      const channel = peer.createDataChannel("oai-events"); this.channel=channel;
      channel.onmessage=message => {
        if (this.closed) return;
        try {
          const event=parseRealtimeEvent(String(message.data)); if (!event) return;
          if (event.type === "session.created" || event.type === "session.updated") {
            if (!acceptsConfiguration(event.session,this.policy)) {
              rejectReady(new Error("effective_configuration_rejected")); this.abort.abort(); this.onFailure?.("configuration_rejected"); return;
            }
            resolveReady();
          }
          this.onEvent?.(event);
        } catch { rejectReady(new Error("invalid_provider_event")); this.abort.abort(); this.onFailure?.("invalid_provider_event"); }
      };
      channel.onclose=channel.onerror=()=> { if (!this.closed) { this.abort.abort(); this.onFailure?.("data_channel_closed"); } };
      await wait(peer.setLocalDescription(await wait(peer.createOffer())));
      await wait(waitForIceComplete(peer,10000));
      const sdp=peer.localDescription?.sdp; if (!sdp) throw new Error("offer_missing");
      const result=await wait(this.backend.create({attemptId:this.attemptId,generation:this.generation,admissionToken:prepared.admissionToken,sdp,languages},this.abort.signal));
      if (result.attemptId !== this.attemptId) throw new Error("attempt_mismatch");
      await wait(peer.setRemoteDescription({type:"answer",sdp:result.sdp}));
      await wait(Promise.all([configured,media]));
      if (this.closed || channel.readyState !== "open") throw new Error("channel_not_ready");
      await wait(this.backend.handoff(this.attemptId,this.abort.signal));
    } finally { clearTimeout(timer); }
  }
  send(event:object):void {
    if (this.closed || this.channel?.readyState !== "open") throw new Error("channel_not_ready");
    this.channel.send(JSON.stringify(event));
  }
  reportUsage(observation:RealtimeUsageObservation) { return this.backend.usage(this.attemptId,observation); }
  close():Promise<{closeConfirmed:boolean;state:string}> {
    if (this.closeWork) return this.closeWork;
    this.closed=true; this.abort.abort(); this.onEvent=this.onFailure=null;
    if (this.channel) { this.channel.onmessage=this.channel.onclose=this.channel.onerror=null; this.channel.close(); }
    if (this.peer) { this.peer.ontrack=this.peer.onconnectionstatechange=null; this.peer.close(); }
    this.channel=null; this.peer=null;
    this.closeWork=(async()=> {
      if (!this.identity) return {closeConfirmed:true,state:"not_dispatched"};
      // Preparation and its cookie may exist even when reading the identity body fails.
      await this.identity.catch(() => undefined);
      try { return await this.backend.cleanup(this.attemptId); }
      catch { return {closeConfirmed:false,state:"unknown"}; }
    })();
    return this.closeWork;
  }
}
