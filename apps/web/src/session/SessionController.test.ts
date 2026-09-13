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
  buildInterpreterInstructions,
  buildSteering,
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
  readonly appendInstructions = vi.fn(async (text: string) => {
    this.callOrder.push(`instructions:${text}`);
    return { eventId: "evt-instructions" };
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
});
