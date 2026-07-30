import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';
import { Store } from '../server/store.js';
import { generateComponent } from '../server/generate.js';
import { CandidateService } from '../server/src/build/candidate-service.js';
import { CanvasService } from '../server/src/canvas/canvas-service.js';
import { EditService } from '../server/src/editor/edit-service.js';
import { VariantService } from '../server/src/editor/variant-service.js';
import { analyzeSource, applyOperations, injectSourceIds } from '../server/src/editor/source-editor.js';

function source() { return { 'src/App.tsx': `export default function App() { return <main className="page"><h1>Original</h1><p title="intro">Keep me</p></main> }` }; }
async function setup() {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'mypath-phase4-')); const store = new Store(root);
  store.with((state) => { state.projects.push({ id: 'p1', name: 'Visual project', createdAt: new Date().toISOString() }); state.canvases.push({ id: 'canvas1', projectId: 'p1', shapes: [], camera: {} }); state.components.push({ id: 'c1', projectId: 'p1', name: 'Card', generatedName: 'card', files: {}, selectedRevisionId: null, createdAt: new Date().toISOString() }); });
  const candidates = new CandidateService(store); const queued = candidates.create({ componentId: 'c1', files: generateComponent({ prompt: 'Original', nameHint: 'Card' }).files }); const build = await candidates.run(queued.buildId);
  assert.equal(build.status, 'succeeded'); const canvases = new CanvasService(store.database);
  return { root, store, candidates, canvases, edits: new EditService(store, candidates), variants: new VariantService(store, candidates, canvases), baseRevisionId: build.revision_id };
}
function cleanup(fixture) { fixture.store.close(); fs.rmSync(fixture.root, { recursive: true, force: true }); }

test('supported JSX mapping injects stable IDs and targeted patches isolate one literal node', () => {
  const first = analyzeSource(source()); const second = analyzeSource(first.files);
  assert.deepEqual(second.layers.map((layer) => layer.sourceId), first.layers.map((layer) => layer.sourceId));
  assert.equal(new Set(first.layers.map((layer) => layer.sourceId)).size, 3);
  const heading = first.layers.find((layer) => layer.tag === 'h1'); const paragraph = first.layers.find((layer) => layer.tag === 'p');
  const changed = applyOperations(first.files, [{ type: 'set-text', sourceId: heading.sourceId, value: 'Changed' }]);
  assert.match(changed['src/App.tsx'], />Changed<\/h1>/); assert.match(changed['src/App.tsx'], />Keep me<\/p>/);
  assert.equal(analyzeSource(changed).layers.find((layer) => layer.tag === 'p').sourceId, paragraph.sourceId, 'unrelated source mapping remains stable');
  const duplicated = applyOperations(first.files, [{ type: 'duplicate', sourceId: heading.sourceId }]);
  const headings = analyzeSource(duplicated).layers.filter((layer) => layer.tag === 'h1'); assert.equal(headings.length, 2); assert.notEqual(headings[0].sourceId, headings[1].sourceId);
});

test('computed, repeated, spread and ambiguous mappings require reconciliation', () => {
  const unsupported = analyzeSource({ 'src/App.tsx': `export default function App({items, props}) { return <><div {...props}>Hi</div>{items.map(item => <p>{item.name}</p>)}</> }` });
  const spread = unsupported.layers.find((layer) => layer.tag === 'div'); const repeated = unsupported.layers.find((layer) => layer.tag === 'p');
  assert.equal(spread.editable, false); assert.ok(spread.readOnlyReasons.includes('spread_props')); assert.ok(spread.readOnlyReasons.includes('fragment_context'));
  assert.equal(repeated.editable, false); assert.ok(repeated.readOnlyReasons.includes('repeated_map')); assert.ok(repeated.readOnlyReasons.includes('computed_text'));
  assert.throws(() => applyOperations(unsupported.files, [{ type: 'set-text', sourceId: repeated.sourceId, value: 'No' }]), (error) => error.code === 'reconciliation_required');
  const mapped = injectSourceIds(source()); const mappedLayers = analyzeSource(mapped).layers; const id = mappedLayers[0].sourceId;
  const duplicateId = { 'src/App.tsx': mapped['src/App.tsx'].replace(mappedLayers[1].sourceId, id) };
  assert.throws(() => analyzeSource(duplicateId), (error) => error.code === 'reconciliation_required');
});

