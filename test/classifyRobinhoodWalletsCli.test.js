import test from 'node:test';
import assert from 'node:assert/strict';

import {
  classificationInput,
  parseCliArgs,
  runWalletClassification,
  validateConfirmedWallets
} from '../scripts/classify-robinhood-wallets.mjs';

const walletA = '0xaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa';
const walletB = '0xbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb';
const walletC = '0xcccccccccccccccccccccccccccccccccccccccc';
const walletD = '0xdddddddddddddddddddddddddddddddddddddddd';

function response(body, status = 200) {
  return new Response(JSON.stringify(body), {
    status,
    headers: { 'content-type': 'application/json' }
  });
}

function confirmed(address, patch = {}) {
  return {
    address,
    confirmed: true,
    reviewState: 'confirmed',
    status: 'active',
    ...patch
  };
}

test('CLI options are dry-run by default and bounded', () => {
  const defaults = parseCliArgs([], {});
  assert.equal(defaults.apply, false);
  assert.equal(defaults.concurrency, 6);
  assert.equal(defaults.apiRoot, 'http://127.0.0.1:18118/api/robinhood');

  const applied = parseCliArgs([
    '--apply',
    '--api-root=https://example.test/robinhood-radar/api/robinhood/',
    '--concurrency', '3',
    '--timeout-ms=5000'
  ], {});
  assert.deepEqual(applied, {
    apply: true,
    apiRoot: 'https://example.test/robinhood-radar/api/robinhood',
    concurrency: 3,
    timeoutMs: 5000,
    help: false
  });
  assert.throws(() => parseCliArgs(['--concurrency', '0'], {}), /1 to 20/);
  assert.throws(() => parseCliArgs(['--api-root', 'file:\/\/tmp\/api'], {}), /HTTP\(S\)/);
  assert.throws(() => parseCliArgs(['--unknown'], {}), /Unknown option/);
});

test('normalizes current wallet summary aliases before using the shared tier classifier', () => {
  assert.deepEqual(classificationInput({
    eligibleEntries: 2,
    winnerHits: 1,
    totalTradeCount: 17,
    totalProfitUsd: 80_000,
    maxPeakMultiple: 24
  }), {
    entries: 2,
    hits: 1,
    tradeFrequency: 8.5,
    totalTradeCount: 17,
    totalProfitUsd: 80_000,
    bestMultiple: 24
  });
});

test('dry run fetches only confirmed wallets and emits complete classification evidence', async () => {
  const requests = [];
  const fetchImpl = async (url, options) => {
    requests.push({ url: String(url), options });
    return response({
      walletCount: 3,
      wallets: [
        confirmed(walletA, {
          entries: 2,
          hits: 1,
          totalTradeCount: 17,
          totalProfitUsd: 80_000,
          maxPeakMultiple: 24
        }),
        confirmed(walletB, {
          entries: 4,
          hits: 3,
          totalTradeCount: 16,
          totalProfitUsd: 100_000,
          maxTotalMultiple: 30,
          monitorTier: 'high_frequency'
        }),
        confirmed(walletC, { monitorTier: 'watch' })
      ]
    });
  };

  const report = await runWalletClassification({
    apiRoot: 'https://example.test/api/robinhood',
    concurrency: 2,
    timeoutMs: 5000
  }, {
    fetchImpl,
    now: () => new Date('2026-07-12T00:00:00.000Z')
  });

  assert.equal(requests.length, 1);
  const requestUrl = new URL(requests[0].url);
  assert.equal(requests[0].options.method, 'GET');
  assert.equal(requestUrl.pathname, '/api/robinhood/wallets');
  assert.deepEqual(Object.fromEntries(requestUrl.searchParams), {
    tab: 'all',
    review: 'confirmed',
    status: 'all'
  });
  assert.equal(report.mode, 'dry-run');
  assert.equal(report.generatedAt, '2026-07-12T00:00:00.000Z');
  assert.deepEqual(report.counts.proposedTiers, { core: 1, watch: 1, high_frequency: 1 });
  assert.equal(report.counts.fetched, 3);
  assert.equal(report.counts.uniqueAddresses, 3);
  assert.equal(report.counts.classified, 3);
  assert.equal(report.counts.changesPlanned, 1);
  assert.deepEqual(report.counts.apply, { attempted: 0, succeeded: 0, failed: 0 });
  assert.equal(report.evidence.find((row) => row.address === walletA).proposedMonitorTier, 'core');
  assert.deepEqual(report.evidence.find((row) => row.address === walletA).reasons, ['selective_high_profit']);
  assert.deepEqual(report.applications, []);
});

