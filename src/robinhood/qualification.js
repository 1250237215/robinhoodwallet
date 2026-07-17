import { analyzeWalletToken, deriveWalletAdmissionMultiple, scoreWallet } from './analysis.js';

const ADDRESS_PATTERN = /^0x[0-9a-f]{40}$/;

const defaultAddressNormalizer = (value) => String(value || '').toLowerCase();
const defaultAddressValidator = (value) => ADDRESS_PATTERN.test(defaultAddressNormalizer(value));
const defaultTransactionNormalizer = (value) => String(value || '').toLowerCase();

function number(value) {
  if (value === null || value === undefined || value === '') return null;
  const next = Number(value);
  return Number.isFinite(next) ? next : null;
}

function round(value, digits = 4) {
  if (!Number.isFinite(value)) return null;
  const scale = 10 ** digits;
  return Math.round(value * scale) / scale;
}

function ordered(actions) {
  return [...(actions || [])].sort(
    (a, b) =>
      (number(a.blockNumber) ?? 0) - (number(b.blockNumber) ?? 0) ||
      (number(a.transactionIndex) ?? 0) - (number(b.transactionIndex) ?? 0) ||
      (number(a.logIndex) ?? 0) - (number(b.logIndex) ?? 0)
  );
}

function median(values) {
  const rows = values.map(number).filter((value) => value !== null).sort((a, b) => a - b);
  if (!rows.length) return null;
  const middle = Math.floor(rows.length / 2);
  return round(rows.length % 2 ? rows[middle] : (rows[middle - 1] + rows[middle]) / 2);
}

function maximum(values) {
  const rows = values.map(number).filter((value) => value !== null);
  return rows.length ? Math.max(...rows) : null;
}

export function reliablePriceStats(actions, {
  minimumDistinctWallets = 2,
  addressNormalizer = defaultAddressNormalizer,
  addressValidator = defaultAddressValidator
} = {}) {
  const trades = ordered(actions).filter(
    (action) => number(action.priceNative) > 0 && number(action.tokenAmount) > 0 && number(action.quoteAmount) > 0
  );
  const wallets = new Set();
  let reliableIndex = -1;
  for (let index = 0; index < trades.length; index += 1) {
    const wallet = addressNormalizer(trades[index].wallet);
    if (addressValidator(wallet)) wallets.add(wallet);
    if (wallets.size >= minimumDistinctWallets) {
      reliableIndex = index;
      break;
    }
  }
  if (reliableIndex < 0) {
    return {
      reliable: false,
      initialPriceNative: null,
      peakPriceNative: maximum(trades.map((trade) => trade.priceNative)),
      peakMultiple: null,
      firstReliableBlock: null,
      peakBlock: null,
      distinctWallets: wallets.size,
      trades: trades.length
    };
  }

  const reliableTrades = trades.slice(reliableIndex);
  const initial = number(trades[reliableIndex].priceNative);
  let peakTrade = reliableTrades[0];
  for (const trade of reliableTrades) {
    if (number(trade.priceNative) > number(peakTrade.priceNative)) peakTrade = trade;
  }
  for (const trade of trades) {
    const wallet = addressNormalizer(trade.wallet);
    if (addressValidator(wallet)) wallets.add(wallet);
  }
  const peak = number(peakTrade.priceNative);
  return {
    reliable: true,
    initialPriceNative: initial,
    peakPriceNative: peak,
    peakMultiple: initial > 0 && peak > 0 ? round(peak / initial) : null,
    firstReliableBlock: number(trades[reliableIndex].blockNumber),
    peakBlock: number(peakTrade.blockNumber),
    distinctWallets: wallets.size,
    trades: trades.length
  };
}

export function discoveryMultiple(token) {
  const candidates = [
    token?.windows?.['24h']?.changePercent,
    token?.change24hPercent,
    token?.windows?.['12h']?.changePercent,
    token?.windows?.['6h']?.changePercent
  ]
    .map(number)
    .filter((value) => value !== null);
  if (!candidates.length) return null;
  return round(Math.max(1, ...candidates.map((percent) => 1 + percent / 100)));
}

export function deriveTokenQualification({
  token,
  actions = [],
  scanComplete = false,
  thresholds = {},
  addressNormalizer = defaultAddressNormalizer,
  addressValidator = defaultAddressValidator
}) {
  const minimumMultiple = number(thresholds.multiple) ?? 10;
  const minimumLiquidityUsd = number(thresholds.minLiquidityUsd) ?? 50_000;
  const minimumWallets = number(thresholds.minWallets) ?? 100;
  const stats = reliablePriceStats(actions, { addressNormalizer, addressValidator });
  const fallbackMultiple = discoveryMultiple(token);
  const peakMultiple = scanComplete
    ? stats.peakMultiple ?? fallbackMultiple
    : maximum([stats.peakMultiple, fallbackMultiple]);
  const verifiedPoolLiquidityUsd = number(token?.pool?.verifiedLiquidityUsd);
  const advisoryLiquidityUsd = Math.max(
    0,
    number(token?.peakLiquidityUsd) ?? 0,
    number(token?.liquidityUsd) ?? 0,
    number(token?.pool?.liquidityUsd) ?? 0
  );
  const liquidityMismatch =
    verifiedPoolLiquidityUsd > 0 && advisoryLiquidityUsd > 0
      ? Math.max(verifiedPoolLiquidityUsd, advisoryLiquidityUsd) /
        Math.min(verifiedPoolLiquidityUsd, advisoryLiquidityUsd) >= 10
      : false;
  const peakLiquidityUsd = verifiedPoolLiquidityUsd ?? advisoryLiquidityUsd;
  const advisoryWallets = number(token?.effectiveWallets);
  const effectiveWallets = scanComplete ? stats.distinctWallets : Math.max(stats.distinctWallets, advisoryWallets ?? 0);
  const checks = {
    multiple: peakMultiple === null ? null : peakMultiple >= minimumMultiple,
    liquidity:
      verifiedPoolLiquidityUsd !== null
        ? verifiedPoolLiquidityUsd >= minimumLiquidityUsd
          ? true
          : null
        : peakLiquidityUsd > 0
          ? peakLiquidityUsd >= minimumLiquidityUsd
          : null,
    wallets: effectiveWallets > 0 ? effectiveWallets >= minimumWallets : null
  };
  const missing = Object.values(checks).some((value) => value === null);
  const failed = Object.values(checks).some((value) => value === false);
  let status = token?.manual ? 'manual' : 'qualified';
  if (missing) status = token?.manual ? 'manual' : 'pending_data';
  else if (failed) status = token?.manual ? 'manual' : 'below_threshold';

  return {
    status,
    qualified: status === 'qualified',
    provisional: !scanComplete || !stats.reliable,
    confidence: scanComplete && stats.reliable ? 'high' : peakMultiple !== null ? 'medium' : 'low',
    priceSource:
      scanComplete && stats.peakMultiple !== null
        ? 'onchain_swaps'
        : stats.peakMultiple !== null && fallbackMultiple !== null
          ? 'partial_onchain_and_debot'
          : stats.peakMultiple !== null
            ? 'partial_onchain_swaps'
            : fallbackMultiple !== null
              ? 'debot_change_window'
              : 'missing',
    liquiditySource:
      verifiedPoolLiquidityUsd !== null ? 'verified_current_pool_lower_bound' : 'advisory_current_snapshot',
    liquidityMismatch,
    walletCountSource: scanComplete ? 'onchain_distinct_tx_senders' : advisoryWallets ? 'debot_advisory' : 'partial_onchain',
    peakMultiple,
    peakLiquidityUsd: peakLiquidityUsd || null,
    effectiveWallets: effectiveWallets || null,
    initialPriceNative: stats.initialPriceNative,
    peakPriceNative: stats.peakPriceNative,
    firstReliableBlock: stats.firstReliableBlock,
    peakBlock: stats.peakBlock,
    checks,
    thresholds: { multiple: minimumMultiple, minLiquidityUsd: minimumLiquidityUsd, minWallets: minimumWallets }
  };
}

