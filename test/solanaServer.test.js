import assert from 'node:assert/strict';
import test from 'node:test';

import { createRobinhoodStore } from '../src/robinhood/store.js';
import {
  SOLANA_CHAIN,
  SOLANA_ADDRESS_CODEC,
  createSolanaConfig,
  createSolanaRuntime,
  createSolanaStandaloneServer
} from '../src/solana/server.js';

const wallet = 'EgsaH8Voe7KRkZwheXFF6vWKjV5VRZGyQ6CaLeqe5KmP';
const otherWallet = '34QBSvWGEWpcz45ZfUGFGGSfK6j6P8rRnTaK7uufyVJw';
const mint = 'DGmn9wHxiPLPUgS5Ni7dje8RVtiKNaMiDzbYtZs9pump';
const signature = '25fzwvU3bzEc14ApdVNy7ybqKqUooy7st18qeUhMSixyRLK2gD4r5eGTBXCkuhq81h6vQzWFYw33PF2p1UiExvyM';

function testConfig(patch = {}) {
  return {
    ...createSolanaConfig({
      HELIUS_API_KEY: 'helius-test-key',
      SOLANA_HELIUS_WEBHOOK_URL: 'https://radar.example.test/api/solana/monitor/webhook',
      SOLANA_HELIUS_AUTH_HEADER: 'Bearer solana-hook-secret'
    }),
    dataFile: ':memory:',
    ...patch
  };
}

function fakeDebotClient() {
  return {
    async fetchTokenMetrics(address) {
      return {
        address,
        symbol: 'RUMP',
        name: 'Official Rump Coin',
        decimals: 6,
        marketCapUsd: 75_000,
        creationTimestamp: 2_000_000_000,
        updatedAt: 2_000_000_100
      };
    },
    async fetchHotTokens() {
      return [];
    }
  };
}

function fakeHolderClient() {
  return {
    async fetchTopHolders() {
      return { holders: [], source: 'test' };
    }
  };
}

function fakeHeliusFetch() {
  const webhooks = new Map();
  let nextId = 1;
  const fetchImpl = async (input, options = {}) => {
    const url = new URL(input);
    const id = url.pathname.split('/').filter(Boolean).at(-1);
    const collection = id === 'webhooks';
    if (options.method === 'POST' && collection) {
      const body = JSON.parse(options.body);
      const webhook = { ...body, webhookID: `wh_${nextId++}`, active: true };
      webhooks.set(webhook.webhookID, webhook);
      return Response.json(webhook);
    }
    if ((!options.method || options.method === 'GET') && collection) {
      return Response.json([...webhooks.values()]);
    }
    if (options.method === 'PUT') {
      const webhook = { ...webhooks.get(id), ...JSON.parse(options.body), webhookID: id, active: true };
      webhooks.set(id, webhook);
      return Response.json(webhook);
    }
    if (options.method === 'PATCH') {
      const webhook = { ...webhooks.get(id), ...JSON.parse(options.body), webhookID: id };
      webhooks.set(id, webhook);
      return Response.json(webhook);
    }
    if (options.method === 'DELETE') {
      webhooks.delete(id);
      return new Response('', { status: 200 });
    }
    return new Response('not found', { status: 404 });
  };
  fetchImpl.webhooks = webhooks;
  return fetchImpl;
}

async function waitFor(check, timeoutMs = 500) {
  const deadline = Date.now() + timeoutMs;
  while (!check()) {
    if (Date.now() >= deadline) throw new Error('Timed out waiting for asynchronous provider sync');
    await new Promise((resolve) => setTimeout(resolve, 5));
  }
}

async function listen(server) {
  await new Promise((resolve, reject) => {
    server.once('error', reject);
    server.listen(0, '127.0.0.1', resolve);
  });
  return `http://127.0.0.1:${server.address().port}`;
}

async function closeRuntime(runtime, server) {
  runtime.service.close();
  runtime.monitor.close();
  await new Promise((resolve) => server.close(resolve));
  runtime.store.close();
}

test('Solana runtime defaults are independent and preserve Base58 addresses', () => {
  const config = createSolanaConfig({});
  assert.equal(config.chain, SOLANA_CHAIN);
  assert.equal(SOLANA_ADDRESS_CODEC.chainId, 'solana');
  assert.equal(config.port, 18_120);
  assert.match(config.dataFile, /data\/solana\.sqlite$/);
  assert.equal(config.addressNormalizer(wallet), wallet);
  assert.equal(config.addressValidator(wallet), true);
  assert.equal(config.addressValidator(wallet.toLowerCase()), false);
  assert.equal(SOLANA_CHAIN.debotTokenRoot, 'https://debot.ai/token/solana/');
  assert.equal(SOLANA_CHAIN.holderSource, 'solana_rpc_program_accounts');
});

