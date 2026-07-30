import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';
import { DatabaseSync } from 'node:sqlite';
import { MyPathDatabase, checksum } from '../server/src/db/database.js';
import { Store } from '../server/store.js';

function temporary() { return fs.mkdtempSync(path.join(os.tmpdir(), 'mypath-db-')); }
function fixture() {
  const t = '2025-01-01T00:00:00.000Z';
  return {
    meta: { version: 2, custom: true }, user: { id: 'local-user', custom: 'kept' }, unknownRoot: { kept: true },
    projects: [{ id: 'p1', name: 'One', description: '', createdAt: t, updatedAt: t }],
    components: [{ id: 'c1', projectId: 'p1', generatedName: 'card', selectedRevisionId: 'r1', files: { 'src/index.css': "@import url('https://fonts.googleapis.com/css2?family=X');\nbody{}" } }],
    revisions: [{ id: 'r1', componentId: 'c1', files: { 'src/App.tsx': 'export default 1' }, code: 'export default 1', createdAt: t }],
    jobs: [{ id: 'j1', componentId: 'c1', revisionId: 'r1', status: 'completed' }],
    canvases: [{ id: 'v1', projectId: 'p1', shapes: [{ id: 's1' }], camera: { x: 1 }, updatedAt: t }],
    designSystems: [{ id: 'd1', tokens: { a: 1 } }], libraries: [{ id: 'l1', componentIds: ['c1'] }], skills: [{ id: 'k1', content: 'text' }],
    chatThreads: [{ id: 't1', title: 'Thread' }], chatMessages: [{ id: 'm1', threadId: 't1', content: 'hi' }],
    images: [{ id: 'a1', projectId: 'p1', custom: 1 }], fonts: [{ id: 'f1', family: 'Local' }],
  };
}

test('legacy JSON imports exactly once, archives provenance, and survives recovery rerun', () => {
  const dir = temporary();
  const raw = JSON.stringify(fixture(), null, 2);
  fs.writeFileSync(path.join(dir, 'db.json'), raw);
  let database = new MyPathDatabase(dir);
  const state = database.loadState();
  assert.equal(state.projects.length, 1);
  assert.equal(state.revisions.length, 2);
  assert.ok(state.revisions.some((revision) => revision.id === 'r1'));
  assert.ok(state.revisions.some((revision) => revision.status === 'imported_unbuilt'));
  assert.equal(state.designSystems[0].tokens.a, 1);
  assert.equal(state.unknownRoot.kept, true);
  assert.doesNotMatch(state.components[0].files['src/index.css'], /googleapis/);
  const report = database.db.prepare('SELECT * FROM import_reports').get();
  assert.equal(report.source_checksum, checksum(Buffer.from(raw)));
  const archive = report.archive_path;
  assert.ok(fs.existsSync(archive));
  assert.equal(fs.readFileSync(archive, 'utf8'), raw);
  assert.equal(database.db.prepare('PRAGMA journal_mode').get().journal_mode, 'wal');
  assert.equal(database.db.prepare('PRAGMA foreign_keys').get().foreign_keys, 1);
  assert.ok(database.db.prepare("PRAGMA foreign_key_list('revisions')").all().some((row) => row.table === 'components'));
  database.close();

  // Crash-recovery shape: commit exists while the original source still exists.
  fs.copyFileSync(archive, path.join(dir, 'db.json'));
  database = new MyPathDatabase(dir);
  assert.equal(database.db.prepare('SELECT count(*) count FROM import_reports').get().count, 1);
  assert.equal(database.loadState().projects.length, 1);
  assert.equal(fs.existsSync(path.join(dir, 'db.json')), false);
  database.close();

  // A different legacy source may not be mixed into an already-imported database.
  fs.writeFileSync(path.join(dir, 'db.json'), JSON.stringify({ ...fixture(), projects: [] }));
  assert.throws(() => new MyPathDatabase(dir), { code: 'legacy_checksum_conflict' });
  const unchanged = new DatabaseSync(path.join(dir, 'db.sqlite'));
  assert.equal(unchanged.prepare('SELECT count(*) count FROM projects').get().count, 1);
  assert.equal(unchanged.prepare('SELECT count(*) count FROM import_reports').get().count, 1);
  unchanged.close();
  fs.rmSync(dir, { recursive: true, force: true });
});

