import test from 'node:test';
import assert from 'node:assert/strict';

import { createServer } from '../src/server.js';

const token = '0x1111111111111111111111111111111111111111';
const wallet = '0xaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa';

async function withServer(robinhoodService, run) {
  const server = createServer({ robinhoodService });
  await new Promise((resolve, reject) => {
    server.once('error', reject);
    server.listen(0, '127.0.0.1', resolve);
  });
  const { port } = server.address();
  try {
    await run(`http://127.0.0.1:${port}`);
  } finally {
    await new Promise((resolve) => server.close(resolve));
  }
}

test('dashboard route forwards validated filters and returns its public contract', async () => {
  let receivedFilters;
  const service = {
    getDashboard(filters) {
      receivedFilters = filters;
      return {
        ok: true,
        status: 'ready',
        filters,
        wallets: [],
        winners: [],
        jobs: [],
        updatedAt: '2026-07-10T12:00:00.000Z',
        stale: false,
        warnings: []
      };
    }
  };

  await withServer(service, async (baseUrl) => {
    const response = await fetch(
      `${baseUrl}/api/robinhood/dashboard?strategy=smart&multiple=50&minEntryUsd=325&minLiquidityUsd=75000&minWallets=250&tab=unrealized`
    );
    const body = await response.json();

    assert.equal(response.status, 200);
    assert.equal(body.status, 'ready');
    assert.deepEqual(receivedFilters, {
      multiple: 50,
      minEntryUsd: 325,
      minLiquidityUsd: 75_000,
      minWallets: 250,
      tab: 'unrealized',
      strategy: 'smart'
    });
  });
});

test('dashboard route rejects malformed numeric filters', async () => {
  await withServer({ getDashboard: () => assert.fail('must not call service') }, async (baseUrl) => {
    const response = await fetch(`${baseUrl}/api/robinhood/dashboard?multiple=NaN&minWallets=1.5`);
    const body = await response.json();
    assert.equal(response.status, 400);
    assert.equal(body.code, 'INVALID_FILTER');
  });
});

test('stale dashboard cache is returned as partial HTTP success', async () => {
  const service = {
    getDashboard() {
      return {
        ok: false,
        status: 'stale',
        filters: {},
        wallets: [],
        winners: [{ address: token }],
        jobs: [],
        updatedAt: '2026-07-09T12:00:00.000Z',
        stale: true,
        warnings: ['cached']
      };
    }
  };
  await withServer(service, async (baseUrl) => {
    const response = await fetch(`${baseUrl}/api/robinhood/dashboard`);
    const body = await response.json();
    assert.equal(response.status, 206);
    assert.equal(body.winners[0].address, token);
  });
});

test('manual winner route validates JSON and normalizes the address', async () => {
  const added = [];
  const service = {
    addManualWinner(address, options) {
      added.push({ address, options });
      return { ok: true, duplicate: false, winner: { address }, job: { status: 'queued' } };
    }
  };
  await withServer(service, async (baseUrl) => {
    const invalidJson = await fetch(`${baseUrl}/api/robinhood/winners`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: '{bad'
    });
    assert.equal(invalidJson.status, 400);

    const invalidAddress = await fetch(`${baseUrl}/api/robinhood/winners`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ address: '0x1234' })
    });
    assert.equal(invalidAddress.status, 400);

    const accepted = await fetch(`${baseUrl}/api/robinhood/winners`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ address: token.toUpperCase().replace('0X', '0x'), minEntryUsd: 275.5 })
    });
    const body = await accepted.json();
    assert.equal(accepted.status, 202);
    assert.equal(body.job.status, 'queued');
    assert.deepEqual(added, [{ address: token, options: { minEntryUsd: 275.5 } }]);

    const invalidMinimum = await fetch(`${baseUrl}/api/robinhood/winners`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ address: token, minEntryUsd: '500' })
    });
    assert.equal(invalidMinimum.status, 400);
    assert.equal((await invalidMinimum.json()).code, 'INVALID_SCAN_OPTIONS');
  });
});

