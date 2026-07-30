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
test.before(async () => { root = fs.mkdtempSync(path.join(os.tmpdir(), 'mypath-phase5-http-')); const port = await freePort(); base = `http://127.0.0.1:${port}`; child = spawn(process.execPath, ['server/index.js'], { cwd: process.cwd(), env: { ...process.env, MYPATH_API_PORT: String(port), MYPATH_DATA_DIR: root }, stdio: ['ignore', 'pipe', 'pipe'] }); let stderr = ''; child.stderr.on('data', (chunk) => { stderr += chunk; }); try { await waitFor(base); } catch (error) { throw new Error(`${error.message}: ${stderr}`); } token = (await fetch(`${base}/api/v1/session`, { headers: { Origin: base, 'Sec-Fetch-Site': 'same-origin' } }).then((response) => response.json())).token; });
test.after(() => { child?.kill('SIGTERM'); fs.rmSync(root, { recursive: true, force: true }); });
const headers = () => ({ Origin: base, 'Sec-Fetch-Site': 'same-origin', 'X-MyPath-Session': token, Accept: 'application/json', 'Content-Type': 'application/json' });
const request = async (method, pathname, body) => { const response = await fetch(`${base}${pathname}`, { method, headers: headers(), ...(body === undefined ? {} : { body: JSON.stringify(body) }) }); const value = response.status === 204 ? null : await response.json(); return { response, value }; };

test('Phase 5 APIs activate reviewed exact context, local fonts, and imported skills', async () => {
  const project = (await request('POST', '/api/v1/projects', { name: 'Operational API' })).value;
  const designResult = await request('POST', '/api/v1/design-systems', { name: 'API design', light: { '--background': '#fff' }, dark: { '--background': '#000' }, markdown: '# API design' }); assert.equal(designResult.response.status, 201); const versionId = designResult.value.currentVersion.id;
  assert.equal((await request('PUT', `/api/v1/projects/${project.id}/design-system`, { versionId })).response.status, 200);
  const fontBytes = Buffer.concat([Buffer.from('wOF2'), Buffer.alloc(28, 9)]); const uploaded = await request('POST', `/api/v1/projects/${project.id}/assets`, { name: 'Local.woff2', kind: 'font', dataUrl: `data:font/woff2;base64,${fontBytes.toString('base64')}` }); assert.equal(uploaded.response.status, 201);
  const font = await request('POST', '/api/v1/fonts', { assetId: uploaded.value.id, family: 'API Local' }); assert.equal(font.response.status, 201); await request('PUT', `/api/v1/projects/${project.id}/fonts/${encodeURIComponent(font.value.id)}`, { active: true });
  const imported = await request('POST', '/api/v1/users/me/skills/import', { name: 'review.skill', base64: Buffer.from('# Review\nCheck clear labels.').toString('base64') }); assert.equal(imported.response.status, 201); assert.equal(imported.value.boundary.scriptsExecuted, false);
  const context = await request('POST', `/api/v1/projects/${project.id}/context-snapshots`, { skills: [{ skillId: imported.value.skill.id }] }); assert.equal(context.response.status, 201); assert.equal(context.value.activeRefs.designSystemVersionId, versionId); assert.ok(context.value.skillRefs.some((ref) => ref.skillId === imported.value.skill.id && ref.versionId)); assert.ok(context.value.fontRefs.some((ref) => ref.fontId === font.value.id));
  const extraction = await request('POST', '/api/v1/theme-extractions', { css: ':root { --surface: #fff; } [data-theme="dark"] { --surface: #111; }' }); assert.equal(extraction.value.status, 'pending'); const approved = await request('POST', `/api/v1/theme-extractions/${encodeURIComponent(extraction.value.id)}/review`, { approved: true, proposal: { ...extraction.value.proposal, name: 'Reviewed' } }); assert.equal(approved.value.status, 'approved'); assert.ok(approved.value.versionId);
  const operational = await request('GET', `/api/v1/projects/${project.id}/operational-context`); assert.equal(operational.response.status, 200); assert.equal(operational.value.selected.designSystem.versionId, versionId); assert.ok(operational.value.skills.some((skill) => skill.builtin));
  const defaults = await request('PUT', `/api/v1/projects/${project.id}/design-system`, { active: false }); assert.equal(defaults.response.status, 200); assert.equal(defaults.value.versionId, null); const afterDefaults = await request('GET', `/api/v1/projects/${project.id}/operational-context`); assert.equal(afterDefaults.value.selected.designSystem, null);
});
