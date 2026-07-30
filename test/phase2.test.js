import assert from 'node:assert/strict';
import crypto from 'node:crypto';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';
import { Store } from '../server/store.js';
import { CanvasService, convertLegacyCanvas } from '../server/src/canvas/canvas-service.js';
import { AssetService, inspectAsset } from '../server/src/assets/asset-service.js';
import { ContextService } from '../server/src/context/context-service.js';

let root, store, canvases, assets, contexts;
test.beforeEach(() => {
  root = fs.mkdtempSync(path.join(os.tmpdir(), 'mypath-phase2-')); store = new Store(root); canvases = new CanvasService(store.database); assets = new AssetService(store.database, root); contexts = new ContextService(store.database, canvases);
  store.with((db) => {
    db.projects.push({ id: 'p1', name: 'Canvas', createdAt: new Date().toISOString() });
    db.canvases.push({ id: 'c1', projectId: 'p1', version: 1, shapes: [{ id: 'old', kind: 'component', componentId: 'component1', selectedRevisionId: 'revision1', position: { x: 12, y: 24 }, size: { width: 300, height: 200 } }], camera: { x: 4, y: 5, zoom: 2 } });
    db.components.push({ id: 'component1', projectId: 'p1', name: 'Frame', generatedName: 'frame', selectedRevisionId: 'revision1' });
    db.revisions.push({ id: 'revision1', componentId: 'component1', status: 'built', files: { 'src/App.tsx': 'export default 1' } });
  });
});
test.afterEach(() => { store.close(); fs.rmSync(root, { recursive: true, force: true }); });

test('ProjectCanvas conflict reload replaces modern and legacy state while suppressing stale autosaves', () => {
  const source = fs.readFileSync('web/src/canvas/ProjectCanvas.tsx', 'utf8');
  assert.doesNotMatch(source, /\.\.\.remote\.document\.store[\s\S]{0,80}\.\.\.local\.document\.store/);
  assert.match(source, /Concurrent edit conflict/);
  assert.match(source, /local edits were not uploaded/);
  assert.match(source, /if \(canvas\.snapshot\?\.document\) loadSnapshot\(instance\.store, canvas\.snapshot\)/, 'modern snapshots replace the tldraw store');
  assert.match(source, /instance\.deleteShapes\(currentShapeIds\)/, 'legacy reload discards stale local shapes before creating remote ones');
  assert.match(source, /Array\.isArray\(canvas\.snapshot\?\.legacyShapes\)/, 'legacy remote publications are loaded');
  assert.match(source, /saveBlocked\.current = true[\s\S]*window\.clearTimeout|window\.clearTimeout[\s\S]*saveBlocked\.current = true/, 'conflict/reload blocks and cancels stale autosaves');
  assert.match(source, /if \(editor\.current\) applyRemoteCanvas\(editor\.current, conflict\)/, 'the explicit conflict action uses the shared replacement path');
});

test('legacy canvas conversion is deterministic and preserves camera/frame references', () => {
  const first = convertLegacyCanvas({ shapes: [{ id: 'x', kind: 'component', componentId: 'c', selectedRevisionId: 'r', position: { x: 1, y: 2 } }], camera: { x: 3 } });
  const second = convertLegacyCanvas({ shapes: [{ id: 'x', kind: 'component', componentId: 'c', selectedRevisionId: 'r', position: { x: 1, y: 2 } }], camera: { x: 3 } });
  assert.deepEqual(first, second); assert.equal(first.format, 'tldraw-v1'); assert.equal(first.legacyShapes[0].props.revisionId, 'r'); assert.equal(first.camera.x, 3);
  assert.equal(canvases.get('p1').snapshot.legacyShapes.length, 1);
});

test('canvas compare-and-swap rejects stale edits and deterministic publication merges once', () => {
  const original = canvases.get('p1');
  const saved = canvases.save('p1', original.version, { ...original.snapshot, marker: 'a' }, original.camera); assert.equal(saved.version, original.version + 1);
  const stale = canvases.save('p1', original.version, { marker: 'stale' }, {}); assert.equal(stale.conflict, true); assert.equal(stale.current.snapshot.marker, 'a');
  const one = canvases.publish('p1', 'job-1', { componentId: 'component1', revisionId: 'revision1' });
  const two = canvases.publish('p1', 'job-1', { componentId: 'component1', revisionId: 'revision1' });
  assert.equal(one.id, 'frame:job-1'); assert.equal(two.materialized_version, one.materialized_version);
  assert.equal(canvases.get('p1').snapshot.legacyShapes.filter((x) => x.props?.publicationId === 'frame:job-1').length, 1);
});

