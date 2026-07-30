import { useCallback, useEffect, useState } from 'react';
import { ProjectCanvas } from './canvas/ProjectCanvas';
import { ActionModal } from './components/ActionModal';
import { GlobalErrorBanner } from './components/GlobalErrorBanner';
import { VisualEditor } from './components/VisualEditor';
import { WebImportPanel } from './components/WebImportPanel';
import { DesignSystemsPage, LibrariesPage, SkillsPage } from './components/OperationalCollections';
import { api } from './lib/api';
import { nativeAvailable, openExportInIde, pickExportDestination } from './lib/native';

type Entity = Record<string, any> & { id: string; name?: string };
const routes = [['/files', 'Projects'], ['/design-systems', 'Design systems'], ['/libraries', 'Libraries'], ['/skills', 'Skills'], ['/agents', 'External agents'], ['/chat', 'Project chat']];
const errorText = (reason: any) => String(reason?.message || reason || 'Action failed');

function useRoute() {
  const [route, setRoute] = useState(location.pathname);
  const navigate = useCallback((next: string) => { history.pushState({}, '', next); setRoute(next); }, []);
  useEffect(() => { const pop = () => setRoute(location.pathname); addEventListener('popstate', pop); return () => removeEventListener('popstate', pop); }, []);
  return { route, navigate };
}
function useLoad<T>(load: () => Promise<T>, dependencies: unknown[] = []) {
  const [data, setData] = useState<T | null>(null); const [error, setError] = useState('');
  const refresh = useCallback(() => { setError(''); return load().then((value) => { setData(value); return value; }).catch((reason) => { setError(errorText(reason)); return null; }); }, dependencies);
  useEffect(() => { void refresh(); }, [refresh]);
  return { data, error, refresh, setData };
}
function ErrorBox({ message }: { message: string }) { return message ? <div className="diagnostics" role="alert">{message}</div> : null; }

function Layout({ route, navigate, title, actions, children, flush = false }: any) {
  return <div id="app">
    <GlobalErrorBanner/>
    <aside className="sidebar">
      <div className="brand"><div className="logo"/><div><h1>MyPath</h1><p>React · runnable · local</p></div></div>
      <nav className="nav">{routes.map(([href, label]) => <a className={route === href || route.startsWith(`${href}/`) ? 'active' : ''} href={href} key={href} onClick={(event) => { event.preventDefault(); navigate(href); }}>{label}</a>)}</nav>
      <div className="foot"><span className="badge">offline runtime</span><div>durable candidate builds</div></div>
    </aside>
    <main className="main"><header className="topbar"><h2>{title}</h2><div className="actions">{actions}</div></header><div className={flush ? 'content flush' : 'content'}>{children}</div></main>
  </div>;
}

