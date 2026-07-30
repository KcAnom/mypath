import crypto from 'node:crypto';
import ts from 'typescript';

export const SOURCE_ATTRIBUTE = 'data-mypath-source-id';
const SOURCE_ID = /^mp_[a-f0-9]{16,32}$/;
const APPROVED_ATTRIBUTES = new Set(['className', 'style', 'id', 'title', 'tabIndex', 'aria-label', 'aria-describedby', 'aria-hidden', 'aria-current', 'role', 'placeholder', 'alt', 'type', 'name', 'value', 'disabled', 'checked', 'htmlFor', 'width', 'height']);
const JSX_FILE = /\.(?:tsx|jsx)$/i;
const encode = (value) => JSON.stringify(value ?? null);

function problem(message, details = {}) {
  return Object.assign(new Error(message), { status: 422, code: 'reconciliation_required', details });
}
function parse(path, source) {
  const scriptKind = path.toLowerCase().endsWith('.jsx') ? ts.ScriptKind.JSX : ts.ScriptKind.TSX;
  const file = ts.createSourceFile(path, source, ts.ScriptTarget.Latest, true, scriptKind);
  const diagnostics = /** @type {any} */ (file).parseDiagnostics || [];
  if (diagnostics.length) {
    const diagnostic = diagnostics[0];
    throw problem(`Source cannot be safely mapped: ${ts.flattenDiagnosticMessageText(diagnostic.messageText, '\n')}`, { path, position: diagnostic.start });
  }
  return file;
}
function intrinsicName(tagName) {
  const text = tagName.getText();
  return /^[a-z][a-z0-9-]*$/.test(text) ? text : null;
}
function openingFor(node) { return ts.isJsxElement(node) ? node.openingElement : node; }
function sourceIdFor(opening) {
  const matches = opening.attributes.properties.filter((item) => ts.isJsxAttribute(item) && item.name.getText() === SOURCE_ATTRIBUTE);
  if (matches.length !== 1) return matches.length ? '__ambiguous__' : null;
  const initializer = matches[0].initializer;
  return initializer && ts.isStringLiteral(initializer) && SOURCE_ID.test(initializer.text) ? initializer.text : '__invalid__';
}
function freshId(seed = crypto.randomBytes(16).toString('hex')) {
  return `mp_${crypto.createHash('sha256').update(String(seed)).digest('hex').slice(0, 20)}`;
}
function jsxNodes(file) {
  const result = [];
  const visit = (node, ancestry = [], structural = []) => {
    if (ts.isJsxElement(node) || ts.isJsxSelfClosingElement(node)) {
      const opening = openingFor(node); const tag = intrinsicName(opening.tagName);
      const key = tag ? `${structural.join('/')}/${tag}` : null;
      if (tag) result.push({ node, opening, tag, ancestry, structuralKey: key });
      const children = ts.isJsxElement(node) ? node.children : [];
      let index = 0;
      for (const child of children) {
        if (ts.isJsxElement(child) || ts.isJsxSelfClosingElement(child) || ts.isJsxFragment(child)) visit(child, [...ancestry, node], [...structural, `${tag || 'custom'}:${index++}`]);
        else visit(child, [...ancestry, node], structural);
      }
      return;
    }
    if (ts.isJsxFragment(node)) {
      let index = 0; for (const child of node.children) visit(child, [...ancestry, node], [...structural, `fragment:${index++}`]); return;
    }
    ts.forEachChild(node, (child) => visit(child, [...ancestry, node], structural));
  };
  visit(file);
  return result;
}
function inheritedByStructure(files) {
  const result = new Map();
  for (const [path, source] of Object.entries(files || {}).filter(([name]) => JSX_FILE.test(name))) {
    const file = parse(path, String(source));
    for (const item of jsxNodes(file)) {
      const id = sourceIdFor(item.opening);
      if (id && !id.startsWith('__')) {
        const key = `${path}\0${item.structuralKey}`;
        if (result.has(key)) result.set(key, '__ambiguous__'); else result.set(key, id);
      }
    }
  }
  return result;
}

/** Inject stable source IDs into intrinsic JSX. Existing valid IDs are always preserved. */
export function injectSourceIds(files, inheritedFiles = null) {
  const inherited = inheritedFiles ? inheritedByStructure(inheritedFiles) : new Map();
  const output = { ...files }; const seen = new Map();
  for (const [path, raw] of Object.entries(files || {}).filter(([name]) => JSX_FILE.test(name))) {
    const source = String(raw); const file = parse(path, source); const inserts = [];
    for (const item of jsxNodes(file)) {
      let id = sourceIdFor(item.opening);
      if (id === '__ambiguous__' || id === '__invalid__') throw problem('Source IDs must be one valid literal attribute per intrinsic JSX node', { path, tag: item.tag });
      if (!id) {
        const inheritedId = inherited.get(`${path}\0${item.structuralKey}`);
        if (inheritedId === '__ambiguous__') throw problem('Structural source-ID matching is ambiguous', { path, structuralKey: item.structuralKey });
        id = inheritedId || freshId(`${path}\0${item.structuralKey}\0${item.tag}`);
        inserts.push({ at: item.opening.tagName.end, text: ` ${SOURCE_ATTRIBUTE}="${id}"` });
      }
      if (seen.has(id)) throw problem('A source ID identifies more than one JSX node', { sourceId: id, first: seen.get(id), second: path });
      seen.set(id, path);
    }
    let next = source;
    for (const insertion of inserts.sort((a, b) => b.at - a.at)) next = next.slice(0, insertion.at) + insertion.text + next.slice(insertion.at);
    parse(path, next); output[path] = next;
  }
  return output;
}

