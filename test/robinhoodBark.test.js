import test from 'node:test';
import assert from 'node:assert/strict';

import {
  RobinhoodBarkNotifier,
  maskBarkEndpoint,
  normalizeBarkEndpoint
} from '../src/robinhood/bark.js';
import { createRobinhoodStore } from '../src/robinhood/store.js';

test('normalizes only official Bark device APIs and masks the key', () => {
  assert.equal(normalizeBarkEndpoint('device_Key-1234'), 'https://api.day.app/device_Key-1234');
  assert.equal(
    normalizeBarkEndpoint('https://api.day.app/device_Key-1234/old/title?sound=bell'),
    'https://api.day.app/device_Key-1234'
  );
  assert.equal(maskBarkEndpoint('device_Key-1234'), 'https://api.day.app/devi***1234');
  assert.throws(() => normalizeBarkEndpoint('http://api.day.app/device_key'), /official/);
  assert.throws(() => normalizeBarkEndpoint('https://127.0.0.1/device_key'), /official/);
  assert.throws(() => normalizeBarkEndpoint('https://example.com/device_key'), /official/);
});

test('persists multiple Bark targets without returning full keys', () => {
  const store = createRobinhoodStore(':memory:');
  const notifier = new RobinhoodBarkNotifier({ store, fetchImpl: async () => assert.fail('not expected') });
  const first = notifier.createTarget({ endpoint: 'device_key_123456', label: 'iPhone' });
  const second = notifier.createTarget({ endpoint: 'another_key_654321', label: 'iPad', enabled: false });
  assert.equal(first.endpointMasked, 'https://api.day.app/devi***3456');
  assert.equal(Object.hasOwn(first, 'endpoint'), false);
  assert.equal(second.enabled, false);
  assert.equal(notifier.listTargets().length, 2);
  assert.throws(() => notifier.createTarget({ endpoint: 'device_key_123456' }), /already/);
  assert.equal(notifier.updateTarget(first.id, { enabled: false }).enabled, false);
  assert.equal(notifier.deleteTarget(second.id), true);
  assert.equal(notifier.listTargets().length, 1);
  store.close();
});

test('sends Bark tests and threshold alerts with the selected sound and critical volume', async () => {
  const store = createRobinhoodStore(':memory:');
  const requests = [];
  const notifier = new RobinhoodBarkNotifier({
    store,
    now: () => 2_000_000_000_000,
    fetchImpl: async (url) => {
      requests.push(new URL(url));
      return new Response(JSON.stringify({ code: 200 }), {
        status: 200,
        headers: { 'content-type': 'application/json' }
      });
    }
  });
  const target = notifier.createTarget({ endpoint: 'device_key_123456', label: 'Phone' });
  await notifier.testTarget(target.id, { sound: 'bell', volume: 3 });
  const result = await notifier.notifyAlert({
    threshold: 2,
    windowSeconds: 120,
    sound: 'electronic',
    volume: 9,
    cluster: {
      tokenSymbol: 'VEX',
      distinctWallets: 2,
      wallets: [
        { address: '0xaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa', alias: '高手一' },
        { address: '0xbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb', alias: '高手二' }
      ],
      debotTokenUrl: 'https://debot.ai/token/robinhood/308574_0x1111111111111111111111111111111111111111'
    }
  });
  assert.deepEqual(result, { attempted: 1, sent: 1, failed: 0 });
  assert.equal(requests.length, 2);
  assert.equal(requests[0].searchParams.get('sound'), 'bell');
  assert.equal(requests[0].searchParams.get('level'), 'critical');
  assert.equal(requests[0].searchParams.get('volume'), '3');
  assert.equal(requests[1].searchParams.get('sound'), 'electronic');
  assert.equal(requests[1].searchParams.get('level'), 'critical');
  assert.equal(requests[1].searchParams.get('volume'), '9');
  assert.match(decodeURIComponent(requests[1].pathname), /集合买入：VEX/);
  assert.match(decodeURIComponent(requests[1].pathname), /2 分钟内买入 VEX/);
  assert.equal(requests[1].searchParams.get('url').startsWith('https://debot.ai/token/'), true);
  assert.equal(notifier.listTargets()[0].lastSuccessAt, 2_000_000_000);
  store.close();
});

test('records Bark delivery errors without exposing the endpoint', async () => {
  const store = createRobinhoodStore(':memory:');
  const notifier = new RobinhoodBarkNotifier({
    store,
    now: () => 2_000_000_000_000,
    fetchImpl: async () => new Response('failed', { status: 500 })
  });
  const target = notifier.createTarget({ endpoint: 'device_key_123456' });
  await assert.rejects(notifier.testTarget(target.id), /Bark request failed/);
  const publicRow = notifier.listTargets()[0];
  assert.equal(publicRow.lastErrorAt, 2_000_000_000);
  assert.match(publicRow.lastError, /500/);
  assert.equal(Object.hasOwn(publicRow, 'endpoint'), false);
  store.close();
});

test('sends an immediate per-wallet event with the transaction link', async () => {
  const store = createRobinhoodStore(':memory:');
  const requests = [];
  const notifier = new RobinhoodBarkNotifier({
    store,
    fetchImpl: async (url) => {
      requests.push(new URL(url));
      return new Response(JSON.stringify({ code: 200 }), { status: 200 });
    }
  });
  notifier.createTarget({ endpoint: 'device_key_123456' });
  const result = await notifier.notifyWalletEvent({
    sound: 'chime',
    volume: 8,
    event: {
      eventType: 'transfer',
      assetType: 'native',
      walletAddress: '0xaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa',
      walletAlias: 'Alpha',
      counterpartyAddress: '0xbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb',
      tokenSymbol: 'ETH',
      tokenAmount: '1.25',
      explorerTxUrl: 'https://robinhoodchain.blockscout.com/tx/0x1234'
    }
  });

  assert.deepEqual(result, { attempted: 1, sent: 1, failed: 0 });
  assert.equal(requests.length, 1);
  assert.match(decodeURIComponent(requests[0].pathname), /Alpha 转出 ETH/);
  assert.match(decodeURIComponent(requests[0].pathname), /1.25 ETH/);
  assert.match(decodeURIComponent(requests[0].pathname), /0xbbbb...bbbb/);
  assert.equal(requests[0].searchParams.get('sound'), 'chime');
  assert.equal(requests[0].searchParams.get('volume'), '8');
  assert.equal(requests[0].searchParams.get('url'), 'https://robinhoodchain.blockscout.com/tx/0x1234');
  store.close();
});
