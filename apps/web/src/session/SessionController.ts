import { COUNTER_NAMES, type MetricCounters } from "../metrics/UsageTypes";
import { BackendClient } from "../api/BackendClient";
import { AudioController } from "../audio/AudioController";
import type { AudioActivityEvent } from "../audio/VoiceActivityMonitor";
import { runtime } from "../config/runtime";
import {
  buildTurnCompletionSnapshot,
  evaluateTurnCompletion,
} from "../conversation/TurnCompletion";
import { canAssignUnresolvedSource, createTranscriptFragment } from "../conversation/TurnBuffer";
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
  buildCorrectionCommentaryTrigger,
  buildCorrectionInstruction,
  buildInterpreterInstructions,
  buildSteering,
  buildUnfinishedTurnWarning,
} from "../live/LivePrompts";
import { traceAckErrorType, traceBeginInterpreter } from "../live/StartupTrace";
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
  private leftoverDrainWaiters: Array<() => void> = [];
  private lifecycleEpoch = 0;
  private lifecycleQueue: Promise<void> = Promise.resolve();
  private gateBMuted = false;
  private maxSourceMuteInFlight: { generation: number; promise: Promise<void> } | null = null;
  private sourceTimeoutResumeWork: Promise<void> | null = null;
  private playbackActive = false;
  private remotePlaybackGeneration = 0;
  private remotePlaybackState: RemotePlaybackState = "ready";
  private remotePlaybackWork: Promise<void> | null = null;
  private remotePlaybackTrack: MediaStreamTrack | null = null;
  private remoteTrackArrived: (() => void) | null = null;
  private retainedProductDeadlineAt: number | null = null;
  private retainedPlaybackCommitted = false;
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
  protected adoptRetainedPause(): void {
    if (this.backgroundPaused || this.currentSession.state !== "idle") return;
    this.sessionGeneration++;
    this.backgroundPaused = true;
    this.currentSession = { ...this.currentSession, state: "suspended" };
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
    const waitMs = Math.min(runtime.steeringAckTimeoutMs, (snapshot.localResumeDeadlineAt ?? 0) - Date.now(),
      (snapshot.serverResumeExpiresAt ?? 0) - Date.now(),
      (snapshot.productDeadlineAt ?? Infinity) - Date.now());
    if (waitMs <= 0) throw new Error("Remote playback deadline expired");
    let trackTimer: number | undefined;
    try {
      await Promise.race([remoteTrack.then(async () => {
        if (!current() || !this.remotePlaybackWork) throw new Error("Remote playback is unavailable");
        await this.remotePlaybackWork;
      }), new Promise<never>((_, reject) => {
        trackTimer = window.setTimeout(() => reject(new Error("Remote audio track unavailable")), waitMs);
      })]);
    } finally {
      if (trackTimer !== undefined) window.clearTimeout(trackTimer);
      this.remoteTrackArrived = null;
    }
    if (!current()) throw new Error("Resume cancelled");
    this.assertRemotePlaybackReady();
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
    this.assertCaptureStreamLive(stream);
    this.assertRemotePlaybackReady();
    this.retainedResumePhase = "complete";
    await complete(this.providerStartedObservedAt);
    if (!current() || Date.now() >= (snapshot.localResumeDeadlineAt ?? 0) ||
      Date.now() >= (snapshot.serverResumeExpiresAt ?? 0) ||
      (snapshot.productDeadlineAt !== null && Date.now() >= snapshot.productDeadlineAt))
      throw new Error("Resume cancelled after commit");
    this.assertCaptureStreamLive(stream);
    this.assertRemotePlaybackReady();
    this.contextBuffer = snapshot.contextText;
    this.contextFrozenByUser = true;
    this.bootstrapBuffer = "";
    this.currentSession = { state: snapshot.setupStage === "interpreter" ? "listening" : snapshot.setupStage === "bootstrap" ? "bootstrap" : "connecting",
      contextText: snapshot.contextText, recentTurns: [],
      participantA: { side: "A", ...snapshot.participantA }, participantB: { side: "B", ...snapshot.participantB } };
    this.enteredInterpreter = snapshot.enteredInterpreter;
    this.freshBootstrapReady = snapshot.setupStage === "bootstrap";
    this.hasConnected = true;
    this.retainedPlaybackCommitted = true;
    this.lifecycleSuspendReason = undefined;
    this.discardedUnfinishedOnSuspend = snapshot.interruptedUtterance;
    this.recoveryPromptKind = snapshot.interruptedUtterance ? "repeat" : undefined;
    if (snapshot.setupStage === "interpreter") {
      this.assertCaptureStreamLive(stream);
      this.assertRemotePlaybackReady();
      if (!(await this.unmuteGateB(generation)) || this.sessionGeneration !== generation || this.visibility.isHidden())
        throw new Error("Resume cancelled before input opened");
      this.assertCaptureStreamLive(stream);
      this.assertRemotePlaybackReady();
      this.audio.resetVoiceActivityBaseline();
      this.audio.setCaptureEnabled(true);
      this.assertRemotePlaybackReady();
      this.audio.setOutputAudible(true);
      this.speechInputReady = true;
      await this.startPlatformLifecycle();
    } else {
      this.assertCaptureStreamLive(stream);
      this.assertRemotePlaybackReady();
      if (!(await this.unmuteGateB(generation))) throw new Error("Resume cancelled before setup input opened");
      this.assertCaptureStreamLive(stream);
      this.assertRemotePlaybackReady();
    }
    if (!current()) throw new Error("Resume cancelled after commit");
    this.assertRemotePlaybackReady();
    this.backgroundPaused = false;
    this.backgroundCloseWork = null;
    this.notify();
  }
  private assertRemotePlaybackReady(): void {
    if (this.remotePlaybackState !== "ready" || this.remotePlaybackTrack?.readyState !== "live")
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

  handleRemoteStream(stream: MediaStream, source: LiveClient): void {
    // Validate origin BEFORE attaching. A generation captured after a stale callback is too late.
    if (source !== this.live || this.liveProductGeneration !== this.sessionGeneration) return;
    const track = stream.getAudioTracks().find(track => track.readyState === "live");
    if (!track || this.remotePlaybackTrack) return;
    this.remotePlaybackTrack = track;
    const sessionGeneration = this.sessionGeneration;
    const playbackGeneration = this.remotePlaybackGeneration + 1;
    this.remotePlaybackGeneration = playbackGeneration;
    this.remotePlaybackState = "pending";
    this.pendingRemotePlaybackActivity = null;
    track.addEventListener("ended", () => {
      if (this.remotePlaybackTrack === track) this.failRemotePlayback(source, sessionGeneration, playbackGeneration,
        new Error("Remote audio track ended"));
    }, { once: true });
    this.audio.attachRemoteStream(stream);
    this.remotePlaybackWork = this.audio.audioElement
      .play()
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
        this.pendingRemotePlaybackActivity = null;
        if (pending?.active === true) {
          void this.handlePlaybackActivity(pending);
        }
      })
      .catch((error: unknown) => {
        if (
          source !== this.live || this.sessionGeneration !== sessionGeneration ||
          this.remotePlaybackGeneration !== playbackGeneration
        ) {
          return;
        }
        this.failRemotePlayback(source, sessionGeneration, playbackGeneration, error);
      });
    this.remoteTrackArrived?.();
  }

  private failRemotePlayback(source: LiveClient, sessionGeneration: number, playbackGeneration: number, error: unknown): void {
    if (source !== this.live || this.sessionGeneration !== sessionGeneration ||
      this.remotePlaybackGeneration !== playbackGeneration || this.remotePlaybackState === "failed") return;
    this.remotePlaybackState = "failed";
    this.pendingRemotePlaybackActivity = null;
    if (this.playbackActive) { this.playbackActive = false; this.finishPlaybackIdleWait(); }
    console.error("Remote audio playback failed", { error });
    if (this.retainedPlaybackCommitted) {
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
    this.remoteTrackArrived?.();
    this.remoteTrackArrived = null;
    this.retainedPlaybackCommitted = false;
    this.remotePlaybackGeneration += 1;
    this.remotePlaybackState = "ready";
    this.remotePlaybackWork = null;
    this.remotePlaybackTrack = null;
    this.pendingRemotePlaybackActivity = null;
    if (this.playbackActive) {
      this.playbackActive = false;
      this.finishPlaybackIdleWait();
    }
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

  private latestCorrectableTurn(): Turn | undefined {
    const session = this.currentSession;
    if (session.state !== "outputting" && session.state !== "listening") {
      return undefined;
    }
    if (session.activeTurn !== undefined) {
      if (canAssignUnresolvedSource(session.activeTurn)) return session.activeTurn;
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
    if (canAssignUnresolvedSource(latest)) return latest;
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
    this.recoveryPromptKind = undefined;
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
      if (this.currentSession.activeTurn?.sourceIdleAtMs === undefined) this.armMaxSourceTimer();
      this.conversationMetrics.recordCorrectionSuccess();
      this.correctionEpoch += 1;
      this.gateCHeldForCorrectionEpoch = this.correctionEpoch;
    } catch (error) {
      if (this.sessionGeneration !== generation) {
        return;
      }
      this.finishPlaybackIdleWait();
      this.ownerErrorMessage = CONNECTION_ERROR_MESSAGE;
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
    this.resetRemotePlaybackTracking();
    this.audio.audioElement.srcObject = null;
    if (this.audio.getCaptureStream() !== null) this.audio.stopCapture();
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
    this.audio.onSourceSample = sample => this.observeMetrics(undefined, sample);
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
    if (event.delta.length === 0) {
      return;
    }
    const fragment = createTranscriptFragment({
      text: event.delta,
      nowMs: Date.now(),
      startMs: event.start_ms,
      endMs: event.end_ms,
    });
    if (this.currentSession.state === "correcting") {
      const activeTurn = this.currentSession.activeTurn;
      if (activeTurn !== undefined && activeTurn.turnCompletedAtMs === undefined) {
        this.dispatch({ type: "CORRECTION_SOURCE_FRAGMENT", fragment });
      }
      return;
    }
    if (this.currentSession.state !== "listening" && this.currentSession.state !== "outputting") {
      return;
    }
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
        speaker: undefined,
        sideSource: "unresolved",
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
    if (this.backgroundPaused) return;
    if (this.turnClosing) {
      return;
    }
    if (this.currentSession.state === "correcting") {
      this.dispatch({ type: "CORRECTION_SOURCE_ACTIVITY", active: event.active });
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
          speaker: undefined,
          sideSource: "unresolved",
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
          } catch {
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
            this.ownerErrorMessage = CONNECTION_ERROR_MESSAGE;
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
    if (this.backgroundPaused) return;
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
    const generation = this.sessionGeneration;
    try {
      const result = await this.live.appendInstructions(
        buildSteering(this.languages),
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
      this.ownerErrorMessage = CONNECTION_ERROR_MESSAGE;
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
    } catch {
      if (this.sessionGeneration !== generation) {
        return;
      }
      this.speechInputReady = false;
      this.ownerErrorMessage = CONNECTION_ERROR_MESSAGE;
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
    } catch {
      if (this.sessionGeneration !== generation) {
        return;
      }
      this.speechInputReady = false;
      this.ownerErrorMessage = CONNECTION_ERROR_MESSAGE;
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
    return state === "listening" || state === "outputting" || state === "correcting";
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
        participantB: { language: state.participantB.language, hasAcceptedConversationSpeech: state.participantB.hasAcceptedConversationSpeech },
        contextText: this.capturingContext ? "" : this.contextBuffer,
        setupStage: (this.enteredInterpreter ? "interpreter" : state.state === "bootstrap" ? "bootstrap" : "context") as ResumeSnapshotInput["setupStage"],
        enteredInterpreter: this.enteredInterpreter,
        interruptedUtterance: state.activeTurn !== undefined && state.activeTurn.turnCompletedAtMs === undefined && !state.activeTurn.corrected,
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
      this.currentSession = { ...this.currentSession, recentTurns: [], activeTurn: undefined };
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
    this.finishPlaybackIdleWait();
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
    this.retainedProductDeadlineAt = null;
    const preservedError =
      options.preserveOwnerError === true ? this.ownerErrorMessage : undefined;
    this.audio.setOutputAudible(false);
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
    this.correctionEpoch = 0;
    this.gateCHeldForCorrectionEpoch = null;
    this.correctionWork = null;
    this.enteredInterpreter = false;
    this.conversationMetrics = new ConversationMetrics();
    this.finishPlaybackIdleWait();
    this.clearTurnEngineTimers();
    this.clearMaxSessionTimer();
    this.stopPlatformLifecycle();
    this.sessionGeneration += 1;
    this.currentSession = createEmptySession();
    this.live = this.deps.createLive();
    this.bindLive();
    this.notify();
  }

  protected dispatch(action: SessionAction): void {
    const previousTurn = this.currentSession.activeTurn;
    this.currentSession = sessionReducer(this.currentSession, action);
    let completedTurnId: string | undefined;
    if (action.type === "CORRECTION_START") this.conversationMetrics.recordCorrectionAttempt();
    if (previousTurn && action.type === "TURN_CLOSED") {
      if (previousTurn.audioOutputStarted && previousTurn.playbackEndAtMs !== undefined && this.audio.audioElement.muted === false && this.remotePlaybackState === "ready") {
        if (this.conversationMetrics.recordTechnicalOutcome(previousTurn.id, "audio")) completedTurnId = previousTurn.id;
      } else if (!previousTurn.audioOutputStarted) this.conversationMetrics.recordTechnicalOutcome(previousTurn.id, "text_only");
    }
    if (previousTurn && action.type === "TURN_FAILED") this.conversationMetrics.recordTechnicalOutcome(previousTurn.id, "failed");
    if (previousTurn && ["SUSPEND", "END", "SESSION_ERROR"].includes(action.type) && previousTurn.turnCompletedAtMs === undefined && !previousTurn.corrected) {
      this.conversationMetrics.recordTechnicalOutcome(previousTurn.id, action.type === "SESSION_ERROR" ? "failed" : "discarded");
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
