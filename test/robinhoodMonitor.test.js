import test from 'node:test';
import assert from 'node:assert/strict';

import {
  ERC20_TRANSFER_TOPIC,
  RobinhoodWalletMonitor,
  V2_SWAP_TOPIC,
  formatTokenAmount
} from '../src/robinhood/monitor.js';
import { createRobinhoodStore } from '../src/robinhood/store.js';

const walletA = '0xaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa';
const walletB = '0xbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb';
const token = '0x1111111111111111111111111111111111111111';
const txHash = `0x${'12'.repeat(32)}`;

function topic(address) {
  return `0x${'0'.repeat(24)}${address.slice(2)}`;
}

function quantity(value) {
  return `0x${Number(value).toString(16)}`;
}

function indexedWallet(index) {
  return `0x${Number(index).toString(16).padStart(40, '0')}`;
}

function addMonitoredWallets(store, count) {
  for (let index = 1; index <= count; index += 1) {
    store.upsertWalletAnnotation({
      address: indexedWallet(index),
      status: 'active',
      createdAt: 1,
      updatedAt: 1
    });
  }
}

function abiString(value) {
  const data = Buffer.from(value, 'utf8').toString('hex');
  const padded = data.padEnd(Math.ceil(data.length / 64) * 64, '0');
  return `0x${'20'.padStart(64, '0')}${(data.length / 2).toString(16).padStart(64, '0')}${padded}`;
}

function transferLog({ wallet = walletA, amount = 1n, block = 101, index = 7 } = {}) {
  return {
    address: token,
    topics: [ERC20_TRANSFER_TOPIC, topic('0x9999999999999999999999999999999999999999'), topic(wallet)],
    data: `0x${amount.toString(16).padStart(64, '0')}`,
    blockNumber: quantity(block),
    transactionHash: txHash,
    logIndex: quantity(index),
    removed: false
  };
}

test('formats even the smallest token amount without a minimum-value filter', () => {
  assert.equal(formatTokenAmount(1n, 18), '0.000000000000000001');
  assert.equal(formatTokenAmount(1_234_500n, 6), '1.2345');
  assert.equal(formatTokenAmount(42n, 0), '42');
});

test('scans 100-wallet topic chunks with at most two concurrent log requests', async () => {
  const store = createRobinhoodStore(':memory:');
  addMonitoredWallets(store, 201);
  store.setMeta('robinhood:monitor:cursor', '10');
  const chunkSizes = [];
  let activeRequests = 0;
  let maxActiveRequests = 0;
  const monitor = new RobinhoodWalletMonitor({
    store,
    rpcClient: {
      async getBlockNumber() {
        return 11;
      },
      async getLogs(filter) {
        const recipients = filter.topics[2];
        chunkSizes.push(Array.isArray(recipients) ? recipients.length : 1);
        activeRequests += 1;
        maxActiveRequests = Math.max(maxActiveRequests, activeRequests);
        await new Promise((resolve) => setImmediate(resolve));
        activeRequests -= 1;
        return [];
      }
    }
  });

  await monitor.pollOnce();
  assert.deepEqual(chunkSizes, [100, 100, 1]);
  assert.equal(maxActiveRequests, 2);
  assert.equal(store.getMeta('robinhood:monitor:cursor'), '11');
  assert.deepEqual(
    {
      pollIntervalMs: monitor.getSnapshot().health.pollIntervalMs,
      fastPollIntervalMs: monitor.getSnapshot().health.fastPollIntervalMs,
      degradedPollIntervalMs: monitor.getSnapshot().health.degradedPollIntervalMs,
      walletTopicChunkSize: monitor.getSnapshot().health.walletTopicChunkSize,
      logConcurrency: monitor.getSnapshot().health.logConcurrency,
      maxLogConcurrency: monitor.getSnapshot().health.maxLogConcurrency
    },
    {
      pollIntervalMs: 500,
      fastPollIntervalMs: 500,
      degradedPollIntervalMs: 1_000,
      walletTopicChunkSize: 100,
      logConcurrency: 2,
      maxLogConcurrency: 2
    }
  );
  monitor.close();
  store.close();
});

