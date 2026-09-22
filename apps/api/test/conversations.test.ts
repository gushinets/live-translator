import { randomUUID } from "node:crypto";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import request from "supertest";
import { openUsageDatabase } from "../src/persistence/database.js";
import { UsageLedger } from "../src/accounting/UsageLedger.js";
import { createApp } from "../src/app.js";
import { LedgerRuntime } from "../src/accounting/LedgerRuntime.js";
import type { LiveSessionCreator } from "../src/openai/createLiveSession.js";
const origin = "http://localhost:5173";
const answer = (id: string) => ({ session: { id }, transport: { type: "webrtc" as const, sdp: "answer-sdp" } });
const dbs: ReturnType<typeof openUsageDatabase>[] = [];
beforeEach(() => vi.stubEnv("OPENAI_API_KEY", "fake-key"));
afterEach(() => { vi.unstubAllEnvs(); for (const db of dbs.splice(0)) if (db.isOpen) db.close(); });
function fixture(creator: LiveSessionCreator = async () => answer(randomUUID())) {
  const db = openUsageDatabase(":memory:"); dbs.push(db);
  const ledger = new UsageLedger(db), provider = vi.fn(creator), closeOrphan = vi.fn(async () => ({ kind: "closed_observed" as const, observation: {} }));
  const app = createApp({ ledger, createLiveSession: provider, closeOrphan, startWorker: false });
  const agent = request.agent(app);
  const conversation = async () => (await agent.post("/api/conversations").set("Origin", origin).send({ createRequestId: randomUUID(), appVersion: "test" }).expect(201)).body as { conversationId: string; version: number };
  return { db, ledger, provider, closeOrphan, app, agent, conversation };
}
const payload = (c: { conversationId: string; version: number }) => ({ sdp: "offer-sdp", conversationId: c.conversationId,
  conversationVersion: c.version, liveSessionId: randomUUID(), initialMode: "setup", startReason: "initial" });

