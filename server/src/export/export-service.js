import crypto from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.resolve(HERE, '../../..');
const now = () => new Date().toISOString();
const sha = (value) => crypto.createHash('sha256').update(value).digest('hex');
const id = () => crypto.randomBytes(18).toString('base64url');
const decode = (value, fallback = null) => { try { return JSON.parse(value); } catch { return fallback; } };
const stable = (value) => Array.isArray(value) ? `[${value.map(stable).join(',')}]` : value && typeof value === 'object' ? `{${Object.keys(value).sort().map((key) => `${JSON.stringify(key)}:${stable(value[key])}`).join(',')}}` : JSON.stringify(value);

function safePath(value) {
  const normalized = path.posix.normalize(String(value || '').replaceAll('\\', '/'));
  if (!normalized || normalized === '.' || normalized.startsWith('../') || path.posix.isAbsolute(normalized) || normalized.includes('\0')) throw Object.assign(new Error(`Unsafe export path: ${value}`), { status: 422, code: 'export_path_invalid' });
  return normalized;
}
function safeName(value) { return String(value || 'mypath-export').replace(/[^A-Za-z0-9._-]+/g, '-').replace(/^-+|-+$/g, '').slice(0, 64) || 'mypath-export'; }
function crc32(bytes) { let crc = 0xffffffff; for (const byte of bytes) { crc ^= byte; for (let bit = 0; bit < 8; bit++) crc = crc & 1 ? 0xedb88320 ^ (crc >>> 1) : crc >>> 1; } return (crc ^ 0xffffffff) >>> 0; }

/** Deterministic, stored ZIP: sorted entries, fixed DOS epoch, no platform metadata. */
export function createZip(inputEntries) {
  const entries = [...inputEntries].sort((a, b) => a.path.localeCompare(b.path)).map((entry) => ({ path: safePath(entry.path), bytes: Buffer.isBuffer(entry.bytes) ? entry.bytes : Buffer.from(entry.bytes) }));
  const locals = []; const centrals = []; let offset = 0;
  for (const entry of entries) {
    const name = Buffer.from(entry.path, 'utf8'); const crc = crc32(entry.bytes);
    const local = Buffer.alloc(30); local.writeUInt32LE(0x04034b50); local.writeUInt16LE(20, 4); local.writeUInt16LE(0x800, 6); local.writeUInt32LE(crc, 14); local.writeUInt32LE(entry.bytes.length, 18); local.writeUInt32LE(entry.bytes.length, 22); local.writeUInt16LE(name.length, 26);
    locals.push(local, name, entry.bytes);
    const central = Buffer.alloc(46); central.writeUInt32LE(0x02014b50); central.writeUInt16LE(20, 4); central.writeUInt16LE(20, 6); central.writeUInt16LE(0x800, 8); central.writeUInt32LE(crc, 16); central.writeUInt32LE(entry.bytes.length, 20); central.writeUInt32LE(entry.bytes.length, 24); central.writeUInt16LE(name.length, 28); central.writeUInt32LE(offset, 42);
    centrals.push(central, name); offset += local.length + name.length + entry.bytes.length;
  }
  const centralBytes = Buffer.concat(centrals); const eocd = Buffer.alloc(22); eocd.writeUInt32LE(0x06054b50); eocd.writeUInt16LE(entries.length, 8); eocd.writeUInt16LE(entries.length, 10); eocd.writeUInt32LE(centralBytes.length, 12); eocd.writeUInt32LE(offset, 16);
  return Buffer.concat([...locals, centralBytes, eocd]);
}
function inside(root, target) { const relative = path.relative(root, target); return relative === '' || (!relative.startsWith(`..${path.sep}`) && relative !== '..' && !path.isAbsolute(relative)); }
function installedVersion(name) { return JSON.parse(fs.readFileSync(path.join(ROOT, 'node_modules', name, 'package.json'), 'utf8')).version; }

export class ExportService {
  constructor(store, assets) { this.store = store; this.db = store.database.db; this.assets = assets; }