test('manual winner rescan route forces one submitted CA and reports active duplicates', async () => {
  const rescanned = [];
  const service = {
    rescanManualWinner(address, options) {
      rescanned.push({ address, options });
      return { ok: true, accepted: rescanned.length === 1, alreadyRunning: rescanned.length > 1, tokenAddress: address };
    }
  };
  await withServer(service, async (baseUrl) => {
    const first = await fetch(`${baseUrl}/api/robinhood/winners/${token}/rescan`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ minEntryUsd: 800 })
    });
    assert.equal(first.status, 202);
    assert.equal((await first.json()).tokenAddress, token);

    const repeated = await fetch(`${baseUrl}/api/robinhood/winners/${token}/rescan`, { method: 'POST' });
    assert.equal(repeated.status, 200);
    assert.equal((await repeated.json()).alreadyRunning, true);
    assert.deepEqual(rescanned, [
      { address: token, options: { minEntryUsd: 800 } },
      { address: token, options: {} }
    ]);

    const invalid = await fetch(`${baseUrl}/api/robinhood/winners/0x1234/rescan`, { method: 'POST' });
    assert.equal(invalid.status, 400);
  });

  await withServer({ rescanManualWinner: () => null }, async (baseUrl) => {
    const missing = await fetch(`${baseUrl}/api/robinhood/winners/${token}/rescan`, { method: 'POST' });
    assert.equal(missing.status, 404);
    assert.equal((await missing.json()).code, 'WINNER_NOT_FOUND');
  });
});

test('refresh and wallet routes use asynchronous service operations', async () => {
  let refreshes = 0;
  const service = {
    triggerRefresh() {
      refreshes += 1;
      return { ok: true, accepted: true, status: 'refreshing' };
    },
    getWallet(address) {
      return address === wallet ? { ok: true, wallet: { address }, tokens: [] } : null;
    }
  };
  await withServer(service, async (baseUrl) => {
    const refresh = await fetch(`${baseUrl}/api/robinhood/refresh`, { method: 'POST' });
    assert.equal(refresh.status, 202);
    assert.equal(refreshes, 1);

    const found = await fetch(`${baseUrl}/api/robinhood/wallet/${wallet}`);
    assert.equal(found.status, 200);
    assert.equal((await found.json()).wallet.address, wallet);

    const missing = await fetch(`${baseUrl}/api/robinhood/wallet/${token}`);
    assert.equal(missing.status, 404);
  });
});

test('legacy signal route still uses injected signal and analysis services', async () => {
  const signalClient = {
    async fetchSignals(limit) {
      assert.equal(limit, 10);
      return { ok: true, rows: [{ address: token, symbol: 'AAA' }] };
    }
  };
  const tokenAnalysisService = {
    async enrichRowsWithRealtime(rows) {
      return rows;
    },
    decorateRows(rows) {
      return rows.map((row) => ({ ...row, decorated: true }));
    },
    prefetchRows() {}
  };
  const server = createServer({ signalClient, tokenAnalysisService, robinhoodService: {} });
  await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
  const { port } = server.address();
  try {
    const response = await fetch(`http://127.0.0.1:${port}/api/signals`);
    const body = await response.json();
    assert.equal(response.status, 200);
    assert.equal(body.rows[0].decorated, true);
  } finally {
    await new Promise((resolve) => server.close(resolve));
  }
});

test('serves the installed Lucide browser bundle from the vendor route', async () => {
  await withServer({}, async (baseUrl) => {
    const response = await fetch(`${baseUrl}/vendor/lucide.js`);
    const source = await response.text();
    assert.equal(response.status, 200);
    assert.match(response.headers.get('content-type'), /javascript/);
    assert.match(source, /lucide/i);
  });
});

test('split overview, wallet, winner and job endpoints avoid dashboard fallback 404s', async () => {
  let scanOptions;
  const service = {
    getDashboard() {
      return {
        ok: true,
        status: 'ready',
        filters: { multiple: 10 },
        wallets: [{ address: wallet, hits: 2 }],
        winners: [
          { address: token, manual: true, qualified: true },
          { address: '0x2222222222222222222222222222222222222222', manual: true, qualified: false }
        ],
        jobs: [{ id: 'scan:1', status: 'complete' }],
        updatedAt: '2026-07-10T12:00:00.000Z',
        stale: false,
        partial: false,
        warnings: []
      };
    },
    getWallet(address) {
      return { ok: true, wallet: { address }, tokens: [] };
    },
    triggerScan(options) {
      scanOptions = options;
      return { ok: true, accepted: true, status: 'scanning', queued: 1 };
    }
  };

  await withServer(service, async (baseUrl) => {
    for (const route of ['overview', 'wallets', 'winners', 'jobs']) {
      const response = await fetch(`${baseUrl}/api/robinhood/${route}`);
      assert.equal(response.status, 200, route);
      if (route === 'overview') {
        const body = await response.json();
        assert.equal(body.counts.winners, 2);
        assert.equal(body.winnerCount, 2);
      }
    }
    const detail = await fetch(`${baseUrl}/api/robinhood/wallets/${wallet}`);
    assert.equal(detail.status, 200);
    const scan = await fetch(`${baseUrl}/api/robinhood/jobs/scan`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ minEntryUsd: 125 })
    });
    assert.equal(scan.status, 202);
    assert.deepEqual(scanOptions, { force: true, minEntryUsd: 125 });
  });
});

