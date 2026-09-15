import type { Page } from "@playwright/test";

const PORTRAIT_SCREEN = { width: 390, height: 844 };

export async function emulatePortraitScreen(page: Page): Promise<void> {
  const cdp = await page.context().newCDPSession(page);
  await cdp.send("Emulation.setDeviceMetricsOverride", {
    mobile: false,
    width: PORTRAIT_SCREEN.width,
    height: PORTRAIT_SCREEN.height,
    screenWidth: PORTRAIT_SCREEN.width,
    screenHeight: PORTRAIT_SCREEN.height,
    deviceScaleFactor: 1,
    screenOrientation: {
      type: "portraitPrimary",
      angle: 0,
    },
  });
}
