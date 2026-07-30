import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

import { BSC_CHAIN } from '../src/bsc/config.js';
import { BscDebotHolderClient } from '../src/bsc/debotHolderClient.js';
import { BscHolderClient } from '../src/bsc/holderClient.js';
import { BscMarketClient } from '../src/bsc/marketClient.js';
import {
  BSC_ADDRESS_CODEC,
  BSC_API_PREFIX,
  BSC_MONITOR_PROFILE,
  assertBscMonitorRpcCapabilities,
  assertBscRpcChain,
  createBscRuntimeConfig,
  scanBscTokenHolders,
  startBscStandaloneServer
} from '../src/bsc/server.js';
import { RobinhoodDebotClient } from '../src/robinhood/debotClient.js';
import { createRobinhoodStore } from '../src/robinhood/store.js';

const wallet = '0xaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa';
const bscToken = '0x1111111111111111111111111111111111111111';

function capableBscMonitorRpc() {
  const probeHash = `0x${'9'.repeat(64)}`;
  return {
    async getBlockNumber() {
      return 100;
    },
    async getLogs() {
      return [];
    },
    async request(method) {
      if (method === 'eth_chainId') return '0x38';
      if (method === 'eth_blockNumber') return '0x64';
      if (method === 'eth_getBlockByNumber') return { transactions: [probeHash] };
      if (method === 'eth_getCode') return '0x';
      return '0x';
    },
    async batchRequest(calls) {
      return calls.map(({ method }) => {
        if (method === 'eth_getTransactionByHash') return { hash: probeHash, from: wallet };
        if (method === 'eth_getTransactionReceipt') {
          return { transactionHash: probeHash, status: '0x1', logs: [] };
        }
        if (method === 'eth_getCode') return '0x';
        throw new Error(`Unexpected batch method ${method}`);
      });
    }
  };
}

function capableBscHolderRpc(rpcUrl = '') {
  const rpc = capableBscMonitorRpc();
  if (rpcUrl) rpc.rpcUrl = rpcUrl;
  rpc.call = async () => '0x0';
  rpc.findBlockByTimestamp = async () => 0;
  return rpc;
}

async function closeBscServer(running) {
  running.service.close();
  running.monitor.close();
  await new Promise((resolve) => running.server.close(resolve));
  running.store.close();
}

test('BSC runtime defaults and tuning are isolated from other chain environments', () => {
  const defaults = createBscRuntimeConfig({});
  assert.equal(defaults.chainId, 'bsc');
  assert.equal(defaults.chainLabel, 'BSC');
  assert.equal(defaults.rpcUrl, BSC_CHAIN.rpcUrl);
  assert.equal(defaults.holderRpcUrl, '');
  assert.equal(defaults.holderLogRpcUrl, '');
  assert.equal(defaults.port, 18122);
  assert.equal(defaults.noxaLaunchFactory, null);
  assert.deepEqual(defaults.quoteTokenAddresses, BSC_CHAIN.quoteTokens);
  assert.equal(BSC_MONITOR_PROFILE.debotTokenRoot, 'https://debot.ai/token/bsc/289942_');
  assert.equal(BSC_ADDRESS_CODEC.chainId, 'bsc');
  assert.match(defaults.dataFile, /data\/bsc\.sqlite$/);
  assert.equal(defaults.holderLogWindow, 2_000);
  assert.equal(defaults.holderLogConcurrency, 2);
  assert.equal(defaults.holderLogResultGuard, 1_000);
  assert.equal(defaults.holderMaxTransferLogs, 100_000);
  assert.equal(defaults.holderMaxBlockSpan, 5_000_000);
  assert.equal(defaults.holderCreationSafetySeconds, 86_400);
  assert.equal(defaults.monitorMaxBlockSpan, 10);
  assert.equal(defaults.allowSharedRpcEndpoint, false);

  const configured = createBscRuntimeConfig({
    ROBINHOOD_RPC_URL: 'https://must-not-leak.example',
    BASE_RPC_URL: 'https://also-must-not-leak.example',
    SOLANA_RPC_URL: 'https://also-must-not-leak.example',
    ROBINHOOD_MONITOR_POLL_INTERVAL_MS: '9999',
    BSC_RPC_URL: 'https://bsc-rpc.example',
    BSC_HOLDER_RPC_URL: 'https://bsc-holder-rpc.example',
    BSC_HOLDER_LOG_RPC_URL: 'https://bsc-holder-logs.example',
    BSC_ALLOW_SHARED_RPC_ENDPOINT: 'true',
    BSC_MONITOR_POLL_INTERVAL_MS: '750',
    BSC_PORT: '19021',
    BSC_SCAN_CONCURRENCY: '99',
    BSC_HOLDER_LOG_WINDOW: '999999',
    BSC_HOLDER_LOG_CONCURRENCY: '99',
    BSC_HOLDER_MAX_TRANSFER_LOGS: '500'
  });
  assert.equal(configured.rpcUrl, 'https://bsc-rpc.example');
  assert.equal(configured.holderRpcUrl, 'https://bsc-holder-rpc.example');
  assert.equal(configured.holderLogRpcUrl, 'https://bsc-holder-logs.example');
  assert.equal(configured.allowSharedRpcEndpoint, true);
  assert.equal(configured.monitorPollIntervalMs, 750);
  assert.equal(configured.port, 19021);
  assert.equal(configured.scanConcurrency, 8);
  assert.equal(configured.holderLogWindow, 20_000);
  assert.equal(configured.holderLogConcurrency, 4);
  assert.equal(configured.holderMaxTransferLogs, 1_000);
});

