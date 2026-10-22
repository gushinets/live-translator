import { earliestFragmentStart, type TranscriptFragment } from "./TranscriptFragment";
import type { Side, Turn } from "./Turn";
import { hasSentenceTerminator } from "./sentenceBoundaries";
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
    this.record({ kind: "deadline", atMs, sourceId: source.id, compatibleOutput: this.hasCompatibleOutput(source) });
  }
  private playback: Array<{ atMs: number; sourceIds: string[]; played: boolean }> = [];
  private queuedPcm = false;

  observePendingPlayback(pending: boolean, atMs: number, sources: Turn[]): void {
    if (pending && !this.queuedPcm) this.observePcm(atMs, sources, false);
    this.queuedPcm = pending;
  }

  receive(fragments: TranscriptFragment[], side: Side | undefined, sources: Turn[], nowMs: number, streamKey = ""): AttributedOutput {
    const overlaps = this.outputs.filter(output => {
      const start = earliestFragmentStart(output.fragments);
      const end = Math.max(...output.fragments.map(part => part.endMs ?? part.startMs ?? -Infinity));
      return start !== undefined && fragments.every(part => part.startMs !== undefined && part.startMs >= start &&
        part.startMs <= end && (/^[\p{P}\s]+$/u.test(part.text) || (part.endMs !== undefined && part.endMs <= end)));
    });
    const last = this.outputs.at(-1);
    const tail = last && last.streamKey === streamKey && (last.side === side || side === undefined) &&
      fragments.every(part => part.startMs === undefined) &&
      (nowMs - last.fragments.at(-1)!.receivedAtMs < runtime.captionIdleMs ||
        !hasSentenceTerminator(last.fragments.map(part => part.text).join(""))) ? last : undefined;
    const output = overlaps.length === 1 ? overlaps[0]! : tail ?? {
      id: crypto.randomUUID(), fragments: [], side, firstReceivedAtMs: Math.min(...fragments.map(part => part.receivedAtMs)),
      candidateIds: [], revision: 0, streamKey, sourceIdsAtReceipt: sources.filter(turn => !turn.translationOnly).map(turn => turn.id),
    };
    if (!this.outputs.includes(output)) this.outputs.push(output);
    for (const part of fragments) if (!output.fragments.some(known => known.id === part.id)) output.fragments.push(part);
    output.side ??= side;
    this.record({ kind: "text", atMs: nowMs, outputId: output.id });
    this.decide(output, sources, nowMs);
    return output;
  }

  reconcile(sources: Turn[], nowMs: number): AttributionChange[] {
    for (const output of this.outputs) this.decide(output, sources, nowMs);
    return this.changes.splice(0);
  }

  private possible(source: Turn, output: AttributedOutput): boolean {
    const sourceStart = earliestFragmentStart(source.sourceFragments), outputStart = earliestFragmentStart(output.fragments);
    if (sourceStart !== undefined && outputStart !== undefined && output.fragments.every(part => part.endMs !== undefined))
      return sourceStart <= Math.max(...output.fragments.map(part => part.endMs!));
    return output.sourceIdsAtReceipt.includes(source.id) || (source.speechStartAtMs ?? Infinity) < output.firstReceivedAtMs;
  }

  private decide(output: AttributedOutput, turns: Turn[], nowMs: number): boolean {
    const sources = turns.filter(turn => !turn.translationOnly);
    // Retired episodes remain competitors. A late transcript may add a previously unknown episode.
    const possible = sources.filter(source => this.possible(source, output) &&
      // A known opposite-direction translation already belonging to this source is independent evidence.
      !(source.speaker !== undefined && source.speaker === output.side && this.outputs.some(previous =>
        previous !== output && previous.side !== undefined && previous.side !== output.side &&
        sources.filter(candidate => this.possible(candidate, previous)).length === 1 && this.possible(source, previous))));
    const candidateIds = possible.map(source => source.id).sort();
    const sole = possible.length === 1 ? possible[0] : undefined;
    // Isolation is established before direction: language alone never selects among sources.
    // First late output requires the only retained episode, known source language and compatible clocks.
    const admissible = sole && (sole.status === "streaming" || sole.status === "outputting" ||
      sole.id === output.sourceId || (sources.length === 1 && (sole.outputDeadline !== undefined || sole.audioOutputStarted)));
    const sourceId = admissible && output.side !== undefined &&
      (sole.speaker !== undefined ? sole.speaker !== output.side : sources.length === 1 && sole.sourceFragments.length > 0 && sole.outputDeadline === undefined)
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
    this.playback.push({ atMs, played, sourceIds: sources.filter(turn => !turn.translationOnly &&
      (turn.speechStartAtMs ?? Infinity) <= atMs).map(turn => turn.id) });
  }

  hasCompatibleOutput(source: Turn): boolean {
    return this.outputs.some(output => this.possible(source, output) &&
      (output.side === undefined || source.speaker === undefined || source.speaker !== output.side)) ||
      this.playback.some(receipt => receipt.sourceIds.includes(source.id));
  }

  current() {
    return { matchedTextOutputs: this.outputs.filter(output => output.sourceId !== undefined).length,
      unattributedTextOutputs: this.outputs.filter(output => output.sourceId === undefined).length,
      matchedAudioOutputs: 0, unattributedPlaybackCount: this.playback.filter(receipt => receipt.played).length,
      confirmedSourceSpeechMs: null };
  }
}
