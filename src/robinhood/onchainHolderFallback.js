import { analyzeWalletToken } from './analysis.js';
import { scanTokenHolders } from './holderScanner.js';
import { reliablePriceStats } from './qualification.js';

const ADDRESS_PATTERN = /^0x[0-9a-f]{40}$/;
const POSITION_MATCH_TOLERANCE = 0.001;

function normalizeAddress(value) {
  return String(value || '').trim().toLowerCase();
}

function number(...values) {
  for (const value of values) {
    if (value === null || value === undefined || value === '') continue;
    const parsed = Number(value);
    if (Number.isFinite(parsed)) return parsed;
  }
  return null;
}

function round(value, digits = 8) {
  if (!Number.isFinite(Number(value))) return null;
  const scale = 10 ** digits;
  return Math.round(Number(value) * scale) / scale;
}

function errorMessage(error) {
  return error instanceof Error ? error.message : String(error || 'Unknown onchain Holder analysis error');
}

function isAddress(value) {
  return ADDRESS_PATTERN.test(normalizeAddress(value));
}

function ordered(actions) {
  return [...actions].sort(
    (left, right) =>
      (Number(left?.blockNumber) || 0) - (Number(right?.blockNumber) || 0) ||
      (Number(left?.transactionIndex) || 0) - (Number(right?.transactionIndex) || 0) ||
      (Number(left?.logIndex) || 0) - (Number(right?.logIndex) || 0)
  );
}

function hasMatchingPosition(expected, actual) {
  if (!(expected >= 0) || !(actual >= 0)) return false;
  const scale = Math.max(1, expected, actual);
  return Math.abs(expected - actual) <= Math.max(1e-8, scale * POSITION_MATCH_TOLERANCE);
}

function latestTimestamp(actions) {
  return ordered(actions)
    .map((action) => number(action.blockTimestamp))
    .filter((value) => value !== null)
    .at(-1) ?? null;
}

function firstTimestamp(actions) {
  return ordered(actions)
    .map((action) => number(action.blockTimestamp))
    .find((value) => value !== null) ?? null;
}

function actionMap(actions) {
  const byWallet = new Map();
  for (const action of Array.isArray(actions) ? actions : []) {
    const wallet = normalizeAddress(action?.wallet);
    if (!isAddress(wallet) || action?.excluded || String(action?.attributionConfidence || 'low').toLowerCase() === 'low') continue;
    if (!byWallet.has(wallet)) byWallet.set(wallet, []);
    byWallet.get(wallet).push(action);
  }
  for (const walletActions of byWallet.values()) walletActions.sort((left, right) => {
    return (Number(left?.blockNumber) || 0) - (Number(right?.blockNumber) || 0) ||
      (Number(left?.transactionIndex) || 0) - (Number(right?.transactionIndex) || 0) ||
      (Number(left?.logIndex) || 0) - (Number(right?.logIndex) || 0);
  });
  return byWallet;
}

function observedNetTokenPosition(actions) {
  return (Array.isArray(actions) ? actions : []).reduce((net, action) => {
    const amount = Math.max(0, number(action?.tokenAmount) ?? 0);
    if (action?.side === 'buy') return net + amount;
    if (action?.side === 'sell') return net - amount;
    return net;
  }, 0);
}

function holderMap(holders) {
  return new Map(
    (Array.isArray(holders) ? holders : [])
      .map((holder) => [normalizeAddress(holder?.address), holder])
      .filter(([address]) => isAddress(address))
  );
}

function onchainPeak({ actions, quoteUsd, totalSupply, historyComplete }) {
  if (historyComplete !== true || !(quoteUsd > 0) || !(totalSupply > 0)) return null;
  const attributableActions = (Array.isArray(actions) ? actions : []).filter((action) => {
    return !action?.excluded && String(action?.attributionConfidence || 'low').toLowerCase() !== 'low';
  });
  const priceStats = reliablePriceStats(attributableActions);
  if (!priceStats.reliable || !(priceStats.peakPriceNative > 0)) return null;
  const peakPriceNative = number(priceStats.peakPriceNative);
  const peakAction = attributableActions.find((action) => {
    const priceNative = number(action?.priceNative);
    return priceNative !== null && Math.abs(priceNative - peakPriceNative) <= Math.max(1e-12, peakPriceNative * 1e-10);
  }) || null;
  if (!(peakPriceNative > 0)) return null;
  const peakPriceUsd = peakPriceNative * quoteUsd;
  return {
    peakPriceUsd: round(peakPriceUsd, 12),
    peakMarketCapUsd: round(peakPriceUsd * totalSupply, 2),
    peakMarketCapAt: number(peakAction?.blockTimestamp),
    peakMarketCapSource: 'verified_pool_swap_peak_price_current_supply',
    // Swap prices are historical, but Blockscout exposes the current supply only.
    peakMarketCapProvisional: true,
    peakMarketCapError: 'historical_supply_unavailable'
  };
}