test('rate pressure activates single-request protection and healthy polls restore fast mode', async () => {
  const store = createRobinhoodStore(':memory:');
  addMonitoredWallets(store, 201);
  store.setMeta('robinhood:monitor:cursor', '20');
  let head = 21;
  let failWithRateLimit = true;
  let activeRequests = 0;
  let maxActiveRequests = 0;
  const monitor = new RobinhoodWalletMonitor({
    store,
    recoverySuccesses: 2,
    rpcClient: {
      async getBlockNumber() {
        return head;
      },
      async getLogs() {
        if (failWithRateLimit) {
          const error = new Error('RPC failed with HTTP 429: rate limit exceeded');
          error.status = 429;
          throw error;
        }
        activeRequests += 1;
        maxActiveRequests = Math.max(maxActiveRequests, activeRequests);
        await new Promise((resolve) => setImmediate(resolve));
        activeRequests -= 1;
        return [];
      }
    }
  });

  await assert.rejects(monitor.pollOnce(), /429/);
  let snapshot = monitor.getSnapshot();
  assert.equal(snapshot.status, 'degraded');
  assert.equal(snapshot.health.pollIntervalMs, 1_000);
  assert.equal(snapshot.health.logConcurrency, 1);
  assert.equal(snapshot.health.rpcProtection.active, true);
  assert.equal(snapshot.health.rpcProtection.healthyPolls, 0);
  assert.equal(store.getMeta('robinhood:monitor:cursor'), '20');

  failWithRateLimit = false;
  head = 22;
  maxActiveRequests = 0;
  await monitor.pollOnce();
  snapshot = monitor.getSnapshot();
  assert.equal(maxActiveRequests, 1);
  assert.equal(snapshot.ok, true);
  assert.equal(snapshot.status, 'degraded');
  assert.equal(snapshot.health.rpcProtection.healthyPolls, 1);

  head = 23;
  maxActiveRequests = 0;
  await monitor.pollOnce();
  snapshot = monitor.getSnapshot();
  assert.equal(maxActiveRequests, 1, 'the recovery poll itself remains protected');
  assert.equal(snapshot.status, 'live');
  assert.equal(snapshot.health.pollIntervalMs, 500);
  assert.equal(snapshot.health.logConcurrency, 2);
  assert.equal(snapshot.health.rpcProtection.active, false);
  assert.ok(snapshot.health.rpcProtection.lastRecoveredAt);

  head = 24;
  maxActiveRequests = 0;
  await monitor.pollOnce();
  assert.equal(maxActiveRequests, 2);
  monitor.close();
  store.close();
});

test('two consecutive ordinary RPC failures also activate protection', async () => {
  const store = createRobinhoodStore(':memory:');
  store.upsertWalletAnnotation({ address: walletA, status: 'active', createdAt: 1, updatedAt: 1 });
  store.setMeta('robinhood:monitor:cursor', '30');
  const monitor = new RobinhoodWalletMonitor({
    store,
    rpcClient: {
      async getBlockNumber() {
        return 31;
      },
      async getLogs() {
        throw new Error('temporary upstream failure');
      }
    }
  });

  await assert.rejects(monitor.pollOnce(), /temporary upstream failure/);
  assert.equal(monitor.getSnapshot().health.rpcProtection.active, false);
  await assert.rejects(monitor.pollOnce(), /temporary upstream failure/);
  assert.equal(monitor.getSnapshot().health.rpcProtection.active, true);
  assert.equal(monitor.getSnapshot().health.logConcurrency, 1);
  assert.equal(monitor.getSnapshot().health.pollIntervalMs, 1_000);
  monitor.close();
  store.close();
});

