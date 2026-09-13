import { BackendClient } from "../api/BackendClient";
import { AudioController } from "../audio/AudioController";
import type { AudioActivityEvent } from "../audio/VoiceActivityMonitor";
import { runtime } from "../config/runtime";
import {
  buildTurnCompletionSnapshot,
  evaluateTurnCompletion,
} from "../conversation/TurnCompletion";
import { createTranscriptFragment } from "../conversation/TurnBuffer";
import { LiveClient } from "../live/LiveClient";
import {
  APPEND_CHAR_BUDGET,
  ContextTooLongError,
  type TranscriptDeltaEvent,
} from "../live/LiveEvents";
import {
  buildAuthoritativeContext,
  buildInterpreterInstructions,
  buildSteering,
  buildUnfinishedTurnWarning,
} from "../live/LivePrompts";
import { sessionReducer, type SessionAction } from "./sessionReducer";
import {
  createInitialSession,
  type TranslationSession,
} from "./SessionState";

export type RecoveryPrompt = "repeat" | "resume-repeat";

export interface SessionControllerDeps {
  createLive: () => LiveClient;
  audio: Pick<
    AudioController,
    | "primeOutput"
    | "setOutputAudible"
    | "startCapture"
    | "stopCapture"
    | "getCaptureStream"
    | "attachRemoteStream"
    | "audioElement"
    | "resetVoiceActivityBaseline"
  > & {
    onVoiceActivity: AudioController["onVoiceActivity"];
    onPlaybackActivity: AudioController["onPlaybackActivity"];
  };
}

/**
 * Owns the owner start flow and the interpreter-mode turn engine.
 * Binding spec 1.2.1 §3.1–§4.5, §5.4–§5.5, §9–§10.
 */
export class SessionController {
  private currentSession: TranslationSession;
  private live: LiveClient;
  private contextBuffer = "";
  private bootstrapBuffer = "";
  private ownerErrorMessage: string | undefined;
  private degradedBootstrap = false;
  private capturingContext = false;
  private capturingBootstrap = false;
  private contextFrozenByUser = false;
  private authoritativeContextSent = false;
  private hasConnected = false;
  private liveConnectStarted = false;
  private connectInFlight = false;
  private connectWork: Promise<void> | null = null;
  private interpreterInFlight = false;
  private interpreterWork: Promise<void> | null = null;
  private cancelWork: Promise<void> | null = null;
  private sessionGeneration = 0;
  private idleTimer: number | null = null;
  private maxSourceTimer: number | null = null;
  private completionTimer: number | null = null;
  private captionIdleTimer: number | null = null;
  private gateBMuted = false;
  private playbackActive = false;
  private turnClosing = false;
  private recoveryPromptKind: RecoveryPrompt | undefined;
  private steeringDegradedFlag = false;
  private readonly listeners = new Set<() => void>();

  constructor(private readonly deps: SessionControllerDeps) {
    this.currentSession = createSessionFromDeviceLocale();
    this.live = deps.createLive();
    this.bindLive();
    this.bindAudio();
  }

  get session(): TranslationSession {
    return this.currentSession;
  }

  get contextText(): string {
    return this.contextBuffer;
  }

  get bootstrapText(): string {
    return this.bootstrapBuffer;
  }

  get ownerError(): string | undefined {
    return this.ownerErrorMessage;
  }

  get bootstrapDegraded(): boolean {
    return this.degradedBootstrap;
  }

  get recoveryPrompt(): RecoveryPrompt | undefined {
    return this.recoveryPromptKind;
  }

  get steeringDegraded(): boolean {
    return this.steeringDegradedFlag;
  }

  get isConnectInFlight(): boolean {
    return this.connectInFlight || this.cancelWork !== null;
  }

  get isInterpreterStarting(): boolean {
    return this.interpreterInFlight;
  }

  get audioElement(): HTMLAudioElement {
    return this.audio.audioElement;
  }

  subscribe(listener: () => void): () => void {
    this.listeners.add(listener);
    return () => {
      this.listeners.delete(listener);
    };
  }

