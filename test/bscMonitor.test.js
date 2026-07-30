import test from 'node:test';
import assert from 'node:assert/strict';

import {
  BSC_CHAIN,
  FOUR_MEME_BUY_TOPIC,
  FOUR_MEME_SELL_TOPIC,
  FOUR_MEME_TOKEN_CREATE_TOPIC
} from '../src/bsc/config.js';
import { BSC_MONITOR_PROFILE } from '../src/bsc/server.js';
import {
  ERC20_TRANSFER_TOPIC,
  RobinhoodWalletMonitor
} from '../src/robinhood/monitor.js';
import { createRobinhoodStore } from '../src/robinhood/store.js';

const buyer = '0xaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa';
const seller = '0xbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb';
const creator = '0xcccccccccccccccccccccccccccccccccccccccc';
const buyToken = '0x1111111111111111111111111111111111111111';
const sellToken = '0x2222222222222222222222222222222222222222';
const createdToken = '0x3333333333333333333333333333333333333333';

function quantity(value) {
  return `0x${BigInt(value).toString(16)}`;
}

function topic(address) {
  return `0x${address.slice(2).padStart(64, '0')}`;
}

function word(address) {
  return address.slice(2).padStart(64, '0');
}

function hash(byte) {
  return `0x${byte.repeat(32)}`;
}

function transferLog({ address, from, to, amount, txHash, logIndex }) {
  return {
    address,
    topics: [ERC20_TRANSFER_TOPIC, topic(from), topic(to)],
    data: `0x${BigInt(amount).toString(16).padStart(64, '0')}`,
    blockNumber: quantity(101),
    transactionHash: txHash,
    logIndex: quantity(logIndex),
    removed: false
  };
}

function addWallet(store, address, eventType) {
  const monitorRules = Object.fromEntries(
    ['buy', 'sell', 'transfer', 'token_create'].map((type) => [
      type,
      { enabled: type === eventType, sound: false, bark: false }
    ])
  );
  store.upsertWalletAnnotation({
    address,
    alias: address === buyer ? 'Buyer' : address === seller ? 'Seller' : 'Creator',
    status: 'active',
    monitorRules,
    createdAt: 1,
    updatedAt: 1
  });
}

function cacheToken(store, address, symbol) {
  store.upsertMonitorTokenMetadata({
    address,
    symbol,
    name: `${symbol} token`,
    decimals: 18,
    complete: true,
    updatedAt: 2_000_000_000
  });
}

test('detects Four.meme bonding-curve buys, sells, and factory launches on BSC', async () => {
  const store = createRobinhoodStore(':memory:', { chainId: 'bsc', chainLabel: 'BSC' });
  addWallet(store, buyer, 'buy');
  addWallet(store, seller, 'sell');
  addWallet(store, creator, 'token_create');
  cacheToken(store, buyToken, 'BUY');
  cacheToken(store, sellToken, 'SELL');
  cacheToken(store, createdToken, 'NEW');
  store.setMeta('robinhood:monitor:cursor', '100');
  store.setMeta('robinhood:monitor:deep-live-cursor', '100');

  const buyHash = hash('1a');
  const sellHash = hash('2b');
  const createHash = hash('3c');
  const incoming = transferLog({
    address: buyToken,
    from: BSC_CHAIN.fourMemeTokenManager,
    to: buyer,
    amount: 5n * 10n ** 18n,
    txHash: buyHash,
    logIndex: 1
  });
  const outgoing = transferLog({
    address: sellToken,
    from: seller,
    to: BSC_CHAIN.fourMemeTokenManager,
    amount: 3n * 10n ** 18n,
    txHash: sellHash,
    logIndex: 2
  });
  const launch = {
    address: BSC_CHAIN.fourMemeTokenManager,
    topics: [FOUR_MEME_TOKEN_CREATE_TOPIC],
    data: `0x${word(creator)}${word(createdToken)}`,
    blockNumber: quantity(101),
    transactionHash: createHash,
    logIndex: quantity(3),
    removed: false
  };

  const monitor = new RobinhoodWalletMonitor({
    store,
    chainProfile: BSC_MONITOR_PROFILE,
    noxaLaunchFactory: null,
    now: () => 2_000_000_010_000,
    rpcClient: {
      async getBlockNumber() {
        return 101;
      },
      async getLogs(filter) {
        if (filter.address === BSC_CHAIN.fourMemeTokenManager) {
          assert.deepEqual(filter.topics, [FOUR_MEME_TOKEN_CREATE_TOPIC]);
          return [launch];
        }
        if (filter.topics?.[2]) return [incoming];
        if (filter.topics?.[1]) return [outgoing];
        return [];
      },
      async getTransactionsByHashes(hashes) {
        return hashes.map((txHash) => txHash === buyHash
          ? { hash: txHash, from: buyer, to: BSC_CHAIN.fourMemeTokenManager }
          : { hash: txHash, from: seller, to: BSC_CHAIN.fourMemeTokenManager });
      },
      async getTransactionReceipts(hashes) {
        return hashes.map((txHash) => ({
          status: '0x1',
          logs: [{ topics: [txHash === buyHash ? FOUR_MEME_BUY_TOPIC : FOUR_MEME_SELL_TOPIC] }]
        }));
      },
      async getBlocksByNumbers(blockNumbers) {
        return blockNumbers.map((blockNumber) => ({
          number: quantity(blockNumber),
          timestamp: quantity(2_000_000_000),
          transactions: []
        }));
      }
    }
  });

  try {
    await monitor.pollOnce();
    const events = store.listMonitorEvents({ limit: 10 });
    assert.equal(events.length, 3);
    const byType = new Map(events.map((event) => [event.eventType, event]));
    assert.equal(byType.get('buy').walletAddress, buyer);
    assert.equal(byType.get('buy').tokenAddress, buyToken);
    assert.equal(byType.get('sell').walletAddress, seller);
    assert.equal(byType.get('sell').tokenAddress, sellToken);
    assert.equal(byType.get('token_create').walletAddress, creator);
    assert.equal(byType.get('token_create').tokenAddress, createdToken);
    assert.equal(byType.get('token_create').platform, 'four_meme');
    assert.equal(byType.get('token_create').counterpartyAddress, BSC_CHAIN.fourMemeTokenManager);
  } finally {
    monitor.close();
    store.close();
  }
});
