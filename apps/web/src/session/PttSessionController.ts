import type { AudioActivityEvent } from "../audio/VoiceActivityMonitor";
import { runtime } from "../config/runtime";
import { createTranscriptFragment } from "../conversation/TurnBuffer";
import type { TranscriptDeltaEvent } from "../live/LiveEvents";
import { PttSpeakerPolicy, type SpeakerInterval } from "../side/PttSpeakerPolicy";
import { SessionController } from "./SessionController";
import { findSessionTurn } from "./sessionReducer";

/** The experiment replaces only speaker routing; media, retirement and accounting stay shared. */
export class PttSessionController extends SessionController {
  private policy?: PttSpeakerPolicy;
  private holdTimer: number | null = null;
  private awaitingRelease = false;
  private notice?: string;

  private get speakers(): PttSpeakerPolicy {
    if (!this.policy || this.policy.generation !== this.sessionGeneration) this.policy = new PttSpeakerPolicy(this.sessionGeneration);
    return this.policy;
  }
  get pttHeld(): boolean { return this.policy?.held !== undefined; }
  get pttAwaitingRelease(): boolean { return this.awaitingRelease; }
  get pttNotice(): string | undefined { return this.notice; }
  get pttCanStart(): boolean {
    return this.hasEnteredInterpreter && !this.pttHeld && !this.awaitingRelease && !this.turnClosing && !this.gateBMuted &&
      ["listening", "outputting"].includes(this.session.state) && !this.audio.playbackInputBlocked &&
      this.audio.getCaptureStream()?.getAudioTracks()[0]?.enabled === true && typeof this.audio.setPlaybackHold === "function";
  }
  protected override get sourceHeld(): boolean { return this.pttHeld; }

  pressPtt(): boolean {
    if (!this.pttCanStart || !this.audio.setPlaybackHold?.(true)) return false;
    const interval = this.speakers.press(performance.now());
    if (!interval) { this.audio.setPlaybackHold?.(false); return false; }
    this.notice = undefined;
    this.clearMaxSourceTimer();
    if (this.session.activeTurn?.sourceIdleAtMs === undefined) this.dispatch({ type: "SOURCE_IDLE" });
    if (this.sourceVoiceActive) this.startInterval(this.speakers.speech(performance.now()));
    const generation = this.sessionGeneration;
    this.holdTimer = window.setTimeout(() => {
      this.holdTimer = null;
      if (generation !== this.sessionGeneration || this.speakers.held?.id !== interval.id) return;
      // Close capture before releasing playback; continued physical holding never becomes B.
      this.audio.setCaptureEnabled(false);
      this.sourceVoiceActive = false;
      this.audio.resetVoiceActivityBaseline?.();
      this.finishHold(true);
      this.awaitingRelease = true;
      this.notice = "Достигнут лимит 120 секунд. Отпустите кнопку и начните новую реплику.";
      this.notify();
    }, runtime.maxPttHoldMs);
    this.notify();
    return true;
  }

  releasePtt(interrupted = false): void {
    if (this.awaitingRelease) {
      this.awaitingRelease = false;
      if (["listening", "outputting"].includes(this.session.state) && !this.turnClosing && !this.gateBMuted)
        this.audio.setCaptureEnabled(true);
    }
    this.finishHold(interrupted);
    this.notify();
    void this.considerTurnCompletion(Date.now());
  }

  private finishHold(interrupted: boolean): void {
    if (this.holdTimer !== null) window.clearTimeout(this.holdTimer);
    this.holdTimer = null;
    const interval = this.policy?.release(performance.now());
    if (!interval) return;
    const turn = findSessionTurn(this.session, interval.id);
    if (turn) {
      if (interrupted) {
        this.dispatch({ type: "TURN_DISCARDED", turnId: interval.id });
        this.notice = "Реплика прервана. Повторите её, удерживая кнопку.";
      } else if (this.session.activeTurn?.id === interval.id) this.dispatch({ type: "SOURCE_IDLE" });
    }
    this.speechInputReady = true;
    this.audio.setPlaybackHold?.(false);
  }

  protected override resetSpeakerPolicy(): void {
    if (this.holdTimer !== null) window.clearTimeout(this.holdTimer);
    this.holdTimer = null;
    // A language change or same-transport pause cannot erase competing capture evidence.
    this.policy?.release(performance.now());
    this.policy?.finish(performance.now());
    this.awaitingRelease = false;
    this.notice = undefined;
    this.audio.setPlaybackHold?.(false);
  }

