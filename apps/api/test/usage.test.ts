import { randomUUID } from "node:crypto";
import request from "supertest";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { createApp } from "../src/app.js";
import { UsageLedger } from "../src/accounting/UsageLedger.js";
import { openUsageDatabase } from "../src/persistence/database.js";

const origin = "http://localhost:5173";
const databases: ReturnType<typeof openUsageDatabase>[] = [];
beforeEach(() => vi.stubEnv("OPENAI_API_KEY", "fake-key"));
afterEach(() => { vi.unstubAllEnvs(); databases.splice(0).forEach(db => db.close()); });
async function fixture() {
  const db = openUsageDatabase(":memory:"); databases.push(db);
  const ledger = new UsageLedger(db);
  const provider = vi.fn(async () => ({ session: { id: randomUUID() }, transport: { type: "webrtc" as const, sdp: "answer" } }));
  const app = createApp({ ledger, createLiveSession: provider, startWorker: false });
  const agent = request.agent(app);
  const c = (await agent.post("/api/conversations").set("Origin", origin).send({ createRequestId: randomUUID(), appVersion: "usage-test" }).expect(201)).body;
  const id = randomUUID();
  await agent.post("/api/live/session").set("Origin", origin).send({ sdp: "offer", conversationId: c.conversationId, conversationVersion: c.version, liveSessionId: id, initialMode: "setup", startReason: "initial" }).expect(201);
  const put = (body: object) => agent.put(`/api/live/session/${id}/usage`).set("Origin", origin).send({ conversationId: c.conversationId, schemaVersion: 1, ...body });
  return { db, ledger, provider, app, agent, c, id, put, row: () => ledger.getAttemptInternal(id) };
}
const totals = (activityReportSeq: number, extra = {}) => ({
  activityReportSeq, measurementVersion: "active-time-v1", observedWallMs: 120000,
  setupMs: 60000, activeInterpreterMs: 60000, visiblePausedMs: 0,
  acceptedSourceSpeechMs: 30000, completedSourceSpeechMs: 20000,
  speechMeasurementVersion: "vam-pre-tail-v1", speechMeasurementStatus: "complete",
  appMetricsFinalized: true, counters: { audioCompletedTurnCount: 1, textOnlyCompletedTurnCount: 0, failedTurnCount: 0, discardedTurnCount: 0 }, ...extra,
});

