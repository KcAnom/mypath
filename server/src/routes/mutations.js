import { HttpError } from '../security/http-security.js';

const text = (maximum = 1_000_000) => ({ type: 'string', maximum });
const array = (maximum = 10_000) => ({ type: 'array', maximum });
const object = { type: 'object' };
const boolean = { type: 'boolean' };
const number = (minimum = -Number.MAX_SAFE_INTEGER, maximum = Number.MAX_SAFE_INTEGER, integer = false) => ({ type: 'number', minimum, maximum, integer });

// Every accepted field has a concrete JSON shape. Service-level validation remains
// responsible for domain rules (for example, whether a referenced revision exists),
// while this boundary rejects coercion-prone values before they reach a handler.
const FIELD_RULES = {
  accepted: boolean, active: boolean, allowDescriptionActivation: boolean, approved: boolean, defer: boolean, enabled: boolean, generate: boolean, ingestAssets: boolean, optIn: boolean, optionalActivation: boolean,
  version: number(0, Number.MAX_SAFE_INTEGER, true), schemaVersion: number(1, Number.MAX_SAFE_INTEGER, true), retentionMs: number(0), ttlSeconds: number(1, 86_400, true), width: number(1, 32_768, true), height: number(1, 32_768, true), weight: number(100, 900, true), x: number(-10_000_000, 10_000_000), y: number(-10_000_000, 10_000_000),
  assets: array(), assetIds: array(10_000), components: array(), componentIds: array(), deliverables: array(100), designSystems: array(), directions: array(100), fonts: array(), frames: array(), libraries: array(), projectIds: array(1_000), selectedSkillIds: array(1_000), shapeIds: array(100_000), shapes: array(100_000), sketches: array(), skills: array(),
  camera: object, computedStyles: object, context: object, dark: object, document: object, exchange: object, files: object, frame: object, light: object, metadata: object, operation: object, proposal: object, snapshot: object, styles: object, tokens: object,
  bytes: { type: 'binary' }, value: { type: 'json-scalar-or-object' },
};

const STRING_FIELDS = [
  'apiKey', 'apiKeyEnv', 'assetId', 'authorization', 'backupPath', 'base64', 'baseRevisionId', 'baseUrl', 'buildId', 'canonicalPath', 'className', 'code', 'componentId', 'content', 'contextSnapshotId', 'css', 'dataUrl', 'defaultTheme', 'description', 'designMd', 'designSystemId', 'destinationGrantId', 'elementId', 'endpointUrl', 'expectedBaseRevisionId', 'family', 'html', 'kind', 'label', 'libraryId', 'logicalJobId', 'markdown', 'model', 'name', 'note', 'op', 'origin', 'outerHtml', 'pageUrl', 'password', 'projectId', 'prompt', 'property', 'providerConfigId', 'providerId', 'query', 'revisionId', 'schema', 'screenshot', 'screenshotDataUrl', 'secret', 'selector', 'sourceId', 'style', 'targetOrigin', 'targetProjectId', 'text', 'title', 'token', 'type', 'url', 'versionId',
];
for (const field of STRING_FIELDS) FIELD_RULES[field] = text(['name', 'title', 'label', 'family'].includes(field) ? 500 : 10_000_000);

const route = (path, methods, fields, required = []) => {
  const rules = Object.fromEntries(fields.map((field) => {
    if (!FIELD_RULES[field]) throw new Error(`Mutation field ${field} has no type contract`);
    return [field, FIELD_RULES[field]];
  }));
  return { path, methods, fields, required, rules, auth: 'session' };
};

