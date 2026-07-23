import { buildWalletSummaries, discoveryMultiple } from './qualification.js';
import { DEFAULT_SMART_SCORE_WEIGHTS } from './config.js';
import {
  applyWalletMonitorRulesPatch,
  defaultWalletMonitorRules,
  normalizeWalletMonitorRules
} from './monitorRules.js';
import { normalizeWalletMonitorTier, WALLET_MONITOR_TIERS } from './tiering.js';

const ADDRESS_PATTERN = /^0x[0-9a-f]{40}$/;
const DEFAULT_CHAIN_ID = 'robinhood';
const DEFAULT_CHAIN_LABEL = 'Robinhood';
const DEFAULT_DEBOT_ADDRESS_ROOT = 'https://debot.ai/address/robinhood';
const ALLOWED_TABS = new Set(['all_round', 'realized', 'unrealized', 'single_hit', 'all']);
const WALLET_STATUSES = new Set(['active', 'excluded', 'watch']);
const WALLET_CLASSIFICATIONS = new Set(['all_round', 'realized', 'unrealized', 'single_hit']);

const DEFAULT_FILTERS = Object.freeze({
  multiple: 10,
  minLiquidityUsd: 50_000,
  minWallets: 100,
  tab: 'all',
  strategy: 'smart'
});

const MAX_MIN_ENTRY_USD = 1_000_000_000;
export const MAX_WALLET_BATCH_LINES = 500;

function nowIso(now) {
  return new Date(now()).toISOString();
}

function unixSeconds(now) {
  return Math.floor(now() / 1000);
}

function finiteNumber(...values) {
  for (const value of values) {
    if (value === null || value === undefined || value === '') continue;
    const number = Number(value);
    if (Number.isFinite(number)) return number;
  }
  return null;
}

function normalizedScanMinimumEntryUsd(value, fallback = 500) {
  if (value === null || value === undefined || value === '') {
    return Math.max(0, finiteNumber(fallback) ?? 500);
  }
  const parsed = finiteNumber(value);
  if (parsed === null || parsed < 0 || parsed > MAX_MIN_ENTRY_USD) {
    throw new TypeError('minEntryUsd must be a number from 0 to 1000000000');
  }
  return parsed;
}

function normalizeAddress(value) {
  return String(value || '').toLowerCase();
}

export function isRobinhoodAddress(value) {
  return ADDRESS_PATTERN.test(normalizeAddress(value));
}

function errorMessage(error) {
  return error instanceof Error ? error.message : String(error);
}

function uniqueStrings(values) {
  return [...new Set(values.filter(Boolean).map(String))];
}

function holderCandidates(holderAnalysis) {
  return Array.isArray(holderAnalysis?.candidates) ? holderAnalysis.candidates : [];
}

function usableHolderCandidate(candidate) {
  if (!candidate || typeof candidate !== 'object') return false;
  if (candidate.profitState && candidate.profitState !== 'complete') return false;
  if (candidate.profitState === 'complete' || candidate.eligible === true) return true;
  return finiteNumber(
    candidate.totalProfitUsd,
    candidate.realizedProfitUsd,
    candidate.unrealizedProfitUsd,
    candidate.totalMultiple
  ) !== null;
}

function hasUsableHolderAnalysis(holderAnalysis) {
  return holderCandidates(holderAnalysis).some(usableHolderCandidate);
}

function holderAnalysisError(holderAnalysis, scan, fallback = 'Holder analysis did not return usable results') {
  const failure = Array.isArray(holderAnalysis?.failures)
    ? holderAnalysis.failures.find((candidate) => candidate?.error)
    : null;
  return String(
    holderAnalysis?.error ||
    scan?.holderFallbackError ||
    failure?.error ||
    scan?.error ||
    scan?.fallbackReason ||
    fallback
  );
}

function holderCacheTimestamp(token, job = null) {
  return token?.holderAnalysis?.snapshotAt || token?.scannedAt || job?.completedAt || null;
}

function staleHolderAnalysis(holderAnalysis, { failedAt, error, cachedAt } = {}) {
  return {
    ...holderAnalysis,
    stale: true,
    cached: true,
    staleAt: failedAt || null,
    staleError: String(error || 'Holder refresh failed'),
    cachedAt: cachedAt || holderAnalysis?.snapshotAt || null
  };
}

function freshHolderAnalysis(holderAnalysis) {
  if (!holderAnalysis || typeof holderAnalysis !== 'object') return holderAnalysis;
  const {
    stale: _stale,
    cached: _cached,
    staleAt: _staleAt,
    staleError: _staleError,
    cachedAt: _cachedAt,
    ...fresh
  } = holderAnalysis;
  return fresh;
}

function hasStaleHolderCache(token) {
  return token?.holderAnalysis?.stale === true && hasUsableHolderAnalysis(token.holderAnalysis);
}

function normalizedTags(values) {
  if (!Array.isArray(values)) return [];
  const seen = new Set();
  const result = [];
  for (const value of values) {
    const tag = String(value || '').trim();
    const key = tag.toLocaleLowerCase();
    if (!tag || seen.has(key)) continue;
    seen.add(key);
    result.push(tag);
  }
  return result;
}

function normalizedWalletStatus(value, fallback = 'active') {
  const status = String(value || fallback).toLowerCase();
  return WALLET_STATUSES.has(status) ? status : fallback;
}

function walletAnnotationDefaults(address) {
  return {
    address,
    alias: '',
    note: '',
    tags: [],
    status: 'active',
    classificationOverride: null,
    monitorTier: 'watch',
    monitorRules: defaultWalletMonitorRules(),
    createdAt: null,
    updatedAt: null
  };
}

function publicBuyFrequency(stats) {
  if (!stats || typeof stats !== 'object') return null;
  return {
    averageDailyDistinctTokens: Math.max(0, finiteNumber(stats.averageDailyDistinctTokens) ?? 0),
    distinctTokenDayCount: Math.max(0, Math.floor(finiteNumber(stats.distinctTokenDayCount) ?? 0)),
    distinctTokens: Math.max(0, Math.floor(finiteNumber(stats.distinctTokens) ?? 0)),
    activeBuyDays: Math.max(0, Math.floor(finiteNumber(stats.activeBuyDays) ?? 0)),
    maxDailyDistinctTokens: Math.max(0, Math.floor(finiteNumber(stats.maxDailyDistinctTokens) ?? 0)),
    observedDays: Math.max(1, Math.floor(finiteNumber(stats.observedDays) ?? 1)),
    observedFrom: isoFromUnknown(stats.observedFrom),
    observedThrough: isoFromUnknown(stats.observedThrough),
    firstBuyAt: isoFromUnknown(stats.firstBuyAt),
    lastBuyAt: isoFromUnknown(stats.lastBuyAt),
    calculatedAt: isoFromUnknown(stats.calculatedAt),
    timezone: String(stats.timezone || 'Asia/Shanghai'),
    source: String(stats.source || 'monitor_events'),
    partialHistory: stats.partialHistory !== false
  };
}

