import test from 'node:test';
import assert from 'node:assert/strict';

import { createDebotBridgeFetch, debotBridgeRequest } from '../src/robinhood/debotBridgeFetch.js';

const token = '0x1111111111111111111111111111111111111111';
const wallet = '0xaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa';

test('recognizes only the two allowlisted Robinhood DeBot analysis requests', () => {
  assert.deepEqual(
    debotBridgeRequest(`https://debot.ai/api/dashboard/token/detail?chain=robinhood&token=${token}`),
    {
      type: 'debot.token_detail.v1',
      payload: { chain: 'robinhood', token },
      cacheTtlMs: 60_000
    }
  );
  assert.deepEqual(
    debotBridgeRequest(`https://debot.ai/api/dex/profit/wallet_token_analysis?chain=robinhood&token=${token}&wallet=${wallet}`),
    {
      type: 'debot.wallet_token_analysis.v1',
      payload: { chain: 'robinhood', token, wallet },
      cacheTtlMs: 30_000
    }
  );
  assert.equal(debotBridgeRequest(`https://debot.ai/api/dashboard/token/detail?chain=base&token=${token}`), null);
  assert.equal(debotBridgeRequest(`https://debot.ai/api/dashboard/token/detail?chain=robinhood&token=${token}&url=https://example.com`), null);
  assert.equal(debotBridgeRequest(`https://debot.ai/api/market/v4?chain=robinhood&token=${token}`), null);
  assert.equal(debotBridgeRequest(`https://example.com/api/dashboard/token/detail?chain=robinhood&token=${token}`), null);
});

test('returns a DeBot-compatible JSON response from the browser bridge', async () => {
  const calls = [];
  const fetch = createDebotBridgeFetch({
    socialService: {
      async requestDeBot(type, payload, options) {
        calls.push({ type, payload, options });
        return { schema: 'debot.token_detail.raw.v1', data: { token: { meta: { address: token } } } };
      }
    },
    fetchImpl: async () => {
      throw new Error('direct fetch should not run');
    },
    timeoutMs: 25_000
  });

  const response = await fetch(`https://debot.ai/api/dashboard/token/detail?chain=robinhood&token=${token}`);
  assert.equal(response.status, 200);
  assert.equal(response.headers.get('x-debot-source'), 'browser-bridge');
  assert.deepEqual(await response.json(), { code: 0, data: { token: { meta: { address: token } } } });
  assert.equal(calls.length, 1);
  assert.equal(calls[0].type, 'debot.token_detail.v1');
  assert.equal(calls[0].options.timeoutMs, 25_000);
  assert.equal(calls[0].options.cacheTtlMs, 60_000);
});

test('falls back to the direct DeBot request when the browser bridge is offline', async () => {
  let directCalls = 0;
  const fetch = createDebotBridgeFetch({
    socialService: {
      async requestDeBot() {
        throw new Error('DeBot analysis bridge is offline');
      }
    },
    fetchImpl: async () => {
      directCalls += 1;
      return new Response('challenge', { status: 403 });
    }
  });

  const response = await fetch(
    `https://debot.ai/api/dex/profit/wallet_token_analysis?chain=robinhood&token=${token}&wallet=${wallet}`
  );
  assert.equal(response.status, 403);
  assert.equal(directCalls, 1);
});

test('passes non-analysis DeBot requests directly through without queuing a bridge job', async () => {
  let bridgeCalls = 0;
  let directCalls = 0;
  const fetch = createDebotBridgeFetch({
    socialService: {
      async requestDeBot() {
        bridgeCalls += 1;
      }
    },
    fetchImpl: async () => {
      directCalls += 1;
      return new Response(JSON.stringify({ code: 0, data: {} }), { status: 200 });
    }
  });

  const response = await fetch(`https://debot.ai/api/dashboard/token/market/metrics?chain=robinhood&token=${token}`);
  assert.equal(response.status, 200);
  assert.equal(bridgeCalls, 0);
  assert.equal(directCalls, 1);
});
