import { expect, test, type Page, type Route } from "@playwright/test";
import { MockLiveHarness } from "./mockLiveHarness";
import type { DiagnosticEvent } from "../../../../types/diagnostics.js";
import { diagnosticBatchSchema, parseDiagnosticEvent } from "../../../api/src/diagnostics/schema";

async function pendingDiagnostics(page: Page) {
  return page.evaluate(async () => {
    const db = await new Promise<IDBDatabase>((resolve, reject) => {
      const request = indexedDB.open("live-translator-diagnostics-v1");
      request.onsuccess = () => resolve(request.result); request.onerror = () => reject(request.error);
    });
    try {
      return await new Promise<Array<{ key: string; text?: string }>>((resolve, reject) => {
        const tx = db.transaction("events"), request = tx.objectStore("events").getAll();
        tx.oncomplete = () => resolve((request.result as Array<{ key: string; event: { text?: string } }>).map(({ key, event }) => ({ key, text: event.text })));
        tx.onerror = () => reject(tx.error);
      });
    } finally { db.close(); }
  });
}

for (const { textEnabled, locksAvailable } of [
  { textEnabled: false, locksAvailable: true }, { textEnabled: true, locksAvailable: true }, { textEnabled: true, locksAvailable: false },
]) test(`diagnostic timeline survives delivery outage and records rendered sides, text=${textEnabled}, locks=${locksAvailable}`, async ({ page }) => {
  const harness = await MockLiveHarness.attach(page);
  if (!locksAvailable) await page.addInitScript(() => Object.defineProperty(navigator, "locks", { value: undefined }));
  if (textEnabled) await page.addInitScript(() => sessionStorage.setItem("liveTranslatorDiagnosticText", crypto.randomUUID()));
  const now = new Date("2026-09-14T00:00:00.000Z").getTime();
  const conversationId = "c3d6cfbf-3977-4ba1-8458-bfa1f7af878c";
  const conversation = { conversationId, version: 1, status: "active", serverTime: now, productDeadlineAt: now + 900000,
    resumeAttemptId: null, resumeExpiresAt: null, policy: { sessionCloseTimeoutMs: 15000, policyVersion: "test", backgroundSessionCloseEnabled: false } };
  const attempts = new Map<string, Record<string, unknown>>(), received: DiagnosticEvent[] = [];
  const revokedTextKeys = new Set<string>();
  const optedInCanary = "ConsentRestoredCanary 8841";
  let blocked = true, policyTextEnabled = textEnabled;
  const handleApi = async (route: Route) => {
    const path = new URL(route.request().url()).pathname, body = route.request().postDataJSON() as Record<string, unknown> | null;
    const reply = (value: unknown, status = 200) => route.fulfill({ status, contentType: "application/json", body: JSON.stringify(value) });
    if (path === "/api/policy") return reply({ usageLedgerEnabled: true, backgroundSessionCloseEnabled: false, diagnostics: { enabled: true, textEnabled: policyTextEnabled, schemaVersion: 1 } });
    if (path.endsWith("/diagnostics")) {
      if (blocked) return reply({ code: "simulated_outage" }, 503);
      const events = body!.events as DiagnosticEvent[];
      if (!policyTextEnabled && events.some(event => event.text !== undefined)) return reply({ code: "diagnostics_text_not_allowed" }, 400);
      for (const event of diagnosticBatchSchema.parse(body).events) parseDiagnosticEvent(event, policyTextEnabled);
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
  };
  await page.route("**/api/**", handleApi);
  await harness.startListeningConversation();
  if (!locksAvailable) await page.evaluate(() => sessionStorage.setItem("liveTranslatorDiagnosticText", crypto.randomUUID()));
  await harness.sourceActive();
  await harness.inputDelta("Please show me the railway station.", 0, 1000);
  await harness.outputDelta("Por favor, muéstreme la estación.", 500, 1500);
  await harness.sourceQuiet();
  await expect(page.getByTestId("participant-pane-B")).toContainText("Por favor, muéstreme la estación.");
  await harness.advance(6000);
  expect(received).toHaveLength(0);
  if (!locksAvailable) {
    await expect.poll(async () => (await pendingDiagnostics(page)).some(row => row.text === "Please show me the railway station.")).toBe(true);
    const pending = await pendingDiagnostics(page), textKeys = pending.filter(row => row.text !== undefined).map(row => row.key);
    const producer = await page.evaluate(() => sessionStorage.getItem("live-translator-client-instance-v1"));
    await page.reload();
    await expect.poll(() => page.evaluate(() => sessionStorage.getItem("live-translator-client-instance-v1"))).not.toBe(producer);
    expect(await page.evaluate(() => sessionStorage.getItem("liveTranslatorDiagnosticText"))).toBeNull();
    await page.evaluate(() => sessionStorage.setItem("liveTranslatorDiagnosticText", crypto.randomUUID()));
    blocked = false;
    await expect.poll(async () => {
      await harness.advance(4000);
      await page.evaluate(() => window.dispatchEvent(new Event("online")));
      const delivered = new Set(received.map(event => `${event.streamId}:${event.seq}`));
      return pending.every(({ key }) => delivered.has(key));
    }).toBe(true);
    expect(received.every(event => event.text === undefined)).toBe(true);
    expect(textKeys.every(key => received.some(event => `${event.streamId}:${event.seq}` === key && event.textRemoved))).toBe(true);
    expect(JSON.stringify(await pendingDiagnostics(page))).not.toMatch(/Please show me|Por favor/);
    expect(attempts.size).toBe(1);
    return;
  }
  if (textEnabled) {
    const idle = await page.context().newPage(); let idleRequests = 0;
    await idle.clock.install({ time: new Date(now) }); await idle.clock.pauseAt(new Date(now + 1000));
    await idle.route("**/api/**", route => {
      if (new URL(route.request().url()).pathname.endsWith("/diagnostics")) idleRequests++;
      return handleApi(route);
    });
    await idle.goto("/");
    expect(await idle.evaluate(() => sessionStorage.getItem("liveTranslatorDiagnosticText"))).toBeNull();
    await expect.poll(async () => { await idle.clock.fastForward(4000); return idleRequests; }).toBeGreaterThan(0);
    await expect.poll(async () => (await pendingDiagnostics(page)).some(row => row.text === "Please show me the railway station.")).toBe(true);
    for (const row of await pendingDiagnostics(page)) if (row.text !== undefined) revokedTextKeys.add(row.key);
    await page.evaluate(() => {
      sessionStorage.removeItem("liveTranslatorDiagnosticText");
      sessionStorage.setItem("liveTranslatorDiagnosticText", crypto.randomUUID());
    });
    blocked = false;
    // The browser clock is context-wide; reload the peer to initiate replay without advancing it.
    await idle.reload();
    await expect.poll(async () => {
      await idle.evaluate(() => window.dispatchEvent(new Event("online")));
      return received.length;
    }).toBeGreaterThan(0);
    expect(received.every(event => event.text === undefined)).toBe(true);
    blocked = true;
    expect(attempts.size).toBe(1); await idle.close();
    await harness.inputDelta(optedInCanary, 1100, 1200);
  }
  blocked = false;
  // Browser time is paused by the harness; advance retries explicitly, preserving IDB/network tasks.
  await expect.poll(async () => {
    await harness.advance(4000);
    await page.evaluate(() => window.dispatchEvent(new Event("online")));
    return received.some(event => event.type === "caption.render") && received.some(event => event.type === "app.snapshot") &&
      received.some(event => event.type === "transport.stats") &&
      received.some(event => event.type === "transcript.fragment" && event.data.kind === "input") &&
      received.some(event => event.type === "caption.block" && event.data.kind === "output" && event.data.side === "B") &&
      (!textEnabled || received.some(event => event.text === optedInCanary) &&
        [...revokedTextKeys].every(key => received.some(event => `${event.streamId}:${event.seq}` === key && event.textRemoved)));
  }).toBe(true);
  expect(received.filter(event => revokedTextKeys.has(`${event.streamId}:${event.seq}`)).every(event => event.text === undefined)).toBe(true);
  expect(received.some(event => event.type === "transcript.fragment" && event.data.kind === "input")).toBe(true);
  expect(received.some(event => event.type === "caption.block" && event.data.kind === "output" && event.data.side === "B")).toBe(true);
  expect(received.some(event => event.type === "app.snapshot")).toBe(true);
  expect(received.some(event => event.type === "transport.stats" && !event.data.available && event.data.totalSamplesReceived === null)).toBe(true);
  const serialized = JSON.stringify(received);
  expect(serialized).not.toMatch(/fake-answer|fake-offer|OWNER_CONTEXT|I speak English/);
  if (textEnabled) expect(serialized).toContain(optedInCanary);
  else expect(serialized).not.toMatch(/Please show me|Por favor/);
  if (textEnabled) {
    policyTextEnabled = false;
    const canary = "PolicyChangedCanary 4815";
    await harness.sourceActive(); await harness.inputDelta(canary, 3000, 4000); await harness.sourceQuiet();
    await expect.poll(async () => {
      await harness.advance(4000);
      return received.some(event => event.type === "transcript.fragment" && event.data.charCount === canary.length);
    }).toBe(true);
    expect(received.filter(event => event.type === "transcript.fragment" && event.data.charCount === canary.length)).toEqual([
      expect.not.objectContaining({ text: canary }),
    ]);
    expect(JSON.stringify(await pendingDiagnostics(page))).not.toContain(canary);
  }
  blocked = true;
  await page.getByRole("button", { name: "End", exact: true }).click();
  await expect(page.getByRole("button", { name: "Back to start", exact: true })).toBeVisible();
  const pending = await pendingDiagnostics(page);
  expect(pending.length).toBeGreaterThan(0);
  const creates = attempts.size;
  blocked = false;
  await page.reload();
  await expect.poll(async () => {
    await harness.advance(4000);
    const delivered = new Set(received.map(event => `${event.streamId}:${event.seq}`));
    return pending.every(({ key }) => delivered.has(key));
  }).toBe(true);
  expect(attempts.size).toBe(creates);
});
