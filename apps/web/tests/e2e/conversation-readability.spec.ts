import { expect, test } from "@playwright/test";
import { runtime } from "../../src/config/runtime";
import { MockLiveHarness } from "./mockLiveHarness";

test("compact guidance keeps all exchanges readable in each participant scroller", async ({ page }, testInfo) => {
  const harness = await MockLiveHarness.attach(page);
  await page.addInitScript(() => {
    localStorage.setItem("live-translator-owner-language", "ru");
    localStorage.setItem("live-translator-interlocutor-language", "en");
  });
  await page.goto("/");
  await page.screenshot({ path: testInfo.outputPath("variant-four-start-ru.png") });
  await page.getByRole("button", { name: "Начать перевод" }).click();
  await expect(page.getByRole("button", { name: "Завершить" })).toBeVisible();
  const exchanges = [
    ["Подскажите, как пройти к вокзалу?", "How do I get to the station?"],
    ["Go straight, then turn left.", "Идите прямо, затем налево."],
    ["Это далеко отсюда?", "Is it far from here?"],
    ["No, just five minutes on foot.", "Нет, всего пять минут пешком."],
  ];
  for (const [source, translation] of exchanges) {
    await harness.sourceActive();
    await harness.inputDelta(source!);
    await harness.outputDelta(translation!);
    await harness.sourceQuiet();
    await harness.advance(runtime.audioStartGraceMs + runtime.captionIdleMs);
    await harness.waitForGateBUnmuted();
    await harness.advance(runtime.captionIdleMs);
  }
  // Wider fallback fonts must not wrap the conversation controls into a second row.
  await page.addStyleTag({ content: ".conversation-center { font-family: Verdana, sans-serif; }" });
  const viewports = [{ width: 390, height: 844 }, { width: 320, height: 640 }];
  const nativeViewport = page.viewportSize()!;
  if (nativeViewport.height !== 844) viewports.push(nativeViewport);
  for (const viewport of viewports) {
    await page.setViewportSize(viewport);
    await page.screenshot({ path: testInfo.outputPath(`variant-four-dialogue-${viewport.width}x${viewport.height}.png`) });
    for (const side of ["A", "B"] as const) {
      const pane = page.getByTestId(`participant-pane-${side}`);
      await expect(pane.locator(".participant-header")).toHaveCount(0);
      const rows = pane.locator("li");
      await expect(rows).toHaveCount(4);
      // Keep three complete rows with phone browser chrome, and all four in the full-height fixture.
      for (const row of (await rows.all()).slice(viewport.height === 844 ? -4 : -3)) {
        await expect(row).toBeInViewport({ ratio: 0.99 });
      }
      await expect(pane.getByTestId(`participant-guidance-${side}`)).toBeInViewport({ ratio: 0.99 });
      expect(await page.getByTestId(`participant-scroll-${side}`).evaluate(el => el.clientHeight)).toBeGreaterThan(0);
    }
    const end = (await page.getByRole("button", { name: "Завершить", exact: true }).boundingBox())!;
    await expect(page.getByRole("switch")).toHaveCount(0);
    await expect(page.getByRole("button", { name: "Язык собеседника" })).toHaveCount(0);
    expect(end.width).toBeGreaterThanOrEqual(44);
    expect(end.height).toBeGreaterThanOrEqual(44);
    await expect(page.getByRole("button", { name: "Завершить", exact: true })).toBeInViewport({ ratio: 0.99 });
    expect(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth)).toBe(true);
  }
});

