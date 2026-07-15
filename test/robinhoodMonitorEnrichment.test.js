import test from 'node:test';
import assert from 'node:assert/strict';

import {
  ERC20_TRANSFER_TOPIC,
  RobinhoodWalletMonitor,
  V2_SWAP_TOPIC
} from '../src/robinhood/monitor.js';
import { createRobinhoodStore } from '../src/robinhood/store.js';

const wallet = '0xaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa';
const token = '0x1111111111111111111111111111111111111111';
const sender = '0xbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb';
const router = '0xcccccccccccccccccccccccccccccccccccccccc';

function topic(address) {
  return `0x${'0'.repeat(24)}${address.slice(2)}`;
}

function quantity(value) {
  return `0x${BigInt(value).toString(16)}`;
}

function hash(byte) {
  return `0x${byte.repeat(32)}`;
}

function abiString(value) {
  const data = Buffer.from(value, 'utf8').toString('hex');
  const padded = data.padEnd(Math.ceil(data.length / 64) * 64, '0');
  return `0x${'20'.padStart(64, '0')}${(data.length / 2).toString(16).padStart(64, '0')}${padded}`;
}

function incomingLog({ transactionHash, index, blockNumber }) {
  return {
    address: token,
    topics: [ERC20_TRANSFER_TOPIC, topic(sender), topic(wallet)],
    data: `0x${(10n ** 18n).toString(16).padStart(64, '0')}`,
    blockNumber: quantity(blockNumber),
    transactionHash,
    logIndex: quantity(index),
    removed: false
  };
}

function deferred() {
  let resolve;
  let reject;
  const promise = new Promise((nextResolve, nextReject) => {
    resolve = nextResolve;
    reject = nextReject;
  });
  return { promise, resolve, reject };
}

async function eventually(assertion, timeoutMs = 500) {
  const deadline = Date.now() + timeoutMs;
  while (true) {
    try {
      return assertion();
    } catch (error) {
      if (Date.now() >= deadline) throw error;
      await new Promise((resolve) => setTimeout(resolve, 5));
    }
  }
}

function insertEvent(store, {
  transactionHash = hash('90'),
  logIndex = 1,
  marketCapUsd = null,
  tokenCreationTimestamp = null,
  marketDataAt = null,
  detectedAt = 2_000_000_001
} = {}) {
  return store.insertMonitorEvent({
    eventType: 'buy',
    assetType: 'erc20',
    walletAddress: wallet,
    walletAlias: 'Alpha',
    tokenAddress: token,
    tokenSymbol: 'TOK',
    tokenName: 'Token',
    tokenAmount: '1',
    rawTokenAmount: '1000000000000000000',
    tokenDecimals: 18,
    txHash: transactionHash,
    logIndex,
    blockNumber: 100,
    blockTimestamp: 2_000_000_000,
    detectedAt,
    marketCapUsd,
    tokenCreationTimestamp,
    marketDataAt
  });
}

test('startup does not backfill stale historical events with a current market-cap snapshot', () => {
  const store = createRobinhoodStore(':memory:');
  insertEvent(store, { detectedAt: 100 });
  let metricCalls = 0;
  const monitor = new RobinhoodWalletMonitor({
    store,
    now: () => 1_000_000,
    debotClient: {
      async fetchTokenMetrics() {
        metricCalls += 1;
        return { marketCapUsd: 10_000, creationTimestamp: 50 };
      }
    },
    rpcClient: {
      async getBlockNumber() {
        return 100;
      },
      async getLogs() {
        return [];
      }
    }
  });

  monitor.start();
  assert.equal(metricCalls, 0);
  assert.equal(store.listMonitorEvents()[0].marketCapUsd, null);
  monitor.close();
  store.close();
});

