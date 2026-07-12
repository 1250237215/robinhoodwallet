import test from 'node:test';
import assert from 'node:assert/strict';

import { createRobinhoodConfig, ROBINHOOD_CHAIN } from '../src/robinhood/config.js';

test('uses verified Robinhood mainnet addresses and bounded scan settings', () => {
  assert.equal(ROBINHOOD_CHAIN.id, 4663);
  assert.equal(ROBINHOOD_CHAIN.weth, '0x0bd7d308f8e1639fab988df18a8011f41eacad73');
  assert.equal(ROBINHOOD_CHAIN.v3Factory, '0x1f7d7550b1b028f7571e69a784071f0205fd2efa');
  assert.equal(ROBINHOOD_CHAIN.noxaLaunchFactory, '0xd9ec2db5f3d1b236843925949fe5bd8a3836fccb');

  const config = createRobinhoodConfig({
    ROBINHOOD_LOG_WINDOW: '999999999',
    ROBINHOOD_AUTO_SCAN_LIMIT: '1000',
    ROBINHOOD_HOLDER_CANDIDATE_LIMIT: '1',
    ROBINHOOD_HOLDER_FETCH_LIMIT: '5000',
    ROBINHOOD_HOLDER_PROFIT_CONCURRENCY: '99'
  });

  assert.equal(config.defaultWinnerMultiple, 10);
  assert.equal(config.minLiquidityUsd, 50_000);
  assert.equal(config.minEffectiveWallets, 100);
  assert.equal(config.minEntryUsd, 500);
  assert.equal(config.significantProfitRate, 0.002);
  assert.equal(config.smartBaseMultiple, 5);
  assert.equal(config.strictMultiple, 10);
  assert.equal(config.repeatMinHits, 2);
  assert.equal(config.strongHolderRank, 30);
  assert.equal(config.relatedClusterPenalty, 0.9);
  assert.equal(config.lowFrequencyReasonThreshold, 0.8);
  assert.deepEqual(config.smartScoreWeights, {
    lowFrequency: 25,
    winRate: 25,
    normalizedProfit: 20,
    repeatability: 15,
    multipleQuality: 10,
    holderEvidence: 5
  });
  assert.equal(config.holderCandidateLimit, 10);
  assert.equal(config.holderFetchLimit, 1_000);
  assert.equal(config.holderProfitConcurrency, 20);
  assert.equal(config.logWindow, 100_000);
  assert.equal(config.autoScanLimit, 20);
  assert.equal(config.rpcMaxRetries, 6);
  assert.equal(config.rpcBatchDelayMs, 350);
  assert.equal(config.monitorPollIntervalMs, 500);
  assert.equal(config.monitorDegradedPollIntervalMs, 1_000);
  assert.equal(config.monitorMaxBlockSpan, 500);
  assert.equal(config.monitorWalletTopicChunkSize, 100);
  assert.equal(config.monitorLogConcurrency, 2);
  assert.equal(config.monitorRecoverySuccesses, 20);
  assert.equal(config.monitorFastLiveBlockSpan, 50);
  assert.equal(config.monitorFastGapBlockSpan, 100);
  assert.equal(config.monitorFastGapPollIntervalMs, 5_000);
  assert.equal(config.monitorDeepPollIntervalMs, 500);
  assert.equal(config.monitorDeepDegradedPollIntervalMs, 1_500);
  assert.equal(config.monitorDeepLiveBlockSpan, 20);
  assert.equal(config.monitorDeepGapBlockSpan, 20);
  assert.equal(config.monitorDeepGapPollIntervalMs, 5_000);
  assert.equal(config.monitorTokenMetadataBudgetMs, 1_500);
  assert.equal(config.noxaLaunchFactory, ROBINHOOD_CHAIN.noxaLaunchFactory);
});

test('keeps dynamic smart-money thresholds configurable and strict multiple above the base', () => {
  const config = createRobinhoodConfig({
    ROBINHOOD_SIGNIFICANT_PROFIT_RATE: '0.0035',
    ROBINHOOD_SMART_BASE_MULTIPLE: '12',
    ROBINHOOD_STRICT_MULTIPLE: '8',
    ROBINHOOD_REPEAT_MIN_HITS: '4',
    ROBINHOOD_STRONG_HOLDER_RANK: '20',
    ROBINHOOD_SCORE_LOW_FREQUENCY_WEIGHT: '40',
    ROBINHOOD_SCORE_MULTIPLE_QUALITY_WEIGHT: '3'
  });

  assert.equal(config.significantProfitRate, 0.0035);
  assert.equal(config.smartBaseMultiple, 12);
  assert.equal(config.strictMultiple, 12);
  assert.equal(config.repeatMinHits, 4);
  assert.equal(config.strongHolderRank, 20);
  assert.equal(config.smartScoreWeights.lowFrequency, 40);
  assert.equal(config.smartScoreWeights.multipleQuality, 3);
});
