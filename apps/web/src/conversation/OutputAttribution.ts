import { earliestFragmentStart, type TranscriptFragment } from "./TranscriptFragment";
import type { Side, Turn } from "./Turn";
import { isSentenceComplete } from "./sentenceBoundaries";
import { runtime } from "../config/runtime";

export interface AttributedOutput {
  id: string;
  fragments: TranscriptFragment[];
  side?: Side;
  firstReceivedAtMs: number;
  matchedAtMs?: number;
  sourceId?: string;
  candidateIds: string[];
  revision: number;
  lateOutput?: boolean;
  technicalCompleted?: boolean;
  languagePending?: boolean;
  streamKey: string;
  sourceIdsAtReceipt: string[];
}
export interface AttributionChange {
  output: Pick<AttributedOutput, "id" | "sourceId" | "revision" | "lateOutput">;
  previousSourceId?: string;
}

interface AttributionTraceEntry {
  generation: string; atMs: number; kind: "text" | "pcm" | "decision" | "revoked" | "deadline";
  outputId?: string; sourceId?: string; revision?: number; candidateIds?: string[]; candidatesTruncated?: boolean;
  compatibleOutput?: boolean; firstReceivedAtMs?: number; matchedAtMs?: number; deadlineAtMs?: number; played?: boolean; basis?: "isolated_episode" | "uncertain";
}

/** Client evidence only. Provider transcript time and local receipt time never mix. */
export class OutputAttribution {
  readonly outputs: AttributedOutput[] = [];
  readonly trace: AttributionTraceEntry[] = [];
  private readonly generation = crypto.randomUUID();
  private changes: AttributionChange[] = [];
  private pendingOutput?: AttributedOutput;

  /** A reassignment changes current evidence, never repeats a technical completion. */
  claimTechnicalCompletion(turnId: string): boolean {
    const outputs = this.outputs.filter(output => output.sourceId === turnId || output.id === turnId);
    const fresh = outputs.some(output => !output.technicalCompleted);
    for (const output of outputs) output.technicalCompleted = true;
    return fresh;
  }
  private record(entry: Omit<AttributionTraceEntry, "generation">): void {
    if (this.trace.length === 128) this.trace.shift();
    this.trace.push({ generation: this.generation, ...entry });
  }
  observeDeadline(source: Turn, atMs: number): void {
    this.record({ kind: "deadline", atMs, sourceId: source.id, compatibleOutput: this.hasCompatibleOutput(source, atMs) });
  }
  private playback: Array<{ atMs: number; sourceIds: string[]; played: boolean }> = [];
  private sources: Turn[] = [];
  private readonly speechStarts = new Map<string, number>();

  observeSourceStart(sourceId: string, atMs: number): void {
    this.speechStarts.set(sourceId, atMs);
  }

  observeReceivedPlayback(atMs: number, sources: Turn[]): void {
    this.observePcm(atMs, sources, false);
  }

  receive(fragments: TranscriptFragment[], side: Side | undefined, sources: Turn[], nowMs: number, streamKey = "", pendingSources: readonly TranscriptFragment[] = []): AttributedOutput {
    // Router splits keep the packet ID as a prefix and preserve its original clocks.
    const pending = this.pendingOutput && fragments.some(part => this.pendingOutput!.fragments.some(known =>
      part.id === known.id || part.id.startsWith(known.id + ":"))) ? this.pendingOutput : undefined;
    const neutral = fragments.every(part => /^[\p{P}\s]+$/u.test(part.text));
    const last = this.outputs.at(-1);
    const timed = this.outputs.filter(output => {
      if (output === this.pendingOutput) return false;
      const start = earliestFragmentStart(output.fragments);
      const end = Math.max(...output.fragments.map(part => part.endMs ?? part.startMs ?? -Infinity));
      return start !== undefined && fragments.every(part => part.startMs !== undefined && part.startMs >= start &&
        part.startMs <= end && (/^[\p{P}\s]+$/u.test(part.text) || (part.endMs !== undefined && part.endMs <= end)));
    });
    // Historical lexical continuation needs a unique interval across all language groups.
    const overlaps = timed.filter(output => (output.side === side || (side === undefined && neutral)) &&
      (neutral || output === last || timed.length === 1));
    const unfinished = last && !isSentenceComplete(last.fragments.map(part => part.text).join(""));
    const adjacent = last && last.fragments.at(-1)!.endMs !== undefined &&
      fragments[0]?.startMs === last.fragments.at(-1)!.endMs;
    const tail = last && last !== this.pendingOutput && last.streamKey === streamKey && (last.side === side || (side === undefined && neutral)) &&
      ((fragments.every(part => part.startMs === undefined) &&
        (nowMs - last.fragments.at(-1)!.receivedAtMs < runtime.captionIdleMs || unfinished)) ||
        (adjacent && unfinished)) ? last : undefined;
    const output = pending ?? (overlaps.length === 1 ? overlaps[0]! : tail) ?? {
      id: crypto.randomUUID(), fragments: [], side, firstReceivedAtMs: Math.min(...fragments.map(part => part.receivedAtMs)),
      candidateIds: [], revision: 0, streamKey, sourceIdsAtReceipt: sources.filter(turn => !turn.translationOnly).map(turn => turn.id),
    };
    if (pending) {
      output.fragments = [];
      output.side = side;
      output.languagePending = false;
      this.pendingOutput = undefined;
    }
    if (!this.outputs.includes(output)) this.outputs.push(output);
    for (const part of fragments) if (!output.fragments.some(known => known.id === part.id)) output.fragments.push(part);
    output.side ??= side;
    this.record({ kind: "text", atMs: nowMs, outputId: output.id });
    this.decide(output, sources, nowMs, pendingSources);
    return output;
  }

