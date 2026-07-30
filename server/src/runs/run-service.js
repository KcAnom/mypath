import crypto from 'node:crypto';
import { planDeliverables } from './planner.js';

const id = () => crypto.randomBytes(12).toString('hex');
const now = () => new Date().toISOString();
const encode = (value) => JSON.stringify(value ?? null);
const decode = (value, fallback = null) => { try { return JSON.parse(value); } catch { return fallback; } };
const terminalRuns = new Set(['succeeded', 'partial', 'failed', 'cancelled']);
const terminalJobs = new Set(['succeeded', 'failed', 'cancelled']);

export class RunService {
  constructor({ store, candidates, canvases, contexts, providers, faultAt = process.env.MYPATH_JOB_FAULT_AT || '' }) {
    this.store = store; this.db = store.database.db; this.candidates = candidates; this.canvases = canvases; this.contexts = contexts; this.providers = providers;
    this.maximum = Math.max(1, Math.min(8, Number(process.env.MYPATH_JOB_CONCURRENCY || 3)));
    this.timeoutMs = Math.max(1_000, Math.min(10 * 60_000, Number(process.env.MYPATH_PROVIDER_TIMEOUT_MS || 90_000)));
    this.faultAt = faultAt; this.injectedFaults = new Set();
    this.queue = []; this.queued = new Set(); this.active = new Map(); this.recover();
  }

  event(runId, type, data = {}, jobId = null, attemptId = null) {
    const result = this.db.prepare('INSERT INTO job_events(run_id,job_id,attempt_id,event_type,data_json,sensitive,created_at) VALUES(?,?,?,?,?,1,?)').run(runId, jobId, attemptId, type, encode(data), now());
    return Number(result.lastInsertRowid);
  }
  workflow(jobId) { return this.db.prepare('SELECT * FROM logical_job_publication_state WHERE job_id=?').get(jobId) || null; }
  transition(jobId, state, fields = {}) {
    const allowed = new Set(['component_id', 'candidate_id', 'build_id', 'revision_id', 'canvas_publication_id', 'attempt_id']);
    const entries = Object.entries(fields).filter(([key]) => allowed.has(key));
    const assignments = ['state=?', 'updated_at=?', ...entries.map(([key]) => `${key}=?`)];
    this.db.prepare(`UPDATE logical_job_publication_state SET ${assignments.join(',')} WHERE job_id=?`).run(state, now(), ...entries.map(([, value]) => value), jobId);
    return this.workflow(jobId);
  }
  injectFault(boundary, jobId) {
    if (this.faultAt !== boundary || this.injectedFaults.has(`${jobId}:${boundary}`)) return;
    this.injectedFaults.add(`${jobId}:${boundary}`);
    throw Object.assign(new Error(`Injected crash after ${boundary} boundary`), { code: 'fault_injected', boundary });
  }
  projectThreads(projectId) {
    const state = this.store.get();
    return state.chatThreads.filter((thread) => thread.projectId === projectId && thread.scope !== 'legacy_unscoped').map((thread) => ({ ...thread, latestRun: this.db.prepare('SELECT id,status,created_at FROM thread_runs WHERE thread_id=? ORDER BY created_at DESC LIMIT 1').get(thread.id) || null }));
  }
  messages(projectId, threadId) {
    const state = this.store.get(); const thread = state.chatThreads.find((item) => item.id === threadId && item.projectId === projectId);
    return thread ? state.chatMessages.filter((message) => message.threadId === threadId) : null;
  }
  createThread(projectId, title = 'New project thread') {
    if (!this.store.get().projects.some((project) => project.id === projectId && !project.deletedAt)) throw Object.assign(new Error('Project not found'), { status: 404, code: 'not_found' });
    return this.store.with((state, helpers) => { const thread = { id: helpers.id(), projectId, scope: 'project', title: String(title || 'New project thread').slice(0, 80), createdAt: helpers.now(), updatedAt: helpers.now() }; state.chatThreads.unshift(thread); return thread; });
  }
  ensureThread(projectId, threadId) {
    const thread = this.store.get().chatThreads.find((item) => item.id === threadId && item.projectId === projectId && item.scope !== 'legacy_unscoped');
    if (!thread) throw Object.assign(new Error('Project thread not found'), { status: 404, code: 'not_found' }); return thread;
  }

