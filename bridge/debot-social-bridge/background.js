import { createPostOutbox } from './post-outbox.js';

const DEFAULT_SERVER_BASE = 'https://radar.217-116-171-250.sslip.io/robinhood-radar/api/social';
const SOCIAL_API_PATH = '/robinhood-radar/api/social';
const DEBOT_URL = 'https://debot.ai/';
const DEBOT_URL_PATTERN = 'https://debot.ai/*';
const RECOVERY_ALARM = 'debot-social-bridge-recovery';
const RECOVERY_STATE_KEY = 'debotSocialBridgeRecoveryV1';
const RECOVERY_PERIOD_MINUTES = 0.5;
const RECOVERY_LOAD_GRACE_MS = 45_000;
const RECOVERY_PROBE_TIMEOUT_MS = 25_000;
const RECOVERY_RELOAD_BACKOFF_MS = [60_000, 5 * 60_000, 15 * 60_000, 30 * 60_000];
const SOCIAL_REQUEST_TIMEOUT_MS = 15_000;
const ALLOWED_SERVER_ORIGINS = new Set([
  'https://radar.217-116-171-250.sslip.io'
]);
const storageReady = Promise.all([
  chrome.storage.local.setAccessLevel({ accessLevel: 'TRUSTED_CONTEXTS' }),
  chrome.storage.session.setAccessLevel({ accessLevel: 'TRUSTED_CONTEXTS' })
]);
const postOutbox = createPostOutbox({ storage: chrome.storage.local });
let settingsWriteQueue = Promise.resolve();
let postFlushInFlight = null;
let postFlushRequested = false;
let bridgeMaintenanceInFlight = null;

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

async function settings() {
  await storageReady;
  const saved = await chrome.storage.local.get(['serverBase', 'bridgeToken']);
  let serverBase;
  try {
    serverBase = normalizeServerBase(saved.serverBase || DEFAULT_SERVER_BASE);
  } catch {
    serverBase = DEFAULT_SERVER_BASE;
  }
  return {
    serverBase,
    bridgeToken: String(saved.bridgeToken || '').trim()
  };
}

function serializeSettingsWrite(operation) {
  const result = settingsWriteQueue.then(operation, operation);
  settingsWriteQueue = result.catch(() => {});
  return result;
}

function publicSettings(value) {
  return { ...value, bridgeToken: value.bridgeToken ? 'configured' : '' };
}

function saveSettings(next) {
  return serializeSettingsWrite(async () => {
    const current = await settings();
    const value = {
      serverBase: normalizeServerBase(next.serverBase || current.serverBase || DEFAULT_SERVER_BASE),
      bridgeToken: String(next.bridgeToken ?? current.bridgeToken ?? '').trim()
    };
    await chrome.storage.local.set(value);
    await updateBadge(value.bridgeToken ? 'ON' : '?', value.bridgeToken ? '#16834b' : '#bd8121');
    return publicSettings(value);
  });
}

function migrateLocalSettings(next) {
  return serializeSettingsWrite(async () => {
    await storageReady;
    const saved = await chrome.storage.local.get(['serverBase', 'bridgeToken']);
    const existingToken = String(saved.bridgeToken || '').trim();
    let serverBase;
    try {
      serverBase = normalizeServerBase(saved.serverBase || next.serverBase || DEFAULT_SERVER_BASE);
    } catch {
      serverBase = DEFAULT_SERVER_BASE;
    }
    if (existingToken) return publicSettings({ serverBase, bridgeToken: existingToken });
    const bridgeToken = String(next.bridgeToken || '').trim();
    if (!bridgeToken) throw new Error('Bridge token is required');
    const value = { serverBase, bridgeToken };
    await chrome.storage.local.set(value);
    await updateBadge('ON', '#16834b');
    return publicSettings(value);
  });
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
  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), SOCIAL_REQUEST_TIMEOUT_MS);
  let response;
  let responseText;
  try {
    response = await fetch(`${config.serverBase}${normalizedPath}`, {
      method,
      signal: controller.signal,
      headers: {
        accept: 'application/json',
        authorization: `Bearer ${config.bridgeToken}`,
        ...(body === null ? {} : { 'content-type': 'application/json' })
      },
      ...(body === null ? {} : { body: JSON.stringify(body) })
    });
    responseText = await response.text();
  } catch (error) {
    if (error?.name === 'AbortError') throw new Error('Radar social API timed out');
    throw error;
  } finally {
    clearTimeout(timeout);
  }
  let payload = {};
  try {
    payload = responseText ? JSON.parse(responseText) : {};
  } catch {
    payload = { error: responseText || `HTTP ${response.status}` };
  }
  if (!response.ok) throw new Error(payload.error || payload.message || `HTTP ${response.status}`);
  await updateBadge('ON', '#16834b');
  return payload;
}

