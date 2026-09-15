import { readFileSync } from "node:fs";
import { expect, test, type Page } from "@playwright/test";

const BOOTSTRAP_AUDIO = readAudioFixture("bootstrap.mp3.b64");
const PARTICIPANT_A_AUDIO = readAudioFixture("participant-a.mp3.b64");
const PARTICIPANT_B_AUDIO = readAudioFixture("participant-b.mp3.b64");

interface AudioElementState {
  exists: boolean;
  muted: boolean | null;
  paused: boolean | null;
  audioTracks: number;
  liveAudioTracks: number;
}

declare global {
  interface Window {
    __liveTranslatorRealMic?: {
      isReady(): boolean;
      startBase64Audio(base64: string): Promise<void>;
    };
  }
}

function readAudioFixture(name: string): string {
  return readFileSync(new URL(`./fixtures/${name}`, import.meta.url), "utf8").trim();
}

async function installDeterministicMicrophone(page: Page): Promise<void> {
  await page.addInitScript(() => {
    let context: AudioContext | null = null;
    let destination: MediaStreamAudioDestinationNode | null = null;

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
      startBase64Audio: async (base64: string): Promise<void> => {
        const microphone = await ensureMicrophone();
        const bytes = Uint8Array.from(atob(base64), (character) =>
          character.charCodeAt(0),
        );
        const decoded = await microphone.context.decodeAudioData(bytes.buffer.slice(0));
        const source = microphone.context.createBufferSource();
        source.buffer = decoded;
        source.connect(microphone.destination);
        source.start();
      },
    };
  });
}

async function startMicrophoneFixture(page: Page, base64: string): Promise<void> {
  await page.evaluate(async (fixture) => {
    const microphone = window.__liveTranslatorRealMic;
    if (microphone === undefined) {
      throw new Error("Deterministic microphone hook is unavailable");
    }
    await microphone.startBase64Audio(fixture);
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

async function hasNonEmptyText(page: Page, testId: string): Promise<boolean> {
  const locator = page.getByTestId(testId);
  if ((await locator.count()) === 0) {
    return false;
  }
  return locator.evaluate((element) => (element.textContent ?? "").trim().length > 0);
}

function safeStage(stage: string): void {
  console.log(`[real-live] stage=${stage}`);
}

test.describe("real GPT-Live desktop conversation", () => {
  test("completes one translated A turn and one translated B turn with remote audio", async ({
    page,
  }) => {
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

    await startMicrophoneFixture(page, BOOTSTRAP_AUDIO);
    await expect(page.getByRole("button", { name: "Accept" })).toBeVisible();
    await expect
      .poll(() => page.locator(".bootstrap-hint-value").evaluate((element) =>
        (element.textContent ?? "").trim().length > 0,
      ))
      .toBe(true);
    safeStage("bootstrap_hint_received");

    await page.getByRole("button", { name: "Accept" }).click();
    await expect(page.getByRole("button", { name: "End conversation" })).toBeVisible();
    await expect(page.getByTestId("participant-status-A")).toHaveText("YOUR TURN");
    await expect(page.getByTestId("participant-status-B")).toHaveText("WAITING");
    expect(liveSessionStatuses).toEqual([201]);
    safeStage("interpreter_ready");

    await startMicrophoneFixture(page, PARTICIPANT_A_AUDIO);
    await expect(page.getByTestId("participant-status-A")).toHaveText("LISTENING");
    await expect.poll(() => hasNonEmptyText(page, "current-primary-A")).toBe(true);
    await expect.poll(() => hasNonEmptyText(page, "current-primary-B")).toBe(true);
    await expect(page.getByTestId("participant-status-B")).toHaveText("SPEAKING");

    const audioDuringBOutput = await readAudioElementState(page);
    expect(audioDuringBOutput.exists).toBe(true);
    expect(audioDuringBOutput.audioTracks).toBeGreaterThanOrEqual(1);
    expect(audioDuringBOutput.liveAudioTracks).toBeGreaterThanOrEqual(1);
    expect(audioDuringBOutput.muted).toBe(false);
    expect(audioDuringBOutput.paused).toBe(false);
    safeStage("a_to_b_text_and_audio");

    await expect(page.getByTestId("participant-status-B")).toHaveText("YOUR TURN");
    await expect(page.getByTestId("participant-status-A")).toHaveText("WAITING");
    safeStage("a_turn_closed");

    await startMicrophoneFixture(page, PARTICIPANT_B_AUDIO);
    await expect(page.getByTestId("participant-status-B")).toHaveText("LISTENING");
    await expect.poll(() => hasNonEmptyText(page, "current-primary-B")).toBe(true);
    await expect.poll(() => hasNonEmptyText(page, "current-primary-A")).toBe(true);
    await expect(page.getByTestId("participant-status-A")).toHaveText("SPEAKING");

    const audioDuringAOutput = await readAudioElementState(page);
    expect(audioDuringAOutput.exists).toBe(true);
    expect(audioDuringAOutput.audioTracks).toBeGreaterThanOrEqual(1);
    expect(audioDuringAOutput.liveAudioTracks).toBeGreaterThanOrEqual(1);
    expect(audioDuringAOutput.muted).toBe(false);
    expect(audioDuringAOutput.paused).toBe(false);
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