  createRun({ projectId, threadId, prompt, contextSnapshotId, providerConfigId, deliverables }) {
    const thread = this.ensureThread(projectId, threadId); const context = this.contexts.get(contextSnapshotId);
    if (!context || context.projectId !== projectId) throw Object.assign(new Error('A ContextEnvelopeV1 snapshot from this project is required'), { status: 422, code: 'context_required' });
    const { config } = this.providers.resolve(providerConfigId); const plan = planDeliverables(prompt, deliverables);
    if (!String(prompt || '').trim()) throw Object.assign(new Error('Prompt is required'), { status: 400, code: 'prompt_required' });
    const runId = id(); const requestMessageId = id(); const stamp = now();
    const predecessor = this.db.prepare("SELECT id FROM thread_runs WHERE thread_id=? AND status IN ('queued','running') ORDER BY created_at DESC LIMIT 1").get(threadId)?.id || null;
    const attemptIds = [];
    this.store.with((state, helpers) => {
      const currentThread = state.chatThreads.find((item) => item.id === threadId && item.projectId === projectId);
      if (!currentThread) throw Object.assign(new Error('Project thread not found'), { status: 404, code: 'not_found' });
      state.chatMessages.push({ id: requestMessageId, threadId, role: 'user', content: String(prompt), contextSnapshotId, runId, createdAt: stamp });
      currentThread.updatedAt = stamp; if (/^New project thread$/i.test(currentThread.title)) currentThread.title = String(prompt).trim().slice(0, 64);
      this.db.prepare(`INSERT INTO thread_runs(id,thread_id,project_id,context_snapshot_id,provider_config_id,predecessor_run_id,request_message_id,prompt,status,deliverable_count,created_at)
        VALUES(?,?,?,?,?,?,?,?,?,?,?)`).run(runId, threadId, projectId, contextSnapshotId, config.id, predecessor, requestMessageId, String(prompt), 'queued', plan.length, stamp);
      for (const deliverable of plan) {
        const jobId = id(); const attemptId = id(); const publicationKey = `frame:${jobId}`;
        const request = { schema: 'LogicalJobRequestV1', projectId, threadId, runId, prompt: String(prompt), deliverable, contextSnapshotId, provider: config };
        this.db.prepare(`INSERT INTO jobs(id,status,ordinal,data_json,run_id,project_id,deliverable_key,deliverable_name,request_json,context_snapshot_id,publication_key,created_at,updated_at)
          VALUES(?,?,?,?,?,?,?,?,?,?,?,?,?)`).run(jobId, 'queued', deliverable.ordinal, encode({ id: jobId, phase3: true }), runId, projectId, deliverable.key, deliverable.name, encode(request), contextSnapshotId, publicationKey, stamp, stamp);
        this.db.prepare('INSERT INTO job_attempts(id,job_id,attempt_number,status,created_at) VALUES(?,?,1,?,?)').run(attemptId, jobId, 'queued', stamp);
        this.event(runId, 'job_queued', { name: deliverable.name, attemptNumber: 1 }, jobId, attemptId); attemptIds.push(attemptId);
      }
      this.event(runId, 'run_queued', { deliverables: plan.map(({ key, name }) => ({ key, name })), predecessorRunId: predecessor });
    });
    for (const attemptId of attemptIds) this.enqueue(attemptId); this.drain();
    return this.getRun(runId);
  }
  /** @param {any} input */
  createThreadRun(input) { const thread = this.createThread(input.projectId, input.title); return { thread, run: this.createRun({ projectId: input.projectId, threadId: thread.id, prompt: input.prompt, contextSnapshotId: input.contextSnapshotId, providerConfigId: input.providerConfigId, deliverables: input.deliverables }) }; }