test("long captions remain accessible through pauses and manual scrolling on both sides", async ({ page }, testInfo) => {
  const harness = await MockLiveHarness.attach(page);
  await harness.startListeningConversation();
  await harness.sourceActive();
  const original = "Could you tell me where the train station is? ".repeat(14);
  const translated = "¿Podría decirme dónde está la estación de tren? ".repeat(14);
  await harness.inputDelta(original);
  await harness.outputDelta(translated);
  for (const side of ["A", "B"] as const) {
    const scroll = page.getByTestId(`participant-scroll-${side}`);
    await expect(page.getByTestId(`participant-pane-${side}`).locator(".recent-turn-primary").last()).toHaveText(side === "A" ? original : translated);

    await expect(scroll).toHaveAttribute("tabindex", "0");
    await expect.poll(() => scroll.evaluate(el => el.scrollHeight > el.clientHeight)).toBe(true);
    expect(await scroll.evaluate(el => el.scrollHeight - el.scrollTop - el.clientHeight)).toBeLessThan(2);
    const box = (await scroll.boundingBox())!;
    const gutter = await scroll.evaluate(el => (el as HTMLElement).offsetWidth - el.clientWidth);
    if (gutter > 0) {
      await page.mouse.click(side === "B" ? box.x + gutter / 2 : box.x + box.width - gutter / 2, box.y + box.height / 2);
      await expect(page.getByTestId("participant-pane-A").locator(".turn-author").last()).toHaveText("Me:");
      await expect(page.getByTestId("participant-pane-B").locator(".turn-author").last()).toHaveText("Él:");
    }
    await page.mouse.move(box.x + box.width / 2, box.y + box.height / 2);
    await page.mouse.down();
    await page.mouse.move(box.x + box.width / 2, box.y + box.height / 2 + 35, { steps: 5 });
    await page.mouse.up();
    await expect(page.getByTestId("participant-pane-A").locator(".turn-author").last()).toHaveText("Me:");
    await expect(page.getByTestId("participant-pane-B").locator(".turn-author").last()).toHaveText("Él:");
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

    const scroll = page.getByTestId(`participant-scroll-${side}`);
    expect(await scroll.evaluate(el => el.scrollHeight - el.scrollTop - el.clientHeight)).toBeLessThan(2);
    expect(await scroll.evaluate(el => el.scrollWidth <= el.clientWidth)).toBe(true);
  }
  await page.screenshot({ path: testInfo.outputPath("conversation-22px.png") });
  await page.setViewportSize({ width: 320, height: 640 });
  await expect(page.getByRole("button", { name: "End", exact: true })).toBeVisible();
  const captionSizes = await Promise.all((["A", "B"] as const).map(side =>
    page.getByTestId(`participant-pane-${side}`).locator(".recent-turn-primary").last()
      .evaluate(el => parseFloat(getComputedStyle(el).fontSize)),
  ));
  // Text-only enlargement exercises reflow without shrinking the CSS viewport.
  await page.addStyleTag({ content: "html { font-size: 200% !important; }" });
  for (const [index, side] of (["A", "B"] as const).entries()) {
    const enlarged = await page.getByTestId(`participant-pane-${side}`).locator(".recent-turn-primary").last()
      .evaluate(el => parseFloat(getComputedStyle(el).fontSize));
    expect(enlarged / captionSizes[index]!).toBeCloseTo(2, 1);
    const scroll = page.getByTestId(`participant-scroll-${side}`);
    expect(await scroll.evaluate(el => el.clientHeight)).toBeGreaterThan(0);
    expect(await scroll.evaluate(el => el.scrollWidth <= el.clientWidth)).toBe(true);
  }
  expect(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth)).toBe(true);
  const end = page.getByRole("button", { name: "End", exact: true });
  await expect(page.getByRole("button", { name: "Partner's language" })).toHaveCount(0);
  const box = (await end.boundingBox())!;
  expect(box.width).toBeGreaterThanOrEqual(44);
  expect(box.height).toBeGreaterThanOrEqual(44);
  await expect(end).toBeInViewport();
  await page.screenshot({ path: testInfo.outputPath("conversation-200-percent.png") });
});

