import test from 'node:test';
import assert from 'node:assert/strict';

import { fetchMarketSnapshot } from '../src/marketClient.js';

test('keeps quote token details from the primary DexScreener pair', async () => {
  const originalFetch = globalThis.fetch;
  globalThis.fetch = async () =>
    new Response(
      JSON.stringify({
        pairs: [
          {
            chainId: 'base',
            pairAddress: '0xb7cd695a77994afe94ecbaee85b0eab5e0aa43fd',
            url: 'https://dexscreener.com/base/0xb7cd695a77994afe94ecbaee85b0eab5e0aa43fd',
            dexId: 'uniswap',
            baseToken: {
              address: '0xb2a99bc73c89b6bcbeb4650eedcd5f2776373c48',
              name: 'PSVIEW',
              symbol: 'PSVIEW'
            },
            quoteToken: {
              address: '0x0b3e328455c4059eeb9e3f84b5543f74e24e7e1b',
              name: 'Virtual Protocol',
              symbol: 'VIRTUAL'
            },
            priceUsd: '0.00088',
            marketCap: 880000,
            liquidity: { usd: 123887.67 },
            volume: { h24: 725056.62 },
            txns: { h24: { buys: 100, sells: 80 } },
            info: {
              websites: [],
              socials: []
            }
          }
        ]
      }),
      { status: 200, headers: { 'content-type': 'application/json' } }
    );

  try {
    const snapshot = await fetchMarketSnapshot('0xb2a99bc73c89b6bcbeb4650eedcd5f2776373c48');

    assert.equal(snapshot.quoteTokenSymbol, 'VIRTUAL');
    assert.equal(snapshot.quoteTokenName, 'Virtual Protocol');
    assert.equal(snapshot.quoteTokenAddress, '0x0b3e328455c4059eeb9e3f84b5543f74e24e7e1b');
    assert.equal(snapshot.pairName, 'PSVIEW/VIRTUAL');
  } finally {
    globalThis.fetch = originalFetch;
  }
});