  setContextText(text: string): void {
    this.contextFrozenByUser = true;
    this.finishContextCapture();
    this.applyContextText(text);
  }

  clearContext(): void {
    this.setContextText("");
  }

  async startContextCapture(): Promise<void> {
    if (this.cancelWork !== null) {
      await this.cancelWork;
    }
    if (this.connectWork !== null) {
      await this.connectWork;
      return;
    }
    const work = this.runStartContextCapture();
    this.connectWork = work;
    try {
      await work;
    } finally {
      if (this.connectWork === work) {
        this.connectWork = null;
      }
    }
  }

  finishContextCapture(): void {
    this.capturingContext = false;
  }

  async startBootstrap(): Promise<void> {
    if (this.cancelWork !== null) {
      await this.cancelWork;
    }
    if (this.connectWork !== null) {
      await this.connectWork;
      return;
    }
    const work = this.runStartBootstrap();
    this.connectWork = work;
    try {
      await work;
    } finally {
      if (this.connectWork === work) {
        this.connectWork = null;
      }
    }
  }

  handleRemoteStream(stream: MediaStream): void {
    this.audio.attachRemoteStream(stream);
    void this.audio.audioElement.play().catch((error: unknown) => {
      console.error("Remote audio play failed", { error });
      throw error;
    });
  }

  async resumeFromSourceTimeout(): Promise<void> {
    if (this.currentSession.state !== "suspended") {
      throw new Error(`Cannot resume from "${this.currentSession.state}"`);
    }
    this.audio.resetVoiceActivityBaseline();
    this.audio.setOutputAudible(true);
    this.recoveryPromptKind = undefined;
    this.playbackActive = false;
    await this.unmuteGateB();
    this.dispatch({ type: "RESUME" });
  }

  acceptBootstrap(text: string): void {
    if (this.currentSession.state !== "bootstrap") {
      throw new Error(`Cannot accept bootstrap from "${this.currentSession.state}"`);
    }
    const hint = text.trim();
    if (hint.length === 0) {
      throw new Error("Bootstrap language hint is empty");
    }
    this.degradedBootstrap = false;
    this.currentSession = {
      ...this.currentSession,
      participantB: {
        side: "B",
        initialLanguageHint: hint,
        languageHintSource: "bootstrap",
        hasAcceptedConversationSpeech: false,
      },
    };
    this.notify();
  }

  skipBootstrap(): void {
    if (this.currentSession.state !== "bootstrap") {
      throw new Error(`Cannot skip bootstrap from "${this.currentSession.state}"`);
    }
    this.degradedBootstrap = true;
    this.currentSession = {
      ...this.currentSession,
      participantB: {
        side: "B",
        hasAcceptedConversationSpeech: false,
      },
    };
    this.notify();
  }

  async beginInterpreter(): Promise<void> {
    if (this.interpreterWork !== null) {
      await this.interpreterWork;
      return;
    }
    const work = this.runBeginInterpreter();
    this.interpreterWork = work;
    try {
      await work;
    } finally {
      if (this.interpreterWork === work) {
        this.interpreterWork = null;
      }
    }
  }

