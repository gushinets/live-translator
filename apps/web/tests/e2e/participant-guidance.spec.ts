import { expect, test } from "@playwright/test";
import { runtime } from "../../src/config/runtime";
import { MockLiveHarness } from "./mockLiveHarness";

test("localized guidance follows the capture gate through playback and its echo tail", async ({ page }, testInfo) => {
  const harness = await MockLiveHarness.attach(page);
  await page.addInitScript(() => {
    localStorage.setItem("live-translator-owner-language", "ru");
    localStorage.setItem("live-translator-interlocutor-language", "en");
  });
  await page.goto("/");
  await page.getByRole("button", { name: "Начать перевод" }).click();
  await expect(page.getByTestId("participant-guidance-A")).toContainText("Можно говорить");
  await expect(page.getByTestId("participant-guidance-B")).toContainText("You can speak");
  await harness.sourceActive();
  await harness.inputDelta("Подскажите, где находится вокзал?");
  await expect(page.getByTestId("participant-guidance-A")).toContainText("Слушаю");
  await expect(page.getByTestId("participant-guidance-B")).toContainText("Wait for the translation");
  await harness.sourceQuiet();
  await harness.advance(runtime.sourceTailGraceMs);
  await harness.outputDelta("Where is the train station?");
  await harness.bufferedPlayback(true);
  await harness.playbackActive();
  await expect(page.getByTestId("participant-guidance-A")).toContainText("Сейчас ваша речь не записывается");
  await expect(page.getByTestId("participant-guidance-B")).toContainText("Your speech is not being recorded");
  for (const width of [390, 320]) {
    await page.setViewportSize({ width, height: width === 320 ? 640 : 844 });
    const center = (await page.locator(".conversation-center").boundingBox())!;
    for (const side of ["A", "B"] as const) {
      const pane = page.getByTestId(`participant-pane-${side}`);
      await expect(pane.locator(".participant-header, .participant-language")).toHaveCount(0);
      const cue = (await pane.getByTestId(`participant-guidance-${side}`).boundingBox())!;
      expect(cue.height).toBeLessThanOrEqual(100);
      expect(side === "A" ? cue.y - center.y - center.height : center.y - cue.y - cue.height).toBeLessThanOrEqual(7);
      await expect(pane.getByTestId(`participant-guidance-${side}`)).toBeInViewport({ ratio: 0.99 });
      await expect(pane.locator("li").last()).toBeInViewport({ ratio: 0.99 });
      expect(await pane.getByTestId(`participant-scroll-${side}`).evaluate(el => el.clientHeight)).toBeGreaterThan(0);
    }
    expect(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth)).toBe(true);
    await page.screenshot({ path: testInfo.outputPath(`playback-guidance-${width}.png`) });
  }
  const enlarged = await page.addStyleTag({ content: "html { font-size: 200% !important; }" });
  const headingVisible = (el: HTMLElement) => {
    const title = el.querySelector(".participant-guidance-title")!.getBoundingClientRect();
    const box = el.getBoundingClientRect();
    return el.closest(".participant-pane--rotated")
      ? title.bottom <= box.bottom && title.bottom > box.top
      : title.top >= box.top && title.top < box.bottom;
  };
  for (const side of ["A", "B"] as const) {
    expect(await page.getByTestId(`participant-scroll-${side}`).evaluate(el => {
      return el.clientHeight >= parseFloat(getComputedStyle(el.querySelector("li")!).lineHeight);
    })).toBe(true);
    const guidance = page.getByTestId(`participant-guidance-${side}`);
    await expect(guidance).toBeInViewport({ ratio: 0.99 });
    await page.getByRole("button", { name: "Завершить", exact: true }).focus();
    await page.keyboard.press(side === "A" ? "Tab" : "Shift+Tab");
    if (side === "B") await page.keyboard.press("Shift+Tab");
    await expect(guidance).toBeFocused();
    await expect(guidance).toHaveAccessibleName(side === "A" ? "Идёт озвучка" : "Translation playing");
    await expect(guidance).toHaveAccessibleDescription(side === "A"
      ? "Подождите. Сейчас ваша речь не записывается."
      : "Please wait. Your speech is not being recorded.");
    await expect(guidance).toHaveCSS("outline-style", "solid");
    await expect(guidance).toHaveCSS("outline-width", "2px");
    await page.keyboard.press("Home");
    await expect.poll(() => guidance.evaluate(el => el.scrollTop)).toBe(0);
    expect(await guidance.evaluate(el => {
      const title = el.querySelector(".participant-guidance-title")!.getBoundingClientRect();
      const box = el.getBoundingClientRect();
      return el.closest(".participant-pane--rotated") ? title.bottom <= box.bottom : title.top >= box.top;
    })).toBe(true);
    await page.keyboard.press("End");
    await expect.poll(() => guidance.evaluate(el => el.scrollTop)).toBeGreaterThan(0);
    await expect.poll(() => guidance.evaluate(el => el.scrollHeight - el.scrollTop - el.clientHeight)).toBeLessThan(2);
    expect(await guidance.evaluate(el => {
      const detail = el.querySelector(".participant-guidance-detail")!.getBoundingClientRect();
      const box = el.getBoundingClientRect();
      return el.closest(".participant-pane--rotated") ? detail.top >= box.top : detail.bottom <= box.bottom;
    })).toBe(true);
  }
  await expect(page.getByRole("button", { name: "Завершить", exact: true })).toBeInViewport();
  expect(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth)).toBe(true);
  await page.screenshot({ path: testInfo.outputPath("playback-guidance-200-percent.png") });
  await expect(page.getByTestId("participant-pane-B")).toHaveCSS("transform", "matrix(-1, 0, 0, -1, 0, 0)");
  await harness.bufferedPlayback(false);
  await harness.playbackIdle();
  await expect(page.getByTestId("participant-guidance-A")).toContainText("Ещё мгновение");
  await expect(page.getByTestId("participant-guidance-B")).toContainText("One moment");
  for (const side of ["A", "B"] as const) {
    const guidance = page.getByTestId(`participant-guidance-${side}`);
    expect(await guidance.evaluate(headingVisible)).toBe(true);
    await guidance.evaluate(el => { el.scrollTop = el.scrollHeight; });
  }
  await harness.advance(runtime.playbackEchoTailMs - 1);
  await expect(page.getByTestId("participant-status-A")).toHaveText("Ещё мгновение");
  await expect(page.getByTestId("participant-status-B")).toHaveText("One moment");
  await harness.advance(1);
  await expect(page.getByTestId("participant-guidance-A")).toContainText("Можно говорить");
  await expect(page.getByTestId("participant-guidance-B")).toContainText("You can speak");
  for (const side of ["A", "B"] as const) {
    expect(await page.getByTestId(`participant-guidance-${side}`).evaluate(headingVisible)).toBe(true);
  }
  await enlarged.evaluate(el => el.remove());
  await page.getByRole("button", { name: "Завершить", exact: true }).click();
  await expect(page.getByTestId("participant-guidance-A")).toHaveCount(0);
  await expect(page.getByTestId("participant-guidance-B")).toHaveCount(0);
  await expect(page.getByText("Подскажите, где находится вокзал?", { exact: true })).toBeVisible();
});
