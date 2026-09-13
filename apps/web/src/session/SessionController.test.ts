import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { AudioController } from "../audio/AudioController";
import { runtime } from "../config/runtime";
import type { LiveClient } from "../live/LiveClient";
import {
  APPEND_CHAR_BUDGET,
  ContextTooLongError,
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
import { SessionController } from "./SessionController";

afterEach(() => {
  vi.useRealTimers();
  vi.restoreAllMocks();
});

class FakeLive {
  onTranscriptDelta: ((event: TranscriptDeltaEvent) => void) | null = null;
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
  readonly appendInstructions = vi.fn(async (text: string, _policy?: { kind: string }) => {
    this.callOrder.push(`instructions:${text}`);
    return { eventId: "evt-instructions" };
  });
  readonly appendCommentary = vi.fn(async (text: string, _policy?: { kind: string }) => {
    this.callOrder.push(`commentary:${text}`);
    return { eventId: "evt-commentary" };
  });
  readonly setInputMuted = vi.fn(async () => {
    this.callOrder.push("setInputMuted");
  });

  emit(event: TranscriptDeltaEvent): void {
    if (this.onTranscriptDelta === null) {
      throw new Error("Transcript handler was not installed");
    }
    this.onTranscriptDelta(event);
  }
}

function createFakeAudio() {
  const captureStream = { id: "mic-stream" } as MediaStream;
  let stream: MediaStream | null = null;
  return {
    captureStream,
    primeOutput: vi.fn(async () => {}),
    setOutputAudible: vi.fn(),
    startCapture: vi.fn(async () => {
      stream = captureStream;
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
    resetVoiceActivityBaseline: vi.fn(),
  };
}

function setDeviceLanguage(language: string): void {
  Object.defineProperty(navigator, "language", {
    configurable: true,
    get: () => language,
  });
}

function createController(options: {
  live?: FakeLive;
  audio?: ReturnType<typeof createFakeAudio>;
} = {}) {
  const live = options.live ?? new FakeLive();
  const audio = options.audio ?? createFakeAudio();
  const controller = new SessionController({
    createLive: () => live as unknown as LiveClient,
    audio: audio as unknown as AudioController,
  });
  return { controller, live, audio };
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
      { kind: "startup_interpreter" },
    );
    expect(live.appendInstructions).toHaveBeenNthCalledWith(1, buildInterpreterInstructions(), {
      kind: "startup_interpreter",
    });
    expect(live.appendInstructions).toHaveBeenNthCalledWith(
      2,
      buildSteering({
        expectedSource: "A",
        recipient: "B",
        initialRecipientHint: "Spanish",
      }),
      { kind: "first_steering", sessionState: "bootstrap" },
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
      { kind: "first_steering", sessionState: "bootstrap" },
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
      "This text is too long to send. Please shorten the context and try again.",
    );
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

  it("sets ownerError on interpreter failure, stays on the owner screen, and does not resend thinking", async () => {
    const { controller, live } = createController();
    await controller.startContextCapture();
    controller.setContextText("We are ordering lunch.");
    await controller.startBootstrap();
    controller.skipBootstrap();

    live.appendInstructions.mockRejectedValueOnce(new Error("ack timeout"));

    await expect(controller.beginInterpreter()).rejects.toThrow("ack timeout");
    expect(controller.session.state).toBe("bootstrap");
    expect(controller.ownerError).toBe("ack timeout");
    expect(live.appendThinking).toHaveBeenCalledOnce();
    expect(live.appendInstructions).toHaveBeenCalledOnce();

    live.appendInstructions.mockResolvedValue({ eventId: "evt-retry" });
    await controller.beginInterpreter();

    expect(live.appendThinking).toHaveBeenCalledOnce();
    expect(live.appendInstructions).toHaveBeenCalledTimes(3);
    expect(controller.session.state).toBe("listening");
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

  it("sets ownerError on microphone and connect failures", async () => {
    const audio = createFakeAudio();
    audio.startCapture.mockRejectedValueOnce(new Error("Microphone access is required for translation."));
    const { controller: micController } = createController({ audio });

    await expect(micController.startContextCapture()).rejects.toThrow(
      "Microphone access is required for translation.",
    );
    expect(micController.ownerError).toBe("Microphone access is required for translation.");

    const live = new FakeLive();
    live.connect.mockRejectedValueOnce(new Error("Unable to establish live connection"));
    const { controller: connectController } = createController({ live });

    await expect(connectController.startContextCapture()).rejects.toThrow(
      "Unable to establish live connection",
    );
    expect(connectController.ownerError).toBe("Unable to establish live connection");
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
    expect(controller.ownerError).toBe("Microphone access is required for translation.");

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
  audio: ReturnType<typeof createFakeAudio>,
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

  it("MAX_SOURCE_MS mutes, closes output, fails, warns, and suspends with Resume/Repeat", async () => {
    const { controller, live, audio } = createController();
    await enterListening(controller);
    emitVoice(audio, true);
    live.emit({ type: "session.input_transcript.delta", delta: "Hello" });

    await vi.advanceTimersByTimeAsync(runtime.maxSourceMs);
    await flushMicrotasks();

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
    expect(audio.setOutputAudible).toHaveBeenLastCalledWith(true);
    expect(controller.session.state).toBe("listening");
    expect(controller.session.expectedSpeaker).toBe("A");
    expect(controller.recoveryPrompt).toBeUndefined();
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
    emitVoice(audio, true);
    live.emit({ type: "session.input_transcript.delta", delta: "Next" });
    expect(controller.session.activeTurn?.originalText).toBe("Next");
    expect(controller.session.expectedSpeaker).toBe("B");
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

  it("sends commentary after the settle timeout if playback stays active", async () => {
    const { controller, live, audio } = createController();
    await startAudibleTurnAssignedA(controller, live, audio);

    const pending = controller.correctLastTurn("B");
    await flushMicrotasks();
    expect(live.appendCommentary).not.toHaveBeenCalled();

    await vi.advanceTimersByTimeAsync(runtime.outputSettleGraceMs - 1);
    await flushMicrotasks();
    expect(live.appendCommentary).not.toHaveBeenCalled();

    await vi.advanceTimersByTimeAsync(1);
    await pending;

    expect(live.appendCommentary).toHaveBeenCalledWith(buildCorrectionCommentaryTrigger(), {
      kind: "correction",
    });
    expect(controller.session.state).toBe("outputting");
    expect(controller.session.activeTurn?.speaker).toBe("B");
    expect(audio.setOutputAudible).toHaveBeenLastCalledWith(true);
    expect(controller.session.activeTurn?.audioOutputStarted).toBe(true);
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
    expect(controller.ownerError).toBe("correction ack timeout");
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
});
