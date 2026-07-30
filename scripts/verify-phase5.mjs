import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { Store } from '../server/store.js';

const required = [
  'server/src/db/migrations/009_operational_context.sql',
  'server/src/design-systems/compiler.js',
  'server/src/design-systems/design-system-service.js',
  'server/src/fonts/font-service.js',
  'server/src/libraries/library-service.js',
  'server/src/skills/skill-package.js',
  'server/src/skills/skill-service.js',
  'server/src/security/theme-fetch.js',
  'web/src/components/OperationalCollections.tsx',
  'test/phase5.test.js',
];
for (const file of required) assert.equal(fs.existsSync(file), true, `missing ${file}`);
const root = fs.mkdtempSync(path.join(os.tmpdir(), 'mypath-verify-phase5-'));
try {
  const store = new Store(root); const db = store.database.db;
  for (const table of ['font_records', 'design_system_compilations', 'library_revision_memberships', 'library_reuse_events', 'skill_versions', 'skill_imports', 'theme_extraction_reviews']) assert.ok(db.prepare("SELECT name FROM sqlite_master WHERE type='table' AND name=?").get(table), `migration missing ${table}`);
  store.close();
} finally { fs.rmSync(root, { recursive: true, force: true }); }
const worker = fs.readFileSync('server/src/build/worker.js', 'utf8'); assert.match(worker, /font-src data:/); assert.match(worker, /connect-src 'none'/);
const themeFetch = fs.readFileSync('server/src/security/theme-fetch.js', 'utf8'); for (const policy of ['https:', 'theme_url_ssrf_rejected', 'MAX_REDIRECTS', 'MAX_DECOMPRESSED', 'resolvePublic']) assert.ok(themeFetch.includes(policy), `theme fetch lacks ${policy}`);
console.log('Phase 5 static verification passed: operational migration, exact context services, offline preview CSP, import boundary, and SSRF policy present');
