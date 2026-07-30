import { BSC_CHAIN, isBscAddress, normalizeBscAddress } from './config.js';

const DEXSCREENER_BATCH_SIZE = 30;

function asNumber(value) {
  if (value === null || value === undefined || value === '') return null;
  const number = Number(value);
  return Number.isFinite(number) ? number : null;
}

function positiveTimestamp(value) {
  const number = asNumber(value);
  if (!(number > 0)) return null;
  return Math.floor(number > 10_000_000_000 ? number / 1_000 : number);
}

function usableMetrics(metrics) {
  return metrics && asNumber(metrics.marketCapUsd) !== null && positiveTimestamp(metrics.creationTimestamp) !== null;
}

function normalizeBatchAddresses(values) {
  const addresses = [...new Set((Array.isArray(values) ? values : []).map(normalizeBscAddress))];
  if (addresses.length > DEXSCREENER_BATCH_SIZE) {
    throw new RangeError(`BSC market data batch cannot exceed ${DEXSCREENER_BATCH_SIZE} addresses`);
  }
  for (const address of addresses) {
    if (!isBscAddress(address)) throw new TypeError('Invalid BSC token address');
  }
  return addresses;
}

function throwIfAborted(signal) {
  if (!signal?.aborted) return;
  throw signal.reason instanceof Error ? signal.reason : new Error('BSC market lookup was aborted');
}

function dexPairsForToken(rows, tokenAddress) {
  return (Array.isArray(rows) ? rows : [])
    .filter((pair) => String(pair?.chainId || '').toLowerCase() === 'bsc')
    .filter((pair) => normalizeBscAddress(pair?.baseToken?.address) === tokenAddress)
    .sort((left, right) => (asNumber(right?.liquidity?.usd) ?? 0) - (asNumber(left?.liquidity?.usd) ?? 0));
}

export function normalizeBscDexScreenerMetrics(rows, tokenAddress) {
  const address = normalizeBscAddress(tokenAddress);
  if (!isBscAddress(address)) throw new TypeError('Invalid BSC token address');
  const pairs = dexPairsForToken(rows, address);
  const pair = pairs[0] || null;
  if (!pair) throw new Error('DexScreener did not return a BSC pair for the token');
  const marketCapUsd = asNumber(pair.marketCap) ?? asNumber(pair.fdv);
  const creationTimestamps = pairs
    .map((candidate) => positiveTimestamp(candidate?.pairCreatedAt))
    .filter((timestamp) => timestamp !== null);
  const creationTimestamp = creationTimestamps.length ? Math.min(...creationTimestamps) : null;
  if (marketCapUsd === null && creationTimestamp === null) {
    throw new Error('DexScreener BSC pair did not include market cap or creation time');
  }
  return {
    chain: 'bsc',
    address,
    symbol: String(pair.baseToken?.symbol || 'UNKNOWN'),
    name: String(pair.baseToken?.name || pair.baseToken?.symbol || 'Unknown'),
    priceUsd: asNumber(pair.priceUsd),
    marketCapUsd,
    liquidityUsd: asNumber(pair.liquidity?.usd),
    creationTimestamp,
    source: 'dexscreener_bsc_pair'
  };
}

export function normalizeBscDexScreenerBatch(rows, tokenAddresses) {
  const addresses = normalizeBatchAddresses(tokenAddresses);
  const metrics = new Map();
  for (const address of addresses) {
    try {
      metrics.set(address, normalizeBscDexScreenerMetrics(rows, address));
    } catch (error) {
      if (!/did not return a BSC pair/.test(String(error?.message || ''))) throw error;
    }
  }
  return metrics;
}

function mergeMetrics(address, primary, fallback) {
  if (!primary && !fallback) return null;
  const marketCapUsd = asNumber(primary?.marketCapUsd) ?? asNumber(fallback?.marketCapUsd);
  const creationTimestamp = positiveTimestamp(primary?.creationTimestamp) ??
    positiveTimestamp(fallback?.creationTimestamp);
  return {
    ...(fallback || {}),
    ...(primary || {}),
    chain: 'bsc',
    address,
    marketCapUsd,
    creationTimestamp,
    source: primary && fallback
      ? 'dexscreener_with_debot_fallback'
      : primary?.source || fallback?.source || 'debot_bsc_fallback'
  };
}

