import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { BackendClient } from "../api/BackendClient";
import { runtime } from "../config/runtime";
import { AckTimeoutError } from "./AckRegistry";
import { LiveClient } from "./LiveClient";
import {
  APPEND_CHAR_BUDGET,
  ContextTooLongError,
  type SessionClosedEvent,
} from "./LiveEvents";

class FakeDataChannel extends EventTarget {
  readyState: RTCDataChannelState = "open";
  readonly sendCalls: string[] = [];
  closeCalls = 0;

  constructor(readonly label: string) {
    super();
  }

  send(data: string): void {
    this.sendCalls.push(data);
  }

  close(): void {
    this.closeCalls += 1;
    this.readyState = "closed";
    // Real RTCDataChannel implementations fire "close" when torn down.
    this.dispatchEvent(new Event("close"));
  }

  emitMessage(payload: unknown): void {
    this.dispatchEvent(
      new MessageEvent("message", { data: JSON.stringify(payload) }),
    );
  }

  /** Simulates the remote side (or the network) closing the channel. */
  emitClose(): void {
    this.readyState = "closed";
    this.dispatchEvent(new Event("close"));
  }
}

class FakePeerConnection extends EventTarget {
  readonly calls: string[] = [];
  iceGatheringState: RTCIceGatheringState = "new";
  connectionState: RTCPeerConnectionState = "new";
  localDescription: RTCSessionDescriptionInit | null = null;
  remoteDescription: RTCSessionDescriptionInit | null = null;
  readonly addTrackCalls: unknown[] = [];
  closeCalls = 0;
  dataChannel: FakeDataChannel | null = null;

  createDataChannel(label: string): RTCDataChannel {
    this.calls.push("createDataChannel");
    this.dataChannel = new FakeDataChannel(label);
    return this.dataChannel as unknown as RTCDataChannel;
  }

  addTrack(track: MediaStreamTrack, stream: MediaStream): RTCRtpSender {
    this.calls.push("addTrack");
    this.addTrackCalls.push({ track, stream });
    return {} as RTCRtpSender;
  }

  async createOffer(): Promise<RTCSessionDescriptionInit> {
    this.calls.push("createOffer");
    return { type: "offer", sdp: "v=0 fake-offer-sdp" };
  }

  async setLocalDescription(
    description: RTCSessionDescriptionInit,
  ): Promise<void> {
    this.calls.push("setLocalDescription");
    this.localDescription = description;
    this.iceGatheringState = "complete";
  }

  async setRemoteDescription(
    description: RTCSessionDescriptionInit,
  ): Promise<void> {
    this.calls.push("setRemoteDescription");
    this.remoteDescription = description;
  }

  close(): void {
    this.closeCalls += 1;
    this.connectionState = "closed";
    // Real RTCPeerConnection implementations fire "connectionstatechange"
    // when the connection transitions to "closed".
    this.dispatchEvent(new Event("connectionstatechange"));
  }

  emitTrack(streams: MediaStream[]): void {
    const event = new Event("track") as RTCTrackEvent;
    Object.defineProperty(event, "streams", { value: streams });
    this.dispatchEvent(event);
  }

  /** Simulates an out-of-band connection-state transition (e.g. failure). */
  emitConnectionStateChange(state: RTCPeerConnectionState): void {
    this.connectionState = state;
    this.dispatchEvent(new Event("connectionstatechange"));
  }
}

function makeFakeStream(trackCount = 1): MediaStream {
  const tracks = Array.from({ length: trackCount }, (_, index) => ({
    id: `track-${index}`,
    kind: "audio",
  })) as unknown as MediaStreamTrack[];
  return { getTracks: () => tracks } as unknown as MediaStream;
}

function makeFakeBackend(
  overrides: Partial<{
    sessionId: string;
    answerSdp: string;
  }> = {},
) {
  const calls: string[] = [];
  const backend: BackendClient = {
    createLiveSession: async (sdp: string) => {
      calls.push(sdp);
      return {
        session: { id: overrides.sessionId ?? "sess_123" },
        transport: {
          type: "webrtc" as const,
          sdp: overrides.answerSdp ?? "v=0 fake-answer-sdp",
        },
      };
    },
  } as unknown as BackendClient;
  return { backend, calls };
}

