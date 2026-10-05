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

test("real AudioWorklet holds, releases and pauses received speech without discarding it", async ({ page }) => {
  await page.evaluate(() => {
    window.audioHarness.controller.setNonInterrupting(true);
    window.audioHarness.mic.gain.value = .2;
  });
  await page.waitForTimeout(350);
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
  await page.evaluate(() => { window.audioHarness.mic.gain.value = .2; });
  await page.waitForTimeout(250);
  expect(await page.evaluate(() => window.audioHarness.readRms())).toBeLessThan(.001);
  await page.evaluate(() => { window.audioHarness.controller.setNonInterrupting(false); });
  await expect.poll(() => page.evaluate(() => window.audioHarness.readRms()), { intervals: [20] }).toBeGreaterThan(.02);
  await expect.poll(() => page.evaluate(() => window.audioHarness.controller.hasPendingPlayback)).toBe(false);
  expect(await page.evaluate(() => window.audioHarness.errors)).toBe(0);
});

test("default streams during speech, lifecycle closure and replacement discard old PCM", async ({ page }) => {
  await page.evaluate(() => { window.audioHarness.mic.gain.value = .2; });
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

test("mode switch works by keyboard and stays beside End on a narrow phone", async ({ page }, testInfo) => {
  const toggle = page.getByRole("switch", { name: "Не перебивать" });
  await expect(toggle).toHaveAttribute("aria-checked", "false");
  await toggle.focus();
  await page.keyboard.press("Space");
  await expect(toggle).toHaveAttribute("aria-checked", "true");
  await page.keyboard.press("Enter");
  await expect(toggle).toHaveAttribute("aria-checked", "false");
  for (const width of [390, 320]) {
    await page.setViewportSize({ width, height: 844 });
    const end = (await page.getByRole("button", { name: "Завершить", exact: true }).boundingBox())!;
    const mode = (await toggle.boundingBox())!;
    expect(mode.x).toBeGreaterThan(end.x);
    expect(Math.abs(mode.y - end.y)).toBeLessThan(2);
    expect(mode.width).toBeGreaterThanOrEqual(44);
    expect(mode.height).toBeGreaterThanOrEqual(44);
    expect(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth)).toBe(true);
  }
  await toggle.click();
  await page.screenshot({ path: testInfo.outputPath("non-interrupting-switch.png") });
});


test("real WebRTC receiver decodes through the worklet in both playback modes", async ({ page }) => {
  await page.evaluate(() => window.audioHarness.useWebRtc());
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
