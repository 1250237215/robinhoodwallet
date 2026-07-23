import test from 'node:test';
import assert from 'node:assert/strict';

import {
  createRobinhoodResilientScanner,
  dexScreenerTokenMetadata,
  isDebotAccessBlocked
} from '../src/robinhood/resilientScanner.js';

const token = '0x1111111111111111111111111111111111111111';
const pool = '0x2222222222222222222222222222222222222222';
const rpc = { id: 'robinhood-rpc' };

function debotBlockedError() {
  const error = new Error('DeBot request failed with HTTP 403');
  error.status = 403;
  error.retryable = false;
  return error;
}

function dexScreenerPairs() {
  return [{
    chainId: 'robinhood',
    pairAddress: pool,
    dexId: 'uniswap',
    baseToken: { address: token.toUpperCase().replace('0X', '0x'), symbol: 'DOG', name: 'Gold Dog' },
    quoteToken: { address: '0x5fc5360d0400a0fd4f2af552add042d716f1d168', symbol: 'USDG' },
    priceUsd: '0.25',
    liquidity: { usd: 90_000 },
    marketCap: 2_500_000,
    pairCreatedAt: 1_700_000_000_000
  }];
}

test('recognizes only explicit DeBot authentication or challenge rejections as fallback eligible', () => {
  assert.equal(isDebotAccessBlocked(debotBlockedError()), true);
  assert.equal(isDebotAccessBlocked(new Error('DeBot request failed with HTTP 401')), true);
  assert.equal(isDebotAccessBlocked(new Error('DeBot request failed with HTTP 500')), false);
  assert.equal(isDebotAccessBlocked(new Error('network timeout')), false);
});

test('derives token metadata from the DexScreener pool directory response', () => {
  assert.deepEqual(dexScreenerTokenMetadata(dexScreenerPairs(), token), {
    symbol: 'DOG',
    name: 'Gold Dog',
    priceUsd: 0.25,
    liquidityUsd: 90_000,
    marketCapUsd: 2_500_000,
    creationTimestamp: 1_700_000_000,
    source: 'dexscreener_robinhood'
  });
});

test('falls back from a DeBot 403 to verified pool and RPC scanning', async () => {
  const progress = [];
  let onchainOptions;
  const poolClient = {
    async fetchPools(address) {
      assert.equal(address, token);
      return dexScreenerPairs();
    }
  };
  const scanner = createRobinhoodResilientScanner({
    poolClient,
    rpc,
    config: { logWindow: 20_000, maxSwapsPerToken: 1_000 },
    holderScanner: async () => {
      throw debotBlockedError();
    },
    onchainScanner: async (options) => {
      onchainOptions = options;
      options.onProgress({ stage: 'transactions', percent: 55 });
      return {
        tokenPatch: { currentPriceNative: 0.01, quoteUsd: 1 },
        pool: { address: pool, verified: true },
        qualification: { status: 'manual', confidence: 'high' },
        actions: [{ wallet: '0xaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa' }],
        scan: { complete: true, partial: false, historyComplete: true, actions: 1 }
      };
    },
    now: () => 1_700_000_100_000
  });

  const result = await scanner({
    token: { address: token, manual: true, name: 'Manual token' },
    config: { minEntryUsd: 500 },
    onProgress: (entry) => progress.push(entry)
  });

  assert.equal(onchainOptions.rpc, rpc);
  assert.deepEqual(onchainOptions.pools, dexScreenerPairs());
  assert.equal(onchainOptions.token.symbol, 'DOG');
  assert.equal(onchainOptions.token.name, 'Gold Dog');
  assert.equal(onchainOptions.token.creationTimestamp, 1_700_000_000);
  assert.equal(onchainOptions.config.logWindow, 20_000);
  assert.equal(onchainOptions.config.maxSwapsPerToken, 1_000);
  assert.equal(onchainOptions.config.minEntryUsd, 500);
  assert.equal(result.tokenPatch.holderAnalysis.partial, true);
  assert.match(result.tokenPatch.holderAnalysis.error, /Blockscout Holder client is unavailable/);
  assert.equal(result.tokenPatch.analysisSource, 'onchain_holder_fallback');
  assert.equal(result.scan.source, 'robinhood_rpc');
  assert.equal(result.scan.fallbackFrom, 'debot');
  assert.equal(result.scan.fallbackStatus, 403);
  assert.equal(result.scan.complete, false);
  assert.equal(result.scan.onchainComplete, true);
  assert.deepEqual(result.actions, [{ wallet: '0xaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa' }]);
  assert.equal(progress[0].stage, 'onchain_fallback');
  assert.equal(progress.at(-1).stage, 'transactions');
  assert.equal(progress.at(-1).fallbackFrom, 'debot');
});

test('falls back when all Holder-profit requests were internally recorded as DeBot 403 failures', async () => {
  let onchainCalls = 0;
  const scanner = createRobinhoodResilientScanner({
    poolClient: { fetchPools: async () => dexScreenerPairs() },
    rpc,
    holderScanner: async () => ({
      holderAnalysis: {
        candidates: [{ address: '0xaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa', profitState: 'failed' }],
        failures: [{
          address: '0xaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa',
          error: 'DeBot request failed with HTTP 403'
        }]
      }
    }),
    onchainScanner: async () => {
      onchainCalls += 1;
      return { tokenPatch: {}, actions: [], scan: { complete: true } };
    },
    now: () => 1_700_000_100_000
  });

  const result = await scanner({ token: { address: token } });

  assert.equal(onchainCalls, 1);
  assert.equal(result.scan.fallbackFrom, 'debot');
  assert.equal(result.scan.fallbackStatus, 403);
  assert.match(result.scan.fallbackReason, /HTTP 403/);
  assert.equal(result.holderAnalysis.partial, true);
});

test('caches an explicit DeBot block so queued scans do not repeatedly challenge the upstream', async () => {
  let holderCalls = 0;
  let onchainCalls = 0;
  const scanner = createRobinhoodResilientScanner({
    poolClient: { fetchPools: async () => dexScreenerPairs() },
    rpc,
    debotBlockCooldownMs: 60_000,
    now: () => 1_700_000_100_000,
    holderScanner: async () => {
      holderCalls += 1;
      throw debotBlockedError();
    },
    onchainScanner: async () => {
      onchainCalls += 1;
      return { tokenPatch: {}, scan: { complete: true }, actions: [] };
    }
  });

  await scanner({ token: { address: token } });
  await scanner({ token: { address: token } });

  assert.equal(holderCalls, 1);
  assert.equal(onchainCalls, 2);
});

test('does not hide unexpected holder analysis failures behind a fallback scan', async () => {
  let poolCalls = 0;
  const error = new Error('Blockscout request failed with HTTP 500');
  error.status = 500;
  await assert.rejects(
    createRobinhoodResilientScanner({
      poolClient: { fetchPools: async () => { poolCalls += 1; return []; } },
      holderScanner: async () => { throw error; }
    })({ token: { address: token } }),
    /Blockscout request failed with HTTP 500/
  );
  assert.equal(poolCalls, 0);
});
