import crypto from 'node:crypto';
import { analyzeSource, applyOperations } from './source-editor.js';

const id = () => crypto.randomBytes(12).toString('hex');
const now = () => new Date().toISOString();
const encode = (value) => JSON.stringify(value ?? null);
const decode = (value, fallback = null) => { try { return JSON.parse(value); } catch { return fallback; } };
const DIRECTIONS = new Set(['layout', 'style', 'color', 'copy', 'device']);

function normalizeDirection(input) {
  const [stringKind, ...rest] = typeof input === 'string' ? input.split(':') : [];
  const kind = String(typeof input === 'string' ? stringKind : input?.kind || '').toLowerCase();
  const value = String(typeof input === 'string' ? rest.join(':') || kind : input?.value || input?.prompt || kind).trim().slice(0, 160);
  if (!DIRECTIONS.has(kind)) throw Object.assign(new Error('Variant direction must be layout, style, color, copy, or device'), { status: 422, code: 'variant_direction_invalid', details: { kind } });
  return { kind, value: value || kind };
}
function variantOperation(files, direction) {
  const mapping = analyzeSource(files); const root = mapping.layers.find((layer) => layer.editable);
  if (!root) throw Object.assign(new Error('No uniquely traceable static intrinsic JSX node can receive this variant'), { status: 422, code: 'reconciliation_required' });
  if (direction.kind === 'copy') {
    const text = mapping.layers.find((layer) => layer.editable && layer.text !== null);
    if (!text) throw Object.assign(new Error('Copy variants require an editable literal text node'), { status: 422, code: 'reconciliation_required' });
    return { files: mapping.files, operation: { type: 'set-text', sourceId: text.sourceId, value: direction.value } };
  }
  const current = root.attributes.style && typeof root.attributes.style === 'object' ? root.attributes.style : {};
  const style = { ...current };
  if (direction.kind === 'layout') Object.assign(style, { display: direction.value.includes('flex') ? 'flex' : 'grid', gap: '16px' });
  else if (direction.kind === 'style') Object.assign(style, { borderRadius: direction.value.includes('sharp') ? '0px' : '20px', boxShadow: '0 16px 48px rgba(0,0,0,0.18)' });
  else if (direction.kind === 'color') Object.assign(style, { backgroundColor: direction.value.match(/#[0-9a-f]{3,8}/i)?.[0] || '#172554', color: '#ffffff' });
  else if (direction.kind === 'device') Object.assign(style, { maxWidth: direction.value.toLowerCase().includes('mobile') ? '390px' : direction.value.toLowerCase().includes('tablet') ? '768px' : '1200px', width: '100%' });
  return { files: mapping.files, operation: { type: 'set-style', sourceId: root.sourceId, value: style } };
}

export class VariantService {
  constructor(store, candidates, canvases) { this.store = store; this.db = store.database.db; this.candidates = candidates; this.canvases = canvases; }
  get(groupId) {
    const group = this.db.prepare('SELECT * FROM variant_groups WHERE id=?').get(groupId); if (!group) return null;
    const variants = this.db.prepare('SELECT * FROM variants WHERE group_id=? ORDER BY created_at,id').all(groupId).map((row) => ({ id: row.id, groupId: row.group_id, componentId: row.component_id, parentRevisionId: row.parent_revision_id, direction: { kind: row.direction_kind, value: row.direction_value }, status: row.status, candidateId: row.candidate_id, buildId: row.build_id, revisionId: row.revision_id, jobId: row.job_id, diagnostics: decode(row.diagnostics_json, []), createdAt: row.created_at, completedAt: row.completed_at }));
    return { id: group.id, componentId: group.component_id, parentRevisionId: group.parent_revision_id, status: group.status, createdAt: group.created_at, completedAt: group.completed_at, variants };
  }
  list(componentId) { return this.db.prepare('SELECT id FROM variant_groups WHERE component_id=? ORDER BY created_at DESC').all(componentId).map((row) => this.get(row.id)); }
  async create(componentId, directionInputs) {
    const state = this.store.get(); const component = state.components.find((item) => item.id === componentId && !item.deletedAt);
    if (!component) throw Object.assign(new Error('Component not found'), { status: 404, code: 'not_found' });
    const parent = state.revisions.find((item) => item.id === component.selectedRevisionId && item.componentId === componentId);
    if (!parent) throw Object.assign(new Error('A selected parent revision is required'), { status: 422, code: 'revision_required' });
    const directions = (Array.isArray(directionInputs) ? directionInputs : []).map(normalizeDirection);
    if (!directions.length || directions.length > 8) throw Object.assign(new Error('Provide between 1 and 8 variant directions'), { status: 422, code: 'variant_count_invalid' });
    const groupId = id(); const stamp = now(); const rows = [];
    this.db.exec('BEGIN IMMEDIATE');
    try {
      this.db.prepare("INSERT INTO variant_groups(id,component_id,parent_revision_id,status,created_at) VALUES(?,?,?,'queued',?)").run(groupId, componentId, parent.id, stamp);
      directions.forEach((direction, ordinal) => {
        const variantId = id(); const jobId = id(); const attemptId = id();
        this.db.prepare("INSERT INTO variants(id,group_id,component_id,parent_revision_id,direction_kind,direction_value,status,job_id,created_at) VALUES(?,?,?,?,?,?,'queued',?,?)").run(variantId, groupId, componentId, parent.id, direction.kind, direction.value, jobId, stamp);
        this.db.prepare(`INSERT INTO jobs(id,component_id,revision_id,status,ordinal,data_json,project_id,deliverable_key,deliverable_name,request_json,created_at,updated_at)
          VALUES(?,NULL,NULL,'queued',?,?,?,?,?,?,?,?)`).run(jobId, ordinal, encode({ id: jobId, phase4: true, variantId, groupId }), component.projectId, `variant:${direction.kind}:${ordinal}`, `${direction.kind}: ${direction.value}`, encode({ schema: 'VariantRequestV1', componentId, parentRevisionId: parent.id, direction }), stamp, stamp);
        this.db.prepare("INSERT INTO job_attempts(id,job_id,attempt_number,status,created_at) VALUES(?,?,1,'queued',?)").run(attemptId, jobId, stamp);
        this.db.prepare("INSERT INTO job_events(run_id,job_id,attempt_id,event_type,data_json,sensitive,created_at) VALUES(?,?,?,'variant_queued',?,1,?)").run(groupId, jobId, attemptId, encode({ variantId, direction }), stamp);
        rows.push({ variantId, jobId, attemptId, direction, ordinal });
      });
      this.db.prepare("UPDATE variant_groups SET status='running' WHERE id=?").run(groupId); this.db.exec('COMMIT');
    } catch (error) { this.db.exec('ROLLBACK'); throw error; }

    await Promise.all(rows.map(async (row) => {
      try {
        const transformed = variantOperation(parent.files || {}, row.direction);
        const files = applyOperations(transformed.files, [transformed.operation]);
        const queued = this.candidates.create({ componentId, files, expectedBaseRevisionId: parent.id, parentRevisionId: parent.id, metadata: { revisionKind: 'variant', variantId: row.variantId, variantDirection: row.direction }, note: `Variant · ${row.direction.kind}: ${row.direction.value}` });
        const started = now();
        this.db.prepare("UPDATE variants SET status='building',candidate_id=?,build_id=? WHERE id=?").run(queued.candidateId, queued.buildId, row.variantId);
        this.db.prepare("UPDATE jobs SET status='running',updated_at=? WHERE id=?").run(started, row.jobId);
        this.db.prepare("UPDATE job_attempts SET status='building',build_id=?,started_at=? WHERE id=?").run(queued.buildId, started, row.attemptId);
        this.db.prepare("INSERT INTO job_events(run_id,job_id,attempt_id,event_type,data_json,sensitive,created_at) VALUES(?,?,?,'variant_building',?,1,?)").run(groupId, row.jobId, row.attemptId, encode({ buildId: queued.buildId }), started);
        const build = await this.candidates.run(queued.buildId);
        if (build.status !== 'succeeded' || !build.revision_id) throw Object.assign(new Error(build.diagnostics?.[0]?.message || 'Variant build failed'), { code: build.diagnostics?.[0]?.code || 'build_failed', diagnostics: build.diagnostics || [] });
        const title = `${component.name} · ${row.direction.kind}: ${row.direction.value}`;
        const publication = this.canvases.publish(component.projectId, row.jobId, { componentId, revisionId: build.revision_id, title, x: 80 + (row.ordinal % 3) * 390, y: 440 + Math.floor(row.ordinal / 3) * 350, w: row.direction.kind === 'device' && row.direction.value.toLowerCase().includes('mobile') ? 390 : 360, h: 320 });
        if (!publication) throw Object.assign(new Error('Variant canvas publication failed'), { code: 'publication_failed' });
        const finished = now(); this.db.prepare("UPDATE variants SET status='completed',revision_id=?,completed_at=?,diagnostics_json='[]' WHERE id=?").run(build.revision_id, finished, row.variantId);
        this.db.prepare("UPDATE jobs SET status='succeeded',result_component_id=?,result_revision_id=?,updated_at=? WHERE id=?").run(componentId, build.revision_id, finished, row.jobId);
        this.db.prepare("UPDATE job_attempts SET status='succeeded',finished_at=? WHERE id=?").run(finished, row.attemptId);
        this.db.prepare("INSERT INTO job_events(run_id,job_id,attempt_id,event_type,data_json,sensitive,created_at) VALUES(?,?,?,'variant_succeeded',?,1,?)").run(groupId, row.jobId, row.attemptId, encode({ revisionId: build.revision_id, publicationId: publication.id }), finished);
      } catch (error) {
        const diagnostics = error.diagnostics || [{ code: error.code || 'variant_failed', message: String(error.message || error) }]; const finished = now();
        this.db.prepare("UPDATE variants SET status='failed',completed_at=?,diagnostics_json=? WHERE id=?").run(finished, encode(diagnostics), row.variantId);
        this.db.prepare("UPDATE jobs SET status='failed',updated_at=? WHERE id=?").run(finished, row.jobId);
        this.db.prepare("UPDATE job_attempts SET status='failed',finished_at=?,error_code=?,error_message=? WHERE id=?").run(finished, diagnostics[0]?.code || 'variant_failed', diagnostics[0]?.message || 'Variant failed', row.attemptId);
        this.db.prepare("INSERT INTO job_events(run_id,job_id,attempt_id,event_type,data_json,sensitive,created_at) VALUES(?,?,?,'variant_failed',?,1,?)").run(groupId, row.jobId, row.attemptId, encode({ diagnostics }), finished);
      }
    }));
    const counts = Object.fromEntries(this.db.prepare('SELECT status,count(*) count FROM variants WHERE group_id=? GROUP BY status').all(groupId).map((row) => [row.status, Number(row.count)]));
    const status = counts.completed === rows.length ? 'completed' : counts.completed ? 'partial' : 'failed';
    this.db.prepare('UPDATE variant_groups SET status=?,completed_at=? WHERE id=?').run(status, now(), groupId);
    return this.get(groupId);
  }
}