type ProjectAction = { kind: 'create' | 'rename' | 'delete'; project?: Entity } | null;
function Projects({ navigate }: { navigate: (path: string) => void }) {
  const { data = [], error: loadError, refresh } = useLoad<Entity[]>(() => api.get('/api/v1/projects'));
  const [action, setAction] = useState<ProjectAction>(null); const [name, setName] = useState('New project'); const [pending, setPending] = useState(false); const [error, setError] = useState(''); const [status, setStatus] = useState('');
  const open = (next: ProjectAction) => { setAction(next); setName(next?.kind === 'rename' ? next.project?.name || '' : 'New project'); setError(''); setStatus(''); };
  const run = async () => {
    if (!action || pending) return; setPending(true); setError('');
    try {
      if (action.kind === 'create') { const item = await api.post<Entity>('/api/v1/projects', { name: name.trim() }); setStatus('Project created. Opening canvas…'); navigate(`/projects/${item.id}`); }
      else if (action.kind === 'rename' && action.project) { await api.patch(`/api/v1/projects/${action.project.id}`, { name: name.trim() }); await refresh(); setAction(null); setStatus('Project renamed.'); }
      else if (action.kind === 'delete' && action.project) { await api.del(`/api/v1/projects/${action.project.id}`); await refresh(); setAction(null); setStatus('Project deleted.'); }
    } catch (reason) { setError(errorText(reason)); } finally { setPending(false); }
  };
  return <><ErrorBox message={error || loadError}/>{status && !action && <div className="action-status" role="status">{status}</div>}<div className="grid">{data?.map((project) => <article className="card" key={project.id}><h3>{project.name}</h3><div className="meta">{project.description || 'Canvas workspace'}</div><div className="row"><button className="primary" onClick={() => navigate(`/projects/${project.id}`)}>Open canvas</button><button onClick={() => open({ kind: 'rename', project })}>Rename</button><button className="danger" onClick={() => open({ kind: 'delete', project })}>Delete</button></div></article>)}</div>{!data?.length && <div className="empty">No projects yet. Create one to open its canvas and project-scoped chat.</div>}<button className="primary floating-create" onClick={() => open({ kind: 'create' })}>New project</button>
    <ActionModal open={Boolean(action)} title={action?.kind === 'delete' ? 'Delete project?' : action?.kind === 'rename' ? 'Rename project' : 'Create a project'} description={action?.kind === 'delete' ? <>This permanently deletes <strong>{action.project?.name}</strong> and its workspace.</> : 'Projects contain the canvas, generation threads, imports, and provenance.'} confirmLabel={action?.kind === 'delete' ? 'Delete project' : action?.kind === 'rename' ? 'Save name' : 'Create project'} danger={action?.kind === 'delete'} pending={pending} error={error} status={status} field={action && action.kind !== 'delete' ? { label: 'Project name', value: name, onChange: setName, required: true } : undefined} onCancel={() => setAction(null)} onConfirm={run}/>
  </>;
}

function Project({ id, navigate }: any) {
  const load = useLoad(async () => { const [project, components] = await Promise.all([api.get<Entity>(`/api/v1/projects/${id}`), api.get<Entity[]>(`/api/v1/projects/${id}/components`)]); return { project, components }; }, [id]);
  if (!load.data) return <ErrorBox message={load.error || 'Loading canvas…'}/>;
  const generate = async (promptText: string) => { await api.post(`/api/v1/projects/${id}/components`, { prompt: promptText, generate: true }); await load.refresh(); };
  return <ProjectCanvas projectId={id} project={load.data.project} components={load.data.components} navigate={navigate} onGenerate={generate}/>;
}

