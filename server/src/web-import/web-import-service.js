import crypto from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import { fetchPublicHttps } from '../security/safe-fetch.js';
import { htmlToSemanticDesign, sanitizeImportedHtml } from './html-sanitizer.js';

const now = () => new Date().toISOString();
const id = (prefix) => `${prefix}:${crypto.randomBytes(12).toString('hex')}`;
const sha = (value) => crypto.createHash('sha256').update(value).digest('hex');
const decode = (value, fallback = null) => { try { return JSON.parse(value); } catch { return fallback; } };
const RIGHTS_WARNING = 'Only import material you have the right to use. Web content may be copyrighted or licensed; review attribution, trademarks, and asset licenses before reuse.';

function rowImport(row, assets = []) { return row ? { id: row.id, projectId: row.project_id, jobId: row.job_id, requestedUrl: row.requested_url, finalUrl: row.final_url, sanitizedHtml: row.sanitized_html, sanitizedChecksum: row.sanitized_checksum, originalChecksum: row.original_checksum, responseHeaders: decode(row.response_headers_json, {}), redirects: decode(row.redirects_json, []), diagnostics: decode(row.diagnostics_json, []), rightsWarning: row.rights_warning, fetchedAt: row.fetched_at, assets } : null; }
function phaseJob(row) { return row ? { id: row.id, projectId: row.project_id, kind: row.kind, status: row.status, input: decode(row.input_json, {}), resultRef: row.result_ref, diagnostics: decode(row.diagnostics_json, []), createdAt: row.created_at, startedAt: row.started_at, finishedAt: row.finished_at } : null; }
function ext(mediaType) { return ({ 'image/png': 'png', 'image/jpeg': 'jpg', 'image/gif': 'gif', 'image/webp': 'webp', 'image/svg+xml': 'svg' })[mediaType] || 'bin'; }
function textUtf8(bytes) { const text = bytes.toString('utf8'); if (text.includes('\ufffd')) throw Object.assign(new Error('Web page must be valid UTF-8'), { status: 415, code: 'web_import_encoding_invalid' }); return text; }

export class WebImportService {
  constructor({ store, candidates, canvases, assets, fetcher = fetchPublicHttps }) { this.store = store; this.database = store.database; this.db = this.database.db; this.candidates = candidates; this.canvases = canvases; this.assets = assets; this.fetcher = fetcher; }
  ensureProject(projectId) { if (!this.db.prepare('SELECT 1 FROM projects WHERE id=?').get(projectId)) throw Object.assign(new Error('Project not found'), { status: 404, code: 'not_found' }); }
  createJob(projectId, kind, input) { const jobId = id('phase7-job'); this.db.prepare("INSERT INTO phase7_jobs(id,project_id,kind,status,input_json,created_at) VALUES(?,?,?,'queued',?,?)").run(jobId, projectId, kind, JSON.stringify(input), now()); return jobId; }
  updateJob(jobId, status, resultRef = null, diagnostics = []) { const stamp = now(); this.db.prepare("UPDATE phase7_jobs SET status=?,result_ref=?,diagnostics_json=?,started_at=COALESCE(started_at,?),finished_at=CASE WHEN ? IN ('succeeded','failed') THEN ? ELSE finished_at END WHERE id=?").run(status, resultRef, JSON.stringify(diagnostics), stamp, status, stamp, jobId); return this.getJob(jobId); }
  getJob(jobId) { return phaseJob(this.db.prepare('SELECT * FROM phase7_jobs WHERE id=?').get(jobId)); }
  list(projectId) { return this.db.prepare('SELECT id FROM web_imports WHERE project_id=? ORDER BY fetched_at DESC').all(projectId).map(({ id: importId }) => this.get(importId)); }
  get(importId) { const assets = this.db.prepare('SELECT * FROM web_import_assets WHERE import_id=? ORDER BY created_at,id').all(importId).map((row) => ({ id: row.id, sourceUrl: row.source_url, assetId: row.asset_id, checksum: row.checksum, mediaType: row.media_type, byteSize: row.byte_size, createdAt: row.created_at })); return rowImport(this.db.prepare('SELECT * FROM web_imports WHERE id=?').get(importId), assets); }

