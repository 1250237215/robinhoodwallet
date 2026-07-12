import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

import {
  createRobinhoodStandaloneServer,
  parseDashboardFilters,
  parseWalletFilters,
  startRobinhoodStandaloneServer
} from '../src/robinhoodServer.js';
import { RobinhoodDebotClient } from '../src/robinhood/debotClient.js';
import { RobinhoodHolderClient } from '../src/robinhood/holderClient.js';
import { scanTokenHolders } from '../src/robinhood/holderScanner.js';

const wallet = '0xaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa';
const token = '0x1111111111111111111111111111111111111111';

async function withServer(service, run, monitor = null) {
  const server = createRobinhoodStandaloneServer({ service, monitor });
  await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
  try {
    const { port } = server.address();
    await run(`http://127.0.0.1:${port}`);
  } finally {
    await new Promise((resolve) => server.close(resolve));
  }
}

test('standalone deployment server validates filters without legacy Base dependencies', () => {
  const filters = parseDashboardFilters(new URLSearchParams('multiple=50&minEntryUsd=325&minLiquidityUsd=75000&minWallets=200&tab=unrealized'));
  assert.deepEqual(filters, { multiple: 50, minLiquidityUsd: 75_000, minWallets: 200, tab: 'unrealized', minEntryUsd: 325 });
});

test('standalone deployment server forwards the smart versus fixed-multiple strategy', () => {
  assert.deepEqual(
    parseDashboardFilters(new URLSearchParams('strategy=multiple&multiple=50&tab=all')),
    {
      multiple: 50,
      minLiquidityUsd: undefined,
      minWallets: undefined,
      tab: 'all',
      strategy: 'multiple'
    }
  );
  assert.throws(
    () => parseDashboardFilters(new URLSearchParams('strategy=unknown')),
    /strategy is not supported/
  );
});

test('standalone deployment server parses smart wallet curation filters', () => {
  const filters = parseWalletFilters(
    new URLSearchParams('tab=all&search=desk&tag=repeat-hit&tags=swing,large&status=watch&classification=realized&review=confirmed&monitorTier=core')
  );
  assert.deepEqual(filters, {
    multiple: undefined,
    minLiquidityUsd: undefined,
    minWallets: undefined,
    tab: 'all',
    search: 'desk',
    tags: ['repeat-hit', 'swing', 'large'],
    status: 'watch',
    classification: 'realized',
    review: 'confirmed',
    monitorTier: 'core'
  });
});

test('standalone deployment server rejects unsupported review states', () => {
  assert.throws(
    () => parseWalletFilters(new URLSearchParams('review=automatic')),
    /review is not supported/
  );
  assert.throws(
    () => parseWalletFilters(new URLSearchParams('monitorTier=vip')),
    /monitorTier is not supported/
  );
});

test('standalone deployment server exposes the split overview endpoint', async () => {
  const service = {
    getDashboard() {
      return {
        ok: true,
        status: 'ready',
        wallets: [{ address: '0xaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa' }],
        winners: [{ manual: true, qualified: true }, { manual: true, qualified: false }],
        jobs: [],
        updatedAt: '2026-07-10T12:00:00.000Z',
        stale: false,
        partial: false,
        warnings: []
      };
    }
  };
  await withServer(service, async (baseUrl) => {
    const response = await fetch(`${baseUrl}/api/robinhood/overview`);
    const body = await response.json();
    assert.equal(response.status, 200);
    assert.deepEqual(body.counts, { wallets: 1, winners: 2, candidates: 2 });
    assert.equal(body.winnerCount, 2);
  });
});

test('standalone deployment server exposes a repeatable single-token Holder rescan', async () => {
  const received = [];
  const service = {
    rescanManualWinner(address, options) {
      received.push({ address, options });
      return { ok: true, accepted: true, alreadyRunning: false, tokenAddress: address };
    }
  };
  await withServer(service, async (baseUrl) => {
    const response = await fetch(`${baseUrl}/api/robinhood/winners/${token}/rescan`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ minEntryUsd: 325 })
    });
    assert.equal(response.status, 202);
    assert.equal((await response.json()).tokenAddress, token);
    assert.deepEqual(received, [{ address: token, options: { minEntryUsd: 325 } }]);

    const invalidMinimum = await fetch(`${baseUrl}/api/robinhood/winners/${token}/rescan`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ minEntryUsd: -1 })
    });
    assert.equal(invalidMinimum.status, 400);
    assert.equal((await invalidMinimum.json()).code, 'INVALID_SCAN_OPTIONS');

    const wrongMethod = await fetch(`${baseUrl}/api/robinhood/winners/${token}/rescan`);
    assert.equal(wrongMethod.status, 405);

    const removedHistoryJob = await fetch(`${baseUrl}/api/robinhood/jobs/history`, { method: 'POST' });
    assert.equal(removedHistoryJob.status, 404);
    const removedWalletHistory = await fetch(`${baseUrl}/api/robinhood/wallets/${wallet}/history`, { method: 'POST' });
    assert.equal(removedWalletHistory.status, 404);
  });
});

