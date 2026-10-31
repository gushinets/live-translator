import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

beforeEach(() => {
  vi.resetModules();
  vi.stubEnv("NODE_ENV", "test");
  vi.stubEnv("WEB_ORIGIN", "http://localhost:5173");
  vi.stubEnv("USAGE_LEDGER_ENABLED", undefined);
  vi.stubEnv("BACKGROUND_SESSION_CLOSE_ENABLED", undefined);
  vi.stubEnv("CONVERSATION_DIAGNOSTICS_ENABLED", undefined);
  vi.stubEnv("CONVERSATION_DIAGNOSTICS_TEXT_ENABLED", undefined);
  vi.stubEnv("DIAGNOSTICS_DB_PATH", undefined);
});
afterEach(() => vi.unstubAllEnvs());

describe("ledger rollout configuration", () => {
  it("requires the ledger and separate database before collecting diagnostics", async () => {
    vi.stubEnv("CONVERSATION_DIAGNOSTICS_ENABLED", "true");
    await expect(import("../src/config.js")).rejects.toThrow("USAGE_LEDGER_ENABLED");
    vi.resetModules(); vi.stubEnv("USAGE_LEDGER_ENABLED", "true");
    vi.stubEnv("DIAGNOSTICS_DB_PATH", process.env.USAGE_DB_PATH!);
    await expect(import("../src/config.js")).rejects.toThrow("separate paths");
  });
  it("requires an explicit diagnostics rollout before allowing test text", async () => {
    vi.stubEnv("CONVERSATION_DIAGNOSTICS_TEXT_ENABLED", "true");
    await expect(import("../src/config.js")).rejects.toThrow("CONVERSATION_DIAGNOSTICS_ENABLED");
  });
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