function cachedVerifiedPeak(token) {
  const source = String(token?.peakMarketCapSource || '');
  const marketCapUsd = number(token?.peakMarketCapUsd);
  const peakPriceUsd = number(token?.peakPriceUsd);
  if (!(marketCapUsd > 0) || !(peakPriceUsd > 0) || token?.peakMarketCapProvisional === true) return null;
  if (!source.startsWith('verified_pool_swap_peak')) return null;
  return {
    peakPriceUsd,
    peakMarketCapUsd: marketCapUsd,
    peakMarketCapAt: number(token?.peakMarketCapAt),
    peakMarketCapSource: source,
    peakMarketCapProvisional: false,
    peakMarketCapError: null
  };
}

function provisionalPeak(tokenDetail) {
  const currentPriceUsd = number(tokenDetail?.priceUsd);
  const currentMarketCapUsd = number(tokenDetail?.marketCapUsd);
  return {
    peakPriceUsd: currentPriceUsd,
    peakMarketCapUsd: currentMarketCapUsd,
    peakMarketCapAt: null,
    peakMarketCapSource: currentMarketCapUsd > 0 ? 'current_onchain_snapshot' : 'unavailable',
    peakMarketCapProvisional: true,
    peakMarketCapError: 'verified_pool_history_incomplete'
  };
}

function onchainTokenDetail({ token, onchainResult, holderSnapshot, quoteUsd, currentPriceNative, currentPriceUsd, peak }) {
  const patch = onchainResult?.tokenPatch || {};
  const pool = onchainResult?.pool || {};
  const snapshotToken = holderSnapshot?.token || {};
  const totalSupply = number(snapshotToken.totalSupply);
  const marketCapUsd = number(
    patch.marketCapUsd,
    currentPriceUsd !== null && totalSupply !== null ? currentPriceUsd * totalSupply : null,
    token?.marketCapUsd
  );
  const liquidityUsd = number(pool.verifiedLiquidityUsd, token?.liquidityUsd, patch.liquidityUsd);
  const address = normalizeAddress(token?.address);
  return {
    address,
    symbol: String(patch.symbol || token?.symbol || snapshotToken.symbol || 'UNKNOWN'),
    name: String(patch.name || token?.name || snapshotToken.name || patch.symbol || token?.symbol || 'Unknown'),
    logo: String(patch.logo || token?.logo || snapshotToken.logo || ''),
    creationTimestamp: number(token?.creationTimestamp, patch.creationTimestamp),
    priceUsd: currentPriceUsd,
    marketCapUsd,
    liquidityUsd,
    holders: number(snapshotToken.holders),
    totalSupply,
    primaryPoolAddress: normalizeAddress(pool.address),
    primaryDex: String(pool.dexId || pool.version || ''),
    pools: isAddress(pool.address) ? [{
      address: normalizeAddress(pool.address),
      dex: String(pool.dexId || pool.version || ''),
      liquidityUsd,
      quoteAddress: normalizeAddress(pool.quoteToken),
      quoteSymbol: String(pool.quoteSymbol || '')
    }] : [],
    currentPriceNative,
    quoteUsd,
    ...(peak || {})
  };
}

