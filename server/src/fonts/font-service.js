import crypto from 'node:crypto';
import fs from 'node:fs';

const MAX_EMBEDDED_FONT_BYTES = 512 * 1024;
const now = () => new Date().toISOString();
const id = () => `font:${crypto.randomBytes(12).toString('hex')}`;

function family(value) {
  const clean = String(value || '').replace(/[\u0000-\u001f\u007f]/g, '').trim().slice(0, 80);
  if (!clean) throw Object.assign(new Error('Font family is required'), { status: 422, code: 'font_family_invalid' });
  return clean;
}
function quoted(value) { return `'${String(value).replaceAll('\\', '\\\\').replaceAll("'", "\\'")}'`; }
function extension(mediaType) { return ({ 'font/woff': 'woff', 'font/woff2': 'woff2', 'font/ttf': 'ttf', 'font/otf': 'otf' })[mediaType] || 'font'; }

export class FontService {
  constructor(database, assets) { this.db = database.db; this.assets = assets; }
  create({ assetId, family: requestedFamily, weight = 400, style = 'normal' }) {
    const asset = this.assets.get(String(assetId || ''));
    if (!asset || asset.tombstonedAt || asset.kind !== 'font') throw Object.assign(new Error('A live ingested font asset is required'), { status: 422, code: 'font_asset_invalid' });
    if (asset.byteSize > MAX_EMBEDDED_FONT_BYTES) throw Object.assign(new Error('Fonts embedded in offline previews must be at most 512 KiB'), { status: 413, code: 'font_too_large' });
    const normalizedWeight = Number(weight);
    if (!Number.isInteger(normalizedWeight) || normalizedWeight < 100 || normalizedWeight > 900) throw Object.assign(new Error('Font weight must be an integer from 100 to 900'), { status: 422, code: 'font_weight_invalid' });
    const normalizedStyle = String(style || 'normal').toLowerCase();
    if (!['normal', 'italic', 'oblique'].includes(normalizedStyle)) throw Object.assign(new Error('Font style must be normal, italic, or oblique'), { status: 422, code: 'font_style_invalid' });
    const existing = this.db.prepare('SELECT id FROM font_records WHERE asset_id=?').get(asset.id);
    if (existing) return this.get(existing.id);
    const fontId = id();
    this.db.prepare('INSERT INTO font_records(id,asset_id,family,weight,style,created_at) VALUES(?,?,?,?,?,?)').run(fontId, asset.id, family(requestedFamily), normalizedWeight, normalizedStyle, now());
    return this.get(fontId);
  }
  get(fontId) {
    const row = this.db.prepare('SELECT * FROM font_records WHERE id=?').get(fontId); if (!row) return null;
    const asset = this.assets.get(row.asset_id); if (!asset) return null;
    return { id: row.id, assetId: row.asset_id, family: row.family, weight: Number(row.weight), style: row.style, mediaType: asset.mediaType, byteSize: asset.byteSize, checksum: asset.checksum, createdAt: row.created_at };
  }
  list() { return this.db.prepare('SELECT id FROM font_records ORDER BY created_at DESC').all().map(({ id: fontId }) => this.get(fontId)); }
  activate(projectId, fontId, active = true) {
    if (!this.db.prepare('SELECT 1 FROM projects WHERE id=? AND deleted_at IS NULL').get(projectId)) throw Object.assign(new Error('Project not found'), { status: 404, code: 'not_found' });
    if (!this.get(fontId)) throw Object.assign(new Error('Font not found'), { status: 404, code: 'not_found' });
    this.db.prepare(`INSERT INTO project_fonts(project_id,font_id,active) VALUES(?,?,?)
      ON CONFLICT(project_id,font_id) DO UPDATE SET active=excluded.active`).run(projectId, fontId, active ? 1 : 0);
    return { projectId, fontId, active: Boolean(active) };
  }
  active(projectId) { return this.db.prepare('SELECT font_id FROM project_fonts WHERE project_id=? AND active=1 ORDER BY font_id').all(projectId).map(({ font_id }) => this.get(font_id)).filter(Boolean); }
  css(fontId) {
    const font = this.get(fontId); if (!font) throw Object.assign(new Error('Font not found'), { status: 404, code: 'not_found' });
    const asset = this.assets.get(font.assetId); const bytes = fs.readFileSync(asset.path);
    if (bytes.length > MAX_EMBEDDED_FONT_BYTES) throw Object.assign(new Error('Font is too large for an offline preview'), { status: 413, code: 'font_too_large' });
    const assetPath = `assets/fonts/${font.checksum}.${extension(font.mediaType)}`;
    return `@font-face { font-family: ${quoted(font.family)}; src: url(${JSON.stringify(`../${assetPath}`)}) format(${JSON.stringify(font.mediaType.split('/')[1])}); font-weight: ${font.weight}; font-style: ${font.style}; font-display: swap; }`;
  }
  bundle(fontId) { const font = this.get(fontId); if (!font) throw Object.assign(new Error('Font not found'), { status: 404, code: 'not_found' }); const asset = this.assets.get(font.assetId); const bytes = fs.readFileSync(asset.path); return { path: `assets/fonts/${font.checksum}.${extension(font.mediaType)}`, content: `base64:${bytes.toString('base64')}` }; }
  content(fontId) { const font = this.get(fontId); if (!font) return null; const asset = this.assets.get(font.assetId); return { font, bytes: fs.readFileSync(asset.path) }; }
}

export { MAX_EMBEDDED_FONT_BYTES };
