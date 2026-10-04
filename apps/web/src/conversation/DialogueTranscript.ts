import { eld } from "eld/extrasmall";
import type { ConversationLanguages } from "../side/SideResolver";
import { orderTranscriptFragments, type TranscriptFragment } from "./TranscriptFragment";
import type { Side } from "./Turn";

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
  private readonly detector = eld.newInstance();

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
      while (bounds[fragmentIndex] && bounds[fragmentIndex]!.end <= start) fragmentIndex++;
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
  }

  clear(): void {
    this.history = [];
    this.streams = {};
    this.blocks = [];
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
    this.blocks = blocks;
  }

  private languageRuns(text: string, languages: ConversationLanguages): Array<{ text: string; side?: Side }> {
    const scriptsA = languageScripts(languages.A), scriptsB = languageScripts(languages.B);
    const a = scriptPattern(scriptsA), b = scriptPattern(scriptsB);
    const runs: Array<{ text: string; side?: Side }> = [];
    const append = (text: string, side?: Side) => {
      const last = runs.at(-1);
      if (last && last.side === side) last.text += text;
      else runs.push({ text, side });
    };
    if (a && b && !scriptsA.some(script => scriptsB.includes(script))) {
      // Re-read the accumulated stream, not individual packets: even a surname
      // arriving one character at a time stays in the same script run.
      for (const character of text) {
        const side = a.test(character) ? "A" : b.test(character) ? "B"
          : /\p{L}/u.test(character) ? undefined : runs.at(-1)?.side;
        append(character, side);
      }
      return runs.map(run => ({ ...run, side: (run.text.match(/\p{L}/gu)?.length ?? 0) >= 4 ? run.side : undefined }));
    }
    this.detector.setLanguageSubset([languages.A, languages.B]);
    // ponytail: same-script switches require sentence evidence in this prototype;
    // no reliable diarization can be inferred from a bare ambiguous word.
    for (const sentence of text.match(/[^.!?。！？]*[.!?。！？]+|[^.!?。！？]+$/gu) ?? []) {
      const evidence = sentence.replace(/\p{L}+$/u, "");
      const result = this.detector.detect(evidence.slice(0, 2000));
      const side = languages.A === languages.B || !result.isReliable() ? undefined
        : result.language === languages.A ? "A" : result.language === languages.B ? "B" : undefined;
      append(sentence, side);
    }
    return runs;
  }
}

function languageScripts(language: string): string[] {
  const script = new Intl.Locale(language).maximize().script;
  return script === "Jpan" ? ["Han", "Hiragana", "Katakana"]
    : script === "Kore" ? ["Hangul", "Han"] : script === "Hans" || script === "Hant" ? ["Han"] : script ? [script] : [];
}

function scriptPattern(scripts: string[]): RegExp | undefined {
  if (!scripts.length) return undefined;
  try { return new RegExp(scripts.map(value => `\\p{Script=${value}}`).join("|"), "u"); }
  catch { return undefined; }
}
