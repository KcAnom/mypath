import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import fs from 'node:fs';
import net from 'node:net';
import os from 'node:os';
import path from 'node:path';

const chrome = process.env.CHROME_PATH || ['/Applications/Google Chrome.app/Contents/MacOS/Google Chrome', '/Applications/Chromium.app/Contents/MacOS/Chromium', '/usr/bin/google-chrome', '/usr/bin/chromium'].find(fs.existsSync);
if (!chrome) throw new Error('Existing Chrome/Chromium is required for the headless interaction regression');
const freePort = () => new Promise((resolve) => { const socket = net.createServer(); socket.listen(0, '127.0.0.1', () => { const address = socket.address(); if (!address || typeof address === 'string') throw new Error('Unable to allocate interaction-test port'); const port = address.port; socket.close(() => resolve(port)); }); });
const wait = (ms) => new Promise((resolve) => setTimeout(resolve, ms));
const port = await freePort(); const base = `http://127.0.0.1:${port}`; const data = fs.mkdtempSync(path.join(os.tmpdir(), 'mypath-ui-data-')); const profile = fs.mkdtempSync(path.join(os.tmpdir(), 'mypath-chrome-')); const instanceNonce = 'headless-instance-renewal';
const server = spawn(process.execPath, ['server/index.js'], { cwd: process.cwd(), env: { ...process.env, MYPATH_API_PORT: String(port), MYPATH_DATA_DIR: data, MYPATH_INSTANCE_NONCE: instanceNonce, MYPATH_SESSION_TTL_MS: '750' }, stdio: ['ignore', 'pipe', 'pipe'] });
let serverError = ''; server.stderr.on('data', (chunk) => { serverError += chunk; });
let browser;
async function stop(child) { if (child?.exitCode == null) { child.kill('SIGTERM'); await Promise.race([new Promise((resolve) => child.once('exit', resolve)), wait(2_000)]); } }
try {
  for (let index = 0; index < 100; index++) { try { if ((await fetch(`${base}/health`)).ok) break; } catch {} if (index === 99) throw new Error(`Server did not start: ${serverError}`); await wait(50); }
  browser = spawn(chrome, ['--headless=new', '--disable-gpu', '--no-first-run', '--no-default-browser-check', '--remote-debugging-port=0', `--user-data-dir=${profile}`, 'about:blank'], { stdio: 'ignore' });
  const activePort = path.join(profile, 'DevToolsActivePort'); for (let index = 0; !fs.existsSync(activePort); index++) { if (index === 100) throw new Error('Chrome DevTools port was not created'); await wait(50); }
  const debugPort = fs.readFileSync(activePort, 'utf8').split('\n')[0];
  let targets; for (let index = 0; index < 50; index++) { try { targets = await fetch(`http://127.0.0.1:${debugPort}/json/list`).then((value) => value.json()); if (targets.length) break; } catch {} await wait(50); }
  const target = targets.find((item) => item.type === 'page'); assert.ok(target?.webSocketDebuggerUrl, 'Chrome page target exists');
  const socket = new WebSocket(target.webSocketDebuggerUrl); await new Promise((resolve, reject) => { socket.addEventListener('open', resolve, { once: true }); socket.addEventListener('error', reject, { once: true }); });
  let requestId = 0; const pending = new Map(); const exceptions = [];
  socket.addEventListener('message', (message) => { const value = JSON.parse(message.data); if (value.id && pending.has(value.id)) { const entry = pending.get(value.id); pending.delete(value.id); value.error ? entry.reject(new Error(value.error.message)) : entry.resolve(value.result); } else if (value.method === 'Runtime.exceptionThrown') exceptions.push(value.params.exceptionDetails.text || value.params.exceptionDetails.exception?.description || 'page exception'); });
  const command = (method, params = {}) => new Promise((resolve, reject) => { const id = ++requestId; pending.set(id, { resolve, reject }); socket.send(JSON.stringify({ id, method, params })); });
  const evaluate = async (expression) => { const response = await command('Runtime.evaluate', { expression, awaitPromise: true, returnByValue: true }); if (response.exceptionDetails) throw new Error(response.exceptionDetails.exception?.description || response.exceptionDetails.text); return response.result.value; };
  const until = async (expression, label) => { for (let index = 0; index < 120; index++) { if (await evaluate(`Boolean(${expression})`)) return; await wait(50); } throw new Error(`Timed out waiting for ${label}`); };
  await command('Runtime.enable'); await command('Page.enable'); await command('Page.navigate', { url: `${base}/files?instanceNonce=${instanceNonce}` });
  await until(`document.querySelector('.floating-create')?.textContent.includes('New project')`, 'first-run Projects UI');
  assert.equal(await evaluate(`document.querySelectorAll('#app').length`), 1, 'React must not render a nested duplicate #app shell');
  assert.equal(await evaluate(`document.querySelector('#app > .app-shell') !== null`), true, 'app shell is a classed child of the mount point');
  assert.ok(await evaluate(`document.querySelector('.main').getBoundingClientRect().width`), 'main content has measurable width');
  assert.ok(await evaluate(`document.querySelector('.main').getBoundingClientRect().width > 400`), 'main content does not collapse into the sidebar grid column');
  assert.equal(await evaluate(`typeof window.prompt + ',' + typeof window.confirm + ',' + typeof window.alert`), 'function,function,function', 'browser dialogs may exist but UI must not call them');
  await evaluate(`document.querySelector('.floating-create').click()`); await until(`document.querySelector('[role="dialog"] input') !== null`, 'in-app project form');
  await evaluate(`(()=>{const input=document.querySelector('[role="dialog"] input');const setter=Object.getOwnPropertyDescriptor(HTMLInputElement.prototype,'value').set;setter.call(input,'Headless interaction project');input.dispatchEvent(new Event('input',{bubbles:true}));return true})()`);
  await evaluate(`document.querySelector('[role="dialog"] form').requestSubmit()`); await until(`location.pathname.startsWith('/projects/') && document.querySelector('[aria-label="Project design canvas"]')`, 'created project canvas');
  assert.equal(await evaluate(`location.search`), '', 'SPA navigation removes the nonce from the current route');
  await wait(900); // force the short-lived session to renew after the nonce left location.search
  await evaluate(`document.querySelector('a[href="/files"]').click()`); await until(`document.querySelector('.card button:not(.primary)')?.textContent === 'Rename'`, 'project route navigation after session renewal');
  assert.equal(await evaluate(`document.body.textContent.includes('Desktop instance nonce is invalid')`), false, 'renewal reuses the module-captured nonce');
  await evaluate(`Array.from(document.querySelectorAll('.card button')).find(b=>b.textContent==='Rename').click()`); await until(`document.querySelector('[role="dialog"]')?.textContent.includes('Rename project')`, 'rename modal');
  await evaluate(`document.dispatchEvent(new KeyboardEvent('keydown',{key:'Escape',bubbles:true}))`); await until(`!document.querySelector('[role="dialog"]')`, 'Escape closes modal');
  await evaluate(`Array.from(document.querySelectorAll('.card button')).find(b=>b.textContent==='Rename').click()`); await until(`document.querySelector('[role="dialog"] input') !== null`, 'rename modal reopens');
  await evaluate(`(()=>{const input=document.querySelector('[role="dialog"] input');const setter=Object.getOwnPropertyDescriptor(HTMLInputElement.prototype,'value').set;setter.call(input,'Renamed by Chrome');input.dispatchEvent(new Event('input',{bubbles:true}));document.querySelector('[role="dialog"] form').requestSubmit();return true})()`); await until(`document.body.textContent.includes('Renamed by Chrome') && !document.querySelector('[role="dialog"]')`, 'rename action success');
  await evaluate(`document.querySelector('a[href="/chat"]').click()`); await until(`document.body.textContent.includes('Choose a project for chat and generation')`, 'project chat chooser route');
  assert.deepEqual(exceptions, [], `No page exceptions expected: ${exceptions.join('\n')}`);
  socket.close(); console.log('Headless Chrome interaction passed: first-run modal create → canvas, post-route session renewal, Escape/rename modal actions, and project-chat route; no page exceptions');
} finally { await stop(browser); await stop(server); fs.rmSync(data, { recursive: true, force: true }); fs.rmSync(profile, { recursive: true, force: true }); }