test('starts an isolated BSC API, smart-wallet scanner, monitor, Bark store, and database', async (t) => {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'bsc-radar-server-'));
  const bscDataFile = path.join(directory, 'bsc.sqlite');
  const robinhoodDataFile = path.join(directory, 'robinhood.sqlite');
  const probeHash = `0x${'1'.repeat(64)}`;
  t.after(() => fs.rmSync(directory, { recursive: true, force: true }));
  const rpcStub = () => ({
    async getBlockNumber() {
      return 100;
    },
    async getLogs() {
      return [];
    },
    async request(method) {
      if (method === 'eth_chainId') return '0x38';
      if (method === 'eth_blockNumber') return '0x64';
      if (method === 'eth_getBlockByNumber') return { transactions: [probeHash] };
      return '0x';
    },
    async batchRequest(calls) {
      return calls.map(({ method }) => method === 'eth_getTransactionByHash'
        ? { hash: probeHash, from: wallet }
        : { transactionHash: probeHash, status: '0x1', logs: [] });
    },
    async call() {
      return '0x0';
    },
    async findBlockByTimestamp() {
      return 0;
    }
  });
  const monitorRpcClient = rpcStub();
  const holderRpcClient = rpcStub();
  const running = await startBscStandaloneServer(
    {
      BSC_HOST: '127.0.0.1',
      BSC_PORT: '0',
      BSC_DATA_FILE: bscDataFile
    },
    {
      monitorRpcClient,
      holderRpcClient
    }
  );
  const robinhoodStore = createRobinhoodStore(robinhoodDataFile);
  try {
    const baseUrl = `http://127.0.0.1:${running.port}`;
    assert.equal(BSC_API_PREFIX, '/api/bsc');
    assert.equal(running.store.chainId, 'bsc');
    assert.equal(running.store.chainLabel, 'BSC');
    assert.equal(running.config.dataFile, bscDataFile);
    assert.equal(running.service.chainId, 'bsc');
    assert.equal(running.service.scanToken, scanBscTokenHolders);
    assert.equal(running.debotClient instanceof RobinhoodDebotClient, true);
    assert.equal(running.debotClient.chain, 'bsc');
    assert.equal(running.marketDataClient instanceof BscMarketClient, true);
    assert.equal(running.monitor.debotClient, running.marketDataClient);
    assert.equal(running.monitor.riskClient, null);
    assert.equal(running.holderClient instanceof BscHolderClient, true);
    assert.equal(running.rpcClient, monitorRpcClient);
    assert.equal(running.holderRpcClient, holderRpcClient);
    assert.equal(running.holderLogRpcClient, holderRpcClient);
    assert.equal(running.holderClient.rpcClient, holderRpcClient);
    assert.equal(running.holderClient.logRpcClient, holderRpcClient);
    assert.notEqual(running.holderClient.rpcClient, running.rpcClient);
    assert.equal(running.holderClient.debotClient, running.debotClient);
    assert.equal(running.holderClient.creationTimeClient, running.marketDataClient);
    assert.equal(running.monitor.chainProfile.id, 'bsc');
    assert.equal(running.monitor.chainProfile.explorerUrl, BSC_CHAIN.explorerUrl);
    assert.equal(running.monitor.noxaLaunchFactory, '');
    assert.equal(running.monitor.swapTopics.has(BSC_CHAIN.swapTopics[0]), true);
    assert.equal(running.monitor.launchProfiles[0].platform, 'four_meme');
    assert.deepEqual([...running.monitor.quoteTokenAddresses].sort(), [...BSC_CHAIN.quoteTokens].sort());
    assert.equal(running.barkNotifier.brand, 'BSC');
    assert.equal(running.monitor.getSnapshot({ eventLimit: 0 }).chain, 'bsc');

    const overview = await fetch(`${baseUrl}/api/bsc/overview`);
    assert.equal(overview.status, 200);
    const overviewBody = await overview.json();
    assert.equal(overviewBody.chain, 'bsc');
    assert.equal(overviewBody.status, 'empty');

    const imported = await fetch(`${baseUrl}/api/bsc/wallets/batch`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ lines: `${wallet},BSC only` })
    });
    assert.equal(imported.status, 200);
    assert.equal((await imported.json()).created, 1);
    assert.equal(running.store.getWalletAnnotation(wallet).note, 'BSC only');
    assert.equal(robinhoodStore.getWalletAnnotation(wallet), null);

    const monitorSettings = await fetch(`${baseUrl}/api/bsc/monitor/settings`, {
      method: 'PATCH',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ threshold: 9 })
    });
    assert.equal(monitorSettings.status, 200);
    assert.equal((await monitorSettings.json()).settings.threshold, 9);
    assert.equal(robinhoodStore.getMeta('robinhood:monitor:threshold'), null);

    for (const otherChain of ['robinhood', 'base', 'solana']) {
      const wrongChain = await fetch(`${baseUrl}/api/${otherChain}/overview`);
      assert.equal(wrongChain.status, 404);
      assert.equal((await wrongChain.json()).code, 'NOT_FOUND');
    }
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

