import test from 'node:test';
import assert from 'node:assert/strict';

import { createRobinhoodService } from '../src/robinhood/service.js';
import { createRobinhoodStore } from '../src/robinhood/store.js';

const tokenA = '0x1111111111111111111111111111111111111111';
const tokenB = '0x2222222222222222222222222222222222222222';
const tokenC = '0x3333333333333333333333333333333333333333';
const tokenLegacy = '0x4444444444444444444444444444444444444444';
const walletA = '0xaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa';
const walletB = '0xbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb';
const walletLegacy = '0xcccccccccccccccccccccccccccccccccccccccc';
const walletC = '0xdddddddddddddddddddddddddddddddddddddddd';

function createService({
  fetchHotTokens,
  debotClient,
  holderClient = null,
  scanToken,
  autoScanLimit = 2,
  scanConcurrency = 1,
  minEntryUsd = 0,
  significantProfitRate = 0.002,
  smartBaseMultiple = 5,
  strictMultiple = 10,
  repeatMinHits = 2,
  strongHolderRank = 30,
  smartScoreWeights,
  holderCandidateLimit = 100,
  holderFetchLimit = 150,
  holderProfitConcurrency = 6,
  now
} = {}) {
  const store = createRobinhoodStore(':memory:');
  const service = createRobinhoodService({
    store,
    debotClient: debotClient || { fetchHotTokens: fetchHotTokens || (async () => []) },
    holderClient,
    poolClient: { fetchPools: async () => [] },
    scanToken,
    scanConcurrency,
    now: now || (() => Date.parse('2026-07-10T12:00:00.000Z')),
    config: {
      defaultWinnerMultiple: 10,
      minLiquidityUsd: 50_000,
      minEffectiveWallets: 100,
      minEntryUsd,
      significantProfitRate,
      smartBaseMultiple,
      strictMultiple,
      repeatMinHits,
      strongHolderRank,
      ...(smartScoreWeights ? { smartScoreWeights } : {}),
      holderCandidateLimit,
      holderFetchLimit,
      holderProfitConcurrency,
      autoScanLimit,
      discoveryLimit: 50
    }
  });
  return { service, store };
}

function action({ tokenAddress = tokenA, wallet = walletA, txHash = '0xabc', logIndex = 0 } = {}) {
  return {
    tokenAddress,
    wallet,
    txHash,
    logIndex,
    transactionIndex: 0,
    side: 'buy',
    tokenAmount: 100,
    quoteAmount: 1,
    priceNative: 0.01,
    blockNumber: 1,
    blockTimestamp: 1,
    poolAddress: tokenB,
    attributionConfidence: 'high'
  };
}

test('start and refresh are manual-only and never call DeBot discovery', async (t) => {
  let fetches = 0;
  const { service, store } = createService({
    fetchHotTokens: async () => {
      fetches += 1;
      return [{ address: tokenA }];
    }
  });
  t.after(() => store.close());

  const started = await service.start();
  const refreshed = await service.refresh();
  const triggered = service.triggerRefresh();

  assert.equal(started.status, 'manual-only');
  assert.equal(refreshed.status, 'manual-only');
  assert.equal(triggered.accepted, false);
  assert.equal(fetches, 0);
  assert.equal(store.listTokens().length, 0);
  assert.equal(store.listJobs().some((job) => job.type === 'discovery'), false);
});

