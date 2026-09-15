import { expect, test } from "@playwright/test";
import { emulatePortraitScreen } from "./portrait-screen";

test("real-Live harness presents a portrait screen to lifecycle code", async ({ page }) => {
  await emulatePortraitScreen(page);
  await page.goto("/");

  const orientation = await page.evaluate(() => screen.orientation?.type ?? "unavailable");

  expect(orientation).toMatch(/^portrait/);
});
