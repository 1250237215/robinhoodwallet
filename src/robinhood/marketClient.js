const ADDRESS_PATTERN = /^0x[0-9a-f]{40}$/;

export const ROBINHOOD_DEXSCREENER_BATCH_SIZE = 30;
export const ROBINHOOD_DEXSCREENER_TOKENS_URL =
  'https://api.dexscreener.com/tokens/v1/robinhood';

function normalizeAddress(value) {
  return String(value || '').trim().toLowerCase();
}

function requireAddress(value) {
  const address = normalizeAddress(value);
  if (!ADDRESS_PATTERN.test(address)) throw new TypeError('Invalid Robinhood token address');
  return address;
}

function number(value) {
  if (value === null || value === undefined || value === '') return null;
  const parsed = Number(value);
  return Number.isFinite(parsed) ? parsed : null;
}

function nonNegativeNumber(value) {
  const parsed = number(value);
  return parsed !== null && parsed >= 0 ? parsed : null;
}

function positiveTimestamp(value) {
  const parsed = number(value);
  if (!(parsed > 0)) return null;
  return Math.floor(parsed > 10_000_000_000 ? parsed / 1_000 : parsed);
}

function marketCapForPair(pair) {
  return nonNegativeNumber(pair?.marketCap) ?? nonNegativeNumber(pair?.fdv);
}

function pairLiquidity(pair) {
  return nonNegativeNumber(pair?.liquidity?.usd);
}

function pairVolume24h(pair) {
  return nonNegativeNumber(pair?.volume?.h24);
}

function validPairForAddress(pair, address) {
  return String(pair?.chainId || '').trim().toLowerCase() === 'robinhood' &&
    normalizeAddress(pair?.baseToken?.address) === address &&
    ADDRESS_PATTERN.test(normalizeAddress(pair?.pairAddress));
}

function comparePrimaryPairs(left, right) {
  const liquidity = (pairLiquidity(right) ?? -1) - (pairLiquidity(left) ?? -1);
  if (liquidity !== 0) return liquidity;
  const volume = (pairVolume24h(right) ?? -1) - (pairVolume24h(left) ?? -1);
  if (volume !== 0) return volume;
  return (positiveTimestamp(left?.pairCreatedAt) ?? Number.MAX_SAFE_INTEGER) -
    (positiveTimestamp(right?.pairCreatedAt) ?? Number.MAX_SAFE_INTEGER);
}

function emptyMetrics(address, { retryable = true } = {}) {
  return {
    chain: 'robinhood',
    address,
    marketCapUsd: null,
    creationTimestamp: null,
    source: 'dexscreener_robinhood',
    retryable
  };
}

export function normalizeRobinhoodDexScreenerMetrics(rows, tokenAddress, { now = Date.now } = {}) {
  const address = requireAddress(tokenAddress);
  const pairs = (Array.isArray(rows) ? rows : []).filter((pair) => validPairForAddress(pair, address));
  if (!pairs.length) return emptyMetrics(address);

  const marketPairs = pairs.filter((pair) => marketCapForPair(pair) !== null);
  const primaryPair = [...(marketPairs.length ? marketPairs : pairs)].sort(comparePrimaryPairs)[0];
  const creationTimestamp = pairs
    .map((pair) => positiveTimestamp(pair?.pairCreatedAt))
    .filter((timestamp) => timestamp !== null)
    .sort((left, right) => left - right)[0] ?? null;
  const marketCapUsd = marketCapForPair(primaryPair);

  return {
    chain: 'robinhood',
    address,
    symbol: String(primaryPair?.baseToken?.symbol || 'UNKNOWN'),
    name: String(primaryPair?.baseToken?.name || primaryPair?.baseToken?.symbol || 'Unknown'),
    priceUsd: number(primaryPair?.priceUsd),
    marketCapUsd,
    liquidityUsd: pairLiquidity(primaryPair),
    creationTimestamp,
    creationTimestampSource: creationTimestamp === null ? null : 'dexscreener_earliest_pair_created_at',
    updatedAt: Math.floor(now() / 1_000),
    primaryPoolAddress: normalizeAddress(primaryPair?.pairAddress),
    primaryDex: String(primaryPair?.dexId || ''),
    pairCount: pairs.length,
    marketCapSource: nonNegativeNumber(primaryPair?.marketCap) !== null
      ? 'dexscreener_market_cap'
      : marketCapUsd === null
        ? null
        : 'dexscreener_fdv',
    source: 'dexscreener_robinhood',
    retryable: marketCapUsd === null || creationTimestamp === null
  };
}

