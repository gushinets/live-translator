import { readFileSync } from "node:fs";
import { expect, test, type Page } from "@playwright/test";
import { emulatePortraitScreen } from "./portrait-screen";

const PARTICIPANT_A_AUDIO = readAudioFixture("participant-a.mp3.b64");
const PARTICIPANT_B_AUDIO = readAudioFixture("participant-b.mp3.b64");
const BOOTSTRAP_AUDIO = PARTICIPANT_B_AUDIO;

interface AudioElementState {
  exists: boolean;
  muted: boolean | null;
  paused: boolean | null;
  audioTracks: number;
  liveAudioTracks: number;
}

interface RealLiveEventDiagnostic {
  type: string;
  delta?: string;
  errorMessage?: string;
  atMs: number;
}

interface TurnSnapshot {
  statusA: string;
  statusB: string;
  primaryA: string;
  primaryB: string;
  secondaryA: string;
  secondaryB: string;
  recentA: number;
  recentB: number;
  remoteAudio: AudioElementState;
}

declare global {
  interface Window {
    __liveTranslatorRealMic?: {
      isReady(): boolean;
      playBase64Audio(base64: string): Promise<void>;
    };
    __liveTranslatorRealDiagnostics?: {
      events: RealLiveEventDiagnostic[];
      outboundAudioBytesSent(): Promise<number>;
    };
  }
}

function readAudioFixture(name: string): string {
  const encoded = readFileSync(new URL(`./fixtures/${name}`, import.meta.url), "utf8")
    .replace(/[\t\n\f\r ]+/g, "")
    .trim();

  const canonicalBase64 =
    /^(?:[A-Za-z0-9+/]{4})*(?:[A-Za-z0-9+/]{2}==|[A-Za-z0-9+/]{3}=)?$/;
  if (encoded.length === 0 || !canonicalBase64.test(encoded)) {
    throw new Error(`Audio fixture ${name} is not valid base64`);
  }

  return encoded;
}

async function installDeterministicMicrophone(page: Page): Promise<void> {
  await page.addInitScript(() => {
    let context: AudioContext | null = null;
    let destination: MediaStreamAudioDestinationNode | null = null;
    const liveEvents: RealLiveEventDiagnostic[] = [];

    const originalCreateDataChannel = RTCPeerConnection.prototype.createDataChannel;
    RTCPeerConnection.prototype.createDataChannel = function (
      label: string,
      dataChannelDict?: RTCDataChannelInit,
    ): RTCDataChannel {
      const channel = originalCreateDataChannel.call(this, label, dataChannelDict);
      const peer = this;
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
          const report = await peer.getStats();
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
      };
      return channel;
    };

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
      }
      return { context, destination };
    }

    Object.defineProperty(navigator.mediaDevices, "getUserMedia", {
      configurable: true,
      value: async (constraints: MediaStreamConstraints): Promise<MediaStream> => {
        if (constraints.audio === false || constraints.audio === undefined) {
          throw new Error("Real-Live test microphone only supports audio capture");
        }
        return (await ensureMicrophone()).destination.stream;
      },
    });

    window.__liveTranslatorRealMic = {
      isReady: () => destination !== null,
      playBase64Audio: async (base64: string): Promise<void> => {
        const microphone = await ensureMicrophone();
        const bytes = Uint8Array.from(atob(base64), (character) =>
          character.charCodeAt(0),
        );
        const decoded = await microphone.context.decodeAudioData(bytes.buffer.slice(0));
        const source = microphone.context.createBufferSource();
        source.buffer = decoded;
        source.connect(microphone.destination);
        await new Promise<void>((resolve) => {
          source.addEventListener("ended", () => resolve(), { once: true });
          source.start();
        });
        await new Promise<void>((resolve) => window.setTimeout(resolve, 350));
      },
    };
  });
}

async function playMicrophoneFixture(page: Page, base64: string): Promise<void> {
  await page.evaluate(async (fixture) => {
    const microphone = window.__liveTranslatorRealMic;
    if (microphone === undefined) {
      throw new Error("Deterministic microphone hook is unavailable");
    }
    await microphone.playBase64Audio(fixture);
  }, base64);
}

