import fs from 'node:fs';
import path from 'node:path';

const ALLOWED = [
  /^src\/App\.tsx$/,
  /^src\/index\.css$/,
  /^src\/components\/generated\/[A-Za-z0-9._/-]+$/,
  /^assets\/[A-Za-z0-9._/-]+$/,
];

export class ForgePathError extends Error {
  constructor(message) { super(message); this.code = 'forge_path_invalid'; this.status = 422; }
}

export function validateForgeRelativePath(relativePath) {
  if (typeof relativePath !== 'string' || !relativePath || relativePath.includes('\0')) throw new ForgePathError('Forge path must be a non-empty string');
  if (path.isAbsolute(relativePath) || /^[A-Za-z]:[\\/]/.test(relativePath) || relativePath.includes('\\')) throw new ForgePathError(`Absolute or platform-specific forge path rejected: ${relativePath}`);
  const normalized = path.posix.normalize(relativePath);
  if (normalized !== relativePath || normalized === '..' || normalized.startsWith('../') || relativePath.split('/').includes('..')) throw new ForgePathError(`Forge traversal rejected: ${relativePath}`);
  if (!ALLOWED.some((rule) => rule.test(relativePath))) throw new ForgePathError(`Forge path is outside the allowlist: ${relativePath}`);
  return normalized;
}

function assertNoSymlink(root, target) {
  const rootReal = fs.realpathSync(root);
  let cursor = target;
  while (cursor !== root && cursor.startsWith(root + path.sep)) {
    if (fs.existsSync(cursor)) {
      const stat = fs.lstatSync(cursor);
      if (stat.isSymbolicLink()) throw new ForgePathError(`Forge symlink rejected: ${cursor}`);
      const real = fs.realpathSync(cursor);
      if (real !== rootReal && !real.startsWith(rootReal + path.sep)) throw new ForgePathError(`Forge path escapes root: ${cursor}`);
    }
    cursor = path.dirname(cursor);
  }
}

export function resolveForgePath(forgeRoot, componentId, relativePath) {
  if (typeof componentId !== 'string' || !/^[A-Za-z0-9_-]+$/.test(componentId)) throw new ForgePathError('Invalid component id');
  const rel = validateForgeRelativePath(relativePath);
  fs.mkdirSync(forgeRoot, { recursive: true });
  const root = path.resolve(forgeRoot);
  if (fs.lstatSync(root).isSymbolicLink()) throw new ForgePathError('Forge root may not be a symlink');
  const componentRoot = path.resolve(root, componentId);
  if (componentRoot !== root && !componentRoot.startsWith(root + path.sep)) throw new ForgePathError('Component path escapes forge root');
  assertNoSymlink(root, componentRoot);
  const target = path.resolve(componentRoot, ...rel.split('/'));
  if (!target.startsWith(componentRoot + path.sep)) throw new ForgePathError('Forge path escapes component root');
  assertNoSymlink(root, target);
  return target;
}

export function writeForgeFiles(forgeRoot, componentId, files) {
  if (!files || typeof files !== 'object' || Array.isArray(files)) throw new ForgePathError('Forge files must be an object');
  const planned = Object.entries(files).map(([relativePath, content]) => {
    if (typeof content !== 'string') throw new ForgePathError(`Forge file content must be text: ${relativePath}`);
    return [resolveForgePath(forgeRoot, componentId, relativePath), content];
  });
  // Validation is complete before the first write.
  for (const [target, content] of planned) {
    fs.mkdirSync(path.dirname(target), { recursive: true });
    assertNoSymlink(path.resolve(forgeRoot), target);
    const temporary = `${target}.tmp-${process.pid}`;
    fs.writeFileSync(temporary, content, { mode: 0o600 });
    fs.renameSync(temporary, target);
  }
  return path.join(forgeRoot, componentId);
}
