import { randomUUID } from "node:crypto";
import { afterEach, describe, expect, it } from "vitest";
import request from "supertest";
import { apiConfig } from "../src/config.js";
import { createApp } from "../src/app.js";

const original = { ...apiConfig };
afterEach(() => Object.assign(apiConfig, original));

describe("background close policy", () => {
  it("publishes the enabled flag and retains it on conversation create and read", async () => {
    Object.assign(apiConfig, { usageLedgerEnabled: true, backgroundSessionCloseEnabled: true, usageDbPath: ":memory:" });
    const app = createApp({ startWorker: false });
    try {
      const agent = request.agent(app);
      const policy = await agent.get("/api/policy").expect(200);
      expect(policy.body).toMatchObject({ usageLedgerEnabled: true, backgroundSessionCloseEnabled: true });
      const created = await agent.post("/api/conversations").set("Origin", "http://localhost:5173")
        .send({ createRequestId: randomUUID(), appVersion: "test" }).expect(201);
      expect(created.body.policy.backgroundSessionCloseEnabled).toBe(true);
      const read = await agent.get(`/api/conversations/${created.body.conversationId}`).expect(200);
      expect(read.body.policy.backgroundSessionCloseEnabled).toBe(true);
      const paused = await agent.post(`/api/conversations/${created.body.conversationId}/pause`)
        .set("Origin", "http://localhost:5173").send({ expectedVersion: created.body.version }).expect(200);
      const claimed = await agent.post(`/api/conversations/${created.body.conversationId}/resume`)
        .set("Origin", "http://localhost:5173")
        .send({ expectedVersion: paused.body.version, resumeAttemptId: randomUUID(), initialMode: "setup" }).expect(200);
      expect(claimed.body.policy.backgroundSessionCloseEnabled).toBe(true);
      expect(claimed.body.attempt.resumeClaimVersion).toBe(claimed.body.version);
    } finally {
      const runtime = app.locals.ledgerRuntime;
      await runtime.shutdown({ drainMs: 0, timeoutMs: 100 });
      runtime.ledger.db.close();
    }
  });
});
