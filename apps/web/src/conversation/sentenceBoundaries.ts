/** Unicode sentence terminals include native danda, Arabic and Urdu punctuation. */
export function isSentenceComplete(text: string): boolean {
  return /\p{Sentence_Terminal}[\p{P}\s]*$/u.test(text);
}
/** Detect a Unicode sentence terminal anywhere in a fragment. */
export function hasSentenceTerminator(text: string): boolean {
  return /\p{Sentence_Terminal}/u.test(text);
}
/** Preserve paired straight quotes; treat unpaired leading words/years as elisions. */
export function splitSentences(text: string): string[] {
  const sentences: string[] = [];
  const terminal = /\p{Sentence_Terminal}/gu;
  const openQuotes: Record<string, number> = { '"': -1, "'": -1 };
  const quoteBoundaries: Record<string, number | undefined> = {};
  // ponytail: unpaired words/years are lexical; ambiguous unmatched quotes need token metadata.
  const leadingApostrophe = /^'(?:\p{L}[\p{L}\p{M}]*|\p{Nd}{2}s?)(?![\p{L}\p{N}])/iu;
  const followsSentence = (index: number): boolean => {
    let before = index - 1;
    while (/[\s\p{Pe}\p{Pf}"']/u.test(text[before] ?? "")) before--;
    return /\p{Sentence_Terminal}/u.test(text[before] ?? "");
  };
  const nextQuoteBoundary = (char: string, index: number, pairedLevel = 0): number => {
    // Separate forward caches keep mate lookahead from advancing the main quote scan.
    const cacheKey = char + pairedLevel;
    let next = quoteBoundaries[cacheKey];
    if (next === undefined || (next >= 0 && next <= index)) {
      const word = pairedLevel ? /^\s*[\p{L}\p{M}\p{N}]+/u.exec(text.slice(index + 1))?.[0] : undefined;
      const wordClosing = word && text[index + 1 + word.length] === char ? index + 1 + word.length : -1;
      next = text.indexOf(char, index + 1);
      // Share one forward scan through lexical marks, including contractions.
      while (next >= 0 && !(pairedLevel && /\p{Sentence_Terminal}/u.test(text[next + 1] ?? "")) &&
          ((next !== wordClosing && /\p{Nd}/u.test(text[next - 1] ?? "")) || (char === "'" &&
          ((next !== wordClosing && /[sS]/u.test(text[next - 1] ?? "")) ||
           (/[\p{L}\p{Nd}]/u.test(text[next - 1] ?? "") && /[\p{L}\p{Nd}]/u.test(text[next + 1] ?? "")) ||
           (leadingApostrophe.test(text.slice(next)) && !followsSentence(next)))))) {
        const lexical = char === "'" && !followsSentence(next) ? leadingApostrophe.exec(text.slice(next)) : null;
        // A paired lexical word inside speech contributes neither quote boundary.
        if (lexical && text[next + lexical[0].length] === char) next += lexical[0].length;
        next = text.indexOf(char, next + 1);
      }
      quoteBoundaries[cacheKey] = next;
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
      const quotedPossessive = char === "'" && openQuotes[char]! >= 0 &&
        /^s(?![\p{L}\p{M}\p{N}])/iu.test(text.slice(i + 1)) &&
        /^\s*[\p{L}\p{M}\p{N}]+$/u.test(text.slice(openQuotes[char]! + 1, i));
      // Apostrophes within words and feet marks stay literal inside quotes too.
      if (char === "'" && /[\p{L}\p{Nd}]/u.test(before) && /[\p{L}\p{Nd}]/u.test(after) && !quotedPossessive) continue;
      if (char === "'" && !quotedPossessive) {
        const lexical = leadingApostrophe.exec(text.slice(i));
        if (lexical) {
          if (openQuotes[char]! >= 0) {
            if (text[i + lexical[0].length] === char) i += lexical[0].length;
            continue;
          }
          const closing = nextQuoteBoundary(char, i);
          const following = closing < 0 ? -1 : nextQuoteBoundary(char, closing, 1);
          const quotedText = following < 0 ? "" : text.slice(closing + 1, following);
          const next = following < 0 ? -1 : nextQuoteBoundary(char, following, 2);
          const followingText = next < 0 ? "" : text.slice(following + 1, next);
          // A later paired opener cannot serve as this candidate's closing mate.
          const followingStartsQuote = /[\p{L}\p{N}]/u.test(followingText) &&
            (/\p{Sentence_Terminal}/u.test(text[next + 1] ?? "") ||
             (/\p{Sentence_Terminal}/u.test(text[next - 1] ?? "") &&
              !/[\p{L}\p{N}]/u.test(text[next + 1] ?? "") && isSentenceComplete(followingText)));
          const startsNextQuote = following >= 0 && !followingStartsQuote && !/[\p{L}\p{N}]/u.test(text[following + 1] ?? "") &&
            (/^[\p{L}\p{M}\p{N}]+$/u.test(quotedText) || isSentenceComplete(quotedText));
          const paired = text[i + lexical[0].length] === "'" || (closing >= 0 &&
            /\p{Sentence_Terminal}/u.test(text[closing - 1] ?? "") &&
            !startsNextQuote);
          if (!paired) continue;
        }
      }
      if (char === '"' && /\p{Nd}/u.test(before)) {
        let numberStart = i - 1;
        while (/\p{Nd}/u.test(text[numberStart - 1] ?? "")) numberStart--;
        if (/['′]/u.test(text[numberStart - 1] ?? "") && /\p{Nd}/u.test(text[numberStart - 2] ?? "")) continue;
      }
      // Distinguish an outer closing quote from an adjacent quoted reply's opener.
      if (char in openQuotes && openQuotes[char]! >= 0 &&
          (quotedPossessive || (char === "'" && /[sS]/u.test(before)) || /\p{Nd}/u.test(before)) &&
          !/^[\p{N}\s.,+−-]+$/u.test(text.slice(openQuotes[char]! + 1, i))) {
        const nextQuote = nextQuoteBoundary(char, i);
        const followingQuote = nextQuote < 0 ? -1 : text.indexOf(char, nextQuote + 1);
        const quotedText = followingQuote < 0 ? "" : text.slice(nextQuote + 1, followingQuote);
        const next = followingQuote < 0 ? -1 : nextQuoteBoundary(char, followingQuote, 2);
        const followingText = next < 0 ? "" : text.slice(followingQuote + 1, next);
        // A paired later reply leaves the intervening sentence outside quotes.
        const followingStartsQuote = /[\p{L}\p{N}]/u.test(followingText) &&
          (/\p{Sentence_Terminal}/u.test(text[next + 1] ?? "") ||
           (/\p{Sentence_Terminal}/u.test(text[next - 1] ?? "") &&
            !/[\p{L}\p{N}]/u.test(text[next + 1] ?? "") && isSentenceComplete(followingText)));
        const startsNextQuote = !followingStartsQuote && /[\p{L}\p{Nd}]/u.test(quotedText) && isSentenceComplete(quotedText);
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
