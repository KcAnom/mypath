import crypto from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';

const MAX_ASSET_BYTES = 20 * 1024 * 1024;
const now = () => new Date().toISOString();
const sha = (bytes) => crypto.createHash('sha256').update(bytes).digest('hex');
const safeName = (name) => path.basename(String(name || 'upload')).replace(/[^a-zA-Z0-9._ -]/g, '_').slice(0, 120) || 'upload';

export function inspectAsset(input, declaredKind) {
  let bytes = Buffer.isBuffer(input) ? input : Buffer.from(input || []);
  if (!bytes.length || bytes.length > MAX_ASSET_BYTES) throw Object.assign(new Error(`Asset must be between 1 byte and ${MAX_ASSET_BYTES} bytes`), { code: 'asset_size_invalid' });
  const ascii = bytes.subarray(0, 256).toString('utf8').trimStart();
  let mediaType = ''; let kind = declaredKind;
  if (bytes.subarray(0, 8).equals(Buffer.from([137,80,78,71,13,10,26,10]))) { mediaType = 'image/png'; kind ||= 'image'; }
  else if (bytes[0] === 0xff && bytes[1] === 0xd8 && bytes[2] === 0xff) { mediaType = 'image/jpeg'; kind ||= 'image'; }
  else if (bytes.subarray(0, 6).toString('ascii').match(/^GIF8[79]a$/)) { mediaType = 'image/gif'; kind ||= 'image'; }
  else if (bytes.subarray(0, 4).toString('ascii') === 'RIFF' && bytes.subarray(8, 12).toString('ascii') === 'WEBP') { mediaType = 'image/webp'; kind ||= 'image'; }
  else if (bytes.subarray(0, 5).toString('ascii') === '%PDF-') { mediaType = 'application/pdf'; kind ||= 'document'; }
  else if (bytes.subarray(0, 4).toString('ascii') === 'wOFF') { mediaType = 'font/woff'; kind ||= 'font'; }
  else if (bytes.subarray(0, 4).toString('ascii') === 'wOF2') { mediaType = 'font/woff2'; kind ||= 'font'; }
  else if (bytes.subarray(0, 4).equals(Buffer.from([0,1,0,0]))) { mediaType = 'font/ttf'; kind ||= 'font'; }
  else if (bytes.subarray(0, 4).toString('ascii') === 'OTTO') { mediaType = 'font/otf'; kind ||= 'font'; }
  else if (/^<svg[\s>]/i.test(ascii)) {
    kind ||= 'image'; mediaType = 'image/svg+xml';
    let svg = bytes.toString('utf8');
    svg = svg.replace(/<script\b[^>]*>[\s\S]*?<\/script\s*>/gi, '').replace(/\son\w+\s*=\s*(?:"[^"]*"|'[^']*')/gi, '').replace(/\s(?:href|xlink:href)\s*=\s*(?:"(?:https?:|javascript:)[^"]*"|'(?:https?:|javascript:)[^']*')/gi, '');
    if (!/^\s*<svg[\s>]/i.test(svg) || /<!DOCTYPE|<!ENTITY/i.test(svg)) throw Object.assign(new Error('Unsafe SVG is not accepted'), { code: 'asset_unsafe' });
    bytes = Buffer.from(svg);
  }
  if (!mediaType || !['image','document','font'].includes(kind)) throw Object.assign(new Error('Unsupported asset; use PNG, JPEG, GIF, WebP, sanitized SVG, PDF, WOFF/WOFF2, TTF, or OTF'), { code: 'asset_type_invalid' });
  const expected = mediaType.startsWith('image/') ? 'image' : mediaType.startsWith('font/') ? 'font' : 'document';
  if (declaredKind && declaredKind !== expected) throw Object.assign(new Error(`File content is ${expected}, not ${declaredKind}`), { code: 'asset_kind_mismatch' });
  return { bytes, mediaType, kind: expected };
}

export class AssetService {
  constructor(database, dataDir) { this.db = database.db; this.dataDir = dataDir; this.root = path.join(dataDir, 'blobs'); fs.mkdirSync(this.root, { recursive: true, mode: 0o700 }); }
  ingest({ projectId = null, name, kind, bytes }) {
    const checked = inspectAsset(bytes, kind); const checksum = sha(checked.bytes); const storageKey = `${checksum.slice(0, 2)}/${checksum}`; const target = path.join(this.root, storageKey);
    fs.mkdirSync(path.dirname(target), { recursive: true, mode: 0o700 });
    if (!fs.existsSync(target)) { const temporary = `${target}.${process.pid}.tmp`; try { fs.writeFileSync(temporary, checked.bytes, { mode: 0o600, flag: 'wx' }); fs.renameSync(temporary, target); } finally { fs.rmSync(temporary, { force: true }); } }
    const stamp = now(); const id = `asset:${crypto.randomBytes(12).toString('hex')}`;
    this.db.prepare('INSERT OR IGNORE INTO asset_blobs(checksum,storage_key,media_type,byte_size,created_at) VALUES(?,?,?,?,?)').run(checksum, storageKey, checked.mediaType, checked.bytes.length, stamp);
    this.db.prepare('INSERT INTO asset_ingestions(id,project_id,checksum,kind,original_name,media_type,created_at) VALUES(?,?,?,?,?,?,?)').run(id, projectId, checksum, checked.kind, safeName(name), checked.mediaType, stamp);
    return this.get(id);
  }
  get(id) { const row = this.db.prepare('SELECT i.*,b.storage_key,b.byte_size FROM asset_ingestions i JOIN asset_blobs b ON b.checksum=i.checksum WHERE i.id=?').get(id); return row ? { id: row.id, projectId: row.project_id, checksum: row.checksum, kind: row.kind, name: row.original_name, mediaType: row.media_type, byteSize: row.byte_size, createdAt: row.created_at, tombstonedAt: row.tombstoned_at, path: path.join(this.root, row.storage_key) } : null; }
  list(projectId) { return this.db.prepare('SELECT id FROM asset_ingestions WHERE project_id=? AND tombstoned_at IS NULL ORDER BY created_at DESC').all(projectId).map(({ id }) => this.get(id)); }
  tombstone(id) { const result = this.db.prepare('UPDATE asset_ingestions SET tombstoned_at=? WHERE id=? AND tombstoned_at IS NULL').run(now(), id); return Boolean(result.changes); }
  verifiedBackup(backupPath) {
    let directory = backupPath ? path.resolve(backupPath) : '';
    if (!directory) {
      const marker = path.join(this.dataDir, '.mypath-last-backup');
      if (fs.existsSync(marker)) directory = path.resolve(fs.readFileSync(marker, 'utf8').trim());
    }
    if (!directory) return null;
    const backupsRoot = path.resolve(this.dataDir, 'backups');
    const relative = path.relative(backupsRoot, directory);
    if (!relative || relative.startsWith('..') || path.isAbsolute(relative)) throw Object.assign(new Error('GC backup must be inside the data/backups directory'), { status: 422, code: 'backup_invalid' });
    const manifestPath = path.join(directory, 'manifest.json');
    if (!fs.existsSync(manifestPath)) throw Object.assign(new Error('Verified backup manifest is required for blob GC'), { status: 422, code: 'backup_required' });
    const manifest = JSON.parse(fs.readFileSync(manifestPath, 'utf8'));
    if (manifest.format !== 3 || !Array.isArray(manifest.trees) || !manifest.trees.includes('blobs') || !Array.isArray(manifest.files) || !manifest.database || !manifest.databaseSha256) throw Object.assign(new Error('Backup does not include a checksummed database and blobs'), { status: 422, code: 'backup_incomplete' });
    const database = path.resolve(directory, manifest.database);
    if (!database.startsWith(`${directory}${path.sep}`) || !fs.existsSync(database) || sha(fs.readFileSync(database)) !== manifest.databaseSha256) throw Object.assign(new Error('Backup database checksum verification failed'), { status: 422, code: 'backup_checksum_invalid' });
    const files = new Map();
    for (const item of manifest.files) {
      const absolute = path.resolve(directory, ...String(item.path).split('/'));
      if (!absolute.startsWith(`${directory}${path.sep}`) || !fs.existsSync(absolute) || fs.statSync(absolute).size !== Number(item.size) || sha(fs.readFileSync(absolute)) !== item.sha256) throw Object.assign(new Error(`Backup payload checksum verification failed: ${item.path}`), { status: 422, code: 'backup_checksum_invalid' });
      files.set(item.path, item);
    }
    return { directory, createdAt: Date.parse(manifest.createdAt), files };
  }
  gc({ retentionMs = 30 * 24 * 60 * 60 * 1000, backupPath = '' } = {}) {
    const retention = Number(retentionMs);
    if (!Number.isFinite(retention) || retention < 0) throw Object.assign(new Error('retentionMs must be a non-negative number'), { status: 400, code: 'retention_invalid' });
    const backup = this.verifiedBackup(backupPath);
    if (!backup) return [];
    const removed = []; const cutoff = Date.now() - retention;
    for (const blob of this.db.prepare('SELECT * FROM asset_blobs').all()) {
      const active = this.db.prepare('SELECT 1 FROM asset_ingestions WHERE checksum=? AND tombstoned_at IS NULL').get(blob.checksum);
      const historical = this.db.prepare("SELECT 1 FROM context_references WHERE ref_type='asset' AND entity_id IN (SELECT id FROM asset_ingestions WHERE checksum=?)").get(blob.checksum);
      const tombstones = this.db.prepare('SELECT tombstoned_at FROM asset_ingestions WHERE checksum=?').all(blob.checksum);
      const retained = !tombstones.length || tombstones.some((item) => !item.tombstoned_at || Date.parse(item.tombstoned_at) > cutoff);
      const relative = `blobs/${String(blob.storage_key).split(path.sep).join('/')}`;
      const record = backup.files.get(relative); const backedUp = record && backup.createdAt >= Math.max(...tombstones.map((item) => Date.parse(item.tombstoned_at) || Infinity));
      const backupFile = record && path.join(backup.directory, ...relative.split('/'));
      const verified = backedUp && fs.existsSync(backupFile) && fs.statSync(backupFile).size === Number(record.size) && sha(fs.readFileSync(backupFile)) === record.sha256 && record.sha256 === blob.checksum;
      if (!active && !historical && !retained && verified) {
        this.db.exec('BEGIN IMMEDIATE');
        try {
          fs.rmSync(path.join(this.root, blob.storage_key), { force: true });
          this.db.prepare('DELETE FROM asset_ingestions WHERE checksum=?').run(blob.checksum);
          this.db.prepare('DELETE FROM asset_blobs WHERE checksum=?').run(blob.checksum);
          this.db.exec('COMMIT'); removed.push(blob.checksum);
        } catch (error) { this.db.exec('ROLLBACK'); throw error; }
      }
    }
    return removed;
  }
}
