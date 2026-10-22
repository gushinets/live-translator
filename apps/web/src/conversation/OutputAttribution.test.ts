import { describe, expect, it, vi } from "vitest";
import { UsageReporter, type ProductObservation } from "../metrics/UsageReporter";
import { ConversationMetrics } from "../metrics/ConversationMetrics";
import { sessionReducer } from "../session/sessionReducer";
import { createInitialSession } from "../session/SessionState";
import { DialogueTranscript } from "./DialogueTranscript";
import { OutputAttribution } from "./OutputAttribution";
import { createTurn } from "./TurnBuffer";
import type { Turn } from "./Turn";
import type { TranscriptFragment } from "./TranscriptFragment";
const fragment = (id: string, startMs: number, endMs: number, receivedAtMs = 1000): TranscriptFragment => ({ id, text: "Texto.", startMs, endMs, receivedAtMs });
const source = (id: string, startMs: number, speaker: "A" | "B" = "A", status: Turn["status"] = "streaming"): Turn => ({ ...createTurn({ id, speaker, sideSource: "language", nowMs: 0 }), status, originalText: "Source", sourceFragments: [fragment(id, startMs, startMs + 100)], languages: { A: "ru", B: "es" } });

describe("output attribution evidence", () => {
  it("revises the same receipt from A1 to uncertain to A2 without changing first receipt", () => {
    const ledger = new OutputAttribution();
    const a1 = source("a1", 0), a2 = source("a2", 50);
    const output = ledger.receive([fragment("out", 200, 300)], "B", [a1], 1000);
    expect(output.sourceId).toBe("a1");
    expect(ledger.reconcile([a1, a2], 1200)).toHaveLength(1);
    expect(output.sourceId).toBeUndefined();
    expect(output.candidateIds).toEqual(["a1", "a2"]);
    a1.sourceFragments = [fragment("corrected", 400, 500)];
    ledger.reconcile([a1, a2], 1500);
    expect(output.sourceId).toBe("a2");
    expect(output.firstReceivedAtMs).toBe(1000);
    expect(output.matchedAtMs).toBe(1500);
    expect(output.revision).toBe(3);
    expect(ledger.reconcile([a1, a2], 1600)).toEqual([]);
    expect(ledger.outputs).toHaveLength(1);
  });
  it("recognizes historical continuation before a fresh speaker and does not choose a new old-language answer", () => {
    const ledger = new OutputAttribution();
    const a = source("a", 0);
    const output = ledger.receive([fragment("o1", 100, 500)], "B", [a], 1000);
    a.status = "completed";
    const b = source("b", 600, "B");
    expect(ledger.receive([{ ...fragment("punct", 450, 450, 1200), text: "." }], undefined, [a, b], 1200).id).toBe(output.id);
    const next = ledger.receive([fragment("o2", 700, 800, 1300)], "B", [a, b], 1300);
    expect(next.id).not.toBe(output.id);
    expect(next.sourceId).toBeUndefined();
  });
  it("allows the first isolated late result but retains a failed competitor", () => {
    const a = source("a", 0, "A", "failed");
    a.outputDeadline = { atMs: 900, outcome: "no_observed_output" };
    const isolated = new OutputAttribution().receive([fragment("o", 200, 300)], "B", [a], 1200);
    expect(isolated.sourceId).toBe("a");
    expect(isolated.lateOutput).toBe(true);
    const ambiguous = new OutputAttribution().receive([fragment("o", 200, 300)], "B", [a, source("a2", 100)], 1200);
    expect(ambiguous.sourceId).toBeUndefined();
    expect(ambiguous.candidateIds).toEqual(["a", "a2"]);
  });
  it("discovers a delayed source using provider time, not the wall clock", () => {
    const ledger = new OutputAttribution();
    const out = ledger.receive([fragment("o", 200, 300, 1000)], "B", [], 1000);
    const delayed = source("a", 0); delayed.speechStartAtMs = 2000;
    delayed.outputDeadline = { atMs: 1500, outcome: "unresolved" };
    ledger.reconcile([delayed], 2500);
    expect(out.sourceId).toBe("a");
    expect(out.lateOutput).toBe(false);
    expect(out.matchedAtMs).toBe(2500);
    expect(ledger.current().matchedTextOutputs).toBe(1);
    expect(ledger.current().confirmedSourceSpeechMs).toBeNull();
  });
  it("does not let really later speech or direction alone choose an owner", () => {
    const ledger = new OutputAttribution();
    const out = ledger.receive([fragment("o", 200, 300)], "B", [source("a", 0), source("b", 100, "B")], 1000);
    expect(out.sourceId).toBeUndefined();
    ledger.reconcile([source("a", 400)], 2000);
    expect(out.candidateIds).toEqual([]);
  });
  it("does not attribute text with unknown language, or PCM from a text owner", () => {
    const ledger = new OutputAttribution();
    const a = source("a", 0);
    expect(ledger.receive([fragment("o", 200, 300)], undefined, [a], 1000).sourceId).toBeUndefined();
    ledger.observePlayback(1200, [a]);
    expect(ledger.hasCompatibleOutput(a)).toBe(true);
    expect(ledger.current().unattributedPlaybackCount).toBe(1);
    expect(ledger.current().matchedAudioOutputs).toBe(0);
  });
  it("retains already drained PCM as deadline evidence, without claiming delivery owner", () => {
    const ledger = new OutputAttribution(), a = source("a", 0);
    ledger.observePlayback(1000, [a]);
    expect(ledger.hasCompatibleOutput(a)).toBe(true);
    expect(ledger.hasCompatibleOutput(source("later", 5000))).toBe(false);
  });
  it("converges for either order of evidence and keeps a previously published snapshot immutable", () => {
    const a1 = source("a1", 0), a2 = source("a2", 50), ledger = new OutputAttribution();
    ledger.receive([fragment("o", 200, 300)], "B", [a1], 1000);
    const intermediate = ledger.current();
    ledger.reconcile([a1, a2], 1200);
    const other = new OutputAttribution(); other.receive([fragment("o", 200, 300)], "B", [a2, a1], 1000);
    expect(ledger.current()).toEqual(other.current());
    expect(intermediate.matchedTextOutputs).toBe(1);
    expect(ledger.outputs[0]?.candidateIds).toEqual(["a1", "a2"]);
  });
});

