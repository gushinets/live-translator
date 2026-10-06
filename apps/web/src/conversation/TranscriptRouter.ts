import { eld } from "eld/extrasmall";
import { isSentenceComplete, splitSentences } from "./sentenceBoundaries";
import type { ConversationLanguages } from "../side/SideResolver";
import type { Side } from "./Turn";
import type { TranscriptFragment } from "./TranscriptFragment";
import { completeScriptSide, shortReplyEvidence, isExplicitShortReply, languageScripts, splitLanguageSentences, languageDetectionSample, isDottedTokenContinuation } from "./languageScripts";

export interface RoutedTranscript {
  side: Side | undefined;
  fragments: TranscriptFragment[];
}

/** Session-local language evidence. Never concatenates candidates with a previous speaker's text. */
export class TranscriptRouter {
  private pending: TranscriptFragment[] = [];
  private readonly detector = eld.newInstance();
  private languages?: ConversationLanguages;
  private currentSide?: Side;
  private sourceText = "";

  reset(): void { this.pending = []; this.currentSide = undefined; this.sourceText = ""; }

  get hasPending(): boolean { return this.pending.length > 0; }

  push(fragment: TranscriptFragment, languages: ConversationLanguages, currentSide?: Side, sourceText = ""): RoutedTranscript[] {
    this.pending.push(fragment);
    this.currentSide = currentSide;
    this.sourceText = sourceText;
    return this.drain(languages, false, false);
  }

  flush(languages: ConversationLanguages, force = false): RoutedTranscript[] {
    return this.drain(languages, true, force);
  }

  private drain(languages: ConversationLanguages, flush: boolean, force: boolean): RoutedTranscript[] {
    const routed: RoutedTranscript[] = [];
    const text = this.pending.map(part => part.text).join("");
    let consumed = 0;
    // ponytail: dotted Latin-token continuation uses syntax and reliable context;
    // explicit token/speaker metadata would remove ambiguous no-space cases.
    for (const sentence of splitSentences(text)) {
      if (this.currentSide === undefined || (!flush && !isSentenceComplete(sentence)) ||
          !isDottedTokenContinuation(this.sourceText, sentence, languages, this.detector) ||
          this.resolve(sentence, languages) !== undefined ||
          this.resolve(this.sourceText + sentence, languages) !== this.currentSide) break;
      routed.push(...this.take(this.currentSide, sentence.length));
      consumed += sentence.length;
      this.sourceText += sentence;
    }
    const sentences = splitLanguageSentences(text.slice(consumed), languages, this.detector);
    for (const [index, sentence] of sentences.entries()) {
      const bounded = index < sentences.length - 1;
      const result = this.resolveSentence(sentence, languages, flush || bounded, force || bounded);
      if (result === undefined) break;
      routed.push(...this.take(result.side, sentence.length));
      this.currentSide = result.side;
      this.sourceText = sentence;
    }
    return routed;
  }

  private resolveSentence(text: string, languages: ConversationLanguages, flush: boolean, force: boolean): { side?: Side } | undefined {
    if (/^[\p{P}\s]+$/u.test(text) && this.currentSide !== undefined) return { side: this.currentSide };
    const scriptSide = this.resolveScript(text, languages);
    if (scriptSide !== undefined) return { side: scriptSide };
    if (shortReplyEvidence(text, languages) === "ambiguous") return flush ? {} : undefined;
    // Only complete words are evidence: "Thank y" can otherwise be classified as Spanish.
    const evidence = text.replace(/\p{L}+$/u, "");
    const side = this.resolve(evidence, languages);
    if (side !== undefined && this.hasEvidence(evidence, text, side, this.currentSide)) return { side };
    if (!flush) return text.length >= 512 ? {} : undefined;
    const fullSide = this.resolve(text, languages);
    // An unreliable prefix is only a consistency check for a reliable full phrase;
    // it never establishes an author by itself. "Thank y" fails that check.
    if (fullSide !== undefined && this.resolve(evidence, languages, false) === fullSide &&
        this.hasEvidence(text, text, fullSide, this.currentSide)) return { side: fullSide };
    // A script distinction can identify a language even before the last word is
    // complete. A pause cannot make an unfinished Latin word Spanish or English.
    const distinctScripts = !languageScripts(languages.A).some(script => languageScripts(languages.B).includes(script));
    if (distinctScripts && fullSide !== undefined && this.hasEvidence(text, text, fullSide, this.currentSide)) return { side: fullSide };
    if (!force && fullSide !== undefined && /\p{L}$/u.test(text)) return undefined;
    return {};
  }

  private resolveScript(text: string, languages: ConversationLanguages): Side | undefined {
    const replySide = shortReplyEvidence(text, languages);
    if (replySide === "A" || replySide === "B") return replySide;
    const side = completeScriptSide(text, languages);
    if (side === undefined || this.currentSide === undefined || side === this.currentSide) return side;
    if (isExplicitShortReply(text, languages[side])) return side;
    const before = this.sourceText.match(/\P{Sentence_Terminal}*$/u)?.[0] ?? "";
    // A packet ending in a period may finish the source's sentence ("Google.").
    // Reliable standalone replies still establish a handoff, even mid-sentence.
    if (/\p{L}/u.test(before) && this.resolve(text, languages) === undefined &&
        this.resolve(before + text, languages) === this.currentSide) return this.currentSide;
    return side;
  }

  private hasEvidence(evidence: string, text: string, side: Side, currentSide?: Side): boolean {
    const letters = (evidence.match(/\p{L}/gu) ?? []).length;
    const words = (evidence.match(/\p{L}+/gu) ?? []).length;
    return currentSide !== undefined && side !== currentSide
      ? letters >= 8 && (words >= 2 || isSentenceComplete(text))
      : letters >= 4;
  }

  private resolve(text: string, languages: ConversationLanguages, requireReliable = true): Side | undefined {
    if (languages.A === languages.B) return undefined;
    if (this.languages?.A !== languages.A || this.languages.B !== languages.B) {
      this.detector.setLanguageSubset([languages.A, languages.B]);
      this.languages = { ...languages };
    }
    const result = this.detector.detect(languageDetectionSample(text));
    if (requireReliable && !result.isReliable()) return undefined;
    return result.language === languages.A ? "A" : result.language === languages.B ? "B" : undefined;
  }

  private take(side: Side | undefined, length: number): RoutedTranscript[] {
    const fragments: TranscriptFragment[] = [];
    const pending: TranscriptFragment[] = [];
    for (const part of this.pending) {
      if (length >= part.text.length) { fragments.push(part); length -= part.text.length; }
      else if (length > 0) {
        // The service timestamps cover the whole packet. Preserve them rather than
        // inventing sub-packet timing when a packet contains two speakers' sentences.
        fragments.push({ ...part, id: part.id + ":head", text: part.text.slice(0, length) });
        pending.push({ ...part, id: part.id + ":tail", text: part.text.slice(length) });
        length = 0;
      } else pending.push(part);
    }
    this.pending = pending;
    return [{ side, fragments }];
  }
}
