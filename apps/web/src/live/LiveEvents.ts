/**
 * Typed shapes for the JSON events exchanged over the GPT-Live `oai-events`
 * WebRTC data channel. Field names follow binding spec 1.2.1 §13.
 *
 * This file intentionally covers only the categories needed for session
 * lifecycle and diagnostics (Task 3). Event correlation via `event_id` /
 * `client_event_id` and the trusted control-command builders are added in a
 * later task.
 */

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
 * Payloads with an unrecognized `type` are not narrowed (Task 3 only
 * "at minimum" handles the categories above; later tasks add more).
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
  instructions: string;
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
