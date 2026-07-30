import assert from 'node:assert/strict';
import { spawn, spawnSync } from 'node:child_process';
import crypto from 'node:crypto';
import fs from 'node:fs';
import http from 'node:http';
import net from 'node:net';
import os from 'node:os';
import path from 'node:path';

const delay = (ms) => new Promise((resolve) => setTimeout(resolve, ms));
const request = (port, route, headers = {}) => new Promise((resolve, reject) => {
  const req = http.get({ hostname: '127.0.0.1', port, path: route, headers: { Host: `127.0.0.1:${port}`, ...headers } }, (res) => {
    const chunks = []; res.on('data', (chunk) => chunks.push(chunk)); res.on('end', () => resolve({ status: res.statusCode, body: Buffer.concat(chunks).toString('utf8') }));
  });
  req.on('error', reject);
});
const alive = (pid) => { try { process.kill(pid, 0); return true; } catch (error) { return error.code === 'EPERM'; } };

if (process.platform !== 'darwin') throw new Error('desktop:smoke:clean currently verifies the configured macOS .app bundle and requires macOS');

// The smoke owns the package build so it can never accidentally certify a stale
// hand-edited bundle. build:prod refreshes .runtime and Tauri copies that stage.
const npmCli = process.env.npm_execpath && fs.existsSync(process.env.npm_execpath) ? process.env.npm_execpath : null;
const build = npmCli
  ? spawnSync(process.execPath, [npmCli, 'run', 'desktop:build'], { cwd: process.cwd(), env: process.env, stdio: 'inherit' })
  : spawnSync('npm', ['run', 'desktop:build'], { cwd: process.cwd(), env: process.env, stdio: 'inherit' });
assert.equal(build.status, 0, `actual Tauri .app build failed${build.error ? `: ${build.error.message}` : ''}`);

const app = path.resolve('src-tauri/target/release/bundle/macos/MyPath.app');
const executable = path.join(app, 'Contents', 'MacOS', 'mypath');
const resources = path.join(app, 'Contents', 'Resources', 'resources', 'mypath');
const manifestPath = path.join(resources, 'runtime-manifest.json');
for (const required of [app, executable, resources, manifestPath]) assert.ok(fs.existsSync(required), `packaged artifact exists: ${required}`);

const manifest = JSON.parse(fs.readFileSync(manifestPath, 'utf8'));
assert.equal(manifest.schema, 'MyPathRuntimeManifestV1');
assert.equal(manifest.nodeVersion, fs.readFileSync('.node-version', 'utf8').trim().replace(/^v/, ''));
assert.equal(manifest.platform, process.platform); assert.equal(manifest.architecture, process.arch);
const expected = new Map(manifest.files.map((item) => [item.path, item]));
const actual = [];
const walk = (directory, prefix = '') => {
  for (const entry of fs.readdirSync(directory, { withFileTypes: true })) {
    const absolute = path.join(directory, entry.name); const relative = path.posix.join(prefix, entry.name);
    if (relative === 'runtime-manifest.json') continue;
    assert.equal(entry.isSymbolicLink(), false, `bundle runtime contains no symlink: ${relative}`);
    if (entry.isDirectory()) walk(absolute, relative);
    else if (entry.isFile()) actual.push({ absolute, relative });
    else assert.fail(`bundle runtime contains special file: ${relative}`);
  }
};
walk(resources);
assert.equal(actual.length, expected.size, 'bundle resource placement exactly matches the runtime manifest');
for (const file of actual) {
  const record = expected.get(file.relative); assert.ok(record, `runtime manifest covers ${file.relative}`);
  const bytes = fs.readFileSync(file.absolute); assert.equal(bytes.length, record.size, `${file.relative} size`);
  assert.equal(crypto.createHash('sha256').update(bytes).digest('hex'), record.sha256, `${file.relative} checksum`);
}
for (const required of ['server/index.js', '.runtime/web/index.html', 'package.json', 'package-lock.json', 'bin/node']) assert.ok(expected.has(required), `bundle contains ${required}`);
const packagedJson = JSON.parse(fs.readFileSync(path.join(resources, 'package.json'), 'utf8'));
for (const dependency of Object.keys(packagedJson.dependencies || {})) assert.ok(expected.has(`node_modules/${dependency}/package.json`), `bundle contains production dependency ${dependency}`);
const packagedNode = path.join(resources, 'bin', 'node');
const nodeVersion = spawnSync(packagedNode, ['--version'], { env: { HOME: os.tmpdir(), PATH: '/usr/bin:/bin' }, encoding: 'utf8' });
assert.equal(nodeVersion.status, 0); assert.equal(nodeVersion.stdout.trim(), `v${manifest.nodeVersion}`);

