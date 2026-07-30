-- Durable Phase 1 candidate/build state. Candidate source and build outputs are immutable.
CREATE TABLE IF NOT EXISTS revision_candidates (
  id TEXT PRIMARY KEY,
  -- Deliberately not an SQL FK: the compatibility store rewrites its projection tables.
  -- Candidate ownership is validated transactionally by CandidateService.
  component_id TEXT NOT NULL,
  expected_base_revision_id TEXT,
  source_revision_id TEXT,
  status TEXT NOT NULL CHECK(status IN ('queued','building','failed','promoted','built_existing')),
  note TEXT,
  source_checksum TEXT NOT NULL,
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL,
  promoted_revision_id TEXT,
  diagnostics_json TEXT
);
CREATE INDEX IF NOT EXISTS revision_candidates_component_created
  ON revision_candidates(component_id, created_at DESC);

CREATE TABLE IF NOT EXISTS candidate_files (
  candidate_id TEXT NOT NULL REFERENCES revision_candidates(id) ON DELETE RESTRICT,
  path TEXT NOT NULL,
  content TEXT NOT NULL,
  content_checksum TEXT NOT NULL,
  PRIMARY KEY(candidate_id, path)
);

CREATE TABLE IF NOT EXISTS builds (
  id TEXT PRIMARY KEY,
  candidate_id TEXT NOT NULL REFERENCES revision_candidates(id) ON DELETE RESTRICT,
  revision_id TEXT,
  status TEXT NOT NULL CHECK(status IN ('queued','building','failed','succeeded')),
  started_at TEXT,
  finished_at TEXT,
  artifact_hash TEXT,
  diagnostics_json TEXT,
  worker_json TEXT NOT NULL DEFAULT '{}'
);
CREATE INDEX IF NOT EXISTS builds_candidate ON builds(candidate_id);
CREATE INDEX IF NOT EXISTS builds_revision ON builds(revision_id, finished_at DESC);

CREATE TABLE IF NOT EXISTS artifact_publications (
  id TEXT PRIMARY KEY,
  build_id TEXT NOT NULL UNIQUE REFERENCES builds(id) ON DELETE RESTRICT,
  candidate_id TEXT NOT NULL REFERENCES revision_candidates(id) ON DELETE RESTRICT,
  revision_id TEXT,
  artifact_hash TEXT NOT NULL,
  stage_path TEXT NOT NULL,
  final_path TEXT NOT NULL,
  status TEXT NOT NULL CHECK(status IN ('intent','published','committed')),
  created_at TEXT NOT NULL,
  published_at TEXT
);

CREATE TABLE IF NOT EXISTS screenshots (
  id TEXT PRIMARY KEY,
  revision_id TEXT NOT NULL,
  build_id TEXT REFERENCES builds(id) ON DELETE RESTRICT,
  viewport_width INTEGER NOT NULL,
  viewport_height INTEGER NOT NULL,
  media_type TEXT NOT NULL,
  blob_path TEXT NOT NULL,
  content_checksum TEXT NOT NULL,
  created_at TEXT NOT NULL
);

CREATE TABLE IF NOT EXISTS build_events (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  build_id TEXT NOT NULL REFERENCES builds(id) ON DELETE RESTRICT,
  event_type TEXT NOT NULL,
  data_json TEXT NOT NULL,
  created_at TEXT NOT NULL
);
CREATE INDEX IF NOT EXISTS build_events_build_id ON build_events(build_id, id);