test('creates and wires a configured BSC Holder log RPC independently', async (t) => {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'bsc-radar-holder-log-rpc-'));
  const dataFile = path.join(directory, 'bsc.sqlite');
  const logRpcUrl = 'https://bsc-holder-logs.example/v1';
  const logRequests = [];
  const fetchImpl = async (input, init = {}) => {
    assert.equal(String(input), logRpcUrl);
    const body = JSON.parse(init.body);
    logRequests.push(body);
    return new Response(JSON.stringify({
      jsonrpc: '2.0',
      id: body.id,
      result: '0x38'
    }), { status: 200, headers: { 'content-type': 'application/json' } });
  };
  t.after(() => fs.rmSync(directory, { recursive: true, force: true }));

  const holderRpcClient = capableBscHolderRpc('https://bsc-holder-state.example/v1');
  const running = await startBscStandaloneServer({
    BSC_HOST: '127.0.0.1',
    BSC_PORT: '0',
    BSC_DATA_FILE: dataFile,
    BSC_HOLDER_LOG_RPC_URL: logRpcUrl
  }, {
    monitorRpcClient: capableBscMonitorRpc(),
    holderRpcClient,
    fetchImpl
  });
  try {
    assert.equal(running.holderRpcClient, holderRpcClient);
    assert.equal(running.holderClient.rpcClient, holderRpcClient);
    assert.notEqual(running.holderLogRpcClient, holderRpcClient);
    assert.equal(running.holderLogRpcClient.rpcUrl, logRpcUrl);
    assert.equal(running.holderClient.logRpcClient, running.holderLogRpcClient);
    assert.deepEqual(logRequests.map((request) => request.method), ['eth_chainId']);
  } finally {
    await closeBscServer(running);
  }
});

