/** Unicode sentence terminals include native danda, Arabic and Urdu punctuation. */
export function isSentenceComplete(text: string): boolean {
  return /\p{Sentence_Terminal}[\p{P}\s]*$/u.test(text);
}
export function hasSentenceTerminator(text: string): boolean {
  return /\p{Sentence_Terminal}/u.test(text);
}
export function splitSentences(text: string): string[] {
  return text.match(/\P{Sentence_Terminal}*(?:\p{Sentence_Terminal}[\p{Pe}\p{Pf}"']*)+\s*|\P{Sentence_Terminal}+$/gu) ?? [];
}
