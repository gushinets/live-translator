import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { VoiceActivityEstimator } from "./VoiceActivityEstimator";
import { AudioController } from "./AudioController";

class FakeAudioTrack {
  kind = "audio";
  enabled = true;
  readyState: MediaStreamTrackState = "live";
  addEventListener = vi.fn();
  removeEventListener = vi.fn();
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

  it("mutes local output immediately during correction", async () => {
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

  it("resumes the analyser AudioContext from a user-gesture prime", async () => {
    await controller.startCapture();
    controller.attachRemoteStream(fakeStream(new FakeAudioTrack()));

    await controller.primeOutput();

    expect(audioContext.resume).toHaveBeenCalled();
    expect(audioElement.play).toHaveBeenCalledOnce();
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
