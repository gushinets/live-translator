/** Unicode sentence terminals include native danda, Arabic and Urdu punctuation. */
export function isSentenceComplete(text: string): boolean {
  return /\p{Sentence_Terminal}[\p{P}\s]*$/u.test(text);
}
export function hasSentenceTerminator(text: string): boolean {
  return /\p{Sentence_Terminal}/u.test(text);
}
export function splitSentences(text: string): string[] {
  const sentences: string[] = [];
  const terminal = /\P{Sentence_Terminal}*\p{Sentence_Terminal}+/gu;
  const openQuotes: Record<string, boolean> = { '"': false, "'": false };
  let start = 0;
  for (let match = terminal.exec(text); match; match = terminal.exec(text)) {
    let end = terminal.lastIndex;
    for (let i = start; i < end; i++) {
      const char = text[i]!;
      // An apostrophe within a word does not open or close quoted speech.
      if (char === "'" && /\p{L}/u.test(text[i - 1] ?? "") && /\p{L}/u.test(text[i + 1] ?? "")) continue;
      if (char in openQuotes) openQuotes[char] = !openQuotes[char];
    }
    while (end < text.length) {
      const char = text[end]!;
      if (/\p{Sentence_Terminal}|\p{Pe}|\p{Pf}/u.test(char)) { end++; continue; }
      if (openQuotes[char]) { openQuotes[char] = false; end++; continue; }
      break;
    }
    while (/\s/u.test(text[end] ?? "")) end++;
    sentences.push(text.slice(start, end));
    start = terminal.lastIndex = end;
  }
  if (start < text.length) sentences.push(text.slice(start));
  return sentences;
}
