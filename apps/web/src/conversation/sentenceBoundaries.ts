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
  const openQuotes: Record<string, number> = { '"': -1, "'": -1 };
  const quoteBoundaries: Record<string, number | undefined> = {};
  // ponytail: common English elisions/abbreviated years use lexical evidence;
  // other languages need their own evidence or explicit token metadata.
  const leadingApostrophe = /^'(?:\p{Nd}{2}s?|cause|em|tis|twas|til)(?![\p{L}\p{N}])/iu;
  const nextQuoteBoundary = (char: string, index: number): number => {
    let next = quoteBoundaries[char];
    if (next === undefined || (next >= 0 && next <= index)) {
      next = text.indexOf(char, index + 1);
      // Share one forward scan through lexical marks, including contractions.
      while (next >= 0 && (/\p{Nd}/u.test(text[next - 1] ?? "") || (char === "'" &&
          (/[sS]/u.test(text[next - 1] ?? "") ||
           (/[\p{L}\p{Nd}]/u.test(text[next - 1] ?? "") && /[\p{L}\p{Nd}]/u.test(text[next + 1] ?? "")) ||
           leadingApostrophe.test(text.slice(next)))))) next = text.indexOf(char, next + 1);
      quoteBoundaries[char] = next;
    }
    return next;
  };
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
      if (char === "'") {
        const lexical = leadingApostrophe.exec(text.slice(i));
        if (lexical) {
          const closing = nextQuoteBoundary(char, i);
          const paired = text[i + lexical[0].length] === "'" || (closing >= 0 &&
            /\p{Sentence_Terminal}/u.test(text[closing - 1] ?? "") && !/[\p{L}\p{N}]/u.test(text[closing + 1] ?? ""));
          if (openQuotes[char]! >= 0 || !paired) continue;
        }
      }
      if (char === '"' && /\p{Nd}/u.test(before)) {
        let numberStart = i - 1;
        while (/\p{Nd}/u.test(text[numberStart - 1] ?? "")) numberStart--;
        if (/['′]/u.test(text[numberStart - 1] ?? "") && /\p{Nd}/u.test(text[numberStart - 2] ?? "")) continue;
      }
      // Distinguish an outer closing quote from an adjacent quoted reply's opener.
      if (char in openQuotes && openQuotes[char]! >= 0 &&
          ((char === "'" && /[sS]/u.test(before)) || /\p{Nd}/u.test(before)) &&
          !/^[\p{N}\s.,+−-]+$/u.test(text.slice(openQuotes[char]! + 1, i))) {
        const nextQuote = nextQuoteBoundary(char, i);
        const followingQuote = nextQuote < 0 ? -1 : text.indexOf(char, nextQuote + 1);
        const quotedText = followingQuote < 0 ? "" : text.slice(nextQuote + 1, followingQuote);
        const startsNextQuote = /^\S/u.test(quotedText) && /[\p{L}\p{Nd}]/u.test(quotedText) && isSentenceComplete(quotedText);
        if (/\p{Sentence_Terminal}/u.test(text[nextQuote - 1] ?? "") && !startsNextQuote) continue;
      }
      // Marks after a number or word do not open quoted speech (6'2", dogs').
      if (char in openQuotes && (openQuotes[char]! >= 0 || !/[\p{L}\p{N}]/u.test(text[i - 1] ?? ""))) {
        openQuotes[char] = openQuotes[char]! >= 0 ? -1 : i;
      }
    }
    while (end < text.length) {
      const char = text[end]!;
      if (/\p{Sentence_Terminal}|\p{Pe}|\p{Pf}/u.test(char)) { end++; continue; }
      if (openQuotes[char]! >= 0) { openQuotes[char] = -1; end++; continue; }
      break;
    }
    while (/\s/u.test(text[end] ?? "")) end++;
    sentences.push(text.slice(start, end));
    start = terminal.lastIndex = end;
  }
  if (start < text.length) sentences.push(text.slice(start));
  return sentences;
}