test('start rebuilds summaries from manual tokens and enforces the 500 USD entry floor', async (t) => {
  const { service, store } = createService({ minEntryUsd: 500 });
  t.after(() => store.close());

  store.upsertToken({
    address: tokenA,
    symbol: 'MANUAL',
    name: 'Manual winner',
    manual: true,
    qualified: false,
    qualificationStatus: 'manual',
    qualification: { status: 'manual', qualified: false },
    peakMultiple: 100,
    currentPriceNative: 1,
    quoteUsd: 2_000,
    pool: { version: 'v3', currentPriceNative: 1 }
  });
  store.replaceTokenActions(tokenA, [
    {
      ...action({ tokenAddress: tokenA, wallet: walletA, txHash: '0xmanual-large', logIndex: 0 }),
      tokenAmount: 30,
      quoteAmount: 0.3,
      priceNative: 0.01,
      blockNumber: 1
    },
    {
      ...action({ tokenAddress: tokenA, wallet: walletB, txHash: '0xmanual-small', logIndex: 0 }),
      tokenAmount: 10,
      quoteAmount: 0.2,
      priceNative: 0.02,
      blockNumber: 2
    },
    {
      ...action({ tokenAddress: tokenA, wallet: walletA, txHash: '0xmanual-exit', logIndex: 0 }),
      side: 'sell',
      tokenAmount: 30,
      quoteAmount: 30,
      priceNative: 1,
      blockNumber: 3
    }
  ]);

  store.upsertToken({
    address: tokenB,
    symbol: 'LEGACY',
    name: 'Legacy discovery',
    manual: false,
    qualified: true,
    peakMultiple: 100,
    currentPriceNative: 1,
    quoteUsd: 2_000,
    pool: { version: 'v3', currentPriceNative: 1 }
  });
  store.replaceTokenActions(tokenB, [
    {
      ...action({ tokenAddress: tokenB, wallet: walletLegacy, txHash: '0xlegacy-large', logIndex: 0 }),
      tokenAmount: 50,
      quoteAmount: 0.5,
      priceNative: 0.01,
      blockNumber: 1
    }
  ]);
  store.replaceWalletSummaries([{ address: walletLegacy, hits: 9, entries: 9, score: 999 }]);

  await service.start();

  const summaries = store.listWalletSummaries();
  assert.deepEqual(summaries.map((summary) => summary.address), [walletA]);
  assert.equal(summaries[0].winnerHits, 1);
  assert.equal(summaries[0].minimumEntryUsd, 500);
  assert.equal(summaries[0].totalEntryCostUsd, 600);
  assert.deepEqual(summaries[0].performances.map((performance) => performance.tokenAddress), [tokenA]);
  assert.equal(store.getToken(tokenB).manual, false);
  assert.equal(store.listActionsForToken(tokenB).length, 1);
});

test('manual winners are persisted and scanned with bounded concurrency', async (t) => {
  let active = 0;
  let maxActive = 0;
  const releases = [];
  const { service, store } = createService({
    scanConcurrency: 1,
    scanToken: async ({ token }) => {
      active += 1;
      maxActive = Math.max(maxActive, active);
      await new Promise((resolve) => releases.push(resolve));
      active -= 1;
      return {
        tokenPatch: {
          peakMultiple: token.address === tokenA ? 20 : 12,
          peakLiquidityUsd: 80_000,
          effectiveWallets: 140
        },
        actions: [],
        scan: { complete: true }
      };
    }
  });
  t.after(() => store.close());

  service.addManualWinner(tokenA);
  service.addManualWinner(tokenB);
  await new Promise((resolve) => setImmediate(resolve));
  assert.equal(active, 1);
  assert.equal(maxActive, 1);
  releases.shift()();
  await new Promise((resolve) => setImmediate(resolve));
  assert.equal(active, 1);
  releases.shift()();
  await service.waitForIdle();

  assert.equal(store.listTokens().length, 2);
  const dashboard = service.getDashboard({ tab: 'all' });
  assert.equal(dashboard.winners.every((winner) => winner.qualified), true);
  assert.equal(dashboard.jobs.filter((job) => job.type === 'token_scan' && job.status === 'complete').length, 2);
});

test('does not replace cached actions when a manual scan reports partial data', async (t) => {
  const { service, store } = createService({
    scanToken: async () => ({
      actions: [action({ txHash: '0xnew', logIndex: 2 })],
      scan: { complete: false, partial: true }
    })
  });
  t.after(() => store.close());
  store.upsertToken({ address: tokenA, symbol: 'AAA', name: 'Alpha', manual: true });
  store.replaceTokenActions(tokenA, [action({ txHash: '0xold', logIndex: 1 })]);

  service.queueToken(store.getToken(tokenA), { force: true, manual: true });
  await service.waitForIdle();

  assert.deepEqual(store.listActionsForToken(tokenA).map((row) => row.txHash), ['0xold']);
  assert.equal(store.getToken(tokenA).scanStatus, 'partial');
});

