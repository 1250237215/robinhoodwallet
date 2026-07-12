import test from 'node:test';
import assert from 'node:assert/strict';

import {
  ERC20_TRANSFER_TOPIC,
  NOXA_LAUNCH_FACTORY,
  NOXA_TOKEN_LAUNCHED_TOPIC,
  RobinhoodWalletMonitor,
  V2_SWAP_TOPIC
} from '../src/robinhood/monitor.js';
import { createRobinhoodStore } from '../src/robinhood/store.js';

const wallet = '0xaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa';
const otherWallet = '0xbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb';
const recipient = '0xcccccccccccccccccccccccccccccccccccccccc';
const token = '0x1111111111111111111111111111111111111111';

function topic(address) {
  return `0x${'0'.repeat(24)}${address.slice(2)}`;
}

function quantity(value) {
  return `0x${BigInt(value).toString(16)}`;
}

function hash(byte) {
  return `0x${byte.repeat(32)}`;
}

function outboundLog({ transactionHash, index, amount = 1n }) {
  return {
    address: token,
    topics: [ERC20_TRANSFER_TOPIC, topic(wallet), topic(recipient)],
    data: `0x${amount.toString(16).padStart(64, '0')}`,
    blockNumber: quantity(101),
    transactionHash,
    logIndex: quantity(index),
    removed: false
  };
}

function outboundTokenLog({ tokenAddress, transactionHash, index, amount = 1n }) {
  return { ...outboundLog({ transactionHash, index, amount }), address: tokenAddress };
}

function cacheToken(store, address = token, symbol = 'TOK') {
  store.upsertMonitorTokenMetadata({
    address,
    symbol,
    name: `${symbol} token`,
    decimals: 18,
    complete: true,
    updatedAt: 2_000_000_000
  });
}

test('classifies outgoing swap logs as sells and non-swap logs as transfers without double reporting', async () => {
  const store = createRobinhoodStore(':memory:');
  store.upsertWalletAnnotation({
    address: wallet,
    alias: 'Alpha',
    status: 'active',
    monitorRules: {
      sell: { enabled: true, sound: true, bark: true },
      transfer: { enabled: true, sound: false, bark: false }
    },
    createdAt: 1,
    updatedAt: 1
  });
  cacheToken(store);
  store.setMeta('robinhood:monitor:cursor', '100');
  const sellHash = hash('2a');
  const transferHash = hash('2b');
  const notifications = [];
  const monitor = new RobinhoodWalletMonitor({
    store,
    barkNotifier: {
      listTargets: () => [{ id: 1, enabled: true }],
      notifyWalletEvent: async (payload) => {
        notifications.push(payload);
        return { attempted: 1, sent: 1, failed: 0 };
      }
    },
    now: () => 2_000_000_010_000,
    rpcClient: {
      async getBlockNumber() {
        return 101;
      },
      async getLogs(filter) {
        if (filter.topics?.[1]) {
          return [
            outboundLog({ transactionHash: sellHash, index: 4, amount: 2n }),
            outboundLog({ transactionHash: transferHash, index: 5, amount: 3n })
          ];
        }
        return [];
      },
      async getBlocksByNumbers(numbers, { includeTransactions }) {
        assert.deepEqual(numbers, [101]);
        assert.equal(includeTransactions, true);
        return [{ number: quantity(101), timestamp: quantity(2_000_000_000), transactions: [] }];
      },
      async getTransactionsByHashes(hashes) {
        assert.deepEqual(hashes, [sellHash, transferHash]);
        return hashes.map((transactionHash) => ({ hash: transactionHash, from: wallet, to: recipient }));
      },
      async getTransactionReceipts(hashes) {
        assert.deepEqual(hashes, [sellHash, transferHash]);
        return [
          { status: '0x1', logs: [{ topics: [V2_SWAP_TOPIC] }] },
          { status: '0x1', logs: [{ topics: [ERC20_TRANSFER_TOPIC] }] }
        ];
      }
    }
  });

  await monitor.pollOnce();
  await new Promise((resolve) => setImmediate(resolve));
  const events = store.listMonitorEvents().sort((left, right) => left.logIndex - right.logIndex);
  assert.deepEqual(events.map((event) => event.eventType), ['sell', 'transfer']);
  assert.equal(events[0].soundAlert, true);
  assert.equal(events[0].barkAlert, true);
  assert.equal(events[1].counterpartyAddress, recipient);
  assert.equal(events[1].soundAlert, false);
  assert.equal(notifications.length, 1);
  assert.equal(notifications[0].event.eventType, 'sell');
  assert.deepEqual(monitor.getClusters(), []);
  monitor.close();
  store.close();
});