export class BscMarketClient {
  constructor({
    debotClient = null,
    dexScreenerBaseUrl = BSC_CHAIN.dexScreenerTokensUrl,
    fetchImpl = globalThis.fetch,
    debotBudgetMs = 1_500,
    debotConcurrency = 2,
    timeoutMs = 5_000
  } = {}) {
    if (debotClient !== null && typeof debotClient?.fetchTokenMetrics !== 'function') {
      throw new TypeError('A DeBot token metrics client is required');
    }
    if (typeof fetchImpl !== 'function') throw new TypeError('fetchImpl is required');
    this.debotClient = debotClient;
    this.dexScreenerBaseUrl = String(dexScreenerBaseUrl || BSC_CHAIN.dexScreenerTokensUrl).replace(/\/$/, '');
    this.fetchImpl = fetchImpl;
    this.debotBudgetMs = Math.max(250, Math.min(10_000, Number(debotBudgetMs) || 1_500));
    this.debotConcurrency = Math.max(1, Math.min(4, Math.floor(Number(debotConcurrency) || 2)));
    this.timeoutMs = Math.max(1_000, Math.min(20_000, Number(timeoutMs) || 5_000));
  }

  async fetchTokenMetrics(tokenAddress, { signal } = {}) {
    const address = normalizeBscAddress(tokenAddress);
    if (!isBscAddress(address)) throw new TypeError('Invalid BSC token address');
    const metrics = (await this.fetchTokenMetricsBatch([address], { signal })).get(address);
    if (metrics) return metrics;
    throw new Error('BSC market data unavailable from DexScreener and DeBot');
  }

  async fetchTokenMetricsBatch(tokenAddresses, { signal } = {}) {
    const addresses = normalizeBatchAddresses(tokenAddresses);
    if (!addresses.length) return new Map();
    throwIfAborted(signal);

    let primaryByAddress = new Map();
    let primaryError = null;
    try {
      primaryByAddress = await this.#fetchDexScreenerBatch(addresses, { signal });
    } catch (error) {
      throwIfAborted(signal);
      primaryError = error;
    }

    const fallbackAddresses = this.debotClient
      ? addresses.filter((address) => !usableMetrics(primaryByAddress.get(address)))
      : [];
    const fallbackByAddress = await this.#fetchDebotFallbacks(fallbackAddresses, { signal });
    const result = new Map();
    for (const address of addresses) {
      const metrics = mergeMetrics(
        address,
        primaryByAddress.get(address) || null,
        fallbackByAddress.get(address) || null
      );
      if (metrics) result.set(address, metrics);
    }
    if (!result.size && primaryError) throw primaryError;
    return result;
  }

  async #fetchDexScreenerBatch(addresses, { signal } = {}) {
    const timeoutSignal = AbortSignal.timeout(this.timeoutMs);
    const combinedSignal = signal ? AbortSignal.any([signal, timeoutSignal]) : timeoutSignal;
    const response = await this.fetchImpl(`${this.dexScreenerBaseUrl}/${addresses.join(',')}`, {
      signal: combinedSignal,
      headers: { accept: 'application/json' }
    });
    if (!response.ok) throw new Error(`request failed with HTTP ${response.status}`);
    const rows = await response.json();
    return normalizeBscDexScreenerBatch(rows, addresses);
  }

  async #fetchDebotFallbacks(addresses, { signal } = {}) {
    const metrics = new Map();
    if (!addresses.length || !this.debotClient) return metrics;
    const budgetSignal = AbortSignal.timeout(this.debotBudgetMs);
    const combinedSignal = signal ? AbortSignal.any([signal, budgetSignal]) : budgetSignal;
    let cursor = 0;
    let globallyBlocked = false;
    const worker = async () => {
      while (!combinedSignal.aborted && !globallyBlocked) {
        const index = cursor;
        cursor += 1;
        if (index >= addresses.length) return;
        const address = addresses[index];
        try {
          const row = await this.debotClient.fetchTokenMetrics(address, { signal: combinedSignal });
          if (row) metrics.set(address, row);
        } catch (error) {
          throwIfAborted(signal);
          if ([401, 403].includes(Number(error?.status))) globallyBlocked = true;
        }
      }
    };
    await Promise.all(Array.from(
      { length: Math.min(this.debotConcurrency, addresses.length) },
      () => worker()
    ));
    throwIfAborted(signal);
    return metrics;
  }
}

export function createBscMarketClient(options) {
  return new BscMarketClient(options);
}
