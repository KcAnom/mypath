import crypto from 'node:crypto';
import { spawnSync } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';

const root = process.cwd();
const runtime = path.join(root, '.runtime');
const target = path.join(runtime, 'mypath');
const temporary = path.join(runtime, `mypath-${process.pid}.tmp`);
const pinned = fs.readFileSync(path.join(root, '.node-version'), 'utf8').trim().replace(/^v/, '');
const actual = process.versions.node;
if (actual !== pinned) throw new Error(`Pinned Node sidecar ${pinned} is required; current Node is ${actual}`);
const sidecarSource = path.resolve(process.env.MYPATH_NODE_SIDECAR || process.execPath);
if (!fs.existsSync(sidecarSource)) throw new Error(`Node sidecar does not exist: ${sidecarSource}`);
const sidecarVersion = spawnSync(sidecarSource, ['--version'], { encoding: 'utf8' });
if (sidecarVersion.status !== 0 || sidecarVersion.stdout.trim() !== `v${pinned}`) throw new Error(`Node sidecar must report exactly v${pinned}`);
if (!fs.existsSync(path.join(runtime, 'web', 'index.html'))) throw new Error('Run build:web before stage-runtime');
fs.rmSync(temporary, { recursive: true, force: true }); fs.mkdirSync(temporary, { recursive: true });
try {
  fs.cpSync(path.join(root, 'server'), path.join(temporary, 'server'), { recursive: true, filter: (source) => !source.includes(`${path.sep}.DS_Store`) });
  fs.cpSync(path.join(runtime, 'web'), path.join(temporary, '.runtime', 'web'), { recursive: true });
  fs.mkdirSync(path.join(temporary, 'bin'), { recursive: true });
  fs.copyFileSync(sidecarSource, path.join(temporary, 'bin', process.platform === 'win32' ? 'node.exe' : 'node'));
  if (process.platform !== 'win32') fs.chmodSync(path.join(temporary, 'bin', 'node'), 0o755);
  for (const name of ['package.json', 'package-lock.json', '.node-version']) fs.copyFileSync(path.join(root, name), path.join(temporary, name));
  const npmCli = process.env.npm_execpath && fs.existsSync(process.env.npm_execpath) ? process.env.npm_execpath : '';
  const install = npmCli
    ? spawnSync(process.execPath, [npmCli, 'ci', '--omit=dev', '--ignore-scripts', '--no-audit', '--no-fund'], { cwd: temporary, env: { ...process.env, NODE_ENV: 'production' }, stdio: 'inherit' })
    : spawnSync('npm', ['ci', '--omit=dev', '--ignore-scripts', '--no-audit', '--no-fund'], { cwd: temporary, env: { ...process.env, NODE_ENV: 'production' }, stdio: 'inherit' });
  if (install.status !== 0) throw new Error(`Production dependency staging failed (${install.status})`);
  // npm's command shims are symlinks and are not used by the embedded server; remove
  // them so the packaged resource tree is regular-file-only and fully checksummed.
  fs.rmSync(path.join(temporary, 'node_modules', '.bin'), { recursive: true, force: true });
  const files = [];
  const walk = (directory, prefix = '') => {
    for (const entry of fs.readdirSync(directory, { withFileTypes: true }).sort((a, b) => a.name.localeCompare(b.name))) {
      const absolute = path.join(directory, entry.name); const relative = path.posix.join(prefix, entry.name);
      if (entry.isSymbolicLink()) throw new Error(`Runtime stage refuses symlink: ${relative}`);
      if (entry.isDirectory()) walk(absolute, relative);
      else if (entry.isFile()) { const bytes = fs.readFileSync(absolute); files.push({ path: relative, size: bytes.length, sha256: crypto.createHash('sha256').update(bytes).digest('hex') }); }
      else throw new Error(`Runtime stage refuses special file: ${relative}`);
    }
  };
  walk(temporary);
  const manifest = { schema: 'MyPathRuntimeManifestV1', createdAt: new Date().toISOString(), nodeVersion: actual, platform: process.platform, architecture: process.arch, files };
  fs.writeFileSync(path.join(temporary, 'runtime-manifest.json'), JSON.stringify(manifest, null, 2));
  fs.rmSync(target, { recursive: true, force: true }); fs.renameSync(temporary, target);
  console.log(`Staged production runtime: ${target} (${files.length} checksummed files, Node ${actual} ${process.arch})`);
} catch (error) { fs.rmSync(temporary, { recursive: true, force: true }); throw error; }
