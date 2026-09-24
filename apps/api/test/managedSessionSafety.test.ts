import { randomUUID } from "node:crypto";
import { once } from "node:events";
import { request as httpRequest } from "node:http";
import express from "express";
import request from "supertest";
import { afterEach, describe, expect, it, vi } from "vitest";
import { createApp } from "../src/app.js";
import { LedgerRuntime } from "../src/accounting/LedgerRuntime.js";
import { UsageLedger } from "../src/accounting/UsageLedger.js";
import { openUsageDatabase } from "../src/persistence/database.js";
import { AnonymousIdentity } from "../src/security/AnonymousIdentity.js";
import type { LiveSessionResponse } from "../src/openai/createLiveSession.js";
import { DEFAULT_LEDGER_POLICY } from "../src/accounting/types.js";

const origin = "http://localhost:5173";
afterEach(() => vi.unstubAllEnvs());

describe("managed session failure boundaries", () => {
  it("fences an HTTP disconnect before abort, then persists a late provider ID for cleanup", async () => {
    vi.stubEnv("OPENAI_API_KEY", "fake-key");
    const db = openUsageDatabase(":memory:"), ledger = new UsageLedger(db);
    let finish!: (value: LiveSessionResponse) => void;
    let signal: AbortSignal | undefined;
    let markerAtAbort: string | null = null;
    const app = createApp({ ledger, startWorker: false, createLiveSession: (_offer, context) => {
      signal = context!.signal;
      signal.addEventListener("abort", () => {
        markerAtAbort = ledger.getAttemptInternal(context!.localId).cleanup_reason;
      });
      return new Promise(resolve => { finish = resolve; });
    }, closeOrphan: async () => ({ kind: "closed_observed", observation: {} }) });
    const server = app.listen(0, "127.0.0.1");
    await once(server, "listening");
    const address = server.address();
    if (!address || typeof address === "string") throw new Error("Missing test address");
    try {
      const created = await request(app).post("/api/conversations").set("Origin", origin)
        .send({ createRequestId: randomUUID(), appVersion: "test" }).expect(201);
      const localId = randomUUID();
      const body = JSON.stringify({ sdp: "synthetic-offer", liveSessionId: localId,
        conversationId: created.body.conversationId, conversationVersion: created.body.version,
        initialMode: "setup", startReason: "initial" });
      const req = httpRequest({ host: "127.0.0.1", port: address.port, path: "/api/live/session", method: "POST",
        headers: { Origin: origin, Cookie: created.headers["set-cookie"]![0]!.split(";")[0]!,
          "Content-Type": "application/json", "Content-Length": Buffer.byteLength(body) } });
      req.on("error", () => {}); // The test deliberately destroys the socket.
      req.end(body);
      await vi.waitFor(() => expect(finish).toBeDefined());
      vi.spyOn(ledger, "getAttempt").mockImplementationOnce(() => { throw new Error("ledger read unavailable"); });
      req.destroy();
      await vi.waitFor(() => expect(signal!.aborted).toBe(true));
      expect(markerAtAbort).toBe("client_disconnected");
      expect(ledger.getAttemptInternal(localId).openai_session_id).toBeNull();
      finish({ session: { id: "late-provider" }, transport: { type: "webrtc", sdp: "late-answer" } });
      await vi.waitFor(() => expect(ledger.getAttemptInternal(localId).openai_session_id).toBe("late-provider"));
      const row = ledger.getAttemptInternal(localId);
      expect(row.cleanup_reason).toBe("client_disconnected");
      expect(row.handoff_acknowledged_at).toBeNull();
      expect(row.lease_released_at).toBeNull();
      expect(row.cleanup_next_attempt_at).not.toBeNull();
      await (app.locals.ledgerRuntime as LedgerRuntime).worker.drain();
      expect(ledger.getAttemptInternal(localId).close_confirmed).toBe(1);
    } finally {
      server.closeAllConnections();
      await new Promise<void>(resolve => server.close(() => resolve()));
      await (app.locals.ledgerRuntime as LedgerRuntime).shutdown({ drainMs: 0, timeoutMs: 100 });
      db.close();
    }
  });

  it("keeps a shared provider create alive while another duplicate request is still connected", async () => {
    vi.stubEnv("OPENAI_API_KEY", "fake-key");
    const db = openUsageDatabase(":memory:"), ledger = new UsageLedger(db);
    let finish!: (value: LiveSessionResponse) => void;
    let providerSignal: AbortSignal | undefined;
    const provider = vi.fn((_offer: string, context?: { signal: AbortSignal }) => {
      providerSignal = context!.signal;
      return new Promise<LiveSessionResponse>(resolve => { finish = resolve; });
    });
    const app = createApp({ ledger, startWorker: false, createLiveSession: provider });
    const runtime = app.locals.ledgerRuntime as LedgerRuntime;
    const server = app.listen(0, "127.0.0.1");
    await once(server, "listening");
    const address = server.address();
    if (!address || typeof address === "string") throw new Error("Missing test address");
    try {
      const created = await request(app).post("/api/conversations").set("Origin", origin)
        .send({ createRequestId: randomUUID(), appVersion: "test" }).expect(201);
      const cookie = created.headers["set-cookie"]![0]!.split(";")[0]!;
      const localId = randomUUID();
      const body = JSON.stringify({ sdp: "synthetic-offer", liveSessionId: localId,
        conversationId: created.body.conversationId, conversationVersion: created.body.version,
        initialMode: "setup", startReason: "initial" });
      const startRequest = () => {
        let req!: ReturnType<typeof httpRequest>;
        const done = new Promise<{ status: number; body: string }>((resolve, reject) => {
          req = httpRequest({ host: "127.0.0.1", port: address.port, path: "/api/live/session", method: "POST",
            headers: { Origin: origin, Cookie: cookie, "Content-Type": "application/json", "Content-Length": Buffer.byteLength(body) } },
          res => {
            let responseBody = ""; res.setEncoding("utf8");
            res.on("data", chunk => { responseBody += chunk; });
            res.on("end", () => resolve({ status: res.statusCode ?? 0, body: responseBody }));
          });
          req.on("error", reject); req.end(body);
        });
        return { req, done };
      };

      const first = startRequest();
      await vi.waitFor(() => expect(provider).toHaveBeenCalledTimes(1));
      const second = startRequest();
      await vi.waitFor(() => expect(runtime.createWaiterCount(localId)).toBe(2));

      first.req.destroy();
      await first.done.catch(() => undefined);
      await vi.waitFor(() => expect(runtime.createWaiterCount(localId)).toBe(1));
      expect(providerSignal?.aborted).toBe(false);
      expect(ledger.getAttemptInternal(localId).cleanup_requested_at).toBeNull();

      finish({ session: { id: "shared-provider" }, transport: { type: "webrtc", sdp: "shared-answer" } });
      const response = await second.done;
      expect(response.status).toBe(201);
      await vi.waitFor(() => expect(runtime.createWaiterCount(localId)).toBe(0));
      expect(provider).toHaveBeenCalledTimes(1);
      expect(ledger.getAttemptInternal(localId).openai_session_id).toBe("shared-provider");
      expect(ledger.getAttemptInternal(localId).cleanup_requested_at).toBeNull();
    } finally {
      server.closeAllConnections();
      await new Promise<void>(resolve => server.close(() => resolve()));
      await runtime.shutdown({ drainMs: 0, timeoutMs: 100 });
      db.close();
    }
  });

  it("does not register a conflicting duplicate as a shared-create waiter", async () => {
    vi.stubEnv("OPENAI_API_KEY", "fake-key");
    const db = openUsageDatabase(":memory:"), ledger = new UsageLedger(db);
    let finish!: (value: LiveSessionResponse) => void;
    const provider = vi.fn(() => new Promise<LiveSessionResponse>(resolve => { finish = resolve; }));
    const app = createApp({ ledger, startWorker: false, createLiveSession: provider });
    const runtime = app.locals.ledgerRuntime as LedgerRuntime, agent = request.agent(app);
    try {
      const created = await agent.post("/api/conversations").set("Origin", origin)
        .send({ createRequestId: randomUUID(), appVersion: "test" }).expect(201);
      const localId = randomUUID();
      const body = { sdp: "shared-offer", liveSessionId: localId,
        conversationId: created.body.conversationId, conversationVersion: created.body.version,
        initialMode: "setup", startReason: "initial" };
      const first = agent.post("/api/live/session").set("Origin", origin).send(body).then(result => result);
      await vi.waitFor(() => expect(provider).toHaveBeenCalledTimes(1));
      expect(runtime.createWaiterCount(localId)).toBe(1);

      const register = vi.spyOn(runtime, "registerCreateWaiter");
      await agent.post("/api/live/session").set("Origin", origin).send({ ...body, sdp: "conflicting-offer" }).expect(409);
      expect(register).not.toHaveBeenCalled();
      expect(runtime.createWaiterCount(localId)).toBe(1);

      finish({ session: { id: "provider-after-conflict" }, transport: { type: "webrtc", sdp: "answer" } });
      expect((await first).status).toBe(201);
      await vi.waitFor(() => expect(runtime.createWaiterCount(localId)).toBe(0));
      expect(ledger.getAttemptInternal(localId).cleanup_requested_at).toBeNull();
    } finally {
      await runtime.shutdown({ drainMs: 0, timeoutMs: 100 }); db.close();
    }
  });

  it("tombstones a missing recovery ID before a late create can register it", async () => {
    vi.stubEnv("OPENAI_API_KEY", "fake-key");
    const db = openUsageDatabase(":memory:"), ledger = new UsageLedger(db);
    const provider = vi.fn();
    const app = createApp({ ledger, startWorker: false, createLiveSession: provider });
    const runtime = app.locals.ledgerRuntime as LedgerRuntime, agent = request.agent(app);
    try {
      const created = await agent.post("/api/conversations").set("Origin", origin)
        .send({ createRequestId: randomUUID(), appVersion: "test" }).expect(201);
      const localId = randomUUID();
      const fence = await agent.post(`/api/live/session/${localId}/recover`).set("Origin", origin)
        .send({ conversationId: created.body.conversationId, reason: "response_not_received" }).expect(200);
      expect(fence.body).toMatchObject({ liveSessionId: localId, state: "failed", openaiSessionId: null, recoveryFenced: true });

      await agent.post("/api/live/session").set("Origin", origin).send({
        sdp: "late-offer", liveSessionId: localId, conversationId: created.body.conversationId,
        conversationVersion: created.body.version, initialMode: "setup", startReason: "initial",
      }).expect(410);
      expect(provider).not.toHaveBeenCalled();
    } finally { await runtime.shutdown({ drainMs: 0, timeoutMs: 100 }); db.close(); }
  });

  it("durably fences an already registered in-flight create before aborting it", async () => {
    vi.stubEnv("OPENAI_API_KEY", "fake-key");
    let now = 1_800_000_000_000;
    const db = openUsageDatabase(":memory:"), ledger = new UsageLedger(db, {
      now: () => now, policy: { ...DEFAULT_LEDGER_POLICY, maxProviderSessionMs: 100 },
    });
    let providerSignal: AbortSignal | undefined;
    const provider = vi.fn((_offer: string, context?: { signal: AbortSignal }) => {
      providerSignal = context!.signal;
      return new Promise<LiveSessionResponse>((_resolve, reject) => {
        context!.signal.addEventListener("abort", () => reject(new Error("aborted")), { once: true });
      });
    });
    const app = createApp({ ledger, startWorker: false, createLiveSession: provider });
    const runtime = app.locals.ledgerRuntime as LedgerRuntime, agent = request.agent(app);
    try {
      const created = await agent.post("/api/conversations").set("Origin", origin)
        .send({ createRequestId: randomUUID(), appVersion: "test" }).expect(201);
      const localId = randomUUID();
      const creation = agent.post("/api/live/session").set("Origin", origin).send({
        sdp: "pending-offer", liveSessionId: localId, conversationId: created.body.conversationId,
        conversationVersion: created.body.version, initialMode: "setup", startReason: "initial",
      }).then(result => result);
      await vi.waitFor(() => expect(provider).toHaveBeenCalledTimes(1));

      const fence = await agent.post(`/api/live/session/${localId}/recover`).set("Origin", origin)
        .send({ conversationId: created.body.conversationId, reason: "response_not_received" }).expect(200);
      expect(fence.body.cleanupRequestedAt).not.toBeNull();
      await vi.waitFor(() => expect(providerSignal?.aborted).toBe(true));
      expect((await creation).status).toBe(502);

      let row = ledger.getAttemptInternal(localId);
      expect(row.cleanup_requested_at).not.toBeNull();
      expect(row.state).toBe("closing");
      expect(row.provider_expires_at).toBe(now + 100);

      now += 99; ledger.watchdog();
      expect(ledger.getAttemptInternal(localId).state).toBe("closing");

      now += 1; ledger.watchdog();
      row = ledger.getAttemptInternal(localId);
      expect(row.state).toBe("closed");
      expect(row.close_confirmed).toBe(0);
      expect(row.lease_released_at).toBe(now);
      expect(ledger.reservations()).toHaveLength(0);
    } finally { await runtime.shutdown({ drainMs: 0, timeoutMs: 100 }); db.close(); }
  });

  it("uses a distinct error for shutdown before attempt registration", async () => {
    const db = openUsageDatabase(":memory:"), ledger = new UsageLedger(db);
    const runtime = new LedgerRuntime(ledger, { startWorker: false, creator: vi.fn() });
    const owner = randomUUID(), c = ledger.createConversation(owner, randomUUID(), "test");
    const input = { liveSessionId: randomUUID(), conversationId: c.id, conversationVersion: c.version,
      initialMode: "setup" as const, startReason: "initial" as const, fingerprint: "shutdown" };
    await runtime.shutdown({ drainMs: 0, timeoutMs: 100 });
    expect(() => runtime.create(owner, input, "offer", () => false)).toThrow("server_shutting_down_before_dispatch");
    expect(() => ledger.getAttemptInternal(input.liveSessionId)).toThrow("not_found");
    db.close();
  });

  it("persists a provider ID that arrives after the shutdown drain has completed", async () => {
    const db = openUsageDatabase(":memory:"), ledger = new UsageLedger(db);
    const owner = randomUUID(), c = ledger.createConversation(owner, randomUUID(), "test");
    const input = { liveSessionId: randomUUID(), conversationId: c.id, conversationVersion: c.version,
      initialMode: "setup" as const, startReason: "initial" as const, fingerprint: "late-shutdown" };
    let finish!: (value: LiveSessionResponse) => void;
    const runtime = new LedgerRuntime(ledger, {
      startWorker: false,
      creator: () => new Promise<LiveSessionResponse>(resolve => { finish = resolve; }),
    });
    const creation = runtime.create(owner, input, "offer", () => false);
    await vi.waitFor(() => expect(ledger.getAttemptInternal(input.liveSessionId).provider_request_dispatched_at).not.toBeNull());
    await runtime.shutdown({ drainMs: 0, timeoutMs: 0 });

    finish({ session: { id: "provider-after-shutdown" }, transport: { type: "webrtc", sdp: "late-answer" } });
    await expect(creation).rejects.toThrow("server_shutting_down");
    const row = ledger.getAttemptInternal(input.liveSessionId);
    expect(row.openai_session_id).toBe("provider-after-shutdown");
    expect(row.cleanup_reason).toBe("server_shutdown");
    expect(row.cleanup_next_attempt_at).not.toBeNull();
    db.close();
  });

  it("never calls the provider again for an attempt restored after restart", async () => {
    const db = openUsageDatabase(":memory:"), ledger = new UsageLedger(db);
    const owner = randomUUID(), c = ledger.createConversation(owner, randomUUID(), "test");
    const input = { liveSessionId: randomUUID(), conversationId: c.id, conversationVersion: c.version,
      initialMode: "setup" as const, startReason: "initial" as const, fingerprint: "synthetic" };
    ledger.registerAttempt(owner, input);
    ledger.dispatchProviderAttempt(owner, input.liveSessionId, c.version, randomUUID(), ledger.now() + 900000);
    const creator = vi.fn();
    const runtime = new LedgerRuntime(ledger, { creator, startWorker: false });
    try {
      expect(() => runtime.create(owner, input, "same-offer", () => false)).toThrow("attempt_already_exists");
      expect(creator).not.toHaveBeenCalled();
      expect(ledger.getAttemptInternal(input.liveSessionId).state).toBe("unknown");
      expect(ledger.getAttemptInternal(input.liveSessionId).provider_final_seconds).toBeNull();
    } finally { await runtime.shutdown({ drainMs: 0, timeoutMs: 100 }); db.close(); }
  });

  it("serializes production cookie flags and renews the same persisted identity", async () => {
    const identity = new AnonymousIdentity(true), app = express();
    app.get("/identity", (req, res) => {
      identity.renew(res, identity.forCreation(req)); res.json({ ok: true });
    });
    const first = await request(app).get("/identity").expect(200);
    const cookie = first.headers["set-cookie"]![0]!;
    expect(cookie).toMatch(/^__Host-live-translator=/);
    for (const attribute of ["HttpOnly", "Secure", "SameSite=Lax", "Path=/", "Max-Age=7776000"]) expect(cookie).toContain(attribute);
    expect(cookie).not.toContain("Domain=");
    const persisted = cookie.split(";")[0]!;
    const renewed = await request(app).get("/identity").set("Cookie", persisted).expect(200);
    expect(renewed.headers["set-cookie"]![0]!.split(";")[0]).toBe(persisted);
    expect(renewed.body).toEqual({ ok: true });
    const cleared = await request(app).get("/identity").expect(200);
    expect(cleared.headers["set-cookie"]![0]!.split(";")[0]).not.toBe(persisted);
  });
});
