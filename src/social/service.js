import crypto from 'node:crypto';

import { createDeepSeekSocialTranslator, shouldTranslateSocialText } from './deepseekTranslator.js';
import { createSocialStore } from './store.js';
import { createXProfileMonitor } from './xProfileMonitor.js';
import { createXReplyEnricher, referenceContextNeedsEnrichment } from './xReplyEnricher.js';

const DEBOT_ANALYSIS_CAPABILITY = 'debot-analysis-v1';
const DEBOT_HOLDER_CAPABILITY = 'debot-token-holders-v1';
const DEBOT_TOKEN_DETAIL = 'debot.token_detail.v1';
const DEBOT_WALLET_TOKEN_ANALYSIS = 'debot.wallet_token_analysis.v1';
const DEBOT_TOKEN_HOLDERS = 'debot.token_holders.v1';
const DEBOT_TYPES = new Set([
  DEBOT_TOKEN_DETAIL,
  DEBOT_WALLET_TOKEN_ANALYSIS,
  DEBOT_TOKEN_HOLDERS
]);
const DEBOT_REMOTE_ERRORS = new Set([
  'AUTH',
  'TIMEOUT',
  'NETWORK',
  'DEBOT',
  'INVALID_JOB',
  'RESULT_TOO_LARGE'
]);
const EVM_ADDRESS_PATTERN = /^0x[0-9a-fA-F]{40}$/;
const ZERO_ADDRESS = '0x0000000000000000000000000000000000000000';
const DEBOT_RESULT_MAX_BYTES = 256 * 1024;
const TRANSLATION_FIELDS = ['translatedContent', 'translatedText', 'translation'];

function removeTranslationFields(value) {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return value;
  const sanitized = { ...value };
  for (const field of TRANSLATION_FIELDS) delete sanitized[field];
  return sanitized;
}

function withoutInboundTranslations(post) {
  if (!post || typeof post !== 'object' || Array.isArray(post)) return post;
  const sanitized = removeTranslationFields(post);
  for (const field of ['replyContext', 'reply_context', 'quoteContext', 'quote_context']) {
    if (Object.hasOwn(sanitized, field)) sanitized[field] = removeTranslationFields(sanitized[field]);
  }
  return sanitized;
}

class DeBotBridgeError extends Error {
  constructor(message, code, statusCode = 503) {
    super(message);
    this.name = 'DeBotBridgeError';
    this.code = code;
    this.statusCode = statusCode;
  }
}

function abortError() {
  const error = new Error('The DeBot bridge request was aborted');
  error.name = 'AbortError';
  error.code = 'ABORT_ERR';
  return error;
}

function exactKeys(value, expected) {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return false;
  const keys = Object.keys(value).sort();
  return keys.length === expected.length && expected.every((key, index) => key === keys[index]);
}

function evmAddress(value, name) {
  const address = String(value || '').trim();
  if (!EVM_ADDRESS_PATTERN.test(address) || address.toLowerCase() === ZERO_ADDRESS) {
    throw new TypeError(`${name} must be a valid non-zero EVM address`);
  }
  return address.toLowerCase();
}

function normalizeDeBotRequest(type, payload) {
  const normalizedType = String(type || '').trim();
  if (!DEBOT_TYPES.has(normalizedType)) throw new TypeError('Unsupported DeBot analysis request type');
  const validPayloadShape = normalizedType === DEBOT_WALLET_TOKEN_ANALYSIS
    ? exactKeys(payload, ['chain', 'token', 'wallet'])
    : normalizedType === DEBOT_TOKEN_HOLDERS
      ? exactKeys(payload, ['chain', 'token']) || exactKeys(payload, ['chain', 'pageSize', 'token'])
      : exactKeys(payload, ['chain', 'token']);
  if (!validPayloadShape) throw new TypeError('Invalid DeBot analysis payload');
  const chain = String(payload.chain || '').trim().toLowerCase();
  if (!['robinhood', 'bsc'].includes(chain)) {
    throw new TypeError('DeBot analysis only supports the Robinhood and BSC chains');
  }
  if (normalizedType === DEBOT_TOKEN_HOLDERS && chain !== 'bsc') {
    throw new TypeError('DeBot Holder analysis only supports the BSC chain');
  }
  const normalized = {
    chain,
    token: evmAddress(payload.token, 'token')
  };
  if (normalizedType === DEBOT_TOKEN_HOLDERS && payload.pageSize !== undefined) {
    const pageSize = Number(payload.pageSize);
    if (!Number.isSafeInteger(pageSize) || pageSize < 1 || pageSize > 100) {
      throw new TypeError('DeBot Holder pageSize must be an integer between 1 and 100');
    }
    normalized.pageSize = pageSize;
  }
  if (normalizedType === DEBOT_WALLET_TOKEN_ANALYSIS) {
    normalized.wallet = evmAddress(payload.wallet, 'wallet');
  }
  return { type: normalizedType, payload: normalized };
}

function deBotRequestKey(type, payload) {
  return crypto.createHash('sha256').update(`${type}\n${JSON.stringify(payload)}`).digest('hex');
}