describe("LiveClient.connect", () => {
  let peer: FakePeerConnection;
  let onRemoteStream: ReturnType<typeof vi.fn>;

  beforeEach(() => {
    peer = new FakePeerConnection();
    onRemoteStream = vi.fn();
  });

  function makeClient(backend: BackendClient) {
    return new LiveClient({
      backend,
      peerFactory: () => peer as unknown as RTCPeerConnection,
      onRemoteStream,
    });
  }

  it("follows the official connect sequence and resolves only after session.started", async () => {
    const { backend, calls: backendCalls } = makeFakeBackend();
    const client = makeClient(backend);
    const stream = makeFakeStream();

    let resolved = false;
    const connectPromise = client.connect(stream).then((result) => {
      resolved = true;
      return result;
    });

    await vi.waitFor(() => {
      expect(peer.calls).toContain("setRemoteDescription");
    });

    expect(peer.calls).toEqual([
      "createDataChannel",
      "addTrack",
      "createOffer",
      "setLocalDescription",
      "setRemoteDescription",
    ]);
    expect(backendCalls).toEqual(["v=0 fake-offer-sdp"]);
    expect(peer.dataChannel?.label).toBe("oai-events");
    expect(resolved).toBe(false);

    peer.dataChannel?.emitMessage({
      type: "session.started",
      session: { id: "sess_123" },
    });

    await expect(connectPromise).resolves.toEqual({ sessionId: "sess_123" });
  });

  it("creates the data channel before adding tracks or creating the offer", async () => {
    const { backend } = makeFakeBackend();
    const client = makeClient(backend);
    const connectPromise = client.connect(makeFakeStream());

    await vi.waitFor(() => {
      expect(peer.calls).toContain("setRemoteDescription");
    });
    const dataChannelIndex = peer.calls.indexOf("createDataChannel");
    const addTrackIndex = peer.calls.indexOf("addTrack");
    const createOfferIndex = peer.calls.indexOf("createOffer");
    expect(dataChannelIndex).toBe(0);
    expect(dataChannelIndex).toBeLessThan(addTrackIndex);
    expect(addTrackIndex).toBeLessThan(createOfferIndex);

    peer.dataChannel?.emitMessage({
      type: "session.started",
      session: { id: "sess_123" },
    });
    await connectPromise;
  });

  it("adds every microphone track from the provided stream", async () => {
    const { backend } = makeFakeBackend();
    const client = makeClient(backend);
    const stream = makeFakeStream(2);
    const connectPromise = client.connect(stream);

    await vi.waitFor(() => {
      expect(peer.addTrackCalls).toHaveLength(2);
    });

    peer.dataChannel?.emitMessage({
      type: "session.started",
      session: { id: "sess_123" },
    });
    await connectPromise;
  });

  it("never sends a session.start command on the data channel", async () => {
    const { backend } = makeFakeBackend();
    const client = makeClient(backend);
    const connectPromise = client.connect(makeFakeStream());

    await vi.waitFor(() => {
      expect(peer.calls).toContain("setRemoteDescription");
    });
    expect(peer.dataChannel?.sendCalls).toEqual([]);

    peer.dataChannel?.emitMessage({
      type: "session.started",
      session: { id: "sess_123" },
    });
    await connectPromise;
    expect(peer.dataChannel?.sendCalls).toEqual([]);
  });

  it("forwards remote tracks to onRemoteStream", async () => {
    const { backend } = makeFakeBackend();
    const client = makeClient(backend);
    const connectPromise = client.connect(makeFakeStream());

    await vi.waitFor(() => {
      expect(peer.calls).toContain("setRemoteDescription");
    });
    const remoteStream = makeFakeStream();
    peer.emitTrack([remoteStream]);
    expect(onRemoteStream).toHaveBeenCalledWith(remoteStream);

    peer.dataChannel?.emitMessage({
      type: "session.started",
      session: { id: "sess_123" },
    });
    await connectPromise;
  });

  it("rejects when ICE gathering never completes within the timeout, and tears down the peer and data channel", async () => {
    vi.useFakeTimers();
    peer.setLocalDescription = async (
      description: RTCSessionDescriptionInit,
    ) => {
      peer.calls.push("setLocalDescription");
      peer.localDescription = description;
      // ICE never completes.
    };
    const { backend } = makeFakeBackend();
    const client = makeClient(backend);

    const connectPromise = client.connect(makeFakeStream());
    const assertion = expect(connectPromise).rejects.toThrow(
      "Timed out while gathering ICE candidates",
    );
    await vi.advanceTimersByTimeAsync(10_000);
    await assertion;
    vi.useRealTimers();

    expect(peer.dataChannel?.closeCalls).toBe(1);
    expect(peer.closeCalls).toBe(1);
  });

  it("tears down the peer and data channel if the backend rejects session creation", async () => {
    const backend: BackendClient = {
      createLiveSession: async () => {
        throw new Error("Live session creation failed");
      },
    } as unknown as BackendClient;
    const client = makeClient(backend);

    await expect(client.connect(makeFakeStream())).rejects.toThrow(
      "Live session creation failed",
    );

    expect(peer.dataChannel?.closeCalls).toBe(1);
    expect(peer.closeCalls).toBe(1);
  });

  it("throws when connect() is called a second time on the same instance", async () => {
    const { backend } = makeFakeBackend();
    const client = makeClient(backend);
    const stream = makeFakeStream();

    const firstConnectPromise = client.connect(stream);
    // connect() is async, so a synchronous guard still surfaces as a
    // rejected promise rather than a thrown error.
    await expect(client.connect(stream)).rejects.toThrow(
      "connect() has already been called on this LiveClient",
    );

    await vi.waitFor(() => {
      expect(peer.calls).toContain("setRemoteDescription");
    });
    peer.dataChannel?.emitMessage({
      type: "session.started",
      session: { id: "sess_123" },
    });
    await firstConnectPromise;
  });

  it("throws when connect() is called a second time even though peerFactory() threw on the first attempt", async () => {
    const { backend } = makeFakeBackend();
    const throwingClient = new LiveClient({
      backend,
      peerFactory: () => {
        throw new Error("WebRTC is not supported in this browser");
      },
      onRemoteStream: vi.fn(),
    });

    await expect(throwingClient.connect(makeFakeStream())).rejects.toThrow(
      "WebRTC is not supported in this browser",
    );
    // A dedicated connectCalled flag (set before peerFactory() is even
    // invoked) means a second attempt is rejected as "already called"
    // rather than re-invoking peerFactory() and throwing the same error
    // again.
    await expect(throwingClient.connect(makeFakeStream())).rejects.toThrow(
      "connect() has already been called on this LiveClient",
    );
  });

  it("rejects connect() (instead of hanging) if the data channel closes before session.started arrives, and tears down", async () => {
    const { backend } = makeFakeBackend();
    const client = makeClient(backend);
    const connectPromise = client.connect(makeFakeStream());
    await vi.waitFor(() => {
      expect(peer.calls).toContain("setRemoteDescription");
    });

    peer.dataChannel?.emitClose();

    await expect(connectPromise).rejects.toThrow(
      "Data channel closed before session.started",
    );
    expect(peer.dataChannel?.closeCalls).toBe(1);
    expect(peer.closeCalls).toBe(1);
  });

  it("rejects connect() (instead of hanging) if the peer connection fails before session.started arrives, and tears down", async () => {
    const { backend } = makeFakeBackend();
    const client = makeClient(backend);
    const connectPromise = client.connect(makeFakeStream());
    await vi.waitFor(() => {
      expect(peer.calls).toContain("setRemoteDescription");
    });

    peer.emitConnectionStateChange("failed");

    await expect(connectPromise).rejects.toThrow(
      'Peer connection state changed to "failed" before session.started',
    );
    expect(peer.dataChannel?.closeCalls).toBe(1);
    expect(peer.closeCalls).toBe(1);
  });

  it("rejects connect() (instead of hanging) if session.closed arrives before session.started, and tears down", async () => {
    const { backend } = makeFakeBackend();
    const client = makeClient(backend);
    const connectPromise = client.connect(makeFakeStream());
    await vi.waitFor(() => {
      expect(peer.calls).toContain("setRemoteDescription");
    });

    peer.dataChannel?.emitMessage({
      type: "session.closed",
      reason: "server_ended",
    });

    await expect(connectPromise).rejects.toThrow(
      "session.closed received before session.started",
    );
    expect(peer.dataChannel?.closeCalls).toBe(1);
    expect(peer.closeCalls).toBe(1);
  });

  it("rejects connect() (instead of hanging) if a server error event arrives before session.started, and tears down", async () => {
    const { backend } = makeFakeBackend();
    const client = makeClient(backend);
    const connectPromise = client.connect(makeFakeStream());
    await vi.waitFor(() => {
      expect(peer.calls).toContain("setRemoteDescription");
    });

    peer.dataChannel?.emitMessage({
      type: "error",
      error: { message: "boom" },
    });

    await expect(connectPromise).rejects.toThrow(
      "Live session reported an error before session.started: boom",
    );
    expect(peer.dataChannel?.closeCalls).toBe(1);
    expect(peer.closeCalls).toBe(1);
  });

  it("tears down the transport before invoking onError for a pre-start server error", async () => {
    const { backend } = makeFakeBackend();
    const client = makeClient(backend);
    const connectPromise = client.connect(makeFakeStream());
    await vi.waitFor(() => {
      expect(peer.calls).toContain("setRemoteDescription");
    });

    let peerCloseCallsInOnError = -1;
    let channelCloseCallsInOnError = -1;
    client.onError = () => {
      peerCloseCallsInOnError = peer.closeCalls;
      channelCloseCallsInOnError = peer.dataChannel?.closeCalls ?? -1;
    };

    peer.dataChannel?.emitMessage({
      type: "error",
      error: { message: "boom" },
    });

    expect(peerCloseCallsInOnError).toBe(1);
    expect(channelCloseCallsInOnError).toBe(1);

    await expect(connectPromise).rejects.toThrow(
      "Live session reported an error before session.started: boom",
    );
  });

  it("rejects connect() (instead of hanging) if close() is called before session.started arrives", async () => {
    const { backend } = makeFakeBackend();
    const client = makeClient(backend);
    const connectPromise = client.connect(makeFakeStream());
    await vi.waitFor(() => {
      expect(peer.calls).toContain("setRemoteDescription");
    });

    const closePromise = client.close();
    await expect(connectPromise).rejects.toThrow(
      "Live session close started before session.started",
    );
    peer.dataChannel?.emitMessage({ type: "session.closed" });
    await closePromise;
  });

  it("aborts signaling and never POSTs the SDP if the data channel closes during ICE gathering", async () => {
    vi.useFakeTimers();
    peer.setLocalDescription = async (
      description: RTCSessionDescriptionInit,
    ) => {
      peer.calls.push("setLocalDescription");
      peer.localDescription = description;
      // ICE never completes, mirroring the ICE-timeout test's fake peer.
    };
    const { backend, calls: backendCalls } = makeFakeBackend();
    const client = makeClient(backend);

    const connectPromise = client.connect(makeFakeStream());
    // Flush the createOffer()/setLocalDescription() microtasks so
    // connect() is now inside waitForIceComplete(), without advancing all
    // the way to its 10s timeout.
    await vi.advanceTimersByTimeAsync(0);

    peer.dataChannel?.emitClose();

    await expect(connectPromise).rejects.toThrow(
      "Data channel closed before session.started",
    );
    vi.useRealTimers();

    // The channel closing during ICE gathering must abort connect()
    // immediately, before it ever reaches the backend POST.
    expect(backendCalls).toEqual([]);
    expect(peer.dataChannel?.closeCalls).toBe(1);
    expect(peer.closeCalls).toBe(1);
  });
});

