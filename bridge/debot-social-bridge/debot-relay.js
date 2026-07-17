const PAGE_SOURCE = 'debot-social-page';
const RELAY_SOURCE = 'debot-social-relay';
let commandPollBusy = false;

function sendToBackground(type, payload) {
  return chrome.runtime.sendMessage({ source: RELAY_SOURCE, type, payload });
}

window.addEventListener('message', (event) => {
  if (event.source !== window || event.origin !== window.location.origin) return;
  const message = event.data;
  if (!message || message.source !== PAGE_SOURCE) return;
  if (['heartbeat', 'posts', 'watchlist'].includes(message.type)) {
    void sendToBackground(message.type, message.payload).catch(() => {});
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
      window.postMessage({ source: RELAY_SOURCE, type: 'command', command }, window.location.origin);
    }
  } catch {
    // The next poll retries after the bridge or VPS reconnects.
  } finally {
    commandPollBusy = false;
  }
}

void pollCommands();
setInterval(() => void pollCommands(), 2_000);
