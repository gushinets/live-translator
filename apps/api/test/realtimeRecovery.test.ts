import { existsSync, mkdtempSync, rmSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { randomUUID } from "node:crypto";
import { once } from "node:events";
import { DatabaseSync } from "node:sqlite";
import request from "supertest";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { createApp } from "../src/app.js";
import type { RealtimeAttempts } from "../src/accounting/RealtimeAttempts.js";
import { backupUsageDatabase, restoreUsageDatabase, verifyUsageDatabase } from "../src/persistence/sqliteBackup.js";

const apps: ReturnType<typeof createApp>[] = [], runtimes: RealtimeAttempts[] = [];
const origin = "http://localhost:5173";
let directory: string;
beforeEach(() => {
  directory = mkdtempSync(join(tmpdir(), "realtime-recovery-"));
  vi.resetModules();
  for (const [name, value] of Object.entries({ NODE_ENV: "test", WEB_ORIGIN: origin, OPENAI_API_KEY: "mock-key",
    USAGE_LEDGER_ENABLED: "false", BACKGROUND_SESSION_CLOSE_ENABLED: "false", MAX_CONCURRENT_SESSIONS: "1",
    USAGE_DB_PATH: join(directory, "ledger.sqlite"), REALTIME_DB_PATH: join(directory, "pilot.sqlite"),
    SESSION_HANDOFF_ACK_TIMEOUT_MS: "10000" })) vi.stubEnv(name, value);
});
afterEach(async () => {
  for (const a of apps.splice(0)) {
    await a.locals.ledgerRuntime?.shutdown({ drainMs: 0, timeoutMs: 1000 });
    await a.locals.realtimeRuntime?.shutdown();
    if (a.locals.realtimeRuntime?.db.isOpen) a.locals.realtimeRuntime.db.close();
    if (a.locals.ledgerRuntime?.ledger.db.isOpen) a.locals.ledgerRuntime.ledger.db.close();
  }
  for (const r of runtimes.splice(0)) { await r.shutdown(); if (r.db.isOpen) r.db.close(); }
  rmSync(directory, { recursive: true, force: true }); vi.restoreAllMocks(); vi.unstubAllEnvs();
});
async function app(ledgerEnabled: boolean, close = vi.fn(async (): Promise<void> => { throw new Error("hangup unavailable"); })) {
  const { createApp } = await import("../src/app.js");
  const a = createApp({ ledgerEnabled, realtimeEnabled: true, startWorker: false,
    createRealtimeCall: async () => ({ callId: "rtc_recovered", sdp: "answer" }), closeRealtimeCall: close,
    closeOrphan: async () => ({ kind: "retryable_error", code: "mock" }) }); apps.push(a); return a;
}
async function create(a: ReturnType<typeof createApp>) {
  const id = randomUUID(), identity = await request(a).post("/api/realtime/identity").set("Origin", origin).send({ attemptId: id, generation: 1 }).expect(201);
  const cookie = identity.headers["set-cookie"]![0]!.split(";")[0]!;
  await request(a).post("/api/realtime/session").set("Origin", origin).set("Cookie", cookie)
    .send({ attemptId: id, generation: 1, admissionToken: identity.body.admissionToken, sdp: "offer", languages: { A: "ru", B: "en" } }).expect(201);
  return { id, cookie };
}
async function stop(a: ReturnType<typeof createApp>) {
  await a.locals.ledgerRuntime?.shutdown({ drainMs: 0, timeoutMs: 1000 }); await a.locals.realtimeRuntime.shutdown();
  if (a.locals.realtimeRuntime.db.isOpen) a.locals.realtimeRuntime.db.close();
  if (a.locals.ledgerRuntime?.ledger.db.isOpen) a.locals.ledgerRuntime.ledger.db.close();
}
describe("Realtime persistence across ledger modes and handoff timing", () => {
  it.each([false, true])("preserves ledger maintenance after actual API startup (pilot=%s)", async (pilot) => {
    const { createApp } = await import("../src/app.js");
    const a = createApp({ ledgerEnabled: true, realtimeEnabled: pilot, startWorker: false,
      createRealtimeCall: async () => ({ callId: "rtc_backup", sdp: "answer" }), closeRealtimeCall: async () => {} }); apps.push(a);
    const ledger = a.locals.ledgerRuntime.ledger;
    expect(a.locals.realtimeRuntime.db).toBe(ledger.db);
    expect(existsSync(join(directory, "pilot.sqlite"))).toBe(false);
    const conversation = ledger.createConversation(randomUUID(), randomUUID(), "backup-regression");
    if (pilot) {
      const { id } = await create(a), r = a.locals.realtimeRuntime as RealtimeAttempts;
      const owner = String(r.db.prepare("SELECT owner FROM realtime_attempts WHERE id=?").get(id)!.owner);
      r.recordUsage(owner, id, { operation: "response", responseId: "saved", usage: { total_tokens: 3 } });
    }
    const source = join(directory, "ledger.sqlite"), backup = join(directory, "backup.sqlite"), restored = join(directory, "restored.sqlite");
    expect(verifyUsageDatabase(source)).toMatchObject({ ledgerSchema: "compatible" });
    await expect(backupUsageDatabase(source, backup)).resolves.toMatchObject({ integrity: "ok" });
    await expect(restoreUsageDatabase(backup, restored)).resolves.toMatchObject({ integrity: "ok" });
    for (const path of [backup, restored]) {
      expect(verifyUsageDatabase(path)).toMatchObject({ ledgerSchema: "compatible" });
      const db = new DatabaseSync(path, { readOnly: true });
      try {
        expect(db.prepare("SELECT * FROM conversations WHERE id=?").get(conversation.id))
          .toEqual(ledger.db.prepare("SELECT * FROM conversations WHERE id=?").get(conversation.id));
        for (const table of ["realtime_attempts", "realtime_response_usage", "realtime_usage"]) {
          expect(db.prepare(`SELECT * FROM ${table} ORDER BY 1`).all()).toEqual(ledger.db.prepare(`SELECT * FROM ${table} ORDER BY 1`).all());
        }
      } finally { db.close(); }
    }
  });
  it.each(["DROP TABLE realtime_usage", "ALTER TABLE realtime_attempts ADD COLUMN unexpected TEXT"])(
    "rejects incompatible Realtime schema instead of ignoring it (%s)", async (sql) => {
      const a = await app(true); a.locals.ledgerRuntime.ledger.db.exec(sql);
      const source = join(directory, "ledger.sqlite"), target = join(directory, "invalid-backup.sqlite");
      expect(() => verifyUsageDatabase(source)).toThrow("ledger_schema_invalid");
      await expect(backupUsageDatabase(source, target)).rejects.toMatchObject({ code: "ledger_schema_invalid" });
      expect(existsSync(target)).toBe(false);
    });
  it("retains standalone attempts, usage and shared admission on a false-to-true ledger restart", async () => {
    const first = await app(false), { id, cookie } = await create(first);
    await request(first).put(`/api/realtime/session/${id}/usage`).set("Origin", origin).set("Cookie", cookie)
      .send({ operation: "response", responseId: "saved", usage: { total_tokens: 3, input_tokens: 2, output_tokens: 1 } }).expect(204);
    await stop(first);
    const close = vi.fn(async (): Promise<void> => { throw new Error("still unavailable"); }), second = await app(true, close);
    const realtime = second.locals.realtimeRuntime as RealtimeAttempts;
    expect(realtime.db).not.toBe(second.locals.ledgerRuntime.ledger.db);
    expect(second.locals.ledgerRuntime.registry.activeLeases).toBe(1);
    expect(realtime.db.prepare("SELECT call_id,close_confirmed FROM realtime_attempts WHERE id=?").get(id))
      .toMatchObject({ call_id: "rtc_recovered", close_confirmed: 0 });
    expect(realtime.db.prepare("SELECT usage_json FROM realtime_usage WHERE attempt_id=?").get(id)!.usage_json)
      .toBe('{"total_tokens":3,"input_tokens":2,"output_tokens":1}');
    await request(second).post("/api/realtime/identity").set("Origin", origin).set("Cookie", cookie).send({ attemptId: randomUUID(), generation: 2 }).expect(409);
    expect(second.locals.ledgerRuntime.registry.acquire()).toBeNull();
    const pending = await request(second).post(`/api/realtime/session/${id}/cleanup`).set("Origin", origin).set("Cookie", cookie).send({}).expect(200);
    expect(pending.body.closeConfirmed).toBe(false); expect(second.locals.ledgerRuntime.registry.activeLeases).toBe(1);
    close.mockResolvedValue(undefined);
    await request(second).post(`/api/realtime/session/${id}/cleanup`).set("Origin", origin).set("Cookie", cookie).send({}).expect(200);
    expect(second.locals.ledgerRuntime.registry.activeLeases).toBe(0);
    const fresh = await request(second).post("/api/realtime/identity").set("Origin", origin).set("Cookie", cookie).send({ attemptId: randomUUID(), generation: 2 }).expect(201);
    expect(fresh.body.admissionToken).toEqual(expect.any(String));
    const { startApiServer } = await import("../src/serverLifecycle.js");
    const lifecycle = startApiServer(second, { port: 0, host: "127.0.0.1", drainMs: 0, timeoutMs: 1000 });
    await once(lifecycle.server, "listening"); await lifecycle.shutdown();
    expect(realtime.db.isOpen).toBe(false); expect(second.locals.ledgerRuntime.ledger.db.isOpen).toBe(false);
  });
  it("retains the existing shared database and cleanup after disabling the ledger flag", async () => {
    const first = await app(true), { id, cookie } = await create(first); await stop(first);
    const second = await app(false);
    expect(second.locals.realtimeRuntime.db).toBe(second.locals.ledgerRuntime.ledger.db);
    expect((await request(second).get("/api/policy")).body.creationPaused).toBe(true);
    const cleaned = await request(second).post(`/api/realtime/session/${id}/cleanup`).set("Origin", origin).set("Cookie", cookie).send({}).expect(200);
    expect(cleaned.body.closeConfirmed).toBe(false);
  });
  it("fails closed when both stores contain attempts rather than hiding either store", async () => {
    const first = await app(false); await create(first); await stop(first);
    const { openUsageDatabase } = await import("../src/persistence/database.js");
    const { RealtimeAttempts } = await import("../src/accounting/RealtimeAttempts.js");
    const { SessionLeaseRegistry } = await import("../src/security/SessionLeaseRegistry.js");
    const existing = new RealtimeAttempts(openUsageDatabase(join(directory, "ledger.sqlite")), new SessionLeaseRegistry(1, 1000), { startWorker: false });
    runtimes.push(existing); existing.prepare(randomUUID(), randomUUID(), 1); await existing.shutdown(); existing.db.close();
    await expect(app(true)).rejects.toThrow("Realtime records exist in both databases");
    for (const file of ["ledger.sqlite", "pilot.sqlite"]) {
      const db = new DatabaseSync(join(directory, file), { readOnly: true });
      try { expect(db.prepare("SELECT COUNT(*) AS n FROM realtime_attempts").get()!.n).toBe(1); }
      finally { db.close(); }
    }
  });
  it("uses one shared handle when Realtime and usage paths name the same database", async () => {
    vi.stubEnv("REALTIME_DB_PATH", join(directory, "ledger.sqlite"));
    const a = await app(true); expect(a.locals.realtimeRuntime.db).toBe(a.locals.ledgerRuntime.ledger.db);
    await create(a);
  });
  it("does not hide existing ledger records behind an empty standalone file", async () => {
    const first = await app(true), { id, cookie } = await create(first); await stop(first);
    new DatabaseSync(join(directory, "pilot.sqlite")).close();
    const second = await app(true);
    expect(second.locals.realtimeRuntime.db).toBe(second.locals.ledgerRuntime.ledger.db);
    expect(second.locals.ledgerRuntime.registry.activeLeases).toBe(1);
    await request(second).post(`/api/realtime/session/${id}/cleanup`).set("Origin", origin).set("Cookie", cookie).send({}).expect(200);
  });
  it.each([true, false])("starts the full handoff grace after slow creation (acknowledged=%s)", async (acknowledged) => {
    const { RealtimeAttempts, openRealtimeDatabase } = await import("../src/accounting/RealtimeAttempts.js");
    const { SessionLeaseRegistry } = await import("../src/security/SessionLeaseRegistry.js");
    let now = Date.now(); const close = vi.fn(async () => {});
    const r = new RealtimeAttempts(openRealtimeDatabase(":memory:"), new SessionLeaseRegistry(1, 900000), {
      startWorker: false, now: () => now, close, create: async () => { now += 12000; return { callId: "rtc_slow", sdp: "answer" }; } }); runtimes.push(r);
    const owner = randomUUID(), id = randomUUID(), token = r.prepare(owner, id, 1).admissionToken;
    now += 6000; await r.create(owner, id, 1, "offer", () => false, token);
    await r.sweep(); expect(close).not.toHaveBeenCalled();
    now += 9999; await r.sweep(); expect(close).not.toHaveBeenCalled();
    if (acknowledged) r.handoff(owner, id);
    now += 1; await r.sweep();
    expect(close).toHaveBeenCalledTimes(acknowledged ? 0 : 1);
    expect(r.owned(owner, id).state).toBe(acknowledged ? "active" : "closed");
  });
});
