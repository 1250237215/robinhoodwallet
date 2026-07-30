import test from 'node:test';
import assert from 'node:assert/strict';

import {
  BscMarketClient,
  normalizeBscDexScreenerBatch,
  normalizeBscDexScreenerMetrics
} from '../src/bsc/marketClient.js';

const token = '0x1111111111111111111111111111111111111111';

function dexPair(patch = {}) {
  return {
    chainId: 'bsc',
    pairAddress: '0x2222222222222222222222222222222222222222',
    baseToken: { address: token, symbol: 'DOG', name: 'BSC Dog' },
    quoteToken: { address: '0xbb4cdb9cbd36b01d1cbaebf2de08d9173bc095c', symbol: 'WBNB' },
    priceUsd: '0.05',
    marketCap: 5_000_000,
    fdv: 6_000_000,
    pairCreatedAt: 1_700_000_000_000,
    liquidity: { usd: 100_000 },
    ...patch
  };
}

test('normalizes the deepest BSC DexScreener pair into monitor metrics', () => {
  const metrics = normalizeBscDexScreenerMetrics([
    dexPair({ liquidity: { usd: 1_000 }, marketCap: 1_000_000, pairCreatedAt: 1_600_000_000_000 }),
    dexPair({ liquidity: { usd: 200_000 }, marketCap: null, fdv: 8_000_000, pairCreatedAt: 1_700_000_000_000 }),
    dexPair({ chainId: 'base', liquidity: { usd: 999_000 }, marketCap: 999_000_000 })
  ], token.toUpperCase().replace('0X', '0x'));

  assert.equal(metrics.chain, 'bsc');
  assert.equal(metrics.address, token);
  assert.equal(metrics.marketCapUsd, 8_000_000);
  assert.equal(metrics.creationTimestamp, 1_600_000_000);
  assert.equal(metrics.liquidityUsd, 200_000);
  assert.equal(metrics.source, 'dexscreener_bsc_pair');
});

test('uses complete DexScreener metrics without contacting the DeBot fallback', async () => {
  let debotCalls = 0;
  const client = new BscMarketClient({
    debotClient: { fetchTokenMetrics: async () => { debotCalls += 1; } },
    fetchImpl: async () => Response.json([dexPair()])
  });

  const metrics = await client.fetchTokenMetrics(token);
  assert.equal(metrics.marketCapUsd, 5_000_000);
  assert.equal(metrics.creationTimestamp, 1_700_000_000);
  assert.equal(debotCalls, 0);
});

test('falls back to DeBot when DexScreener fails and fills incomplete primary fields', async () => {
  const urls = [];
  const failed = new BscMarketClient({
    debotClient: { fetchTokenMetrics: async () => ({
      chain: 'bsc',
      address: token,
      marketCapUsd: 9_000_000,
      creationTimestamp: 1_710_000_000,
      source: 'debot'
    }) },
    fetchImpl: async () => new Response('', { status: 503 })
  });
  const fallback = await failed.fetchTokenMetrics(token);
  assert.equal(fallback.marketCapUsd, 9_000_000);
  assert.equal(fallback.creationTimestamp, 1_710_000_000);

  const fetchImpl = async (input) => {
    urls.push(String(input));
    return Response.json([dexPair({ pairCreatedAt: null })]);
  };
  const incomplete = new BscMarketClient({
    debotClient: {
      fetchTokenMetrics: async () => ({
        chain: 'bsc',
        address: token,
        symbol: 'DEBOT',
        marketCapUsd: 7_000_000,
        creationTimestamp: 1_680_000_000
      })
    },
    fetchImpl
  });
  const merged = await incomplete.fetchTokenMetrics(token);
  assert.equal(merged.symbol, 'DOG');
  assert.equal(merged.marketCapUsd, 5_000_000);
  assert.equal(merged.creationTimestamp, 1_680_000_000);
  assert.equal(merged.source, 'dexscreener_with_debot_fallback');
  assert.equal(urls.length, 1);
  assert.match(urls[0], /tokens\/v1\/bsc\/0x1111/);
});

test('batches up to 30 BSC token addresses into one DexScreener request', async () => {
  const tokenB = '0x2222222222222222222222222222222222222222';
  const urls = [];
  const rows = [dexPair(), dexPair({
    baseToken: { address: tokenB, symbol: 'CAT', name: 'BSC Cat' },
    marketCap: 8_000_000
  })];
  const normalized = normalizeBscDexScreenerBatch(rows, [token, tokenB]);
  assert.equal(normalized.get(tokenB).marketCapUsd, 8_000_000);

  const client = new BscMarketClient({
    fetchImpl: async (input) => {
      urls.push(String(input));
      return Response.json(rows);
    }
  });
  const result = await client.fetchTokenMetricsBatch([token, tokenB]);
  assert.equal(result.size, 2);
  assert.equal(urls.length, 1);
  assert.match(urls[0], new RegExp(`${token},${tokenB}$`));

  const tooMany = Array.from({ length: 31 }, (_, index) =>
    `0x${(index + 1).toString(16).padStart(40, '0')}`);
  await assert.rejects(client.fetchTokenMetricsBatch(tooMany), /cannot exceed 30/);
});

test('does not contact BSC fallbacks after caller cancellation', async () => {
  let requests = 0;
  const controller = new AbortController();
  controller.abort(new Error('stop BSC lookup'));
  const client = new BscMarketClient({
    debotClient: { fetchTokenMetrics: async () => { requests += 1; } },
    fetchImpl: async () => {
      requests += 1;
      return Response.json([]);
    }
  });

  await assert.rejects(client.fetchTokenMetrics(token, { signal: controller.signal }), /stop BSC lookup/);
  assert.equal(requests, 0);
});
