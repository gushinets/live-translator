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
