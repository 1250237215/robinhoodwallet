import test from 'node:test';
import assert from 'node:assert/strict';

import {
  normalizeRobinhoodDexScreenerMetrics,
  RobinhoodDexScreenerClient,
  RobinhoodMarketDataClient
} from '../src/robinhood/marketClient.js';

const tokenA = '0x1111111111111111111111111111111111111111';
const tokenB = '0x2222222222222222222222222222222222222222';
const tokenC = '0x3333333333333333333333333333333333333333';

function pair({
  token = tokenA,
  pairAddress = '0xaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa',
  chainId = 'robinhood',
  marketCap = 1_000_000,
  fdv = null,
  liquidityUsd = 10_000,
  volume24h = 5_000,
  pairCreatedAt = 1_700_000_000_000,
  symbol = 'TOK'
} = {}) {
  return {
    chainId,
    dexId: 'uniswap',
    pairAddress,
    baseToken: { address: token, symbol, name: `${symbol} Token` },
    quoteToken: { address: tokenB, symbol: 'WETH', name: 'Wrapped Ether' },
    priceUsd: '0.01',
    marketCap,
    fdv,
    liquidity: { usd: liquidityUsd },
    volume: { h24: volume24h },
    pairCreatedAt
  };
}

test('selects the highest-liquidity Robinhood base pair and the earliest valid pair age', () => {
  const metrics = normalizeRobinhoodDexScreenerMetrics([
    pair({
      pairAddress: '0xbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb',
      marketCap: 2_000_000,
      liquidityUsd: 25_000,
      pairCreatedAt: 1_700_000_000_000
    }),
    pair({
      pairAddress: '0xcccccccccccccccccccccccccccccccccccccccc',
      marketCap: null,
      fdv: 8_000_000,
      liquidityUsd: 250_000,
      pairCreatedAt: 1_800_000_000_000
    }),
    pair({ chainId: 'base', marketCap: 999_000_000, liquidityUsd: 999_000_000 }),
    {
      ...pair({ token: tokenB, marketCap: 777_000_000 }),
      quoteToken: { address: tokenA, symbol: 'TOK' }
    },
    pair({ pairAddress: 'not-an-address', pairCreatedAt: 1_600_000_000_000 })
  ], tokenA, { now: () => 2_000_000_000_000 });

  assert.equal(metrics.marketCapUsd, 8_000_000);
  assert.equal(metrics.marketCapSource, 'dexscreener_fdv');
  assert.equal(metrics.liquidityUsd, 250_000);
  assert.equal(metrics.primaryPoolAddress, '0xcccccccccccccccccccccccccccccccccccccccc');
  assert.equal(metrics.creationTimestamp, 1_700_000_000);
  assert.equal(metrics.creationTimestampSource, 'dexscreener_earliest_pair_created_at');
  assert.equal(metrics.pairCount, 2);
  assert.equal(metrics.updatedAt, 2_000_000_000);
});

test('uses the DexScreener Robinhood tokens batch endpoint and enforces its 30-address limit', async () => {
  const requests = [];
  const client = new RobinhoodDexScreenerClient({
    baseUrl: 'https://dex.test/tokens/v1/robinhood',
    now: () => 2_000_000_000_000,
    fetchImpl: async (input) => {
      requests.push(String(input));
      return Response.json([
        pair({ token: tokenA, symbol: 'AAA' }),
        pair({
          token: tokenB,
          symbol: 'BBB',
          pairAddress: '0xdddddddddddddddddddddddddddddddddddddddd',
          marketCap: 2_000_000
        })
      ]);
    }
  });

  const metrics = await client.fetchTokenMetricsBatch([tokenA.toUpperCase().replace('0X', '0x'), tokenB]);

  assert.equal(requests[0], `https://dex.test/tokens/v1/robinhood/${tokenA},${tokenB}`);
  assert.equal(metrics.get(tokenA).symbol, 'AAA');
  assert.equal(metrics.get(tokenB).marketCapUsd, 2_000_000);
  assert.equal(metrics.size, 2);

  const tooMany = Array.from({ length: 31 }, (_, index) =>
    `0x${(index + 1).toString(16).padStart(40, '0')}`);
  await assert.rejects(client.fetchTokenMetricsBatch(tooMany), /cannot exceed 30 addresses/);
  await assert.rejects(client.fetchTokenMetricsBatch(['0x1234']), /Invalid Robinhood token address/);
  assert.equal(requests.length, 1);
});

