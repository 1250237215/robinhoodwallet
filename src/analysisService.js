import { buildCoinProfile } from './profileBuilder.js';
import { fetchMarketSnapshot, fetchMarketSnapshots } from './marketClient.js';
import { resolveTokenSources } from './sourceResolver.js';
import { applyDeepSeekEnhancement, getNarrativeMetadata } from './deepseekNarrative.js';

function normalizeAddress(value) {
  return String(value || '').toLowerCase();
}

function normalizeHandle(value) {
  const raw = String(value || '').trim().replace(/^@/, '');
  return /^[A-Za-z0-9_]{2,20}$/.test(raw) ? `@${raw}` : null;
}

function summarizeAnalysis(analysis) {
  return {
    narrativeLabel: analysis.narrative.label,
    narrativeCategory: analysis.narrative.category,
    devStatus: analysis.dev.identityStatus,
    devHandle: analysis.dev.publicHandle
  };
}

function hasLlmNarrative(analysis) {
  return Boolean(analysis?.narrative?.llmProvider);
}

function leaksSearchFailure(analysis) {
  return /communityContext\s*搜索失败|community search failed|搜索失败，只能使用 factPack|只(?:能|使用) factPack|缺少 X\/scanner 实时语境|search failed/i.test(
    JSON.stringify(analysis?.narrative || {})
  );
}

function emptyPartialDetails(profile) {
  return {
    ...profile,
    narrative: {
      ...profile.narrative,
      origin: '',
      thesis: '正在分析，叙事和 dev 背景哪部分先完成会先显示。',
      details: []
    }
  };
}

function initialAnalysisStatus({ tweetAttitude = 'skipped' } = {}) {
  const status = {
    narrative: 'loading',
    dev: 'loading',
    tweetAttitude,
    complete: false
  };
  status.complete = isAnalysisComplete(status);
  return status;
}

function isAnalysisComplete(status = {}) {
  return ['narrative', 'dev', 'tweetAttitude'].every((part) => status[part] !== 'loading');
}

function markPartStatus(status = {}, part, value) {
  const next = {
    narrative: status.narrative || 'loading',
    dev: status.dev || 'loading',
    tweetAttitude: status.tweetAttitude || 'skipped',
    complete: false,
    ...status,
    [part]: value
  };
  next.complete = isAnalysisComplete(next);
  return next;
}

function skippedTweetAttitude(summary = '没有确认到 dev X 账号，无法抓取最近推文或回复判断态度。') {
  return {
    supportLevel: '未确认',
    summary,
    items: [],
    updatedAt: new Date().toISOString()
  };
}

export class TokenAnalysisService {
  constructor(options = {}) {
    this.ttlMs = options.ttlMs ?? 120000;
    this.fetchMarketSnapshot = options.fetchMarketSnapshot || fetchMarketSnapshot;
    this.fetchMarketSnapshots = options.fetchMarketSnapshots || fetchMarketSnapshots;
    this.resolveTokenSources = options.resolveTokenSources || resolveTokenSources;
    this.buildCoinProfile = options.buildCoinProfile || buildCoinProfile;
    this.narrativeGenerator = options.narrativeGenerator || null;
    this.devTweetAttitudeAnalyzer = options.devTweetAttitudeAnalyzer || null;
    this.logger = options.logger || console;
    this.seenAddresses = new Set();
    this.latestRows = new Map();
    this.cache = new Map();
    this.pending = new Map();
    this.marketCache = new Map();
    this.partialRuns = new Map();
  }

  async enrichRowsWithRealtime(rows) {
    const snapshots = await this.fetchMarketSnapshots(rows.map((row) => row.address));
    return rows.map((row) => {
      const address = normalizeAddress(row.address);
      const market = snapshots.get(address);
      if (!market) {
        return row;
      }
      this.marketCache.set(address, market);
      return {
        ...row,
        priceUsd: market.priceUsd ?? row.priceUsd,
        marketCapUsd: market.marketCapUsd ?? market.fdvUsd ?? row.marketCapUsd,
        liquidityUsd: market.liquidityUsd ?? row.liquidityUsd,
        volume24h: market.volume24h ?? row.volume24h,
        priceChange24h: market.priceChange24h ?? row.priceChange24h,
        logo: market.imageUrl || row.logo
      };
    });
  }

