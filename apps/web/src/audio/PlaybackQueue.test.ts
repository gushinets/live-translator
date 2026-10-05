import { describe, expect, it, vi } from "vitest";
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
  it("keeps owner boundaries with queued PCM across trimmed silence and mode changes", () => {
    const q = new PlaybackQueue(1000);
    const played = vi.fn();
    q.onPlaybackTurn = played;
    q.setAudible(true); q.setEnabled(true); q.setSpeaking(true);
    q.process(Float32Array.of(.5)); // Audio can precede its first caption.
    q.setTurn("A");
    q.process(new Float32Array(1000));
    q.setTurn("B");
    q.process(Float32Array.of(.7));
    expect(played).not.toHaveBeenCalled();
    q.setEnabled(false);
    const output = q.process(new Float32Array(1000));
    expect(output[0]).toBe(.5);
    expect(output.findIndex(value => value > .6)).toBeLessThan(400);
    expect(played.mock.calls.filter(([, active]) => active).map(([turnId]) => turnId)).toEqual(["A", "B"]);
    expect(q.pending).toBe(false);
    q.setEnabled(true); q.setSpeaking(true);
    q.setTurn("discarded"); q.process(Float32Array.of(.8));
    q.setAudible(false); q.setAudible(true); q.setEnabled(false);
    q.setTurn("A"); q.process(Float32Array.of(.9));
    expect(played.mock.calls.filter(([, active]) => active).map(([turnId]) => turnId)).toEqual(["A", "B", "A"]); // A fresh media generation may reuse an ID.
  });
  it.each([
    [false, 1000, 48000, 19680], [true, 1000, 48000, 19680], [false, 300, 1000, 400], [true, 300, 1000, 400],
  ] as const)("ignores repeated captions without losing the next PCM owner, first delayed=%s, gap=%s ms, rate=%s", (firstDelayed, gapMs, rate, bStart) => {
    const q = new PlaybackQueue(rate, rate * 3);
    const played = vi.fn();
    let owner: string | undefined;
    let position = 0;
    const starts: Array<[string | undefined, number]> = [];
    q.onPlaybackTurn = (turnId, active) => {
      played(turnId, active);
      if (active) { owner = turnId; starts.push([turnId, position]); }
    };
    q.setAudible(true); q.setEnabled(true); q.setSpeaking(true);
    if (!firstDelayed) q.setTurn("A");
    q.process(new Float32Array(rate / 10).fill(.5));
    q.process(new Float32Array(rate * gapMs / 1000));
    q.process(new Float32Array(rate / 10).fill(.7));
    if (firstDelayed) q.setTurn("A");
    q.setTurn("A"); q.setTurn("A"); // Caption deltas must not consume B's unowned PCM.
    q.setTurn("B");
    q.setEnabled(false);
    const output = new Float32Array(rate * 2), sample = new Float32Array(1);
    const owners: Array<string | undefined> = [];
    for (; position < output.length; position++) {
      q.process(undefined, sample);
      output[position] = sample[0]!;
      if (sample[0]! > .1) owners.push(owner);
    }
    expect(output.filter(value => value > .1)).toEqual(Float32Array.from([
      ...new Array(rate / 10).fill(.5), ...new Array(rate / 10).fill(.7),
    ]));
    expect(played.mock.calls.filter(([, active]) => active).map(([turnId]) => turnId)).toEqual(["A", "B"]);
    expect(owners).toEqual([...new Array(rate / 10).fill("A"), ...new Array(rate / 10).fill("B")]);
    expect(starts).toEqual([["A", 0], ["B", bStart]]);
  });
  it("does not let a previously claimed caption steal a later unowned span", () => {
    const q = new PlaybackQueue(1000);
    const played = vi.fn();
    q.onPlaybackTurn = played;
    q.setAudible(true); q.setEnabled(true); q.setSpeaking(true);
    q.setTurn("A"); q.process(new Float32Array(100).fill(.5));
    q.process(new Float32Array(300));
    q.process(new Float32Array(100).fill(.7)); q.setTurn("B");
    q.process(new Float32Array(300));
    q.process(new Float32Array(100).fill(.9));
    q.setTurn("A"); // A late historical caption is not a new audio owner.
    q.setTurn("C");
    q.setEnabled(false);
    const output = q.process(new Float32Array(2000));
    expect(output.filter(value => value > .1)).toEqual(Float32Array.from([
      ...new Array(100).fill(.5), ...new Array(100).fill(.7), ...new Array(100).fill(.9),
    ]));
    expect(played.mock.calls.filter(([, active]) => active).map(([turnId]) => turnId)).toEqual(["A", "B", "C"]);
  });
  it("retains a caption-first next owner across the remaining raw silence", () => {
    const q = new PlaybackQueue(1000);
    const played = vi.fn();
    q.onPlaybackTurn = played;
    q.setAudible(true); q.setEnabled(true); q.setSpeaking(true);
    q.setTurn("A"); q.process(Float32Array.of(.5));
    q.process(new Float32Array(100));
    q.setTurn("B");
    q.process(new Float32Array(1000));
    q.process(Float32Array.of(.7));
    q.setEnabled(false); q.process(new Float32Array(1000));
    expect(played.mock.calls.filter(([, active]) => active).map(([turnId]) => turnId)).toEqual(["A", "B"]);
  });
  it("reports fresh activity after a long pause or a held playback interval", () => {
    const q = new PlaybackQueue(1000);
    const played = vi.fn();
    q.onPlaybackTurn = played;
    q.setAudible(true); q.setTurn("A");
    q.process(Float32Array.of(.5));
    q.process(new Float32Array(500));
    expect(played).toHaveBeenLastCalledWith("A", false); // A one-sample phrase must still produce an idle edge.
    q.setTurn("B"); // A new caption identifies the next incoming span.
    q.process(Float32Array.of(.6));
    q.setEnabled(true); q.setSpeaking(true);
    q.process(Float32Array.of(.7));
    q.process(new Float32Array(500));
    q.setEnabled(false);
    q.process(new Float32Array(1));
    expect(played.mock.calls.filter(([, active]) => active).map(([turnId]) => turnId)).toEqual(["A", "B", "B"]);
  });
  it("drains a full FIFO after disabling buffering even when the input has no channels", () => {
    const q = new PlaybackQueue(1000, 128);
    q.setAudible(true); q.setEnabled(true); q.setSpeaking(true); q.setTurn("A");
    const received = new Float32Array(128).fill(.5);
    q.process(received);
    expect(q.pending).toBe(true);
    q.setEnabled(false);
    const output = new Float32Array(128);
    expect(() => q.process(undefined, output)).not.toThrow();
    expect(output).toEqual(received);
    expect(q.process(undefined, new Float32Array(512)).every(value => value === 0)).toBe(true);
    expect(q.pending).toBe(false);
    expect(q.process(Float32Array.of(.7))[0]).toBeCloseTo(.7); // The queue did not latch terminal overflow.
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
