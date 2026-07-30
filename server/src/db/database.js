import crypto from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import { fileURLToPath } from 'node:url';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const MIGRATIONS = path.join(HERE, 'migrations');
const ARRAY_TABLES = {
  projects: 'projects', canvases: 'canvases', components: 'components', revisions: 'revisions', jobs: 'jobs',
  designSystems: 'design_systems', libraries: 'libraries', skills: 'skills', chatThreads: 'chat_threads',
  chatMessages: 'chat_messages', images: 'assets', fonts: 'fonts',
};
const GOOGLE_FONT_IMPORT = /@import\s+(?:url\()?['"]?https:\/\/fonts\.googleapis\.com\/[^;\n]+;?/gi;

export function checksum(value) {
  return crypto.createHash('sha256').update(value).digest('hex');
}

function json(value) { return JSON.stringify(value ?? null); }
function parsed(value, fallback = null) {
  try { return JSON.parse(value); } catch { return fallback; }
}
function now() { return new Date().toISOString(); }

function readLegacy(sourcePath) {
  if (!fs.existsSync(sourcePath)) return null;
  const bytes = fs.readFileSync(sourcePath);
  let data;
  try { data = JSON.parse(bytes.toString('utf8')); }
  catch (error) {
    const wrapped = Object.assign(new Error(`Legacy database is not valid JSON: ${error.message}`), { code: 'legacy_json_corrupt' });
    throw wrapped;
  }
  if (!data || typeof data !== 'object' || Array.isArray(data)) {
    const error = Object.assign(new Error('Legacy database root must be an object'), { code: 'legacy_json_invalid' });
    throw error;
  }
  return { bytes, data, checksum: checksum(bytes), size: bytes.length, sourcePath };
}

function stripRemoteFonts(files, transformations, owner) {
  if (!files || typeof files !== 'object' || Array.isArray(files)) return files;
  const result = { ...files };
  for (const [name, value] of Object.entries(result)) {
    if (typeof value !== 'string') continue;
    const next = value.replace(GOOGLE_FONT_IMPORT, '');
    if (next !== value) {
      transformations.push({ entity: owner, file: name, kind: 'removed_google_font_import', originalChecksum: checksum(value) });
      result[name] = next;
    }
  }
  return result;
}

function preflightLegacy(input) {
  const data = structuredClone(input.data);
  const report = {
    checksum: input.checksum, sourceSize: input.size, counts: {}, collisions: [], orphans: [], unresolvedBlobs: [],
    transformations: [], unsupportedRootFields: [], quarantineRows: [],
  };
  const quarantine = (entity, item, reason) => {
    const entry = { entity, id: item?.id || null, reason, data: item };
    report.quarantineRows.push(entry);
    report.orphans.push({ entity, id: entry.id, reason });
  };
  for (const key of Object.keys(ARRAY_TABLES)) {
    if (!Array.isArray(data[key])) data[key] = [];
    report.counts[key] = data[key].length;
  }
  const supported = new Set(['meta', 'user', ...Object.keys(ARRAY_TABLES)]);
  report.unsupportedRootFields = Object.keys(data).filter((key) => !supported.has(key));

  data.projects = data.projects.filter((project) => {
    if (!project?.id) { quarantine('project', project, 'missing_id'); return false; }
    return true;
  });
  const projectIds = new Set(data.projects.map((project) => project.id));

  data.canvases = data.canvases.filter((canvas) => {
    if (!canvas?.id || !canvas.projectId || !projectIds.has(canvas.projectId)) {
      quarantine('canvas', canvas, `missing_project:${canvas?.projectId || ''}`); return false;
    }
    return true;
  });

  const generated = new Set();
  data.components = data.components.flatMap((item, index) => {
    const component = { ...item };
    if (!component.id) component.id = `legacy-component-${index}-${input.checksum.slice(0, 8)}`;
    if (!component.projectId || !projectIds.has(component.projectId)) {
      quarantine('component', component, `missing_project:${component.projectId || ''}`); return [];
    }
    const base = String(component.generatedName || 'component');
    let candidate = base;
    let suffix = 2;
    while (generated.has(`${component.projectId}\0${candidate}`)) candidate = `${base}-${suffix++}`;
    if (candidate !== component.generatedName) {
      if (component.generatedName) report.collisions.push({ entity: 'component', id: component.id, original: component.generatedName, normalized: candidate });
      component.generatedName = candidate;
    }
    generated.add(`${component.projectId}\0${candidate}`);
    component.files = stripRemoteFonts(component.files, report.transformations, `component:${component.id}`);
    return [component];
  });
  const componentIds = new Set(data.components.map((component) => component.id));

  data.revisions = data.revisions.flatMap((item, index) => {
    const revision = { ...item };
    if (!revision.id) revision.id = `legacy-revision-${index}-${input.checksum.slice(0, 8)}`;
    if (!revision.componentId || !componentIds.has(revision.componentId)) {
      quarantine('revision', revision, `missing_component:${revision.componentId || ''}`); return [];
    }
    revision.files = stripRemoteFonts(revision.files, report.transformations, `revision:${revision.id}`);
    if (!revision.status) revision.status = 'imported_unbuilt';
    return [revision];
  });
  const revisions = new Map(data.revisions.map((revision) => [revision.id, revision]));
  for (const component of data.components) {
    const selected = revisions.get(component.selectedRevisionId);
    if (component.selectedRevisionId && (!selected || selected.componentId !== component.id)) {
      quarantine('component_relation', component, `missing_selected_revision:${component.selectedRevisionId}`);
      component.selectedRevisionId = null;
    }
    const currentSelected = revisions.get(component.selectedRevisionId);
    const mutable = component.files && typeof component.files === 'object' ? component.files : null;
    if (!mutable) continue;
    const differs = !currentSelected || json(mutable) !== json(currentSelected.files || null) || (component.code != null && component.code !== (currentSelected.code ?? null));
    if (!differs) continue;
    const fingerprint = checksum(`${component.id}\0${json(mutable)}\0${component.code || ''}`);
    let syntheticId = `imported-${fingerprint.slice(0, 24)}`;
    while (revisions.has(syntheticId)) syntheticId += '-copy';
    const synthetic = {
      id: syntheticId, componentId: component.id, status: 'imported_unbuilt', note: 'synthetic legacy mutable snapshot',
      files: mutable, code: component.code || '', createdAt: component.updatedAt || component.createdAt || now(),
      provenance: { kind: 'legacy_mutable_snapshot', sourceChecksum: input.checksum },
    };
    data.revisions.push(synthetic);
    revisions.set(syntheticId, synthetic);
    component.selectedRevisionId = syntheticId;
    report.transformations.push({ entity: `component:${component.id}`, kind: 'created_synthetic_revision', revisionId: syntheticId });
  }
  const revisionIds = new Set(data.revisions.map((revision) => revision.id));

  data.jobs = data.jobs.filter((job) => {
    if (!job?.id || (job.componentId && !componentIds.has(job.componentId)) || (job.revisionId && !revisionIds.has(job.revisionId))) {
      quarantine('job', job, 'missing_component_or_revision'); return false;
    }
    return true;
  });

  for (const canvas of data.canvases) {
    canvas.shapes = (canvas.shapes || []).filter((shape) => {
      if (shape?.componentId && !componentIds.has(shape.componentId)) {
        quarantine('canvas_shape', shape, `missing_component:${shape.componentId}`); return false;
      }
      return true;
    });
  }

  data.chatThreads = data.chatThreads.filter((thread) => {
    if (!thread?.id) { quarantine('chat_thread', thread, 'missing_id'); return false; }
    if (thread.projectId && !projectIds.has(thread.projectId)) {
      quarantine('chat_thread_relation', thread, `missing_project:${thread.projectId}`);
      thread.projectId = null;
      thread.scope = 'legacy_unscoped';
    }
    return true;
  });
  const threadIds = new Set(data.chatThreads.map((thread) => thread.id));
  data.chatMessages = data.chatMessages.filter((message) => {
    if (!message?.id || !message.threadId || !threadIds.has(message.threadId)) {
      quarantine('chat_message', message, `missing_thread:${message?.threadId || ''}`); return false;
    }
    return true;
  });

  for (const library of data.libraries) {
    const retained = [];
    for (const componentId of library.componentIds || []) {
      if (componentIds.has(componentId)) retained.push(componentId);
      else quarantine('library_membership', { id: `${library.id}:${componentId}`, libraryId: library.id, componentId }, `missing_component:${componentId}`);
    }
    library.componentIds = retained;
  }

  data.images = data.images.flatMap((item) => {
    const image = { ...item };
    if (!image.id || (image.projectId && !projectIds.has(image.projectId))) {
      quarantine('asset', image, `missing_project:${image.projectId || ''}`); return [];
    }
    const local = image.path || image.filePath || (typeof image.url === 'string' && !/^(?:https?:|data:)/i.test(image.url) ? image.url.replace(/^\/+/, '') : null);
    const inlineBlob = typeof image.data === 'string' || typeof image.base64 === 'string' || (typeof image.url === 'string' && image.url.startsWith('data:'));
    const candidate = local ? (path.isAbsolute(local) ? local : path.resolve(path.dirname(input.sourcePath), local)) : null;
    const hasFile = candidate && fs.existsSync(candidate) && fs.statSync(candidate).isFile();
    if (!image.tombstonedAt && !hasFile && !inlineBlob) {
      report.unresolvedBlobs.push({ entity: 'image', id: image.id, path: local || null });
      image.legacyProvenance = { ...(image.legacyProvenance || {}), missingBlobPath: local || null, originalUrl: image.url || null };
      image.tombstonedAt = image.tombstonedAt || now();
      image.disabled = true;
      image.url = null;
      delete image.path;
      delete image.filePath;
    }
    return [image];
  });

  data.fonts = data.fonts.map((item) => {
    const font = { ...item };
    const local = font.path || font.filePath;
    const candidate = local ? (path.isAbsolute(local) ? local : path.resolve(path.dirname(input.sourcePath), local)) : null;
    if (!font.disabled && (!candidate || !fs.existsSync(candidate) || !fs.statSync(candidate).isFile())) {
      font.disabled = true;
      font.unresolvedPath = local || null;
      report.unresolvedBlobs.push({ entity: 'font', id: font.id, path: local || null });
    }
    return font;
  });
  report.counts.revisionsImported = data.revisions.length;
  report.counts.quarantined = report.quarantineRows.length;
  return { data, report };
}

export class MyPathDatabase {
  constructor(dataDir) {
    this.dataDir = dataDir;
    this.dbPath = path.join(dataDir, 'db.sqlite');
    this.legacyPath = path.join(dataDir, 'db.json');
    fs.mkdirSync(dataDir, { recursive: true });
    // Parse before opening SQLite so corrupt legacy input cannot create or alter the target.
    const legacy = readLegacy(this.legacyPath);
    this.db = new DatabaseSync(this.dbPath);
    try {
      this.db.exec('PRAGMA foreign_keys=ON; PRAGMA journal_mode=WAL; PRAGMA synchronous=FULL; PRAGMA busy_timeout=5000;');
      this.migrate();
      if (legacy) this.importLegacy(legacy);
      if (!this.getSetting('meta')) this.saveState(this.seed());
      this.reconcileIntegrity();
    } catch (error) {
      this.db.close();
      throw error;
    }
  }

  migrate() {
    const files = fs.readdirSync(MIGRATIONS).filter((name) => /^\d+.*\.sql$/.test(name)).sort();
    this.db.exec('CREATE TABLE IF NOT EXISTS schema_migrations(version INTEGER PRIMARY KEY, name TEXT NOT NULL, applied_at TEXT NOT NULL)');
    for (const name of files) {
      const version = Number(name.match(/^\d+/)[0]);
      if (this.db.prepare('SELECT 1 FROM schema_migrations WHERE version=?').get(version)) continue;
      const sql = fs.readFileSync(path.join(MIGRATIONS, name), 'utf8');
      this.db.exec('BEGIN IMMEDIATE');
      try {
        this.db.exec(sql);
        this.db.prepare('INSERT INTO schema_migrations(version,name,applied_at) VALUES(?,?,?)').run(version, name, now());
        this.db.exec('COMMIT');
      } catch (error) { this.db.exec('ROLLBACK'); throw error; }
    }
  }

  /** @returns {Record<string, any>} */
  seed() {
    const t = now();
    return { meta: { version: 3, product: 'mypath', mode: 'local-solo', createdAt: t }, user: { id: 'local-user', displayName: 'Me', createdAt: t }, ...Object.fromEntries(Object.keys(ARRAY_TABLES).map((key) => [key, []])) };
  }

  getSetting(key) {
    const row = this.db.prepare('SELECT value_json FROM settings WHERE key=?').get(key);
    return row ? parsed(row.value_json) : null;
  }

  importLegacy(input) {
    const existing = this.db.prepare('SELECT * FROM import_reports WHERE source_checksum=?').get(input.checksum);
    if (existing) return this.finishArchive(input.checksum, existing.id);
    const other = this.db.prepare('SELECT source_checksum FROM import_reports LIMIT 1').get();
    if (other) {
      const priorChecksum = String(other.source_checksum);
      const error = Object.assign(new Error(`Refusing legacy import ${input.checksum.slice(0, 12)}: database already imported ${priorChecksum.slice(0, 12)}`), { code: 'legacy_checksum_conflict' });
      throw error;
    }
    const { data, report } = preflightLegacy(input);
    this.db.exec('BEGIN IMMEDIATE');
    try {
      this.saveState(data, false);
      for (const row of report.quarantineRows) {
        this.db.prepare('INSERT INTO quarantine_rows(source_checksum,entity_type,entity_id,reason,data_json,created_at) VALUES(?,?,?,?,?,?)')
          .run(input.checksum, row.entity, row.id || null, row.reason, json(row.data), now());
      }
      const info = this.db.prepare('INSERT INTO import_reports(source_path,source_checksum,source_size,imported_at,archive_path,report_json) VALUES(?,?,?,?,NULL,?)')
        .run(this.legacyPath, input.checksum, input.size, now(), json(report));
      this.db.exec('COMMIT');
      this.finishArchive(input.checksum, Number(info.lastInsertRowid));
    } catch (error) { this.db.exec('ROLLBACK'); throw error; }
  }

  finishArchive(sourceChecksum, reportId) {
    if (!fs.existsSync(this.legacyPath)) return;
    const current = fs.readFileSync(this.legacyPath);
    if (checksum(current) !== sourceChecksum) {
      const error = Object.assign(new Error('Legacy JSON changed after it was imported'), { code: 'legacy_checksum_conflict' });
      throw error;
    }
    const archive = `${this.legacyPath}.legacy.${sourceChecksum.slice(0, 12)}`;
    if (fs.existsSync(archive)) {
      if (checksum(fs.readFileSync(archive)) !== sourceChecksum) throw new Error(`Legacy archive already exists with different content: ${archive}`);
      fs.unlinkSync(this.legacyPath);
    } else fs.renameSync(this.legacyPath, archive);
    this.db.prepare('UPDATE import_reports SET archive_path=? WHERE id=?').run(archive, reportId);
  }

  reconcileIntegrity() {
    const current = this.loadState();
    const input = { data: current, checksum: 'runtime-reconciliation', size: 0, sourcePath: this.dbPath };
    const { data, report } = preflightLegacy(input);
    if (!report.quarantineRows.length && !report.unresolvedBlobs.length && !report.transformations.length) return;
    this.db.exec('BEGIN IMMEDIATE');
    try {
      this.saveState(data, false);
      for (const row of report.quarantineRows) {
        const encoded = json(row.data);
        const exists = this.db.prepare('SELECT 1 FROM quarantine_rows WHERE source_checksum IS NULL AND entity_type=? AND entity_id IS ? AND reason=? AND data_json=?').get(row.entity, row.id || null, row.reason, encoded);
        if (!exists) this.db.prepare('INSERT INTO quarantine_rows(source_checksum,entity_type,entity_id,reason,data_json,created_at) VALUES(NULL,?,?,?,?,?)').run(row.entity, row.id || null, row.reason, encoded, now());
      }
      this.db.exec('COMMIT');
    } catch (error) { this.db.exec('ROLLBACK'); throw error; }
  }

  /** @returns {Record<string, any>} */
  loadState() {
    const result = this.seed();
    result.meta = this.getSetting('meta') || result.meta;
    result.user = this.getSetting('user') || result.user;
    const extra = this.getSetting('legacy-root-extra') || {};
    Object.assign(result, extra);
    for (const [key, table] of Object.entries(ARRAY_TABLES)) {
      if (table === 'canvases') {
        result[key] = this.db.prepare('SELECT data_json,version,document_format,camera_json,updated_at FROM canvases ORDER BY ordinal').all().map((row) => ({
          ...parsed(row.data_json, {}), version: Number(row.version), documentFormat: row.document_format,
          camera: parsed(row.camera_json, {}), updatedAt: row.updated_at || parsed(row.data_json, {}).updatedAt,
        }));
      } else result[key] = this.db.prepare(`SELECT data_json FROM ${table} ORDER BY ordinal`).all().map((row) => parsed(row.data_json, {}));
    }
    return result;
  }

  /** @param {Record<string, any>} state */
  saveState(state, transaction = true) {
    if (transaction) this.db.exec('BEGIN IMMEDIATE');
    try {
      this.db.prepare('INSERT INTO settings(key,value_json) VALUES(?,?) ON CONFLICT(key) DO UPDATE SET value_json=excluded.value_json').run('meta', json(state.meta || {}));
      this.db.prepare('INSERT INTO settings(key,value_json) VALUES(?,?) ON CONFLICT(key) DO UPDATE SET value_json=excluded.value_json').run('user', json(state.user || {}));
      const extra = Object.fromEntries(Object.entries(state).filter(([key]) => !ARRAY_TABLES[key] && key !== 'meta' && key !== 'user'));
      this.db.prepare('INSERT INTO settings(key,value_json) VALUES(?,?) ON CONFLICT(key) DO UPDATE SET value_json=excluded.value_json').run('legacy-root-extra', json(extra));
      this.db.exec(`
        DELETE FROM asset_references;
        DELETE FROM library_memberships;
        DELETE FROM revision_files;
        DELETE FROM chat_messages;
        DELETE FROM jobs
          WHERE COALESCE(json_extract(data_json, '$.phase3'), 0) != 1
            AND COALESCE(json_extract(data_json, '$.phase4'), 0) != 1;
        DELETE FROM revisions;
        DELETE FROM canvases;
        DELETE FROM assets;
        DELETE FROM components;
        DELETE FROM chat_threads;
        DELETE FROM projects;
        DELETE FROM design_systems;
        DELETE FROM libraries;
        DELETE FROM skills;
        DELETE FROM fonts;
      `);
      for (const [key, table] of Object.entries(ARRAY_TABLES)) (state[key] || []).forEach((item, ordinal) => this.insertEntity(table, item, ordinal));
      for (const revision of state.revisions || []) for (const [filePath, content] of Object.entries(revision.files || {})) {
        this.db.prepare('INSERT INTO revision_files(revision_id,path,content,content_checksum) VALUES(?,?,?,?)').run(revision.id, filePath, String(content), checksum(String(content)));
      }
      const revisionsByComponent = new Map((state.components || []).map((c) => [c.id, c.selectedRevisionId || null]));
      for (const lib of state.libraries || []) (lib.componentIds || []).forEach((componentId, ordinal) => {
        const exact = (lib.memberships || []).find((entry) => entry.componentId === componentId);
        this.db.prepare('INSERT OR IGNORE INTO library_memberships(library_id,component_id,revision_id,ordinal) VALUES(?,?,?,?)').run(lib.id, componentId, exact?.revisionId || revisionsByComponent.get(componentId) || null, exact?.ordinal ?? ordinal);
      });
      for (const project of state.projects || []) if (project.deletedAt) this.recordTombstone('project', project.id, project.deletedAt, project);
      for (const component of state.components || []) if (component.deletedAt) this.recordTombstone('component', component.id, component.deletedAt, { projectId: component.projectId, selectedRevisionId: component.selectedRevisionId });
      for (const asset of state.images || []) if (asset.tombstonedAt) this.recordTombstone('asset', asset.id, asset.tombstonedAt, asset.legacyProvenance || {});
      if (transaction) this.db.exec('COMMIT');
    } catch (error) { if (transaction) this.db.exec('ROLLBACK'); throw error; }
  }

  recordTombstone(entityType, entityId, deletedAt, metadata) {
    this.db.prepare('INSERT INTO tombstones(entity_type,entity_id,deleted_at,metadata_json) VALUES(?,?,?,?) ON CONFLICT(entity_type,entity_id) DO UPDATE SET deleted_at=excluded.deleted_at,metadata_json=excluded.metadata_json')
      .run(entityType, entityId, deletedAt, json(metadata));
  }

  insertEntity(table, item, ordinal) {
    const id = String(item?.id || `${table}-${ordinal}`);
    const data = json({ ...item, id });
    if (table === 'projects') return this.db.prepare('INSERT INTO projects(id,name,description,created_at,updated_at,ordinal,data_json,deleted_at) VALUES(?,?,?,?,?,?,?,?)').run(id, String(item.name || ''), String(item.description || ''), item.createdAt || null, item.updatedAt || null, ordinal, data, item.deletedAt || null);
    if (table === 'canvases') return this.db.prepare('INSERT INTO canvases(id,project_id,version,document_format,shapes_json,camera_json,updated_at,ordinal,data_json) VALUES(?,?,?,?,?,?,?,?,?)').run(id, item.projectId || null, Number(item.version || 1), item.documentFormat || 'legacy-v0', json(item.shapes || []), json(item.camera || {}), item.updatedAt || null, ordinal, data);
    if (table === 'components') return this.db.prepare('INSERT INTO components(id,project_id,generated_name,selected_revision_id,ordinal,data_json,deleted_at) VALUES(?,?,?,?,?,?,?)').run(id, item.projectId || null, item.generatedName || null, item.selectedRevisionId || null, ordinal, data, item.deletedAt || null);
    if (table === 'revisions') return this.db.prepare('INSERT INTO revisions(id,component_id,status,created_at,ordinal,data_json) VALUES(?,?,?,?,?,?)').run(id, item.componentId || null, item.status || null, item.createdAt || null, ordinal, data);
    // Phase-3/4 logical jobs are durable workflow rows, not compatibility projection
    // entries. Preserve them while the legacy store rewrites its other projections.
    if (table === 'jobs' && (item.phase3 === true || item.phase4 === true)) return;
    if (table === 'jobs') return this.db.prepare('INSERT INTO jobs(id,component_id,revision_id,status,ordinal,data_json) VALUES(?,?,?,?,?,?)').run(id, item.componentId || null, item.revisionId || null, item.status || null, ordinal, data);
    if (table === 'chat_threads') return this.db.prepare('INSERT INTO chat_threads(id,project_id,scope,ordinal,data_json) VALUES(?,?,?,?,?)').run(id, item.projectId || null, item.projectId ? 'project' : 'legacy_unscoped', ordinal, data);
    if (table === 'chat_messages') return this.db.prepare('INSERT INTO chat_messages(id,thread_id,ordinal,data_json) VALUES(?,?,?,?)').run(id, item.threadId || null, ordinal, data);
    if (table === 'assets') return this.db.prepare('INSERT INTO assets(id,project_id,kind,tombstoned_at,ordinal,data_json) VALUES(?,?,?,?,?,?)').run(id, item.projectId || null, 'image', item.tombstonedAt || null, ordinal, data);
    return this.db.prepare(`INSERT INTO ${table}(id,ordinal,data_json) VALUES(?,?,?)`).run(id, ordinal, data);
  }

  transaction(mutator) {
    this.db.exec('BEGIN IMMEDIATE');
    try {
      const state = this.loadState();
      const result = mutator(state);
      this.saveState(state, false);
      this.db.exec('COMMIT');
      return result;
    } catch (error) { this.db.exec('ROLLBACK'); throw error; }
  }

  close() { this.db.close(); }
}