function onchainWalletProfit({ wallet, holders, actionsByWallet, currentPriceNative, currentPriceUsd, quoteUsd }) {
  const normalized = normalizeAddress(wallet);
  const holder = holders.get(normalized);
  const actions = actionsByWallet.get(normalized) || [];
  if (!holder) throw new Error('Holder is not present in the Blockscout snapshot');
  if (!actions.length) throw new Error('No verified-pool swap was attributable to this Holder');
  if (!(currentPriceNative > 0) || !(currentPriceUsd > 0) || !(quoteUsd > 0)) {
    throw new Error('Verified pool price conversion is unavailable');
  }

  const result = analyzeWalletToken({ actions, currentPriceNative });
  const holdingTokenAmount = number(holder.holdingTokenAmount);
  if (!(holdingTokenAmount >= 0)) throw new Error('Current Holder balance is unavailable');
  const observedPosition = observedNetTokenPosition(actions);
  if (!hasMatchingPosition(observedPosition, holdingTokenAmount)) {
    throw new Error('Observed net token position does not reconcile with the current Holder balance');
  }
  if (!hasMatchingPosition(number(result.remainingTokenAmount) ?? -1, holdingTokenAmount)) {
    throw new Error('Observed pool-swap lots do not reconcile with the current Holder balance');
  }

  const buyAmount = number(result.boughtTokenAmount) ?? 0;
  const sellAmount = number(result.soldTokenAmount) ?? 0;
  const entryCostNative = number(result.totalEntryCostNative) ?? 0;
  const remainingCostNative = number(result.remainingCostNative) ?? 0;
  const realizedProceedsNative = number(result.realizedProceedsNative) ?? 0;
  if (!(entryCostNative > 0) || !(buyAmount > 0)) throw new Error('Observed Holder buy cost is unavailable');

  const currentValueUsd = holdingTokenAmount * currentPriceUsd;
  const realizedProfitUsd = (number(result.realizedProfitNative) ?? 0) * quoteUsd;
  const unrealizedProfitUsd = currentValueUsd - remainingCostNative * quoteUsd;
  const totalProfitUsd = realizedProfitUsd + unrealizedProfitUsd;
  const totalMultiple = (realizedProceedsNative + holdingTokenAmount * currentPriceNative) / entryCostNative;
  const firstBuy = actions.find((action) => action.side === 'buy') || actions[0];

  return {
    address: normalized,
    currentPriceUsd,
    buyAmount: round(buyAmount, 8),
    sellAmount: round(sellAmount, 8),
    buyVolumeUsd: round(entryCostNative * quoteUsd, 2),
    sellVolumeUsd: round(realizedProceedsNative * quoteUsd, 2),
    holdingTokenAmount: round(holdingTokenAmount, 8),
    holdingValueUsd: round(currentValueUsd, 2),
    averageBuyPriceUsd: round((entryCostNative * quoteUsd) / buyAmount, 12),
    remainingCostUsd: round(remainingCostNative * quoteUsd, 2),
    realizedProfitUsd: round(realizedProfitUsd, 2),
    unrealizedProfitUsd: round(unrealizedProfitUsd, 2),
    totalProfitUsd: round(totalProfitUsd, 2),
    realizedMultiple: number(result.realizedMultiple),
    unrealizedMultiple: number(result.unrealizedMultiple),
    totalMultiple: round(totalMultiple),
    firstTradeAt: firstTimestamp(actions),
    lastTradeAt: latestTimestamp(actions),
    entryBlock: number(firstBuy?.blockNumber),
    profitSource: 'verified_pool_swaps_and_blockscout_holders',
    profitState: 'complete'
  };
}

/**
 * Builds a conservative Holder-first snapshot without DeBot. It only admits
 * wallets when their Blockscout balance reconciles with observed pool swaps.
 */
