import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

beforeEach(() => {
  vi.resetModules();
  vi.stubEnv("NODE_ENV", "test");
  vi.stubEnv("WEB_ORIGIN", "http://localhost:5173");
  vi.stubEnv("USAGE_LEDGER_ENABLED", undefined);
  vi.stubEnv("BACKGROUND_SESSION_CLOSE_ENABLED", undefined);
});
afterEach(() => vi.unstubAllEnvs());

describe("ledger rollout configuration", () => {
  it("keeps ledger disabled until the coordinated rollout", async () => {
    const { apiConfig } = await import("../src/config.js");
    expect(apiConfig).toMatchObject({ usageLedgerEnabled: false });
  });
  it("allows an explicit ledger rollout", async () => {
    vi.stubEnv("USAGE_LEDGER_ENABLED", "true");
    const { apiConfig } = await import("../src/config.js");
    expect(apiConfig).toMatchObject({ usageLedgerEnabled: true });
  });
  it.each(["", "1", "yes", "FALSE"])("rejects an invalid flag %j", async (value) => {
    vi.stubEnv("USAGE_LEDGER_ENABLED", value);
    await expect(import("../src/config.js")).rejects.toThrow("USAGE_LEDGER_ENABLED");
  });
  it("keeps background close disabled by default", async () => {
    const { apiConfig } = await import("../src/config.js");
    expect(apiConfig.backgroundSessionCloseEnabled).toBe(false);
  });
  it("requires the ledger before enabling background close", async () => {
    vi.stubEnv("BACKGROUND_SESSION_CLOSE_ENABLED", "true");
    await expect(import("../src/config.js")).rejects.toThrow("USAGE_LEDGER_ENABLED");
  });
  it("accepts background close only with the ledger enabled", async () => {
    vi.stubEnv("BACKGROUND_SESSION_CLOSE_ENABLED", "true");
    vi.stubEnv("USAGE_LEDGER_ENABLED", "true");
    const { apiConfig } = await import("../src/config.js");
    expect(apiConfig.backgroundSessionCloseEnabled).toBe(true);
  });
  it.each(["", "1", "yes", "FALSE"])("rejects an invalid background flag %j", async (value) => {
    vi.stubEnv("BACKGROUND_SESSION_CLOSE_ENABLED", value);
    await expect(import("../src/config.js")).rejects.toThrow("BACKGROUND_SESSION_CLOSE_ENABLED");
  });
});