export function normalizeRobinhoodDexScreenerBatch(rows, tokenAddresses, options = {}) {
  const addresses = [...new Set((Array.isArray(tokenAddresses) ? tokenAddresses : [])
    .map(requireAddress))];
  const result = new Map();
  for (const address of addresses) {
    result.set(address, normalizeRobinhoodDexScreenerMetrics(rows, address, options));
  }
  return result;
}

function requestError(message, { status = null, retryable = true, cause = null } = {}) {
  const error = new Error(message, cause ? { cause } : undefined);
  error.status = status;
  error.retryable = retryable;
  return error;
}

function asError(value, fallbackMessage) {
  if (value instanceof Error) return value;
  return requestError(String(value || fallbackMessage), { cause: value });
}

function httpRetryable(status) {
  return status === 408 || status === 425 || status === 429 || status >= 500;
}

async function requestPairs(url, { fetchImpl, timeoutMs, maxResponseBytes, signal }) {
  try {
    const timeoutSignal = AbortSignal.timeout(timeoutMs);
    const combinedSignal = signal ? AbortSignal.any([signal, timeoutSignal]) : timeoutSignal;
    const response = await fetchImpl(url, {
      signal: combinedSignal,
      headers: { accept: 'application/json' }
    });
    const declaredSize = number(response?.headers?.get?.('content-length'));
    if (declaredSize !== null && declaredSize > maxResponseBytes) {
      throw requestError('DexScreener response is too large', { retryable: false });
    }
    const text = await response.text();
    if (Buffer.byteLength(text) > maxResponseBytes) {
      throw requestError('DexScreener response is too large', { retryable: false });
    }
    if (!response.ok) {
      throw requestError(`DexScreener request failed with HTTP ${response.status}`, {
        status: response.status,
        retryable: httpRetryable(response.status)
      });
    }
    let body;
    try {
      body = JSON.parse(text);
    } catch (error) {
      throw requestError('DexScreener returned unreadable JSON', { retryable: true, cause: error });
    }
    if (!Array.isArray(body)) {
      throw requestError('DexScreener returned an invalid tokens response', { retryable: false });
    }
    return body;
  } catch (error) {
    const normalized = asError(error, 'DexScreener request failed');
    if (signal?.aborted) throw signal.reason instanceof Error ? signal.reason : normalized;
    if (typeof normalized.retryable !== 'boolean') normalized.retryable = true;
    throw normalized;
  }
}

function normalizeBatchAddresses(values) {
  const addresses = [...new Set((Array.isArray(values) ? values : []).map(requireAddress))];
  if (addresses.length > ROBINHOOD_DEXSCREENER_BATCH_SIZE) {
    throw new RangeError(
      `DexScreener token batch cannot exceed ${ROBINHOOD_DEXSCREENER_BATCH_SIZE} addresses`
    );
  }
  return addresses;
}

