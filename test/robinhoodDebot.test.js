import test from 'node:test';
import assert from 'node:assert/strict';

import {
  normalizeHotToken,
  normalizeMarketHistory,
  normalizeTokenDetail,
  normalizeTokenMetrics,
  normalizeWalletTokenProfit,
  RobinhoodDebotClient
} from '../src/robinhood/debotClient.js';

const tokenAddress = '0x1111111111111111111111111111111111111111';
const walletAddress = '0xaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa';

test('normalizes DeBot ratio fields into explicit percentages', () => {
  const token = normalizeHotToken({
    chain: 'robinhood',
    address: '0xABCDEFabcdefABCDEFabcdefABCDEFabcdefABCD',
    symbol: 'WALLET',
    name: 'Robinhood Wallet',
    decimals: 18,
    creation_timestamp: 1783645324,
    logo: 'https://example.com/logo.png',
    market_info: {
      price: 0.0021,
      mkt_cap: 2_100_000,
      holders: 1950,
      volume: 900_000,
      percent_5m: 0.064,
      percent_1h: 0.193,
      percent_24h: 870.84,
      buys: 2425,
      sells: 1794,
      uniq_wallet_swaps: 1231
    },
    pair_summary_info: { liquidity: 430_000 },
    safe_info: { goplus: { is_honeypot: 0, buy_tax: 0, sell_tax: 0 } },
    kol_count: 27,
    tags: ['noxafun']
  });

  assert.equal(token.address, '0xabcdefabcdefabcdefabcdefabcdefabcdefabcd');
  assert.equal(token.change1hPercent, 19.3);
  assert.equal(token.change24hPercent, 87_084);
  assert.equal(token.liquidityUsd, 430_000);
  assert.equal(token.safe.honeypot, false);
  assert.equal(token.effectiveWallets, 1231);
});

test('normalizes detailed metric windows without double converting DeBot ratios', () => {
  const metrics = normalizeTokenMetrics({
    chain: 'robinhood',
    token: '0xabcdefabcdefabcdefabcdefabcdefabcdefabcd',
    meta: { symbol: 'DOG', name: 'Gold Dog', decimals: 9, creation_timestamp: 100 },
    metrics: {
      '24h': {
        percent: 9,
        volume: 500_000,
        buy_wallets: 240,
        sell_wallets: 180
      }
    },
    liquidity: 80_000,
    price: 0.01,
    update_time: 200
  });

  assert.equal(metrics.windows['24h'].changePercent, 900);
  assert.equal(metrics.effectiveWallets, 240);
  assert.equal(metrics.liquidityUsd, 80_000);
});

test('normalizes the public token detail response used by holder-first scans', () => {
  const detail = normalizeTokenDetail({
    token: {
      meta: {
        chain: 'robinhood',
        address: tokenAddress.toUpperCase().replace('0X', '0x'),
        creator_address: walletAddress,
        symbol: 'DOG',
        name: 'Gold Dog',
        decimals: 18,
        creation_timestamp: 100,
        logo: 'https://example.com/dog.png'
      }
    },
    pair: {
      price: 2,
      market_cap: 2_000_000,
      totalSupply: 1_000_000,
      tokenPairAddress: '0x4444444444444444444444444444444444444444',
      dex: { dex_name: 'uniswapv2' }
    },
    market_metrics: { price: 2.1, total_liquidity: 90_000, holders: 450, update_time: 200 },
    pools: {
      list: [{
        pair: '0x2222222222222222222222222222222222222222',
        dex_name: 'uniswapv3',
        liquidity: 75_000,
        base_token: { symbol: 'WETH', address: '0x3333333333333333333333333333333333333333' }
      }]
    }
  });

  assert.equal(detail.address, tokenAddress);
  assert.equal(detail.creatorAddress, walletAddress);
  assert.equal(detail.priceUsd, 2.1);
  assert.equal(detail.liquidityUsd, 90_000);
  assert.equal(detail.holders, 450);
  assert.equal(detail.totalSupply, 1_000_000);
  assert.equal(detail.primaryPoolAddress, '0x4444444444444444444444444444444444444444');
  assert.equal(detail.primaryDex, 'uniswapv2');
  assert.deepEqual(detail.pools[0], {
    address: '0x2222222222222222222222222222222222222222',
    dex: 'uniswapv3',
    liquidityUsd: 75_000,
    quoteSymbol: 'WETH',
    quoteAddress: '0x3333333333333333333333333333333333333333'
  });
});

test('normalizes DeBot market history supply and daily highs', () => {
  const history = normalizeMarketHistory({
    decimals: 18,
    total_supply: 1_000_000_000n * (10n ** 18n),
    list: [
      { time: 200, high: 0.0156 },
      { time: 100, high: 0.01 },
      { time: null, high: 999 }
    ]
  });

  assert.equal(history.normalizedSupply, 1_000_000_000);
  assert.deepEqual(history.candles, [
    { time: 200, high: 0.0156 },
    { time: 100, high: 0.01 }
  ]);
});

