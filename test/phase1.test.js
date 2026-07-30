import assert from 'node:assert/strict';
import { spawn, spawnSync } from 'node:child_process';
import fs from 'node:fs';
import net from 'node:net';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';
import { DatabaseSync } from 'node:sqlite';

async function freePort() { return new Promise((resolve) => { const socket = net.createServer(); socket.listen(0, '127.0.0.1', () => { const port = socket.address().port; socket.close(() => resolve(port)); }); }); }
async function wait(base) { for (let attempt = 0; attempt < 100; attempt++) { try { if ((await fetch(`${base}/health`)).ok) return; } catch {} await new Promise((resolve) => setTimeout(resolve, 50)); } throw new Error('server did not start'); }
let child, dataDir, base, headers;
const request = async (method, pathname, body, extra = {}) => fetch(`${base}${pathname}`, { method, headers: { ...headers, ...(body === undefined ? {} : { 'Content-Type': 'application/json' }), ...extra }, body: body === undefined ? undefined : JSON.stringify(body) });

test.before(async () => {
  const port = await freePort(); dataDir = fs.mkdtempSync(path.join(os.tmpdir(), 'mypath-phase1-')); base = `http://127.0.0.1:${port}`;
  child = spawn(process.execPath, ['server/index.js'], { cwd: process.cwd(), env: { ...process.env, MYPATH_API_PORT: String(port), MYPATH_DATA_DIR: dataDir, MYPATH_BUILD_TEST_DELAY_MS: '350' }, stdio: ['ignore', 'pipe', 'pipe'] });
  let errors = ''; child.stderr.on('data', (chunk) => { errors += chunk; });
  try { await wait(base); } catch (error) { throw new Error(`${error.message}\n${errors}`); }
  const session = await fetch(`${base}/api/v1/session`, { headers: { Origin: base, 'Sec-Fetch-Site': 'same-origin' } }).then((response) => response.json());
  headers = { Origin: base, 'Sec-Fetch-Site': 'same-origin', Accept: 'application/json', 'X-MyPath-Session': session.token };
});
test.after(() => { child?.kill('SIGTERM'); fs.rmSync(dataDir, { recursive: true, force: true }); });

async function component() {
  const project = await request('POST', '/api/v1/projects', { name: 'Runtime' }).then((response) => response.json());
  const generatedResponse = await request('POST', `/api/v1/projects/${project.id}/components`, { name: 'Counter' });
  const generatedBody = await generatedResponse.json();
  assert.equal(generatedResponse.status, 201, JSON.stringify(generatedBody));
  return generatedBody.component;
}

