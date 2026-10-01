import { expect, test } from "@playwright/test";
test("does not show the removed OpenAI footer copy", async ({ page }) => {
  await page.goto("/");

  await expect(page.getByText(/Речь обрабатывает OpenAI/i)).toHaveCount(0);
  await expect(page.getByRole("heading", { name: "Partner's language" })).toBeVisible();
  await expect(page.getByRole("button", { name: "Start translation" })).toBeVisible();
  await expect(page.getByRole("button", { name: "End" })).toHaveCount(0);
  await expect(page.getByRole("radio", { name: "Spanish" })).toBeChecked();
  await expect(page.getByText(/Речь обрабатывает OpenAI/i)).toHaveCount(0);
});