test('combined server exposes filtered wallet curation PATCH and DELETE routes', async () => {
  let receivedFilters;
  let receivedPatch;
  let receivedBatchLines;
  let deletedAddress;
  const service = {
    getDashboard(filters) {
      receivedFilters = filters;
      return {
        ok: true,
        status: 'ready',
        filters,
        wallets: [{ address: wallet, alias: 'Desk alpha', status: 'watch' }],
        winners: [],
        jobs: [],
        updatedAt: '2026-07-10T12:00:00.000Z',
        stale: false,
        partial: false,
        warnings: []
      };
    },
    updateWallet(address, patch) {
      receivedPatch = { address, patch };
      return { ok: true, wallet: { address, ...patch }, tokens: [] };
    },
    batchUpdateWallets(lines) {
      receivedBatchLines = lines;
      return {
        ok: true,
        total: 2,
        created: 1,
        restored: 0,
        updated: 0,
        duplicate: 0,
        invalid: 1,
        results: []
      };
    },
    deleteWallet(address) {
      deletedAddress = address;
      return { ok: true, deleted: true, excluded: true, alreadyExcluded: false, wallet: { address } };
    }
  };

  await withServer(service, async (baseUrl) => {
    const invalidFilter = await fetch(`${baseUrl}/api/robinhood/wallets?monitorTier=vip`);
    assert.equal(invalidFilter.status, 400);
    assert.equal((await invalidFilter.json()).code, 'INVALID_FILTER');

    const list = await fetch(
      `${baseUrl}/api/robinhood/wallets?tab=all&search=desk&tags=repeat-hit,swing&status=watch&classification=realized&review=confirmed&monitorTier=core`
    );
    assert.equal(list.status, 200);
    assert.equal((await list.json()).wallets[0].alias, 'Desk alpha');
    assert.equal(receivedFilters.search, 'desk');
    assert.deepEqual(receivedFilters.tags, ['repeat-hit', 'swing']);
    assert.equal(receivedFilters.status, 'watch');
    assert.equal(receivedFilters.classification, 'realized');
    assert.equal(receivedFilters.review, 'confirmed');
    assert.equal(receivedFilters.monitorTier, 'core');

    const invalid = await fetch(`${baseUrl}/api/robinhood/wallets/${wallet}`, {
      method: 'PATCH',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ tags: 'not-an-array' })
    });
    assert.equal(invalid.status, 400);
    assert.equal((await invalid.json()).code, 'INVALID_WALLET_UPDATE');

    const invalidTier = await fetch(`${baseUrl}/api/robinhood/wallets/${wallet}`, {
      method: 'PATCH',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ monitorTier: 'vip' })
    });
    assert.equal(invalidTier.status, 400);
    assert.equal((await invalidTier.json()).code, 'INVALID_WALLET_UPDATE');

    const invalidRules = await fetch(`${baseUrl}/api/robinhood/wallets/${wallet}`, {
      method: 'PATCH',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ monitorRules: { buy: { sound: 'yes' } } })
    });
    assert.equal(invalidRules.status, 400);
    assert.equal((await invalidRules.json()).code, 'INVALID_WALLET_UPDATE');

    const patch = await fetch(`${baseUrl}/api/robinhood/wallets/${wallet}`, {
      method: 'PATCH',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({
        alias: 'Desk alpha',
        status: 'watch',
        classificationOverride: 'realized',
        monitorTier: 'high_frequency',
        monitorRules: { buy: { sound: true }, token_create: { enabled: true, bark: false } }
      })
    });
    assert.equal(patch.status, 200);
    assert.deepEqual(receivedPatch, {
      address: wallet,
      patch: {
        alias: 'Desk alpha',
        status: 'watch',
        classificationOverride: 'realized',
        monitorTier: 'high_frequency',
        monitorRules: { buy: { sound: true }, token_create: { enabled: true, bark: false } }
      }
    });

    const batchLines = `${wallet},Desk alpha\nnot-a-wallet`;
    const batch = await fetch(`${baseUrl}/api/robinhood/wallets/batch`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ lines: batchLines })
    });
    assert.equal(batch.status, 200);
    assert.equal((await batch.json()).created, 1);
    assert.equal(receivedBatchLines, batchLines);

    const invalidBatch = await fetch(`${baseUrl}/api/robinhood/wallets/batch`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ lines: new Array(501).fill(wallet) })
    });
    assert.equal(invalidBatch.status, 400);
    assert.equal((await invalidBatch.json()).code, 'INVALID_WALLET_BATCH');

    const deletion = await fetch(`${baseUrl}/api/robinhood/wallets/${wallet}`, { method: 'DELETE' });
    assert.equal(deletion.status, 200);
    assert.equal((await deletion.json()).excluded, true);
    assert.equal(deletedAddress, wallet);
  });
});