test('persists latest token metrics while keeping each resolved event market-cap snapshot immutable', () => {
  const store = createRobinhoodStore(':memory:');
  store.upsertMonitorTokenMetadata({
    address: token,
    symbol: 'TOK',
    name: 'Token',
    decimals: 18,
    complete: true,
    updatedAt: 100
  });
  const unresolved = insertEvent(store).event;
  const partial = insertEvent(store, {
    transactionHash: hash('91'),
    logIndex: 2,
    marketCapUsd: 50_000,
    marketDataAt: 101
  }).event;

  const cached = store.upsertMonitorTokenMarketData({
    address: token,
    marketCapUsd: 75_000,
    tokenCreationTimestamp: 90,
    marketDataAt: 110
  });
  assert.deepEqual(
    {
      marketCapUsd: cached.marketCapUsd,
      tokenCreationTimestamp: cached.tokenCreationTimestamp,
      marketDataAt: cached.marketDataAt
    },
    { marketCapUsd: 75_000, tokenCreationTimestamp: 90, marketDataAt: 110 }
  );

  const updated = store.updateMonitorEventsTokenMarketData(token, cached);
  assert.deepEqual(updated.map((event) => event.id), [unresolved.id, partial.id]);
  assert.deepEqual(
    updated.map((event) => ({
      marketCapUsd: event.marketCapUsd,
      tokenCreationTimestamp: event.tokenCreationTimestamp,
      marketDataAt: event.marketDataAt
    })),
    [
      { marketCapUsd: 75_000, tokenCreationTimestamp: 90, marketDataAt: 110 },
      { marketCapUsd: 50_000, tokenCreationTimestamp: 90, marketDataAt: 101 }
    ]
  );
  const newer = store.upsertMonitorTokenMarketData({
    address: token,
    marketCapUsd: 125_000,
    tokenCreationTimestamp: null,
    marketDataAt: 120
  });
  assert.equal(newer.marketCapUsd, 125_000);
  assert.equal(newer.tokenCreationTimestamp, 90);
  assert.deepEqual(store.updateMonitorEventsTokenMarketData(token, newer), []);
  assert.deepEqual(
    store.listMonitorEvents().map((event) => event.marketCapUsd),
    [50_000, 75_000]
  );
  store.close();
});

test('emits buys and Bark without awaiting DeBot, dedupes lookups, and reuses the short cache', async () => {
  const store = createRobinhoodStore(':memory:');
  const historicalEvent = insertEvent(store, {
    transactionHash: hash('99'),
    logIndex: 99
  }).event;
  store.upsertWalletAnnotation({
    address: wallet,
    alias: 'Alpha',
    status: 'active',
    monitorRules: { buy: { enabled: true, sound: true, bark: true } },
    createdAt: 1,
    updatedAt: 1
  });
  store.setMeta('robinhood:monitor:cursor', '100');
  let head = 101;
  let nowMs = 2_000_000_010_000;
  let logs = [
    incomingLog({ transactionHash: hash('11'), index: 1, blockNumber: 101 }),
    incomingLog({ transactionHash: hash('12'), index: 2, blockNumber: 101 })
  ];
  const metrics = deferred();
  const metricCalls = [];
  const barkEvents = [];
  const messages = [];
  const monitor = new RobinhoodWalletMonitor({
    store,
    now: () => nowMs,
    debotClient: {
      fetchTokenMetrics(address) {
        metricCalls.push(address);
        return metrics.promise;
      }
    },
    barkNotifier: {
      listTargets: () => [{ id: 1, enabled: true }],
      notifyWalletEvent: async ({ event }) => {
        barkEvents.push(event.id);
        return { attempted: 1, sent: 1, failed: 0 };
      }
    },
    rpcClient: {
      async getBlockNumber() {
        return head;
      },
      async getLogs() {
        return logs;
      },
      async getTransactionsByHashes(hashes) {
        return hashes.map((transactionHash) => ({ hash: transactionHash, from: wallet, to: router }));
      },
      async getTransactionReceipts(hashes) {
        return hashes.map((transactionHash) => ({
          transactionHash,
          status: '0x1',
          logs: [{ topics: [V2_SWAP_TOPIC] }]
        }));
      },
      async getBlockByNumber(blockNumber) {
        return { number: quantity(blockNumber), timestamp: quantity(Math.floor(nowMs / 1000) - 1) };
      },
      async ethCall({ data }) {
        if (data === '0x95d89b41') return abiString('TOK');
        if (data === '0x06fdde03') return abiString('Token');
        return `0x${'12'.padStart(64, '0')}`;
      }
    }
  });
  monitor.subscribe((message) => messages.push(message));

  await monitor.pollOnce();
  await new Promise((resolve) => setImmediate(resolve));
  assert.equal(messages.filter((message) => message.type === 'event').length, 2);
  assert.equal(messages.filter((message) => message.type === 'event_update').length, 0);
  assert.deepEqual(barkEvents, [2, 3]);
  assert.deepEqual(metricCalls, [token]);
  assert.deepEqual(
    store.listMonitorEvents().map((event) => event.marketCapUsd),
    [null, null, null]
  );

  nowMs += 5_000;
  head = 102;
  logs = [incomingLog({ transactionHash: hash('13'), index: 3, blockNumber: 102 })];
  const insertMonitorEvent = store.insertMonitorEvent.bind(store);
  store.insertMonitorEvent = (event) => {
    const result = insertMonitorEvent(event);
    if (result.inserted && event.txHash === hash('13')) {
      metrics.resolve({ marketCapUsd: 88_000, creationTimestamp: 1_999_999_000 });
    }
    return result;
  };
  await monitor.pollOnce();
  await eventually(() => {
    const liveEvents = store.listMonitorEvents().filter((event) => event.id !== historicalEvent.id);
    assert.equal(liveEvents.every((event) => event.marketCapUsd === 88_000), true);
  });
  const patches = messages.filter((message) => message.type === 'event_update').map((message) => message.data);
  assert.deepEqual(patches.flatMap((patch) => patch.eventIds), [2, 3, 4]);
  assert.equal(patches.every((patch) => patch.marketCapUsd === 88_000), true);
  assert.equal(patches.every((patch) => patch.marketDataAt === 2_000_000_015), true);
  assert.equal(store.listMonitorEvents().find((event) => event.id === historicalEvent.id).marketCapUsd, null);
  const newest = store.listMonitorEvents()[0];
  assert.equal(metricCalls.length, 1);
  assert.equal(newest.marketCapUsd, 88_000);
  assert.equal(newest.tokenCreationTimestamp, 1_999_999_000);
  assert.equal(newest.marketDataAt, 2_000_000_015);

  nowMs += 13_000;
  head = 103;
  logs = [incomingLog({ transactionHash: hash('14'), index: 4, blockNumber: 103 })];
  await monitor.pollOnce();
  await eventually(() => assert.equal(store.listMonitorEvents()[0].marketCapUsd, 88_000));
  assert.equal(metricCalls.length, 2);
  assert.equal(store.listMonitorEvents()[0].marketDataAt, 2_000_000_028);
  assert.deepEqual(
    store.listMonitorEvents().slice(1).map((event) => event.marketDataAt),
    [2_000_000_015, 2_000_000_015, 2_000_000_015, null]
  );
  monitor.close();
  store.close();
});

