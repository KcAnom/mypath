-- Phase 5: immutable operational design-system compilations, local fonts,
-- exact library membership/reuse, versioned text-only skills, and reviewed theme extraction.
CREATE TABLE IF NOT EXISTS font_records (
  id TEXT PRIMARY KEY,
  asset_id TEXT NOT NULL UNIQUE REFERENCES asset_ingestions(id) ON DELETE RESTRICT,
  family TEXT NOT NULL,
  weight INTEGER NOT NULL DEFAULT 400 CHECK(weight BETWEEN 100 AND 900),
  style TEXT NOT NULL DEFAULT 'normal' CHECK(style IN ('normal','italic','oblique')),
  created_at TEXT NOT NULL
);
CREATE TABLE IF NOT EXISTS project_fonts (
  project_id TEXT NOT NULL,
  font_id TEXT NOT NULL REFERENCES font_records(id) ON DELETE RESTRICT,
  active INTEGER NOT NULL DEFAULT 1 CHECK(active IN (0,1)),
  PRIMARY KEY(project_id,font_id)
);

CREATE TABLE IF NOT EXISTS design_system_compilations (
  version_id TEXT PRIMARY KEY REFERENCES design_system_versions(id) ON DELETE RESTRICT,
  content_checksum TEXT NOT NULL,
  compiled_css TEXT NOT NULL,
  prompt_text TEXT NOT NULL,
  light_json TEXT NOT NULL,
  dark_json TEXT NOT NULL,
  font_refs_json TEXT NOT NULL DEFAULT '[]',
  created_at TEXT NOT NULL
);
CREATE TRIGGER IF NOT EXISTS design_system_compilations_immutable_update BEFORE UPDATE ON design_system_compilations BEGIN SELECT RAISE(ABORT,'design-system compilations are immutable'); END;
CREATE TRIGGER IF NOT EXISTS design_system_compilations_immutable_delete BEFORE DELETE ON design_system_compilations BEGIN SELECT RAISE(ABORT,'design-system compilations are immutable'); END;

CREATE TABLE IF NOT EXISTS library_revision_memberships (
  library_id TEXT NOT NULL,
  component_id TEXT NOT NULL,
  revision_id TEXT NOT NULL,
  ordinal INTEGER NOT NULL DEFAULT 0,
  added_at TEXT NOT NULL,
  PRIMARY KEY(library_id,component_id),
  UNIQUE(library_id,revision_id)
);
CREATE TABLE IF NOT EXISTS library_reuse_events (
  id TEXT PRIMARY KEY,
  library_id TEXT NOT NULL,
  source_component_id TEXT NOT NULL,
  source_revision_id TEXT NOT NULL,
  target_project_id TEXT NOT NULL,
  target_component_id TEXT,
  target_revision_id TEXT,
  action TEXT NOT NULL CHECK(action IN ('canvas','copy')),
  canvas_publication_id TEXT,
  created_at TEXT NOT NULL
);

CREATE TABLE IF NOT EXISTS skill_versions (
  id TEXT PRIMARY KEY,
  skill_id TEXT NOT NULL,
  version INTEGER NOT NULL,
  name TEXT NOT NULL,
  description TEXT NOT NULL,
  content TEXT NOT NULL,
  files_json TEXT NOT NULL DEFAULT '[]',
  content_checksum TEXT NOT NULL,
  builtin INTEGER NOT NULL DEFAULT 0 CHECK(builtin IN (0,1)),
  optional_activation INTEGER NOT NULL DEFAULT 0 CHECK(optional_activation IN (0,1)),
  created_at TEXT NOT NULL,
  UNIQUE(skill_id,version)
);
CREATE TABLE IF NOT EXISTS skill_imports (
  id TEXT PRIMARY KEY,
  skill_id TEXT NOT NULL,
  skill_version_id TEXT NOT NULL REFERENCES skill_versions(id) ON DELETE RESTRICT,
  package_checksum TEXT NOT NULL,
  package_name TEXT NOT NULL,
  file_count INTEGER NOT NULL,
  uncompressed_bytes INTEGER NOT NULL,
  created_at TEXT NOT NULL
);
CREATE TRIGGER IF NOT EXISTS skill_versions_immutable_update BEFORE UPDATE ON skill_versions BEGIN SELECT RAISE(ABORT,'skill versions are immutable'); END;
CREATE TRIGGER IF NOT EXISTS skill_versions_immutable_delete BEFORE DELETE ON skill_versions BEGIN SELECT RAISE(ABORT,'skill versions are immutable'); END;

CREATE TABLE IF NOT EXISTS theme_extraction_reviews (
  id TEXT PRIMARY KEY,
  source_kind TEXT NOT NULL CHECK(source_kind IN ('css','url')),
  source_url TEXT,
  final_url TEXT,
  status TEXT NOT NULL CHECK(status IN ('pending','approved','rejected','failed')),
  proposal_json TEXT,
  diagnostics_json TEXT NOT NULL DEFAULT '[]',
  response_metadata_json TEXT NOT NULL DEFAULT '{}',
  created_design_system_id TEXT,
  created_version_id TEXT,
  created_at TEXT NOT NULL,
  reviewed_at TEXT
);
