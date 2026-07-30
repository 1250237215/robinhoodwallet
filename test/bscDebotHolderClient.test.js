import test from 'node:test';
import assert from 'node:assert/strict';

import { BscDebotHolderClient } from '../src/bsc/debotHolderClient.js';

const token = '0x1111111111111111111111111111111111111111';
const walletA = '0xaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa';
const walletB = '0xbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb';
const walletC = '0xcccccccccccccccccccccccccccccccccccccccc';
const contract = '0xdddddddddddddddddddddddddddddddddddddddd';
const delegated = '0xeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeee';
const infrastructure = '0xffffffffffffffffffffffffffffffffffffffff';
const zeroProfitWallet = '0x7777777777777777777777777777777777777777';
const dead = '0x000000000000000000000000000000000000dead';

function rpcWithCodes(codes = new Map()) {
  const calls = [];
  return {
    calls,
    async batchRequest(requests) {
      calls.push(...requests);
      return requests.map((request) => codes.get(request.params[0]) || '0x');
    }
  };
}

function profileClient(raw) {
  const calls = [];
  return {
    calls,
    async fetchTokenHolderProfile(address, options) {
      calls.push({ address, options });
      return raw;
    }
  };
}

function generatedWallet(index) {
  return `0x${BigInt(1_000 + index).toString(16).padStart(40, '0')}`;
}

test('requires both the DeBot Holder profile method and a BSC RPC batch client', () => {
  assert.throws(() => new BscDebotHolderClient({}), /DeBot BSC Holder profile client/);
  assert.throws(() => new BscDebotHolderClient({
    debotClient: { fetchTokenHolderProfile: async () => ({}) }
  }), /BSC RPC client/);
});

test('normalizes confirmed DeBot Holder fields and excludes contracts, pools, CEX wallets, and infrastructure', async () => {
  const debotClient = profileClient({
    total: 8,
    list: [
      {
        wallet: walletA,
        rank: 1,
        position: '1000',
        balance: '250',
        percent: 0.25,
        profit: {
          buy_volume: '100',
          buy_amount: '500',
          buy_times: 2,
          sell_volume: '140',
          sell_amount: '200',
          sell_times: 1,
          actual_buy_amount: '300',
          actual_buy_cost: '60',
          realized_profit: '40',
          unrealized_profit: '190',
          total_profit: '230'
        }
      },
      { wallet: contract, rank: 2, position: 900, balance: 180, percent: 0.2 },
      {
        wallet: walletB,
        rank: 3,
        position: 800,
        balance: 120,
        percent: 0.15,
        tags: ['Binance Hot Wallet'],
        profit: { buy_volume: 0, buy_amount: 0, total_profit: 0 }
      },
      { wallet: walletC, rank: 4, position: 700, balance: 70, percent: 0.1, label: 'Liquidity Pool' },
      { wallet: delegated, rank: 5, position: 600, balance: 30, percent: 0.05 },
      { wallet: infrastructure, rank: 6, position: 500, balance: 10, percent: 0.01 },
      {
        wallet: zeroProfitWallet,
        rank: 7,
        position: 400,
        balance: 8,
        percent: 0.005,
        profit: { buy_volume: 0, buy_amount: 0, total_profit: 0 }
      },
      { wallet: dead, rank: 8, position: 300, balance: 0, percent: 0.003 }
    ]
  });
  const rpcClient = rpcWithCodes(new Map([
    [contract, '0x60006000'],
    [delegated, `0xef0100${'12'.repeat(20)}`]
  ]));
  const client = new BscDebotHolderClient({
    debotClient,
    rpcClient,
    infrastructureAddresses: [infrastructure],
    rpcBatchSize: 3
  });

  const result = await client.fetchTopHolders(token, { limit: 10 });

  assert.equal(result.source, 'debot_token_holder_profile');
  assert.equal(result.complete, true);
  assert.equal(result.partial, false);
  assert.equal(result.denominatorPartial, false);
  assert.deepEqual(result.holders.map((holder) => holder.address), [walletA, delegated, zeroProfitWallet]);
  assert.equal(result.excludedRows, 5);
  assert.deepEqual(debotClient.calls.map((call) => call.address), [token]);
  assert.equal(debotClient.calls[0].options.limit, 10);
  assert.equal(rpcClient.calls.length, 8);
  assert.equal(rpcClient.calls.every((call) => call.method === 'eth_getCode'), true);
  assert.equal(rpcClient.calls.every((call) => call.params[1] === 'latest'), true);

  const profitable = result.holders.find((holder) => holder.address === walletA);
  assert.equal(profitable.holdingTokenAmount, 1_000);
  assert.equal(profitable.holdingValueUsd, 250);
  assert.equal(profitable.holdingSharePercent, 25);
  assert.equal(profitable.walletTokenProfit.chain, 'bsc');
  assert.equal(profitable.walletTokenProfit.address, walletA);
  assert.equal(profitable.walletTokenProfit.tokenAddress, token);
  assert.equal(profitable.walletTokenProfit.currentPriceUsd, 0.25);
  assert.equal(profitable.walletTokenProfit.averageBuyPriceUsd, 0.2);
  assert.equal(profitable.walletTokenProfit.totalProfitUsd, 230);

  assert.equal(result.holders.some((holder) => holder.address === contract), false);
  assert.equal(result.holders.some((holder) => holder.address === walletB), false);
  assert.equal(result.holders.some((holder) => holder.address === walletC), false);
  assert.equal(result.holders.some((holder) => holder.address === infrastructure), false);
  assert.equal(result.holders.some((holder) => holder.address === dead), false);
  assert.deepEqual(result.holders.find((holder) => holder.address === delegated).exclusionReasons, []);
  assert.equal(
    'walletTokenProfit' in result.holders.find((holder) => holder.address === zeroProfitWallet),
    false
  );
});

