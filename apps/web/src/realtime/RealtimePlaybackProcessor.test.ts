import { afterEach, describe, expect, it, vi } from "vitest";

interface Processor {
  port: { onmessage: ((event: { data: object }) => void) | null; postMessage: ReturnType<typeof vi.fn> };
  process(inputs: Float32Array[][], outputs: Float32Array[][]): boolean;
}
async function processor() {
  let Constructor!: new () => Processor;
  vi.stubGlobal("sampleRate", 48000);
  vi.stubGlobal("AudioWorkletProcessor", class {
    port = { onmessage: null, postMessage: vi.fn(), close: vi.fn() };
  });
  vi.stubGlobal("registerProcessor", (_name: string, value: typeof Constructor) => { Constructor = value; });
  vi.resetModules(); await import("./RealtimePlaybackProcessor");
  const p = new Constructor();
  const send = (data: object) => p.port.onmessage?.({ data });
  const render = (input?: Float32Array) => {
    const output = new Float32Array(128); p.process(input ? [[input]] : [[]], [[output]]); return output;
  };
  return { p, send, render };
}
afterEach(() => vi.unstubAllGlobals());
describe("actual AudioWorklet response activity", () => {
  it("does not report output on begin, absent input or continuous zero PCM", async () => {
    const { p, send, render } = await processor(); send({ type: "begin", responseId: "a" });
    render(); for (let n = 0; n < 4; n++) render(new Float32Array(128));
    expect(p.port.postMessage).not.toHaveBeenCalledWith(expect.objectContaining({ type: "started" }));
  });
  it("holds every sample and reports activity only when nonzero PCM reaches output", async () => {
    const { p, send, render } = await processor();
    send({ type: "begin", responseId: "a" }); send({ type: "hold", value: true });
    const quiet = new Float32Array(128); quiet[64] = 1e-9;
    expect(render(quiet).every(v => v === 0)).toBe(true);
    expect(p.port.postMessage).not.toHaveBeenCalledWith(expect.objectContaining({ type: "started" }));
    send({ type: "hold", value: false }); expect(render()[64]).toBe(quiet[64]);
    expect(p.port.postMessage).toHaveBeenCalledWith({ type: "nonzero_pcm_rendered", responseId: "a" });
  });
});