export function estimateV2Exit({ amountIn, reserveIn, reserveOut, feeBps = 30 }) {
  const input = number(amountIn);
  const inputReserve = number(reserveIn);
  const outputReserve = number(reserveOut);
  const fee = number(feeBps);
  if (!(input > 0 && inputReserve > 0 && outputReserve > 0 && fee >= 0 && fee < 10_000)) return null;
  const inputAfterFee = input * (10_000 - fee);
  const amountOut = (inputAfterFee * outputReserve) / (inputReserve * 10_000 + inputAfterFee);
  const spotValue = input * (outputReserve / inputReserve);
  const realizableRatio = spotValue > 0 ? amountOut / spotValue : null;
  return {
    amountOut: round(amountOut, 8),
    spotValue: round(spotValue, 8),
    priceImpactPercent: round((1 - amountOut / spotValue) * 100, 2),
    realizableRatio: round(realizableRatio, 4)
  };
}

function entryProgress(firstBuy, stats) {
  const price = number(firstBuy?.priceNative);
  if (!(price > 0 && stats.peakPriceNative > 0)) return null;
  return Math.min(1, price / stats.peakPriceNative);
}

function quoteUsd(token) {
  const explicit = number(token?.quoteUsd);
  if (explicit !== null) return explicit;
  const priceUsd = number(token?.priceUsd);
  const priceNative = number(token?.currentPriceNative ?? token?.pool?.currentPriceNative);
  return priceUsd > 0 && priceNative > 0 ? priceUsd / priceNative : null;
}

function performanceLabel(result, exit) {
  if (result.remainingTokenAmount <= 0) return 'realized';
  if (!exit) return 'exit_unavailable';
  if (exit.realizableRatio >= 0.8) return 'liquid_unrealized';
  if (exit.realizableRatio >= 0.4) return 'thin_unrealized';
  return 'paper_multiple';
}

function peakMarketCap(token) {
  return number(
    token?.peakMarketCapUsd ??
    token?.maxMarketCapUsd ??
    token?.qualification?.peakMarketCapUsd
  );
}

function currentMarketCap(token) {
  return number(token?.marketCapUsd ?? token?.currentMarketCapUsd);
}

function tokenPeakPriceUsd(token) {
  const explicit = number(token?.peakPriceUsd);
  if (explicit > 0) return explicit;
  const currentPriceUsd = number(token?.priceUsd);
  const peakMarketCapUsd = peakMarketCap(token);
  const currentMarketCapUsd = currentMarketCap(token);
  if (currentPriceUsd > 0 && peakMarketCapUsd > 0 && currentMarketCapUsd > 0) {
    return currentPriceUsd * (peakMarketCapUsd / currentMarketCapUsd);
  }
  return null;
}

function historicalPeakReturn({ boughtAmount, entryCost, averageBuyPrice, peakPrice }) {
  const peak = number(peakPrice);
  let amount = number(boughtAmount);
  let cost = number(entryCost);
  const average = number(averageBuyPrice);
  if (!(peak > 0)) return null;
  if (!(amount > 0) && cost > 0 && average > 0) amount = cost / average;
  if (!(cost > 0) && amount > 0 && average > 0) cost = amount * average;
  if (!(amount > 0 && cost > 0)) return null;
  const grossValue = amount * peak;
  const multiple = grossValue / cost;
  if (!Number.isFinite(multiple) || multiple < 0) return null;
  return {
    boughtAmount: amount,
    entryCost: cost,
    peakPrice: peak,
    grossValue,
    profit: grossValue - cost,
    multiple,
    returnRate: multiple - 1
  };
}

function holderEntryProgress(candidate, token) {
  const averageBuyPriceUsd = number(candidate?.averageBuyPriceUsd);
  const currentPriceUsd = number(candidate?.currentPriceUsd ?? token?.priceUsd);
  const peakMarketCapUsd = peakMarketCap(token);
  const currentMarketCapUsd = currentMarketCap(token);
  if (
    averageBuyPriceUsd > 0 &&
    currentPriceUsd > 0 &&
    peakMarketCapUsd > 0 &&
    currentMarketCapUsd > 0
  ) {
    return Math.min(1, (averageBuyPriceUsd / currentPriceUsd) * (currentMarketCapUsd / peakMarketCapUsd));
  }
  return number(candidate?.entryProgress);
}

function totalProfit(performance) {
  const explicit = number(performance?.totalProfitUsd);
  if (explicit !== null) return explicit;
  const realized = number(performance?.realizedProfitUsd) ?? 0;
  const unrealized = number(performance?.unrealizedProfitUsd) ?? 0;
  return realized + unrealized;
}

