import type { TranscriptFragment } from "../conversation/TranscriptFragment";
import type { Side, Turn } from "../conversation/Turn";
import {
  appendOutputTextToTurn,
  appendSourceFragmentToTurn,
  clearSourceIdle,
  canAssignUnresolvedSource,
  completeTurn,
  createTurn,
  discardTurn,
  failTurn,
  markAudioOutputStarted,
  markOutputActive,
  markPlaybackEnded,
  markSourceIdle,
  pushRecentTurn,
  startFreshOutputEpoch,
} from "../conversation/TurnBuffer";
import { resolveSide } from "../side/SideResolver";
import type { SessionState, TranslationSession } from "./SessionState";

export type SessionAction =
  // Session lifecycle (§4.1: two valid entry flows).
  | { type: "CONNECT" }
  | { type: "CONTEXT_READY" }
  | { type: "SKIP_CONTEXT" }
  | { type: "BOOTSTRAP_READY" }
  | { type: "INTERPRETER_READY" }
  // Main conversation flow (§11.1).
  | {
      type: "SOURCE_ACTIVE";
      turnId: string;
      speaker: Side | undefined;
      sideSource: Turn["sideSource"];
      fragment?: TranscriptFragment;
    }
  | { type: "SOURCE_FRAGMENT"; fragment: TranscriptFragment }
  | { type: "SOURCE_IDLE" }
  | { type: "OUTPUT_ACTIVE" }
  | { type: "OUTPUT_DELTA"; text: string; nowMs: number }
  | { type: "AUDIO_STARTED"; nowMs: number }
  | { type: "PLAYBACK_ENDED"; nowMs: number }
  | { type: "OUTPUT_IDLE" }
  | { type: "TURN_CLOSED"; speaker: Side | undefined }
  | { type: "TURN_FAILED" }
  // Correction flow (§11.2).
  | { type: "CORRECTION_START" }
  | { type: "CORRECTION_SOURCE_ACTIVITY"; active: boolean }
  | { type: "CORRECTION_SOURCE_FRAGMENT"; fragment: TranscriptFragment }
  | { type: "CORRECTION_APPLIED"; speaker: Side }
  // Suspension flow (§11.3).
  | { type: "SUSPEND" }
  | { type: "RESUME" }
  // Errors and graceful end (§22, §23).
  | { type: "SESSION_ERROR"; message: string }
  | { type: "END" }
  | { type: "ENDED" };

function assertNever(value: never): never {
  throw new Error(`Unhandled session action: ${JSON.stringify(value)}`);
}

function requireActiveTurn(session: TranslationSession): Turn {
  if (session.activeTurn === undefined) {
    throw new Error("No active turn exists.");
  }
  return session.activeTurn;
}

const SOURCE_APPEND_BLOCKED_STATES: ReadonlySet<SessionState> = new Set([
  "correcting",
  "ending",
  "ended",
  "error",
  "suspended",
]);

function assertSourceAppendAllowed(session: TranslationSession): void {
  if (SOURCE_APPEND_BLOCKED_STATES.has(session.state)) {
    throw new Error(`Cannot accept source input while session state is "${session.state}".`);
  }
}

const TURN_CLOSE_BLOCKED_STATES: ReadonlySet<SessionState> = new Set([
  "error",
  "ended",
  "suspended",
  "correcting",
]);

function assertTurnCloseAllowed(session: TranslationSession): void {
  if (TURN_CLOSE_BLOCKED_STATES.has(session.state)) {
    throw new Error(`Cannot close or fail a turn while session state is "${session.state}".`);
  }
}

function assertFreshOutputEpoch(session: TranslationSession): void {
  if (session.state === "correcting") {
    throw new Error(`Cannot accept output or source-idle events while session state is "correcting".`);
  }
}

const OUTPUT_EVENT_BLOCKED_STATES: ReadonlySet<SessionState> = new Set([
  "error",
  "ended",
  "suspended",
  "correcting",
]);

function assertOutputEventAllowed(session: TranslationSession): void {
  if (OUTPUT_EVENT_BLOCKED_STATES.has(session.state)) {
    throw new Error(`Cannot accept output events while session state is "${session.state}".`);
  }
}

function isPreservedCompletedTarget(turn: Turn): boolean {
  return turn.turnCompletedAtMs !== undefined || turn.corrected;
}

function isRecentCorrectable(turn: Turn): boolean {
  return turn.status === "completed" || turn.status === "outputting" || canAssignUnresolvedSource(turn);
}

function withOutputtingIfListening(session: TranslationSession, activeTurn: Turn): TranslationSession {
  return {
    ...session,
    state: session.state === "listening" ? "outputting" : session.state,
    activeTurn,
  };
}

function transitionLifecycle(
  session: TranslationSession,
  from: SessionState,
  to: SessionState,
): TranslationSession {
  if (session.state !== from) {
    throw new Error(`Cannot transition to "${to}"; expected state "${from}" but session is "${session.state}".`);
  }
  return { ...session, state: to };
}

