export interface RealtimePolicy {
  enabled: boolean; model: string; transcriptionModel: string; vad: { type:"server_vad"; threshold:number;
    prefix_padding_ms:number; silence_duration_ms:number; create_response:false; interrupt_response:false };
  promptVersion:string; schemaVersion:number; maxSessionMs:number;
  instructions:string; transcriptionPrompt:string; maxOutputTokens:number;
}
export interface EffectiveSession {
  type?:string; model?:string; output_modalities?:string[]; instructions?:string; tools?:unknown[]; max_output_tokens?:number|string;
  audio?: {input?: {transcription?:{model?:string;prompt?:string;language?:string|null}|null;turn_detection?: Record<string,unknown>};output?:{voice?:string}};
}
export interface ResponseInfo {
  id:string; status?:string; metadata?:Record<string,string>;
  usage?:unknown; output?:Array<{id:string;content?:Array<{type?:string;transcript?:string}>}>;
}
export type RealtimeEvent =
  | {type:"session.created"|"session.updated";session:EffectiveSession}
  | {type:"input_audio_buffer.speech_started"|"input_audio_buffer.speech_stopped";item_id:string;audio_start_ms?:number;audio_end_ms?:number}
  | {type:"input_audio_buffer.committed";item_id:string;previous_item_id?:string|null}
  | {type:"conversation.item.input_audio_transcription.delta";item_id:string;content_index:number;delta:string}
  | {type:"conversation.item.input_audio_transcription.completed";item_id:string;content_index:number;transcript:string;usage?:unknown}
  | {type:"conversation.item.input_audio_transcription.failed";item_id:string;content_index:number}
  | {type:"response.created"|"response.done";response:ResponseInfo}
  | {type:"response.output_item.added";response_id:string;item:{id:string}}
  | {type:"response.output_audio_transcript.delta";response_id:string;item_id:string;content_index:number;delta:string}
  | {type:"response.output_audio_transcript.done";response_id:string;item_id:string;content_index:number;transcript:string}
  | {type:"output_audio_buffer.started"|"output_audio_buffer.stopped"|"output_audio_buffer.cleared";response_id:string}
  | {type:"error"};

/** Ignore unrelated GA events; reject malformed fields without exporting raw payloads. */
export function parseRealtimeEvent(raw:string): RealtimeEvent | undefined {
  const value:unknown = JSON.parse(raw);
  if (!value || typeof value !== "object" || !("type" in value) || typeof value.type !== "string") throw new Error("invalid_event");
  const v = value as Record<string,unknown> & {type:string};
  const identifier = (value:unknown) => typeof value === "string" && /^[A-Za-z0-9_-]{1,200}$/.test(value);
  const id = (name:string) => identifier(v[name]);
  const index = () => Number.isInteger(v.content_index) && (v.content_index as number)>=0 && (v.content_index as number)<32;
  const text = (value:unknown) => typeof value === "string" && value.length<=16000;
  if (v.type === "error") return {type:"error"};
  if (v.type === "session.created" || v.type === "session.updated") {
    if (!v.session || typeof v.session !== "object") throw new Error("invalid_session");
    return v as unknown as RealtimeEvent;
  }
  if (v.type === "response.created" || v.type === "response.done") {
    if (!v.response || typeof v.response !== "object" || !("id" in v.response) || !identifier(v.response.id)) throw new Error("invalid_response");
    if("output" in v.response && v.response.output!==undefined) {
      if(!Array.isArray(v.response.output) || v.response.output.length>32)throw new Error("invalid_output");
      for(const item of v.response.output) {
        if(!item || !identifier(item.id) || item.content!==undefined && (!Array.isArray(item.content) || item.content.length>32 ||
          item.content.some((part:unknown)=>!part || typeof part!=="object" || "transcript" in part && part.transcript!==undefined && !text(part.transcript))))throw new Error("invalid_output");
      }
    }
    return v as unknown as RealtimeEvent;
  }
  if (v.type === "input_audio_buffer.committed" || v.type === "input_audio_buffer.speech_started" || v.type === "input_audio_buffer.speech_stopped") {
    if (!id("item_id")) throw new Error("invalid_item");
    for(const key of ["audio_start_ms","audio_end_ms"])if(v[key]!==undefined && (typeof v[key]!=="number" || !Number.isFinite(v[key]) || (v[key] as number)<0))throw new Error("invalid_audio_clock");
  } else if (v.type.startsWith("conversation.item.input_audio_transcription.")) {
    if (!["delta","completed","failed"].some(s => v.type === `conversation.item.input_audio_transcription.${s}`)) return;
    if (!id("item_id") || !index()) throw new Error("invalid_transcription");
    if (v.type.endsWith(".delta") && !text(v.delta) || v.type.endsWith(".completed") && !text(v.transcript)) throw new Error("invalid_transcription");
  } else if (v.type === "response.output_audio_transcript.delta" || v.type === "response.output_audio_transcript.done") {
    if (!id("response_id") || !id("item_id") || !index() ||
      (v.type.endsWith("delta") ? !text(v.delta) : !text(v.transcript))) throw new Error("invalid_output");
  } else if (v.type === "response.output_item.added") {
    if (!id("response_id") || !v.item || typeof v.item !== "object" || !("id" in v.item) || !identifier(v.item.id)) throw new Error("invalid_output");
  } else if (v.type === "output_audio_buffer.started" || v.type === "output_audio_buffer.stopped" || v.type === "output_audio_buffer.cleared") {
    if (!id("response_id")) throw new Error("invalid_buffer");
  } else return;
  return v as unknown as RealtimeEvent;
}