describe("LiveClient event dispatch", () => {
  async function connectedClient() {
    const peer = new FakePeerConnection();
    const onRemoteStream = vi.fn();
    const { backend } = makeFakeBackend();
    const client = new LiveClient({
      backend,
      peerFactory: () => peer as unknown as RTCPeerConnection,
      onRemoteStream,
    });
    const connectPromise = client.connect(makeFakeStream());
    await vi.waitFor(() => {
      expect(peer.calls).toContain("setRemoteDescription");
    });
    peer.dataChannel?.emitMessage({
      type: "session.started",
      session: { id: "sess_123" },
    });
    await connectPromise;
    if (peer.dataChannel === null) throw new Error("data channel missing");
    return { client, peer, channel: peer.dataChannel };
  }

  it("invokes onTranscriptDelta for transcript delta events", async () => {
    const { client, channel } = await connectedClient();
    const onTranscriptDelta = vi.fn();
    client.onTranscriptDelta = onTranscriptDelta;

    channel.emitMessage({
      type: "session.output_transcript.delta",
      delta: "hola",
    });

    expect(onTranscriptDelta).toHaveBeenCalledWith({
      type: "session.output_transcript.delta",
      delta: "hola",
    });
  });

  it("invokes onAppendAcknowledged for append acknowledgment events", async () => {
    const { client, channel } = await connectedClient();
    const onAppendAcknowledged = vi.fn();
    client.onAppendAcknowledged = onAppendAcknowledged;

    channel.emitMessage({
      type: "session.instructions.appended",
      client_event_id: "evt-1",
    });

    expect(onAppendAcknowledged).toHaveBeenCalledWith({
      type: "session.instructions.appended",
      client_event_id: "evt-1",
    });
  });

  it("invokes onMuteAcknowledged for mute/unmute acknowledgment events", async () => {
    const { client, channel } = await connectedClient();
    const onMuteAcknowledged = vi.fn();
    client.onMuteAcknowledged = onMuteAcknowledged;

    channel.emitMessage({ type: "session.input_audio.muted" });

    expect(onMuteAcknowledged).toHaveBeenCalledWith({
      type: "session.input_audio.muted",
    });
  });

  it("invokes onError for error events", async () => {
    const { client, channel } = await connectedClient();
    const onError = vi.fn();
    client.onError = onError;

    channel.emitMessage({ type: "error", error: { message: "boom" } });

    expect(onError).toHaveBeenCalledWith({
      type: "error",
      error: { message: "boom" },
    });
  });

  it("invokes onSessionClosed and onUsage when session.closed arrives", async () => {
    const { client, channel } = await connectedClient();
    const onSessionClosed = vi.fn();
    const onUsage = vi.fn();
    client.onSessionClosed = onSessionClosed;
    client.onUsage = onUsage;

    const closedEvent: SessionClosedEvent = {
      type: "session.closed",
      reason: "user_requested",
      usage: { seconds: 42 },
    };
    channel.emitMessage(closedEvent);

    expect(onSessionClosed).toHaveBeenCalledWith(closedEvent);
    expect(onUsage).toHaveBeenCalledWith({ seconds: 42 });
  });

  it("tears down the transport before invoking onSessionClosed and onUsage for a server-initiated session.closed", async () => {
    const { client, peer, channel } = await connectedClient();
    let peerCloseCallsInOnSessionClosed = -1;
    let peerCloseCallsInOnUsage = -1;
    client.onSessionClosed = () => {
      peerCloseCallsInOnSessionClosed = peer.closeCalls;
    };
    client.onUsage = () => {
      peerCloseCallsInOnUsage = peer.closeCalls;
    };

    channel.emitMessage({
      type: "session.closed",
      reason: "user_requested",
      usage: { seconds: 42 },
    });

    expect(peerCloseCallsInOnSessionClosed).toBe(1);
    expect(peerCloseCallsInOnUsage).toBe(1);
  });
});