  protected override async handleVoiceActivity(event: AudioActivityEvent): Promise<void> {
    if (this.turnClosing || this.audio.playbackInputBlocked || this.awaitingRelease ||
        !["listening", "outputting"].includes(this.session.state) || this.gateBMuted) return;
    this.sourceVoiceActive = event.active;
    if (event.active) {
      this.recoveryPromptKind = undefined;
      const interval = this.speakers.speech(performance.now());
      if (!this.startInterval(interval) && !this.pttHeld && this.session.activeTurn?.id === interval.id &&
          this.session.activeTurn.sourceIdleAtMs !== undefined) {
        this.dispatch({ type: "SOURCE_ACTIVE", turnId: interval.id, speaker: "B", sideSource: "ptt-default", languageRouted: true });
        this.armMaxSourceTimer();
      }
    } else if (!this.pttHeld) {
      const interval = this.speakers.finish(performance.now());
      if (interval && this.session.activeTurn?.id === interval.id) this.dispatch({ type: "SOURCE_IDLE" });
      this.clearMaxSourceTimer();
      this.speechInputReady = true;
    }
    await this.considerTurnCompletion(Date.now());
  }

  private startInterval(interval: SpeakerInterval): boolean {
    if (findSessionTurn(this.session, interval.id)) return false;
    const sideSource = interval.side === "A" ? "ptt" : "ptt-default";
    if (this.session.activeTurn) this.dispatch({ type: "SOURCE_HANDOFF", turnId: interval.id,
      speaker: interval.side, sideSource, nowMs: Date.now(), languageRouted: true });
    else this.dispatch({ type: "SOURCE_ACTIVE", turnId: interval.id, speaker: interval.side, sideSource, languageRouted: true });
    this.speechInputReady = false;
    if (interval.side === "B") this.armMaxSourceTimer();
    return true;
  }

  protected override handleConversationInputDelta(event: TranscriptDeltaEvent): void {
    this.routePttTranscript("input", event);
  }
  protected override handleConversationOutputDelta(event: TranscriptDeltaEvent): void {
    this.routePttTranscript("output", event);
  }

  private routePttTranscript(kind: "input" | "output", event: TranscriptDeltaEvent): void {
    if (!event.delta || !["listening", "outputting"].includes(this.session.state) || this.turnClosing ||
        !this.speakers.accept(event.event_id, this.sessionGeneration)) return;
    const fragment = createTranscriptFragment({ text: event.delta, nowMs: Date.now(), startMs: event.start_ms, endMs: event.end_ms });
    const assignment = this.speakers.assign(kind, fragment);
    const interval = assignment.interval;
    if (kind === "input" && interval && !findSessionTurn(this.session, interval.id)) this.startInterval(interval);
    const turn = interval ? findSessionTurn(this.session, interval.id) : undefined;
    if (kind === "input" && turn && turn.status !== "discarded") {
      this.dispatch({ type: "SOURCE_TARGETED_FRAGMENT", turnId: turn.id, fragment });
      if (this.session.activeTurn?.id === turn.id && turn.sourceIdleAtMs === undefined && !this.pttHeld && (interval?.endedAtMs !== undefined || this.sourceVoiceActive !== true)) {
        this.dispatch({ type: "SOURCE_IDLE" });
        this.clearMaxSourceTimer();
        if (interval?.side === "B") this.speakers.finish(performance.now());
        this.speechInputReady = true;
      }
    }
    if (kind === "output") {
      if (turn && !["failed", "discarded"].includes(turn.status)) {
        this.dispatch({ type: "OUTPUT_DELTA", turnId: turn.id, text: fragment.text, fragment,
          nowMs: fragment.receivedAtMs, languageRouted: true });
        this.audio.setPlaybackTurn?.(turn.id);
      } else {
        this.dispatch({ type: "OUTPUT_STANDALONE", turnId: fragment.id, speaker: assignment.side,
          text: fragment.text, fragment, nowMs: fragment.receivedAtMs });
        this.audio.setPlaybackTurn?.(undefined);
      }
      this.armCaptionIdleTimer();
    }
    const side = kind === "input" ? assignment.side : assignment.side === "A" ? "B" : assignment.side === "B" ? "A" : undefined;
    const captionKey = interval?.id ?? `unpaired:${this.sessionGeneration}:${side ?? "unknown"}`;
    this.dialogueTranscript.pushAssigned(kind, fragment, turn?.languages ?? this.languages, captionKey, side);
    this.notify();
    void this.considerTurnCompletion(Date.now());
  }
}