function mergeWalletAnnotation(summary, annotation, address, buyFrequency = null, {
  addressNormalizer = normalizeAddress,
  debotAddressRoot = DEFAULT_DEBOT_ADDRESS_ROOT
} = {}) {
  const normalized = addressNormalizer(address || summary?.address || annotation?.address);
  const monitorTier = normalizeWalletMonitorTier(annotation?.monitorTier);
  const curation = {
    ...walletAnnotationDefaults(normalized),
    ...(annotation || {}),
    address: normalized,
    tags: normalizedTags(annotation?.tags),
    status: normalizedWalletStatus(annotation?.status),
    monitorTier,
    monitorRules: normalizeWalletMonitorRules(annotation?.monitorRules)
  };
  const computedClassification = summary?.classification || null;
  const classification = curation.classificationOverride || computedClassification;
  const reviewState = annotation
    ? curation.status === 'excluded' ? 'excluded' : 'confirmed'
    : 'pending';
  return {
    ...(summary || {}),
    ...curation,
    address: normalized,
    computedClassification,
    classification,
    monitorTier,
    curated: Boolean(annotation),
    confirmed: reviewState === 'confirmed',
    reviewState,
    debotUrl: `${debotAddressRoot}/${normalized}`,
    curation,
    ...(buyFrequency ? { buyFrequency: publicBuyFrequency(buyFrequency) } : {})
  };
}

function walletPerformanceProfit(performance) {
  const explicit = finiteNumber(performance?.totalProfitUsd);
  if (explicit !== null) return explicit;
  return (finiteNumber(performance?.realizedProfitUsd) ?? 0) +
    (finiteNumber(performance?.unrealizedProfitUsd) ?? 0);
}

function attachCandidateReviewMetadata(summaries, {
  addressNormalizer = normalizeAddress,
  addressValidator = isRobinhoodAddress,
  debotAddressRoot = DEFAULT_DEBOT_ADDRESS_ROOT
} = {}) {
  const byToken = new Map();
  for (const summary of summaries) {
    summary.debotUrl = `${debotAddressRoot}/${addressNormalizer(summary.address)}`;
    for (const performance of Array.isArray(summary.performances) ? summary.performances : []) {
      const tokenAddress = addressNormalizer(performance.tokenAddress);
      if (!addressValidator(tokenAddress)) continue;
      if (!byToken.has(tokenAddress)) byToken.set(tokenAddress, []);
      byToken.get(tokenAddress).push({ summary, performance });
    }
  }
  for (const rows of byToken.values()) {
    rows.sort((left, right) =>
      walletPerformanceProfit(right.performance) - walletPerformanceProfit(left.performance) ||
      (finiteNumber(right.performance.bestMultiple, right.performance.totalMultiple) ?? 0) -
        (finiteNumber(left.performance.bestMultiple, left.performance.totalMultiple) ?? 0) ||
      addressNormalizer(left.summary.address).localeCompare(addressNormalizer(right.summary.address))
    );
    rows.forEach(({ performance }, index) => {
      performance.profitRank = index + 1;
    });
  }
  for (const summary of summaries) {
    const performances = (Array.isArray(summary.performances) ? summary.performances : [])
      .filter((performance) => finiteNumber(performance.profitRank) !== null)
      .sort((left, right) =>
        walletPerformanceProfit(right) - walletPerformanceProfit(left) ||
        (finiteNumber(left.profitRank) ?? Infinity) - (finiteNumber(right.profitRank) ?? Infinity)
      );
    const best = performances[0];
    if (!best) continue;
    const symbol = String(best.symbol || '金狗').trim().replace(/\s+/g, ' ').slice(0, 32) || '金狗';
    const profitRank = Math.max(1, Math.floor(finiteNumber(best.profitRank) ?? 1));
    summary.profitRank = profitRank;
    summary.bestProfitTokenAddress = addressNormalizer(best.tokenAddress);
    summary.bestProfitTokenSymbol = symbol;
    summary.suggestedAlias = `${symbol} ${profitRank}`;
  }
  return summaries;
}

function walletMatchesCuration(wallet, filters = {}) {
  const status = String(filters.status || '').toLowerCase();
  if (status && status !== 'all' && wallet.status !== status) return false;
  const review = String(filters.review || '').toLowerCase();
  if (!status && wallet.status === 'excluded' && !['excluded', 'all'].includes(review)) return false;

  const classification = String(filters.classification || '').toLowerCase();
  if (classification && classification !== 'all' && wallet.classification !== classification) return false;

  const monitorTier = String(filters.monitorTier || '').toLowerCase();
  if (monitorTier && monitorTier !== 'all' && wallet.monitorTier !== monitorTier) return false;

  const requestedTags = normalizedTags(filters.tags).map((tag) => tag.toLocaleLowerCase());
  if (requestedTags.length) {
    const walletTags = new Set(normalizedTags(wallet.tags).map((tag) => tag.toLocaleLowerCase()));
    if (!requestedTags.every((tag) => walletTags.has(tag))) return false;
  }

  const search = String(filters.search || filters.q || '').trim().toLocaleLowerCase();
  if (!search) return true;
  return [wallet.address, wallet.alias, wallet.note, wallet.classification, wallet.monitorTier, ...wallet.tags]
    .some((value) => String(value || '').toLocaleLowerCase().includes(search));
}

function walletMatchesReview(wallet, filters = {}) {
  const review = String(filters.review || 'all').toLowerCase();
  if (review === 'pending') return wallet.reviewState === 'pending';
  if (review === 'confirmed') return wallet.reviewState === 'confirmed';
  if (review === 'excluded') return wallet.reviewState === 'excluded';
  return true;
}

function normalizedFilters(filters = {}, defaults = DEFAULT_FILTERS) {
  const multiple = finiteNumber(filters.multiple, defaults.multiple, DEFAULT_FILTERS.multiple);
  const minLiquidityUsd = finiteNumber(
    filters.minLiquidityUsd,
    defaults.minLiquidityUsd,
    DEFAULT_FILTERS.minLiquidityUsd
  );
  const minWallets = finiteNumber(filters.minWallets, defaults.minWallets, DEFAULT_FILTERS.minWallets);
  const tab = ALLOWED_TABS.has(filters.tab) ? filters.tab : defaults.tab || DEFAULT_FILTERS.tab;
  const strategy = String(filters.strategy || defaults.strategy || DEFAULT_FILTERS.strategy).toLowerCase() === 'multiple'
    ? 'multiple'
    : 'smart';
  return { multiple, minLiquidityUsd, minWallets, tab, strategy };
}

