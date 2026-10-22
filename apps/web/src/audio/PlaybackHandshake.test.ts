import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { AudioController } from "./AudioController";

type Message = { type: string; value?: boolean; requestId?: number; generation?: number };
class ProcessorBase {
  readonly port = {
    onmessage: null as ((event: MessageEvent<Message>) => void) | null,
    postMessage: vi.fn<(message: Message) => void>(), close: () => {},
  };
}
type Processor = ProcessorBase & { process(inputs: Float32Array[][], outputs: Float32Array[][]): boolean };
let ProcessorClass: new () => Processor;
const SAMPLE_RATE = 48_000;
const QUANTUM = 128;
const FRAME_MS = QUANTUM / SAMPLE_RATE * 1000;

class Track {
  enabled = true;
  readyState = "live";
  getSettings() { return {}; }
  addEventListener() {}
  removeEventListener() {}
  stop() { this.readyState = "ended"; }
}
function stream(track = new Track()): MediaStream {
  return { getAudioTracks: () => [track], getTracks: () => [track], clone: () => stream() } as unknown as MediaStream;
}
class Node {
  connect() { return this; }
  disconnect() {}
}
class Analyser extends Node {
  fftSize = 128;
  amplitude = 0;
  getFloatTimeDomainData(output: Float32Array) { output.fill(this.amplitude); }
}

type Trace = {
  atMs: number; event: string; generation?: number; requestId?: number;
  pending: boolean; nonzero: boolean; capture: boolean; analysis: boolean; muted: boolean;
};

// Real queue/processor/controller; only the browser's nodes, tracks and schedulers are replaced.
class Harness {
  now = 0;
  readonly capture = new Track();
  readonly analysers: Analyser[] = [];
  readonly sources: MediaStream[] = [];
  readonly trace: Trace[] = [];
  readonly played: number[] = [];
  readonly audiblePlayed: number[] = [];
  readonly timers = new Map<number, { due: number; run: () => void }>();
  readonly nodes: Array<{
    processor: Processor; toMain: Message[]; toWorklet: Message[];
    port: { onmessage: ((event: MessageEvent<Message>) => void) | null; postMessage(message: Message): void; close(): void };
    handler?: (event: MessageEvent<Message>) => void;
  }> = [];
  private nextTimer = 0;
  private sampler = () => {};
  private pending = false;
  private nonzero = false;
  private permission?: Message;
  readonly controller: AudioController;
  get node() { return this.nodes.at(-1)!; }
  get analysis() { return this.sources[0]!.getAudioTracks()[0]!; }

