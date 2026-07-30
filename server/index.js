/**
 * MyPath local server — canvas + generation + design systems
 * Zero npm deps. Data in ./data
 */
import http from 'node:http';
import crypto from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { Store } from './store.js';
import { generateComponent } from './generate.js';
import { CandidateService } from './src/build/candidate-service.js';
import { CanvasService } from './src/canvas/canvas-service.js';
import { AssetService } from './src/assets/asset-service.js';
import { FontService } from './src/fonts/font-service.js';
import { DesignSystemService } from './src/design-systems/design-system-service.js';
import { ThemeExtractionService } from './src/design-systems/theme-extraction.js';
import { LibraryService } from './src/libraries/library-service.js';
import { SkillService } from './src/skills/skill-service.js';
import { ContextService } from './src/context/context-service.js';
import { EditService } from './src/editor/edit-service.js';
import { VariantService } from './src/editor/variant-service.js';
import { ProviderRegistry } from './src/runs/provider-registry.js';
import { RunService } from './src/runs/run-service.js';
import { ExportService } from './src/export/export-service.js';
import { ExternalAgentService } from './src/external-agents/external-agent-service.js';
import { WebImportService } from './src/web-import/web-import-service.js';
import { CaptureService } from './src/web-import/capture-service.js';
import { SearchService } from './src/search/search-service.js';
import { FigmaService } from './src/figma/figma-service.js';
import { HttpError, SessionManager, bodyLimitFor, enforceBrowserBoundary, readJsonBody, requestAuthority, sendError } from './src/security/http-security.js';
import { validateMutation } from './src/routes/mutations.js';
import { validateKeyResponse } from './src/routes/responses.js';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.resolve(__dirname, '..');
const WEB_BUILD = path.join(ROOT, '.runtime', 'web');
const WEB = fs.existsSync(path.join(WEB_BUILD, 'index.html')) ? WEB_BUILD : path.join(ROOT, 'web');
const PORT = Number(process.env.MYPATH_API_PORT ?? process.env.PORT ?? 8787);
if (!Number.isInteger(PORT) || PORT < 0 || PORT > 65535) throw new Error('MYPATH_API_PORT must be an integer from 0 to 65535');
let LISTEN_PORT = PORT;
const DATA = path.resolve(process.env.MYPATH_DATA_DIR || path.join(ROOT, 'data'));
const store = new Store(DATA);
const candidates = new CandidateService(store);
const canvases = new CanvasService(store.database);
const assets = new AssetService(store.database, DATA);
const fonts = new FontService(store.database, assets);
const designSystems = new DesignSystemService(store, fonts);
const skills = new SkillService(store);
const libraries = new LibraryService(store, candidates, canvases);
const themes = new ThemeExtractionService(store.database, designSystems);
const contexts = new ContextService(store.database, canvases, { designSystems, libraries, skills, fonts });
const edits = new EditService(store, candidates);
const variants = new VariantService(store, candidates, canvases);
const providers = new ProviderRegistry(store.database);
const runs = new RunService({ store, candidates, canvases, contexts, providers });
const exportsService = new ExportService(store, assets);
const externalAgents = new ExternalAgentService(store, candidates, contexts);
const webImports = new WebImportService({ store, candidates, canvases, assets });
const captures = new CaptureService(store.database, assets);
const search = new SearchService(store.database);
const figma = new FigmaService(store, candidates, canvases);
const sessions = new SessionManager();
canvases.resume();
const SERVER_PID_FILE = path.join(DATA, 'server.pid');
if (fs.existsSync(SERVER_PID_FILE)) {
  const priorPid = Number(fs.readFileSync(SERVER_PID_FILE, 'utf8').trim());
  if (priorPid && priorPid !== process.pid) {
    try { process.kill(priorPid, 0); throw new Error(`MyPath data directory is already open by PID ${priorPid}`); }
    catch (error) { if (error.code !== 'ESRCH') throw error; }
  }
  fs.rmSync(SERVER_PID_FILE, { force: true });
}
fs.writeFileSync(SERVER_PID_FILE, String(process.pid), { mode: 0o600 });
function closeServerState() {
  try {
    if (fs.readFileSync(SERVER_PID_FILE, 'utf8').trim() === String(process.pid)) fs.rmSync(SERVER_PID_FILE, { force: true });
  } catch {}
  try { runs.close(); } catch {}
  try { store.close(); } catch {}
}
process.once('exit', closeServerState);
process.once('SIGINT', () => { closeServerState(); process.exit(0); });
process.once('SIGTERM', () => { closeServerState(); process.exit(0); });

const MIME = {
  '.html': 'text/html; charset=utf-8',
  '.js': 'text/javascript; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.json': 'application/json',
  '.svg': 'image/svg+xml',
  '.png': 'image/png',
  '.tsx': 'text/plain; charset=utf-8',
  '.ts': 'text/plain; charset=utf-8',
};

function send(res, status, body, headers = {}) {
  if (res.mypathRoute) validateKeyResponse(res.mypathRoute.method, res.mypathRoute.pathname, status, body);
  if (status >= 400) {
    const message = body && typeof body === 'object' && body.error ? body.error : body;
    if (!(message && typeof message === 'object' && message.code && message.message)) {
      body = { error: { code: status === 404 ? 'not_found' : 'request_failed', message: String(message || 'Request failed') } };
    }
  }
  const isObj = body !== null && typeof body === 'object' && !Buffer.isBuffer(body);
  const payload = isObj ? JSON.stringify(body) : body ?? '';
  res.writeHead(status, {
    'Content-Type': isObj ? 'application/json; charset=utf-8' : (headers['Content-Type'] || 'text/plain; charset=utf-8'),
    'Cache-Control': isObj ? 'no-store' : 'no-cache',
    'X-Content-Type-Options': 'nosniff',
    'Referrer-Policy': 'no-referrer',
    'Content-Security-Policy': "default-src 'none'; frame-ancestors 'none'; base-uri 'none'",
    ...headers,
  });
  res.end(payload);
}

function match(pathname, pattern) {
  const pp = pattern.split('/').filter(Boolean);
  const sp = pathname.split('/').filter(Boolean);
  if (pp.length !== sp.length) return null;
  const params = {};
  for (let i = 0; i < pp.length; i++) {
    if (pp[i].startsWith(':')) params[pp[i].slice(1)] = decodeURIComponent(sp[i]);
    else if (pp[i] !== sp[i]) return null;
  }
  return params;
}

function isLive(entity) { return entity && !entity.deletedAt && !entity.tombstonedAt; }

