import test from 'node:test';
import assert from 'node:assert/strict';

import {
  BASE_CHAIN,
  createBaseConfig,
  isBaseAddress,
  normalizeBaseAddress
} from '../src/base/config.js';

test('defines the verified Base mainnet profile and independent data defaults', () => {
  assert.equal(BASE_CHAIN.id, 8453);
  assert.equal(BASE_CHAIN.chainId, 8453);
  assert.equal(BASE_CHAIN.hexId, '0x2105');
  assert.equal(BASE_CHAIN.debotChain, 'base');
  assert.equal(BASE_CHAIN.rpcUrl, 'https://mainnet.base.org');
  assert.equal(BASE_CHAIN.explorerUrl, 'https://base.blockscout.com');
  assert.equal(BASE_CHAIN.blockscoutApiUrl, 'https://base.blockscout.com/api/v2');
  assert.equal(BASE_CHAIN.weth, '0x4200000000000000000000000000000000000006');
  assert.equal(BASE_CHAIN.usdc, '0x833589fcd6edb6e08f4c7c32d4f71b54bda02913');
  assert.deepEqual(BASE_CHAIN.quoteTokens, [BASE_CHAIN.weth, BASE_CHAIN.usdc]);
  assert.equal(BASE_CHAIN.infrastructureAddresses.includes(BASE_CHAIN.v3Factory), true);
  assert.equal(BASE_CHAIN.infrastructureAddresses.includes(BASE_CHAIN.v2Router), true);
  assert.equal(Object.isFrozen(BASE_CHAIN), true);
  assert.equal(Object.isFrozen(BASE_CHAIN.quoteTokens), true);

  assert.equal(
    normalizeBaseAddress(' 0x833589fCD6eDb6E08f4c7C32D4f71b54bDa02913 '),
    BASE_CHAIN.usdc
  );
  assert.equal(isBaseAddress(BASE_CHAIN.usdc), true);
  assert.equal(isBaseAddress('0x1234'), false);

  const config = createBaseConfig({
    BASE_RPC_URL: 'https://base-rpc.example',
    BASE_BLOCKSCOUT_API_URL: 'https://base-explorer.example/api/v2',
    BASE_DATA_FILE: '/tmp/base-independent.sqlite',
    BASE_REQUEST_TIMEOUT_MS: '999999'
  });
  assert.equal(config.chain, BASE_CHAIN);
  assert.equal(config.rpcUrl, 'https://base-rpc.example');
  assert.equal(config.blockscoutApiUrl, 'https://base-explorer.example/api/v2');
  assert.equal(config.dataFile, '/tmp/base-independent.sqlite');
  assert.equal(config.requestTimeoutMs, 60_000);
});
