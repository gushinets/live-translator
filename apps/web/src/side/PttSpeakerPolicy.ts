import type { TranscriptFragment } from "../conversation/TranscriptFragment";
import type { Side } from "../conversation/Turn";

export interface SpeakerInterval {
  id: string;
  side: Side;
  generation: number;
  startedAtMs: number;
  endedAtMs?: number;
  speech: boolean;
  input: TranscriptFragment[];
  output: TranscriptFragment[];
}
export interface SpeakerAssignment { side?: Side; interval?: SpeakerInterval }

/** Local control time is never compared with the provider's approximate timeline. */
export class PttSpeakerPolicy {
  readonly intervals: SpeakerInterval[] = [];
  held?: SpeakerInterval;
  private listening?: SpeakerInterval;
  private readonly seen = new Set<string>();

  constructor(readonly generation: number) {
    // Capture is already open for B before the first press, including speech missed by VAD.
    this.listening = this.create("B", performance.now());
  }

  press(atMs: number): SpeakerInterval | undefined {
    if (this.held) return undefined;
    this.finish(atMs);
    this.held = this.create("A", atMs);
    return this.held;
  }

  release(atMs: number): SpeakerInterval | undefined {
    const interval = this.held;
    if (interval) interval.endedAtMs = atMs;
    this.held = undefined;
    return interval;
  }

  speech(atMs: number): SpeakerInterval {
    const interval = this.held ?? (this.listening ??= this.create("B", atMs));
    interval.speech = true;
    return interval;
  }

  finish(atMs: number): SpeakerInterval | undefined {
    const interval = this.listening;
    if (interval) interval.endedAtMs = atMs;
    this.listening = undefined;
    return interval;
  }

  accept(eventId: string | undefined, generation: number): boolean {
    if (generation !== this.generation || (eventId && this.seen.has(eventId))) return false;
    if (eventId) this.seen.add(eventId);
    return true;
  }

  assign(kind: "input" | "output", fragment: TranscriptFragment): SpeakerAssignment {
    const eligible = this.intervals;
    // shortcut: GPT-Live has no source-turn IDs or bounded clock correlation;
    // after A/B capture, retain unknown until the provider exposes that evidence.
    const sides = new Set(eligible.map(interval => interval.side));
    if (sides.size !== 1 || (kind === "output" && !eligible.some(interval => interval.speech))) return {};
    if (eligible.length === 1 && eligible[0]!.endedAtMs === undefined) {
      const interval = eligible[0]!;
      interval[kind].push(fragment);
      if (kind === "input") interval.speech = true;
      return { side: interval.side, interval };
    }
    return { side: eligible[0]!.side };
  }

  private create(side: Side, atMs: number): SpeakerInterval {
    const interval: SpeakerInterval = { id: crypto.randomUUID(), side, generation: this.generation,
      startedAtMs: atMs, speech: false, input: [], output: [] };
    this.intervals.push(interval);
    return interval;
  }
}