  createDestinationGrant(rawPath, ttlMs = 5 * 60_000) {
    const requested = path.resolve(String(rawPath || ''));
    let canonical;
    try { canonical = fs.realpathSync(requested); } catch { throw Object.assign(new Error('Export destination must be an existing directory'), { status: 422, code: 'export_destination_invalid' }); }
    if (!fs.statSync(canonical).isDirectory()) throw Object.assign(new Error('Export destination must be a directory'), { status: 422, code: 'export_destination_invalid' });
    const grant = { id: id(), canonicalPath: canonical, expiresAt: new Date(Date.now() + Math.max(1_000, Math.min(10 * 60_000, ttlMs))).toISOString(), createdAt: now() };
    this.db.prepare('INSERT INTO export_destination_grants(id,canonical_path,expires_at,created_at) VALUES(?,?,?,?)').run(grant.id, grant.canonicalPath, grant.expiresAt, grant.createdAt);
    return { id: grant.id, expiresAt: grant.expiresAt };
  }

  contextFor(revision) {
    const snapshot = revision.contextSnapshotId ? this.db.prepare('SELECT envelope_json,content_checksum FROM context_snapshots WHERE id=?').get(revision.contextSnapshotId) : null;
    const envelope = snapshot ? decode(snapshot.envelope_json, {}) : null;
    return {
      contextSnapshotId: revision.contextSnapshotId || null, contextChecksum: snapshot?.content_checksum || null,
      designSystemVersionId: revision.designSystemVersionId || null, designSystemChecksum: revision.designSystemChecksum || null,
      libraryRevisionContext: revision.libraryRevisionContext || [], skillVersionIds: revision.skillVersionIds || [], fontIds: revision.fontIds || [], envelope,
    };
  }

