import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import { DatabaseSync } from "node:sqlite";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { openUsageDatabase } from "../src/persistence/database.js";
import { UsageLedger } from "../src/accounting/UsageLedger.js";
import { randomUUID } from "node:crypto";

describe("persistent usage database", () => {
  it("migrates once, uses WAL/FULL/foreign keys, and preserves records after reopen", () => {
    const dir = mkdtempSync(join(tmpdir(), "translator-db-"));
    try {
      const path = join(dir, "nested", "ledger.sqlite");
      let db = openUsageDatabase(path);
      expect(db.prepare("PRAGMA user_version").get()!.user_version).toBe(2);
      expect(db.prepare("PRAGMA journal_mode").get()!.journal_mode).toBe("wal");
      expect(db.prepare("PRAGMA synchronous").get()!.synchronous).toBe(2);
      expect(db.prepare("PRAGMA foreign_keys").get()!.foreign_keys).toBe(1);
      const owner = randomUUID(), ledger = new UsageLedger(db), c = ledger.createConversation(owner, randomUUID(), "test");
      db.close(); db = openUsageDatabase(path);
      expect(new UsageLedger(db).getConversation(owner, c.id).id).toBe(c.id);
      expect(db.prepare("PRAGMA integrity_check").get()!.integrity_check).toBe("ok");
      db.close();
    } finally { rmSync(dir, { recursive: true, force: true }); }
  });
  it("upgrades an existing v1 ledger with durable recovery fences", () => {
    const dir = mkdtempSync(join(tmpdir(), "translator-db-v1-"));
    try {
      const path = join(dir, "ledger.sqlite");
      const legacy = new DatabaseSync(path);
      legacy.exec(readFileSync(new URL("../src/persistence/migrations/001-usage-ledger.sql", import.meta.url), "utf8"));
      legacy.exec("PRAGMA user_version=1");
      legacy.close();

      const db = openUsageDatabase(path);
      expect(db.prepare("PRAGMA user_version").get()!.user_version).toBe(2);
      expect(db.prepare("SELECT name FROM sqlite_master WHERE type='table' AND name='live_session_recovery_fences'").get()).toBeTruthy();
      db.close();
    } finally { rmSync(dir, { recursive: true, force: true }); }
  });

});
