const DEBOT_BASE_URL = 'https://debot.ai/api';
const ADDRESS_PATTERN = /^0x[0-9a-f]{40}$/;

function asNumber(value) {
  if (value === null || value === undefined || value === '') return null;
  const number = Number(value);
  return Number.isFinite(number) ? number : null;
}

function ratioToPercent(value) {
  const number = asNumber(value);
  return number === null ? null : number * 100;
}

function normalizeSafety(raw = {}) {
  const goplus = raw?.goplus || raw?.safe_info?.goplus || {};
  const booleanFlag = (value) => (value === 0 ? false : value === 1 ? true : null);
  return {
    trusted: raw?.debot_trust === true,
    honeypot: booleanFlag(goplus.is_honeypot),
    openSource: booleanFlag(goplus.is_open_source),
    ownershipAbandoned: booleanFlag(goplus.is_ownership_abandoned),
    poolLocked: booleanFlag(goplus.is_pool_locked),
    buyTax: asNumber(goplus.buy_tax),
    sellTax: asNumber(goplus.sell_tax)
  };
}

function normalizeMetricWindow(raw = {}) {
  return {
    changePercent: ratioToPercent(raw.percent),
    volumeUsd: asNumber(raw.volume),
    buyVolumeUsd: asNumber(raw.buy_volume),
    sellVolumeUsd: asNumber(raw.sell_volume),
    buys: asNumber(raw.buy_count),
    sells: asNumber(raw.sell_count),
    buyWallets: asNumber(raw.buy_wallets),
    sellWallets: asNumber(raw.sell_wallets)
  };
}

export function normalizeTokenMetrics(raw = {}) {
  const meta = raw?.meta || {};
  const metrics = raw?.metrics || {};
  return {
    chain: String(raw?.chain || 'robinhood'),
    address: String(raw?.token || meta.address || '').toLowerCase(),
    symbol: String(meta.symbol || 'UNKNOWN'),
    name: String(meta.name || meta.symbol || 'Unknown'),
    decimals: asNumber(meta.decimals) ?? 18,
    logo: typeof raw?.token_logo === 'string' ? raw.token_logo : typeof meta.logo === 'string' ? meta.logo : '',
    creationTimestamp: asNumber(meta.creation_timestamp),
    priceUsd: asNumber(raw?.price),
    marketCapUsd: asNumber(raw?.mkt_cap ?? raw?.fdv),
    liquidityUsd: asNumber(raw?.liquidity ?? raw?.total_liquidity),
    holders: asNumber(raw?.holders),
    effectiveWallets: Math.max(
      asNumber(metrics?.['24h']?.buy_wallets) ?? 0,
      asNumber(metrics?.['24h']?.sell_wallets) ?? 0
    ),
    windows: Object.fromEntries(
      ['5m', '1h', '6h', '12h', '24h']
        .filter((key) => metrics[key] && typeof metrics[key] === 'object')
        .map((key) => [key, normalizeMetricWindow(metrics[key])])
    ),
    devHoldRate: asNumber(raw?.tag_stats?.dev_holds_rate),
    sniperHoldRate: asNumber(raw?.tag_stats?.snipers_holds_rate),
    insiderHoldRate: asNumber(raw?.tag_stats?.insiders_holds_rate),
    bundlerHoldRate: asNumber(raw?.tag_stats?.bundlers_holds_rate),
    updatedAt: asNumber(raw?.update_time) || Math.floor(Date.now() / 1000)
  };
}