test('preserves injected RPC identities when only monitor and Holder state share a URL', async (t) => {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'bsc-radar-shared-state-rpc-'));
  const dataFile = path.join(directory, 'bsc.sqlite');
  const sharedStateUrl = 'https://shared-bsc-state.example/v1';
  const monitorRpcClient = capableBscMonitorRpc();
  monitorRpcClient.rpcUrl = `${sharedStateUrl}/`;
  const holderRpcClient = capableBscHolderRpc(sharedStateUrl);
  const holderLogRpcClient = {
    rpcUrl: 'https://independent-bsc-logs.example/v1',
    request: async () => '0x38'
  };
  t.after(() => fs.rmSync(directory, { recursive: true, force: true }));

  const running = await startBscStandaloneServer({
    BSC_HOST: '127.0.0.1',
    BSC_PORT: '0',
    BSC_DATA_FILE: dataFile,
    BSC_ALLOW_SHARED_RPC_ENDPOINT: 'true'
  }, {
    monitorRpcClient,
    holderRpcClient,
    holderLogRpcClient
  });
  try {
    assert.equal(running.rpcClient, monitorRpcClient);
    assert.equal(running.holderRpcClient, holderRpcClient);
    assert.equal(running.holderLogRpcClient, holderLogRpcClient);
    assert.equal(running.holderClient.rpcClient, holderRpcClient);
    assert.equal(running.holderClient.logRpcClient, holderLogRpcClient);
  } finally {
    await closeBscServer(running);
  }
});

test('allows Holder state and log clients to share one normalized endpoint', async (t) => {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'bsc-radar-shared-holder-rpc-'));
  const dataFile = path.join(directory, 'bsc.sqlite');
  const holderUrl = 'https://shared-holder.example/v1';
  const monitorRpcClient = capableBscMonitorRpc();
  monitorRpcClient.rpcUrl = 'https://independent-monitor.example/v1';
  const holderRpcClient = capableBscHolderRpc(`${holderUrl}/`);
  const holderLogRpcClient = {
    rpcUrl: holderUrl,
    request: async () => '0x38'
  };
  t.after(() => fs.rmSync(directory, { recursive: true, force: true }));

  const running = await startBscStandaloneServer({
    BSC_HOST: '127.0.0.1',
    BSC_PORT: '0',
    BSC_DATA_FILE: dataFile
  }, {
    monitorRpcClient,
    holderRpcClient,
    holderLogRpcClient
  });
  try {
    assert.equal(running.holderRpcClient, holderRpcClient);
    assert.equal(running.holderLogRpcClient, holderLogRpcClient);
  } finally {
    await closeBscServer(running);
  }
});

test('wires the default BSC token-detail and wallet-profit client through the loopback bridge', async (t) => {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'bsc-radar-analysis-bridge-'));
  const dataFile = path.join(directory, 'bsc.sqlite');
  const bridgeCalls = [];
  const directCalls = [];
  const fetchImpl = async (input, init = {}) => {
    const url = String(input);
    if (url === 'http://127.0.0.1:18118/internal/debot/request') {
      const request = JSON.parse(init.body);
      bridgeCalls.push(request);
      if (request.type === 'debot.token_detail.v1') {
        return new Response(JSON.stringify({
          ok: true,
          result: {
            schema: 'debot.token_detail.raw.v1',
            data: {
              token: {
                meta: {
                  chain: 'bsc',
                  address: bscToken,
                  symbol: 'TEST',
                  name: 'Bridge test'
                }
              },
              pair: { chain: 'bsc', tokenAddress: bscToken }
            }
          }
        }), { status: 200, headers: { 'content-type': 'application/json' } });
      }
      if (request.type === 'debot.wallet_token_analysis.v1') {
        return new Response(JSON.stringify({
          ok: true,
          result: {
            schema: 'debot.wallet_token_analysis.raw.v1',
            data: {
              chain: 'bsc',
              token: bscToken,
              wallet,
              buy_amount: 10,
              buy_volume: 5,
              position: 10,
              balance: 15
            }
          }
        }), { status: 200, headers: { 'content-type': 'application/json' } });
      }
      throw new Error(`Unexpected bridge job ${request.type}`);
    }
    directCalls.push(url);
    return new Response(JSON.stringify({ code: 0, data: {} }), {
      status: 200,
      headers: { 'content-type': 'application/json' }
    });
  };
  t.after(() => fs.rmSync(directory, { recursive: true, force: true }));

  const running = await startBscStandaloneServer({
    BSC_HOST: '127.0.0.1',
    BSC_PORT: '0',
    BSC_DATA_FILE: dataFile
  }, {
    monitorRpcClient: capableBscMonitorRpc(),
    holderClient: { async fetchTopHolders() { return { token: {}, holders: [] }; } },
    fetchImpl
  });
  try {
    const detail = await running.debotClient.fetchTokenDetail(bscToken);
    const profit = await running.debotClient.fetchWalletTokenProfit(bscToken, wallet);
    await running.debotClient.fetchTokenMetrics(bscToken);

    assert.equal(running.debotClient instanceof RobinhoodDebotClient, true);
    assert.equal(running.debotClient.chain, 'bsc');
    assert.equal(running.debotClient.timeoutMs, running.config.debotRequestTimeoutMs);
    assert.equal(running.service.debotClient, running.debotClient);
    assert.equal(running.holderLogRpcClient, null);
    assert.equal(detail.address, bscToken);
    assert.equal(detail.symbol, 'TEST');
    assert.equal(profit.address, wallet);
    assert.equal(profit.tokenAddress, bscToken);
    assert.equal(profit.totalProfitUsd, 10);
    assert.deepEqual(bridgeCalls, [
      { type: 'debot.token_detail.v1', payload: { chain: 'bsc', token: bscToken } },
      {
        type: 'debot.wallet_token_analysis.v1',
        payload: { chain: 'bsc', token: bscToken, wallet }
      }
    ]);
    assert.deepEqual(directCalls, [
      `https://debot.ai/api/dashboard/token/market/metrics?chain=bsc&token=${bscToken}`
    ]);
  } finally {
    running.service.close();
    running.monitor.close();
    await new Promise((resolve) => running.server.close(resolve));
    running.store.close();
  }
});

