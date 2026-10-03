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

  reset(): void { this.pending = []; }

  push(fragment: TranscriptFragment, languages: ConversationLanguages, currentSide?: Side): RoutedTranscript[] {
    this.pending.push(fragment);
    const text = this.pending.map(part => part.text).join("");
    const letters = (text.match(/\p{L}/gu) ?? []).length;
    if (letters === 0 && currentSide !== undefined) return this.take(currentSide);
    // Only complete words are evidence: "Thank y" can otherwise be classified as Spanish.
    const evidence = text.replace(/\p{L}+$/u, "");
    const side = this.resolve(evidence, languages);
    const evidenceLetters = (evidence.match(/\p{L}/gu) ?? []).length;
    const words = (evidence.match(/\p{L}+/gu) ?? []).length;
    const switching = currentSide !== undefined && side !== currentSide;
    // A partial word or a borrowed word is insufficient evidence to switch an established author.
    const enoughEvidence = switching
      ? evidenceLetters >= 8 && (words >= 2 || /[.!?。！？]\s*$/u.test(text))
      : evidenceLetters >= 4;
    if (side !== undefined && enoughEvidence) return this.take(side);
    if (text.length >= 512) return this.take(undefined);
    return [];
  }

  flush(languages: ConversationLanguages): RoutedTranscript[] {
    if (!this.pending.length) return [];
    const text = this.pending.map(part => part.text).join("");
    return this.take(this.resolve(text, languages));
  }

  private resolve(text: string, languages: ConversationLanguages): Side | undefined {
    if (languages.A === languages.B) return undefined;
    if (this.languages?.A !== languages.A || this.languages.B !== languages.B) {
      this.detector.setLanguageSubset([languages.A, languages.B]);
      this.languages = { ...languages };
    }
    const result = this.detector.detect(text.slice(0, 2000));
    if (!result.isReliable()) return undefined;
    return result.language === languages.A ? "A" : result.language === languages.B ? "B" : undefined;
  }

  private take(side: Side | undefined): RoutedTranscript[] {
    const fragments = this.pending;
    this.pending = [];
    return [{ side, fragments }];
  }
}
