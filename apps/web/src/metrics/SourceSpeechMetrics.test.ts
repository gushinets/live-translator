import { describe, expect, it } from "vitest";
import { SourceSpeechMetrics } from "./SourceSpeechMetrics";
function speech(m: SourceSpeechMetrics, start: number, length: number, id: string) {
  for (let t = start; t <= start + length; t += 50) m.sample({ active: t < start + length, atMs: t }, true, id);
}
describe("vam-pre-tail-v1", () => {
  it("integrates 2000+3000 pre-tail speech, not delayed idle edges", () => {
    const m = new SourceSpeechMetrics(); speech(m, 0, 2000, "turn");
    for (let t = 2050; t <= 3000; t += 50) m.sample({ active: false, atMs: t }, true, "turn");
    speech(m, 3050, 3000, "turn");
    expect(m.snapshot()).toMatchObject({ acceptedSourceSpeechMs: 5000, completedSourceSpeechMs: 0, speechMeasurementStatus: "complete" });
  });
  it("transfers the completed subset once; discarded and text-only speech stays only accepted", () => {
    const m = new SourceSpeechMetrics(); speech(m, 0, 5000, "one");
    m.complete("one"); m.complete("one"); speech(m, 5050, 2000, "discarded"); m.complete("one");
    expect(m.snapshot()).toMatchObject({ acceptedSourceSpeechMs: 7000, completedSourceSpeechMs: 5000 });
  });
  it("does not extrapolate large gaps, hidden/mute boundaries, or a baseline reset", () => {
    const m = new SourceSpeechMetrics(); speech(m, 0, 100, "one");
    m.sample({ active: true, atMs: 1000 }, true, "one");
    m.transition(false, 1050); m.sample({ active: true, atMs: 2000 }, false, "one");
    m.reset(2050); m.sample({ active: false, atMs: 2100 }, true, "one");
    expect(m.snapshot()).toMatchObject({ acceptedSourceSpeechMs: 150, speechMeasurementStatus: "partial" });
  });
  it("distinguishes uninstrumented from observed silence", () => {
    const m = new SourceSpeechMetrics(); expect(m.snapshot().acceptedSourceSpeechMs).toBeNull();
    m.sample({ active: false, atMs: 0 }, true); m.sample({ active: false, atMs: 50 }, true);
    expect(m.snapshot()).toMatchObject({ acceptedSourceSpeechMs: 0, completedSourceSpeechMs: 0, speechMeasurementStatus: "complete" });
  });
});

it("does not reintegrate a previously measured interval after a backwards timestamp", () => {
  const m = new SourceSpeechMetrics();
  m.sample({ active: true, atMs: 100 }, true, "turn"); m.sample({ active: true, atMs: 150 }, true, "turn");
  m.sample({ active: true, atMs: 100 }, true, "turn"); m.sample({ active: false, atMs: 150 }, true, "turn");
  expect(m.snapshot()).toMatchObject({ acceptedSourceSpeechMs: 50, speechMeasurementStatus: "partial" });
});