test('marks non-retryable DexScreener HTTP failures without internal retry loops', async () => {
  let calls = 0;
  const client = new RobinhoodDexScreenerClient({
    fetchImpl: async () => {
      calls += 1;
      return new Response('forbidden', { status: 403 });
    }
  });

  await assert.rejects(
    client.fetchTokenMetricsBatch([tokenA]),
    (error) => error.status === 403 && error.retryable === false
  );
  assert.equal(calls, 1);
});

test('uses DeBot only to fill fields missing from the DexScreener batch result', async () => {
  const fallbackCalls = [];
  const client = new RobinhoodMarketDataClient({
    primary: {
      async fetchTokenMetricsBatch() {
        return new Map([
          [tokenA, { address: tokenA, marketCapUsd: 1_000_000, creationTimestamp: 100, source: 'dex' }],
          [tokenB, { address: tokenB, marketCapUsd: 2_000_000, creationTimestamp: null, source: 'dex' }],
          [tokenC, { address: tokenC, marketCapUsd: null, creationTimestamp: null, source: 'dex' }]
        ]);
      }
    },
    fallback: {
      async fetchTokenMetrics(address) {
        fallbackCalls.push(address);
        if (address === tokenB) {
          return { address, marketCapUsd: 99_000_000, creationTimestamp: 200, source: 'debot' };
        }
        return { address, marketCapUsd: 3_000_000, creationTimestamp: 300, source: 'debot' };
      }
    }
  });

  const metrics = await client.fetchTokenMetricsBatch([tokenA, tokenB, tokenC]);

  assert.deepEqual(fallbackCalls, [tokenB, tokenC]);
  assert.equal(metrics.get(tokenA).source, 'dexscreener_robinhood');
  assert.equal(metrics.get(tokenB).marketCapUsd, 2_000_000);
  assert.equal(metrics.get(tokenB).creationTimestamp, 200);
  assert.equal(metrics.get(tokenB).source, 'dexscreener_robinhood+debot_fallback');
  assert.equal(metrics.get(tokenC).marketCapUsd, 3_000_000);
  assert.equal(metrics.get(tokenC).creationTimestamp, 300);
  assert.equal(metrics.get(tokenC).source, 'debot_fallback');
});

test('circuit-breaks DeBot after a 403 while allowing later DexScreener-only checks', async () => {
  let fallbackCalls = 0;
  const client = new RobinhoodMarketDataClient({
    primary: {
      async fetchTokenMetricsBatch(addresses) {
        return new Map(addresses.map((address) => [
          address,
          { address, marketCapUsd: null, creationTimestamp: null, retryable: true }
        ]));
      }
    },
    fallback: {
      async fetchTokenMetrics() {
        fallbackCalls += 1;
        const error = new Error('DeBot request failed with HTTP 403');
        error.status = 403;
        error.retryable = false;
        throw error;
      }
    }
  });

  const first = await client.fetchTokenMetricsBatch([tokenA, tokenB]);
  const second = await client.fetchTokenMetricsBatch([tokenA]);

  assert.equal(fallbackCalls, 1);
  assert.equal(first.get(tokenA).upstreamStatus, 403);
  assert.equal(first.get(tokenB).upstreamStatus, 403);
  assert.equal(first.get(tokenA).retryable, true);
  assert.equal(second.get(tokenA).source, 'market_data_unavailable');
});