function deBotResultEnvelope(type, result) {
  const schema = type === DEBOT_TOKEN_DETAIL
    ? 'debot.token_detail.raw.v1'
    : type === DEBOT_TOKEN_HOLDERS
      ? 'debot.token_holders.raw.v1'
      : 'debot.wallet_token_analysis.raw.v1';
  return {
    schema,
    data: result
  };
}

function validateDeBotResult(job, result) {
  if (!result || typeof result !== 'object' || Array.isArray(result)) {
    throw new TypeError('A successful DeBot analysis result must be a JSON object');
  }
  if (job.type === DEBOT_TOKEN_DETAIL) {
    const chain = String(result.token?.meta?.chain || result.pair?.chain || '').trim().toLowerCase();
    const token = String(result.token?.meta?.address || result.pair?.tokenAddress || '').trim().toLowerCase();
    if (chain !== job.payload.chain || token !== job.payload.token) {
      throw new TypeError('DeBot token-detail result does not match the claimed job');
    }
    return;
  }
  const chain = String(result.chain || '').trim().toLowerCase();
  const token = String(result.token || '').trim().toLowerCase();
  if (job.type === DEBOT_TOKEN_HOLDERS) {
    const holders = Array.isArray(result.list) ? result.list : null;
    const expectedLimit = Number(job.payload.pageSize || 100);
    if (chain !== job.payload.chain || token !== job.payload.token
      || !holders || holders.length > expectedLimit || holders.length > 100) {
      throw new TypeError('DeBot Holder result does not match the claimed job');
    }
    const seen = new Set();
    for (const holder of holders) {
      const address = String(holder?.address || '').trim().toLowerCase();
      if (!holder || typeof holder !== 'object' || Array.isArray(holder)
        || !EVM_ADDRESS_PATTERN.test(address) || address === ZERO_ADDRESS || seen.has(address)) {
        throw new TypeError('DeBot Holder result contains an invalid wallet row');
      }
      seen.add(address);
    }
    return;
  }
  const wallet = String(result.wallet || '').trim().toLowerCase();
  if (chain !== job.payload.chain || token !== job.payload.token || wallet !== job.payload.wallet) {
    throw new TypeError('DeBot wallet result does not match the claimed job');
  }
}

function serializedBytes(value) {
  let serialized;
  try {
    serialized = JSON.stringify(value);
  } catch {
    throw new TypeError('DeBot result must be JSON serializable');
  }
  if (serialized === undefined) throw new TypeError('DeBot result must be JSON serializable');
  return Buffer.byteLength(serialized, 'utf8');
}

function timingSafeStringEqual(left, right) {
  const leftBuffer = Buffer.from(String(left || ''));
  const rightBuffer = Buffer.from(String(right || ''));
  if (!leftBuffer.length || leftBuffer.length !== rightBuffer.length) return false;
  return crypto.timingSafeEqual(leftBuffer, rightBuffer);
}

function hasDeBotAnalysisCapability(connection, type = '') {
  return type === DEBOT_TOKEN_HOLDERS
    ? connection.holderAnalysisOnline === true
    : connection.analysisOnline === true;
}

function connectionState(config, bridge, now) {
  const paired = Boolean(config.bridgeToken);
  const lastSeenAt = bridge.lastSeenAt;
  const heartbeatAgeMs = lastSeenAt === null ? null : Math.max(0, now - lastSeenAt);
  const fresh = heartbeatAgeMs !== null && heartbeatAgeMs <= config.bridgeOfflineMs;
  const capabilities = Array.isArray(bridge.capabilities)
    ? bridge.capabilities.map((capability) => String(capability).trim().toLowerCase())
    : [];
  const reportedError = fresh && (capabilities.includes('error') || !capabilities.includes('posts'));
  const online = paired && fresh && !reportedError;
  const analysisOnline = paired && fresh && capabilities.includes(DEBOT_ANALYSIS_CAPABILITY);
  const holderAnalysisOnline = paired
    && fresh
    && capabilities.includes(DEBOT_ANALYSIS_CAPABILITY)
    && capabilities.includes(DEBOT_HOLDER_CAPABILITY);
  return {
    state: !paired ? 'unpaired' : reportedError ? 'error' : online ? 'online' : 'offline',
    paired,
    online,
    analysisOnline,
    holderAnalysisOnline,
    fresh,
    readOnly: !paired,
    lastSeenAt,
    heartbeatAgeMs,
    bridgeId: bridge.bridgeId,
    version: bridge.version,
    capabilities: bridge.capabilities,
    diagnostics: bridge.diagnostics
  };
}

