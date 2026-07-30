import assert from 'node:assert/strict';
import test from 'node:test';
import { SessionManager } from '../server/src/security/http-security.js';

function request(headers = {}, url = '/api/session') {
  return { headers: { host: '127.0.0.1:8787', ...headers }, url, socket: { localPort: 8787 } };
}

test('sessions expire and cannot be reused', async () => {
  const sessions = new SessionManager({ ttlMs: 50 });
  const session = sessions.bootstrap(request());
  sessions.authenticate(request({ 'x-mypath-session': session.token }));
  await new Promise((resolve) => setTimeout(resolve, 75));
  assert.throws(() => sessions.authenticate(request({ 'x-mypath-session': session.token })), { code: 'session_expired', status: 401 });
});

test('configured desktop instance nonce is required only at bootstrap', () => {
  const sessions = new SessionManager({ instanceNonce: 'secret-instance' });
  assert.throws(() => sessions.bootstrap(request()), { code: 'instance_nonce_rejected' });
  const session = sessions.bootstrap(request({ 'x-mypath-instance': 'secret-instance' }));
  assert.ok(session.token.length >= 40);
});