test('fetches peak market cap from the explicit primary pool and normalized supply', async () => {
  const requests = [];
  const client = new RobinhoodDebotClient({
    baseUrl: 'https://debot.test/api',
    fetchImpl: async (input) => {
      const url = new URL(input);
      requests.push(url);
      return Response.json({
        code: 0,
        data: {
          decimals: 18,
          total_supply: 1e27,
          list: [
            { time: 100, high: 0.01 },
            { time: 200, high: 0.0156 }
          ]
        }
      });
    }
  });
  const peak = await client.fetchTokenPeakMarketCap(tokenAddress, {
    creationTimestamp: 50,
    totalSupply: 1_000_000_000,
    primaryPoolAddress: '0x4444444444444444444444444444444444444444',
    primaryDex: 'uniswapv2'
  });

  assert.equal(peak.peakPriceUsd, 0.0156);
  assert.equal(peak.peakMarketCapUsd, 15_600_000);
  assert.equal(peak.peakMarketCapAt, 200);
  assert.equal(peak.source, 'debot_primary_pool_daily_high');
  assert.equal(requests[0].pathname, '/api/market/v4');
  assert.equal(requests[0].searchParams.get('pair'), '0x4444444444444444444444444444444444444444');
  assert.equal(requests[0].searchParams.get('start'), '50');
  assert.equal(requests[0].searchParams.get('interval'), '86400');
});

test('derives holding value and realized/unrealized multiples from DeBot wallet profit lots', () => {
  const profit = normalizeWalletTokenProfit({
    wallet: walletAddress.toUpperCase().replace('0X', '0x'),
    token: tokenAddress,
    price: 4,
    position: 90,
    actual_buy_amount: 100,
    actual_buy_cost: 200,
    buy_amount: 300,
    sell_amount: 200,
    buy_volume: 1_000,
    sell_volume: 1_600,
    buy_count: 3,
    sell_count: 2,
    avg_buy_price: 2,
    realized_profit: 800,
    unrealized_profit: 200,
    profit: 1_000,
    first_trade_time: 10,
    last_trade_time: 20
  });

  assert.equal(profit.address, walletAddress);
  assert.equal(profit.holdingTokenAmount, 90);
  assert.equal(profit.holdingValueUsd, 360);
  assert.equal(profit.remainingCostUsd, 200);
  assert.equal(profit.realizedMultiple, 2);
  assert.equal(profit.unrealizedMultiple, 1.8);
  assert.equal(profit.totalMultiple, 1.96);
  assert.equal(profit.buyTimes, 3);
  assert.equal(profit.sellTimes, 2);
});

test('trusts current position over historical actual buy amount for fully exited wallets', () => {
  const profit = normalizeWalletTokenProfit({
    wallet: walletAddress,
    token: tokenAddress,
    price: 0.01,
    position: 0,
    balance: 0,
    actual_buy_amount: 23_693,
    buy_amount: 23_693,
    sell_amount: -23_693,
    buy_volume: 526.06,
    sell_volume: -738.18,
    profit: 234.31
  });

  assert.equal(profit.holdingTokenAmount, 0);
  assert.equal(profit.holdingValueUsd, 0);
  assert.equal(profit.totalMultiple > 1, true);
});

test('keeps realized multiple unknown when the wallet has never sold', () => {
  const profit = normalizeWalletTokenProfit({
    wallet: walletAddress,
    token: tokenAddress,
    price: 10,
    position: 1_000,
    actual_buy_amount: 1_000,
    actual_buy_cost: 600,
    buy_amount: 1_000,
    sell_amount: 0,
    buy_volume: 620,
    sell_volume: 0,
    realized_profit: 0,
    unrealized_profit: 9_400,
    profit: 9_400
  });

  assert.equal(profit.realizedMultiple, null);
  assert.equal(profit.unrealizedMultiple > 10, true);
});

test('exposes token detail and wallet profit requests with validated normalized addresses', async () => {
  const requests = [];
  const client = new RobinhoodDebotClient({
    baseUrl: 'https://debot.test/api',
    fetchImpl: async (input) => {
      const url = new URL(input);
      requests.push(url);
      if (url.pathname.endsWith('/dashboard/token/detail')) {
        return Response.json({
          code: 0,
          data: { token: { meta: { address: tokenAddress, symbol: 'DOG' } }, market_metrics: { price: 1 } }
        });
      }
      return Response.json({
        code: 0,
        data: { wallet: walletAddress, token: tokenAddress, buy_volume: 600, profit_rate: 9 }
      });
    }
  });

  const detail = await client.fetchTokenDetail(tokenAddress.toUpperCase().replace('0X', '0x'));
  const profit = await client.fetchWalletTokenProfit(tokenAddress, walletAddress.toUpperCase().replace('0X', '0x'));

  assert.equal(detail.address, tokenAddress);
  assert.equal(profit.address, walletAddress);
  assert.equal(profit.totalMultiple, 10);
  assert.equal(requests[0].searchParams.get('chain'), 'robinhood');
  assert.equal(requests[0].searchParams.get('token'), tokenAddress);
  assert.equal(requests[1].searchParams.get('wallet'), walletAddress);
  await assert.rejects(client.fetchTokenDetail('0x1234'), /Invalid Robinhood token address/);
  await assert.rejects(client.fetchWalletTokenProfit(tokenAddress, '0x1234'), /Invalid Robinhood wallet address/);
  assert.equal(requests.length, 2);
});