async function readAudioElementState(page: Page): Promise<AudioElementState> {
  return page.evaluate(() => {
    const element = document.querySelector("audio");
    if (!(element instanceof HTMLAudioElement)) {
      return {
        exists: false,
        muted: null,
        paused: null,
        audioTracks: 0,
        liveAudioTracks: 0,
      };
    }
    const stream = element.srcObject;
    const audioTracks = stream instanceof MediaStream ? stream.getAudioTracks() : [];
    return {
      exists: true,
      muted: element.muted,
      paused: element.paused,
      audioTracks: audioTracks.length,
      liveAudioTracks: audioTracks.filter((track) => track.readyState === "live").length,
    };
  });
}

async function hasLiveAudibleRemoteAudio(page: Page): Promise<boolean> {
  const audio = await readAudioElementState(page);
  return (
    audio.exists &&
    audio.audioTracks >= 1 &&
    audio.liveAudioTracks >= 1 &&
    audio.muted === false &&
    audio.paused === false
  );
}

async function hasNonEmptyText(page: Page, testId: string): Promise<boolean> {
  const locator = page.getByTestId(testId);
  if ((await locator.count()) === 0) {
    return false;
  }
  return locator.evaluate((element) => (element.textContent ?? "").trim().length > 0);
}

async function testIdText(page: Page, testId: string): Promise<string> {
  const locator = page.getByTestId(testId);
  if ((await locator.count()) === 0) {
    return "";
  }
  return locator.evaluate((element) => (element.textContent ?? "").trim());
}

async function readTurnSnapshot(page: Page): Promise<TurnSnapshot> {
  const [statusA, statusB, primaryA, primaryB, secondaryA, secondaryB, recentA, recentB] =
    await Promise.all([
      testIdText(page, "participant-status-A"),
      testIdText(page, "participant-status-B"),
      testIdText(page, "current-primary-A"),
      testIdText(page, "current-primary-B"),
      testIdText(page, "current-secondary-A"),
      testIdText(page, "current-secondary-B"),
      page.getByTestId("participant-pane-A").locator(".recent-turn").count(),
      page.getByTestId("participant-pane-B").locator(".recent-turn").count(),
    ]);
  return {
    statusA,
    statusB,
    primaryA,
    primaryB,
    secondaryA,
    secondaryB,
    recentA,
    recentB,
    remoteAudio: await readAudioElementState(page),
  };
}

async function liveEventCount(page: Page): Promise<number> {
  return page.evaluate(() => window.__liveTranslatorRealDiagnostics?.events.length ?? 0);
}

async function liveEventsSince(page: Page, startIndex: number): Promise<RealLiveEventDiagnostic[]> {
  return page.evaluate(
    (index) => window.__liveTranslatorRealDiagnostics?.events.slice(index) ?? [],
    startIndex,
  );
}

async function outboundAudioBytesSent(page: Page): Promise<number> {
  return page.evaluate(async () => {
    return (await window.__liveTranslatorRealDiagnostics?.outboundAudioBytesSent()) ?? 0;
  });
}

function safeStage(stage: string): void {
  console.log(`[real-live] stage=${stage}`);
}