  decorateRows(rows) {
    return rows.map((row) => {
      const address = normalizeAddress(row.address);
      const isNew = address ? !this.seenAddresses.has(address) : false;
      if (address) {
        this.seenAddresses.add(address);
        this.latestRows.set(address, row);
      }

      const cached = this.peek(address);
      return {
        ...row,
        isNew,
        analysisSummary: cached ? summarizeAnalysis(cached) : null
      };
    });
  }

  analysisSummaryFor(address) {
    const cached = this.peek(address);
    return cached ? summarizeAnalysis(cached) : null;
  }

  prefetchRows(rows) {
    for (const row of rows) {
      const address = normalizeAddress(row.address);
      if (row.isNew === false) {
        continue;
      }
      if (!address || this.peek(address) || this.pending.has(address)) {
        continue;
      }
      this.getAnalysis(address, row, { priority: 'background' }).catch(() => {});
    }
  }

  hasRow(address) {
    return this.latestRows.has(normalizeAddress(address));
  }

  peek(address) {
    const cached = this.cache.get(normalizeAddress(address));
    if (!cached) {
      return null;
    }
    if (Date.now() - cached.cachedAt > this.ttlMs) {
      this.cache.delete(normalizeAddress(address));
      return null;
    }
    return cached.data;
  }

  async getAnalysis(address, rowOverride = null, options = {}) {
    const normalized = normalizeAddress(address);
    const previousCached = this.peek(normalized);
    const cached = options.force ? null : previousCached;
    if (cached) {
      return cached;
    }

    if (options.force) {
      this.cache.delete(normalized);
    }

    const priority = options.priority || 'foreground';
    const pending = this.pending.get(normalized);
    if (!options.force && pending) {
      if (priority !== 'foreground' || pending.priority === 'foreground') {
        return pending.job;
      }
    }

    const row = rowOverride || this.latestRows.get(normalized);
    if (!row) {
      throw new Error(`No signal row is available for ${address}`);
    }

    const pendingRecord = {
      priority,
      job: null
    };
    const job = this.buildAnalysis(normalized, row, { priority })
      .then((result) => {
        const selected = this.selectAnalysisResult({
          force: options.force,
          previous: previousCached,
          result
        });
        if (this.pending.get(normalized) === pendingRecord && !selected?.analysisStatus) {
          this.cache.set(normalized, {
            cachedAt: Date.now(),
            data: selected
          });
        }
        return selected;
      })
      .finally(() => {
        if (this.pending.get(normalized) === pendingRecord) {
          this.pending.delete(normalized);
        }
      });

    pendingRecord.job = job;
    this.pending.set(normalized, pendingRecord);
    return job;
  }

  selectAnalysisResult({ force = false, previous = null, result }) {
    if (force && hasLlmNarrative(previous) && !leaksSearchFailure(previous) && !hasLlmNarrative(result)) {
      this.logger?.warn?.(
        `Keeping cached ${previous.narrative.llmProvider} narrative because refreshed analysis degraded to rule fallback.`
      );
      return previous;
    }
    return result;
  }

