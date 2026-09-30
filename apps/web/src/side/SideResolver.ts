import { eld } from "eld/extrasmall";
import type { Side } from "../conversation/Turn";

export interface ConversationLanguages {
  A: string;
  B: string;
}

export function supportedLanguageCodes(): string[] {
  return Object.values(eld.info().Languages);
}

export function preferredLanguage(locales: readonly string[]): string | undefined {
  const supported = new Set(supportedLanguageCodes());
  for (const locale of locales) {
    try {
      const language = new Intl.Locale(locale).language;
      const detectorLanguage = language === "nb" ? "no" : language === "fil" ? "tl" : language;
      if (supported.has(detectorLanguage)) return detectorLanguage;
    } catch { /* Ignore an invalid browser locale. */ }
  }
  return undefined;
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

// Keep Russian labels stable across browsers with different ICU language data.
const russianLanguageNames: Record<string, string> = {
  "am": "амхарский",
  "ar": "арабский",
  "az": "азербайджанский",
  "be": "белорусский",
  "bg": "болгарский",
  "bn": "бенгальский",
  "ca": "каталанский",
  "cs": "чешский",
  "da": "датский",
  "de": "немецкий",
  "el": "греческий",
  "en": "английский",
  "es": "испанский",
  "et": "эстонский",
  "eu": "баскский",
  "fa": "персидский",
  "fi": "финский",
  "fr": "французский",
  "gu": "гуджарати",
  "he": "иврит",
  "hi": "хинди",
  "hr": "хорватский",
  "hu": "венгерский",
  "hy": "армянский",
  "is": "исландский",
  "it": "итальянский",
  "ja": "японский",
  "ka": "грузинский",
  "kn": "каннада",
  "ko": "корейский",
  "ku": "курдский",
  "lo": "лаосский",
  "lt": "литовский",
  "lv": "латышский",
  "ml": "малаялам",
  "mr": "маратхи",
  "ms": "малайский",
  "nl": "нидерландский",
  "no": "норвежский",
  "or": "ория",
  "pa": "панджаби",
  "pl": "польский",
  "pt": "португальский",
  "ro": "румынский",
  "ru": "русский",
  "sk": "словацкий",
  "sl": "словенский",
  "sq": "албанский",
  "sr": "сербский",
  "sv": "шведский",
  "ta": "тамильский",
  "te": "телугу",
  "th": "тайский",
  "tl": "филиппинский",
  "tr": "турецкий",
  "uk": "украинский",
  "ur": "урду",
  "vi": "вьетнамский",
  "yo": "йоруба",
  "zh": "китайский"
};

export function languageName(code: string, locale = "ru"): string {
  if (new Intl.Locale(locale).language === "ru" && russianLanguageNames[code]) return russianLanguageNames[code];
  return new Intl.DisplayNames([locale], { type: "language" }).of(code) ?? code;
}
