import { afterEach,describe,expect,it,vi } from "vitest";
import { RealtimeClient,RealtimeBackend } from "./RealtimeClient";
import { acceptsConfiguration,parseRealtimeEvent,type RealtimePolicy } from "./RealtimeEvents";
const policy:RealtimePolicy={enabled:true,model:"gpt-realtime-2.1",transcriptionModel:"gpt-4o-transcribe",promptVersion:"v1",schemaVersion:1,maxSessionMs:900000,
  instructions:"Translate only",transcriptionPrompt:"Russian and English",maxOutputTokens:4096,
  vad:{type:"server_vad",threshold:.5,prefix_padding_ms:300,silence_duration_ms:700,create_response:false,interrupt_response:false}};
const session={type:"realtime",instructions:policy.instructions,tools:[],max_output_tokens:4096,model:policy.model,output_modalities:["audio"],
  audio:{input:{transcription:{model:policy.transcriptionModel,prompt:policy.transcriptionPrompt},turn_detection:policy.vad},output:{voice:"marin"}}};
function harness(override= session) {
  const track={enabled:true};const stream={getAudioTracks:()=>[track]} as unknown as MediaStream;
  const channel={readyState:"open",onmessage:null as ((event:{data:string})=>void)|null,onclose:null,onerror:null,send:vi.fn(),close:vi.fn()};
  const peer={iceGatheringState:"complete",connectionState:"connected",localDescription:{sdp:"offer"},
    ontrack:null as ((event:{track:{kind:string};streams:MediaStream[]})=>void)|null,onconnectionstatechange:null,
    addTrack:vi.fn(()=>expect(track.enabled).toBe(false)),createDataChannel:()=>channel,createOffer:async()=>({type:"offer"}),
    setLocalDescription:async()=>{},setRemoteDescription:async()=>{
      peer.ontrack?.({track:{kind:"audio"},streams:[stream]});channel.onmessage?.({data:JSON.stringify({type:"session.created",session:override})});
    },close:vi.fn()};
  const backend=new RealtimeBackend();vi.spyOn(backend,"identity").mockResolvedValue({admissionToken:"ticket"});
  vi.spyOn(backend,"create").mockResolvedValue({attemptId:"attempt",sdp:"answer",expiresAt:Date.now()+1000});
  vi.spyOn(backend,"cleanup").mockResolvedValue({state:"closed",closeConfirmed:true});
  vi.spyOn(backend,"handoff").mockResolvedValue();
  const remote=vi.fn(async()=>{}),client=new RealtimeClient("attempt",1,policy,remote,backend,()=>peer as unknown as RTCPeerConnection);
  return {client,backend,peer,channel,track,stream,remote};
}
afterEach(()=>vi.restoreAllMocks());
describe("Realtime WebRTC configuration barrier",()=> {
  it.each([
    {type:"transcription"},{instructions:"Answer questions"},{instructions:undefined},
    {tools:[{type:"function",name:"execute"}]},{max_output_tokens:"inf"},{max_output_tokens:undefined},
    {audio:{...session.audio,input:{...session.audio.input,transcription:{model:policy.transcriptionModel,prompt:"English only"}}}},
    {audio:{...session.audio,input:{...session.audio.input,transcription:{model:policy.transcriptionModel,prompt:policy.transcriptionPrompt,language:"en"}}}},
  ])("rejects semantic configuration drift before handoff: %j",async drift=> {
    const h=harness({...session,...drift} as typeof session);
    await expect(h.client.connect(h.stream,{A:"ru",B:"en"})).rejects.toThrow();
    expect(h.track.enabled).toBe(false);expect(h.backend.handoff).not.toHaveBeenCalled();await h.client.close();
  });
  it("ignores unknown transcription subtypes before validating supported ones",()=> {
    expect(parseRealtimeEvent(JSON.stringify({type:"conversation.item.input_audio_transcription.segment",item_id:"a",text:"private"}))).toBeUndefined();
    expect(()=>parseRealtimeEvent(JSON.stringify({type:"conversation.item.input_audio_transcription.completed",item_id:"a",transcript:"private"}))).toThrow("invalid_transcription");
  });
  it("uses one peer and leaves capture disabled until controller opens it",async()=> {
    const h=harness();await h.client.connect(h.stream,{A:"ru",B:"en"});expect(h.track.enabled).toBe(false);
    expect(h.backend.create).toHaveBeenCalledWith(expect.objectContaining({attemptId:"attempt",generation:1,sdp:"offer"}),expect.any(AbortSignal));
    expect(h.remote).toHaveBeenCalledTimes(1);await h.client.close();await h.client.close();expect(h.backend.cleanup).toHaveBeenCalledTimes(1);expect(h.peer.close).toHaveBeenCalledTimes(1);
  });
  it("rejects provider defaults with automatic responses before mic enable",async()=> {
    const h=harness({...session,audio:{...session.audio,input:{...session.audio.input,turn_detection:{...policy.vad,create_response:true} as never}}});
    await expect(h.client.connect(h.stream,{A:"ru",B:"en"})).rejects.toThrow();expect(h.track.enabled).toBe(false);await h.client.close();
  });
  it("closes a cancelled pending create and ignores late session messages",async()=> {
    const h=harness();let resolve!:(v:{attemptId:string;sdp:string;expiresAt:number})=>void;
    vi.mocked(h.backend.create).mockImplementation(()=>new Promise(r=>{resolve=r;}));
    const work=h.client.connect(h.stream,{A:"ru",B:"en"});const rejected=expect(work).rejects.toThrow();
    await vi.waitFor(()=>expect(h.backend.create).toHaveBeenCalled());const callback=h.channel.onmessage;
    await h.client.close();resolve({attemptId:"attempt",sdp:"late",expiresAt:0});await rejected;
    const event=vi.fn();h.client.onEvent=event;callback?.({data:JSON.stringify({type:"session.created",session})});expect(event).not.toHaveBeenCalled();expect(h.remote).not.toHaveBeenCalled();
  });
  it("rejects wrong identity and malformed events without copying payloads",()=> {
    expect(acceptsConfiguration(session,policy)).toBe(true);
    expect(acceptsConfiguration({...session,model:"gpt-live-1"},policy)).toBe(false);
    expect(()=>parseRealtimeEvent('{"type":"conversation.item.input_audio_transcription.delta","item_id":1}')).toThrow("invalid_transcription");
    expect(parseRealtimeEvent('{"type":"error","error":{"message":"SECRET"}}')).toEqual({type:"error"});
    expect(()=>parseRealtimeEvent('{"type":"input_audio_buffer.speech_started","item_id":"a","audio_start_ms":{"transcript":"SECRET"}}')).toThrow("invalid_audio_clock");
    expect(()=>parseRealtimeEvent('{"type":"response.done","response":{"id":"PRIVATE SPEECH"}}')).toThrow("invalid_response");
  });
});
