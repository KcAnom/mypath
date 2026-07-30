import path from 'node:path';
import { builtinModules } from 'node:module';
import ts from 'typescript';

const BUILT_INS = new Set([...builtinModules, ...builtinModules.map((name) => `node:${name}`)]);
export const APPROVED_GENERATED_PACKAGES = new Set(['react', 'react/jsx-runtime', 'react/jsx-dev-runtime', 'react-dom', 'react-dom/client']);
const SOURCE_EXTENSIONS = ['.ts', '.tsx', '.js', '.jsx', '.css', '.json'];
const SCRIPT_PATH = /\.(?:ts|tsx|js|jsx)$/i;
const SOURCE_PATH = /\.(?:ts|tsx|js|jsx|css|json)$/i;

export class GeneratedSourceError extends Error {
  constructor(message, details) {
    super(message);
    this.code = 'generated_source_invalid';
    this.status = 422;
    this.details = details;
  }
}

/** Replace comments with spaces while retaining newlines and byte offsets. Used only for CSS. */
function maskCssComments(source) {
  return source.replace(/\/\*[\s\S]*?\*\//g, (comment) => comment.replace(/[^\r\n]/g, ' '));
}

function scriptImportSpecifiers(name, source) {
  const kind = /\.tsx$/i.test(name) ? ts.ScriptKind.TSX : /\.jsx$/i.test(name) ? ts.ScriptKind.JSX : /\.ts$/i.test(name) ? ts.ScriptKind.TS : ts.ScriptKind.JS;
  const tree = ts.createSourceFile(name, source, ts.ScriptTarget.Latest, true, kind);
  const specifiers = [];
  let dynamicImport = false;
  let commonJsRequire = false;
  const visit = (node) => {
    if ((ts.isImportDeclaration(node) || ts.isExportDeclaration(node)) && node.moduleSpecifier && ts.isStringLiteralLike(node.moduleSpecifier)) specifiers.push(node.moduleSpecifier.text);
    else if (ts.isImportEqualsDeclaration(node) && ts.isExternalModuleReference(node.moduleReference) && node.moduleReference.expression && ts.isStringLiteralLike(node.moduleReference.expression)) specifiers.push(node.moduleReference.expression.text);
    if (ts.isCallExpression(node)) {
      if (node.expression.kind === ts.SyntaxKind.ImportKeyword) dynamicImport = true;
      if (ts.isIdentifier(node.expression) && node.expression.text === 'require') commonJsRequire = true;
    }
    ts.forEachChild(node, visit);
  };
  visit(tree);
  return { specifiers, dynamicImport, commonJsRequire };
}

function cssImportSpecifiers(source) {
  const masked = maskCssComments(source);
  const specifiers = [];
  const pattern = /@import\s+(?:url\(\s*)?(?:["']([^"']+)["']|([^\s;)]+))/giy;
  // Sticky matching is deliberately avoided: scan each actual @import token, including
  // whitespace that was formerly a comment, without ever deleting source characters.
  const token = /@import\b/gi;
  for (const match of masked.matchAll(token)) {
    pattern.lastIndex = match.index;
    const parsed = pattern.exec(masked);
    if (parsed) specifiers.push(parsed[1] || parsed[2]);
  }
  return specifiers;
}

function resolvesInsideCandidate(importer, specifier, files) {
  const importerDir = path.posix.dirname(importer);
  const resolved = path.posix.normalize(path.posix.join(importerDir, specifier));
  if (resolved === '..' || resolved.startsWith('../') || resolved.startsWith('/')) return false;
  if (files.has(resolved)) return true;
  if (SOURCE_EXTENSIONS.some((extension) => files.has(resolved + extension))) return true;
  return SOURCE_EXTENSIONS.some((extension) => files.has(path.posix.join(resolved, `index${extension}`)));
}

function validateSpecifier(name, specifier, names) {
  if (/^(?:https?:)?\/\//i.test(specifier)) throw new GeneratedSourceError(`Remote import is not allowed: ${specifier}`, { path: name, specifier });
  if (BUILT_INS.has(specifier) || specifier.startsWith('node:')) throw new GeneratedSourceError(`Node built-in import is not allowed: ${specifier}`, { path: name, specifier });
  if (specifier.startsWith('.')) {
    if (!resolvesInsideCandidate(name, specifier, names)) throw new GeneratedSourceError(`Relative import escapes or is missing from candidate: ${specifier}`, { path: name, specifier });
  } else if (specifier.startsWith('/') || path.posix.isAbsolute(specifier)) {
    throw new GeneratedSourceError(`Absolute import is not allowed: ${specifier}`, { path: name, specifier });
  } else if (!APPROVED_GENERATED_PACKAGES.has(specifier)) {
    throw new GeneratedSourceError(`Package import is not approved: ${specifier}`, { path: name, specifier });
  }
}

export function validateGeneratedSources(files, options = {}) {
  if (!files || typeof files !== 'object' || Array.isArray(files)) throw new GeneratedSourceError('Generated files must be an object');
  const maxFiles = options.maxFiles || 100;
  const maxFileBytes = options.maxFileBytes || 256 * 1024;
  const maxTotalBytes = options.maxTotalBytes || 1024 * 1024;
  const maxAssetBytes = options.maxAssetBytes || 768 * 1024;
  const maxTotalAssetBytes = options.maxTotalAssetBytes || 4 * 1024 * 1024;
  const entries = Object.entries(files);
  if (entries.length > maxFiles) throw new GeneratedSourceError(`Generated output exceeds ${maxFiles} files`, { maxFiles });
  const names = new Set(entries.map(([name]) => name));
  let total = 0; let assetTotal = 0;
  for (const [name, content] of entries) {
    if (typeof content !== 'string') throw new GeneratedSourceError(`Generated source must be text: ${name}`);
    const size = Buffer.byteLength(content); const encodedAsset = name.startsWith('assets/') && content.startsWith('base64:');
    if (encodedAsset) { assetTotal += size; if (size > maxAssetBytes || assetTotal > maxTotalAssetBytes || (content.length - 7) % 4 !== 0 || !/^base64:(?:[A-Za-z0-9+/]{4})*(?:[A-Za-z0-9+/]{2}==|[A-Za-z0-9+/]{3}=)?$/.test(content)) throw new GeneratedSourceError(`Generated asset exceeds limits or is not canonical base64: ${name}`, { path: name, maxAssetBytes, maxTotalAssetBytes }); }
    else { total += size; if (size > maxFileBytes) throw new GeneratedSourceError(`Generated source exceeds per-file limit: ${name}`, { path: name, maxFileBytes }); if (total > maxTotalBytes) throw new GeneratedSourceError('Generated output exceeds aggregate source limit', { maxTotalBytes }); }
    if (!SOURCE_PATH.test(name) && !name.startsWith('assets/')) continue;
    let specifiers = [];
    if (SCRIPT_PATH.test(name)) {
      const parsed = scriptImportSpecifiers(name, content);
      if (parsed.dynamicImport) throw new GeneratedSourceError(`Dynamic import is not allowed: ${name}`, { path: name });
      if (parsed.commonJsRequire) throw new GeneratedSourceError(`CommonJS require is not allowed: ${name}`, { path: name });
      specifiers = parsed.specifiers;
    } else if (/\.css$/i.test(name)) {
      specifiers = cssImportSpecifiers(content);
      if (/url\(\s*["']?(?:https?:)?\/\//i.test(maskCssComments(content))) throw new GeneratedSourceError(`Remote CSS assets and fonts are not allowed: ${name}`, { path: name });
    }
    for (const specifier of specifiers) validateSpecifier(name, specifier, names);
  }
  return { fileCount: entries.length, totalBytes: total };
}
