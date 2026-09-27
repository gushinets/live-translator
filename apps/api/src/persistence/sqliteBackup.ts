import { chmodSync, linkSync, mkdirSync, mkdtempSync, readFileSync, rmSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { backup, DatabaseSync } from "node:sqlite";

type FailureCode = "backup_failed" | "restore_failed";
type VerificationResult = { integrity: "ok"; foreignKeyViolations: 0; ledgerSchema: "compatible" };
type MaintenanceResult = VerificationResult & { pages: number; stagingCleanup: "complete" | "pending" };

export class SqliteMaintenanceError extends Error {
  constructor(readonly code: "same_path" | "source_unavailable" | "target_exists" | "publication_unsupported" |
    "backup_failed" | "restore_failed" | "integrity_failed" | "foreign_key_failed" |
    "ledger_schema_invalid" | "ledger_schema_unsupported") {
    super(code);
    this.name = "SqliteMaintenanceError";
  }
}

function samePath(left: string, right: string): boolean {
  const a = resolve(left), b = resolve(right);
  return process.platform === "win32" ? a.toLowerCase() === b.toLowerCase() : a === b;
}

function schemaFingerprint(db: DatabaseSync): string {
  const rows = db.prepare("SELECT type,name,sql FROM sqlite_schema WHERE name NOT GLOB 'sqlite_*' ORDER BY name")
    .all() as { type: string; name: string; sql: string | null }[];
  return JSON.stringify(rows.map(row => [row.type, row.name, row.sql?.replace(/\s+/g, " ").trim()]));
}

function matchesLedgerSchema(db: DatabaseSync, version: number): boolean {
  const expected = new DatabaseSync(":memory:");
  try {
    expected.exec(readFileSync(new URL("./migrations/001-usage-ledger.sql", import.meta.url), "utf8"));
    if (version >= 2) expected.exec(readFileSync(new URL("./migrations/002-live-session-recovery-fences.sql", import.meta.url), "utf8"));
    if (version === 3 || db.prepare("SELECT 1 FROM pragma_table_info('live_sessions') WHERE name='usage_identity_version'").get()) {
      expected.exec(readFileSync(new URL("./migrations/003-usage-identity.sql", import.meta.url), "utf8"));
    }
    return schemaFingerprint(db) === schemaFingerprint(expected);
  } finally { expected.close(); }
}

/** Checks one SQLite file read-only against the shipped migrations without starting the server. */
export function verifyUsageDatabase(path: string): VerificationResult {
  let db: DatabaseSync;
  try { db = new DatabaseSync(path, { readOnly: true, timeout: 1000 }); }
  catch { throw new SqliteMaintenanceError("source_unavailable"); }
  try {
    const integrity = db.prepare("PRAGMA integrity_check").all() as unknown as { integrity_check: string }[];
    if (integrity.length !== 1 || integrity[0]?.integrity_check !== "ok") throw new SqliteMaintenanceError("integrity_failed");
    if (db.prepare("PRAGMA foreign_key_check").all().length) throw new SqliteMaintenanceError("foreign_key_failed");
    const version = Number(db.prepare("PRAGMA user_version").get()!.user_version);
    if (version < 1) throw new SqliteMaintenanceError("ledger_schema_invalid");
    if (version > 3) throw new SqliteMaintenanceError("ledger_schema_unsupported");
    if (!matchesLedgerSchema(db, version)) {
      throw new SqliteMaintenanceError("ledger_schema_invalid");
    }
    return { integrity: "ok", foreignKeyViolations: 0, ledgerSchema: "compatible" };
  } catch (error) {
    if (error instanceof SqliteMaintenanceError) throw error;
    throw new SqliteMaintenanceError("ledger_schema_invalid");
  } finally { db.close(); }
}

function publicationError(error: unknown, failureCode: FailureCode): SqliteMaintenanceError {
  if (error && typeof error === "object" && "code" in error) {
    if (error.code === "EEXIST") return new SqliteMaintenanceError("target_exists");
    if (["EXDEV", "ENOTSUP", "EOPNOTSUPP", "EPERM"].includes(String(error.code))) {
      return new SqliteMaintenanceError("publication_unsupported");
    }
  }
  return new SqliteMaintenanceError(failureCode);
}

/** Stages privately beside the target, verifies, then publishes atomically without replacing a path. */
async function copyUsageDatabase(source: string, target: string, failureCode: FailureCode, copy: typeof backup): Promise<MaintenanceResult> {
  if (samePath(source, target)) throw new SqliteMaintenanceError("same_path");
  let sourceDb: DatabaseSync;
  try { sourceDb = new DatabaseSync(source, { readOnly: true, timeout: 1000 }); }
  catch { throw new SqliteMaintenanceError("source_unavailable"); }

  const targetPath = resolve(target), targetDirectory = dirname(targetPath);
  let stagingDirectory: string | undefined;
  let published = false;
  try {
    mkdirSync(targetDirectory, { recursive: true, mode: 0o700 });
    stagingDirectory = mkdtempSync(join(targetDirectory, ".live-translator-sqlite-maintenance-"));
    const stagingPath = join(stagingDirectory, "snapshot.sqlite");
    const pages = await copy(sourceDb, stagingPath);
    chmodSync(stagingPath, 0o600);
    const verified = verifyUsageDatabase(stagingPath);
    try { linkSync(stagingPath, targetPath); }
    catch (error) { throw publicationError(error, failureCode); }
    published = true;

    let stagingCleanup: "complete" | "pending" = "complete";
    try { rmSync(stagingDirectory, { recursive: true, force: true }); }
    catch { stagingCleanup = "pending"; }
    return { pages, ...verified, stagingCleanup };
  } catch (error) {
    if (error instanceof SqliteMaintenanceError) throw error;
    throw new SqliteMaintenanceError(failureCode);
  } finally {
    sourceDb.close();
    if (stagingDirectory && !published) {
      try { rmSync(stagingDirectory, { recursive: true, force: true }); }
      catch { /* Keep the original maintenance failure; only our private staging directory is removed. */ }
    }
  }
}

/** Uses SQLite's online backup API so committed WAL pages are included in one coherent snapshot. */
export function backupUsageDatabase(source: string, target: string, copy: typeof backup = backup): Promise<MaintenanceResult> {
  return copyUsageDatabase(source, target, "backup_failed", copy);
}

/** Restores a coherent SQLite snapshot to a new path; existing targets are never replaced. */
export function restoreUsageDatabase(source: string, target: string, copy: typeof backup = backup): Promise<MaintenanceResult> {
  return copyUsageDatabase(source, target, "restore_failed", copy);
}
