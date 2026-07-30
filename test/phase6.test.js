import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';
import { Store } from '../server/store.js';
import { AssetService } from '../server/src/assets/asset-service.js';
import { CandidateService } from '../server/src/build/candidate-service.js';
import { CanvasService } from '../server/src/canvas/canvas-service.js';
import { ContextService } from '../server/src/context/context-service.js';
import { ExportService } from '../server/src/export/export-service.js';
import { ExternalAgentService } from '../server/src/external-agents/external-agent-service.js';

async function fixture() {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'mypath-phase6-')); const store = new Store(root);
  store.with((state) => { state.projects.push({ id: 'p1', name: 'Phase Six', createdAt: new Date().toISOString() }); state.canvases.push({ id: 'canvas1', projectId: 'p1', shapes: [], camera: {} }); state.components.push({ id: 'c1', projectId: 'p1', name: 'Runnable Card', generatedName: 'runnable-card', files: {}, selectedRevisionId: null, createdAt: new Date().toISOString() }); });
  const assets = new AssetService(store.database, root); const candidates = new CandidateService(store); const canvases = new CanvasService(store.database); const contexts = new ContextService(store.database, canvases); const exportsService = new ExportService(store, assets); const agents = new ExternalAgentService(store, candidates, contexts);
  const queued = candidates.create({ componentId: 'c1', files: { 'src/App.tsx': "export default function App(){return <main className='p-6'>Exported</main>}", 'src/index.css': ':root { color-scheme: dark; }' } }); const build = await candidates.run(queued.buildId);
  return { root, store, candidates, exportsService, agents, revisionId: build.revision_id };
}
function cleanup(value) { value.store.close(); fs.rmSync(value.root, { recursive: true, force: true }); }
function bearer(token) { return { headers: { authorization: `Bearer ${token}` } }; }

// acceptance selector: clean-export-build
test('clean export build is deterministic, runnable, context-complete, and immutably manifested', async () => {
  const value = await fixture(); const extracted = fs.mkdtempSync(path.join(os.tmpdir(), 'mypath-export-build-')); try {
    const first = value.exportsService.packageFor(value.revisionId); const second = value.exportsService.packageFor(value.revisionId); assert.equal(first.archiveChecksum, second.archiveChecksum); assert.deepEqual(first.zip, second.zip); assert.ok(first.manifest.dependencies.react); assert.ok(first.entries.some((entry) => entry.path === 'package-lock.json')); assert.ok(first.entries.some((entry) => entry.path === 'mypath/context.json')); assert.ok(first.entries.some((entry) => entry.path === 'README.md'));
    const archive = path.join(extracted, 'export.zip'); fs.writeFileSync(archive, first.zip); const unzip = spawnSync('unzip', ['-q', archive, '-d', extracted], { encoding: 'utf8' }); assert.equal(unzip.status, 0, unzip.stderr);
    // Install from the exact exported lockfile into an empty tree, with network disabled,
    // then build using only the exported project.
    const installed = spawnSync('npm', ['ci', '--offline', '--ignore-scripts', '--no-audit', '--no-fund'], { cwd: extracted, encoding: 'utf8', timeout: 120_000 }); assert.equal(installed.status, 0, installed.stderr || installed.stdout); const built = spawnSync('npm', ['run', 'build'], { cwd: extracted, encoding: 'utf8', timeout: 120_000 }); assert.equal(built.status, 0, built.stderr || built.stdout); assert.equal(fs.existsSync(path.join(extracted, 'dist/index.html')), true);
    const row = value.store.database.db.prepare('SELECT * FROM export_manifests WHERE revision_id=?').get(value.revisionId); assert.equal(row.archive_checksum, first.archiveChecksum); assert.throws(() => value.store.database.db.prepare("UPDATE export_manifests SET archive_checksum='changed' WHERE id=?").run(row.id), /immutable/);
  } finally { fs.rmSync(extracted, { recursive: true, force: true }); cleanup(value); }
});