test('detects native transfers and direct ERC-20 deployments from full blocks', async () => {
  const store = createRobinhoodStore(':memory:');
  store.upsertWalletAnnotation({
    address: wallet,
    status: 'active',
    monitorRules: {
      buy: { enabled: false },
      transfer: { enabled: true, sound: true },
      token_create: { enabled: true, bark: true }
    },
    createdAt: 1,
    updatedAt: 1
  });
  cacheToken(store);
  store.setMeta('robinhood:monitor:cursor', '100');
  const nativeHash = hash('3a');
  const createHash = hash('3b');
  const notifications = [];
  const monitor = new RobinhoodWalletMonitor({
    store,
    barkNotifier: {
      listTargets: () => [{ id: 1, enabled: true }],
      notifyWalletEvent: async (payload) => {
        notifications.push(payload);
        return { attempted: 1, sent: 1, failed: 0 };
      }
    },
    now: () => 2_000_000_010_000,
    rpcClient: {
      async getBlockNumber() {
        return 101;
      },
      async getLogs() {
        return [];
      },
      async getBlocksByNumbers(numbers, { includeTransactions }) {
        assert.deepEqual(numbers, [101]);
        assert.equal(includeTransactions, true);
        return [{
          number: quantity(101),
          timestamp: quantity(2_000_000_000),
          transactions: [
            { hash: nativeHash, from: wallet, to: recipient, value: quantity(10n ** 18n), input: '0x' },
            { hash: createHash, from: wallet, to: null, value: '0x0', input: '0x6000' }
          ]
        }];
      },
      async getTransactionReceipts(hashes) {
        assert.deepEqual(hashes, [nativeHash, createHash]);
        return [
          { status: '0x1', contractAddress: null, logs: [] },
          { status: '0x1', contractAddress: token, logs: [] }
        ];
      }
    }
  });

  await monitor.pollOnce();
  await new Promise((resolve) => setImmediate(resolve));
  const events = store.listMonitorEvents().sort((left, right) => left.logIndex - right.logIndex);
  assert.equal(events.length, 2);
  assert.deepEqual(events.map((event) => event.eventType), ['token_create', 'transfer']);
  const created = events.find((event) => event.eventType === 'token_create');
  const transferred = events.find((event) => event.eventType === 'transfer');
  assert.equal(created.platform, 'direct');
  assert.equal(created.tokenAddress, token);
  assert.equal(created.barkAlert, true);
  assert.equal(transferred.assetType, 'native');
  assert.equal(transferred.tokenSymbol, 'ETH');
  assert.equal(transferred.tokenAmount, '1');
  assert.equal(transferred.counterpartyAddress, recipient);
  assert.equal(transferred.soundAlert, true);
  assert.equal(notifications.length, 1);
  assert.equal(notifications[0].event.eventType, 'token_create');
  monitor.close();
  store.close();
});

test('keeps direct quote-token transfers while suppressing quote-token swap legs', async () => {
  const store = createRobinhoodStore(':memory:');
  const weth = '0x0bd7d308f8e1639fab988df18a8011f41eacad73';
  store.upsertWalletAnnotation({
    address: wallet,
    status: 'active',
    monitorRules: {
      buy: { enabled: false },
      sell: { enabled: true },
      transfer: { enabled: true }
    },
    createdAt: 1,
    updatedAt: 1
  });
  cacheToken(store, weth, 'WETH');
  store.setMeta('robinhood:monitor:cursor', '100');
  const directHash = hash('3c');
  const swapHash = hash('3d');
  const monitor = new RobinhoodWalletMonitor({
    store,
    rpcClient: {
      async getBlockNumber() {
        return 101;
      },
      async getLogs(filter) {
        return filter.topics?.[1] ? [
          outboundTokenLog({ tokenAddress: weth, transactionHash: directHash, index: 6 }),
          outboundTokenLog({ tokenAddress: weth, transactionHash: swapHash, index: 7 })
        ] : [];
      },
      async getBlocksByNumbers() {
        return [{ number: quantity(101), timestamp: quantity(2_000_000_000), transactions: [] }];
      },
      async getTransactionsByHashes(hashes) {
        return hashes.map((transactionHash) => ({ hash: transactionHash, from: wallet, to: recipient }));
      },
      async getTransactionReceipts() {
        return [
          { status: '0x1', logs: [{ topics: [ERC20_TRANSFER_TOPIC] }] },
          { status: '0x1', logs: [{ topics: [V2_SWAP_TOPIC] }] }
        ];
      }
    }
  });

  await monitor.pollOnce();
  const [event] = store.listMonitorEvents();
  assert.equal(store.listMonitorEvents().length, 1);
  assert.equal(event.eventType, 'transfer');
  assert.equal(event.tokenAddress, weth);
  assert.equal(event.txHash, directHash);
  monitor.close();
  store.close();
});

