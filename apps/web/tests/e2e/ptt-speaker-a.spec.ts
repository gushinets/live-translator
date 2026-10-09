import { expect, test } from "@playwright/test";
import { MockLiveHarness } from "./mockLiveHarness";

test("PTT reacts immediately, ignores repeat keys, survives pauses and resets on release", async ({ page }) => {
  const harness = await MockLiveHarness.attach(page);
  await harness.startListeningConversation();
  const button = page.getByTestId("ptt-A");
  await expect(button).toBeEnabled();
  await expect(page.getByTestId("participant-pane-B").getByTestId("ptt-A")).toHaveCount(0);
  await button.focus();
  await page.keyboard.down("Space");
  await expect(button).toHaveAttribute("aria-pressed", "true");
  await expect(button).toHaveAccessibleName("Speaking…");
  await page.keyboard.down("Space");
  await harness.sourceActive(); await harness.inputDelta("iPhone Pro Max и Google Maps");
  await harness.sourceQuiet(); await harness.advance(35_000);
  await expect(button).toHaveAttribute("aria-pressed", "true");
  await page.keyboard.up("Space");
  await expect(button).toHaveAttribute("aria-pressed", "false");
  await expect(button).toHaveAccessibleName("Hold to speak");
  expect(harness.liveSessionCreateCount()).toBe(1);
});

test("unknown PTT captions remain accessible without overwriting previously confirmed B", async ({ page }) => {
  const harness = await MockLiveHarness.attach(page);
  await harness.startListeningConversation();
  await harness.sourceActive(); await harness.inputDelta("Спасибо", 100, 500);
  await expect(page.getByTestId("participant-pane-B")).toContainText("Спасибо");
  await harness.sourceQuiet();
  const button = page.getByTestId("ptt-A");
  await button.focus(); await page.keyboard.down("Enter");
  await harness.sourceActive(); await harness.inputDelta("Мне нужен Google Maps", 600, 900);
  await harness.outputDelta("I need Google Maps");
  await page.keyboard.up("Enter");
  await page.locator(".unassigned-captions summary").click();
  await expect(page.locator(".unassigned-captions")).toContainText("Мне нужен Google Maps");
  await expect(page.locator(".unassigned-captions")).toContainText("I need Google Maps");
  await expect(page.getByTestId("participant-pane-B")).toContainText("Спасибо");
  await expect(page.getByTestId("participant-pane-A")).not.toContainText("Google Maps");
});

test("physical release is required after the 120-second limit and End removes the control", async ({ page }) => {
  const harness = await MockLiveHarness.attach(page);
  await harness.startListeningConversation();
  const button = page.getByTestId("ptt-A");
  await button.focus(); await page.keyboard.down("Space");
  await harness.advance(120_000);
  await expect(button).toHaveAttribute("aria-pressed", "false");
  await expect(page.getByText(/120-second limit reached/)).toBeVisible();
  await page.keyboard.down("Space");
  await expect(button).toHaveAttribute("aria-pressed", "false");
  await page.keyboard.up("Space");
  await page.keyboard.down("Space");
  await expect(button).toHaveAttribute("aria-pressed", "true");
  await page.keyboard.up("Space");
  await page.getByRole("button", { name: "End", exact: true }).click();
  await expect(page.getByTestId("ptt-A")).toHaveCount(0);
  await expect(page.getByRole("button", { name: "Back to start" })).toBeVisible();
});
