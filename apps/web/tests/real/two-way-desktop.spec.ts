import { readFileSync } from "node:fs";
import { expect, test, type Page } from "@playwright/test";
import { emulatePortraitScreen } from "./portrait-screen";

const PARTICIPANT_A_AUDIO = readAudioFixture("participant-a.mp3.b64"); // Russian
const PARTICIPANT_B_AUDIO = readAudioFixture("participant-b.mp3.b64"); // English
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

interface RecentTurnText {
  primary: string;
  secondary: string;
}

interface RemoteRmsSummary {
  samples: number;
  min: number | null;
  max: number | null;
  average: number | null;
  aboveActiveFloor: number;
  tail: number[];
}

type Script = "cyrillic" | "latin";

declare global {
  interface Window {
    __liveTranslatorRealMic?: {
      isReady(): boolean;
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
    let playbackComplete: Promise<void> | null = null;
    const liveEvents: RealLiveEventDiagnostic[] = [];

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
        return (await ensureMicrophone()).destination.stream;
      },
    });

    window.__liveTranslatorRealMic = {
      isReady: () => destination !== null,
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

async function startMicrophoneFixture(page: Page, base64: string): Promise<void> {
  await page.evaluate(async (fixture) => {
    const microphone = window.__liveTranslatorRealMic;
    if (microphone === undefined) {
      throw new Error("Deterministic microphone hook is unavailable");
    }
    await microphone.startBase64Audio(fixture);
  }, base64);
}

async function waitForMicrophoneFixture(page: Page): Promise<void> {
  await page.evaluate(async () => {
    const microphone = window.__liveTranslatorRealMic;
    if (microphone === undefined) {
      throw new Error("Deterministic microphone hook is unavailable");
    }
    await microphone.waitForPlaybackComplete();
  });
}

async function playMicrophoneFixture(page: Page, base64: string): Promise<void> {
  await startMicrophoneFixture(page, base64);
  await waitForMicrophoneFixture(page);
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

async function readLatestRecentTurn(page: Page, side: "A" | "B"): Promise<RecentTurnText> {
  const latest = page.getByTestId(`participant-pane-${side}`).locator(".recent-turn").last();
  if ((await latest.count()) === 0) {
    return { primary: "", secondary: "" };
  }
  const primary = (await latest.locator(".recent-turn-primary").textContent()) ?? "";
  const secondaryLocator = latest.locator(".recent-turn-secondary");
  const secondary =
    (await secondaryLocator.count()) === 0 ? "" : ((await secondaryLocator.textContent()) ?? "");
  return { primary: primary.trim(), secondary: secondary.trim() };
}

function expectDominantScript(text: string, expected: Script): void {
  const cyrillic = (text.match(/[А-ЯЁ]/gi) ?? []).length;
  const latin = (text.match(/[A-Z]/gi) ?? []).length;
  expect(expected === "cyrillic" ? cyrillic : latin).toBeGreaterThan(
    expected === "cyrillic" ? latin : cyrillic,
  );
}

async function expectUsableLatestRecentTurn(
  page: Page,
  sourceSide: "A" | "B",
  expectedTargetScript: Script,
): Promise<void> {
  const [turnA, turnB] = await Promise.all([
    readLatestRecentTurn(page, "A"),
    readLatestRecentTurn(page, "B"),
  ]);
  const source = sourceSide === "A" ? turnA : turnB;
  const target = sourceSide === "A" ? turnB : turnA;

  // Output transcription belongs to the Live model response and is required
  // for a usable translated turn. Input transcription is a separate
  // asynchronous ASR path and may be absent even when the model understood
  // the audio and produced valid translated text/audio.
  expect(source.secondary).not.toBe("");
  expect(target.primary).not.toBe("");
  expect(source.secondary).toBe(target.primary);
  expectDominantScript(target.primary, expectedTargetScript);

  // When an input transcript is available, it must still mirror correctly on
  // the opposite pane. If ASR produced no source text, both source copies may
  // legitimately be empty while the translated turn remains usable.
  if (source.primary.length > 0 || target.secondary.length > 0) {
    expect(source.primary).not.toBe("");
    expect(target.secondary).not.toBe("");
    expect(source.primary).toBe(target.secondary);
  }
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

async function hasTranscriptDeltaSince(
  page: Page,
  startIndex: number,
  type: "session.input_transcript.delta" | "session.output_transcript.delta",
): Promise<boolean> {
  const events = await liveEventsSince(page, startIndex);
  return events.some((event) => event.type === type && (event.delta ?? "").trim().length > 0);
}

async function outboundAudioBytesSent(page: Page): Promise<number> {
  return page.evaluate(async () => {
    return (await window.__liveTranslatorRealDiagnostics?.outboundAudioBytesSent()) ?? 0;
  });
}

async function inboundAudioBytesReceived(page: Page): Promise<number> {
  return page.evaluate(async () => {
    return (await window.__liveTranslatorRealDiagnostics?.inboundAudioBytesReceived()) ?? 0;
  });
}

async function remoteAudioRmsSummary(page: Page, durationMs: number): Promise<RemoteRmsSummary> {
  const values = await page.evaluate(async (duration) => {
    return (await window.__liveTranslatorRealDiagnostics?.remoteAudioRmsSamples(duration)) ?? [];
  }, durationMs);
  const min = values.length === 0 ? null : Math.min(...values);
  const max = values.length === 0 ? null : Math.max(...values);
  const average =
    values.length === 0 ? null : values.reduce((sum, value) => sum + value, 0) / values.length;
  return {
    samples: values.length,
    min,
    max,
    average,
    aboveActiveFloor: values.filter((value) => value >= 0.015).length,
    tail: values.slice(-10),
  };
}

function safeStage(stage: string): void {
  console.log(`[real-live] stage=${stage}`);
}

test.describe("real GPT-Live desktop conversation", () => {
  test("translates Russian A to English B and English B to Russian A with remote audio", async ({
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

    await page.getByRole("button", { name: "Начать перевод" }).click();
    await expect(page.getByRole("button", { name: "Пропустить" })).toBeVisible();
    expect(liveSessionStatuses).toEqual([201]);
    await expect
      .poll(() => page.evaluate(() => window.__liveTranslatorRealMic?.isReady() === true))
      .toBe(true);
    safeStage("bootstrap_connected");

    await playMicrophoneFixture(page, BOOTSTRAP_AUDIO);
    await expect(page.getByRole("button", { name: "Продолжить" })).toBeVisible();
    await expect
      .poll(() =>
        page
          .locator(".bootstrap-hint-value")
          .evaluate((element) => (element.textContent ?? "").trim().length > 0),
      )
      .toBe(true);
    safeStage("bootstrap_hint_received");

    await page.getByRole("button", { name: "Продолжить" }).click();
    await expect(page.getByRole("button", { name: "Завершить" })).toBeVisible();
    await expect(page.getByTestId("participant-status-A")).toHaveText("ГОВОРИТЕ");
    await expect(page.getByTestId("participant-status-B")).toHaveText("ОЖИДАНИЕ");
    expect(liveSessionStatuses).toEqual([201]);
    safeStage("interpreter_ready");

    const firstTurnEventStart = await liveEventCount(page);
    const outboundBytesBeforeA = await outboundAudioBytesSent(page);
    const inboundBytesBeforeA = await inboundAudioBytesReceived(page);
    await startMicrophoneFixture(page, PARTICIPANT_A_AUDIO);
    await expect(page.getByTestId("participant-status-A")).toHaveText("СЛУШАЮ");
    await waitForMicrophoneFixture(page);
    await expect
      .poll(() => outboundAudioBytesSent(page), { timeout: 5_000 })
      .toBeGreaterThan(outboundBytesBeforeA);
    try {
      await expect
        .poll(
          () => hasTranscriptDeltaSince(page, firstTurnEventStart, "session.output_transcript.delta"),
          { timeout: 10_000 },
        )
        .toBe(true);
    } catch (error) {
      const repeat = page.getByText("Повторите", { exact: true });
      if (!(await repeat.isVisible())) {
        throw error;
      }
      await expect(page.getByTestId("participant-status-A")).toHaveText("ГОВОРИТЕ");
      await expect(page.getByTestId("participant-status-B")).toHaveText("ОЖИДАНИЕ");
      safeStage("a_no_output_repeat");
      await startMicrophoneFixture(page, PARTICIPANT_A_AUDIO);
      await expect(page.getByTestId("participant-status-A")).toHaveText("СЛУШАЮ");
      await waitForMicrophoneFixture(page);
      await expect
        .poll(() => outboundAudioBytesSent(page), { timeout: 5_000 })
        .toBeGreaterThan(outboundBytesBeforeA);
      await expect
        .poll(
          () => hasTranscriptDeltaSince(page, firstTurnEventStart, "session.output_transcript.delta"),
          { timeout: 10_000 },
        )
        .toBe(true);
    }
    await expect
      .poll(() => inboundAudioBytesReceived(page))
      .toBeGreaterThan(inboundBytesBeforeA);
    await expect.poll(() => hasLiveAudibleRemoteAudio(page)).toBe(true);
    safeStage("a_to_b_text_and_audio");

    try {
      await expect(page.getByTestId("participant-status-B")).toHaveText("ГОВОРИТЕ");
    } catch (error) {
      const inboundBytesBeforeRmsSample = await inboundAudioBytesReceived(page);
      const rms = await remoteAudioRmsSummary(page, 2_000);
      const inboundBytesAfterRmsSample = await inboundAudioBytesReceived(page);
      const events = await liveEventsSince(page, firstTurnEventStart);
      const snapshot = await readTurnSnapshot(page);
      console.log(
        `[real-live-debug] a_stuck_output=${JSON.stringify({
          inboundBytesBeforeRmsSample,
          inboundBytesAfterRmsSample,
          rms,
          events,
          snapshot,
        })}`,
      );
      throw error;
    }
    await expect(page.getByTestId("participant-status-A")).toHaveText("ОЖИДАНИЕ");
    await expect
      .poll(() => page.getByTestId("participant-pane-A").locator(".recent-turn").count())
      .toBeGreaterThanOrEqual(1);
    await expect
      .poll(() => page.getByTestId("participant-pane-B").locator(".recent-turn").count())
      .toBeGreaterThanOrEqual(1);
    await expectUsableLatestRecentTurn(page, "A", "latin");
    safeStage("a_turn_closed");

    const outboundBytesAfterA = await outboundAudioBytesSent(page);
    const inboundBytesAfterA = await inboundAudioBytesReceived(page);
    const firstTurnEvents = await liveEventsSince(page, firstTurnEventStart);
    const firstTurnSnapshot = await readTurnSnapshot(page);
    console.log(
      `[real-live-debug] a_boundary=${JSON.stringify({
        outboundBytesBeforeA,
        outboundBytesAfterA,
        inboundBytesBeforeA,
        inboundBytesAfterA,
        events: firstTurnEvents,
        snapshot: firstTurnSnapshot,
      })}`,
    );

    const secondTurnEventStart = await liveEventCount(page);
    const outboundBytesBeforeB = await outboundAudioBytesSent(page);
    const inboundBytesBeforeB = await inboundAudioBytesReceived(page);
    await startMicrophoneFixture(page, PARTICIPANT_B_AUDIO);
    await expect(page.getByTestId("participant-status-B")).toHaveText("СЛУШАЮ");
    await waitForMicrophoneFixture(page);
    await expect
      .poll(() => outboundAudioBytesSent(page), { timeout: 5_000 })
      .toBeGreaterThan(outboundBytesBeforeB);
    try {
      await expect
        .poll(
          () => hasTranscriptDeltaSince(page, secondTurnEventStart, "session.output_transcript.delta"),
          { timeout: 10_000 },
        )
        .toBe(true);
    } catch (error) {
      const repeat = page.getByText("Повторите", { exact: true });
      if (!(await repeat.isVisible())) {
        throw error;
      }
      await expect(page.getByTestId("participant-status-B")).toHaveText("ГОВОРИТЕ");
      await expect(page.getByTestId("participant-status-A")).toHaveText("ОЖИДАНИЕ");
      safeStage("b_no_output_repeat");
      await startMicrophoneFixture(page, PARTICIPANT_B_AUDIO);
      await expect(page.getByTestId("participant-status-B")).toHaveText("СЛУШАЮ");
      await waitForMicrophoneFixture(page);
      await expect
        .poll(() => outboundAudioBytesSent(page), { timeout: 5_000 })
        .toBeGreaterThan(outboundBytesBeforeB);
      await expect
        .poll(
          () => hasTranscriptDeltaSince(page, secondTurnEventStart, "session.output_transcript.delta"),
          { timeout: 10_000 },
        )
        .toBe(true);
    }
    await expect
      .poll(() => inboundAudioBytesReceived(page))
      .toBeGreaterThan(inboundBytesBeforeB);
    await expect.poll(() => hasLiveAudibleRemoteAudio(page)).toBe(true);
    safeStage("b_to_a_text_and_audio");

    await expect(page.getByTestId("participant-status-A")).toHaveText("ГОВОРИТЕ");
    await expect(page.getByTestId("participant-status-B")).toHaveText("ОЖИДАНИЕ");
    await expect
      .poll(() => page.getByTestId("participant-pane-A").locator(".recent-turn").count())
      .toBeGreaterThanOrEqual(2);
    await expect
      .poll(() => page.getByTestId("participant-pane-B").locator(".recent-turn").count())
      .toBeGreaterThanOrEqual(2);
    await expectUsableLatestRecentTurn(page, "B", "cyrillic");
    safeStage("b_turn_closed");

    const outboundBytesAfterB = await outboundAudioBytesSent(page);
    const inboundBytesAfterB = await inboundAudioBytesReceived(page);
    const secondTurnEvents = await liveEventsSince(page, secondTurnEventStart);
    const secondTurnSnapshot = await readTurnSnapshot(page);
    console.log(
      `[real-live-debug] b_boundary=${JSON.stringify({
        outboundBytesBeforeB,
        outboundBytesAfterB,
        inboundBytesBeforeB,
        inboundBytesAfterB,
        events: secondTurnEvents,
        snapshot: secondTurnSnapshot,
      })}`,
    );

    await page.getByRole("button", { name: "Завершить" }).click();
    await expect(page.getByRole("button", { name: "Начать перевод" })).toBeVisible({
      timeout: 25_000,
    });
    expect(liveSessionStatuses).toEqual([201]);
    safeStage("session_closed");
  });
});