test('creates a bridge-backed Holder profile client when an injected DeBot client lacks that method', async (t) => {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'bsc-radar-injected-debot-'));
  const dataFile = path.join(directory, 'bsc.sqlite');
  const injectedCalls = [];
  const injectedDebotClient = {
    async fetchTokenDetail(address) {
      injectedCalls.push({ type: 'detail', address });
      return { source: 'injected-detail' };
    },
    async fetchWalletTokenProfit(address, walletAddress) {
      injectedCalls.push({ type: 'profit', address, wallet: walletAddress });
      return { source: 'injected-profit' };
    },
    async fetchTokenMetrics() {
      return {};
    }
  };
  const bridgeCalls = [];
  const fetchImpl = async (input, init) => {
    bridgeCalls.push({ url: String(input), init });
    return new Response(JSON.stringify({
      ok: true,
      result: {
        schema: 'debot.token_holders.raw.v1',
        data: { chain: 'bsc', token: bscToken, total: 0, list: [] }
      }
    }), { status: 200, headers: { 'content-type': 'application/json' } });
  };
  t.after(() => fs.rmSync(directory, { recursive: true, force: true }));

  const running = await startBscStandaloneServer({
    BSC_HOST: '127.0.0.1',
    BSC_PORT: '0',
    BSC_DATA_FILE: dataFile
  }, {
    monitorRpcClient: capableBscMonitorRpc(),
    debotClient: injectedDebotClient,
    fetchImpl
  });
  try {
    assert.equal(running.debotClient, injectedDebotClient);
    assert.equal(running.service.debotClient, injectedDebotClient);
    assert.equal(running.holderProfileDebotClient instanceof RobinhoodDebotClient, true);
    assert.notEqual(running.holderProfileDebotClient, injectedDebotClient);
    assert.equal(running.holderProfileDebotClient.chain, 'bsc');
    assert.equal(running.holderClient instanceof BscDebotHolderClient, true);
    assert.equal(running.holderClient.debotClient, running.holderProfileDebotClient);
    assert.equal(running.holderClient.rpcClient, running.rpcClient);
    assert.deepEqual(await running.debotClient.fetchTokenDetail(bscToken), {
      source: 'injected-detail'
    });
    assert.deepEqual(await running.debotClient.fetchWalletTokenProfit(bscToken, wallet), {
      source: 'injected-profit'
    });
    assert.deepEqual(injectedCalls, [
      { type: 'detail', address: bscToken },
      { type: 'profit', address: bscToken, wallet }
    ]);
    assert.deepEqual(
      await running.holderProfileDebotClient.fetchTokenHolderProfile(bscToken, { limit: 1 }),
      { chain: 'bsc', token: bscToken, total: 0, list: [] }
    );
    assert.equal(bridgeCalls.length, 1);
    assert.equal(bridgeCalls[0].url, 'http://127.0.0.1:18118/internal/debot/request');
    assert.deepEqual(JSON.parse(bridgeCalls[0].init.body), {
      type: 'debot.token_holders.v1',
      payload: { chain: 'bsc', token: bscToken, pageSize: 1 }
    });
  } finally {
    running.service.close();
    running.monitor.close();
    await new Promise((resolve) => running.server.close(resolve));
    running.store.close();
  }
});

