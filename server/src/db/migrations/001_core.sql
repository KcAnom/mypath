PRAGMA foreign_keys = ON;

CREATE TABLE IF NOT EXISTS schema_migrations (
  version INTEGER PRIMARY KEY,
  name TEXT NOT NULL,
  applied_at TEXT NOT NULL
);

CREATE TABLE IF NOT EXISTS settings (
  key TEXT PRIMARY KEY,
  value_json TEXT NOT NULL,
  legacy_extra_json TEXT
);

CREATE TABLE IF NOT EXISTS import_reports (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  source_path TEXT NOT NULL,
  source_checksum TEXT NOT NULL UNIQUE,
  source_size INTEGER NOT NULL,
  imported_at TEXT NOT NULL,
  archive_path TEXT,
  report_json TEXT NOT NULL
);

CREATE TABLE IF NOT EXISTS projects (
  id TEXT PRIMARY KEY,
  name TEXT NOT NULL,
  description TEXT NOT NULL DEFAULT '',
  created_at TEXT,
  updated_at TEXT,
  ordinal INTEGER NOT NULL,
  data_json TEXT NOT NULL
);

CREATE TABLE IF NOT EXISTS canvases (
  id TEXT PRIMARY KEY,
  project_id TEXT NOT NULL REFERENCES projects(id) ON DELETE RESTRICT,
  version INTEGER NOT NULL DEFAULT 1,
  document_format TEXT NOT NULL DEFAULT 'legacy-v0',
  shapes_json TEXT NOT NULL,
  camera_json TEXT NOT NULL,
  updated_at TEXT,
  ordinal INTEGER NOT NULL,
  data_json TEXT NOT NULL
);

CREATE TABLE IF NOT EXISTS components (
  id TEXT PRIMARY KEY,
  project_id TEXT NOT NULL REFERENCES projects(id) ON DELETE RESTRICT,
  generated_name TEXT,
  selected_revision_id TEXT,
  ordinal INTEGER NOT NULL,
  data_json TEXT NOT NULL
);
CREATE UNIQUE INDEX IF NOT EXISTS components_project_generated_name
  ON components(project_id, generated_name) WHERE generated_name IS NOT NULL;

CREATE TABLE IF NOT EXISTS revisions (
  id TEXT PRIMARY KEY,
  component_id TEXT NOT NULL REFERENCES components(id) ON DELETE RESTRICT,
  status TEXT,
  created_at TEXT,
  ordinal INTEGER NOT NULL,
  data_json TEXT NOT NULL
);
CREATE TABLE IF NOT EXISTS revision_files (
  revision_id TEXT NOT NULL REFERENCES revisions(id) ON DELETE RESTRICT,
  path TEXT NOT NULL,
  content TEXT NOT NULL,
  content_checksum TEXT NOT NULL,
  PRIMARY KEY(revision_id, path)
);

CREATE TABLE IF NOT EXISTS jobs (
  id TEXT PRIMARY KEY,
  component_id TEXT REFERENCES components(id) ON DELETE RESTRICT,
  revision_id TEXT REFERENCES revisions(id) ON DELETE RESTRICT,
  status TEXT,
  ordinal INTEGER NOT NULL,
  data_json TEXT NOT NULL
);
CREATE TABLE IF NOT EXISTS design_systems (id TEXT PRIMARY KEY, ordinal INTEGER NOT NULL, data_json TEXT NOT NULL);
CREATE TABLE IF NOT EXISTS libraries (id TEXT PRIMARY KEY, ordinal INTEGER NOT NULL, data_json TEXT NOT NULL);
CREATE TABLE IF NOT EXISTS library_memberships (
  library_id TEXT NOT NULL REFERENCES libraries(id) ON DELETE RESTRICT,
  component_id TEXT NOT NULL REFERENCES components(id) ON DELETE RESTRICT,
  revision_id TEXT REFERENCES revisions(id) ON DELETE RESTRICT,
  ordinal INTEGER NOT NULL,
  PRIMARY KEY(library_id, component_id)
);
CREATE TABLE IF NOT EXISTS skills (id TEXT PRIMARY KEY, ordinal INTEGER NOT NULL, data_json TEXT NOT NULL);
CREATE TABLE IF NOT EXISTS chat_threads (
  id TEXT PRIMARY KEY,
  project_id TEXT REFERENCES projects(id) ON DELETE RESTRICT,
  scope TEXT NOT NULL DEFAULT 'legacy_unscoped',
  ordinal INTEGER NOT NULL,
  data_json TEXT NOT NULL
);
CREATE TABLE IF NOT EXISTS chat_messages (
  id TEXT PRIMARY KEY,
  thread_id TEXT NOT NULL REFERENCES chat_threads(id) ON DELETE RESTRICT,
  ordinal INTEGER NOT NULL,
  data_json TEXT NOT NULL
);
CREATE TABLE IF NOT EXISTS assets (
  id TEXT PRIMARY KEY,
  project_id TEXT REFERENCES projects(id) ON DELETE RESTRICT,
  kind TEXT NOT NULL DEFAULT 'image',
  tombstoned_at TEXT,
  ordinal INTEGER NOT NULL,
  data_json TEXT NOT NULL
);
CREATE TABLE IF NOT EXISTS fonts (id TEXT PRIMARY KEY, ordinal INTEGER NOT NULL, data_json TEXT NOT NULL);
CREATE TABLE IF NOT EXISTS asset_references (
  asset_id TEXT NOT NULL REFERENCES assets(id) ON DELETE RESTRICT,
  owner_type TEXT NOT NULL,
  owner_id TEXT NOT NULL,
  historical INTEGER NOT NULL DEFAULT 0,
  PRIMARY KEY(asset_id, owner_type, owner_id)
);
CREATE TABLE IF NOT EXISTS tombstones (
  entity_type TEXT NOT NULL,
  entity_id TEXT NOT NULL,
  deleted_at TEXT NOT NULL,
  metadata_json TEXT,
  PRIMARY KEY(entity_type, entity_id)
);
CREATE TABLE IF NOT EXISTS quarantine_rows (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  source_checksum TEXT,
  entity_type TEXT NOT NULL,
  entity_id TEXT,
  reason TEXT NOT NULL,
  data_json TEXT NOT NULL,
  created_at TEXT NOT NULL
);
