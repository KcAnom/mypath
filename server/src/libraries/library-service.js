import crypto from 'node:crypto';

const id = () => crypto.randomBytes(12).toString('hex');
const now = () => new Date().toISOString();

export class LibraryService {
  constructor(store, candidates, canvases) { this.store = store; this.db = store.database.db; this.candidates = candidates; this.canvases = canvases; this.backfill(); }
  create(input = {}) { return this.store.with((state, helpers) => { const item = { id: helpers.id(), name: String(input.name || 'Library').slice(0, 100), description: String(input.description || '').slice(0, 500), componentIds: [], memberships: [], createdAt: helpers.now(), updatedAt: helpers.now() }; state.libraries.unshift(item); return item; }); }
  list() { return this.store.get().libraries.map((library) => { const members = this.members(library.id); return { ...library, membershipCount: members.length, members }; }); }
  get(libraryId) { const library = this.store.get().libraries.find((item) => item.id === libraryId); return library ? { ...library, members: this.members(libraryId) } : null; }
  members(libraryId) {
    const state = this.store.get();
    return this.db.prepare('SELECT * FROM library_revision_memberships WHERE library_id=? ORDER BY ordinal,added_at').all(libraryId).map((row) => {
      const component = state.components.find((item) => item.id === row.component_id); const revision = state.revisions.find((item) => item.id === row.revision_id);
      return { libraryId, componentId: row.component_id, revisionId: row.revision_id, ordinal: Number(row.ordinal), addedAt: row.added_at, name: component?.name || component?.generatedName || row.component_id, status: revision?.status || null, provenance: revision ? { sourceComponentId: row.component_id, exactRevisionId: row.revision_id, revisionCreatedAt: revision.createdAt || null } : null };
    });
  }
  add(libraryId, componentId, revisionId) {
    const state = this.store.get(); const library = state.libraries.find((item) => item.id === libraryId);
    const component = state.components.find((item) => item.id === componentId && !item.deletedAt); const revision = state.revisions.find((item) => item.id === revisionId && item.componentId === componentId);
    if (!library) throw Object.assign(new Error('Library not found'), { status: 404, code: 'not_found' });
    if (!component || !revision || revision.status !== 'completed') throw Object.assign(new Error('Library membership requires an exact completed component revision'), { status: 422, code: 'exact_revision_required' });
    const stamp = now(); const ordinal = Number(this.db.prepare('SELECT COALESCE(MAX(ordinal),-1)+1 next FROM library_revision_memberships WHERE library_id=?').get(libraryId).next);
    this.store.with((next) => { const target = next.libraries.find((item) => item.id === libraryId); target.componentIds = [...new Set([...(target.componentIds || []).filter((value) => value !== componentId), componentId])]; target.memberships = [...(target.memberships || []).filter((entry) => entry.componentId !== componentId), { componentId, revisionId, ordinal, addedAt: stamp }]; target.updatedAt = stamp; });
    this.db.prepare(`INSERT INTO library_revision_memberships(library_id,component_id,revision_id,ordinal,added_at) VALUES(?,?,?,?,?)
      ON CONFLICT(library_id,component_id) DO UPDATE SET revision_id=excluded.revision_id,ordinal=excluded.ordinal,added_at=excluded.added_at`).run(libraryId, componentId, revisionId, ordinal, stamp);
    return this.members(libraryId).find((entry) => entry.componentId === componentId);
  }
  remove(libraryId, componentId) {
    let exists = false; this.store.with((state) => { const library = state.libraries.find((item) => item.id === libraryId); if (!library) return; exists = (library.componentIds || []).includes(componentId); library.componentIds = (library.componentIds || []).filter((value) => value !== componentId); library.memberships = (library.memberships || []).filter((entry) => entry.componentId !== componentId); library.updatedAt = now(); });
    this.db.prepare('DELETE FROM library_revision_memberships WHERE library_id=? AND component_id=?').run(libraryId, componentId); return exists;
  }
  activate(projectId, libraryId, active = true) {
    if (!this.store.get().projects.some((project) => project.id === projectId && !project.deletedAt)) throw Object.assign(new Error('Project not found'), { status: 404, code: 'not_found' });
    if (!this.get(libraryId)) throw Object.assign(new Error('Library not found'), { status: 404, code: 'not_found' });
    this.db.prepare(`INSERT INTO project_libraries(project_id,library_id,active) VALUES(?,?,?)
      ON CONFLICT(project_id,library_id) DO UPDATE SET active=excluded.active`).run(projectId, libraryId, active ? 1 : 0);
    return { projectId, libraryId, active: Boolean(active) };
  }
  active(projectId) { return this.db.prepare('SELECT library_id FROM project_libraries WHERE project_id=? AND active=1 ORDER BY library_id').all(projectId).map(({ library_id }) => this.get(library_id)).filter(Boolean); }
  exact(libraryId, componentId, revisionId) { return this.db.prepare('SELECT * FROM library_revision_memberships WHERE library_id=? AND component_id=? AND revision_id=?').get(libraryId, componentId, revisionId) || null; }
  reuseOnCanvas({ libraryId, componentId, revisionId, targetProjectId, x = 120, y = 120 }) {
    const member = this.exact(libraryId, componentId, revisionId); if (!member) throw Object.assign(new Error('The requested exact revision is not a member of this library'), { status: 422, code: 'library_revision_mismatch' });
    const revision = this.store.get().revisions.find((item) => item.id === revisionId && item.componentId === componentId && item.status === 'completed'); if (!revision) throw Object.assign(new Error('Library revision is unavailable'), { status: 422, code: 'exact_revision_required' });
    const library = this.get(libraryId); const membership = library.members.find((item) => item.componentId === componentId); const eventId = `reuse:${id()}`; const logicalId = `library:${eventId}`;
    const publication = this.canvases.publish(targetProjectId, logicalId, { componentId, revisionId, title: membership?.name || 'Library component', x: Number(x) || 120, y: Number(y) || 120, w: 360, h: 320, provenance: { kind: 'library-exact-revision', libraryId, sourceComponentId: componentId, sourceRevisionId: revisionId } });
    if (!publication) throw Object.assign(new Error('Target project canvas not found'), { status: 404, code: 'not_found' });
    this.db.prepare(`INSERT INTO library_reuse_events(id,library_id,source_component_id,source_revision_id,target_project_id,action,canvas_publication_id,created_at)
      VALUES(?,?,?,?,?,'canvas',?,?)`).run(eventId, libraryId, componentId, revisionId, targetProjectId, publication.id, now());
    return { id: eventId, action: 'canvas', libraryId, componentId, revisionId, targetProjectId, publication, provenance: { libraryId, sourceComponentId: componentId, exactRevisionId: revisionId } };
  }
  async copy({ libraryId, componentId, revisionId, targetProjectId, name }) {
    if (!this.exact(libraryId, componentId, revisionId)) throw Object.assign(new Error('The requested exact revision is not a member of this library'), { status: 422, code: 'library_revision_mismatch' });
    const state = this.store.get(); const source = state.components.find((item) => item.id === componentId); const revision = state.revisions.find((item) => item.id === revisionId && item.componentId === componentId && item.status === 'completed');
    if (!source || !revision || !state.projects.some((item) => item.id === targetProjectId && !item.deletedAt)) throw Object.assign(new Error('Source revision or target project is unavailable'), { status: 422, code: 'copy_target_invalid' });
    const provenance = { kind: 'library-copy', libraryId, sourceComponentId: componentId, sourceRevisionId: revisionId };
    const component = this.store.with((next, helpers) => { const item = { id: helpers.id(), projectId: targetProjectId, name: String(name || source.name || source.generatedName || 'Library copy'), generatedName: helpers.slugName(String(name || source.name || 'library-copy')), prompt: source.prompt || '', files: {}, code: '', selectedRevisionId: null, copyProvenance: provenance, createdAt: helpers.now(), updatedAt: helpers.now() }; next.components.unshift(item); return item; });
    const queued = this.candidates.create({ componentId: component.id, files: revision.files || {}, expectedBaseRevisionId: null, metadata: { copyProvenance: provenance, designSystemVersionId: revision.designSystemVersionId || null, skillVersionIds: revision.skillVersionIds || [], fontIds: revision.fontIds || [] }, note: `Copied exact library revision ${revisionId}` });
    const build = await this.candidates.run(queued.buildId); if (build.status !== 'succeeded') throw Object.assign(new Error('Copied library revision did not build'), { status: 422, code: 'copy_build_failed', details: { build } });
    const eventId = `reuse:${id()}`; this.db.prepare(`INSERT INTO library_reuse_events(id,library_id,source_component_id,source_revision_id,target_project_id,target_component_id,target_revision_id,action,created_at)
      VALUES(?,?,?,?,?,?,?,'copy',?)`).run(eventId, libraryId, componentId, revisionId, targetProjectId, component.id, build.revision_id, now());
    return { id: eventId, action: 'copy', component: this.store.get().components.find((item) => item.id === component.id), revisionId: build.revision_id, provenance };
  }
  backfill() {
    const state = this.store.get();
    for (const library of state.libraries) for (const [ordinal, componentId] of (library.componentIds || []).entries()) {
      const explicit = (library.memberships || []).find((item) => item.componentId === componentId); const component = state.components.find((item) => item.id === componentId); const revisionId = explicit?.revisionId || component?.selectedRevisionId;
      if (revisionId && state.revisions.some((item) => item.id === revisionId && item.componentId === componentId)) this.db.prepare('INSERT OR IGNORE INTO library_revision_memberships(library_id,component_id,revision_id,ordinal,added_at) VALUES(?,?,?,?,?)').run(library.id, componentId, revisionId, explicit?.ordinal ?? ordinal, explicit?.addedAt || library.updatedAt || library.createdAt || now());
    }
  }
}