  constructor() {
    vi.spyOn(window, "setTimeout").mockImplementation(((run: () => void, delay = 0) => {
      const id = ++this.nextTimer;
      this.timers.set(id, { due: this.now + delay, run });
      return id;
    }) as typeof window.setTimeout);
    vi.spyOn(window, "clearTimeout").mockImplementation(id => { if (typeof id === "number") this.timers.delete(id); });
    vi.spyOn(window, "setInterval").mockImplementation(((run: () => void) => { this.sampler = run; return 1; }) as typeof window.setInterval);
    vi.spyOn(window, "clearInterval").mockImplementation(() => {});
    const context = {
      state: "running", resume: async () => {}, close: async () => {},
      addEventListener() {}, removeEventListener() {},
      audioWorklet: { addModule: async () => {} },
      createMediaStreamSource: (source: MediaStream) => { this.sources.push(source); return new Node(); },
      createAnalyser: () => { const analyser = new Analyser(); this.analysers.push(analyser); return analyser; },
      createMediaStreamDestination: () => ({ stream: stream() }),
    };
    this.controller = new AudioController({
      createAudioContext: () => context as unknown as AudioContext,
      getUserMedia: async () => stream(this.capture), nowMs: () => this.now,
      createPlaybackNode: () => {
        const processor = new ProcessorClass();
        const toMain: Message[] = [], toWorklet: Message[] = [];
        processor.port.postMessage.mockImplementation(message => { toMain.push({ ...message }); });
        const node = Object.assign(new Node(), {
          processor, toMain, toWorklet,
          port: {
            onmessage: null as ((event: MessageEvent<Message>) => void) | null,
            postMessage: (message: Message) => {
              toWorklet.push({ ...message });
              if (message.type === "playback") this.record(`ACK posted:${message.value}`, message);
            }, close() {},
          },
        });
        this.nodes.push(node);
        return node as unknown as AudioWorkletNode;
      },
    });
  }
  async start() {
    await this.controller.primeOutput();
    await this.controller.startCapture();
    this.controller.attachRemoteStream(stream());
    this.node.handler = this.node.port.onmessage!;
    this.controller.setOutputAudible(true);
    this.flushWorklet();
  }
  record(event: string, message?: Message) {
    if (event === "worklet playback:true") this.permission = message;
    this.trace.push({ atMs: this.now, event,
      generation: message?.generation ?? this.permission?.generation, requestId: message?.requestId ?? this.permission?.requestId,
      pending: this.pending, nonzero: this.nonzero, capture: this.capture.enabled, analysis: this.analysis.enabled,
      muted: this.controller.audioElement.muted });
  }
  // Each direction is FIFO, but delivering one never implicitly flushes the other.
  flushMain(node = this.node) {
    while (node.toMain.length) this.deliverMain(node);
  }
  takeWorkletTasks(node = this.node) {
    // Web Audio snapshots task_count before running tasks and the next render quantum.
    const tasks = node.toWorklet.splice(0);
    return () => {
      for (const message of tasks) {
        this.record(`worklet ${message.type}:${message.value}`, message);
        node.processor.port.onmessage?.({ data: message } as MessageEvent<Message>);
      }
    };
  }
  flushWorklet(node = this.node) {
    this.takeWorkletTasks(node)();
  }
  deliverMain(node = this.node) {
    if (node.toMain.length) {
      const message = node.toMain.shift()!;
      if (message.type === "pending") this.pending = message.value === true;
      this.record(`main ${message.type}:${message.value}`, message);
      node.handler?.({ data: message } as MessageEvent<Message>);
    }
  }
  runTimers() {
    for (const [id, timer] of [...this.timers].sort((a, b) => a[1].due - b[1].due)) {
      if (timer.due <= this.now && this.timers.delete(id)) {
        timer.run();
        this.record("timer");
      }
    }
  }
  frame(amplitude = 0, pump = true) {
    const output = new Float32Array(QUANTUM);
    const alive = this.node.processor.process([[new Float32Array(QUANTUM).fill(amplitude)]], [[output]]);
    this.now += FRAME_MS;
    this.nonzero = output.some(x => x !== 0);
    if (this.nonzero) {
      this.record("PCM");
      this.played.push(...output.filter(x => x !== 0));
      if (!this.controller.audioElement.muted) this.audiblePlayed.push(...output.filter(x => x !== 0));
    }
    if (pump) { this.flushMain(); this.flushWorklet(); this.runTimers(); }
    return { output, alive };
  }
  render(ms: number, amplitude = 0, pump = true) {
    for (let n = 0; n < Math.ceil(ms / FRAME_MS); n++) this.frame(amplitude, pump);
  }
  until(predicate: () => boolean, pump = true) {
    for (let n = 0; n < 2000 && !predicate(); n++) this.frame(0, pump);
    expect(predicate()).toBe(true);
  }
  sampleMic(amplitude: number, ms: number) {
    this.analysers[0]!.amplitude = amplitude;
    for (let n = 0; n < ms / 50; n++) { this.now += 50; this.sampler(); this.flushWorklet(); }
  }
  firstPlayback() {
    this.render(40, .5);
    this.until(() => this.trace.some(row => row.event === "PCM"));
    this.until(() => this.controller.playbackInputState === "tail");
    expect(this.capture.enabled).toBe(false);
  }
  assertProtected() {
    for (const row of this.trace.filter(row => row.event === "PCM" || row.event === "ACK posted:true")) {
      expect(row.capture, JSON.stringify(row)).toBe(false);
      expect(row.analysis, JSON.stringify(row)).toBe(false);
    }
  }
  dispose() { this.controller.dispose(); }
}

