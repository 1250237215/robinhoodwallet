import crypto from 'node:crypto';

import { createSocialStore } from './store.js';

const DEBOT_ANALYSIS_CAPABILITY = 'debot-analysis-v1';
const DEBOT_TOKEN_DETAIL = 'debot.token_detail.v1';
const DEBOT_WALLET_TOKEN_ANALYSIS = 'debot.wallet_token_analysis.v1';
const DEBOT_TYPES = new Set([DEBOT_TOKEN_DETAIL, DEBOT_WALLET_TOKEN_ANALYSIS]);
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
  const expectedKeys = normalizedType === DEBOT_TOKEN_DETAIL
    ? ['chain', 'token']
    : ['chain', 'token', 'wallet'];
  if (!exactKeys(payload, expectedKeys)) throw new TypeError('Invalid DeBot analysis payload');
  const chain = String(payload.chain || '').trim().toLowerCase();
  if (chain !== 'robinhood') throw new TypeError('DeBot analysis only supports the Robinhood chain');
  const normalized = {
    chain,
    token: evmAddress(payload.token, 'token')
  };
  if (normalizedType === DEBOT_WALLET_TOKEN_ANALYSIS) {
    normalized.wallet = evmAddress(payload.wallet, 'wallet');
  }
  return { type: normalizedType, payload: normalized };
}

function deBotRequestKey(type, payload) {
  return crypto.createHash('sha256').update(`${type}\n${JSON.stringify(payload)}`).digest('hex');
}

function deBotResultEnvelope(type, result) {
  return {
    schema: type === DEBOT_TOKEN_DETAIL
      ? 'debot.token_detail.raw.v1'
      : 'debot.wallet_token_analysis.raw.v1',
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
    if (chain !== 'robinhood' || token !== job.payload.token) {
      throw new TypeError('DeBot token-detail result does not match the claimed job');
    }
    return;
  }
  const chain = String(result.chain || '').trim().toLowerCase();
  const token = String(result.token || '').trim().toLowerCase();
  const wallet = String(result.wallet || '').trim().toLowerCase();
  if (chain !== 'robinhood' || token !== job.payload.token || wallet !== job.payload.wallet) {
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

function hasDeBotAnalysisCapability(connection) {
  return connection.online && connection.capabilities.some(
    (capability) => String(capability).trim().toLowerCase() === DEBOT_ANALYSIS_CAPABILITY
  );
}

function connectionState(config, bridge, now) {
  const paired = Boolean(config.bridgeToken);
  const lastSeenAt = bridge.lastSeenAt;
  const fresh = lastSeenAt !== null && now - lastSeenAt <= config.bridgeOfflineMs;
  const reportedError = fresh && Array.isArray(bridge.capabilities) &&
    bridge.capabilities.some((capability) => String(capability).trim().toLowerCase() === 'error');
  const online = paired && fresh && !reportedError;
  return {
    state: !paired ? 'unpaired' : reportedError ? 'error' : online ? 'online' : 'offline',
    paired,
    online,
    readOnly: !paired,
    lastSeenAt,
    bridgeId: bridge.bridgeId,
    version: bridge.version,
    capabilities: bridge.capabilities
  };
}

export function createSocialService({ config, store = null, now = () => Date.now() }) {
  if (!config) throw new TypeError('Social config is required');
  const activeStore = store || createSocialStore(config.dataFile, { now });
  const subscribers = new Set();
  const debotWaiters = new Map();
  let cleanupTimer = null;
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
    const changes = activeStore.listChanges({ after: latestBefore, limit: 1_000 });
    for (const change of changes) publish(change);
    return changes;
  }

  const service = {
    config: {
      dataFile: config.dataFile,
      retentionDays: config.retentionDays,
      bridgeOfflineMs: config.bridgeOfflineMs,
      commandLeaseMs: config.commandLeaseMs,
      debotJobLeaseMs: debotConfig.jobLeaseMs,
      debotRequestTimeoutMs: debotConfig.requestTimeoutMs,
      debotPendingCap: debotConfig.pendingCap
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
        posts: activeStore.listPosts({ limit: postLimit }),
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
    removeWatchAccount(id) {
      const latestBefore = activeStore.getLatestChangeId();
      const result = activeStore.removeWatchAccount(id);
      publishAfter(latestBefore);
      return result ? { ok: true, ...result, counts: activeStore.getCounts() } : null;
    },
    ingestPosts(posts) {
      const latestBefore = activeStore.getLatestChangeId();
      const results = activeStore.upsertPosts(posts);
      const changes = publishAfter(latestBefore);
      const summary = { created: 0, updated: 0, deleted: 0, restored: 0, unchanged: 0 };
      for (const result of results) summary[result.action] += 1;
      return {
        ok: true,
        summary,
        posts: results.map((result) => result.post),
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
    reconcileWatchlist(accounts) {
      const latestBefore = activeStore.getLatestChangeId();
      const result = activeStore.reconcileRemoteWatchlist(accounts);
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
      if (!hasDeBotAnalysisCapability(connection)) return Promise.reject(bridgeUnavailable());

      const waitMs = timeoutMs === undefined
        ? debotConfig.requestTimeoutMs
        : Math.floor(Number(timeoutMs));
      if (!Number.isSafeInteger(waitMs) || waitMs < 1 || waitMs > 2 * 60_000) {
        throw new RangeError('DeBot request timeout is outside the allowed range');
      }
      const defaultCacheTtl = request.type === DEBOT_TOKEN_DETAIL
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
      if (!hasDeBotAnalysisCapability(service.getConnection())) throw bridgeUnavailable();
      const jobs = activeStore.claimDeBotJobs({
        limit,
        leaseMs: debotConfig.jobLeaseMs,
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
    },
    close() {
      if (closed) return;
      closed = true;
      if (cleanupTimer) clearInterval(cleanupTimer);
      cleanupTimer = null;
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