test('monitors only confirmed non-excluded wallets, verifies swaps, and persists exact events', async () => {
  const store = createRobinhoodStore(':memory:');
  store.upsertWalletAnnotation({ address: walletA, alias: 'VEX profit #2', status: 'active', createdAt: 1, updatedAt: 1 });
  store.upsertWalletAnnotation({ address: walletB, alias: 'excluded', status: 'excluded', createdAt: 1, updatedAt: 1 });

  let head = 100;
  let logCalls = 0;
  const rpcClient = {
    async getBlockNumber() {
      return head;
    },
    async getLogs(filter) {
      logCalls += 1;
      assert.equal(filter.fromBlock, 101);
      assert.equal(filter.toBlock, 101);
      assert.equal(filter.topics[2], topic(walletA));
      return [transferLog(), transferLog({ wallet: walletB, index: 8 })];
    },
    async getTransactionsByHashes(hashes) {
      assert.deepEqual(hashes, [txHash]);
      return [{ hash: txHash, from: walletA }];
    },
    async getTransactionReceipts(hashes) {
      assert.deepEqual(hashes, [txHash]);
      return [{ transactionHash: txHash, status: '0x1', logs: [{ topics: [V2_SWAP_TOPIC] }] }];
    },
    async getBlockByNumber(blockNumber) {
      assert.equal(blockNumber, 101);
      return { number: quantity(blockNumber), timestamp: quantity(2_000_000_000) };
    },
    async ethCall({ data }) {
      if (data === '0x95d89b41') return abiString('TINY');
      if (data === '0x06fdde03') return abiString('Tiny token');
      if (data === '0x313ce567') return `0x${'12'.padStart(64, '0')}`;
      throw new Error('unexpected selector');
    }
  };
  const monitor = new RobinhoodWalletMonitor({
    store,
    rpcClient,
    now: () => 2_000_000_010_000
  });

  await monitor.pollOnce();
  assert.equal(store.getMeta('robinhood:monitor:cursor'), '100');
  assert.equal(logCalls, 0, 'first startup begins at the current head instead of replaying history');

  head = 101;
  await monitor.pollOnce();
  assert.equal(logCalls, 1);
  assert.equal(store.getMeta('robinhood:monitor:cursor'), '101');
  const snapshot = monitor.getSnapshot();
  assert.equal(snapshot.events.length, 1);
  assert.equal(snapshot.events[0].walletAddress, walletA);
  assert.equal(snapshot.events[0].walletAlias, 'VEX profit #2');
  assert.equal(snapshot.events[0].tokenSymbol, 'TINY');
  assert.equal(snapshot.events[0].tokenAmount, '0.000000000000000001');
  assert.equal(snapshot.events[0].blockTimestamp, '2033-05-18T03:33:20.000Z');
  assert.equal(snapshot.events[0].debotAddressUrl, `https://debot.ai/address/robinhood/${walletA}`);
  assert.equal(snapshot.events[0].debotTokenUrl, `https://debot.ai/token/robinhood/308574_${token}`);
  assert.equal(snapshot.events[0].explorerTxUrl, `https://robinhoodchain.blockscout.com/tx/${txHash}`);
  assert.equal(snapshot.clusters[0].distinctWallets, 1);
  assert.equal(snapshot.clusters[0].triggered, false);

  const duplicate = store.insertMonitorEvent({
    walletAddress: walletA,
    tokenAddress: token,
    tokenSymbol: 'TINY',
    tokenName: 'Tiny token',
    tokenAmount: '1',
    rawTokenAmount: '1',
    tokenDecimals: 18,
    txHash,
    logIndex: 7,
    blockNumber: 101,
    blockTimestamp: 2_000_000_000,
    detectedAt: 2_000_000_010
  });
  assert.equal(duplicate.inserted, false);
  assert.equal(store.listMonitorEvents().length, 1);

  monitor.updateSettings({ threshold: 1 });
  assert.equal(monitor.getSnapshot().clusters[0].triggered, true);
  monitor.close();
  store.close();
});

