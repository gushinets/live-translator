import playbackWorkletUrl from "./BufferedPlaybackProcessor.ts?worker&url";
import { PlaybackActivityDetector } from "./PlaybackActivityDetector";
import { VAM_SAMPLE_INTERVAL_MS } from "./VoiceActivityEstimator";
import { runtime } from "../config/runtime";
import {
  VoiceActivityMonitor,
  type AudioActivityEvent,
} from "./VoiceActivityMonitor";

/** `owned` events identify the PCM currently leaving the queue, including an unknown owner. */
export type PlaybackActivityEvent = AudioActivityEvent & { owned?: boolean; turnId?: string; retired?: boolean };

export interface MicrophoneSettingsDiagnostics {
  echoCancellation: boolean | undefined;
  noiseSuppression: boolean | undefined;
  autoGainControl: boolean | undefined;
  channelCount: number | undefined;
  sampleRate: number | undefined;
}

export interface AudioControllerOptions {
  getUserMedia?: (constraints: MediaStreamConstraints) => Promise<MediaStream>;
  audioElement?: HTMLAudioElement;
  createAudioContext?: () => AudioContext;
  nowMs?: () => number;
  createPlaybackNode?: (context: AudioContext) => AudioWorkletNode;
}

function rmsFromAnalyser(analyser: AnalyserNode): number {
  const samples = new Float32Array(analyser.fftSize);
  analyser.getFloatTimeDomainData(samples);
  if (samples.length === 0) {
    throw new Error("Analyser time-domain buffer is empty");
  }
  let sumSquares = 0;
  for (const sample of samples) {
    sumSquares += sample * sample;
  }
  return Math.sqrt(sumSquares / samples.length);
}

function cloneStream(stream: MediaStream): MediaStream {
  if (typeof stream.clone !== "function") {
    throw new Error("MediaStream.clone is required for analyser isolation");
  }
  return stream.clone();
}

function stopTracks(stream: MediaStream | null): void {
  if (stream === null) {
    return;
  }
  for (const track of stream.getTracks()) {
    track.stop();
  }
}

function readMicrophoneSettings(track: MediaStreamTrack): MicrophoneSettingsDiagnostics {
  const settings = track.getSettings();
  return {
    echoCancellation: settings.echoCancellation,
    noiseSuppression: settings.noiseSuppression,
    autoGainControl: settings.autoGainControl,
    channelCount: settings.channelCount,
    sampleRate: settings.sampleRate,
  };
}

/**
 * Owns microphone capture (Gate A), the HTMLAudioElement playback gate (Gate C),
 * local PCM buffering, source/playback analysers, and user-gesture output priming.
 * Does not mute Live model input (Gate B).
 */
export class AudioController {
  onSourceSample: ((event: AudioActivityEvent & { reset?: boolean }) => void) | null = null;
  onVoiceActivity: ((event: AudioActivityEvent) => void) | null = null;
  onPlaybackActivity: ((event: PlaybackActivityEvent) => void) | null = null;
  onPlaybackInputBlocked: (() => void) | null = null;
  onRemoteAudioSample: ((event: AudioActivityEvent) => void) | null = null;
  onAudioInterruption: (() => void) | null = null;
  onAudioRestored: (() => void) | null = null;
  onCaptureEnded: (() => void) | null = null;
  onPlaybackBufferError: (() => void) | null = null;
  onPlaybackDecoderError: ((error: MediaError) => void) | null = null;

  readonly audioElement: HTMLAudioElement;

  private readonly getUserMedia: (
    constraints: MediaStreamConstraints,
  ) => Promise<MediaStream>;
  private readonly createAudioContext: () => AudioContext;
  private readonly nowMs: () => number;
  private readonly voiceActivityMonitor = new VoiceActivityMonitor();
  private readonly playbackDetector = new PlaybackActivityDetector();
  private readonly rawPlaybackDetector = new PlaybackActivityDetector();

