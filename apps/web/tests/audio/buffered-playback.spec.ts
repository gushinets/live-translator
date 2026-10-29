import { expect, test } from "@playwright/test";
import type {} from "./harness";

test.beforeEach(async ({ page }) => {
  page.on("pageerror", error => console.log("PAGE ERROR", error.message));
  await page.goto("/tests/audio/harness.html");
  test.skip(await page.evaluate(() => typeof AudioContext === "undefined"),
    "This browser build has no Web Audio API (Windows WebKit); run on a Web Audio capable host.");
  await page.locator("#start").click();
  await page.waitForFunction(() => !!window.audioHarness);
});

test("real AudioWorklet keeps an interrupted utterance out of WebRTC until a complete repeat", async ({ page }) => {
  await page.evaluate(() => window.audioHarness.useWebRtc());
  await page.evaluate(() => {
    window.audioHarness.mic.gain.value = .2;
  });
  await page.waitForTimeout(350);
  await expect.poll(() => page.evaluate(() => window.audioHarness.readReceivedMicRms())).toBeGreaterThan(.02);
  await page.evaluate(() => { window.audioHarness.remote.gain.value = .1; });
  await page.waitForTimeout(1500);
  expect(await page.evaluate(() => window.audioHarness.readRms())).toBeLessThan(.001);
  expect(await page.evaluate(() => window.audioHarness.controller.hasPendingPlayback)).toBe(true);
  await page.evaluate(() => {
    window.audioHarness.remote.gain.value = 0;
    window.audioHarness.mic.gain.value = 0;
  });
  await page.waitForTimeout(400);
  expect(await page.evaluate(() => window.audioHarness.readRms())).toBeLessThan(.001);
  await expect.poll(() => page.evaluate(() => window.audioHarness.readRms()), { intervals: [20] }).toBeGreaterThan(.02);
  expect(await page.evaluate(() => window.audioHarness.controller.getCaptureStream()!.getAudioTracks()[0]!.enabled)).toBe(false);
  await page.evaluate(() => { window.audioHarness.mic.gain.value = .2; });
  await page.waitForTimeout(250);
  expect(await page.evaluate(() => window.audioHarness.readRms())).toBeGreaterThan(.02);
  await expect.poll(() => page.evaluate(() => window.audioHarness.readReceivedMicRms()), { intervals: [20] }).toBeLessThan(.001);
  await expect.poll(() => page.evaluate(() => window.audioHarness.controller.hasPendingPlayback)).toBe(false);
  // Polling may observe pending=false after the shorter echo tail has already elapsed.
  await expect.poll(() => page.evaluate(() => window.audioHarness.inputTransitions.find(t => t.state === "tail")))
    .toMatchObject({ capture: false, analysis: true });
  await expect(page.getByTestId("participant-guidance-A")).toContainText("Микрофон ещё выключен");
  await expect(page.getByTestId("participant-guidance-B")).toContainText("El micrófono sigue apagado");
  // Simulate continued speech well beyond the former unconditional reopening timer.
  await page.waitForTimeout(800);
  expect(await page.evaluate(() => window.audioHarness.controller.playbackInputBlocked)).toBe(true);
  expect(await page.evaluate(() => window.audioHarness.readReceivedMicRms())).toBeLessThan(.001);
  await page.evaluate(() => { window.audioHarness.mic.gain.value = 0; });
  await expect.poll(() => page.evaluate(() => window.audioHarness.controller.playbackInputBlocked)).toBe(false);
  const transitions = await page.evaluate(() => window.audioHarness.inputTransitions);
  const tail = transitions.find(t => t.state === "tail")!;
  const reopened = transitions.find(t => t.state === "repeat")!;
  expect(reopened.atMs - tail.atMs).toBeGreaterThanOrEqual(299);
  await expect(page.getByTestId("participant-guidance-A")).toContainText("Микрофон включён. Повторите фразу целиком.");
  await expect(page.getByTestId("participant-guidance-B")).toContainText("Micrófono encendido. Repite la frase completa.");
  await page.evaluate(() => { window.audioHarness.mic.gain.value = .2; });
  await expect.poll(() => page.evaluate(() => window.audioHarness.readReceivedMicRms())).toBeGreaterThan(.02);
  expect(await page.evaluate(() => window.audioHarness.errors)).toBe(0);
});

