import { earliestFragmentStart, orderTranscriptFragments, type TranscriptFragment } from "../conversation/TranscriptFragment";
import type { Side, Turn } from "../conversation/Turn";
import {
  appendOutputTextToTurn,
  appendSourceFragmentToTurn,
  clearSourceIdle,
  completeTurn,
  createTurn,
  discardTurn,
  failTurn,
  markAudioOutputStarted,
  markOutputActive,
  markPlaybackEnded,
  markSourceIdle,
  pushRecentTurn,
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
      languageRouted?: boolean;
    }
  | { type: "SOURCE_FRAGMENT"; fragment: TranscriptFragment; speaker?: Side; languageRouted?: boolean }
  | { type: "SOURCE_HANDOFF"; turnId: string; speaker: Side | undefined; fragment?: TranscriptFragment; nowMs: number; previousIdleAtMs?: number; languageRouted?: boolean }
  | { type: "SOURCE_TARGETED_FRAGMENT"; turnId: string; fragment: TranscriptFragment }
  | { type: "SOURCE_BOUNDARY"; turnId: string; endMs: number }
  | { type: "SOURCE_IDLE" }
  | { type: "OUTPUT_ACTIVE" }
  | { type: "OUTPUT_DELTA"; text: string; nowMs: number; turnId?: string; fragment?: TranscriptFragment; speaker?: Side; languageRouted?: boolean }
  | { type: "OUTPUT_STANDALONE"; turnId: string; speaker: Side | undefined; text: string; nowMs: number; fragment?: TranscriptFragment }
  | { type: "AUDIO_STARTED"; nowMs: number; turnId?: string }
  | { type: "AUDIO_INTERRUPTED"; nowMs: number; turnId: string }
  | { type: "PLAYBACK_ENDED"; nowMs: number; turnId?: string }
  | { type: "OUTPUT_IDLE" }
  | { type: "TURN_CLOSED"; speaker: Side | undefined; turnId?: string }
  | { type: "TURN_FAILED"; turnId?: string }
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

export function findSessionTurn(session: TranslationSession, id?: string): Turn | undefined {
  if (id === undefined || session.activeTurn?.id === id) return session.activeTurn;
  return session.pendingTurns?.find(turn => turn.id === id) ?? session.recentTurns.find(turn => turn.id === id);
}

function updateSessionTurn(session: TranslationSession, id: string, update: (turn: Turn) => Turn): TranslationSession {
  if (session.activeTurn?.id === id) return { ...session, activeTurn: update(session.activeTurn) };
  if (session.pendingTurns?.some(turn => turn.id === id)) {
    return { ...session, pendingTurns: session.pendingTurns.map(turn => turn.id === id ? update(turn) : turn) };
  }
  if (session.recentTurns.some(turn => turn.id === id)) {
    return { ...session, recentTurns: session.recentTurns.map(turn => turn.id === id ? update(turn) : turn) };
  }
  throw new Error(`No turn exists with id "${id}".`);
}

const SOURCE_APPEND_BLOCKED_STATES: ReadonlySet<SessionState> = new Set([
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
]);

function assertTurnCloseAllowed(session: TranslationSession): void {
  if (TURN_CLOSE_BLOCKED_STATES.has(session.state)) {
    throw new Error(`Cannot close or fail a turn while session state is "${session.state}".`);
  }
}

const OUTPUT_EVENT_BLOCKED_STATES: ReadonlySet<SessionState> = new Set([
  "error",
  "ended",
  "suspended",
]);

function assertOutputEventAllowed(session: TranslationSession): void {
  if (OUTPUT_EVENT_BLOCKED_STATES.has(session.state)) {
    throw new Error(`Cannot accept output events while session state is "${session.state}".`);
  }
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

  if (session.state !== "listening" && session.state !== "outputting") {
    throw new Error(`Cannot start a new source turn while session state is "${session.state}".`);
  }

  const created = createTurn({
    id: action.turnId,
    speaker: action.speaker,
    sideSource: action.sideSource,
    nowMs: Date.now(),
  });
  const A = session.participantA.language;
  const B = session.participantB.language;
  if (A !== undefined && B !== undefined) created.languages = { A, B };
  const withFragment = action.fragment ? appendSourceFragmentToTurn(created, action.fragment) : created;
  return { ...session, activeTurn: action.languageRouted ? withFragment : assignLanguageSide(session, withFragment) };
}

