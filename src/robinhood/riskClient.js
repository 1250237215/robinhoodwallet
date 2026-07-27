const ADDRESS_PATTERN = /^0x[0-9a-f]{40}$/;
const HASH_PATTERN = /^0x[0-9a-f]{64}$/;
const ZERO_ADDRESS = '0x0000000000000000000000000000000000000000';
const DEAD_ADDRESS = '0x000000000000000000000000000000000000dead';
const DEFAULT_BLOCKSCOUT_URL = 'https://robinhoodchain.blockscout.com/api/v2';
const DEFAULT_ROBINHOOD_RPC_URL = 'https://rpc.mainnet.chain.robinhood.com';
const DEFAULT_GOPLUS_TOKEN_SECURITY_URL = 'https://api.gopluslabs.io/api/v1/token_security';
const ROBINHOOD_GOPLUS_CHAIN_ID = 4663;
const DEFAULT_TOKEN_CACHE_MAX_ENTRIES = 2_048;
const DEFAULT_CREATOR_CACHE_MAX_ENTRIES = 512;
const DEFAULT_CACHE_SWEEP_INTERVAL_MS = 60_000;
const TOKEN_LAUNCHED_TOPIC =
  '0xdb51ea9ad51ab453a65a4cb7e60c3cb378c9501bb002609f8f97778fb6c4235a';
const LAUNCH_FACTORIES = Object.freeze([
  '0xa5aab3f0c6eeadf30ef1d3eb997108e976351feb', // Pons
  '0xd9ec2db5f3d1b236843925949fe5bd8a3836fccb' // Noxa
]);
const EXPLICIT_INFRASTRUCTURE_NAME = /pool|router|factory|locker|uniswap\s*v?\d*\s*pair/i;

const DEFAULT_RISK_THRESHOLDS = Object.freeze({
  lowLiquidityUsd: 10_000,
  holderConcentrationPercent: 50,
  creatorConcentrationPercent: 5,
  badCreatorHistoryMinimumTokens: 3,
  badCreatorHistoryDeadRatio: 0.5,
  deadMinimumAgeSeconds: 24 * 60 * 60,
  deadLiquidityUsd: 1_000
});

export const ROBINHOOD_TOKEN_LAUNCHED_TOPIC = TOKEN_LAUNCHED_TOPIC;
export const ROBINHOOD_LAUNCH_FACTORIES = LAUNCH_FACTORIES;
export const ROBINHOOD_TOKEN_RISK_THRESHOLDS = DEFAULT_RISK_THRESHOLDS;
export const ROBINHOOD_GOPLUS_TOKEN_SECURITY_URL = DEFAULT_GOPLUS_TOKEN_SECURITY_URL;
export const ROBINHOOD_DEAD_TOKEN_DEFINITION =
  'age>=24h && (no_dexscreener_pair || primary_liquidity_usd<1000)';

function normalizeAddress(value) {
  const raw = typeof value === 'string'
    ? value
    : value?.hash ?? value?.address_hash ?? value?.address ?? '';
  return String(raw || '').trim().toLowerCase();
}

function normalizeHash(value) {
  return String(value || '').trim().toLowerCase();
}

function requireAddress(value, label = 'token') {
  const address = normalizeAddress(value);
  if (!ADDRESS_PATTERN.test(address)) throw new TypeError(`Invalid Robinhood ${label} address`);
  return address;
}

function finiteNumber(value) {
  if (value === null || value === undefined || value === '') return null;
  const number = Number(value);
  return Number.isFinite(number) ? number : null;
}

function nonNegativeNumber(value) {
  const number = finiteNumber(value);
  return number !== null && number >= 0 ? number : null;
}

function nonNegativeCount(value) {
  if (typeof value === 'string') {
    if (!/^\d+$/.test(value)) return null;
  } else if (typeof value !== 'number') {
    return null;
  }
  const number = Number(value);
  return Number.isSafeInteger(number) && number >= 0 ? number : null;
}

function booleanFlag(value) {
  if (value === false || value === 0 || value === '0') return false;
  if (value === true || value === 1 || value === '1') return true;
  return null;
}

function unixSeconds(value) {
  if (typeof value === 'string' && /^0x[0-9a-f]+$/i.test(value.trim())) {
    try {
      const parsed = Number(BigInt(value.trim()));
      return Number.isSafeInteger(parsed) && parsed > 0 ? parsed : null;
    } catch {
      return null;
    }
  }
  const number = finiteNumber(value);
  if (number !== null && number > 0) {
    if (number > 10_000_000_000) return Math.floor(number / 1_000);
    return Math.floor(number);
  }
  if (typeof value !== 'string' || !value.trim()) return null;
  const parsed = Date.parse(value);
  return Number.isFinite(parsed) ? Math.floor(parsed / 1_000) : null;
}

function boundedInteger(value, fallback, minimum, maximum) {
  const number = Number(value);
  if (!Number.isFinite(number)) return fallback;
  return Math.max(minimum, Math.min(maximum, Math.floor(number)));
}

function abortReason(signal, fallback = 'Robinhood token risk request was cancelled') {
  return signal?.reason instanceof Error ? signal.reason : new Error(fallback);
}

function throwIfAborted(signal) {
  if (signal?.aborted) throw abortReason(signal);
}

function signalWithTimeout(signal, timeoutMs) {
  const timeoutSignal = AbortSignal.timeout(timeoutMs);
  return signal ? AbortSignal.any([signal, timeoutSignal]) : timeoutSignal;
}

function awaitWithSignal(value, signal) {
  if (!signal) return Promise.resolve(value);
  if (signal.aborted) return Promise.reject(abortReason(signal));
  return new Promise((resolve, reject) => {
    let settled = false;
    const finish = (handler, result) => {
      if (settled) return;
      settled = true;
      signal.removeEventListener('abort', onAbort);
      handler(result);
    };
    const onAbort = () => finish(reject, abortReason(signal));
    signal.addEventListener('abort', onAbort, { once: true });
    Promise.resolve(value).then(
      (result) => finish(resolve, result),
      (error) => finish(reject, error)
    );
  });
}

function delayWithSignal(delayMs, signal) {
  if (!(delayMs > 0)) {
    throwIfAborted(signal);
    return Promise.resolve();
  }
  return new Promise((resolve, reject) => {
    const timer = setTimeout(() => {
      signal?.removeEventListener('abort', onAbort);
      resolve();
    }, delayMs);
    const onAbort = () => {
      clearTimeout(timer);
      reject(abortReason(signal));
    };
    if (signal?.aborted) onAbort();
    else signal?.addEventListener('abort', onAbort, { once: true });
  });
}

function compactError(error) {
  const message = error instanceof Error ? error.message : String(error || 'Unknown upstream error');
  return message.replace(/[\u0000-\u001f\u007f]+/g, ' ').replace(/\s+/g, ' ').trim().slice(0, 240);
}

function requestError(message, { status = null, retryable = true, cause = null } = {}) {
  const error = new Error(message, cause ? { cause } : undefined);
  error.status = status;
  error.retryable = retryable;
  return error;
}

async function limitedResponseText(response, maxResponseBytes, source) {
  const tooLarge = () => requestError(`${source} response is too large`, { retryable: false });
  const cancelWithoutWaiting = (cancel) => {
    try {
      Promise.resolve(cancel()).catch(() => {});
    } catch {
      // Cancellation is best-effort; the deterministic size error must not be delayed.
    }
  };
  const declared = finiteNumber(response?.headers?.get?.('content-length'));
  if (declared !== null && declared > maxResponseBytes) {
    if (typeof response?.body?.cancel === 'function') {
      cancelWithoutWaiting(() => response.body.cancel());
    }
    throw tooLarge();
  }

  const reader = response?.body?.getReader?.();
  if (!reader) {
    const text = await response.text();
    if (Buffer.byteLength(text) > maxResponseBytes) throw tooLarge();
    return text;
  }

  const chunks = [];
  let total = 0;
  try {
    while (true) {
      const { done, value } = await reader.read();
      if (done) break;
      const chunk = value instanceof Uint8Array ? value : new Uint8Array(value || []);
      total += chunk.byteLength;
      if (total > maxResponseBytes) {
        cancelWithoutWaiting(() => reader.cancel());
        throw tooLarge();
      }
      chunks.push(Buffer.from(chunk));
    }
  } finally {
    reader.releaseLock?.();
  }
  return Buffer.concat(chunks, total).toString('utf8');
}

