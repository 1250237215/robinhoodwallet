function normalizeAddress(value) {
  return String(value || '').toLowerCase();
}
function numberOrNull(value) {
  const number = Number(value);
  return Number.isFinite(number) ? number : null;
}

export function chooseMainPool(pairs, { targetToken, supportedQuotes }) {
  const target = normalizeAddress(targetToken);
  const quotes = new Set(supportedQuotes.map(normalizeAddress));
  const candidates = (Array.isArray(pairs) ? pairs : [])
    .map((pair) => {
      const baseAddress = normalizeAddress(pair?.baseToken?.address || target);
      const quoteAddress = normalizeAddress(pair?.quoteToken?.address);
      const labels = Array.isArray(pair?.labels) ? pair.labels.map((label) => String(label).toLowerCase()) : [];
      const version = labels.includes('v2') ? 'v2' : labels.includes('v3') ? 'v3' : null;
      return {
        address: normalizeAddress(pair?.pairAddress),
        version,
        dexId: String(pair?.dexId || ''),
        baseAddress,
        quoteAddress,
        liquidityUsd: numberOrNull(pair?.liquidity?.usd) ?? 0,
        currentPriceNative: numberOrNull(pair?.priceNative),
        currentPriceUsd: numberOrNull(pair?.priceUsd),
        volume24hUsd: numberOrNull(pair?.volume?.h24),
        createdAt: numberOrNull(pair?.pairCreatedAt)
      };
    })
    .filter(
      (pair) =>
        /^0x[0-9a-f]{40}$/.test(pair.address) &&
        pair.version &&
        pair.baseAddress === target &&
        quotes.has(pair.quoteAddress)
    )
    .sort((a, b) => b.liquidityUsd - a.liquidityUsd);
  return candidates[0] || null;
}

export class RobinhoodPoolClient {
  constructor({
    baseUrl = 'https://api.dexscreener.com/token-pairs/v1/robinhood',
    timeoutMs = 20_000,
    fetchImpl = globalThis.fetch
  } = {}) {
    if (typeof fetchImpl !== 'function') throw new TypeError('fetchImpl is required');
    this.baseUrl = baseUrl.replace(/\/$/, '');
    this.timeoutMs = timeoutMs;
    this.fetchImpl = fetchImpl;
  }

  async fetchPools(tokenAddress, { signal } = {}) {
    const timeoutSignal = AbortSignal.timeout(this.timeoutMs);
    const combined = signal ? AbortSignal.any([signal, timeoutSignal]) : timeoutSignal;
    const response = await this.fetchImpl(`${this.baseUrl}/${encodeURIComponent(tokenAddress)}`, {
      signal: combined,
      headers: { accept: 'application/json' }
    });
    if (!response.ok) throw new Error(`Pool directory failed with HTTP ${response.status}`);
    const body = await response.json();
    if (!Array.isArray(body)) throw new Error('Pool directory returned an invalid response');
    return body;
  }
}
