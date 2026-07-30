import crypto from 'node:crypto';

const encode = (value) => JSON.stringify(value ?? null);
const decode = (value, fallback = null) => { try { return JSON.parse(value); } catch { return fallback; } };
const time = () => new Date().toISOString();
const hash = (value) => crypto.createHash('sha256').update(value).digest('hex');

export function convertLegacyCanvas(canvas) {
  const shapes = Array.isArray(canvas?.shapes) ? canvas.shapes : [];
  return {
    format: 'tldraw-v1',
    document: null,
    legacyShapes: shapes.map((shape, index) => ({
      id: `shape:${String(shape.id || `legacy-${index}`).replace(/[^a-zA-Z0-9_-]/g, '-')}`,
      type: shape.kind === 'component' ? 'design-frame' : (shape.kind || 'geo'),
      x: Number(shape.position?.x || shape.x || 0), y: Number(shape.position?.y || shape.y || 0),
      props: shape.kind === 'component' ? {
        w: Number(shape.size?.width || 320), h: Number(shape.size?.height || 280),
        componentId: String(shape.componentId || ''), revisionId: String(shape.selectedRevisionId || ''),
        title: String(shape.name || 'Design'), publicationId: '',
      } : { w: Number(shape.size?.width || 160), h: Number(shape.size?.height || 100), geo: 'rectangle', color: 'black', fill: 'none', dash: 'draw', size: 'm' },
    })),
    camera: canvas?.camera || { x: 0, y: 0, z: 1 },
  };
}

function addFrame(snapshot, frame, publicationId) {
  const next = structuredClone(snapshot);
  const key = `shape:${String(publicationId).replace(/[^a-zA-Z0-9_-]/g, '-')}`;
  const records = next?.document?.store;
  if (records && typeof records === 'object') {
    if (records[key] || Object.values(records).some((r) => r?.meta?.publicationId === publicationId || r?.props?.publicationId === publicationId)) return { snapshot: next, inserted: false };
    const page = Object.values(records).find((r) => r?.typeName === 'page');
    records[key] = { id: key, typeName: 'shape', type: 'design-frame', x: Number(frame.x || 80), y: Number(frame.y || 80), rotation: 0, index: `a${hash(publicationId).slice(0, 10)}`, parentId: page?.id || 'page:page', isLocked: false, opacity: 1, meta: { publicationId }, props: { w: Number(frame.w || 320), h: Number(frame.h || 280), componentId: String(frame.componentId || ''), revisionId: String(frame.revisionId || ''), title: String(frame.title || 'Generated design'), publicationId } };
  } else {
    next.legacyShapes ||= [];
    if (next.legacyShapes.some((r) => r?.props?.publicationId === publicationId)) return { snapshot: next, inserted: false };
    next.legacyShapes.push({ id: key, type: 'design-frame', x: Number(frame.x || 80), y: Number(frame.y || 80), props: { w: Number(frame.w || 320), h: Number(frame.h || 280), componentId: String(frame.componentId || ''), revisionId: String(frame.revisionId || ''), title: String(frame.title || 'Generated design'), publicationId } });
  }
  return { snapshot: next, inserted: true };
}

