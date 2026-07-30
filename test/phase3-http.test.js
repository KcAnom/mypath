import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import fs from 'node:fs';
import net from 'node:net';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';

const freePort = () => new Promise((resolve) => { const socket = net.createServer(); socket.listen(0, '127.0.0.1', () => { const port = socket.address().port; socket.close(() => resolve(port)); }); });
async function waitFor(url) { for (let index = 0; index < 100; index++) { try { if ((await fetch(`${url}/health`)).ok) return; } catch {} await new Promise((resolve) => setTimeout(resolve, 50)); } throw new Error('server did not start'); }

let child, root, base, token;
test.before(async () => {
  root = fs.mkdtempSync(path.join(os.tmpdir(), 'mypath-phase3-http-')); const port = await freePort(); base = `http://127.0.0.1:${port}`;
  child = spawn(process.execPath, ['server/index.js'], { cwd: process.cwd(), env: { ...process.env, MYPATH_API_PORT: String(port), MYPATH_DATA_DIR: root, MYPATH_JOB_CONCURRENCY: '3', MYPATH_BUILD_CONCURRENCY: '3' }, stdio: ['ignore', 'pipe', 'pipe'] });
  let stderr = ''; child.stderr.on('data', (chunk) => { stderr += chunk; });
  try { await waitFor(base); } catch (error) { throw new Error(`${error.message}: ${stderr}`); }
  token = (await fetch(`${base}/api/v1/session`, { headers: { Origin: base, 'Sec-Fetch-Site': 'same-origin' } }).then((response) => response.json())).token;
});
test.after(() => { child?.kill('SIGTERM'); fs.rmSync(root, { recursive: true, force: true }); });
const headers = (json = false) => ({ Origin: base, 'Sec-Fetch-Site': 'same-origin', 'X-MyPath-Session': token, Accept: 'application/json', ...(json ? { 'Content-Type': 'application/json' } : {}) });
const post = (pathname, body) => fetch(`${base}${pathname}`, { method: 'POST', headers: headers(true), body: JSON.stringify(body) });

test('authenticated project-run API streams persisted events for three deliverables and reloads results', async () => {
  const projectResponse = await post('/api/v1/projects', { name: 'HTTP project chat' }); assert.equal(projectResponse.status, 201); const project = await projectResponse.json();
  const contextResponse = await post(`/api/v1/projects/${project.id}/context-snapshots`, {}); assert.equal(contextResponse.status, 201); const context = await contextResponse.json(); assert.equal(context.schema, 'ContextEnvelopeV1');
  const providers = await fetch(`${base}/api/v1/provider-configs`, { headers: headers() }).then((response) => response.json()); assert.equal(providers.find((provider) => provider.id === 'fixture').status, 'ready');
  const runResponse = await post(`/api/v1/projects/${project.id}/chat/runs`, { prompt: 'Build three screens', contextSnapshotId: context.id, providerConfigId: 'fixture', deliverables: ['Home', 'Search', 'Profile'] });
  assert.equal(runResponse.status, 202); const created = await runResponse.json(); assert.equal(created.run.jobs.length, 3);
  const streamResponse = await fetch(`${base}/api/v1/thread-runs/${created.run.id}/events`, { headers: { ...headers(), Accept: 'text/event-stream', 'Last-Event-ID': '0' } }); assert.equal(streamResponse.status, 200);
  const records = await streamResponse.text(); const eventIds = [...records.matchAll(/^id:\s*(\d+)/gm)].map((match) => Number(match[1]));
  assert.ok(records.includes('event: run_finished')); assert.equal(new Set(eventIds).size, eventIds.length); assert.ok(eventIds.every((value, index) => index === 0 || value > eventIds[index - 1]));
  const loaded = await fetch(`${base}/api/v1/thread-runs/${created.run.id}`, { headers: headers() }).then((response) => response.json());
  assert.equal(loaded.status, 'succeeded'); assert.equal(loaded.completedCount, 3); assert.ok(loaded.jobs.every((job) => job.revisionId));
  const canvas = await fetch(`${base}/api/v1/projects/${project.id}/canvas`, { headers: headers() }).then((response) => response.json());
  assert.equal(canvas.snapshot.legacyShapes.filter((shape) => shape.props?.publicationId?.startsWith('frame:')).length, 3);
  const resumed = await fetch(`${base}/api/v1/thread-runs/${created.run.id}/events`, { headers: { ...headers(), Accept: 'text/event-stream', 'Last-Event-ID': String(eventIds.at(-2)) } }).then((response) => response.text());
  assert.equal((resumed.match(/^id:/gm) || []).length, 1, 'Last-Event-ID resumes without duplicate records');
});

test('provider config API rejects secret values', async () => {
  const response = await post('/api/v1/provider-configs', { kind: 'openai-compatible', label: 'Bad', baseUrl: 'http://127.0.0.1:9999', apiKey: 'secret' });
  assert.equal(response.status, 422); assert.equal((await response.json()).error.code, 'provider_secret_rejected');
});
