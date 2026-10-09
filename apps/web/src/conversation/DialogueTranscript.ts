import { eld } from "eld/extrasmall";
import { hasSentenceTerminator } from "./sentenceBoundaries";
import type { ConversationLanguages } from "../side/SideResolver";
import { orderTranscriptFragments, type TranscriptFragment } from "./TranscriptFragment";
import type { Side } from "./Turn";
import { completeScriptSide, shortReplyEvidence, isExplicitShortReply, languageScripts, scriptPattern, splitLanguageSentences, languageDetectionSample, isDottedContinuation } from "./languageScripts";

export interface DialogueBlock {
  id: string;
  kind: "input" | "output";
  text: string;
  side?: Side;
  language?: string;
  receivedAtMs: number;
}
interface Stream {
  id: number;
  kind: DialogueBlock["kind"];
  languages: ConversationLanguages;
  fragments: TranscriptFragment[];
  blocks: DialogueBlock[];
}

/** Display-only transcript. Neither idle timers nor service Turn IDs define paragraphs. */
export class DialogueTranscript {
  blocks: readonly DialogueBlock[] = [];
  private history: DialogueBlock[] = [];
  private streams: Partial<Record<DialogueBlock["kind"], Stream>> = {};
  private sequence = 0;
  private readonly assigned = new Map<string, { block: DialogueBlock; fragments: TranscriptFragment[] }>();
  private readonly detector = eld.newInstance();

  /** PTT ownership is authoritative, including unknown; language never reroutes it. */
  pushAssigned(kind: DialogueBlock["kind"], fragment: TranscriptFragment, languages: ConversationLanguages,
    key: string, side?: Side): void {
    if (!fragment.text) return;
    const id = `${kind}:${key}`;
    const entry = this.assigned.get(id) ?? { block: { id: `ptt:${this.sequence++}`, kind,
      text: "", side, language: side ? languages[side] : undefined, receivedAtMs: fragment.receivedAtMs }, fragments: [] };
    entry.fragments.push(fragment);
    entry.block = { ...entry.block, text: orderTranscriptFragments(entry.fragments).map(part => part.text).join("") };
    this.assigned.set(id, entry);
    this.publish();
  }

  push(kind: DialogueBlock["kind"], fragment: TranscriptFragment, languages: ConversationLanguages): void {
    if (!fragment.text) return;
    const previous = this.streams[kind];
    if (previous && (previous.languages.A !== languages.A || previous.languages.B !== languages.B)) this.seal();
    const stream = this.streams[kind] ??= { id: this.sequence++, kind, languages: { ...languages }, fragments: [], blocks: [] };
    stream.fragments.push(fragment);
    const fragments = orderTranscriptFragments(stream.fragments);
    const text = fragments.map(part => part.text).join("");
    const runs = this.languageRuns(text, languages);
    let position = 0;
    const bounds = fragments.map(part => {
      const start = position;
      position += part.text.length;
      return { start, end: position, receivedAtMs: part.receivedAtMs };
    });
    let offset = 0;
    let fragmentIndex = 0;
    stream.blocks = runs.map(run => {
      const start = offset;
      offset += run.text.length;
      // A leading space may belong to the previous packet, before this phrase existed.
      const contentStart = start + Math.max(0, run.text.search(/\S/u));
      while (bounds[fragmentIndex] && bounds[fragmentIndex]!.end <= contentStart) fragmentIndex++;
      let receivedAtMs = Infinity;
      for (let index = fragmentIndex; bounds[index] && bounds[index]!.start < offset; index++) {
        receivedAtMs = Math.min(receivedAtMs, bounds[index]!.receivedAtMs);
      }
      return { ...run, id: `${stream.id}:${start}`, kind, language: run.side ? languages[run.side] : undefined,
        receivedAtMs };
    });
    this.publish();
  }

  /** A transport/language boundary seals context, but retains the visible history. */
  seal(): void {
    this.history = [...this.blocks];
    this.streams = {};
    this.assigned.clear();
  }

  clear(): void {
    this.history = [];
    this.streams = {};
    this.blocks = [];
    this.assigned.clear();
  }

  private publish(): void {
    const blocks = [...this.history];
    const cursors = Object.values(this.streams).map(stream => ({ blocks: stream.blocks, index: 0 }));
    // Merge stream heads by arrival, without undoing timestamp order inside a stream.
    while (true) {
      const available = cursors.filter(cursor => cursor.index < cursor.blocks.length);
      if (!available.length) break;
      const next = available.reduce((a, b) => a.blocks[a.index]!.receivedAtMs <= b.blocks[b.index]!.receivedAtMs ? a : b);
      blocks.push(next.blocks[next.index++]!);
    }
    this.blocks = this.assigned.size ? [...blocks, ...Array.from(this.assigned.values(), entry => entry.block)]
      .sort((a, b) => a.receivedAtMs - b.receivedAtMs) : blocks;
  }

