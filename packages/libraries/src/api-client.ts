/**
 * Minimal local API client.
 * Base URL defaults to local loopback. No SaaS auth cookies.
 */
import { API_ORIGIN, fillRoute, Routes, type RouteName } from '../../shared/src/routes';

export type Channel = keyof typeof API_ORIGIN;

export interface ApiClientOptions {
  channel?: Channel;
  baseUrl?: string;
  fetchImpl?: typeof fetch;
}

export class MyPathApi {
  readonly baseUrl: string;
  private fetchImpl: typeof fetch;

  constructor(opts: ApiClientOptions = {}) {
    this.baseUrl = opts.baseUrl ?? API_ORIGIN[opts.channel ?? 'local'];
    this.fetchImpl = opts.fetchImpl ?? fetch.bind(globalThis);
  }

  route(name: RouteName, params: Record<string, string | number> = {}): string {
    return fillRoute(Routes[name], params);
  }

  async request<T = unknown>(
    method: string,
    path: string,
    body?: unknown,
    init: RequestInit = {},
  ): Promise<T> {
    const headers: Record<string, string> = {
      Accept: 'application/json',
      ...(init.headers as Record<string, string> | undefined),
    };
    if (body !== undefined) headers['Content-Type'] = 'application/json';

    const res = await this.fetchImpl(`${this.baseUrl}${path}`, {
      ...init,
      method,
      headers,
      body: body === undefined ? undefined : JSON.stringify(body),
    });
    if (!res.ok) {
      const text = await res.text().catch(() => '');
      throw new Error(`MyPath API ${method} ${path} → ${res.status}: ${text.slice(0, 200)}`);
    }
    if (res.status === 204) return undefined as T;
    const ct = res.headers.get('content-type') || '';
    if (ct.includes('application/json')) return (await res.json()) as T;
    return (await res.text()) as T;
  }

  get<T = unknown>(path: string, init?: RequestInit) {
    return this.request<T>('GET', path, undefined, init);
  }
  post<T = unknown>(path: string, body?: unknown, init?: RequestInit) {
    return this.request<T>('POST', path, body, init);
  }
  put<T = unknown>(path: string, body?: unknown, init?: RequestInit) {
    return this.request<T>('PUT', path, body, init);
  }
  patch<T = unknown>(path: string, body?: unknown, init?: RequestInit) {
    return this.request<T>('PATCH', path, body, init);
  }
  delete<T = unknown>(path: string, init?: RequestInit) {
    return this.request<T>('DELETE', path, undefined, init);
  }
}

export { Routes, fillRoute };
