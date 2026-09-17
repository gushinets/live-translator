import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { BackendClient } from "../api/BackendClient";
import { AudioController } from "../audio/AudioController";
import { runtime } from "../config/runtime";
import { AckTimeoutError } from "../live/AckRegistry";
import { LiveClient } from "../live/LiveClient";
import {
  APPEND_CHAR_BUDGET,
  ContextTooLongError,
  type SessionClosedEvent,
  type TranscriptDeltaEvent,
} from "../live/LiveEvents";
import {
  buildAuthoritativeContext,
  buildCorrectionCommentaryTrigger,
  buildCorrectionInstruction,
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

function createDispatchableAudio(): {
  audio: AudioController;
  track: DispatchableMicTrack;
  audioContext: DispatchableAudioContext;
} {
  const track = new DispatchableMicTrack();
  const audioContext = new DispatchableAudioContext();
  const audioElement = document.createElement("audio");
  audioElement.play = vi.fn().mockResolvedValue(undefined);
  const audio = new AudioController({
    getUserMedia: async () =>
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
      }) as unknown as MediaStream,
    createAudioContext: () => audioContext as unknown as AudioContext,
    audioElement,
  });
  return { audio, track, audioContext };
}

function createController<
  TAudio extends ReturnType<typeof createFakeAudio> | AudioController = ReturnType<
    typeof createFakeAudio
  >,
>(options: {
  live?: FakeLive;
  audio?: TAudio;
  orientation?: FakeOrientation;
  visibility?: FakeVisibility;
  wakeLock?: FakeWakeLock;
} = {}) {
  const live = options.live ?? new FakeLive();
  const audio = (options.audio ?? createFakeAudio()) as TAudio;
  const orientation = options.orientation ?? new FakeOrientation();
  const visibility = options.visibility ?? new FakeVisibility();
  const wakeLock = options.wakeLock ?? new FakeWakeLock();
  const controller = new SessionController({
    createLive: () => live as unknown as LiveClient,
    audio: audio as unknown as AudioController,
    orientation: orientation as unknown as OrientationController,
    visibility: visibility as unknown as VisibilityController,
    wakeLock: wakeLock as unknown as WakeLockController,
  });
  return { controller, live, audio, orientation, visibility, wakeLock };
}

