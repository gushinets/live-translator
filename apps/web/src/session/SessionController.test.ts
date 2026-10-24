import { createElement, Profiler } from "react";
import { act, cleanup, render } from "@testing-library/react";
import { renderToStaticMarkup } from "react-dom/server";
import { ConversationScreen } from "../screens/ConversationScreen";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { setImmediate as flushLifecycle } from "node:timers/promises";
import type { BackendClient } from "../api/BackendClient";
import { AudioController, type AudioControllerOptions } from "../audio/AudioController";
import { runtime } from "../config/runtime";
import { PlaybackQueue } from "../audio/PlaybackQueue";
import { AckTimeoutError } from "../live/AckRegistry";
import { LiveClient } from "../live/LiveClient";
import { LiveDiagnostics } from "../live/LiveDiagnostics";
import {
  APPEND_CHAR_BUDGET,
  ContextTooLongError,
  type SessionClosedEvent,
  type TranscriptDeltaEvent,
} from "../live/LiveEvents";
import {
  buildAuthoritativeContext,
  buildInterpreterInstructions,
  buildSteering,
  buildUnfinishedTurnWarning,
} from "../live/LivePrompts";
import type { OrientationController } from "../platform/OrientationController";
import type { VisibilityController } from "../platform/VisibilityController";
import type { WakeLockController } from "../platform/WakeLockController";
import { SessionController } from "./SessionController";
import {
  CONNECTION_ERROR_MESSAGE,
  INCOMPLETE_FINALIZATION_MESSAGE,
  MICROPHONE_CAPTURE_ENDED_MESSAGE,
  MICROPHONE_DENIED_MESSAGE,
  STARTUP_ERROR_MESSAGE,
} from "./userFacingErrors";

type FakeLiveErrorEvent = {
  type: "error";
  error: { message: string; code?: string; client_event_id?: string };
  transportFailure?: true;
};

afterEach(() => {
  cleanup();
  vi.useRealTimers();
  vi.restoreAllMocks();
  window.history.replaceState({}, "", "/");
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

function fakeRemoteStream(id: string): MediaStream {
  return { id, getAudioTracks: () => [{ readyState: "live", addEventListener: vi.fn() }] } as unknown as MediaStream;
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
      load: vi.fn(),
    } as unknown as HTMLAudioElement,
    onVoiceActivity: null as ((event: { active: boolean; atMs: number }) => void) | null,
    onPlaybackActivity: null as ((event: { active: boolean; atMs: number }) => void) | null,
    onPcmReceived: null as ((atMs: number) => void) | null,
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

class DispatchableMicTrack extends EventTarget {
  kind = "audio";
  enabled = true;
  readyState: MediaStreamTrackState = "live";
  stop = vi.fn(() => {
    this.readyState = "ended";
  });
  getSettings = (): MediaTrackSettings => ({
    echoCancellation: true,
    noiseSuppression: false,
  });
  end(): void {
    this.readyState = "ended";
    this.dispatchEvent(new Event("ended"));
  }
}

class DispatchableAudioNode {
  connect(): DispatchableAudioNode {
    return this;
  }
  disconnect(): void {}
}

class DispatchableAnalyser extends DispatchableAudioNode {
  fftSize = 2048;
  getFloatTimeDomainData(output: Float32Array): void {
    output.fill(0);
  }
}

class DispatchableAudioContext extends EventTarget {
  state: AudioContextState | "interrupted" = "running";
  resume = vi.fn(async () => {
    this.state = "running";
  });
  close = vi.fn(async () => {
    this.state = "closed";
  });
  createAnalyser(): DispatchableAnalyser {
    return new DispatchableAnalyser();
  }
  createMediaStreamSource(): DispatchableAudioNode {
    return new DispatchableAudioNode();
  }
  setState(state: AudioContextState | "interrupted"): void {
    this.state = state;
    this.dispatchEvent(new Event("statechange"));
  }
}

function createDispatchableAudio(getUserMedia?: () => Promise<MediaStream>,
  createPlaybackNode?: AudioControllerOptions["createPlaybackNode"]): {
  audio: AudioController;
  track: DispatchableMicTrack;
  audioContext: DispatchableAudioContext;
} {
  const track = new DispatchableMicTrack();
  const audioContext = new DispatchableAudioContext();
  const audioElement = document.createElement("audio");
  audioElement.play = vi.fn().mockResolvedValue(undefined);
  const audio = new AudioController({
    getUserMedia: getUserMedia ?? (async () =>
      ({
        getAudioTracks: () => [track],
        getTracks: () => [track],
        clone: () => ({
          getAudioTracks: () => [new DispatchableMicTrack()],
          getTracks: () => [new DispatchableMicTrack()],
          clone: () => {
            throw new Error("Nested MediaStream.clone is not used");
          },
        }),
      }) as unknown as MediaStream),
    createAudioContext: () => audioContext as unknown as AudioContext,
    audioElement, createPlaybackNode,
  });
  return { audio, track, audioContext };
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

describe("SessionController", () => {
  it("does not disable buffered playback when ending and starting another conversation", async () => {
    const audio = Object.assign(createFakeAudio(), { setNonInterrupting: vi.fn() });
    const { controller } = createController({ audio });
    await controller.startWithLanguages({ A: "ru", B: "es" });
    await controller.endConversation();
    await controller.cancel();
    await controller.startWithLanguages({ A: "ru", B: "es" });
    expect(controller.session.state).toBe("listening");
    expect(audio.setNonInterrupting).not.toHaveBeenCalled();
  });

  beforeEach(() => {
    setDeviceLanguage("ru-RU");
  });

  it("starts directly with the chosen language pair without recording samples", async () => {
    const { controller, live, audio } = createController();

    await controller.startWithLanguages({ A: "ru", B: "es" });

    expect(controller.session.state).toBe("listening");
    expect(controller.session.participantA.language).toBe("ru");
    expect(controller.session.participantB.language).toBe("es");
    expect(live.connect).toHaveBeenCalledOnce();
    expect(live.appendInstructions).toHaveBeenCalledWith(
      buildInterpreterInstructions({ A: "ru", B: "es" }), expect.anything(),
    );
    expect(audio.setCaptureEnabled).toHaveBeenLastCalledWith(true);
  });

  it("rejects a same-language pair before connecting", async () => {
    const { controller, live } = createController();
    await expect(controller.startWithLanguages({ A: "ru", B: "ru" })).rejects.toThrow();
    expect(live.connect).not.toHaveBeenCalled();
  });

  it("applies a changed interlocutor language to the live steering", async () => {
    const { controller, live } = createController();
    await controller.startWithLanguages({ A: "ru", B: "es" });

    await controller.changeInterlocutorLanguage("de");

    expect(controller.session.participantB.language).toBe("de");
    expect(live.appendInstructions).toHaveBeenLastCalledWith(
      buildSteering({ A: "ru", B: "de" }), expect.anything(),
    );
  });

  it.each(["mute", "steering", "unmute"])("does not reopen input when suspended during language-change %s", async phase => {
    const { controller, live, audio, orientation } = createController();
    await controller.startWithLanguages({ A: "ru", B: "es" });
    let release!: () => void;
    const gate = new Promise<void>(resolve => { release = resolve; });
    if (phase === "steering") live.appendInstructions.mockImplementationOnce(async () => {
      await gate; return { eventId: "language-ack" };
    });
    else live.setInputMuted.mockImplementationOnce(async () => {
      if (phase === "mute") await gate;
    }).mockImplementationOnce(async () => { if (phase === "unmute") await gate; });
    const changing = controller.changeInterlocutorLanguage("de").catch(error => error);
    await flushMicrotasks();
    orientation.emit("landscape");
    await flushMicrotasks();
    release();
    await changing;
    expect(controller.session.state).toBe("suspended");
    expect(controller.inputReady).toBe(false);
    expect(audio.captureTrack.enabled).toBe(false);
    if (phase === "mute") expect(controller.session.participantB.language).toBe("es");
    expect(live.setInputMuted).toHaveBeenLastCalledWith(true);
    await controller.cancel();
  });

  it("does not assign either language from the device locale", () => {
    const { controller } = createController();

    expect(controller.session.participantA).toEqual({
      side: "A",
      hasAcceptedConversationSpeech: false,
    });
    expect(controller.session.participantB).toEqual({
      side: "B",
      hasAcceptedConversationSpeech: false,
    });
    expect(controller.session.participantB.language).toBeUndefined();
  });

  it("connects on first context capture, enters context, primes output, and keeps Gate C closed", async () => {
    const { controller, live, audio } = createController();
    live.connect.mockImplementation(async () => {
      audio.captureTrack.enabled = false;
      return { sessionId: "sess_1" };
    });

    await controller.startContextCapture();

    expect(audio.primeOutput).toHaveBeenCalledOnce();
    expect(audio.startCapture).toHaveBeenCalledOnce();
    expect(live.connect).toHaveBeenCalledExactlyOnceWith(audio.captureStream);
    expect(audio.setCaptureEnabled).toHaveBeenLastCalledWith(true);
    expect(audio.captureTrack.enabled).toBe(true);
    expect(controller.session.state).toBe("context");
    expect(audio.setOutputAudible).toHaveBeenCalledWith(false);
    expect(controller.session.activeTurn).toBeUndefined();
    expect(controller.session.recentTurns).toEqual([]);
  });

  it("does not connect again when context capture is resumed", async () => {
    const { controller, live, audio } = createController();
    await controller.startContextCapture();
    controller.finishContextCapture();

    await controller.startContextCapture();

    expect(live.connect).toHaveBeenCalledOnce();
    expect(audio.startCapture).toHaveBeenCalledOnce();
    expect(controller.session.state).toBe("context");
  });

  it("appends input transcript deltas to the editable context buffer and never creates a Turn", async () => {
    const { controller, live } = createController();
    await controller.startContextCapture();

    live.emit({ type: "session.input_transcript.delta", delta: "I'm a courier. " });
    live.emit({ type: "session.input_transcript.delta", delta: "Spanish is likely." });
    live.emit({ type: "session.output_transcript.delta", delta: "ignored model speech" });

    expect(controller.contextText).toBe("I'm a courier. Spanish is likely.");
    expect(controller.session.activeTurn).toBeUndefined();
    expect(controller.session.recentTurns).toEqual([]);
  });

  it("stops adding context transcript on finish without closing the Live session", async () => {
    const { controller, live } = createController();
    await controller.startContextCapture();
    live.emit({ type: "session.input_transcript.delta", delta: "Hello" });

    controller.finishContextCapture();
    live.emit({ type: "session.input_transcript.delta", delta: " extra" });

    expect(controller.contextText).toBe("Hello");
    expect(live.close).not.toHaveBeenCalled();
    expect(controller.session.state).toBe("context");
  });

  it("enters bootstrap from context with Gate C closed and a cleared bootstrap buffer", async () => {
    const { controller, live, audio } = createController();
    await controller.startContextCapture();
    live.emit({ type: "session.input_transcript.delta", delta: "Courier at the door" });
    live.emit({ type: "session.input_transcript.delta", delta: " leftover bootstrap" });

    await controller.startBootstrap();

    expect(controller.session.state).toBe("bootstrap");
    expect(controller.bootstrapText).toBe("");
    expect(controller.contextText).toBe("Courier at the door leftover bootstrap");
    expect(audio.setOutputAudible).toHaveBeenLastCalledWith(false);
    expect(live.close).not.toHaveBeenCalled();
  });

  it("connects and skips context when Start begins bootstrap from idle", async () => {
    const { controller, live, audio } = createController();

    await controller.startBootstrap();

    expect(audio.primeOutput).toHaveBeenCalledOnce();
    expect(live.connect).toHaveBeenCalledExactlyOnceWith(audio.captureStream);
    expect(controller.session.state).toBe("bootstrap");
    expect(controller.session.contextText).toBe("");
    expect(audio.setOutputAudible).toHaveBeenCalledWith(false);
  });

  it("locks two different languages from samples and rejects unknown or identical samples", async () => {
    const { controller, live, audio } = createController();
    await controller.startBootstrap();
    await controller.acceptBootstrap("OK");
    expect(controller.session.participantA.language).toBeUndefined();
    expect(controller.ownerError).toContain("полное предложение");
    await controller.acceptBootstrap("Я говорю по-русски и хочу узнать дорогу к вокзалу.");
    expect(controller.session.participantA.language).toBe("ru");
    expect(controller.bootstrapSide).toBe("B");
    expect(controller.bootstrapRecording).toBe(false);
    expect(audio.setCaptureEnabled).toHaveBeenLastCalledWith(false);
    live.emit({ type: "session.input_transcript.delta", delta: "late sample A" });
    expect(controller.bootstrapText).toBe("");
    await expect(controller.beginInterpreter()).rejects.toThrow("Сначала запишите");
    await controller.startBootstrap();
    await controller.acceptBootstrap("Я снова говорю по-русски, это ещё одна фраза.");
    expect(controller.session.participantB.language).toBeUndefined();
    expect(controller.ownerError).toContain("тот же язык");
    await controller.acceptBootstrap("I speak English and would like to find the nearest station.");
    expect(controller.languagesReady).toBe(true);
    expect(controller.session.participantB.language).toBe("en");
    expect(controller.ownerError).toBeUndefined();
  });

  it("uses a fresh Live transport so old transcript events stay ignored even after new capture starts", async () => {
    const firstLive = new FakeLive();
    const secondLive = new FakeLive();
    const { controller, audio } = createController({ lives: [firstLive, secondLive] });

    await controller.startBootstrap();
    firstLive.emit({
      type: "session.input_transcript.delta",
      delta: "This is the old sample that will be discarded.",
    });
    expect(controller.bootstrapText).toBe("This is the old sample that will be discarded.");

    let releaseDisconnect!: () => void;
    firstLive.close.mockImplementationOnce(async () => {
      await new Promise<void>((resolve) => { releaseDisconnect = resolve; });
      return { finalized: true };
    });

    const restarting = controller.startBootstrap();
    await flushMicrotasks();

    // The controller has already switched identity, so even events arriving
    // while the old backend lease is still being released are rejected.
    firstLive.emit({
      type: "session.input_transcript.delta",
      delta: " stale tail while old transport is releasing",
    });
    expect(controller.bootstrapText).toBe("");
    expect(secondLive.connect).not.toHaveBeenCalled();

    releaseDisconnect();
    await restarting;

    expect(firstLive.close).toHaveBeenCalledOnce();
    expect(firstLive.disconnectImmediately).not.toHaveBeenCalled();
    expect(secondLive.connect).toHaveBeenCalledExactlyOnceWith(audio.captureStream);
    expect(controller.bootstrapRecording).toBe(true);
    expect(controller.bootstrapText).toBe("");
    expect(audio.setCaptureEnabled).toHaveBeenLastCalledWith(true);

    // Simulate the exact race the prior mute-only fix could not exclude:
    // a very late event from the previous data channel after new capture is
    // already active. The Live identity guard must still reject it.
    firstLive.emit({
      type: "session.input_transcript.delta",
      delta: " stale tail arriving after replacement capture started",
    });
    expect(controller.bootstrapText).toBe("");

    secondLive.emit({
      type: "session.input_transcript.delta",
      delta: "I speak English and would like to find the nearest station.",
    });
    expect(controller.bootstrapText).toBe(
      "I speak English and would like to find the nearest station.",
    );
  });

  it("sends authoritative context, interpreter contract, then fixed-language steering before listening", async () => {
    const { controller, live, audio } = createController();
    await controller.startContextCapture();
    controller.setContextText("We are ordering lunch.");
    await controller.startBootstrap();
    await calibrate(controller);

    await controller.beginInterpreter();

    expect(live.appendThinking).toHaveBeenCalledExactlyOnceWith(
      buildAuthoritativeContext("We are ordering lunch."),
      {
        kind: "startup_interpreter",
        startupGeneration: 0,
        startupState: "bootstrap",
        startupStage: "authoritative_context",
      },
    );
    expect(live.appendInstructions).toHaveBeenNthCalledWith(1, buildInterpreterInstructions({ A: "en", B: "es" }), {
      kind: "startup_interpreter",
      startupGeneration: 0,
      startupState: "bootstrap",
      startupStage: "interpreter_contract",
    });
    expect(live.appendInstructions).toHaveBeenNthCalledWith(
      2,
      buildSteering({ A: "en", B: "es" }),
      {
        kind: "first_steering",
        sessionState: "bootstrap",
        startupGeneration: 0,
        startupState: "bootstrap",
        startupStage: "first_steering",
      },
    );
    expect(live.callOrder.filter(call => call.startsWith("thinking:") || call.startsWith("instructions:"))).toEqual([
      `thinking:${buildAuthoritativeContext("We are ordering lunch.")}`,
      `instructions:${buildInterpreterInstructions({ A: "en", B: "es" })}`,
      `instructions:${buildSteering({ A: "en", B: "es" })}`,
    ]);
    expect(audio.setOutputAudible).toHaveBeenLastCalledWith(true);
    expect(controller.session.state).toBe("listening");
    expect(controller.inputReady).toBe(true);
    expect(live.setInputMuted).toHaveBeenLastCalledWith(false);
  });

  it("skips thinking append for empty context and keeps both fixed languages", async () => {
    const { controller, live } = createController();
    await controller.startBootstrap();
    await calibrate(controller);

    await controller.beginInterpreter();

    expect(live.appendThinking).not.toHaveBeenCalled();
    expect(live.appendInstructions).toHaveBeenNthCalledWith(
      2,
      buildSteering({ A: "en", B: "es" }),
      {
        kind: "first_steering",
        sessionState: "bootstrap",
        startupGeneration: 0,
        startupState: "bootstrap",
        startupStage: "first_steering",
      },
    );
    expect(controller.session.state).toBe("listening");
  });

  it("rejects oversized context before any append and remains on the owner screen", async () => {
    const { controller, live } = createController();
    await controller.startBootstrap();
    await calibrate(controller);
    controller.setContextText("x".repeat(APPEND_CHAR_BUDGET));

    await expect(controller.beginInterpreter()).rejects.toBeInstanceOf(ContextTooLongError);
    expect(live.appendThinking).not.toHaveBeenCalled();
    expect(live.appendInstructions).not.toHaveBeenCalled();
    expect(controller.session.state).toBe("bootstrap");
    expect(controller.ownerError).toBe(
      "Текст слишком длинный. Сократите контекст и попробуйте снова.",
    );
  });

  it("shows the shorten-context prompt when the server rejects context append size", async () => {
    const { controller, live } = createController();
    await controller.startBootstrap();
    await calibrate(controller);
    controller.setContextText("We are ordering lunch.");
    live.appendThinking.mockRejectedValueOnce(
      new Error("append content exceeds maximum token limit"),
    );

    await expect(controller.beginInterpreter()).rejects.toBeInstanceOf(
      ContextTooLongError,
    );
    expect(controller.ownerError).toBe(new ContextTooLongError().message);
    expect(controller.session.state).toBe("bootstrap");
    expect(live.appendInstructions).not.toHaveBeenCalled();
  });

  it("keeps unrelated context append rate-limit errors on the generic startup path", async () => {
    const { controller, live } = createController();
    await controller.startBootstrap();
    await calibrate(controller);
    controller.setContextText("We are ordering lunch.");
    live.appendThinking.mockRejectedValueOnce(
      new Error("content moderation request rate limit exceeded"),
    );

    await expect(controller.beginInterpreter()).rejects.toThrow(
      "content moderation request rate limit exceeded",
    );
    expect(controller.ownerError).toBe(STARTUP_ERROR_MESSAGE);
    expect(controller.session.state).toBe("error");
    expect(live.appendInstructions).not.toHaveBeenCalled();
  });

  it("keeps unrelated interpreter instruction rate-limit errors on the generic startup path", async () => {
    const { controller, live } = createController();
    await controller.startBootstrap();
    await calibrate(controller);
    live.appendInstructions.mockRejectedValueOnce(
      new Error("instructions rate limit exceeded"),
    );

    await expect(controller.beginInterpreter()).rejects.toThrow(
      "instructions rate limit exceeded",
    );
    expect(controller.ownerError).toBe(STARTUP_ERROR_MESSAGE);
    expect(controller.session.state).toBe("error");
    expect(controller.hasEnteredInterpreter).toBe(false);
  });

  it("keeps unrelated first-steering quota errors on the generic startup path", async () => {
    const { controller, live } = createController();
    await controller.startBootstrap();
    await calibrate(controller);
    live.appendInstructions.mockImplementation(async (text: string, policy?: { kind: string }) => {
      live.callOrder.push(`instructions:${text}`);
      if (policy?.kind === "first_steering") {
        throw new Error("payload quota exceeded");
      }
      return { eventId: "evt-ok" };
    });

    await expect(controller.beginInterpreter()).rejects.toThrow("payload quota exceeded");
    expect(controller.ownerError).toBe(STARTUP_ERROR_MESSAGE);
    expect(controller.session.state).toBe("error");
    expect(controller.hasEnteredInterpreter).toBe(false);
  });

  it("closes an abandoned context session after 120s", async () => {
    vi.useFakeTimers();
    const { controller, live, audio } = createController();
    await controller.startContextCapture();

    await vi.advanceTimersByTimeAsync(runtime.contextIdleTimeoutMs - 1);
    expect(live.close).not.toHaveBeenCalled();

    await vi.advanceTimersByTimeAsync(1);
    expect(live.close).toHaveBeenCalledOnce();
    expect(audio.stopCapture).toHaveBeenCalledOnce();
    expect(controller.session.state).toBe("idle");
  });

  it("closes an abandoned bootstrap session after 60s", async () => {
    vi.useFakeTimers();
    const { controller, live } = createController();
    await controller.startBootstrap();

    await vi.advanceTimersByTimeAsync(runtime.bootstrapIdleTimeoutMs - 1);
    expect(live.close).not.toHaveBeenCalled();

    await vi.advanceTimersByTimeAsync(1);
    expect(live.close).toHaveBeenCalledOnce();
    expect(controller.session.state).toBe("idle");
  });

  it("cancel performs graceful close immediately", async () => {
    vi.useFakeTimers();
    const { controller, live, audio } = createController();
    await controller.startContextCapture();

    await controller.cancel();

    expect(live.close).toHaveBeenCalledOnce();
    expect(audio.stopCapture).toHaveBeenCalledOnce();
    expect(controller.session.state).toBe("idle");
    await vi.advanceTimersByTimeAsync(runtime.contextIdleTimeoutMs);
    expect(live.close).toHaveBeenCalledOnce();
  });

  it("freezes context against later ASR after the user edits the buffer", async () => {
    const { controller, live } = createController();
    await controller.startContextCapture();
    live.emit({ type: "session.input_transcript.delta", delta: "Courier at the door" });

    controller.setContextText("Courier at the door in Madrid");
    live.emit({ type: "session.input_transcript.delta", delta: " extra ASR" });

    expect(controller.contextText).toBe("Courier at the door in Madrid");
  });

  it("shares one in-flight connect and ignores a second Start/context while connecting", async () => {
    const live = new FakeLive();
    let finishConnect: ((value: { sessionId: string }) => void) | undefined;
    live.connect.mockImplementation(
      () =>
        new Promise<{ sessionId: string }>((resolve) => {
          finishConnect = resolve;
        }),
    );
    const { controller, audio } = createController({ live });

    const first = controller.startContextCapture();
    const secondCapture = controller.startContextCapture();
    const startDuringConnect = controller.startBootstrap();

    await vi.waitFor(() => {
      expect(audio.startCapture).toHaveBeenCalledOnce();
      expect(live.connect).toHaveBeenCalledOnce();
    });
    if (finishConnect === undefined) {
      throw new Error("connect was not started");
    }
    finishConnect({ sessionId: "sess_1" });

    await first;
    await secondCapture;
    await startDuringConnect;

    expect(audio.startCapture).toHaveBeenCalledOnce();
    expect(live.connect).toHaveBeenCalledOnce();
    expect(controller.session.state).toBe("context");
  });

  it("keeps remote playback pending until the decoder and audible path are both ready", async () => {
    const audio = Object.assign(createFakeAudio(), { playOutput: vi.fn() });
    let ready!: () => void;
    audio.playOutput.mockImplementationOnce(() => new Promise<void>(resolve => { ready = resolve; }));
    const { controller, live } = createController({ audio });
    controller.handleRemoteStream(fakeRemoteStream("remote"), live as unknown as LiveClient);
    expect(audio.playOutput).toHaveBeenCalledOnce();
    expect((controller as unknown as { remotePlaybackState: string }).remotePlaybackState).toBe("pending");
    ready(); await flushMicrotasks();
    expect((controller as unknown as { remotePlaybackState: string }).remotePlaybackState).toBe("ready");
  });
  it.each(["cancel", "endConversation"] as const)("detaches remote playback on %s", async action => {
    const audio = Object.assign(createFakeAudio(), { detachRemoteStream: vi.fn() });
    const { controller, live } = createController({ audio });
    await controller.startWithLanguages({ A: "en", B: "es" });
    controller.handleRemoteStream(fakeRemoteStream("remote"), live as unknown as LiveClient);
    await controller[action]();
    expect(audio.detachRemoteStream).toHaveBeenCalled();
    expect(controller.session.state).toBe(action === "cancel" ? "idle" : "ended");
  });
  it("keeps remote media for draining during temporary orientation suspension", async () => {
    const audio = Object.assign(createFakeAudio(), { detachRemoteStream: vi.fn() });
    const { controller, orientation } = createController({ audio });
    await controller.startWithLanguages({ A: "en", B: "es" });
    orientation.emit("landscape"); await flushMicrotasks();
    expect(controller.session.state).toBe("suspended");
    expect(audio.detachRemoteStream).not.toHaveBeenCalled();
    await controller.endConversation();
  });
  it("plays the primed remote audio element when the stream attaches", async () => {
    const { controller, audio } = createController();
    const remoteStream = fakeRemoteStream("remote");

    controller.handleRemoteStream(remoteStream, controllerHarnesses.get(controller)!.live as unknown as LiveClient);

    expect(audio.attachRemoteStream).toHaveBeenCalledExactlyOnceWith(remoteStream);
    expect(audio.audioElement.play).toHaveBeenCalledOnce();
  });

  it("recovers a decoder error arriving after playback was already ready, once per stream", async () => {
    const { controller, audio } = createController();
    const element = audio.audioElement;
    controller.handleRemoteStream(fakeRemoteStream("remote"), controllerHarnesses.get(controller)!.live as unknown as LiveClient);
    await flushMicrotasks();
    let error: MediaError | null = { code: 3 } as MediaError;
    Object.defineProperty(element, "error", { get: () => error, configurable: true });
    vi.mocked(element.load).mockImplementation(() => { error = null; });
    element.onerror?.call(element, new Event("error"));
    await flushMicrotasks();
    expect(element.play).toHaveBeenCalledTimes(2);
    expect(error).toBeNull();
    expect((controller as unknown as { remotePlaybackState: string }).remotePlaybackState).toBe("ready");
    expect(audio.stopCapture).not.toHaveBeenCalled();
    const logged = vi.spyOn(console, "error").mockImplementation(() => {});
    error = { code: 3 } as MediaError;
    element.onerror?.call(element, new Event("error"));
    await flushMicrotasks();
    expect(element.play).toHaveBeenCalledTimes(2);
    expect((controller as unknown as { remotePlaybackState: string }).remotePlaybackState).toBe("failed");
    expect(logged).toHaveBeenCalled();
  });

  it.each([false, true])("recovers a hidden decoder error and retires on a second error, non-interrupting=%s", async enabled => {
    vi.spyOn(HTMLMediaElement.prototype, "play").mockResolvedValue(undefined);
    vi.spyOn(HTMLMediaElement.prototype, "pause").mockImplementation(() => {});
    vi.spyOn(HTMLMediaElement.prototype, "load").mockImplementation(() => {});
    vi.spyOn(console, "error").mockImplementation(() => {});
    const node = Object.assign(new DispatchableAudioNode(), {
      port: { postMessage: vi.fn(), close: vi.fn(), onmessage: null }, onprocessorerror: null,
    });
    const { audio, audioContext } = createDispatchableAudio(undefined, () => node as unknown as AudioWorkletNode);
    Object.assign(audioContext, {
      audioWorklet: { addModule: vi.fn(async () => {}) },
      createMediaStreamDestination: () => ({ stream: audio.getCaptureStream()! }),
    });
    const { controller, live } = createController({ audio });
    try {
      await controller.startWithLanguages({ A: "ru", B: "en" });
      controller.handleRemoteStream(audio.getCaptureStream()!, live as unknown as LiveClient);
      await flushMicrotasks();
      const readiness = () => (controller as unknown as { remotePlaybackState: string }).remotePlaybackState;
      expect(readiness()).toBe("ready");
      audio.setNonInterrupting(enabled);
      const decoder = vi.mocked(HTMLMediaElement.prototype.play).mock.contexts[0] as HTMLAudioElement;
      let error: MediaError | null = { code: 3 } as MediaError;
      Object.defineProperty(decoder, "error", { configurable: true, get: () => error });
      decoder.load = vi.fn(() => { error = null; });
      decoder.dispatchEvent(new Event("error"));
      await flushMicrotasks();
      expect(decoder.load).toHaveBeenCalledOnce();
      expect(HTMLMediaElement.prototype.play).toHaveBeenCalledTimes(2);
      expect(readiness()).toBe("ready");
      expect(live.disconnectImmediately).not.toHaveBeenCalled();
      error = { code: 3 } as MediaError;
      decoder.dispatchEvent(new Event("error"));
      await vi.waitFor(() => expect(controller.session.state).toBe("ended"));
      expect(live.disconnectImmediately).toHaveBeenCalledExactlyOnceWith("abandoned_connect");
      expect(audio.audioElement.muted).toBe(true);
      expect(decoder.onerror).toBeNull();
      expect(audio.onPlaybackDecoderError).toBeNull();
    } finally { await controller.cancel(); audio.dispose(); }
  });

  it.each(["unexpected-close", "mic-ended", "transport"])("records terminal %s as failure and releases the real buffered pipeline", async reason => {
    vi.useFakeTimers();
    vi.spyOn(HTMLMediaElement.prototype, "play").mockResolvedValue(undefined);
    vi.spyOn(HTMLMediaElement.prototype, "pause").mockImplementation(() => {});
    vi.spyOn(HTMLMediaElement.prototype, "load").mockImplementation(() => {});
    vi.spyOn(console, "error").mockImplementation(() => {});
    const node = Object.assign(new DispatchableAudioNode(), {
      port: { postMessage: vi.fn(), close: vi.fn(), onmessage: null as ((event: MessageEvent) => void) | null }, onprocessorerror: null,
    });
    const { audio, audioContext, track } = createDispatchableAudio(undefined, () => node as unknown as AudioWorkletNode);
    Object.assign(audioContext, {
      audioWorklet: { addModule: vi.fn(async () => {}) },
      createMediaStreamDestination: () => ({ stream: audio.getCaptureStream()! }),
    });
    const { controller, live } = createController({ audio });
    try {
      await controller.startWithLanguages({ A: "ru", B: "en" });
      controller.handleRemoteStream(audio.getCaptureStream()!, live as unknown as LiveClient);
      await flushMicrotasks();
      const decoder = vi.mocked(HTMLMediaElement.prototype.play).mock.contexts[0] as HTMLAudioElement;
      emitVoice(audio, true);
      const turnId = controller.session.activeTurn!.id;
      // The sole source turn can own PCM before its caption; retirement must not forge an idle edge.
      node.port.onmessage!({ data: { type: "turn", value: true } } as MessageEvent);
      live.emit({ type: "session.input_transcript.delta", delta: "Подскажите, где находится вокзал?" });
      live.emit({ type: "session.output_transcript.delta", delta: "Could you tell me where the train station is?" });
      emitVoice(audio, false);
      await vi.advanceTimersByTimeAsync(runtime.audioStartGraceMs + runtime.captionIdleMs);
      expect(controller.session.activeTurn).toMatchObject({ id: turnId, audioOutputStarted: true,
        translatedText: "Could you tell me where the train station is?" });
      expect((controller as unknown as { playbackActive: boolean }).playbackActive).toBe(true);
      expect(controller.metrics.snapshot().completedTurnCount).toBe(0);
      const clearInterval = vi.spyOn(window, "clearInterval");
      if (reason === "unexpected-close") live.emitSessionClosed("server_shutdown");
      else if (reason === "mic-ended") track.end();
      else live.onError?.({ type: "error", error: { message: "transport failed" }, transportFailure: true });
      expect(controller.session.state).toBe("error");
      expect(controller.session.activeTurn?.id).toBe(turnId);
      expect(controller.session.activeTurn?.turnCompletedAtMs).toBeUndefined();
      expect(controller.session.activeTurn?.playbackEndAtMs).toBeUndefined();
      expect(controller.session.recentTurns.some(turn => turn.id === turnId && turn.status === "completed")).toBe(false);
      expect(controller.metrics.snapshot()).toMatchObject({ completedTurnCount: 0, audioCompletedTurnCount: 0,
        textOnlyCompletedTurnCount: 0, textOnlyCompletionCount: 0, failedTurnCount: 1 });
      expect(controller.ownerError).toBe(reason === "mic-ended" ? MICROPHONE_CAPTURE_ENDED_MESSAGE : CONNECTION_ERROR_MESSAGE);
      expect(audio.audioElement.muted).toBe(true);
      expect(audio.audioElement.srcObject).toBeNull();
      expect(audio.getCaptureStream()).toBeNull();
      expect(decoder.srcObject).toBeNull();
      expect(decoder.onerror).toBeNull();
      expect(audio.onPlaybackDecoderError).toBeNull();
      expect(node.port.postMessage).toHaveBeenCalledWith({ type: "dispose" });
      expect(node.port.close).toHaveBeenCalledOnce();
      expect(clearInterval).toHaveBeenCalledOnce();
      expect(live.close).toHaveBeenCalledTimes(reason === "mic-ended" ? 1 : 0);
      expect(live.disconnectImmediately).not.toHaveBeenCalled();
      controller.handleRemoteStream(fakeRemoteStream("late-after-error"), live as unknown as LiveClient);
      expect(audio.audioElement.srcObject).toBeNull();
      expect(node.port.close).toHaveBeenCalledOnce();
    } finally { await controller.cancel(); audio.dispose(); }
  });

  it("preserves playback ending while decoder recovery is pending", async () => {
    const { controller, audio } = createController();
    await enterListening(controller);
    const element = audio.audioElement;
    controller.handleRemoteStream(fakeRemoteStream("remote"), controllerHarnesses.get(controller)!.live as unknown as LiveClient);
    await flushMicrotasks();
    emitPlayback(audio, true);
    let resolvePlay!: () => void;
    vi.mocked(element.play).mockImplementationOnce(() => new Promise<void>(resolve => { resolvePlay = resolve; }));
    let error: MediaError | null = { code: 3 } as MediaError;
    Object.defineProperty(element, "error", { get: () => error, configurable: true });
    vi.mocked(element.load).mockImplementation(() => { error = null; });
    element.onerror?.call(element, new Event("error"));
    emitPlayback(audio, false);
    resolvePlay();
    await flushMicrotasks();
    expect((controller as unknown as { playbackActive: boolean }).playbackActive).toBe(false);
  });

  it("logs a remote audio play failure without leaking an unhandled rejection", async () => {
    const { controller, audio } = createController();
    const remoteStream = fakeRemoteStream("remote");
    const playError = new Error("autoplay blocked");
    audio.audioElement.play = vi.fn(async () => {
      throw playError;
    });
    const consoleError = vi.spyOn(console, "error").mockImplementation(() => {});

    const unhandled = await collectUnhandledRejectionsDuring(async () => {
      controller.handleRemoteStream(remoteStream, controllerHarnesses.get(controller)!.live as unknown as LiveClient);
    });

    expect(unhandled).toEqual([]);
    expect(consoleError).toHaveBeenCalledExactlyOnceWith("Remote audio playback failed", {
      error: playError,
    });
  });

  it("ignores stale remote audio play failure after reset", async () => {
    const { controller, audio } = createController();
    const remoteStream = fakeRemoteStream("remote");
    const playError = new Error("late autoplay block");
    let rejectPlay: ((error: Error) => void) | undefined;
    audio.audioElement.play = vi.fn(
      () =>
        new Promise<void>((_resolve, reject) => {
          rejectPlay = reject;
        }),
    );
    const consoleError = vi.spyOn(console, "error").mockImplementation(() => {});

    const unhandled = await collectUnhandledRejectionsDuring(async () => {
      controller.handleRemoteStream(remoteStream, controllerHarnesses.get(controller)!.live as unknown as LiveClient);
      await controller.startContextCapture();
      await controller.cancel();
      rejectPlay?.(playError);
    });

    expect(unhandled).toEqual([]);
    expect(consoleError).not.toHaveBeenCalled();
    expect(controller.session.state).toBe("idle");
  });

  it("sets ownerError on interpreter failure, stays on the owner screen, and does not resend thinking", async () => {
    const { controller, live, audio } = createController();
    await controller.startContextCapture();
    controller.setContextText("We are ordering lunch.");
    await controller.startBootstrap();
    await calibrate(controller);

    live.appendInstructions.mockRejectedValueOnce(new Error("ack timeout"));

    await expect(controller.beginInterpreter()).rejects.toThrow("ack timeout");
    expect(controller.session.state).toBe("error");
    expect(controller.ownerError).toBe(STARTUP_ERROR_MESSAGE);
    expect(controller.hasEnteredInterpreter).toBe(false);
    expect(audio.setOutputAudible).not.toHaveBeenCalledWith(true);
    expect(live.appendThinking).toHaveBeenCalledOnce();
    expect(live.appendInstructions).toHaveBeenCalledOnce();
  });

  it("maps first_steering double timeout to startup error without opening conversation gates", async () => {
    const { controller, live, audio } = createController();
    await controller.startBootstrap();
    await calibrate(controller);
    live.appendInstructions.mockImplementation(async (text: string, policy?: { kind: string }) => {
      live.callOrder.push(`instructions:${text}`);
      if (policy?.kind === "first_steering") {
        throw new Error("ack timeout");
      }
      return { eventId: "evt-ok" };
    });

    await expect(controller.beginInterpreter()).rejects.toThrow("ack timeout");
    expect(controller.session.state).toBe("error");
    expect(controller.ownerError).toBe(STARTUP_ERROR_MESSAGE);
    expect(controller.hasEnteredInterpreter).toBe(false);
    expect(audio.setOutputAudible).not.toHaveBeenCalledWith(true);
  });

  it("leaves empty bootstrap unassigned", async () => {
    const { controller } = createController();
    await controller.startBootstrap();
    await controller.acceptBootstrap("   ");
    expect(controller.ownerError).toContain("полное предложение");
    expect(controller.session.participantA.language).toBeUndefined();
  });

  it("closes the in-flight LiveClient on cancel during connecting and ignores a late connect", async () => {
    const created: FakeLive[] = [];
    const audio = createFakeAudio();
    const controller = new SessionController({
      createLive: () => {
        const live = new FakeLive();
        created.push(live);
        return live as unknown as LiveClient;
      },
      audio: audio as unknown as AudioController,
    });
    const first = created[0];
    if (first === undefined) {
      throw new Error("LiveClient was not created");
    }
    let finishConnect: ((value: { sessionId: string }) => void) | undefined;
    first.connect.mockImplementation(
      () =>
        new Promise<{ sessionId: string }>((resolve) => {
          finishConnect = resolve;
        }),
    );

    const starting = controller.startContextCapture();
    await vi.waitFor(() => {
      expect(first.connect).toHaveBeenCalledOnce();
    });

    await controller.cancel();

    expect(first.close).toHaveBeenCalledOnce();
    expect(controller.session.state).toBe("idle");
    expect(created).toHaveLength(2);
    expect(created[1]?.close).not.toHaveBeenCalled();

    if (finishConnect === undefined) {
      throw new Error("connect was not started");
    }
    finishConnect({ sessionId: "late" });
    await starting;

    expect(controller.session.state).toBe("idle");
    expect(created[1]?.connect).not.toHaveBeenCalled();

    await controller.startContextCapture();
    expect(created[1]?.connect).toHaveBeenCalledOnce();
    expect(first.connect).toHaveBeenCalledOnce();
    expect(controller.session.state).toBe("context");
  });

  it("notifies subscribers that start is available after cancelling a denied microphone", async () => {
    vi.spyOn(console, "error").mockImplementation(() => {});
    const { controller, audio } = createController();
    audio.startCapture.mockRejectedValueOnce(new DOMException("Permission denied", "NotAllowedError"));
    await expect(controller.startWithLanguages({ A: "en", B: "es" })).rejects.toThrow();
    let renderedBusy = controller.isConnectInFlight;
    controller.subscribe(() => { renderedBusy = controller.isConnectInFlight; });

    await controller.cancel();

    expect(controller.session.state).toBe("idle");
    expect(controller.ownerError).toBeUndefined();
    expect(renderedBusy).toBe(false);
    await controller.startWithLanguages({ A: "en", B: "es" });
    expect(controller.session.state).toBe("listening");
  });

  it("cancels cleanly after LiveClient connect fails before transport exists", async () => {
    const errorSpy = vi.spyOn(console, "error").mockImplementation(() => {});
    try {
      const audio = createFakeAudio();
      const createLive = () =>
        new LiveClient({
          backend: { createLiveSession: vi.fn() } as unknown as BackendClient,
          peerFactory: () => {
            throw new Error("WebRTC is unavailable");
          },
          onRemoteStream: vi.fn(),
        });
      const controller = new SessionController({
        createLive,
        audio: audio as unknown as AudioController,
      });

      await expect(controller.startContextCapture()).rejects.toThrow(
        "WebRTC is unavailable",
      );
      expect(controller.session.state).toBe("error");
      expect(controller.ownerError).toBe(STARTUP_ERROR_MESSAGE);

      const unhandled = await collectUnhandledRejectionsDuring(() => {
        void controller.cancel();
      });

      expect(unhandled).toEqual([]);
      expect(controller.session.state).toBe("idle");
      expect(controller.ownerError).toBeUndefined();
      expect(audio.getCaptureStream()).toBeNull();
    } finally {
      errorSpy.mockRestore();
    }
  });

  it("serializes beginInterpreter and ignores a second activation while one is in flight", async () => {
    const { controller, live } = createController();
    await controller.startBootstrap();
    await calibrate(controller);

    let releaseFirstAppend: (() => void) | undefined;
    let appendCalls = 0;
    live.appendInstructions.mockImplementation(async () => {
      appendCalls += 1;
      if (appendCalls === 1) {
        await new Promise<void>((resolve) => {
          releaseFirstAppend = resolve;
        });
      }
      return { eventId: `evt-${appendCalls}` };
    });

    const first = controller.beginInterpreter();
    const second = controller.beginInterpreter();
    await vi.waitFor(() => {
      expect(appendCalls).toBe(1);
      expect(controller.isInterpreterStarting).toBe(true);
    });
    if (releaseFirstAppend === undefined) {
      throw new Error("first interpreter append was not started");
    }
    releaseFirstAppend();
    await first;
    await second;

    expect(appendCalls).toBe(2);
    expect(controller.session.state).toBe("listening");
    expect(controller.isInterpreterStarting).toBe(false);
  });

  it("maps NotAllowedError to the microphone permission message", async () => {
    const audio = createFakeAudio();
    audio.startCapture.mockRejectedValueOnce(
      Object.assign(new Error("Permission denied"), { name: "NotAllowedError" }),
    );
    const { controller } = createController({ audio });

    await expect(controller.startContextCapture()).rejects.toThrow(
      MICROPHONE_DENIED_MESSAGE,
    );
    expect(controller.ownerError).toBe(MICROPHONE_DENIED_MESSAGE);
    expect(controller.session.state).toBe("idle");
  });

  it("does not connect or enter setup when the microphone track ends during startup capture", async () => {
    const audio = createFakeAudio();
    const live = new FakeLive();
    audio.startCapture.mockImplementationOnce(async () => {
      audio.setCaptureStream(audio.captureStream);
      audio.endCaptureTrack();
    });
    const { controller } = createController({ audio, live });

    await expect(controller.startBootstrap()).rejects.toThrow(MICROPHONE_CAPTURE_ENDED_MESSAGE);

    expect(controller.ownerError).toBe(MICROPHONE_CAPTURE_ENDED_MESSAGE);
    expect(controller.session.state).toBe("idle");
    expect(controller.hasEnteredInterpreter).toBe(false);
    expect(live.connect).not.toHaveBeenCalled();
    expect(audio.stopCapture).toHaveBeenCalledOnce();
  });

  it("closes the in-flight LiveClient when the microphone track ends during connect", async () => {
    const audio = createFakeAudio();
    const live = new FakeLive();
    let rejectConnect: ((error: Error) => void) | undefined;
    live.connect.mockImplementation(
      () =>
        new Promise<{ sessionId: string }>((_resolve, reject) => {
          rejectConnect = reject;
        }),
    );
    live.close.mockImplementation(async () => {
      rejectConnect?.(new Error("Live session close started before session.started"));
      return { finalized: false };
    });
    const { controller } = createController({ audio, live });

    const starting = controller.startContextCapture();
    await vi.waitFor(() => {
      expect(live.connect).toHaveBeenCalledOnce();
    });

    try {
      const unhandled = await collectUnhandledRejectionsDuring(async () => {
        audio.endCaptureTrack();
      });

      expect(unhandled).toEqual([]);
      expect(live.close).toHaveBeenCalledOnce();
      expect(controller.session.state).toBe("error");
      expect(controller.ownerError).toBe(MICROPHONE_CAPTURE_ENDED_MESSAGE);
    } finally {
      rejectConnect?.(new Error("test cleanup"));
      await starting.catch(() => {});
    }
  });

  it("closes a connected LiveClient when the microphone track ends before retrying", async () => {
    const created: FakeLive[] = [];
    const audio = createFakeAudio();
    const controller = new SessionController({
      createLive: () => {
        const live = new FakeLive();
        created.push(live);
        return live as unknown as LiveClient;
      },
      audio: audio as unknown as AudioController,
    });
    const first = created[0];
    if (first === undefined) {
      throw new Error("LiveClient was not created");
    }

    await controller.startContextCapture();
    const unhandled = await collectUnhandledRejectionsDuring(async () => {
      audio.endCaptureTrack();
    });

    expect(unhandled).toEqual([]);
    expect(first.close).toHaveBeenCalledOnce();
    expect(controller.session.state).toBe("error");
    expect(controller.ownerError).toBe(MICROPHONE_CAPTURE_ENDED_MESSAGE);

    await controller.cancel();
    expect(controller.session.state).toBe("idle");
    expect(created).toHaveLength(2);
    expect(created[1]?.close).not.toHaveBeenCalled();

    const retryTrack = audio.captureStream.getAudioTracks()[0] as MediaStreamTrack;
    Object.defineProperty(retryTrack, "readyState", {
      configurable: true,
      value: "live",
    });
    await controller.startContextCapture();
    expect(created[1]?.connect).toHaveBeenCalledOnce();
    expect(first.connect).toHaveBeenCalledOnce();
    expect(controller.session.state).toBe("context");
  });

  it("sets ownerError on microphone and connect failures", async () => {
    const audio = createFakeAudio();
    audio.startCapture.mockRejectedValueOnce(new Error("Microphone access is required for translation."));
    const { controller: micController } = createController({ audio });

    await expect(micController.startContextCapture()).rejects.toThrow(
      "Microphone access is required for translation.",
    );
    expect(micController.ownerError).toBe(STARTUP_ERROR_MESSAGE);

    const live = new FakeLive();
    live.connect.mockRejectedValueOnce(new Error("Unable to establish live connection"));
    const { controller: connectController } = createController({ live });

    await expect(connectController.startContextCapture()).rejects.toThrow(
      "Unable to establish live connection",
    );
    expect(connectController.ownerError).toBe(STARTUP_ERROR_MESSAGE);
  });

  it("ignores a late interpreter append after cancel and stays idle", async () => {
    const created: FakeLive[] = [];
    const audio = createFakeAudio();
    const controller = new SessionController({
      createLive: () => {
        const live = new FakeLive();
        created.push(live);
        return live as unknown as LiveClient;
      },
      audio: audio as unknown as AudioController,
    });

    await controller.startBootstrap();
    await calibrate(controller);

    const interpreterLive = created[1];
    if (interpreterLive === undefined) {
      throw new Error("Bootstrap replacement LiveClient was not created");
    }

    let releaseInterpreterAppend: (() => void) | undefined;
    interpreterLive.appendInstructions.mockImplementation(
      () =>
        new Promise<{ eventId: string }>((resolve) => {
          releaseInterpreterAppend = () => {
            resolve({ eventId: "evt-late" });
          };
        }),
    );

    const starting = controller.beginInterpreter();
    await vi.waitFor(() => {
      expect(interpreterLive.appendInstructions).toHaveBeenCalledOnce();
      expect(controller.isInterpreterStarting).toBe(true);
    });

    await controller.cancel();

    expect(interpreterLive.close).toHaveBeenCalledOnce();
    expect(controller.session.state).toBe("idle");
    expect(controller.ownerError).toBeUndefined();
    expect(created).toHaveLength(3);

    if (releaseInterpreterAppend === undefined) {
      throw new Error("interpreter append was not started");
    }
    releaseInterpreterAppend();
    await starting;

    expect(controller.session.state).toBe("idle");
    expect(controller.ownerError).toBeUndefined();
    expect(controller.isInterpreterStarting).toBe(false);
    expect(audio.setOutputAudible).toHaveBeenLastCalledWith(false);
    expect(created[2]?.appendInstructions).not.toHaveBeenCalled();
  });

  it("cancels during microphone wait and stops a capture that lands after reset", async () => {
    const audio = createFakeAudio();
    let stream: MediaStream | null = null;
    audio.getCaptureStream.mockImplementation(() => stream);
    audio.stopCapture.mockImplementation(() => {
      stream = null;
    });
    let finishCapture: (() => void) | undefined;
    audio.startCapture.mockImplementationOnce(
      () =>
        new Promise<void>((resolve) => {
          finishCapture = () => {
            stream = audio.captureStream;
            resolve();
          };
        }),
    );
    audio.startCapture.mockImplementation(async () => {
      if (stream !== null) {
        throw new Error("Microphone capture has already started");
      }
      stream = audio.captureStream;
    });

    const { controller } = createController({ audio });

    const starting = controller.startContextCapture();
    await vi.waitFor(() => {
      expect(audio.startCapture).toHaveBeenCalledOnce();
      expect(controller.isConnectInFlight).toBe(true);
    });
    expect(controller.session.state).toBe("idle");

    const cancelling = controller.cancel();
    if (finishCapture === undefined) {
      throw new Error("startCapture was not started");
    }
    finishCapture();
    await cancelling;
    await starting;

    expect(controller.session.state).toBe("idle");
    expect(audio.stopCapture).toHaveBeenCalledOnce();
    expect(audio.getCaptureStream()).toBeNull();
    expect(controller.ownerError).toBeUndefined();

    await controller.startContextCapture();
    expect(audio.startCapture).toHaveBeenCalledTimes(2);
    expect(controller.session.state).toBe("context");
  });

  it("cancels pending real microphone capture before its track exists", async () => {
    let grant!: (stream: MediaStream) => void;
    const { audio, track } = createDispatchableAudio(() => new Promise(resolve => { grant = resolve; }));
    const stream = {
      getAudioTracks: () => [track],
      getTracks: () => [track],
      clone: () => ({
        getAudioTracks: () => [new DispatchableMicTrack()],
        getTracks: () => [new DispatchableMicTrack()],
      }),
    } as unknown as MediaStream;
    const { controller } = createController({ audio });

    const starting = controller.startContextCapture();
    await vi.waitFor(() => expect(grant).toBeTypeOf("function"));
    const cancelling = controller.cancel();
    grant(stream);

    await expect(cancelling).resolves.toBeUndefined();
    await expect(starting).resolves.toBeUndefined();
    expect(controller.session.state).toBe("idle");
    expect(controller.isConnectInFlight).toBe(false);
    expect(audio.getCaptureStream()).toBeNull();
  });

  it("swallows a late primeOutput rejection after cancel and still stops a late capture stream", async () => {
    const audio = createFakeAudio();
    let stream: MediaStream | null = null;
    audio.getCaptureStream.mockImplementation(() => stream);
    audio.stopCapture.mockImplementation(() => {
      stream = null;
    });
    let rejectPrime: ((error: Error) => void) | undefined;
    audio.primeOutput.mockImplementation(
      () =>
        new Promise<void>((_, reject) => {
          rejectPrime = reject;
        }),
    );

    const { controller } = createController({ audio });
    const starting = controller.startContextCapture();
    await vi.waitFor(() => {
      expect(audio.primeOutput).toHaveBeenCalledOnce();
    });

    const cancelling = controller.cancel();
    if (rejectPrime === undefined) {
      throw new Error("primeOutput was not started");
    }
    stream = audio.captureStream;
    rejectPrime(new Error("AudioContext resume failed"));
    await expect(cancelling).resolves.toBeUndefined();
    await expect(starting).resolves.toBeUndefined();

    expect(controller.session.state).toBe("idle");
    expect(controller.ownerError).toBeUndefined();
    expect(audio.stopCapture).toHaveBeenCalledOnce();
    expect(audio.getCaptureStream()).toBeNull();
  });

  it("clears ownerError when a later connect attempt succeeds", async () => {
    const audio = createFakeAudio();
    audio.startCapture.mockRejectedValueOnce(
      new Error("Microphone access is required for translation."),
    );
    const { controller } = createController({ audio });

    await expect(controller.startContextCapture()).rejects.toThrow(
      "Microphone access is required for translation.",
    );
    expect(controller.ownerError).toBe(STARTUP_ERROR_MESSAGE);

    await controller.startContextCapture();

    expect(controller.session.state).toBe("context");
    expect(controller.ownerError).toBeUndefined();
  });
});

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

async function collectUnhandledRejectionsDuring(
  action: () => Promise<void> | void,
): Promise<unknown[]> {
  const unhandled: unknown[] = [];
  const onUnhandled = (reason: unknown) => {
    unhandled.push(reason);
  };
  process.on("unhandledRejection", onUnhandled);
  try {
    await action();
    await flushMicrotasks();
    await new Promise<void>((resolve) => {
      setTimeout(resolve, 0);
    });
  } finally {
    process.off("unhandledRejection", onUnhandled);
  }
  return unhandled;
}

async function collectUnhandledRejectionsDuringFakeTimers(
  action: () => Promise<void> | void,
): Promise<unknown[]> {
  const unhandled: unknown[] = [];
  const onUnhandled = (reason: unknown) => {
    unhandled.push(reason);
  };
  process.on("unhandledRejection", onUnhandled);
  try {
    await action();
    await flushMicrotasks();
    await vi.advanceTimersByTimeAsync(0);
    await flushMicrotasks();
  } finally {
    process.off("unhandledRejection", onUnhandled);
  }
  return unhandled;
}

async function startGateARestoreFailureRemuteRace(): Promise<{
  controller: SessionController;
  live: FakeLive;
  releaseRemute: () => void;
  resuming: Promise<void>;
  setCaptureEnabled: ReturnType<typeof vi.fn>;
}> {
  const audio = createFakeAudio();
  const setCaptureEnabled = vi.fn((enabled: boolean) => {
    audio.captureTrack.enabled = enabled;
    if (enabled) {
      throw new Error("capture enable failed");
    }
  });
  audio.setCaptureEnabled = setCaptureEnabled;
  const live = new FakeLive();
  let releaseRemute: (() => void) | undefined;
  let muteAttempts = 0;
  live.setInputMuted.mockImplementation(async (muted: boolean) => {
    if (!muted) {
      return;
    }
    muteAttempts += 1;
    if (muteAttempts === 1) {
      return;
    }
    await new Promise<void>((resolve) => {
      releaseRemute = resolve;
    });
  });
  const { controller } = createController({ audio, live });
  await enterListening(controller);
  emitVoice(audio, true);
  await vi.advanceTimersByTimeAsync(runtime.maxSourceMs);
  await flushMicrotasks();

  const resuming = controller.resumeFromSourceTimeout();
  await waitUntil(() => muteAttempts >= 2 && releaseRemute !== undefined);
  if (releaseRemute === undefined) {
    throw new Error("Gate B remute did not start");
  }
  return { controller, live, releaseRemute, resuming, setCaptureEnabled };
}

async function completeTextOnlyTurn(
  controller: SessionController,
  live: FakeLive,
  audio: ReturnType<typeof createFakeAudio>,
): Promise<void> {
  emitVoice(audio, true);
  live.emit({
    type: "session.input_transcript.delta",
    delta: "Hello, where is the nearest train station?",
    start_ms: 10,
    end_ms: 40,
  });
  live.emit({ type: "session.output_transcript.delta", delta: "Hola, ¿dónde está la estación?" });
  emitVoice(audio, false);
  await flushMicrotasks();
  await vi.advanceTimersByTimeAsync(runtime.audioStartGraceMs);
  await flushMicrotasks();
  if (controller.session.state !== "listening") {
    throw new Error(`Expected listening after text-only close, got "${controller.session.state}"`);
  }
}

async function enterOutputtingTurn(
  controller: SessionController,
  live: FakeLive,
  audio: ReturnType<typeof createFakeAudio>,
): Promise<void> {
  await enterListening(controller);
  emitVoice(audio, true);
  live.emit({ type: "session.input_transcript.delta", delta: "Hello, where is the nearest train station?" });
  live.emit({ type: "session.output_transcript.delta", delta: "Hola, ¿dónde está la estación?" });
  emitPlayback(audio, true);
  await flushMicrotasks();
  emitVoice(audio, false);
  await flushMicrotasks();
  expect(controller.session.state).toBe("outputting");
  expect(controller.session.activeTurn?.speaker).toBe("A");
}

describe("SessionController turn engine", () => {
  it.each([false, true])("records a sole turn's fully played PCM before its first caption, draining=%s", async draining => {
    const rate = 48000;
    const queue = new PlaybackQueue(rate);
    const audio = Object.assign(createFakeAudio(), { setPlaybackTurn: vi.fn((id: string | undefined) => queue.setTurn(id)) });
    Object.defineProperty(audio, "hasPendingPlayback", { get: () => queue.pending });
    audio.setOutputAudible.mockImplementation(audible => {
      audio.audioElement.muted = !audible;
      queue.setAudible(audible);
    });
    const { controller, live } = createController({ audio });
    await controller.startWithLanguages({ A: "ru", B: "en" });
    queue.setEnabled(draining); queue.setSpeaking(false);
    if (draining) queue.process(new Float32Array(rate * .3));
    emitVoice(audio, true);
    live.emit({ type: "session.input_transcript.delta", delta: "Подскажите, где находится вокзал?" });
    const id = controller.session.activeTurn!.id;
    emitVoice(audio, false);
    const origin = Date.now();
    let position = 0;
    const edges: Array<{ active: boolean; atMs: number; position: number }> = [];
    queue.onPlaybackTurn = (turnId, active) => {
      const event = { active, atMs: origin + Math.floor(position * 1000 / rate), turnId, owned: true };
      edges.push({ ...event, position });
      audio.onPlaybackActivity?.(event);
    };
    const input = new Float32Array(1), output = new Float32Array(1);
    const played: number[] = [];
    // Clock the actual queue one sample at a time, including its complete played-idle interval.
    for (; position < rate * .8; position++) {
      input[0] = position < 4800 ? .5 : 0;
      queue.process(input, output);
      if (output[0]! > .1) played.push(output[0]!);
    }
    expect(played).toEqual(new Array(4800).fill(.5));
    expect(queue.pending).toBe(false);
    expect(edges.map(edge => edge.active)).toEqual([true, false]);
    expect(edges[0]!.atMs).toBe(origin + (draining ? 60 : 0));
    expect(edges[1]!.position - edges[0]!.position).toBe(28799);
    expect(edges[1]!.atMs - edges[0]!.atMs).toBe(599);
    await vi.advanceTimersByTimeAsync(800);
    const findTurn = () => [controller.session.activeTurn, ...(controller.session.pendingTurns ?? []),
      ...controller.session.recentTurns].find(turn => turn?.id === id)!;
    expect(findTurn()).toMatchObject({ audioOutputStarted: true, firstAudibleOutputAtMs: edges[0]!.atMs,
      playbackEndAtMs: edges[1]!.atMs });
    live.emit({ type: "session.output_transcript.delta", delta: "Where is the train station?" });
    await vi.advanceTimersByTimeAsync(runtime.outputSettleGraceMs + runtime.captionIdleMs);
    expect(findTurn()).toMatchObject({ status: "completed", translatedText: "Where is the train station?",
      audioOutputStarted: true, firstAudibleOutputAtMs: edges[0]!.atMs, playbackEndAtMs: edges[1]!.atMs });
    expect(controller.metrics.snapshot()).toMatchObject({ audioCompletedTurnCount: 1, textOnlyCompletedTurnCount: 0 });
    await controller.endConversation();
  });
  it.each([
    [false, false, 1000, false], [false, true, 1000, false],
    [true, false, 1000, false], [true, true, 1000, false],
    [false, true, 300, false], [true, true, 300, true],
  ] as const)("preserves PCM without inventing delayed ownership, decoder pending=%s, second caption delayed=%s, gap=%s ms, first delayed=%s", async (decoderPending, captionDelayed, gapMs, firstDelayed) => {
    const queue = new PlaybackQueue(1000);
    const audio = Object.assign(createFakeAudio(), {
      setNonInterrupting: vi.fn((enabled: boolean) => queue.setEnabled(enabled)),
      setPlaybackTurn: vi.fn((turnId: string | undefined) => queue.setTurn(turnId)),
      playOutput: vi.fn(async () => {}),
    });
    Object.defineProperty(audio, "hasPendingPlayback", { get: () => queue.pending });
    audio.setOutputAudible.mockImplementation(audible => {
      audio.audioElement.muted = !audible;
      queue.setAudible(audible);
    });
    const played: string[] = [];
    queue.onPlaybackTurn = (turnId, active) => {
      if (turnId && active) played.push(turnId);
      const event = { active, atMs: Date.now(), turnId, owned: true };
      audio.onPlaybackActivity?.(event);
    };
    const { controller, live } = createController({ audio });
    await controller.startWithLanguages({ A: "ru", B: "en" });
    let ready!: () => void;
    if (decoderPending) {
      audio.playOutput.mockImplementationOnce(() => new Promise<void>(resolve => { ready = resolve; }));
      controller.handleRemoteStream(fakeRemoteStream("remote"), live as unknown as LiveClient);
    }
    audio.setNonInterrupting(true);
    queue.setSpeaking(true);
    emitVoice(audio, true);
    live.emit({ type: "session.input_transcript.delta", delta: "Подскажите, где находится вокзал?", start_ms: 0, end_ms: 500 });
    const a = controller.session.activeTurn!.id;
    if (!firstDelayed) live.emit({ type: "session.output_transcript.delta", delta: "Where is the train station?", start_ms: 600, end_ms: 900 });
    queue.process(new Float32Array(128).fill(.5));
    queue.process(new Float32Array(gapMs)); // A gap alone cannot identify the next PCM owner.
    live.emit({ type: "session.input_transcript.delta", delta: "The station is straight ahead.", start_ms: 1000, end_ms: 1500 });
    const b = controller.session.activeTurn!.id;
    if (captionDelayed) queue.process(new Float32Array(128).fill(.7));
    if (firstDelayed) live.emit({ type: "session.output_transcript.delta", delta: "Where is the train station?", start_ms: 600, end_ms: 900 });
    live.emit({ type: "session.output_transcript.delta", delta: " Please show me the way.", start_ms: 910, end_ms: 980 });
    live.emit({ type: "session.output_transcript.delta", delta: "Вокзал находится прямо впереди.", start_ms: 1600, end_ms: 1900 });
    if (!captionDelayed) queue.process(new Float32Array(128).fill(.7));
    emitVoice(audio, false);
    await flushMicrotasks();
    await vi.advanceTimersByTimeAsync(runtime.audioStartGraceMs + runtime.outputSettleGraceMs + 500);
    expect(controller.session.pendingTurns?.map(turn => turn.id)).toContain(a);
    expect(controller.session.activeTurn?.id).toBe(b);
    expect(controller.captionBlocks.map(block => block.text).join(" ")).toContain("Вокзал находится прямо впереди.");
    queue.setSpeaking(false);
    queue.process(new Float32Array(300));
    const output = queue.process(new Float32Array(1000));
    expect(output.filter(sample => sample > .1)).toEqual(Float32Array.from([
      ...new Array(128).fill(.5), ...new Array(128).fill(.7),
    ]));
    expect(played).toEqual(captionDelayed ? [a] : [a, b]);
    if (decoderPending) {
      expect(controller.session.activeTurn?.audioOutputStarted).toBe(false);
      ready();
      await flushMicrotasks();
    }
    const first = controller.session.pendingTurns!.find(turn => turn.id === a)!;
    expect(first.audioOutputStarted).toBe(true);
    expect(first.firstAudibleOutputAtMs).toBeDefined();
    expect(first.playbackEndAtMs).toBeDefined(); // Explicit owner transition, without an idle edge between A and B.
    expect(controller.session.activeTurn?.audioOutputStarted).toBe(!captionDelayed);
    if (captionDelayed) {
      expect(controller.session.activeTurn?.firstAudibleOutputAtMs).toBeUndefined();
      expect(controller.session.activeTurn?.playbackEndAtMs).toBeUndefined();
    } else {
      expect(controller.session.activeTurn?.firstAudibleOutputAtMs).toBeGreaterThanOrEqual(first.playbackEndAtMs!);
    }
    emitPlayback(audio, false);
    await vi.advanceTimersByTimeAsync(runtime.outputSettleGraceMs + 100);
    expect(controller.session.activeTurn).toBeUndefined();
    expect(controller.session.pendingTurns ?? []).toHaveLength(0);
    for (const id of [a, b]) {
      const turn = controller.session.recentTurns.find(turn => turn.id === id)!;
      expect(turn.status).toBe("completed");
      const attributed = id === a || !captionDelayed;
      expect(turn.audioOutputStarted).toBe(attributed);
      if (attributed) {
        expect(turn.firstAudibleOutputAtMs).toBeDefined();
        expect(turn.playbackEndAtMs).toBeDefined();
      } else {
        expect(turn.firstAudibleOutputAtMs).toBeUndefined();
        expect(turn.playbackEndAtMs).toBeUndefined();
      }
    }
    expect(controller.metrics.snapshot()).toMatchObject({
      audioCompletedTurnCount: captionDelayed ? 1 : 2, textOnlyCompletedTurnCount: captionDelayed ? 1 : 0,
    });
    await controller.endConversation();
  });
  it("does not close a caption-only-looking turn while received audio is still queued", async () => {
    vi.useFakeTimers();
    const audio = Object.assign(createFakeAudio(), { hasPendingPlayback: true });
    const { controller, live } = createController({ audio });
    await controller.startWithLanguages({ A: "en", B: "es" });
    emitVoice(audio, true);
    live.emit({ type: "session.input_transcript.delta", delta: "Where is the station?" });
    live.emit({ type: "session.output_transcript.delta", delta: "Dónde está la estación?" });
    emitVoice(audio, false);
    await flushMicrotasks();
    await vi.advanceTimersByTimeAsync(runtime.audioStartGraceMs + runtime.outputSettleGraceMs + 500);
    expect(controller.session.activeTurn).toBeDefined();
    audio.hasPendingPlayback = false;
    await vi.advanceTimersByTimeAsync(100);
    expect(controller.session.activeTurn).toBeUndefined();
    await controller.endConversation();
    vi.useRealTimers();
  });

  beforeEach(() => {
    setDeviceLanguage("ru-RU");
    vi.useFakeTimers();
    vi.setSystemTime(new Date("2026-01-01T00:00:00.000Z"));
  });

  it("applies a language change after the current utterance closes", async () => {
    const { controller, live, audio } = createController();
    await controller.startWithLanguages({ A: "en", B: "es" });
    emitVoice(audio, true);
    live.emit({ type: "session.input_transcript.delta", delta: "Hello, where is the nearest train station?" });
    live.emit({ type: "session.output_transcript.delta", delta: "Hola, ¿dónde está la estación?" });

    await controller.changeInterlocutorLanguage("de");
    expect(controller.session.participantB.language).toBe("es");

    emitVoice(audio, false);
    await flushMicrotasks();
    await vi.advanceTimersByTimeAsync(runtime.audioStartGraceMs);
    expect(controller.session.participantB.language).toBe("de");
    expect(live.appendInstructions).toHaveBeenLastCalledWith(
      buildSteering({ A: "en", B: "de" }), expect.anything(),
    );
  });

  it("can cancel a queued language change before the utterance closes", async () => {
    const { controller, live, audio } = createController();
    await controller.startWithLanguages({ A: "en", B: "es" });
    emitVoice(audio, true);
    live.emit({ type: "session.input_transcript.delta", delta: "Hello, where is the nearest train station?" });
    live.emit({ type: "session.output_transcript.delta", delta: "Hola, ¿dónde está la estación?" });

    await controller.changeInterlocutorLanguage("de");
    await controller.changeInterlocutorLanguage("es");
    emitVoice(audio, false);
    await flushMicrotasks();
    await vi.advanceTimersByTimeAsync(runtime.audioStartGraceMs);

    expect(controller.session.participantB.language).toBe("es");
    expect(live.appendInstructions).toHaveBeenLastCalledWith(
      buildSteering({ A: "en", B: "es" }), expect.anything(),
    );
  });

  it("keeps the queued language and input closed until failed-turn steering is applied", async () => {
    const { controller, live, audio } = createController();
    await controller.startWithLanguages({ A: "en", B: "es" });
    emitVoice(audio, true);
    live.emit({ type: "session.input_transcript.delta", delta: "Where is the nearest train station?" });
    await controller.changeInterlocutorLanguage("de");
    emitVoice(audio, false);
    await flushMicrotasks();
    const readiness: boolean[] = [];
    const unsubscribe = controller.subscribe(() => readiness.push(controller.inputReady));
    let release!: () => void;
    live.appendInstructions.mockImplementationOnce(async () => {
      await new Promise<void>(resolve => { release = resolve; });
      return { eventId: "changed-language" };
    });
    await vi.advanceTimersByTimeAsync(runtime.noOutputTimeoutMs + runtime.captionIdleMs);
    expect(controller.session.participantB.language).toBe("de");
    expect(controller.selectedInterlocutorLanguage).toBe("de");
    expect(readiness).not.toContain(true);
    expect(controller.inputReady).toBe(false);
    release();
    await waitUntil(() => controller.inputReady);
    expect(controller.session.participantB.language).toBe("de");
    expect(controller.selectedInterlocutorLanguage).toBe("de");
    expect(controller.inputReady).toBe(true);
    unsubscribe();
  });

  it("does not start a new turn while changing the language between utterances", async () => {
    const { controller, live, audio } = createController();
    await controller.startWithLanguages({ A: "en", B: "es" });
    let releaseMute: (() => void) | undefined;
    live.setInputMuted.mockImplementation(async (muted: boolean) => {
      if (muted) await new Promise<void>(resolve => { releaseMute = resolve; });
    });

    const changing = controller.changeInterlocutorLanguage("de");
    await waitUntil(() => releaseMute !== undefined);
    emitVoice(audio, true);
    live.emit({ type: "session.input_transcript.delta", delta: "Hello, where is the station?" });
    expect(controller.session.activeTurn).toBeUndefined();
    releaseMute?.();
    await changing;
    expect(controller.session.participantB.language).toBe("de");
  });

  it("creates an active turn from the first listening input fragment using detected language", async () => {
    const { controller, live } = createController();
    await enterListening(controller);

    live.emit({
      type: "session.input_transcript.delta",
      delta: "Where is apartment 12?",
      start_ms: 100,
      end_ms: 400,
    });

    expect(controller.session.state).toBe("listening");
    expect(controller.session.activeTurn?.speaker).toBe("A");
    expect(controller.session.activeTurn?.originalText).toBe("Where is apartment 12?");
    expect(controller.session.activeTurn?.sourceFragments[0]?.startMs).toBe(100);
    expect(controller.session.activeTurn?.sourceFragments[0]?.endMs).toBe(400);
  });

  it("appends output captions without changing expected speaker or muting Gate B", async () => {
    const { controller, live, audio } = createController();
    await enterListening(controller);
    emitVoice(audio, true);
    live.emit({ type: "session.input_transcript.delta", delta: "Hello, where is the nearest train station?" });

    const receivedAtMs = Date.now();
    live.emit({ type: "session.output_transcript.delta", delta: "Hola, ¿dónde está la estación?" });
    await vi.advanceTimersByTimeAsync(runtime.captionIdleMs);

    expect(controller.session.state).toBe("outputting");
    expect(controller.session.activeTurn?.translatedText).toBe("Hola, ¿dónde está la estación?");
    expect(controller.session.activeTurn?.firstOutputTextAtMs).toBe(receivedAtMs);
    expect(live.setInputMuted).not.toHaveBeenCalled();
  });

  it("keeps translated text usable when remote audio playback cannot start", async () => {
    const { controller, live, audio } = createController();
    const playError = new Error("autoplay blocked");
    let rejectPlay: ((error: Error) => void) | undefined;
    audio.audioElement.play = vi.fn(
      () =>
        new Promise<void>((_resolve, reject) => {
          rejectPlay = reject;
        }),
    );
    vi.spyOn(console, "error").mockImplementation(() => {});

    await enterListening(controller);
    controller.handleRemoteStream(fakeRemoteStream("remote"), controllerHarnesses.get(controller)!.live as unknown as LiveClient);
    await flushMicrotasks();

    emitVoice(audio, true);
    live.emit({
      type: "session.input_transcript.delta",
      delta: "Hello, where is the nearest train station?",
      start_ms: 10,
      end_ms: 40,
    });
    live.emit({ type: "session.output_transcript.delta", delta: "Hola, ¿dónde está la estación?" });
    await vi.advanceTimersByTimeAsync(runtime.captionIdleMs);

    expect(controller.session.state).toBe("outputting");
    expect(controller.session.activeTurn?.translatedText).toBe("Hola, ¿dónde está la estación?");

    emitPlayback(audio, true);
    await flushMicrotasks();

    expect(controller.session.activeTurn?.audioOutputStarted).toBe(false);

    emitVoice(audio, false);
    rejectPlay?.(playError);
    await flushMicrotasks();
    await vi.advanceTimersByTimeAsync(runtime.audioStartGraceMs);
    await flushMicrotasks();

    expect(controller.session.state).toBe("listening");
    expect(controller.session.recentTurns[0]?.translatedText).toBe("Hola, ¿dónde está la estación?");
    expect(controller.session.recentTurns[0]?.audioOutputStarted).toBe(false);
    expect(controller.session.recentTurns[0]?.firstAudibleOutputAtMs).toBeUndefined();
    expect(controller.inputReady).toBe(true);
    expect(controller.metrics.snapshot().textOnlyCompletionCount).toBe(1);
    expect(controller.metrics.snapshot().lastTurn?.t2Ms).toBeUndefined();

    emitVoice(audio, true);
    live.emit({ type: "session.input_transcript.delta", delta: "Next" });
    await vi.advanceTimersByTimeAsync(runtime.captionIdleMs);

    expect(controller.session.activeTurn?.originalText).toBe("Next");
  });

  it("tracks buffered remote playback activity once media playback succeeds", async () => {
    const { controller, live, audio } = createController();
    let resolvePlay: (() => void) | undefined;
    audio.audioElement.play = vi.fn(
      () =>
        new Promise<void>((resolve) => {
          resolvePlay = resolve;
        }),
    );

    await enterListening(controller);
    controller.handleRemoteStream(fakeRemoteStream("remote"), controllerHarnesses.get(controller)!.live as unknown as LiveClient);
    emitVoice(audio, true);
    live.emit({ type: "session.input_transcript.delta", delta: "Hello, where is the nearest train station?" });
    live.emit({ type: "session.output_transcript.delta", delta: "Hola, ¿dónde está la estación?" });

    emitPlayback(audio, true);
    await flushMicrotasks();
    expect(controller.session.activeTurn?.audioOutputStarted).toBe(false);

    resolvePlay?.();
    await flushMicrotasks();

    expect(controller.session.activeTurn?.audioOutputStarted).toBe(true);
    expect(controller.session.activeTurn?.firstAudibleOutputAtMs).toBeDefined();
  });

  it("does not use provider input mute merely because audible output started", async () => {
    const { controller, audio, live } = createController();
    await enterListening(controller);
    emitVoice(audio, true);
    live.emit({ type: "session.input_transcript.delta", delta: "Hello, where is the nearest train station?" });

    emitPlayback(audio, true);
    await flushMicrotasks();

    expect(controller.session.activeTurn?.audioOutputStarted).toBe(true);
    expect(live.setInputMuted).not.toHaveBeenCalled();
  });

  it("closes a text-only turn with fixed languages while input stays open", async () => {
    const { controller, live, audio } = createController();
    await enterListening(controller);
    emitVoice(audio, true);
    live.emit({
      type: "session.input_transcript.delta",
      delta: "Hello, where is the nearest train station?",
      start_ms: 10,
      end_ms: 40,
    });
    live.emit({ type: "session.output_transcript.delta", delta: "Hola, ¿dónde está la estación?" });
    expect(live.setInputMuted).not.toHaveBeenCalled();

    emitVoice(audio, false);
    await flushMicrotasks();
    expect(live.setInputMuted).not.toHaveBeenCalled();
    await vi.advanceTimersByTimeAsync(runtime.audioStartGraceMs);
    await flushMicrotasks();

    expect(controller.session.state).toBe("listening");
    expect(controller.session.activeTurn).toBeUndefined();
    expect(controller.session.recentTurns[0]?.status).toBe("completed");
    expect(controller.session.lastSpeaker).toBe("A");
    expect(controller.session.participantA.hasAcceptedConversationSpeech).toBe(true);
    expect(controller.session.participantB.hasAcceptedConversationSpeech).toBe(false);
    expect(live.setInputMuted).not.toHaveBeenCalled();
    expect(live.appendInstructions.mock.calls.filter(call => call[1]?.kind === "later_steering")).toHaveLength(0);
  });

  it("keeps the source turn open when playback goes idle before the human has finished", async () => {
    const { controller, live, audio } = createController();
    await enterListening(controller);
    emitVoice(audio, true);
    live.emit({ type: "session.input_transcript.delta", delta: "Hello, where is the nearest train station?" });
    emitPlayback(audio, true);
    emitPlayback(audio, false);
    await flushMicrotasks();
    await vi.advanceTimersByTimeAsync(
      runtime.postSourceOutputGraceMs + runtime.outputSettleGraceMs,
    );
    await flushMicrotasks();

    expect(controller.session.activeTurn?.status).not.toBe("completed");
    expect(live.setInputMuted).not.toHaveBeenCalled();
  });

  it("waits POST_SOURCE_OUTPUT_GRACE_MS after source idle when playback already ended", async () => {
    const { controller, live, audio } = createController();
    await enterListening(controller);
    emitVoice(audio, true);
    live.emit({ type: "session.input_transcript.delta", delta: "Hello, where is the nearest train station?" });
    emitPlayback(audio, true);
    emitPlayback(audio, false);
    await vi.advanceTimersByTimeAsync(1);
    emitVoice(audio, false);
    await flushMicrotasks();

    await vi.advanceTimersByTimeAsync(runtime.postSourceOutputGraceMs - 1);
    await flushMicrotasks();
    expect(controller.session.activeTurn).toBeDefined();
    await vi.advanceTimersByTimeAsync(1);
    await flushMicrotasks();
    expect(controller.session.state).toBe("listening");
    expect(controller.session.recentTurns[0]?.status).toBe("completed");
  });

  it("fails a no-output turn, keeps the same speaker, restores input, and does not steer opposite", async () => {
    const { controller, live, audio } = createController();
    await enterListening(controller);
    const appendCountAfterStart = live.appendInstructions.mock.calls.length;
    emitVoice(audio, true);
    live.emit({ type: "session.input_transcript.delta", delta: "Hello, where is the nearest train station?" });
    emitVoice(audio, false);
    await flushMicrotasks();

    await vi.advanceTimersByTimeAsync(runtime.noOutputTimeoutMs - 1);
    await flushMicrotasks();
    expect(controller.session.activeTurn).toBeDefined();

    await vi.advanceTimersByTimeAsync(1);
    await flushMicrotasks();

    expect(controller.session.state).toBe("listening");
    expect(controller.session.recentTurns[0]?.status).toBe("failed");
    expect(controller.session.participantA.hasAcceptedConversationSpeech).toBe(false);
    expect(controller.recoveryPrompt).toBe("repeat");
    expect(controller.recoveryPromptIsTurnFailure).toBe(true);
    expect(live.setInputMuted).not.toHaveBeenCalled();
    expect(live.appendInstructions.mock.calls.length).toBe(appendCountAfterStart);
  });

  it("MAX_SOURCE_MS mutes, closes output, fails, warns, and suspends with Resume/Repeat", async () => {
    const { controller, live, audio } = createController();
    await enterListening(controller);
    emitVoice(audio, true);
    live.emit({ type: "session.input_transcript.delta", delta: "Hello, where is the nearest train station?" });

    await vi.advanceTimersByTimeAsync(runtime.maxSourceMs);
    await flushMicrotasks();

    expect(live.setInputMuted).toHaveBeenCalledWith(true);
    expect(audio.setCaptureEnabled).toHaveBeenLastCalledWith(false);
    expect(audio.captureTrack.enabled).toBe(false);
    expect(audio.setOutputAudible).toHaveBeenLastCalledWith(false);
    expect(controller.inputReady).toBe(false);
    expect(controller.session.state).toBe("suspended");
    expect(controller.session.recentTurns[0]?.status).toBe("failed");
    expect(controller.recoveryPrompt).toBe("resume-repeat");
    expect(live.appendInstructions).toHaveBeenCalledWith(buildUnfinishedTurnWarning(), {
      kind: "later_steering",
      sessionState: "suspended",
    });
  });

  it("MAX_SOURCE_MS forces Gate A off when capture disable throws", async () => {
    const errorSpy = vi.spyOn(console, "error").mockImplementation(() => {});
    try {
      const audio = createFakeAudio();
      audio.setCaptureEnabled = vi.fn((enabled: boolean) => {
        if (!enabled) {
          throw new Error("capture disable failed");
        }
        audio.captureTrack.enabled = enabled;
      });
      const { controller, live } = createController({ audio });
      await enterListening(controller);
      emitVoice(audio, true);
      live.emit({ type: "session.input_transcript.delta", delta: "Hello, where is the nearest train station?" });

      const unhandled = await collectUnhandledRejectionsDuringFakeTimers(async () => {
        await vi.advanceTimersByTimeAsync(runtime.maxSourceMs);
        await flushMicrotasks();
      });

      expect(unhandled).toEqual([]);
      expect(audio.captureTrack.enabled).toBe(false);
      expect(controller.session.state).toBe("suspended");
      expect(controller.inputReady).toBe(false);
      expect(controller.recoveryPrompt).toBe("resume-repeat");
      expect(audio.setOutputAudible).toHaveBeenLastCalledWith(false);
      expect(errorSpy).toHaveBeenCalled();
    } finally {
      errorSpy.mockRestore();
    }
  });

  it("suspends with resume-repeat when MAX_SOURCE_MS Gate B mute rejects", async () => {
    const errorSpy = vi.spyOn(console, "error").mockImplementation(() => {});
    const { controller, live, audio } = createController();
    live.setInputMuted.mockImplementation(async (muted: boolean) => {
      if (muted) {
        throw new Error("network failed");
      }
    });
    await enterListening(controller);
    emitVoice(audio, true);
    live.emit({ type: "session.input_transcript.delta", delta: "Hello, where is the nearest train station?" });

    const unhandled = await collectUnhandledRejectionsDuringFakeTimers(async () => {
      await vi.advanceTimersByTimeAsync(runtime.maxSourceMs);
      await flushMicrotasks();
    });

    expect(unhandled).toEqual([]);
    expect(audio.setCaptureEnabled).toHaveBeenLastCalledWith(false);
    expect(audio.captureTrack.enabled).toBe(false);
    expect(controller.inputReady).toBe(false);
    expect(live.setInputMuted).toHaveBeenCalledWith(true);
    expect(audio.setOutputAudible).toHaveBeenLastCalledWith(false);
    expect(controller.session.state).toBe("suspended");
    expect(controller.session.recentTurns[0]?.status).toBe("failed");
    expect(controller.recoveryPrompt).toBe("resume-repeat");
    expect(live.appendInstructions).toHaveBeenCalledWith(buildUnfinishedTurnWarning(), {
      kind: "later_steering",
      sessionState: "suspended",
    });
    expect(errorSpy).toHaveBeenCalled();
  });

  it("suspends on MAX_SOURCE while Gate B mute remains pending", async () => {
    const { controller, live, audio } = createController();
    let releaseMute: (() => void) | undefined;
    live.setInputMuted.mockImplementation(async (muted: boolean) => {
      if (muted) {
        await new Promise<void>((resolve) => {
          releaseMute = resolve;
        });
      }
    });
    await enterListening(controller);
    emitVoice(audio, true);
    live.emit({ type: "session.input_transcript.delta", delta: "Hello, where is the nearest train station?" });

    await vi.advanceTimersByTimeAsync(runtime.maxSourceMs);
    await waitUntil(() => releaseMute !== undefined);

    expect(controller.session.state).toBe("suspended");
    expect(audio.setCaptureEnabled).toHaveBeenLastCalledWith(false);
    expect(audio.captureTrack.enabled).toBe(false);
    expect(audio.setOutputAudible).toHaveBeenLastCalledWith(false);
    expect(controller.inputReady).toBe(false);

    releaseMute?.();
    await flushMicrotasks();
  });

  it("suspends on MAX_SOURCE when Gate B mute times out", async () => {
    const errorSpy = vi.spyOn(console, "error").mockImplementation(() => {});
    const { controller, live, audio } = createController();
    live.setInputMuted.mockImplementation(async (muted: boolean) => {
      if (muted) {
        throw new AckTimeoutError("evt-timeout");
      }
    });
    await enterListening(controller);
    emitVoice(audio, true);
    live.emit({ type: "session.input_transcript.delta", delta: "Hello, where is the nearest train station?" });

    const unhandled = await collectUnhandledRejectionsDuringFakeTimers(async () => {
      await vi.advanceTimersByTimeAsync(runtime.maxSourceMs);
      await flushMicrotasks();
    });

    expect(unhandled).toEqual([]);
    expect(audio.setCaptureEnabled).toHaveBeenLastCalledWith(false);
    expect(audio.captureTrack.enabled).toBe(false);
    expect(audio.setOutputAudible).toHaveBeenLastCalledWith(false);
    expect(controller.inputReady).toBe(false);
    expect(controller.session.state).toBe("suspended");
    expect(controller.session.recentTurns[0]?.status).toBe("failed");
    expect(controller.recoveryPrompt).toBe("resume-repeat");
    expect(live.appendInstructions).toHaveBeenCalledWith(buildUnfinishedTurnWarning(), {
      kind: "later_steering",
      sessionState: "suspended",
    });
    expect(errorSpy).toHaveBeenCalled();
  });

  it("resume after MAX_SOURCE_MS re-baselines VAM, unmutes, and returns to listening", async () => {
    const { controller, live, audio } = createController();
    await enterListening(controller);
    emitVoice(audio, true);
    await vi.advanceTimersByTimeAsync(runtime.maxSourceMs);
    await flushMicrotasks();

    await controller.resumeFromSourceTimeout();

    expect(audio.resetVoiceActivityBaseline).toHaveBeenCalledOnce();
    expect(live.setInputMuted).toHaveBeenLastCalledWith(false);
    expect(audio.setCaptureEnabled).toHaveBeenLastCalledWith(true);
    expect(audio.captureTrack.enabled).toBe(true);
    expect(audio.setOutputAudible).toHaveBeenLastCalledWith(true);
    expect(controller.session.state).toBe("listening");
    expect(controller.inputReady).toBe(true);
    expect(controller.recoveryPrompt).toBeUndefined();
  });

  it("applies a queued language change before repeating a timed-out source turn", async () => {
    const { controller, live, audio } = createController();
    await controller.startWithLanguages({ A: "en", B: "es" });
    emitVoice(audio, true);
    await controller.changeInterlocutorLanguage("de");
    await vi.advanceTimersByTimeAsync(runtime.maxSourceMs);
    await flushMicrotasks();
    expect(controller.session.state).toBe("suspended");

    await controller.resumeFromSourceTimeout();

    expect(controller.session.participantB.language).toBe("de");
    expect(live.appendInstructions).toHaveBeenLastCalledWith(
      buildSteering({ A: "en", B: "de" }), expect.anything(),
    );
    expect(controller.inputReady).toBe(true);
  });

  it("manual MAX_SOURCE resume waits for Gate B unmute before reopening output", async () => {
    const { controller, live, audio } = createController();
    let releaseUnmute: (() => void) | undefined;
    live.setInputMuted.mockImplementation(async (muted: boolean) => {
      if (!muted) {
        await new Promise<void>((resolve) => {
          releaseUnmute = resolve;
        });
      }
    });
    await enterListening(controller);
    emitVoice(audio, true);
    await vi.advanceTimersByTimeAsync(runtime.maxSourceMs);
    await flushMicrotasks();

    const resuming = controller.resumeFromSourceTimeout();
    await waitUntil(() => releaseUnmute !== undefined);

    expect(live.setInputMuted).toHaveBeenLastCalledWith(false);
    expect(controller.session.state).toBe("suspended");
    expect(controller.inputReady).toBe(false);
    expect(audio.setOutputAudible).toHaveBeenLastCalledWith(false);
    expect(audio.setCaptureEnabled).toHaveBeenLastCalledWith(false);
    expect(audio.captureTrack.enabled).toBe(false);

    releaseUnmute?.();
    await resuming;

    expect(audio.resetVoiceActivityBaseline).toHaveBeenCalledOnce();
    expect(controller.session.state).toBe("listening");
    expect(controller.inputReady).toBe(true);
    expect(audio.setOutputAudible).toHaveBeenLastCalledWith(true);
    let gateBUnmuteOrder: number | undefined;
    for (let i = live.setInputMuted.mock.calls.length - 1; i >= 0; i--) {
      if (live.setInputMuted.mock.calls[i]?.[0] === false) {
        gateBUnmuteOrder = live.setInputMuted.mock.invocationCallOrder[i];
        break;
      }
    }
    let gateAOnOrder: number | undefined;
    for (let i = audio.setCaptureEnabled.mock.calls.length - 1; i >= 0; i--) {
      if (audio.setCaptureEnabled.mock.calls[i]?.[0] === true) {
        gateAOnOrder = audio.setCaptureEnabled.mock.invocationCallOrder[i];
        break;
      }
    }
    const gateCOnOrder = audio.setOutputAudible.mock.invocationCallOrder.at(-1);
    if (gateBUnmuteOrder === undefined || gateAOnOrder === undefined || gateCOnOrder === undefined) {
      throw new Error("Gate B unmute or Gate C reopen was not recorded");
    }
    expect(gateBUnmuteOrder).toBeLessThan(gateAOnOrder);
    expect(gateAOnOrder).toBeLessThan(gateCOnOrder);
  });

  it("manual MAX_SOURCE resume waits for pending Gate B mute before reopening gates", async () => {
    const { controller, live, audio } = createController();
    let releaseMute: (() => void) | undefined;
    let releaseUnmute: (() => void) | undefined;
    let muteAttempts = 0;
    live.setInputMuted.mockImplementation(async (muted: boolean) => {
      if (muted) {
        muteAttempts += 1;
        if (muteAttempts === 1) {
          await new Promise<void>((resolve) => {
            releaseMute = resolve;
          });
        }
        return;
      }
      await new Promise<void>((resolve) => {
        releaseUnmute = resolve;
      });
    });
    await enterListening(controller);
    emitVoice(audio, true);
    live.emit({ type: "session.input_transcript.delta", delta: "Hello, where is the nearest train station?" });

    await vi.advanceTimersByTimeAsync(runtime.maxSourceMs);
    await waitUntil(() => releaseMute !== undefined);

    const resuming = controller.resumeFromSourceTimeout();
    await flushMicrotasks();

    expect(controller.session.state).toBe("suspended");
    expect(controller.inputReady).toBe(false);
    expect(audio.setOutputAudible).toHaveBeenLastCalledWith(false);
    expect(audio.setCaptureEnabled).toHaveBeenLastCalledWith(false);
    expect(audio.captureTrack.enabled).toBe(false);
    expect(live.setInputMuted.mock.calls.some((call) => call[0] === false)).toBe(false);
    expect(audio.setCaptureEnabled).not.toHaveBeenCalledWith(true);

    releaseMute?.();
    await waitUntil(() => releaseUnmute !== undefined);
    releaseUnmute?.();
    await resuming;

    expect(audio.setCaptureEnabled).toHaveBeenCalledWith(true);
    expect(audio.setOutputAudible).toHaveBeenLastCalledWith(true);
    expect(controller.session.state).toBe("listening");
    expect(controller.inputReady).toBe(true);
    let gateBUnmuteOrder: number | undefined;
    for (let i = live.setInputMuted.mock.calls.length - 1; i >= 0; i -= 1) {
      if (live.setInputMuted.mock.calls[i]?.[0] === false) {
        gateBUnmuteOrder = live.setInputMuted.mock.invocationCallOrder[i];
        break;
      }
    }
    let gateAOnOrder: number | undefined;
    for (let i = audio.setCaptureEnabled.mock.calls.length - 1; i >= 0; i -= 1) {
      if (audio.setCaptureEnabled.mock.calls[i]?.[0] === true) {
        gateAOnOrder = audio.setCaptureEnabled.mock.invocationCallOrder[i];
        break;
      }
    }
    const gateCOnOrder = audio.setOutputAudible.mock.invocationCallOrder.at(-1);
    if (gateBUnmuteOrder === undefined || gateAOnOrder === undefined || gateCOnOrder === undefined) {
      throw new Error("Gate resume order was not captured");
    }
    expect(gateBUnmuteOrder).toBeLessThan(gateAOnOrder);
    expect(gateAOnOrder).toBeLessThan(gateCOnOrder);
  });

  it.each([
    ["rejects", () => new Error("mute failed")],
    ["times out", () => new AckTimeoutError("evt-timeout")],
  ])(
    "manual MAX_SOURCE resume waits for pending Gate B mute that %s before reopening gates",
    async (_label, createMuteError) => {
      const errorSpy = vi.spyOn(console, "error").mockImplementation(() => {});
      try {
        const { controller, live, audio } = createController();
        let rejectMute: ((reason: unknown) => void) | undefined;
        let releaseUnmute: (() => void) | undefined;
        live.setInputMuted.mockImplementation(async (muted: boolean) => {
          if (muted) {
            await new Promise<void>((_resolve, reject) => {
              rejectMute = reject;
            });
            return;
          }
          await new Promise<void>((resolve) => {
            releaseUnmute = resolve;
          });
        });
        await enterListening(controller);
        emitVoice(audio, true);
        live.emit({ type: "session.input_transcript.delta", delta: "Hello, where is the nearest train station?" });

        const unhandled = await collectUnhandledRejectionsDuringFakeTimers(async () => {
          await vi.advanceTimersByTimeAsync(runtime.maxSourceMs);
          await waitUntil(() => rejectMute !== undefined);

          const resuming = controller.resumeFromSourceTimeout();
          await flushMicrotasks();

          expect(live.setInputMuted.mock.calls.some((call) => call[0] === false)).toBe(false);
          rejectMute?.(createMuteError());
          await waitUntil(() => releaseUnmute !== undefined);
          expect(audio.setCaptureEnabled).not.toHaveBeenCalledWith(true);
          expect(audio.setOutputAudible).toHaveBeenLastCalledWith(false);

          releaseUnmute?.();
          await resuming;
        });

        expect(unhandled).toEqual([]);
        expect(audio.setCaptureEnabled).toHaveBeenCalledWith(true);
        expect(audio.setOutputAudible).toHaveBeenLastCalledWith(true);
        expect(controller.session.state).toBe("listening");
        expect(controller.inputReady).toBe(true);

        let gateBUnmuteOrder: number | undefined;
        for (let i = live.setInputMuted.mock.calls.length - 1; i >= 0; i -= 1) {
          if (live.setInputMuted.mock.calls[i]?.[0] === false) {
            gateBUnmuteOrder = live.setInputMuted.mock.invocationCallOrder[i];
            break;
          }
        }
        let gateAOnOrder: number | undefined;
        for (let i = audio.setCaptureEnabled.mock.calls.length - 1; i >= 0; i -= 1) {
          if (audio.setCaptureEnabled.mock.calls[i]?.[0] === true) {
            gateAOnOrder = audio.setCaptureEnabled.mock.invocationCallOrder[i];
            break;
          }
        }
        const gateCOnOrder = audio.setOutputAudible.mock.invocationCallOrder.at(-1);
        if (
          gateBUnmuteOrder === undefined ||
          gateAOnOrder === undefined ||
          gateCOnOrder === undefined
        ) {
          throw new Error("Gate B unmute or gate reopen was not recorded");
        }
        expect(gateBUnmuteOrder).toBeLessThan(gateAOnOrder);
        expect(gateAOnOrder).toBeLessThan(gateCOnOrder);
      } finally {
        errorSpy.mockRestore();
      }
    },
  );

  it("manual MAX_SOURCE resume is single-flight while Gate B unmute is pending", async () => {
    const { controller, live, audio } = createController();
    const releaseUnmutes: Array<() => void> = [];
    live.setInputMuted.mockImplementation(async (muted: boolean) => {
      if (!muted) {
        await new Promise<void>((resolve) => {
          releaseUnmutes.push(resolve);
        });
      }
    });
    await enterListening(controller);
    emitVoice(audio, true);
    await vi.advanceTimersByTimeAsync(runtime.maxSourceMs);
    await flushMicrotasks();

    const firstResume = controller.resumeFromSourceTimeout();
    await waitUntil(() => releaseUnmutes.length === 1);
    const secondResume = controller.resumeFromSourceTimeout();
    await flushMicrotasks();
    const unmuteCalls = live.setInputMuted.mock.calls.filter((call) => call[0] === false).length;
    for (const release of releaseUnmutes) {
      release();
    }
    await Promise.all([firstResume, secondResume]);

    expect(unmuteCalls).toBe(1);
    expect(controller.session.state).toBe("listening");
    expect(controller.inputReady).toBe(true);
    expect(audio.setOutputAudible).toHaveBeenLastCalledWith(true);
  });

  it.each([
    ["visibility hides", (controls: { visibility: FakeVisibility }) => controls.visibility.hide()],
    [
      "orientation turns landscape",
      (controls: { orientation: FakeOrientation }) => controls.orientation.emit("landscape"),
    ],
  ])(
    "manual MAX_SOURCE resume remains suspended when %s while Gate B unmute is pending",
    async (_label, triggerUnsafeLifecycle) => {
      const orientation = new FakeOrientation();
      const visibility = new FakeVisibility();
      const { controller, live, audio } = createController({
        orientation,
        visibility,
        wakeLock: new FakeWakeLock(),
      });
      let releaseUnmute: (() => void) | undefined;
      live.setInputMuted.mockImplementation(async (muted: boolean) => {
        if (!muted) {
          await new Promise<void>((resolve) => {
            releaseUnmute = resolve;
          });
        }
      });
      await enterListening(controller);
      emitVoice(audio, true);
      live.emit({ type: "session.input_transcript.delta", delta: "Hello, where is the nearest train station?" });
      await vi.advanceTimersByTimeAsync(runtime.maxSourceMs);
      await flushMicrotasks();

      const resuming = controller.resumeFromSourceTimeout();
      await waitUntil(() => releaseUnmute !== undefined);
      triggerUnsafeLifecycle({ orientation, visibility });
      await flushLifecycle();

      releaseUnmute?.();
      await resuming;

      expect(controller.session.state).toBe("suspended");
      expect(controller.recoveryPrompt).toBe("resume-repeat");
      expect(controller.inputReady).toBe(false);
      expect(audio.setCaptureEnabled).not.toHaveBeenCalledWith(true);
      expect(audio.captureTrack.enabled).toBe(false);
      expect(audio.setOutputAudible).toHaveBeenLastCalledWith(false);
      expect(live.setInputMuted).toHaveBeenLastCalledWith(true);
    },
  );

  it("manual MAX_SOURCE resume ignores new speech/transcript until Gate C reopens", async () => {
    const { controller, live, audio } = createController();
    await enterListening(controller);
    emitVoice(audio, true);
    await vi.advanceTimersByTimeAsync(runtime.maxSourceMs);
    await flushMicrotasks();
    emitVoice(audio, true);
    live.emit({ type: "session.input_transcript.delta", delta: "ignored" });
    live.emit({ type: "session.output_transcript.delta", delta: "ignored output" });

    expect(controller.session.state).toBe("suspended");
    expect(controller.session.activeTurn).toBeUndefined();
    expect(controller.session.recentTurns[0]?.status).toBe("failed");
    expect(controller.session.recentTurns).toHaveLength(1);
    await controller.resumeFromSourceTimeout();
    expect(controller.session.state).toBe("listening");
  });

  it("manual MAX_SOURCE resume rejects a dead microphone track without opening gates", async () => {
    const { controller, live, audio } = createController();
    await enterListening(controller);
    emitVoice(audio, true);
    await vi.advanceTimersByTimeAsync(runtime.maxSourceMs);
    await flushMicrotasks();
    audio.captureTrack.readyState = "ended";

    await expect(controller.resumeFromSourceTimeout()).rejects.toThrow(
      'Microphone track is not live (readyState "ended")',
    );

    expect(controller.session.state).toBe("error");
    expect(controller.ownerError).toBe(CONNECTION_ERROR_MESSAGE);
    expect(controller.inputReady).toBe(false);
    expect(audio.setOutputAudible).toHaveBeenLastCalledWith(false);
    expect(live.setInputMuted).not.toHaveBeenLastCalledWith(false);
  });

  it("manual MAX_SOURCE resume rejects a closed transport without opening gates", async () => {
    const { controller, live, audio } = createController();
    await enterListening(controller);
    emitVoice(audio, true);
    await vi.advanceTimersByTimeAsync(runtime.maxSourceMs);
    await flushMicrotasks();
    live.peerConnectionState = "closed";

    await expect(controller.resumeFromSourceTimeout()).rejects.toThrow(
      'Peer connection state is "closed"',
    );

    expect(controller.session.state).toBe("error");
    expect(controller.ownerError).toBe(CONNECTION_ERROR_MESSAGE);
    expect(controller.inputReady).toBe(false);
    expect(audio.setOutputAudible).toHaveBeenLastCalledWith(false);
    expect(live.setInputMuted).not.toHaveBeenLastCalledWith(false);
  });

  it("manual MAX_SOURCE resume fails safely when Gate B unmute rejects", async () => {
    const errorSpy = vi.spyOn(console, "error").mockImplementation(() => {});
    const { controller, live, audio } = createController();
    live.setInputMuted.mockImplementation(async (muted: boolean) => {
      if (!muted) {
        throw new Error("unmute failed");
      }
    });
    await enterListening(controller);
    emitVoice(audio, true);
    await vi.advanceTimersByTimeAsync(runtime.maxSourceMs);
    await flushMicrotasks();

    const unhandled = await collectUnhandledRejectionsDuringFakeTimers(async () => {
      await expect(controller.resumeFromSourceTimeout()).rejects.toThrow("unmute failed");
    });

    expect(unhandled).toEqual([]);
    expect(errorSpy).toHaveBeenCalled();
    expect(live.setInputMuted).toHaveBeenLastCalledWith(false);
    expect(controller.session.state).toBe("error");
    expect(controller.ownerError).toBe(CONNECTION_ERROR_MESSAGE);
    expect(controller.inputReady).toBe(false);
    expect(audio.setOutputAudible).toHaveBeenLastCalledWith(false);
    expect(audio.setCaptureEnabled).toHaveBeenLastCalledWith(false);
    errorSpy.mockRestore();
  });

  it("manual MAX_SOURCE resume fails safely when Gate A cannot reopen and remutes Gate B", async () => {
    const audio = createFakeAudio();
    const captureTrack = audio.captureTrack;
    const customSetCaptureEnabled = vi.fn((enabled: boolean) => {
      captureTrack.enabled = enabled;
      if (enabled) {
        throw new Error("capture enable failed");
      }
    });
    audio.setCaptureEnabled = customSetCaptureEnabled;
    const { controller, live } = createController({ audio });
    await enterListening(controller);
    emitVoice(audio, true);
    await vi.advanceTimersByTimeAsync(runtime.maxSourceMs);
    await flushMicrotasks();

    await expect(controller.resumeFromSourceTimeout()).rejects.toThrow("capture enable failed");

    expect(controller.session.state).toBe("error");
    expect(controller.ownerError).toBe(CONNECTION_ERROR_MESSAGE);
    expect(controller.inputReady).toBe(false);
    expect(audio.setCaptureEnabled).toHaveBeenCalledWith(false);
    expect(audio.setCaptureEnabled).toHaveBeenCalledWith(true);
    expect(audio.setOutputAudible).toHaveBeenLastCalledWith(false);
    expect(captureTrack.enabled).toBe(false);
    expect(live.setInputMuted).toHaveBeenLastCalledWith(true);
  });

  it("manual MAX_SOURCE resume ignores Gate A restore failure remute after cancel", async () => {
    const { controller, releaseRemute, resuming, setCaptureEnabled } =
      await startGateARestoreFailureRemuteRace();
    const unhandled = await collectUnhandledRejectionsDuringFakeTimers(async () => {
      await controller.cancel();
      releaseRemute();
      await resuming;
    });

    expect(unhandled).toEqual([]);
    expect(controller.session.state).toBe("idle");
    expect(controller.ownerError).toBeUndefined();
    expect(setCaptureEnabled).toHaveBeenCalledWith(true);
    expect(setCaptureEnabled).toHaveBeenCalledWith(false);
  });

  it("manual MAX_SOURCE resume ignores Gate A restore failure when remute resolves before cancel", async () => {
    const { controller, releaseRemute, resuming, setCaptureEnabled } =
      await startGateARestoreFailureRemuteRace();
    const unhandled = await collectUnhandledRejectionsDuringFakeTimers(async () => {
      releaseRemute();
      await controller.cancel();
      await resuming;
    });

    expect(unhandled).toEqual([]);
    expect(controller.session.state).toBe("idle");
    expect(controller.ownerError).toBeUndefined();
    expect(setCaptureEnabled).toHaveBeenCalledWith(true);
    expect(setCaptureEnabled).toHaveBeenCalledWith(false);
  });

  it("ignores a pending manual MAX_SOURCE resume unmute after cancel", async () => {
    const { controller, live, audio } = createController();
    let releaseUnmute: (() => void) | undefined;
    live.setInputMuted.mockImplementation(async (muted: boolean) => {
      if (!muted) {
        await new Promise<void>((resolve) => {
          releaseUnmute = resolve;
        });
      }
    });
    await enterListening(controller);
    emitVoice(audio, true);
    await vi.advanceTimersByTimeAsync(runtime.maxSourceMs);
    await flushMicrotasks();

    const resuming = controller.resumeFromSourceTimeout();
    await waitUntil(() => releaseUnmute !== undefined);
    await controller.cancel();
    releaseUnmute?.();
    await resuming;

    expect(controller.session.state).toBe("idle");
    expect(controller.inputReady).toBe(false);
    expect(audio.setOutputAudible).toHaveBeenLastCalledWith(false);
  });

  it("cancel invalidates pending manual MAX_SOURCE resume before close settles", async () => {
    const live = new FakeLive();
    let releaseUnmute: (() => void) | undefined;
    let releaseClose: (() => void) | undefined;
    live.setInputMuted.mockImplementation(async (muted: boolean) => {
      if (!muted) {
        await new Promise<void>((resolve) => {
          releaseUnmute = resolve;
        });
      }
    });
    const { controller, audio } = createController({ live });
    await enterListening(controller);
    live.close.mockImplementation(async () => {
      await new Promise<void>((resolve) => {
        releaseClose = resolve;
      });
      return { finalized: true };
    });

    emitVoice(audio, true);
    await vi.advanceTimersByTimeAsync(runtime.maxSourceMs);
    await flushMicrotasks();

    const resuming = controller.resumeFromSourceTimeout();
    await waitUntil(() => releaseUnmute !== undefined);
    const cancelling = controller.cancel();
    await waitUntil(() => releaseClose !== undefined);
    try {
      releaseUnmute?.();
      await resuming;

      expect(controller.session.state).toBe("suspended");
      expect(controller.inputReady).toBe(false);
      expect(audio.setCaptureEnabled).toHaveBeenLastCalledWith(false);
      expect(audio.captureTrack.enabled).toBe(false);
      expect(audio.setOutputAudible).toHaveBeenLastCalledWith(false);
    } finally {
      releaseClose?.();
      await cancelling;
    }

    expect(controller.session.state).toBe("idle");
    expect(controller.inputReady).toBe(false);
  });

  it("cancel ignores pending Gate A restore failure remute before close settles", async () => {
    const { controller, live, releaseRemute, resuming, setCaptureEnabled } =
      await startGateARestoreFailureRemuteRace();
    let releaseClose: (() => void) | undefined;
    live.close.mockImplementation(async () => {
      await new Promise<void>((resolve) => {
        releaseClose = resolve;
      });
      return { finalized: true };
    });

    const cancelling = controller.cancel();
    await waitUntil(() => releaseClose !== undefined);
    try {
      releaseRemute();
      await expect(resuming).resolves.toBeUndefined();

      expect(controller.session.state).toBe("suspended");
      expect(controller.ownerError).toBeUndefined();
      expect(setCaptureEnabled).toHaveBeenCalledWith(true);
      expect(setCaptureEnabled).toHaveBeenCalledWith(false);
    } finally {
      releaseClose?.();
      await cancelling;
    }

    expect(controller.session.state).toBe("idle");
    expect(controller.ownerError).toBeUndefined();
  });

  it("ignores residual output transcript after the active turn is cleared", async () => {
    const { controller, live, audio } = createController();
    await enterListening(controller);
    await completeTextOnlyTurn(controller, live, audio);

    expect(() => {
      live.emit({ type: "session.output_transcript.delta", delta: "late caption" });
    }).not.toThrow();
    expect(controller.session.activeTurn).toBeUndefined();
    expect(controller.session.recentTurns).toHaveLength(1);
    expect(controller.session.recentTurns[0]?.translatedText).toBe("Hola, ¿dónde está la estación?");
  });

  it("ignores residual playback-start after the active turn is cleared", async () => {
    const { controller, live, audio } = createController();
    await enterListening(controller);
    await completeTextOnlyTurn(controller, live, audio);

    emitPlayback(audio, true);
    await flushMicrotasks();
    expect(controller.session.activeTurn).toBeUndefined();
    expect(controller.session.state).toBe("listening");
  });

  it("ignores an empty output delta when there is no active turn", async () => {
    const { controller, live } = createController();
    await enterListening(controller);

    expect(() => {
      live.emit({ type: "session.output_transcript.delta", delta: "" });
    }).not.toThrow();
    expect(controller.session.activeTurn).toBeUndefined();
  });

  it("does not start a new source turn during an in-flight MAX_SOURCE_MS warning append", async () => {
    const { controller, live, audio } = createController();
    let releaseWarning: (() => void) | undefined;
    live.appendInstructions.mockImplementation(async (text: string, policy?: { kind: string }) => {
      live.callOrder.push(`instructions:${text}`);
      if (policy?.kind === "later_steering" && text === buildUnfinishedTurnWarning()) {
        await new Promise<void>((resolve) => {
          releaseWarning = resolve;
        });
      }
      return { eventId: "evt-warn" };
    });
    await enterListening(controller);
    emitVoice(audio, true);
    live.emit({ type: "session.input_transcript.delta", delta: "Hello, where is the nearest train station?" });

    await vi.advanceTimersByTimeAsync(runtime.maxSourceMs);
    await flushMicrotasks();
    await vi.waitFor(() => {
      if (releaseWarning === undefined) {
        throw new Error("MAX_SOURCE_MS warning append was not started");
      }
    });
    const finishWarning = releaseWarning;
    if (finishWarning === undefined) {
      throw new Error("MAX_SOURCE_MS warning append was not started");
    }

    emitVoice(audio, true);
    live.emit({ type: "session.input_transcript.delta", delta: " still talking" });
    expect(controller.session.activeTurn).toBeUndefined();
    finishWarning();
    await flushMicrotasks();

    expect(controller.session.state).toBe("suspended");
    expect(controller.recoveryPrompt).toBe("resume-repeat");
    expect(controller.session.recentTurns[0]?.status).toBe("failed");
    expect(controller.session.activeTurn).toBeUndefined();
  });

  it("still suspends with resume-repeat when the unfinished-turn warning append rejects", async () => {
    const { controller, live, audio } = createController();
    live.appendInstructions.mockImplementation(async (text: string, policy?: { kind: string }) => {
      live.callOrder.push(`instructions:${text}`);
      if (policy?.kind === "later_steering" && text === buildUnfinishedTurnWarning()) {
        throw new Error("warning ack timeout");
      }
      return { eventId: "evt-ok" };
    });
    await enterListening(controller);
    emitVoice(audio, true);

    await vi.advanceTimersByTimeAsync(runtime.maxSourceMs);
    await flushMicrotasks();

    expect(controller.session.state).toBe("suspended");
    expect(controller.recoveryPrompt).toBe("resume-repeat");
    expect(controller.session.recentTurns[0]?.status).toBe("failed");
    await controller.resumeFromSourceTimeout();
    expect(controller.session.state).toBe("listening");
  });

  it("advertises resume-repeat only after suspend and allows resume during warning append", async () => {
    const { controller, live, audio } = createController();
    let releaseWarning: (() => void) | undefined;
    live.appendInstructions.mockImplementation(async (text: string, policy?: { kind: string }) => {
      live.callOrder.push(`instructions:${text}`);
      if (policy?.kind === "later_steering" && text === buildUnfinishedTurnWarning()) {
        await new Promise<void>((resolve) => {
          releaseWarning = resolve;
        });
      }
      return { eventId: "evt-warn" };
    });
    await enterListening(controller);
    emitVoice(audio, true);

    await vi.advanceTimersByTimeAsync(runtime.maxSourceMs);
    await flushMicrotasks();
    await vi.waitFor(() => {
      expect(controller.recoveryPrompt).toBe("resume-repeat");
    });

    expect(controller.session.state).toBe("suspended");
    await controller.resumeFromSourceTimeout();
    expect(controller.session.state).toBe("listening");
    expect(controller.recoveryPrompt).toBeUndefined();

    if (releaseWarning === undefined) {
      throw new Error("MAX_SOURCE_MS warning append was not started");
    }
    releaseWarning();
    await flushMicrotasks();
    expect(controller.session.state).toBe("listening");
  });

  it("keeps leftover drain across MAX_SOURCE_MS resume while playback stays active", async () => {
    const { controller, live, audio } = createController();
    await enterListening(controller);
    emitVoice(audio, true);
    live.emit({ type: "session.input_transcript.delta", delta: "Hello, where is the nearest train station?" });
    emitPlayback(audio, true);
    await flushMicrotasks();

    await vi.advanceTimersByTimeAsync(runtime.maxSourceMs);
    await flushMicrotasks();

    expect(controller.session.state).toBe("suspended");
    expect(controller.recoveryPrompt).toBe("resume-repeat");
    expect(audio.setOutputAudible).toHaveBeenLastCalledWith(false);
    await vi.advanceTimersByTimeAsync(runtime.captionIdleMs);
    await flushMicrotasks();

    await controller.resumeFromSourceTimeout();
    expect(controller.session.state).toBe("listening");
    expect(audio.setOutputAudible).toHaveBeenLastCalledWith(true);

    emitVoice(audio, true);
    live.emit({ type: "session.input_transcript.delta", delta: "Where is the nearest train station?" });
    await vi.advanceTimersByTimeAsync(runtime.captionIdleMs);
    live.emit({ type: "session.output_transcript.delta", delta: "stale leftover" });
    emitPlayback(audio, true);
    await flushMicrotasks();

    expect(controller.session.activeTurn?.originalText).toBe("Where is the nearest train station?");
    expect(controller.session.activeTurn?.translatedText).toBeUndefined();
    expect(controller.session.activeTurn?.audioOutputStarted).toBe(false);
    expect(controller.session.activeTurn?.status).toBe("streaming");
    emitPlayback(audio, false);
    await flushMicrotasks();
    await vi.advanceTimersByTimeAsync(runtime.captionIdleMs);
    await flushMicrotasks();
    live.emit({ type: "session.output_transcript.delta", delta: "Siguiente pregunta, por favor." });
    await vi.advanceTimersByTimeAsync(runtime.captionIdleMs);

    expect(controller.session.activeTurn?.translatedText).toBe("Siguiente pregunta, por favor.");
  });

  it("preserves MAX_SOURCE resume-repeat suspension across lifecycle hide/show drain", async () => {
    const visibility = new FakeVisibility();
    const { controller, live, audio } = createController({
      orientation: new FakeOrientation(),
      visibility,
      wakeLock: new FakeWakeLock(),
    });
    await enterListening(controller);
    emitVoice(audio, true);
    live.emit({ type: "session.input_transcript.delta", delta: "Hello, where is the nearest train station?" });
    await vi.advanceTimersByTimeAsync(runtime.maxSourceMs);
    await flushMicrotasks();

    expect(controller.session.state).toBe("suspended");
    expect(controller.recoveryPrompt).toBe("resume-repeat");

    visibility.hide();
    await flushLifecycle();
    visibility.show();
    await flushLifecycle();
    await vi.advanceTimersByTimeAsync(runtime.captionIdleMs);
    await flushLifecycle();

    expect(controller.session.state).toBe("suspended");
    expect(controller.recoveryPrompt).toBe("resume-repeat");
    expect(controller.inputReady).toBe(false);
    expect(audio.setOutputAudible).toHaveBeenLastCalledWith(false);
    expect(live.setInputMuted.mock.calls.some((call) => call[0] === false)).toBe(false);
  });
});

describe("SessionController endConversation", () => {
  beforeEach(() => {
    setDeviceLanguage("ru-RU");
    vi.useFakeTimers();
    vi.setSystemTime(new Date("2026-01-01T00:00:00.000Z"));
  });

  it("closes Live and releases audio while retaining both sides until returning to setup", async () => {
    const { controller, live, audio } = createController();
    await enterListening(controller);
    live.close.mockClear();
    controller.setContextText("We are ordering lunch.");
    live.emit({ type: "session.input_transcript.delta", delta: "Could you tell me where the train station is?" });
    live.emit({ type: "session.output_transcript.delta", delta: "¿Dónde está la estación de tren?" });
    const captions = controller.captionBlocks;
    const participants = [controller.session.participantA, controller.session.participantB];
    live.close.mockImplementation(async () => {
      expect(controller.session.state).toBe("ending");
      live.callOrder.push("close");
      return { finalized: true };
    });

    await controller.endConversation();

    expect(live.close).toHaveBeenCalledOnce();
    expect(audio.setOutputAudible).toHaveBeenLastCalledWith(false);
    expect(audio.stopCapture).toHaveBeenCalled();
    expect(audio.getCaptureStream()).toBeNull();
    expect(controller.session.state).toBe("ended");
    expect(controller.captionBlocks).toBe(captions);
    expect(captions.map(block => block.side)).toEqual(["A", "B"]);
    expect([controller.session.participantA, controller.session.participantB]).toEqual(participants);
    expect(controller.session.recentTurns).toEqual([]);
    expect(controller.session.activeTurn).toBeUndefined();
    expect(controller.contextText).toBe("");
    expect(controller.session.contextText).toBe("");
    await controller.cancel();
    expect(controller.session.state).toBe("idle");
    expect(controller.captionBlocks).toEqual([]);
    expect(live.close).toHaveBeenCalledOnce();
  });

  it("stops local capture before close and shows incomplete finalization after timeout", async () => {
    const { controller, live, audio } = createController();
    await enterListening(controller);
    const order: string[] = [];
    live.close.mockImplementation(async () => {
      order.push("close");
      return { finalized: false, reason: "Timed out waiting for session.closed" };
    });
    audio.stopCapture.mockImplementation(() => {
      order.push("release");
      audio.getCaptureStream.mockReturnValue(null);
    });
    controller.subscribe(() => {
      if (
        controller.ownerError === INCOMPLETE_FINALIZATION_MESSAGE &&
        !order.includes("shown")
      ) {
        order.push("shown");
      }
    });

    await controller.endConversation();

    expect(order).toEqual(["release", "close", "shown"]);
    expect(controller.ownerError).toBe(INCOMPLETE_FINALIZATION_MESSAGE);
    expect(controller.session.state).toBe("ended");
  });

  it("ignores session.closed while a local graceful end is already in progress", async () => {
    const { controller, live } = createController();
    await enterListening(controller);
    let releaseClose: (() => void) | undefined;
    live.close.mockImplementation(async () => {
      live.callOrder.push("close");
      await new Promise<void>((resolve) => {
        releaseClose = resolve;
      });
      return { finalized: true };
    });

    const ending = controller.endConversation();
    await flushMicrotasks();
    expect(controller.session.state).toBe("ending");

    live.emitSessionClosed("client_requested");

    expect(controller.session.state).toBe("ending");
    expect(controller.ownerError).toBeUndefined();
    if (releaseClose === undefined) {
      throw new Error("Live close was not started");
    }
    releaseClose();
    await ending;

    expect(controller.session.state).toBe("ended");
    expect(controller.ownerError).toBeUndefined();
  });

});

describe("SessionController max session duration", () => {
  beforeEach(() => {
    setDeviceLanguage("ru-RU");
    vi.useFakeTimers();
    vi.setSystemTime(new Date("2026-01-01T00:00:00.000Z"));
  });

  it("starts the 15-minute cap at session.started and ends through the graceful close path", async () => {
    const { controller, live, audio } = createController();
    await enterListening(controller);
    live.close.mockClear();
    live.onSessionStarted?.({ type: "session.started", session: { id: "sess_1" } });

    await vi.advanceTimersByTimeAsync(runtime.maxSessionMs - 1);
    expect(live.close).not.toHaveBeenCalled();
    expect(controller.session.state).toBe("listening");

    await vi.advanceTimersByTimeAsync(1);
    await flushMicrotasks();

    expect(live.close).toHaveBeenCalledOnce();
    expect(audio.stopCapture).toHaveBeenCalled();
    expect(controller.session.state).toBe("ended");
  });

  it("ignores stale session.started callbacks after reset swaps the Live client", async () => {
    const audio = createFakeAudio();
    const firstLive = new FakeLive();
    const bootstrapReplacementLive = new FakeLive();
    const afterResetLive = new FakeLive();
    const createLive = vi
      .fn<() => LiveClient>()
      .mockReturnValueOnce(firstLive as unknown as LiveClient)
      .mockReturnValueOnce(bootstrapReplacementLive as unknown as LiveClient)
      .mockReturnValue(afterResetLive as unknown as LiveClient);
    const controller = new SessionController({
      createLive,
      audio: audio as unknown as AudioController,
    });
    const staleSessionStarted = firstLive.onSessionStarted;
    expect(staleSessionStarted).toBeTypeOf("function");

    await enterListening(controller);
    await controller.cancel();
    expect(controller.session.state).toBe("idle");
    expect(bootstrapReplacementLive.close).toHaveBeenCalledOnce();
    expect(afterResetLive.close).not.toHaveBeenCalled();
    expect(vi.getTimerCount()).toBe(0);

    staleSessionStarted?.({ type: "session.started", session: { id: "late" } });

    expect(vi.getTimerCount()).toBe(0);
    await vi.advanceTimersByTimeAsync(runtime.maxSessionMs);
    expect(afterResetLive.close).not.toHaveBeenCalled();
    expect(controller.session.state).toBe("idle");
  });
});

describe("SessionController runtime connection errors", () => {
  beforeEach(() => {
    setDeviceLanguage("ru-RU");
    vi.useFakeTimers();
    vi.setSystemTime(new Date("2026-01-01T00:00:00.000Z"));
  });

  it("maps data channel failure to connection error and leaves listening", async () => {
    const { controller, live } = createController();
    await enterListening(controller);

    live.onError?.({
      type: "error",
      error: { message: "Live data channel closed unexpectedly" },
      transportFailure: true,
    });

    expect(controller.session.state).toBe("error");
    expect(controller.ownerError).toBe(CONNECTION_ERROR_MESSAGE);
    expect(controller.hasEnteredInterpreter).toBe(true);
  });

  it("maps peer failure to connection error", async () => {
    const { controller, live } = createController();
    await enterListening(controller);

    live.onError?.({
      type: "error",
      error: { message: 'Peer connection state changed to "failed"' },
      transportFailure: true,
    });

    expect(controller.session.state).toBe("error");
    expect(controller.ownerError).toBe(CONNECTION_ERROR_MESSAGE);
  });

  it("maps remote session.closed while listening to a terminal connection error", async () => {
    const { controller, live, audio, orientation, wakeLock } = createController();
    await enterListening(controller);
    audio.setOutputAudible.mockClear();
    audio.stopCapture.mockClear();

    live.emitSessionClosed("server_shutdown");

    expect(controller.session.state).toBe("error");
    expect(controller.ownerError).toBe(CONNECTION_ERROR_MESSAGE);
    expect(audio.setOutputAudible).toHaveBeenLastCalledWith(false);
    expect(audio.stopCapture).toHaveBeenCalledOnce();
    expect(audio.getCaptureStream()).toBeNull();
    expect(orientation.stop).toHaveBeenCalled();
    expect(wakeLock.release).toHaveBeenCalled();

    live.emit({ type: "session.input_transcript.delta", delta: "ignored" });
    expect(controller.session.activeTurn).toBeUndefined();
  });

  it("maps remote session.closed while outputting to a terminal connection error", async () => {
    const { controller, live, audio } = createController();
    await enterOutputtingTurn(controller, live, audio);
    audio.setOutputAudible.mockClear();
    audio.stopCapture.mockClear();

    live.emitSessionClosed("server_shutdown");
    await vi.advanceTimersByTimeAsync(runtime.captionIdleMs + runtime.noOutputTimeoutMs);
    await flushMicrotasks();

    expect(controller.session.state).toBe("error");
    expect(controller.ownerError).toBe(CONNECTION_ERROR_MESSAGE);
    expect(audio.setOutputAudible).toHaveBeenLastCalledWith(false);
    expect(audio.stopCapture).toHaveBeenCalledOnce();
  });

  it("maps remote session.closed during startup to a startup error", async () => {
    const { controller, live, audio } = createController();
    await controller.startBootstrap();
    expect(controller.session.state).toBe("bootstrap");
    audio.setOutputAudible.mockClear();
    audio.stopCapture.mockClear();

    live.emitSessionClosed("server_shutdown");

    expect(controller.session.state).toBe("error");
    expect(controller.ownerError).toBe(STARTUP_ERROR_MESSAGE);
    expect(audio.setOutputAudible).toHaveBeenLastCalledWith(false);
    expect(audio.stopCapture).toHaveBeenCalledOnce();
    await expect(controller.beginInterpreter()).rejects.toThrow(
      'Cannot begin interpreter from "error"',
    );
  });

  it("ignores stale session.closed callbacks after reset swaps the Live client", async () => {
    const audio = createFakeAudio();
    const firstLive = new FakeLive();
    const replacementLive = new FakeLive();
    const createLive = vi
      .fn<() => LiveClient>()
      .mockReturnValueOnce(firstLive as unknown as LiveClient)
      .mockReturnValue(replacementLive as unknown as LiveClient);
    const controller = new SessionController({
      createLive,
      audio: audio as unknown as AudioController,
    });
    await enterListening(controller);
    const staleSessionClosed = firstLive.onSessionClosed;
    expect(staleSessionClosed).toBeTypeOf("function");

    await controller.cancel();
    expect(controller.session.state).toBe("idle");
    staleSessionClosed?.({ type: "session.closed", reason: "late_server_close" });

    expect(controller.session.state).toBe("idle");
    expect(controller.ownerError).toBeUndefined();
  });

  it("keeps listening after a recoverable post-start server error", async () => {
    const { controller, live, audio } = createController();
    await enterListening(controller);
    audio.setOutputAudible.mockClear();

    live.onError?.({
      type: "error",
      error: { message: "model interrupted this turn", code: "moderation" },
    });

    expect(controller.session.state).toBe("listening");
    expect(controller.ownerError).toBeUndefined();
    expect(audio.setOutputAudible).not.toHaveBeenCalledWith(false);
  });
});

describe("SessionController conversation metrics", () => {
  beforeEach(() => {
    setDeviceLanguage("ru-RU");
    vi.useFakeTimers();
    vi.setSystemTime(new Date("2026-01-01T00:00:00.000Z"));
  });

  it("records early-output T1 clamp and text-only completion on turn close", async () => {
    const { controller, live, audio } = createController();
    await enterListening(controller);
    emitVoice(audio, true);
    live.emit({ type: "session.input_transcript.delta", delta: "Hello, where is the nearest train station?" });
    live.emit({ type: "session.output_transcript.delta", delta: "Hola, ¿dónde está la estación?" });
    await vi.advanceTimersByTimeAsync(300);
    emitVoice(audio, false);
    await flushMicrotasks();
    await vi.advanceTimersByTimeAsync(runtime.audioStartGraceMs);
    await flushMicrotasks();

    const snapshot = controller.metrics.snapshot();
    expect(snapshot.earlyOutputCount).toBe(1);
    expect(snapshot.textOnlyCompletionCount).toBe(1);
    expect(snapshot.poorOutputRoute).toBe(true);
    expect(snapshot.lastTurn?.t1Ms).toBe(0);
    expect(snapshot.lastTurn?.earlyOutputLeadMs).toBe(300);
    expect(snapshot.lastTurn?.t3Ms).toBeDefined();
    expect(JSON.stringify(snapshot)).not.toMatch(/Hello|Hola/);
  });

  it("records no-output watchdog count", async () => {
    const { controller, live, audio } = createController();
    await enterListening(controller);
    emitVoice(audio, true);
    live.emit({ type: "session.input_transcript.delta", delta: "Hello, where is the nearest train station?" });
    emitVoice(audio, false);
    await flushMicrotasks();
    await vi.advanceTimersByTimeAsync(runtime.noOutputTimeoutMs);
    await flushMicrotasks();

    expect(controller.metrics.snapshot().noOutputWatchdogCount).toBe(1);
  });

  it("records VAM false-active when source energy fires during playback", async () => {
    const { controller, audio } = createController();
    await enterListening(controller);
    emitPlayback(audio, true);
    emitVoice(audio, true);

    expect(controller.metrics.snapshot().vamFalseActiveCount).toBe(1);
  });

  it("records source-tail clipping reports from the test harness", () => {
    const { controller } = createController();
    controller.reportSourceTailClipping();
    expect(controller.metrics.snapshot().sourceTailClippingReports).toBe(1);
  });
});

describe("SessionController PWA lifecycle suspension (§11.3 / §19)", () => {
  beforeEach(() => {
    setDeviceLanguage("ru-RU");
    vi.useFakeTimers();
    vi.setSystemTime(new Date("2026-01-01T00:00:00.000Z"));
  });

  async function startSourceTurn(
    controller: SessionController,
    live: FakeLive,
    audio: ReturnType<typeof createFakeAudio> | AudioController,
  ): Promise<void> {
    await enterListening(controller);
    emitVoice(audio, true);
    live.emit({ type: "session.input_transcript.delta", delta: "Hello, where is the nearest train station?" });
    expect(controller.session.activeTurn?.status).toBe("streaming");
  }

  function rejectPostResumeSteering(live: FakeLive): void {
    live.appendInstructions.mockImplementation(async (text: string, policy?: { kind: string }) => {
      live.callOrder.push(`instructions:${text}`);
      if (policy?.kind === "later_steering") {
        throw new Error("resume steering rejected");
      }
      return { eventId: "evt-instructions" };
    });
  }

  function expectFailedLifecycleResume(
    controller: SessionController,
    live: FakeLive,
    audio: ReturnType<typeof createFakeAudio> | AudioController,
  ): void {
    expect(controller.session.state).toBe("error");
    expect(controller.ownerError).toBe(CONNECTION_ERROR_MESSAGE);
    expect(controller.inputReady).toBe(false);
    expect(audio.setCaptureEnabled).toHaveBeenLastCalledWith(false);
    expect(audio.setOutputAudible).toHaveBeenLastCalledWith(false);
    expect(live.setInputMuted).not.toHaveBeenLastCalledWith(false);
  }

  it("landscape while a source turn is active discards, closes Gate C, mutes Gate B, and suspends", async () => {
    const orientation = new FakeOrientation();
    const visibility = new FakeVisibility();
    const wakeLock = new FakeWakeLock();
    const { controller, live, audio } = createController({
      orientation,
      visibility,
      wakeLock,
    });
    await startSourceTurn(controller, live, audio);

    orientation.emit("landscape");
    await flushMicrotasks();

    expect(controller.session.state).toBe("suspended");
    expect(controller.session.activeTurn).toBeUndefined();
    expect(controller.session.recentTurns[0]?.status).toBe("discarded");
    expect(audio.setCaptureEnabled).toHaveBeenLastCalledWith(false);
    expect(audio.captureTrack.enabled).toBe(false);
    expect(audio.setOutputAudible).toHaveBeenLastCalledWith(false);
    expect(live.setInputMuted).toHaveBeenCalledWith(true);
    expect(controller.recoveryPrompt).toBeUndefined();
  });

  it("background while a source turn is active discards, closes Gate C, mutes Gate B, and suspends", async () => {
    const orientation = new FakeOrientation();
    const visibility = new FakeVisibility();
    const { controller, live, audio } = createController({
      orientation,
      visibility,
      wakeLock: new FakeWakeLock(),
    });
    await startSourceTurn(controller, live, audio);

    visibility.hide();
    await flushMicrotasks();

    expect(controller.session.state).toBe("suspended");
    expect(controller.session.recentTurns[0]?.status).toBe("discarded");
    expect(audio.setCaptureEnabled).toHaveBeenLastCalledWith(false);
    expect(audio.captureTrack.enabled).toBe(false);
    expect(audio.setOutputAudible).toHaveBeenLastCalledWith(false);
    expect(live.setInputMuted).toHaveBeenCalledWith(true);
    emitVoice(audio, true);
    live.emit({ type: "session.input_transcript.delta", delta: "ignored" });
    expect(controller.session.state).toBe("suspended");
    expect(controller.session.activeTurn).toBeUndefined();
  });

  it("audio interruption while a source turn is active suspends and discards the unfinished turn", async () => {
    const { controller, live, audio } = createController({
      orientation: new FakeOrientation(),
      visibility: new FakeVisibility(),
      wakeLock: new FakeWakeLock(),
    });
    await startSourceTurn(controller, live, audio);
    if (audio.onAudioInterruption === null) {
      throw new Error("Audio interruption handler was not installed");
    }

    audio.onAudioInterruption();
    await flushMicrotasks();

    expect(controller.session.state).toBe("suspended");
    expect(controller.session.recentTurns[0]?.status).toBe("discarded");
    expect(audio.setCaptureEnabled).toHaveBeenLastCalledWith(false);
    expect(audio.captureTrack.enabled).toBe(false);
    expect(audio.setOutputAudible).toHaveBeenLastCalledWith(false);
    expect(live.setInputMuted).toHaveBeenCalledWith(true);
  });

  it("enters suspended immediately while Gate B mute is still pending", async () => {
    const visibility = new FakeVisibility();
    const live = new FakeLive();
    let releaseMute: (() => void) | undefined;
    live.setInputMuted.mockImplementation(async (muted: boolean) => {
      live.callOrder.push(`setInputMuted:${muted}`);
      if (muted) {
        await new Promise<void>((resolve) => {
          releaseMute = resolve;
        });
      }
    });
    const { controller, audio } = createController({
      live,
      orientation: new FakeOrientation(),
      visibility,
      wakeLock: new FakeWakeLock(),
    });
    await startSourceTurn(controller, live, audio);

    visibility.hide();
    await waitUntil(() => releaseMute !== undefined);

    expect(controller.session.state).toBe("suspended");
    expect(audio.setCaptureEnabled).toHaveBeenLastCalledWith(false);
    expect(audio.captureTrack.enabled).toBe(false);
    expect(audio.setOutputAudible).toHaveBeenLastCalledWith(false);

    releaseMute?.();
    await flushLifecycle();
  });

  it("stays suspended when Gate B mute times out during suspend", async () => {
    const visibility = new FakeVisibility();
    const live = new FakeLive();
    live.setInputMuted.mockImplementation(async (muted: boolean) => {
      live.callOrder.push(`setInputMuted:${muted}`);
      if (muted) {
        throw new AckTimeoutError("evt-mute");
      }
    });
    const { controller, audio } = createController({
      live,
      orientation: new FakeOrientation(),
      visibility,
      wakeLock: new FakeWakeLock(),
    });
    await startSourceTurn(controller, live, audio);

    visibility.hide();
    await flushLifecycle();

    expect(controller.session.state).toBe("suspended");
    expect(audio.setCaptureEnabled).toHaveBeenLastCalledWith(false);
    expect(audio.captureTrack.enabled).toBe(false);
    expect(audio.setOutputAudible).toHaveBeenLastCalledWith(false);
    expect(live.setInputMuted).not.toHaveBeenLastCalledWith(false);
  });

  it("stays suspended when Gate B mute rejects during suspend", async () => {
    const visibility = new FakeVisibility();
    const live = new FakeLive();
    live.setInputMuted.mockImplementation(async (muted: boolean) => {
      live.callOrder.push(`setInputMuted:${muted}`);
      if (muted) {
        throw new Error("network failed");
      }
    });
    const { controller, audio } = createController({
      live,
      orientation: new FakeOrientation(),
      visibility,
      wakeLock: new FakeWakeLock(),
    });
    await startSourceTurn(controller, live, audio);

    visibility.hide();
    await flushLifecycle();

    expect(controller.session.state).toBe("suspended");
    expect(audio.setCaptureEnabled).toHaveBeenLastCalledWith(false);
    expect(audio.captureTrack.enabled).toBe(false);
    expect(audio.setOutputAudible).toHaveBeenLastCalledWith(false);
    expect(live.setInputMuted).not.toHaveBeenLastCalledWith(false);
  });

  it("waits for Gate B unmute before resuming after an uncertain suspend mute failure", async () => {
    const visibility = new FakeVisibility();
    const live = new FakeLive();
    let releaseUnmute: (() => void) | undefined;
    live.setInputMuted.mockImplementation(async (muted: boolean) => {
      live.callOrder.push(`setInputMuted:${muted}`);
      if (muted) {
        throw new Error("network failed");
      }
      await new Promise<void>((resolve) => {
        releaseUnmute = resolve;
      });
    });
    const { controller, audio } = createController({
      live,
      orientation: new FakeOrientation(),
      visibility,
      wakeLock: new FakeWakeLock(),
    });
    await startSourceTurn(controller, live, audio);

    visibility.hide();
    await flushLifecycle();
    visibility.show();
    await waitUntil(() => releaseUnmute !== undefined);

    expect(live.setInputMuted).toHaveBeenLastCalledWith(false);
    expect(controller.session.state).toBe("suspended");
    expect(controller.inputReady).toBe(false);
    expect(audio.setCaptureEnabled).toHaveBeenLastCalledWith(false);
    expect(audio.captureTrack.enabled).toBe(false);
    expect(audio.setOutputAudible).toHaveBeenLastCalledWith(false);

    releaseUnmute?.();
    await flushLifecycle();

    expect(controller.session.state).toBe("listening");
    expect(controller.inputReady).toBe(true);
    expect(audio.setCaptureEnabled).toHaveBeenLastCalledWith(true);
    expect(audio.captureTrack.enabled).toBe(true);
    expect(audio.setOutputAudible).toHaveBeenLastCalledWith(true);
  });

  it("fails resume without restoring capture when Gate B unmute rejects after an uncertain mute", async () => {
    const visibility = new FakeVisibility();
    const live = new FakeLive();
    live.setInputMuted.mockImplementation(async (muted: boolean) => {
      live.callOrder.push(`setInputMuted:${muted}`);
      if (muted) {
        throw new Error("network failed");
      }
      throw new Error("unmute failed");
    });
    const { controller, audio } = createController({
      live,
      orientation: new FakeOrientation(),
      visibility,
      wakeLock: new FakeWakeLock(),
    });
    await startSourceTurn(controller, live, audio);

    visibility.hide();
    await flushLifecycle();
    const unhandled = await collectUnhandledRejectionsDuringFakeTimers(async () => {
      visibility.show();
      await flushLifecycle();
    });

    expect(unhandled).toEqual([]);
    expect(live.setInputMuted).toHaveBeenLastCalledWith(false);
    expect(controller.session.state).toBe("error");
    expect(controller.ownerError).toBe(CONNECTION_ERROR_MESSAGE);
    expect(controller.inputReady).toBe(false);
    expect(audio.setCaptureEnabled).toHaveBeenLastCalledWith(false);
    expect(audio.captureTrack.enabled).toBe(false);
    expect(audio.setOutputAudible).toHaveBeenLastCalledWith(false);
  });

  it("successful lifecycle resume appends expected-speaker steering, returns to listening, and asks the same source to repeat", async () => {
    const orientation = new FakeOrientation();
    const visibility = new FakeVisibility();
    const wakeLock = new FakeWakeLock();
    const { controller, live, audio } = createController({
      orientation,
      visibility,
      wakeLock,
    });
    await startSourceTurn(controller, live, audio);
    const steeringAfterStart = live.appendInstructions.mock.calls.length;

    visibility.hide();
    await flushMicrotasks();
    visibility.show();
    await flushLifecycle();

    expect(wakeLock.reacquire).toHaveBeenCalled();
    expect(controller.session.state).toBe("listening");
    expect(controller.recoveryPrompt).toBe("repeat");
    expect(live.appendInstructions.mock.calls.length).toBe(steeringAfterStart + 1);
    expect(live.appendInstructions).toHaveBeenLastCalledWith(
      buildSteering({ A: "en", B: "es" }),
      { kind: "later_steering", sessionState: "suspended" },
    );
    expect(audio.setCaptureEnabled).toHaveBeenLastCalledWith(true);
    expect(audio.captureTrack.enabled).toBe(true);
    expect(audio.setOutputAudible).toHaveBeenLastCalledWith(true);
    expect(live.setInputMuted).toHaveBeenLastCalledWith(false);
    const unmuteOrder = live.setInputMuted.mock.invocationCallOrder.at(-1);
    const gateAOrder = audio.setCaptureEnabled.mock.invocationCallOrder.at(-1);
    if (unmuteOrder === undefined || gateAOrder === undefined) {
      throw new Error("Gate B or Gate A restore was not recorded");
    }
    expect(unmuteOrder).toBeLessThan(gateAOrder);
  });

  it("handles rejected visibility resume steering without leaking an unhandled rejection", async () => {
    const errorSpy = vi.spyOn(console, "error").mockImplementation(() => {});
    try {
      const visibility = new FakeVisibility();
      const { controller, live, audio } = createController({
        orientation: new FakeOrientation(),
        visibility,
        wakeLock: new FakeWakeLock(),
      });
      rejectPostResumeSteering(live);
      await startSourceTurn(controller, live, audio);
      visibility.hide();
      await flushLifecycle();

      const unhandled = await collectUnhandledRejectionsDuringFakeTimers(async () => {
        visibility.show();
        await flushLifecycle();
      });

      expect(unhandled).toEqual([]);
      expectFailedLifecycleResume(controller, live, audio);
    } finally {
      errorSpy.mockRestore();
    }
  });

  it("portrait restore after landscape resume asks the same source to repeat", async () => {
    const orientation = new FakeOrientation();
    const visibility = new FakeVisibility();
    const { controller, live, audio } = createController({
      orientation,
      visibility,
      wakeLock: new FakeWakeLock(),
    });
    await startSourceTurn(controller, live, audio);

    orientation.emit("landscape");
    await flushMicrotasks();
    orientation.emit("portrait");
    await flushLifecycle();

    expect(controller.session.state).toBe("listening");
    expect(controller.recoveryPrompt).toBe("repeat");
    expect(live.appendInstructions).toHaveBeenLastCalledWith(
      buildSteering({ A: "en", B: "es" }),
      { kind: "later_steering", sessionState: "suspended" },
    );
  });

  it("handles rejected orientation resume steering without leaking an unhandled rejection", async () => {
    const errorSpy = vi.spyOn(console, "error").mockImplementation(() => {});
    try {
      const orientation = new FakeOrientation();
      const { controller, live, audio } = createController({
        orientation,
        visibility: new FakeVisibility(),
        wakeLock: new FakeWakeLock(),
      });
      rejectPostResumeSteering(live);
      await startSourceTurn(controller, live, audio);
      orientation.emit("landscape");
      await flushLifecycle();

      const unhandled = await collectUnhandledRejectionsDuringFakeTimers(async () => {
        orientation.emit("portrait");
        await flushLifecycle();
      });

      expect(unhandled).toEqual([]);
      expectFailedLifecycleResume(controller, live, audio);
    } finally {
      errorSpy.mockRestore();
    }
  });

  it("does not auto-resume MAX_SOURCE_MS suspension on visibility restore", async () => {
    const visibility = new FakeVisibility();
    const { controller, audio } = createController({
      orientation: new FakeOrientation(),
      visibility,
      wakeLock: new FakeWakeLock(),
    });
    await enterListening(controller);
    emitVoice(audio, true);
    await vi.advanceTimersByTimeAsync(runtime.maxSourceMs);
    await flushMicrotasks();
    expect(controller.session.state).toBe("suspended");
    expect(controller.recoveryPrompt).toBe("resume-repeat");

    visibility.hide();
    visibility.show();
    await flushMicrotasks();

    expect(controller.session.state).toBe("suspended");
    expect(controller.recoveryPrompt).toBe("resume-repeat");
  });

  it("fails resume to error when the microphone track is not live", async () => {
    const visibility = new FakeVisibility();
    const audio = createFakeAudio();
    const { controller, live } = createController({
      audio,
      orientation: new FakeOrientation(),
      visibility,
      wakeLock: new FakeWakeLock(),
    });
    await startSourceTurn(controller, live, audio);
    visibility.hide();
    await flushMicrotasks();
    audio.captureTrack.readyState = "ended";

    visibility.show();
    await flushLifecycle();

    expect(controller.session.state).toBe("error");
    expect(controller.ownerError).toBe(CONNECTION_ERROR_MESSAGE);
    expect(live.setInputMuted).not.toHaveBeenLastCalledWith(false);
  });

  it("fails resume to error when the peer connection is failed or closed", async () => {
    const visibility = new FakeVisibility();
    const { controller, live, audio } = createController({
      orientation: new FakeOrientation(),
      visibility,
      wakeLock: new FakeWakeLock(),
    });
    await startSourceTurn(controller, live, audio);
    visibility.hide();
    await flushMicrotasks();
    live.peerConnectionState = "failed";

    visibility.show();
    await flushLifecycle();

    expect(controller.session.state).toBe("error");
    expect(controller.ownerError).toBe(CONNECTION_ERROR_MESSAGE);
  });

  it("fails resume to error when the data channel is not open", async () => {
    const visibility = new FakeVisibility();
    const { controller, live, audio } = createController({
      orientation: new FakeOrientation(),
      visibility,
      wakeLock: new FakeWakeLock(),
    });
    await startSourceTurn(controller, live, audio);
    visibility.hide();
    await flushMicrotasks();
    live.dataChannelReadyState = "connecting";

    visibility.show();
    await flushLifecycle();

    expect(controller.session.state).toBe("error");
    expect(controller.ownerError).toBe(CONNECTION_ERROR_MESSAGE);
  });

  it("fails resume to error when peer connection state cannot be read", async () => {
    const visibility = new FakeVisibility();
    const { controller, live, audio } = createController({
      orientation: new FakeOrientation(),
      visibility,
      wakeLock: new FakeWakeLock(),
    });
    await startSourceTurn(controller, live, audio);
    visibility.hide();
    await flushMicrotasks();
    live.peerConnectionState = null;

    visibility.show();
    await flushLifecycle();

    expect(controller.session.state).toBe("error");
    expect(controller.ownerError).toBe(CONNECTION_ERROR_MESSAGE);
  });

  it("does not resume while orientation is still landscape", async () => {
    const orientation = new FakeOrientation();
    const visibility = new FakeVisibility();
    const { controller, live, audio } = createController({
      orientation,
      visibility,
      wakeLock: new FakeWakeLock(),
    });
    await startSourceTurn(controller, live, audio);
    orientation.emit("landscape");
    await flushMicrotasks();

    visibility.hide();
    visibility.show();
    await flushMicrotasks();

    expect(controller.session.state).toBe("suspended");
    expect(controller.recoveryPrompt).toBeUndefined();
  });

  it("locks portrait and requests wake lock when interpreter mode starts", async () => {
    const orientation = new FakeOrientation();
    const wakeLock = new FakeWakeLock();
    const visibility = new FakeVisibility();
    const { controller } = createController({ orientation, visibility, wakeLock });

    await enterListening(controller);

    expect(orientation.lockPortrait).toHaveBeenCalledOnce();
    expect(orientation.start).toHaveBeenCalledOnce();
    expect(visibility.start).toHaveBeenCalledOnce();
    expect(wakeLock.request).toHaveBeenCalledOnce();
  });

  it("samples orientation at start and suspends when already landscape", async () => {
    const orientation = new FakeOrientation();
    orientation.emit("landscape");
    const { controller } = createController({
      orientation,
      visibility: new FakeVisibility(),
      wakeLock: new FakeWakeLock(),
    });

    await enterListening(controller);

    expect(controller.session.state).toBe("suspended");
    expect(controller.suspendReason).toBe("orientation");
    expect(controller.session.activeTurn).toBeUndefined();
  });

  it("resumes AudioContext on lifecycle resume", async () => {
    const visibility = new FakeVisibility();
    const { controller, live, audio } = createController({
      orientation: new FakeOrientation(),
      visibility,
      wakeLock: new FakeWakeLock(),
    });
    await startSourceTurn(controller, live, audio);
    const primeCount = audio.primeOutput.mock.calls.length;

    visibility.hide();
    await flushMicrotasks();
    visibility.show();
    await flushLifecycle();

    expect(audio.primeOutput.mock.calls.length).toBeGreaterThan(primeCount);
    expect(controller.session.state).toBe("listening");
  });

  it("resumes from AudioContext interrupted to suspended via statechange", async () => {
    const { audio, audioContext } = createDispatchableAudio();
    const { controller, live } = createController({
      audio,
      orientation: new FakeOrientation(),
      visibility: new FakeVisibility(),
      wakeLock: new FakeWakeLock(),
    });
    await startSourceTurn(controller, live, audio);
    const primeOutput = vi.spyOn(audio, "primeOutput");
    const primeCount = primeOutput.mock.calls.length;

    audioContext.setState("interrupted");
    await flushMicrotasks();
    expect(controller.session.state).toBe("suspended");

    audioContext.setState("suspended");
    await flushLifecycle();

    expect(primeOutput.mock.calls.length).toBeGreaterThan(primeCount);
    expect(controller.session.state).toBe("listening");
  });

  it("errors immediately when the mic track ends while visible", async () => {
    const { audio, track } = createDispatchableAudio();
    const { controller, live } = createController({
      audio,
      orientation: new FakeOrientation(),
      visibility: new FakeVisibility(),
      wakeLock: new FakeWakeLock(),
    });
    await startSourceTurn(controller, live, audio);

    track.end();
    await flushLifecycle();

    expect(controller.session.state).toBe("error");
    expect(controller.ownerError).toBe(MICROPHONE_CAPTURE_ENDED_MESSAGE);
    expect(controller.inputReady).toBe(false);
    expect(audio.getCaptureStream()).toBeNull();
    expect(live.setInputMuted).not.toHaveBeenCalledWith(true);
    const originalText = controller.session.activeTurn?.originalText;
    live.emit({ type: "session.input_transcript.delta", delta: "ignored" });
    expect(controller.session.activeTurn?.originalText).toBe(originalText);
  });

  it("keeps a suspended session terminal when the mic track ends before restore", async () => {
    const visibility = new FakeVisibility();
    const { audio, track } = createDispatchableAudio();
    const { controller, live } = createController({
      audio,
      orientation: new FakeOrientation(),
      visibility,
      wakeLock: new FakeWakeLock(),
    });
    await startSourceTurn(controller, live, audio);
    visibility.hide();
    await flushMicrotasks();
    expect(controller.session.state).toBe("suspended");

    track.end();
    await flushLifecycle();
    visibility.show();
    await flushLifecycle();

    expect(controller.session.state).toBe("error");
    expect(controller.ownerError).toBe(MICROPHONE_CAPTURE_ENDED_MESSAGE);
    expect(controller.inputReady).toBe(false);
    expect(audio.getCaptureStream()).toBeNull();
    expect(live.setInputMuted).not.toHaveBeenLastCalledWith(false);
  });

  it("resumes after AudioContext leaves interrupted when media is still live", async () => {
    const { controller, live, audio } = createController({
      orientation: new FakeOrientation(),
      visibility: new FakeVisibility(),
      wakeLock: new FakeWakeLock(),
    });
    await startSourceTurn(controller, live, audio);
    if (audio.onAudioInterruption === null || audio.onAudioRestored === null) {
      throw new Error("Audio interruption/restore handlers were not installed");
    }
    const primeCount = audio.primeOutput.mock.calls.length;

    audio.onAudioInterruption();
    await flushMicrotasks();
    expect(controller.session.state).toBe("suspended");

    audio.onAudioRestored();
    await flushLifecycle();

    expect(audio.primeOutput.mock.calls.length).toBeGreaterThan(primeCount);
    expect(controller.session.state).toBe("listening");
  });

  it("handles rejected audio-restored resume steering without leaking an unhandled rejection", async () => {
    const errorSpy = vi.spyOn(console, "error").mockImplementation(() => {});
    try {
      const { controller, live, audio } = createController({
        orientation: new FakeOrientation(),
        visibility: new FakeVisibility(),
        wakeLock: new FakeWakeLock(),
      });
      rejectPostResumeSteering(live);
      await startSourceTurn(controller, live, audio);
      if (audio.onAudioInterruption === null || audio.onAudioRestored === null) {
        throw new Error("Audio interruption/restore handlers were not installed");
      }

      audio.onAudioInterruption();
      await flushLifecycle();

      const unhandled = await collectUnhandledRejectionsDuringFakeTimers(async () => {
        audio.onAudioRestored?.();
        await flushLifecycle();
      });

      expect(unhandled).toEqual([]);
      expectFailedLifecycleResume(controller, live, audio);
    } finally {
      errorSpy.mockRestore();
    }
  });

  it("keeps Gate C closed and does not steer until leftover playback and captions are idle", async () => {
    const visibility = new FakeVisibility();
    const { controller, live, audio } = createController({
      orientation: new FakeOrientation(),
      visibility,
      wakeLock: new FakeWakeLock(),
    });
    await startSourceTurn(controller, live, audio);
    emitPlayback(audio, true);
    const steeringAfterStart = live.appendInstructions.mock.calls.length;

    visibility.hide();
    await flushMicrotasks();
    visibility.show();
    await flushLifecycle();

    expect(controller.session.state).toBe("suspended");
    expect(audio.setOutputAudible).toHaveBeenLastCalledWith(false);
    expect(live.appendInstructions.mock.calls.length).toBe(steeringAfterStart);
    expect(live.setInputMuted).not.toHaveBeenLastCalledWith(false);

    emitPlayback(audio, false);
    await flushMicrotasks();
    await vi.advanceTimersByTimeAsync(runtime.captionIdleMs);
    await flushLifecycle();

    expect(controller.session.state).toBe("listening");
    expect(live.appendInstructions.mock.calls.length).toBe(steeringAfterStart + 1);
    expect(live.appendInstructions).toHaveBeenLastCalledWith(
      buildSteering({ A: "en", B: "es" }),
      { kind: "later_steering", sessionState: "suspended" },
    );
    expect(audio.setOutputAudible).toHaveBeenLastCalledWith(true);
    expect(live.setInputMuted).toHaveBeenLastCalledWith(false);
  });

  it.each([false, true])("retires owned playback on suspension when the RMS sampler stayed inactive, non-interrupting=%s", async enabled => {
    vi.spyOn(HTMLMediaElement.prototype, "play").mockResolvedValue(undefined);
    vi.spyOn(HTMLMediaElement.prototype, "pause").mockImplementation(() => {});
    vi.spyOn(HTMLMediaElement.prototype, "load").mockImplementation(() => {});
    const queue = new PlaybackQueue(48_000);
    const node = Object.assign(new DispatchableAudioNode(), {
      port: {
        postMessage: vi.fn((data: { type: string; value?: boolean; turnId?: string; generation?: number }) => {
          if (data.type === "audible") queue.setAudible(data.value === true);
          if (data.type === "enabled") queue.setEnabled(data.value === true);
          if (data.type === "speaking") queue.setSpeaking(data.value === true);
          if (data.type === "turn") queue.setTurn(data.turnId);
          if (data.type === "dispose") queue.clear();
          if (data.type === "enabled" || (data.type === "audible" && !data.value)) {
            queueMicrotask(() => node.port.onmessage?.({ data: { type: "reset", generation: data.generation } } as MessageEvent));
          }
        }),
        close: vi.fn(), onmessage: null as ((event: MessageEvent) => void) | null,
      }, onprocessorerror: null,
    });
    queue.onPlaybackTurn = (turnId, active) => node.port.onmessage?.({
      data: { type: "turn", turnId, value: active },
    } as MessageEvent);
    const { audio, audioContext } = createDispatchableAudio(undefined, () => node as unknown as AudioWorkletNode);
    Object.assign(audioContext, {
      audioWorklet: { addModule: vi.fn(async () => {}) },
      createMediaStreamDestination: () => ({ stream: audio.getCaptureStream()! }),
    });
    const orientation = new FakeOrientation();
    const { controller, live } = createController({ audio, orientation });
    try {
      await controller.startWithLanguages({ A: "en", B: "es" });
      controller.handleRemoteStream(audio.getCaptureStream()!, live as unknown as LiveClient);
      await flushMicrotasks();
      audio.setNonInterrupting(enabled);
      emitVoice(audio, true);
      live.emit({ type: "session.input_transcript.delta", delta: "Where is the station?" });
      live.emit({ type: "session.output_transcript.delta", delta: "Dónde está la estación?" });
      emitVoice(audio, false);
      queue.process(new Float32Array(14_400));
      const quietSine = Float32Array.from({ length: 4_800 }, (_, index) => .018 * Math.sin(2 * Math.PI * 1000 * index / 48_000));
      queue.process(quietSine);
      expect(controller.session.activeTurn?.audioOutputStarted).toBe(true);
      expect(audio.rawPlaybackActive).toBe(false); // Dispatchable analysers remain silent/inactive.
      orientation.emit("landscape");
      await flushMicrotasks();
      expect((controller as unknown as { playbackActive: boolean }).playbackActive).toBe(false);
      orientation.emit("portrait");
      await flushLifecycle();
      await vi.advanceTimersByTimeAsync(runtime.captionIdleMs - 1);
      expect(controller.session.state).toBe("suspended");
      await vi.advanceTimersByTimeAsync(1);
      await flushLifecycle();
      expect(controller.session.state).toBe("listening");
      expect(audio.audioElement.muted).toBe(false);
    } finally { await controller.cancel(); audio.dispose(); }
  });

  it("keeps fast resume gated until a fresh sample when the worklet pending message is still in flight", async () => {
    const queue = new PlaybackQueue(1000);
    const audio = Object.assign(createFakeAudio(), {
      hasPendingPlayback: false, rawPlaybackActive: false,
      onRemoteAudioSample: null as AudioController["onRemoteAudioSample"],
      setNonInterrupting: vi.fn((enabled: boolean) => queue.setEnabled(enabled)),
    });
    audio.setOutputAudible.mockImplementation(audible => {
      audio.audioElement.muted = !audible;
      queue.setAudible(audible);
    });
    const orientation = new FakeOrientation();
    const { controller, live } = createController({ audio, orientation });
    await startSourceTurn(controller, live, audio);
    audio.setNonInterrupting(true);
    queue.setSpeaking(true);
    queue.process(new Float32Array(128).fill(.5));
    expect(queue.pending).toBe(true);
    expect(audio.hasPendingPlayback).toBe(false); // Port message and first raw sample have not arrived.
    orientation.emit("landscape");
    await flushMicrotasks();
    orientation.emit("portrait");
    await flushLifecycle();
    await vi.advanceTimersByTimeAsync(runtime.captionIdleMs);
    expect(controller.session.state).toBe("suspended");
    expect(audio.audioElement.muted).toBe(true);
    audio.rawPlaybackActive = true;
    audio.onRemoteAudioSample?.({ active: true, atMs: Date.now() });
    expect(queue.process(Float32Array.of(.7))[0]).toBe(0);
    expect(audio.captureTrack.enabled).toBe(false);
    audio.rawPlaybackActive = false;
    audio.onRemoteAudioSample?.({ active: false, atMs: Date.now() });
    await flushLifecycle(); // Steering and unmute both acknowledge immediately.
    expect(controller.session.state).toBe("listening");
    expect(audio.audioElement.muted).toBe(false);
    expect(queue.process(new Float32Array(128)).every(sample => sample === 0)).toBe(true);
  });
  it.each([
    ["steering", true], ["unmute", true], ["steering", false], ["unmute", false],
  ] as const)("waits for fresh raw idle during resume %s, pending message delivered=%s", async (phase, pendingDelivered) => {
    const queue = new PlaybackQueue(1000);
    const audio = Object.assign(createFakeAudio(), {
      rawPlaybackActive: false,
      onRemoteAudioSample: null as AudioController["onRemoteAudioSample"],
      setNonInterrupting: vi.fn((enabled: boolean) => queue.setEnabled(enabled)),
    });
    Object.defineProperty(audio, "hasPendingPlayback", { get: () => pendingDelivered && queue.pending });
    audio.setOutputAudible.mockImplementation(audible => {
      audio.audioElement.muted = !audible;
      queue.setAudible(audible);
    });
    const orientation = new FakeOrientation();
    const { controller, live } = createController({ audio, orientation });
    await startSourceTurn(controller, live, audio);
    audio.setNonInterrupting(true);
    queue.setSpeaking(true);
    queue.process(new Float32Array(128).fill(.5));
    expect(queue.pending).toBe(true);
    const steeringCount = live.appendInstructions.mock.calls.length;
    let release!: () => void;
    if (phase === "steering") {
      live.appendInstructions.mockImplementationOnce(() => new Promise(resolve => {
        release = () => resolve({ eventId: "resume-steering" });
      }));
    } else {
      live.setInputMuted.mockImplementation(async muted => {
        if (!muted) await new Promise<void>(resolve => { release = resolve; });
      });
    }
    orientation.emit("landscape");
    await flushMicrotasks();
    expect(queue.pending).toBe(false); // Gate C discarded PCM, but not the incoming response.
    orientation.emit("portrait");
    await flushLifecycle();
    await vi.advanceTimersByTimeAsync(runtime.captionIdleMs);
    expect(controller.session.state).toBe("suspended");
    expect(live.appendInstructions.mock.calls.length).toBe(steeringCount);
    expect(audio.audioElement.muted).toBe(true);
    const incoming = (active: boolean) => {
      audio.rawPlaybackActive = active;
      audio.onRemoteAudioSample?.({ active, atMs: Date.now() });
      emitPlayback(audio, active);
    };
    incoming(true);
    expect(queue.process(Float32Array.of(.7))[0]).toBe(0);
    incoming(false);
    await waitUntil(() => release !== undefined);
    incoming(true); // More stale audio arrives while steering/unmute is awaiting its acknowledgement.
    release();
    await flushLifecycle();
    await vi.advanceTimersByTimeAsync(runtime.captionIdleMs);
    expect(controller.session.state).toBe("suspended");
    expect(audio.audioElement.muted).toBe(true);
    expect(audio.captureTrack.enabled).toBe(false);
    expect(queue.process(Float32Array.of(.8))[0]).toBe(0);
    incoming(false);
    await flushLifecycle();
    expect(controller.session.state).toBe("listening");
    expect(audio.audioElement.muted).toBe(false);
    expect(queue.process(new Float32Array(128)).every(sample => sample === 0)).toBe(true);
  });

  it("does not open gates when hidden arrives before an in-flight resume commits", async () => {
    const visibility = new FakeVisibility();
    const live = new FakeLive();
    let releaseSteer: (() => void) | undefined;
    live.appendInstructions.mockImplementation(async (text: string, policy?: { kind: string }) => {
      live.callOrder.push(`instructions:${text}`);
      if (policy?.kind === "later_steering") {
        await new Promise<void>((resolve) => {
          releaseSteer = resolve;
        });
      }
      return { eventId: "evt-later" };
    });
    const { controller, audio } = createController({
      live,
      orientation: new FakeOrientation(),
      visibility,
      wakeLock: new FakeWakeLock(),
    });
    await startSourceTurn(controller, live, audio);

    visibility.hide();
    await flushMicrotasks();
    visibility.show();
    await waitUntil(() => releaseSteer !== undefined);
    visibility.hide();
    const finishSteer = releaseSteer;
    if (finishSteer === undefined) {
      throw new Error("Resume steering did not start");
    }
    finishSteer();
    await flushLifecycle();

    expect(controller.session.state).toBe("suspended");
    expect(controller.suspendReason).toBe("visibility");
    expect(audio.setOutputAudible).toHaveBeenLastCalledWith(false);
    expect(live.setInputMuted).not.toHaveBeenLastCalledWith(false);
  });

  it("finishes suspend before resume when visible arrives during Gate B mute", async () => {
    const visibility = new FakeVisibility();
    const live = new FakeLive();
    let releaseMute: (() => void) | undefined;
    live.setInputMuted.mockImplementation(async (muted: boolean) => {
      live.callOrder.push(`setInputMuted:${muted}`);
      if (muted) {
        await new Promise<void>((resolve) => {
          releaseMute = resolve;
        });
      }
    });
    const { controller, audio } = createController({
      live,
      orientation: new FakeOrientation(),
      visibility,
      wakeLock: new FakeWakeLock(),
    });
    await startSourceTurn(controller, live, audio);

    visibility.hide();
    await waitUntil(() => releaseMute !== undefined);
    visibility.show();
    expect(controller.recoveryPrompt).toBeUndefined();
    expect(live.setInputMuted).not.toHaveBeenLastCalledWith(false);
    expect(controller.session.state).toBe("suspended");
    expect(audio.setCaptureEnabled).toHaveBeenLastCalledWith(false);
    expect(audio.captureTrack.enabled).toBe(false);

    const finishMute = releaseMute;
    if (finishMute === undefined) {
      throw new Error("Gate B mute did not start");
    }
    finishMute();
    await flushLifecycle();

    expect(controller.session.state).toBe("listening");
    expect(controller.recoveryPrompt).toBe("repeat");
    expect(audio.setCaptureEnabled).toHaveBeenLastCalledWith(true);
    expect(audio.captureTrack.enabled).toBe(true);
    expect(audio.setOutputAudible).toHaveBeenLastCalledWith(true);
    expect(live.setInputMuted).toHaveBeenLastCalledWith(false);
  });
});

async function waitUntil(check: () => boolean): Promise<void> {
  for (let attempt = 0; attempt < 20; attempt += 1) {
    if (check()) {
      return;
    }
    await Promise.resolve();
  }
  throw new Error("Timed out waiting for lifecycle condition");
}

describe("fixed-language conversation regression", () => {
  beforeEach(() => { vi.useFakeTimers(); });

  it("routes B-A-A-A-B-B by language, retains independent repeated-direction output, and resolves OK after pause", async () => {
    const { controller, live, audio, visibility } = createController();
    await controller.startBootstrap();
    await controller.acceptBootstrap("Я говорю по-русски и хочу узнать дорогу к вокзалу.");
    await controller.startBootstrap();
    await controller.acceptBootstrap("I speak English and would like to find the nearest station.");
    await controller.beginInterpreter();
    const russian = "Подскажите, пожалуйста, где находится вокзал?";
    const english = "Could you tell me where the train station is?";
    let providerStart = 0;
    for (const side of ["B", "A", "A", "A", "B", "B"] as const) {

      emitVoice(audio, true);
      expect(controller.session.activeTurn?.speaker).toBeUndefined();
      live.emit({ type: "session.input_transcript.delta", delta: side === "A" ? russian : english, start_ms: providerStart, end_ms: providerStart + 500 });
      expect(controller.session.activeTurn?.speaker).toBe(side);
      expect(controller.session.activeTurn?.sideSource).toBe("language");
      const sourceId = controller.session.activeTurn?.id;
      live.emit({ type: "session.output_transcript.delta", delta: side === "A" ? english : russian, start_ms: providerStart + 600, end_ms: providerStart + 900 });
      emitVoice(audio, false);
      await vi.advanceTimersByTimeAsync(runtime.noOutputTimeoutMs + runtime.captionIdleMs);
      expect(controller.session.activeTurn).toBeUndefined();
      expect(controller.session.recentTurns.find(turn => turn.id === sourceId)?.speaker).toBe(side);
      expect(controller.inputReady).toBe(true);
      providerStart += 3000;
    }
    expect(controller.session.recentTurns.filter(turn => !turn.translationOnly).map(turn => turn.speaker))
      .toEqual(["B", "A", "A", "A", "B", "B"]);
    expect(controller.session.recentTurns.filter(turn => turn.translationOnly)).toHaveLength(4);
    visibility.hide();
    await flushMicrotasks();
    visibility.show();
    await vi.advanceTimersByTimeAsync(runtime.captionIdleMs);
    expect(controller.session.state).toBe("listening");
    expect(controller.session.participantA.language).toBe("ru");
    expect(controller.session.participantB.language).toBe("en");
    expect(controller.session.recentTurns).toHaveLength(10);
    emitVoice(audio, true);
    live.emit({ type: "session.input_transcript.delta", delta: "OK" });
    expect(controller.session.activeTurn?.speaker).toBeUndefined();
    live.emit({ type: "session.output_transcript.delta", delta: "Хорошо" });
    emitVoice(audio, false);
    await vi.advanceTimersByTimeAsync(runtime.audioStartGraceMs + runtime.captionIdleMs);
    expect(controller.session.recentTurns.at(-1)?.speaker).toBe("B");
    expect(controller.session.recentTurns).toHaveLength(11);
  });

  it("does not commit a calibration result after cancellation", async () => {
    const { controller, live } = createController();
    await controller.startBootstrap();
    let acknowledge!: () => void;
    live.setInputMuted.mockImplementationOnce(() => new Promise<void>(resolve => { acknowledge = resolve; }));
    const saving = controller.acceptBootstrap("I speak English and would like to find the nearest station.");
    await controller.cancel();
    acknowledge();
    await saving;
    expect(controller.session.state).toBe("idle");
    expect(controller.session.participantA.language).toBeUndefined();
  });
});

describe("open-input interpretation", () => {
  beforeEach(() => { vi.useFakeTimers(); });

  async function startRussianEnglish() {
    const fixture = createController();
    await fixture.controller.startWithLanguages({ A: "ru", B: "en" });
    fixture.live.setInputMuted.mockClear();
    return fixture;
  }

  it("keeps independent display captions across service completion and clears them on cancellation", async () => {
    window.history.replaceState({}, "", "/");
    const { controller, live, audio } = await startRussianEnglish();
    emitVoice(audio, true);
    live.emit({ type: "session.input_transcript.delta", delta: "Да, у вас посылка для меня?" });
    live.emit({ type: "session.output_transcript.delta", delta: "Do you have a package for " });
    emitVoice(audio, false);
    await vi.advanceTimersByTimeAsync(runtime.noOutputTimeoutMs + runtime.captionIdleMs);
    live.emit({ type: "session.output_transcript.delta", delta: "me?" });
    expect(controller.captionBlocks.map(({ kind, side, text }) => ({ kind, side, text }))).toEqual([
      { kind: "input", side: "A", text: "Да, у вас посылка для меня?" },
      { kind: "output", side: "B", text: "Do you have a package for me?" },
    ]);
    expect(live.setInputMuted).not.toHaveBeenCalledWith(true);
    await controller.cancel();
    expect(controller.captionBlocks).toEqual([]);
    window.history.replaceState({}, "", "/");
  });

  it("collects dialogue captions at the normal URL without opting in", async () => {
    const { controller, live, audio } = await startRussianEnglish();
    emitVoice(audio, true);
    live.emit({ type: "session.input_transcript.delta", delta: "Здравствуйте, я хочу получить посылку." });
    expect(controller.captionBlocks).toMatchObject([{ kind: "input", side: "A", text: "Здравствуйте, я хочу получить посылку." }]);
  });

  it("seals caption context and retains real interruption guidance after orientation recovery", async () => {
    window.history.replaceState({}, "", "/?captions=blocks");
    const { controller, live, audio, orientation } = await startRussianEnglish();
    emitVoice(audio, true);
    live.emit({ type: "session.input_transcript.delta", delta: "Мне нужна посылка." });
    orientation.emit("landscape");
    await flushLifecycle();
    orientation.emit("portrait");
    await flushLifecycle();
    expect(controller.session.state).toBe("listening");
    expect(controller.recoveryPrompt).toBe("repeat");
    expect(controller.recoveryPromptIsTurnFailure).toBe(false);
    emitVoice(audio, true);
    live.emit({ type: "session.input_transcript.delta", delta: "Повторю сначала." });
    expect(controller.captionBlocks.map(block => block.text)).toEqual(["Мне нужна посылка.", "Повторю сначала."]);
  });

  it("keeps an unfinished English continuation with A after the caption timer", async () => {
    const { controller, live, audio } = createController();
    await controller.startWithLanguages({ A: "en", B: "es" });
    emitVoice(audio, true);
    live.emit({ type: "session.input_transcript.delta", delta: "Where is the nearest station?" });
    const id = controller.session.activeTurn?.id;
    live.emit({ type: "session.input_transcript.delta", delta: " Thank y" });
    await vi.advanceTimersByTimeAsync(runtime.captionIdleMs);
    expect(controller.session.activeTurn?.id).toBe(id);
    expect(controller.session.pendingTurns ?? []).toHaveLength(0);
    live.emit({ type: "session.input_transcript.delta", delta: "ou very much." });
    expect(controller.session.activeTurn).toMatchObject({ id, speaker: "A",
      originalText: "Where is the nearest station? Thank you very much." });
  });

  it("preserves forced partial captions as unresolved when suspending", async () => {
    const { controller, live, audio, visibility } = createController();
    await controller.startWithLanguages({ A: "en", B: "es" });
    emitVoice(audio, true);
    live.emit({ type: "session.input_transcript.delta", delta: "Where is the nearest station?" });
    live.emit({ type: "session.input_transcript.delta", delta: " Thank y" });
    visibility.hide();
    await flushMicrotasks();
    expect(controller.session.recentTurns.find(turn => turn.originalText === " Thank y")).toMatchObject({
      speaker: undefined, status: "discarded" });
  });

  it("preserves undecidable buffered speech before applying a queued language change", async () => {
    const { controller, live, audio } = createController();
    await controller.startWithLanguages({ A: "en", B: "es" });
    emitVoice(audio, true);
    live.emit({ type: "session.input_transcript.delta", delta: "Where is the nearest station?", start_ms: 0, end_ms: 1000 });
    live.emit({ type: "session.output_transcript.delta", delta: "¿Dónde está la estación de tren, por favor?", start_ms: 500, end_ms: 1500 });
    live.emit({ type: "session.input_transcript.delta", delta: " Thank y", start_ms: 2000, end_ms: 2500 });
    await controller.changeInterlocutorLanguage("de");
    emitVoice(audio, false);
    await vi.advanceTimersByTimeAsync(runtime.audioStartGraceMs + runtime.captionIdleMs);
    expect(controller.session.participantB.language).toBe("es");
    expect(controller.session.activeTurn).toMatchObject({ originalText: " Thank y", speaker: undefined });
    await vi.advanceTimersByTimeAsync(runtime.noOutputTimeoutMs + runtime.captionIdleMs);
    expect(controller.session.participantB.language).toBe("de");
    expect(controller.session.recentTurns.find(turn => turn.originalText === " Thank y")).toMatchObject({
      speaker: undefined, status: "failed" });
  });

  it("preserves pending language evidence when a language is requested after the visible source closed", async () => {
    const { controller, live, audio } = createController();
    await controller.startWithLanguages({ A: "en", B: "es" });
    emitVoice(audio, true);
    live.emit({ type: "session.input_transcript.delta", delta: "Where is the nearest station?", start_ms: 0, end_ms: 1000 });
    live.emit({ type: "session.output_transcript.delta", delta: "¿Dónde está la estación de tren, por favor?", start_ms: 500, end_ms: 1500 });
    live.emit({ type: "session.input_transcript.delta", delta: " Thank y", start_ms: 2000, end_ms: 2500 });
    emitVoice(audio, false);
    await vi.advanceTimersByTimeAsync(runtime.audioStartGraceMs + runtime.captionIdleMs);
    expect(controller.session.activeTurn).toBeUndefined();
    await controller.changeInterlocutorLanguage("de");
    expect(controller.session.participantB.language).toBe("es");
    expect(controller.session.activeTurn).toMatchObject({ originalText: " Thank y", speaker: undefined });
  });

  it("does not prefer A2 over completed A1 for an ambiguous late translation", async () => {
    const { controller, live, audio } = await startRussianEnglish();
    emitVoice(audio, true);
    live.emit({ type: "session.input_transcript.delta", delta: "Подскажите, где находится вокзал?", start_ms: 0, end_ms: 500 });
    const a1 = controller.session.activeTurn?.id;
    live.emit({ type: "session.output_transcript.delta", delta: "Where is the train station?", start_ms: 500, end_ms: 900 });
    emitVoice(audio, false);
    await vi.advanceTimersByTimeAsync(runtime.audioStartGraceMs + runtime.captionIdleMs);
    emitVoice(audio, true);
    live.emit({ type: "session.input_transcript.delta", delta: "The station is straight ahead.", start_ms: 1000, end_ms: 1500 });
    live.emit({ type: "session.input_transcript.delta", delta: "Спасибо, я пойду туда пешком.", start_ms: 1600, end_ms: 2000 });
    live.emit({ type: "session.output_transcript.delta", delta: " I want to walk there." });
    expect(controller.session.activeTurn?.translatedText).toBeUndefined();
    expect(controller.session.recentTurns.find(turn => turn.id === a1)?.translatedText).toBe("Where is the train station?");
    expect(controller.session.pendingTurns?.find(turn => turn.translationOnly)).toMatchObject({
      speaker: "A", translatedText: " I want to walk there." });
  });

  it("keeps late timestamped punctuation with completed A output after B starts", async () => {
    const { controller, live, audio } = await startRussianEnglish();
    emitVoice(audio, true);
    live.emit({ type: "session.input_transcript.delta", delta: "Подскажите, где находится вокзал?", start_ms: 0, end_ms: 500 });
    const a = controller.session.activeTurn?.id;
    live.emit({ type: "session.output_transcript.delta", delta: "Where is the train station", start_ms: 600, end_ms: 900 });
    emitVoice(audio, false);
    await vi.advanceTimersByTimeAsync(runtime.audioStartGraceMs + runtime.captionIdleMs);
    emitVoice(audio, true);
    live.emit({ type: "session.input_transcript.delta", delta: "The station is straight ahead.", start_ms: 1000, end_ms: 1500 });
    live.emit({ type: "session.output_transcript.delta", delta: "?", start_ms: 900, end_ms: 950 });
    expect(controller.session.activeTurn?.translatedText).toBeUndefined();
    expect(controller.session.recentTurns.find(turn => turn.id === a)?.translatedText).toBe("Where is the train station?");
  });

  it.each(["", "12, "])("routes B's delayed opening with untimed prefix %j before using A's provisional interval", async prefix => {
    const { controller, live, audio } = await startRussianEnglish();
    emitVoice(audio, true);
    if (prefix) live.emit({ type: "session.input_transcript.delta", delta: prefix });
    live.emit({ type: "session.input_transcript.delta", delta: "Подскажите, где находится вокзал?", start_ms: 0, end_ms: 800 });
    const a = controller.session.activeTurn?.id;
    if (prefix) live.emit({ type: "session.input_transcript.delta", delta: prefix });
    live.emit({ type: "session.input_transcript.delta", delta: "The station is straight ahead.", start_ms: 1200, end_ms: 1500 });
    const b = controller.session.activeTurn?.id;
    live.emit({ type: "session.input_transcript.delta", delta: "Thank you for asking. ", start_ms: 1000, end_ms: 1199 });
    expect(controller.session.activeTurn).toMatchObject({ id: b, speaker: "B",
      originalText: prefix + "Thank you for asking. The station is straight ahead." });
    expect(controller.session.pendingTurns?.find(turn => turn.id === a)).toMatchObject({
      originalText: prefix + "Подскажите, где находится вокзал?", sourceEndMs: 1000 });
  });

  it.each(["The", "?"])("keeps an undecidable timed opening %j outside both established authors", async text => {
    const { controller, live, audio } = await startRussianEnglish();
    emitVoice(audio, true);
    live.emit({ type: "session.input_transcript.delta", delta: "Подскажите, где находится вокзал?", start_ms: 0, end_ms: 800 });
    const a = controller.session.activeTurn?.id;
    live.emit({ type: "session.input_transcript.delta", delta: "The station is straight ahead.", start_ms: 1200, end_ms: 1500 });
    const b = controller.session.activeTurn?.id;
    live.emit({ type: "session.input_transcript.delta", delta: text, start_ms: 1000, end_ms: 1100 });
    await vi.advanceTimersByTimeAsync(runtime.captionIdleMs);
    expect(controller.session.pendingTurns?.find(turn => turn.id === a)?.originalText).toBe("Подскажите, где находится вокзал?");
    expect(controller.session.pendingTurns?.find(turn => turn.id === b)).toMatchObject({
      originalText: "The station is straight ahead.", sourceEndMs: undefined });
    expect(controller.session.activeTurn).toMatchObject({ speaker: undefined, originalText: text });
  });

  it("uses neutral output timestamps before the latest caption's direction", async () => {
    const { controller, live, audio } = await startRussianEnglish();
    emitVoice(audio, true);
    live.emit({ type: "session.input_transcript.delta", delta: "Подскажите, где находится вокзал?", start_ms: 0, end_ms: 500 });
    const a = controller.session.activeTurn?.id;
    live.emit({ type: "session.output_transcript.delta", delta: "Where is the train station", start_ms: 600, end_ms: 900 });
    live.emit({ type: "session.input_transcript.delta", delta: "The station is straight ahead.", start_ms: 1000, end_ms: 1500 });
    live.emit({ type: "session.output_transcript.delta", delta: "Вокзал находится прямо впереди.", start_ms: 1600, end_ms: 1900 });
    live.emit({ type: "session.output_transcript.delta", delta: "?", start_ms: 900, end_ms: 950 });
    expect(controller.session.activeTurn?.translatedText).toBe("Вокзал находится прямо впереди.");
    expect(controller.session.pendingTurns?.find(turn => turn.id === a)?.translatedText).toBe("Where is the train station?");
  });

  it("retains A's delayed first fragment without opening a third source", async () => {
    const { controller, live, audio } = await startRussianEnglish();
    emitVoice(audio, true);
    live.emit({ type: "session.input_transcript.delta", delta: "где находится вокзал?", start_ms: 200, end_ms: 800 });
    const a = controller.session.activeTurn?.id;
    live.emit({ type: "session.input_transcript.delta", delta: "The station is straight ahead.", start_ms: 1000, end_ms: 1500 });
    const b = controller.session.activeTurn?.id;
    live.emit({ type: "session.input_transcript.delta", delta: "Подскажите, пожалуйста, ", start_ms: 0, end_ms: 199 });
    expect(controller.session.activeTurn?.id).toBe(b);
    expect(controller.session.pendingTurns).toHaveLength(1);
    expect(controller.session.pendingTurns?.find(turn => turn.id === a)).toMatchObject({
      speaker: "A", originalText: "Подскажите, пожалуйста, где находится вокзал?", sourceEndMs: 1000 });
    expect(controller.session.activeTurn?.sourceEndMs).toBeUndefined();
  });

  it("does not reauthor a flushed unsupported source when another speaker starts after quiet", async () => {
    const { controller, live, audio } = await startRussianEnglish();
    emitVoice(audio, true);
    live.emit({ type: "session.input_transcript.delta", delta: "Γειά σας, ποιος είναι ο δρόμος;" });
    emitVoice(audio, false);
    await vi.advanceTimersByTimeAsync(runtime.captionIdleMs);
    const unknown = controller.session.activeTurn?.id;
    expect(controller.session.activeTurn?.speaker).toBeUndefined();
    emitVoice(audio, true);
    live.emit({ type: "session.input_transcript.delta", delta: "The station is straight ahead." });
    expect(controller.session.activeTurn).toMatchObject({ speaker: "B", originalText: "The station is straight ahead." });
    expect(controller.session.pendingTurns?.find(turn => turn.id === unknown)).toMatchObject({
      speaker: undefined, originalText: "Γειά σας, ποιος είναι ο δρόμος;" });
  });

  it("accepts a new old-language source while a language change waits for pending A", async () => {
    const { controller, live, audio } = await startRussianEnglish();
    emitVoice(audio, true);
    live.emit({ type: "session.input_transcript.delta", delta: "Подскажите, где находится вокзал?" });
    live.emit({ type: "session.input_transcript.delta", delta: "The station is straight ahead." });
    await controller.changeInterlocutorLanguage("es");
    live.emit({ type: "session.output_transcript.delta", delta: "Вокзал находится прямо впереди." });
    emitVoice(audio, false);
    await vi.advanceTimersByTimeAsync(runtime.audioStartGraceMs + runtime.captionIdleMs);
    expect(controller.session.activeTurn).toMatchObject({ speaker: "B", translatedText: undefined });
    expect(controller.session.pendingTurns).toHaveLength(1);
    expect(audio.captureTrack.enabled).toBe(true);
    emitVoice(audio, true);
    live.emit({ type: "session.input_transcript.delta", delta: "Спасибо, теперь мне нужна другая информация." });
    expect(controller.session.activeTurn).toMatchObject({ speaker: "A", originalText: "Спасибо, теперь мне нужна другая информация." });
    expect(controller.session.participantB.language).toBe("en");
  });

  it("keeps unknown output unassigned instead of completing the only known source", async () => {
    const { controller, live, audio } = await startRussianEnglish();
    emitVoice(audio, true);
    live.emit({ type: "session.input_transcript.delta", delta: "Подскажите, где находится вокзал?" });
    live.emit({ type: "session.output_transcript.delta", delta: "OK" });
    emitVoice(audio, false);
    await vi.advanceTimersByTimeAsync(runtime.captionIdleMs);
    expect(controller.session.activeTurn?.translatedText).toBeUndefined();
    expect(controller.session.pendingTurns?.find(turn => turn.translationOnly)).toMatchObject({
      speaker: undefined, translatedText: "OK" });
    await vi.advanceTimersByTimeAsync(runtime.audioStartGraceMs);
    expect(controller.metrics.snapshot().textOnlyCompletedTurnCount).toBe(0);
  });

  it("retains timed source corrections after failure without recording a new outcome", async () => {
    const { controller, live, audio } = await startRussianEnglish();
    emitVoice(audio, true);
    live.emit({ type: "session.input_transcript.delta", delta: "Подскажите, где находится вокзал?", start_ms: 0, end_ms: 800 });
    const a = controller.session.activeTurn?.id;
    live.emit({ type: "session.input_transcript.delta", delta: "The station is straight ahead.", start_ms: 1000, end_ms: 1500 });
    emitVoice(audio, false);
    await vi.advanceTimersByTimeAsync(runtime.noOutputTimeoutMs + runtime.captionIdleMs);
    const before = controller.metrics.snapshot();
    live.emit({ type: "session.input_transcript.delta", delta: " Я хочу дойти туда пешком.", start_ms: 810, end_ms: 980 });
    expect(controller.session.activeTurn).toBeUndefined();
    expect(controller.session.recentTurns.find(turn => turn.id === a)).toMatchObject({
      status: "failed", originalText: "Подскажите, где находится вокзал? Я хочу дойти туда пешком." });
    expect(controller.metrics.snapshot().failedTurnCount).toBe(before.failedTurnCount);
  });

  it("does not postpone A's no-output deadline when B's transcript arrives after quiet", async () => {
    const { controller, live, audio } = await startRussianEnglish();
    emitVoice(audio, true);
    live.emit({ type: "session.input_transcript.delta", delta: "Подскажите, где находится вокзал?" });
    const a = controller.session.activeTurn?.id;
    emitVoice(audio, false);
    const idle = controller.session.activeTurn?.sourceIdleAtMs;
    await vi.advanceTimersByTimeAsync(runtime.noOutputTimeoutMs - 100);
    live.emit({ type: "session.input_transcript.delta", delta: "The station is straight ahead." });
    expect(controller.session.pendingTurns?.find(turn => turn.id === a)?.sourceIdleAtMs).toBe(idle);
    await vi.advanceTimersByTimeAsync(100);
    expect(controller.session.recentTurns.find(turn => turn.id === a)?.status).toBe("failed");
  });

  it("does not strand a buffered new speaker when local quiet arrived before language evidence", async () => {
    const { controller, live, audio } = await startRussianEnglish();
    emitVoice(audio, true);
    live.emit({ type: "session.input_transcript.delta", delta: "Подскажите, где находится вокзал?" });
    live.emit({ type: "session.input_transcript.delta", delta: "Thank you" });
    emitVoice(audio, false);
    await vi.advanceTimersByTimeAsync(runtime.captionIdleMs);
    expect(controller.session.activeTurn).toMatchObject({ speaker: "B", originalText: "Thank you" });
    expect(controller.session.activeTurn?.sourceIdleAtMs).toBeDefined();
    live.emit({ type: "session.output_transcript.delta", delta: "Спасибо за вашу помощь." });
    await vi.advanceTimersByTimeAsync(runtime.noOutputTimeoutMs + runtime.captionIdleMs);
    expect(controller.session.activeTurn).toBeUndefined();
    expect(controller.inputReady).toBe(true);
  });

  it("updates completed A source with a delayed timed fragment after B starts", async () => {
    const { controller, live, audio } = await startRussianEnglish();
    emitVoice(audio, true);
    live.emit({ type: "session.input_transcript.delta", delta: "Подскажите, где находится вокзал?", start_ms: 0, end_ms: 500 });
    const aId = controller.session.activeTurn?.id;
    live.emit({ type: "session.output_transcript.delta", delta: "Where is the train station?" });
    emitVoice(audio, false);
    await vi.advanceTimersByTimeAsync(runtime.audioStartGraceMs + runtime.captionIdleMs);
    emitVoice(audio, true);
    live.emit({ type: "session.input_transcript.delta", delta: "The station is straight ahead.", start_ms: 1000, end_ms: 1500 });
    const bId = controller.session.activeTurn?.id;
    live.emit({ type: "session.input_transcript.delta", delta: " Я хочу дойти туда пешком.", start_ms: 550, end_ms: 950 });
    expect(controller.session.activeTurn?.id).toBe(bId);
    expect(controller.session.recentTurns.find(turn => turn.id === aId)?.originalText).toBe("Подскажите, где находится вокзал? Я хочу дойти туда пешком.");
  });

  it("never assigns late A playback to the new B source after A caption idle", async () => {
    const { controller, live, audio } = await startRussianEnglish();
    emitVoice(audio, true);
    live.emit({ type: "session.input_transcript.delta", delta: "Подскажите, где находится вокзал?" });
    live.emit({ type: "session.output_transcript.delta", delta: "Where is the train station?" });
    emitVoice(audio, false);
    await vi.advanceTimersByTimeAsync(runtime.audioStartGraceMs + runtime.captionIdleMs);
    emitVoice(audio, true);
    live.emit({ type: "session.input_transcript.delta", delta: "The station is straight ahead." });
    emitPlayback(audio, true);
    expect(controller.session.activeTurn?.audioOutputStarted).toBe(false);
    expect(controller.session.activeTurn?.firstAudibleOutputAtMs).toBeUndefined();
  });

  it("orders late source fragments by their session timestamps without deleting repeated words", async () => {
    const { controller, live, audio } = await startRussianEnglish();
    emitVoice(audio, true);
    live.emit({ type: "session.input_transcript.delta", delta: "Подскажите, пожалуйста, мне нужна", start_ms: 0, end_ms: 200 });
    live.emit({ type: "session.input_transcript.delta", delta: " информация пораньше.", start_ms: 600, end_ms: 900 });
    const aId = controller.session.activeTurn?.id;
    live.emit({ type: "session.input_transcript.delta", delta: "The station is straight ahead.", start_ms: 1000, end_ms: 1500 });
    live.emit({ type: "session.input_transcript.delta", delta: " эта информация,", start_ms: 250, end_ms: 550 });
    await vi.advanceTimersByTimeAsync(runtime.captionIdleMs);
    expect(controller.session.pendingTurns?.find(t => t.id === aId)?.originalText).toBe("Подскажите, пожалуйста, мне нужна эта информация, информация пораньше.");
  });

  it("keeps a fresh untimed old-language result independent of completed history", async () => {
    const { controller, live, audio } = await startRussianEnglish();

    emitVoice(audio, true);
    live.emit({ type: "session.input_transcript.delta", delta: "Подскажите, где находится вокзал?" });
    const aId = controller.session.activeTurn?.id;
    live.emit({ type: "session.output_transcript.delta", delta: "Where is the train station?" });
    emitVoice(audio, false);
    await vi.advanceTimersByTimeAsync(runtime.audioStartGraceMs + runtime.captionIdleMs);
    const before = controller.metrics.snapshot().textOnlyCompletedTurnCount;
    emitVoice(audio, true);
    live.emit({ type: "session.input_transcript.delta", delta: "The station is straight ahead." });
    live.emit({ type: "session.output_transcript.delta", delta: " I want to walk there." });
    expect(controller.session.recentTurns.find(t => t.id === aId)).toMatchObject({ speaker: "A",
      translatedText: undefined });
    expect(controller.session.activeTurn?.translatedText).toBeUndefined();
    expect(controller.captionBlocks.filter(block => block.kind === "output").map(block => block.text))
      .toEqual(["Where is the train station?", " I want to walk there."]);
    expect(controller.session.pendingTurns?.filter(turn => turn.translationOnly).at(-1)?.translatedText).toBe(" I want to walk there.");
    expect(controller.metrics.snapshot().textOnlyCompletedTurnCount).toBe(before);
  });

  it("does not count interrupted A audio as a delivered B or A audio turn", async () => {
    const { controller, live, audio } = await startRussianEnglish();
    Object.defineProperty(audio.audioElement, "muted", { value: false, writable: true });
    emitVoice(audio, true);
    live.emit({ type: "session.input_transcript.delta", delta: "Подскажите, где находится вокзал?", start_ms: 0, end_ms: 500 });
    live.emit({ type: "session.output_transcript.delta", delta: "Where is the train station?", start_ms: 500, end_ms: 900 });
    emitPlayback(audio, true);
    live.emit({ type: "session.input_transcript.delta", delta: "The station is straight ahead.", start_ms: 1000, end_ms: 1500 });
    live.emit({ type: "session.output_transcript.delta", delta: "Вокзал находится прямо впереди.", start_ms: 1600, end_ms: 1900 });
    emitPlayback(audio, false);
    emitVoice(audio, false);
    await vi.advanceTimersByTimeAsync(runtime.audioStartGraceMs + runtime.captionIdleMs);
    expect(controller.metrics.snapshot().audioCompletedTurnCount).toBe(0);
    expect(controller.metrics.snapshot().textOnlyCompletedTurnCount).toBe(2);
    expect(controller.session.recentTurns).toHaveLength(2);
  });

  it("suspends all pending sources and prevents their old fragment timers from touching resumed speech", async () => {
    const { controller, live, audio, visibility } = await startRussianEnglish();
    emitVoice(audio, true);
    live.emit({ type: "session.input_transcript.delta", delta: "Подскажите, где находится вокзал?" });
    live.emit({ type: "session.input_transcript.delta", delta: "The station is straight ahead." });
    live.emit({ type: "session.input_transcript.delta", delta: "Tha" });
    live.emit({ type: "session.output_transcript.delta", delta: "OK" });
    visibility.hide();
    await flushMicrotasks();
    expect(controller.session.pendingTurns ?? []).toHaveLength(0);
    expect(controller.session.recentTurns.every(turn => turn.status === "discarded")).toBe(true);
    // The ambiguous fragment is retained separately, with no guessed author.
    expect(controller.session.recentTurns.find(turn => turn.originalText === "Tha")?.speaker).toBeUndefined();
    expect(controller.metrics.snapshot().discardedTurnCount).toBe(3);
    visibility.show();
    await vi.advanceTimersByTimeAsync(runtime.captionIdleMs);
    emitVoice(audio, true);
    live.emit({ type: "session.input_transcript.delta", delta: "Я хочу продолжить разговор и узнать дорогу." });
    await vi.advanceTimersByTimeAsync(runtime.captionIdleMs);
    expect(controller.session.activeTurn?.originalText).toBe("Я хочу продолжить разговор и узнать дорогу.");
  });

  it("defers language replacement until every pending source is settled", async () => {
    const { controller, live, audio } = await startRussianEnglish();
    emitVoice(audio, true);
    live.emit({ type: "session.input_transcript.delta", delta: "Подскажите, где находится вокзал?" });
    live.emit({ type: "session.input_transcript.delta", delta: "The station is straight ahead." });
    await controller.changeInterlocutorLanguage("es");
    expect(controller.session.participantB.language).toBe("en");
    live.emit({ type: "session.output_transcript.delta", delta: "Вокзал находится прямо впереди." });
    emitVoice(audio, false);
    await vi.advanceTimersByTimeAsync(runtime.audioStartGraceMs + runtime.captionIdleMs);
    expect(controller.session.activeTurn).toMatchObject({ speaker: "B", translatedText: undefined });
    expect(controller.session.participantB.language).toBe("en");
    live.emit({ type: "session.output_transcript.delta", delta: "Where is the train station?" });
    await vi.advanceTimersByTimeAsync(runtime.noOutputTimeoutMs + runtime.captionIdleMs);
    expect(controller.session.participantB.language).toBe("es");
  });

  it("holds ambiguous source separately, then drops its flush when the session is cancelled", async () => {
    const { controller, live, audio } = await startRussianEnglish();
    emitVoice(audio, true);
    live.emit({ type: "session.input_transcript.delta", delta: "Подскажите, где находится вокзал?" });
    live.emit({ type: "session.input_transcript.delta", delta: "The" });
    expect(controller.session.activeTurn?.originalText).toBe("Подскажите, где находится вокзал?");
    live.emit({ type: "session.output_transcript.delta", delta: "OK" });
    await controller.cancel();
    await vi.advanceTimersByTimeAsync(runtime.captionIdleMs + runtime.noOutputTimeoutMs);
    expect(controller.session.state).toBe("idle");
    expect(controller.session.activeTurn).toBeUndefined();
    expect(controller.session.pendingTurns ?? []).toHaveLength(0);
  });

  it("preserves unfinished same-speaker speech across a pause", async () => {
    const { controller, live, audio } = await startRussianEnglish();
    emitVoice(audio, true);
    live.emit({ type: "session.input_transcript.delta", delta: "Подскажите, где находится вокзал?" });
    const id = controller.session.activeTurn?.id;
    emitVoice(audio, false);
    await vi.advanceTimersByTimeAsync(300);
    emitVoice(audio, true);
    live.emit({ type: "session.input_transcript.delta", delta: " Я хочу дойти туда пешком." });
    expect(controller.session.activeTurn).toMatchObject({ id, speaker: "A",
      originalText: "Подскажите, где находится вокзал? Я хочу дойти туда пешком." });
    expect(controller.session.pendingTurns ?? []).toHaveLength(0);
    expect(live.setInputMuted).not.toHaveBeenCalled();
  });

  it("shows an independently authored translation when A-B-A leaves two plausible A sources", async () => {
    const { controller, live, audio } = await startRussianEnglish();
    emitVoice(audio, true);
    live.emit({ type: "session.input_transcript.delta", delta: "Подскажите, где находится вокзал?" });
    live.emit({ type: "session.input_transcript.delta", delta: "The station is straight ahead." });
    live.emit({ type: "session.input_transcript.delta", delta: "Спасибо, я пойду туда пешком." });
    live.emit({ type: "session.output_transcript.delta", delta: "Thank you, I will walk there." });
    expect(controller.session.activeTurn?.translatedText).toBeUndefined();
    const translation = controller.session.pendingTurns?.find(turn => turn.translationOnly);
    expect(translation).toMatchObject({ speaker: "A", translatedText: "Thank you, I will walk there." });
    emitVoice(audio, false);
    await vi.advanceTimersByTimeAsync(runtime.noOutputTimeoutMs + runtime.captionIdleMs);
    expect(controller.session.recentTurns.find(turn => turn.id === translation?.id)).toMatchObject({ speaker: "A", status: "completed" });
    expect(controller.inputReady).toBe(true);
  });

  it("retains punctuation on its confirmed source and accepts a new source while output is pending", async () => {
    const { controller, live, audio } = await startRussianEnglish();
    emitVoice(audio, true);
    live.emit({ type: "session.input_transcript.delta", delta: "Подскажите, где находится вокзал" });
    live.emit({ type: "session.input_transcript.delta", delta: "? " });
    expect(controller.session.activeTurn?.originalText).toBe("Подскажите, где находится вокзал? ");
    live.emit({ type: "session.output_transcript.delta", delta: "Where is the train station?" });
    emitPlayback(audio, true);
    live.emit({ type: "session.input_transcript.delta", delta: "The station is straight ahead." });
    expect(controller.session.activeTurn?.speaker).toBe("B");
    expect(controller.session.activeTurn?.audioOutputStarted).toBe(false);
    expect(controller.session.pendingTurns?.[0]).toMatchObject({ speaker: "A", audioOutputInterrupted: true });
    expect(live.setInputMuted).not.toHaveBeenCalled();
  });

  it("separates a rapid B reply while A's late translation is still pending", async () => {
    const { controller, live, audio } = await startRussianEnglish();
    emitVoice(audio, true);
    live.emit({ type: "session.input_transcript.delta", delta: "Подскажите, пожалуйста, где находится вокзал?", start_ms: 0, end_ms: 1000 });
    const aId = controller.session.activeTurn?.id;
    await vi.advanceTimersByTimeAsync(100);
    live.emit({ type: "session.input_transcript.delta", delta: "The station is straight ahead.", start_ms: 1100, end_ms: 1600 });
    expect(controller.session.activeTurn).toMatchObject({ speaker: "B", originalText: "The station is straight ahead." });
    expect(controller.session.activeTurn?.id).not.toBe(aId);
    live.emit({ type: "session.output_transcript.delta", delta: "Where is the train station?", start_ms: 1700, end_ms: 2000 });
    expect(controller.session.activeTurn?.translatedText).toBeUndefined();
    expect(controller.session.pendingTurns?.find(t => t.id === aId)?.translatedText).toBeUndefined();
    expect(controller.session.pendingTurns?.find(turn => turn.translationOnly)?.translatedText).toBe("Where is the train station?");
    expect(live.setInputMuted).not.toHaveBeenCalled();
  });

  it("routes timestamped late A speech to A after B has started", async () => {
    const { controller, live, audio } = await startRussianEnglish();
    emitVoice(audio, true);
    live.emit({ type: "session.input_transcript.delta", delta: "Подскажите, где находится вокзал?", start_ms: 0, end_ms: 800 });
    const aId = controller.session.activeTurn?.id;
    live.emit({ type: "session.input_transcript.delta", delta: "The station is straight ahead.", start_ms: 1000, end_ms: 1500 });
    const bId = controller.session.activeTurn?.id;
    live.emit({ type: "session.input_transcript.delta", delta: " Я хочу туда дойти пешком.", start_ms: 810, end_ms: 980 });
    expect(controller.session.activeTurn?.id).toBe(bId);
    expect(controller.session.activeTurn?.originalText).toBe("The station is straight ahead.");
    expect(controller.session.pendingTurns?.find(t => t.id === aId)?.originalText).toBe("Подскажите, где находится вокзал? Я хочу туда дойти пешком.");
  });

  it("leaves provider input control unchanged through quiet, playback and bookkeeping completion", async () => {
    const { controller, live, audio } = createController();
    await enterListening(controller);
    const startupInstructions = live.appendInstructions.mock.calls.length;
    emitVoice(audio, true);
    live.emit({ type: "session.input_transcript.delta", delta: "Hello, where is the nearest train station?" });
    live.emit({ type: "session.output_transcript.delta", delta: "Hola, ¿dónde está la estación?" });
    emitPlayback(audio, true);
    emitVoice(audio, false);
    await flushMicrotasks();
    expect(live.setInputMuted).not.toHaveBeenCalled();
    emitPlayback(audio, false);
    await vi.advanceTimersByTimeAsync(runtime.outputSettleGraceMs + runtime.postSourceOutputGraceMs);
    expect(controller.session.activeTurn).toBeUndefined();
    expect(controller.inputReady).toBe(true);
    expect(live.setInputMuted).not.toHaveBeenCalled();
    expect(live.appendInstructions).toHaveBeenCalledTimes(startupInstructions);
  });
});

describe("buffered playback microphone isolation", () => {
  it("reports input unavailable during playback and its tail, preserves late source text, and still accepts generated output", async () => {
    vi.useFakeTimers();
    vi.spyOn(HTMLMediaElement.prototype, "play").mockResolvedValue(undefined);
    vi.spyOn(HTMLMediaElement.prototype, "pause").mockImplementation(() => {});
    vi.spyOn(HTMLMediaElement.prototype, "load").mockImplementation(() => {});
    const node = Object.assign(new DispatchableAudioNode(), {
      port: { postMessage: vi.fn(), close: vi.fn(), onmessage: null as ((event: MessageEvent) => void) | null },
      onprocessorerror: null,
    });
    const { audio, audioContext, track } = createDispatchableAudio(undefined, () => node as unknown as AudioWorkletNode);
    const playbackTrack = new DispatchableMicTrack();
    Object.assign(audioContext, {
      audioWorklet: { addModule: vi.fn(async () => {}) },
      createMediaStreamDestination: () => ({ stream: {
        getTracks: () => [playbackTrack], getAudioTracks: () => [playbackTrack],
      } as unknown as MediaStream }),
    });
    const { controller, live } = createController({ audio });
    try {
      await controller.startWithLanguages({ A: "ru", B: "en" });
      controller.handleRemoteStream(audio.getCaptureStream()!, live as unknown as LiveClient);
      await flushMicrotasks();
      emitVoice(audio, true);
      live.emit({ type: "session.input_transcript.delta", delta: "Подскажите, где находится вокзал?" });
      emitVoice(audio, false);
      expect(controller.inputReady).toBe(true);
      const changed = vi.fn(); const unsubscribe = controller.subscribe(changed);
      const generation = node.port.postMessage.mock.calls.filter(([m]) => m.generation !== undefined).at(-1)![0].generation;
      node.port.onmessage!({ data: { type: "playback", value: true, requestId: 1, generation } } as MessageEvent);
      expect(track.enabled).toBe(false); expect(controller.inputReady).toBe(false);
      expect(controller.playbackInputState).toBe("playing");
      expect(changed).toHaveBeenCalled();
      emitVoice(audio, true);
      expect(controller.session.activeTurn?.sourceIdleAtMs).toBeDefined();
      // Transcripts of audio sent before closure can arrive late and must not be dropped.
      live.emit({ type: "session.input_transcript.delta", delta: " Я хочу туда дойти пешком." });
      live.emit({ type: "session.output_transcript.delta", delta: "Where is the train station?" });
      expect(controller.captionBlocks.some(block => block.text.includes("пешком"))).toBe(true);
      expect(controller.captionBlocks.some(block => block.text.includes("train station"))).toBe(true);
      node.port.onmessage!({ data: { type: "playback", value: false, requestId: 1, generation } } as MessageEvent);
      expect(controller.playbackInputState).toBe("tail");
      await vi.advanceTimersByTimeAsync(runtime.playbackEchoTailMs - 1);
      expect(controller.inputReady).toBe(false);
      await vi.advanceTimersByTimeAsync(1);
      expect(track.enabled).toBe(true); expect(controller.inputReady).toBe(true);
      expect(controller.playbackInputState).toBe("idle");
      unsubscribe();
    } finally { await controller.endConversation(); audio.dispose(); }
  });
});

describe("stage 4 product retirement safety", () => {
  it.each(["endConversation", "cancel"] as const)("%s closes capture before awaiting the provider", async operation => {
    const { controller, live, audio } = createController();
    await controller.startContextCapture();
    let resolve!: (result: { finalized: boolean }) => void;
    live.close.mockImplementationOnce(() => new Promise(r => { resolve = r; }));
    const retiring = controller[operation]();
    expect(audio.captureTrack.enabled).toBe(false);
    expect(audio.getCaptureStream()).toBeNull();
    expect(audio.setOutputAudible).toHaveBeenLastCalledWith(false);
    resolve({ finalized: true }); await retiring;
    expect(controller.session.state).toBe("idle");
  });
  it("A4.3 concurrent End and cancel share retirement and cannot reset a newer client", async () => {
    const first = new FakeLive(), next = new FakeLive();
    const { controller } = createController({ lives: [first, next] }); await controller.startContextCapture();
    let resolve!: (value: { finalized: boolean }) => void;
    first.close.mockImplementation(() => new Promise(r => { resolve = r; }));
    const end = controller.endConversation(), cancel = controller.cancel();
    expect(first.close).toHaveBeenCalledTimes(1);
    resolve({ finalized: true }); await Promise.all([end, cancel]);
    await controller.startContextCapture(); expect(next.connect).toHaveBeenCalledTimes(1);
  });
  it("A4.4 rejects a late old source before attaching it to the audio element", async () => {
    const first = new FakeLive(), second = new FakeLive();
    const { controller, audio } = createController({ lives: [first, second] });
    await controller.startBootstrap(); await controller.startBootstrap();
    const attach = controller.handleRemoteStream.bind(controller) as (stream: MediaStream, source: LiveClient) => void;
    attach(fakeRemoteStream("stale"), first as unknown as LiveClient);
    expect(audio.attachRemoteStream).not.toHaveBeenCalled();
    const stream = fakeRemoteStream("current");
    attach(stream, second as unknown as LiveClient);
    expect(audio.attachRemoteStream).toHaveBeenCalledExactlyOnceWith(stream);
  });
  it("A4.3 a synchronous ending subscriber cannot start a second terminal operation", async () => {
    const { controller, live } = createController(); await controller.startContextCapture();
    const cancellation: Promise<void>[] = [];
    controller.subscribe(() => {
      if (controller.session.state === "ending" && cancellation.length === 0) {
        cancellation.push(Promise.resolve()); // Guard the observer itself against recursion.
        cancellation.push(controller.cancel());
      }
    });
    await controller.endConversation(); await Promise.all(cancellation);
    expect(live.close).toHaveBeenCalledTimes(1); expect(controller.session.state).toBe("idle");
  });

  it("A4.3 cancel during replacement joins retirement of the old usable client", async () => {
    const old = new FakeLive(), unused = new FakeLive(), next = new FakeLive();
    const { controller, audio } = createController({ lives: [old, unused, next] });
    await controller.startBootstrap();
    let resolve!: (value: { finalized: boolean }) => void;
    const oldClose = new Promise<{ finalized: boolean }>(r => { resolve = r; });
    old.close.mockReturnValue(oldClose);
    const replacement = controller.startBootstrap(); await flushMicrotasks();
    let cancelled = false;
    const cancellation = controller.cancel().then(() => { cancelled = true; });
    await flushMicrotasks(); await flushMicrotasks();
    expect(audio.getCaptureStream()).toBeNull(); expect(unused.connect).not.toHaveBeenCalled();
    expect(cancelled).toBe(false);
    resolve({ finalized: true }); await replacement; await cancellation;
    await controller.startContextCapture(); expect(next.connect).toHaveBeenCalledTimes(1);
  });

  it("A4.3 End accepts finalization from the retiring bootstrap client", async () => {
    const old = new FakeLive(), unused = new FakeLive(), next = new FakeLive();
    const { controller } = createController({ lives: [old, unused, next] });
    await controller.startBootstrap();
    let resolve!: (value: { finalized: boolean }) => void;
    const oldClose = new Promise<{ finalized: boolean }>(r => { resolve = r; });
    old.close.mockReturnValueOnce(oldClose);
    const replacement = controller.startBootstrap(); await flushMicrotasks();
    unused.close.mockResolvedValue({ finalized: false });
    const ending = controller.endConversation();
    await flushMicrotasks(); resolve({ finalized: true });
    await replacement; await ending;
    expect(controller.ownerError).toBeUndefined();
  });

  it.each(["resolve", "reject"] as const)("A4.4 stale play %s cannot change the replacement readiness", async outcome => {
    const old = new FakeLive(), next = new FakeLive();
    const { controller, audio } = createController({ lives: [old, next] }); await controller.startBootstrap();
    let resolve!: () => void, reject!: (error: Error) => void;
    vi.mocked(audio.audioElement.play).mockReturnValueOnce(new Promise<void>((ok, fail) => { resolve = ok; reject = fail; }));
    controller.handleRemoteStream(fakeRemoteStream("old"), old as unknown as LiveClient);
    await controller.startBootstrap();
    controller.handleRemoteStream(fakeRemoteStream("new"), next as unknown as LiveClient);
    await flushMicrotasks();
    const readiness = () => (controller as unknown as { remotePlaybackState: string }).remotePlaybackState;
    expect(readiness()).toBe("ready");
    if (outcome === "resolve") resolve(); else reject(new Error("old play failed"));
    await flushMicrotasks(); expect(readiness()).toBe("ready");
    expect(audio.stopCapture).not.toHaveBeenCalled();
  });

});

describe("PR32 source lifecycle regressions", () => {
  beforeEach(() => { vi.useFakeTimers(); vi.setSystemTime(0); });
  async function setup() {
    const fixture = createController();
    await fixture.controller.startWithLanguages({ A: "ru", B: "en" });
    return fixture;
  }
  it.each([false, true])("preserves A idle after B voice activation, with B quiet before transcript: %s", async quietBeforeTranscript => {
    const {controller,live,audio} = await setup();
    emitVoice(audio,true);
    live.emit({type:"session.input_transcript.delta",delta:"Подскажите, где находится вокзал?"});
    const a = controller.session.activeTurn!.id;
    await vi.advanceTimersByTimeAsync(100);
    emitVoice(audio,false);
    await vi.advanceTimersByTimeAsync(700);
    emitVoice(audio,true);
    await vi.advanceTimersByTimeAsync(4200);
    if (quietBeforeTranscript) emitVoice(audio, false);
    live.emit({type:"session.input_transcript.delta",delta:"The station is straight ahead."});
    expect(controller.session.pendingTurns?.find(t=>t.id===a)?.sourceIdleAtMs).toBe(100);
    await vi.advanceTimersByTimeAsync(100);
    expect(controller.session.recentTurns.find(t => t.id === a)?.status).toBe("failed");
  });
  it("keeps a fresh timed source separate from completed source", async () => {
    const {controller,live,audio} = await setup();
    emitVoice(audio,true);
    live.emit({type:"session.input_transcript.delta",delta:"Подскажите, где находится вокзал?",start_ms:0,end_ms:500});
    const a = controller.session.activeTurn!.id;
    live.emit({type:"session.output_transcript.delta",delta:"Where is the train station?"});
    emitVoice(audio,false);
    await vi.advanceTimersByTimeAsync(runtime.audioStartGraceMs+runtime.captionIdleMs);
    expect(controller.session.recentTurns.find(t=>t.id===a)?.status).toBe("completed");
    emitVoice(audio,true);
    live.emit({type:"session.input_transcript.delta",delta:"Спасибо, я пойду туда пешком.",start_ms:2200,end_ms:2700});
    expect(controller.session.activeTurn?.originalText).toBe("Спасибо, я пойду туда пешком.");
    expect(controller.session.recentTurns.find(t=>t.id===a)?.originalText).toBe("Подскажите, где находится вокзал?");
  });
  it.each([800, 90, 40])("uses the new idle after a confirmed same-speaker continuation starting at %i", async startMs => {
    const { controller, live, audio } = await setup();
    emitVoice(audio, true);
    live.emit({ type: "session.input_transcript.delta", delta: "Подскажите, где находится вокзал?", start_ms: 0, end_ms: 90 });
    const a = controller.session.activeTurn!.id;
    await vi.advanceTimersByTimeAsync(100);
    emitVoice(audio, false);
    await vi.advanceTimersByTimeAsync(700);
    emitVoice(audio, true);
    live.emit({ type: "session.input_transcript.delta", delta: " Я хочу дойти туда пешком.", start_ms: startMs, end_ms: 900 });
    await vi.advanceTimersByTimeAsync(200);
    emitVoice(audio, false);
    await vi.advanceTimersByTimeAsync(100);
    emitVoice(audio, true);
    live.emit({ type: "session.input_transcript.delta", delta: "The station is straight ahead.", start_ms: 1100, end_ms: 1200 });
    expect(controller.session.pendingTurns?.find(t => t.id === a)?.sourceIdleAtMs).toBe(1000);
  });
  it("retains genuine timed corrections while a fresh source is still empty", async () => {
    const { controller, live, audio } = await setup();
    emitVoice(audio, true);
    live.emit({ type: "session.input_transcript.delta", delta: "Подскажите, где находится вокзал?", start_ms: 0, end_ms: 500 });
    const a = controller.session.activeTurn!.id;
    live.emit({ type: "session.output_transcript.delta", delta: "Where is the train station?" });
    emitVoice(audio, false);
    await vi.advanceTimersByTimeAsync(runtime.audioStartGraceMs + runtime.captionIdleMs);
    emitVoice(audio, true);
    const next = controller.session.activeTurn!.id;
    live.emit({ type: "session.input_transcript.delta", delta: " Мне нужна информация.", start_ms: 400, end_ms: 500 });
    expect(controller.session.recentTurns.find(t => t.id === a)?.originalText).toContain("Мне нужна информация.");
    expect(controller.session.activeTurn).toMatchObject({ id: next, originalText: "" });
    live.emit({ type: "session.input_transcript.delta", delta: "Спасибо, я пойду туда пешком.", start_ms: 2200, end_ms: 2700 });
    expect(controller.session.activeTurn).toMatchObject({ id: next, originalText: "Спасибо, я пойду туда пешком." });
  });
  it("does not treat a late correction as confirmation that A resumed speaking", async () => {
    const { controller, live, audio } = await setup();
    emitVoice(audio, true);
    live.emit({ type: "session.input_transcript.delta", delta: "Подскажите, где находится вокзал?", start_ms: 0, end_ms: 90 });
    const a = controller.session.activeTurn!.id;
    await vi.advanceTimersByTimeAsync(100);
    emitVoice(audio, false);
    await vi.advanceTimersByTimeAsync(700);
    emitVoice(audio, true);
    live.emit({ type: "session.input_transcript.delta", delta: " Мне нужна информация.", start_ms: 40, end_ms: 80 });
    await vi.advanceTimersByTimeAsync(200);
    live.emit({ type: "session.input_transcript.delta", delta: "The station is straight ahead.", start_ms: 800, end_ms: 1000 });
    expect(controller.session.pendingTurns?.find(t => t.id === a)?.sourceIdleAtMs).toBe(100);
  });
  it("retains an equal-timestamp correction without end_ms after a new VAD activation", async () => {
    const { controller, live, audio } = await setup();
    emitVoice(audio, true);
    live.emit({ type: "session.input_transcript.delta", delta: "Подскажите, где находится вокзал?", start_ms: 0 });
    const a = controller.session.activeTurn!.id;
    live.emit({ type: "session.output_transcript.delta", delta: "Where is the train station?" });
    emitVoice(audio, false);
    await vi.advanceTimersByTimeAsync(runtime.audioStartGraceMs + runtime.captionIdleMs);
    emitVoice(audio, true);
    live.emit({ type: "session.input_transcript.delta", delta: " Мне нужна информация.", start_ms: 0 });
    expect(controller.session.recentTurns.find(t => t.id === a)?.originalText).toContain("Мне нужна информация.");
    expect(controller.session.activeTurn?.originalText).toBe("");
  });
  it("keeps pending deadlines armed after B reactivation", async () => {
    const {controller,live,audio} = await setup();
    emitVoice(audio,true);
    live.emit({type:"session.input_transcript.delta",delta:"Подскажите, где находится вокзал?"});
    const a = controller.session.activeTurn!.id;
    await vi.advanceTimersByTimeAsync(100);
    live.emit({type:"session.input_transcript.delta",delta:"The station is straight ahead."});
    emitVoice(audio,false);
    await vi.advanceTimersByTimeAsync(1000);
    expect(controller.session.pendingTurns?.find(t=>t.id===a)?.sourceIdleAtMs).toBe(100);
    emitVoice(audio,true);
    await vi.advanceTimersByTimeAsync(5000);
    expect(controller.session.recentTurns.find(t=>t.id===a)?.status).toBe("failed");
  });
  it("preserves unknown source during gapless handoff", async () => {
    const {controller,live,audio} = await setup();
    emitVoice(audio,true);
    live.emit({type:"session.input_transcript.delta",delta:"Γειά σας, ποιος είναι ο δρόμος;"});
    await vi.advanceTimersByTimeAsync(runtime.captionIdleMs);
    expect(controller.session.activeTurn?.speaker).toBeUndefined();
    live.emit({type:"session.input_transcript.delta",delta:"The station is straight ahead."});
    expect(controller.session.activeTurn?.originalText).toBe("The station is straight ahead.");
    expect(controller.session.pendingTurns).toEqual(expect.arrayContaining([expect.objectContaining({speaker:undefined,originalText:"Γειά σας, ποιος είναι ο δρόμος;"})]));
  });
});

describe("PR32 playback completion regression", () => {
  beforeEach(() => { vi.useFakeTimers(); vi.setSystemTime(0); });
  it("does not complete B while unattributed audio is playing", async () => {
    const {controller,live,audio} = createController();
    await controller.startWithLanguages({A:"ru",B:"en"});

    emitVoice(audio, true);
    live.emit({type:"session.input_transcript.delta",delta:"Подскажите, где находится вокзал?",start_ms:0,end_ms:500});
    live.emit({type:"session.output_transcript.delta",delta:"Where is the train station?",start_ms:600,end_ms:900});
    emitVoice(audio,false);
    await vi.advanceTimersByTimeAsync(runtime.audioStartGraceMs+runtime.captionIdleMs);
    expect(controller.session.activeTurn).toBeUndefined();
    emitVoice(audio, true);
    live.emit({type:"session.input_transcript.delta",delta:"The station is straight ahead.",start_ms:1000,end_ms:1500});
    const b = controller.session.activeTurn!.id;
    live.setInputMuted.mockClear();
    emitPlayback(audio,true);
    live.emit({type:"session.output_transcript.delta",delta:"Вокзал находится прямо впереди.",start_ms:1600,end_ms:1900});
    emitVoice(audio,false);
    await vi.advanceTimersByTimeAsync(runtime.audioStartGraceMs+runtime.captionIdleMs);
    expect(controller.session.recentTurns.find(t=>t.id===b)?.status).not.toBe("completed");
    expect(controller.session.activeTurn?.id).toBe(b);
    await controller.changeInterlocutorLanguage("de");
    expect(controller.session.participantB.language).toBe("en");
    expect(live.setInputMuted).not.toHaveBeenCalledWith(true);
    emitPlayback(audio, false);
    await flushMicrotasks();
    expect(controller.session.recentTurns.find(t => t.id === b)?.status).toBe("completed");
    expect(controller.session.participantB.language).toBe("de");
  });
  it("queues language changes during unattributed audio even without any source turn", async () => {
    const { controller, live, audio } = createController();
    await controller.startWithLanguages({ A: "ru", B: "en" });
    live.setInputMuted.mockClear();
    emitPlayback(audio, true);
    await controller.changeInterlocutorLanguage("de");
    expect(controller.session.participantB.language).toBe("en");
    expect(live.setInputMuted).not.toHaveBeenCalledWith(true);
    emitPlayback(audio, false);
    await flushMicrotasks();
    expect(controller.session.participantB.language).toBe("de");
  });
});

describe("PR32 timestamp routing follow-up", () => {
  beforeEach(() => { vi.useFakeTimers(); vi.setSystemTime(0); });
  it.each(["transcript-first", "buffered-correction", "untimed-prefix"])("separates fresh speech: %s", async scenario => {
    const { controller, live, audio } = createController();
    await controller.startWithLanguages({ A: "ru", B: "en" });
    emitVoice(audio, true);
    live.emit({ type: "session.input_transcript.delta", delta: "Подскажите, где находится вокзал?", start_ms: 0, end_ms: 500 });
    const a = controller.session.activeTurn!.id;
    live.emit({ type: "session.output_transcript.delta", delta: "Where is the train station?" });
    emitVoice(audio, false);
    await vi.advanceTimersByTimeAsync(runtime.audioStartGraceMs + runtime.captionIdleMs);
    expect(controller.session.recentTurns.find(t=>t.id===a)?.status).toBe("completed");
    if (scenario === "buffered-correction") {
      emitVoice(audio, true);
      live.emit({ type: "session.input_transcript.delta", delta: ", ", start_ms: 400, end_ms: 500 });
    }
    if (scenario === "untimed-prefix") live.emit({ type: "session.input_transcript.delta", delta: "12, " });
    live.emit({ type: "session.input_transcript.delta", delta: "Спасибо, я пойду туда пешком.", start_ms: 2200, end_ms: 2700 });
    expect(controller.session.activeTurn?.originalText).toBe((scenario === "untimed-prefix" ? "12, " : "") + "Спасибо, я пойду туда пешком.");
    expect(controller.session.recentTurns.find(t=>t.id===a)?.originalText).not.toContain("Спасибо");
  });
});

describe("PR32 neutral fragment ownership", () => {
  beforeEach(() => { vi.useFakeTimers(); vi.setSystemTime(0); });
  it("retains neutral corrections inside a bounded historical interval beyond its last observed packet", async () => {
    const { controller, live, audio } = createController();
    await controller.startWithLanguages({ A: "ru", B: "en" });
    emitVoice(audio, true);
    live.emit({ type: "session.input_transcript.delta", delta: "Подскажите, где находится вокзал?", start_ms: 0, end_ms: 500 });
    const previous = controller.session.activeTurn!.id;
    live.emit({ type: "session.output_transcript.delta", delta: "Where is the train station?" });
    emitVoice(audio, false);
    await vi.advanceTimersByTimeAsync(runtime.audioStartGraceMs + runtime.captionIdleMs);
    emitVoice(audio, true);
    live.emit({ type: "session.input_transcript.delta", delta: "The station is straight ahead.", start_ms: 1000, end_ms: 1500 });
    const current = controller.session.activeTurn!.id;
    live.emit({ type: "session.input_transcript.delta", delta: ", ", start_ms: 850, end_ms: 900 });
    live.emit({ type: "session.input_transcript.delta", delta: "Мне нужна информация.", start_ms: 900, end_ms: 980 });
    expect(controller.session.activeTurn?.id).toBe(current);
    expect(controller.session.recentTurns.find(turn => turn.id === previous)).toMatchObject({
      originalText: "Подскажите, где находится вокзал?, Мне нужна информация.", sourceEndMs: 1000,
    });
  });
  it("does not treat neutral correction as resumed speech without end timestamps", async () => {
    const { controller, live, audio } = createController();
    await controller.startWithLanguages({ A: "ru", B: "en" });
    emitVoice(audio, true);
    live.emit({ type: "session.input_transcript.delta", delta: "Подскажите, где находится вокзал?", start_ms: 0 });
    const previous = controller.session.activeTurn!.id;
    await vi.advanceTimersByTimeAsync(100);
    emitVoice(audio, false);
    await vi.advanceTimersByTimeAsync(100);
    emitVoice(audio, true);
    live.emit({ type: "session.input_transcript.delta", delta: ", ", start_ms: 0 });
    live.emit({ type: "session.input_transcript.delta", delta: "The station is straight ahead.", start_ms: 2200, end_ms: 2700 });
    expect(controller.session.pendingTurns?.find(turn => turn.id === previous)?.sourceIdleAtMs).toBe(100);
  });
  it.each([
    ["ru", "en", ", "], ["en", "ru", ", "],
    ["ru", "en", "12, "], ["en", "ru", "12, "],
  ])("keeps delayed neutral %s→%s packet %s with its historical source", async (firstLanguage, nextLanguage, neutral) => {
    const phrase = { ru: "Подскажите, где находится вокзал?", en: "The station is straight ahead." };
    const correction = { ru: " Мне нужна информация.", en: " Please check the information." };
    const original = phrase[firstLanguage as keyof typeof phrase];
    const next = phrase[nextLanguage as keyof typeof phrase];
    const late = correction[firstLanguage as keyof typeof correction];
    const { controller, live, audio } = createController();
    await controller.startWithLanguages({ A: "ru", B: "en" });
    emitVoice(audio, true);
    live.emit({ type: "session.input_transcript.delta", delta: original, start_ms: 0, end_ms: 500 });
    const previous = controller.session.activeTurn!.id;
    live.emit({ type: "session.output_transcript.delta", delta: next });
    emitVoice(audio, false);
    await vi.advanceTimersByTimeAsync(runtime.audioStartGraceMs + runtime.captionIdleMs);
    expect(controller.session.recentTurns.find(turn => turn.id === previous)?.status).toBe("completed");
    emitVoice(audio, true);
    const current = controller.session.activeTurn!.id;
    live.emit({ type: "session.input_transcript.delta", delta: neutral, start_ms: 400, end_ms: 500 });
    live.emit({ type: "session.input_transcript.delta", delta: next, start_ms: 2200, end_ms: 2700 });
    expect(controller.session.activeTurn).toMatchObject({ id: current, originalText: next, speaker: nextLanguage === "ru" ? "A" : "B" });
    expect(controller.session.recentTurns.find(turn => turn.id === previous)).toMatchObject({ originalText: original + neutral, sourceEndMs: 2200 });
    live.emit({ type: "session.input_transcript.delta", delta: late, start_ms: 450, end_ms: 500 });
    expect(controller.session.activeTurn).toMatchObject({ id: current, originalText: next });
    expect(controller.session.recentTurns.find(turn => turn.id === previous)?.originalText).toBe(original + neutral + late);
  });
  it.each([undefined, 2100])("keeps a new neutral prefix with new speech when its timestamp is %s", async startMs => {
    const { controller, live, audio } = createController();
    await controller.startWithLanguages({ A: "ru", B: "en" });
    emitVoice(audio, true);
    live.emit({ type: "session.input_transcript.delta", delta: "Подскажите, где находится вокзал?", start_ms: 0, end_ms: 500 });
    const previous = controller.session.activeTurn!.id;
    live.emit({ type: "session.output_transcript.delta", delta: "Where is the train station?" });
    emitVoice(audio, false);
    await vi.advanceTimersByTimeAsync(runtime.audioStartGraceMs + runtime.captionIdleMs);
    emitVoice(audio, true);
    live.emit({ type: "session.input_transcript.delta", delta: "12, ", ...(startMs === undefined ? {} : { start_ms: startMs, end_ms: 2150 }) });
    live.emit({ type: "session.input_transcript.delta", delta: "The station is straight ahead.", start_ms: 2200, end_ms: 2700 });
    expect(controller.session.activeTurn).toMatchObject({ originalText: "12, The station is straight ahead.", speaker: "B" });
    expect(controller.session.recentTurns.find(turn => turn.id === previous)?.originalText).toBe("Подскажите, где находится вокзал?");
  });
});

it.each([["Я использую ", "Google."], ["Наш новый офис теперь находится в ", "New York."]])("preserves foreign name continuation: %s%s", async (opening, name) => {
  vi.useFakeTimers(); vi.setSystemTime(0);
  const { controller, live, audio } = createController();
  await controller.startWithLanguages({ A: "ru", B: "en" });
  emitVoice(audio, true);
  live.emit({ type: "session.input_transcript.delta", delta: opening });
  const original = controller.session.activeTurn!.id;
  for (const character of name) live.emit({ type: "session.input_transcript.delta", delta: character });
  expect(controller.session.activeTurn).toMatchObject({ id: original, speaker: "A", originalText: opening + name });
});

it("retains packet-local short replies after a completed opposite-language source", async () => {
  vi.useFakeTimers(); vi.setSystemTime(0);
  const { controller, live, audio } = createController();
  await controller.startWithLanguages({ A: "ru", B: "en" });
  emitVoice(audio, true);
  live.emit({ type: "session.input_transcript.delta", delta: "The station is straight ahead." });
  const original = controller.session.activeTurn!.id;
  live.emit({ type: "session.input_transcript.delta", delta: "Привет." });
  expect(controller.session.activeTurn?.id).not.toBe(original);
  expect(controller.session.activeTurn).toMatchObject({ speaker: "A", originalText: "Привет." });
});

describe("PR32 untimed source openings", () => {
  beforeEach(() => { vi.useFakeTimers(); vi.setSystemTime(0); });
  it.each(["completed", "pending"])("routes late corrections to a %s source with an untimed prefix", async status => {
    const { controller, live, audio } = createController();
    await controller.startWithLanguages({ A: "ru", B: "en" });
    emitVoice(audio, true);
    live.emit({ type: "session.input_transcript.delta", delta: "12, " });
    live.emit({ type: "session.input_transcript.delta", delta: "Подскажите, где находится вокзал?", start_ms: 0, end_ms: 800 });
    const a = controller.session.activeTurn!.id;
    if (status === "completed") {
      live.emit({ type: "session.output_transcript.delta", delta: "Where is the train station?" });
      emitVoice(audio, false);
      await vi.advanceTimersByTimeAsync(runtime.audioStartGraceMs + runtime.captionIdleMs);
      expect(controller.session.recentTurns.find(turn => turn.id === a)?.status).toBe("completed");
      emitVoice(audio, true);
    }
    live.emit({ type: "session.input_transcript.delta", delta: "The station is straight ahead.", start_ms: 1000, end_ms: 1500 });
    const b = controller.session.activeTurn!.id;
    live.emit({ type: "session.output_transcript.delta", delta: "Вокзал находится прямо впереди." });
    emitPlayback(audio, true);
    live.emit({ type: "session.input_transcript.delta", delta: " Мне нужна информация.", start_ms: 400, end_ms: 600 });
    expect(controller.session.activeTurn).toMatchObject({ id: b, speaker: "B", originalText: "The station is straight ahead." });
    expect(controller.session.activeTurn?.audioOutputInterrupted).not.toBe(true);
    const historical = [...controller.session.recentTurns, ...(controller.session.pendingTurns ?? [])].find(turn => turn.id === a);
    expect(historical).toMatchObject({ originalText: "12, Подскажите, где находится вокзал? Мне нужна информация.", sourceEndMs: 1000 });
  });
});

describe("PR32 output sentence context", () => {
  beforeEach(() => { vi.useFakeTimers(); vi.setSystemTime(0); });
  it.each([0, 900])("retains a translated foreign brand after a %i ms caption gap", async gap => {
    const { controller, live, audio } = createController();
    await controller.startWithLanguages({ A: "ru", B: "en" });
    emitVoice(audio, true);
    live.emit({ type: "session.input_transcript.delta", delta: "I use Google every day." });
    const b = controller.session.activeTurn!.id;
    live.emit({ type: "session.output_transcript.delta", delta: "Я использую " });
    emitPlayback(audio, true);
    await vi.advanceTimersByTimeAsync(gap);
    live.emit({ type: "session.output_transcript.delta", delta: "Google." });
    expect(controller.session.activeTurn).toMatchObject({ id: b, translatedText: "Я использую Google." });
    expect(controller.session.recentTurns.filter(turn => turn.translationOnly)).toHaveLength(0);
    expect(controller.session.pendingTurns?.filter(turn => turn.translationOnly) ?? []).toHaveLength(0);
  });
});

describe("PR32 output context boundaries", () => {
  beforeEach(() => { vi.useFakeTimers(); vi.setSystemTime(0); });
  it.each(["new sentence", "older timestamp"])("does not absorb English output with %s into Russian context", async kind => {
    const { controller, live, audio } = createController();
    await controller.startWithLanguages({ A: "ru", B: "en" });
    emitVoice(audio, true);
    live.emit({ type: "session.input_transcript.delta", delta: "Я использую Google." });
    const a = controller.session.activeTurn!.id;
    live.emit({ type: "session.input_transcript.delta", delta: "I also use Google." });
    const b = controller.session.activeTurn!.id;
    const russian = kind === "new sentence" ? "Я тоже использую Google." : "Я тоже использую ";
    live.emit({ type: "session.output_transcript.delta", delta: russian, start_ms: 2000, end_ms: 2500 });
    live.emit({ type: "session.output_transcript.delta", delta: "Google.", start_ms: kind === "new sentence" ? 3000 : 1000, end_ms: kind === "new sentence" ? 3500 : 1500 });
    expect(controller.session.activeTurn).toMatchObject({ id: b, translatedText: undefined });
    expect(controller.session.pendingTurns?.find(turn => turn.id === a)?.translatedText).toBeUndefined();
    expect(controller.session.pendingTurns?.filter(turn => turn.translationOnly).map(turn => turn.translatedText)).toEqual([russian, "Google."]);
  });
});

it("does not borrow a completed output sentence for a new source's short translation", async () => {
  vi.useFakeTimers(); vi.setSystemTime(0);
  const { controller, live, audio } = createController();
  await controller.startWithLanguages({ A: "ru", B: "en" });

  emitVoice(audio, true);
  live.emit({ type: "session.input_transcript.delta", delta: "I use Google every day.", start_ms: 0, end_ms: 100 });
  const b = controller.session.activeTurn!.id;
  live.emit({ type: "session.output_transcript.delta", delta: "Я использую ", start_ms: 0, end_ms: 500 });
  emitVoice(audio, false);
  await vi.advanceTimersByTimeAsync(runtime.audioStartGraceMs + runtime.captionIdleMs);
  expect(controller.session.recentTurns.find(turn => turn.id === b)?.status).toBe("completed");
  emitVoice(audio, true);
  live.emit({ type: "session.input_transcript.delta", delta: "Гугл.", start_ms: 600, end_ms: 900 });
  const a = controller.session.activeTurn!.id;
  live.emit({ type: "session.output_transcript.delta", delta: "Google.", start_ms: 1000, end_ms: 1500 });
  expect(controller.session.activeTurn).toMatchObject({ id: a, speaker: "A", translatedText: "Google." });
  expect(controller.session.recentTurns.find(turn => turn.id === b)?.translatedText).toBe("Я использую ");
});

describe("PR32 pending-source ownership", () => {
  beforeEach(() => { vi.useFakeTimers(); vi.setSystemTime(0); });
  it.each([0, 250])("preserves old idle only for already observed text at %i without end_ms", async correctionStart => {
    const { controller, live, audio } = createController();
    await controller.startWithLanguages({ A: "ru", B: "en" });
    emitVoice(audio, true);
    live.emit({ type: "session.input_transcript.delta", delta: "Подскажите, где находится вокзал?", start_ms: 0 });
    const a = controller.session.activeTurn!.id;
    await vi.advanceTimersByTimeAsync(100); emitVoice(audio, false);
    await vi.advanceTimersByTimeAsync(100); emitVoice(audio, true);
    await vi.advanceTimersByTimeAsync(100);
    live.emit({ type: "session.input_transcript.delta", delta: " Мне нужна информация.", start_ms: correctionStart });
    await vi.advanceTimersByTimeAsync(4700);
    live.emit({ type: "session.input_transcript.delta", delta: "The station is straight ahead.", start_ms: 4500, end_ms: 5000 });
    expect(controller.session.pendingTurns?.find(turn => turn.id === a)?.sourceIdleAtMs).toBe(correctionStart === 0 ? 100 : 5000);
    await vi.advanceTimersByTimeAsync(100);
    expect(controller.session.recentTurns.find(turn => turn.id === a)?.status).toBe(correctionStart === 0 ? "failed" : undefined);
  });
  it.each([undefined, 1000, "late correction"])("uses output interval evidence instead of ASR to separate Google at %s", async timestamp => {
    const { controller, live, audio } = createController();
    await controller.startWithLanguages({ A: "ru", B: "en" });
    emitVoice(audio, true);
    live.emit({ type: "session.input_transcript.delta", delta: "I use Google every day.", start_ms: 0, end_ms: 500 });
    const b = controller.session.activeTurn!.id;
    live.emit({ type: "session.output_transcript.delta", delta: "Я использую ", start_ms: 0, end_ms: 500 });
    live.emit({ type: "session.input_transcript.delta", delta: "Гугл.", start_ms: 600, end_ms: 900 });
    const a = controller.session.activeTurn!.id;
    if (timestamp === "late correction") live.emit({ type: "session.output_transcript.delta", delta: "Каждый день я использую ", start_ms: 100, end_ms: 400 });
    live.emit({ type: "session.output_transcript.delta", delta: "Google.", start_ms: typeof timestamp === "number" ? timestamp : undefined });
    const disjoint = typeof timestamp === "number";
    expect(controller.session.activeTurn).toMatchObject({ id: a, speaker: "A", translatedText: disjoint ? "Google." : undefined });
    expect(controller.session.pendingTurns?.find(turn => turn.id === b)?.translatedText).toBe(disjoint ? "Я использую " : undefined);
    expect(controller.captionBlocks.filter(block => block.kind === "output").map(block => block.text)).toEqual(disjoint
      ? ["Я использую ", "Google."]
      : [timestamp === "late correction" ? "Я использую Каждый день я использую Google." : "Я использую Google."]);
    expect(controller.currentAttribution).toMatchObject({ matchedTextOutputs: disjoint ? 2 : 0, unattributedTextOutputs: disjoint ? 0 : 1 });
  });
  it.each([false, true])("keeps audio before B's caption unattributed when A is still pending, owned=%s", async owned => {
    const { controller, live, audio } = createController();
    await controller.startWithLanguages({ A: "ru", B: "en" });
    emitVoice(audio, true);
    live.emit({ type: "session.input_transcript.delta", delta: "Подскажите, где находится вокзал?", start_ms: 0, end_ms: 500 });
    const a = controller.session.activeTurn!.id;
    live.emit({ type: "session.output_transcript.delta", delta: "Where is the train station?", start_ms: 500, end_ms: 900 });
    live.emit({ type: "session.input_transcript.delta", delta: "The station is straight ahead.", start_ms: 1000, end_ms: 1500 });
    const b = controller.session.activeTurn!.id;
    const activity = { active: true, atMs: Date.now(), owned };
    audio.onPlaybackActivity?.(activity);
    live.emit({ type: "session.output_transcript.delta", delta: "Вокзал находится прямо впереди.", start_ms: 1600, end_ms: 1900 });
    emitVoice(audio, false);
    await vi.advanceTimersByTimeAsync(runtime.audioStartGraceMs + runtime.captionIdleMs);
    expect(controller.session.activeTurn?.id).toBe(b);
    expect(controller.session.activeTurn?.audioOutputStarted).toBe(false);
    expect(controller.session.pendingTurns?.find(turn => turn.id === a)?.audioOutputStarted).toBe(false);
    expect(controller.session.pendingTurns?.find(turn => turn.id === a)?.firstAudibleOutputAtMs).toBeUndefined();
    emitPlayback(audio, false);
    await vi.advanceTimersByTimeAsync(runtime.postSourceOutputGraceMs + runtime.captionIdleMs);
    expect(controller.session.recentTurns.find(turn => turn.id === b)?.status).toBe("completed");
  });
  it.each([
    ["Подскажите, пожалуйста, где находится ", "No.", "A", "B"],
    ["Подскажите, пожалуйста, где находится ", "Yes.", "A", "B"],
    ["Подскажите, пожалуйста, где находится ", "Stop.", "A", "B"],
    ["The station is straight ahead and ", "Нет.", "B", "A"],
  ])("shows interruption separately from unfinished speech: %s%s", async (opening, reply, first, second) => {
    const { controller, live, audio } = createController();
    await controller.startWithLanguages({ A: "ru", B: "en" });
    emitVoice(audio, true);
    live.emit({ type: "session.input_transcript.delta", delta: opening });
    live.emit({ type: "session.input_transcript.delta", delta: reply });
    expect(controller.session.activeTurn).toMatchObject({ speaker: second, originalText: reply });
    expect(controller.captionBlocks.map(block => ({ side: block.side, text: block.text.trim() }))).toEqual([
      { side: first, text: opening.trim() }, { side: second, text: reply },
    ]);
  });
});

it.each([0, runtime.noOutputTimeoutMs])("preserves standalone output context after a %i ms gap without a new source", async gap => {
  vi.useFakeTimers(); vi.setSystemTime(0);
  const { controller, live, audio } = createController();
  await controller.startWithLanguages({ A: "ru", B: "en" });
  emitVoice(audio, true);
  live.emit({ type: "session.input_transcript.delta", delta: "I use Google every day." });
  live.emit({ type: "session.input_transcript.delta", delta: "Я тоже использую Гугл." });
  const a = controller.session.activeTurn!.id;
  live.emit({ type: "session.input_transcript.delta", delta: "I use it for work too." });
  live.emit({ type: "session.output_transcript.delta", delta: "Я использую " });
  const standalone = controller.session.pendingTurns?.find(turn => turn.translationOnly)?.id;
  expect(standalone).toBeDefined();
  emitVoice(audio, false);
  emitPlayback(audio, true);
  await vi.advanceTimersByTimeAsync(gap);
  if (gap) expect(controller.session.activeTurn).toBeUndefined();
  live.emit({ type: "session.output_transcript.delta", delta: "Google." });
  expect(controller.session.pendingTurns?.find(turn => turn.id === standalone)).toMatchObject({
    speaker: "B", translatedText: "Я использую Google.", audioOutputStarted: true,
  });
  expect(controller.session.pendingTurns?.find(turn => turn.id === a)?.translatedText).toBeUndefined();
});

it.each([false, true])("requires disjoint output intervals to separate an unfinished same-language output, timed=%s", async timed => {
  vi.useFakeTimers(); vi.setSystemTime(0);
  const { controller, live, audio } = createController();
  await controller.startWithLanguages({ A: "ru", B: "en" });
  emitVoice(audio, true);
  for (const delta of ["I use Google every day.", "Я тоже использую Гугл.", "I use it for work too."])
    live.emit({ type: "session.input_transcript.delta", delta });
  live.emit({ type: "session.output_transcript.delta", delta: "Я использую ", ...(timed ? { start_ms: 100, end_ms: 200 } : {}) });
  const standalone = controller.session.pendingTurns?.find(turn => turn.translationOnly)?.id;
  for (const delta of ["Подскажите, где находится вокзал?", "The station is straight ahead."])
    live.emit({ type: "session.input_transcript.delta", delta });
  live.emit({ type: "session.output_transcript.delta", delta: "Вокзал находится прямо впереди.", ...(timed ? { start_ms: 300, end_ms: 400 } : {}) });
  expect(controller.session.pendingTurns?.find(turn => turn.id === standalone)?.translatedText).toBe(timed ? "Я использую " : "Я использую Вокзал находится прямо впереди.");
  expect(controller.session.pendingTurns?.filter(turn => turn.translationOnly).map(turn => turn.translatedText)).toEqual(timed ? ["Я использую ", "Вокзал находится прямо впереди."] : ["Я использую Вокзал находится прямо впереди."]);
  expect(controller.currentAttribution.matchedTextOutputs).toBe(0);
});

describe("PR32 buffered output boundaries", () => {
  beforeEach(() => { vi.useFakeTimers(); vi.setSystemTime(0); });
  it("seals unresolved old output before a new speaker's translation", async () => {
    const { controller, live, audio } = createController();
    await controller.startWithLanguages({ A: "ru", B: "en" });
    emitVoice(audio, true);
    live.emit({ type: "session.input_transcript.delta", delta: "Yes, I understand you." });
    live.emit({ type: "session.output_transcript.delta", delta: "Да" });
    live.emit({ type: "session.input_transcript.delta", delta: "Подскажите, где находится вокзал?" });
    const a = controller.session.activeTurn!.id;
    live.emit({ type: "session.output_transcript.delta", delta: "Where is the train station?" });
    await vi.advanceTimersByTimeAsync(runtime.captionIdleMs);
    expect(controller.session.activeTurn).toMatchObject({ id: a, translatedText: undefined });
    const old = [...controller.session.recentTurns, ...(controller.session.pendingTurns ?? [])];
    expect(old.some(turn => turn.translatedText === "Да")).toBe(true);
    expect(old.filter(turn => turn.translationOnly).map(turn => turn.translatedText)).toEqual(["Да", "Where is the train station?"]);
  });
  it("keeps pending output through a same-source VAD reactivation", async () => {
    const { controller, live, audio } = createController();
    await controller.startWithLanguages({ A: "ru", B: "en" });
    emitVoice(audio, true);
    live.emit({ type: "session.input_transcript.delta", delta: "Спасибо за помощь." });
    const a = controller.session.activeTurn!.id;
    live.emit({ type: "session.output_transcript.delta", delta: "Thank y" });
    emitVoice(audio, false); emitVoice(audio, true);
    live.emit({ type: "session.output_transcript.delta", delta: "ou very much." });
    expect(controller.session.activeTurn).toMatchObject({ id: a, translatedText: "Thank you very much." });
  });
  it("keeps equal-timestamp late punctuation with output missing end_ms", async () => {
    const { controller, live, audio } = createController();
    await controller.startWithLanguages({ A: "ru", B: "en" });
    emitVoice(audio, true);
    live.emit({ type: "session.input_transcript.delta", delta: "Подскажите, где находится вокзал?" });
    live.emit({ type: "session.output_transcript.delta", delta: "Where is the train station", start_ms: 600 });
    const original = controller.captionBlocks.find(block => block.kind === "output")!;
    live.emit({ type: "session.input_transcript.delta", delta: "The station is straight ahead." });
    live.emit({ type: "session.output_transcript.delta", delta: "Вокзал находится прямо впереди.", start_ms: 1600, end_ms: 1900 });
    live.emit({ type: "session.output_transcript.delta", delta: "?", start_ms: 600 });
    // Missing output end/source timing cannot prove an owner, but punctuation retains its packet group.
    expect(controller.captionBlocks.find(block => block.outputId === original.outputId)).toMatchObject({
      text: "Where is the train station?", receivedAtMs: original.receivedAtMs, attribution: "unattributed",
    });
    expect(controller.captionBlocks.filter(block => block.kind === "output")).toHaveLength(2);
    expect(controller.currentAttribution.matchedTextOutputs).toBe(0);
  });
});

it.each(["", "12, "])("bounds a completed predecessor when a new source has untimed prefix %j", async prefix => {
  vi.useFakeTimers(); vi.setSystemTime(0);
  const { controller, live, audio } = createController();
  await controller.startWithLanguages({ A: "ru", B: "en" });
  emitVoice(audio, true);
  live.emit({ type: "session.input_transcript.delta", delta: "The station is straight ahead.", start_ms: 0, end_ms: 500 });
  const b1 = controller.session.activeTurn!.id;
  live.emit({ type: "session.output_transcript.delta", delta: "Вокзал находится прямо впереди." });
  emitVoice(audio, false);
  await vi.advanceTimersByTimeAsync(runtime.audioStartGraceMs + runtime.captionIdleMs);
  expect(controller.session.recentTurns.find(turn => turn.id === b1)?.status).toBe("completed");
  emitVoice(audio, true);
  if (prefix) live.emit({ type: "session.input_transcript.delta", delta: prefix });
  live.emit({ type: "session.input_transcript.delta", delta: "где находится вокзал?", start_ms: 2200, end_ms: 2700 });
  const a1 = controller.session.activeTurn!.id;
  live.emit({ type: "session.input_transcript.delta", delta: "Please continue walking straight ahead.", start_ms: 3000, end_ms: 3500 });
  const b2 = controller.session.activeTurn!.id;
  live.emit({ type: "session.output_transcript.delta", delta: "Продолжайте идти прямо вперед." });
  emitPlayback(audio, true);
  live.emit({ type: "session.input_transcript.delta", delta: "Подскажите, пожалуйста, ", start_ms: 1000, end_ms: 1800 });
  expect(controller.session.activeTurn).toMatchObject({ id: b2, speaker: "B" });
  expect(controller.session.activeTurn?.audioOutputInterrupted).not.toBe(true);
  expect(controller.session.pendingTurns?.find(turn => turn.id === a1)).toMatchObject({
    originalText: prefix + "Подскажите, пожалуйста, где находится вокзал?", sourceEndMs: 3000,
  });
  expect(controller.session.recentTurns.find(turn => turn.id === b1)?.sourceEndMs).toBe(1000);
});

it("routes exclusive Spanish short replies in source and output streams", async () => {
  vi.useFakeTimers(); vi.setSystemTime(0);
  const { controller, live, audio } = createController();
  await controller.startWithLanguages({ A: "en", B: "es" });
  emitVoice(audio, true);
  live.emit({ type: "session.input_transcript.delta", delta: "Where is the train station?" });
  live.emit({ type: "session.output_transcript.delta", delta: "Sí." });
  expect(controller.session.activeTurn?.translatedText).toBe("Sí.");
  await vi.advanceTimersByTimeAsync(1);
  live.emit({ type: "session.input_transcript.delta", delta: "Sí." });
  expect(controller.session.activeTurn).toMatchObject({ speaker: "B", originalText: "Sí." });
  expect(controller.captionBlocks.filter(block => block.side === "B").map(block => [block.kind, block.text])).toEqual([
    ["output", "Sí."], ["input", "Sí."],
  ]);
});

it.each(["input", "output"] as const)("does not merge ambiguous No with Spanish %s reply before caption idle", async kind => {
  vi.useFakeTimers(); vi.setSystemTime(0);
  const { controller, live, audio } = createController();
  await controller.startWithLanguages({ A: "en", B: "es" });
  emitVoice(audio, true);
  live.emit({ type: "session.input_transcript.delta", delta: "Where is the train station?" });
  live.emit({ type: kind === "input" ? "session.input_transcript.delta" : "session.output_transcript.delta", delta: "No." });
  live.emit({ type: kind === "input" ? "session.input_transcript.delta" : "session.output_transcript.delta", delta: " Sí." });
  expect(controller.captionBlocks.filter(block => block.side === "B").map(block => block.text.trim())).toEqual(["Sí."]);
  expect(controller.captionBlocks.filter(block => block.side === undefined).map(block => block.text.trim())).toEqual(["No."]);
  if (kind === "input") expect(controller.session.activeTurn).toMatchObject({ speaker: "B", originalText: "Sí." });
  else expect(controller.session.activeTurn?.translatedText).toBe("Sí.");
});

it.each([
  ["3.14 liters.", "3.14 литра."],
  ["1.5 kilograms.", "1.5 килограмма."],
])("keeps decimal replies on one source and attaches their translation: %s", async (source, translation) => {
  vi.useFakeTimers(); vi.setSystemTime(0);
  const { controller, live, audio } = createController();
  await controller.startWithLanguages({ A: "ru", B: "en" });
  emitVoice(audio, true);
  live.emit({ type: "session.input_transcript.delta", delta: source });
  const id = controller.session.activeTurn!.id;
  expect(controller.session.activeTurn).toMatchObject({ speaker: "B", originalText: source });
  expect(controller.session.pendingTurns ?? []).toHaveLength(0);
  live.emit({ type: "session.output_transcript.delta", delta: translation });
  expect(controller.session.activeTurn).toMatchObject({ id, speaker: "B", originalText: source, translatedText: translation });
  expect(controller.session.pendingTurns ?? []).toHaveLength(0);
  expect(controller.captionBlocks.map(block => [block.kind, block.side, block.text])).toEqual([
    ["input", "B", source], ["output", "A", translation],
  ]);
});

it.each([
  { pair: { A: "ru", B: "de" }, speaker: "B", source: "5. Oktober.", translation: "Пятое октября." },
  { pair: { A: "ru", B: "de" }, speaker: "B", source: "1. Stock.", translation: "Первый этаж." },
  { pair: { A: "en", B: "es" }, speaker: "A", source: "Dr. Smith is here.", translation: "El doctor Smith está aquí." },
  { pair: { A: "en", B: "es" }, speaker: "A", source: "J. Smith is here.", translation: "El señor Smith está aquí." },
  { pair: { A: "en", B: "es" }, speaker: "A", source: "J. R. Smith is here.", translation: "El señor Smith está aquí." },
  { pair: { A: "en", B: "sr" }, speaker: "B", source: "Dr. Ј. Петровић.", translation: "Doctor Petrovic is here." },
  { pair: { A: "en", B: "es" }, speaker: "A", source: "Visit example.com.", translation: "Visite la página example.com." },
  { pair: { A: "en", B: "es" }, speaker: "A", source: "\"Dr. Smith is here.\"", translation: "El doctor Smith está aquí." },
  { pair: { A: "en", B: "es" }, speaker: "A", source: "(Dr. Smith is here.)", translation: "El doctor Smith está aquí." },
  { pair: { A: "ru", B: "de" }, speaker: "B", source: "\"5. Oktober.\"", translation: "Пятое октября." },
  { pair: { A: "en", B: "es" }, speaker: "A", source: "\"J. R. Smith is here.\"", translation: "El señor Smith está aquí." },
  { pair: { A: "en", B: "es" }, speaker: "A", source: "No. 5 is ready.", translation: "El número cinco está listo." },
  { pair: { A: "en", B: "es" }, speaker: "A", source: "Visit example.no.", translation: "Visite la página example.no." },
  { pair: { A: "en", B: "fr" }, speaker: "B", source: "Veuillez ouvrir le site example.no.", translation: "Please open the website example.no." },
  { pair: { A: "en", B: "fr" }, speaker: "A", source: "Please open the website example.no.", translation: "Veuillez ouvrir le site example.no." },
  { pair: { A: "fr", B: "en" }, speaker: "A", source: 'Veuillez ouvrir le site "example.no".', translation: 'Please open the website "example.no".' },
  { pair: { A: "en", B: "es" }, speaker: "A", source: "Visit \"example.com\".", translation: "Visite la página example.com." },
  { pair: { A: "en", B: "es" }, speaker: "A", source: "Visit (example.com).", translation: "Visite la página example.com." },
].flatMap(example => [false, true].map(chunked => ({ ...example,
  chunks: chunked ? [example.source.slice(0, example.source.indexOf(".") + 1), example.source.slice(example.source.indexOf(".") + 1)] : [example.source],
}))))("retains periods inside ordinal, abbreviation and hostname replies: $chunks", async ({ pair, speaker, source, translation, chunks }) => {
  vi.useFakeTimers(); vi.setSystemTime(0);
  const { controller, live, audio } = createController();
  await controller.startWithLanguages(pair);
  emitVoice(audio, true);
  for (const delta of chunks) live.emit({ type: "session.input_transcript.delta", delta });
  const id = controller.session.activeTurn!.id;
  expect(controller.session.activeTurn).toMatchObject({ speaker, originalText: source });
  expect(controller.session.pendingTurns ?? []).toHaveLength(0);
  const dot = translation.indexOf(".") + 1;
  const outputChunks = chunks.length > 1 && dot < translation.length ? [translation.slice(0, dot), translation.slice(dot)] : [translation];
  for (const delta of outputChunks) live.emit({ type: "session.output_transcript.delta", delta });
  expect(controller.session.activeTurn).toMatchObject({ id, speaker, originalText: source, translatedText: translation });
  expect(controller.session.pendingTurns ?? []).toHaveLength(0);
  expect(controller.captionBlocks.map(block => [block.kind, block.side, block.text])).toEqual([
    ["input", speaker, source], ["output", speaker === "A" ? "B" : "A", translation],
  ]);
});

it.each([
  { prefix: "Visit example.", suffix: "com." },
  { prefix: "Visit example.", suffix: "no." },
  { prefix: 'Visit "example.', suffix: 'com".' },
  { prefix: "Visit (example.", suffix: "com)." },
  { prefix: "Visit example.", suffix: "com" },
  { prefix: 'Visit "example.', suffix: 'com"' },
  { prefix: "Visit (example.", suffix: "com)" },
])("keeps a chunked hostname on its source before the next Spanish speaker: $prefix$suffix", async ({ prefix, suffix }) => {
  vi.useFakeTimers(); vi.setSystemTime(0);
  const { controller, live, audio } = createController();
  await controller.startWithLanguages({ A: "en", B: "es" });
  emitVoice(audio, true);
  live.emit({ type: "session.input_transcript.delta", delta: prefix, start_ms: 0, end_ms: 400 });
  const a = controller.session.activeTurn!.id;
  live.emit({ type: "session.input_transcript.delta", delta: suffix, start_ms: 400, end_ms: 500 });
  await vi.advanceTimersByTimeAsync(runtime.captionIdleMs);
  expect(controller.session.activeTurn).toMatchObject({ id: a, speaker: "A", originalText: prefix + suffix });
  live.emit({ type: "session.input_transcript.delta", delta: " La estación está cerca del supermercado.", start_ms: 1000, end_ms: 1500 });
  expect(controller.session.activeTurn).toMatchObject({ speaker: "B", originalText: " La estación está cerca del supermercado." });
  expect(controller.session.pendingTurns).toHaveLength(1);
  expect(controller.session.pendingTurns![0]).toMatchObject({ id: a, speaker: "A", originalText: prefix + suffix });
  live.emit({ type: "session.output_transcript.delta", delta: "Visite la página example.com.", start_ms: 600, end_ms: 900 });
  expect(controller.session.pendingTurns![0]).toMatchObject({ id: a, translatedText: "Visite la página example.com." });
});

it("attaches translation to speech after a single oversized neutral prefix", async () => {
  vi.useFakeTimers(); vi.setSystemTime(0);
  const { controller, live, audio } = createController();
  await controller.startWithLanguages({ A: "en", B: "es" });
  emitVoice(audio, true);
  const source = "123 ".repeat(600) + "Where is the station?", translation = "La estación está cerca del supermercado.";
  live.emit({ type: "session.input_transcript.delta", delta: source });
  const id = controller.session.activeTurn!.id;
  expect(controller.session.activeTurn).toMatchObject({ speaker: "A", originalText: source });
  expect(controller.session.pendingTurns ?? []).toHaveLength(0);
  live.emit({ type: "session.output_transcript.delta", delta: translation });
  expect(controller.session.activeTurn).toMatchObject({ id, translatedText: translation });
  expect(controller.captionBlocks.map(block => [block.kind, block.side, block.text])).toEqual([
    ["input", "A", source], ["output", "B", translation],
  ]);
});

it.each([
  { name: "No", weak: "No." },
  { name: "OK", weak: "OK." },
  { name: "bounded numeric prefix", weak: "123. ".repeat(400) },
])("preserves independent output when unresolved source text competes: $name", async ({ weak }) => {
  vi.useFakeTimers(); vi.setSystemTime(0);
  const { controller, live, audio } = createController();
  await controller.startWithLanguages({ A: "en", B: "es" });
  emitVoice(audio, true);
  live.emit({ type: "session.input_transcript.delta", delta: "Where is the train station?" });
  live.emit({ type: "session.input_transcript.delta", delta: weak });
  live.emit({ type: "session.input_transcript.delta", delta: " Sí." });
  const id = controller.session.activeTurn!.id;
  expect(controller.session.activeTurn?.speaker).toBe("B");
  expect(controller.session.activeTurn?.originalText.trim()).toBe("Sí.");
  const unknown = controller.session.pendingTurns?.find(turn => turn.speaker === undefined);
  expect(unknown?.originalText.trim()).toBe(weak.trim());
  live.emit({ type: "session.output_transcript.delta", delta: "Yes." });
  live.emit({ type: "session.output_transcript.delta", delta: " The station is nearby." });
  expect(controller.session.activeTurn).toMatchObject({ id, translatedText: undefined });
  expect(controller.session.pendingTurns?.find(turn => turn.translationOnly)?.translatedText).toBe("Yes. The station is nearby.");
  expect(controller.session.pendingTurns?.find(turn => turn.id === unknown?.id)).toMatchObject({ speaker: undefined, originalText: unknown?.originalText });
  expect(controller.session.pendingTurns?.some(turn => turn.translationOnly)).toBe(true);
  expect(controller.captionBlocks.filter(block => block.side === undefined).map(block => block.text).join("").trim()).toBe(weak.trim());
});

it.each([
  { text: "Пожалуйста, откройте сайт example.com." },
  { text: 'Пожалуйста, откройте сайт "example.com".' },
].flatMap(example => (["input", "output"] as const).flatMap(kind => [false, true].map(chunked => ({ ...example, kind, chunked })))))("keeps a Russian hostname in its language through $kind packets (chunked=$chunked): $text", async ({ text, kind, chunked }) => {
  vi.useFakeTimers(); vi.setSystemTime(0);
  const { controller, live, audio } = createController();
  await controller.startWithLanguages({ A: "ru", B: "en" });
  emitVoice(audio, true);
  if (kind === "output") live.emit({ type: "session.input_transcript.delta", delta: "Please open the website example.com." });
  const dot = text.indexOf(".") + 1;
  for (const delta of chunked ? [text.slice(0, dot), text.slice(dot)] : [text])
    live.emit({ type: kind === "input" ? "session.input_transcript.delta" : "session.output_transcript.delta", delta });
  await vi.advanceTimersByTimeAsync(runtime.captionIdleMs);
  expect(controller.session.pendingTurns ?? []).toHaveLength(0);
  expect(controller.captionBlocks.filter(block => block.kind === kind).map(block => [block.side, block.text])).toEqual([["A", text]]);
  if (kind === "input") {
    expect(controller.session.activeTurn).toMatchObject({ speaker: "A", originalText: text });
    const id = controller.session.activeTurn!.id;
    live.emit({ type: "session.output_transcript.delta", delta: "Please open the website example.com." });
    expect(controller.session.activeTurn).toMatchObject({ id, translatedText: "Please open the website example.com." });
  } else expect(controller.session.activeTurn).toMatchObject({ speaker: "B", translatedText: text });
});

it("keeps output independent with two exact speaker sources and an unresolved source", async () => {
  vi.useFakeTimers(); vi.setSystemTime(0);
  const { controller, live, audio } = createController();
  await controller.startWithLanguages({ A: "en", B: "es" });
  emitVoice(audio, true);
  for (const delta of ["Where is the train station?", "No.", " Sí.", " I would like to walk there."])
    live.emit({ type: "session.input_transcript.delta", delta });
  expect(controller.session.activeTurn?.speaker).toBe("A");
  live.emit({ type: "session.output_transcript.delta", delta: "Quiero ir allí a pie." });
  expect(controller.session.activeTurn?.translatedText).toBeUndefined();
  expect(controller.session.pendingTurns?.find(turn => turn.translationOnly)).toMatchObject({ speaker: "A", translatedText: "Quiero ir allí a pie." });
  expect(controller.session.pendingTurns?.find(turn => turn.speaker === undefined)?.originalText.trim()).toBe("No.");
});

it("keeps an unresolved source independent of an output whose language alone suggests its author", async () => {
  vi.useFakeTimers(); vi.setSystemTime(0);
  const { controller, live, audio } = createController();
  await controller.startWithLanguages({ A: "en", B: "es" });
  emitVoice(audio, true);
  live.emit({ type: "session.input_transcript.delta", delta: "No." });
  await vi.advanceTimersByTimeAsync(runtime.captionIdleMs);
  const id = controller.session.activeTurn!.id;
  expect(controller.session.activeTurn?.speaker).toBeUndefined();
  live.emit({ type: "session.output_transcript.delta", delta: "Yes." });
  expect(controller.session.activeTurn).toMatchObject({ id, speaker: undefined, originalText: "No.", translatedText: undefined });
  expect(controller.captionBlocks.find(block => block.kind === "input")).toMatchObject({ side: undefined, text: "No." });
  expect(controller.captionBlocks.find(block => block.kind === "output")).toMatchObject({ text: "Yes.", attribution: "unattributed" });
  expect(controller.currentAttribution.matchedTextOutputs).toBe(0);
});

it.each([false, true])("keeps fresh output independent of completed same-speaker history, caption=%s", async caption => {
  vi.useFakeTimers(); vi.setSystemTime(0);
  const { controller, live, audio } = createController();
  await controller.startWithLanguages({ A: "en", B: "es" });

  emitVoice(audio, true);
  live.emit({ type: "session.input_transcript.delta", delta: "Sí." });
  const completedId = controller.session.activeTurn!.id;
  live.emit({ type: "session.output_transcript.delta", delta: "Yes." });
  emitVoice(audio, false);
  await vi.advanceTimersByTimeAsync(runtime.audioStartGraceMs + runtime.captionIdleMs);
  expect(controller.session.recentTurns.find(turn => turn.id === completedId)).toMatchObject({
    status: "completed", speaker: "B", translatedText: "Yes.",
  });
  emitVoice(audio, true);
  if (caption) {
    live.emit({ type: "session.input_transcript.delta", delta: "No." });
    await vi.advanceTimersByTimeAsync(runtime.captionIdleMs);
  }
  const unresolvedId = controller.session.activeTurn!.id;
  expect(unresolvedId).not.toBe(completedId);
  expect(controller.session.activeTurn?.speaker).toBeUndefined();
  live.emit({ type: "session.output_transcript.delta", delta: "Yes." });
  expect(controller.session.recentTurns.find(turn => turn.id === completedId)?.translatedText).toBeUndefined();
  expect(controller.session.activeTurn).toMatchObject({ id: unresolvedId, speaker: undefined });
  expect(controller.session.activeTurn?.translatedText).toBeUndefined();
  expect(controller.session.pendingTurns?.find(turn => turn.translationOnly)).toMatchObject({
    speaker: "B", translatedText: "Yes.",
  });
});

it("keeps timestamped continuation uncertain beside an uncorrelated VAD source", async () => {
  vi.useFakeTimers(); vi.setSystemTime(0);
  const { controller, live, audio } = createController();
  await controller.startWithLanguages({ A: "en", B: "es" });

  emitVoice(audio, true);
  live.emit({ type: "session.input_transcript.delta", delta: "Sí.", start_ms: 0, end_ms: 500 });
  const completedId = controller.session.activeTurn!.id;
  live.emit({ type: "session.output_transcript.delta", delta: "Yes.", start_ms: 600, end_ms: 900 });
  emitVoice(audio, false);
  await vi.advanceTimersByTimeAsync(runtime.audioStartGraceMs + runtime.captionIdleMs);
  expect(controller.session.recentTurns.find(turn => turn.id === completedId)?.status).toBe("completed");
  emitVoice(audio, true);
  const unresolvedId = controller.session.activeTurn!.id;
  live.emit({ type: "session.output_transcript.delta", delta: "Yes.", start_ms: 600, end_ms: 900 });
  expect(controller.session.recentTurns.find(turn => turn.id === completedId)?.translatedText).toBeUndefined();
  expect(controller.session.activeTurn).toMatchObject({ id: unresolvedId, speaker: undefined });
  expect(controller.session.activeTurn?.translatedText).toBeUndefined();
  expect(controller.captionBlocks.find(block => block.kind === "output"))
    .toMatchObject({ text: "Yes.Yes.", attribution: "unattributed" });
});

it("preserves historical text when provider source time excludes that output", async () => {
  vi.useFakeTimers(); vi.setSystemTime(0);
  const { controller, live, audio } = createController();
  await controller.startWithLanguages({ A: "en", B: "es" });

  emitVoice(audio, true);
  live.emit({ type: "session.input_transcript.delta", delta: "Sí.", start_ms: 0, end_ms: 500 });
  const completedId = controller.session.activeTurn!.id;
  live.emit({ type: "session.output_transcript.delta", delta: "Yes.", start_ms: 600, end_ms: 900 });
  emitVoice(audio, false);
  await vi.advanceTimersByTimeAsync(runtime.audioStartGraceMs + runtime.captionIdleMs);
  expect(controller.session.recentTurns.find(turn => turn.id === completedId)?.status).toBe("completed");
  emitVoice(audio, true);
  const unresolvedId = controller.session.activeTurn!.id;
  live.emit({ type: "session.input_transcript.delta", delta: "No.", start_ms: 1000, end_ms: 1200 });
  await vi.advanceTimersByTimeAsync(runtime.captionIdleMs);
  live.emit({ type: "session.output_transcript.delta", delta: "Yes.", start_ms: 600, end_ms: 900 });
  expect(controller.session.recentTurns.find(turn => turn.id === completedId)?.translatedText).toBe("Yes.Yes.");
  expect(controller.session.activeTurn).toMatchObject({ id: unresolvedId, speaker: undefined });
  expect(controller.session.activeTurn?.translatedText).toBeUndefined();
  expect(controller.captionBlocks.find(block => block.kind === "output"))
    .toMatchObject({ text: "Yes.Yes.", attribution: "matched" });
});

it("keeps late output independent of completed history after the latest unresolved source expires", async () => {
  vi.useFakeTimers(); vi.setSystemTime(0);
  const { controller, live, audio } = createController();
  await controller.startWithLanguages({ A: "en", B: "es" });

  emitVoice(audio, true);
  live.emit({ type: "session.input_transcript.delta", delta: "Sí." });
  const completedId = controller.session.activeTurn!.id;
  live.emit({ type: "session.output_transcript.delta", delta: "Yes." });
  emitVoice(audio, false);
  await vi.advanceTimersByTimeAsync(runtime.audioStartGraceMs + runtime.captionIdleMs);
  expect(controller.session.recentTurns.find(turn => turn.id === completedId)?.status).toBe("completed");
  emitVoice(audio, true);
  live.emit({ type: "session.input_transcript.delta", delta: "No." });
  await vi.advanceTimersByTimeAsync(runtime.captionIdleMs);
  const unresolvedId = controller.session.activeTurn!.id;
  emitVoice(audio, false);
  await vi.advanceTimersByTimeAsync(runtime.noOutputTimeoutMs + runtime.captionIdleMs);
  expect(controller.session.recentTurns.find(turn => turn.id === unresolvedId)).toMatchObject({
    status: "unresolved", speaker: undefined,
  });
  live.emit({ type: "session.output_transcript.delta", delta: "Yes." });
  const turns = [...controller.session.recentTurns, ...(controller.session.pendingTurns ?? []),
    ...(controller.session.activeTurn ? [controller.session.activeTurn] : [])];
  expect(turns.find(turn => turn.id === completedId)?.translatedText).toBeUndefined();
  expect(turns.find(turn => turn.id === unresolvedId)?.translatedText).toBeUndefined();
  expect(turns.filter(turn => turn.translationOnly).map(turn => turn.translatedText)).toEqual(["Yes.", "Yes."]);
});

it.each((["streaming", "outputting"] as const).flatMap(status => [undefined, 1600].map(startMs => ({ status, startMs }))))(
  "keeps fresh output independent of pending same-speaker history, status=$status, timestamp=$startMs", async ({ status, startMs }) => {
    vi.useFakeTimers(); vi.setSystemTime(0);
    const { controller, live, audio } = createController();
    await controller.startWithLanguages({ A: "en", B: "es" });
    emitVoice(audio, true);
    live.emit({ type: "session.input_transcript.delta", delta: "Sí.", start_ms: 0, end_ms: 500 });
    const previousId = controller.session.activeTurn!.id;
    if (status === "outputting") live.emit({ type: "session.output_transcript.delta", delta: "Yes.", start_ms: 600, end_ms: 900 });
    live.emit({ type: "session.input_transcript.delta", delta: "No.", start_ms: 1000, end_ms: 1500 });
    await vi.advanceTimersByTimeAsync(runtime.captionIdleMs);
    const unresolvedId = controller.session.activeTurn!.id;
    expect(unresolvedId).not.toBe(previousId);
    expect(controller.session.activeTurn).toMatchObject({ speaker: undefined, originalText: "No." });
    expect(controller.session.pendingTurns?.find(turn => turn.id === previousId)).toMatchObject({ speaker: "B", status });
    live.emit({ type: "session.output_transcript.delta", delta: "Yes.", start_ms: startMs, end_ms: startMs === undefined ? undefined : 1900 });
    expect(controller.session.pendingTurns?.find(turn => turn.id === previousId)?.translatedText).toBe(status === "outputting" ? "Yes." : undefined);
    expect(controller.session.activeTurn).toMatchObject({ id: unresolvedId, speaker: undefined });
    expect(controller.session.activeTurn?.translatedText).toBeUndefined();
    expect(controller.session.pendingTurns?.find(turn => turn.translationOnly)).toMatchObject({ speaker: "B", translatedText: "Yes." });
  });

it("retains timestamped late output for pending history beside a fresh unresolved source", async () => {
  vi.useFakeTimers(); vi.setSystemTime(0);
  const { controller, live, audio } = createController();
  await controller.startWithLanguages({ A: "en", B: "es" });
  emitVoice(audio, true);
  live.emit({ type: "session.input_transcript.delta", delta: "Sí.", start_ms: 0, end_ms: 500 });
  const previousId = controller.session.activeTurn!.id;
  live.emit({ type: "session.output_transcript.delta", delta: "Yes.", start_ms: 600, end_ms: 900 });
  live.emit({ type: "session.input_transcript.delta", delta: "No.", start_ms: 1000, end_ms: 1500 });
  await vi.advanceTimersByTimeAsync(runtime.captionIdleMs);
  const unresolvedId = controller.session.activeTurn!.id;
  expect(controller.session.pendingTurns?.find(turn => turn.id === previousId)?.status).toBe("outputting");
  live.emit({ type: "session.output_transcript.delta", delta: "Yes.", start_ms: 600, end_ms: 900 });
  expect(controller.session.pendingTurns?.find(turn => turn.id === previousId)?.translatedText).toBe("Yes.Yes.");
  expect(controller.session.activeTurn).toMatchObject({ id: unresolvedId, speaker: undefined });
  expect(controller.session.activeTurn?.translatedText).toBeUndefined();
  expect(controller.session.pendingTurns?.some(turn => turn.translationOnly)).toBe(false);
});

it.each([false, true].flatMap(completed => [1900, 2200, undefined].map(endMs => ({ completed, endMs }))))(
  "requires a contained lexical output interval for older history, completed=$completed, end=$endMs", async ({ completed, endMs }) => {
    vi.useFakeTimers(); vi.setSystemTime(0);
    const { controller, live, audio } = createController();
    await controller.startWithLanguages({ A: "en", B: "es" });
    emitVoice(audio, true);
    live.emit({ type: "session.input_transcript.delta", delta: "Sí.", start_ms: 0, end_ms: 500 });
    const previousId = controller.session.activeTurn!.id;
    live.emit({ type: "session.output_transcript.delta", delta: "Yes.", start_ms: 600, end_ms: 1900 });
    if (completed) {
      emitVoice(audio, false);
      await vi.advanceTimersByTimeAsync(runtime.audioStartGraceMs + runtime.captionIdleMs);
      expect(controller.session.recentTurns.find(turn => turn.id === previousId)?.status).toBe("completed");
      emitVoice(audio, true);
    }
    live.emit({ type: "session.input_transcript.delta", delta: "No.", start_ms: 2000, end_ms: 2500 });
    await vi.advanceTimersByTimeAsync(runtime.captionIdleMs);
    const unresolvedId = controller.session.activeTurn!.id;
    expect(unresolvedId).not.toBe(previousId);
    expect(controller.session.activeTurn?.speaker).toBeUndefined();
    live.emit({ type: "session.output_transcript.delta", delta: "Yes.", start_ms: 1600, end_ms: endMs });
    const contained = endMs === 1900;
    const history = [...controller.session.recentTurns, ...(controller.session.pendingTurns ?? [])];
    expect(history.find(turn => turn.id === previousId)?.translatedText).toBe(contained ? "Yes.Yes." : "Yes.");
    expect(controller.session.activeTurn).toMatchObject({ id: unresolvedId, speaker: undefined });
    expect(controller.session.activeTurn?.translatedText).toBeUndefined();
    expect(history.find(turn => turn.translationOnly)?.translatedText).toBe(contained ? undefined : "Yes.");
  });

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
  it("records audible completion without sending a per-turn steering command", async () => {
    const { controller, live, audio } = createController(); await enterListening(controller);
    Object.defineProperty(audio.audioElement, "muted", { value: false, writable: true });
    emitVoice(audio, true); live.emit({ type: "session.input_transcript.delta", delta: "Hello, where is the nearest train station?" });
    live.emit({ type: "session.output_transcript.delta", delta: "Hola" }); emitPlayback(audio, true); await flushMicrotasks();
    emitVoice(audio, false); await flushMicrotasks();
    live.appendInstructions.mockRejectedValueOnce(new Error("next steering failed"));
    emitPlayback(audio, false); await flushMicrotasks();
    await vi.advanceTimersByTimeAsync(2000);
    expect(controller.metrics.snapshot().audioCompletedTurnCount).toBe(1);
    expect(controller.session.state).toBe("listening");
    expect(live.appendInstructions.mock.calls.filter(call => call[1]?.kind === "later_steering")).toHaveLength(0);
  });
});

describe("attribution deadlines and visible output", () => {
  beforeEach(() => { vi.useFakeTimers(); });
  it("retains all six outputs with historical watchdogs but no false absence", async () => {
    const { controller, live, audio } = createController();
    await controller.startWithLanguages({ A: "ru", B: "es" });
    for (let index = 0; index < 6; index++) {
      emitVoice(audio, true);
      live.emit({ type: "session.input_transcript.delta", delta: "Подскажите, где находится вокзал?", start_ms: index * 10000, end_ms: index * 10000 + 1000 });
      live.emit({ type: "session.output_transcript.delta", delta: "¿Dónde está la estación?", start_ms: index * 10000 + 500, end_ms: index * 10000 + 1500 });
      emitVoice(audio, false);
      emitPlayback(audio, true); emitPlayback(audio, false);
      await vi.advanceTimersByTimeAsync(runtime.noOutputTimeoutMs + runtime.captionIdleMs);
      expect(controller.recoveryPrompt).toBe(index === 0 ? undefined : "conditional-repeat");
    }
    expect(controller.metrics.snapshot().noObservedOutputDeadlineCount).toBe(0);
    expect(controller.metrics.snapshot().noOutputWatchdogCount).toBe(5);
    expect(controller.session.recentTurns.filter(turn => !turn.translationOnly && turn.status === "unresolved")).toHaveLength(5);
    expect(controller.captionBlocks.filter(block => block.kind === "output").map(block => block.text)).toEqual(Array(6).fill("¿Dónde está la estación?"));
  });
  it("clears only the addressed no-output hint on the first isolated late response", async () => {
    const { controller, live, audio } = createController();
    await controller.startWithLanguages({ A: "ru", B: "es" });
    emitVoice(audio, true);
    live.emit({ type: "session.input_transcript.delta", delta: "Подскажите, где находится вокзал?", start_ms: 0, end_ms: 1000 });
    emitVoice(audio, false);
    await vi.advanceTimersByTimeAsync(runtime.noOutputTimeoutMs + 1);
    expect(controller.recoveryPrompt).toBe("repeat");
    live.emit({ type: "session.output_transcript.delta", delta: "¿Dónde está la estación?", start_ms: 500, end_ms: 1500 });
    expect(controller.recoveryPrompt).toBeUndefined();
    expect(controller.session.recentTurns[0]?.status).toBe("failed");
    expect(controller.session.recentTurns[0]?.translatedText).toBe("¿Dónde está la estación?");
    expect(controller.metrics.snapshot().lateOutputAfterDeadlineCount).toBe(1);
    expect(controller.metrics.snapshot().noOutputWatchdogCount).toBe(1);
  });
  it("retains technical playback completion separately from current PCM ownership", async () => {
    const { controller, live, audio } = createController();
    await controller.startWithLanguages({ A: "ru", B: "es" });
    emitVoice(audio, true);
    live.emit({ type: "session.input_transcript.delta", delta: "Подскажите, где находится вокзал?" });
    emitVoice(audio, false);
    emitPlayback(audio, true); emitPlayback(audio, false);
    await vi.advanceTimersByTimeAsync(runtime.noOutputTimeoutMs + runtime.captionIdleMs);
    expect(controller.session.recentTurns[0]?.status).toBe("completed");
    expect(controller.currentAttribution.matchedAudioOutputs).toBe(0);
    expect(controller.currentAttribution.unattributedPlaybackCount).toBe(1);
    expect(controller.metrics.snapshot().noObservedOutputDeadlineCount).toBe(0);
    expect(controller.recoveryPrompt).toBeUndefined();
  });
});


it.each([false, true])("expires unresolved waiting while unrelated PCM remains active, queued=%s", async queued => {
  vi.useFakeTimers(); vi.setSystemTime(1000);
  const audio = Object.assign(createFakeAudio(), { hasPendingPlayback: false });
  const { controller, live } = createController({ audio });
  await controller.startWithLanguages({ A: "ru", B: "es" });
  emitVoice(audio, true);
  live.emit({ type: "session.input_transcript.delta", delta: "Подскажите, где находится вокзал?" });
  const source = controller.session.activeTurn!.id;
  live.emit({ type: "session.output_transcript.delta", delta: "OK" });
  emitVoice(audio, false);
  await vi.advanceTimersByTimeAsync(runtime.captionIdleMs);
  emitPlayback(audio, true);
  audio.hasPendingPlayback = queued;
  await vi.advanceTimersByTimeAsync(runtime.noOutputTimeoutMs + 1);
  expect(controller.session.activeTurn).toBeUndefined();
  expect(controller.session.recentTurns.find(turn => turn.id === source)?.status).toBe("unresolved");
  expect(controller.metrics.snapshot().noObservedOutputDeadlineCount).toBe(0);
  expect(controller.recoveryPrompt).toBeUndefined();
});


it("uses queued PCM as presence evidence without inventing audible playback", async () => {
  vi.useFakeTimers(); vi.setSystemTime(1000);
  const audio = Object.assign(createFakeAudio(), { hasPendingPlayback: false });
  const { controller, live } = createController({ audio });
  await controller.startWithLanguages({ A: "ru", B: "es" });
  emitVoice(audio, true);
  live.emit({ type: "session.input_transcript.delta", delta: "Подскажите, где находится вокзал?" });
  const id = controller.session.activeTurn!.id;
  emitVoice(audio, false);
  audio.hasPendingPlayback = true;
  audio.onPcmReceived?.(Date.now());
  await vi.advanceTimersByTimeAsync(runtime.noOutputTimeoutMs + 1);
  expect(controller.session.recentTurns.find(turn => turn.id === id)?.status).toBe("unresolved");
  expect(controller.currentAttribution.unattributedPlaybackCount).toBe(0);
  expect(controller.metrics.snapshot().noObservedOutputDeadlineCount).toBe(0);
});


it("reattributes an output observed before delayed source ASR without replaying or recounting it", async () => {
  vi.useFakeTimers(); vi.setSystemTime(1000);
  const { controller, live, audio } = createController();
  await controller.startWithLanguages({ A: "ru", B: "es" });
  live.emit({ type: "session.output_transcript.delta", delta: "¿Dónde está la estación?", start_ms: 500, end_ms: 1500 });
  const outputId = controller.captionBlocks.find(block => block.kind === "output")?.outputId;
  await vi.advanceTimersByTimeAsync(runtime.audioStartGraceMs + runtime.captionIdleMs);
  live.emit({ type: "session.input_transcript.delta", delta: "Подскажите, где находится вокзал?", start_ms: 0, end_ms: 1000 });
  expect(controller.currentAttribution.matchedTextOutputs).toBe(1);
  const output = controller.captionBlocks.filter(block => block.kind === "output");
  expect(output).toHaveLength(1);
  expect(output[0]).toMatchObject({ outputId, receivedAtMs: 1000, attribution: "matched" });
  emitVoice(audio, false);
  await vi.advanceTimersByTimeAsync(runtime.noOutputTimeoutMs + runtime.captionIdleMs);
  expect(controller.metrics.snapshot().textOnlyCompletedTurnCount).toBe(0);
  expect(controller.metrics.snapshot().lateOutputAfterDeadlineCount).toBe(0);
});

it("clears a repeat hint for compatible late uncertainty without crediting either failed source", async () => {
  vi.useFakeTimers(); vi.setSystemTime(1000);
  const { controller, live, audio } = createController();
  await controller.startWithLanguages({ A: "ru", B: "es" });
  for (const start of [0, 2000]) {
    emitVoice(audio, true);
    live.emit({ type: "session.input_transcript.delta", delta: "Подскажите, где находится вокзал?", start_ms: start, end_ms: start + 1000 });
    emitVoice(audio, false);
    await vi.advanceTimersByTimeAsync(runtime.noOutputTimeoutMs + 1);
  }
  expect(controller.recoveryPrompt).toBe("repeat");
  const history = controller.metrics.snapshot();
  live.emit({ type: "session.output_transcript.delta", delta: "¿Dónde está la estación?", start_ms: 2500, end_ms: 3500 });
  expect(controller.recoveryPrompt).toBeUndefined();
  expect(controller.currentAttribution.matchedTextOutputs).toBe(0);
  expect(controller.metrics.snapshot()).toMatchObject({ failedTurnCount: history.failedTurnCount,
    noObservedOutputDeadlineCount: 2, lateOutputAfterDeadlineCount: 0 });
});

it("does not clear an addressed repeat hint for incompatible output, then clears on new accepted speech", async () => {
  vi.useFakeTimers(); vi.setSystemTime(1000);
  const { controller, live, audio } = createController();
  await controller.startWithLanguages({ A: "ru", B: "es" });
  emitVoice(audio, true);
  live.emit({ type: "session.input_transcript.delta", delta: "Подскажите, где находится вокзал?" });
  emitVoice(audio, false);
  await vi.advanceTimersByTimeAsync(runtime.noOutputTimeoutMs + 1);
  live.emit({ type: "session.output_transcript.delta", delta: "Вокзал находится прямо впереди." });
  expect(controller.recoveryPrompt).toBe("repeat");
  emitVoice(audio, true);
  live.emit({ type: "session.input_transcript.delta", delta: "Gracias por su ayuda." });
  expect(controller.recoveryPrompt).toBeUndefined();
});

it("keeps the UI output activity edge when a fresh caption follows playback end", async () => {
  vi.useFakeTimers(); vi.setSystemTime(1000);
  const { controller, live, audio } = createController();
  await controller.startWithLanguages({ A: "ru", B: "es" });
  emitVoice(audio, true);
  live.emit({ type: "session.input_transcript.delta", delta: "Подскажите, где находится вокзал?" });
  live.emit({ type: "session.output_transcript.delta", delta: "¿Dónde está la estación?" });
  emitPlayback(audio, true); emitPlayback(audio, false);
  expect(controller.session.activeTurn?.outputTextAfterPlaybackEdge).toBe(false);
  await vi.advanceTimersByTimeAsync(1);
  live.emit({ type: "session.output_transcript.delta", delta: " Quiero ir a pie." });
  expect(controller.session.activeTurn?.outputTextAfterPlaybackEdge).toBe(true);
});


describe("receipt, language boundaries and deadline ordering", () => {
  beforeEach(() => { vi.useFakeTimers(); vi.setSystemTime(1000); });
  const outputRows = (controller: SessionController, side: "A" | "B") => {
    const root = document.createElement("div");
    root.innerHTML = renderToStaticMarkup(createElement(ConversationScreen, { controller }));
    return [...root.querySelectorAll(`[data-testid="participant-pane-${side}"] li`)].map(row => row.textContent);
  };

  it("shows an unclassified receipt immediately and keeps its identity through late language evidence", async () => {
    const { controller, live, audio } = createController();
    await controller.startWithLanguages({ A: "en", B: "es" });
    emitVoice(audio, true);
    live.emit({ type: "session.input_transcript.delta", delta: "¿Dónde está la estación?", start_ms: 0, end_ms: 1000 });
    const sourceId = controller.session.activeTurn!.id;
    emitVoice(audio, false);
    live.emit({ type: "session.output_transcript.delta", delta: "Thank y", start_ms: 500, end_ms: 1500 });
    const first = controller.captionBlocks.find(block => block.kind === "output");
    expect(first).toMatchObject({ text: "Thank y", attribution: "unattributed", receivedAtMs: 1000 });
    expect(renderToStaticMarkup(createElement(ConversationScreen, { controller }))).toContain("Thank y");
    expect(controller.currentAttribution).toMatchObject({ matchedTextOutputs: 0, unattributedTextOutputs: 1 });
    await vi.advanceTimersByTimeAsync(6000);
    expect(controller.session.recentTurns.find(turn => turn.id === sourceId)).toMatchObject({
      status: "unresolved", outputDeadline: { atMs: 6000, outcome: "unresolved" },
    });
    expect(controller.metrics.snapshot()).toMatchObject({ noObservedOutputDeadlineCount: 0, unresolvedSourceOutcomeCount: 1 });
    expect(controller.recoveryPrompt).toBe("conditional-repeat");
    live.emit({ type: "session.output_transcript.delta", delta: "ou very much.", start_ms: 1500, end_ms: 2000 });
    expect(controller.captionBlocks.filter(block => block.kind === "output")).toEqual([
      expect.objectContaining({ outputId: first!.outputId, text: "Thank you very much.", receivedAtMs: 1000, attribution: "matched" }),
    ]);
    expect(controller.recoveryPrompt).toBeUndefined();
    expect(controller.session.recentTurns.find(turn => turn.id === sourceId)).toMatchObject({ status: "unresolved", firstOutputTextAtMs: 1000 });
    expect(controller.metrics.snapshot().lateOutputAfterDeadlineCount).toBe(0);
    expect(controller.attributionTrace.some(entry => entry.firstReceivedAtMs === 1000 && entry.matchedAtMs === 7000 && entry.deadlineAtMs === 6000)).toBe(true);
  });

  it("keeps mixed packet directions separate without inventing sub-packet times", async () => {
    const { controller, live, audio } = createController();
    await controller.startWithLanguages({ A: "ru", B: "es" });
    emitVoice(audio, true);
    live.emit({ type: "session.input_transcript.delta", delta: "Подскажите, где находится вокзал?", start_ms: 0, end_ms: 1000 });
    live.emit({ type: "session.output_transcript.delta", delta: "¿Dónde está la estación? Вокзал находится прямо впереди.", start_ms: 500, end_ms: 2500 });
    await vi.advanceTimersByTimeAsync(601);
    expect(controller.session.activeTurn?.translatedText).toBe("¿Dónde está la estación? ");
    const blocks = controller.captionBlocks.filter(block => block.kind === "output");
    expect(blocks.map(block => [block.text, block.attribution])).toEqual([
      ["¿Dónde está la estación? ", "matched"], ["Вокзал находится прямо впереди.", "unattributed"],
    ]);
    expect(new Set(blocks.map(block => block.outputId)).size).toBe(2);
    const turns = [...(controller.session.pendingTurns ?? []), controller.session.activeTurn!];
    expect(turns.flatMap(turn => turn.outputFragments ?? []).map(part => [part.startMs, part.endMs, part.receivedAtMs]))
      .toEqual([[500, 2500, 1000], [500, 2500, 1000]]);
    expect(controller.currentAttribution).toMatchObject({ matchedTextOutputs: 1, unattributedTextOutputs: 1 });
    expect(outputRows(controller, "B")).toEqual(["Él: ¿Dónde está la estación?"]);
  });

  it("renders adjacent timed parts of one phrase in one paragraph and keeps a new source separate", async () => {
    const { controller, live, audio } = createController();
    await controller.startWithLanguages({ A: "ru", B: "es" });
    emitVoice(audio, true);
    live.emit({ type: "session.input_transcript.delta", delta: "Подскажите, где находится вокзал?", start_ms: 0, end_ms: 1000 });
    live.emit({ type: "session.output_transcript.delta", delta: "¿Dónde está ", start_ms: 100, end_ms: 200 });
    const id = controller.captionBlocks.find(block => block.kind === "output")!.outputId;
    await vi.advanceTimersByTimeAsync(100);
    live.emit({ type: "session.output_transcript.delta", delta: "la estación?", start_ms: 200, end_ms: 300 });
    expect(controller.captionBlocks.filter(block => block.kind === "output")).toEqual([
      expect.objectContaining({ outputId: id, text: "¿Dónde está la estación?" }),
    ]);
    expect(outputRows(controller, "B")).toEqual(["Él: ¿Dónde está la estación?"]);
    live.emit({ type: "session.input_transcript.delta", delta: "Gracias por su ayuda.", start_ms: 2000, end_ms: 3000 });
    live.emit({ type: "session.output_transcript.delta", delta: "Siguiente pregunta.", start_ms: 3000, end_ms: 4000 });
    expect(controller.captionBlocks.filter(block => block.kind === "output")).toHaveLength(2);
    expect(controller.captionBlocks.filter(block => block.kind === "output")[1]).toMatchObject({ attribution: "unattributed" });
  });

  it.each([6000, 7000])("uses receipt time when output at %i precedes an overdue timer task", async receiptAt => {
    const { controller, live, audio } = createController();
    await controller.startWithLanguages({ A: "ru", B: "es" });
    emitVoice(audio, true);
    live.emit({ type: "session.input_transcript.delta", delta: "Подскажите, где находится вокзал?", start_ms: 0, end_ms: 1000 });
    const sourceId = controller.session.activeTurn!.id;
    emitVoice(audio, false);
    vi.setSystemTime(receiptAt);
    live.emit({ type: "session.output_transcript.delta", delta: "¿Dónde está la estación?", start_ms: 500, end_ms: 1500 });
    await vi.advanceTimersByTimeAsync(600);
    const turn = controller.session.recentTurns.find(turn => turn.id === sourceId)!;
    expect(turn.firstOutputTextAtMs).toBe(receiptAt);
    expect(turn.outputDeadline).toEqual(receiptAt > 6000 ? { atMs: 6000, outcome: "no_observed_output" } : undefined);
    expect(controller.metrics.snapshot()).toMatchObject({ lateOutputAfterDeadlineCount: receiptAt > 6000 ? 1 : 0,
      noObservedOutputDeadlineCount: receiptAt > 6000 ? 1 : 0 });
    expect(controller.recoveryPrompt).toBeUndefined();
    const history = controller.metrics.snapshot();
    await vi.advanceTimersByTimeAsync(6000);
    expect(controller.metrics.snapshot().noObservedOutputDeadlineCount).toBe(history.noObservedOutputDeadlineCount);
    expect(controller.metrics.snapshot().lateOutputAfterDeadlineCount).toBe(history.lateOutputAfterDeadlineCount);
  });
});


it("keeps one visible phrase when a timed continuation waits for language evidence", async () => {
  vi.useFakeTimers(); vi.setSystemTime(1000);
  const { controller, live, audio } = createController();
  await controller.startWithLanguages({ A: "ru", B: "es" });
  emitVoice(audio, true);
  live.emit({ type: "session.input_transcript.delta", delta: "Подскажите, где находится вокзал?", start_ms: 0, end_ms: 1000 });
  live.emit({ type: "session.output_transcript.delta", delta: "¿Dónde está ", start_ms: 100, end_ms: 200 });
  live.emit({ type: "session.output_transcript.delta", delta: "l", start_ms: 200, end_ms: 210 });
  const pendingId = controller.captionBlocks.filter(block => block.kind === "output").at(-1)!.outputId;
  live.emit({ type: "session.output_transcript.delta", delta: "a estación?", start_ms: 210, end_ms: 300 });
  expect(controller.attributionTrace.filter(entry => entry.outputId === pendingId && entry.kind === "decision").at(-1)?.sourceId)
    .toBe(controller.session.activeTurn!.id);
  const root = document.createElement("div");
  root.innerHTML = renderToStaticMarkup(createElement(ConversationScreen, { controller }));
  expect([...root.querySelectorAll('[data-testid="participant-pane-B"] li')].map(row => row.textContent))
    .toEqual(["Él: ¿Dónde está la estación?"]);
});

it.each([false, true])("retains deadline uncertainty before later incompatible classification, delayedTimer=%s", async delayedTimer => {
  vi.useFakeTimers(); vi.setSystemTime(1000);
  const { controller, live, audio } = createController();
  await controller.startWithLanguages({ A: "en", B: "es" });
  emitVoice(audio, true);
  live.emit({ type: "session.input_transcript.delta", delta: "Where is the nearest station?", start_ms: 0, end_ms: 1000 });
  const id = controller.session.activeTurn!.id;
  emitVoice(audio, false);
  live.emit({ type: "session.output_transcript.delta", delta: "Thank y", start_ms: 500, end_ms: 1500 });
  if (delayedTimer) vi.setSystemTime(7000);
  else await vi.advanceTimersByTimeAsync(6000);
  live.emit({ type: "session.output_transcript.delta", delta: "ou very much.", start_ms: 1500, end_ms: 2000 });
  expect(controller.session.recentTurns.find(turn => turn.id === id)?.outputDeadline)
    .toEqual({ atMs: 6000, outcome: "unresolved" });
  expect(controller.metrics.snapshot()).toMatchObject({ unresolvedSourceOutcomeCount: 1, noObservedOutputDeadlineCount: 0 });
  expect(controller.currentAttribution.matchedTextOutputs).toBe(0);
});

it("keeps a repeat hint when an unclassified receipt predates that source on the provider clock", async () => {
  vi.useFakeTimers(); vi.setSystemTime(1000);
  const { controller, live, audio } = createController();
  await controller.startWithLanguages({ A: "en", B: "es" });
  emitVoice(audio, true);
  live.emit({ type: "session.input_transcript.delta", delta: "¿Dónde está la estación?", start_ms: 3000, end_ms: 4000 });
  emitVoice(audio, false);
  await vi.advanceTimersByTimeAsync(5001);
  live.emit({ type: "session.output_transcript.delta", delta: "Thank y", start_ms: 500, end_ms: 1500 });
  expect(controller.captionBlocks.some(block => block.text === "Thank y")).toBe(true);
  expect(controller.recoveryPrompt).toBe("repeat");
  expect(controller.currentAttribution.matchedTextOutputs).toBe(0);
});


it.each([false, true])("freezes deadline uncertainty before source handoff classification, delayed=%s", async delayed => {
  vi.useFakeTimers(); vi.setSystemTime(1000);
  const { controller, live, audio } = createController();
  await controller.startWithLanguages({ A: "en", B: "es" });
  emitVoice(audio, true);
  live.emit({ type: "session.input_transcript.delta", delta: "Where is the nearest station?", start_ms: 0, end_ms: 1000 });
  const sourceId = controller.session.activeTurn!.id;
  emitVoice(audio, false);
  await vi.advanceTimersByTimeAsync(4500);
  live.emit({ type: "session.output_transcript.delta", delta: "Thank you", start_ms: 500, end_ms: 1500 });
  const output = controller.captionBlocks.find(block => block.kind === "output")!;
  expect(output).toMatchObject({ receivedAtMs: 5500, attribution: "unattributed" });
  if (delayed) vi.setSystemTime(7000);
  else await vi.advanceTimersByTimeAsync(1500);
  live.emit({ type: "session.input_transcript.delta", delta: "La estación está cerca del supermercado.", start_ms: 3000, end_ms: 4000 });
  expect(controller.session.recentTurns.find(turn => turn.id === sourceId)?.outputDeadline)
    .toEqual({ atMs: 6000, outcome: "unresolved" });
  expect(controller.metrics.snapshot()).toMatchObject({ noObservedOutputDeadlineCount: 0, unresolvedSourceOutcomeCount: 1 });
  expect(controller.captionBlocks.find(block => block.outputId === output.outputId)).toMatchObject({ receivedAtMs: 5500 });
  expect(controller.currentAttribution.matchedTextOutputs).toBe(0);
});

it("preserves every mixed packet boundary through attribution and rendered captions", async () => {
  vi.useFakeTimers(); vi.setSystemTime(1000);
  const { controller, live, audio } = createController();
  await controller.startWithLanguages({ A: "ru", B: "es" });
  emitVoice(audio, true);
  live.emit({ type: "session.input_transcript.delta", delta: "Подскажите, где находится вокзал?", start_ms: 0, end_ms: 1000 });
  const parts = ["¿Dónde está la estación? ", "Вокзал находится прямо впереди. ", "Muchas gracias por su ayuda."];
  live.emit({ type: "session.output_transcript.delta", delta: parts.join(""), start_ms: 500, end_ms: 2500 });
  await vi.advanceTimersByTimeAsync(601);
  const blocks = controller.captionBlocks.filter(block => block.kind === "output");
  expect(blocks.map(block => block.text)).toEqual(parts);
  expect(new Set(blocks.map(block => block.outputId)).size).toBe(3);
  expect(blocks.map(block => block.receivedAtMs)).toEqual([1000, 1000, 1000]);
  const root = document.createElement("div");
  root.innerHTML = renderToStaticMarkup(createElement(ConversationScreen, { controller }));
  expect([...root.querySelectorAll('[data-testid="participant-pane-B"] li')].map(row => row.textContent))
    .toEqual(["Él: ¿Dónde está la estación?", "Él: Muchas gracias por su ayuda."]);
});


it("keeps an unfinished multi-sentence output together across caption idle without guessing its source", async () => {
  vi.useFakeTimers(); vi.setSystemTime(1000);
  const { controller, live, audio } = createController();
  await controller.startWithLanguages({ A: "ru", B: "en" });
  emitVoice(audio, true);
  const input = (delta: string) => live.emit({ type: "session.input_transcript.delta", delta });
  const output = (delta: string) => live.emit({ type: "session.output_transcript.delta", delta });
  input("Так, здравствуйте. Кто вы? Что вы хотите?");
  input("Um, sir, hi. I'm a delivery guy. I ");
  output("Well, hello. Who are you, what do you ");
  await vi.advanceTimersByTimeAsync(900);
  output("want?");
  input("need to deliver a package for Mr. Mikhail Gu");
  await vi.advanceTimersByTimeAsync(900);
  input("shin.");
  output("Эм, сэр, привет. Я курьер. У меня посылка для господина Михаила Гу");
  const prefix = controller.captionBlocks.filter(block => block.kind === "output").at(-1)!;
  await vi.advanceTimersByTimeAsync(900);
  output("шина.");
  expect(controller.captionBlocks.find(block => block.outputId === prefix.outputId)).toMatchObject({
    receivedAtMs: prefix.receivedAtMs, text: "Эм, сэр, привет. Я курьер. У меня посылка для господина Михаила Гушина.",
  });
  input("Ага, как мне получить посылку?");
  output("How do I get the package?");
  emitVoice(audio, false);
  await vi.advanceTimersByTimeAsync(6000);
  const blocks = controller.captionBlocks.filter(block => block.kind === "output");
  expect(blocks.map(block => block.text.trim())).toEqual([
    "Well, hello. Who are you, what do you want?",
    "Эм, сэр, привет. Я курьер. У меня посылка для господина Михаила Гушина.",
    "How do I get the package?",
  ]);
  expect(controller.currentAttribution.matchedTextOutputs).toBe(0);
});


it("retains flushed unknown output before a later language-known phrase without guessing a source", async () => {
  vi.useFakeTimers(); vi.setSystemTime(1000);
  const { controller, live } = createController();
  await controller.startWithLanguages({ A: "ru", B: "en" });
  live.emit({ type: "session.output_transcript.delta", delta: "OK" });
  await vi.advanceTimersByTimeAsync(900);
  const unknown = controller.captionBlocks.find(block => block.kind === "output")!;
  live.emit({ type: "session.output_transcript.delta", delta: ", I can check that for you." });
  expect(controller.captionBlocks.filter(block => block.kind === "output")).toEqual([
    expect.objectContaining({ outputId: unknown.outputId, text: "OK", side: undefined, receivedAtMs: 1000, attribution: "unattributed" }),
    expect.objectContaining({ text: ", I can check that for you.", side: "B", receivedAtMs: 1900, attribution: "unattributed" }),
  ]);
  expect(controller.currentAttribution).toMatchObject({ matchedTextOutputs: 0, unattributedTextOutputs: 2, matchedAudioOutputs: 0 });
  expect(controller.recoveryPrompt).toBeUndefined();
  expect(controller.metrics.snapshot().noObservedOutputDeadlineCount).toBe(0);
});


it("keeps source ownership and success uncertain when only output language supplies the author", async () => {
  vi.useFakeTimers(); vi.setSystemTime(1000);
  const { controller, live, audio } = createController();
  await controller.startWithLanguages({ A: "en", B: "es" });
  emitVoice(audio, true);
  live.emit({ type: "session.input_transcript.delta", delta: "No.", start_ms: 0, end_ms: 500 });
  await vi.advanceTimersByTimeAsync(601);
  const sourceId = controller.session.activeTurn!.id;
  expect(controller.session.activeTurn?.speaker).toBeUndefined();
  live.emit({ type: "session.output_transcript.delta", delta: "No, thank you.", start_ms: 200, end_ms: 600 });
  emitVoice(audio, false);
  await vi.advanceTimersByTimeAsync(1601);
  const source = controller.session.recentTurns.find(turn => turn.id === sourceId) ?? controller.session.activeTurn;
  expect(controller.currentAttribution.matchedTextOutputs).toBe(0);
  expect(source?.speaker).toBeUndefined();
});

it("retains unique historical lexical continuation after a different interval", async () => {
  vi.useFakeTimers(); vi.setSystemTime(1000);
  const { controller, live, audio } = createController();
  await controller.startWithLanguages({ A: "ru", B: "es" });
  emitVoice(audio, true);
  live.emit({ type: "session.input_transcript.delta", delta: "Я хочу пройти к вокзалу пешком.", start_ms: 0, end_ms: 100 });
  const sourceId = controller.session.activeTurn!.id;
  live.emit({ type: "session.output_transcript.delta", delta: "Quiero ir a la estación", start_ms: 100, end_ms: 500 });
  const original = controller.captionBlocks.find(block => block.kind === "output")!;
  emitVoice(audio, false);
  await vi.advanceTimersByTimeAsync(1601);
  expect(controller.session.recentTurns.find(turn => turn.id === sourceId)?.status).toBe("completed");
  const completedBefore = controller.metrics.snapshot().textOnlyCompletedTurnCount;
  emitVoice(audio, true);
  live.emit({ type: "session.input_transcript.delta", delta: "La estación está cerca de aquí.", start_ms: 600, end_ms: 700 });
  live.emit({ type: "session.output_transcript.delta", delta: "Вокзал находится недалеко отсюда.", start_ms: 700, end_ms: 800 });
  live.emit({ type: "session.output_transcript.delta", delta: " a pie.", start_ms: 300, end_ms: 450 });
  await vi.advanceTimersByTimeAsync(601);
  const source = controller.session.recentTurns.find(turn => turn.id === sourceId);
  expect(source?.translatedText).toBe("Quiero ir a la estación a pie.");
  if (original.outputId !== undefined) expect(controller.captionBlocks.find(block => block.outputId === original.outputId)?.text).toBe("Quiero ir a la estación a pie.");
  expect(controller.metrics.snapshot().textOnlyCompletedTurnCount).toBe(completedBefore);
});

it.each([false, true])("recomputes first late isolation from facts regardless of later-source callback order, sourceFirst=%s", async sourceFirst => {
  vi.useFakeTimers(); vi.setSystemTime(1000);
  const { controller, live, audio } = createController();
  await controller.startWithLanguages({ A: "ru", B: "es" });
  emitVoice(audio, true);
  live.emit({ type: "session.input_transcript.delta", delta: "Подскажите, где находится вокзал?", start_ms: 0, end_ms: 1000 });
  const sourceId = controller.session.activeTurn!.id;
  emitVoice(audio, false);
  await vi.advanceTimersByTimeAsync(5001);
  vi.setSystemTime(7000);
  const nextSource = () => live.emit({ type: "session.input_transcript.delta", delta: "La estación está cerca del supermercado.", start_ms: 2000, end_ms: 3000 });
  const oldOutput = () => live.emit({ type: "session.output_transcript.delta", delta: "¿Dónde está la estación?", start_ms: 500, end_ms: 1500 });
  if (sourceFirst) nextSource();
  oldOutput();
  const original = controller.captionBlocks.find(block => block.kind === "output")!;
  const intermediate = controller.currentAttribution;
  const published = structuredClone(intermediate);
  if (!sourceFirst) nextSource();
  // D precedes the first receipt; the second retained episode rules out fresh isolation.
  expect(controller.currentAttribution).toMatchObject({ matchedTextOutputs: 0, unattributedTextOutputs: 1 });
  expect(controller.session.recentTurns.find(turn => turn.id === sourceId)).toMatchObject({
    status: "failed", outputDeadline: { atMs: 6000, outcome: "no_observed_output" },
  });
  expect(controller.session.recentTurns.find(turn => turn.id === sourceId)?.translatedText).toBeUndefined();
  expect(controller.captionBlocks.filter(block => block.kind === "output")).toEqual([
    expect.objectContaining({ outputId: original.outputId, receivedAtMs: 7000, text: "¿Dónde está la estación?", attribution: "unattributed" }),
  ]);
  expect(intermediate).toEqual(published);
  expect(controller.currentAttribution.matchedAudioOutputs).toBe(0);
  await controller.endConversation();
});

it.each([false, true])("observes pending unknown source before caption flush and preserves output identity, outputFirst=%s", async outputFirst => {
  vi.useFakeTimers(); vi.setSystemTime(1000);
  const { controller, live, audio } = createController();
  await controller.startWithLanguages({ A: "en", B: "es" });
  emitVoice(audio, true);
  live.emit({ type: "session.input_transcript.delta", delta: "Where is the nearest train station?", start_ms: 0, end_ms: 1000 });
  const sourceId = controller.session.activeTurn!.id;
  emitVoice(audio, false);
  await vi.advanceTimersByTimeAsync(5001);
  vi.setSystemTime(7000);
  const output = () => live.emit({ type: "session.output_transcript.delta", delta: "La estación está cerca de aquí.", start_ms: 2500, end_ms: 3500 });
  if (outputFirst) output();
  const publishedMatches: number[] = [];
  const unsubscribe = controller.subscribe(() => {
    if (controller.captionBlocks.some(block => block.text === "No.")) publishedMatches.push(controller.currentAttribution.matchedTextOutputs);
  });
  live.emit({ type: "session.input_transcript.delta", delta: "No.", start_ms: 2000, end_ms: 3000 });
  if (!outputFirst) output();
  const original = controller.captionBlocks.find(block => block.kind === "output")!;
  const before = controller.currentAttribution;
  unsubscribe();
  expect(publishedMatches.length).toBeGreaterThan(0);
  expect(publishedMatches.every(count => count === 0)).toBe(true);
  const metrics = controller.metrics.snapshot();
  expect(before).toMatchObject({ matchedTextOutputs: 0, unattributedTextOutputs: 1, matchedAudioOutputs: 0 });
  expect(controller.session.activeTurn).toBeUndefined();
  expect(controller.session.recentTurns.find(turn => turn.id === sourceId)?.translatedText).toBeUndefined();
  expect(controller.captionBlocks.find(block => block.text === "No.")?.side).toBeUndefined();
  if (!outputFirst) expect(metrics).toMatchObject({ lateOutputAfterDeadlineCount: 0, attributionRevokedCount: 0 });
  await vi.advanceTimersByTimeAsync(601);
  expect(controller.currentAttribution).toEqual(before);
  expect(controller.metrics.snapshot()).toMatchObject({ lateOutputAfterDeadlineCount: metrics.lateOutputAfterDeadlineCount,
    attributionRevokedCount: metrics.attributionRevokedCount, completedTurnCount: metrics.completedTurnCount });
  expect(controller.session.activeTurn).toMatchObject({ speaker: undefined, originalText: "No." });
  expect(controller.session.activeTurn?.sourceFragments).toEqual([expect.objectContaining({ text: "No.", startMs: 2000, endMs: 3000, receivedAtMs: 7000 })]);
  expect(controller.captionBlocks.find(block => block.outputId === original.outputId)).toMatchObject({
    text: original.text, receivedAtMs: 7000, attribution: "unattributed",
  });
  await controller.endConversation();
});


it.each([false, true])("publishes classified source with revised attribution, outputPending=%s", async outputPending => {
  vi.useFakeTimers(); vi.setSystemTime(1000);
  const { controller, live, audio } = createController();
  await controller.startWithLanguages({ A: "en", B: "es" });
  emitVoice(audio, true);
  live.emit({ type: "session.input_transcript.delta", delta: "Where is the nearest train station?", start_ms: 0, end_ms: 1000 });
  emitVoice(audio, false);
  await vi.advanceTimersByTimeAsync(5001);
  vi.setSystemTime(7000);
  live.emit({ type: "session.output_transcript.delta", delta: "La estación está cerca de aquí.", start_ms: 2500, end_ms: 3500 });
  const original = controller.captionBlocks.find(block => block.kind === "output")!;
  if (outputPending) live.emit({ type: "session.output_transcript.delta", delta: "No", start_ms: 4000, end_ms: 4100 });
  const snapshots: Array<{ matched: number; attribution: string | undefined; id: string | undefined; receipt: number | undefined }> = [];
  const unsubscribe = controller.subscribe(() => {
    if (!controller.captionBlocks.some(block => block.text.includes("How much does the ticket cost?"))) return;
    const output = controller.captionBlocks.find(block => block.outputId === original.outputId)!;
    snapshots.push({ matched: controller.currentAttribution.matchedTextOutputs, attribution: output.attribution,
      id: output.outputId, receipt: output.receivedAtMs });
  });
  live.emit({ type: "session.input_transcript.delta", delta: "How much does the ticket cost?", start_ms: 2000, end_ms: 3000 });
  unsubscribe();
  expect(snapshots.length).toBeGreaterThan(0);
  expect(snapshots).toEqual(snapshots.map(() => ({ matched: 0, attribution: "unattributed", id: original.outputId, receipt: 7000 })));
  expect(controller.session.activeTurn?.originalText).toBe("How much does the ticket cost?");
  await controller.endConversation();
});


it.each(["source", "vad"])("restores source publication after a projection exception: %s", async path => {
  vi.useFakeTimers(); vi.setSystemTime(1000);
  const { controller, live } = createController();
  await controller.startWithLanguages({ A: "en", B: "es" });
  const internal = controller as unknown as {
    attribution: { reconcile(...args: unknown[]): unknown };
    handleVoiceActivity(event: { active: boolean; atMs: number }): Promise<void>;
  };
  const failure = new Error("projection failed");
  vi.spyOn(internal.attribution, "reconcile").mockImplementationOnce(() => { throw failure; });
  const published: string[] = [];
  const unsubscribe = controller.subscribe(() => published.push(controller.session.activeTurn?.originalText ?? ""));
  if (path === "vad") await expect(internal.handleVoiceActivity({ active: true, atMs: 1000 })).rejects.toBe(failure);
  else expect(() => live.emit({ type: "session.input_transcript.delta", delta: "Where is the station?" })).toThrow(failure);
  expect(published).toEqual([]);
  live.emit({ type: "session.input_transcript.delta", delta: "I need to buy a ticket." });
  expect(published.some(text => text.includes("I need to buy a ticket."))).toBe(true);
  unsubscribe();
  await controller.endConversation();
});


it("preserves six untimed exchanges without retaining unsupported historical matches", async () => {
    vi.useFakeTimers();
    const { controller, live, audio, visibility } = createController();
    await controller.startBootstrap();
    await controller.acceptBootstrap("Я говорю по-русски и хочу узнать дорогу к вокзалу.");
    await controller.startBootstrap();
    await controller.acceptBootstrap("I speak English and would like to find the nearest station.");
    await controller.beginInterpreter();
    const russian = "Подскажите, пожалуйста, где находится вокзал?";
    const english = "Could you tell me where the train station is?";
    for (const side of ["B", "A", "A", "A", "B", "B"] as const) {
      emitVoice(audio, true);
      expect(controller.session.activeTurn?.speaker).toBeUndefined();
      live.emit({ type: "session.input_transcript.delta", delta: side === "A" ? russian : english });
      expect(controller.session.activeTurn?.speaker).toBe(side);
      expect(controller.session.activeTurn?.sideSource).toBe("language");
      const sourceId = controller.session.activeTurn?.id;
      live.emit({ type: "session.output_transcript.delta", delta: side === "A" ? english : russian });
      emitVoice(audio, false);
      await vi.advanceTimersByTimeAsync(runtime.noOutputTimeoutMs + runtime.captionIdleMs);
      expect(controller.session.activeTurn).toBeUndefined();
      expect(controller.session.recentTurns.find(turn => turn.id === sourceId)?.speaker).toBe(side);
      expect(controller.inputReady).toBe(true);
    }
    expect(controller.session.recentTurns.filter(turn => !turn.translationOnly).map(turn => turn.speaker))
      .toEqual(["B", "A", "A", "A", "B", "B"]);
    expect(controller.session.recentTurns.filter(turn => turn.translationOnly)).toHaveLength(6);
    visibility.hide();
    await flushMicrotasks();
    visibility.show();
    await vi.advanceTimersByTimeAsync(runtime.captionIdleMs);
    expect(controller.session.state).toBe("listening");
    expect(controller.session.participantA.language).toBe("ru");
    expect(controller.session.participantB.language).toBe("en");
    expect(controller.session.recentTurns).toHaveLength(12);
    emitVoice(audio, true);
    live.emit({ type: "session.input_transcript.delta", delta: "OK" });
    expect(controller.session.activeTurn?.speaker).toBeUndefined();
    live.emit({ type: "session.output_transcript.delta", delta: "Хорошо" });
    emitVoice(audio, false);
    await vi.advanceTimersByTimeAsync(runtime.audioStartGraceMs + runtime.captionIdleMs);
    expect(controller.session.recentTurns.at(-1)?.speaker).toBe("B");
    expect(controller.session.recentTurns).toHaveLength(13);
  });

it("keeps untimed B unresolved after unattributed audio drains", async () => {
    vi.useFakeTimers(); vi.setSystemTime(0);
    const {controller,live,audio} = createController();
    await controller.startWithLanguages({A:"ru",B:"en"});
    emitVoice(audio, true);
    live.emit({type:"session.input_transcript.delta",delta:"Подскажите, где находится вокзал?"});
    live.emit({type:"session.output_transcript.delta",delta:"Where is the train station?"});
    emitVoice(audio,false);
    await vi.advanceTimersByTimeAsync(runtime.audioStartGraceMs+runtime.captionIdleMs);
    expect(controller.session.activeTurn).toBeUndefined();
    emitVoice(audio, true);
    live.emit({type:"session.input_transcript.delta",delta:"The station is straight ahead."});
    const b = controller.session.activeTurn!.id;
    live.setInputMuted.mockClear();
    emitPlayback(audio,true);
    live.emit({type:"session.output_transcript.delta",delta:"Вокзал находится прямо впереди."});
    emitVoice(audio,false);
    await vi.advanceTimersByTimeAsync(runtime.audioStartGraceMs+runtime.captionIdleMs);
    expect(controller.session.recentTurns.find(t=>t.id===b)?.status).not.toBe("completed");
    expect(controller.session.activeTurn?.id).toBe(b);
    await controller.changeInterlocutorLanguage("de");
    expect(controller.session.participantB.language).toBe("en");
    expect(live.setInputMuted).not.toHaveBeenCalledWith(true);
    emitPlayback(audio, false);
    await flushMicrotasks();
    expect(controller.session.recentTurns.find(t => t.id === b)?.status).not.toBe("completed");
    await vi.advanceTimersByTimeAsync(runtime.noOutputTimeoutMs);
    expect(controller.session.recentTurns.find(t => t.id === b)?.status).toBe("unresolved");
    expect(controller.recoveryPrompt).toBeUndefined();
    expect(controller.session.participantB.language).toBe("de");
  });

it("retains untimed short-source uncertainty without borrowing completed text", async () => {
  vi.useFakeTimers(); vi.setSystemTime(0);
  const { controller, live, audio } = createController();
  await controller.startWithLanguages({ A: "ru", B: "en" });
  emitVoice(audio, true);
  live.emit({ type: "session.input_transcript.delta", delta: "I use Google every day." });
  const b = controller.session.activeTurn!.id;
  live.emit({ type: "session.output_transcript.delta", delta: "Я использую ", start_ms: 0, end_ms: 500 });
  emitVoice(audio, false);
  await vi.advanceTimersByTimeAsync(runtime.audioStartGraceMs + runtime.captionIdleMs);
  expect(controller.session.recentTurns.find(turn => turn.id === b)?.status).toBe("completed");
  emitVoice(audio, true);
  live.emit({ type: "session.input_transcript.delta", delta: "Гугл." });
  const a = controller.session.activeTurn!.id;
  live.emit({ type: "session.output_transcript.delta", delta: "Google.", start_ms: 1000, end_ms: 1500 });
  expect(controller.session.activeTurn).toMatchObject({ id: a, translatedText: undefined });
  expect(controller.session.recentTurns.find(turn => turn.id === b)?.translatedText).toBeUndefined();
  expect(controller.captionBlocks.filter(block => block.kind === "output").map(block => block.text)).toEqual(["Я использую ", "Google."]);
});

describe("final attribution review regressions", () => {
  beforeEach(() => { vi.useFakeTimers(); vi.setSystemTime(1000); });

  it.each([true, false])("keeps output identity and outcomes independent of ASR delivery order, timed=%s", async timed => {
    const scenario = async (asrFirst: boolean) => {
      vi.setSystemTime(1000);
      const { controller, live, audio } = createController();
      await controller.startWithLanguages({ A: "ru", B: "es" });
      emitVoice(audio, true);
      live.emit({ type: "session.input_transcript.delta", delta: "Где находится станция?", start_ms: 0, end_ms: 100 });
      emitVoice(audio, false);
      const sourceId = controller.session.activeTurn!.id;
      live.emit({ type: "session.output_transcript.delta", delta: "La estación está ",
        ...(timed ? { start_ms: 100, end_ms: 200 } : {}) });
      const outputId = controller.captionBlocks.find(block => block.kind === "output")!.outputId;
      vi.setSystemTime(1100);
      const source = () => live.emit({ type: "session.input_transcript.delta", delta: "¿Está muy lejos?", start_ms: 250, end_ms: 350 });
      const suffix = () => live.emit({ type: "session.output_transcript.delta", delta: "muy cerca.",
        ...(timed ? { start_ms: 200, end_ms: 300 } : {}) });
      if (asrFirst) { source(); suffix(); } else { suffix(); source(); }
      emitVoice(audio, false);
      await vi.advanceTimersByTimeAsync(6000);
      const outputs = controller.captionBlocks.filter(block => block.kind === "output");
      expect(outputs).toEqual([expect.objectContaining({ outputId, text: "La estación está muy cerca.",
        attribution: "unattributed", receivedAtMs: 1000 })]);
      const turn = controller.session.recentTurns.find(turn => turn.id === sourceId)!;
      expect(turn).toMatchObject({ status: "unresolved", outputDeadline: { atMs: 6000, outcome: "unresolved" } });
      expect(turn.translatedText).toBeUndefined();
      const result = { current: controller.currentAttribution, metrics: controller.metrics.snapshot(),
        outputs: outputs.map(({ text, attribution, receivedAtMs }) => ({ text, attribution, receivedAtMs })) };
      expect(result.current).toMatchObject({ matchedTextOutputs: 0, unattributedTextOutputs: 1, matchedAudioOutputs: 0, confirmedSourceSpeechMs: null });
      expect(result.metrics).toMatchObject({ completedTurnCount: 0, noOutputWatchdogCount: 2, unresolvedSourceOutcomeCount: 1, noObservedOutputDeadlineCount: 1, lateOutputAfterDeadlineCount: 0 });
      const decisions = controller.attributionTrace.filter(entry => entry.outputId === outputId && entry.revision !== undefined);
      expect(new Set(decisions.map(entry => entry.revision)).size).toBe(decisions.length);
      await controller.endConversation();
      return result;
    };
    expect(await scenario(true)).toEqual(await scenario(false));
  });

  it.each(["finalized", "incomplete", "rejected"] as const)("retains content-free diagnostics after public End, close=%s", async close => {
    const { controller, live, audio } = createController();
    await controller.startWithLanguages({ A: "ru", B: "es" });
    emitVoice(audio, true);
    live.emit({ type: "session.input_transcript.delta", delta: "Где находится станция?", start_ms: 0, end_ms: 100 });
    live.emit({ type: "session.output_transcript.delta", delta: "La estación está cerca.", start_ms: 100, end_ms: 200 });
    emitVoice(audio, false);
    audio.onPcmReceived?.(1050);
    await vi.advanceTimersByTimeAsync(1600);
    const trace = structuredClone(controller.attributionTrace);
    const captions = structuredClone(controller.captionBlocks);
    const oldTranscript = live.onTranscriptDelta!;
    expect(trace.length).toBeGreaterThan(0);
    if (close === "incomplete") live.close.mockResolvedValue({ finalized: false });
    if (close === "rejected") live.close.mockRejectedValue(new Error("close failed"));
    if (close === "rejected") await expect(controller.endConversation()).rejects.toThrow("close failed");
    else await controller.endConversation();
    expect(controller.session.state).toBe(close === "rejected" ? "ending" : "ended");
    expect(controller.captionBlocks).toEqual(captions);
    expect(controller.attributionTrace).toEqual(trace);
    expect(JSON.stringify(controller.attributionTrace)).not.toMatch(/Где находится|La estación|delta|payload/);
    oldTranscript({ type: "session.output_transcript.delta", delta: "Старое событие." });
    expect(controller.attributionTrace).toEqual(trace);
    expect(controller.currentAttribution).toMatchObject({ matchedTextOutputs: 0, unattributedTextOutputs: 0, unattributedPlaybackCount: 0 });
  });

  it("clears retained diagnostics and attribution before a new conversation", async () => {
    const { controller, live, audio } = createController();
    await controller.startWithLanguages({ A: "ru", B: "es" });
    live.emit({ type: "session.output_transcript.delta", delta: "La estación está cerca.", start_ms: 100, end_ms: 200 });
    const oldGeneration = controller.attributionTrace[0]!.generation;
    const oldTranscript = live.onTranscriptDelta!;
    const oldPcm = audio.onPcmReceived!;
    await controller.endConversation();
    expect(controller.attributionTrace.length).toBeGreaterThan(0);
    oldPcm(2000);
    expect(controller.attributionTrace.some(entry => entry.atMs === 2000)).toBe(false);
    await controller.cancel();
    expect(controller.attributionTrace).toEqual([]);
    await controller.startWithLanguages({ A: "ru", B: "es" });
    oldTranscript({ type: "session.output_transcript.delta", delta: "Старое событие." });
    expect(controller.attributionTrace).toEqual([]);
    expect(controller.captionBlocks).toEqual([]);
    expect(controller.currentAttribution).toMatchObject({ matchedTextOutputs: 0, unattributedTextOutputs: 0, unattributedPlaybackCount: 0 });
    live.emit({ type: "session.output_transcript.delta", delta: "Una conversación nueva." });
    expect(controller.attributionTrace.length).toBeGreaterThan(0);
    expect(controller.attributionTrace.every(entry => entry.generation !== oldGeneration)).toBe(true);
    await controller.endConversation();
  });

  it("bounds retained metadata across routing generations without retaining their candidate state", async () => {
    const { controller, audio } = createController();
    await controller.startWithLanguages({ A: "ru", B: "es" });
    audio.onPcmReceived?.(1000);
    const first = structuredClone(controller.attributionTrace);
    await controller.changeInterlocutorLanguage("en");
    expect(controller.attributionTrace).toEqual(first);
    expect(controller.currentAttribution).toMatchObject({ matchedTextOutputs: 0, unattributedTextOutputs: 0, unattributedPlaybackCount: 0 });
    audio.onPcmReceived?.(1100);
    expect(controller.attributionTrace.at(-1)!.generation).not.toBe(first[0]!.generation);
    for (let index = 0; index < 200; index++) audio.onPcmReceived?.(1200 + index);
    const beforeReset = structuredClone(controller.attributionTrace);
    expect(beforeReset).toHaveLength(128);
    expect(beforeReset[0]!.atMs).toBe(1272);
    await controller.changeInterlocutorLanguage("es");
    expect(controller.attributionTrace).toEqual(beforeReset);
    await controller.endConversation();
    expect(controller.attributionTrace).toEqual(beforeReset);
  });
});


describe("output evidence across source callback order", () => {
  beforeEach(() => { vi.useFakeTimers(); vi.setSystemTime(1000); });

  it.each(["»", "!"])("keeps an untimed neutral suffix on its timed output: %s", async suffix => {
    const { controller, live, audio } = createController();
    await controller.startWithLanguages({ A: "ru", B: "es" });
    emitVoice(audio, true);
    live.emit({ type: "session.input_transcript.delta", delta: "Где находится посылка?", start_ms: 100, end_ms: 1000 });
    const prefix = suffix === "»" ? "«El paquete está aquí." : "El paquete está aquí.";
    live.emit({ type: "session.output_transcript.delta", delta: prefix, start_ms: 600, end_ms: 1300 });
    const first = controller.captionBlocks.find(block => block.kind === "output")!;
    vi.setSystemTime(1100);
    live.emit({ type: "session.output_transcript.delta", delta: suffix });
    expect(controller.captionBlocks.filter(block => block.kind === "output")).toEqual([
      expect.objectContaining({ outputId: first.outputId, text: prefix + suffix, receivedAtMs: 1000, attribution: "matched" }),
    ]);
    const root = document.createElement("div");
    root.innerHTML = renderToStaticMarkup(createElement(ConversationScreen, { controller }));
    expect([...root.querySelectorAll('[data-testid="participant-pane-B"] li')].map(row => row.textContent)).toEqual(["Él: " + prefix + suffix]);
    expect(root.querySelectorAll(".unattributed-output li")).toHaveLength(0);
    expect(controller.currentAttribution).toMatchObject({ matchedTextOutputs: 1, unattributedTextOutputs: 0 });
    await controller.endConversation();
  });

  it.each([
    ["Я использую ", "Google.", "adjacent"],
    ["Я использую ", "Google.", "overlap"],
    ["Я использую ", "Google.", "untimed"],
    ["Я ", "использую сервис.", "adjacent"],
    ["Я ", "использую сервис.", "overlap"],
    ["Я ", "использую сервис.", "untimed"],
  ])("keeps the same raw output and outcomes across ASR order: %s%s (%s)", async (prefix, suffix, timing) => {
    const scenario = async (sourceFirst: boolean) => {
      vi.setSystemTime(1000);
      const { controller, live, audio } = createController();
      await controller.startWithLanguages({ A: "ru", B: "en" });
      emitVoice(audio, true);
      live.emit({ type: "session.input_transcript.delta", delta: "I use this service every day.", start_ms: 0, end_ms: 100 });
      live.emit({ type: "session.output_transcript.delta", delta: prefix, start_ms: 100, end_ms: 200 });
      const first = controller.captionBlocks.find(block => block.kind === "output")!;
      vi.setSystemTime(1100);
      const source = () => live.emit({ type: "session.input_transcript.delta", delta: "Я тоже каждый день пользуюсь этим сервисом.", start_ms: 150, end_ms: 350 });
      const output = () => live.emit({ type: "session.output_transcript.delta", delta: suffix,
        ...(timing === "untimed" ? {} : { start_ms: timing === "adjacent" ? 200 : 150, end_ms: timing === "adjacent" ? 300 : 200 }) });
      if (sourceFirst) { source(); output(); } else { output(); source(); }
      emitVoice(audio, false);
      await vi.advanceTimersByTimeAsync(6000);
      const outputs = controller.captionBlocks.filter(block => block.kind === "output");
      expect(outputs).toEqual([expect.objectContaining({ outputId: first.outputId, text: prefix + suffix, side: "A", receivedAtMs: 1000, attribution: "unattributed" })]);
      expect(controller.currentAttribution).toMatchObject({ matchedTextOutputs: 0, unattributedTextOutputs: 1, matchedAudioOutputs: 0, confirmedSourceSpeechMs: null });
      const metrics = structuredClone(controller.metrics.snapshot());
      expect(metrics).toMatchObject({ completedTurnCount: 0, noOutputWatchdogCount: 2, unresolvedSourceOutcomeCount: 1, noObservedOutputDeadlineCount: 1 });
      const root = document.createElement("div");
      root.innerHTML = renderToStaticMarkup(createElement(ConversationScreen, { controller }));
      expect([...root.querySelectorAll('[data-testid="participant-pane-A"] li')].map(row => row.textContent)).toContain(prefix + suffix);
      expect(root.querySelectorAll(".unattributed-output li")).toHaveLength(0);
      const trace = structuredClone(controller.attributionTrace);
      const decisions = trace.filter(entry => entry.outputId === first.outputId && entry.revision !== undefined);
      expect(new Set(decisions.map(entry => entry.revision)).size).toBe(decisions.length);
      const current = controller.currentAttribution;
      await vi.advanceTimersByTimeAsync(1000);
      expect(controller.currentAttribution).toEqual(current);
      expect(controller.metrics.snapshot()).toEqual(metrics);
      expect(controller.attributionTrace).toEqual(trace);
      // A real intermediate match/revocation remains history even when the final evidence agrees.
      const { attributionRevokedCount, ...outcomes } = metrics;
      expect(attributionRevokedCount).toBe(prefix === "Я " && sourceFirst ? 0 : 1);
      const result = { current, outcomes, outputs: outputs.map(({ text, side, attribution, receivedAtMs }) => ({ text, side, attribution, receivedAtMs })) };
      await controller.endConversation();
      return result;
    };
    expect(await scenario(true)).toEqual(await scenario(false));
  });
});


it.each([true, false].flatMap(sourceFirst => [false, true].flatMap(timed =>
  (timed ? [["Да", "Where is the train station?"], ["Да ", "Where is the train station?"], ["Да ", " Where is the train station?"]]
    : [["Да", "Where is the train station?"]])
    .map(([opening, question]) => ({ sourceFirst, timed, opening: opening!, question: question! })),
)))("keeps an undecided prefix separate: ASR first=$sourceFirst, timed=$timed, $opening/$question", async ({ sourceFirst, timed, opening, question }) => {
  vi.useFakeTimers(); vi.setSystemTime(1000);
  const { controller, live, audio } = createController();
  await controller.startWithLanguages({ A: "ru", B: "en" });
  emitVoice(audio, true);
  live.emit({ type: "session.input_transcript.delta", delta: "Yes, I understand you.", ...(timed ? { start_ms: 0, end_ms: 100 } : {}) });
  live.emit({ type: "session.output_transcript.delta", delta: opening, ...(timed ? { start_ms: 100, end_ms: 200 } : {}) });
  const prefix = controller.captionBlocks.find(block => block.kind === "output")!;
  vi.setSystemTime(1100);
  const source = () => live.emit({ type: "session.input_transcript.delta", delta: "Подскажите, где находится вокзал?", ...(timed ? { start_ms: 500, end_ms: 800 } : {}) });
  const output = () => live.emit({ type: "session.output_transcript.delta", delta: question, ...(timed ? { start_ms: 1000, end_ms: 1200 } : {}) });
  if (sourceFirst) { source(); output(); } else { output(); source(); }
  await vi.advanceTimersByTimeAsync(runtime.captionIdleMs);
  const outputs = controller.captionBlocks.filter(block => block.kind === "output");
  expect(outputs).toEqual([
    expect.objectContaining({ outputId: prefix.outputId, text: opening, side: undefined, receivedAtMs: 1000, attribution: "unattributed" }),
    expect.objectContaining({ text: question, side: "B", receivedAtMs: 1100, attribution: "unattributed" }),
  ]);
  expect(outputs[1]!.outputId).not.toBe(prefix.outputId);
  expect(controller.currentAttribution).toMatchObject({ matchedTextOutputs: 0, unattributedTextOutputs: 2 });
  const root = document.createElement("div");
  root.innerHTML = renderToStaticMarkup(createElement(ConversationScreen, { controller }));
  expect([...root.querySelectorAll(".unattributed-output li")].map(row => row.textContent)).toEqual(["Да"]);
  expect([...root.querySelectorAll('[data-testid="participant-pane-B"] li')].map(row => row.textContent)).toContain("Where is the train station?");
  await controller.endConversation();
});

it.each([
  { A: "fr", B: "ru", openings: ["là ", "la\u0300 "], source: "Да, я вас понимаю.",
    nextSource: "Où est la gare, s'il vous plaît ?", question: " Где находится вокзал?" },
  { A: "ru", B: "en", openings: ["Да ", "Да\u0301 "], source: "Yes, I understand you.",
    nextSource: "Подскажите, где находится вокзал?", question: " Where is the train station?" },
].flatMap(row => row.openings.flatMap(opening => [false, true].map(sourceFirst => ({ ...row, opening, sourceFirst })))))("separates Unicode spaced prefixes without changing raw text: $A $opening ASR first=$sourceFirst", async ({ A, B, source, nextSource, question, opening, sourceFirst }) => {
  vi.useFakeTimers(); vi.setSystemTime(1000);
  const { controller, live, audio } = createController();
  await controller.startWithLanguages({ A, B });
  emitVoice(audio, true);
  live.emit({ type: "session.input_transcript.delta", delta: source, start_ms: 0, end_ms: 100 });
  live.emit({ type: "session.output_transcript.delta", delta: opening, start_ms: 100, end_ms: 200 });
  const first = controller.captionBlocks.find(block => block.kind === "output")!;
  vi.setSystemTime(1100);
  const input = () => live.emit({ type: "session.input_transcript.delta", delta: nextSource, start_ms: 500, end_ms: 800 });
  const output = () => live.emit({ type: "session.output_transcript.delta", delta: question, start_ms: 1000, end_ms: 1200 });
  if (sourceFirst) { input(); output(); } else { output(); input(); }
  await vi.advanceTimersByTimeAsync(runtime.captionIdleMs);
  const outputs = controller.captionBlocks.filter(block => block.kind === "output");
  expect(outputs).toEqual([
    expect.objectContaining({ outputId: first.outputId, text: opening, side: undefined, receivedAtMs: 1000, attribution: "unattributed" }),
    expect.objectContaining({ text: question, side: "B", receivedAtMs: 1100, attribution: "unattributed" }),
  ]);
  expect(outputs[1]!.outputId).not.toBe(first.outputId);
  expect(controller.currentAttribution).toMatchObject({ matchedTextOutputs: 0, unattributedTextOutputs: 2 });
  await controller.endConversation();
});


it.each([["Я", " использую Google."], ["Я ис", "пользую Google."], ["Гу", "гл."]])("refines an undecided continuation without losing its first receipt: %s%s", async (prefix, suffix) => {
  vi.useFakeTimers(); vi.setSystemTime(1000);
  const { controller, live, audio } = createController();
  await controller.startWithLanguages({ A: "ru", B: "en" });
  emitVoice(audio, true);
  live.emit({ type: "session.input_transcript.delta", delta: "I use this service every day.", start_ms: 0, end_ms: 100 });
  live.emit({ type: "session.output_transcript.delta", delta: prefix, start_ms: 100, end_ms: 200 });
  const first = controller.captionBlocks.find(block => block.kind === "output")!;
  vi.setSystemTime(1100);
  live.emit({ type: "session.output_transcript.delta", delta: suffix, start_ms: 200, end_ms: 300 });
  expect(controller.captionBlocks.filter(block => block.kind === "output")).toEqual([
    expect.objectContaining({ outputId: first.outputId, text: prefix + suffix, side: "A", attribution: "matched", receivedAtMs: 1000 }),
  ]);
  expect(controller.currentAttribution).toMatchObject({ matchedTextOutputs: 1, unattributedTextOutputs: 0 });
  await controller.endConversation();
});

it.each([150, 200])("keeps a mixed-script word with its pending output at provider start %s", async startMs => {
  vi.useFakeTimers(); vi.setSystemTime(1000);
  const { controller, live, audio } = createController();
  await controller.startWithLanguages({ A: "ru", B: "en" });
  emitVoice(audio, true);
  live.emit({ type: "session.input_transcript.delta", delta: "Zoom is convenient to use.", start_ms: 0, end_ms: 100 });
  live.emit({ type: "session.output_transcript.delta", delta: "Zoom", start_ms: 100, end_ms: 200 });
  const first = controller.captionBlocks.find(block => block.kind === "output")!;
  vi.setSystemTime(1100);
  live.emit({ type: "session.output_transcript.delta", delta: "ом удобно пользоваться.", start_ms: startMs, end_ms: 400 });
  expect(controller.captionBlocks.filter(block => block.kind === "output")).toEqual([
    expect.objectContaining({ outputId: first.outputId, text: "Zoomом удобно пользоваться.", side: "A", receivedAtMs: 1000, attribution: "matched" }),
  ]);
  expect(controller.currentAttribution).toMatchObject({ matchedTextOutputs: 1, unattributedTextOutputs: 0, matchedAudioOutputs: 0 });
  const root = document.createElement("div");
  root.innerHTML = renderToStaticMarkup(createElement(ConversationScreen, { controller }));
  expect([...root.querySelectorAll('[data-testid="participant-pane-A"] li')].map(row => row.textContent)).toEqual(["Он: Zoomом удобно пользоваться."]);
  expect(root.querySelectorAll(".unattributed-output li")).toHaveLength(0);
  await controller.endConversation();
});

it.each([
  { A: "ru", B: "en", prefix: "Я ис", suffix: "пользую приложение.", source: "I use the application every day." },
  { A: "es", B: "en", prefix: "Uti", suffix: "lizo la aplicación.", source: "I use the application every day." },
  { A: "pt", B: "en", prefix: "Eu uti", suffix: "lizo o aplicativo.", source: "I use the application every day." },
  { A: "de", B: "en", prefix: "Ich ve", suffix: "rwende die Anwendung.", source: "I use the application every day." },
  { A: "fr", B: "en", prefix: "Je re", suffix: "garde la télévision.", source: "I watch television every day." },
  { A: "en", B: "ru", prefix: "Thank y", suffix: "ou very much.", source: "Спасибо большое за вашу помощь." },
  { A: "it", B: "en", prefix: "Sto uti", suffix: "lizzando l'applicazione.", source: "I am using the application every day." },
  { A: "ru", B: "en", prefix: "Я ", suffix: "использую приложение.", source: "I use the application every day." },
  { A: "ru", B: "en", prefix: "Zoom", suffix: "ом удобно пользоваться.", source: "Zoom is convenient to use." },
  { A: "ru", B: "en", prefix: "Zoom\u0301\u0323", suffix: "ом удобно пользоваться.", source: "Zoom is convenient to use." },
  { A: "fr", B: "en", prefix: "L'", suffix: "application fonctionne correctement.", source: "The application works correctly." },
  { A: "it", B: "en", prefix: "L’", suffix: "applicazione funziona correttamente.", source: "The application works correctly." },
  { A: "en", B: "ru", prefix: "Self-", suffix: "service is available.", source: "Самообслуживание доступно каждому посетителю." },
  { A: "fr", B: "en", prefix: "Je pre\u0301", suffix: "pare le repas.", source: "I am preparing the meal." },
].flatMap(row => [1, 20].map(gap => ({ ...row, gap }))))("keeps a word across an output interval gap: $A $gap ms ($prefix | $suffix)", async ({ A, B, prefix, suffix, source, gap }) => {
  vi.useFakeTimers(); vi.setSystemTime(1000);
  const { controller, live, audio } = createController();
  await controller.startWithLanguages({ A, B });
  emitVoice(audio, true);
  live.emit({ type: "session.input_transcript.delta", delta: source, start_ms: 0, end_ms: 100 });
  live.emit({ type: "session.output_transcript.delta", delta: prefix, start_ms: 100, end_ms: 200 });
  const first = controller.captionBlocks.find(block => block.kind === "output")!;
  vi.setSystemTime(1100);
  live.emit({ type: "session.output_transcript.delta", delta: suffix, start_ms: 200 + gap, end_ms: 400 });
  await vi.advanceTimersByTimeAsync(runtime.captionIdleMs);
  expect(controller.captionBlocks.filter(block => block.kind === "output")).toEqual([
    expect.objectContaining({ outputId: first.outputId, text: prefix + suffix, side: "A", receivedAtMs: 1000 }),
  ]);
  expect(controller.currentAttribution).toMatchObject({ matchedTextOutputs: 1, unattributedTextOutputs: 0, matchedAudioOutputs: 0 });
  await controller.endConversation();
});

it.each(["?", " ?"].flatMap(suffix => [1, 20].map(gap => ({ suffix, gap }))))("keeps a neutral suffix across an output interval gap: $suffix $gap ms", async ({ suffix, gap }) => {
  vi.useFakeTimers(); vi.setSystemTime(1000);
  const { controller, live, audio } = createController();
  await controller.startWithLanguages({ A: "en", B: "ru" });
  emitVoice(audio, true);
  live.emit({ type: "session.input_transcript.delta", delta: "Спасибо большое за вашу помощь.", start_ms: 0, end_ms: 100 });
  live.emit({ type: "session.output_transcript.delta", delta: "Thank y", start_ms: 100, end_ms: 200 });
  const first = controller.captionBlocks.find(block => block.kind === "output")!;
  vi.setSystemTime(1100);
  live.emit({ type: "session.output_transcript.delta", delta: suffix, start_ms: 200 + gap, end_ms: 400 });
  await vi.advanceTimersByTimeAsync(runtime.captionIdleMs);
  expect(controller.captionBlocks.filter(block => block.kind === "output")).toEqual([
    expect.objectContaining({ outputId: first.outputId, text: "Thank y" + suffix, receivedAtMs: 1000 }),
  ]);
  await controller.endConversation();
});


describe("PR44 comment regressions", () => {
  beforeEach(() => { vi.useFakeTimers(); vi.setSystemTime(1000); });

  it("returns to listening after the last standalone output binds to a failed source", async () => {
    const { controller, live, audio } = createController();
    await controller.startWithLanguages({ A: "en", B: "es" });
    emitVoice(audio, true);
    live.emit({ type: "session.input_transcript.delta", delta: "Where is the train station?", start_ms: 0, end_ms: 1000 });
    const sourceId = controller.session.activeTurn!.id;
    emitVoice(audio, false);
    await vi.advanceTimersByTimeAsync(5001);
    live.emit({ type: "session.input_transcript.delta", delta: "Thank y", start_ms: 100, end_ms: 200 });
    live.emit({ type: "session.output_transcript.delta", delta: "La estación está cerca.", start_ms: 500, end_ms: 1500 });
    expect(controller.session.pendingTurns).toHaveLength(1);
    live.emit({ type: "session.input_transcript.delta", delta: "ou very much.", start_ms: 200, end_ms: 300 });
    await vi.advanceTimersByTimeAsync(2000);
    expect(controller.session.recentTurns.find(turn => turn.id === sourceId)?.status).toBe("failed");
    expect(controller.session.pendingTurns).toEqual([]);
    expect(controller.session.activeTurn).toBeUndefined();
    expect(controller.session.state).toBe("listening");
    live.appendInstructions.mockImplementation(async (_text, policy) => {
      (LiveClient.prototype as unknown as { assertSteeringAllowed(policy: unknown): void }).assertSteeringAllowed.call(live, policy);
      return { eventId: "change-language" };
    });
    await controller.changeInterlocutorLanguage("de");
    expect(controller.session.participantB.language).toBe("de");
    expect(controller.session.state).toBe("listening");
    await controller.endConversation();
  });

  it("counts one late receipt once when the same source binding is revoked and restored", async () => {
    const { controller, live, audio } = createController();
    await controller.startWithLanguages({ A: "ru", B: "es" });
    emitVoice(audio, true);
    live.emit({ type: "session.input_transcript.delta", delta: "Где находится станция?", start_ms: 0, end_ms: 1000 });
    emitVoice(audio, false);
    await vi.advanceTimersByTimeAsync(5001);
    live.emit({ type: "session.output_transcript.delta", delta: "La estación está cerca.", start_ms: 500, end_ms: 1500 });
    const first = controller.captionBlocks.find(block => block.kind === "output")!;
    expect(controller.metrics.snapshot().lateOutputAfterDeadlineCount).toBe(1);
    vi.setSystemTime(6101);
    live.emit({ type: "session.input_transcript.delta", delta: "у", start_ms: 200, end_ms: 300 });
    expect(controller.currentAttribution.matchedTextOutputs).toBe(0);
    vi.setSystemTime(6201);
    live.emit({ type: "session.input_transcript.delta", delta: "лица.", start_ms: 300, end_ms: 400 });
    expect(controller.currentAttribution.matchedTextOutputs).toBe(1);
    expect(controller.captionBlocks.filter(block => block.kind === "output")).toEqual([expect.objectContaining({
      outputId: first.outputId, receivedAtMs: 6001, text: first.text,
    })]);
    expect(controller.metrics.snapshot().lateOutputAfterDeadlineCount).toBe(1);
    expect(controller.metrics.snapshot().attributionRevokedCount).toBe(1);
    await controller.endConversation();
  });

  it("retains a bounded provider diagnostic snapshot after End and clears it for the next conversation", async () => {
    const first = Object.assign(new FakeLive(), { diagnostics: new LiveDiagnostics() });
    const next = Object.assign(new FakeLive(), { diagnostics: new LiveDiagnostics() });
    const third = Object.assign(new FakeLive(), { diagnostics: new LiveDiagnostics() });
    const { controller } = createController({ lives: [first, next, third] });
    await controller.startWithLanguages({ A: "ru", B: "es" });
    for (let index = 0; index < 40; index++) first.diagnostics.observe("unknown_event", `session.future.${index}`, index);
    first.diagnostics.observe("provider_error", "error", 1000);
    const expected = structuredClone(first.diagnostics.entries);
    await controller.endConversation();
    const diagnostics = (controller as unknown as { providerDiagnostics: typeof expected }).providerDiagnostics;
    expect(diagnostics).toEqual(expected);
    expect(diagnostics).toHaveLength(2);
    expect(diagnostics.find(entry => entry.kind === "unknown_event")).toMatchObject({ type: "unknown_event", count: 40 });
    first.diagnostics.observe("provider_error", "error", 2000);
    expect((controller as unknown as { providerDiagnostics: typeof expected }).providerDiagnostics).toEqual(expected);
    await controller.cancel();
    expect((controller as unknown as { providerDiagnostics: typeof expected }).providerDiagnostics).toEqual([]);
    await controller.startWithLanguages({ A: "ru", B: "es" });
    expect((controller as unknown as { providerDiagnostics: typeof expected }).providerDiagnostics).toEqual([]);
  });
});


it("offers conditional recovery for a fresh silent source after an earlier completed played translation", async () => {
  vi.useFakeTimers(); vi.setSystemTime(1000);
  const { controller, live, audio } = createController();
  await controller.startWithLanguages({ A: "ru", B: "es" });
  emitVoice(audio, true);
  live.emit({ type: "session.input_transcript.delta", delta: "Где находится станция?", start_ms: 0, end_ms: 1000 });
  live.emit({ type: "session.output_transcript.delta", delta: "La estación está cerca.", start_ms: 500, end_ms: 1500 });
  emitVoice(audio, false);
  audio.onPcmReceived?.(1000);
  emitPlayback(audio, true);
  vi.setSystemTime(1500); emitPlayback(audio, false);
  await vi.advanceTimersByTimeAsync(1500);
  expect(controller.session.recentTurns.some(turn => turn.status === "completed")).toBe(true);
  emitVoice(audio, true);
  live.emit({ type: "session.input_transcript.delta", delta: "¿Puedo ir a pie hasta la estación?", start_ms: 3000, end_ms: 4000 });
  const laterId = controller.session.activeTurn!.id;
  emitVoice(audio, false);
  await vi.advanceTimersByTimeAsync(5001);
  const later = controller.session.recentTurns.find(turn => turn.id === laterId)!;
  // PCM has no provider/source boundary: the current evidence cannot prove absence for this ASR episode.
  expect(later.outputDeadline?.outcome).toBe("unresolved");
  expect(controller.recoveryPrompt).toBe("conditional-repeat");
  expect(controller.metrics.snapshot().noObservedOutputDeadlineCount).toBe(0);
  emitVoice(audio, true);
  expect(controller.recoveryPrompt).toBeUndefined();
  audio.onPcmReceived?.(Date.now());
  emitPlayback(audio, true); emitPlayback(audio, false);
  expect(controller.recoveryPrompt).toBeUndefined();
  expect(controller.recoveryPromptIsTurnFailure).toBe(false);
  await controller.endConversation();
});

it.each(["content", "expired"])("surfaces the documented terminal Live session reason %s", async reason => {
  vi.useFakeTimers(); vi.setSystemTime(1000);
  const { controller, live, audio } = createController();
  await controller.startWithLanguages({ A: "ru", B: "es" });
  vi.spyOn(console, "error").mockImplementation(() => {});
  live.emitSessionClosed(reason);
  expect(controller.session.state).toBe("error");
  expect(controller.ownerError).toBe(CONNECTION_ERROR_MESSAGE);
  expect(audio.getCaptureStream()).toBeNull();
});


it("gates conditional recovery on playback and clears it for verified late translation", async () => {
  vi.useFakeTimers(); vi.setSystemTime(1000);
  const { controller, live, audio } = createController();
  await controller.startWithLanguages({ A: "ru", B: "es" });
  emitVoice(audio, true);
  live.emit({ type: "session.input_transcript.delta", delta: "Где находится станция?", start_ms: 0, end_ms: 1000 });
  emitVoice(audio, false);
  audio.onPcmReceived?.(1000);
  await vi.advanceTimersByTimeAsync(5001);
  expect(controller.session.recentTurns[0]?.outputDeadline?.outcome).toBe("unresolved");
  expect(controller.recoveryPrompt).toBe("conditional-repeat");
  emitPlayback(audio, true);
  expect(controller.recoveryPrompt).toBeUndefined();
  emitPlayback(audio, false);
  expect(controller.recoveryPrompt).toBe("conditional-repeat");
  live.emit({ type: "session.output_transcript.delta", delta: "La estación está cerca.", start_ms: 500, end_ms: 1500 });
  expect(controller.currentAttribution.matchedTextOutputs).toBe(1);
  expect(controller.recoveryPrompt).toBeUndefined();
  await controller.endConversation();
  expect(controller.recoveryPrompt).toBeUndefined();
});


it.each(["language-change", "end"])("dismisses unresolved conditional recovery on %s without reviving it on PCM", async boundary => {
  vi.useFakeTimers(); vi.setSystemTime(1000);
  const { controller, live, audio } = createController();
  await controller.startWithLanguages({ A: "ru", B: "es" });
  emitVoice(audio, true);
  live.emit({ type: "session.input_transcript.delta", delta: "Где находится станция?", start_ms: 0, end_ms: 1000 });
  emitVoice(audio, false);
  audio.onPcmReceived?.(1000);
  await vi.advanceTimersByTimeAsync(5001);
  expect(controller.recoveryPrompt).toBe("conditional-repeat");
  if (boundary === "language-change") await controller.changeInterlocutorLanguage("de");
  else await controller.endConversation();
  expect(controller.recoveryPrompt).toBeUndefined();
  audio.onPcmReceived?.(Date.now());
  emitPlayback(audio, true); emitPlayback(audio, false);
  expect(controller.recoveryPrompt).toBeUndefined();
  if (boundary === "language-change") await controller.endConversation();
});


it.each(["none", "pcm", "late-text"])("retains A's unseen timeout through B's continued speech and completion, evidence=%s", async evidence => {
  vi.useFakeTimers(); vi.setSystemTime(1000);
  const { controller, live, audio } = createController();
  await controller.startWithLanguages({ A: "ru", B: "en" });
  emitVoice(audio, true);
  live.emit({ type: "session.input_transcript.delta", delta: "Где находится станция?", start_ms: 2000, end_ms: 3000 });
  const failedId = controller.session.activeTurn!.id;
  emitVoice(audio, false);
  vi.setSystemTime(2000); emitVoice(audio, true);
  // ASR delivery order need not be provider-time order; the earlier B interval can be isolated independently.
  live.emit({ type: "session.input_transcript.delta", delta: "The station is nearby", start_ms: 0, end_ms: 1000 });
  const otherId = controller.session.activeTurn!.id;
  expect(otherId).not.toBe(failedId);
  if (evidence === "late-text") {
    vi.setSystemTime(5900);
    live.emit({ type: "session.output_transcript.delta", delta: "Thank y", start_ms: 2500, end_ms: 2600 });
  }
  await vi.advanceTimersByTimeAsync(6001 - Date.now());
  expect(controller.session.recentTurns.find(turn => turn.id === failedId)?.outputDeadline?.outcome)
    .toBe(evidence === "late-text" ? "unresolved" : "no_observed_output");
  expect(controller.session.activeTurn?.id).toBe(otherId);
  expect(controller.recoveryPrompt).toBeUndefined();
  // A second VAD notification and an ASR continuation belong to B, who was already speaking before A failed.
  emitVoice(audio, true);
  live.emit({ type: "session.input_transcript.delta", delta: ", just around the corner.", start_ms: 1000, end_ms: 1100 });
  live.emit({ type: "session.output_transcript.delta", delta: "Станция рядом, за углом.", start_ms: 500, end_ms: 1500 });
  expect(controller.captionBlocks.find(block => block.text === "Станция рядом, за углом.")?.attribution).toBe("matched");
  if (evidence === "pcm") audio.onPcmReceived?.(Date.now());
  emitVoice(audio, false);
  await vi.advanceTimersByTimeAsync(1500);
  expect(controller.session.activeTurn).toBeUndefined();
  expect(controller.session.pendingTurns).toEqual([]);
  if (evidence === "late-text") {
    expect(controller.captionBlocks.find(block => block.text === "Thank y")?.attribution).toBe("matched");
    expect(controller.recoveryPrompt).toBeUndefined();
  } else {
    expect(controller.recoveryPrompt).toBe(evidence === "none" ? "repeat" : "conditional-repeat");
    expect(controller.recoveryPromptSide).toBe("A");
    emitVoice(audio, true);
    expect(controller.recoveryPrompt).toBeUndefined();
    audio.onPcmReceived?.(Date.now());
    expect(controller.recoveryPrompt).toBeUndefined();
  }
  await controller.endConversation();
});


it.each(["late-output", "acknowledgement"])("retains B's unseen timeout after A's %s", async resolution => {
  vi.useFakeTimers(); vi.setSystemTime(1000);
  const { controller, live, audio } = createController();
  await controller.startWithLanguages({ A: "ru", B: "en" });
  emitVoice(audio, true);
  live.emit({ type: "session.input_transcript.delta", delta: "Где находится станция?", start_ms: 0, end_ms: 1000 });
  const aId = controller.session.activeTurn!.id;
  emitVoice(audio, false);
  vi.setSystemTime(1100); emitVoice(audio, true);
  live.emit({ type: "session.input_transcript.delta", delta: "The station is nearby.", start_ms: 2000, end_ms: 3000 });
  const bId = controller.session.activeTurn!.id;
  emitVoice(audio, false);
  if (resolution === "late-output") {
    vi.setSystemTime(5900);
    live.emit({ type: "session.output_transcript.delta", delta: "W", start_ms: 500, end_ms: 600 });
  }
  await vi.advanceTimersByTimeAsync(6101 - Date.now());
  expect(controller.session.recentTurns.filter(turn => turn.outputDeadline).map(turn => turn.id)).toEqual([aId, bId]);
  expect(controller.recoveryPrompt).toBe(resolution === "late-output" ? "conditional-repeat" : "repeat");
  expect(controller.recoveryPromptSide).toBe("A");
  live.onError?.({ type: "error", error: { message: "recoverable interruption" } });
  expect(controller.recoveryPromptSide).toBe("A");
  if (resolution === "late-output") {
    expect(controller.captionBlocks.find(block => block.text === "W")?.attribution).toBe("unattributed");
    live.emit({ type: "session.output_transcript.delta", delta: "here is the station?", start_ms: 600, end_ms: 1500 });
    expect(controller.captionBlocks.find(block => block.text === "Where is the station?")?.attribution).toBe("matched");
  } else {
    emitVoice(audio, true);
    expect(controller.recoveryPrompt).toBeUndefined();
    emitVoice(audio, false);
    await vi.advanceTimersByTimeAsync(5001);
  }
  expect(controller.recoveryPrompt).toBe("repeat");
  expect(controller.recoveryPromptSide).toBe("B");
  await controller.endConversation();
});

it.each([undefined, "append-123"])("offers private nonfatal recovery for a valid post-start error, client event %s", async clientEventId => {
  const { controller, live, audio } = createController();
  await controller.startWithLanguages({ A: "ru", B: "es" });
  const parser = new LiveClient({ backend: {} as BackendClient, peerFactory: () => { throw new Error("Network is not used"); }, onRemoteStream: vi.fn() });
  const channel = parser as unknown as { started: boolean; handleChannelMessage(event: MessageEvent<string>): void };
  channel.started = true;
  parser.onError = event => live.onError?.(event as FakeLiveErrorEvent);
  channel.handleChannelMessage(new MessageEvent("message", { data: JSON.stringify({ type: "error",
    error: { message: "private patient details", code: null, ...(clientEventId ? { client_event_id: clientEventId } : {}) } }) }));
  expect(controller.session.state).toBe("listening");
  expect(controller.inputReady).toBe(true);
  expect(audio.captureTrack.enabled).toBe(true);
  expect(controller.ownerError).toBeUndefined();
  expect(controller.recoveryPrompt).toBe("conditional-repeat");
  expect(controller.recoveryPromptSide).toBeUndefined();
  const markup = renderToStaticMarkup(createElement(ConversationScreen, { controller }));
  expect(markup).toContain("Если перевод не прозвучал, повторите реплику");
  expect(markup).not.toContain("private patient details");
  emitPlayback(audio, true);
  expect(controller.recoveryPrompt).toBeUndefined();
  emitPlayback(audio, false);
  expect(controller.recoveryPrompt).toBe("conditional-repeat");
  live.emit({ type: "session.output_transcript.delta", delta: "La estación está cerca." });
  expect(controller.recoveryPrompt).toBeUndefined();
  await controller.endConversation();
});

it("does not offer nonfatal recovery for a malformed provider error", async () => {
  vi.spyOn(console, "error").mockImplementation(() => {});
  const { controller, live } = createController();
  await controller.startWithLanguages({ A: "ru", B: "es" });
  const parser = new LiveClient({ backend: {} as BackendClient, peerFactory: () => { throw new Error("Network is not used"); }, onRemoteStream: vi.fn() });
  const channel = parser as unknown as { started: boolean; handleChannelMessage(event: MessageEvent<string>): void };
  channel.started = true;
  parser.onError = event => live.onError?.(event as FakeLiveErrorEvent);
  channel.handleChannelMessage(new MessageEvent("message", { data: JSON.stringify({ type: "error", error: { message: 42 } }) }));
  expect(controller.recoveryPrompt).toBeUndefined();
  expect(parser.diagnostics.entries.some(entry => entry.kind === "provider_error")).toBe(false);
  expect(controller.session.state).toBe("error");
  expect(controller.ownerError).toBe(CONNECTION_ERROR_MESSAGE);
});


it.each(["speech", "transcript", "pcm", "language", "end"])("dismisses provider recovery on %s without reviving it on old playback", async boundary => {
  vi.useFakeTimers(); vi.setSystemTime(1000);
  const { controller, live, audio } = createController();
  await controller.startWithLanguages({ A: "ru", B: "es" });
  live.onError?.({ type: "error", error: { message: "recoverable interruption" } });
  expect(controller.recoveryPrompt).toBe("conditional-repeat");
  if (boundary === "speech") emitVoice(audio, true);
  if (boundary === "transcript") live.emit({ type: "session.input_transcript.delta", delta: "Где находится станция?" });
  if (boundary === "pcm") audio.onPcmReceived?.(Date.now());
  if (boundary === "language") await controller.changeInterlocutorLanguage("de");
  if (boundary === "end") await controller.endConversation();
  expect(controller.recoveryPrompt).toBeUndefined();
  emitPlayback(audio, true); emitPlayback(audio, false);
  expect(controller.recoveryPrompt).toBeUndefined();
  if (boundary !== "end") await controller.endConversation();
});


it("dismisses the presented A hint when a new B source arrives through ASR without VAD", async () => {
  vi.useFakeTimers(); vi.setSystemTime(1000);
  const { controller, live, audio } = createController();
  await controller.startWithLanguages({ A: "ru", B: "es" });
  emitVoice(audio, true);
  live.emit({ type: "session.input_transcript.delta", delta: "Где находится станция?", start_ms: 0, end_ms: 1000 });
  const aId = controller.session.activeTurn!.id;
  emitVoice(audio, false);
  await vi.advanceTimersByTimeAsync(5001);
  expect(controller.inputReady).toBe(true);
  expect(controller.recoveryPrompt).toBe("repeat");
  expect(controller.recoveryPromptSide).toBe("A");
  vi.setSystemTime(6002);
  // ASR itself accepts a new source; no VAD-active event precedes it.
  live.emit({ type: "session.input_transcript.delta", delta: "La estación está cerca.", start_ms: 2000, end_ms: 3000 });
  const bId = controller.session.activeTurn!.id;
  expect(bId).not.toBe(aId);
  expect(controller.session.activeTurn?.speaker).toBe("B");
  expect(controller.recoveryPrompt).toBeUndefined();
  await vi.advanceTimersByTimeAsync(5001);
  expect(controller.session.recentTurns.filter(turn => turn.outputDeadline).map(turn => turn.id)).toEqual([aId, bId]);
  expect(controller.recoveryPrompt).toBe("repeat");
  expect(controller.recoveryPromptSide).toBe("B");
  await controller.endConversation();
});

it.each([false, true])("preserves an unpublished timeout discovered by new ASR, delayed timer=%s", async delayedTimer => {
  vi.useFakeTimers(); vi.setSystemTime(1000);
  const { controller, live, audio } = createController();
  await controller.startWithLanguages({ A: "ru", B: "en" });
  const presented: string[] = [];
  const unsubscribe = controller.subscribe(() => {
    if (controller.recoveryPrompt) presented.push(controller.recoveryPrompt);
  });
  emitVoice(audio, true);
  live.emit({ type: "session.input_transcript.delta", delta: "Где находится станция?", start_ms: 2000, end_ms: 3000 });
  const aId = controller.session.activeTurn!.id;
  emitVoice(audio, false);
  if (delayedTimer) vi.setSystemTime(6001);
  else await vi.advanceTimersByTimeAsync(5001);
  expect(presented.length > 0).toBe(!delayedTimer);

  live.emit({ type: "session.input_transcript.delta", delta: "The station is nearby.", start_ms: 0, end_ms: 1000 });
  expect(controller.session.recentTurns.find(turn => turn.id === aId)?.outputDeadline?.outcome).toBe("no_observed_output");
  expect(controller.session.activeTurn?.speaker).toBe("B");
  expect(controller.recoveryPrompt).toBeUndefined();
  if (delayedTimer) expect(presented).toEqual([]);
  live.emit({ type: "session.output_transcript.delta", delta: "Станция находится рядом.", start_ms: 500, end_ms: 1500 });
  expect(controller.captionBlocks.find(block => block.text === "Станция находится рядом.")?.attribution).toBe("matched");
  await vi.advanceTimersByTimeAsync(1500);
  expect(controller.session.activeTurn).toBeUndefined();
  expect(controller.session.pendingTurns).toEqual([]);
  expect(controller.recoveryPrompt).toBe(delayedTimer ? "repeat" : undefined);
  if (delayedTimer) {
    expect(controller.recoveryPromptSide).toBe("A");
    expect(presented).toContain("repeat");
  }
  unsubscribe();
  await controller.endConversation();
});

it.each([false, true])("shows a new provider error after a language change, prior timeout=%s", async priorTimeout => {
  vi.useFakeTimers(); vi.setSystemTime(1000);
  const { controller, live, audio } = createController();
  await controller.startWithLanguages({ A: "ru", B: "es" });
  if (priorTimeout) {
    emitVoice(audio, true);
    live.emit({ type: "session.input_transcript.delta", delta: "Где находится станция?", start_ms: 0, end_ms: 1000 });
    emitVoice(audio, false);
    await vi.advanceTimersByTimeAsync(5001);
    expect(controller.recoveryPrompt).toBe("repeat");
  }
  await controller.changeInterlocutorLanguage("de");
  expect(controller.recoveryPrompt).toBeUndefined();
  const parser = new LiveClient({ backend: {} as BackendClient, peerFactory: () => { throw new Error("Network is not used"); }, onRemoteStream: vi.fn() });
  const channel = parser as unknown as { started: boolean; handleChannelMessage(event: MessageEvent<string>): void };
  channel.started = true;
  parser.onError = event => live.onError?.(event as FakeLiveErrorEvent);
  channel.handleChannelMessage(new MessageEvent("message", { data: JSON.stringify({ type: "error",
    error: { message: "recoverable interruption", code: null } }) }));
  expect(parser.diagnostics.entries.some(entry => entry.kind === "provider_error")).toBe(true);
  expect(controller.session.state).toBe("listening");
  expect(controller.inputReady).toBe(true);
  expect(audio.captureTrack.enabled).toBe(true);
  expect(controller.recoveryPrompt).toBe("conditional-repeat");
  expect(controller.recoveryPromptIsTurnFailure).toBe(false);
  expect(controller.recoveryPromptSide).toBeUndefined();
  await controller.endConversation();
});

it.each([false, true])("keeps VAD-discovered timeout recovery until it can render, delayed timer=%s", async delayedTimer => {
  vi.useFakeTimers(); vi.setSystemTime(1000);
  const { controller, live, audio } = createController();
  await controller.startWithLanguages({ A: "ru", B: "en" });
  const committedHints: (string | null)[] = [];
  const view = render(createElement(Profiler, {
    id: "conversation",
    onRender: () => committedHints.push(document.querySelector('[data-testid="participant-recovery-A"]')?.textContent ?? null),
  }, createElement(ConversationScreen, { controller })));
  await act(async () => {
    emitVoice(audio, true);
    live.emit({ type: "session.input_transcript.delta", delta: "Где находится станция?", start_ms: 2000, end_ms: 3000 });
    emitVoice(audio, false);
  });
  const aId = controller.session.activeTurn!.id;
  if (delayedTimer) vi.setSystemTime(6001);
  else await act(async () => { await vi.advanceTimersByTimeAsync(5001); });
  expect(committedHints.includes("Повторите")).toBe(!delayedTimer);

  await act(async () => {
    emitVoice(audio, true);
    live.emit({ type: "session.input_transcript.delta", delta: "The station is nearby.", start_ms: 0, end_ms: 1000 });
  });
  expect(controller.session.recentTurns.find(turn => turn.id === aId)?.outputDeadline?.outcome).toBe("no_observed_output");
  expect(controller.session.activeTurn?.speaker).toBe("B");
  expect(view.queryByTestId("participant-recovery-A")).toBeNull();
  expect(committedHints.includes("Повторите")).toBe(!delayedTimer);

  await act(async () => {
    live.emit({ type: "session.output_transcript.delta", delta: "Станция находится рядом.", start_ms: 500, end_ms: 1500 });
    emitVoice(audio, false);
    await vi.advanceTimersByTimeAsync(1500);
  });
  expect(controller.captionBlocks.find(block => block.text === "Станция находится рядом.")?.attribution).toBe("matched");
  expect(controller.session.activeTurn).toBeUndefined();
  expect(controller.session.pendingTurns).toEqual([]);
  if (delayedTimer) {
    expect(view.getByTestId("participant-recovery-A")).toHaveTextContent("Повторите");
    expect(committedHints).toContain("Повторите");
    expect(controller.recoveryPromptSide).toBe("A");
  } else {
    expect(view.queryByTestId("participant-recovery-A")).toBeNull();
    expect(controller.recoveryPrompt).toBeUndefined();
  }
  view.unmount();
  await controller.endConversation();
});

it.each([false, true])("completes a queued language change after deadline expiry, VAD first=%s", async vadFirst => {
  vi.useFakeTimers(); vi.setSystemTime(1000);
  const { controller, live, audio } = createController();
  await controller.startWithLanguages({ A: "ru", B: "en" });
  emitVoice(audio, true);
  live.emit({ type: "session.input_transcript.delta", delta: "Где находится станция?", start_ms: 0, end_ms: 1000 });
  const aId = controller.session.activeTurn!.id;
  emitVoice(audio, false);
  await vi.advanceTimersByTimeAsync(runtime.captionIdleMs + 1);
  await controller.changeInterlocutorLanguage("de");
  expect(controller.selectedInterlocutorLanguage).toBe("de");
  expect(controller.session.participantB.language).toBe("en");
  if (vadFirst) {
    vi.setSystemTime(6001);
    emitVoice(audio, true);
    emitVoice(audio, false);
  } else {
    await vi.advanceTimersByTimeAsync(6001 - Date.now());
  }
  await vi.advanceTimersByTimeAsync(10_000);
  expect(controller.session.recentTurns.find(turn => turn.id === aId)?.outputDeadline?.outcome).toBe("no_observed_output");
  expect(controller.session.activeTurn).toBeUndefined();
  expect(controller.session.pendingTurns ?? []).toEqual([]);
  expect(controller.session.participantB.language).toBe("de");
  expect(live.appendInstructions).toHaveBeenLastCalledWith(buildSteering({ A: "ru", B: "de" }), expect.anything());
  expect(controller.inputReady).toBe(true);
  expect(controller.session.state).toBe("listening");
  await controller.endConversation();
});
