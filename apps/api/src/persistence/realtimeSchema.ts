import type { DatabaseSync } from "node:sqlite";

/** Shared DDL for the runtime and maintenance's isolated schema reference. */
export function ensureRealtimeSchema(db: DatabaseSync) {
  db.exec(`CREATE TABLE IF NOT EXISTS realtime_attempts (
    id TEXT PRIMARY KEY, owner TEXT NOT NULL, generation INTEGER NOT NULL,
    model TEXT NOT NULL, transcription_model TEXT NOT NULL, engine TEXT NOT NULL DEFAULT 'realtime',
    state TEXT NOT NULL, call_id TEXT, lease_id TEXT, created_at INTEGER NOT NULL,
    expires_at INTEGER NOT NULL, cleanup_at INTEGER, close_confirmed INTEGER NOT NULL DEFAULT 0,
    next_cleanup_at INTEGER NOT NULL DEFAULT 0, cleanup_count INTEGER NOT NULL DEFAULT 0,
    error_category TEXT, closed_at INTEGER, handoff_at INTEGER);
    CREATE TABLE IF NOT EXISTS realtime_response_usage (
      attempt_id TEXT NOT NULL REFERENCES realtime_attempts(id), response_id TEXT NOT NULL,
      usage_json TEXT NOT NULL, source TEXT NOT NULL DEFAULT 'browser', received_at INTEGER NOT NULL,
      PRIMARY KEY(attempt_id,response_id));`);
  if (!db.prepare("SELECT 1 FROM pragma_table_info('realtime_attempts') WHERE name='handoff_at'").get()) db.exec("ALTER TABLE realtime_attempts ADD COLUMN handoff_at INTEGER");
  if (!db.prepare("SELECT 1 FROM pragma_table_info('realtime_attempts') WHERE name='creation_token'").get()) db.exec("ALTER TABLE realtime_attempts ADD COLUMN creation_token TEXT");
  if (!db.prepare("SELECT 1 FROM pragma_table_info('realtime_attempts') WHERE name='handoff_ready_at'").get()) db.exec("ALTER TABLE realtime_attempts ADD COLUMN handoff_ready_at INTEGER");
  db.exec(`CREATE TABLE IF NOT EXISTS realtime_usage (
    attempt_id TEXT NOT NULL REFERENCES realtime_attempts(id), operation TEXT NOT NULL,
    observation_id TEXT NOT NULL, content_index INTEGER NOT NULL, model TEXT NOT NULL,
    usage_json TEXT NOT NULL, source TEXT NOT NULL DEFAULT 'provider_data_channel_via_browser',
    received_at INTEGER NOT NULL, PRIMARY KEY(attempt_id,operation,observation_id,content_index));`);
}
