import { FormEvent, useEffect, useRef, useState } from 'react';
import { api } from '../lib/api';

type Provider = { id: string; label: string; kind: string; status: string; model?: string | null };
type Thread = { id: string; title: string; latestRun?: { id: string; status: string } | null };
type Attempt = { id: string; attemptNumber: number; status: string; errorCode?: string };
type Job = { id: string; name: string; status: string; attempts: Attempt[]; componentId?: string; revisionId?: string };
type Run = { id: string; status: string; completedCount: number; deliverableCount: number; predecessorRunId?: string | null; jobs: Job[] };
type Status = { kind: 'error' | 'success' | 'info'; text: string } | null;
const terminal = new Set(['succeeded', 'partial', 'failed', 'cancelled']);
const providerUsable = (provider?: Provider) => Boolean(provider && ['ready', 'configured'].includes(provider.status));
const CHAT_LOG_PAGE = 20;

type Skill = { id: string; name?: string; description?: string; builtin?: boolean };
export function ProjectChatPanel({ projectId, contextSnapshot, contextLabels = [], skills = [], selectedSkillIds = [], onSkillToggle, prepareContext }: { projectId: string; contextSnapshot: any; contextLabels?: string[]; skills?: Skill[]; selectedSkillIds?: string[]; onSkillToggle?: (id: string) => void; prepareContext?: (input: { prompt: string; skillIds: string[]; allowDescriptionActivation: boolean }) => Promise<any> }) {
  const [providers, setProviders] = useState<Provider[]>([]); const [providerId, setProviderId] = useState('fixture');
  const [threads, setThreads] = useState<Thread[]>([]); const [threadId, setThreadId] = useState(''); const [messages, setMessages] = useState<any[]>([]);
  const [prompt, setPrompt] = useState(''); const [deliverables, setDeliverables] = useState(''); const [run, setRun] = useState<Run | null>(null);
  const [allowDescriptionActivation, setAllowDescriptionActivation] = useState(false);
  const [status, setStatus] = useState<Status>(null); const [submitting, setSubmitting] = useState(false); const [actionBusy, setActionBusy] = useState(''); const stream = useRef<AbortController | null>(null);
  const [visibleCount, setVisibleCount] = useState(CHAT_LOG_PAGE); const [hasNewMessages, setHasNewMessages] = useState(false);
  const logRef = useRef<HTMLDivElement>(null); const nearBottomRef = useRef(true); const pendingPrependRef = useRef<{ scrollHeight: number; scrollTop: number } | null>(null); const prevMessagesRef = useRef<any[]>([]);
  const refreshThreads = async () => { const value = await api.get<Thread[]>(`/api/v1/projects/${projectId}/chat/threads`); setThreads(value); if (!threadId && value[0]) setThreadId(value[0].id); };
  useEffect(() => { void Promise.all([api.get<Provider[]>('/api/v1/provider-configs').then((value) => { setProviders(value); const preferred = value.find((item) => item.id === providerId && providerUsable(item)) || value.find(providerUsable); setProviderId(preferred?.id || ''); }), refreshThreads()]).catch((reason) => setStatus({ kind: 'error', text: reason.message })); }, [projectId]);
  useEffect(() => { setVisibleCount(CHAT_LOG_PAGE); setHasNewMessages(false); nearBottomRef.current = true; prevMessagesRef.current = []; }, [threadId]);
  useEffect(() => {
    if (!threadId) { setMessages([]); setRun(null); return; }
    void (async () => {
      setMessages(await api.get<any[]>(`/api/v1/projects/${projectId}/chat/threads/${threadId}/messages`));
      const latest = threads.find((thread) => thread.id === threadId)?.latestRun;
      setRun(latest?.id ? await api.get<Run>(`/api/v1/thread-runs/${latest.id}`) : null);
    })().catch((reason) => setStatus({ kind: 'error', text: reason.message }));
  }, [projectId, threadId, threads]);
  useEffect(() => {
    stream.current?.abort(); if (!run || terminal.has(run.status)) return;
    const controller = new AbortController(); stream.current = controller;
    void api.stream(`/api/v1/thread-runs/${run.id}/events`, async (event) => {
      if (['job_succeeded', 'job_failed', 'job_cancelled', 'job_retried', 'run_finished', 'run_cancelled'].includes(event.type)) {
        const current = await api.get<Run>(`/api/v1/thread-runs/${run.id}`); setRun(current);
        if (terminal.has(current.status) && threadId) setMessages(await api.get(`/api/v1/projects/${projectId}/chat/threads/${threadId}/messages`));
      }
    }, controller.signal).catch((reason) => { if (!controller.signal.aborted) setStatus({ kind: 'error', text: reason.message }); });
    return () => controller.abort();
  }, [run?.id, run?.status, projectId, threadId]);
  useEffect(() => { if (!status || status.kind === 'error') return; const t = setTimeout(() => setStatus(null), 6000); return () => clearTimeout(t); }, [status]);
  useEffect(() => {
    const el = logRef.current; if (!el) return;
    if (pendingPrependRef.current) { const { scrollHeight, scrollTop } = pendingPrependRef.current; el.scrollTop = el.scrollHeight - scrollHeight + scrollTop; pendingPrependRef.current = null; prevMessagesRef.current = messages; return; }
    const grew = messages.length !== prevMessagesRef.current.length || messages.at(-1)?.id !== prevMessagesRef.current.at(-1)?.id;
    if (grew) { if (!prevMessagesRef.current.length || nearBottomRef.current) { el.scrollTop = el.scrollHeight; setHasNewMessages(false); } else setHasNewMessages(true); }
    prevMessagesRef.current = messages;
  }, [messages, visibleCount]);
  const onLogScroll = () => { const el = logRef.current; if (!el) return; nearBottomRef.current = el.scrollHeight - el.scrollTop - el.clientHeight < 80; if (nearBottomRef.current) setHasNewMessages(false); };
  const showEarlierMessages = () => { const el = logRef.current; if (el) pendingPrependRef.current = { scrollHeight: el.scrollHeight, scrollTop: el.scrollTop }; setVisibleCount((count) => Math.min(messages.length, count + CHAT_LOG_PAGE)); };
  const jumpToLatest = () => { const el = logRef.current; if (el) el.scrollTop = el.scrollHeight; nearBottomRef.current = true; setHasNewMessages(false); };
  const action = async (name: string, task: () => Promise<void>) => { if (actionBusy || submitting) return; setActionBusy(name); setStatus(null); try { await task(); } catch (reason: any) { setStatus({ kind: 'error', text: reason?.message || String(reason) }); } finally { setActionBusy(''); } };
  const createThread = () => action('thread', async () => { const thread = await api.post<Thread>(`/api/v1/projects/${projectId}/chat/threads`, { title: 'New project thread' }); await refreshThreads(); setThreadId(thread.id); setRun(null); setStatus({ kind: 'success', text: 'New project thread created.' }); });
  const submit = async (event: FormEvent, newThread = false) => {
    event.preventDefault(); if (!prompt.trim() || submitting) return; const provider = providers.find((item) => item.id === providerId); if (!providerUsable(provider)) { setStatus({ kind: 'error', text: 'Select an enabled generation provider before running.' }); return; } setSubmitting(true); setStatus(null);
    try {
      const exactContext = prepareContext ? await prepareContext({ prompt, skillIds: selectedSkillIds, allowDescriptionActivation }) : contextSnapshot;
      if (!exactContext?.id) throw new Error('Freeze the selected operational context before running');
      const names = deliverables.split(',').map((name) => name.trim()).filter(Boolean); const body = { prompt, contextSnapshotId: exactContext.id, providerConfigId: providerId, ...(names.length ? { deliverables: names } : {}) };
      if (newThread || !threadId) { const value = await api.post<{ thread: Thread; run: Run }>(`/api/v1/projects/${projectId}/chat/runs`, body); setThreadId(value.thread.id); setRun(value.run); }
      else setRun(await api.post<Run>(`/api/v1/projects/${projectId}/chat/threads/${threadId}/runs`, body));
      setPrompt(''); setDeliverables(''); await refreshThreads(); setStatus({ kind: 'success', text: 'Run queued. Progress will update below.' });
    } catch (reason: any) { setStatus({ kind: 'error', text: reason.message }); } finally { setSubmitting(false); }
  };
  const retry = (jobId: string) => action(`retry:${jobId}`, async () => { setRun(await api.post<Run>(`/api/v1/jobs/${jobId}/retry`)); setStatus({ kind: 'success', text: 'Deliverable retry queued.' }); });
  const visibleMessages = messages.slice(Math.max(0, messages.length - visibleCount));
  return <section className="project-chat" aria-label="Project chat">
    <div className="project-chat-head"><strong>Project chat</strong><button className="ghost" disabled={Boolean(actionBusy) || submitting} onClick={createThread}>{actionBusy === 'thread' ? 'Creating…' : 'New thread'}</button></div>
    <div className="provider-row"><select aria-label="Generation provider" value={providerId} onChange={(event) => setProviderId(event.target.value)}><option value="" disabled>No enabled provider selected</option>{providers.map((provider) => <option disabled={!providerUsable(provider)} value={provider.id} key={provider.id}>{provider.label} · {provider.status}</option>)}</select><span className={`provider-status ${providers.find((item) => item.id === providerId)?.status || ''}`}>{providers.find((item) => item.id === providerId)?.kind || 'No enabled provider'}</span></div>
    <select aria-label="Project thread" value={threadId} onChange={(event) => { setThreadId(event.target.value); setRun(null); }}><option value="">New thread</option>{threads.map((thread) => <option key={thread.id} value={thread.id}>{thread.title}{thread.latestRun ? ` · ${thread.latestRun.status}` : ''}</option>)}</select>
    <div className="project-chat-log" ref={logRef} onScroll={onLogScroll}>
      {visibleMessages.length < messages.length && <button type="button" className="chat-log-more" onClick={showEarlierMessages}>Show earlier messages</button>}
      {visibleMessages.map((message) => <div className={`bubble ${message.role}`} key={message.id}>{message.content}{message.contextSnapshotId && <small className="meta" title={message.contextSnapshotId}>Context {message.contextSnapshotId.slice(4, 12)}</small>}</div>)}
      {!messages.length && <small>Runs in different threads are independent. Requests in this thread queue in order.</small>}
    </div>
    {hasNewMessages && <button type="button" className="ghost" onClick={jumpToLatest}>New messages ↓</button>}
    <div className="context-pills"><span className={contextSnapshot?.id ? 'context-pill frozen' : 'context-pill'}>{contextSnapshot?.id ? `Context frozen${contextSnapshot.canvas?.version != null ? ` · v${contextSnapshot.canvas.version}` : ''}` : 'Context is frozen when the run starts'}</span>{contextLabels.map((label) => <span className="context-pill" key={label}>{label}</span>)}{selectedSkillIds.map((skillId) => <button type="button" className="context-pill selected-skill" key={skillId} onClick={() => onSkillToggle?.(skillId)}>/ {skills.find((skill) => skill.id === skillId)?.name || skillId} ×</button>)}</div>
    {run && <div className="run-progress"><div className="run-summary"><strong>{run.deliverableCount > 0 ? `${run.completedCount}/${run.deliverableCount} deliverables` : run.jobs.length ? 'Deliverables in progress' : 'No deliverables yet'}</strong><span>{run.status}{run.predecessorRunId && run.status === 'queued' ? ' · waiting for thread' : ''}</span></div>{run.deliverableCount > 0 ? <progress max={run.deliverableCount} value={run.completedCount} aria-label={`${run.completedCount} of ${run.deliverableCount} deliverables complete`}/> : run.jobs.length > 0 ? <progress aria-label="Deliverables in progress, total unknown"/> : null}{run.jobs.map((job) => <div className="deliverable" key={job.id}><span><b>{job.name}</b><small>{job.status}{job.attempts.length ? ` · attempt ${job.attempts.at(-1)?.attemptNumber}` : ''}</small></span>{['failed', 'cancelled'].includes(job.status) && <button disabled={Boolean(actionBusy)} onClick={() => retry(job.id)}>{actionBusy === `retry:${job.id}` ? 'Retrying…' : 'Retry'}</button>}</div>)}{!terminal.has(run.status) && <button className="danger" disabled={Boolean(actionBusy)} onClick={() => action('cancel', async () => { setRun(await api.post<Run>(`/api/v1/thread-runs/${run.id}/cancel`)); setStatus({ kind: 'success', text: 'Run cancelled.' }); })}>{actionBusy === 'cancel' ? 'Cancelling…' : 'Cancel run'}</button>}</div>}
    {status && <p className={"status-message " + status.kind} role={status.kind === 'error' ? 'alert' : 'status'}>{status.text}</p>}
    <form className="project-composer" onSubmit={(event) => void submit(event)}>
      <textarea value={prompt} onChange={(event) => setPrompt(event.target.value)} placeholder="Describe screens… Type / to explicitly select a skill"/>
      {prompt.trimStart().startsWith('/') && <div className="slash-skill-menu" role="menu" aria-label="Skill menu">{skills.map((skill) => <button type="button" role="menuitemcheckbox" aria-checked={selectedSkillIds.includes(skill.id)} key={skill.id} onClick={() => { onSkillToggle?.(skill.id); setPrompt((value) => value.replace(/^\s*\/[^\s]*\s*/, '')); }}><b>/ {skill.name}</b><small>{skill.description}</small></button>)}</div>}
      <label className="safe-activation"><input type="checkbox" checked={allowDescriptionActivation} onChange={(event) => setAllowDescriptionActivation(event.target.checked)}/> Optionally suggest skills using descriptions only</label>
      <input value={deliverables} onChange={(event) => setDeliverables(event.target.value)} placeholder="Optional deliverables: Home, Search, Profile"/><div className="row"><button className="primary" disabled={submitting || Boolean(actionBusy) || !prompt.trim() || !providerUsable(providers.find((item) => item.id === providerId))} title={!prompt.trim() ? 'Enter a request first.' : !providerUsable(providers.find((item) => item.id === providerId)) ? 'Select an enabled generation provider.' : ''}>{submitting ? 'Queueing…' : 'Run in thread'}</button><button type="button" disabled={submitting || Boolean(actionBusy) || !prompt.trim() || !providerUsable(providers.find((item) => item.id === providerId))} onClick={(event) => void submit(event as any, true)}>Run in new thread</button></div></form>
  </section>;
}