let harness: Harness;
beforeEach(async () => {
  vi.resetModules();
  vi.stubGlobal("AudioWorkletProcessor", ProcessorBase);
  vi.stubGlobal("sampleRate", SAMPLE_RATE);
  vi.stubGlobal("registerProcessor", (_name: string, constructor: new () => Processor) => { ProcessorClass = constructor; });
  await import("./BufferedPlaybackProcessor");
  vi.spyOn(console, "info").mockImplementation(() => {});
  for (const method of ["load", "pause"] as const) vi.spyOn(HTMLMediaElement.prototype, method).mockImplementation(() => {});
  vi.spyOn(HTMLMediaElement.prototype, "play").mockResolvedValue(undefined);
  harness = new Harness();
  await harness.start();
});
afterEach(() => { harness.dispose(); vi.restoreAllMocks(); vi.unstubAllGlobals(); });

describe("physical playback permission with independent render/main queues", () => {
  it("reopens about 550 ms after the last nonzero block without the logical 700 ms grace", () => {
    harness.firstPlayback();
    harness.until(() => harness.capture.enabled);
    const lastPCM = harness.trace.filter(row => row.event === "PCM").at(-1)!;
    const delay = harness.now - lastPCM.atMs;
    console.log(JSON.stringify({ sampleRate: SAMPLE_RATE, quantum: QUANTUM,
      lastNonzeroBlockEndMs: lastPCM.atMs, reopenedAtMs: harness.now, delayMs: delay,
      toleranceMs: 3 * FRAME_MS, trace: harness.trace.filter(row => row.event !== "PCM").slice(-8) }));
    expect(delay).toBeGreaterThanOrEqual(550 - 3 * FRAME_MS);
    expect(delay).toBeLessThanOrEqual(550 + 3 * FRAME_MS);
    harness.assertProtected();
  });

  it.each([20, 150, 299, 350])("holds resumed PCM at %s ms into the release window until its own ACK", delay => {
    harness.firstPlayback();
    harness.render(delay);
    const before = harness.played.length;
    harness.render(40, .7, false);
    expect(harness.played).toHaveLength(before);
    harness.flushMain();
    expect(harness.capture.enabled).toBe(false);
    harness.render(40, 0, false);
    expect(harness.played).toHaveLength(before); // Closed tracks alone are not the ACK.
    harness.flushWorklet();
    harness.until(() => harness.played.length > before);
    harness.until(() => harness.capture.enabled);
    expect(harness.played.filter(x => x > .6)).toHaveLength(Math.ceil(40 / FRAME_MS) * QUANTUM);
    harness.assertProtected();
  });

  it.each(["timer-first", "message-first"])("keeps PCM held when main is blocked beyond 300 ms (%s)", order => {
    harness.firstPlayback();
    const before = harness.played.length;
    harness.render(100, 0, false);
    harness.render(40, .7, false);
    harness.render(300, 0, false);
    expect(harness.played).toHaveLength(before);
    if (order === "timer-first") {
      harness.runTimers();
      expect(harness.capture.enabled).toBe(true);
      harness.frame(0, false);
      expect(harness.played).toHaveLength(before);
      harness.flushMain();
    } else {
      harness.flushMain();
      harness.runTimers();
    }
    expect(harness.capture.enabled).toBe(false);
    harness.frame(0, false);
    expect(harness.played).toHaveLength(before);
    harness.flushWorklet();
    harness.until(() => harness.played.length > before);
    harness.assertProtected();
  });

  it.each([500, 699, 701, 900])("reauthorizes provider chunks separated by %s ms without loss or duplication", gap => {
    harness.render(40, .5);
    harness.render(gap);
    harness.render(40, .7);
    harness.until(() => harness.capture.enabled && harness.played.some(x => x > .6));
    expect(harness.played).toEqual([
      ...new Float32Array(Math.ceil(40 / FRAME_MS) * QUANTUM).fill(.5),
      ...new Float32Array(Math.ceil(40 / FRAME_MS) * QUANTUM).fill(.7),
    ]);
    harness.assertProtected();
  });

  it("rejects a queued request from before suspend/resume while the same processor requests fresh PCM", () => {
    harness.render(40, .5, false);
    harness.render(320, 0, false);
    expect(harness.node.toMain.some(m => m.type === "playback" && m.value)).toBe(true);
    harness.controller.setCaptureEnabled(false);
    harness.controller.setOutputAudible(false);
    harness.controller.setCaptureEnabled(true);
    harness.controller.setOutputAudible(true);
    harness.flushWorklet();
    harness.render(40, .7, false);
    harness.render(320, 0, false);
    const requests = harness.node.toMain.filter(m => m.type === "playback" && m.value);
    expect(requests).toHaveLength(2);
    // Old request is ahead of the current request in worklet -> main FIFO.
    const queued = harness.node.toMain.splice(0);
    const oldEnd = queued.findIndex(m => m.type === "playback" && m.value) + 1;
    harness.node.toMain.push(...queued.slice(0, oldEnd));
    harness.flushMain();
    expect(harness.capture.enabled).toBe(true);
    harness.flushWorklet();
    harness.frame(0, false);
    expect(harness.played).toHaveLength(0);
    harness.node.toMain.push(...queued.slice(oldEnd));
    harness.flushMain(); harness.flushWorklet();
    harness.until(() => harness.played.length > 0);
    expect(harness.played.every(x => x > .6)).toBe(true);
    harness.assertProtected();
  });

  it("cancels an acknowledged but undelivered cycle on suspend and never replays it after resume", () => {
    harness.render(40, .5, false); harness.render(320, 0, false);
    harness.flushMain(); // Tracks closed, ACK is still queued in main -> worklet.
    expect(harness.capture.enabled).toBe(false);
    expect(harness.node.toWorklet.some(m => m.type === "playback" && m.value)).toBe(true);
    harness.controller.setCaptureEnabled(false); harness.controller.setOutputAudible(false);
    harness.controller.setCaptureEnabled(true); harness.controller.setOutputAudible(true);
    harness.flushWorklet(); // ACK then cancellation/resume, strictly FIFO.
    harness.render(400);
    expect(harness.played).toHaveLength(0);
    expect(harness.capture.enabled).toBe(true);
    harness.render(40, .7);
    harness.until(() => harness.played.length > 0);
    harness.until(() => harness.capture.enabled);
    expect(harness.played).toEqual([...new Float32Array(Math.ceil(40 / FRAME_MS) * QUANTUM).fill(.7)]);
    harness.assertProtected();
  });

  it("keeps both inputs and audible output closed across a canceled ACK's render-task snapshot", () => {
    harness.render(40, .5, false); harness.render(320, 0, false);
    harness.flushMain();
    const oldTasks = harness.takeWorkletTasks();
    harness.controller.setCaptureEnabled(false); harness.controller.setOutputAudible(false);
    harness.controller.setCaptureEnabled(true); harness.controller.setOutputAudible(true);
    expect(harness.capture.enabled).toBe(false);
    expect(harness.analysis.enabled).toBe(false);
    expect(harness.controller.audioElement.muted).toBe(true);
    oldTasks(); // The cancellation belongs to the next task packet, preserving FIFO.
    expect(harness.frame(0, false).output.some(x => x !== 0)).toBe(true);
    harness.render(400, 0, false); harness.runTimers();
    expect(harness.capture.enabled).toBe(false);
    expect(harness.analysis.enabled).toBe(false);
    expect(harness.controller.audioElement.muted).toBe(true);
    harness.flushMain(); // Old turn/release messages cannot confirm the cancellation.
    expect(harness.capture.enabled).toBe(false);
    expect(harness.controller.audioElement.muted).toBe(true);
    harness.flushWorklet(); // Apply the actual cancellation, then resume in FIFO order.
    harness.flushMain();
    expect(harness.controller.audioElement.muted).toBe(true); // The reset must also reach a render quantum.
    expect(harness.frame(0, false).output.every(x => x === 0)).toBe(true);
    expect(harness.capture.enabled).toBe(false); // Its confirmation is still undelivered.
    harness.flushMain();
    expect(harness.controller.audioElement.muted).toBe(false);
    harness.until(() => harness.capture.enabled);
    const before = harness.played.length;
    harness.render(40, .7, false); harness.render(320, 0, false);
    expect(harness.played).toHaveLength(before);
    harness.flushMain(); // Close both tracks, but delay the fresh cycle's ACK.
    expect(harness.capture.enabled).toBe(false); expect(harness.analysis.enabled).toBe(false);
    harness.frame(0, false);
    expect(harness.played).toHaveLength(before);
    harness.flushWorklet();
    harness.until(() => harness.capture.enabled && harness.played.length > before);
    const freshPCM = [...new Float32Array(Math.ceil(40 / FRAME_MS) * QUANTUM).fill(.7)];
    expect(harness.played.slice(before)).toEqual(freshPCM);
    expect(harness.audiblePlayed).toEqual(freshPCM); // No canceled .5 marker reaches Gate C.
    harness.assertProtected();
  });

  it("ignores an older cancellation confirmation while a newer reset is still queued", () => {
    harness.render(40, .5, false); harness.render(320, 0, false);
    harness.flushMain(); harness.flushWorklet();
    harness.controller.setCaptureEnabled(false); harness.controller.setOutputAudible(false);
    harness.flushWorklet(); harness.frame(0, false); // Cancellation rendered; confirmation delayed.
    harness.controller.setCaptureEnabled(true); harness.controller.setOutputAudible(true);
    harness.controller.setCaptureEnabled(false); harness.controller.setOutputAudible(false);
    harness.controller.setCaptureEnabled(true); harness.controller.setOutputAudible(true);
    while (harness.node.toMain.length) {
      harness.deliverMain();
      harness.frame(0, false); harness.runTimers();
      expect(harness.capture.enabled).toBe(false);
      expect(harness.analysis.enabled).toBe(false);
      expect(harness.controller.audioElement.muted).toBe(true);
    }
    harness.flushWorklet(); harness.flushMain();
    harness.until(() => harness.capture.enabled);
    expect(harness.analysis.enabled).toBe(true);
    expect(harness.controller.audioElement.muted).toBe(false);
    harness.render(40, .7);
    harness.until(() => harness.capture.enabled && harness.played.length > 0);
    expect(harness.played).toEqual([...new Float32Array(Math.ceil(40 / FRAME_MS) * QUANTUM).fill(.7)]);
    harness.assertProtected();
  });

  it("ignores a cancellation confirmation from a retired node while its replacement is resetting", () => {
    harness.render(40, .5, false); harness.render(320, 0, false); harness.flushMain();
    harness.controller.setCaptureEnabled(false); harness.controller.setOutputAudible(false);
    harness.controller.setCaptureEnabled(true); harness.controller.setOutputAudible(true);
    harness.flushWorklet(); harness.frame(0, false);
    const retired = harness.node; // Its reset confirmation has not reached main.
    harness.controller.attachRemoteStream(stream());
    harness.node.handler = harness.node.port.onmessage!;
    harness.controller.setOutputAudible(false); harness.controller.setOutputAudible(true);
    harness.flushMain(retired);
    harness.render(400, 0, false); harness.runTimers();
    expect(harness.capture.enabled).toBe(false); expect(harness.analysis.enabled).toBe(false);
    expect(harness.controller.audioElement.muted).toBe(true);
    harness.flushWorklet(); harness.frame(0, false); harness.flushMain();
    harness.until(() => harness.capture.enabled);
    expect(harness.controller.audioElement.muted).toBe(false);
    harness.controller.dispose();
    harness.flushMain(retired);
    expect(harness.capture.readyState).toBe("ended");
    expect(harness.analysis.readyState).toBe("ended");
  });

  it("confirms a mode reset before authorizing its already buffered PCM", () => {
    harness.render(600, .5, false); harness.render(320, 0, false);
    harness.flushMain(); // The old ACK is queued ahead of the mode reset.
    harness.controller.setNonInterrupting(true);
    harness.flushWorklet(); harness.frame(0, false);
    harness.flushMain(); harness.flushWorklet();
    harness.until(() => harness.capture.enabled && harness.played.length > 0);
    expect(harness.played).toEqual([...new Float32Array(Math.ceil(600 / FRAME_MS) * QUANTUM).fill(.5)]);
    harness.assertProtected();
  });

  it("retires permission when re-enabling buffering with no new PCM", () => {
    harness.firstPlayback();
    harness.controller.setNonInterrupting(true);
    harness.flushWorklet(); harness.flushMain();
    harness.until(() => harness.capture.enabled);
    harness.render(40, .7);
    harness.until(() => harness.played.some(x => x > .6));
    harness.assertProtected();
  });

  it("ignores messages from a replaced worklet and after session disposal", () => {
    harness.render(40, .5, false); harness.render(320, 0, false);
    const old = harness.node;
    harness.controller.attachRemoteStream(stream());
    harness.node.handler = harness.node.port.onmessage!;
    harness.flushWorklet();
    harness.flushMain(old);
    expect(harness.capture.enabled).toBe(true);
    harness.render(40, .7);
    harness.until(() => harness.played.length > 0);
    harness.flushMain(old);
    harness.assertProtected();
    const current = harness.node;
    harness.controller.dispose();
    harness.flushMain(current); harness.flushWorklet(current);
    expect(harness.frame(.8, false).alive).toBe(false);
    expect(harness.capture.readyState).toBe("ended");
  });

  it("denies a delayed request when source speech starts before main handles it", () => {
    harness.render(40, .5, false); harness.render(320, 0, false);
    expect(harness.node.toMain.some(m => m.type === "playback" && m.value)).toBe(true);
    harness.sampleMic(.01, 50); harness.sampleMic(.2, 200);
    harness.flushMain();
    expect(harness.node.toWorklet.some(m => m.type === "playback" && m.value === false)).toBe(true);
    harness.flushWorklet(); harness.render(400);
    expect(harness.capture.enabled).toBe(true);
    expect(harness.played).toHaveLength(0);
    harness.sampleMic(0, 700);
    harness.until(() => harness.played.length > 0);
    harness.until(() => harness.capture.enabled);
    expect(harness.played).toEqual([...new Float32Array(Math.ceil(40 / FRAME_MS) * QUANTUM).fill(.5)]);
    harness.assertProtected();
  });

  it("waits for real source activity to end, preserving all buffered word samples", () => {
    harness.sampleMic(.01, 50); harness.sampleMic(.2, 200);
    harness.render(600, .5);
    expect(harness.played).toHaveLength(0);
    expect(harness.capture.enabled).toBe(true);
    harness.sampleMic(0, 700);
    harness.until(() => harness.played.length > 0);
    harness.until(() => harness.capture.enabled);
    expect(harness.played).toEqual([...new Float32Array(Math.ceil(600 / FRAME_MS) * QUANTUM).fill(.5)]);
    harness.assertProtected();
  });
});


