import { expect, test } from "@playwright/test";
test("opens the built app ready to start with the default partner language", async ({ page }) => {
  await page.goto("/");

  await expect(page.getByRole("region", { name: "Translator setup" })).toBeVisible();
  await expect(page.getByRole("button", { name: "Start translation" })).toBeEnabled();
  await expect(page.getByRole("button", { name: "End" })).toHaveCount(0);
  await expect(page.getByRole("radio", { name: "Spanish" })).toBeChecked();
});
