import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

beforeEach(() => {
  vi.resetModules();
  vi.stubEnv("NODE_ENV", "test");
  vi.stubEnv("WEB_ORIGIN", "http://localhost:5173");
  vi.stubEnv("USAGE_LEDGER_ENABLED", undefined);
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
});