export class CanvasService {
  constructor(database) { this.database = database; this.db = database.db; }
  rowForProject(projectId) { return this.db.prepare('SELECT * FROM canvases WHERE project_id=?').get(projectId); }
  latest(canvasId) { return this.db.prepare('SELECT * FROM canvas_snapshots WHERE canvas_id=? ORDER BY version DESC LIMIT 1').get(canvasId); }
  get(projectId) {
    const row = this.rowForProject(projectId); if (!row) return null;
    let snapshot = this.latest(row.id);
    if (!snapshot) {
      const legacy = decode(row.data_json, {});
      const converted = convertLegacyCanvas({ ...legacy, shapes: decode(row.shapes_json, legacy.shapes || []), camera: decode(row.camera_json, legacy.camera || {}) });
      this.db.prepare('INSERT OR IGNORE INTO canvas_snapshots(canvas_id,version,schema_version,snapshot_json,camera_json,source,created_at) VALUES(?,?,?,?,?,?,?)').run(row.id, Number(row.version || 1), 1, encode(converted), encode(converted.camera), 'legacy-conversion', time());
      snapshot = this.latest(row.id);
      this.db.prepare("UPDATE canvases SET document_format='tldraw-v1' WHERE id=?").run(row.id);
    }
    return { id: row.id, projectId, version: Number(snapshot.version), schemaVersion: Number(snapshot.schema_version), snapshot: decode(snapshot.snapshot_json, {}), camera: decode(snapshot.camera_json, {}), updatedAt: snapshot.created_at };
  }
  save(projectId, expectedVersion, snapshot, camera = {}) {
    if (!snapshot || typeof snapshot !== 'object' || Array.isArray(snapshot)) throw Object.assign(new Error('A tldraw snapshot object is required'), { code: 'canvas_invalid' });
    const bytes = Buffer.byteLength(encode(snapshot)); if (bytes > 10 * 1024 * 1024) throw Object.assign(new Error('Canvas snapshot exceeds 10 MiB'), { code: 'canvas_too_large' });
    this.db.exec('BEGIN IMMEDIATE');
    try {
      const row = this.rowForProject(projectId); if (!row) { this.db.exec('ROLLBACK'); return null; }
      const latest = this.latest(row.id); const current = Number(latest?.version || row.version || 1);
      if (Number(expectedVersion) !== current) { this.db.exec('ROLLBACK'); return { conflict: true, current: this.get(projectId) }; }
      const version = current + 1; const stamp = time();
      const info = this.db.prepare('UPDATE canvases SET version=?,document_format=?,camera_json=?,updated_at=?,data_json=json_set(data_json,\'$.version\',?,\'$.camera\',json(?),\'$.updatedAt\',?) WHERE id=? AND version=?').run(version, 'tldraw-v1', encode(camera), stamp, version, encode(camera), stamp, row.id, current);
      if (!info.changes) { this.db.exec('ROLLBACK'); return { conflict: true, current: this.get(projectId) }; }
      this.db.prepare('INSERT INTO canvas_snapshots(canvas_id,version,schema_version,snapshot_json,camera_json,source,created_at) VALUES(?,?,?,?,?,?,?)').run(row.id, version, 1, encode(snapshot), encode(camera), 'edit', stamp);
      this.db.exec('COMMIT'); return this.get(projectId);
    } catch (error) { try { this.db.exec('ROLLBACK'); } catch {} throw error; }
  }
  publish(projectId, logicalJobId, frame) {
    if (!logicalJobId) throw Object.assign(new Error('logicalJobId is required'), { code: 'publication_invalid' });
    const canvas = this.get(projectId); if (!canvas) return null;
    const id = `frame:${logicalJobId}`; const stamp = time();
    this.db.prepare("INSERT INTO canvas_frame_publications(id,canvas_id,logical_job_id,frame_json,status,created_at,updated_at) VALUES(?,?,?,?, 'pending',?,?) ON CONFLICT(id) DO NOTHING").run(id, canvas.id, logicalJobId, encode(frame), stamp, stamp);
    return this.materialize(id);
  }
  materialize(id, maxAttempts = 8) {
    for (let attempt = 0; attempt < maxAttempts; attempt++) {
      const publication = this.db.prepare('SELECT * FROM canvas_frame_publications WHERE id=?').get(id); if (!publication) return null;
      if (publication.status === 'materialized') return publication;
      const canvasRow = this.db.prepare('SELECT project_id FROM canvases WHERE id=?').get(publication.canvas_id); if (!canvasRow) return null;
      const canvas = this.get(canvasRow.project_id); const merged = addFrame(canvas.snapshot, decode(publication.frame_json, {}), publication.id);
      if (!merged.inserted) { this.db.prepare("UPDATE canvas_frame_publications SET status='materialized',materialized_version=?,updated_at=? WHERE id=?").run(canvas.version, time(), id); return this.db.prepare('SELECT * FROM canvas_frame_publications WHERE id=?').get(id); }
      const saved = this.save(canvasRow.project_id, canvas.version, merged.snapshot, canvas.camera);
      this.db.prepare('UPDATE canvas_frame_publications SET attempts=attempts+1,updated_at=? WHERE id=?').run(time(), id);
      if (!saved?.conflict) { this.db.prepare("UPDATE canvas_frame_publications SET status='materialized',materialized_version=?,updated_at=? WHERE id=?").run(saved.version, time(), id); return this.db.prepare('SELECT * FROM canvas_frame_publications WHERE id=?').get(id); }
    }
    return this.db.prepare('SELECT * FROM canvas_frame_publications WHERE id=?').get(id);
  }
  resume() { return this.db.prepare("SELECT id FROM canvas_frame_publications WHERE status='pending'").all().map(({ id }) => this.materialize(id)); }
}
