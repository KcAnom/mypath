import fs from 'node:fs';
import path from 'node:path';
import { createRequire } from 'node:module';
import { build as viteBuild } from 'vite';
import tailwindcss from '@tailwindcss/vite';
import { validateGeneratedSources } from '../security/generated-source.js';

const [, , inputPath, workspace, resultPath] = process.argv;
const require = createRequire(import.meta.url);
const tailwindStylesheet = require.resolve('tailwindcss/index.css');
const tailwindRoot = path.dirname(tailwindStylesheet);
const installedModules = path.dirname(path.dirname(require.resolve('react/package.json')));
const approvedRuntimeRoots = ['react', 'react-dom', 'scheduler'].map((name) => fs.realpathSync(path.dirname(require.resolve(`${name}/package.json`))));
const result = { ok: false, diagnostics: [] };

function diagnostic(stage, error) {
  const details = error?.details || {};
  return {
    severity: 'error', stage, code: error?.code || 'build_failed',
    message: String(error?.message || error), path: details.path || null,
    line: error?.loc?.line || null, column: error?.loc?.column || null,
  };
}
function isInside(root, target) {
  const relative = path.relative(root, target);
  return relative === '' || (!relative.startsWith('..' + path.sep) && relative !== '..' && !path.isAbsolute(relative));
}
function containmentPlugin(sourceRoot) {
  const realSourceRoot = fs.realpathSync(sourceRoot);
  return /** @type {import('vite').Plugin} */ ({
    name: 'mypath-resolver-containment',
    enforce: 'post',
    async resolveId(source, importer, options) {
      if (!importer || source.startsWith('\0')) return null;
      const resolved = await this.resolve(source, importer, { ...options, skipSelf: true });
      if (!resolved || resolved.external || resolved.id.startsWith('\0')) return resolved;
      const filename = resolved.id.split('?')[0];
      if (!path.isAbsolute(filename) || !fs.existsSync(filename)) throw Object.assign(new Error(`Build resolver produced a non-contained module: ${resolved.id}`), { code: 'resolver_containment_invalid', details: { path: importer, specifier: source } });
      const real = fs.realpathSync(filename);
      if (!isInside(realSourceRoot, real) && !approvedRuntimeRoots.some((root) => isInside(root, real))) throw Object.assign(new Error(`Resolved import escapes the candidate and approved runtime packages: ${source}`), { code: 'resolver_containment_invalid', details: { path: importer, specifier: source, resolved: real } });
      return resolved;
    },
  });
}
function safeWrite(root, name, content) {
  const normalized = path.posix.normalize(name.replaceAll('\\', '/'));
  if (!normalized || normalized === '.' || normalized.startsWith('../') || path.posix.isAbsolute(normalized)) throw Object.assign(new Error(`Invalid candidate path: ${name}`), { code: 'forge_path_invalid', details: { path: name } });
  const destination = path.join(root, ...normalized.split('/'));
  fs.mkdirSync(path.dirname(destination), { recursive: true });
  fs.writeFileSync(destination, content, { flag: 'wx' });
}