  private async runBeginInterpreter(): Promise<void> {
    if (this.currentSession.state !== "bootstrap") {
      throw new Error(`Cannot begin interpreter from "${this.currentSession.state}"`);
    }

    const live = this.live;
    const generation = this.sessionGeneration;
    this.interpreterInFlight = true;
    this.ownerErrorMessage = undefined;
    this.notify();
    try {
      const edited = this.contextBuffer.trim();
      if (edited.length > 0 && !this.authoritativeContextSent) {
        const payload = buildAuthoritativeContext(edited);
        if (payload.length > APPEND_CHAR_BUDGET) {
          this.ownerErrorMessage = new ContextTooLongError().message;
          this.notify();
          throw new ContextTooLongError();
        }
        try {
          await live.appendThinking(payload, { kind: "startup_interpreter" });
        } catch (error) {
          if (this.sessionGeneration !== generation) {
            return;
          }
          this.failOwnerRequest("Authoritative context append failed", error);
        }
        if (this.sessionGeneration !== generation) {
          return;
        }
        this.authoritativeContextSent = true;
      }

      try {
        await live.appendInstructions(buildInterpreterInstructions(), {
          kind: "startup_interpreter",
        });
      } catch (error) {
        if (this.sessionGeneration !== generation) {
          return;
        }
        this.failOwnerRequest("BEGIN_INTERPRETER_MODE append failed", error);
      }
      if (this.sessionGeneration !== generation) {
        return;
      }

      const recipientHint = this.degradedBootstrap
        ? undefined
        : this.currentSession.participantB.initialLanguageHint;
      try {
        await live.appendInstructions(
          buildSteering({
            expectedSource: "A",
            recipient: "B",
            initialRecipientHint: recipientHint,
          }),
          {
            kind: "first_steering",
            sessionState: this.currentSession.state,
          },
        );
      } catch (error) {
        if (this.sessionGeneration !== generation) {
          return;
        }
        this.failOwnerRequest("First steering append failed", error);
      }
      if (this.sessionGeneration !== generation) {
        return;
      }

      this.clearIdleTimer();
      this.capturingBootstrap = false;
      this.audio.setOutputAudible(true);
      this.dispatch({ type: "INTERPRETER_READY" });
    } finally {
      if (this.sessionGeneration === generation) {
        this.interpreterInFlight = false;
        this.notify();
      }
    }
  }

  async cancel(): Promise<void> {
    if (this.cancelWork !== null) {
      await this.cancelWork;
      return;
    }
    const work = this.runCancel();
    this.cancelWork = work;
    try {
      await work;
    } finally {
      if (this.cancelWork === work) {
        this.cancelWork = null;
      }
    }
  }

  private async runCancel(): Promise<void> {
    const pendingConnect = this.connectWork;
    const shouldWaitForMic =
      pendingConnect !== null && !this.hasConnected && !this.liveConnectStarted;
    this.clearIdleTimer();
    this.clearTurnEngineTimers();
    this.capturingContext = false;
    this.capturingBootstrap = false;
    if (this.hasConnected || this.liveConnectStarted) {
      try {
        await this.live.close();
      } catch (error) {
        console.error("Live session close failed", {
          error,
          state: this.currentSession.state,
        });
        throw error;
      }
    }
    if (this.audio.getCaptureStream() !== null) {
      this.audio.stopCapture();
    }
    this.resetToIdle();
    if (shouldWaitForMic) {
      try {
        await pendingConnect;
      } catch (error) {
        console.error("Cancelled connect attempt rejected after reset", {
          error,
          state: this.currentSession.state,
        });
      }
      if (this.audio.getCaptureStream() !== null) {
        this.audio.stopCapture();
      }
    }
  }

  private get audio(): SessionControllerDeps["audio"] {
    return this.deps.audio;
  }

  private bindLive(): void {
    this.live.onTranscriptDelta = (event) => {
      this.handleTranscriptDelta(event);
    };
  }

  private bindAudio(): void {
    this.audio.onVoiceActivity = (event) => {
      void this.handleVoiceActivity(event);
    };
    this.audio.onPlaybackActivity = (event) => {
      void this.handlePlaybackActivity(event);
    };
  }

  private handleTranscriptDelta(event: TranscriptDeltaEvent): void {
    if (event.type === "session.input_transcript.delta") {
      if (
        this.capturingContext &&
        !this.contextFrozenByUser &&
        this.currentSession.state === "context"
      ) {
        this.applyContextText(this.contextBuffer + event.delta);
        return;
      }
      if (this.capturingBootstrap && this.currentSession.state === "bootstrap") {
        this.bootstrapBuffer += event.delta;
        this.notify();
        return;
      }
      this.handleConversationInputDelta(event);
      return;
    }
    this.handleConversationOutputDelta(event);
  }

