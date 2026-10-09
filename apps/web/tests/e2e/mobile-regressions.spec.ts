import { devices, expect, test } from "@playwright/test";
import { MockLiveHarness } from "./mockLiveHarness";

test("loads the declared browser icon", async ({ page, request }) => {
  await page.goto("/");
  const href = await page.locator('link[rel="icon"]').getAttribute("href", { timeout: 1000 });
  expect(href).toBeTruthy();
  const response = await request.get(href!);
  expect(response.ok()).toBe(true);
  expect(response.headers()["content-type"]).toContain("image/");
});

for (const name of ["Pixel 7 landscape", "iPhone 13 landscape", "Galaxy S24 landscape"]) {
  const { defaultBrowserType, ...descriptor } = devices[name]!;
  test.describe(name, () => {
    test.use(descriptor);
    test("setup language lists remain usable and the conversation keeps its end action", async ({ page, browserName }) => {
      test.skip(browserName !== defaultBrowserType, "Use the descriptor's browser engine");
      await MockLiveHarness.attach(page);
      // Defense in depth: unknown live endpoints cannot reach a paid backend.
      await page.context().route("**/api/live/session**", route => route.abort());
      await page.context().route("https://api.openai.com/**", route => route.abort());
      await page.goto("/");
      const options = page.locator(".language-picker-options");
      await expect(options).toBeVisible();
      expect(await options.evaluate(e => e.clientHeight)).toBeGreaterThanOrEqual(74);
      expect(await page.locator(".setup-card").evaluate(card => {
        const button = card.querySelector(".language-picker-action")!;
        return button.getBoundingClientRect().bottom <= card.getBoundingClientRect().bottom;
      })).toBe(true);
      await page.getByRole("button", { name: "Change", exact: true }).tap();
      await page.getByRole("combobox").selectOption("en");
      const russian = page.locator('.language-picker-option:has(input[value="ru"])');
      await russian.scrollIntoViewIfNeeded();
      await russian.tap();
      await expect(page.locator('input[value="ru"]')).toBeChecked();
      await page.getByRole("button", { name: "Start translation", exact: true }).tap();
      await expect(page.locator(".conversation-screen")).toBeVisible();
      await expect(page.getByRole("button", { name: "Partner's language" })).toHaveCount(0);
      await expect(page.getByRole("dialog")).toHaveCount(0);
      await expect(page.getByRole("button", { name: "End", exact: true })).toBeVisible();
      await expect(page.getByTestId("participant-pane-B")).toHaveAttribute("lang", "ru");
    });
  });
}
