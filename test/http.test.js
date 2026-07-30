import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import fs from 'node:fs';
import http from 'node:http';
import net from 'node:net';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';

async function freePort() {
  return new Promise((resolve) => { const server = net.createServer(); server.listen(0, '127.0.0.1', () => { const port = server.address().port; server.close(() => resolve(port)); }); });
}
async function waitFor(url) {
  for (let i = 0; i < 80; i++) {
    try { const res = await fetch(`${url}/health`); if (res.ok) return; } catch {}
    await new Promise((r) => setTimeout(r, 50));
  }
  throw new Error('server did not start');
}
async function raw(port, host) {
  return new Promise((resolve, reject) => {
    const req = http.request({ hostname: '127.0.0.1', port, path: '/health', headers: { Host: host } }, (res) => {
      const chunks = []; res.on('data', (c) => chunks.push(c)); res.on('end', () => resolve({ status: res.statusCode, body: Buffer.concat(chunks).toString() }));
    }); req.on('error', reject); req.end();
  });
}

let child, base, dataDir, token, port;
test.before(async () => {
  port = await freePort();
  dataDir = fs.mkdtempSync(path.join(os.tmpdir(), 'mypath-http-'));
  child = spawn(process.execPath, ['server/index.js'], { cwd: process.cwd(), env: { ...process.env, MYPATH_API_PORT: String(port), MYPATH_DATA_DIR: dataDir }, stdio: ['ignore', 'pipe', 'pipe'] });
  let errors = ''; child.stderr.on('data', (c) => { errors += c; });
  base = `http://127.0.0.1:${port}`;
  try { await waitFor(base); } catch (error) { throw new Error(`${error.message}: ${errors}`); }
  const session = await fetch(`${base}/api/session`, { headers: { Origin: base, 'Sec-Fetch-Site': 'same-origin' } });
  assert.equal(session.status, 200);
  token = (await session.json()).token;
});
test.after(() => { child?.kill('SIGTERM'); fs.rmSync(dataDir, { recursive: true, force: true }); });

const authenticated = (extra = {}) => ({ 'X-MyPath-Session': token, Origin: base, 'Sec-Fetch-Site': 'same-origin', ...extra });

test('session bootstrap is same-origin and API rejects tokenless/cross-site requests', async () => {
  let response = await fetch(`${base}/projects`, { headers: { Accept: 'application/json' } });
  assert.equal(response.status, 401);
  assert.equal((await response.json()).error.code, 'session_required');

  response = await fetch(`${base}/api/session`, { headers: { Origin: 'http://evil.example', 'Sec-Fetch-Site': 'cross-site' } });
  assert.equal(response.status, 403);
  assert.equal((await response.json()).error.code, 'origin_rejected');

  response = await fetch(`${base}/projects`, { headers: authenticated({ Origin: 'http://evil.example' }) });
  assert.equal(response.status, 403);
  assert.equal((await response.json()).error.code, 'origin_rejected');

  const host = await raw(port, 'evil.example');
  assert.equal(host.status, 403);
  assert.equal(JSON.parse(host.body).error.code, 'host_rejected');
});

test('body limits and invalid JSON return structured errors', async () => {
  let response = await fetch(`${base}/projects`, { method: 'POST', headers: authenticated({ 'Content-Type': 'application/json' }), body: '{bad' });
  assert.equal(response.status, 400);
  assert.equal((await response.json()).error.code, 'invalid_json');

  response = await fetch(`${base}/projects`, { method: 'POST', headers: authenticated({ 'Content-Type': 'application/json' }), body: JSON.stringify({ name: 'x'.repeat(1024 * 1024) }) });
  assert.equal(response.status, 413);
  const error = (await response.json()).error;
  assert.equal(error.code, 'body_too_large');
  assert.equal(error.details.limit, 1024 * 1024);

  const thread = await fetch(`${base}/users/me/chat-threads`, { method: 'POST', headers: authenticated({ 'Content-Type': 'application/json' }), body: JSON.stringify({ title: 'Limits' }) }).then((r) => r.json());
  response = await fetch(`${base}/users/me/chat-threads/${thread.id}/messages`, { method: 'POST', headers: authenticated({ 'Content-Type': 'application/json' }), body: JSON.stringify({ content: 'x'.repeat(256 * 1024) }) });
  assert.equal(response.status, 413);
  assert.equal((await response.json()).error.details.limit, 256 * 1024);
});

