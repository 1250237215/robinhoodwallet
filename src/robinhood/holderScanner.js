import { ROBINHOOD_CHAIN, createRobinhoodConfig } from './config.js';
import { deriveWalletAdmissionMultiple } from './analysis.js';

const ADDRESS_PATTERN = /^0x[0-9a-f]{40}$/;

function normalizeAddress(value) {
  return String(value || '').toLowerCase();
}

function number(value) {
  if (value === null || value === undefined || value === '') return null;
  const next = Number(value);
  return Number.isFinite(next) ? next : null;
}

function round(value, digits = 4) {
  if (value === null || value === undefined || value === '') return null;
  if (!Number.isFinite(Number(value))) return null;
  const scale = 10 ** digits;
  return Math.round(Number(value) * scale) / scale;
}

function addressAdapter(chainProfile, addressNormalizer, addressValidator) {
  const normalize = addressNormalizer || chainProfile?.addressNormalizer || normalizeAddress;
  const validate = addressValidator || chainProfile?.addressValidator || ((value) => ADDRESS_PATTERN.test(value));
  if (typeof normalize !== 'function') throw new TypeError('addressNormalizer must be a function');
  if (typeof validate !== 'function') throw new TypeError('addressValidator must be a function');
  return {
    normalize: (value) => String(normalize(value) || ''),
    validate: (value) => validate(value) === true
  };
}

function knownInfrastructure(tokenAddress, tokenDetail, chainProfile, adapter) {
  const profileAddresses = [
    chainProfile?.weth,
    chainProfile?.usdg,
    chainProfile?.usdc,
    chainProfile?.v2Factory,
    chainProfile?.v2Router,
    chainProfile?.v3Factory,
    chainProfile?.v3Router,
    ...(Array.isArray(chainProfile?.quoteTokens) ? chainProfile.quoteTokens : []),
    ...(Array.isArray(chainProfile?.infrastructureAddresses) ? chainProfile.infrastructureAddresses : [])
  ];
  return new Set([
    '0x0000000000000000000000000000000000000000',
    '0x000000000000000000000000000000000000dead',
    ...profileAddresses,
    tokenAddress,
    tokenDetail?.creatorAddress,
    ...(Array.isArray(tokenDetail?.pools) ? tokenDetail.pools.map((pool) => pool.address) : [])
  ].map(adapter.normalize).filter(adapter.validate));
}

async function mapLimit(items, concurrency, mapper) {
  const results = new Array(items.length);
  let cursor = 0;
  const workers = Array.from({ length: Math.min(items.length, Math.max(1, concurrency)) }, async () => {
    while (cursor < items.length) {
      const index = cursor;
      cursor += 1;
      results[index] = await mapper(items[index], index);
    }
  });
  await Promise.all(workers);
  return results;
}

