import assert from 'node:assert/strict';
import test from 'node:test';

import { buildWalletSummaries, reliablePriceStats } from '../src/robinhood/qualification.js';
import { createRobinhoodService } from '../src/robinhood/service.js';
import { createRobinhoodStore } from '../src/robinhood/store.js';

const wallet = '7xKXtg2CW87d97TXJSDpbD5jBkheTqA83TZRuJosgGi';
const counterparty = 'Vote111111111111111111111111111111111111111';
const token = 'So11111111111111111111111111111111111111112';
const otherToken = 'EPjFWdd5AufqSSqeM2qN1xzybapC8G4wEGGkZwyTDt1v';
const transaction = 'MixedCaseSolanaTransactionSignature123456789ABCDEFGHijkmnop';

const normalizeSolanaAddress = (value) => String(value || '').trim();
const isSolanaAddress = (value) => /^[1-9A-HJ-NP-Za-km-z]{32,44}$/.test(String(value || ''));
const preserveTransaction = (value) => String(value || '').trim();

function solanaStore() {
  return createRobinhoodStore(':memory:', {
    chainId: 'solana',
    chainLabel: 'Solana',
    addressNormalizer: normalizeSolanaAddress,
    addressValidator: isSolanaAddress,
    transactionNormalizer: preserveTransaction
  });
}

test('wallet qualification accepts injected Solana address rules without changing case', () => {
  const stats = reliablePriceStats([
    { wallet, priceNative: 1, tokenAmount: 10, quoteAmount: 1, blockNumber: 1 },
    { wallet: counterparty, priceNative: 2, tokenAmount: 10, quoteAmount: 1, blockNumber: 2 }
  ], {
    addressNormalizer: normalizeSolanaAddress,
    addressValidator: isSolanaAddress
  });
  assert.equal(stats.reliable, true);
  assert.equal(stats.distinctWallets, 2);

  const [summary] = buildWalletSummaries({
    tokens: [{
      address: token,
      symbol: 'WSOL',
      manual: true,
      peakMarketCapUsd: 1_000_000,
      holderAnalysis: {
        complete: true,
        minimumEntryUsd: 500,
        candidates: [{
          address: wallet,
          eligible: true,
          profitState: 'complete',
          buyVolumeUsd: 600,
          totalProfitUsd: 6_000,
          totalMultiple: 11,
          entryProgress: 0.05,
          early: true
        }]
      }
    }],
    minimumEntryUsd: 500,
    addressNormalizer: normalizeSolanaAddress,
    addressValidator: isSolanaAddress,
    transactionNormalizer: preserveTransaction
  });

  assert.equal(summary.address, wallet);
  assert.equal(summary.performances[0].tokenAddress, token);
  assert.notEqual(summary.address, wallet.toLowerCase());
});

test('store applies injected canonicalizers to every indexed chain identity', (t) => {
  const store = solanaStore();
  t.after(() => store.close());

  assert.equal(store.chainId, 'solana');
  assert.equal(store.chainLabel, 'Solana');
  assert.equal(store.getMeta('solana:compact_profit_rank_aliases_v1'), '1');
  assert.equal(store.getMeta('robinhood:compact_profit_rank_aliases_v1'), null);

  store.upsertToken({ address: ` ${token} `, symbol: 'WSOL', manual: true });
  store.upsertWalletAnnotation({ address: wallet, alias: 'Mixed case wallet' });
  store.upsertMonitorTokenMetadata({ address: token, symbol: 'WSOL', decimals: 9, complete: true });
  store.recordMonitorTokenAlert(token, 100);
  const inserted = store.insertMonitorEvent({
    eventType: 'buy',
    assetType: 'token',
    walletAddress: wallet,
    walletAlias: 'Mixed case wallet',
    counterpartyAddress: counterparty,
    tokenAddress: token,
    tokenSymbol: 'WSOL',
    tokenName: 'Wrapped SOL',
    tokenAmount: '1',
    rawTokenAmount: '1000000000',
    tokenDecimals: 9,
    txHash: transaction,
    logIndex: 1,
    blockNumber: 10,
    blockTimestamp: 100,
    detectedAt: 101
  });

  assert.equal(store.getToken(token).address, token);
  assert.equal(store.getToken(token.toLowerCase()), null);
  assert.equal(store.getWalletAnnotation(wallet).address, wallet);
  assert.equal(store.getWalletAnnotation(wallet.toLowerCase()), null);
  assert.equal(store.getMonitorTokenMetadata(token).address, token);
  assert.equal(store.listMonitorTokenAlerts()[0].tokenAddress, token);
  assert.equal(inserted.event.walletAddress, wallet);
  assert.equal(inserted.event.counterpartyAddress, counterparty);
  assert.equal(inserted.event.tokenAddress, token);
  assert.equal(inserted.event.txHash, transaction);
});

test('service injects chain identity and address rules into summaries, URLs, and validation', async (t) => {
  const store = solanaStore();
  t.after(() => store.close());
  let builderInput = null;
  const walletSummaryBuilder = (input) => {
    builderInput = input;
    return [{
      address: wallet,
      score: 90,
      smartScore: 90,
      smartEligible: true,
      classification: 'all_round',
      performances: [{
        tokenAddress: token,
        symbol: 'WSOL',
        totalProfitUsd: 1_000,
        totalMultiple: 10
      }]
    }];
  };
  const service = createRobinhoodService({
    store,
    chainId: 'solana',
    chainLabel: 'Solana',
    addressNormalizer: normalizeSolanaAddress,
    addressValidator: isSolanaAddress,
    transactionNormalizer: preserveTransaction,
    debotAddressRoot: 'https://debot.ai/address/solana/',
    walletSummaryBuilder,
    scanToken: async () => ({ actions: [], scan: { complete: true } }),
    now: () => Date.parse('2026-07-17T00:00:00.000Z')
  });
  t.after(() => service.close());

  store.upsertToken({ address: token, symbol: 'WSOL', manual: true });
  await service.start();

  assert.equal(builderInput.addressNormalizer(` ${wallet} `), wallet);
  assert.equal(builderInput.addressValidator(wallet), true);
  assert.equal(builderInput.transactionNormalizer(transaction), transaction);
  assert.equal(store.listWalletSummaries()[0].address, wallet);

  const updated = service.updateWallet(wallet, { alias: 'Sol alpha', status: 'active' });
  assert.equal(updated.wallet.address, wallet);
  assert.equal(updated.wallet.debotUrl, `https://debot.ai/address/solana/${wallet}`);
  assert.equal(service.getWallet(wallet).wallet.debotUrl, `https://debot.ai/address/solana/${wallet}`);

  const added = service.addManualWinner(otherToken);
  assert.equal(added.winner.chain, 'solana');
  assert.throws(() => service.updateWallet(`0x${'a'.repeat(40)}`, { status: 'active' }), /Invalid Solana wallet address/);
  const batch = service.batchUpdateWallets(['not-a-solana-address']);
  assert.equal(batch.results[0].reason, 'Invalid Solana wallet address');
  await service.waitForIdle();
});
