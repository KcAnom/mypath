const pending = new Map();
const STYLE_ALLOWLIST = ['color','background-color','font-family','font-size','font-weight','font-style','line-height','letter-spacing','text-align','text-decoration','display','flex-direction','justify-content','align-items','gap','padding','padding-top','padding-right','padding-bottom','padding-left','margin','margin-top','margin-right','margin-bottom','margin-left','border','border-width','border-style','border-color','border-radius','width','max-width','min-width','height','max-height','min-height','object-fit','opacity','box-shadow'];

function installSelector(properties) {
  if (window.__mypathCaptureActive) return false;
  window.__mypathCaptureActive = true; let selected = null;
  const overlay = document.createElement('div'); Object.assign(overlay.style, { position: 'fixed', zIndex: '2147483647', pointerEvents: 'none', border: '2px solid #2563eb', background: 'rgba(37,99,235,.12)', display: 'none' }); document.documentElement.append(overlay);
  const move = (event) => { selected = event.target instanceof Element ? event.target : null; if (!selected || selected === overlay) return; const box = selected.getBoundingClientRect(); Object.assign(overlay.style, { display: 'block', left: `${box.left}px`, top: `${box.top}px`, width: `${box.width}px`, height: `${box.height}px` }); };
  const cleanup = () => { removeEventListener('mousemove', move, true); removeEventListener('click', choose, true); removeEventListener('keydown', key, true); overlay.remove(); window.__mypathCaptureActive = false; };
  const key = (event) => { if (event.key === 'Escape') { cleanup(); chrome.runtime.sendMessage({ type: 'capture-cancelled' }); } };
  const choose = (event) => { event.preventDefault(); event.stopPropagation(); if (!selected || selected === overlay) return; const style = getComputedStyle(selected); const computedStyles = Object.fromEntries(properties.map((name) => [name, style.getPropertyValue(name).trim()]).filter(([, value]) => value)); const html = selected.outerHTML; const pageUrl = location.href; cleanup(); chrome.runtime.sendMessage({ type: 'capture-selected', html, pageUrl, computedStyles }); };
  addEventListener('mousemove', move, true); addEventListener('click', choose, true); addEventListener('keydown', key, true); return true;
}

chrome.runtime.onMessage.addListener((message, sender, respond) => {
  if (message?.type === 'start-capture') {
    pending.set(message.tabId, { server: message.server, ticketId: message.ticketId, token: message.token, windowId: message.windowId });
    chrome.scripting.executeScript({ target: { tabId: message.tabId }, func: installSelector, args: [STYLE_ALLOWLIST] }).then(() => respond({ ok: true }), (error) => { pending.delete(message.tabId); respond({ ok: false, error: error.message }); }); return true;
  }
  if (message?.type === 'capture-cancelled' && sender.tab?.id) { pending.delete(sender.tab.id); return; }
  if (message?.type === 'capture-selected' && sender.tab?.id) {
    const tabId = sender.tab.id; const request = pending.get(tabId); pending.delete(tabId); if (!request) return;
    (async () => {
      try {
        const screenshot = await chrome.tabs.captureVisibleTab(request.windowId, { format: 'png' });
        const response = await fetch(`${request.server}/api/v1/capture-tickets/${encodeURIComponent(request.ticketId)}/submission`, { method: 'POST', headers: { Authorization: `Bearer ${request.token}`, 'Content-Type': 'application/json', Accept: 'application/json' }, body: JSON.stringify({ pageUrl: message.pageUrl, html: message.html, computedStyles: message.computedStyles, screenshot, assetIds: [] }) });
        const body = await response.json(); if (!response.ok) throw new Error(body?.error?.message || `MyPath returned ${response.status}`);
        await chrome.notifications?.create?.({ type: 'basic', iconUrl: 'icon128.png', title: 'Captured into MyPath', message: 'The selected element was stored as inert, sanitized reference content.' });
      } catch (error) { console.error('MyPath capture failed:', error); }
    })();
  }
});