async function readAssetUpload(req) {
  const maximum = 20 * 1024 * 1024;
  const length = Number(req.headers['content-length'] || 0);
  if (length > maximum + 64 * 1024) throw new HttpError(413, 'asset_too_large', 'Asset upload exceeds 20 MiB');
  const chunks = []; let total = 0;
  for await (const chunk of req) { total += chunk.length; if (total > maximum + 64 * 1024) throw new HttpError(413, 'asset_too_large', 'Asset upload exceeds 20 MiB'); chunks.push(chunk); }
  const raw = Buffer.concat(chunks); const type = String(req.headers['content-type'] || '');
  if (type.startsWith('application/json')) {
    let value; try { value = JSON.parse(raw.toString('utf8')); } catch { throw new HttpError(400, 'json_invalid', 'Invalid JSON'); }
    const matched = /^data:[^;,]+;base64,([A-Za-z0-9+/=]+)$/.exec(String(value.dataUrl || ''));
    const bytes = matched ? Buffer.from(matched[1], 'base64') : Buffer.from(String(value.base64 || ''), 'base64');
    return { name: value.name, kind: value.kind, bytes };
  }
  const boundary = type.match(/boundary=(?:"([^"]+)"|([^;]+))/)?.slice(1).find(Boolean);
  if (!boundary || boundary.length > 100) throw new HttpError(415, 'multipart_required', 'Use multipart/form-data or JSON base64');
  const delimiter = Buffer.from(`--${boundary}`); const result = {};
  let cursor = 0;
  while ((cursor = raw.indexOf(delimiter, cursor)) >= 0) {
    const headerStart = cursor + delimiter.length + 2; const headerEnd = raw.indexOf(Buffer.from('\r\n\r\n'), headerStart); if (headerEnd < 0) break;
    const next = raw.indexOf(delimiter, headerEnd + 4); if (next < 0) break;
    const headers = raw.subarray(headerStart, headerEnd).toString('utf8'); const data = raw.subarray(headerEnd + 4, next - 2);
    const name = headers.match(/name="([^"]+)"/)?.[1]; const filename = headers.match(/filename="([^"]*)"/)?.[1];
    if (name === 'file') { result.bytes = data; result.name = filename || 'upload'; }
    else if (name) result[name] = data.toString('utf8');
    cursor = next;
  }
  if (!result.bytes) throw new HttpError(400, 'asset_missing', 'Multipart field "file" is required');
  return result;
}

function ensureCanvas(db, helpers, projectId) {
  let c = db.canvases.find((x) => x.projectId === projectId);
  if (!c) {
    c = {
      id: helpers.id(),
      projectId,
      shapes: [],
      camera: { x: 0, y: 0, zoom: 1 },
      updatedAt: helpers.now(),
    };
    db.canvases.push(c);
  }
  return c;
}

async function createGeneratedComponent(projectId, input = {}) {
  const prompt = input.prompt || input.name || 'New component';
  let generated = generateComponent({ prompt, nameHint: input.name });
  const component = store.with((db, h) => {
    const project = db.projects.find((item) => item.id === projectId && isLive(item));
    if (!project) return null;
    const time = h.now();
    const item = {
      id: h.id(), projectId, name: input.name || generated.name, generatedName: h.slugName(generated.name), prompt,
      code: '', files: {}, selectedRevisionId: null, createdAt: time, updatedAt: time,
    };
    db.components.unshift(item);
    ensureCanvas(db, h, projectId);
    project.updatedAt = time;
    return item;
  });
  if (!component) return null;
  const operationalContext = contexts.operational(projectId, input.context || {});
  generated = { ...generated, files: contexts.applyToGeneratedFiles(generated.files, { operationalContext }) };
  const queued = candidates.create({ componentId: component.id, files: generated.files, expectedBaseRevisionId: null, metadata: contexts.revisionMetadata({ operationalContext }), note: generated.note || 'generated' });
  const build = await candidates.run(queued.buildId);
  const current = store.get();
  const promoted = current.components.find((item) => item.id === component.id);
  const revision = current.revisions.find((item) => item.id === build.revision_id) || null;
  let job = null;
  if (revision) job = store.with((db, h) => {
    const item = { id: h.id(), componentId: component.id, revisionId: revision.id, candidateId: queued.candidateId, buildId: build.id, status: 'completed', createdAt: component.createdAt, finishedAt: h.now() };
    db.jobs.unshift(item); return item;
  });
  if (revision && job) {
    const count = canvases.get(projectId)?.snapshot?.document?.store ? Object.keys(canvases.get(projectId).snapshot.document.store).filter((key) => key.startsWith('shape:')).length : 0;
    canvases.publish(projectId, job.id, { componentId: component.id, revisionId: revision.id, title: component.name, x: 80 + (count % 4) * 390, y: 80 + Math.floor(count / 4) * 350, w: 360, h: 320 });
  }
  return { component: promoted, revision, build, candidate: candidates.getCandidate(queued.candidateId) };
}

