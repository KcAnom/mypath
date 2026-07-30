import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';
import { Store } from '../server/store.js';
import { AssetService } from '../server/src/assets/asset-service.js';
import { CandidateService } from '../server/src/build/candidate-service.js';
import { CanvasService } from '../server/src/canvas/canvas-service.js';
import { ContextService } from '../server/src/context/context-service.js';
import { DesignSystemService } from '../server/src/design-systems/design-system-service.js';
import { FontService } from '../server/src/fonts/font-service.js';
import { LibraryService } from '../server/src/libraries/library-service.js';
import { SkillService } from '../server/src/skills/skill-service.js';
import { RunService } from '../server/src/runs/run-service.js';
import { parseSkillPackage } from '../server/src/skills/skill-package.js';
import { assertPublicHttpsUrl, fetchThemeFromUrl, isBlockedAddress } from '../server/src/security/theme-fetch.js';

function crc32(bytes) { let crc = 0xffffffff; for (const byte of bytes) { crc ^= byte; for (let bit = 0; bit < 8; bit++) crc = crc & 1 ? 0xedb88320 ^ (crc >>> 1) : crc >>> 1; } return (crc ^ 0xffffffff) >>> 0; }
function storedZip(name, value) {
  const filename = Buffer.from(name); const content = Buffer.from(value); const crc = crc32(content);
  const local = Buffer.alloc(30); local.writeUInt32LE(0x04034b50); local.writeUInt16LE(20, 4); local.writeUInt32LE(crc, 14); local.writeUInt32LE(content.length, 18); local.writeUInt32LE(content.length, 22); local.writeUInt16LE(filename.length, 26);
  const central = Buffer.alloc(46); central.writeUInt32LE(0x02014b50); central.writeUInt16LE(20, 4); central.writeUInt16LE(20, 6); central.writeUInt32LE(crc, 16); central.writeUInt32LE(content.length, 20); central.writeUInt32LE(content.length, 24); central.writeUInt16LE(filename.length, 28);
  const eocd = Buffer.alloc(22); eocd.writeUInt32LE(0x06054b50); eocd.writeUInt16LE(1, 8); eocd.writeUInt16LE(1, 10); eocd.writeUInt32LE(central.length + filename.length, 12); eocd.writeUInt32LE(local.length + filename.length + content.length, 16);
  return Buffer.concat([local, filename, content, central, filename, eocd]);
}
async function fixture() {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'mypath-phase5-')); const store = new Store(root);
  store.with((state) => { state.projects.push({ id: 'p1', name: 'Phase 5', createdAt: new Date().toISOString() }); state.canvases.push({ id: 'canvas1', projectId: 'p1', shapes: [], camera: {} }); state.components.push({ id: 'c1', projectId: 'p1', name: 'Source', generatedName: 'source', files: {}, selectedRevisionId: null, createdAt: new Date().toISOString() }); });
  const assets = new AssetService(store.database, root); const fonts = new FontService(store.database, assets); const candidates = new CandidateService(store); const canvases = new CanvasService(store.database); const designSystems = new DesignSystemService(store, fonts); const skills = new SkillService(store); const libraries = new LibraryService(store, candidates, canvases); const contexts = new ContextService(store.database, canvases, { designSystems, libraries, skills, fonts });
  return { root, store, assets, fonts, candidates, canvases, designSystems, skills, libraries, contexts };
}
function cleanup(value) { value.store.close(); fs.rmSync(value.root, { recursive: true, force: true }); }