test('corrupt legacy input leaves SQLite target absent', () => {
  const dir = temporary();
  fs.writeFileSync(path.join(dir, 'db.json'), '{broken');
  assert.throws(() => new MyPathDatabase(dir), { code: 'legacy_json_corrupt' });
  assert.equal(fs.existsSync(path.join(dir, 'db.sqlite')), false);
  fs.rmSync(dir, { recursive: true, force: true });
});

test('failed legacy insertion rolls the import transaction back', () => {
  const dir = temporary();
  const bad = fixture();
  bad.projects.push({ ...bad.projects[0], name: 'duplicate id' });
  fs.writeFileSync(path.join(dir, 'db.json'), JSON.stringify(bad));
  assert.throws(() => new MyPathDatabase(dir));
  const db = new DatabaseSync(path.join(dir, 'db.sqlite'));
  assert.equal(db.prepare('SELECT count(*) count FROM projects').get().count, 0);
  assert.equal(db.prepare('SELECT count(*) count FROM import_reports').get().count, 0);
  db.close();
  assert.equal(fs.existsSync(path.join(dir, 'db.json')), true);
  fs.rmSync(dir, { recursive: true, force: true });
});

test('legacy orphans are quarantined and missing blobs are tombstoned instead of live', () => {
  const dir = temporary();
  const data = fixture();
  data.components.push({ id: 'orphan-component', projectId: 'missing-project', generatedName: 'orphan' });
  data.revisions.push({ id: 'orphan-revision', componentId: 'orphan-component', files: {} });
  data.jobs.push({ id: 'orphan-job', componentId: 'orphan-component', revisionId: 'orphan-revision' });
  data.canvases.push({ id: 'orphan-canvas', projectId: 'missing-project', shapes: [] });
  data.chatMessages.push({ id: 'orphan-message', threadId: 'missing-thread', content: 'orphan' });
  data.libraries[0].componentIds.push('orphan-component');
  data.images.push({ id: 'missing-asset', projectId: 'p1', path: 'assets/does-not-exist.png', url: '/images/missing' });
  fs.writeFileSync(path.join(dir, 'db.json'), JSON.stringify(data));
  const database = new MyPathDatabase(dir);
  const state = database.loadState();
  assert.equal(state.components.some((item) => item.id === 'orphan-component'), false);
  assert.equal(state.revisions.some((item) => item.id === 'orphan-revision'), false);
  assert.equal(state.jobs.some((item) => item.id === 'orphan-job'), false);
  assert.equal(state.canvases.some((item) => item.id === 'orphan-canvas'), false);
  assert.equal(state.chatMessages.some((item) => item.id === 'orphan-message'), false);
  assert.deepEqual(state.libraries[0].componentIds, ['c1']);
  const missing = state.images.find((item) => item.id === 'missing-asset');
  assert.ok(missing.tombstonedAt);
  assert.equal(missing.disabled, true);
  assert.equal(missing.url, null);
  assert.equal(database.db.prepare("SELECT count(*) count FROM quarantine_rows WHERE entity_id IN ('orphan-component','orphan-revision','orphan-job','orphan-canvas','orphan-message')").get().count, 5);
  assert.equal(database.db.prepare("SELECT count(*) count FROM tombstones WHERE entity_type='asset' AND entity_id='missing-asset'").get().count, 1);
  assert.throws(() => database.db.prepare("INSERT INTO revisions(id,component_id,ordinal,data_json) VALUES('bad','does-not-exist',0,'{}')").run(), /fk revisions\.component_id/);
  database.close();
  fs.rmSync(dir, { recursive: true, force: true });
});

test('SQLite store preserves CRUD writes across connections without lost records', () => {
  const dir = temporary();
  const first = new Store(dir);
  const second = new Store(dir);
  for (let i = 0; i < 30; i++) {
    const store = i % 2 ? first : second;
    store.with((db) => { db.projects.push({ id: `p${i}`, name: `P${i}`, description: '' }); });
  }
  assert.equal(first.get().projects.length, 30);
  second.with((db) => { db.projects[0].name = 'changed'; });
  assert.equal(first.get().projects[0].name, 'changed');
  first.close(); second.close();
  const check = new DatabaseSync(path.join(dir, 'db.sqlite'), { readOnly: true });
  assert.equal(check.prepare('PRAGMA integrity_check').get().integrity_check, 'ok');
  check.close();
  fs.rmSync(dir, { recursive: true, force: true });
});
