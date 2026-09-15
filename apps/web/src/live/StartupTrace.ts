export const STARTUP_TRACE_PREFIX = "[live-translator:startup]";
export const STARTUP_TRACE_STORAGE_KEY = "liveTranslatorStartupTrace";
const STARTUP_TRACE_QUERY_KEY = "lt_startup_trace";

type TraceValue = string | number | boolean | null | undefined;

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

export function traceAppendSent(
  command: { type: string; event_id?: string },
  appendKind: string,
): void {
  trace({
    event: "live.append.sent",
    command_type: command.type,
    event_id: command.event_id,
    append_kind: appendKind,
  });
}

export function traceAppendAck(
  event: { type: string; client_event_id?: string },
  rawEvent: unknown,
): void {
  trace({
    event: "live.append.ack",
    server_type: event.type,
    server_event_id: stringField(rawEvent, "event_id"),
    client_event_id: event.client_event_id,
  });
}

export function traceAppendError(rawEvent: unknown): void {
  const error = isRecord(rawEvent) ? rawEvent.error : undefined;
  trace({
    event: "live.append.error",
    server_type: stringField(rawEvent, "type") ?? "error",
    server_event_id: stringField(rawEvent, "event_id"),
    client_event_id: stringField(rawEvent, "client_event_id"),
    nested_client_event_id: stringField(error, "client_event_id"),
    error_code: nullableStringField(error, "code"),
    error_type: stringField(error, "type"),
  });
}

export function traceAckRegistry(
  event: "ack.wait" | "ack.resolve" | "ack.reject" | "ack.timeout" | "ack.reject_all",
  details: {
    clientEventId: string;
    pendingCount: number;
    errorType?: string;
  },
): void {
  trace({
    event,
    client_event_id: details.clientEventId,
    pending_count: details.pendingCount,
    error_type: details.errorType,
  });
}

export function traceBeginInterpreter(
  event:
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
  });
}

export function traceAckErrorType(error: unknown): string {
  return errorType(error);
}