test('rejects a wrong-chain BSC RPC before creating the database', async () => {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'bsc-radar-wrong-chain-'));
  const dataFile = path.join(directory, 'bsc.sqlite');
  try {
    await assert.rejects(
      startBscStandaloneServer(
        { BSC_HOST: '127.0.0.1', BSC_PORT: '0', BSC_DATA_FILE: dataFile },
        { monitorRpcClient: { request: async () => '0x1' } }
      ),
      (error) => error?.code === 'BSC_RPC_CHAIN_MISMATCH' && /eth_chainId 0x38/.test(error.message)
    );
    assert.equal(fs.existsSync(dataFile), false);
  } finally {
    fs.rmSync(directory, { recursive: true, force: true });
  }
});

test('validates BSC RPC chain identifiers strictly', async () => {
  assert.equal(await assertBscRpcChain({ request: async () => '0x38' }), '0x38');
  for (const invalid of ['0x1', '0x038', '56', 'not-a-chain', null]) {
    await assert.rejects(
      assertBscRpcChain({ request: async () => invalid }),
      (error) => error?.code === 'BSC_RPC_CHAIN_MISMATCH'
    );
  }
});

test('validates the recent transaction and receipt capabilities used by the BSC monitor', async () => {
  const probeHash = `0x${'2'.repeat(64)}`;
  const requestedBlocks = [];
  const result = await assertBscMonitorRpcCapabilities({
    async request(method, params) {
      if (method === 'eth_blockNumber') return '0x64';
      if (method === 'eth_getBlockByNumber') {
        requestedBlocks.push(params[0]);
        return requestedBlocks.length === 1 ? { transactions: [] } : { transactions: [probeHash] };
      }
      throw new Error(`Unexpected method ${method}`);
    },
    async batchRequest(calls) {
      assert.deepEqual(calls.map((call) => call.method), [
        'eth_getTransactionByHash',
        'eth_getTransactionReceipt'
      ]);
      return [
        { hash: probeHash, from: wallet },
        { transactionHash: probeHash, status: '0x1', logs: [] }
      ];
    }
  });
  assert.deepEqual(requestedBlocks, ['0x5f', '0x5e']);
  assert.equal(result.headBlock, 100);
  assert.equal(result.probeBlock, 94);
  assert.equal(result.transactionHash, probeHash);
});

test('rejects a receipt-incapable BSC monitor RPC before creating the database', async () => {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'bsc-radar-no-receipts-'));
  const dataFile = path.join(directory, 'bsc.sqlite');
  const probeHash = `0x${'3'.repeat(64)}`;
  try {
    await assert.rejects(
      startBscStandaloneServer(
        { BSC_HOST: '127.0.0.1', BSC_PORT: '0', BSC_DATA_FILE: dataFile },
        {
          monitorRpcClient: {
            async request(method) {
              if (method === 'eth_chainId') return '0x38';
              if (method === 'eth_blockNumber') return '0x64';
              if (method === 'eth_getBlockByNumber') return { transactions: [probeHash] };
              throw new Error(`Unexpected method ${method}`);
            },
            async batchRequest() {
              throw new Error('Archive requests require a personal token');
            }
          }
        }
      ),
      (error) => error?.code === 'BSC_MONITOR_RPC_CAPABILITY_MISMATCH' &&
        /transaction receipts/.test(error.message)
    );
    assert.equal(fs.existsSync(dataFile), false);
  } finally {
    fs.rmSync(directory, { recursive: true, force: true });
  }
});

test('rejects sharing one RPC client between live monitoring and Holder scans', async () => {
  const sharedRpc = { request: async () => '0x38' };
  await assert.rejects(
    startBscStandaloneServer({}, {
      monitorRpcClient: sharedRpc,
      holderRpcClient: sharedRpc
    }),
    /must use separate RPC client instances/
  );
});

