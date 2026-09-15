import { expect, test } from "@playwright/test";

test("real-Live harness presents a portrait screen to lifecycle code", async ({ page }) => {
  const cdp = await page.context().newCDPSession(page);
  await cdp.send("Emulation.setDeviceMetricsOverride", {
    mobile: false,
    width: 390,
    height: 844,
    screenWidth: 390,
    screenHeight: 844,
    deviceScaleFactor: 1,
    screenOrientation: {
      type: "portraitPrimary",
      angle: 0,
    },
  });

  await page.goto("/");

  const orientation = await page.evaluate(() => screen.orientation?.type ?? "unavailable");

  expect(orientation).toMatch(/^portrait/);
});
