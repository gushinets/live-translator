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
  it.each([1000, 48000])("drains decoder noise while preserving quiet speech and its edges at %s Hz", rate => {
    const q = new PlaybackQueue(rate, rate * 2);
    q.setAudible(true); q.setEnabled(true); q.setSpeaking(true);
    const noise = new Float32Array(rate).fill(.0002);
    for (let i = 0; i < 10; i++) q.process(noise);
    expect(q.pending).toBe(false);
    // Quiet speech is below the playback VAD floor; softer onset/tail must survive too.
    const speech = Float32Array.from({ length: rate / 2 }, (_, i) => .004 * Math.sin(i * Math.PI / 4));
    const edge = new Float32Array(rate * .03).fill(.0003);
    q.process(edge); q.process(speech); q.process(edge);
    q.process(noise);
    q.setSpeaking(false);
    const output = q.process(new Float32Array(rate * 2).fill(.0002));
    const start = output.findIndex(value => Math.abs(value) > .001);
    expect(output.slice(start - 1, start - 1 + speech.length)).toEqual(speech);
    expect(output.slice(start - 1 - edge.length, start - 1)).toEqual(edge);
    expect(output.slice(start - 1 + speech.length, start - 1 + speech.length + edge.length)).toEqual(edge);
    expect(q.pending).toBe(false);
    q.process(noise);
    expect(q.pending).toBe(false);
  });
  it.each([[1000, false], [48000, false], [1000, true], [48000, true]] as const)("does not queue a raised receiver floor while speaking at %s Hz, alternating=%s", (rate, alternating) => {
    const q = new PlaybackQueue(rate);
    q.setAudible(true); q.setEnabled(true); q.setSpeaking(true);
    const noise = Float32Array.from({ length: rate }, (_, i) => alternating && i % 2 ? -.002 : .002);
    for (const reset of ["fresh", "mute", "silence"]) {
      if (reset === "mute") { q.setAudible(false); q.setAudible(true); }
      if (reset === "silence") q.process(new Float32Array(rate));
      for (let seconds = 0; seconds < 6; seconds++) q.process(noise);
      expect(q.pending).toBe(false);
      const speech = new Float32Array(rate / 10).fill(.1);
      q.process(speech);
      q.setSpeaking(false);
      const output = q.process(undefined, new Float32Array(rate));
      const start = output.findIndex(value => value > .05);
      expect(start).toBeGreaterThanOrEqual(rate * .3);
      expect(start).toBeLessThanOrEqual(rate * .36);
      expect(output.slice(start, start + speech.length).every((sample, i) => sample === speech[i])).toBe(true);
      expect(q.pending).toBe(false);
      q.setSpeaking(true);
    }
  });
  it.each([1000, 48000])("preserves a long quiet utterance immediately after reset at %s Hz", rate => {
    const q = new PlaybackQueue(rate);
    q.setAudible(true); q.setEnabled(true); q.setSpeaking(true);
    q.setAudible(false); q.setAudible(true);
    const speech = Float32Array.from({ length: rate * 3 }, (_, i) => .004 * Math.sin(i * 2 * Math.PI * 125 / rate + Math.PI / 6));
    q.process(speech);
    q.setSpeaking(false);
    const output = q.process(undefined, new Float32Array(rate * 4));
    const start = output.findIndex(value => value !== 0);
    expect(start).toBe(rate * .3);
    expect(output.slice(start, start + speech.length).every((sample, i) => sample === speech[i])).toBe(true);
    expect(q.pending).toBe(false);
  });
  it.each([[1000, false], [48000, false], [1000, true], [48000, true]] as const)("trims broadband receiver noise and retains consonants at %s Hz, strong=%s", (rate, strong) => {
    const q = new PlaybackQueue(rate);
    q.setAudible(true); q.setEnabled(true); q.setSpeaking(true);
    let seed = 17;
    const noise = Float32Array.from({ length: rate }, () => {
      seed = (Math.imul(seed, 1664525) + 1013904223) >>> 0;
      return (seed / 0x100000000 - .5) * .006;
    });
    for (let seconds = 0; seconds < 6; seconds++) q.process(noise);
    expect(q.pending).toBe(false);
    q.clear();
    const onset = noise.slice(0, rate * .03);
    const speech = Float32Array.from({ length: rate / 2 }, (_, i) => (strong ? .1 : 0) + .004 * Math.sin(i * 2 * Math.PI * 125 / rate + Math.PI / 6));
    const consonant = noise.slice(0, rate * .2);
    q.process(onset); q.process(speech); q.process(consonant); q.process(speech); q.process(onset);
    q.setSpeaking(false);
    const output = q.process(undefined, new Float32Array(rate * 2));
    const received = Float32Array.from([...onset, ...speech, ...consonant, ...speech, ...onset]);
    const start = output.findIndex(value => value !== 0);
    expect(output.slice(start, start + received.length).every((sample, i) => sample === received[i])).toBe(true);
    expect(q.pending).toBe(false);
  });
  it.each([1000, 48000])("eventually drains correlated low-energy receiver noise at %s Hz", rate => {
    const q = new PlaybackQueue(rate);
    q.setAudible(true); q.setEnabled(true); q.setSpeaking(true);
    const noise = Float32Array.from({ length: rate }, (_, i) => .002 * Math.sin(i * 2 * Math.PI * 125 / rate));
    for (let seconds = 0; seconds < 6; seconds++) q.process(noise);
    q.setSpeaking(false);
    for (let seconds = 0; seconds < 10; seconds++) q.process(noise);
    expect(q.pending).toBe(false);
  });
  it.each([1000, 48000])("adapts to decoder noise above the old cutoff at %s Hz", rate => {
    const q = new PlaybackQueue(rate, rate * 20);
    q.setAudible(true); q.setEnabled(true); q.setSpeaking(true);
    const noise = new Float32Array(rate).fill(.002);
    q.process(noise);
    q.setSpeaking(false);
    for (let i = 0; i < 15; i++) q.process(noise);
    expect(q.pending).toBe(false);
    // A receiver's noise floor can also rise after a quieter baseline.
    q.setAudible(false); q.setAudible(true); q.setSpeaking(true);
    q.process(new Float32Array(rate).fill(.0002));
    q.process(noise);
    q.setSpeaking(false);
    for (let i = 0; i < 15; i++) q.process(noise);
    expect(q.pending).toBe(false);
    // Low-level alternating samples must not re-open the gate at each peak.
    const varyingNoise = Float32Array.from({ length: rate }, (_, i) => i % 2 ? -.003 : .001);
    for (let i = 0; i < 15; i++) q.process(varyingNoise);
    expect(q.pending).toBe(false);
  });
  it.each([false, true])("does not give a paused continuation to the next caption, buffered=%s", buffered => {
    const q = new PlaybackQueue(1000);
    q.setAudible(true); q.setEnabled(buffered); q.setSpeaking(true);
    let owner: string | undefined;
    let position = 0;
    const starts: Array<[string | undefined, number]> = [];
    const samples: number[] = [], owners: Array<string | undefined> = [];
    q.onPlaybackTurn = (turnId, active) => {
      if (active) { owner = turnId; starts.push([turnId, position]); }
    };
    const input = new Float32Array(1), output = new Float32Array(1);
    const feed = (value: number, count: number) => {
      input[0] = value;
      for (let i = 0; i < count; i++, position++) {
        q.process(input, output);
        if (output[0]! > .1) { samples.push(output[0]!); owners.push(owner); }
      }
    };
    q.setTurn("A"); feed(.5, 100); feed(0, 300);
    feed(.7, 100); // Indistinguishable from B audio whose first caption is delayed.
    q.setTurn("A"); q.setTurn("B");
    feed(.9, 100);
    q.setEnabled(false);
    feed(0, 1500);
    expect(samples).toEqual(Array.from(Float32Array.from([
      ...new Array(100).fill(.5), ...new Array(100).fill(.7), ...new Array(100).fill(.9),
    ])));
    expect(owners).toEqual([...new Array(100).fill("A"), ...new Array(100).fill(undefined), ...new Array(100).fill("B")]);
    const offset = buffered ? 600 : 0;
    expect(starts).toEqual([["A", offset], [undefined, offset + 400], ["B", offset + 500]]);
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
  ] as const)("leaves delayed post-pause PCM unattributed despite repeated captions, first delayed=%s, gap=%s ms, rate=%s", (firstDelayed, gapMs, rate, bStart) => {
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
    q.setTurn("A"); q.setTurn("A"); // This could be A continuing or B arriving before its caption.
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
    expect(played.mock.calls.filter(([, active]) => active).map(([turnId]) => turnId)).toEqual(["A", undefined]);
    expect(owners).toEqual([...new Array(rate / 10).fill("A"), ...new Array(rate / 10).fill(undefined)]);
    expect(starts).toEqual([["A", 0], [undefined, bStart]]);
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
    expect(played.mock.calls.filter(([, active]) => active).map(([turnId]) => turnId)).toEqual(["A", undefined, "B"]); // B preceded the third span; C cannot claim it retroactively.
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