test('attributes Noxa TokenLaunched events to the indexed deployer wallet', async () => {
  const store = createRobinhoodStore(':memory:');
  store.upsertWalletAnnotation({
    address: wallet,
    alias: 'Launcher',
    status: 'active',
    monitorRules: {
      buy: { enabled: false },
      token_create: { enabled: true, sound: true, bark: true }
    },
    createdAt: 1,
    updatedAt: 1
  });
  cacheToken(store, token, 'NOXA');
  store.setMeta('robinhood:monitor:cursor', '100');
  const launchHash = hash('4a');
  const monitor = new RobinhoodWalletMonitor({
    store,
    now: () => 2_000_000_010_000,
    rpcClient: {
      async getBlockNumber() {
        return 101;
      },
      async getLogs(filter) {
        if (filter.address !== NOXA_LAUNCH_FACTORY) return [];
        assert.deepEqual(filter.topics, [NOXA_TOKEN_LAUNCHED_TOPIC]);
        return [{
          address: NOXA_LAUNCH_FACTORY,
          topics: [
            NOXA_TOKEN_LAUNCHED_TOPIC,
            topic(token),
            topic(wallet),
            topic('0x1f7d7550b1b028f7571e69a784071f0205fd2efa')
          ],
          data: '0x',
          blockNumber: quantity(101),
          transactionHash: launchHash,
          logIndex: quantity(9),
          removed: false
        }];
      },
      async getBlocksByNumbers() {
        return [{ number: quantity(101), timestamp: quantity(2_000_000_000), transactions: [] }];
      }
    }
  });

  await monitor.pollOnce();
  const [event] = store.listMonitorEvents();
  assert.equal(event.eventType, 'token_create');
  assert.equal(event.platform, 'noxa');
  assert.equal(event.walletAddress, wallet);
  assert.equal(event.tokenAddress, token);
  assert.equal(event.counterpartyAddress, NOXA_LAUNCH_FACTORY);
  assert.equal(event.soundAlert, true);
  assert.equal(event.barkAlert, true);
  monitor.close();
  store.close();
});

test('buy clusters ignore sell and transfer events for the same token', () => {
  const store = createRobinhoodStore(':memory:');
  const nowSeconds = 2_100_000_000;
  for (const [eventType, walletAddress, byte, logIndex] of [
    ['buy', wallet, '5a', 1],
    ['sell', otherWallet, '5b', 2],
    ['transfer', otherWallet, '5c', 3]
  ]) {
    store.insertMonitorEvent({
      eventType,
      assetType: 'erc20',
      walletAddress,
      tokenAddress: token,
      tokenSymbol: 'TOK',
      tokenName: 'Token',
      tokenAmount: '1',
      rawTokenAmount: '1',
      tokenDecimals: 18,
      txHash: hash(byte),
      logIndex,
      blockNumber: 1,
      blockTimestamp: nowSeconds - 5,
      detectedAt: nowSeconds - 4
    });
  }
  const monitor = new RobinhoodWalletMonitor({
    store,
    rpcClient: { getBlockNumber() {}, getLogs() {} },
    now: () => nowSeconds * 1000
  });

  monitor.updateSettings({ threshold: 2 });
  const [cluster] = monitor.getClusters();
  assert.equal(cluster.eventCount, 1);
  assert.equal(cluster.distinctWallets, 1);
  assert.equal(cluster.triggered, false);
  monitor.close();
  store.close();
});
