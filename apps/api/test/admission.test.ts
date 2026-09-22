import request from "supertest";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const origin = "http://localhost:5173";

beforeEach(() => {
  vi.resetModules();
  vi.stubEnv("NODE_ENV", "test");
  vi.stubEnv("WEB_ORIGIN", origin);
  vi.stubEnv("OPENAI_API_KEY", "test-placeholder-not-a-real-key");
  vi.stubEnv("MAX_CONCURRENT_SESSIONS", "5");
  vi.stubEnv("LIVE_SESSION_LEASE_MS", "900000");
  vi.stubEnv("LIVE_SESSION_RATE_LIMIT", "20");
  vi.stubEnv("LIVE_SESSION_RATE_WINDOW_MS", "600000");
});

afterEach(() => {
  vi.useRealTimers();
  vi.unstubAllEnvs();
});

function fakeProvider() {
  let nextId = 0;
  return vi.fn(async () => ({
    session: { id: `session-${++nextId}` },
    transport: { type: "webrtc" as const, sdp: "answer-sdp" },
  }));
}

async function configuredApp(overrides: Record<string, string> = {}) {
  for (const [name, value] of Object.entries(overrides)) vi.stubEnv(name, value);
  const { createApp } = await import("../src/app.js");
  const createLiveSession = fakeProvider();
  return { app: createApp({ createLiveSession }), createLiveSession };
}

