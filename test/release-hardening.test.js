import assert from 'node:assert/strict';
import test from 'node:test';
import { spawnSync } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { mutationRoutes, validateMutation } from '../server/src/routes/mutations.js';
import { keyResponseContracts, validateKeyResponse } from '../server/src/routes/responses.js';
import { Store } from '../server/store.js';
import { AssetService } from '../server/src/assets/asset-service.js';

test('acceptance selector runner rejects unknown selectors before launching tests', () => {
  const result = spawnSync(process.execPath, ['scripts/run-selected-tests.mjs', 'integration', 'definitely-unknown'], { encoding: 'utf8' });
  assert.equal(result.status, 2); assert.match(result.stderr, /Unknown acceptance selector/);
});

test('default backup marker is published where AssetService GC discovers it', () => {
  const root = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'mypath-default-backup-marker-')));
  const dataDir = path.join(root, 'data'); const store = new Store(dataDir); store.close();
  const env = { ...process.env }; delete env.MYPATH_DATA_DIR;
  try {
    const result = spawnSync(process.execPath, [path.resolve('scripts/backup.mjs'), 'create', '--label', 'default-marker'], { cwd: root, env, encoding: 'utf8' });
    assert.equal(result.status, 0, result.stderr);
    assert.equal(fs.existsSync(path.join(root, '.mypath-last-backup')), false, 'no incompatible cwd-level marker is written');
    const reopened = new Store(dataDir);
    try {
      const discovered = new AssetService(reopened.database, dataDir).verifiedBackup();
      assert.ok(discovered?.directory.startsWith(path.join(dataDir, 'backups')));
    } finally { reopened.close(); }
  } finally { fs.rmSync(root, { recursive: true, force: true }); }
});

test('registered mutation schemas reject unknown persistence fields and prototype keys', () => {
  assert.equal(mutationRoutes.some((route) => route.path === '/projects/:id' && route.methods.includes('PATCH')), true);
  assert.throws(() => validateMutation('PATCH', '/projects/p1', { name: 'safe', selectedRevisionId: 'overwrite' }), (error) => error.code === 'field_unknown');
  const polluted = JSON.parse('{"name":"safe","__proto__":{"admin":true}}');
  assert.throws(() => validateMutation('PATCH', '/projects/p1', polluted), (error) => error.code === 'field_forbidden');
  assert.throws(() => validateMutation('PUT', '/projects/p1/canvas', { version: 1 }), (error) => error.code === 'field_required');
  assert.deepEqual(validateMutation('PATCH', '/projects/p1', { name: 'safe' }), { name: 'safe' });
});

test('key handler responses are conformance-checked at the serialization boundary', () => {
  assert.ok(keyResponseContracts.length >= 7);
  assert.doesNotThrow(() => validateKeyResponse('GET', '/api/v1/health', 200, { ok: true, product: 'mypath', instanceAuthenticated: true, features: [] }));
  assert.throws(() => validateKeyResponse('GET', '/api/v1/projects/p1/canvas', 200, { id: 'canvas:1', version: '2', snapshot: {}, camera: {} }), /Response contract failed/);
  assert.throws(() => validateKeyResponse('POST', '/api/v1/projects', 201, { id: 'p1', name: { invalid: true } }), /Response contract failed/);
});

test('every mutation field has type, shape, and range validation', () => {
  for (const route of mutationRoutes) {
    assert.deepEqual(Object.keys(route.rules).sort(), [...route.fields].sort(), `${route.path} has a rule for every accepted field`);
    assert.ok(Object.values(route.rules).every((rule) => rule && typeof rule.type === 'string'));
  }
  const invalid = (method, path, body) => assert.throws(() => validateMutation(method, path, body), (error) => error.code === 'field_invalid');
  invalid('POST', '/projects', { name: { injected: true } });
  invalid('PUT', '/projects/p1/canvas', { version: '7', snapshot: {} });
  invalid('PUT', '/projects/p1/canvas', { version: 7, snapshot: 'not-a-document' });
  invalid('POST', '/projects/p1/chat/runs', { prompt: ['not', 'text'], contextSnapshotId: 'ctx:1' });
  invalid('POST', '/assets/gc', { retentionMs: -1 });
  invalid('POST', '/revisions/r1/screenshots', { dataUrl: 'data:image/png;base64,x', width: 0, height: 900 });
});