it("traces receipts, decision revisions and deadlines without content and with a fixed bound", () => {
  const ledger = new OutputAttribution(), a = source("a", 0);
  const output = ledger.receive([{ ...fragment("private", 200, 300), text: "PRIVATE SPEECH" }], "B", [a], 1000);
  ledger.reconcile([a, source("a2", 50)], 1100);
  ledger.observeDeadline(a, 1200);
  expect(ledger.trace.some(entry => entry.kind === "revoked" && entry.outputId === output.id)).toBe(true);
  expect(ledger.trace.some(entry => entry.kind === "deadline" && entry.compatibleOutput === true)).toBe(true);
  for (let index = 0; index < 200; index++) ledger.observePlayback(1300 + index, [a]);
  expect(ledger.trace.length).toBeLessThanOrEqual(128);
  expect(JSON.stringify(ledger.trace)).not.toContain("PRIVATE SPEECH");
});

it("reconsiders dependent evidence in either order rather than retaining a self-supporting owner", () => {
  const a = source("a", 0), b = source("b", 50, "B");
  const early = new OutputAttribution();
  early.receive([fragment("o1", 100, 200)], "B", [a], 1000);
  early.receive([fragment("o2", 300, 400, 1100)], "A", [a, b], 1100);
  early.reconcile([a, b], 1200);
  const together = new OutputAttribution();
  together.receive([fragment("o1", 100, 200)], "B", [a, b], 1000);
  together.receive([fragment("o2", 300, 400, 1100)], "A", [a, b], 1100);
  together.reconcile([a, b], 1200);
  expect(early.outputs.map(out => out.sourceId)).toEqual(together.outputs.map(out => out.sourceId));
});

