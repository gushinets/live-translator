import { expect, test } from "@playwright/test";

test("real-Live harness presents a portrait screen to lifecycle code", async ({ page }) => {
  await page.goto("/");

  const orientation = await page.evaluate(() => screen.orientation?.type ?? "unavailable");

  expect(orientation).toMatch(/^portrait/);
});
