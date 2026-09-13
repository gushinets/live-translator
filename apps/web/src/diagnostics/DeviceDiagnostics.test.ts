import { describe, expect, it } from "vitest";
import { DeviceDiagnostics } from "./DeviceDiagnostics";

describe("DeviceDiagnostics", () => {
  it("starts with an empty, all-null snapshot", () => {
    const diagnostics = new DeviceDiagnostics();
    expect(diagnostics.getSnapshot()).toEqual({
      connectionState: null,
      iceGatheringState: null,
      dataChannelState: null,
      sessionId: null,
      usageSeconds: null,
    });
  });

  it("records only connection, ICE, data-channel, session id, and usage fields", () => {
    const diagnostics = new DeviceDiagnostics();

    diagnostics.recordConnectionState("connected");
    diagnostics.recordIceGatheringState("complete");
    diagnostics.recordDataChannelState("open");
    diagnostics.recordSessionId("sess_123");
    diagnostics.recordUsageSeconds(42);

    expect(diagnostics.getSnapshot()).toEqual({
      connectionState: "connected",
      iceGatheringState: "complete",
      dataChannelState: "open",
      sessionId: "sess_123",
      usageSeconds: 42,
    });
  });

  it("does nothing when disabled", () => {
    const diagnostics = new DeviceDiagnostics(false);

    diagnostics.recordConnectionState("connected");
    diagnostics.recordSessionId("sess_123");

    expect(diagnostics.getSnapshot()).toEqual({
      connectionState: null,
      iceGatheringState: null,
      dataChannelState: null,
      sessionId: null,
      usageSeconds: null,
    });
  });

  it("exposes only the whitelisted diagnostic keys, never transcript/audio content", () => {
    const diagnostics = new DeviceDiagnostics();
    const keys = Object.keys(diagnostics.getSnapshot()).sort();
    expect(keys).toEqual(
      [
        "connectionState",
        "dataChannelState",
        "iceGatheringState",
        "sessionId",
        "usageSeconds",
      ].sort(),
    );
  });
});
