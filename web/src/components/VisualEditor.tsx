import { useEffect, useMemo, useState } from 'react';
import { api } from '../lib/api';
import { PreviewFrame } from './PreviewFrame';

type Revision = Record<string, any> & { id: string; createdAt?: string; status?: string };
type Props = { component: Record<string, any>; revisions: Revision[]; selectedRevisionId: string; onRefresh: () => Promise<unknown>; onSelectRevision: (id: string) => void };

export function VisualEditor({ component, revisions, selectedRevisionId, onRefresh, onSelectRevision }: Props) {
  const [session, setSession] = useState<any>(null); const [selectedSourceId, setSelectedSourceId] = useState('');
  const [text, setText] = useState(''); const [className, setClassName] = useState(''); const [style, setStyle] = useState('{}');
  const [busy, setBusy] = useState(false); const [message, setMessage] = useState(''); const [comparison, setComparison] = useState<any>(null);
  const layers = session?.mapping?.layers || [];
  const selectedLayer = useMemo(() => layers.find((layer: any) => layer.sourceId === selectedSourceId) || null, [layers, selectedSourceId]);
  useEffect(() => {
    if (!selectedLayer) return;
    setText(selectedLayer.text ?? ''); setClassName(String(selectedLayer.attributes?.className ?? '')); setStyle(JSON.stringify(selectedLayer.attributes?.style || {}, null, 2));
  }, [selectedLayer]);
  const perform = async (callback: () => Promise<any>) => { setBusy(true); setMessage(''); try { return await callback(); } catch (error: any) { setMessage(`${error.code || 'error'}: ${error.message}`); } finally { setBusy(false); } };
  const start = () => perform(async () => { const value = await api.post<any>(`/api/v1/components/${component.id}/edit-sessions`, { baseRevisionId: component.selectedRevisionId }); setSession(value); setSelectedSourceId(value.mapping?.layers?.[0]?.sourceId || ''); });
  const operation = (value: any) => perform(async () => { const next = await api.post<any>(`/api/v1/edit-sessions/${session.id}/operations`, value); setSession(next); return next; });
  const applyInspector = () => perform(async () => {
    let next = session;
    if (selectedLayer.text !== null && text !== selectedLayer.text) next = await api.post<any>(`/api/v1/edit-sessions/${session.id}/operations`, { type: 'set-text', sourceId: selectedSourceId, value: text });
    const latestLayer = next.mapping.layers.find((layer: any) => layer.sourceId === selectedSourceId);
    if (className !== String(latestLayer.attributes?.className ?? '')) next = await api.post<any>(`/api/v1/edit-sessions/${session.id}/operations`, { type: 'set-class', sourceId: selectedSourceId, value: className });
    const latestAfterClass = next.mapping.layers.find((layer: any) => layer.sourceId === selectedSourceId);
    const parsedStyle = JSON.parse(style || '{}');
    if (JSON.stringify(parsedStyle) !== JSON.stringify(latestAfterClass.attributes?.style || {})) next = await api.post<any>(`/api/v1/edit-sessions/${session.id}/operations`, { type: 'set-style', sourceId: selectedSourceId, value: parsedStyle });
    setSession(next); setMessage('Draft updated — Done will create one revision.');
  });
  const cancel = () => perform(async () => { await api.del(`/api/v1/edit-sessions/${session.id}`); setSession(null); setSelectedSourceId(''); setMessage('Edit cancelled; no revision created.'); });
  const done = () => perform(async () => { const value = await api.post<any>(`/api/v1/edit-sessions/${session.id}/done`, {}); setSession(value); if (value.doneRevisionId) onSelectRevision(value.doneRevisionId); await onRefresh(); setMessage('Done created exactly one immutable revision.'); });
  const createVariants = () => perform(async () => { const result = await api.post<any>(`/api/v1/components/${component.id}/variants`, { directions: [{ kind: 'layout', value: 'grid' }, { kind: 'style', value: 'soft elevated' }, { kind: 'color', value: '#312e81' }, { kind: 'copy', value: 'A clear new direction' }, { kind: 'device', value: 'mobile' }] }); await onRefresh(); setMessage(`${result.variants.filter((item: any) => item.status === 'completed').length} parallel variants published to canvas.`); });
  const compare = () => perform(async () => { if (!selectedRevisionId || selectedRevisionId === component.selectedRevisionId) return setComparison(null); setComparison(await api.get(`/api/v1/revisions/${component.selectedRevisionId}/compare?otherRevisionId=${encodeURIComponent(selectedRevisionId)}`)); });
  const checkout = () => perform(async () => { await api.post(`/api/v1/components/${component.id}/checkout`, { revisionId: selectedRevisionId }); await onRefresh(); setMessage('Checked out without changing revision history.'); });
  const restore = () => perform(async () => { const result = await api.post<any>(`/api/v1/revisions/${selectedRevisionId}/restore`, {}); onSelectRevision(result.revision.id); await onRefresh(); setMessage('Historical source restored as a new child revision.'); });

  return <div className="visual-editor">
    <section className="visual-tools panel">
      <header><strong>Layers</strong>{!session ? <button className="primary" disabled={busy || !component.selectedRevisionId} onClick={start}>Visual edit</button> : <span className="badge">{session.status}</span>}</header>
      <div className="body layer-tree">
        {!session && <p className="meta">Start an edit session to inspect uniquely traceable intrinsic JSX layers.</p>}
        {layers.map((layer: any) => <button key={layer.sourceId} className={`layer-item ${selectedSourceId === layer.sourceId ? 'active' : ''}`} style={{ paddingLeft: `${12 + Math.max(0, layers.findIndex((item: any) => item.sourceId === layer.parentSourceId)) * 2}px` }} onClick={() => setSelectedSourceId(layer.sourceId)}>
          <span>&lt;{layer.tag}&gt;</span><small>{layer.editable ? layer.text || layer.attributes?.className || 'literal node' : `read only · ${layer.readOnlyReasons.join(', ')}`}</small>
        </button>)}
      </div>
      {session?.status === 'open' && <footer className="edit-session-actions"><button disabled={busy} onClick={cancel}>Cancel</button><button className="primary" disabled={busy} onClick={done}>{busy ? 'Building…' : 'Done'}</button></footer>}
    </section>
    <PreviewFrame revisionId={session?.status === 'completed' ? session.doneRevisionId : selectedRevisionId} title={session?.status === 'open' ? 'Selected revision (draft builds on Done)' : 'Runnable revision'} selectableSourceIds={layers.map((layer: any) => layer.sourceId)} onSelect={({ sourceId }) => setSelectedSourceId(sourceId)}/>
    <section className="visual-tools panel inspector-panel">
      <header><strong>Inspector</strong><button disabled={busy} onClick={createVariants}>5 variants</button></header>
      <div className="body">
        {selectedLayer ? <>
          <div className="meta">{selectedLayer.tag} · {selectedLayer.sourceId}<br/>{selectedLayer.editable ? 'literal supported subset' : `Read only: ${selectedLayer.readOnlyReasons.join(', ')}`}</div>
          <label>Literal text</label><textarea disabled={!selectedLayer.editable || selectedLayer.text === null} value={text} onChange={(event) => setText(event.target.value)}/>
          <label>className</label><textarea disabled={!selectedLayer.editable} value={className} onChange={(event) => setClassName(event.target.value)}/>
          <label>Literal style object</label><textarea disabled={!selectedLayer.editable} value={style} onChange={(event) => setStyle(event.target.value)}/>
          <div className="row"><button className="primary" disabled={busy || !selectedLayer.editable || session?.status !== 'open'} onClick={applyInspector}>Apply to draft</button><button disabled={busy || !selectedLayer.editable || session?.status !== 'open'} onClick={() => operation({ type: 'duplicate', sourceId: selectedSourceId })}>Duplicate</button></div>
        </> : <p className="meta">Select a layer in the tree or click a mapped node in the preview.</p>}
        <hr/><strong>Immutable revisions</strong>
        <div className="revision-list">{revisions.map((revision) => <button className={selectedRevisionId === revision.id ? 'primary' : 'ghost'} key={revision.id} onClick={() => onSelectRevision(revision.id)}>{new Date(revision.createdAt || Date.now()).toLocaleString()} · {revision.revisionKind || revision.status}</button>)}</div>
        <div className="row"><button disabled={busy || !selectedRevisionId || selectedRevisionId === component.selectedRevisionId} onClick={compare}>Compare</button><button disabled={busy || !selectedRevisionId || selectedRevisionId === component.selectedRevisionId} onClick={checkout}>Checkout</button><button disabled={busy || !selectedRevisionId} onClick={restore}>Restore as new</button></div>
        {comparison && <div className="compare-summary">{comparison.files.filter((file: any) => file.changed).map((file: any) => <div key={file.path}><strong>{file.path}</strong> · {file.changes.length} changed lines</div>)}</div>}
        {message && <div className="diagnostics" role="status">{message}</div>}
      </div>
    </section>
  </div>;
}
