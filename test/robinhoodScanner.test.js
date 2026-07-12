import test from 'node:test';
import assert from 'node:assert/strict';
import {
  encodeAbiParameters,
  encodeEventTopics,
  encodeFunctionData,
  encodeFunctionResult,
  parseAbi,
  parseAbiItem
} from 'viem';

import { ROBINHOOD_CHAIN } from '../src/robinhood/config.js';
import { chooseMainPool } from '../src/robinhood/poolClient.js';
import { decodePoolSwap, scanToken, verifyPoolOnchain, V2_SWAP_EVENT, V3_SWAP_EVENT } from '../src/robinhood/scanner.js';

const token = '0x1111111111111111111111111111111111111111';
const weth = '0x2222222222222222222222222222222222222222';
const pool = '0x3333333333333333333333333333333333333333';
const user = '0x4444444444444444444444444444444444444444';

test('chooses the deepest supported WETH pool without trusting its remote price for accounting', () => {
  const selected = chooseMainPool(
    [
      { pairAddress: pool, labels: ['v3'], quoteToken: { address: weth }, liquidity: { usd: 80_000 } },
      { pairAddress: '0x5555555555555555555555555555555555555555', labels: ['v2'], quoteToken: { address: weth }, liquidity: { usd: 120_000 } },
      { pairAddress: '0x6666666666666666666666666666666666666666', labels: ['v3'], quoteToken: { address: token }, liquidity: { usd: 900_000 } }
    ],
    { targetToken: token, supportedQuotes: [weth] }
  );

  assert.equal(selected.address, '0x5555555555555555555555555555555555555555');
  assert.equal(selected.version, 'v2');
  assert.equal(selected.liquidityUsd, 120_000);
});

test('decodes a V3 target-token buy from signed pool deltas', () => {
  const topics = encodeEventTopics({
    abi: [V3_SWAP_EVENT],
    eventName: 'Swap',
    args: { sender: user, recipient: user }
  });
  const data = encodeAbiParameters(
    [
      { type: 'int256' },
      { type: 'int256' },
      { type: 'uint160' },
      { type: 'uint128' },
      { type: 'int24' }
    ],
    [-1000n * 10n ** 18n, 2n * 10n ** 18n, 1n, 1n, 0]
  );
  const action = decodePoolSwap({
    version: 'v3',
    log: { address: pool, topics, data, transactionHash: '0xabc', blockNumber: '0x10', logIndex: '0x2' },
    token0: token,
    token1: weth,
    targetToken: token,
    quoteToken: weth,
    targetDecimals: 18,
    quoteDecimals: 18
  });

  assert.equal(action.side, 'buy');
  assert.equal(action.tokenAmount, 1000);
  assert.equal(action.quoteAmount, 2);
  assert.equal(action.priceNative, 0.002);
});

test('decodes a V2 target-token sell from amount in/out fields', () => {
  const topics = encodeEventTopics({
    abi: [V2_SWAP_EVENT],
    eventName: 'Swap',
    args: { sender: user, to: user }
  });
  const data = encodeAbiParameters(
    [{ type: 'uint256' }, { type: 'uint256' }, { type: 'uint256' }, { type: 'uint256' }],
    [100n * 10n ** 18n, 0n, 0n, 1n * 10n ** 18n]
  );
  const action = decodePoolSwap({
    version: 'v2',
    log: { address: pool, topics, data, transactionHash: '0xdef', blockNumber: '0x20', logIndex: '0x3' },
    token0: token,
    token1: weth,
    targetToken: token,
    quoteToken: weth,
    targetDecimals: 18,
    quoteDecimals: 18
  });

  assert.equal(action.side, 'sell');
  assert.equal(action.tokenAmount, 100);
  assert.equal(action.quoteAmount, 1);
});

test('verifies a hinted pool against code, pair tokens and the known factory', async () => {
  const abi = parseAbi([
    'function token0() view returns (address)',
    'function token1() view returns (address)',
    'function factory() view returns (address)'
  ]);
  const outputByData = new Map([
    [
      encodeFunctionData({ abi, functionName: 'token0' }),
      encodeFunctionResult({ abi, functionName: 'token0', result: token })
    ],
    [
      encodeFunctionData({ abi, functionName: 'token1' }),
      encodeFunctionResult({ abi, functionName: 'token1', result: ROBINHOOD_CHAIN.weth })
    ],
    [
      encodeFunctionData({ abi, functionName: 'factory' }),
      encodeFunctionResult({ abi, functionName: 'factory', result: ROBINHOOD_CHAIN.v2Factory })
    ]
  ]);
  const verified = await verifyPoolOnchain({
    pool: { address: pool, version: 'v2' },
    targetToken: token,
    rpc: {
      request: async () => '0x6000',
      ethCall: async ({ data }) => outputByData.get(data)
    }
  });

  assert.equal(verified.verified, true);
  assert.equal(verified.factory, ROBINHOOD_CHAIN.v2Factory);
  assert.equal(verified.token1, ROBINHOOD_CHAIN.weth);
});