test("keeps all history and the reading position when another turn arrives", async ({ page }) => {
  const harness = await MockLiveHarness.attach(page);
  await harness.startListeningConversation();
  const captions = ["First", "Second", "Third", "Fourth"].map((word, index) => {
    const english = `${word}: ` + "Could you tell me where the train station is? ".repeat(10);
    const spanish = `${word}: ` + "¿Podría decirme dónde está la estación de tren? ".repeat(10);
    return index % 2 === 0 ? { original: english, translation: spanish } : { original: spanish, translation: english };
  });
  for (const caption of captions.slice(0, 3)) {
    await harness.sourceActive();
    await harness.inputDelta(caption.original);
    await harness.outputDelta(caption.translation);
    await harness.sourceQuiet();
    await harness.advance(runtime.noOutputTimeoutMs);
    await expect(page.getByTestId("participant-status-A")).toHaveText("You can speak");
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
  await harness.advance(runtime.noOutputTimeoutMs + runtime.captionIdleMs);
  for (const [index, side] of (["A", "B"] as const).entries()) {
    const history = page.getByTestId(`participant-scroll-${side}`).locator(".recent-turn");
    await expect(history).toHaveCount(4);
    await expect(history.first()).toContainText("First:");
    const retained = history.nth(1);
    await expect(retained).toContainText("Second:");
    await expect.poll(async () => Math.abs((await retained.boundingBox())!.y - before[index]!)).toBeLessThan(2);
  }
});

for (const resizeGuidance of [false, true]) {
  test(`keeps a later caption in place when an earlier translation grows${resizeGuidance ? " alongside a guidance resize" : ""}`, async ({ page }) => {
    const harness = await MockLiveHarness.attach(page);
    await page.addInitScript(() => {
      localStorage.setItem("live-translator-owner-language", "ru");
      localStorage.setItem("live-translator-interlocutor-language", "en");
    });
    await page.setViewportSize({ width: 390, height: 664 });
    await page.goto("/");
    await page.getByRole("button", { name: "Начать перевод" }).click();
    await expect(page.getByRole("button", { name: "Завершить" })).toBeVisible();
    const russian = "Подскажите, как пройти к вокзалу? ".repeat(8);
    const english = "Could you tell me where the train station is? ".repeat(8);
    const exchanges = [
      ["Первая реплика. " + russian, "First translation. " + english],
      ["Second source. " + english, "Второй перевод. " + russian],
      ["Третья реплика. " + russian, "Third translation. " + english],
      ["Fourth source. " + english, "Четвертый перевод. " + russian],
    ];
    for (const [index, [source, translation]] of exchanges.entries()) {
      await harness.sourceActive();
      await harness.inputDelta(source!, index * 10_000);
      await harness.outputDelta(translation!, index * 10_000);
      await harness.sourceQuiet();
      await harness.advance(runtime.noOutputTimeoutMs);
      await harness.waitForGateBUnmuted();
    }
    if (resizeGuidance) {
      await harness.bufferedPlayback(true);
      await harness.playbackActive();
      await expect(page.getByTestId("participant-guidance-B")).toContainText("Translation playing");
    }
    await page.clock.resume();
    const anchors = [
      page.getByTestId("participant-scroll-A").locator("li").filter({ hasText: "Третья реплика." }),
      page.getByTestId("participant-scroll-B").locator("li").filter({ hasText: "Second source." }),
    ];
    const positions: number[] = [];
    for (const anchor of anchors) {
      await anchor.evaluate(el => {
        const scroll = el.closest<HTMLElement>(".participant-scroll")!;
        scroll.scrollTop = (el as HTMLElement).offsetTop - scroll.offsetTop + 40;
        scroll.dispatchEvent(new Event("scroll"));
      });
      positions.push((await anchor.boundingBox())!.y);
    }
    const guidance = page.getByTestId("participant-guidance-B");
    const height = (await guidance.boundingBox())!.height;
    // Deliver both updates before the next paint, including the playback-to-tail transition.
    await page.evaluate(({ resize, height }) => new Promise<void>(resolve => requestAnimationFrame(() => {
      window.__liveTranslatorTestLive!.emit({
        type: "session.output_transcript.delta",
        delta: " Additional information about the first translation. ".repeat(14), start_ms: 1_000,
      });
      window.__liveTranslatorTestLive!.emit({
        type: "session.output_transcript.delta",
        delta: " Дополнение ко второму переводу. ".repeat(14), start_ms: 11_000,
      });
      if (resize) {
        window.__liveTranslatorTestPlayback!.emit(false);
        window.__liveTranslatorTestAudio!.emitPlaybackActivity(false, Date.now());
        // Model a one-pixel wrap difference independently of the browser's fallback font.
        document.querySelector<HTMLElement>('[data-testid="participant-guidance-B"]')!.style.minHeight = `${height + 1}px`;
      }
      resolve();
    })), { resize: resizeGuidance, height });
    await page.evaluate(() => new Promise<void>(resolve => requestAnimationFrame(() => requestAnimationFrame(() => resolve()))));
    if (resizeGuidance) {
      await expect(guidance).toContainText("One moment");
      expect((await guidance.boundingBox())!.height).not.toBe(height);
    }
    for (const [index, anchor] of anchors.entries()) {
      await expect.poll(async () => Math.abs((await anchor.boundingBox())!.y - positions[index]!)).toBeLessThan(2);
    }
  });
}

test("keeps the first keyboard scroll after caption-only reflow", async ({ page }) => {
  const harness = await MockLiveHarness.attach(page);
  await page.setViewportSize({ width: 390, height: 664 });
  await harness.startListeningConversation();
  await harness.sourceActive();
  await harness.inputDelta("Could you tell me where the train station is? ".repeat(14));
  await harness.outputDelta("¿Podría decirme dónde está la estación de tren? ".repeat(14));
  await harness.sourceQuiet();
  await harness.advance(runtime.noOutputTimeoutMs);
  await harness.waitForGateBUnmuted();
  await page.clock.resume();
  for (const side of ["A", "B"]) {
    const scroll = page.getByTestId(`participant-scroll-${side}`);
    await scroll.focus();
    const before = await scroll.evaluate(el => ({ top: el.scrollTop, height: el.clientHeight, content: el.scrollHeight }));
    await scroll.evaluate(el => {
      el.querySelector<HTMLElement>(".participant-recent")!.style.paddingBottom = "400px";
    });
    expect(await scroll.evaluate(el => el.clientHeight)).toBe(before.height);
    expect(await scroll.evaluate(el => el.scrollHeight)).toBe(before.content + 400);
    const firstScroll = scroll.evaluate(el => new Promise<number>(resolve => {
      el.addEventListener("scroll", () => resolve(el.scrollTop), { once: true });
    }));
    await scroll.press("ArrowUp");
    expect(await firstScroll).toBeLessThan(before.top);
  }
});

for (const { width, height, textSize } of [
  { width: 390, height: 664, textSize: 100 },
  { width: 320, height: 640, textSize: 100 },
  { width: 390, height: 664, textSize: 200 },
  { width: 320, height: 640, textSize: 200 },
]) {
  test(`preserves a near-end reading position through pause/resume at ${width}x${height} with ${textSize}% text`, async ({ page }) => {
    const harness = await MockLiveHarness.attach(page);
    await page.setViewportSize({ width, height });
    await harness.startListeningConversation();
    await page.addStyleTag({ content: `html { font-size: ${textSize}% !important; }` });
    await harness.sourceActive();
    await harness.inputDelta("Could you tell me where the train station is? ".repeat(14));
    await harness.outputDelta("¿Podría decirme dónde está la estación de tren? ".repeat(14));
    await harness.sourceQuiet();
    await harness.advance(runtime.noOutputTimeoutMs);
    await harness.waitForGateBUnmuted();
    await expect(page.getByTestId("participant-status-A")).toHaveText("You can speak");
    await page.clock.resume();
    const scrolls = ["A", "B"].map(side => page.getByTestId(`participant-scroll-${side}`));
    const positions: number[] = [];
    for (const scroll of scrolls) {
      await scroll.evaluate(el => {
        el.scrollTop = el.scrollHeight - el.clientHeight - 32;
        el.dispatchEvent(new Event("scroll"));
      });
      positions.push(await scroll.evaluate(el => el.scrollTop));
      expect(positions.at(-1)).toBeGreaterThan(0);
    }

    await page.evaluate(() => window.__setAudioState?.("interrupted"));
    await expect(page.getByTestId("participant-status-A")).toHaveText("Paused");
    await expect(page.getByTestId("participant-status-B")).toHaveText("En pausa");
    await page.evaluate(() => new Promise<void>(resolve => requestAnimationFrame(() => requestAnimationFrame(() => resolve()))));
    for (const [index, scroll] of scrolls.entries()) {
      const maximum = await scroll.evaluate(el => el.scrollHeight - el.clientHeight);
      expect(await scroll.evaluate(el => el.scrollTop)).toBe(Math.min(positions[index]!, maximum));
      if (textSize === 100) expect(maximum).toBeLessThan(positions[index]!);
    }

    await page.evaluate(() => window.__setAudioState?.("running"));
    await expect(page.getByTestId("participant-status-A")).toHaveText("You can speak");
    await expect(page.getByTestId("participant-status-B")).toHaveText("Puedes hablar");
    await page.evaluate(() => new Promise<void>(resolve => requestAnimationFrame(() => requestAnimationFrame(() => resolve()))));
    for (const [index, scroll] of scrolls.entries()) {
      await expect.poll(async () => Math.abs(await scroll.evaluate(el => el.scrollTop) - positions[index]!)).toBeLessThan(1);
    }
    await harness.sourceActive();
    await harness.inputDelta("Please show me the way.");
    await harness.outputDelta("Por favor, muéstreme el camino.");
    await page.evaluate(() => new Promise<void>(resolve => requestAnimationFrame(() => requestAnimationFrame(() => resolve()))));
    for (const [index, scroll] of scrolls.entries()) {
      await expect.poll(async () => Math.abs(await scroll.evaluate(el => el.scrollTop) - positions[index]!)).toBeLessThan(1);
      expect(await scroll.evaluate(el => el.scrollHeight - el.scrollTop - el.clientHeight)).toBeGreaterThan(32);
    }
  });
}

test("a long dialogue keeps all resolved captions and translation-only output while hiding unknown text", async ({ page }, testInfo) => {
  const harness = await MockLiveHarness.attach(page);
  await harness.startListeningConversation();
  for (let i = 0; i < 12; i++) {
    await harness.sourceActive();
    const spanishSource = i % 2 === 1;
    if (i !== 10) await harness.inputDelta(i === 11 ? "OK" : spanishSource
      ? `¿Podría decirme dónde está la estación de tren número ${i}?`
      : `Could you tell me where the train station number ${i} is?`);
    await harness.outputDelta(spanishSource ? `Thank you very much for helping me with question ${i}.` : `¿Podría decirme dónde está la estación de tren número ${i}?`);
    await harness.sourceQuiet();
    await harness.advance(runtime.noOutputTimeoutMs + runtime.captionIdleMs);
    await harness.waitForGateBUnmuted();
    for (const side of ["A", "B"] as const) {
      // Index 10 has output only; index 11 has an unresolved source retained internally.
      const count = i < 10 ? i + 1 : i === 10 ? (side === "A" ? 10 : 11) : 11;
      await expect(page.getByTestId(`participant-scroll-${side}`).locator("li")).toHaveCount(count);
    }
  }
  const a = page.getByTestId("participant-scroll-A");
  const b = page.getByTestId("participant-scroll-B");
  await expect(a.locator("li").first()).toContainText("Could you tell me");
  await expect(b.locator("li").first()).toContainText("¿Podría decirme");
  await expect(a.locator("li").last()).toContainText("Thank you very much for helping me with question 11.");
  await expect(page.locator(".recent-turn-primary").filter({ hasText: "OK" })).toHaveCount(0);
  await expect(b.locator("li").nth(10)).toContainText("¿Podría decirme");
  for (const scroll of [a, b]) {
    expect(await scroll.evaluate(el => el.scrollHeight > el.clientHeight)).toBe(true);
    await scroll.evaluate(el => { el.scrollTop = 0; el.dispatchEvent(new Event("scroll")); });
    await expect(scroll.locator("li").first()).toBeInViewport();
  }
  await page.screenshot({ path: testInfo.outputPath("conversation-full-history.png") });
});
