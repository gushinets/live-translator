import { expect, test, type Page } from "@playwright/test";
import { runtime } from "../../src/config/runtime";
import { MockLiveHarness } from "./mockLiveHarness";

async function startRussianEnglish(page: Page): Promise<MockLiveHarness> {
  const harness = await MockLiveHarness.attach(page);
  await page.addInitScript(() => {
    localStorage.setItem("live-translator-owner-language", "ru");
    localStorage.setItem("live-translator-interlocutor-language", "en");
  });
  await page.goto("/");
  await page.getByRole("button", { name: "Начать перевод" }).click();
  await expect(page.getByRole("button", { name: "Завершить" })).toBeVisible();
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
  await expect(b.getByTestId("current-primary-B")).toHaveText("The station is straight ahead.");
  await expect(b.getByTestId("current-author-B")).toHaveText("Me:");
  await expect(a.locator("li")).toHaveText("Я: Подскажите, где находится вокзал?");
  await harness.outputDelta("Where is the train station?");
  await expect(b.locator("li")).toHaveText("Him: Where is the train station?");
  await harness.outputDelta("Вокзал находится прямо впереди.");
  await expect(a.getByTestId("current-primary-A")).toHaveText("Вокзал находится прямо впереди.");
  await expect(a.getByTestId("current-author-A")).toHaveText("Он:");
  expect(await harness.sentClientEvents()).toEqual(startupEvents);
  await page.screenshot({ path: testInfo.outputPath("rapid-reply-late-translation.png") });
});

test("partial words stay separate until the new speaker's language resolves", async ({ page }) => {
  const harness = await startRussianEnglish(page);
  await harness.sourceActive();
  await harness.inputDelta("Подскажите, где находится вокзал?", 0, 1000);
  await harness.inputDelta("The", 1100, 1150);
  await expect(page.getByTestId("current-primary-A")).toHaveText("Подскажите, где находится вокзал?");
  await harness.inputDelta(" station is straight ahead.", 1150, 1600);
  await expect(page.getByTestId("current-primary-B")).toHaveText("The station is straight ahead.");
  await expect(page.getByTestId("participant-pane-A").locator("li")).toHaveText("Я: Подскажите, где находится вокзал?");
});

test("same-speaker continuation stays in the original source across a short pause", async ({ page }) => {
  const harness = await startRussianEnglish(page);
  await harness.sourceActive();
  await harness.inputDelta("Подскажите, где находится вокзал?");
  await harness.sourceQuiet();
  await harness.advance(300);
  await harness.sourceActive();
  await harness.inputDelta(" Я хочу дойти туда пешком.");
  await expect(page.getByTestId("current-primary-A")).toHaveText("Подскажите, где находится вокзал? Я хочу дойти туда пешком.");
  await expect(page.locator(".recent-turn")).toHaveCount(0);
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
  await expect(b.locator("li")).toHaveCount(3);
  await harness.sourceQuiet();
  await harness.advance(runtime.noOutputTimeoutMs + runtime.captionIdleMs);
  await expect(b.getByText("Thank you, I will walk there.")).toBeVisible();
  await expect(page.getByText("Повторите", { exact: true })).toHaveCount(0);
  expect(await harness.lastGateBCommand()).toBe("unmute");
  await page.screenshot({ path: testInfo.outputPath("independent-translation.png") });
});
