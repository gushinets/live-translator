import { expect, test, type Locator } from "@playwright/test";

async function contrastRatio(locator: Locator): Promise<number> {
  return locator.evaluate((element) => {
    function parseRgb(value: string): [number, number, number] {
      const match = value.match(/rgba?\((\d+),\s*(\d+),\s*(\d+)/);
      if (match === null) {
        throw new Error(`Unsupported color: ${value}`);
      }
      return [Number(match[1]), Number(match[2]), Number(match[3])];
    }

    function luminance([red, green, blue]: [number, number, number]): number {
      const channels = [red, green, blue].map((channel) => {
        const value = channel / 255;
        return value <= 0.04045
          ? value / 12.92
          : ((value + 0.055) / 1.055) ** 2.4;
      });
      return 0.2126 * channels[0] + 0.7152 * channels[1] + 0.0722 * channels[2];
    }

    const foreground = parseRgb(getComputedStyle(element).color);
    const backgroundElement = element.closest(".setup-screen") ?? document.body;
    const background = parseRgb(getComputedStyle(backgroundElement).backgroundColor);
    const light = Math.max(luminance(foreground), luminance(background));
    const dark = Math.min(luminance(foreground), luminance(background));
    return (light + 0.05) / (dark + 0.05);
  });
}

test.describe("mobile setup layout", () => {
  test.use({ viewport: { width: 390, height: 844 } });

  test("fits a portrait viewport and keeps primary controls touch friendly", async ({ page }) => {
    await page.goto("/");

    const setup = page.getByRole("region", { name: "Translator setup" });
    await expect(setup).toBeVisible();
    await expect(page.getByRole("heading", { level: 1, name: "Live Translator" })).toBeVisible();
    await expect(page.getByRole("textbox", { name: "Context" })).toBeVisible();

    const start = page.getByRole("button", { name: "Start translation" });
    await expect(start).toBeVisible();

    const fitsViewport = await page.evaluate(() =>
      document.documentElement.scrollWidth <= window.innerWidth,
    );
    expect(fitsViewport).toBe(true);

    const startBox = await start.boundingBox();
    expect(startBox).not.toBeNull();
    expect(startBox?.height ?? 0).toBeGreaterThanOrEqual(44);
    expect(startBox?.width ?? 0).toBeGreaterThanOrEqual(44);

    const contextAction = page.getByRole("button", {
      name: "Tell me the context (optional)",
    });
    const contextActionBox = await contextAction.boundingBox();
    expect(contextActionBox).not.toBeNull();
    expect(contextActionBox?.height ?? 0).toBeGreaterThanOrEqual(44);
  });

  test("keeps small secondary setup copy at readable contrast", async ({ page }) => {
    await page.goto("/");

    const privacy = page.locator(".privacy-disclosure");
    await expect(privacy).toBeVisible();
    expect(await contrastRatio(privacy)).toBeGreaterThanOrEqual(4.5);

    const fieldFooter = page.locator(".setup-field-footer > span");
    await expect(fieldFooter).toBeVisible();
    expect(await contrastRatio(fieldFooter)).toBeGreaterThanOrEqual(4.5);
  });
});