describe("cumulative usage ingestion", () => {
  it("requires the attempt's conversation identity before mutating usage", async () => {
    const f = await fixture();
    const foreign = (await f.agent.post("/api/conversations").set("Origin", origin)
      .send({ createRequestId: randomUUID(), appVersion: "usage-test" }).expect(201)).body;
    await f.agent.put(`/api/live/session/${f.id}/usage`).set("Origin", origin)
      .send({ schemaVersion: 1, checkpointSeconds: 33 }).expect(400);
    await f.agent.put(`/api/live/session/${f.id}/usage`).set("Origin", origin)
      .send({ conversationId: foreign.conversationId, schemaVersion: 1, checkpointSeconds: 33 }).expect(404);
    expect(f.row().provider_checkpoint_seconds).toBeNull();
  });
  it("A3.1 keeps checkpoints and final separate, never sums snapshots", async () => {
    const f = await fixture();
    for (const checkpointSeconds of [15, 28, 15, 43]) await f.put({ checkpointSeconds }).expect(200);
    await f.put({ providerClosed: { seconds: 46 } }).expect(200);
    await f.put({ providerClosed: { seconds: 46 } }).expect(200);
    expect(f.row()).toMatchObject({ provider_checkpoint_seconds: 43, provider_final_seconds: 46, provider_checkpoint_source: "browser", provider_final_source: "browser", usage_quality: "final" });
    expect(f.provider).toHaveBeenCalledTimes(1);
  });
  it("A3.2 preserves estimate and independent close/numeric provenance including conflicts", async () => {
    const f = await fixture();
    f.db.prepare("UPDATE live_sessions SET estimated_total_seconds=90,estimate_method_version='test-estimate',estimate_as_of=1 WHERE id=?").run(f.id);
    await f.put({ providerClosed: { seconds: 74, reason: "browser_reason" } }).expect(200);
    f.ledger.recordProviderClosed(f.id, {}, "sideband");
    expect(f.row()).toMatchObject({ estimated_total_seconds: 90, provider_final_seconds: 74, provider_final_source: "browser", close_confirmation_source: "sideband", provider_close_reason_source: "browser" });
    f.ledger.recordProviderClosed(f.id, { seconds: 74 }, "sideband");
    await f.put({ providerClosed: { seconds: 75 } }).expect(200);
    expect(f.row()).toMatchObject({ provider_final_seconds: 74, provider_final_source: "sideband", usage_quality: "conflict" });
    expect(JSON.parse(f.row().usage_conflict_details!)).toMatchObject({ numeric: { existing: 74, existingSource: "sideband", incoming: 75, incomingSource: "browser" } });
  });
  it("A3.4 invalid seconds do not lose confirmed close or manufacture final zero", async () => {
    const f = await fixture();
    await f.put({ providerClosed: { seconds: -2, reason: "ended" } }).expect(200);
    expect(f.row()).toMatchObject({ close_confirmed: 1, state: "closed", provider_final_seconds: null, usage_quality: "unknown" });
    expect(f.row().lease_released_at).not.toBeNull();
  });
  it("A3.5 old app seq cannot suppress a late provider final or roll counters back", async () => {
    const f = await fixture();
    await f.put({ checkpointSeconds: 43, app: totals(2) }).expect(200);
    await f.put({ providerClosed: { seconds: 46 }, app: totals(1, { activeInterpreterMs: 1000 }) }).expect(200);
    expect(f.db.prepare("SELECT activity_report_seq,active_interpreter_ms FROM live_sessions WHERE id=?").get(f.id)).toMatchObject({ activity_report_seq: 2, active_interpreter_ms: 60000 });
    expect(f.row().provider_final_seconds).toBe(46);
  });
  it("rejects regressive/new-version app data without losing valid provider fields", async () => {
    const f = await fixture();
    await f.put({ app: totals(1, { appMetricsFinalized: false }) }).expect(200);
    const res = await f.put({ providerClosed: { seconds: 120 }, app: totals(2, { activeInterpreterMs: 1000 }) }).expect(200);
    expect(res.body.appAccepted).toBe(false);
    expect(f.row().provider_final_seconds).toBe(120);
    expect(f.db.prepare("SELECT active_interpreter_ms FROM live_sessions WHERE id=?").get(f.id)!.active_interpreter_ms).toBe(60000);
  });
  it("A3.10 validates ownership, origin and strict metadata/provenance allowlists", async () => {
    const f = await fixture();
    await request(f.app).put(`/api/live/session/${f.id}/usage`).set("Origin", origin).send({ schemaVersion: 1, checkpointSeconds: 3 }).expect(401);
    const other = request.agent(f.app);
    await other.post("/api/conversations").set("Origin", origin).send({ createRequestId: randomUUID(), appVersion: "other" }).expect(201);
    await other.put(`/api/live/session/${f.id}/usage`).set("Origin", origin).send({ conversationId: f.c.conversationId, schemaVersion: 1, checkpointSeconds: 3 }).expect(404);
    await f.agent.put(`/api/live/session/${f.id}/usage`).send({ schemaVersion: 1, checkpointSeconds: 3 }).expect(403);
    for (const extra of [{ source: "sideband" }, { transcript: "secret" }, { openaiSessionId: "spoofed" }]) await f.put({ checkpointSeconds: 3, ...extra }).expect(400);
    const invalidApp = await f.put({ app: { ...totals(1), counters: { transcript: "secret" } } }).expect(200);
    expect(invalidApp.body).toMatchObject({ appAccepted: false, appRejection: "invalid_app_metrics" });
    expect(f.row().provider_checkpoint_seconds).toBeNull();
    expect(f.row().activity_report_seq).toBeNull();
  });
  it("commits provider and app metadata atomically before ACK; retry is safe", async () => {
    const f = await fixture(), exec = f.db.exec.bind(f.db);
    const spy = vi.spyOn(f.db, "exec").mockImplementation(sql => { if (sql === "COMMIT") throw new Error("simulated fsync failure"); return exec(sql); });
    await f.put({ checkpointSeconds: 43, app: totals(1) }).expect(503);
    spy.mockRestore();
    expect(f.row().provider_checkpoint_seconds).toBeNull();
    await f.put({ checkpointSeconds: 43, app: totals(1) }).expect(200);
    expect(f.row().provider_checkpoint_seconds).toBe(43);
  });
});

