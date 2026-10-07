import { randomUUID } from "node:crypto";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import OpenAI from "openai";
import { RealtimeAttempts, openRealtimeDatabase } from "../src/accounting/RealtimeAttempts.js";
import { SessionLeaseRegistry } from "../src/security/SessionLeaseRegistry.js";
import { makeRealtimeProvider } from "../src/openai/realtimeCall.js";
import { once } from "node:events";
import express from "express";
import { startApiServer } from "../src/serverLifecycle.js";
import { LedgerRuntime } from "../src/accounting/LedgerRuntime.js";
import { UsageLedger } from "../src/accounting/UsageLedger.js";
import { openUsageDatabase } from "../src/persistence/database.js";
import { createLiveSessionRouter } from "../src/routes/liveSession.js";
import request from "supertest";

const runtimes: RealtimeAttempts[] = [];
const directories: string[] = [];
function admit(runtime:RealtimeAttempts,owner:string,id:string) {
  return runtime.create(owner,id,1,"offer",()=>false,runtime.prepare(owner,id,1).admissionToken);
}
afterEach(async () => {
  for (const runtime of runtimes.splice(0)) {
    await runtime.shutdown();
    if (runtime.db.isOpen) runtime.db.close();
  }
  for (const directory of directories.splice(0)) rmSync(directory, { recursive: true, force: true });
  vi.restoreAllMocks();
  vi.useRealTimers();vi.unstubAllEnvs();
});
describe("PR36 real adapter and durable reservation regressions", () => {
  it.each(["", "   ", "\t\r\n"])("rejects blank database path %j before SQLite opens", (path) => {
    expect(() => openRealtimeDatabase(path)).toThrow("Invalid realtime database path");
  });
  it("keeps :memory: databases isolated", () => {
    const first = new RealtimeAttempts(openRealtimeDatabase(":memory:"), new SessionLeaseRegistry(1, 10), { startWorker: false });
    const second = new RealtimeAttempts(openRealtimeDatabase(":memory:"), new SessionLeaseRegistry(1, 10), { startWorker: false });
    runtimes.push(first, second);
    const id = randomUUID(); first.prepare(randomUUID(), id, 1);
    expect(first.db.prepare("SELECT id FROM realtime_attempts").get()!.id).toBe(id);
    expect(second.db.prepare("SELECT id FROM realtime_attempts").get()).toBeUndefined();
  });
  it("preserves a Realtime attempt and usage after closing and reopening a file database", async () => {
    const directory = mkdtempSync(join(tmpdir(), "realtime-path-")); directories.push(directory);
    const path = join(directory, "nested", "pilot.sqlite"), owner = randomUUID(), id = randomUUID();
    const options = { startWorker: false, create: async () => ({ callId: "rtc_persisted", sdp: "answer" }), close: async () => {} };
    const first = new RealtimeAttempts(openRealtimeDatabase(path), new SessionLeaseRegistry(1, 10), options); runtimes.push(first);
    await admit(first, owner, id);
    first.recordUsage(owner, id, { operation: "response", responseId: "persisted", usage: { total_tokens: 3 } });
    await first.shutdown(); first.db.close(); runtimes.pop();
    const second = new RealtimeAttempts(openRealtimeDatabase(path), new SessionLeaseRegistry(1, 10), options); runtimes.push(second);
    expect(second.owned(owner, id)).toMatchObject({ id, owner, generation: 1, call_id: "rtc_persisted", state: "closed", close_confirmed: 1 });
    expect(second.db.prepare("SELECT usage_json FROM realtime_usage WHERE attempt_id=?").get(id)!.usage_json).toBe('{"total_tokens":3}');
    expect(second.db.prepare("PRAGMA journal_mode").get()!.journal_mode).toBe("wal");
    expect(second.db.prepare("PRAGMA synchronous").get()!.synchronous).toBe(2);
    expect(second.db.prepare("PRAGMA integrity_check").get()!.integrity_check).toBe("ok");
  });
  it("migrates legacy usage additively and keeps old tombstone observations during pruning",async()=> {
    let now=Date.now();const db=openUsageDatabase(":memory:"),registry=new SessionLeaseRegistry(1,10),owner=randomUUID(),id=randomUUID();
    const options={startWorker:false,now:()=>now,close:async()=>{}};
    let runtime=new RealtimeAttempts(db,registry,options);runtimes.push(runtime);
    runtime.prepare(owner,id,1);await runtime.cleanup(owner,id);
    db.prepare("INSERT INTO realtime_response_usage(attempt_id,response_id,usage_json,received_at) VALUES(?,?,?,?)").run(id,"legacy",'{"total_tokens":3}',now);
    await runtime.shutdown();runtimes.pop();runtime=new RealtimeAttempts(db,registry,options);runtimes.push(runtime);
    now+=60001;await runtime.sweep();
    expect(db.prepare("SELECT usage_json FROM realtime_response_usage").get()!.usage_json).toBe('{"total_tokens":3}');
    expect(db.prepare("SELECT operation,model,source FROM realtime_usage").get()).toMatchObject({operation:"response",model:"gpt-realtime-2.1",source:"browser"});
    expect(db.prepare("PRAGMA foreign_key_check").all()).toEqual([]);expect(db.prepare("PRAGMA integrity_check").get()!.integrity_check).toBe("ok");
  });
  it("shares durable expired Realtime capacity with Live in the ledger runtime",async()=> {
    vi.useFakeTimers({toFake:["Date"]});const initial=Date.now();
    const db=openUsageDatabase(":memory:"),ledger=new UsageLedger(db),holder:{runtime?:RealtimeAttempts}={};
    const live=new LedgerRuntime(ledger,{maxConcurrent:1,startWorker:false,additionalReservations:()=>holder.runtime?.reservations()??[],
      creator:async()=>({session:{id:"live_1"},transport:{type:"webrtc",sdp:"answer"}}),closeOrphan:async()=>({kind:"retryable_error",code:"mock"})});
    const realtime=new RealtimeAttempts(db,live.registry,{create:async()=>({callId:"rtc_shared",sdp:"answer"}),close:async()=>{throw new Error("404");},syncAdmission:()=>live.syncAdmission(),startWorker:false});
    holder.runtime=realtime;
    runtimes.push(realtime);
    try {
      await admit(realtime,randomUUID(),randomUUID());vi.setSystemTime(initial+3_600_001);await realtime.sweep();live.syncAdmission();
      const owner=randomUUID(),c=ledger.createConversation(owner,randomUUID(),"test");
      await expect(live.create(owner,{conversationId:c.id,conversationVersion:c.version,liveSessionId:randomUUID(),initialMode:"setup",startReason:"initial",fingerprint:"test"},"offer",()=>false)).rejects.toThrow("concurrent_session_limit");
      expect(live.registry.activeLeases).toBe(1);
    } finally {await live.shutdown({drainMs:0,timeoutMs:100});}
  });
  it("shares reservations both ways with the real legacy Live route",async()=> {
    vi.useFakeTimers({toFake:["Date"]});const initial=Date.now();
    vi.stubEnv("OPENAI_API_KEY","mock");const registry=new SessionLeaseRegistry(1,10),db=openRealtimeDatabase(":memory:");
    const close=vi.fn(async():Promise<void>=>{throw new Error("404");}),realtime=new RealtimeAttempts(db,registry,{create:async()=>({callId:"rtc_legacy",sdp:"answer"}),close,startWorker:false});
    runtimes.push(realtime);
    const a=express();a.use(express.json());a.use("/api/live/session",createLiveSessionRouter({leaseRegistry:registry,webOrigin:"http://localhost:5173",createLiveSession:async()=>({session:{id:"live_legacy"},transport:{type:"webrtc",sdp:"answer"}})}));
    await request(a).post("/api/live/session").set("Origin","http://localhost:5173").send({sdp:"offer"}).expect(201);
    expect(()=>admit(realtime,randomUUID(),randomUUID())).toThrow("concurrent_session_limit");
    await request(a).delete("/api/live/session/live_legacy").set("Origin","http://localhost:5173").expect(204);
    const owner=randomUUID(),id=randomUUID();await admit(realtime,owner,id);vi.setSystemTime(initial+3_600_001);await realtime.sweep();
    await request(a).post("/api/live/session").set("Origin","http://localhost:5173").send({sdp:"offer"}).expect(429);
    close.mockResolvedValueOnce(undefined);await realtime.cleanup(owner,id);
    await request(a).post("/api/live/session").set("Origin","http://localhost:5173").send({sdp:"offer"}).expect(201);
  });
  it("retains an unknown create with no ID across expiry and restart",async()=> {
    let now=Date.now();const registry=new SessionLeaseRegistry(1,10),db=openRealtimeDatabase(":memory:");
    const options={create:async()=>{throw new Error("timeout");},close:async()=>{},startWorker:false,now:()=>now};
    let runtime=new RealtimeAttempts(db,registry,options);runtimes.push(runtime);const owner=randomUUID(),id=randomUUID();
    await expect(admit(runtime,owner,id)).rejects.toThrow();now+=3_600_001;await runtime.sweep();
    const reservations=runtime.reservations();expect(reservations).toHaveLength(1);await runtime.shutdown();runtimes.pop();
    runtime=new RealtimeAttempts(db,registry,options);runtimes.push(runtime);registry.restoreReservations(runtime.reservations(),now);
    expect(runtime.reservations()).toEqual(reservations);expect(registry.acquire(now)).toBeNull();
    expect(()=>admit(runtime,owner,randomUUID())).toThrow("attempt_in_progress");
  });
  function fixture(options:ConstructorParameters<typeof RealtimeAttempts>[2]={}) {
    const registry=new SessionLeaseRegistry(1,10),db=openRealtimeDatabase(":memory:");
    const runtime=new RealtimeAttempts(db,registry,{create:async()=>({callId:"rtc_test",sdp:"answer"}),close:async()=>{},startWorker:false,...options});
    runtimes.push(runtime);return {runtime,registry,db,owner:randomUUID(),id:randomUUID()};
  }
  it("does not confirm closure on a 4xx error after a call ID is known and hangup fails", async () => {
    const close = vi.fn(async () => { throw new Error("hangup unavailable"); });
    const f = fixture({ create: async (_sdp, _signal, remember) => {
      remember("rtc_known_4xx"); throw new OpenAI.APIError(400, undefined, "body error", new Headers());
    }, close });
    await expect(admit(f.runtime, f.owner, f.id)).rejects.toThrow("realtime_provider_unavailable");
    expect(f.runtime.owned(f.owner, f.id)).toMatchObject({ call_id: "rtc_known_4xx", state: "unknown", close_confirmed: 0 });
    expect(f.runtime.reservations()).toHaveLength(1); expect(f.registry.activeLeases).toBe(1);
    expect(close).toHaveBeenCalledWith("rtc_known_4xx", expect.any(AbortSignal));
  });
  it("writes the handoff timestamp once and preserves lifecycle validation on replay", async () => {
    let now = Date.now(); const f = fixture({ now: () => now });
    await admit(f.runtime, f.owner, f.id);
    const before = Number(f.db.prepare("SELECT total_changes() AS n").get()!.n);
    f.runtime.handoff(f.owner, f.id);
    const timestamp = f.runtime.owned(f.owner, f.id).handoff_at;
    now += 1;
    f.runtime.handoff(f.owner, f.id);
    expect(f.runtime.owned(f.owner, f.id).handoff_at).toBe(timestamp);
    expect(Number(f.db.prepare("SELECT total_changes() AS n").get()!.n) - before).toBe(1);
    expect(() => f.runtime.handoff(randomUUID(), f.id)).toThrow("not_found");
    await f.runtime.cleanup(f.owner, f.id);
    expect(() => f.runtime.handoff(f.owner, f.id)).toThrow("attempt_not_activatable");
  });
  it("preserves a known ID after failed SDP and failed hangup, then retries it",async()=> {
    const hangup=vi.fn(async():Promise<void>=>{throw new Error("404");});
    const create=vi.fn(async()=>({headers:new Headers({location:"/v1/realtime/calls/rtc_retry"}),text:async()=>{throw new Error("body reset");}}));
    const provider=makeRealtimeProvider({realtime:{calls:{create,hangup}}} as unknown as OpenAI);
    const f=fixture({create:provider.create,close:provider.close});
    await expect(admit(f.runtime,f.owner,f.id)).rejects.toThrow();
    expect(f.runtime.owned(f.owner,f.id)).toMatchObject({call_id:"rtc_retry",close_confirmed:0,state:"unknown"});
    hangup.mockResolvedValueOnce(undefined);await f.runtime.cleanup(f.owner,f.id);
    expect(hangup).toHaveBeenCalledTimes(2);expect(create).toHaveBeenCalledOnce();
    expect(f.runtime.owned(f.owner,f.id).close_confirmed).toBe(1);
  });
  it("Cancel after headers closes the call and rejects late SDP without activation",async()=> {
    let finish!:(sdp:string)=>void;
    const hangup=vi.fn(async()=>{}),provider=makeRealtimeProvider({realtime:{calls:{
      create:async()=>({headers:new Headers({location:"/v1/realtime/calls/rtc_cancel"}),text:()=>new Promise<string>(r=>{finish=r;})}),hangup,
    }}} as unknown as OpenAI);
    const f=fixture({create:provider.create,close:provider.close});
    const work=admit(f.runtime,f.owner,f.id);const rejection=expect(work).rejects.toThrow("attempt_cancelled");
    await vi.waitFor(()=>expect(f.runtime.owned(f.owner,f.id).call_id).toBe("rtc_cancel"));
    await f.runtime.cleanup(f.owner,f.id);finish("late answer");await rejection;
    expect(hangup).toHaveBeenCalledOnce();expect(f.runtime.owned(f.owner,f.id).state).toBe("closed");
    await f.runtime.sweep();expect(f.registry.activeLeases).toBe(0);
  });
  it("keeps the cleanup ID in memory while SQLite writes fail and repairs it",async()=> {
    let now=Date.now();
    const hangup=vi.fn(async():Promise<void>=>{throw new Error("network");});
    const provider=makeRealtimeProvider({realtime:{calls:{create:async()=>({headers:new Headers({location:"/v1/realtime/calls/rtc_storage"}),text:async()=>"answer"}),hangup}}} as unknown as OpenAI);
    const f=fixture({create:provider.create,close:provider.close,now:()=>now}),token=f.runtime.prepare(f.owner,f.id,1).admissionToken;
    const prepare=f.db.prepare.bind(f.db);let broken=true;
    vi.spyOn(f.db,"prepare").mockImplementation(sql=>{if(broken && sql.startsWith("UPDATE realtime_attempts SET call_id="))throw new Error("storage unavailable");return prepare(sql);});
    await expect(f.runtime.create(f.owner,f.id,1,"offer",()=>false,token)).rejects.toThrow();
    expect(hangup).toHaveBeenCalledWith("rtc_storage",expect.any(Object));expect(f.runtime.reservations()).toHaveLength(1);
    broken=false;now+=10001;hangup.mockResolvedValue(undefined);await f.runtime.sweep();
    expect(f.runtime.owned(f.owner,f.id)).toMatchObject({call_id:"rtc_storage",close_confirmed:1});
    expect(f.registry.activeLeases).toBe(0);
  });
  it("drains create before abort so late headers become durable cleanup handles",async()=> {
    let finish!:(value:Response)=>void,signal:AbortSignal|undefined;
    const hangup=vi.fn(async()=>{}),provider=makeRealtimeProvider({realtime:{calls:{create:(_body:unknown,options:{signal:AbortSignal})=>{
      signal=options.signal;return new Promise<Response>(r=>{finish=r;});},hangup}}} as unknown as OpenAI);
    const f=fixture({create:provider.create,close:provider.close});
    const work=admit(f.runtime,f.owner,f.id).catch(error=>error);
    const stopping=f.runtime.shutdown({drainMs:100,timeoutMs:300});expect(signal!.aborted).toBe(false);
    finish(new Response("late",{headers:{location:"/v1/realtime/calls/rtc_drain"}}));await work;await stopping;
    expect(f.runtime.owned(f.owner,f.id)).toMatchObject({call_id:"rtc_drain",close_confirmed:1});expect(hangup).toHaveBeenCalledOnce();
  });
  it("honors the lifecycle absolute budget and never touches closed SQLite from a late create",async()=> {
    let finish!:(value:{callId:string;sdp:string})=>void;
    const close=vi.fn(async()=>{}),f=fixture({create:()=>new Promise(r=>{finish=r;}),close,ownsDb:true});
    const app=express();app.locals.realtimeRuntime=f.runtime;
    const lifecycle=startApiServer(app,{port:0,host:"127.0.0.1",drainMs:500,timeoutMs:40});await once(lifecycle.server,"listening");
    const work=admit(f.runtime,f.owner,f.id).catch(error=>error),start=performance.now();
    await lifecycle.shutdown().catch(()=>undefined);expect(performance.now()-start).toBeLessThan(200);expect(f.db.isOpen).toBe(false);
    finish({callId:"rtc_after_db_close",sdp:"late"});await work;
    expect(close).toHaveBeenCalledWith("rtc_after_db_close",expect.any(Object));
  });
  it("bounds prepared rows and prunes Cancel fences without admitting an old nonce",async()=> {
    let now=Date.now();const f=fixture({now:()=>now}),old=f.runtime.prepare(f.owner,f.id,1);
    await f.runtime.cleanup(f.owner,f.id);now+=60001;await f.runtime.sweep();
    expect(f.db.prepare("SELECT id FROM realtime_attempts WHERE id=?").get(f.id)).toBeUndefined();
    expect(()=>f.runtime.create(f.owner,f.id,1,"offer",()=>false,old.admissionToken)).toThrow("not_found");
    const fresh=f.runtime.prepare(f.owner,f.id,1);
    expect(()=>f.runtime.create(f.owner,f.id,1,"offer",()=>false,old.admissionToken)).toThrow("attempt_not_activatable");
    await f.runtime.create(f.owner,f.id,1,"offer",()=>false,fresh.admissionToken);await f.runtime.cleanup(f.owner,f.id);
    for(let n=0;n<2048;n++)f.runtime.prepare(randomUUID(),randomUUID(),1);
    expect(()=>f.runtime.prepare(randomUUID(),randomUUID(),1)).toThrow("preparation_limit");
    now+=60001;await f.runtime.sweep();expect(f.db.prepare("SELECT COUNT(*) AS n FROM realtime_attempts WHERE call_id IS NULL").get()!.n).toBe(0);
  });
  it("bounds and separates idempotent usage, including observations after owned close",async()=> {
    const f=fixture();f.runtime.prepare(f.owner,f.id,1);
    expect(()=>f.runtime.recordUsage(f.owner,f.id,{operation:"response",responseId:"pre",usage:{}})).toThrow("usage_before_provider_call");
    await f.runtime.cleanup(f.owner,f.id);
    expect(()=>f.runtime.recordUsage(f.owner,f.id,{operation:"response",responseId:"tombstone",usage:{}})).toThrow("usage_before_provider_call");
    const id=randomUUID();await admit(f.runtime,f.owner,id);await f.runtime.cleanup(f.owner,id);
    for(let n=0;n<128;n++)f.runtime.recordUsage(f.owner,id,{operation:"response",responseId:`r${n}`,usage:{total_tokens:3}});
    f.runtime.recordUsage(f.owner,id,{operation:"response",responseId:"r0",usage:{total_tokens:4}});
    expect(()=>f.runtime.recordUsage(f.owner,id,{operation:"response",responseId:"overflow",usage:{}})).toThrow("usage_observation_limit");
    f.runtime.recordUsage(f.owner,id,{operation:"transcription",itemId:"r0",contentIndex:0,usage:{type:"tokens",total_tokens:8}});
    f.runtime.recordUsage(f.owner,id,{operation:"transcription",itemId:"r0",contentIndex:0,usage:{type:"tokens",total_tokens:8}});
    expect(f.db.prepare("SELECT operation,model,source FROM realtime_usage WHERE observation_id='r0' ORDER BY operation").all()).toEqual([
      expect.objectContaining({operation:"response",model:"gpt-realtime-2.1",source:"provider_data_channel_via_browser"}),
      expect.objectContaining({operation:"transcription",model:"gpt-4o-transcribe",source:"provider_data_channel_via_browser"}),
    ]);
    expect(f.db.prepare("SELECT COUNT(*) AS n FROM realtime_usage").get()!.n).toBe(129);
    for(let n=1;n<4096;n++)f.runtime.recordUsage(f.owner,id,{operation:"transcription",itemId:`a${Math.floor(n/32)}`,contentIndex:n%32,usage:{type:"tokens",total_tokens:1}});
    expect(()=>f.runtime.recordUsage(f.owner,id,{operation:"transcription",itemId:"extra",contentIndex:0,usage:{}})).toThrow("usage_observation_limit");
  });
  it("retains the Location call ID and hangs up when the SDP body rejects", async () => {
    const hangup = vi.fn(async () => {});
    const provider = makeRealtimeProvider({ realtime: { calls: {
      create: async () => ({ headers: new Headers({ location: "/v1/realtime/calls/rtc_headers" }),
        text: async () => { throw new Error("body reset"); } }), hangup,
    } } } as unknown as OpenAI);
    const runtime = new RealtimeAttempts(openRealtimeDatabase(":memory:"), new SessionLeaseRegistry(1, 10), {
      create: provider.create, close: provider.close, startWorker: false,
    }); runtimes.push(runtime);
    const owner = randomUUID(), id = randomUUID();
    await expect(admit(runtime, owner, id)).rejects.toThrow();
    expect(hangup).toHaveBeenCalledWith("rtc_headers", expect.any(Object));
    expect(runtime.owned(owner, id)).toMatchObject({ call_id: "rtc_headers", close_confirmed: 1 });
  });
  it("keeps capacity and owner reservation after product deadline and failed hangup", async () => {
    let now = Date.now();
    const registry = new SessionLeaseRegistry(1, 10);
    const close = vi.fn(async ():Promise<void> => { throw new Error("404 is ambiguous"); });
    const db = openRealtimeDatabase(":memory:");
    const options = { create: async () => ({ callId: "rtc_reserved", sdp: "answer" }), close,
      now: () => now, startWorker: false };
    let runtime = new RealtimeAttempts(db, registry, options); runtimes.push(runtime);
    const owner = randomUUID(), id = randomUUID();
    await admit(runtime, owner, id);
    now += 3_600_001; await runtime.sweep();
    expect(runtime.reservations()).toHaveLength(1);
    expect(() => admit(runtime, owner, randomUUID())).toThrow();
    expect(() => admit(runtime, randomUUID(), randomUUID())).toThrow("concurrent_session_limit");
    expect(registry.acquire(now)).toBeNull();
    await runtime.shutdown(); runtimes.pop();
    runtime = new RealtimeAttempts(db, registry, options); runtimes.push(runtime);
    registry.restoreReservations(runtime.reservations(), now);
    expect(registry.acquire(now)).toBeNull();
    close.mockResolvedValueOnce(undefined); await runtime.cleanup(owner, id);
    expect(runtime.reservations()).toHaveLength(0);
    expect(registry.acquire(now)).not.toBeNull();
  });
});
