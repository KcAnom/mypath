import crypto from 'node:crypto';

const DROP_WITH_CONTENT = /<(script|iframe|object|embed|applet|template|noscript|svg|math|form)\b[^>]*>[\s\S]*?<\/\1\s*>/gi;
const DROP_TAG = /<\/?(?:script|iframe|object|embed|applet|template|noscript|svg|math|form|base|meta|link)\b[^>]*>/gi;
const EVENT_ATTRIBUTE = /\s+on[a-z0-9_-]+\s*=\s*(?:"[^"]*"|'[^']*'|[^\s>]+)/gi;
const RISKY_ATTRIBUTE = /\s+(?:srcdoc|nonce|integrity|crossorigin|formaction|ping|autofocus)\s*=\s*(?:"[^"]*"|'[^']*'|[^\s>]+)/gi;
const URL_ATTRIBUTE = /\s+(href|src|poster|action|background|cite)\s*=\s*("([^"]*)"|'([^']*)'|([^\s>]+))/gi;
const STYLE_ATTRIBUTE = /\s+style\s*=\s*("([^"]*)"|'([^']*)'|([^\s>]+))/gi;
const ALLOWED_STYLE = new Set(['color','background-color','font-family','font-size','font-weight','font-style','line-height','letter-spacing','text-align','text-decoration','display','flex-direction','justify-content','align-items','gap','padding','padding-top','padding-right','padding-bottom','padding-left','margin','margin-top','margin-right','margin-bottom','margin-left','border','border-width','border-style','border-color','border-radius','width','max-width','min-width','height','max-height','min-height','object-fit','opacity','box-shadow']);