test('notifies Bark only once for a token CA across window expiry and monitor restart', async () => {
  const store = createRobinhoodStore(':memory:');
  store.upsertWalletAnnotation({ address: walletA, alias: 'Alpha', status: 'active', createdAt: 1, updatedAt: 1 });
  store.setMeta('robinhood:monitor:cursor', '100');
  const notifications = [];
  let head = 101;
  let nowSeconds = 2_000_000_010;
  const rpcClient = {
    async getBlockNumber() {
      return head;
    },
    async getLogs() {
      const hashByte = head === 101 ? '12' : head === 102 ? '13' : '14';
      return [{
        ...transferLog({ block: head, index: head }),
        transactionHash: `0x${hashByte.repeat(32)}`
      }];
    },
    async getTransactionsByHashes(hashes) {
      return hashes.map((hash) => ({ hash, from: walletA }));
    },
    async getTransactionReceipts(hashes) {
      return hashes.map((hash) => ({ transactionHash: hash, status: '0x1', logs: [{ topics: [V2_SWAP_TOPIC] }] }));
    },
    async getBlockByNumber() {
      return { timestamp: quantity(nowSeconds) };
    },
    async ethCall({ data }) {
      if (data === '0x95d89b41') return abiString('ALERT');
      if (data === '0x06fdde03') return abiString('Alert token');
      return `0x${'12'.padStart(64, '0')}`;
    }
  };
  const monitor = new RobinhoodWalletMonitor({
    store,
    barkNotifier: {
      listTargets: () => [{ id: 1, enabled: true }],
      notifyAlert: async (payload) => {
        notifications.push(payload);
        return { attempted: 1, sent: 1, failed: 0 };
      }
    },
    now: () => nowSeconds * 1000,
    rpcClient
  });
  monitor.updateSettings({ threshold: 1, windowSeconds: 120, sound: 'bell', volume: 35, barkSound: 'chime', barkVolume: 8 });
  await monitor.pollOnce();
  await new Promise((resolve) => setImmediate(resolve));
  assert.equal(notifications.length, 1);
  assert.equal(notifications[0].cluster.tokenAddress, token);
  assert.equal(notifications[0].threshold, 1);
  assert.equal(notifications[0].windowSeconds, 120);
  assert.equal(notifications[0].sound, 'chime');
  assert.equal(notifications[0].volume, 8);

  nowSeconds += 121;
  head = 102;
  await monitor.pollOnce();
  await new Promise((resolve) => setImmediate(resolve));
  assert.equal(notifications.length, 1, 'the same CA stays suppressed after the original cluster expires');
  assert.deepEqual(monitor.getSnapshot().alertedTokenAddresses, [token]);
  assert.deepEqual(monitor.getSnapshot().settings, {
    enabled: true,
    threshold: 1,
    windowSeconds: 120,
    sound: 'bell',
    volume: 35,
    barkSound: 'chime',
    barkVolume: 8
  });
  monitor.close();

  nowSeconds += 121;
  head = 103;
  const restarted = new RobinhoodWalletMonitor({
    store,
    barkNotifier: {
      listTargets: () => [{ id: 1, enabled: true }],
      notifyAlert: async (payload) => {
        notifications.push(payload);
        return { attempted: 1, sent: 1, failed: 0 };
      }
    },
    now: () => nowSeconds * 1000,
    rpcClient
  });
  assert.deepEqual(restarted.getSnapshot().alertedTokenAddresses, [token]);
  await restarted.pollOnce();
  await new Promise((resolve) => setImmediate(resolve));
  assert.equal(notifications.length, 1, 'the persisted CA stays suppressed after monitor restart');
  restarted.close();
  store.close();
});

