import test from 'node:test';
import assert from 'node:assert/strict';

import { BASE_CHAIN } from '../src/base/config.js';
import { scanTokenHolders } from '../src/robinhood/holderScanner.js';

const token = '0x1111111111111111111111111111111111111111';
const creator = '0x2222222222222222222222222222222222222222';
const pool = '0x3333333333333333333333333333333333333333';
const walletA = '0xaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa';
const walletB = '0xbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb';
const walletC = '0xcccccccccccccccccccccccccccccccccccccccc';

function holder(address, holderRank, patch = {}) {
  return {
    address,
    holderRank,
    holdingTokenAmount: 1_000 / holderRank,
    holdingValueUsd: 10_000 / holderRank,
    holdingSharePercent: 10 / holderRank,
    holderSnapshotAt: '2026-07-11T00:00:00.000Z',
    exclusionReasons: [],
    ...patch
  };
}

function config(patch = {}) {
  return {
    defaultWinnerMultiple: 10,
    minEntryUsd: 500,
    minLiquidityUsd: 50_000,
    minEffectiveWallets: 100,
    holderCandidateLimit: 2,
    holderFetchLimit: 5,
    holderProfitConcurrency: 1,
    ...patch
  };
}

function tokenDetail() {
  return {
    address: token,
    symbol: 'DOG',
    name: 'Gold Dog',
    creatorAddress: creator,
    priceUsd: 10,
    liquidityUsd: 80_000,
    holders: 2_000,
    pools: [{ address: pool, liquidityUsd: 120_000 }]
  };
}

test('analyzes only top non-infrastructure holders and enforces the 500 USD floor', async () => {
  const profitCalls = [];
  let active = 0;
  let maxActive = 0;
  let requestedLimit;
  const progress = [];
  const result = await scanTokenHolders({
    token: { address: token, manual: true },
    config: config(),
    holderClient: {
      async fetchTopHolders(_address, { limit }) {
        requestedLimit = limit;
        return {
          holders: [
            holder(token, 1),
            holder(creator, 2),
            holder(pool, 3),
            holder('0x4444444444444444444444444444444444444444', 4, { exclusionReasons: ['contract_holder'] }),
            holder(walletA, 5),
            holder(walletB, 6),
            holder(walletC, 7)
          ],
          token: { holders: 1_900, priceUsd: 9 },
          snapshotAt: '2026-07-11T00:00:00.000Z'
        };
      }
    },
    debotClient: {
      fetchTokenDetail: async () => tokenDetail(),
      fetchTokenPeakMarketCap: async () => ({
        peakPriceUsd: 15.6,
        peakMarketCapUsd: 15_600_000,
        peakMarketCapAt: 200,
        source: 'debot_primary_pool_daily_high'
      }),
      async fetchWalletTokenProfit(_tokenAddress, address) {
        profitCalls.push(address);
        active += 1;
        maxActive = Math.max(maxActive, active);
        await new Promise((resolve) => setImmediate(resolve));
        active -= 1;
        if (address === walletA) {
          return {
            address,
            currentPriceUsd: 10,
            averageBuyPriceUsd: 0.5,
            buyVolumeUsd: 600,
            sellVolumeUsd: 6_000,
            realizedProfitUsd: 5_400,
            unrealizedProfitUsd: 1_000,
            totalProfitUsd: 6_400,
            realizedMultiple: 10,
            unrealizedMultiple: 12,
            totalMultiple: 11,
            profitState: 'complete'
          };
        }
        return {
          address,
          currentPriceUsd: 10,
          averageBuyPriceUsd: 0.1,
          buyVolumeUsd: 499.999,
          totalMultiple: 100,
          profitState: 'complete'
        };
      }
    },
    onProgress: (event) => progress.push(event)
  });

  assert.equal(requestedLimit, 5);
  assert.deepEqual(profitCalls, [walletA, walletB]);
  assert.equal(maxActive, 1);
  assert.equal(result.scan.complete, true);
  assert.equal(result.scan.analyzedWallets, 2);
  assert.equal(result.scan.eligibleWallets, 1);
  assert.equal(result.scan.ignoredBelowEntry, 1);
  assert.equal(result.holderAnalysis.candidates[0].hit, true);
  assert.equal(result.holderAnalysis.candidates[0].holderRank, 5);
  assert.equal(result.holderAnalysis.candidates[1].eligible, false);
  assert.equal(result.holderAnalysis.candidates[1].rawBuyVolumeUsd, 499.999);
  assert.equal(result.holderAnalysis.candidates[1].buyVolumeUsd, 500);
  assert.equal(result.holderAnalysis.candidates[1].ignoredReason, 'below_minimum_entry');
  assert.equal(result.tokenPatch.peakLiquidityUsd, 120_000);
  assert.equal(result.tokenPatch.peakMarketCapUsd, 15_600_000);
  assert.equal(result.tokenPatch.peakMarketCapAt, 200);
  assert.equal(result.tokenPatch.peakMarketCapSource, 'debot_primary_pool_daily_high');
  assert.equal(result.tokenPatch.peakMarketCapProvisional, false);
  assert.equal(result.tokenPatch.effectiveWallets, 2_000);
  assert.equal(progress.at(-1).stage, 'complete');
});

