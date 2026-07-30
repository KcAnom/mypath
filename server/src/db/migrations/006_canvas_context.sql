-- Phase 2: versioned tldraw documents, safe assets, deterministic frame publication,
-- and immutable context envelopes. Phase 2 relations deliberately reference stable IDs
-- rather than projection rows because the compatibility store rebuilds projections.
CREATE TABLE IF NOT EXISTS canvas_snapshots (
  canvas_id TEXT NOT NULL,
  version INTEGER NOT NULL,
  schema_version INTEGER NOT NULL DEFAULT 1,
  snapshot_json TEXT NOT NULL,
  camera_json TEXT NOT NULL DEFAULT '{}',
  source TEXT NOT NULL DEFAULT 'edit',
  created_at TEXT NOT NULL,
  PRIMARY KEY(canvas_id, version)
);
CREATE INDEX IF NOT EXISTS canvas_snapshots_latest ON canvas_snapshots(canvas_id, version DESC);

CREATE TABLE IF NOT EXISTS canvas_frame_publications (
  id TEXT PRIMARY KEY,
  canvas_id TEXT NOT NULL,
  logical_job_id TEXT NOT NULL,
  frame_json TEXT NOT NULL,
  status TEXT NOT NULL DEFAULT 'pending' CHECK(status IN ('pending','materialized','failed')),
  materialized_version INTEGER,
  attempts INTEGER NOT NULL DEFAULT 0,
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL,
  UNIQUE(canvas_id, logical_job_id)
);

CREATE TABLE IF NOT EXISTS asset_blobs (
  checksum TEXT PRIMARY KEY,
  storage_key TEXT NOT NULL UNIQUE,
  media_type TEXT NOT NULL,
  byte_size INTEGER NOT NULL,
  created_at TEXT NOT NULL
);
CREATE TABLE IF NOT EXISTS asset_ingestions (
  id TEXT PRIMARY KEY,
  project_id TEXT,
  checksum TEXT NOT NULL REFERENCES asset_blobs(checksum) ON DELETE RESTRICT,
  kind TEXT NOT NULL CHECK(kind IN ('image','document','font')),
  original_name TEXT NOT NULL,
  media_type TEXT NOT NULL,
  created_at TEXT NOT NULL,
  tombstoned_at TEXT
);
CREATE INDEX IF NOT EXISTS asset_ingestions_project ON asset_ingestions(project_id, created_at DESC);

CREATE TABLE IF NOT EXISTS design_system_versions (
  id TEXT PRIMARY KEY,
  design_system_id TEXT NOT NULL,
  version INTEGER NOT NULL,
  data_json TEXT NOT NULL,
  created_at TEXT NOT NULL,
  UNIQUE(design_system_id, version)
);
INSERT OR IGNORE INTO design_system_versions(id, design_system_id, version, data_json, created_at)
SELECT 'dsv:' || id || ':1', id, 1, data_json, COALESCE(json_extract(data_json,'$.createdAt'), datetime('now')) FROM design_systems;
CREATE TABLE IF NOT EXISTS project_design_systems (project_id TEXT NOT NULL, design_system_version_id TEXT NOT NULL, active INTEGER NOT NULL DEFAULT 0, PRIMARY KEY(project_id,design_system_version_id));
CREATE TABLE IF NOT EXISTS project_libraries (project_id TEXT NOT NULL, library_id TEXT NOT NULL, active INTEGER NOT NULL DEFAULT 0, PRIMARY KEY(project_id,library_id));
CREATE TABLE IF NOT EXISTS project_skills (project_id TEXT NOT NULL, skill_id TEXT NOT NULL, active INTEGER NOT NULL DEFAULT 0, PRIMARY KEY(project_id,skill_id));

CREATE TABLE IF NOT EXISTS context_snapshots (
  id TEXT PRIMARY KEY,
  project_id TEXT NOT NULL,
  schema_version INTEGER NOT NULL CHECK(schema_version=1),
  envelope_json TEXT NOT NULL,
  content_checksum TEXT NOT NULL UNIQUE,
  created_at TEXT NOT NULL
);
CREATE TABLE IF NOT EXISTS context_references (
  context_snapshot_id TEXT NOT NULL REFERENCES context_snapshots(id) ON DELETE RESTRICT,
  ref_type TEXT NOT NULL,
  entity_id TEXT NOT NULL,
  exact_version TEXT,
  metadata_json TEXT NOT NULL DEFAULT '{}',
  PRIMARY KEY(context_snapshot_id, ref_type, entity_id, exact_version)
);
CREATE TRIGGER IF NOT EXISTS context_snapshots_immutable_update BEFORE UPDATE ON context_snapshots BEGIN SELECT RAISE(ABORT,'context snapshots are immutable'); END;
CREATE TRIGGER IF NOT EXISTS context_snapshots_immutable_delete BEFORE DELETE ON context_snapshots BEGIN SELECT RAISE(ABORT,'context snapshots are immutable'); END;
CREATE TRIGGER IF NOT EXISTS context_references_immutable_update BEFORE UPDATE ON context_references BEGIN SELECT RAISE(ABORT,'context references are immutable'); END;
CREATE TRIGGER IF NOT EXISTS context_references_immutable_delete BEFORE DELETE ON context_references BEGIN SELECT RAISE(ABORT,'context references are immutable'); END;
