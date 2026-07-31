import crypto from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import { spawn } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { checksum } from '../db/database.js';
import { injectSourceIds } from '../editor/source-editor.js';
import { SCREENSHOT_MAX_BYTES } from '../security/http-security.js';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const WORKER = path.join(HERE, 'worker.js');
const MAX_BUILD_MS = Number(process.env.MYPATH_BUILD_TIMEOUT_MS || 15_000);
function id() { return crypto.randomBytes(12).toString('hex'); }
function now() { return new Date().toISOString(); }
function encode(value) { return JSON.stringify(value ?? null); }
function decode(value, fallback = null) { try { return JSON.parse(value); } catch { return fallback; } }
function sourceChecksum(files) {
  return checksum(Object.entries(files || {}).sort(([a], [b]) => a.localeCompare(b)).map(([name, content]) => `${name}\0${content}`).join('\0'));
}
function preserveOperationalCss(files, inherited) {
  if (!inherited?.['src/index.css']) return files;
  const source = String(inherited['src/index.css']);
  const blocks = [
    ...source.matchAll(/\/\* mypath-design-system:[^*]+:start \*\/[\s\S]*?\/\* mypath-design-system:[^*]+:end \*\//g),
    ...source.matchAll(/\/\* mypath-selected-fonts:start \*\/[\s\S]*?\/\* mypath-selected-fonts:end \*\//g),
  ].map((match) => match[0]);
  if (!blocks.length) return files;
  const output = { ...files }; let css = String(output['src/index.css'] || '');
  css = css.replace(/\/\* mypath-design-system:[^*]+:start \*\/[\s\S]*?\/\* mypath-design-system:[^*]+:end \*\/[\r\n]*/g, '').replace(/\/\* mypath-selected-fonts:start \*\/[\s\S]*?\/\* mypath-selected-fonts:end \*\/[\r\n]*/g, '');
  output['src/index.css'] = `${blocks.join('\n')}\n${css}`; return output;
}

export class CandidateService {
  constructor(store) {
    this.store = store;
    this.db = store.database.db;
    this.dataDir = store.dataDir;
    this.artifactDir = path.join(this.dataDir, 'artifacts');
    this.stageDir = path.join(this.dataDir, 'build-staging');
    this.screenshotDir = path.join(this.dataDir, 'screenshots');
    this.maxConcurrent = Math.max(1, Math.min(4, Number(process.env.MYPATH_BUILD_CONCURRENCY || 1)));
    this.activeBuilds = 0;
    this.buildQueue = [];
    this.pendingBuilds = new Map();
    this.activeWorkers = new Map();
    for (const directory of [this.artifactDir, this.stageDir, this.screenshotDir]) fs.mkdirSync(directory, { recursive: true, mode: 0o700 });
    // Canonical paths keep Vite/Rollup from deriving invalid relative chunks on macOS,
    // where /var is a symlink to /private/var.
    this.artifactDir = fs.realpathSync(this.artifactDir);
    this.stageDir = fs.realpathSync(this.stageDir);
    this.screenshotDir = fs.realpathSync(this.screenshotDir);
    this.reconcile();
  }

  event(buildId, type, data = {}) {
    this.db.prepare('INSERT INTO build_events(build_id,event_type,data_json,created_at) VALUES(?,?,?,?)').run(buildId, type, encode(data), now());
  }

  create({ componentId, files, expectedBaseRevisionId, sourceRevisionId = null, parentRevisionId = null, metadata = {}, note = '' }) {
    if (!files || typeof files !== 'object' || Array.isArray(files)) throw Object.assign(new Error('files must be an object'), { status: 400, code: 'invalid_candidate' });
    const state = this.store.get();
    const component = state.components.find((item) => item.id === componentId && !item.deletedAt);
    if (!component) throw Object.assign(new Error('Component not found'), { status: 404, code: 'not_found' });
    const inheritedRevision = state.revisions.find((item) => item.id === (parentRevisionId || component.selectedRevisionId) && item.componentId === componentId);
    const inherited = inheritedRevision?.files || component.files || null;
    metadata = {
      ...(inheritedRevision ? {
        contextSnapshotId: inheritedRevision.contextSnapshotId || null,
        designSystemVersionId: inheritedRevision.designSystemVersionId || null,
        designSystemChecksum: inheritedRevision.designSystemChecksum || null,
        libraryRevisionContext: inheritedRevision.libraryRevisionContext || [],
        skillVersionIds: inheritedRevision.skillVersionIds || [],
        fontIds: inheritedRevision.fontIds || [],
      } : {}),
      ...metadata,
    };
    // Stable IDs and operational CSS are persisted in candidate source. Regeneration,
    // visual edits, and variants cannot silently drift to a newer selected context.
    files = preserveOperationalCss(files, inherited);
    files = injectSourceIds(files, inherited);
    const candidateId = id();
    const buildId = id();
    const time = now();
    const base = expectedBaseRevisionId === undefined ? (component.selectedRevisionId || null) : (expectedBaseRevisionId || null);
    this.db.exec('BEGIN IMMEDIATE');
    try {
      this.db.prepare(`INSERT INTO revision_candidates(id,component_id,expected_base_revision_id,source_revision_id,parent_revision_id,metadata_json,status,note,source_checksum,created_at,updated_at)
        VALUES(?,?,?,?,?,?,?,?,?,?,?)`).run(candidateId, componentId, base, sourceRevisionId, parentRevisionId, encode(metadata), 'queued', String(note || ''), sourceChecksum(files), time, time);
      const insertFile = this.db.prepare('INSERT INTO candidate_files(candidate_id,path,content,content_checksum) VALUES(?,?,?,?)');
      for (const [name, content] of Object.entries(files)) insertFile.run(candidateId, String(name), String(content), checksum(String(content)));
      this.db.prepare("INSERT INTO builds(id,candidate_id,revision_id,status,worker_json) VALUES(?,?,?,?,'{}')").run(buildId, candidateId, sourceRevisionId, 'queued');
      this.db.prepare('INSERT INTO build_events(build_id,event_type,data_json,created_at) VALUES(?,?,?,?)').run(buildId, 'queued', encode({ candidateId }), time);
      this.db.exec('COMMIT');
    } catch (error) { this.db.exec('ROLLBACK'); throw error; }
    return { candidateId, buildId, status: 'queued' };
  }

  getCandidate(candidateId) {
    const row = this.db.prepare('SELECT * FROM revision_candidates WHERE id=?').get(candidateId);
    if (!row) return null;
    const files = Object.fromEntries(this.db.prepare('SELECT path,content FROM candidate_files WHERE candidate_id=? ORDER BY path').all(candidateId).map((file) => [file.path, file.content]));
    return { ...row, files, diagnostics: decode(row.diagnostics_json, []) };
  }

  getBuild(buildId) {
    const row = this.db.prepare('SELECT * FROM builds WHERE id=?').get(buildId);
    return row ? { ...row, diagnostics: decode(row.diagnostics_json, []), worker: decode(row.worker_json, {}) } : null;
  }

  /** @param {string} buildId @param {{ signal?: AbortSignal }} [options] */
  run(buildId, { signal } = {}) {
    const build = this.db.prepare('SELECT * FROM builds WHERE id=?').get(buildId);
    if (!build) return Promise.reject(Object.assign(new Error('Build not found'), { status: 404, code: 'not_found' }));
    if (!['queued', 'building'].includes(build.status)) return Promise.resolve(this.getBuild(buildId));
    const pending = this.pendingBuilds.get(buildId);
    if (pending) { if (signal) signal.addEventListener('abort', () => this.cancel(buildId), { once: true }); return pending.promise; }
    let resolveJob; let rejectJob;
    const promise = new Promise((resolve, reject) => { resolveJob = resolve; rejectJob = reject; });
    this.pendingBuilds.set(buildId, { promise, resolve: resolveJob, reject: rejectJob });
    if (signal) { if (signal.aborted) this.cancel(buildId); else signal.addEventListener('abort', () => this.cancel(buildId), { once: true }); }
    this.buildQueue.push(buildId);
    this.drainQueue();
    return promise;
  }

  cancel(buildId, reason = 'build_cancelled') {
    const build = this.db.prepare('SELECT status,candidate_id FROM builds WHERE id=?').get(buildId);
    if (!build || !['queued', 'building'].includes(build.status)) return this.getBuild(buildId);
    const worker = this.activeWorkers.get(buildId);
    if (worker) {
      worker.cancelled = true;
      try { if (worker.detached && worker.child.pid) process.kill(-worker.child.pid, 'SIGKILL'); else worker.child.kill('SIGKILL'); } catch {}
    }
    const finished = now(); const diagnostics = [{ severity: 'error', stage: 'build', code: reason, message: reason === 'server_restarted' ? 'Build interrupted by server restart' : 'Build cancelled' }];
    this.db.exec('BEGIN IMMEDIATE');
    try {
      this.db.prepare("UPDATE builds SET status='failed',finished_at=?,diagnostics_json=? WHERE id=? AND status IN ('queued','building')").run(finished, encode(diagnostics), buildId);
      this.db.prepare("UPDATE revision_candidates SET status='failed',updated_at=?,diagnostics_json=? WHERE id=? AND status IN ('queued','building')").run(finished, encode(diagnostics), build.candidate_id);
      this.db.prepare('INSERT INTO build_events(build_id,event_type,data_json,created_at) VALUES(?,?,?,?)').run(buildId, 'failed', encode({ diagnostics }), finished);
      this.db.exec('COMMIT');
    } catch (error) { this.db.exec('ROLLBACK'); throw error; }
    return this.getBuild(buildId);
  }

  drainQueue() {
    while (this.activeBuilds < this.maxConcurrent && this.buildQueue.length) {
      const buildId = this.buildQueue.shift();
      const pending = this.pendingBuilds.get(buildId);
      if (!pending) continue;
      this.activeBuilds += 1;
      void this.execute(buildId).then(pending.resolve, pending.reject).finally(() => {
        this.activeBuilds -= 1;
        this.pendingBuilds.delete(buildId);
        this.drainQueue();
      });
    }
  }

  runWorker(buildId, input, workspace, resultPath) {
    return new Promise((resolve) => {
      let stdout = ''; let stderr = ''; let settled = false; let timedOut = false;
      const detached = process.platform !== 'win32';
      const child = spawn(process.execPath, ['--max-old-space-size=256', WORKER, input, workspace, resultPath], {
        detached, stdio: ['ignore', 'pipe', 'pipe'], env: { ...process.env, NODE_ENV: 'production', NO_COLOR: '1' },
      });
      const worker = { child, detached, cancelled: false }; this.activeWorkers.set(buildId, worker);
      const append = (current, chunk) => (current + chunk.toString()).slice(-16 * 1024);
      child.stdout.on('data', (chunk) => { stdout = append(stdout, chunk); });
      child.stderr.on('data', (chunk) => { stderr = append(stderr, chunk); });
      const finish = (value) => { if (!settled) { settled = true; clearTimeout(timer); this.activeWorkers.delete(buildId); resolve({ ...value, cancelled: worker.cancelled }); } };
      const timer = setTimeout(() => {
        timedOut = true;
        try { if (detached && child.pid) process.kill(-child.pid, 'SIGKILL'); else child.kill('SIGKILL'); } catch {}
      }, MAX_BUILD_MS);
      child.once('error', (error) => finish({ status: null, signal: null, stdout, stderr, error, timedOut }));
      child.once('close', (status, signal) => finish({ status, signal, stdout, stderr, error: null, timedOut }));
    });
  }

  async execute(buildId) {
    const build = this.db.prepare('SELECT * FROM builds WHERE id=?').get(buildId);
    if (!build || !['queued', 'building'].includes(build.status)) return this.getBuild(buildId);
    const candidate = this.getCandidate(build.candidate_id);
    if (!candidate) throw new Error('Build candidate disappeared');
    const workspace = fs.mkdtempSync(path.join(this.stageDir, `${buildId}-`));
    const input = path.join(workspace, 'candidate.json');
    const resultPath = path.join(workspace, 'result.json');
    fs.writeFileSync(input, encode({ files: candidate.files }), { mode: 0o600 });
    const started = now();
    this.db.prepare("UPDATE builds SET status='building',started_at=? WHERE id=?").run(started, buildId);
    this.db.prepare("UPDATE revision_candidates SET status='building',updated_at=? WHERE id=?").run(started, candidate.id);
    this.event(buildId, 'building', { timeoutMs: MAX_BUILD_MS });
    const child = await this.runWorker(buildId, input, workspace, resultPath);
    let result;
    if (child.cancelled) result = { ok: false, diagnostics: [{ severity: 'error', stage: 'build', code: 'build_cancelled', message: 'Build cancelled' }] };
    else if (child.timedOut) result = { ok: false, diagnostics: [{ severity: 'error', stage: 'build', code: 'build_timeout', message: `Build exceeded ${MAX_BUILD_MS}ms` }] };
    else if (!fs.existsSync(resultPath)) result = { ok: false, diagnostics: [{ severity: 'error', stage: 'worker', code: 'worker_failed', message: (child.stderr || child.error?.message || `Worker exited ${child.status}`).slice(0, 4000) }] };
    else result = decode(fs.readFileSync(resultPath, 'utf8'), { ok: false, diagnostics: [{ severity: 'error', stage: 'worker', code: 'invalid_worker_result', message: 'Build worker returned invalid output' }] });
    if (!result.ok) {
      this.failBuild(buildId, candidate.id, result.diagnostics || [], { exitCode: child.status, signal: child.signal });
      fs.rmSync(workspace, { recursive: true, force: true });
      return this.getBuild(buildId);
    }
    // Publication must never leave the build in 'building': a stuck row makes /builds/:id/run
    // resolve nothing and keeps the event stream polling for a terminal state that never arrives.
    try {
      const artifact = fs.readFileSync(path.join(workspace, 'artifact.html'));
      const artifactHash = checksum(artifact);
      const stagePath = path.join(this.stageDir, `${artifactHash}.${buildId}.html.stage`);
      const finalPath = path.join(this.artifactDir, `${artifactHash}.html`);
      fs.copyFileSync(path.join(workspace, 'artifact.html'), stagePath, fs.constants.COPYFILE_EXCL);
      fs.chmodSync(stagePath, 0o400);
      const publicationId = id();
      this.db.prepare(`INSERT INTO artifact_publications(id,build_id,candidate_id,artifact_hash,stage_path,final_path,status,created_at)
        VALUES(?,?,?,?,?,?,?,?)`).run(publicationId, buildId, candidate.id, artifactHash, stagePath, finalPath, 'intent', now());
      if (fs.existsSync(finalPath)) fs.rmSync(stagePath, { force: true });
      else fs.renameSync(stagePath, finalPath);
      this.db.prepare("UPDATE artifact_publications SET status='published',published_at=? WHERE id=?").run(now(), publicationId);
      return this.finalize(buildId, artifactHash, finalPath, result.stats || {});
    } catch (error) {
      try { this.failBuild(buildId, candidate.id, [{ severity: 'error', stage: 'publish', code: error?.code || 'artifact_publish_failed', message: String(error?.message || error).slice(0, 4000) }]); } catch {}
      throw error;
    } finally {
      fs.rmSync(workspace, { recursive: true, force: true });
    }
  }

  failBuild(buildId, candidateId, diagnostics, worker = null) {
    const finished = now();
    this.db.exec('BEGIN IMMEDIATE');
    try {
      if (worker) this.db.prepare("UPDATE builds SET status='failed',finished_at=?,diagnostics_json=?,worker_json=? WHERE id=?").run(finished, encode(diagnostics), encode(worker), buildId);
      else this.db.prepare("UPDATE builds SET status='failed',finished_at=?,diagnostics_json=? WHERE id=?").run(finished, encode(diagnostics), buildId);
      this.db.prepare("UPDATE revision_candidates SET status='failed',updated_at=?,diagnostics_json=? WHERE id=?").run(finished, encode(diagnostics), candidateId);
      this.db.prepare('INSERT INTO build_events(build_id,event_type,data_json,created_at) VALUES(?,?,?,?)').run(buildId, 'failed', encode({ diagnostics }), finished);
      this.db.exec('COMMIT');
    } catch (error) { this.db.exec('ROLLBACK'); throw error; }
  }

  finalize(buildId, artifactHash, finalPath, stats = {}) {
    const build = this.db.prepare('SELECT * FROM builds WHERE id=?').get(buildId);
    const candidate = this.getCandidate(build.candidate_id);
    const candidateMetadata = decode(candidate.metadata_json, {});
    if (candidateMetadata.deferredPromotion === true) {
      const finished = now();
      this.db.exec('BEGIN IMMEDIATE');
      try {
        this.db.prepare("UPDATE builds SET revision_id=NULL,status='succeeded',finished_at=?,artifact_hash=?,diagnostics_json='[]',worker_json=? WHERE id=?").run(finished, artifactHash, encode({ stats, pendingReview: true }), buildId);
        this.db.prepare("UPDATE revision_candidates SET status='built_existing',updated_at=?,diagnostics_json='[]' WHERE id=?").run(finished, candidate.id);
        this.db.prepare("UPDATE artifact_publications SET revision_id=NULL,status='committed',published_at=? WHERE build_id=?").run(finished, buildId);
        this.db.prepare('INSERT INTO build_events(build_id,event_type,data_json,created_at) VALUES(?,?,?,?)').run(buildId, 'awaiting_review', encode({ candidateId: candidate.id, artifactHash }), finished);
        this.db.exec('COMMIT');
      } catch (error) { this.db.exec('ROLLBACK'); throw error; }
      return this.getBuild(buildId);
    }
    const alreadyPromoted = this.store.get().revisions.find((item) => item.buildId === buildId);
    let revisionId = candidate.source_revision_id || alreadyPromoted?.id || null;
    let selected = Boolean(alreadyPromoted && this.store.get().components.find((item) => item.id === candidate.component_id)?.selectedRevisionId === alreadyPromoted.id);
    if (revisionId && !alreadyPromoted) {
      this.store.with((state, helpers) => {
        const revision = state.revisions.find((item) => item.id === revisionId && item.componentId === candidate.component_id);
        if (!revision) throw new Error('Source revision disappeared during lazy build');
        revision.status = 'completed'; revision.artifactHash = artifactHash; revision.buildId = buildId; revision.builtAt = helpers.now();
      });
    } else if (!alreadyPromoted) {
      revisionId = id();
      this.store.with((state, helpers) => {
        const component = state.components.find((item) => item.id === candidate.component_id && !item.deletedAt);
        if (!component) throw new Error('Candidate component disappeared during promotion');
        const codeKey = Object.keys(candidate.files).find((name) => name.includes('generated') && name.endsWith('.tsx')) || Object.keys(candidate.files).find((name) => /App\.(?:tsx|jsx)$/.test(name));
        const metadata = decode(candidate.metadata_json, {});
        const revision = { id: revisionId, componentId: component.id, parentRevisionId: candidate.parent_revision_id || candidate.expected_base_revision_id || null, status: 'completed', note: candidate.note || 'candidate build', files: candidate.files, code: candidate.files[codeKey] || '', artifactHash, buildId, ...metadata, createdAt: helpers.now() };
        state.revisions.unshift(revision);
        if ((component.selectedRevisionId || null) === (candidate.expected_base_revision_id || null)) {
          component.selectedRevisionId = revisionId; component.files = candidate.files; component.code = revision.code; component.updatedAt = helpers.now(); selected = true;
        }
      });
    }
    const finished = now();
    this.db.exec('BEGIN IMMEDIATE');
    try {
      this.db.prepare("UPDATE builds SET revision_id=?,status='succeeded',finished_at=?,artifact_hash=?,diagnostics_json='[]',worker_json=? WHERE id=?").run(revisionId, finished, artifactHash, encode({ stats }), buildId);
      this.db.prepare("UPDATE revision_candidates SET status=?,promoted_revision_id=?,updated_at=?,diagnostics_json='[]' WHERE id=?").run(candidate.source_revision_id ? 'built_existing' : 'promoted', revisionId, finished, candidate.id);
      this.db.prepare("UPDATE artifact_publications SET revision_id=?,status='committed',published_at=? WHERE build_id=?").run(revisionId, finished, buildId);
      this.db.prepare('INSERT INTO build_events(build_id,event_type,data_json,created_at) VALUES(?,?,?,?)').run(buildId, 'succeeded', encode({ revisionId, selected, artifactHash }), finished);
      this.db.exec('COMMIT');
    } catch (error) { this.db.exec('ROLLBACK'); throw error; }
    return this.getBuild(buildId);
  }

  promoteDeferred(candidateId, note = 'accepted external-agent candidate') {
    const candidate = this.getCandidate(candidateId);
    if (!candidate) throw Object.assign(new Error('Candidate not found'), { status: 404, code: 'not_found' });
    const metadata = decode(candidate.metadata_json, {});
    if (metadata.deferredPromotion !== true) throw Object.assign(new Error('Candidate is not pending review'), { status: 409, code: 'candidate_not_reviewable' });
    if (candidate.promoted_revision_id) return { revisionId: candidate.promoted_revision_id, selected: false };
    const build = this.db.prepare("SELECT * FROM builds WHERE candidate_id=? AND status='succeeded' ORDER BY finished_at DESC LIMIT 1").get(candidate.id);
    if (!build?.artifact_hash) throw Object.assign(new Error('Candidate build has not succeeded'), { status: 409, code: 'candidate_build_incomplete' });
    const revisionId = id(); let selected = false;
    this.store.with((state, helpers) => {
      const component = state.components.find((item) => item.id === candidate.component_id && !item.deletedAt);
      if (!component) throw Object.assign(new Error('Component not found'), { status: 404, code: 'not_found' });
      const inherited = state.revisions.find((item) => item.id === candidate.expected_base_revision_id && item.componentId === component.id);
      if (!inherited) throw Object.assign(new Error('Base revision is unavailable'), { status: 409, code: 'base_revision_unavailable' });
      const codeKey = Object.keys(candidate.files).find((name) => name.includes('generated') && name.endsWith('.tsx')) || Object.keys(candidate.files).find((name) => /App\.(?:tsx|jsx)$/.test(name));
      const { deferredPromotion: ignored, externalSubmissionId: ignoredSubmission, ...revisionMetadata } = metadata;
      const revision = { id: revisionId, componentId: component.id, parentRevisionId: inherited.id, status: 'completed', note: String(note || 'accepted external-agent candidate'), files: candidate.files, code: candidate.files[codeKey] || '', artifactHash: build.artifact_hash, buildId: build.id, ...revisionMetadata, createdAt: helpers.now() };
      state.revisions.unshift(revision);
      if ((component.selectedRevisionId || null) === inherited.id) { component.selectedRevisionId = revisionId; component.files = candidate.files; component.code = revision.code; component.updatedAt = helpers.now(); selected = true; }
    });
    const stamp = now();
    this.db.exec('BEGIN IMMEDIATE');
    try {
      this.db.prepare("UPDATE revision_candidates SET status='promoted',promoted_revision_id=?,updated_at=? WHERE id=? AND promoted_revision_id IS NULL").run(revisionId, stamp, candidate.id);
      this.db.prepare('UPDATE builds SET revision_id=? WHERE id=?').run(revisionId, build.id);
      this.db.prepare('UPDATE artifact_publications SET revision_id=? WHERE build_id=?').run(revisionId, build.id);
      this.db.prepare('INSERT INTO build_events(build_id,event_type,data_json,created_at) VALUES(?,?,?,?)').run(build.id, 'accepted', encode({ revisionId, selected }), stamp);
      this.db.exec('COMMIT');
    } catch (error) { this.db.exec('ROLLBACK'); throw error; }
    return { revisionId, selected, buildId: build.id };
  }

  async buildRevision(revisionId, { retry = false } = {}) {
    const existing = this.db.prepare("SELECT * FROM builds WHERE revision_id=? ORDER BY CASE status WHEN 'succeeded' THEN 0 WHEN 'building' THEN 1 WHEN 'queued' THEN 2 ELSE 3 END, finished_at DESC LIMIT 1").get(revisionId);
    if (existing?.status === 'succeeded' && existing.artifact_hash && fs.existsSync(path.join(this.artifactDir, `${existing.artifact_hash}.html`))) return this.getBuild(existing.id);
    if (existing && ['queued', 'building'].includes(existing.status)) return this.run(existing.id);
    if (existing?.status === 'failed' && !retry) return this.getBuild(existing.id);
    const state = this.store.get();
    const revision = state.revisions.find((item) => item.id === revisionId);
    if (!revision) throw Object.assign(new Error('Revision not found'), { status: 404, code: 'not_found' });
    const component = state.components.find((item) => item.id === revision.componentId);
    const queued = this.create({ componentId: revision.componentId, files: revision.files || {}, expectedBaseRevisionId: component?.selectedRevisionId || null, sourceRevisionId: revision.id, note: retry ? 'explicit historical rebuild retry' : 'lazy historical build' });
    return this.run(queued.buildId);
  }

  async artifactForRevision(revisionId, options = {}) {
    const build = await this.buildRevision(revisionId, options);
    if (build.status !== 'succeeded') return { build, html: null };
    const file = path.join(this.artifactDir, `${build.artifact_hash}.html`);
    return { build, html: fs.readFileSync(file, 'utf8') };
  }

  events(buildId, after = 0) {
    return this.db.prepare('SELECT id,event_type,data_json,created_at FROM build_events WHERE build_id=? AND id>? ORDER BY id LIMIT 200').all(buildId, Number(after) || 0)
      .map((row) => ({ id: row.id, type: row.event_type, data: decode(row.data_json, {}), createdAt: row.created_at }));
  }

  saveScreenshot({ revisionId, buildId = null, width, height, mediaType, bytes }) {
    if (!['image/png', 'image/jpeg', 'image/webp'].includes(mediaType) || bytes.length > SCREENSHOT_MAX_BYTES || !Number.isInteger(width) || !Number.isInteger(height) || width < 1 || height < 1 || width > 4096 || height > 4096) throw Object.assign(new Error('Screenshot must be PNG, JPEG, or WebP, at most 1 MiB, with a 1–4096 px viewport'), { status: 422, code: 'screenshot_invalid' });
    if (!this.store.get().revisions.some((item) => item.id === revisionId)) throw Object.assign(new Error('Revision not found'), { status: 404, code: 'not_found' });
    const screenshotId = id(); const hash = checksum(bytes); const target = path.join(this.screenshotDir, `${hash}.${mediaType.split('/')[1]}`);
    if (!fs.existsSync(target)) fs.writeFileSync(target, bytes, { mode: 0o400, flag: 'wx' });
    this.db.prepare('INSERT INTO screenshots(id,revision_id,build_id,viewport_width,viewport_height,media_type,blob_path,content_checksum,created_at) VALUES(?,?,?,?,?,?,?,?,?)')
      .run(screenshotId, revisionId, buildId, width, height, mediaType, target, hash, now());
    return { id: screenshotId, revisionId, buildId, width, height, mediaType, checksum: hash, createdAt: now() };
  }

  reconcile() {
    const retry = [];
    for (const row of this.db.prepare("SELECT * FROM artifact_publications WHERE status!='committed'").all()) {
      if (fs.existsSync(row.stage_path) && !fs.existsSync(row.final_path)) fs.renameSync(row.stage_path, row.final_path);
      else if (fs.existsSync(row.stage_path)) fs.rmSync(row.stage_path, { force: true });
      if (fs.existsSync(row.final_path)) {
        this.db.prepare("UPDATE artifact_publications SET status='published',published_at=? WHERE id=?").run(now(), row.id);
        try { this.finalize(row.build_id, row.artifact_hash, row.final_path, { reconciled: true }); } catch (error) { console.error('Build publication reconciliation failed', error); }
      } else {
        this.db.exec('BEGIN IMMEDIATE');
        try {
          this.db.prepare('DELETE FROM artifact_publications WHERE id=?').run(row.id);
          this.db.prepare("UPDATE builds SET status='queued' WHERE id=?").run(row.build_id);
          this.db.prepare("UPDATE revision_candidates SET status='queued' WHERE id=?").run(row.candidate_id);
          this.db.exec('COMMIT'); retry.push(row.build_id);
        } catch (error) { this.db.exec('ROLLBACK'); throw error; }
      }
    }
    for (const entry of fs.readdirSync(this.stageDir)) {
      const target = path.join(this.stageDir, entry);
      if (fs.statSync(target).isDirectory()) fs.rmSync(target, { recursive: true, force: true });
      else if (entry.endsWith('.stage')) {
        const publication = this.db.prepare('SELECT status FROM artifact_publications WHERE stage_path=?').get(target);
        if (!publication || publication.status === 'committed') fs.rmSync(target, { force: true });
      }
    }
    for (const buildId of retry) void this.run(buildId).catch((error) => console.error('Build retry reconciliation failed', error));
  }
}
