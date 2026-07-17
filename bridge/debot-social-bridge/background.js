const DEFAULT_SERVER_BASE = 'https://radar.217-116-171-250.sslip.io/robinhood-radar/api/social';
const SOCIAL_API_PATH = '/robinhood-radar/api/social';
const ALLOWED_SERVER_ORIGINS = new Set([
  'http://217.116.171.250',
  'https://radar.217-116-171-250.sslip.io'
]);
let localConfig = {};

function normalizeServerBase(value) {
  const url = new URL(String(value || DEFAULT_SERVER_BASE));
  const pathname = url.pathname.replace(/\/$/, '');
  if (!ALLOWED_SERVER_ORIGINS.has(url.origin) || pathname !== SOCIAL_API_PATH || url.search || url.hash) {
    throw new Error('Social server must use the configured Robinhood Radar API');
  }
  return `${url.origin}${SOCIAL_API_PATH}`;
}

function text(value, maximum = 100_000) {
  return String(value ?? '').slice(0, maximum);
}

function number(value) {
  const result = Number(value);
  return Number.isFinite(result) ? result : 0;
}

function safeMedia(value) {
  return (Array.isArray(value) ? value : []).slice(0, 12).map((item) => ({
    type: text(item?.type, 20),
    url: text(item?.url, 2_000),
    previewUrl: text(item?.previewUrl, 2_000)
  }));
}

function safeContracts(value) {
  return (Array.isArray(value) ? value : []).slice(0, 32).map((item) => ({
    address: text(item?.address, 100),
    chain: text(item?.chain, 20)
  }));
}

function safePost(value) {
  const post = value && typeof value === 'object' ? value : {};
  const author = post.author && typeof post.author === 'object' ? post.author : {};
  return {
    source: text(post.source, 40),
    externalId: text(post.externalId, 240),
    kind: text(post.kind, 20),
    author: {
      id: text(author.id, 240),
      handle: text(author.handle, 240),
      name: text(author.name, 500),
      avatarUrl: text(author.avatarUrl, 2_000),
      followersCount: number(author.followersCount)
    },
    content: text(post.content),
    translatedContent: text(post.translatedContent),
    url: text(post.url, 2_000),
    media: safeMedia(post.media),
    contractAddresses: safeContracts(post.contractAddresses),
    chainTags: (Array.isArray(post.chainTags) ? post.chainTags : []).slice(0, 20).map((item) => text(item, 20)),
    replyToExternalId: text(post.replyToExternalId, 240),
    quotedExternalId: text(post.quotedExternalId, 240),
    repostExternalId: text(post.repostExternalId, 240),
    publishedAt: number(post.publishedAt),
    receivedAt: number(post.receivedAt),
    sourceUpdatedAt: number(post.sourceUpdatedAt),
    deleted: post.deleted === true,
    deletedAt: post.deletedAt === null || post.deletedAt === undefined ? null : number(post.deletedAt),
    feedSources: (Array.isArray(post.feedSources) ? post.feedSources : []).slice(0, 3).map((item) => text(item, 20))
  };
}

function safeWatchAccount(value) {
  const account = value && typeof value === 'object' ? value : {};
  const metadata = account.metadata && typeof account.metadata === 'object' ? account.metadata : {};
  return {
    platform: text(account.platform, 40),
    accountKey: text(account.accountKey, 240),
    handle: text(account.handle, 240),
    name: text(account.name, 500),
    url: text(account.url, 2_000),
    remoteId: text(account.remoteId, 240),
    metadata: {
      hotSubscribeId: metadata.hotSubscribeId === null || metadata.hotSubscribeId === undefined
        ? null
        : text(metadata.hotSubscribeId, 240),
      monitorLevel: text(metadata.monitorLevel, 120)
    }
  };
}

function safeHeartbeat(value) {
  const heartbeat = value && typeof value === 'object' ? value : {};
  return {
    bridgeId: text(heartbeat.bridgeId, 240),
    version: text(heartbeat.version, 120),
    sessionId: text(heartbeat.sessionId, 240),
    capabilities: (Array.isArray(heartbeat.capabilities) ? heartbeat.capabilities : [])
      .slice(0, 50)
      .map((item) => text(item, 120)),
    error: redactSensitiveText(heartbeat.error)
  };
}

function redactSensitiveText(value) {
  return text(value, 2_000)
    .replace(/\b(Bearer)\s+[^\s,;]+/gi, '$1 [redacted]')
    .replace(/\b(sub_token|access_token|refresh_token|auth_token|session_token|authorization|cookie|password|secret)\b\s*[:=]\s*[^\s,;]+/gi, '$1=[redacted]');
}

try {
  localConfig = (await import('./config.local.js')).default || {};
} catch {
  // config.local.js is intentionally absent from Git and optional at runtime.
}

async function settings() {
  const saved = await chrome.storage.local.get(['serverBase', 'bridgeToken']);
  let serverBase;
  try {
    serverBase = normalizeServerBase(saved.serverBase || localConfig.serverBase || DEFAULT_SERVER_BASE);
  } catch {
    serverBase = DEFAULT_SERVER_BASE;
  }
  return {
    serverBase,
    bridgeToken: String(saved.bridgeToken || localConfig.bridgeToken || '').trim()
  };
}

