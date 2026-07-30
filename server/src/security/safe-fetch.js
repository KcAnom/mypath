import dns from 'node:dns/promises';
import https from 'node:https';
import net from 'node:net';
import zlib from 'node:zlib';
import { isBlockedAddress } from './theme-fetch.js';

export const SAFE_FETCH_LIMITS = Object.freeze({ maxCompressedBytes: 1024 * 1024, maxDecompressedBytes: 4 * 1024 * 1024, maxRedirects: 3, timeoutMs: 8_000, maxHeaderBytes: 16 * 1024 });

function policyError(message, code = 'fetch_url_policy', status = 422) { return Object.assign(new Error(message), { code, status }); }

/** Validate a credential-free public HTTPS URL. DNS is separately checked immediately before every connection. */
export function assertSafeFetchUrl(input) {
  let url;
  try { url = input instanceof URL ? new URL(input.href) : new URL(String(input)); }
  catch { throw policyError('URL is invalid', 'fetch_url_invalid'); }
  const host = url.hostname.replace(/^\[|\]$/g, '');
  if (url.protocol !== 'https:' || url.username || url.password || url.hash) throw policyError('Only credential-free HTTPS URLs are allowed');
  if (net.isIP(host) && isBlockedAddress(host)) throw policyError('URL targets a private, loopback, link-local, or reserved address', 'fetch_ssrf_rejected');
  return url;
}

async function publicRecords(hostname, lookup) {
  let records;
  try { records = await lookup(hostname, { all: true, verbatim: true }); }
  catch (error) { throw policyError(`DNS resolution failed: ${error.message}`, 'fetch_dns_failed'); }
  if (!Array.isArray(records)) records = [records];
  const normalized = records.map((entry) => typeof entry === 'string' ? { address: entry, family: net.isIP(entry) } : entry).filter((entry) => entry?.address);
  if (!normalized.length || normalized.some(({ address }) => isBlockedAddress(address))) throw policyError('DNS includes a private, loopback, link-local, or reserved address', 'fetch_ssrf_rejected');
  return normalized;
}

function decoded(bytes, encoding, limit) {
  try {
    if (!encoding || encoding === 'identity') return bytes;
    if (encoding === 'gzip') return zlib.gunzipSync(bytes, { maxOutputLength: limit });
    if (encoding === 'deflate') return zlib.inflateSync(bytes, { maxOutputLength: limit });
    if (encoding === 'br') return zlib.brotliDecompressSync(bytes, { maxOutputLength: limit });
  } catch { throw policyError('Response is malformed or exceeds the decompression limit', 'fetch_decompression_rejected', 413); }
  throw policyError(`Unsupported content encoding: ${encoding}`, 'fetch_encoding_invalid', 415);
}

async function once(url, options) {
  await publicRecords(url.hostname, options.lookup);
  return new Promise((resolve, reject) => {
    let settled = false;
    const finish = (error, value) => { if (settled) return; settled = true; clearTimeout(hardTimeout); error ? reject(error) : resolve(value); };
    const request = https.request(url, {
      method: 'GET', timeout: options.timeoutMs, maxHeaderSize: options.maxHeaderBytes,
      // Deliberately no Cookie, Authorization, Referer, or ambient credential headers.
      headers: { Accept: options.accept, 'Accept-Encoding': 'gzip, deflate, br', 'User-Agent': options.userAgent },
      lookup: async (hostname, lookupOptions, callback) => {
        try {
          const records = await publicRecords(hostname, options.lookup); // DNS-rebinding check at socket creation.
          const family = typeof lookupOptions === 'number' ? lookupOptions : lookupOptions?.family;
          const chosen = records.find((record) => !family || record.family === family) || records[0];
          callback(null, chosen.address, chosen.family);
        } catch (error) { callback(error, undefined, undefined); }
      },
    }, (response) => {
      const chunks = []; let size = 0;
      response.on('data', (chunk) => {
        size += chunk.length;
        if (size > options.maxCompressedBytes) {
          response.destroy();
          finish(policyError(`Response exceeds ${options.maxCompressedBytes} compressed bytes`, 'fetch_response_too_large', 413));
        } else chunks.push(chunk);
      });
      response.once('end', () => finish(null, { status: Number(response.statusCode || 0), headers: response.headers, bytes: Buffer.concat(chunks) }));
      response.once('error', (error) => finish(error));
    });
    const timedOut = () => policyError('Request timed out', 'fetch_timeout', 408);
    const hardTimeout = setTimeout(() => request.destroy(timedOut()), options.timeoutMs);
    request.once('timeout', () => request.destroy(timedOut()));
    request.once('error', (error) => finish(error));
    request.end();
  });
}

/**
 * Shared bounded SSRF-safe transport for web import, asset ingestion and opt-in search fetch.
 * Tests may inject `lookup`; production always uses node:dns.
 */
export async function fetchPublicHttps(input, config = {}) {
  const options = {
    ...SAFE_FETCH_LIMITS,
    lookup: config.lookup || dns.lookup,
    accept: String(config.accept || 'text/html,application/xhtml+xml;q=0.9,text/plain;q=0.5'),
    userAgent: String(config.userAgent || 'MyPath-Safe-Fetch/1'),
    ...Object.fromEntries(['maxCompressedBytes', 'maxDecompressedBytes', 'maxRedirects', 'timeoutMs'].map((key) => [key, Math.max(1, Math.min(Number(config[key] || SAFE_FETCH_LIMITS[key]), key === 'timeoutMs' ? 30_000 : 16 * 1024 * 1024))])),
  };
  let url = assertSafeFetchUrl(input); const redirects = [];
  for (let count = 0; count <= options.maxRedirects; count++) {
    const response = await once(url, options);
    if ([301, 302, 303, 307, 308].includes(response.status)) {
      if (count === options.maxRedirects) throw policyError('Redirect limit exceeded', 'fetch_redirect_limit');
      if (!response.headers.location) throw policyError('Redirect has no Location header', 'fetch_redirect_invalid');
      const next = assertSafeFetchUrl(new URL(response.headers.location, url));
      redirects.push({ from: url.href, to: next.href, status: response.status }); url = next; continue;
    }
    if (response.status < 200 || response.status >= 300) throw policyError(`Remote server returned HTTP ${response.status}`, 'fetch_http_error');
    const encoding = String(response.headers['content-encoding'] || 'identity').toLowerCase().trim();
    const bytes = decoded(response.bytes, encoding, options.maxDecompressedBytes);
    if (bytes.length > options.maxDecompressedBytes) throw policyError(`Response exceeds ${options.maxDecompressedBytes} decompressed bytes`, 'fetch_response_too_large', 413);
    const contentType = String(response.headers['content-type'] || '').split(';')[0].trim().toLowerCase();
    const allowed = config.allowedContentTypes || [];
    if (allowed.length && !allowed.some((type) => typeof type === 'string' ? contentType === type : type.test(contentType))) throw policyError(`Response content type is not allowed: ${contentType || 'missing'}`, 'fetch_mime_invalid', 415);
    return {
      bytes, finalUrl: url.href, redirects,
      headers: { contentType, contentEncoding: encoding, etag: String(response.headers.etag || ''), lastModified: String(response.headers['last-modified'] || ''), cacheControl: String(response.headers['cache-control'] || '') },
      diagnostics: [], compressedBytes: response.bytes.length, decompressedBytes: bytes.length,
    };
  }
  throw new Error('unreachable');
}
