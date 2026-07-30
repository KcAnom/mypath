import { FormEvent, useEffect, useRef, useState } from 'react';
import { api } from '../lib/api';

type Provider = { id: string; label: string; kind: string; status: string; model?: string | null };
type Thread = { id: string; title: string; latestRun?: { status: string } | null };
type Attempt = { id: string; attemptNumber: number; status: string; errorCode?: string };
type Job = { id: string; name: string; status: string; attempts: Attempt[]; componentId?: string; revisionId?: string };
type Run = { id: string; status: string; completedCount: number; deliverableCount: number; predecessorRunId?: string | null; jobs: Job[] };
const terminal = new Set(['succeeded', 'partial', 'failed', 'cancelled']);

type Skill = { id: string; name?: string; description?: string; builtin?: boolean };
export function ProjectChatPanel({ projectId, contextSnapshot, contextLabels = [], skills = [], selectedSkillIds = [], onSkillToggle, prepareContext }: { projectId: string; contextSnapshot: any; contextLabels?: string[]; skills?: Skill[]; selectedSkillIds?: string[]; onSkillToggle?: (id: string) => void; prepareContext?: (input: { prompt: string; skillIds: string[]; allowDescriptionActivation: boolean }) => Promise<any> }) {
  const [providers, setProviders] = useState<Provider[]>([]); const [providerId, setProviderId] = useState('fixture');
  const [threads, setThreads] = useState<Thread[]>([]); const [threadId, setThreadId] = useState(''); const [messages, setMessages] = useState<any[]>([]);
  const [prompt, setPrompt] = useState(''); const [deliverables, setDeliverables] = useState(''); const [run, setRun] = useState<Run | null>(null);
  const [allowDescriptionActivation, setAllowDescriptionActivation] = useState(false);
  const [error, setError] = useState(''); const [status, setStatus] = useState(''); const [submitting, setSubmitting] = useState(false); const [actionBusy, setActionBusy] = useState(''); const stream = useRef<AbortController | null>(null);
  const refreshThreads = async () => { const value = await api.get<Thread[]>(`/api/v1/projects/${projectId}/chat/threads`); setThreads(value); if (!threadId && value[0]) setThreadId(value[0].id); };
  useEffect(() => { void Promise.all([api.get<Provider[]>('/api/v1/provider-configs').then((value) => { setProviders(value); const preferred = value.find((item) => item.id === providerId && item.status === 'ready') || value.find((item) => item.status === 'ready'); setProviderId(preferred?.id || ''); }), refreshThreads()]).catch((reason) => setError(reason.message)); }, [projectId]);
  useEffect(() => { if (!threadId) { setMessages([]); return; } void api.get<any[]>(`/api/v1/projects/${projectId}/chat/threads/${threadId}/messages`).then(setMessages).catch((reason) => setError(reason.message)); }, [projectId, threadId]);
  useEffect(() => {
    stream.current?.abort(); if (!run || terminal.has(run.status)) return;
    const controller = new AbortController(); stream.current = controller;
    void api.stream(`/api/v1/thread-runs/${run.id}/events`, async (event) => {
      if (['job_succeeded', 'job_failed', 'job_cancelled', 'job_retried', 'run_finished', 'run_cancelled'].includes(event.type)) {
        const current = await api.get<Run>(`/api/v1/thread-runs/${run.id}`); setRun(current);
        if (terminal.has(current.status) && threadId) setMessages(await api.get(`/api/v1/projects/${projectId}/chat/threads/${threadId}/messages`));
      }
    }, controller.signal).catch((reason) => { if (!controller.signal.aborted) setError(reason.message); });
    return () => controller.abort();
  }, [run?.id, run?.status, projectId, threadId]);
  const action = async (name: string, task: () => Promise<void>) => { if (actionBusy || submitting) return; setActionBusy(name); setError(''); setStatus(''); try { await task(); } catch (reason: any) { setError(reason?.message || String(reason)); } finally { setActionBusy(''); } };
  const createThread = () => action('thread', async () => { const thread = await api.post<Thread>(`/api/v1/projects/${projectId}/chat/threads`, { title: 'New project thread' }); await refreshThreads(); setThreadId(thread.id); setRun(null); setStatus('New project thread created.'); });
  const submit = async (event: FormEvent, newThread = false) => {
    event.preventDefault(); if (!prompt.trim() || submitting) return; const provider = providers.find((item) => item.id === providerId); if (!provider || provider.status !== 'ready') { setError('Select a ready generation provider before running.'); return; } setSubmitting(true); setError(''); setStatus('');
    try {
      const exactContext = prepareContext ? await prepareContext({ prompt, skillIds: selectedSkillIds, allowDescriptionActivation }) : contextSnapshot;
      if (!exactContext?.id) throw new Error('Freeze the selected operational context before running');
      const names = deliverables.split(',').map((name) => name.trim()).filter(Boolean); const body = { prompt, contextSnapshotId: exactContext.id, providerConfigId: providerId, ...(names.length ? { deliverables: names } : {}) };
      if (newThread || !threadId) { const value = await api.post<{ thread: Thread; run: Run }>(`/api/v1/projects/${projectId}/chat/runs`, body); setThreadId(value.thread.id); setRun(value.run); }
      else setRun(await api.post<Run>(`/api/v1/projects/${projectId}/chat/threads/${threadId}/runs`, body));
      setPrompt(''); setDeliverables(''); await refreshThreads(); setStatus('Run queued. Progress will update below.');
    } catch (reason: any) { setError(reason.message); } finally { setSubmitting(false); }
  };
  const retry = (jobId: string) => action(`retry:${jobId}`, async () => { setRun(await api.post<Run>(`/api/v1/jobs/${jobId}/retry`)); setStatus('Deliverable retry queued.'); });
  return <section className="project-chat" aria-label="Project chat">
    <div className="project-chat-head"><strong>Project chat</strong><button className="ghost" disabled={Boolean(actionBusy) || submitting} onClick={createThread}>{actionBusy === 'thread' ? 'Creating…' : 'New thread'}</button></div>
    <div className="provider-row"><select aria-label="Generation provider" value={providerId} onChange={(event) => setProviderId(event.target.value)}><option value="" disabled>No ready provider selected</option>{providers.map((provider) => <option disabled={provider.status !== 'ready'} value={provider.id} key={provider.id}>{provider.label} · {provider.status}</option>)}</select><span className={`provider-status ${providers.find((item) => item.id === providerId)?.status || ''}`}>{providers.find((item) => item.id === providerId)?.kind || 'No ready provider'}</span></div>
    <select aria-label="Project thread" value={threadId} onChange={(event) => { setThreadId(event.target.value); setRun(null); }}><option value="">New thread</option>{threads.map((thread) => <option key={thread.id} value={thread.id}>{thread.title}{thread.latestRun ? ` · ${thread.latestRun.status}` : ''}</option>)}</select>
    <div className="project-chat-log">{messages.slice(-8).map((message) => <div className={`bubble ${message.role}`} key={message.id}>{message.content}{message.contextSnapshotId && <small>Context {message.contextSnapshotId.slice(4, 12)}</small>}</div>)}{!messages.length && <small>Runs in different threads are independent. Requests in this thread queue in order.</small>}</div>
    <div className="context-pills"><span className={contextSnapshot?.id ? 'context-pill frozen' : 'context-pill'}>{contextSnapshot?.id ? `ContextEnvelopeV1 · v${contextSnapshot.canvas?.version}` : 'Context is frozen when the run starts'}</span>{contextLabels.map((label) => <span className="context-pill" key={label}>{label}</span>)}{selectedSkillIds.map((skillId) => <button type="button" className="context-pill selected-skill" key={skillId} onClick={() => onSkillToggle?.(skillId)}>/ {skills.find((skill) => skill.id === skillId)?.name || skillId} ×</button>)}</div>
    {run && <div className="run-progress"><div className="run-summary"><strong>{run.completedCount}/{run.deliverableCount} deliverables</strong><span>{run.status}{run.predecessorRunId && run.status === 'queued' ? ' · waiting for thread' : ''}</span></div><progress max={run.deliverableCount} value={run.completedCount}/>{run.jobs.map((job) => <div className="deliverable" key={job.id}><span><b>{job.name}</b><small>{job.status} · attempt {job.attempts.at(-1)?.attemptNumber}</small></span>{['failed', 'cancelled'].includes(job.status) && <button disabled={Boolean(actionBusy)} onClick={() => retry(job.id)}>{actionBusy === `retry:${job.id}` ? 'Retrying…' : 'Retry'}</button>}</div>)}{!terminal.has(run.status) && <button className="danger" disabled={Boolean(actionBusy)} onClick={() => action('cancel', async () => { setRun(await api.post<Run>(`/api/v1/thread-runs/${run.id}/cancel`)); setStatus('Run cancelled.'); })}>{actionBusy === 'cancel' ? 'Cancelling…' : 'Cancel run'}</button>}</div>}
    {error && <div className="diagnostics" role="alert">{error}</div>}{status && !error && <div className="action-status" role="status">{status}</div>}
    <form className="project-composer" onSubmit={(event) => void submit(event)}>
      <textarea value={prompt} onChange={(event) => setPrompt(event.target.value)} placeholder="Describe screens… Type / to explicitly select a skill"/>
      {prompt.trimStart().startsWith('/') && <div className="slash-skill-menu" role="menu" aria-label="Skill menu">{skills.map((skill) => <button type="button" role="menuitemcheckbox" aria-checked={selectedSkillIds.includes(skill.id)} key={skill.id} onClick={() => { onSkillToggle?.(skill.id); setPrompt((value) => value.replace(/^\s*\/[^\s]*\s*/, '')); }}><b>/ {skill.name}</b><small>{skill.description}</small></button>)}</div>}
      <label className="safe-activation"><input type="checkbox" checked={allowDescriptionActivation} onChange={(event) => setAllowDescriptionActivation(event.target.checked)}/> Optionally suggest skills using descriptions only</label>
      <input value={deliverables} onChange={(event) => setDeliverables(event.target.value)} placeholder="Optional deliverables: Home, Search, Profile"/><div className="row"><button className="primary" disabled={submitting || Boolean(actionBusy) || !prompt.trim() || providers.find((item) => item.id === providerId)?.status !== 'ready'} title={!prompt.trim() ? 'Enter a request first.' : providers.find((item) => item.id === providerId)?.status !== 'ready' ? 'Select a ready generation provider.' : ''}>{submitting ? 'Queueing…' : 'Run in thread'}</button><button type="button" disabled={submitting || Boolean(actionBusy) || !prompt.trim() || providers.find((item) => item.id === providerId)?.status !== 'ready'} onClick={(event) => void submit(event as any, true)}>Run in new thread</button></div></form>
  </section>;
}
