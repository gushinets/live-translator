import { eld } from "eld/extrasmall";
import type { Side } from "../conversation/Turn";

export interface ConversationLanguages {
  A: string;
  B: string;
}

export function detectLanguage(text: string, minLetters = 8): string | undefined {
  // ponytail: text detection cannot identify very short or ambiguous speech;
  // leave it unassigned and offer manual correction instead of guessing.
  const sample = text.slice(0, 2000);
  if ((sample.match(/\p{L}/gu)?.length ?? 0) < minLetters) return undefined;
  const result = eld.detect(sample);
  return result.isReliable() && result.language ? result.language : undefined;
}

export function resolveSide(
  text: string,
  languages: ConversationLanguages,
  manualOverride?: Side,
): Side | undefined {
  if (manualOverride !== undefined) return manualOverride;
  if (languages.A === languages.B) return undefined;
  const language = detectLanguage(text);
  if (language === languages.A) return "A";
  if (language === languages.B) return "B";
  return undefined;
}

export function languageName(code: string, locale = "ru"): string {
  return new Intl.DisplayNames([locale], { type: "language" }).of(code) ?? code;
}