test('seeds an empty cache with explicitly partial actions from a manual winner', async (t) => {
  const partialAction = action({ txHash: '0xpartial', logIndex: 1 });
  const { service, store } = createService({
    scanToken: async () => ({
      tokenPatch: { currentPriceNative: 0.2, peakMultiple: 20 },
      actions: [partialAction],
      scan: { complete: false, partial: true }
    })
  });
  t.after(() => store.close());

  service.addManualWinner(tokenA);
  await service.waitForIdle();

  assert.deepEqual(store.listActionsForToken(tokenA).map((row) => row.txHash), ['0xpartial']);
  assert.equal(store.getToken(tokenA).scanStatus, 'partial');
});

test('manual token additions are normalized, queued once, and idempotent', async (t) => {
  let scans = 0;
  const { service, store } = createService({
    autoScanLimit: 0,
    scanToken: async () => {
      scans += 1;
      return { actions: [], scan: { complete: true } };
    }
  });
  t.after(() => store.close());

  const first = service.addManualWinner(tokenA.toUpperCase().replace('0X', '0x'));
  await service.waitForIdle();
  const second = service.addManualWinner(tokenA);
  await service.waitForIdle();

  assert.equal(first.duplicate, false);
  assert.equal(second.duplicate, true);
  assert.equal(store.getToken(tokenA).manual, true);
  assert.equal(scans, 1);
});

test('scan-specific minimum entry USD is persisted per CA and reused by later rescans', async (t) => {
  const scannedThresholds = [];
  const { service, store } = createService({
    minEntryUsd: 500,
    scanToken: async ({ config }) => {
      scannedThresholds.push(config.minEntryUsd);
      const candidate = {
        address: walletA,
        holderRank: 5,
        holdingTokenAmount: 100,
        holdingValueUsd: 900,
        buyVolumeUsd: 300,
        totalProfitUsd: 600,
        totalMultiple: 3,
        entryProgress: 0.1,
        early: true,
        profitState: 'complete'
      };
      const holderAnalysis = {
        strategy: 'holder_first',
        complete: true,
        minimumEntryUsd: config.minEntryUsd,
        candidates: [candidate]
      };
      return {
        tokenPatch: { holderAnalysis },
        holderAnalysis,
        scan: { complete: true, strategy: 'holder_first', minimumEntryUsd: config.minEntryUsd }
      };
    }
  });
  t.after(() => store.close());

  const added = service.addManualWinner(tokenA, { minEntryUsd: 250 });
  await service.waitForIdle();

  assert.equal(added.job.minimumEntryUsd, 250);
  assert.deepEqual(scannedThresholds, [250]);
  assert.equal(store.getToken(tokenA).holderAnalysis.minimumEntryUsd, 250);
  assert.equal(store.listWalletSummaries()[0].minimumEntryUsd, 250);
  assert.equal(store.listWalletSummaries()[0].totalEntryCostUsd, 300);
  assert.equal(service.getDashboard({ tab: 'all', minEntryUsd: 250 }).filters.minEntryUsd, 250);

  const rescanned = service.rescanManualWinner(tokenA, { minEntryUsd: 400 });
  await service.waitForIdle();

  assert.equal(rescanned.minimumEntryUsd, 400);
  assert.deepEqual(scannedThresholds, [250, 400]);
  assert.equal(store.getToken(tokenA).holderAnalysis.minimumEntryUsd, 400);
  assert.deepEqual(store.listWalletSummaries(), []);

  service.triggerScan();
  await service.waitForIdle();
  assert.deepEqual(scannedThresholds, [250, 400, 400]);
  assert.throws(() => service.triggerScan({ minEntryUsd: -1 }), /minEntryUsd/);
});

