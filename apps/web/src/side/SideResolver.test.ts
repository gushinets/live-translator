import { describe, expect, it } from "vitest";
import { resolveSide } from "./SideResolver";

describe("language-based side resolution", () => {
  const languages = { A: "ru", B: "en" };
  it("allows A-A-A-B-B-A and B to speak first", () => {
    const russian = "Подскажите, пожалуйста, где находится вокзал?";
    const english = "Could you tell me where the train station is?";
    expect([russian, russian, russian, english, english, russian]
      .map(text => resolveSide(text, languages))).toEqual(["A", "A", "A", "B", "B", "A"]);
    expect(resolveSide(english, languages)).toBe("B");
  });
  it("does not guess for ambiguous text or another language", () => {
    for (const text of ["", "OK", "12345", "Alex", "Où se trouve la gare, s'il vous plaît ?"]) {
      expect(resolveSide(text, languages)).toBeUndefined();
    }
  });
  it("distinguishes languages sharing a script and respects manual assignment", () => {
    expect(resolveSide("¿Dónde está la estación de tren, por favor?", { A: "en", B: "es" })).toBe("B");
    expect(resolveSide("OK", languages, "A")).toBe("A");
  });
});