  private languageRuns(text: string, languages: ConversationLanguages): Array<{ text: string; side?: Side }> {
    const scriptsA = languageScripts(languages.A), scriptsB = languageScripts(languages.B);
    const a = scriptPattern(scriptsA), b = scriptPattern(scriptsB);
    const runs: Array<{ text: string; side?: Side }> = [];
    this.detector.setLanguageSubset([languages.A, languages.B]);
    const append = (text: string, side?: Side) => {
      const last = runs.at(-1);
      if (last && last.side === side) last.text += text;
      else runs.push({ text, side });
    };
    if (a && b && !scriptsA.some(script => scriptsB.includes(script))) {
      // Re-read the accumulated stream, not individual packets: even a surname
      // arriving one character at a time stays in the same script run.
      for (const character of text) {
        const side = /\p{L}/u.test(character)
          ? a.test(character) ? "A" : b.test(character) ? "B" : undefined
          : runs.at(-1)?.side;
        append(character, side);
      }
      // A name or borrowed word inside a sentence is not a speaker change.
      // Use the neighbouring sentence context, while preserving complete replies.
      const sentences = runs.flatMap(run => run.side === undefined ? [run]
        : splitLanguageSentences(run.text, languages, this.detector).map(text => ({ text, side: run.side })));
      const sentenceContexts: string[] = [];
      let contextStart = 0, contextText = "";
      for (let index = 0; index < sentences.length; index++) {
        contextText += sentences[index]!.text;
        if (hasSentenceTerminator(sentences[index]!.text) || index === sentences.length - 1) {
          for (let part = contextStart; part <= index; part++) sentenceContexts[part] = contextText;
          contextStart = index + 1;
          contextText = "";
        }
      }
      const contextual = sentences.map((run, index) => {
        if (run.side !== undefined && isExplicitShortReply(run.text, languages[run.side])) return run;
        const previous = sentences[index - 1], next = sentences[index + 1];
        const before = previous?.text.match(/\P{Sentence_Terminal}*$/u)?.[0] ?? "";
        const after = next?.text.match(/^\P{Sentence_Terminal}*/u)?.[0] ?? "";
        const previousSide = /\p{L}/u.test(before) ? previous?.side : undefined;
        const nextSide = !hasSentenceTerminator(run.text) && /\p{L}/u.test(after) ? next?.side : undefined;
        const surroundingSide = previousSide ?? nextSide;
        if (run.side !== undefined &&
            surroundingSide !== undefined && surroundingSide !== run.side &&
            (nextSide === undefined || previousSide === undefined || nextSide === previousSide)) {
          const standalone = this.detector.detect(languageDetectionSample(run.text));
          const embedded = previousSide !== undefined && previousSide === nextSide;
          const dot = run.text.indexOf(".");
          const dottedToken = !/\s/u.test(run.text.trim()) && dot >= 0 &&
            isDottedContinuation(run.text.slice(0, dot + 1), run.text.slice(dot + 1));
          // A domain label's Latin spelling is not evidence of an English speaker.
          if (!embedded && !dottedToken && standalone.isReliable() && standalone.language === languages[run.side]) return run;
          const context = this.detector.detect(languageDetectionSample(sentenceContexts[index]!));
          if (context.isReliable() && context.language === languages[surroundingSide]) {
            return { ...run, side: surroundingSide };
          }
        }
        return run;
      });
      const phrases: typeof runs = [];
      for (let index = 0; index < contextual.length; index++) {
        const run = contextual[index]!, previous = phrases.at(-1);
        if (previous && previous.side === run.side && sentenceContexts[index] === sentenceContexts[index - 1]) {
          previous.text += run.text;
        } else phrases.push({ ...run });
      }
      // Decide each sentence before coalescing it with a new unfinished tail.
      // A neutral suffix cannot revoke the language of a completed short reply.
      for (let index = 0; index < phrases.length; index++) {
        const run = phrases[index]!;
        const letters = (run.text.match(/\p{L}/gu) ?? []).length;
        if (letters >= 4 || completeScriptSide(run.text, languages) === run.side) continue;
        if (!letters && phrases[index - 1]?.side === run.side) continue;
        run.side = undefined;
      }
      // Neutral prefixes (numbers, quotes, punctuation) wait for the first language.
      const prefix = phrases[0];
      if (prefix && prefix.side === undefined && !/\p{L}/u.test(prefix.text) && phrases[1]?.side) {
        prefix.side = phrases[1].side;
      }
      runs.length = 0;
      for (const run of phrases) append(run.text, run.side);
      return runs;
    }
    // ponytail: same-script switches require sentence evidence in this prototype;
    // no reliable diarization can be inferred from a bare ambiguous word.
    for (const sentence of splitLanguageSentences(text, languages, this.detector)) {
      const reply = shortReplyEvidence(sentence, languages);
      if (reply === "ambiguous") { append(sentence); continue; }
      const scriptSide = reply ?? completeScriptSide(sentence, languages);
      if (scriptSide !== undefined) { append(sentence, scriptSide); continue; }
      const evidence = sentence.replace(/\p{L}+$/u, "");
      const result = this.detector.detect(languageDetectionSample(evidence));
      const side = languages.A === languages.B || !result.isReliable() ? undefined
        : result.language === languages.A ? "A" : result.language === languages.B ? "B" : undefined;
      append(sentence, side);
    }
    return runs;
  }
}
