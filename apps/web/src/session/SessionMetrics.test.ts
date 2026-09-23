import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { AudioController } from "../audio/AudioController";
import { LiveClient } from "../live/LiveClient";
import type { SessionClosedEvent, TranscriptDeltaEvent } from "../live/LiveEvents";
import type { OrientationController } from "../platform/OrientationController";
import type { VisibilityController } from "../platform/VisibilityController";
import type { WakeLockController } from "../platform/WakeLockController";
import { SessionController } from "./SessionController";

type FakeLiveErrorEvent = {
  type: "error";
  error: { message: string; code?: string; client_event_id?: string };
  transportFailure?: true;
};

afterEach(() => {
  vi.useRealTimers();
  vi.restoreAllMocks();
});

class FakeLive {
  onTranscriptDelta: ((event: TranscriptDeltaEvent) => void) | null = null;
  onSessionStarted: ((event: { type: "session.started"; session: { id: string } }) => void) | null =
    null;
  onSessionClosed: ((event: SessionClosedEvent) => void) | null = null;
  onError: ((event: FakeLiveErrorEvent) => void) | null = null;
  readonly callOrder: string[] = [];
  readonly connect = vi.fn(async () => {
    this.callOrder.push("connect");
    return { sessionId: "sess_1" };
  });
  readonly close = vi.fn(async () => {
    this.callOrder.push("close");
    return { finalized: true };
  });
  readonly disconnectImmediately = vi.fn(async () => {
    this.callOrder.push("disconnectImmediately");
  });
  readonly appendThinking = vi.fn(async (text: string) => {
    this.callOrder.push(`thinking:${text}`);
    return { eventId: "evt-thinking" };
  });
  readonly appendInstructions = vi.fn<
    (text: string, policy?: { kind: string }) => Promise<{ eventId: string }>
  >(async (text: string) => {
    this.callOrder.push(`instructions:${text}`);
    return { eventId: "evt-instructions" };
  });
  readonly appendCommentary = vi.fn<
    (text: string, policy?: { kind: string }) => Promise<{ eventId: string }>
  >(async (text: string) => {
    this.callOrder.push(`commentary:${text}`);
    return { eventId: "evt-commentary" };
  });
  readonly setInputMuted = vi.fn<(muted: boolean) => Promise<void>>(async () => {
    this.callOrder.push("setInputMuted");
  });
  peerConnectionState: RTCPeerConnectionState | null = "connected";
  dataChannelReadyState: RTCDataChannelState | null = "open";

  emit(event: TranscriptDeltaEvent): void {
    if (this.onTranscriptDelta === null) {
      throw new Error("Transcript handler was not installed");
    }
    this.onTranscriptDelta(event);
  }

  emitSessionClosed(reason = "server_closed"): void {
    if (this.onSessionClosed === null) {
      throw new Error("Session closed handler was not installed");
    }
    this.onSessionClosed({ type: "session.closed", reason });
  }
}

function createFakeAudio() {
  const captureTrack = {
    kind: "audio",
    readyState: "live" as MediaStreamTrackState,
    enabled: true,
    addEventListener: vi.fn(),
    removeEventListener: vi.fn(),
    stop: vi.fn(),
  };
  const captureStream = {
    id: "mic-stream",
    getAudioTracks: () => [captureTrack],
    getTracks: () => [captureTrack],
  } as unknown as MediaStream;
  let stream: MediaStream | null = null;
  const audio = {
    captureStream,
    captureTrack,
    primeOutput: vi.fn(async () => {}),
    setOutputAudible: vi.fn(),
    setCaptureEnabled: vi.fn((enabled: boolean) => {
      captureTrack.enabled = enabled;
    }),
    startCapture: vi.fn(async () => {
      stream = captureStream;
    }),
    setCaptureStream: vi.fn((nextStream: MediaStream | null) => {
      stream = nextStream;
    }),
    endCaptureTrack: vi.fn(() => {
      captureTrack.readyState = "ended";
      audio.onCaptureEnded?.();
    }),
    stopCapture: vi.fn(() => {
      stream = null;
    }),
    getCaptureStream: vi.fn(() => stream),
    attachRemoteStream: vi.fn(),
    audioElement: {
      play: vi.fn(async () => {}),
    } as unknown as HTMLAudioElement,
    onVoiceActivity: null as ((event: { active: boolean; atMs: number }) => void) | null,
    onPlaybackActivity: null as ((event: { active: boolean; atMs: number }) => void) | null,
    onAudioInterruption: null as (() => void) | null,
    onAudioRestored: null as (() => void) | null,
    onCaptureEnded: null as (() => void) | null,
    resetVoiceActivityBaseline: vi.fn(),
  };
  return audio;
}

class FakeOrientation {
  onChange: ((orientation: "portrait" | "landscape") => void) | null = null;
  private orientation: "portrait" | "landscape" = "portrait";
  readonly start = vi.fn();
  readonly stop = vi.fn();
  readonly lockPortrait = vi.fn(async () => {});
  getOrientation(): "portrait" | "landscape" {
    return this.orientation;
  }
  isPortrait(): boolean {
    return this.orientation === "portrait";
  }
  emit(orientation: "portrait" | "landscape"): void {
    this.orientation = orientation;
    this.onChange?.(orientation);
  }
}

class FakeVisibility {
  onHidden: (() => void) | null = null;
  onVisible: (() => void) | null = null;
  private hidden = false;
  readonly start = vi.fn();
  readonly stop = vi.fn();
  isHidden(): boolean {
    return this.hidden;
  }
  hide(): void {
    this.hidden = true;
    this.onHidden?.();
  }
  show(): void {
    this.hidden = false;
    this.onVisible?.();
  }
}