// This registry is consumed by request dispatch and conformance verification. Keeping
// mutation contracts here prevents handlers from accidentally accepting persistence
// fields via object spreading (id, timestamps, tombstones, selected revisions, etc.).
export const mutationRoutes = [
  route('/projects', ['POST'], ['name', 'description']),
  route('/projects/:id', ['PUT', 'PATCH'], ['name', 'description']),
  route('/projects/:id/canvas', ['PUT', 'PATCH'], ['version', 'snapshot', 'camera'], ['version', 'snapshot']),
  route('/projects/:id/canvas/publications', ['POST'], ['logicalJobId', 'frame'], ['logicalJobId', 'frame']),
  route('/projects/:id/assets', ['POST'], ['name', 'kind', 'bytes']),
  route('/assets/gc', ['POST'], ['retentionMs', 'backupPath']),
  route('/projects/:id/context-snapshots', ['POST'], ['shapeIds', 'shapes', 'components', 'assets', 'designSystems', 'libraries', 'skills', 'sketches', 'active', 'prompt', 'allowDescriptionActivation']),
  route('/projects/:id/components', ['POST'], ['prompt', 'name', 'context', 'generate']),
  route('/generate', ['POST'], ['projectId', 'prompt', 'name', 'context'], ['projectId']),
  route('/components/:id', ['PUT', 'PATCH'], ['name', 'description', 'code', 'files', 'note']),
  route('/components/:id/candidates', ['POST'], ['files', 'code', 'expectedBaseRevisionId', 'note', 'defer']),
  route('/components/:id/edit-sessions', ['POST'], ['baseRevisionId']),
  route('/edit-sessions/:id/operations', ['POST'], ['type', 'op', 'sourceId', 'elementId', 'property', 'value', 'className', 'text', 'operation']),
  route('/edit-sessions/:id/done', ['POST'], []),
  route('/components/:id/checkout', ['POST'], ['revisionId'], ['revisionId']),
  route('/revisions/:id/restore', ['POST'], ['note']),
  route('/components/:id/variants', ['POST'], ['directions']),
  route('/builds/:id/run', ['POST'], []),
  route('/revisions/:id/retry-build', ['POST'], []),
  route('/revisions/:id/screenshots', ['POST'], ['dataUrl', 'buildId', 'width', 'height'], ['dataUrl', 'width', 'height']),
  route('/revisions/:id/export-directory', ['POST'], ['destinationGrantId'], ['destinationGrantId']),
  route('/native/export-destination-grants', ['POST'], ['canonicalPath'], ['canonicalPath']),
  route('/design-systems', ['POST'], ['name', 'prompt', 'defaultTheme', 'light', 'dark', 'tokens', 'fonts', 'markdown', 'designMd']),
  route('/design-systems/:id', ['PUT', 'PATCH'], ['name', 'prompt', 'defaultTheme', 'light', 'dark', 'tokens', 'fonts', 'markdown', 'designMd']),
  route('/design-systems/:id/versions', ['POST'], ['name', 'prompt', 'defaultTheme', 'light', 'dark', 'tokens', 'fonts', 'markdown', 'designMd']),
  // versionId is required by the service when activating; { active:false }
  // intentionally clears the current selection and restores system defaults.
  route('/projects/:id/design-system', ['PUT', 'PATCH'], ['versionId', 'active']),
  route('/theme-extractions', ['POST'], ['url', 'css']),
  route('/design-systems/extract-from-url', ['POST'], ['url', 'css']),
  route('/theme-extractions/:id/review', ['POST'], ['approved', 'proposal', 'accepted', 'name', 'prompt', 'defaultTheme', 'light', 'dark', 'fonts', 'markdown', 'designSystemId']),
  route('/fonts', ['POST'], ['assetId', 'family', 'weight', 'style']),
  route('/projects/:id/fonts/:fontId', ['PUT', 'PATCH'], ['active']),
  route('/users/me/skills', ['POST'], ['name', 'description', 'content', 'files', 'optionalActivation']),
  route('/skills', ['POST'], ['name', 'description', 'content', 'files', 'optionalActivation']),
  route('/skills/import', ['POST'], ['base64', 'name'], ['base64']),
  route('/users/me/skills/import', ['POST'], ['base64', 'name'], ['base64']),
  route('/skills/:id', ['PUT', 'PATCH'], ['name', 'description', 'content', 'files', 'optionalActivation']),
  route('/projects/:id/skills/:skillId', ['PUT', 'PATCH'], ['active']),
  route('/projects/:id/skills/suggest', ['POST'], ['selectedSkillIds', 'prompt', 'allowDescriptionActivation']),
  route('/libraries', ['POST'], ['name', 'description', 'componentIds']),
  route('/libraries/:id/components', ['POST'], ['componentId', 'revisionId'], ['componentId', 'revisionId']),
  route('/libraries/:id/copy', ['POST'], ['componentId', 'revisionId', 'targetProjectId', 'name'], ['componentId', 'revisionId', 'targetProjectId']),
  route('/libraries/:id/components/:componentId/copy-to-project', ['POST'], ['revisionId', 'targetProjectId', 'projectId', 'name']),
  route('/libraries/:id/active', ['POST', 'PUT', 'PATCH'], ['projectId', 'active'], ['projectId']),
  route('/projects/:id/libraries/:libraryId', ['PUT', 'PATCH'], ['active']),
  route('/projects/:id/canvas/library-items', ['POST'], ['libraryId', 'componentId', 'revisionId', 'x', 'y'], ['libraryId', 'componentId', 'revisionId']),
  route('/provider-configs', ['POST'], ['kind', 'label', 'baseUrl', 'model', 'apiKeyEnv', 'enabled', 'apiKey', 'token', 'password', 'secret', 'authorization']),
  route('/provider-configs/:id', ['PUT', 'PATCH'], ['kind', 'label', 'baseUrl', 'model', 'apiKeyEnv', 'enabled', 'apiKey', 'token', 'password', 'secret', 'authorization']),
  route('/projects/:id/chat/threads', ['POST'], ['title']),
  route('/projects/:id/chat/threads/:threadId/runs', ['POST'], ['prompt', 'contextSnapshotId', 'providerConfigId', 'deliverables'], ['prompt', 'contextSnapshotId']),
  route('/projects/:id/chat/runs', ['POST'], ['title', 'prompt', 'contextSnapshotId', 'providerConfigId', 'deliverables'], ['prompt', 'contextSnapshotId']),
  route('/thread-runs/:id/cancel', ['POST'], []),
  route('/jobs/:id/retry', ['POST'], []),
  route('/users/me/chat-threads', ['POST'], ['title']),
  route('/users/me/chat-threads/:threadId/messages', ['POST'], ['content']),
  route('/projects/:id/imports/web', ['POST'], ['url', 'ingestAssets'], ['url']),
  route('/imports/:id/convert', ['POST'], ['name']),
  route('/projects/:id/capture-tickets', ['POST'], ['targetOrigin', 'origin', 'ttlSeconds', 'assetIds']),
  route('/capture-tickets/:id/submission', ['POST'], ['html', 'outerHtml', 'computedStyles', 'styles', 'screenshotDataUrl', 'screenshot', 'assetIds', 'pageUrl', 'selector']),
  route('/search/providers', ['POST'], ['kind', 'label', 'endpointUrl', 'enabled']),
  route('/search/providers/:id', ['PUT', 'PATCH'], ['label', 'endpointUrl', 'enabled']),
  route('/projects/:id/search', ['POST'], ['query', 'providerId', 'optIn'], ['query', 'providerId', 'optIn']),
  route('/search/queries/:id/results/:index/fetch', ['POST'], ['optIn'], ['optIn']),
  route('/projects/:id/imports/figma', ['POST'], ['exchange', 'schema', 'schemaVersion', 'version', 'document', 'components', 'frames', 'assets', 'metadata']),
  route('/external-agent/projects/:id/edit-sessions', ['POST'], ['componentId', 'baseRevisionId'], ['componentId']),
  route('/external-agent/edit-sessions/:id/submissions', ['POST'], ['files', 'note'], ['files']),
  route('/external-agent/submissions/:id/accept', ['POST'], []),
  route('/external-agent/submissions/:id/reject', ['POST'], []),
  route('/external-agent-grants', ['POST'], ['label', 'projectIds', 'ttlSeconds'], ['projectIds']),
];

