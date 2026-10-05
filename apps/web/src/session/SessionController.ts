import { COUNTER_NAMES, type MetricCounters } from "../metrics/UsageTypes";
import { BackendClient } from "../api/BackendClient";
import { AudioController, type PlaybackActivityEvent } from "../audio/AudioController";
import type { AudioActivityEvent } from "../audio/VoiceActivityMonitor";
import { runtime } from "../config/runtime";
import {
  buildTurnCompletionSnapshot,
  evaluateTurnCompletion,
} from "../conversation/TurnCompletion";
import { createTranscriptFragment } from "../conversation/TurnBuffer";
import { TranscriptRouter, type RoutedTranscript } from "../conversation/TranscriptRouter";
import { DialogueTranscript } from "../conversation/DialogueTranscript";
import { earliestFragmentStart, type TranscriptFragment } from "../conversation/TranscriptFragment";
import type { ResumeSnapshot, ResumeSnapshotInput } from "./ResumeSnapshotStore";
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
  buildInterpreterInstructions,
  buildSteering,
  buildUnfinishedTurnWarning,
} from "../live/LivePrompts";
import { traceAckErrorType, traceBeginInterpreter } from "../live/StartupTrace";
import { ConversationMetrics } from "../metrics/ConversationMetrics";
import { OrientationController } from "../platform/OrientationController";
import { VisibilityController } from "../platform/VisibilityController";
import { WakeLockController } from "../platform/WakeLockController";
import { findSessionTurn, sessionReducer, type SessionAction } from "./sessionReducer";
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

