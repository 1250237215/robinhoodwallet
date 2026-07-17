async function announceReady() {
  let configured = false;
  try {
    const result = await chrome.runtime.sendMessage({
      source: 'robinhood-radar-content',
      type: 'status'
    });
    configured = result?.ok === true && result?.payload?.configured === true;
  } catch {
    // The Radar page can still use its browser-local pairing token.
  }
  window.postMessage({
    source: 'robinhood-social-bridge',
    type: 'ready',
    configured
  }, window.location.origin);
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

void announceReady();
window.addEventListener('DOMContentLoaded', () => void announceReady(), { once: true });
setTimeout(() => void announceReady(), 1_000);