test("speech starting exactly at the echo tail remains gated through its whole duration", async ({ page }) => {
  await page.evaluate(() => window.audioHarness.useWebRtc());
  await page.evaluate(() => {
    const h = window.audioHarness;
    const record = h.controller.onPlaybackInputBlocked!;
    let triggered = false;
    h.controller.onPlaybackInputBlocked = () => {
      record();
      if (!triggered && h.controller.playbackInputState === "tail") {
        triggered = true;
        h.mic.gain.value = .2;
        // Deliberately span the old 300 ms release deadline with uninterrupted speech.
        setTimeout(() => { h.mic.gain.value = 0; }, 1200);
      }
    };
    h.remote.gain.value = .1;
  });
  await expect.poll(() => page.evaluate(() => window.audioHarness.readRms()), { intervals: [20] }).toBeGreaterThan(.02);
  await page.evaluate(() => { window.audioHarness.remote.gain.value = 0; });
  await expect(page.getByTestId("participant-guidance-A")).toContainText("Микрофон ещё выключен");
  expect(await page.evaluate(() => window.audioHarness.readReceivedMicRms())).toBeLessThan(.001);
  await expect(page.getByTestId("participant-guidance-A")).toContainText("Микрофон включён. Повторите фразу целиком.");
  const transitions = await page.evaluate(() => window.audioHarness.inputTransitions);
  expect(transitions.map(t => t.state)).toEqual(["playing", "tail", "waiting", "repeat"]);
  expect(transitions.at(-1)!.atMs - transitions[1]!.atMs).toBeGreaterThanOrEqual(1600);
});

test("an 800ms pause inside a long source does not start queued playback or cut its continuation", async ({ page }) => {
  await page.evaluate(() => window.audioHarness.useWebRtc());
  await page.evaluate(() => { window.audioHarness.mic.gain.value = .2; });
  await expect.poll(() => page.evaluate(() => window.audioHarness.readReceivedMicRms())).toBeGreaterThan(.02);
  await page.evaluate(() => { window.audioHarness.remote.gain.value = .1; });
  await expect.poll(() => page.evaluate(() => window.audioHarness.controller.hasPendingPlayback)).toBe(true);
  await page.evaluate(async () => {
    const h = window.audioHarness;
    h.mic.gain.value = 0;
    await new Promise(resolve => setTimeout(resolve, 800));
    h.mic.gain.value = .2;
    await new Promise(resolve => setTimeout(resolve, 1200));
  });
  expect(await page.evaluate(() => window.audioHarness.inputTransitions)).toEqual([]);
  expect(await page.evaluate(() => window.audioHarness.controller.getCaptureStream()!.getAudioTracks()[0]!.enabled)).toBe(true);
  expect(await page.evaluate(() => window.audioHarness.readReceivedMicRms())).toBeGreaterThan(.02);
  expect(await page.evaluate(() => window.audioHarness.readRms())).toBeLessThan(.001);
  await page.evaluate(() => { window.audioHarness.mic.gain.value = 0; window.audioHarness.remote.gain.value = 0; });
  await expect.poll(() => page.evaluate(() => window.audioHarness.readRms()), { intervals: [20] }).toBeGreaterThan(.02);
  expect(await page.evaluate(() => window.audioHarness.controller.getCaptureStream()!.getAudioTracks()[0]!.enabled)).toBe(false);
  await expect.poll(() => page.evaluate(() => window.audioHarness.controller.playbackInputBlocked)).toBe(false);
  expect(await page.evaluate(() => window.audioHarness.errors)).toBe(0);
});

test("explicit direct playback streams during speech, lifecycle closure and replacement discard old PCM", async ({ page }) => {
  await page.evaluate(() => {
    window.audioHarness.controller.setNonInterrupting(false);
    window.audioHarness.mic.gain.value = .2;
  });
  await page.waitForTimeout(350);
  await page.evaluate(() => { window.audioHarness.remote.gain.value = .1; });
  await expect.poll(() => page.evaluate(() => window.audioHarness.readRms()), { intervals: [20] }).toBeGreaterThan(.02);
  await page.evaluate(() => { window.audioHarness.controller.setNonInterrupting(true); });
  await page.waitForTimeout(500);
  expect(await page.evaluate(() => window.audioHarness.readRms())).toBeLessThan(.001);
  await page.evaluate(() => {
    window.audioHarness.controller.setOutputAudible(false); window.audioHarness.remote.gain.value = 0;
  });
  await page.waitForTimeout(150);
  await page.evaluate(() => {
    const h = window.audioHarness;
    h.replaceRemote(); h.controller.setNonInterrupting(false); h.controller.setOutputAudible(true);
  });
  await page.waitForTimeout(500);
  expect(await page.evaluate(() => window.audioHarness.readRms())).toBeLessThan(.001);
  expect(await page.evaluate(() => window.audioHarness.controller.hasPendingPlayback)).toBe(false);
});

