import test from 'node:test';
import assert from 'node:assert/strict';

import { analyzeWalletToken, scoreWallet } from '../src/robinhood/analysis.js';

test('uses FIFO lots for partial sells and keeps open-position multiple separate', () => {
  const result = analyzeWalletToken({
    currentPriceNative: 10,
    actions: [
      { side: 'buy', tokenAmount: 100, quoteAmount: 100, priceNative: 1, blockNumber: 1, logIndex: 0 },
      { side: 'buy', tokenAmount: 100, quoteAmount: 200, priceNative: 2, blockNumber: 2, logIndex: 0 },
      { side: 'sell', tokenAmount: 150, quoteAmount: 900, priceNative: 6, blockNumber: 3, logIndex: 0 }
    ]
  });

  assert.equal(result.realizedCostNative, 200);
  assert.equal(result.realizedProceedsNative, 900);
  assert.equal(result.realizedMultiple, 4.5);
  assert.equal(result.remainingTokenAmount, 50);
  assert.equal(result.remainingCostNative, 100);
  assert.equal(result.unrealizedMultiple, 5);
  assert.equal(result.netMultiple, 4.6667);
  assert.equal(result.peakPotentialMultiple, 10);
});

test('rewards repeat high-multiple hits and penalizes broad spraying', () => {
  const focused = scoreWallet({
    hits: 3,
    entries: 5,
    maxRealizedMultiple: 20,
    maxUnrealizedMultiple: 30,
    maxPeakMultiple: 60,
    medianEntryProgress: 0.08,
    confidence: 1
  });
  const spray = scoreWallet({
    hits: 3,
    entries: 60,
    maxRealizedMultiple: 20,
    maxUnrealizedMultiple: 30,
    maxPeakMultiple: 60,
    medianEntryProgress: 0.08,
    confidence: 1
  });

  assert.equal(focused.score > spray.score, true);
  assert.equal(focused.classification, 'all_round');
});

test('shrinks one-shot win rates and reports sample confidence separately', () => {
  const oneShot = scoreWallet({
    hits: 1,
    entries: 1,
    totalTradeCount: 2,
    maxTotalMultiple: 8,
    profitToPeakMarketCapRatio: 0.002,
    normalizedProfitCoverage: 1
  });
  const established = scoreWallet({
    hits: 5,
    entries: 5,
    totalTradeCount: 10,
    maxTotalMultiple: 8,
    profitToPeakMarketCapRatio: 0.002,
    normalizedProfitCoverage: 1
  });

  assert.equal(oneShot.observedWinRate, 1);
  assert.equal(oneShot.adjustedWinRate, 0.6667);
  assert.equal(oneShot.sampleConfidence, 0.3333);
  assert.equal(established.adjustedWinRate, 0.8571);
  assert.equal(established.sampleConfidence, 0.7143);
  assert.equal(established.adjustedWinRate > oneShot.adjustedWinRate, true);
});

test('ranks the lower-frequency wallet higher when outcomes are otherwise equal', () => {
  const selective = scoreWallet({
    hits: 3,
    entries: 4,
    totalTradeCount: 8,
    maxTotalMultiple: 12,
    profitToPeakMarketCapRatio: 0.01,
    normalizedProfitCoverage: 1
  });
  const churn = scoreWallet({
    hits: 3,
    entries: 4,
    totalTradeCount: 80,
    maxTotalMultiple: 12,
    profitToPeakMarketCapRatio: 0.01,
    normalizedProfitCoverage: 1
  });

  assert.equal(selective.tradeFrequency, 2);
  assert.equal(churn.tradeFrequency, 20);
  assert.equal(selective.lowFrequencyScore > churn.lowFrequencyScore, true);
  assert.equal(selective.smartScore > churn.smartScore, true);
});

test('keeps missing trade counts neutral instead of treating them as zero-frequency evidence', () => {
  const unknown = scoreWallet({
    hits: 1,
    entries: 1,
    maxTotalMultiple: 12,
    profitToPeakMarketCapRatio: 0.01,
    normalizedProfitCoverage: 1
  });
  const knownSelective = scoreWallet({
    hits: 1,
    entries: 1,
    totalTradeCount: 2,
    maxTotalMultiple: 12,
    profitToPeakMarketCapRatio: 0.01,
    normalizedProfitCoverage: 1
  });

  assert.equal(unknown.tradeFrequency, null);
  assert.equal(unknown.totalTradeCount, null);
  assert.equal(unknown.tradeCountCoverage, 0);
  assert.equal(knownSelective.lowFrequencyScore > unknown.lowFrequencyScore, true);
});
