import { afterEach, describe, expect, it, vi } from "vitest";
import { AckRegistry, AckTimeoutError } from "./AckRegistry";

describe("AckRegistry", () => {
  afterEach(() => {
    vi.useRealTimers();
  });

  it("resolves only the matching client_event_id", async () => {
    const registry = new AckRegistry();
    const wait = registry.waitFor("event-1", 3000);
    registry.accept({ client_event_id: "event-2" });
    expect(registry.pendingCount).toBe(1);
    registry.accept({ client_event_id: "event-1" });
    await expect(wait).resolves.toBeDefined();
  });

  it("rejects the waiter after the acknowledgment timeout", async () => {
    vi.useFakeTimers();
    const registry = new AckRegistry();
    const wait = registry.waitFor("event-1", 3000);

    const assertion = expect(wait).rejects.toSatisfy(
      (error: unknown) =>
        error instanceof AckTimeoutError && error.eventId === "event-1",
    );
    await vi.advanceTimersByTimeAsync(3000);
    await assertion;
    expect(registry.pendingCount).toBe(0);
  });

  it("ignores an acknowledgment that has no client_event_id", async () => {
    const registry = new AckRegistry();
    const wait = registry.waitFor("event-1", 3000);
    registry.accept({});
    expect(registry.pendingCount).toBe(1);
    registry.accept({ client_event_id: "event-1" });
    await expect(wait).resolves.toBeDefined();
  });

  it("rejects the matching waiter when a correlated error arrives", async () => {
    const registry = new AckRegistry();
    const wait = registry.waitFor("event-1", 3000);
    registry.fail({
      client_event_id: "event-1",
      message: "append rejected",
    });
    await expect(wait).rejects.toThrow("append rejected");
    expect(registry.pendingCount).toBe(0);
  });

  it("throws if waitFor is called twice for the same event id", () => {
    const registry = new AckRegistry();
    registry.waitFor("event-1", 3000);
    expect(() => registry.waitFor("event-1", 3000)).toThrow(
      'Acknowledgment waiter already exists for event "event-1"',
    );
  });

  it("rejects every pending waiter when rejectAll is called", async () => {
    const registry = new AckRegistry();
    const wait = registry.waitFor("event-1", 3000);
    registry.rejectAll(new Error("session closed"));
    await expect(wait).rejects.toThrow("session closed");
    expect(registry.pendingCount).toBe(0);
  });

  it("clears the timeout when fail() rejects the waiter", async () => {
    vi.useFakeTimers();
    const registry = new AckRegistry();
    const wait = registry.waitFor("event-1", 3000);
    registry.fail({
      client_event_id: "event-1",
      message: "channel is not open",
    });
    await expect(wait).rejects.toThrow("channel is not open");
    await vi.advanceTimersByTimeAsync(3000);
    expect(registry.pendingCount).toBe(0);
  });
});