function cloneResult(value) {
  return {
    ...value,
    ...(value?.tokenRiskFlags ? { tokenRiskFlags: [...value.tokenRiskFlags] } : {}),
    ...(value?.tokenRiskSources ? { tokenRiskSources: { ...value.tokenRiskSources } } : {}),
    ...(value?.creatorContext ? { creatorContext: { ...value.creatorContext } } : {}),
    ...(value?.creatorHistoryFlags ? { creatorHistoryFlags: [...value.creatorHistoryFlags] } : {}),
    ...(value?._creatorRecords
      ? { _creatorRecords: value._creatorRecords.map((record) => ({ ...record })) }
      : {})
  };
}

function percentFromRawBalance(value, totalSupply) {
  try {
    const balance = BigInt(String(value));
    const supply = BigInt(String(totalSupply));
    if (balance < 0n || supply <= 0n) return null;
    const scaled = (balance * 100_000_000n) / supply;
    return Math.max(0, Math.min(100, Number(scaled) / 1_000_000));
  } catch {
    return null;
  }
}

function rpcUint256(value, label) {
  const encoded = String(value || '').trim().toLowerCase();
  if (!/^0x[0-9a-f]{64}$/.test(encoded)) {
    throw requestError(`Robinhood RPC returned an invalid ${label}`, { retryable: false });
  }
  return BigInt(encoded).toString();
}

function addressFromTopic(value) {
  const topic = String(value || '').trim().toLowerCase();
  if (!/^0x[0-9a-f]{64}$/.test(topic)) return null;
  const address = `0x${topic.slice(-40)}`;
  return ADDRESS_PATTERN.test(address) ? address : null;
}

function topicForAddress(address) {
  return `0x${'0'.repeat(24)}${requireAddress(address, 'creator').slice(2)}`;
}

function blockscoutCursorUrl(base, cursor) {
  const url = new URL(base);
  for (const [key, value] of Object.entries(cursor || {})) {
    if (value !== null && value !== undefined && value !== '') url.searchParams.set(key, String(value));
  }
  return url;
}

function mapBatchResult(value, addresses) {
  if (value instanceof Map) {
    return new Map([...value].map(([address, metrics]) => [normalizeAddress(address), metrics]));
  }
  if (Array.isArray(value)) {
    return new Map(value.map((metrics, index) => [
      normalizeAddress(metrics?.address || addresses[index]),
      metrics
    ]));
  }
  if (value && typeof value === 'object') {
    return new Map(Object.entries(value).map(([address, metrics]) => [normalizeAddress(address), metrics]));
  }
  return new Map();
}

async function mapLimit(items, concurrency, mapper) {
  const results = new Array(items.length);
  let index = 0;
  const worker = async () => {
    while (index < items.length) {
      const current = index;
      index += 1;
      results[current] = await mapper(items[current], current);
    }
  };
  await Promise.all(Array.from({ length: Math.min(items.length, concurrency) }, () => worker()));
  return results;
}

function holderName(holder) {
  return String(holder?.contractName || holder?.name || holder?.address?.name || '').trim();
}

function riskHolderExcluded(holder, poolAddresses) {
  const address = normalizeAddress(holder?.address);
  if (!ADDRESS_PATTERN.test(address) || address === ZERO_ADDRESS || address === DEAD_ADDRESS) return true;
  if (poolAddresses.has(address)) return true;
  return EXPLICIT_INFRASTRUCTURE_NAME.test(holderName(holder));
}

function topHolderSummary(holderResult, marketMetrics) {
  if (!holderResult || !Array.isArray(holderResult.holders)) {
    return { percent: null, count: 0, partial: true };
  }
  const poolAddresses = new Set([
    marketMetrics?.primaryPoolAddress,
    ...(Array.isArray(marketMetrics?.poolAddresses) ? marketMetrics.poolAddresses : [])
  ].map(normalizeAddress).filter((address) => ADDRESS_PATTERN.test(address)));
  const eligible = holderResult.holders.filter((holder) => !riskHolderExcluded(holder, poolAddresses));
  const top = eligible.slice(0, 10);
  const shares = top.map((holder) => nonNegativeNumber(holder?.holdingSharePercent));
  const availableShares = shares.filter((share) => share !== null);
  const percent = top.length === 0 && holderResult.reachedEnd === true
    ? 0
    : availableShares.length === top.length && top.length > 0
      ? Math.max(0, Math.min(100, availableShares.reduce((total, share) => total + share, 0)))
      : null;
  return {
    percent,
    count: top.length,
    partial: top.length < 10 && holderResult.reachedEnd !== true
  };
}

function creatorShareFromHolders(holderResult, creatorAddress) {
  if (!creatorAddress || !Array.isArray(holderResult?.holders)) return null;
  const row = holderResult.holders.find((holder) => normalizeAddress(holder?.address) === creatorAddress);
  return nonNegativeNumber(row?.holdingSharePercent);
}

function transactionSucceeded(transaction) {
  const status = String(transaction?.status ?? transaction?.result ?? '').trim().toLowerCase();
  return !['error', 'failed', 'failure', 'reverted'].includes(status);
}

function transactionTo(transaction) {
  return normalizeAddress(transaction?.to);
}

function createdContract(transaction) {
  return normalizeAddress(transaction?.created_contract ?? transaction?.createdContract);
}

function sourceLabel(value, fallback) {
  return String(value || fallback || '').trim().slice(0, 120) || null;
}

function confirmedSellability({ honeypot, cannotSellAll, inDex }) {
  if (honeypot === true) return false;
  if (honeypot === false && cannotSellAll === false && inDex === true) return true;
  return null;
}

function recentSellCount(market) {
  const direct = nonNegativeCount(market?.recentSellCount);
  if (direct !== null) return direct;
  const windows = market?.recentSellCounts;
  if (!windows || typeof windows !== 'object' || Array.isArray(windows)) return null;
  const counts = [windows.m5, windows.h1]
    .map(nonNegativeCount)
    .filter((value) => value !== null);
  return counts.length ? Math.max(...counts) : null;
}

function mergeSafetyValue(primary, fallback, { dangerWhenTrue = false, dangerWhenFalse = false } = {}) {
  const left = booleanFlag(primary);
  const right = booleanFlag(fallback);
  if (dangerWhenTrue && (left === true || right === true)) return true;
  if (dangerWhenFalse && (left === false || right === false)) return false;
  return left !== null ? left : right;
}

function mergeSafety(primary = {}, fallback = {}) {
  return {
    honeypot: mergeSafetyValue(primary.honeypot, fallback.honeypot, { dangerWhenTrue: true }),
    cannotSellAll: mergeSafetyValue(primary.cannotSellAll, fallback.cannotSellAll, { dangerWhenTrue: true }),
    inDex: mergeSafetyValue(primary.inDex, fallback.inDex, { dangerWhenFalse: true }),
    mintable: mergeSafetyValue(primary.mintable, fallback.mintable, { dangerWhenTrue: true }),
    openSource: mergeSafetyValue(primary.openSource, fallback.openSource, { dangerWhenFalse: true }),
    isProxy: mergeSafetyValue(primary.isProxy, fallback.isProxy, { dangerWhenTrue: true })
  };
}

function safetyNeedsFallback(safety = {}) {
  return ['honeypot', 'cannotSellAll', 'inDex', 'mintable', 'openSource', 'isProxy']
    .some((field) => booleanFlag(safety[field]) === null);
}

function normalizeGoPlusSafety(body, address) {
  if (Number(body?.code) !== 1 || !body?.result || typeof body.result !== 'object' ||
    Array.isArray(body.result)) {
    throw requestError('GoPlus returned an invalid token-security response', { retryable: false });
  }
  const matching = Object.entries(body.result).filter(([key]) => normalizeAddress(key) === address);
  if (matching.length !== 1 || !ADDRESS_PATTERN.test(normalizeAddress(matching[0][0]))) {
    throw requestError('GoPlus token-security response did not match the requested address', {
      retryable: false
    });
  }
  const row = matching[0][1];
  if (!row || typeof row !== 'object' || Array.isArray(row)) {
    throw requestError('GoPlus returned invalid token-security data', { retryable: false });
  }
  return {
    honeypot: booleanFlag(row.is_honeypot),
    cannotSellAll: booleanFlag(row.cannot_sell_all),
    inDex: booleanFlag(row.is_in_dex),
    mintable: booleanFlag(row.is_mintable),
    openSource: booleanFlag(row.is_open_source),
    isProxy: booleanFlag(row.is_proxy)
  };
}

function confirmedMintability({ mintable, openSource, proxy }) {
  if (mintable === true) return true;
  if (mintable === false && openSource === true && proxy === false) return false;
  return null;
}

function historyIsHighRisk(tokenCount, deadTokenCount, minimumTokens, deadRatio) {
  if (!Number.isFinite(tokenCount) || !Number.isFinite(deadTokenCount) || tokenCount < minimumTokens) {
    return false;
  }
  return tokenCount > 0 && deadTokenCount / tokenCount >= deadRatio;
}

