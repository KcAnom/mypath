const $ = (id) => document.getElementById(id);
chrome.storage.local.get(['mypathServer'], ({ mypathServer }) => { if (mypathServer) $('server').value = mypathServer; });
$('capture').addEventListener('click', async () => {
  const server = $('server').value.trim().replace(/\/$/, ''); const ticketId = $('ticket').value.trim(); const token = $('token').value.trim();
  if (!/^http:\/\/(?:127\.0\.0\.1|localhost):\d+$/.test(server) || !ticketId || !token) { $('status').textContent = 'Enter a loopback MyPath URL and the complete ticket.'; return; }
  await chrome.storage.local.set({ mypathServer: server });
  const [tab] = await chrome.tabs.query({ active: true, currentWindow: true });
  if (!tab?.id || !/^https:\/\//.test(tab.url || '')) { $('status').textContent = 'Open the HTTPS page named by the ticket first.'; return; }
  const response = await chrome.runtime.sendMessage({ type: 'start-capture', tabId: tab.id, windowId: tab.windowId, server, ticketId, token });
  $('status').textContent = response?.ok ? 'Click the element to capture. Press Escape to cancel.' : (response?.error || 'Unable to start capture.');
});