function handleSourceActive(
  session: TranslationSession,
  action: Extract<SessionAction, { type: "SOURCE_ACTIVE" }>,
): TranslationSession {
  assertSourceAppendAllowed(session);
  const { activeTurn } = session;

  if (activeTurn !== undefined) {
    if (activeTurn.speaker !== action.speaker) {
      throw new Error(
        `Cannot start a new active turn for speaker "${action.speaker}": speaker "${activeTurn.speaker}"'s ` +
          `turn ("${activeTurn.id}", status "${activeTurn.status}") has not been closed.`,
      );
    }
    const resumed = clearSourceIdle(activeTurn);
    const updated = action.fragment ? appendSourceFragmentToTurn(resumed, action.fragment) : resumed;
    return { ...session, activeTurn: updated };
  }

  if (session.state !== "listening") {
    throw new Error(`Cannot start a new source turn while session state is "${session.state}".`);
  }

  const created = createTurn({
    id: action.turnId,
    speaker: action.speaker,
    sideSource: action.sideSource,
    nowMs: Date.now(),
  });
  const withFragment = action.fragment ? appendSourceFragmentToTurn(created, action.fragment) : created;
  return { ...session, activeTurn: assignLanguageSide(session, withFragment) };
}

function assignLanguageSide(session: TranslationSession, turn: Turn): Turn {
  if (turn.sideSource === "manual") return turn;
  const A = session.participantA.language;
  const B = session.participantB.language;
  if (A === undefined || B === undefined) return turn;
  const speaker = resolveSide(turn.originalText, { A, B });
  return { ...turn, speaker, sideSource: speaker === undefined ? "unresolved" : "language" };
}

function handleSourceFragment(
  session: TranslationSession,
  action: Extract<SessionAction, { type: "SOURCE_FRAGMENT" }>,
): TranslationSession {
  assertSourceAppendAllowed(session);
  return { ...session, activeTurn: assignLanguageSide(session, appendSourceFragmentToTurn(requireActiveTurn(session), action.fragment)) };
}

function withAcceptedSpeech(
  session: TranslationSession,
  speaker: Side | undefined,
): TranslationSession {
  if (speaker === undefined) return session;
  if (speaker === "A") {
    return {
      ...session,
      participantA: { ...session.participantA, hasAcceptedConversationSpeech: true },
    };
  }
  return {
    ...session,
    participantB: { ...session.participantB, hasAcceptedConversationSpeech: true },
  };
}

function handleTurnClosed(
  session: TranslationSession,
  action: Extract<SessionAction, { type: "TURN_CLOSED" }>,
): TranslationSession {
  assertTurnCloseAllowed(session);
  const activeTurn = requireActiveTurn(session);
  if (activeTurn.speaker !== action.speaker) {
    throw new Error(
      `TURN_CLOSED speaker "${action.speaker}" does not match the active turn's speaker "${activeTurn.speaker}".`,
    );
  }

  const completed = completeTurn(activeTurn, Date.now());
  return withAcceptedSpeech(
    {
      ...session,
      // Drain while ending stays in ending; otherwise return to listening.
      state: session.state === "ending" ? "ending" : "listening",
      activeTurn: undefined,
      recentTurns: pushRecentTurn(session.recentTurns, completed),
      lastSpeaker: action.speaker,
    },
    action.speaker,
  );
}

function handleTurnFailed(session: TranslationSession): TranslationSession {
  assertTurnCloseAllowed(session);
  const activeTurn = requireActiveTurn(session);
  const failed = failTurn(activeTurn, Date.now());
  return {
    ...session,
    state: session.state === "ending" ? "ending" : "listening",
    activeTurn: undefined,
    recentTurns: pushRecentTurn(session.recentTurns, failed),
  };
}

function handleCorrectionStart(session: TranslationSession): TranslationSession {
  if (session.state !== "outputting" && session.state !== "listening") {
    throw new Error(`Cannot start a correction while session state is "${session.state}".`);
  }

  if (session.activeTurn !== undefined) {
    if (
      session.activeTurn.status === "failed" ||
      session.activeTurn.status === "discarded" ||
      (session.state === "listening" && session.activeTurn.status === "streaming" &&
        !canAssignUnresolvedSource(session.activeTurn))
    ) {
      throw new Error("Cannot start a correction: no correctable turn exists.");
    }
    return {
      ...session,
      state: "correcting",
      activeTurn: { ...session.activeTurn, status: "correcting" },
    };
  }

  const latest = session.recentTurns.at(-1);
  if (latest === undefined || !isRecentCorrectable(latest)) {
    throw new Error("Cannot start a correction: no correctable turn exists.");
  }

  return {
    ...session,
    state: "correcting",
    activeTurn: { ...latest, status: "correcting" },
    recentTurns: session.recentTurns.slice(0, -1),
  };
}

