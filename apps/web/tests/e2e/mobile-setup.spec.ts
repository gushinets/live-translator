import { expect, test } from "@playwright/test";

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
});