  getRun(runId) {
    const run = this.db.prepare('SELECT * FROM thread_runs WHERE id=?').get(runId); if (!run) return null;
    const jobs = this.db.prepare('SELECT * FROM jobs WHERE run_id=? ORDER BY ordinal').all(runId).map((job) => ({
      id: job.id, runId: job.run_id, projectId: job.project_id, name: job.deliverable_name, key: job.deliverable_key, status: job.status,
      publicationKey: job.publication_key, componentId: job.result_component_id, revisionId: job.result_revision_id, createdAt: job.created_at, updatedAt: job.updated_at,
      attempts: this.db.prepare('SELECT * FROM job_attempts WHERE job_id=? ORDER BY attempt_number').all(job.id).map((attempt) => ({ id: attempt.id, attemptNumber: attempt.attempt_number, status: attempt.status, buildId: attempt.build_id, errorCode: attempt.error_code, errorMessage: attempt.error_message, createdAt: attempt.created_at, startedAt: attempt.started_at, finishedAt: attempt.finished_at })),
    }));
    return { id: run.id, threadId: run.thread_id, projectId: run.project_id, contextSnapshotId: run.context_snapshot_id, providerConfigId: run.provider_config_id, predecessorRunId: run.predecessor_run_id, prompt: run.prompt, status: run.status, deliverableCount: run.deliverable_count, completedCount: run.completed_count, createdAt: run.created_at, startedAt: run.started_at, finishedAt: run.finished_at, errorCode: run.error_code, jobs };
  }
  events(runId, after = 0) {
    return this.db.prepare('SELECT * FROM job_events WHERE run_id=? AND id>? ORDER BY id LIMIT 250').all(runId, Number(after) || 0).map((row) => ({ id: Number(row.id), type: row.event_type, jobId: row.job_id, attemptId: row.attempt_id, data: decode(row.data_json, {}), createdAt: row.created_at }));
  }

  enqueue(attemptId) { if (!this.queued.has(attemptId) && !this.active.has(attemptId)) { this.queued.add(attemptId); this.queue.push(attemptId); } }
  eligible(attemptId) {
    const row = this.db.prepare(`SELECT a.status,r.predecessor_run_id,p.status predecessor_status FROM job_attempts a JOIN jobs j ON j.id=a.job_id JOIN thread_runs r ON r.id=j.run_id LEFT JOIN thread_runs p ON p.id=r.predecessor_run_id WHERE a.id=?`).get(attemptId);
    return row?.status === 'queued' && (!row.predecessor_run_id || terminalRuns.has(row.predecessor_status));
  }
  drain() {
    if (this.active.size >= this.maximum || !this.queue.length) return;
    let scans = this.queue.length;
    while (this.active.size < this.maximum && this.queue.length && scans-- > 0) {
      const attemptId = this.queue.shift(); this.queued.delete(attemptId);
      if (!this.eligible(attemptId)) { const status = this.db.prepare('SELECT status FROM job_attempts WHERE id=?').get(attemptId)?.status; if (status === 'queued') { this.queue.push(attemptId); this.queued.add(attemptId); } continue; }
      const controller = new AbortController(); this.active.set(attemptId, controller);
      void this.execute(attemptId, controller).catch((error) => { if (error?.code !== 'fault_injected') console.error('Logical job execution failed unexpectedly', error); }).finally(() => { this.active.delete(attemptId); this.enqueueEligible(); this.drain(); });
    }
  }
  enqueueEligible() { for (const row of this.db.prepare("SELECT id FROM job_attempts WHERE status='queued' ORDER BY created_at").all()) this.enqueue(row.id); }