export class RobinhoodTokenRiskClient {
  constructor({
    debotClient = null,
    marketClient = null,
    holderClient = null,
    blockscoutBaseUrl = DEFAULT_BLOCKSCOUT_URL,
    blockscoutLegacyUrl = null,
    rpcUrl = DEFAULT_ROBINHOOD_RPC_URL,
    goplusBaseUrl = DEFAULT_GOPLUS_TOKEN_SECURITY_URL,
    goplusChainId = ROBINHOOD_GOPLUS_CHAIN_ID,
    fetchImpl = globalThis.fetch,
    now = Date.now,
    requestTimeoutMs = 8_000,
    historyRequestTimeoutMs = 15_000,
    maxResponseBytes = 8 * 1024 * 1024,
    tokenCacheTtlMs = 60_000,
    creatorCacheTtlMs = 6 * 60 * 60_000,
    tokenCacheMaxEntries = DEFAULT_TOKEN_CACHE_MAX_ENTRIES,
    creatorCacheMaxEntries = DEFAULT_CREATOR_CACHE_MAX_ENTRIES,
    cacheSweepIntervalMs = DEFAULT_CACHE_SWEEP_INTERVAL_MS,
    creatorHistoryMaxPages = 4,
    creatorHistoryMaxTransactions = 200,
    creatorDirectDeploymentLimit = 50,
    creatorLaunchLogLimit = 1_000,
    creatorBlockTimestampLimit = 100,
    creatorFactoryRetryCount = 1,
    creatorFactoryRetryBaseMs = 350,
    creatorDeadAnalysisLimit = 90,
    lowLiquidityUsd = DEFAULT_RISK_THRESHOLDS.lowLiquidityUsd,
    holderConcentrationPercent = DEFAULT_RISK_THRESHOLDS.holderConcentrationPercent,
    creatorConcentrationPercent = DEFAULT_RISK_THRESHOLDS.creatorConcentrationPercent,
    badCreatorHistoryMinimumTokens = DEFAULT_RISK_THRESHOLDS.badCreatorHistoryMinimumTokens,
    badCreatorHistoryDeadRatio = DEFAULT_RISK_THRESHOLDS.badCreatorHistoryDeadRatio,
    deadMinimumAgeSeconds = DEFAULT_RISK_THRESHOLDS.deadMinimumAgeSeconds,
    deadLiquidityUsd = DEFAULT_RISK_THRESHOLDS.deadLiquidityUsd
  } = {}) {
    if (typeof fetchImpl !== 'function') throw new TypeError('fetchImpl is required');
    if (typeof now !== 'function') throw new TypeError('now must be a function');
    if (debotClient !== null && typeof debotClient?.fetchTokenSafety !== 'function') {
      throw new TypeError('debotClient.fetchTokenSafety is required');
    }
    if (marketClient !== null && typeof marketClient?.fetchTokenMetrics !== 'function' &&
      typeof marketClient?.fetchTokenMetricsBatch !== 'function') {
      throw new TypeError('marketClient token metrics method is required');
    }
    if (holderClient !== null && typeof holderClient?.fetchTopHolders !== 'function') {
      throw new TypeError('holderClient.fetchTopHolders is required');
    }
    this.debotClient = debotClient;
    this.marketClient = marketClient;
    this.holderClient = holderClient;
    this.blockscoutBaseUrl = String(blockscoutBaseUrl || DEFAULT_BLOCKSCOUT_URL).replace(/\/$/, '');
    const explorerUrl = new URL(this.blockscoutBaseUrl);
    explorerUrl.pathname = '/api';
    explorerUrl.search = '';
    this.blockscoutLegacyUrl = String(blockscoutLegacyUrl || explorerUrl).replace(/\/$/, '');
    this.rpcUrl = String(rpcUrl || DEFAULT_ROBINHOOD_RPC_URL);
    this.goplusBaseUrl = String(goplusBaseUrl || DEFAULT_GOPLUS_TOKEN_SECURITY_URL).replace(/\/$/, '');
    this.goplusChainId = boundedInteger(goplusChainId, ROBINHOOD_GOPLUS_CHAIN_ID, 1, 10_000_000);
    // Robinhood mainnet is chain 4663; accepting another chain here could cross-wire safety data.
    if (this.goplusChainId !== ROBINHOOD_GOPLUS_CHAIN_ID) {
      throw new RangeError(`GoPlus chain must be ${ROBINHOOD_GOPLUS_CHAIN_ID} for Robinhood`);
    }
    try {
      new URL(this.rpcUrl);
      new URL(this.goplusBaseUrl);
    } catch (error) {
      throw new TypeError('Robinhood RPC and GoPlus URLs must be absolute URLs', { cause: error });
    }
    this.fetchImpl = fetchImpl;
    this.now = now;
    this.requestTimeoutMs = boundedInteger(requestTimeoutMs, 8_000, 100, 60_000);
    this.historyRequestTimeoutMs = boundedInteger(historyRequestTimeoutMs, 15_000, 100, 60_000);
    this.maxResponseBytes = boundedInteger(maxResponseBytes, 8 * 1024 * 1024, 128, 32 * 1024 * 1024);
    this.tokenCacheTtlMs = boundedInteger(tokenCacheTtlMs, 60_000, 0, 60 * 60_000);
    this.creatorCacheTtlMs = boundedInteger(creatorCacheTtlMs, 6 * 60 * 60_000, 0, 7 * 24 * 60 * 60_000);
    this.tokenCacheMaxEntries = boundedInteger(
      tokenCacheMaxEntries,
      DEFAULT_TOKEN_CACHE_MAX_ENTRIES,
      1,
      100_000
    );
    this.creatorCacheMaxEntries = boundedInteger(
      creatorCacheMaxEntries,
      DEFAULT_CREATOR_CACHE_MAX_ENTRIES,
      1,
      100_000
    );
    this.cacheSweepIntervalMs = boundedInteger(
      cacheSweepIntervalMs,
      DEFAULT_CACHE_SWEEP_INTERVAL_MS,
      100,
      60 * 60_000
    );
    this.creatorHistoryMaxPages = boundedInteger(creatorHistoryMaxPages, 4, 1, 20);
    this.creatorHistoryMaxTransactions = boundedInteger(creatorHistoryMaxTransactions, 200, 1, 1_000);
    this.creatorDirectDeploymentLimit = boundedInteger(creatorDirectDeploymentLimit, 50, 1, 200);
    this.creatorLaunchLogLimit = boundedInteger(creatorLaunchLogLimit, 1_000, 1, 1_000);
    this.creatorBlockTimestampLimit = boundedInteger(creatorBlockTimestampLimit, 100, 1, 500);
    this.creatorFactoryRetryCount = boundedInteger(creatorFactoryRetryCount, 1, 0, 2);
    this.creatorFactoryRetryBaseMs = boundedInteger(creatorFactoryRetryBaseMs, 350, 0, 5_000);
    this.creatorDeadAnalysisLimit = boundedInteger(creatorDeadAnalysisLimit, 90, 1, 300);
    this.lowLiquidityUsd = Math.max(0, finiteNumber(lowLiquidityUsd) ?? DEFAULT_RISK_THRESHOLDS.lowLiquidityUsd);
    this.holderConcentrationPercent = Math.max(
      0,
      Math.min(100, finiteNumber(holderConcentrationPercent) ?? DEFAULT_RISK_THRESHOLDS.holderConcentrationPercent)
    );
    this.creatorConcentrationPercent = Math.max(
      0,
      Math.min(100, finiteNumber(creatorConcentrationPercent) ?? DEFAULT_RISK_THRESHOLDS.creatorConcentrationPercent)
    );
    this.badCreatorHistoryMinimumTokens = boundedInteger(
      badCreatorHistoryMinimumTokens,
      DEFAULT_RISK_THRESHOLDS.badCreatorHistoryMinimumTokens,
      1,
      1_000
    );
    this.badCreatorHistoryDeadRatio = Math.max(
      0,
      Math.min(1, finiteNumber(badCreatorHistoryDeadRatio) ?? DEFAULT_RISK_THRESHOLDS.badCreatorHistoryDeadRatio)
    );
    this.deadMinimumAgeSeconds = boundedInteger(deadMinimumAgeSeconds, 86_400, 60, 30 * 86_400);
    this.deadLiquidityUsd = Math.max(
      0,
      finiteNumber(deadLiquidityUsd) ?? DEFAULT_RISK_THRESHOLDS.deadLiquidityUsd
    );
    this.tokenCache = new Map();
    this.tokenInflight = new Map();
    this.creatorCache = new Map();
    this.creatorInflight = new Map();
    this.cacheNextSweepAt = new Map([
      [this.tokenCache, 0],
      [this.creatorCache, 0]
    ]);
  }