function flushPostOutbox() {
  if (postFlushInFlight) return postFlushInFlight;
  postFlushRequested = false;
  postFlushInFlight = (async () => {
    await storageReady;
    let sent = 0;
    for (let batchNumber = 0; batchNumber < 5; batchNumber += 1) {
      const batch = await postOutbox.readBatch(200);
      if (!batch.count) break;
      const acknowledgement = await socialRequest('/bridge/posts', {
        method: 'POST',
        body: { posts: batch.records.map((record) => record.post) }
      });
      if (acknowledgement?.ok !== true) {
        throw new Error('Radar social API did not acknowledge the post batch');
      }
      await postOutbox.acknowledge(batch.records.map((record) => record.key));
      sent += batch.count;
      if (!batch.remaining) break;
    }
    return { ok: true, sent, ...(await postOutbox.stats()) };
  })().catch(async (error) => {
    await updateBadge('!', '#b33a45');
    return { ok: false, error: redactSensitiveText(error instanceof Error ? error.message : String(error)) };
  }).finally(() => {
    postFlushInFlight = null;
    if (postFlushRequested) void flushPostOutbox();
  });
  return postFlushInFlight;
}

function requestPostFlush() {
  if (postFlushInFlight) postFlushRequested = true;
  return flushPostOutbox();
}

async function queuePosts(value) {
  const posts = (Array.isArray(value) ? value : [])
    .map(safePost)
    .filter((post) => post.source && post.externalId)
    .slice(0, 200)
    .sort((left, right) => (left.sourceUpdatedAt || left.publishedAt) - (right.sourceUpdatedAt || right.publishedAt));
  if (!posts.length) return { queued: 0, skipped: true };
  await storageReady;
  const result = await postOutbox.enqueue(posts);
  void requestPostFlush();
  return {
    queued: result.queued,
    added: result.added,
    duplicates: result.duplicates,
    overflow: result.overflow,
    durable: result.overflow === 0
  };
}