function Component({ id, navigate }: { id: string; navigate: (path: string) => void }) {
  const load = useLoad(async () => { const [component, revisions, libraries] = await Promise.all([api.get<Entity>(`/api/v1/components/${id}`), api.get<Entity[]>(`/api/v1/components/${id}/revisions`), api.get<Entity[]>('/api/v1/libraries')]); return { component, revisions, libraries }; }, [id]);
  const [selectedRevision, setSelectedRevision] = useState(''); const [libraryId, setLibraryId] = useState(''); const [status, setStatus] = useState(''); const [busy, setBusy] = useState(''); const [confirmDelete, setConfirmDelete] = useState(false);
  useEffect(() => { const data = load.data; if (data) { setSelectedRevision((current) => current && data.revisions.some((revision) => revision.id === current) ? current : data.component.selectedRevisionId || ''); setLibraryId((current) => current && data.libraries.some((library) => library.id === current) ? current : data.libraries[0]?.id || ''); } }, [load.data]);
  if (!load.data) return <ErrorBox message={load.error || 'Loading component…'}/>;
  const perform = async (label: string, task: () => Promise<void>) => { if (busy) return; setBusy(label); setStatus(''); try { await task(); } catch (reason) { setStatus(`Failed: ${errorText(reason)}`); } finally { setBusy(''); } };
  const openInIde = () => perform('export', async () => { setStatus('Choose an export destination…'); const grant = await pickExportDestination(); if (grant.status !== 'granted' || !grant.destinationGrantId) { setStatus(grant.status === 'cancelled' ? 'Export cancelled.' : 'IDE export is unavailable in browser mode; ZIP download is available.'); return; } const exported = await api.post<any>(`/api/v1/revisions/${selectedRevision}/export-directory`, { destinationGrantId: grant.destinationGrantId }); const launched = await openExportInIde(exported.exportedPath); setStatus(`Exported to ${launched.exportedPath} · IDE ${launched.launchStatus}.`); });
  const exportFigma = () => perform('figma', async () => { const result = await api.get<any>(`/api/v1/revisions/${selectedRevision}/figma-exchange`); api.downloadJson(result.exchange || result, `${load.data?.component.name || 'component'}-figma.json`); setStatus('FigmaExchangeV1 JSON downloaded.'); });
  const remove = () => perform('delete', async () => { await api.del(`/api/v1/components/${id}`); setStatus('Component deleted.'); navigate(`/projects/${load.data?.component.projectId}`); });
  const missingRevision = selectedRevision ? '' : 'Select a built revision first.';
  return <div className="component-page"><div className="component-heading"><div><strong>{load.data.component.name}</strong><span className="meta">Visual editing is limited to traceable literal intrinsic JSX.</span>{status && <span className={status.startsWith('Failed:') ? 'diagnostics inline-status' : 'meta export-status'} role={status.startsWith('Failed:') ? 'alert' : 'status'}>{status}</span>}</div><div className="row"><select aria-label="Target library" value={libraryId} onChange={(event) => setLibraryId(event.target.value)}><option value="">No library</option>{load.data.libraries.map((library) => <option value={library.id} key={library.id}>{library.name}</option>)}</select><button disabled={Boolean(busy) || !libraryId || !selectedRevision} title={!libraryId ? 'Create or select a library first.' : missingRevision} onClick={() => perform('library', async () => { await api.post(`/api/v1/libraries/${libraryId}/components`, { componentId: id, revisionId: selectedRevision }); setStatus('Exact selected revision added to library.'); })}>{busy === 'library' ? 'Adding…' : 'Add exact revision'}</button><button disabled={Boolean(busy) || !selectedRevision} title={missingRevision} onClick={() => perform('zip', async () => { await api.download(`/api/v1/revisions/${selectedRevision}/export.zip`); setStatus('Runnable ZIP downloaded.'); })}>Download runnable ZIP</button><button disabled={Boolean(busy) || !selectedRevision} title={missingRevision} onClick={exportFigma}>{busy === 'figma' ? 'Exporting…' : 'Download Figma JSON'}</button><button disabled={Boolean(busy) || !selectedRevision} title={nativeAvailable() ? missingRevision : 'Desktop app required; ZIP export remains available'} onClick={openInIde}>Export &amp; open IDE</button><button className="danger" disabled={Boolean(busy)} onClick={() => { setStatus(''); setConfirmDelete(true); }}>Delete</button></div></div><VisualEditor component={load.data.component} revisions={load.data.revisions} selectedRevisionId={selectedRevision} onSelectRevision={setSelectedRevision} onRefresh={load.refresh}/><ActionModal open={confirmDelete} title="Delete component?" description="This removes the component from the project. Immutable library memberships remain traceable." confirmLabel="Delete component" danger pending={busy === 'delete'} error={status.startsWith('Failed:') ? status : ''} onCancel={() => setConfirmDelete(false)} onConfirm={remove}/></div>;
}

