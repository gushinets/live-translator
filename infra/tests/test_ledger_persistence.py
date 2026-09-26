"""Exercise the built production API image against a disposable named volume.

No application server or provider connection is started. Both containers run
with networking disabled, and only the uniquely named test volume is removed.
"""
import os
import subprocess
import unittest
import uuid


class LedgerPersistenceTest(unittest.TestCase):
    def test_survives_container_recreation_as_non_root(self):
        image = os.environ.get("LEDGER_TEST_IMAGE", "live-translator-api")
        volume = "live-translator-ledger-test-" + uuid.uuid4().hex
        subprocess.run(["docker", "image", "inspect", image], check=True,
                       stdout=subprocess.DEVNULL, timeout=30)
        subprocess.run(["docker", "volume", "create", volume], check=True,
                       stdout=subprocess.DEVNULL, timeout=30)
        common = """
import assert from 'node:assert/strict';
import { openUsageDatabase } from './dist/persistence/database.js';
import { UsageLedger } from './dist/accounting/UsageLedger.js';
assert.notEqual(process.getuid(), 0, 'Production image must not run as root');
await import('ws');
await import('openai/resources/live/sideband/ws');
const db = openUsageDatabase('/data/verification.sqlite');
try {
  assert.equal(db.prepare('PRAGMA user_version').get().user_version, 2);
  assert.equal(db.prepare("SELECT count(*) AS n FROM pragma_table_info('live_sessions') WHERE name='usage_identity_version'").get().n, 1);
  assert.equal(db.prepare('PRAGMA journal_mode').get().journal_mode, 'wal');
  assert.equal(db.prepare('PRAGMA synchronous').get().synchronous, 2);
  assert.equal(db.prepare('PRAGMA foreign_keys').get().foreign_keys, 1);
  const ledger = new UsageLedger(db);
  const owner = '11111111-1111-4111-8111-111111111111';
  const requestId = '22222222-2222-4222-8222-222222222222';
"""
        create = """
  const c = ledger.createConversation(owner, requestId, 'container-verification');
  ledger.registerAttempt(owner, {
    conversationId: c.id, conversationVersion: c.version,
    liveSessionId: '33333333-3333-4333-8333-333333333333',
    initialMode: 'setup', startReason: 'initial', fingerprint: 'synthetic',
  });
"""
        reopen = """
  const saved = db.prepare('SELECT id FROM conversations WHERE create_request_id=?').get(requestId);
  assert.ok(saved, 'Conversation must survive the first container');
  const c = ledger.createConversation(owner, requestId, 'container-verification');
  assert.equal(c.id, saved.id);
  assert.equal(db.prepare('SELECT count(*) AS n FROM conversations').get().n, 1);
  const attempts = ledger.listAttempts(owner, c.id);
  assert.equal(attempts.length, 1);
  assert.equal(attempts[0].provider_request_dispatched_at, null);
  assert.equal(db.prepare('PRAGMA integrity_check').get().integrity_check, 'ok');
  assert.deepEqual(db.prepare('PRAGMA foreign_key_check').all(), []);
"""
        try:
            for body in (create, reopen):
                result = subprocess.run([
                    "docker", "run", "--rm", "--network", "none",
                    "--mount", f"type=volume,source={volume},target=/data",
                    image, "node", "--input-type=module", "-e",
                    common + body + "\n} finally { db.close(); }\n",
                ], capture_output=True, text=True, timeout=30)
                self.assertEqual(result.returncode, 0, result.stdout + result.stderr)
        finally:
            subprocess.run(["docker", "volume", "rm", volume], check=True,
                           stdout=subprocess.DEVNULL, timeout=30)


if __name__ == "__main__":
    unittest.main()