async function api(req, res, url) {
  const method = req.method || 'GET';
  const rawPath = url.pathname.replace(/\/$/, '') || '/';
  res.mypathRoute = { method, pathname: rawPath };
  if (method === 'GET' && (rawPath === '/api/session' || rawPath === '/api/v1/session')) {
    return send(res, 200, sessions.bootstrap(req));
  }
  const p = rawPath === '/api/v1' ? '/' : (rawPath.startsWith('/api/v1/') ? rawPath.slice('/api/v1'.length) : rawPath);
  let agentGrant = null;
  const captureSubmission = method === 'POST' && /^\/capture-tickets\/[^/]+\/submission$/.test(p);
  if ((method !== 'GET' || p !== '/health') && !captureSubmission) {
    if (p === '/native/export-destination-grants') sessions.authenticateInstance(req);
    else if (p.startsWith('/external-agent/')) {
      const desktopReview = method === 'POST' && /^\/external-agent\/submissions\/[^/]+\/(?:accept|reject)$/.test(p);
      if (desktopReview) {
        if (/^Bearer\s/i.test(String(req.headers.authorization || ''))) throw new HttpError(403, 'agent_self_approval_forbidden', 'External-agent tokens cannot accept or reject candidates');
        sessions.authenticate(req);
      } else agentGrant = externalAgents.authenticate(req);
    } else sessions.authenticate(req);
  }
  const isAssetUpload = method === 'POST' && /^\/projects\/[^/]+\/assets$/.test(p);
  const body = isAssetUpload ? await readAssetUpload(req) : (['POST', 'PUT', 'PATCH'].includes(method) ? await readJsonBody(req, bodyLimitFor(p)) : undefined);
  validateMutation(method, p, body);

  if (method === 'GET' && p === '/health') {
    const supplied = String(req.headers['x-mypath-instance'] || '');
    const expected = String(process.env.MYPATH_INSTANCE_NONCE || '');
    const instanceAuthenticated = Boolean(expected && supplied.length === expected.length && crypto.timingSafeEqual(Buffer.from(supplied), Buffer.from(expected)));
    return send(res, 200, { ok: true, product: 'mypath', mode: 'local-solo', instanceAuthenticated, features: ['canvas', 'generation', 'design-systems', 'project-chat', 'parallel-jobs', 'visual-editing', 'revision-restore', 'variants', 'reproducible-export', 'external-agents', 'safe-web-import', 'surgical-capture', 'opt-in-search', 'figma-exchange-v1'] });
  }

  // ---- Phase 7: immutable web import, capture, opt-in search, and Figma exchange ----
  {
    const m = match(p, '/projects/:id/imports/web');
    if (m && method === 'POST') return send(res, 202, await webImports.create(m.id, body || {}));
    if (m && method === 'GET') return send(res, 200, webImports.list(m.id));
  }
  {
    const m = match(p, '/imports/:id');
    if (m && method === 'GET') { const imported = webImports.get(m.id); return imported ? send(res, 200, imported) : send(res, 404, { error: 'web import not found' }); }
  }
  {
    const m = match(p, '/imports/:id/convert');
    if (m && method === 'POST') return send(res, 202, await webImports.convert(m.id, body || {}));
  }
  {
    const m = match(p, '/phase7/jobs/:id');
    if (m && method === 'GET') { const job = webImports.getJob(m.id); return job ? send(res, 200, job) : send(res, 404, { error: 'job not found' }); }
  }
  {
    const m = match(p, '/projects/:id/capture-tickets');
    if (m && method === 'GET') return send(res, 200, captures.listTickets(m.id));
    if (m && method === 'POST') return send(res, 201, captures.createTicket(m.id, body || {}));
  }
  {
    const m = match(p, '/capture-tickets/:id');
    if (m && method === 'GET') { const ticket = captures.ticket(m.id); return ticket ? send(res, 200, ticket) : send(res, 404, { error: 'capture ticket not found' }); }
  }
  {
    const m = match(p, '/capture-tickets/:id/submission');
    if (m && method === 'POST') return send(res, 201, captures.submit(m.id, String(req.headers.authorization || ''), body || {}));
  }
  {
    const m = match(p, '/captures/:id');
    if (m && method === 'GET') { const capture = captures.get(m.id); return capture ? send(res, 200, capture) : send(res, 404, { error: 'capture not found' }); }
  }
  if (p === '/search/providers' && method === 'GET') return send(res, 200, search.listProviders());
  if (p === '/search/providers' && method === 'POST') return send(res, 201, search.createProvider(body || {}));
  {
    const m = match(p, '/search/providers/:id');
    if (m && (method === 'PATCH' || method === 'PUT')) return send(res, 200, search.configure(m.id, body || {}));
  }
  {
    const m = match(p, '/projects/:id/search');
    if (m && method === 'POST') return send(res, 202, await search.search(m.id, body || {}));
  }
  {
    const m = match(p, '/search/queries/:id');
    if (m && method === 'GET') { const query = search.get(m.id); return query ? send(res, 200, query) : send(res, 404, { error: 'search record not found' }); }
  }
  {
    const m = match(p, '/search/queries/:id/results/:index/fetch');
    if (m && method === 'POST') return send(res, 202, await search.fetchResult(m.id, Number(m.index), body || {}));
  }
  {
    const m = match(p, '/search/contexts/:id');
    if (m && method === 'GET') { const context = search.getContext(m.id); return context ? send(res, 200, context) : send(res, 404, { error: 'search context not found' }); }
  }
  {
    const m = match(p, '/projects/:id/imports/figma');
    if (m && method === 'POST') return send(res, 202, await figma.import(m.id, body?.exchange || body));
  }
  {
    const m = match(p, '/revisions/:id/figma-exchange');
    if (m && method === 'GET') return send(res, 200, figma.exportRevision(m.id));
  }
  {
    const m = match(p, '/figma-exchanges/:id');
    if (m && method === 'GET') { const record = figma.get(m.id); return record ? send(res, 200, record) : send(res, 404, { error: 'Figma exchange not found' }); }
  }

  // ---- native-only destination grant channel ----
  if (method === 'POST' && p === '/native/export-destination-grants') return send(res, 201, exportsService.createDestinationGrant(body?.canonicalPath));

  // ---- scoped external-agent API; candidates cannot approve themselves ----
  if (method === 'GET' && p === '/external-agent/projects') return send(res, 200, externalAgents.projects(agentGrant));
  {
    const m = match(p, '/external-agent/projects/:id/context');
    if (m && method === 'GET') return send(res, 200, externalAgents.projectContext(agentGrant, m.id));
  }
  {
    const m = match(p, '/external-agent/projects/:id/edit-sessions');
    if (m && method === 'POST') return send(res, 201, externalAgents.startSession(agentGrant, m.id, body || {}));
  }
  {
    const m = match(p, '/external-agent/edit-sessions/:id');
    if (m && method === 'GET') return send(res, 200, externalAgents.session(agentGrant, m.id));
  }
  {
    const m = match(p, '/external-agent/edit-sessions/:id/forge-boundary');
    if (m && method === 'GET') return send(res, 200, externalAgents.boundary(agentGrant, m.id));
  }
  {
    const m = match(p, '/external-agent/edit-sessions/:id/submissions');
    if (m && method === 'POST') return send(res, 201, await externalAgents.submit(agentGrant, m.id, body || {}));
  }
  {
    const m = match(p, '/external-agent/submissions/:id');
    if (m && method === 'GET') return send(res, 200, externalAgents.submissionForGrant(agentGrant, m.id));
  }
  {
    const m = match(p, '/external-agent/submissions/:id/build');
    if (m && method === 'GET') { const submission = externalAgents.submissionForGrant(agentGrant, m.id); return send(res, 200, submission.build); }
  }
  {
    const m = match(p, '/external-agent/builds/:id');
    if (m && method === 'GET') return send(res, 200, externalAgents.buildForGrant(agentGrant, m.id));
  }
  {
    const m = match(p, '/external-agent/jobs/:id');
    if (m && method === 'GET') return send(res, 200, externalAgents.submissionForGrant(agentGrant, m.id));
  }
  {
    const m = match(p, '/external-agent/submissions/:id/diff');
    if (m && method === 'GET') return send(res, 200, externalAgents.submissionForGrant(agentGrant, m.id).diff);
  }
  {
    const m = match(p, '/external-agent/submissions/:id/accept');
    if (m && method === 'POST') return send(res, 200, externalAgents.accept(m.id));
  }
  {
    const m = match(p, '/external-agent/submissions/:id/reject');
    if (m && method === 'POST') return send(res, 200, externalAgents.reject(m.id));
  }

  // Desktop sessions create/revoke grants and review the pending queue. Raw tokens are
  // returned exactly once; stored grants contain only SHA-256 token hashes.
  if (method === 'GET' && p === '/external-agent-grants') return send(res, 200, externalAgents.listGrants());
  if (method === 'POST' && p === '/external-agent-grants') return send(res, 201, externalAgents.createGrant(body || {}));
  {
    const m = match(p, '/external-agent-grants/:id');
    if (m && method === 'DELETE') return externalAgents.revoke(m.id) ? send(res, 204, '') : send(res, 404, { error: 'grant not found' });
  }
  if (method === 'GET' && p === '/external-agent-submissions') return send(res, 200, externalAgents.listPending());

  // ---- user ----
  if (method === 'GET' && p === '/users/me') return send(res, 200, store.get().user);

  // ---- projects ----
  if (method === 'GET' && (p === '/projects' || p === '/users/me/projects')) {
    return send(res, 200, store.get().projects.filter(isLive));
  }
  if (method === 'POST' && p === '/projects') {
    const project = store.with((db, h) => {
      const proj = {
        id: h.id(),
        name: body?.name || 'Untitled project',
        description: body?.description || '',
        createdAt: h.now(),
        updatedAt: h.now(),
      };
      db.projects.unshift(proj);
      ensureCanvas(db, h, proj.id);
      return proj;
    });
    return send(res, 201, project);
  }
  {
    const m = match(p, '/projects/:id');
    if (m && method === 'GET') {
      const proj = store.get().projects.find((x) => x.id === m.id && isLive(x));
      return proj ? send(res, 200, proj) : send(res, 404, { error: 'not found' });
    }
    if (m && (method === 'PATCH' || method === 'PUT')) {
      const proj = store.with((db, h) => {
        const i = db.projects.findIndex((x) => x.id === m.id && isLive(x));
        if (i < 0) return null;
        db.projects[i] = { ...db.projects[i], ...body, id: m.id, updatedAt: h.now() };
        return db.projects[i];
      });
      return proj ? send(res, 200, proj) : send(res, 404, { error: 'not found' });
    }
    if (m && method === 'DELETE') {
      const ok = store.with((db, h) => {
        const project = db.projects.find((x) => x.id === m.id && isLive(x));
        if (!project) return false;
        project.deletedAt = h.now();
        project.updatedAt = project.deletedAt;
        for (const component of db.components.filter((item) => item.projectId === m.id && isLive(item))) {
          component.deletedAt = project.deletedAt;
          component.updatedAt = project.deletedAt;
        }
        for (const image of db.images.filter((item) => item.projectId === m.id && isLive(item))) {
          image.tombstonedAt = project.deletedAt;
          image.disabled = true;
        }
        return true;
      });
      return ok ? send(res, 204, '') : send(res, 404, { error: 'not found' });
    }
  }

  // ---- versioned tldraw canvas (CAS; stale clients never overwrite) ----
  {
    const m = match(p, '/projects/:id/canvas');
    if (m && method === 'GET') {
      // Creation remains in the compatibility transaction; snapshots are materialized afterward.
      if (!canvases.rowForProject(m.id) && store.get().projects.some((x) => x.id === m.id && isLive(x))) store.with((db, h) => ensureCanvas(db, h, m.id));
      const canvas = canvases.get(m.id);
      return canvas ? send(res, 200, canvas) : send(res, 404, { error: 'project not found' });
    }
    if (m && (method === 'PUT' || method === 'PATCH')) {
      const saved = canvases.save(m.id, body?.version, body?.snapshot, body?.camera || {});
      if (!saved) return send(res, 404, { error: 'project not found' });
      if (saved.conflict) return send(res, 409, { error: { code: 'canvas_version_conflict', message: 'Canvas changed; merge with the latest version', details: { current: saved.current } } });
      return send(res, 200, saved);
    }
  }
  {
    const m = match(p, '/projects/:id/canvas/publications');
    if (m && method === 'POST') {
      const publication = canvases.publish(m.id, body?.logicalJobId, body?.frame || {});
      return publication ? send(res, publication.status === 'materialized' ? 201 : 202, publication) : send(res, 404, { error: 'project not found' });
    }
  }

  // ---- validated, content-addressed assets ----
  {
    const m = match(p, '/projects/:id/assets');
    if (m && method === 'GET') return send(res, 200, assets.list(m.id).map(({ path: ignored, ...asset }) => asset));
    if (m && method === 'POST') {
      if (!store.get().projects.some((x) => x.id === m.id && isLive(x))) return send(res, 404, { error: 'project not found' });
      const asset = assets.ingest({ projectId: m.id, name: body.name, kind: body.kind, bytes: body.bytes }); const { path: ignored, ...safe } = asset;
      return send(res, 201, safe);
    }
  }
  {
    const m = match(p, '/assets/:id/content');
    if (m && method === 'GET') { const asset = assets.get(m.id); if (!asset || asset.tombstonedAt) return send(res, 404, { error: 'asset not found' }); return send(res, 200, fs.readFileSync(asset.path), { 'Content-Type': asset.mediaType, 'Content-Length': String(asset.byteSize), 'Content-Disposition': `${asset.kind === 'image' ? 'inline' : 'attachment'}; filename="${asset.name.replace(/["\\]/g, '_')}"`, 'Cache-Control': 'private, max-age=31536000, immutable' }); }
    if (m && method === 'DELETE') return assets.tombstone(m.id) ? send(res, 204, '') : send(res, 404, { error: 'asset not found' });
  }
  if (method === 'POST' && p === '/assets/gc') return send(res, 200, { removed: assets.gc({ retentionMs: body?.retentionMs, backupPath: body?.backupPath }) });

  // ---- immutable ContextEnvelopeV1 and searchable mentions ----
  {
    const m = match(p, '/projects/:id/context-snapshots');
    if (m && method === 'POST') return send(res, 201, contexts.create(m.id, body || {}));
  }
  {
    const m = match(p, '/context-snapshots/:id');
    if (m && method === 'GET') { const value = contexts.get(m.id); return value ? send(res, 200, value) : send(res, 404, { error: 'context not found' }); }
  }
  {
    const m = match(p, '/projects/:id/mentions');
    if (m && method === 'GET') return send(res, 200, contexts.mentions(m.id, url.searchParams.get('q') || ''));
  }

  // ---- supported-subset visual editing, revision operations, and variants ----
  {
    const m = match(p, '/revisions/:id/mapping');
    if (m && method === 'GET') { const mapping = edits.mapping(m.id); return mapping ? send(res, 200, mapping) : send(res, 404, { error: 'revision not found' }); }
  }
  {
    const m = match(p, '/components/:id/edit-sessions');
    if (m && method === 'POST') return send(res, 201, edits.create(m.id, body?.baseRevisionId));
  }
  {
    const m = match(p, '/edit-sessions/:id');
    if (m && method === 'GET') { const session = edits.get(m.id); return session ? send(res, 200, session) : send(res, 404, { error: 'edit session not found' }); }
    if (m && method === 'DELETE') { const session = edits.cancel(m.id); return session ? send(res, 200, session) : send(res, 404, { error: 'edit session not found' }); }
  }
  {
    const m = match(p, '/edit-sessions/:id/operations');
    if (m && method === 'POST') { const session = edits.append(m.id, body); return session ? send(res, 201, session) : send(res, 404, { error: 'edit session not found' }); }
  }
  {
    const m = match(p, '/edit-sessions/:id/done');
    if (m && method === 'POST') { const session = await edits.done(m.id); return session ? send(res, 201, session) : send(res, 404, { error: 'edit session not found' }); }
  }
  {
    const m = match(p, '/revisions/:id/compare');
    if (m && method === 'GET') { const comparison = edits.compare(m.id, url.searchParams.get('otherRevisionId')); return comparison ? send(res, 200, comparison) : send(res, 404, { error: 'revision not found' }); }
  }
  {
    const m = match(p, '/components/:id/checkout');
    if (m && method === 'POST') { const component = edits.checkout(m.id, body?.revisionId); return component ? send(res, 200, component) : send(res, 404, { error: 'component or revision not found' }); }
  }
  {
    const m = match(p, '/revisions/:id/restore');
    if (m && method === 'POST') { const result = await edits.restore(m.id, body?.note); return result ? send(res, 201, result) : send(res, 404, { error: 'revision not found' }); }
  }
  {
    const m = match(p, '/components/:id/variants');
    if (m && method === 'GET') return send(res, 200, variants.list(m.id));
    if (m && method === 'POST') return send(res, 201, await variants.create(m.id, body?.directions));
  }
  {
    const m = match(p, '/variant-groups/:id');
    if (m && method === 'GET') { const group = variants.get(m.id); return group ? send(res, 200, group) : send(res, 404, { error: 'variant group not found' }); }
  }

  // ---- durable candidates, builds, event transport, and historical previews ----
  {
    const m = match(p, '/components/:id/candidates');
    if (m && method === 'POST') {
      const component = store.get().components.find((item) => item.id === m.id && isLive(item));
      if (!component) return send(res, 404, { error: 'component not found' });
      const files = body?.files || (body?.code ? { ...(component.files || {}), [Object.keys(component.files || {}).find((name) => name.includes('generated') && name.endsWith('.tsx')) || 'src/App.tsx']: body.code } : null);
      if (!files) return send(res, 400, { error: 'files or code required' });
      const queued = candidates.create({ componentId: m.id, files, expectedBaseRevisionId: body?.expectedBaseRevisionId, note: body?.note || 'candidate' });
      const build = body?.defer === true ? candidates.getBuild(queued.buildId) : await candidates.run(queued.buildId);
      const candidate = candidates.getCandidate(queued.candidateId);
      if (build.status === 'failed') return send(res, 422, { error: { code: build.diagnostics?.[0]?.code || 'candidate_build_failed', message: 'Candidate source did not compile', details: { candidate, build } } });
      return send(res, build.status === 'queued' ? 202 : 201, { candidate, build });
    }
  }
  {
    const m = match(p, '/candidates/:id');
    if (m && method === 'GET') {
      const candidate = candidates.getCandidate(m.id);
      return candidate ? send(res, 200, candidate) : send(res, 404, { error: 'candidate not found' });
    }
  }
  {
    const m = match(p, '/builds/:id');
    if (m && method === 'GET') {
      const build = candidates.getBuild(m.id);
      return build ? send(res, 200, build) : send(res, 404, { error: 'build not found' });
    }
  }
  {
    const m = match(p, '/builds/:id/run');
    if (m && method === 'POST') {
      const build = await candidates.run(m.id);
      return send(res, build.status === 'failed' ? 422 : 200, build);
    }
  }
  {
    const m = match(p, '/builds/:id/events');
    if (m && method === 'GET') {
      if (!candidates.getBuild(m.id)) return send(res, 404, { error: 'build not found' });
      let cursor = Number(req.headers['last-event-id'] || url.searchParams.get('after') || 0);
      let closed = false;
      res.on('close', () => { closed = true; });
      res.writeHead(200, {
        'Content-Type': 'text/event-stream; charset=utf-8', 'Cache-Control': 'no-store', Connection: 'keep-alive',
        'X-Accel-Buffering': 'no', 'X-Content-Type-Options': 'nosniff', 'Content-Security-Policy': "default-src 'none'",
      });
      res.flushHeaders?.();
      let lastKeepAlive = Date.now();
      while (!closed) {
        const events = candidates.events(m.id, cursor);
        for (const event of events) {
          cursor = event.id;
          res.write(`id: ${event.id}\nevent: ${event.type}\ndata: ${JSON.stringify(event.data)}\n\n`);
        }
        const build = candidates.getBuild(m.id);
        if (build && ['failed', 'succeeded'].includes(build.status) && !candidates.events(m.id, cursor).length) break;
        if (Date.now() - lastKeepAlive >= 10_000) { res.write(': keep-alive\n\n'); lastKeepAlive = Date.now(); }
        await new Promise((resolve) => setTimeout(resolve, 75));
      }
      if (!closed) res.end();
      return;
    }
  }
  {
    const m = match(p, '/revisions/:id/retry-build');
    if (m && method === 'POST') {
      const build = await candidates.buildRevision(m.id, { retry: true });
      return send(res, build.status === 'failed' ? 422 : 200, build.status === 'failed' ? { error: { code: build.diagnostics?.[0]?.code || 'build_failed', message: 'Historical revision rebuild failed', details: { build } } } : build);
    }
  }
  {
    const m = match(p, '/revisions/:id/preview');
    if (m && method === 'GET') {
      const preview = await candidates.artifactForRevision(m.id);
      if (!preview.html) return send(res, 422, { error: { code: 'build_failed', message: 'Revision could not be built', details: { build: preview.build } } });
      return send(res, 200, preview.html, {
        'Content-Type': 'text/html; charset=utf-8',
        'Content-Security-Policy': "default-src 'none'; script-src 'unsafe-inline'; style-src 'unsafe-inline'; img-src data: blob:; font-src data:; connect-src 'none'; object-src 'none'; base-uri 'none'; frame-ancestors 'self'",
      });
    }
  }
  {
    const m = match(p, '/revisions/:id/screenshots');
    if (m && method === 'POST') {
      const parsed = /^data:(image\/(?:png|jpeg|webp));base64,([A-Za-z0-9+/=]+)$/.exec(String(body?.dataUrl || ''));
      if (!parsed) return send(res, 422, { error: { code: 'screenshot_invalid', message: 'A base64 PNG, JPEG, or WebP data URL is required' } });
      const screenshot = candidates.saveScreenshot({ revisionId: m.id, buildId: body?.buildId || null, width: Number(body?.width || 0), height: Number(body?.height || 0), mediaType: parsed[1], bytes: Buffer.from(parsed[2], 'base64') });
      return send(res, 201, screenshot);
    }
  }
  {
    const m = match(p, '/revisions/:id/export.zip');
    if (m && method === 'GET') { const output = exportsService.packageFor(m.id); return send(res, 200, output.zip, { 'Content-Type': 'application/zip', 'Content-Length': String(output.zip.length), 'Content-Disposition': `attachment; filename="${output.filename}"`, 'Cache-Control': 'private, no-store' }); }
  }
  {
    const m = match(p, '/revisions/:id/export-manifest');
    if (m && method === 'GET') { const manifest = exportsService.getManifest(m.id); return manifest ? send(res, 200, manifest) : send(res, 404, { error: 'export manifest not found' }); }
  }
  {
    const m = match(p, '/revisions/:id/export-directory');
    if (m && method === 'POST') return send(res, 201, exportsService.exportToGrantedDestination(m.id, body?.destinationGrantId));
  }

  // ---- project components list / create ----
  {
    const m = match(p, '/projects/:id/components');
    if (m && method === 'GET') {
      return send(res, 200, store.get().components.filter((c) => c.projectId === m.id && isLive(c)));
    }
    if (m && method === 'POST') {
      const result = await createGeneratedComponent(m.id, body || {});
      if (!result) return send(res, 404, { error: 'project not found' });
      return send(res, result.build.status === 'succeeded' ? 201 : 422, result);
    }
  }

  // ---- generate shortcut ----
  if (method === 'POST' && p === '/generate') {
    const projectId = body?.projectId;
    if (!projectId) return send(res, 400, { error: 'projectId required' });
    const result = await createGeneratedComponent(projectId, body || {});
    if (!result) return send(res, 404, { error: 'project not found' });
    return send(res, result.build.status === 'succeeded' ? 201 : 422, result);
  }

  // ---- single component ----
  {
    const m = match(p, '/components/:id');
    if (m && method === 'GET') {
      const c = store.get().components.find((x) => x.id === m.id && isLive(x));
      return c ? send(res, 200, c) : send(res, 404, { error: 'not found' });
    }
    if (m && (method === 'PATCH' || method === 'PUT')) {
      const previous = store.get().components.find((item) => item.id === m.id && isLive(item));
      if (!previous) return send(res, 404, { error: 'not found' });
      if ((body?.code && body.code !== previous.code) || body?.files) {
        const files = { ...(previous.files || {}), ...(body.files || {}) };
        if (body?.code && !body.files) {
          const key = Object.keys(files).find((name) => name.includes('generated') && name.endsWith('.tsx')) || 'src/App.tsx';
          files[key] = body.code;
        }
        const queued = candidates.create({ componentId: m.id, files, expectedBaseRevisionId: previous.selectedRevisionId || null, note: body?.note || 'edit' });
        const build = await candidates.run(queued.buildId);
        if (build.status !== 'succeeded') return send(res, 422, { error: { code: build.diagnostics?.[0]?.code || 'candidate_build_failed', message: 'Candidate source did not compile', details: { candidateId: queued.candidateId, build } } });
      }
      const metadata = { ...(body || {}) };
      delete metadata.code; delete metadata.files; delete metadata.selectedRevisionId;
      const c = Object.keys(metadata).length ? store.with((db, h) => {
        const index = db.components.findIndex((item) => item.id === m.id && isLive(item));
        db.components[index] = { ...db.components[index], ...metadata, id: m.id, updatedAt: h.now() };
        return db.components[index];
      }) : store.get().components.find((item) => item.id === m.id);
      return send(res, 200, c);
    }
    if (m && method === 'DELETE') {
      const ok = store.with((db, h) => {
        const component = db.components.find((x) => x.id === m.id && isLive(x));
        if (!component) return false;
        component.deletedAt = h.now();
        component.updatedAt = component.deletedAt;
        for (const canvas of db.canvases) canvas.shapes = canvas.shapes.filter((shape) => shape.componentId !== m.id);
        return true;
      });
      return ok ? send(res, 204, '') : send(res, 404, { error: 'not found' });
    }
  }

  // revisions
  {
    const m = match(p, '/components/:id/revisions');
    if (m && method === 'GET') {
      return send(res, 200, store.get().revisions.filter((r) => r.componentId === m.id));
    }
  }
  {
    const m = match(p, '/components/:id/revision/:revisionId/code');
    if (m && method === 'GET') {
      const r = store.get().revisions.find((x) => x.id === m.revisionId && x.componentId === m.id);
      return r ? send(res, 200, { code: r.code, files: r.files }) : send(res, 404, { error: 'not found' });
    }
  }

  // forge files listing
  {
    const m = match(p, '/components/:id/files');
    if (m && method === 'GET') {
      const c = store.get().components.find((x) => x.id === m.id && isLive(x));
      if (!c) return send(res, 404, { error: 'not found' });
      return send(res, 200, c.files || {});
    }
  }

  // Runnable component preview. The client fetches this with session auth and places it in
  // a sandboxed iframe srcdoc, so the main session token is never exposed to preview code.
  {
    const m = match(p, '/components/:id/preview');
    if (m && method === 'GET') {
      const component = store.get().components.find((item) => item.id === m.id && isLive(item));
      if (!component) return send(res, 404, 'not found', { 'Content-Type': 'text/plain' });
      if (!component.selectedRevisionId) return send(res, 422, { error: { code: 'preview_unavailable', message: 'Component has no successfully built revision' } });
      const preview = await candidates.artifactForRevision(component.selectedRevisionId);
      if (!preview.html) return send(res, 422, { error: { code: 'build_failed', message: 'Selected revision could not be built', details: { build: preview.build } } });
      return send(res, 200, preview.html, {
        'Content-Type': 'text/html; charset=utf-8',
        'Content-Security-Policy': "default-src 'none'; script-src 'unsafe-inline'; style-src 'unsafe-inline'; img-src data: blob:; font-src data:; connect-src 'none'; object-src 'none'; base-uri 'none'; frame-ancestors 'self'",
      });
    }
  }

  // ---- operational, immutable design-system versions and reviewed extraction ----
  if (method === 'GET' && (p === '/design-systems' || p === '/users/me/design-systems')) return send(res, 200, designSystems.list());
  if (method === 'POST' && p === '/design-systems') return send(res, 201, designSystems.create(body || {}));
  {
    const m = match(p, '/design-systems/:id/versions');
    if (m && method === 'GET') return send(res, 200, designSystems.versions(m.id));
    if (m && method === 'POST') return send(res, 201, designSystems.createVersion(m.id, body || {}));
  }
  {
    const m = match(p, '/design-systems/:id/versions/:versionId');
    if (m && method === 'GET') { const version = designSystems.getVersion(m.versionId); return version?.designSystemId === m.id ? send(res, 200, version) : send(res, 404, { error: 'not found' }); }
  }
  {
    const m = match(p, '/design-systems/:id');
    if (m && method === 'GET') { const design = designSystems.get(m.id); return design ? send(res, 200, design) : send(res, 404, { error: 'not found' }); }
    if (m && (method === 'PATCH' || method === 'PUT')) return send(res, 201, designSystems.update(m.id, body || {}));
    if (m && method === 'DELETE') return designSystems.remove(m.id) ? send(res, 204, '') : send(res, 404, { error: 'not found' });
  }
  {
    const m = match(p, '/projects/:id/design-system');
    if (m && (method === 'PUT' || method === 'PATCH')) return send(res, 200, designSystems.activate(m.id, body?.versionId, body?.active !== false));
  }
  if (method === 'POST' && (p === '/theme-extractions' || p === '/design-systems/extract-from-url')) return send(res, 201, body?.url ? await themes.fromUrl(body.url) : themes.fromCss(body?.css));
  {
    const m = match(p, '/design-systems/extract-from-url/:jobId');
    if (m && method === 'GET') { const review = themes.get(m.jobId); return review ? send(res, 200, review) : send(res, 404, { error: 'not found' }); }
  }
  {
    const m = match(p, '/theme-extractions/:id');
    if (m && method === 'GET') { const review = themes.get(m.id); return review ? send(res, 200, review) : send(res, 404, { error: 'not found' }); }
  }
  {
    const m = match(p, '/theme-extractions/:id/review');
    if (m && method === 'POST') return send(res, 200, themes.review(m.id, body || {}));
  }

  // ---- local offline fonts ----
  if (method === 'GET' && (p === '/fonts' || p === '/users/me/fonts')) return send(res, 200, fonts.list());
  if (method === 'POST' && p === '/fonts') return send(res, 201, fonts.create(body || {}));
  {
    const m = match(p, '/fonts/:id');
    if (m && method === 'GET') { const font = fonts.get(m.id); return font ? send(res, 200, font) : send(res, 404, { error: 'not found' }); }
  }
  {
    const m = match(p, '/fonts/:id/content');
    if (m && method === 'GET') { const content = fonts.content(m.id); return content ? send(res, 200, content.bytes, { 'Content-Type': content.font.mediaType, 'Content-Length': String(content.bytes.length), 'Cache-Control': 'private, max-age=31536000, immutable' }) : send(res, 404, { error: 'not found' }); }
  }
  {
    const m = match(p, '/projects/:id/fonts/:fontId');
    if (m && (method === 'PUT' || method === 'PATCH')) return send(res, 200, fonts.activate(m.id, m.fontId, body?.active !== false));
  }

  // ---- versioned text-only skills ----
  if (method === 'GET' && (p === '/users/me/skills' || p === '/skills')) return send(res, 200, skills.list());
  if (method === 'POST' && (p === '/users/me/skills' || p === '/skills')) return send(res, 201, skills.create(body || {}));
  if (method === 'POST' && (p === '/skills/import' || p === '/users/me/skills/import')) {
    const encoded = String(body?.base64 || '');
    if (!encoded || !/^(?:[A-Za-z0-9+/]{4})*(?:[A-Za-z0-9+/]{2}==|[A-Za-z0-9+/]{3}=)?$/.test(encoded)) throw new HttpError(400, 'skill_package_invalid', 'Skill package base64 is invalid');
    return send(res, 201, skills.importPackage({ bytes: Buffer.from(encoded, 'base64'), packageName: body?.name || 'skill.skill' }));
  }
  {
    const m = match(p, '/skills/:id');
    if (m && method === 'GET') { const skill = skills.get(m.id); return skill ? send(res, 200, skill) : send(res, 404, { error: 'not found' }); }
    if (m && (method === 'PATCH' || method === 'PUT')) return send(res, 201, skills.update(m.id, body || {}));
    if (m && method === 'DELETE') return skills.remove(m.id) ? send(res, 204, '') : send(res, 404, { error: 'not found or built-in' });
  }
  {
    const m = match(p, '/skills/:id/files');
    if (m && method === 'GET') { const skill = skills.get(m.id); return skill ? send(res, 200, skill.currentVersion?.files || []) : send(res, 404, { error: 'not found' }); }
  }
  {
    const m = match(p, '/skills/:id/files/content');
    if (m && method === 'GET') { const skill = skills.get(m.id); const file = skill?.currentVersion?.files?.find((entry) => entry.path === url.searchParams.get('path')); return file ? send(res, 200, file.content) : send(res, 404, { error: 'not found' }); }
  }
  {
    const m = match(p, '/projects/:id/skills/:skillId');
    if (m && (method === 'PUT' || method === 'PATCH')) return send(res, 200, skills.activate(m.id, m.skillId, body?.active !== false));
  }
  {
    const m = match(p, '/projects/:id/skills/suggest');
    if (m && method === 'POST') return send(res, 200, skills.resolveSelection(m.id, body?.selectedSkillIds || [], body?.prompt || '', body?.allowDescriptionActivation === true));
  }

  // ---- exact-revision libraries, activation, browse, drag and copy provenance ----
  if (method === 'GET' && p === '/libraries') return send(res, 200, libraries.list());
  if (method === 'POST' && p === '/libraries') return send(res, 201, libraries.create(body || {}));
  {
    const m = match(p, '/libraries/:id');
    if (m && method === 'GET') { const library = libraries.get(m.id); return library ? send(res, 200, library) : send(res, 404, { error: 'not found' }); }
  }
  {
    const m = match(p, '/libraries/:id/components');
    if (m && method === 'GET') return send(res, 200, libraries.members(m.id));
    if (m && method === 'POST') return send(res, 201, libraries.add(m.id, body?.componentId, body?.revisionId));
  }
  {
    const m = match(p, '/libraries/:id/components/:componentId');
    if (m && method === 'DELETE') return libraries.remove(m.id, m.componentId) ? send(res, 204, '') : send(res, 404, { error: 'not found' });
  }
  {
    const m = match(p, '/libraries/:id/copy');
    if (m && method === 'POST') return send(res, 201, await libraries.copy({ libraryId: m.id, componentId: body?.componentId, revisionId: body?.revisionId, targetProjectId: body?.targetProjectId, name: body?.name }));
  }
  {
    const m = match(p, '/libraries/:id/components/:componentId/copy-to-project');
    if (m && method === 'POST') { const member = libraries.members(m.id).find((entry) => entry.componentId === m.componentId && (!body?.revisionId || entry.revisionId === body.revisionId)); return member ? send(res, 201, await libraries.copy({ libraryId: m.id, componentId: m.componentId, revisionId: member.revisionId, targetProjectId: body?.targetProjectId || body?.projectId, name: body?.name })) : send(res, 422, { error: { code: 'library_revision_mismatch', message: 'Exact library revision is required' } }); }
  }
  {
    const m = match(p, '/libraries/:id/active');
    if (m && (method === 'PUT' || method === 'PATCH' || method === 'POST')) return send(res, 200, libraries.activate(body?.projectId, m.id, body?.active !== false));
  }
  {
    const m = match(p, '/projects/:id/libraries/:libraryId');
    if (m && (method === 'PUT' || method === 'PATCH')) return send(res, 200, libraries.activate(m.id, m.libraryId, body?.active !== false));
  }
  {
    const m = match(p, '/projects/:id/canvas/library-items');
    if (m && method === 'POST') return send(res, 201, libraries.reuseOnCanvas({ libraryId: body?.libraryId, componentId: body?.componentId, revisionId: body?.revisionId, targetProjectId: m.id, x: body?.x, y: body?.y }));
  }
  {
    const m = match(p, '/projects/:id/operational-context');
    if (m && method === 'GET') return send(res, 200, { selected: contexts.operational(m.id), designSystems: designSystems.list(), libraries: libraries.list(), skills: skills.list(), fonts: fonts.list() });
  }

  // ---- Phase 3 project-scoped chat and durable parallel runs ----
  if (method === 'GET' && p === '/provider-configs') return send(res, 200, providers.list());
  if (method === 'POST' && p === '/provider-configs') return send(res, 201, providers.save(body || {}));
  {
    const m = match(p, '/provider-configs/:id');
    if (m && (method === 'PUT' || method === 'PATCH')) return send(res, 200, providers.save(body || {}, m.id));
  }
  {
    const m = match(p, '/projects/:id/chat/threads');
    if (m && method === 'GET') return send(res, 200, runs.projectThreads(m.id));
    if (m && method === 'POST') return send(res, 201, runs.createThread(m.id, body?.title));
  }
  {
    const m = match(p, '/projects/:id/chat/threads/:threadId/messages');
    if (m && method === 'GET') { const messages = runs.messages(m.id, m.threadId); return messages ? send(res, 200, messages) : send(res, 404, { error: 'project thread not found' }); }
  }
  {
    const m = match(p, '/projects/:id/chat/threads/:threadId/runs');
    if (m && method === 'POST') return send(res, 202, runs.createRun({ projectId: m.id, threadId: m.threadId, prompt: body?.prompt, contextSnapshotId: body?.contextSnapshotId, providerConfigId: body?.providerConfigId, deliverables: body?.deliverables }));
  }
  {
    const m = match(p, '/projects/:id/chat/runs');
    if (m && method === 'POST') return send(res, 202, runs.createThreadRun({ projectId: m.id, title: body?.title, prompt: body?.prompt, contextSnapshotId: body?.contextSnapshotId, providerConfigId: body?.providerConfigId, deliverables: body?.deliverables }));
  }
  {
    const m = match(p, '/thread-runs/:id');
    if (m && method === 'GET') { const run = runs.getRun(m.id); return run ? send(res, 200, run) : send(res, 404, { error: 'run not found' }); }
  }
  {
    const m = match(p, '/thread-runs/:id/cancel');
    if (m && method === 'POST') { const run = runs.cancel(m.id); return run ? send(res, 200, run) : send(res, 404, { error: 'run not found' }); }
  }
  {
    const m = match(p, '/jobs/:id/retry');
    if (m && method === 'POST') { const run = runs.retry(m.id); return run ? send(res, 202, run) : send(res, 404, { error: 'job not found' }); }
  }
  {
    const m = match(p, '/thread-runs/:id/events');
    if (m && method === 'GET') {
      if (!runs.getRun(m.id)) return send(res, 404, { error: 'run not found' });
      let cursor = Number(req.headers['last-event-id'] || 0); let closed = false; res.on('close', () => { closed = true; });
      res.writeHead(200, { 'Content-Type': 'text/event-stream; charset=utf-8', 'Cache-Control': 'no-store', Connection: 'keep-alive', 'X-Accel-Buffering': 'no', 'X-Content-Type-Options': 'nosniff', 'Content-Security-Policy': "default-src 'none'" }); res.flushHeaders?.();
      let keepAlive = Date.now();
      while (!closed) {
        for (const event of runs.events(m.id, cursor)) { cursor = event.id; res.write(`id: ${event.id}\nevent: ${event.type}\ndata: ${JSON.stringify({ ...event.data, jobId: event.jobId, attemptId: event.attemptId })}\n\n`); }
        const run = runs.getRun(m.id); if (run && ['succeeded', 'partial', 'failed', 'cancelled'].includes(run.status) && !runs.events(m.id, cursor).length) break;
        if (Date.now() - keepAlive > 10_000) { res.write(': keep-alive\n\n'); keepAlive = Date.now(); }
        await new Promise((resolve) => setTimeout(resolve, 75));
      }
      if (!closed) res.end(); return;
    }
  }

  // ---- legacy unscoped chat (preserved) ----
  if (method === 'GET' && p === '/users/me/chat-threads') return send(res, 200, store.get().chatThreads);
  if (method === 'POST' && p === '/users/me/chat-threads') {
    const thread = store.with((db, h) => {
      const t = { id: h.id(), title: body?.title || 'New thread', createdAt: h.now(), updatedAt: h.now() };
      db.chatThreads.unshift(t);
      return t;
    });
    return send(res, 201, thread);
  }
  {
    const m = match(p, '/users/me/chat-threads/:threadId/messages');
    if (m && method === 'GET') {
      return send(res, 200, store.get().chatMessages.filter((x) => x.threadId === m.threadId));
    }
    if (m && method === 'POST') {
      const msg = store.with((db, h) => {
        const t = db.chatThreads.find((x) => x.id === m.threadId);
        if (!t) return null;
        const userMsg = {
          id: h.id(),
          threadId: m.threadId,
          role: 'user',
          content: body?.content || '',
          createdAt: h.now(),
        };
        db.chatMessages.push(userMsg);
        const reply = {
          id: h.id(),
          threadId: m.threadId,
          role: 'assistant',
          content: body?.content
            ? `Local agent received:\n\n> ${body.content}\n\nTip: open a project canvas and use Generate to create a component from this prompt.\n(Wire your model in server/generate.js + chat handler.)`
            : 'Say something.',
          createdAt: h.now(),
        };
        db.chatMessages.push(reply);
        t.updatedAt = h.now();
        if (t.title === 'New thread' && body?.content) t.title = String(body.content).slice(0, 48);
        return { user: userMsg, assistant: reply };
      });
      return msg ? send(res, 201, msg) : send(res, 404, { error: 'not found' });
    }
  }


  return send(res, 404, { error: `no route ${method} ${p}` });
}

