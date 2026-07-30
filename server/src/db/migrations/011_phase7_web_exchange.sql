-- Phase 7: immutable web/search provenance, one-time surgical capture,
-- semantic conversion jobs, and deterministic Figma exchange records.
CREATE TABLE IF NOT EXISTS phase7_jobs (
  id TEXT PRIMARY KEY,
  project_id TEXT,
  kind TEXT NOT NULL CHECK(kind IN ('web_fetch','semantic_conversion','search','search_fetch','figma_import')),
  status TEXT NOT NULL CHECK(status IN ('queued','running','succeeded','failed')),
  input_json TEXT NOT NULL,
  result_ref TEXT,
  diagnostics_json TEXT NOT NULL DEFAULT '[]',
  created_at TEXT NOT NULL,
  started_at TEXT,
  finished_at TEXT
);
CREATE INDEX IF NOT EXISTS phase7_jobs_project ON phase7_jobs(project_id, created_at DESC);

CREATE TABLE IF NOT EXISTS web_imports (
  id TEXT PRIMARY KEY,
  project_id TEXT NOT NULL,
  job_id TEXT NOT NULL UNIQUE REFERENCES phase7_jobs(id) ON DELETE RESTRICT,
  requested_url TEXT NOT NULL,
  final_url TEXT NOT NULL,
  sanitized_html TEXT NOT NULL,
  sanitized_checksum TEXT NOT NULL,
  original_checksum TEXT NOT NULL,
  response_headers_json TEXT NOT NULL,
  redirects_json TEXT NOT NULL,
  diagnostics_json TEXT NOT NULL,
  rights_warning TEXT NOT NULL,
  fetched_at TEXT NOT NULL
);
CREATE INDEX IF NOT EXISTS web_imports_project ON web_imports(project_id, fetched_at DESC);
CREATE TRIGGER IF NOT EXISTS web_imports_immutable_update BEFORE UPDATE ON web_imports BEGIN SELECT RAISE(ABORT,'web imports are immutable'); END;
CREATE TRIGGER IF NOT EXISTS web_imports_immutable_delete BEFORE DELETE ON web_imports BEGIN SELECT RAISE(ABORT,'web imports are immutable'); END;

CREATE TABLE IF NOT EXISTS web_import_assets (
  id TEXT PRIMARY KEY,
  import_id TEXT NOT NULL REFERENCES web_imports(id) ON DELETE RESTRICT,
  source_url TEXT NOT NULL,
  asset_id TEXT NOT NULL,
  checksum TEXT NOT NULL,
  media_type TEXT NOT NULL,
  byte_size INTEGER NOT NULL,
  created_at TEXT NOT NULL,
  UNIQUE(import_id, source_url)
);
CREATE TRIGGER IF NOT EXISTS web_import_assets_immutable_update BEFORE UPDATE ON web_import_assets BEGIN SELECT RAISE(ABORT,'web import assets are immutable'); END;
CREATE TRIGGER IF NOT EXISTS web_import_assets_immutable_delete BEFORE DELETE ON web_import_assets BEGIN SELECT RAISE(ABORT,'web import assets are immutable'); END;

CREATE TABLE IF NOT EXISTS semantic_import_conversions (
  id TEXT PRIMARY KEY,
  import_id TEXT NOT NULL REFERENCES web_imports(id) ON DELETE RESTRICT,
  job_id TEXT NOT NULL UNIQUE REFERENCES phase7_jobs(id) ON DELETE RESTRICT,
  component_id TEXT,
  revision_id TEXT,
  semantic_json TEXT NOT NULL,
  semantic_checksum TEXT NOT NULL,
  diagnostics_json TEXT NOT NULL,
  created_at TEXT NOT NULL
);
CREATE TRIGGER IF NOT EXISTS semantic_imports_immutable_update BEFORE UPDATE ON semantic_import_conversions BEGIN SELECT RAISE(ABORT,'semantic conversions are immutable'); END;
CREATE TRIGGER IF NOT EXISTS semantic_imports_immutable_delete BEFORE DELETE ON semantic_import_conversions BEGIN SELECT RAISE(ABORT,'semantic conversions are immutable'); END;

