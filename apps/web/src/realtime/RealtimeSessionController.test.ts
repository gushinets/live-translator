import { afterEach,describe,expect,it,vi } from "vitest";
import { RealtimeSessionController } from "./RealtimeSessionController";
import type { RealtimeEvent,RealtimePolicy } from "./RealtimeEvents";
import type { RealtimeTransport } from "./RealtimeClient";
import type { RealtimeAudioOutput } from "./RealtimePlayback";
const policy:RealtimePolicy={enabled:true,model:"gpt-realtime-2.1",transcriptionModel:"gpt-4o-transcribe",promptVersion:"v1",schemaVersion:1,maxSessionMs:900000,
  vad:{type:"server_vad",threshold:.5,prefix_padding_ms:300,silence_duration_ms:700,create_response:false,interrupt_response:false}};
function harness(options:{connect?:()=>Promise<void>;capture?:()=>Promise<void>}={}) {
  vi.useFakeTimers();
  const transport:RealtimeTransport={onEvent:null,onFailure:null,connect:vi.fn(options.connect??(async()=>{})),send:vi.fn(),
    close:vi.fn(async()=>({state:"closed",closeConfirmed:true})),reportUsage:vi.fn(async()=>{})};
  const output:RealtimeAudioOutput={onStarted:null,onDrained:null,onFailure:null,pendingSamples:100,
    prime:vi.fn(async()=>{}),attach:vi.fn(async()=>{}),begin:vi.fn(),hold:vi.fn(),seal:vi.fn(),dispose:vi.fn()};
  const track={enabled:true,stop:vi.fn()};
  const capture={onCaptureEnded:null,startCapture:vi.fn(options.capture??(async()=>{})),getCaptureStream:()=>({getAudioTracks:()=>[track]}) as unknown as MediaStream,
    setCaptureEnabled:vi.fn((value:boolean)=>{track.enabled=value;}),dispose:vi.fn()};
  const controller=new RealtimeSessionController(policy,{createTransport:()=>transport,createOutput:()=>output,createCapture:()=>capture,mediaTailMs:1000});
  const emit=(e:RealtimeEvent)=>transport.onEvent?.(e);
  const commit=(id:string)=>emit({type:"input_audio_buffer.committed",item_id:id});
  const text=(id:string,value:string,final=true)=>emit(final?{type:"conversation.item.input_audio_transcription.completed",item_id:id,content_index:0,transcript:value}:
    {type:"conversation.item.input_audio_transcription.delta",item_id:id,content_index:0,delta:value});
  const speech=(id:string,active:boolean)=>emit({type:active?"input_audio_buffer.speech_started":"input_audio_buffer.speech_stopped",item_id:id});
  function response(id:string,status="completed",value="Hello") {
    const request=vi.mocked(transport.send).mock.calls.at(-1)?.[0] as {response:{metadata:Record<string,string>}};
    emit({type:"response.created",response:{id,metadata:request.response.metadata}});
    emit({type:"response.output_audio_transcript.delta",response_id:id,item_id:`out_${id}`,content_index:0,delta:"partial"});
    emit({type:"response.done",response:{id,metadata:request.response.metadata,status,
      output:[{id:`out_${id}`,content:[{type:"audio",transcript:value}]}],usage:{total_tokens:3,input_tokens:2,output_tokens:1,transcript:"secret"}}});
    return request.response.metadata;
  }
  async function start(){await controller.startWithLanguages({A:"ru",B:"en"});}
  async function tick(){await vi.advanceTimersByTimeAsync(1);}
  function drain(id:string) {output.onDrained?.(controller.items.get(id)!.requestId!);}
  return {controller,transport,output,capture,emit,commit,text,speech,response,start,tick,drain};
}
afterEach(()=>{vi.clearAllTimers();vi.useRealTimers();});
describe("Realtime serialized conversation",()=> {
  it("never reports an active attempt closed, records final-only output and terminal interruption",async()=> {
    const h=harness();await h.start();expect(h.controller.exportDiagnostics().cleanup).toEqual({state:"active",closeConfirmed:false});
    h.commit("a");await h.tick();
    const request=vi.mocked(h.transport.send).mock.calls[0]![0] as {response:{metadata:Record<string,string>}};
    h.emit({type:"response.done",response:{id:"r1",metadata:request.response.metadata,status:"completed",output:[{id:"out",content:[{transcript:"Hello"}]}]}});
    expect(h.controller.exportDiagnostics().events.some(e=>e.name==="first_output_text")).toBe(true);
    await h.controller.endConversation();expect(h.controller.items.get("a")!.requestState).toBe("unknown");
    expect(h.controller.exportDiagnostics().events.at(-1)).toMatchObject({state:"idle"});
  });
  it("rejects a start already in the background without opening resources",async()=> {
    const h=harness();vi.spyOn(document,"visibilityState","get").mockReturnValue("hidden");
    await expect(h.start()).rejects.toThrow("page_hidden");expect(h.capture.startCapture).not.toHaveBeenCalled();
    vi.restoreAllMocks();
  });
  it("session.created during startup does not strand the first committed item",async()=> {
    const h=harness();vi.mocked(h.transport.connect).mockImplementation(async()=> {
      h.emit({type:"session.created",session:{model:policy.model}});
    });
    await h.start();h.commit("a");await h.tick();expect(h.transport.send).toHaveBeenCalledTimes(1);await h.controller.endConversation();
  });
  it("deduplicates Start and never starts a second attempt",async()=> {
    const h=harness();const first=h.controller.startWithLanguages({A:"ru",B:"en"});
    expect(h.controller.startWithLanguages({A:"ru",B:"en"})).toBe(first);await first;
    expect(h.transport.connect).toHaveBeenCalledTimes(1);await h.controller.endConversation();
  });
  it("waits for commit, rechecks a speech race, and deduplicates commit",async()=> {
    const h=harness();await h.start();h.speech("a",true);h.speech("a",false);await h.tick();expect(h.transport.send).not.toHaveBeenCalled();
    h.commit("a");h.commit("a");h.speech("b",true);await h.tick();expect(h.transport.send).not.toHaveBeenCalled();
    h.speech("b",false);h.commit("b");await h.tick();expect(h.transport.send).toHaveBeenCalledTimes(1);
    expect(h.transport.send).toHaveBeenCalledWith(expect.objectContaining({type:"response.create",response:expect.objectContaining({conversation:"none",input:[{type:"item_reference",id:"a"}]})}));
    await h.controller.endConversation();
  });
  it("does not copy late/out-of-order or completed-after-delta transcripts between inputs",async()=> {
    const h=harness();await h.start();h.commit("a");h.commit("b");h.text("b","Good morning everyone");h.text("a","Спасибо",false);h.text("a","Спасибо, это очень удобно.");
    h.text("a","ignored late delta",false);
    expect(h.controller.items.get("a")?.turn.originalText).toBe("Спасибо, это очень удобно.");
    expect(h.controller.items.get("b")?.turn.originalText).toBe("Good morning everyone");
    expect(h.controller.items.get("a")?.turn.speaker).toBe("A");expect(h.controller.items.get("b")?.turn.speaker).toBe("B");
    await h.controller.endConversation();
  });
  it("leaves ambiguous short/mixed sources unresolved and never alternates directions",async()=> {
    const h=harness();await h.start();for(const id of ["a","b","c","d"]){h.commit(id);}
    h.text("a","Спасибо, это очень удобно.");h.text("b","Пожалуйста, приходите ещё завтра.");h.text("c","OK");h.text("d","Hello да");
    expect(h.controller.items.get("a")?.turn.speaker).toBe("A");expect(h.controller.items.get("b")?.turn.speaker).toBe("A");
    expect(h.controller.items.get("c")?.turn.speaker).toBeUndefined();expect(h.controller.items.get("d")?.turn.speaker).toBeUndefined();
    await h.controller.endConversation();
  });
  it("preserves hold, waits for generation + buffer stopped + actual drain",async()=> {
    const h=harness();await h.start();h.commit("a");await h.tick();h.response("r1");
    h.output.onStarted?.(h.controller.items.get("a")!.requestId!);
    h.speech("b",true);expect(h.output.hold).toHaveBeenLastCalledWith(true);h.commit("b");await h.tick();expect(h.transport.send).toHaveBeenCalledTimes(1);
    h.speech("b",false);expect(h.output.hold).toHaveBeenLastCalledWith(false);
    expect(h.transport.send).toHaveBeenCalledTimes(1);expect(h.output.dispose).not.toHaveBeenCalled();
    h.emit({type:"output_audio_buffer.stopped",response_id:"r1"});await vi.advanceTimersByTimeAsync(1001);
    expect(h.output.seal).toHaveBeenCalledTimes(1);expect(h.transport.send).toHaveBeenCalledTimes(1);
    h.drain("a");await h.tick();expect(h.transport.send).toHaveBeenCalledTimes(2);
    expect(h.controller.items.get("a")?.requestState).toBe("completed");await h.controller.endConversation();
  });
  it("does not finish when drain precedes response.done",async()=> {
    const h=harness();await h.start();h.commit("a");h.commit("b");await h.tick();
    const meta=h.response("r1");h.emit({type:"output_audio_buffer.stopped",response_id:"r1"});
    h.controller.items.get("a")!.generationDone=false;h.drain("a");await h.tick();expect(h.transport.send).toHaveBeenCalledTimes(1);
    h.emit({type:"response.done",response:{id:"r1",metadata:meta,status:"completed",output:[{id:"out_r1",content:[{transcript:"Hello"}]}]}});
    await h.tick();expect(h.transport.send).toHaveBeenCalledTimes(2);await h.controller.endConversation();
  });
  it("fails a mismatched response and sanitizes diagnostics/usage",async()=> {
    const h=harness();await h.start();h.commit("a");h.text("a","SECRET CONVERSATION TEXT");await h.tick();h.response("r1");
    const json=JSON.stringify(h.controller.exportDiagnostics());expect(json).not.toContain("SECRET");expect(json).not.toContain("partial");expect(json).not.toContain('"transcript":');
    h.emit({type:"response.created",response:{id:"alien",metadata:{request_id:"wrong"}}});
    await Promise.resolve();await Promise.resolve();expect(h.transport.close).toHaveBeenCalledTimes(1);
  });
  it.each(["failed","incomplete","cancelled"])("does not mark %s responses completed",async status=> {
    const h=harness();await h.start();h.commit("a");await h.tick();h.response("r1",status);await Promise.resolve();
    expect(h.controller.items.get("a")?.requestState).toBe("failed");expect(h.transport.close).toHaveBeenCalledTimes(1);
  });
  it("keeps transcription failure on its own source",async()=> {
    const h=harness();await h.start();h.commit("a");h.commit("b");h.text("b","Good morning everyone");
    h.emit({type:"conversation.item.input_audio_transcription.failed",item_id:"a",content_index:0});
    expect(h.controller.captionBlocks.find(b=>b.id.includes(":a:input"))?.text).toBe("Исходный текст недоступен");
    expect(h.controller.exportDiagnostics().events.filter(e=>e.name==="first_source_text").map(e=>e.itemId)).toEqual(["b"]);
    h.text("c","partial",false);h.emit({type:"conversation.item.input_audio_transcription.failed",item_id:"c",content_index:0});
    expect(h.controller.captionBlocks.find(b=>b.id.includes(":c:input"))?.text).toContain("не подтверждён");
    expect(h.controller.items.get("b")?.turn.originalText).toBe("Good morning everyone");await h.controller.endConversation();
  });
  it("Cancel retires pending capture; late capture never connects",async()=> {
    let finish!:()=>void;const h=harness({capture:()=>new Promise<void>(resolve=>{finish=resolve;})});
    const start=h.controller.startWithLanguages({A:"ru",B:"en"});await h.controller.cancel();await start;finish();await Promise.resolve();
    expect(h.transport.connect).not.toHaveBeenCalled();expect(h.capture.dispose).toHaveBeenCalled();expect(h.controller.session.state).toBe("idle");
  });
  it("Cancel and old callbacks cannot affect the next generation",async()=> {
    const h=harness();await h.start();const old=h.transport.onEvent;await h.controller.endConversation();await h.start();
    old?.({type:"input_audio_buffer.committed",item_id:"old"});expect(h.controller.items.has("old")).toBe(false);await h.controller.endConversation();
  });
  it("bounds source queue and response wait without retries",async()=> {
    const h=harness();await h.start();h.commit("a");await h.tick();await vi.advanceTimersByTimeAsync(90001);
    expect(h.controller.items.get("a")?.requestState).toBe("unknown");expect(h.transport.send).toHaveBeenCalledTimes(1);expect(h.transport.close).toHaveBeenCalledTimes(1);
  });
  it("ends on hidden and never auto-resumes",async()=> {
    const h=harness();h.controller.start();await h.start();
    vi.spyOn(document,"visibilityState","get").mockReturnValue("hidden");document.dispatchEvent(new Event("visibilitychange"));
    await h.controller.endConversation();document.dispatchEvent(new Event("visibilitychange"));
    expect(h.transport.connect).toHaveBeenCalledTimes(1);expect(h.controller.session.state).toBe("idle");await h.controller.dispose();vi.restoreAllMocks();
  });
  it("rejects unsupported pairs without opening media",async()=> {
    const h=harness();await expect(h.controller.startWithLanguages({A:"ru",B:"de"})).rejects.toThrow("unsupported_languages");
    expect(h.capture.startCapture).not.toHaveBeenCalled();
  });
});