function unsupportedReasons(item) {
  const reasons = [];
  if (item.opening.attributes.properties.some(ts.isJsxSpreadAttribute)) reasons.push('spread_props');
  for (const ancestor of item.ancestry) {
    if (ts.isCallExpression(ancestor) && ts.isPropertyAccessExpression(ancestor.expression) && ancestor.expression.name.text === 'map') reasons.push('repeated_map');
    if (ts.isConditionalExpression(ancestor) || ts.isIfStatement(ancestor) || ts.isSwitchStatement(ancestor)) reasons.push('conditional_render');
    if (ts.isJsxFragment(ancestor)) reasons.push('fragment_context');
  }
  return [...new Set(reasons)];
}
function literalAttribute(attribute) {
  if (!attribute.initializer) return true;
  if (ts.isStringLiteral(attribute.initializer)) return attribute.initializer.text;
  if (!ts.isJsxExpression(attribute.initializer) || !attribute.initializer.expression) return null;
  const expression = attribute.initializer.expression;
  if (ts.isStringLiteral(expression) || ts.isNumericLiteral(expression)) return expression.text;
  if (expression.kind === ts.SyntaxKind.TrueKeyword) return true;
  if (expression.kind === ts.SyntaxKind.FalseKeyword) return false;
  if (ts.isObjectLiteralExpression(expression)) {
    const value = {};
    for (const property of expression.properties) {
      if (!ts.isPropertyAssignment(property) || (!ts.isIdentifier(property.name) && !ts.isStringLiteral(property.name))) return null;
      const item = property.initializer;
      if (ts.isStringLiteral(item) || ts.isNumericLiteral(item)) value[property.name.text] = item.text;
      else if (item.kind === ts.SyntaxKind.TrueKeyword) value[property.name.text] = true;
      else if (item.kind === ts.SyntaxKind.FalseKeyword) value[property.name.text] = false;
      else return null;
    }
    return value;
  }
  return null;
}
function layerFrom(item, file, path) {
  const sourceId = sourceIdFor(item.opening); const reasons = unsupportedReasons(item);
  const attributes = {}; let computedAttribute = false;
  for (const property of item.opening.attributes.properties) {
    if (!ts.isJsxAttribute(property)) continue;
    const name = property.name.getText(); if (name === SOURCE_ATTRIBUTE || !APPROVED_ATTRIBUTES.has(name)) continue;
    const value = literalAttribute(property); if (value === null) computedAttribute = true; else attributes[name] = value;
  }
  let text = null;
  if (ts.isJsxElement(item.node)) {
    const meaningful = item.node.children.filter((child) => !(ts.isJsxText(child) && !child.getText(file).trim()));
    if (meaningful.length === 1 && ts.isJsxText(meaningful[0])) text = meaningful[0].getText(file).trim();
    else if (meaningful.some(ts.isJsxExpression)) reasons.push('computed_text');
  }
  if (computedAttribute) reasons.push('computed_attribute');
  return { sourceId, path, tag: item.tag, text, attributes, editable: reasons.length === 0, readOnlyReasons: [...new Set(reasons)], start: item.node.getStart(file), end: item.node.end, parentSourceId: [...item.ancestry].reverse().map((node) => (ts.isJsxElement(node) || ts.isJsxSelfClosingElement(node)) ? sourceIdFor(openingFor(node)) : null).find((id) => id && !id.startsWith('__')) || null };
}