function mergeCandidate(holder, profit, tokenDetail, minimumEntryUsd, minimumHitMultiple, normalize = normalizeAddress) {
  const currentPriceUsd = number(profit.currentPriceUsd ?? tokenDetail?.priceUsd);
  const holdingTokenAmount = number(holder.holdingTokenAmount ?? profit.holdingTokenAmount);
  const holdingValueUsd = number(profit.holdingValueUsd) ??
    (holdingTokenAmount !== null && currentPriceUsd > 0 ? holdingTokenAmount * currentPriceUsd : null);
  const buyVolumeUsd = Math.max(0, number(profit.buyVolumeUsd) ?? 0);
  const realizedMultiple = number(profit.realizedMultiple);
  const unrealizedMultiple = number(profit.unrealizedMultiple);
  const totalMultiple = number(profit.totalMultiple);
  const admission = deriveWalletAdmissionMultiple({ ...profit, holdingTokenAmount });
  const bestMultiple = Math.max(0, number(admission.admissionMultiple) ?? 0);
  const averageBuyPriceUsd = number(profit.averageBuyPriceUsd);
  const entryProgress = averageBuyPriceUsd > 0 && currentPriceUsd > 0
    ? Math.min(1, averageBuyPriceUsd / currentPriceUsd)
    : null;
  const early = entryProgress !== null && entryProgress <= 0.2;
  const eligible = buyVolumeUsd >= minimumEntryUsd;
  return {
    ...holder,
    ...profit,
    address: normalize(holder.address || profit.address),
    holderRank: number(holder.holderRank),
    holdingTokenAmount,
    holdingValueUsd: round(holdingValueUsd, 2),
    holdingSharePercent: round(holder.holdingSharePercent, 6),
    currentPriceUsd,
    rawBuyVolumeUsd: buyVolumeUsd,
    buyVolumeUsd: round(buyVolumeUsd, 2),
    entryCostUsd: round(buyVolumeUsd, 2),
    realizedProfitUsd: round(profit.realizedProfitUsd, 2),
    unrealizedProfitUsd: round(profit.unrealizedProfitUsd, 2),
    totalProfitUsd: round(profit.totalProfitUsd, 2),
    realizedMultiple: round(realizedMultiple),
    unrealizedMultiple: round(unrealizedMultiple),
    totalMultiple: round(totalMultiple),
    bestMultiple: round(bestMultiple),
    ...admission,
    entryProgress: round(entryProgress),
    early,
    hit: Boolean(eligible && early && bestMultiple >= minimumHitMultiple),
    eligible,
    ignoredReason: eligible ? '' : 'below_minimum_entry',
    candidateReason: 'top_holder',
    profitState: 'complete',
    confidence: 'high'
  };
}

