import { describe, expect, it } from "vitest";
import { PlaybackQueue } from "./PlaybackQueue";

describe("PlaybackQueue", () => {
  it("passes streaming PCM without changing samples", () => {
    const q = new PlaybackQueue(1000);
    q.setAudible(true);
    expect([...q.process(Float32Array.of(.1, .2, .3))]).toEqual([...Float32Array.of(.1, .2, .3)]);
    expect(q.pending).toBe(false);
  });
  it("holds speech, waits through short pauses, then drains FIFO", () => {
    const q = new PlaybackQueue(1000);
    q.setAudible(true);
    q.setEnabled(true);
    q.setSpeaking(true);
    expect([...q.process(Float32Array.of(.1, .2))]).toEqual([0, 0]);
    q.setSpeaking(false);
    q.process(new Float32Array(200));
    q.setSpeaking(true);
    q.process(Float32Array.of(.3));
    q.setSpeaking(false);
    expect(q.process(new Float32Array(299)).every(v => v === 0)).toBe(true);
    const out = q.process(new Float32Array(3));
    expect([...out.slice(1)]).toEqual([...Float32Array.of(.1, .2)]);
  });
  it("preserves the unplayed suffix when switching modes mid-buffer", () => {
    const q = new PlaybackQueue(1000);
    q.setAudible(true);
    q.setEnabled(true);
    q.setSpeaking(true);
    q.process(Float32Array.of(.1, .2, .3, .4));
    q.setEnabled(false);
    expect([...q.process(new Float32Array(2))]).toEqual([...Float32Array.of(.1, .2)]);
    q.setEnabled(true);
    expect([...q.process(new Float32Array(2))]).toEqual([0, 0]);
    q.setEnabled(false);
    expect([...q.process(new Float32Array(2))]).toEqual([...Float32Array.of(.3, .4)]);
  });
  it("does not accumulate an unbounded silent gap before the next phrase", () => {
    const q = new PlaybackQueue(1000);
    q.setAudible(true);
    q.setEnabled(true);
    q.setSpeaking(true);
    q.process(Float32Array.of(.5));
    for (let i = 0; i < 100; i++) q.process(new Float32Array(100));
    q.process(Float32Array.of(.6));
    q.setEnabled(false);
    const out = q.process(new Float32Array(1000));
    expect(out[0]).toBe(.5);
    expect(out.findIndex(v => v > .55)).toBeLessThan(400);
    expect(q.pending).toBe(false);
  });
  it("drops queued and arriving audio at lifecycle closure, keeping the mode", () => {
    const q = new PlaybackQueue(1000);
    q.setAudible(true); q.setEnabled(true); q.setSpeaking(true);
    q.process(Float32Array.of(.5));
    q.setAudible(false);
    q.process(Float32Array.of(.7));
    q.setAudible(true); q.setEnabled(false);
    expect(q.process(new Float32Array(1000)).every(v => v === 0)).toBe(true);
    expect(q.pending).toBe(false);
  });
  it("fails closed on overflow instead of silently dropping speech", () => {
    const q = new PlaybackQueue(1000, 10);
    q.setAudible(true); q.setEnabled(true); q.setSpeaking(true);
    q.process(new Float32Array(10).fill(.5));
    expect(() => q.process(Float32Array.of(.6))).toThrow("Playback buffer full");
    expect(q.pending).toBe(false);
    expect(q.process(Float32Array.of(.7))[0]).toBe(0);
  });
});