it("never uses unknown source speech as an isolated first late answer", () => {
  const unknown = { ...source("unknown", 0, "A", "failed"), speaker: undefined,
    outputDeadline: { atMs: 900, outcome: "no_observed_output" as const } };
  expect(new OutputAttribution().receive([fragment("o", 200, 300)], "B", [unknown], 1000).sourceId).toBeUndefined();
});

it("consumes technical text completion once for the stable output across rebinding", () => {
  const ledger = new OutputAttribution(), a1 = source("a1", 0), a2 = source("a2", 50);
  const out = ledger.receive([fragment("o", 200, 300)], "B", [a1], 1000);
  expect(ledger.claimTechnicalCompletion("a1")).toBe(true);
  ledger.reconcile([a1, a2], 1100);
  a1.sourceFragments = [fragment("later", 400, 500)];
  ledger.reconcile([a1, a2], 1200);
  expect(out.sourceId).toBe("a2");
  expect(ledger.claimTechnicalCompletion("a2")).toBe(false);
  expect(ledger.claimTechnicalCompletion("a2")).toBe(false);
});

it("freezes each queued decision revision even when more evidence arrives before projection", () => {
  const ledger = new OutputAttribution(), a = source("a", 0), b = source("b", 50);
  const out = ledger.receive([fragment("o", 200, 300)], "B", [a], 1000);
  ledger.receive([fragment("p1", 210, 220)], "B", [a, b], 1100);
  a.sourceFragments = [fragment("later", 400, 500)];
  ledger.receive([fragment("p2", 230, 240)], "B", [a, b], 1200);
  expect(ledger.reconcile([a, b], 1300).map(change => [change.output.revision, change.output.sourceId])).toEqual([[2, undefined], [3, "b"]]);
  expect(out.firstReceivedAtMs).toBe(1000);
});