  packageFor(revisionId) {
    const state = this.store.get(); const revision = state.revisions.find((item) => item.id === revisionId); const component = revision && state.components.find((item) => item.id === revision.componentId); const project = component && state.projects.find((item) => item.id === component.projectId);
    if (!revision || revision.status !== 'completed' || !component || component.deletedAt || !project || project.deletedAt) throw Object.assign(new Error('Only a completed revision can be exported'), { status: 422, code: 'revision_not_exportable' });
    const files = revision.files && typeof revision.files === 'object' ? revision.files : {}; const entries = [];
    for (const [name, content] of Object.entries(files)) {
      const target = safePath(name); const text = String(content); entries.push({ path: target, bytes: target.startsWith('assets/') && text.startsWith('base64:') ? Buffer.from(text.slice(7), 'base64') : Buffer.from(text) });
    }
    const candidates = Object.keys(files); const app = candidates.includes('src/App.tsx') ? './App.tsx' : candidates.includes('src/App.jsx') ? './App.jsx' : './' + path.posix.relative('src', candidates.find((name) => /\.(?:tsx|jsx)$/.test(name)) || 'App.tsx');
    const unused = (stem, extension) => { let index = 0; let candidate; do { candidate = `src/${stem}${index ? `-${index}` : ''}.${extension}`; index += 1; } while (candidates.includes(candidate)); return candidate; };
    const mainPath = unused('__mypath_export_main', 'tsx'); const tailwindPath = unused('__mypath_export_tailwind', 'css');
    const rootPackage = JSON.parse(fs.readFileSync(path.join(ROOT, 'package.json'), 'utf8'));
    const packageJson = { name: safeName(`${project.name}-${component.name || component.generatedName}`), version: '1.0.0', private: true, type: 'module', scripts: { dev: 'vite', build: 'vite build', preview: 'vite preview' }, engines: rootPackage.engines, dependencies: rootPackage.dependencies, devDependencies: rootPackage.devDependencies };
    entries.push(
      { path: 'package.json', bytes: Buffer.from(`${JSON.stringify(packageJson, null, 2)}\n`) },
      { path: 'package-lock.json', bytes: fs.readFileSync(path.join(ROOT, 'package-lock.json')) },
      { path: 'index.html', bytes: Buffer.from(`<!doctype html>\n<html><head><meta charset="UTF-8"><meta name="viewport" content="width=device-width,initial-scale=1.0"><title>MyPath export</title></head><body><div id="root"></div><script type="module" src="/${mainPath}"></script></body></html>\n`) },
      { path: mainPath, bytes: Buffer.from(`import React from 'react';\nimport { createRoot } from 'react-dom/client';\nimport App from ${JSON.stringify(app)};\nimport ${JSON.stringify('./' + path.posix.basename(tailwindPath))};\n${files['src/index.css'] ? "import './index.css';\n" : ''}createRoot(document.getElementById('root')!).render(<React.StrictMode><App /></React.StrictMode>);\n`) },
      { path: tailwindPath, bytes: Buffer.from('@import "tailwindcss";\n') },
      { path: 'vite.config.ts', bytes: Buffer.from("import { defineConfig } from 'vite';\nimport react from '@vitejs/plugin-react';\nimport tailwindcss from '@tailwindcss/vite';\nexport default defineConfig({ plugins: [react(), tailwindcss()] });\n") },
      { path: 'tsconfig.json', bytes: Buffer.from('{"compilerOptions":{"target":"ES2022","useDefineForClassFields":true,"lib":["ES2022","DOM","DOM.Iterable"],"allowJs":true,"skipLibCheck":true,"esModuleInterop":true,"allowSyntheticDefaultImports":true,"strict":true,"forceConsistentCasingInFileNames":true,"module":"ESNext","moduleResolution":"Bundler","resolveJsonModule":true,"isolatedModules":true,"noEmit":true,"jsx":"react-jsx","allowImportingTsExtensions":true},"include":["src"],"exclude":["dist"]}\n') },
    );
    const context = this.contextFor(revision); entries.push({ path: 'mypath/context.json', bytes: Buffer.from(`${stable(context)}\n`) });
    if (context.designSystemVersionId) {
      const design = this.db.prepare('SELECT prompt_text,light_json,dark_json,font_refs_json FROM design_system_compilations WHERE version_id=?').get(context.designSystemVersionId);
      if (design) entries.push({ path: 'mypath/DESIGN.md', bytes: Buffer.from(`${design.prompt_text}\n\n## Compiled token context\n\n\`\`\`json\n${JSON.stringify({ light: decode(design.light_json, {}), dark: decode(design.dark_json, {}), fonts: decode(design.font_refs_json, []) }, null, 2)}\n\`\`\`\n`) });
    }
    for (const versionId of context.skillVersionIds) { const row = this.db.prepare('SELECT name,content,content_checksum FROM skill_versions WHERE id=?').get(versionId); if (row) entries.push({ path: `mypath/skills/${safeName(row.name)}-${safeName(versionId)}.md`, bytes: Buffer.from(`${row.content}\n`) }); }
    const assetRefs = context.envelope?.assetRefs || []; const bundledContextAssets = new Set();
    for (const ref of assetRefs) { const asset = this.assets.get(ref.assetId); const assetPath = asset ? `assets/context/${asset.checksum}-${safeName(asset.name)}` : ''; if (asset && !asset.tombstonedAt && !bundledContextAssets.has(assetPath)) { bundledContextAssets.add(assetPath); entries.push({ path: assetPath, bytes: fs.readFileSync(asset.path) }); } }
    const duplicate = new Set(); for (const entry of entries) { if (duplicate.has(entry.path)) throw Object.assign(new Error(`Duplicate export path: ${entry.path}`), { code: 'export_path_collision' }); duplicate.add(entry.path); }
    const dependencies = Object.fromEntries([...Object.keys(packageJson.dependencies), ...Object.keys(packageJson.devDependencies)].sort().map((name) => [name, installedVersion(name)]));
    const payloadFiles = [...entries].sort((a, b) => a.path.localeCompare(b.path)).map((entry) => ({ path: entry.path, bytes: entry.bytes.length, sha256: sha(entry.bytes) }));
    const core = { schema: 'MyPathExportManifestV1', revisionId: revision.id, componentId: component.id, projectId: project.id, sourceCreatedAt: revision.createdAt, sourceChecksum: sha(Object.entries(files).sort(([a], [b]) => a.localeCompare(b)).map(([name, content]) => `${name}\0${content}`).join('\0')), dependencies, context: { contextSnapshotId: context.contextSnapshotId, contextChecksum: context.contextChecksum, designSystemVersionId: context.designSystemVersionId, designSystemChecksum: context.designSystemChecksum, libraryRevisionContext: context.libraryRevisionContext, skillVersionIds: context.skillVersionIds, fontIds: context.fontIds }, files: payloadFiles };
    const manifest = { ...core, manifestChecksum: sha(stable(core)) }; entries.push({ path: 'mypath/export-manifest.json', bytes: Buffer.from(`${stable(manifest)}\n`) });
    entries.push({ path: 'README.md', bytes: Buffer.from(`# ${component.name || component.generatedName}\n\nImmutable MyPath revision \`${revision.id}\` from project **${project.name}**.\n\n## Run\n\n\`\`\`sh\nnpm ci\nnpm run build\nnpm run dev\n\`\`\`\n\nThe exact React/TypeScript/Tailwind dependency graph is pinned by \`package-lock.json\`. Original revision source, local assets/fonts, design-system compilation, skills, library revision references, and context provenance are included. Verify file hashes in \`mypath/export-manifest.json\`.\n`) });
    const zip = createZip(entries); const archiveChecksum = sha(zip); const manifestId = `export:${manifest.manifestChecksum}`;
    this.db.prepare('INSERT OR IGNORE INTO export_manifests(id,revision_id,project_id,component_id,archive_checksum,manifest_checksum,manifest_json,created_at) VALUES(?,?,?,?,?,?,?,?)').run(manifestId, revision.id, project.id, component.id, archiveChecksum, manifest.manifestChecksum, stable(manifest), now());
    const existing = this.db.prepare('SELECT * FROM export_manifests WHERE revision_id=?').get(revision.id);
    if (existing.archive_checksum !== archiveChecksum || existing.manifest_checksum !== manifest.manifestChecksum) throw Object.assign(new Error('Immutable export no longer reproduces its recorded manifest'), { status: 409, code: 'export_reproducibility_conflict' });
    return { zip, entries, manifest, archiveChecksum, filename: `${safeName(component.name || component.generatedName)}-${revision.id.slice(0, 10)}.zip`, directoryName: `${safeName(component.name || component.generatedName)}-${revision.id.slice(0, 10)}` };
  }

