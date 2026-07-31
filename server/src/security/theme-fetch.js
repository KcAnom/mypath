import dns from 'node:dns/promises';
import https from 'node:https';
import net from 'node:net';
import zlib from 'node:zlib';

const MAX_COMPRESSED = 1024 * 1024;
const MAX_DECOMPRESSED = 2 * 1024 * 1024;
const MAX_REDIRECTS = 3;
const TIMEOUT_MS = 8_000;

function ipv4Number(address) { const parts = address.split('.').map(Number); return parts.length === 4 && parts.every((part) => Number.isInteger(part) && part >= 0 && part <= 255) ? (((parts[0] * 256 + parts[1]) * 256 + parts[2]) * 256 + parts[3]) >>> 0 : null; }
function inV4(value, base, bits) { const mask = bits === 0 ? 0 : (0xffffffff << (32 - bits)) >>> 0; return (value & mask) === (ipv4Number(base) & mask); }
export function isBlockedAddress(address) {
  let value = String(address || '').toLowerCase().split('%')[0];
  if (value.startsWith('::ffff:')) { const mapped = value.slice(7); if (net.isIP(mapped) === 4) return isBlockedAddress(mapped); }
  const family = net.isIP(value); if (!family) return true;
  if (family === 4) {
    const number = ipv4Number(value); return [
      ['0.0.0.0', 8], ['10.0.0.0', 8], ['100.64.0.0', 10], ['127.0.0.0', 8], ['169.254.0.0', 16], ['172.16.0.0', 12], ['192.0.0.0', 24], ['192.0.2.0', 24], ['192.168.0.0', 16], ['198.18.0.0', 15], ['198.51.100.0', 24], ['203.0.113.0', 24], ['224.0.0.0', 4], ['240.0.0.0', 4],
    ].some(([base, bits]) => inV4(number, base, bits));
  }
  const compact = value.replace(/^\[|\]$/g, '');
  const mappedHex = compact.match(/^(?:::)?ffff:([0-9a-f]{1,4}):([0-9a-f]{1,4})$/);
  if (mappedHex) return isBlockedAddress(`${parseInt(mappedHex[1], 16) >>> 8}.${parseInt(mappedHex[1], 16) & 255}.${parseInt(mappedHex[2], 16) >>> 8}.${parseInt(mappedHex[2], 16) & 255}`);
  const sixToFour = compact.match(/^2002:([0-9a-f]{1,4}):([0-9a-f]{1,4})(?::|$)/); if (sixToFour && isBlockedAddress(`${parseInt(sixToFour[1], 16) >>> 8}.${parseInt(sixToFour[1], 16) & 255}.${parseInt(sixToFour[2], 16) >>> 8}.${parseInt(sixToFour[2], 16) & 255}`)) return true;
  return compact === '::' || compact === '::1' || /^f[cd]/.test(compact) || /^fe[89ab]/.test(compact) || /^ff/.test(compact) || /^2001:(?:0{1,4}:|0*db8(?:[:]|$))/.test(compact);
}
export function assertPublicHttpsUrl(value) {
  let url; try { url = new URL(String(value)); } catch { throw Object.assign(new Error('Theme URL is invalid'), { status: 422, code: 'theme_url_invalid' }); }
  if (url.protocol !== 'https:' || url.username || url.password || url.hash) throw Object.assign(new Error('Theme extraction requires a credential-free HTTPS URL'), { status: 422, code: 'theme_url_policy' });
  if (net.isIP(url.hostname.replace(/^\[|\]$/g, '')) && isBlockedAddress(url.hostname.replace(/^\[|\]$/g, ''))) throw Object.assign(new Error('Theme URL resolves to a private, loopback, link-local, or reserved address'), { status: 422, code: 'theme_url_ssrf_rejected' });
  return url;
}
async function resolvePublic(hostname, lookup) {
  let records; try { records = await lookup(hostname, { all: true, verbatim: true }); } catch (error) { throw Object.assign(new Error(`Theme host DNS resolution failed: ${error.message}`), { status: 422, code: 'theme_dns_failed' }); }
  if (!Array.isArray(records)) records = [records];
  const normalized = records.map((entry) => typeof entry === 'string' ? { address: entry, family: net.isIP(entry) } : entry).filter((entry) => entry?.address);
  if (!normalized.length || normalized.some((entry) => isBlockedAddress(entry.address))) throw Object.assign(new Error('Theme host DNS includes a private, loopback, link-local, or reserved address'), { status: 422, code: 'theme_url_ssrf_rejected' });
  return normalized;
}
function decompress(bytes, encoding) {
  try {
    if (!encoding || encoding === 'identity') return bytes;
    if (encoding === 'gzip') return zlib.gunzipSync(bytes, { maxOutputLength: MAX_DECOMPRESSED });
    if (encoding === 'deflate') return zlib.inflateSync(bytes, { maxOutputLength: MAX_DECOMPRESSED });
    if (encoding === 'br') return zlib.brotliDecompressSync(bytes, { maxOutputLength: MAX_DECOMPRESSED });
  } catch { throw Object.assign(new Error('Theme response exceeded decompression limits or was malformed'), { status: 422, code: 'theme_decompression_rejected' }); }
  throw Object.assign(new Error(`Unsupported theme response encoding: ${encoding}`), { status: 415, code: 'theme_encoding_invalid' });
}
function extractCss(body, contentType) {
  const text = body.toString('utf8'); if (text.includes('\ufffd')) throw Object.assign(new Error('Theme response must be UTF-8 text'), { status: 415, code: 'theme_mime_invalid' });
  if (/^(?:text\/css|application\/css)\b/i.test(contentType)) return text;
  if (/^(?:text\/html|application\/xhtml\+xml)\b/i.test(contentType)) {
    const styles = [...text.matchAll(/<style\b[^>]*>([\s\S]*?)<\/style\s*>/gi)].map((match) => match[1]);
    const colors = [...text.matchAll(/<meta\s+[^>]*name=["']theme-color["'][^>]*content=["']([^"']+)["'][^>]*>/gi)].map((match) => `:root { --theme-color: ${match[1]}; }`);
    if (!styles.length && !colors.length) throw Object.assign(new Error('HTML contains no inline reviewed theme CSS'), { status: 422, code: 'theme_css_missing' });
    return [...styles, ...colors].join('\n');
  }
  throw Object.assign(new Error('Theme response must be CSS or HTML'), { status: 415, code: 'theme_mime_invalid' });
}
async function requestOnce(url, { lookup, timeoutMs }) {
  await resolvePublic(url.hostname, lookup); // Validate before creating a socket.
  return new Promise((resolve, reject) => {
    const request = https.request(url, {
      method: 'GET', timeout: timeoutMs, maxHeaderSize: 16 * 1024,
      headers: { Accept: 'text/css,text/html;q=0.8', 'Accept-Encoding': 'gzip, deflate, br', 'User-Agent': 'MyPath-Theme-Review/1' },
      lookup: async (hostname, options, callback) => { // Re-resolve immediately at connect time to reject rebinding.
        try {
          const records = await resolvePublic(hostname, lookup); // Throws unless every resolved address is public.
          const requestedFamily = typeof options === 'number' ? options : options?.family;
          const matching = records.filter((entry) => !requestedFamily || entry.family === requestedFamily);
          const usable = matching.length ? matching : records;
          // Happy Eyeballs (autoSelectFamily, on by default since Node 20) calls lookup with
          // all:true and expects an array; answering with a single address makes net read
          // addresses[0].address off a string and fail with ERR_INVALID_IP_ADDRESS.
          if ((typeof options === 'object' && options?.all) === true) callback(null, usable.map((entry) => ({ address: entry.address, family: entry.family })));
          else callback(null, usable[0].address, usable[0].family);
        } catch (error) { callback(error, undefined, undefined); }
      },
    }, (response) => {
      const chunks = []; let total = 0; let done = false;
      const fail = (error) => { if (!done) { done = true; clearTimeout(hardTimeout); response.destroy(); reject(error); } };
      response.on('data', (chunk) => { total += chunk.length; if (total > MAX_COMPRESSED) fail(Object.assign(new Error('Theme response exceeds 1 MiB compressed limit'), { status: 413, code: 'theme_response_too_large' })); else chunks.push(chunk); });
      response.on('end', () => { if (done) return; done = true; clearTimeout(hardTimeout); resolve({ status: Number(response.statusCode || 0), headers: response.headers, bytes: Buffer.concat(chunks) }); }); response.on('error', fail);
    });
    const timeoutError = () => Object.assign(new Error('Theme request timed out'), { status: 408, code: 'theme_fetch_timeout' });
    const hardTimeout = setTimeout(() => request.destroy(timeoutError()), timeoutMs);
    request.once('timeout', () => request.destroy(timeoutError())); request.once('error', (error) => { clearTimeout(hardTimeout); reject(error); }); request.end();
  });
}

export async function fetchThemeFromUrl(input, options = {}) {
  const lookup = options.lookup || dns.lookup; const timeoutMs = Math.max(100, Math.min(TIMEOUT_MS, Number(options.timeoutMs || TIMEOUT_MS))); let url = assertPublicHttpsUrl(input); const redirects = [];
  for (let count = 0; count <= MAX_REDIRECTS; count++) {
    const response = await requestOnce(url, { lookup, timeoutMs });
    if ([301, 302, 303, 307, 308].includes(response.status)) {
      if (count === MAX_REDIRECTS) throw Object.assign(new Error('Theme URL exceeded redirect limit'), { status: 422, code: 'theme_redirect_limit' });
      const location = response.headers.location; if (!location) throw Object.assign(new Error('Theme redirect has no location'), { status: 422, code: 'theme_redirect_invalid' });
      const next = assertPublicHttpsUrl(new URL(location, url)); redirects.push({ from: url.href, to: next.href, status: response.status }); url = next; continue;
    }
    if (response.status < 200 || response.status >= 300) throw Object.assign(new Error(`Theme URL returned HTTP ${response.status}`), { status: 422, code: 'theme_http_error' });
    const encoding = String(response.headers['content-encoding'] || 'identity').toLowerCase().trim(); const body = decompress(response.bytes, encoding); if (body.length > MAX_DECOMPRESSED) throw Object.assign(new Error('Theme response exceeds 2 MiB decompressed limit'), { status: 413, code: 'theme_response_too_large' });
    const contentType = String(response.headers['content-type'] || '').split(';')[0].trim(); const css = extractCss(body, contentType);
    return { css, finalUrl: url.href, redirects, metadata: { contentType, contentEncoding: encoding, compressedBytes: response.bytes.length, decompressedBytes: body.length } };
  }
  throw new Error('unreachable');
}

export const THEME_FETCH_LIMITS = { MAX_COMPRESSED, MAX_DECOMPRESSED, MAX_REDIRECTS, TIMEOUT_MS };