export function normalizeHotToken(raw) {
  const market = raw?.market_info || {};
  const liquidity = raw?.pair_summary_info?.liquidity;
  return {
    chain: raw?.chain || 'robinhood',
    address: String(raw?.address || '').toLowerCase(),
    symbol: String(raw?.symbol || 'UNKNOWN'),
    name: String(raw?.name || raw?.symbol || 'Unknown'),
    decimals: asNumber(raw?.decimals) ?? 18,
    logo: typeof raw?.logo === 'string' ? raw.logo : '',
    creationTimestamp: asNumber(raw?.creation_timestamp),
    launchpad: String(raw?.launchpad || ''),
    dexName: String(raw?.dex?.dex_name || ''),
    priceUsd: asNumber(market.price),
    marketCapUsd: asNumber(market.mkt_cap ?? market.fdv),
    liquidityUsd: asNumber(liquidity),
    holders: asNumber(market.holders),
    volume1hUsd: asNumber(market.volume),
    buys1h: asNumber(market.buys),
    sells1h: asNumber(market.sells),
    effectiveWallets: asNumber(market.uniq_wallet_swaps ?? market.uniq_wallet_swaps_1h),
    change5mPercent: ratioToPercent(market.percent_5m),
    change1hPercent: ratioToPercent(market.percent_1h ?? market.percent),
    change24hPercent: ratioToPercent(market.percent_24h),
    kolCount: asNumber(raw?.kol_count) ?? 0,
    tags: Array.isArray(raw?.tags) ? raw.tags.filter((tag) => typeof tag === 'string') : [],
    safe: normalizeSafety(raw?.safe_info || {}),
    social: raw?.social_info || null,
    devHoldRate: asNumber(raw?.tag_stats?.dev_holds_rate),
    sniperHoldRate: asNumber(raw?.tag_stats?.snipers_holds_rate),
    insiderHoldRate: asNumber(raw?.tag_stats?.insiders_holds_rate),
    bundlerHoldRate: asNumber(raw?.tag_stats?.bundlers_holds_rate),
    updatedAt: asNumber(market.last_update_time) || Math.floor(Date.now() / 1000)
  };
}

function retryDelay(response, attempt) {
  const retryAfterHeader = response?.headers?.get?.('retry-after');
  const retryAfter = retryAfterHeader === null || retryAfterHeader === undefined
    ? NaN
    : Number(retryAfterHeader);
  if (Number.isFinite(retryAfter) && retryAfter >= 0) return Math.min(5_000, retryAfter * 1_000);
  return 250 * (2 ** attempt);
}

async function fetchResponse(url, { timeoutMs, signal, fetchImpl }) {
  let lastError;
  for (let attempt = 0; attempt < 4; attempt += 1) {
    try {
      const timeoutSignal = AbortSignal.timeout(timeoutMs);
      const combined = signal ? AbortSignal.any([signal, timeoutSignal]) : timeoutSignal;
      const response = await fetchImpl(url, {
        signal: combined,
        headers: { accept: 'application/json' }
      });
      if (response.ok) return response;
      const retryable = response.status === 429 || response.status >= 500;
      if (!retryable || attempt >= 3) {
        const error = new Error(`DeBot request failed with HTTP ${response.status}`);
        error.retryable = false;
        throw error;
      }
      await new Promise((resolve) => setTimeout(resolve, retryDelay(response, attempt)));
    } catch (error) {
      lastError = error;
      if (signal?.aborted || error?.name === 'AbortError' || error?.retryable === false || attempt >= 3) break;
      await new Promise((resolve) => setTimeout(resolve, 250 * (2 ** attempt)));
    }
  }
  throw lastError || new Error('DeBot request failed');
}

async function requestJson(url, { timeoutMs = 20_000, signal, fetchImpl = globalThis.fetch } = {}) {
  const response = await fetchResponse(url, { timeoutMs, signal, fetchImpl });
  const body = await response.json();
  if (body?.code !== 0 || !Array.isArray(body?.data)) {
    throw new Error(body?.description || body?.message_en || body?.message || 'DeBot returned an invalid response');
  }
  return body.data;
}

async function requestObject(url, { timeoutMs = 20_000, signal, fetchImpl = globalThis.fetch } = {}) {
  const response = await fetchResponse(url, { timeoutMs, signal, fetchImpl });
  const body = await response.json();
  if (body?.code !== 0 || !body?.data || typeof body.data !== 'object' || Array.isArray(body.data)) {
    throw new Error(body?.description || body?.message_en || body?.message || 'DeBot returned an invalid response');
  }
  return body.data;
}

function returnMultiple(proceeds, cost) {
  const nextProceeds = asNumber(proceeds);
  const nextCost = asNumber(cost);
  return nextProceeds !== null && nextCost > 0 ? nextProceeds / nextCost : null;
}

