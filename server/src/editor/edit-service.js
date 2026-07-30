import crypto from 'node:crypto';
import { analyzeSource, applyOperations, compareFiles } from './source-editor.js';

const id = () => crypto.randomBytes(12).toString('hex');
const now = () => new Date().toISOString();
const encode = (value) => JSON.stringify(value ?? null);
const decode = (value, fallback = null) => { try { return JSON.parse(value); } catch { return fallback; } };

function conflict(message, code = 'edit_session_conflict') { return Object.assign(new Error(message), { status: 409, code }); }

export class EditService {
  constructor(store, candidates) {
    this.store = store; this.db = store.database.db; this.candidates = candidates;
    this.reconcile();
  }
  revision(componentId, revisionId) {
    return this.store.get().revisions.find((item) => item.id === revisionId && item.componentId === componentId) || null;
  }
  row(sessionId) { return this.db.prepare('SELECT * FROM edit_sessions WHERE id=?').get(sessionId) || null; }
  operations(sessionId) { return this.db.prepare('SELECT operation_json FROM edit_operations WHERE session_id=? ORDER BY ordinal').all(sessionId).map((row) => decode(row.operation_json, {})); }
  draft(row) {
    const revision = this.revision(row.component_id, row.base_revision_id);
    if (!revision) throw Object.assign(new Error('The edit session base revision no longer exists'), { status: 422, code: 'reconciliation_required' });
    return applyOperations(revision.files || {}, this.operations(row.id));
  }
  serialize(row, includeMapping = true) {
    if (!row) return null;
    let mapping = null;
    if (includeMapping && ['open', 'committing', 'completed'].includes(row.status)) {
      try { mapping = analyzeSource(row.status === 'completed' && row.done_revision_id ? (this.revision(row.component_id, row.done_revision_id)?.files || this.draft(row)) : this.draft(row)); }
      catch (error) { mapping = { files: null, layers: [], reconciliation: { code: error.code || 'reconciliation_required', message: error.message, details: error.details } }; }
    }
    return { id: row.id, componentId: row.component_id, baseRevisionId: row.base_revision_id, status: row.status, doneRevisionId: row.done_revision_id, candidateId: row.candidate_id, buildId: row.build_id, error: decode(row.error_json), createdAt: row.created_at, updatedAt: row.updated_at, operations: this.operations(row.id), mapping };
  }
  create(componentId, baseRevisionId) {
    const state = this.store.get(); const component = state.components.find((item) => item.id === componentId && !item.deletedAt);
    if (!component) throw Object.assign(new Error('Component not found'), { status: 404, code: 'not_found' });
    const base = baseRevisionId || component.selectedRevisionId;
    const revision = this.revision(componentId, base);
    if (!revision) throw Object.assign(new Error('A built base revision is required'), { status: 422, code: 'revision_required' });
    const mapping = analyzeSource(revision.files || {}); const sessionId = id(); const stamp = now();
    try { this.db.prepare("INSERT INTO edit_sessions(id,component_id,base_revision_id,status,created_at,updated_at) VALUES(?,?,?,'open',?,?)").run(sessionId, componentId, base, stamp, stamp); }
    catch (error) { if (String(error.message).includes('edit_sessions_one_open')) throw conflict('This component already has an open edit session'); throw error; }
    return { ...this.serialize(this.row(sessionId), false), mapping };
  }
  get(sessionId) { return this.serialize(this.row(sessionId)); }
  append(sessionId, operation) {
    const row = this.row(sessionId); if (!row) return null;
    if (row.status !== 'open') throw conflict('Only an open edit session accepts operations');
    // Validate against a freshly reparsed draft before persisting the operation.
    const revision = this.revision(row.component_id, row.base_revision_id);
    const operations = [...this.operations(sessionId), operation];
    const files = applyOperations(revision.files || {}, operations);
    this.db.exec('BEGIN IMMEDIATE');
    try {
      const current = this.db.prepare('SELECT status FROM edit_sessions WHERE id=?').get(sessionId);
      if (current?.status !== 'open') throw conflict('The edit session changed while applying the operation');
      const ordinal = Number(this.db.prepare('SELECT COALESCE(MAX(ordinal),0)+1 value FROM edit_operations WHERE session_id=?').get(sessionId).value);
      this.db.prepare('INSERT INTO edit_operations(session_id,ordinal,operation_json,created_at) VALUES(?,?,?,?)').run(sessionId, ordinal, encode(operation), now());
      this.db.prepare('UPDATE edit_sessions SET updated_at=? WHERE id=?').run(now(), sessionId); this.db.exec('COMMIT');
    } catch (error) { this.db.exec('ROLLBACK'); throw error; }
    return { ...this.serialize(this.row(sessionId), false), mapping: analyzeSource(files) };
  }
  cancel(sessionId) {
    const row = this.row(sessionId); if (!row) return null;
    if (row.status === 'cancelled') return this.serialize(row, false);
    if (row.status !== 'open') throw conflict('A committing or completed edit session cannot be cancelled');
    this.db.prepare("UPDATE edit_sessions SET status='cancelled',updated_at=?,completed_at=? WHERE id=? AND status='open'").run(now(), now(), sessionId);
    return this.serialize(this.row(sessionId), false);
  }
  async done(sessionId) {
    let row = this.row(sessionId); if (!row) return null;
    if (row.status === 'completed') return this.serialize(row);
    if (row.status !== 'open') throw conflict('Done can be used exactly once for an open edit session', 'edit_session_already_committed');
    const files = this.draft(row);
    this.db.exec('BEGIN IMMEDIATE');
    try {
      const claimed = this.db.prepare("UPDATE edit_sessions SET status='committing',updated_at=? WHERE id=? AND status='open'").run(now(), sessionId);
      if (!claimed.changes) throw conflict('Done was already requested', 'edit_session_already_committed');
      this.db.exec('COMMIT');
    } catch (error) { this.db.exec('ROLLBACK'); throw error; }
    try {
      const queued = this.candidates.create({ componentId: row.component_id, files, expectedBaseRevisionId: row.base_revision_id, parentRevisionId: row.base_revision_id, metadata: { editSessionId: sessionId, revisionKind: 'visual-edit' }, note: 'Visual edit session' });
      this.db.prepare('UPDATE edit_sessions SET candidate_id=?,build_id=?,updated_at=? WHERE id=?').run(queued.candidateId, queued.buildId, now(), sessionId);
      const build = await this.candidates.run(queued.buildId);
      if (build.status !== 'succeeded' || !build.revision_id) {
        const details = { buildId: build.id, diagnostics: build.diagnostics || [] };
        this.db.prepare("UPDATE edit_sessions SET status='failed',error_json=?,updated_at=?,completed_at=? WHERE id=?").run(encode(details), now(), now(), sessionId);
        throw Object.assign(new Error('Edited source did not build; no revision was created'), { status: 422, code: 'edit_build_failed', details });
      }
      this.db.prepare("UPDATE edit_sessions SET status='completed',done_revision_id=?,updated_at=?,completed_at=? WHERE id=? AND status='committing'").run(build.revision_id, now(), now(), sessionId);
      return this.serialize(this.row(sessionId));
    } catch (error) {
      if (this.row(sessionId)?.status === 'committing') this.db.prepare("UPDATE edit_sessions SET status='failed',error_json=?,updated_at=?,completed_at=? WHERE id=?").run(encode({ code: error.code || 'edit_failed', message: error.message }), now(), now(), sessionId);
      throw error;
    }
  }
  mapping(revisionId) {
    const revision = this.store.get().revisions.find((item) => item.id === revisionId);
    return revision ? analyzeSource(revision.files || {}) : null;
  }
  compare(leftId, rightId) {
    const state = this.store.get(); const left = state.revisions.find((item) => item.id === leftId); const right = state.revisions.find((item) => item.id === rightId && item.componentId === left?.componentId);
    return left && right ? { leftRevisionId: leftId, rightRevisionId: rightId, files: compareFiles(left.files || {}, right.files || {}) } : null;
  }
  checkout(componentId, revisionId) {
    const revision = this.revision(componentId, revisionId); if (!revision) return null;
    return this.store.with((state, helpers) => {
      const component = state.components.find((item) => item.id === componentId && !item.deletedAt); if (!component) return null;
      component.selectedRevisionId = revisionId; component.files = revision.files; component.code = revision.code || ''; component.updatedAt = helpers.now(); return component;
    });
  }
  async restore(revisionId, note = '') {
    const state = this.store.get(); const restored = state.revisions.find((item) => item.id === revisionId); if (!restored) return null;
    const component = state.components.find((item) => item.id === restored.componentId && !item.deletedAt); if (!component) return null;
    const parent = component.selectedRevisionId || revisionId;
    const queued = this.candidates.create({ componentId: component.id, files: restored.files || {}, expectedBaseRevisionId: parent, parentRevisionId: parent, metadata: { revisionKind: 'restore', restoredFromRevisionId: revisionId }, note: note || `Restore ${revisionId}` });
    const build = await this.candidates.run(queued.buildId);
    if (build.status !== 'succeeded') throw Object.assign(new Error('Restored source did not build'), { status: 422, code: 'restore_build_failed', details: { build } });
    return { revision: this.revision(component.id, build.revision_id), build };
  }
  reconcile() {
    for (const row of this.db.prepare("SELECT s.*,b.status build_status,b.revision_id,b.diagnostics_json FROM edit_sessions s LEFT JOIN builds b ON b.id=s.build_id WHERE s.status='committing'").all()) {
      if (row.build_status === 'succeeded' && row.revision_id) this.db.prepare("UPDATE edit_sessions SET status='completed',done_revision_id=?,updated_at=?,completed_at=? WHERE id=?").run(row.revision_id, now(), now(), row.id);
      else if (row.build_status === 'failed') this.db.prepare("UPDATE edit_sessions SET status='failed',error_json=?,updated_at=?,completed_at=? WHERE id=?").run(encode({ diagnostics: decode(row.diagnostics_json, []) }), now(), now(), row.id);
    }
  }
}