test('versioned compiler pins exact design context and embeds ingested fonts without remote dependencies', async () => {
  const value = await fixture(); try {
    const fontAsset = value.assets.ingest({ projectId: 'p1', name: 'Offline.woff2', kind: 'font', bytes: Buffer.concat([Buffer.from('wOF2'), Buffer.alloc(28, 7)]) }); const font = value.fonts.create({ assetId: fontAsset.id, family: 'Offline Sans' }); value.fonts.activate('p1', font.id);
    const design = value.designSystems.create({ name: 'Product', defaultTheme: 'dark', light: { '--background': '#fff', '--foreground': '#111' }, dark: { '--background': '#111', '--foreground': '#fff' }, markdown: '# Product\nExact spacing.', fonts: [{ fontId: font.id }] }); value.designSystems.activate('p1', design.currentVersion.id);
    const context = value.contexts.create('p1', {}); assert.equal(context.activeRefs.designSystemVersionId, design.currentVersion.id); assert.equal(context.fontRefs[0].fontId, font.id);
    const files = value.contexts.applyToGeneratedFiles({ 'src/App.tsx': 'export default function App(){return <main>Offline</main>}', 'src/index.css': 'body{}' }, context);
    assert.match(files['src/index.css'], /mypath-design-system:/); assert.match(files['src/index.css'], /@font-face/); assert.match(files['src/index.css'], /\.\.\/assets\/fonts\//); assert.ok(Object.entries(files).some(([name, content]) => name.startsWith('assets/fonts/') && content.startsWith('base64:'))); assert.doesNotMatch(files['src/index.css'], /https?:\/\//);
    const queued = value.candidates.create({ componentId: 'c1', files, metadata: value.contexts.revisionMetadata(context) }); const build = await value.candidates.run(queued.buildId); assert.equal(build.status, 'succeeded'); const preview = await value.candidates.artifactForRevision(build.revision_id); assert.match(preview.html, /data:font\/woff2;base64/); assert.doesNotMatch(preview.html, /@font-face[^}]+https?:\/\//); const revision = value.store.get().revisions.find((item) => item.id === build.revision_id); assert.equal(revision.designSystemVersionId, design.currentVersion.id); assert.deepEqual(revision.fontIds, [font.id]);
    value.designSystems.update(design.id, { dark: { '--background': '#222', '--foreground': '#eee' } }); assert.equal(revision.designSystemVersionId, design.currentVersion.id, 'later versions cannot alter revision provenance');
  } finally { cleanup(value); }
});

test('library membership, canvas reuse, and copy remain pinned to one completed revision with provenance', async () => {
  const value = await fixture(); try {
    const first = value.candidates.create({ componentId: 'c1', files: { 'src/App.tsx': 'export default function App(){return <button>Exact</button>}' } }); const built = await value.candidates.run(first.buildId); const library = value.libraries.create({ name: 'Exact library' }); const member = value.libraries.add(library.id, 'c1', built.revision_id); assert.equal(member.revisionId, built.revision_id);
    const reused = value.libraries.reuseOnCanvas({ libraryId: library.id, componentId: 'c1', revisionId: built.revision_id, targetProjectId: 'p1' }); assert.equal(reused.provenance.exactRevisionId, built.revision_id); assert.equal(value.canvases.get('p1').snapshot.legacyShapes.at(-1).props.revisionId, built.revision_id);
    assert.throws(() => value.libraries.reuseOnCanvas({ libraryId: library.id, componentId: 'c1', revisionId: 'latest', targetProjectId: 'p1' }), (error) => error.code === 'library_revision_mismatch');
    const copied = await value.libraries.copy({ libraryId: library.id, componentId: 'c1', revisionId: built.revision_id, targetProjectId: 'p1' }); assert.equal(copied.provenance.sourceRevisionId, built.revision_id); assert.equal(value.store.get().revisions.find((revision) => revision.id === copied.revisionId).copyProvenance.sourceRevisionId, built.revision_id);
  } finally { cleanup(value); }
});

test('skill package import is text-only, bounded, traversal-safe, and selection snapshots exact built-in/user versions', async () => {
  const valid = parseSkillPackage(storedZip('SKILL.md', '# Review\nCheck accessible labels.'), 'review.zip'); assert.equal(valid.files.length, 1); assert.equal(valid.content.startsWith('# Review'), true);
  assert.throws(() => parseSkillPackage(storedZip('../escape.md', 'no'), 'bad.zip'), (error) => error.code === 'skill_path_invalid');
  assert.throws(() => parseSkillPackage(storedZip('run.js', 'console.log(1)'), 'bad.zip'), (error) => error.code === 'skill_file_type_invalid');
  assert.throws(() => parseSkillPackage(Buffer.concat([Buffer.from('wOF2'), Buffer.from([0])]), 'binary.skill'), (error) => error.code === 'skill_text_invalid');
  const value = await fixture(); try { const imported = value.skills.importPackage({ bytes: storedZip('SKILL.md', '# Mobile\nResponsive mobile layouts.'), packageName: 'mobile.zip' }); value.skills.activate('p1', imported.skill.id); const context = value.contexts.create('p1', { skills: [{ skillId: 'builtin:accessibility' }] }); assert.ok(context.skillRefs.some((ref) => ref.skillId === imported.skill.id && ref.versionId)); assert.ok(context.skillRefs.some((ref) => ref.skillId === 'builtin:accessibility' && ref.versionId)); assert.match(context.operationalContext.skills.map((skill) => skill.content).join('\n'), /accessible|Responsive/i); } finally { cleanup(value); }
});

test('selected operational context reaches provider generation and promoted revision metadata', async () => {
  const value = await fixture(); let runs; try {
    const design = value.designSystems.create({ name: 'Selected', light: { '--background': '#fff' }, dark: { '--background': '#000' }, markdown: '# Selected exact' }); value.designSystems.activate('p1', design.currentVersion.id); value.skills.activate('p1', 'builtin:accessibility');
    const context = value.contexts.create('p1', {}); let received = null;
    const providers = { resolve: () => ({ config: { id: 'spy', kind: 'fixture' } }), resolveSnapshot: () => ({ config: { id: 'spy', kind: 'fixture' }, provider: { generate: async (request) => { received = request.context.envelope.operationalContext; return { name: 'Observed', files: { 'src/App.tsx': 'export default function App(){return <main>Observed</main>}', 'src/index.css': 'body{}' } }; } } }) };
    runs = new RunService({ store: value.store, candidates: value.candidates, canvases: value.canvases, contexts: value.contexts, providers }); const thread = runs.createThread('p1'); const run = runs.createRun({ projectId: 'p1', threadId: thread.id, prompt: 'Observe selected context', contextSnapshotId: context.id, providerConfigId: 'spy' });
    let completed; for (let attempt = 0; attempt < 100; attempt++) { completed = runs.getRun(run.id); if (['succeeded', 'failed'].includes(completed.status)) break; await new Promise((resolve) => setTimeout(resolve, 50)); }
    assert.equal(completed.status, 'succeeded'); assert.equal(received.designSystem.versionId, design.currentVersion.id); assert.equal(received.skills[0].skillId, 'builtin:accessibility'); const revision = value.store.get().revisions.find((item) => item.id === completed.jobs[0].revisionId); assert.equal(revision.contextSnapshotId, context.id); assert.equal(revision.designSystemVersionId, design.currentVersion.id); assert.deepEqual(revision.skillVersionIds, context.skillRefs.map((ref) => ref.versionId));
  } finally { runs?.close(); cleanup(value); }
});

test('theme URL policy rejects SSRF addresses before a socket and revalidates DNS', async () => {
  for (const address of ['127.0.0.1', '10.0.0.1', '169.254.169.254', '::1', 'fc00::1', '2001:db8::1']) assert.equal(isBlockedAddress(address), true, address);
  assert.throws(() => assertPublicHttpsUrl('http://example.com/theme.css'), (error) => error.code === 'theme_url_policy'); assert.throws(() => assertPublicHttpsUrl('https://127.0.0.1/theme.css'), (error) => error.code === 'theme_url_ssrf_rejected');
  await assert.rejects(fetchThemeFromUrl('https://example.com/theme.css', { lookup: async () => [{ address: '127.0.0.1', family: 4 }] }), (error) => error.code === 'theme_url_ssrf_rejected');
});

test('system defaults clear the current project design-system selection', async () => {
  const value = await fixture(); try {
    const design = value.designSystems.create({ name: 'Temporary selection' });
    value.designSystems.activate('p1', design.currentVersion.id, true);
    assert.equal(value.designSystems.active('p1').id, design.currentVersion.id);
    const cleared = value.designSystems.activate('p1', null, false);
    assert.deepEqual(cleared, { projectId: 'p1', versionId: null, active: false });
    assert.equal(value.designSystems.active('p1'), null);
  } finally { cleanup(value); }
});