  async create(projectId, input = {}) {
    this.ensureProject(projectId); const requestedUrl = String(input.url || ''); const jobId = this.createJob(projectId, 'web_fetch', { url: requestedUrl, ingestAssets: input.ingestAssets === true }); this.updateJob(jobId, 'running');
    try {
      const fetched = await this.fetcher(requestedUrl, { allowedContentTypes: ['text/html', 'application/xhtml+xml'], maxCompressedBytes: 1024 * 1024, maxDecompressedBytes: 4 * 1024 * 1024, maxRedirects: 3, timeoutMs: 8_000, accept: 'text/html,application/xhtml+xml;q=0.9' });
      const sanitized = sanitizeImportedHtml(textUtf8(fetched.bytes), fetched.finalUrl); const importId = id('web-import'); const ingested = [];
      // Parse only sanitized HTTPS image references. Each is independently revalidated by the same fetch policy.
      if (input.ingestAssets === true) {
        const sources = [...sanitized.html.matchAll(/<img\b[^>]*\ssrc="(https:[^"]+)"[^>]*>/gi)].map((match) => match[1]).filter((value, index, all) => all.indexOf(value) === index).slice(0, 8);
        for (const sourceUrl of sources) {
          try {
            const resource = await this.fetcher(sourceUrl, { allowedContentTypes: [/^image\/(?:png|jpeg|gif|webp|svg\+xml)$/], maxCompressedBytes: 768 * 1024, maxDecompressedBytes: 768 * 1024, maxRedirects: 3, timeoutMs: 8_000, accept: 'image/png,image/jpeg,image/gif,image/webp,image/svg+xml' });
            const asset = this.assets.ingest({ projectId, name: path.basename(new URL(resource.finalUrl).pathname) || `import.${ext(resource.headers.contentType)}`, kind: 'image', bytes: resource.bytes });
            ingested.push({ id: id('web-import-asset'), sourceUrl, asset, finalUrl: resource.finalUrl });
          } catch (error) { sanitized.diagnostics.push({ code: error.code || 'asset_ingestion_failed', message: `Asset was not ingested (${sourceUrl}): ${String(error.message || error)}` }); }
        }
      }
      this.db.exec('BEGIN IMMEDIATE');
      try {
        this.db.prepare('INSERT INTO web_imports(id,project_id,job_id,requested_url,final_url,sanitized_html,sanitized_checksum,original_checksum,response_headers_json,redirects_json,diagnostics_json,rights_warning,fetched_at) VALUES(?,?,?,?,?,?,?,?,?,?,?,?,?)').run(importId, projectId, jobId, requestedUrl, fetched.finalUrl, sanitized.html, sanitized.sanitizedChecksum, sanitized.originalChecksum, JSON.stringify({ ...fetched.headers, compressedBytes: fetched.compressedBytes, decompressedBytes: fetched.decompressedBytes }), JSON.stringify(fetched.redirects), JSON.stringify([...fetched.diagnostics, ...sanitized.diagnostics]), RIGHTS_WARNING, now());
        for (const item of ingested) this.db.prepare('INSERT INTO web_import_assets(id,import_id,source_url,asset_id,checksum,media_type,byte_size,created_at) VALUES(?,?,?,?,?,?,?,?)').run(item.id, importId, item.sourceUrl, item.asset.id, item.asset.checksum, item.asset.mediaType, item.asset.byteSize, now());
        this.db.exec('COMMIT');
      } catch (error) { this.db.exec('ROLLBACK'); throw error; }
      this.updateJob(jobId, 'succeeded', importId); return { job: this.getJob(jobId), import: this.get(importId) };
    } catch (error) { this.updateJob(jobId, 'failed', null, [{ code: error.code || 'web_import_failed', message: String(error.message || error) }]); throw error; }
  }