function matches(pathname, pattern) {
  const actual = pathname.split('/').filter(Boolean); const expected = pattern.split('/').filter(Boolean);
  return actual.length === expected.length && expected.every((part, index) => part.startsWith(':') || part === actual[index]);
}
function assertSafeObject(value, location = 'body') {
  if (!value || typeof value !== 'object' || ArrayBuffer.isView(value)) return;
  for (const [key, nested] of Object.entries(value)) {
    if (['__proto__', 'prototype', 'constructor'].includes(key)) throw new HttpError(400, 'field_forbidden', `${location}.${key} is forbidden`);
    if (nested && typeof nested === 'object') assertSafeObject(nested, `${location}.${key}`);
  }
}

export function validateMutation(method, pathname, body) {
  if (!['POST', 'PUT', 'PATCH'].includes(method)) return body;
  const schema = mutationRoutes.find((item) => item.methods.includes(method) && matches(pathname, item.path));
  // Mutation dispatch is fail-closed: an unregistered mutation is treated as no route,
  // so adding a handler also requires adding its explicit contract here.
  if (!schema) throw new HttpError(404, 'route_not_found', `No registered mutation route: ${method} ${pathname}`);
  const value = body === undefined ? {} : body;
  if (!value || typeof value !== 'object' || Array.isArray(value)) throw new HttpError(400, 'body_invalid', 'Mutation body must be a JSON object');
  assertSafeObject(value);
  const unknown = Object.keys(value).filter((key) => !schema.fields.includes(key));
  if (unknown.length) throw new HttpError(400, 'field_unknown', `Unknown mutation field${unknown.length > 1 ? 's' : ''}: ${unknown.join(', ')}`, { unknown, allowed: schema.fields });
  const missing = schema.required.filter((key) => value[key] === undefined || value[key] === null || value[key] === '');
  if (missing.length) throw new HttpError(400, 'field_required', `Missing required field${missing.length > 1 ? 's' : ''}: ${missing.join(', ')}`, { missing });
  for (const [field, rule] of Object.entries(schema.rules)) {
    const fieldValue = value[field];
    // Optional null is an explicit absence value used by several compatibility APIs.
    if (fieldValue === undefined || fieldValue === null) continue;
    let valid = true;
    if (rule.type === 'string') valid = typeof fieldValue === 'string' && fieldValue.length <= rule.maximum;
    else if (rule.type === 'boolean') valid = typeof fieldValue === 'boolean';
    else if (rule.type === 'array') valid = Array.isArray(fieldValue) && fieldValue.length <= rule.maximum;
    else if (rule.type === 'object') valid = Boolean(fieldValue) && typeof fieldValue === 'object' && !Array.isArray(fieldValue) && !ArrayBuffer.isView(fieldValue);
    else if (rule.type === 'binary') valid = Buffer.isBuffer(fieldValue) || fieldValue instanceof Uint8Array;
    else if (rule.type === 'number') valid = typeof fieldValue === 'number' && Number.isFinite(fieldValue) && fieldValue >= rule.minimum && fieldValue <= rule.maximum && (!rule.integer || Number.isInteger(fieldValue));
    else if (rule.type === 'json-scalar-or-object') valid = !Array.isArray(fieldValue) && ['string', 'number', 'boolean', 'object'].includes(typeof fieldValue) && (typeof fieldValue !== 'number' || Number.isFinite(fieldValue));
    if (!valid) throw new HttpError(400, 'field_invalid', `${field} has an invalid type, shape, or range`, { field, expected: rule });
  }
  return value;
}