export async function scanTokenHolders({
  token,
  holderClient,
  debotClient,
  config: providedConfig,
  chainProfile = ROBINHOOD_CHAIN,
  holderSource: providedHolderSource,
  addressNormalizer,
  addressValidator,
  signal,
  onProgress = () => {}
}) {
  const config = { ...createRobinhoodConfig({}), ...(providedConfig || {}) };
  const adapter = addressAdapter(chainProfile, addressNormalizer, addressValidator);
  const chainName = String(chainProfile?.name || 'Robinhood');
  const minimumEntryUsd = Math.max(0, number(config.minEntryUsd) ?? 500);
  const tokenAddress = adapter.normalize(token?.address);
  if (!adapter.validate(tokenAddress)) throw new TypeError(`Invalid ${chainName} token address`);
  if (!holderClient?.fetchTopHolders) throw new Error(`${chainName} holder client is unavailable`);
  if (!debotClient?.fetchTokenDetail || !debotClient?.fetchWalletTokenProfit) {
    throw new Error('DeBot wallet profit client is unavailable');
  }

  onProgress({ stage: 'holder_sources', percent: 5 });
  const [tokenDetail, holderSnapshot] = await Promise.all([
    debotClient.fetchTokenDetail(tokenAddress, { signal }),
    holderClient.fetchTopHolders(tokenAddress, {
      limit: Math.max(config.holderCandidateLimit, config.holderFetchLimit),
      signal
    })
  ]);
  const holderSource = String(
    providedHolderSource || holderSnapshot?.source || chainProfile?.holderSource || 'blockscout'
  ).trim() || 'blockscout';
  const holderSourceKey = holderSource.toLowerCase().replace(/[^a-z0-9]+/g, '_').replace(/^_|_$/g, '') || 'holder';
  const peakMarketCapPromise = typeof debotClient.fetchTokenPeakMarketCap === 'function'
    ? debotClient.fetchTokenPeakMarketCap(tokenAddress, tokenDetail, { signal })
        .then((value) => ({ value, error: null }))
        .catch((error) => ({
          value: null,
          error: error instanceof Error ? error.message : String(error)
        }))
    : Promise.resolve({ value: null, error: 'peak_market_cap_client_unavailable' });
  const infrastructure = knownInfrastructure(tokenAddress, tokenDetail, chainProfile, adapter);
  const candidates = [];
  for (const holder of holderSnapshot.holders) {
    const address = adapter.normalize(holder.address);
    const reasons = [...(holder.exclusionReasons || [])];
    if (!adapter.validate(address)) reasons.push('invalid_address');
    if (infrastructure.has(address)) {
      reasons.push(address === adapter.normalize(tokenDetail.creatorAddress) ? 'developer' : 'known_infrastructure');
    }
    if (reasons.length) continue;
    candidates.push({ ...holder, address });
    if (candidates.length >= config.holderCandidateLimit) break;
  }

  onProgress({
    stage: 'holder_candidates',
    percent: 15,
    completed: 0,
    total: candidates.length,
    holders: holderSnapshot.holders.length
  });
  let completed = 0;
  const failures = [];
  const analyzed = await mapLimit(candidates, config.holderProfitConcurrency, async (holder) => {
    try {
      const profit = await debotClient.fetchWalletTokenProfit(tokenAddress, holder.address, { signal });
      return mergeCandidate(
        holder,
        profit,
        tokenDetail,
        minimumEntryUsd,
        config.defaultWinnerMultiple,
        adapter.normalize
      );
    } catch (error) {
      if (error?.name === 'AbortError') throw error;
      failures.push({
        address: holder.address,
        error: error instanceof Error ? error.message : String(error)
      });
      return {
        ...holder,
        eligible: false,
        ignoredReason: 'profit_unavailable',
        candidateReason: 'top_holder',
        profitState: 'failed',
        confidence: 'low'
      };
    } finally {
      completed += 1;
      onProgress({
        stage: 'wallet_profits',
        percent: 15 + Math.round((completed / Math.max(1, candidates.length)) * 80),
        completed,
        total: candidates.length
      });
    }
  });
  const eligible = analyzed.filter((candidate) => candidate.eligible);
  const peakResult = await peakMarketCapPromise;
  const complete = failures.length === 0;
  const updatedAt = Math.floor(Date.now() / 1000);
  const highestLiquidity = Math.max(
    number(tokenDetail.liquidityUsd) ?? 0,
    ...(tokenDetail.pools || []).map((pool) => number(pool.liquidityUsd) ?? 0)
  );
  const cachedPeakMarketCapUsd = number(token?.peakMarketCapUsd);
  const fetchedPeakMarketCapUsd = number(peakResult.value?.peakMarketCapUsd);
  const currentMarketCapUsd = number(tokenDetail.marketCapUsd ?? token?.marketCapUsd);
  const peakMarketCapUsd = Math.max(
    0,
    cachedPeakMarketCapUsd ?? 0,
    fetchedPeakMarketCapUsd ?? 0,
    currentMarketCapUsd ?? 0
  ) || null;
  const peakFromHistory = fetchedPeakMarketCapUsd !== null || cachedPeakMarketCapUsd !== null;
  const peakMarketCapProvisional = !peakFromHistory;
  const selectedPeakSource =
    fetchedPeakMarketCapUsd !== null && fetchedPeakMarketCapUsd === peakMarketCapUsd
      ? 'fetched'
      : cachedPeakMarketCapUsd !== null && cachedPeakMarketCapUsd === peakMarketCapUsd
        ? 'cached'
        : currentMarketCapUsd !== null && currentMarketCapUsd === peakMarketCapUsd
          ? 'current'
          : 'unavailable';
  const peakPriceUsd = selectedPeakSource === 'fetched'
    ? number(peakResult.value?.peakPriceUsd)
    : selectedPeakSource === 'cached'
      ? number(token?.peakPriceUsd)
      : selectedPeakSource === 'current'
        ? number(tokenDetail.priceUsd)
        : null;
  const peakMarketCapAt = selectedPeakSource === 'fetched'
    ? number(peakResult.value?.peakMarketCapAt)
    : selectedPeakSource === 'cached'
      ? number(token?.peakMarketCapAt)
      : selectedPeakSource === 'current'
        ? updatedAt
        : null;
  const peakMarketCapSource = selectedPeakSource === 'fetched'
    ? String(peakResult.value?.source || 'debot_primary_pool_daily_high')
    : selectedPeakSource === 'cached'
      ? String(token?.peakMarketCapSource || 'cached_historical_peak')
      : selectedPeakSource === 'current'
        ? peakFromHistory ? 'debot_current_market_cap_above_cached_history' : 'debot_current_market_cap_only'
        : 'unavailable';
  const qualification = {
    status: 'manual',
    qualified: false,
    provisional: !complete,
    confidence: complete ? 'high' : 'medium',
    priceSource: 'debot_current_snapshot',
    liquiditySource: 'debot_token_detail',
    walletCountSource: `${holderSourceKey}_holder_index`,
    peakMultiple: null,
    peakLiquidityUsd: highestLiquidity || null,
    effectiveWallets: number(tokenDetail.holders ?? holderSnapshot.token?.holders),
    checks: { multiple: null, liquidity: highestLiquidity > 0, wallets: candidates.length > 0 },
    thresholds: {
      multiple: config.defaultWinnerMultiple,
      minLiquidityUsd: config.minLiquidityUsd,
      minWallets: config.minEffectiveWallets,
      minEntryUsd: minimumEntryUsd
    }
  };
  const holderAnalysis = {
    strategy: 'holder_first',
    holderSource,
    profitSource: 'debot_wallet_token_analysis',
    holderLimit: config.holderCandidateLimit,
    fetchedHolders: holderSnapshot.holders.length,
    analyzedWallets: analyzed.length,
    eligibleWallets: eligible.length,
    ignoredBelowEntry: analyzed.filter((candidate) => candidate.ignoredReason === 'below_minimum_entry').length,
    failedWallets: failures.length,
    minimumEntryUsd,
    snapshotAt: holderSnapshot.snapshotAt,
    complete,
    candidates: analyzed,
    failures
  };
  onProgress({ stage: 'complete', percent: 100, completed: analyzed.length, total: candidates.length });
  return {
    tokenPatch: {
      ...tokenDetail,
      address: tokenAddress,
      symbol: tokenDetail.symbol || token?.symbol,
      name: tokenDetail.name || token?.name,
      logo: tokenDetail.logo || token?.logo || holderSnapshot.token?.logo || '',
      priceUsd: number(tokenDetail.priceUsd ?? holderSnapshot.token?.priceUsd),
      marketCapUsd: currentMarketCapUsd,
      peakPriceUsd,
      peakMarketCapUsd,
      peakMarketCapAt,
      peakMarketCapSource,
      peakMarketCapProvisional,
      peakMarketCapError: peakResult.error,
      liquidityUsd: highestLiquidity || null,
      peakLiquidityUsd: highestLiquidity || null,
      effectiveWallets: qualification.effectiveWallets,
      qualificationStatus: 'manual',
      holderAnalysis,
      analysisSource: 'debot_holder_first',
      analysisFallback: null,
      updatedAt
    },
    qualification,
    holderAnalysis,
    actions: [],
    scan: {
      complete,
      partial: !complete,
      strategy: 'holder_first',
      source: 'debot_holder_first',
      analysisSource: 'debot_holder_first',
      holderSource,
      profitSource: 'debot_wallet_token_analysis',
      holderLimit: config.holderCandidateLimit,
      fetchedHolders: holderSnapshot.holders.length,
      analyzedWallets: analyzed.length,
      eligibleWallets: eligible.length,
      ignoredBelowEntry: holderAnalysis.ignoredBelowEntry,
      failedWallets: failures.length,
      minimumEntryUsd,
      parserConfidence: complete ? 'high' : 'medium'
    }
  };
}
