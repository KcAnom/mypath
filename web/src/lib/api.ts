type ApiErrorBody = { error?: { code?: string; message?: string; details?: unknown } | string };

// WKWebView supplies this only on the first desktop URL. Keep it for every later
// session renewal even after history navigation removes it from location.search.
export const desktopInstanceNonce = new URLSearchParams(globalThis.location?.search || '').get('instanceNonce') || '';

class ApiClient {
  private token = '';
  private bootstrapPromise: Promise<void> | null = null;

  async bootstrap() {
    if (this.bootstrapPromise) return this.bootstrapPromise;
    this.bootstrapPromise = (async () => {
      const headers: Record<string, string> = { Accept: 'application/json' };
      if (desktopInstanceNonce) headers['X-MyPath-Instance'] = desktopInstanceNonce;
      const response = await fetch('/api/v1/session', { headers, cache: 'no-store' });
      const body = await response.json() as { token?: string } & ApiErrorBody;
      if (!response.ok || !body.token) throw new Error(typeof body.error === 'object' ? body.error?.message : 'Unable to start local session');
      this.token = body.token;
    })().finally(() => { this.bootstrapPromise = null; });
    return this.bootstrapPromise;
  }

  private async response(method: string, path: string, body?: unknown, retry = true): Promise<Response> {
    if (!this.token) await this.bootstrap();
    const headers: Record<string, string> = { Accept: 'application/json', 'X-MyPath-Session': this.token };
    if (body !== undefined) headers['Content-Type'] = 'application/json';
    const response = await fetch(path, { method, headers, cache: 'no-store', body: body === undefined ? undefined : JSON.stringify(body) });
    if (response.status === 401 && retry) { this.token = ''; await this.bootstrap(); return this.response(method, path, body, false); }
    return response;
  }

  async request<T = unknown>(method: string, path: string, body?: unknown): Promise<T> {
    const response = await this.response(method, path, body);
    if (response.status === 204) return null as T;
    const data = await response.json() as T & ApiErrorBody;
    if (!response.ok) {
      const error = typeof data.error === 'object' ? data.error : { message: String(data.error || response.statusText) };
      throw Object.assign(new Error(error?.message || response.statusText), { status: response.status, code: error?.code, details: error?.details });
    }
    return data;
  }

  async download(path: string, fallbackName = 'mypath-export.zip') {
    const response = await this.response('GET', path);
    if (!response.ok) {
      const data = await response.json().catch(() => ({})) as ApiErrorBody;
      throw Object.assign(new Error(typeof data.error === 'object' ? data.error?.message : response.statusText), { status: response.status, details: typeof data.error === 'object' ? data.error?.details : undefined });
    }
    const disposition = response.headers.get('content-disposition') || '';
    const filename = disposition.match(/filename="([^"\\]+)"/)?.[1] || fallbackName;
    const url = URL.createObjectURL(await response.blob());
    try { const anchor = document.createElement('a'); anchor.href = url; anchor.download = filename; anchor.rel = 'noopener'; document.body.append(anchor); anchor.click(); anchor.remove(); }
    finally { setTimeout(() => URL.revokeObjectURL(url), 1_000); }
  }

  async text(path: string) {
    const response = await this.response('GET', path);
    if (!response.ok) {
      const data = await response.json().catch(() => ({})) as ApiErrorBody;
      throw Object.assign(new Error(typeof data.error === 'object' ? data.error?.message : response.statusText), { status: response.status, details: typeof data.error === 'object' ? data.error?.details : undefined });
    }
    return response.text();
  }

  get = <T = unknown>(path: string) => this.request<T>('GET', path);
  post = <T = unknown>(path: string, body?: unknown) => this.request<T>('POST', path, body);
  patch = <T = unknown>(path: string, body?: unknown) => this.request<T>('PATCH', path, body);
  put = <T = unknown>(path: string, body?: unknown) => this.request<T>('PUT', path, body);
  del = (path: string) => this.request('DELETE', path);

  async upload<T = unknown>(path: string, file: File, kind: 'image' | 'document' | 'font', retry = true): Promise<T> {
    if (!this.token) await this.bootstrap();
    const data = new FormData(); data.append('kind', kind); data.append('file', file, file.name);
    const response = await fetch(path, { method: 'POST', headers: { Accept: 'application/json', 'X-MyPath-Session': this.token }, body: data, cache: 'no-store' });
    if (response.status === 401 && retry) { this.token = ''; await this.bootstrap(); return this.upload<T>(path, file, kind, false); }
    const value = await response.json() as T & ApiErrorBody;
    if (!response.ok) { const error = typeof value.error === 'object' ? value.error : { message: String(value.error || response.statusText) }; throw Object.assign(new Error(error.message), { status: response.status, code: error.code, details: error.details }); }
    return value;
  }

  downloadJson(value: unknown, filename: string) {
    const url = URL.createObjectURL(new Blob([`${JSON.stringify(value, null, 2)}\n`], { type: 'application/json' }));
    try { const anchor = document.createElement('a'); anchor.href = url; anchor.download = filename; anchor.rel = 'noopener'; document.body.append(anchor); anchor.click(); anchor.remove(); }
    finally { setTimeout(() => URL.revokeObjectURL(url), 1_000); }
  }

  /** Authenticated fetch-based SSE with durable Last-Event-ID and duplicate suppression. */
  async stream(path: string, onEvent: (event: { id: number; type: string; data: unknown }) => void | Promise<void>, signal?: AbortSignal, lastId = 0) {
    let cursor = lastId;
    while (!signal?.aborted) {
      if (!this.token) await this.bootstrap();
      const response = await fetch(path, { headers: { Accept: 'text/event-stream', 'X-MyPath-Session': this.token, 'Last-Event-ID': String(cursor) }, cache: 'no-store', signal });
      if (response.status === 401) { this.token = ''; await this.bootstrap(); continue; }
      if (!response.ok) throw new Error(`Event stream failed (${response.status})`);
      if (!response.body) throw new Error('Event stream has no response body');
      const reader = response.body.getReader();
      const decoder = new TextDecoder();
      let buffer = ''; let terminal = false;
      while (!signal?.aborted) {
        const chunk = await reader.read();
        buffer += decoder.decode(chunk.value || new Uint8Array(), { stream: !chunk.done });
        let boundary;
        while ((boundary = buffer.indexOf('\n\n')) >= 0) {
          const record = buffer.slice(0, boundary); buffer = buffer.slice(boundary + 2);
          const id = Number(record.match(/^id:\s*(\d+)/m)?.[1] || 0);
          if (!id || id <= cursor) continue;
          const type = record.match(/^event:\s*(.+)$/m)?.[1] || 'message';
          const raw = record.match(/^data:\s*(.+)$/m)?.[1] || '{}';
          cursor = id; terminal ||= ['failed', 'succeeded', 'run_finished', 'run_cancelled'].includes(type);
          await onEvent({ id, type, data: JSON.parse(raw) });
        }
        if (chunk.done) break;
      }
      if (terminal || signal?.aborted) break;
      await new Promise((resolve) => setTimeout(resolve, 250));
    }
    return cursor;
  }
}

export const api = new ApiClient();
