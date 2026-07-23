import test from 'node:test';
import assert from 'node:assert/strict';

import { scanTokenHoldersOnchainFallback } from '../src/robinhood/onchainHolderFallback.js';

const token = '0x1111111111111111111111111111111111111111';
const pool = '0x2222222222222222222222222222222222222222';
const wallet = '0xaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa';
const secondWallet = '0xbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb';

function swap({ tokenAmount = 100, quoteAmount = 1 } = {}) {
  return {
    wallet,
    side: 'buy',
    tokenAmount,
    quoteAmount,
    priceNative: quoteAmount / tokenAmount,
    blockNumber: 100,
    transactionIndex: 1,
    logIndex: 2,
    blockTimestamp: 1_700_000_000,
    poolAddress: pool,
    txHash: '0xabc',
    attributionConfidence: 'high'
  };
}

function secondSwap() {
  return {
    ...swap({ tokenAmount: 10, quoteAmount: 0.2 }),
    wallet: secondWallet,
    txHash: '0xsecond-wallet',
    blockNumber: 101,
    blockTimestamp: 1_700_000_060
  };
}

function onchainResult(action = swap()) {
  return {
    tokenPatch: {
      symbol: 'DOG',
      name: 'Gold Dog',
      currentPriceNative: 0.01,
      quoteUsd: 1_000
    },
    pool: {
      address: pool,
      quoteToken: '0x5fc5360d0400a0fd4f2af552add042d716f1d168',
      quoteSymbol: 'WETH',
      currentPriceNative: 0.01,
      quoteUsd: 1_000,
      verifiedLiquidityUsd: 90_000,
      verified: true,
      version: 'v2'
    },
    actions: Array.isArray(action) ? action : [action],
    scan: { complete: true, partial: false, historyComplete: true }
  };
}

function holderClient(holdingTokenAmount) {
  let calls = 0;
  return {
    get calls() {
      return calls;
    },
    async fetchTopHolders(address, options) {
      calls += 1;
      assert.equal(address, token);
      assert.equal(options.limit, 10);
      return {
        source: 'blockscout',
        snapshotAt: '2026-07-10T12:00:00.000Z',
        token: { totalSupply: 10_000, holders: 12, symbol: 'DOG', name: 'Gold Dog' },
        holders: [{
          address: wallet,
          holderRank: 1,
          holdingTokenAmount,
          holdingSharePercent: holdingTokenAmount / 100,
          exclusionReasons: []
        }]
      };
    }
  };
}

const config = {
  minEntryUsd: 500,
  holderCandidateLimit: 10,
  holderFetchLimit: 10,
  holderProfitConcurrency: 1,
  defaultWinnerMultiple: 5
};

test('builds a conservative Holder candidate from Blockscout and reconciled verified-pool swaps', async () => {
  const holders = holderClient(100);
  const result = await scanTokenHoldersOnchainFallback({
    token: { address: token, manual: true },
    onchainResult: onchainResult([swap(), secondSwap()]),
    holderClient: holders,
    config
  });

  assert.equal(holders.calls, 1);
  assert.equal(result.scan.complete, false);
  assert.equal(result.scan.partial, true);
  assert.equal(result.scan.onchainComplete, true);
  assert.equal(result.holderAnalysis.strategy, 'holder_first_onchain_fallback');
  assert.equal(result.holderAnalysis.profitSource, 'verified_pool_swaps_and_blockscout_holders');
  assert.equal(result.holderAnalysis.fetchedHolders, 1);
  assert.equal(result.holderAnalysis.analyzedWallets, 1);
  assert.equal(result.holderAnalysis.reconciledWallets, 1);
  assert.equal(result.holderAnalysis.eligibleWallets, 1);
  assert.equal(result.holderAnalysis.failedWallets, 0);

  const candidate = result.holderAnalysis.candidates[0];
  assert.equal(candidate.address, wallet);
  assert.equal(candidate.profitState, 'complete');
  assert.equal(candidate.profitSource, 'verified_pool_swaps_and_blockscout_holders');
  assert.equal(candidate.confidence, 'medium');
  assert.equal(candidate.buyVolumeUsd, 1_000);
  assert.equal(candidate.holdingValueUsd, 1_000);
  assert.equal(candidate.totalProfitUsd, 0);
  assert.equal(candidate.totalMultiple, 1);
  assert.equal(candidate.costBasisComplete, true);

  assert.equal(result.tokenPatch.priceUsd, 10);
  assert.equal(result.tokenPatch.marketCapUsd, 100_000);
  assert.equal(result.tokenPatch.peakMarketCapUsd, 200_000);
  assert.equal(result.tokenPatch.peakMarketCapSource, 'verified_pool_swap_peak_price_current_supply');
  assert.equal(result.tokenPatch.peakMarketCapProvisional, true);
  assert.equal(result.tokenPatch.peakMarketCapError, 'historical_supply_unavailable');
  assert.equal(result.qualification.provisional, true);
  assert.equal(result.qualification.confidence, 'medium');
});

test('does not admit a Holder whose current balance cannot be reconciled with observed pool swaps', async () => {
  const result = await scanTokenHoldersOnchainFallback({
    token: { address: token, manual: true },
    onchainResult: onchainResult(),
    holderClient: holderClient(90),
    config
  });

  assert.equal(result.holderAnalysis.eligibleWallets, 0);
  assert.equal(result.holderAnalysis.analyzedWallets, 0);
  assert.equal(result.holderAnalysis.failedWallets, 1);
  assert.equal(result.holderAnalysis.candidates.length, 1);
  assert.equal(result.holderAnalysis.candidates[0].profitState, 'failed');
  assert.equal(result.holderAnalysis.candidates[0].eligible, false);
  assert.equal(result.holderAnalysis.candidates[0].confidence, 'low');
  assert.match(result.holderAnalysis.failures[0].error, /does not reconcile/);
});

test('skips Holder profit reconciliation when verified-pool history is incomplete', async () => {
  const incompleteHistory = onchainResult([swap(), secondSwap()]);
  incompleteHistory.scan.historyComplete = false;
  const holders = holderClient(100);
  await assert.rejects(
    scanTokenHoldersOnchainFallback({
      token: { address: token, manual: true },
      onchainResult: incompleteHistory,
      holderClient: holders,
      config
    }),
    /transaction history is incomplete/
  );
  assert.equal(holders.calls, 0);
});

test('does not admit a Holder when the observed swaps contain an unaccounted external position', async () => {
  const externalExit = {
    ...swap(),
    side: 'sell',
    quoteAmount: 1,
    txHash: '0xexternal-exit',
    blockNumber: 99
  };
  const resultWithExternalExit = onchainResult();
  resultWithExternalExit.actions = [externalExit, swap()];
  const result = await scanTokenHoldersOnchainFallback({
    token: { address: token, manual: true },
    onchainResult: resultWithExternalExit,
    holderClient: holderClient(100),
    config
  });

  assert.equal(result.holderAnalysis.eligibleWallets, 0);
  assert.equal(result.holderAnalysis.analyzedWallets, 0);
  assert.equal(result.holderAnalysis.candidates[0].profitState, 'failed');
  assert.match(result.holderAnalysis.failures[0].error, /Observed net token position/);
});
