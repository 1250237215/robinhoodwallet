import test from 'node:test';
import assert from 'node:assert/strict';

import {
  classifyWalletMonitorTier,
  normalizeWalletMonitorTier
} from '../src/robinhood/tiering.js';

test('classifies selective high-profit wallets as core', () => {
  const result = classifyWalletMonitorTier({
    entries: 2,
    hits: 1,
    tradeFrequency: 8.5,
    totalTradeCount: 17,
    totalProfitUsd: 80_000,
    bestMultiple: 24
  });
  assert.equal(result.monitorTier, 'core');
  assert.deepEqual(result.reasons, ['selective_high_profit']);
});

test('high transaction frequency takes precedence over profit', () => {
  const result = classifyWalletMonitorTier({
    entries: 2,
    hits: 2,
    tradeFrequency: 20,
    totalTradeCount: 40,
    totalProfitUsd: 500_000,
    bestMultiple: 100
  });
  assert.equal(result.monitorTier, 'high_frequency');
  assert.deepEqual(result.reasons, ['high_trades_per_token']);
});

test('classifies broad or mixed token participation as high frequency', () => {
  assert.equal(classifyWalletMonitorTier({
    entries: 4,
    hits: 3,
    tradeFrequency: 4,
    totalTradeCount: 16,
    totalProfitUsd: 80_000,
    bestMultiple: 30
  }).monitorTier, 'high_frequency');
  assert.equal(classifyWalletMonitorTier({
    entries: 3,
    hits: 1,
    tradeFrequency: 5,
    totalTradeCount: 15,
    totalProfitUsd: 80_000,
    bestMultiple: 30
  }).monitorTier, 'high_frequency');
  assert.equal(classifyWalletMonitorTier({
    entries: 3,
    hits: 2,
    tradeFrequency: 5,
    totalTradeCount: 15,
    totalProfitUsd: 80_000,
    bestMultiple: 30
  }).monitorTier, 'watch');
});

test('keeps incomplete and ordinary wallets in observation', () => {
  assert.equal(classifyWalletMonitorTier({}).monitorTier, 'watch');
  assert.deepEqual(classifyWalletMonitorTier({}).reasons, ['insufficient_sample_data']);
  assert.equal(classifyWalletMonitorTier({
    entries: 1,
    hits: 1,
    tradeFrequency: 3,
    totalTradeCount: 3,
    totalProfitUsd: 39_999,
    bestMultiple: 50
  }).monitorTier, 'watch');
  assert.equal(normalizeWalletMonitorTier('CORE'), 'core');
  assert.equal(normalizeWalletMonitorTier('unknown'), 'watch');
});
