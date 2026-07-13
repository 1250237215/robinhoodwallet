import { DEFAULT_SMART_SCORE_WEIGHTS } from './config.js';

function round(value, digits = 4) {
  if (!Number.isFinite(value)) return null;
  const factor = 10 ** digits;
  return Math.round(value * factor) / factor;
}

function finiteNumber(value) {
  if (value === null || value === undefined || value === '') return null;
  const next = Number(value);
  return Number.isFinite(next) ? next : null;
}

export function assessWalletTokenCostBasis({
  buyAmount,
  sellAmount,
  holdingTokenAmount
} = {}) {
  const hasFlowData = finiteNumber(buyAmount) !== null && finiteNumber(sellAmount) !== null;
  const bought = Math.max(0, finiteNumber(buyAmount) ?? 0);
  const sold = Math.max(0, finiteNumber(sellAmount) ?? 0);
  const held = Math.max(0, finiteNumber(holdingTokenAmount) ?? 0);
  const accountedTokens = sold + held;
  const tolerance = Math.max(1e-8, bought * 0.01);
  const unexplainedTokenAmount = Math.max(0, accountedTokens - bought);

  if (!hasFlowData || (bought === 0 && accountedTokens === 0)) {
    return {
      costBasisStatus: 'unknown',
      costBasisComplete: null,
      costBasisCoverage: null,
      unexplainedTokenAmount: 0,
      costBasisReason: ''
    };
  }
  if (accountedTokens > bought + tolerance) {
    return {
      costBasisStatus: 'incomplete_external_inflow',
      costBasisComplete: false,
      costBasisCoverage: accountedTokens > 0 ? round(Math.min(1, bought / accountedTokens), 6) : null,
      unexplainedTokenAmount: round(unexplainedTokenAmount, 8),
      costBasisReason: 'sold_or_held_amount_exceeds_observed_buys'
    };
  }
  return {
    costBasisStatus: 'complete',
    costBasisComplete: true,
    costBasisCoverage: 1,
    unexplainedTokenAmount: 0,
    costBasisReason: ''
  };
}

export function deriveWalletAdmissionMultiple(performance = {}) {
  const inferredCostBasis = assessWalletTokenCostBasis(performance);
  const costBasisComplete = typeof performance.costBasisComplete === 'boolean'
    ? performance.costBasisComplete
    : inferredCostBasis.costBasisComplete;
  const costBasisStatus = String(performance.costBasisStatus || (
    costBasisComplete === false
      ? 'incomplete_external_inflow'
      : costBasisComplete === true
        ? 'complete'
        : inferredCostBasis.costBasisStatus
  ));
  const costBasis = {
    costBasisStatus,
    costBasisComplete,
    costBasisCoverage: finiteNumber(performance.costBasisCoverage) ?? inferredCostBasis.costBasisCoverage,
    unexplainedTokenAmount:
      finiteNumber(performance.unexplainedTokenAmount) ?? inferredCostBasis.unexplainedTokenAmount,
    costBasisReason: String(performance.costBasisReason || inferredCostBasis.costBasisReason || '')
  };
  const profitRate = finiteNumber(performance.profitRate);
  const totalProfitUsd = finiteNumber(performance.totalProfitUsd);
  const buyVolumeUsd = finiteNumber(performance.buyVolumeUsd ?? performance.entryCostUsd);
  const explicitProfitMultiple = profitRate !== null
    ? Math.max(0, 1 + profitRate)
    : totalProfitUsd !== null && buyVolumeUsd > 0
      ? Math.max(0, 1 + totalProfitUsd / buyVolumeUsd)
      : null;

  if (costBasisComplete === false) {
    return {
      ...costBasis,
      admissionMultiple: round(explicitProfitMultiple),
      admissionMultipleSource: profitRate !== null
        ? 'debot_profit_rate'
        : explicitProfitMultiple !== null
          ? 'explicit_profit_vs_observed_buys'
          : 'unavailable',
      admissionMultipleReliable: explicitProfitMultiple !== null
    };
  }

  const reported = [
    performance.realizedMultiple,
    performance.unrealizedMultiple,
    performance.totalMultiple,
    performance.admissionMultiple
  ].map(finiteNumber).filter((value) => value !== null && value >= 0);
  const admissionMultiple = reported.length ? Math.max(...reported) : explicitProfitMultiple;
  return {
    ...costBasis,
    admissionMultiple: round(admissionMultiple),
    admissionMultipleSource: reported.length
      ? costBasisComplete === true ? 'complete_cost_basis' : 'reported_multiples'
      : explicitProfitMultiple !== null
        ? profitRate !== null ? 'debot_profit_rate' : 'explicit_profit_vs_observed_buys'
        : 'unavailable',
    admissionMultipleReliable: admissionMultiple !== null
  };
}

