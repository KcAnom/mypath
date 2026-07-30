import crypto from 'node:crypto';
import { compileDesignSystem, injectCompiledTheme } from './compiler.js';

const now = () => new Date().toISOString();
const id = () => crypto.randomBytes(12).toString('hex');
const decode = (value, fallback = null) => { try { return JSON.parse(value); } catch { return fallback; } };
export const DEFAULT_LIGHT = { '--background': '#ffffff', '--foreground': '#0b0b0c', '--primary': '#6354e0', '--primary-foreground': '#ffffff', '--border': '#e5e5ea', '--card': '#f7f7f8', '--muted-foreground': '#6b6b76' };
export const DEFAULT_DARK = { '--background': '#0b0b0c', '--foreground': '#f3f3f4', '--primary': '#7c6cff', '--primary-foreground': '#ffffff', '--border': '#2a2a30', '--card': '#141416', '--muted-foreground': '#9a9aa3' };

export class DesignSystemService {
  constructor(store, fonts) { this.store = store; this.db = store.database.db; this.fonts = fonts; this.backfillCompilations(); }
  create(input = {}) {
    const stamp = now(); const designSystemId = id();
    const item = { id: designSystemId, name: String(input.name || 'Design system'), prompt: String(input.prompt || ''), defaultTheme: input.defaultTheme === 'light' ? 'light' : 'dark', light: input.light || input.tokens?.light || DEFAULT_LIGHT, dark: input.dark || input.tokens?.dark || DEFAULT_DARK, fonts: Array.isArray(input.fonts) ? input.fonts : [], markdown: input.markdown || input.designMd || `# ${input.name || 'Design system'}\n`, createdAt: stamp, updatedAt: stamp };
    this.store.with((state) => state.designSystems.unshift(item));
    const version = this.createVersion(designSystemId, item);
    return { ...item, currentVersion: version };
  }
  createVersion(designSystemId, input = {}) {
    const state = this.store.get(); const current = state.designSystems.find((item) => item.id === designSystemId);
    if (!current) throw Object.assign(new Error('Design system not found'), { status: 404, code: 'not_found' });
    const merged = { ...current, ...input, id: designSystemId, createdAt: current.createdAt, updatedAt: now() };
    const fontIds = (Array.isArray(merged.fonts) ? merged.fonts : []).map((entry) => String(entry?.fontId || entry?.id || entry));
    const fontFaces = fontIds.map((fontId) => { const font = this.fonts.get(fontId); if (!font) throw Object.assign(new Error(`Font ${fontId} is unavailable`), { status: 422, code: 'font_reference_invalid' }); return { font, css: this.fonts.css(fontId) }; });
    const version = Number(this.db.prepare('SELECT COALESCE(MAX(version),0)+1 next FROM design_system_versions WHERE design_system_id=?').get(designSystemId).next);
    const versionId = `dsv:${designSystemId}:${version}:${id().slice(0, 8)}`;
    const compiled = compileDesignSystem(merged, { versionId, version, fontFaces });
    const versionData = { ...merged, versionId, version, fontRefs: compiled.fontRefs, compilationChecksum: compiled.checksum };
    this.db.exec('BEGIN IMMEDIATE');
    try {
      this.db.prepare('INSERT INTO design_system_versions(id,design_system_id,version,data_json,created_at) VALUES(?,?,?,?,?)').run(versionId, designSystemId, version, JSON.stringify(versionData), now());
      this.db.prepare('INSERT INTO design_system_compilations(version_id,content_checksum,compiled_css,prompt_text,light_json,dark_json,font_refs_json,created_at) VALUES(?,?,?,?,?,?,?,?)').run(versionId, compiled.checksum, compiled.css, compiled.promptText, JSON.stringify(compiled.light), JSON.stringify(compiled.dark), JSON.stringify(compiled.fontRefs), now());
      this.db.exec('COMMIT');
    } catch (error) { this.db.exec('ROLLBACK'); throw error; }
    this.store.with((next) => { const index = next.designSystems.findIndex((item) => item.id === designSystemId); if (index >= 0) next.designSystems[index] = { ...merged, currentVersionId: versionId, version }; });
    return this.getVersion(versionId);
  }
  update(designSystemId, input = {}) { return this.createVersion(designSystemId, input); }
  list() { return this.store.get().designSystems.map((item) => { const versions = this.versions(item.id).map(({ compiledCss: ignoredCss, promptText: ignoredPrompt, ...version }) => version); return { ...item, currentVersion: this.current(item.id), versions }; }); }
  get(designSystemId) { const item = this.store.get().designSystems.find((entry) => entry.id === designSystemId); return item ? { ...item, versions: this.versions(designSystemId), currentVersion: this.current(designSystemId) } : null; }
  versions(designSystemId) { return this.db.prepare('SELECT id FROM design_system_versions WHERE design_system_id=? ORDER BY version DESC').all(designSystemId).map(({ id: versionId }) => this.getVersion(versionId)); }
  current(designSystemId) { const row = this.db.prepare('SELECT id FROM design_system_versions WHERE design_system_id=? ORDER BY version DESC LIMIT 1').get(designSystemId); return row ? this.getVersion(row.id) : null; }
  getVersion(versionId) {
    const row = this.db.prepare(`SELECT v.*,c.content_checksum,c.compiled_css,c.prompt_text,c.light_json,c.dark_json,c.font_refs_json
      FROM design_system_versions v LEFT JOIN design_system_compilations c ON c.version_id=v.id WHERE v.id=?`).get(versionId);
    if (!row) return null;
    const data = decode(row.data_json, {});
    return { ...data, id: row.id, versionId: row.id, designSystemId: row.design_system_id, version: Number(row.version), checksum: row.content_checksum || null, compiledCss: row.compiled_css || '', promptText: row.prompt_text || '', light: decode(row.light_json, data.light || {}), dark: decode(row.dark_json, data.dark || {}), fontRefs: decode(row.font_refs_json, data.fontRefs || []), createdAt: row.created_at };
  }
  activate(projectId, versionId, active = true) {
    if (!this.store.get().projects.some((project) => project.id === projectId && !project.deletedAt)) throw Object.assign(new Error('Project not found'), { status: 404, code: 'not_found' });
    // System defaults are represented by no active project selection. This path
    // intentionally accepts no versionId so the UI can truly clear prior state.
    if (!active && !versionId) {
      this.db.prepare('UPDATE project_design_systems SET active=0 WHERE project_id=?').run(projectId);
      return { projectId, versionId: null, active: false };
    }
    const version = this.getVersion(versionId); if (!version) throw Object.assign(new Error('Design-system version not found'), { status: 404, code: 'not_found' });
    this.db.exec('BEGIN IMMEDIATE'); try {
      if (active) this.db.prepare('UPDATE project_design_systems SET active=0 WHERE project_id=?').run(projectId);
      this.db.prepare(`INSERT INTO project_design_systems(project_id,design_system_version_id,active) VALUES(?,?,?)
        ON CONFLICT(project_id,design_system_version_id) DO UPDATE SET active=excluded.active`).run(projectId, versionId, active ? 1 : 0);
      this.db.exec('COMMIT');
    } catch (error) { this.db.exec('ROLLBACK'); throw error; }
    return { projectId, versionId, active: Boolean(active) };
  }
  active(projectId) { const row = this.db.prepare('SELECT design_system_version_id FROM project_design_systems WHERE project_id=? AND active=1 LIMIT 1').get(projectId); return row ? this.getVersion(row.design_system_version_id) : null; }
  apply(files, versionId) { const version = this.getVersion(versionId); if (!version?.compiledCss) throw Object.assign(new Error('Compiled design-system version is unavailable'), { status: 422, code: 'design_compilation_unavailable' }); const output = injectCompiledTheme(files, { css: version.compiledCss }); for (const ref of version.fontRefs || []) { const bundle = this.fonts.bundle(ref.fontId); output[bundle.path] = bundle.content; } return output; }
  remove(designSystemId) { let removed = false; this.store.with((state) => { const length = state.designSystems.length; state.designSystems = state.designSystems.filter((item) => item.id !== designSystemId); removed = state.designSystems.length < length; }); return removed; }
  backfillCompilations() {
    for (const row of this.db.prepare('SELECT v.* FROM design_system_versions v LEFT JOIN design_system_compilations c ON c.version_id=v.id WHERE c.version_id IS NULL ORDER BY v.version').all()) {
      const data = decode(row.data_json, {}); const fontFaces = [];
      for (const entry of Array.isArray(data.fonts) ? data.fonts : []) { const fontId = String(entry?.fontId || entry?.id || entry); const font = this.fonts.get(fontId); if (font) fontFaces.push({ font, css: this.fonts.css(fontId) }); }
      try {
        const compiled = compileDesignSystem({ name: data.name || row.design_system_id, defaultTheme: data.defaultTheme, light: data.light || DEFAULT_LIGHT, dark: data.dark || DEFAULT_DARK, markdown: data.markdown, fonts: data.fonts }, { versionId: row.id, version: Number(row.version), fontFaces });
        this.db.prepare('INSERT OR IGNORE INTO design_system_compilations(version_id,content_checksum,compiled_css,prompt_text,light_json,dark_json,font_refs_json,created_at) VALUES(?,?,?,?,?,?,?,?)').run(row.id, compiled.checksum, compiled.css, compiled.promptText, JSON.stringify(compiled.light), JSON.stringify(compiled.dark), JSON.stringify(compiled.fontRefs), row.created_at || now());
      } catch (error) { console.error(`Design-system compilation backfill skipped for ${row.id}: ${error.message}`); }
    }
  }
}