  async execute(attemptId, controller) {
    const stamp = now();
    const claimed = this.db.prepare("UPDATE job_attempts SET status='running',started_at=COALESCE(started_at,?) WHERE id=? AND status='queued'").run(stamp, attemptId);
    if (!claimed.changes) return;
    const row = this.db.prepare('SELECT a.*,j.run_id,j.request_json,j.deliverable_name,j.ordinal,j.status job_status FROM job_attempts a JOIN jobs j ON j.id=a.job_id WHERE a.id=?').get(attemptId);
    this.db.prepare("UPDATE jobs SET status='running',updated_at=? WHERE id=?").run(stamp, row.job_id);
    this.db.prepare("UPDATE thread_runs SET status='running',started_at=COALESCE(started_at,?) WHERE id=? AND status='queued'").run(stamp, row.run_id);
    this.event(row.run_id, 'attempt_started', { attemptNumber: row.attempt_number, reconciled: Boolean(this.workflow(row.job_id)) }, row.job_id, attemptId);
    const request = decode(row.request_json, {}); const context = this.contexts.get(request.contextSnapshotId);
    let timeout = false; const timer = setTimeout(() => { timeout = true; controller.abort(); }, this.timeoutMs);
    try {
      let workflow = this.workflow(row.job_id);
      if (!workflow) {
        const { provider, config } = this.providers.resolveSnapshot(request.provider);
        this.db.prepare("UPDATE job_attempts SET status='streaming' WHERE id=? AND status='running'").run(attemptId);
        const generated = await provider.generate({ ...request, attemptNumber: row.attempt_number, context: { id: request.contextSnapshotId, envelope: context }, config, signal: controller.signal, onEvent: (type, data) => this.event(row.run_id, type, data, row.job_id, attemptId) });
        if (controller.signal.aborted) throw Object.assign(new Error('Attempt cancelled'), { code: timeout ? 'attempt_timeout' : 'user_cancelled' });
        const created = now();
        this.db.prepare(`INSERT INTO logical_job_publication_state(job_id,state,generated_json,attempt_id,created_at,updated_at)
          VALUES(?,'provider_completed',?,?,?,?)`).run(row.job_id, encode({ generated, providerKind: config.kind }), attemptId, created, created);
        workflow = this.workflow(row.job_id);
        this.event(row.run_id, 'publication_provider_completed', {}, row.job_id, attemptId);
        this.injectFault('provider', row.job_id);
      } else {
        this.transition(row.job_id, workflow.state, { attempt_id: attemptId });
      }

      const generated = decode(workflow.generated_json, {}).generated || {};
      let component = workflow.component_id && this.store.get().components.find((item) => item.id === workflow.component_id);
      if (!component) component = this.store.get().components.find((item) => item.logicalJobId === row.job_id);
      if (!component) component = this.store.with((state, helpers) => {
        const existing = state.components.find((item) => item.logicalJobId === row.job_id); if (existing) return existing;
        const item = { id: helpers.id(), projectId: request.projectId, name: generated.name || row.deliverable_name, generatedName: helpers.slugName(generated.name || row.deliverable_name), prompt: request.prompt, code: '', files: {}, selectedRevisionId: null, logicalJobId: row.job_id, contextSnapshotId: context.id, createdAt: helpers.now(), updatedAt: helpers.now() };
        state.components.unshift(item); return item;
      });
      if (!workflow.component_id) workflow = this.transition(row.job_id, 'component_created', { component_id: component.id, attempt_id: attemptId });

      let candidateId = workflow.candidate_id; let buildId = workflow.build_id;
      if (!candidateId) {
        const existing = this.db.prepare("SELECT id FROM revision_candidates WHERE json_extract(metadata_json,'$.logicalJobId')=? ORDER BY created_at LIMIT 1").get(row.job_id);
        if (existing) {
          candidateId = existing.id; buildId = this.db.prepare('SELECT id FROM builds WHERE candidate_id=? ORDER BY rowid LIMIT 1').get(candidateId)?.id;
        } else {
          const themedFiles = this.contexts.applyToGeneratedFiles(generated.files, context);
          const queued = this.candidates.create({ componentId: component.id, files: themedFiles, expectedBaseRevisionId: null, metadata: { ...this.contexts.revisionMetadata(context), logicalJobId: row.job_id }, note: `${decode(workflow.generated_json, {}).providerKind || 'provider'}: ${row.deliverable_name}` });
          candidateId = queued.candidateId; buildId = queued.buildId;
        }
        workflow = this.transition(row.job_id, 'candidate_created', { component_id: component.id, candidate_id: candidateId, build_id: buildId, attempt_id: attemptId });
        this.event(row.run_id, 'publication_candidate_created', { candidateId, buildId }, row.job_id, attemptId);
        this.injectFault('candidate', row.job_id);
      }

      this.db.prepare("UPDATE job_attempts SET status='building',build_id=? WHERE id=?").run(buildId, attemptId);
      let build = this.candidates.getBuild(buildId);
      if (build?.status === 'failed' && Number(row.attempt_number) > 1) {
        // An explicit logical-job retry reuses the immutable provider output and
        // candidate source, but gives its failed build another bounded worker attempt.
        const reset = now(); this.db.exec('BEGIN IMMEDIATE');
        try {
          this.db.prepare("UPDATE builds SET status='queued',started_at=NULL,finished_at=NULL,diagnostics_json='[]',worker_json='{}' WHERE id=? AND status='failed'").run(buildId);
          this.db.prepare("UPDATE revision_candidates SET status='queued',updated_at=?,diagnostics_json='[]' WHERE id=?").run(reset, candidateId);
          this.db.prepare('INSERT INTO build_events(build_id,event_type,data_json,created_at) VALUES(?,?,?,?)').run(buildId, 'logical_job_retry', encode({ attemptNumber: row.attempt_number }), reset);
          this.db.exec('COMMIT');
        } catch (error) { this.db.exec('ROLLBACK'); throw error; }
        build = this.candidates.getBuild(buildId);
      }
      if (!build || build.status !== 'succeeded') {
        this.event(row.run_id, 'build_started', { buildId }, row.job_id, attemptId);
        build = await this.candidates.run(buildId, { signal: controller.signal });
      }
      if (controller.signal.aborted) throw Object.assign(new Error(timeout ? 'Attempt timed out' : 'Attempt cancelled'), { code: timeout ? 'attempt_timeout' : 'user_cancelled' });
      if (build.status !== 'succeeded') throw Object.assign(new Error(build.diagnostics?.[0]?.message || 'Candidate build failed'), { code: build.diagnostics?.[0]?.code || 'build_failed' });
      const revisionId = workflow.revision_id || build.revision_id;
      if (!revisionId) throw Object.assign(new Error('Succeeded build has no revision'), { code: 'revision_missing' });
      if (!workflow.revision_id) {
        workflow = this.transition(row.job_id, 'revision_created', { revision_id: revisionId, attempt_id: attemptId });
        this.event(row.run_id, 'publication_revision_created', { revisionId }, row.job_id, attemptId);
        this.injectFault('revision', row.job_id);
      }

      const publicationKey = `frame:${row.job_id}`;
      this.db.prepare(`INSERT OR IGNORE INTO logical_job_publications(publication_key,job_id,component_id,revision_id,canvas_publication_id,status,created_at) VALUES(?,?,?,?,?,'pending',?)`).run(publicationKey, row.job_id, component.id, revisionId, publicationKey, now());
      const publication = this.canvases.publish(request.projectId, row.job_id, { componentId: component.id, revisionId, title: row.deliverable_name, x: 80 + (Number(row.ordinal) % 3) * 390, y: 80 + Math.floor(Number(row.ordinal) / 3) * 350, w: 360, h: 320 });
      if (publication?.status !== 'materialized') throw Object.assign(new Error('Canvas frame publication could not be materialized'), { code: 'publication_failed' });
      if (workflow.state !== 'canvas_materialized' && workflow.state !== 'acknowledged') {
        const materialized = now();
        this.db.prepare("UPDATE logical_job_publications SET status='materialized',materialized_at=? WHERE job_id=?").run(materialized, row.job_id);
        workflow = this.transition(row.job_id, 'canvas_materialized', { canvas_publication_id: publicationKey, attempt_id: attemptId });
        this.event(row.run_id, 'publication_canvas_materialized', { publicationKey }, row.job_id, attemptId);
        this.injectFault('canvas', row.job_id);
      }

      if (workflow.state !== 'acknowledged') {
        const finished = now(); this.db.exec('BEGIN IMMEDIATE');
        try {
          this.db.prepare("UPDATE job_attempts SET status='succeeded',finished_at=?,error_code=NULL,error_message=NULL WHERE id=?").run(finished, attemptId);
          this.db.prepare("UPDATE jobs SET status='succeeded',result_component_id=?,result_revision_id=?,updated_at=? WHERE id=?").run(component.id, revisionId, finished, row.job_id);
          this.db.prepare("UPDATE logical_job_publication_state SET state='acknowledged',attempt_id=?,updated_at=? WHERE job_id=?").run(attemptId, finished, row.job_id);
          this.event(row.run_id, 'job_succeeded', { componentId: component.id, revisionId, publicationKey }, row.job_id, attemptId);
          this.db.exec('COMMIT');
        } catch (error) { this.db.exec('ROLLBACK'); throw error; }
      }
      this.injectFault('ack', row.job_id);
    } catch (error) {
      // Fault injection models process death: durable state is intentionally left at the
      // preceding boundary so a new service instance exercises the startup reconciler.
      if (error?.code === 'fault_injected') throw error;
      const cancelled = controller.signal.aborted && !timeout; const code = timeout ? 'attempt_timeout' : (error?.code || (cancelled ? 'user_cancelled' : 'provider_failed')); const status = cancelled ? 'cancelled' : 'failed'; const finished = now();
      this.db.exec('BEGIN IMMEDIATE');
      try {
        this.db.prepare('UPDATE job_attempts SET status=?,finished_at=?,error_code=?,error_message=? WHERE id=?').run(status, finished, code, String(error?.message || error).slice(0, 2000), attemptId);
        this.db.prepare('UPDATE jobs SET status=?,updated_at=? WHERE id=?').run(status, finished, row.job_id);
        this.event(row.run_id, status === 'cancelled' ? 'job_cancelled' : 'job_failed', { code, message: String(error?.message || error) }, row.job_id, attemptId); this.db.exec('COMMIT');
      } catch (next) { this.db.exec('ROLLBACK'); throw next; }
    } finally { clearTimeout(timer); this.recomputeRun(row.run_id); }
  }

