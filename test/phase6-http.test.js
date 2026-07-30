import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import fs from 'node:fs';
import net from 'node:net';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';

const instanceNonce = 'phase6-native-instance-nonce';
const freePort = () => new Promise((resolve) => { const socket = net.createServer(); socket.listen(0, '127.0.0.1', () => { const port = socket.address().port; socket.close(() => resolve(port)); }); });
async function waitFor(url) { for (let index = 0; index < 100; index++) { try { if ((await fetch(`${url}/health`)).ok) return; } catch {} await new Promise((resolve) => setTimeout(resolve, 50)); } throw new Error('server did not start'); }
let child, root, base, sessionToken;
test.before(async () => { root = fs.mkdtempSync(path.join(os.tmpdir(), 'mypath-phase6-http-')); const port = await freePort(); base = `http://127.0.0.1:${port}`; child = spawn(process.execPath, ['server/index.js'], { cwd: process.cwd(), env: { ...process.env, MYPATH_API_PORT: String(port), MYPATH_DATA_DIR: root, MYPATH_INSTANCE_NONCE: instanceNonce }, stdio: ['ignore', 'pipe', 'pipe'] }); let stderr = ''; child.stderr.on('data', (chunk) => { stderr += chunk; }); try { await waitFor(base); } catch (error) { throw new Error(`${error.message}: ${stderr}`); } sessionToken = (await fetch(`${base}/api/v1/session`, { headers: { Origin: base, 'Sec-Fetch-Site': 'same-origin', 'X-MyPath-Instance': instanceNonce } }).then((response) => response.json())).token; });
test.after(() => { child?.kill('SIGTERM'); fs.rmSync(root, { recursive: true, force: true }); });
const desktopHeaders = () => ({ Origin: base, 'Sec-Fetch-Site': 'same-origin', 'X-MyPath-Session': sessionToken, Accept: 'application/json', 'Content-Type': 'application/json' });
const desktop = async (method, route, body) => { const response = await fetch(`${base}${route}`, { method, headers: desktopHeaders(), ...(body === undefined ? {} : { body: JSON.stringify(body) }) }); const value = response.status === 204 ? null : await response.json(); return { response, value }; };
const agent = async (method, route, token, body) => { const response = await fetch(`${base}${route}`, { method, headers: { Authorization: `Bearer ${token}`, Accept: 'application/json', 'Content-Type': 'application/json' }, ...(body === undefined ? {} : { body: JSON.stringify(body) }) }); const value = await response.json(); return { response, value }; };

// acceptance selectors: external-agent-auth-separation, agent-submit-accept-reject
test('external-agent HTTP auth is path-scoped and bearer tokens cannot self-approve', async () => {
  const project = (await desktop('POST', '/api/v1/projects', { name: 'Agent HTTP' })).value; const generated = (await desktop('POST', `/api/v1/projects/${project.id}/components`, { name: 'AgentCard' })).value; const revisionId = generated.revision.id;
  const issued = (await desktop('POST', '/api/v1/external-agent-grants', { label: 'HTTP agent', projectIds: [project.id], ttlSeconds: 600 })).value; assert.match(issued.token, /^mpa_/);
  let result = await agent('GET', '/api/v1/external-agent/projects', issued.token); assert.equal(result.response.status, 200); assert.equal(result.value[0].id, project.id);
  result = await agent('GET', '/api/v1/projects', issued.token); assert.equal(result.response.status, 401); assert.equal(result.value.error.code, 'session_required');
  const session = (await agent('POST', `/api/v1/external-agent/projects/${project.id}/edit-sessions`, issued.token, { componentId: generated.component.id, baseRevisionId: revisionId })).value; const boundary = (await agent('GET', `/api/v1/external-agent/edit-sessions/${session.id}/forge-boundary`, issued.token)).value; assert.equal(boundary.boundary.scriptsExecuted, false);
  const files = { ...boundary.files, 'src/App.tsx': "export default function App(){return <main>Agent HTTP edit</main>}" }; const submission = (await agent('POST', `/api/v1/external-agent/edit-sessions/${session.id}/submissions`, issued.token, { files })).value; assert.equal(submission.status, 'pending_review');
  result = await agent('POST', `/api/v1/external-agent/submissions/${submission.id}/accept`, issued.token, {}); assert.equal(result.response.status, 403); assert.equal(result.value.error.code, 'agent_self_approval_forbidden');
  const accepted = await desktop('POST', `/api/v1/external-agent/submissions/${submission.id}/accept`, {}); assert.equal(accepted.response.status, 200); assert.equal(accepted.value.status, 'accepted'); assert.ok(accepted.value.revisionId);
});

// acceptance selectors: export-path-grant, ide-unavailable-after-export
test('browser ZIP and native path grant keep successful export independent of IDE launch', async () => {
  const project = (await desktop('POST', '/api/v1/projects', { name: 'Export HTTP' })).value; const generated = (await desktop('POST', `/api/v1/projects/${project.id}/components`, { name: 'ExportCard' })).value; const revisionId = generated.revision.id;
  let response = await fetch(`${base}/api/v1/revisions/${revisionId}/export.zip`, { headers: desktopHeaders() }); assert.equal(response.status, 200); assert.equal(response.headers.get('content-type'), 'application/zip'); assert.match(response.headers.get('content-disposition'), /attachment/); assert.ok((await response.arrayBuffer()).byteLength > 1000);
  const destination = fs.mkdtempSync(path.join(os.tmpdir(), 'mypath-phase6-http-destination-')); try {
    let invalid = await desktop('POST', '/api/v1/native/export-destination-grants', { canonicalPath: destination }); assert.equal(invalid.response.status, 403); assert.equal(invalid.value.error.code, 'instance_nonce_rejected');
    response = await fetch(`${base}/api/v1/native/export-destination-grants`, { method: 'POST', headers: { 'X-MyPath-Instance': instanceNonce, Accept: 'application/json', 'Content-Type': 'application/json' }, body: JSON.stringify({ canonicalPath: destination }) }); assert.equal(response.status, 201); const grant = await response.json();
    const exported = await desktop('POST', `/api/v1/revisions/${revisionId}/export-directory`, { destinationGrantId: grant.id }); assert.equal(exported.response.status, 201); assert.equal(fs.existsSync(path.join(exported.value.exportedPath, 'package.json')), true); assert.equal(typeof exported.value.archiveChecksum, 'string');
  } finally { fs.rmSync(destination, { recursive: true, force: true }); }
});