function ExternalAgents() {
  const projects = useLoad<Entity[]>(() => api.get('/api/v1/projects')); const grants = useLoad<any[]>(() => api.get('/api/v1/external-agent-grants')); const pending = useLoad<any[]>(() => api.get('/api/v1/external-agent-submissions')); const [token, setToken] = useState(''); const [error, setError] = useState(''); const [busy, setBusy] = useState('');
  const act = async (name: string, task: () => Promise<void>) => { if (busy) return; setBusy(name); setError(''); try { await task(); } catch (reason) { setError(errorText(reason)); } finally { setBusy(''); } };
  const create = () => act('create', async () => { const projectId = projects.data?.[0]?.id; if (!projectId) throw new Error('Create a project before issuing an external-agent token.'); const grant = await api.post<any>('/api/v1/external-agent-grants', { label: 'Local external agent', projectIds: [projectId], ttlSeconds: 3600 }); setToken(grant.token); await grants.refresh(); });
  const projectProblem = projects.error || (!projects.data ? 'Loading projects…' : !projects.data.length ? 'Create a project before issuing a token.' : '');
  return <><ErrorBox message={error || projects.error || grants.error || pending.error}/><section className="card agent-access"><h3>Scoped external-agent access</h3><p className="meta">Tokens work only on /api/v1/external-agent/** and cannot accept or reject their own candidates.</p><button className="primary" disabled={Boolean(busy) || !projects.data?.length} title={projectProblem} onClick={create}>{busy === 'create' ? 'Creating…' : `Create one-hour token for ${projects.data?.[0]?.name || 'a project'}`}</button>{projectProblem && <p className="prerequisite-note">{projectProblem}</p>}{token && <div className="one-time-token"><b>Copy now — shown once</b><code>{token}</code></div>}{grants.data?.map((grant) => <div className="library-member" key={grant.id}><b>{grant.label}</b><small>{grant.projectIds.join(', ')} · expires {grant.expiresAt}</small>{!grant.revokedAt && <button disabled={Boolean(busy)} onClick={() => act(`revoke:${grant.id}`, async () => { await api.del(`/api/v1/external-agent-grants/${grant.id}`); await grants.refresh(); })}>{busy === `revoke:${grant.id}` ? 'Revoking…' : 'Revoke'}</button>}</div>)}</section><section className="card"><h3>Candidate review</h3>{!pending.data?.length && <p className="meta">No candidates await desktop review.</p>}{pending.data?.map((submission) => <div className="agent-submission" key={submission.id}><div><b>{submission.note || submission.id}</b><small>{submission.diff.changedCount} changed file(s) · build {submission.build?.status}</small></div><div className="row"><button className="primary" disabled={Boolean(busy)} onClick={() => act(`accept:${submission.id}`, async () => { await api.post(`/api/v1/external-agent/submissions/${submission.id}/accept`); await pending.refresh(); })}>Accept</button><button className="danger" disabled={Boolean(busy)} onClick={() => act(`reject:${submission.id}`, async () => { await api.post(`/api/v1/external-agent/submissions/${submission.id}/reject`); await pending.refresh(); })}>Reject</button></div></div>)}</section></>;
}

function ProjectChatChooser({ navigate }: { navigate: (path: string) => void }) {
  const projects = useLoad<Entity[]>(() => api.get('/api/v1/projects'));
  return <><ErrorBox message={projects.error}/><section className="card project-chooser"><h3>Choose a project for chat and generation</h3><p className="meta">AI runs require a project canvas and an immutable operational context. Open a project to use its real project-scoped chat; this page does not simulate AI output.</p>{projects.data?.map((project) => <button className="list-item" key={project.id} onClick={() => navigate(`/projects/${project.id}`)}><strong>{project.name}</strong><small>Open canvas and project chat →</small></button>)}{projects.data && !projects.data.length && <p className="prerequisite-note">Create a project first from Projects.</p>}<button onClick={() => navigate('/files')}>{projects.data?.length ? 'Back to projects' : 'Create a project'}</button></section></>;
}

export default function App() {
  const { route, navigate } = useRoute(); let title = 'Projects'; let content: any;
  if (/^\/projects\/[^/]+\/web-import$/.test(route)) { const id = route.split('/')[2]; title = 'Web import'; content = <WebImportPanel projectId={id} navigate={navigate}/>; }
  else if (route.startsWith('/projects/')) { const id = route.split('/')[2]; title = 'Canvas'; content = <Project id={id} navigate={navigate}/>; }
  else if (route.startsWith('/components/')) { title = 'Design preview'; content = <Component id={route.split('/')[2]} navigate={navigate}/>; }
  else if (route === '/design-systems') { title = 'Design systems'; content = <DesignSystemsPage/>; }
  else if (route === '/libraries') { title = 'Libraries'; content = <LibrariesPage/>; }
  else if (route === '/skills') { title = 'Skills'; content = <SkillsPage/>; }
  else if (route === '/agents') { title = 'External agents'; content = <ExternalAgents/>; }
  else if (route === '/chat') { title = 'Project chat'; content = <ProjectChatChooser navigate={navigate}/>; }
  else content = <Projects navigate={navigate}/>;
  return <Layout route={route} navigate={navigate} title={title} flush={title === 'Canvas'} actions={null}>{content}</Layout>;
}