test('reports top-100 and caller truncation as partial unless an authoritative total proves completion', async () => {
  const rows100 = Array.from({ length: 100 }, (_, index) => ({
    wallet: generatedWallet(index),
    position: 100 - index,
    balance: 100 - index,
    percent: 0.001
  }));
  const run = async (raw, limit = 100) => new BscDebotHolderClient({
    debotClient: profileClient(raw),
    rpcClient: rpcWithCodes()
  }).fetchTopHolders(token, { limit });

  const cappedWithoutTotal = await run({ list: rows100 });
  assert.equal(cappedWithoutTotal.holders.length, 100);
  assert.equal(cappedWithoutTotal.denominatorPartial, true);
  assert.equal(cappedWithoutTotal.complete, false);
  assert.equal(cappedWithoutTotal.reachedEnd, false);

  const exactTotal = await run({ total: 100, list: rows100 });
  assert.equal(exactTotal.denominatorPartial, false);
  assert.equal(exactTotal.complete, true);
  assert.equal(exactTotal.reachedEnd, true);

  const callerTruncated = await run({ total: 20, list: rows100.slice(0, 20) }, 10);
  assert.equal(callerTruncated.holders.length, 10);
  assert.equal(callerTruncated.denominatorPartial, true);
  assert.equal(callerTruncated.complete, false);

  const explicitMore = await run({ has_more: true, list: rows100.slice(0, 5) });
  assert.equal(explicitMore.denominatorPartial, true);
  assert.equal(explicitMore.complete, false);
});

test('fails closed when RPC contract verification omits a Holder result', async () => {
  const client = new BscDebotHolderClient({
    debotClient: profileClient({
      total: 2,
      list: [
        { wallet: walletA, position: 10, balance: 10 },
        { wallet: walletB, position: 9, balance: 9 }
      ]
    }),
    rpcClient: {
      async batchRequest() {
        return ['0x'];
      }
    }
  });

  await assert.rejects(client.fetchTopHolders(token), (error) =>
    error?.code === 'BSC_HOLDER_EOA_CHECK_FAILED' &&
    /contract verification failed/.test(error.message) &&
    /incomplete contract verification batch/.test(error.cause?.message || '')
  );
});
