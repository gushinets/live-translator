// @vitest-environment node
import { randomUUID } from "node:crypto";
import { once } from "node:events";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { request as httpRequest } from "@playwright/test";
import { cleanupRealSessions } from "../../tests/real/cleanup";
import { createApp } from "../../../api/src/app";
import { openUsageDatabase } from "../../../api/src/persistence/database";
import { UsageLedger } from "../../../api/src/accounting/UsageLedger";
import type { LedgerRuntime } from "../../../api/src/accounting/LedgerRuntime";
import { apiConfig } from "../../../api/src/config";

const origin = apiConfig.webOrigin;
beforeEach(() => vi.stubEnv("OPENAI_API_KEY", "test-placeholder-not-a-real-key"));
afterEach(() => vi.unstubAllEnvs());
const payload = (c: { conversationId: string; version: number }) => ({ sdp: "offer-sdp", conversationId: c.conversationId,
  conversationVersion: c.version, liveSessionId: randomUUID(), initialMode: "setup", startReason: "initial" });

describe("real-Live harness cleanup against SQLite endpoints", () => {
  it.each(["timeout", "503"])("ends every conversation even when one session cleanup fails with %s", async failure => {
    const db = openUsageDatabase(":memory:");
    const ledger = new UsageLedger(db);
    const app = createApp({ ledger, startWorker: false,
      createLiveSession: async () => ({ session: { id: randomUUID() }, transport: { type: "webrtc", sdp: "answer" } }),
      closeOrphan: async () => ({ kind: "closed_observed", observation: {} }),
    });
    app.get("/cleanup-unavailable", (_req, res) => res.sendStatus(503));
    const server = app.listen(0, "127.0.0.1");
    await once(server, "listening");
    const address = server.address() as { port: number };
    const client = await httpRequest.newContext({ baseURL: `http://127.0.0.1:${address.port}` });
    try {
      const conversations: string[] = [], attempts = new Map<string, string>();
      for (let index = 0; index < 2; index++) {
        const response = await client.post("/api/conversations", { headers: { Origin: origin }, data: { createRequestId: randomUUID(), appVersion: "test" } });
        expect(response.status()).toBe(201);
        const c = await response.json() as { conversationId: string; version: number };
        const p = payload(c);
        expect((await client.post("/api/live/session", { headers: { Origin: origin }, data: p })).status()).toBe(201);
        // The second attempt already closed; it must still have its conversation ended.
        if (index === 1) expect((await client.post(`/api/live/session/${p.liveSessionId}/closed`, { headers: { Origin: origin }, data: {} })).status()).toBe(200);
        conversations.push(c.conversationId); attempts.set(p.liveSessionId, c.conversationId);
      }
      const failedId = attempts.keys().next().value!;
      const boundary = { get: client.get.bind(client), post: async (...args: Parameters<typeof client.post>) => {
        if (args[0] === `/api/live/session/${failedId}/cleanup`) {
          if (failure === "timeout") throw new Error("Request timed out");
          return client.get("/cleanup-unavailable", args[1]);
        }
        return client.post(...args);
      } };
      await expect(cleanupRealSessions(boundary, origin, attempts)).rejects.toThrow("Real Live session cleanup failed");
      for (const id of conversations) {
        expect((await (await client.get(`/api/conversations/${id}`)).json()).status).toBe("ended");
      }
      expect(ledger.getAttemptInternal(failedId).cleanup_reason).toBe("user_end");
    } finally {
      await client.dispose();
      await (app.locals.ledgerRuntime as LedgerRuntime).shutdown({ drainMs: 0, timeoutMs: 100 });
      await new Promise<void>(resolve => server.close(() => resolve()));
      db.close();
    }
  });
});