class FakeWakeLock {
  readonly request = vi.fn(async () => {});
  readonly reacquire = vi.fn(async () => {});
  readonly release = vi.fn(async () => {});
}

function setDeviceLanguage(language: string): void {
  Object.defineProperty(navigator, "language", {
    configurable: true,
    get: () => language,
  });
}


const controllerHarnesses = new WeakMap<SessionController, {
  live: FakeLive;
  audio: ReturnType<typeof createFakeAudio> | AudioController;
}>();

function createController<
  TAudio extends ReturnType<typeof createFakeAudio> | AudioController = ReturnType<
    typeof createFakeAudio
  >,
>(options: {
  live?: FakeLive;
  lives?: FakeLive[];
  audio?: TAudio;
  orientation?: FakeOrientation;
  visibility?: FakeVisibility;
  wakeLock?: FakeWakeLock;
} = {}) {
  const live = options.lives?.[0] ?? options.live ?? new FakeLive();
  let liveIndex = 0;
  const createLive = (): LiveClient => {
    if (options.lives === undefined) {
      return live as unknown as LiveClient;
    }
    const next = options.lives[liveIndex];
    if (next === undefined) {
      throw new Error("No FakeLive remains for createLive()");
    }
    liveIndex += 1;
    return next as unknown as LiveClient;
  };
  const audio = (options.audio ?? createFakeAudio()) as TAudio;
  const orientation = options.orientation ?? new FakeOrientation();
  const visibility = options.visibility ?? new FakeVisibility();
  const wakeLock = options.wakeLock ?? new FakeWakeLock();
  const controller = new SessionController({
    createLive,
    audio: audio as unknown as AudioController,
    orientation: orientation as unknown as OrientationController,
    visibility: visibility as unknown as VisibilityController,
    wakeLock: wakeLock as unknown as WakeLockController,
  });
  controllerHarnesses.set(controller, { live, audio });
  return { controller, live, audio, orientation, visibility, wakeLock };
}


async function calibrate(controller: SessionController): Promise<void> {
  await controller.acceptBootstrap("I speak English and would like to find the nearest station.");
  await controller.startBootstrap();
  await controller.acceptBootstrap("Hablo español y quisiera encontrar la estación de tren.");
}

async function enterListening(controller: SessionController): Promise<void> {
  const harness = controllerHarnesses.get(controller);
  const start = async () => {
    await controller.startBootstrap();
    await calibrate(controller);
    await controller.beginInterpreter();
  };
  // Fault injections in turn-engine tests apply after calibration, not to setup.
  if (harness === undefined) { await start(); return; }
  await harness.live.setInputMuted.withImplementation(async () => {}, async () => {
    const capture = harness.audio.setCaptureEnabled;
    if (vi.isMockFunction(capture)) {
      await capture.withImplementation(() => {}, start);
      capture.mockClear();
    } else {
      await start();
    }
  });
  harness.live.setInputMuted.mockClear();
  if (vi.isMockFunction(harness.audio.resetVoiceActivityBaseline)) harness.audio.resetVoiceActivityBaseline.mockClear();
}

function emitVoice(
  audio: { onVoiceActivity: ((event: { active: boolean; atMs: number }) => void) | null },
  active: boolean,
  atMs = Date.now(),
): void {
  if (audio.onVoiceActivity === null) {
    throw new Error("Voice activity handler was not installed");
  }
  audio.onVoiceActivity({ active, atMs });
}

function emitPlayback(
  audio: ReturnType<typeof createFakeAudio>,
  active: boolean,
  atMs = Date.now(),
): void {
  if (audio.onPlaybackActivity === null) {
    throw new Error("Playback activity handler was not installed");
  }
  audio.onPlaybackActivity({ active, atMs });
}

async function flushMicrotasks(): Promise<void> {
  await Promise.resolve();
  await Promise.resolve();
}


describe("stage-3 metadata observations", () => {
  beforeEach(() => { setDeviceLanguage("ru-RU"); vi.useFakeTimers(); });
  it("observes source-active time even though inputReady becomes false, and emits no conversation text", async () => {
    const { controller, live, audio } = createController();
    const observe = vi.fn(); Object.assign(live, { observeProductMetrics: observe, inputMeteringReady: true });
    await enterListening(controller); audio.setCaptureEnabled(true);
    emitVoice(audio, true); live.emit({ type: "session.input_transcript.delta", delta: "Private sentence in English." });
    const typedAudio = audio as typeof audio & { onSourceSample?: (event: { active: boolean; atMs: number }) => void };
    typedAudio.onSourceSample?.({ active: true, atMs: performance.now() });
    expect(controller.inputReady).toBe(false);
    expect(observe).toHaveBeenLastCalledWith(expect.objectContaining({ state: "listening", interpreterReady: true, mediaReady: true, speechEligible: true, sample: { active: true, atMs: performance.now() } }));
    expect(JSON.stringify(observe.mock.calls)).not.toContain("Private sentence");
  });
  it("records audible completion before a subsequent steering failure", async () => {
    const { controller, live, audio } = createController(); await enterListening(controller);
    Object.defineProperty(audio.audioElement, "muted", { value: false, writable: true });
    emitVoice(audio, true); live.emit({ type: "session.input_transcript.delta", delta: "Hello, where is the nearest train station?" });
    live.emit({ type: "session.output_transcript.delta", delta: "Hola" }); emitPlayback(audio, true); await flushMicrotasks();
    emitVoice(audio, false); await flushMicrotasks();
    live.appendInstructions.mockRejectedValueOnce(new Error("next steering failed"));
    emitPlayback(audio, false); await flushMicrotasks();
    await vi.advanceTimersByTimeAsync(2000);
    expect(controller.metrics.snapshot().audioCompletedTurnCount).toBe(1);
    expect(controller.session.state).toBe("error");
  });
});
