import fs from 'node:fs';
import { implementedDeclaredRoutes, intentionallyUnsupportedPhase0, runtimeRoutes } from '../server/src/routes/conformance.js';
import { mutationRoutes } from '../server/src/routes/mutations.js';

const source = fs.readFileSync('packages/shared/src/routes.ts', 'utf8');
const block = source.slice(source.indexOf('export const Routes = {'), source.indexOf('} as const;', source.indexOf('export const Routes = {')));
const declared = [...block.matchAll(/^  ([A-Z0-9_]+):\s*'([^']+)'/gm)].map((match) => ({ key: match[1], path: match[2] }));
if (!declared.length) throw new Error('No shared routes were parsed');
const declaredKeys = new Set(declared.map((route) => route.key));
const registeredPaths = new Set([
  ...runtimeRoutes.flatMap((route) => [route.path, route.canonical].filter(Boolean)),
  ...Object.values(implementedDeclaredRoutes).flatMap((route) => route.aliases || []),
  ...mutationRoutes.flatMap((route) => [route.path, `/api/v1${route.path}`]),
].map((value) => value.replace(/\/$/, '')));
for (const route of declared) {
  const implemented = implementedDeclaredRoutes[route.key];
  const unsupported = intentionallyUnsupportedPhase0.has(route.key);
  if (Boolean(implemented) === Boolean(unsupported)) throw new Error(`${route.key} must be classified exactly once`);
  if (implemented) {
    if (!implemented.methods?.length || !implemented.auth || !implemented.aliases?.length) throw new Error(`${route.key} conformance record is incomplete`);
    if (!implemented.aliases.some((alias) => alias.startsWith('/api/v1/') || route.path.startsWith('/v1/'))) throw new Error(`${route.key} lacks canonical /api/v1 alias`);
    const normalizedPath = route.path.replace(/\/$/, '');
    if (!implemented.aliases.some((alias) => registeredPaths.has(alias.replace(/\/$/, ''))) && !registeredPaths.has(normalizedPath)) throw new Error(`${route.key} is classified implemented but absent from registered route metadata`);
  }
}
for (const key of Object.keys(implementedDeclaredRoutes)) if (!declaredKeys.has(key)) throw new Error(`Unknown implemented route key: ${key}`);
for (const key of intentionallyUnsupportedPhase0) if (!declaredKeys.has(key)) throw new Error(`Unknown unsupported route key: ${key}`);
for (const route of runtimeRoutes) {
  if (!route.path || !route.methods?.length || !route.auth) throw new Error('Runtime route record is incomplete');
  for (const method of route.methods.filter((item) => ['POST', 'PUT', 'PATCH'].includes(item))) {
    if (!mutationRoutes.some((schema) => schema.path === route.path && schema.methods.includes(method))) throw new Error(`${method} ${route.path} lacks registered mutation schema`);
  }
}
const identities = new Set();
for (const route of mutationRoutes) for (const method of route.methods) {
  const identity = `${method} ${route.path}`; if (identities.has(identity)) throw new Error(`Duplicate mutation route metadata: ${identity}`); identities.add(identity);
}
console.log(`Route conformance passed from metadata: ${declared.length} declared (${Object.keys(implementedDeclaredRoutes).length} implemented, ${intentionallyUnsupportedPhase0.size} explicitly Phase-0 unsupported), ${runtimeRoutes.length} runtime and ${identities.size} schema-validated mutation routes`);
