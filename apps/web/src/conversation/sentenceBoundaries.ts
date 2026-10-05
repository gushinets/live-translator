/** Unicode sentence terminals include native danda, Arabic and Urdu punctuation. */
export function isSentenceComplete(text: string): boolean {
  return /\p{Sentence_Terminal}[\p{P}\s]*$/u.test(text);
}
export function hasSentenceTerminator(text: string): boolean {
  return /\p{Sentence_Terminal}/u.test(text);
}
export function splitSentences(text: string): string[] {
  const sentences: string[] = [];
  const terminal = /\p{Sentence_Terminal}/gu;
  const openQuotes: Record<string, boolean> = { '"': false, "'": false };
  let start = 0;
  for (let match = terminal.exec(text); match; match = terminal.exec(text)) {
    // Decimal points are part of a value, not a speaker/sentence boundary.
    if (match[0] === "." && /\p{Nd}/u.test(text[match.index - 1] ?? "") && /\p{Nd}/u.test(text[match.index + 1] ?? "")) continue;
    let end = terminal.lastIndex;
    for (let i = start; i < end; i++) {
      const char = text[i]!;
      const before = text[i - 1] ?? "", after = text[i + 1] ?? "";
      // Apostrophes within words and feet marks stay literal inside quotes too.
      if (char === "'" && /[\p{L}\p{Nd}]/u.test(before) && /[\p{L}\p{Nd}]/u.test(after)) continue;
      if (char === '"' && /\p{Nd}/u.test(before)) {
        let numberStart = i - 1;
        while (/\p{Nd}/u.test(text[numberStart - 1] ?? "")) numberStart--;
        if (/['′]/u.test(text[numberStart - 1] ?? "") && /\p{Nd}/u.test(text[numberStart - 2] ?? "")) continue;
      }
      // Distinguish an outer closing quote from an adjacent quoted reply's opener.
      if (char in openQuotes && /\s/u.test(after) && openQuotes[char] &&
          ((char === "'" && /[sS]/u.test(before)) || /\p{Nd}/u.test(before))) {
        const nextQuote = text.indexOf(char, i + 1);
        const followingQuote = nextQuote < 0 ? -1 : text.indexOf(char, nextQuote + 1);
        const quotedText = followingQuote < 0 ? "" : text.slice(nextQuote + 1, followingQuote);
        const startsNextQuote = /^\S/u.test(quotedText) && /[\p{L}\p{Nd}]/u.test(quotedText) && isSentenceComplete(quotedText);
        if (/\p{Sentence_Terminal}/u.test(text[nextQuote - 1] ?? "") && !startsNextQuote) continue;
      }
      // Marks after a number or word do not open quoted speech (6'2", dogs').
      if (char in openQuotes && (openQuotes[char] || !/[\p{L}\p{N}]/u.test(text[i - 1] ?? ""))) openQuotes[char] = !openQuotes[char];
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
