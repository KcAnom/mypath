import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';
import { resolveForgePath, validateForgeRelativePath, writeForgeFiles } from '../server/src/security/forge-path.js';

const invalid = ['/tmp/pwn', '../pwn', 'src/../pwn', 'src\\App.tsx', 'package.json', 'src/other.tsx', 'assets/../../pwn'];
for (const value of invalid) test(`forge rejects ${value}`, () => assert.throws(() => validateForgeRelativePath(value), { code: 'forge_path_invalid' }));

test('forge accepts only intended source and asset paths', () => {
  assert.equal(validateForgeRelativePath('src/App.tsx'), 'src/App.tsx');
  assert.equal(validateForgeRelativePath('src/components/generated/Card.tsx'), 'src/components/generated/Card.tsx');
  assert.equal(validateForgeRelativePath('assets/icon.svg'), 'assets/icon.svg');
});

test('forge rejects symlink escape and validates all paths before writing', () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'mypath-forge-'));
  fs.mkdirSync(path.join(root, 'component'), { recursive: true });
  fs.symlinkSync(os.tmpdir(), path.join(root, 'component', 'assets'));
  assert.throws(() => resolveForgePath(root, 'component', 'assets/escape.txt'), { code: 'forge_path_invalid' });
  assert.throws(() => writeForgeFiles(root, 'safe', { 'src/App.tsx': 'ok', '../escape': 'bad' }), { code: 'forge_path_invalid' });
  assert.equal(fs.existsSync(path.join(root, 'safe', 'src', 'App.tsx')), false);
  fs.rmSync(root, { recursive: true, force: true });
});