  /** Observe the unresolved router tail now; later language evidence refines the same receipt. */
  observePending(fragments: readonly TranscriptFragment[], sources: Turn[], nowMs: number, streamKey = "", pendingSources: readonly TranscriptFragment[] = []): void {
    if (!fragments.length) return;
    const output = this.pendingOutput ??= {
      id: crypto.randomUUID(), fragments: [], languagePending: true, firstReceivedAtMs: Math.min(...fragments.map(part => part.receivedAtMs)),
      candidateIds: [], revision: 0, streamKey, sourceIdsAtReceipt: sources.filter(turn => !turn.translationOnly).map(turn => turn.id),
    };
    output.fragments = [...fragments];
    if (!this.outputs.includes(output)) this.outputs.push(output);
    this.record({ kind: "text", atMs: nowMs, outputId: output.id });
    this.decide(output, sources, nowMs, pendingSources);
  }

  reconcile(sources: Turn[], nowMs: number, pendingSources: readonly TranscriptFragment[] = []): AttributionChange[] {
    this.sources = sources;
    const isolatedDirections = this.isolatedDirections(sources.filter(turn => !turn.translationOnly), pendingSources);
    for (const output of this.outputs) this.decide(output, sources, nowMs, pendingSources, isolatedDirections);
    return this.changes.splice(0);
  }

  private possible(source: Turn, output: AttributedOutput): boolean {
    const sourceStart = earliestFragmentStart(source.sourceFragments), outputStart = earliestFragmentStart(output.fragments);
    if (sourceStart !== undefined && outputStart !== undefined && output.fragments.every(part => part.endMs !== undefined))
      return sourceStart <= Math.max(...output.fragments.map(part => part.endMs!));
    // ASR receipt time is not speech onset; only an observed VAD boundary can exclude untimed later speech.
    return output.sourceIdsAtReceipt.includes(source.id) || (this.speechStarts.get(source.id) ?? -Infinity) <= output.firstReceivedAtMs;
  }

  private hasPendingSource(output: AttributedOutput, pendingSources: readonly TranscriptFragment[]): boolean {
    return pendingSources.some(part => !/^[\p{P}\s]+$/u.test(part.text) &&
      (part.startMs === undefined || output.fragments.some(fragment => fragment.endMs === undefined) ||
        part.startMs <= Math.max(...output.fragments.map(fragment => fragment.endMs!))));
  }

  private isolatedDirections(sources: Turn[], pendingSources: readonly TranscriptFragment[]): Map<string, Set<Side>> {
    const directions = new Map<string, Set<Side>>();
    for (const previous of this.outputs) {
      if (previous.side === undefined || this.hasPendingSource(previous, pendingSources)) continue;
      const candidates = sources.filter(source => this.possible(source, previous));
      if (candidates.length !== 1) continue;
      const id = candidates[0]!.id;
      if (!directions.has(id)) directions.set(id, new Set());
      directions.get(id)!.add(previous.side);
    }
    return directions;
  }