describe("G1 conversation summary", () => {
  it("reports the three duration denominators from one complete conversation", async () => {
    const f = await fixture(); await f.put({ providerClosed: { seconds: 120 }, app: totals(1) }).expect(200);
    const response = await f.agent.get(`/api/conversations/${f.c.conversationId}`).expect(200);
    expect(response.body.summary).toMatchObject({ summaryVersion: 1,
      attempts: { total: 1, dispatched: 1, notDispatched: 0 },
      usage: { finalSeconds: 120, partialSeconds: 0, totalProviderSeconds: 120, unknownCount: 0, conflictCount: 0 },
      durations: { activeInterpreterMs: 60000, acceptedSourceSpeechMs: 30000, completedSourceSpeechMs: 20000 },
      ratios: { providerSecondsPerActiveMinute: 120, providerSecondsPerAcceptedSpeechMinute: 240, providerSecondsPerCompletedSpeechMinute: 360 },
      providerSecondsByPhase: null,
    });
    expect(JSON.stringify(response.body)).not.toMatch(/anonymous_user_id|request_fingerprint|"sdp"|"transcript"|fake-key/);
  });
  it("preserves partial/unknown/conflict accounting and never presents unavailable metrics as zero", async () => {
    const f = await fixture(); await f.put({ checkpointSeconds: 43 }).expect(200);
    const partial = (await f.agent.get(`/api/conversations/${f.c.conversationId}`).expect(200)).body.summary;
    expect(partial).toMatchObject({ usage: { finalSeconds: 0, partialSeconds: 43, totalProviderSeconds: null, partialCount: 1 },
      durations: { activeInterpreterMs: null }, ratios: { providerSecondsPerActiveMinute: null } });
    await f.put({ providerClosed: { seconds: 46 }, conflictingProviderClosed: { seconds: 45 } }).expect(200);
    expect((await f.agent.get(`/api/conversations/${f.c.conversationId}`)).body.summary.usage).toMatchObject({ conflictCount: 1, totalProviderSeconds: null });
  });
  it("returns NULL ratios for measured silence or incomplete speech coverage", async () => {
    const f = await fixture(); await f.put({ providerClosed: { seconds: 120 }, app: totals(1, { activeInterpreterMs: 0, acceptedSourceSpeechMs: 0, completedSourceSpeechMs: 0, speechMeasurementStatus: "partial" }) }).expect(200);
    expect((await f.agent.get(`/api/conversations/${f.c.conversationId}`)).body.summary.ratios).toEqual({ providerSecondsPerActiveMinute: null, providerSecondsPerAcceptedSpeechMinute: null, providerSecondsPerCompletedSpeechMinute: null });
  });
  it("does not double-count active time or mix exact phase costs across multiple attempts", async () => {
    const f = await fixture(); await f.put({ providerClosed: { seconds: 120 }, app: totals(1) }).expect(200);
    const id2 = randomUUID();
    await f.agent.post("/api/live/session").set("Origin", origin).send({ sdp: "second", conversationId: f.c.conversationId, conversationVersion: f.c.version, liveSessionId: id2, initialMode: "setup", startReason: "bootstrap_replacement" }).expect(201);
    await f.agent.put(`/api/live/session/${id2}/usage`).set("Origin", origin).send({ conversationId: f.c.conversationId, schemaVersion: 1, providerClosed: { seconds: 120 }, app: totals(1) }).expect(200);
    const summary = (await f.agent.get(`/api/conversations/${f.c.conversationId}`)).body.summary;
    expect(summary).toMatchObject({ attempts: { total: 2, dispatched: 2 }, usage: { totalProviderSeconds: 240 }, durations: { activeInterpreterMs: 120000 }, ratios: { providerSecondsPerActiveMinute: 120 } });
  });
});

it("rejects an unsupported measurement version independently from a valid final", async () => {
  const f = await fixture();
  const result = await f.put({ providerClosed: { seconds: 46 }, app: totals(1, { measurementVersion: "active-time-v2" }) }).expect(200);
  expect(result.body.appAccepted).toBe(false); expect(f.row().provider_final_seconds).toBe(46);
  expect(f.row().activity_report_seq).toBeNull();
});

it("rejects malformed app metrics independently from a valid final", async () => {
  const f = await fixture();
  const result = await f.put({ providerClosed: { seconds: 46 }, app: { activityReportSeq: 1 } }).expect(200);
  expect(result.body).toMatchObject({ appAccepted: false, appRejection: "invalid_app_metrics" });
  expect(f.row()).toMatchObject({ provider_final_seconds: 46, activity_report_seq: null });
});

it("updates checkpoint provenance only for the max value or an equal stronger observation", async () => {
  const f = await fixture(); const owner = String(f.db.prepare("SELECT anonymous_user_id FROM conversations WHERE id=?").get(f.c.conversationId)!.anonymous_user_id);
  f.ledger.recordUsage(owner, f.id, f.c.conversationId, { schemaVersion: 1, checkpointSeconds: 28 }, "sideband");
  await f.put({ checkpointSeconds: 43 }).expect(200);
  expect(f.row().provider_checkpoint_source).toBe("browser");
  f.ledger.recordUsage(owner, f.id, f.c.conversationId, { schemaVersion: 1, checkpointSeconds: 28 }, "sideband");
  expect(f.row().provider_checkpoint_source).toBe("browser");
  f.ledger.recordUsage(owner, f.id, f.c.conversationId, { schemaVersion: 1, checkpointSeconds: 43 }, "sideband");
  expect(f.row().provider_checkpoint_source).toBe("sideband");
});