test('successful candidate produces an immutable runnable React artifact', async () => {
  const current = await component();
  const source = `import { useEffect, useState } from 'react'; export default function App(){ const [count,setCount]=useState(0); useEffect(()=>{ document.querySelector('button')?.click() },[]); return <button onClick={()=>setCount(count+1)}>Count {count}</button> }`;
  const response = await request('POST', `/api/v1/components/${current.id}/candidates`, { files: { 'src/App.tsx': source, 'src/index.css': 'button{padding:12px}' }, expectedBaseRevisionId: current.selectedRevisionId });
  const result = await response.json();
  assert.equal(response.status, 201, JSON.stringify(result));
  assert.equal(result.build.status, 'succeeded');
  assert.equal(result.candidate.status, 'promoted');
  const preview = await request('GET', `/api/v1/revisions/${result.build.revision_id}/preview`);
  assert.equal(preview.status, 200);
  const html = await preview.text();
  assert.match(html, /Count/);
  assert.match(html, /onClick|onclick|click/);
  assert.match(html, /Content-Security-Policy/);
  assert.match(html, /connect-src 'none'/);
  assert.doesNotMatch(html, /<(?:script|link)[^>]+(?:src|href)=["']https?:\/\//);
  const artifactPath = path.join(dataDir, 'artifacts', `${result.build.artifact_hash}.html`);
  assert.ok(fs.existsSync(artifactPath));
  assert.equal(fs.statSync(artifactPath).mode & 0o222, 0);
  const maximumScreenshot = Buffer.alloc(1024 * 1024).toString('base64');
  const screenshot = await request('POST', `/api/v1/revisions/${result.build.revision_id}/screenshots`, { width: 1, height: 1, dataUrl: `data:image/png;base64,${maximumScreenshot}` });
  assert.equal(screenshot.status, 201, await screenshot.text());
  assert.equal(fs.readdirSync(path.join(dataDir, 'screenshots')).length, 1);
  const chrome = [process.env.MYPATH_BROWSER_BIN, '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome', '/usr/bin/google-chrome', '/usr/bin/chromium'].filter(Boolean).find((candidate) => fs.existsSync(candidate));
  assert.ok(chrome, 'Runnable preview verification requires Chrome/Chromium; set MYPATH_BROWSER_BIN to the browser executable');
  const rendered = spawnSync(chrome, ['--headless', '--disable-gpu', '--no-sandbox', '--virtual-time-budget=1000', '--dump-dom', `file://${artifactPath}`], { encoding: 'utf8', timeout: 20_000 });
  assert.equal(rendered.status, 0, rendered.stderr);
  assert.match(rendered.stdout, /<button>Count 1<\/button>/, 'React mounted and its click handler changed state');
});

test('invalid candidate preserves diagnostics and never promotes a revision', async () => {
  const current = await component();
  const before = await request('GET', `/api/v1/components/${current.id}/revisions`).then((response) => response.json());
  const response = await request('POST', `/api/v1/components/${current.id}/candidates`, { files: { 'src/App.tsx': "import fs from 'node:fs'; export default fs" } });
  assert.equal(response.status, 422);
  const failure = await response.json();
  const result = failure.error.details;
  assert.equal(result.build.status, 'failed');
  assert.equal(result.candidate.status, 'failed');
  assert.equal(result.build.revision_id, null);
  assert.equal(result.build.diagnostics[0].code, 'generated_source_invalid');
  const after = await request('GET', `/api/v1/components/${current.id}/revisions`).then((response) => response.json());
  assert.equal(after.length, before.length);
  const db = new DatabaseSync(path.join(dataDir, 'db.sqlite'), { readOnly: true });
  assert.equal(db.prepare('SELECT count(*) count FROM candidate_files WHERE candidate_id=?').get(result.candidate.id).count, 1);
  db.close();
});

test('comment-obfuscated absolute imports cannot exfiltrate local files', async () => {
  const current = await component();
  const secretPath = path.join(dataDir, 'local-secret.js');
  fs.writeFileSync(secretPath, "export default 'EXFILTRATED_SECRET'");
  const source = `import/**/ secret from ${JSON.stringify(secretPath)}; export default function App(){ return <div>{secret}</div> }`;
  const response = await request('POST', `/api/v1/components/${current.id}/candidates`, { files: { 'src/App.tsx': source } });
  assert.equal(response.status, 422);
  const failure = await response.json();
  assert.equal(failure.error.code, 'generated_source_invalid');
  assert.match(failure.error.details.build.diagnostics[0].message, /Absolute import is not allowed/);
  assert.equal(fs.readdirSync(path.join(dataDir, 'artifacts')).some((name) => fs.readFileSync(path.join(dataDir, 'artifacts', name), 'utf8').includes('EXFILTRATED_SECRET')), false);
});

test('health remains responsive while asynchronous worker build is running', async () => {
  const current = await component();
  const queued = await request('POST', `/api/v1/components/${current.id}/candidates`, { defer: true, files: { 'src/App.tsx': 'export default function App(){return <button>Async</button>}' } }).then((response) => response.json());
  const runPromise = request('POST', `/api/v1/builds/${queued.build.id}/run`, {});
  for (let attempt = 0; attempt < 50; attempt++) {
    const build = await request('GET', `/api/v1/builds/${queued.build.id}`).then((response) => response.json());
    if (build.status === 'building') break;
    await new Promise((resolve) => setTimeout(resolve, 10));
  }
  const started = performance.now();
  const health = await fetch(`${base}/health`);
  const elapsed = performance.now() - started;
  assert.equal(health.status, 200);
  assert.ok(elapsed < 250, `health was blocked for ${elapsed.toFixed(1)}ms`);
  assert.equal((await runPromise).status, 200);
});

test('historical imported revision rebuild is lazy and does not change selection', async () => {
  const current = await component();
  const db = new DatabaseSync(path.join(dataDir, 'db.sqlite'));
  const state = JSON.parse(db.prepare('SELECT data_json FROM components WHERE id=?').get(current.id).data_json);
  const historicalId = 'historical-' + Date.now();
  const revision = { id: historicalId, componentId: current.id, status: 'imported_unbuilt', files: { 'src/App.tsx': 'export default function App(){return <button>Historical</button>}' }, code: 'historical', createdAt: new Date().toISOString() };
  db.prepare('INSERT INTO revisions(id,component_id,status,created_at,ordinal,data_json) VALUES(?,?,?,?,?,?)').run(historicalId, current.id, 'imported_unbuilt', revision.createdAt, 999, JSON.stringify(revision));
  db.prepare('INSERT INTO revision_files(revision_id,path,content,content_checksum) VALUES(?,?,?,?)').run(historicalId, 'src/App.tsx', revision.files['src/App.tsx'], 'fixture');
  db.close();
  const preview = await request('GET', `/api/v1/revisions/${historicalId}/preview`);
  const previewHtml = await preview.text();
  assert.equal(preview.status, 200, previewHtml);
  assert.match(previewHtml, /Historical/);
  const selected = await request('GET', `/api/v1/components/${current.id}`).then((response) => response.json());
  assert.equal(selected.selectedRevisionId, state.selectedRevisionId);
});

test('failed lazy historical builds are deduplicated until explicit retry', async () => {
  const current = await component();
  const historicalId = 'failed-historical-' + Date.now();
  const revision = { id: historicalId, componentId: current.id, status: 'imported_unbuilt', files: { 'src/App.tsx': "import fs from 'node:fs'; export default fs" }, code: 'invalid', createdAt: new Date().toISOString() };
  const db = new DatabaseSync(path.join(dataDir, 'db.sqlite'));
  db.prepare('INSERT INTO revisions(id,component_id,status,created_at,ordinal,data_json) VALUES(?,?,?,?,?,?)').run(historicalId, current.id, 'imported_unbuilt', revision.createdAt, 1000, JSON.stringify(revision));
  db.prepare('INSERT INTO revision_files(revision_id,path,content,content_checksum) VALUES(?,?,?,?)').run(historicalId, 'src/App.tsx', revision.files['src/App.tsx'], 'invalid-fixture');
  db.close();
  let response = await request('GET', `/api/v1/revisions/${historicalId}/preview`);
  assert.equal(response.status, 422);
  response = await request('GET', `/api/v1/revisions/${historicalId}/preview`);
  assert.equal(response.status, 422);
  let check = new DatabaseSync(path.join(dataDir, 'db.sqlite'), { readOnly: true });
  assert.equal(check.prepare('SELECT count(*) count FROM builds WHERE revision_id=?').get(historicalId).count, 1);
  check.close();
  response = await request('POST', `/api/v1/revisions/${historicalId}/retry-build`, {});
  assert.equal(response.status, 422);
  check = new DatabaseSync(path.join(dataDir, 'db.sqlite'), { readOnly: true });
  assert.equal(check.prepare('SELECT count(*) count FROM builds WHERE revision_id=?').get(historicalId).count, 2);
  check.close();
});

test('build event stream requires auth and resumes queued through terminal with durable IDs', async () => {
  const current = await component();
  const queued = await request('POST', `/api/v1/components/${current.id}/candidates`, { defer: true, files: { 'src/App.tsx': 'export default function App(){return <button>Stream</button>}' } }).then((response) => response.json());
  let response = await fetch(`${base}/api/v1/builds/${queued.build.id}/events`, { headers: { Accept: 'text/event-stream', Origin: base, 'Sec-Fetch-Site': 'same-origin' } });
  assert.equal(response.status, 401);

  const controller = new AbortController();
  response = await fetch(`${base}/api/v1/builds/${queued.build.id}/events`, { headers: { ...headers, Accept: 'text/event-stream' }, signal: controller.signal });
  const reader = response.body.getReader();
  const initial = new TextDecoder().decode((await reader.read()).value);
  const firstId = Number(initial.match(/id: (\d+)/)?.[1]);
  assert.match(initial, /event: queued/); assert.ok(firstId > 0);
  controller.abort();

  const resumedPromise = fetch(`${base}/api/v1/builds/${queued.build.id}/events`, { headers: { ...headers, Accept: 'text/event-stream', 'Last-Event-ID': String(firstId) } }).then((stream) => stream.text());
  const run = await request('POST', `/api/v1/builds/${queued.build.id}/run`, {});
  assert.equal(run.status, 200);
  const resumed = await resumedPromise;
  assert.match(resumed, /event: building/);
  assert.match(resumed, /event: succeeded/);
  const ids = [...resumed.matchAll(/id: (\d+)/g)].map((match) => Number(match[1]));
  assert.ok(ids.length >= 2);
  assert.ok(ids.every((value) => value > firstId));
  assert.equal(new Set(ids).size, ids.length);
});