test('apply mode PATCHes only monitorTier with bounded concurrency and no scan or history request', async () => {
  const requests = [];
  let activePatches = 0;
  let maximumActivePatches = 0;
  const fetchImpl = async (url, options) => {
    const request = { url: String(url), method: options.method, body: options.body };
    requests.push(request);
    if (options.method === 'GET') {
      return response({
        wallets: [
          confirmed(walletA, { entries: 1, hits: 1, totalTradeCount: 2, totalProfitUsd: 1_000, maxTotalMultiple: 2 }),
          confirmed(walletB, { entries: 2, hits: 1, totalTradeCount: 10, totalProfitUsd: 90_000, maxPeakMultiple: 20 }),
          confirmed(walletC, { entries: 4, hits: 1, totalTradeCount: 12, totalProfitUsd: 3_000, maxTotalMultiple: 3 }),
          confirmed(walletD, { entries: 1, hits: 0, totalTradeCount: 25, totalProfitUsd: 100, maxTotalMultiple: 1 })
        ]
      });
    }
    activePatches += 1;
    maximumActivePatches = Math.max(maximumActivePatches, activePatches);
    await new Promise((resolve) => setImmediate(resolve));
    activePatches -= 1;
    const monitorTier = JSON.parse(options.body).monitorTier;
    return response({ ok: true, wallet: { monitorTier } });
  };

  const report = await runWalletClassification({
    apply: true,
    apiRoot: 'https://example.test/api/robinhood',
    concurrency: 2,
    timeoutMs: 5000
  }, { fetchImpl });

  assert.equal(maximumActivePatches, 2);
  assert.equal(requests.length, 5);
  for (const request of requests.slice(1)) {
    const url = new URL(request.url);
    assert.equal(request.method, 'PATCH');
    assert.match(url.pathname, /^\/api\/robinhood\/wallets\/0x[0-9a-f]{40}$/);
    assert.deepEqual(Object.keys(JSON.parse(request.body)), ['monitorTier']);
  }
  assert.equal(requests.some((request) => /scan|history|jobs/.test(new URL(request.url).pathname)), false);
  assert.equal(report.counts.changesPlanned, 4);
  assert.deepEqual(report.counts.apply, { attempted: 4, succeeded: 4, failed: 0 });
  assert.equal(report.applications.every((application) => application.responseVerified), true);
});

test('duplicate, non-confirmed, excluded, and mismatched-count responses fail before mutation', async () => {
  assert.throws(() => validateConfirmedWallets({
    wallets: [confirmed(walletA), confirmed(walletA.toUpperCase().replace('0X', '0x'))]
  }), /duplicate address/);
  assert.throws(() => validateConfirmedWallets({ wallets: [{ address: walletA }] }), /non-confirmed/);
  assert.throws(() => validateConfirmedWallets({
    wallets: [confirmed(walletA, { status: 'excluded' })]
  }), /excluded address/);
  assert.throws(() => validateConfirmedWallets({
    count: 2,
    wallets: [confirmed(walletA)]
  }), /does not match/);

  const requests = [];
  await assert.rejects(runWalletClassification({
    apply: true,
    apiRoot: 'https://example.test/api/robinhood',
    concurrency: 2,
    timeoutMs: 5000
  }, {
    fetchImpl: async (url, options) => {
      requests.push({ url, method: options.method });
      return response({ wallets: [confirmed(walletA), confirmed(walletA)] });
    }
  }), /duplicate address/);
  assert.deepEqual(requests.map((request) => request.method), ['GET']);
});