function escapedAttribute(value) { return String(value).replaceAll('&', '&amp;').replaceAll('"', '&quot;').replaceAll('<', '&lt;').replaceAll('>', '&gt;'); }
function cleanStyle(value) {
  return String(value).split(';').flatMap((entry) => {
    const split = entry.indexOf(':'); if (split < 1) return [];
    const property = entry.slice(0, split).trim().toLowerCase(); const raw = entry.slice(split + 1).trim();
    if (!ALLOWED_STYLE.has(property) || !raw || /(?:url\s*\(|@import|expression\s*\(|javascript:|behavior\s*:|-moz-binding|[<>])/i.test(raw)) return [];
    return `${property}:${raw.slice(0, 200)}`;
  }).join(';');
}
function cleanUrl(value, baseUrl, attribute) {
  const source = String(value || '').trim(); if (!source) return '';
  if (attribute === 'href' && /^(?:#|mailto:)/i.test(source)) return source.startsWith('#') ? source : '';
  if (/^data:/i.test(source)) return attribute === 'src' && /^data:image\/(?:png|jpeg|gif|webp);base64,[a-z0-9+/=]+$/i.test(source) && source.length <= 256 * 1024 ? source : '';
  try { const url = new URL(source, baseUrl); return url.protocol === 'https:' && !url.username && !url.password ? url.href : ''; } catch { return ''; }
}

/** Sanitizes fetched/captured markup as inert reference data. It is never mounted as HTML or executed. */
export function sanitizeImportedHtml(input, baseUrl) {
  const original = String(input || '');
  if (!original.trim()) throw Object.assign(new Error('Imported page is empty'), { status: 422, code: 'web_import_empty' });
  if (Buffer.byteLength(original) > 4 * 1024 * 1024) throw Object.assign(new Error('Imported HTML exceeds 4 MiB'), { status: 413, code: 'web_import_too_large' });
  const diagnostics = [];
  let html = original.replace(/<!DOCTYPE[^>]*>/gi, '').replace(/<!--[\s\S]*?-->/g, '');
  const beforeDangerous = html; html = html.replace(DROP_WITH_CONTENT, '').replace(DROP_TAG, '');
  if (beforeDangerous !== html) diagnostics.push({ code: 'active_content_removed', message: 'Scripts, embedded documents, forms, or active metadata were removed.' });
  const beforeAttributes = html; html = html.replace(EVENT_ATTRIBUTE, '').replace(RISKY_ATTRIBUTE, '');
  if (beforeAttributes !== html) diagnostics.push({ code: 'active_attributes_removed', message: 'Event handlers and active attributes were removed.' });
  html = html.replace(STYLE_ATTRIBUTE, (_all, _quoted, doubleValue, singleValue, bareValue) => { const style = cleanStyle(doubleValue ?? singleValue ?? bareValue); return style ? ` style="${escapedAttribute(style)}"` : ''; });
  html = html.replace(URL_ATTRIBUTE, (_all, name, _quoted, doubleValue, singleValue, bareValue) => { const url = cleanUrl(doubleValue ?? singleValue ?? bareValue, baseUrl, name.toLowerCase()); return url ? ` ${name.toLowerCase()}="${escapedAttribute(url)}"` : ''; });
  // Unknown XML namespaces and control characters are unnecessary for semantic reference data.
  html = html.replace(/\s+xmlns(?::[\w-]+)?\s*=\s*(?:"[^"]*"|'[^']*')/gi, '').replace(/[\u0000-\u0008\u000b\u000c\u000e-\u001f]/g, '');
  return { html: html.trim(), diagnostics, originalChecksum: crypto.createHash('sha256').update(original).digest('hex'), sanitizedChecksum: crypto.createHash('sha256').update(html.trim()).digest('hex') };
}

function decodeEntities(value) { return String(value).replace(/&nbsp;/gi, ' ').replace(/&amp;/gi, '&').replace(/&lt;/gi, '<').replace(/&gt;/gi, '>').replace(/&quot;/gi, '"').replace(/&#39;|&apos;/gi, "'").replace(/&#(\d+);/g, (_all, number) => String.fromCodePoint(Math.min(0x10ffff, Number(number)))); }
function textOf(value) { return decodeEntities(String(value).replace(/<[^>]+>/g, ' ')).replace(/\s+/g, ' ').trim(); }

/** Deterministic, bounded semantic model used to generate a runnable React design. */
export function htmlToSemanticDesign(html, { finalUrl = '', title = '' } = {}) {
  const source = String(html || ''); const nodes = [];
  const pattern = /<(h[1-6]|p|button|a|li|blockquote|label|img)\b([^>]*)>([\s\S]*?)<\/\1\s*>|<img\b([^>]*)\/?\s*>/gi;
  for (const match of source.matchAll(pattern)) {
    if (nodes.length >= 160) break;
    const tag = (match[1] || 'img').toLowerCase(); const attrs = match[2] || match[4] || ''; const text = tag === 'img' ? '' : textOf(match[3]);
    const src = attrs.match(/\ssrc="([^"]+)"/i)?.[1] || ''; const alt = attrs.match(/\salt="([^"]*)"/i)?.[1] || '';
    if (tag === 'img' && src) nodes.push({ kind: 'image', src: decodeEntities(src), alt: decodeEntities(alt).slice(0, 240) });
    else if (text) nodes.push({ kind: /^h/.test(tag) ? 'heading' : tag === 'button' || tag === 'a' ? 'action' : tag === 'li' ? 'item' : 'text', level: /^h/.test(tag) ? Number(tag[1]) : undefined, text: text.slice(0, 1200) });
  }
  if (!nodes.length) { const text = textOf(source).slice(0, 4000); if (text) nodes.push({ kind: 'text', text }); }
  const pageTitle = title || textOf(source.match(/<title\b[^>]*>([\s\S]*?)<\/title>/i)?.[1] || '') || (() => { try { return new URL(finalUrl).hostname; } catch { return 'Imported page'; } })();
  return { version: 1, title: pageTitle.slice(0, 160), sourceUrl: finalUrl, nodes };
}

export { ALLOWED_STYLE as CAPTURE_STYLE_ALLOWLIST };