async function handleBridgePayload(message) {
  if (message.type === 'heartbeat') {
    return socialRequest('/bridge/heartbeat', { method: 'POST', body: safeHeartbeat(message.payload) });
  }
  if (message.type === 'posts') {
    return queuePosts(message.payload?.posts);
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

function normalizedRecoveryState(value) {
  const state = value && typeof value === 'object' ? value : {};
  return {
    managedTabId: Number.isSafeInteger(Number(state.managedTabId)) ? Number(state.managedTabId) : null,
    createdAt: Math.max(0, number(state.createdAt)),
    lastHealthyAt: Math.max(0, number(state.lastHealthyAt)),
    lastProbeAt: Math.max(0, number(state.lastProbeAt)),
    structuralFailures: Math.max(0, Math.trunc(number(state.structuralFailures))),
    lastReloadAt: Math.max(0, number(state.lastReloadAt)),
    reloadLevel: Math.max(0, Math.trunc(number(state.reloadLevel))),
    lastErrorType: text(state.lastErrorType, 40)
  };
}

async function loadRecoveryState() {
  await storageReady;
  const stored = await chrome.storage.session.get(RECOVERY_STATE_KEY);
  return normalizedRecoveryState(stored?.[RECOVERY_STATE_KEY]);
}

async function saveRecoveryState(state) {
  await storageReady;
  await chrome.storage.session.set({ [RECOVERY_STATE_KEY]: normalizedRecoveryState(state) });
}

function ensureRecoveryAlarm() {
  chrome.alarms.create(RECOVERY_ALARM, { periodInMinutes: RECOVERY_PERIOD_MINUTES });
}

function chooseManagedTab(tabs, managedTabId) {
  return tabs.find((tab) => tab.id === managedTabId)
    || tabs.find((tab) => tab.pinned && !tab.discarded)
    || tabs.find((tab) => !tab.discarded)
    || tabs[0]
    || null;
}

async function findDeBotTabs() {
  const tabs = await chrome.tabs.query({ url: DEBOT_URL_PATTERN });
  return tabs.filter((tab) => Number.isSafeInteger(tab.id));
}

async function probeDeBotTab(tabId, requestId) {
  let timeoutId;
  try {
    return await Promise.race([
      chrome.tabs.sendMessage(tabId, {
        source: 'debot-social-background',
        type: 'force-poll',
        requestId
      }),
      new Promise((resolve) => {
        timeoutId = setTimeout(() => {
          resolve({ ok: false, requestId, errorType: 'PAGE_TIMEOUT' });
        }, RECOVERY_PROBE_TIMEOUT_MS);
      })
    ]);
  } finally {
    clearTimeout(timeoutId);
  }
}

async function createManagedDeBotTab(state, now) {
  const existing = await findDeBotTabs();
  if (existing.length) return chooseManagedTab(existing, state.managedTabId);
  const created = await chrome.tabs.create({ url: DEBOT_URL, active: false, pinned: true });
  if (!Number.isSafeInteger(created?.id)) throw new Error('Chrome did not return the DeBot tab id');
  await chrome.tabs.update(created.id, { autoDiscardable: false }).catch(() => {});
  await saveRecoveryState({
    ...state,
    managedTabId: created.id,
    createdAt: now,
    structuralFailures: 0,
    lastProbeAt: now,
    lastErrorType: ''
  });
  return created;
}

async function reloadManagedTab(tab, state, now, errorType) {
  const reloadIndex = Math.min(state.reloadLevel, RECOVERY_RELOAD_BACKOFF_MS.length - 1);
  const cooldown = RECOVERY_RELOAD_BACKOFF_MS[reloadIndex];
  if (state.lastReloadAt && now - state.lastReloadAt < cooldown) {
    await saveRecoveryState({ ...state, lastProbeAt: now, lastErrorType: errorType });
    return { ok: false, action: 'reload-backoff', errorType };
  }
  await chrome.tabs.reload(tab.id);
  await saveRecoveryState({
    ...state,
    managedTabId: tab.id,
    createdAt: now,
    lastProbeAt: now,
    structuralFailures: 0,
    lastReloadAt: now,
    reloadLevel: Math.min(state.reloadLevel + 1, RECOVERY_RELOAD_BACKOFF_MS.length - 1),
    lastErrorType: errorType
  });
  return { ok: false, action: 'reloaded', errorType };
}

async function maintainDeBotConnection() {
  const config = await settings();
  if (!config.bridgeToken) return { ok: false, action: 'unconfigured' };

  const now = Date.now();
  let state = await loadRecoveryState();
  const tabs = await findDeBotTabs();
  const tab = tabs.length ? chooseManagedTab(tabs, state.managedTabId) : await createManagedDeBotTab(state, now);
  if (!tab) return { ok: false, action: 'missing-tab' };
  if (!tabs.length) state = await loadRecoveryState();
  await chrome.tabs.update(tab.id, { autoDiscardable: false }).catch(() => {});

  const requestId = `recovery-${now}-${Math.random().toString(36).slice(2, 10)}`;
  let result;
  try {
    result = await probeDeBotTab(tab.id, requestId);
  } catch {
    result = { ok: false, errorType: 'NO_RECEIVER' };
  }

  if (result?.ok === true && result.requestId === requestId) {
    await saveRecoveryState({
      ...state,
      managedTabId: tab.id,
      createdAt: state.managedTabId === tab.id ? state.createdAt : 0,
      lastHealthyAt: now,
      lastProbeAt: now,
      structuralFailures: 0,
      reloadLevel: 0,
      lastErrorType: ''
    });
    return { ok: true, action: 'healthy' };
  }

  const errorType = text(result?.errorType || 'PAGE_TIMEOUT', 40).toUpperCase();
  if (['AUTH', 'TIMEOUT', 'NETWORK', 'DEBOT'].includes(errorType)) {
    await saveRecoveryState({
      ...state,
      managedTabId: tab.id,
      lastProbeAt: now,
      structuralFailures: 0,
      lastErrorType: errorType
    });
    return { ok: false, action: 'retry', errorType };
  }

  const structuralFailures = state.structuralFailures + 1;
  const withinLoadGrace = state.createdAt > 0
    && now - state.createdAt < RECOVERY_LOAD_GRACE_MS;
  const nextState = {
    ...state,
    managedTabId: tab.id,
    lastProbeAt: now,
    structuralFailures,
    lastErrorType: errorType
  };
  if (!tab.discarded && (withinLoadGrace || structuralFailures < 2)) {
    await saveRecoveryState(nextState);
    return { ok: false, action: withinLoadGrace ? 'loading-grace' : 'probe-failed', errorType };
  }
  return reloadManagedTab(tab, nextState, now, errorType);
}

function runBridgeMaintenance() {
  if (bridgeMaintenanceInFlight) return bridgeMaintenanceInFlight;
  bridgeMaintenanceInFlight = Promise.allSettled([
    flushPostOutbox(),
    maintainDeBotConnection()
  ]).finally(() => {
    bridgeMaintenanceInFlight = null;
  });
  return bridgeMaintenanceInFlight;
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
    if (message.source === 'robinhood-radar-content' && message.type === 'status') {
      const value = await settings();
      return { configured: Boolean(value.bridgeToken) };
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
    if (message.source === 'bridge-options' && message.type === 'migrate-local-settings') {
      return migrateLocalSettings(message.payload || {});
    }
    throw new Error('Unsupported bridge message');
  };
  void run().then((payload) => sendResponse({ ok: true, payload })).catch(async (error) => {
    await updateBadge('!', '#b33a45');
    sendResponse({ ok: false, error: error instanceof Error ? error.message : String(error) });
  });
  return true;
});

ensureRecoveryAlarm();
chrome.runtime.onInstalled.addListener(() => {
  ensureRecoveryAlarm();
  void runBridgeMaintenance();
});
chrome.runtime.onStartup.addListener(() => {
  ensureRecoveryAlarm();
  void runBridgeMaintenance();
});
chrome.alarms.onAlarm.addListener((alarm) => {
  if (alarm?.name === RECOVERY_ALARM) void runBridgeMaintenance();
});

void settings().then(async (value) => {
  await updateBadge(value.bridgeToken ? 'ON' : '?', value.bridgeToken ? '#16834b' : '#bd8121');
  await runBridgeMaintenance();
});
