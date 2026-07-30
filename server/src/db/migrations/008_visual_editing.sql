-- Phase 4: transactional supported-subset editing and parallel variants.
ALTER TABLE revision_candidates ADD COLUMN parent_revision_id TEXT;
ALTER TABLE revision_candidates ADD COLUMN metadata_json TEXT NOT NULL DEFAULT '{}';

CREATE TABLE IF NOT EXISTS edit_sessions (
  id TEXT PRIMARY KEY,
  component_id TEXT NOT NULL,
  base_revision_id TEXT NOT NULL,
  status TEXT NOT NULL CHECK(status IN ('open','committing','completed','cancelled','failed')),
  done_revision_id TEXT,
  candidate_id TEXT,
  build_id TEXT,
  error_json TEXT,
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL,
  completed_at TEXT
);
CREATE UNIQUE INDEX IF NOT EXISTS edit_sessions_one_open
  ON edit_sessions(component_id) WHERE status IN ('open','committing');
CREATE INDEX IF NOT EXISTS edit_sessions_component_created ON edit_sessions(component_id, created_at DESC);

CREATE TABLE IF NOT EXISTS edit_operations (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  session_id TEXT NOT NULL REFERENCES edit_sessions(id) ON DELETE RESTRICT,
  ordinal INTEGER NOT NULL,
  operation_json TEXT NOT NULL,
  created_at TEXT NOT NULL,
  UNIQUE(session_id, ordinal)
);

CREATE TABLE IF NOT EXISTS variant_groups (
  id TEXT PRIMARY KEY,
  component_id TEXT NOT NULL,
  parent_revision_id TEXT NOT NULL,
  status TEXT NOT NULL CHECK(status IN ('queued','running','completed','partial','failed')),
  created_at TEXT NOT NULL,
  completed_at TEXT
);

CREATE TABLE IF NOT EXISTS variants (
  id TEXT PRIMARY KEY,
  group_id TEXT NOT NULL REFERENCES variant_groups(id) ON DELETE RESTRICT,
  component_id TEXT NOT NULL,
  parent_revision_id TEXT NOT NULL,
  direction_kind TEXT NOT NULL CHECK(direction_kind IN ('layout','style','color','copy','device')),
  direction_value TEXT NOT NULL,
  status TEXT NOT NULL CHECK(status IN ('queued','building','completed','failed')),
  candidate_id TEXT,
  build_id TEXT,
  revision_id TEXT,
  job_id TEXT,
  diagnostics_json TEXT,
  created_at TEXT NOT NULL,
  completed_at TEXT
);
CREATE INDEX IF NOT EXISTS variants_group ON variants(group_id, created_at);
CREATE INDEX IF NOT EXISTS variants_component ON variants(component_id, created_at DESC);
