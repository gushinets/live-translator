import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { VoiceActivityEstimator } from "./VoiceActivityEstimator";
import { AudioController } from "./AudioController";

class FakeAudioTrack {
  kind = "audio";
  enabled = true;
  readyState: MediaStreamTrackState = "live";
  private readonly endedListeners = new Set<() => void>();
  addEventListener = vi.fn((type: string, listener: EventListenerOrEventListenerObject) => {
    if (type === "ended" && typeof listener === "function") {
      this.endedListeners.add(listener as () => void);
    }
  });
  removeEventListener = vi.fn((type: string, listener: EventListenerOrEventListenerObject) => {
    if (type === "ended" && typeof listener === "function") {
      this.endedListeners.delete(listener as () => void);
    }
  });
  stop = vi.fn(() => {
    this.readyState = "ended";
  });
  getSettings = vi.fn(
    (): MediaTrackSettings => ({
      echoCancellation: true,
      noiseSuppression: false,
      autoGainControl: true,
      channelCount: 1,
      sampleRate: 48_000,
    }),
  );

  end(): void {
    this.readyState = "ended";
    for (const listener of this.endedListeners) {
      listener();
    }
  }
}

class FakeAudioNode {
  readonly connections: unknown[] = [];

  connect(destination: unknown): FakeAudioNode {
    this.connections.push(destination);
    return this;
  }

  disconnect(): void {
    this.connections.length = 0;
  }
}

class FakeAnalyser extends FakeAudioNode {
  fftSize = 2048;
  readonly samples = new Float32Array(2048);

  fill(amplitude: number): void {
    this.samples.fill(amplitude);
  }

  getFloatTimeDomainData(output: Float32Array): void {
    output.set(this.samples.subarray(0, output.length));
  }
}

class FakeAudioContext {
  state: AudioContextState = "suspended";
  readonly destination = { id: "destination" };
  readonly analysers: FakeAnalyser[] = [];
  readonly sources: FakeAudioNode[] = [];
  readonly sourceStreams: MediaStream[] = [];
  addEventListener = vi.fn();
  removeEventListener = vi.fn();
  resume = vi.fn(async () => {
    this.state = "running";
  });
  close = vi.fn(async () => {
    this.state = "closed";
  });

  createAnalyser(): FakeAnalyser {
    const analyser = new FakeAnalyser();
    this.analysers.push(analyser);
    return analyser;
  }

  createMediaStreamSource(stream: MediaStream): FakeAudioNode {
    const source = new FakeAudioNode();
    this.sources.push(source);
    this.sourceStreams.push(stream);
    return source;
  }
}

function fakeStream(track: FakeAudioTrack): MediaStream {
  return {
    getAudioTracks: () => [track],
    getTracks: () => [track],
    clone: vi.fn(() => fakeStream(new FakeAudioTrack())),
  } as unknown as MediaStream;
}

