import crypto from 'node:crypto';

const TOKEN = /^--[a-z][a-z0-9-]{0,62}$/;
const FORBIDDEN_VALUE = /(?:@import|url\s*\(|expression\s*\(|javascript:|https?:\/\/|[{};])/i;
const stable = (value) => {
  if (Array.isArray(value)) return `[${value.map(stable).join(',')}]`;
  if (value && typeof value === 'object') return `{${Object.keys(value).sort().map((key) => `${JSON.stringify(key)}:${stable(value[key])}`).join(',')}}`;
  return JSON.stringify(value);
};
export const designChecksum = (value) => crypto.createHash('sha256').update(stable(value)).digest('hex');

export function normalizeTokens(input, label = 'theme') {
  if (!input || typeof input !== 'object' || Array.isArray(input)) throw Object.assign(new Error(`${label} tokens must be an object`), { status: 422, code: 'design_tokens_invalid' });
  const entries = Object.entries(input);
  if (!entries.length || entries.length > 200) throw Object.assign(new Error(`${label} must contain 1–200 tokens`), { status: 422, code: 'design_tokens_invalid' });
  const output = {};
  for (const [name, raw] of entries.sort(([a], [b]) => a.localeCompare(b))) {
    if (!TOKEN.test(name)) throw Object.assign(new Error(`Invalid design token name: ${name}`), { status: 422, code: 'design_token_name_invalid' });
    const value = String(raw ?? '').trim();
    if (!value || value.length > 300 || FORBIDDEN_VALUE.test(value) || /[\u0000-\u001f\u007f]/.test(value)) throw Object.assign(new Error(`Unsafe or invalid value for ${name}`), { status: 422, code: 'design_token_value_invalid' });
    output[name] = value;
  }
  return output;
}
function declarations(tokens) { return Object.entries(tokens).map(([name, value]) => `  ${name}: ${value};`).join('\n'); }
function markdown(value, name) {
  const text = String(value || `# ${name}\n`).replaceAll('\u0000', '').trim();
  if (Buffer.byteLength(text) > 128 * 1024) throw Object.assign(new Error('DESIGN.md exceeds 128 KiB'), { status: 413, code: 'design_markdown_too_large' });
  return `${text}\n`;
}

/** Compile a fully self-contained, immutable CSS/prompt payload.
 * @param {any} input
 * @param {{versionId?: string, version?: number, fontFaces?: any[]}} [options]
 */
export function compileDesignSystem(input, { versionId, version, fontFaces = [] } = {}) {
  const name = String(input?.name || 'Design system').trim().slice(0, 100) || 'Design system';
  const light = normalizeTokens(input?.light || input?.tokens?.light, 'light');
  const dark = normalizeTokens(input?.dark || input?.tokens?.dark, 'dark');
  const defaultTheme = input?.defaultTheme === 'light' ? 'light' : 'dark';
  const designMarkdown = markdown(input?.markdown ?? input?.designMd, name);
  const fontCss = fontFaces.map((face) => String(face.css || '')).filter(Boolean).join('\n');
  const defaultTokens = defaultTheme === 'light' ? light : dark;
  const marker = `mypath-design-system:${versionId || 'unversioned'}`;
  const css = `/* ${marker}:start */\n${fontCss}${fontCss ? '\n' : ''}:root {\n${declarations(defaultTokens)}\n  color-scheme: ${defaultTheme};\n}\n:root[data-theme="light"], [data-theme="light"] {\n${declarations(light)}\n  color-scheme: light;\n}\n:root[data-theme="dark"], [data-theme="dark"] {\n${declarations(dark)}\n  color-scheme: dark;\n}\n/* ${marker}:end */`;
  const fontRefs = fontFaces.map(({ font, css: ignored }) => ({ fontId: font.id, assetId: font.assetId, checksum: font.checksum, family: font.family, weight: font.weight, style: font.style }));
  const promptText = `DESIGN SYSTEM (exact immutable version ${version || '?'}; id ${versionId || 'pending'})\nName: ${name}\nDefault mode: ${defaultTheme}\nUse only these light/dark tokens and local fonts.\n\nDESIGN.md\n${designMarkdown}\nTOKENS\n${stable({ light, dark, fonts: fontRefs })}`;
  const data = { name, defaultTheme, light, dark, markdown: designMarkdown, fontRefs };
  return { ...data, versionId: versionId || null, version: version || null, css, promptText, checksum: designChecksum({ data, css, promptText }) };
}

export function injectCompiledTheme(files, compilation) {
  const output = { ...(files || {}) }; const target = 'src/index.css';
  const existing = String(output[target] || '');
  const stripped = existing.replace(/\/\* mypath-design-system:[^*]+:start \*\/[\s\S]*?\/\* mypath-design-system:[^*]+:end \*\/[\r\n]*/g, '');
  output[target] = `${compilation.css}\n${stripped}`;
  return output;
}