  recomputeRun(runId) {
    const run = this.db.prepare('SELECT * FROM thread_runs WHERE id=?').get(runId); if (!run) return;
    const counts = Object.fromEntries(this.db.prepare('SELECT status,count(*) count FROM jobs WHERE run_id=? GROUP BY status').all(runId).map((item) => [item.status, Number(item.count)]));
    const complete = Number(counts.succeeded || 0); const terminal = complete + Number(counts.failed || 0) + Number(counts.cancelled || 0);
    let status = run.status;
    if (terminal === Number(run.deliverable_count)) {
      if (complete === Number(run.deliverable_count)) status = 'succeeded';
      else if (complete > 0) status = 'partial';
      else if (Number(counts.cancelled || 0) === Number(run.deliverable_count)) status = 'cancelled';
      else status = 'failed';
    } else if (Number(counts.running || 0) || complete) status = 'running'; else status = 'queued';
    const finished = terminalRuns.has(status) ? (run.finished_at || now()) : null;
    this.db.prepare('UPDATE thread_runs SET status=?,completed_count=?,finished_at=?,error_code=? WHERE id=?').run(status, complete, finished, status === 'failed' ? 'all_jobs_failed' : null, runId);
    if (terminalRuns.has(status) && !terminalRuns.has(run.status)) { this.event(runId, 'run_finished', { status, completed: complete, total: Number(run.deliverable_count) }); this.finishMessage(runId); }
  }
  finishMessage(runId) {
    const run = this.db.prepare('SELECT * FROM thread_runs WHERE id=?').get(runId); if (!run || run.response_message_id) return;
    const jobs = this.db.prepare('SELECT deliverable_name,status,result_component_id,result_revision_id FROM jobs WHERE run_id=? ORDER BY ordinal').all(runId);
    const messageId = id(); const lines = jobs.map((job) => `${job.status === 'succeeded' ? '✓' : job.status === 'cancelled' ? '–' : '✕'} ${job.deliverable_name}: ${job.status}`);
    this.store.with((state) => {
      const current = this.db.prepare('SELECT response_message_id FROM thread_runs WHERE id=?').get(runId); if (current?.response_message_id) return;
      state.chatMessages.push({ id: messageId, threadId: run.thread_id, role: 'assistant', content: `Run ${run.status}.\n${lines.join('\n')}`, runId, deliverables: jobs, createdAt: now() });
      this.db.prepare('UPDATE thread_runs SET response_message_id=? WHERE id=? AND response_message_id IS NULL').run(messageId, runId);
    });
  }

