import { expect, test } from "@playwright/test";
import { runtime } from "../../src/config/runtime";
import { MockLiveHarness } from "./mockLiveHarness";

test("long captions stay readable, retain their size in pauses, and respect manual scrolling on both sides", async ({ page }, testInfo) => {
  const harness = await MockLiveHarness.attach(page);
  await harness.startListeningConversation();
  await harness.sourceActive();
  const original = "Could you tell me where the train station is? ".repeat(14);
  const translated = "¿Podría decirme dónde está la estación de tren? ".repeat(14);
  await harness.inputDelta(original);
  await harness.outputDelta(translated);
  for (const side of ["A", "B"] as const) {
    const message = page.getByTestId(`current-primary-${side}`);
    const scroll = page.getByTestId(`participant-scroll-${side}`);
    await expect(message).toHaveCSS("font-size", "28px");
    const pane = page.getByTestId(`participant-pane-${side}`);
    for (const label of [pane.locator(".participant-language"), pane.getByTestId(`participant-status-${side}`)]) {
      await expect(label).toHaveCSS("font-family", "system-ui, sans-serif");
      await expect(label).toHaveCSS("font-size", "18px");
    }
    expect(await message.evaluate(el => {
      const author = el.previousElementSibling!.getBoundingClientRect();
      const firstLetter = document.createRange();
      firstLetter.setStart(el.firstChild!, 0);
      firstLetter.setEnd(el.firstChild!, 1);
      const text = firstLetter.getBoundingClientRect();
      return Math.max(author.top, text.top) < Math.min(author.bottom, text.bottom);
    })).toBe(true);
    await expect(scroll).toHaveAttribute("tabindex", "0");
    expect(await scroll.evaluate(el => el.scrollHeight > el.clientHeight)).toBe(true);
    expect(await scroll.evaluate(el => el.scrollHeight - el.scrollTop - el.clientHeight)).toBeLessThan(2);
    const box = (await scroll.boundingBox())!;
    const gutter = await scroll.evaluate(el => (el as HTMLElement).offsetWidth - el.clientWidth);
    if (gutter > 0) {
      await page.mouse.click(side === "B" ? box.x + gutter / 2 : box.x + box.width - gutter / 2, box.y + box.height / 2);
      await expect(page.getByTestId("current-author-A")).toHaveText("Me:");
      await expect(page.getByTestId("current-author-B")).toHaveText("Él:");
    }
    await page.mouse.move(box.x + box.width / 2, box.y + box.height / 2);
    await page.mouse.down();
    await page.mouse.move(box.x + box.width / 2, box.y + box.height / 2 + 35, { steps: 5 });
    await page.mouse.up();
    await expect(page.getByTestId("current-author-A")).toHaveText("Me:");
    await expect(page.getByTestId("current-author-B")).toHaveText("Él:");
    await page.evaluate(() => getSelection()?.removeAllRanges());
    await scroll.evaluate(el => { el.scrollTop = 0; el.dispatchEvent(new Event("scroll")); });
  }
  await harness.inputDelta(" Please show me the way.");
  await harness.outputDelta(" Por favor, muéstreme el camino.");
  for (const side of ["A", "B"] as const) {
    const scroll = page.getByTestId(`participant-scroll-${side}`);
    expect(await scroll.evaluate(el => el.scrollTop)).toBe(0);
    await scroll.evaluate(el => { el.scrollTop = el.scrollHeight; el.dispatchEvent(new Event("scroll")); });
  }
  await harness.inputDelta(" Thank you very much.");
  await harness.outputDelta(" Muchas gracias.");
  await harness.sourceQuiet();
  await harness.advance(runtime.audioStartGraceMs + runtime.captionIdleMs);
  for (const side of ["A", "B"] as const) {
    await expect(page.getByTestId(`latest-primary-${side}`)).toHaveCSS("font-size", "28px");
    expect(await page.getByTestId(`latest-primary-${side}`).evaluate(el => {
      const author = el.previousElementSibling!.getBoundingClientRect();
      const firstLetter = document.createRange();
      firstLetter.setStart(el.firstChild!, 0);
      firstLetter.setEnd(el.firstChild!, 1);
      const text = firstLetter.getBoundingClientRect();
      return Math.max(author.top, text.top) < Math.min(author.bottom, text.bottom);
    })).toBe(true);
    const scroll = page.getByTestId(`participant-scroll-${side}`);
    expect(await scroll.evaluate(el => el.scrollHeight - el.scrollTop - el.clientHeight)).toBeLessThan(2);
    expect(await scroll.evaluate(el => el.scrollWidth <= el.clientWidth)).toBe(true);
  }
  await page.screenshot({ path: testInfo.outputPath("conversation-28px.png") });
  await page.setViewportSize({ width: 320, height: 640 });
  await expect(page.getByRole("button", { name: "End", exact: true })).toBeVisible();
  // Text-only enlargement exercises reflow without shrinking the CSS viewport.
  await page.addStyleTag({ content: "html { font-size: 200% !important; }" });
  for (const side of ["A", "B"] as const) {
    await expect(page.getByTestId(`latest-primary-${side}`)).toHaveCSS("font-size", "56px");
    const scroll = page.getByTestId(`participant-scroll-${side}`);
    expect(await scroll.evaluate(el => el.clientHeight)).toBeGreaterThan(0);
    expect(await scroll.evaluate(el => el.scrollWidth <= el.clientWidth)).toBe(true);
  }
  expect(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth)).toBe(true);
  const end = page.getByRole("button", { name: "End", exact: true });
  const changeLanguage = page.getByRole("button", { name: "Partner's language" });
  for (const button of [end, changeLanguage]) {
    const box = (await button.boundingBox())!;
    expect(box.width).toBeGreaterThanOrEqual(44);
    expect(box.height).toBeGreaterThanOrEqual(44);
    await expect(button).toBeInViewport();
  }
  await page.screenshot({ path: testInfo.outputPath("conversation-200-percent.png") });
});

