import { ChangeEvent, useCallback, useEffect, useState } from 'react';
import { api } from '../lib/api';
import { ActionModal } from './ActionModal';

type Entity = Record<string, any> & { id: string; name?: string };
type Status = { kind: 'error' | 'success' | 'info' | 'warn'; text: string } | null;
const errorText = (reason: any) => String(reason?.message || reason || 'Action failed');
const isColorValue = (value: string) => /^#[0-9a-f]{3,8}$/i.test(value.trim()) || /^(rgb|hsl)a?\(/i.test(value.trim());
function Feedback({ status }: { status: Status }) { return status ? <p className={'status-message ' + status.kind} role={status.kind === 'error' ? 'alert' : 'status'}>{status.text}</p> : null; }
function TokenRows({ tokens }: { tokens: Record<string, any> }) { return <>{Object.entries(tokens || {}).map(([name, value]) => <div className="proposal-token" key={name}>{isColorValue(String(value)) && <span className="proposal-swatch" style={{ background: String(value) }}/>}<span>{name}</span><span>{String(value)}</span></div>)}</>; }

export function DesignSystemsPage() {
  const [items, setItems] = useState<Entity[] | null>(null); const [loading, setLoading] = useState(true); const [source, setSource] = useState(''); const [review, setReview] = useState<any>(null); const [status, setStatus] = useState<Status>(null); const [busy, setBusy] = useState(''); const [modal, setModal] = useState<{ kind: 'create' | 'version'; item?: Entity } | null>(null); const [value, setValue] = useState('');
  const refresh = useCallback(async () => { try { setItems(await api.get<Entity[]>('/api/v1/design-systems')); } catch (reason) { setStatus({ kind: 'error', text: errorText(reason) }); } finally { setLoading(false); } }, []); useEffect(() => { void refresh(); }, [refresh]);
  useEffect(() => { if (!status || status.kind === 'error') return; const t = setTimeout(() => setStatus(null), 6000); return () => clearTimeout(t); }, [status]);
  const perform = async (name: string, task: () => Promise<void>) => { if (busy) return; setBusy(name); setStatus(null); try { await task(); } catch (reason) { setStatus({ kind: 'error', text: errorText(reason) }); } finally { setBusy(''); } };
  // Treat a bare host ("example.com/theme.css") as a URL too; only CSS punctuation or
  // whitespace marks the input as a stylesheet, so a pasted address is never sent as CSS.
  const asSource = (raw: string) => { const trimmed = raw.trim(); if (/^https?:\/\//i.test(trimmed)) return { url: trimmed }; if (!/[{};]/.test(trimmed) && !/\s/.test(trimmed) && /^[a-z0-9.-]+\.[a-z]{2,}(?:[/:?]|$)/i.test(trimmed)) return { url: `https://${trimmed}` }; return { css: raw }; };
  const extract = () => perform('extract', async () => {
    const result = await api.post<any>('/api/v1/theme-extractions', asSource(source));
    setReview(result);
    if (result?.status === 'failed') setStatus({ kind: 'error', text: result.diagnostics?.map((item: any) => item.message).filter(Boolean).join(' · ') || 'Extraction failed and produced no tokens.' });
    else setStatus({ kind: 'info', text: 'Extraction is ready for review.' });
  });
  const open = (kind: 'create' | 'version', item?: Entity) => { setModal({ kind, item }); setValue(kind === 'create' ? 'New design system' : item?.markdown || `# ${item?.name || 'Design system'}`); setStatus(null); };
  const save = () => perform('modal', async () => { if (modal?.kind === 'create') { await api.post('/api/v1/design-systems', { name: value.trim() }); setStatus({ kind: 'success', text: 'Design system created.' }); } else if (modal?.item) { await api.post(`/api/v1/design-systems/${modal.item.id}/versions`, { markdown: value }); setStatus({ kind: 'success', text: 'New version created.' }); } await refresh(); setModal(null); });
  return <>
    <Feedback status={status}/>
    <section className="theme-extractor card">
      <h3>Reviewed theme extraction</h3>
      <p className="meta">Paste CSS or a web address starting with https://. Nothing is activated until you review and approve the proposed tokens.</p>
      <textarea value={source} onChange={(event) => setSource(event.target.value)} placeholder={'https://example.com/theme.css\n—or—\n:root { --background: #fff; }'}/>
      <button onClick={extract} disabled={Boolean(busy) || !source.trim()} title={!source.trim() ? 'Paste CSS or a web address first.' : ''}>{busy === 'extract' ? 'Extracting…' : 'Extract for review'}</button>
      {review?.status === 'pending' && <div className="proposal-review">
        <p className="meta">Proposed design system: <strong>{review.proposal?.name || 'Untitled theme'}</strong> · default theme {review.proposal?.defaultTheme || 'light'}</p>
        {review.proposal?.light && Object.keys(review.proposal.light).length > 0 && <div><h4>Light tokens</h4><TokenRows tokens={review.proposal.light}/></div>}
        {review.proposal?.dark && Object.keys(review.proposal.dark).length > 0 && <div><h4>Dark tokens</h4><TokenRows tokens={review.proposal.dark}/></div>}
        <details><summary>Raw data</summary><pre>{JSON.stringify(review.proposal, null, 2)}</pre></details>
        <div className="row">
          <button className="primary" disabled={Boolean(busy)} onClick={() => perform('approve', async () => { const approved = await api.post<any>(`/api/v1/theme-extractions/${review.id}/review`, { approved: true, proposal: review.proposal }); setReview(approved); await refresh(); setStatus({ kind: 'success', text: 'Approved and created a new design system.' }); })}>{busy === 'approve' ? 'Approving…' : 'Approve and create design system'}</button>
          <button className="danger" disabled={Boolean(busy)} onClick={() => perform('reject', async () => { setReview(await api.post(`/api/v1/theme-extractions/${review.id}/review`, { approved: false })); setStatus({ kind: 'info', text: 'Proposal rejected.' }); })}>Reject</button>
        </div>
      </div>}
      {review?.status === 'failed' && <div className="status-message error" role="alert"><strong>Could not extract a theme</strong>{review.diagnostics?.length ? <ul>{review.diagnostics.map((item: any, index: number) => <li key={`${item.code}-${index}`}>{item.message || item.code}</li>)}</ul> : <p>The address was reached but produced no reusable tokens.</p>}<p className="meta">This reads CSS custom properties (<code>--token: value;</code>). A page or stylesheet that defines none cannot be extracted.</p></div>}
      {review && review.status !== 'pending' && review.status !== 'failed' && <p className="status-message info" role="status" title={review.versionId || ''}>Review {review.status}{review.versionId ? ' · saved as a new version' : ''}</p>}
    </section>
    {loading ? <div className="loading-state" role="status"><span className="loading-pulse"/>Loading design systems…</div>
      : items && items.length > 0 ? <div className="grid">{items.map((item) => <article className="card" key={item.id}><h3>{item.name}</h3><div className="meta">Version {item.currentVersion?.version || '?'}<small className="meta" title={item.currentVersion?.id || ''}>{item.currentVersion?.id ? ' · compiled' : ' · not compiled'}</small></div><p>{item.markdown || item.prompt}</p><div className="row"><button disabled={Boolean(busy)} onClick={() => open('version', item)}>New version</button></div></article>)}</div>
      : <div className="empty"><strong>No design systems yet</strong><span>Extract one from a URL or CSS above, or create one from scratch, to reuse its tokens across projects.</span></div>}
    <button className="primary floating-create" disabled={Boolean(busy)} onClick={() => open('create')}>New design system</button>
    <ActionModal open={Boolean(modal)} title={modal?.kind === 'create' ? 'Create design system' : `New version of ${modal?.item?.name || 'design system'}`} description={modal?.kind === 'create' ? 'A first version will be created.' : 'Edit DESIGN.md. Saving creates a new version.'} confirmLabel={modal?.kind === 'create' ? 'Create design system' : 'Create version'} pending={busy === 'modal'} error={status?.kind === 'error' ? status.text : ''} field={{ label: modal?.kind === 'create' ? 'Name' : 'DESIGN.md', value, onChange: setValue, required: true, multiline: modal?.kind === 'version' }} onCancel={() => setModal(null)} onConfirm={save}/>
  </>;
}

function CollectionCreatePage({ kind }: { kind: 'library' | 'skill' }) {
  const plural = kind === 'library' ? 'libraries' : 'skills'; const title = kind === 'library' ? 'Library' : 'Skill';
  const [items, setItems] = useState<Entity[] | null>(null); const [loading, setLoading] = useState(true); const [status, setStatus] = useState<Status>(null); const [busy, setBusy] = useState(false); const [open, setOpen] = useState(false); const [editing, setEditing] = useState<Entity | null>(null); const [name, setName] = useState(`New ${kind}`); const [description, setDescription] = useState(''); const [content, setContent] = useState('');
  const refresh = useCallback(async () => { try { setItems(await api.get<Entity[]>(`/api/v1/${plural}`)); } catch (reason) { setStatus({ kind: 'error', text: errorText(reason) }); } finally { setLoading(false); } }, [plural]); useEffect(() => { void refresh(); }, [refresh]);
  useEffect(() => { if (!status || status.kind === 'error') return; const t = setTimeout(() => setStatus(null), 6000); return () => clearTimeout(t); }, [status]);
  const beginCreate = () => { setEditing(null); setName(`New ${kind}`); setDescription(''); setContent(kind === 'skill' ? '# Instructions\n' : ''); setStatus(null); setOpen(true); };
  const beginEdit = (item: Entity) => { setEditing(item); setName(item.name || 'Skill'); setDescription(item.description || ''); setContent(item.currentVersion?.content || item.content || ''); setStatus(null); setOpen(true); };
  const save = async () => { if (busy) return; setBusy(true); setStatus(null); try { const body = kind === 'skill' ? { name: name.trim(), description: description.trim(), content } : { name: name.trim() }; if (editing) await api.patch(`/api/v1/skills/${editing.id}`, body); else await api.post(`/api/v1/${plural}`, body); await refresh(); setOpen(false); setStatus({ kind: 'success', text: `${title} ${editing ? 'updated with a new version' : 'created'}.` }); } catch (reason) { setStatus({ kind: 'error', text: errorText(reason) }); } finally { setBusy(false); } };
  const emptyCopy = kind === 'library' ? { title: 'No libraries yet', body: 'Libraries pin exact component versions so you can reuse them across projects. Create one to get started.' } : { title: 'No skills yet', body: 'Skills are step-by-step instructions the assistant follows when you ask for something specific. Create one to get started.' };
  return <>
    <Feedback status={status}/>
    {kind === 'skill' && <SkillImport busy={busy} setBusy={setBusy} setStatus={setStatus} refresh={refresh}/>}
    {loading ? <div className="loading-state" role="status"><span className="loading-pulse"/>Loading {plural}…</div>
      : items && items.length > 0 ? <div className="grid">{items.map((item) => <article className="card" key={item.id}><h3>{item.name}{item.builtin ? ' · built-in' : ''}</h3>{kind === 'library' ? <><div className="meta">{item.membershipCount} pinned component{item.membershipCount === 1 ? '' : 's'}</div>{item.members?.map((member: any) => <div className="library-member" key={member.revisionId}><b>{member.name}</b><small className="meta" title={member.revisionId}>{member.status}</small></div>)}</> : <><div className="meta">Version {item.currentVersion?.version || '?'} · {item.optionalActivation ? 'suggested automatically' : 'selected manually'}</div><p>{item.description || 'No description yet.'}</p>{!item.builtin && <div className="row"><button disabled={busy} onClick={() => beginEdit(item)}>Edit skill</button></div>}</>}</article>)}</div>
      : <div className="empty"><strong>{emptyCopy.title}</strong><span>{emptyCopy.body}</span></div>}
    <button className="primary floating-create" disabled={busy} onClick={beginCreate}>New {kind}</button>
    <ActionModal open={open} title={editing ? `Edit ${editing.name}` : `Create ${kind}`} description={kind === 'library' ? 'Libraries pin exact component versions.' : editing ? 'Saving creates a new version of this skill.' : 'Write the instructions the assistant should follow when this skill is selected.'} confirmLabel={editing ? 'Create new version' : `Create ${kind}`} pending={busy} error={status?.kind === 'error' ? status.text : ''} fields={kind === 'skill' ? [{ label: 'Skill name', value: name, onChange: setName, required: true }, { label: 'Description', value: description, onChange: setDescription, required: true }, { label: 'Instructions', value: content, onChange: setContent, required: true, multiline: true }] : [{ label: `${title} name`, value: name, onChange: setName, required: true }]} onCancel={() => setOpen(false)} onConfirm={save}/>
  </>;
}

function SkillImport({ busy, setBusy, setStatus, refresh }: any) {
  const ingest = async (event: ChangeEvent<HTMLInputElement>) => { const file = event.target.files?.[0]; if (!file || busy) return; setBusy(true); setStatus(null); try { const bytes = new Uint8Array(await file.arrayBuffer()); let binary = ''; for (const byte of bytes) binary += String.fromCharCode(byte); await api.post('/api/v1/skills/import', { name: file.name, base64: btoa(binary) }); await refresh(); setStatus({ kind: 'success', text: `Imported ${file.name}.` }); } catch (reason) { setStatus({ kind: 'error', text: errorText(reason) }); } finally { setBusy(false); event.target.value = ''; } };
  return <label className="upload-control">{busy ? 'Importing…' : 'Import a skill file (.skill or a zip under 5 MB)'}<input disabled={busy} type="file" accept=".skill,.zip" onChange={ingest}/></label>;
}
export function LibrariesPage() { return <CollectionCreatePage kind="library"/>; }
export function SkillsPage() { return <CollectionCreatePage kind="skill"/>; }