CREATE TABLE IF NOT EXISTS capture_tickets (
  id TEXT PRIMARY KEY,
  token_hash TEXT NOT NULL UNIQUE,
  project_id TEXT NOT NULL,
  page_origin TEXT NOT NULL,
  expires_at TEXT NOT NULL,
  consumed_at TEXT,
  created_at TEXT NOT NULL
);
CREATE INDEX IF NOT EXISTS capture_tickets_expiry ON capture_tickets(expires_at);
CREATE TABLE IF NOT EXISTS surgical_captures (
  id TEXT PRIMARY KEY,
  ticket_id TEXT NOT NULL UNIQUE REFERENCES capture_tickets(id) ON DELETE RESTRICT,
  project_id TEXT NOT NULL,
  page_url TEXT NOT NULL,
  sanitized_html TEXT NOT NULL,
  styles_json TEXT NOT NULL,
  screenshot_asset_id TEXT,
  asset_references_json TEXT NOT NULL,
  provenance_json TEXT NOT NULL,
  created_at TEXT NOT NULL
);
CREATE TRIGGER IF NOT EXISTS surgical_captures_immutable_update BEFORE UPDATE ON surgical_captures BEGIN SELECT RAISE(ABORT,'surgical captures are immutable'); END;
CREATE TRIGGER IF NOT EXISTS surgical_captures_immutable_delete BEFORE DELETE ON surgical_captures BEGIN SELECT RAISE(ABORT,'surgical captures are immutable'); END;

CREATE TABLE IF NOT EXISTS search_providers (
  id TEXT PRIMARY KEY,
  kind TEXT NOT NULL CHECK(kind IN ('fixture','endpoint')),
  label TEXT NOT NULL,
  endpoint_url TEXT,
  enabled INTEGER NOT NULL DEFAULT 0,
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL
);
INSERT OR IGNORE INTO search_providers(id,kind,label,endpoint_url,enabled,created_at,updated_at) VALUES('fixture-search','fixture','Deterministic fixture search',NULL,0,datetime('now'),datetime('now'));
CREATE TABLE IF NOT EXISTS search_queries (
  id TEXT PRIMARY KEY,
  project_id TEXT NOT NULL,
  job_id TEXT NOT NULL UNIQUE REFERENCES phase7_jobs(id) ON DELETE RESTRICT,
  provider_id TEXT NOT NULL REFERENCES search_providers(id) ON DELETE RESTRICT,
  query TEXT NOT NULL,
  results_json TEXT NOT NULL,
  provenance_json TEXT NOT NULL,
  created_at TEXT NOT NULL
);
CREATE TRIGGER IF NOT EXISTS search_queries_immutable_update BEFORE UPDATE ON search_queries BEGIN SELECT RAISE(ABORT,'search queries are immutable'); END;
CREATE TRIGGER IF NOT EXISTS search_queries_immutable_delete BEFORE DELETE ON search_queries BEGIN SELECT RAISE(ABORT,'search queries are immutable'); END;
CREATE TABLE IF NOT EXISTS search_fetched_contexts (
  id TEXT PRIMARY KEY,
  search_query_id TEXT NOT NULL REFERENCES search_queries(id) ON DELETE RESTRICT,
  result_index INTEGER NOT NULL,
  requested_url TEXT NOT NULL,
  final_url TEXT NOT NULL,
  content_text TEXT NOT NULL,
  content_checksum TEXT NOT NULL,
  provenance_json TEXT NOT NULL,
  trust_class TEXT NOT NULL CHECK(trust_class='untrusted_reference'),
  fetched_at TEXT NOT NULL
);
CREATE TRIGGER IF NOT EXISTS search_contexts_immutable_update BEFORE UPDATE ON search_fetched_contexts BEGIN SELECT RAISE(ABORT,'search contexts are immutable'); END;
CREATE TRIGGER IF NOT EXISTS search_contexts_immutable_delete BEFORE DELETE ON search_fetched_contexts BEGIN SELECT RAISE(ABORT,'search contexts are immutable'); END;

CREATE TABLE IF NOT EXISTS figma_exchange_records (
  id TEXT PRIMARY KEY,
  direction TEXT NOT NULL CHECK(direction IN ('import','export')),
  project_id TEXT,
  component_id TEXT,
  revision_id TEXT,
  exchange_json TEXT NOT NULL,
  exchange_checksum TEXT NOT NULL,
  created_at TEXT NOT NULL
);
CREATE TRIGGER IF NOT EXISTS figma_exchange_immutable_update BEFORE UPDATE ON figma_exchange_records BEGIN SELECT RAISE(ABORT,'Figma exchange records are immutable'); END;
CREATE TRIGGER IF NOT EXISTS figma_exchange_immutable_delete BEFORE DELETE ON figma_exchange_records BEGIN SELECT RAISE(ABORT,'Figma exchange records are immutable'); END;
