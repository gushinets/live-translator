export const STARTUP_TRACE_PREFIX = "[live-translator:startup]";
export const STARTUP_TRACE_STORAGE_KEY = "liveTranslatorStartupTrace";
const STARTUP_TRACE_QUERY_KEY = "lt_startup_trace";

type TraceValue = string | number | boolean | null | undefined;

export interface StartupTraceContext {
  startupGeneration?: number;
  startupState?: string;
  startupStage?: string;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null;
}

function stringField(value: unknown, key: string): string | undefined {
  return isRecord(value) && typeof value[key] === "string"
    ? value[key]
    : undefined;
}

function nullableStringField(
  value: unknown,
  key: string,
): string | null | undefined {
  if (!isRecord(value)) return undefined;
  if (value[key] === null) return null;
  return typeof value[key] === "string" ? value[key] : undefined;
}

function errorType(error: unknown): string {
  return error instanceof Error ? error.name : typeof error;
}

function traceEnabled(): boolean {
  try {
    if (localStorage.getItem(STARTUP_TRACE_STORAGE_KEY) === "1") return true;
  } catch {
    // Some browser modes can deny storage access.
  }
  try {
    return new URLSearchParams(location.search).get(STARTUP_TRACE_QUERY_KEY) === "1";
  } catch {
    return false;
  }
}

function trace(fields: Record<string, TraceValue>): void {
  if (!traceEnabled()) return;
  try {
    console.info(
      `${STARTUP_TRACE_PREFIX} ${JSON.stringify({
        flow: "interpreter_startup",
        ...fields,
      })}`,
    );
  } catch {
    // Diagnostic logging must never change runtime behavior.
  }
}

function startupFields(
  context: StartupTraceContext | undefined,
): Record<string, TraceValue> {
  return {
    startup_generation: context?.startupGeneration,
    startup_state: context?.startupState,
    startup_stage: context?.startupStage,
  };
}

export function traceAppendSent(
  command: { type: string; event_id?: string },
  appendKind: string,
  context?: StartupTraceContext,
): void {
  trace({
    event: "live.append.sent",
    command_type: command.type,
    event_id: command.event_id,
    append_kind: appendKind,
    ...startupFields(context),
  });
}

export function traceAppendSendFailed(
  command: { type: string; event_id?: string },
  appendKind: string,
  error: unknown,
  context?: StartupTraceContext,
): void {
  trace({
    event: "live.append.send_failed",
    command_type: command.type,
    event_id: command.event_id,
    append_kind: appendKind,
    error_type: errorType(error),
    ...startupFields(context),
  });
}

export function traceAppendAck(
  event: { type: string; client_event_id?: string },
  rawEvent: unknown,
  context?: StartupTraceContext,
): void {
  trace({
    event: "live.append.ack",
    server_type: event.type,
    server_event_id: stringField(rawEvent, "event_id"),
    client_event_id: event.client_event_id,
    ...startupFields(context),
  });
}

export function traceAppendError(
  rawEvent: unknown,
  context?: StartupTraceContext,
): void {
  const error = isRecord(rawEvent) ? rawEvent.error : undefined;
  trace({
    event: "live.append.error",
    server_type: stringField(rawEvent, "type") ?? "error",
    server_event_id: stringField(rawEvent, "event_id"),
    client_event_id: stringField(rawEvent, "client_event_id"),
    nested_client_event_id: stringField(error, "client_event_id"),
    error_code: nullableStringField(error, "code"),
    error_type: stringField(error, "type"),
    ...startupFields(context),
  });
}

export function traceAppendErrorClientEventId(rawEvent: unknown): string | undefined {
  const error = isRecord(rawEvent) ? rawEvent.error : undefined;
  return stringField(error, "client_event_id") ?? stringField(rawEvent, "client_event_id");
}

export function traceAckRegistry(
  event: "ack.wait" | "ack.resolve" | "ack.reject" | "ack.timeout" | "ack.reject_all",
  details: {
    clientEventId: string;
    pendingCount: number;
    errorType?: string;
  } & StartupTraceContext,
): void {
  trace({
    event,
    client_event_id: details.clientEventId,
    pending_count: details.pendingCount,
    error_type: details.errorType,
    ...startupFields(details),
  });
}

export function traceBeginInterpreter(
  event:
    | "session.cancel"
    | "session.beginInterpreter.cancelled"
    | "session.beginInterpreter.failure"
    | "session.beginInterpreter.start"
    | "session.beginInterpreter.finish"
    | "session.interpreter_ready",
  details: {
    generation: number;
    state: string;
    enteredInterpreter: boolean;
    gateCOpen: boolean;
    interpreterInFlight?: boolean;
    currentGeneration?: number;
    errorType?: string;
  },
): void {
  trace({
    event,
    generation: details.generation,
    current_generation: details.currentGeneration,
    state: details.state,
    entered_interpreter: details.enteredInterpreter,
    gate_c_open: details.gateCOpen,
    interpreter_in_flight: details.interpreterInFlight,
    error_type: details.errorType,
  });
}

export function traceAckErrorType(error: unknown): string {
  return errorType(error);
}

export function traceBootstrapAction(
  action: "accept" | "skip",
  details: {
    state: string;
    isInterpreterStarting: boolean;
    enteredInterpreter: boolean;
  },
): void {
  trace({
    event: `ui.bootstrap.${action}_invoked`,
    action,
    state: details.state,
    is_interpreter_starting: details.isInterpreterStarting,
    entered_interpreter: details.enteredInterpreter,
  });
}

export function traceConversationRenderPredicate(details: {
  state: string;
  isConversation: boolean;
  isOwnerSetup: boolean;
  enteredInterpreter: boolean;
  isInterpreterStarting: boolean;
}): void {
  trace({
    event: "ui.conversation.render_predicate",
    state: details.state,
    is_conversation: details.isConversation,
    is_owner_setup: details.isOwnerSetup,
    rendered_screen: details.isConversation ? "conversation" : "owner_setup",
    entered_interpreter: details.enteredInterpreter,
    is_interpreter_starting: details.isInterpreterStarting,
  });
}