export function normalizeWalletTokenProfit(raw = {}, requestedWallet = '') {
  const buyAmount = Math.abs(asNumber(raw.buy_amount) ?? 0);
  const sellAmount = Math.abs(asNumber(raw.sell_amount) ?? 0);
  const buyVolumeUsd = Math.abs(asNumber(raw.buy_volume) ?? 0);
  const sellVolumeUsd = Math.abs(asNumber(raw.sell_volume) ?? 0);
  const holdingTokenAmount = Math.max(
    0,
    asNumber(raw.position ?? raw.hold_amount ?? raw.actual_buy_amount) ?? 0
  );
  const currentPriceUsd = asNumber(raw.price);
  const explicitHoldingValueUsd = asNumber(
    raw.balance ?? raw.holding_value_usd ?? raw.position_value_usd ?? raw.balance_usd
  );
  const computedHoldingValueUsd = currentPriceUsd !== null
    ? holdingTokenAmount * currentPriceUsd
    : null;
  const holdingValueUsd = Math.max(
    0,
    explicitHoldingValueUsd ?? computedHoldingValueUsd ?? 0
  );
  const averageBuyPriceUsd = asNumber(raw.avg_buy_price);
  const rawRemainingCostUsd = asNumber(raw.actual_buy_cost);
  const remainingCostUsd = Math.max(0, rawRemainingCostUsd ?? 0);
  const estimatedSoldCostUsd = averageBuyPriceUsd > 0 && sellAmount > 0
    ? averageBuyPriceUsd * sellAmount
    : null;
  const explicitRealizedProfitUsd = asNumber(raw.realized_profit);
  const explicitUnrealizedProfitUsd = asNumber(raw.unrealized_profit);
  const explicitRealizedRate = asNumber(raw.realized_profit_rate);
  const explicitUnrealizedRate = asNumber(raw.unrealized_profit_rate);
  const realizedCostUsd = explicitRealizedProfitUsd !== null && sellVolumeUsd - explicitRealizedProfitUsd > 0
    ? sellVolumeUsd - explicitRealizedProfitUsd
    : rawRemainingCostUsd !== null
      ? Math.max(0, buyVolumeUsd - remainingCostUsd)
      : estimatedSoldCostUsd;
  const realizedMultiple = sellVolumeUsd > 0 && sellAmount > 0
    ? returnMultiple(sellVolumeUsd, realizedCostUsd)
    : null;
  const unrealizedMultiple = returnMultiple(holdingValueUsd, remainingCostUsd);
  const totalMultiple = sellVolumeUsd > 0 || holdingValueUsd > 0
    ? returnMultiple(sellVolumeUsd + holdingValueUsd, buyVolumeUsd)
    : null;
  const profitRate = asNumber(raw.profit_rate);
  return {
    address: String(raw.wallet || requestedWallet || '').toLowerCase(),
    tokenAddress: String(raw.token || '').toLowerCase(),
    chain: String(raw.chain || 'robinhood'),
    currentPriceUsd,
    buyAmount,
    sellAmount,
    buyVolumeUsd,
    sellVolumeUsd,
    buyTimes: Math.max(0, asNumber(raw.buy_times ?? raw.buy_count) ?? 0),
    sellTimes: Math.max(0, asNumber(raw.sell_times ?? raw.sell_count) ?? 0),
    holdingTokenAmount,
    holdingValueUsd,
    averageBuyPriceUsd,
    averageCostPriceUsd: asNumber(raw.avg_cost_price),
    remainingCostUsd,
    realizedProfitUsd: explicitRealizedProfitUsd ?? (
      realizedCostUsd === null ? null : sellVolumeUsd - realizedCostUsd
    ),
    unrealizedProfitUsd: explicitUnrealizedProfitUsd ?? (
      currentPriceUsd === null ? null : holdingValueUsd - remainingCostUsd
    ),
    totalProfitUsd: asNumber(raw.profit) ?? (
      buyVolumeUsd > 0 ? sellVolumeUsd + holdingValueUsd - buyVolumeUsd : null
    ),
    profitRate,
    realizedProfitRate: explicitRealizedRate,
    unrealizedProfitRate: explicitUnrealizedRate,
    realizedMultiple,
    unrealizedMultiple,
    totalMultiple: totalMultiple ?? (profitRate === null ? null : 1 + profitRate),
    feesUsd: asNumber(raw.fees_usd),
    transactionFeesUsd: asNumber(raw.tx_fees_usd),
    firstTradeAt: asNumber(raw.first_trade_time),
    lastTradeAt: asNumber(raw.last_trade_time),
    holdDurationSeconds: asNumber(raw.hold_duration),
    firstFunding: raw.first_funding && typeof raw.first_funding === 'object' ? raw.first_funding : null,
    profitSource: 'debot_wallet_token_analysis',
    profitState: 'complete'
  };
}

