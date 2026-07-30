import crypto from 'node:crypto';
import { CAPTURE_STYLE_ALLOWLIST, sanitizeImportedHtml } from './html-sanitizer.js';

const now = () => new Date().toISOString();
const id = (prefix) => `${prefix}:${crypto.randomBytes(12).toString('hex')}`;
const hash = (value) => crypto.createHash('sha256').update(String(value)).digest('hex');
const decode = (value, fallback = null) => { try { return JSON.parse(value); } catch { return fallback; } };
const MAX_SUBTREE_BYTES = 256 * 1024;
const MAX_SCREENSHOT_BYTES = 1024 * 1024;

function captureOrigin(value) {
  let url; try { url = new URL(String(value)); } catch { throw Object.assign(new Error('Capture origin is invalid'), { status: 422, code: 'capture_origin_invalid' }); }
  if (url.protocol !== 'https:' || url.username || url.password || url.origin !== String(value).replace(/\/$/, '')) throw Object.assign(new Error('Capture tickets require an exact credential-free HTTPS origin'), { status: 422, code: 'capture_origin_invalid' });
  return url.origin;
}
function pageUrl(value) { let url; try { url = new URL(String(value)); } catch { throw Object.assign(new Error('Captured page URL is invalid'), { status: 422, code: 'capture_page_invalid' }); } if (url.protocol !== 'https:' || url.username || url.password) throw Object.assign(new Error('Captured page must use credential-free HTTPS'), { status: 422, code: 'capture_page_invalid' }); return url; }
function safeStyles(input) {
  if (!input || typeof input !== 'object' || Array.isArray(input)) return {};
  const output = {};
  for (const [name, value] of Object.entries(input)) {
    const key = name.toLowerCase(); const text = String(value || '').slice(0, 200);
    if (CAPTURE_STYLE_ALLOWLIST.has(key) && text && !/(?:url\s*\(|expression\s*\(|javascript:|[<>])/i.test(text)) output[key] = text;
    if (Object.keys(output).length >= 64) break;
  }
  return output;
}
function screenshotBytes(value) { const matched = /^data:image\/(png|jpeg);base64,([A-Za-z0-9+/=]+)$/.exec(String(value || '')); if (!matched) throw Object.assign(new Error('Capture screenshot must be a PNG or JPEG data URL'), { status: 422, code: 'capture_screenshot_invalid' }); const bytes = Buffer.from(matched[2], 'base64'); if (!bytes.length || bytes.length > MAX_SCREENSHOT_BYTES) throw Object.assign(new Error('Capture screenshot exceeds 1 MiB'), { status: 413, code: 'capture_screenshot_too_large' }); return { bytes, extension: matched[1] === 'jpeg' ? 'jpg' : 'png' }; }

export class CaptureService {
  constructor(database, assets) { this.db = database.db; this.assets = assets; }
  createTicket(projectId, input = {}) {
    if (!this.db.prepare('SELECT 1 FROM projects WHERE id=?').get(projectId)) throw Object.assign(new Error('Project not found'), { status: 404, code: 'not_found' });
    const origin = captureOrigin(input.origin); const ticketId = id('capture-ticket'); const token = `mpc_${crypto.randomBytes(32).toString('base64url')}`; const ttl = Math.max(30, Math.min(300, Number(input.ttlSeconds || 120))); const createdAt = now(); const expiresAt = new Date(Date.now() + ttl * 1000).toISOString();
    this.db.prepare('INSERT INTO capture_tickets(id,token_hash,project_id,page_origin,expires_at,created_at) VALUES(?,?,?,?,?,?)').run(ticketId, hash(token), projectId, origin, expiresAt, createdAt);
    return { id: ticketId, token, projectId, origin, expiresAt, createdAt, singleUse: true, maxSubtreeBytes: MAX_SUBTREE_BYTES, maxScreenshotBytes: MAX_SCREENSHOT_BYTES };
  }
  ticket(ticketId) { const row = this.db.prepare('SELECT t.id,t.project_id,t.page_origin,t.expires_at,t.consumed_at,t.created_at,c.id capture_id FROM capture_tickets t LEFT JOIN surgical_captures c ON c.ticket_id=t.id WHERE t.id=?').get(ticketId); return row ? { id: row.id, projectId: row.project_id, origin: row.page_origin, expiresAt: row.expires_at, consumedAt: row.consumed_at, captureId: row.capture_id || null, state: row.consumed_at ? 'received' : Date.parse(row.expires_at) <= Date.now() ? 'expired' : 'waiting', createdAt: row.created_at, singleUse: true } : null; }
  listTickets(projectId) { return this.db.prepare('SELECT id FROM capture_tickets WHERE project_id=? ORDER BY created_at DESC LIMIT 50').all(projectId).map((row) => this.ticket(row.id)); }
  submit(ticketId, token, input = {}) {
    const tokenHash = hash(String(token || '').replace(/^Bearer\s+/i, '')); const ticket = this.db.prepare('SELECT * FROM capture_tickets WHERE id=? AND token_hash=?').get(ticketId, tokenHash);
    if (!ticket) throw Object.assign(new Error('Capture ticket or token is invalid'), { status: 401, code: 'capture_ticket_invalid' });
    if (ticket.consumed_at) throw Object.assign(new Error('Capture ticket was already used'), { status: 409, code: 'capture_ticket_consumed' });
    if (Date.parse(ticket.expires_at) <= Date.now()) throw Object.assign(new Error('Capture ticket expired'), { status: 410, code: 'capture_ticket_expired' });
    const url = pageUrl(input.pageUrl); if (url.origin !== ticket.page_origin) throw Object.assign(new Error('Captured page does not match the ticket origin'), { status: 403, code: 'capture_origin_mismatch' });
    const subtree = String(input.html || ''); if (!subtree || Buffer.byteLength(subtree) > MAX_SUBTREE_BYTES) throw Object.assign(new Error('Selected DOM subtree must be non-empty and at most 256 KiB'), { status: 413, code: 'capture_subtree_size_invalid' });
    const sanitized = sanitizeImportedHtml(subtree, url.href); const styles = safeStyles(input.computedStyles); const refs = Array.isArray(input.assetIds) ? [...new Set(input.assetIds.map(String))].slice(0, 16) : [];
    for (const assetId of refs) { const asset = this.assets.get(assetId); if (!asset || asset.projectId !== ticket.project_id || asset.tombstonedAt) throw Object.assign(new Error('Capture references an unapproved project asset'), { status: 422, code: 'capture_asset_unapproved' }); }
    let screenshotAsset = null; if (input.screenshot) { const screenshot = screenshotBytes(input.screenshot); screenshotAsset = this.assets.ingest({ projectId: ticket.project_id, name: `capture-${ticket.id}.${screenshot.extension}`, kind: 'image', bytes: screenshot.bytes }); }
    const captureId = id('capture'); const stamp = now();
    this.db.exec('BEGIN IMMEDIATE');
    try {
      const consumed = this.db.prepare('UPDATE capture_tickets SET consumed_at=? WHERE id=? AND consumed_at IS NULL AND expires_at>?').run(stamp, ticketId, stamp);
      if (!consumed.changes) throw Object.assign(new Error('Capture ticket was already used or expired'), { status: 409, code: 'capture_ticket_consumed' });
      this.db.prepare('INSERT INTO surgical_captures(id,ticket_id,project_id,page_url,sanitized_html,styles_json,screenshot_asset_id,asset_references_json,provenance_json,created_at) VALUES(?,?,?,?,?,?,?,?,?,?)').run(captureId, ticketId, ticket.project_id, url.href, sanitized.html, JSON.stringify(styles), screenshotAsset?.id || null, JSON.stringify(refs), JSON.stringify({ pageOrigin: url.origin, capturedAt: stamp, sanitizedChecksum: sanitized.sanitizedChecksum, originalChecksum: sanitized.originalChecksum, diagnostics: sanitized.diagnostics, trust: 'untrusted_reference', scriptsExecuted: false }), stamp);
      this.db.exec('COMMIT');
    } catch (error) { this.db.exec('ROLLBACK'); if (screenshotAsset) this.assets.tombstone(screenshotAsset.id); throw error; }
    return this.get(captureId);
  }
  get(captureId) { const row = this.db.prepare('SELECT * FROM surgical_captures WHERE id=?').get(captureId); return row ? { id: row.id, ticketId: row.ticket_id, projectId: row.project_id, pageUrl: row.page_url, sanitizedHtml: row.sanitized_html, computedStyles: decode(row.styles_json, {}), screenshotAssetId: row.screenshot_asset_id, assetIds: decode(row.asset_references_json, []), provenance: decode(row.provenance_json, {}), createdAt: row.created_at } : null; }
}

export const CAPTURE_LIMITS = Object.freeze({ MAX_SUBTREE_BYTES, MAX_SCREENSHOT_BYTES });
