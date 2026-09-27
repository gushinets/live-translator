import { randomUUID } from "node:crypto";
import { spawn } from "node:child_process";
import { DatabaseSync } from "node:sqlite";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, rmSync, statSync, writeFileSync } from "node:fs";
import { basename, dirname, join } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import { tmpdir } from "node:os";
import { afterEach, describe, expect, it, vi } from "vitest";
import { UsageLedger } from "../src/accounting/UsageLedger.js";
import { LedgerRuntime } from "../src/accounting/LedgerRuntime.js";
import { DEFAULT_LEDGER_POLICY } from "../src/accounting/types.js";
import { usageReportSchema } from "../src/accounting/mergeUsage.js";
import { openUsageDatabase } from "../src/persistence/database.js";
import { backupUsageDatabase, restoreUsageDatabase, SqliteMaintenanceError, verifyUsageDatabase } from "../src/persistence/sqliteBackup.js";
import { buildUnitEconomicsReport } from "../src/reports/unitEconomics.js";

const directories: string[] = [];
const databases: ReturnType<typeof openUsageDatabase>[] = [];
afterEach(() => {
  for (const db of databases.splice(0)) if (db.isOpen) db.close();
  for (const directory of directories.splice(0)) rmSync(directory, { recursive: true, force: true });
});
const temporaryDirectory = () => {
  const directory = mkdtempSync(join(tmpdir(), "live-translator-sqlite-"));
  directories.push(directory);
  return directory;
};

function maintenanceChild(source: string, target: string, mode: string, operation = "backup", extra: Record<string, string> = {}) {
  const root = fileURLToPath(new URL("../../..", import.meta.url));
  const loader = fileURLToPath(new URL("../node_modules/tsx/dist/loader.mjs", import.meta.url));
  const hook = fileURLToPath(new URL("./helpers/sqliteMaintenanceProcessHook.mjs", import.meta.url));
  const entry = fileURLToPath(new URL("./helpers/sqliteMaintenanceProcessChild.mjs", import.meta.url));
  const env = Object.fromEntries(Object.entries(process.env).filter(([name]) =>
    ["PATH", "Path", "SystemRoot", "WINDIR", "TEMP", "TMP"].includes(name)));
  return spawn(process.execPath, ["--import", pathToFileURL(loader).href, "--import", pathToFileURL(hook).href, entry], {
    cwd: root, stdio: ["pipe", "pipe", "pipe"],
    env: { ...env, ...extra, LT_SQLITE_TEST_BOUNDARY: mode, LT_SQLITE_TEST_OPERATION: operation, LT_SQLITE_TEST_SOURCE: source, LT_SQLITE_TEST_TARGET: target },
  });
}

function nextJsonLine(child: ReturnType<typeof spawn>): Promise<Record<string, unknown>> {
  return new Promise((resolve, reject) => {
    let output = "";
    const timer = setTimeout(() => { cleanup(); reject(new Error("maintenance child boundary timeout")); }, 10000);
    const onData = (chunk: Buffer) => {
      output += chunk.toString("utf8");
      const newline = output.indexOf("\n");
      if (newline < 0) return;
      cleanup();
      try { resolve(JSON.parse(output.slice(0, newline)) as Record<string, unknown>); }
      catch { reject(new Error("maintenance child emitted an invalid boundary")); }
    };
    const onExit = (code: number | null, signal: NodeJS.Signals | null) => {
      cleanup();
      reject(new Error("maintenance child exited before boundary: " + code + "/" + signal));
    };
    const cleanup = () => {
      clearTimeout(timer);
      child.stdout!.off("data", onData);
      child.off("exit", onExit);
    };
    child.stdout!.on("data", onData);
    child.once("exit", onExit);
  });
}