describe("LiveClient transport failure handling", () => {
  async function connectedClient() {
    const peer = new FakePeerConnection();
    const onRemoteStream = vi.fn();
    const { backend } = makeFakeBackend();
    const client = new LiveClient({
      backend,
      peerFactory: () => peer as unknown as RTCPeerConnection,
      onRemoteStream,
    });
    const connectPromise = client.connect(makeFakeStream());
    await vi.waitFor(() => {
      expect(peer.calls).toContain("setRemoteDescription");
    });
    peer.dataChannel?.emitMessage({
      type: "session.started",
      session: { id: "sess_123" },
    });
    await connectPromise;
    if (peer.dataChannel === null) throw new Error("data channel missing");
    return { client, peer, channel: peer.dataChannel };
  }

  it("registers the close and connectionstatechange handlers during connect(), before session.started arrives", async () => {
    const peer = new FakePeerConnection();
    const { backend } = makeFakeBackend();
    const client = new LiveClient({
      backend,
      peerFactory: () => peer as unknown as RTCPeerConnection,
      onRemoteStream: vi.fn(),
    });
    const onError = vi.fn();
    client.onError = onError;

    const connectPromise = client.connect(makeFakeStream());
    await vi.waitFor(() => {
      expect(peer.calls).toContain("setRemoteDescription");
    });

    peer.emitConnectionStateChange("failed");
    expect(onError).toHaveBeenCalledWith({
      type: "error",
      error: { message: 'Peer connection state changed to "failed"' },
    });

    // A terminal connection-state failure before session.started also
    // rejects the in-flight connect() instead of leaving it hanging (see
    // the dedicated "rejects connect() ... if the peer connection fails"
    // test for full coverage of that behavior).
    await expect(connectPromise).rejects.toThrow(
      'Peer connection state changed to "failed" before session.started',
    );
  });

  it("invokes onError when the data channel closes unexpectedly", async () => {
    const { client, channel } = await connectedClient();
    const onError = vi.fn();
    client.onError = onError;

    channel.emitClose();

    expect(onError).toHaveBeenCalledWith({
      type: "error",
      error: { message: "Live data channel closed unexpectedly" },
    });
  });

  it("invokes onError when the peer connection enters the failed state", async () => {
    const { client, peer } = await connectedClient();
    const onError = vi.fn();
    client.onError = onError;

    peer.emitConnectionStateChange("failed");

    expect(onError).toHaveBeenCalledWith({
      type: "error",
      error: { message: 'Peer connection state changed to "failed"' },
    });
  });

  it("invokes onError when the peer connection closes unexpectedly (without a graceful close())", async () => {
    const { client, peer } = await connectedClient();
    const onError = vi.fn();
    client.onError = onError;

    peer.emitConnectionStateChange("closed");

    expect(onError).toHaveBeenCalledWith({
      type: "error",
      error: { message: 'Peer connection state changed to "closed"' },
    });
  });

  it("ignores benign connection-state transitions", async () => {
    const { client, peer } = await connectedClient();
    const onError = vi.fn();
    client.onError = onError;

    peer.emitConnectionStateChange("connected");
    peer.emitConnectionStateChange("disconnected");

    expect(onError).not.toHaveBeenCalled();
  });

  it("does not invoke onError when the transport closes gracefully via close()", async () => {
    const { client, channel } = await connectedClient();
    const onError = vi.fn();
    client.onError = onError;

    const closePromise = client.close();
    channel.emitMessage({ type: "session.closed" });
    await closePromise;

    expect(onError).not.toHaveBeenCalled();
  });

  it("does not invoke onError when the server ends the session and the transport subsequently closes, without close() ever being called", async () => {
    const { client, peer, channel } = await connectedClient();
    const onError = vi.fn();
    client.onError = onError;

    // Server-initiated graceful end: no local close() call precedes this.
    channel.emitMessage({ type: "session.closed", reason: "server_ended" });
    channel.emitClose();
    peer.emitConnectionStateChange("closed");

    expect(onError).not.toHaveBeenCalled();
  });

  it("disables send() after an unexpected data channel close once the session has started", async () => {
    const { client, channel } = await connectedClient();

    channel.emitClose();

    expect(() =>
      client.send({ type: "session.input_audio.mute", event_id: "evt-1" }),
    ).toThrow("Cannot send a Live event while the session is closing");
  });

  it("tears down the peer connection after an unexpected data channel close once the session has started", async () => {
    const { peer, channel } = await connectedClient();

    channel.emitClose();

    expect(peer.closeCalls).toBe(1);
    expect(channel.closeCalls).toBe(1);
  });

  it("disables send() after an unexpected peer connection failure once the session has started", async () => {
    const { client, peer } = await connectedClient();

    peer.emitConnectionStateChange("failed");

    expect(() =>
      client.send({ type: "session.input_audio.mute", event_id: "evt-1" }),
    ).toThrow("Cannot send a Live event while the session is closing");
  });

  it("tears down the transport before invoking onError for an unexpected data channel close", async () => {
    const { client, peer, channel } = await connectedClient();
    let peerCloseCallsInOnError = -1;
    let channelCloseCallsInOnError = -1;
    client.onError = () => {
      peerCloseCallsInOnError = peer.closeCalls;
      channelCloseCallsInOnError = channel.closeCalls;
    };

    channel.emitClose();

    expect(peerCloseCallsInOnError).toBe(1);
    expect(channelCloseCallsInOnError).toBe(1);
  });

  it("tears down the transport before invoking onError for an unexpected peer connection failure", async () => {
    const { client, peer, channel } = await connectedClient();
    let peerCloseCallsInOnError = -1;
    let channelCloseCallsInOnError = -1;
    client.onError = () => {
      peerCloseCallsInOnError = peer.closeCalls;
      channelCloseCallsInOnError = channel.closeCalls;
    };

    peer.emitConnectionStateChange("failed");

    expect(peerCloseCallsInOnError).toBe(1);
    expect(channelCloseCallsInOnError).toBe(1);
  });
});