test('Solana service injects its chain profile into holder-first scans', async () => {
  const store = createRobinhoodStore(':memory:', {
    chainId: 'solana',
    chainLabel: 'Solana',
    addressNormalizer: (value) => String(value || '').trim(),
    addressValidator: (value) => value === wallet || value === mint,
    transactionNormalizer: (value) => String(value || '').trim()
  });
  let received = null;
  const runtime = createSolanaRuntime({}, {
    config: testConfig(),
    store,
    debotClient: fakeDebotClient(),
    holderClient: fakeHolderClient(),
    scanToken: async (options) => {
      received = options;
      return {
        actions: [],
        tokenPatch: { symbol: 'RUMP', name: 'Official Rump Coin' },
        holderAnalysis: { complete: true, candidates: [] },
        scan: { complete: true, strategy: 'holder_first' }
      };
    }
  });
  runtime.service.addManualWinner(mint);
  await runtime.service.waitForIdle();
  assert.equal(received.chainProfile, SOLANA_CHAIN);
  assert.equal(received.holderSource, 'solana_rpc_program_accounts');
  assert.equal(received.addressNormalizer(wallet), wallet);
  assert.equal(runtime.store.getToken(mint).chain, 'solana');
  runtime.service.close();
  runtime.monitor.close();
  runtime.store.close();
});

test('Solana API stays isolated and ingests authenticated Helius events idempotently', async () => {
  const heliusFetchImpl = fakeHeliusFetch();
  const runtime = createSolanaRuntime({}, {
    config: testConfig(),
    debotClient: fakeDebotClient(),
    holderClient: fakeHolderClient(),
    heliusFetchImpl,
    scanToken: async () => ({ actions: [], tokenPatch: {}, scan: { complete: true } })
  });
  runtime.store.upsertWalletAnnotation({
    address: wallet,
    alias: 'Sol Core',
    status: 'active',
    monitorRules: {
      buy: { enabled: true, sound: true, bark: false },
      sell: { enabled: true, sound: false, bark: false },
      transfer: { enabled: true, sound: false, bark: false },
      token_create: { enabled: true, sound: false, bark: false }
    },
    createdAt: 1,
    updatedAt: 1
  });
  const server = createSolanaStandaloneServer(runtime, { maxBodyBytes: 1_024 });
  const root = await listen(server);
  await runtime.service.start();
  await runtime.monitor.start();

  const monitorResponse = await fetch(`${root}/api/solana/monitor`);
  const monitor = await monitorResponse.json();
  assert.equal(monitorResponse.status, 200);
  assert.equal(monitor.chain, 'solana');
  assert.equal(monitor.status, 'live');
  assert.equal(monitor.health.monitoredWallets, 1);
  assert.equal(monitor.health.source, 'helius_enhanced_webhook');

  const payload = [{
    signature,
    type: 'SWAP',
    source: 'PUMP_AMM',
    feePayer: wallet,
    slot: 433_432_531,
    timestamp: 2_000_000_010,
    accountData: [{
      account: wallet,
      tokenBalanceChanges: [{
        userAccount: wallet,
        mint,
        rawTokenAmount: { tokenAmount: '14535155000000', decimals: 6 }
      }]
    }]
  }];
  const wrongAuth = await fetch(`${root}/api/solana/monitor/webhook`, {
    method: 'POST',
    headers: { 'content-type': 'application/json', authorization: 'Bearer wrong' },
    body: JSON.stringify(payload)
  });
  assert.equal(wrongAuth.status, 401);

  const accepted = await fetch(`${root}/api/solana/monitor/webhook`, {
    method: 'POST',
    headers: { 'content-type': 'application/json', authorization: 'Bearer solana-hook-secret' },
    body: JSON.stringify(payload)
  });
  assert.equal(accepted.status, 200);
  assert.deepEqual(await accepted.json(), {
    ok: true,
    acceptedTransactions: 1,
    duplicateSignatures: 0,
    invalidTransactions: [],
    insertedEvents: 1,
    disabled: false
  });

  const duplicate = await fetch(`${root}/api/solana/monitor/webhook`, {
    method: 'POST',
    headers: { 'content-type': 'application/json', authorization: 'Bearer solana-hook-secret' },
    body: JSON.stringify(payload)
  });
  const duplicateBody = await duplicate.json();
  assert.equal(duplicateBody.acceptedTransactions, 0);
  assert.equal(duplicateBody.duplicateSignatures, 1);
  assert.equal(duplicateBody.insertedEvents, 0);
  assert.equal(
    runtime.store.db.prepare('SELECT COUNT(*) AS count FROM solana_webhook_signatures').get().count,
    1
  );
  assert.equal(
    runtime.store.db.prepare("SELECT COUNT(*) AS count FROM metadata WHERE key LIKE 'solana:webhook:signature:%'").get().count,
    0
  );

  const eventsResponse = await fetch(`${root}/api/solana/monitor/events`);
  const events = await eventsResponse.json();
  assert.equal(eventsResponse.status, 200);
  assert.equal(events.events.length, 1);
  assert.equal(events.events[0].walletAddress, wallet);
  assert.equal(events.events[0].walletAlias, 'Sol Core');
  assert.equal(events.events[0].tokenAddress, mint);
  assert.equal(events.events[0].debotAddressUrl, `https://debot.ai/address/solana/${wallet}`);
  assert.equal(events.events[0].debotTokenUrl, `https://debot.ai/token/solana/${mint}`);
  assert.equal(events.events[0].explorerTxUrl, `https://solscan.io/tx/${signature}`);

  const oversized = await fetch(`${root}/api/solana/monitor/webhook`, {
    method: 'POST',
    headers: { 'content-type': 'application/json', authorization: 'Bearer solana-hook-secret' },
    body: JSON.stringify([{ padding: 'x'.repeat(2_000) }])
  });
  assert.equal(oversized.status, 413);
  assert.equal((await oversized.json()).code, 'BODY_TOO_LARGE');

  const crossed = await fetch(`${root}/api/robinhood/monitor`);
  assert.equal(crossed.status, 404);

  const addedWallet = await fetch(`${root}/api/solana/wallets/batch`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ lines: `${otherWallet},Second Sol wallet` })
  });
  assert.equal(addedWallet.status, 200);
  await waitFor(() => [...heliusFetchImpl.webhooks.values()][0]?.accountAddresses?.length === 2);
  assert.deepEqual(
    [...heliusFetchImpl.webhooks.values()][0].accountAddresses,
    [wallet, otherWallet].sort()
  );

  for (const address of [wallet, otherWallet]) {
    const removed = await fetch(`${root}/api/solana/wallets/${address}`, { method: 'DELETE' });
    assert.equal(removed.status, 200);
  }
  await waitFor(() => heliusFetchImpl.webhooks.size === 0);

  await closeRuntime(runtime, server);
});

