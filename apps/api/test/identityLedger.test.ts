import { randomUUID } from "node:crypto";
import request from "supertest";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

beforeEach(() => {
  vi.resetModules();
  vi.stubEnv("NODE_ENV", "test");
  vi.stubEnv("WEB_ORIGIN", "http://localhost:5173");
  vi.stubEnv("USAGE_LEDGER_ENABLED", "true");
  vi.stubEnv("USAGE_DB_PATH", ":memory:");
});
afterEach(() => vi.unstubAllEnvs());

describe("anonymous conversation identity", () => {
  it("creates a metadata-only conversation before any provider request", async () => {
    const { createApp } = await import("../src/app.js");
    const provider = vi.fn();
    const app = createApp({ createLiveSession: provider });
    const response = await request(app)
      .post("/api/conversations")
      .set("Origin", "http://localhost:5173")
      .send({ createRequestId: randomUUID(), appVersion: "test" });
    expect(response.status).toBe(201);
    expect(response.body.conversation.id).toMatch(/^[0-9a-f-]{36}$/);
    expect(response.body.conversation.status).toBe("active");
    expect(response.body.conversation.anonymous_user_id).toBeUndefined();
    expect(response.headers["set-cookie"]?.[0]).toContain("HttpOnly");
    expect(provider).not.toHaveBeenCalled();
  });
});