describe("LiveClient.send", () => {
  it("writes the event as JSON onto the data channel once connected", async () => {
    const peer = new FakePeerConnection();
    const { backend } = makeFakeBackend();
    const client = new LiveClient({
      backend,
      peerFactory: () => peer as unknown as RTCPeerConnection,
      onRemoteStream: vi.fn(),
    });
    const connectPromise = client.connect(makeFakeStream());
    await vi.waitFor(() => {
      expect(peer.calls).toContain("setRemoteDescription");
    });
    peer.dataChannel?.emitMessage({
      type: "session.started",
      session: { id: "sess_123" },
    });
    await connectPromise;

    client.send({ type: "session.input_audio.mute", event_id: "evt-1" });

    expect(peer.dataChannel?.sendCalls).toEqual([
      JSON.stringify({ type: "session.input_audio.mute", event_id: "evt-1" }),
    ]);
  });

  it("throws while connect() is in flight and the data channel exists, but session.started has not arrived yet", async () => {
    const peer = new FakePeerConnection();
    const { backend } = makeFakeBackend();
    const client = new LiveClient({
      backend,
      peerFactory: () => peer as unknown as RTCPeerConnection,
      onRemoteStream: vi.fn(),
    });

    const connectPromise = client.connect(makeFakeStream());
    await vi.waitFor(() => {
      expect(peer.calls).toContain("setRemoteDescription");
    });
    // The data channel already exists at this point (created at the start
    // of connect()), but session.started has not arrived yet.
    expect(peer.dataChannel).not.toBeNull();
    expect(() =>
      client.send({ type: "session.input_audio.mute", event_id: "evt-1" }),
    ).toThrow("Cannot send a Live event before session.started");

    peer.dataChannel?.emitMessage({
      type: "session.started",
      session: { id: "sess_123" },
    });
    await connectPromise;

    // Once started, sending is allowed.
    expect(() =>
      client.send({ type: "session.input_audio.mute", event_id: "evt-1" }),
    ).not.toThrow();
  });

  it("throws when called before connect() has resolved", () => {
    const peer = new FakePeerConnection();
    const { backend } = makeFakeBackend();
    const client = new LiveClient({
      backend,
      peerFactory: () => peer as unknown as RTCPeerConnection,
      onRemoteStream: vi.fn(),
    });

    expect(() =>
      client.send({ type: "session.input_audio.mute", event_id: "evt-1" }),
    ).toThrow();
  });
});