  private decide(output: AttributedOutput, turns: Turn[], nowMs: number, pendingSources: readonly TranscriptFragment[],
    isolatedDirections = this.isolatedDirections(turns.filter(turn => !turn.translationOnly), pendingSources)): boolean {
    const sources = turns.filter(turn => !turn.translationOnly);
    // Retired episodes remain competitors. A late transcript may add a previously unknown episode.
    const possible = sources.filter(source => this.possible(source, output) &&
      // A known opposite-direction translation already belonging to this source is independent evidence.
      !(source.speaker !== undefined && source.speaker === output.side &&
        isolatedDirections.get(source.id)?.has(output.side === "A" ? "B" : "A")));
    const candidateIds = possible.map(source => source.id).sort();
    const sole = possible.length === 1 ? possible[0] : undefined;
    // Isolation is established before direction: language alone never selects among sources.
    // First late output requires the only retained episode, known source language and compatible clocks.
    const observedWhileOpen = sole?.turnCompletedAtMs !== undefined && output.firstReceivedAtMs <= sole.turnCompletedAtMs &&
      (sole.outputDeadline === undefined || output.firstReceivedAtMs <= sole.outputDeadline.atMs);
    // Retain on-time historical evidence, not a previous assignment of this output.
    const admissible = !this.hasPendingSource(output, pendingSources) && sole &&
      (sole.status === "streaming" || sole.status === "outputting" || observedWhileOpen ||
        (sources.length === 1 && pendingSources.length === 0 && (sole.outputDeadline !== undefined || sole.audioOutputStarted)));
    const sourceId = admissible && output.side !== undefined && sole.speaker !== undefined && sole.speaker !== output.side
      ? sole.id : undefined;
    const lateOutput = sourceId && sole?.outputDeadline ? output.firstReceivedAtMs > sole.outputDeadline.atMs : undefined;
    if (sourceId === output.sourceId && candidateIds.join() === output.candidateIds.join() && lateOutput === output.lateOutput && output.revision > 0) return false;
    const previousSourceId = output.sourceId;
    output.revision++;
    if (output.revision > 1) this.changes.push({ output: { id: output.id, revision: output.revision, sourceId, lateOutput }, previousSourceId });
    this.record({ kind: previousSourceId && previousSourceId !== sourceId ? "revoked" : "decision", atMs: nowMs,
      outputId: output.id, sourceId, revision: output.revision, firstReceivedAtMs: output.firstReceivedAtMs,
      matchedAtMs: sourceId ? nowMs : undefined, deadlineAtMs: sourceId ? sole?.outputDeadline?.atMs : undefined, candidateIds: candidateIds.slice(0, 16),
      candidatesTruncated: candidateIds.length > 16, basis: sourceId ? "isolated_episode" : "uncertain" });
    output.sourceId = sourceId;
    output.candidateIds = candidateIds;
    output.lateOutput = lateOutput;
    output.matchedAtMs = sourceId ? nowMs : undefined;
    return true;
  }

  observePlayback(atMs: number, sources: Turn[]): void {
    // Worklet labels originate in caption routing, not provider correlation: they cannot prove PCM ownership.
    this.observePcm(atMs, sources, true);
  }

  private observePcm(atMs: number, sources: Turn[], played: boolean): void {
    this.record({ kind: "pcm", atMs, played });
    this.sources = sources;
    const eligible = sources.filter(turn => !turn.translationOnly && (turn.speechStartAtMs ?? Infinity) <= atMs);
    this.playback.push({ atMs, played, sourceIds: eligible.map(turn => turn.id) });
  }

  hasCompatibleOutput(source: Turn, atMs = Infinity): boolean {
    return this.outputs.some(output => output.firstReceivedAtMs <= atMs && this.possible(source, output) &&
      (output.side === undefined || source.speaker === undefined || source.speaker !== output.side)) ||
      this.playback.some(receipt => {
        if (receipt.atMs > atMs) return false;
        if (receipt.sourceIds.includes(source.id)) return true;
        const start = earliestFragmentStart(source.sourceFragments);
        // A late transcript can reveal old speech; receipt UUIDs alone cannot exclude it.
        const ends = this.sources.filter(turn => receipt.sourceIds.includes(turn.id)).flatMap(turn =>
          turn.sourceFragments.flatMap(part => part.endMs === undefined && part.startMs === undefined ? [] : [part.endMs ?? part.startMs!]));
        if (start === undefined || (ends.length && start > Math.max(...ends))) return false;
        return ![...this.speechStarts].some(([id, speechAtMs]) => {
          if (speechAtMs <= receipt.atMs) return false;
          if (id === source.id) return true;
          const boundary = earliestFragmentStart(this.sources.find(turn => turn.id === id)?.sourceFragments);
          return boundary !== undefined ? start >= boundary : (source.speechStartAtMs ?? Infinity) >= speechAtMs;
        });
      });
  }

  current() {
    return { matchedTextOutputs: this.outputs.filter(output => output.sourceId !== undefined).length,
      unattributedTextOutputs: this.outputs.filter(output => output.sourceId === undefined).length,
      matchedAudioOutputs: 0, unattributedPlaybackCount: this.playback.filter(receipt => receipt.played).length,
      confirmedSourceSpeechMs: null };
  }
}