test('authenticated compatibility CRUD remains functional under concurrent requests', async () => {
  const creates = await Promise.all(Array.from({ length: 20 }, (_, i) => fetch(`${base}/projects`, {
    method: 'POST', headers: authenticated({ 'Content-Type': 'application/json' }), body: JSON.stringify({ name: `Concurrent ${i}` }),
  })));
  assert.ok(creates.every((response) => response.status === 201));
  const projects = await fetch(`${base}/api/v1/projects`, { headers: authenticated() }).then((response) => response.json());
  assert.equal(projects.length, 20);
  const id = projects[0].id;
  const updated = await fetch(`${base}/projects/${id}`, { method: 'PATCH', headers: authenticated({ 'Content-Type': 'application/json' }), body: JSON.stringify({ description: 'updated' }) });
  assert.equal(updated.status, 200);
  assert.equal((await updated.json()).description, 'updated');
  const removed = await fetch(`${base}/projects/${id}`, { method: 'DELETE', headers: authenticated() });
  assert.equal(removed.status, 204);
});

test('generated-source policy rejects dangerous imports before persistence', async () => {
  const project = await fetch(`${base}/projects`, { method: 'POST', headers: authenticated({ 'Content-Type': 'application/json' }), body: JSON.stringify({ name: 'Source policy' }) }).then((r) => r.json());
  const generated = await fetch(`${base}/projects/${project.id}/components`, { method: 'POST', headers: authenticated({ 'Content-Type': 'application/json' }), body: JSON.stringify({ name: 'SafeCard' }) }).then((r) => r.json());
  const response = await fetch(`${base}/components/${generated.component.id}`, {
    method: 'PATCH', headers: authenticated({ 'Content-Type': 'application/json' }),
    body: JSON.stringify({ code: "import fs from 'node:fs'; export default fs", files: { 'src/App.tsx': "import fs from 'node:fs'; export default fs" } }),
  });
  assert.equal(response.status, 422);
  assert.equal((await response.json()).error.code, 'generated_source_invalid');
  const revisions = await fetch(`${base}/components/${generated.component.id}/revisions`, { headers: authenticated() }).then((r) => r.json());
  assert.equal(revisions.length, 1);
});

test('forge traversal submitted through compatibility API rolls back', async () => {
  const project = await fetch(`${base}/projects`, { method: 'POST', headers: authenticated({ 'Content-Type': 'application/json' }), body: JSON.stringify({ name: 'Forge' }) }).then((r) => r.json());
  const generated = await fetch(`${base}/projects/${project.id}/components`, { method: 'POST', headers: authenticated({ 'Content-Type': 'application/json' }), body: JSON.stringify({ name: 'Card' }) }).then((r) => r.json());
  const response = await fetch(`${base}/components/${generated.component.id}`, {
    method: 'PATCH', headers: authenticated({ 'Content-Type': 'application/json' }), body: JSON.stringify({ code: 'changed', files: { '../escape': 'bad' } }),
  });
  assert.equal(response.status, 422);
  assert.equal((await response.json()).error.code, 'forge_path_invalid');
  const component = await fetch(`${base}/components/${generated.component.id}`, { headers: authenticated() }).then((r) => r.json());
  assert.notEqual(component.code, 'changed');
  assert.equal(fs.existsSync(path.join(dataDir, 'escape')), false);
});