test('a submitted token can be rescanned repeatedly without duplicating an active scan', async (t) => {
  let scans = 0;
  const releases = [];
  const { service, store } = createService({
    scanToken: async () => {
      scans += 1;
      await new Promise((resolve) => releases.push(resolve));
      return { actions: [], scan: { complete: true, strategy: 'holder_first' } };
    }
  });
  t.after(() => store.close());

  service.addManualWinner(tokenA, { minEntryUsd: 500 });
  await new Promise((resolve) => setImmediate(resolve));
  assert.equal(scans, 1);

  const globalWhileRunning = service.triggerScan({ minEntryUsd: 100 });
  assert.equal(globalWhileRunning.accepted, false);
  assert.equal(globalWhileRunning.alreadyRunning, true);
  assert.equal(globalWhileRunning.queued, 0);
  assert.deepEqual(globalWhileRunning.active, [{ id: `scan:${tokenA}`, minimumEntryUsd: 500 }]);

  const whileRunning = service.rescanManualWinner(tokenA);
  assert.equal(whileRunning.accepted, false);
  assert.equal(whileRunning.alreadyRunning, true);
  releases.shift()();
  await service.waitForIdle();
  assert.equal(scans, 1);

  const repeated = service.rescanManualWinner(tokenA);
  assert.equal(repeated.accepted, true);
  assert.equal(repeated.alreadyRunning, false);
  assert.equal(repeated.tokenAddress, tokenA);
  await new Promise((resolve) => setImmediate(resolve));
  assert.equal(scans, 2);

  const duplicateClick = service.rescanManualWinner(tokenA);
  assert.equal(duplicateClick.accepted, false);
  assert.equal(duplicateClick.alreadyRunning, true);
  releases.shift()();
  await service.waitForIdle();
  assert.equal(scans, 2);
  assert.equal(service.rescanManualWinner(tokenB), null);
  assert.equal(store.listJobs().some((job) => job.type === 'wallet_history'), false);
});

test('rebuilds one global repeat-hit wallet leaderboard across manual winner scans', async (t) => {
  const makeActions = (tokenAddress, seed) => [
    action({ tokenAddress, wallet: walletA, txHash: `0x${String(seed).padStart(64, '0')}` }),
    {
      ...action({ tokenAddress, wallet: walletB, txHash: `0x${String(seed + 1).padStart(64, '0')}` }),
      tokenAmount: 10,
      quoteAmount: 0.2,
      priceNative: 0.02,
      blockNumber: 2,
      blockTimestamp: 2
    },
    {
      ...action({ tokenAddress, wallet: walletA, txHash: `0x${String(seed + 2).padStart(64, '0')}` }),
      side: 'sell',
      tokenAmount: 50,
      quoteAmount: 50,
      priceNative: 1,
      blockNumber: 3,
      blockTimestamp: 3
    }
  ];
  const { service, store } = createService({
    scanToken: async ({ token }) => ({
      tokenPatch: {
        peakMultiple: 100,
        peakLiquidityUsd: 100_000,
        effectiveWallets: 200,
        currentPriceNative: 1,
        qualified: true
      },
      qualification: { status: 'qualified', qualified: true, peakMultiple: 100 },
      pool: { version: 'v3', currentPriceNative: 1 },
      actions: makeActions(token.address, token.address === tokenA ? 10 : 20),
      scan: { complete: true }
    })
  });
  t.after(() => store.close());

  service.addManualWinner(tokenA);
  service.addManualWinner(tokenB);
  await service.waitForIdle();

  const summary = store.listWalletSummaries().find((wallet) => wallet.address === walletA);
  assert.equal(summary.winnerHits, 2);
  assert.equal(summary.eligibleEntries, 2);
  assert.equal(summary.maxRealizedMultiple, 100);
  assert.equal(summary.maxUnrealizedMultiple, 100);
  const detail = service.getWallet(walletA);
  assert.equal(detail.tokens.length, 2);
  assert.equal(detail.tokens[0].realizedMultiple, 100);
  assert.equal(detail.tokens[0].actions.length, 2);
});