function fundingField(funding, keys, normalizer = defaultTransactionNormalizer) {
  if (!funding || typeof funding !== 'object') return '';
  for (const key of keys) {
    const value = funding[key];
    if (value !== null && value !== undefined && String(value).trim()) return normalizer(value);
  }
  return '';
}

function clusterEvidence(performance, {
  addressNormalizer = defaultAddressNormalizer,
  transactionNormalizer = defaultTransactionNormalizer
} = {}) {
  const funding = performance?.firstFunding;
  const firstFundingSource = fundingField(funding, [
    'from', 'from_address', 'fromAddress', 'source', 'source_address', 'address', 'wallet'
  ], addressNormalizer);
  const firstFundingTransaction = fundingField(funding, [
    'first_tx_hash', 'tx_hash', 'txHash', 'transaction_hash', 'transactionHash', 'hash'
  ], transactionNormalizer);
  const firstBuyAt = number(performance?.firstBuyAt ?? performance?.entryTimestamp);
  const firstBuyTimeBucket = firstBuyAt === null ? null : Math.floor(firstBuyAt / 60) * 60;
  const buyTimes = Math.max(0, number(performance?.buyTimes) ?? 0);
  const sellTimes = Math.max(0, number(performance?.sellTimes) ?? 0);
  const tradePattern = performance?.tradeCountAvailable === false ? null : `${buyTimes}:${sellTimes}`;
  const parts = [
    firstFundingSource ? `fund:${firstFundingSource}` : '',
    firstBuyTimeBucket !== null ? `entry:${firstBuyTimeBucket}` : '',
    tradePattern ? `trades:${tradePattern}` : ''
  ].filter(Boolean);
  return {
    firstFundingSource: firstFundingSource || null,
    firstFundingTransaction: firstFundingTransaction || null,
    firstBuyTimeBucket,
    tradePattern,
    fingerprint: parts.length >= 2 ? parts.join('|') : null
  };
}

function clusterId(value) {
  let hash = 2166136261;
  for (const character of String(value)) {
    hash ^= character.codePointAt(0);
    hash = Math.imul(hash, 16777619);
  }
  return `related_${(hash >>> 0).toString(16).padStart(8, '0')}`;
}

function applyRelatedClusters(summaries, penalty = 0.9) {
  const evidenceGroups = new Map();
  const addEvidence = (key, type, evidence, walletAddress) => {
    if (!evidenceGroups.has(key)) {
      evidenceGroups.set(key, { key, type, evidence, wallets: new Set() });
    }
    evidenceGroups.get(key).wallets.add(walletAddress);
  };
  for (const summary of summaries) {
    for (const evidence of summary.clusterEvidence || []) {
      if (evidence.firstFundingTransaction) {
        addEvidence(
          `funding_tx:${evidence.firstFundingTransaction}`,
          'shared_funding_transaction',
          { firstFundingTransaction: evidence.firstFundingTransaction },
          summary.address
        );
      }
      if (
        evidence.firstFundingSource &&
        evidence.tokenAddress &&
        evidence.firstBuyTimeBucket !== null &&
        evidence.firstBuyTimeBucket !== undefined &&
        evidence.tradePattern
      ) {
        addEvidence(
          [
            'funding_pattern',
            evidence.tokenAddress,
            evidence.firstFundingSource,
            evidence.firstBuyTimeBucket,
            evidence.tradePattern
          ].join(':'),
          'shared_funding_entry_pattern',
          {
            tokenAddress: evidence.tokenAddress,
            firstFundingSource: evidence.firstFundingSource,
            firstBuyTimeBucket: evidence.firstBuyTimeBucket,
            tradePattern: evidence.tradePattern
          },
          summary.address
        );
      }
    }
  }
  const relatedGroups = [...evidenceGroups.values()]
    .filter((group) => group.wallets.size >= 2)
    .map((group) => ({
      id: clusterId(group.key),
      type: group.type,
      confidence: 'high',
      evidence: group.evidence,
      wallets: [...group.wallets].sort()
    }))
    .sort(
      (a, b) =>
        (a.type === 'shared_funding_transaction' ? 0 : 1) -
          (b.type === 'shared_funding_transaction' ? 0 : 1) ||
        b.wallets.length - a.wallets.length ||
        a.id.localeCompare(b.id)
    );
  const boundedPenalty = Math.max(0.5, Math.min(1, number(penalty) ?? 0.9));
  for (const summary of summaries) {
    const matches = relatedGroups
      .filter((group) => group.wallets.includes(summary.address))
      .map((group) => ({
        ...group,
        size: group.wallets.length,
        peers: group.wallets.filter((address) => address !== summary.address),
        scoreMultiplier: boundedPenalty
      }));
    summary.relatedClusters = matches;
    summary.relatedCluster = matches[0] || null;
    summary.relatedClusterCount = matches.length;
    summary.clusterScorePenalty = matches.length ? boundedPenalty : 1;
    summary.preClusterSmartScore = summary.smartScore;
    summary.clusterPenaltyPoints = 0;
    if (matches.length) {
      summary.smartReasons = [...new Set([...(summary.smartReasons || []), 'related_cluster'])];
      summary.smartScore = round((number(summary.smartScore) ?? 0) * boundedPenalty, 1);
      summary.score = summary.smartScore;
      summary.clusterPenaltyPoints = round((number(summary.preClusterSmartScore) ?? 0) - summary.smartScore, 1);
      summary.scoreComponents = {
        ...(summary.scoreComponents || {}),
        relatedClusterPenalty: -summary.clusterPenaltyPoints
      };
    }
  }
  return summaries;
}