export async function scanTokenHoldersOnchainFallback({
  token,
  onchainResult,
  holderClient,
  config = {},
  signal,
  onProgress = () => {}
} = {}) {
  const tokenAddress = normalizeAddress(token?.address);
  if (!isAddress(tokenAddress)) throw new TypeError('Invalid Robinhood token address');
  if (!holderClient?.fetchTopHolders) throw new Error('Robinhood Holder client is unavailable');
  if (onchainResult?.scan?.historyComplete !== true) {
    throw new Error('Verified-pool transaction history is incomplete; Holder profit reconciliation was skipped');
  }

  const holderLimit = Math.max(
    10,
    Math.floor(number(config.holderCandidateLimit, 100) ?? 100),
    Math.floor(number(config.holderFetchLimit, 150) ?? 150)
  );
  onProgress({ stage: 'holder_snapshot', percent: 60, source: 'blockscout' });
  const holderSnapshot = await holderClient.fetchTopHolders(tokenAddress, { limit: holderLimit, signal });
  const actions = Array.isArray(onchainResult?.actions) ? onchainResult.actions : [];
  const pool = onchainResult?.pool || {};
  const patch = onchainResult?.tokenPatch || {};
  const quoteUsd = number(patch.quoteUsd, pool.quoteUsd, token?.quoteUsd);
  const currentPriceNative = number(patch.currentPriceNative, pool.currentPriceNative);
  const currentPriceUsd = number(
    patch.priceUsd,
    currentPriceNative !== null && quoteUsd !== null ? currentPriceNative * quoteUsd : null,
    token?.priceUsd,
    holderSnapshot?.token?.priceUsd
  );
  const peak = onchainPeak({
    actions,
    quoteUsd,
    totalSupply: number(holderSnapshot?.token?.totalSupply),
    historyComplete: onchainResult?.scan?.historyComplete
  });
  const tokenDetail = onchainTokenDetail({
    token: { ...token, ...(peak || {}) },
    onchainResult,
    holderSnapshot,
    quoteUsd,
    currentPriceNative,
    currentPriceUsd,
    peak
  });
  const peakPatch = peak || cachedVerifiedPeak(token) || provisionalPeak(tokenDetail);
  const holders = holderMap(holderSnapshot?.holders);
  const actionsByWallet = actionMap(actions);
  const profitClient = {
    fetchTokenDetail: async () => tokenDetail,
    fetchWalletTokenProfit: async (_requestedToken, wallet) => onchainWalletProfit({
      wallet,
      holders,
      actionsByWallet,
      currentPriceNative,
      currentPriceUsd,
      quoteUsd
    })
  };
  const cachedHolderClient = {
    fetchTopHolders: async () => holderSnapshot
  };
  const fallback = await scanTokenHolders({
    token: { ...token, ...tokenDetail, ...peakPatch, address: tokenAddress },
    holderClient: cachedHolderClient,
    debotClient: profitClient,
    config,
    signal,
    holderSource: 'blockscout',
    onProgress: (progress) => onProgress({
      ...progress,
      source: 'robinhood_rpc',
      analysisSource: 'onchain_holder_fallback'
    })
  });
  const candidates = (fallback.holderAnalysis?.candidates || []).map((candidate) => ({
    ...candidate,
    confidence: candidate.profitState === 'complete' ? 'medium' : 'low',
    profitSource: candidate.profitState === 'complete'
      ? 'verified_pool_swaps_and_blockscout_holders'
      : candidate.profitSource || 'unavailable'
  }));
  const reconciledWallets = candidates.filter((candidate) => candidate.profitState === 'complete').length;
  const holderAnalysis = {
    ...fallback.holderAnalysis,
    strategy: 'holder_first_onchain_fallback',
    holderSource: 'blockscout',
    profitSource: 'verified_pool_swaps_and_blockscout_holders',
    complete: false,
    partial: true,
    onchainComplete: onchainResult?.scan?.historyComplete === true,
    analyzedWallets: reconciledWallets,
    reconciledWallets,
    candidates,
    limitations: [
      'Only current Blockscout Holders with reconcilable verified-pool swaps are profit-attributed.',
      'Unobserved transfers, externally funded positions, and activity in unobserved pools remain excluded from admission.'
    ]
  };
  const scan = {
    ...fallback.scan,
    complete: false,
    partial: true,
    onchainComplete: onchainResult?.scan?.historyComplete === true,
    strategy: 'holder_first_onchain_fallback',
    source: 'robinhood_rpc',
    holderSource: 'blockscout',
    profitSource: 'verified_pool_swaps_and_blockscout_holders',
    fetchedHolders: holderAnalysis.fetchedHolders,
    analyzedWallets: holderAnalysis.analyzedWallets,
    reconciledWallets: holderAnalysis.reconciledWallets,
    eligibleWallets: holderAnalysis.eligibleWallets,
    ignoredBelowEntry: holderAnalysis.ignoredBelowEntry,
    failedWallets: holderAnalysis.failedWallets,
    minimumEntryUsd: holderAnalysis.minimumEntryUsd
  };
  onProgress({
    stage: 'holder_analysis_partial',
    percent: 100,
    source: 'robinhood_rpc',
    fetched: holderAnalysis.fetchedHolders,
    analyzed: holderAnalysis.analyzedWallets,
    eligible: holderAnalysis.eligibleWallets
  });
  return {
    ...fallback,
    tokenPatch: {
      ...fallback.tokenPatch,
      ...peakPatch,
      holderAnalysis,
      analysisSource: 'onchain_holder_fallback'
    },
    holderAnalysis,
    qualification: {
      ...fallback.qualification,
      provisional: true,
      confidence: 'medium'
    },
    scan
  };
}

export function onchainHolderFallbackError(error) {
  return errorMessage(error);
}