export function normalizeTokenDetail(raw = {}) {
  const token = raw.token || {};
  const meta = token.meta || {};
  const pair = raw.pair || {};
  const market = raw.market_metrics || {};
  const pools = Array.isArray(raw.pools?.list) ? raw.pools.list : [];
  const primaryPoolAddress = String(pair.tokenPairAddress || pair.pair || '').toLowerCase();
  const primaryDex = String(pair.dex?.dex_name || pair.dex_name || '');
  return {
    chain: String(meta.chain || pair.chain || 'robinhood'),
    address: String(meta.address || pair.tokenAddress || '').toLowerCase(),
    symbol: String(meta.symbol || pair.tokenSymbol || 'UNKNOWN'),
    name: String(meta.name || pair.tokenName || meta.symbol || 'Unknown'),
    decimals: asNumber(meta.decimals ?? pair.decimals) ?? 18,
    logo: String(meta.logo || token.social?.logo_cache || pair.tokenIcon || ''),
    creationTimestamp: asNumber(meta.creation_timestamp ?? pair.createTimestamp),
    creatorAddress: String(meta.creator_address || '').toLowerCase(),
    priceUsd: asNumber(market.price ?? pair.price),
    marketCapUsd: asNumber(market.mkt_cap ?? market.fdv ?? pair.market_cap),
    liquidityUsd: asNumber(market.total_liquidity ?? market.liquidity ?? pair.liquidity),
    holders: asNumber(market.holders),
    totalSupply: asNumber(pair.totalSupply),
    primaryPoolAddress,
    primaryDex,
    pools: pools.map((pool) => ({
      address: String(pool.pair || '').toLowerCase(),
      dex: String(pool.dex_name || pool.contract || ''),
      liquidityUsd: asNumber(pool.liquidity),
      quoteSymbol: String(pool.base_token?.symbol || ''),
      quoteAddress: String(pool.base_token?.address || '').toLowerCase()
    })),
    updatedAt: asNumber(market.update_time ?? pair.lastUpdateTime) || Math.floor(Date.now() / 1000)
  };
}

export function normalizeMarketHistory(raw = {}) {
  const decimals = asNumber(raw.decimals);
  const rawSupply = asNumber(raw.total_supply);
  const normalizedSupply =
    rawSupply !== null && decimals !== null
      ? rawSupply / (10 ** decimals)
      : null;
  const candles = (Array.isArray(raw.list) ? raw.list : [])
    .map((row) => ({
      time: asNumber(row?.time),
      high: asNumber(row?.high)
    }))
    .filter((row) => row.time !== null && row.high !== null && row.high > 0);
  return { decimals, normalizedSupply, candles };
}

export class RobinhoodDebotClient {
  constructor({ baseUrl = DEBOT_BASE_URL, timeoutMs = 20_000, fetchImpl = globalThis.fetch } = {}) {
    if (typeof fetchImpl !== 'function') throw new TypeError('fetchImpl is required');
    this.baseUrl = String(baseUrl || DEBOT_BASE_URL).replace(/\/$/, '');
    this.timeoutMs = Math.max(1_000, Number(timeoutMs) || 20_000);
    this.fetchImpl = fetchImpl;
  }

  async fetchHotTokens({ signal } = {}) {
    const rows = await requestJson(
      `${this.baseUrl}/dashboard/chain/recommend/hot_token?chain=robinhood`,
      { timeoutMs: this.timeoutMs, signal, fetchImpl: this.fetchImpl }
    );
    return rows.map(normalizeHotToken).filter((token) => /^0x[0-9a-f]{40}$/.test(token.address));
  }


  async fetchTokenMetrics(tokenAddress, { signal } = {}) {
    const address = String(tokenAddress || '').toLowerCase();
    const raw = await requestObject(
      `${this.baseUrl}/dashboard/token/market/metrics?chain=robinhood&token=${encodeURIComponent(address)}`,
      { timeoutMs: this.timeoutMs, signal, fetchImpl: this.fetchImpl }
    );
    return normalizeTokenMetrics(raw);
  }