  exportToGrantedDestination(revisionId, grantId) {
    const output = this.packageFor(revisionId); const grant = this.db.prepare('SELECT * FROM export_destination_grants WHERE id=?').get(String(grantId || ''));
    if (!grant || grant.consumed_at || Date.parse(grant.expires_at) <= Date.now()) throw Object.assign(new Error('Export destination grant is missing, expired, or already used'), { status: 403, code: 'export_destination_grant_invalid' });
    let canonical; try { canonical = fs.realpathSync(grant.canonical_path); } catch { throw Object.assign(new Error('Granted export destination is unavailable'), { status: 422, code: 'export_destination_invalid' }); }
    if (canonical !== grant.canonical_path || !fs.statSync(canonical).isDirectory()) throw Object.assign(new Error('Granted export destination changed after approval'), { status: 403, code: 'export_destination_changed' });
    const target = path.join(canonical, output.directoryName); if (!inside(canonical, target) || fs.existsSync(target)) throw Object.assign(new Error('The deterministic export directory already exists'), { status: 409, code: 'export_destination_exists' });
    const consumed = this.db.prepare('UPDATE export_destination_grants SET consumed_at=? WHERE id=? AND consumed_at IS NULL AND expires_at>?').run(now(), grant.id, now());
    if (!consumed.changes) throw Object.assign(new Error('Export destination grant was already consumed'), { status: 409, code: 'export_destination_grant_consumed' });
    try { fs.mkdirSync(target, { mode: 0o700 }); for (const entry of output.entries) { const destination = path.join(target, ...safePath(entry.path).split('/')); if (!inside(target, destination)) throw new Error('Export containment failure'); fs.mkdirSync(path.dirname(destination), { recursive: true, mode: 0o700 }); fs.writeFileSync(destination, entry.bytes, { flag: 'wx', mode: 0o600 }); } }
    catch (error) { fs.rmSync(target, { recursive: true, force: true }); throw error; }
    return { exportedPath: fs.realpathSync(target), archiveChecksum: output.archiveChecksum, manifestChecksum: output.manifest.manifestChecksum };
  }

  getManifest(revisionId) { const row = this.db.prepare('SELECT * FROM export_manifests WHERE revision_id=?').get(revisionId); return row ? { id: row.id, revisionId: row.revision_id, archiveChecksum: row.archive_checksum, manifestChecksum: row.manifest_checksum, manifest: decode(row.manifest_json, {}) } : null; }
}