function tokenMetrics(token) {
  const holderCandidates = Array.isArray(token.holderAnalysis?.candidates) ? token.holderAnalysis.candidates : [];
  return {
    peakMultiple: finiteNumber(
      token.peakMultiple,
      token.peakPriceMultiple,
      token.maxMultiple,
      token.qualification?.peakMultiple,
      discoveryMultiple(token)
    ),
    peakLiquidityUsd: finiteNumber(
      token.peakLiquidityUsd,
      token.maxLiquidityUsd,
      token.qualification?.peakLiquidityUsd,
      token.liquidityUsd
    ),
    effectiveWallets: finiteNumber(
      token.effectiveWallets,
      token.effectiveWalletCount,
      token.qualification?.effectiveWallets,
      token.holderAnalysis?.analyzedWallets
    ),
    highestWalletMultiple: holderCandidates.length
      ? Math.max(0, ...holderCandidates.map((candidate) => finiteNumber(candidate.bestMultiple) ?? 0))
      : null,
    holderCandidates: finiteNumber(token.holderAnalysis?.analyzedWallets),
    eligibleWallets: finiteNumber(token.holderAnalysis?.eligibleWallets)
  };
}

function qualifyToken(token, filters) {
  const metrics = tokenMetrics(token);
  if (token.manual === true && token.holderAnalysis) {
    const complete = token.holderAnalysis.complete === true && token.scanStatus === 'complete';
    return {
      ...token,
      ...metrics,
      provisional: !complete,
      qualified: false,
      qualificationStatus: complete ? 'manual_complete' : 'manual_partial',
      qualificationChecks: {
        holderCandidates: (metrics.holderCandidates ?? 0) > 0,
        profits: complete,
        minimumEntry: (metrics.eligibleWallets ?? 0) > 0
      },
      qualificationReasons: complete ? [] : ['holder_profit_partial']
    };
  }
  const checks = {
    multiple: metrics.peakMultiple === null ? null : metrics.peakMultiple >= filters.multiple,
    liquidity: metrics.peakLiquidityUsd === null ? null : metrics.peakLiquidityUsd >= filters.minLiquidityUsd,
    wallets: metrics.effectiveWallets === null ? null : metrics.effectiveWallets >= filters.minWallets
  };
  const missing = Object.entries(checks).filter(([, value]) => value === null).map(([key]) => key);
  const failed = Object.entries(checks).filter(([, value]) => value === false).map(([key]) => key);
  let qualificationStatus = 'qualified';
  if (missing.length) qualificationStatus = token.manual ? 'manual_pending' : 'pending';
  else if (failed.length) qualificationStatus = token.manual ? 'manual_below_threshold' : 'below_threshold';

  return {
    ...token,
    ...metrics,
    provisional: token.qualification?.provisional ?? token.scanStatus !== 'complete',
    qualified: qualificationStatus === 'qualified',
    qualificationStatus,
    qualificationChecks: checks,
    qualificationReasons: [...missing.map((key) => `missing_${key}`), ...failed.map((key) => `below_${key}`)]
  };
}

function walletHits(wallet) {
  return finiteNumber(wallet.hits, wallet.winnerHits, wallet.qualifiedWinnerHits) ?? 0;
}

function walletBestMultiple(wallet) {
  return Math.max(
    finiteNumber(wallet.maxRealizedMultiple) ?? 0,
    finiteNumber(wallet.maxUnrealizedMultiple) ?? 0,
    finiteNumber(wallet.maxTotalMultiple) ?? 0
  );
}

function walletMatchesTab(wallet, filters) {
  if (wallet.classificationOverride && !['all', 'all_round'].includes(filters.tab)) {
    return wallet.classificationOverride === filters.tab;
  }
  const hits = walletHits(wallet);
  const realized = finiteNumber(wallet.maxRealizedMultiple);
  const unrealized = finiteNumber(wallet.maxUnrealizedMultiple);
  const hasSmartDecision = typeof wallet.smartEligible === 'boolean';
  if (filters.strategy === 'smart' && filters.tab === 'all' && hasSmartDecision) {
    return wallet.smartEligible;
  }
  if (filters.tab === 'single_hit') return hits === 1 && walletBestMultiple(wallet) >= filters.multiple;
  if (filters.tab === 'realized') return realized !== null && realized >= filters.multiple;
  if (filters.tab === 'unrealized') return unrealized !== null && unrealized >= filters.multiple;
  if (filters.tab === 'all') return walletBestMultiple(wallet) >= filters.multiple;
  return hits >= 2 && walletBestMultiple(wallet) >= filters.multiple;
}

function sortWallets(a, b, addressNormalizer = normalizeAddress) {
  return (
    (finiteNumber(b.score) ?? 0) - (finiteNumber(a.score) ?? 0) ||
    walletBestMultiple(b) - walletBestMultiple(a) ||
    addressNormalizer(a.address).localeCompare(addressNormalizer(b.address))
  );
}

function sortWinners(a, b, addressNormalizer = normalizeAddress) {
  const statusOrder = {
    manual_complete: 0,
    qualified: 1,
    manual_partial: 2,
    manual_pending: 3,
    manual_below_threshold: 4,
    pending: 5,
    below_threshold: 6
  };
  return (
    (statusOrder[a.qualificationStatus] ?? 9) - (statusOrder[b.qualificationStatus] ?? 9) ||
    (b.peakMultiple ?? -1) - (a.peakMultiple ?? -1) ||
    (b.peakLiquidityUsd ?? -1) - (a.peakLiquidityUsd ?? -1) ||
    addressNormalizer(a.address).localeCompare(addressNormalizer(b.address))
  );
}

function isoFromUnknown(value) {
  if (value === null || value === undefined || value === '') return null;
  if (typeof value === 'string' && Number.isNaN(Number(value))) {
    const parsed = Date.parse(value);
    return Number.isFinite(parsed) ? new Date(parsed).toISOString() : null;
  }
  const number = Number(value);
  if (!Number.isFinite(number)) return null;
  return new Date(number < 10_000_000_000 ? number * 1000 : number).toISOString();
}

function latestTokenTimestamp(tokens) {
  let latest = null;
  for (const token of tokens) {
    const candidate = isoFromUnknown(
      token.scannedAt || token.holderAnalysis?.snapshotAt || token.updatedAt || token.discoveredAt
    );
    if (candidate && (!latest || candidate > latest)) latest = candidate;
  }
  return latest;
}

function latestWalletAnnotationTimestamp(annotations) {
  let latest = null;
  for (const annotation of annotations) {
    const candidate = isoFromUnknown(annotation.updatedAt || annotation.createdAt);
    if (candidate && (!latest || candidate > latest)) latest = candidate;
  }
  return latest;
}

