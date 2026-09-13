import { afterEach, describe, expect, it, vi } from "vitest";
import { waitForIceComplete } from "./waitForIceComplete";

function makeFakePeer(initialState: RTCIceGatheringState) {
  let state = initialState;
  const listeners = new Set<() => void>();
  return {
    listeners,
    get iceGatheringState() {
      return state;
    },
    addEventListener: (_type: string, listener: () => void) => {
      listeners.add(listener);
    },
    removeEventListener: (_type: string, listener: () => void) => {
      listeners.delete(listener);
    },
    setState(next: RTCIceGatheringState) {
      state = next;
      for (const listener of listeners) listener();
    },
  };
}

describe("waitForIceComplete", () => {
  afterEach(() => {
    vi.useRealTimers();
  });

  it("resolves immediately when ICE gathering is already complete", async () => {
    const peer = makeFakePeer("complete");
    await expect(
      waitForIceComplete(peer as unknown as RTCPeerConnection, 10_000),
    ).resolves.toBeUndefined();
  });

  it("resolves once iceGatheringState transitions to complete", async () => {
    const peer = makeFakePeer("gathering");
    const promise = waitForIceComplete(
      peer as unknown as RTCPeerConnection,
      10_000,
    );
    peer.setState("complete");
    await expect(promise).resolves.toBeUndefined();
  });

  it("rejects after 10 seconds if ICE never completes", async () => {
    vi.useFakeTimers();
    const peer = makeFakePeer("gathering");
    const promise = waitForIceComplete(
      peer as unknown as RTCPeerConnection,
      10_000,
    );
    const assertion = expect(promise).rejects.toThrow(
      "Unable to establish live connection",
    );
    await vi.advanceTimersByTimeAsync(10_000);
    await assertion;
  });

  it("does not leak the icegatheringstatechange listener after completing", async () => {
    const peer = makeFakePeer("gathering");
    const promise = waitForIceComplete(
      peer as unknown as RTCPeerConnection,
      10_000,
    );
    peer.setState("complete");
    await promise;
    expect(peer.listeners.size).toBe(0);
  });
});
