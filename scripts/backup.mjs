import crypto from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import { acquireDataLock } from '../server/src/db/data-lock.js';

const args = process.argv.slice(3);
const flag = (name, fallback = '') => { const i = args.indexOf(`--${name}`); return i >= 0 ? args[i + 1] : fallback; };
const action = process.argv[2];
const dataDir = path.resolve(process.env.MYPATH_DATA_DIR || 'data');
const backupsDir = path.join(dataDir, 'backups');
const TREES = ['blobs', 'assets', 'forge', 'artifacts', 'screenshots'];
const sha256 = (file) => crypto.createHash('sha256').update(fs.readFileSync(file)).digest('hex');
const safe = (value) => String(value).replace(/'/g, "''");

function walkFiles(root, prefix = '') {
  if (!fs.existsSync(root)) return [];
  const results = [];
  for (const entry of fs.readdirSync(root, { withFileTypes: true }).sort((a, b) => a.name.localeCompare(b.name))) {
    const absolute = path.join(root, entry.name);
    const relative = path.posix.join(prefix, entry.name);
    if (entry.isSymbolicLink()) throw new Error(`Backup refuses symlink: ${absolute}`);
    if (entry.isDirectory()) results.push(...walkFiles(absolute, relative));
    else if (entry.isFile()) results.push({ absolute, relative });
    else throw new Error(`Backup refuses special file: ${absolute}`);
  }
  return results;
}

function copyTrees(destination) {
  const files = [];
  for (const tree of TREES) {
    const sourceRoot = path.join(dataDir, tree);
    const destinationRoot = path.join(destination, tree);
    fs.mkdirSync(destinationRoot, { recursive: true });
    for (const file of walkFiles(sourceRoot, tree)) {
      const target = path.join(destination, ...file.relative.split('/'));
      fs.mkdirSync(path.dirname(target), { recursive: true });
      fs.copyFileSync(file.absolute, target);
      files.push({ path: file.relative, size: fs.statSync(target).size, sha256: sha256(target) });
    }
  }
  return files;
}

function latestBackup() {
  if (!fs.existsSync(backupsDir)) throw new Error('No backups directory exists');
  const entries = fs.readdirSync(backupsDir).map((name) => path.join(backupsDir, name)).filter((item) => fs.statSync(item).isDirectory()).sort();
  if (!entries.length) throw new Error('No backups exist');
  return entries.at(-1);
}
function resolveBackup() {
  const requested = flag('backup');
  if (requested) return path.resolve(requested);
  if (args.includes('--latest')) return latestBackup();
  throw new Error('Use --backup <path> or --latest');
}
function manifestFor(directory) {
  const manifestPath = path.join(directory, 'manifest.json');
  if (!fs.existsSync(manifestPath)) throw new Error(`Missing backup manifest: ${manifestPath}`);
  return JSON.parse(fs.readFileSync(manifestPath, 'utf8'));
}
function verify(directory) {
  const manifest = manifestFor(directory);
  if (manifest.format !== 3 || !Array.isArray(manifest.files) || !Array.isArray(manifest.trees)) throw new Error('Backup predates complete data/blob recovery format 3');
  if (JSON.stringify(manifest.trees) !== JSON.stringify(TREES)) throw new Error('Backup tree manifest is incomplete');
  const dbPath = path.join(directory, manifest.database || 'db.sqlite');
  if (!fs.existsSync(dbPath)) throw new Error(`Missing backup database: ${dbPath}`);
  if (sha256(dbPath) !== manifest.databaseSha256) throw new Error('Backup database checksum does not match its manifest');
  const expected = new Map(manifest.files.map((file) => [file.path, file]));
  const actual = TREES.flatMap((tree) => walkFiles(path.join(directory, tree), tree));
  if (actual.length !== expected.size) throw new Error('Backup payload file count does not match its manifest');
  for (const file of actual) {
    const record = expected.get(file.relative);
    if (!record || fs.statSync(file.absolute).size !== record.size || sha256(file.absolute) !== record.sha256) throw new Error(`Backup payload checksum mismatch: ${file.relative}`);
  }
  const db = new DatabaseSync(dbPath, { readOnly: true });
  const integrity = db.prepare('PRAGMA integrity_check').get().integrity_check;
  db.close();
  if (integrity !== 'ok') throw new Error(`SQLite integrity check failed: ${integrity}`);
  return { directory, dbPath, manifest, integrity };
}
function assertStopped() {
  for (const name of ['server.pid', 'desktop-server.pid']) {
    const pidFile = path.join(dataDir, name);
    if (!fs.existsSync(pidFile)) continue;
    const raw = fs.readFileSync(pidFile, 'utf8').trim();
    let pid = Number(raw);
    if (!pid) { try { pid = Number(JSON.parse(raw).pid); } catch {} }
    if (pid) {
      try { process.kill(pid, 0); throw new Error(`Refusing restore while server PID ${pid} is running`); }
      catch (error) { if (error.code !== 'ESRCH') throw error; }
    }
    fs.rmSync(pidFile, { force: true });
  }
}

if (action === 'create') {
  const release = acquireDataLock(dataDir, 'backup-create');
  try {
    const source = path.join(dataDir, 'db.sqlite');
    if (!fs.existsSync(source)) throw new Error(`SQLite database does not exist: ${source}`);
    fs.mkdirSync(backupsDir, { recursive: true });
    const stamp = new Date().toISOString().replace(/[:.]/g, '-');
    const label = flag('label', 'manual').replace(/[^A-Za-z0-9._-]/g, '-');
    const directory = path.join(backupsDir, `${stamp}-${label}`);
    fs.mkdirSync(directory, { recursive: false });
    try {
      const destination = path.join(directory, 'db.sqlite');
      const db = new DatabaseSync(source);
      db.exec('PRAGMA wal_checkpoint(PASSIVE)');
      db.exec(`VACUUM INTO '${safe(destination)}'`);
      db.close();
      const files = copyTrees(directory);
      const manifest = { format: 3, createdAt: new Date().toISOString(), label, database: 'db.sqlite', databaseSha256: sha256(destination), trees: TREES, files };
      fs.writeFileSync(path.join(directory, 'manifest.json'), JSON.stringify(manifest, null, 2));
      verify(directory);
      // AssetService discovers the default verified backup marker in the data
      // directory, so creation must always publish it there as well.
      const marker = path.join(dataDir, '.mypath-last-backup');
      fs.writeFileSync(marker, `${directory}\n`);
      console.log(`Created and verified complete backup: ${directory} (${files.length} payload files)`);
    } catch (error) { fs.rmSync(directory, { recursive: true, force: true }); throw error; }
  } finally { release(); }
} else if (action === 'verify') {
  const result = verify(resolveBackup());
  console.log(`Complete backup verified: ${result.directory} (${result.integrity}, ${result.manifest.files.length} payload files)`);
} else if (action === 'restore') {
  assertStopped();
  const result = verify(resolveBackup());
  const release = acquireDataLock(dataDir, 'backup-restore');
  try {
    fs.mkdirSync(dataDir, { recursive: true });
    const stageRoot = path.join(dataDir, `.restore-stage-${process.pid}`);
    fs.rmSync(stageRoot, { recursive: true, force: true });
    fs.mkdirSync(stageRoot, { recursive: true });
    const dbTemporary = path.join(stageRoot, 'db.sqlite');
    fs.copyFileSync(result.dbPath, dbTemporary);
    for (const tree of TREES) fs.cpSync(path.join(result.directory, tree), path.join(stageRoot, tree), { recursive: true });
    for (const tree of TREES) {
      const destination = path.join(dataDir, tree);
      fs.rmSync(destination, { recursive: true, force: true });
      fs.renameSync(path.join(stageRoot, tree), destination);
    }
    const destination = path.join(dataDir, 'db.sqlite');
    fs.renameSync(dbTemporary, destination);
    for (const suffix of ['-wal', '-shm']) fs.rmSync(destination + suffix, { force: true });
    fs.rmSync(stageRoot, { recursive: true, force: true });
    const restored = new DatabaseSync(destination, { readOnly: true });
    const integrity = restored.prepare('PRAGMA integrity_check').get().integrity_check;
    restored.close();
    if (integrity !== 'ok') throw new Error(`Restored database failed integrity check: ${integrity}`);
    console.log(`Restored complete verified backup: ${result.directory}`);
  } finally { release(); }
} else throw new Error('Usage: node scripts/backup.mjs create|verify|restore');
