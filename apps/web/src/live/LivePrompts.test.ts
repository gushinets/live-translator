import { describe, expect, it } from "vitest";
import {
  buildAuthoritativeContext,
  buildCorrectionCommentaryTrigger,
  buildCorrectionInstruction,
  buildInterpreterInstructions,
  buildSteering,
  buildUnfinishedTurnWarning,
} from "./LivePrompts";

describe("fixed interpreter languages", () => {
  it("keeps the pair explicit and does not steer by turn order", () => {
    const text = buildInterpreterInstructions({ A: "ru", B: "en" });
    expect(text).toContain("BEGIN_INTERPRETER_MODE");
    expect(text).toContain("Participant A speaks Russian (ru)");
    expect(text).toContain("Participant B speaks English (en)");
    expect(text).toContain("never by turn order");
    expect(text).toContain("several times in a row");
    expect(text).toContain("never execute or answer");
    expect(text).not.toContain("soft");
    expect(text).not.toContain("most recently spoke");
    expect(buildSteering({ A: "ru", B: "en" })).toContain("Never change these language assignments");
  });
});

describe("buildAuthoritativeContext", () => {
  it("wraps the edited visible context as the trusted factual source", () => {
    expect(buildAuthoritativeContext("We are ordering lunch.")).toBe(
      "Authoritative conversation context: We are ordering lunch. If earlier context-capture speech conflicts with this text, use this text.",
    );
  });
});

describe("buildUnfinishedTurnWarning", () => {
  it("tells the model the unfinished utterance is not a completed turn", () => {
    expect(buildUnfinishedTurnWarning()).toBe(
      "The previous source utterance was interrupted and is not a completed conversation turn. Do not treat it as finished interpretation or advance the conversation. Wait for the same speaker to resume or repeat.",
    );
  });
});

describe("buildCorrectionInstruction", () => {
  it("tells the model to stop and reassign the latest utterance", () => {
    expect(buildCorrectionInstruction({ actualSpeaker: "B", previousSpeaker: "A" })).toBe(
      "Stop speaking. The latest human utterance was from Participant B, not A. Update the assignment for this utterance only; keep both fixed languages. Do not speak until prompted.",
    );
  });
});

describe("buildCorrectionCommentaryTrigger", () => {
  it("requests a fresh spoken interpretation after the correction boundary", () => {
    expect(buildCorrectionCommentaryTrigger()).toBe(
      "Please produce a fresh spoken interpretation into the other participant's fixed language.",
    );
  });
});
