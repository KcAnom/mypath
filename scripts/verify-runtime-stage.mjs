import assert from 'node:assert/strict';
import crypto from 'node:crypto';
import { spawnSync } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';

const root = path.resolve('.runtime/mypath');
const manifestPath = path.join(root, 'runtime-manifest.json');
assert.ok(fs.existsSync(manifestPath), 'runtime manifest exists');
const manifest = JSON.parse(fs.readFileSync(manifestPath, 'utf8'));
assert.equal(manifest.schema, 'MyPathRuntimeManifestV1');
assert.equal(manifest.nodeVersion, fs.readFileSync('.node-version', 'utf8').trim().replace(/^v/, ''));
const expected = new Map(manifest.files.map((item) => [item.path, item]));
const actual = [];
const walk = (directory, prefix = '') => {
  for (const entry of fs.readdirSync(directory, { withFileTypes: true })) {
    const absolute = path.join(directory, entry.name); const relative = path.posix.join(prefix, entry.name);
    if (relative === 'runtime-manifest.json') continue;
    assert.equal(entry.isSymbolicLink(), false, `no runtime symlink: ${relative}`);
    if (entry.isDirectory()) walk(absolute, relative); else if (entry.isFile()) actual.push({ absolute, relative });
  }
};
walk(root); assert.equal(actual.length, expected.size, 'manifest covers every staged file');
for (const file of actual) { const record = expected.get(file.relative); assert.ok(record, `manifest contains ${file.relative}`); const bytes = fs.readFileSync(file.absolute); assert.equal(bytes.length, record.size); assert.equal(crypto.createHash('sha256').update(bytes).digest('hex'), record.sha256); }
for (const required of ['server/index.js', '.runtime/web/index.html', 'package.json', 'package-lock.json', 'bin/node', 'node_modules/vite/package.json', 'node_modules/react/package.json']) assert.ok(expected.has(required), `runtime includes ${required}`);
const node = path.join(root, 'bin', process.platform === 'win32' ? 'node.exe' : 'node');
const version = spawnSync(node, ['--version'], { env: { PATH: process.platform === 'win32' ? '' : '/usr/bin:/bin' }, encoding: 'utf8' });
assert.equal(version.status, 0); assert.equal(version.stdout.trim(), `v${manifest.nodeVersion}`);
console.log(`Runtime manifest verified: ${expected.size} files, pinned Node ${manifest.nodeVersion}, production dependencies and compiled web present`);