  private audioContext: AudioContext | null = null;
  private captureStream: MediaStream | null = null;
  private captureTrack: MediaStreamTrack | null = null;
  private microphoneSettings: MicrophoneSettingsDiagnostics | null = null;
  private micSource: MediaStreamAudioSourceNode | null = null;
  private micAnalyser: AnalyserNode | null = null;
  private micAnalysisStream: MediaStream | null = null;
  private remoteSource: MediaStreamAudioSourceNode | null = null;
  private remoteAnalyser: AnalyserNode | null = null;
  private playedAnalyser: AnalyserNode | null = null;
  private remoteAnalysisStream: MediaStream | null = null;
  private sampleTimer: number | null = null;
  private readonly createPlaybackNode: (context: AudioContext) => AudioWorkletNode;
  private workletPreparation: Promise<void> | null = null;
  private workletReady = false;
  private playbackNode: AudioWorkletNode | null = null;
  private playbackDestination: MediaStreamAudioDestinationNode | null = null;
  private remoteDecoder: HTMLAudioElement | null = null;
  private queuedPlayback = false;
  private nonInterrupting = true;
  private sourceSpeaking = false;
  private lastSourceSpeaking: boolean | null = null;
  private captureEnabled = false;
  private inputBlocked = false;
  private playbackReleaseTimer: number | null = null;
  get playbackInputBlocked(): boolean { return this.inputBlocked; }
  get hasPendingPlayback(): boolean { return this.queuedPlayback; }
  get rawPlaybackActive(): boolean | undefined {
    return this.remoteAnalyser === null ? undefined : this.rawPlaybackDetector.active;
  }


  constructor(options: AudioControllerOptions = {}) {
    this.getUserMedia =
      options.getUserMedia ??
      ((constraints) => navigator.mediaDevices.getUserMedia(constraints));
    this.audioElement = options.audioElement ?? document.createElement("audio");
    this.audioElement.autoplay = true;
    this.audioElement.muted = true;
    this.createAudioContext =
      options.createAudioContext ?? (() => new AudioContext());
    this.nowMs = options.nowMs ?? (() => Date.now());
    this.createPlaybackNode = options.createPlaybackNode ?? (context =>
      new AudioWorkletNode(context, "buffered-playback", {
        numberOfInputs: 1, numberOfOutputs: 1, outputChannelCount: [1],
        channelCount: 1, channelCountMode: "explicit",
      }));


    this.voiceActivityMonitor.onActivity = (event) => {
      this.onVoiceActivity?.(event);
    };
    this.voiceActivityMonitor.onSample = event => {
      this.sourceSpeaking = event.active;
      this.sendSourceActivity();
      this.onSourceSample?.({ active: event.active, atMs: performance.now() });
    };
    this.playbackDetector.onActivity = (event) => {
      // The worklet reports played activity and FIFO ownership, including phrases shorter than a sampler tick.
      if (this.playbackNode && !this.audioElement.muted) return;
      this.onPlaybackActivity?.(event);
    };
    this.installE2eAudioHooks();
  }

  /**
   * Playwright-only: when the e2e init script sets `__LIVE_TRANSLATOR_E2E`,
   * expose direct VAM/playback edges so tests do not drive real RMS.
   */
  private installE2eAudioHooks(): void {
    const e2eWindow = window as Window & {
      __LIVE_TRANSLATOR_E2E?: boolean;
      __liveTranslatorTestAudio?: {
        emitVoiceActivity(active: boolean, atMs: number): void;
        emitPlaybackActivity(active: boolean, atMs: number): void;
        isOutputMuted(): boolean;
      };
    };
    if (e2eWindow.__LIVE_TRANSLATOR_E2E !== true) {
      return;
    }
    e2eWindow.__liveTranslatorTestAudio = {
      emitVoiceActivity: (active, atMs) => {
        this.onVoiceActivity?.({ active, atMs });
      },
      emitPlaybackActivity: (active, atMs) => {
        this.onPlaybackActivity?.({ active, atMs });
      },
      isOutputMuted: () => this.audioElement.muted,
    };
  }

  getMicrophoneSettings(): MicrophoneSettingsDiagnostics | null {
    if (this.microphoneSettings === null) {
      return null;
    }
    return { ...this.microphoneSettings };
  }

  get meteringMediaReady(): boolean { return this.audioContext?.state === "running" && this.captureTrack?.readyState === "live"; }
  private notifyMeteringBoundary(): void {
    try { this.onSourceSample?.({ active: false, atMs: performance.now(), reset: true }); }
    catch { console.error("Audio metadata boundary observer failed"); }
  }
  getCaptureStream(): MediaStream | null {
    return this.captureStream;
  }

  resetVoiceActivityBaseline(): void {
    this.voiceActivityMonitor.resetBaseline();
    this.sourceSpeaking = false;
    this.lastSourceSpeaking = null;
    this.sendSourceActivity();
    try { this.onSourceSample?.({ active: false, atMs: performance.now(), reset: true }); }
    catch { console.error("Source reset metadata observer failed"); }
  }

