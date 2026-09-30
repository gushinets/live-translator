import { expect, test } from "@playwright/test";
test("does not show the removed OpenAI footer copy", async ({ page }) => {
  await page.goto("/");

  await expect(page.getByText(/Речь обрабатывает OpenAI/i)).toHaveCount(0);
  await expect(page.getByRole("heading", { name: "Язык собеседника" })).toBeVisible();
  await expect(page.getByRole("button", { name: "Начать перевод" })).toBeVisible();
  await expect(page.getByRole("button", { name: "Завершить" })).toHaveCount(0);
  await expect(page.getByRole("radio", { name: "испанский" })).toBeChecked();
  await expect(page.getByText(/Речь обрабатывает OpenAI/i)).toHaveCount(0);
});
