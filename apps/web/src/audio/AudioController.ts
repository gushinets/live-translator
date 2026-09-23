import { PlaybackActivityDetector } from "./PlaybackActivityDetector";
import { VAM_SAMPLE_INTERVAL_MS } from "./VoiceActivityEstimator";
import {
  VoiceActivityMonitor,
  type AudioActivityEvent,
} from "./VoiceActivityMonitor";

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
 * Owns microphone capture (Gate A), one remote HTMLAudioElement (Gate C),
 * analyser-only VAM/playback graphs, and user-gesture output priming.
 * Does not mute Live model input (Gate B).
 */
export class AudioController {
  onSourceSample: ((event: AudioActivityEvent & { reset?: boolean }) => void) | null = null;
  onVoiceActivity: ((event: AudioActivityEvent) => void) | null = null;
  onPlaybackActivity: ((event: AudioActivityEvent) => void) | null = null;
  onAudioInterruption: (() => void) | null = null;
  onAudioRestored: (() => void) | null = null;
  onCaptureEnded: (() => void) | null = null;

  readonly audioElement: HTMLAudioElement;

  private readonly getUserMedia: (
    constraints: MediaStreamConstraints,
  ) => Promise<MediaStream>;
  private readonly createAudioContext: () => AudioContext;
  private readonly nowMs: () => number;
  private readonly voiceActivityMonitor = new VoiceActivityMonitor();
  private readonly playbackDetector = new PlaybackActivityDetector();

  private audioContext: AudioContext | null = null;
  private captureStream: MediaStream | null = null;
  private captureTrack: MediaStreamTrack | null = null;
  private microphoneSettings: MicrophoneSettingsDiagnostics | null = null;
  private micSource: MediaStreamAudioSourceNode | null = null;
  private micAnalyser: AnalyserNode | null = null;
  private micAnalysisStream: MediaStream | null = null;
  private remoteSource: MediaStreamAudioSourceNode | null = null;
  private remoteAnalyser: AnalyserNode | null = null;
  private remoteAnalysisStream: MediaStream | null = null;
  private sampleTimer: number | null = null;

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

    this.voiceActivityMonitor.onActivity = (event) => {
      this.onVoiceActivity?.(event);
    };
    this.voiceActivityMonitor.onSample = event => {
      this.onSourceSample?.({ active: event.active, atMs: performance.now() });
    };
    this.playbackDetector.onActivity = (event) => {
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
    console.info("Microphone track settings", this.microphoneSettings);
    this.syncSampler();
  }

  stopCapture(): void {
    if (this.captureTrack === null || this.captureStream === null || this.micSource === null) {
      throw new Error("Microphone capture has not started");
    }
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
    this.captureTrack.enabled = enabled;
    for (const track of this.micAnalysisStream.getAudioTracks()) {
      track.enabled = enabled;
    }
    this.notifyMeteringBoundary();
  }

  /** Gate C: mute local GPT playback. Never uses Live input mute. */
  setOutputAudible(audible: boolean): void {
    this.audioElement.muted = !audible;
  }

  attachRemoteStream(stream: MediaStream): void {
    this.audioElement.srcObject = stream;
    this.remoteSource?.disconnect();
    stopTracks(this.remoteAnalysisStream);
    const context = this.ensureAudioContext();
    const analysisStream = cloneStream(stream);
    this.remoteAnalysisStream = analysisStream;
    this.remoteSource = context.createMediaStreamSource(analysisStream);
    this.remoteAnalyser = context.createAnalyser();
    this.remoteSource.connect(this.remoteAnalyser);
    this.syncSampler();
  }

  async primeOutput(): Promise<void> {
    const context = this.ensureAudioContext();
    await context.resume();
    if (this.audioElement.srcObject !== null) {
      await this.audioElement.play();
    }
  }

  dispose(): void {
    if (this.captureTrack !== null) {
      this.stopCapture();
    }
    this.remoteSource?.disconnect();
    stopTracks(this.remoteAnalysisStream);
    this.remoteSource = null;
    this.remoteAnalyser = null;
    this.remoteAnalysisStream = null;
    this.audioElement.srcObject = null;
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
      this.playbackDetector.pushRms(rmsFromAnalyser(this.remoteAnalyser), atMs);
    }
    if (this.micAnalyser !== null) {
      this.voiceActivityMonitor.pushRms(
        rmsFromAnalyser(this.micAnalyser),
        !this.audioElement.muted && this.playbackDetector.active,
        atMs,
      );
    }
  }
}