  async #requestJson(input, {
    signal,
    timeoutMs = this.requestTimeoutMs,
    expected = 'object',
    source = 'Blockscout'
  } = {}) {
    throwIfAborted(signal);
    const response = await this.fetchImpl(String(input), {
      signal: signalWithTimeout(signal, timeoutMs),
      headers: { accept: 'application/json' }
    });
    const text = await limitedResponseText(response, this.maxResponseBytes, source);
    if (!response.ok) {
      throw requestError(`${source} request failed with HTTP ${response.status}`, {
        status: response.status,
        retryable: response.status === 408 || response.status === 429 || response.status >= 500
      });
    }
    let body;
    try {
      body = JSON.parse(text);
    } catch (error) {
      throw requestError(`${source} returned unreadable JSON`, { cause: error });
    }
    const valid = expected === 'array'
      ? Array.isArray(body)
      : body && typeof body === 'object' && !Array.isArray(body);
    if (!valid) throw requestError(`${source} returned an invalid response`, { retryable: false });
    return body;
  }

  async #requestRpc(method, params, signal) {
    throwIfAborted(signal);
    const response = await this.fetchImpl(this.rpcUrl, {
      method: 'POST',
      signal: signalWithTimeout(signal, this.historyRequestTimeoutMs),
      headers: {
        accept: 'application/json',
        'content-type': 'application/json'
      },
      body: JSON.stringify({ jsonrpc: '2.0', id: 1, method, params })
    });
    const text = await limitedResponseText(response, this.maxResponseBytes, 'Robinhood RPC');
    if (!response.ok) {
      throw requestError(`Robinhood RPC request failed with HTTP ${response.status}`, {
        status: response.status,
        retryable: response.status === 408 || response.status === 429 || response.status >= 500
      });
    }
    let body;
    try {
      body = JSON.parse(text);
    } catch (error) {
      throw requestError('Robinhood RPC returned unreadable JSON', { cause: error });
    }
    if (!body || typeof body !== 'object' || Array.isArray(body) || body.error || !('result' in body)) {
      const detail = compactError(body?.error?.message || body?.error || 'invalid response');
      throw requestError(`Robinhood RPC ${method} failed: ${detail}`, {
        retryable: body?.error?.code === -32005 || /limit|rate|timeout|temporar/i.test(detail)
      });
    }
    return body.result;
  }

  async #callDependency(operation, { signal, timeoutMs = this.requestTimeoutMs } = {}) {
    throwIfAborted(signal);
    return operation(signalWithTimeout(signal, timeoutMs));
  }

  async #capture(label, operation, signal) {
    try {
      return { label, value: await operation(), error: null };
    } catch (error) {
      if (signal?.aborted) throw abortReason(signal);
      return { label, value: null, error };
    }
  }

  async #fetchGoPlusSafety(address, signal) {
    const url = new URL(`${this.goplusBaseUrl}/${this.goplusChainId}`);
    url.searchParams.set('contract_addresses', address);
    const body = await this.#requestJson(url, { signal, source: 'GoPlus' });
    return normalizeGoPlusSafety(body, address);
  }

  async #fetchCombinedSafety(address, signal) {
    const debotResult = await this.#capture('debot_safety', () => this.debotClient
      ? this.#callDependency(
          (requestSignal) => this.debotClient.fetchTokenSafety(address, { signal: requestSignal }),
          { signal }
        )
      : null, signal);
    const debotSafety = debotResult.value || {};
    let goplusResult = { label: 'goplus_safety', value: null, error: null };
    if (!this.debotClient || debotResult.error || safetyNeedsFallback(debotSafety)) {
      goplusResult = await this.#capture(
        'goplus_safety',
        () => this.#fetchGoPlusSafety(address, signal),
        signal
      );
    }
    const errors = [debotResult, goplusResult]
      .filter((result) => result.error)
      .map((result) => `${result.label}: ${compactError(result.error)}`);
    if (!debotResult.value && !goplusResult.value && errors.length) {
      throw requestError(errors.join(' | '), {
        retryable: [debotResult.error, goplusResult.error]
          .filter(Boolean)
          .some((error) => error?.retryable !== false)
      });
    }
    return {
      safety: mergeSafety(debotSafety, goplusResult.value || {}),
      errors,
      usedGoPlus: Boolean(goplusResult.value)
    };
  }

  async #fetchMarketMetrics(address, signal) {
    if (!this.marketClient) return null;
    return this.#callDependency(async (requestSignal) => {
      if (typeof this.marketClient.fetchTokenMetrics === 'function') {
        return this.marketClient.fetchTokenMetrics(address, { signal: requestSignal });
      }
      const result = await this.marketClient.fetchTokenMetricsBatch([address], { signal: requestSignal });
      return mapBatchResult(result, [address]).get(address) || null;
    }, { signal });
  }

  async #resolveFactoryCreationContext(address, signal) {
    const rows = await this.#requestRpc('eth_getLogs', [{
      address: [...LAUNCH_FACTORIES],
      fromBlock: '0x0',
      toBlock: 'latest',
      topics: [TOKEN_LAUNCHED_TOPIC, topicForAddress(address)]
    }], signal);
    if (!Array.isArray(rows)) {
      throw requestError('Robinhood RPC creation log query returned invalid results', { retryable: false });
    }
    if (rows.length === 0) return null;
    const records = rows.map((log) => {
      const topics = Array.isArray(log?.topics) ? log.topics.map((topic) => String(topic).toLowerCase()) : [];
      const factoryAddress = normalizeAddress(log?.address);
      const creatorAddress = addressFromTopic(topics[2]);
      const transactionHash = normalizeHash(log?.transactionHash);
      const blockNumber = String(log?.blockNumber || '').trim().toLowerCase();
      if (!LAUNCH_FACTORIES.includes(factoryAddress) || topics[0] !== TOKEN_LAUNCHED_TOPIC ||
        addressFromTopic(topics[1]) !== address || !ADDRESS_PATTERN.test(creatorAddress) ||
        !HASH_PATTERN.test(transactionHash) || !/^0x[0-9a-f]+$/.test(blockNumber)) {
        const error = requestError('Robinhood RPC returned an inconsistent token creation log', {
          retryable: false
        });
        error.creationContextConflict = true;
        throw error;
      }
      return {
        factoryAddress,
        creatorAddress,
        transactionHash,
        blockNumber,
        logIndex: String(log?.logIndex || '').trim().toLowerCase()
      };
    });
    const unique = new Map(records.map((record) => [
      `${record.transactionHash}:${record.blockNumber}:${record.logIndex}:${record.factoryAddress}:${record.creatorAddress}`,
      record
    ]));
    if (unique.size !== 1) {
      const error = requestError('Robinhood RPC returned multiple token creation logs', { retryable: false });
      error.creationContextConflict = true;
      throw error;
    }
    const record = unique.values().next().value;
    let tokenCreationTimestamp = null;
    const errors = [];
    try {
      const block = await this.#requestRpc('eth_getBlockByNumber', [record.blockNumber, false], signal);
      tokenCreationTimestamp = unixSeconds(block?.timestamp);
      if (tokenCreationTimestamp === null) {
        errors.push('creation_block_timestamp: Robinhood RPC returned an invalid block timestamp');
      }
    } catch (error) {
      if (signal?.aborted) throw abortReason(signal);
      errors.push(`creation_block_timestamp: ${compactError(error)}`);
    }
    return {
      context: {
        tokenAddress: address,
        creatorAddress: record.creatorAddress,
        creatorAddressSource: 'robinhood_rpc_token_launched_log',
        contractCreatorAddress: record.factoryAddress,
        creationTransactionHash: record.transactionHash,
        createdContractAddress: address,
        deploymentKind: 'factory',
        factoryAddress: record.factoryAddress,
        creationMethod: 'TokenLaunched',
        tokenCreationTimestamp
      },
      errors
    };
  }

  async #resolveCreationContext(address, signal) {
    let rpcError = null;
    try {
      const factoryContext = await this.#resolveFactoryCreationContext(address, signal);
      if (factoryContext) return factoryContext;
    } catch (error) {
      if (signal?.aborted) throw abortReason(signal);
      if (error?.creationContextConflict) throw error;
      rpcError = error;
    }

    let details;
    try {
      details = await this.#requestJson(
        `${this.blockscoutBaseUrl}/addresses/${encodeURIComponent(address)}`,
        { signal }
      );
    } catch (error) {
      if (signal?.aborted) throw abortReason(signal);
      const rpcDetail = rpcError ? `${compactError(rpcError)} | ` : '';
      throw requestError(
        `Creation lookup failed: ${rpcDetail}${compactError(error)}`,
        { retryable: rpcError?.retryable !== false || error?.retryable !== false }
      );
    }
    const contractCreatorAddress = normalizeAddress(details.creator_address_hash);
    const creationTransactionHash = normalizeHash(details.creation_transaction_hash);
    let transaction = null;
    const errors = [];
    if (HASH_PATTERN.test(creationTransactionHash)) {
      try {
        transaction = await this.#requestJson(
          `${this.blockscoutBaseUrl}/transactions/${encodeURIComponent(creationTransactionHash)}`,
          { signal }
        );
      } catch (error) {
        if (signal?.aborted) throw abortReason(signal);
        errors.push(`creation_transaction: ${compactError(error)}`);
      }
    }
    const transactionSender = normalizeAddress(transaction?.from);
    const creatorAddress = ADDRESS_PATTERN.test(transactionSender)
      ? transactionSender
      : ADDRESS_PATTERN.test(contractCreatorAddress)
        ? contractCreatorAddress
        : null;
    const factoryAddress = transactionTo(transaction);
    const createdContractAddress = createdContract(transaction);
    return {
      context: {
        tokenAddress: address,
        creatorAddress,
        creatorAddressSource: ADDRESS_PATTERN.test(transactionSender)
          ? 'blockscout_creation_transaction_sender'
          : creatorAddress
            ? 'blockscout_contract_creator'
            : null,
        contractCreatorAddress: ADDRESS_PATTERN.test(contractCreatorAddress) ? contractCreatorAddress : null,
        creationTransactionHash: HASH_PATTERN.test(creationTransactionHash) ? creationTransactionHash : null,
        createdContractAddress: ADDRESS_PATTERN.test(createdContractAddress) ? createdContractAddress : null,
        deploymentKind: ADDRESS_PATTERN.test(factoryAddress) ? 'factory' : transaction ? 'direct' : 'unknown',
        factoryAddress: ADDRESS_PATTERN.test(factoryAddress) ? factoryAddress : null,
        creationMethod: String(transaction?.method || '').trim().slice(0, 120) || null,
        tokenCreationTimestamp: unixSeconds(transaction?.timestamp)
      },
      errors
    };
  }

  async #fetchCreatorHolding(address, creatorAddress, holderResult, signal) {
    const holderShare = creatorShareFromHolders(holderResult, creatorAddress);
    if (holderShare !== null) return { percent: holderShare, source: 'blockscout_top_holders' };
    try {
      const balanceData = `0x70a08231${creatorAddress.slice(2).padStart(64, '0')}`;
      const [balanceHex, supplyHex] = await Promise.all([
        this.#requestRpc('eth_call', [{ to: address, data: balanceData }, 'latest'], signal),
        this.#requestRpc('eth_call', [{ to: address, data: '0x18160ddd' }, 'latest'], signal)
      ]);
      const balance = rpcUint256(balanceHex, 'balanceOf result');
      const supply = rpcUint256(supplyHex, 'totalSupply result');
      if (BigInt(supply) <= 0n) {
        throw requestError('Robinhood RPC returned a zero totalSupply', { retryable: false });
      }
      return {
        percent: percentFromRawBalance(balance, supply),
        source: 'robinhood_rpc_balance_of_total_supply'
      };
    } catch (error) {
      if (signal?.aborted) throw abortReason(signal);
      // Non-standard tokens and transient RPC failures retain the existing explorer fallback.
    }
    const rows = await this.#requestJson(
      `${this.blockscoutBaseUrl}/addresses/${encodeURIComponent(creatorAddress)}/token-balances`,
      { signal, expected: 'array' }
    );
    const balance = rows.find((row) => normalizeAddress(row?.token) === address);
    if (!balance) return { percent: 0, source: 'blockscout_address_token_balances' };
    return {
      percent: percentFromRawBalance(balance.value, balance?.token?.total_supply),
      source: 'blockscout_address_token_balances'
    };
  }

  #pruneCache(cache, maxEntries, { force = false } = {}) {
    const now = this.now();
    if (force || now >= (this.cacheNextSweepAt.get(cache) || 0)) {
      for (const [key, entry] of cache) {
        if (entry.expiresAt <= now) cache.delete(key);
      }
      this.cacheNextSweepAt.set(cache, now + this.cacheSweepIntervalMs);
    }
    while (cache.size > maxEntries) {
      const oldestKey = cache.keys().next().value;
      if (oldestKey === undefined) break;
      cache.delete(oldestKey);
    }
  }

  #cacheGet(cache, key, maxEntries) {
    this.#pruneCache(cache, maxEntries);
    const cached = cache.get(key);
    if (!cached) return null;
    if (cached.expiresAt <= this.now()) {
      cache.delete(key);
      return null;
    }
    // Refresh insertion order so capacity eviction approximates LRU.
    cache.delete(key);
    cache.set(key, cached);
    return cloneResult(cached.value);
  }

  #cacheSet(cache, key, value, ttlMs, maxEntries) {
    cache.delete(key);
    cache.set(key, { value: cloneResult(value), expiresAt: this.now() + ttlMs });
    this.#pruneCache(cache, maxEntries, { force: cache.size > maxEntries });
  }

  async #awaitShared(inflight, key, signal, operation, onSuccess) {
    let entry = inflight.get(key);
    if (entry?.controller?.signal?.aborted && !entry.settled) {
      if (inflight.get(key) === entry) inflight.delete(key);
      entry = null;
    }
    if (!entry) {
      const controller = new AbortController();
      entry = { controller, promise: null, waiters: 0, settled: false };
      entry.promise = Promise.resolve()
        .then(() => operation(controller.signal))
        .then((result) => {
          onSuccess?.(result);
          return result;
        })
        .finally(() => {
          entry.settled = true;
          if (inflight.get(key) === entry) inflight.delete(key);
        });
      inflight.set(key, entry);
    }
    entry.waiters += 1;
    try {
      return await awaitWithSignal(entry.promise, signal);
    } finally {
      entry.waiters = Math.max(0, entry.waiters - 1);
      if (!entry.settled && entry.waiters === 0) {
        entry.controller.abort(abortReason(signal, 'Robinhood token risk request has no active callers'));
      }
    }
  }

  async fetchTokenRiskSummary(tokenAddress, { signal, force = false } = {}) {
    const address = requireAddress(tokenAddress);
    throwIfAborted(signal);
    const cached = force ? null : this.#cacheGet(this.tokenCache, address, this.tokenCacheMaxEntries);
    if (cached) return cached;
    const result = await this.#awaitShared(
      this.tokenInflight,
      address,
      signal,
      (requestSignal) => this.#fetchTokenRiskSummary(address, requestSignal),
      (summary) => this.#cacheSet(
        this.tokenCache,
        address,
        summary,
        this.tokenCacheTtlMs,
        this.tokenCacheMaxEntries
      )
    );
    return cloneResult(result);
  }

  async #fetchTokenRiskSummary(address, signal) {
    const [safetyResult, marketResult, holderResult, creationResult] = await Promise.all([
      this.#capture('safety', () => this.#fetchCombinedSafety(address, signal), signal),
      this.#capture('market', () => this.#fetchMarketMetrics(address, signal), signal),
      this.#capture('holders', () => this.holderClient
        ? this.#callDependency(
            (requestSignal) => this.holderClient.fetchTopHolders(address, { limit: 50, signal: requestSignal }),
            { signal }
          )
        : null, signal),
      this.#capture('creation', () => this.#resolveCreationContext(address, signal), signal)
    ]);
    throwIfAborted(signal);

    const safety = safetyResult.value?.safety || null;
    const market = marketResult.value;
    const holders = holderResult.value;
    const creation = creationResult.value;
    const honeypot = booleanFlag(safety?.honeypot ?? safety?.goplus?.is_honeypot);
    const cannotSellAll = booleanFlag(safety?.cannotSellAll ?? safety?.goplus?.cannot_sell_all);
    const inDex = booleanFlag(safety?.inDex ?? safety?.goplus?.is_in_dex);
    const mintableSignal = booleanFlag(
      safety?.mintable ?? safety?.canMintMore ??
      safety?.goplus?.ownership_detail?.is_mintable ?? safety?.goplus?.is_mintable
    );
    const openSource = booleanFlag(
      safety?.openSource ?? safety?.isOpenSource ?? safety?.goplus?.is_open_source
    );
    const proxy = booleanFlag(
      safety?.isProxy ?? safety?.proxy ?? safety?.goplus?.is_proxy
    );
    const sellable = confirmedSellability({ honeypot, cannotSellAll, inDex });
    const sells = recentSellCount(market);
    const recentSalesOnly = sellable === null && honeypot !== true && cannotSellAll !== true &&
      inDex !== false && sells > 0;
    const resolvedSellable = recentSalesOnly ? true : sellable;
    const canMintMore = confirmedMintability({ mintable: mintableSignal, openSource, proxy });
    const liquidityUsd = nonNegativeNumber(market?.liquidityUsd);
    const top10 = topHolderSummary(holders, market);
    const creatorContext = {
      ...(creation?.context || { tokenAddress: address }),
      tokenAddress: address,
      tokenCreationTimestamp: creation?.context?.tokenCreationTimestamp ?? unixSeconds(market?.creationTimestamp)
    };
    const creatorAddress = ADDRESS_PATTERN.test(normalizeAddress(creatorContext.creatorAddress))
      ? normalizeAddress(creatorContext.creatorAddress)
      : null;
    creatorContext.creatorAddress = creatorAddress;

    let creatorHolding = { percent: null, source: null };
    let creatorHoldingError = null;
    if (creatorAddress) {
      try {
        creatorHolding = await this.#fetchCreatorHolding(address, creatorAddress, holders, signal);
      } catch (error) {
        if (signal?.aborted) throw abortReason(signal);
        creatorHoldingError = error;
      }
    }

    const errors = [safetyResult, marketResult, holderResult, creationResult]
      .filter((result) => result.error)
      .map((result) => `${result.label}: ${compactError(result.error)}`);
    errors.push(...(safetyResult.value?.errors || []));
    errors.push(...(creation?.errors || []));
    if (creatorHoldingError) errors.push(`creator_holding: ${compactError(creatorHoldingError)}`);

    const flags = [];
    if (resolvedSellable === false) flags.push('unsellable');
    else if (recentSalesOnly) flags.push('sellability_recent_sales_only');
    else if (resolvedSellable === null) flags.push('sellability_unknown');
    if (cannotSellAll === true) flags.push('cannot_sell_all');
    if (inDex === false) flags.push('not_in_dex');
    if (liquidityUsd === null) flags.push('liquidity_unknown');
    else if (liquidityUsd < this.lowLiquidityUsd) flags.push('low_liquidity');
    if (top10.percent === null) flags.push('top10_holders_unknown');
    else if (top10.percent >= this.holderConcentrationPercent) flags.push('holder_concentration');
    if (top10.partial) flags.push('top10_holders_partial');
    if (!creatorAddress) flags.push('creator_unknown');
    if (creatorAddress && creatorHolding.percent === null) flags.push('creator_holding_unknown');
    else if (creatorHolding.percent >= this.creatorConcentrationPercent) flags.push('creator_concentration');
    if (canMintMore === true) flags.push('mintable');
    else if (canMintMore === null) flags.push('mintability_unknown');

    const sources = {
      sellable: resolvedSellable === null
        ? null
        : recentSalesOnly
          ? 'dexscreener_recent_sales'
          : 'debot_goplus_sellability_composite',
      liquidity: liquidityUsd === null ? null : sourceLabel(market?.source, 'market_client'),
      top10Holders: top10.percent === null ? null : sourceLabel(holders?.source, 'blockscout'),
      creator: creatorContext.creatorAddressSource || null,
      creatorHolding: creatorHolding.percent === null ? null : creatorHolding.source,
      canMintMore: canMintMore === null ? null : 'debot_goplus_mintability_composite'
    };
    const sourceList = [...new Set(Object.values(sources).filter(Boolean))];
    const fields = [
      resolvedSellable,
      liquidityUsd,
      top10.percent,
      creatorAddress,
      creatorHolding.percent,
      canMintMore
    ];
    const availableFields = fields.filter((value) => value !== null && value !== undefined).length;
    const tokenRiskStatus = availableFields === fields.length
      ? 'ready'
      : availableFields > 0
        ? 'partial'
        : errors.length
          ? 'error'
          : 'unavailable';

    return {
      tokenAddress: address,
      sellable: resolvedSellable,
      liquidityUsd,
      top10HolderPercent: top10.percent,
      top10HolderCount: top10.count,
      top10HolderPartial: top10.partial,
      creatorAddress,
      creatorHoldingPercent: creatorHolding.percent,
      canMintMore,
      tokenRiskStatus,
      tokenRiskDataAt: Math.floor(this.now() / 1_000),
      tokenRiskSource: sourceList.length ? sourceList.join('+') : null,
      tokenRiskSources: sources,
      tokenRiskFlags: [...new Set(flags)],
      tokenRiskError: errors.join(' | ') || null,
      creatorContext
    };
  }

  #historyCacheKey(context) {
    return requireAddress(context?.creatorAddress, 'creator');
  }

  #deadTokenDefinition() {
    const age = this.deadMinimumAgeSeconds === 86_400
      ? '24h'
      : `${this.deadMinimumAgeSeconds}s`;
    return `age>=${age} && (no_dexscreener_pair || primary_liquidity_usd<${this.deadLiquidityUsd})`;
  }

  async fetchCreatorHistory(tokenAddress, { creatorContext = null, signal, force = false } = {}) {
    const address = requireAddress(tokenAddress);
    throwIfAborted(signal);
    let context = creatorContext;
    if (context?.tokenAddress && normalizeAddress(context.tokenAddress) !== address) {
      throw new TypeError('creatorContext token does not match the requested token');
    }
    if (!ADDRESS_PATTERN.test(normalizeAddress(context?.creatorAddress))) {
      context = (await this.fetchTokenRiskSummary(address, { signal })).creatorContext;
    }
    const creatorAddress = normalizeAddress(context?.creatorAddress);
    if (!ADDRESS_PATTERN.test(creatorAddress)) {
      return {
        tokenAddress: address,
        creatorAddress: null,
        creatorTokenCount: null,
        creatorDeadTokenCount: null,
        creatorHistoryPartial: true,
        creatorHistoryDataAt: Math.floor(this.now() / 1_000),
        creatorHistorySource: null,
        creatorHistoryFlags: ['creator_unknown'],
        creatorHistoryError: null,
        deadDefinition: this.#deadTokenDefinition()
      };
    }
    context = { ...context, tokenAddress: address, creatorAddress };
    const key = this.#historyCacheKey(context);
    let base = force ? null : this.#cacheGet(this.creatorCache, key, this.creatorCacheMaxEntries);
    if (!base) {
      base = await this.#awaitShared(
        this.creatorInflight,
        key,
        signal,
        (requestSignal) => this.#fetchCreatorHistoryBase(creatorAddress, requestSignal),
        (result) => {
          const sourceFailed = result?._creatorHistoryFlags?.includes('history_source_failed');
          if (result?._creatorHistoryAvailable === true && !sourceFailed) {
            this.#cacheSet(
              this.creatorCache,
              key,
              result,
              this.creatorCacheTtlMs,
              this.creatorCacheMaxEntries
            );
          }
        }
      );
    }
    const materializedBase = cloneResult(base);
    const result = await this.#materializeCreatorHistory(address, context, materializedBase, signal);
    const sourceFailed = materializedBase?._creatorHistoryFlags?.includes('history_source_failed');
    if (materializedBase?._creatorHistoryAvailable === true && !sourceFailed) {
      this.#cacheSet(
        this.creatorCache,
        key,
        materializedBase,
        this.creatorCacheTtlMs,
        this.creatorCacheMaxEntries
      );
    }
    return result;
  }

  #launchRecord(log, factoryAddress, creatorAddress, source) {
    const topics = Array.isArray(log?.topics) ? log.topics.map((topic) => String(topic).toLowerCase()) : [];
    if (topics[0] !== TOKEN_LAUNCHED_TOPIC || addressFromTopic(topics[2]) !== creatorAddress) return null;
    if (normalizeAddress(log?.address) !== factoryAddress) return null;
    const tokenAddress = addressFromTopic(topics[1]);
    if (!tokenAddress) return null;
    const blockNumber = String(log?.blockNumber || '').trim().toLowerCase();
    return {
      tokenAddress,
      createdAt: unixSeconds(log?.blockTimestamp ?? log?.timeStamp ?? log?.timestamp),
      blockNumber: /^0x[0-9a-f]+$/.test(blockNumber) ? blockNumber : null,
      transactionHash: HASH_PATTERN.test(normalizeHash(log?.transactionHash))
        ? normalizeHash(log.transactionHash)
        : null,
      factoryAddress,
      source
    };
  }

  async #queryLaunchFactoryRpc(factoryAddress, creatorAddress, signal) {
    const rows = await this.#requestRpc('eth_getLogs', [{
      address: factoryAddress,
      fromBlock: '0x0',
      toBlock: 'latest',
      topics: [TOKEN_LAUNCHED_TOPIC, null, topicForAddress(creatorAddress)]
    }], signal);
    if (!Array.isArray(rows)) {
      throw requestError('Robinhood RPC eth_getLogs returned invalid results', { retryable: false });
    }
    return {
      records: rows.slice(0, this.creatorLaunchLogLimit)
        .map((log) => this.#launchRecord(
          log,
          factoryAddress,
          creatorAddress,
          'robinhood_rpc_token_launched_log'
        ))
        .filter(Boolean),
      partial: rows.length >= this.creatorLaunchLogLimit,
      source: 'robinhood_rpc_token_launched_logs'
    };
  }

  async #queryLaunchFactoryLegacy(factoryAddress, creatorAddress, signal) {
    const url = new URL(this.blockscoutLegacyUrl);
    url.searchParams.set('module', 'logs');
    url.searchParams.set('action', 'getLogs');
    url.searchParams.set('address', factoryAddress);
    url.searchParams.set('fromBlock', '0');
    url.searchParams.set('toBlock', 'latest');
    url.searchParams.set('topic0', TOKEN_LAUNCHED_TOPIC);
    url.searchParams.set('topic2', topicForAddress(creatorAddress));
    url.searchParams.set('topic0_2_opr', 'and');
    url.searchParams.set('page', '1');
    url.searchParams.set('offset', String(this.creatorLaunchLogLimit));
    const body = await this.#requestJson(url, {
      signal,
      timeoutMs: this.historyRequestTimeoutMs
    });
    if (String(body.status) === '0' && !Array.isArray(body.result)) {
      if (/no (?:logs|records|transactions) found/i.test(String(body.message || body.result || ''))) {
        return {
          records: [],
          partial: false,
          source: 'blockscout_token_launched_logs'
        };
      }
      throw requestError(`Blockscout log query failed: ${compactError(body.result || body.message)}`);
    }
    if (!Array.isArray(body.result)) throw requestError('Blockscout log query returned invalid results');
    const rows = body.result.slice(0, this.creatorLaunchLogLimit);
    const records = rows.map((log) => this.#launchRecord(
      log,
      factoryAddress,
      creatorAddress,
      'blockscout_token_launched_log'
    )).filter(Boolean);
    return {
      records,
      partial: body.result.length >= this.creatorLaunchLogLimit,
      source: 'blockscout_token_launched_logs'
    };
  }

  async #queryLaunchFactory(factoryAddress, creatorAddress, signal) {
    try {
      return await this.#queryLaunchFactoryRpc(factoryAddress, creatorAddress, signal);
    } catch (rpcError) {
      if (signal?.aborted) throw abortReason(signal);
      let lastError = rpcError;
      for (let attempt = 0; attempt <= this.creatorFactoryRetryCount; attempt += 1) {
        if (attempt > 0) {
          await delayWithSignal(this.creatorFactoryRetryBaseMs * attempt, signal);
        }
        try {
          return await this.#queryLaunchFactoryLegacy(factoryAddress, creatorAddress, signal);
        } catch (error) {
          if (signal?.aborted) throw abortReason(signal);
          lastError = error;
          if (error?.retryable === false) break;
        }
      }
      throw requestError(
        `RPC and Blockscout factory queries failed: ${compactError(rpcError)} | ${compactError(lastError)}`,
        { retryable: lastError?.retryable !== false }
      );
    }
  }

  async #enrichLaunchTimestamps(records, signal) {
    const missing = records.filter((record) => !Number.isSafeInteger(record.createdAt));
    const blockNumbers = [...new Set(missing
      .map((record) => record.blockNumber)
      .filter((value) => /^0x[0-9a-f]+$/.test(String(value || ''))))];
    const selected = blockNumbers.slice(0, this.creatorBlockTimestampLimit);
    let partial = blockNumbers.length > selected.length;
    const timestamps = new Map();
    const results = await mapLimit(selected, 2, async (blockNumber) => {
      try {
        const block = await this.#requestRpc('eth_getBlockByNumber', [blockNumber, false], signal);
        return { blockNumber, timestamp: unixSeconds(block?.timestamp), failed: false };
      } catch (error) {
        if (signal?.aborted) throw abortReason(signal);
        return { blockNumber, timestamp: null, failed: true };
      }
    });
    for (const result of results) {
      if (result.timestamp !== null) timestamps.set(result.blockNumber, result.timestamp);
      if (result.failed || result.timestamp === null) partial = true;
    }
    const enriched = records.map((record) => ({
      ...record,
      createdAt: record.createdAt ?? timestamps.get(record.blockNumber) ?? null
    }));
    if (enriched.some((record) => !Number.isSafeInteger(record.createdAt))) partial = true;
    return { records: enriched, partial };
  }

  async #listLaunchDeployments(creatorAddress, signal) {
    const results = [];
    // Querying both historical ranges at once caused the public explorer to rate-limit itself.
    for (const factoryAddress of LAUNCH_FACTORIES) {
      results.push(await this.#capture(
        `factory_${factoryAddress}`,
        () => this.#queryLaunchFactory(factoryAddress, creatorAddress, signal),
        signal
      ));
    }
    const successful = results.filter((result) => !result.error);
    const errors = results
      .filter((result) => result.error)
      .map((result) => `${result.label}: ${compactError(result.error)}`);
    if (!successful.length) {
      throw requestError(`All known launch-factory queries failed: ${errors.join(' | ')}`);
    }
    const recordsByAddress = new Map();
    for (const result of successful) {
      for (const record of result.value.records) recordsByAddress.set(record.tokenAddress, record);
    }
    const timestampResult = await this.#enrichLaunchTimestamps([...recordsByAddress.values()], signal);
    return {
      records: timestampResult.records,
      partial: errors.length > 0 || timestampResult.partial ||
        successful.some((result) => result.value.partial),
      errors,
      sources: [...new Set(successful.map((result) => result.value.source).filter(Boolean))]
    };
  }

  async #validateDirectDeployment(record, signal) {
    try {
      const token = await this.#requestJson(
        `${this.blockscoutBaseUrl}/tokens/${encodeURIComponent(record.tokenAddress)}`,
        { signal, timeoutMs: this.historyRequestTimeoutMs }
      );
      return String(token?.type || '').toUpperCase() === 'ERC-20'
        ? { record, failed: false }
        : { record: null, failed: false };
    } catch (error) {
      if (signal?.aborted) throw abortReason(signal);
      if (Number(error?.status) === 404) return { record: null, failed: false };
      return { record: null, failed: true, error };
    }
  }

  async #listDirectDeployments(creatorAddress, signal) {
    const records = [];
    let cursor = null;
    let pages = 0;
    let transactions = 0;
    let partial = false;
    let previousCursor = '';
    while (pages < this.creatorHistoryMaxPages && transactions < this.creatorHistoryMaxTransactions) {
      const base = new URL(`${this.blockscoutBaseUrl}/addresses/${encodeURIComponent(creatorAddress)}/transactions`);
      base.searchParams.set('filter', 'from');
      const body = await this.#requestJson(blockscoutCursorUrl(base, cursor), {
        signal,
        timeoutMs: this.historyRequestTimeoutMs
      });
      const items = Array.isArray(body.items) ? body.items : [];
      pages += 1;
      for (const transaction of items) {
        transactions += 1;
        if (transactions > this.creatorHistoryMaxTransactions) {
          partial = true;
          break;
        }
        if (normalizeAddress(transaction?.from) !== creatorAddress || !transactionSucceeded(transaction)) continue;
        const tokenAddress = createdContract(transaction);
        if (!ADDRESS_PATTERN.test(tokenAddress)) continue;
        records.push({
          tokenAddress,
          createdAt: unixSeconds(transaction?.timestamp),
          transactionHash: HASH_PATTERN.test(normalizeHash(transaction?.hash))
            ? normalizeHash(transaction.hash)
            : null,
          factoryAddress: null,
          source: 'blockscout_direct_contract_creation'
        });
      }
      cursor = body.next_page_params || null;
      if (!cursor) break;
      const serialized = JSON.stringify(cursor);
      if (serialized === previousCursor) {
        partial = true;
        break;
      }
      previousCursor = serialized;
    }
    if (cursor) partial = true;
    if (records.length > this.creatorDirectDeploymentLimit) partial = true;
    const candidates = records.slice(0, this.creatorDirectDeploymentLimit);
    const validated = await mapLimit(candidates, 3, (record) => this.#validateDirectDeployment(record, signal));
    if (validated.some((result) => result.failed)) partial = true;
    return {
      records: validated.map((result) => result.record).filter(Boolean),
      partial
    };
  }

  async #fetchHistoryMetrics(records, signal) {
    const metrics = new Map();
    const failures = new Set();
    if (!this.marketClient || !records.length) {
      for (const record of records) failures.add(record.tokenAddress);
      return { metrics, failures };
    }
    const addresses = records.map((record) => record.tokenAddress);
    if (typeof this.marketClient.fetchTokenMetricsBatch === 'function') {
      for (let index = 0; index < addresses.length; index += 30) {
        const batch = addresses.slice(index, index + 30);
        try {
          const result = await this.#callDependency(
            (requestSignal) => this.marketClient.fetchTokenMetricsBatch(batch, { signal: requestSignal }),
            { signal, timeoutMs: this.historyRequestTimeoutMs }
          );
          const normalized = mapBatchResult(result, batch);
          for (const address of batch) {
            if (normalized.has(address)) metrics.set(address, normalized.get(address));
            else failures.add(address);
          }
        } catch (error) {
          if (signal?.aborted) throw abortReason(signal);
          for (const address of batch) failures.add(address);
        }
      }
      return { metrics, failures };
    }
    const results = await mapLimit(addresses, 3, async (address) => {
      try {
        return {
          address,
          value: await this.#callDependency(
            (requestSignal) => this.marketClient.fetchTokenMetrics(address, { signal: requestSignal }),
            { signal, timeoutMs: this.historyRequestTimeoutMs }
          )
        };
      } catch (error) {
        if (signal?.aborted) throw abortReason(signal);
        return { address, value: null };
      }
    });
    for (const result of results) {
      if (result.value) metrics.set(result.address, result.value);
      else failures.add(result.address);
    }
    return { metrics, failures };
  }

  async #deadTokenCount(records, signal) {
    const now = Math.floor(this.now() / 1_000);
    let partial = false;
    const oldEnough = records.filter((record) => {
      if (!Number.isSafeInteger(record.createdAt) || record.createdAt <= 0) {
        partial = true;
        return false;
      }
      return now - record.createdAt >= this.deadMinimumAgeSeconds;
    });
    if (oldEnough.length > this.creatorDeadAnalysisLimit) partial = true;
    const selected = oldEnough.slice(0, this.creatorDeadAnalysisLimit);
    const { metrics, failures } = await this.#fetchHistoryMetrics(selected, signal);
    if (failures.size) partial = true;
    let count = 0;
    for (const record of selected) {
      const market = metrics.get(record.tokenAddress);
      if (!market) continue;
      const liquidity = nonNegativeNumber(market?.liquidityUsd);
      const pairCount = finiteNumber(market?.pairCount);
      const noPair = market?.noPair === true || pairCount === 0 || (
        sourceLabel(market?.source, '') === 'dexscreener_robinhood' &&
        !ADDRESS_PATTERN.test(normalizeAddress(market?.primaryPoolAddress)) && liquidity === null
      );
      if (noPair || (liquidity !== null && liquidity < this.deadLiquidityUsd)) count += 1;
    }
    return { count, partial };
  }

  async #fetchCreatorHistoryBase(creatorAddress, signal) {
    const [launchResult, directResult] = await Promise.all([
      this.#capture(
        'token_launched_logs',
        () => this.#listLaunchDeployments(creatorAddress, signal),
        signal
      ),
      this.#capture(
        'direct_deployments',
        () => this.#listDirectDeployments(creatorAddress, signal),
        signal
      )
    ]);
    throwIfAborted(signal);
    const successfulSources = [launchResult, directResult].filter((result) => !result.error);
    const errors = [launchResult, directResult]
      .filter((result) => result.error)
      .map((result) => `${result.label}: ${compactError(result.error)}`);
    errors.push(...(launchResult.value?.errors || []));
    if (!successfulSources.length) {
      return {
        creatorAddress,
        _creatorRecords: [],
        _creatorHistoryAvailable: false,
        _creatorHistoryPartial: true,
        _creatorHistoryDataAt: Math.floor(this.now() / 1_000),
        creatorHistorySource: null,
        creatorHistoryError: errors.join(' | ') || null,
        _creatorHistoryFlags: ['history_unavailable']
      };
    }

    const recordsByAddress = new Map();
    for (const result of successfulSources) {
      for (const record of result.value?.records || []) recordsByAddress.set(record.tokenAddress, record);
    }
    const records = [...recordsByAddress.values()];
    const dead = await this.#deadTokenCount(records, signal);
    const truncated = successfulSources.some((result) => result.value?.partial === true) || dead.partial;
    const flags = ['known_launch_events_and_direct_deployments_only'];
    if (truncated) flags.push('history_truncated_or_incomplete');
    if (errors.length) flags.push('history_source_failed');
    const sourceNames = [];
    if (!launchResult.error) sourceNames.push(...(launchResult.value?.sources || ['token_launched_logs']));
    if (!directResult.error) sourceNames.push('blockscout_verified_direct_erc20_deployments');
    return {
      creatorAddress,
      _creatorRecords: records,
      _creatorDeadTokenCount: dead.count,
      _creatorHistoryAvailable: true,
      _creatorHistoryPartial: truncated,
      _creatorHistoryDataAt: Math.floor(this.now() / 1_000),
      creatorHistorySource: [...new Set(sourceNames)].join('+') || null,
      _creatorHistoryFlags: flags,
      creatorHistoryError: errors.join(' | ') || null,
    };
  }

  async #materializeCreatorHistory(address, context, base, signal) {
    const creatorAddress = requireAddress(context.creatorAddress, 'creator');
    if (base?._creatorHistoryAvailable !== true) {
      return {
        tokenAddress: address,
        creatorAddress,
        creatorTokenCount: null,
        creatorDeadTokenCount: null,
        creatorHistoryPartial: true,
        creatorHistoryDataAt: base?._creatorHistoryDataAt ?? Math.floor(this.now() / 1_000),
        creatorHistorySource: null,
        creatorHistoryFlags: [...(base?._creatorHistoryFlags || ['history_unavailable'])],
        creatorHistoryError: base?.creatorHistoryError || null,
        deadDefinition: this.#deadTokenDefinition()
      };
    }

    const records = (base._creatorRecords || []).map((record) => ({ ...record }));
    let deadTokenCount = nonNegativeNumber(base._creatorDeadTokenCount) ?? 0;
    let partial = base._creatorHistoryPartial === true;
    const existingRecord = records.find((record) => record.tokenAddress === address);
    if (!existingRecord) {
      const currentRecord = {
        tokenAddress: address,
        createdAt: unixSeconds(context.tokenCreationTimestamp),
        transactionHash: context.creationTransactionHash || null,
        factoryAddress: context.factoryAddress || null,
        source: 'current_token_context'
      };
      records.push(currentRecord);
      const currentDead = await this.#deadTokenCount([currentRecord], signal);
      deadTokenCount += currentDead.count;
      partial ||= currentDead.partial;
    } else if (!Number.isSafeInteger(existingRecord.createdAt)) {
      const contextTimestamp = unixSeconds(context.tokenCreationTimestamp);
      if (contextTimestamp !== null) {
        existingRecord.createdAt = contextTimestamp;
        existingRecord.transactionHash ||= context.creationTransactionHash || null;
        existingRecord.factoryAddress ||= context.factoryAddress || null;
        const currentDead = await this.#deadTokenCount([existingRecord], signal);
        deadTokenCount += currentDead.count;
        partial ||= currentDead.partial;
      }
    }

    const flags = [...new Set(base._creatorHistoryFlags || [
      'known_launch_events_and_direct_deployments_only'
    ])];
    if (partial && !flags.includes('history_truncated_or_incomplete')) {
      flags.push('history_truncated_or_incomplete');
    }
    if (records.some((record) => record.source === 'current_token_context')) {
      if (!flags.includes('current_token_context_included')) flags.push('current_token_context_included');
      const sources = new Set(String(base.creatorHistorySource || '').split('+').filter(Boolean));
      sources.add('current_token_context');
      base.creatorHistorySource = [...sources].join('+');
    }
    const badCreatorHistory = historyIsHighRisk(
      records.length,
      deadTokenCount,
      this.badCreatorHistoryMinimumTokens,
      this.badCreatorHistoryDeadRatio
    );
    if (badCreatorHistory && !flags.includes('bad_creator_history')) flags.push('bad_creator_history');
    base._creatorRecords = records.map((record) => ({ ...record }));
    base._creatorDeadTokenCount = deadTokenCount;
    base._creatorHistoryPartial = partial;
    base._creatorHistoryFlags = [...flags];
    return {
      // Cache entries are creator-scoped; the public result is always rebound to this call's CA.
      tokenAddress: address,
      creatorAddress,
      creatorTokenCount: records.length,
      creatorDeadTokenCount: deadTokenCount,
      // Other, unknown launch platforms cannot be proven from these indexed sources.
      creatorHistoryPartial: true,
      creatorHistoryDataAt: base._creatorHistoryDataAt ?? Math.floor(this.now() / 1_000),
      creatorHistorySource: base.creatorHistorySource || null,
      creatorHistoryFlags: flags,
      tokenRiskFlags: badCreatorHistory ? ['bad_creator_history'] : [],
      creatorHistoryError: base.creatorHistoryError || null,
      deadDefinition: this.#deadTokenDefinition()
    };
  }
}
