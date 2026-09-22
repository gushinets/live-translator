import { mkdtempSync, rmSync } from "node:fs";
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
      expect(db.prepare("PRAGMA user_version").get()!.user_version).toBe(1);
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
});
