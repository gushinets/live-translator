import type { ConversationLanguages } from "../side/SideResolver";
import type { Side } from "./Turn";

export function languageScripts(language: string): string[] {
  const script = new Intl.Locale(language).maximize().script;
  return script === "Jpan" ? ["Han", "Hiragana", "Katakana"]
    : script === "Kore" ? ["Hangul", "Han"] : script === "Hans" || script === "Hant" ? ["Han"] : script ? [script] : [];
}

export function scriptPattern(scripts: string[]): RegExp | undefined {
  if (!scripts.length) return undefined;
  try { return new RegExp(scripts.map(value => `\\p{Script=${value}}`).join("|"), "u"); }
  catch { return undefined; }
}

/** A completed, single-script phrase can resolve even a one-character reply. */
export function completeScriptSide(text: string, languages: ConversationLanguages): Side | undefined {
  if (!/[.!?。！？][\p{P}\s]*$/u.test(text)) return undefined;
  const a = languageScripts(languages.A), b = languageScripts(languages.B);
  if (a.some(script => b.includes(script))) return undefined;
  const letters = text.match(/\p{L}/gu) ?? [];
  if (!letters.length) return undefined;
  const patternA = scriptPattern(a), patternB = scriptPattern(b);
  if (patternA && letters.every(letter => patternA.test(letter))) return "A";
  if (patternB && letters.every(letter => patternB.test(letter))) return "B";
  return undefined;
}

/** Shared decisive reply evidence for routing and displayed sentence context. */
export function isExplicitShortReply(text: string, language: string): boolean {
  if (!/[.!?。！？][\p{P}\s]*$/u.test(text)) return false;
  const words = text.toLowerCase().match(/\p{L}+/gu) ?? [];
  // ponytail: common short replies are explicit; broader vocabulary needs stronger language evidence.
  return words.length > 0 && words.every(word =>
    (language === "en" && /^(yes|no|hi|hey|bye|stop|wait|why|what|how|who|when|where|sure|fine)$/.test(word)) ||
    (language === "ru" && /^(да|нет|ага|угу|стой|стоп|как|что|кто|где|эй)$/.test(word)));
}
