import { AudioController } from "../audio/AudioController";
import { createInitialSession,type TranslationSession } from "../session/SessionState";
import type { ProductSession } from "../session/ProductSession";
import type { DialogueBlock } from "../conversation/DialogueTranscript";
import type { Side,Turn } from "../conversation/Turn";
import { detectLanguage } from "../side/SideResolver";
import { RealtimeClient,type RealtimeTransport } from "./RealtimeClient";
import { RealtimePlayback,type RealtimeAudioOutput } from "./RealtimePlayback";
import { tokenUsage,type RealtimeEvent,type RealtimePolicy } from "./RealtimeEvents";

export interface SourceItem {
  localId:string;itemId:string;committed:boolean;contents:Map<number,{text:string;final:boolean;failed:boolean}>;
  turn:Turn;requestId?:string;responseId?:string;outputItemIds:string[];
  requestState:"queued"|"requested"|"acknowledged"|"completed"|"failed"|"unknown";
  committedAt?:number;firstSourceTextAtMs?:number;generationDone:boolean;bufferStopped:boolean;drained:boolean;
  outputContents:Map<string,{text:string;final:boolean}>;
}
type Capture = Pick<AudioController,"startCapture"|"getCaptureStream"|"setCaptureEnabled"|"dispose"|"onCaptureEnded">;
interface Attempt {
  id:string;generation:number;capture:Capture;output:RealtimeAudioOutput;transport:RealtimeTransport;
  retiring:boolean;timers:Set<ReturnType<typeof setTimeout>>;abort:AbortController;
}
export interface RealtimeControllerOptions {
  createCapture?:()=>Capture;
  createOutput?:()=>RealtimeAudioOutput;
  createTransport?:(id:string,generation:number,onRemote:(stream:MediaStream)=>Promise<void>)=>RealtimeTransport;
  now?:()=>number;
  responseTimeoutMs?:number;
  mediaTailMs?:number;
}
const emptySession=()=>createInitialSession({side:"A",hasAcceptedConversationSpeech:false},{side:"B",hasAcceptedConversationSpeech:false});
function createCapture():Capture {
  let retired=false,stream:MediaStream|undefined;
  const audio=new AudioController({getUserMedia:async constraints=> {
    const result=await navigator.mediaDevices.getUserMedia(constraints);
    if(retired){for(const track of result.getTracks())track.stop();throw new Error("capture_retired");}
    stream=result;return result;
  }});
  return {
    startCapture:()=>audio.startCapture(),getCaptureStream:()=>audio.getCaptureStream(),
    setCaptureEnabled:value=>audio.setCaptureEnabled(value),
    get onCaptureEnded(){return audio.onCaptureEnded;},set onCaptureEnded(value){audio.onCaptureEnded=value;},
    dispose:()=> {retired=true;audio.onCaptureEnded=null;audio.dispose();for(const track of stream?.getTracks()??[])track.stop();},
  };
}
export class RealtimeSessionController implements ProductSession {
  readonly engine="realtime" as const;
  readonly capabilities={changeLanguages:false,resume:false,playbackSwitch:false};
  readonly buildSha=__BUILD_SHA__;
  session:TranslationSession=emptySession();
  ownerError:string|undefined;
  inputReady=false;
  hasEnteredInterpreter=false;
  activityLabel="Готов к подключению";
  diagnosticsRevision=0;
  captionBlocks:readonly DialogueBlock[]=[];
  readonly items=new Map<string,SourceItem>();
  private readonly listeners=new Set<()=>void>();
  private readonly speech=new Set<string>();
  private readonly awaitingCommit=new Set<string>();
  private readonly pending:string[]=[];
  private active:SourceItem|undefined;
  private attempt:Attempt|undefined;
  private generation=0;
  private startWork:Promise<void>|undefined;
  private stopWork:Promise<void>|undefined;
  private scheduled=false;
  private held=false;
  private disposed=false;
  private events:Array<{name:string;elapsedMs:number;itemId?:string;responseId?:string;providerAudioMs?:number;category?:string;state?:string;activity?:string}>=[];
  private usage:Array<{responseId:string;usage:object}>=[];
  private cleanup={state:"not_dispatched",closeConfirmed:true};
  private startAt=0;
  private wallStartedAt:string|undefined;
  private lastAttemptId:string|undefined;
  private lastActivity="";
  constructor(readonly policy:RealtimePolicy,private readonly options:RealtimeControllerOptions={}) {}
  get model() {return this.policy.model;}
  get isConnectInFlight() {return !!this.startWork;}
  subscribe(listener:()=>void) {this.listeners.add(listener);return()=>{this.listeners.delete(listener);};}
  private now() {return (this.options.now??(()=>performance.now()))();}
  private notify() {this.diagnosticsRevision++;for(const listener of this.listeners) listener();}
  private trace(name:string,item?:SourceItem,extra:Partial<(typeof this.events)[number]>={}) {
    this.events.push({name,elapsedMs:this.now()-this.startAt,itemId:item?.itemId,responseId:item?.responseId,...extra});
    if(this.events.length>1000)this.events.shift();
  }
  private valid(attempt:Attempt) {return !attempt.retiring && !this.disposed && this.attempt===attempt;}
  private later(attempt:Attempt,work:()=>void,ms:number) {
    const timer=setTimeout(()=> {attempt.timers.delete(timer);if(this.valid(attempt))work();},ms);
    attempt.timers.add(timer);return timer;
  }
  startWithLanguages(languages:{A:string;B:string}):Promise<void> {
    if(this.startWork)return this.startWork;
    if(this.stopWork || this.disposed || this.session.state!=="idle")return Promise.reject(new Error("conversation_in_progress"));
    if(document.visibilityState==="hidden") {
      this.ownerError="Вернитесь на страницу и начните новый разговор Realtime.";this.notify();return Promise.reject(new Error("page_hidden"));
    }
    if(!this.policy.enabled || languages.A===languages.B || ![languages.A,languages.B].every(l=>l==="ru"||l==="en")) {
      this.ownerError="Realtime Pilot поддерживает только пару русский / английский.";this.notify();return Promise.reject(new Error("unsupported_languages"));
    }
    this.startAt=this.now();this.wallStartedAt=new Date().toISOString();this.events=[];this.usage=[];
    this.cleanup={state:"starting",closeConfirmed:false};this.lastActivity="";
    this.items.clear();this.pending.length=0;this.speech.clear();this.awaitingCommit.clear();this.active=undefined;
    this.ownerError=undefined;this.hasEnteredInterpreter=false;this.captionBlocks=[];this.held=false;this.scheduled=false;
    this.session={...emptySession(),state:"connecting",participantA:{side:"A",language:languages.A,hasAcceptedConversationSpeech:false},
      participantB:{side:"B",language:languages.B,hasAcceptedConversationSpeech:false}};
    this.activityLabel="Подключение Realtime…";
    const id=crypto.randomUUID(),generation=++this.generation;
    this.lastAttemptId=id;
    const capture=this.options.createCapture?.()??createCapture();
    const output=this.options.createOutput?.()??new RealtimePlayback();
    const transport=this.options.createTransport?.(id,generation,s=>output.attach(s))??new RealtimeClient(id,generation,this.policy,s=>output.attach(s));
    const attempt:Attempt={id,generation,capture,output,transport,retiring:false,timers:new Set(),abort:new AbortController()};this.attempt=attempt;
    transport.onEvent=event=>{if(this.valid(attempt))this.receive(event,attempt);};
    transport.onFailure=category=>{if(this.valid(attempt))this.fail(category);};
    capture.onCaptureEnded=()=>{if(this.valid(attempt))this.fail("microphone_ended");};
    output.onFailure=category=>{if(this.valid(attempt))this.fail(category);};
    output.onStarted=id=> {
      if(!this.valid(attempt)||this.active?.requestId!==id)return;
      this.active.turn.audioOutputStarted=true;this.trace("local_playback_started",this.active);this.update();
    };
    output.onDrained=id=> {
      if(!this.valid(attempt)||this.active?.requestId!==id)return;
      this.active.drained=true;this.active.turn.playbackEndAtMs=this.now();
      this.trace("local_playback_drained",this.active);this.finishResponse();this.update();
    };
    this.trace("attempt_started",undefined,{state:this.session.state});
    // Start immediately in the user gesture; async failures are handled per owned attempt.
    const work=this.startAttempt(attempt,languages).finally(()=>{if(this.startWork===work)this.startWork=undefined;this.notify();});
    this.startWork=work;this.notify();return work;
  }
  private async startAttempt(attempt:Attempt,languages:{A:string;B:string}) {
    const aborted=new Promise<never>((_resolve,reject)=>attempt.abort.signal.addEventListener("abort",()=>reject(new Error("start_cancelled")),{once:true}));
    void aborted.catch(()=>undefined);
    const wait=<T>(work:Promise<T>)=>Promise.race([work,aborted]);
    this.later(attempt,()=>this.fail("startup_timeout"),30000);
    try {
      const primed=attempt.output.prime();
      void primed.catch(()=>undefined);
      await wait(attempt.capture.startCapture().then(()=>{if(!this.valid(attempt))attempt.capture.dispose();}));
      if(!this.valid(attempt)){attempt.capture.dispose();return;}
      attempt.capture.setCaptureEnabled(false);await wait(primed);
      if(!this.valid(attempt))return;
      const stream=attempt.capture.getCaptureStream();if(!stream)throw new Error("microphone_missing");
      await wait(attempt.transport.connect(stream,languages));
      if(!this.valid(attempt))return;
      if(document.visibilityState==="hidden"){this.hidden();return;}
      this.cleanup={state:"active",closeConfirmed:false};
      attempt.capture.setCaptureEnabled(true);this.inputReady=true;this.hasEnteredInterpreter=true;
      this.session={...this.session,state:"listening"};this.trace("configuration_accepted_input_enabled");
      // Startup timeout no longer applies to the established conversation.
      for(const timer of attempt.timers)clearTimeout(timer);attempt.timers.clear();
      this.scheduled=false;this.schedule();
      this.later(attempt,()=>this.fail("session_duration_limit"),this.policy.maxSessionMs);
      this.update();
    } catch(error) {
      if(!this.valid(attempt))return;
      this.fail(error instanceof DOMException && error.name==="NotAllowedError" ? "microphone_denied" : "startup_failed");
    }
  }
  private item(id:string):SourceItem {
    let item=this.items.get(id);if(item)return item;
    if(this.items.size>=128)throw new Error("input_item_limit");
    item={itemId:id,localId:`realtime:${this.generation}:${id}`,committed:false,contents:new Map(),outputContents:new Map(),outputItemIds:[],
      requestState:"queued",generationDone:false,bufferStopped:false,drained:false,
      turn:{id:`realtime:${this.generation}:${id}`,speaker:undefined,sideSource:"unresolved",sourceFragments:[],originalText:"",
        status:"streaming",audioOutputStarted:false,languages:{A:this.session.participantA.language!,B:this.session.participantB.language!}}};
    this.items.set(id,item);return item;
  }
  private receive(event:RealtimeEvent,attempt:Attempt) {
    try {
      if(event.type==="error") {this.fail("provider_error");return;}
      if(event.type==="input_audio_buffer.speech_started") {
        const item=this.item(event.item_id);if(this.speech.has(event.item_id)||item.committed)return;
        this.speech.add(event.item_id);this.held=true;attempt.output.hold(true);
        item.turn.speechStartAtMs=this.now();this.trace("speech_started",item,{providerAudioMs:event.audio_start_ms});
        this.later(attempt,()=>{if(this.speech.has(item.itemId))this.fail("source_timeout");},60000);
      } else if(event.type==="input_audio_buffer.speech_stopped") {
        const item=this.item(event.item_id);this.speech.delete(event.item_id);
        if(!item.committed){this.awaitingCommit.add(event.item_id);this.later(attempt,()=>{if(!item.committed)this.fail("commit_timeout");},30000);}
        item.turn.sourceIdleAtMs=this.now();this.trace("speech_stopped",item,{providerAudioMs:event.audio_end_ms});
        // A stopped event alone does not release hold or permit response creation.
        if(item.committed)this.releaseHold(attempt);
      } else if(event.type==="input_audio_buffer.committed") {
        const item=this.item(event.item_id);this.awaitingCommit.delete(event.item_id);
        if(!item.committed) {
          if(this.pending.length>=16)throw new Error("input_queue_limit");
          item.committed=true;item.committedAt=this.now();item.turn.sourceIdleAtMs??=this.now();this.pending.push(item.itemId);
          this.trace("input_committed",item);
          this.later(attempt,()=>{if(!["completed","failed"].includes(item.requestState))this.fail("item_wait_timeout");},180000);
        }
        this.releaseHold(attempt);
      } else if(event.type==="conversation.item.input_audio_transcription.delta" || event.type==="conversation.item.input_audio_transcription.completed" || event.type==="conversation.item.input_audio_transcription.failed") {
        const item=this.item(event.item_id),part=item.contents.get(event.content_index)??{text:"",final:false,failed:false};
        if(event.type.endsWith("failed")) {part.failed=true;part.final=true;this.trace("transcription_failed",item);}
        else if("transcript" in event) {part.text=event.transcript;part.final=true;}
        else if("delta" in event && !part.final) part.text+=event.delta;
        if(part.text.length>16000)throw new Error("text_limit");
        item.contents.set(event.content_index,part);
        item.turn.originalText=[...item.contents].sort(([a],[b])=>a-b).map(([,p])=>p.text).join(" ");
        if(item.turn.originalText && item.firstSourceTextAtMs===undefined) {
          item.firstSourceTextAtMs=this.now();this.trace("first_source_text",item);
        }
        item.turn.speaker=this.sourceSide(item.turn.originalText);
        item.turn.sideSource=item.turn.speaker ? "language":"unresolved";
      } else if(event.type==="response.created" || event.type==="response.done") {
        const item=this.active,meta=event.response.metadata;
        if([...this.items.values()].some(i=>i.responseId===event.response.id&&i.generationDone))return;
        if(!item || meta?.request_id!==item.requestId || meta?.source_item_id!==item.itemId || meta?.attempt_id!==attempt.id || meta?.generation!==String(attempt.generation)) {
          throw new Error("response_correlation_mismatch");
        }
        if(item.responseId && item.responseId!==event.response.id)throw new Error("duplicate_response");
        item.responseId=event.response.id;
        if(event.type==="response.created") {item.requestState="acknowledged";this.trace("response_acknowledged",item);}
        else {
          if(item.generationDone)return;
          item.generationDone=true;this.trace("generation_done",item);
          const usage=tokenUsage(event.response.usage);
          if(usage) {this.usage.push({responseId:item.responseId,usage});void attempt.transport.reportUsage(item.responseId,usage).catch(()=> {
            if(this.valid(attempt)){this.trace("usage_delivery_pending",item);this.notify();}
          });}
          if(event.response.status!=="completed" || !event.response.output?.length) {
            item.requestState="failed";item.turn.status="failed";this.fail("response_failed_or_empty");return;
          }
          for(const output of event.response.output) {
            if(!item.outputItemIds.includes(output.id))item.outputItemIds.push(output.id);
            output.content?.forEach((part,index)=>{if(part.transcript!==undefined)item.outputContents.set(`${output.id}:${index}`,{text:part.transcript,final:true});});
          }
          this.refreshOutput(item);
          if(item.turn.translatedText && item.turn.firstOutputTextAtMs===undefined) {
            item.turn.firstOutputTextAtMs=this.now();this.trace("first_output_text",item);
          }
          this.finishResponse();
        }
      } else if("response_id" in event) {
        const item=this.active;
        if(!item || item.responseId!==event.response_id)return;
        if(event.type==="response.output_item.added") {if(!item.outputItemIds.includes(event.item.id))item.outputItemIds.push(event.item.id);}
        else if(event.type==="response.output_audio_transcript.delta" || event.type==="response.output_audio_transcript.done") {
          const key=`${event.item_id}:${event.content_index}`,part=item.outputContents.get(key)??{text:"",final:false};
          if("transcript" in event) {part.text=event.transcript;part.final=true;} else if(!part.final)part.text+=event.delta;
          if(part.text.length>16000)throw new Error("text_limit");
          item.outputContents.set(key,part);this.refreshOutput(item);
          if(item.turn.translatedText && item.turn.firstOutputTextAtMs===undefined) {
            item.turn.firstOutputTextAtMs=this.now();this.trace("first_output_text",item);
          }
        } else if(event.type==="output_audio_buffer.started") {this.trace("provider_buffer_started",item);}
        else if(event.type==="output_audio_buffer.stopped" && !item.bufferStopped) {
          item.bufferStopped=true;this.trace("provider_buffer_stopped",item);
          // ponytail: RTP/data-channel skew has no exact PCM boundary. Retain 1s;
          // measure on hardware before tuning or replacing with a stronger transport barrier.
          this.later(attempt,()=>attempt.output.seal(),this.options.mediaTailMs??1000);
        }
      }
      this.update();this.schedule();
    } catch(error) {this.fail(error instanceof Error ? error.message:"protocol_error");}
  }
  private sourceSide(text:string):Side|undefined {
    if(/[\p{Script=Cyrillic}]/u.test(text)&&/[\p{Script=Latin}]/u.test(text))return;
    const language=detectLanguage(text);return language===this.session.participantA.language ? "A":language===this.session.participantB.language ? "B":undefined;
  }
  private refreshOutput(item:SourceItem) {item.turn.translatedText=[...item.outputContents.values()].map(p=>p.text).join(" ");}
  private releaseHold(attempt:Attempt) {
    if(this.speech.size || this.awaitingCommit.size)return;
    this.held=false;attempt.output.hold(false);this.trace("playback_resumed");
  }
  private schedule() {
    const attempt=this.attempt;
    if(!attempt || !this.valid(attempt) || !this.inputReady || this.scheduled)return;
    this.scheduled=true;
    this.later(attempt,()=>{
      this.scheduled=false;
      // Recheck at send time: speech_started may arrive after the commit callback.
      if(!this.inputReady || this.speech.size || this.awaitingCommit.size || this.held || this.active || !this.pending.length)return;
      const item=this.items.get(this.pending.shift()!)!;
      item.requestId=`rt_${attempt.generation}_${crypto.randomUUID()}`;item.requestState="requested";item.turn.status="outputting";this.active=item;
      try {
        attempt.output.begin(item.requestId);
        attempt.transport.send({type:"response.create",event_id:item.requestId,response:{conversation:"none",output_modalities:["audio"],
          input:[{type:"item_reference",id:item.itemId}],metadata:{request_id:item.requestId,source_item_id:item.itemId,
            attempt_id:attempt.id,generation:String(attempt.generation)}}});
        this.trace("response_requested",item);
        this.later(attempt,()=>{if(this.active===item){item.requestState="unknown";this.fail("response_or_drain_timeout");}},this.options.responseTimeoutMs??90000);
      }catch {item.requestState="unknown";this.fail("response_send_unknown");}
      this.update();
    },0);
  }
  private finishResponse() {
    const item=this.active;if(!item || !item.generationDone || !item.bufferStopped || !item.drained)return;
    if(!item.turn.translatedText?.trim()) {item.requestState="failed";item.turn.status="failed";this.fail("empty_translation");return;}
    item.requestState="completed";item.turn.status="completed";item.turn.turnCompletedAtMs=this.now();
    this.trace("translation_completed",item);this.active=undefined;this.schedule();
  }
  private update() {
    const turns=[...this.items.values()].map(i=>({...i.turn})),source=[...this.speech].at(-1);
    this.session={...this.session,activeTurn:source?{...this.items.get(source)!.turn}:undefined,
      pendingTurns:turns.filter(t=>t.status==="outputting"),recentTurns:turns.filter(t=>t.status==="completed"||t.status==="failed")};
    this.captionBlocks=[...this.items.values()].flatMap(item=> {
      const side=item.turn.speaker;
      const failed=[...item.contents.values()].some(p=>p.failed);
      return [{id:`${item.localId}:input`,kind:"input" as const,text:failed?
        (item.turn.originalText?`${item.turn.originalText} · исходный текст не подтверждён`:"Исходный текст недоступен"):
        item.turn.originalText||"Ожидание исходного текста…",side,
        receivedAtMs:item.turn.speechStartAtMs??item.committedAt??this.now()},
        ...(item.turn.translatedText?[{id:`${item.localId}:output`,kind:"output" as const,text:item.turn.translatedText,
          side:side?(side==="A"?"B":"A") as Side:undefined,receivedAtMs:item.turn.firstOutputTextAtMs??this.now()}]:[])];
    });
    if(this.inputReady) {
      this.activityLabel=this.held&&this.active?"Перевод удержан · принимаю речь":this.speech.size?"Принимаю речь":
        this.active?.turn.audioOutputStarted?"Воспроизведение перевода":this.active?"Генерация перевода":"Готов слушать";
      this.session={...this.session,state:this.active?"outputting":"listening"};
    }
    if(this.lastActivity!==this.activityLabel){this.lastActivity=this.activityLabel;this.trace("state_changed",undefined,{state:this.session.state,activity:this.activityLabel});}
    this.notify();
  }
  private fail(category:string) {
    this.trace("error",undefined,{category:/^[a-z_]+$/.test(category)?category:"operation_failed"});
    this.ownerError=category==="microphone_denied"?"Разрешите доступ к микрофону и начните новый разговор.":
      category.includes("limit")?"Достигнут лимит Realtime. Разговор остановлен; начните новый.":
      category==="startup_failed"?`Не удалось подключить Realtime (${this.model}). Проверьте доступ к модели и соединение; начните новый разговор.`:
      "Realtime остановлен из-за ошибки или ожидания ответа. Начните новый разговор.";
    void this.stop(true);
  }
  cancel() {return this.stop(false);}
  endConversation() {return this.stop(false);}
  private stop(error:boolean):Promise<void> {
    if(this.stopWork)return this.stopWork;
    const attempt=this.attempt;
    if(!attempt) {if(!error){this.session=emptySession();this.hasEnteredInterpreter=false;}this.notify();return Promise.resolve();}
    attempt.retiring=true;attempt.abort.abort();this.inputReady=false;this.activityLabel="Остановка Realtime…";
    this.session={...this.session,state:"ending"};
    this.trace("state_changed",undefined,{state:"ending",activity:this.activityLabel});
    for(const item of this.items.values()) {
      if(item.requestState==="queued")item.requestState="failed";
      else if(item.requestState==="requested" || item.requestState==="acknowledged")item.requestState="unknown";
      if(item.turn.status!=="completed")item.turn.status="failed";
    }
    for(const timer of attempt.timers)clearTimeout(timer);attempt.timers.clear();
    attempt.capture.onCaptureEnded=null;attempt.capture.dispose();attempt.output.dispose();
    attempt.transport.onEvent=attempt.transport.onFailure=null;
    this.speech.clear();this.awaitingCommit.clear();this.pending.length=0;
    const work=(async()=> {
      try{this.cleanup=await attempt.transport.close();}catch{this.cleanup={state:"unknown",closeConfirmed:false};}
      if(this.attempt!==attempt)return;
      this.trace("attempt_stopped");this.attempt=undefined;this.active=undefined;this.scheduled=false;
      this.activityLabel=error?"Ошибка Realtime":"Разговор завершён";
      if(!this.cleanup.closeConfirmed)this.ownerError="Локальный разговор остановлен. Закрытие серверной попытки ещё не подтверждено.";
      this.session=error?{...this.session,state:"error"}:emptySession();
      this.trace("state_changed",undefined,{state:this.session.state,activity:this.activityLabel});
      if(!error)this.hasEnteredInterpreter=false;
    })().finally(()=>{if(this.stopWork===work)this.stopWork=undefined;this.notify();});
    this.stopWork=work;this.notify();return work;
  }
  start() {document.addEventListener("visibilitychange",this.hidden);window.addEventListener("pagehide",this.pagehide);}
  private hidden=()=> {if(document.visibilityState==="hidden"&&this.attempt){this.ownerError="Realtime завершён при уходе в фон. Начните новый разговор.";void this.stop(false);}};
  private pagehide=()=>{void this.stop(false);};
  async dispose() {
    this.disposed=true;document.removeEventListener("visibilitychange",this.hidden);window.removeEventListener("pagehide",this.pagehide);
    await this.stop(false);this.listeners.clear();
  }
  exportDiagnostics() {
    return {engine:this.engine,model:this.model,transcriptionModel:this.policy.transcriptionModel,buildSha:this.buildSha,
      vad:this.policy.vad,promptVersion:this.policy.promptVersion,schemaVersion:this.policy.schemaVersion,generation:this.generation,
      attemptId:this.lastAttemptId,wallStartedAt:this.wallStartedAt,clock:"client elapsed milliseconds; provider audio timestamps stored separately",
      playbackClock:"AudioWorklet render quanta, including silence; not acoustic sound at the listener",
      state:this.session.state,pendingItems:this.pending.length,pcmSamples:this.attempt?.output.pendingSamples??0,cleanup:this.cleanup,
      items:[...this.items.values()].map(i=>({localId:i.localId,inputItemId:i.itemId,requestId:i.requestId,responseId:i.responseId,
        outputItemIds:i.outputItemIds,requestState:i.requestState,side:i.turn.speaker,sideSource:i.turn.speaker?"local_text_estimate":"unknown",
        transcriptionStatus:[...i.contents.values()].some(p=>p.failed)?"failed":[...i.contents.values()].every(p=>p.final)&&i.contents.size?"completed":"pending",
        generationDone:i.generationDone,bufferStopped:i.bufferStopped,drained:i.drained})),
      events:this.events,usage:this.usage,cost:"not calculated"};
  }
}
