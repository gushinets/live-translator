import { expect, type Page } from "@playwright/test";

export interface LiveHarnessSentEvent {
  type: string;
  event_id?: string;
  content?: string;
}

export type LiveAckType =
  | "session.instructions.appended"
  | "session.thinking.appended"
  | "session.commentary.appended"
  | "session.input_audio.muted"
  | "session.input_audio.unmuted";

declare global {
  interface Window {
    __LIVE_TRANSLATOR_E2E?: boolean;
    __liveTranslatorTestAudio?: {
      emitVoiceActivity(active: boolean, atMs: number): void;
      emitPlaybackActivity(active: boolean, atMs: number): void;
      isOutputMuted(): boolean;
    };
    __liveTranslatorTestLive?: {
      channel: EventTarget | null;
      sent: LiveHarnessSentEvent[];
      peerCreateCount: number;
      emit(payload: unknown): void;
    };
  }
}

/**
 * Deterministic GPT-Live / WebRTC / VAM stand-in for Playwright. Does not
 * exercise real microphone, remote TTS, or OpenAI.
 */
export class MockLiveHarness {
  private liveSessionCreates = 0;

  private constructor(readonly page: Page) {}

  static async attach(page: Page): Promise<MockLiveHarness> {
    const harness = new MockLiveHarness(page);
    const start = new Date("2026-09-14T00:00:00.000Z");
    await page.clock.install({ time: start });
    await page.clock.pauseAt(start);
    await harness.installInitScript();
    await harness.installBackendStub();
    return harness;
  }

  async sessionStarted(): Promise<void> {
    await this.emitLiveEvent({
      type: "session.started",
      session: { id: "sess_e2e" },
    });
  }

  async inputDelta(text: string, startMs?: number, endMs?: number): Promise<void> {
    const payload: {
      type: "session.input_transcript.delta";
      delta: string;
      start_ms?: number;
      end_ms?: number;
    } = {
      type: "session.input_transcript.delta",
      delta: text,
    };
    if (startMs !== undefined) {
      payload.start_ms = startMs;
    }
    if (endMs !== undefined) {
      payload.end_ms = endMs;
    }
    await this.emitLiveEvent(payload);
  }

  async sourceActive(): Promise<void> {
    await this.emitVoiceActivity(true);
  }

  async sourceQuiet(): Promise<void> {
    await this.emitVoiceActivity(false);
  }

  async outputDelta(text: string): Promise<void> {
    await this.emitLiveEvent({
      type: "session.output_transcript.delta",
      delta: text,
    });
  }

  async playbackActive(): Promise<void> {
    await this.emitPlaybackActivity(true);
  }

  async playbackIdle(): Promise<void> {
    await this.emitPlaybackActivity(false);
  }

  async ack(clientEventId: string, type: LiveAckType): Promise<void> {
    await this.emitLiveEvent({
      type,
      client_event_id: clientEventId,
    });
  }

  async error(clientEventId: string, message: string): Promise<void> {
    await this.emitLiveEvent({
      type: "error",
      error: { message, client_event_id: clientEventId },
    });
  }

  async sessionClosed(reason: string, usageSeconds: number): Promise<void> {
    await this.emitLiveEvent({
      type: "session.closed",
      reason,
      usage: { seconds: usageSeconds },
    });
  }

  async startListeningConversation(): Promise<void> {
    await this.page.goto("/");
    await this.page.getByRole("button", { name: "Начать перевод" }).click();
    await completeLanguageSetup(this.page, text => this.inputDelta(text));
    await expect(this.page.getByRole("button", { name: "Завершить" })).toBeVisible();
    await expect(this.page.getByTestId("participant-status-A")).toHaveText("ГОВОРИТЕ");
    await this.page.waitForFunction(
      () =>
        window.__liveTranslatorTestAudio !== undefined &&
        window.__liveTranslatorTestLive?.channel !== undefined &&
        window.__liveTranslatorTestLive.channel !== null,
    );
  }

  async advance(ms: number): Promise<void> {
    await this.page.clock.fastForward(ms);
  }

  liveSessionCreateCount(): number {
    return this.liveSessionCreates;
  }

  async peerCreateCount(): Promise<number> {
    return this.page.evaluate(() => {
      const live = window.__liveTranslatorTestLive;
      if (live === undefined) {
        throw new Error("Live harness was not installed");
      }
      return live.peerCreateCount;
    });
  }

  async sentClientEvents(): Promise<LiveHarnessSentEvent[]> {
    return this.page.evaluate(() => {
      const live = window.__liveTranslatorTestLive;
      if (live === undefined) {
        throw new Error("Live harness was not installed");
      }
      return live.sent;
    });
  }

  async lastGateBCommand(): Promise<"mute" | "unmute" | undefined> {
    const sent = await this.sentClientEvents();
    for (let index = sent.length - 1; index >= 0; index -= 1) {
      const type = sent[index]?.type;
      if (type === "session.input_audio.mute") {
        return "mute";
      }
      if (type === "session.input_audio.unmute") {
        return "unmute";
      }
    }
    return undefined;
  }