test('never lowers a cached historical peak when a later history request is smaller', async () => {
  const result = await scanTokenHolders({
    token: {
      address: token,
      manual: true,
      peakPriceUsd: 20,
      peakMarketCapUsd: 20_000_000,
      peakMarketCapAt: 150,
      peakMarketCapSource: 'cached_debot_history'
    },
    config: config({ holderCandidateLimit: 1 }),
    holderClient: {
      fetchTopHolders: async () => ({
        holders: [holder(walletA, 1)],
        token: { holders: 500 },
        snapshotAt: '2026-07-11T00:00:00.000Z'
      })
    },
    debotClient: {
      fetchTokenDetail: async () => tokenDetail(),
      fetchTokenPeakMarketCap: async () => ({
        peakPriceUsd: 15.6,
        peakMarketCapUsd: 15_600_000,
        peakMarketCapAt: 200,
        source: 'debot_primary_pool_daily_high'
      }),
      fetchWalletTokenProfit: async () => ({
        address: walletA,
        currentPriceUsd: 10,
        averageBuyPriceUsd: 1,
        buyVolumeUsd: 600,
        totalMultiple: 10,
        profitState: 'complete'
      })
    }
  });

  assert.equal(result.tokenPatch.peakMarketCapUsd, 20_000_000);
  assert.equal(result.tokenPatch.peakPriceUsd, 20);
  assert.equal(result.tokenPatch.peakMarketCapAt, 150);
  assert.equal(result.tokenPatch.peakMarketCapSource, 'cached_debot_history');
  assert.equal(result.tokenPatch.peakMarketCapProvisional, false);
});

test('returns a useful partial snapshot when one holder profit request fails', async () => {
  const result = await scanTokenHolders({
    token: { address: token, manual: true },
    config: config({ holderProfitConcurrency: 2 }),
    holderClient: {
      fetchTopHolders: async () => ({
        holders: [holder(walletA, 1), holder(walletB, 2)],
        token: { holders: 500 },
        snapshotAt: '2026-07-11T00:00:00.000Z'
      })
    },
    debotClient: {
      fetchTokenDetail: async () => tokenDetail(),
      fetchWalletTokenProfit: async (_tokenAddress, address) => {
        if (address === walletB) throw new Error('profit API timeout');
        return {
          address,
          currentPriceUsd: 10,
          averageBuyPriceUsd: 0.5,
          buyVolumeUsd: 800,
          totalMultiple: 20,
          profitState: 'complete'
        };
      }
    }
  });

  assert.equal(result.scan.complete, false);
  assert.equal(result.scan.partial, true);
  assert.equal(result.scan.failedWallets, 1);
  assert.equal(result.holderAnalysis.complete, false);
  assert.deepEqual(result.holderAnalysis.failures, [{ address: walletB, error: 'profit API timeout' }]);
  assert.equal(result.holderAnalysis.candidates[0].profitState, 'complete');
  assert.equal(result.holderAnalysis.candidates[1].profitState, 'failed');
  assert.equal(result.holderAnalysis.candidates[1].ignoredReason, 'profit_unavailable');
  assert.equal(result.qualification.provisional, true);
  assert.equal(result.qualification.confidence, 'medium');
});

