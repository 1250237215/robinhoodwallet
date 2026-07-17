import assert from 'node:assert/strict';
import test from 'node:test';

import { createRobinhoodStore } from '../src/robinhood/store.js';
import { HeliusWebhookManager } from '../src/solana/heliusWebhookManager.js';
import { isSolanaAddress } from '../src/solana/address.js';

const wallet = 'EgsaH8Voe7KRkZwheXFF6vWKjV5VRZGyQ6CaLeqe5KmP';
const otherWallet = '34QBSvWGEWpcz45ZfUGFGGSfK6j6P8rRnTaK7uufyVJw';

function createStore() {
  return createRobinhoodStore(':memory:', {
    chainId: 'solana',
    chainLabel: 'Solana',
    addressNormalizer: (value) => String(value || '').trim(),
    addressValidator: isSolanaAddress,
    transactionNormalizer: (value) => String(value || '').trim()
  });
}

function providerFixture() {
  const webhooks = new Map();
  const requests = [];
  let nextId = 1;
  const fetchImpl = async (input, options = {}) => {
    const url = new URL(input);
    const method = options.method || 'GET';
    const segments = url.pathname.split('/').filter(Boolean);
    const id = segments.at(-1) === 'webhooks' ? '' : segments.at(-1);
    const body = options.body ? JSON.parse(options.body) : null;
    requests.push({ method, id, body, apiKeyPresent: Boolean(url.searchParams.get('api-key')) });
    if (method === 'GET' && !id) return Response.json([...webhooks.values()]);
    if (method === 'POST' && !id) {
      const webhook = { ...body, webhookID: `wh_${nextId++}`, active: true };
      webhooks.set(webhook.webhookID, webhook);
      return Response.json(webhook);
    }
    if (method === 'PUT' && id && webhooks.has(id)) {
      const webhook = { ...webhooks.get(id), ...body, webhookID: id, active: true };
      webhooks.set(id, webhook);
      return Response.json(webhook);
    }
    if (method === 'PATCH' && id && webhooks.has(id)) {
      const webhook = { ...webhooks.get(id), ...body, webhookID: id };
      webhooks.set(id, webhook);
      return Response.json(webhook);
    }
    if (method === 'DELETE' && id) {
      webhooks.delete(id);
      return new Response('', { status: 200 });
    }
    return new Response('missing', { status: 404 });
  };
  return { webhooks, requests, fetchImpl };
}

test('Helius manager creates, updates, and deletes the provider webhook as wallets change', async () => {
  const store = createStore();
  const provider = providerFixture();
  let addresses = [wallet];
  let timerCleared = false;
  const manager = new HeliusWebhookManager({
    store,
    apiKey: 'secret-api-key',
    webhookUrl: 'https://radar.example.test/api/solana/monitor/webhook',
    authHeader: 'Bearer secret-hook-auth',
    addressProvider: () => addresses,
    fetchImpl: provider.fetchImpl,
    syncIntervalMs: 30_000,
    setIntervalImpl(callback, milliseconds) {
      assert.equal(typeof callback, 'function');
      assert.equal(milliseconds, 30_000);
      return { unref() {} };
    },
    clearIntervalImpl() {
      timerCleared = true;
    },
    now: () => 2_000_000_000_000
  });

  const created = await manager.start();
  assert.equal(created.realtimeReady, true);
  assert.equal(created.syncedAddressCount, 1);
  assert.equal(provider.webhooks.size, 1);
  const [webhook] = provider.webhooks.values();
  assert.equal(webhook.webhookURL, 'https://radar.example.test/api/solana/monitor/webhook');
  assert.equal(webhook.webhookType, 'enhanced');
  assert.equal(webhook.authHeader, 'Bearer secret-hook-auth');
  assert.deepEqual(webhook.transactionTypes, []);
  assert.deepEqual(webhook.accountAddresses, [wallet]);
  assert.equal(store.getMeta('solana:helius:webhook-id'), webhook.webhookID);

  addresses = [otherWallet, wallet];
  assert.ok(manager.getHealth().reasons.includes('helius_wallet_addresses_pending_sync'));
  await manager.syncNow();
  assert.equal(manager.getHealth().realtimeReady, true);
  assert.deepEqual(provider.webhooks.get(webhook.webhookID).accountAddresses, [otherWallet, wallet].sort());
  assert.ok(provider.requests.some((request) => request.method === 'PUT'));

  const requestCount = provider.requests.length;
  await manager.syncNow();
  assert.equal(provider.requests.length, requestCount);

  addresses = [];
  await manager.syncNow();
  assert.equal(provider.webhooks.size, 0);
  assert.equal(store.getMeta('solana:helius:webhook-id'), '');
  assert.equal(manager.getHealth().realtimeReady, true);
  assert.equal(manager.getHealth().syncedAddressCount, 0);
  assert.ok(provider.requests.some((request) => request.method === 'DELETE'));

  manager.close();
  assert.equal(timerCleared, true);
  store.close();
});

test('Helius manager stays degraded after provider failure and never exposes API or auth secrets', async () => {
  const store = createStore();
  const apiKey = 'super-secret-helius-key';
  const authHeader = 'Bearer super-secret-hook';
  const manager = new HeliusWebhookManager({
    store,
    apiKey,
    webhookUrl: 'https://radar.example.test/api/solana/monitor/webhook',
    authHeader,
    addressProvider: () => [wallet],
    fetchImpl: async () => {
      throw new Error(`network rejected ${apiKey} and ${authHeader}`);
    },
    setIntervalImpl: () => ({ unref() {} }),
    clearIntervalImpl: () => {}
  });
  const health = await manager.start();
  const serialized = JSON.stringify(health);
  assert.equal(health.realtimeReady, false);
  assert.equal(health.synced, false);
  assert.ok(health.reasons.includes('helius_webhook_sync_error'));
  assert.ok(health.reasons.includes('helius_webhook_not_synced'));
  assert.doesNotMatch(serialized, new RegExp(apiKey));
  assert.doesNotMatch(serialized, /super-secret-hook/);
  assert.match(health.lastError, /\[redacted\]/);
  manager.close();
  store.close();
});
