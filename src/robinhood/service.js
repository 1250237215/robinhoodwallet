import { buildWalletSummaries, discoveryMultiple } from './qualification.js';
import { DEFAULT_SMART_SCORE_WEIGHTS } from './config.js';
import {
  applyWalletMonitorRulesPatch,
  defaultWalletMonitorRules,
  normalizeWalletMonitorRules
} from './monitorRules.js';
import { normalizeWalletMonitorTier, WALLET_MONITOR_TIERS } from './tiering.js';

const ADDRESS_PATTERN = /^0x[0-9a-f]{40}$/;
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

function mergeWalletAnnotation(summary, annotation, address) {
  const normalized = normalizeAddress(address || summary?.address || annotation?.address);
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
    debotUrl: `https://debot.ai/address/robinhood/${normalized}`,
    curation
  };
}

function walletPerformanceProfit(performance) {
  const explicit = finiteNumber(performance?.totalProfitUsd);
  if (explicit !== null) return explicit;
  return (finiteNumber(performance?.realizedProfitUsd) ?? 0) +
    (finiteNumber(performance?.unrealizedProfitUsd) ?? 0);
}

function attachCandidateReviewMetadata(summaries) {
  const byToken = new Map();
  for (const summary of summaries) {
    summary.debotUrl = `https://debot.ai/address/robinhood/${normalizeAddress(summary.address)}`;
    for (const performance of Array.isArray(summary.performances) ? summary.performances : []) {
      const tokenAddress = normalizeAddress(performance.tokenAddress);
      if (!ADDRESS_PATTERN.test(tokenAddress)) continue;
      if (!byToken.has(tokenAddress)) byToken.set(tokenAddress, []);
      byToken.get(tokenAddress).push({ summary, performance });
    }
  }
  for (const rows of byToken.values()) {
    rows.sort((left, right) =>
      walletPerformanceProfit(right.performance) - walletPerformanceProfit(left.performance) ||
      (finiteNumber(right.performance.bestMultiple, right.performance.totalMultiple) ?? 0) -
        (finiteNumber(left.performance.bestMultiple, left.performance.totalMultiple) ?? 0) ||
      normalizeAddress(left.summary.address).localeCompare(normalizeAddress(right.summary.address))
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
    summary.bestProfitTokenAddress = normalizeAddress(best.tokenAddress);
    summary.bestProfitTokenSymbol = symbol;
    summary.suggestedAlias = `${symbol} 盈利榜第 ${profitRank} 名`;
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

function sortWallets(a, b) {
  return (
    (finiteNumber(b.score) ?? 0) - (finiteNumber(a.score) ?? 0) ||
    walletBestMultiple(b) - walletBestMultiple(a) ||
    normalizeAddress(a.address).localeCompare(normalizeAddress(b.address))
  );
}

function sortWinners(a, b) {
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
    normalizeAddress(a.address).localeCompare(normalizeAddress(b.address))
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
    const candidate = isoFromUnknown(token.scannedAt || token.updatedAt || token.discoveredAt);
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
    now = Date.now
  }) {
    if (!store?.upsertToken || !store?.listTokens) throw new TypeError('A Robinhood store is required');
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
    const address = normalizeAddress(token?.address);
    if (!isRobinhoodAddress(address)) throw new TypeError('Invalid Robinhood token address');
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
      const address = normalizeAddress(token.address);
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
      const cachedActions = this.store.listActionsForToken(token.address);
      const canSeedPartial = !scanComplete && cachedActions.length === 0;
      const actionsReplaced = Array.isArray(result?.actions) && (scanComplete || canSeedPartial);
      const holderAnalysisUpdated = Boolean(result?.holderAnalysis || result?.tokenPatch?.holderAnalysis);
      if (actionsReplaced) {
        this.store.replaceTokenActions(token.address, result.actions);
      }

      const completedAt = nowIso(this.now);
      const latest = this.store.getToken(token.address) || token;
      const tokenPatch = result?.tokenPatch || result?.token || result?.winner || {};
      this.store.upsertToken({
        ...latest,
        ...tokenPatch,
        ...(result?.qualification || {}),
        address: token.address,
        pool: result?.pool || tokenPatch.pool || latest.pool || null,
        qualification: result?.qualification || latest.qualification || null,
        scan: result?.scan || null,
        scanStatus: scanComplete ? 'complete' : 'partial',
        scanError: null,
        scannedAt: completedAt,
        updatedAt: unixSeconds(this.now)
      });
      if (actionsReplaced || holderAnalysisUpdated) this.#rebuildWalletSummaries();
      this.store.upsertJob({
        ...job,
        status: 'complete',
        startedAt,
        completedAt,
        partial: !scanComplete,
        result: result?.scan || null,
        updatedAt: unixSeconds(this.now)
      });
    } catch (error) {
      const failedAt = nowIso(this.now);
      const message = errorMessage(error);
      const latest = this.store.getToken(token.address) || token;
      this.store.upsertToken({
        ...latest,
        address: token.address,
        scanStatus: 'failed',
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
        updatedAt: unixSeconds(this.now)
      });
    }
  }

  #rebuildWalletSummaries() {
    const tokens = this.store.listTokens().filter((token) => token.manual === true);
    const actionsByToken = new Map(
      tokens.map((token) => [normalizeAddress(token.address), this.store.listActionsForToken(token.address)])
    );
    const summaries = buildWalletSummaries({
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
      lowFrequencyReasonThreshold: this.config.lowFrequencyReasonThreshold
    });
    this.store.replaceWalletSummaries(attachCandidateReviewMetadata(summaries));
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
    const winners = tokens.map((token) => qualifyToken(token, appliedFilters)).sort(sortWinners);
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
    const lastError = '';
    const running = jobs.some((job) => job.status === 'queued' || job.status === 'running');
    const pending = winners.some((winner) => ['pending', 'manual_pending'].includes(winner.qualificationStatus));
    const failedScans = jobs.filter((job) => job.type === 'token_scan' && job.status === 'failed').length;
    const failedHolderWallets = tokens.reduce(
      (sum, token) => sum + Math.max(0, finiteNumber(token.holderAnalysis?.failedWallets) ?? 0),
      0
    );
    const partial = pending || failedScans > 0 ||
      winners.some((winner) => winner.scanStatus === 'partial');
    const stale = Boolean(lastError);
    let status = 'ready';
    if (running || this.refreshPromise) status = 'scanning';
    else if (stale && tokens.length) status = 'stale';
    else if (stale) status = 'error';
    else if (!tokens.length && !wallets.length) status = 'empty';
    else if (partial) status = 'partial';

    const warnings = uniqueStrings([
      failedScans ? `${failedScans} 个代币的链上扫描失败，可稍后重试` : '',
      failedHolderWallets ? `${failedHolderWallets} 个候选地址的 DeBot 收益分析失败，可重扫补全` : '',
      tokens.length && winners.every((winner) => winner.qualificationStatus.includes('pending'))
        ? '手工提交的金狗正在补全链上倍数、流动性和有效地址数据'
        : ''
    ]);

    return {
      ok: !stale,
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
    const normalized = normalizeAddress(address);
    if (!isRobinhoodAddress(normalized)) throw new TypeError('Invalid Robinhood wallet address');
    const summary = this.store
      .listWalletSummaries()
      .find((candidate) => normalizeAddress(candidate.address) === normalized);
    const annotation = this.store.getWalletAnnotation?.(normalized) || null;
    const tokenRows = [];
    const tokens = new Map(
      this.store.listTokens().map((token) => [normalizeAddress(token.address), token])
    );
    for (const performance of Array.isArray(summary?.performances) ? summary.performances : []) {
      const tokenAddress = normalizeAddress(performance.tokenAddress);
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
            .filter((action) => normalizeAddress(action.wallet) === normalized)
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
      wallet: mergeWalletAnnotation(summary, annotation, normalized),
      tokens: tokenRows,
      updatedAt:
        isoFromUnknown(annotation?.updatedAt) ||
        (summary?.updatedAt ? isoFromUnknown(summary.updatedAt) : this.store.getMeta('robinhood:last_success_at'))
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
      this.store.listWalletSummaries().map((summary) => [normalizeAddress(summary.address), summary])
    );
    const annotations = new Map(
      (this.store.listWalletAnnotations?.() || []).map((annotation) => [normalizeAddress(annotation.address), annotation])
    );
    const addresses = new Set([...summaries.keys(), ...annotations.keys()]);
    const wallets = [];
    for (const address of addresses) {
      const summary = summaries.get(address) || null;
      const wallet = mergeWalletAnnotation(summary, annotations.get(address) || null, address);
      const keepConfirmedLibraryRecord = wallet.curated && appliedFilters.tab === 'all';
      if (summary && !keepConfirmedLibraryRecord && !walletMatchesTab(wallet, appliedFilters)) continue;
      if (!walletMatchesReview(wallet, filters)) continue;
      if (!walletMatchesCuration(wallet, filters)) continue;
      wallets.push(wallet);
    }
    return wallets.sort(sortWallets);
  }

  updateWallet(address, patch = {}) {
    const normalized = normalizeAddress(address);
    if (!isRobinhoodAddress(normalized)) throw new TypeError('Invalid Robinhood wallet address');
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
      const address = normalizeAddress(rawAddress);
      if (!isRobinhoodAddress(address)) {
        response.invalid += 1;
        response.results.push({
          line: lineNumber,
          input: trimmed.slice(0, 200),
          result: 'invalid',
          reason: 'Invalid Robinhood wallet address'
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
    const normalized = normalizeAddress(address);
    if (!isRobinhoodAddress(normalized)) throw new TypeError('Invalid Robinhood wallet address');
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
    const normalized = normalizeAddress(address);
    if (!isRobinhoodAddress(normalized)) throw new TypeError('Invalid Robinhood token address');
    if (minEntryUsd !== undefined) normalizedScanMinimumEntryUsd(minEntryUsd, this.config.minEntryUsd);
    const existing = this.store.getToken(normalized);
    const addedAt = nowIso(this.now);
    const token = {
      ...(existing || {}),
      chain: 'robinhood',
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
    const job = duplicate
      ? existingJob
      : this.queueToken(token, { manual: true, force: existing?.scanStatus === 'complete', minEntryUsd });
    const filters = normalizedFilters({}, {
      multiple: this.config.defaultWinnerMultiple,
      minLiquidityUsd: this.config.minLiquidityUsd,
      minWallets: this.config.minEffectiveWallets,
      tab: DEFAULT_FILTERS.tab
    });
    return { ok: true, duplicate, winner: qualifyToken(token, filters), job };
  }

  rescanManualWinner(address, { minEntryUsd } = {}) {
    const normalized = normalizeAddress(address);
    if (!isRobinhoodAddress(normalized)) throw new TypeError('Invalid Robinhood token address');
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