function assignLanguageSide(session: TranslationSession, turn: Turn): Turn {
  const A = turn.languages?.A ?? session.participantA.language;
  const B = turn.languages?.B ?? session.participantB.language;
  if (A === undefined || B === undefined) return turn;
  const sourceSide = resolveSide(turn.originalText, { A, B }) ?? (turn.sideSource === "language" ? turn.speaker : undefined);
  if (sourceSide !== undefined) return { ...turn, speaker: sourceSide, sideSource: "language" };
  // A reliable translation identifies its recipient when source captions are short or missing.
  // Recheck the growing translation: a partial word can initially resemble another language.
  const outputSide = resolveSide(turn.translatedText ?? "", { A, B });
  const speaker = outputSide === "A" ? "B" : outputSide === "B" ? "A" : undefined;
  return { ...turn, speaker, sideSource: speaker === undefined ? "unresolved" : "translation" };
}

function handleSourceFragment(
  session: TranslationSession,
  action: Extract<SessionAction, { type: "SOURCE_FRAGMENT" }>,
): TranslationSession {
  assertSourceAppendAllowed(session);
  const appended = appendSourceFragmentToTurn(requireActiveTurn(session), action.fragment);
  return { ...session, activeTurn: action.speaker ? { ...appended, speaker: action.speaker, sideSource: "language" }
    : action.languageRouted ? appended : assignLanguageSide(session, appended) };
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
  const activeTurn = findSessionTurn(session, action.turnId);
  if (!activeTurn) throw new Error("No active turn exists.");
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
      state: session.state === "ending" ? "ending" : session.activeTurn?.id === activeTurn.id ||
        (!session.activeTurn && !(session.pendingTurns?.some(turn => turn.id !== activeTurn.id))) ? "listening" : session.state,
      activeTurn: session.activeTurn?.id === activeTurn.id ? undefined : session.activeTurn,
      pendingTurns: session.pendingTurns?.filter(turn => turn.id !== activeTurn.id),
      recentTurns: pushRecentTurn(session.recentTurns, completed),
      lastSpeaker: action.speaker,
    },
    action.speaker,
  );
}