describe("LiveClient resume validation getters", () => {
  it("exposes peer connectionState and data channel readyState after connect", async () => {
    const peer = new FakePeerConnection();
    peer.connectionState = "connected";
    const { backend } = makeFakeBackend();
    const client = new LiveClient({
      backend,
      peerFactory: () => peer as unknown as RTCPeerConnection,
      onRemoteStream: vi.fn(),
    });
    const connectPromise = client.connect(makeFakeStream());
    await vi.waitFor(() => {
      expect(peer.calls).toContain("setRemoteDescription");
    });
    peer.dataChannel?.emitMessage({
      type: "session.started",
      session: { id: "sess_123" },
    });
    await connectPromise;

    expect(client.peerConnectionState).toBe("connected");
    expect(client.dataChannelReadyState).toBe("open");
  });

  it("returns null for peer and channel state before connect instead of inventing healthy values", () => {
    const client = new LiveClient({
      backend: makeFakeBackend().backend,
      peerFactory: () => new FakePeerConnection() as unknown as RTCPeerConnection,
      onRemoteStream: vi.fn(),
    });

    expect(client.peerConnectionState).toBeNull();
    expect(client.dataChannelReadyState).toBeNull();
  });
});

describe("LiveClient.close", () => {
  afterEach(() => {
    vi.useRealTimers();
  });

  async function connectedClient() {
    const peer = new FakePeerConnection();
    const { backend } = makeFakeBackend();
    const client = new LiveClient({
      backend,
      peerFactory: () => peer as unknown as RTCPeerConnection,
      onRemoteStream: vi.fn(),
    });
    const connectPromise = client.connect(makeFakeStream());
    await vi.waitFor(() => {
      expect(peer.calls).toContain("setRemoteDescription");
    });
    peer.dataChannel?.emitMessage({
      type: "session.started",
      session: { id: "sess_123" },
    });
    await connectPromise;
    if (peer.dataChannel === null) throw new Error("data channel missing");
    return { client, peer, channel: peer.dataChannel };
  }

  it("sends session.close, waits for session.closed, then tears down the transport", async () => {
    const { client, peer, channel } = await connectedClient();

    const closePromise = client.close();
    await vi.waitFor(() => {
      expect(channel.sendCalls).toContain(
        JSON.stringify({ type: "session.close" }),
      );
    });
    expect(channel.closeCalls).toBe(0);
    expect(peer.closeCalls).toBe(0);

    channel.emitMessage({
      type: "session.closed",
      reason: "user_requested",
      usage: { seconds: 12 },
    });

    await expect(closePromise).resolves.toEqual({
      finalized: true,
      reason: "user_requested",
      usageSeconds: 12,
    });
    expect(channel.closeCalls).toBe(1);
    expect(peer.closeCalls).toBe(1);
  });

  it("finalizes as false after waiting 15 seconds without session.closed", async () => {
    vi.useFakeTimers();
    const { client, peer, channel } = await connectedClient();

    const closePromise = client.close();
    const assertion = expect(closePromise).resolves.toMatchObject({
      finalized: false,
    });
    await vi.advanceTimersByTimeAsync(15_000);
    await assertion;
    expect(channel.closeCalls).toBe(1);
    expect(peer.closeCalls).toBe(1);
  });

  it("stops accepting new commands once close() has been called", async () => {
    const { client, channel } = await connectedClient();

    const closePromise = client.close();
    expect(() =>
      client.send({ type: "session.input_audio.mute", event_id: "evt-1" }),
    ).toThrow();

    channel.emitMessage({ type: "session.closed" });
    await closePromise;
  });

  it("tears down the data channel and peer as soon as the server ends the session, even if close() is never called", async () => {
    const { peer, channel } = await connectedClient();

    channel.emitMessage({
      type: "session.closed",
      reason: "server_ended",
      usage: { seconds: 7 },
    });

    expect(channel.closeCalls).toBe(1);
    expect(peer.closeCalls).toBe(1);
  });

  it("is idempotent after a server-initiated session.closed: close() resolves with the already-known result instead of throwing", async () => {
    const { client, channel } = await connectedClient();

    channel.emitMessage({
      type: "session.closed",
      reason: "server_ended",
      usage: { seconds: 7 },
    });

    await expect(client.close()).resolves.toEqual({
      finalized: true,
      reason: "server_ended",
      usageSeconds: 7,
    });
    // No second session.close command should have been sent — the session
    // had already ended before close() was ever called.
    expect(channel.sendCalls).not.toContain(
      JSON.stringify({ type: "session.close" }),
    );
  });

  it("is idempotent when close() is called twice in a row locally", async () => {
    const { client, channel } = await connectedClient();

    const firstClosePromise = client.close();
    const secondClosePromise = client.close();
    channel.emitMessage({
      type: "session.closed",
      reason: "user_requested",
      usage: { seconds: 3 },
    });

    const expected = {
      finalized: true,
      reason: "user_requested",
      usageSeconds: 3,
    };
    await expect(firstClosePromise).resolves.toEqual(expected);
    await expect(secondClosePromise).resolves.toEqual(expected);
    expect(
      channel.sendCalls.filter(
        (call) => call === JSON.stringify({ type: "session.close" }),
      ),
    ).toHaveLength(1);
  });

  it("still tears down the transport if sending session.close throws, and does not leave close() stuck on a rejected promise", async () => {
    const { client, peer, channel } = await connectedClient();
    channel.send = () => {
      throw new Error("channel is not open");
    };

    await expect(client.close()).resolves.toEqual({
      finalized: false,
      reason: "channel is not open",
    });
    expect(channel.closeCalls).toBe(1);
    expect(peer.closeCalls).toBe(1);

    // A second call must return the cached result immediately, not the
    // same broken send attempt again.
    await expect(client.close()).resolves.toEqual({
      finalized: false,
      reason: "channel is not open",
    });
  });
});

