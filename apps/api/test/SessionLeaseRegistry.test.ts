import { describe, expect, it, vi } from "vitest";
import { SessionLeaseRegistry } from "../src/security/SessionLeaseRegistry.js";

describe("SessionLeaseRegistry", () => {
  it("rejects the sixth lease", () => {
    const registry = new SessionLeaseRegistry(5, 15 * 60 * 1000);

    for (let leaseNumber = 0; leaseNumber < 5; leaseNumber += 1) {
      expect(registry.acquire(0)).not.toBeNull();
    }

    expect(registry.acquire(0)).toBeNull();
    expect(registry.activeLeases).toBe(5);
  });

  it("keeps bound sessions active until their session id is released", () => {
    const registry = new SessionLeaseRegistry(5, 15 * 60 * 1000);

    for (let sessionNumber = 0; sessionNumber < 5; sessionNumber += 1) {
      const lease = registry.acquire(0);
      expect(lease).not.toBeNull();
      if (lease === null) continue;
      registry.bindSession(lease.leaseId, `session-${sessionNumber}`);
    }

    expect(registry.acquire(0)).toBeNull();
    expect(registry.releaseSession("session-2", 0)).toBe(true);
    expect(registry.acquire(0)).not.toBeNull();
  });

  it("T2: starts an unbound lease TTL at acquisition time", () => {
    const registry = new SessionLeaseRegistry(1, 15 * 60 * 1000);

    expect(registry.acquire(0)).not.toBeNull();
    expect(registry.acquire(15 * 60 * 1000 - 1)).toBeNull();
    expect(registry.acquire(15 * 60 * 1000)).not.toBeNull();
    expect(registry.activeLeases).toBe(1);
  });

  it("T1: starts a bound session TTL at bind time", () => {
    const ttlMs = 15 * 60 * 1000;
    const registry = new SessionLeaseRegistry(1, ttlMs);
    const lease = registry.acquire(0);

    expect(lease).not.toBeNull();
    if (lease === null) return;
    registry.bindSession(lease.leaseId, "session-1", 2 * 60 * 1000);

    expect(registry.acquire(17 * 60 * 1000 - 1)).toBeNull();
    expect(registry.acquire(17 * 60 * 1000)).not.toBeNull();
  });

  it("expires bound sessions after fifteen minutes", () => {
    const registry = new SessionLeaseRegistry(1, 15 * 60 * 1000);
    const lease = registry.acquire(0);

    expect(lease).not.toBeNull();
    if (lease === null) return;
    registry.bindSession(lease.leaseId, "session-1", 0);

    expect(registry.acquire(15 * 60 * 1000 - 1)).toBeNull();
    expect(registry.acquire(15 * 60 * 1000)).not.toBeNull();
  });

  it("releases a lease explicitly", () => {
    const registry = new SessionLeaseRegistry(1, 15 * 60 * 1000);
    const lease = registry.acquire(0);

    expect(lease).not.toBeNull();
    lease?.release();

    expect(registry.activeLeases).toBe(0);
  });

  it("makes unknown and duplicate session releases harmless", () => {
    const registry = new SessionLeaseRegistry(1, 15 * 60 * 1000);
    const lease = registry.acquire(0);

    expect(registry.releaseSession("unknown", 0)).toBe(false);
    expect(lease).not.toBeNull();
    if (lease === null) return;

    registry.bindSession(lease.leaseId, "session-1", 0);
    expect(registry.releaseSession("session-1", 0)).toBe(true);
    expect(registry.releaseSession("session-1", 0)).toBe(false);
    expect(registry.activeLeases).toBe(0);
  });

  it("uses random UUIDs for lease identifiers", () => {
    const randomUUID = vi.spyOn(crypto, "randomUUID").mockReturnValue(
      "00000000-0000-4000-8000-000000000001",
    );
    const registry = new SessionLeaseRegistry(1, 15 * 60 * 1000);

    const lease = registry.acquire(0);

    expect(lease?.leaseId).toBe("00000000-0000-4000-8000-000000000001");
    randomUUID.mockRestore();
  });
});
