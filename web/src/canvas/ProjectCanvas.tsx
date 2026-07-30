import { ChangeEvent, DragEvent, useCallback, useEffect, useRef, useState } from 'react';
import { Editor, getSnapshot, loadSnapshot, Tldraw } from 'tldraw';
import { AssetRecordType } from '@tldraw/tlschema';
import 'tldraw/tldraw.css';
import { api } from '../lib/api';
import { designFrameShapeUtils } from './DesignFrameShape';
import { ProjectChatPanel } from '../components/ProjectChatPanel';

type CanvasRecord = { id: string; version: number; snapshot: any; camera: any };
type Mention = { type: string; id: string; label: string; detail?: string };

export function ProjectCanvas({ projectId, project, components, navigate, onGenerate }: any) {
  const editor = useRef<Editor | null>(null); const version = useRef(0); const saveTimer = useRef<number | undefined>(undefined);
  const saveBlocked = useRef(false);
  const [selected, setSelected] = useState<any[]>([]); const [status, setStatus] = useState('Loading canvas…');
  const [conflict, setConflict] = useState<CanvasRecord | null>(null);
  const [mentionText, setMentionText] = useState(''); const [mentions, setMentions] = useState<Mention[]>([]);
  const [contextSnapshot, setContextSnapshot] = useState<any>(null);
  const [operational, setOperational] = useState<any>({ designSystems: [], libraries: [], skills: [], fonts: [], selected: {} });
  const [selectedSkillIds, setSelectedSkillIds] = useState<string[]>([]);
  const [promptText, setPromptText] = useState(''); const [building, setBuilding] = useState(false); const [actionBusy, setActionBusy] = useState('');
  const errorText = (reason: any) => String(reason?.message || reason || 'Action failed');
  const refreshOperational = useCallback(async () => { try { setOperational(await api.get<any>(`/api/v1/projects/${projectId}/operational-context`)); } catch (reason) { setStatus(`Operational context failed: ${errorText(reason)}`); } }, [projectId]);
  useEffect(() => { void refreshOperational(); }, [refreshOperational]);
  const runAction = async (name: string, task: () => Promise<void>) => { if (actionBusy) return; setActionBusy(name); try { await task(); } catch (reason) { setStatus(`${name} failed: ${errorText(reason)}`); } finally { setActionBusy(''); } };

  const applyRemoteCanvas = useCallback((instance: Editor, canvas: CanvasRecord) => {
    // Cancel every stale autosave before adopting the CAS winner. Suppression stays
    // active while tldraw emits store events caused by either replacement path.
    window.clearTimeout(saveTimer.current); saveTimer.current = undefined; saveBlocked.current = true;
    try {
      if (canvas.snapshot?.document) loadSnapshot(instance.store, canvas.snapshot);
      else {
        // Legacy snapshots are shape-only, so explicitly replace (never append to)
        // the current page. This preserves remote publications while discarding all
        // stale local shapes, including an empty remote legacy canvas.
        const currentShapeIds = Array.from(instance.getCurrentPageShapeIds());
        if (currentShapeIds.length) instance.deleteShapes(currentShapeIds);
        const remoteShapes = Array.isArray(canvas.snapshot?.legacyShapes) ? canvas.snapshot.legacyShapes : [];
        if (remoteShapes.length) instance.createShapes(remoteShapes as any);
      }
      if (canvas.camera) instance.setCamera({ x: Number(canvas.camera.x || 0), y: Number(canvas.camera.y || 0), z: Number(canvas.camera.z || canvas.camera.zoom || 1) });
      version.current = canvas.version; setConflict(null); setStatus(`Reloaded canvas v${canvas.version}`);
    } finally { saveBlocked.current = false; }
  }, []);

  const persist = useCallback(async (instance: Editor) => {
    if (saveBlocked.current) return;
    const snapshot = getSnapshot(instance.store); const camera = instance.getCamera();
    try { const saved = await api.put<CanvasRecord>(`/api/v1/projects/${projectId}/canvas`, { version: version.current, snapshot, camera }); version.current = saved.version; setConflict(null); setStatus(`Saved v${saved.version}`); }
    catch (error: any) {
      if (error.status !== 409 || !error.details?.current) { setStatus(`Save failed: ${error.message}`); return; }
      // A stale full-store snapshot cannot be merged safely without a common base:
      // local-wins object spreading would silently overwrite same-record edits. Keep
      // the local editor untouched and require an explicit reload/reapply decision.
      window.clearTimeout(saveTimer.current); saveTimer.current = undefined; saveBlocked.current = true;
      setConflict(error.details.current as CanvasRecord);
      setStatus('Conflict: canvas changed elsewhere; local edits were not uploaded');
    }
  }, [projectId]);

  const mounted = useCallback((instance: Editor) => {
    editor.current = instance;
    void (async () => {
      let loading = true;
      const canvas = await api.get<CanvasRecord>(`/api/v1/projects/${projectId}/canvas`);
      applyRemoteCanvas(instance, canvas); setStatus(`Canvas v${canvas.version}`); loading = false;
      instance.store.listen(() => {
        setSelected(instance.getSelectedShapes());
        if (loading || saveBlocked.current) return; window.clearTimeout(saveTimer.current); saveTimer.current = window.setTimeout(() => void persist(instance), 550);
      }, { source: 'user', scope: 'all' });
    })().catch((error) => setStatus(`Canvas failed: ${error.message}`));
  }, [applyRemoteCanvas, persist, projectId]);

  const searchMentions = async (value: string) => { setMentionText(value); const query = value.includes('@') ? value.slice(value.lastIndexOf('@') + 1) : value; if (!value.includes('@')) { setMentions([]); return; } try { setMentions(await api.get(`/api/v1/projects/${projectId}/mentions?q=${encodeURIComponent(query)}`)); } catch (reason) { setMentions([]); setStatus(`Context search failed: ${errorText(reason)}`); } };
  const snapshotContext = async (options: { prompt?: string; skillIds?: string[]; allowDescriptionActivation?: boolean } = {}) => {
    const shapeIds = selected.map((shape) => shape.id); const componentRefs = selected.filter((shape) => shape.type === 'design-frame' && shape.props.revisionId).map((shape) => ({ componentId: shape.props.componentId, revisionId: shape.props.revisionId }));
    const context = await api.post<any>(`/api/v1/projects/${projectId}/context-snapshots`, { shapeIds, components: componentRefs, skills: (options.skillIds || selectedSkillIds).map((id) => ({ skillId: id })), prompt: options.prompt || '', allowDescriptionActivation: options.allowDescriptionActivation === true }); setContextSnapshot(context); setStatus(`Context frozen ${context.id.slice(0, 16)}…`); return context;
  };
  const upload = async (event: ChangeEvent<HTMLInputElement>) => {
    const file = event.target.files?.[0]; if (!file || actionBusy) return; const kind = file.type.startsWith('image/') ? 'image' : file.type.includes('font') || /\.(woff2?|ttf|otf)$/i.test(file.name) ? 'font' : 'document'; setActionBusy('upload');
    try {
      const asset = await api.upload<any>(`/api/v1/projects/${projectId}/assets`, file, kind); setStatus(`Stored ${asset.name}`);
      if (kind === 'font') { const registered = await api.post<any>('/api/v1/fonts', { assetId: asset.id, family: file.name.replace(/\.(?:woff2?|ttf|otf)$/i, '') }); await api.put(`/api/v1/projects/${projectId}/fonts/${encodeURIComponent(registered.id)}`, { active: true }); await refreshOperational(); setStatus(`Stored and activated local font ${registered.family}`); }
      if (kind === 'image' && editor.current) {
        const src = await new Promise<string>((resolve, reject) => { const reader = new FileReader(); reader.onload = () => resolve(String(reader.result)); reader.onerror = () => reject(reader.error || new Error('Unable to read image')); reader.readAsDataURL(file); });
        const size = await new Promise<{w:number;h:number}>((resolve, reject) => { const image = new Image(); image.onload = () => resolve({ w: image.naturalWidth, h: image.naturalHeight }); image.onerror = () => reject(new Error('Stored file could not be decoded as an image')); image.src = src; });
        const assetId = AssetRecordType.createId(asset.id.replace(/[^a-zA-Z0-9_-]/g, '-')); editor.current.createAssets([{ id: assetId, type: 'image', typeName: 'asset', props: { name: asset.name, src, w: size.w, h: size.h, mimeType: asset.mediaType, isAnimated: asset.mediaType === 'image/gif', fileSize: asset.byteSize }, meta: { ingestedAssetId: asset.id } }] as any);
        editor.current.createShape({ type: 'image', x: 120, y: 120, props: { assetId, w: Math.min(size.w, 500), h: Math.min(size.h, 500) } } as any);
      }
    } catch (reason) { setStatus(`Upload failed: ${errorText(reason)}`); } finally { setActionBusy(''); event.target.value = ''; }
  };
  const generate = async () => { if (!promptText.trim() || building) return; setBuilding(true); try { await onGenerate(promptText); setPromptText(''); setStatus('Generated component added to project.'); } catch (reason) { setStatus(`Generation failed: ${errorText(reason)}`); } finally { setBuilding(false); } };
  const reuseLibraryItem = async (event: DragEvent, member?: any) => {
    event.preventDefault(); let value = member; try { value ||= JSON.parse(event.dataTransfer.getData('application/x-mypath-library') || 'null'); } catch { setStatus('Library drop failed: invalid drag payload'); return; } if (!value) return;
    await runAction('Library reuse', async () => { const point = !member && editor.current && Number.isFinite(event.clientX) ? editor.current.screenToPage({ x: event.clientX, y: event.clientY }) : { x: 120, y: 120 }; await api.post(`/api/v1/projects/${projectId}/canvas/library-items`, { ...value, x: point.x, y: point.y }); const canvas = await api.get<CanvasRecord>(`/api/v1/projects/${projectId}/canvas`); if (editor.current) applyRemoteCanvas(editor.current, canvas); setStatus(`Reused exact library revision ${value.revisionId.slice(0, 10)}…`); });
  };
  const toggleSkill = (skillId: string) => setSelectedSkillIds((current) => current.includes(skillId) ? current.filter((id) => id !== skillId) : [...current, skillId]);

  return <div className="tldraw-workspace">
    <section className="tldraw-stage" aria-label="Project design canvas" onDragOver={(event) => event.preventDefault()} onDrop={(event) => void reuseLibraryItem(event)}><Tldraw shapeUtils={designFrameShapeUtils} onMount={mounted}/></section>
    <aside className="canvas-context-panel"><header><strong>{project.name}</strong><span>{status}</span></header>
      <div className="canvas-panel-body">
        {conflict && <div role="alert" className="canvas-conflict"><strong>Concurrent edit conflict</strong><p>Your local canvas is still visible and has not overwritten version {conflict.version}. Reload the latest canvas, then reapply your changes.</p><button onClick={() => { if (editor.current) applyRemoteCanvas(editor.current, conflict); }}>Reload latest (discard local canvas edits)</button></div>}
        <button className="primary" onClick={() => navigate(`/projects/${projectId}/web-import`)}>Import web page or capture element</button>
        <div className="context-pills">{selected.map((shape) => <span className="context-pill" key={shape.id}>{shape.type} · {shape.props?.title || shape.id.slice(6, 14)}</span>)}{!selected.length && <small>No selection: context will still pin this exact canvas version.</small>}</div>
        <button disabled={Boolean(actionBusy)} onClick={() => void runAction('Context freeze', async () => { await snapshotContext(); })}>{actionBusy === 'Context freeze' ? 'Freezing…' : selected.length ? 'Freeze selection context' : 'Freeze project context'}</button>
        <details className="operational-context" open><summary>Design system · libraries · local fonts</summary>
          <label>Exact design-system version<select disabled={Boolean(actionBusy)} value={operational.selected?.designSystem?.versionId || ''} onChange={(event) => { const versionId = event.target.value; void runAction('Design-system selection', async () => { await api.put(`/api/v1/projects/${projectId}/design-system`, versionId ? { versionId, active: true } : { active: false }); await refreshOperational(); setStatus(versionId ? 'Exact design-system version activated.' : 'System defaults activated; project design-system selection cleared.'); }); }}><option value="">System defaults</option>{operational.designSystems?.flatMap((design: any) => (design.versions || (design.currentVersion ? [design.currentVersion] : [])).map((item: any) => <option key={item.id} value={item.id}>{design.name} · exact v{item.version}</option>))}</select></label>
          <div className="library-browser"><strong>Library browser</strong>{operational.libraries?.map((library: any) => <div key={library.id}><label><input type="checkbox" disabled={Boolean(actionBusy)} checked={Boolean(operational.selected?.libraries?.some((item: any) => item.libraryId === library.id))} onChange={(event) => { const active = event.target.checked; void runAction('Library selection', async () => { await api.put(`/api/v1/projects/${projectId}/libraries/${library.id}`, { active }); await refreshOperational(); setStatus(`${library.name} ${active ? 'activated' : 'deactivated'}.`); }); }}/>{library.name}</label>{library.members?.map((member: any) => <button type="button" disabled={Boolean(actionBusy)} draggable key={`${library.id}:${member.revisionId}`} onDragStart={(event) => event.dataTransfer.setData('application/x-mypath-library', JSON.stringify({ libraryId: library.id, componentId: member.componentId, revisionId: member.revisionId }))} onClick={(event) => void reuseLibraryItem(event as any, { libraryId: library.id, componentId: member.componentId, revisionId: member.revisionId })}>{member.name}<small>Exact revision {member.revisionId.slice(0, 10)}… · drag to canvas</small></button>)}</div>)}</div>
          <div className="active-fonts">{operational.selected?.fonts?.map((font: any) => <span className="context-pill" key={font.fontId}>Local font · {font.family}</span>)}</div>
        </details>
        <label className="upload-control">{actionBusy === 'upload' ? 'Uploading and decoding…' : 'Add image / document / local font'}<input disabled={Boolean(actionBusy)} type="file" accept="image/*,.pdf,.woff,.woff2,.ttf,.otf" onChange={upload}/></label>
        <div className="mention-box"><input value={mentionText} onChange={(e) => void searchMentions(e.target.value)} placeholder="Search context with @…"/>{mentions.map((m) => <button key={`${m.type}:${m.id}`} onClick={() => { setMentionText(`@${m.label}`); setMentions([]); }}>{m.label}<small>{m.type} {m.detail}</small></button>)}</div>
        <ProjectChatPanel projectId={projectId} contextSnapshot={contextSnapshot} contextLabels={selected.map((shape) => `${shape.type} · ${shape.props?.title || shape.id.slice(6, 14)}`)} skills={operational.skills || []} selectedSkillIds={selectedSkillIds} onSkillToggle={toggleSkill} prepareContext={snapshotContext}/>
        <details className="legacy-generate"><summary>Legacy single-component generator</summary><div className="gen-box"><textarea value={promptText} onChange={(event) => setPromptText(event.target.value)} placeholder="Describe an interactive UI…"/><button className="primary" disabled={building || !promptText.trim()} title={!promptText.trim() ? 'Describe a component before generating.' : ''} onClick={generate}>{building ? 'Building…' : 'Generate (legacy)'}</button></div></details>
        {components.map((item: any) => <button className="ghost" key={item.id} onClick={() => navigate(`/components/${item.id}`)}>{item.name}</button>)}
      </div>
    </aside>
  </div>;
}
