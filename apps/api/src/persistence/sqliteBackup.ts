import { closeSync, mkdirSync, openSync, unlinkSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { backup, DatabaseSync } from "node:sqlite";

export class SqliteMaintenanceError extends Error {
  constructor(readonly code: "same_path" | "source_unavailable" | "target_exists" | "backup_failed" | "restore_failed" | "integrity_failed" | "foreign_key_failed") {
    super(code);
    this.name = "SqliteMaintenanceError";
  }
}

function samePath(left: string, right: string): boolean {
  const a = resolve(left), b = resolve(right);
  return process.platform === "win32" ? a.toLowerCase() === b.toLowerCase() : a === b;
}

function createTarget(path: string, failureCode: "backup_failed" | "restore_failed"): void {
  try {
    mkdirSync(dirname(resolve(path)), { recursive: true, mode: 0o700 });
    closeSync(openSync(path, "wx", 0o600));
  } catch (error) {
    if (error && typeof error === "object" && "code" in error && error.code === "EEXIST") throw new SqliteMaintenanceError("target_exists");
    throw new SqliteMaintenanceError(failureCode);
  }
}

export function verifyUsageDatabase(path: string): { integrity: "ok"; foreignKeyViolations: 0 } {
  let db: DatabaseSync;
  try { db = new DatabaseSync(path, { readOnly: true, timeout: 1000 }); }
  catch { throw new SqliteMaintenanceError("source_unavailable"); }
  try {
    const integrity = db.prepare("PRAGMA integrity_check").all() as unknown as { integrity_check: string }[];
    if (integrity.length !== 1 || integrity[0]?.integrity_check !== "ok") throw new SqliteMaintenanceError("integrity_failed");
    if (db.prepare("PRAGMA foreign_key_check").all().length) throw new SqliteMaintenanceError("foreign_key_failed");
    return { integrity: "ok", foreignKeyViolations: 0 };
  } catch (error) {
    if (error instanceof SqliteMaintenanceError) throw error;
    throw new SqliteMaintenanceError("source_unavailable");
  } finally { db.close(); }
}

/** Uses SQLite's online backup API so committed WAL pages are included in one coherent snapshot. */
export async function backupUsageDatabase(source: string, target: string): Promise<{ pages: number; integrity: "ok"; foreignKeyViolations: 0 }> {
  if (samePath(source, target)) throw new SqliteMaintenanceError("same_path");
  let sourceDb: DatabaseSync;
  try { sourceDb = new DatabaseSync(source, { readOnly: true, timeout: 1000 }); }
  catch { throw new SqliteMaintenanceError("source_unavailable"); }
  let created = false;
  try {
    createTarget(target, "backup_failed"); created = true;
    const pages = await backup(sourceDb, target);
    const verified = verifyUsageDatabase(target);
    return { pages, ...verified };
  } catch (error) {
    if (created) { try { unlinkSync(target); } catch { /* Retain the original maintenance failure. */ } }
    if (error instanceof SqliteMaintenanceError) throw error;
    throw new SqliteMaintenanceError("backup_failed");
  } finally { sourceDb.close(); }
}

/** Restores a coherent SQLite snapshot to a new path; existing targets are never replaced. */
export async function restoreUsageDatabase(source: string, target: string): Promise<{ pages: number; integrity: "ok"; foreignKeyViolations: 0 }> {
  if (samePath(source, target)) throw new SqliteMaintenanceError("same_path");
  let sourceDb: DatabaseSync;
  try { sourceDb = new DatabaseSync(source, { readOnly: true, timeout: 1000 }); }
  catch { throw new SqliteMaintenanceError("source_unavailable"); }
  let created = false;
  try {
    createTarget(target, "restore_failed"); created = true;
    const pages = await backup(sourceDb, target);
    return { pages, ...verifyUsageDatabase(target) };
  } catch (error) {
    if (created) { try { unlinkSync(target); } catch { /* Retain the original maintenance failure. */ } }
    if (error instanceof SqliteMaintenanceError) throw error;
    if (error && typeof error === "object" && "code" in error && error.code === "EEXIST") throw new SqliteMaintenanceError("target_exists");
    throw new SqliteMaintenanceError("restore_failed");
  } finally { sourceDb.close(); }
}