export function createSocialService({
  config,
  store = null,
  now = () => Date.now(),
  fetchImpl = globalThis.fetch,
  xProfileMonitor = null,
  xReplyEnricher = null,
  socialTranslator = null,
  notifySocialContract = null
}) {
  if (!config) throw new TypeError('Social config is required');
  const activeStore = store || createSocialStore(config.dataFile, { now });
  const subscribers = new Set();
  const debotWaiters = new Map();
  let cleanupTimer = null;
  let xFastTimer = null;
  let xReferenceBackfillTimer = null;
  let xReferenceBackfillQueue = [];
  let translationBackfillTimer = null;
  let translationBackfillCursor = null;
  const translationBackfill = {
    scanned: 0,
    scheduled: 0,
    complete: false
  };
  let xFastInFlight = 0;
  const xFastAbortController = new AbortController();
  const xFastStats = {
    polls: 0,
    requests: 0,
    errors: 0,
    posts: 0,
    lastStartedAt: null,
    lastCompletedAt: null,
    lastPostAt: null,
    lastErrorCode: ''
  };
  let closed = false;
  const debotConfig = {
    jobLeaseMs: Number(config.debotJobLeaseMs) || 120_000,
    requestTimeoutMs: Number(config.debotRequestTimeoutMs) || 30_000,
    tokenCacheTtlMs: Number.isFinite(Number(config.debotTokenCacheTtlMs))
      ? Math.max(0, Number(config.debotTokenCacheTtlMs))
      : 60_000,
    walletCacheTtlMs: Number.isFinite(Number(config.debotWalletCacheTtlMs))
      ? Math.max(0, Number(config.debotWalletCacheTtlMs))
      : 30_000,
    pendingCap: Number(config.debotPendingCap) || 256,
    terminalRetentionMs: Number(config.debotTerminalRetentionMs) || 60 * 60 * 1_000
  };

  function bridgeUnavailable() {
    return new DeBotBridgeError(
      'DeBot analysis bridge is offline or does not support analysis jobs',
      'DEBOT_BRIDGE_UNAVAILABLE',
      503
    );
  }

  function settleDeBotWaiters(job) {
    const waiters = debotWaiters.get(job.id);
    if (!waiters) return;
    debotWaiters.delete(job.id);
    for (const waiter of waiters) {
      clearTimeout(waiter.timer);
      if (waiter.signal && waiter.onAbort) waiter.signal.removeEventListener('abort', waiter.onAbort);
      if (job.status === 'completed') {
        waiter.resolve(job.result);
      } else {
        waiter.reject(new DeBotBridgeError(
          `DeBot browser bridge request failed (${job.errorCode || 'DEBOT'})`,
          'DEBOT_BRIDGE_REQUEST_FAILED',
          502
        ));
      }
    }
  }

  function waitForDeBotJob(job, { signal, timeoutMs }) {
    return new Promise((resolve, reject) => {
      let settled = false;
      const finish = (operation, value) => {
        if (settled) return;
        settled = true;
        clearTimeout(waiter.timer);
        if (signal && waiter.onAbort) signal.removeEventListener('abort', waiter.onAbort);
        const waiters = debotWaiters.get(job.id);
        waiters?.delete(waiter);
        if (waiters?.size === 0) debotWaiters.delete(job.id);
        operation(value);
      };
      const waiter = {
        resolve: (value) => finish(resolve, value),
        reject: (error) => finish(reject, error),
        signal,
        onAbort: null,
        timer: null
      };
      waiter.timer = setTimeout(() => waiter.reject(new DeBotBridgeError(
        'DeBot analysis bridge request timed out',
        'DEBOT_BRIDGE_TIMEOUT',
        504
      )), timeoutMs);
      waiter.timer.unref?.();
      if (signal) {
        waiter.onAbort = () => waiter.reject(abortError());
        signal.addEventListener('abort', waiter.onAbort, { once: true });
      }
      const waiters = debotWaiters.get(job.id) || new Set();
      waiters.add(waiter);
      debotWaiters.set(job.id, waiters);
      if (signal?.aborted) waiter.onAbort();
    });
  }

  function publish(change) {
    for (const subscriber of subscribers) {
      try {
        subscriber(change);
      } catch {
        // One disconnected SSE client must not interrupt ingestion.
      }
    }
  }

  function publishAfter(latestBefore) {
    const latestTarget = activeStore.getLatestChangeId();
    const changes = [];
    let cursor = Math.max(0, Number(latestBefore) || 0);
    while (cursor < latestTarget) {
      const batch = activeStore.listChanges({ after: cursor, limit: 1_000 })
        .filter((change) => change.id <= latestTarget);
      if (!batch.length) break;
      for (const change of batch) publish(change);
      changes.push(...batch);
      cursor = batch.at(-1).id;
    }
    return changes;
  }

  const xFastHandles = Array.isArray(config.xFastHandles) ? config.xFastHandles : [];
  const activeXProfileMonitor = xProfileMonitor || (xFastHandles.length
    ? createXProfileMonitor({
        accounts: xFastHandles,
        fetchImpl,
        concurrency: Math.min(2, xFastHandles.length),
        timeoutMs: Number(config.xFastRequestTimeoutMs) || 3_500
      })
    : null);
  let service = null;
  const activeSocialTranslator = socialTranslator || (config.translationApiKey
    ? createDeepSeekSocialTranslator({
        apiKey: config.translationApiKey,
        baseUrl: config.translationBaseUrl,
        model: config.translationModel,
        fetchImpl,
        timeoutMs: config.translationTimeoutMs,
        maxAttempts: config.translationMaxAttempts,
        retryDelayMs: config.translationRetryDelayMs,
        concurrency: config.translationConcurrency,
        maxQueue: config.translationMaxQueue,
        cacheSize: config.translationCacheSize,
        readCache: (...args) => activeStore.getSocialTranslation?.(...args),
        writeCache: (...args) => activeStore.putSocialTranslation?.(...args)
      })
    : null);
  const translateXContext = activeSocialTranslator
    ? (content, { signal = null } = {}) => activeSocialTranslator.translate(content, {
        priority: 'realtime',
        signal
      })
    : async () => '';
  const activeXReplyEnricher = xReplyEnricher || (config.xReplyEnrichmentEnabled === true
    ? createXReplyEnricher({
        fetchImpl,
        translateImpl: translateXContext,
        emitOriginalFirst: true,
        translationRequired: Boolean(activeSocialTranslator),
        onEnriched: (post) => service?.ingestPosts([post], {
          skipReplyEnrichment: true,
          trustedTranslations: true
        })
      })
    : null);
  const allowedXFastHandles = new Set(xFastHandles.map((handle) => String(handle).toLowerCase()));

  function postIsWatched(post) {
    const source = String(post?.source || '').toLowerCase();
    const handle = String(post?.author?.handle || '').replace(/^@/, '').toLowerCase();
    if (!source || !handle) return false;
    const kind = String(post?.kind || 'post').toLowerCase();
    const watchlists = activeStore.listWatchlist({ platform: source });
    return watchlists.some((entry) => {
      if (entry.desiredState !== 'active') return false;
      if (entry.caBark !== true) return false;
      const watchedHandle = String(entry.handle || entry.accountKey || '').replace(/^@/, '').toLowerCase();
      if (watchedHandle !== handle) return false;
      return Array.isArray(entry.eventTypes) && entry.eventTypes.includes(kind);
    });
  }

  function notifyNewSocialContracts(posts) {
    if (typeof notifySocialContract !== 'function') return;
    for (const post of posts) {
      if (!postIsWatched(post) || !Array.isArray(post.contractAddresses) || !post.contractAddresses.length) continue;
      void Promise.resolve(notifySocialContract({
        platform: post.source === 'twitter' ? 'Twitter' : post.source,
        sourceName: post.source === 'twitter' ? 'Twitter' : post.source,
        authorName: post.author?.name || post.author?.handle,
        authorHandle: post.author?.handle,
        text: post.content,
        contractAddresses: post.contractAddresses,
        messageUrl: post.url
      })).catch(() => {});
    }
  }

  function updateTranslatedField(post, field, sourceText, translatedContent) {
    if (closed || !translatedContent) return;
    const latest = activeStore.getPost(String(post.source || ''), String(post.externalId || ''));
    if (!latest) return;
    const currentText = field === 'translatedContent'
      ? String(latest.content || '').trim()
      : String(latest[field]?.content || '').trim();
    if (currentText !== sourceText) return;
    const patch = {
      source: latest.source,
      externalId: latest.externalId,
      sourceUpdatedAt: latest.sourceUpdatedAt
    };
    if (field === 'translatedContent') {
      patch.translatedContent = translatedContent;
    } else {
      patch[field] = { ...latest[field], translatedContent };
    }
    service?.ingestPosts([patch], {
      skipReplyEnrichment: true,
      skipTranslation: true,
      trustedTranslations: true
    });
  }

  function schedulePostTranslations(post, priority = 'realtime') {
    if (!activeSocialTranslator || !post || post.deleted) {
      return { eligible: 0, scheduled: 0, rejected: 0 };
    }
    let scheduled = 0;
    let eligible = 0;
    let rejected = 0;
    const tasks = [
      ['translatedContent', String(post.content || '').trim()],
      ['replyContext', String(post.replyContext?.content || '').trim()],
      ['quoteContext', String(post.quoteContext?.content || '').trim()]
    ];
    for (const [field, sourceText] of tasks) {
      if (!shouldTranslateSocialText(sourceText)) continue;
      eligible += 1;
      const accepted = activeSocialTranslator.enqueue(sourceText, {
        priority,
        onTranslated: (translatedContent) => updateTranslatedField(
          post,
          field,
          sourceText,
          translatedContent
        ),
        onDropped: priority === 'background'
          ? () => {
              translationBackfill.complete = false;
              translationBackfillCursor = null;
              scheduleTranslationBackfill(100);
            }
          : null
      });
      if (accepted) scheduled += 1;
      else rejected += 1;
    }
    return { eligible, scheduled, rejected };
  }

  function scheduleTranslationBackfill(delayMs = 100) {
    if (closed || !activeSocialTranslator || translationBackfill.complete || translationBackfillTimer) return;
    translationBackfillTimer = setTimeout(() => {
      translationBackfillTimer = null;
      pumpTranslationBackfill();
    }, Math.max(25, Number(delayMs) || 100));
    translationBackfillTimer.unref?.();
  }

  function pumpTranslationBackfill() {
    if (closed || !activeSocialTranslator || translationBackfill.complete) return;
    const translatorStatus = activeSocialTranslator.status || {};
    const activeLimit = Math.max(1, Number(config.translationConcurrency) || 3);
    if (Number(translatorStatus.queued || 0) > activeLimit * 2) {
      scheduleTranslationBackfill(250);
      return;
    }
    const page = typeof activeStore.listPostsForTranslation === 'function'
      ? activeStore.listPostsForTranslation({ beforeId: translationBackfillCursor, limit: 100 })
      : [];
    if (!page.length) {
      translationBackfill.complete = true;
      return;
    }
    let lastAcceptedId = null;
    for (const post of page) {
      const result = schedulePostTranslations(post, 'background');
      if (result.rejected > 0) {
        scheduleTranslationBackfill(250);
        break;
      }
      translationBackfill.scanned += 1;
      translationBackfill.scheduled += result.scheduled;
      lastAcceptedId = Number(post.id);
    }
    if (lastAcceptedId !== null) translationBackfillCursor = lastAcceptedId;
    const pageFullyAccepted = lastAcceptedId !== null && lastAcceptedId === Number(page.at(-1).id);
    if (pageFullyAccepted && page.length < 100) {
      translationBackfill.complete = true;
      return;
    }
    if (!pageFullyAccepted) {
      scheduleTranslationBackfill(250);
      return;
    }
    scheduleTranslationBackfill(100);
  }

  function scheduleReferenceBackfill(delayMs = 250) {
    if (closed || !activeXReplyEnricher || !xReferenceBackfillQueue.length || xReferenceBackfillTimer) return;
    xReferenceBackfillTimer = setTimeout(() => {
      xReferenceBackfillTimer = null;
      pumpReferenceBackfill();
    }, Math.max(50, Number(delayMs) || 250));
    xReferenceBackfillTimer.unref?.();
  }

  function pumpReferenceBackfill() {
    if (closed || !activeXReplyEnricher || !xReferenceBackfillQueue.length) return;
    if (Number(activeXReplyEnricher.active || 0) > 0 || Number(activeXReplyEnricher.queued || 0) > 0) {
      scheduleReferenceBackfill(250);
      return;
    }
    const post = xReferenceBackfillQueue.shift();
    if (post) activeXReplyEnricher.enqueue(post);
    scheduleReferenceBackfill(250);
  }

  function confirmFastXPosts(handle, tweetIds) {
    if (!tweetIds.length) return;
    if (typeof activeXProfileMonitor?.confirm === 'function') {
      activeXProfileMonitor.confirm(handle, tweetIds);
      return;
    }
    if (typeof activeXProfileMonitor?.remember === 'function') {
      for (const tweetId of tweetIds) activeXProfileMonitor.remember(handle, tweetId);
    }
  }

  function handleFastXResult(result) {
    const status = String(result?.status || '');
    if (result?.requestMade !== false && status !== 'backoff' && status !== 'inflight') {
      xFastStats.requests += 1;
    }
    if (status === 'error' || status === 'empty') {
      xFastStats.errors += 1;
      xFastStats.lastErrorCode = status === 'empty'
        ? 'EMPTY_PROFILE'
        : String(result?.error?.code || 'X_PROFILE_ERROR').slice(0, 80);
    }
    if (closed || status !== 'new') return;
    const handle = String(result.handle || '').toLowerCase();
    if (!allowedXFastHandles.has(handle)) return;
    const discoveredAt = Number.isFinite(Number(result.checkedAt)) ? Number(result.checkedAt) : now();
    const posts = (Array.isArray(result.posts) ? result.posts : result.post ? [result.post] : [])
      .filter((post) => String(post.author?.handle || '').toLowerCase() === handle)
      .map((post) => ({ ...post, feedSources: ['my'], discoveredAt, receivedAt: discoveredAt }));
    if (!posts.length) return;
    try {
      const ingestion = service.ingestPosts(posts);
      const persistedIds = [...new Set((ingestion.posts || [])
        .map((post) => String(post.externalId || ''))
        .filter((externalId) => /^\d{5,25}$/.test(externalId)))];
      confirmFastXPosts(handle, persistedIds);
      if (persistedIds.length) {
        xFastStats.posts += persistedIds.length;
        xFastStats.lastPostAt = now();
      }
      if (persistedIds.length < posts.length) {
        xFastStats.errors += posts.length - persistedIds.length;
        xFastStats.lastErrorCode = 'FAST_X_NOT_PERSISTED';
      }
    } catch (error) {
      xFastStats.errors += 1;
      xFastStats.lastErrorCode = String(error?.code || error?.name || 'FAST_X_PERSIST_FAILED').slice(0, 80);
      throw error;
    }
  }

  function pollFastXProfiles() {
    if (closed || !activeXProfileMonitor || !xFastHandles.length) return;
    const maximum = Math.max(1, Math.min(3, Number(config.xFastMaxInFlight) || 3));
    if (xFastInFlight >= maximum) return;
    xFastInFlight += 1;
    xFastStats.polls += 1;
    xFastStats.lastStartedAt = now();
    void activeXProfileMonitor.pollOnce(xFastHandles, {
      signal: xFastAbortController.signal,
      onResult: handleFastXResult
    })
      .catch((error) => {
        if (closed) return;
        xFastStats.errors += 1;
        xFastStats.lastErrorCode = String(error?.code || error?.name || 'X_PROFILE_ERROR').slice(0, 80);
      })
      .finally(() => {
        xFastInFlight = Math.max(0, xFastInFlight - 1);
        xFastStats.lastCompletedAt = now();
      });
  }

  service = {
    config: {
      dataFile: config.dataFile,
      retentionDays: config.retentionDays,
      bridgeOfflineMs: config.bridgeOfflineMs,
      commandLeaseMs: config.commandLeaseMs,
      debotJobLeaseMs: debotConfig.jobLeaseMs,
      debotRequestTimeoutMs: debotConfig.requestTimeoutMs,
      debotPendingCap: debotConfig.pendingCap,
      xFastHandles: [...xFastHandles],
      xFastPollIntervalMs: Number(config.xFastPollIntervalMs) || 500,
      translationEnabled: Boolean(activeSocialTranslator),
      translationModel: activeSocialTranslator?.model || ''
    },
    store: activeStore,
    get paired() {
      return Boolean(config.bridgeToken);
    },
    getConnection() {
      return connectionState(config, activeStore.getBridgeState(), now());
    },
    getSnapshot({ postLimit = 50 } = {}) {
      return {
        ok: true,
        status: 'ready',
        bridge: service.getConnection(),
        counts: activeStore.getCounts(),
        fastX: service.getFastXStatus(),
        translation: service.getTranslationStatus(),
        posts: activeStore.listPosts({ limit: postLimit, watchlistOnly: true }),
        watchlist: activeStore.listWatchlist(),
        latestChangeId: activeStore.getLatestChangeId(),
        retention: { days: config.retentionDays },
        serverTime: now()
      };
    },
    listPosts(filters) {
      return activeStore.listPosts(filters);
    },
    listWatchlist(filters) {
      return activeStore.listWatchlist(filters);
    },
    getFastXStatus() {
      return {
        enabled: Boolean(activeXProfileMonitor && xFastHandles.length),
        handles: [...xFastHandles],
        pollIntervalMs: Number(config.xFastPollIntervalMs) || 500,
        maxInFlight: Math.max(1, Math.min(3, Number(config.xFastMaxInFlight) || 3)),
        inFlight: xFastInFlight,
        ...xFastStats
      };
    },
    getTranslationStatus() {
      return activeSocialTranslator
        ? { ...activeSocialTranslator.status, backfill: { ...translationBackfill } }
        : { enabled: false, model: '', backfill: { ...translationBackfill, complete: true } };
    },
    addWatchAccounts(accounts) {
      const latestBefore = activeStore.getLatestChangeId();
      const results = activeStore.addWatchAccounts(accounts);
      publishAfter(latestBefore);
      return {
        ok: true,
        entries: results.map((result) => result.entry),
        commands: results.map((result) => result.command).filter(Boolean),
        counts: activeStore.getCounts()
      };
    },
    updateWatchAccountPreferences(id, patch) {
      const latestBefore = activeStore.getLatestChangeId();
      const result = activeStore.updateWatchAccountPreferences(id, patch);
      publishAfter(latestBefore);
      return result ? { ok: true, ...result, counts: activeStore.getCounts() } : null;
    },
    updateWatchAccountEventTypes(id, eventTypes) {
      return service.updateWatchAccountPreferences(id, { eventTypes });
    },
    removeWatchAccount(id) {
      const latestBefore = activeStore.getLatestChangeId();
      const result = activeStore.removeWatchAccount(id);
      publishAfter(latestBefore);
      return result ? { ok: true, ...result, counts: activeStore.getCounts() } : null;
    },
    ingestPosts(posts, {
      skipReplyEnrichment = false,
      skipTranslation = false,
      trustedTranslations = false
    } = {}) {
      const latestBefore = activeStore.getLatestChangeId();
      const incoming = !trustedTranslations
        ? (Array.isArray(posts) ? posts : [posts]).map(withoutInboundTranslations)
        : posts;
      const results = activeStore.upsertPosts(incoming);
      const changes = publishAfter(latestBefore);
      notifyNewSocialContracts(results
        .filter((result) => result.action === 'created')
        .map((result) => result.post)
        .filter(Boolean));
      if (!skipReplyEnrichment) {
        activeXReplyEnricher?.enqueue(
          results.map((result) => result.post).filter(referenceContextNeedsEnrichment)
        );
      }
      if (!skipTranslation) {
        for (const result of results) schedulePostTranslations(result.post, 'realtime');
      }
      const summary = { created: 0, updated: 0, deleted: 0, restored: 0, unchanged: 0, filtered: 0 };
      for (const result of results) summary[result.action] += 1;
      return {
        ok: true,
        summary,
        posts: results.map((result) => result.post).filter(Boolean),
        filtered: results
          .filter((result) => result.action === 'filtered')
          .map(({ source, externalId, reason }) => ({ source, externalId, reason })),
        changes,
        counts: activeStore.getCounts()
      };
    },
    deletePost(source, externalId, deletedAt) {
      const latestBefore = activeStore.getLatestChangeId();
      const result = activeStore.deletePost(source, externalId, deletedAt);
      publishAfter(latestBefore);
      return { ok: true, ...result, counts: activeStore.getCounts() };
    },
    heartbeat(body) {
      const bridge = activeStore.recordBridgeHeartbeat(body);
      return {
        ok: true,
        bridge: connectionState(config, bridge, now()),
        counts: activeStore.getCounts(),
        serverTime: now()
      };
    },
    reconcileWatchlist(accounts, snapshotMetadata = {}) {
      const latestBefore = activeStore.getLatestChangeId();
      const result = activeStore.reconcileRemoteWatchlist(accounts, snapshotMetadata);
      publishAfter(latestBefore);
      return { ok: true, ...result, counts: activeStore.getCounts() };
    },
    claimCommands(options = {}) {
      return {
        ok: true,
        commands: activeStore.claimCommands({
          ...options,
          leaseMs: config.commandLeaseMs
        }),
        serverTime: now()
      };
    },
    acknowledgeCommand(id, result) {
      const latestBefore = activeStore.getLatestChangeId();
      const command = activeStore.acknowledgeCommand(id, result);
      publishAfter(latestBefore);
      return command ? { ok: true, command, counts: activeStore.getCounts() } : null;
    },
    requestDeBot(type, payload, { signal = null, timeoutMs, cacheTtlMs } = {}) {
      if (closed) {
        return Promise.reject(new DeBotBridgeError(
          'DeBot analysis bridge is closed',
          'DEBOT_BRIDGE_CLOSED',
          503
        ));
      }
      if (signal?.aborted) return Promise.reject(abortError());
      const request = normalizeDeBotRequest(type, payload);
      const requestKey = deBotRequestKey(request.type, request.payload);
      const cached = activeStore.getCachedDeBotResult(requestKey);
      if (cached) return Promise.resolve(cached.result);
      const connection = service.getConnection();
      if (!hasDeBotAnalysisCapability(connection, request.type)) return Promise.reject(bridgeUnavailable());

      const waitMs = timeoutMs === undefined
        ? debotConfig.requestTimeoutMs
        : Math.floor(Number(timeoutMs));
      if (!Number.isSafeInteger(waitMs) || waitMs < 1 || waitMs > 2 * 60_000) {
        throw new RangeError('DeBot request timeout is outside the allowed range');
      }
      const defaultCacheTtl = [DEBOT_TOKEN_DETAIL, DEBOT_TOKEN_HOLDERS].includes(request.type)
        ? debotConfig.tokenCacheTtlMs
        : debotConfig.walletCacheTtlMs;
      const ttlMs = cacheTtlMs === undefined ? defaultCacheTtl : Math.floor(Number(cacheTtlMs));
      if (!Number.isSafeInteger(ttlMs) || ttlMs < 0 || ttlMs > 10 * 60_000) {
        throw new RangeError('DeBot cache TTL is outside the allowed range');
      }
      const queued = activeStore.enqueueDeBotJob({
        requestKey,
        type: request.type,
        payload: request.payload,
        deadlineAt: now() + waitMs,
        cacheTtlMs: ttlMs,
        pendingCap: debotConfig.pendingCap
      });
      if (queued.state === 'cached') return Promise.resolve(queued.job.result);
      if (queued.state === 'full') {
        return Promise.reject(new DeBotBridgeError(
          'DeBot analysis bridge queue is full',
          'DEBOT_BRIDGE_QUEUE_FULL',
          503
        ));
      }
      return waitForDeBotJob(queued.job, { signal, timeoutMs: waitMs });
    },
    claimDeBotJobs({ limit = 4 } = {}) {
      const connection = service.getConnection();
      if (!hasDeBotAnalysisCapability(connection)) throw bridgeUnavailable();
      const allowedTypes = connection.holderAnalysisOnline
        ? [...DEBOT_TYPES]
        : [DEBOT_TOKEN_DETAIL, DEBOT_WALLET_TOKEN_ANALYSIS];
      const jobs = activeStore.claimDeBotJobs({
        limit,
        leaseMs: debotConfig.jobLeaseMs,
        types: allowedTypes,
        createClaimToken: () => crypto.randomBytes(24).toString('base64url')
      });
      return {
        ok: true,
        jobs: jobs.map((job) => ({
          id: job.id,
          type: job.type,
          claimToken: job.claimToken,
          payload: job.payload,
          leaseExpiresAt: job.leaseExpiresAt,
          deadlineAt: job.deadlineAt
        })),
        serverTime: now()
      };
    },
    submitDeBotResult(id, {
      claimToken,
      success,
      result = null,
      error = '',
      errorType = ''
    } = {}) {
      const job = activeStore.getDeBotJob(id);
      if (!job) {
        throw new DeBotBridgeError('DeBot analysis job was not found', 'DEBOT_JOB_NOT_FOUND', 404);
      }
      const submittedToken = String(claimToken || '');
      if (!submittedToken || submittedToken.length > 240) {
        throw new TypeError('A valid DeBot claim token is required');
      }
      if (!timingSafeStringEqual(job.claimToken, submittedToken)) {
        throw new DeBotBridgeError('DeBot analysis job claim is invalid', 'DEBOT_JOB_CLAIM_INVALID', 409);
      }
      if (typeof success !== 'boolean') throw new TypeError('success must be a boolean');

      let resultEnvelope = null;
      let remoteError = '';
      if (success) {
        if (String(error || '') || String(errorType || '')) {
          throw new TypeError('A successful DeBot analysis result cannot include an error');
        }
        validateDeBotResult(job, result);
        resultEnvelope = deBotResultEnvelope(job.type, result);
        if (serializedBytes(resultEnvelope) > DEBOT_RESULT_MAX_BYTES) {
          throw new DeBotBridgeError('DeBot analysis result is too large', 'DEBOT_RESULT_TOO_LARGE', 413);
        }
      } else {
        if (result !== null && result !== undefined) {
          throw new TypeError('A failed DeBot analysis result must be null');
        }
        if (typeof error !== 'string' || typeof errorType !== 'string') {
          throw new TypeError('DeBot bridge errors must be strings');
        }
        const candidate = String(errorType || error || '').trim().toUpperCase();
        remoteError = DEBOT_REMOTE_ERRORS.has(candidate) ? candidate : 'DEBOT';
      }

      const acknowledged = activeStore.acknowledgeDeBotJob(job.id, {
        claimToken: submittedToken,
        success,
        result: resultEnvelope,
        errorCode: remoteError,
        errorMessage: remoteError ? `DeBot browser bridge request failed (${remoteError})` : ''
      });
      if (acknowledged.state === 'not_found') {
        throw new DeBotBridgeError('DeBot analysis job was not found', 'DEBOT_JOB_NOT_FOUND', 404);
      }
      if (acknowledged.state === 'claim_mismatch' || acknowledged.state === 'claim_expired') {
        throw new DeBotBridgeError('DeBot analysis job claim has expired', 'DEBOT_JOB_CLAIM_EXPIRED', 409);
      }
      if (acknowledged.state === 'terminal') {
        const sameOutcome = (acknowledged.job.status === 'completed') === success;
        const samePayload = success
          ? JSON.stringify(acknowledged.job.result) === JSON.stringify(resultEnvelope)
          : acknowledged.job.errorCode === remoteError;
        if (!sameOutcome || !samePayload) {
          throw new DeBotBridgeError('DeBot analysis job is already complete', 'DEBOT_JOB_ALREADY_COMPLETE', 409);
        }
        return { ok: true };
      }
      settleDeBotWaiters(acknowledged.job);
      return { ok: true };
    },
    listChanges(options) {
      return activeStore.listChanges(options);
    },
    subscribe(listener) {
      if (typeof listener !== 'function') throw new TypeError('Social subscriber must be a function');
      subscribers.add(listener);
      return () => subscribers.delete(listener);
    },
    cleanup() {
      return activeStore.cleanup({
        retentionDays: config.retentionDays,
        debotTerminalRetentionMs: debotConfig.terminalRetentionMs
      });
    },
    start() {
      if (cleanupTimer || closed) return;
      service.cleanup();
      cleanupTimer = setInterval(() => service.cleanup(), config.cleanupIntervalMs);
      cleanupTimer.unref?.();
      if (activeXReplyEnricher) {
        xReferenceBackfillQueue = activeStore.listPosts({ limit: 500, watchlistOnly: true })
          .filter(referenceContextNeedsEnrichment)
          .sort((left, right) => Number(String(right.kind).toLowerCase() === 'quote')
            - Number(String(left.kind).toLowerCase() === 'quote'));
        pumpReferenceBackfill();
      }
      if (activeSocialTranslator) {
        scheduleTranslationBackfill(0);
      }
      if (activeXProfileMonitor && xFastHandles.length) {
        pollFastXProfiles();
        xFastTimer = setInterval(
          pollFastXProfiles,
          Math.max(250, Number(config.xFastPollIntervalMs) || 500)
        );
        xFastTimer.unref?.();
      }
    },
    close() {
      if (closed) return;
      closed = true;
      if (cleanupTimer) clearInterval(cleanupTimer);
      cleanupTimer = null;
      if (xFastTimer) clearInterval(xFastTimer);
      xFastTimer = null;
      if (xReferenceBackfillTimer) clearTimeout(xReferenceBackfillTimer);
      xReferenceBackfillTimer = null;
      xReferenceBackfillQueue = [];
      if (translationBackfillTimer) clearTimeout(translationBackfillTimer);
      translationBackfillTimer = null;
      xFastAbortController.abort(abortError());
      activeXReplyEnricher?.close?.();
      activeSocialTranslator?.close?.();
      for (const waiters of debotWaiters.values()) {
        for (const waiter of [...waiters]) {
          waiter.reject(new DeBotBridgeError(
            'DeBot analysis bridge is closed',
            'DEBOT_BRIDGE_CLOSED',
            503
          ));
        }
      }
      debotWaiters.clear();
      subscribers.clear();
      activeStore.close();
    }
  };
  return service;
}