const temporary = fs.mkdtempSync(path.join(os.tmpdir(), 'mypath-packaged-app-smoke-'));
const data = path.join(temporary, 'data'); const descriptorPath = path.join(temporary, 'desktop-startup.json');
let decoy = null; let child = null; let descriptor = null; let stderr = '';
try {
  decoy = net.createServer((socket) => socket.end('HTTP/1.1 200 OK\r\nContent-Length: 2\r\n\r\n{}'));
  await new Promise((resolve, reject) => { decoy.once('error', reject); decoy.listen(8787, '127.0.0.1', resolve); }).catch((error) => { if (error.code !== 'EADDRINUSE') throw error; decoy = null; });

  const env = { ...process.env, HOME: temporary, PATH: '/usr/bin:/bin', NODE_ENV: 'production', MYPATH_DATA_DIR: data, MYPATH_DESKTOP_SMOKE_DESCRIPTOR: descriptorPath };
  for (const name of ['MYPATH_ROOT', 'MYPATH_NODE', 'MYPATH_API_PORT', 'PORT']) delete env[name];
  child = spawn(executable, [], { cwd: temporary, env, stdio: ['ignore', 'ignore', 'pipe'] });
  child.stderr.on('data', (chunk) => { stderr += chunk; });
  for (let attempt = 0; attempt < 600 && !fs.existsSync(descriptorPath); attempt++) { if (child.exitCode != null) break; await delay(25); }
  assert.ok(fs.existsSync(descriptorPath), `packaged app wrote its authenticated startup descriptor (${stderr})`);
  descriptor = JSON.parse(fs.readFileSync(descriptorPath, 'utf8'));
  assert.equal(descriptor.schema, 'MyPathDesktopSmokeDescriptorV1'); assert.equal(descriptor.desktopPid, child.pid);
  assert.ok(Number.isInteger(descriptor.serverPid) && descriptor.serverPid > 0); assert.ok(Number.isInteger(descriptor.port) && descriptor.port > 0);
  assert.notEqual(descriptor.port, 8787, 'packaged app selected a dynamic port rather than attaching to the fixed-port decoy');
  assert.match(descriptor.instanceNonce, /^[a-f0-9]{64}$/);

  const health = await request(descriptor.port, '/health', { 'X-MyPath-Instance': descriptor.instanceNonce });
  assert.equal(health.status, 200); assert.equal(JSON.parse(health.body).instanceAuthenticated, true);
  const unauthenticated = await request(descriptor.port, '/api/v1/projects'); assert.equal(unauthenticated.status, 401);
  const bootstrap = await request(descriptor.port, '/api/session', { 'X-MyPath-Instance': descriptor.instanceNonce });
  assert.equal(bootstrap.status, 200); const session = JSON.parse(bootstrap.body); assert.match(session.token, /^[A-Za-z0-9_-]+$/);
  const authenticated = await request(descriptor.port, '/api/v1/projects', { 'X-MyPath-Session': session.token });
  assert.equal(authenticated.status, 200); assert.ok(Array.isArray(JSON.parse(authenticated.body)));

  child.kill('SIGTERM');
  await Promise.race([new Promise((resolve) => child.once('exit', resolve)), delay(5000)]);
  assert.notEqual(child.exitCode, null, 'packaged app exits on SIGTERM');
  for (let attempt = 0; attempt < 100 && alive(descriptor.serverPid); attempt++) await delay(25);
  assert.equal(alive(descriptor.serverPid), false, 'packaged Node server shuts down with the app');
  assert.equal(fs.existsSync(path.join(data, 'desktop-server.pid')), false, 'packaged app clears its owned-server pidfile');
  console.log(`Actual ${app} smoke passed: ${expected.size} manifested resources, pinned Node ${manifest.nodeVersion}, authenticated dynamic port ${descriptor.port}, clean shutdown`);
} finally {
  if (child && child.exitCode == null) { child.kill('SIGKILL'); await Promise.race([new Promise((resolve) => child.once('exit', resolve)), delay(1000)]); }
  if (descriptor?.serverPid && alive(descriptor.serverPid)) { try { process.kill(descriptor.serverPid, 'SIGKILL'); } catch {} }
  if (decoy) await new Promise((resolve) => decoy.close(resolve));
  fs.rmSync(temporary, { recursive: true, force: true });
}