test('advances its persisted cursor without confirmed wallets and resumes from it after restart', async () => {
  const store = createRobinhoodStore(':memory:');
  let head = 50;
  const requestedRanges = [];
  const rpcClient = {
    async getBlockNumber() {
      return head;
    },
    async getLogs(filter) {
      requestedRanges.push([filter.fromBlock, filter.toBlock]);
      return [];
    },
    async getTransactionsByHashes() {
      return [];
    },
    async getTransactionReceipts() {
      return [];
    }
  };

  const first = new RobinhoodWalletMonitor({ store, rpcClient });
  await first.pollOnce();
  head = 55;
  await first.pollOnce();
  assert.equal(store.getMeta('robinhood:monitor:cursor'), '55');
  assert.deepEqual(requestedRanges, []);
  first.close();

  store.upsertWalletAnnotation({ address: walletA, status: 'watch', createdAt: 1, updatedAt: 1 });
  head = 57;
  const second = new RobinhoodWalletMonitor({ store, rpcClient });
  await second.pollOnce();
  assert.deepEqual(requestedRanges, [[56, 57]]);
  assert.equal(store.getMeta('robinhood:monitor:cursor'), '57');
  second.updateSettings({ enabled: false, threshold: 9, windowSeconds: 300 });
  second.close();

  const third = new RobinhoodWalletMonitor({ store, rpcClient });
  assert.deepEqual(third.getSnapshot().settings, {
    enabled: false,
    threshold: 9,
    windowSeconds: 300,
    sound: 'alarm',
    volume: 70,
    barkSound: 'alarm',
    barkVolume: 5
  });
  third.close();
  store.close();
});

test('does not advance the cursor when an RPC range fails', async () => {
  const store = createRobinhoodStore(':memory:');
  store.upsertWalletAnnotation({ address: walletA, status: 'active', createdAt: 1, updatedAt: 1 });
  store.setMeta('robinhood:monitor:cursor', '10');
  const monitor = new RobinhoodWalletMonitor({
    store,
    rpcClient: {
      async getBlockNumber() {
        return 11;
      },
      async getLogs() {
        throw new Error('temporary rate limit');
      }
    }
  });

  await assert.rejects(monitor.pollOnce(), /temporary rate limit/);
  assert.equal(store.getMeta('robinhood:monitor:cursor'), '10');
  assert.equal(monitor.getSnapshot().status, 'degraded');
  monitor.close();
  store.close();
});

test('rejects quote-token proceeds, unrelated senders, and transfers without a swap', async () => {
  const store = createRobinhoodStore(':memory:');
  store.upsertWalletAnnotation({ address: walletA, status: 'active', createdAt: 1, updatedAt: 1 });
  store.setMeta('robinhood:monitor:cursor', '200');
  const quoteToken = '0x0bd7d308f8e1639fab988df18a8011f41eacad73';
  const wrongSenderHash = `0x${'21'.repeat(32)}`;
  const noSwapHash = `0x${'22'.repeat(32)}`;
  const makeLog = (address, hash, index) => ({
    address,
    topics: [ERC20_TRANSFER_TOPIC, topic('0x9999999999999999999999999999999999999999'), topic(walletA)],
    data: `0x${'1'.padStart(64, '0')}`,
    blockNumber: quantity(201),
    transactionHash: hash,
    logIndex: quantity(index),
    removed: false
  });
  const monitor = new RobinhoodWalletMonitor({
    store,
    rpcClient: {
      async getBlockNumber() {
        return 201;
      },
      async getLogs() {
        return [
          makeLog(quoteToken, `0x${'20'.repeat(32)}`, 1),
          makeLog(token, wrongSenderHash, 2),
          makeLog(token, noSwapHash, 3)
        ];
      },
      async getTransactionsByHashes(hashes) {
        assert.deepEqual(hashes, [wrongSenderHash, noSwapHash]);
        return [{ from: walletB }, { from: walletA }];
      },
      async getTransactionReceipts(hashes) {
        assert.deepEqual(hashes, [wrongSenderHash, noSwapHash]);
        return [
          { status: '0x1', logs: [{ topics: [V2_SWAP_TOPIC] }] },
          { status: '0x1', logs: [{ topics: [ERC20_TRANSFER_TOPIC] }] }
        ];
      }
    }
  });

  await monitor.pollOnce();
  assert.equal(store.listMonitorEvents().length, 0);
  assert.equal(store.getMeta('robinhood:monitor:cursor'), '201');
  monitor.close();
  store.close();
});

