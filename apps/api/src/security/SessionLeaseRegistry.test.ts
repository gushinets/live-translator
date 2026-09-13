import { describe, expect, it, vi } from "vitest";
import { SessionLeaseRegistry } from "./SessionLeaseRegistry.js";

describe("SessionLeaseRegistry", () => {
  it("rejects the sixth lease", () => {
    const registry = new SessionLeaseRegistry(5, 15 * 60 * 1000);

    for (let leaseNumber = 0; leaseNumber < 5; leaseNumber += 1) {
      expect(registry.acquire(0)).not.toBeNull();
    }

    expect(registry.acquire(0)).toBeNull();
    expect(registry.activeLeases).toBe(5);
  });

  it("expires leases after fifteen minutes", () => {
    const registry = new SessionLeaseRegistry(1, 15 * 60 * 1000);

    expect(registry.acquire(0)).not.toBeNull();
    expect(registry.acquire(15 * 60 * 1000 - 1)).toBeNull();
    expect(registry.acquire(15 * 60 * 1000)).not.toBeNull();
    expect(registry.activeLeases).toBe(1);
  });

  it("releases a lease explicitly", () => {
    const registry = new SessionLeaseRegistry(1, 15 * 60 * 1000);
    const lease = registry.acquire(0);

    expect(lease).not.toBeNull();
    lease?.release();

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
