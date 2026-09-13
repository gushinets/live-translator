import type { BackendClient } from "../api/BackendClient";
import {
  isLiveServerEvent,
  type AppendAcknowledgedEvent,
  type LiveClientEvent,
  type LiveErrorEvent,
  type LiveServerEvent,
  type MuteAcknowledgedEvent,
  type SessionClosedEvent,
  type SessionStartedEvent,
  type SessionUsage,
  type TranscriptDeltaEvent,
} from "./LiveEvents";
import { waitForIceComplete } from "./waitForIceComplete";

/** Binding spec 1.2.1 §14.3 step 6 / ambiguity resolution. */
const ICE_GATHER_TIMEOUT_MS = 10_000;
/** Binding spec 1.2.1 §23 step 7 graceful-close wait budget. */
const SESSION_CLOSE_TIMEOUT_MS = 15_000;
/** Binding spec 1.2.1 §14.2 data-channel label. */
const DATA_CHANNEL_LABEL = "oai-events";

export interface LiveClientDeps {
  backend: BackendClient;
  peerFactory: () => RTCPeerConnection;
  onRemoteStream: (stream: MediaStream) => void;
}

export interface LiveCloseResult {
  finalized: boolean;
  reason?: string;
  usageSeconds?: number;
}

interface Deferred<T> {
  promise: Promise<T>;
  resolve: (value: T) => void;
}

function createDeferred<T>(): Deferred<T> {
  let resolve!: (value: T) => void;
  const promise = new Promise<T>((res) => {
    resolve = res;
  });
  return { promise, resolve };
}

/**
 * Browser-side WebRTC transport for a GPT-Live session, implementing the
 * official connect sequence (binding spec 1.2.1 §14.3) and graceful shutdown
 * (§23). Peer connection and backend dependencies are injected for testing;
 * this class never talks to OpenAI directly.
 */
export class LiveClient {
  onSessionStarted: ((event: SessionStartedEvent) => void) | null = null;
  onTranscriptDelta: ((event: TranscriptDeltaEvent) => void) | null = null;
  onAppendAcknowledged:
    | ((event: AppendAcknowledgedEvent) => void)
    | null = null;
  onMuteAcknowledged: ((event: MuteAcknowledgedEvent) => void) | null = null;
  onUsage: ((usage: SessionUsage) => void) | null = null;
  onError: ((event: LiveErrorEvent) => void) | null = null;
  onSessionClosed: ((event: SessionClosedEvent) => void) | null = null;

  private peer: RTCPeerConnection | null = null;
  private channel: RTCDataChannel | null = null;
  private sessionClosedDeferred: Deferred<SessionClosedEvent> | null = null;
  private pendingSessionStarted: ((event: SessionStartedEvent) => void) | null =
    null;
  /** True only once a `session.started` message has actually been received. */
  private started = false;
  private closing = false;

  constructor(private readonly deps: LiveClientDeps) {}

  async connect(stream: MediaStream): Promise<{ sessionId: string }> {
    const peer = this.deps.peerFactory();
    this.peer = peer;

    // Data channel must exist before offer creation so the SDP advertises it.
    const channel = peer.createDataChannel(DATA_CHANNEL_LABEL);
    this.channel = channel;
    this.sessionClosedDeferred = createDeferred<SessionClosedEvent>();

    channel.addEventListener("message", (event) => {
      this.handleChannelMessage(event as MessageEvent<string>);
    });
    channel.addEventListener("close", () => {
      this.handleChannelClose();
    });

    peer.addEventListener("track", (event) => {
      const trackEvent = event as RTCTrackEvent;
      const [remoteStream] = trackEvent.streams;
      if (remoteStream !== undefined) this.deps.onRemoteStream(remoteStream);
    });
    peer.addEventListener("connectionstatechange", () => {
      this.handleConnectionStateChange();
    });

    const sessionStartedPromise = new Promise<SessionStartedEvent>(
      (resolve) => {
        this.pendingSessionStarted = resolve;
      },
    );

    for (const track of stream.getTracks()) {
      peer.addTrack(track, stream);
    }

    const offer = await peer.createOffer();
    await peer.setLocalDescription(offer);

    await waitForIceComplete(peer, ICE_GATHER_TIMEOUT_MS);

    const localSdp = peer.localDescription?.sdp;
    if (localSdp === undefined) {
      throw new Error("Missing local SDP after ICE gathering completed");
    }

    const { transport } = await this.deps.backend.createLiveSession(localSdp);
    await peer.setRemoteDescription({ type: "answer", sdp: transport.sdp });

    const startedEvent = await sessionStartedPromise;
    return { sessionId: startedEvent.session.id };
  }

