import { afterEach, describe, expect, it, vi } from "vitest";

import {
  STARTUP_TRACE_PREFIX,
  STARTUP_TRACE_STORAGE_KEY,
  traceAppendAck,
  traceAppendError,
  traceAppendSent,
} from "./StartupTrace";

describe("startup trace", () => {
  afterEach(() => {
    localStorage.clear();
    vi.restoreAllMocks();
  });

  it("stays silent until startup tracing is enabled", () => {
    const info = vi.spyOn(console, "info").mockImplementation(() => {});

    traceAppendSent(
      { type: "session.instructions.append", event_id: "evt-1" },
      "startup_interpreter",
    );

    expect(info).not.toHaveBeenCalled();
  });

  it("logs append and error correlation without prohibited content", () => {
    const info = vi.spyOn(console, "info").mockImplementation(() => {});
    localStorage.setItem(STARTUP_TRACE_STORAGE_KEY, "1");
    const command = {
      type: "session.instructions.append",
      event_id: "evt-1",
      content: "SECRET_PROMPT SECRET_TRANSCRIPT SECRET_AUDIO sk-secret",
    };
    const ack = {
      type: "session.instructions.appended",
      event_id: "srv-1",
      client_event_id: "evt-1",
      content: "SECRET_ACK_CONTENT",
    };
    const error = {
      type: "error",
      event_id: "srv-err",
      client_event_id: "evt-top",
      prompt: "SECRET_PROMPT",
      transcript: "SECRET_TRANSCRIPT",
      audio: "SECRET_AUDIO",
      api_key: "sk-secret",
      error: {
        client_event_id: "evt-nested",
        code: "rate_limit",
        type: "invalid_request_error",
        message: "SECRET_MESSAGE",
        content: "SECRET_ERROR_CONTENT",
      },
    };

    traceAppendSent(command, "startup_interpreter");
    traceAppendAck(ack, ack);
    traceAppendError(error);

    const output = info.mock.calls.map((call) => call.join(" ")).join("\n");
    expect(output).toContain(STARTUP_TRACE_PREFIX);
    expect(output).toContain('"command_type":"session.instructions.append"');
    expect(output).toContain('"event_id":"evt-1"');
    expect(output).toContain('"server_event_id":"srv-1"');
    expect(output).toContain('"server_event_id":"srv-err"');
    expect(output).toContain('"client_event_id":"evt-top"');
    expect(output).toContain('"nested_client_event_id":"evt-nested"');
    expect(output).toContain('"error_code":"rate_limit"');
    expect(output).toContain('"error_type":"invalid_request_error"');
    expect(output).not.toMatch(/SECRET|content|prompt|transcript|audio|message|api_key|sk-secret/i);
  });
});
