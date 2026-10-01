import { expect, test, type Locator } from "@playwright/test";
import { MockLiveHarness } from "./mockLiveHarness";

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
    await expect(page.getByText("Live Translator")).toBeVisible();
    await expect(page.getByRole("heading", { name: "Partner's language" })).toBeVisible();
    await expect(page.getByRole("textbox", { name: "Контекст" })).toHaveCount(0);

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

    const choices = page.locator(".language-picker-option");
    for (let index = 0; index < 4; index++) {
      const box = await choices.nth(index).boundingBox();
      expect(box?.height ?? 0).toBeGreaterThanOrEqual(70);
      expect(box?.y ?? 0).toBeGreaterThanOrEqual(0);
      expect((box?.y ?? 0) + (box?.height ?? 0)).toBeLessThan(startBox?.y ?? 0);
    }
    expect(await page.locator(".language-picker-options").evaluate(element =>
      element.scrollHeight > element.clientHeight)).toBe(true);
    const listBox = await page.locator(".language-picker-options").boundingBox();
    expect((startBox!.y) - (listBox!.y + listBox!.height)).toBeLessThanOrEqual(16);
    expect(await choices.evaluateAll(elements => {
      const edge = elements[0].parentElement!.getBoundingClientRect().bottom;
      return elements.some(element => {
        const box = element.getBoundingClientRect();
        return box.top < edge && box.bottom > edge;
      });
    })).toBe(true);
  });

  test("keeps secondary setup copy at readable contrast", async ({ page }) => {
    await page.goto("/");

    const owner = page.locator(".language-picker-owner");
    await expect(owner).toBeVisible();
    expect(await contrastRatio(owner)).toBeGreaterThanOrEqual(4.5);
  });

  test("centers the repeat-start action and reopens the saved choice from settings", async ({ page }) => {
    await page.addInitScript(() => localStorage.setItem("live-translator-interlocutor-language", "es"));
    await page.goto("/");

    const start = page.getByRole("button", { name: "Start translation" });
    const brand = page.getByText("Live Translator");
    const settings = page.getByRole("button", { name: "Settings" });
    await expect(brand).toBeVisible();
    await expect(settings).toBeVisible();
    const brandBox = await brand.boundingBox();
    const settingsBox = await settings.boundingBox();
    expect(Math.abs((brandBox?.y ?? 0) + (brandBox?.height ?? 0) / 2 -
      (settingsBox?.y ?? 0) - (settingsBox?.height ?? 0) / 2)).toBeLessThan(3);
    const box = await start.boundingBox();
    expect(Math.abs((box?.y ?? 0) + (box?.height ?? 0) / 2 - 844 / 2)).toBeLessThan(70);
    await expect(page.getByRole("radio", { name: "Spanish" })).toHaveCount(0);

    await page.getByRole("button", { name: "Settings" }).click();
    await expect(page.getByRole("radio", { name: "Spanish" })).toBeChecked();
    await page.getByRole("button", { name: "Close settings" }).click();
    await expect(page.getByRole("radio", { name: "Spanish" })).toHaveCount(0);
  });

  test("keeps the repeat-start button in place until translation is ready", async ({ page }) => {
    await MockLiveHarness.attach(page);
    await page.addInitScript(() => localStorage.setItem("live-translator-interlocutor-language", "es"));
    let releaseSession!: () => void;
    const sessionGate = new Promise<void>(resolve => { releaseSession = resolve; });
    await page.route("**/api/live/session", async route => {
      await sessionGate;
      await route.fulfill({ status: 200, contentType: "application/json", body: JSON.stringify({
        session: { id: "sess_e2e" }, transport: { type: "webrtc", sdp: "v=0 fake-answer" },
      }) });
    });
    await page.goto("/");

    const start = page.getByRole("button", { name: "Start translation" });
    const before = await start.boundingBox();
    await start.click();
    const pending = page.getByRole("button", { name: "Connecting…" });
    await expect(pending).toBeDisabled();
    await expect(page.getByRole("button", { name: "Settings" })).toBeDisabled();
    const during = await pending.boundingBox();
    expect(Math.abs((during?.y ?? 0) - (before?.y ?? 0))).toBeLessThan(2);
    expect(during?.height).toBe(before?.height);
    expect(await page.locator(".setup-card--start").count()).toBe(1);

    releaseSession();
    await expect(page.getByRole("button", { name: "End" })).toBeVisible();
  });

  test("uses a Russian PWA description", async ({ request }) => {
    const response = await request.get("/manifest.webmanifest");
    const manifest = await response.json();

    expect(manifest.description).toBe(
      "Переводчик для разговора двух людей на одном телефоне.",
    );
  });
});