test('standalone wallet routes merge filters and expose validated PATCH and DELETE operations', async () => {
  let receivedFilters;
  let receivedPatch;
  let deletes = 0;
  const service = {
    getDashboard(filters) {
      receivedFilters = filters;
      return {
        ok: true,
        status: 'ready',
        wallets: [{ address: wallet, alias: 'Desk alpha', status: 'watch' }],
        winners: [],
        jobs: [],
        updatedAt: '2026-07-10T12:00:00.000Z',
        stale: false,
        partial: false,
        warnings: [],
        filters
      };
    },
    updateWallet(address, patch) {
      receivedPatch = { address, patch };
      return { ok: true, wallet: { address, ...patch } };
    },
    deleteWallet(address) {
      deletes += 1;
      return { ok: true, deleted: true, excluded: true, alreadyExcluded: deletes > 1, wallet: { address } };
    }
  };

  await withServer(service, async (baseUrl) => {
    const list = await fetch(`${baseUrl}/api/robinhood/wallets?tab=all&search=desk&tag=repeat-hit&status=watch&monitorTier=core`);
    assert.equal(list.status, 200);
    assert.equal((await list.json()).wallets[0].alias, 'Desk alpha');
    assert.equal(receivedFilters.search, 'desk');
    assert.deepEqual(receivedFilters.tags, ['repeat-hit']);
    assert.equal(receivedFilters.monitorTier, 'core');

    const invalid = await fetch(`${baseUrl}/api/robinhood/wallets/${wallet}`, {
      method: 'PATCH',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ status: 'deleted' })
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

    const updated = await fetch(`${baseUrl}/api/robinhood/wallets/${wallet}`, {
      method: 'PATCH',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({
        alias: 'Desk alpha',
        tags: ['repeat-hit'],
        status: 'watch',
        classificationOverride: 'realized',
        monitorTier: 'high_frequency'
      })
    });
    assert.equal(updated.status, 200);
    assert.deepEqual(receivedPatch, {
      address: wallet,
      patch: {
        alias: 'Desk alpha',
        tags: ['repeat-hit'],
        status: 'watch',
        classificationOverride: 'realized',
        monitorTier: 'high_frequency'
      }
    });

    const firstDelete = await fetch(`${baseUrl}/api/robinhood/wallets/${wallet}`, { method: 'DELETE' });
    const secondDelete = await fetch(`${baseUrl}/api/robinhood/wallets/${wallet}`, { method: 'DELETE' });
    assert.equal(firstDelete.status, 200);
    assert.equal((await firstDelete.json()).alreadyExcluded, false);
    assert.equal((await secondDelete.json()).alreadyExcluded, true);
  });
});

test('standalone refresh endpoint reports manual-only mode without accepting discovery work', async () => {
  const service = {
    triggerRefresh() {
      return { ok: true, accepted: false, status: 'manual-only', discovery: 'disabled' };
    }
  };
  await withServer(service, async (baseUrl) => {
    const response = await fetch(`${baseUrl}/api/robinhood/refresh`, { method: 'POST' });
    assert.equal(response.status, 200);
    assert.deepEqual(await response.json(), {
      ok: true,
      accepted: false,
      status: 'manual-only',
      discovery: 'disabled'
    });
  });
});

