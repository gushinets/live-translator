import { BackendClient } from "../api/BackendClient";
import { AudioController } from "../audio/AudioController";
import type { AudioActivityEvent } from "../audio/VoiceActivityMonitor";
import { runtime } from "../config/runtime";
import {
  buildTurnCompletionSnapshot,
  evaluateTurnCompletion,
} from "../conversation/TurnCompletion";
import { createTranscriptFragment } from "../conversation/TurnBuffer";
import type { Side, Turn } from "../conversation/Turn";
import { AckTimeoutError } from "../live/AckRegistry";
import { LiveClient, type LiveClientErrorEvent } from "../live/LiveClient";
import {
  ContextTooLongError,
  assertAppendWithinBudget,
  isAppendSizeError,
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
import { ConversationMetrics } from "../metrics/ConversationMetrics";
import { OrientationController } from "../platform/OrientationController";
import { VisibilityController } from "../platform/VisibilityController";
import { WakeLockController } from "../platform/WakeLockController";
import { sessionReducer, type SessionAction } from "./sessionReducer";
import {
  createInitialSession,
  type TranslationSession,
} from "./SessionState";
import {
  CONNECTION_ERROR_MESSAGE,
  INCOMPLETE_FINALIZATION_MESSAGE,
  MICROPHONE_CAPTURE_ENDED_MESSAGE,
  MICROPHONE_DENIED_MESSAGE,
  STARTUP_ERROR_MESSAGE,
} from "./userFacingErrors";

export type RecoveryPrompt = "repeat" | "resume-repeat";

export type LifecycleSuspendReason = "orientation" | "visibility" | "audio";

type RemotePlaybackState = "ready" | "pending" | "failed";

export interface SessionControllerDeps {
  createLive: () => LiveClient;
  audio: Pick<
    AudioController,
    | "primeOutput"
    | "setOutputAudible"
    | "setCaptureEnabled"
    | "startCapture"
    | "stopCapture"
    | "getCaptureStream"
    | "attachRemoteStream"
    | "audioElement"
    | "resetVoiceActivityBaseline"
  > & {
    onVoiceActivity: AudioController["onVoiceActivity"];
    onPlaybackActivity: AudioController["onPlaybackActivity"];
    onAudioInterruption: AudioController["onAudioInterruption"];
    onAudioRestored: AudioController["onAudioRestored"];
    onCaptureEnded: AudioController["onCaptureEnded"];
  };
  orientation?: OrientationController;
  visibility?: VisibilityController;
  wakeLock?: WakeLockController;
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
  private maxSessionTimer: number | null = null;
  private maxSourceTimer: number | null = null;
  private completionTimer: number | null = null;
  private captionIdleTimer: number | null = null;
  private leftoverDrainTimer: number | null = null;
  private leftoverOutputDraining = false;
  private leftoverCaptionIdle = true;
  private leftoverDrainWaiters: Array<() => void> = [];
  private lifecycleEpoch = 0;
  private lifecycleQueue: Promise<void> = Promise.resolve();
  private gateBMuted = false;
  private maxSourceMuteInFlight: { generation: number; promise: Promise<void> } | null = null;
  private playbackActive = false;
  private remotePlaybackGeneration = 0;
  private remotePlaybackState: RemotePlaybackState = "ready";
  private pendingRemotePlaybackActivity: AudioActivityEvent | null = null;
  private turnClosing = false;
  private speechInputReady = false;
  private recoveryPromptKind: RecoveryPrompt | undefined;
  private steeringDegradedFlag = false;
  private correctionEpoch = 0;
  private gateCHeldForCorrectionEpoch: number | null = null;
  private correctionWork: Promise<void> | null = null;
  private endWork: Promise<void> | null = null;
  private playbackIdleWaitResolve: (() => void) | null = null;
  private playbackIdleWaitTimer: number | null = null;
  private platformStarted = false;
  private lifecycleSuspendReason: LifecycleSuspendReason | undefined;
  private discardedUnfinishedOnSuspend = false;
  private enteredInterpreter = false;
  private conversationMetrics = new ConversationMetrics();
  private readonly orientation: OrientationController;
  private readonly visibility: VisibilityController;
  private readonly wakeLock: WakeLockController;
  private readonly listeners = new Set<() => void>();

  constructor(private readonly deps: SessionControllerDeps) {
    this.currentSession = createSessionFromDeviceLocale();
    this.live = deps.createLive();
    this.orientation = deps.orientation ?? new OrientationController();
    this.visibility = deps.visibility ?? new VisibilityController();
    this.wakeLock = deps.wakeLock ?? new WakeLockController();
    this.orientation.onChange = (orientation) => {
      void this.handleOrientationChange(orientation);
    };
    this.visibility.onHidden = () => {
      void this.handleVisibilityHidden();
    };
    this.visibility.onVisible = () => {
      void this.handleVisibilityVisible();
    };
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

  get hasEnteredInterpreter(): boolean {
    return this.enteredInterpreter;
  }

  get metrics(): ConversationMetrics {
    return this.conversationMetrics;
  }

  get bootstrapDegraded(): boolean {
    return this.degradedBootstrap;
  }

  get recoveryPrompt(): RecoveryPrompt | undefined {
    return this.recoveryPromptKind;
  }

  get suspendReason(): LifecycleSuspendReason | undefined {
    if (this.currentSession.state !== "suspended") {
      return undefined;
    }
    return this.lifecycleSuspendReason;
  }

  get steeringDegraded(): boolean {
    return this.steeringDegradedFlag;
  }

  get inputReady(): boolean {
    return (
      this.currentSession.state === "listening" &&
      this.currentSession.activeTurn === undefined &&
      this.speechInputReady
    );
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

  reportSourceTailClipping(): void {
    this.conversationMetrics.reportSourceTailClipping();
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
    const sessionGeneration = this.sessionGeneration;
    const playbackGeneration = this.remotePlaybackGeneration + 1;
    this.remotePlaybackGeneration = playbackGeneration;
    this.remotePlaybackState = "pending";
    this.pendingRemotePlaybackActivity = null;
    this.audio.attachRemoteStream(stream);
    void this.audio.audioElement
      .play()
      .then(() => {
        if (
          this.sessionGeneration !== sessionGeneration ||
          this.remotePlaybackGeneration !== playbackGeneration
        ) {
          return;
        }
        this.remotePlaybackState = "ready";
        const pending = this.pendingRemotePlaybackActivity;
        this.pendingRemotePlaybackActivity = null;
        if (pending?.active === true) {
          void this.handlePlaybackActivity(pending);
        }
      })
      .catch((error: unknown) => {
        if (
          this.sessionGeneration !== sessionGeneration ||
          this.remotePlaybackGeneration !== playbackGeneration
        ) {
          return;
        }
        this.remotePlaybackState = "failed";
        this.pendingRemotePlaybackActivity = null;
        if (this.playbackActive) {
          this.playbackActive = false;
          this.finishPlaybackIdleWait();
        }
        console.error("Remote audio play failed", { error });
      });
  }

  private acceptRemotePlaybackActivity(event: AudioActivityEvent): boolean {
    if (this.remotePlaybackState === "ready") {
      return true;
    }
    if (this.remotePlaybackState === "pending") {
      this.pendingRemotePlaybackActivity = event.active ? event : null;
    }
    return false;
  }

  private resetRemotePlaybackTracking(): void {
    this.remotePlaybackGeneration += 1;
    this.remotePlaybackState = "ready";
    this.pendingRemotePlaybackActivity = null;
    if (this.playbackActive) {
      this.playbackActive = false;
      this.finishPlaybackIdleWait();
    }
  }

  async resumeFromSourceTimeout(): Promise<void> {
    if (this.currentSession.state !== "suspended") {
      throw new Error(`Cannot resume from "${this.currentSession.state}"`);
    }
    const generation = this.sessionGeneration;
    const ensureMuted = async (): Promise<void> => {
      if (this.sessionGeneration !== generation || this.currentSession.state !== "suspended") {
        return;
      }
      try {
        await this.muteGateB(generation);
      } catch (error) {
        if (this.sessionGeneration !== generation) {
          return;
        }
        console.error("Gate B re-mute failed while recovering from MAX_SOURCE_MS", {
          error,
          state: this.currentSession.state,
        });
      }
    };
    try {
      this.assertResumeMedia();
    } catch (error) {
      this.audio.setOutputAudible(false);
      this.failLifecycleResume(error);
      throw error;
    }
    this.audio.resetVoiceActivityBaseline();
    if (this.sessionGeneration !== generation || this.currentSession.state !== "suspended") {
      this.audio.setOutputAudible(false);
      return;
    }
    const pendingMaxSourceMute = this.maxSourceMuteInFlight;
    if (pendingMaxSourceMute !== null && pendingMaxSourceMute.generation === generation) {
      await pendingMaxSourceMute.promise;
      if (this.sessionGeneration !== generation || this.currentSession.state !== "suspended") {
        this.audio.setOutputAudible(false);
        await ensureMuted();
        return;
      }
    }
    try {
      if (!(await this.unmuteGateB(generation))) {
        this.audio.setOutputAudible(false);
        return;
      }
    } catch (error) {
      if (this.sessionGeneration !== generation || this.currentSession.state !== "suspended") {
        return;
      }
      this.audio.setOutputAudible(false);
      this.failLifecycleResume(error);
      throw error;
    }
    if (this.sessionGeneration !== generation || this.currentSession.state !== "suspended") {
      this.audio.setOutputAudible(false);
      await ensureMuted();
      return;
    }
    try {
      this.audio.setCaptureEnabled(true);
    } catch (error) {
      if (this.sessionGeneration !== generation || this.currentSession.state !== "suspended") {
        return;
      }
      this.audio.setOutputAudible(false);
      await ensureMuted();
      if (this.sessionGeneration !== generation || this.currentSession.state !== "suspended") {
        return;
      }
      this.failLifecycleResume(error);
      throw error;
    }
    if (this.sessionGeneration !== generation || this.currentSession.state !== "suspended") {
      this.audio.setOutputAudible(false);
      await ensureMuted();
      return;
    }
    this.audio.setOutputAudible(true);
    this.recoveryPromptKind = undefined;
    this.speechInputReady = true;
    this.dispatch({ type: "RESUME" });
  }

  async correctLastTurn(side: Side): Promise<void> {
    if (this.correctionWork !== null) {
      await this.correctionWork;
    }
    const work = this.runCorrectLastTurn(side);
    this.correctionWork = work;
    try {
      await work;
    } finally {
      if (this.correctionWork === work) {
        this.correctionWork = null;
      }
    }
  }

  async endConversation(): Promise<void> {
    if (this.endWork !== null) {
      await this.endWork;
      return;
    }
    const work = this.runEndConversation();
    this.endWork = work;
    try {
      await work;
    } finally {
      if (this.endWork === work) {
        this.endWork = null;
      }
    }
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
        this.assertStartupAppendWithinBudget(payload);
        try {
          await live.appendThinking(payload, { kind: "startup_interpreter" });
        } catch (error) {
          if (this.sessionGeneration !== generation) {
            return;
          }
          this.failStartupAppend("Authoritative context append failed", error);
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
        this.failStartupAppend("BEGIN_INTERPRETER_MODE append failed", error);
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
        this.failStartupAppend("First steering append failed", error);
      }
      if (this.sessionGeneration !== generation) {
        return;
      }

      this.clearIdleTimer();
      this.capturingBootstrap = false;
      this.audio.setOutputAudible(true);
      this.enteredInterpreter = true;
      this.speechInputReady = true;
      this.dispatch({ type: "INTERPRETER_READY" });
      await this.startPlatformLifecycle();
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
    this.clearMaxSessionTimer();
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

  private latestCorrectableTurn(): Turn | undefined {
    const session = this.currentSession;
    if (session.state !== "outputting" && session.state !== "listening") {
      return undefined;
    }
    if (session.activeTurn !== undefined) {
      if (
        session.activeTurn.status === "failed" ||
        session.activeTurn.status === "discarded" ||
        (session.state === "listening" && session.activeTurn.status === "streaming")
      ) {
        return undefined;
      }
      return session.activeTurn;
    }
    const latest = session.recentTurns.at(-1);
    if (latest === undefined) {
      return undefined;
    }
    if (latest.status !== "completed" && latest.status !== "outputting") {
      return undefined;
    }
    return latest;
  }

  private async runCorrectLastTurn(side: Side): Promise<void> {
    const target = this.latestCorrectableTurn();
    if (target === undefined || target.speaker === side) {
      return;
    }
    this.conversationMetrics.recordWrongSideCorrection();
    const previousSpeaker = target.speaker;
    const generation = this.sessionGeneration;
    this.clearMaxSourceTimer();
    this.clearCompletionTimer();
    this.clearCaptionIdleTimer();
    this.audio.setOutputAudible(false);
    this.speechInputReady = false;
    this.dispatch({ type: "CORRECTION_START" });
    this.beginLeftoverOutputDrain();
    try {
      await this.live.appendInstructions(
        buildCorrectionInstruction({ actualSpeaker: side, previousSpeaker }),
        { kind: "correction" },
      );
      if (this.sessionGeneration !== generation || this.currentSession.state !== "correcting") {
        return;
      }
      await this.waitForPlaybackIdleOrSettle();
      if (this.sessionGeneration !== generation || this.currentSession.state !== "correcting") {
        return;
      }
      await this.live.appendCommentary(buildCorrectionCommentaryTrigger(), {
        kind: "correction",
      });
      if (this.sessionGeneration !== generation || this.currentSession.state !== "correcting") {
        return;
      }
      this.dispatch({ type: "CORRECTION_APPLIED", speaker: side });
      this.conversationMetrics.recordCorrectionSuccess();
      this.correctionEpoch += 1;
      this.gateCHeldForCorrectionEpoch = this.correctionEpoch;
    } catch (error) {
      if (this.sessionGeneration !== generation) {
        return;
      }
      this.finishPlaybackIdleWait();
      this.ownerErrorMessage = error instanceof Error ? error.message : String(error);
      this.dispatch({
        type: "SESSION_ERROR",
        message: this.ownerErrorMessage,
      });
      console.error("Correction append failed", {
        error,
        state: this.currentSession.state,
      });
      throw error;
    }
  }

  private async runEndConversation(): Promise<void> {
    if (this.currentSession.state === "idle" || this.currentSession.state === "ended") {
      throw new Error(`Cannot end a session in state "${this.currentSession.state}"`);
    }
    this.sessionGeneration += 1;
    this.clearIdleTimer();
    this.clearMaxSessionTimer();
    this.clearTurnEngineTimers();
    this.capturingContext = false;
    this.capturingBootstrap = false;
    this.speechInputReady = false;
    this.audio.setOutputAudible(false);
    this.dispatch({ type: "END" });
    let closeResult: { finalized: boolean };
    try {
      closeResult = await this.live.close();
    } catch (error) {
      console.error("Live session close failed", {
        error,
        state: this.currentSession.state,
      });
      throw error;
    }
    if (closeResult.finalized === false) {
      this.ownerErrorMessage = INCOMPLETE_FINALIZATION_MESSAGE;
      this.notify();
    }
    if (this.audio.getCaptureStream() !== null) {
      this.audio.stopCapture();
    }
    this.resetToIdle({ preserveOwnerError: closeResult.finalized === false });
  }

  private get audio(): SessionControllerDeps["audio"] {
    return this.deps.audio;
  }

  private bindLive(): void {
    const live = this.live;
    const generation = this.sessionGeneration;
    this.live.onTranscriptDelta = (event) => {
      if (this.live !== live || this.sessionGeneration !== generation) {
        return;
      }
      this.handleTranscriptDelta(event);
    };
    this.live.onSessionStarted = () => {
      if (this.live !== live || this.sessionGeneration !== generation) {
        return;
      }
      this.armMaxSessionTimer();
    };
    this.live.onSessionClosed = (event) => {
      if (this.live !== live || this.sessionGeneration !== generation) {
        return;
      }
      this.handleLiveSessionClosed(event);
    };
    this.live.onError = (event) => {
      if (this.live !== live || this.sessionGeneration !== generation) {
        return;
      }
      this.handleLiveTransportError(event);
    };
  }

  private bindAudio(): void {
    this.audio.onVoiceActivity = (event) => {
      void this.handleVoiceActivity(event);
    };
    this.audio.onPlaybackActivity = (event) => {
      void this.handlePlaybackActivity(event);
    };
    this.audio.onAudioInterruption = () => {
      void this.handleAudioInterruption();
    };
    this.audio.onAudioRestored = () => {
      void this.handleAudioRestored();
    };
    this.audio.onCaptureEnded = () => {
      this.handleCaptureEnded();
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
    if (this.turnClosing) {
      return;
    }
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
      this.speechInputReady = false;
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
    if (event.delta.length === 0) {
      return;
    }
    if (this.leftoverOutputDraining) {
      this.noteLeftoverCaption();
      return;
    }
    if (this.currentSession.state !== "listening" && this.currentSession.state !== "outputting") {
      return;
    }
    if (this.currentSession.activeTurn === undefined) {
      return;
    }
    this.dispatch({
      type: "OUTPUT_DELTA",
      text: event.delta,
      nowMs: Date.now(),
    });
    this.releaseGateCAfterFreshCorrectionOutput();
    this.armCaptionIdleTimer();
    void this.considerTurnCompletion(Date.now());
  }

  private async handleVoiceActivity(event: AudioActivityEvent): Promise<void> {
    if (this.turnClosing) {
      return;
    }
    if (this.currentSession.state !== "listening" && this.currentSession.state !== "outputting") {
      return;
    }
    const generation = this.sessionGeneration;
    if (event.active) {
      if (this.playbackActive) {
        this.conversationMetrics.recordVamFalseActive();
      }
      this.recoveryPromptKind = undefined;
      this.clearCompletionTimer();
      const activeTurn = this.currentSession.activeTurn;
      const wasIdle = activeTurn?.sourceIdleAtMs !== undefined;
      if (activeTurn === undefined) {
        this.speechInputReady = false;
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
          try {
            if (!(await this.unmuteGateB(generation))) {
              return;
            }
          } catch (error) {
            if (this.sessionGeneration !== generation) {
              return;
            }
            this.clearTurnEngineTimers();
            this.speechInputReady = false;
            try {
              this.audio.setCaptureEnabled(false);
            } catch (captureError) {
              console.error("Gate A close failed after Gate B unmute failure", {
                error: captureError,
                state: this.currentSession.state,
              });
            }
            this.audio.setOutputAudible(false);
            if (
              this.currentSession.activeTurn !== undefined &&
              (this.currentSession.state === "listening" ||
                this.currentSession.state === "outputting")
            ) {
              this.dispatch({ type: "TURN_FAILED" });
            }
            this.ownerErrorMessage = error instanceof Error ? error.message : String(error);
            this.dispatch({
              type: "SESSION_ERROR",
              message: this.ownerErrorMessage,
            });
            return;
          }
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
    try {
      await this.muteGateB();
    } catch (error) {
      if (this.sessionGeneration !== generation) {
        return;
      }
      if (error instanceof AckTimeoutError) {
        console.error("Gate B mute ack timed out; continuing turn completion", {
          error,
          state: this.currentSession.state,
        });
      }
    }
    if (this.sessionGeneration !== generation) {
      return;
    }
    await this.considerTurnCompletion(Date.now());
  }

  private async handlePlaybackActivity(event: AudioActivityEvent): Promise<void> {
    if (!this.acceptRemotePlaybackActivity(event)) {
      return;
    }
    const wasActive = this.playbackActive;
    this.playbackActive = event.active;
    if (!event.active) {
      this.finishPlaybackIdleWait();
    }
    const isPlaybackOnset = event.active && !wasActive;
    if (this.leftoverOutputDraining) {
      if (isPlaybackOnset && this.tryEstablishCorrectionEpochFromPlayback(event.atMs)) {
        return;
      }
      if (!event.active) {
        this.maybeFinishLeftoverOutputDrain();
      }
      return;
    }
    if (this.currentSession.state === "correcting") {
      return;
    }
    if (this.currentSession.state !== "listening" && this.currentSession.state !== "outputting") {
      return;
    }
    if (this.currentSession.activeTurn === undefined) {
      return;
    }
    if (event.active) {
      if (this.gateCHeldForCorrectionEpoch !== null && !isPlaybackOnset) {
        return;
      }
      this.dispatch({ type: "AUDIO_STARTED", nowMs: event.atMs });
      this.releaseGateCAfterFreshCorrectionOutput();
      return;
    }
    this.dispatch({ type: "PLAYBACK_ENDED", nowMs: event.atMs });
    await this.considerTurnCompletion(Date.now());
  }

  private async considerTurnCompletion(nowMs: number): Promise<void> {
    if (this.turnClosing || this.gateCHeldForCorrectionEpoch !== null) {
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
    if (this.currentSession.state !== "listening" && this.currentSession.state !== "outputting") {
      return;
    }
    const turn = this.currentSession.activeTurn;
    if (turn === undefined) {
      throw new Error("Cannot complete a turn without an active turn");
    }
    const speaker = turn.speaker;
    const sourceIdleAtMs = turn.sourceIdleAtMs;
    const firstOutputTextAtMs = turn.firstOutputTextAtMs;
    const firstAudibleOutputAtMs = turn.firstAudibleOutputAtMs;
    const playbackEndAtMs = turn.playbackEndAtMs;
    const audioOutputStarted = turn.audioOutputStarted;
    this.speechInputReady = false;
    this.dispatch({ type: "TURN_CLOSED", speaker });
    const turnCompletedAtMs = this.currentSession.recentTurns.at(-1)?.turnCompletedAtMs;
    this.beginLeftoverOutputDrain();
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
      this.audio.setOutputAudible(false);
      this.speechInputReady = false;
      this.ownerErrorMessage = error instanceof Error ? error.message : String(error);
      this.dispatch({
        type: "SESSION_ERROR",
        message: this.ownerErrorMessage,
      });
      return;
    }
    if (this.sessionGeneration !== generation) {
      return;
    }
    try {
      if (!(await this.unmuteGateB(generation))) {
        return;
      }
    } catch (error) {
      if (this.sessionGeneration !== generation) {
        return;
      }
      this.speechInputReady = false;
      this.ownerErrorMessage = error instanceof Error ? error.message : String(error);
      this.dispatch({
        type: "SESSION_ERROR",
        message: this.ownerErrorMessage,
      });
      return;
    }
    if (this.sessionGeneration !== generation) {
      return;
    }
    if (sourceIdleAtMs === undefined) {
      throw new Error("Cannot complete a turn without sourceIdleAtMs");
    }
    if (firstOutputTextAtMs !== undefined) {
      this.conversationMetrics.recordTurn({
        sourceIdleAtMs,
        firstOutputTextAtMs,
        firstAudibleOutputAtMs,
        playbackEndAtMs,
        turnCompletedAtMs,
        listeningRestoredAtMs: Date.now(),
        audioOutputStarted,
      });
    }
    this.speechInputReady = true;
    this.notify();
  }

  private async failTurnNoOutput(): Promise<void> {
    if (this.currentSession.state !== "listening" && this.currentSession.state !== "outputting") {
      return;
    }
    this.conversationMetrics.recordNoOutputWatchdog();
    this.speechInputReady = false;
    this.dispatch({ type: "TURN_FAILED" });
    this.beginLeftoverOutputDrain();
    this.recoveryPromptKind = "repeat";
    const generation = this.sessionGeneration;
    try {
      if (!(await this.unmuteGateB(generation))) {
        return;
      }
    } catch (error) {
      if (this.sessionGeneration !== generation) {
        return;
      }
      this.speechInputReady = false;
      this.ownerErrorMessage = error instanceof Error ? error.message : String(error);
      this.dispatch({
        type: "SESSION_ERROR",
        message: this.ownerErrorMessage,
      });
      return;
    }
    if (this.sessionGeneration !== generation) {
      return;
    }
    this.speechInputReady = true;
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
    this.speechInputReady = false;
    this.turnClosing = true;
    const maxSourceMuteInFlight = {
      generation,
      promise: this.muteGateB(generation).then(
        () => undefined,
        (error) => {
          if (this.sessionGeneration !== generation) {
            return;
          }
          if (error instanceof AckTimeoutError) {
            console.error("Gate B mute ack timed out; continuing source timeout", {
              error,
              state: this.currentSession.state,
            });
            return;
          }
          console.error("Gate B mute failed during source timeout", {
            error,
            state: this.currentSession.state,
          });
        },
      ),
    };
    this.maxSourceMuteInFlight = maxSourceMuteInFlight;
    maxSourceMuteInFlight.promise.finally(() => {
      if (this.maxSourceMuteInFlight === maxSourceMuteInFlight) {
        this.maxSourceMuteInFlight = null;
      }
    });
    try {
      if (this.sessionGeneration !== generation) {
        return;
      }
      try {
        this.audio.setCaptureEnabled(false);
      } catch (error) {
        console.error("Gate A close failed during source timeout", {
          error,
          state: this.currentSession.state,
        });
      }
      this.audio.setOutputAudible(false);
      this.dispatch({ type: "TURN_FAILED" });
      this.beginLeftoverOutputDrain();
      this.dispatch({ type: "SUSPEND" });
      this.recoveryPromptKind = "resume-repeat";
      this.turnClosing = false;
      this.notify();
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
      }
    } finally {
      if (this.sessionGeneration === generation) {
        this.turnClosing = false;
      }
    }
  }

  private async muteGateB(generation = this.sessionGeneration): Promise<boolean> {
    if (this.gateBMuted) {
      return this.sessionGeneration === generation;
    }
    try {
      await this.live.setInputMuted(true);
    } catch (error) {
      if (this.sessionGeneration !== generation) {
        return false;
      }
      console.error("Gate B mute failed", { error, state: this.currentSession.state });
      this.gateBMuted = true;
      throw error;
    }
    if (this.sessionGeneration !== generation) {
      return false;
    }
    this.gateBMuted = true;
    return true;
  }

  private async unmuteGateB(generation = this.sessionGeneration): Promise<boolean> {
    if (!this.gateBMuted) {
      return this.sessionGeneration === generation;
    }
    try {
      await this.live.setInputMuted(false);
    } catch (error) {
      if (this.sessionGeneration !== generation) {
        return false;
      }
      console.error("Gate B unmute failed", { error, state: this.currentSession.state });
      throw error;
    }
    if (this.sessionGeneration !== generation) {
      return false;
    }
    this.gateBMuted = false;
    return true;
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

  private beginLeftoverOutputDrain(): void {
    this.leftoverOutputDraining = true;
    this.leftoverCaptionIdle = false;
    this.armLeftoverDrainTimer();
  }

  private noteLeftoverCaption(): void {
    this.leftoverCaptionIdle = false;
    this.armLeftoverDrainTimer();
  }

  private armLeftoverDrainTimer(): void {
    this.clearLeftoverDrainTimer();
    this.leftoverDrainTimer = window.setTimeout(() => {
      this.leftoverCaptionIdle = true;
      this.maybeFinishLeftoverOutputDrain();
    }, runtime.captionIdleMs);
  }

  private maybeFinishLeftoverOutputDrain(): void {
    if (!this.leftoverOutputDraining || !this.leftoverCaptionIdle || this.playbackActive) {
      return;
    }
    this.leftoverOutputDraining = false;
    this.clearLeftoverDrainTimer();
    this.resolveLeftoverDrainWaiters();
  }

  private clearLeftoverDrainTimer(): void {
    if (this.leftoverDrainTimer === null) {
      return;
    }
    window.clearTimeout(this.leftoverDrainTimer);
    this.leftoverDrainTimer = null;
  }

  private releaseGateCAfterFreshCorrectionOutput(): void {
    if (this.leftoverOutputDraining || this.gateCHeldForCorrectionEpoch === null) {
      return;
    }
    if (this.gateCHeldForCorrectionEpoch !== this.correctionEpoch) {
      return;
    }
    this.gateCHeldForCorrectionEpoch = null;
    this.finishLeftoverOutputDrain();
    this.audio.setOutputAudible(true);
  }

  private tryEstablishCorrectionEpochFromPlayback(atMs: number): boolean {
    if (this.leftoverOutputDraining || !this.playbackActive || this.gateCHeldForCorrectionEpoch === null) {
      return false;
    }
    if (this.currentSession.state !== "outputting" || this.currentSession.activeTurn === undefined) {
      return false;
    }
    this.dispatch({ type: "AUDIO_STARTED", nowMs: atMs });
    this.releaseGateCAfterFreshCorrectionOutput();
    return true;
  }

  private async waitForPlaybackIdleOrSettle(): Promise<void> {
    if (!this.playbackActive) {
      return;
    }
    await new Promise<void>((resolve) => {
      this.playbackIdleWaitResolve = resolve;
      this.playbackIdleWaitTimer = window.setTimeout(() => {
        this.finishPlaybackIdleWait();
      }, runtime.playbackIdleMs + runtime.outputSettleGraceMs);
    });
  }

  private finishPlaybackIdleWait(): void {
    if (this.playbackIdleWaitTimer !== null) {
      window.clearTimeout(this.playbackIdleWaitTimer);
      this.playbackIdleWaitTimer = null;
    }
    const resolve = this.playbackIdleWaitResolve;
    this.playbackIdleWaitResolve = null;
    resolve?.();
  }

  private finishLeftoverOutputDrain(): void {
    this.leftoverOutputDraining = false;
    this.leftoverCaptionIdle = true;
    this.clearLeftoverDrainTimer();
    this.resolveLeftoverDrainWaiters();
  }

  private resolveLeftoverDrainWaiters(): void {
    const waiters = this.leftoverDrainWaiters;
    this.leftoverDrainWaiters = [];
    for (const resolve of waiters) {
      resolve();
    }
  }

  private waitForLeftoverOutputIdle(): Promise<void> {
    if (!this.leftoverOutputDraining && !this.playbackActive) {
      return Promise.resolve();
    }
    if (!this.leftoverOutputDraining) {
      this.beginLeftoverOutputDrain();
    }
    return new Promise((resolve) => {
      this.leftoverDrainWaiters.push(resolve);
      if (!this.leftoverOutputDraining && !this.playbackActive) {
        this.resolveLeftoverDrainWaiters();
      }
    });
  }

  private clearTurnEngineTimers(): void {
    this.clearMaxSourceTimer();
    this.clearCompletionTimer();
    this.clearCaptionIdleTimer();
    this.clearLeftoverDrainTimer();
    this.finishPlaybackIdleWait();
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
        this.failMicrophoneCapture(error);
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
    try {
      this.assertCaptureStreamLive(stream);
    } catch (error) {
      if (this.audio.getCaptureStream() !== null) {
        this.audio.stopCapture();
      }
      this.failMicrophoneCapture(error);
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

  private failMicrophoneCapture(error: unknown): never {
    if (error instanceof Error && error.name === "NotAllowedError") {
      console.error("Microphone capture failed", {
        error,
        state: this.currentSession.state,
      });
      this.ownerErrorMessage = MICROPHONE_DENIED_MESSAGE;
      this.notify();
      throw new Error(MICROPHONE_DENIED_MESSAGE);
    }
    this.failOwnerRequest("Microphone capture failed", error);
  }

  private assertStartupAppendWithinBudget(text: string): void {
    try {
      assertAppendWithinBudget(text);
    } catch (error) {
      if (error instanceof ContextTooLongError) {
        this.ownerErrorMessage = error.message;
        this.notify();
      }
      throw error;
    }
  }

  private assertCaptureStreamLive(stream: MediaStream): void {
    const track = stream.getAudioTracks()[0];
    if (track === undefined) {
      throw new Error("Microphone capture stream has no audio track");
    }
    if (track.readyState !== "live") {
      throw new Error(MICROPHONE_CAPTURE_ENDED_MESSAGE);
    }
  }

  private failStartupAppend(context: string, error: unknown): never {
    if (isAppendSizeError(error)) {
      console.error(context, { error, state: this.currentSession.state });
      const mapped = new ContextTooLongError();
      this.ownerErrorMessage = mapped.message;
      this.notify();
      throw mapped;
    }
    this.failStartup(context, error);
  }

  private failStartup(context: string, error: unknown): never {
    console.error(context, { error, state: this.currentSession.state });
    this.ownerErrorMessage = STARTUP_ERROR_MESSAGE;
    this.dispatch({
      type: "SESSION_ERROR",
      message: STARTUP_ERROR_MESSAGE,
    });
    throw error;
  }

  private failOwnerRequest(context: string, error: unknown): never {
    this.ownerErrorMessage = error instanceof Error ? error.message : String(error);
    this.notify();
    console.error(context, { error, state: this.currentSession.state });
    throw error;
  }

  private handleLiveTransportError(event: LiveClientErrorEvent): void {
    if (!this.enteredInterpreter) {
      return;
    }
    if (!("transportFailure" in event)) {
      return;
    }
    if (
      this.currentSession.state === "ending" ||
      this.currentSession.state === "ended" ||
      this.currentSession.state === "error"
    ) {
      return;
    }
    this.speechInputReady = false;
    this.audio.setOutputAudible(false);
    this.ownerErrorMessage = CONNECTION_ERROR_MESSAGE;
    this.dispatch({
      type: "SESSION_ERROR",
      message: CONNECTION_ERROR_MESSAGE,
    });
    console.error("Live transport failed", {
      error: event.error.message,
      state: this.currentSession.state,
    });
  }

  private handleLiveSessionClosed(event: SessionClosedEvent): void {
    const state = this.currentSession.state;
    if (state === "idle" || state === "ending" || state === "ended" || state === "error") {
      return;
    }

    const message = this.enteredInterpreter ? CONNECTION_ERROR_MESSAGE : STARTUP_ERROR_MESSAGE;
    this.sessionGeneration += 1;
    this.clearIdleTimer();
    this.clearMaxSessionTimer();
    this.clearTurnEngineTimers();
    this.capturingContext = false;
    this.capturingBootstrap = false;
    this.connectInFlight = false;
    this.interpreterInFlight = false;
    this.turnClosing = false;
    this.speechInputReady = false;
    this.playbackActive = false;
    this.resetRemotePlaybackTracking();
    this.leftoverOutputDraining = false;
    this.leftoverCaptionIdle = true;
    this.resolveLeftoverDrainWaiters();
    this.recoveryPromptKind = undefined;
    this.audio.setOutputAudible(false);
    if (this.audio.getCaptureStream() !== null) {
      this.audio.stopCapture();
    }
    this.stopPlatformLifecycle();
    this.hasConnected = false;
    this.liveConnectStarted = false;
    this.ownerErrorMessage = message;
    this.dispatch({
      type: "SESSION_ERROR",
      message,
    });
    console.error("Live session closed unexpectedly", {
      reason: event.reason,
      state,
    });
  }

  private armMaxSessionTimer(): void {
    this.clearMaxSessionTimer();
    this.maxSessionTimer = window.setTimeout(() => {
      void this.endConversation();
    }, runtime.maxSessionMs);
  }

  private clearMaxSessionTimer(): void {
    if (this.maxSessionTimer === null) {
      return;
    }
    window.clearTimeout(this.maxSessionTimer);
    this.maxSessionTimer = null;
  }

  private enqueueLifecycle(work: () => Promise<void>): Promise<void> {
    const run = this.lifecycleQueue.then(work, work);
    this.lifecycleQueue = run.then(
      () => undefined,
      () => undefined,
    );
    return run;
  }

  private bumpLifecycleEpoch(): number {
    this.lifecycleEpoch += 1;
    return this.lifecycleEpoch;
  }

  private async startPlatformLifecycle(): Promise<void> {
    if (this.platformStarted) {
      return;
    }
    this.platformStarted = true;
    this.orientation.start();
    this.visibility.start();
    try {
      if (!this.orientation.isPortrait()) {
        await this.suspendFromLifecycle("orientation");
      }
    } catch (error) {
      console.error("Screen orientation sample failed", {
        error,
        state: this.currentSession.state,
      });
    }
    await this.orientation.lockPortrait();
    await this.wakeLock.request();
  }

  private stopPlatformLifecycle(): void {
    this.orientation.stop();
    this.visibility.stop();
    void this.wakeLock.release();
    this.platformStarted = false;
    this.lifecycleSuspendReason = undefined;
    this.discardedUnfinishedOnSuspend = false;
    this.bumpLifecycleEpoch();
  }

  private conversationCanSuspend(): boolean {
    const state = this.currentSession.state;
    return state === "listening" || state === "outputting" || state === "correcting";
  }

  private async handleOrientationChange(orientation: "portrait" | "landscape"): Promise<void> {
    if (orientation === "landscape") {
      this.bumpLifecycleEpoch();
      await this.enqueueLifecycle(() => this.suspendFromLifecycle("orientation"));
      return;
    }
    await this.enqueueLifecycle(() => this.resumeFromLifecycle());
  }

  private async handleVisibilityHidden(): Promise<void> {
    this.bumpLifecycleEpoch();
    await this.enqueueLifecycle(() => this.suspendFromLifecycle("visibility"));
  }

  private async handleVisibilityVisible(): Promise<void> {
    await this.enqueueLifecycle(async () => {
      await this.wakeLock.reacquire();
      await this.resumeFromLifecycle();
    });
  }

  private async handleAudioInterruption(): Promise<void> {
    this.bumpLifecycleEpoch();
    await this.enqueueLifecycle(() => this.suspendFromLifecycle("audio"));
  }

  private async handleAudioRestored(): Promise<void> {
    await this.enqueueLifecycle(async () => {
      await this.wakeLock.reacquire();
      await this.resumeFromLifecycle();
    });
  }

  private handleCaptureEnded(): void {
    const state = this.currentSession.state;
    if (state === "idle" || state === "ending" || state === "ended" || state === "error") {
      return;
    }
    const live = this.live;
    const shouldCloseLive = this.hasConnected || this.liveConnectStarted;

    this.sessionGeneration += 1;
    this.clearIdleTimer();
    this.clearMaxSessionTimer();
    this.clearTurnEngineTimers();
    this.capturingContext = false;
    this.capturingBootstrap = false;
    this.connectInFlight = false;
    this.interpreterInFlight = false;
    this.turnClosing = false;
    this.speechInputReady = false;
    this.playbackActive = false;
    this.leftoverOutputDraining = false;
    this.leftoverCaptionIdle = true;
    this.resolveLeftoverDrainWaiters();
    this.recoveryPromptKind = undefined;
    this.audio.setOutputAudible(false);
    if (this.audio.getCaptureStream() !== null) {
      this.audio.stopCapture();
    }
    this.stopPlatformLifecycle();
    this.hasConnected = false;
    this.liveConnectStarted = false;
    this.ownerErrorMessage = MICROPHONE_CAPTURE_ENDED_MESSAGE;
    this.dispatch({
      type: "SESSION_ERROR",
      message: MICROPHONE_CAPTURE_ENDED_MESSAGE,
    });
    if (shouldCloseLive) {
      void live.close().catch((error: unknown) => {
        console.error("Live session close failed after microphone capture ended", {
          error,
          state,
        });
      });
    }
    console.error("Microphone capture ended", { state });
  }

  private clearTurnEngineTimersKeepingLeftoverDrain(): void {
    this.clearMaxSourceTimer();
    this.clearCompletionTimer();
    this.clearCaptionIdleTimer();
    this.finishPlaybackIdleWait();
  }

  private async suspendFromLifecycle(reason: LifecycleSuspendReason): Promise<void> {
    if (this.currentSession.state === "suspended") {
      this.lifecycleSuspendReason = reason;
      this.notify();
      return;
    }
    if (!this.conversationCanSuspend()) {
      return;
    }
    const generation = this.sessionGeneration;
    const active = this.currentSession.activeTurn;
    this.speechInputReady = false;
    this.discardedUnfinishedOnSuspend =
      active !== undefined && active.turnCompletedAtMs === undefined && !active.corrected;
    this.clearTurnEngineTimersKeepingLeftoverDrain();
    this.turnClosing = false;
    if (this.playbackActive && !this.leftoverOutputDraining) {
      this.beginLeftoverOutputDrain();
    }
    try {
      this.audio.setCaptureEnabled(false);
    } catch (error) {
      this.ownerErrorMessage = error instanceof Error ? error.message : String(error);
      this.dispatch({
        type: "SESSION_ERROR",
        message: this.ownerErrorMessage,
      });
      console.error("Lifecycle suspend failed", {
        error,
        state: this.currentSession.state,
      });
      return;
    }
    this.audio.setOutputAudible(false);
    this.dispatch({ type: "SUSPEND" });
    this.lifecycleSuspendReason = reason;
    this.recoveryPromptKind = undefined;
    this.notify();
    try {
      if (!(await this.muteGateB(generation))) {
        return;
      }
    } catch {
      if (this.sessionGeneration !== generation) {
        return;
      }
    }
  }

  private resumePreconditionsMet(): boolean {
    if (this.visibility.isHidden()) {
      return false;
    }
    if (!this.orientation.isPortrait()) {
      return false;
    }
    return true;
  }

  private async resumeFromLifecycle(): Promise<void> {
    if (this.currentSession.state !== "suspended") {
      return;
    }
    if (this.lifecycleSuspendReason === undefined) {
      return;
    }
    const epoch = this.lifecycleEpoch;

    try {
      if (!this.resumePreconditionsMet()) {
        return;
      }
    } catch (error) {
      this.failLifecycleResume(error);
      return;
    }

    try {
      this.assertResumeMedia();
    } catch (error) {
      this.failLifecycleResume(error);
      return;
    }

    await this.wakeLock.reacquire();
    if (this.lifecycleEpoch !== epoch) {
      return;
    }

    try {
      await this.audio.primeOutput();
    } catch (error) {
      console.error("Audio output restore failed", {
        error,
        state: this.currentSession.state,
      });
      this.failLifecycleResume(error);
      return;
    }
    if (this.lifecycleEpoch !== epoch) {
      return;
    }

    await this.waitForLeftoverOutputIdle();
    if (this.lifecycleEpoch !== epoch || this.currentSession.state !== "suspended") {
      return;
    }

    try {
      if (!this.resumePreconditionsMet()) {
        return;
      }
    } catch (error) {
      this.failLifecycleResume(error);
      return;
    }

    const session = this.currentSession;
    const expectedSource = session.expectedSpeaker;
    const recipient = expectedSource === "A" ? "B" : "A";
    const recipientProfile = recipient === "A" ? session.participantA : session.participantB;
    const initialRecipientHint = recipientProfile.hasAcceptedConversationSpeech
      ? undefined
      : recipientProfile.initialLanguageHint;
    const generation = this.sessionGeneration;
    try {
      await this.live.appendInstructions(
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
    } catch (error) {
      if (this.sessionGeneration !== generation) {
        return;
      }
      console.error("Post-resume steering append failed", {
        error,
        state: this.currentSession.state,
      });
      this.failLifecycleResume(error);
      return;
    }
    if (this.sessionGeneration !== generation || this.lifecycleEpoch !== epoch) {
      return;
    }

    try {
      if (!this.resumePreconditionsMet()) {
        return;
      }
    } catch (error) {
      this.failLifecycleResume(error);
      return;
    }

    this.audio.resetVoiceActivityBaseline();
    try {
      if (!(await this.unmuteGateB(generation))) {
        this.audio.setOutputAudible(false);
        return;
      }
    } catch (error) {
      if (this.sessionGeneration !== generation || this.lifecycleEpoch !== epoch) {
        return;
      }
      this.audio.setOutputAudible(false);
      this.failLifecycleResume(error);
      return;
    }
    if (this.sessionGeneration !== generation || this.lifecycleEpoch !== epoch) {
      this.audio.setOutputAudible(false);
      if (this.sessionGeneration !== generation) {
        return;
      }
      try {
        await this.muteGateB(generation);
      } catch {
        if (this.sessionGeneration !== generation) {
          return;
        }
      }
      return;
    }
    try {
      this.audio.setCaptureEnabled(true);
    } catch (error) {
      this.failLifecycleResume(error);
      return;
    }
    this.audio.setOutputAudible(true);
    this.speechInputReady = true;
    this.dispatch({ type: "RESUME" });
    this.recoveryPromptKind = this.discardedUnfinishedOnSuspend ? "repeat" : undefined;
    this.lifecycleSuspendReason = undefined;
    this.notify();
  }

  private assertResumeMedia(): void {
    const stream = this.audio.getCaptureStream();
    if (stream === null) {
      throw new Error("Microphone capture stream is unavailable");
    }
    const track = stream.getAudioTracks()[0];
    if (track === undefined) {
      throw new Error("Microphone track is unavailable");
    }
    if (track.readyState !== "live") {
      throw new Error(`Microphone track is not live (readyState "${track.readyState}")`);
    }

    const peerState = this.live.peerConnectionState;
    if (peerState === null || peerState === undefined) {
      throw new Error("RTCPeerConnection state is unavailable");
    }
    if (peerState === "failed" || peerState === "closed") {
      throw new Error(`Peer connection state is "${peerState}"`);
    }

    const channelState = this.live.dataChannelReadyState;
    if (channelState === null || channelState === undefined) {
      throw new Error("Data channel state is unavailable");
    }
    if (channelState !== "open") {
      throw new Error(`Data channel is not open (readyState "${channelState}")`);
    }
  }

  private failLifecycleResume(error: unknown): void {
    this.speechInputReady = false;
    this.ownerErrorMessage = error instanceof Error ? error.message : String(error);
    this.dispatch({
      type: "SESSION_ERROR",
      message: this.ownerErrorMessage,
    });
    console.error("Lifecycle resume failed", {
      error,
      state: this.currentSession.state,
    });
  }

  private resetToIdle(options: { preserveOwnerError?: boolean } = {}): void {
    const preservedError =
      options.preserveOwnerError === true ? this.ownerErrorMessage : undefined;
    this.audio.setOutputAudible(false);
    this.audio.audioElement.srcObject = null;
    this.hasConnected = false;
    this.contextBuffer = "";
    this.bootstrapBuffer = "";
    this.ownerErrorMessage = preservedError;
    this.degradedBootstrap = false;
    this.contextFrozenByUser = false;
    this.authoritativeContextSent = false;
    this.liveConnectStarted = false;
    this.connectInFlight = false;
    this.connectWork = null;
    this.interpreterInFlight = false;
    this.interpreterWork = null;
    this.gateBMuted = false;
    this.maxSourceMuteInFlight = null;
    this.playbackActive = false;
    this.resetRemotePlaybackTracking();
    this.turnClosing = false;
    this.speechInputReady = false;
    this.leftoverOutputDraining = false;
    this.leftoverCaptionIdle = true;
    this.resolveLeftoverDrainWaiters();
    this.recoveryPromptKind = undefined;
    this.steeringDegradedFlag = false;
    this.correctionEpoch = 0;
    this.gateCHeldForCorrectionEpoch = null;
    this.correctionWork = null;
    this.endWork = null;
    this.enteredInterpreter = false;
    this.conversationMetrics = new ConversationMetrics();
    this.finishPlaybackIdleWait();
    this.clearTurnEngineTimers();
    this.clearMaxSessionTimer();
    this.stopPlatformLifecycle();
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
