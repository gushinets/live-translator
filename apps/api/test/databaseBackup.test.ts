import { randomUUID } from "node:crypto";
import { mkdtempSync, readFileSync, rmSync, statSync, writeFileSync } from "node:fs";
import { join } from "node:path";
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
    expect(verifyUsageDatabase(backupPath)).toEqual({ integrity: "ok", foreignKeyViolations: 0 });
    expect(verifyUsageDatabase(restoredPath)).toEqual({ integrity: "ok", foreignKeyViolations: 0 });
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
    expect(verifyUsageDatabase(sourcePath)).toEqual({ integrity: "ok", foreignKeyViolations: 0 });
  });
});