it("preserves published speech and counters through revisions while both evidence orders converge", async () => {
  const a1 = source("a1", 0), a2 = source("a2", 50), ledger = new OutputAttribution();
  const metrics = new ConversationMetrics(), captions = new DialogueTranscript();
  const outbox = { enqueue: vi.fn().mockResolvedValue(undefined), finishProducer: vi.fn(), noProvider: vi.fn() };
  let now = 0;
  const observation: ProductObservation = { atMs: 0, visible: true, state: "listening", interpreterReady: true,
    mediaReady: true, speechEligible: true, counters: {} };
  const reporter = new UsageReporter("attempt", "conversation", outbox, { now: () => now, automatic: false, initial: observation });
  for (now = 0; now <= 100; now += 50) reporter.observeProduct({ ...observation, atMs: now, turnId: a1.id, sample: { atMs: now, active: now < 100 } });
  const output = ledger.receive([fragment("o", 200, 300)], "B", [], 1000);
  ledger.reconcile([a1], 1100);
  ledger.observePlayback(1100, [a1]);
  expect(ledger.claimTechnicalCompletion(a1.id)).toBe(true);
  metrics.recordTechnicalOutcome(a1.id, "audio");
  reporter.observeProduct({ ...observation, atMs: 150, completedTurnId: a1.id, counters: { audioCompletedTurnCount: 1 } });
  reporter.observeUsage({ kind: "checkpoint", seconds: 15 }); await reporter.idle();
  const intermediate = structuredClone(outbox.enqueue.mock.calls[0]![2]);
  a1.status = "completed";
  const changes = ledger.reconcile([a1, a2], 1200);
  for (const { output: decision, previousSourceId } of changes) if (previousSourceId && previousSourceId !== decision.sourceId)
    metrics.recordAttributionEvent("attributionRevokedCount", `${decision.id}:${decision.revision}`);
  const state = { ...createInitialSession({ side: "A", hasAcceptedConversationSpeech: true }, { side: "B", hasAcceptedConversationSpeech: false }),
    state: "listening" as const, activeTurn: a2, recentTurns: [a1] };
  const uncertain = sessionReducer(state, { type: "OUTPUT_ATTRIBUTION", outputs: ledger.outputs, sourceIds: [a1.id, a2.id] });
  expect(uncertain.recentTurns.find(turn => turn.id === output.id)?.status).toBe("completed");
  expect(uncertain.recentTurns.find(turn => turn.id === a1.id)?.status).toBe("completed");
  a1.sourceFragments = [fragment("corrected", 400, 500)];
  ledger.reconcile([a1, a2], 1300);
  expect(ledger.claimTechnicalCompletion(a2.id)).toBe(false);
  const resolved = sessionReducer(uncertain, { type: "OUTPUT_ATTRIBUTION", outputs: ledger.outputs, sourceIds: [a1.id, a2.id] });
  expect(resolved.activeTurn?.translatedText).toBe("Texto.");
  expect(resolved.recentTurns.find(turn => turn.id === output.id)).toBeUndefined();
  for (let index = 0; index < 2; index++) captions.setOutputs([output], { A: "ru", B: "es" });
  expect(captions.blocks.map(block => block.text).join("")).toBe("Texto.");
  reporter.observeProduct({ ...observation, atMs: 150, counters: { audioCompletedTurnCount: 1, attributionRevokedCount: metrics.snapshot().attributionRevokedCount } });
  reporter.observeUsage({ kind: "local_close_unconfirmed" }); await reporter.idle();
  const final = outbox.enqueue.mock.calls.at(-1)![2];
  expect(final.app).toMatchObject({ completedSourceSpeechMs: 100, counters: { audioCompletedTurnCount: 1, attributionRevokedCount: 1 } });
  expect(outbox.enqueue.mock.calls[0]![2]).toEqual(intermediate);
  expect(intermediate.app.completedSourceSpeechMs).toBe(100);
  const otherOrder = new OutputAttribution();
  otherOrder.receive([fragment("o", 200, 300)], "B", [a1, a2], 1000);
  otherOrder.observePlayback(1100, [a1, a2]);
  expect(otherOrder.current()).toEqual(ledger.current());
  expect(ledger.current().confirmedSourceSpeechMs).toBeNull();
  expect(output.firstReceivedAtMs).toBe(1000);
});


it("does not inherit a known direction for an unknown lexical group sharing its packet interval", () => {
  const ledger = new OutputAttribution(), a = source("a", 0);
  const known = ledger.receive([{ ...fragment("packet:head", 100, 500), text: "¿Dónde está la estación? " }], "B", [a], 1000);
  const unknown = ledger.receive([{ ...fragment("packet:tail", 100, 500), text: "OK." }], undefined, [a], 1000);
  expect(unknown.id).not.toBe(known.id);
  expect(unknown.sourceId).toBeUndefined();
  expect(known.fragments.map(part => part.text).join("")).toBe("¿Dónde está la estación? ");
});

it("preserves pending packet identity and clocks when language evidence splits its tail", () => {
  const ledger = new OutputAttribution(), a = source("a", 0);
  const raw = { ...fragment("packet", 100, 500), text: "Thank y" };
  ledger.observePending([raw], [a], 1000, "a");
  const id = ledger.outputs[0]!.id;
  const first = ledger.receive([{ ...raw, id: "packet:head", text: "Thank " }], "B", [a], 2000, "a");
  ledger.observePending([{ ...raw, id: "packet:tail", text: "y" }], [a], 2000, "a");
  expect(first.id).toBe(id);
  expect(ledger.outputs.flatMap(output => output.fragments).map(part => part.text).join("")).toBe("Thank y");
  expect(ledger.outputs.map(output => output.firstReceivedAtMs)).toEqual([1000, 1000]);
  expect(ledger.outputs.at(-1)?.sourceId).toBeUndefined();
});


