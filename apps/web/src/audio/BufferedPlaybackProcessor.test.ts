import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

class TestProcessorBase {
  readonly port = {
    onmessage: null as ((event: MessageEvent) => void) | null,
    postMessage: vi.fn(), close: vi.fn(),
  };
}
type Processor = TestProcessorBase & { process(inputs: Float32Array[][], outputs: Float32Array[][]): boolean };
let ProcessorClass: new () => Processor;

beforeEach(async () => {
  vi.resetModules();
  vi.stubGlobal("AudioWorkletProcessor", TestProcessorBase);
  vi.stubGlobal("sampleRate", 1000);
  vi.stubGlobal("registerProcessor", (_name: string, constructor: new () => Processor) => { ProcessorClass = constructor; });
  await import("./BufferedPlaybackProcessor");
});
afterEach(() => { vi.unstubAllGlobals(); });
function send(processor: Processor, type: string, value = true) {
  processor.port.onmessage?.({ data: { type, value } } as MessageEvent);
}

describe("buffered playback processor lifetime", () => {
  it("waits for microphone closure before the first sample, ignores speech during playback, and bridges short output gaps", () => {
    const processor = new ProcessorClass();
    send(processor, "audible"); send(processor, "enabled"); send(processor, "speaking");
    const received = new Float32Array(400).fill(.5);
    const output = new Float32Array(100);
    processor.process([[received]], [[new Float32Array(400)]]);
    send(processor, "speaking", false);
    for (let i = 0; i < 10; i++) {
      processor.process([[]], [[output]]);
      expect(output.every(sample => sample === 0)).toBe(true);
    }
    expect(processor.port.postMessage).toHaveBeenCalledWith({ type: "playback", value: true });
    expect(processor.port.postMessage.mock.calls.filter(([message]) => message.type === "playback")).toHaveLength(1);
    send(processor, "playback");
    send(processor, "speaking"); // Even a delayed source sample must not interrupt started playback.
    const played: number[] = [];
    for (let i = 0; i < 12; i++) { processor.process([[]], [[output]]); played.push(...output.filter(x => x !== 0)); }
    expect(played).toEqual([...received]);
    // New provider PCM after a short gap belongs to the same protected playback window.
    expect(processor.port.postMessage).not.toHaveBeenCalledWith({ type: "playback", value: false });
    processor.process([[new Float32Array(100).fill(.7)]], [[output]]);
    expect(output.some(x => x > .6)).toBe(true);
    for (let i = 0; i < 15; i++) processor.process([[]], [[output]]);
    expect(processor.port.postMessage).toHaveBeenCalledWith({ type: "playback", value: false });
  });
  it.each([true, false])("terminates after disposal, with incoming audio=%s", incoming => {
    const processor = new ProcessorClass();
    send(processor, "audible"); send(processor, "enabled"); send(processor, "speaking");
    processor.process([[Float32Array.of(.5)]], [[new Float32Array(1)]]);
    send(processor, "dispose");
    const output = Float32Array.of(1);
    expect(processor.process(incoming ? [[Float32Array.of(.7)]] : [[]], [[output]])).toBe(false);
    expect(output[0]).toBe(0);
    expect(processor.process([], [])).toBe(false);
    expect(processor.port.close).toHaveBeenCalledOnce();
    expect(processor.port.onmessage).toBeNull();
  });
  it.each([false, true])("drains queued PCM without input channels, non-interrupting=%s", enabled => {
    const processor = new ProcessorClass();
    send(processor, "audible"); send(processor, "enabled"); send(processor, "speaking");
    const output = new Float32Array(128);
    processor.process([[new Float32Array(128).fill(.5)]], [[output]]);
    expect(output.every(sample => sample === 0)).toBe(true);
    expect(processor.port.postMessage).toHaveBeenLastCalledWith({ type: "pending", value: true });
    send(processor, "speaking", false); send(processor, "enabled", enabled);
    const played: number[] = [];
    for (let quantum = 0; quantum < 100; quantum++) {
      expect(processor.process([[]], [[output]])).toBe(true);
      played.push(...output.filter(sample => sample !== 0));
      if (processor.port.postMessage.mock.calls.some(([message]) => message.type === "playback" && message.value)) send(processor, "playback");
    }
    expect(played).toEqual(new Array(128).fill(.5));
    expect(processor.port.postMessage).toHaveBeenCalledWith({ type: "pending", value: false });
    expect(processor.port.close).not.toHaveBeenCalled();
  });
  it.each([[false, 1000], [true, 1000], [false, 300], [true, 300]] as const)("sends conservative FIFO owner transitions despite caption continuation, second delayed=%s, gap=%s ms", (captionDelayed, gapMs) => {
    const processor = new ProcessorClass();
    const turn = (turnId: string) => processor.port.onmessage?.({ data: { type: "turn", turnId } } as MessageEvent);
    send(processor, "audible"); send(processor, "enabled"); send(processor, "speaking");
    turn("A"); processor.process([[Float32Array.of(.5)]], [[new Float32Array(1)]]);
    processor.process([[new Float32Array(gapMs)]], [[new Float32Array(gapMs)]]);
    if (!captionDelayed) turn("B");
    processor.process([[Float32Array.of(.7)]], [[new Float32Array(1)]]);
    if (captionDelayed) { turn("A"); turn("A"); turn("B"); }
    expect(processor.port.postMessage.mock.calls.filter(([message]) => message.type === "turn")).toEqual([]);
    send(processor, "enabled", false);
    const output = new Float32Array(128);
    const played: number[] = [];
    for (let quantum = 0; quantum < 10; quantum++) {
      processor.process([[]], [[output]]);
      played.push(...output);
    }
    expect(played[0]).toBe(.5);
    expect(played.findIndex(sample => sample > .6)).toBe(gapMs === 300 ? 301 : 311);
    expect(played.filter(sample => sample > .1)).toEqual(Array.from(Float32Array.of(.5, .7)));
    expect(processor.port.postMessage.mock.calls.filter(([message]) => message.type === "turn").map(([message]) => message)).toEqual([
      { type: "turn", turnId: "A", value: true },
      { type: "turn", turnId: captionDelayed ? undefined : "B", value: true },
      { type: "turn", turnId: captionDelayed ? undefined : "B", value: false },
    ]);
  });
  it("stays alive during ordinary input silence and temporary muting", () => {
    const processor = new ProcessorClass();
    const output = new Float32Array(1);
    expect(processor.process([[]], [[output]])).toBe(true);
    send(processor, "audible", false); send(processor, "clear");
    expect(processor.process([[]], [[output]])).toBe(true);
    send(processor, "audible");
    expect(processor.process([[Float32Array.of(.5)]], [[output]])).toBe(true);
    expect(output[0]).toBe(.5);
    expect(processor.port.close).not.toHaveBeenCalled();
  });
  it("discards a delayed playback permission after output closure", () => {
    const processor = new ProcessorClass();
    send(processor, "audible"); send(processor, "enabled");
    const output = new Float32Array(500);
    processor.process([[new Float32Array(500).fill(.5)]], [[output]]);
    expect(output.every(x => x === 0)).toBe(true);
    send(processor, "audible", false); send(processor, "playback"); send(processor, "audible");
    processor.process([[new Float32Array(500).fill(.7)]], [[output]]);
    expect(output.every(x => x === 0)).toBe(true);
    send(processor, "playback");
    processor.process([[]], [[output]]);
    expect(output.some(x => x > .6)).toBe(true);
  });
});