test('wires holder clients and config into scans, persists holder summaries, and exposes holder token detail', async (t) => {
  const holderClient = { fetchTopHolders: async () => ({ holders: [] }) };
  const debotClient = {
    fetchTokenDetail: async () => ({}),
    fetchWalletTokenProfit: async () => ({})
  };
  let received;
  const holderAnalysis = {
    strategy: 'holder_first',
    complete: true,
    analyzedWallets: 1,
    eligibleWallets: 1,
    failedWallets: 0,
    snapshotAt: '2026-07-11T00:00:00.000Z',
    candidates: [{
      address: walletA,
      holderRank: 3,
      holdingTokenAmount: 2_000,
      holdingValueUsd: 20_000,
      buyVolumeUsd: 600,
      sellVolumeUsd: 12_000,
      realizedProfitUsd: 11_400,
      unrealizedProfitUsd: 6_000,
      totalProfitUsd: 17_400,
      realizedMultiple: 20,
      unrealizedMultiple: 12,
      totalMultiple: 15,
      entryProgress: 0.05,
      early: true,
      profitState: 'complete',
      candidateReason: 'top_holder',
      confidence: 'high'
    }]
  };
  const { service, store } = createService({
    debotClient,
    holderClient,
    minEntryUsd: 500,
    holderCandidateLimit: 25,
    holderFetchLimit: 40,
    holderProfitConcurrency: 3,
    significantProfitRate: 0.003,
    smartBaseMultiple: 6,
    strictMultiple: 12,
    repeatMinHits: 3,
    strongHolderRank: 20,
    scanToken: async (options) => {
      received = options;
      return {
        tokenPatch: { symbol: 'DOG', priceUsd: 10, holderAnalysis },
        holderAnalysis,
        qualification: { status: 'manual', qualified: false },
        actions: [],
        scan: { complete: true, strategy: 'holder_first' }
      };
    }
  });
  t.after(() => store.close());

  service.addManualWinner(tokenA);
  await service.waitForIdle();

  assert.equal(received.holderClient, holderClient);
  assert.equal(received.debotClient, debotClient);
  assert.equal(received.config.holderCandidateLimit, 25);
  assert.equal(received.config.holderFetchLimit, 40);
  assert.equal(received.config.holderProfitConcurrency, 3);
  assert.equal(received.config.minEntryUsd, 500);
  assert.equal(received.config.significantProfitRate, 0.003);
  assert.equal(received.config.smartBaseMultiple, 6);
  assert.equal(received.config.strictMultiple, 12);
  assert.equal(received.config.repeatMinHits, 3);
  assert.equal(received.config.strongHolderRank, 20);
  const summary = store.listWalletSummaries()[0];
  assert.equal(summary.address, walletA);
  assert.equal(summary.candidateSource, 'top_holder');
  assert.equal(summary.bestHolderRank, 3);
  assert.equal(summary.minimumEntryUsd, 500);
  const detail = service.getWallet(walletA);
  assert.equal(detail.tokens.length, 1);
  assert.equal(detail.tokens[0].tokenAddress, tokenA);
  assert.deepEqual(detail.tokens[0].actions, []);
  const winner = service.getDashboard({ tab: 'all' }).winners[0];
  assert.equal(winner.qualificationStatus, 'manual_complete');
  assert.equal(winner.holderCandidates, 1);
  const dashboard = service.getDashboard({ tab: 'all' });
  assert.equal(dashboard.filters.significantProfitRate, 0.003);
  assert.equal(dashboard.filters.smartBaseMultiple, 6);
  assert.equal(dashboard.filters.strictMultiple, 12);
  assert.equal(dashboard.filters.repeatMinHits, 3);
});

test('keeps successful holder candidates when another profit lookup makes the scan partial', async (t) => {
  const partialHolderAnalysis = {
    strategy: 'holder_first',
    complete: false,
    analyzedWallets: 2,
    eligibleWallets: 1,
    failedWallets: 1,
    candidates: [
      {
        address: walletA,
        holderRank: 2,
        holdingValueUsd: 5_000,
        buyVolumeUsd: 700,
        totalMultiple: 20,
        entryProgress: 0.05,
        early: true,
        profitState: 'complete'
      },
      {
        address: walletB,
        holderRank: 3,
        profitState: 'failed',
        ignoredReason: 'profit_unavailable'
      }
    ],
    failures: [{ address: walletB, error: 'timeout' }]
  };
  const { service, store } = createService({
    minEntryUsd: 500,
    scanToken: async () => ({
      tokenPatch: { holderAnalysis: partialHolderAnalysis },
      holderAnalysis: partialHolderAnalysis,
      qualification: { status: 'manual', qualified: false, provisional: true },
      actions: [],
      scan: { complete: false, partial: true, strategy: 'holder_first', failedWallets: 1 }
    })
  });
  t.after(() => store.close());

  service.addManualWinner(tokenA);
  await service.waitForIdle();

  const token = store.getToken(tokenA);
  assert.equal(token.scanStatus, 'partial');
  assert.equal(token.holderAnalysis.failedWallets, 1);
  assert.deepEqual(store.listWalletSummaries().map((wallet) => wallet.address), [walletA]);
  const job = store.listJobs().find((candidate) => candidate.id === `scan:${tokenA}`);
  assert.equal(job.status, 'complete');
  assert.equal(job.partial, true);
  const dashboard = service.getDashboard({ tab: 'all' });
  assert.equal(dashboard.status, 'partial');
  assert.equal(dashboard.winners[0].qualificationStatus, 'manual_partial');
  assert.equal(dashboard.warnings.some((warning) => warning.includes('1 个候选地址')), true);
});

