import assert from 'node:assert/strict';
import fs from 'node:fs';
import test from 'node:test';

const webFiles = () => {
  const output = [];
  const walk = (directory) => { for (const entry of fs.readdirSync(directory, { withFileTypes: true })) { const target = `${directory}/${entry.name}`; if (entry.isDirectory()) walk(target); else if (/\.tsx?$/.test(entry.name)) output.push(target); } };
  walk('web/src'); return output;
};

test('packaged UI never uses unreliable browser prompt, confirm, or alert dialogs', () => {
  for (const file of webFiles()) {
    const source = fs.readFileSync(file, 'utf8');
    assert.doesNotMatch(source, /\b(?:window\s*\.\s*)?(?:prompt|confirm|alert)\s*\(/, `${file} must use an accessible React modal/status instead`);
  }
  const modal = fs.readFileSync('web/src/components/ActionModal.tsx', 'utf8');
  assert.match(modal, /role="dialog"/); assert.match(modal, /aria-modal="true"/); assert.match(modal, /event\.key === 'Escape'/); assert.match(modal, /<form onSubmit=/); assert.match(modal, /pending/);
});

test('async controls expose local diagnostics and global unhandled failure safety', () => {
  const app = fs.readFileSync('web/src/App.tsx', 'utf8'); const canvas = fs.readFileSync('web/src/canvas/ProjectCanvas.tsx', 'utf8'); const chat = fs.readFileSync('web/src/components/ProjectChatPanel.tsx', 'utf8'); const global = fs.readFileSync('web/src/components/GlobalErrorBanner.tsx', 'utf8');
  assert.match(app, /catch \(reason\).*setStatus\(`Failed:/s); assert.match(canvas, /catch \(reason\).*setStatus/s); assert.match(chat, /catch \(reason: any\) \{ setError/s);
  assert.match(global, /unhandledrejection/); assert.match(global, /role="alert"/); assert.match(chat, /disabled=\{submitting.*!prompt\.trim\(\)/s);
});

test('desktop instance nonce is captured once at module initialization and reused on renewal', () => {
  const source = fs.readFileSync('web/src/lib/api.ts', 'utf8');
  const declaration = source.indexOf('export const desktopInstanceNonce'); const client = source.indexOf('class ApiClient');
  assert.ok(declaration >= 0 && declaration < client, 'nonce must be captured before the API singleton is created');
  assert.equal((source.match(/new URLSearchParams\(globalThis\.location\?\.search/g) || []).length, 1);
  assert.match(source, /if \(desktopInstanceNonce\) headers\['X-MyPath-Instance'\] = desktopInstanceNonce/);
  assert.doesNotMatch(source.slice(client), /new URLSearchParams\(location\.search\)/, 'renewal must not reread a route-mutated location');
});

test('Phase 7 desktop capabilities have reachable busy/error/status UI', () => {
  const webImport = fs.readFileSync('web/src/components/WebImportPanel.tsx', 'utf8'); const app = fs.readFileSync('web/src/App.tsx', 'utf8');
  for (const marker of ['FigmaExchangeV1 import', 'Opt-in reference search', 'Explicitly fetch this result', 'Immutable search provenance', 'capture-tickets']) assert.match(webImport, new RegExp(marker));
  assert.match(app, /Download Figma JSON/); assert.match(app, /Choose a project for chat and generation/); assert.doesNotMatch(app, /canned/i);
});

test('expired upload sessions renew and dynamic capture origin is visible', () => {
  const api = fs.readFileSync('web/src/lib/api.ts', 'utf8');
  const webImport = fs.readFileSync('web/src/components/WebImportPanel.tsx', 'utf8');
  const popup = fs.readFileSync('extensions/web-capture/popup.html', 'utf8');
  assert.match(api, /response\.status === 401 && retry[\s\S]*this\.token = ''[\s\S]*this\.bootstrap\(\)[\s\S]*this\.upload<T>\(path, file, kind, false\)/);
  assert.match(webImport, /const backendOrigin = location\.origin/);
  assert.match(webImport, /MyPath origin[\s\S]*\{backendOrigin\}[\s\S]*Ticket ID[\s\S]*One-time token/);
  assert.doesNotMatch(popup, /value="http:\/\/127\.0\.0\.1:8787"/, 'extension must not suggest a stale fixed port');
});
