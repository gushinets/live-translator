import { BackendClient } from "../api/BackendClient";
import { DeviceDiagnostics } from "../diagnostics/DeviceDiagnostics";
import { LiveClient, type LiveCloseResult } from "../live/LiveClient";
import type {
  DevSpikeConnection,
  DevSpikeSession,
} from "./DevSpikeScreen";

export class BrowserDevSpikeSession implements DevSpikeSession {
  private readonly diagnostics = new DeviceDiagnostics(import.meta.env.DEV);
  private liveClient: LiveClient | null = null;
  private microphoneStream: MediaStream | null = null;

  async connect(
    onRemoteStream: (stream: MediaStream) => void,
  ): Promise<DevSpikeConnection> {
    try {
      const microphoneStream = await navigator.mediaDevices.getUserMedia({
        audio: {
          echoCancellation: true,
          noiseSuppression: false,
        },
      });
      this.microphoneStream = microphoneStream;

      const audioTrack = microphoneStream.getAudioTracks()[0];
      if (audioTrack === undefined) {
        throw new Error("Microphone stream has no audio track");
      }

      const liveClient = new LiveClient({
        backend: new BackendClient(),
        peerFactory: () => this.createObservedPeer(),
        onRemoteStream,
      });
      this.liveClient = liveClient;
      liveClient.onUsage = (usage) => {
        if (usage.seconds !== undefined) {
          this.diagnostics.recordUsageSeconds(usage.seconds);
        }
      };

      const { sessionId } = await liveClient.connect(microphoneStream);
      this.diagnostics.recordSessionId(sessionId);

      return {
        sessionId,
        microphoneSettings: audioTrack.getSettings(),
        diagnostics: this.diagnostics.getSnapshot(),
      };
    } catch (error) {
      console.error("DEV Live transport connection failed", {
        error,
        diagnostics: this.diagnostics.getSnapshot(),
      });
      this.stopMicrophone();
      throw error;
    }
  }

  async close(): Promise<LiveCloseResult> {
    if (this.liveClient === null) {
      throw new Error("Cannot end the DEV spike before connecting");
    }

    try {
      const result = await this.liveClient.close();
      if (result.usageSeconds !== undefined) {
        this.diagnostics.recordUsageSeconds(result.usageSeconds);
      }
      return result;
    } finally {
      this.stopMicrophone();
    }
  }

  private createObservedPeer(): RTCPeerConnection {
    const peer = new RTCPeerConnection();
    this.recordPeerState(peer);
    peer.addEventListener("connectionstatechange", () => {
      this.diagnostics.recordConnectionState(peer.connectionState);
    });
    peer.addEventListener("icegatheringstatechange", () => {
      this.diagnostics.recordIceGatheringState(peer.iceGatheringState);
    });

    const createDataChannel = peer.createDataChannel.bind(peer);
    peer.createDataChannel = (...args): RTCDataChannel => {
      const channel = createDataChannel(...args);
      this.diagnostics.recordDataChannelState(channel.readyState);
      channel.addEventListener("open", () => {
        this.diagnostics.recordDataChannelState(channel.readyState);
      });
      channel.addEventListener("close", () => {
        this.diagnostics.recordDataChannelState(channel.readyState);
      });
      return channel;
    };

    return peer;
  }

  private recordPeerState(peer: RTCPeerConnection): void {
    this.diagnostics.recordConnectionState(peer.connectionState);
    this.diagnostics.recordIceGatheringState(peer.iceGatheringState);
  }

  private stopMicrophone(): void {
    if (this.microphoneStream === null) {
      return;
    }
    for (const track of this.microphoneStream.getTracks()) {
      track.stop();
    }
    this.microphoneStream = null;
  }
}

export function createBrowserDevSpikeSession(): BrowserDevSpikeSession {
  return new BrowserDevSpikeSession();
}
