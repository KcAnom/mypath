import { generateComponent } from '../../generate.js';

const sleep = (ms, signal) => new Promise((resolve, reject) => {
  const timer = setTimeout(resolve, ms);
  const abort = () => { clearTimeout(timer); reject(Object.assign(new Error('Provider request cancelled'), { code: 'provider_cancelled' })); };
  if (signal?.aborted) abort(); else signal?.addEventListener('abort', abort, { once: true });
});

function endpoint(base, pathname) {
  const value = new URL(pathname, String(base || ''));
  if (!['http:', 'https:'].includes(value.protocol) || value.username || value.password) throw Object.assign(new Error('Provider URL must be HTTP(S) and contain no credentials'), { code: 'provider_config_invalid' });
  return value;
}
function extractJson(value) {
  const source = String(value || '').trim().replace(/^```(?:json)?\s*/i, '').replace(/\s*```$/, '');
  let parsed;
  try { parsed = JSON.parse(source); } catch { throw Object.assign(new Error('Provider did not return the required JSON source bundle'), { code: 'provider_response_invalid' }); }
  const files = parsed?.files;
  if (!files || typeof files !== 'object' || Array.isArray(files) || !Object.keys(files).length) throw Object.assign(new Error('Provider response has no files object'), { code: 'provider_response_invalid' });
  return { name: String(parsed.name || 'Generated design'), files: Object.fromEntries(Object.entries(files).map(([name, content]) => [String(name), String(content)])), note: String(parsed.note || 'model provider') };
}
function modelPrompt(request) {
  return `Create one runnable React/TypeScript screen named ${JSON.stringify(request.deliverable.name)} for this request:\n${request.prompt}\n\nReturn only JSON in this exact shape: {"name":"ScreenName","files":{"src/App.tsx":"...","src/index.css":"..."},"note":"..."}. Use only React, relative imports, and local CSS. Do not use remote URLs or packages. Immutable context follows:\n${JSON.stringify(request.context?.envelope || {})}`;
}
async function jsonResponse(response) {
  const body = await response.json().catch(() => null);
  if (!response.ok) throw Object.assign(new Error(String(body?.error?.message || body?.error || `Provider HTTP ${response.status}`)), { code: 'provider_http_error', status: response.status });
  return body;
}

export class FixtureProvider {
  kind = 'fixture';
  async generate(request) {
    request.onEvent?.('provider_progress', { message: `Planning ${request.deliverable.name}` });
    const delay = Math.max(0, Math.min(10_000, Number(request.config?.fixtureDelayMs ?? process.env.MYPATH_FIXTURE_DELAY_MS ?? 15)));
    if (delay) await sleep(delay, request.signal);
    if (String(request.prompt).includes('[fixture-fail]') || (String(request.prompt).includes('[fixture-fail-once]') && Number(request.attemptNumber) === 1)) throw Object.assign(new Error('Requested deterministic fixture failure'), { code: 'fixture_failure' });
    const generated = generateComponent({ prompt: `${request.deliverable.name}\n\n${request.deliverable.prompt}`, nameHint: request.deliverable.name });
    request.onEvent?.('provider_complete', { fileCount: Object.keys(generated.files).length });
    return { ...generated, note: 'deterministic fixture provider' };
  }
}

export class LocalTemplateProvider extends FixtureProvider {
  kind = 'local-template';
  async generate(request) { const result = await super.generate({ ...request, config: { ...request.config, fixtureDelayMs: 0 } }); return { ...result, note: 'local template provider' }; }
}

export class OllamaProvider {
  kind = 'ollama';
  async generate(request) {
    const url = endpoint(request.config.baseUrl || 'http://127.0.0.1:11434', '/api/generate');
    // Ollama is intentionally local-only; compatible remote services use the explicit adapter.
    if (!['127.0.0.1', 'localhost', '[::1]'].includes(url.hostname)) throw Object.assign(new Error('Ollama must use a loopback URL'), { code: 'provider_config_invalid' });
    request.onEvent?.('provider_connected', { provider: 'ollama', model: request.config.model });
    const response = await fetch(url, { method: 'POST', signal: request.signal, headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ model: request.config.model || 'llama3.2', prompt: modelPrompt(request), stream: false, format: 'json' }) });
    const body = await jsonResponse(response);
    return extractJson(body?.response);
  }
}

export class OpenAICompatibleProvider {
  kind = 'openai-compatible';
  async generate(request) {
    const url = endpoint(request.config.baseUrl, '/v1/chat/completions');
    const key = request.config.apiKeyEnv ? process.env[request.config.apiKeyEnv] : '';
    if (request.config.apiKeyEnv && !key) throw Object.assign(new Error(`Provider credential environment variable ${request.config.apiKeyEnv} is not set`), { code: 'provider_secret_unavailable' });
    const headers = { 'Content-Type': 'application/json', ...(key ? { Authorization: `Bearer ${key}` } : {}) };
    request.onEvent?.('provider_connected', { provider: 'openai-compatible', model: request.config.model, authenticated: Boolean(key) });
    const response = await fetch(url, { method: 'POST', signal: request.signal, headers, body: JSON.stringify({ model: request.config.model, temperature: 0, messages: [{ role: 'user', content: modelPrompt(request) }] }) });
    const body = await jsonResponse(response);
    return extractJson(body?.choices?.[0]?.message?.content);
  }
}