async function saveSettings(next) {
  const current = await settings();
  const value = {
    serverBase: normalizeServerBase(next.serverBase || current.serverBase || DEFAULT_SERVER_BASE),
    bridgeToken: String(next.bridgeToken ?? current.bridgeToken ?? '').trim()
  };
  await chrome.storage.local.set(value);
  await updateBadge(value.bridgeToken ? 'ON' : '?', value.bridgeToken ? '#16834b' : '#bd8121');
  return { ...value, bridgeToken: value.bridgeToken ? 'configured' : '' };
}

async function updateBadge(text, color) {
  try {
    await chrome.action.setBadgeText({ text });
    await chrome.action.setBadgeBackgroundColor({ color });
  } catch {
    // Badge support is not required for bridge operation.
  }
}

async function socialRequest(path, { method = 'GET', body = null } = {}) {
  const config = await settings();
  if (!config.bridgeToken) throw new Error('Bridge token is not configured');
  const normalizedPath = String(path || '').startsWith('/') ? String(path) : `/${path}`;
  const response = await fetch(`${config.serverBase}${normalizedPath}`, {
    method,
    headers: {
      accept: 'application/json',
      authorization: `Bearer ${config.bridgeToken}`,
      ...(body === null ? {} : { 'content-type': 'application/json' })
    },
    ...(body === null ? {} : { body: JSON.stringify(body) })
  });
  const text = await response.text();
  let payload = {};
  try {
    payload = text ? JSON.parse(text) : {};
  } catch {
    payload = { error: text || `HTTP ${response.status}` };
  }
  if (!response.ok) throw new Error(payload.error || payload.message || `HTTP ${response.status}`);
  await updateBadge('ON', '#16834b');
  return payload;
}

async function handleBridgePayload(message) {
  if (message.type === 'heartbeat') {
    return socialRequest('/bridge/heartbeat', { method: 'POST', body: safeHeartbeat(message.payload) });
  }
  if (message.type === 'posts') {
    const posts = Array.isArray(message.payload?.posts)
      ? message.payload.posts.map(safePost).filter((post) => post.externalId)
      : [];
    if (!posts.length) return { ok: true, skipped: true };
    return socialRequest('/bridge/posts', { method: 'POST', body: { posts: posts.slice(0, 200) } });
  }
  if (message.type === 'watchlist') {
    const accounts = Array.isArray(message.payload?.accounts)
      ? message.payload.accounts.map(safeWatchAccount).filter((account) => account.handle)
      : [];
    return socialRequest('/bridge/watchlist/snapshot', {
      method: 'POST',
      body: { accounts: accounts.slice(0, 5_000), complete: true }
    });
  }
  throw new Error('Unsupported bridge payload');
}

chrome.runtime.onMessage.addListener((message, sender, sendResponse) => {
  const run = async () => {
    if (!message || typeof message !== 'object') throw new Error('Invalid bridge message');
    if (message.source === 'debot-social-relay' && ['heartbeat', 'posts', 'watchlist'].includes(message.type)) {
      return handleBridgePayload(message);
    }
    if (message.source === 'debot-social-relay' && message.type === 'poll-commands') {
      return socialRequest('/bridge/commands?limit=50');
    }
    if (message.source === 'debot-social-relay' && message.type === 'command-result') {
      const commandId = Number(message.payload?.commandId);
      if (!Number.isSafeInteger(commandId) || commandId <= 0) throw new Error('Invalid command id');
      return socialRequest(`/bridge/commands/${commandId}/ack`, {
        method: 'POST',
        body: {
          success: message.payload?.success === true,
          error: redactSensitiveText(message.payload?.error),
          remoteId: String(message.payload?.remoteId || '')
        }
      });
    }
    if (message.source === 'robinhood-radar-content' && message.type === 'api') {
      const path = String(message.command?.path || '');
      if (!/^\/watchlist(?:\/batch|\/\d+)?$/.test(path)) throw new Error('Radar requested a disallowed social route');
      const method = String(message.command?.method || 'GET').toUpperCase();
      if (!['POST', 'DELETE'].includes(method)) throw new Error('Radar requested a disallowed method');
      return socialRequest(path, { method, body: message.command?.body ?? null });
    }
    if (message.source === 'bridge-options' && message.type === 'get-settings') {
      const value = await settings();
      return { ...value, bridgeToken: value.bridgeToken ? 'configured' : '' };
    }
    if (message.source === 'bridge-options' && message.type === 'save-settings') {
      return saveSettings(message.payload || {});
    }
    throw new Error('Unsupported bridge message');
  };
  void run().then((payload) => sendResponse({ ok: true, payload })).catch(async (error) => {
    await updateBadge('!', '#b33a45');
    sendResponse({ ok: false, error: error instanceof Error ? error.message : String(error) });
  });
  return true;
});

void settings().then((value) => updateBadge(value.bridgeToken ? 'ON' : '?', value.bridgeToken ? '#16834b' : '#bd8121'));