  async convert(importId, input = {}) {
    const imported = this.get(importId); if (!imported) throw Object.assign(new Error('Web import not found'), { status: 404, code: 'not_found' });
    const jobId = this.createJob(imported.projectId, 'semantic_conversion', { importId, name: input.name || null }); this.updateJob(jobId, 'running');
    try {
      const semantic = htmlToSemanticDesign(imported.sanitizedHtml, { finalUrl: imported.finalUrl, title: input.name || '' });
      const assetBySource = new Map(imported.assets.map((entry) => [entry.sourceUrl, this.assets.get(entry.assetId)]));
      for (const node of semantic.nodes) if (node.kind === 'image') { const asset = assetBySource.get(node.src); node.src = asset && asset.byteSize <= 512 * 1024 ? `data:${asset.mediaType};base64,${fs.readFileSync(asset.path).toString('base64')}` : ''; }
      const component = this.store.with((state, helpers) => { const time = helpers.now(); const item = { id: helpers.id(), projectId: imported.projectId, name: String(input.name || semantic.title || 'Imported page').slice(0, 120), generatedName: helpers.slugName(String(input.name || semantic.title || 'imported-page')), prompt: `Semantic conversion of immutable web import ${importId}`, code: '', files: {}, selectedRevisionId: null, provenance: { kind: 'web_import', importId, sanitizedChecksum: imported.sanitizedChecksum, finalUrl: imported.finalUrl, trust: 'untrusted_reference' }, createdAt: time, updatedAt: time }; state.components.unshift(item); return item; });
      const source = `const design=${JSON.stringify(semantic)};\nconst tags={heading:'h2',text:'p',action:'button',item:'li'};\nexport default function App(){return <main className="imported-page"><header><span>Imported reference</span><h1>{design.title}</h1></header><section>{design.nodes.map((node,index)=>node.kind==='image'&&node.src?<img key={index} src={node.src} alt={node.alt||''}/>:node.text?(()=>{const Tag=tags[node.kind]||'p';return <Tag key={index}>{node.text}</Tag>})():null)}</section><footer>Converted from an immutable, sanitized reference. Review rights before reuse.</footer></main>}`;
      const css = `:root{font-family:system-ui,-apple-system,sans-serif;color:#172033;background:#eef2f7}.imported-page{max-width:1120px;margin:0 auto;min-height:100vh;background:white}.imported-page header{padding:72px 8%;background:#14213d;color:white}.imported-page header span{font-size:12px;text-transform:uppercase;letter-spacing:.12em}.imported-page h1{font-size:clamp(36px,7vw,76px);line-height:1;margin:20px 0}.imported-page section{padding:48px 8%;display:flex;flex-direction:column;gap:18px}.imported-page section h2{font-size:30px;margin-top:24px}.imported-page p,.imported-page li{font-size:18px;line-height:1.65;max-width:760px}.imported-page button{align-self:flex-start;border:0;border-radius:10px;padding:13px 20px;background:#2563eb;color:white;font-weight:700}.imported-page img{max-width:100%;max-height:560px;object-fit:cover;border-radius:14px}.imported-page footer{padding:24px 8%;font-size:12px;color:#64748b;border-top:1px solid #e2e8f0}`;
      const queued = this.candidates.create({ componentId: component.id, files: { 'src/App.tsx': source, 'src/index.css': css }, expectedBaseRevisionId: null, metadata: { webImport: { importId, sanitizedChecksum: imported.sanitizedChecksum, finalUrl: imported.finalUrl, trust: 'untrusted_reference' } }, note: 'Semantic web import conversion' });
      const build = await this.candidates.run(queued.buildId); const conversionId = id('semantic-conversion'); const diagnostics = build.diagnostics || [];
      this.db.prepare('INSERT INTO semantic_import_conversions(id,import_id,job_id,component_id,revision_id,semantic_json,semantic_checksum,diagnostics_json,created_at) VALUES(?,?,?,?,?,?,?,?,?)').run(conversionId, importId, jobId, component.id, build.revision_id || null, JSON.stringify(semantic), sha(JSON.stringify(semantic)), JSON.stringify(diagnostics), now());
      if (build.status !== 'succeeded') { this.updateJob(jobId, 'failed', conversionId, diagnostics); return { job: this.getJob(jobId), conversion: this.getConversion(conversionId), build }; }
      this.updateJob(jobId, 'succeeded', conversionId, diagnostics);
      const count = Object.keys(this.canvases.get(imported.projectId)?.snapshot?.document?.store || {}).filter((key) => key.startsWith('shape:')).length;
      this.canvases.publish(imported.projectId, jobId, { componentId: component.id, revisionId: build.revision_id, title: component.name, x: 80 + (count % 4) * 390, y: 80 + Math.floor(count / 4) * 350, w: 360, h: 600 });
      return { job: this.getJob(jobId), conversion: this.getConversion(conversionId), component, build };
    } catch (error) { this.updateJob(jobId, 'failed', null, [{ code: error.code || 'semantic_conversion_failed', message: String(error.message || error) }]); throw error; }
  }
  getConversion(conversionId) { const row = this.db.prepare('SELECT * FROM semantic_import_conversions WHERE id=?').get(conversionId); return row ? { id: row.id, importId: row.import_id, jobId: row.job_id, componentId: row.component_id, revisionId: row.revision_id, semantic: decode(row.semantic_json, {}), semanticChecksum: row.semantic_checksum, diagnostics: decode(row.diagnostics_json, []), createdAt: row.created_at } : null; }
}

export { RIGHTS_WARNING };
