-- Release hardening: a durable, restart-reconcilable publication workflow for each
-- logical job. Every externally visible boundary is recorded before the next step.
CREATE TABLE IF NOT EXISTS logical_job_publication_state (
  job_id TEXT PRIMARY KEY REFERENCES jobs(id) ON DELETE RESTRICT,
  state TEXT NOT NULL CHECK(state IN (
    'provider_completed',
    'component_created',
    'candidate_created',
    'revision_created',
    'canvas_materialized',
    'acknowledged'
  )),
  generated_json TEXT NOT NULL,
  component_id TEXT,
  candidate_id TEXT,
  build_id TEXT,
  revision_id TEXT,
  canvas_publication_id TEXT,
  attempt_id TEXT NOT NULL,
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL
);
CREATE UNIQUE INDEX IF NOT EXISTS logical_job_publication_component_unique
  ON logical_job_publication_state(component_id) WHERE component_id IS NOT NULL;
CREATE UNIQUE INDEX IF NOT EXISTS logical_job_publication_candidate_unique
  ON logical_job_publication_state(candidate_id) WHERE candidate_id IS NOT NULL;
CREATE UNIQUE INDEX IF NOT EXISTS logical_job_publication_canvas_unique
  ON logical_job_publication_state(canvas_publication_id) WHERE canvas_publication_id IS NOT NULL;
CREATE INDEX IF NOT EXISTS logical_job_publication_state_status
  ON logical_job_publication_state(state, updated_at);