  private handleConversationInputDelta(event: TranscriptDeltaEvent): void {
    if (this.currentSession.state !== "listening" && this.currentSession.state !== "outputting") {
      return;
    }
    if (event.delta.length === 0) {
      return;
    }
    const fragment = createTranscriptFragment({
      text: event.delta,
      nowMs: Date.now(),
      startMs: event.start_ms,
      endMs: event.end_ms,
    });
    if (this.currentSession.activeTurn === undefined) {
      if (this.currentSession.state !== "listening") {
        throw new Error(
          `Cannot start a source turn from transcript while session state is "${this.currentSession.state}"`,
        );
      }
      this.dispatch({
        type: "SOURCE_ACTIVE",
        turnId: crypto.randomUUID(),
        speaker: this.currentSession.expectedSpeaker,
        sideSource: "prior",
        fragment,
      });
      this.armMaxSourceTimer();
      return;
    }
    this.dispatch({ type: "SOURCE_FRAGMENT", fragment });
  }

  private handleConversationOutputDelta(event: TranscriptDeltaEvent): void {
    if (this.currentSession.state !== "listening" && this.currentSession.state !== "outputting") {
      return;
    }
    if (this.currentSession.activeTurn === undefined) {
      throw new Error("Cannot append output transcript without an active turn");
    }
    if (event.delta.length === 0) {
      return;
    }
    this.dispatch({
      type: "OUTPUT_DELTA",
      text: event.delta,
      nowMs: Date.now(),
    });
    this.armCaptionIdleTimer();
    void this.considerTurnCompletion(Date.now());
  }

  private async handleVoiceActivity(event: AudioActivityEvent): Promise<void> {
    if (this.currentSession.state !== "listening" && this.currentSession.state !== "outputting") {
      return;
    }
    const generation = this.sessionGeneration;
    if (event.active) {
      this.recoveryPromptKind = undefined;
      this.clearCompletionTimer();
      const activeTurn = this.currentSession.activeTurn;
      const wasIdle = activeTurn?.sourceIdleAtMs !== undefined;
      if (activeTurn === undefined) {
        this.dispatch({
          type: "SOURCE_ACTIVE",
          turnId: crypto.randomUUID(),
          speaker: this.currentSession.expectedSpeaker,
          sideSource: "prior",
        });
        this.armMaxSourceTimer();
        return;
      }
      this.dispatch({
        type: "SOURCE_ACTIVE",
        turnId: activeTurn.id,
        speaker: activeTurn.speaker,
        sideSource: activeTurn.sideSource,
      });
      if (wasIdle) {
        this.armMaxSourceTimer();
        if (this.gateBMuted) {
          await this.unmuteGateB();
        }
      }
      if (this.sessionGeneration !== generation) {
        return;
      }
      return;
    }
    if (this.currentSession.activeTurn === undefined) {
      return;
    }
    this.clearMaxSourceTimer();
    this.dispatch({ type: "SOURCE_IDLE" });
    await this.muteGateB();
    if (this.sessionGeneration !== generation) {
      return;
    }
    await this.considerTurnCompletion(Date.now());
  }

  private async handlePlaybackActivity(event: AudioActivityEvent): Promise<void> {
    if (this.currentSession.state !== "listening" && this.currentSession.state !== "outputting") {
      return;
    }
    this.playbackActive = event.active;
    if (this.currentSession.activeTurn === undefined) {
      if (event.active) {
        throw new Error("Cannot start playback without an active turn");
      }
      return;
    }
    if (event.active) {
      this.dispatch({ type: "AUDIO_STARTED", nowMs: event.atMs });
      return;
    }
    this.dispatch({ type: "PLAYBACK_ENDED", nowMs: event.atMs });
    await this.considerTurnCompletion(Date.now());
  }

  private async considerTurnCompletion(nowMs: number): Promise<void> {
    if (this.turnClosing) {
      return;
    }
    const turn = this.currentSession.activeTurn;
    if (turn === undefined) {
      return;
    }
    if (this.currentSession.state !== "listening" && this.currentSession.state !== "outputting") {
      return;
    }
    const decision = evaluateTurnCompletion(
      buildTurnCompletionSnapshot({
        turn,
        playbackActive: this.playbackActive,
        nowMs,
      }),
      nowMs,
    );
    if (decision.kind === "continue") {
      this.armCompletionTimer(decision.retryAtMs, nowMs);
      return;
    }
    this.clearCompletionTimer();
    this.clearCaptionIdleTimer();
    this.clearMaxSourceTimer();
    this.turnClosing = true;
    const generation = this.sessionGeneration;
    try {
      if (decision.kind === "complete") {
        await this.closeCompletedTurn();
      } else {
        await this.failTurnNoOutput();
      }
    } finally {
      if (this.sessionGeneration === generation) {
        this.turnClosing = false;
      }
    }
  }

