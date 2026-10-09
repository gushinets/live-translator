import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { AudioController } from "../audio/AudioController";
import type { TranscriptDeltaEvent } from "../live/LiveEvents";
import type { LiveClient } from "../live/LiveClient";
import type { OrientationController } from "../platform/OrientationController";
import type { VisibilityController } from "../platform/VisibilityController";
import type { WakeLockController } from "../platform/WakeLockController";
import { PttSessionController } from "./PttSessionController";

beforeEach(() => vi.useFakeTimers());
afterEach(() => { vi.useRealTimers(); vi.restoreAllMocks(); });

async function setup() {
  const lives: Array<{ onTranscriptDelta?: (event: TranscriptDeltaEvent) => void; onError?: (event: unknown) => void }> = [];
  const track = { enabled: true, readyState: "live" };
  const stream = { getAudioTracks: () => [track], getTracks: () => [track] } as unknown as MediaStream;
  const audio = {
    onVoiceActivity: null as AudioController["onVoiceActivity"], onPlaybackActivity: null as AudioController["onPlaybackActivity"],
    onAudioInterruption: null, onAudioRestored: null, onCaptureEnded: null,
    primeOutput: vi.fn(async () => {}), playOutput: vi.fn(async () => {}),
    setOutputAudible: vi.fn(), setPlaybackHold: vi.fn(() => true), setPlaybackTurn: vi.fn(),
    startCapture: vi.fn(async () => {}), stopCapture: vi.fn(), attachRemoteStream: vi.fn(),
    getCaptureStream: () => stream, resetVoiceActivityBaseline: vi.fn(), playbackInputBlocked: false,
    setCaptureEnabled: vi.fn((enabled: boolean) => { track.enabled = enabled; }),
    audioElement: { play: vi.fn(async () => {}), muted: false } as unknown as HTMLAudioElement,
  };
  const visibility = { start() {}, stop() {}, isHidden: () => false, onHidden: null as (() => void) | null, onVisible: null };
  const controller = new PttSessionController({ audio: audio as unknown as AudioController,
    createLive: () => {
      const live = { onTranscriptDelta: undefined as ((event: TranscriptDeltaEvent) => void) | undefined,
        connect: vi.fn(async () => ({ sessionId: "fake" })), close: vi.fn(async () => ({ finalized: true })),
        disconnectImmediately: vi.fn(async () => {}), setInputMuted: vi.fn(async () => {}),
        appendInstructions: vi.fn(async () => ({})), appendThinking: vi.fn(async () => ({})), appendCommentary: vi.fn(async () => ({})),
        peerConnectionState: "connected", dataChannelReadyState: "open" };
      lives.push(live); return live as unknown as LiveClient;
    },
    orientation: { start() {}, stop() {}, lockPortrait: async () => {}, isPortrait: () => true, getOrientation: () => "portrait" } as unknown as OrientationController,
    visibility: visibility as unknown as VisibilityController,
    wakeLock: { request: async () => {}, reacquire: async () => {}, release: async () => {} } as WakeLockController,
  });
  await controller.startWithLanguages({ A: "ru", B: "en" });
  const emit = (kind: "input" | "output", delta: string, start_ms?: number, end_ms?: number, event_id?: string) =>
    lives.at(-1)!.onTranscriptDelta?.({ type: kind === "input" ? "session.input_transcript.delta" : "session.output_transcript.delta", delta, start_ms, end_ms, event_id });
  const voice = (active: boolean) => audio.onVoiceActivity?.({ active, atMs: Date.now() });
  return { controller, audio, lives, emit, voice, visibility, track };
}

