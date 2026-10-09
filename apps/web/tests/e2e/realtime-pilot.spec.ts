import { expect,test,type Page } from "@playwright/test";
import { MockLiveHarness } from "./mockLiveHarness";
import type { RealtimeEvent } from "../../src/realtime/RealtimeEvents";
declare global {
  interface Window {
    __realtimeTest:{sent:Array<{type:string;response:{metadata:Record<string,string>;input:unknown[]}}>;
      holds:boolean[];captures:number;peerCreates:number;emit(event:unknown):void;drain():void;started():void};
  }
}
const policy={enabled:true,model:"gpt-realtime-2.1",transcriptionModel:"gpt-4o-transcribe",promptVersion:"realtime-translation-v1",schemaVersion:1,maxSessionMs:900000,
  instructions:"Translate only",transcriptionPrompt:"Russian and English",maxOutputTokens:4096,
  vad:{type:"server_vad",threshold:.5,prefix_padding_ms:300,silence_duration_ms:700,create_response:false,interrupt_response:false}};
async function setup(page:Page,enabled=true) {
  const live=await MockLiveHarness.attach(page);
  await page.addInitScript(({policy})=> {
    localStorage.setItem("live-translator-owner-language","ru");localStorage.setItem("live-translator-interlocutor-language","en");
    const OriginalContext=window.AudioContext,OriginalPeer=window.RTCPeerConnection;
    const mediaStreams=new WeakMap<HTMLMediaElement,unknown>();
    Object.defineProperty(HTMLMediaElement.prototype,"srcObject",{configurable:true,
      get(){return mediaStreams.get(this)??null;},set(value){mediaStreams.set(this,value);}});
    let channel:{onmessage:((event:{data:string})=>void)|null}|undefined;
    let outputPort:((event:{data:unknown})=>void)|null=null,requestId="";
    const state:Window["__realtimeTest"]={sent:[],holds:[],captures:0,peerCreates:0,
      emit:event=>channel?.onmessage?.({data:JSON.stringify(event)}),
      drain:()=>outputPort?.({data:{type:"drained",responseId:requestId}}),started:()=>outputPort?.({data:{type:"nonzero_pcm_rendered",responseId:requestId}})};
    window.__realtimeTest=state;
    const originalCapture=navigator.mediaDevices.getUserMedia.bind(navigator.mediaDevices);
    navigator.mediaDevices.getUserMedia=async constraints=>{state.captures++;return originalCapture(constraints);};
    class Context extends OriginalContext {
      audioWorklet={addModule:async()=>{}} as unknown as AudioWorklet;
      destination=this.createAnalyser() as unknown as AudioDestinationNode;
    }
    class Worklet {
      onprocessorerror=null;
      port={onmessage:null as ((event:{data:unknown})=>void)|null,
        postMessage:(data:{type:string;responseId?:string;value?:boolean})=> {
          if(data.type==="begin"){requestId=data.responseId!;outputPort=this.port.onmessage;}
          if(data.type==="hold")state.holds.push(data.value===true);
        },close:()=>{}};
      connect(){return this;}disconnect(){}
    }
    class Channel {
      readyState="open";onmessage:((event:{data:string})=>void)|null=null;onclose=null;onerror=null;
      send(raw:string){state.sent.push(JSON.parse(raw));}
      close(){this.readyState="closed";}
    }
    class Peer extends OriginalPeer {
      ontrack:((event:{track:{kind:string};streams:MediaStream[]})=>void)|null=null;
      private realtimeChannel:Channel|undefined;
      createDataChannel():RTCDataChannel {
        this.realtimeChannel=new Channel();channel=this.realtimeChannel;state.peerCreates++;
        return this.realtimeChannel as unknown as RTCDataChannel;
      }
      addTrack(track:MediaStreamTrack):RTCRtpSender {if(track.enabled)throw new Error("input_enabled_before_configuration");return {} as RTCRtpSender;}
      async setRemoteDescription(description:RTCSessionDescriptionInit) {
        if(description.sdp!=="mock-realtime-answer")return super.setRemoteDescription(description);
        this.ontrack?.({track:{kind:"audio"},streams:[await originalCapture({audio:true})]});
        queueMicrotask(()=>state.emit({type:"session.created",session:{type:"realtime",instructions:policy.instructions,tools:[],max_output_tokens:policy.maxOutputTokens,model:policy.model,output_modalities:["audio"],
          audio:{input:{transcription:{model:policy.transcriptionModel,prompt:policy.transcriptionPrompt},turn_detection:policy.vad},output:{voice:"marin"}}}}));
      }
    }
    Object.defineProperty(window,"AudioContext",{configurable:true,value:Context});
    Object.defineProperty(window,"AudioWorkletNode",{configurable:true,value:Worklet});
    Object.defineProperty(window,"RTCPeerConnection",{configurable:true,value:Peer});
  },{policy});
  await page.route("**/api/policy",route=>route.fulfill({json:{usageLedgerEnabled:false,realtime:{...policy,enabled}}}));
  await page.route("**/api/realtime/identity",route=>route.fulfill({status:201,json:{admissionToken:"mock-ticket"}}));
  await page.route("**/api/realtime/session/*/cleanup",route=>route.fulfill({json:{state:"closed",closeConfirmed:true}}));
  await page.route("**/api/realtime/session/*/usage",route=>route.fulfill({status:204}));
  await page.route("**/api/realtime/session/*/handoff",route=>route.fulfill({status:204}));
  await page.route("**/api/realtime/session",route=>route.fulfill({status:201,json:{attemptId:route.request().postDataJSON().attemptId,
    sdp:"mock-realtime-answer",expiresAt:Date.now()+900000}}));
  return live;
}
async function emit(page:Page,event:RealtimeEvent) {await page.evaluate(e=>window.__realtimeTest.emit(e),event);}
async function reply(page:Page,id:string,text:string) {
  const metadata=await page.evaluate(()=>window.__realtimeTest.sent.at(-1)!.response.metadata);
  await emit(page,{type:"response.created",response:{id,metadata}});
  await emit(page,{type:"response.output_audio_transcript.delta",response_id:id,item_id:`out_${id}`,content_index:0,delta:text});
  await emit(page,{type:"response.done",response:{id,metadata,status:"completed",output:[{id:`out_${id}`,content:[{transcript:text}]}]}});
  await emit(page,{type:"output_audio_buffer.stopped",response_id:id});
}
test("server-off setup keeps Live and hides Realtime",async({page})=> {
  await setup(page,false);await page.goto("/");await expect(page.getByRole("combobox",{name:"Режим перевода"})).toHaveCount(0);
  await expect(page.getByRole("button",{name:"Начать перевод"})).toBeVisible();
  expect(await page.evaluate(()=>window.__realtimeTest.captures)).toBe(0);
});
test("product Realtime translates correlated items, holds, drains and ends",async({page},testInfo)=> {
  await setup(page);const errors:string[]=[];page.on("pageerror",error=>errors.push(error.message));await page.goto("/");
  const select=page.getByRole("combobox",{name:"Режим перевода"});await select.selectOption("realtime");await expect(select).toHaveValue("realtime");
  await page.getByRole("button",{name:"Настройки",exact:true}).click();
  const diagnostics=page.locator(".setup-card .realtime-diagnostics");await expect(diagnostics).toBeVisible();
  expect((await diagnostics.boundingBox())!.height).toBeLessThan(80);
  await expect(page.getByRole("heading",{name:"Язык собеседника"})).toBeInViewport();
  await page.getByRole("button",{name:"Закрыть настройки",exact:true}).click();
  await expect(page.getByRole("button",{name:"Начать перевод"})).toBeEnabled();
  await page.getByRole("button",{name:"Начать перевод"}).click();await expect(page.getByRole("button",{name:"Завершить",exact:true})).toBeVisible();
  await expect(page.getByRole("button",{name:"Не перебивать"})).toHaveCount(0);
  await expect(page.getByRole("button",{name:"Язык собеседника"})).toHaveCount(0);
  await expect(page.locator(".conversation-engine")).toContainText("gpt-realtime-2.1");
  await emit(page,{type:"input_audio_buffer.speech_started",item_id:"ru1"});
  await emit(page,{type:"input_audio_buffer.speech_stopped",item_id:"ru1"});
  await page.clock.fastForward(10);expect(await page.evaluate(()=>window.__realtimeTest.sent.length)).toBe(0);
  await emit(page,{type:"input_audio_buffer.committed",item_id:"ru1"});
  await emit(page,{type:"conversation.item.input_audio_transcription.completed",item_id:"ru1",content_index:0,transcript:"Спасибо, это очень удобно."});
  await page.clock.fastForward(10);await reply(page,"r1","Thank you, this is very convenient.");
  await page.evaluate(()=>window.__realtimeTest.started());
  await emit(page,{type:"input_audio_buffer.speech_started",item_id:"en2"});await expect(page.locator(".conversation-engine")).toContainText("удержан");
  await emit(page,{type:"input_audio_buffer.speech_stopped",item_id:"en2"});
  await emit(page,{type:"input_audio_buffer.committed",item_id:"en2"});
  await emit(page,{type:"conversation.item.input_audio_transcription.completed",item_id:"en2",content_index:0,transcript:"Good morning everyone"});
  await page.clock.fastForward(1100);expect(await page.evaluate(()=>window.__realtimeTest.sent.length)).toBe(1);
  await page.evaluate(()=>window.__realtimeTest.drain());await page.clock.fastForward(10);await reply(page,"r2","Всем доброе утро.");
  await expect(page.getByTestId("participant-pane-A")).toContainText("Спасибо, это очень удобно.");
  await expect(page.getByTestId("participant-pane-B")).toContainText("Thank you, this is very convenient.");
  await expect(page.getByTestId("participant-pane-A")).toContainText("Всем доброе утро.");
  await page.screenshot({path:testInfo.outputPath("realtime-product-mock.png"),fullPage:true});
  await page.getByRole("button",{name:"Завершить",exact:true}).click();await expect(select).toBeVisible();
  expect(await page.evaluate(()=>window.__realtimeTest.peerCreates)).toBe(1);expect(await page.evaluate(()=>window.__realtimeTest.captures)).toBe(1);
  expect(errors).toEqual([]);
  await select.selectOption("live");await expect(select).toHaveValue("live");
});
test("cancel during connect ignores late SDP and permits a new conversation",async({page})=> {
  await setup(page);let finish!:()=>void;
  await page.route("**/api/realtime/session",async route=>{await new Promise<void>(resolve=>{finish=resolve;});await route.fulfill({status:201,json:{attemptId:route.request().postDataJSON().attemptId,sdp:"mock-realtime-answer",expiresAt:0}}).catch(()=>{});});
  await page.goto("/");await page.getByRole("combobox",{name:"Режим перевода"}).selectOption("realtime");
  await page.getByRole("button",{name:"Начать перевод"}).click();await expect.poll(()=>!!finish).toBe(true);
  await page.getByRole("button",{name:"Отмена"}).click();finish();
  await expect(page.getByRole("button",{name:"Начать перевод"})).toBeEnabled();await expect(page.locator(".conversation-screen")).toHaveCount(0);
});