  private async closeCompletedTurn(): Promise<void> {
    const turn = this.currentSession.activeTurn;
    if (turn === undefined) {
      throw new Error("Cannot complete a turn without an active turn");
    }
    const speaker = turn.speaker;
    this.dispatch({ type: "TURN_CLOSED", speaker });
    const session = this.currentSession;
    const expectedSource = session.expectedSpeaker;
    const recipient = expectedSource === "A" ? "B" : "A";
    const recipientProfile = recipient === "A" ? session.participantA : session.participantB;
    const initialRecipientHint = recipientProfile.hasAcceptedConversationSpeech
      ? undefined
      : recipientProfile.initialLanguageHint;
    const generation = this.sessionGeneration;
    try {
      const result = await this.live.appendInstructions(
        buildSteering({
          expectedSource,
          recipient,
          initialRecipientHint,
        }),
        {
          kind: "later_steering",
          sessionState: session.state,
        },
      );
      if (this.sessionGeneration !== generation) {
        return;
      }
      if (result.degraded === true) {
        this.steeringDegradedFlag = true;
      }
    } catch (error) {
      if (this.sessionGeneration !== generation) {
        return;
      }
      console.error("Later steering append failed", {
        error,
        state: this.currentSession.state,
      });
      throw error;
    } finally {
      if (this.sessionGeneration === generation) {
        await this.unmuteGateB();
        this.notify();
      }
    }
  }

  private async failTurnNoOutput(): Promise<void> {
    this.dispatch({ type: "TURN_FAILED" });
    this.recoveryPromptKind = "repeat";
    await this.unmuteGateB();
    this.notify();
  }

  private async handleMaxSourceTimeout(): Promise<void> {
    const turn = this.currentSession.activeTurn;
    if (turn === undefined || turn.sourceIdleAtMs !== undefined) {
      return;
    }
    if (this.currentSession.state !== "listening" && this.currentSession.state !== "outputting") {
      return;
    }
    this.clearTurnEngineTimers();
    const generation = this.sessionGeneration;
    this.turnClosing = true;
    try {
      await this.muteGateB();
      if (this.sessionGeneration !== generation) {
        return;
      }
      this.audio.setOutputAudible(false);
      this.dispatch({ type: "TURN_FAILED" });
      try {
        await this.live.appendInstructions(buildUnfinishedTurnWarning(), {
          kind: "later_steering",
          sessionState: this.currentSession.state,
        });
      } catch (error) {
        if (this.sessionGeneration !== generation) {
          return;
        }
        console.error("Unfinished-turn warning append failed", {
          error,
          state: this.currentSession.state,
        });
        throw error;
      }
      if (this.sessionGeneration !== generation) {
        return;
      }
      this.dispatch({ type: "SUSPEND" });
      this.recoveryPromptKind = "resume-repeat";
      this.notify();
    } finally {
      if (this.sessionGeneration === generation) {
        this.turnClosing = false;
      }
    }
  }

  private async muteGateB(): Promise<void> {
    if (this.gateBMuted) {
      return;
    }
    try {
      await this.live.setInputMuted(true);
    } catch (error) {
      console.error("Gate B mute failed", { error, state: this.currentSession.state });
      throw error;
    }
    this.gateBMuted = true;
  }

  private async unmuteGateB(): Promise<void> {
    if (!this.gateBMuted) {
      return;
    }
    try {
      await this.live.setInputMuted(false);
    } catch (error) {
      console.error("Gate B unmute failed", { error, state: this.currentSession.state });
      throw error;
    }
    this.gateBMuted = false;
  }

  private armMaxSourceTimer(): void {
    this.clearMaxSourceTimer();
    this.maxSourceTimer = window.setTimeout(() => {
      void this.handleMaxSourceTimeout();
    }, runtime.maxSourceMs);
  }