test('retries failed enrichment with bounded scheduling and aborts pending work on close', async () => {
  const retryStore = createRobinhoodStore(':memory:');
  retryStore.upsertMonitorTokenMetadata({
    address: token,
    symbol: 'TOK',
    name: 'Token',
    decimals: 18,
    complete: true,
    updatedAt: 100
  });
  insertEvent(retryStore);
  let calls = 0;
  const retryMonitor = new RobinhoodWalletMonitor({
    store: retryStore,
    marketDataRetryBaseMs: 10,
    marketDataRetryMaxMs: 10,
    debotClient: {
      async fetchTokenMetrics() {
        calls += 1;
        if (calls === 1) throw new Error('temporary DeBot failure');
        if (calls < 4) return { marketCapUsd: 99_000, creationTimestamp: null };
        return { marketCapUsd: 99_000, creationTimestamp: 1_999_999_000 };
      }
    },
    rpcClient: {
      async getBlockNumber() {
        return 100;
      },
      async getLogs() {
        return [];
      }
    }
  });
  retryMonitor.start();
  await eventually(() => {
    assert.equal(retryStore.listMonitorEvents()[0].tokenCreationTimestamp, 1_999_999_000);
  });
  assert.equal(retryStore.listMonitorEvents()[0].marketCapUsd, 99_000);
  assert.equal(calls, 4);
  retryMonitor.close();
  retryStore.close();

  const abortStore = createRobinhoodStore(':memory:');
  abortStore.upsertMonitorTokenMetadata({
    address: token,
    symbol: 'TOK',
    name: 'Token',
    decimals: 18,
    complete: true,
    updatedAt: 100
  });
  insertEvent(abortStore);
  let aborted = false;
  const abortMonitor = new RobinhoodWalletMonitor({
    store: abortStore,
    debotClient: {
      fetchTokenMetrics(_address, { signal }) {
        return new Promise((_resolve, reject) => {
          signal.addEventListener('abort', () => {
            aborted = true;
            reject(signal.reason);
          }, { once: true });
        });
      }
    },
    rpcClient: {
      async getBlockNumber() {
        return 100;
      },
      async getLogs() {
        return [];
      }
    }
  });
  abortMonitor.start();
  abortMonitor.close();
  await eventually(() => assert.equal(aborted, true));
  abortStore.close();
});
