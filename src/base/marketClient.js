import { BASE_CHAIN, isBaseAddress, normalizeBaseAddress } from './config.js';

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

function throwIfAborted(signal) {
  if (!signal?.aborted) return;
  throw signal.reason instanceof Error ? signal.reason : new Error('Base market lookup was aborted');
}

function dexPairForToken(rows, tokenAddress) {
  return (Array.isArray(rows) ? rows : [])
    .filter((pair) => String(pair?.chainId || '').toLowerCase() === 'base')
    .filter((pair) => normalizeBaseAddress(pair?.baseToken?.address) === tokenAddress)
    .sort((left, right) => (asNumber(right?.liquidity?.usd) ?? 0) - (asNumber(left?.liquidity?.usd) ?? 0))[0] || null;
}

export function normalizeBaseDexScreenerMetrics(rows, tokenAddress) {
  const address = normalizeBaseAddress(tokenAddress);
  if (!isBaseAddress(address)) throw new TypeError('Invalid Base token address');
  const pair = dexPairForToken(rows, address);
  if (!pair) throw new Error('DexScreener did not return a Base pair for the token');
  const marketCapUsd = asNumber(pair.marketCap) ?? asNumber(pair.fdv);
  const creationTimestamp = positiveTimestamp(pair.pairCreatedAt);
  if (marketCapUsd === null && creationTimestamp === null) {
    throw new Error('DexScreener Base pair did not include market cap or creation time');
  }
  return {
    chain: 'base',
    address,
    symbol: String(pair.baseToken?.symbol || 'UNKNOWN'),
    name: String(pair.baseToken?.name || pair.baseToken?.symbol || 'Unknown'),
    priceUsd: asNumber(pair.priceUsd),
    marketCapUsd,
    liquidityUsd: asNumber(pair.liquidity?.usd),
    creationTimestamp,
    source: 'dexscreener_base_pair'
  };
}

export class BaseMarketClient {
  constructor({
    debotClient = null,
    dexScreenerBaseUrl = BASE_CHAIN.dexScreenerPairsUrl,
    fetchImpl = globalThis.fetch,
    debotBudgetMs = 1_500,
    timeoutMs = 5_000
  } = {}) {
    if (debotClient !== null && typeof debotClient?.fetchTokenMetrics !== 'function') {
      throw new TypeError('A DeBot token metrics client is required');
    }
    if (typeof fetchImpl !== 'function') throw new TypeError('fetchImpl is required');
    this.debotClient = debotClient;
    this.dexScreenerBaseUrl = String(dexScreenerBaseUrl || BASE_CHAIN.dexScreenerPairsUrl).replace(/\/$/, '');
    this.fetchImpl = fetchImpl;
    this.debotBudgetMs = Math.max(250, Math.min(10_000, Number(debotBudgetMs) || 1_500));
    this.timeoutMs = Math.max(1_000, Math.min(20_000, Number(timeoutMs) || 5_000));
  }

  async fetchTokenMetrics(tokenAddress, { signal } = {}) {
    const address = normalizeBaseAddress(tokenAddress);
    if (!isBaseAddress(address)) throw new TypeError('Invalid Base token address');
    throwIfAborted(signal);

    let debotMetrics = null;
    let debotError = null;
    if (this.debotClient) {
      try {
        const budgetSignal = AbortSignal.timeout(this.debotBudgetMs);
        const combinedSignal = signal ? AbortSignal.any([signal, budgetSignal]) : budgetSignal;
        debotMetrics = await this.debotClient.fetchTokenMetrics(address, { signal: combinedSignal });
        if (usableMetrics(debotMetrics)) return debotMetrics;
      } catch (error) {
        throwIfAborted(signal);
        debotError = error;
      }
    }

    try {
      const fallback = await this.#fetchDexScreener(address, { signal });
      return {
        ...fallback,
        ...(debotMetrics || {}),
        chain: 'base',
        address,
        marketCapUsd: asNumber(debotMetrics?.marketCapUsd) ?? fallback.marketCapUsd,
        creationTimestamp: positiveTimestamp(debotMetrics?.creationTimestamp) ?? fallback.creationTimestamp,
        source: debotMetrics ? 'debot_with_dexscreener_fallback' : fallback.source
      };
    } catch (fallbackError) {
      throwIfAborted(signal);
      if (debotMetrics) return debotMetrics;
      const error = new Error(
        `Base market data unavailable: DeBot ${debotError?.message || 'unavailable'}; ` +
        `DexScreener ${fallbackError instanceof Error ? fallbackError.message : String(fallbackError)}`
      );
      error.cause = fallbackError;
      throw error;
    }
  }

  async #fetchDexScreener(address, { signal } = {}) {
    const timeoutSignal = AbortSignal.timeout(this.timeoutMs);
    const combinedSignal = signal ? AbortSignal.any([signal, timeoutSignal]) : timeoutSignal;
    const response = await this.fetchImpl(`${this.dexScreenerBaseUrl}/${encodeURIComponent(address)}`, {
      signal: combinedSignal,
      headers: { accept: 'application/json' }
    });
    if (!response.ok) throw new Error(`request failed with HTTP ${response.status}`);
    const rows = await response.json();
    return normalizeBaseDexScreenerMetrics(rows, address);
  }
}

export function createBaseMarketClient(options) {
  return new BaseMarketClient(options);
}
