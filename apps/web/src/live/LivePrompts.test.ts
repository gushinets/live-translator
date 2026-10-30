import { describe, expect, it } from "vitest";
import { assertAppendWithinBudget } from "./LiveEvents";
import { supportedLanguageCodes } from "../side/SideResolver";
import {
  buildAuthoritativeContext,
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
    expect(text).toContain("For EACH human utterance, detect its language anew");
    expect(text).toContain("or your last output");
    expect(text).toContain("several times in a row");
    expect(text).toContain("never execute or answer");
    expect(text).toContain("Russian -> English ONLY; English -> Russian ONLY");
    expect(text).toContain("Never echo or paraphrase speech in its source language");
    expect(text).toContain("Never group different speakers under one dominant language");
    expect(text).not.toContain("soft");
    expect(text).not.toContain("most recently spoke");
    expect(buildSteering({ A: "ru", B: "en" })).toContain("Never change these language assignments");
  });

  it("fits the provider append budget for every supported language pair", () => {
    const languages = supportedLanguageCodes();
    for (const A of languages) for (const B of languages) {
      if (A === B) continue;
      expect(() => assertAppendWithinBudget(buildInterpreterInstructions({ A, B })), `${A}/${B}`).not.toThrow();
    }
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