  async startCapture(): Promise<void> {
    if (this.captureTrack !== null) {
      throw new Error("Microphone capture has already started");
    }

    const context = this.ensureAudioContext();
    const resumeStarted = context.resume();

    let stream: MediaStream;
    try {
      stream = await this.getUserMedia({
        audio: {
          echoCancellation: true,
          noiseSuppression: false,
        },
      });
    } catch (error) {
      console.error("getUserMedia failed", {
        error,
        constraints: { echoCancellation: true, noiseSuppression: false },
      });
      throw error;
    }

    await resumeStarted;

    const track = stream.getAudioTracks()[0];
    if (track === undefined) {
      for (const existing of stream.getTracks()) {
        existing.stop();
      }
      throw new Error("Microphone stream has no audio track");
    }
    track.addEventListener("ended", this.handleCaptureEnded);
    if (track.readyState !== "live") {
      track.removeEventListener("ended", this.handleCaptureEnded);
      for (const existing of stream.getTracks()) {
        existing.stop();
      }
      throw new Error(`Microphone track is not live (readyState "${track.readyState}")`);
    }

    const analysisStream = cloneStream(stream);
    const micSource = context.createMediaStreamSource(analysisStream);
    const micAnalyser = context.createAnalyser();
    micSource.connect(micAnalyser);

    this.captureStream = stream;
    this.captureTrack = track;
    this.micAnalysisStream = analysisStream;
    this.micSource = micSource;
    this.micAnalyser = micAnalyser;
    this.microphoneSettings = readMicrophoneSettings(track);
    this.captureEnabled = true;
    this.applyCaptureGate();
    console.info("Microphone track settings", this.microphoneSettings);
    this.syncSampler();
  }

  stopCapture(): void {
    if (this.captureTrack === null || this.captureStream === null || this.micSource === null) {
      throw new Error("Microphone capture has not started");
    }
    this.captureEnabled = false;
    this.captureTrack.removeEventListener("ended", this.handleCaptureEnded);
    for (const track of this.captureStream.getTracks()) {
      track.stop();
    }
    this.micSource.disconnect();
    stopTracks(this.micAnalysisStream);
    this.micSource = null;
    this.micAnalyser = null;
    this.micAnalysisStream = null;
    this.captureTrack = null;
    this.captureStream = null;
    this.notifyMeteringBoundary();
    this.syncSampler();
  }

  setCaptureEnabled(enabled: boolean): void {
    if (this.captureTrack === null || this.micAnalysisStream === null) {
      throw new Error("Microphone capture has not started");
    }
    this.captureEnabled = enabled;
    this.applyCaptureGate();
    this.notifyMeteringBoundary();
  }

  private applyCaptureGate(): void {
    const enabled = this.captureEnabled && !this.inputBlocked;
    if (this.captureTrack) this.captureTrack.enabled = enabled;
    for (const track of this.micAnalysisStream?.getAudioTracks() ?? []) track.enabled = enabled;
  }

  private blockPlaybackInput(blocked: boolean): void {
    if (this.inputBlocked === blocked) return;
    this.inputBlocked = blocked;
    this.applyCaptureGate();
    this.resetVoiceActivityBaseline();
    this.onPlaybackInputBlocked?.();
  }

  private cancelPlaybackRelease(): void {
    if (this.playbackReleaseTimer !== null) window.clearTimeout(this.playbackReleaseTimer);
    this.playbackReleaseTimer = null;
  }

  private releasePlaybackInput(): void {
    this.cancelPlaybackRelease();
    if (!this.inputBlocked) return;
    this.playbackReleaseTimer = window.setTimeout(() => {
      this.playbackReleaseTimer = null;
      this.blockPlaybackInput(false);
    }, runtime.playbackEchoTailMs);
  }

  /** Gate C: mute local GPT playback. Never uses Live input mute. */
  setOutputAudible(audible: boolean): void {
    this.audioElement.muted = !audible;
    this.playbackNode?.port.postMessage({ type: "audible", value: audible });
    if (!audible) {
      this.releasePlaybackInput();
      this.queuedPlayback = false;
      this.playbackDetector.reset();
      // Retire worklet activity even if sampled RMS stayed quiet; this is not normal playback completion.
      this.onPlaybackActivity?.({ active: false, atMs: this.nowMs(), retired: true });
    }
  }

  setPlaybackTurn(turnId: string | undefined): void {
    this.playbackNode?.port.postMessage({ type: "turn", turnId });
  }

  setNonInterrupting(enabled: boolean): void {
    if (enabled && !this.playbackNode) throw new Error("Buffered playback unavailable");
    this.nonInterrupting = enabled;
    this.playbackNode?.port.postMessage({ type: "enabled", value: enabled });
    this.sendSourceActivity();
    if (!enabled) this.releasePlaybackInput();
  }