describe("AudioController", () => {
  let track: FakeAudioTrack;
  let audioContext: FakeAudioContext;
  let audioElement: HTMLAudioElement;
  let getUserMedia: ReturnType<typeof vi.fn>;
  let nowMs: number;
  let controller: AudioController;

  beforeEach(() => {
    vi.spyOn(console, "info").mockImplementation(() => {});
    track = new FakeAudioTrack();
    audioContext = new FakeAudioContext();
    audioElement = document.createElement("audio");
    audioElement.play = vi.fn().mockResolvedValue(undefined);
    audioElement.load = vi.fn();
    audioElement.pause = vi.fn();
    getUserMedia = vi.fn(async () => fakeStream(track));
    nowMs = 0;
    controller = new AudioController({
      getUserMedia,
      audioElement,
      createAudioContext: () => audioContext as unknown as AudioContext,
      nowMs: () => nowMs,
    });
  });

  afterEach(() => {
    controller.dispose();
    vi.useRealTimers();
    vi.restoreAllMocks();
  });

  it("requests the microphone with echo cancellation and without noise suppression", async () => {
    await controller.startCapture();

    expect(getUserMedia).toHaveBeenCalledWith({
      audio: {
        echoCancellation: true,
        noiseSuppression: false,
      },
    });
    const constraints = getUserMedia.mock.calls[0]?.[0] as MediaStreamConstraints;
    expect(constraints.audio).not.toHaveProperty("autoGainControl");
  });

  it("records only non-content microphone settings diagnostics", async () => {
    await controller.startCapture();

    expect(controller.getMicrophoneSettings()).toEqual({
      echoCancellation: true,
      noiseSuppression: false,
      autoGainControl: true,
      channelCount: 1,
      sampleRate: 48_000,
    });
  });

  it("does not invent microphone settings the track omitted", async () => {
    track.getSettings.mockReturnValue({ echoCancellation: true });

    await controller.startCapture();

    expect(controller.getMicrophoneSettings()).toEqual({
      echoCancellation: true,
      noiseSuppression: undefined,
      autoGainControl: undefined,
      channelCount: undefined,
      sampleRate: undefined,
    });
  });

  it("closes Gate C without disabling the microphone track", async () => {
    await controller.startCapture();
    controller.setOutputAudible(true);
    expect(audioElement.muted).toBe(false);
    expect(track.enabled).toBe(true);

    controller.setOutputAudible(false);

    expect(audioElement.muted).toBe(true);
    expect(track.enabled).toBe(true);
    expect(track.stop).not.toHaveBeenCalled();
  });

  it("disabling Gate A stops capture without releasing the track", async () => {
    await controller.startCapture();

    controller.setCaptureEnabled(false);

    expect(track.enabled).toBe(false);
    expect(track.stop).not.toHaveBeenCalled();
    expect(track.readyState).toBe("live");
  });

  it("stopCapture releases the microphone track", async () => {
    await controller.startCapture();

    controller.stopCapture();

    expect(track.stop).toHaveBeenCalledOnce();
    expect(track.readyState).toBe("ended");
  });

  it("mutes local output immediately", async () => {
    await controller.startCapture();
    controller.setOutputAudible(true);

    controller.setOutputAudible(false);

    expect(audioElement.muted).toBe(true);
    expect(audioElement.autoplay).toBe(true);
  });

  it("resumes AudioContext before getUserMedia resolves", async () => {
    let resolveGum: ((stream: MediaStream) => void) | undefined;
    getUserMedia.mockImplementation(
      () =>
        new Promise<MediaStream>((resolve) => {
          resolveGum = resolve;
        }),
    );

    const pending = controller.startCapture();
    expect(audioContext.resume).toHaveBeenCalled();
    expect(resolveGum).toBeDefined();

    resolveGum?.(fakeStream(track));
    await pending;
  });

  it("rejects and releases capture when getUserMedia returns an already-ended track", async () => {
    track.readyState = "ended";

    await expect(controller.startCapture()).rejects.toThrow(/microphone/i);

    expect(controller.getCaptureStream()).toBeNull();
    expect(track.removeEventListener).toHaveBeenCalled();
    expect(track.stop).toHaveBeenCalledOnce();
  });

  it("treats leaving interrupted for suspended as restore", async () => {
    const onAudioInterruption = vi.fn();
    const onAudioRestored = vi.fn();
    controller.onAudioInterruption = onAudioInterruption;
    controller.onAudioRestored = onAudioRestored;
    await controller.startCapture();
    const listener = audioContext.addEventListener.mock.calls.find(
      (call) => call[0] === "statechange",
    )?.[1] as (() => void) | undefined;
    if (listener === undefined) {
      throw new Error("AudioContext statechange listener was not installed");
    }

    (audioContext as { state: string }).state = "interrupted";
    listener();
    expect(onAudioInterruption).toHaveBeenCalledOnce();
    expect(onAudioRestored).not.toHaveBeenCalled();

    audioContext.state = "suspended";
    listener();
    expect(onAudioRestored).toHaveBeenCalledOnce();
  });

  it("reports a capture-ended failure without faking AudioContext restoration", async () => {
    const onAudioInterruption = vi.fn();
    const onAudioRestored = vi.fn();
    const onCaptureEnded = vi.fn();
    controller.onAudioInterruption = onAudioInterruption;
    controller.onAudioRestored = onAudioRestored;
    controller.onCaptureEnded = onCaptureEnded;
    await controller.startCapture();

    track.end();

    expect(onCaptureEnded).toHaveBeenCalledOnce();
    expect(onAudioInterruption).not.toHaveBeenCalled();
    expect(onAudioRestored).not.toHaveBeenCalled();
  });

  it("does not report capture-ended after stopCapture removed the track listener", async () => {
    const onCaptureEnded = vi.fn();
    controller.onCaptureEnded = onCaptureEnded;
    await controller.startCapture();
    const stoppedTrack = track;

    controller.stopCapture();
    stoppedTrack.end();

    expect(onCaptureEnded).not.toHaveBeenCalled();
  });

  it("resumes the analyser AudioContext from a user-gesture prime", async () => {
    await controller.startCapture();
    controller.attachRemoteStream(fakeStream(new FakeAudioTrack()));

    await controller.primeOutput();

    expect(audioContext.resume).toHaveBeenCalled();
    expect(audioElement.play).toHaveBeenCalledOnce();
  });

  it.each(["new stream", "same stream"])("recovers a decoder error when resuming with a %s", async mode => {
    const first = fakeStream(new FakeAudioTrack());
    controller.attachRemoteStream(first);
    let error: MediaError | null = { code: 3 } as MediaError;
    Object.defineProperty(audioElement, "error", { get: () => error, configurable: true });
    audioElement.load = vi.fn(() => { error = null; });
    audioElement.play = vi.fn(async () => { if (error) throw new DOMException("Decoder stopped", "NotSupportedError"); });
    const resumed = mode === "new stream" ? fakeStream(new FakeAudioTrack()) : first;
    if (mode === "new stream") controller.attachRemoteStream(resumed);
    await expect(controller.primeOutput()).resolves.toBeUndefined();
    expect(audioElement.error).toBeNull();
    expect(audioElement.srcObject).toBe(resumed);
    expect(audioElement.muted).toBe(true);
  });

  it("clones the capture stream for analysis so Live can consume the original", async () => {
    const original = fakeStream(track);
    const cloned = fakeStream(new FakeAudioTrack());
    vi.mocked(original.clone).mockReturnValue(cloned);
    getUserMedia.mockResolvedValue(original);

    await controller.startCapture();

    expect(controller.getCaptureStream()).toBe(original);
    expect(original.clone).toHaveBeenCalledOnce();
    expect(audioContext.sourceStreams[0]).toBe(cloned);
  });

  it("clones the remote stream for analysis and keeps the original on the audio element", async () => {
    await controller.startCapture();
    const original = fakeStream(new FakeAudioTrack());
    const cloned = fakeStream(new FakeAudioTrack());
    vi.mocked(original.clone).mockReturnValue(cloned);

    controller.attachRemoteStream(original);

    expect(audioElement.srcObject).toBe(original);
    expect(original.clone).toHaveBeenCalledOnce();
    expect(audioContext.sourceStreams[1]).toBe(cloned);
  });

  it("connects analysers only to their sources, never to destination", async () => {
    await controller.startCapture();
    controller.attachRemoteStream(fakeStream(new FakeAudioTrack()));

    expect(audioContext.analysers).toHaveLength(2);
    expect(audioContext.sources).toHaveLength(2);
    expect(audioContext.sources[0]?.connections).toEqual([audioContext.analysers[0]]);
    expect(audioContext.sources[1]?.connections).toEqual([audioContext.analysers[1]]);
    for (const analyser of audioContext.analysers) {
      expect(analyser.connections).toEqual([]);
    }
  });

  it("logs and rethrows getUserMedia failure", async () => {
    const error = new DOMException("Permission denied", "NotAllowedError");
    getUserMedia.mockRejectedValueOnce(error);
    const logged = vi.spyOn(console, "error").mockImplementation(() => {});

    await expect(controller.startCapture()).rejects.toBe(error);
    expect(logged).toHaveBeenCalled();
  });

  it("passes playback-active into the VAM estimator when Gate C is audible", async () => {
    vi.useFakeTimers();
    const pushRms = vi.spyOn(VoiceActivityEstimator.prototype, "pushRms");
    await controller.startCapture();
    controller.attachRemoteStream(fakeStream(new FakeAudioTrack()));
    controller.setOutputAudible(true);
    audioContext.analysers[0]?.fill(0.01);
    audioContext.analysers[1]?.fill(0.08);

    nowMs = 50;
    await vi.advanceTimersByTimeAsync(50);

    expect(pushRms).toHaveBeenCalledWith(expect.any(Number), true, 50);
  });

  it("does not pass playback-active into VAM while Gate C is muted", async () => {
    vi.useFakeTimers();
    const pushRms = vi.spyOn(VoiceActivityEstimator.prototype, "pushRms");
    await controller.startCapture();
    controller.attachRemoteStream(fakeStream(new FakeAudioTrack()));
    audioContext.analysers[0]?.fill(0.01);
    audioContext.analysers[1]?.fill(0.08);

    nowMs = 50;
    await vi.advanceTimersByTimeAsync(50);

    expect(pushRms).toHaveBeenCalledWith(expect.any(Number), false, 50);
  });

  it("emits playback activity events from remote analyser energy", async () => {
    vi.useFakeTimers();
    const onPlaybackActivity = vi.fn();
    controller.onPlaybackActivity = onPlaybackActivity;
    await controller.startCapture();
    controller.attachRemoteStream(fakeStream(new FakeAudioTrack()));
    audioContext.analysers[1]?.fill(0.08);

    nowMs = 50;
    await vi.advanceTimersByTimeAsync(50);

    expect(onPlaybackActivity).toHaveBeenCalledWith({ active: true, atMs: 50 });
  });

  it.each(["end", "reconnect"])("starts a fresh playback activity edge after %s during active output", async boundary => {
    vi.useFakeTimers();
    const observed = vi.fn();
    controller.onPlaybackActivity = observed;
    controller.attachRemoteStream(fakeStream(new FakeAudioTrack()));
    audioContext.analysers[0]!.fill(.08);
    nowMs = 50;
    await vi.advanceTimersByTimeAsync(50);
    expect(observed).toHaveBeenCalledExactlyOnceWith({ active: true, atMs: 50 });
    if (boundary === "end") {
      controller.detachRemoteStream();
      expect(vi.getTimerCount()).toBe(0);
    }
    controller.attachRemoteStream(fakeStream(new FakeAudioTrack()));
    expect(observed).toHaveBeenCalledOnce(); // Retirement must not emit into the previous session.
    audioContext.analysers[1]!.fill(.08);
    nowMs = 100;
    await vi.advanceTimersByTimeAsync(50);
    expect(observed).toHaveBeenCalledTimes(2);
    expect(observed).toHaveBeenLastCalledWith({ active: true, atMs: 100 });
  });

  it("emits VAM activity events from microphone analyser energy", async () => {
    vi.useFakeTimers();
    const onVoiceActivity = vi.fn();
    controller.onVoiceActivity = onVoiceActivity;
    await controller.startCapture();
    audioContext.analysers[0]?.fill(0.01);

    for (let i = 1; i <= 100; i++) {
      nowMs = i * 50;
      await vi.advanceTimersByTimeAsync(50);
    }

    audioContext.analysers[0]?.fill(0.08);
    nowMs = 5_050;
    await vi.advanceTimersByTimeAsync(50);
    nowMs = 5_100;
    await vi.advanceTimersByTimeAsync(50);

    expect(onVoiceActivity).toHaveBeenCalledWith({ active: true, atMs: 5_100 });
  });
});

