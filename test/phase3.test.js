import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';
import { Store } from '../server/store.js';
import { CandidateService } from '../server/src/build/candidate-service.js';
import { CanvasService } from '../server/src/canvas/canvas-service.js';
import { ContextService } from '../server/src/context/context-service.js';
import { ProviderRegistry } from '../server/src/runs/provider-registry.js';
import { RunService } from '../server/src/runs/run-service.js';
import { planDeliverables } from '../server/src/runs/planner.js';

const pause = (ms) => new Promise((resolve) => setTimeout(resolve, ms));
async function waitFor(read, predicate, message = 'condition', timeout = 25_000) {
  const started = Date.now();
  while (Date.now() - started < timeout) { const value = read(); if (predicate(value)) return value; await pause(25); }
  throw new Error(`Timed out waiting for ${message}`);
}
function setup() {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'mypath-phase3-')); const store = new Store(root);
  store.with((state) => { state.projects.push({ id: 'p1', name: 'Parallel project', createdAt: new Date().toISOString() }); state.canvases.push({ id: 'canvas1', projectId: 'p1', version: 1, shapes: [], camera: {} }); });
  const candidates = new CandidateService(store); const canvases = new CanvasService(store.database); const contexts = new ContextService(store.database, canvases); const providers = new ProviderRegistry(store.database);
  const context = contexts.create('p1', {}); const runs = new RunService({ store, candidates, canvases, contexts, providers }); const thread = runs.createThread('p1');
  return { root, store, candidates, canvases, contexts, providers, context, runs, thread };
}
function cleanup(fixture) { fixture.runs.close(); fixture.store.close(); fs.rmSync(fixture.root, { recursive: true, force: true }); }

const terminal = (run) => ['succeeded', 'partial', 'failed', 'cancelled'].includes(run?.status);

test('named planner and deterministic provider publish a three-screen parallel run exactly once', async () => {
  const fixture = setup();
  try {
    assert.deepEqual(planDeliverables('Create three screens: Home, Search, Profile').map((item) => item.name), ['Home', 'Search', 'Profile']);
    const queued = fixture.runs.createRun({ projectId: 'p1', threadId: fixture.thread.id, prompt: 'Create three independent screens', contextSnapshotId: fixture.context.id, providerConfigId: 'fixture', deliverables: ['Home', 'Search', 'Profile'] });
    const complete = await waitFor(() => fixture.runs.getRun(queued.id), terminal, 'three-screen run');
    assert.equal(complete.status, 'succeeded'); assert.equal(complete.jobs.length, 3); assert.ok(complete.jobs.every((job) => job.status === 'succeeded' && job.attempts.length === 1));
    assert.equal(new Set(complete.jobs.map((job) => job.componentId)).size, 3); assert.equal(new Set(complete.jobs.map((job) => job.revisionId)).size, 3);
    const snapshot = fixture.canvases.get('p1').snapshot; const frames = snapshot.legacyShapes.filter((shape) => complete.jobs.some((job) => shape.props?.publicationId === `frame:${job.id}`));
    assert.equal(frames.length, 3); assert.equal(fixture.store.database.db.prepare('SELECT count(*) count FROM logical_job_publications').get().count, 3);
    for (const job of complete.jobs) fixture.canvases.publish('p1', job.id, { componentId: job.componentId, revisionId: job.revisionId });
    const after = fixture.canvases.get('p1').snapshot.legacyShapes.filter((shape) => complete.jobs.some((job) => shape.props?.publicationId === `frame:${job.id}`));
    assert.equal(after.length, 3, 'deterministic logical publication keys suppress duplicate frames');
  } finally { cleanup(fixture); }
});