export class RobinhoodService {
  constructor({
    debotClient,
    store,
    poolClient = null,
    holderClient = null,
    scanToken = null,
    config = {},
    scanConcurrency = 2,
    now = Date.now,
    chainId = null,
    chainLabel = null,
    addressNormalizer = null,
    addressValidator = null,
    transactionNormalizer = null,
    debotAddressRoot = null,
    walletSummaryBuilder = null
  }) {
    const resolvedChainId = String(chainId || config.chainId || store?.chainId || DEFAULT_CHAIN_ID)
      .trim()
      .toLowerCase() || DEFAULT_CHAIN_ID;
    const resolvedChainLabel = String(
      chainLabel || config.chainLabel || store?.chainLabel || (resolvedChainId === DEFAULT_CHAIN_ID
        ? DEFAULT_CHAIN_LABEL
        : resolvedChainId)
    ).trim() || resolvedChainId;
    if (!store?.upsertToken || !store?.listTokens) {
      throw new TypeError(`A ${resolvedChainLabel} store is required`);
    }
    const resolvedAddressNormalizer = addressNormalizer || config.addressNormalizer || store.normalizeAddress || normalizeAddress;
    const resolvedAddressValidator = addressValidator || config.addressValidator || store.isValidAddress || isRobinhoodAddress;
    const resolvedTransactionNormalizer = transactionNormalizer || config.transactionNormalizer || store.normalizeTransaction ||
      ((value) => String(value || '').toLowerCase());
    const resolvedWalletSummaryBuilder = walletSummaryBuilder || config.walletSummaryBuilder || buildWalletSummaries;
    if (typeof resolvedAddressNormalizer !== 'function') throw new TypeError('addressNormalizer must be a function');
    if (typeof resolvedAddressValidator !== 'function') throw new TypeError('addressValidator must be a function');
    if (typeof resolvedTransactionNormalizer !== 'function') throw new TypeError('transactionNormalizer must be a function');
    if (typeof resolvedWalletSummaryBuilder !== 'function') throw new TypeError('walletSummaryBuilder must be a function');
    this.chainId = resolvedChainId;
    this.chainLabel = resolvedChainLabel;
    this.normalizeAddress = (value) => String(resolvedAddressNormalizer(value) ?? '');
    this.isValidAddress = (value) => resolvedAddressValidator(this.normalizeAddress(value)) === true;
    this.normalizeTransaction = (value) => String(resolvedTransactionNormalizer(value) ?? '');
    this.debotAddressRoot = String(
      debotAddressRoot || config.debotAddressRoot || (resolvedChainId === DEFAULT_CHAIN_ID
        ? DEFAULT_DEBOT_ADDRESS_ROOT
        : `https://debot.ai/address/${resolvedChainId}`)
    ).replace(/\/$/, '');
    this.walletSummaryBuilder = resolvedWalletSummaryBuilder;
    this.lastSuccessMetadataKey = `${this.chainId}:last_success_at`;
    this.debotClient = debotClient || null;
    this.store = store;
    this.poolClient = poolClient;
    this.holderClient = holderClient;
    this.scanToken = typeof scanToken === 'function' ? scanToken : null;
    this.config = {
      defaultWinnerMultiple: finiteNumber(config.defaultWinnerMultiple) ?? DEFAULT_FILTERS.multiple,
      minLiquidityUsd: finiteNumber(config.minLiquidityUsd) ?? DEFAULT_FILTERS.minLiquidityUsd,
      minEffectiveWallets: finiteNumber(config.minEffectiveWallets) ?? DEFAULT_FILTERS.minWallets,
      minEntryUsd: Math.max(0, finiteNumber(config.minEntryUsd) ?? 500),
      significantProfitRate: Math.max(0.000001, finiteNumber(config.significantProfitRate) ?? 0.002),
      smartBaseMultiple: Math.max(1, finiteNumber(config.smartBaseMultiple) ?? 5),
      strictMultiple: Math.max(
        Math.max(1, finiteNumber(config.smartBaseMultiple) ?? 5),
        finiteNumber(config.strictMultiple) ?? 10
      ),
      repeatMinHits: Math.max(2, Math.floor(finiteNumber(config.repeatMinHits) ?? 2)),
      strongHolderRank: Math.max(1, Math.floor(finiteNumber(config.strongHolderRank) ?? 30)),
      relatedClusterPenalty: Math.max(0.5, Math.min(1, finiteNumber(config.relatedClusterPenalty) ?? 0.9)),
      lowFrequencyReasonThreshold: Math.max(
        0,
        Math.min(1, finiteNumber(config.lowFrequencyReasonThreshold) ?? 0.8)
      ),
      smartScoreWeights: {
        ...DEFAULT_SMART_SCORE_WEIGHTS,
        ...(config.smartScoreWeights || {})
      },
      holderCandidateLimit: Math.max(10, Math.floor(finiteNumber(config.holderCandidateLimit) ?? 100)),
      holderFetchLimit: Math.max(10, Math.floor(finiteNumber(config.holderFetchLimit) ?? 150)),
      holderProfitConcurrency: Math.max(1, Math.floor(finiteNumber(config.holderProfitConcurrency) ?? 6)),
      autoScanLimit: Math.max(0, Math.floor(finiteNumber(config.autoScanLimit) ?? 8)),
      discoveryLimit: Math.max(1, Math.floor(finiteNumber(config.discoveryLimit) ?? 50))
    };
    this.scanConcurrency = Math.max(1, Math.min(8, Math.floor(scanConcurrency) || 2));
    this.now = now;
    this.started = false;
    this.closed = false;
    this.refreshPromise = null;
    this.queue = [];
    this.queuedAddresses = new Set();
    this.activeScans = new Map();
    this.idleWaiters = new Set();
  }

  start() {
    if (!this.started && !this.closed) {
      this.started = true;
      this.#recoverFailedHolderCaches();
      this.#rebuildWalletSummaries();
    }
    return Promise.resolve({
      ok: !this.closed,
      accepted: false,
      status: 'manual-only',
      updatedAt: nowIso(this.now)
    });
  }

  triggerRefresh() {
    return {
      ok: !this.closed,
      accepted: false,
      alreadyRunning: false,
      status: 'manual-only',
      discovery: 'disabled',
      updatedAt: nowIso(this.now)
    };
  }

  refresh() {
    return Promise.resolve(this.triggerRefresh());
  }