describe("pending observations across a reset barrier", () => {
  it("keeps fresh PCM pending before and after the reset ACK without opening Gate C early", () => {
    harness.controller.setCaptureEnabled(false); harness.controller.setOutputAudible(false);
    harness.controller.setCaptureEnabled(true); harness.controller.setOutputAudible(true);
    harness.flushWorklet();
    harness.frame(.7, false);
    while (harness.node.toMain.length && harness.node.toMain[0]?.type !== "reset") harness.deliverMain();
    expect(harness.node.toMain[0]?.type).toBe("reset");
    expect(harness.controller.audioElement.muted).toBe(true);
    expect(harness.controller.hasPendingPlayback).toBe(true);
    expect(harness.played).toHaveLength(0);
    harness.deliverMain();
    expect(harness.controller.audioElement.muted).toBe(false);
    expect(harness.controller.hasPendingPlayback).toBe(true);
    harness.until(() => harness.capture.enabled && harness.played.length > 0);
    expect(harness.played).toEqual([...new Float32Array(QUANTUM).fill(.7)]);
    expect(harness.controller.hasPendingPlayback).toBe(false);
    harness.assertProtected();
  });

  it("does not let SessionController complete text-only while fresh PCM awaits its request and ACK", async () => {
    const { SessionController } = await import("../session/SessionController");
    harness.controller.setCaptureEnabled(false); harness.controller.setOutputAudible(false);
    harness.controller.setCaptureEnabled(true); harness.controller.setOutputAudible(true);
    harness.flushWorklet(); harness.frame(.7, false); harness.flushMain();
    const session = new SessionController({ audio: harness.controller, createLive: () => ({}) as never });
    Object.assign(session.session, { state: "outputting", activeTurn: {
      id: "fresh-turn", speaker: "A", sideSource: "language", sourceFragments: [], originalText: "test",
      translatedText: "prueba", outputFragments: [], status: "outputting", sourceIdleAtMs: harness.now,
      firstOutputTextAtMs: harness.now, outputTextEndAtMs: harness.now, audioOutputStarted: false,
    }});
    harness.render(1500, 0, false); // Render runs while main delays the playback request beyond text completion.
    expect(harness.node.toMain.some(m => m.type === "playback" && m.value)).toBe(true);
    expect(harness.played).toHaveLength(0);
    await (session as unknown as { considerTurnCompletion(atMs: number): Promise<void> }).considerTurnCompletion(harness.now);
    expect(session.session.activeTurn?.id).toBe("fresh-turn");
    expect(session.session.recentTurns).toHaveLength(0);
  });

  it("repeats held pending in a new mode generation when its previous observation was delayed", () => {
    harness.render(40, .7, false);
    harness.controller.setNonInterrupting(true);
    harness.flushMain(); // The old generation's pending must not populate the new one.
    expect(harness.controller.hasPendingPlayback).toBe(false);
    harness.flushWorklet(); harness.flushMain();
    expect(harness.controller.hasPendingPlayback).toBe(true); // Same queue value, fresh generation.
    expect(harness.played).toHaveLength(0);
    harness.until(() => harness.capture.enabled && harness.played.length > 0);
    expect(harness.played).toEqual([...new Float32Array(Math.ceil(40 / FRAME_MS) * QUANTUM).fill(.7)]);
    expect(harness.controller.hasPendingPlayback).toBe(false);
    harness.assertProtected();
  });
});


