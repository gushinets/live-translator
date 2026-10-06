import { randomUUID } from "node:crypto";
import request from "supertest";
import { afterEach,describe,expect,it,vi } from "vitest";
import { createApp } from "../src/app.js";
import { UsageLedger } from "../src/accounting/UsageLedger.js";
import { openUsageDatabase } from "../src/persistence/database.js";
import type { RealtimeAttempts } from "../src/accounting/RealtimeAttempts.js";
import express from "express";
import { createRealtimeRouter } from "../src/routes/realtime.js";
import { apiConfig } from "../src/config.js";
const origin="http://localhost:5173";
const apps:Array<ReturnType<typeof createApp>>=[];
function app(enabled=true,create=vi.fn(async()=>({callId:"rtc_test",sdp:"answer"})),close=vi.fn(async()=>{})) {
  process.env.OPENAI_API_KEY="mock-key";
  const a=createApp({ledger:new UsageLedger(openUsageDatabase(":memory:")),startWorker:false,realtimeEnabled:enabled,
    createRealtimeCall:create,closeRealtimeCall:close,closeOrphan:async()=>({kind:"retryable_error",code:"mock"})});
  apps.push(a);return {a,create,close,runtime:a.locals.realtimeRuntime as RealtimeAttempts};
}
async function identity(a:ReturnType<typeof createApp>) {
  const res=await request(a).post("/api/realtime/identity").set("Origin",origin).send({});
  return res.headers["set-cookie"]![0]!.split(";")[0] as string;
}
const body=(id=randomUUID())=>({attemptId:id,generation:1,sdp:"offer",languages:{A:"ru",B:"en"}});
afterEach(async()=> {for(const a of apps.splice(0)){await a.locals.realtimeRuntime.shutdown();await a.locals.ledgerRuntime.shutdown({drainMs:10,timeoutMs:1000});a.locals.ledgerRuntime.ledger.db.close();}vi.restoreAllMocks();});
describe("Realtime server boundary",()=> {
  it("keeps owned cleanup available with the feature flag disabled",async()=> {
    const {a,runtime,close}=app(),cookie=await identity(a),b=body();
    await request(a).post("/api/realtime/session").set("Origin",origin).set("Cookie",cookie).send(b).expect(201);
    const disabled=express();disabled.use(express.json());disabled.use("/api/realtime",createRealtimeRouter(runtime,false,()=>false));
    await request(disabled).post("/api/realtime/session").set("Origin",origin).set("Cookie",cookie).send(body()).expect(403);
    const cleaned=await request(disabled).post(`/api/realtime/session/${b.attemptId}/cleanup`).set("Origin",origin).set("Cookie",cookie).send({}).expect(200);
    expect(cleaned.body.closeConfirmed).toBe(true);expect(close).toHaveBeenCalledOnce();
  });
  it("shares creation rate quota with Live but never blocks cleanup",async()=> {
    const {a}=app(),cookie=await identity(a);
    for(let n=0;n<apiConfig.creationLimit;n++)await request(a).post("/api/live/session").set("Origin",origin).send({});
    await request(a).post("/api/realtime/session").set("Origin",origin).set("Cookie",cookie).send(body()).expect(429);
    await request(a).post(`/api/realtime/session/${randomUUID()}/cleanup`).set("Origin",origin).set("Cookie",cookie).send({}).expect(200);
  });
  it("reserves global admission, expires known calls and leaves unknown creation uncertain",async()=> {
    const {a,runtime,create,close}=app();
    for(let n=0;n<apiConfig.maxConcurrentSessions;n++)await runtime.create(randomUUID(),randomUUID(),1,"offer",()=>false);
    expect(()=>runtime.create(randomUUID(),randomUUID(),1,"offer",()=>false)).toThrow("concurrent_session_limit");
    const db=a.locals.ledgerRuntime.ledger.db;db.prepare("UPDATE realtime_attempts SET expires_at=0").run();
    await runtime.sweep();expect(close).toHaveBeenCalledTimes(apiConfig.maxConcurrentSessions);
    vi.mocked(create).mockRejectedValueOnce(new Error("network timeout"));const id=randomUUID(),owner=randomUUID();
    await expect(runtime.create(owner,id,1,"offer",()=>false)).rejects.toThrow("realtime_provider_unavailable");
    expect(runtime.owned(owner,id)).toMatchObject({state:"unknown",close_confirmed:0,call_id:null});
  });
  it("feature flag blocks direct creation and policy keeps Live default",async()=> {
    const {a,create}=app(false);const r=await request(a).post("/api/realtime/session").set("Origin",origin).send(body());
    expect(r.status).toBe(403);expect(create).not.toHaveBeenCalled();expect((await request(a).get("/api/policy")).body.realtime.enabled).toBe(false);
  });
  it("enforces origin, identity, model/session allowlist and ru/en",async()=> {
    const {a,create}=app();expect((await request(a).post("/api/realtime/session").send(body())).status).toBe(403);
    expect((await request(a).post("/api/realtime/session").set("Origin",origin).send(body())).status).toBe(401);
    const cookie=await identity(a);
    for(const b of [{...body(),model:"other"},{...body(),session:{tools:[]}},{...body(),languages:{A:"ru",B:"de"}}]) {
      expect((await request(a).post("/api/realtime/session").set("Origin",origin).set("Cookie",cookie).send(b)).status).toBe(400);
    }expect(create).not.toHaveBeenCalled();
  });
  it("does not close another owner's attempt and uses local IDs",async()=> {
    const {a,close}=app(),cookie=await identity(a),b=body();
    expect((await request(a).post("/api/realtime/session").set("Origin",origin).set("Cookie",cookie).send(b)).status).toBe(201);
    const other=await identity(a);
    expect((await request(a).post(`/api/realtime/session/${b.attemptId}/cleanup`).set("Origin",origin).set("Cookie",other).send({})).status).toBe(404);
    expect(close).not.toHaveBeenCalled();
    const r=await request(a).post(`/api/realtime/session/${b.attemptId}/cleanup`).set("Origin",origin).set("Cookie",cookie).send({});
    expect(r.body.closeConfirmed).toBe(true);expect(close).toHaveBeenCalledWith("rtc_test",expect.any(AbortSignal));
    await request(a).post(`/api/realtime/session/${b.attemptId}/cleanup`).set("Origin",origin).set("Cookie",cookie).send({});expect(close).toHaveBeenCalledTimes(1);
  });
  it("Cancel before create fences the same attempt durably",async()=> {
    const {a,create}=app(),cookie=await identity(a),b=body();
    await request(a).post(`/api/realtime/session/${b.attemptId}/cleanup`).set("Origin",origin).set("Cookie",cookie).send({});
    expect((await request(a).post("/api/realtime/session").set("Origin",origin).set("Cookie",cookie).send(b)).status).toBe(409);expect(create).not.toHaveBeenCalled();
  });
  it("late creation after Cancel hangs up without activation",async()=> {
    let resolve!:(value:{callId:string;sdp:string})=>void;
    const creator=vi.fn(()=>new Promise<{callId:string;sdp:string}>(r=>{resolve=r;}));const {runtime,close}=app(true,creator);
    const id=randomUUID(),owner=randomUUID();const work=runtime.create(owner,id,1,"offer",()=>false);
    await runtime.cleanup(owner,id);resolve({callId:"rtc_late",sdp:"answer"});await expect(work).rejects.toThrow("attempt_cancelled");
    expect(close).toHaveBeenCalledWith("rtc_late",expect.any(AbortSignal));expect(runtime.owned(owner,id).close_confirmed).toBe(1);
  });
  it("shares Live admission and keeps uncertain hangup pending",async()=> {
    const closer=vi.fn(async()=>{throw new Error("provider secret SDP");});const {a,runtime}=app(true,undefined,closer);
    const live=a.locals.ledgerRuntime;
    await runtime.create(randomUUID(),randomUUID(),1,"offer",()=>false);live.syncAdmission();expect(live.registry.activeLeases).toBe(1);
    const cookie=await identity(a),b=body();await request(a).post("/api/realtime/session").set("Origin",origin).set("Cookie",cookie).send(b);
    const r=await request(a).post(`/api/realtime/session/${b.attemptId}/cleanup`).set("Origin",origin).set("Cookie",cookie).send({});
    expect(r.body).toMatchObject({state:"unknown",closeConfirmed:false});expect(JSON.stringify(r.body)).not.toContain("secret");
  });
  it("stores only whitelisted raw token usage separately from Live",async()=> {
    const {a}=app(),cookie=await identity(a),b=body();await request(a).post("/api/realtime/session").set("Origin",origin).set("Cookie",cookie).send(b);
    await request(a).put(`/api/realtime/session/${b.attemptId}/usage`).set("Origin",origin).set("Cookie",cookie)
      .send({responseId:"resp_1",usage:{total_tokens:3,input_tokens:2,output_tokens:1,transcript:"SECRET",audio:"SECRET"}}).expect(204);
    const db=a.locals.ledgerRuntime.ledger.db;
    expect(db.prepare("SELECT usage_json FROM realtime_response_usage").get().usage_json).toBe('{"total_tokens":3,"input_tokens":2,"output_tokens":1}');
    expect(db.prepare("SELECT COUNT(*) AS n FROM live_sessions").get().n).toBe(0);
  });
});