  queueToken(token, { force = false, manual = false, minEntryUsd } = {}) {
    const address = this.normalizeAddress(token?.address);
    if (!this.isValidAddress(address)) throw new TypeError(`Invalid ${this.chainLabel} token address`);
    const minimumEntryUsd = normalizedScanMinimumEntryUsd(
      minEntryUsd,
      token?.holderAnalysis?.minimumEntryUsd ?? this.config.minEntryUsd
    );
    const current = this.store.listJobs().find((job) => job.id === `scan:${address}`);
    if (this.queuedAddresses.has(address) || this.activeScans.has(address)) return current;
    if (!force && current?.status === 'complete' && !manual) return current;

    const queuedAt = nowIso(this.now);
    const job = {
      id: `scan:${address}`,
      type: 'token_scan',
      tokenAddress: address,
      status: 'queued',
      manual: Boolean(manual || token.manual),
      minimumEntryUsd,
      queuedAt,
      updatedAt: unixSeconds(this.now)
    };
    this.store.upsertJob(job);
    this.queue.push({ token: { ...token, address }, job, force, minimumEntryUsd });
    this.queuedAddresses.add(address);
    queueMicrotask(() => this.#pumpQueue());
    return job;
  }

  triggerScan({ force = true, minEntryUsd } = {}) {
    if (minEntryUsd !== undefined) normalizedScanMinimumEntryUsd(minEntryUsd, this.config.minEntryUsd);
    const tokens = this.store.listTokens().filter((token) => token.manual === true);
    const queued = [];
    const active = [];
    for (const token of tokens) {
      const address = this.normalizeAddress(token.address);
      const alreadyRunning = this.queuedAddresses.has(address) || this.activeScans.has(address);
      const job = this.queueToken(token, { force, minEntryUsd });
      if (!job) continue;
      if (alreadyRunning) {
        active.push({ id: job.id, minimumEntryUsd: job.minimumEntryUsd });
      } else if (this.queuedAddresses.has(address)) {
        queued.push(job.id);
      }
    }
    return {
      ok: true,
      accepted: queued.length > 0,
      alreadyRunning: active.length > 0,
      status: queued.length || active.length ? 'scanning' : 'manual-only',
      queued: queued.length,
      jobs: queued,
      active,
      updatedAt: nowIso(this.now)
    };
  }

  #pumpQueue() {
    if (this.closed) return;
    while (this.activeScans.size < this.scanConcurrency && this.queue.length) {
      const item = this.queue.shift();
      this.queuedAddresses.delete(item.token.address);
      const task = this.#runScan(item).finally(() => {
        this.activeScans.delete(item.token.address);
        this.#pumpQueue();
        this.#notifyIdle();
      });
      this.activeScans.set(item.token.address, task);
    }
  }

  async #runScan({ token, job, force, minimumEntryUsd }) {
    const startedAt = nowIso(this.now);
    this.store.upsertJob({ ...job, status: 'running', startedAt, updatedAt: unixSeconds(this.now) });
    this.store.upsertToken({ ...token, scanStatus: 'running', scanError: null, updatedAt: unixSeconds(this.now) });

    try {
      if (!this.scanToken) throw new Error('Onchain token scanner is unavailable');
      const result = await this.scanToken({
        token,
        poolClient: this.poolClient,
        holderClient: this.holderClient,
        debotClient: this.debotClient,
        config: { ...this.config, minEntryUsd: minimumEntryUsd },
        force,
        onProgress: (progress) => {
          this.store.upsertJob({
            ...job,
            status: 'running',
            startedAt,
            progress,
            updatedAt: unixSeconds(this.now)
          });
        }
      });

      const scanComplete = result?.scan?.complete === true;
      const onchainComplete = result?.scan?.onchainComplete === true;
      const cachedActions = this.store.listActionsForToken(token.address);
      const canSeedPartial = !scanComplete && cachedActions.length === 0;
      const actionsReplaced = Array.isArray(result?.actions) && (scanComplete || onchainComplete || canSeedPartial);
      if (actionsReplaced) {
        this.store.replaceTokenActions(token.address, result.actions);
      }

      const completedAt = nowIso(this.now);
      const latest = this.store.getToken(token.address) || token;
      const tokenPatch = result?.tokenPatch || result?.token || result?.winner || {};
      const previousHolderAnalysis = latest.holderAnalysis;
      const nextHolderAnalysis = result?.holderAnalysis || tokenPatch.holderAnalysis || null;
      const cachedHolderAnalysisUsable = hasUsableHolderAnalysis(previousHolderAnalysis);
      const refreshedHolderAnalysisUsable = hasUsableHolderAnalysis(nextHolderAnalysis);
      const preserveCompleteHolderSnapshot = cachedHolderAnalysisUsable &&
        previousHolderAnalysis?.complete === true &&
        nextHolderAnalysis?.complete !== true;
      const useCachedHolderAnalysis = cachedHolderAnalysisUsable && (
        preserveCompleteHolderSnapshot ||
        (!refreshedHolderAnalysisUsable && (
          !scanComplete ||
          previousHolderAnalysis?.stale === true ||
          Boolean(nextHolderAnalysis && nextHolderAnalysis.complete !== true)
        ))
      );
      const refreshError = useCachedHolderAnalysis
        ? holderAnalysisError(
            nextHolderAnalysis,
            result?.scan,
            preserveCompleteHolderSnapshot
              ? 'New Holder analysis was partial; retained the last complete snapshot'
              : 'Holder analysis did not return usable results'
          )
        : null;
      const cachedAt = useCachedHolderAnalysis ? holderCacheTimestamp(latest) : null;
      const storedHolderAnalysis = useCachedHolderAnalysis
        ? staleHolderAnalysis(previousHolderAnalysis, {
            failedAt: completedAt,
            error: refreshError,
            cachedAt
          })
        : freshHolderAnalysis(nextHolderAnalysis);
      const holderAnalysisUpdated = Boolean(storedHolderAnalysis);
      this.store.upsertToken({
        ...latest,
        ...tokenPatch,
        ...(result?.qualification || {}),
        ...(storedHolderAnalysis ? { holderAnalysis: storedHolderAnalysis } : {}),
        address: token.address,
        pool: result?.pool || tokenPatch.pool || latest.pool || null,
        qualification: result?.qualification || latest.qualification || null,
        scan: result?.scan || null,
        scanStatus: scanComplete && !useCachedHolderAnalysis ? 'complete' : 'partial',
        scanError: refreshError,
        scanFailedAt: useCachedHolderAnalysis ? completedAt : null,
        ...(useCachedHolderAnalysis ? {} : { scannedAt: completedAt }),
        updatedAt: unixSeconds(this.now)
      });
      if (actionsReplaced || holderAnalysisUpdated) this.#rebuildWalletSummaries();
      this.store.upsertJob({
        ...job,
        status: 'complete',
        startedAt,
        completedAt,
        partial: !scanComplete || useCachedHolderAnalysis,
        cachedResult: useCachedHolderAnalysis,
        cachedAt,
        error: refreshError,
        result: result?.scan || null,
        updatedAt: unixSeconds(this.now)
      });
    } catch (error) {
      const failedAt = nowIso(this.now);
      const message = errorMessage(error);
      const latest = this.store.getToken(token.address) || token;
      const cachedResult = hasUsableHolderAnalysis(latest.holderAnalysis);
      const cachedAt = cachedResult ? holderCacheTimestamp(latest) : null;
      this.store.upsertToken({
        ...latest,
        address: token.address,
        ...(cachedResult
          ? {
              holderAnalysis: staleHolderAnalysis(latest.holderAnalysis, {
                failedAt,
                error: message,
                cachedAt
              })
            }
          : {}),
        scanStatus: cachedResult ? 'partial' : 'failed',
        scanError: message,
        scanFailedAt: failedAt,
        updatedAt: unixSeconds(this.now)
      });
      this.store.upsertJob({
        ...job,
        status: 'failed',
        startedAt,
        failedAt,
        error: message,
        retryable: true,
        partial: cachedResult,
        cachedResult,
        cachedAt,
        updatedAt: unixSeconds(this.now)
      });
    }
  }

  #recoverFailedHolderCaches() {
    const jobs = new Map(this.store.listJobs().map((job) => [job.id, job]));
    for (const token of this.store.listTokens()) {
      if (token.manual !== true || token.scanStatus !== 'failed' || !hasUsableHolderAnalysis(token.holderAnalysis)) {
        continue;
      }
      const job = jobs.get(`scan:${this.normalizeAddress(token.address)}`) || null;
      const failedAt = token.scanFailedAt || job?.failedAt || nowIso(this.now);
      const message = String(token.scanError || job?.error || 'Latest Holder refresh failed');
      const cachedAt = holderCacheTimestamp(token, job);
      this.store.upsertToken({
        ...token,
        scanStatus: 'partial',
        scanError: message,
        scanFailedAt: failedAt,
        holderAnalysis: staleHolderAnalysis(token.holderAnalysis, { failedAt, error: message, cachedAt })
      });
      if (job?.status === 'failed') {
        this.store.upsertJob({
          ...job,
          partial: true,
          cachedResult: true,
          cachedAt
        });
      }
    }
  }

  #rebuildWalletSummaries() {
    const tokens = this.store.listTokens().filter((token) => token.manual === true);
    const actionsByToken = new Map(
      tokens.map((token) => [this.normalizeAddress(token.address), this.store.listActionsForToken(token.address)])
    );
    const summaries = this.walletSummaryBuilder({
      tokens,
      actionsByToken,
      minimumHitMultiple: this.config.defaultWinnerMultiple,
      minimumEntryUsd: this.config.minEntryUsd,
      smartBaseMultiple: this.config.smartBaseMultiple,
      strictMultiple: this.config.strictMultiple,
      significantProfitRate: this.config.significantProfitRate,
      repeatMinHits: this.config.repeatMinHits,
      strongHolderRank: this.config.strongHolderRank,
      smartScoreWeights: this.config.smartScoreWeights,
      relatedClusterPenalty: this.config.relatedClusterPenalty,
      lowFrequencyReasonThreshold: this.config.lowFrequencyReasonThreshold,
      addressNormalizer: this.normalizeAddress,
      addressValidator: this.isValidAddress,
      transactionNormalizer: this.normalizeTransaction
    });
    this.store.replaceWalletSummaries(attachCandidateReviewMetadata(summaries, {
      addressNormalizer: this.normalizeAddress,
      addressValidator: this.isValidAddress,
      debotAddressRoot: this.debotAddressRoot
    }));
  }

  getDashboard(filters = {}) {
    const minimumEntryUsd = normalizedScanMinimumEntryUsd(filters.minEntryUsd, this.config.minEntryUsd);
    const appliedFilters = normalizedFilters(filters, {
      multiple: this.config.defaultWinnerMultiple,
      minLiquidityUsd: this.config.minLiquidityUsd,
      minWallets: this.config.minEffectiveWallets,
      tab: DEFAULT_FILTERS.tab
    });
    const tokens = this.store.listTokens().filter((token) => token.manual === true);
    const winners = tokens
      .map((token) => qualifyToken(token, appliedFilters))
      .sort((left, right) => sortWinners(left, right, this.normalizeAddress));
    const walletFilters = {
      ...filters,
      ...appliedFilters,
      tab: filters.tab || (filters.classification ? 'all' : appliedFilters.tab)
    };
    const wallets = this.listWallets(walletFilters);
    const annotations = this.store.listWalletAnnotations?.() || [];
    const jobs = this.store.listJobs().filter((job) => !['discovery', 'wallet_history'].includes(job.type));
    const lastSuccess =
      [latestTokenTimestamp(tokens), latestWalletAnnotationTimestamp(annotations)].filter(Boolean).sort().at(-1) || null;
    const running = jobs.some((job) => job.status === 'queued' || job.status === 'running');
    const pending = winners.some((winner) => ['pending', 'manual_pending'].includes(winner.qualificationStatus));
    const staleCachedTokens = tokens.filter(hasStaleHolderCache);
    const hardFailedTokens = tokens.filter((token) =>
      token.scanStatus === 'failed' && !hasUsableHolderAnalysis(token.holderAnalysis)
    );
    const failedScans = hardFailedTokens.length;
    const failedHolderWallets = tokens.reduce(
      (sum, token) => sum + Math.max(0, finiteNumber(token.holderAnalysis?.failedWallets) ?? 0),
      0
    );
    const partial = pending || failedScans > 0 || staleCachedTokens.length > 0 ||
      winners.some((winner) => winner.scanStatus === 'partial');
    const stale = staleCachedTokens.length > 0;
    let status = 'ready';
    if (running || this.refreshPromise) status = 'scanning';
    else if (stale && tokens.length) status = 'stale';
    else if (stale) status = 'error';
    else if (!tokens.length && !wallets.length) status = 'empty';
    else if (partial) status = 'partial';

    const warnings = uniqueStrings([
      staleCachedTokens.length
        ? `${staleCachedTokens.length} 个 CA 的最新重扫失败，正在继续显示上次有效 Holder 结果`
        : '',
      failedScans ? `${failedScans} 个 CA 分析失败且没有可用 Holder 缓存，可稍后重试` : '',
      failedHolderWallets ? `${failedHolderWallets} 个候选地址的 DeBot 收益分析失败，可重扫补全` : '',
      tokens.length && winners.every((winner) => winner.qualificationStatus.includes('pending'))
        ? '手工提交的金狗正在补全链上倍数、流动性和有效地址数据'
        : ''
    ]);

    return {
      ok: !stale,
      chain: this.chainId,
      status,
      mode: 'manual-only',
      discoveryEnabled: false,
      filters: {
        ...appliedFilters,
        minEntryUsd: minimumEntryUsd,
        significantProfitRate: this.config.significantProfitRate,
        smartBaseMultiple: this.config.smartBaseMultiple,
        strictMultiple: this.config.strictMultiple,
        repeatMinHits: this.config.repeatMinHits,
        lowFrequencyReasonThreshold: this.config.lowFrequencyReasonThreshold,
        ...(filters.search || filters.q ? { search: String(filters.search || filters.q).trim() } : {}),
        ...(Array.isArray(filters.tags) && filters.tags.length ? { tags: normalizedTags(filters.tags) } : {}),
        ...(filters.status ? { status: String(filters.status).toLowerCase() } : {}),
        ...(filters.classification ? { classification: String(filters.classification).toLowerCase() } : {}),
        ...(filters.monitorTier ? { monitorTier: String(filters.monitorTier).toLowerCase() } : {})
      },
      wallets,
      winners,
      jobs,
      updatedAt: lastSuccess,
      stale,
      warnings,
      partial
    };
  }

  getWallet(address) {
    const normalized = this.normalizeAddress(address);
    if (!this.isValidAddress(normalized)) throw new TypeError(`Invalid ${this.chainLabel} wallet address`);
    const summary = this.store
      .listWalletSummaries()
      .find((candidate) => this.normalizeAddress(candidate.address) === normalized);
    const annotation = this.store.getWalletAnnotation?.(normalized) || null;
    const buyFrequency = annotation
      ? (this.store.listWalletBuyFrequencyStats?.({ asOf: unixSeconds(this.now), address: normalized }) || [])[0] || null
      : null;
    const tokenRows = [];
    const tokens = new Map(
      this.store.listTokens().map((token) => [this.normalizeAddress(token.address), token])
    );
    for (const performance of Array.isArray(summary?.performances) ? summary.performances : []) {
      const tokenAddress = this.normalizeAddress(performance.tokenAddress);
      const token = tokens.get(tokenAddress) || {
        address: tokenAddress,
        symbol: performance.tokenSymbol || `${tokenAddress.slice(0, 6)}...${tokenAddress.slice(-4)}`,
        name: performance.tokenName || performance.tokenSymbol || 'Indexed token',
        logo: performance.tokenLogo || '',
        manual: performance.isSeedToken === true || performance.isSeed === true
      };
      const actions = tokens.has(tokenAddress)
        ? this.store
            .listActionsForToken(tokenAddress)
            .filter((action) => this.normalizeAddress(action.wallet) === normalized)
        : [];
      tokenRows.push({
        token,
        ...performance,
        tokenAddress,
        actions
      });
    }
    if (!summary && !tokenRows.length && !annotation) return null;
    return {
      ok: true,
      chain: this.chainId,
      wallet: mergeWalletAnnotation(summary, annotation, normalized, buyFrequency, {
        addressNormalizer: this.normalizeAddress,
        debotAddressRoot: this.debotAddressRoot
      }),
      tokens: tokenRows,
      updatedAt:
        isoFromUnknown(annotation?.updatedAt) ||
        (summary?.updatedAt ? isoFromUnknown(summary.updatedAt) : this.store.getMeta(this.lastSuccessMetadataKey))
    };
  }

  listWallets(filters = {}) {
    const appliedFilters = normalizedFilters(filters, {
      multiple: this.config.defaultWinnerMultiple,
      minLiquidityUsd: this.config.minLiquidityUsd,
      minWallets: this.config.minEffectiveWallets,
      tab: DEFAULT_FILTERS.tab
    });
    const summaries = new Map(
      this.store.listWalletSummaries().map((summary) => [this.normalizeAddress(summary.address), summary])
    );
    const annotations = new Map(
      (this.store.listWalletAnnotations?.() || []).map((annotation) => [this.normalizeAddress(annotation.address), annotation])
    );
    const buyFrequencies = new Map(
      (this.store.listWalletBuyFrequencyStats?.({ asOf: unixSeconds(this.now) }) || [])
        .map((stats) => [this.normalizeAddress(stats.address), stats])
    );
    const addresses = new Set([...summaries.keys(), ...annotations.keys()]);
    const wallets = [];
    for (const address of addresses) {
      const summary = summaries.get(address) || null;
      const wallet = mergeWalletAnnotation(
        summary,
        annotations.get(address) || null,
        address,
        buyFrequencies.get(address) || null,
        {
          addressNormalizer: this.normalizeAddress,
          debotAddressRoot: this.debotAddressRoot
        }
      );
      const keepConfirmedLibraryRecord = wallet.curated && appliedFilters.tab === 'all';
      if (summary && !keepConfirmedLibraryRecord && !walletMatchesTab(wallet, appliedFilters)) continue;
      if (!walletMatchesReview(wallet, filters)) continue;
      if (!walletMatchesCuration(wallet, filters)) continue;
      wallets.push(wallet);
    }
    return wallets.sort((left, right) => sortWallets(left, right, this.normalizeAddress));
  }

  updateWallet(address, patch = {}) {
    const normalized = this.normalizeAddress(address);
    if (!this.isValidAddress(normalized)) throw new TypeError(`Invalid ${this.chainLabel} wallet address`);
    if (!patch || typeof patch !== 'object' || Array.isArray(patch)) {
      throw new TypeError('Wallet update must be an object');
    }
    const existing = this.store.getWalletAnnotation?.(normalized) || walletAnnotationDefaults(normalized);
    const classificationValue = Object.hasOwn(patch, 'classificationOverride')
      ? patch.classificationOverride
      : Object.hasOwn(patch, 'classification')
        ? patch.classification
        : existing.classificationOverride;
    const classificationOverride = classificationValue === null || classificationValue === ''
      ? null
      : String(classificationValue).toLowerCase();
    if (classificationOverride && !WALLET_CLASSIFICATIONS.has(classificationOverride)) {
      throw new TypeError('Unsupported wallet classification override');
    }
    const status = Object.hasOwn(patch, 'status') ? String(patch.status || '').toLowerCase() : existing.status;
    if (!WALLET_STATUSES.has(status)) throw new TypeError('Unsupported wallet status');
    const monitorTier = Object.hasOwn(patch, 'monitorTier')
      ? String(patch.monitorTier || '').toLowerCase()
      : normalizeWalletMonitorTier(existing.monitorTier);
    if (!WALLET_MONITOR_TIERS.has(monitorTier)) throw new TypeError('Unsupported wallet monitor tier');
    const monitorRules = Object.hasOwn(patch, 'monitorRules')
      ? applyWalletMonitorRulesPatch(existing.monitorRules, patch.monitorRules)
      : normalizeWalletMonitorRules(existing.monitorRules);
    if (Object.hasOwn(patch, 'tags') && !Array.isArray(patch.tags)) {
      throw new TypeError('Wallet tags must be an array');
    }
    const now = unixSeconds(this.now);
    this.store.upsertWalletAnnotation({
      ...existing,
      address: normalized,
      alias: Object.hasOwn(patch, 'alias') ? String(patch.alias ?? '').trim() : existing.alias,
      note: Object.hasOwn(patch, 'note') ? String(patch.note ?? '').trim() : existing.note,
      tags: Object.hasOwn(patch, 'tags') ? normalizedTags(patch.tags) : existing.tags,
      status,
      classificationOverride,
      monitorTier,
      monitorRules,
      createdAt: existing.createdAt || now,
      updatedAt: now
    });
    return this.getWallet(normalized) || {
      ok: true,
      wallet: mergeWalletAnnotation(null, this.store.getWalletAnnotation(normalized), normalized),
      tokens: [],
      updatedAt: nowIso(this.now)
    };
  }

  batchUpdateWallets(lines) {
    const sourceLines = typeof lines === 'string'
      ? lines.split(/\r\n?|\n/)
      : Array.isArray(lines)
        ? lines
        : null;
    if (!sourceLines) throw new TypeError('Wallet batch lines must be a string or an array');
    if (sourceLines.length > MAX_WALLET_BATCH_LINES) {
      throw new TypeError(`Wallet batch cannot exceed ${MAX_WALLET_BATCH_LINES} lines`);
    }

    const response = {
      ok: true,
      total: 0,
      processed: 0,
      valid: 0,
      created: 0,
      restored: 0,
      updated: 0,
      duplicate: 0,
      invalid: 0,
      ignoredBlank: 0,
      counts: {
        created: 0,
        restored: 0,
        updated: 0,
        duplicate: 0,
        invalid: 0
      },
      results: []
    };
    const seen = new Map();

    for (let index = 0; index < sourceLines.length; index += 1) {
      const lineNumber = index + 1;
      const sourceLine = sourceLines[index];
      if (typeof sourceLine !== 'string') {
        response.total += 1;
        response.invalid += 1;
        response.results.push({
          line: lineNumber,
          input: String(sourceLine).slice(0, 200),
          result: 'invalid',
          reason: 'Line must be a string'
        });
        continue;
      }
      const trimmed = sourceLine.trim();
      if (!trimmed) {
        response.ignoredBlank += 1;
        continue;
      }

      response.total += 1;
      const commaIndex = trimmed.indexOf(',');
      const rawAddress = (commaIndex >= 0 ? trimmed.slice(0, commaIndex) : trimmed).trim();
      const noteProvided = commaIndex >= 0;
      const note = noteProvided ? trimmed.slice(commaIndex + 1).trim() : undefined;
      const address = this.normalizeAddress(rawAddress);
      if (!this.isValidAddress(address)) {
        response.invalid += 1;
        response.results.push({
          line: lineNumber,
          input: trimmed.slice(0, 200),
          result: 'invalid',
          reason: `Invalid ${this.chainLabel} wallet address`
        });
        continue;
      }
      if (noteProvided && note.length > 4000) {
        response.invalid += 1;
        response.results.push({
          line: lineNumber,
          address,
          result: 'invalid',
          reason: 'Wallet note is too long'
        });
        continue;
      }
      response.valid += 1;
      if (seen.has(address)) {
        response.duplicate += 1;
        response.results.push({
          line: lineNumber,
          address,
          result: 'duplicate',
          reason: 'Duplicate address in this batch',
          duplicateOf: seen.get(address)
        });
        continue;
      }
      seen.set(address, lineNumber);

      const existing = this.store.getWalletAnnotation?.(address) || null;
      let result;
      let update;
      if (!existing) {
        result = 'created';
        update = { status: 'active', ...(noteProvided ? { note } : {}) };
      } else if (existing.status === 'excluded') {
        result = 'restored';
        update = { status: 'active', ...(noteProvided ? { note } : {}) };
      } else if (noteProvided && note !== existing.note) {
        result = 'updated';
        update = { note };
      } else {
        response.duplicate += 1;
        response.results.push({
          line: lineNumber,
          address,
          result: 'duplicate',
          reason: 'Wallet already exists with the same active state and note'
        });
        continue;
      }

      const updated = this.updateWallet(address, update);
      response[result] += 1;
      response.processed += 1;
      response.results.push({
        line: lineNumber,
        address,
        result,
        walletStatus: updated.wallet.status,
        note: updated.wallet.note
      });
    }

    for (const outcome of ['created', 'restored', 'updated', 'duplicate', 'invalid']) {
      response.counts[outcome] = response[outcome];
    }
    return response;
  }

  importWalletBatch(lines) {
    return this.batchUpdateWallets(lines);
  }

  deleteWallet(address) {
    const normalized = this.normalizeAddress(address);
    if (!this.isValidAddress(normalized)) throw new TypeError(`Invalid ${this.chainLabel} wallet address`);
    const previous = this.store.getWalletAnnotation?.(normalized) || null;
    const result = this.updateWallet(normalized, { status: 'excluded' });
    return {
      ok: true,
      deleted: true,
      excluded: true,
      alreadyExcluded: previous?.status === 'excluded',
      wallet: result.wallet
    };
  }

  addManualWinner(address, { minEntryUsd } = {}) {
    const normalized = this.normalizeAddress(address);
    if (!this.isValidAddress(normalized)) throw new TypeError(`Invalid ${this.chainLabel} token address`);
    if (minEntryUsd !== undefined) normalizedScanMinimumEntryUsd(minEntryUsd, this.config.minEntryUsd);
    const existing = this.store.getToken(normalized);
    const addedAt = nowIso(this.now);
    const token = {
      ...(existing || {}),
      chain: this.chainId,
      address: normalized,
      symbol: existing?.symbol || `${normalized.slice(0, 6)}...${normalized.slice(-4)}`,
      name: existing?.name || 'Manual token',
      logo: existing?.logo || '',
      manual: true,
      discoverySource: existing?.discoverySource === 'debot' ? 'manual,debot' : 'manual',
      addedAt: existing?.addedAt || addedAt,
      scanStatus: existing?.scanStatus || 'pending',
      updatedAt: unixSeconds(this.now)
    };
    this.store.upsertToken(token);
    const duplicate = Boolean(existing?.manual);
    const existingJob = this.store.listJobs().find((candidate) => candidate.id === `scan:${normalized}`) || null;
    const alreadyRunning = this.queuedAddresses.has(normalized) || this.activeScans.has(normalized);
    const retryableDuplicate = duplicate && (
      existing?.scanStatus === 'failed' ||
      hasStaleHolderCache(existing) ||
      existingJob?.cachedResult === true
    );
    const shouldQueue = !duplicate || retryableDuplicate;
    const job = shouldQueue
      ? this.queueToken(token, {
          manual: true,
          force: retryableDuplicate || existing?.scanStatus === 'complete',
          minEntryUsd
        })
      : existingJob;
    const accepted = shouldQueue && !alreadyRunning && this.queuedAddresses.has(normalized);
    const filters = normalizedFilters({}, {
      multiple: this.config.defaultWinnerMultiple,
      minLiquidityUsd: this.config.minLiquidityUsd,
      minWallets: this.config.minEffectiveWallets,
      tab: DEFAULT_FILTERS.tab
    });
    return {
      ok: true,
      duplicate,
      accepted,
      alreadyRunning,
      requeued: duplicate && accepted,
      winner: qualifyToken(token, filters),
      job
    };
  }

  rescanManualWinner(address, { minEntryUsd } = {}) {
    const normalized = this.normalizeAddress(address);
    if (!this.isValidAddress(normalized)) throw new TypeError(`Invalid ${this.chainLabel} token address`);
    const token = this.store.getToken(normalized);
    if (!token || token.manual !== true) return null;

    const alreadyRunning = this.queuedAddresses.has(normalized) || this.activeScans.has(normalized);
    const job = this.queueToken(token, { force: true, manual: true, minEntryUsd });
    const minimumEntryUsd = finiteNumber(job?.minimumEntryUsd, token.holderAnalysis?.minimumEntryUsd, this.config.minEntryUsd);
    return {
      ok: true,
      accepted: !alreadyRunning,
      alreadyRunning,
      status: alreadyRunning ? 'already_running' : 'queued',
      tokenAddress: normalized,
      minimumEntryUsd,
      job,
      updatedAt: nowIso(this.now)
    };
  }

  async waitForIdle() {
    if (
      !this.refreshPromise &&
      this.queue.length === 0 &&
      this.activeScans.size === 0
    ) return;
    await new Promise((resolve) => this.idleWaiters.add(resolve));
  }

  #notifyIdle() {
    if (
      this.refreshPromise ||
      this.queue.length ||
      this.activeScans.size
    ) return;
    for (const resolve of this.idleWaiters) resolve();
    this.idleWaiters.clear();
  }

  close() {
    this.closed = true;
    this.queue.length = 0;
    this.queuedAddresses.clear();
    this.#notifyIdle();
  }
}

export function createRobinhoodService(options) {
  return new RobinhoodService(options);
}