// acceptance selector: export-path-grant
test('export path grants are canonical, short-lived, single-use, and contained', async () => {
  const value = await fixture(); const destination = fs.mkdtempSync(path.join(os.tmpdir(), 'mypath-export-destination-')); try {
    assert.throws(() => value.exportsService.createDestinationGrant(path.join(destination, 'missing')), (error) => error.code === 'export_destination_invalid');
    const grant = value.exportsService.createDestinationGrant(destination); const result = value.exportsService.exportToGrantedDestination(value.revisionId, grant.id); assert.equal(path.dirname(result.exportedPath), fs.realpathSync(destination)); assert.equal(fs.existsSync(path.join(result.exportedPath, 'package.json')), true);
    assert.throws(() => value.exportsService.exportToGrantedDestination(value.revisionId, grant.id), (error) => error.code === 'export_destination_grant_invalid');
    const expired = value.exportsService.createDestinationGrant(destination); value.store.database.db.prepare("UPDATE export_destination_grants SET expires_at='2000-01-01T00:00:00.000Z' WHERE id=?").run(expired.id); assert.throws(() => value.exportsService.exportToGrantedDestination(value.revisionId, expired.id), (error) => error.code === 'export_destination_grant_invalid');
  } finally { fs.rmSync(destination, { recursive: true, force: true }); cleanup(value); }
});

// acceptance selectors: external-agent-auth-separation, agent-submit-accept-reject
test('external agent submit, poll, diff, desktop accept and reject preserve approval separation', async () => {
  const value = await fixture(); try {
    const issued = value.agents.createGrant({ projectIds: ['p1'], ttlSeconds: 600 }); const grant = value.agents.authenticate(bearer(issued.token)); assert.equal(value.agents.projects(grant)[0].id, 'p1'); assert.throws(() => value.agents.authenticate(bearer('mpa_invalid_invalid_invalid_invalid')), (error) => error.code === 'agent_token_invalid');
    const session = value.agents.startSession(grant, 'p1', { componentId: 'c1', baseRevisionId: value.revisionId }); const boundary = value.agents.boundary(grant, session.id); assert.equal(boundary.boundary.scriptsExecuted, false); assert.ok(boundary.files['src/App.tsx']);
    const before = value.store.get().revisions.length; const submitted = await value.agents.submit(grant, session.id, { files: { ...boundary.files, 'src/App.tsx': "export default function App(){return <main>Agent candidate</main>}" }, note: 'Agent candidate' }); assert.equal(submitted.status, 'pending_review'); assert.equal(submitted.build.status, 'succeeded'); assert.equal(submitted.diff.changedCount, 1); assert.equal(value.store.get().revisions.length, before, 'successful agent builds do not create revisions before acceptance');
    const accepted = value.agents.accept(submitted.id); assert.equal(accepted.status, 'accepted'); assert.ok(accepted.revisionId); assert.equal(value.store.get().revisions.length, before + 1);
    const second = value.agents.startSession(grant, 'p1', { componentId: 'c1', baseRevisionId: accepted.revisionId }); const secondBoundary = value.agents.boundary(grant, second.id); const rejectedCandidate = await value.agents.submit(grant, second.id, { files: { ...secondBoundary.files, 'src/App.tsx': "export default function App(){return <main>Reject me</main>}" } }); const count = value.store.get().revisions.length; assert.equal(value.agents.reject(rejectedCandidate.id).status, 'rejected'); assert.equal(value.store.get().revisions.length, count);
    value.agents.revoke(issued.id); assert.throws(() => value.agents.authenticate(bearer(issued.token)), (error) => error.code === 'agent_token_invalid');
  } finally { cleanup(value); }
});

// acceptance selector: ide-unavailable-after-export
test('IDE launch source retains export success when allowlisted executable is unavailable', () => {
  const rust = fs.readFileSync('src-tauri/src/main.rs', 'utf8'); assert.match(rust, /launch_status: "unavailable"/); assert.match(rust, /Command::new\(executable\)\.arg\(&canonical\)/); assert.doesNotMatch(rust, /sh\s+-c|bash\s+-c/); assert.match(rust, /path_is_inside/);
});
