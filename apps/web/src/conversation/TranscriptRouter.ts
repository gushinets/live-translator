import { eld } from "eld/extrasmall";
import type { ConversationLanguages } from "../side/SideResolver";
import type { Side } from "./Turn";
import type { TranscriptFragment } from "./TranscriptFragment";

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

  reset(): void { this.pending = []; this.currentSide = undefined; }

  get hasPending(): boolean { return this.pending.length > 0; }

  push(fragment: TranscriptFragment, languages: ConversationLanguages, currentSide?: Side): RoutedTranscript[] {
    this.pending.push(fragment);
    this.currentSide = currentSide;
    const text = this.pending.map(part => part.text).join("");
    if (/^[\p{P}\s]+$/u.test(text) && currentSide !== undefined) return this.take(currentSide);
    // Only complete words are evidence: "Thank y" can otherwise be classified as Spanish.
    const evidence = text.replace(/\p{L}+$/u, "");
    const side = this.resolve(evidence, languages);
    if (side !== undefined && this.hasEvidence(evidence, text, side, currentSide)) return this.take(side);
    if (text.length >= 512) return this.take(undefined);
    return [];
  }

  flush(languages: ConversationLanguages, force = false): RoutedTranscript[] {
    if (!this.pending.length) return [];
    const text = this.pending.map(part => part.text).join("");
    const evidence = text.replace(/\p{L}+$/u, "");
    const side = this.resolve(evidence, languages);
    if (side !== undefined && this.hasEvidence(evidence, text, side, this.currentSide)) return this.take(side);
    const fullSide = this.resolve(text, languages);
    // An unreliable prefix is only a consistency check for a reliable full phrase;
    // it never establishes an author by itself. "Thank y" fails that check.
    if (fullSide !== undefined && this.resolve(evidence, languages, false) === fullSide &&
        this.hasEvidence(text, text, fullSide, this.currentSide)) return this.take(fullSide);
    // A script distinction can identify a language even before the last word is
    // complete. A pause cannot make an unfinished Latin word Spanish or English.
    const distinctScripts = new Intl.Locale(languages.A).maximize().script !== new Intl.Locale(languages.B).maximize().script;
    if (distinctScripts && fullSide !== undefined && this.hasEvidence(text, text, fullSide, this.currentSide)) return this.take(fullSide);
    if (!force && fullSide !== undefined && /\p{L}$/u.test(text)) return [];
    return this.take(undefined);
  }

  private hasEvidence(evidence: string, text: string, side: Side, currentSide?: Side): boolean {
    const letters = (evidence.match(/\p{L}/gu) ?? []).length;
    const words = (evidence.match(/\p{L}+/gu) ?? []).length;
    return currentSide !== undefined && side !== currentSide
      ? letters >= 8 && (words >= 2 || /[.!?。！？]\s*$/u.test(text))
      : letters >= 4;
  }

  private resolve(text: string, languages: ConversationLanguages, requireReliable = true): Side | undefined {
    if (languages.A === languages.B) return undefined;
    if (this.languages?.A !== languages.A || this.languages.B !== languages.B) {
      this.detector.setLanguageSubset([languages.A, languages.B]);
      this.languages = { ...languages };
    }
    const result = this.detector.detect(text.slice(0, 2000));
    if (requireReliable && !result.isReliable()) return undefined;
    return result.language === languages.A ? "A" : result.language === languages.B ? "B" : undefined;
  }

  private take(side: Side | undefined): RoutedTranscript[] {
    const fragments = this.pending;
    this.pending = [];
    return [{ side, fragments }];
  }
}