test('restart policy fails interrupted attempts, re-enqueues queued attempts, and never creates an implicit retry', async () => {
  const fixture = setup();
  try {
    const queued = fixture.runs.createRun({ projectId: 'p1', threadId: fixture.thread.id, prompt: '[fixture-fail]', contextSnapshotId: fixture.context.id, providerConfigId: 'fixture' });
    const failed = await waitFor(() => fixture.runs.getRun(queued.id), terminal, 'fixture failure'); const job = failed.jobs[0]; const attempt = job.attempts[0]; assert.equal(job.status, 'failed');
    fixture.runs.close(); fixture.store.database.db.prepare("UPDATE job_attempts SET status='streaming',finished_at=NULL,error_code=NULL WHERE id=?").run(attempt.id);
    fixture.store.database.db.prepare("UPDATE jobs SET status='running' WHERE id=?").run(job.id); fixture.store.database.db.prepare("UPDATE thread_runs SET status='running',finished_at=NULL WHERE id=?").run(queued.id);
    fixture.runs = new RunService({ store: fixture.store, candidates: fixture.candidates, canvases: fixture.canvases, contexts: fixture.contexts, providers: fixture.providers });
    let recovered = fixture.runs.getRun(queued.id); assert.equal(recovered.jobs[0].attempts.length, 1); assert.equal(recovered.jobs[0].attempts[0].errorCode, 'server_restarted'); assert.equal(recovered.jobs[0].status, 'failed');
    fixture.runs.close(); fixture.store.database.db.prepare("UPDATE job_attempts SET status='queued',finished_at=NULL,error_code=NULL,error_message=NULL WHERE id=?").run(attempt.id);
    fixture.store.database.db.prepare("UPDATE jobs SET status='queued' WHERE id=?").run(job.id); fixture.store.database.db.prepare("UPDATE thread_runs SET status='queued',finished_at=NULL,response_message_id=NULL WHERE id=?").run(queued.id);
    fixture.runs = new RunService({ store: fixture.store, candidates: fixture.candidates, canvases: fixture.canvases, contexts: fixture.contexts, providers: fixture.providers });
    recovered = await waitFor(() => fixture.runs.getRun(queued.id), terminal, 're-enqueued queued attempt'); assert.equal(recovered.jobs[0].attempts.length, 1); assert.equal(recovered.jobs[0].attempts[0].status, 'failed');
    assert.ok(fixture.runs.events(queued.id).filter((event) => event.type === 'attempt_started').length >= 2);
  } finally { cleanup(fixture); }
});

test('same-thread work waits for its predecessor while a new thread runs independently', async () => {
  const fixture = setup();
  try {
    process.env.MYPATH_FIXTURE_DELAY_MS = '400';
    const first = fixture.runs.createRun({ projectId: 'p1', threadId: fixture.thread.id, prompt: '[fixture-fail] First', contextSnapshotId: fixture.context.id, providerConfigId: 'fixture' });
    await waitFor(() => fixture.runs.getRun(first.id), (run) => run.jobs[0].attempts[0].status === 'streaming', 'first provider');
    const dependent = fixture.runs.createRun({ projectId: 'p1', threadId: fixture.thread.id, prompt: '[fixture-fail] Dependent', contextSnapshotId: fixture.context.id, providerConfigId: 'fixture' });
    const independent = fixture.runs.createThreadRun({ projectId: 'p1', prompt: '[fixture-fail] Independent', contextSnapshotId: fixture.context.id, providerConfigId: 'fixture' }).run;
    assert.equal(dependent.predecessorRunId, first.id); assert.equal(fixture.runs.getRun(dependent.id).jobs[0].attempts[0].status, 'queued');
    await waitFor(() => fixture.runs.getRun(independent.id), (run) => run.jobs[0].attempts[0].status === 'streaming', 'independent provider');
    assert.equal(fixture.runs.getRun(dependent.id).jobs[0].attempts[0].status, 'queued', 'dependent work remains queued while predecessor is active');
    await waitFor(() => fixture.runs.getRun(dependent.id), terminal, 'dependent completion'); assert.equal(fixture.runs.getRun(dependent.id).jobs[0].attempts[0].status, 'failed');
  } finally { delete process.env.MYPATH_FIXTURE_DELAY_MS; cleanup(fixture); }
});

