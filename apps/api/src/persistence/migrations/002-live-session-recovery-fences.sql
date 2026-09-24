CREATE TABLE live_session_recovery_fences (
  id TEXT PRIMARY KEY,
  conversation_id TEXT NOT NULL REFERENCES conversations(id),
  cleanup_reason TEXT NOT NULL CHECK(cleanup_reason IN (
    'response_not_received','primary_startup_failed','abandoned_connect','hidden','user_end','cancelled','replacement',
    'server_shutdown','client_disconnected','handoff_timeout','handoff_not_activatable','resume_claim_expired'
  )),
  created_at INTEGER NOT NULL
) STRICT;

CREATE INDEX idx_live_session_recovery_fences_conversation
  ON live_session_recovery_fences(conversation_id, created_at);