import { detectLanguage, type ConversationLanguages } from "../side/SideResolver";

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
    onSourceSample?: AudioController["onSourceSample"];
    meteringMediaReady?: boolean;
    setNonInterrupting?: AudioController["setNonInterrupting"];
    setPlaybackTurn?: AudioController["setPlaybackTurn"];
    playOutput?: AudioController["playOutput"];
    detachRemoteStream?: AudioController["detachRemoteStream"];
    hasPendingPlayback?: boolean;
    rawPlaybackActive?: AudioController["rawPlaybackActive"];
    onRemoteAudioSample?: AudioController["onRemoteAudioSample"];
    onPlaybackBufferError?: AudioController["onPlaybackBufferError"];
    onPlaybackDecoderError?: AudioController["onPlaybackDecoderError"];
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
  private bootstrapAccepting = false;
  private capturingContext = false;
  private capturingBootstrap = false;
  private freshBootstrapReady = false;
  private contextFrozenByUser = false;
  private authoritativeContextSent = false;
  private hasConnected = false;
  private liveConnectStarted = false;
  private connectInFlight = false;
  private connectWork: Promise<void> | null = null;
  private interpreterInFlight = false;
  private interpreterWork: Promise<void> | null = null;
  private pendingInterlocutorLanguage: string | undefined;
  private cancelWork: Promise<void> | null = null;
  private sessionGeneration = 0;
  private liveProductGeneration = 0;
  private retiringLiveClose: Promise<{ finalized: boolean }> | null = null;
  private idleTimer: number | null = null;
  private maxSessionTimer: number | null = null;
  private maxSourceTimer: number | null = null;
  private completionTimer: number | null = null;
  private captionIdleTimer: number | null = null;
  private leftoverDrainTimer: number | null = null;
  private leftoverOutputDraining = false;
  private leftoverCaptionIdle = true;
  private leftoverRawIdleObserved = true;
  private leftoverDrainWaiters: Array<() => void> = [];
  private lifecycleEpoch = 0;
  private lifecycleQueue: Promise<void> = Promise.resolve();
  private gateBMuted = false;
  private maxSourceMuteInFlight: { generation: number; promise: Promise<void> } | null = null;
  private sourceTimeoutResumeWork: Promise<void> | null = null;
  private playbackActive = false;
  private outputTurnId: string | undefined;
  private outputSourceTurnId: string | undefined;
  private latestSourceTurnId: string | undefined;
  private playbackTurnId: string | undefined;
  private readonly sourceRouter = new TranscriptRouter();
  private readonly outputRouter = new TranscriptRouter();
  private readonly dialogueTranscript = new DialogueTranscript();
  get captionBlocks() { return this.dialogueTranscript.blocks; }
  private sourceFragmentTimer: number | null = null;
  private outputFragmentTimer: number | null = null;
  private lastOutputSide: Side | undefined;
  private readonly routingTurnIds = new Set<string>();
  private sourceVoiceActive: boolean | undefined;
  private resumedSourceIdle: { turnId: string; atMs: number; observedThroughMs?: number } | undefined;
  private remotePlaybackGeneration = 0;
  private remotePlaybackState: RemotePlaybackState = "ready";
  private remotePlaybackWork: Promise<void> | null = null;
  private remotePlaybackTrack: MediaStreamTrack | null = null;
  private remoteTrackArrived: (() => void) | null = null;
  private retainedProductDeadlineAt: number | null = null;
  private retainedPlaybackCommitted = false;
  private pendingRemotePlaybackActivity: PlaybackActivityEvent[] = [];
  private turnClosing = false;
  private speechInputReady = false;
  private recoveryPromptKind: RecoveryPrompt | undefined;
  private turnFailurePrompt = false;
  private steeringDegradedFlag = false;
  private endWork: Promise<void> | null = null;
  private platformStarted = false;
  private earlyVisibilityStarted = false;
  private backgroundPaused = false;
  private backgroundCloseWork: Promise<void> | null = null;
  protected retainedResumeInFlight = false;
  protected retainedResumeCaptureEnded = false;
  private visibleAgainDuringResume = false;
  private providerStartedObservedAt = 0;
  protected retainedResumePhase: "media" | "create" | "restore" | "complete" = "media";
  private lifecycleSuspendReason: LifecycleSuspendReason | undefined;
  private discardedUnfinishedOnSuspend = false;
  private enteredInterpreter = false;
  private conversationMetrics = new ConversationMetrics();
  private readonly orientation: OrientationController;
  private readonly visibility: VisibilityController;
  private readonly wakeLock: WakeLockController;
  private readonly listeners = new Set<() => void>();

  constructor(private readonly deps: SessionControllerDeps) {
    this.currentSession = createEmptySession();
    this.live = deps.createLive();
    this.orientation = deps.orientation ?? new OrientationController();
    this.visibility = deps.visibility ?? new VisibilityController();
    this.wakeLock = deps.wakeLock ?? new WakeLockController();
    this.orientation.onChange = (orientation) => {
      void this.handleOrientationChange(orientation);
    };
    this.visibility.onHidden = () => {
      this.onVisibilityHidden();
      if (!this.backgroundCloseEnabled && !this.platformStarted) return;
      void this.handleVisibilityHidden();
    };
    this.visibility.onVisible = () => {
      if (!this.backgroundCloseEnabled && !this.platformStarted) return;
      void this.handleVisibilityVisible();
    };
    this.bindLive();
    this.bindAudio();
  }

  get session(): TranslationSession {
    return this.currentSession;
  }

  protected get backgroundCloseEnabled(): boolean { return false; }
  protected onVisibilityHidden(): void {}
  protected get retainedPaused(): boolean { return this.backgroundPaused; }
  protected beginBackgroundPause(): void {}
  protected resumeBackground(): Promise<void> { return Promise.resolve(); }
  protected get backgroundResumeGeneration(): number { return this.sessionGeneration; }
  protected adoptRetainedPause(snapshot: ResumeSnapshot): void {
    if (this.backgroundPaused || this.currentSession.state !== "idle") return;
    this.sessionGeneration++;
    this.backgroundPaused = true;
    this.currentSession = { ...this.currentSession, state: "suspended",
      participantA: { ...this.currentSession.participantA, ...snapshot.participantA },
      participantB: { ...this.currentSession.participantB, ...snapshot.participantB } };
    this.lifecycleSuspendReason = "visibility";
    this.notify();
  }
  protected clearRetainedAfterEnd(): void { this.resetToIdle(); }
  protected backgroundResumeCurrent(generation: number): boolean {
    return this.backgroundPaused && this.sessionGeneration === generation && !this.visibility.isHidden() &&
      this.orientation.isPortrait() && this.endWork === null && this.cancelWork === null;
  }
  protected beginOutputPriming(): Promise<void> {
    const priming = this.audio.primeOutput();
    void priming.catch(() => undefined); // Policy/claim may reject before the priming result is awaited.
    return priming;
  }
  protected async restoreRetained(snapshot: ResumeSnapshot, complete: (startedAt: number) => Promise<void>,
    primedOutput?: Promise<void>): Promise<void> {
    const generation = this.sessionGeneration;
    this.retainedResumePhase = "media";
    const current = () => this.backgroundResumeCurrent(generation);
    if (!current()) throw new Error("Resume cancelled");
    await (primedOutput ?? this.audio.primeOutput());
    if (!current()) throw new Error("Resume cancelled");
    this.audio.setOutputAudible(false);
    await this.audio.startCapture();
    if (!current()) throw new Error("Resume cancelled");
    const stream = this.audio.getCaptureStream();
    if (!stream) throw new Error("Microphone capture stream is unavailable");
    this.assertCaptureStreamLive(stream);
    this.audio.setCaptureEnabled(false);
    const live = this.live = this.deps.createLive();
    this.bindLive();
    this.retainedProductDeadlineAt = snapshot.productDeadlineAt;
    this.conversationMetrics = new ConversationMetrics();
    this.conversationMetrics.restoreCounters(snapshot.counters);
    this.publishRetainedCounterBaseline();
    const remoteTrack = new Promise<void>(resolve => { this.remoteTrackArrived = resolve; });
    this.liveConnectStarted = true;
    this.retainedResumePhase = "create";
    await live.connect(stream);
    this.retainedResumePhase = "restore";
    if (!current()) throw new Error("Resume cancelled");
    const waitForPlayback = async (waitForTrack = false) => {
      const waitMs = Math.min(runtime.steeringAckTimeoutMs, (snapshot.localResumeDeadlineAt ?? 0) - Date.now(),
        (snapshot.serverResumeExpiresAt ?? 0) - Date.now(),
        (snapshot.productDeadlineAt ?? Infinity) - Date.now());
      if (waitMs <= 0) throw new Error("Remote playback deadline expired");
      let timer: number | undefined;
      try {
        await Promise.race([(async () => {
          if (waitForTrack) await remoteTrack;
          if (!current() || !this.remotePlaybackWork) throw new Error("Remote playback is unavailable");
          let playbackWork: Promise<void>;
          do {
            playbackWork = this.remotePlaybackWork;
            await playbackWork;
            if (!current() || !this.remotePlaybackWork) throw new Error("Resume cancelled");
          } while (playbackWork !== this.remotePlaybackWork);
          this.assertRemotePlaybackReady();
        })(), new Promise<never>((_, reject) => {
          timer = window.setTimeout(() => reject(new Error("Remote audio playback unavailable")), waitMs);
        })]);
      } finally {
        if (timer !== undefined) window.clearTimeout(timer);
      }
    };
    try {
      await waitForPlayback(true);
    } finally {
      this.remoteTrackArrived = null;
    }
    if (!current()) throw new Error("Resume cancelled");
    await waitForPlayback();
    await this.muteGateB(generation);
    if (!current()) throw new Error("Resume cancelled");
    const languages = { A: snapshot.participantA.language, B: snapshot.participantB.language };
    if (snapshot.setupStage === "interpreter" && snapshot.contextText.trim()) {
      await live.appendThinking(buildAuthoritativeContext(snapshot.contextText.trim()), { kind: "startup_interpreter" });
      if (!current()) throw new Error("Resume cancelled");
      this.authoritativeContextSent = true;
    }
    if (snapshot.setupStage === "interpreter") {
      if (!languages.A || !languages.B || languages.A === languages.B) throw new Error("Invalid retained language pair");
      await live.appendInstructions(buildInterpreterInstructions({ A: languages.A, B: languages.B }), { kind: "startup_interpreter" });
      if (!current()) throw new Error("Resume cancelled");
      await live.appendInstructions(buildSteering({ A: languages.A, B: languages.B }),
        { kind: "first_steering", sessionState: "suspended" });
      if (!current()) throw new Error("Resume cancelled");
    }
    if (!this.providerStartedObservedAt ||
      Date.now() >= (snapshot.localResumeDeadlineAt ?? 0) ||
      Date.now() >= (snapshot.serverResumeExpiresAt ?? 0) ||
      (snapshot.productDeadlineAt !== null && Date.now() >= snapshot.productDeadlineAt))
      throw new Error("Resume readiness or deadline expired");
    await waitForPlayback();
    this.assertCaptureStreamLive(stream);
    this.retainedResumePhase = "complete";
    await complete(this.providerStartedObservedAt);
    if (!current() || Date.now() >= (snapshot.localResumeDeadlineAt ?? 0) ||
      Date.now() >= (snapshot.serverResumeExpiresAt ?? 0) ||
      (snapshot.productDeadlineAt !== null && Date.now() >= snapshot.productDeadlineAt))
      throw new Error("Resume cancelled after commit");
    await waitForPlayback();
    this.assertCaptureStreamLive(stream);
    this.contextBuffer = snapshot.contextText;
    this.contextFrozenByUser = true;
    this.bootstrapBuffer = "";
    this.currentSession = { state: snapshot.setupStage === "interpreter" ? "listening" : snapshot.setupStage === "bootstrap" ? "bootstrap" : "connecting",
      contextText: snapshot.contextText, recentTurns: this.currentSession.recentTurns,
      participantA: { side: "A", ...snapshot.participantA }, participantB: { side: "B", ...snapshot.participantB } };
    this.pendingInterlocutorLanguage = undefined;
    this.enteredInterpreter = snapshot.enteredInterpreter;
    this.freshBootstrapReady = snapshot.setupStage === "bootstrap";
    this.hasConnected = true;
    this.retainedPlaybackCommitted = true;
    this.lifecycleSuspendReason = undefined;
    this.discardedUnfinishedOnSuspend = snapshot.interruptedUtterance;
    this.recoveryPromptKind = snapshot.interruptedUtterance ? "repeat" : undefined;
    this.turnFailurePrompt = false;
    if (snapshot.setupStage === "interpreter") {
      await waitForPlayback();
      this.assertCaptureStreamLive(stream);
      if (!(await this.unmuteGateB(generation)) || this.sessionGeneration !== generation || this.visibility.isHidden())
        throw new Error("Resume cancelled before input opened");
      await waitForPlayback();
      this.assertCaptureStreamLive(stream);
      this.audio.resetVoiceActivityBaseline();
      this.audio.setCaptureEnabled(true);
      this.assertRemotePlaybackReady();
      this.audio.setOutputAudible(true);
      this.speechInputReady = true;
      await this.startPlatformLifecycle();
    } else {
      await waitForPlayback();
      this.assertCaptureStreamLive(stream);
      if (!(await this.unmuteGateB(generation))) throw new Error("Resume cancelled before setup input opened");
      await waitForPlayback();
      this.assertCaptureStreamLive(stream);
    }
    if (!current()) throw new Error("Resume cancelled after commit");
    await waitForPlayback();
    this.backgroundPaused = false;
    this.backgroundCloseWork = null;
    this.notify();
  }
  private assertRemotePlaybackReady(): void {
    if (this.remotePlaybackState !== "ready" || this.remotePlaybackTrack?.readyState !== "live" || this.audio.audioElement.error != null)
      throw new Error("Remote playback is unavailable");
  }
  protected async abandonRetainedMedia(reason: "hidden" | "abandoned_connect"): Promise<void> {
    this.stopLocalMedia();
    await this.live.disconnectImmediately(reason);
  }
  protected fenceRetainedResumeForDisposal(): void {
    if (!this.retainedResumeInFlight) return;
    this.sessionGeneration++;
    this.bumpLifecycleEpoch();
    try { this.stopLocalMedia(); } catch { this.closeGateAForSafety("Resume disposal capture gate failed"); }
    void this.live.disconnectImmediately("cancelled").catch(() => console.error("Resume disposal cleanup incomplete"));
  }
  protected fenceRetainedRecoveryForEnd(): void {
    this.sessionGeneration++;
    this.bumpLifecycleEpoch();
    this.stopLocalMedia();
    void this.live.disconnectImmediately("user_end").catch(() => console.error("Retained End transport cleanup incomplete"));
  }
  protected beginRetainedResume(): boolean {
    if (this.retainedResumeInFlight) return false;
    this.retainedResumeCaptureEnded = false;
    this.retainedResumeInFlight = true;
    return true;
  }
  protected finishRetainedResume(): void {
    this.retainedResumeInFlight = false;
    this.retainedResumeCaptureEnded = false;
    if (this.visibleAgainDuringResume) {
      this.visibleAgainDuringResume = false;
      if (this.backgroundPaused && !this.visibility.isHidden()) void this.handleVisibilityVisible();
    }
  }
  protected clearIdleBackgroundPause(): boolean { return true; }
  protected pauseBackground(_state: Omit<ResumeSnapshotInput, "conversationId" | "conversationVersion" | "policyVersion" | "productDeadlineAt">,
    _hiddenAt: number, _close: Promise<unknown>): Promise<void> {
    void _state; void _hiddenAt; void _close;
    return Promise.resolve();
  }
  protected startEarlyVisibility(): void {
    if (this.earlyVisibilityStarted) return;
    this.visibility.start();
    this.earlyVisibilityStarted = true;
  }
  protected stopEarlyVisibility(): void {
    if (!this.earlyVisibilityStarted) return;
    this.visibility.stop();
    this.earlyVisibilityStarted = false;
  }
  protected async awaitBackgroundPause(): Promise<void> {
    await this.backgroundCloseWork?.catch(() => undefined);
  }
  protected resetAfterUnpausedBackground(): void { this.resetToIdle(); }
  protected sampleInitialHidden(): boolean {
    if (!this.backgroundCloseEnabled) return false;
    if (this.backgroundPaused && !this.visibility.isHidden() && this.currentSession.state === "idle" &&
      this.clearIdleBackgroundPause()) {
      this.backgroundPaused = false;
      this.backgroundCloseWork = null;
      this.sessionGeneration++;
      this.live = this.deps.createLive();
      this.bindLive();
    }
    if (this.backgroundPaused) return true;
    if (!this.visibility.isHidden()) return false;
    void this.handleVisibilityHidden();
    return true;
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

  get bootstrapSide(): Side {
    return this.currentSession.participantA.language === undefined ? "A" : "B";
  }

  get bootstrapRecording(): boolean {
    return this.capturingBootstrap;
  }

  get languagesReady(): boolean {
    return this.currentSession.participantA.language !== undefined &&
      this.currentSession.participantB.language !== undefined;
  }

  private get languages(): ConversationLanguages {
    const A = this.currentSession.participantA.language;
    const B = this.currentSession.participantB.language;
    if (A === undefined || B === undefined || A === B) {
      throw new Error("Сначала запишите образцы речи A и B на разных языках.");
    }
    return { A, B };
  }

  get recoveryPrompt(): RecoveryPrompt | undefined {
    return this.recoveryPromptKind;
  }

  get recoveryPromptIsTurnFailure(): boolean {
    return this.recoveryPromptKind === "repeat" && this.turnFailurePrompt;
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

  private nonInterruptingEnabled = false;
  get nonInterrupting(): boolean { return this.nonInterruptingEnabled; }
  setNonInterrupting(enabled: boolean): void {
    if (!["listening", "outputting"].includes(this.currentSession.state)) return;
    try {
      if (!this.audio.setNonInterrupting) throw new Error("Buffered playback unavailable");
      this.audio.setNonInterrupting(enabled);
      this.nonInterruptingEnabled = enabled;
      this.ownerErrorMessage = undefined;
    } catch {
      this.ownerErrorMessage = "Режим «Не перебивать» недоступен в этом браузере.";
    }
    this.notify();
  }

  get inputReady(): boolean {
    return (
      (this.currentSession.state === "listening" || this.currentSession.state === "outputting") &&
      (this.currentSession.activeTurn === undefined || this.currentSession.activeTurn.sourceIdleAtMs !== undefined) &&
      this.speechInputReady
    );
  }

  get isConnectInFlight(): boolean {
    return this.connectInFlight || this.cancelWork !== null;
  }

  get isInterpreterStarting(): boolean {
    return this.interpreterInFlight || this.bootstrapAccepting;
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
    if (this.backgroundPaused) return;
    this.contextFrozenByUser = true;
    this.finishContextCapture();
    this.applyContextText(text);
  }

  clearContext(): void {
    this.setContextText("");
  }

  async startContextCapture(primedOutput?: Promise<void>): Promise<void> {
    if (this.endWork !== null) await this.endWork;
    if (this.cancelWork !== null) {
      await this.cancelWork;
    }
    if (this.connectWork !== null) {
      await this.connectWork;
      return;
    }
    const work = this.runStartContextCapture(primedOutput);
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

  async startBootstrap(primedOutput?: Promise<void>): Promise<void> {
    if (this.endWork !== null) await this.endWork;
    if (this.cancelWork !== null) {
      await this.cancelWork;
    }
    if (this.connectWork !== null) {
      await this.connectWork;
      return;
    }
    const work = this.runStartBootstrap(primedOutput);
    this.connectWork = work;
    try {
      await work;
    } finally {
      if (this.connectWork === work) {
        this.connectWork = null;
      }
    }
  }

  async startWithLanguages(languages: ConversationLanguages, primedOutput?: Promise<void>): Promise<void> {
    if (!languages.A || !languages.B || languages.A === languages.B) {
      throw new Error("Выберите два разных языка.");
    }
    if (this.endWork !== null) await this.endWork;
    if (this.cancelWork !== null) await this.cancelWork;
    if (this.connectWork !== null) return this.connectWork;
    const work = (async () => {
      const generation = this.sessionGeneration;
      this.connectInFlight = true;
      this.notify();
      try {
        await this.ensureConnected(primedOutput);
        if (generation !== this.sessionGeneration || this.currentSession.state !== "connecting") return;
        this.audio.setCaptureEnabled(false);
        if (!(await this.muteGateB(generation))) return;
        if (generation !== this.sessionGeneration) return;
        this.currentSession = {
          ...this.currentSession,
          participantA: { ...this.currentSession.participantA, language: languages.A },
          participantB: { ...this.currentSession.participantB, language: languages.B },
        };
        this.dispatch({ type: "SKIP_CONTEXT" });
        await this.beginInterpreter();
      } finally {
        if (generation === this.sessionGeneration) {
          this.connectInFlight = false;
          this.notify();
        }
      }
    })();
    this.connectWork = work;
    try { await work; }
    finally { if (this.connectWork === work) this.connectWork = null; }
  }

  async changeInterlocutorLanguage(language: string): Promise<void> {
    if (this.currentSession.state !== "listening" && this.currentSession.state !== "outputting") {
      throw new Error("Сменить язык можно во время разговора.");
    }
    if (!language || language === this.currentSession.participantA.language) {
      throw new Error("Выберите язык, отличный от вашего.");
    }
    if (language === this.currentSession.participantB.language) {
      this.pendingInterlocutorLanguage = undefined;
      this.notify();
      return;
    }
    if (this.currentSession.activeTurn || this.currentSession.pendingTurns?.length || this.turnClosing || this.playbackActive ||
        this.sourceRouter.hasPending || this.outputRouter.hasPending) {
      this.pendingInterlocutorLanguage = language;
      this.notify();
      if (!this.currentSession.activeTurn && !this.currentSession.pendingTurns?.length && !this.turnClosing) {
        await this.considerTurnCompletion(Date.now());
      }
      return;
    }
    const generation = this.sessionGeneration;
    const lifecycleEpoch = this.lifecycleEpoch;
    const current = () => generation === this.sessionGeneration && lifecycleEpoch === this.lifecycleEpoch &&
      (this.currentSession.state === "listening" || this.currentSession.state === "outputting");
    const interrupted = () => new Error("Смена языка прервана изменением состояния разговора.");
    this.speechInputReady = false;
    this.audio.setCaptureEnabled(false);
    this.notify();
    try {
      if (!(await this.muteGateB(generation)) || !current()) throw interrupted();
      this.resetTranscriptRouting();
      this.currentSession = {
        ...this.currentSession,
        participantB: { ...this.currentSession.participantB, language },
      };
      if (this.pendingInterlocutorLanguage === language) this.pendingInterlocutorLanguage = undefined;
      this.notify();
      await this.live.appendInstructions(buildSteering(this.languages), {
        kind: "later_steering", sessionState: this.currentSession.state,
      });
      if (!current()) throw interrupted();
      if (!(await this.unmuteGateB(generation)) || !current()) {
        if (generation === this.sessionGeneration) await this.muteGateB(generation);
        throw interrupted();
      }
      this.audio.setCaptureEnabled(true);
      this.speechInputReady = true;
      this.notify();
    } catch (error) {
      if (!current()) throw error;
      this.ownerErrorMessage = CONNECTION_ERROR_MESSAGE;
      this.dispatch({ type: "SESSION_ERROR", message: this.ownerErrorMessage });
      throw error;
    }
  }

  get selectedInterlocutorLanguage(): string | undefined {
    return this.pendingInterlocutorLanguage ?? this.currentSession.participantB.language;
  }

  handleRemoteStream(stream: MediaStream, source: LiveClient): void {
    // Validate origin BEFORE attaching. A generation captured after a stale callback is too late.
    if (source !== this.live || this.liveProductGeneration !== this.sessionGeneration ||
        ["ending", "ended", "error"].includes(this.currentSession.state)) return;
    const track = stream.getAudioTracks().find(track => track.readyState === "live");
    if (!track || this.remotePlaybackTrack) return;
    this.remotePlaybackTrack = track;
    const sessionGeneration = this.sessionGeneration;
    track.addEventListener("ended", () => {
      if (this.remotePlaybackTrack === track) this.failRemotePlayback(source, sessionGeneration, this.remotePlaybackGeneration,
        new Error("Remote audio track ended"));
    }, { once: true });
    this.audio.attachRemoteStream(stream);
    this.audio.setPlaybackTurn?.(this.outputTurnId);
    let recovered = false;
    const startPlayback = () => {
      const playbackGeneration = ++this.remotePlaybackGeneration;
      this.remotePlaybackState = "pending";
      this.pendingRemotePlaybackActivity = [];
      this.remotePlaybackWork = (this.audio.playOutput?.() ?? this.audio.audioElement.play())
      .then(() => {
        if (
          source !== this.live || this.sessionGeneration !== sessionGeneration ||
          this.remotePlaybackGeneration !== playbackGeneration || this.remotePlaybackState !== "pending"
        ) {
          return;
        }
        if (track.readyState !== "live") {
          this.failRemotePlayback(source, sessionGeneration, playbackGeneration, new Error("Remote audio track ended"));
          return;
        }
        this.remotePlaybackState = "ready";
        const pending = this.pendingRemotePlaybackActivity;
        this.pendingRemotePlaybackActivity = [];
        // Preserve every queued owner before deciding whether any turn was text-only.
        for (const event of pending) void this.handlePlaybackActivity(event, false);
        void this.considerTurnCompletion(Date.now());
      })
      .catch((error: unknown) => {
        if (
          source !== this.live || this.sessionGeneration !== sessionGeneration ||
          this.remotePlaybackGeneration !== playbackGeneration
        ) {
          return;
        }
        // Initial play refusal allows text-only startup; failed decoder recovery is terminal.
        this.failRemotePlayback(source, sessionGeneration, playbackGeneration, error, recovered);
      });
    };
    const handlePlaybackError = (error: MediaError | null) => {
      if (source !== this.live || this.sessionGeneration !== sessionGeneration || this.remotePlaybackTrack !== track ||
        (this.backgroundPaused && !this.retainedResumeInFlight) || this.remotePlaybackState === "failed") return;
      if (!error) return;
      if (error.code === 3 && !recovered) {
        recovered = true;
        this.audio.audioElement.load();
        startPlayback();
      } else {
        this.failRemotePlayback(source, sessionGeneration, this.remotePlaybackGeneration, error);
      }
    };
    this.audio.audioElement.onerror = () => handlePlaybackError(this.audio.audioElement.error);
    this.audio.onPlaybackDecoderError = handlePlaybackError;
    startPlayback();
    this.remoteTrackArrived?.();
  }

  private failRemotePlayback(source: LiveClient, sessionGeneration: number, playbackGeneration: number, error: unknown,
    terminalFailure = true): void {
    if (source !== this.live || this.sessionGeneration !== sessionGeneration ||
      this.remotePlaybackGeneration !== playbackGeneration || this.remotePlaybackState === "failed") return;
    this.remotePlaybackState = "failed";
    this.pendingRemotePlaybackActivity = [];
    this.playbackActive = false;
    console.error("Remote audio playback failed", { error });
    if (this.retainedPlaybackCommitted || (!this.retainedResumeInFlight && terminalFailure &&
      (this.hasConnected || this.liveConnectStarted))) {
      try { this.stopLocalMedia(); }
      catch {
        this.closeGateAForSafety("Remote playback capture gate failed");
        try { this.audio.setOutputAudible(false); } catch { /* Continue retirement. */ }
        try { this.audio.audioElement.srcObject = null; } catch { /* Continue retirement. */ }
        try { this.audio.stopCapture(); } catch { /* Gate A remains closed. */ }
      }
      void this.live.disconnectImmediately("abandoned_connect")
        .catch(retireError => console.error("Remote playback cleanup failed", { error: retireError }));
      void this.endConversation().catch(retireError => console.error("Remote playback retirement failed", { error: retireError }));
    }
  }

  private acceptRemotePlaybackActivity(event: PlaybackActivityEvent): boolean {
    if (this.remotePlaybackState === "ready") {
      return true;
    }
    if (this.remotePlaybackState === "pending") {
      this.pendingRemotePlaybackActivity.push(event);
    }
    return false;
  }

  private resetRemotePlaybackTracking(): void {
    this.audio.audioElement.onerror = null;
    this.audio.onPlaybackDecoderError = null;
    this.remoteTrackArrived?.();
    this.remoteTrackArrived = null;
    this.retainedPlaybackCommitted = false;
    this.remotePlaybackGeneration += 1;
    this.remotePlaybackState = "ready";
    this.remotePlaybackWork = null;
    this.remotePlaybackTrack = null;
    this.pendingRemotePlaybackActivity = [];
    this.playbackActive = false;
    this.playbackTurnId = undefined;
  }

  async resumeFromSourceTimeout(): Promise<void> {
    if (this.backgroundPaused) return;
    if (this.sourceTimeoutResumeWork !== null) {
      await this.sourceTimeoutResumeWork;
      return;
    }
    const work = this.runResumeFromSourceTimeout();
    this.sourceTimeoutResumeWork = work;
    try {
      await work;
    } finally {
      if (this.sourceTimeoutResumeWork === work) {
        this.sourceTimeoutResumeWork = null;
      }
    }
  }

  private async runResumeFromSourceTimeout(): Promise<void> {
    if (this.currentSession.state !== "suspended") {
      throw new Error(`Cannot resume from "${this.currentSession.state}"`);
    }
    const generation = this.sessionGeneration;
    const lifecycleEpoch = this.lifecycleEpoch;
    const resumeStillCurrent = (): boolean =>
      this.sessionGeneration === generation &&
      this.lifecycleEpoch === lifecycleEpoch &&
      this.currentSession.state === "suspended";
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
    if (!resumeStillCurrent()) {
      this.audio.setOutputAudible(false);
      return;
    }
    const pendingMaxSourceMute = this.maxSourceMuteInFlight;
    if (pendingMaxSourceMute !== null && pendingMaxSourceMute.generation === generation) {
      await pendingMaxSourceMute.promise;
      if (!resumeStillCurrent()) {
        this.audio.setOutputAudible(false);
        await ensureMuted();
        return;
      }
    }
    if (this.applyPendingInterlocutorLanguage()) {
      try {
        await this.live.appendInstructions(buildSteering(this.languages), {
          kind: "later_steering", sessionState: this.currentSession.state,
        });
      } catch (error) {
        if (!resumeStillCurrent()) return;
        this.failLifecycleResume(error);
        throw error;
      }
      if (!resumeStillCurrent()) return;
    }
    try {
      if (!(await this.unmuteGateB(generation))) {
        this.audio.setOutputAudible(false);
        return;
      }
    } catch (error) {
      if (!resumeStillCurrent()) {
        return;
      }
      this.audio.setOutputAudible(false);
      this.failLifecycleResume(error);
      throw error;
    }
    if (!resumeStillCurrent()) {
      this.audio.setOutputAudible(false);
      await ensureMuted();
      return;
    }
    try {
      this.audio.setCaptureEnabled(true);
    } catch (error) {
      if (!resumeStillCurrent()) {
        return;
      }
      this.audio.setOutputAudible(false);
      this.closeGateAForSafety("Gate A close failed after Gate A restore failure");
      await ensureMuted();
      if (!resumeStillCurrent()) {
        return;
      }
      this.failLifecycleResume(error);
      throw error;
    }
    if (!resumeStillCurrent()) {
      this.audio.setOutputAudible(false);
      await ensureMuted();
      return;
    }
    this.audio.setOutputAudible(true);
    this.recoveryPromptKind = undefined;
    this.speechInputReady = true;
    this.dispatch({ type: "RESUME" });
  }

  endConversation(): Promise<void> { return this.runTerminalBoundary("end"); }

  private async runTerminalBoundary(kind: "end" | "cancel"): Promise<void> {
    const existing = this.endWork ?? this.cancelWork;
    if (existing !== null) return existing;
    let resolve!: () => void, reject!: (error: unknown) => void;
    const work = new Promise<void>((ok, fail) => { resolve = ok; reject = fail; });
    // Publish the shared operation before synchronous UI observers can re-enter End/cancel.
    if (kind === "end") this.endWork = work; else this.cancelWork = work;
    if (this.retainedResumeInFlight) {
      this.sessionGeneration++;
      this.bumpLifecycleEpoch();
      this.stopLocalMedia();
      void this.live.disconnectImmediately(kind === "end" ? "user_end" : "cancelled")
        .catch(() => console.error("Retained transport cleanup incomplete"));
    }
    const retire = () => kind === "end" ? this.runEndConversation() : this.runCancel();
    const operation = this.backgroundPaused && this.backgroundCloseWork
      ? this.backgroundCloseWork.catch(() => undefined).then(retire) : retire();
    void operation.then(resolve, reject);
    try { await work; }
    finally {
      if (this.endWork === work) this.endWork = null;
      if (this.cancelWork === work) this.cancelWork = null;
      this.notify();
    }
  }

  async acceptBootstrap(text: string): Promise<void> {
    if (this.backgroundPaused) return;
    if (this.bootstrapAccepting) return;
    if (this.currentSession.state !== "bootstrap" || !this.capturingBootstrap) {
      throw new Error("Сначала запишите образец речи.");
    }
    const language = detectLanguage(text, 20);
    if (language === undefined || language === this.currentSession.participantA.language) {
      this.ownerErrorMessage = language === undefined
        ? "Не удалось уверенно определить язык. Произнесите полное предложение на своём языке."
        : "Распознан тот же язык, что у A. Участнику B нужно говорить на своём, другом языке.";
      this.notify();
      return;
    }
    const side = this.bootstrapSide;
    const generation = this.sessionGeneration;
    this.bootstrapAccepting = true;
    this.capturingBootstrap = false;
    this.ownerErrorMessage = undefined;
    this.notify();
    try {
      this.audio.setCaptureEnabled(false);
      if (!(await this.muteGateB(generation))) return;
      const key = side === "A" ? "participantA" : "participantB";
      this.currentSession = {
        ...this.currentSession,
        [key]: { ...this.currentSession[key], language },
      };
      this.bootstrapBuffer = "";
      this.armIdleTimer("bootstrap");
    } catch (error) {
      if (this.sessionGeneration !== generation) return;
      this.ownerErrorMessage = "Не удалось сохранить образец. Запишите его ещё раз.";
      console.error("Language sample boundary failed", { error });
    } finally {
      if (this.sessionGeneration === generation) {
        this.bootstrapAccepting = false;
        this.notify();
      }
    }
  }

  async beginInterpreter(): Promise<void> {
    if (this.backgroundPaused) return;
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

  private traceBeginInterpreterCancelled(generation: number): void {
    traceBeginInterpreter("session.beginInterpreter.cancelled", {
      generation,
      currentGeneration: this.sessionGeneration,
      state: this.currentSession.state,
      enteredInterpreter: this.enteredInterpreter,
      gateCOpen: this.enteredInterpreter,
      interpreterInFlight: this.interpreterInFlight,
    });
  }

  private async runBeginInterpreter(): Promise<void> {
    const generation = this.sessionGeneration;
    traceBeginInterpreter("session.beginInterpreter.start", {
      generation,
      state: this.currentSession.state,
      enteredInterpreter: this.enteredInterpreter,
      gateCOpen: this.enteredInterpreter,
      interpreterInFlight: this.interpreterInFlight,
    });
    if (this.currentSession.state !== "bootstrap") {
      throw new Error(`Cannot begin interpreter from "${this.currentSession.state}"`);
    }

    const languages = this.languages;
    const live = this.live;
    this.interpreterInFlight = true;
    this.ownerErrorMessage = undefined;
    this.notify();
    try {
      const edited = this.contextBuffer.trim();
      if (edited.length > 0 && !this.authoritativeContextSent) {
        const payload = buildAuthoritativeContext(edited);
        this.assertStartupAppendWithinBudget(payload);
        try {
          await live.appendThinking(payload, {
            kind: "startup_interpreter",
            startupGeneration: generation,
            startupState: this.currentSession.state,
            startupStage: "authoritative_context",
          });
        } catch (error) {
          if (this.sessionGeneration !== generation) {
            this.traceBeginInterpreterCancelled(generation);
            return;
          }
          this.failStartupAppend("Authoritative context append failed", error);
        }
        if (this.sessionGeneration !== generation) {
          this.traceBeginInterpreterCancelled(generation);
          return;
        }
        this.authoritativeContextSent = true;
      }

      try {
        await live.appendInstructions(buildInterpreterInstructions(languages), {
          kind: "startup_interpreter",
          startupGeneration: generation,
          startupState: this.currentSession.state,
          startupStage: "interpreter_contract",
        });
      } catch (error) {
        if (this.sessionGeneration !== generation) {
          this.traceBeginInterpreterCancelled(generation);
          return;
        }
        this.failStartupAppend("BEGIN_INTERPRETER_MODE append failed", error);
      }
      if (this.sessionGeneration !== generation) {
        this.traceBeginInterpreterCancelled(generation);
        return;
      }

      try {
        await live.appendInstructions(
          buildSteering(languages),
          {
            kind: "first_steering",
            sessionState: this.currentSession.state,
            startupGeneration: generation,
            startupState: this.currentSession.state,
            startupStage: "first_steering",
          },
        );
      } catch (error) {
        if (this.sessionGeneration !== generation) {
          this.traceBeginInterpreterCancelled(generation);
          return;
        }
        this.failStartupAppend("First steering append failed", error);
      }
      if (this.sessionGeneration !== generation) {
        this.traceBeginInterpreterCancelled(generation);
        return;
      }

      try {
        if (!(await this.unmuteGateB(generation))) return;
        this.audio.resetVoiceActivityBaseline();
        this.audio.setCaptureEnabled(true);
      } catch (error) {
        if (this.sessionGeneration !== generation) return;
        this.failStartup("Failed to reopen input after language setup", error);
      }
      this.clearIdleTimer();
      this.capturingBootstrap = false;
      this.audio.setOutputAudible(true);
      this.enteredInterpreter = true;
      this.speechInputReady = true;
      this.dispatch({ type: "INTERPRETER_READY" });
      traceBeginInterpreter("session.interpreter_ready", {
        generation,
        state: this.currentSession.state,
        enteredInterpreter: this.enteredInterpreter,
        gateCOpen: true,
        interpreterInFlight: this.interpreterInFlight,
      });
      await this.startPlatformLifecycle();
    } catch (error) {
      traceBeginInterpreter("session.beginInterpreter.failure", {
        generation,
        currentGeneration: this.sessionGeneration,
        state: this.currentSession.state,
        enteredInterpreter: this.enteredInterpreter,
        gateCOpen: this.enteredInterpreter,
        interpreterInFlight: this.interpreterInFlight,
        errorType: traceAckErrorType(error),
      });
      throw error;
    } finally {
      if (this.sessionGeneration === generation) {
        this.interpreterInFlight = false;
        traceBeginInterpreter("session.beginInterpreter.finish", {
          generation,
          currentGeneration: this.sessionGeneration,
          state: this.currentSession.state,
          enteredInterpreter: this.enteredInterpreter,
          gateCOpen: this.enteredInterpreter,
          interpreterInFlight: this.interpreterInFlight,
        });
        this.notify();
      }
    }
  }

  cancel(): Promise<void> { return this.runTerminalBoundary("cancel"); }

  private async runCancel(): Promise<void> {
    const pendingConnect = this.connectWork;
    const shouldWaitForMic =
      pendingConnect !== null && !this.hasConnected && !this.liveConnectStarted;
    const generation = this.sessionGeneration;
    traceBeginInterpreter("session.cancel", {
      generation,
      currentGeneration: generation + 1,
      state: this.currentSession.state,
      enteredInterpreter: this.enteredInterpreter,
      gateCOpen: this.enteredInterpreter,
      interpreterInFlight: this.interpreterInFlight,
    });
    this.sessionGeneration += 1;
    this.clearIdleTimer();
    this.clearMaxSessionTimer();
    this.clearTurnEngineTimers();
    this.capturingContext = false;
    this.capturingBootstrap = false;
    this.speechInputReady = false;
    this.stopLocalMedia();
    const prepared = this.prepareConversationRetirement("setup_cancel").catch(() => {
      console.error("Cancellation intent storage degraded; retirement will retry cleanup");
    });
    this.notify();
    if (this.hasConnected || this.liveConnectStarted) {
      try {
        const retiring = this.retiringLiveClose;
        await this.live.close("cancelled");
        await retiring;
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
    await prepared;
    try { await this.finishConversationRetirement("setup_cancel"); }
    finally { this.resetToIdle(); }
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
    this.stopLocalMedia();
    const prepared = this.prepareConversationRetirement("user_end").catch(() => {
      console.error("End intent storage degraded; retirement will retry cleanup");
    });
    this.dispatch({ type: "END" });
    let closeResult: { finalized: boolean };
    let retiringResult: { finalized: boolean } | null;
    try {
      const retiring = this.retiringLiveClose;
      closeResult = await this.live.close();
      retiringResult = retiring ? await retiring : null;
    } catch (error) {
      console.error("Live session close failed", {
        error,
        state: this.currentSession.state,
      });
      throw error;
    }
    const finalized = closeResult.finalized || retiringResult?.finalized === true;
    if (!finalized) {
      this.ownerErrorMessage = INCOMPLETE_FINALIZATION_MESSAGE;
      this.notify();
    }
    if (this.audio.getCaptureStream() !== null) {
      this.audio.stopCapture();
    }
    await prepared;
    try { await this.finishConversationRetirement("user_end"); }
    finally { this.resetToIdle({ preserveOwnerError: !finalized }); }
  }

  /** Saves recovery intent without holding open local media or finalizing its usage producer. */
  protected async prepareConversationRetirement(reason: "user_end" | "setup_cancel"): Promise<void> { void reason; }

  /** Runs after local retirement, before a fresh controller can use the next accounting scope. */
  protected async finishConversationRetirement(reason: "user_end" | "setup_cancel"): Promise<void> { void reason; }

  private stopLocalMedia(): void {
    if (this.audio.getCaptureStream() !== null) this.audio.setCaptureEnabled(false);
    this.audio.setOutputAudible(false);
    this.detachRemotePlayback();
    if (this.audio.getCaptureStream() !== null) this.audio.stopCapture();
  }

  private detachRemotePlayback(): void {
    this.resetRemotePlaybackTracking();
    this.audio.detachRemoteStream?.();
    this.audio.audioElement.srcObject = null;
  }

  private get audio(): SessionControllerDeps["audio"] {
    return this.deps.audio;
  }

  private bindLive(): void {
    const live = this.live;
    const generation = this.sessionGeneration;
    this.liveProductGeneration = generation;
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
      this.providerStartedObservedAt = Date.now();
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
    this.audio.onPlaybackBufferError = () => {
      this.audio.setOutputAudible(false);
      const message = "Не удалось сохранить звук перевода. Начните новый разговор.";
      void this.endConversation().catch(() => undefined).then(() => {
        this.ownerErrorMessage = message;
        this.notify();
      });
    };
    this.audio.onSourceSample = sample => this.observeMetrics(undefined, sample);
    this.audio.onVoiceActivity = (event) => {
      void this.handleVoiceActivity(event);
    };
    this.audio.onPlaybackActivity = (event) => {
      void this.handlePlaybackActivity(event);
    };
    this.audio.onRemoteAudioSample = event => {
      if (this.backgroundPaused) return;
      if (event.active && this.currentSession.state === "suspended" && this.lifecycleSuspendReason !== undefined &&
          !this.leftoverOutputDraining) this.beginLeftoverOutputDrain();
      if (!this.leftoverOutputDraining) return;
      this.leftoverRawIdleObserved = !event.active;
      this.maybeFinishLeftoverOutputDrain();
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
    if (!event.delta || !["listening", "outputting"].includes(this.currentSession.state) || this.turnClosing) return;
    const fragment = createTranscriptFragment({ text: event.delta, nowMs: Date.now(), startMs: event.start_ms, endMs: event.end_ms });
    this.dialogueTranscript.push("input", fragment, this.languages);
    this.notify();
    const active = this.currentSession.activeTurn;
    const activeStart = earliestFragmentStart(active?.sourceFragments);
    const currentSide = fragment.startMs === undefined || activeStart === undefined || fragment.startMs >= activeStart
      ? active?.speaker : undefined;
    this.routeSource(this.sourceRouter.push(fragment, this.languages, currentSide, currentSide ? active?.originalText : undefined));
    const generation = this.sessionGeneration;
    const epoch = this.lifecycleEpoch;
    if (this.sourceFragmentTimer !== null) window.clearTimeout(this.sourceFragmentTimer);
    this.sourceFragmentTimer = window.setTimeout(() => {
      this.sourceFragmentTimer = null;
      if (generation !== this.sessionGeneration || epoch !== this.lifecycleEpoch ||
          !["listening", "outputting"].includes(this.currentSession.state)) return;
      this.routeSource(this.sourceRouter.flush(this.languages));
      void this.considerTurnCompletion(Date.now());
    }, runtime.captionIdleMs);
  }

  private routeSource(groups: RoutedTranscript[], considerCompletion = true): void {
    // A language-evidence group can contain packets from different source intervals.
    for (const { side, first } of groups.flatMap(group => group.fragments.map(first => ({ side: group.side, first })))) {
      const historical = this.findSourceTarget(first, side);
      if (historical) {
        if (historical.id === this.currentSession.activeTurn?.id && /\p{L}/u.test(first.text) &&
            (this.resumedSourceIdle?.observedThroughMs === undefined || first.startMs === undefined || (first.endMs ?? first.startMs) > this.resumedSourceIdle.observedThroughMs)) {
          this.resumedSourceIdle = undefined;
        }
        this.extendSourceOpening(historical, first);
        this.dispatch({ type: "SOURCE_TARGETED_FRAGMENT", turnId: historical.id, fragment: first });
        continue;
      }
      let active = this.currentSession.activeTurn;
      if (earliestFragmentStart(active?.sourceFragments) === undefined) this.closePreviousSourceInterval(first);
      const playback = this.playbackTurnId ? findSessionTurn(this.currentSession, this.playbackTurnId) : undefined;
      if (side !== undefined && playback?.speaker !== undefined && side !== playback.speaker &&
          !playback.audioOutputInterrupted && !["completed", "failed", "discarded"].includes(playback.status)) {
        this.dispatch({ type: "AUDIO_INTERRUPTED", turnId: playback.id, nowMs: Date.now() });
      }
      if (!active) {
        if (!this.speechInputReady) continue;
        this.speechInputReady = false;
        this.dispatch({ type: "SOURCE_ACTIVE", turnId: crypto.randomUUID(), speaker: side,
          sideSource: side ? "language" : "unresolved", fragment: first, languageRouted: true });
        this.armMaxSourceTimer();
      } else if ((active.speaker !== undefined || active.originalText.length > 0) && active.speaker !== side &&
                 !(side === undefined && active.originalText === "" && active.sideSource === "translation")) {
        const id = crypto.randomUUID();
        const previousIdleAtMs = this.resumedSourceIdle?.turnId === active.id ? this.resumedSourceIdle.atMs : undefined;
        this.resumedSourceIdle = undefined;
        this.dispatch({ type: "SOURCE_HANDOFF", turnId: id, speaker: side, fragment: first, nowMs: Date.now(), previousIdleAtMs, languageRouted: true });
        this.armMaxSourceTimer();
      } else {
        this.resumedSourceIdle = undefined;
        this.dispatch({ type: "SOURCE_FRAGMENT", fragment: first, speaker: side, languageRouted: true });
      }
      active = this.currentSession.activeTurn;
      if (active) {
        this.routingTurnIds.add(active.id);
        if (this.sourceVoiceActive === false && active.sourceIdleAtMs === undefined) {
          this.dispatch({ type: "SOURCE_IDLE" });
          this.clearMaxSourceTimer();
          this.speechInputReady = true;
        }
      }
    }
    if (considerCompletion) void this.considerTurnCompletion(Date.now());
  }

  private routingTurns(): Turn[] {
    return [...this.currentSession.recentTurns, ...(this.currentSession.pendingTurns ?? []),
      ...(this.currentSession.activeTurn ? [this.currentSession.activeTurn] : [])]
      .filter(turn => this.routingTurnIds.has(turn.id) && turn.status !== "discarded");
  }

  private findSourceTarget(fragment: TranscriptFragment, side?: Side): Turn | undefined {
    const neutral = !/\p{L}/u.test(fragment.text);
    if (fragment.startMs === undefined || (side === undefined && !neutral)) return undefined;
    const sources = this.routingTurns().filter(turn => !turn.translationOnly && earliestFragmentStart(turn.sourceFragments) !== undefined)
      .sort((a, b) => earliestFragmentStart(a.sourceFragments)! - earliestFragmentStart(b.sourceFragments)!);
    const preceding = sources.findLast(turn => earliestFragmentStart(turn.sourceFragments)! <= fragment.startMs!);
    if (neutral) {
      // Neutral packets cannot inherit language from later buffered speech.
      // Only known source timing can establish historical ownership; a new or
      // untimed prefix stays on the normal path with its accompanying speech.
      if (!preceding || (preceding.sourceEndMs !== undefined && fragment.startMs >= preceding.sourceEndMs)) return undefined;
      const observedEnd = Math.max(...preceding.sourceFragments.map(part => part.endMs ?? part.startMs ?? -Infinity));
      // The gap before a later source can also contain that source's delayed
      // opening. Extend beyond observed audio only with matching language evidence.
      const intervalEnd = side !== undefined && side === preceding.speaker ? preceding.sourceEndMs ?? observedEnd : observedEnd;
      return (fragment.endMs ?? fragment.startMs) <= intervalEnd ? preceding : undefined;
    }
    // Fresh speech, whether VAD- or transcript-first, must claim forward packets before a retired,
    // open-ended interval can mistake it for a correction. Overlapping timestamps
    // and intervals already bounded by another source still route historically.
    if (preceding && ["completed", "failed"].includes(preceding.status) && preceding.sourceEndMs === undefined) {
      const lastEnd = Math.max(...preceding.sourceFragments.map(part => part.endMs ?? part.startMs ?? -Infinity));
      if (fragment.startMs > lastEnd) return undefined;
    }
    if (preceding && preceding.speaker === side &&
        (preceding.sourceEndMs === undefined || fragment.startMs < preceding.sourceEndMs)) return preceding;
    // The first packet is not necessarily the opening. An earlier packet in the next
    // speaker's language extends that source, rather than contaminating the preceding one.
    const following = sources.find(turn => earliestFragmentStart(turn.sourceFragments)! > fragment.startMs!);
    return following?.speaker === side ? following : undefined;
  }

  private extendSourceOpening(target: Turn, fragment: TranscriptFragment): void {
    const start = earliestFragmentStart(target.sourceFragments);
    if (fragment.startMs === undefined || start === undefined || fragment.startMs >= start) return;
    const preceding = this.routingTurns().filter(turn => !turn.translationOnly && turn.id !== target.id &&
      earliestFragmentStart(turn.sourceFragments) !== undefined && earliestFragmentStart(turn.sourceFragments)! < start)
      .sort((a, b) => earliestFragmentStart(b.sourceFragments)! - earliestFragmentStart(a.sourceFragments)!)[0];
    if (preceding && earliestFragmentStart(preceding.sourceFragments)! < fragment.startMs) {
      this.dispatch({ type: "SOURCE_BOUNDARY", turnId: preceding.id, endMs: fragment.startMs });
    }
  }

  private closePreviousSourceInterval(fragment: TranscriptFragment): void {
    if (fragment.startMs === undefined) return;
    const previous = this.routingTurns().filter(turn => !turn.translationOnly && turn.sourceEndMs === undefined &&
      turn.sourceFragments.some(part => part.startMs !== undefined && part.startMs < fragment.startMs!))
      .sort((a, b) => (earliestFragmentStart(b.sourceFragments) ?? 0) - (earliestFragmentStart(a.sourceFragments) ?? 0))[0];
    if (previous) this.dispatch({ type: "SOURCE_BOUNDARY", turnId: previous.id, endMs: fragment.startMs });
  }

  private handleConversationOutputDelta(event: TranscriptDeltaEvent): void {
    if (!event.delta || !["listening", "outputting"].includes(this.currentSession.state)) return;
    if (this.leftoverOutputDraining) { this.noteLeftoverCaption(); return; }
    const fragment = createTranscriptFragment({ text: event.delta, nowMs: Date.now(), startMs: event.start_ms, endMs: event.end_ms });
    this.dialogueTranscript.push("output", fragment, this.languages);
    this.notify();
    if (!this.outputRouter.hasPending && /^[\p{P}\s]+$/u.test(fragment.text)) {
      this.routeOutput([{ side: undefined, fragments: [fragment] }]);
    } else {
      const continuation = this.outputTurnId ? findSessionTurn(this.currentSession, this.outputTurnId) : undefined;
      const start = earliestFragmentStart(continuation?.outputFragments);
      // Retired output and older packets cannot supply context for a new translation.
      const hasContext = continuation && !["completed", "failed", "discarded"].includes(continuation.status) &&
        (this.outputSourceTurnId === this.latestSourceTurnId) &&
        (fragment.startMs === undefined || start === undefined || fragment.startMs >= start);
      const side = hasContext ? (continuation.speaker === "A" ? "B" : continuation.speaker === "B" ? "A" : undefined) : undefined;
      this.routeOutput(this.outputRouter.push(fragment, this.languages, side, hasContext ? continuation.translatedText : undefined));
    }
    const generation = this.sessionGeneration;
    const epoch = this.lifecycleEpoch;
    if (this.outputFragmentTimer !== null) window.clearTimeout(this.outputFragmentTimer);
    this.outputFragmentTimer = window.setTimeout(() => {
      this.outputFragmentTimer = null;
      if (generation !== this.sessionGeneration || epoch !== this.lifecycleEpoch ||
          !["listening", "outputting"].includes(this.currentSession.state)) return;
      this.routeOutput(this.outputRouter.flush(this.languages));
      this.lastOutputSide = undefined;
      void this.considerTurnCompletion(Date.now());
    }, runtime.captionIdleMs);
  }

  private routeOutput(groups: RoutedTranscript[], considerCompletion = true): void {
    for (const { side, fragments } of groups) {
      const speaker = side === "A" ? "B" : side === "B" ? "A" : undefined;
      const turns = this.routingTurns();
      const continuation = this.outputTurnId ? findSessionTurn(this.currentSession, this.outputTurnId) : undefined;
      const candidates = speaker === undefined ? [] : turns.filter(turn => !turn.translationOnly &&
        (turn.speaker === speaker || turn.speaker === undefined));
      let target = candidates.length === 1 && candidates[0]?.status !== "failed" ? candidates[0] : undefined;
      if (fragments.every(fragment => /^[\p{P}\s]+$/u.test(fragment.text))) target = this.findOutputContinuation(fragments);
      if (!target && continuation?.translationOnly && continuation.status !== "completed" &&
          continuation.speaker === speaker && this.outputSourceTurnId === this.latestSourceTurnId) target = continuation;
      for (const fragment of fragments) {
        if (target) this.dispatch({ type: "OUTPUT_DELTA", turnId: target.id, text: fragment.text,
          nowMs: fragment.receivedAtMs, fragment, speaker: speaker ?? target.speaker, languageRouted: true });
        else {
          const turnId = crypto.randomUUID();
          this.dispatch({ type: "OUTPUT_STANDALONE", turnId, speaker, text: fragment.text,
            nowMs: fragment.receivedAtMs, fragment });
          this.routingTurnIds.add(turnId);
          target = findSessionTurn(this.currentSession, turnId);
        }
      }
      if (target) {
        this.outputTurnId = target.id;
        this.audio.setPlaybackTurn?.(target.id);
        this.outputSourceTurnId = target.translationOnly ? this.latestSourceTurnId : target.id;
      }
      this.lastOutputSide = side;
    }
    this.armCaptionIdleTimer();
    if (considerCompletion) void this.considerTurnCompletion(Date.now());
  }

  private findOutputContinuation(fragments: TranscriptFragment[]): Turn | undefined {
    const eligible = this.routingTurns().filter(turn => turn.speaker !== undefined && turn.status !== "failed");
    if (fragments.every(fragment => fragment.startMs !== undefined)) {
      const candidates = eligible.filter(turn => {
        const starts = (turn.outputFragments ?? []).flatMap(fragment => fragment.startMs === undefined ? [] : [fragment.startMs]);
        const ends = (turn.outputFragments ?? []).flatMap(fragment => {
          const timestamp = fragment.endMs ?? fragment.startMs;
          return timestamp === undefined ? [] : [timestamp];
        });
        return starts.length > 0 && ends.length > 0 && fragments.every(fragment =>
          fragment.startMs! >= Math.min(...starts) && fragment.startMs! <= Math.max(...ends));
      });
      return candidates.length === 1 ? candidates[0] : undefined;
    }
    return this.lastOutputSide === undefined ? undefined : eligible.find(turn => turn.id === this.outputTurnId &&
      turn.speaker !== this.lastOutputSide);
  }

  private async handleVoiceActivity(event: AudioActivityEvent): Promise<void> {
    if (this.backgroundPaused || this.turnClosing ||
        !["listening", "outputting"].includes(this.currentSession.state)) return;
    this.sourceVoiceActive = event.active;
    if (event.active) {
      if (this.playbackActive) this.conversationMetrics.recordVamFalseActive();
      this.recoveryPromptKind = undefined;
      this.clearCompletionTimer();
      const active = this.currentSession.activeTurn;
      if (!active || (active.speaker === undefined && active.originalText.length > 0 && active.sourceIdleAtMs !== undefined)) {
        if (!this.speechInputReady) return;
        this.speechInputReady = false;
        if (active) this.dispatch({ type: "SOURCE_HANDOFF", turnId: crypto.randomUUID(), speaker: undefined, nowMs: event.atMs });
        else this.dispatch({ type: "SOURCE_ACTIVE", turnId: crypto.randomUUID(), speaker: undefined, sideSource: "unresolved" });
        this.routingTurnIds.add(this.currentSession.activeTurn!.id);
        this.armMaxSourceTimer();
      } else {
        if (active.sourceIdleAtMs !== undefined && this.resumedSourceIdle?.turnId !== active.id) {
          const observed = active.sourceFragments.flatMap(part => {
            const timestamp = part.endMs ?? part.startMs;
            return timestamp === undefined ? [] : [timestamp];
          });
          this.resumedSourceIdle = { turnId: active.id, atMs: active.sourceIdleAtMs,
            observedThroughMs: observed.length ? Math.max(...observed) : undefined };
        }
        this.dispatch({ type: "SOURCE_ACTIVE", turnId: active.id, speaker: active.speaker, sideSource: active.sideSource });
        if (active.sourceIdleAtMs !== undefined) this.armMaxSourceTimer();
      }
      await this.considerTurnCompletion(Date.now());
      return;
    }
    if (!this.currentSession.activeTurn) return;
    this.clearMaxSourceTimer();
    this.dispatch({ type: "SOURCE_IDLE" });
    this.speechInputReady = true;
    // GPT-Live must hear the next speaker, including interruptions during its output.
    await this.considerTurnCompletion(Date.now());
  }

  private async handlePlaybackActivity(event: PlaybackActivityEvent, considerCompletion = true): Promise<void> {
    if (this.backgroundPaused) return;
    if (!this.acceptRemotePlaybackActivity(event)) {
      return;
    }
    this.playbackActive = event.active;
    if (event.retired) {
      this.playbackTurnId = undefined;
      this.maybeFinishLeftoverOutputDrain();
      return;
    }
    if (this.leftoverOutputDraining) {
      if (!event.active) {
        this.maybeFinishLeftoverOutputDrain();
      }
      return;
    }
    if (this.currentSession.state !== "listening" && this.currentSession.state !== "outputting") {
      return;
    }
    if (event.active) {
      const turns = [...(this.currentSession.pendingTurns ?? []), ...(this.currentSession.activeTurn ? [this.currentSession.activeTurn] : [])];
      const target = event.owned
        ? (event.turnId ? findSessionTurn(this.currentSession, event.turnId) : undefined)
        : (this.outputTurnId ? findSessionTurn(this.currentSession, this.outputTurnId) : undefined) ?? (turns.length === 1 ? turns[0] : undefined);
      const previous = this.playbackTurnId ? findSessionTurn(this.currentSession, this.playbackTurnId) : undefined;
      if (event.owned && previous && previous.id !== target?.id && !["completed", "failed", "discarded"].includes(previous.status)) {
        this.dispatch({ type: "PLAYBACK_ENDED", nowMs: event.atMs, turnId: previous.id });
      }
      if (!target || ["completed", "failed", "discarded"].includes(target.status) ||
          (!event.owned && this.outputTurnId !== undefined && this.outputSourceTurnId !== this.latestSourceTurnId)) {
        // A previous source's caption does not identify newly starting audio.
        this.playbackTurnId = undefined;
        return;
      }
      this.playbackTurnId = target.id;
      this.dispatch({ type: "AUDIO_STARTED", nowMs: event.atMs, turnId: target.id });
      if (considerCompletion && event.owned && previous?.id !== target.id) await this.considerTurnCompletion(Date.now());
      return;
    }
    const target = this.playbackTurnId ? findSessionTurn(this.currentSession, this.playbackTurnId) : undefined;
    if (target && target.status !== "completed" && target.status !== "failed" && target.status !== "discarded") {
      this.dispatch({ type: "PLAYBACK_ENDED", nowMs: event.atMs, turnId: target.id });
    }
    this.playbackTurnId = undefined;
    if (considerCompletion) await this.considerTurnCompletion(Date.now());
  }

  private async considerTurnCompletion(nowMs: number): Promise<void> {
    if (this.turnClosing || !["listening", "outputting"].includes(this.currentSession.state)) return;
    const playback = this.playbackTurnId ? findSessionTurn(this.currentSession, this.playbackTurnId) : undefined;
    if (this.playbackActive && (!playback || ["completed", "failed", "discarded"].includes(playback.status))) {
      // Audio before its caption is not silence. Wait for the idle edge rather
      // than inventing an owner or closing text-only turns under playing audio.
      this.clearCompletionTimer();
      return;
    }
    if (this.audio.hasPendingPlayback) {
      this.armCompletionTimer(nowMs + 50, nowMs);
      return;
    }
    const turns = [...(this.currentSession.pendingTurns ?? []), ...(this.currentSession.activeTurn ? [this.currentSession.activeTurn] : [])];
    let retryAtMs: number | undefined;
    for (const turn of turns) {
      const decision = evaluateTurnCompletion(buildTurnCompletionSnapshot({ turn,
        playbackActive: this.playbackActive && this.playbackTurnId === turn.id, nowMs }), nowMs);
      if (decision.kind === "continue") {
        if (decision.retryAtMs !== undefined) retryAtMs = Math.min(retryAtMs ?? Infinity, decision.retryAtMs);
        continue;
      }
      if (this.currentSession.activeTurn?.id === turn.id) this.clearMaxSourceTimer();
      if (decision.kind === "complete") this.closeCompletedTurn(turn);
      else this.failTurnNoOutput(turn);
    }
    this.armCompletionTimer(retryAtMs, nowMs);
    if (this.pendingInterlocutorLanguage && !this.currentSession.activeTurn && !(this.currentSession.pendingTurns?.length)) {
      if (this.sourceRouter.hasPending || this.outputRouter.hasPending) {
        // Gate B still uses the current pair. Preserve pending text before replacement
        // resets the routers; an unresolved caption is not an empty conversation.
        this.speechInputReady = true;
        this.flushTranscriptBuffers();
        await this.considerTurnCompletion(nowMs);
        return;
      }
      const language = this.pendingInterlocutorLanguage;
      await this.changeInterlocutorLanguage(language).catch(error => console.error("Language change after turn failed", { error }));
    }
  }

  private closeCompletedTurn(turn: Turn): void {
    const replacingLanguage = this.pendingInterlocutorLanguage !== undefined &&
      (!this.currentSession.activeTurn || this.currentSession.activeTurn.id === turn.id) &&
      !(this.currentSession.pendingTurns?.some(pending => pending.id !== turn.id));
    this.speechInputReady = !replacingLanguage;
    this.dispatch({ type: "TURN_CLOSED", turnId: turn.id, speaker: turn.speaker });
    if (!turn.translationOnly && turn.sourceIdleAtMs !== undefined && turn.firstOutputTextAtMs !== undefined) {
      this.conversationMetrics.recordTurn({ sourceIdleAtMs: turn.sourceIdleAtMs,
        firstOutputTextAtMs: turn.firstOutputTextAtMs, firstAudibleOutputAtMs: turn.firstAudibleOutputAtMs,
        playbackEndAtMs: turn.playbackEndAtMs, turnCompletedAtMs: Date.now(), listeningRestoredAtMs: Date.now(),
        audioOutputStarted: turn.audioOutputStarted && !turn.audioOutputInterrupted });
    }
    this.notify();
  }

  private failTurnNoOutput(turn: Turn): void {
    const replacingLanguage = this.pendingInterlocutorLanguage !== undefined &&
      (!this.currentSession.activeTurn || this.currentSession.activeTurn.id === turn.id) &&
      !(this.currentSession.pendingTurns?.some(pending => pending.id !== turn.id));
    this.speechInputReady = !replacingLanguage;
    if (!turn.translationOnly) this.conversationMetrics.recordNoOutputWatchdog();
    this.dispatch({ type: "TURN_FAILED", turnId: turn.id });
    const independentOutput = this.routingTurns().some(output => output.translationOnly && output.translatedText &&
      (output.speechStartAtMs ?? 0) >= (turn.speechStartAtMs ?? 0) && output.speaker === turn.speaker);
    if (!independentOutput && !this.currentSession.activeTurn && !(this.currentSession.pendingTurns?.length)) {
      this.recoveryPromptKind = "repeat";
      this.turnFailurePrompt = true;
    }
    this.notify();
  }

  private applyPendingInterlocutorLanguage(): boolean {
    const language = this.pendingInterlocutorLanguage;
    if (language === undefined) return false;
    this.pendingInterlocutorLanguage = undefined;
    this.currentSession = {
      ...this.currentSession,
      participantB: { ...this.currentSession.participantB, language },
    };
    this.notify();
    return true;
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
      if (!this.closeGateAForSafety("Gate A close failed during source timeout")) {
        this.audio.setOutputAudible(false);
        this.ownerErrorMessage = MICROPHONE_CAPTURE_ENDED_MESSAGE;
        this.dispatch({
          type: "SESSION_ERROR",
          message: this.ownerErrorMessage,
        });
        return;
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

  private closeGateAForSafety(logMessage: string): boolean {
    try {
      this.audio.setCaptureEnabled(false);
      return true;
    } catch (error) {
      console.error(logMessage, { error, state: this.currentSession.state });
    }
    return this.forceCaptureTracksDisabled();
  }

  private forceCaptureTracksDisabled(): boolean {
    try {
      const stream = this.audio.getCaptureStream();
      if (stream === null) {
        return false;
      }
      let disabledAny = false;
      for (const track of stream.getAudioTracks()) {
        track.enabled = false;
        disabledAny = true;
      }
      return disabledAny;
    } catch (error) {
      console.error("Gate A force-off failed", { error, state: this.currentSession.state });
      return false;
    }
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
    // An attached raw analyser must confirm idle after the gate closes, even if played PCM was held.
    this.leftoverRawIdleObserved = this.audio.rawPlaybackActive === undefined;
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
    if (!this.leftoverOutputDraining || !this.leftoverCaptionIdle || this.playbackActive ||
        this.audio.rawPlaybackActive || !this.leftoverRawIdleObserved) {
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

  private finishLeftoverOutputDrain(): void {
    this.leftoverOutputDraining = false;
    this.leftoverCaptionIdle = true;
    this.leftoverRawIdleObserved = true;
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
    if (!this.leftoverOutputDraining && !this.playbackActive && !this.audio.rawPlaybackActive) {
      return Promise.resolve();
    }
    if (!this.leftoverOutputDraining) {
      this.beginLeftoverOutputDrain();
    }
    return new Promise((resolve) => {
      this.leftoverDrainWaiters.push(resolve);
      if (!this.leftoverOutputDraining && !this.playbackActive && !this.audio.rawPlaybackActive) {
        this.resolveLeftoverDrainWaiters();
      }
    });
  }

  private clearTurnEngineTimers(): void {
    this.clearMaxSourceTimer();
    this.clearCompletionTimer();
    this.clearCaptionIdleTimer();
    this.clearLeftoverDrainTimer();
    this.resetTranscriptRouting();
  }

  private resetTranscriptRouting(): void {
    this.dialogueTranscript.seal();
    if (this.sourceFragmentTimer !== null) window.clearTimeout(this.sourceFragmentTimer);
    if (this.outputFragmentTimer !== null) window.clearTimeout(this.outputFragmentTimer);
    this.sourceFragmentTimer = null;
    this.outputFragmentTimer = null;
    this.sourceRouter.reset();
    this.outputRouter.reset();
    this.routingTurnIds.clear();
    this.outputTurnId = undefined;
    this.audio.setPlaybackTurn?.(undefined);
    this.outputSourceTurnId = undefined;
    this.latestSourceTurnId = undefined;
    this.lastOutputSide = undefined;
    this.sourceVoiceActive = undefined;
    this.resumedSourceIdle = undefined;
  }

  private flushTranscriptBuffers(): void {
    if (!["listening", "outputting"].includes(this.currentSession.state)) return;
    const source = this.sourceRouter.flush(this.languages, true);
    const output = this.outputRouter.flush(this.languages, true);
    this.routeSource(source, false);
    this.routeOutput(output, false);
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

  private async restartBootstrapLiveConnection(generation: number): Promise<boolean> {
    const previousLive = this.live;
    const replacementLive = this.deps.createLive();

    // Close local capture before swapping Live clients. Once this.live points
    // at the replacement, bindLive()'s identity guard rejects every event that
    // can still arrive from the previous data channel.
    this.capturingBootstrap = false;
    this.bootstrapBuffer = "";
    this.audio.setCaptureEnabled(false);
    this.audio.setOutputAudible(false);
    this.clearMaxSessionTimer();
    this.resetRemotePlaybackTracking();
    this.audio.detachRemoteStream?.();
    this.audio.audioElement.srcObject = null;

    this.live = replacementLive;
    this.hasConnected = false;
    this.liveConnectStarted = true;
    this.gateBMuted = false;
    this.bindLive();
    const retiring = previousLive.close("replacement");
    this.retiringLiveClose = retiring;
    this.notify();
    try { await retiring; }
    finally { if (this.retiringLiveClose === retiring) this.retiringLiveClose = null; }

    if (this.sessionGeneration !== generation) {
      await replacementLive.disconnectImmediately();
      return false;
    }

    const stream = this.audio.getCaptureStream();
    if (stream === null) {
      this.failOwnerRequest(
        "Microphone capture failed while restarting language sample",
        new Error("Microphone capture stream is missing"),
      );
    }
    try {
      this.assertCaptureStreamLive(stream);
    } catch (error) {
      this.failMicrophoneCapture(error);
    }

    try {
      await replacementLive.connect(stream);
    } catch (error) {
      if (
        this.sessionGeneration !== generation ||
        this.live !== replacementLive
      ) {
        return false;
      }
      console.error("Live reconnect failed before language sample", {
        error,
        state: this.currentSession.state,
      });
      this.ownerErrorMessage = STARTUP_ERROR_MESSAGE;
      this.dispatch({
        type: "SESSION_ERROR",
        message: this.ownerErrorMessage,
      });
      throw error;
    }

    if (
      this.sessionGeneration !== generation ||
      this.live !== replacementLive
    ) {
      await replacementLive.disconnectImmediately();
      return false;
    }

    this.hasConnected = true;
    return true;
  }

  private async ensureConnected(primedOutput?: Promise<void>): Promise<void> {
    const live = this.live;
    const generation = this.sessionGeneration;
    try {
      await (primedOutput ?? this.audio.primeOutput());
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
    this.audio.setCaptureEnabled(false);
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
      this.ownerErrorMessage = STARTUP_ERROR_MESSAGE;
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

  private async runStartContextCapture(primedOutput?: Promise<void>): Promise<void> {
    const generation = this.sessionGeneration;
    this.ownerErrorMessage = undefined;
    this.connectInFlight = true;
    this.notify();
    try {
      await this.ensureConnected(primedOutput);
      if (this.sessionGeneration !== generation) {
        return;
      }
      if (this.currentSession.state === "idle") {
        return;
      }
      this.audio.setCaptureEnabled(true);
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

  private async runStartBootstrap(primedOutput?: Promise<void>): Promise<void> {
    const generation = this.sessionGeneration;
    this.ownerErrorMessage = undefined;
    this.connectInFlight = true;
    this.notify();
    try {
      await this.ensureConnected(primedOutput);
      if (this.sessionGeneration !== generation) {
        return;
      }
      if (this.currentSession.state === "idle") {
        return;
      }
      this.finishContextCapture();
      if (this.languagesReady) return;

      // Every sample after the first gets a fresh Live/WebRTC transport.
      // Transcript events do not carry a sample/attempt id, so reconnecting is
      // the only strict boundary that prevents a delayed event from the old
      // data channel from contaminating the next sample.
      if (this.currentSession.state === "bootstrap" && !this.freshBootstrapReady) {
        if (!(await this.restartBootstrapLiveConnection(generation))) return;
      }
      this.freshBootstrapReady = false;

      this.bootstrapBuffer = "";
      if (!(await this.unmuteGateB(generation))) return;
      if (this.sessionGeneration !== generation) return;
      this.audio.setCaptureEnabled(true);
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
      if (this.backgroundPaused && this.retainedResumeInFlight) this.retainedResumeCaptureEnded = true;
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
    this.ownerErrorMessage =
      error instanceof Error && error.message === MICROPHONE_CAPTURE_ENDED_MESSAGE
        ? MICROPHONE_CAPTURE_ENDED_MESSAGE
        : STARTUP_ERROR_MESSAGE;
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
    this.freshBootstrapReady = false;
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
    }, this.retainedProductDeadlineAt === null ? runtime.maxSessionMs :
      Math.max(0, this.retainedProductDeadlineAt - Date.now()));
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
    if (!this.earlyVisibilityStarted) this.visibility.start();
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
    if (!this.earlyVisibilityStarted) this.visibility.stop();
    void this.wakeLock.release();
    this.platformStarted = false;
    this.lifecycleSuspendReason = undefined;
    this.discardedUnfinishedOnSuspend = false;
    this.bumpLifecycleEpoch();
  }

  private conversationCanSuspend(): boolean {
    const state = this.currentSession.state;
    return state === "listening" || state === "outputting";
  }

  private async handleOrientationChange(orientation: "portrait" | "landscape"): Promise<void> {
    if (this.backgroundPaused) {
      if (orientation === "landscape" && this.retainedResumeInFlight) {
        this.sessionGeneration++;
        this.stopLocalMedia();
        void this.live.disconnectImmediately("abandoned_connect").catch(() => console.error("Resume cleanup incomplete"));
      } else if (orientation === "portrait" && !this.visibility.isHidden()) void this.handleVisibilityVisible();
      return;
    }
    if (orientation === "landscape") {
      this.bumpLifecycleEpoch();
      await this.enqueueLifecycle(() => this.suspendFromLifecycle("orientation"));
      return;
    }
    await this.enqueueLifecycle(() => this.resumeFromLifecycle());
  }

  protected applyHiddenBackgroundClose(): Promise<void> { return this.handleVisibilityHidden(); }
  private async handleVisibilityHidden(): Promise<void> {
    if (this.backgroundCloseEnabled) {
      if (this.backgroundPaused) {
        if (this.retainedResumeInFlight) {
          this.sessionGeneration++;
          this.bumpLifecycleEpoch();
          this.stopLocalMedia();
          void this.live.disconnectImmediately("hidden").catch(() => console.error("Resume cleanup incomplete"));
        }
        return;
      }
      if (this.endWork !== null || this.cancelWork !== null) return;
      this.flushTranscriptBuffers();
      this.backgroundPaused = true;
      this.beginBackgroundPause();
      let resolveClose!: () => void;
      let rejectClose!: (error: unknown) => void;
      this.backgroundCloseWork = new Promise<void>((resolve, reject) => {
        resolveClose = resolve; rejectClose = reject;
      });
      const state = this.currentSession;
      const hadLive = this.hasConnected || this.liveConnectStarted;
      const hiddenAt = Date.now();
      const counters: MetricCounters = {};
      const retained = {
        participantA: { language: state.participantA.language, hasAcceptedConversationSpeech: state.participantA.hasAcceptedConversationSpeech },
        participantB: { language: this.selectedInterlocutorLanguage, hasAcceptedConversationSpeech: state.participantB.hasAcceptedConversationSpeech },
        contextText: this.capturingContext ? "" : this.contextBuffer,
        setupStage: (this.enteredInterpreter ? "interpreter" : state.state === "bootstrap" ? "bootstrap" : "context") as ResumeSnapshotInput["setupStage"],
        enteredInterpreter: this.enteredInterpreter,
        interruptedUtterance: (state.activeTurn !== undefined && state.activeTurn.turnCompletedAtMs === undefined) ||
          Boolean(state.pendingTurns?.some(turn => !turn.translationOnly)),
        counters,
      };
      this.sessionGeneration += 1;
      this.bumpLifecycleEpoch();
      this.clearIdleTimer(); this.clearMaxSessionTimer(); this.clearTurnEngineTimers();
      this.capturingContext = false; this.capturingBootstrap = false; this.bootstrapAccepting = false;
      this.speechInputReady = false; this.turnClosing = false; this.recoveryPromptKind = undefined;
      try { this.stopLocalMedia(); }
      catch (error) {
        console.error("Background local media stop failed", { error });
        this.closeGateAForSafety("Background Gate A close failed");
        try { this.audio.setOutputAudible(false); } catch { /* Provider close still proceeds. */ }
        try { this.audio.audioElement.srcObject = null; } catch { /* Provider close still proceeds. */ }
        try { this.audio.stopCapture(); } catch { /* Disabled tracks remain the safety boundary. */ }
      }
      if (this.platformStarted) this.stopPlatformLifecycle();
      if (!["idle", "ended", "ending", "error", "suspended"].includes(state.state)) this.dispatch({ type: "SUSPEND" });
      else if (state.state === "suspended") this.notify();
      this.currentSession = { ...this.currentSession, activeTurn: undefined };
      const snapshot = this.conversationMetrics.snapshot();
      for (const name of COUNTER_NAMES) if (name in snapshot) counters[name] = snapshot[name as keyof typeof snapshot] as number;
      this.lifecycleSuspendReason = "visibility";
      this.authoritativeContextSent = false;
      this.gateBMuted = false;
      this.hasConnected = false; this.liveConnectStarted = false;
      try {
        const close = !hadLive && state.state === "idle" ? Promise.resolve() : this.live.close("hidden");
        void this.pauseBackground(retained, hiddenAt, close).then(resolveClose, rejectClose);
      } catch (error) { rejectClose(error); }
      try { await this.backgroundCloseWork; }
      catch (error) { console.error("Background pause incomplete", { error }); }
      return;
    }
    this.bumpLifecycleEpoch();
    await this.enqueueLifecycle(() => this.suspendFromLifecycle("visibility"));
  }

  private async handleVisibilityVisible(): Promise<void> {
    if (this.backgroundPaused) {
      if (this.retainedResumeInFlight) { this.visibleAgainDuringResume = true; return; }
      this.beginRetainedResume();
      try { await this.resumeBackground(); }
      finally { this.finishRetainedResume(); }
      return;
    }
    await this.enqueueLifecycle(async () => {
      await this.wakeLock.reacquire();
      await this.resumeFromLifecycle();
    });
  }

  private async handleAudioInterruption(): Promise<void> {
    if (this.backgroundPaused) return;
    this.bumpLifecycleEpoch();
    await this.enqueueLifecycle(() => this.suspendFromLifecycle("audio"));
  }

  private async handleAudioRestored(): Promise<void> {
    if (this.backgroundPaused) return;
    await this.enqueueLifecycle(async () => {
      await this.wakeLock.reacquire();
      await this.resumeFromLifecycle();
    });
  }

  private handleCaptureEnded(): void {
    if (this.backgroundPaused) {
      if (this.retainedResumeInFlight) {
        this.retainedResumeCaptureEnded = true;
        this.sessionGeneration++;
        this.bumpLifecycleEpoch();
        this.stopLocalMedia();
        void this.live.disconnectImmediately("abandoned_connect").catch(() => console.error("Resume cleanup incomplete"));
      }
      return;
    }
    const state = this.currentSession.state;
    if (state === "idle" || state === "ending" || state === "ended" || state === "error") {
      return;
    }
    const live = this.live;
    const shouldCloseLive = this.hasConnected || this.liveConnectStarted;

    this.sessionGeneration += 1;
    this.clearIdleTimer();
    this.clearMaxSessionTimer();
    this.retainedProductDeadlineAt = null;
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
    this.resetTranscriptRouting();
  }

  private async suspendFromLifecycle(reason: LifecycleSuspendReason): Promise<void> {
    if (this.backgroundPaused) return;
    if (this.currentSession.state === "suspended") {
      if (this.recoveryPromptKind !== "resume-repeat") {
        this.lifecycleSuspendReason = reason;
      }
      this.notify();
      return;
    }
    if (!this.conversationCanSuspend()) {
      return;
    }
    this.flushTranscriptBuffers();
    const generation = this.sessionGeneration;
    const active = this.currentSession.activeTurn;
    this.speechInputReady = false;
    this.discardedUnfinishedOnSuspend =
      (active !== undefined && active.turnCompletedAtMs === undefined) ||
      Boolean(this.currentSession.pendingTurns?.some(turn => !turn.translationOnly));
    this.clearTurnEngineTimersKeepingLeftoverDrain();
    this.turnClosing = false;
    if ((this.audio.rawPlaybackActive !== undefined || this.playbackActive || this.audio.hasPendingPlayback) && !this.leftoverOutputDraining) {
      this.beginLeftoverOutputDrain();
    }
    try {
      this.audio.setCaptureEnabled(false);
    } catch (error) {
      this.ownerErrorMessage = CONNECTION_ERROR_MESSAGE;
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
    if (this.backgroundPaused) return;
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

    this.applyPendingInterlocutorLanguage();
    const session = this.currentSession;
    const generation = this.sessionGeneration;
    try {
      await this.live.appendInstructions(
        buildSteering(this.languages),
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
    await this.waitForLeftoverOutputIdle();
    if (this.sessionGeneration !== generation || this.lifecycleEpoch !== epoch || this.currentSession.state !== "suspended") {
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
    await this.waitForLeftoverOutputIdle();
    if (this.sessionGeneration !== generation || this.lifecycleEpoch !== epoch || this.currentSession.state !== "suspended") {
      this.audio.setOutputAudible(false);
      if (this.sessionGeneration !== generation || this.currentSession.state !== "suspended") {
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
    this.turnFailurePrompt = false;
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
    this.ownerErrorMessage = CONNECTION_ERROR_MESSAGE;
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
    this.nonInterruptingEnabled = false;
    this.audio.setNonInterrupting?.(false);
    this.retainedProductDeadlineAt = null;
    const preservedError =
      options.preserveOwnerError === true ? this.ownerErrorMessage : undefined;
    this.audio.setOutputAudible(false);
    this.audio.detachRemoteStream?.();
    this.audio.audioElement.srcObject = null;
    this.hasConnected = false;
    this.backgroundPaused = false;
    this.backgroundCloseWork = null;
    this.contextBuffer = "";
    this.bootstrapBuffer = "";
    this.ownerErrorMessage = preservedError;
    this.bootstrapAccepting = false;
    this.contextFrozenByUser = false;
    this.authoritativeContextSent = false;
    this.liveConnectStarted = false;
    this.connectInFlight = false;
    this.connectWork = null;
    this.interpreterInFlight = false;
    this.interpreterWork = null;
    this.gateBMuted = false;
    this.maxSourceMuteInFlight = null;
    this.sourceTimeoutResumeWork = null;
    this.playbackActive = false;
    this.resetRemotePlaybackTracking();
    this.turnClosing = false;
    this.speechInputReady = false;
    this.leftoverOutputDraining = false;
    this.leftoverCaptionIdle = true;
    this.resolveLeftoverDrainWaiters();
    this.recoveryPromptKind = undefined;
    this.steeringDegradedFlag = false;
    this.enteredInterpreter = false;
    this.pendingInterlocutorLanguage = undefined;
    this.conversationMetrics = new ConversationMetrics();
    this.clearTurnEngineTimers();
    this.clearMaxSessionTimer();
    this.stopPlatformLifecycle();
    this.sessionGeneration += 1;
    this.currentSession = createEmptySession();
    this.dialogueTranscript.clear();
    this.live = this.deps.createLive();
    this.bindLive();
    this.notify();
  }

  protected dispatch(action: SessionAction): void {
    if ((action.type === "SOURCE_ACTIVE" || action.type === "SOURCE_HANDOFF") &&
        action.turnId !== this.latestSourceTurnId && this.outputRouter.hasPending) {
      // Seal old evidence before changing its source context. Ambiguity is retained.
      this.routeOutput(this.outputRouter.flush(this.languages, true), false);
    }
    const previousTurn = "turnId" in action ? findSessionTurn(this.currentSession, action.turnId) : this.currentSession.activeTurn;
    const previousUnfinished = [...(this.currentSession.pendingTurns ?? []),
      ...(this.currentSession.activeTurn ? [this.currentSession.activeTurn] : [])];
    this.currentSession = sessionReducer(this.currentSession, action);
    if (action.type === "SESSION_ERROR" && this.currentSession.state === "error") {
      this.audio.setOutputAudible(false);
      this.detachRemotePlayback();
      if (this.audio.getCaptureStream() !== null) this.audio.stopCapture();
      this.finishLeftoverOutputDrain();
    }
    if (action.type === "SOURCE_ACTIVE" || action.type === "SOURCE_HANDOFF") this.latestSourceTurnId = action.turnId;
    let completedTurnId: string | undefined;
    if (previousTurn && !previousTurn.translationOnly && action.type === "TURN_CLOSED") {
      if (previousTurn.audioOutputStarted && !previousTurn.audioOutputInterrupted && previousTurn.playbackEndAtMs !== undefined && this.audio.audioElement.muted === false && this.remotePlaybackState === "ready") {
        if (this.conversationMetrics.recordTechnicalOutcome(previousTurn.id, "audio")) completedTurnId = previousTurn.id;
      } else if (previousTurn.translatedText) this.conversationMetrics.recordTechnicalOutcome(previousTurn.id, "text_only");
    }
    if (previousTurn && !previousTurn.translationOnly && action.type === "TURN_FAILED") this.conversationMetrics.recordTechnicalOutcome(previousTurn.id, "failed");
    if (["SUSPEND", "END", "SESSION_ERROR"].includes(action.type)) {
      for (const turn of previousUnfinished) if (!turn.translationOnly && turn.turnCompletedAtMs === undefined) {
        this.conversationMetrics.recordTechnicalOutcome(turn.id, action.type === "SESSION_ERROR" ? "failed" : "discarded");
      }
    }
    this.notify(completedTurnId);
  }

  /** Seed the new attempt before managed create so retained totals are a baseline, not a delta. */
  private publishRetainedCounterBaseline(): void {
    if (typeof this.live.observeProductMetrics !== "function") return;
    const counters: MetricCounters = {};
    const snapshot = this.conversationMetrics.snapshot();
    for (const name of COUNTER_NAMES) {
      const value = snapshot[name as keyof typeof snapshot];
      if (typeof value === "number") counters[name] = value;
    }
    try {
      this.live.observeProductMetrics({ atMs: performance.now(), visible: document.visibilityState !== "hidden" && !this.visibility.isHidden(),
        state: "connecting", interpreterReady: false, mediaReady: false, speechEligible: false, counters });
    } catch { console.error("Product measurement unavailable"); }
  }

  /** Observe facts only. These hooks never change product states, thresholds, or audio gates. */
  private observeMetrics(completedTurnId?: string, sample?: AudioActivityEvent & { reset?: boolean }): void {
    if (typeof this.live.observeProductMetrics !== "function") return;
    try {
      const track = this.audio.getCaptureStream()?.getAudioTracks()[0];
      const visible = document.visibilityState !== "hidden" && !this.visibility.isHidden();
      const mediaReady = this.hasConnected && this.remotePlaybackState === "ready" && track?.readyState === "live" &&
        this.live.peerConnectionState === "connected" && this.live.dataChannelReadyState === "open" && this.audio.meteringMediaReady !== false;
      const counters: MetricCounters = {}, snapshot = this.conversationMetrics.snapshot();
      for (const name of COUNTER_NAMES) if (name in snapshot) counters[name] = snapshot[name as keyof typeof snapshot] as number;
      this.live.observeProductMetrics({ atMs: sample?.atMs ?? performance.now(), visible, state: this.currentSession.state,
        interpreterReady: this.enteredInterpreter, mediaReady,
        speechEligible: visible && mediaReady && this.enteredInterpreter && ["listening", "outputting"].includes(this.currentSession.state) && track?.enabled === true && this.live.inputMeteringReady,
        counters, turnId: this.currentSession.activeTurn?.id, completedTurnId,
        ...(sample?.reset ? { resetSpeech: true } : sample ? { sample: { active: sample.active, atMs: sample.atMs } } : {}),
      });
    } catch { console.error("Product measurement unavailable"); }
  }

  protected notify(completedTurnId?: string): void {
    this.observeMetrics(completedTurnId);
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
        onRemoteStream: (stream, source) => {
          controller.handleRemoteStream(stream, source);
        },
      }),
    audio,
  });
  return controller;
}

function createEmptySession(): TranslationSession {
  return createInitialSession(
    { side: "A", hasAcceptedConversationSpeech: false },
    { side: "B", hasAcceptedConversationSpeech: false },
  );
}
