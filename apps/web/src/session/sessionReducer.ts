import type { TranscriptFragment } from "../conversation/TranscriptFragment";
import type { Side, Turn } from "../conversation/Turn";
import {
  appendSourceFragmentToTurn,
  completeTurn,
  createTurn,
  discardTurn,
  failTurn,
  markOutputActive,
  markSourceIdle,
  pushRecentTurn,
} from "../conversation/TurnBuffer";
import { nextExpectedSpeaker } from "../side/SideResolver";
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
      speaker: Side;
      sideSource: Turn["sideSource"];
      fragment?: TranscriptFragment;
    }
  | { type: "SOURCE_FRAGMENT"; fragment: TranscriptFragment }
  | { type: "SOURCE_IDLE" }
  | { type: "OUTPUT_ACTIVE" }
  | { type: "OUTPUT_IDLE" }
  | { type: "TURN_CLOSED"; speaker: Side }
  | { type: "TURN_FAILED" }
  // Correction flow (§11.2).
  | { type: "CORRECTION_START" }
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
  const { activeTurn } = session;

  if (activeTurn !== undefined) {
    if (activeTurn.speaker !== action.speaker) {
      throw new Error(
        `Cannot start a new active turn for speaker "${action.speaker}": speaker "${activeTurn.speaker}"'s ` +
          `turn ("${activeTurn.id}", status "${activeTurn.status}") has not been closed.`,
      );
    }
    const updated = action.fragment ? appendSourceFragmentToTurn(activeTurn, action.fragment) : activeTurn;
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
  return { ...session, activeTurn: withFragment };
}

function handleTurnClosed(
  session: TranslationSession,
  action: Extract<SessionAction, { type: "TURN_CLOSED" }>,
): TranslationSession {
  const activeTurn = requireActiveTurn(session);
  if (activeTurn.speaker !== action.speaker) {
    throw new Error(
      `TURN_CLOSED speaker "${action.speaker}" does not match the active turn's speaker "${activeTurn.speaker}".`,
    );
  }

  const completed = completeTurn(activeTurn, Date.now());
  return {
    ...session,
    state: "listening",
    activeTurn: undefined,
    recentTurns: pushRecentTurn(session.recentTurns, completed),
    lastSpeaker: action.speaker,
    // Expected-alternation prior (§7.4): only advances once a turn actually closes.
    expectedSpeaker: nextExpectedSpeaker(action.speaker),
  };
}

function handleTurnFailed(session: TranslationSession): TranslationSession {
  const activeTurn = requireActiveTurn(session);
  const failed = failTurn(activeTurn, Date.now());
  return {
    ...session,
    state: "listening",
    activeTurn: undefined,
    recentTurns: pushRecentTurn(session.recentTurns, failed),
    // §10.3: keep expectedSpeaker on the same source side so they can repeat.
    expectedSpeaker: activeTurn.speaker,
  };
}

function handleCorrectionStart(session: TranslationSession): TranslationSession {
  if (session.state !== "outputting" && session.state !== "listening") {
    throw new Error(`Cannot start a correction while session state is "${session.state}".`);
  }
  const correctable = session.activeTurn ?? session.recentTurns.at(-1);
  if (correctable === undefined) {
    throw new Error("Cannot start a correction: no correctable turn exists.");
  }
  return {
    ...session,
    state: "correcting",
    activeTurn: session.activeTurn ? { ...session.activeTurn, status: "correcting" } : session.activeTurn,
  };
}

function handleCorrectionApplied(
  session: TranslationSession,
  action: Extract<SessionAction, { type: "CORRECTION_APPLIED" }>,
): TranslationSession {
  if (session.state !== "correcting") {
    throw new Error(`Cannot apply a correction while session state is "${session.state}"; expected "correcting".`);
  }

  if (session.activeTurn !== undefined) {
    const corrected: Turn = {
      ...session.activeTurn,
      speaker: action.speaker,
      sideSource: "manual",
      corrected: true,
      status: "outputting",
    };
    return { ...session, state: "outputting", activeTurn: corrected };
  }

  const lastTurn = session.recentTurns.at(-1);
  if (lastTurn === undefined) {
    throw new Error("Cannot apply a correction: no recent turn exists.");
  }
  const corrected: Turn = {
    ...lastTurn,
    speaker: action.speaker,
    sideSource: "manual",
    corrected: true,
    status: "outputting",
  };
  return {
    ...session,
    state: "outputting",
    activeTurn: corrected,
    recentTurns: session.recentTurns.slice(0, -1),
  };
}

function handleSuspend(session: TranslationSession): TranslationSession {
  if (session.state === "idle" || session.state === "ended" || session.state === "suspended") {
    throw new Error(`Cannot suspend a session in state "${session.state}".`);
  }
  if (session.activeTurn === undefined) {
    return { ...session, state: "suspended" };
  }
  // §11.3: an unfinished active turn is discarded, never silently resumed.
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
      return { ...session, activeTurn: appendSourceFragmentToTurn(requireActiveTurn(session), action.fragment) };
    case "SOURCE_IDLE":
      return { ...session, activeTurn: markSourceIdle(requireActiveTurn(session), Date.now()) };
    case "OUTPUT_ACTIVE": {
      const activeTurn = requireActiveTurn(session);
      const updated = markOutputActive(activeTurn);
      return { ...session, state: session.state === "listening" ? "outputting" : session.state, activeTurn: updated };
    }
    case "OUTPUT_IDLE":
      // Informational only: never changes `state` or `expectedSpeaker` (only
      // an explicit TURN_CLOSED does that, per §11.1).
      requireActiveTurn(session);
      return session;
    case "TURN_CLOSED":
      return handleTurnClosed(session, action);
    case "TURN_FAILED":
      return handleTurnFailed(session);

    case "CORRECTION_START":
      return handleCorrectionStart(session);
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