  private armCompletionTimer(retryAtMs: number | undefined, nowMs: number): void {
    this.clearCompletionTimer();
    if (retryAtMs === undefined) {
      return;
    }
    const delayMs = retryAtMs - nowMs;
    if (delayMs <= 0) {
      void this.considerTurnCompletion(Date.now());
      return;
    }
    this.completionTimer = window.setTimeout(() => {
      void this.considerTurnCompletion(Date.now());
    }, delayMs);
  }

  private armCaptionIdleTimer(): void {
    this.clearCaptionIdleTimer();
    this.captionIdleTimer = window.setTimeout(() => {
      void this.considerTurnCompletion(Date.now());
    }, runtime.captionIdleMs);
  }

  private clearTurnEngineTimers(): void {
    this.clearMaxSourceTimer();
    this.clearCompletionTimer();
    this.clearCaptionIdleTimer();
  }

  private clearMaxSourceTimer(): void {
    if (this.maxSourceTimer === null) {
      return;
    }
    window.clearTimeout(this.maxSourceTimer);
    this.maxSourceTimer = null;
  }

  private clearCompletionTimer(): void {
    if (this.completionTimer === null) {
      return;
    }
    window.clearTimeout(this.completionTimer);
    this.completionTimer = null;
  }

  private clearCaptionIdleTimer(): void {
    if (this.captionIdleTimer === null) {
      return;
    }
    window.clearTimeout(this.captionIdleTimer);
    this.captionIdleTimer = null;
  }

  private async ensureConnected(): Promise<void> {
    const live = this.live;
    const generation = this.sessionGeneration;
    try {
      await this.audio.primeOutput();
    } catch (error) {
      if (this.sessionGeneration !== generation) {
        return;
      }
      console.error("Audio output priming failed", {
        error,
        state: this.currentSession.state,
      });
      throw error;
    }
    if (this.sessionGeneration !== generation) {
      return;
    }
    this.audio.setOutputAudible(false);
    if (this.audio.getCaptureStream() === null) {
      try {
        await this.audio.startCapture();
      } catch (error) {
        if (this.sessionGeneration !== generation) {
          return;
        }
        this.failOwnerRequest("Microphone capture failed", error);
      }
    }
    if (this.sessionGeneration !== generation) {
      if (this.audio.getCaptureStream() !== null) {
        this.audio.stopCapture();
      }
      return;
    }
    const stream = this.audio.getCaptureStream();
    if (stream === null) {
      this.failOwnerRequest(
        "Microphone capture failed",
        new Error("Microphone capture stream is missing"),
      );
    }
    if (this.currentSession.state !== "idle") {
      return;
    }
    this.dispatch({ type: "CONNECT" });
    this.liveConnectStarted = true;
    try {
      await live.connect(stream);
    } catch (error) {
      if (this.sessionGeneration !== generation) {
        return;
      }
      console.error("Live connect failed", {
        error,
        state: this.currentSession.state,
      });
      this.ownerErrorMessage = error instanceof Error ? error.message : String(error);
      this.dispatch({
        type: "SESSION_ERROR",
        message: this.ownerErrorMessage,
      });
      throw error;
    }
    if (this.sessionGeneration !== generation) {
      return;
    }
    this.hasConnected = true;
  }

  private armIdleTimer(kind: "context" | "bootstrap"): void {
    this.clearIdleTimer();
    const timeoutMs =
      kind === "context" ? runtime.contextIdleTimeoutMs : runtime.bootstrapIdleTimeoutMs;
    this.idleTimer = window.setTimeout(() => {
      void this.cancel();
    }, timeoutMs);
  }

  private clearIdleTimer(): void {
    if (this.idleTimer === null) {
      return;
    }
    window.clearTimeout(this.idleTimer);
    this.idleTimer = null;
  }