test('uses smart admission by default so dynamic 5x wallets are not hidden by the 10x display threshold', async (t) => {
  const { service, store } = createService({ minEntryUsd: 500 });
  t.after(() => store.close());
  store.upsertToken({
    address: tokenA,
    symbol: 'DYNAMIC',
    manual: true,
    scanStatus: 'complete',
    peakMarketCapUsd: 1_000_000,
    holderAnalysis: {
      strategy: 'holder_first',
      complete: true,
      candidates: [{
        address: walletA,
        holderRank: 3,
        holdingTokenAmount: 10_000,
        holdingValueUsd: 10_000,
        holdingSharePercent: 1,
        buyVolumeUsd: 600,
        unrealizedProfitUsd: 3_000,
        totalProfitUsd: 3_000,
        totalMultiple: 6,
        entryProgress: 0.05,
        early: true,
        profitState: 'complete'
      }]
    }
  });

  await service.start();

  const smartDashboard = service.getDashboard({ tab: 'all', multiple: 10 });
  assert.equal(smartDashboard.filters.strategy, 'smart');
  assert.deepEqual(smartDashboard.wallets.map((wallet) => wallet.address), [walletA]);
  assert.equal(smartDashboard.wallets[0].smartEligible, true);
  assert.deepEqual(smartDashboard.wallets[0].smartReasons, ['heavy_5x']);
  assert.deepEqual(service.listWallets({ tab: 'all', strategy: 'multiple', multiple: 10 }), []);
});

test('keeps smart candidates pending until confirmation and suggests token profit-rank aliases', async (t) => {
  const { service, store } = createService({ minEntryUsd: 500 });
  t.after(() => store.close());
  store.upsertToken({
    address: tokenA,
    symbol: 'VEX',
    manual: true,
    scanStatus: 'complete',
    peakMarketCapUsd: 1_000_000,
    holderAnalysis: {
      strategy: 'holder_first',
      complete: true,
      candidates: [
        {
          address: walletA,
          holderRank: 5,
          holdingTokenAmount: 10_000,
          holdingValueUsd: 10_000,
          buyVolumeUsd: 600,
          unrealizedProfitUsd: 3_000,
          totalProfitUsd: 3_000,
          totalMultiple: 6,
          entryProgress: 0.05,
          early: true,
          profitState: 'complete'
        },
        {
          address: walletB,
          holderRank: 2,
          holdingTokenAmount: 20_000,
          holdingValueUsd: 20_000,
          buyVolumeUsd: 800,
          unrealizedProfitUsd: 10_000,
          totalProfitUsd: 10_000,
          totalMultiple: 12,
          entryProgress: 0.05,
          early: true,
          profitState: 'complete'
        },
        {
          address: walletC,
          holderRank: 20,
          holdingTokenAmount: 5_000,
          holdingValueUsd: 5_000,
          buyVolumeUsd: 1_000,
          unrealizedProfitUsd: 1_000,
          totalProfitUsd: 1_000,
          totalMultiple: 2,
          entryProgress: 0.05,
          early: true,
          profitState: 'complete'
        }
      ]
    }
  });

  await service.start();

  const summaries = new Map(store.listWalletSummaries().map((wallet) => [wallet.address, wallet]));
  assert.equal(summaries.get(walletB).profitRank, 1);
  assert.equal(summaries.get(walletB).suggestedAlias, 'VEX 盈利榜第 1 名');
  assert.equal(summaries.get(walletA).profitRank, 2);
  assert.equal(summaries.get(walletA).suggestedAlias, 'VEX 盈利榜第 2 名');

  const pending = service.listWallets({ tab: 'all', review: 'pending' });
  assert.deepEqual(new Set(pending.map((wallet) => wallet.address)), new Set([walletA, walletB]));
  assert.equal(pending.some((wallet) => wallet.address === walletC), false);
  assert.equal(pending.every((wallet) => wallet.reviewState === 'pending' && wallet.curated === false), true);

  const confirmed = service.updateWallet(walletA, {
    alias: summaries.get(walletA).suggestedAlias,
    status: 'active'
  });
  assert.equal(confirmed.wallet.reviewState, 'confirmed');
  assert.equal(confirmed.wallet.confirmed, true);
  assert.equal(confirmed.wallet.debotUrl, `https://debot.ai/address/robinhood/${walletA}`);
  assert.deepEqual(service.listWallets({ tab: 'all', review: 'confirmed' }).map((wallet) => wallet.address), [walletA]);
  assert.deepEqual(service.listWallets({ tab: 'all', review: 'pending' }).map((wallet) => wallet.address), [walletB]);

  service.deleteWallet(walletB);
  assert.deepEqual(service.listWallets({ tab: 'all', review: 'excluded' }).map((wallet) => wallet.address), [walletB]);
  assert.equal(service.listWallets({ tab: 'all' }).some((wallet) => wallet.address === walletB), false);
});