function handleTurnFailed(session: TranslationSession, turnId?: string): TranslationSession {
  assertTurnCloseAllowed(session);
  const activeTurn = findSessionTurn(session, turnId);
  if (!activeTurn) throw new Error("No active turn exists.");
  const failed = failTurn(activeTurn, Date.now());
  return {
    ...session,
    state: session.state === "ending" ? "ending" : session.activeTurn?.id === activeTurn.id ||
      (!session.activeTurn && !(session.pendingTurns?.some(turn => turn.id !== activeTurn.id))) ? "listening" : session.state,
    activeTurn: session.activeTurn?.id === activeTurn.id ? undefined : session.activeTurn,
    pendingTurns: session.pendingTurns?.filter(turn => turn.id !== activeTurn.id),
    recentTurns: pushRecentTurn(session.recentTurns, failed),
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
  if (session.pendingTurns?.length) {
    session = { ...session, pendingTurns: [], recentTurns: [...session.recentTurns,
      ...session.pendingTurns.map(turn => discardTurn(turn, Date.now()))] };
  }
  if (session.activeTurn === undefined) {
    return { ...session, state: "suspended" };
  }
  if (session.activeTurn.turnCompletedAtMs !== undefined) {
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
    case "SOURCE_HANDOFF": {
      assertSourceAppendAllowed(session);
      const previous = session.activeTurn;
      const pendingTurns = [...(session.pendingTurns ?? [])];
      const boundary = action.fragment?.startMs;
      const previousStart = earliestFragmentStart(previous?.sourceFragments);
      if (previous) pendingTurns.push({ ...markSourceIdle(previous, action.previousIdleAtMs ?? previous.sourceIdleAtMs ?? action.nowMs),
        sourceEndMs: boundary !== undefined && (previousStart === undefined || boundary >= previousStart)
          ? boundary : previous.sourceEndMs });
      const next = handleSourceActive({ ...session, state: "listening", activeTurn: undefined, pendingTurns }, {
        type: "SOURCE_ACTIVE", turnId: action.turnId, speaker: action.speaker, sideSource: action.speaker ? "language" : "unresolved", fragment: action.fragment,
        languageRouted: action.languageRouted,
      });
      return { ...next, state: session.state };
    }
    case "SOURCE_TARGETED_FRAGMENT": {
      assertSourceAppendAllowed(session);
      return updateSessionTurn(session, action.turnId, turn => {
        if (turn.status === "completed" || turn.status === "failed") {
          const sourceFragments = orderTranscriptFragments([...turn.sourceFragments, action.fragment]);
          return { ...turn, sourceFragments, originalText: sourceFragments.map(fragment => fragment.text).join("") };
        }
        return appendSourceFragmentToTurn(turn, action.fragment);
      });
    }
    case "SOURCE_BOUNDARY":
      assertSourceAppendAllowed(session);
      return updateSessionTurn(session, action.turnId, turn => ({ ...turn, sourceEndMs: action.endMs }));
    case "SOURCE_IDLE":
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
      const target = findSessionTurn(session, action.turnId);
      if (!target) throw new Error("No active turn exists.");
      const updated = updateSessionTurn(session, target.id, turn => {
        let output = turn.status === "completed"
          ? { ...turn, translatedText: (turn.translatedText ?? "") + action.text, outputTextEndAtMs: action.nowMs }
          : turn.sideSource === "language" || action.languageRouted ? appendOutputTextToTurn(turn, action.text, action.nowMs)
          : assignLanguageSide(session, appendOutputTextToTurn(turn, action.text, action.nowMs));
        if (action.speaker !== undefined) output = { ...output, speaker: action.speaker,
          sideSource: turn.sideSource === "language" ? "language" : "translation" };
        return action.fragment ? { ...output, outputFragments: [...(turn.outputFragments ?? []), action.fragment] } : output;
      });
      return { ...updated, state: session.state === "listening" && target.status !== "completed" ? "outputting" : session.state };
    }
    case "OUTPUT_STANDALONE": {
      assertOutputEventAllowed(session);
      const languages = session.participantA.language && session.participantB.language
        ? { A: session.participantA.language, B: session.participantB.language } : undefined;
      const created: Turn = { ...createTurn({ id: action.turnId, speaker: action.speaker, sideSource: "translation", nowMs: action.nowMs }),
        translationOnly: true, languages, sourceIdleAtMs: action.nowMs };
      const turn = appendOutputTextToTurn(created, action.text, action.nowMs);
      if (action.fragment) turn.outputFragments = [action.fragment];
      return { ...session, pendingTurns: [...(session.pendingTurns ?? []), turn],
        state: session.state === "listening" ? "outputting" : session.state };
    }
    case "AUDIO_STARTED": {
      assertOutputEventAllowed(session);
      const target = findSessionTurn(session, action.turnId);
      if (!target) throw new Error("No active turn exists.");
      const updated = updateSessionTurn(session, target.id, turn => markAudioOutputStarted(markOutputActive(turn), action.nowMs));
      return { ...updated, state: session.state === "listening" ? "outputting" : session.state };
    }
    case "AUDIO_INTERRUPTED":
      return updateSessionTurn(session, action.turnId, turn => ({ ...turn, audioOutputInterrupted: true, playbackEndAtMs: action.nowMs }));
    case "PLAYBACK_ENDED":
      assertOutputEventAllowed(session);
      return updateSessionTurn(session, action.turnId ?? requireActiveTurn(session).id, turn => markPlaybackEnded(turn, action.nowMs));
    case "OUTPUT_IDLE":
      // Turn completion is handled separately from output inactivity.
      return session;
    case "TURN_CLOSED":
      return handleTurnClosed(session, action);
    case "TURN_FAILED":
      return handleTurnFailed(session, action.turnId);

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
