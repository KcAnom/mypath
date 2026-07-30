import assert from 'node:assert/strict';
import fs from 'node:fs';

const required = [
  'server/src/db/migrations/011_phase7_web_exchange.sql',
  'server/src/security/safe-fetch.js',
  'server/src/web-import/html-sanitizer.js',
  'server/src/web-import/web-import-service.js',
  'server/src/web-import/capture-service.js',
  'server/src/search/search-service.js',
  'server/src/figma/figma-exchange.js',
  'server/src/figma/figma-service.js',
  'web/src/components/WebImportPanel.tsx',
  'extensions/web-capture/manifest.json',
  'extensions/web-capture/background.js',
  'extensions/figma-plugin/manifest.json',
  'extensions/figma-plugin/code.js',
  'test/fixtures/figma-exchange-v1.json',
];
for (const file of required) assert.equal(fs.existsSync(file), true, `missing Phase 7 deliverable: ${file}`);
const server = fs.readFileSync('server/index.js', 'utf8');
for (const route of ['/imports/web', '/imports/:id/convert', '/capture-tickets/:id/submission', '/projects/:id/search', '/imports/figma', '/figma-exchange']) assert.match(server, new RegExp(route.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')), `missing route ${route}`);
const migration = fs.readFileSync(required[0], 'utf8');
for (const boundary of ['web_imports_immutable_update', 'capture_tickets', 'search_contexts_immutable_update', 'figma_exchange_immutable_update']) assert.match(migration, new RegExp(boundary));
const captureManifest = JSON.parse(fs.readFileSync('extensions/web-capture/manifest.json', 'utf8')); assert.deepEqual(captureManifest.host_permissions.sort(), ['http://127.0.0.1/*', 'http://localhost/*']); assert.equal('content_scripts' in captureManifest, false, 'capture extension must not run persistently on arbitrary pages');
const figmaManifest = JSON.parse(fs.readFileSync('extensions/figma-plugin/manifest.json', 'utf8')); assert.deepEqual(figmaManifest.networkAccess.allowedDomains, ['none']);
const fixture = JSON.parse(fs.readFileSync('test/fixtures/figma-exchange-v1.json', 'utf8')); assert.equal(fixture.version, 'FigmaExchangeV1'); assert.ok(fixture.frames.length);
console.log(`Phase 7 deliverables verified (${required.length} files, immutable provenance, bounded extension permissions, offline Figma fixture)`);