test('merges persistent curation and filters the smart wallet library server-side', (t) => {
  const { service, store } = createService();
  t.after(() => store.close());
  store.replaceWalletSummaries([
    {
      address: walletA,
      hits: 2,
      entries: 2,
      maxRealizedMultiple: 18,
      maxUnrealizedMultiple: 12,
      classification: 'all_round',
      score: 88
    },
    {
      address: walletB,
      hits: 2,
      entries: 3,
      maxRealizedMultiple: 14,
      maxUnrealizedMultiple: 11,
      classification: 'all_round',
      score: 70
    }
  ]);

  const updated = service.updateWallet(walletA, {
    alias: 'Desk alpha',
    note: 'Repeat winner under review',
    tags: ['Repeat-Hit', 'repeat-hit', 'swing'],
    status: 'watch',
    classificationOverride: 'realized'
  });
  assert.equal(updated.wallet.alias, 'Desk alpha');
  assert.deepEqual(updated.wallet.tags, ['Repeat-Hit', 'swing']);
  assert.equal(updated.wallet.computedClassification, 'all_round');
  assert.equal(updated.wallet.classification, 'realized');
  assert.equal(service.getDashboard({ tab: 'all' }).mode, 'manual-only');
  assert.equal(service.listWallets({ tab: 'all_round' }).some((wallet) => wallet.address === walletA), true);

  const filtered = service.listWallets({
    tab: 'all',
    search: 'desk',
    tags: ['repeat-hit'],
    status: 'watch',
    classification: 'realized'
  });
  assert.deepEqual(filtered.map((wallet) => wallet.address), [walletA]);

  const firstDelete = service.deleteWallet(walletA);
  const secondDelete = service.deleteWallet(walletA);
  assert.equal(firstDelete.alreadyExcluded, false);
  assert.equal(secondDelete.alreadyExcluded, true);
  assert.equal(service.listWallets({ tab: 'all' }).some((wallet) => wallet.address === walletA), false);
  assert.equal(service.listWallets({ tab: 'all', status: 'excluded' })[0].address, walletA);

  service.updateWallet(walletA, { status: 'active', classificationOverride: null });
  assert.equal(service.getWallet(walletA).wallet.classification, 'all_round');
});

test('persists, filters, and preserves wallet monitor tiers', (t) => {
  const { service, store } = createService();
  t.after(() => store.close());
  store.replaceWalletSummaries([
    {
      address: walletA,
      hits: 1,
      entries: 2,
      totalTradeCount: 10,
      totalProfitUsd: 80_000,
      maxRealizedMultiple: 24,
      classification: 'realized',
      score: 88
    },
    {
      address: walletB,
      hits: 2,
      entries: 2,
      totalTradeCount: 40,
      totalProfitUsd: 120_000,
      maxRealizedMultiple: 30,
      classification: 'realized',
      score: 70
    }
  ]);

  service.updateWallet(walletA, { monitorTier: 'core' });
  service.updateWallet(walletB, { monitorTier: 'high_frequency' });
  assert.equal(service.getWallet(walletA).wallet.monitorTier, 'core');
  assert.equal(service.getWallet(walletB).wallet.monitorTier, 'high_frequency');
  assert.deepEqual(
    service.listWallets({ tab: 'all', monitorTier: 'core' }).map((wallet) => wallet.address),
    [walletA]
  );
  assert.deepEqual(
    service.listWallets({ tab: 'all', monitorTier: 'high_frequency' }).map((wallet) => wallet.address),
    [walletB]
  );

  service.updateWallet(walletA, { monitorTier: 'watch' });
  service.updateWallet(walletA, { note: 'Keep the assigned tier' });
  assert.equal(service.getWallet(walletA).wallet.monitorTier, 'watch');
  assert.equal(store.getWalletAnnotation(walletA).monitorTier, 'watch');
  assert.equal(service.getDashboard({ tab: 'all', monitorTier: 'watch' }).filters.monitorTier, 'watch');
  assert.throws(() => service.updateWallet(walletA, { monitorTier: 'vip' }), /Unsupported wallet monitor tier/);
});

