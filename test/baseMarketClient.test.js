import test from 'node:test';
import assert from 'node:assert/strict';

import {
  BaseMarketClient,
  normalizeBaseDexScreenerMetrics
} from '../src/base/marketClient.js';

const token = '0x1111111111111111111111111111111111111111';

function dexPair(patch = {}) {
  return {
    chainId: 'base',
    pairAddress: '0x2222222222222222222222222222222222222222',
    baseToken: { address: token, symbol: 'BASE', name: 'Base Token' },
    quoteToken: { address: '0x4200000000000000000000000000000000000006', symbol: 'WETH' },
    priceUsd: '0.05',
    marketCap: 5_000_000,
    fdv: 6_000_000,
    pairCreatedAt: 1_700_000_000_000,
    liquidity: { usd: 100_000 },
    ...patch
  };
}

test('normalizes the deepest Base DexScreener pair into monitor metrics', () => {
  const metrics = normalizeBaseDexScreenerMetrics([
    dexPair({ liquidity: { usd: 1_000 }, marketCap: 1_000_000 }),
    dexPair({ liquidity: { usd: 200_000 }, marketCap: null, fdv: 8_000_000 })
  ], token.toUpperCase().replace('0X', '0x'));

  assert.equal(metrics.chain, 'base');
  assert.equal(metrics.address, token);
  assert.equal(metrics.marketCapUsd, 8_000_000);
  assert.equal(metrics.creationTimestamp, 1_700_000_000);
  assert.equal(metrics.liquidityUsd, 200_000);
  assert.equal(metrics.source, 'dexscreener_base_pair');
});

test('returns complete DeBot metrics without contacting DexScreener', async () => {
  let dexCalls = 0;
  const expected = {
    chain: 'base',
    address: token,
    marketCapUsd: 9_000_000,
    creationTimestamp: 1_700_000_000
  };
  const client = new BaseMarketClient({
    debotClient: { fetchTokenMetrics: async () => expected },
    fetchImpl: async () => {
      dexCalls += 1;
      return Response.json([]);
    }
  });

  assert.equal(await client.fetchTokenMetrics(token), expected);
  assert.equal(dexCalls, 0);
});

test('falls back to DexScreener when DeBot fails and merges incomplete DeBot fields', async () => {
  const urls = [];
  const fetchImpl = async (input) => {
    urls.push(String(input));
    return Response.json([dexPair()]);
  };
  const failed = new BaseMarketClient({
    debotClient: { fetchTokenMetrics: async () => { throw new Error('Cloudflare 403'); } },
    fetchImpl
  });
  const fallback = await failed.fetchTokenMetrics(token);
  assert.equal(fallback.marketCapUsd, 5_000_000);
  assert.equal(fallback.creationTimestamp, 1_700_000_000);
  assert.equal(fallback.source, 'dexscreener_base_pair');

  const incomplete = new BaseMarketClient({
    debotClient: {
      fetchTokenMetrics: async () => ({
        chain: 'base',
        address: token,
        symbol: 'DEBOT',
        marketCapUsd: 7_000_000,
        creationTimestamp: null
      })
    },
    fetchImpl
  });
  const merged = await incomplete.fetchTokenMetrics(token);
  assert.equal(merged.symbol, 'DEBOT');
  assert.equal(merged.marketCapUsd, 7_000_000);
  assert.equal(merged.creationTimestamp, 1_700_000_000);
  assert.equal(merged.source, 'debot_with_dexscreener_fallback');
  assert.equal(urls.length, 2);
  assert.match(urls[0], /token-pairs\/v1\/base\/0x1111/);
});

test('does not contact fallbacks after caller cancellation', async () => {
  let requests = 0;
  const controller = new AbortController();
  controller.abort(new Error('stop base lookup'));
  const client = new BaseMarketClient({
    debotClient: { fetchTokenMetrics: async () => { requests += 1; } },
    fetchImpl: async () => {
      requests += 1;
      return Response.json([]);
    }
  });

  await assert.rejects(client.fetchTokenMetrics(token, { signal: controller.signal }), /stop base lookup/);
  assert.equal(requests, 0);
});