  private sendSourceActivity(): void {
    if (!this.playbackNode || this.lastSourceSpeaking === this.sourceSpeaking) return;
    this.lastSourceSpeaking = this.sourceSpeaking;
    this.playbackNode.port.postMessage({ type: "speaking", value: this.sourceSpeaking });
  }

  private async preparePlayback(): Promise<void> {
    if (this.workletPreparation) return this.workletPreparation;
    const context = this.ensureAudioContext();
    if (!context.audioWorklet) return;
    this.workletPreparation = context.audioWorklet.addModule(playbackWorkletUrl)
      .then(() => { if (this.audioContext === context) this.workletReady = true; })
      .catch(() => { console.warn("Buffered playback is unavailable in this browser"); });
    return this.workletPreparation;
  }

  private releasePlayback(): void {
    this.releasePlaybackInput();
    if (this.remoteDecoder) {
      this.remoteDecoder.onerror = null;
      this.remoteDecoder.pause();
      this.remoteDecoder.srcObject = null;
      this.remoteDecoder = null;
    }
    if (this.playbackNode) {
      this.playbackNode.port.postMessage({ type: "dispose" });
      this.playbackNode.port.close();
      this.playbackNode.port.onmessage = null;
      this.playbackNode.onprocessorerror = null;
      this.playbackNode.disconnect();
      this.playbackNode = null;
    }
    stopTracks(this.playbackDestination?.stream ?? null);
    this.playbackDestination = null;
    this.playedAnalyser = null;
    this.queuedPlayback = false;
    this.lastSourceSpeaking = null;
  }

  private connectPlayback(context: AudioContext, remoteStream: MediaStream): void {
    const node = this.createPlaybackNode(context);
    this.playbackNode = node;
    this.playbackDestination = context.createMediaStreamDestination();
    const fail = () => {
      if (this.playbackNode !== node) return;
      this.setOutputAudible(false);
      this.onPlaybackBufferError?.();
    };
    node.onprocessorerror = fail;
    node.port.onmessage = ({ data }: MessageEvent<{ type: string; value?: boolean; turnId?: string }>) => {
      if (this.playbackNode !== node) return;
      if (data.type === "playback" && !this.audioElement.muted && this.nonInterrupting) {
        if (data.value === true) {
          if (this.sourceSpeaking && !this.inputBlocked) {
            node.port.postMessage({ type: "playback", value: false });
            return;
          }
          this.cancelPlaybackRelease();
          try {
            this.blockPlaybackInput(true);
            if (this.playbackNode === node && !this.audioElement.muted) node.port.postMessage({ type: "playback", value: true });
          } catch { fail(); }
        } else this.releasePlaybackInput();
      }
      if (data.type === "pending") this.queuedPlayback = !this.audioElement.muted && data.value === true;
      if (data.type === "turn" && !this.audioElement.muted) {
        this.onPlaybackActivity?.({ active: data.value === true, atMs: this.nowMs(), owned: true,
          turnId: typeof data.turnId === "string" ? data.turnId : undefined });
      }
      if (data.type === "error") fail();
    };
    node.port.postMessage({ type: "enabled", value: this.nonInterrupting });
    node.port.postMessage({ type: "audible", value: !this.audioElement.muted });
    this.sendSourceActivity();
    this.remoteSource!.connect(node);
    this.playedAnalyser = context.createAnalyser();
    node.connect(this.playedAnalyser);
    node.connect(this.playbackDestination);
    // Chrome does not pull/decode remote WebRTC audio through the cloned Web Audio
    // source alone. Keep the original stream playing silently; only queued PCM is audible.
    const decoder = document.createElement("audio");
    this.remoteDecoder = decoder;
    decoder.onerror = () => {
      const error = decoder.error;
      if (this.remoteDecoder === decoder && error) this.onPlaybackDecoderError?.(error);
    };
    decoder.muted = decoder.defaultMuted = true;
    decoder.volume = 0;
    decoder.autoplay = true;
    decoder.srcObject = remoteStream;
    this.audioElement.srcObject = this.playbackDestination.stream;
  }

  /** Retire remote resources while keeping the primed context for a new conversation. */
  detachRemoteStream(): void {
    this.releasePlayback();
    this.remoteSource?.disconnect();
    stopTracks(this.remoteAnalysisStream);
    this.remoteSource = null;
    this.remoteAnalyser = null;
    this.remoteAnalysisStream = null;
    this.playbackDetector.reset();
    this.rawPlaybackDetector.reset();
    this.audioElement.pause();
    this.audioElement.srcObject = null;
    this.syncSampler();
  }

