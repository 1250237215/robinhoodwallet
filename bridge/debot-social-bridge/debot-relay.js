const PAGE_SOURCE = 'debot-social-page';
const RELAY_SOURCE = 'debot-social-relay';
const BACKGROUND_SOURCE = 'debot-social-background';
const FORCE_POLL_TIMEOUT_MS = 20_000;
const FORCE_POLL_ERROR_TYPES = new Set(['AUTH', 'TIMEOUT', 'NETWORK', 'DEBOT']);
const pendingForcePolls = new Map();
let commandPollBusy = false;

function sendToBackground(type, payload) {
  return chrome.runtime.sendMessage({ source: RELAY_SOURCE, type, payload });
}

function postToPage(type, value = {}) {
  window.postMessage({ source: RELAY_SOURCE, type, ...value }, window.location.origin);
}

function acknowledgePostDelivery(deliveryId, ok) {
  if (!deliveryId) return;
  postToPage('posts-delivery-result', { payload: { deliveryId, ok: ok === true } });
}

function forwardPosts(payload) {
  const deliveryId = String(payload?.deliveryId || '');
  void sendToBackground('posts', payload).then((result) => {
    acknowledgePostDelivery(deliveryId, result?.ok === true && result.payload?.durable === true);
  }).catch(() => {
    acknowledgePostDelivery(deliveryId, false);
  });
}

function requestPageForcePoll(requestId) {
  const existing = pendingForcePolls.get(requestId);
  if (existing) return existing.promise;

  let resolveRequest;
  const promise = new Promise((resolve) => {
    resolveRequest = resolve;
  });
  const timeoutId = setTimeout(() => {
    if (pendingForcePolls.get(requestId)?.promise !== promise) return;
    pendingForcePolls.delete(requestId);
    resolveRequest({ ok: false, requestId, errorType: 'PAGE_TIMEOUT' });
  }, FORCE_POLL_TIMEOUT_MS);
  pendingForcePolls.set(requestId, { promise, resolve: resolveRequest, timeoutId });
  postToPage('force-poll', { requestId });
  return promise;
}

window.addEventListener('message', (event) => {
  if (event.source !== window || event.origin !== window.location.origin) return;
  const message = event.data;
  if (!message || message.source !== PAGE_SOURCE) return;
  if (message.type === 'posts') {
    forwardPosts(message.payload);
    return;
  }
  if (['heartbeat', 'watchlist'].includes(message.type)) {
    void sendToBackground(message.type, message.payload).catch(() => {});
    return;
  }
  if (message.type === 'force-poll-result') {
    const requestId = typeof message.payload?.requestId === 'string' ? message.payload.requestId : '';
    const pending = pendingForcePolls.get(requestId);
    if (!pending) return;
    clearTimeout(pending.timeoutId);
    pendingForcePolls.delete(requestId);
    pending.resolve({
      ok: message.payload?.ok === true,
      requestId,
      ...(message.payload?.ok === true
        ? {}
        : { errorType: FORCE_POLL_ERROR_TYPES.has(message.payload?.errorType) ? message.payload.errorType : 'DEBOT' })
    });
    return;
  }
  if (message.type === 'command-result') {
    void sendToBackground('command-result', message.payload).catch(() => {});
  }
});

async function pollCommands() {
  if (commandPollBusy) return;
  commandPollBusy = true;
  try {
    const result = await sendToBackground('poll-commands', {});
    if (!result?.ok) return;
    const commands = Array.isArray(result.payload?.commands) ? result.payload.commands : [];
    for (const command of commands) {
      postToPage('command', { command });
    }
  } catch {
    // The next poll retries after the bridge or VPS reconnects.
  } finally {
    commandPollBusy = false;
  }
}

if (chrome.runtime.onMessage?.addListener) {
  chrome.runtime.onMessage.addListener((message, sender, sendResponse) => {
    if (!message || message.source !== BACKGROUND_SOURCE || message.type !== 'force-poll') return false;
    if (sender?.id && chrome.runtime.id && sender.id !== chrome.runtime.id) return false;
    const requestId = typeof message.requestId === 'string' ? message.requestId : '';
    if (!requestId.trim()) {
      sendResponse({ ok: false, requestId, errorType: 'DEBOT' });
      return false;
    }
    void pollCommands();
    void requestPageForcePoll(requestId).then(sendResponse);
    return true;
  });
}

void pollCommands();
setInterval(() => void pollCommands(), 2_000);
