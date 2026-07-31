import { useEffect, useRef, useState } from 'react';
import { api } from '../lib/api';

type Diagnostic = { severity?: string; stage?: string; code?: string; message?: string; path?: string; line?: number; column?: number };
type Selection = { sourceId: string; occurrenceId: string; tag: string };
type Status = { kind: 'error' | 'success' | 'info'; text: string } | null;
type Props = { componentId?: string; revisionId?: string; diagnostics?: Diagnostic[]; title?: string; selectableSourceIds?: string[]; onSelect?: (selection: Selection) => void };
const viewports = { mobile: [390, 700], tablet: [768, 700], desktop: [1200, 760] } as const;
const capitalize = (value: string) => value.charAt(0).toUpperCase() + value.slice(1);

export function PreviewFrame({ componentId, revisionId, diagnostics = [], title = 'Runnable preview', selectableSourceIds = [], onSelect }: Props) {
  const [viewport, setViewport] = useState<keyof typeof viewports>('desktop');
  const [html, setHtml] = useState('');
  const [error, setError] = useState('');
  const [ready, setReady] = useState(false);
  const [screenshotStatus, setScreenshotStatus] = useState<Status>(null);
  const [attempt, setAttempt] = useState(0);
  const frame = useRef<HTMLIFrameElement>(null);
  const captureId = useRef('');
  const [width, height] = viewports[viewport];
  const url = revisionId ? `/api/v1/revisions/${revisionId}/preview` : `/api/v1/components/${componentId}/preview`;

  useEffect(() => {
    let live = true; setReady(false); setError(''); setHtml('');
    api.text(url).then((source) => { if (live) setHtml(source); }).catch((reason) => {
      if (live) setError(String(reason?.message || reason));
    });
    return () => { live = false; };
  }, [url, attempt]);

  useEffect(() => { if (!screenshotStatus || screenshotStatus.kind === 'error') return; const t = setTimeout(() => setScreenshotStatus(null), 6000); return () => clearTimeout(t); }, [screenshotStatus]);

  useEffect(() => {
    const receive = (event: MessageEvent) => {
      if (event.source !== frame.current?.contentWindow) return;
      const data = event.data;
      if (!data || data.channel !== 'mypath-preview' || data.version !== 1 || typeof data.type !== 'string') return;
      if (data.type === 'ready') setReady(true);
      else if (data.type === 'select' && onSelect) {
        const sourceId = typeof data.sourceId === 'string' ? data.sourceId : '';
        const occurrenceId = typeof data.occurrenceId === 'string' ? data.occurrenceId : '';
        const tag = typeof data.tag === 'string' && /^[a-z][a-z0-9-]*$/.test(data.tag) ? data.tag : '';
        if (/^mp_[a-f0-9]{16,32}$/.test(sourceId) && new RegExp(`^${sourceId}:\\d+$`).test(occurrenceId) && tag && selectableSourceIds.includes(sourceId)) onSelect({ sourceId, occurrenceId, tag });
      } else if (data.type === 'screenshot' && data.id === captureId.current && revisionId && typeof data.dataUrl === 'string') {
        void api.post(`/api/v1/revisions/${revisionId}/screenshots`, { dataUrl: data.dataUrl, width: data.width, height: data.height }).then(() => setScreenshotStatus({ kind: 'success', text: 'Screenshot saved.' })).catch((reason) => setScreenshotStatus({ kind: 'error', text: `Screenshot failed: ${reason?.message || reason}` }));
      } else if (data.type === 'screenshot-error' && data.id === captureId.current) setScreenshotStatus({ kind: 'error', text: `Screenshot failed: ${String(data.message || 'capture error')}` });
    };
    window.addEventListener('message', receive);
    return () => window.removeEventListener('message', receive);
  }, [revisionId, onSelect, selectableSourceIds]);

  const saveScreenshot = () => {
    if (!revisionId || !frame.current?.contentWindow || !ready) return;
    captureId.current = crypto.randomUUID();
    setScreenshotStatus({ kind: 'info', text: 'Capturing…' });
    frame.current.contentWindow.postMessage({ channel: 'mypath-preview', type: 'capture', version: 1, id: captureId.current, width, height }, '*');
  };

  return <section className="preview-panel" aria-label={title}>
    <header className="preview-toolbar">
      <strong>{title}</strong>
      <span className={ready ? 'build-ok' : 'meta'}>{ready ? 'interactive' : html ? 'starting…' : 'loading…'}</span>
      <div className="viewport-controls" aria-label="Preview viewport">
        {(Object.keys(viewports) as Array<keyof typeof viewports>).map((name) =>
          <button type="button" className="viewport-button" aria-pressed={viewport === name} onClick={() => setViewport(name)} key={name} title={`${capitalize(name)} · ${viewports[name][0]}px`}>{capitalize(name)}<small>{viewports[name][0]}px</small></button>)}
        {revisionId && <button type="button" className="capture-button" disabled={!ready} onClick={saveScreenshot}>Capture screenshot</button>}
      </div>
    </header>
    <div className="preview-stage">
      {html && <iframe ref={frame} title={title} sandbox="allow-scripts" srcDoc={html} style={{ width, height, maxWidth: '100%' }} />}
      {error && <div className="diagnostics" role="alert"><strong>Preview unavailable</strong><p>{error}</p><button onClick={() => setAttempt((value) => value + 1)}>Retry preview</button></div>}
    </div>
    {screenshotStatus && <p className={'status-message ' + screenshotStatus.kind} role={screenshotStatus.kind === 'error' ? 'alert' : 'status'}>{screenshotStatus.text}</p>}
    {diagnostics.length > 0 && <div className="diagnostics" role="alert">
      <strong>Build diagnostics</strong>
      {diagnostics.map((item, index) => <div className="diagnostic" key={`${item.code}-${index}`}>
        <span>{item.stage || 'build'} · {item.code || item.severity || 'error'}</span>
        <p>{item.path ? `${item.path}${item.line ? `:${item.line}:${item.column || 1}` : ''} — ` : ''}{item.message}</p>
      </div>)}
    </div>}
  </section>;
}