test('rejects separate RPC clients that still share one normalized endpoint', async () => {
  const monitorRpc = {
    rpcUrl: 'https://shared-bsc-rpc.example/v1/',
    request: async () => '0x38'
  };
  const holderRpc = {
    rpcUrl: 'https://shared-bsc-rpc.example/v1',
    request: async () => '0x38'
  };
  await assert.rejects(
    startBscStandaloneServer({}, {
      monitorRpcClient: monitorRpc,
      holderRpcClient: holderRpc
    }),
    /must use different RPC endpoints/
  );
});

test('rejects a wrong-chain Holder log RPC before creating the BSC database', async () => {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'bsc-radar-wrong-log-chain-'));
  const dataFile = path.join(directory, 'bsc.sqlite');
  try {
    await assert.rejects(
      startBscStandaloneServer(
        { BSC_HOST: '127.0.0.1', BSC_PORT: '0', BSC_DATA_FILE: dataFile },
        {
          monitorRpcClient: capableBscMonitorRpc(),
          holderRpcClient: { request: async () => '0x38' },
          holderLogRpcClient: { request: async () => '0x1' }
        }
      ),
      (error) => error?.code === 'BSC_RPC_CHAIN_MISMATCH' &&
        /BSC Holder log RPC/.test(error.message)
    );
    assert.equal(fs.existsSync(dataFile), false);
  } finally {
    fs.rmSync(directory, { recursive: true, force: true });
  }
});

test('rejects a Holder log RPC when strict Holder state mode is disabled', async () => {
  const cases = [
    {
      name: 'configured URL',
      env: { BSC_HOLDER_LOG_RPC_URL: 'https://orphan-holder-logs.example' },
      options: {}
    },
    {
      name: 'injected client',
      env: {},
      options: { holderLogRpcClient: { request: async () => '0x38' } }
    }
  ];

  for (const scenario of cases) {
    const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'bsc-radar-orphan-log-rpc-'));
    const dataFile = path.join(directory, 'bsc.sqlite');
    try {
      await assert.rejects(
        startBscStandaloneServer(
          {
            ...scenario.env,
            BSC_HOST: '127.0.0.1',
            BSC_PORT: '0',
            BSC_DATA_FILE: dataFile
          },
          { monitorRpcClient: capableBscMonitorRpc(), ...scenario.options }
        ),
        (error) => /requires strict Holder state mode/.test(error.message),
        scenario.name
      );
      assert.equal(fs.existsSync(dataFile), false, scenario.name);
    } finally {
      fs.rmSync(directory, { recursive: true, force: true });
    }
  }
});

test('rejects sharing the live monitor client instance with Holder log reads', async () => {
  const monitorRpcClient = capableBscMonitorRpc();
  await assert.rejects(
    startBscStandaloneServer({ BSC_ALLOW_SHARED_RPC_ENDPOINT: 'true' }, {
      monitorRpcClient,
      holderRpcClient: { request: async () => '0x38' },
      holderLogRpcClient: monitorRpcClient
    }),
    /monitor and Holder log analysis must use separate RPC client instances/
  );
});

test('rejects separate monitor and Holder log clients on one normalized endpoint', async () => {
  const sharedUrl = 'https://shared-bsc-rpc.example/v1';
  const monitorRpcClient = {
    rpcUrl: `${sharedUrl}/`,
    request: async () => '0x38'
  };
  const holderRpcClient = {
    rpcUrl: 'https://bsc-holder-state.example/v1',
    request: async () => '0x38'
  };
  const holderLogRpcClient = {
    rpcUrl: sharedUrl,
    request: async () => '0x38'
  };

  await assert.rejects(
    startBscStandaloneServer({ BSC_ALLOW_SHARED_RPC_ENDPOINT: 'true' }, {
      monitorRpcClient,
      holderRpcClient,
      holderLogRpcClient
    }),
    /monitor and Holder log analysis must use different RPC endpoints/
  );
});

test('rejects redundant RPC injections when a custom Holder client is authoritative', async () => {
  const customHolderClient = {
    async fetchTopHolders() {
      return { token: {}, holders: [] };
    }
  };
  const cases = [
    { holderRpcClient: { request: async () => '0x38' } },
    { holderLogRpcClient: { request: async () => '0x38' } }
  ];

  for (const options of cases) {
    await assert.rejects(
      startBscStandaloneServer({}, {
        monitorRpcClient: capableBscMonitorRpc(),
        holderClient: customHolderClient,
        ...options
      }),
      /holderClient is authoritative; do not also inject/
    );
  }
});
