/**
 * Typed shapes for the JSON events exchanged over the GPT-Live `oai-events`
 * WebRTC data channel. Field names follow binding spec 1.2.1 §13.
 *
 * Application-generated control events use unique `event_id` values.
 * Acknowledgments are correlated by `client_event_id`. Append payloads are
 * preflighted against a conservative character budget standing in for the
 * Live 500-token event limit; oversized text is rejected, never truncated.
 */

/** Conservative character stand-in for the Live 500-token append limit. */
export const APPEND_CHAR_BUDGET = 1800;

export class ContextTooLongError extends Error {
  constructor() {
    super(
      "This text is too long to send. Please shorten the context and try again.",
    );
    this.name = "ContextTooLongError";
  }
}

function assertAppendWithinBudget(text: string): void {
  if (text.length > APPEND_CHAR_BUDGET) {
    throw new ContextTooLongError();
  }
}

export interface SessionStartedEvent {
  type: "session.started";
  session: { id: string };
}

export type TranscriptDeltaType =
  | "session.input_transcript.delta"
  | "session.output_transcript.delta";

export interface TranscriptDeltaEvent {
  type: TranscriptDeltaType;
  delta: string;
  start_ms?: number;
  end_ms?: number;
}

export type AppendAcknowledgedType =
  | "session.instructions.appended"
  | "session.thinking.appended"
  | "session.commentary.appended";

export interface AppendAcknowledgedEvent {
  type: AppendAcknowledgedType;
  client_event_id?: string;
}

export type MuteAcknowledgedType =
  | "session.input_audio.muted"
  | "session.input_audio.unmuted";

export interface MuteAcknowledgedEvent {
  type: MuteAcknowledgedType;
  client_event_id?: string;
}

export interface SessionUsage {
  seconds?: number;
}

export interface SessionClosedEvent {
  type: "session.closed";
  reason?: string;
  usage?: SessionUsage;
}

export interface LiveErrorEvent {
  type: "error";
  error: { message: string; code?: string };
  client_event_id?: string;
}

export type LiveServerEvent =
  | SessionStartedEvent
  | TranscriptDeltaEvent
  | AppendAcknowledgedEvent
  | MuteAcknowledgedEvent
  | SessionClosedEvent
  | LiveErrorEvent;

const KNOWN_SERVER_EVENT_TYPES: ReadonlySet<LiveServerEvent["type"]> = new Set([
  "session.started",
  "session.input_transcript.delta",
  "session.output_transcript.delta",
  "session.instructions.appended",
  "session.thinking.appended",
  "session.commentary.appended",
  "session.input_audio.muted",
  "session.input_audio.unmuted",
  "session.closed",
  "error",
]);

/**
 * Narrows an arbitrary parsed JSON payload to a known `LiveServerEvent`.
 * Payloads with an unrecognized `type` are not narrowed.
 */
export function isLiveServerEvent(value: unknown): value is LiveServerEvent {
  if (typeof value !== "object" || value === null || !("type" in value)) {
    return false;
  }
  const { type } = value as { type: unknown };
  return (
    typeof type === "string" &&
    KNOWN_SERVER_EVENT_TYPES.has(type as LiveServerEvent["type"])
  );
}

/** Client -> server command sent to end the Live session gracefully. */
export interface SessionCloseCommand {
  type: "session.close";
}

export interface InstructionsAppendCommand {
  type: "session.instructions.append";
  event_id: string;
  delegation_id: null;
  content: string;
}

export interface ThinkingAppendCommand {
  type: "session.thinking.append";
  event_id: string;
  delegation_id: null;
  content: string;
}

export interface CommentaryAppendCommand {
  type: "session.commentary.append";
  event_id: string;
  delegation_id: null;
  content: string;
}

export interface InputAudioMuteCommand {
  type: "session.input_audio.mute";
  event_id: string;
}

export interface InputAudioUnmuteCommand {
  type: "session.input_audio.unmute";
  event_id: string;
}

export type LiveClientEvent =
  | SessionCloseCommand
  | InstructionsAppendCommand
  | ThinkingAppendCommand
  | CommentaryAppendCommand
  | InputAudioMuteCommand
  | InputAudioUnmuteCommand;

export function buildInstructionsAppendCommand(
  eventId: string,
  content: string,
): InstructionsAppendCommand {
  assertAppendWithinBudget(content);
  return {
    type: "session.instructions.append",
    event_id: eventId,
    delegation_id: null,
    content,
  };
}

export function buildThinkingAppendCommand(
  eventId: string,
  content: string,
): ThinkingAppendCommand {
  assertAppendWithinBudget(content);
  return {
    type: "session.thinking.append",
    event_id: eventId,
    delegation_id: null,
    content,
  };
}

export function buildCommentaryAppendCommand(
  eventId: string,
  content: string,
): CommentaryAppendCommand {
  assertAppendWithinBudget(content);
  return {
    type: "session.commentary.append",
    event_id: eventId,
    delegation_id: null,
    content,
  };
}