function staticFile(res, filePath) {
  if (!fs.existsSync(filePath) || !fs.statSync(filePath).isFile()) return false;
  const ext = path.extname(filePath).toLowerCase();
  res.writeHead(200, {
    'Content-Type': MIME[ext] || 'application/octet-stream',
    'X-Content-Type-Options': 'nosniff',
    'Referrer-Policy': 'no-referrer',
    'Content-Security-Policy': "default-src 'self'; script-src 'self'; style-src 'self' 'unsafe-inline'; connect-src 'self'; img-src 'self' data: blob:; font-src 'self'; object-src 'none'; base-uri 'none'; frame-ancestors 'none'",
  });
  res.end(fs.readFileSync(filePath));
  return true;
}

function wantsHtml(req, pathname) {
  // Only real document navigations get index.html.
  // API clients (app.js) MUST send Accept: application/json.
  const accept = String(req.headers.accept || '');
  const secFetchDest = String(req.headers['sec-fetch-dest'] || '');
  const mode = String(req.headers['sec-fetch-mode'] || '');
  if (accept.includes('application/json') && !accept.includes('text/html')) return false;
  if (secFetchDest === 'document' || mode === 'navigate') return true;
  // Prefer HTML only when text/html is explicitly accepted (browsers/WKWebView page loads)
  if (accept.includes('text/html')) return true;
  // Bare GETs to app shell paths with no Accept (some webviews) → SPA
  const shell = new Set(['/', '/files', '/chat', '/libraries', '/skills', '/design-systems', '/agents', '/components']);
  if ((req.method || 'GET') === 'GET' && accept === '' && (shell.has(pathname) || pathname.startsWith('/projects/') || pathname.startsWith('/components/'))) {
    return true;
  }
  return false;
}