test('custom-window clusters count distinct wallets rather than repeated buys', () => {
  const store = createRobinhoodStore(':memory:');
  const nowSeconds = 2_100_000_000;
  const insert = (walletAddress, hashByte, logIndex) => store.insertMonitorEvent({
    walletAddress,
    walletAlias: walletAddress === walletA ? 'Alpha' : 'Beta',
    tokenAddress: token,
    tokenSymbol: 'ONE',
    tokenName: 'One',
    tokenAmount: '1',
    rawTokenAmount: '1',
    tokenDecimals: 18,
    txHash: `0x${hashByte.repeat(64)}`,
    logIndex,
    blockNumber: 1,
    blockTimestamp: nowSeconds - 10,
    detectedAt: nowSeconds - 9
  });
  insert(walletA, '1', 1);
  insert(walletA, '2', 2);
  insert(walletB, '3', 3);
  const monitor = new RobinhoodWalletMonitor({
    store,
    rpcClient: { getBlockNumber() {}, getLogs() {} },
    now: () => nowSeconds * 1000
  });

  monitor.updateSettings({ threshold: 2, windowSeconds: 60 });
  const [cluster] = monitor.getClusters();
  assert.equal(cluster.eventCount, 3);
  assert.equal(cluster.distinctWallets, 2);
  assert.equal(cluster.wallets.length, 2);
  assert.equal(cluster.triggered, true);
  monitor.close();
  store.close();
});

test('uses the configured time window when selecting cluster events', () => {
  const store = createRobinhoodStore(':memory:');
  const nowSeconds = 2_100_000_000;
  const insert = ({ walletAddress, secondsAgo, hashByte, logIndex }) => store.insertMonitorEvent({
    walletAddress,
    walletAlias: walletAddress === walletA ? 'Alpha' : 'Beta',
    tokenAddress: token,
    tokenSymbol: 'WINDOW',
    tokenName: 'Window',
    tokenAmount: '1',
    rawTokenAmount: '1',
    tokenDecimals: 18,
    txHash: `0x${hashByte.repeat(64)}`,
    logIndex,
    blockNumber: logIndex,
    blockTimestamp: nowSeconds - secondsAgo,
    detectedAt: nowSeconds - secondsAgo
  });
  insert({ walletAddress: walletA, secondsAgo: 10, hashByte: '4', logIndex: 4 });
  insert({ walletAddress: walletB, secondsAgo: 90, hashByte: '5', logIndex: 5 });
  const monitor = new RobinhoodWalletMonitor({
    store,
    rpcClient: { getBlockNumber() {}, getLogs() {} },
    now: () => nowSeconds * 1000
  });

  assert.equal(monitor.getSnapshot().settings.windowSeconds, 60);
  monitor.updateSettings({ windowSeconds: 30 });
  assert.equal(monitor.getClusters()[0].eventCount, 1);
  assert.equal(monitor.getClusters()[0].distinctWallets, 1);

  monitor.updateSettings({ windowSeconds: 120 });
  assert.equal(monitor.getClusters()[0].eventCount, 2);
  assert.equal(monitor.getClusters()[0].distinctWallets, 2);
  assert.equal(monitor.getClusters()[0].windowSeconds, 120);
  assert.equal(store.getMeta('robinhood:monitor:window-seconds'), '120');

  assert.throws(() => monitor.updateSettings({ windowSeconds: 4 }), /5 to 3600/);
  assert.throws(() => monitor.updateSettings({ windowSeconds: 3_601 }), /5 to 3600/);
  assert.throws(() => monitor.updateSettings({ windowSeconds: 5.5 }), /5 to 3600/);
  assert.equal(monitor.getSnapshot().settings.windowSeconds, 120);
  monitor.close();
  store.close();
});