function handleCorrectionApplied(
  session: TranslationSession,
  action: Extract<SessionAction, { type: "CORRECTION_APPLIED" }>,
): TranslationSession {
  if (session.state !== "correcting") {
    throw new Error(`Cannot apply a correction while session state is "${session.state}"; expected "correcting".`);
  }
  if (session.activeTurn === undefined || session.activeTurn.status !== "correcting") {
    throw new Error("Cannot apply a correction: no active correcting turn exists.");
  }

  return {
    ...session,
    state: "outputting",
    activeTurn: startFreshOutputEpoch(session.activeTurn, action.speaker),
  };
}

function handleSuspend(session: TranslationSession): TranslationSession {
  if (
    session.state === "idle" ||
    session.state === "ended" ||
    session.state === "suspended" ||
    session.state === "error" ||
    session.state === "ending"
  ) {
    throw new Error(`Cannot suspend a session in state "${session.state}".`);
  }
  if (session.activeTurn === undefined) {
    return { ...session, state: "suspended" };
  }
  // §11.3 discards an unfinished source turn. A completed or already-corrected
  // utterance must return to recentTurns as completed, including after
  // CORRECTION_APPLIED (which clears turnCompletedAtMs for the fresh epoch).
  if (isPreservedCompletedTarget(session.activeTurn)) {
    return {
      ...session,
      state: "suspended",
      activeTurn: undefined,
      recentTurns: pushRecentTurn(session.recentTurns, { ...session.activeTurn, status: "completed" }),
    };
  }
  const discarded = discardTurn(session.activeTurn, Date.now());
  return {
    ...session,
    state: "suspended",
    activeTurn: undefined,
    recentTurns: pushRecentTurn(session.recentTurns, discarded),
  };
}

export function sessionReducer(session: TranslationSession, action: SessionAction): TranslationSession {
  switch (action.type) {
    case "CONNECT":
      return transitionLifecycle(session, "idle", "connecting");
    case "CONTEXT_READY":
      return transitionLifecycle(session, "connecting", "context");
    case "SKIP_CONTEXT":
      return transitionLifecycle(session, "connecting", "bootstrap");
    case "BOOTSTRAP_READY":
      return transitionLifecycle(session, "context", "bootstrap");
    case "INTERPRETER_READY":
      return transitionLifecycle(session, "bootstrap", "listening");

    case "SOURCE_ACTIVE":
      return handleSourceActive(session, action);
    case "SOURCE_FRAGMENT":
      return handleSourceFragment(session, action);
    case "SOURCE_IDLE":
      assertFreshOutputEpoch(session);
      if (session.activeTurn === undefined) {
        return session;
      }
      return { ...session, activeTurn: markSourceIdle(session.activeTurn, Date.now()) };
    case "OUTPUT_ACTIVE": {
      assertOutputEventAllowed(session);
      const updated = markOutputActive(requireActiveTurn(session));
      return withOutputtingIfListening(session, updated);
    }
    case "OUTPUT_DELTA": {
      assertOutputEventAllowed(session);
      const updated = appendOutputTextToTurn(requireActiveTurn(session), action.text, action.nowMs);
      return withOutputtingIfListening(session, updated);
    }
    case "AUDIO_STARTED": {
      assertOutputEventAllowed(session);
      const outputting = markOutputActive(requireActiveTurn(session));
      const updated = markAudioOutputStarted(outputting, action.nowMs);
      return withOutputtingIfListening(session, updated);
    }
    case "PLAYBACK_ENDED":
      assertOutputEventAllowed(session);
      return { ...session, activeTurn: markPlaybackEnded(requireActiveTurn(session), action.nowMs) };
    case "OUTPUT_IDLE":
      // Turn completion is handled separately from output inactivity.
      return session;
    case "TURN_CLOSED":
      return handleTurnClosed(session, action);
    case "TURN_FAILED":
      return handleTurnFailed(session);

    case "CORRECTION_START":
      return handleCorrectionStart(session);
    case "CORRECTION_SOURCE_ACTIVITY":
      if (session.state !== "correcting" || session.activeTurn === undefined) return session;
      return {
        ...session,
        activeTurn: action.active
          ? clearSourceIdle(session.activeTurn)
          : markSourceIdle(session.activeTurn, Date.now()),
      };
    case "CORRECTION_SOURCE_FRAGMENT":
      if (session.state !== "correcting" || session.activeTurn === undefined) return session;
      return {
        ...session,
        // Manual correction owns side assignment for this utterance. Preserve
        // transcript tail without re-running language routing mid-correction.
        activeTurn: appendSourceFragmentToTurn(session.activeTurn, action.fragment),
      };
    case "CORRECTION_APPLIED":
      return handleCorrectionApplied(session, action);

    case "SUSPEND":
      return handleSuspend(session);
    case "RESUME":
      return transitionLifecycle(session, "suspended", "listening");

    case "SESSION_ERROR":
      if (session.state === "ended") {
        throw new Error("Cannot error a session that has already ended.");
      }
      return { ...session, state: "error" };

    case "END":
      if (session.state === "idle" || session.state === "ended") {
        throw new Error(`Cannot end a session in state "${session.state}".`);
      }
      return { ...session, state: "ending" };
    case "ENDED":
      return transitionLifecycle(session, "ending", "ended");

    default:
      return assertNever(action);
  }
}