function ordered(actions) {
  return [...actions].sort(
    (a, b) =>
      (a.blockNumber || 0) - (b.blockNumber || 0) ||
      (a.transactionIndex || 0) - (b.transactionIndex || 0) ||
      (a.logIndex || 0) - (b.logIndex || 0)
  );
}

export function analyzeWalletToken({ actions = [], currentPriceNative = null }) {
  const lots = [];
  let totalEntryCostNative = 0;
  let realizedCostNative = 0;
  let realizedProceedsNative = 0;
  let peakPriceNative = Number.isFinite(Number(currentPriceNative)) ? Number(currentPriceNative) : 0;
  let firstBuyPriceNative = null;
  let boughtTokenAmount = 0;
  let soldTokenAmount = 0;

  for (const action of ordered(actions)) {
    const tokenAmount = Number(action.tokenAmount) || 0;
    const quoteAmount = Number(action.quoteAmount) || 0;
    const price = Number(action.priceNative) || (tokenAmount > 0 ? quoteAmount / tokenAmount : 0);
    if (price > peakPriceNative) peakPriceNative = price;

    if (action.side === 'buy' && tokenAmount > 0 && quoteAmount >= 0) {
      const unitCost = tokenAmount > 0 ? quoteAmount / tokenAmount : 0;
      lots.push({ amount: tokenAmount, unitCost });
      totalEntryCostNative += quoteAmount;
      boughtTokenAmount += tokenAmount;
      if (firstBuyPriceNative === null) firstBuyPriceNative = price || unitCost;
      continue;
    }

    if (action.side !== 'sell' || tokenAmount <= 0) continue;
    let remaining = tokenAmount;
    let consumedCost = 0;
    while (remaining > 1e-18 && lots.length) {
      const lot = lots[0];
      const consumed = Math.min(remaining, lot.amount);
      consumedCost += consumed * lot.unitCost;
      lot.amount -= consumed;
      remaining -= consumed;
      if (lot.amount <= 1e-18) lots.shift();
    }
    realizedCostNative += consumedCost;
    realizedProceedsNative += quoteAmount;
    soldTokenAmount += tokenAmount - remaining;
  }

  const remainingTokenAmount = lots.reduce((sum, lot) => sum + lot.amount, 0);
  const remainingCostNative = lots.reduce((sum, lot) => sum + lot.amount * lot.unitCost, 0);
  const currentValueNative = Number.isFinite(Number(currentPriceNative))
    ? remainingTokenAmount * Number(currentPriceNative)
    : null;
  const realizedMultiple = realizedCostNative > 0 ? realizedProceedsNative / realizedCostNative : null;
  const unrealizedMultiple = remainingCostNative > 0 && currentValueNative !== null
    ? currentValueNative / remainingCostNative
    : null;
  const netMultiple = totalEntryCostNative > 0 && currentValueNative !== null
    ? (realizedProceedsNative + currentValueNative) / totalEntryCostNative
    : null;
  const peakPotentialMultiple = firstBuyPriceNative > 0 ? peakPriceNative / firstBuyPriceNative : null;

  return {
    totalEntryCostNative: round(totalEntryCostNative),
    realizedCostNative: round(realizedCostNative),
    realizedProceedsNative: round(realizedProceedsNative),
    realizedProfitNative: round(realizedProceedsNative - realizedCostNative),
    realizedMultiple: round(realizedMultiple),
    remainingTokenAmount: round(remainingTokenAmount, 8),
    remainingCostNative: round(remainingCostNative),
    currentValueNative: round(currentValueNative),
    unrealizedProfitNative: currentValueNative === null ? null : round(currentValueNative - remainingCostNative),
    unrealizedMultiple: round(unrealizedMultiple),
    netMultiple: round(netMultiple),
    peakPotentialMultiple: round(peakPotentialMultiple),
    peakPriceNative: round(peakPriceNative, 10),
    firstBuyPriceNative: round(firstBuyPriceNative, 10),
    boughtTokenAmount: round(boughtTokenAmount, 8),
    soldTokenAmount: round(soldTokenAmount, 8)
  };
}

