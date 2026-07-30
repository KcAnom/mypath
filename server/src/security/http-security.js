import crypto from 'node:crypto';

export class HttpError extends Error {
  constructor(status, code, message, details) { super(message); this.status = status; this.code = code; this.details = details; }
}

function header(req, name) { return String(req.headers[name] || ''); }

export function requestAuthority(req) {
  const host = header(req, 'host');
  if (!host || /[\s,@/\\]/.test(host)) throw new HttpError(400, 'invalid_host', 'Invalid Host header');
  let parsed;
  try { parsed = new URL(`http://${host}`); } catch { throw new HttpError(400, 'invalid_host', 'Invalid Host header'); }
  const hostname = parsed.hostname.toLowerCase();
  if (hostname !== '127.0.0.1' && hostname !== 'localhost' && hostname !== '[::1]') throw new HttpError(403, 'host_rejected', 'Host must be a loopback address');
  const localPort = Number(req.socket.localPort || 0);
  const port = Number(parsed.port || 80);
  if (localPort && port !== localPort) throw new HttpError(403, 'host_rejected', 'Host port does not match the listening port');
  return parsed.origin;
}

export function enforceBrowserBoundary(req) {
  const authority = requestAuthority(req);
  const origin = header(req, 'origin');
  if (origin && origin !== authority) throw new HttpError(403, 'origin_rejected', 'Origin must exactly match the MyPath origin');
  const site = header(req, 'sec-fetch-site').toLowerCase();
  if (site && !['same-origin', 'none'].includes(site)) throw new HttpError(403, 'fetch_metadata_rejected', 'Cross-site requests are not allowed');
  const mode = header(req, 'sec-fetch-mode').toLowerCase();
  if (mode === 'navigate' && !['GET', 'HEAD'].includes(req.method || 'GET')) throw new HttpError(403, 'fetch_metadata_rejected', 'Navigation mode cannot mutate the API');
  return authority;
}

export class SessionManager {
  constructor({ ttlMs = Number(process.env.MYPATH_SESSION_TTL_MS || 30 * 60 * 1000), instanceNonce = process.env.MYPATH_INSTANCE_NONCE || '' } = {}) {
    this.ttlMs = ttlMs;
    this.instanceNonce = instanceNonce;
    this.sessions = new Map();
  }
  bootstrap(req) {
    if (this.instanceNonce) {
      const nonce = header(req, 'x-mypath-instance');
      // The desktop shell may place its nonce in the initial URL. Browser mode has no configured nonce.
      const queryNonce = new URL(req.url || '/', requestAuthority(req)).searchParams.get('instanceNonce') || '';
      const supplied = Buffer.from(nonce || queryNonce);
      const expected = Buffer.from(this.instanceNonce);
      if (supplied.length !== expected.length || !crypto.timingSafeEqual(supplied, expected)) throw new HttpError(403, 'instance_nonce_rejected', 'Desktop instance nonce is invalid');
    }
    const token = crypto.randomBytes(32).toString('base64url');
    const expiresAt = Date.now() + this.ttlMs;
    this.sessions.set(token, expiresAt);
    this.prune();
    return { token, expiresAt: new Date(expiresAt).toISOString() };
  }
  authenticate(req) {
    const token = header(req, 'x-mypath-session');
    if (!token) throw new HttpError(401, 'session_required', 'X-MyPath-Session is required');
    const expires = this.sessions.get(token);
    if (!expires || expires <= Date.now()) {
      this.sessions.delete(token);
      throw new HttpError(401, 'session_expired', 'Session is missing or expired');
    }
    return token;
  }
  authenticateInstance(req) {
    if (!this.instanceNonce) throw new HttpError(503, 'desktop_channel_unavailable', 'The native desktop channel is unavailable');
    const supplied = Buffer.from(header(req, 'x-mypath-instance'));
    const expected = Buffer.from(this.instanceNonce);
    if (supplied.length !== expected.length || !crypto.timingSafeEqual(supplied, expected)) throw new HttpError(403, 'instance_nonce_rejected', 'Desktop instance nonce is invalid');
    return true;
  }
  prune() {
    const time = Date.now();
    for (const [token, expiry] of this.sessions) if (expiry <= time) this.sessions.delete(token);
  }
}

export const SCREENSHOT_MAX_BYTES = 1024 * 1024;
export const SCREENSHOT_JSON_LIMIT = Math.ceil(SCREENSHOT_MAX_BYTES * 4 / 3) + 16 * 1024;

export function bodyLimitFor(pathname) {
  if (/\/skills\/import$/.test(pathname)) return 7 * 1024 * 1024;
  if (/\/capture-tickets\/[^/]+\/submission$/.test(pathname)) return 2 * 1024 * 1024;
  if (/\/imports\/figma$/.test(pathname)) return 5 * 1024 * 1024;
  if (/\/revisions\/[^/]+\/screenshots$/.test(pathname)) return SCREENSHOT_JSON_LIMIT;
  return /\/(?:chat-threads\/[^/]+\/(?:messages|runs)|chat\/runs)$/.test(pathname) ? 256 * 1024 : 1024 * 1024;
}

export function readJsonBody(req, limit) {
  return new Promise((resolve, reject) => {
    const chunks = [];
    let size = 0;
    let settled = false;
    const fail = (error) => { if (!settled) { settled = true; reject(error); } };
    req.on('data', (chunk) => {
      size += chunk.length;
      if (size > limit) {
        fail(new HttpError(413, 'body_too_large', `Request body exceeds ${limit} bytes`, { limit }));
        req.resume();
      } else chunks.push(chunk);
    });
    req.on('end', () => {
      if (settled) return;
      settled = true;
      if (!chunks.length) return resolve(undefined);
      try { resolve(JSON.parse(Buffer.concat(chunks).toString('utf8'))); }
      catch { reject(new HttpError(400, 'invalid_json', 'Request body must be valid JSON')); }
    });
    req.on('aborted', () => fail(new HttpError(400, 'request_aborted', 'Request was aborted')));
    req.on('error', fail);
  });
}

export function sendError(res, error, requestId) {
  const status = Number(error?.status) || 500;
  const code = error?.code || 'internal_error';
  const body = { error: { code, message: status === 500 ? 'Internal server error' : String(error.message || error), requestId } };
  if (error?.details !== undefined && status < 500) body.error.details = error.details;
  res.writeHead(status, { 'Content-Type': 'application/json; charset=utf-8', 'Cache-Control': 'no-store', 'X-Content-Type-Options': 'nosniff' });
  res.end(JSON.stringify(body));
}
