import { mkdirSync, readFileSync } from "node:fs";
import { dirname } from "node:path";
import { DatabaseSync } from "node:sqlite";

/** A single process and local disk. SQL transactions must never contain network awaits. */
export function openUsageDatabase(path: string, busyTimeoutMs = 1000): DatabaseSync {
  if (!path || !Number.isSafeInteger(busyTimeoutMs) || busyTimeoutMs < 0 || busyTimeoutMs > 5000) throw new Error("Invalid usage database configuration");
  if (path !== ":memory:") mkdirSync(dirname(path), { recursive: true, mode: 0o700 });
  const db = new DatabaseSync(path);
  try {
    db.exec(`PRAGMA foreign_keys=ON; PRAGMA busy_timeout=${busyTimeoutMs}; PRAGMA journal_mode=WAL; PRAGMA synchronous=FULL;`);
    const version = Number(db.prepare("PRAGMA user_version").get()!.user_version);
    if (version > 3) throw new Error("Usage database schema is newer than this application");
    if (version < 1) transaction(db, () => {
      db.exec(readFileSync(new URL("./migrations/001-usage-ledger.sql", import.meta.url), "utf8"));
      db.exec("PRAGMA user_version=1");
    });
    if (version < 2) transaction(db, () => {
      db.exec(readFileSync(new URL("./migrations/002-live-session-recovery-fences.sql", import.meta.url), "utf8"));
      db.exec("PRAGMA user_version=2");
    });
    if (version < 3) transaction(db, () => {
      db.exec(readFileSync(new URL("./migrations/003-usage-identity.sql", import.meta.url), "utf8"));
      db.exec("PRAGMA user_version=3");
    });
    return db;
  } catch (error) { db.close(); throw error; }
}
export function transaction<T>(db: DatabaseSync, work: () => T): T {
  db.exec("BEGIN IMMEDIATE");
  try {
    const result = work();
    if (result instanceof Promise) throw new Error("SQLite transactions must be synchronous");
    db.exec("COMMIT"); return result;
  } catch (error) {
    try { db.exec("ROLLBACK"); } catch { /* Preserve the original failure. */ }
    throw error;
  }
}