function clamp01(value) {
  return Math.max(0, Math.min(1, Number(value) || 0));
}

function logScore(value, cap) {
  if (!Number.isFinite(Number(value)) || Number(value) <= 1) return 0;
  return clamp01(Math.log10(Number(value)) / Math.log10(cap));
}

export const SMART_SCORING_DEFAULTS = Object.freeze({
  priorWins: 1,
  priorLosses: 1,
  significantProfitRate: 0.002,
  repeatMinHits: 2,
  idealTradesPerToken: 2,
  participationDecay: 8,
  lowFrequencyReasonThreshold: 0.8
});

function positiveNumber(value, fallback = 0) {
  const next = Number(value);
  return Number.isFinite(next) && next >= 0 ? next : fallback;
}

function normalizedWeights(weights = {}) {
  const merged = { ...DEFAULT_SMART_SCORE_WEIGHTS, ...(weights || {}) };
  const entries = Object.entries(merged).map(([key, value]) => [key, positiveNumber(value)]);
  const total = entries.reduce((sum, [, value]) => sum + value, 0) || 1;
  return Object.fromEntries(entries.map(([key, value]) => [key, value / total]));
}

function holderEvidenceScore(features) {
  const rank = Number(features.bestHolderRank);
  const rankEvidence = Number.isFinite(rank) && rank > 0
    ? clamp01(1 - Math.log10(Math.max(1, rank)) / 2)
    : 0;
  const share = positiveNumber(features.bestHoldingSharePercent) / 100;
  const significantProfitRate = Math.max(
    Number.EPSILON,
    positiveNumber(features.significantProfitRate, SMART_SCORING_DEFAULTS.significantProfitRate)
  );
  const shareEvidence = clamp01(share / significantProfitRate);
  return rankEvidence * 0.65 + shareEvidence * 0.35;
}