export function analyzeSource(files) {
  const normalized = injectSourceIds(files); const layers = []; const ids = new Set();
  for (const [path, source] of Object.entries(normalized).filter(([name]) => JSX_FILE.test(name))) {
    const file = parse(path, String(source));
    for (const item of jsxNodes(file)) {
      const layer = layerFrom(item, file, path);
      if (!layer.sourceId || layer.sourceId.startsWith('__') || ids.has(layer.sourceId)) throw problem('Source mapping is ambiguous', { path, sourceId: layer.sourceId });
      ids.add(layer.sourceId); layers.push(layer);
    }
  }
  return { files: normalized, layers };
}
function findTarget(files, sourceId) {
  const matches = [];
  for (const [path, source] of Object.entries(files).filter(([name]) => JSX_FILE.test(name))) {
    const file = parse(path, String(source));
    for (const item of jsxNodes(file)) if (sourceIdFor(item.opening) === sourceId) matches.push({ path, source: String(source), file, item, layer: layerFrom(item, file, path) });
  }
  if (matches.length !== 1) throw problem('The selected source node is missing or ambiguous', { sourceId, matches: matches.length });
  if (!matches[0].layer.editable) throw problem('This rendered node is outside the supported visual-editing subset', { sourceId, reasons: matches[0].layer.readOnlyReasons });
  return matches[0];
}
function quote(value) { return JSON.stringify(String(value)); }
function styleExpression(value) {
  if (!value || typeof value !== 'object' || Array.isArray(value)) throw problem('style must be a literal object');
  const entries = Object.entries(value).sort(([a], [b]) => a.localeCompare(b));
  for (const [name, item] of entries) if (!/^[A-Za-z_$][\w$]*$/.test(name) || !['string', 'number', 'boolean'].includes(typeof item)) throw problem('style contains an unsupported computed value', { property: name });
  return `{{ ${entries.map(([name, item]) => `${name}: ${typeof item === 'string' ? quote(item) : String(item)}`).join(', ')} }}`;
}
function replaceAttribute(target, name, value, remove = false) {
  if (!APPROVED_ATTRIBUTES.has(name)) throw problem('Attribute is not approved for visual editing', { attribute: name });
  const matches = target.item.opening.attributes.properties.filter((property) => ts.isJsxAttribute(property) && property.name.getText() === name);
  if (matches.length > 1) throw problem('Attribute mapping is ambiguous', { attribute: name });
  const source = target.source;
  if (remove) {
    if (!matches.length) return source;
    const attribute = matches[0]; return source.slice(0, attribute.getFullStart()) + source.slice(attribute.end);
  }
  const encodedValue = name === 'style' ? styleExpression(value) : (typeof value === 'boolean' ? (value ? `{true}` : `{false}`) : quote(value));
  if (matches.length) {
    const attribute = matches[0];
    if (!attribute.initializer) return source.slice(0, attribute.end) + `=${encodedValue}` + source.slice(attribute.end);
    return source.slice(0, attribute.initializer.getStart(target.file)) + encodedValue + source.slice(attribute.initializer.end);
  }
  const at = target.item.opening.attributes.end;
  return source.slice(0, at) + ` ${name}=${encodedValue}` + source.slice(at);
}
function replaceText(target, value) {
  if (!ts.isJsxElement(target.item.node)) throw problem('Self-closing nodes have no editable text');
  const meaningful = target.item.node.children.filter((child) => !(ts.isJsxText(child) && !child.getText(target.file).trim()));
  if (meaningful.length !== 1 || !ts.isJsxText(meaningful[0])) throw problem('Only a single literal text child can be edited', { sourceId: target.layer.sourceId });
  const text = String(value); if (/[<>{}]/.test(text)) throw problem('Text contains JSX syntax; use literal plain text');
  const escaped = text.replaceAll('&', '&amp;'); const node = meaningful[0];
  return target.source.slice(0, node.getStart(target.file)) + escaped + target.source.slice(node.end);
}
function duplicateNode(target) {
  let copy = target.source.slice(target.item.node.getStart(target.file), target.item.node.end);
  copy = copy.replace(/data-mypath-source-id\s*=\s*"mp_[a-f0-9]{16,32}"/g, () => `${SOURCE_ATTRIBUTE}="${freshId()}"`);
  return target.source.slice(0, target.item.node.end) + `\n${copy}` + target.source.slice(target.item.node.end);
}

/** Apply deterministic operations. The source is reparsed and the ID resolved before every operation. */
export function applyOperations(inputFiles, operations) {
  let files = injectSourceIds(inputFiles);
  for (const operation of operations || []) {
    if (!operation || typeof operation !== 'object' || !SOURCE_ID.test(String(operation.sourceId || ''))) throw problem('Operation requires a valid sourceId');
    const target = findTarget(files, operation.sourceId); let next;
    if (operation.type === 'set-text') next = replaceText(target, operation.value);
    else if (operation.type === 'set-class') next = replaceAttribute(target, 'className', operation.value);
    else if (operation.type === 'set-style') next = replaceAttribute(target, 'style', operation.value);
    else if (operation.type === 'set-attribute') next = replaceAttribute(target, String(operation.name || ''), operation.value);
    else if (operation.type === 'remove-attribute') next = replaceAttribute(target, String(operation.name || ''), null, true);
    else if (operation.type === 'duplicate') next = duplicateNode(target);
    else throw problem('Unsupported visual edit operation', { type: operation.type });
    parse(target.path, next); files = { ...files, [target.path]: next };
    analyzeSource(files);
  }
  return files;
}

export function compareFiles(leftFiles, rightFiles) {
  const paths = [...new Set([...Object.keys(leftFiles || {}), ...Object.keys(rightFiles || {})])].sort();
  return paths.map((path) => {
    const left = String(leftFiles?.[path] ?? '').split('\n'); const right = String(rightFiles?.[path] ?? '').split('\n'); const changes = [];
    const count = Math.max(left.length, right.length);
    for (let index = 0; index < count; index++) if (left[index] !== right[index]) changes.push({ line: index + 1, before: left[index] ?? null, after: right[index] ?? null });
    return { path, changed: changes.length > 0, changes };
  });
}

export function reconciliationError(error) {
  return error?.code === 'reconciliation_required' ? error : problem(String(error?.message || error), { original: encode(error) });
}
