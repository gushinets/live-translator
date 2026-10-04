import { expect, test } from "@playwright/test";
import { MockLiveHarness } from "./mockLiveHarness";

test("courier dialogue retains originals, translations and split names across caption idle", async ({ page }, testInfo) => {
  const harness = await MockLiveHarness.attach(page);
  await page.addInitScript(() => {
    localStorage.setItem("live-translator-owner-language", "ru");
    localStorage.setItem("live-translator-interlocutor-language", "en");
  });
  await page.goto("/?captions=blocks");
  await page.getByRole("button", { name: "Начать перевод", exact: true }).click();
  await expect(page.getByRole("button", { name: "Завершить", exact: true })).toBeVisible();
  const startup = await harness.sentClientEvents();
  await harness.sourceActive();
  await harness.inputDelta("Так, здравствуйте. Кто вы? Что вы хотите?");
  await harness.inputDelta("Um, sir, hi. I'm a delivery guy. I ");
  await harness.outputDelta("Well, hello. Who are you, what do you ");
  await harness.advance(900);
  await harness.outputDelta("want?");
  await harness.inputDelta("need to deliver a package for Mr. Mikhail Gu");
  await harness.advance(900);
  await harness.inputDelta("shin.");
  await harness.outputDelta("Эм, сэр, привет. Я курьер. У меня посылка для господина Михаила Гу");
  await harness.advance(900);
  await harness.outputDelta("шина.");
  await harness.inputDelta("Ага, как мне получить посылку?");
  await harness.outputDelta("How do I get the package?");
  await harness.sourceQuiet();
  await harness.advance(6000);

  const a = page.getByTestId("participant-pane-A"), b = page.getByTestId("participant-pane-B");
  await expect(a.locator("li")).toHaveText([
    "Я: Так, здравствуйте. Кто вы? Что вы хотите?",
    "Он: Эм, сэр, привет. Я курьер. У меня посылка для господина Михаила Гушина.",
    "Я: Ага, как мне получить посылку?",
  ]);
  await expect(b.locator("li")).toHaveText([
    "Me: Um, sir, hi. I'm a delivery guy. I need to deliver a package for Mr. Mikhail Gushin.",
    "Him: Well, hello. Who are you, what do you want?",
    "Him: How do I get the package?",
  ]);
  await expect(page.locator(".turn-waiting")).toHaveCount(0);
  await expect(page.getByText("Повторите", { exact: true })).toHaveCount(0);
  expect(await harness.lastGateBCommand()).toBe("unmute");
  expect(await harness.sentClientEvents()).toEqual(startup);
  await page.screenshot({ path: testInfo.outputPath("courier-caption-blocks.png") });
});

test("unknown text is retained once outside both panes and resolves in place", async ({ page }) => {
  const harness = await MockLiveHarness.attach(page);
  await page.addInitScript(() => {
    localStorage.setItem("live-translator-owner-language", "ru");
    localStorage.setItem("live-translator-interlocutor-language", "en");
  });
  await page.goto("/?captions=blocks");
  await page.getByRole("button", { name: "Начать перевод", exact: true }).click();
  await expect(page.getByRole("button", { name: "Завершить", exact: true })).toBeVisible();
  await harness.outputDelta("OK");
  await harness.advance(900);
  await expect(page.locator(".participant-pane li")).toHaveCount(0);
  await page.getByText("Текст без определённого языка (1)", { exact: true }).click();
  await expect(page.getByText("OK", { exact: true })).toBeVisible();
  await harness.outputDelta(", I can check that for you.");
  await expect(page.locator(".unassigned-captions")).toHaveCount(0);
  await expect(page.getByTestId("participant-pane-B").locator("li")).toHaveText("Him: OK, I can check that for you.");
  await expect(page.getByTestId("participant-pane-A").locator("li")).toHaveCount(0);
});
