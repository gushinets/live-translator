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

test.describe("mobile setup controls", () => {
  test.use({ viewport: { width: 390, height: 844 } });

  test("shows four priority languages and Start immediately and allows selecting a language after scrolling", async ({ page }) => {
    await page.goto("/");

    const setup = page.getByRole("region", { name: "Translator setup" });
    await expect(setup).toBeVisible();

    const start = page.getByRole("button", { name: "Start translation" });
    await expect(start).toBeEnabled();
    await expect(start).toBeInViewport({ ratio: 1 });

    const choices = await page.getByRole("radio").evaluateAll(radios => Promise.all(
      radios.map(radio => new Promise<{ visibility: number; width: number; height: number }>(resolve => {
        const observer = new IntersectionObserver(([entry]) => {
          observer.disconnect();
          resolve({ visibility: entry.intersectionRatio,
            width: entry.boundingClientRect.width, height: entry.boundingClientRect.height });
        });
        // Observe visible labels; native radio inputs may be visually hidden.
        observer.observe((radio as HTMLInputElement).labels?.[0] ?? radio);
      })),
    ));
    expect(choices.slice(0, 4).map(choice => choice.visibility)).toEqual([1, 1, 1, 1]);
    expect(choices.some(choice => choice.visibility > 0 && choice.visibility < 1)).toBe(true);
    for (const choice of choices) {
      expect(choice.width).toBeGreaterThanOrEqual(44);
      expect(choice.height).toBeGreaterThanOrEqual(44);
    }

    const startBox = await start.boundingBox();
    expect(startBox).not.toBeNull();
    expect(startBox?.height ?? 0).toBeGreaterThanOrEqual(44);
    expect(startBox?.width ?? 0).toBeGreaterThanOrEqual(44);

    const choice = page.getByRole("radio").last();
    await choice.scrollIntoViewIfNeeded();
    await choice.click();
    await expect(choice).toBeChecked();
    await expect(start).toBeInViewport();
  });

  test("keeps secondary setup copy at readable contrast", async ({ page }) => {
    await page.goto("/");

    const owner = page.locator(".language-picker-owner");
    await expect(owner).toBeVisible();
    expect(await contrastRatio(owner)).toBeGreaterThanOrEqual(4.5);
  });

  test("shows the saved languages and reopens the choice from settings", async ({ page }) => {
    await page.addInitScript(() => localStorage.setItem("live-translator-interlocutor-language", "es"));
    await page.goto("/");

    const settings = page.getByRole("button", { name: "Settings" });
    await expect(settings).toBeVisible();
    await expect(page.getByRole("button", { name: "Your language English" })).toBeVisible();
    await expect(page.getByRole("button", { name: "Partner's language Spanish" })).toBeVisible();
    await expect(page.getByRole("radio", { name: "Spanish" })).toHaveCount(0);

    await page.getByRole("button", { name: "Settings" }).click();
    await expect(page.getByRole("radio", { name: "Spanish" })).toBeChecked();
    await page.getByRole("button", { name: "Close settings" }).click();
    await expect(page.getByRole("radio", { name: "Spanish" })).toHaveCount(0);
  });

  test("blocks repeated Start and settings changes until translation is ready", async ({ page }) => {
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
    await start.click();
    const pending = page.getByRole("button", { name: "Connecting…" });
    await expect(pending).toBeDisabled();
    await expect(page.getByRole("button", { name: "Settings" })).toBeDisabled();

    releaseSession();
    await expect(page.getByRole("button", { name: "End" })).toBeVisible();
  });

});