  async lastSteeringContent(): Promise<string | undefined> {
    const sent = await this.sentClientEvents();
    for (let index = sent.length - 1; index >= 0; index -= 1) {
      const event = sent[index];
      if (
        event?.type === "session.instructions.append" &&
        typeof event.content === "string" &&
        event.content.includes("Fixed languages:")
      ) {
        return event.content;
      }
    }
    return undefined;
  }

  async isOutputMuted(): Promise<boolean> {
    return this.page.evaluate(() => {
      const audio = window.__liveTranslatorTestAudio;
      if (audio === undefined) {
        throw new Error("E2E audio hooks were not installed");
      }
      return audio.isOutputMuted();
    });
  }

  async waitForGateBUnmuted(): Promise<void> {
    await expect
      .poll(async () => this.lastGateBCommand(), { timeout: 15_000 })
      .toBe("unmute");
  }

  private async emitVoiceActivity(active: boolean): Promise<void> {
    await this.page.evaluate((isActive) => {
      const audio = window.__liveTranslatorTestAudio;
      if (audio === undefined) {
        throw new Error("E2E audio hooks were not installed");
      }
      audio.emitVoiceActivity(isActive, Date.now());
    }, active);
    await this.flush();
  }

  private async emitPlaybackActivity(active: boolean): Promise<void> {
    await this.page.evaluate((isActive) => {
      const audio = window.__liveTranslatorTestAudio;
      if (audio === undefined) {
        throw new Error("E2E audio hooks were not installed");
      }
      audio.emitPlaybackActivity(isActive, Date.now());
    }, active);
    await this.flush();
  }

  private async emitLiveEvent(payload: unknown): Promise<void> {
    await this.page.evaluate((event) => {
      const live = window.__liveTranslatorTestLive;
      if (live === undefined) {
        throw new Error("Live harness was not installed");
      }
      live.emit(event);
    }, payload);
    await this.flush();
  }

  private async flush(): Promise<void> {
    await this.page.evaluate(async () => {
      await Promise.resolve();
      await Promise.resolve();
    });
  }

  private async installBackendStub(): Promise<void> {
    await this.page.route("**/api/policy", route => route.fulfill({ status: 200, contentType: "application/json", body: JSON.stringify({ usageLedgerEnabled: false }) }));
    await this.page.route("**/api/live/session", async (route) => {
      this.liveSessionCreates += 1;
      await route.fulfill({
        status: 200,
        contentType: "application/json",
        body: JSON.stringify({
          session: { id: "sess_e2e" },
          transport: { type: "webrtc", sdp: "v=0 fake-answer" },
        }),
      });
    });
  }