try {
  const testDelay = Math.max(0, Math.min(5000, Number(process.env.MYPATH_BUILD_TEST_DELAY_MS || 0)));
  if (testDelay) await new Promise((resolve) => setTimeout(resolve, testDelay));
  const input = JSON.parse(fs.readFileSync(inputPath, 'utf8'));
  validateGeneratedSources(input.files);
  const sourceRoot = path.join(workspace, 'source');
  const outputRoot = path.join(workspace, 'output');
  fs.mkdirSync(sourceRoot, { recursive: true });
  // Resolution is pinned to the application's already-installed dependency tree. The
  // candidate cannot add packages and validation rejects every non-approved import.
  fs.symlinkSync(installedModules, path.join(sourceRoot, 'node_modules'), 'dir');
  const localTailwind = path.join(sourceRoot, '.mypath-tailwind');
  fs.mkdirSync(localTailwind);
  for (const name of ['index.css', 'theme.css', 'preflight.css', 'utilities.css']) fs.copyFileSync(path.join(tailwindRoot, name), path.join(localTailwind, name));
  for (const [name, content] of Object.entries(input.files)) {
    if (!/^(?:src\/(?:[A-Za-z0-9_-]+\/)*[A-Za-z0-9_.-]+\.(?:ts|tsx|js|jsx|css|json)|assets\/(?:[A-Za-z0-9_-]+\/)*[A-Za-z0-9_.-]+)$/.test(name)) throw Object.assign(new Error(`Candidate path is not an approved source or asset path: ${name}`), { code: 'forge_path_invalid', details: { path: name } });
    const output = name.startsWith('assets/') && String(content).startsWith('base64:') ? Buffer.from(String(content).slice(7), 'base64') : (name === 'src/index.css' ? `@import "../.mypath-tailwind/index.css";\n${content}` : content);
    safeWrite(sourceRoot, name, output);
  }
  const candidates = Object.keys(input.files);
  const app = candidates.includes('src/App.tsx') ? 'src/App.tsx'
    : candidates.includes('src/App.jsx') ? 'src/App.jsx'
      : candidates.find((name) => /\.(?:tsx|jsx)$/.test(name));
  if (!app) throw Object.assign(new Error('Candidate must contain src/App.tsx, src/App.jsx, or a JSX component'), { code: 'entrypoint_missing' });
  const css = candidates.includes('src/index.css') ? "import './index.css';\n" : '';
  safeWrite(sourceRoot, 'src/__mypath_entry.jsx', `import React from 'react';\nimport { createRoot } from 'react-dom/client';\nimport App from ${JSON.stringify('./' + path.posix.relative('src', app))};\n${css}const root=createRoot(document.getElementById('root'));\nroot.render(React.createElement(App));\nconst sourcePattern=/^mp_[a-f0-9]{16,32}$/;\nconst occurrenceMetadata=new WeakMap();\nconst annotateOccurrences=()=>{\n  const counts=new Map();\n  document.querySelectorAll('*').forEach((element)=>{\n    const sourceId=element.getAttribute('data-mypath-source-id')||occurrenceMetadata.get(element)?.sourceId;\n    if(!sourcePattern.test(sourceId||'')) return;\n    const index=counts.get(sourceId)||0; counts.set(sourceId,index+1);\n    occurrenceMetadata.set(element,{sourceId,occurrenceId:sourceId+':'+index});\n    // IDs remain immutable in persisted JSX. Runtime metadata is kept outside DOM\n    // attributes so host-page serializers and user CSS cannot depend on the bridge.\n    element.removeAttribute('data-mypath-source-id'); element.removeAttribute('data-mypath-occurrence-id');\n  });\n};\nqueueMicrotask(()=>{ annotateOccurrences(); window.parent.postMessage({channel:'mypath-preview',type:'ready',version:1}, '*'); });\nnew MutationObserver(annotateOccurrences).observe(document.getElementById('root'),{childList:true,subtree:true});\ndocument.addEventListener('click',(event)=>{\n  let element=event.target instanceof Element?event.target:null;\n  while(element&&!occurrenceMetadata.has(element)) element=element.parentElement;\n  const metadata=element?occurrenceMetadata.get(element):null; const sourceId=metadata?.sourceId; const occurrenceId=metadata?.occurrenceId;\n  if(!sourcePattern.test(sourceId||'')||occurrenceId!==sourceId+':'+Number(String(occurrenceId||'').split(':').at(-1))) return;\n  window.parent.postMessage({channel:'mypath-preview',type:'select',version:1,sourceId,occurrenceId,tag:element.tagName.toLowerCase()},'*');\n},true);\nwindow.addEventListener('message', async (event) => {\n  const request=event.data;\n  if(event.source!==window.parent||!request||request.channel!=='mypath-preview'||request.version!==1||request.type!=='capture'||typeof request.id!=='string'||request.id.length>100) return;\n  try {\n    const width=Math.max(1,Math.min(4096,Number(request.width)||document.documentElement.scrollWidth));\n    const height=Math.max(1,Math.min(4096,Number(request.height)||document.documentElement.scrollHeight));\n    const markup=new XMLSerializer().serializeToString(document.documentElement);\n    const svg='<svg xmlns="http://www.w3.org/2000/svg" width="'+width+'" height="'+height+'"><foreignObject width="100%" height="100%">'+markup+'</foreignObject></svg>';\n    const image=new Image();\n    image.src='data:image/svg+xml;charset=utf-8,'+encodeURIComponent(svg);\n    await image.decode();\n    const canvas=document.createElement('canvas'); canvas.width=width; canvas.height=height;\n    canvas.getContext('2d').drawImage(image,0,0,width,height);\n    window.parent.postMessage({channel:'mypath-preview',type:'screenshot',version:1,id:request.id,width,height,dataUrl:canvas.toDataURL('image/png')},'*');\n  } catch(error) { window.parent.postMessage({channel:'mypath-preview',type:'screenshot-error',version:1,id:request.id,message:String(error?.message||error)},'*'); }\n});\n`);
  safeWrite(sourceRoot, 'index.html', '<!doctype html><html><head><meta charset="UTF-8"><meta name="viewport" content="width=device-width,initial-scale=1"></head><body><div id="root"></div><script type="module" src="/src/__mypath_entry.jsx"></script></body></html>');
  await viteBuild({
    root: sourceRoot,
    logLevel: 'silent',
    configFile: false,
    plugins: [tailwindcss(), containmentPlugin(sourceRoot)],
    resolve: { dedupe: ['react', 'react-dom'] },
    esbuild: { jsx: 'automatic', jsxImportSource: 'react' },
    build: { outDir: outputRoot, emptyOutDir: true, assetsInlineLimit: 1024 * 1024, cssCodeSplit: false, minify: true, sourcemap: false, reportCompressedSize: false },
  });
  let html = fs.readFileSync(path.join(outputRoot, 'index.html'), 'utf8');
  html = html.replace(/<script type="module" crossorigin src="([^"]+)"><\/script>/g, (_all, url) => {
    const jsPath = path.join(outputRoot, url.replace(/^\//, ''));
    const js = fs.readFileSync(jsPath, 'utf8').replaceAll('</script>', '<\\/script>');
    return `<script type="module">${js}</script>`;
  });
  html = html.replace(/<link rel="stylesheet" crossorigin href="([^"]+)">/g, (_all, url) => `<style>${fs.readFileSync(path.join(outputRoot, url.replace(/^\//, '')), 'utf8')}</style>`);
  const csp = "default-src 'none'; script-src 'unsafe-inline'; style-src 'unsafe-inline'; img-src data: blob:; font-src data:; connect-src 'none'; media-src data: blob:; object-src 'none'; base-uri 'none'; form-action 'none'";
  html = html.replace('<head>', `<head><meta http-equiv="Content-Security-Policy" content="${csp}">`);
  const bytes = Buffer.byteLength(html);
  if (bytes > 2 * 1024 * 1024) throw Object.assign(new Error('Compiled preview exceeds the 2 MiB artifact limit'), { code: 'artifact_too_large' });
  fs.writeFileSync(path.join(workspace, 'artifact.html'), html, { flag: 'wx' });
  result.ok = true;
  result.stats = { sourceFiles: Object.keys(input.files).length, artifactBytes: bytes };
} catch (error) {
  result.diagnostics.push(diagnostic(error?.code === 'generated_source_invalid' || error?.code === 'forge_path_invalid' ? 'validation' : 'compile', error));
}
fs.writeFileSync(resultPath, JSON.stringify(result));