export class RobinhoodDexScreenerClient {
  constructor({
    baseUrl = ROBINHOOD_DEXSCREENER_TOKENS_URL,
    timeoutMs = 5_000,
    maxResponseBytes = 4 * 1024 * 1024,
    fetchImpl = globalThis.fetch,
    now = Date.now
  } = {}) {
    if (typeof fetchImpl !== 'function') throw new TypeError('fetchImpl is required');
    if (typeof now !== 'function') throw new TypeError('now must be a function');
    this.baseUrl = String(baseUrl || ROBINHOOD_DEXSCREENER_TOKENS_URL).replace(/\/$/, '');
    this.timeoutMs = Math.max(500, Math.min(60_000, Number(timeoutMs) || 5_000));
    this.maxResponseBytes = Math.max(
      64 * 1024,
      Math.min(16 * 1024 * 1024, Number(maxResponseBytes) || 4 * 1024 * 1024)
    );
    this.fetchImpl = fetchImpl;
    this.now = now;
  }

  async fetchTokenMetricsBatch(tokenAddresses, { signal } = {}) {
    const addresses = normalizeBatchAddresses(tokenAddresses);
    if (!addresses.length) return new Map();
    const rows = await requestPairs(`${this.baseUrl}/${addresses.join(',')}`, {
      fetchImpl: this.fetchImpl,
      timeoutMs: this.timeoutMs,
      maxResponseBytes: this.maxResponseBytes,
      signal
    });
    return normalizeRobinhoodDexScreenerBatch(rows, addresses, { now: this.now });
  }

  async fetchTokenMetrics(tokenAddress, options = {}) {
    const address = requireAddress(tokenAddress);
    return (await this.fetchTokenMetricsBatch([address], options)).get(address);
  }
}

function metricsComplete(metrics) {
  return nonNegativeNumber(metrics?.marketCapUsd) !== null &&
    positiveTimestamp(metrics?.creationTimestamp) !== null;
}

function mapFromBatchResult(value, addresses) {
  if (value instanceof Map) {
    return new Map([...value].map(([address, metrics]) => [normalizeAddress(address), metrics]));
  }
  if (Array.isArray(value)) {
    return new Map(value
      .map((metrics, index) => [normalizeAddress(metrics?.address || addresses[index]), metrics])
      .filter(([address]) => ADDRESS_PATTERN.test(address)));
  }
  if (value && typeof value === 'object') {
    return new Map(Object.entries(value).map(([address, metrics]) => [normalizeAddress(address), metrics]));
  }
  return new Map();
}

function fallbackGloballyBlocked(error) {
  return Number(error?.status) === 401 || Number(error?.status) === 403;
}

function retryableError(error) {
  return error ? error.retryable !== false : false;
}

function mergeMetrics(address, primary, fallback, { primaryError = null, fallbackError = null } = {}) {
  const primaryMarketCap = nonNegativeNumber(primary?.marketCapUsd);
  const fallbackMarketCap = nonNegativeNumber(fallback?.marketCapUsd);
  const primaryCreation = positiveTimestamp(primary?.creationTimestamp);
  const fallbackCreation = positiveTimestamp(fallback?.creationTimestamp);
  const marketCapUsd = primaryMarketCap ?? fallbackMarketCap;
  const creationTimestamp = primaryCreation ?? fallbackCreation;
  const hasPrimary = Boolean(primary && (
    primaryMarketCap !== null || primaryCreation !== null || primary?.primaryPoolAddress
  ));
  const hasFallback = Boolean(fallback && (fallbackMarketCap !== null || fallbackCreation !== null));
  const source = hasPrimary
    ? hasFallback ? 'dexscreener_robinhood+debot_fallback' : 'dexscreener_robinhood'
    : hasFallback ? 'debot_fallback' : 'market_data_unavailable';
  const dexCanChange = !primaryError && !metricsComplete(primary);

  return {
    ...(fallback || {}),
    ...(primary || {}),
    chain: 'robinhood',
    address,
    marketCapUsd,
    creationTimestamp,
    creationTimestampSource: primaryCreation !== null
      ? primary.creationTimestampSource || 'dexscreener_earliest_pair_created_at'
      : fallbackCreation !== null
        ? fallback?.creationTimestampSource || 'debot_token_creation'
        : null,
    source,
    retryable: metricsComplete({ marketCapUsd, creationTimestamp })
      ? false
      : dexCanChange || retryableError(primaryError) || retryableError(fallbackError),
    upstreamStatus: fallbackError?.status ?? primaryError?.status ?? null
  };
}

