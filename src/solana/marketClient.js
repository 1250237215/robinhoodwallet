import { normalizeSolanaAddress } from './address.js';

const DEXSCREENER_SOLANA_ROOT = 'https://api.dexscreener.com/token-pairs/v1/solana';

function number(value) {
  if (value === null || value === undefined || value === '') return null;
  const parsed = Number(value);
  return Number.isFinite(parsed) ? parsed : null;
}

function retryDelay(response, attempt) {
  const retryAfter = Number(response?.headers?.get?.('retry-after'));
  return Number.isFinite(retryAfter) && retryAfter >= 0
    ? Math.min(10_000, retryAfter * 1_000)
    : Math.min(4_000, 250 * (2 ** attempt));
}

async function requestPairs(url, { fetchImpl, timeoutMs, signal, maxResponseBytes }) {
  let lastError;
  for (let attempt = 0; attempt < 4; attempt += 1) {
    try {
      const timeoutSignal = AbortSignal.timeout(timeoutMs);
      const combined = signal ? AbortSignal.any([signal, timeoutSignal]) : timeoutSignal;
      const response = await fetchImpl(url, {
        signal: combined,
        headers: { accept: 'application/json' }
      });
      const declared = Number(response.headers.get('content-length'));
      if (Number.isFinite(declared) && declared > maxResponseBytes) {
        const error = new Error('DexScreener response is too large');
        error.retryable = false;
        throw error;
      }
      const text = await response.text();
      if (Buffer.byteLength(text) > maxResponseBytes) {
        const error = new Error('DexScreener response is too large');
        error.retryable = false;
        throw error;
      }
      if (!response.ok) {
        const error = new Error(`DexScreener request failed with HTTP ${response.status}`);
        error.retryable = response.status === 429 || response.status >= 500;
        error.response = response;
        throw error;
      }
      const body = JSON.parse(text);
      if (!Array.isArray(body)) {
        const error = new Error('DexScreener returned an invalid token-pairs response');
        error.retryable = false;
        throw error;
      }
      return body;
    } catch (error) {
      lastError = error;
      if (signal?.aborted || error?.name === 'AbortError' || error?.retryable === false || attempt >= 3) break;
      await new Promise((resolve) => setTimeout(resolve, retryDelay(error?.response, attempt)));
    }
  }
  throw lastError || new Error('DexScreener request failed');
}

function bestPair(rows, mint) {
  return rows
    .filter((pair) => pair?.chainId === 'solana' && pair?.baseToken?.address === mint)
    .sort((left, right) => (number(right?.liquidity?.usd) ?? 0) - (number(left?.liquidity?.usd) ?? 0))[0] || null;
}

export class SolanaDexScreenerClient {
  constructor({
    baseUrl = DEXSCREENER_SOLANA_ROOT,
    timeoutMs = 10_000,
    maxResponseBytes = 2 * 1024 * 1024,
    fetchImpl = globalThis.fetch
  } = {}) {
    if (typeof fetchImpl !== 'function') throw new TypeError('fetchImpl is required');
    this.baseUrl = String(baseUrl || DEXSCREENER_SOLANA_ROOT).replace(/\/$/, '');
    this.timeoutMs = Math.max(1_000, Math.min(60_000, Number(timeoutMs) || 10_000));
    this.maxResponseBytes = Math.max(64 * 1024, Math.min(16 * 1024 * 1024, Number(maxResponseBytes) || 2 * 1024 * 1024));
    this.fetchImpl = fetchImpl;
  }

  async fetchTokenMetrics(tokenAddress, { signal } = {}) {
    const mint = normalizeSolanaAddress(tokenAddress);
    const rows = await requestPairs(`${this.baseUrl}/${encodeURIComponent(mint)}`, {
      fetchImpl: this.fetchImpl,
      timeoutMs: this.timeoutMs,
      signal,
      maxResponseBytes: this.maxResponseBytes
    });
    const pair = bestPair(rows, mint);
    if (!pair) throw new Error('DexScreener did not return a Solana pair with the token as base asset');
    const pairCreatedAtMs = number(pair.pairCreatedAt);
    return {
      chain: 'solana',
      address: mint,
      symbol: String(pair.baseToken?.symbol || mint),
      name: String(pair.baseToken?.name || pair.baseToken?.symbol || mint),
      decimals: null,
      logo: String(pair.info?.imageUrl || ''),
      creationTimestamp: pairCreatedAtMs === null ? null : Math.floor(pairCreatedAtMs / 1_000),
      creationTimestampSource: 'dexscreener_pair_created_at',
      priceUsd: number(pair.priceUsd),
      marketCapUsd: number(pair.marketCap ?? pair.fdv),
      liquidityUsd: number(pair.liquidity?.usd),
      holders: null,
      updatedAt: Math.floor(Date.now() / 1_000),
      primaryPoolAddress: String(pair.pairAddress || ''),
      primaryDex: String(pair.dexId || ''),
      source: 'dexscreener'
    };
  }
}

export class SolanaCompositeMarketClient {
  constructor({ primary = null, fallback } = {}) {
    if (!fallback?.fetchTokenMetrics) throw new TypeError('A fallback Solana market client is required');
    this.primary = primary;
    this.fallback = fallback;
  }

  async fetchTokenMetrics(tokenAddress, options = {}) {
    let primary = null;
    let primaryError = null;
    if (this.primary?.fetchTokenMetrics) {
      try {
        primary = await this.primary.fetchTokenMetrics(tokenAddress, options);
        if (primary?.marketCapUsd !== null && primary?.marketCapUsd !== undefined &&
          primary?.creationTimestamp !== null && primary?.creationTimestamp !== undefined) {
          return { ...primary, source: primary.source || 'debot' };
        }
      } catch (error) {
        primaryError = error;
      }
    }

    try {
      const fallback = await this.fallback.fetchTokenMetrics(tokenAddress, options);
      if (!primary) return fallback;
      return {
        ...fallback,
        ...primary,
        symbol: primary.symbol || fallback.symbol,
        name: primary.name || fallback.name,
        decimals: primary.decimals ?? fallback.decimals,
        marketCapUsd: primary.marketCapUsd ?? fallback.marketCapUsd,
        creationTimestamp: primary.creationTimestamp ?? fallback.creationTimestamp,
        creationTimestampSource: primary.creationTimestamp !== null && primary.creationTimestamp !== undefined
          ? primary.creationTimestampSource || 'debot_token_creation'
          : fallback.creationTimestampSource,
        priceUsd: primary.priceUsd ?? fallback.priceUsd,
        liquidityUsd: primary.liquidityUsd ?? fallback.liquidityUsd,
        source: 'debot+dexscreener'
      };
    } catch (fallbackError) {
      if (primary) return { ...primary, source: primary.source || 'debot_partial' };
      throw new AggregateError(
        [primaryError, fallbackError].filter(Boolean),
        'Solana market data is unavailable from DeBot and DexScreener'
      );
    }
  }
}