describe("conversation HTTP ownership and handoff", () => {
  it("issues a persistent HttpOnly identity, deduplicates conversation key, never exposes owner JSON", async () => {
    const f = fixture(), body = { createRequestId: randomUUID(), appVersion: "test" };
    const first = await f.agent.post("/api/conversations").set("Origin", origin).send(body).expect(201);
    const cookie = first.headers["set-cookie"]?.[0];
    expect(cookie).toContain("HttpOnly"); expect(cookie).toContain("Max-Age=7776000"); expect(cookie).toContain("SameSite=Lax");
    expect(JSON.stringify(first.body)).not.toContain("anonymous_user_id");
    const second = await f.agent.post("/api/conversations").set("Origin", origin).send(body).expect(201);
    expect(second.body.conversationId).toBe(first.body.conversationId); expect(f.provider).not.toHaveBeenCalled();
  });
  it("does not issue cookies or rows for a cross-origin request", async () => {
    const f = fixture(); const res = await f.agent.post("/api/conversations").set("Origin", "https://evil.test").send({ createRequestId: randomUUID(), appVersion: "test" }).expect(403);
    expect(res.headers["set-cookie"]).toBeUndefined(); expect(f.db.prepare("SELECT COUNT(*) AS n FROM conversations").get()!.n).toBe(0);
  });
  it("prevents another anonymous owner from reading, creating or releasing a child", async () => {
    const f = fixture(), c = await f.conversation(), p = payload(c);
    const created = await f.agent.post("/api/live/session").set("Origin", origin).send(p).expect(201);
    const other = request.agent(f.app); await other.post("/api/conversations").set("Origin", origin).send({ createRequestId: randomUUID(), appVersion: "other" }).expect(201);
    await other.get(`/api/conversations/${c.conversationId}`).expect(404);
    await other.post("/api/live/session").set("Origin", origin).send({ ...p, liveSessionId: randomUUID() }).expect(404);
    await other.delete(`/api/live/session/${created.body.session.id}`).set("Origin", origin).expect(404);
    expect(f.provider).toHaveBeenCalledTimes(1);
  });
  it("rejects old and unsupported payloads before registration/provider dispatch", async () => {
    const f = fixture(), c = await f.conversation();
    const old = await f.agent.post("/api/live/session").set("Origin", origin).send({ sdp: "legacy" }).expect(400);
    expect(old.body.code).toBe("client_upgrade_required");
    for (const startReason of ["reconnect", "rollover", "unknown"]) await f.agent.post("/api/live/session").set("Origin", origin).send({ ...payload(c), startReason }).expect(400);
    expect(f.provider).not.toHaveBeenCalled(); expect(f.db.prepare("SELECT COUNT(*) AS n FROM live_sessions").get()!.n).toBe(0);
  });
  it("commits registration and dispatch before provider call, then requires handoff", async () => {
    const f = fixture(), c = await f.conversation(), p = payload(c);
    f.provider.mockImplementation(async (_sdp, context) => {
      expect(context!.signal).toBeInstanceOf(AbortSignal);
      expect(f.ledger.getAttemptInternal(p.liveSessionId).provider_request_dispatched_at).not.toBeNull(); return answer("provider-one");
    });
    const res = await f.agent.post("/api/live/session").set("Origin", origin).send(p).expect(201);
    expect(res.body.accounting.liveSessionId).toBe(p.liveSessionId); expect(f.ledger.getAttemptInternal(p.liveSessionId).state).toBe("creating");
    await f.agent.post(`/api/live/session/${p.liveSessionId}/handoff`).set("Origin", origin).send({}).expect(200);
    expect(f.ledger.getAttemptInternal(p.liveSessionId).state).toBe("active");
  });
  it("concurrent duplicate requests share one provider call and later duplicates never re-create", async () => {
    let resolve!: (result: ReturnType<typeof answer>) => void;
    const f = fixture(() => new Promise(r => { resolve = r; })), c = await f.conversation(), p = payload(c);
    const a = f.agent.post("/api/live/session").set("Origin", origin).send(p).then(r => r);
    await vi.waitFor(() => expect(f.provider).toHaveBeenCalledTimes(1));
    const b = f.agent.post("/api/live/session").set("Origin", origin).send(p).then(r => r);
    await new Promise(r => setTimeout(r, 10)); resolve(answer("provider-once"));
    expect((await Promise.all([a, b])).map(r => r.status)).toEqual([201, 201]);
    await f.agent.post("/api/live/session").set("Origin", origin).send(p).expect(409); expect(f.provider).toHaveBeenCalledTimes(1);
  });
  it("does not turn a post-provider SQLite failure into a usable 201", async () => {
    const f = fixture(), c = await f.conversation(), p = payload(c);
    vi.spyOn(f.ledger, "recordProviderCreated").mockImplementationOnce(() => { throw new Error("disk unavailable"); });
    const res = await f.agent.post("/api/live/session").set("Origin", origin).send(p).expect(503);
    expect(res.body.code).toBe("provider_result_unpersisted"); expect(f.ledger.getAttemptInternal(p.liveSessionId).cleanup_requested_at).not.toBeNull();
    await f.app.locals.ledgerRuntime.worker.drain(); expect(f.closeOrphan).toHaveBeenCalledTimes(1);
  });
  it("keeps first cleanup reason, refuses backend-only reason, and cannot ACK after cleanup", async () => {
    const f = fixture(), c = await f.conversation(), p = payload(c);
    await f.agent.post("/api/live/session").set("Origin", origin).send(p).expect(201);
    await f.agent.post(`/api/live/session/${p.liveSessionId}/cleanup`).set("Origin", origin).send({ reason: "server_shutdown" }).expect(400);
    await f.agent.post(`/api/live/session/${p.liveSessionId}/cleanup`).set("Origin", origin).send({ reason: "primary_startup_failed" }).expect(200);
    await f.agent.post(`/api/live/session/${p.liveSessionId}/cleanup`).set("Origin", origin).send({ reason: "user_end" }).expect(200);
    expect(f.ledger.getAttemptInternal(p.liveSessionId).cleanup_reason).toBe("primary_startup_failed");
    await f.agent.post(`/api/live/session/${p.liveSessionId}/handoff`).set("Origin", origin).send({}).expect(409);
  });
  it("omits SDP and fingerprints from read-back", async () => {
    const f = fixture(), c = await f.conversation(), p = payload(c);
    await f.agent.post("/api/live/session").set("Origin", origin).send(p).expect(201);
    const res = await f.agent.get(`/api/conversations/${c.conversationId}`).expect(200);
    expect(res.body.sessions).toHaveLength(1); expect(res.body.sessions[0].handoffAcknowledgedAt).toBeNull();
    expect(JSON.stringify(res.body)).not.toContain("offer-sdp"); expect(JSON.stringify(res.body)).not.toContain("request_fingerprint");
  });
  it("does not create a resume claim after runtime shutdown starts", async () => {
    const f = fixture(), c = await f.conversation();
    const paused = await f.agent.post(`/api/conversations/${c.conversationId}/pause`).set("Origin", origin)
      .send({ expectedVersion: c.version }).expect(200);
    await (f.app.locals.ledgerRuntime as LedgerRuntime).shutdown({ drainMs: 0, timeoutMs: 100 });
    const res = await f.agent.post(`/api/conversations/${c.conversationId}/resume`).set("Origin", origin)
      .send({ expectedVersion: paused.body.version, resumeAttemptId: randomUUID(), initialMode: "setup" }).expect(503);
    expect(res.body.code).toBe("new_creations_paused");
    expect(f.ledger.getConversation((f.db.prepare("SELECT anonymous_user_id FROM conversations WHERE id=?").get(c.conversationId) as { anonymous_user_id: string }).anonymous_user_id, c.conversationId).status).toBe("paused");
  });

  it("keeps recovery endpoints while disabling new creations during rollback", async () => {
    const f = fixture(), c = await f.conversation();
    const app = createApp({ ledger: f.ledger, ledgerEnabled: false, startWorker: false, createLiveSession: f.provider, closeOrphan: f.closeOrphan });
    const policy = await request(app).get("/api/policy").expect(200);
    expect(policy.body.creationPaused).toBe(true);
    await request(app).post("/api/live/session").set("Origin", origin).send({ sdp: "legacy" }).expect(503);
    expect(c.conversationId).toBeTruthy(); expect(f.provider).not.toHaveBeenCalled();
  });
});
