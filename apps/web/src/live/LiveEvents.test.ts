import { describe, expect, it } from "vitest";
import {
  APPEND_CHAR_BUDGET,
  ContextTooLongError,
  buildCommentaryAppendCommand,
  buildInstructionsAppendCommand,
  buildThinkingAppendCommand,
} from "./LiveEvents";

describe("append payload builders", () => {
  it("builds an instructions append with delegation_id null and the given event_id", () => {
    expect(buildInstructionsAppendCommand("evt-1", "BEGIN_INTERPRETER_MODE.")).toEqual({
      type: "session.instructions.append",
      event_id: "evt-1",
      delegation_id: null,
      instructions: "BEGIN_INTERPRETER_MODE.",
    });
  });

  it("builds thinking and commentary appends without truncating the content", () => {
    const thinking = "Authoritative conversation context: hello.";
    const commentary = "Please produce a fresh spoken interpretation.";
    expect(buildThinkingAppendCommand("evt-2", thinking)).toEqual({
      type: "session.thinking.append",
      event_id: "evt-2",
      delegation_id: null,
      content: thinking,
    });
    expect(buildCommentaryAppendCommand("evt-3", commentary)).toEqual({
      type: "session.commentary.append",
      event_id: "evt-3",
      delegation_id: null,
      content: commentary,
    });
  });

  it("accepts text at the conservative character budget", () => {
    const text = "a".repeat(APPEND_CHAR_BUDGET);
    expect(buildInstructionsAppendCommand("evt-budget", text).instructions).toBe(
      text,
    );
  });

  it("throws a user-facing shorten-context error instead of truncating oversized text", () => {
    const oversized = "a".repeat(APPEND_CHAR_BUDGET + 1);
    expect(() => buildInstructionsAppendCommand("evt-big", oversized)).toThrow(
      ContextTooLongError,
    );
    expect(() => buildInstructionsAppendCommand("evt-big", oversized)).toThrow(
      "This text is too long to send. Please shorten the context and try again.",
    );
    expect(() => buildThinkingAppendCommand("evt-big", oversized)).toThrow(
      ContextTooLongError,
    );
    expect(() => buildCommentaryAppendCommand("evt-big", oversized)).toThrow(
      ContextTooLongError,
    );
  });
});
