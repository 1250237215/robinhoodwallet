function announceReady() {
  window.postMessage({ source: 'robinhood-social-bridge', type: 'ready' }, window.location.origin);
}

window.addEventListener('message', (event) => {
  if (event.source !== window || event.origin !== window.location.origin) return;
  const message = event.data;
  if (!message || message.source !== 'robinhood-radar' || message.type !== 'social-command') return;
  chrome.runtime.sendMessage({
    source: 'robinhood-radar-content',
    type: 'api',
    command: message.command
  }).then((result) => {
    window.postMessage({
      source: 'robinhood-social-bridge',
      type: 'response',
      requestId: message.requestId,
      ok: result?.ok === true,
      payload: result?.payload || {},
      error: result?.error || ''
    }, window.location.origin);
  }).catch((error) => {
    window.postMessage({
      source: 'robinhood-social-bridge',
      type: 'response',
      requestId: message.requestId,
      ok: false,
      error: error instanceof Error ? error.message : String(error)
    }, window.location.origin);
  });
});

announceReady();
window.addEventListener('DOMContentLoaded', announceReady, { once: true });
setTimeout(announceReady, 1_000);
