import { expect, test } from "@playwright/test";
import { MockLiveHarness } from "./mockLiveHarness";

/** Real browser/IndexedDB pipeline; provider and HTTP persistence are stand-ins (SQL is tested by API integration tests). */
test("ledger-enabled browser retains final metadata across an HTTP outage without leaking dialogue content", async ({ page }) => {
  const harness = await MockLiveHarness.attach(page);
  const now = new Date("2026-09-14T00:00:00.000Z").getTime();
  const conversationId = "c3d6cfbf-3977-4ba1-8458-bfa1f7af878c";
  const conversation = { conversationId, version: 1, status: "active", serverTime: now, productDeadlineAt: now + 900000, policy: { sessionCloseTimeoutMs: 15000 } };
  const attempts = new Map<string, Record<string, unknown>>();
  const received: Array<{ id: string; body: Record<string, unknown> }> = [];
  let blockUsage = true;
  await page.route("**/api/**", async route => {
    const path = new URL(route.request().url()).pathname, method = route.request().method();
    const body = method === "GET" ? {} : route.request().postDataJSON() as Record<string, unknown>;
    const json = (value: unknown, status = 200) => route.fulfill({ status, contentType: "application/json", body: JSON.stringify(value) });
    if (path === "/api/policy") return json({ usageLedgerEnabled: true });
    if (path === "/api/conversations" || path.startsWith("/api/conversations/")) return json(conversation, method === "POST" && path === "/api/conversations" ? 201 : 200);
    if (path === "/api/live/session") {
      const id = String(body.liveSessionId);
      expect(body.conversationId).toBe(conversationId);
      attempts.set(id, { liveSessionId: id, state: "creating", conversation, handoffAcknowledgedAt: null, cleanupRequestedAt: null, openaiSessionId: "sess_e2e" });
      return json({ session: { id: "sess_e2e" }, transport: { type: "webrtc", sdp: "v=0 fake-answer" } }, 201);
    }
    const match = path.match(/^\/api\/live\/session\/([^/]+)(?:\/(handoff|cleanup|closed|usage))?$/);
    if (!match) return json({ code: "not_found" }, 404);
    const id = match[1], action = match[2], row = attempts.get(id);
    if (!row) return json({ code: "not_found" }, 404);
    if (action === "usage") {
      if (blockUsage) return json({ code: "simulated_outage" }, 503);
      received.push({ id, body });
      const app = body.app as { activityReportSeq: number; appMetricsFinalized: boolean } | undefined;
      return json({ schemaVersion: 1, appAccepted: true, activityReportSeq: app?.activityReportSeq ?? null, appMetricsFinalized: app?.appMetricsFinalized ?? false });
    }
    if (action === "handoff") Object.assign(row, { state: "active", handoffAcknowledgedAt: now });
    if (action === "cleanup") Object.assign(row, { state: "unknown", cleanupRequestedAt: now });
    if (action === "closed") Object.assign(row, { state: "closed", closeConfirmed: true });
    return json(row);
  });
  await harness.startListeningConversation();
  const id = [...attempts.keys()].at(-1)!;
  await harness.inputDelta("Private English sentence that must never enter usage metadata.");
  await page.evaluate(() => {
    window.__liveTranslatorTestLive!.emit({ type: "session.usage.updated", usage: { seconds: 43 } });
    window.__liveTranslatorTestLive!.emit({ type: "session.usage.updated", usage: { seconds: 15 } });
  });
  await harness.sessionClosed("user_requested", 46);
  await expect.poll(() => attempts.get(id)?.state).toBe("closed");
  await page.waitForFunction(async localId => {
    const db = await new Promise<IDBDatabase>((resolve, reject) => { const r = indexedDB.open("live-translator-metadata-v1", 1); r.onsuccess = () => resolve(r.result); r.onerror = reject; });
    try { return await new Promise<boolean>((resolve, reject) => { const tx = db.transaction("envelopes"), r = tx.objectStore("envelopes").get(localId); r.onsuccess = () => resolve(r.result?.usage?.report?.providerClosed?.seconds === 46); r.onerror = reject; }); }
    finally { db.close(); }
  }, id);
  blockUsage = false;
  await page.evaluate(() => window.dispatchEvent(new Event("online")));
  await expect.poll(() => received.some(item => item.id === id && (item.body.providerClosed as { seconds?: number } | undefined)?.seconds === 46)).toBe(true);
  const final = received.find(item => item.id === id && item.body.providerClosed)!;
  expect(final.body).toMatchObject({ checkpointSeconds: 43, providerClosed: { seconds: 46 }, app: { appMetricsFinalized: true } });
  expect(JSON.stringify(received)).not.toMatch(/Private English sentence|fake-answer|transcript|contextText|"source":"sideband"/);
});
