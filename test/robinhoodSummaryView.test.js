import test from 'node:test';
import assert from 'node:assert/strict';

import {
  summarizeDashboard,
  summarizeWallet,
  summarizeWinner
} from '../src/robinhood/summaryView.js';

test('winner summaries keep pipeline counts without sending Holder rows', () => {
  const winner = {
    address: '0x1111111111111111111111111111111111111111',
    symbol: 'DOG',
    pools: [{ address: '0x2222222222222222222222222222222222222222' }],
    holderAnalysis: {
      fetchedHolders: 150,
      analyzedWallets: 100,
      eligibleWallets: 73,
      failedWallets: 14,
      snapshotAt: '2026-07-24T00:00:00.000Z',
      candidates: [{ address: '0xaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa', totalProfitUsd: 10_000 }],
      failures: [{ address: '0xbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb', error: 'unavailable' }]
    }
  };

  const summary = summarizeWinner(winner);

  assert.equal(summary.address, winner.address);
  assert.equal(summary.holderAnalysis.fetchedHolders, 150);
  assert.equal(summary.holderAnalysis.candidateCount, 1);
  assert.equal(summary.holderAnalysis.failureCount, 1);
  assert.equal(summary.poolCount, 1);
  assert.equal(Object.hasOwn(summary, 'pools'), false);
  assert.equal(Object.hasOwn(summary.holderAnalysis, 'candidates'), false);
  assert.equal(Object.hasOwn(summary.holderAnalysis, 'failures'), false);
  assert.equal(winner.holderAnalysis.candidates.length, 1);
});

test('winner summaries preserve aggregate counts from compact legacy snapshots', () => {
  const summary = summarizeWinner({
    address: '0x1111111111111111111111111111111111111111',
    holderAnalysis: {
      fetchedHolders: 150,
      candidateCount: 23,
      failureCount: 4
    }
  });

  assert.equal(summary.holderAnalysis.candidateCount, 23);
  assert.equal(summary.holderAnalysis.failureCount, 4);
});

test('wallet summaries retain list behavior with compact performance and frequency evidence', () => {
  const wallet = {
    address: '0xaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa',
    smartScore: 91,
    monitorRules: { buy: { enabled: true } },
    performances: [{
      tokenAddress: '0x1111111111111111111111111111111111111111',
      tokenSymbol: 'DOG',
      holderSnapshotAt: '2026-07-24T00:00:00.000Z',
      entryCostUsd: 800,
      totalProfitUsd: 12_000,
      hit: true,
      rawPayload: { oversized: true }
    }],
    buyFrequency: {
      averageDailyDistinctTokens: 2.5,
      distinctTokenDayCount: 20,
      observedDays: 10,
      dailyRows: Array.from({ length: 100 }, (_, index) => ({ index }))
    },
    curation: { duplicated: true },
    clusterEvidence: Array.from({ length: 100 }, (_, index) => ({ index })),
    scoreComponents: { repeated: 'large internal detail' }
  };

  const summary = summarizeWallet(wallet);

  assert.equal(summary.smartScore, 91);
  assert.deepEqual(summary.monitorRules, wallet.monitorRules);
  assert.equal(summary.performanceCount, 1);
  assert.equal(summary.performances[0].entryCostUsd, 800);
  assert.equal(summary.performances[0].hit, true);
  assert.equal(Object.hasOwn(summary.performances[0], 'rawPayload'), false);
  assert.equal(summary.buyFrequency.averageDailyDistinctTokens, 2.5);
  assert.equal(Object.hasOwn(summary.buyFrequency, 'dailyRows'), false);
  assert.equal(Object.hasOwn(summary, 'curation'), false);
  assert.equal(Object.hasOwn(summary, 'clusterEvidence'), false);
  assert.equal(Object.hasOwn(summary, 'scoreComponents'), false);
});

test('dashboard summaries compact both collections and declare their response view', () => {
  const dashboard = summarizeDashboard({
    ok: true,
    wallets: [{ address: '0xaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa', performances: [] }],
    winners: [{
      address: '0x1111111111111111111111111111111111111111',
      holderAnalysis: { candidates: [], failures: [] }
    }],
    jobs: [{ id: 'scan:token', status: 'complete' }]
  });

  assert.equal(dashboard.view, 'summary');
  assert.equal(dashboard.wallets[0].performanceCount, 0);
  assert.equal(dashboard.winners[0].holderAnalysis.candidateCount, 0);
  assert.equal(dashboard.jobs.length, 1);
});
