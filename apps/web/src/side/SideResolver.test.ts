import { describe, expect, it, vi } from "vitest";
import { languageName, preferredLanguage, resolveSide, supportedLanguageCodes } from "./SideResolver";

it("provides Russian names even when the browser only returns language codes", () => {
  const names = vi.spyOn(Intl.DisplayNames.prototype, "of").mockImplementation(code => String(code));
  try {
    expect(["be", "ku", "or", "yo"].map(code => languageName(code)))
      .toEqual(["белорусский", "курдский", "ория", "йоруба"]);
    for (const code of supportedLanguageCodes()) expect(languageName(code)).not.toBe(code);
  } finally { names.mockRestore(); }
});

it("uses the first supported browser language and exposes the detector's language set", () => {
  expect(preferredLanguage(["xx-ZZ", "ru-RU", "en-US"])).toBe("ru");
  expect(preferredLanguage(["xx-ZZ"])).toBeUndefined();
  expect(supportedLanguageCodes()).toEqual(expect.arrayContaining(["es", "en", "de", "ru"]));
});

it.each([["nb-NO", "no"], ["fil-PH", "tl"]])("maps device locale %s to detector code %s", (locale, language) => {
  expect(preferredLanguage([locale, "en-US"])).toBe(language);
});

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
  it("distinguishes languages sharing a script", () => {
    expect(resolveSide("¿Dónde está la estación de tren, por favor?", { A: "en", B: "es" })).toBe("B");
  });
});
