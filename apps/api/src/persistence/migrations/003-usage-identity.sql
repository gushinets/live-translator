ALTER TABLE live_sessions ADD COLUMN usage_identity_version INTEGER CHECK(usage_identity_version=1);