describe("buffered audio output", () => {
  beforeEach(() => {
    vi.spyOn(HTMLMediaElement.prototype, "play").mockResolvedValue(undefined);
    vi.spyOn(HTMLMediaElement.prototype, "pause").mockImplementation(() => {});
  });
  afterEach(() => { vi.restoreAllMocks(); });
  function setup() {
    const context = new FakeAudioContext();
    const destinationStream = fakeStream(new FakeAudioTrack());
    const nodes: Array<FakeAudioNode & { port: { postMessage: ReturnType<typeof vi.fn>; close: ReturnType<typeof vi.fn>; onmessage: ((event: MessageEvent) => void) | null }; onprocessorerror: (() => void) | null }> = [];
    Object.assign(context, {
      audioWorklet: { addModule: vi.fn(async () => {}) },
      createMediaStreamDestination: () => ({ stream: destinationStream }),
    });
    const element = document.createElement("audio");
    element.srcObject = null;
    element.load = vi.fn(); element.play = vi.fn(async () => {}); element.pause = vi.fn();
    const controller = new AudioController({
      audioElement: element, createAudioContext: () => context as unknown as AudioContext,
      getUserMedia: async () => fakeStream(new FakeAudioTrack()),
      createPlaybackNode: () => {
        const node = Object.assign(new FakeAudioNode(), {
          port: { postMessage: vi.fn(), close: vi.fn(), onmessage: null as ((event: MessageEvent) => void) | null },
          onprocessorerror: null as (() => void) | null,
        });
        nodes.push(node);
        return node as unknown as AudioWorkletNode;
      },
    });
    return { context, controller, element, nodes, destinationStream };
  }
  it("awaits original decoder playback before declaring processed playback ready", async () => {
    const { controller, element } = setup();
    await controller.primeOutput();
    controller.attachRemoteStream(fakeStream(new FakeAudioTrack()));
    let ready!: () => void;
    vi.mocked(HTMLMediaElement.prototype.play).mockImplementationOnce(() => new Promise<void>(resolve => { ready = resolve; }));
    const playback = controller.playOutput();
    expect(element.play).not.toHaveBeenCalled();
    ready();
    await playback;
    expect(element.play).toHaveBeenCalledOnce();
    controller.dispose();
  });
  it("does not play a replacement stream from a retired decoder's pending startup", async () => {
    const { controller, element } = setup();
    await controller.primeOutput();
    controller.attachRemoteStream(fakeStream(new FakeAudioTrack()));
    let ready!: () => void;
    vi.mocked(HTMLMediaElement.prototype.play).mockImplementationOnce(() => new Promise<void>(resolve => { ready = resolve; }));
    const stalePlayback = controller.playOutput();
    controller.attachRemoteStream(fakeStream(new FakeAudioTrack()));
    ready(); await stalePlayback;
    expect(element.play).not.toHaveBeenCalled();
    await controller.playOutput();
    expect(element.play).toHaveBeenCalledOnce();
    controller.dispose();
  });
  it("forwards hidden decoder errors and removes retired decoder handlers", async () => {
    const { controller } = setup();
    try {
      await controller.primeOutput();
      controller.attachRemoteStream(fakeStream(new FakeAudioTrack()));
      await controller.playOutput();
      const decoder = vi.mocked(HTMLMediaElement.prototype.play).mock.contexts[0] as HTMLAudioElement;
      const observed = vi.fn();
      controller.onPlaybackDecoderError = observed;
      const error = { code: 3 } as MediaError;
      Object.defineProperty(decoder, "error", { configurable: true, value: error });
      decoder.dispatchEvent(new Event("error"));
      expect(observed).toHaveBeenCalledExactlyOnceWith(error);
      const stale = decoder.onerror!;
      controller.attachRemoteStream(fakeStream(new FakeAudioTrack()));
      expect(decoder.onerror).toBeNull();
      decoder.dispatchEvent(new Event("error"));
      stale.call(decoder, new Event("error"));
      expect(observed).toHaveBeenCalledOnce();
      await controller.playOutput();
      const replacement = vi.mocked(HTMLMediaElement.prototype.play).mock.contexts[1] as HTMLAudioElement;
      Object.defineProperty(replacement, "error", { configurable: true, value: error });
      replacement.dispatchEvent(new Event("error"));
      expect(observed).toHaveBeenCalledTimes(2);
      controller.detachRemoteStream();
      expect(replacement.onerror).toBeNull();
    } finally { controller.dispose(); }
  });
  it("rejects decoder startup failure before audible playback starts", async () => {
    const { controller, element } = setup();
    await controller.primeOutput();
    controller.attachRemoteStream(fakeStream(new FakeAudioTrack()));
    vi.mocked(HTMLMediaElement.prototype.play).mockRejectedValueOnce(new Error("Decoder refused"));
    await expect(controller.playOutput()).rejects.toThrow("Decoder refused");
    expect(element.play).not.toHaveBeenCalled();
    controller.dispose();
  });
  it("detaches terminal media, stops sampling and never primes a stale decoder in the next conversation", async () => {
    vi.useFakeTimers();
    const { controller, element, context, nodes, destinationStream } = setup();
    try {
      await controller.primeOutput();
      controller.attachRemoteStream(fakeStream(new FakeAudioTrack()));
      await controller.primeOutput();
      const decoder = vi.mocked(HTMLMediaElement.prototype.play).mock.contexts[0] as HTMLMediaElement;
      controller.detachRemoteStream();
      expect(decoder.srcObject).toBeNull();
      expect(element.srcObject).toBeNull();
      expect(context.sources[0]!.connections).toEqual([]);
      expect(destinationStream.getAudioTracks()[0]!.readyState).toBe("ended");
      expect(nodes[0]!.port.postMessage).toHaveBeenCalledWith({ type: "dispose" });
      expect(nodes[0]!.port.close).toHaveBeenCalledOnce();
      expect(vi.getTimerCount()).toBe(0);
      await controller.primeOutput();
      expect(HTMLMediaElement.prototype.play).toHaveBeenCalledOnce();
      expect(element.play).toHaveBeenCalledOnce();
    } finally { controller.dispose(); vi.useRealTimers(); }
  });
  it("terminates a retired worklet on stream replacement", async () => {
    const { controller, nodes } = setup();
    await controller.primeOutput();
    controller.attachRemoteStream(fakeStream(new FakeAudioTrack()));
    controller.attachRemoteStream(fakeStream(new FakeAudioTrack()));
    expect(nodes[0]!.port.postMessage).toHaveBeenCalledWith({ type: "dispose" });
    expect(nodes[0]!.port.close).toHaveBeenCalledOnce();
    expect(nodes[1]!.port.close).not.toHaveBeenCalled();
    controller.dispose();
  });
  it("plays processed PCM through the primed element and analyses played audio", async () => {
    const { controller, element, context, nodes, destinationStream } = setup();
    await controller.primeOutput();
    const remote = fakeStream(new FakeAudioTrack());
    controller.attachRemoteStream(remote);
    expect(element.srcObject).toBe(destinationStream);
    expect(context.sources[0]?.connections).toContain(context.analysers[0]);
    expect(nodes[0]?.connections).toContain(context.analysers[1]);
    controller.setOutputAudible(true);
    controller.setNonInterrupting(true);
    expect(element.muted).toBe(false);
    expect(nodes[0]?.port.postMessage).toHaveBeenCalledWith({ type: "enabled", value: true });
    controller.dispose();
  });
  it("keeps the original WebRTC decoder silent and releases it on replacement and disposal", async () => {
    const { controller, element } = setup();
    await controller.primeOutput();
    const remoteTrack = new FakeAudioTrack();
    const remote = fakeStream(remoteTrack);
    controller.attachRemoteStream(remote);
    await controller.primeOutput();
    const decoder = vi.mocked(HTMLMediaElement.prototype.play).mock.contexts[0] as HTMLMediaElement;
    expect(decoder).not.toBe(element);
    expect(decoder.srcObject).toBe(remote);
    expect(decoder.muted).toBe(true);
    expect(decoder.volume).toBe(0);
    controller.setOutputAudible(true);
    controller.setNonInterrupting(true);
    controller.setNonInterrupting(false);
    expect(decoder.muted).toBe(true);
    controller.setOutputAudible(false);
    expect(decoder.srcObject).toBe(remote); // still decode for lifecycle draining
    controller.attachRemoteStream(fakeStream(new FakeAudioTrack()));
    expect(decoder.srcObject).toBeNull();
    expect(HTMLMediaElement.prototype.pause).toHaveBeenCalledOnce();
    expect(remoteTrack.stop).not.toHaveBeenCalled();
    await controller.primeOutput();
    const replacement = vi.mocked(HTMLMediaElement.prototype.play).mock.contexts[1] as HTMLMediaElement;
    controller.dispose();
    expect(replacement.srcObject).toBeNull();
    expect(HTMLMediaElement.prototype.pause).toHaveBeenCalledTimes(2);
  });
  it("clears the queue on gate closure and ignores a retired stream's messages", async () => {
    const { controller, nodes } = setup();
    await controller.primeOutput();
    controller.attachRemoteStream(fakeStream(new FakeAudioTrack()));
    controller.setOutputAudible(true);
    const stale = nodes[0]!.port.onmessage!;
    stale({ data: { type: "pending", value: true } } as MessageEvent);
    expect(controller.hasPendingPlayback).toBe(true);
    controller.setOutputAudible(false);
    expect(controller.hasPendingPlayback).toBe(false);
    controller.attachRemoteStream(fakeStream(new FakeAudioTrack()));
    stale({ data: { type: "pending", value: true } } as MessageEvent);
    expect(controller.hasPendingPlayback).toBe(false);
    controller.dispose();
  });
  it("observes incoming audio while muted and played audio after reopening", async () => {
    vi.useFakeTimers();
    const { controller, context, nodes } = setup();
    try {
      await controller.primeOutput();
      controller.attachRemoteStream(fakeStream(new FakeAudioTrack()));
      const observed = vi.fn();
      controller.onPlaybackActivity = observed;
      context.analysers[0]!.fill(.2); // incoming provider audio
      context.analysers[1]!.fill(0); // held/cleared output
      await vi.advanceTimersByTimeAsync(100);
      expect(observed).toHaveBeenLastCalledWith(expect.objectContaining({ active: true }));
      controller.setOutputAudible(true);
      await vi.advanceTimersByTimeAsync(600);
      nodes[0]!.port.onmessage!({ data: { type: "turn", value: false } } as MessageEvent);
      expect(observed).toHaveBeenLastCalledWith(expect.objectContaining({ active: false }));
    } finally {
      controller.dispose();
      vi.useRealTimers();
    }
  });
  it("forwards queued playback ownership and ignores muted or retired owner messages", async () => {
    const { controller, nodes } = setup();
    await controller.primeOutput();
    controller.attachRemoteStream(fakeStream(new FakeAudioTrack()));
    const activity = vi.fn();
    controller.onPlaybackActivity = activity;
    controller.setOutputAudible(true);
    controller.setPlaybackTurn("A");
    expect(nodes[0]!.port.postMessage).toHaveBeenCalledWith({ type: "turn", turnId: "A" });
    const stale = nodes[0]!.port.onmessage!;
    stale({ data: { type: "turn", turnId: "A", value: true } } as MessageEvent);
    stale({ data: { type: "turn", turnId: "B", value: true } } as MessageEvent);
    stale({ data: { type: "turn", turnId: "B", value: false } } as MessageEvent);
    expect(activity.mock.calls.map(([event]) => [event.turnId, event.active, event.owned])).toEqual([
      ["A", true, true], ["B", true, true], ["B", false, true],
    ]);
    controller.setOutputAudible(false);
    stale({ data: { type: "turn", turnId: "discarded", value: true } } as MessageEvent);
    controller.attachRemoteStream(fakeStream(new FakeAudioTrack()));
    controller.setOutputAudible(true);
    stale({ data: { type: "turn", turnId: "retired", value: true } } as MessageEvent);
    expect(activity).toHaveBeenCalledTimes(4); // Gate closure explicitly retires played activity.
    expect(activity).toHaveBeenLastCalledWith(expect.objectContaining({ active: false, retired: true }));
    controller.dispose();
  });
  it("reports raw audio samples independently of held playback and only from a running context", async () => {
    vi.useFakeTimers();
    const { controller, context } = setup();
    try {
      await controller.primeOutput();
      controller.attachRemoteStream(fakeStream(new FakeAudioTrack()));
      controller.setOutputAudible(true);
      controller.setNonInterrupting(true);
      const raw = vi.fn(), played = vi.fn();
      controller.onRemoteAudioSample = raw;
      controller.onPlaybackActivity = played;
      context.analysers[0]!.fill(.2);
      context.analysers[1]!.fill(0);
      await vi.advanceTimersByTimeAsync(50);
      expect(controller.rawPlaybackActive).toBe(true);
      expect(raw).toHaveBeenLastCalledWith(expect.objectContaining({ active: true }));
      expect(played).not.toHaveBeenCalled();
      controller.setOutputAudible(false);
      context.analysers[0]!.fill(0);
      context.state = "suspended";
      raw.mockClear();
      await vi.advanceTimersByTimeAsync(600);
      expect(raw).not.toHaveBeenCalled();
      expect(controller.rawPlaybackActive).toBe(true);
      await controller.primeOutput();
      await vi.advanceTimersByTimeAsync(100);
      expect(controller.rawPlaybackActive).toBe(false);
      expect(raw).toHaveBeenLastCalledWith(expect.objectContaining({ active: false }));
      expect(raw).toHaveBeenCalledTimes(2); // Fresh idle is reported even without another activity edge.
      controller.detachRemoteStream();
      expect(controller.rawPlaybackActive).toBeUndefined();
    } finally { controller.dispose(); vi.useRealTimers(); }
  });
  it("fails closed when the worklet fails instead of switching to overlapping speech", async () => {
    const { controller, nodes, element } = setup();
    await controller.primeOutput();
    controller.attachRemoteStream(fakeStream(new FakeAudioTrack()));
    controller.setOutputAudible(true);
    const failed = vi.fn(); controller.onPlaybackBufferError = failed;
    nodes[0]!.onprocessorerror!();
    expect(element.muted).toBe(true);
    expect(failed).toHaveBeenCalledOnce();
    controller.dispose();
  });
});
