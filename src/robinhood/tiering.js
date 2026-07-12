export const WALLET_MONITOR_TIERS = new Set(['core', 'watch', 'high_frequency']);

export const WALLET_TIER_THRESHOLDS = Object.freeze({
  highFrequencyTradesPerToken: 20,
  broadTokenSamples: 4,
  mixedTokenSamples: 3,
  mixedMaximumHitRate: 0.5,
  coreMaximumTokenSamples: 2,
  coreMaximumTotalTrades: 20,
  coreMinimumProfitUsd: 40_000,
  coreMinimumBestMultiple: 10
});

function finiteNumber(value) {
  if (value === null || value === undefined || value === '') return null;
  const number = Number(value);
  return Number.isFinite(number) ? number : null;
}

export function normalizeWalletMonitorTier(value, fallback = 'watch') {
  const normalized = String(value || '').toLowerCase();
  return WALLET_MONITOR_TIERS.has(normalized) ? normalized : fallback;
}

export function classifyWalletMonitorTier(wallet = {}, thresholds = WALLET_TIER_THRESHOLDS) {
  const entries = finiteNumber(wallet.entries);
  const hits = finiteNumber(wallet.hits);
  const tradeFrequency = finiteNumber(wallet.tradeFrequency);
  const totalTradeCount = finiteNumber(wallet.totalTradeCount);
  const totalProfitUsd = finiteNumber(wallet.totalProfitUsd);
  const bestMultiple = finiteNumber(wallet.bestMultiple);
  const hitRate = entries !== null && entries > 0 && hits !== null ? hits / entries : null;

  const highFrequencyReasons = [];
  if (tradeFrequency !== null && tradeFrequency >= thresholds.highFrequencyTradesPerToken) {
    highFrequencyReasons.push('high_trades_per_token');
  }
  if (entries !== null && entries >= thresholds.broadTokenSamples) {
    highFrequencyReasons.push('broad_token_samples');
  } else if (
    entries !== null &&
    entries >= thresholds.mixedTokenSamples &&
    hitRate !== null &&
    hitRate <= thresholds.mixedMaximumHitRate
  ) {
    highFrequencyReasons.push('broad_mixed_samples');
  }
  if (highFrequencyReasons.length) {
    return {
      monitorTier: 'high_frequency',
      reasons: highFrequencyReasons,
      metrics: { entries, hits, hitRate, tradeFrequency, totalTradeCount, totalProfitUsd, bestMultiple }
    };
  }

  const coreChecks = {
    tokenSamples: entries !== null && entries <= thresholds.coreMaximumTokenSamples,
    totalTrades: totalTradeCount !== null && totalTradeCount <= thresholds.coreMaximumTotalTrades,
    profit: totalProfitUsd !== null && totalProfitUsd >= thresholds.coreMinimumProfitUsd,
    multiple: bestMultiple !== null && bestMultiple >= thresholds.coreMinimumBestMultiple
  };
  if (Object.values(coreChecks).every(Boolean)) {
    return {
      monitorTier: 'core',
      reasons: ['selective_high_profit'],
      metrics: { entries, hits, hitRate, tradeFrequency, totalTradeCount, totalProfitUsd, bestMultiple }
    };
  }

  const hasCompleteMetrics = [entries, totalTradeCount, totalProfitUsd, bestMultiple].every((value) => value !== null);
  return {
    monitorTier: 'watch',
    reasons: [hasCompleteMetrics ? 'standard_observation' : 'insufficient_sample_data'],
    metrics: { entries, hits, hitRate, tradeFrequency, totalTradeCount, totalProfitUsd, bestMultiple }
  };
}