  async buildAnalysis(address, row, options = {}) {
    let market = this.marketCache.get(address) || {
      address,
      pairCount: 0,
      websites: [],
      socials: []
    };

    try {
      market = await this.fetchMarketSnapshot(address);
      this.marketCache.set(address, market);
    } catch (error) {
      market = {
        ...market,
        error: error instanceof Error ? error.message : String(error)
      };
    }

    const sources = await this.resolveTokenSources(row, market);
    const baseProfile = this.buildCoinProfile({ row, market, sources });
    if (this.supportsPartialAnalysis()) {
      const tweetAttitudeHandle = this.devTweetAttitudeHandle(baseProfile, sources);
      const tweetAttitudeEnabled = Boolean(this.devTweetAttitudeAnalyzer);
      const result = {
        ...emptyPartialDetails(baseProfile),
        devTweetAttitude: tweetAttitudeEnabled && !tweetAttitudeHandle ? skippedTweetAttitude() : undefined,
        analysisStatus: initialAnalysisStatus({
          tweetAttitude: tweetAttitudeEnabled && tweetAttitudeHandle ? 'loading' : 'skipped'
        }),
        updatedAt: new Date().toISOString()
      };
      this.cacheAnalysis(address, result);
      this.startPartialAnalysis({
        address,
        row,
        market,
        sources,
        profile: result,
        priority: options.priority || 'foreground'
      });
      return result;
    }

    const profile = await this.enhanceProfile({
      row,
      market,
      sources,
      profile: baseProfile,
      priority: options.priority || 'foreground'
    });
    const profileWithTweetAttitude = await this.enhanceTweetAttitude({
      row,
      sources,
      profile
    });
    const result = {
      ...profileWithTweetAttitude,
      updatedAt: new Date().toISOString()
    };

    return result;
  }

  supportsPartialAnalysis() {
    return typeof this.narrativeGenerator?.generatePart === 'function';
  }

  devTweetAttitudeHandle(profile, sources = {}) {
    return normalizeHandle(
      profile?.dev?.publicHandle ||
        profile?.dev?.feeRecipientHandle ||
        sources.bankr?.feeRecipientHandle ||
        sources.virtuals?.creatorTwitterHandle ||
        sources.virtuals?.projectTwitterHandle
    );
  }

  cacheAnalysis(address, data) {
    this.cache.set(normalizeAddress(address), {
      cachedAt: Date.now(),
      data
    });
  }

  startPartialAnalysis({ address, row, market, sources, profile, priority = 'foreground' }) {
    const normalized = normalizeAddress(address);
    const runId = Symbol(normalized);
    this.partialRuns.set(normalized, runId);

    for (const part of ['narrative', 'dev']) {
      this.runPartialAnalysisPart({
        address: normalized,
        row,
        market,
        sources,
        profile,
        priority,
        part,
        runId
      });
    }

    this.runTweetAttitudePart({
      address: normalized,
      row,
      sources,
      profile,
      runId
    });
  }

  runTweetAttitudePart({ address, row, sources, profile, runId }) {
    const normalized = normalizeAddress(address);
    if (!this.devTweetAttitudeAnalyzer) {
      return;
    }

    if (!this.devTweetAttitudeHandle(profile, sources)) {
      this.applyTweetAttitude({
        address: normalized,
        tweetAttitude: skippedTweetAttitude(),
        status: 'skipped',
        runId
      });
      return;
    }

    this.devTweetAttitudeAnalyzer
      .analyze({
        row,
        dev: profile.dev,
        sources
      })
      .then((tweetAttitude) => {
        this.applyTweetAttitude({
          address: normalized,
          tweetAttitude,
          status: 'ready',
          runId
        });
      })
      .catch((error) => {
        this.warnTweetAttitudeFailure(row, error);
        this.applyTweetAttitude({
          address: normalized,
          tweetAttitude: skippedTweetAttitude('dev 最近推文或回复抓取失败，暂时无法判断他是否支持这个 token。'),
          status: 'failed',
          runId
        });
      });
  }

  runPartialAnalysisPart({ address, row, market, sources, profile, priority, part, runId }) {
    this.narrativeGenerator
      .generatePart({
        row,
        market,
        sources,
        profile,
        priority,
        part
      })
      .then((enhancement) => {
        this.applyPartialEnhancement({
          address,
          row,
          enhancement,
          part,
          runId
        });
      })
      .catch((error) => {
        this.markPartialFailure({
          address,
          row,
          part,
          runId,
          error
        });
      });
  }

