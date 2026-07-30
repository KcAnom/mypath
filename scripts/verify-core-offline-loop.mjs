import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import fs from 'node:fs';
import net from 'node:net';
import os from 'node:os';
import path from 'node:path';

const port = await new Promise((resolve) => { const socket = net.createServer(); socket.listen(0, '127.0.0.1', () => { const address = socket.address(); if (!address || typeof address === 'string') throw new Error('No TCP address'); const value = address.port; socket.close(() => resolve(value)); }); });
const data = fs.mkdtempSync(path.join(os.tmpdir(), 'mypath-core-offline-')); const base = `http://127.0.0.1:${port}`;
const child = spawn(process.execPath, ['server/index.js'], { env: { ...process.env, MYPATH_API_PORT: String(port), MYPATH_DATA_DIR: data, HTTP_PROXY: '', HTTPS_PROXY: '', ALL_PROXY: '', NO_PROXY: '*' }, stdio: ['ignore', 'pipe', 'pipe'] });
let stderr = ''; child.stderr.on('data', (chunk) => { stderr += chunk; });
const pause = (ms) => new Promise((resolve) => setTimeout(resolve, ms));
async function stop() { if (child.exitCode == null) { child.kill('SIGTERM'); await new Promise((resolve) => child.once('exit', resolve)); } }
try {
  for (let attempt = 0; attempt < 200; attempt++) { try { if ((await fetch(`${base}/health`)).ok) break; } catch {} if (attempt === 199) throw new Error(stderr); await pause(25); }
  const shell = await fetch(base + '/', { headers: { Accept: 'text/html', 'Sec-Fetch-Mode': 'navigate', 'Sec-Fetch-Site': 'none' } }); assert.equal(shell.status, 200); assert.match(await shell.text(), /<div id="app">/);
  const sessionResponse = await fetch(base + '/api/session', { headers: { Origin: base, 'Sec-Fetch-Site': 'same-origin', Accept: 'application/json' } }); const session = await sessionResponse.json(); assert.equal(sessionResponse.status, 200);
  const headers = { Origin: base, 'Sec-Fetch-Site': 'same-origin', Accept: 'application/json', 'Content-Type': 'application/json', 'X-MyPath-Session': session.token };
  const call = async (method, route, body) => { const response = await fetch(base + route, { method, headers, body: body === undefined ? undefined : JSON.stringify(body) }); const value = response.status === 204 ? null : await response.json(); assert.ok(response.ok, `${method} ${route}: ${response.status} ${JSON.stringify(value)}`); return value; };
  const project = await call('POST', '/api/v1/projects', { name: 'Offline acceptance loop' });
  const png = Buffer.from([137, 80, 78, 71, 13, 10, 26, 10, 0, 0, 0, 0]);
  const asset = await call('POST', `/api/v1/projects/${project.id}/assets`, { name: 'offline.png', kind: 'image', base64: png.toString('base64') });
  assert.equal(asset.checksum.length, 64);
  const context = await call('POST', `/api/v1/projects/${project.id}/context-snapshots`, { assets: [{ id: asset.id }] });
  const thread = await call('POST', `/api/v1/projects/${project.id}/chat/threads`, { title: 'Offline run' });
  const run = await call('POST', `/api/v1/projects/${project.id}/chat/threads/${thread.id}/runs`, { prompt: 'Create an offline card', contextSnapshotId: context.id, providerConfigId: 'fixture', deliverables: ['Offline card'] });
  let completed;
  for (let attempt = 0; attempt < 600; attempt++) { completed = await call('GET', `/api/v1/thread-runs/${run.id}`); if (['succeeded', 'partial', 'failed', 'cancelled'].includes(completed.status)) break; await pause(25); }
  assert.equal(completed.status, 'succeeded'); assert.equal(completed.jobs.length, 1); assert.ok(completed.jobs[0].revisionId);
  const preview = await fetch(base + `/api/v1/revisions/${completed.jobs[0].revisionId}/preview`, { headers: { ...headers, 'Content-Type': undefined } }); assert.equal(preview.status, 200); assert.match(await preview.text(), /Offline card/i);
  const canvas = await call('GET', `/api/v1/projects/${project.id}/canvas`); assert.match(JSON.stringify(canvas.snapshot), new RegExp(`frame:${completed.jobs[0].id}`));
  await stop();
  assert.ok(fs.existsSync(path.join(data, 'blobs', asset.checksum.slice(0, 2), asset.checksum)), 'real content-addressed blob persisted');
  console.log('Core offline production HTTP E2E passed: shell → session → project → real blob → context → fixture job → revision preview → canvas → persistence');
} finally { await stop(); fs.rmSync(data, { recursive: true, force: true }); }
