import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

import { BASE_CHAIN } from '../src/base/config.js';
import { BaseMarketClient } from '../src/base/marketClient.js';
import {
  BASE_ADDRESS_CODEC,
  BASE_API_PREFIX,
  BASE_MONITOR_PROFILE,
  createBaseRuntimeConfig,
  scanBaseTokenHolders,
  startBaseStandaloneServer
} from '../src/base/server.js';
import { RobinhoodDebotClient } from '../src/robinhood/debotClient.js';
import { RobinhoodHolderClient } from '../src/robinhood/holderClient.js';
import { createRobinhoodStore } from '../src/robinhood/store.js';

const wallet = '0xaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa';

test('Base runtime defaults and tuning are independent from Robinhood environment values', () => {
  const defaults = createBaseRuntimeConfig({});
  assert.equal(defaults.chainId, 'base');
  assert.equal(defaults.chainLabel, 'Base');
  assert.equal(defaults.rpcUrl, BASE_CHAIN.rpcUrl);
  assert.equal(defaults.blockscoutApiUrl, BASE_CHAIN.blockscoutApiUrl);
  assert.equal(defaults.port, 18119);
  assert.equal(defaults.noxaLaunchFactory, null);
  assert.deepEqual(defaults.quoteTokenAddresses, [BASE_CHAIN.weth, BASE_CHAIN.usdc]);
  assert.equal(BASE_MONITOR_PROFILE.debotTokenRoot, 'https://debot.ai/token/base/');
  assert.equal(BASE_ADDRESS_CODEC.chainId, 'base');
  assert.match(defaults.dataFile, /data\/base\.sqlite$/);

  const configured = createBaseRuntimeConfig({
    ROBINHOOD_RPC_URL: 'https://must-not-leak.example',
    ROBINHOOD_MONITOR_POLL_INTERVAL_MS: '9999',
    BASE_RPC_URL: 'https://base-rpc.example',
    BASE_MONITOR_POLL_INTERVAL_MS: '750',
    BASE_PORT: '19019',
    BASE_SCAN_CONCURRENCY: '99'
  });
  assert.equal(configured.rpcUrl, 'https://base-rpc.example');
  assert.equal(configured.monitorPollIntervalMs, 750);
  assert.equal(configured.port, 19019);
  assert.equal(configured.scanConcurrency, 8);
});

test('starts an isolated Base API, scanner, monitor, Bark store, and database', async (t) => {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'base-radar-server-'));
  const baseDataFile = path.join(directory, 'base.sqlite');
  const robinhoodDataFile = path.join(directory, 'robinhood.sqlite');
  t.after(() => fs.rmSync(directory, { recursive: true, force: true }));
  const running = await startBaseStandaloneServer(
    {
      BASE_HOST: '127.0.0.1',
      BASE_PORT: '0',
      BASE_DATA_FILE: baseDataFile
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
  const robinhoodStore = createRobinhoodStore(robinhoodDataFile);
  try {
    const baseUrl = `http://127.0.0.1:${running.port}`;
    assert.equal(BASE_API_PREFIX, '/api/base');
    assert.equal(running.store.chainId, 'base');
    assert.equal(running.store.chainLabel, 'Base');
    assert.equal(running.config.dataFile, baseDataFile);
    assert.equal(running.service.chainId, 'base');
    assert.equal(running.service.scanToken, scanBaseTokenHolders);
    assert.equal(running.debotClient instanceof RobinhoodDebotClient, true);
    assert.equal(running.debotClient.chain, 'base');
    assert.equal(running.marketDataClient instanceof BaseMarketClient, true);
    assert.equal(running.monitor.debotClient, running.marketDataClient);
    assert.equal(running.holderClient instanceof RobinhoodHolderClient, true);
    assert.equal(running.holderClient.baseUrl, BASE_CHAIN.blockscoutApiUrl);
    assert.equal(running.monitor.chainProfile.id, 'base');
    assert.equal(running.monitor.chainProfile.explorerUrl, BASE_CHAIN.explorerUrl);
    assert.equal(running.monitor.noxaLaunchFactory, '');
    assert.deepEqual([...running.monitor.quoteTokenAddresses].sort(), [...BASE_CHAIN.quoteTokens].sort());
    assert.equal(running.barkNotifier.brand, 'Base');
    assert.equal(running.monitor.getSnapshot({ eventLimit: 0 }).chain, 'base');

    const overview = await fetch(`${baseUrl}/api/base/overview`);
    assert.equal(overview.status, 200);
    const overviewBody = await overview.json();
    assert.equal(overviewBody.chain, 'base');
    assert.equal(overviewBody.status, 'empty');

    const imported = await fetch(`${baseUrl}/api/base/wallets/batch`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ lines: `${wallet},Base only` })
    });
    assert.equal(imported.status, 200);
    assert.equal((await imported.json()).created, 1);
    assert.equal(running.store.getWalletAnnotation(wallet).note, 'Base only');
    assert.equal(robinhoodStore.getWalletAnnotation(wallet), null);

    const monitorSettings = await fetch(`${baseUrl}/api/base/monitor/settings`, {
      method: 'PATCH',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ threshold: 9 })
    });
    assert.equal(monitorSettings.status, 200);
    assert.equal((await monitorSettings.json()).settings.threshold, 9);
    assert.equal(robinhoodStore.getMeta('robinhood:monitor:threshold'), null);

    const wrongChain = await fetch(`${baseUrl}/api/robinhood/overview`);
    assert.equal(wrongChain.status, 404);
    assert.equal((await wrongChain.json()).code, 'NOT_FOUND');
    const publicRoot = await fetch(`${baseUrl}/`);
    assert.equal(publicRoot.status, 404);
    assert.equal((await publicRoot.json()).code, 'NOT_FOUND');
  } finally {
    running.service.close();
    running.monitor.close();
    await new Promise((resolve) => running.server.close(resolve));
    running.store.close();
    robinhoodStore.close();
  }
});
