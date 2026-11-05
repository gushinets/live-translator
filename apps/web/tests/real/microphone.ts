import type { Page } from "@playwright/test";

export interface RealLiveEventDiagnostic {
  type: string;
  delta?: string;
  errorMessage?: string;
  atMs: number;
}

declare global {
  interface Window {
    __liveTranslatorRealMic?: {
      isReady(): boolean;
      captureTracks(): MediaStreamTrack[];
      startBase64Audio(base64: string): Promise<void>;
      waitForPlaybackComplete(): Promise<void>;
    };
    __liveTranslatorRealDiagnostics?: {
      events: RealLiveEventDiagnostic[];
      outboundAudioBytesSent(): Promise<number>;
      inboundAudioBytesReceived(): Promise<number>;
      remoteAudioRmsSamples(durationMs: number): Promise<number[]>;
    };
  }
}

export async function installDeterministicMicrophone(page: Page): Promise<void> {
  await page.addInitScript(() => {
    let context: AudioContext | null = null;
    let destination: MediaStreamAudioDestinationNode | null = null;
    let playbackComplete: Promise<void> | null = null;
    const liveEvents: RealLiveEventDiagnostic[] = [];
    const captureTracks: MediaStreamTrack[] = [];

    async function ensureMicrophone(): Promise<{
      context: AudioContext;
      destination: MediaStreamAudioDestinationNode;
    }> {
      if (context === null) {
        context = new AudioContext();
      }
      if (context.state !== "running") {
        await context.resume();
      }
      if (destination === null) {
        destination = context.createMediaStreamDestination();
        // Keep the provider timeline advancing before and between speech fixtures.
        const silence = context.createConstantSource();
        silence.offset.value = 0;
        silence.connect(destination);
        silence.start();
      }
      return { context, destination };
    }

    const originalCreateDataChannel = RTCPeerConnection.prototype.createDataChannel;
    RTCPeerConnection.prototype.createDataChannel = function (
      label: string,
      dataChannelDict?: RTCDataChannelInit,
    ): RTCDataChannel {
      const channel = originalCreateDataChannel.call(this, label, dataChannelDict);
      channel.addEventListener("message", (event) => {
        if (typeof event.data !== "string") {
          return;
        }
        try {
          const parsed = JSON.parse(event.data) as {
            type?: unknown;
            delta?: unknown;
            error?: { message?: unknown };
          };
          if (typeof parsed.type !== "string") {
            return;
          }
          liveEvents.push({
            type: parsed.type,
            delta: typeof parsed.delta === "string" ? parsed.delta : undefined,
            errorMessage:
              typeof parsed.error?.message === "string" ? parsed.error.message : undefined,
            atMs: performance.now(),
          });
        } catch {
          liveEvents.push({ type: "<invalid-json>", atMs: performance.now() });
        }
      });
      window.__liveTranslatorRealDiagnostics = {
        events: liveEvents,
        outboundAudioBytesSent: async (): Promise<number> => {
          const report = await this.getStats();
          let bytesSent = 0;
          report.forEach((entry) => {
            if (
              entry.type === "outbound-rtp" &&
              entry.kind === "audio" &&
              typeof entry.bytesSent === "number"
            ) {
              bytesSent += entry.bytesSent;
            }
          });
          return bytesSent;
        },
        inboundAudioBytesReceived: async (): Promise<number> => {
          const report = await this.getStats();
          let bytesReceived = 0;
          report.forEach((entry) => {
            if (
              entry.type === "inbound-rtp" &&
              entry.kind === "audio" &&
              typeof entry.bytesReceived === "number"
            ) {
              bytesReceived += entry.bytesReceived;
            }
          });
          return bytesReceived;
        },
        remoteAudioRmsSamples: async (durationMs: number): Promise<number[]> => {
          const element = document.querySelector("audio");
          if (!(element instanceof HTMLAudioElement) || !(element.srcObject instanceof MediaStream)) {
            return [];
          }
          const microphone = await ensureMicrophone();
          const analysisStream = element.srcObject.clone();
          const source = microphone.context.createMediaStreamSource(analysisStream);
          const analyser = microphone.context.createAnalyser();
          analyser.fftSize = 2048;
          const silentSink = microphone.context.createGain();
          silentSink.gain.value = 0;
          source.connect(analyser);
          analyser.connect(silentSink);
          silentSink.connect(microphone.context.destination);
          const samples = new Float32Array(analyser.fftSize);
          const rmsValues: number[] = [];
          const deadline = performance.now() + durationMs;
          try {
            while (performance.now() < deadline) {
              analyser.getFloatTimeDomainData(samples);
              let sumSquares = 0;
              for (const sample of samples) {
                sumSquares += sample * sample;
              }
              rmsValues.push(Math.sqrt(sumSquares / samples.length));
              await new Promise<void>((resolve) => window.setTimeout(resolve, 50));
            }
          } finally {
            source.disconnect();
            analyser.disconnect();
            silentSink.disconnect();
            for (const track of analysisStream.getTracks()) {
              track.stop();
            }
          }
          return rmsValues;
        },
      };
      return channel;
    };

    Object.defineProperty(navigator.mediaDevices, "getUserMedia", {
      configurable: true,
      value: async (constraints: MediaStreamConstraints): Promise<MediaStream> => {
        if (constraints.audio === false || constraints.audio === undefined) {
          throw new Error("Real-Live test microphone only supports audio capture");
        }
        const stream = (await ensureMicrophone()).destination.stream.clone();
        captureTracks.push(...stream.getAudioTracks());
        return stream;
      },
    });

    window.__liveTranslatorRealMic = {
      isReady: () => destination !== null,
      captureTracks: () => captureTracks,
      startBase64Audio: async (base64: string): Promise<void> => {
        if (playbackComplete !== null) {
          throw new Error("A real-Live microphone fixture is already playing");
        }
        const microphone = await ensureMicrophone();
        const bytes = Uint8Array.from(atob(base64), (character) =>
          character.charCodeAt(0),
        );
        const decoded = await microphone.context.decodeAudioData(bytes.buffer.slice(0));
        const source = microphone.context.createBufferSource();
        source.buffer = decoded;
        source.connect(microphone.destination);
        playbackComplete = new Promise<void>((resolve) => {
          source.addEventListener(
            "ended",
            () => {
              window.setTimeout(() => {
                playbackComplete = null;
                resolve();
              }, 350);
            },
            { once: true },
          );
        });
        source.start();
      },
      waitForPlaybackComplete: async (): Promise<void> => {
        const currentPlayback = playbackComplete;
        if (currentPlayback !== null) {
          await currentPlayback;
        }
      },
    };
  });
}