function childExit(child: ReturnType<typeof spawn>): Promise<[number | null, NodeJS.Signals | null]> {
  return new Promise(resolve => child.once("exit", (code, signal) => resolve([code, signal])));
}
function terminateOwnedChild(child: ReturnType<typeof spawn>): Promise<[number | null, NodeJS.Signals | null]> {
  return new Promise((resolve, reject) => {
    if (child.exitCode !== null || child.signalCode !== null) { resolve([child.exitCode, child.signalCode]); return; }
    const timer = setTimeout(() => reject(new Error("owned maintenance child did not exit")), 5000);
    child.once("exit", (code, signal) => { clearTimeout(timer); resolve([code, signal]); });
    if (child.exitCode === null && child.signalCode === null) child.kill("SIGKILL");
  });
}

describe("SQLite backup and restore", () => {
  it("backs up WAL data and restores identities, usage, cleanup, resume, and report state", async () => {
    const directory = temporaryDirectory(), sourcePath = join(directory, "source.sqlite");
    const sourceDb = openUsageDatabase(sourcePath); databases.push(sourceDb);
    const now = Date.UTC(2026, 8, 25), owner = randomUUID();
    const ledger = new UsageLedger(sourceDb, { now: () => now, policy: { ...DEFAULT_LEDGER_POLICY, sessionHandoffAckTimeoutMs: 120000 } });
    const conversation = () => ledger.createConversation(owner, randomUUID(), "synthetic-backup-v1");
    const start = (id: string, conversationId: string, version: number, reason: "initial" | "resume" = "initial") => {
      ledger.registerAttempt(owner, { liveSessionId: id, conversationId, conversationVersion: version,
        initialMode: "setup", startReason: reason, fingerprint: `synthetic-${id}`, usageIdentityVersion: 1 });
      ledger.dispatchProviderAttempt(owner, id, version, `lease-${id}`, now + 900000);
      ledger.recordProviderCreated(id, `provider-${id}`);
      ledger.acknowledgeHandoff(owner, id);
    };
    const report = (id: string, conversationId: string, value: Record<string, unknown>) =>
      ledger.recordUsage(owner, id, conversationId, usageReportSchema.parse({ schemaVersion: 1, ...value }));

    const lateConversation = conversation(), lateId = randomUUID();
    start(lateId, lateConversation.id, lateConversation.version);
    report(lateId, lateConversation.id, { checkpointSeconds: 105 });
    const ended = ledger.endConversation(owner, lateConversation.id, lateConversation.version, "user_end");

    const conflictConversation = conversation(), conflictId = randomUUID();
    start(conflictId, conflictConversation.id, conflictConversation.version);
    report(conflictId, conflictConversation.id, { providerClosed: { seconds: 90 }, conflictingProviderClosed: { seconds: 88 } });

    const resumeConversation = conversation();
    const paused = ledger.pauseConversation(owner, resumeConversation.id, resumeConversation.version);
    const resumeId = randomUUID();
    const claim = ledger.claimResume(owner, resumeConversation.id, paused.version, resumeId, "setup", 1);
    start(resumeId, resumeConversation.id, claim.conversation.version, "resume");

    const options = { from: now - 86400000, to: now + 86400000, asOf: now, generatedAt: now, dataClass: "synthetic" as const };
    const before = buildUnitEconomicsReport(sourceDb, options);
    expect(statSync(`${sourcePath}-wal`).size).toBeGreaterThan(0);
    const backupPath = join(directory, "backup.sqlite"), restoredPath = join(directory, "restored", "restored.sqlite");
    expect(await backupUsageDatabase(sourcePath, backupPath)).toMatchObject({ integrity: "ok", foreignKeyViolations: 0 });
    expect(await restoreUsageDatabase(backupPath, restoredPath)).toMatchObject({ integrity: "ok", foreignKeyViolations: 0 });

    const backupDb = openUsageDatabase(backupPath); databases.push(backupDb);
    const restoredReadDb = openUsageDatabase(restoredPath); databases.push(restoredReadDb);
    expect(buildUnitEconomicsReport(backupDb, options)).toEqual(before);
    expect(buildUnitEconomicsReport(restoredReadDb, options)).toEqual(before);
    expect(verifyUsageDatabase(backupPath)).toEqual({ integrity: "ok", foreignKeyViolations: 0, ledgerSchema: "compatible" });
    expect(verifyUsageDatabase(restoredPath)).toEqual({ integrity: "ok", foreignKeyViolations: 0, ledgerSchema: "compatible" });
    const identity = (db: typeof sourceDb) => db.prepare(`SELECT usage_identity_version,provider_checkpoint_seconds,provider_final_seconds,
      usage_conflict,cleanup_requested_at,resume_outcome FROM live_sessions ORDER BY id`).all();
    expect(identity(backupDb)).toEqual(identity(sourceDb));
    expect(identity(restoredReadDb)).toEqual(identity(sourceDb));
    for (const db of [sourceDb, backupDb, restoredReadDb]) {
      expect(db.prepare("PRAGMA foreign_key_check").all()).toEqual([]);
      expect(db.prepare("SELECT usage_identity_version FROM live_sessions WHERE id=?").get(lateId)).toMatchObject({ usage_identity_version: 1 });
    }
    backupDb.close(); restoredReadDb.close();

    const restoredDb = openUsageDatabase(restoredPath); databases.push(restoredDb);
    const restoredLedger = new UsageLedger(restoredDb, { now: () => now });
    const creator = vi.fn();
    new LedgerRuntime(restoredLedger, { creator, closeOrphan: vi.fn(async () => ({ kind: "terminal_not_live" as const })), startWorker: false });
    expect(restoredLedger.getAttemptInternal(resumeId)).toMatchObject({ resume_outcome: "pending", cleanup_requested_at: null });
    expect(restoredLedger.reservations().some(row => row.id === resumeId)).toBe(true);
    expect(creator).not.toHaveBeenCalled();

    const foreignConversation = restoredLedger.createConversation(owner, randomUUID(), "synthetic-foreign-v1");
    expect(() => restoredLedger.recordUsage(owner, lateId, foreignConversation.id,
      usageReportSchema.parse({ schemaVersion: 1, providerClosed: { seconds: 120 } }))).toThrow("not_found");
    restoredLedger.recordUsage(owner, lateId, lateConversation.id,
      usageReportSchema.parse({ schemaVersion: 1, providerClosed: { seconds: 120 } }));
    expect(restoredDb.prepare("SELECT status,end_reason,ended_at FROM conversations WHERE id=?").get(lateConversation.id))
      .toEqual({ status: "ended", end_reason: "user_end", ended_at: ended.ended_at });
    const afterLateFinal = buildUnitEconomicsReport(restoredDb, options);
    expect(afterLateFinal.usage.finalSeconds).toBe(120);
    expect(afterLateFinal.usage.partialCheckpointSeconds).toBe(0);
    expect(afterLateFinal.usage.conflictCount).toBe(1);
    expect(restoredLedger.getAttemptInternal(lateId)).toMatchObject({ provider_checkpoint_seconds: 105, provider_final_seconds: 120,
      usage_identity_version: 1, cleanup_reason: "user_end" });
    expect(creator).not.toHaveBeenCalled();
  });

  it("refuses overwrite and leaves source untouched on a controlled destination write failure", async () => {
    const directory = temporaryDirectory(), sourcePath = join(directory, "source.sqlite"), targetPath = join(directory, "existing.sqlite");
    const db = openUsageDatabase(sourcePath); databases.push(db);
    const original = "leave this target intact";
    writeFileSync(targetPath, original);
    await expect(backupUsageDatabase(sourcePath, targetPath)).rejects.toMatchObject({ code: "target_exists" });
    expect(readFileSync(targetPath, "utf8")).toBe(original);
    await expect(restoreUsageDatabase(sourcePath, sourcePath)).rejects.toMatchObject({ code: "same_path" });

    const blockedParent = join(directory, "not-a-directory");
    writeFileSync(blockedParent, "controlled write failure");
    await expect(backupUsageDatabase(sourcePath, join(blockedParent, "backup.sqlite")))
      .rejects.toBeInstanceOf(SqliteMaintenanceError);
    await expect(restoreUsageDatabase(sourcePath, join(blockedParent, "restored.sqlite")))
      .rejects.toBeInstanceOf(SqliteMaintenanceError);
    expect(verifyUsageDatabase(sourcePath)).toEqual({ integrity: "ok", foreignKeyViolations: 0, ledgerSchema: "compatible" });
  });
  it("accepts supported ledger schemas and rejects empty, unrelated, incomplete and future databases", () => {
    const directory = temporaryDirectory();
    const migrations = ["001-usage-ledger.sql", "002-live-session-recovery-fences.sql"];
    const createLedger = (name: string, version: number) => {
      const path = join(directory, name), db = new DatabaseSync(path);
      for (const migration of migrations.slice(0, version)) {
        db.exec(readFileSync(new URL("../src/persistence/migrations/" + migration, import.meta.url), "utf8"));
      }
      db.exec("PRAGMA user_version=" + version);
      db.close();
      return path;
    };
    const expectError = (path: string, code: string) => {
      try { verifyUsageDatabase(path); throw new Error("expected verification to fail"); }
      catch (error) { expect(error).toMatchObject({ code }); }
    };

    const zero = join(directory, "zero.sqlite");
    writeFileSync(zero, "");
    expectError(zero, "ledger_schema_invalid");

    const uninitialized = join(directory, "uninitialized.sqlite");
    let db = new DatabaseSync(uninitialized);
    db.exec("CREATE TABLE placeholder(id INTEGER)");
    db.close();
    expectError(uninitialized, "ledger_schema_invalid");

    const unrelated = join(directory, "unrelated.sqlite");
    db = new DatabaseSync(unrelated);
    db.exec("CREATE TABLE unrelated(id INTEGER PRIMARY KEY, payload TEXT)");
    db.close();
    expectError(unrelated, "ledger_schema_invalid");

    const missingField = join(directory, "missing-field.sqlite");
    db = new DatabaseSync(missingField);
    db.exec("CREATE TABLE conversations(id TEXT, created_at INTEGER); CREATE TABLE live_sessions(id TEXT); CREATE TABLE live_session_recovery_fences(id TEXT); PRAGMA user_version=2");
    db.close();
    expectError(missingField, "ledger_schema_invalid");

    const legacyV1 = createLedger("legacy-v1.sqlite", 1);
    expect(verifyUsageDatabase(legacyV1)).toMatchObject({ integrity: "ok", foreignKeyViolations: 0 });
    db = new DatabaseSync(legacyV1);
    expect(db.prepare("PRAGMA user_version").get()!.user_version).toBe(1);
    db.close();

    const legacyV2 = createLedger("legacy-v2.sqlite", 2);
    expect(verifyUsageDatabase(legacyV2)).toMatchObject({ integrity: "ok", foreignKeyViolations: 0 });

    const incompleteV3 = createLedger("incomplete-v3.sqlite", 2);
    db = new DatabaseSync(incompleteV3);
    db.exec("PRAGMA user_version=3");
    db.close();
    expectError(incompleteV3, "ledger_schema_invalid");

    const legacyV3 = createLedger("legacy-v3.sqlite", 2);
    db = new DatabaseSync(legacyV3);
    db.exec(readFileSync(new URL("../src/persistence/migrations/003-usage-identity.sql", import.meta.url), "utf8"));
    db.exec("PRAGMA user_version=3");
    db.close();
    expect(verifyUsageDatabase(legacyV3)).toMatchObject({ integrity: "ok", foreignKeyViolations: 0, ledgerSchema: "compatible" });
    db = new DatabaseSync(legacyV3);
    expect(db.prepare("PRAGMA user_version").get()!.user_version).toBe(3);
    db.close();

    const future = createLedger("future.sqlite", 2);
    db = new DatabaseSync(future);
    db.exec("PRAGMA user_version=4");
    db.close();
    expectError(future, "ledger_schema_unsupported");

    const emptyLedger = join(directory, "empty-ledger.sqlite");
    db = openUsageDatabase(emptyLedger);
    expect(db.prepare("SELECT count(*) AS count FROM conversations").get()!.count).toBe(0);
    db.close();
    expect(verifyUsageDatabase(emptyLedger)).toMatchObject({ integrity: "ok", foreignKeyViolations: 0 });
  });

  it.each(["backup", "restore"])("does not expose a partial target when the process is stopped during %s", async operation => {
    const directory = temporaryDirectory(), source = join(directory, "source.sqlite"), target = join(directory, "backup.sqlite");
    const db = openUsageDatabase(source);
    db.close();
    const child = maintenanceChild(source, target, "during_copy", operation);
    let boundary: Record<string, unknown> | undefined;
    try {
      boundary = await nextJsonLine(child);
      expect(boundary.pid).toBe(child.pid);
      expect(existsSync(target)).toBe(false);
    } finally {
      await terminateOwnedChild(child);
    }
    expect(existsSync(target)).toBe(false);
    expect(boundary?.boundary).toBe("copy_in_progress");
    expect(Number(boundary?.pagesCopied)).toBeGreaterThan(0);
    expect(Number(boundary?.remainingPages)).toBeGreaterThan(0);
    expect(basename(dirname(String(boundary?.path))).startsWith(".live-translator-sqlite-maintenance-")).toBe(true);
    expect(existsSync(String(boundary?.path))).toBe(true);
  });

  it("keeps an interrupted verified staging copy private and permits a safe retry", async () => {
    const directory = temporaryDirectory(), source = join(directory, "source.sqlite"), target = join(directory, "backup.sqlite");
    openUsageDatabase(source).close();
    const child = maintenanceChild(source, target, "before_publish");
    let boundary: Record<string, unknown> | undefined;
    try {
      boundary = await nextJsonLine(child);
      expect(boundary.boundary).toBe("before_publish");
      expect(existsSync(target)).toBe(false);
      expect(String(boundary.path).endsWith(".sqlite")).toBe(true);
      expect(verifyUsageDatabase(String(boundary.path))).toMatchObject({ integrity: "ok", ledgerSchema: "compatible" });
    } finally {
      await terminateOwnedChild(child);
    }
    expect(existsSync(target)).toBe(false);
    const interruptedStage = dirname(String(boundary?.path));
    await expect(backupUsageDatabase(source, target)).resolves.toMatchObject({ integrity: "ok", stagingCleanup: "complete" });
    expect(verifyUsageDatabase(target)).toMatchObject({ integrity: "ok", ledgerSchema: "compatible" });
    expect(existsSync(interruptedStage)).toBe(true);
  });

  it("leaves a valid published target when stopped during staging cleanup", async () => {
    const directory = temporaryDirectory(), source = join(directory, "source.sqlite"), target = join(directory, "backup.sqlite");
    const sourceDb = openUsageDatabase(source), conversationId = new UsageLedger(sourceDb).createConversation(randomUUID(), randomUUID(), "synthetic").id;
    sourceDb.close();
    const child = maintenanceChild(source, target, "after_publish");
    try {
      const boundary = await nextJsonLine(child);
      expect(boundary.boundary).toBe("after_publish");
      expect(existsSync(target)).toBe(true);
      expect(verifyUsageDatabase(target)).toMatchObject({ integrity: "ok", ledgerSchema: "compatible" });
    } finally {
      await terminateOwnedChild(child);
    }
    expect(verifyUsageDatabase(target)).toMatchObject({ integrity: "ok", ledgerSchema: "compatible" });
    const restored = new DatabaseSync(target, { readOnly: true });
    expect(restored.prepare("SELECT id FROM conversations").get()!.id).toBe(conversationId);
    restored.close();
  });

  it("does not overwrite a target created at the atomic publication boundary", async () => {
    const directory = temporaryDirectory(), source = join(directory, "source.sqlite"), target = join(directory, "backup.sqlite");
    openUsageDatabase(source).close();
    const child = maintenanceChild(source, target, "race_before_publish", "backup",
      { LT_SQLITE_TEST_SENTINEL: "pre-existing target" });
    const exited = childExit(child);
    const output = await nextJsonLine(child);
    const [code] = await exited;
    expect(output).toEqual({ error: "target_exists" });
    expect(code).toBe(2);
    expect(readFileSync(target, "utf8")).toBe("pre-existing target");
  });

  it("fails explicitly when atomic hard-link publication is unavailable", async () => {
    const directory = temporaryDirectory(), source = join(directory, "source.sqlite"), target = join(directory, "backup.sqlite");
    openUsageDatabase(source).close();
    const child = maintenanceChild(source, target, "unsupported_publish");
    const exited = childExit(child);
    const output = await nextJsonLine(child);
    const [code] = await exited;
    expect(output).toEqual({ error: "publication_unsupported" });
    expect(code).toBe(2);
    expect(existsSync(target)).toBe(false);
    expect(readdirSync(directory).some(name => name.startsWith(".live-translator-sqlite-maintenance-"))).toBe(false);
  });
  it("returns success with pending cleanup when its private staging directory cannot be removed", async () => {
    const directory = temporaryDirectory(), source = join(directory, "source.sqlite"), target = join(directory, "backup.sqlite");
    openUsageDatabase(source).close();
    const child = maintenanceChild(source, target, "cleanup_error");
    const exited = childExit(child);
    const output = await nextJsonLine(child);
    const [code] = await exited;
    expect(code).toBe(0);
    expect(output.result).toMatchObject({ integrity: "ok", stagingCleanup: "pending" });
    expect(verifyUsageDatabase(target)).toMatchObject({ integrity: "ok", ledgerSchema: "compatible" });
    expect(readdirSync(directory).some(name => name.startsWith(".live-translator-sqlite-maintenance-"))).toBe(true);
  });

  it("cleans only its own failed verification stage and allows a valid retry", async () => {
    const directory = temporaryDirectory(), invalid = join(directory, "unrelated.sqlite"), source = join(directory, "source.sqlite"), target = join(directory, "backup.sqlite");
    const db = new DatabaseSync(invalid);
    db.exec("CREATE TABLE unrelated(id INTEGER PRIMARY KEY)");
    db.close();
    const unrelatedStage = join(directory, ".live-translator-sqlite-maintenance-foreign");
    mkdirSync(unrelatedStage);
    writeFileSync(join(unrelatedStage, "keep.txt"), "keep");
    await expect(backupUsageDatabase(invalid, target)).rejects.toMatchObject({ code: "ledger_schema_invalid" });
    expect(existsSync(target)).toBe(false);
    expect(readFileSync(join(unrelatedStage, "keep.txt"), "utf8")).toBe("keep");
    openUsageDatabase(source).close();
    await expect(backupUsageDatabase(source, target)).resolves.toMatchObject({ integrity: "ok" });
    expect(verifyUsageDatabase(target)).toMatchObject({ integrity: "ok", ledgerSchema: "compatible" });
  });

  it("allows only one concurrent operation to publish the same target", async () => {
    const directory = temporaryDirectory(), source = join(directory, "source.sqlite"), target = join(directory, "backup.sqlite");
    openUsageDatabase(source).close();
    const results = await Promise.allSettled([backupUsageDatabase(source, target), restoreUsageDatabase(source, target)]);
    expect(results.filter(result => result.status === "fulfilled")).toHaveLength(1);
    expect(results.filter(result => result.status === "rejected")).toHaveLength(1);
    expect(results.find(result => result.status === "rejected")).toMatchObject({ reason: { code: "target_exists" } });
    expect(verifyUsageDatabase(target)).toMatchObject({ integrity: "ok", ledgerSchema: "compatible" });
  });
});