export class RobinhoodMarketDataClient {
  constructor({ primary, fallback = null, fallbackTimeoutMs = 3_000 } = {}) {
    if (!primary?.fetchTokenMetricsBatch && !primary?.fetchTokenMetrics) {
      throw new TypeError('A primary Robinhood market data client is required');
    }
    if (fallback !== null && typeof fallback?.fetchTokenMetrics !== 'function') {
      throw new TypeError('A fallback DeBot token metrics client is required');
    }
    this.primary = primary;
    this.fallback = fallback;
    this.fallbackTimeoutMs = Math.max(250, Math.min(20_000, Number(fallbackTimeoutMs) || 3_000));
    this.fallbackBlockedError = null;
  }

  async fetchTokenMetricsBatch(tokenAddresses, { signal } = {}) {
    const addresses = normalizeBatchAddresses(tokenAddresses);
    if (!addresses.length) return new Map();
    let primaryByAddress = new Map();
    let primaryError = null;
    try {
      if (typeof this.primary.fetchTokenMetricsBatch === 'function') {
        primaryByAddress = mapFromBatchResult(
          await this.primary.fetchTokenMetricsBatch(addresses, { signal }),
          addresses
        );
      } else {
        const rows = await Promise.all(addresses.map((address) =>
          this.primary.fetchTokenMetrics(address, { signal })));
        primaryByAddress = mapFromBatchResult(rows, addresses);
      }
    } catch (error) {
      const normalized = asError(error, 'Primary market data request failed');
      if (signal?.aborted) throw signal.reason instanceof Error ? signal.reason : normalized;
      primaryError = normalized;
    }

    const fallbackByAddress = new Map();
    const fallbackErrors = new Map();
    for (const address of addresses) {
      const primary = primaryByAddress.get(address) || null;
      if (metricsComplete(primary) || !this.fallback) continue;
      if (this.fallbackBlockedError) {
        fallbackErrors.set(address, this.fallbackBlockedError);
        continue;
      }
      try {
        const timeoutSignal = AbortSignal.timeout(this.fallbackTimeoutMs);
        const combinedSignal = signal ? AbortSignal.any([signal, timeoutSignal]) : timeoutSignal;
        fallbackByAddress.set(
          address,
          await this.fallback.fetchTokenMetrics(address, { signal: combinedSignal })
        );
      } catch (error) {
        const normalized = asError(error, 'Fallback market data request failed');
        if (signal?.aborted) throw signal.reason instanceof Error ? signal.reason : normalized;
        if (typeof normalized.retryable !== 'boolean') normalized.retryable = true;
        fallbackErrors.set(address, normalized);
        if (fallbackGloballyBlocked(normalized)) this.fallbackBlockedError = normalized;
      }
    }

    return new Map(addresses.map((address) => [
      address,
      mergeMetrics(address, primaryByAddress.get(address) || null, fallbackByAddress.get(address) || null, {
        primaryError,
        fallbackError: fallbackErrors.get(address) || this.fallbackBlockedError
      })
    ]));
  }

  async fetchTokenMetrics(tokenAddress, options = {}) {
    const address = requireAddress(tokenAddress);
    return (await this.fetchTokenMetricsBatch([address], options)).get(address);
  }
}

export function createRobinhoodMarketDataClient({
  dexScreenerClient = null,
  debotClient = null,
  ...options
} = {}) {
  return new RobinhoodMarketDataClient({
    primary: dexScreenerClient || new RobinhoodDexScreenerClient(options),
    fallback: debotClient,
    fallbackTimeoutMs: options.fallbackTimeoutMs
  });
}