const server = http.createServer(async (req, res) => {
  const requestId = crypto.randomUUID();
  try {
    const url = new URL(req.url || '/', `http://127.0.0.1:${LISTEN_PORT}`);
    const pathname = url.pathname.replace(/\/$/, '') || '/';
    const isCaptureSubmission = /^\/api\/v1\/capture-tickets\/[^/]+\/submission$/.test(pathname);
    if (isCaptureSubmission) {
      const authority = requestAuthority(req); const origin = String(req.headers.origin || '');
      const approvedExtension = /^chrome-extension:\/\/[a-p]{32}$/.test(origin);
      if (origin && origin !== authority && !approvedExtension) throw new HttpError(403, 'origin_rejected', 'Capture submissions accept only the MyPath origin or a Chrome extension origin');
      if (approvedExtension) res.setHeader('Access-Control-Allow-Origin', origin);
      if (req.method === 'OPTIONS') {
        res.writeHead(204, { 'Access-Control-Allow-Methods': 'POST', 'Access-Control-Allow-Headers': 'authorization,content-type', 'Access-Control-Max-Age': '120', Vary: 'Origin' }); res.end(); return;
      }
    } else {
      enforceBrowserBoundary(req);
      if (req.method === 'OPTIONS') throw new HttpError(405, 'method_not_allowed', 'CORS preflight is not supported');
    }

    // Static assets first
    if (pathname.startsWith('/assets/') || pathname.startsWith('/src/')) {
      const filePath = path.normalize(path.join(WEB, pathname));
      if (filePath.startsWith(WEB) && staticFile(res, filePath)) return;
    }

    // SPA document navigations (fixes blank WKWebView / refresh on /projects/:id etc.)
    if ((req.method || 'GET') === 'GET' && wantsHtml(req, pathname)) {
      if (staticFile(res, path.join(WEB, 'index.html'))) return;
    }

    const apiRoots = [
      '/health', '/users', '/projects', '/components', '/design-systems',
      '/libraries', '/skills', '/images', '/fonts', '/assets', '/context-snapshots', '/generate', '/candidates', '/builds', '/revisions', '/edit-sessions', '/variant-groups', '/provider-configs', '/thread-runs', '/jobs', '/api',
    ];
    if (apiRoots.some((r) => pathname === r || pathname.startsWith(r + '/'))) {
      return await api(req, res, url);
    }

    // fallback SPA
    if ((req.method || 'GET') === 'GET' && staticFile(res, path.join(WEB, 'index.html'))) return;
    send(res, 404, 'not found');
  } catch (err) {
    if (!err?.status || err.status >= 500) console.error(err);
    if (!res.headersSent) sendError(res, err, requestId);
    else res.destroy();
  }
});