  send(event: LiveClientEvent): void {
    if (this.channel === null) {
      throw new Error("Cannot send a Live event before connect() completes");
    }
    // `this.channel` is assigned at the very start of connect(), well
    // before session.started arrives, so it is not a sufficient readiness
    // check on its own (binding spec 1.2.1 §14.3 step 11).
    if (!this.started) {
      throw new Error("Cannot send a Live event before session.started");
    }
    if (this.closing) {
      throw new Error("Cannot send a Live event while the session is closing");
    }
    this.channel.send(JSON.stringify(event));
  }

  async close(): Promise<LiveCloseResult> {
    if (this.channel === null || this.peer === null) {
      throw new Error("Cannot close a Live session that was never connected");
    }
    if (this.closing) {
      throw new Error("close() has already been called");
    }
    this.closing = true;

    const sessionClosedPromise = this.getSessionClosedPromise();
    this.channel.send(JSON.stringify({ type: "session.close" }));

    const result = await this.waitForSessionClosedOrTimeout(
      sessionClosedPromise,
      SESSION_CLOSE_TIMEOUT_MS,
    );

    this.channel.close();
    this.peer.close();

    return result;
  }

  private getSessionClosedPromise(): Promise<SessionClosedEvent> {
    if (this.sessionClosedDeferred === null) {
      throw new Error("Session closed waiter was not installed");
    }
    return this.sessionClosedDeferred.promise;
  }

  private async waitForSessionClosedOrTimeout(
    sessionClosedPromise: Promise<SessionClosedEvent>,
    timeoutMs: number,
  ): Promise<LiveCloseResult> {
    return new Promise<LiveCloseResult>((resolve) => {
      const timer = window.setTimeout(() => {
        resolve({
          finalized: false,
          reason: "Timed out waiting for session.closed",
        });
      }, timeoutMs);
      sessionClosedPromise.then((event) => {
        window.clearTimeout(timer);
        resolve({
          finalized: true,
          reason: event.reason,
          usageSeconds: event.usage?.seconds,
        });
      });
    });
  }

  /**
   * Fires when the data channel closes without going through our own
   * graceful `close()` (e.g. the remote side or the network dropped it).
   * Reported via the existing `onError` callback rather than a new
   * product-level event; both a local `close()` and a server-initiated
   * `session.closed` set `closing` before the transport tears down, so
   * expected closure is never reported as an error.
   */
  private handleChannelClose(): void {
    if (this.closing) return;
    this.onError?.({
      type: "error",
      error: { message: "Live data channel closed unexpectedly" },
    });
  }

  /**
   * Fires on every `RTCPeerConnection` state transition. Only the terminal
   * failure states are surfaced (via `onError`); transient states such as
   * "connecting"/"connected"/"disconnected" are not reported, and a
   * transition to "closed" caused by a graceful close (local `close()` or a
   * server-initiated `session.closed`) is suppressed by the `closing` guard
   * for the same reason as above.
   */
  private handleConnectionStateChange(): void {
    if (this.closing) return;
    const state = this.peer?.connectionState;
    if (state !== "failed" && state !== "closed") return;
    this.onError?.({
      type: "error",
      error: { message: `Peer connection state changed to "${state}"` },
    });
  }

  private handleChannelMessage(event: MessageEvent<string>): void {
    const parsed: unknown = JSON.parse(event.data);
    if (!isLiveServerEvent(parsed)) {
      throw new Error("Received a Live event without a recognizable type");
    }
    this.dispatchServerEvent(parsed);
  }

  private dispatchServerEvent(serverEvent: LiveServerEvent): void {
    switch (serverEvent.type) {
      case "session.started":
        this.started = true;
        this.pendingSessionStarted?.(serverEvent);
        this.pendingSessionStarted = null;
        this.onSessionStarted?.(serverEvent);
        return;
      case "session.input_transcript.delta":
      case "session.output_transcript.delta":
        this.onTranscriptDelta?.(serverEvent);
        return;
      case "session.instructions.appended":
      case "session.thinking.appended":
      case "session.commentary.appended":
        this.onAppendAcknowledged?.(serverEvent);
        return;
      case "session.input_audio.muted":
      case "session.input_audio.unmuted":
        this.onMuteAcknowledged?.(serverEvent);
        return;
      case "session.closed":
        // A server-initiated session.closed enters the same non-error
        // closing path as a local close(): it stops new sends and
        // suppresses the close/connectionstatechange handlers below from
        // reporting the resulting transport teardown as an error (§23).
        this.closing = true;
        this.sessionClosedDeferred?.resolve(serverEvent);
        this.onSessionClosed?.(serverEvent);
        if (serverEvent.usage !== undefined) this.onUsage?.(serverEvent.usage);
        return;
      case "error":
        this.onError?.(serverEvent);
        return;
    }
  }
}
