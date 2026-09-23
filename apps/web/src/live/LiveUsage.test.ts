import { describe, expect, it, vi } from "vitest";
import type { BackendClient } from "../api/BackendClient";
import { LiveClient } from "./LiveClient";
function fixture() {
  const sink = vi.fn(), peer = { close: vi.fn() }, channel = { close: vi.fn() };
  const client = new LiveClient({ backend: {} as BackendClient, peerFactory: () => peer as unknown as RTCPeerConnection, onRemoteStream: () => {},
    accounting: { managed: false, create: vi.fn(), handoff: vi.fn(), finish: vi.fn(), abandon: vi.fn(), observeUsage: sink } });
  // Isolate the actual message/teardown handlers from SDP establishment (covered by LiveClient.test).
  Object.assign(client, { peer, channel });
  const dispatch = (payload: unknown) => (client as unknown as { handleChannelMessage(e: MessageEvent<string>): void }).handleChannelMessage(new MessageEvent("message", { data: JSON.stringify(payload) }));
  return { client, sink, peer, channel, dispatch };
}
describe("generation-independent Live accounting sink", () => {
  it("receives final usage even when a product callback throws, without delaying teardown", () => {
    const f = fixture(), diagnostics = vi.fn();
    f.client.onSessionClosed = () => { expect(f.peer.close).toHaveBeenCalledTimes(1); throw new Error("consumer bug"); };
    f.client.onUsage = diagnostics;
    expect(() => f.dispatch({ type: "session.closed", usage: { seconds: 46 } })).toThrow("consumer bug");
    expect(f.sink).toHaveBeenCalledWith({ kind: "provider_closed", seconds: 46 });
    expect(diagnostics).toHaveBeenCalledWith({ seconds: 46 });
  });
  it("reports a close without seconds rather than converting it to final zero", () => {
    const f = fixture(); f.dispatch({ type: "session.closed" });
    expect(f.sink).toHaveBeenCalledWith({ kind: "provider_closed" }); expect(f.peer.close).toHaveBeenCalledTimes(1);
  });
  it("a broken accounting observer cannot prevent transport cleanup", () => {
    const f = fixture(); f.sink.mockImplementation(() => { throw new Error("metrics consumer bug"); });
    const log = vi.spyOn(console, "error").mockImplementation(() => {});
    expect(() => f.dispatch({ type: "session.closed", usage: { seconds: 46 } })).not.toThrow();
    expect(f.peer.close).toHaveBeenCalledTimes(1); expect(log).toHaveBeenCalled(); log.mockRestore();
  });
});
