import { completeLanguageSetup } from "./mockLiveHarness";
import { expect, test, type Page } from "@playwright/test";

declare global {
  interface Window {
    __setVisibility?: (state: DocumentVisibilityState) => void;
    __setOrientation?: (type: string) => void;
    __testLiveChannel?: EventTarget;
  }
}

async function installLiveStubs(page: Page): Promise<void> {
  await page.addInitScript(() => {
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

    class FakeDataChannel extends EventTarget {
      readyState: RTCDataChannelState = "open";
      constructor(readonly label: string) {
        super();
      }
      send(data: string): void {
        const message = JSON.parse(data) as { type: string; event_id?: string };
        if (message.type === "session.close") {
          queueMicrotask(() => this.dispatchEvent(new MessageEvent("message", {
            data: JSON.stringify({ type: "session.closed", reason: "user_requested" }),
          })));
          return;
        }
        const ackType = (
          {
            "session.instructions.append": "session.instructions.appended",
            "session.thinking.append": "session.thinking.appended",
            "session.commentary.append": "session.commentary.appended",
            "session.input_audio.mute": "session.input_audio.muted",
            "session.input_audio.unmute": "session.input_audio.unmuted",
          } as Record<string, string>
        )[message.type];
        if (ackType === undefined) {
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
      createDataChannel(label: string): FakeDataChannel {
        this.channel = new FakeDataChannel(label);
        window.__testLiveChannel = this.channel;
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
    window.__setOrientation = (type: string) => {
      orientation.type = type;
      for (const listener of orientationListeners) {
        listener(new Event("change"));
      }
    };

    let visibilityState: DocumentVisibilityState = "visible";
    Object.defineProperty(document, "visibilityState", {
      configurable: true,
      get: () => visibilityState,
    });
    Object.defineProperty(document, "hidden", {
      configurable: true,
      get: () => visibilityState === "hidden",
    });
    window.__setVisibility = (state: DocumentVisibilityState) => {
      visibilityState = state;
      document.dispatchEvent(new Event("visibilitychange"));
    };

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

  await page.route("**/api/policy", route => route.fulfill({ status: 200, contentType: "application/json", body: JSON.stringify({ usageLedgerEnabled: false }) }));
  await page.route("**/api/live/session/*", route => route.request().method() === "DELETE"
    ? route.fulfill({ status: 204 }) : route.continue());
    await page.route("**/api/live/session", async (route) => {
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

async function startListeningConversation(page: Page): Promise<void> {
  await page.goto("/");
  await page.getByRole("button", { name: "Начать перевод" }).click();
  await completeLanguageSetup(page, async delta => {
      await page.evaluate(text => {
        window.__testLiveChannel?.dispatchEvent(new MessageEvent("message", {
          data: JSON.stringify({ type: "session.input_transcript.delta", delta: text }),
        }));
      }, delta);
    });
  await expect(page.getByRole("button", { name: "Завершить" })).toBeVisible();
  await expect(page.getByTestId("participant-status-A")).toHaveText("ГОВОРИТЕ");
}

async function emitSourceTranscript(page: Page, delta: string): Promise<void> {
  await page.evaluate((text) => {
    const channel = window.__testLiveChannel;
    if (channel === undefined) {
      throw new Error("Live data channel stub was not installed");
    }
    channel.dispatchEvent(
      new MessageEvent("message", {
        data: JSON.stringify({
          type: "session.input_transcript.delta",
          delta: text,
        }),
      }),
    );
  }, delta);
}

test.describe("PWA suspension", () => {
  test("serves a portrait standalone manifest", async ({ page }) => {
    await page.goto("/");
    const href = await page.locator('link[rel="manifest"]').getAttribute("href");
    expect(href).toBe("/manifest.webmanifest");
    const manifest = await page.evaluate(async () => {
      const response = await fetch("/manifest.webmanifest");
      if (!response.ok) {
        throw new Error(`Manifest fetch failed: ${response.status}`);
      }
      return response.json() as Promise<{
        display: string;
        orientation: string;
        icons: Array<{ src: string; sizes: string; purpose?: string }>;
      }>;
    });
    expect(manifest.display).toBe("standalone");
    expect(manifest.orientation).toBe("portrait");
    expect(manifest.icons.some((icon) => icon.sizes === "192x192")).toBe(true);
    expect(manifest.icons.some((icon) => icon.sizes === "512x512")).toBe(true);
    expect(manifest.icons.some((icon) => icon.purpose === "maskable")).toBe(true);
  });

  test("backgrounding an active source turn discards it and asks the same speaker to repeat after resume", async ({
    page,
  }) => {
    await installLiveStubs(page);
    await startListeningConversation(page);
    await emitSourceTranscript(page, "Hello from A");
    await expect(page.getByTestId("current-primary-A")).toHaveText("Hello from A");

    await page.evaluate(() => {
      window.__setVisibility?.("hidden");
    });
    await expect(page.getByTestId("participant-status-A")).toHaveText("ПАУЗА");
    await expect(page.getByTestId("participant-status-B")).toHaveText("ПАУЗА");

    await page.evaluate(() => {
      window.__setVisibility?.("visible");
    });
    await expect(page.getByText("Повторите")).toBeVisible();
    await expect(page.getByTestId("participant-status-A")).toHaveText("ГОВОРИТЕ");
  });

  test("landscape suspends an active source turn until portrait is restored", async ({ page }) => {
    await installLiveStubs(page);
    await startListeningConversation(page);
    await emitSourceTranscript(page, "Where is apartment 12?");
    await expect(page.getByTestId("current-primary-A")).toHaveText("Where is apartment 12?");

    await page.evaluate(() => {
      window.__setOrientation?.("landscape-primary");
    });
    await expect(page.getByTestId("participant-status-A")).toHaveText("ПАУЗА");
    await expect(page.getByTestId("rotate-overlay")).toBeVisible();
    await expect(page.getByTestId("rotate-overlay")).toHaveText(/поверните/i);

    await page.evaluate(() => {
      window.__setOrientation?.("portrait-primary");
    });
    await expect(page.getByText("Повторите")).toBeVisible();
    await expect(page.getByTestId("participant-status-A")).toHaveText("ГОВОРИТЕ");
  });
});