server.listen(PORT, '127.0.0.1', () => {
  const address = server.address();
  if (!address || typeof address === 'string') throw new Error('Server did not expose a TCP listening address');
  LISTEN_PORT = Number(address.port);
  const descriptorPath = process.env.MYPATH_STARTUP_DESCRIPTOR;
  const nonce = String(process.env.MYPATH_INSTANCE_NONCE || '');
  if (descriptorPath) {
    if (!nonce) throw new Error('MYPATH_INSTANCE_NONCE is required with MYPATH_STARTUP_DESCRIPTOR');
    const startedAt = new Date().toISOString();
    const authentication = crypto.createHmac('sha256', nonce).update(`${process.pid}:${LISTEN_PORT}:${startedAt}`).digest('hex');
    const temporary = `${descriptorPath}.${process.pid}.tmp`;
    fs.mkdirSync(path.dirname(descriptorPath), { recursive: true, mode: 0o700 });
    fs.writeFileSync(temporary, JSON.stringify({ schema: 'MyPathStartupDescriptorV1', pid: process.pid, port: LISTEN_PORT, startedAt, authentication }), { mode: 0o600, flag: 'wx' });
    fs.renameSync(temporary, descriptorPath); fs.chmodSync(descriptorPath, 0o600);
  }
  console.log(`MyPath local server → http://127.0.0.1:${LISTEN_PORT}`);
  console.log(`Data directory     → ${DATA}`);
  console.log(`Features           → canvas · generation · visual-editing · revision-restore · parallel-variants`);
});