describe("session admission configuration and creation-only rate limit", () => {
  it("allows release and duplicate release even after creation quota is exhausted", async () => {
    const { createApp } = await import("../src/app.js");
    const { SessionLeaseRegistry } = await import("../src/security/SessionLeaseRegistry.js");
    const createLiveSession = fakeProvider();
    const registry = new SessionLeaseRegistry(25, 900000);
    const app = createApp({ createLiveSession, leaseRegistry: registry });
    for (let i = 0; i < 20; i += 1) {
      await request(app).post("/api/live/session").set("Origin", origin).send({ sdp: `offer-${i}` }).expect(201);
    }
    await request(app).post("/api/live/session").set("Origin", origin).send({ sdp: "over-quota" }).expect(429);
    await request(app).delete("/api/live/session/session-1").set("Origin", origin).expect(204);
    await request(app).delete("/api/live/session/session-1").set("Origin", origin).expect(204);
    expect(registry.activeLeases).toBe(19);
    expect(createLiveSession).toHaveBeenCalledTimes(20);
  });

  it("uses a configured two-create limit without blocking cleanup", async () => {
    const { app, createLiveSession } = await configuredApp({ LIVE_SESSION_RATE_LIMIT: "2" });
    await request(app).post("/api/live/session").set("Origin", origin).send({ sdp: "first" }).expect(201);
    await request(app).post("/api/live/session/").set("Origin", origin).send({ sdp: "second" }).expect(201);
    const denied = await request(app).post("/api/live/session").set("Origin", origin).send({ sdp: "third" });
    expect(denied.status).toBe(429);
    expect(denied.body).toEqual({ error: "Too many session creation attempts" });
    await request(app).delete("/api/live/session/session-1").set("Origin", origin).expect(204);
    expect(createLiveSession).toHaveBeenCalledTimes(2);
  });

  it("does not spend creation quota on releases or unmatched methods/routes", async () => {
    const { app, createLiveSession } = await configuredApp({ LIVE_SESSION_RATE_LIMIT: "2" });
    for (let i = 0; i < 21; i += 1) {
      await request(app).delete("/api/live/session/unknown").set("Origin", origin).expect(204);
    }
    await request(app).get("/api/live/session").expect(404);
    await request(app).post("/api/live/session/not-a-create-route").set("Origin", origin).send({ sdp: "unused" }).expect(404);
    await request(app).post("/api/live/session").set("Origin", origin).send({ sdp: "first" }).expect(201);
    await request(app).post("/api/live/session").set("Origin", origin).send({ sdp: "second" }).expect(201);
    expect(createLiveSession).toHaveBeenCalledTimes(2);
  });

  it("enforces configured concurrency and frees capacity only once on duplicate release", async () => {
    const { app, createLiveSession } = await configuredApp({ MAX_CONCURRENT_SESSIONS: "2" });
    await request(app).post("/api/live/session").set("Origin", origin).send({ sdp: "one" }).expect(201);
    await request(app).post("/api/live/session").set("Origin", origin).send({ sdp: "two" }).expect(201);
    const denied = await request(app).post("/api/live/session").set("Origin", origin).send({ sdp: "three" });
    expect(denied.status).toBe(429);
    expect(denied.body).toEqual({ error: "Concurrent session limit reached" });
    await request(app).delete("/api/live/session/session-1").set("Origin", origin).expect(204);
    await request(app).delete("/api/live/session/session-1").set("Origin", origin).expect(204);
    await request(app).post("/api/live/session").set("Origin", origin).send({ sdp: "replacement" }).expect(201);
    await request(app).post("/api/live/session").set("Origin", origin).send({ sdp: "still-full" }).expect(429);
    expect(createLiveSession).toHaveBeenCalledTimes(3);
  });

  it("applies a configured lease TTL at its exact expiry boundary", async () => {
    vi.useFakeTimers({ toFake: ["Date"] });
    const now = Date.now();
    vi.setSystemTime(now);
    const { app, createLiveSession } = await configuredApp({ MAX_CONCURRENT_SESSIONS: "1", LIVE_SESSION_LEASE_MS: "200" });
    await request(app).post("/api/live/session").set("Origin", origin).send({ sdp: "one" }).expect(201);
    vi.setSystemTime(now + 199);
    await request(app).post("/api/live/session").set("Origin", origin).send({ sdp: "before-expiry" }).expect(429);
    vi.setSystemTime(now + 200);
    await request(app).post("/api/live/session").set("Origin", origin).send({ sdp: "at-expiry" }).expect(201);
    expect(createLiveSession).toHaveBeenCalledTimes(2);
  });

  it("resets creation quota at the configured rate-window boundary", async () => {
    vi.useFakeTimers({ toFake: ["Date"] });
    const now = Date.now();
    vi.setSystemTime(now);
    const { app, createLiveSession } = await configuredApp({ LIVE_SESSION_RATE_LIMIT: "1", LIVE_SESSION_RATE_WINDOW_MS: "200" });
    await request(app).post("/api/live/session").set("Origin", origin).send({ sdp: "one" }).expect(201);
    vi.setSystemTime(now + 199);
    await request(app).post("/api/live/session").set("Origin", origin).send({ sdp: "before-reset" }).expect(429);
    vi.setSystemTime(now + 200);
    await request(app).post("/api/live/session").set("Origin", origin).send({ sdp: "at-reset" }).expect(201);
    expect(createLiveSession).toHaveBeenCalledTimes(2);
  });

  it("shares a NAT budget and ignores spoofed addresses beyond the single trusted proxy hop", async () => {
    const { app, createLiveSession } = await configuredApp({ LIVE_SESSION_RATE_LIMIT: "2" });
    expect(app.get("trust proxy")).toBe(1);
    for (const spoofed of ["198.51.100.10", "198.51.100.11"]) {
      await request(app).post("/api/live/session").set("Origin", origin)
        .set("X-Forwarded-For", `${spoofed}, 203.0.113.10`).send({ sdp: "same-nat" }).expect(201);
    }
    await request(app).post("/api/live/session").set("Origin", origin)
      .set("X-Forwarded-For", "198.51.100.12, 203.0.113.10").send({ sdp: "same-nat" }).expect(429);
    await request(app).post("/api/live/session").set("Origin", origin)
      .set("X-Forwarded-For", "203.0.113.11").send({ sdp: "different-client" }).expect(201);
    expect(createLiveSession).toHaveBeenCalledTimes(3);
  });

  it("still rejects missing or wrong release origins after creation quota is exhausted", async () => {
    const { app } = await configuredApp({ LIVE_SESSION_RATE_LIMIT: "1" });
    await request(app).post("/api/live/session").set("Origin", origin).send({ sdp: "one" }).expect(201);
    await request(app).delete("/api/live/session/session-1").set("Origin", "https://other.test").expect(403);
    await request(app).delete("/api/live/session/session-1").expect(403);
    await request(app).delete("/api/live/session/session-1").set("Origin", origin).expect(204);
  });
});