export function evaluateSmartPerformance(performance, {
  isWinner = true,
  smartBaseMultiple = 5,
  strictMultiple = 10,
  significantProfitRate = 0.002,
  strongHolderRank = 30
} = {}) {
  const baseMultiple = Math.max(1, number(smartBaseMultiple) ?? 5);
  const highMultiple = Math.max(baseMultiple, number(strictMultiple) ?? 10);
  const requiredProfitRate = Math.max(Number.EPSILON, number(significantProfitRate) ?? 0.002);
  const hasAdmissionMultiple = Object.hasOwn(performance || {}, 'admissionMultiple');
  const bestMultiple = hasAdmissionMultiple
    ? Math.max(0, number(performance?.admissionMultiple) ?? 0)
    : Math.max(
        0,
        number(performance?.realizedMultiple) ?? 0,
        number(performance?.unrealizedMultiple) ?? 0,
        number(performance?.totalMultiple) ?? 0,
        number(performance?.peakPotentialMultiple) ?? 0
      );
  const admissionMultipleReliable = performance?.admissionMultipleReliable !== false;
  const peakMarketCapUsd = number(performance?.peakMarketCapUsd);
  const peakMarketCapProvisional = performance?.peakMarketCapProvisional === true;
  const peakMarketCapReliable = peakMarketCapUsd > 0 && !peakMarketCapProvisional;
  const profitUsd = totalProfit(performance);
  const realizedProfitUsd = number(performance?.realizedProfitUsd) ?? 0;
  const holdingValueUsd = number(performance?.holdingValueUsd ?? performance?.currentValueUsd) ?? 0;
  const holdingShareRate = Math.max(0, number(performance?.holdingSharePercent) ?? 0) / 100;
  const relativeProfitRate = peakMarketCapUsd > 0 ? Math.max(0, profitUsd) / peakMarketCapUsd : null;
  const relativeRealizedProfitRate = peakMarketCapUsd > 0
    ? Math.max(0, realizedProfitUsd) / peakMarketCapUsd
    : null;
  const holdingToPeakMarketCapRate = peakMarketCapUsd > 0
    ? Math.max(0, holdingValueUsd) / peakMarketCapUsd
    : null;
  const holderRank = number(performance?.holderRank);
  const strongHoldingEvidence = Boolean(
    (holderRank !== null && holderRank > 0 && holderRank <= Math.max(1, number(strongHolderRank) ?? 30)) ||
    holdingShareRate >= requiredProfitRate ||
    (holdingToPeakMarketCapRate !== null && holdingToPeakMarketCapRate >= requiredProfitRate)
  );
  const significantHoldingValue = Boolean(
    peakMarketCapReliable && (
      holdingShareRate >= requiredProfitRate ||
      (holdingToPeakMarketCapRate !== null && holdingToPeakMarketCapRate >= requiredProfitRate)
    )
  );
  const relativeProfitMeetsThreshold = relativeProfitRate !== null && relativeProfitRate >= requiredProfitRate;
  const relativeRealizedProfitMeetsThreshold =
    relativeRealizedProfitRate !== null && relativeRealizedProfitRate >= requiredProfitRate;
  const significantProfit = peakMarketCapReliable && relativeProfitMeetsThreshold;
  const significantRealizedProfit = peakMarketCapReliable && relativeRealizedProfitMeetsThreshold;
  const multipleHit = Boolean(isWinner && performance?.early === true && bestMultiple >= baseMultiple);
  const baseHit = Boolean(multipleHit && admissionMultipleReliable);
  const valueEvidence = significantProfit || significantRealizedProfit || significantHoldingValue;
  const strictHit = Boolean(baseHit && bestMultiple >= highMultiple && valueEvidence);
  const dynamicFiveXHit = Boolean(
    baseHit &&
    bestMultiple < highMultiple &&
    significantProfit &&
    (significantHoldingValue || significantRealizedProfit)
  );
  const smartReasons = [];
  if (strictHit) smartReasons.push('high_multiple');
  if (dynamicFiveXHit && significantHoldingValue) smartReasons.push('heavy_5x');
  if (dynamicFiveXHit && significantRealizedProfit) smartReasons.push('realized_5x');
  const smartPendingReasons = [];
  if (multipleHit && !admissionMultipleReliable) smartPendingReasons.push('unreliable_cost_basis');
  if (baseHit && !strictHit && !peakMarketCapReliable) {
    smartPendingReasons.push(peakMarketCapProvisional ? 'peak_market_cap_provisional' : 'missing_peak_market_cap');
  }
  return {
    hit: baseHit,
    smartEligibleSingle: strictHit || dynamicFiveXHit,
    smartReasons,
    smartPending: smartPendingReasons.length > 0,
    smartPendingReasons,
    bestMultiple: round(bestMultiple),
    peakMarketCapUsd,
    significantProfitUsd: peakMarketCapUsd > 0 ? round(peakMarketCapUsd * requiredProfitRate, 2) : null,
    profitToPeakMarketCapRatio: round(relativeProfitRate, 8),
    realizedProfitToPeakMarketCapRatio: round(relativeRealizedProfitRate, 8),
    holdingToPeakMarketCapRatio: round(holdingToPeakMarketCapRate, 8),
    strongHoldingEvidence,
    significantHoldingValue,
    significantProfit,
    significantRealizedProfit,
    relativeProfitMeetsThreshold,
    relativeRealizedProfitMeetsThreshold,
    smartAdmissionChecks: {
      minimumEntry: true,
      early: performance?.early === true,
      baseMultiple: bestMultiple >= baseMultiple,
      strictMultiple: bestMultiple >= highMultiple,
      admissionMultipleReliable,
      admissionMultipleSource: performance?.admissionMultipleSource || 'derived_performance',
      costBasisStatus: performance?.costBasisStatus || 'unknown',
      peakMarketCapAvailable: peakMarketCapUsd > 0,
      peakMarketCapReliable,
      peakMarketCapProvisional,
      significantProfit,
      strongHoldingEvidence,
      significantHoldingValue,
      valueEvidence,
      significantRealizedProfit
    }
  };
}