test("keeps all history and the reading position when another turn arrives", async ({ page }) => {
  const harness = await MockLiveHarness.attach(page);
  await harness.startListeningConversation();
  const captions = ["First", "Second", "Third", "Fourth"].map(word => ({
    original: `${word}: ` + "Could you tell me where the train station is? ".repeat(10),
    translation: `${word}: ` + "¿Podría decirme dónde está la estación de tren? ".repeat(10),
  }));
  for (const caption of captions.slice(0, 3)) {
    await harness.sourceActive();
    await harness.inputDelta(caption.original);
    await harness.outputDelta(caption.translation);
    await harness.sourceQuiet();
    await harness.advance(runtime.audioStartGraceMs);
    await expect(page.getByTestId("participant-status-A")).toHaveText("Speak");
    await harness.waitForGateBUnmuted();
    await harness.advance(runtime.captionIdleMs);
  }
  const before: number[] = [];
  for (const side of ["A", "B"] as const) {
    const scroll = page.getByTestId(`participant-scroll-${side}`);
    await scroll.evaluate(el => {
      const retained = el.querySelectorAll<HTMLElement>(".recent-turn")[1]!;
      el.scrollTop = retained.offsetTop - (el as HTMLElement).offsetTop + 40;
      el.dispatchEvent(new Event("scroll"));
    });
    before.push((await scroll.locator(".recent-turn").nth(1).boundingBox())!.y);
  }
  await harness.sourceActive();
  await harness.inputDelta(captions[3]!.original);
  await harness.outputDelta(captions[3]!.translation);
  await harness.sourceQuiet();
  await harness.advance(runtime.audioStartGraceMs + runtime.captionIdleMs);
  for (const [index, side] of (["A", "B"] as const).entries()) {
    const history = page.getByTestId(`participant-scroll-${side}`).locator(".recent-turn");
    await expect(history).toHaveCount(4);
    await expect(history.first()).toContainText("First:");
    const retained = history.nth(1);
    await expect(retained).toContainText("Second:");
    await expect.poll(async () => Math.abs((await retained.boundingBox())!.y - before[index]!)).toBeLessThan(2);
  }
});

test("a long dialogue keeps both languages, including short and translation-only turns", async ({ page }, testInfo) => {
  const harness = await MockLiveHarness.attach(page);
  await harness.startListeningConversation();
  for (let i = 0; i < 12; i++) {
    await harness.sourceActive();
    const spanishSource = i % 2 === 1;
    if (i !== 10) await harness.inputDelta(i === 11 ? "OK" : spanishSource
      ? `¿Podría decirme dónde está la estación de tren? ${i}`
      : `Could you tell me where the train station is? ${i}`);
    await harness.outputDelta(spanishSource ? `Thank you very much. ${i}` : `¿Podría decirme dónde está la estación de tren? ${i}`);
    await harness.sourceQuiet();
    await harness.advance(runtime.audioStartGraceMs + runtime.captionIdleMs);
    await harness.waitForGateBUnmuted();
    // Let the prior output's drain window settle before delivering the next provider response.
    await harness.advance(runtime.captionIdleMs);
    for (const side of ["A", "B"] as const) {
      await expect(page.getByTestId(`participant-scroll-${side}`).locator("li")).toHaveCount(i + 1);
    }
  }
  const a = page.getByTestId("participant-scroll-A");
  const b = page.getByTestId("participant-scroll-B");
  await expect(a.locator("li").first()).toContainText("Could you tell me");
  await expect(b.locator("li").first()).toContainText("¿Podría decirme");
  await expect(a.locator("li").last()).toContainText("Thank you very much. 11");
  await expect(b.locator("li").last()).toContainText("OK");
  await expect(b.locator("li").nth(10)).toContainText("¿Podría decirme");
  for (const scroll of [a, b]) {
    expect(await scroll.evaluate(el => el.scrollHeight > el.clientHeight)).toBe(true);
    await scroll.evaluate(el => { el.scrollTop = 0; el.dispatchEvent(new Event("scroll")); });
    await expect(scroll.locator("li").first()).toBeInViewport();
  }
  await page.screenshot({ path: testInfo.outputPath("conversation-full-history.png") });
});