  private async installInitScript(): Promise<void> {
    await this.page.addInitScript(() => {
      window.__LIVE_TRANSLATOR_E2E = true;
      const sent: LiveHarnessSentEvent[] = [];
      const liveState: NonNullable<Window["__liveTranslatorTestLive"]> = {
        channel: null,
        sent,
        peerCreateCount: 0,
        emit(payload: unknown): void {
          const channel = liveState.channel;
          if (channel === null) {
            throw new Error("Live data channel stub was not installed");
          }
          channel.dispatchEvent(
            new MessageEvent("message", {
              data: JSON.stringify(payload),
            }),
          );
        },
      };
      window.__liveTranslatorTestLive = liveState;

      class FakeTrack extends EventTarget {
        kind = "audio";
        enabled = true;
        readyState: MediaStreamTrackState = "live";
        id = "mic-track";
        stop(): void {
          this.readyState = "ended";
          this.dispatchEvent(new Event("ended"));
        }
        getSettings(): MediaTrackSettings {
          return { echoCancellation: true, noiseSuppression: false };
        }
      }

      class FakeMediaStream {
        id = "mic-stream";
        private readonly tracks = [new FakeTrack()];
        getAudioTracks(): FakeTrack[] {
          return this.tracks;
        }
        getTracks(): FakeTrack[] {
          return this.tracks;
        }
        clone(): FakeMediaStream {
          return new FakeMediaStream();
        }
      }

      class FakeAudioNode {
        connect(): FakeAudioNode {
          return this;
        }
        disconnect(): void {}
      }

      class FakeAnalyser extends FakeAudioNode {
        fftSize = 2048;
        getFloatTimeDomainData(output: Float32Array): void {
          output.fill(0);
        }
      }

      class FakeAudioContext extends EventTarget {
        state: AudioContextState = "running";
        resume(): Promise<void> {
          this.state = "running";
          return Promise.resolve();
        }
        close(): Promise<void> {
          this.state = "closed";
          return Promise.resolve();
        }
        createAnalyser(): FakeAnalyser {
          return new FakeAnalyser();
        }
        createMediaStreamSource(): FakeAudioNode {
          return new FakeAudioNode();
        }
      }

      const ACK_TYPES: Record<string, LiveAckType> = {
        "session.instructions.append": "session.instructions.appended",
        "session.thinking.append": "session.thinking.appended",
        "session.commentary.append": "session.commentary.appended",
        "session.input_audio.mute": "session.input_audio.muted",
        "session.input_audio.unmute": "session.input_audio.unmuted",
      };

      class FakeDataChannel extends EventTarget {
        readyState: RTCDataChannelState = "open";
        constructor(readonly label: string) {
          super();
        }
        send(data: string): void {
          const message = JSON.parse(data) as LiveHarnessSentEvent;
          sent.push(message);
          const ackType = ACK_TYPES[message.type];
          if (ackType === undefined || message.event_id === undefined) {
            return;
          }
          queueMicrotask(() => {
            this.dispatchEvent(
              new MessageEvent("message", {
                data: JSON.stringify({
                  type: ackType,
                  client_event_id: message.event_id,
                }),
              }),
            );
          });
        }
        close(): void {
          this.readyState = "closed";
          this.dispatchEvent(new Event("close"));
        }
      }

      class FakeRTCPeerConnection extends EventTarget {
        connectionState: RTCPeerConnectionState = "connected";
        iceGatheringState: RTCIceGatheringState = "new";
        localDescription: RTCSessionDescriptionInit | null = null;
        remoteDescription: RTCSessionDescriptionInit | null = null;
        channel: FakeDataChannel | null = null;
        constructor() {
          super();
          liveState.peerCreateCount += 1;
        }
        createDataChannel(label: string): FakeDataChannel {
          this.channel = new FakeDataChannel(label);
          liveState.channel = this.channel;
          return this.channel;
        }
        addTrack(): RTCRtpSender {
          return {} as RTCRtpSender;
        }
        createOffer(): Promise<RTCSessionDescriptionInit> {
          return Promise.resolve({ type: "offer", sdp: "v=0 fake-offer" });
        }
        setLocalDescription(description: RTCSessionDescriptionInit): Promise<void> {
          this.localDescription = description;
          this.iceGatheringState = "complete";
          this.dispatchEvent(new Event("icegatheringstatechange"));
          return Promise.resolve();
        }
        setRemoteDescription(description: RTCSessionDescriptionInit): Promise<void> {
          this.remoteDescription = description;
          queueMicrotask(() => {
            this.channel?.dispatchEvent(
              new MessageEvent("message", {
                data: JSON.stringify({
                  type: "session.started",
                  session: { id: "sess_e2e" },
                }),
              }),
            );
          });
          return Promise.resolve();
        }
        close(): void {
          this.connectionState = "closed";
          this.dispatchEvent(new Event("connectionstatechange"));
          this.channel?.close();
        }
      }

      Object.defineProperty(navigator, "mediaDevices", {
        configurable: true,
        value: {
          getUserMedia: async () => new FakeMediaStream(),
        },
      });
      Object.defineProperty(window, "AudioContext", {
        configurable: true,
        value: FakeAudioContext,
      });
      Object.defineProperty(window, "webkitAudioContext", {
        configurable: true,
        value: FakeAudioContext,
      });
      Object.defineProperty(window, "RTCPeerConnection", {
        configurable: true,
        value: FakeRTCPeerConnection,
      });

      const orientationListeners = new Set<EventListener>();
      const orientation = {
        type: "portrait-primary",
        angle: 0,
        lock: async () => {},
        unlock: () => {},
        addEventListener: (_type: string, listener: EventListener) => {
          orientationListeners.add(listener);
        },
        removeEventListener: (_type: string, listener: EventListener) => {
          orientationListeners.delete(listener);
        },
      };
      Object.defineProperty(screen, "orientation", {
        configurable: true,
        value: orientation,
      });

      const visibilityState: DocumentVisibilityState = "visible";
      Object.defineProperty(document, "visibilityState", {
        configurable: true,
        get: () => visibilityState,
      });
      Object.defineProperty(document, "hidden", {
        configurable: true,
        get: () => visibilityState === "hidden",
      });

      Object.defineProperty(navigator, "wakeLock", {
        configurable: true,
        value: {
          request: async () => ({
            released: false,
            type: "screen",
            release: async () => {},
            addEventListener: () => {},
            removeEventListener: () => {},
          }),
        },
      });

      HTMLMediaElement.prototype.play = async () => {};
    });
  }
}

export async function completeLanguageSetup(page: Page, input: (text: string) => Promise<void>): Promise<void> {
  await expect(page.getByRole("heading", { name: "Образец речи A · 1 из 2" })).toBeVisible();
  await input("I speak English and would like to find the nearest station.");
  await page.getByRole("button", { name: "Сохранить образец" }).click();
  await page.getByRole("button", { name: "Записать образец B" }).click();
  await expect(page.getByText("Слушаю участника B")).toBeVisible();
  await input("Hablo español y quisiera encontrar la estación de tren.");
  await page.getByRole("button", { name: "Сохранить образец" }).click();
  await page.getByRole("button", { name: "Начать разговор" }).click();
}
