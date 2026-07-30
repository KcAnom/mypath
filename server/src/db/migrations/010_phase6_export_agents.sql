-- Phase 6: immutable reproducible exports, native destination grants, and
-- separately-authorized external-agent review sessions.
CREATE TABLE IF NOT EXISTS export_destination_grants (
  id TEXT PRIMARY KEY,
  canonical_path TEXT NOT NULL,
  expires_at TEXT NOT NULL,
  consumed_at TEXT,
  created_at TEXT NOT NULL
);
CREATE INDEX IF NOT EXISTS export_destination_grants_expiry ON export_destination_grants(expires_at);

CREATE TABLE IF NOT EXISTS export_manifests (
  id TEXT PRIMARY KEY,
  revision_id TEXT NOT NULL UNIQUE,
  project_id TEXT NOT NULL,
  component_id TEXT NOT NULL,
  archive_checksum TEXT NOT NULL,
  manifest_checksum TEXT NOT NULL,
  manifest_json TEXT NOT NULL,
  created_at TEXT NOT NULL
);
CREATE TRIGGER IF NOT EXISTS export_manifests_immutable_update BEFORE UPDATE ON export_manifests
BEGIN SELECT RAISE(ABORT,'export manifests are immutable'); END;
CREATE TRIGGER IF NOT EXISTS export_manifests_immutable_delete BEFORE DELETE ON export_manifests
BEGIN SELECT RAISE(ABORT,'export manifests are immutable'); END;

CREATE TABLE IF NOT EXISTS external_agent_grants (
  id TEXT PRIMARY KEY,
  token_hash TEXT NOT NULL UNIQUE,
  label TEXT NOT NULL,
  project_ids_json TEXT NOT NULL,
  scopes_json TEXT NOT NULL,
  expires_at TEXT NOT NULL,
  revoked_at TEXT,
  created_at TEXT NOT NULL
);
CREATE INDEX IF NOT EXISTS external_agent_grants_token ON external_agent_grants(token_hash);

CREATE TABLE IF NOT EXISTS external_edit_sessions (
  id TEXT PRIMARY KEY,
  grant_id TEXT NOT NULL REFERENCES external_agent_grants(id) ON DELETE RESTRICT,
  project_id TEXT NOT NULL,
  component_id TEXT NOT NULL,
  base_revision_id TEXT NOT NULL,
  status TEXT NOT NULL CHECK(status IN ('open','submitted','accepted','rejected')),
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL
);
CREATE INDEX IF NOT EXISTS external_edit_sessions_grant ON external_edit_sessions(grant_id, created_at DESC);

CREATE TABLE IF NOT EXISTS external_agent_submissions (
  id TEXT PRIMARY KEY,
  session_id TEXT NOT NULL REFERENCES external_edit_sessions(id) ON DELETE RESTRICT,
  candidate_id TEXT,
  build_id TEXT,
  status TEXT NOT NULL CHECK(status IN ('building','build_failed','pending_review','accepted','rejected')),
  revision_id TEXT,
  diff_json TEXT NOT NULL DEFAULT '{}',
  note TEXT NOT NULL DEFAULT '',
  created_at TEXT NOT NULL,
  reviewed_at TEXT
);
CREATE INDEX IF NOT EXISTS external_agent_submissions_session ON external_agent_submissions(session_id, created_at DESC);