  cancel(runId) {
    const run = this.db.prepare('SELECT * FROM thread_runs WHERE id=?').get(runId); if (!run) return null; if (terminalRuns.has(run.status)) return this.getRun(runId);
    const stamp = now(); this.db.exec('BEGIN IMMEDIATE');
    try {
      for (const attempt of this.db.prepare("SELECT a.id,a.job_id FROM job_attempts a JOIN jobs j ON j.id=a.job_id WHERE j.run_id=? AND a.status IN ('queued','running','streaming','building')").all(runId)) {
        this.db.prepare("UPDATE job_attempts SET status='cancelled',finished_at=?,error_code='user_cancelled',error_message='Run cancelled by user' WHERE id=?").run(stamp, attempt.id);
        this.db.prepare("UPDATE jobs SET status='cancelled',updated_at=? WHERE id=?").run(stamp, attempt.job_id); this.event(runId, 'job_cancelled', { code: 'user_cancelled' }, attempt.job_id, attempt.id);
      }
      this.db.prepare("UPDATE thread_runs SET status='cancelled',finished_at=?,error_code='user_cancelled' WHERE id=?").run(stamp, runId); this.event(runId, 'run_cancelled', {}); this.db.exec('COMMIT');
    } catch (error) { this.db.exec('ROLLBACK'); throw error; }
    for (const [attemptId, controller] of this.active) { const belongs = this.db.prepare('SELECT 1 FROM job_attempts a JOIN jobs j ON j.id=a.job_id WHERE a.id=? AND j.run_id=?').get(attemptId, runId); if (belongs) controller.abort(); }
    this.finishMessage(runId); this.enqueueEligible(); this.drain(); return this.getRun(runId);
  }
  retry(jobId) {
    const job = this.db.prepare('SELECT * FROM jobs WHERE id=? AND run_id IS NOT NULL').get(jobId); if (!job) return null;
    if (!['failed', 'cancelled'].includes(job.status)) throw Object.assign(new Error('Only failed or cancelled logical jobs can be retried'), { status: 409, code: 'retry_not_allowed' });
    const workflow = this.workflow(jobId);
    if (workflow?.state === 'acknowledged') throw Object.assign(new Error('Logical job is already acknowledged'), { status: 409, code: 'retry_not_allowed' });
    const number = Number(this.db.prepare('SELECT COALESCE(MAX(attempt_number),0) number FROM job_attempts WHERE job_id=?').get(jobId).number) + 1; const attemptId = id(); const stamp = now();
    this.db.exec('BEGIN IMMEDIATE');
    try {
      this.db.prepare('INSERT INTO job_attempts(id,job_id,attempt_number,status,created_at) VALUES(?,?,?,?,?)').run(attemptId, jobId, number, 'queued', stamp);
      this.db.prepare("UPDATE jobs SET status='queued',updated_at=? WHERE id=?").run(stamp, jobId);
      this.db.prepare("UPDATE thread_runs SET status='queued',finished_at=NULL,error_code=NULL,response_message_id=NULL WHERE id=?").run(job.run_id);
      if (workflow) this.db.prepare('UPDATE logical_job_publication_state SET attempt_id=?,updated_at=? WHERE job_id=?').run(attemptId, stamp, jobId);
      this.event(job.run_id, 'job_retried', { attemptNumber: number, resumesPublication: Boolean(workflow) }, jobId, attemptId); this.db.exec('COMMIT');
    } catch (error) { this.db.exec('ROLLBACK'); throw error; }
    this.enqueue(attemptId); this.drain(); return this.getRun(job.run_id);
  }