test('cancellation aborts provider work and kills an active build process group', async () => {
  const fixture = setup();
  try {
    process.env.MYPATH_FIXTURE_DELAY_MS = '5000';
    const providerRun = fixture.runs.createRun({ projectId: 'p1', threadId: fixture.thread.id, prompt: 'Slow provider', contextSnapshotId: fixture.context.id, providerConfigId: 'fixture' });
    await waitFor(() => fixture.runs.getRun(providerRun.id), (run) => run.jobs[0].attempts[0].status === 'streaming', 'provider streaming'); fixture.runs.cancel(providerRun.id);
    const cancelledProvider = await waitFor(() => fixture.runs.getRun(providerRun.id), terminal, 'provider cancellation'); assert.equal(cancelledProvider.status, 'cancelled');
    assert.equal(fixture.store.database.db.prepare('SELECT count(*) count FROM builds').get().count, 0, 'aborted provider never reaches build');
    delete process.env.MYPATH_FIXTURE_DELAY_MS;

    process.env.MYPATH_BUILD_TEST_DELAY_MS = '5000';
    const buildRun = fixture.runs.createThreadRun({ projectId: 'p1', prompt: 'Slow build', contextSnapshotId: fixture.context.id, providerConfigId: 'fixture' }).run;
    const buildId = await waitFor(() => fixture.runs.getRun(buildRun.id).jobs[0].attempts[0].buildId, Boolean, 'active build');
    await waitFor(() => fixture.candidates.activeWorkers.has(buildId), Boolean, 'build worker process'); fixture.runs.cancel(buildRun.id);
    await waitFor(() => fixture.candidates.getBuild(buildId), (build) => build?.status === 'failed' && !fixture.candidates.activeWorkers.has(buildId), 'killed build');
    const build = fixture.candidates.getBuild(buildId); assert.equal(build.status, 'failed'); assert.equal(build.diagnostics[0].code, 'build_cancelled'); assert.equal(fixture.runs.getRun(buildRun.id).status, 'cancelled');
  } finally { delete process.env.MYPATH_FIXTURE_DELAY_MS; delete process.env.MYPATH_BUILD_TEST_DELAY_MS; cleanup(fixture); }
});

test('explicit retry reuses immutable request, creates attempt N+1, and survives service reload without duplicate publication', async () => {
  const fixture = setup();
  try {
    const queued = fixture.runs.createRun({ projectId: 'p1', threadId: fixture.thread.id, prompt: '[fixture-fail-once] Retry card', contextSnapshotId: fixture.context.id, providerConfigId: 'fixture' });
    const first = await waitFor(() => fixture.runs.getRun(queued.id), terminal, 'first attempt failure'); assert.equal(first.status, 'failed'); const jobId = first.jobs[0].id;
    const originalRequest = fixture.store.database.db.prepare('SELECT request_json FROM jobs WHERE id=?').get(jobId).request_json;
    fixture.runs.retry(jobId); const succeeded = await waitFor(() => fixture.runs.getRun(queued.id), (run) => run.status === 'succeeded', 'retry success');
    assert.equal(succeeded.jobs[0].attempts.length, 2); assert.deepEqual(succeeded.jobs[0].attempts.map((attempt) => attempt.attemptNumber), [1, 2]); assert.equal(fixture.store.database.db.prepare('SELECT request_json FROM jobs WHERE id=?').get(jobId).request_json, originalRequest);
    fixture.runs.close(); fixture.runs = new RunService({ store: fixture.store, candidates: fixture.candidates, canvases: fixture.canvases, contexts: fixture.contexts, providers: fixture.providers });
    const loaded = fixture.runs.getRun(queued.id); assert.equal(loaded.status, 'succeeded'); assert.equal(loaded.jobs[0].attempts.length, 2);
    assert.equal(fixture.store.database.db.prepare('SELECT count(*) count FROM logical_job_publications WHERE job_id=?').get(jobId).count, 1);
    assert.equal(fixture.canvases.get('p1').snapshot.legacyShapes.filter((shape) => shape.props?.publicationId === `frame:${jobId}`).length, 1);
  } finally { cleanup(fixture); }
});

test('retry resumes a durable candidate after a worker failure without already_published deadlock', async () => {
  const fixture = setup();
  try {
    fixture.runs.close(); fixture.runs = new RunService({ store: fixture.store, candidates: fixture.candidates, canvases: fixture.canvases, contexts: fixture.contexts, providers: fixture.providers, faultAt: 'candidate' });
    const queued = fixture.runs.createRun({ projectId: 'p1', threadId: fixture.thread.id, prompt: 'Retry durable candidate', contextSnapshotId: fixture.context.id, providerConfigId: 'fixture' }); const jobId = queued.jobs[0].id;
    const workflow = await waitFor(() => fixture.store.database.db.prepare('SELECT * FROM logical_job_publication_state WHERE job_id=?').get(jobId), (item) => item?.state === 'candidate_created', 'durable candidate');
    await waitFor(() => fixture.runs.active.size, (size) => size === 0, 'candidate fault stop');
    const attemptId = queued.jobs[0].attempts[0].id; const stamp = new Date().toISOString();
    fixture.store.database.db.prepare("UPDATE builds SET status='failed',finished_at=?,diagnostics_json='[]' WHERE id=?").run(stamp, workflow.build_id);
    fixture.store.database.db.prepare("UPDATE revision_candidates SET status='failed' WHERE id=?").run(workflow.candidate_id);
    fixture.store.database.db.prepare("UPDATE job_attempts SET status='failed',finished_at=?,error_code='worker_failed' WHERE id=?").run(stamp, attemptId);
    fixture.store.database.db.prepare("UPDATE jobs SET status='failed' WHERE id=?").run(jobId); fixture.store.database.db.prepare("UPDATE thread_runs SET status='failed',finished_at=? WHERE id=?").run(stamp, queued.id);
    fixture.runs.retry(jobId);
    const completed = await waitFor(() => fixture.runs.getRun(queued.id), (run) => run?.status === 'succeeded', 'durable candidate retry');
    assert.equal(completed.jobs[0].attempts.length, 2); assert.equal(fixture.store.get().components.filter((item) => item.logicalJobId === jobId).length, 1);
    assert.equal(fixture.canvases.get('p1').snapshot.legacyShapes.filter((shape) => shape.props?.publicationId === `frame:${jobId}`).length, 1);
  } finally { cleanup(fixture); }
});

