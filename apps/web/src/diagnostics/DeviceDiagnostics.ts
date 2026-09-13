export interface DeviceDiagnosticsSnapshot {
  connectionState: RTCPeerConnectionState | null;
  iceGatheringState: RTCIceGatheringState | null;
  dataChannelState: RTCDataChannelState | null;
  sessionId: string | null;
  usageSeconds: number | null;
}

/**
 * Development-only, non-content diagnostics for the Live WebRTC transport
 * (binding spec 1.2.1 §23 step 8). Records connection/ICE/data-channel
 * state, the session id, and final usage seconds only — never transcript or
 * audio content.
 */
export class DeviceDiagnostics {
  private snapshot: DeviceDiagnosticsSnapshot = {
    connectionState: null,
    iceGatheringState: null,
    dataChannelState: null,
    sessionId: null,
    usageSeconds: null,
  };

  constructor(private readonly enabled = true) {}

  recordConnectionState(state: RTCPeerConnectionState): void {
    if (!this.enabled) return;
    this.snapshot = { ...this.snapshot, connectionState: state };
  }

  recordIceGatheringState(state: RTCIceGatheringState): void {
    if (!this.enabled) return;
    this.snapshot = { ...this.snapshot, iceGatheringState: state };
  }

  recordDataChannelState(state: RTCDataChannelState): void {
    if (!this.enabled) return;
    this.snapshot = { ...this.snapshot, dataChannelState: state };
  }

  recordSessionId(sessionId: string): void {
    if (!this.enabled) return;
    this.snapshot = { ...this.snapshot, sessionId };
  }

  recordUsageSeconds(usageSeconds: number): void {
    if (!this.enabled) return;
    this.snapshot = { ...this.snapshot, usageSeconds };
  }

  getSnapshot(): DeviceDiagnosticsSnapshot {
    return { ...this.snapshot };
  }
}
