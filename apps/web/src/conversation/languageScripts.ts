import type { ConversationLanguages } from "../side/SideResolver";
import type { Side } from "./Turn";
import { shortReplies } from "./shortReplies";
import { isSentenceComplete } from "./sentenceBoundaries";

// Contemporary alternate orthographies from CLDR languageData (same pinned source/license as shortReplies).
// Phonetic transliterations and historical orthographies are not inferred from a bare language code.
const alternateScripts: Readonly<Record<string, readonly string[]>> = {
  az: ["Latn", "Arab", "Cyrl"], ku: ["Latn", "Arab", "Cyrl"],
  ms: ["Latn", "Arab"], pa: ["Guru", "Arab"], ro: ["Latn", "Cyrl"], sr: ["Cyrl", "Latn"],
};

export function languageScripts(language: string): string[] {
  const locale = new Intl.Locale(language);
  const likely = locale.maximize().script;
  const scripts = locale.script ? [locale.script] : alternateScripts[locale.language] ?? (likely ? [likely] : []);
  return scripts.flatMap(script => script === "Jpan" ? ["Han", "Hiragana", "Katakana"]
    : script === "Kore" ? ["Hangul", "Han"] : script === "Hans" || script === "Hant" ? ["Han"] : [script]);
}

export function scriptPattern(scripts: string[]): RegExp | undefined {
  if (!scripts.length) return undefined;
  try { return new RegExp(scripts.map(value => `\\p{Script_Extensions=${value}}`).join("|"), "u"); }
  catch { return undefined; }
}

/** A completed, single-script phrase can resolve even a one-character reply. */
export function completeScriptSide(text: string, languages: ConversationLanguages): Side | undefined {
  if (!isSentenceComplete(text)) return undefined;
  const a = languageScripts(languages.A), b = languageScripts(languages.B);
  const letters = text.match(/\p{L}/gu) ?? [];
  if (!letters.length) return undefined;
  const patternA = scriptPattern(a), patternB = scriptPattern(b);
  const matchesA = patternA && letters.every(letter => patternA.test(letter));
  const matchesB = patternB && letters.every(letter => patternB.test(letter));
  // Shared letters may be the sentence language with a foreign name embedded.
  // Only wholly exclusive evidence is decisive without language detection.
  if (matchesA && !letters.some(letter => patternB?.test(letter))) return "A";
  if (matchesB && !letters.some(letter => patternA?.test(letter))) return "B";
  return undefined;
}

/** Shared decisive reply evidence for routing and displayed sentence context. */
export function isExplicitShortReply(text: string, language: string): boolean {
  if (!isSentenceComplete(text)) return false;
  const words = text.normalize("NFC").toLowerCase().match(/[\p{L}\p{M}]+/gu) ?? [];
  // Full localized replies protect short interruptions; keyboard abbreviations are not speech.
  return words.length > 0 && words.every(word => shortReplies[language]?.includes(word) ||
    (language === "en" && /^(yes|no|hi|hey|bye|stop|wait|why|what|how|who|when|where|sure|fine)$/.test(word)) ||
    (language === "ru" && /^(да|нет|ага|угу|стой|стоп|как|что|кто|где|эй)$/.test(word)));
}

// A short-reply list is not a vocabulary: absence cannot prove another language.
// These canonical answers have been checked for the listed same-script pairs.
const pairReplies: Readonly<Record<string, Readonly<Record<string, readonly string[]>>>> = {
  "en/es": { en: ["yes"], es: ["sí"] },
  "en/fr": { en: ["yes", "no"], fr: ["oui", "non"] },
};
export function shortReplyEvidence(text: string, languages: ConversationLanguages): Side | "ambiguous" | undefined {
  if (!isExplicitShortReply(text, languages.A) && !isExplicitShortReply(text, languages.B)) return undefined;
  const scriptSide = completeScriptSide(text, languages);
  if (scriptSide !== undefined) return scriptSide;
  const replies = pairReplies[[languages.A, languages.B].sort().join("/")];
  const words = text.normalize("NFC").toLowerCase().match(/[\p{L}\p{M}]+/gu) ?? [];
  const a = words.length > 0 && words.every(word => replies?.[languages.A]?.includes(word));
  const b = words.length > 0 && words.every(word => replies?.[languages.B]?.includes(word));
  return a === b ? "ambiguous" : a ? "A" : "B";
}
