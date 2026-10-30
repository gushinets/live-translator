import { expect, test } from "@playwright/test";
import { MockLiveHarness, completeLanguageSetup } from "./mockLiveHarness";

test("identifies the loaded production bundle before provider creation without changing the create body", async ({ page }) => {
  await MockLiveHarness.attach(page);
  const conversationId = "e6b68212-f44f-4f2a-9b91-b451757779ae";
  let observed: { build: string | undefined; body: Record<string, unknown> } | undefined;
  await page.route("**/api/**", async route => {
    const path = new URL(route.request().url()).pathname;
    const json = (body: unknown, status = 200) => route.fulfill({ status, contentType: "application/json", body: JSON.stringify(body) });
    if (path === "/api/policy") return json({ usageLedgerEnabled: true, backgroundSessionCloseEnabled: false });
    if (path === "/api/conversations") return json({ conversationId, version: 1, status: "active",
      productDeadlineAt: null, resumeExpiresAt: null, resumeAttemptId: null, serverTime: Date.now(),
      policy: { policyVersion: "test", backgroundSessionCloseEnabled: false, conversationRetentionMs: 300000,
        maxProviderSessionMs: 900000, maxConversationElapsedMs: 900000, sessionCloseTimeoutMs: 100,
        sessionHandoffAckTimeoutMs: 30000, resumeClaimTimeoutMs: 60000 } }, 201);
    if (path === "/api/live/session") {
      observed = { build: route.request().headers()["x-live-translator-build"], body: route.request().postDataJSON() };
      return json({ code: "invalid_request" }, 400);
    }
    return json({});
  });
  await page.goto("/");
  const loadedBundle = await page.locator('script[type="module"][src]').first().getAttribute("src");
  await completeLanguageSetup(page);
  await expect.poll(() => observed).toBeDefined();
  expect(observed!.build).toBe(`bundle:${loadedBundle!.split("/").at(-1)}`);
  expect(observed!.body).not.toHaveProperty("clientMetadata");
  expect(observed!.body).not.toHaveProperty("clientBuildId");
  expect(observed!.body).toMatchObject({ conversationId, usageIdentityVersion: 1 });
});
