import crypto from 'node:crypto';
import { parseSkillPackage } from './skill-package.js';

const now = () => new Date().toISOString();
const randomId = () => crypto.randomBytes(12).toString('hex');
const hash = (bytes) => crypto.createHash('sha256').update(bytes).digest('hex');
const BUILT_INS = [
  { id: 'builtin:accessibility', name: 'Accessibility review', description: 'Apply accessible labels, keyboard navigation, focus states, contrast, and semantic structure.', content: '# Accessibility review\nUse semantic HTML, labeled controls, visible focus, keyboard access, and WCAG-friendly contrast.', optionalActivation: true },
  { id: 'builtin:responsive', name: 'Responsive layout', description: 'Adapt screens for mobile, tablet, desktop, and responsive layouts.', content: '# Responsive layout\nUse resilient responsive layout, readable line lengths, and touch-safe controls.', optionalActivation: true },
  { id: 'builtin:content-design', name: 'Content design', description: 'Improve interface copy, labels, empty states, errors, and plain language.', content: '# Content design\nWrite concise, specific interface copy and useful states without filler.', optionalActivation: true },
];

export class SkillService {
  constructor(store) { this.store = store; this.db = store.database.db; this.ensureBuiltIns(); this.backfill(); }
  create(input = {}, builtin = false, forcedId = null) {
    const skillId = forcedId || randomId(); const item = { id: skillId, name: String(input.name || 'Skill').slice(0, 100), description: String(input.description || '').slice(0, 500), content: String(input.content || '').slice(0, 512 * 1024), files: Array.isArray(input.files) ? input.files : [], builtin, optionalActivation: input.optionalActivation === true, createdAt: now(), updatedAt: now() };
    this.store.with((state) => state.skills.unshift(item)); const version = this.createVersion(skillId, item, builtin); return { ...item, currentVersion: version };
  }
  createVersion(skillId, input = {}, builtin = false) {
    const current = this.store.get().skills.find((item) => item.id === skillId); if (!current) throw Object.assign(new Error('Skill not found'), { status: 404, code: 'not_found' });
    const merged = { ...current, ...input, id: skillId, builtin: Boolean(current.builtin || builtin), name: String(input.name ?? current.name ?? 'Skill').slice(0, 100), description: String(input.description ?? current.description ?? '').slice(0, 500), content: String(input.content ?? current.content ?? '').slice(0, 512 * 1024), optionalActivation: input.optionalActivation ?? current.optionalActivation ?? false, updatedAt: now() };
    const files = (Array.isArray(merged.files) ? merged.files : []).map((file) => ({ path: String(file.path || file.name || '').slice(0, 240), content: String(file.content || '').slice(0, 512 * 1024) }));
    const version = Number(this.db.prepare('SELECT COALESCE(MAX(version),0)+1 next FROM skill_versions WHERE skill_id=?').get(skillId).next); const versionId = `skv:${skillId}:${version}:${randomId().slice(0, 8)}`;
    const checksum = hash(Buffer.from(JSON.stringify({ name: merged.name, description: merged.description, content: merged.content, files })));
    this.db.prepare('INSERT INTO skill_versions(id,skill_id,version,name,description,content,files_json,content_checksum,builtin,optional_activation,created_at) VALUES(?,?,?,?,?,?,?,?,?,?,?)').run(versionId, skillId, version, merged.name, merged.description, merged.content, JSON.stringify(files), checksum, merged.builtin ? 1 : 0, merged.optionalActivation ? 1 : 0, now());
    this.store.with((state) => { const index = state.skills.findIndex((item) => item.id === skillId); if (index >= 0) state.skills[index] = { ...merged, files, currentVersionId: versionId, version }; }); return this.getVersion(versionId);
  }
  update(skillId, input = {}) { return this.createVersion(skillId, input); }
  getVersion(versionId) { const row = this.db.prepare('SELECT * FROM skill_versions WHERE id=?').get(versionId); return row ? { id: row.id, skillId: row.skill_id, version: Number(row.version), name: row.name, description: row.description, content: row.content, files: JSON.parse(row.files_json), checksum: row.content_checksum, builtin: Boolean(row.builtin), optionalActivation: Boolean(row.optional_activation), createdAt: row.created_at } : null; }
  current(skillId) { const row = this.db.prepare('SELECT id FROM skill_versions WHERE skill_id=? ORDER BY version DESC LIMIT 1').get(skillId); return row ? this.getVersion(row.id) : null; }
  get(skillId) { const skill = this.store.get().skills.find((item) => item.id === skillId); return skill ? { ...skill, currentVersion: this.current(skillId) } : null; }
  list() { return this.store.get().skills.map((item) => ({ ...item, currentVersion: this.current(item.id) })); }
  remove(skillId) { const skill = this.store.get().skills.find((item) => item.id === skillId); if (!skill || skill.builtin) return false; this.store.with((state) => { state.skills = state.skills.filter((item) => item.id !== skillId); }); return true; }
  activate(projectId, skillId, active = true) { if (!this.store.get().projects.some((project) => project.id === projectId && !project.deletedAt)) throw Object.assign(new Error('Project not found'), { status: 404, code: 'not_found' }); if (!this.get(skillId)) throw Object.assign(new Error('Skill not found'), { status: 404, code: 'not_found' }); this.db.prepare(`INSERT INTO project_skills(project_id,skill_id,active) VALUES(?,?,?) ON CONFLICT(project_id,skill_id) DO UPDATE SET active=excluded.active`).run(projectId, skillId, active ? 1 : 0); return { projectId, skillId, active: Boolean(active) }; }
  active(projectId) { return this.db.prepare('SELECT skill_id FROM project_skills WHERE project_id=? AND active=1 ORDER BY skill_id').all(projectId).map(({ skill_id }) => this.current(skill_id)).filter(Boolean); }
  resolveSelection(projectId, explicitIds = [], prompt = '', allowDescriptionActivation = false) {
    const explicit = new Set(explicitIds.map(String)); const selected = [];
    for (const skillId of explicit) { const version = this.current(skillId); if (!version) throw Object.assign(new Error(`Skill ${skillId} is unavailable`), { status: 422, code: 'skill_reference_invalid' }); selected.push({ ...version, activation: 'explicit' }); }
    for (const version of this.active(projectId)) if (!selected.some((item) => item.skillId === version.skillId)) selected.push({ ...version, activation: 'project' });
    if (allowDescriptionActivation) {
      const words = new Set(String(prompt).toLowerCase().match(/[a-z0-9]{4,}/g) || []);
      for (const skill of this.list()) { const version = skill.currentVersion; if (!version?.optionalActivation || selected.some((item) => item.skillId === skill.id)) continue; const descriptionWords = String(version.description).toLowerCase().match(/[a-z0-9]{4,}/g) || []; if (descriptionWords.some((word) => words.has(word))) selected.push({ ...version, activation: 'description-match' }); }
    }
    return selected;
  }
  importPackage({ bytes, packageName }) {
    const buffer = Buffer.isBuffer(bytes) ? bytes : Buffer.from(bytes || []); const parsed = parseSkillPackage(buffer, packageName); const skill = this.create({ name: parsed.name, description: parsed.description, content: parsed.content, files: parsed.files.map(({ path, content }) => ({ path, content })), optionalActivation: parsed.optionalActivation });
    const importId = `ski:${randomId()}`; this.db.prepare('INSERT INTO skill_imports(id,skill_id,skill_version_id,package_checksum,package_name,file_count,uncompressed_bytes,created_at) VALUES(?,?,?,?,?,?,?,?)').run(importId, skill.id, skill.currentVersion.id, hash(buffer), String(packageName || 'skill.skill').slice(0, 200), parsed.files.length, parsed.uncompressedBytes, now());
    return { importId, skill, boundary: { textOnly: true, scriptsExecuted: false, fileCount: parsed.files.length, uncompressedBytes: parsed.uncompressedBytes, archive: parsed.archive } };
  }
  ensureBuiltIns() { for (const builtin of BUILT_INS) if (!this.store.get().skills.some((item) => item.id === builtin.id)) this.create(builtin, true, builtin.id); }
  backfill() { for (const skill of this.store.get().skills) if (!this.current(skill.id)) this.createVersion(skill.id, skill, Boolean(skill.builtin)); }
}

export { BUILT_INS };
