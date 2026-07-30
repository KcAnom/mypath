import crypto from 'node:crypto';
import { normalizeTokens } from './compiler.js';
import { fetchThemeFromUrl } from '../security/theme-fetch.js';

const id = () => `theme-review:${crypto.randomBytes(12).toString('hex')}`;
const now = () => new Date().toISOString();
const decode = (value, fallback = null) => { try { return JSON.parse(value); } catch { return fallback; } };

export function extractThemeTokens(css) {
  const source = String(css || '');
  if (!source.trim() || Buffer.byteLength(source) > 2 * 1024 * 1024) throw Object.assign(new Error('Theme CSS must be non-empty and at most 2 MiB'), { status: 413, code: 'theme_css_size_invalid' });
  if (/@import\b|url\s*\(|expression\s*\(|javascript:/i.test(source)) throw Object.assign(new Error('Theme extraction rejects imports, URLs, and executable CSS'), { status: 422, code: 'theme_css_unsafe' });
  const base = {}; const light = {}; const dark = {}; const token = /(--[a-z][a-z0-9-]{0,62})\s*:\s*([^;{}]+)\s*;/gi;
  for (const match of source.matchAll(token)) {
    const context = source.slice(Math.max(0, match.index - 300), match.index).toLowerCase(); const name = match[1].toLowerCase(); const value = match[2].trim();
    if (/data-theme\s*=\s*["']?dark|prefers-color-scheme\s*:\s*dark|(?:^|[\s.{])\.dark\b/.test(context)) dark[name] = value;
    else if (/data-theme\s*=\s*["']?light|prefers-color-scheme\s*:\s*light|(?:^|[\s.{])\.light\b/.test(context)) light[name] = value;
    else base[name] = value;
  }
  if (!Object.keys(base).length && !Object.keys(light).length && !Object.keys(dark).length) throw Object.assign(new Error('No CSS custom-property theme tokens were found'), { status: 422, code: 'theme_tokens_missing' });
  const normalizedLight = normalizeTokens({ ...base, ...light, ...(Object.keys(base).length || Object.keys(light).length ? {} : dark) }, 'extracted light');
  const normalizedDark = normalizeTokens({ ...base, ...(Object.keys(dark).length ? dark : light) }, 'extracted dark');
  return { name: 'Extracted theme', defaultTheme: Object.keys(dark).length ? 'dark' : 'light', light: normalizedLight, dark: normalizedDark, markdown: '# Extracted theme\n\nReview every token before creating this design system.\n', summary: { baseTokenCount: Object.keys(base).length, lightTokenCount: Object.keys(light).length, darkTokenCount: Object.keys(dark).length } };
}

export class ThemeExtractionService {
  constructor(database, designSystems) { this.db = database.db; this.designSystems = designSystems; }
  store({ sourceKind, sourceUrl = null, finalUrl = null, proposal = null, diagnostics = [], metadata = {}, status = 'pending' }) {
    const reviewId = id(); this.db.prepare('INSERT INTO theme_extraction_reviews(id,source_kind,source_url,final_url,status,proposal_json,diagnostics_json,response_metadata_json,created_at) VALUES(?,?,?,?,?,?,?,?,?)').run(reviewId, sourceKind, sourceUrl, finalUrl, status, proposal ? JSON.stringify(proposal) : null, JSON.stringify(diagnostics), JSON.stringify(metadata), now()); return this.get(reviewId);
  }
  fromCss(css) { return this.store({ sourceKind: 'css', proposal: extractThemeTokens(css), metadata: { inputBytes: Buffer.byteLength(String(css || '')) } }); }
  async fromUrl(url) {
    try { const fetched = await fetchThemeFromUrl(url); return this.store({ sourceKind: 'url', sourceUrl: String(url), finalUrl: fetched.finalUrl, proposal: extractThemeTokens(fetched.css), metadata: { ...fetched.metadata, redirects: fetched.redirects } }); }
    catch (error) { if (error?.code === 'theme_url_ssrf_rejected' || error?.code === 'theme_url_policy' || error?.code === 'theme_url_invalid') throw error; return this.store({ sourceKind: 'url', sourceUrl: String(url), status: 'failed', diagnostics: [{ code: error.code || 'theme_fetch_failed', message: String(error.message || error) }] }); }
  }
  get(reviewId) { const row = this.db.prepare('SELECT * FROM theme_extraction_reviews WHERE id=?').get(reviewId); return row ? { id: row.id, sourceKind: row.source_kind, sourceUrl: row.source_url, finalUrl: row.final_url, status: row.status, proposal: decode(row.proposal_json), diagnostics: decode(row.diagnostics_json, []), metadata: decode(row.response_metadata_json, {}), designSystemId: row.created_design_system_id, versionId: row.created_version_id, createdAt: row.created_at, reviewedAt: row.reviewed_at } : null; }
  /** @param {string} reviewId @param {{approved?: boolean, proposal?: any}} [input] */
  review(reviewId, { approved, proposal } = {}) {
    const current = this.get(reviewId); if (!current) throw Object.assign(new Error('Theme review not found'), { status: 404, code: 'not_found' }); if (current.status !== 'pending') throw Object.assign(new Error('Theme extraction was already reviewed'), { status: 409, code: 'theme_already_reviewed' });
    if (!approved) { this.db.prepare("UPDATE theme_extraction_reviews SET status='rejected',reviewed_at=? WHERE id=?").run(now(), reviewId); return this.get(reviewId); }
    const checked = extractThemeTokens(`:root { ${Object.entries(proposal?.light || current.proposal.light).map(([name, value]) => `${name}:${value};`).join('')} } [data-theme="dark"] { ${Object.entries(proposal?.dark || current.proposal.dark).map(([name, value]) => `${name}:${value};`).join('')} }`);
    const created = this.designSystems.create({ ...current.proposal, ...proposal, light: checked.light, dark: checked.dark, name: String(proposal?.name || current.proposal.name || 'Reviewed theme') });
    this.db.prepare("UPDATE theme_extraction_reviews SET status='approved',proposal_json=?,created_design_system_id=?,created_version_id=?,reviewed_at=? WHERE id=?").run(JSON.stringify({ ...current.proposal, ...proposal, light: checked.light, dark: checked.dark }), created.id, created.currentVersion.id, now(), reviewId); return this.get(reviewId);
  }
}