describe("timestamped PCM evidence and independent source deadline", () => {
  async function sourceSession() {
    const { SessionController } = await import("../session/SessionController");
    const session = new SessionController({ audio: harness.controller, createLive: () => ({}) as never });
    vi.spyOn(Date, "now").mockImplementation(() => harness.now);
    harness.now = 1000;
    Object.assign(session.session, { state: "listening", participantA: { side: "A", language: "ru" }, participantB: { side: "B", language: "es" }, activeTurn: {
      id: "source", speaker: "A", sideSource: "language", originalText: "Вокзал", status: "streaming",
      sourceFragments: [{ id: "s", text: "Вокзал", startMs: 0, endMs: 1000, receivedAtMs: 1000 }],
      sourceIdleAtMs: 1000, speechStartAtMs: 0, audioOutputStarted: false,
    } });
    const internal = session as unknown as { routingTurnIds: Set<string>; considerTurnCompletion(atMs: number): Promise<void> };
    internal.routingTurnIds.add("source");
    await internal.considerTurnCompletion(1000);
    return { session, internal };
  }

  it.each(["on-time", "delayed", "cancelled"])("retains actual held PCM receipt when completion is %s", async schedule => {
    const { session } = await sourceSession();
    harness.now = 5500;
    harness.frame(.7, false); harness.flushMain();
    const receivedAt = harness.now;
    expect(harness.controller.hasPendingPlayback).toBe(true);
    expect(harness.played).toHaveLength(0);
    if (schedule === "cancelled") {
      harness.now = 5800;
      harness.controller.setOutputAudible(false); harness.flushWorklet(); harness.flushMain();
      expect(harness.controller.hasPendingPlayback).toBe(false);
    }
    harness.now = schedule === "delayed" ? 7000 : 6000;
    harness.runTimers();
    expect(session.session.recentTurns.find(turn => turn.id === "source")?.outputDeadline)
      .toEqual({ atMs: 6000, outcome: "unresolved" });
    expect(session.attributionTrace.filter(entry => entry.kind === "pcm"))
      .toEqual([expect.objectContaining({ atMs: receivedAt, played: false })]);
    expect(session.metrics.snapshot().noObservedOutputDeadlineCount).toBe(0);
    expect(session.currentAttribution).toMatchObject({ matchedAudioOutputs: 0, unattributedPlaybackCount: 0, confirmedSourceSpeechMs: null });
    expect(harness.played).toHaveLength(0);
  });

  it("expires semantic uncertainty at D while natural audio settling has a later timer", async () => {
    const { session, internal } = await sourceSession();
    harness.now = 5100;
    harness.frame(.7, false); harness.flushMain();
    const receivedAt = harness.now;
    await internal.considerTurnCompletion(harness.now); harness.flushWorklet();
    while (harness.now < 6000) harness.frame();
    expect(harness.played).toHaveLength(128);
    expect(harness.controller.hasPendingPlayback).toBe(false);
    expect(harness.capture.enabled).toBe(true);
    expect(harness.analysis.enabled).toBe(true);
    expect(session.session.recentTurns.find(turn => turn.id === "source")?.outputDeadline)
      .toEqual({ atMs: 6000, outcome: "unresolved" });
    expect(session.attributionTrace.filter(entry => entry.kind === "pcm" && !entry.played))
      .toEqual([expect.objectContaining({ atMs: receivedAt, played: false })]);
    expect(session.currentAttribution).toMatchObject({ matchedAudioOutputs: 0, unattributedPlaybackCount: 1, confirmedSourceSpeechMs: null });
    harness.assertProtected();
  });
});