test('publication state machine reconciles crashes at provider, candidate, revision, canvas, and ack boundaries', async () => {
  for (const boundary of ['provider', 'candidate', 'revision', 'canvas', 'ack']) {
    const fixture = setup();
    try {
      fixture.runs.close();
      fixture.runs = new RunService({ store: fixture.store, candidates: fixture.candidates, canvases: fixture.canvases, contexts: fixture.contexts, providers: fixture.providers, faultAt: boundary });
      const queued = fixture.runs.createRun({ projectId: 'p1', threadId: fixture.thread.id, prompt: `Crash boundary ${boundary}`, contextSnapshotId: fixture.context.id, providerConfigId: 'fixture' });
      const jobId = queued.jobs[0].id;
      await waitFor(() => fixture.store.database.db.prepare('SELECT state FROM logical_job_publication_state WHERE job_id=?').get(jobId)?.state, (state) => {
        const order = ['provider_completed', 'component_created', 'candidate_created', 'revision_created', 'canvas_materialized', 'acknowledged'];
        const expected = boundary === 'provider' ? 'provider_completed' : boundary === 'candidate' ? 'candidate_created' : boundary === 'revision' ? 'revision_created' : boundary === 'canvas' ? 'canvas_materialized' : 'acknowledged';
        return order.indexOf(state) >= order.indexOf(expected);
      }, `${boundary} durable workflow boundary`);
      await waitFor(() => fixture.runs.active.size, (size) => size === 0, `${boundary} injected process stop`);
      fixture.runs.close();
      fixture.runs = new RunService({ store: fixture.store, candidates: fixture.candidates, canvases: fixture.canvases, contexts: fixture.contexts, providers: fixture.providers });
      const completed = await waitFor(() => fixture.runs.getRun(queued.id), (run) => run?.status === 'succeeded', `${boundary} reconciliation`);
      assert.equal(completed.jobs[0].attempts.length, 1, `${boundary} resumes the same attempt`);
      assert.equal(fixture.store.database.db.prepare('SELECT count(*) count FROM logical_job_publications WHERE job_id=?').get(jobId).count, 1);
      assert.equal(fixture.store.get().components.filter((item) => item.logicalJobId === jobId).length, 1);
      assert.equal(fixture.canvases.get('p1').snapshot.legacyShapes.filter((shape) => shape.props?.publicationId === `frame:${jobId}`).length, 1);
      assert.equal(fixture.store.database.db.prepare('SELECT state FROM logical_job_publication_state WHERE job_id=?').get(jobId).state, 'acknowledged');
    } finally { cleanup(fixture); }
  }
});

test('provider configuration stores environment-variable references but rejects secrets', () => {
  const fixture = setup();
  try {
    const saved = fixture.providers.save({ kind: 'openai-compatible', label: 'Local gateway', baseUrl: 'http://127.0.0.1:1234', model: 'test', apiKeyEnv: 'MYPATH_TEST_KEY' });
    assert.equal(saved.apiKeyEnv, 'MYPATH_TEST_KEY'); assert.equal(saved.status, 'missing-credential');
    assert.throws(() => fixture.providers.save({ kind: 'openai-compatible', apiKey: 'do-not-store' }), /may not be stored/);
    const raw = fixture.store.database.db.prepare('SELECT * FROM provider_configs WHERE id=?').get(saved.id); assert.equal(JSON.stringify(raw).includes('do-not-store'), false);
  } finally { cleanup(fixture); }
});