  async fetchTokenSafety(tokenAddress, { signal } = {}) {
    const address = String(tokenAddress || '').toLowerCase();
    const raw = await requestObject(
      `${this.baseUrl}/dashboard/token/safe_info?chain=robinhood&token=${encodeURIComponent(address)}`,
      { timeoutMs: this.timeoutMs, signal, fetchImpl: this.fetchImpl }
    );
    return normalizeSafety(raw);
  }

  async fetchTokenDetail(tokenAddress, { signal } = {}) {
    const address = String(tokenAddress || '').toLowerCase();
    if (!ADDRESS_PATTERN.test(address)) throw new TypeError('Invalid Robinhood token address');
    const raw = await requestObject(
      `${this.baseUrl}/dashboard/token/detail?chain=robinhood&token=${encodeURIComponent(address)}`,
      { timeoutMs: this.timeoutMs, signal, fetchImpl: this.fetchImpl }
    );
    return normalizeTokenDetail(raw);
  }

  async fetchTokenPeakMarketCap(tokenAddress, detail, { signal } = {}) {
    const address = String(tokenAddress || '').toLowerCase();
    if (!ADDRESS_PATTERN.test(address)) throw new TypeError('Invalid Robinhood token address');
    const tokenDetail = detail || await this.fetchTokenDetail(address, { signal });
    const primaryPoolAddress = String(
      tokenDetail?.primaryPoolAddress ||
      tokenDetail?.pools?.[0]?.address ||
      ''
    ).toLowerCase();
    if (!ADDRESS_PATTERN.test(primaryPoolAddress)) {
      throw new Error('DeBot token detail did not include a valid primary pool');
    }
    const params = new URLSearchParams({
      chain: 'robinhood',
      token: address,
      pair: primaryPoolAddress,
      dex_name: String(tokenDetail?.primaryDex || tokenDetail?.pools?.[0]?.dex || 'uniswapv2'),
      interval: '86400',
      limit: '1000',
      start: String(Math.max(0, Math.floor(asNumber(tokenDetail?.creationTimestamp) ?? 0))),
      end: '0'
    });
    let oldest = null;
    let peakPriceUsd = null;
    let peakMarketCapAt = null;
    let normalizedSupply = asNumber(tokenDetail?.totalSupply);
    let pages = 0;
    while (pages < 100) {
      const raw = await requestObject(`${this.baseUrl}/market/v4?${params}`, {
        timeoutMs: this.timeoutMs,
        signal,
        fetchImpl: this.fetchImpl
      });
      const page = normalizeMarketHistory(raw);
      if (page.normalizedSupply > 0) normalizedSupply = page.normalizedSupply;
      for (const candle of page.candles) {
        if (peakPriceUsd === null || candle.high > peakPriceUsd) {
          peakPriceUsd = candle.high;
          peakMarketCapAt = candle.time;
        }
      }
      pages += 1;
      if (page.candles.length < 1000) break;
      const nextOldest = Math.min(...page.candles.map((candle) => candle.time));
      if (!(nextOldest > 0) || nextOldest === oldest || nextOldest <= Number(params.get('start'))) break;
      oldest = nextOldest;
      params.set('end', String(nextOldest));
    }
    if (!(peakPriceUsd > 0) || !(normalizedSupply > 0)) {
      throw new Error('DeBot market history did not include a usable price or supply');
    }
    return {
      peakPriceUsd,
      peakMarketCapUsd: peakPriceUsd * normalizedSupply,
      peakMarketCapAt,
      normalizedSupply,
      primaryPoolAddress,
      source: 'debot_primary_pool_daily_high',
      provisional: false,
      pages
    };
  }

  async fetchWalletTokenProfit(tokenAddress, walletAddress, { signal } = {}) {
    const token = String(tokenAddress || '').toLowerCase();
    const wallet = String(walletAddress || '').toLowerCase();
    if (!ADDRESS_PATTERN.test(token)) throw new TypeError('Invalid Robinhood token address');
    if (!ADDRESS_PATTERN.test(wallet)) throw new TypeError('Invalid Robinhood wallet address');
    const raw = await requestObject(
      `${this.baseUrl}/dex/profit/wallet_token_analysis?chain=robinhood&token=${encodeURIComponent(token)}&wallet=${encodeURIComponent(wallet)}`,
      { timeoutMs: this.timeoutMs, signal, fetchImpl: this.fetchImpl }
    );
    return normalizeWalletTokenProfit(raw, wallet);
  }
}