test('asset validation sniffs bytes, sanitizes SVG, and retains context-referenced blobs', () => {
  assert.throws(() => inspectAsset(Buffer.from('not an image'), 'image'), /Unsupported asset/);
  const sanitized = inspectAsset(Buffer.from('<svg xmlns="http://www.w3.org/2000/svg" onload="bad()"><script>bad()</script><rect/></svg>'), 'image');
  assert.equal(sanitized.mediaType, 'image/svg+xml'); assert.doesNotMatch(sanitized.bytes.toString(), /script|onload/i);
  const asset = assets.ingest({ projectId: 'p1', name: '../../unsafe.svg', kind: 'image', bytes: sanitized.bytes }); assert.ok(fs.existsSync(asset.path)); assert.equal(asset.name.includes('..'), false); assert.equal(asset.path.startsWith(path.join(root, 'blobs')), true);
  const canvas = canvases.get('p1'); const shapeId = canvas.snapshot.legacyShapes[0].id;
  const context = contexts.create('p1', { shapeIds: [shapeId], components: [{ componentId: 'component1', revisionId: 'revision1' }], assets: [{ id: asset.id }] }); assert.equal(context.schema, 'ContextEnvelopeV1');
  assert.equal(assets.tombstone(asset.id), true); assert.deepEqual(assets.gc(), []); assert.ok(fs.existsSync(asset.path));
});

test('blob GC requires elapsed retention and a post-tombstone verified blob backup', () => {
  const png = Buffer.from([137, 80, 78, 71, 13, 10, 26, 10, 0, 0, 0, 0]);
  const asset = assets.ingest({ projectId: 'p1', name: 'gc.png', kind: 'image', bytes: png });
  assets.tombstone(asset.id);
  const old = '2020-01-01T00:00:00.000Z';
  store.database.db.prepare('UPDATE asset_ingestions SET tombstoned_at=? WHERE id=?').run(old, asset.id);
  const backup = path.join(root, 'backups', 'verified'); const relative = `blobs/${asset.checksum.slice(0, 2)}/${asset.checksum}`;
  const copy = path.join(backup, ...relative.split('/')); fs.mkdirSync(path.dirname(copy), { recursive: true }); fs.copyFileSync(asset.path, copy);
  const databaseCopy = path.join(backup, 'db.sqlite'); fs.copyFileSync(path.join(root, 'db.sqlite'), databaseCopy);
  const databaseSha256 = crypto.createHash('sha256').update(fs.readFileSync(databaseCopy)).digest('hex');
  const manifest = { format: 3, createdAt: '2025-01-01T00:00:00.000Z', database: 'db.sqlite', databaseSha256, trees: ['blobs'], files: [{ path: relative, size: png.length, sha256: '0'.repeat(64) }] };
  fs.writeFileSync(path.join(backup, 'manifest.json'), JSON.stringify(manifest));
  assert.throws(() => assets.gc({ retentionMs: 0, backupPath: backup }), (error) => error.code === 'backup_checksum_invalid', 'bad backup checksum cannot authorize deletion');
  manifest.files[0].sha256 = asset.checksum; fs.writeFileSync(path.join(backup, 'manifest.json'), JSON.stringify(manifest));
  assert.deepEqual(assets.gc({ retentionMs: Number.MAX_SAFE_INTEGER, backupPath: backup }), [], 'retention must also elapse');
  assert.deepEqual(assets.gc({ retentionMs: 0, backupPath: backup }), [asset.checksum]);
  assert.equal(fs.existsSync(asset.path), false);
});

test('context envelopes use exact immutable revisions and SQLite rejects mutation', () => {
  const canvas = canvases.get('p1'); const shapeId = canvas.snapshot.legacyShapes[0].id;
  assert.throws(() => contexts.create('p1', { shapeIds: [shapeId], components: [{ componentId: 'component1', revisionId: 'missing' }] }), /not exact/);
  const value = contexts.create('p1', { shapeIds: [shapeId], components: [{ componentId: 'component1', revisionId: 'revision1' }] });
  assert.equal(value.canvas.version, canvas.version); assert.equal(value.componentRevisionRefs[0].revisionId, 'revision1');
  assert.throws(() => store.database.db.prepare('UPDATE context_snapshots SET project_id=? WHERE id=?').run('other', value.id), /immutable/);
  assert.deepEqual(contexts.create('p1', { shapeIds: [shapeId], components: [{ componentId: 'component1', revisionId: 'revision1' }] }).id, value.id);
});

test('fifty deterministic frames materialize without loss or duplicates', () => {
  for (let index = 0; index < 50; index++) { const publication = canvases.publish('p1', `job-${index}`, { componentId: 'component1', revisionId: 'revision1', x: index * 10 }); assert.equal(publication.status, 'materialized'); }
  const snapshot = canvases.get('p1').snapshot; const frames = snapshot.legacyShapes.filter((shape) => shape.props?.publicationId?.startsWith('frame:job-'));
  assert.equal(frames.length, 50); assert.equal(new Set(frames.map((shape) => shape.props.publicationId)).size, 50);
  assert.equal(store.database.db.prepare("SELECT count(*) count FROM canvas_frame_publications WHERE status='materialized'").get().count, 50);
});