export function scoreWallet(features, options = {}) {
  const hits = Math.max(0, Number(features.hits) || 0);
  const entries = Math.max(hits, Number(features.entries) || hits || 1);
  const observedWinRate = entries > 0 ? hits / entries : 0;
  const priorWins = positiveNumber(options.priorWins ?? features.priorWins, SMART_SCORING_DEFAULTS.priorWins);
  const priorLosses = positiveNumber(options.priorLosses ?? features.priorLosses, SMART_SCORING_DEFAULTS.priorLosses);
  const priorStrength = priorWins + priorLosses;
  const adjustedWinRate = (hits + priorWins) / Math.max(1, entries + priorStrength);
  const sampleConfidence = entries / Math.max(1, entries + priorStrength);
  const totalTradeCount = Math.max(0, Number(features.totalTradeCount) || 0);
  const inferredTradeCoverage = Object.hasOwn(features, 'totalTradeCount') ? 1 : 0;
  const tradeCountCoverage = clamp01(features.tradeCountCoverage ?? inferredTradeCoverage);
  const tradeCountEntries = Math.max(
    0,
    Number(features.tradeCountEntries) || (tradeCountCoverage > 0 ? entries * tradeCountCoverage : 0)
  );
  const tradeFrequency = tradeCountEntries > 0 ? totalTradeCount / tradeCountEntries : null;
  const idealTradesPerToken = Math.max(
    Number.EPSILON,
    positiveNumber(options.idealTradesPerToken, SMART_SCORING_DEFAULTS.idealTradesPerToken)
  );
  const participationDecay = Math.max(
    Number.EPSILON,
    positiveNumber(options.participationDecay, SMART_SCORING_DEFAULTS.participationDecay)
  );
  const participationSelectivity = 1 / Math.sqrt(Math.max(1, entries));
  const tradeSelectivity = tradeFrequency === null
    ? 0.5
    : 1 / Math.sqrt(Math.max(1, tradeFrequency / idealTradesPerToken));
  const missedEntries = Math.max(0, entries - hits);
  const missSelectivity = Math.exp(-missedEntries / participationDecay);
  const lowFrequencyScore = clamp01(
    participationSelectivity * 0.35 + tradeSelectivity * 0.45 + missSelectivity * 0.2
  );
  const winRateScore = clamp01(adjustedWinRate * (0.5 + sampleConfidence * 0.5));
  const repeatMinHits = Math.max(
    1,
    Math.floor(positiveNumber(options.repeatMinHits ?? features.repeatMinHits, SMART_SCORING_DEFAULTS.repeatMinHits))
  );
  const repeatabilityScore = hits < repeatMinHits
    ? clamp01((hits / repeatMinHits) * sampleConfidence * 0.5)
    : clamp01((0.55 + 0.45 * (1 - Math.exp(-(hits - repeatMinHits + 1) / 2))) * adjustedWinRate);
  const significantProfitRate = Math.max(
    Number.EPSILON,
    positiveNumber(
      options.significantProfitRate ?? features.significantProfitRate,
      SMART_SCORING_DEFAULTS.significantProfitRate
    )
  );
  const aggregateProfitRate = positiveNumber(features.profitToPeakMarketCapRatio);
  const profitCoverage = clamp01(features.normalizedProfitCoverage ?? 0);
  const normalizedProfitScore = clamp01(
    (aggregateProfitRate / (aggregateProfitRate + significantProfitRate)) * (0.5 + profitCoverage * 0.5)
  );
  const holderEvidence = holderEvidenceScore({ ...features, significantProfitRate });
  const bestMultiple = Math.max(
    Number(features.maxRealizedMultiple) || 0,
    Number(features.maxUnrealizedMultiple) || 0,
    Number(features.maxTotalMultiple) || 0
  );
  const multipleQualityScore = logScore(bestMultiple, 100);
  const weights = normalizedWeights(options.weights ?? features.scoreWeights);
  const smartScore = round(
    100 * (
      lowFrequencyScore * weights.lowFrequency +
      winRateScore * weights.winRate +
      normalizedProfitScore * weights.normalizedProfit +
      repeatabilityScore * weights.repeatability +
      multipleQualityScore * weights.multipleQuality +
      holderEvidence * weights.holderEvidence
    ),
    1
  );

  let classification = 'single_hit';
  if (hits >= 2) {
    if ((features.maxRealizedMultiple || 0) >= 5 && (features.maxUnrealizedMultiple || 0) >= 5) {
      classification = 'all_round';
    } else if ((features.maxRealizedMultiple || 0) >= (features.maxUnrealizedMultiple || 0)) {
      classification = 'realized';
    } else {
      classification = 'unrealized';
    }
  }
  return {
    score: smartScore,
    smartScore,
    classification,
    hitRate: round(observedWinRate, 4),
    observedWinRate: round(observedWinRate, 4),
    adjustedWinRate: round(adjustedWinRate, 4),
    sampleConfidence: round(sampleConfidence, 4),
    tradeFrequency: round(tradeFrequency, 2),
    totalTradeCount: tradeCountCoverage > 0 ? totalTradeCount : null,
    tradeCountCoverage: round(tradeCountCoverage, 4),
    lowFrequencyScore: round(lowFrequencyScore, 4),
    winRateScore: round(winRateScore, 4),
    normalizedProfitScore: round(normalizedProfitScore, 4),
    repeatabilityScore: round(repeatabilityScore, 4),
    multipleQualityScore: round(multipleQualityScore, 4),
    holderEvidenceScore: round(holderEvidence, 4),
    scoreComponents: {
      lowFrequency: round(lowFrequencyScore * weights.lowFrequency * 100, 2),
      winRate: round(winRateScore * weights.winRate * 100, 2),
      normalizedProfit: round(normalizedProfitScore * weights.normalizedProfit * 100, 2),
      repeatability: round(repeatabilityScore * weights.repeatability * 100, 2),
      multipleQuality: round(multipleQualityScore * weights.multipleQuality * 100, 2),
      holderEvidence: round(holderEvidence * weights.holderEvidence * 100, 2)
    },
    scoringModel: 'beta_adjusted_low_frequency_v1',
    bestMultiple: round(bestMultiple)
  };
}