test.describe("real GPT-Live desktop conversation", () => {
  test("completes one translated A turn and one translated B turn with remote audio", async ({
    page,
  }) => {
    await emulatePortraitScreen(page);
    await installDeterministicMicrophone(page);

    const liveSessionStatuses: number[] = [];
    page.on("response", (response) => {
      const url = new URL(response.url());
      if (
        url.pathname === "/api/live/session" &&
        response.request().method() === "POST"
      ) {
        liveSessionStatuses.push(response.status());
      }
    });

    await page.goto("/");
    safeStage("setup_loaded");

    await page.getByRole("button", { name: "Start translation" }).click();
    await expect(page.getByRole("button", { name: "Skip" })).toBeVisible();
    expect(liveSessionStatuses).toEqual([201]);
    await expect
      .poll(() => page.evaluate(() => window.__liveTranslatorRealMic?.isReady() === true))
      .toBe(true);
    safeStage("bootstrap_connected");

    await playMicrophoneFixture(page, BOOTSTRAP_AUDIO);
    await expect(page.getByRole("button", { name: "Accept" })).toBeVisible();
    await expect
      .poll(() =>
        page
          .locator(".bootstrap-hint-value")
          .evaluate((element) => (element.textContent ?? "").trim().length > 0),
      )
      .toBe(true);
    safeStage("bootstrap_hint_received");

    await page.getByRole("button", { name: "Accept" }).click();
    await expect(page.getByRole("button", { name: "End conversation" })).toBeVisible();
    await expect(page.getByTestId("participant-status-A")).toHaveText("YOUR TURN");
    await expect(page.getByTestId("participant-status-B")).toHaveText("WAITING");
    expect(liveSessionStatuses).toEqual([201]);
    safeStage("interpreter_ready");

    const firstTurnEventStart = await liveEventCount(page);
    const outboundBytesBeforeA = await outboundAudioBytesSent(page);
    const participantAPlayback = playMicrophoneFixture(page, PARTICIPANT_A_AUDIO);
    await expect(page.getByTestId("participant-status-A")).toHaveText("LISTENING");
    await participantAPlayback;
    await expect
      .poll(() => outboundAudioBytesSent(page), { timeout: 5_000 })
      .toBeGreaterThan(outboundBytesBeforeA);
    await page.waitForTimeout(3_000);
    const outboundBytesAfterA = await outboundAudioBytesSent(page);
    const firstTurnEvents = await liveEventsSince(page, firstTurnEventStart);
    const firstTurnSnapshot = await readTurnSnapshot(page);
    console.log(
      `[real-live-debug] a_boundary=${JSON.stringify({
        outboundBytesBeforeA,
        outboundBytesAfterA,
        events: firstTurnEvents,
        snapshot: firstTurnSnapshot,
      })}`,
    );

    await Promise.all([
      expect.poll(() => hasNonEmptyText(page, "current-primary-A")).toBe(true),
      expect.poll(() => hasNonEmptyText(page, "current-primary-B")).toBe(true),
      expect(page.getByTestId("participant-status-B")).toHaveText("SPEAKING"),
      expect.poll(() => hasLiveAudibleRemoteAudio(page)).toBe(true),
    ]);
    safeStage("a_to_b_text_and_audio");

    await expect(page.getByTestId("participant-status-B")).toHaveText("YOUR TURN");
    await expect(page.getByTestId("participant-status-A")).toHaveText("WAITING");
    safeStage("a_turn_closed");

    await Promise.all([
      playMicrophoneFixture(page, PARTICIPANT_B_AUDIO),
      expect(page.getByTestId("participant-status-B")).toHaveText("LISTENING"),
      expect.poll(() => hasNonEmptyText(page, "current-primary-B")).toBe(true),
      expect.poll(() => hasNonEmptyText(page, "current-primary-A")).toBe(true),
      expect(page.getByTestId("participant-status-A")).toHaveText("SPEAKING"),
      expect.poll(() => hasLiveAudibleRemoteAudio(page)).toBe(true),
    ]);
    safeStage("b_to_a_text_and_audio");

    await expect(page.getByTestId("participant-status-A")).toHaveText("YOUR TURN");
    await expect(page.getByTestId("participant-status-B")).toHaveText("WAITING");
    await expect
      .poll(() => page.getByTestId("participant-pane-A").locator(".recent-turn").count())
      .toBeGreaterThanOrEqual(2);
    await expect
      .poll(() => page.getByTestId("participant-pane-B").locator(".recent-turn").count())
      .toBeGreaterThanOrEqual(2);
    safeStage("b_turn_closed");

    await page.getByRole("button", { name: "End conversation" }).click();
    await expect(page.getByRole("button", { name: "Start translation" })).toBeVisible({
      timeout: 25_000,
    });
    expect(liveSessionStatuses).toEqual([201]);
    safeStage("session_closed");
  });
});