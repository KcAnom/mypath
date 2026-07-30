import crypto from 'node:crypto';
import { FixtureProvider, LocalTemplateProvider, OllamaProvider, OpenAICompatibleProvider } from './providers.js';

const now = () => new Date().toISOString();
const decode = (value) => { try { return JSON.parse(value || '{}'); } catch { return {}; } };
const encode = (value) => JSON.stringify(value || {});
const SECRET_FIELD = /(?:api.?key|secret|token|password|authorization)/i;
const providers = new Map([
  ['fixture', new FixtureProvider()], ['local-template', new LocalTemplateProvider()],
  ['ollama', new OllamaProvider()], ['openai-compatible', new OpenAICompatibleProvider()],
]);

function assertNoSecrets(input) {
  for (const [key, value] of Object.entries(input || {})) {
    if (SECRET_FIELD.test(key) && key !== 'apiKeyEnv') throw Object.assign(new Error(`Provider secrets may not be stored (${key}); configure an environment variable name instead`), { status: 422, code: 'provider_secret_rejected' });
    if (value && typeof value === 'object') assertNoSecrets(value);
  }
}
function safeConfig(row) {
  const extra = decode(row.config_json);
  return { id: row.id, kind: row.kind, label: row.label, baseUrl: row.base_url || null, model: row.model || null, apiKeyEnv: row.api_key_env || null, enabled: Boolean(row.enabled), ...extra, createdAt: row.created_at, updatedAt: row.updated_at };
}

export class ProviderRegistry {
  constructor(database) { this.db = database.db; }
  list() {
    return this.db.prepare('SELECT * FROM provider_configs ORDER BY CASE kind WHEN \'fixture\' THEN 0 WHEN \'local-template\' THEN 1 WHEN \'ollama\' THEN 2 ELSE 3 END,label').all().map((row) => {
      const config = safeConfig(row); const credentialReady = !config.apiKeyEnv || Boolean(process.env[config.apiKeyEnv]);
      return { ...config, status: !config.enabled ? 'disabled' : credentialReady ? (['fixture', 'local-template'].includes(config.kind) ? 'ready' : 'configured') : 'missing-credential' };
    });
  }
  get(id) { const row = this.db.prepare('SELECT * FROM provider_configs WHERE id=?').get(id); return row ? safeConfig(row) : null; }
  resolve(id) {
    const config = this.get(id || process.env.MYPATH_PROVIDER || 'fixture');
    return this.resolveSnapshot(config);
  }
  resolveSnapshot(config) {
    if (!config || !config.enabled) throw Object.assign(new Error('Provider is unavailable'), { status: 422, code: 'provider_unavailable' });
    const provider = providers.get(config.kind); if (!provider) throw Object.assign(new Error(`Unsupported provider kind ${config.kind}`), { status: 422, code: 'provider_unavailable' });
    return { provider, config: { ...config } };
  }
  save(input, id = null) {
    assertNoSecrets(input);
    const kind = String(input?.kind || 'openai-compatible');
    if (!providers.has(kind)) throw Object.assign(new Error('Unknown provider kind'), { status: 422, code: 'provider_config_invalid' });
    const configId = id || `provider:${crypto.randomBytes(8).toString('hex')}`;
    const existing = this.get(configId); const stamp = now();
    const apiKeyEnv = input?.apiKeyEnv == null ? existing?.apiKeyEnv || null : String(input.apiKeyEnv || '') || null;
    if (apiKeyEnv && !/^[A-Z_][A-Z0-9_]{0,127}$/i.test(apiKeyEnv)) throw Object.assign(new Error('apiKeyEnv must be an environment-variable name'), { status: 422, code: 'provider_config_invalid' });
    const known = new Set(['kind', 'label', 'baseUrl', 'model', 'apiKeyEnv', 'enabled']);
    const extra = Object.fromEntries(Object.entries(input || {}).filter(([key]) => !known.has(key)));
    const created = existing?.createdAt || stamp;
    this.db.prepare(`INSERT INTO provider_configs(id,kind,label,base_url,model,api_key_env,enabled,config_json,created_at,updated_at)
      VALUES(?,?,?,?,?,?,?,?,?,?) ON CONFLICT(id) DO UPDATE SET kind=excluded.kind,label=excluded.label,base_url=excluded.base_url,model=excluded.model,api_key_env=excluded.api_key_env,enabled=excluded.enabled,config_json=excluded.config_json,updated_at=excluded.updated_at`)
      .run(configId, kind, String(input?.label || existing?.label || kind), input?.baseUrl ?? existing?.baseUrl ?? null, input?.model ?? existing?.model ?? null, apiKeyEnv, input?.enabled === false ? 0 : 1, encode(extra), created, stamp);
    return this.list().find((item) => item.id === configId);
  }
}
