import crypto from 'node:crypto';
import { designToFigmaExchange, figmaExchangeToDesign, normalizeFigmaExchangeV1, stableFigmaJson } from './figma-exchange.js';

const now = () => new Date().toISOString();
const id = (prefix) => `${prefix}:${crypto.randomBytes(12).toString('hex')}`;
const sha = (value) => crypto.createHash('sha256').update(value).digest('hex');
function extension(mediaType) { return ({ 'image/png': 'png', 'image/jpeg': 'jpg', 'image/gif': 'gif', 'image/webp': 'webp' })[mediaType] || 'png'; }

export class FigmaService {
  constructor(store, candidates, canvases) { this.store = store; this.db = store.database.db; this.candidates = candidates; this.canvases = canvases; }
  record(direction, exchange, refs = {}) { const json = stableFigmaJson(exchange); const recordId = id('figma-exchange'); this.db.prepare('INSERT INTO figma_exchange_records(id,direction,project_id,component_id,revision_id,exchange_json,exchange_checksum,created_at) VALUES(?,?,?,?,?,?,?,?)').run(recordId, direction, refs.projectId || null, refs.componentId || null, refs.revisionId || null, json, sha(json), now()); return { id: recordId, direction, exchange: JSON.parse(json), checksum: sha(json), ...refs }; }
  get(recordId) { const row = this.db.prepare('SELECT * FROM figma_exchange_records WHERE id=?').get(recordId); return row ? { id: row.id, direction: row.direction, projectId: row.project_id, componentId: row.component_id, revisionId: row.revision_id, exchange: JSON.parse(row.exchange_json), checksum: row.exchange_checksum, createdAt: row.created_at } : null; }
  async import(projectId, input) {
    const project = this.store.get().projects.find((item) => item.id === projectId && !item.deletedAt); if (!project) throw Object.assign(new Error('Project not found'), { status: 404, code: 'not_found' });
    const exchange = normalizeFigmaExchangeV1(input); const design = figmaExchangeToDesign(exchange); const component = this.store.with((state, helpers) => { const stamp = helpers.now(); const item = { id: helpers.id(), projectId, name: exchange.document.name, generatedName: helpers.slugName(exchange.document.name), prompt: 'Imported from deterministic FigmaExchangeV1', code: '', files: {}, selectedRevisionId: null, provenance: { kind: 'figma_exchange_v1', checksum: sha(stableFigmaJson(exchange)) }, createdAt: stamp, updatedAt: stamp }; state.components.unshift(item); return item; });
    const imports = []; const files = {}; const assetVariables = {};
    exchange.assets.forEach((asset, index) => { if (!asset.dataBase64) return; const variable = `figmaAsset${index}`; const filename = `assets/figma-${index}.${extension(asset.mediaType)}`; imports.push(`import ${variable} from '../${filename}';`); files[filename] = `base64:${asset.dataBase64}`; assetVariables[asset.id] = variable; });
    const data = structuredClone(design); const scrub = (node) => { node.src = ''; node.children.forEach(scrub); }; data.frames.forEach(scrub); delete data.figmaExchange;
    const source = `${imports.join('\n')}\nconst design=${JSON.stringify(data)};\nconst assets={${Object.entries(assetVariables).map(([assetId, variable]) => `${JSON.stringify(assetId)}:${variable}`).join(',')}};\nfunction Node({node}){const children=(node.children||[]).map(child=><Node key={child.id} node={child}/>);if(node.type==='text')return <div style={node.style}>{node.text}</div>;if(node.type==='image')return <img style={node.style} src={assets[node.assetId]||''} alt={node.name||''}/>;const Tag=node.type==='frame'?'section':'div';return <Tag style={node.style}>{children}</Tag>}\nexport default function App(){return <main className="figma-import" aria-label={design.title}>{design.frames.map(frame=><Node key={frame.id} node={frame}/>)}</main>}`;
    files['src/App.tsx'] = source; files['src/index.css'] = `:root{font-family:system-ui,-apple-system,sans-serif;background:#e5e7eb}.figma-import{padding:32px;min-height:100vh}.figma-import>section{margin:0 auto;background:white;box-shadow:0 16px 50px rgba(15,23,42,.18)}`;
    const queued = this.candidates.create({ componentId: component.id, files, expectedBaseRevisionId: null, metadata: { figmaExchange: exchange, figmaExchangeChecksum: sha(stableFigmaJson(exchange)) }, note: 'FigmaExchangeV1 import' }); const build = await this.candidates.run(queued.buildId);
    const record = this.record('import', exchange, { projectId, componentId: component.id, revisionId: build.revision_id || null });
    if (build.status === 'succeeded') { const count = Object.keys(this.canvases.get(projectId)?.snapshot?.document?.store || {}).filter((key) => key.startsWith('shape:')).length; this.canvases.publish(projectId, record.id, { componentId: component.id, revisionId: build.revision_id, title: component.name, x: 80 + (count % 4) * 390, y: 80 + Math.floor(count / 4) * 350, w: Math.min(1200, exchange.frames[0].width), h: Math.min(1000, exchange.frames[0].height) }); }
    return { record, component, build };
  }
  exportRevision(revisionId) {
    const state = this.store.get(); const revision = state.revisions.find((item) => item.id === revisionId); if (!revision) throw Object.assign(new Error('Revision not found'), { status: 404, code: 'not_found' }); const component = state.components.find((item) => item.id === revision.componentId);
    let exchange;
    if (revision.figmaExchange) exchange = normalizeFigmaExchangeV1(revision.figmaExchange);
    else { const source = String(revision.files?.['src/App.tsx'] || revision.code || '').replace(/<[^>]+>/g, ' ').replace(/\s+/g, ' ').slice(0, 1000); exchange = designToFigmaExchange({ title: component?.name || 'MyPath revision', nodes: [{ kind: 'text', text: source || component?.name || 'MyPath revision' }] }); }
    return this.record('export', exchange, { projectId: component?.projectId || null, componentId: revision.componentId, revisionId });
  }
}
