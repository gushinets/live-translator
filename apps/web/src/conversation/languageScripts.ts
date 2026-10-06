import type { ConversationLanguages } from "../side/SideResolver";
import type { Side } from "./Turn";
import { shortReplies } from "./shortReplies";
import { isSentenceComplete, splitSentences } from "./sentenceBoundaries";
import type { eld } from "eld/extrasmall";

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

/** Neutral leading syntax must not consume the bounded language sample. */
export function languageDetectionSample(text: string): string {
  const start = text.search(/\p{L}/u);
  return start < 0 ? "" : text.slice(start, start + 2000);
}

/** A lowercase label can finish a dotted token, including its closing punctuation. */
export function isDottedContinuation(before: string, after: string): boolean {
  return /\p{Script_Extensions=Latin}\.$/u.test(before) &&
    /^(?=\p{Ll})\p{Script_Extensions=Latin}[\p{Script_Extensions=Latin}\p{M}\p{Nd}./_-]*[\p{Pe}\p{Pf}"']*\.?[\p{Pe}\p{Pf}"']*\s*$/u.test(after);
}

/** A scheme, www prefix or web cue is positive address evidence; dotted initials are not. */
function hasDottedTokenPrefix(before: string): boolean {
  return /(?:https?:\/\/|(?:^|[\s\p{Ps}\p{Pi}"'])www\.)(?:[\p{Script_Extensions=Latin}\p{M}\p{Nd}_-]+\.)*$/iu.test(before) ||
    /(?:^|\s)(?:site|website|domain|url|address|adresse|visit|página|pagina)\s+[\p{Ps}\p{Pi}"']*(?:[\p{Script_Extensions=Latin}\p{M}\p{Nd}_-]+\.)+$/iu.test(before);
}

/** Prefer explicit replies unless positive token or conflicting-language evidence exists. */
export function isDottedTokenContinuation(before: string, after: string, languages: ConversationLanguages,
  detector: ReturnType<typeof eld.newInstance>): boolean {
  const dotted = isDottedContinuation(before, after);
  if (!dotted || shortReplyEvidence(after, languages) === undefined) return dotted;
  if (hasDottedTokenPrefix(before)) return true;
  const label = /([\p{Script_Extensions=Latin}\p{M}\p{Nd}_-]+)\.$/u.exec(before)?.[1];
  if (!label) return false;
  detector.setLanguageSubset([languages.A, languages.B]);
  const context = detector.detect(languageDetectionSample(before)), token = detector.detect(label);
  return context.isReliable() && token.isReliable() && context.language !== token.language;
}

/** Keep weak period prefixes and dotted tokens until language context is available. */
export function splitLanguageSentences(text: string, languages: ConversationLanguages, detector: ReturnType<typeof eld.newInstance>): string[] {
  detector.setLanguageSubset([languages.A, languages.B]);
  const allowed = scriptPattern([...languageScripts(languages.A), ...languageScripts(languages.B)]);
  const covered = (text: string) => (text.match(/\p{L}/gu) ?? []).every(letter => allowed?.test(letter));
  const reliable = (text: string) => {
    const result = detector.detect(languageDetectionSample(text));
    return result.isReliable() && (result.language === languages.A || result.language === languages.B);
  };
  const candidates = splitSentences(text), sentences: string[] = [];
  let prefix = "", prefixEvidence = "", prefixCovered = true;
  let prefixScriptSide: Side | "ambiguous" | undefined;
  for (const [index, sentence] of candidates.entries()) {
    const next = candidates[index + 1];
    // Opening quotes/brackets are neutral syntax; No. is a number label only before a number.
    const continuation = /^[\s\p{Ps}\p{Pi}"']*(?:\p{Nd}+|Dr|Mr|Mrs|Ms|Prof|Sr|Jr)\.\s*$/iu.test(sentence) ||
      /^[\s\p{Ps}\p{Pi}"']*\p{Lu}\.\s*$/u.test(sentence) ||
      (/^[\s\p{Ps}\p{Pi}"']*No\.\s*$/iu.test(sentence) && /^\s*\p{Nd}/u.test(next ?? ""));
    const reply = continuation || (prefix && isDottedTokenContinuation(prefix, sentence, languages, detector))
      ? undefined : shortReplyEvidence(sentence, languages);
    // Preserve standalone replies and leave room for new evidence in the detection sample.
    if (prefix && (reply !== undefined || prefix.length + sentence.length > 2000)) {
      sentences.push(prefix); prefix = ""; prefixEvidence = ""; prefixCovered = true; prefixScriptSide = undefined;
    }
    prefix += sentence;
    // Inspect each piece once, retaining only the bounded sample used by ELD.
    prefixCovered &&= covered(sentence);
    if (/\p{L}/u.test(sentence)) {
      const side = completeScriptSide(sentence, languages);
      // All letters in the prefix must share exclusive evidence; shared letters cancel it.
      prefixScriptSide = prefixScriptSide === undefined ? side ?? "ambiguous" : prefixScriptSide === side ? side : "ambiguous";
    }
    if (prefixEvidence.length < 2000) prefixEvidence += languageDetectionSample(sentence).slice(0, 2000 - prefixEvidence.length);
    // ponytail: only common titles, numeric ordinals and initials defer a period;
    // other abbreviations need explicit evidence or token-boundary metadata.
    if (continuation && reply === undefined &&
        (prefixScriptSide === undefined || prefixScriptSide === "ambiguous") && prefixCovered && !reliable(prefixEvidence)) continue;
    // Contiguous lowercase labels (including .no) belong to the dotted token before reply evidence.
    if (next && isDottedTokenContinuation(prefix, next, languages, detector) &&
        covered(next) && (hasDottedTokenPrefix(prefix) || !reliable(next))) continue;
    sentences.push(prefix); prefix = ""; prefixEvidence = ""; prefixCovered = true; prefixScriptSide = undefined;
  }
  if (prefix) sentences.push(prefix);
  return sentences;
}
