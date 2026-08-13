import test from 'node:test';
import assert from 'node:assert/strict';

import {
  BSC_CHAIN,
  FOUR_MEME_BUY_TOPIC,
  FOUR_MEME_SELL_TOPIC,
  FOUR_MEME_TOKEN_CREATE_TOPIC,
  createBscConfig,
  isBscAddress,
  normalizeBscAddress
} from '../src/bsc/config.js';

test('defines the BSC mainnet profile and independent data defaults', () => {
  assert.equal(BSC_CHAIN.id, 56);
  assert.equal(BSC_CHAIN.chainId, 56);
  assert.equal(BSC_CHAIN.hexId, '0x38');
  assert.equal(BSC_CHAIN.debotChain, 'bsc');
  assert.equal(BSC_CHAIN.rpcUrl, 'https://bsc-rpc.publicnode.com');
  assert.equal(Object.hasOwn(BSC_CHAIN, 'holderRpcUrl'), false);
  assert.equal(BSC_CHAIN.explorerUrl, 'https://bscscan.com');
  assert.equal(BSC_CHAIN.dexScreenerTokensUrl, 'https://api.dexscreener.com/tokens/v1/bsc');
  assert.equal(BSC_CHAIN.holderSource, 'debot_token_holder_profile');
  assert.equal(BSC_CHAIN.nativeSymbol, 'BNB');
  assert.equal(BSC_CHAIN.wbnb, '0xbb4cdb9cbd36b01bd1cbaebf2de08d9173bc095c');
  assert.equal(BSC_CHAIN.usdt, '0x55d398326f99059ff775485246999027b3197955');
  assert.equal(BSC_CHAIN.usdc, '0x8ac76a51cc950d9822d68b83fe1ad97b32cd580d');
  assert.equal(BSC_CHAIN.fdusd, '0xc5f0f7b66764f6ec8c8dff7ba683102295e16409');
  assert.equal(BSC_CHAIN.busd, '0xe9e7cea3dedca5984780bafc599bd69add087d56');
  assert.equal(BSC_CHAIN.dai, '0x1af3f329e8be154074d8769d1ffa4ee058b1dbc3');
  assert.equal(BSC_CHAIN.tusd, '0x14016e85a25aeb13065688cafb43044c2ef86784');
  assert.equal(BSC_CHAIN.usdd, '0xd17479997f34dd9156deef8f95a52d81d265be9c');
  assert.equal(BSC_CHAIN.fourMemeTokenManager, '0x5c952063c7fc8610ffdb798152d69f0b9550762b');
  assert.deepEqual(BSC_CHAIN.quoteTokens, [
    BSC_CHAIN.wbnb,
    BSC_CHAIN.usdt,
    BSC_CHAIN.usdc,
    BSC_CHAIN.busd,
    BSC_CHAIN.fdusd,
    BSC_CHAIN.dai,
    BSC_CHAIN.tusd,
    BSC_CHAIN.usdd
  ]);
  assert.deepEqual(BSC_CHAIN.swapTopics, [FOUR_MEME_BUY_TOPIC, FOUR_MEME_SELL_TOPIC]);
  assert.deepEqual(BSC_CHAIN.launchProfiles, [{
    address: BSC_CHAIN.fourMemeTokenManager,
    topic: FOUR_MEME_TOKEN_CREATE_TOPIC,
    platform: 'four_meme',
    walletDataWord: 0,
    tokenDataWord: 1
  }]);
  assert.equal(BSC_CHAIN.infrastructureAddresses.includes(BSC_CHAIN.v3Factory), true);
  assert.equal(BSC_CHAIN.infrastructureAddresses.includes(BSC_CHAIN.v2Router), true);
  assert.equal(Object.isFrozen(BSC_CHAIN), true);
  assert.equal(Object.isFrozen(BSC_CHAIN.quoteTokens), true);
  assert.equal(Object.isFrozen(BSC_CHAIN.swapTopics), true);
  assert.equal(Object.isFrozen(BSC_CHAIN.launchProfiles), true);

  assert.equal(
    normalizeBscAddress(' 0x55d398326f99059fF775485246999027B3197955 '),
    BSC_CHAIN.usdt
  );
  assert.equal(isBscAddress(BSC_CHAIN.usdt), true);
  assert.equal(isBscAddress('0x1234'), false);

  const config = createBscConfig({
    BSC_RPC_URL: 'https://bsc-rpc.example',
    BSC_HOLDER_RPC_URL: 'https://bsc-holder-rpc.example',
    BSC_HOLDER_LOG_RPC_URL: '  https://bsc-holder-logs.example/v1  ',
    BSC_DATA_FILE: '/tmp/bsc-independent.sqlite',
    EVM_WALLET_DATA_FILE: '/tmp/shared-evm-wallets.sqlite',
    BSC_REQUEST_TIMEOUT_MS: '999999'
  });
  assert.equal(config.chain, BSC_CHAIN);
  assert.equal(config.rpcUrl, 'https://bsc-rpc.example');
  assert.equal(config.holderRpcUrl, 'https://bsc-holder-rpc.example');
  assert.equal(config.holderLogRpcUrl, 'https://bsc-holder-logs.example/v1');
  assert.equal(config.debotBridgeUrl, 'http://127.0.0.1:18118/internal/debot/request');
  assert.equal(config.debotBridgeTimeoutMs, 90_000);
  assert.equal(config.debotRequestTimeoutMs, 95_000);
  assert.equal(Object.hasOwn(config, 'blockscoutApiUrl'), false);
  assert.equal(config.dataFile, '/tmp/bsc-independent.sqlite');
  assert.equal(config.walletDataFile, '/tmp/shared-evm-wallets.sqlite');
  assert.equal(config.requestTimeoutMs, 60_000);

  assert.equal(createBscConfig({}).holderRpcUrl, '');
  assert.equal(createBscConfig({}).holderLogRpcUrl, '');
});
