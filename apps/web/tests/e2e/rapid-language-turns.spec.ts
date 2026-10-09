import { expect, test, type Page } from "@playwright/test";
import { runtime } from "../../src/config/runtime";
import { MockLiveHarness } from "./mockLiveHarness";

async function startRussianEnglish(page: Page, languages = { A: "ru", B: "en" }): Promise<MockLiveHarness> {
  const harness = await MockLiveHarness.attach(page);
  await page.addInitScript(pair => {
    localStorage.setItem("live-translator-owner-language", pair.A);
    localStorage.setItem("live-translator-interlocutor-language", pair.B);
  }, languages);
  await page.goto("/");
  await page.getByRole("button", { name: /^(Начать перевод|Start translation)$/ }).click();
  await expect(page.getByRole("button", { name: /^(Завершить|End)$/ })).toBeVisible();
  return harness;
}

test("a rapid B reply retains A's late translation and both relative authors", async ({ page }, testInfo) => {
  const harness = await startRussianEnglish(page);
  const startupEvents = await harness.sentClientEvents();
  await harness.sourceActive();
  await harness.inputDelta("Подскажите, где находится вокзал?", 0, 1000);
  await harness.advance(100);
  await harness.inputDelta("The station is straight ahead.", 1100, 1600);
  const a = page.getByTestId("participant-pane-A");
  const b = page.getByTestId("participant-pane-B");
  await expect(b.locator(".recent-turn-primary").last()).toHaveText("The station is straight ahead.");
  await expect(b.locator(".turn-author").last()).toHaveText("Me:");
  await expect(a.locator("li")).toHaveText("Я: Подскажите, где находится вокзал?");
  await harness.outputDelta("Where is the train station?");
  await expect(b.locator("li")).toHaveText(["Me: The station is straight ahead.", "Him: Where is the train station?"]);
  await harness.outputDelta("Вокзал находится прямо впереди.");
  await expect(a.locator(".recent-turn-primary").last()).toHaveText("Вокзал находится прямо впереди.");
  await expect(a.locator(".turn-author").last()).toHaveText("Он:");
  expect(await harness.sentClientEvents()).toEqual(startupEvents);
  await page.screenshot({ path: testInfo.outputPath("rapid-reply-late-translation.png") });
});

test("partial words stay separate until the new speaker's language resolves", async ({ page }) => {
  const harness = await startRussianEnglish(page);
  await harness.sourceActive();
  await harness.inputDelta("Подскажите, где находится вокзал?", 0, 1000);
  await harness.inputDelta("The", 1100, 1150);
  await expect(page.getByTestId("participant-pane-A").locator(".recent-turn-primary").last()).toHaveText("Подскажите, где находится вокзал?");
  await harness.inputDelta(" station is straight ahead.", 1150, 1600);
  await expect(page.getByTestId("participant-pane-B").locator(".recent-turn-primary").last()).toHaveText("The station is straight ahead.");
  await expect(page.getByTestId("participant-pane-A").locator("li")).toHaveText("Я: Подскажите, где находится вокзал?");
});

test("an idle timer cannot turn an unfinished English word into a Spanish author", async ({ page }) => {
  const harness = await startRussianEnglish(page, { A: "en", B: "es" });
  await harness.sourceActive();
  await harness.inputDelta("Where is the nearest station?");
  await harness.inputDelta(" Thank y");
  await harness.advance(runtime.captionIdleMs);
  await expect(page.getByTestId("participant-pane-A").locator(".recent-turn-primary").last()).toHaveText("Where is the nearest station?");
  await expect(page.locator(".recent-turn")).toHaveCount(1);
  await harness.inputDelta("ou very much.");
  await expect(page.getByTestId("participant-pane-A").locator(".recent-turn-primary").last()).toHaveText("Where is the nearest station? Thank you very much.");
  await expect(page.getByTestId("participant-pane-A").locator(".turn-author").last()).toHaveText("Me:");
  await expect(page.locator(".recent-turn")).toHaveCount(1);
});

test("unidentified translation captions stay hidden without acquiring the current source author", async ({ page }) => {
  const harness = await startRussianEnglish(page);
  await harness.sourceActive();
  await harness.inputDelta("Подскажите, где находится вокзал?");
  await harness.outputDelta("OK");
  await harness.sourceQuiet();
  await harness.advance(runtime.captionIdleMs);
  for (const side of ["A", "B"]) {
    const caption = page.getByTestId(`participant-pane-${side}`).locator("li").filter({ hasText: "OK" });
    await expect(caption).toHaveCount(0);
    await expect(caption.locator(".turn-author")).toHaveCount(0);
  }
  await expect(page.getByTestId("participant-pane-A").locator(".recent-turn-primary").last()).toHaveText("Подскажите, где находится вокзал?");
  await expect(page.getByTestId("participant-pane-B").locator(".recent-turn-primary").last()).toHaveCount(0);
  expect(await harness.lastGateBCommand()).toBe("unmute");
});

test("same-speaker continuation stays in the original source across a short pause", async ({ page }) => {
  const harness = await startRussianEnglish(page);
  await harness.sourceActive();
  await harness.inputDelta("Подскажите, где находится вокзал?");
  await harness.sourceQuiet();
  await harness.advance(300);
  await harness.sourceActive();
  await harness.inputDelta(" Я хочу дойти туда пешком.");
  await expect(page.getByTestId("participant-pane-A").locator(".recent-turn-primary").last()).toHaveText("Подскажите, где находится вокзал? Я хочу дойти туда пешком.");
  await expect(page.locator(".recent-turn")).toHaveCount(1);
  expect(await harness.lastGateBCommand()).toBe("unmute");
});

test("ambiguous A-B-A output stays an independent authored block after source timeouts", async ({ page }, testInfo) => {
  const harness = await startRussianEnglish(page);
  await harness.sourceActive();
  await harness.inputDelta("Подскажите, где находится вокзал?");
  await harness.advance(100);
  await harness.inputDelta("The station is straight ahead.");
  await harness.advance(100);
  await harness.inputDelta("Спасибо, я пойду туда пешком.");
  await harness.outputDelta("Thank you, I will walk there.");
  const a = page.getByTestId("participant-pane-A");
  const b = page.getByTestId("participant-pane-B");
  await expect(b.getByText("Thank you, I will walk there.").locator("..")).toContainText("Him:");
  await expect(a.getByText("Thank you, I will walk there.")).toHaveCount(0);
  await expect(a.locator("li")).toHaveCount(2);
  await expect(b.locator("li")).toHaveCount(2);
  await harness.sourceQuiet();
  await harness.advance(runtime.noOutputTimeoutMs + runtime.captionIdleMs);
  await expect(b.getByText("Thank you, I will walk there.")).toBeVisible();
  await expect(page.getByText("Повторите", { exact: true })).toHaveCount(0);
  expect(await harness.lastGateBCommand()).toBe("unmute");
  await page.screenshot({ path: testInfo.outputPath("independent-translation.png") });
});
