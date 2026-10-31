import { expect, test } from "@playwright/test";
import { MockLiveHarness } from "./mockLiveHarness";
import type { DiagnosticEvent } from "../../../../types/diagnostics.js";
import { diagnosticBatchSchema, parseDiagnosticEvent } from "../../../api/src/diagnostics/schema";

for (const textEnabled of [false, true]) test(`diagnostic timeline survives delivery outage and records rendered sides, text=${textEnabled}`, async ({ page }) => {
  const harness = await MockLiveHarness.attach(page);
  if (textEnabled) await page.addInitScript(() => sessionStorage.setItem("liveTranslatorDiagnosticText", "1"));
  const now = new Date("2026-09-14T00:00:00.000Z").getTime();
  const conversationId = "c3d6cfbf-3977-4ba1-8458-bfa1f7af878c";
  const conversation = { conversationId, version: 1, status: "active", serverTime: now, productDeadlineAt: now + 900000,
    resumeAttemptId: null, resumeExpiresAt: null, policy: { sessionCloseTimeoutMs: 15000, policyVersion: "test", backgroundSessionCloseEnabled: false } };
  const attempts = new Map<string, Record<string, unknown>>(), received: DiagnosticEvent[] = [];
  let blocked = true;
  await page.route("**/api/**", async route => {
    const path = new URL(route.request().url()).pathname, body = route.request().postDataJSON() as Record<string, unknown> | null;
    const reply = (value: unknown, status = 200) => route.fulfill({ status, contentType: "application/json", body: JSON.stringify(value) });
    if (path === "/api/policy") return reply({ usageLedgerEnabled: true, backgroundSessionCloseEnabled: false, diagnostics: { enabled: true, textEnabled, schemaVersion: 1 } });
    if (path.endsWith("/diagnostics")) {
      if (blocked) return reply({ code: "simulated_outage" }, 503);
      const events = body!.events as DiagnosticEvent[];
      for (const event of diagnosticBatchSchema.parse(body).events) parseDiagnosticEvent(event, textEnabled);
      received.push(...events);
      expect(new TextEncoder().encode(JSON.stringify(body)).byteLength).toBeLessThanOrEqual(32768);
      expect(events.every(event => event.conversationId === conversationId && attempts.has(event.liveSessionId!))).toBe(true);
      return reply({ schemaVersion: 1, serverTime: now, accepted: events.map(({ streamId, seq }) => ({ streamId, seq })) });
    }
    if (path === "/api/conversations") return reply(conversation, 201);
    if (path.startsWith("/api/conversations/")) {
      if (path.endsWith("/end")) Object.assign(conversation, { status: "ended", version: conversation.version + 1 });
      return reply(conversation);
    }
    if (path === "/api/live/session") {
      const id = String(body!.liveSessionId);
      attempts.set(id, { liveSessionId: id, state: "creating", conversation, handoffAcknowledgedAt: null, cleanupRequestedAt: null });
      return reply({ session: { id: "sess_e2e" }, transport: { type: "webrtc", sdp: "v=0 fake-answer" } }, 201);
    }
    const match = path.match(/^\/api\/live\/session\/([^/]+)(?:\/(handoff|cleanup|closed|usage))?$/);
    const row = match ? attempts.get(match[1]!) : undefined;
    if (!row) return reply({ code: "not_found" }, 404);
    if (match![2] === "handoff") Object.assign(row, { state: "active", handoffAcknowledgedAt: now });
    if (match![2] === "cleanup") Object.assign(row, { state: "unknown", cleanupRequestedAt: now });
    if (match![2] === "closed") Object.assign(row, { state: "closed", closeConfirmed: true });
    if (match![2] === "usage") {
      const app = body!.app as { activityReportSeq?: number; appMetricsFinalized?: boolean } | undefined;
      return reply({ schemaVersion: 1, appAccepted: true, activityReportSeq: app?.activityReportSeq ?? null, appMetricsFinalized: app?.appMetricsFinalized ?? false });
    }
    return reply(row);
  });
  await harness.startListeningConversation();
  await harness.sourceActive();
  await harness.inputDelta("Please show me the railway station.", 0, 1000);
  await harness.outputDelta("Por favor, muéstreme la estación.", 500, 1500);
  await harness.sourceQuiet();
  await expect(page.getByTestId("participant-pane-B")).toContainText("Por favor, muéstreme la estación.");
  await harness.advance(6000);
  expect(received).toHaveLength(0);
  blocked = false;
  // Browser time is paused by the harness; advance retries explicitly, preserving IDB/network tasks.
  await expect.poll(async () => {
    await harness.advance(4000);
    await page.evaluate(() => window.dispatchEvent(new Event("online")));
    return received.some(event => event.type === "caption.render") && received.some(event => event.type === "app.snapshot") &&
      received.some(event => event.type === "transport.stats");
  }).toBe(true);
  expect(received.some(event => event.type === "transcript.fragment" && event.data.kind === "input")).toBe(true);
  expect(received.some(event => event.type === "caption.block" && event.data.kind === "output" && event.data.side === "B")).toBe(true);
  expect(received.some(event => event.type === "app.snapshot")).toBe(true);
  expect(received.some(event => event.type === "transport.stats" && !event.data.available && event.data.totalSamplesReceived === null)).toBe(true);
  const serialized = JSON.stringify(received);
  expect(serialized).not.toMatch(/fake-answer|fake-offer|OWNER_CONTEXT|I speak English/);
  if (textEnabled) expect(serialized).toContain("Please show me the railway station.");
  else expect(serialized).not.toMatch(/Please show me|Por favor/);
  await page.getByRole("button", { name: "End", exact: true }).click();
  await expect(page.getByRole("button", { name: "Back to start", exact: true })).toBeVisible();
});
