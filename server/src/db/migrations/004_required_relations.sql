DROP TRIGGER canvases_project_fk_insert;
DROP TRIGGER components_project_fk_insert;
DROP TRIGGER revisions_component_fk_insert;
DROP TRIGGER chat_messages_thread_fk_insert;
DROP TRIGGER canvases_project_fk_update;
DROP TRIGGER components_project_fk_update;
DROP TRIGGER revisions_component_fk_update;
DROP TRIGGER chat_messages_thread_fk_update;

CREATE TRIGGER canvases_project_fk_insert BEFORE INSERT ON canvases
WHEN NEW.project_id IS NULL OR NOT EXISTS (SELECT 1 FROM projects WHERE id=NEW.project_id)
BEGIN SELECT RAISE(ABORT, 'fk canvases.project_id'); END;
CREATE TRIGGER components_project_fk_insert BEFORE INSERT ON components
WHEN NEW.project_id IS NULL OR NOT EXISTS (SELECT 1 FROM projects WHERE id=NEW.project_id)
BEGIN SELECT RAISE(ABORT, 'fk components.project_id'); END;
CREATE TRIGGER revisions_component_fk_insert BEFORE INSERT ON revisions
WHEN NEW.component_id IS NULL OR NOT EXISTS (SELECT 1 FROM components WHERE id=NEW.component_id)
BEGIN SELECT RAISE(ABORT, 'fk revisions.component_id'); END;
CREATE TRIGGER chat_messages_thread_fk_insert BEFORE INSERT ON chat_messages
WHEN NEW.thread_id IS NULL OR NOT EXISTS (SELECT 1 FROM chat_threads WHERE id=NEW.thread_id)
BEGIN SELECT RAISE(ABORT, 'fk chat_messages.thread_id'); END;
CREATE TRIGGER canvases_project_fk_update BEFORE UPDATE OF project_id ON canvases
WHEN NEW.project_id IS NULL OR NOT EXISTS (SELECT 1 FROM projects WHERE id=NEW.project_id)
BEGIN SELECT RAISE(ABORT, 'fk canvases.project_id'); END;
CREATE TRIGGER components_project_fk_update BEFORE UPDATE OF project_id ON components
WHEN NEW.project_id IS NULL OR NOT EXISTS (SELECT 1 FROM projects WHERE id=NEW.project_id)
BEGIN SELECT RAISE(ABORT, 'fk components.project_id'); END;
CREATE TRIGGER revisions_component_fk_update BEFORE UPDATE OF component_id ON revisions
WHEN NEW.component_id IS NULL OR NOT EXISTS (SELECT 1 FROM components WHERE id=NEW.component_id)
BEGIN SELECT RAISE(ABORT, 'fk revisions.component_id'); END;
CREATE TRIGGER chat_messages_thread_fk_update BEFORE UPDATE OF thread_id ON chat_messages
WHEN NEW.thread_id IS NULL OR NOT EXISTS (SELECT 1 FROM chat_threads WHERE id=NEW.thread_id)
BEGIN SELECT RAISE(ABORT, 'fk chat_messages.thread_id'); END;
