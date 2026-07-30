import crypto from 'node:crypto';

const stable = (value) => {
  if (Array.isArray(value)) return `[${value.map(stable).join(',')}]`;
  if (value && typeof value === 'object') return `{${Object.keys(value).sort().map((key) => `${JSON.stringify(key)}:${stable(value[key])}`).join(',')}}`;
  return JSON.stringify(value);
};
const checksum = (value) => crypto.createHash('sha256').update(stable(value)).digest('hex');
const now = () => new Date().toISOString();
const array = (value) => Array.isArray(value) ? value : [];
const cleanRef = (ref) => typeof ref === 'string' ? { id: ref } : { ...(ref || {}) };

export class ContextService {
  constructor(database, canvasService, operational = {}) { this.database = database; this.db = database.db; this.canvases = canvasService; this.designSystems = operational.designSystems; this.libraries = operational.libraries; this.skills = operational.skills; this.fonts = operational.fonts; }
  operational(projectId, input = {}) {
    const explicitDesign = array(input.designSystems).map(cleanRef); const activeDesign = this.designSystems?.active(projectId) || null;
    const designRef = explicitDesign[0]; const designVersionId = String(designRef?.versionId || input.active?.designSystemVersionId || activeDesign?.id || '');
    const design = designVersionId ? this.designSystems?.getVersion(designVersionId) : null;
    if (designVersionId && !design) throw Object.assign(new Error(`Design-system version ${designVersionId} is unavailable`), { code: 'context_reference_invalid' });
    const explicitLibraryIds = array(input.libraries).map(cleanRef).map((ref) => String(ref.libraryId || ref.id || ''));
    const libraryIds = [...new Set([...(this.libraries?.active(projectId).map((library) => library.id) || []), ...array(input.active?.libraryIds).map(String), ...explicitLibraryIds].filter(Boolean))];
    const libraries = libraryIds.map((libraryId) => this.libraries?.get(libraryId)).filter(Boolean);
    if (libraries.length !== libraryIds.length) throw Object.assign(new Error('One or more selected libraries are unavailable'), { code: 'context_reference_invalid' });
    const explicitSkillIds = array(input.skills).map(cleanRef).map((ref) => String(ref.skillId || ref.id || ''));
    const skillIds = [...new Set([...array(input.active?.skillIds).map(String), ...explicitSkillIds].filter(Boolean))];
    const skills = this.skills ? this.skills.resolveSelection(projectId, skillIds, input.prompt || '', input.allowDescriptionActivation === true) : [];
    const selectedFonts = [...(design?.fontRefs || []).map((ref) => this.fonts?.get(ref.fontId)), ...(this.fonts?.active(projectId) || [])].filter(Boolean);
    const fonts = [...new Map(selectedFonts.map((font) => [font.id, font])).values()];
    return {
      designSystem: design ? { designSystemId: design.designSystemId, versionId: design.id, version: design.version, checksum: design.checksum, defaultTheme: design.defaultTheme, light: design.light, dark: design.dark, markdown: design.markdown, promptText: design.promptText, fontRefs: design.fontRefs } : null,
      libraries: libraries.map((library) => ({ libraryId: library.id, name: library.name, description: library.description || '', exactMembers: library.members.map((member) => ({ componentId: member.componentId, revisionId: member.revisionId, name: member.name })) })),
      skills: skills.map((skill) => ({ skillId: skill.skillId, versionId: skill.id, version: skill.version, checksum: skill.checksum, name: skill.name, description: skill.description, content: skill.content, activation: skill.activation })),
      fonts: fonts.map((font) => ({ fontId: font.id, assetId: font.assetId, checksum: font.checksum, family: font.family, weight: font.weight, style: font.style })),
    };
  }
  create(projectId, input = {}) {
    const state = this.database.loadState();
    if (!state.projects.some((p) => p.id === projectId && !p.deletedAt)) throw Object.assign(new Error('Project not found'), { code: 'not_found' });
    const canvas = this.canvases.get(projectId); if (!canvas) throw Object.assign(new Error('Canvas not found'), { code: 'not_found' });
    const selectedShapeIds = array(input.shapeIds || input.shapes).map((item) => String(item?.id || item)); const snapshotText = JSON.stringify(canvas.snapshot);
    for (const shapeId of selectedShapeIds) if (!snapshotText.includes(JSON.stringify(shapeId))) throw Object.assign(new Error(`Canvas shape ${shapeId} is not in canvas version ${canvas.version}`), { code: 'context_reference_invalid' });
    const componentRefs = array(input.components).map(cleanRef).map((ref) => ({ componentId: String(ref.componentId || ref.id || ''), revisionId: String(ref.revisionId || '') }));
    for (const ref of componentRefs) { const component = state.components.find((c) => c.id === ref.componentId && !c.deletedAt); const revision = state.revisions.find((r) => r.id === ref.revisionId && r.componentId === ref.componentId); if (!component || !revision) throw Object.assign(new Error(`Component/revision reference is not exact: ${ref.componentId}/${ref.revisionId}`), { code: 'context_reference_invalid' }); }
    const assetRefs = array(input.assets).map(cleanRef).map((r) => ({ assetId: String(r.assetId || r.id || '') }));
    for (const ref of assetRefs) if (!this.db.prepare('SELECT 1 FROM asset_ingestions WHERE id=? AND tombstoned_at IS NULL').get(ref.assetId)) throw Object.assign(new Error(`Asset ${ref.assetId} is unavailable`), { code: 'context_reference_invalid' });
    const operationalContext = this.operational(projectId, input);
    const designSystemRefs = operationalContext.designSystem ? [{ designSystemId: operationalContext.designSystem.designSystemId, versionId: operationalContext.designSystem.versionId }] : [];
    const libraryRefs = operationalContext.libraries.map((library) => ({ libraryId: library.libraryId, exactRevisionIds: library.exactMembers.map((member) => member.revisionId) }));
    const skillRefs = operationalContext.skills.map((skill) => ({ skillId: skill.skillId, versionId: skill.versionId }));
    const fontRefs = operationalContext.fonts.map((font) => ({ fontId: font.fontId, checksum: font.checksum }));
    const envelope = { schema: 'ContextEnvelopeV1', schemaVersion: 1, projectId, canvas: { canvasId: canvas.id, version: canvas.version }, shapeRefs: selectedShapeIds.map((shapeId) => ({ canvasId: canvas.id, canvasVersion: canvas.version, shapeId })), componentRevisionRefs: componentRefs, assetRefs, designSystemVersionRefs: designSystemRefs, libraryRefs, skillRefs, fontRefs, sketchRefs: array(input.sketches).map(cleanRef), activeRefs: { designSystemVersionId: operationalContext.designSystem?.versionId || null, libraryIds: libraryRefs.map((ref) => ref.libraryId), skillIds: skillRefs.map((ref) => ref.skillId), fontIds: fontRefs.map((ref) => ref.fontId) }, operationalContext };
    const digest = checksum(envelope); const snapshotId = `ctx:${digest}`;
    this.db.exec('BEGIN IMMEDIATE'); try {
      this.db.prepare('INSERT OR IGNORE INTO context_snapshots(id,project_id,schema_version,envelope_json,content_checksum,created_at) VALUES(?,?,?,?,?,?)').run(snapshotId, projectId, 1, JSON.stringify(envelope), digest, now());
      const add = this.db.prepare('INSERT OR IGNORE INTO context_references(context_snapshot_id,ref_type,entity_id,exact_version,metadata_json) VALUES(?,?,?,?,?)');
      for (const ref of envelope.shapeRefs) add.run(snapshotId, 'shape', ref.shapeId, String(ref.canvasVersion), JSON.stringify({ canvasId: ref.canvasId }));
      for (const ref of componentRefs) add.run(snapshotId, 'component', ref.componentId, ref.revisionId, '{}'); for (const ref of assetRefs) add.run(snapshotId, 'asset', ref.assetId, null, '{}');
      for (const ref of designSystemRefs) add.run(snapshotId, 'design-system', ref.designSystemId, ref.versionId, '{}');
      for (const ref of libraryRefs) add.run(snapshotId, 'library', ref.libraryId, checksum(ref.exactRevisionIds), JSON.stringify({ exactRevisionIds: ref.exactRevisionIds }));
      for (const ref of skillRefs) add.run(snapshotId, 'skill', ref.skillId, ref.versionId, '{}'); for (const ref of fontRefs) add.run(snapshotId, 'font', ref.fontId, ref.checksum, '{}');
      this.db.exec('COMMIT');
    } catch (error) { this.db.exec('ROLLBACK'); throw error; }
    return { id: snapshotId, ...envelope, createdAt: this.db.prepare('SELECT created_at FROM context_snapshots WHERE id=?').get(snapshotId).created_at };
  }
  get(snapshotId) { const row = this.db.prepare('SELECT * FROM context_snapshots WHERE id=?').get(snapshotId); return row ? { id: row.id, ...JSON.parse(row.envelope_json), createdAt: row.created_at } : null; }
  applyToGeneratedFiles(files, context) {
    let output = { ...files }; const operational = context?.operationalContext || {};
    if (operational.designSystem?.versionId) output = this.designSystems.apply(output, operational.designSystem.versionId);
    const designFontIds = new Set(operational.designSystem?.fontRefs?.map((font) => font.fontId) || []); const standalone = (operational.fonts || []).filter((font) => !designFontIds.has(font.fontId));
    if (standalone.length) { const css = standalone.map((font) => this.fonts.css(font.fontId)).join('\n'); output['src/index.css'] = `/* mypath-selected-fonts:start */\n${css}\n/* mypath-selected-fonts:end */\n${String(output['src/index.css'] || '').replace(/\/\* mypath-selected-fonts:start \*\/[\s\S]*?\/\* mypath-selected-fonts:end \*\/[\r\n]*/g, '')}`; for (const font of standalone) { const bundle = this.fonts.bundle(font.fontId); output[bundle.path] = bundle.content; } }
    return output;
  }
  revisionMetadata(context) { const operational = context?.operationalContext || {}; return { contextSnapshotId: context?.id || null, designSystemVersionId: operational.designSystem?.versionId || null, designSystemChecksum: operational.designSystem?.checksum || null, libraryRevisionContext: operational.libraries?.map((library) => ({ libraryId: library.libraryId, revisionIds: library.exactMembers.map((member) => member.revisionId) })) || [], skillVersionIds: operational.skills?.map((skill) => skill.versionId) || [], fontIds: operational.fonts?.map((font) => font.fontId) || [] }; }
  mentions(projectId, query = '') { const q = String(query).toLowerCase(); const state = this.database.loadState(); const out = []; const add = (type, id, label, detail = '') => { if (!q || `${label} ${detail}`.toLowerCase().includes(q)) out.push({ type, id, label, detail }); }; for (const component of state.components.filter((item) => item.projectId === projectId && !item.deletedAt)) { add('component', component.id, component.name || component.generatedName, component.selectedRevisionId || ''); for (const revision of state.revisions.filter((item) => item.componentId === component.id)) add('revision', revision.id, `${component.name || component.generatedName} revision`, revision.id); } for (const asset of this.db.prepare('SELECT * FROM asset_ingestions WHERE project_id=? AND tombstoned_at IS NULL').all(projectId)) add('asset', asset.id, asset.original_name, asset.kind); for (const design of this.designSystems?.list() || state.designSystems) add('design-system', design.id, design.name || design.id); for (const library of this.libraries?.list() || state.libraries) add('library', library.id, library.name || library.id); for (const skill of this.skills?.list() || state.skills) add('skill', skill.id, skill.name || skill.id); return out.slice(0, 50); }
}
