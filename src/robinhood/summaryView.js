const WALLET_OMITTED_FIELDS = new Set([
  'performances',
  'curation',
  'clusterEvidence',
  'clusterFingerprint',
  'clusterFingerprints',
  'scoreComponents',
  'scoreWeights',
  'scoringModel',
  'recurrence',
  'relatedCluster',
  'relatedClusters',
  'manualWinnerHitTokenAddresses',
  'buyFrequency'
]);

const PERFORMANCE_FIELDS = [
  'tokenAddress',
  'tokenSymbol',
  'tokenName',
  'holderSnapshotAt',
  'entryCostUsd',
  'buyVolumeUsd',
  'holderRank',
  'holdingSharePercent',
  'realizedProfitUsd',
  'unrealizedProfitUsd',
  'totalProfitUsd',
  'realizedMultiple',
  'unrealizedMultiple',
  'totalMultiple',
  'bestMultiple',
  'eligible',
  'hit',
  'profitState'
];

const BUY_FREQUENCY_FIELDS = [
  'averageDailyDistinctTokens',
  'distinctTokenDayCount',
  'observedDays',
  'monitoredCalendarDays',
  'maxDailyDistinctTokens'
];

function object(value) {
  return value && typeof value === 'object' && !Array.isArray(value) ? value : {};
}

function withoutFields(value, omitted) {
  return Object.fromEntries(Object.entries(object(value)).filter(([key]) => !omitted.has(key)));
}

function selectedFields(value, fields) {
  const source = object(value);
  return Object.fromEntries(fields.filter((key) => source[key] !== undefined).map((key) => [key, source[key]]));
}

export function summarizeWinner(winner) {
  const source = object(winner);
  const result = withoutFields(source, new Set(['holderAnalysis', 'pools']));
  if (source.holderAnalysis && typeof source.holderAnalysis === 'object') {
    const holderAnalysis = withoutFields(source.holderAnalysis, new Set(['candidates', 'failures']));
    result.holderAnalysis = {
      ...holderAnalysis,
      ...(Array.isArray(source.holderAnalysis.candidates)
        ? { candidateCount: source.holderAnalysis.candidates.length }
        : {}),
      ...(Array.isArray(source.holderAnalysis.failures)
        ? { failureCount: source.holderAnalysis.failures.length }
        : {})
    };
  }
  if (Array.isArray(source.pools)) result.poolCount = source.pools.length;
  return result;
}

export function summarizeWallet(wallet) {
  const source = object(wallet);
  const result = withoutFields(source, WALLET_OMITTED_FIELDS);
  if (Array.isArray(source.performances)) {
    result.performanceCount = source.performances.length;
    result.performances = source.performances.map((performance) => selectedFields(performance, PERFORMANCE_FIELDS));
  }
  if (source.buyFrequency && typeof source.buyFrequency === 'object') {
    result.buyFrequency = selectedFields(source.buyFrequency, BUY_FREQUENCY_FIELDS);
  }
  return result;
}

export function summarizeDashboard(dashboard) {
  const source = object(dashboard);
  return {
    ...source,
    view: 'summary',
    wallets: (Array.isArray(source.wallets) ? source.wallets : []).map(summarizeWallet),
    winners: (Array.isArray(source.winners) ? source.winners : []).map(summarizeWinner)
  };
}