describe("LiveClient trusted control commands", () => {
  afterEach(() => {
    vi.useRealTimers();
    vi.restoreAllMocks();
  });

  async function connectedClient() {
    const peer = new FakePeerConnection();
    const { backend } = makeFakeBackend();
    const client = new LiveClient({
      backend,
      peerFactory: () => peer as unknown as RTCPeerConnection,
      onRemoteStream: vi.fn(),
    });
    const connectPromise = client.connect(makeFakeStream());
    await vi.waitFor(() => {
      expect(peer.calls).toContain("setRemoteDescription");
    });
    peer.dataChannel?.emitMessage({
      type: "session.started",
      session: { id: "sess_123" },
    });
    await connectPromise;
    if (peer.dataChannel === null) throw new Error("data channel missing");
    let uuidSeq = 0;
    vi.spyOn(crypto, "randomUUID").mockImplementation(() => {
      uuidSeq += 1;
      return `evt-${uuidSeq}` as ReturnType<typeof crypto.randomUUID>;
    });
    return { client, peer, channel: peer.dataChannel };
  }

  it("sends instructions.append with a unique event_id and resolves on the matching client_event_id", async () => {
    const { client, channel } = await connectedClient();

    const pending = client.appendInstructions("BEGIN_INTERPRETER_MODE.", {
      kind: "startup_interpreter",
    });
    expect(channel.sendCalls).toEqual([
      JSON.stringify({
        type: "session.instructions.append",
        event_id: "evt-1",
        delegation_id: null,
        content: "BEGIN_INTERPRETER_MODE.",
      }),
    ]);

    channel.emitMessage({
      type: "session.thinking.appended",
      client_event_id: "evt-other",
    });
    channel.emitMessage({
      type: "session.instructions.appended",
      client_event_id: "evt-1",
    });

    await expect(pending).resolves.toEqual({ eventId: "evt-1" });
  });

  it("sends thinking.append and commentary.append and waits for their acks", async () => {
    const { client, channel } = await connectedClient();

    const thinking = client.appendThinking("Authoritative conversation context: hello.", {
      kind: "startup_interpreter",
    });
    channel.emitMessage({
      type: "session.thinking.appended",
      client_event_id: "evt-1",
    });
    await expect(thinking).resolves.toEqual({ eventId: "evt-1" });

    const commentary = client.appendCommentary("Please produce a fresh spoken interpretation.", {
      kind: "first_steering",
      sessionState: "correcting",
    });
    channel.emitMessage({
      type: "session.commentary.appended",
      client_event_id: "evt-2",
    });
    await expect(commentary).resolves.toEqual({ eventId: "evt-2" });
  });

  it("does not send oversized append text", async () => {
    const { client, channel } = await connectedClient();
    const oversized = "a".repeat(APPEND_CHAR_BUDGET + 1);

    await expect(
      client.appendInstructions(oversized, { kind: "startup_interpreter" }),
    ).rejects.toBeInstanceOf(ContextTooLongError);
    expect(channel.sendCalls).toEqual([]);
  });

  it("refuses steering while session state is outputting and does not send", async () => {
    const { client, channel } = await connectedClient();

    await expect(
      client.appendInstructions("The next expected source speaker is Participant A.", {
        kind: "first_steering",
        sessionState: "outputting",
      }),
    ).rejects.toThrow("Cannot send steering while session state is outputting");
    await expect(
      client.appendInstructions("The next expected source speaker is Participant B.", {
        kind: "later_steering",
        sessionState: "outputting",
      }),
    ).rejects.toThrow("Cannot send steering while session state is outputting");
    expect(channel.sendCalls).toEqual([]);
  });

  it("retries a startup interpreter append once after ack timeout, then throws", async () => {
    const { client, channel } = await connectedClient();
    vi.useFakeTimers();

    const pending = client.appendInstructions("BEGIN_INTERPRETER_MODE.", {
      kind: "startup_interpreter",
    });
    expect(channel.sendCalls).toHaveLength(1);

    await vi.advanceTimersByTimeAsync(runtime.steeringAckTimeoutMs);
    expect(channel.sendCalls).toHaveLength(2);
    expect(JSON.parse(channel.sendCalls[1] as string).event_id).toBe("evt-2");

    const assertion = expect(pending).rejects.toBeInstanceOf(AckTimeoutError);
    await vi.advanceTimersByTimeAsync(runtime.steeringAckTimeoutMs);
    await assertion;
  });

  it("retries first steering once after ack timeout, then throws", async () => {
    const { client, channel } = await connectedClient();
    vi.useFakeTimers();

    const pending = client.appendInstructions("steer", {
      kind: "first_steering",
      sessionState: "listening",
    });
    await vi.advanceTimersByTimeAsync(runtime.steeringAckTimeoutMs);
    expect(channel.sendCalls).toHaveLength(2);

    const assertion = expect(pending).rejects.toBeInstanceOf(AckTimeoutError);
    await vi.advanceTimersByTimeAsync(runtime.steeringAckTimeoutMs);
    await assertion;
  });

  it("retries later steering once after ack timeout, then returns degraded and continues", async () => {
    const { client, channel } = await connectedClient();
    vi.useFakeTimers();

    const pending = client.appendInstructions("steer", {
      kind: "later_steering",
      sessionState: "listening",
    });
    await vi.advanceTimersByTimeAsync(runtime.steeringAckTimeoutMs);
    expect(channel.sendCalls).toHaveLength(2);

    await vi.advanceTimersByTimeAsync(runtime.steeringAckTimeoutMs);
    await expect(pending).resolves.toEqual({ eventId: "evt-2", degraded: true });
  });

  it("retries a correction append once after ack timeout, then throws", async () => {
    const { client, channel } = await connectedClient();
    vi.useFakeTimers();

    const pending = client.appendInstructions(
      "Stop speaking. The latest human utterance was from Participant B, not A. Update the assignment. Do not speak until prompted.",
      { kind: "correction" },
    );
    await vi.advanceTimersByTimeAsync(runtime.steeringAckTimeoutMs);
    expect(channel.sendCalls).toHaveLength(2);

    const assertion = expect(pending).rejects.toBeInstanceOf(AckTimeoutError);
    await vi.advanceTimersByTimeAsync(runtime.steeringAckTimeoutMs);
    await assertion;
  });

  it("succeeds on the retry acknowledgment after the first attempt times out", async () => {
    const { client, channel } = await connectedClient();
    vi.useFakeTimers();

    const pending = client.appendInstructions("BEGIN_INTERPRETER_MODE.", {
      kind: "startup_interpreter",
    });
    await vi.advanceTimersByTimeAsync(runtime.steeringAckTimeoutMs);
    channel.emitMessage({
      type: "session.instructions.appended",
      client_event_id: "evt-2",
    });
    await expect(pending).resolves.toEqual({ eventId: "evt-2" });
  });

  it("sends mute/unmute with event_id and waits for the matching mute ack", async () => {
    const { client, channel } = await connectedClient();

    const muted = client.setInputMuted(true);
    expect(JSON.parse(channel.sendCalls[0] as string)).toEqual({
      type: "session.input_audio.mute",
      event_id: "evt-1",
    });
    channel.emitMessage({
      type: "session.input_audio.muted",
      client_event_id: "evt-1",
    });
    await expect(muted).resolves.toBeUndefined();

    const unmuted = client.setInputMuted(false);
    expect(JSON.parse(channel.sendCalls[1] as string)).toEqual({
      type: "session.input_audio.unmute",
      event_id: "evt-2",
    });
    channel.emitMessage({
      type: "session.input_audio.unmuted",
      client_event_id: "evt-2",
    });
    await expect(unmuted).resolves.toBeUndefined();
  });

  it("does not treat mute acknowledgment as output completion", async () => {
    const { client, channel } = await connectedClient();
    const onAppendAcknowledged = vi.fn();
    const onTranscriptDelta = vi.fn();
    const onSessionClosed = vi.fn();
    client.onAppendAcknowledged = onAppendAcknowledged;
    client.onTranscriptDelta = onTranscriptDelta;
    client.onSessionClosed = onSessionClosed;

    const appendPending = client.appendInstructions("BEGIN_INTERPRETER_MODE.", {
      kind: "startup_interpreter",
    });
    const mutePending = client.setInputMuted(true);

    channel.emitMessage({
      type: "session.input_audio.muted",
      client_event_id: "evt-2",
    });
    await expect(mutePending).resolves.toBeUndefined();

    expect(onAppendAcknowledged).not.toHaveBeenCalled();
    expect(onTranscriptDelta).not.toHaveBeenCalled();
    expect(onSessionClosed).not.toHaveBeenCalled();

    channel.emitMessage({
      type: "session.instructions.appended",
      client_event_id: "evt-1",
    });
    await expect(appendPending).resolves.toEqual({ eventId: "evt-1" });
  });

  it("fails the matching waiter when a correlated error arrives", async () => {
    const { client, channel } = await connectedClient();
    const pending = client.appendInstructions("BEGIN_INTERPRETER_MODE.", {
      kind: "startup_interpreter",
    });
    channel.emitMessage({
      type: "error",
      client_event_id: "evt-1",
      error: { message: "append rejected" },
    });
    await expect(pending).rejects.toThrow("append rejected");
  });

  it("does not leak an ack waiter if send() throws", async () => {
    const { client, channel } = await connectedClient();
    vi.useFakeTimers();
    channel.send = () => {
      throw new Error("channel is not open");
    };

    const unhandled: unknown[] = [];
    const onUnhandled = (reason: unknown) => {
      unhandled.push(reason);
    };
    process.on("unhandledRejection", onUnhandled);

    await expect(
      client.appendInstructions("BEGIN_INTERPRETER_MODE.", {
        kind: "startup_interpreter",
      }),
    ).rejects.toThrow("channel is not open");
    await expect(client.setInputMuted(true)).rejects.toThrow(
      "channel is not open",
    );

    await vi.advanceTimersByTimeAsync(runtime.steeringAckTimeoutMs);
    process.off("unhandledRejection", onUnhandled);

    expect(unhandled).toEqual([]);
  });
});