  recover() {
    const interrupted = this.db.prepare("SELECT a.id,a.job_id,j.run_id,a.build_id,w.state publication_state FROM job_attempts a JOIN jobs j ON j.id=a.job_id LEFT JOIN logical_job_publication_state w ON w.job_id=j.id WHERE a.status IN ('running','streaming','building')").all();
    const affectedRuns = new Set();
    for (const attempt of interrupted) {
      const stamp = now(); affectedRuns.add(attempt.run_id);
      if (attempt.publication_state && attempt.publication_state !== 'acknowledged') {
        // Provider output and every later publication boundary are durable. Resume the
        // same attempt rather than fabricating a retry or reporting already_published.
        this.db.prepare("UPDATE job_attempts SET status='queued',finished_at=NULL,error_code=NULL,error_message=NULL WHERE id=?").run(attempt.id);
        this.db.prepare("UPDATE jobs SET status='queued',updated_at=? WHERE id=?").run(stamp, attempt.job_id);
        this.db.prepare("UPDATE thread_runs SET status='queued',finished_at=NULL,error_code=NULL WHERE id=?").run(attempt.run_id);
        this.event(attempt.run_id, 'publication_reconcile_queued', { state: attempt.publication_state }, attempt.job_id, attempt.id);
      } else if (attempt.publication_state === 'acknowledged') {
        this.db.prepare("UPDATE job_attempts SET status='succeeded',finished_at=COALESCE(finished_at,?),error_code=NULL,error_message=NULL WHERE id=?").run(stamp, attempt.id);
        this.db.prepare("UPDATE jobs SET status='succeeded',updated_at=? WHERE id=?").run(stamp, attempt.job_id);
      } else {
        this.db.prepare("UPDATE job_attempts SET status='failed',finished_at=?,error_code='server_restarted',error_message='Server restarted before provider output was durable' WHERE id=?").run(stamp, attempt.id);
        this.db.prepare("UPDATE jobs SET status='failed',updated_at=? WHERE id=?").run(stamp, attempt.job_id); this.event(attempt.run_id, 'job_failed', { code: 'server_restarted' }, attempt.job_id, attempt.id);
        if (attempt.build_id) this.candidates.cancel?.(attempt.build_id, 'server_restarted');
      }
    }
    // Repair an acknowledged publication if a process died after the workflow commit
    // but before projections were observed by callers.
    for (const row of this.db.prepare("SELECT w.job_id,j.run_id,w.component_id,w.revision_id,w.attempt_id FROM logical_job_publication_state w JOIN jobs j ON j.id=w.job_id WHERE w.state='acknowledged' AND j.status!='succeeded'").all()) {
      const stamp = now(); affectedRuns.add(row.run_id);
      this.db.prepare("UPDATE jobs SET status='succeeded',result_component_id=?,result_revision_id=?,updated_at=? WHERE id=?").run(row.component_id, row.revision_id, stamp, row.job_id);
      this.db.prepare("UPDATE job_attempts SET status='succeeded',finished_at=COALESCE(finished_at,?) WHERE id=?").run(stamp, row.attempt_id);
    }
    for (const runId of affectedRuns) this.recomputeRun(runId);
    this.enqueueEligible(); queueMicrotask(() => this.drain());
  }
  close() { for (const controller of this.active.values()) controller.abort(); }
}