describe("SessionController", () => {
  beforeEach(() => {
    setDeviceLanguage("ru-RU");
  });

  it("initializes Participant A from navigator.language and does not infer B", () => {
    const { controller } = createController();

    expect(controller.session.participantA).toEqual({
      side: "A",
      initialLanguageHint: "ru-RU",
      languageHintSource: "device_locale",
      hasAcceptedConversationSpeech: false,
    });
    expect(controller.session.participantB).toEqual({
      side: "B",
      hasAcceptedConversationSpeech: false,
    });
    expect(controller.session.participantB.initialLanguageHint).toBeUndefined();
    expect(controller.session.participantB.languageHintSource).toBeUndefined();
  });

  it("connects on first context capture, enters context, primes output, and keeps Gate C closed", async () => {
    const { controller, live, audio } = createController();

    await controller.startContextCapture();

    expect(audio.primeOutput).toHaveBeenCalledOnce();
    expect(audio.startCapture).toHaveBeenCalledOnce();
    expect(live.connect).toHaveBeenCalledExactlyOnceWith(audio.captureStream);
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

  it("captures bootstrap speech as a raw B hint and skip marks degraded mode", async () => {
    const { controller, live } = createController();
    await controller.startBootstrap();
    live.emit({ type: "session.input_transcript.delta", delta: "Spanish" });

    expect(controller.bootstrapText).toBe("Spanish");
    expect(controller.session.activeTurn).toBeUndefined();

    controller.acceptBootstrap("Spanish");
    expect(controller.session.participantB.initialLanguageHint).toBe("Spanish");
    expect(controller.session.participantB.languageHintSource).toBe("bootstrap");
    expect(controller.bootstrapDegraded).toBe(false);

    controller.skipBootstrap();
    expect(controller.bootstrapDegraded).toBe(true);
    expect(controller.session.participantB.initialLanguageHint).toBeUndefined();
  });

  it("sends authoritative context, interpreter contract, then first A->B steering before listening", async () => {
    const { controller, live, audio } = createController();
    await controller.startContextCapture();
    controller.setContextText("We are ordering lunch.");
    await controller.startBootstrap();
    controller.acceptBootstrap("Spanish");

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
    expect(live.appendInstructions).toHaveBeenNthCalledWith(1, buildInterpreterInstructions(), {
      kind: "startup_interpreter",
      startupGeneration: 0,
      startupState: "bootstrap",
      startupStage: "interpreter_contract",
    });
    expect(live.appendInstructions).toHaveBeenNthCalledWith(
      2,
      buildSteering({
        expectedSource: "A",
        recipient: "B",
        initialRecipientHint: "Spanish",
      }),
      {
        kind: "first_steering",
        sessionState: "bootstrap",
        startupGeneration: 0,
        startupState: "bootstrap",
        startupStage: "first_steering",
      },
    );
    expect(live.callOrder.slice(1)).toEqual([
      `thinking:${buildAuthoritativeContext("We are ordering lunch.")}`,
      `instructions:${buildInterpreterInstructions()}`,
      `instructions:${buildSteering({
        expectedSource: "A",
        recipient: "B",
        initialRecipientHint: "Spanish",
      })}`,
    ]);
    expect(audio.setOutputAudible).toHaveBeenLastCalledWith(true);
    expect(controller.session.state).toBe("listening");
    expect(controller.inputReady).toBe(true);
    expect(live.setInputMuted).not.toHaveBeenCalled();
  });

  it("skips thinking append for empty context and omits B hint when bootstrap was skipped", async () => {
    const { controller, live } = createController();
    await controller.startBootstrap();
    controller.skipBootstrap();

    await controller.beginInterpreter();

    expect(live.appendThinking).not.toHaveBeenCalled();
    expect(live.appendInstructions).toHaveBeenNthCalledWith(
      2,
      buildSteering({ expectedSource: "A", recipient: "B" }),
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
    controller.skipBootstrap();
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
    controller.skipBootstrap();
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
    controller.skipBootstrap();
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
    controller.skipBootstrap();
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
    controller.skipBootstrap();
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

  it("plays the primed remote audio element when the stream attaches", async () => {
    const { controller, audio } = createController();
    const remoteStream = { id: "remote" } as MediaStream;

    controller.handleRemoteStream(remoteStream);

    expect(audio.attachRemoteStream).toHaveBeenCalledExactlyOnceWith(remoteStream);
    expect(audio.audioElement.play).toHaveBeenCalledOnce();
  });

  it("logs a remote audio play failure without leaking an unhandled rejection", async () => {
    const { controller, audio } = createController();
    const remoteStream = { id: "remote" } as MediaStream;
    const playError = new Error("autoplay blocked");
    audio.audioElement.play = vi.fn(async () => {
      throw playError;
    });
    const consoleError = vi.spyOn(console, "error").mockImplementation(() => {});

    const unhandled = await collectUnhandledRejectionsDuring(async () => {
      controller.handleRemoteStream(remoteStream);
    });

    expect(unhandled).toEqual([]);
    expect(consoleError).toHaveBeenCalledExactlyOnceWith("Remote audio play failed", {
      error: playError,
    });
  });

  it("ignores stale remote audio play failure after reset", async () => {
    const { controller, audio } = createController();
    const remoteStream = { id: "remote" } as MediaStream;
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
      controller.handleRemoteStream(remoteStream);
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
    controller.skipBootstrap();

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
    controller.skipBootstrap();
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

  it("rejects an empty bootstrap language hint", async () => {
    const { controller } = createController();
    await controller.startBootstrap();

    expect(() => controller.acceptBootstrap("   ")).toThrow("Bootstrap language hint is empty");
    expect(controller.session.participantB.initialLanguageHint).toBeUndefined();
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
    controller.skipBootstrap();

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
    const first = created[0];
    if (first === undefined) {
      throw new Error("LiveClient was not created");
    }
    await controller.startBootstrap();
    controller.skipBootstrap();

    let releaseFirstAppend: (() => void) | undefined;
    first.appendInstructions.mockImplementation(
      () =>
        new Promise<{ eventId: string }>((resolve) => {
          releaseFirstAppend = () => {
            resolve({ eventId: "evt-late" });
          };
        }),
    );

    const starting = controller.beginInterpreter();
    await vi.waitFor(() => {
      expect(first.appendInstructions).toHaveBeenCalledOnce();
      expect(controller.isInterpreterStarting).toBe(true);
    });

    await controller.cancel();

    expect(first.close).toHaveBeenCalledOnce();
    expect(controller.session.state).toBe("idle");
    expect(controller.ownerError).toBeUndefined();
    expect(created).toHaveLength(2);

    if (releaseFirstAppend === undefined) {
      throw new Error("first interpreter append was not started");
    }
    releaseFirstAppend();
    await starting;

    expect(controller.session.state).toBe("idle");
    expect(controller.ownerError).toBeUndefined();
    expect(controller.isInterpreterStarting).toBe(false);
    expect(audio.setOutputAudible).toHaveBeenLastCalledWith(false);
    expect(created[1]?.appendInstructions).not.toHaveBeenCalled();
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

async function enterListening(
  controller: SessionController,
  options: { hint?: string } = {},
): Promise<void> {
  await controller.startBootstrap();
  if (options.hint !== undefined) {
    controller.acceptBootstrap(options.hint);
  } else {
    controller.skipBootstrap();
  }
  await controller.beginInterpreter();
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

async function flushLifecycle(): Promise<void> {
  for (let attempt = 0; attempt < 24; attempt += 1) {
    await Promise.resolve();
  }
}

async function completeTextOnlyTurn(
  controller: SessionController,
  live: FakeLive,
  audio: ReturnType<typeof createFakeAudio>,
): Promise<void> {
  emitVoice(audio, true);
  live.emit({
    type: "session.input_transcript.delta",
    delta: "Hello",
    start_ms: 10,
    end_ms: 40,
  });
  live.emit({ type: "session.output_transcript.delta", delta: "Hola" });
  emitVoice(audio, false);
  await flushMicrotasks();
  await vi.advanceTimersByTimeAsync(runtime.audioStartGraceMs);
  await flushMicrotasks();
  if (controller.session.state !== "listening") {
    throw new Error(`Expected listening after text-only close, got "${controller.session.state}"`);
  }
}

async function completeTextOnlyTurnUntilLaterSteeringStarts(
  controller: SessionController,
  live: FakeLive,
  audio: ReturnType<typeof createFakeAudio>,
): Promise<void> {
  emitVoice(audio, true);
  live.emit({
    type: "session.input_transcript.delta",
    delta: "Hello",
    start_ms: 10,
    end_ms: 40,
  });
  live.emit({ type: "session.output_transcript.delta", delta: "Hola" });
  emitVoice(audio, false);
  await flushMicrotasks();
  await vi.advanceTimersByTimeAsync(runtime.audioStartGraceMs);
  await flushMicrotasks();
  if (controller.session.state !== "listening") {
    throw new Error(`Expected listening during text-only close, got "${controller.session.state}"`);
  }
}

async function enterOutputtingTurn(
  controller: SessionController,
  live: FakeLive,
  audio: ReturnType<typeof createFakeAudio>,
): Promise<void> {
  await enterListening(controller);
  emitVoice(audio, true);
  live.emit({ type: "session.input_transcript.delta", delta: "Hello" });
  live.emit({ type: "session.output_transcript.delta", delta: "Hola" });
  emitPlayback(audio, true);
  await flushMicrotasks();
  emitVoice(audio, false);
  await flushMicrotasks();
  expect(controller.session.state).toBe("outputting");
  expect(controller.session.activeTurn?.speaker).toBe("A");
}

describe("SessionController turn engine", () => {
  beforeEach(() => {
    setDeviceLanguage("ru-RU");
    vi.useFakeTimers();
    vi.setSystemTime(new Date("2026-01-01T00:00:00.000Z"));
  });

  it("creates an active turn from the first listening input fragment using expectedSpeaker", async () => {
    const { controller, live } = createController();
    await enterListening(controller, { hint: "Spanish" });

    live.emit({
      type: "session.input_transcript.delta",
      delta: "Where is apartment 12?",
      start_ms: 100,
      end_ms: 400,
    });

    expect(controller.session.state).toBe("listening");
    expect(controller.session.expectedSpeaker).toBe("A");
    expect(controller.session.activeTurn?.speaker).toBe("A");
    expect(controller.session.activeTurn?.originalText).toBe("Where is apartment 12?");
    expect(controller.session.activeTurn?.sourceFragments[0]?.startMs).toBe(100);
    expect(controller.session.activeTurn?.sourceFragments[0]?.endMs).toBe(400);
  });

  it("appends output captions without changing expected speaker or muting Gate B", async () => {
    const { controller, live, audio } = createController();
    await enterListening(controller);
    emitVoice(audio, true);
    live.emit({ type: "session.input_transcript.delta", delta: "Hello" });

    live.emit({ type: "session.output_transcript.delta", delta: "Hola" });

    expect(controller.session.state).toBe("outputting");
    expect(controller.session.expectedSpeaker).toBe("A");
    expect(controller.session.activeTurn?.translatedText).toBe("Hola");
    expect(controller.session.activeTurn?.firstOutputTextAtMs).toBe(Date.now());
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
    controller.handleRemoteStream({ id: "remote" } as MediaStream);
    await flushMicrotasks();

    emitVoice(audio, true);
    live.emit({
      type: "session.input_transcript.delta",
      delta: "Hello",
      start_ms: 10,
      end_ms: 40,
    });
    live.emit({ type: "session.output_transcript.delta", delta: "Hola" });

    expect(controller.session.state).toBe("outputting");
    expect(controller.session.activeTurn?.translatedText).toBe("Hola");

    emitPlayback(audio, true);
    await flushMicrotasks();

    expect(controller.session.activeTurn?.audioOutputStarted).toBe(false);

    emitVoice(audio, false);
    rejectPlay?.(playError);
    await flushMicrotasks();
    await vi.advanceTimersByTimeAsync(runtime.audioStartGraceMs);
    await flushMicrotasks();

    expect(controller.session.state).toBe("listening");
    expect(controller.session.recentTurns[0]?.translatedText).toBe("Hola");
    expect(controller.session.recentTurns[0]?.audioOutputStarted).toBe(false);
    expect(controller.session.recentTurns[0]?.firstAudibleOutputAtMs).toBeUndefined();
    expect(controller.session.expectedSpeaker).toBe("B");
    expect(controller.inputReady).toBe(true);
    expect(controller.metrics.snapshot().textOnlyCompletionCount).toBe(1);
    expect(controller.metrics.snapshot().lastTurn?.t2Ms).toBeUndefined();

    emitVoice(audio, true);
    live.emit({ type: "session.input_transcript.delta", delta: "Next" });

    expect(controller.session.activeTurn?.originalText).toBe("Next");
    expect(controller.session.expectedSpeaker).toBe("B");
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
    controller.handleRemoteStream({ id: "remote" } as MediaStream);
    emitVoice(audio, true);
    live.emit({ type: "session.input_transcript.delta", delta: "Hello" });
    live.emit({ type: "session.output_transcript.delta", delta: "Hola" });

    emitPlayback(audio, true);
    await flushMicrotasks();
    expect(controller.session.activeTurn?.audioOutputStarted).toBe(false);

    resolvePlay?.();
    await flushMicrotasks();

    expect(controller.session.activeTurn?.audioOutputStarted).toBe(true);
    expect(controller.session.activeTurn?.firstAudibleOutputAtMs).toBeDefined();
  });

  it("does not mute Gate B merely because audible output started", async () => {
    const { controller, audio, live } = createController();
    await enterListening(controller);
    emitVoice(audio, true);
    live.emit({ type: "session.input_transcript.delta", delta: "Hello" });

    emitPlayback(audio, true);
    await flushMicrotasks();

    expect(controller.session.activeTurn?.audioOutputStarted).toBe(true);
    expect(live.setInputMuted).not.toHaveBeenCalled();
    expect(controller.session.expectedSpeaker).toBe("A");
  });

  it("mutes Gate B only after source idle, then closes a text-only turn with hint fade and later steering", async () => {
    const { controller, live, audio } = createController();
    await enterListening(controller, { hint: "Spanish" });
    emitVoice(audio, true);
    live.emit({
      type: "session.input_transcript.delta",
      delta: "Hello",
      start_ms: 10,
      end_ms: 40,
    });
    live.emit({ type: "session.output_transcript.delta", delta: "Hola" });
    expect(live.setInputMuted).not.toHaveBeenCalled();

    emitVoice(audio, false);
    await flushMicrotasks();
    expect(live.setInputMuted).toHaveBeenCalledExactlyOnceWith(true);
    expect(controller.session.expectedSpeaker).toBe("A");

    await vi.advanceTimersByTimeAsync(runtime.audioStartGraceMs);
    await flushMicrotasks();

    expect(controller.session.state).toBe("listening");
    expect(controller.session.activeTurn).toBeUndefined();
    expect(controller.session.recentTurns[0]?.status).toBe("completed");
    expect(controller.session.lastSpeaker).toBe("A");
    expect(controller.session.expectedSpeaker).toBe("B");
    expect(controller.session.participantA.hasAcceptedConversationSpeech).toBe(true);
    expect(controller.session.participantB.hasAcceptedConversationSpeech).toBe(false);
    expect(live.setInputMuted).toHaveBeenLastCalledWith(false);
    expect(live.appendInstructions).toHaveBeenLastCalledWith(
      buildSteering({ expectedSource: "B", recipient: "A" }),
      { kind: "later_steering", sessionState: "listening" },
    );
  });

  it("keeps the source turn open when playback goes idle before the human has finished", async () => {
    const { controller, live, audio } = createController();
    await enterListening(controller);
    emitVoice(audio, true);
    live.emit({ type: "session.input_transcript.delta", delta: "Hello" });
    emitPlayback(audio, true);
    emitPlayback(audio, false);
    await flushMicrotasks();
    await vi.advanceTimersByTimeAsync(
      runtime.postSourceOutputGraceMs + runtime.outputSettleGraceMs,
    );
    await flushMicrotasks();

    expect(controller.session.activeTurn?.status).not.toBe("completed");
    expect(controller.session.expectedSpeaker).toBe("A");
    expect(live.setInputMuted).not.toHaveBeenCalled();
  });

  it("waits POST_SOURCE_OUTPUT_GRACE_MS after source idle when playback already ended", async () => {
    const { controller, live, audio } = createController();
    await enterListening(controller);
    emitVoice(audio, true);
    live.emit({ type: "session.input_transcript.delta", delta: "Hello" });
    emitPlayback(audio, true);
    emitPlayback(audio, false);
    await vi.advanceTimersByTimeAsync(1);
    emitVoice(audio, false);
    await flushMicrotasks();

    await vi.advanceTimersByTimeAsync(runtime.postSourceOutputGraceMs - 1);
    await flushMicrotasks();
    expect(controller.session.activeTurn).toBeDefined();
    expect(controller.session.expectedSpeaker).toBe("A");

    await vi.advanceTimersByTimeAsync(1);
    await flushMicrotasks();
    expect(controller.session.state).toBe("listening");
    expect(controller.session.recentTurns[0]?.status).toBe("completed");
    expect(controller.session.expectedSpeaker).toBe("B");
  });

  it("fails a no-output turn, keeps the same speaker, restores input, and does not steer opposite", async () => {
    const { controller, live, audio } = createController();
    await enterListening(controller, { hint: "Spanish" });
    const appendCountAfterStart = live.appendInstructions.mock.calls.length;
    emitVoice(audio, true);
    live.emit({ type: "session.input_transcript.delta", delta: "Hello" });
    emitVoice(audio, false);
    await flushMicrotasks();

    await vi.advanceTimersByTimeAsync(runtime.noOutputTimeoutMs - 1);
    await flushMicrotasks();
    expect(controller.session.activeTurn).toBeDefined();

    await vi.advanceTimersByTimeAsync(1);
    await flushMicrotasks();

    expect(controller.session.state).toBe("listening");
    expect(controller.session.recentTurns[0]?.status).toBe("failed");
    expect(controller.session.expectedSpeaker).toBe("A");
    expect(controller.session.participantA.hasAcceptedConversationSpeech).toBe(false);
    expect(controller.recoveryPrompt).toBe("repeat");
    expect(live.setInputMuted).toHaveBeenLastCalledWith(false);
    expect(live.appendInstructions.mock.calls.length).toBe(appendCountAfterStart);
  });

  it("still arms no-output timeout when Gate B mute ack times out", async () => {
    const errorSpy = vi.spyOn(console, "error").mockImplementation(() => {});
    const { controller, live, audio } = createController();
    live.setInputMuted.mockImplementation(async (muted: boolean) => {
      if (muted) {
        throw new AckTimeoutError("evt-mute");
      }
    });
    await enterListening(controller);
    emitVoice(audio, true);
    live.emit({ type: "session.input_transcript.delta", delta: "Hello" });
    emitVoice(audio, false);
    await flushMicrotasks();

    expect(controller.session.activeTurn?.sourceIdleAtMs).toBeDefined();
    expect(live.setInputMuted).toHaveBeenCalledWith(true);

    await vi.advanceTimersByTimeAsync(runtime.noOutputTimeoutMs - 1);
    await flushMicrotasks();
    expect(controller.session.activeTurn).toBeDefined();
    expect(controller.session.recentTurns).toHaveLength(0);

    await vi.advanceTimersByTimeAsync(1);
    await flushMicrotasks();

    expect(controller.session.state).toBe("listening");
    expect(controller.session.recentTurns[0]?.status).toBe("failed");
    expect(controller.session.expectedSpeaker).toBe("A");
    expect(controller.recoveryPrompt).toBe("repeat");
    expect(live.setInputMuted).toHaveBeenLastCalledWith(false);
    expect(errorSpy).toHaveBeenCalled();
  });

  it("continues text-only completion when source-idle Gate B mute rejects", async () => {
    const errorSpy = vi.spyOn(console, "error").mockImplementation(() => {});
    const { controller, live, audio } = createController();
    live.setInputMuted.mockImplementation(async (muted: boolean) => {
      if (muted) {
        throw new Error("network failed");
      }
    });
    await enterListening(controller);
    emitVoice(audio, true);
    live.emit({ type: "session.input_transcript.delta", delta: "Hello" });
    live.emit({ type: "session.output_transcript.delta", delta: "Hola" });

    const unhandled = await collectUnhandledRejectionsDuringFakeTimers(async () => {
      emitVoice(audio, false);
      await flushMicrotasks();
      await vi.advanceTimersByTimeAsync(runtime.audioStartGraceMs);
      await flushMicrotasks();
    });

    expect(unhandled).toEqual([]);
    expect(controller.session.state).toBe("listening");
    expect(controller.session.recentTurns[0]?.status).toBe("completed");
    expect(controller.session.expectedSpeaker).toBe("B");
    expect(controller.inputReady).toBe(true);
    expect(live.setInputMuted).toHaveBeenCalledWith(true);
    expect(live.setInputMuted).toHaveBeenLastCalledWith(false);
    expect(errorSpy).toHaveBeenCalled();
  });

  it("fails closed when source reactivation Gate B unmute rejects", async () => {
    const errorSpy = vi.spyOn(console, "error").mockImplementation(() => {});
    const { controller, live, audio } = createController();
    live.setInputMuted.mockImplementation(async (muted: boolean) => {
      if (!muted) {
        throw new Error("reactivation unmute failed");
      }
    });
    await enterListening(controller);
    audio.setOutputAudible.mockClear();
    emitVoice(audio, true);
    live.emit({ type: "session.input_transcript.delta", delta: "Hello" });
    emitVoice(audio, false);
    await flushMicrotasks();

    expect(controller.session.activeTurn?.sourceIdleAtMs).toBeDefined();
    expect(live.setInputMuted).toHaveBeenCalledWith(true);

    const unhandled = await collectUnhandledRejectionsDuringFakeTimers(async () => {
      emitVoice(audio, true);
      await flushMicrotasks();
    });

    expect(unhandled).toEqual([]);
    expect(controller.session.state).toBe("error");
    expect(controller.session.activeTurn).toBeUndefined();
    expect(controller.session.recentTurns[0]?.status).toBe("failed");
    expect(controller.inputReady).toBe(false);
    expect(controller.ownerError).toBe("reactivation unmute failed");
    expect(audio.setCaptureEnabled).toHaveBeenLastCalledWith(false);
    expect(audio.setOutputAudible).toHaveBeenLastCalledWith(false);
    expect(live.setInputMuted).toHaveBeenLastCalledWith(false);
    live.emit({ type: "session.input_transcript.delta", delta: "ignored" });
    expect(controller.session.activeTurn).toBeUndefined();
    expect(errorSpy).toHaveBeenCalled();
  });

  it("MAX_SOURCE_MS mutes, closes output, fails, warns, and suspends with Resume/Repeat", async () => {
    const { controller, live, audio } = createController();
    await enterListening(controller);
    emitVoice(audio, true);
    live.emit({ type: "session.input_transcript.delta", delta: "Hello" });

    await vi.advanceTimersByTimeAsync(runtime.maxSourceMs);
    await flushMicrotasks();

    expect(live.setInputMuted).toHaveBeenCalledWith(true);
    expect(audio.setCaptureEnabled).toHaveBeenLastCalledWith(false);
    expect(audio.captureTrack.enabled).toBe(false);
    expect(audio.setOutputAudible).toHaveBeenLastCalledWith(false);
    expect(controller.inputReady).toBe(false);
    expect(controller.session.state).toBe("suspended");
    expect(controller.session.recentTurns[0]?.status).toBe("failed");
    expect(controller.session.expectedSpeaker).toBe("A");
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
      live.emit({ type: "session.input_transcript.delta", delta: "Hello" });

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
    live.emit({ type: "session.input_transcript.delta", delta: "Hello" });

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
    expect(controller.session.expectedSpeaker).toBe("A");
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
    live.emit({ type: "session.input_transcript.delta", delta: "Hello" });

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
    live.emit({ type: "session.input_transcript.delta", delta: "Hello" });

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
    expect(controller.session.expectedSpeaker).toBe("A");
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
    expect(controller.session.expectedSpeaker).toBe("A");
    expect(controller.inputReady).toBe(true);
    expect(controller.recoveryPrompt).toBeUndefined();
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
    live.emit({ type: "session.input_transcript.delta", delta: "Hello" });

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
        live.emit({ type: "session.input_transcript.delta", delta: "Hello" });

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
      live.emit({ type: "session.input_transcript.delta", delta: "Hello" });
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
    expect(controller.ownerError).toBe('Microphone track is not live (readyState "ended")');
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
    expect(controller.ownerError).toBe('Peer connection state is "closed"');
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
    expect(controller.ownerError).toBe("unmute failed");
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
    expect(controller.ownerError).toBe("capture enable failed");
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
    live.close.mockImplementation(async () => {
      await new Promise<void>((resolve) => {
        releaseClose = resolve;
      });
      return { finalized: true };
    });
    const { controller, audio } = createController({ live });
    await enterListening(controller);
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

  it("later-turn double timeout records degraded steering and continues listening", async () => {
    const { controller, live, audio } = createController();
    live.appendInstructions.mockImplementation(
      async (text: string, policy?: { kind: string }) => {
        live.callOrder.push(`instructions:${text}`);
        if (policy?.kind === "later_steering") {
          return { eventId: "evt-degraded", degraded: true };
        }
        return { eventId: "evt-ok" };
      },
    );
    await enterListening(controller);
    await completeTextOnlyTurn(controller, live, audio);

    expect(controller.session.state).toBe("listening");
    expect(controller.session.expectedSpeaker).toBe("B");
    expect(controller.steeringDegraded).toBe(true);
    expect(controller.inputReady).toBe(true);
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
    expect(controller.session.recentTurns[0]?.translatedText).toBe("Hola");
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
    live.emit({ type: "session.input_transcript.delta", delta: "Hello" });

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
    expect(controller.session.expectedSpeaker).toBe("A");

    finishWarning();
    await flushMicrotasks();

    expect(controller.session.state).toBe("suspended");
    expect(controller.recoveryPrompt).toBe("resume-repeat");
    expect(controller.session.expectedSpeaker).toBe("A");
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
    expect(controller.session.expectedSpeaker).toBe("A");
    expect(controller.session.recentTurns[0]?.status).toBe("failed");
    await controller.resumeFromSourceTimeout();
    expect(controller.session.state).toBe("listening");
  });

  it("does not accept the next source turn until later steering and unmute have settled", async () => {
    const { controller, live, audio } = createController();
    let releaseSteering: (() => void) | undefined;
    live.appendInstructions.mockImplementation(async (text: string, policy?: { kind: string }) => {
      live.callOrder.push(`instructions:${text}`);
      if (policy?.kind === "later_steering") {
        await new Promise<void>((resolve) => {
          releaseSteering = resolve;
        });
      }
      return { eventId: "evt-steer" };
    });
    await enterListening(controller);
    emitVoice(audio, true);
    live.emit({ type: "session.input_transcript.delta", delta: "Hello" });
    live.emit({ type: "session.output_transcript.delta", delta: "Hola" });
    emitVoice(audio, false);
    await flushMicrotasks();
    await vi.advanceTimersByTimeAsync(runtime.audioStartGraceMs);
    await flushMicrotasks();
    await vi.waitFor(() => {
      if (releaseSteering === undefined) {
        throw new Error("later steering append was not started");
      }
    });
    const finishSteering = releaseSteering;
    if (finishSteering === undefined) {
      throw new Error("later steering append was not started");
    }

    expect(controller.session.state).toBe("listening");
    expect(controller.session.activeTurn).toBeUndefined();
    expect(controller.session.expectedSpeaker).toBe("B");
    expect(controller.inputReady).toBe(false);
    emitVoice(audio, true);
    live.emit({ type: "session.input_transcript.delta", delta: "Next" });
    expect(controller.session.activeTurn).toBeUndefined();
    expect(live.setInputMuted).not.toHaveBeenCalledWith(false);

    finishSteering();
    await flushMicrotasks();
    const unmuteResult = live.setInputMuted.mock.results.at(-1)?.value;
    if (unmuteResult instanceof Promise) {
      await unmuteResult;
    }
    await flushMicrotasks();

    expect(live.setInputMuted).toHaveBeenLastCalledWith(false);
    expect(controller.inputReady).toBe(true);
    emitVoice(audio, true);
    live.emit({ type: "session.input_transcript.delta", delta: "Next" });
    expect(controller.session.activeTurn?.originalText).toBe("Next");
    expect(controller.session.expectedSpeaker).toBe("B");
  });

  it("fails closed when later steering append explicitly rejects", async () => {
    const errorSpy = vi.spyOn(console, "error").mockImplementation(() => {});
    try {
      const { controller, live, audio } = createController();
      live.appendInstructions.mockImplementation(async (text: string, policy?: { kind: string }) => {
        live.callOrder.push(`instructions:${text}`);
        if (policy?.kind === "later_steering") {
          throw new Error("instructions rejected");
        }
        return { eventId: "evt-ok" };
      });
      await enterListening(controller);
      emitVoice(audio, true);
      live.emit({ type: "session.input_transcript.delta", delta: "Hello" });
      live.emit({ type: "session.output_transcript.delta", delta: "Hola" });
      const turnCloseCallStart = live.callOrder.length;

      const unhandled = await collectUnhandledRejectionsDuringFakeTimers(async () => {
        emitVoice(audio, false);
        await flushMicrotasks();
        await vi.advanceTimersByTimeAsync(runtime.audioStartGraceMs);
        await flushMicrotasks();
      });

      expect(unhandled).toEqual([]);
      expect(controller.session.state).toBe("error");
      expect(controller.ownerError).toBe("instructions rejected");
      expect(controller.inputReady).toBe(false);
      expect(audio.setOutputAudible).toHaveBeenLastCalledWith(false);
      expect(live.callOrder.slice(turnCloseCallStart)).not.toContain("setInputMuted:false");
      expect(controller.session.activeTurn).toBeUndefined();
      const recentTurnCount = controller.session.recentTurns.length;

      emitVoice(audio, true);
      live.emit({ type: "session.input_transcript.delta", delta: "Next" });

      expect(controller.session.activeTurn).toBeUndefined();
      expect(controller.session.recentTurns).toHaveLength(recentTurnCount);
    } finally {
      errorSpy.mockRestore();
    }
  });

  it("does not mark input ready while Gate B unmute is still pending after steering", async () => {
    const { controller, live, audio } = createController();
    let releaseUnmute: (() => void) | undefined;
    live.setInputMuted.mockImplementation(async (muted: boolean) => {
      live.callOrder.push(`setInputMuted:${muted}`);
      if (!muted) {
        await new Promise<void>((resolve) => {
          releaseUnmute = resolve;
        });
      }
    });
    await enterListening(controller);
    await completeTextOnlyTurnUntilLaterSteeringStarts(controller, live, audio);
    await vi.waitFor(() => {
      if (releaseUnmute === undefined) {
        throw new Error("Gate B unmute did not start");
      }
    });

    expect(controller.session.state).toBe("listening");
    expect(controller.session.expectedSpeaker).toBe("B");
    expect(controller.inputReady).toBe(false);

    releaseUnmute?.();
    await flushMicrotasks();

    expect(controller.inputReady).toBe(true);
  });

  it("stays not ready and errors when Gate B unmute fails after turn completion", async () => {
    const { controller, live, audio } = createController();
    let rejectUnmute: ((error: Error) => void) | undefined;
    live.setInputMuted.mockImplementation(async (muted: boolean) => {
      live.callOrder.push(`setInputMuted:${muted}`);
      if (!muted) {
        await new Promise<void>((_resolve, reject) => {
          rejectUnmute = reject;
        });
      }
    });
    await enterListening(controller);
    await completeTextOnlyTurnUntilLaterSteeringStarts(controller, live, audio);
    await vi.waitFor(() => {
      if (rejectUnmute === undefined) {
        throw new Error("Gate B unmute did not start");
      }
    });

    expect(controller.session.state).toBe("listening");
    expect(controller.inputReady).toBe(false);

    rejectUnmute?.(new Error("unmute failed"));
    await flushMicrotasks();

    expect(controller.session.state).toBe("error");
    expect(controller.ownerError).toBe("unmute failed");
    expect(controller.inputReady).toBe(false);
  });

  it("does not attach residual output to the next source turn before leftover drain", async () => {
    const { controller, live, audio } = createController();
    await enterListening(controller);
    await completeTextOnlyTurn(controller, live, audio);
    expect(controller.session.expectedSpeaker).toBe("B");

    emitVoice(audio, true);
    live.emit({ type: "session.input_transcript.delta", delta: "Next" });
    live.emit({ type: "session.output_transcript.delta", delta: "stale leftover" });

    expect(controller.session.activeTurn?.originalText).toBe("Next");
    expect(controller.session.activeTurn?.translatedText).toBeUndefined();
    expect(controller.session.activeTurn?.status).toBe("streaming");
    expect(controller.session.expectedSpeaker).toBe("B");
    expect(controller.session.recentTurns).toHaveLength(1);
  });

  it("does not treat leftover captions as success after a no-output fail", async () => {
    const { controller, live, audio } = createController();
    await enterListening(controller);
    const laterSteeringBefore = live.appendInstructions.mock.calls.filter(
      (call) => call[1]?.kind === "later_steering",
    ).length;
    emitVoice(audio, true);
    live.emit({ type: "session.input_transcript.delta", delta: "Hello" });
    emitVoice(audio, false);
    await flushMicrotasks();
    await vi.advanceTimersByTimeAsync(runtime.noOutputTimeoutMs);
    await flushMicrotasks();
    expect(controller.session.recentTurns[0]?.status).toBe("failed");
    expect(controller.session.expectedSpeaker).toBe("A");

    emitVoice(audio, true);
    live.emit({ type: "session.input_transcript.delta", delta: "Hello again" });
    live.emit({ type: "session.output_transcript.delta", delta: "stale leftover" });
    expect(controller.session.activeTurn?.translatedText).toBeUndefined();

    emitVoice(audio, false);
    await flushMicrotasks();
    await vi.advanceTimersByTimeAsync(runtime.noOutputTimeoutMs);
    await flushMicrotasks();

    expect(controller.session.state).toBe("listening");
    expect(controller.session.expectedSpeaker).toBe("A");
    expect(controller.session.recentTurns.at(-1)?.status).toBe("failed");
    expect(
      live.appendInstructions.mock.calls.filter((call) => call[1]?.kind === "later_steering").length,
    ).toBe(laterSteeringBefore);
  });

  it("does not mark AUDIO_STARTED on the next turn from residual playback during drain", async () => {
    const { controller, live, audio } = createController();
    await enterListening(controller);
    await completeTextOnlyTurn(controller, live, audio);

    emitVoice(audio, true);
    live.emit({ type: "session.input_transcript.delta", delta: "Next" });
    emitPlayback(audio, true);
    await flushMicrotasks();

    expect(controller.session.activeTurn?.audioOutputStarted).toBe(false);
    expect(controller.session.activeTurn?.firstAudibleOutputAtMs).toBeUndefined();
    expect(controller.session.expectedSpeaker).toBe("B");
  });

  it("attaches genuine output to the new turn after leftover caption and playback drain", async () => {
    const { controller, live, audio } = createController();
    await enterListening(controller);
    await completeTextOnlyTurn(controller, live, audio);

    emitVoice(audio, true);
    live.emit({ type: "session.input_transcript.delta", delta: "Next" });
    live.emit({ type: "session.output_transcript.delta", delta: "stale leftover" });
    expect(controller.session.activeTurn?.translatedText).toBeUndefined();

    await vi.advanceTimersByTimeAsync(runtime.captionIdleMs);
    await flushMicrotasks();
    live.emit({ type: "session.output_transcript.delta", delta: "Siguiente" });

    expect(controller.session.activeTurn?.translatedText).toBe("Siguiente");
    expect(controller.session.expectedSpeaker).toBe("B");
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
    expect(controller.session.expectedSpeaker).toBe("A");
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
    live.emit({ type: "session.input_transcript.delta", delta: "Hello" });
    emitPlayback(audio, true);
    await flushMicrotasks();

    await vi.advanceTimersByTimeAsync(runtime.maxSourceMs);
    await flushMicrotasks();

    expect(controller.session.state).toBe("suspended");
    expect(controller.recoveryPrompt).toBe("resume-repeat");
    expect(audio.setOutputAudible).toHaveBeenLastCalledWith(false);
    expect(controller.session.expectedSpeaker).toBe("A");

    await vi.advanceTimersByTimeAsync(runtime.captionIdleMs);
    await flushMicrotasks();

    await controller.resumeFromSourceTimeout();
    expect(controller.session.state).toBe("listening");
    expect(audio.setOutputAudible).toHaveBeenLastCalledWith(true);

    emitVoice(audio, true);
    live.emit({ type: "session.input_transcript.delta", delta: "Next" });
    live.emit({ type: "session.output_transcript.delta", delta: "stale leftover" });
    emitPlayback(audio, true);
    await flushMicrotasks();

    expect(controller.session.activeTurn?.originalText).toBe("Next");
    expect(controller.session.activeTurn?.translatedText).toBeUndefined();
    expect(controller.session.activeTurn?.audioOutputStarted).toBe(false);
    expect(controller.session.activeTurn?.status).toBe("streaming");
    expect(controller.session.expectedSpeaker).toBe("A");

    emitPlayback(audio, false);
    await flushMicrotasks();
    await vi.advanceTimersByTimeAsync(runtime.captionIdleMs);
    await flushMicrotasks();
    live.emit({ type: "session.output_transcript.delta", delta: "Siguiente" });

    expect(controller.session.activeTurn?.translatedText).toBe("Siguiente");
    expect(controller.session.expectedSpeaker).toBe("A");
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
    live.emit({ type: "session.input_transcript.delta", delta: "Hello" });
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

describe("SessionController correction", () => {
  beforeEach(() => {
    setDeviceLanguage("ru-RU");
    vi.useFakeTimers();
    vi.setSystemTime(new Date("2026-01-01T00:00:00.000Z"));
  });

  async function startAudibleTurnAssignedA(
    controller: SessionController,
    live: FakeLive,
    audio: ReturnType<typeof createFakeAudio>,
  ): Promise<void> {
    await enterListening(controller);
    emitVoice(audio, true);
    live.emit({ type: "session.input_transcript.delta", delta: "Hello" });
    live.emit({ type: "session.output_transcript.delta", delta: "Hola" });
    emitPlayback(audio, true);
    await flushMicrotasks();
    emitVoice(audio, false);
    await flushMicrotasks();
    expect(controller.session.activeTurn?.speaker).toBe("A");
    expect(controller.session.state).toBe("outputting");
    expect(audio.setOutputAudible).toHaveBeenLastCalledWith(true);
  }

  it("closes Gate C immediately, waits for correction ack before commentary, and reopens Gate C only after a fresh epoch", async () => {
    const { controller, live, audio } = createController();
    let releaseCorrection: (() => void) | undefined;
    live.appendInstructions.mockImplementation(async (text: string, policy?: { kind: string }) => {
      live.callOrder.push(`instructions:${text}`);
      if (policy?.kind === "correction") {
        await new Promise<void>((resolve) => {
          releaseCorrection = resolve;
        });
      }
      return { eventId: "evt-correction" };
    });

    await startAudibleTurnAssignedA(controller, live, audio);

    const pending = controller.correctLastTurn("B");
    expect(audio.setOutputAudible).toHaveBeenLastCalledWith(false);
    expect(controller.session.state).toBe("correcting");
    expect(controller.session.activeTurn?.status).toBe("correcting");
    await flushMicrotasks();
    expect(live.appendCommentary).not.toHaveBeenCalled();
    expect(live.appendInstructions).toHaveBeenCalledWith(
      buildCorrectionInstruction({ actualSpeaker: "B", previousSpeaker: "A" }),
      { kind: "correction" },
    );

    live.emit({ type: "session.output_transcript.delta", delta: "stale" });
    emitPlayback(audio, true);
    await flushMicrotasks();
    expect(controller.session.activeTurn?.translatedText).toBe("Hola");
    expect(audio.setOutputAudible).toHaveBeenLastCalledWith(false);

    if (releaseCorrection === undefined) {
      throw new Error("correction instruction append was not started");
    }
    releaseCorrection();
    await flushMicrotasks();
    expect(live.appendCommentary).not.toHaveBeenCalled();
    expect(audio.setOutputAudible).toHaveBeenLastCalledWith(false);

    emitPlayback(audio, false);
    await flushMicrotasks();
    await pending;

    expect(live.appendCommentary).toHaveBeenCalledWith(buildCorrectionCommentaryTrigger(), {
      kind: "correction",
    });
    const commentaryIndex = live.callOrder.findIndex((entry) =>
      entry.startsWith("commentary:"),
    );
    const instructionIndex = live.callOrder.findIndex((entry) =>
      entry.startsWith(`instructions:${buildCorrectionInstruction({ actualSpeaker: "B", previousSpeaker: "A" })}`),
    );
    expect(instructionIndex).toBeGreaterThanOrEqual(0);
    expect(commentaryIndex).toBeGreaterThan(instructionIndex);
    expect(controller.session.state).toBe("outputting");
    expect(controller.session.activeTurn?.speaker).toBe("B");
    expect(controller.session.activeTurn?.corrected).toBe(true);
    expect(controller.session.activeTurn?.translatedText).toBeUndefined();
    expect(audio.setOutputAudible).toHaveBeenLastCalledWith(false);

    await vi.advanceTimersByTimeAsync(runtime.captionIdleMs);
    await flushMicrotasks();
    live.emit({ type: "session.output_transcript.delta", delta: "Hello there" });
    expect(controller.session.activeTurn?.translatedText).toBe("Hello there");
    expect(audio.setOutputAudible).toHaveBeenLastCalledWith(true);
  });

  it("reopens Gate C on fresh playback onset for the new epoch without a transcript delta", async () => {
    const { controller, live, audio } = createController();
    await startAudibleTurnAssignedA(controller, live, audio);
    emitPlayback(audio, false);
    await flushMicrotasks();
    await controller.correctLastTurn("B");
    expect(audio.setOutputAudible).toHaveBeenLastCalledWith(false);

    await vi.advanceTimersByTimeAsync(runtime.captionIdleMs);
    await flushMicrotasks();
    emitPlayback(audio, true);
    await flushMicrotasks();
    expect(controller.session.activeTurn?.audioOutputStarted).toBe(true);
    expect(audio.setOutputAudible).toHaveBeenLastCalledWith(true);
  });

  it("after corrected output completes, next steering uses corrected B then A", async () => {
    const { controller, live, audio } = createController();
    await startAudibleTurnAssignedA(controller, live, audio);
    emitPlayback(audio, false);
    await flushMicrotasks();
    await controller.correctLastTurn("B");
    await vi.advanceTimersByTimeAsync(runtime.captionIdleMs);
    await flushMicrotasks();
    live.emit({ type: "session.output_transcript.delta", delta: "Hello there" });
    emitPlayback(audio, false);
    await flushMicrotasks();
    await vi.advanceTimersByTimeAsync(runtime.audioStartGraceMs);
    await flushMicrotasks();

    expect(controller.session.state).toBe("listening");
    expect(controller.session.lastSpeaker).toBe("B");
    expect(controller.session.expectedSpeaker).toBe("A");
    expect(live.appendInstructions).toHaveBeenLastCalledWith(
      buildSteering({ expectedSource: "A", recipient: "B" }),
      { kind: "later_steering", sessionState: "listening" },
    );
  });

  it("ignores a same-side tap and a tap with no correctable turn", async () => {
    const { controller, live, audio } = createController();
    await enterListening(controller);
    await expect(controller.correctLastTurn("B")).resolves.toBeUndefined();
    expect(controller.session.state).toBe("listening");
    expect(live.appendInstructions).not.toHaveBeenCalledWith(
      expect.anything(),
      expect.objectContaining({ kind: "correction" }),
    );

    emitVoice(audio, true);
    live.emit({ type: "session.input_transcript.delta", delta: "Hello" });
    live.emit({ type: "session.output_transcript.delta", delta: "Hola" });
    emitPlayback(audio, true);
    await flushMicrotasks();
    const audibleCalls = audio.setOutputAudible.mock.calls.length;
    await expect(controller.correctLastTurn("A")).resolves.toBeUndefined();
    expect(controller.session.state).toBe("outputting");
    expect(controller.session.activeTurn?.speaker).toBe("A");
    expect(audio.setOutputAudible.mock.calls.length).toBe(audibleCalls);
  });

  it("sends commentary after the composed idle deadline and keeps Gate C closed until a fresh signal", async () => {
    const { controller, live, audio } = createController();
    await startAudibleTurnAssignedA(controller, live, audio);
    const idleDeadlineMs = runtime.playbackIdleMs + runtime.outputSettleGraceMs;

    const pending = controller.correctLastTurn("B");
    await flushMicrotasks();
    expect(live.appendCommentary).not.toHaveBeenCalled();

    await vi.advanceTimersByTimeAsync(runtime.outputSettleGraceMs);
    await flushMicrotasks();
    expect(live.appendCommentary).not.toHaveBeenCalled();
    expect(audio.setOutputAudible).toHaveBeenLastCalledWith(false);

    await vi.advanceTimersByTimeAsync(idleDeadlineMs - runtime.outputSettleGraceMs - 1);
    await flushMicrotasks();
    expect(live.appendCommentary).not.toHaveBeenCalled();

    await vi.advanceTimersByTimeAsync(1);
    await pending;

    expect(live.appendCommentary).toHaveBeenCalledWith(buildCorrectionCommentaryTrigger(), {
      kind: "correction",
    });
    expect(controller.session.state).toBe("outputting");
    expect(controller.session.activeTurn?.speaker).toBe("B");
    expect(audio.setOutputAudible).toHaveBeenLastCalledWith(false);
    expect(controller.session.activeTurn?.audioOutputStarted).toBe(false);

    live.emit({ type: "session.output_transcript.delta", delta: "stale leftover" });
    expect(controller.session.activeTurn?.translatedText).toBeUndefined();
    expect(audio.setOutputAudible).toHaveBeenLastCalledWith(false);

    emitPlayback(audio, false);
    await flushMicrotasks();
    await vi.advanceTimersByTimeAsync(runtime.captionIdleMs);
    await flushMicrotasks();
    live.emit({ type: "session.output_transcript.delta", delta: "Hello there" });
    expect(controller.session.activeTurn?.translatedText).toBe("Hello there");
    expect(audio.setOutputAudible).toHaveBeenLastCalledWith(true);
  });

  it("does not treat leftover captions after an outputting correction as the new epoch", async () => {
    const { controller, live, audio } = createController();
    await startAudibleTurnAssignedA(controller, live, audio);
    const laterSteeringBefore = live.appendInstructions.mock.calls.filter(
      (call) => call[1]?.kind === "later_steering",
    ).length;
    const idleDeadlineMs = runtime.playbackIdleMs + runtime.outputSettleGraceMs;

    const pending = controller.correctLastTurn("B");
    await vi.advanceTimersByTimeAsync(idleDeadlineMs);
    await pending;

    expect(controller.session.state).toBe("outputting");
    expect(controller.session.activeTurn?.speaker).toBe("B");
    expect(controller.session.activeTurn?.translatedText).toBeUndefined();
    expect(audio.setOutputAudible).toHaveBeenLastCalledWith(false);

    live.emit({ type: "session.output_transcript.delta", delta: "stale leftover" });
    await flushMicrotasks();
    await vi.advanceTimersByTimeAsync(runtime.audioStartGraceMs);
    await flushMicrotasks();

    expect(controller.session.activeTurn?.translatedText).toBeUndefined();
    expect(controller.session.activeTurn?.status).toBe("outputting");
    expect(controller.session.state).toBe("outputting");
    expect(controller.session.recentTurns).toHaveLength(0);
    expect(audio.setOutputAudible).toHaveBeenLastCalledWith(false);
    expect(
      live.appendInstructions.mock.calls.filter((call) => call[1]?.kind === "later_steering").length,
    ).toBe(laterSteeringBefore);

    emitPlayback(audio, false);
    await flushMicrotasks();
    await vi.advanceTimersByTimeAsync(runtime.noOutputTimeoutMs);
    await flushMicrotasks();

    expect(controller.session.state).toBe("outputting");
    expect(controller.session.activeTurn?.status).toBe("outputting");
    expect(controller.session.activeTurn?.translatedText).toBeUndefined();
    expect(audio.setOutputAudible).toHaveBeenLastCalledWith(false);

    await vi.advanceTimersByTimeAsync(runtime.captionIdleMs);
    await flushMicrotasks();
    live.emit({ type: "session.output_transcript.delta", delta: "Hello there" });
    expect(controller.session.activeTurn?.translatedText).toBe("Hello there");
    expect(audio.setOutputAudible).toHaveBeenLastCalledWith(true);
  });

  it("does not treat leftover captions as the new correction epoch", async () => {
    const { controller, live, audio } = createController();
    await enterListening(controller);
    await completeTextOnlyTurn(controller, live, audio);
    expect(controller.session.expectedSpeaker).toBe("B");

    await controller.correctLastTurn("B");
    expect(controller.session.state).toBe("outputting");
    expect(controller.session.activeTurn?.speaker).toBe("B");
    expect(audio.setOutputAudible).toHaveBeenLastCalledWith(false);

    live.emit({ type: "session.output_transcript.delta", delta: "stale leftover" });
    expect(controller.session.activeTurn?.translatedText).toBeUndefined();
    expect(audio.setOutputAudible).toHaveBeenLastCalledWith(false);

    await vi.advanceTimersByTimeAsync(runtime.captionIdleMs);
    await flushMicrotasks();
    live.emit({ type: "session.output_transcript.delta", delta: "Hello there" });
    expect(controller.session.activeTurn?.translatedText).toBe("Hello there");
    expect(audio.setOutputAudible).toHaveBeenLastCalledWith(true);
  });

  it("recovers to error when the correction instruction append fails", async () => {
    const { controller, live, audio } = createController();
    live.appendInstructions.mockImplementation(async (text: string, policy?: { kind: string }) => {
      live.callOrder.push(`instructions:${text}`);
      if (policy?.kind === "correction") {
        throw new Error("correction ack timeout");
      }
      return { eventId: "evt-ok" };
    });
    await startAudibleTurnAssignedA(controller, live, audio);

    await expect(controller.correctLastTurn("B")).rejects.toThrow("correction ack timeout");
    expect(controller.session.state).toBe("error");
    expect(controller.ownerError).toBe(CONNECTION_ERROR_MESSAGE);
    expect(audio.setOutputAudible).toHaveBeenLastCalledWith(false);
    expect(live.appendCommentary).not.toHaveBeenCalled();
  });
});

describe("SessionController endConversation", () => {
  beforeEach(() => {
    setDeviceLanguage("ru-RU");
    vi.useFakeTimers();
    vi.setSystemTime(new Date("2026-01-01T00:00:00.000Z"));
  });

  it("enters ending, closes Live, releases audio, and returns to idle start state", async () => {
    const { controller, live, audio } = createController();
    await enterListening(controller);
    controller.setContextText("We are ordering lunch.");
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
    expect(controller.session.state).toBe("idle");
    expect(controller.session.recentTurns).toEqual([]);
    expect(controller.session.activeTurn).toBeUndefined();
    expect(controller.contextText).toBe("");
    expect(controller.session.contextText).toBe("");
  });

  it("shows Incomplete finalization before releasing resources", async () => {
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

    expect(order).toEqual(["close", "shown", "release"]);
    expect(controller.ownerError).toBe(INCOMPLETE_FINALIZATION_MESSAGE);
    expect(controller.session.state).toBe("idle");
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

    expect(controller.session.state).toBe("idle");
    expect(controller.ownerError).toBeUndefined();
  });

  it("does not unmute after close rejects a pending later steering ack", async () => {
    const { controller, live, audio } = createController();
    let rejectSteering: ((error: Error) => void) | undefined;
    live.appendInstructions.mockImplementation(async (text: string, policy?: { kind: string }) => {
      live.callOrder.push(`instructions:${text}`);
      if (policy?.kind === "later_steering") {
        await new Promise<void>((_resolve, reject) => {
          rejectSteering = reject;
        });
      }
      return { eventId: "evt-steer" };
    });
    live.setInputMuted.mockImplementation(async (muted: boolean) => {
      live.callOrder.push(`setInputMuted:${muted}`);
    });
    live.close.mockImplementation(async () => {
      live.callOrder.push("close");
      rejectSteering?.(new Error("Live client is closing"));
      return { finalized: true };
    });
    await enterListening(controller);
    emitVoice(audio, true);
    live.emit({ type: "session.input_transcript.delta", delta: "Hello" });
    live.emit({ type: "session.output_transcript.delta", delta: "Hola" });
    emitVoice(audio, false);
    await flushMicrotasks();
    await vi.advanceTimersByTimeAsync(runtime.audioStartGraceMs);
    await flushMicrotasks();
    await vi.waitFor(() => {
      if (rejectSteering === undefined) {
        throw new Error("later steering append was not started");
      }
    });

    await controller.endConversation();
    await flushMicrotasks();

    const closeIndex = live.callOrder.indexOf("close");
    expect(closeIndex).toBeGreaterThanOrEqual(0);
    expect(live.callOrder.slice(closeIndex + 1)).not.toContain("setInputMuted:false");
    expect(controller.session.state).toBe("idle");
  });

  it("handles a pending unmute rejection after local end starts", async () => {
    const { controller, live, audio } = createController();
    let rejectUnmute: ((error: Error) => void) | undefined;
    live.setInputMuted.mockImplementation(async (muted: boolean) => {
      live.callOrder.push(`setInputMuted:${muted}`);
      if (!muted) {
        await new Promise<void>((_resolve, reject) => {
          rejectUnmute = reject;
        });
      }
    });
    await enterListening(controller);
    emitVoice(audio, true);
    live.emit({ type: "session.input_transcript.delta", delta: "Hello" });
    live.emit({ type: "session.output_transcript.delta", delta: "Hola" });
    emitVoice(audio, false);
    await flushMicrotasks();
    await vi.advanceTimersByTimeAsync(runtime.audioStartGraceMs);
    await flushMicrotasks();
    await vi.waitFor(() => {
      if (rejectUnmute === undefined) {
        throw new Error("unmute was not started");
      }
    });

    const ending = controller.endConversation();
    rejectUnmute?.(new Error("Live client is closing"));
    await ending;
    await flushMicrotasks();

    expect(controller.session.state).toBe("idle");
    expect(controller.ownerError).toBeUndefined();
  });

  it("handles a pending source-resume unmute rejection after local end starts", async () => {
    const { controller, live, audio } = createController();
    let rejectUnmute: ((error: Error) => void) | undefined;
    live.setInputMuted.mockImplementation(async (muted: boolean) => {
      live.callOrder.push(`setInputMuted:${muted}`);
      if (!muted) {
        await new Promise<void>((_resolve, reject) => {
          rejectUnmute = reject;
        });
      }
    });
    await enterListening(controller);
    emitVoice(audio, true);
    live.emit({ type: "session.input_transcript.delta", delta: "Hello" });
    emitVoice(audio, false);
    await flushMicrotasks();
    expect(controller.session.activeTurn?.sourceIdleAtMs).toBeDefined();
    expect(live.setInputMuted).toHaveBeenCalledWith(true);

    emitVoice(audio, true);
    await vi.waitFor(() => {
      if (rejectUnmute === undefined) {
        throw new Error("source-resume unmute was not started");
      }
    });

    const ending = controller.endConversation();
    rejectUnmute?.(new Error("Live client is closing"));
    await ending;
    await flushMicrotasks();

    expect(controller.session.state).toBe("idle");
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
    live.onSessionStarted?.({ type: "session.started", session: { id: "sess_1" } });

    await vi.advanceTimersByTimeAsync(runtime.maxSessionMs - 1);
    expect(live.close).not.toHaveBeenCalled();
    expect(controller.session.state).toBe("listening");

    await vi.advanceTimersByTimeAsync(1);
    await flushMicrotasks();

    expect(live.close).toHaveBeenCalledOnce();
    expect(audio.stopCapture).toHaveBeenCalled();
    expect(controller.session.state).toBe("idle");
  });

  it("ignores stale session.started callbacks after reset swaps the Live client", async () => {
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
    const staleSessionStarted = firstLive.onSessionStarted;
    expect(staleSessionStarted).toBeTypeOf("function");

    await enterListening(controller);
    await controller.cancel();
    expect(controller.session.state).toBe("idle");
    expect(vi.getTimerCount()).toBe(0);

    staleSessionStarted?.({ type: "session.started", session: { id: "late" } });

    expect(vi.getTimerCount()).toBe(0);
    await vi.advanceTimersByTimeAsync(runtime.maxSessionMs);
    expect(replacementLive.close).not.toHaveBeenCalled();
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
    live.emit({ type: "session.input_transcript.delta", delta: "Hello" });
    live.emit({ type: "session.output_transcript.delta", delta: "Hola" });
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
    live.emit({ type: "session.input_transcript.delta", delta: "Hello" });
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

  it("records wrong-side correction and success counts", async () => {
    const { controller, live, audio } = createController();
    await enterListening(controller);
    emitVoice(audio, true);
    live.emit({ type: "session.input_transcript.delta", delta: "Hello" });
    live.emit({ type: "session.output_transcript.delta", delta: "Hola" });
    emitPlayback(audio, true);
    await flushMicrotasks();
    emitVoice(audio, false);
    await flushMicrotasks();
    emitPlayback(audio, false);
    await flushMicrotasks();

    await controller.correctLastTurn("B");

    const snapshot = controller.metrics.snapshot();
    expect(snapshot.wrongSideCorrectionCount).toBe(1);
    expect(snapshot.correctionSuccessCount).toBe(1);
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
    live.emit({ type: "session.input_transcript.delta", delta: "Hello" });
    expect(controller.session.activeTurn?.status).toBe("streaming");
    expect(controller.session.expectedSpeaker).toBe("A");
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
    expect(controller.ownerError).toBe("resume steering rejected");
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
    expect(controller.session.expectedSpeaker).toBe("A");
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
    expect(controller.session.expectedSpeaker).toBe("A");

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
    expect(controller.ownerError).toBe("unmute failed");
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
    expect(controller.session.expectedSpeaker).toBe("A");
    expect(controller.recoveryPrompt).toBe("repeat");
    expect(live.appendInstructions.mock.calls.length).toBe(steeringAfterStart + 1);
    expect(live.appendInstructions).toHaveBeenLastCalledWith(
      buildSteering({ expectedSource: "A", recipient: "B" }),
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
    expect(controller.session.expectedSpeaker).toBe("A");
    expect(controller.recoveryPrompt).toBe("repeat");
    expect(live.appendInstructions).toHaveBeenLastCalledWith(
      buildSteering({ expectedSource: "A", recipient: "B" }),
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
    expect(controller.ownerError).toMatch(/Microphone track is not live/);
    expect(controller.session.expectedSpeaker).toBe("A");
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
    expect(controller.ownerError).toMatch(/peer/i);
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
    expect(controller.ownerError).toMatch(/data channel/i);
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
    expect(controller.ownerError).toMatch(/peer/i);
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
      buildSteering({ expectedSource: "A", recipient: "B" }),
      { kind: "later_steering", sessionState: "suspended" },
    );
    expect(audio.setOutputAudible).toHaveBeenLastCalledWith(true);
    expect(live.setInputMuted).toHaveBeenLastCalledWith(false);
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