it("keeps received PCM with its source context and rejects old generation and replaced-node callbacks", async () => {
  const { SessionController } = await import("../session/SessionController");
  const session = new SessionController({ audio: harness.controller, createLive: () => ({}) as never });
  vi.spyOn(Date, "now").mockImplementation(() => harness.now);
  harness.now = 1000;
  Object.assign(session.session, { state: "listening", activeTurn: {
    id: "old-source", speaker: "A", sideSource: "language", originalText: "source", status: "streaming",
    sourceFragments: [], sourceIdleAtMs: 1000, speechStartAtMs: 0, audioOutputStarted: false,
  } });
  const internal = session as unknown as {
    routingTurnIds: Set<string>; considerTurnCompletion(atMs: number): Promise<void>;
    dispatch(action: unknown): void; resetTranscriptRouting(): void;
    attribution: { hasCompatibleOutput(source: unknown): boolean };
  };
  internal.routingTurnIds.add("old-source");
  harness.now = 5000; harness.frame(.7, false); harness.flushMain();
  const receivedAt = harness.now;
  const oldNode = harness.node;
  const oldPending = harness.trace.find(row => row.event === "main pending:true")!;
  for (let n = 0; n < 3; n++) await internal.considerTurnCompletion(harness.now);
  expect(session.attributionTrace.filter(entry => entry.kind === "pcm"))
    .toEqual([expect.objectContaining({ atMs: receivedAt, played: false })]);
  harness.now = 5700;
  internal.dispatch({ type: "SOURCE_HANDOFF", turnId: "new-source", speaker: "B", nowMs: 5700, languageRouted: true });
  internal.routingTurnIds.add("new-source");
  expect(internal.attribution.hasCompatibleOutput(session.session.activeTurn)).toBe(false);
  harness.now = 6000;
  await internal.considerTurnCompletion(harness.now);
  expect(session.session.recentTurns.find(turn => turn.id === "old-source")?.outputDeadline)
    .toEqual({ atMs: 6000, outcome: "unresolved" });

  harness.controller.setOutputAudible(false); harness.controller.setOutputAudible(true);
  internal.resetTranscriptRouting(); internal.routingTurnIds.add("new-source");
  const stale = { data: { type: "pending", value: true, generation: oldPending.generation } } as MessageEvent<Message>;
  oldNode.handler?.(stale);
  await internal.considerTurnCompletion(harness.now);
  expect(session.attributionTrace.filter(entry => entry.kind === "pcm")).toEqual([]);
  harness.controller.attachRemoteStream(stream());
  oldNode.handler?.(stale);
  expect(session.attributionTrace.filter(entry => entry.kind === "pcm")).toEqual([]);
  expect(internal.attribution.hasCompatibleOutput(session.session.activeTurn)).toBe(false);
});
