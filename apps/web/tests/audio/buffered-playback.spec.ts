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

test("real AudioWorklet closes WebRTC microphone before playback and plays the entire buffer despite new speech", async ({ page }) => {
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
  expect(await page.evaluate(() => window.audioHarness.controller.getCaptureStream()!.getAudioTracks()[0]!.enabled)).toBe(false);
  await expect.poll(() => page.evaluate(() => window.audioHarness.controller.playbackInputBlocked)).toBe(false);
  await expect.poll(() => page.evaluate(() => window.audioHarness.readReceivedMicRms())).toBeGreaterThan(.02);
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