  private async runStartContextCapture(): Promise<void> {
    const generation = this.sessionGeneration;
    this.ownerErrorMessage = undefined;
    this.connectInFlight = true;
    this.notify();
    try {
      await this.ensureConnected();
      if (this.sessionGeneration !== generation) {
        return;
      }
      if (this.currentSession.state === "idle") {
        return;
      }
      if (this.currentSession.state === "connecting") {
        this.dispatch({ type: "CONTEXT_READY" });
      } else if (this.currentSession.state !== "context") {
        throw new Error(
          `Cannot start context capture from "${this.currentSession.state}"`,
        );
      }
      this.contextFrozenByUser = false;
      this.capturingContext = true;
      this.capturingBootstrap = false;
      this.armIdleTimer("context");
    } finally {
      if (this.sessionGeneration === generation) {
        this.connectInFlight = false;
        this.notify();
      }
    }
  }

  private async runStartBootstrap(): Promise<void> {
    const generation = this.sessionGeneration;
    this.ownerErrorMessage = undefined;
    this.connectInFlight = true;
    this.notify();
    try {
      await this.ensureConnected();
      if (this.sessionGeneration !== generation) {
        return;
      }
      if (this.currentSession.state === "idle") {
        return;
      }
      this.finishContextCapture();
      this.bootstrapBuffer = "";
      this.capturingBootstrap = true;
      this.audio.setOutputAudible(false);
      if (this.currentSession.state === "connecting") {
        this.dispatch({ type: "SKIP_CONTEXT" });
      } else if (this.currentSession.state === "context") {
        this.dispatch({ type: "BOOTSTRAP_READY" });
      } else if (this.currentSession.state !== "bootstrap") {
        throw new Error(`Cannot start bootstrap from "${this.currentSession.state}"`);
      }
      this.armIdleTimer("bootstrap");
    } finally {
      if (this.sessionGeneration === generation) {
        this.connectInFlight = false;
        this.notify();
      }
    }
  }

  private applyContextText(text: string): void {
    this.contextBuffer = text;
    this.currentSession = { ...this.currentSession, contextText: text };
    this.notify();
  }

  private failOwnerRequest(context: string, error: unknown): never {
    this.ownerErrorMessage = error instanceof Error ? error.message : String(error);
    this.notify();
    console.error(context, { error, state: this.currentSession.state });
    throw error;
  }

  private resetToIdle(): void {
    this.audio.setOutputAudible(false);
    this.audio.audioElement.srcObject = null;
    this.hasConnected = false;
    this.contextBuffer = "";
    this.bootstrapBuffer = "";
    this.ownerErrorMessage = undefined;
    this.degradedBootstrap = false;
    this.contextFrozenByUser = false;
    this.authoritativeContextSent = false;
    this.liveConnectStarted = false;
    this.connectInFlight = false;
    this.connectWork = null;
    this.interpreterInFlight = false;
    this.interpreterWork = null;
    this.gateBMuted = false;
    this.playbackActive = false;
    this.turnClosing = false;
    this.recoveryPromptKind = undefined;
    this.steeringDegradedFlag = false;
    this.clearTurnEngineTimers();
    this.sessionGeneration += 1;
    this.currentSession = createSessionFromDeviceLocale();
    this.live = this.deps.createLive();
    this.bindLive();
    this.notify();
  }

  private dispatch(action: SessionAction): void {
    this.currentSession = sessionReducer(this.currentSession, action);
    this.notify();
  }

  private notify(): void {
    for (const listener of this.listeners) {
      listener();
    }
  }
}

export function createDefaultSessionController(): SessionController {
  const audio = new AudioController();
  const controller = new SessionController({
    createLive: () =>
      new LiveClient({
        backend: new BackendClient(),
        peerFactory: () => new RTCPeerConnection(),
        onRemoteStream: (stream) => {
          controller.handleRemoteStream(stream);
        },
      }),
    audio,
  });
  return controller;
}

function createSessionFromDeviceLocale(): TranslationSession {
  const language = navigator.language;
  if (language.length === 0) {
    throw new Error("Device locale (navigator.language) is missing");
  }
  return createInitialSession(
    {
      side: "A",
      initialLanguageHint: language,
      languageHintSource: "device_locale",
      hasAcceptedConversationSpeech: false,
    },
    {
      side: "B",
      hasAcceptedConversationSpeech: false,
    },
  );
}
