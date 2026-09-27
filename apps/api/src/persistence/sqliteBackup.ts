import { chmodSync, linkSync, mkdirSync, mkdtempSync, rmSync } from "node:fs";
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

const requiredColumns = {
  conversations: "id anonymous_user_id create_request_id version status end_reason resume_attempt_id created_at first_provider_dispatch_at first_interpreter_observed_at last_product_activity_received_at paused_at resume_expires_at ended_at product_deadline_at app_version conversation_policy_version policy_json".split(" "),
  live_sessions: "id conversation_id generation openai_session_id state initial_mode start_reason request_fingerprint request_conversation_version resume_claimed_at resume_claim_expires_at resume_claim_version resume_outcome model transport prompt_version app_version creation_requested_at provider_request_dispatched_at creation_completed_at handoff_ack_deadline_at handoff_acknowledged_at cleanup_requested_at cleanup_reason cleanup_attempt_count cleanup_last_attempt_at cleanup_next_attempt_at cleanup_retry_expires_at cleanup_retry_exhausted_at cleanup_last_result cleanup_last_error_code cleanup_blocked_at provider_started_observed_at interpreter_ready_observed_at provider_expires_at lease_id lease_expires_at lease_released_at close_requested_at closed_observed_at last_report_received_at close_confirmed close_confirmation_source provider_close_reason provider_close_reason_source app_end_reason provider_checkpoint_seconds provider_final_seconds provider_checkpoint_source provider_final_source usage_conflict usage_conflict_details observed_wall_ms setup_ms active_interpreter_ms visible_paused_ms last_checkpoint_at_interpreter_ready last_checkpoint_received_at estimated_total_seconds estimate_method_version estimate_as_of measurement_version activity_report_seq accepted_source_speech_ms completed_source_speech_ms speech_measurement_version speech_measurement_status app_metrics_finalized metrics_json usage_quality pricing_policy_version".split(" "),
  live_session_recovery_fences: "id conversation_id cleanup_reason created_at".split(" "),
} as const;

function hasColumns(db: DatabaseSync, table: keyof typeof requiredColumns, version?: number): boolean {
  const columns = new Set((db.prepare("PRAGMA table_info(" + table + ")").all() as { name: string }[]).map(column => column.name));
  return requiredColumns[table].every(column => columns.has(column)) &&
    (table !== "live_sessions" || version !== 3 || columns.has("usage_identity_version"));
}

/** Checks one SQLite file without opening the ledger adapter, migrations, workers, or server. */
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
    if (!hasColumns(db, "conversations") || !hasColumns(db, "live_sessions", version) ||
        (version >= 2 && !hasColumns(db, "live_session_recovery_fences"))) {
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