describe("PTT session integration", () => {
  it("keeps late A uncertain after a language change on the same transport", async () => {
    const f = await setup();
    f.controller.pressPtt(); f.voice(true); f.emit("input", "early A");
    f.controller.releasePtt(); await vi.advanceTimersByTimeAsync(6000);
    await f.controller.changeInterlocutorLanguage("de");
    expect(f.controller.session.participantB.language).toBe("de");
    f.emit("input", "late A", 100, 200);
    expect(f.controller.captionBlocks.every(block => block.side === undefined)).toBe(true);
    expect(f.controller.captionBlocks.map(block => block.text).join("")).toContain("late A");
    await f.controller.endConversation();
  });
  it("clears repeat guidance when fresh source speech starts", async () => {
    const f = await setup();
    f.voice(true); f.emit("input", "B without output"); f.voice(false);
    await vi.advanceTimersByTimeAsync(6000);
    expect(f.controller.recoveryPrompt).toBe("repeat");
    f.controller.pressPtt(); f.voice(true);
    expect(f.controller.recoveryPrompt).toBeUndefined();
    await f.controller.endConversation();
  });
  it("keeps the B 30-second cap when captions arrive before VAD and do not rearm it", async () => {
    const f = await setup();
    f.emit("input", "quiet B first");
    f.voice(true);
    await vi.advanceTimersByTimeAsync(20_000);
    f.emit("input", " more");
    f.voice(true);
    await vi.advanceTimersByTimeAsync(10_001);
    expect(f.controller.session.state).toBe("suspended");
    expect(f.controller.recoveryPrompt).toBe("resume-repeat");
    await f.controller.endConversation();
  });
  it("holds A past 30 seconds, preserves release time, and retains uncertain captions", async () => {
    const f = await setup();
    expect(f.controller.pressPtt()).toBe(true);
    f.voice(true); f.emit("input", "Мне нужен iPhone Pro Max и Google Maps", 100, 900);
    f.voice(false);
    await vi.advanceTimersByTimeAsync(35_000);
    expect(f.controller.pttHeld).toBe(true);
    expect(f.controller.session.activeTurn?.sourceIdleAtMs).toBeUndefined();
    expect(f.controller.session.activeTurn?.speaker).toBe("A");
    f.controller.releasePtt();
    const releasedAt = f.controller.session.activeTurn?.sourceIdleAtMs;
    await vi.advanceTimersByTimeAsync(100);
    f.emit("input", ".", 800, 900);
    f.emit("output", "I need an iPhone Pro Max and Google Maps", 1000, 1500);
    expect(f.controller.captionBlocks.map(block => block.side)).toEqual([undefined, undefined]);
    expect(f.controller.captionBlocks.map(block => block.text).join("")).toContain("Maps.");
    expect(f.controller.session.activeTurn?.sourceIdleAtMs).toBe(releasedAt);
    expect(f.audio.setPlaybackHold).toHaveBeenLastCalledWith(false);
    await f.controller.endConversation();
  });
  it("free B remains B for Спасибо, and uncertain late B during A never becomes A", async () => {
    const f = await setup();
    f.voice(true); f.emit("input", "Спасибо", 100, 500); f.voice(false);
    expect(f.controller.session.activeTurn?.speaker).toBe("B");
    f.controller.pressPtt(); f.voice(true);
    f.emit("input", "!", 200, 300);
    f.emit("output", "competing translation");
    expect(f.controller.captionBlocks[0]?.side).toBe("B");
    expect(f.controller.captionBlocks[0]?.text).toBe("Спасибо");
    expect(f.controller.captionBlocks.at(-1)?.side).toBeUndefined();
    expect(f.controller.session.pendingTurns?.find(turn => turn.speaker === "B")?.originalText).toBe("Спасибо");
    await f.controller.endConversation();
  });
  it("a silent tap has no phantom turn, watchdog, error or retained hold", async () => {
    const f = await setup();
    f.controller.pressPtt(); f.controller.releasePtt();
    await vi.advanceTimersByTimeAsync(6000);
    expect(f.controller.session.activeTurn).toBeUndefined();
    expect(f.controller.session.recentTurns).toHaveLength(0);
    expect(f.controller.recoveryPrompt).toBeUndefined();
    expect(f.controller.pttHeld).toBe(false);
    await f.controller.endConversation();
  });
  it("refuses playback-time presses but output text cannot terminate an accepted hold", async () => {
    const f = await setup();
    f.audio.playbackInputBlocked = true;
    expect(f.controller.pressPtt()).toBe(false);
    f.audio.playbackInputBlocked = false;
    f.controller.pressPtt(); f.voice(true); f.emit("output", "hello");
    expect(f.controller.pttHeld).toBe(true);
    expect(f.controller.pressPtt()).toBe(false);
    await f.controller.endConversation();
  });
  it("at 120 seconds closes capture and requires actual release before another interval", async () => {
    const f = await setup();
    f.controller.pressPtt(); f.voice(true); f.emit("input", "long A");
    await vi.advanceTimersByTimeAsync(120_000);
    expect(f.controller.pttHeld).toBe(false);
    expect(f.controller.pttAwaitingRelease).toBe(true);
    expect(f.track.enabled).toBe(false);
    f.voice(true);
    expect(f.controller.session.activeTurn).toBeUndefined();
    expect(f.controller.pressPtt()).toBe(false);
    f.controller.releasePtt();
    expect(f.track.enabled).toBe(true);
    expect(f.controller.pressPtt()).toBe(true);
    expect(f.controller.session.activeTurn).toBeUndefined();
    f.controller.releasePtt();
    await vi.advanceTimersByTimeAsync(6000);
    expect(f.controller.session.activeTurn).toBeUndefined();
    await f.controller.endConversation();
  });
  it("fences old held generations on end, background suspension and reconnect", async () => {
    const f = await setup();
    f.controller.pressPtt(); f.voice(true); f.emit("input", "retained");
    const old = f.lives.at(-1)!.onTranscriptDelta!;
    await f.controller.endConversation();
    expect(f.controller.pttHeld).toBe(false);
    expect(f.controller.captionBlocks[0]?.text).toBe("retained");
    await f.controller.cancel();
    await f.controller.startWithLanguages({ A: "ru", B: "en" });
    old({ type: "session.input_transcript.delta", delta: "stale" });
    expect(f.controller.captionBlocks).toHaveLength(0);
    f.controller.pressPtt(); f.voice(true);
    f.visibility.onHidden?.();
    await vi.advanceTimersByTimeAsync(0);
    expect(f.controller.pttHeld).toBe(false);
    expect(f.controller.session.state).toBe("suspended");
    await f.controller.endConversation();
  });
  it("cancelled speech is retained as interrupted, not completed", async () => {
    const f = await setup();
    f.controller.pressPtt(); f.voice(true); f.emit("input", "incomplete");
    f.controller.releasePtt(true);
    expect(f.controller.session.recentTurns[0]?.status).toBe("discarded");
    expect(f.controller.metrics.snapshot().discardedTurnCount).toBe(1);
    expect(f.controller.pttNotice).toContain("прервана");
    expect(f.controller.captionBlocks[0]?.text).toBe("incomplete");
    await f.controller.endConversation();
  });
});