it.each(["shared-packet", "separate-packets"])("does not join nonadjacent language groups with shared clocks: %s", kind => {
  const ledger = new OutputAttribution(), a = source("a", 0);
  const ids = kind === "shared-packet" ? ["p:head", "p:tail:head", "p:tail:tail"] : ["p1", "p2", "p3"];
  const texts = ["¿Dónde está la estación? ", "Вокзал находится прямо впереди. ", "Muchas gracias por su ayuda."];
  for (const [index, side] of (["B", "A", "B"] as const).entries())
    ledger.receive([{ ...fragment(ids[index]!, 500, 2500), text: texts[index]! }], side, [a], 1000, "a");
  expect(ledger.outputs.map(output => output.fragments.map(part => part.text).join(""))).toEqual(texts);
  expect(new Set(ledger.outputs.map(output => output.id)).size).toBe(3);
  const first = ledger.outputs[0]!;
  const punctuation = ledger.receive([{ ...fragment("late-punctuation", 600, 600, 2000), text: "!" }], undefined, [a], 2000, "a");
  // Both ES outputs cover this interval, so punctuation cannot choose one arbitrarily.
  expect(punctuation.id).not.toBe(first.id);
  expect(first.firstReceivedAtMs).toBe(1000);
});


it("waits for independent source language before matching the same output", () => {
  const ledger = new OutputAttribution();
  const unknown = { ...source("a", 0), speaker: undefined };
  const output = ledger.receive([fragment("out", 200, 300)], "B", [unknown], 1000);
  expect(output.sourceId).toBeUndefined();
  expect(output.candidateIds).toEqual(["a"]);
  expect(ledger.hasCompatibleOutput(unknown)).toBe(true);
  ledger.reconcile([{ ...unknown, speaker: "A" }], 2000);
  expect(output.sourceId).toBe("a");
  expect(output.firstReceivedAtMs).toBe(1000);
  expect(ledger.outputs).toHaveLength(1);
});

it("keeps late PCM candidates on their provider timeline across a new observed speech boundary", () => {
  const ledger = new OutputAttribution();
  ledger.observeReceivedPlayback(1000, []);
  ledger.observePlayback(1100, []);
  ledger.observeSourceStart("fresh", 2000);
  const fresh = { ...source("fresh", 120000), speechStartAtMs: 2000 };
  const delayed = { ...source("delayed", 100000), speechStartAtMs: 3000 };
  ledger.reconcile([fresh, delayed], 3000);
  expect(ledger.hasCompatibleOutput(fresh)).toBe(false);
  expect(ledger.hasCompatibleOutput(delayed)).toBe(true);
  expect(ledger.current()).toMatchObject({ matchedAudioOutputs: 0, unattributedPlaybackCount: 1, confirmedSourceSpeechMs: null });
});

it("lets late ASR split a known PCM episode but excludes later provider speech", () => {
  const ledger = new OutputAttribution(), original = source("original", 100000);
  ledger.observeReceivedPlayback(1000, [original]);
  const delayed = { ...source("split", 100050), speechStartAtMs: 2000 };
  const later = { ...source("later", 100200), speechStartAtMs: 2000 };
  ledger.reconcile([original, delayed, later], 2000);
  expect(ledger.hasCompatibleOutput(delayed)).toBe(true);
  expect(ledger.hasCompatibleOutput(later)).toBe(false);
  expect(ledger.hasCompatibleOutput(delayed, 999)).toBe(false);
});

it.each([false, true])("refines PCM episode bounds when ASR reveals more of the source, initiallyUntimed=%s", initiallyUntimed => {
  const ledger = new OutputAttribution();
  const original = source("original", 100000);
  if (initiallyUntimed) original.sourceFragments = [];
  ledger.observeReceivedPlayback(1000, [original]);
  original.sourceFragments = [fragment("expanded", 100000, 100300)];
  const delayed = { ...source("split", 100200), speechStartAtMs: 2000 };
  ledger.reconcile([original, delayed], 2000);
  expect(ledger.hasCompatibleOutput(delayed)).toBe(true);
  expect(ledger.current().matchedAudioOutputs).toBe(0);
});
