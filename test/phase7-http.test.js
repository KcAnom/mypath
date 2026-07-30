import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import fs from 'node:fs';
import net from 'node:net';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';

const freePort = () => new Promise((resolve) => { const server = net.createServer(); server.listen(0, '127.0.0.1', () => { const port = server.address().port; server.close(() => resolve(port)); }); });
async function waitFor(url) { for (let index = 0; index < 100; index++) { try { if ((await fetch(`${url}/health`)).ok) return; } catch {} await new Promise((resolve) => setTimeout(resolve, 50)); } throw new Error('server did not start'); }
let child, root, base, sessionToken, project;
test.before(async () => { root = fs.mkdtempSync(path.join(os.tmpdir(), 'mypath-phase7-http-')); const port = await freePort(); base = `http://127.0.0.1:${port}`; child = spawn(process.execPath, ['server/index.js'], { cwd: process.cwd(), env: { ...process.env, MYPATH_API_PORT: String(port), MYPATH_DATA_DIR: root }, stdio: ['ignore', 'pipe', 'pipe'] }); let stderr = ''; child.stderr.on('data', (chunk) => { stderr += chunk; }); try { await waitFor(base); } catch (error) { throw new Error(`${error.message}: ${stderr}`); } sessionToken = (await fetch(`${base}/api/v1/session`, { headers: { Origin: base, 'Sec-Fetch-Site': 'same-origin' } }).then((response) => response.json())).token; project = (await desktop('POST', '/api/v1/projects', { name: 'Phase 7 HTTP' })).value; });
test.after(() => { child?.kill('SIGTERM'); fs.rmSync(root, { recursive: true, force: true }); });
const desktop = async (method, route, body) => { const response = await fetch(`${base}${route}`, { method, headers: { Origin: base, 'Sec-Fetch-Site': 'same-origin', 'X-MyPath-Session': sessionToken, Accept: 'application/json', 'Content-Type': 'application/json' }, ...(body === undefined ? {} : { body: JSON.stringify(body) }) }); const value = response.status === 204 ? null : await response.json(); return { response, value }; };

// acceptance selector: web-import-convert
test('web import UI exposes safe import, rights review, conversion, and one-time capture', async () => {
  const shell = await fetch(`${base}/projects/${project.id}/web-import`, { headers: { Accept: 'text/html', 'Sec-Fetch-Mode': 'navigate', 'Sec-Fetch-Site': 'none' } }); assert.equal(shell.status, 200);
  const source = fs.readFileSync('web/src/components/WebImportPanel.tsx', 'utf8'); assert.match(source, /Safe full-page import/); assert.match(source, /right to use/i); assert.match(source, /Convert into runnable design/); assert.match(source, /Create one-time ticket/);
});

// acceptance selector: web-import-ssrf-sanitize
test('web import HTTP rejects SSRF before fetching and returns durable diagnostics policy', async () => {
  const result = await desktop('POST', `/api/v1/projects/${project.id}/imports/web`, { url: 'https://127.0.0.1/private' }); assert.equal(result.response.status, 422); assert.equal(result.value.error.code, 'fetch_ssrf_rejected');
});

// acceptance selector: capture-ticket, surgical-capture
test('capture ticket HTTP submission is narrowly CORS-scoped, origin-bound and single-use', async () => {
  const issued = await desktop('POST', `/api/v1/projects/${project.id}/capture-tickets`, { origin: 'https://example.com', ttlSeconds: 60 }); assert.equal(issued.response.status, 201); const waiting = await desktop('GET', `/api/v1/projects/${project.id}/capture-tickets`); assert.equal(waiting.response.status, 200); assert.equal(waiting.value[0].state, 'waiting');
  const extensionOrigin = `chrome-extension://${'a'.repeat(32)}`; let response = await fetch(`${base}/api/v1/capture-tickets/${encodeURIComponent(issued.value.id)}/submission`, { method: 'OPTIONS', headers: { Origin: extensionOrigin, 'Access-Control-Request-Method': 'POST', 'Access-Control-Request-Headers': 'authorization,content-type' } }); assert.equal(response.status, 204); assert.equal(response.headers.get('access-control-allow-origin'), extensionOrigin);
  response = await fetch(`${base}/api/v1/capture-tickets/${encodeURIComponent(issued.value.id)}/submission`, { method: 'POST', headers: { Origin: extensionOrigin, Authorization: `Bearer ${issued.value.token}`, 'Content-Type': 'application/json', Accept: 'application/json' }, body: JSON.stringify({ pageUrl: 'https://example.com/path', html: '<article onclick="bad()"><h2>Selected</h2></article>', computedStyles: { color: 'red', position: 'fixed' } }) }); assert.equal(response.status, 201); assert.equal(response.headers.get('access-control-allow-origin'), extensionOrigin); const capture = await response.json(); assert.doesNotMatch(capture.sanitizedHtml, /onclick/i); const received = await desktop('GET', `/api/v1/projects/${project.id}/capture-tickets`); assert.equal(received.value[0].state, 'received'); assert.equal(received.value[0].captureId, capture.id);
  response = await fetch(`${base}/api/v1/capture-tickets/${encodeURIComponent(issued.value.id)}/submission`, { method: 'POST', headers: { Origin: extensionOrigin, Authorization: `Bearer ${issued.value.token}`, 'Content-Type': 'application/json' }, body: JSON.stringify({ pageUrl: 'https://example.com/path', html: '<p>again</p>' }) }); assert.equal(response.status, 409); assert.equal((await response.json()).error.code, 'capture_ticket_consumed');
  response = await fetch(`${base}/api/v1/projects`, { headers: { Origin: extensionOrigin, 'X-MyPath-Session': sessionToken, Accept: 'application/json' } }); assert.equal(response.status, 403, 'extension CORS exception does not widen other API routes');
});
