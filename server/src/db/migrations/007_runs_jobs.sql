-- Phase 3: durable project chat runs, stable logical jobs, retry attempts,
-- persisted event streams, and non-secret provider configuration.
-- The pre-Phase-3 `jobs` compatibility projection is extended in place so imported
-- identifiers remain stable. New logical jobs are marked with phase3=1 in data_json.
ALTER TABLE jobs ADD COLUMN run_id TEXT;
ALTER TABLE jobs ADD COLUMN project_id TEXT;
ALTER TABLE jobs ADD COLUMN deliverable_key TEXT;
ALTER TABLE jobs ADD COLUMN deliverable_name TEXT;
ALTER TABLE jobs ADD COLUMN request_json TEXT;
ALTER TABLE jobs ADD COLUMN context_snapshot_id TEXT;
ALTER TABLE jobs ADD COLUMN publication_key TEXT;
ALTER TABLE jobs ADD COLUMN result_component_id TEXT;
ALTER TABLE jobs ADD COLUMN result_revision_id TEXT;
ALTER TABLE jobs ADD COLUMN created_at TEXT;
ALTER TABLE jobs ADD COLUMN updated_at TEXT;
CREATE UNIQUE INDEX IF NOT EXISTS jobs_publication_key_unique ON jobs(publication_key) WHERE publication_key IS NOT NULL;
CREATE INDEX IF NOT EXISTS jobs_run_order ON jobs(run_id, ordinal);

CREATE TABLE IF NOT EXISTS provider_configs (
  id TEXT PRIMARY KEY,
  kind TEXT NOT NULL CHECK(kind IN ('fixture','local-template','ollama','openai-compatible')),
  label TEXT NOT NULL,
  base_url TEXT,
  model TEXT,
  api_key_env TEXT,
  enabled INTEGER NOT NULL DEFAULT 1,
  config_json TEXT NOT NULL DEFAULT '{}',
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL
);
INSERT OR IGNORE INTO provider_configs(id,kind,label,base_url,model,api_key_env,enabled,config_json,created_at,updated_at)
VALUES
 ('fixture','fixture','Deterministic fixture',NULL,'fixture-v1',NULL,1,'{}',datetime('now'),datetime('now')),
 ('local-template','local-template','Local template',NULL,'template-v1',NULL,1,'{}',datetime('now'),datetime('now')),
 ('ollama','ollama','Ollama','http://127.0.0.1:11434','llama3.2',NULL,1,'{}',datetime('now'),datetime('now'));

CREATE TABLE IF NOT EXISTS thread_runs (
  id TEXT PRIMARY KEY,
  thread_id TEXT NOT NULL,
  project_id TEXT NOT NULL,
  context_snapshot_id TEXT NOT NULL,
  provider_config_id TEXT NOT NULL,
  predecessor_run_id TEXT,
  request_message_id TEXT NOT NULL,
  response_message_id TEXT,
  prompt TEXT NOT NULL,
  status TEXT NOT NULL CHECK(status IN ('queued','running','succeeded','partial','failed','cancelled')),
  deliverable_count INTEGER NOT NULL,
  completed_count INTEGER NOT NULL DEFAULT 0,
  created_at TEXT NOT NULL,
  started_at TEXT,
  finished_at TEXT,
  error_code TEXT
);
CREATE INDEX IF NOT EXISTS thread_runs_thread_created ON thread_runs(thread_id, created_at DESC);
CREATE INDEX IF NOT EXISTS thread_runs_status ON thread_runs(status, created_at);

CREATE TABLE IF NOT EXISTS job_attempts (
  id TEXT PRIMARY KEY,
  job_id TEXT NOT NULL REFERENCES jobs(id) ON DELETE RESTRICT,
  attempt_number INTEGER NOT NULL,
  status TEXT NOT NULL CHECK(status IN ('queued','running','streaming','building','succeeded','failed','cancelled')),
  provider_request_id TEXT,
  build_id TEXT,
  error_code TEXT,
  error_message TEXT,
  created_at TEXT NOT NULL,
  started_at TEXT,
  finished_at TEXT,
  UNIQUE(job_id, attempt_number)
);
CREATE INDEX IF NOT EXISTS job_attempts_status ON job_attempts(status, created_at);

CREATE TABLE IF NOT EXISTS job_events (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  run_id TEXT NOT NULL,
  job_id TEXT,
  attempt_id TEXT,
  event_type TEXT NOT NULL,
  data_json TEXT NOT NULL,
  sensitive INTEGER NOT NULL DEFAULT 1,
  created_at TEXT NOT NULL
);
CREATE INDEX IF NOT EXISTS job_events_run_id ON job_events(run_id, id);
CREATE INDEX IF NOT EXISTS job_events_job_id ON job_events(job_id, id);

CREATE TABLE IF NOT EXISTS logical_job_publications (
  publication_key TEXT PRIMARY KEY,
  job_id TEXT NOT NULL UNIQUE REFERENCES jobs(id) ON DELETE RESTRICT,
  component_id TEXT NOT NULL,
  revision_id TEXT NOT NULL,
  canvas_publication_id TEXT NOT NULL UNIQUE,
  status TEXT NOT NULL CHECK(status IN ('pending','materialized')),
  created_at TEXT NOT NULL,
  materialized_at TEXT
);