test('Cancel creates no revision and Done creates exactly one parent-linked revision', async () => {
  const fixture = await setup();
  try {
    const initialCount = fixture.store.get().revisions.length; const cancelled = fixture.edits.create('c1', fixture.baseRevisionId); fixture.edits.cancel(cancelled.id);
    assert.equal(fixture.store.get().revisions.length, initialCount); assert.equal(fixture.edits.get(cancelled.id).status, 'cancelled');
    const session = fixture.edits.create('c1', fixture.baseRevisionId); const layer = session.mapping.layers.find((item) => item.text === 'Primary');
    fixture.edits.append(session.id, { type: 'set-text', sourceId: layer.sourceId, value: 'Edited only' });
    const done = await fixture.edits.done(session.id); assert.equal(done.status, 'completed'); assert.equal(fixture.store.get().revisions.length, initialCount + 1);
    assert.equal(fixture.store.get().revisions.find((item) => item.id === done.doneRevisionId).parentRevisionId, fixture.baseRevisionId);
    const again = await fixture.edits.done(session.id); assert.equal(again.doneRevisionId, done.doneRevisionId); assert.equal(fixture.store.get().revisions.length, initialCount + 1, 'idempotent repeated Done cannot create a second revision');
    assert.match(fixture.store.get().revisions.find((item) => item.id === done.doneRevisionId).code, /Edited only/);
  } finally { cleanup(fixture); }
});

test('checkout preserves history, restore creates a child, and variants branch in parallel from one parent', async () => {
  const fixture = await setup();
  try {
    const session = fixture.edits.create('c1', fixture.baseRevisionId); const primary = session.mapping.layers.find((item) => item.text === 'Primary'); fixture.edits.append(session.id, { type: 'set-text', sourceId: primary.sourceId, value: 'Second' }); const edited = await fixture.edits.done(session.id);
    const count = fixture.store.get().revisions.length; fixture.edits.checkout('c1', fixture.baseRevisionId); assert.equal(fixture.store.get().revisions.length, count); assert.equal(fixture.store.get().components.find((item) => item.id === 'c1').selectedRevisionId, fixture.baseRevisionId);
    fixture.edits.checkout('c1', edited.doneRevisionId); const restored = await fixture.edits.restore(fixture.baseRevisionId);
    assert.equal(fixture.store.get().revisions.length, count + 1); assert.equal(restored.revision.parentRevisionId, edited.doneRevisionId); assert.equal(restored.revision.restoredFromRevisionId, fixture.baseRevisionId);
    const comparison = fixture.edits.compare(fixture.baseRevisionId, edited.doneRevisionId); assert.ok(comparison.files.some((file) => file.changed));
    const group = await fixture.variants.create('c1', [{ kind: 'layout', value: 'grid' }, { kind: 'color', value: '#312e81' }, { kind: 'copy', value: 'Variant copy' }, { kind: 'device', value: 'mobile' }]);
    assert.equal(group.status, 'completed'); assert.equal(group.variants.length, 4); assert.ok(group.variants.every((variant) => variant.status === 'completed' && variant.parentRevisionId === restored.revision.id));
    const revisions = fixture.store.get().revisions.filter((revision) => group.variants.some((variant) => variant.revisionId === revision.id)); assert.equal(revisions.length, 4); assert.ok(revisions.every((revision) => revision.parentRevisionId === restored.revision.id && revision.revisionKind === 'variant'));
    assert.equal(fixture.store.database.db.prepare("SELECT count(*) count FROM jobs WHERE json_extract(data_json,'$.phase4')=1 AND status='succeeded'").get().count, 4);
    assert.equal(fixture.store.database.db.prepare("SELECT count(*) count FROM job_attempts a JOIN jobs j ON j.id=a.job_id WHERE json_extract(j.data_json,'$.phase4')=1 AND a.status='succeeded'").get().count, 4);
    assert.equal(fixture.canvases.get('p1').snapshot.legacyShapes.filter((shape) => group.variants.some((variant) => shape.props?.publicationId === `frame:${variant.jobId}`)).length, 4);
  } finally { cleanup(fixture); }
});
