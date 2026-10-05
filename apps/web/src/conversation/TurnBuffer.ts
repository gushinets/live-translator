import { orderTranscriptFragments, type TranscriptFragment } from "./TranscriptFragment";
import type { Side, Turn } from "./Turn";

export interface StartTurnParams {
  id: string;
  speaker: Side | undefined;
  sideSource: Turn["sideSource"];
  nowMs: number;
}

const TERMINAL_STATUSES: ReadonlySet<Turn["status"]> = new Set([
  "completed",
  "discarded",
  "failed",
]);

/** Pure constructor for a stored transcript fragment, keeping optional timing. */
export function createTranscriptFragment(input: {
  text: string;
  nowMs: number;
  startMs?: number;
  endMs?: number;
}): TranscriptFragment {
  const fragment: TranscriptFragment = {
    id: crypto.randomUUID(),
    text: input.text,
    receivedAtMs: input.nowMs,
  };
  if (input.startMs !== undefined) {
    fragment.startMs = input.startMs;
  }
  if (input.endMs !== undefined) {
    fragment.endMs = input.endMs;
  }
  return fragment;
}

/** Pure constructor for a fresh, still-streaming turn. */
export function createTurn(params: StartTurnParams): Turn {
  return {
    id: params.id,
    speaker: params.speaker,
    sideSource: params.sideSource,
    sourceFragments: [],
    originalText: "",
    status: "streaming",
    audioOutputStarted: false,
    speechStartAtMs: params.nowMs,
  };
}

/** Pure append of a new source transcript fragment onto a non-terminal turn. */
export function appendSourceFragmentToTurn(turn: Turn, fragment: TranscriptFragment): Turn {
  if (TERMINAL_STATUSES.has(turn.status)) {
    throw new Error(`Cannot append a source fragment to a turn with terminal status "${turn.status}".`);
  }
  const sourceFragments = orderTranscriptFragments([...turn.sourceFragments, fragment]);
  return {
    ...turn,
    sourceFragments,
    originalText: sourceFragments.map(part => part.text).join(""),
  };
}

/** Pure marker for the local VAM deciding the source side has gone idle. */
export function markSourceIdle(turn: Turn, nowMs: number): Turn {
  if (TERMINAL_STATUSES.has(turn.status)) {
    throw new Error(`Cannot mark source idle on a turn with terminal status "${turn.status}".`);
  }
  return { ...turn, sourceIdleAtMs: nowMs };
}

/**
 * Pure marker that output has started for this turn, without yet knowing
 * the text/audio content (e.g. a raw "output activity" signal). Does not
 * fabricate `translatedText`/`firstOutputTextAtMs`; those are only set once
 * actual output text arrives via {@link appendOutputTextToTurn}.
 */
export function markOutputActive(turn: Turn): Turn {
  if (TERMINAL_STATUSES.has(turn.status)) {
    throw new Error(`Cannot mark output active on a turn with terminal status "${turn.status}".`);
  }
  return turn.status === "streaming" ? { ...turn, status: "outputting" } : turn;
}

/** Pure append of an output-transcript delta onto a non-terminal turn. */
export function appendOutputTextToTurn(turn: Turn, text: string, nowMs: number): Turn {
  if (TERMINAL_STATUSES.has(turn.status)) {
    throw new Error(`Cannot append output text to a turn with terminal status "${turn.status}".`);
  }
  return {
    ...turn,
    status: "outputting",
    translatedText: `${turn.translatedText ?? ""}${text}`,
    firstOutputTextAtMs: turn.firstOutputTextAtMs ?? nowMs,
    outputTextEndAtMs: nowMs,
    outputTextAfterPlaybackEdge: turn.playbackEndAtMs !== undefined || turn.audioOutputInterrupted
      ? true : turn.outputTextAfterPlaybackEdge,
  };
}

/** Pure marker for the first audible playback byte of this turn's output. */
export function markAudioOutputStarted(turn: Turn, nowMs: number): Turn {
  return {
    ...turn,
    audioOutputStarted: true,
    firstAudibleOutputAtMs: turn.firstAudibleOutputAtMs ?? nowMs,
    playbackEndAtMs: undefined,
  };
}

/** Pure marker for local playback finishing for this turn. */
export function markPlaybackEnded(turn: Turn, nowMs: number): Turn {
  return { ...turn, playbackEndAtMs: nowMs, outputTextAfterPlaybackEdge: false };
}

/**
 * Same-speaker source continuation: a premature idle must not stay latched
 * once VAM reports source activity again.
 */
export function clearSourceIdle(turn: Turn): Turn {
  if (TERMINAL_STATUSES.has(turn.status)) {
    throw new Error(`Cannot clear source idle on a turn with terminal status "${turn.status}".`);
  }
  return { ...turn, sourceIdleAtMs: undefined };
}

/** Pure transition: the §10 completion predicate succeeded. */
export function completeTurn(turn: Turn, nowMs: number): Turn {
  return { ...turn, status: "completed", turnCompletedAtMs: nowMs };
}

/** Pure transition: §10.3 branch C deadlock escape (no usable output). */
export function failTurn(turn: Turn, nowMs: number): Turn {
  return { ...turn, status: "failed", turnCompletedAtMs: nowMs };
}

/** Pure transition: an unfinished turn abandoned at a suspension/cancel boundary. */
export function discardTurn(turn: Turn, nowMs: number): Turn {
  return { ...turn, status: "discarded", turnCompletedAtMs: nowMs };
}

/** Retain the whole conversation for both participants' scrollable history. */
export function pushRecentTurn(recent: readonly Turn[], turn: Turn): Turn[] {
  return [...recent, turn];
}

/**
 * Stateful convenience wrapper around the pure turn-lifecycle functions
 * above. Holds one active turn and every completed/failed/discarded turn
 * for UI history. No persistence beyond the in-memory session.
 */
export class TurnBuffer {
  private active: Turn | undefined;
  private history: Turn[] = [];

  activeTurn(): Turn | undefined {
    return this.active;
  }

  start(params: StartTurnParams): Turn {
    if (this.active !== undefined) {
      throw new Error(
        `Cannot start a new turn for speaker "${params.speaker}": the previous active turn ` +
          `("${this.active.id}", speaker "${this.active.speaker}", status "${this.active.status}") ` +
          "has not been closed.",
      );
    }
    this.active = createTurn(params);
    return this.active;
  }

  appendSourceFragment(fragment: TranscriptFragment): Turn {
    this.active = appendSourceFragmentToTurn(this.requireActive(), fragment);
    return this.active;
  }

  appendOutputText(text: string, nowMs: number): Turn {
    this.active = appendOutputTextToTurn(this.requireActive(), text, nowMs);
    return this.active;
  }

  complete(nowMs: number): Turn {
    const completed = completeTurn(this.requireActive(), nowMs);
    this.history = pushRecentTurn(this.history, completed);
    this.active = undefined;
    return completed;
  }

  fail(nowMs: number): Turn {
    const failed = failTurn(this.requireActive(), nowMs);
    this.history = pushRecentTurn(this.history, failed);
    this.active = undefined;
    return failed;
  }

  discard(nowMs: number): Turn {
    const discarded = discardTurn(this.requireActive(), nowMs);
    this.history = pushRecentTurn(this.history, discarded);
    this.active = undefined;
    return discarded;
  }

  recent(): readonly Turn[] {
    return this.history;
  }

  private requireActive(): Turn {
    if (this.active === undefined) {
      throw new Error("No active turn exists.");
    }
    return this.active;
  }
}
