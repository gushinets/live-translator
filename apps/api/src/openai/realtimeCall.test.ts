import { describe,expect,it,vi } from "vitest";
import OpenAI from "openai";
import { makeRealtimeProvider,realtimeConfiguration } from "./realtimeCall.js";
describe("Realtime GA Calls adapter",()=> {
  it("uses the installed SDK multipart call and Location ID with no hidden fallback",async()=> {
    const create=vi.fn(async()=>new Response("answer",{status:201,headers:{location:"/v1/realtime/calls/rtc_fixture"}}));
    const hangup=vi.fn(async()=>{});const provider=makeRealtimeProvider({realtime:{calls:{create,hangup}}} as unknown as OpenAI);
    const signal=new AbortController().signal;expect(await provider.create("offer",signal,vi.fn())).toEqual({callId:"rtc_fixture",sdp:"answer"});
    expect(create).toHaveBeenCalledWith({sdp:"offer",session:realtimeConfiguration()},{signal});await provider.close("rtc_fixture",signal);
    expect(hangup).toHaveBeenCalledWith("rtc_fixture",{signal});
    const config=realtimeConfiguration();expect(config.model).toBe("gpt-realtime-2.1");expect(config.output_modalities).toEqual(["audio"]);
    expect(config.audio?.input?.turn_detection).toMatchObject({create_response:false,interrupt_response:false,type:"server_vad"});
    expect(config.audio?.input?.transcription).not.toHaveProperty("language");expect(config.tools).toEqual([]);
  });
});
