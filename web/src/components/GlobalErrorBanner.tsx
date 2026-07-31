import { Component, ErrorInfo, ReactNode, useEffect, useState } from 'react';

const message = (reason: unknown) => reason instanceof Error ? reason.message : String(reason || 'Unexpected application error');

export function GlobalErrorBanner() {
  const [error, setError] = useState('');
  useEffect(() => {
    const rejection = (event: PromiseRejectionEvent) => { event.preventDefault(); setError(`An action failed unexpectedly: ${message(event.reason)}`); };
    const runtime = (event: ErrorEvent) => {
      const detail = event.message || message(event.error);
      // Chromium reports this benign observer scheduling warning while tldraw settles.
      // It is not an application failure and must not cover the canvas with a red banner.
      if (/ResizeObserver loop (?:limit exceeded|completed with undelivered notifications)/i.test(detail)) return;
      setError(`The page encountered an error: ${detail}`);
    };
    window.addEventListener('unhandledrejection', rejection);
    window.addEventListener('error', runtime);
    return () => { window.removeEventListener('unhandledrejection', rejection); window.removeEventListener('error', runtime); };
  }, []);
  return error ? <div className="status-message error global-error-banner" role="alert"><span>{error}</span><button onClick={() => setError('')} aria-label="Dismiss unexpected error">Dismiss</button></div> : null;
}

type State = { error: string };
export class AppErrorBoundary extends Component<{ children: ReactNode }, State> {
  state: State = { error: '' };
  static getDerivedStateFromError(error: unknown): State { return { error: message(error) }; }
  componentDidCatch(error: Error, info: ErrorInfo) { console.error('MyPath render failure', error, info); }
  render() {
    if (this.state.error) return <main className="fatal-error" role="alert"><h1>MyPath could not render this page</h1><p>{this.state.error}</p><button onClick={() => location.reload()}>Reload MyPath</button></main>;
    return this.props.children;
  }
}
