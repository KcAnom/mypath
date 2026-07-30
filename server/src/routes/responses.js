const object = (value) => Boolean(value) && typeof value === 'object' && !Array.isArray(value);
const text = (value) => typeof value === 'string' && value.length > 0;
const integer = (value) => Number.isInteger(value) && value >= 0;

const canvas = (value) => object(value) && text(value.id) && integer(value.version) && object(value.snapshot) && object(value.camera);
const project = (value) => object(value) && text(value.id) && typeof value.name === 'string';

// These are the high-value browser/desktop bootstrap contracts. Keeping them at
// the serialization boundary detects handler drift before a malformed success
// response can be consumed or persisted by the client.
export const keyResponseContracts = [
  { method: 'GET', pattern: '/health', description: 'health descriptor', validate: (value) => object(value) && value.ok === true && value.product === 'mypath' && typeof value.instanceAuthenticated === 'boolean' && Array.isArray(value.features) },
  { method: 'GET', pattern: '/api/session', description: 'session bootstrap', validate: (value) => object(value) && text(value.token) && text(value.expiresAt) },
  { method: 'GET', pattern: '/projects', description: 'project list', validate: (value) => Array.isArray(value) && value.every(project) },
  { method: 'POST', pattern: '/projects', description: 'created project', validate: project },
  { method: 'GET', pattern: '/projects/:id/canvas', description: 'canvas snapshot', validate: canvas },
  { method: 'PUT', pattern: '/projects/:id/canvas', description: 'saved canvas snapshot', validate: canvas },
  { method: 'PATCH', pattern: '/projects/:id/canvas', description: 'saved canvas snapshot', validate: canvas },
];

function normalized(pathname) {
  if (pathname === '/api/v1/session') return '/api/session';
  return pathname.startsWith('/api/v1/') ? pathname.slice('/api/v1'.length) : pathname;
}
function matches(pathname, pattern) {
  const actual = normalized(pathname).split('/').filter(Boolean); const expected = pattern.split('/').filter(Boolean);
  return actual.length === expected.length && expected.every((part, index) => part.startsWith(':') || part === actual[index]);
}

export function validateKeyResponse(method, pathname, status, value) {
  if (status < 200 || status >= 300) return value;
  const contract = keyResponseContracts.find((item) => item.method === method && matches(pathname, item.pattern));
  if (contract && !contract.validate(value)) throw new Error(`Response contract failed for ${method} ${pathname}: ${contract.description}`);
  return value;
}