test('an annotation-only smart wallet keeps the manual library ready before scan data exists', (t) => {
  const { service, store } = createService();
  t.after(() => store.close());

  service.updateWallet(walletA, { alias: 'Imported wallet', status: 'watch' });
  const dashboard = service.getDashboard({ tab: 'all', status: 'watch' });

  assert.equal(dashboard.status, 'ready');
  assert.equal(dashboard.mode, 'manual-only');
  assert.equal(dashboard.discoveryEnabled, false);
  assert.equal(dashboard.wallets[0].address, walletA);
  assert.equal(dashboard.wallets[0].curated, true);
  assert.equal(dashboard.updatedAt, '2026-07-10T12:00:00.000Z');
});

test('re-adding a manual wallet updates its note without duplicating the annotation', (t) => {
  const { service, store } = createService();
  t.after(() => store.close());

  service.updateWallet(walletA, { status: 'active', note: 'First note' });
  service.updateWallet(walletA.toUpperCase().replace('0X', '0x'), { status: 'active', note: 'Updated note' });

  const annotations = store.listWalletAnnotations();
  assert.equal(annotations.length, 1);
  assert.equal(annotations[0].address, walletA);
  assert.equal(annotations[0].status, 'active');
  assert.equal(annotations[0].note, 'Updated note');
  assert.equal(service.listWallets({ tab: 'all', review: 'confirmed' }).length, 1);
});

test('manual scan trigger ignores legacy auto-discovered candidates', async (t) => {
  let release;
  const scanned = [];
  const { service, store } = createService({
    scanToken: async ({ token }) => {
      scanned.push(token.address);
      await new Promise((resolve) => { release = resolve; });
      return { actions: [], scan: { complete: true } };
    }
  });
  t.after(() => store.close());
  store.upsertToken({ address: tokenA, symbol: 'AAA', name: 'Manual', manual: true });
  store.upsertToken({ address: tokenB, symbol: 'BBB', name: 'Legacy', manual: false });

  const result = service.triggerScan();
  await new Promise((resolve) => setImmediate(resolve));
  assert.equal(result.queued, 1);
  assert.deepEqual(scanned, [tokenA]);
  release();
  await service.waitForIdle();
});

test('manual scan trigger rescans every submitted token without the legacy auto-scan limit', async (t) => {
  const scanned = [];
  const { service, store } = createService({
    autoScanLimit: 1,
    scanConcurrency: 2,
    scanToken: async ({ token }) => {
      scanned.push(token.address);
      return { actions: [], scan: { complete: true } };
    }
  });
  t.after(() => store.close());
  for (const address of [tokenA, tokenB, tokenC]) {
    store.upsertToken({ address, symbol: 'MANUAL', name: 'Manual token', manual: true });
  }
  store.upsertToken({ address: tokenLegacy, symbol: 'LEGACY', name: 'Legacy discovery', manual: false });

  const result = service.triggerScan();
  await service.waitForIdle();

  assert.equal(result.queued, 3);
  assert.deepEqual(scanned.sort(), [tokenA, tokenB, tokenC]);
  assert.equal(scanned.includes(tokenLegacy), false);
});

test('legacy DeBot candidates stay persisted but do not appear as manual winners', (t) => {
  const { service, store } = createService();
  t.after(() => store.close());
  store.upsertToken({
    address: tokenA,
    symbol: 'OLD',
    name: 'Legacy discovery',
    manual: false,
    scanStatus: 'partial',
    peakMultiple: 30
  });
  store.setMeta('robinhood:last_success_at', '2026-07-09T12:00:00.000Z');

  const dashboard = service.getDashboard({ tab: 'all' });
  assert.equal(store.getToken(tokenA).address, tokenA);
  assert.deepEqual(dashboard.winners, []);
  assert.equal(dashboard.status, 'empty');
  assert.equal(dashboard.updatedAt, null);
});
