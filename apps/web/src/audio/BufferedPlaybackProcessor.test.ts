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
    }
    expect(played).toEqual(new Array(128).fill(.5));
    expect(processor.port.postMessage).toHaveBeenCalledWith({ type: "pending", value: false });
    expect(processor.port.close).not.toHaveBeenCalled();
  });
  it("sends FIFO owner transitions and idle even for sub-sampler-length phrases", () => {
    const processor = new ProcessorClass();
    const turn = (turnId: string) => processor.port.onmessage?.({ data: { type: "turn", turnId } } as MessageEvent);
    send(processor, "audible"); send(processor, "enabled"); send(processor, "speaking");
    turn("A"); processor.process([[Float32Array.of(.5)]], [[new Float32Array(1)]]);
    turn("B"); processor.process([[Float32Array.of(.7)]], [[new Float32Array(1)]]);
    expect(processor.port.postMessage.mock.calls.filter(([message]) => message.type === "turn")).toEqual([]);
    send(processor, "enabled", false);
    const output = new Float32Array(128);
    for (let quantum = 0; quantum < 10; quantum++) processor.process([[]], [[output]]);
    expect(processor.port.postMessage.mock.calls.filter(([message]) => message.type === "turn").map(([message]) => message)).toEqual([
      { type: "turn", turnId: "A", value: true },
      { type: "turn", turnId: "B", value: true },
      { type: "turn", turnId: "B", value: false },
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
});
