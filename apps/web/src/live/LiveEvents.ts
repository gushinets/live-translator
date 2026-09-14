/**
 * Typed shapes for the JSON events exchanged over the GPT-Live `oai-events`
 * WebRTC data channel. Field names follow binding spec 1.2.1 §13.
 *
 * Application-generated control events use unique `event_id` values.
 * Acknowledgments are correlated by `client_event_id`. Append payloads are
 * preflighted with a small local heuristic to avoid obvious append-size
 * failures. This is not a tokenizer and does not guarantee any token count;
 * oversized text is rejected locally, never truncated.
 */

/** Hard local safety cap; not a token guarantee. */
export const APPEND_CHAR_BUDGET = 1800;

const APPEND_COMPLEXITY_BUDGET = 500;

export class ContextTooLongError extends Error {
  constructor() {
    super(
      "This text is too long to send. Please shorten the context and try again.",
    );
    this.name = "ContextTooLongError";
  }
}

export function isAppendSizeError(error: unknown): boolean {
  if (error instanceof ContextTooLongError) {
    return true;
  }
  const message = error instanceof Error ? error.message : String(error);
  return (
    /\btoo\s+(?:long|large)\b/i.test(message) ||
    /\b(?:exceeds?|exceeding)\s+(?:the\s+)?(?:maximum|max)\s+(?:tokens?|context|size|length|payload)\s+limit\b/i.test(
      message,
    ) ||
    /\b(?:maximum|max)\s+(?:tokens?|context|size|length|payload)\s+limit\s+(?:exceeded|reached)\b/i.test(
      message,
    )
  );
}

function estimateAppendComplexity(text: string): number {
  let total = 0;
  for (const char of text) {
    total += char.charCodeAt(0) <= 0x7f ? 0.25 : 1;
  }
  return total;
}

export function assertAppendWithinBudget(text: string): void {
  if (
    text.length > APPEND_CHAR_BUDGET ||
    estimateAppendComplexity(text) > APPEND_COMPLEXITY_BUDGET
  ) {
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

export interface SessionUsageContextWindow {
  usage_ratio?: number;
}

export interface SessionUsage {
  seconds?: number;
}

export interface SessionUsageSnapshot extends SessionUsage {
  context_window?: SessionUsageContextWindow;
}

export interface SessionUsageUpdatedEvent {
  type: "session.usage.updated";
  usage: SessionUsage;
  context_window?: SessionUsageContextWindow;
}

export interface SessionClosedEvent {
  type: "session.closed";
  reason?: string;
  usage?: SessionUsage;
}

export interface LiveErrorEvent {
  type: "error";
  error: { message: string; code?: string | null; client_event_id?: string };
}

export type LiveServerEvent =
  | SessionStartedEvent
  | TranscriptDeltaEvent
  | AppendAcknowledgedEvent
  | MuteAcknowledgedEvent
  | SessionUsageUpdatedEvent
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
  "session.usage.updated",
  "session.closed",
  "error",
]);

type LiveServerEventParseResult =
  | { kind: "known"; event: LiveServerEvent }
  | { kind: "unknown" }
  | { kind: "invalid"; message: string };

/**
 * Narrows an arbitrary parsed JSON payload to a known `LiveServerEvent`.
 * Payloads with an unrecognized `type` are not narrowed.
 */
export function isLiveServerEvent(value: unknown): value is LiveServerEvent {
  return parseLiveServerEvent(value).kind === "known";
}

export function parseLiveServerEvent(
  value: unknown,
): LiveServerEventParseResult {
  if (!isRecord(value) || typeof value.type !== "string") {
    return {
      kind: "invalid",
      message: "Received a Live event without a valid type",
    };
  }
  const type = value.type as LiveServerEvent["type"];
  if (!KNOWN_SERVER_EVENT_TYPES.has(type)) {
    return { kind: "unknown" };
  }
  if (!hasValidPayload(value, type)) {
    return {
      kind: "invalid",
      message: `Received malformed ${type} event`,
    };
  }
  return { kind: "known", event: value as unknown as LiveServerEvent };
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null;
}

function hasOptionalString(
  value: Record<string, unknown>,
  key: string,
): boolean {
  return !(key in value) || typeof value[key] === "string";
}

function hasOptionalNullableString(
  value: Record<string, unknown>,
  key: string,
): boolean {
  return (
    !(key in value) ||
    value[key] === null ||
    typeof value[key] === "string"
  );
}

function hasOptionalNumber(
  value: Record<string, unknown>,
  key: string,
): boolean {
  return !(key in value) || typeof value[key] === "number";
}

function hasValidUsage(value: unknown): value is SessionUsage {
  if (!isRecord(value)) return false;
  return hasOptionalNumber(value, "seconds");
}

function hasValidContextWindow(
  value: unknown,
): value is SessionUsageContextWindow {
  return (
    isRecord(value) &&
    hasOptionalNumber(value, "usage_ratio")
  );
}

function hasValidPayload(
  value: Record<string, unknown>,
  type: LiveServerEvent["type"],
): boolean {
  switch (type) {
    case "session.started": {
      const session = value.session;
      return isRecord(session) && typeof session.id === "string";
    }
    case "session.input_transcript.delta":
    case "session.output_transcript.delta":
      return (
        typeof value.delta === "string" &&
        hasOptionalNumber(value, "start_ms") &&
        hasOptionalNumber(value, "end_ms")
      );
    case "session.instructions.appended":
    case "session.thinking.appended":
    case "session.commentary.appended":
    case "session.input_audio.muted":
    case "session.input_audio.unmuted":
      return hasOptionalString(value, "client_event_id");
    case "session.usage.updated":
      return (
        hasValidUsage(value.usage) &&
        (!("context_window" in value) ||
          hasValidContextWindow(value.context_window))
      );
    case "session.closed":
      return (
        hasOptionalString(value, "reason") &&
        (!("usage" in value) || hasValidUsage(value.usage))
      );
    case "error": {
      const error = value.error;
      return (
        isRecord(error) &&
        typeof error.message === "string" &&
        hasOptionalNullableString(error, "code") &&
        hasOptionalString(error, "client_event_id")
      );
    }
  }
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