test('scans a verified pool into transaction-attributed economic actions', async () => {
  const readAbi = parseAbi([
    'function token0() view returns (address)',
    'function token1() view returns (address)',
    'function factory() view returns (address)',
    'function getReserves() view returns (uint112 reserve0, uint112 reserve1, uint32 blockTimestampLast)'
  ]);
  const outputByData = new Map([
    [
      encodeFunctionData({ abi: readAbi, functionName: 'token0' }),
      encodeFunctionResult({ abi: readAbi, functionName: 'token0', result: token })
    ],
    [
      encodeFunctionData({ abi: readAbi, functionName: 'token1' }),
      encodeFunctionResult({ abi: readAbi, functionName: 'token1', result: ROBINHOOD_CHAIN.weth })
    ],
    [
      encodeFunctionData({ abi: readAbi, functionName: 'factory' }),
      encodeFunctionResult({ abi: readAbi, functionName: 'factory', result: ROBINHOOD_CHAIN.v2Factory })
    ],
    [
      encodeFunctionData({ abi: readAbi, functionName: 'getReserves' }),
      encodeFunctionResult({
        abi: readAbi,
        functionName: 'getReserves',
        result: [1_000_000n * 10n ** 18n, 100n * 10n ** 18n, 0]
      })
    ]
  ]);
  const txHash = `0x${'ab'.repeat(32)}`;
  const topics = encodeEventTopics({
    abi: [V2_SWAP_EVENT],
    eventName: 'Swap',
    args: { sender: user, to: user }
  });
  const data = encodeAbiParameters(
    [{ type: 'uint256' }, { type: 'uint256' }, { type: 'uint256' }, { type: 'uint256' }],
    [0n, 1n * 10n ** 18n, 1_000n * 10n ** 18n, 0n]
  );
  const rpc = {
    batchSize: 50,
    request: async () => '0x6000',
    ethCall: async ({ data: callData }) => outputByData.get(callData),
    getBlockNumber: async () => 100,
    findBlockByTimestamp: async () => 10,
    getLogs: async () => [
      { address: pool, topics, data, transactionHash: txHash, blockNumber: '0x20', logIndex: '0x2' }
    ],
    getTransactionsByHashes: async () => [
      { hash: txHash, from: user, to: pool, transactionIndex: '0x3' }
    ],
    batchRequest: async () => [{ number: '0x20', timestamp: '0x64' }]
  };

  const result = await scanToken({
    token: { address: token, symbol: 'DOG', decimals: 18, creationTimestamp: 90, priceUsd: 0.2 },
    pools: [
      {
        pairAddress: pool,
        labels: ['v2'],
        baseToken: { address: token },
        quoteToken: { address: ROBINHOOD_CHAIN.weth },
        liquidity: { usd: 100_000 },
        priceNative: '0.0001',
        priceUsd: '0.2',
        pairCreatedAt: 90_000
      }
    ],
    rpc,
    config: {
      maxSwapsPerToken: 100,
      logWindow: 1_000,
      defaultWinnerMultiple: 10,
      minLiquidityUsd: 50_000,
      minEffectiveWallets: 100
    }
  });

  assert.equal(result.scan.complete, true);
  assert.equal(result.pool.verified, true);
  assert.deepEqual(result.pool.reserves, { target: 1_000_000, quote: 100 });
  assert.equal(result.pool.currentPriceNative, 0.0001);
  assert.equal(result.pool.quoteUsd, 2000);
  assert.equal(result.pool.verifiedLiquidityUsd, 400_000);
  assert.equal(result.actions[0].wallet, user);
  assert.equal(result.actions[0].attributionConfidence, 'high');
  assert.equal(result.actions[0].transactionIndex, 3);
  assert.equal(result.actions[0].blockTimestamp, 100);
  assert.equal(result.actions[0].side, 'buy');
});