export function acceptsConfiguration(session:EffectiveSession,policy:RealtimePolicy):boolean {
  const vad = session.audio?.input?.turn_detection;
  return session.type==="realtime" && typeof policy.instructions==="string" && policy.instructions.length>0 &&
    session.instructions===policy.instructions && Array.isArray(session.tools) && session.tools.length===0 &&
    session.max_output_tokens===policy.maxOutputTokens && policy.maxOutputTokens===4096 &&
    session.model === policy.model && session.output_modalities?.length === 1 && session.output_modalities[0] === "audio" &&
    session.audio?.input?.transcription?.model === policy.transcriptionModel &&
    typeof policy.transcriptionPrompt==="string" && policy.transcriptionPrompt.length>0 && session.audio.input.transcription.prompt===policy.transcriptionPrompt &&
    session.audio.input.transcription.language==null &&
    session.audio?.output?.voice === "marin" && !!vad && Object.entries(policy.vad).every(([key,value]) => vad[key] === value) &&
    vad.idle_timeout_ms == null;
}

/** Numeric provider token observations only; no speech or arbitrary payloads. */
export function tokenUsage(raw:unknown,depth=0):Record<string,unknown> | undefined {
  if(depth>2)return;
  if (!raw || typeof raw !== "object") return;
  const r = raw as Record<string,unknown>, result:Record<string,unknown> = {};
  const numericKeys = ["total_tokens","input_tokens","output_tokens","cached_tokens","text_tokens","audio_tokens","image_tokens"];
  for (const key of numericKeys) if (Number.isSafeInteger(r[key]) && (r[key] as number) >= 0) result[key] = r[key];
  for (const key of ["input_token_details","output_token_details","cached_tokens_details"]) {
    if (r[key]) result[key] = tokenUsage(r[key],depth+1);
  }
  return Object.keys(result).length && (depth>0 || ["total_tokens","input_tokens","output_tokens"].every(key=>key in result))?result:undefined;
}

export function transcriptionUsage(raw:unknown):Record<string,unknown>|undefined {
  if(!raw || typeof raw!=="object")return;
  const r=raw as Record<string,unknown>;
  if(r.type==="tokens") {const tokens=tokenUsage(raw);return tokens?{type:"tokens",...tokens}:undefined;}
  if(r.type==="duration" && typeof r.seconds==="number" && Number.isFinite(r.seconds) && r.seconds>=0 && r.seconds<=3600)return {type:"duration",seconds:r.seconds};
}
export type RealtimeUsageObservation=
  | {operation:"response";responseId:string;usage:object}
  | {operation:"transcription";itemId:string;contentIndex:number;usage:object};