test('standalone monitor routes expose snapshots, incremental events, and validated persistent settings', async () => {
  const updates = [];
  const barkTargets = [];
  const event = {
    id: 7,
    walletAddress: wallet,
    tokenAddress: '0x1111111111111111111111111111111111111111',
    txHash: `0x${'12'.repeat(32)}`
  };
  const monitor = {
    getSnapshot() {
      return {
        ok: true,
        status: 'live',
        settings: {
          enabled: true,
          threshold: updates.at(-1)?.threshold || 3,
          windowSeconds: updates.at(-1)?.windowSeconds || 60,
          sound: 'alarm',
          volume: 70,
          barkSound: 'alarm',
          barkVolume: 5
        },
        health: { monitoredWallets: 1 },
        events: [event],
        clusters: [],
        alertedTokenAddresses: [token]
      };
    },
    getEvents(options) {
      assert.deepEqual(options, { after: 5, limit: 20 });
      return [event];
    },
    updateSettings(patch) {
      updates.push(patch);
      return this.getSnapshot();
    },
    listBarkTargets() {
      return barkTargets;
    },
    createBarkTarget(payload) {
      const target = { id: 1, label: payload.label || 'Bark', endpointMasked: 'https://api.day.app/abcd***wxyz', enabled: true };
      barkTargets.push(target);
      return target;
    },
    updateBarkTarget(id, patch) {
      if (id !== 1) return null;
      Object.assign(barkTargets[0], patch);
      return barkTargets[0];
    },
    deleteBarkTarget(id) {
      if (id !== 1) return false;
      barkTargets.length = 0;
      return true;
    },
    async testBarkTarget(id) {
      return id === 1 ? barkTargets[0] : null;
    },
    subscribe() {
      return () => {};
    },
    close() {}
  };

  await withServer({}, async (baseUrl) => {
    const snapshot = await fetch(`${baseUrl}/api/robinhood/monitor`);
    assert.equal(snapshot.status, 200);
    const snapshotBody = await snapshot.json();
    assert.equal(snapshotBody.events[0].id, 7);
    assert.deepEqual(snapshotBody.alertedTokenAddresses, [token]);

    for (const windowSeconds of [4, 3_601, 5.5, '120']) {
      const invalidWindow = await fetch(`${baseUrl}/api/robinhood/monitor/settings`, {
        method: 'PATCH',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ windowSeconds })
      });
      assert.equal(invalidWindow.status, 400);
      assert.equal((await invalidWindow.json()).code, 'INVALID_MONITOR_SETTINGS');
    }

    const invalid = await fetch(`${baseUrl}/api/robinhood/monitor/settings`, {
      method: 'PATCH',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ threshold: 0 })
    });
    assert.equal(invalid.status, 400);
    assert.equal((await invalid.json()).code, 'INVALID_MONITOR_SETTINGS');

    const settings = await fetch(`${baseUrl}/api/robinhood/monitor/settings`, {
      method: 'PATCH',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ enabled: true, threshold: 8, windowSeconds: 120, sound: 'bell', volume: 35, barkSound: 'chime', barkVolume: 8 })
    });
    assert.equal(settings.status, 200);
    assert.deepEqual(updates, [{ enabled: true, threshold: 8, windowSeconds: 120, sound: 'bell', volume: 35, barkSound: 'chime', barkVolume: 8 }]);
    const savedSettings = await settings.json();
    assert.equal(savedSettings.settings.threshold, 8);
    assert.equal(savedSettings.settings.windowSeconds, 120);

    const events = await fetch(`${baseUrl}/api/robinhood/monitor/events?after=5&limit=20`);
    assert.equal(events.status, 200);
    assert.deepEqual(await events.json(), {
      ok: true,
      status: 'live',
      settings: { enabled: true, threshold: 8, windowSeconds: 120, sound: 'alarm', volume: 70, barkSound: 'alarm', barkVolume: 5 },
      health: { monitoredWallets: 1 },
      clusters: [],
      alertedTokenAddresses: [token],
      barkTargets: [],
      events: [event],
      after: 5,
      latestId: 7
    });

    const created = await fetch(`${baseUrl}/api/robinhood/monitor/bark`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ endpoint: 'device_key', label: 'Phone' })
    });
    assert.equal(created.status, 201);
    assert.equal((await created.json()).target.endpointMasked, 'https://api.day.app/abcd***wxyz');

    const list = await fetch(`${baseUrl}/api/robinhood/monitor/bark`);
    assert.equal((await list.json()).barkTargets.length, 1);
    const paused = await fetch(`${baseUrl}/api/robinhood/monitor/bark/1`, {
      method: 'PATCH',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ enabled: false })
    });
    assert.equal((await paused.json()).target.enabled, false);
    assert.equal((await fetch(`${baseUrl}/api/robinhood/monitor/bark/1/test`, { method: 'POST' })).status, 200);
    assert.equal((await fetch(`${baseUrl}/api/robinhood/monitor/bark/1`, { method: 'DELETE' })).status, 200);
  }, monitor);
});

test('standalone startup wires the holder-first scanner and its two data clients', async (t) => {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'robinhood-holder-server-'));
  t.after(() => fs.rmSync(directory, { recursive: true, force: true }));
  const running = await startRobinhoodStandaloneServer(
    {
      HOST: '127.0.0.1',
      PORT: '0',
      ROBINHOOD_DATA_FILE: path.join(directory, 'radar.sqlite'),
      ROBINHOOD_PUBLIC_DIR: path.resolve('public')
    },
    {
      monitorRpcClient: {
        async getBlockNumber() {
          return 100;
        },
        async getLogs() {
          return [];
        }
      }
    }
  );
  try {
    assert.equal(running.service.scanToken, scanTokenHolders);
    assert.equal(running.service.debotClient instanceof RobinhoodDebotClient, true);
    assert.equal(running.service.holderClient instanceof RobinhoodHolderClient, true);
    assert.equal(running.monitor.getSnapshot().health.running, true);
  } finally {
    running.service.close();
    running.monitor.close();
    await new Promise((resolve) => running.server.close(resolve));
    running.store.close();
  }
});