test('Solana monitor remains available but clearly degraded without Helius configuration', async () => {
  const runtime = createSolanaRuntime({}, {
    config: testConfig({ heliusApiKey: '', heliusWebhookUrl: '', heliusAuthHeader: '' }),
    debotClient: fakeDebotClient(),
    holderClient: fakeHolderClient(),
    scanToken: async () => ({ actions: [], tokenPatch: {}, scan: { complete: true } })
  });
  const server = createSolanaStandaloneServer(runtime);
  const root = await listen(server);
  await runtime.monitor.start();
  const monitorResponse = await fetch(`${root}/api/solana/monitor`);
  const monitor = await monitorResponse.json();
  assert.equal(monitorResponse.status, 200);
  assert.equal(monitor.status, 'degraded');
  assert.equal(monitor.health.realtimeReady, false);
  assert.ok(monitor.health.reasons.includes('helius_api_key_missing'));

  const webhookResponse = await fetch(`${root}/api/solana/monitor/webhook`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: '[]'
  });
  assert.equal(webhookResponse.status, 503);
  assert.equal((await webhookResponse.json()).code, 'WEBHOOK_NOT_CONFIGURED');
  await closeRuntime(runtime, server);
});

test('Solana persistence failures release signature claims so Helius retries are accepted', async () => {
  const runtime = createSolanaRuntime({}, {
    config: testConfig(),
    debotClient: fakeDebotClient(),
    holderClient: fakeHolderClient(),
    heliusFetchImpl: fakeHeliusFetch(),
    scanToken: async () => ({ actions: [], tokenPatch: {}, scan: { complete: true } })
  });
  runtime.store.upsertWalletAnnotation({
    address: wallet,
    alias: 'Retry wallet',
    status: 'active',
    monitorRules: {
      buy: { enabled: true, sound: false, bark: false },
      sell: { enabled: false, sound: false, bark: false },
      transfer: { enabled: false, sound: false, bark: false },
      token_create: { enabled: false, sound: false, bark: false }
    }
  });
  const payload = [{
    signature,
    type: 'SWAP',
    source: 'PUMP_AMM',
    feePayer: wallet,
    slot: 433_432_531,
    timestamp: 2_000_000_010,
    accountData: [{
      account: wallet,
      tokenBalanceChanges: [{
        userAccount: wallet,
        mint,
        rawTokenAmount: { tokenAmount: '14535155000000', decimals: 6 }
      }]
    }]
  }];
  const insertMonitorEvent = runtime.store.insertMonitorEvent;
  runtime.store.insertMonitorEvent = () => {
    throw new Error('synthetic SQLite failure');
  };

  await assert.rejects(
    runtime.monitor.ingestWebhook(payload, { authorization: 'Bearer solana-hook-secret' }),
    /synthetic SQLite failure/
  );
  assert.equal(
    runtime.store.db.prepare('SELECT COUNT(*) AS count FROM solana_webhook_signatures').get().count,
    0
  );

  runtime.store.insertMonitorEvent = insertMonitorEvent;
  const retry = await runtime.monitor.ingestWebhook(payload, {
    authorization: 'Bearer solana-hook-secret'
  });
  assert.equal(retry.acceptedTransactions, 1);
  assert.equal(retry.events.length, 1);
  assert.equal(
    runtime.store.db.prepare('SELECT COUNT(*) AS count FROM solana_webhook_signatures').get().count,
    1
  );

  runtime.service.close();
  runtime.monitor.close();
  runtime.store.close();
});