export function buildWalletSummaries({
  tokens = [],
  actionsByToken = new Map(),
  minimumHitMultiple = null,
  minimumEntryUsd = 0,
  smartBaseMultiple = null,
  strictMultiple = 10,
  significantProfitRate = 0.002,
  repeatMinHits = 2,
  strongHolderRank = 30,
  smartScoreWeights = null,
  relatedClusterPenalty = 0.9,
  lowFrequencyReasonThreshold = 0.8,
  addressNormalizer = defaultAddressNormalizer,
  addressValidator = defaultAddressValidator,
  transactionNormalizer = defaultTransactionNormalizer
} = {}) {
  const baseMultiple = Math.max(1, number(smartBaseMultiple ?? minimumHitMultiple) ?? 5);
  const highMultiple = Math.max(baseMultiple, number(strictMultiple) ?? 10);
  const requiredRepeatHits = Math.max(2, Math.floor(number(repeatMinHits) ?? 2));
  const defaultMinimumEntryUsd = Math.max(0, number(minimumEntryUsd) ?? 0);
  const wallets = new Map();
  for (const token of tokens) {
    const tokenAddress = addressNormalizer(token.address);
    const qualification = token.qualification || {};
    const tokenPeakMultiple = number(token.peakMultiple ?? qualification.peakMultiple);
    const hasExplicitQualification =
      token.qualification !== null && token.qualification !== undefined ||
      token.qualificationStatus !== null && token.qualificationStatus !== undefined;
    const isWinner =
      token.manual === true ||
      token.qualified === true ||
      qualification.qualified === true ||
      qualification.status === 'qualified' ||
      token.qualificationStatus === 'qualified' ||
      (!hasExplicitQualification && tokenPeakMultiple >= baseMultiple);
    const holderCandidates = Array.isArray(token.holderAnalysis?.candidates)
      ? token.holderAnalysis.candidates
      : [];
    const tokenMinimumEntryUsd = Math.max(
      0,
      number(token.holderAnalysis?.minimumEntryUsd) ?? defaultMinimumEntryUsd
    );
    if (token.holderAnalysis && typeof token.holderAnalysis === 'object') {
      for (const candidate of holderCandidates) {
        const address = addressNormalizer(candidate.address);
        const entryCostUsd = number(
          candidate.rawBuyVolumeUsd ?? candidate.buyVolumeUsd ?? candidate.entryCostUsd
        );
        if (!addressValidator(address) || candidate.excluded || candidate.profitState !== 'complete') continue;
        if (candidate.eligible === false) continue;
        if (!(entryCostUsd >= tokenMinimumEntryUsd)) continue;
        const realizedMultiple = number(candidate.realizedMultiple);
        const unrealizedMultiple = number(candidate.unrealizedMultiple);
        const admission = deriveWalletAdmissionMultiple(candidate);
        const totalMultiple = admission.costBasisComplete === false
          ? number(admission.admissionMultiple)
          : number(candidate.totalMultiple);
        const bestMultiple = Math.max(0, number(admission.admissionMultiple) ?? 0);
        const candidateEntryProgress = holderEntryProgress(candidate, token);
        const early = candidate.early === true || (candidateEntryProgress !== null && candidateEntryProgress <= 0.2);
        const firstTimestamp = number(candidate.firstTradeAt);
        const peakPriceUsd = tokenPeakPriceUsd(token);
        const historicalPeak = historicalPeakReturn({
          boughtAmount: candidate.buyAmount,
          entryCost: entryCostUsd,
          averageBuyPrice: candidate.averageBuyPriceUsd,
          peakPrice: peakPriceUsd
        });
        const performance = {
          tokenAddress,
          symbol: String(token.symbol || 'UNKNOWN'),
          name: String(token.name || token.symbol || 'Unknown'),
          logo: String(token.logo || ''),
          manualToken: token.manual === true,
          hit: false,
          early,
          entryProgress: round(candidateEntryProgress),
          entryTimestamp: firstTimestamp,
          firstBuyAt: firstTimestamp,
          lastTradeAt: number(candidate.lastTradeAt),
          entryPriceUsd: number(candidate.averageBuyPriceUsd),
          buyAmount: number(candidate.buyAmount),
          currentPriceUsd: number(candidate.currentPriceUsd ?? token.priceUsd),
          entryDelaySeconds:
            firstTimestamp !== null && number(token.creationTimestamp) !== null
              ? Math.max(0, firstTimestamp - number(token.creationTimestamp))
              : null,
          entryCostUsd: round(entryCostUsd, 2),
          buyVolumeUsd: round(entryCostUsd, 2),
          minimumEntryUsd: tokenMinimumEntryUsd,
          sellVolumeUsd: round(candidate.sellVolumeUsd, 2),
          buyTimes: number(candidate.buyTimes) ?? 0,
          sellTimes: number(candidate.sellTimes) ?? 0,
          tradeCountAvailable: number(candidate.buyTimes) !== null || number(candidate.sellTimes) !== null,
          realizedProfitUsd: round(candidate.realizedProfitUsd, 2),
          unrealizedProfitUsd: round(candidate.unrealizedProfitUsd, 2),
          totalProfitUsd: round(candidate.totalProfitUsd, 2),
          currentValueUsd: round(candidate.holdingValueUsd, 2),
          openPositionValueUsd: round(candidate.holdingValueUsd, 2),
          holdingValueUsd: round(candidate.holdingValueUsd, 2),
          holdingTokenAmount: number(candidate.holdingTokenAmount),
          holdingSharePercent: number(candidate.holdingSharePercent),
          holderRank: number(candidate.holderRank),
          peakMarketCapUsd: peakMarketCap(token),
          peakPriceUsd,
          peakMarketCapAt: token.peakMarketCapAt || null,
          peakMarketCapSource: token.peakMarketCapSource || null,
          peakMarketCapProvisional: token.peakMarketCapProvisional === true,
          peakMarketCapError: token.peakMarketCapError || null,
          currentMarketCapUsd: currentMarketCap(token),
          holderSnapshotAt: candidate.holderSnapshotAt || token.holderAnalysis?.snapshotAt || null,
          candidateReason: candidate.candidateReason || 'top_holder',
          realizedMultiple,
          unrealizedMultiple,
          totalMultiple,
          netMultiple: totalMultiple,
          peakPotentialMultiple: bestMultiple,
          bestMultiple,
          historicalPeakGrossValueUsd: round(historicalPeak?.grossValue, 2),
          historicalPeakProfitUsd: round(historicalPeak?.profit, 2),
          historicalPeakMultiple: round(historicalPeak?.multiple),
          historicalPeakReturnRate: round(historicalPeak?.returnRate, 6),
          historicalPeakReturnPercent: round(
            historicalPeak ? historicalPeak.returnRate * 100 : null,
            2
          ),
          historicalPeakSource: historicalPeak ? 'buy_quantity_cost_and_token_peak_price' : 'unavailable',
          manualWinnerHit: Boolean(token.manual === true && historicalPeak?.multiple >= baseMultiple),
          manualWinnerHitThreshold: baseMultiple,
          ...admission,
          firstFunding: candidate.firstFunding || null,
          positionLabel: number(candidate.holdingTokenAmount) > 0 ? 'ranked_holder' : 'realized',
          profitState: candidate.profitState,
          profitSource: candidate.profitSource || token.holderAnalysis?.profitSource || 'debot_wallet_token_analysis',
          confidence: candidate.confidence || 'high',
          actions: []
        };
        Object.assign(performance, evaluateSmartPerformance(performance, {
          isWinner,
          smartBaseMultiple: baseMultiple,
          strictMultiple: highMultiple,
          significantProfitRate,
          strongHolderRank
        }));
        const evidence = clusterEvidence(performance, { addressNormalizer, transactionNormalizer });
        performance.clusterFingerprint = evidence.fingerprint;
        performance.clusterEvidence = evidence;
        if (!wallets.has(address)) wallets.set(address, []);
        wallets.get(address).push(performance);
      }
      continue;
    }
    const actions = ordered(
      actionsByToken instanceof Map ? actionsByToken.get(tokenAddress) || [] : actionsByToken[tokenAddress] || []
    );
    if (!actions.length) continue;
    const stats = reliablePriceStats(actions, { addressNormalizer, addressValidator });
    const legacyIsWinner = isWinner || (!hasExplicitQualification && (stats.peakMultiple ?? 0) >= baseMultiple);
    const byWallet = new Map();
    for (const action of actions) {
      const wallet = addressNormalizer(action.wallet);
      if (!addressValidator(wallet) || action.excluded) continue;
      if (!byWallet.has(wallet)) byWallet.set(wallet, []);
      byWallet.get(wallet).push(action);
    }

    for (const [address, walletActions] of byWallet) {
      const firstBuy = walletActions.find((action) => action.side === 'buy');
      if (!firstBuy) continue;
      const conversion = quoteUsd(token);
      const entryCostNative = walletActions
        .filter((action) => action.side === 'buy')
        .reduce((sum, action) => sum + Math.max(0, number(action.quoteAmount) ?? 0), 0);
      const boughtTokenAmount = walletActions
        .filter((action) => action.side === 'buy')
        .reduce((sum, action) => sum + Math.max(0, number(action.tokenAmount) ?? 0), 0);
      const entryCostUsd = conversion === null ? null : entryCostNative * conversion;
      if (tokenMinimumEntryUsd > 0 && !(entryCostUsd >= tokenMinimumEntryUsd)) continue;
      const currentPriceNative =
        number(token.currentPriceNative ?? token.pool?.currentPriceNative) ??
        number(actions.at(-1)?.priceNative);
      const result = analyzeWalletToken({ actions: walletActions, currentPriceNative });
      const progress = entryProgress(firstBuy, {
        ...stats,
        peakPriceNative: Math.max(number(stats.peakPriceNative) ?? 0, number(currentPriceNative) ?? 0)
      });
      const early = progress !== null && progress <= 0.2;
      const exit = token.pool?.version === 'v2' && result.remainingTokenAmount > 0 && token.pool?.reserves
        ? estimateV2Exit({
            amountIn: result.remainingTokenAmount,
            reserveIn: token.pool.reserves.target,
            reserveOut: token.pool.reserves.quote,
            feeBps: token.pool.feeBps ?? 30
          })
        : null;
      const firstTimestamp = number(firstBuy.blockTimestamp);
      const historicalPeak = historicalPeakReturn({
        boughtAmount: boughtTokenAmount,
        entryCost: entryCostNative,
        averageBuyPrice: entryCostNative > 0 && boughtTokenAmount > 0 ? entryCostNative / boughtTokenAmount : null,
        peakPrice: stats.peakPriceNative
      });
      const performance = {
        tokenAddress,
        symbol: String(token.symbol || 'UNKNOWN'),
        name: String(token.name || token.symbol || 'Unknown'),
        logo: String(token.logo || ''),
        manualToken: token.manual === true,
        hit: false,
        early,
        entryProgress: round(progress),
        entryBlock: number(firstBuy.blockNumber),
        entryTimestamp: firstTimestamp,
        firstBuyAt: firstTimestamp,
        entryPriceNative: number(firstBuy.priceNative),
        entryDelaySeconds:
          firstTimestamp !== null && number(token.creationTimestamp) !== null
            ? Math.max(0, firstTimestamp - number(token.creationTimestamp))
            : null,
        quoteSymbol: token.pool?.quoteSymbol || 'WETH',
        quoteUsd: conversion,
        entryCostNative: round(entryCostNative, 10),
        entryCostUsd: entryCostUsd === null ? null : round(entryCostUsd, 2),
        buyAmount: round(boughtTokenAmount, 8),
        minimumEntryUsd: tokenMinimumEntryUsd,
        buyTimes: walletActions.filter((action) => action.side === 'buy').length,
        sellTimes: walletActions.filter((action) => action.side === 'sell').length,
        tradeCountAvailable: true,
        realizedProfitUsd: conversion === null ? null : round(result.realizedProfitNative * conversion, 2),
        unrealizedProfitUsd:
          conversion === null || result.unrealizedProfitNative === null
            ? null
            : round(result.unrealizedProfitNative * conversion, 2),
        currentValueUsd:
          conversion === null || result.currentValueNative === null
            ? null
            : round(result.currentValueNative * conversion, 2),
        openPositionValueUsd:
          conversion === null || result.currentValueNative === null
            ? null
            : round(result.currentValueNative * conversion, 2),
        totalProfitUsd:
          conversion === null || result.unrealizedProfitNative === null
            ? null
            : round((result.realizedProfitNative + result.unrealizedProfitNative) * conversion, 2),
        holdingValueUsd:
          conversion === null || result.currentValueNative === null
            ? null
            : round(result.currentValueNative * conversion, 2),
        peakMarketCapUsd: peakMarketCap(token),
        peakPriceNative: number(stats.peakPriceNative),
        peakMarketCapAt: token.peakMarketCapAt || null,
        peakMarketCapSource: token.peakMarketCapSource || null,
        peakMarketCapProvisional: token.peakMarketCapProvisional === true,
        peakMarketCapError: token.peakMarketCapError || null,
        currentMarketCapUsd: currentMarketCap(token),
        historicalPeakGrossValueNative: round(historicalPeak?.grossValue, 10),
        historicalPeakProfitNative: round(historicalPeak?.profit, 10),
        historicalPeakMultiple: round(historicalPeak?.multiple),
        historicalPeakReturnRate: round(historicalPeak?.returnRate, 6),
        historicalPeakReturnPercent: round(
          historicalPeak ? historicalPeak.returnRate * 100 : null,
          2
        ),
        historicalPeakSource: historicalPeak ? 'onchain_buy_quantity_cost_and_peak_price' : 'unavailable',
        manualWinnerHit: Boolean(token.manual === true && historicalPeak?.multiple >= baseMultiple),
        manualWinnerHitThreshold: baseMultiple,
        estimatedExitProceedsUsd:
          conversion === null || exit?.amountOut === null || exit?.amountOut === undefined
            ? null
            : round(exit.amountOut * conversion, 2),
        liquidityWarning:
          result.remainingTokenAmount <= 0
            ? ''
            : exit
              ? exit.realizableRatio < 0.8
                ? `全仓退出预计只能实现账面价值的 ${round(exit.realizableRatio * 100, 1)}%`
                : ''
              : '当前主池无法提供可信的全仓退出估算',
        exit,
        positionLabel: performanceLabel(result, exit),
        confidence: walletActions.every((action) => action.attributionConfidence === 'high') ? 'high' : 'medium',
        actions: walletActions,
        ...result
      };
      Object.assign(performance, evaluateSmartPerformance(performance, {
        isWinner: legacyIsWinner,
        smartBaseMultiple: baseMultiple,
        strictMultiple: highMultiple,
        significantProfitRate,
        strongHolderRank
      }));
      const evidence = clusterEvidence(performance, { addressNormalizer, transactionNormalizer });
      performance.clusterFingerprint = evidence.fingerprint;
      performance.clusterEvidence = evidence;
      if (!wallets.has(address)) wallets.set(address, []);
      wallets.get(address).push(performance);
    }
  }

  const summaries = [];
  for (const [address, performances] of wallets) {
    const hits = performances.filter((performance) => performance.hit);
    const manualTokenAddresses = new Set();
    const manualWinnerHitTokenAddresses = new Set();
    for (const performance of performances) {
      const performanceTokenAddress = addressNormalizer(performance.tokenAddress);
      if (performance.manualToken !== true || !addressValidator(performanceTokenAddress)) continue;
      manualTokenAddresses.add(performanceTokenAddress);
      if (performance.manualWinnerHit === true) manualWinnerHitTokenAddresses.add(performanceTokenAddress);
    }
    const manualWinnerParticipationCount = manualTokenAddresses.size;
    const manualWinnerHitCount = manualWinnerHitTokenAddresses.size;
    const manualWinnerHitRate = manualWinnerParticipationCount
      ? manualWinnerHitCount / manualWinnerParticipationCount
      : null;
    const repeatEligible = hits.length >= requiredRepeatHits;
    const smartReasons = [...new Set(performances.flatMap((performance) => performance.smartReasons || []))];
    if (repeatEligible) smartReasons.push('repeat_5x');
    for (const performance of performances) {
      performance.smartEligible = Boolean(performance.smartEligibleSingle || (repeatEligible && performance.hit));
      performance.smartReasons = [...new Set([
        ...(performance.smartReasons || []),
        ...(repeatEligible && performance.hit ? ['repeat_5x'] : [])
      ])];
    }
    const smartEligible = performances.some((performance) => performance.smartEligible);
    const smartPendingReasons = [...new Set(
      performances.flatMap((performance) => performance.smartPendingReasons || [])
    )];
    const maxRealizedMultiple = maximum(performances.map((performance) => performance.realizedMultiple));
    const maxUnrealizedMultiple = maximum(performances.map((performance) => performance.unrealizedMultiple));
    const maxPeakMultiple = maximum(performances.map((performance) => performance.peakPotentialMultiple));
    const maxHistoricalPeakMultiple = maximum(performances.map((performance) => performance.historicalPeakMultiple));
    const maxTotalMultiple = maximum(performances.map((performance) => performance.totalMultiple));
    const holderRanks = performances.map((performance) => number(performance.holderRank)).filter((rank) => rank !== null);
    const bestHolderRank = holderRanks.length ? Math.min(...holderRanks) : null;
    const bestHolderPerformance = bestHolderRank === null
      ? null
      : performances.find((performance) => number(performance.holderRank) === bestHolderRank) || null;
    const totalHoldingValueUsd = round(
      performances.reduce((sum, performance) => sum + (number(performance.holdingValueUsd) ?? 0), 0),
      2
    );
    const totalProfitUsd = round(
      performances.reduce((sum, performance) => sum + (number(performance.totalProfitUsd) ?? 0), 0),
      2
    );
    const totalTradeCount = performances.reduce((sum, performance) => {
      const reportedTrades =
        (number(performance.buyTimes) ?? 0) +
        (number(performance.sellTimes) ?? 0);
      const observedTrades = Array.isArray(performance.actions) ? performance.actions.length : 0;
      return sum + Math.max(0, reportedTrades > 0 ? reportedTrades : observedTrades);
    }, 0);
    const tradeCountEntries = performances.filter((performance) => performance.tradeCountAvailable === true).length;
    const tradeCountCoverage = performances.length ? tradeCountEntries / performances.length : 0;
    const profitComparablePerformances = performances.filter(
      (performance) =>
        (number(performance.peakMarketCapUsd) ?? 0) > 0 &&
        performance.peakMarketCapProvisional !== true
    );
    const comparablePeakMarketCapUsd = profitComparablePerformances.reduce(
      (sum, performance) => sum + number(performance.peakMarketCapUsd),
      0
    );
    const comparableProfitUsd = profitComparablePerformances.reduce(
      (sum, performance) => sum + totalProfit(performance),
      0
    );
    const profitToPeakMarketCapRatio = comparablePeakMarketCapUsd > 0
      ? Math.max(0, comparableProfitUsd) / comparablePeakMarketCapUsd
      : null;
    const normalizedProfitCoverage = performances.length
      ? profitComparablePerformances.length / performances.length
      : 0;
    const performanceEntryThresholds = performances
      .map((performance) => number(performance.minimumEntryUsd))
      .filter((threshold) => threshold !== null);
    const summaryMinimumEntryUsd = performanceEntryThresholds.length
      ? Math.min(...performanceEntryThresholds)
      : defaultMinimumEntryUsd;
    const clusterRows = performances
      .map((performance) => ({
        tokenAddress: performance.tokenAddress,
        ...(performance.clusterEvidence || clusterEvidence(performance))
      }))
      .filter((evidence) => evidence.fingerprint);
    const clusterFingerprints = [...new Set(clusterRows.map((evidence) => evidence.fingerprint))];
    const confidence = performances.length
      ? performances.filter((performance) => performance.confidence === 'high').length / performances.length
      : 0;
    const features = {
      hits: hits.length,
      entries: performances.length,
      maxRealizedMultiple,
      maxUnrealizedMultiple,
      maxPeakMultiple,
      maxTotalMultiple,
      bestHolderRank,
      bestHoldingSharePercent: number(bestHolderPerformance?.holdingSharePercent),
      holderSnapshotAt: bestHolderPerformance?.holderSnapshotAt || null,
      totalHoldingValueUsd,
      totalTradeCount,
      tradeCountEntries,
      tradeCountCoverage,
      profitToPeakMarketCapRatio,
      normalizedProfitCoverage,
      significantProfitRate,
      repeatMinHits: requiredRepeatHits,
      scoreWeights: smartScoreWeights,
      medianEntryProgress: median(performances.map((performance) => performance.entryProgress)),
      confidence: Math.max(0.35, confidence)
    };
    const scored = scoreWallet(features, {
      significantProfitRate,
      repeatMinHits: requiredRepeatHits,
      weights: smartScoreWeights
    });
    if (
      smartEligible &&
      tradeCountCoverage > 0 &&
      (number(scored.lowFrequencyScore) ?? 0) >= Math.max(0, Math.min(1, number(lowFrequencyReasonThreshold) ?? 0.8))
    ) {
      smartReasons.push('low_frequency');
    }
    summaries.push({
      address,
      ...features,
      ...scored,
      winnerHits: hits.length,
      eligibleEntries: performances.length,
      manualTokenParticipationCount: manualWinnerParticipationCount,
      manualWinnerParticipationCount,
      manualWinnerHitCount,
      manualWinnerHitRate: round(manualWinnerHitRate, 4),
      manualWinnerHitThreshold: baseMultiple,
      manualWinnerHitTokenAddresses: [...manualWinnerHitTokenAddresses].sort(),
      minimumEntryUsd: summaryMinimumEntryUsd,
      smartEligible,
      smartReasons,
      smartPending: !smartEligible && smartPendingReasons.length > 0,
      smartAdmissionPending: smartPendingReasons.length > 0,
      smartPendingReasons,
      smartBaseMultiple: baseMultiple,
      strictMultiple: highMultiple,
      significantProfitRate,
      repeatMinHits: requiredRepeatHits,
      strictHitCount: performances.filter((performance) => performance.smartReasons?.includes('high_multiple')).length,
      dynamicFiveXHitCount: performances.filter(
        (performance) => performance.smartReasons?.includes('heavy_5x') || performance.smartReasons?.includes('realized_5x')
      ).length,
      bestHolderRank,
      topHolderCount: performances.filter((performance) => (number(performance.holderRank) ?? Infinity) <= 100).length,
      totalHoldingValueUsd,
      totalProfitUsd,
      comparablePeakMarketCapUsd: round(comparablePeakMarketCapUsd, 2),
      profitToPeakMarketCapRatio: round(profitToPeakMarketCapRatio, 8),
      normalizedProfitCoverage: round(normalizedProfitCoverage, 4),
      clusterFingerprint: clusterFingerprints[0] || null,
      clusterFingerprints,
      clusterEvidence: clusterRows,
      profitState: performances.every((performance) => performance.profitState === 'complete' || !performance.profitState)
        ? 'complete'
        : 'partial',
      candidateSource: performances.some((performance) => performance.candidateReason)
        ? 'top_holder'
        : 'onchain_pool',
      totalEntryCostUsd: round(
        performances.reduce((sum, performance) => sum + (number(performance.entryCostUsd) ?? 0), 0),
        2
      ),
      maxRealizedMultiple,
      medianRealizedMultiple: median(performances.map((performance) => performance.realizedMultiple)),
      maxUnrealizedMultiple,
      medianUnrealizedMultiple: median(performances.map((performance) => performance.unrealizedMultiple)),
      maxTotalMultiple,
      maxPeakMultiple,
      medianPeakMultiple: median(performances.map((performance) => performance.peakPotentialMultiple)),
      maxHistoricalPeakMultiple,
      medianHistoricalPeakMultiple: median(
        performances.map((performance) => performance.historicalPeakMultiple)
      ),
      realizedProfitUsd: round(
        performances.reduce((sum, performance) => sum + (number(performance.realizedProfitUsd) ?? 0), 0),
        2
      ),
      unrealizedProfitUsd: round(
        performances.reduce((sum, performance) => sum + (number(performance.unrealizedProfitUsd) ?? 0), 0),
        2
      ),
      unrealizedValueUsd: round(
        performances.reduce((sum, performance) => sum + (number(performance.currentValueUsd) ?? 0), 0),
        2
      ),
      openPositionValueUsd: round(
        performances.reduce((sum, performance) => sum + (number(performance.currentValueUsd) ?? 0), 0),
        2
      ),
      firstEntryAt: minimumTimestamp(performances.map((performance) => performance.entryTimestamp)),
      medianEntryDelaySeconds: median(performances.map((performance) => performance.entryDelaySeconds)),
      realizableRatio: median(performances.map((performance) => performance.exit?.realizableRatio)),
      recurrence: hits.map((performance) => performance.tokenAddress),
      performances
    });
  }
  applyRelatedClusters(summaries, relatedClusterPenalty);
  return summaries.sort(
    (a, b) => b.score - a.score || b.winnerHits - a.winnerHits || b.realizedProfitUsd - a.realizedProfitUsd || a.address.localeCompare(b.address)
  );
}

function minimumTimestamp(values) {
  const rows = values.map(number).filter((value) => value !== null);
  return rows.length ? Math.min(...rows) : null;
}
