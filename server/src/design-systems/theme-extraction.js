import crypto from 'node:crypto';
import { acceptsToken, normalizeTokens } from './compiler.js';
import { fetchThemeFromUrl } from '../security/theme-fetch.js';

const id = () => `theme-review:${crypto.randomBytes(12).toString('hex')}`;
const now = () => new Date().toISOString();
const decode = (value, fallback = null) => { try { return JSON.parse(value); } catch { return fallback; } };

// A real site defines far more custom properties than a design system may hold, and the
// compiler caps a theme at 200. Truncating by source order would keep whatever happened to be
// declared first, so tokens are ranked by how theme-like they are and the remainder is
// reported rather than silently dropped.
const TOKEN_LIMIT = 200;
const COLOR_VALUE = /^(?:#[0-9a-f]{3,8}|rgba?\(|hsla?\(|oklch\(|oklab\(|color\()/i;
const COLOR_NAME = /color|background|bg\b|foreground|\bfg\b|text|border|surface|accent|primary|secondary|brand|muted|danger|error|success|warning|info|link|shadow/i;
const SHAPE_NAME = /font|leading|tracking|size|weight|space|spacing|gap|radius|rounded|width|height|duration|ease/i;
export function selectThemeTokens(map) {
  const entries = Object.entries(map);
  if (entries.length <= TOKEN_LIMIT) return { tokens: map, omitted: 0 };
  const rank = ([name, value]) => (COLOR_VALUE.test(String(value).trim()) || COLOR_NAME.test(name) ? 0 : SHAPE_NAME.test(name) ? 1 : 2);
  const ordered = entries.map((entry, index) => ({ entry, index, rank: rank(entry) }))
    .sort((a, b) => a.rank - b.rank || a.index - b.index)
    .slice(0, TOKEN_LIMIT)
    .sort((a, b) => a.index - b.index); // Restore declaration order for a readable review.
  return { tokens: Object.fromEntries(ordered.map((item) => item.entry)), omitted: entries.length - ordered.length };
}

export function extractThemeTokens(css) {
  const source = String(css || '');
  if (!source.trim() || Buffer.byteLength(source) > 2 * 1024 * 1024) throw Object.assign(new Error('Theme CSS must be non-empty and at most 2 MiB'), { status: 413, code: 'theme_css_size_invalid' });
  // Executable CSS is refused outright. url() and @import are not executable and appear in
  // almost every real stylesheet (an embedded SVG, a webfont), so rejecting the whole
  // document for them discarded every safe token alongside them. They are filtered per token
  // instead: no value containing one is ever stored, which is the property that actually
  // matters, since only stored values are re-rendered later.
  if (/expression\s*\(|javascript:/i.test(source)) throw Object.assign(new Error('Theme extraction rejects executable CSS'), { status: 422, code: 'theme_css_unsafe' });
  const unsafeValue = /@import\b|url\s*\(|expression\s*\(|javascript:/i;
  const base = {}; const light = {}; const dark = {}; let skipped = 0; const token = /(--[a-z][a-z0-9-]{0,62})\s*:\s*([^;{}]+)\s*;/gi;
  for (const match of source.matchAll(token)) {
    const context = source.slice(Math.max(0, match.index - 300), match.index).toLowerCase(); const name = match[1].toLowerCase(); const value = match[2].trim();
    // Drop anything the compiler would reject rather than failing the whole import on it.
    if (unsafeValue.test(value) || !acceptsToken(name, value)) { skipped++; continue; }
    if (/data-theme\s*=\s*["']?dark|prefers-color-scheme\s*:\s*dark|(?:^|[\s.{])\.dark\b/.test(context)) dark[name] = value;
    else if (/data-theme\s*=\s*["']?light|prefers-color-scheme\s*:\s*light|(?:^|[\s.{])\.light\b/.test(context)) light[name] = value;
    else base[name] = value;
  }
  if (!Object.keys(base).length && !Object.keys(light).length && !Object.keys(dark).length) throw Object.assign(new Error('No CSS custom-property theme tokens were found'), { status: 422, code: 'theme_tokens_missing' });
  const selectedLight = selectThemeTokens({ ...base, ...light, ...(Object.keys(base).length || Object.keys(light).length ? {} : dark) });
  const selectedDark = selectThemeTokens({ ...base, ...(Object.keys(dark).length ? dark : light) });
  const omitted = selectedLight.omitted + selectedDark.omitted;
  const normalizedLight = normalizeTokens(selectedLight.tokens, 'extracted light');
  const normalizedDark = normalizeTokens(selectedDark.tokens, 'extracted dark');
  return { name: 'Extracted theme', defaultTheme: Object.keys(dark).length ? 'dark' : 'light', light: normalizedLight, dark: normalizedDark, markdown: '# Extracted theme\n\nReview every token before creating this design system.\n', summary: { baseTokenCount: Object.keys(base).length, lightTokenCount: Object.keys(light).length, darkTokenCount: Object.keys(dark).length, skippedUnsafeCount: skipped, omittedTokenCount: omitted } };
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
