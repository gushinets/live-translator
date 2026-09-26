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

  it("upgrades an existing v2 live attempt as legacy usage without changing its conversation", () => {
    const dir = mkdtempSync(join(tmpdir(), "translator-db-v2-"));
    let upgraded: DatabaseSync | undefined;
    try {
      const path = join(dir, "ledger.sqlite"), owner = randomUUID(), conversationId = randomUUID(), id = randomUUID();
      const legacy = new DatabaseSync(path);
      legacy.exec(readFileSync(new URL("../src/persistence/migrations/001-usage-ledger.sql", import.meta.url), "utf8"));
      legacy.exec(readFileSync(new URL("../src/persistence/migrations/002-live-session-recovery-fences.sql", import.meta.url), "utf8"));
      legacy.prepare("INSERT INTO conversations(id,anonymous_user_id,create_request_id,status,created_at,app_version,conversation_policy_version,policy_json) VALUES(?,?,?,'active',0,'old','old','{}')")
        .run(conversationId, owner, randomUUID());
      legacy.prepare("INSERT INTO live_sessions(id,conversation_id,generation,state,initial_mode,start_reason,model,transport,prompt_version,app_version,creation_requested_at,provider_request_dispatched_at) VALUES(?,?,1,'active','setup','initial','gpt-live-1','webrtc','old','old',0,0)")
        .run(id, conversationId);
      legacy.exec("PRAGMA user_version=2"); legacy.close();

      upgraded = openUsageDatabase(path);
      expect(upgraded.prepare("PRAGMA user_version").get()!.user_version).toBe(2);
      const ledger = new UsageLedger(upgraded);
      ledger.recordUsage(owner, id, undefined, { schemaVersion: 1, checkpointSeconds: 7 });
      expect(ledger.getAttemptInternal(id)).toMatchObject({ conversation_id: conversationId,
        usage_identity_version: null, provider_checkpoint_seconds: 7 });
    } finally { upgraded?.close(); rmSync(dir, { recursive: true, force: true }); }
  });

  it("keeps an upgraded ledger readable by the previous v2 binary", () => {
    const dir = mkdtempSync(join(tmpdir(), "translator-db-rollback-"));
    try {
      const path = join(dir, "ledger.sqlite");
      let db = openUsageDatabase(path);
      const owner = randomUUID(), c = new UsageLedger(db).createConversation(owner, randomUUID(), "test");
      db.close();

      // The previous binary rejects user_version > 2 before reading the ledger.
      const previous = new DatabaseSync(path);
      expect(Number(previous.prepare("PRAGMA user_version").get()!.user_version)).toBeLessThanOrEqual(2);
      expect(previous.prepare("SELECT id FROM conversations WHERE id=?").get(c.id)?.id).toBe(c.id);
      previous.close();

      // A database opened by earlier PR builds at v3 must become rollback-safe too.
      db = new DatabaseSync(path);
      db.exec("PRAGMA user_version=3");
      db.close();
      db = openUsageDatabase(path);
      expect(db.prepare("PRAGMA user_version").get()!.user_version).toBe(2);
      expect(db.prepare("SELECT count(*) AS n FROM pragma_table_info('live_sessions') WHERE name='usage_identity_version'").get()!.n).toBe(1);
      db.close();
    } finally { rmSync(dir, { recursive: true, force: true }); }
  });

});
