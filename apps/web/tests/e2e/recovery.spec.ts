import { expect, test } from "@playwright/test";

test("unresolved create keeps admission blocked without retry or End offline", async ({ page }) => {
  await page.goto("/");
  await expect(page.getByRole("button", { name: "Начать перевод" })).toBeVisible();
  await page.evaluate(() => sessionStorage.setItem("live-translator-retained-conversation-v1", "pending-create"));
  await page.route("**/api/**", route => route.abort());
  await page.setViewportSize({ width: 320, height: 700 });
  await page.emulateMedia({ reducedMotion: "reduce" });
  await page.reload();
  await expect(page.getByRole("alert")).toContainText("Создание разговора не удалось подтвердить");
  await expect(page.getByRole("button", { name: "Начать перевод" })).toHaveCount(0);
  await expect(page.getByRole("button", { name: "Повторить проверку" })).toHaveCount(0);
  await expect(page.getByRole("button", { name: "Завершить сохранённый разговор" })).toHaveCount(0);
  expect(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth)).toBe(true);
});

test("pending End stays blocked offline and releases Start only after server proof", async ({ page }) => {
  await page.goto("/");
  await page.evaluate(async () => {
    const db = await new Promise<IDBDatabase>((resolve, reject) => {
      const request = indexedDB.open("live-translator-metadata-v1", 2);
      request.onupgradeneeded = () => {
        request.result.createObjectStore("envelopes", { keyPath: "localId" });
        request.result.createObjectStore("lifecycle", { keyPath: "conversationId" });
      };
      request.onsuccess = () => resolve(request.result);
      request.onerror = () => reject(request.error);
    });
    await new Promise<void>((resolve, reject) => {
      const tx = db.transaction("lifecycle", "readwrite");
      tx.objectStore("lifecycle").put({ conversationId: "recovery", expectedVersion: 1,
        reason: "user_end", expiresAt: Date.now() + 7 * 86400000, cleanupLocalIds: [] });
      tx.oncomplete = () => resolve();
      tx.onerror = () => reject(tx.error);
    });
    db.close();
  });
  const offline = (route: import("@playwright/test").Route) => route.abort();
  await page.route("**/api/**", offline);
  await page.reload();
  await expect(page.getByRole("alert")).toContainText("Завершение не подтверждено");
  await expect(page.getByRole("button", { name: "Начать перевод" })).toHaveCount(0);
  const retry = page.getByRole("button", { name: "Повторить проверку" });
  await page.setViewportSize({ width: 320, height: 700 });
  await page.emulateMedia({ reducedMotion: "reduce" });
  expect(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth)).toBe(true);
  expect((await retry.boundingBox())?.height).toBeGreaterThanOrEqual(44);
  await retry.focus();
  await page.keyboard.press("Enter");
  await expect(page.getByRole("alert")).toContainText("Завершение не подтверждено");
  await page.unroute("**/api/**", offline);
  const end = page.getByRole("button", { name: "Завершить сохранённый разговор" });
  expect(await retry.evaluate(button => getComputedStyle(button).backgroundColor)).toBe("rgb(244, 234, 213)");
  expect(await end.evaluate(button => getComputedStyle(button).borderColor)).toBe("rgb(122, 46, 31)");
  const before = { retry: await retry.boundingBox(), end: await end.boundingBox() };
  let release!: () => void;
  const gate = new Promise<void>(resolve => { release = resolve; });
  let started!: () => void;
  const requestStarted = new Promise<void>(resolve => { started = resolve; });
  await page.route("**/api/conversations/recovery/end", async route => {
    started();
    await gate;
    await route.fulfill({ contentType: "application/json", body: JSON.stringify({ status: "ended" }) });
  });
  await retry.click();
  await requestStarted;
  await expect(retry).toBeDisabled();
  await expect(end).toBeDisabled();
  expect(await retry.boundingBox()).toEqual(before.retry);
  expect(await end.boundingBox()).toEqual(before.end);
  release();
  await expect(page.getByRole("button", { name: "Начать перевод" })).toBeVisible();
  await expect(page.getByRole("button", { name: "Начать перевод" })).toBeFocused();
});