  applyPartialEnhancement({ address, row, enhancement, part, runId }) {
    const normalized = normalizeAddress(address);
    if (this.partialRuns.get(normalized) !== runId) {
      return;
    }

    const current = this.peek(normalized);
    if (!current) {
      return;
    }

    const metadata = getNarrativeMetadata(enhancement);
    const updated = applyDeepSeekEnhancement(current, enhancement, {
      provider: metadata.provider || this.narrativeGenerator.provider || 'deepseek',
      model: metadata.model || this.narrativeGenerator.model,
      fallbackFrom: metadata.fallbackFrom,
      updatedAt: new Date().toISOString()
    });

    const result = {
      ...updated,
      analysisStatus: markPartStatus(current.analysisStatus, part, 'ready'),
      updatedAt: new Date().toISOString()
    };
    this.cacheAnalysis(normalized, result);
  }

  markPartialFailure({ address, row, part, runId, error }) {
    const normalized = normalizeAddress(address);
    if (this.partialRuns.get(normalized) !== runId) {
      return;
    }

    this.warnNarrativeFailure(row, error);
    const current = this.peek(normalized);
    if (!current) {
      return;
    }

    const result = {
      ...current,
      analysisStatus: markPartStatus(current.analysisStatus, part, 'failed'),
      updatedAt: new Date().toISOString()
    };
    this.cacheAnalysis(normalized, result);
  }

  applyTweetAttitude({ address, tweetAttitude, status = 'ready', runId }) {
    const normalized = normalizeAddress(address);
    if (this.partialRuns.get(normalized) !== runId) {
      return;
    }

    const current = this.peek(normalized);
    if (!current) {
      return;
    }

    const result = {
      ...current,
      devTweetAttitude: tweetAttitude || skippedTweetAttitude(),
      analysisStatus: markPartStatus(current.analysisStatus, 'tweetAttitude', status),
      updatedAt: new Date().toISOString()
    };
    this.cacheAnalysis(normalized, result);
  }

  async enhanceTweetAttitude({ row, sources, profile }) {
    if (!this.devTweetAttitudeAnalyzer) {
      return profile;
    }
    if (!this.devTweetAttitudeHandle(profile, sources)) {
      return {
        ...profile,
        devTweetAttitude: skippedTweetAttitude()
      };
    }

    try {
      const devTweetAttitude = await this.devTweetAttitudeAnalyzer.analyze({
        row,
        dev: profile.dev,
        sources
      });
      return {
        ...profile,
        devTweetAttitude
      };
    } catch (error) {
      this.warnTweetAttitudeFailure(row, error);
      return {
        ...profile,
        devTweetAttitude: skippedTweetAttitude('dev 最近推文或回复抓取失败，暂时无法判断他是否支持这个 token。')
      };
    }
  }

  async enhanceProfile({ row, market, sources, profile, priority = 'foreground' }) {
    if (!this.narrativeGenerator) {
      return profile;
    }

    try {
      const enhancement = await this.narrativeGenerator.generate({
        row,
        market,
        sources,
        profile,
        priority
      });
      const metadata = getNarrativeMetadata(enhancement);
      return applyDeepSeekEnhancement(profile, enhancement, {
        provider: metadata.provider || this.narrativeGenerator.provider || 'deepseek',
        model: metadata.model || this.narrativeGenerator.model,
        fallbackFrom: metadata.fallbackFrom,
        updatedAt: new Date().toISOString()
      });
    } catch (error) {
      this.warnNarrativeFailure(row, error);
      return profile;
    }
  }

  warnNarrativeFailure(row, error) {
    const message = error instanceof Error ? error.message : String(error || 'unknown error');
    const safeMessage = message.replace(/sk-[A-Za-z0-9_-]+/g, 'sk-***');
    this.logger?.warn?.(
      `Narrative generation failed for ${row?.symbol || 'unknown'} ${normalizeAddress(row?.address)}: ${safeMessage}`
    );
  }

  warnTweetAttitudeFailure(row, error) {
    const message = error instanceof Error ? error.message : String(error || 'unknown error');
    const safeMessage = message.replace(/sk-[A-Za-z0-9_-]+/g, 'sk-***');
    this.logger?.warn?.(
      `Dev tweet attitude failed for ${row?.symbol || 'unknown'} ${normalizeAddress(row?.address)}: ${safeMessage}`
    );
  }
}
