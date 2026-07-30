ALTER TABLE projects ADD COLUMN deleted_at TEXT;
ALTER TABLE components ADD COLUMN deleted_at TEXT;

DROP INDEX IF EXISTS components_project_generated_name;
CREATE UNIQUE INDEX components_project_generated_name
  ON components(project_id, generated_name)
  WHERE generated_name IS NOT NULL AND deleted_at IS NULL;

CREATE TRIGGER canvases_project_fk_insert BEFORE INSERT ON canvases
WHEN NEW.project_id IS NOT NULL AND NOT EXISTS (SELECT 1 FROM projects WHERE id=NEW.project_id)
BEGIN SELECT RAISE(ABORT, 'fk canvases.project_id'); END;
CREATE TRIGGER components_project_fk_insert BEFORE INSERT ON components
WHEN NEW.project_id IS NOT NULL AND NOT EXISTS (SELECT 1 FROM projects WHERE id=NEW.project_id)
BEGIN SELECT RAISE(ABORT, 'fk components.project_id'); END;
CREATE TRIGGER revisions_component_fk_insert BEFORE INSERT ON revisions
WHEN NEW.component_id IS NOT NULL AND NOT EXISTS (SELECT 1 FROM components WHERE id=NEW.component_id)
BEGIN SELECT RAISE(ABORT, 'fk revisions.component_id'); END;
CREATE TRIGGER revision_files_revision_fk_insert BEFORE INSERT ON revision_files
WHEN NOT EXISTS (SELECT 1 FROM revisions WHERE id=NEW.revision_id)
BEGIN SELECT RAISE(ABORT, 'fk revision_files.revision_id'); END;
CREATE TRIGGER jobs_component_fk_insert BEFORE INSERT ON jobs
WHEN NEW.component_id IS NOT NULL AND NOT EXISTS (SELECT 1 FROM components WHERE id=NEW.component_id)
BEGIN SELECT RAISE(ABORT, 'fk jobs.component_id'); END;
CREATE TRIGGER jobs_revision_fk_insert BEFORE INSERT ON jobs
WHEN NEW.revision_id IS NOT NULL AND NOT EXISTS (SELECT 1 FROM revisions WHERE id=NEW.revision_id)
BEGIN SELECT RAISE(ABORT, 'fk jobs.revision_id'); END;
CREATE TRIGGER chat_threads_project_fk_insert BEFORE INSERT ON chat_threads
WHEN NEW.project_id IS NOT NULL AND NOT EXISTS (SELECT 1 FROM projects WHERE id=NEW.project_id)
BEGIN SELECT RAISE(ABORT, 'fk chat_threads.project_id'); END;
CREATE TRIGGER chat_messages_thread_fk_insert BEFORE INSERT ON chat_messages
WHEN NEW.thread_id IS NOT NULL AND NOT EXISTS (SELECT 1 FROM chat_threads WHERE id=NEW.thread_id)
BEGIN SELECT RAISE(ABORT, 'fk chat_messages.thread_id'); END;
CREATE TRIGGER assets_project_fk_insert BEFORE INSERT ON assets
WHEN NEW.project_id IS NOT NULL AND NOT EXISTS (SELECT 1 FROM projects WHERE id=NEW.project_id)
BEGIN SELECT RAISE(ABORT, 'fk assets.project_id'); END;
CREATE TRIGGER library_memberships_library_fk_insert BEFORE INSERT ON library_memberships
WHEN NOT EXISTS (SELECT 1 FROM libraries WHERE id=NEW.library_id)
BEGIN SELECT RAISE(ABORT, 'fk library_memberships.library_id'); END;
CREATE TRIGGER library_memberships_component_fk_insert BEFORE INSERT ON library_memberships
WHEN NOT EXISTS (SELECT 1 FROM components WHERE id=NEW.component_id)
BEGIN SELECT RAISE(ABORT, 'fk library_memberships.component_id'); END;
CREATE TRIGGER library_memberships_revision_fk_insert BEFORE INSERT ON library_memberships
WHEN NEW.revision_id IS NOT NULL AND NOT EXISTS (SELECT 1 FROM revisions WHERE id=NEW.revision_id)
BEGIN SELECT RAISE(ABORT, 'fk library_memberships.revision_id'); END;