  attachRemoteStream(stream: MediaStream): void {
    // Recreate the media pipeline after Android backgrounding or a replaced WebRTC stream.
    this.detachRemoteStream();
    const context = this.ensureAudioContext();
    const analysisStream = cloneStream(stream);
    this.remoteAnalysisStream = analysisStream;
    this.remoteSource = context.createMediaStreamSource(analysisStream);
    this.remoteAnalyser = context.createAnalyser();
    this.remoteSource.connect(this.remoteAnalyser);
    try {
      if (!this.workletReady) throw new Error("Buffered playback unavailable");
      this.connectPlayback(context, stream);
    } catch {
      this.releasePlayback();
      // Buffered playback must never silently become direct playback.
      if (this.nonInterrupting) {
        this.setOutputAudible(false);
        this.onPlaybackBufferError?.();
      } else {
        this.audioElement.srcObject = stream;
      }
    }
    this.audioElement.load();
    this.syncSampler();
  }

  async primeOutput(): Promise<void> {
    const context = this.ensureAudioContext();
    await context.resume();
    await this.preparePlayback();
    await this.playOutput();
  }

  async playOutput(): Promise<void> {
    const decoder = this.remoteDecoder;
    const stream = this.audioElement.srcObject;
    if (decoder) {
      if (decoder.error !== null) decoder.load();
      await decoder.play();
      if (decoder !== this.remoteDecoder || stream !== this.audioElement.srcObject) return;
    }
    if (stream !== null) {
      if (this.audioElement.error !== null) this.audioElement.load();
      await this.audioElement.play();
    }
  }

  dispose(): void {
    this.captureEnabled = false;
    this.detachRemoteStream();
    this.workletReady = false;
    this.workletPreparation = null;
    if (this.captureTrack !== null) {
      this.stopCapture();
    }
    this.cancelPlaybackRelease();
    this.blockPlaybackInput(false);
    this.stopSampler();
    if (this.audioContext !== null) {
      const context = this.audioContext;
      this.audioContext = null;
      context.removeEventListener("statechange", this.handleContextStateChange);
      void context.close();
    }
  }

  private contextWasInterrupted = false;

  private readonly handleCaptureEnded = (): void => {
    if (this.captureTrack?.readyState !== "ended") {
      return;
    }
    this.notifyMeteringBoundary();
    this.onCaptureEnded?.();
  };

  private readonly handleContextStateChange = (): void => {
    if (this.audioContext === null) {
      return;
    }
    this.notifyMeteringBoundary();
    if ((this.audioContext.state as string) === "interrupted") {
      this.contextWasInterrupted = true;
      this.onAudioInterruption?.();
      return;
    }
    if (this.contextWasInterrupted) {
      this.contextWasInterrupted = false;
      this.onAudioRestored?.();
    }
  };

  private ensureAudioContext(): AudioContext {
    if (this.audioContext === null) {
      this.audioContext = this.createAudioContext();
      this.audioContext.addEventListener("statechange", this.handleContextStateChange);
    }
    return this.audioContext;
  }

  private syncSampler(): void {
    if (this.micAnalyser !== null || this.remoteAnalyser !== null) {
      this.startSampler();
      return;
    }
    this.stopSampler();
  }

  private startSampler(): void {
    if (this.sampleTimer !== null) {
      return;
    }
    this.sampleTimer = window.setInterval(() => {
      this.sample();
    }, VAM_SAMPLE_INTERVAL_MS);
  }

  private stopSampler(): void {
    if (this.sampleTimer === null) {
      return;
    }
    window.clearInterval(this.sampleTimer);
    this.sampleTimer = null;
  }

  private sample(): void {
    const atMs = this.nowMs();
    if (this.remoteAnalyser !== null) {
      const rawRms = rmsFromAnalyser(this.remoteAnalyser);
      const fresh = this.audioContext?.state === "running";
      if (fresh) this.rawPlaybackDetector.pushRms(rawRms, atMs);
      // Turn completion observes played PCM; lifecycle draining also observes incoming audio.
      const playedRms = !this.audioElement.muted && this.playedAnalyser ? rmsFromAnalyser(this.playedAnalyser) : rawRms;
      this.playbackDetector.pushRms(playedRms, atMs);
      if (fresh) this.onRemoteAudioSample?.({ active: this.rawPlaybackDetector.active, atMs });
    }
    if (this.micAnalyser !== null && this.captureTrack?.enabled) {
      this.voiceActivityMonitor.pushRms(
        rmsFromAnalyser(this.micAnalyser),
        !this.audioElement.muted && this.playbackDetector.active,
        atMs,
      );
    }
  }
}
