import test from 'node:test';
import assert from 'node:assert/strict';

import { transformSignalResponse } from '../src/transform.js';

test('returns the first ten Debot results in the original order', () => {
  const response = {
    data: {
      meta: {
        tokens: Object.fromEntries(
          Array.from({ length: 12 }, (_, index) => {
            const address = `0x${String(index + 1).padStart(40, '0')}`;
            return [
              address,
              {
                address,
                chain: 'base',
                symbol: `COIN${index + 1}`,
                name: `Coin ${index + 1}`,
                logo: `https://cdn.example/${index + 1}.png`,
                creation_timestamp: 1779510000 + index
              }
            ];
          })
        )
      },
      results: Array.from({ length: 12 }, (_, index) => ({
        id: String(index + 1),
        create_time: 1779513000 + index,
        chain: 'base',
        token: `0x${String(index + 1).padStart(40, '0')}`,
        group_name: `Group ${index + 1}`,
        wallet_stats: { wallet_count: index + 10 },
        token_trading_stat: {
          price_usd: String(index + 0.1234),
          market_cap_usd: String((index + 1) * 1000)
        }
      }))
    }
  };

  const rows = transformSignalResponse(response, { limit: 10 });

  assert.equal(rows.length, 10);
  assert.deepEqual(
    rows.map((row) => row.symbol),
    ['COIN1', 'COIN2', 'COIN3', 'COIN4', 'COIN5', 'COIN6', 'COIN7', 'COIN8', 'COIN9', 'COIN10']
  );
  assert.equal(rows[0].rank, 1);
  assert.equal(rows[9].rank, 10);
  assert.equal(rows[0].address, '0x0000000000000000000000000000000000000001');
  assert.equal(rows[0].avgWalletVolume, null);
  assert.equal(rows[0].holders, null);
  assert.equal(rows[0].liquidityUsd, null);
  assert.equal(rows[0].volume24h, null);
  assert.equal(rows[0].priceChange24h, null);
});

test('keeps a useful fallback when token metadata is missing', () => {
  const response = {
    data: {
      meta: { tokens: {} },
      results: [
        {
          id: 'missing-token',
          create_time: 1779513000,
          chain: 'base',
          token: '0xabc'
        }
      ]
    }
  };

  const rows = transformSignalResponse(response, { limit: 10 });

  assert.deepEqual(rows, [
    {
      rank: 1,
      id: 'missing-token',
      chain: 'base',
      address: '0xabc',
      symbol: '0xabc',
      name: '0xabc',
      logo: '',
      createTime: 1779513000,
      creationTimestamp: null,
      groupName: '',
      walletCount: null,
      avgWalletVolume: null,
      priceUsd: null,
      marketCapUsd: null,
      holders: null,
      liquidityUsd: null,
      volume24h: null,
      priceChange24h: null
    }
  ]);
});

test('does not pass a contract address through as a logo URL', () => {
  const response = {
    data: {
      meta: {
        tokens: {
          '0xlogo': {
            address: '0xlogo',
            chain: 'base',
            symbol: 'LOGO',
            name: 'Logo Token',
            logo: '0x593092ee5c54cb4c794b49e06ab119759b838ba3'
          }
        }
      },
      results: [
        {
          id: 'logo-token',
          create_time: 1779513000,
          chain: 'base',
          token: '0xlogo'
        }
      ]
    }
  };

  const [row] = transformSignalResponse(response, { limit: 10 });

  assert.equal(row.logo, '');
});

test('keeps signal metrics that are useful for later analysis', () => {
  const response = {
    data: {
      meta: {
        tokens: {
          '0xaaa': {
            address: '0xaaa',
            chain: 'base',
            symbol: 'AIX',
            name: 'AI X'
          }
        }
      },
      results: [
        {
          id: '1',
          create_time: 1779513000,
          chain: 'base',
          token: '0xaaa',
          avg_wallet_volume: '798.1445508676476',
          group_name: 'SmartMoney#700金额5分钟3钱包#150K',
          wallet_stats: [{}, {}, {}],
          token_trading_stat: {
            price: 0.0000189,
            mkt_cap: 1897856.84,
            holders: 1672,
            liquidity: 660511.06,
            volume_24h: 4660154.36,
            percent24h: 2.27
          }
        }
      ]
    }
  };

  const [row] = transformSignalResponse(response, { limit: 10 });

  assert.equal(row.avgWalletVolume, 798.1445508676476);
  assert.equal(row.holders, 1672);
  assert.equal(row.liquidityUsd, 660511.06);
  assert.equal(row.volume24h, 4660154.36);
  assert.equal(row.priceChange24h, 2.27);
});