test('uses a Base chain profile to exclude chain infrastructure and label holder evidence', async () => {
  const profitCalls = [];
  const result = await scanTokenHolders({
    token: { address: token, manual: true },
    chainProfile: BASE_CHAIN,
    holderSource: 'base_blockscout',
    config: config({ holderCandidateLimit: 1, holderFetchLimit: 2 }),
    holderClient: {
      fetchTopHolders: async () => ({
        holders: [holder(BASE_CHAIN.weth, 1), holder(walletA, 2)],
        token: { holders: 500 },
        snapshotAt: '2026-07-17T00:00:00.000Z',
        source: 'blockscout'
      })
    },
    debotClient: {
      fetchTokenDetail: async () => tokenDetail(),
      fetchWalletTokenProfit: async (_tokenAddress, address) => {
        profitCalls.push(address);
        return {
          address,
          currentPriceUsd: 10,
          averageBuyPriceUsd: 1,
          buyVolumeUsd: 600,
          totalMultiple: 10,
          profitState: 'complete'
        };
      }
    }
  });

  assert.deepEqual(profitCalls, [walletA]);
  assert.equal(result.holderAnalysis.holderSource, 'base_blockscout');
  assert.equal(result.scan.holderSource, 'base_blockscout');
  assert.equal(result.qualification.walletCountSource, 'base_blockscout_holder_index');
  assert.equal(result.holderAnalysis.candidates[0].address, walletA);
});

test('supports case-sensitive holder addresses through an injected chain adapter', async () => {
  const solToken = 'So11111111111111111111111111111111111111112';
  const solCreator = 'Vote111111111111111111111111111111111111111';
  const solWallet = 'SysvarRent111111111111111111111111111111111';
  const isSolanaAddress = (value) => /^[1-9A-HJ-NP-Za-km-z]{32,44}$/.test(value);
  const result = await scanTokenHolders({
    token: { address: ` ${solToken} `, manual: true },
    chainProfile: {
      name: 'Solana',
      holderSource: 'helius',
      infrastructureAddresses: [solCreator]
    },
    addressNormalizer: (value) => String(value || '').trim(),
    addressValidator: isSolanaAddress,
    config: config({ holderCandidateLimit: 1, holderFetchLimit: 2 }),
    holderClient: {
      fetchTopHolders: async () => ({
        holders: [holder(solCreator, 1), holder(solWallet, 2)],
        token: { holders: 500 },
        snapshotAt: '2026-07-17T00:00:00.000Z'
      })
    },
    debotClient: {
      fetchTokenDetail: async () => ({
        address: solToken,
        creatorAddress: solCreator,
        symbol: 'SOLTEST',
        name: 'Solana Test',
        priceUsd: 10,
        liquidityUsd: 80_000,
        holders: 500,
        pools: []
      }),
      fetchWalletTokenProfit: async (_tokenAddress, address) => ({
        address,
        currentPriceUsd: 10,
        averageBuyPriceUsd: 1,
        buyVolumeUsd: 600,
        totalMultiple: 10,
        profitState: 'complete'
      })
    }
  });

  assert.equal(result.tokenPatch.address, solToken);
  assert.equal(result.holderAnalysis.holderSource, 'helius');
  assert.equal(result.qualification.walletCountSource, 'helius_holder_index');
  assert.equal(result.holderAnalysis.candidates.length, 1);
  assert.equal(result.holderAnalysis.candidates[0].address, solWallet);
});
