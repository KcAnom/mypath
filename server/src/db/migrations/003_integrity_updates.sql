CREATE TRIGGER canvases_project_fk_update BEFORE UPDATE OF project_id ON canvases
WHEN NEW.project_id IS NOT NULL AND NOT EXISTS (SELECT 1 FROM projects WHERE id=NEW.project_id)
BEGIN SELECT RAISE(ABORT, 'fk canvases.project_id'); END;
CREATE TRIGGER components_project_fk_update BEFORE UPDATE OF project_id ON components
WHEN NEW.project_id IS NOT NULL AND NOT EXISTS (SELECT 1 FROM projects WHERE id=NEW.project_id)
BEGIN SELECT RAISE(ABORT, 'fk components.project_id'); END;
CREATE TRIGGER revisions_component_fk_update BEFORE UPDATE OF component_id ON revisions
WHEN NEW.component_id IS NOT NULL AND NOT EXISTS (SELECT 1 FROM components WHERE id=NEW.component_id)
BEGIN SELECT RAISE(ABORT, 'fk revisions.component_id'); END;
CREATE TRIGGER revision_files_revision_fk_update BEFORE UPDATE OF revision_id ON revision_files
WHEN NOT EXISTS (SELECT 1 FROM revisions WHERE id=NEW.revision_id)
BEGIN SELECT RAISE(ABORT, 'fk revision_files.revision_id'); END;
CREATE TRIGGER jobs_component_fk_update BEFORE UPDATE OF component_id ON jobs
WHEN NEW.component_id IS NOT NULL AND NOT EXISTS (SELECT 1 FROM components WHERE id=NEW.component_id)
BEGIN SELECT RAISE(ABORT, 'fk jobs.component_id'); END;
CREATE TRIGGER jobs_revision_fk_update BEFORE UPDATE OF revision_id ON jobs
WHEN NEW.revision_id IS NOT NULL AND NOT EXISTS (SELECT 1 FROM revisions WHERE id=NEW.revision_id)
BEGIN SELECT RAISE(ABORT, 'fk jobs.revision_id'); END;
CREATE TRIGGER chat_threads_project_fk_update BEFORE UPDATE OF project_id ON chat_threads
WHEN NEW.project_id IS NOT NULL AND NOT EXISTS (SELECT 1 FROM projects WHERE id=NEW.project_id)
BEGIN SELECT RAISE(ABORT, 'fk chat_threads.project_id'); END;
CREATE TRIGGER chat_messages_thread_fk_update BEFORE UPDATE OF thread_id ON chat_messages
WHEN NEW.thread_id IS NOT NULL AND NOT EXISTS (SELECT 1 FROM chat_threads WHERE id=NEW.thread_id)
BEGIN SELECT RAISE(ABORT, 'fk chat_messages.thread_id'); END;
CREATE TRIGGER assets_project_fk_update BEFORE UPDATE OF project_id ON assets
WHEN NEW.project_id IS NOT NULL AND NOT EXISTS (SELECT 1 FROM projects WHERE id=NEW.project_id)
BEGIN SELECT RAISE(ABORT, 'fk assets.project_id'); END;
CREATE TRIGGER library_memberships_library_fk_update BEFORE UPDATE OF library_id ON library_memberships
WHEN NOT EXISTS (SELECT 1 FROM libraries WHERE id=NEW.library_id)
BEGIN SELECT RAISE(ABORT, 'fk library_memberships.library_id'); END;
CREATE TRIGGER library_memberships_component_fk_update BEFORE UPDATE OF component_id ON library_memberships
WHEN NOT EXISTS (SELECT 1 FROM components WHERE id=NEW.component_id)
BEGIN SELECT RAISE(ABORT, 'fk library_memberships.component_id'); END;
CREATE TRIGGER library_memberships_revision_fk_update BEFORE UPDATE OF revision_id ON library_memberships
WHEN NEW.revision_id IS NOT NULL AND NOT EXISTS (SELECT 1 FROM revisions WHERE id=NEW.revision_id)
BEGIN SELECT RAISE(ABORT, 'fk library_memberships.revision_id'); END;
