import { randomUUID } from "node:crypto";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
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

  it("keeps each conversation's stored policy when the server flag changes", async () => {
    const dir = mkdtempSync(join(tmpdir(), "translator-background-policy-"));
    const apps: ReturnType<typeof createApp>[] = [];
    try {
      Object.assign(apiConfig, { usageLedgerEnabled: true, backgroundSessionCloseEnabled: true, usageDbPath: join(dir, "usage.sqlite") });
      const before = createApp({ startWorker: false });
      apps.push(before);
      const created = await request(before).post("/api/conversations").set("Origin", "http://localhost:5173")
        .send({ createRequestId: randomUUID(), appVersion: "test" }).expect(201);
      expect(created.body.policy.backgroundSessionCloseEnabled).toBe(true);
      const cookie = created.headers["set-cookie"]![0]!.split(";")[0]!;

      apiConfig.backgroundSessionCloseEnabled = false;
      const after = createApp({ startWorker: false });
      apps.push(after);
      const policy = await request(after).get("/api/policy").expect(200);
      expect(policy.body).toMatchObject({ usageLedgerEnabled: true, backgroundSessionCloseEnabled: false });
      const existing = await request(after).get(`/api/conversations/${created.body.conversationId}`).set("Cookie", cookie).expect(200);
      expect(existing.body.policy.backgroundSessionCloseEnabled).toBe(true);
      const newer = await request(after).post("/api/conversations").set("Origin", "http://localhost:5173")
        .set("Cookie", cookie).send({ createRequestId: randomUUID(), appVersion: "test" }).expect(201);
      expect(newer.body.policy.backgroundSessionCloseEnabled).toBe(false);
      const reread = await request(after).get(`/api/conversations/${newer.body.conversationId}`).set("Cookie", cookie).expect(200);
      expect(reread.body.policy.backgroundSessionCloseEnabled).toBe(false);
    } finally {
      for (const app of apps) {
        const runtime = app.locals.ledgerRuntime;
        await runtime.shutdown({ drainMs: 0, timeoutMs: 100 });
        runtime.ledger.db.close();
      }
      rmSync(dir, { recursive: true, force: true });
    }
  });
});
