import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import fs from 'node:fs';
import net from 'node:net';
import os from 'node:os';
import path from 'node:path';
import { Store } from '../server/store.js';

const port = await new Promise((resolve) => { const socket = net.createServer(); socket.listen(0, '127.0.0.1', () => { const value = /** @type {import('node:net').AddressInfo} */ (socket.address()).port; socket.close(() => resolve(value)); }); });
const dataDir = fs.mkdtempSync(path.join(os.tmpdir(), 'mypath-prod-http-'));
const base = `http://127.0.0.1:${port}`;
const child = spawn(process.execPath, ['server/index.js'], { env: { ...process.env, MYPATH_API_PORT: String(port), MYPATH_DATA_DIR: dataDir }, stdio: ['ignore', 'pipe', 'pipe'] });
let stderr = ''; child.stderr.on('data', (chunk) => { stderr += chunk; });
async function stop() {
  if (child.exitCode == null) {
    child.kill('SIGTERM');
    await new Promise((resolve) => child.once('exit', resolve));
  }
}
async function request(route, options = {}) {
  const response = await fetch(base + route, options);
  const type = response.headers.get('content-type') || '';
  const data = response.status === 204 ? null : (type.includes('json') ? await response.json() : await response.text());
  return { response, data };
}
try {
  for (let attempt = 0; attempt < 80; attempt++) {
    try { if ((await fetch(`${base}/health`)).ok) break; } catch {}
    if (attempt === 79) throw new Error(`Production server did not start: ${stderr}`);
    await new Promise((resolve) => setTimeout(resolve, 50));
  }
  const document = await request('/', { headers: { Accept: 'text/html', 'Sec-Fetch-Mode': 'navigate', 'Sec-Fetch-Site': 'none' } });
  assert.equal(document.response.status, 200); assert.match(document.data, /<div id="app">/); assert.doesNotMatch(document.data, /fonts\.googleapis/);
  const clientPath = String(document.data).match(/<script[^>]+src="([^"]+)"/)?.[1];
  assert.ok(clientPath, 'Vite client entry is linked from the production document');
  const client = await request(clientPath);
  assert.equal(client.response.status, 200); assert.match(client.data, /X-MyPath-Session/); assert.match(client.data, /mypath-preview/);

  const session = await request('/api/session', { headers: { Origin: base, 'Sec-Fetch-Site': 'same-origin' } });
  assert.equal(session.response.status, 200);
  const headers = { Origin: base, 'Sec-Fetch-Site': 'same-origin', 'X-MyPath-Session': session.data.token, Accept: 'application/json' };
  const jsonHeaders = { ...headers, 'Content-Type': 'application/json' };
  const create = await request('/api/v1/projects', { method: 'POST', headers: jsonHeaders, body: JSON.stringify({ name: 'Production CRUD' }) });
  assert.equal(create.response.status, 201); const project = create.data;
  const canvas = await request(`/api/v1/projects/${project.id}/canvas`, { headers }); assert.equal(canvas.response.status, 200);
  const generated = await request(`/api/v1/projects/${project.id}/components`, { method: 'POST', headers: jsonHeaders, body: JSON.stringify({ name: 'ProductionCard' }) });
  assert.equal(generated.response.status, 201); const component = generated.data.component; const originalRevision = generated.data.revision;
  const edit = await request(`/api/v1/components/${component.id}`, { method: 'PATCH', headers: jsonHeaders, body: JSON.stringify({ code: 'export default function ProductionCard(){ return <div>Edited</div> }', note: 'production verification' }) });
  assert.equal(edit.response.status, 200); const editedRevisionId = edit.data.selectedRevisionId;
  const revisions = await request(`/api/v1/components/${component.id}/revisions`, { headers }); assert.equal(revisions.data.length, 2);

  const design = await request('/api/v1/design-systems', { method: 'POST', headers: jsonHeaders, body: JSON.stringify({ name: 'Production DS' }) }); assert.equal(design.response.status, 201);
  const skill = await request('/api/v1/users/me/skills', { method: 'POST', headers: jsonHeaders, body: JSON.stringify({ name: 'Production Skill', content: 'safe text' }) }); assert.equal(skill.response.status, 201);
  const library = await request('/api/v1/libraries', { method: 'POST', headers: jsonHeaders, body: JSON.stringify({ name: 'Production Library', componentIds: [component.id] }) }); assert.equal(library.response.status, 201);
  const thread = await request('/api/v1/users/me/chat-threads', { method: 'POST', headers: jsonHeaders, body: JSON.stringify({ title: 'Production Thread' }) }); assert.equal(thread.response.status, 201);
  const message = await request(`/api/v1/users/me/chat-threads/${thread.data.id}/messages`, { method: 'POST', headers: jsonHeaders, body: JSON.stringify({ content: 'hello' }) }); assert.equal(message.response.status, 201);

  const deleted = await request(`/api/v1/components/${component.id}`, { method: 'DELETE', headers }); assert.equal(deleted.response.status, 204);
  assert.equal((await request(`/api/v1/components/${component.id}`, { headers })).response.status, 404);
  assert.equal((await request(`/api/v1/components/${component.id}/revision/${originalRevision.id}/code`, { headers })).response.status, 200);
  assert.equal((await request(`/api/v1/components/${component.id}/revision/${editedRevisionId}/code`, { headers })).response.status, 200);
  await stop();

  const persisted = new Store(dataDir);
  assert.equal(persisted.get().projects.filter((item) => !item.deletedAt).length, 1);
  assert.equal(persisted.get().components.filter((item) => item.deletedAt).length, 1);
  assert.equal(persisted.get().revisions.length, 2);
  assert.equal(persisted.database.db.prepare("SELECT count(*) count FROM tombstones WHERE entity_type='component'").get().count, 1);
  persisted.close();
  console.log('Production HTTP/UI verification passed: shell/session/canonical CRUD/history/persistence');
} finally {
  await stop();
  fs.rmSync(dataDir, { recursive: true, force: true });
}