test('keeps a token CA suppressed when the aggregation window changes', async () => {
  const store = createRobinhoodStore(':memory:');
  const nowSeconds = 2_100_000_000;
  store.upsertWalletAnnotation({ address: walletA, alias: 'Alpha', status: 'active', createdAt: 1, updatedAt: 1 });
  store.upsertWalletAnnotation({ address: walletB, alias: 'Beta', status: 'active', createdAt: 1, updatedAt: 1 });
  store.upsertMonitorTokenMetadata({
    address: token,
    symbol: 'WINDOW',
    name: 'Window',
    decimals: 18,
    complete: true,
    updatedAt: nowSeconds
  });
  const insert = ({ walletAddress, secondsAgo, hashByte, logIndex }) => store.insertMonitorEvent({
    walletAddress,
    walletAlias: walletAddress === walletA ? 'Alpha' : 'Beta',
    tokenAddress: token,
    tokenSymbol: 'WINDOW',
    tokenName: 'Window',
    tokenAmount: '1',
    rawTokenAmount: '1',
    tokenDecimals: 18,
    txHash: `0x${hashByte.repeat(64)}`,
    logIndex,
    blockNumber: logIndex,
    blockTimestamp: nowSeconds - secondsAgo,
    detectedAt: nowSeconds - secondsAgo
  });
  insert({ walletAddress: walletA, secondsAgo: 90, hashByte: '6', logIndex: 6 });
  insert({ walletAddress: walletB, secondsAgo: 10, hashByte: '7', logIndex: 7 });
  store.setMeta('robinhood:monitor:cursor', '100');

  const notifications = [];
  let head = 101;
  const monitor = new RobinhoodWalletMonitor({
    store,
    now: () => nowSeconds * 1000,
    barkNotifier: {
      listTargets: () => [{ id: 1, enabled: true }],
      notifyAlert: async (payload) => {
        notifications.push(payload);
        return { attempted: 1, sent: 1, failed: 0 };
      }
    },
    rpcClient: {
      async getBlockNumber() {
        return head;
      },
      async getLogs() {
        const wallet = head === 101 ? walletB : walletA;
        const transactionHash = `0x${(head === 101 ? '8' : '9').repeat(64)}`;
        return [{
          ...transferLog({ wallet, block: head, index: head }),
          transactionHash
        }];
      },
      async getTransactionsByHashes(hashes) {
        const from = head === 101 ? walletB : walletA;
        return hashes.map((hash) => ({ hash, from }));
      },
      async getTransactionReceipts(hashes) {
        return hashes.map((hash) => ({
          transactionHash: hash,
          status: '0x1',
          logs: [{ topics: [V2_SWAP_TOPIC] }]
        }));
      },
      async getBlockByNumber(blockNumber) {
        return { number: quantity(blockNumber), timestamp: quantity(nowSeconds) };
      }
    }
  });

  monitor.updateSettings({ threshold: 2, windowSeconds: 60 });
  assert.equal(monitor.getClusters()[0].triggered, false);

  monitor.updateSettings({ windowSeconds: 120 });
  assert.equal(monitor.getClusters()[0].triggered, true);
  await monitor.pollOnce();
  await new Promise((resolve) => setImmediate(resolve));
  assert.equal(notifications.length, 0, 'extending the window arms the existing cluster without reporting it as new');

  monitor.updateSettings({ windowSeconds: 30 });
  assert.equal(monitor.getClusters()[0].triggered, false);
  head = 102;
  await monitor.pollOnce();
  await new Promise((resolve) => setImmediate(resolve));
  assert.equal(notifications.length, 0, 'a CA armed by the wider window is never reported again');
  assert.deepEqual(monitor.getSnapshot().alertedTokenAddresses, [token]);

  monitor.close();
  store.close();
});
