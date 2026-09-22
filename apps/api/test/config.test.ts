import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const admissionVariables = [
  "MAX_CONCURRENT_SESSIONS",
  "LIVE_SESSION_LEASE_MS",
  "LIVE_SESSION_RATE_LIMIT",
  "LIVE_SESSION_RATE_WINDOW_MS",
] as const;

beforeEach(() => {
  vi.resetModules();
  vi.stubEnv("NODE_ENV", "test");
  vi.stubEnv("WEB_ORIGIN", undefined);
  for (const name of admissionVariables) vi.stubEnv(name, undefined);
});

afterEach(() => {
  vi.unstubAllEnvs();
});

describe("API configuration", () => {
  it("keeps all four safe admission defaults when env is absent", async () => {
    const { apiConfig } = await import("../src/config.js");
    expect(apiConfig).toMatchObject({
      webOrigin: "http://localhost:5173",
      maxConcurrentSessions: 5,
      leaseMs: 900000,
      creationLimit: 20,
      creationWindowMs: 600000,
    });
  });

  it("reads the internal test profile and explicit TTL/window overrides", async () => {
    vi.stubEnv("MAX_CONCURRENT_SESSIONS", "15");
    vi.stubEnv("LIVE_SESSION_LEASE_MS", "120000");
    vi.stubEnv("LIVE_SESSION_RATE_LIMIT", "60");
    vi.stubEnv("LIVE_SESSION_RATE_WINDOW_MS", "300000");
    const { apiConfig } = await import("../src/config.js");
    expect(apiConfig).toMatchObject({
      maxConcurrentSessions: 15,
      leaseMs: 120000,
      creationLimit: 60,
      creationWindowMs: 300000,
    });
  });

  describe.each(admissionVariables)("%s", (name) => {
    it.each(["", " ", "0", "-1", "1.5", "NaN", "Infinity", "9007199254740992", "1e3", "0x10", "10ms"])(
      "rejects invalid configured value %j rather than falling back",
      async (value) => {
        vi.stubEnv(name, value);
        await expect(import("../src/config.js")).rejects.toThrow(name);
      },
    );
  });

  it("rejects a rate window beyond the built-in store's timer range", async () => {
    vi.stubEnv("LIVE_SESSION_RATE_WINDOW_MS", "2147483648");
    await expect(import("../src/config.js")).rejects.toThrow("LIVE_SESSION_RATE_WINDOW_MS");
  });

  it("accepts the built-in store's maximum supported rate window", async () => {
    vi.stubEnv("LIVE_SESSION_RATE_WINDOW_MS", "2147483647");
    const { apiConfig } = await import("../src/config.js");
    expect(apiConfig).toMatchObject({ creationWindowMs: 2147483647 });
  });

  it("still requires WEB_ORIGIN in production", async () => {
    vi.stubEnv("NODE_ENV", "production");
    await expect(import("../src/config.js")).rejects.toThrow("WEB_ORIGIN is required");
  });

  it.each(["http://example.test", "https://example.test/", "https://example.test/path"])(
    "still rejects an invalid production origin %s",
    async (origin) => {
      vi.stubEnv("NODE_ENV", "production");
      vi.stubEnv("WEB_ORIGIN", origin);
      await expect(import("../src/config.js")).rejects.toThrow("WEB_ORIGIN");
    },
  );

  it("preserves an exact HTTPS production origin", async () => {
    vi.stubEnv("NODE_ENV", "production");
    vi.stubEnv("WEB_ORIGIN", "https://example.test");
    const { apiConfig } = await import("../src/config.js");
    expect(apiConfig.webOrigin).toBe("https://example.test");
  });
});