test("conversation has no playback switch and keeps its actions usable on a narrow phone", async ({ page }, testInfo) => {
  await expect(page.getByRole("switch")).toHaveCount(0);
  await expect(page.getByRole("button", { name: "Язык собеседника" })).toHaveCount(0);
  for (const width of [390, 320]) {
    await page.setViewportSize({ width, height: 844 });
    const end = (await page.getByRole("button", { name: "Завершить", exact: true }).boundingBox())!;
    expect(end.width).toBeGreaterThanOrEqual(44);
    expect(end.height).toBeGreaterThanOrEqual(44);
    await page.getByRole("button", { name: "Завершить", exact: true }).focus();
    await expect(page.getByRole("button", { name: "Завершить", exact: true })).toBeFocused();
    expect(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth)).toBe(true);
  }
  await page.screenshot({ path: testInfo.outputPath("buffered-playback-dialogue.png") });
});


test("real WebRTC receiver decodes through the worklet in both playback modes", async ({ page }) => {
  await page.evaluate(() => window.audioHarness.useWebRtc());
  await page.evaluate(() => window.audioHarness.controller.setNonInterrupting(false));
  // As in a real translation, source speech precedes the generated reply.
  await page.evaluate(() => { window.audioHarness.mic.gain.value = .2; });
  await page.waitForTimeout(350);
  await page.evaluate(() => { window.audioHarness.remote.gain.value = .1; });
  await expect.poll(() => page.evaluate(() => window.audioHarness.readRms()), { intervals: [50] }).toBeGreaterThan(.02);
  expect(await page.evaluate(() => window.audioHarness.receivedSamples())).toBeGreaterThan(0);
  await page.evaluate(() => {
    window.audioHarness.controller.setNonInterrupting(true);
    window.audioHarness.mic.gain.value = .2;
  });
  await page.waitForTimeout(1000);
  expect(await page.evaluate(() => window.audioHarness.readRms())).toBeLessThan(.001);
  expect(await page.evaluate(() => window.audioHarness.controller.hasPendingPlayback)).toBe(true);
  await page.evaluate(() => {
    window.audioHarness.remote.gain.value = 0;
    window.audioHarness.mic.gain.value = 0;
  });
  await expect.poll(() => page.evaluate(() => window.audioHarness.readRms()), { intervals: [20] }).toBeGreaterThan(.02);
  expect(await page.evaluate(() => window.audioHarness.errors)).toBe(0);
});

for (const delayMs of [100, 400]) {
  test(`real WebRTC continuation ${delayMs} ms after release recloses both input tracks`, async ({ page }) => {
    await page.evaluate(() => window.audioHarness.useWebRtc());
    await page.evaluate(delay => {
      const h = window.audioHarness;
      const record = h.controller.onPlaybackInputBlocked!;
      let scheduled = false;
      h.controller.onPlaybackInputBlocked = () => {
        record();
        if (!scheduled && h.controller.playbackInputState === "tail") {
          scheduled = true;
          // Deliberate provider chunk gap, not a wait used to make an assertion pass.
          setTimeout(() => {
            h.remote.gain.value = .1;
            setTimeout(() => { h.remote.gain.value = 0; }, 200);
          }, delay);
        }
      };
      h.remote.gain.value = .1;
    }, delayMs);
    await expect.poll(() => page.evaluate(() => window.audioHarness.readRms()), { intervals: [20] }).toBeGreaterThan(.02);
    await page.evaluate(() => { window.audioHarness.remote.gain.value = 0; });
    await expect.poll(() => page.evaluate(() => window.audioHarness.inputTransitions.filter(t => t.state === "playing").length),
      { intervals: [20] }).toBe(2);
    await expect.poll(() => page.evaluate(() => window.audioHarness.readRms()), { intervals: [20] }).toBeGreaterThan(.02);
    const transitions = await page.evaluate(() => window.audioHarness.inputTransitions);
    for (const playing of transitions.filter(t => t.state === "playing")) {
      expect(playing.capture).toBe(false);
      expect(playing.analysis).toBe(false);
    }
    const secondStart = transitions.findIndex((t, i) => t.state === "playing" && i > 0);
    expect(transitions.slice(0, secondStart).some(t => t.state === "idle")).toBe(delayMs > 300);
    await expect.poll(() => page.evaluate(() => window.audioHarness.controller.playbackInputBlocked)).toBe(false);
    expect(await page.evaluate(() => window.audioHarness.errors)).toBe(0);
  });
}
