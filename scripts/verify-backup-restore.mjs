import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { Store } from '../server/store.js';
import { AssetService } from '../server/src/assets/asset-service.js';

const dataDir = fs.mkdtempSync(path.join(os.tmpdir(), 'mypath-backup-verify-'));
function backup(...arguments_) {
  const result = spawnSync(process.execPath, ['scripts/backup.mjs', ...arguments_], { env: { ...process.env, MYPATH_DATA_DIR: dataDir }, encoding: 'utf8' });
  if (result.status !== 0) throw new Error(`${arguments_.join(' ')} failed:\n${result.stdout}\n${result.stderr}`);
  return result.stdout.trim();
}
try {
  const store = new Store(dataDir);
  store.with((db) => db.projects.push({ id: 'backup-project', name: 'Before backup', description: '' }));
  const assetService = new AssetService(store.database, dataDir);
  const png = Buffer.from([137, 80, 78, 71, 13, 10, 26, 10, 0, 0, 0, 0]);
  const realAsset = assetService.ingest({ projectId: 'backup-project', name: 'real.png', kind: 'image', bytes: png });
  assert.deepEqual(fs.readFileSync(realAsset.path), png);
  store.close();
  fs.mkdirSync(path.join(dataDir, 'assets'), { recursive: true });
  fs.mkdirSync(path.join(dataDir, 'forge', 'candidate', 'src'), { recursive: true });
  fs.mkdirSync(path.join(dataDir, 'artifacts'), { recursive: true });
  fs.mkdirSync(path.join(dataDir, 'screenshots'), { recursive: true });
  fs.writeFileSync(path.join(dataDir, 'assets', 'pixel.bin'), Buffer.from([0, 1, 2, 3]));
  fs.writeFileSync(path.join(dataDir, 'forge', 'candidate', 'src', 'App.tsx'), 'export default function App(){return null}');
  fs.writeFileSync(path.join(dataDir, 'artifacts', 'preview.html'), '<button>Preview</button>');
  fs.writeFileSync(path.join(dataDir, 'screenshots', 'preview.png'), Buffer.from([4, 5, 6]));

  backup('create', '--label', 'verify-phase0');
  const marker = fs.readFileSync(path.join(dataDir, '.mypath-last-backup'), 'utf8').trim();
  backup('verify', '--backup', marker);
  const manifest = JSON.parse(fs.readFileSync(path.join(marker, 'manifest.json'), 'utf8'));
  assert.equal(manifest.format, 3);
  assert.deepEqual(manifest.trees, ['blobs', 'assets', 'forge', 'artifacts', 'screenshots']);
  assert.equal(manifest.files.length, 5);
  assert.ok(manifest.files.some((item) => item.path === `blobs/${realAsset.checksum.slice(0, 2)}/${realAsset.checksum}` && item.sha256 === realAsset.checksum));

  const changed = new Store(dataDir);
  changed.with((db) => { db.projects[0].name = 'After backup'; });
  changed.close();
  fs.writeFileSync(path.join(dataDir, 'assets', 'pixel.bin'), 'changed');
  fs.rmSync(path.join(dataDir, 'forge'), { recursive: true, force: true });
  fs.rmSync(path.join(dataDir, 'artifacts'), { recursive: true, force: true });
  fs.rmSync(path.join(dataDir, 'screenshots'), { recursive: true, force: true });
  backup('restore', '--backup', marker);

  const restored = new Store(dataDir);
  assert.equal(restored.get().projects[0].name, 'Before backup');
  const restoredAsset = new AssetService(restored.database, dataDir).get(realAsset.id);
  assert.ok(restoredAsset);
  assert.deepEqual(fs.readFileSync(restoredAsset.path), png);
  restored.close();
  assert.deepEqual(fs.readFileSync(path.join(dataDir, 'assets', 'pixel.bin')), Buffer.from([0, 1, 2, 3]));
  assert.match(fs.readFileSync(path.join(dataDir, 'forge', 'candidate', 'src', 'App.tsx'), 'utf8'), /function App/);
  assert.match(fs.readFileSync(path.join(dataDir, 'artifacts', 'preview.html'), 'utf8'), /Preview/);
  assert.deepEqual(fs.readFileSync(path.join(dataDir, 'screenshots', 'preview.png')), Buffer.from([4, 5, 6]));

  const tampered = path.join(marker, 'assets', 'pixel.bin');
  fs.writeFileSync(tampered, 'tampered');
  const rejected = spawnSync(process.execPath, ['scripts/backup.mjs', 'verify', '--backup', marker], { env: { ...process.env, MYPATH_DATA_DIR: dataDir }, encoding: 'utf8' });
  assert.notEqual(rejected.status, 0);
  assert.match(rejected.stderr, /checksum mismatch/);
  console.log('Backup/restore verification passed: DB + real AssetService blobs + assets + forge + artifacts + screenshots + tamper rejection');
} finally { fs.rmSync(dataDir, { recursive: true, force: true }); }
