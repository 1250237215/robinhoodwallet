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
const recipient = '0xbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb';
const router = '0xcccccccccccccccccccccccccccccccccccccccc';
const pool = '0xdddddddddddddddddddddddddddddddddddddddd';
const token = '0x1111111111111111111111111111111111111111';
const directToken = '0x2222222222222222222222222222222222222222';
const buyHash = hash('11');
const sellHash = hash('22');
const TEST_TIMEOUT_MS = 1_500;
const ASSERTION_TIMEOUT_MS = 250;
const EVENT_DEADLINE_MS = 5_000;

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

function delay(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

function deferred() {
  let resolve;
  let reject;
  const promise = new Promise((resolvePromise, rejectPromise) => {
    resolve = resolvePromise;
    reject = rejectPromise;
  });
  return { promise, resolve, reject };
}

async function within(promise, label, timeoutMs = ASSERTION_TIMEOUT_MS) {
  let timer;
  try {
    return await Promise.race([
      Promise.resolve(promise),
      new Promise((_, reject) => {
        timer = setTimeout(() => reject(new Error(`${label} exceeded ${timeoutMs}ms`)), timeoutMs);
      })
    ]);
  } finally {
    clearTimeout(timer);
  }
}

function pendingUntilAbort(signal) {
  return new Promise((_, reject) => {
    const abort = () => reject(signal?.reason instanceof Error ? signal.reason : new Error('aborted'));
    if (signal?.aborted) {
      abort();
      return;
    }
    signal?.addEventListener('abort', abort, { once: true });
  });
}

function transferLog({ direction, transactionHash, logIndex, blockNumber = 101 }) {
  return {
    address: token,
    topics: direction === 'incoming'
      ? [ERC20_TRANSFER_TOPIC, topic(pool), topic(wallet)]
      : [ERC20_TRANSFER_TOPIC, topic(wallet), topic(recipient)],
    data: `0x${'1'.padStart(64, '0')}`,
    blockNumber: quantity(blockNumber),
    transactionHash,
    logIndex: quantity(logIndex),
    removed: false
  };
}

function block(blockNumber, { transactions = undefined } = {}) {
  return {
    number: quantity(blockNumber),
    timestamp: quantity(2_000_000_000 + blockNumber),
    ...(transactions === undefined ? {} : { transactions })
  };
}

function seedWallet(store, rules = {}) {
  store.upsertWalletAnnotation({
    address: wallet,
    alias: 'Alpha',
    status: 'active',
    monitorRules: rules,
    createdAt: 1,
    updatedAt: 1
  });
  store.upsertMonitorTokenMetadata({
    address: token,
    symbol: 'TOK',
    name: 'Token',
    decimals: 18,
    complete: true,
    updatedAt: 2_000_000_000
  });
}

function seedCursors(store, { fast = 100, deep = 100, gaps = [] } = {}) {
  store.setMeta('robinhood:monitor:cursor', String(fast));
  store.setMeta('robinhood:monitor:deep-live-cursor', String(deep));
  store.setMeta('robinhood:monitor:deep-gaps', JSON.stringify(gaps));
}

function fastBuySellRpc({ head = 101, fullBlocks } = {}) {
  return {
    async getBlockNumber() {
      return head;
    },
    async getLogs(filter) {
      if (filter.topics?.[2]) {
        return [transferLog({ direction: 'incoming', transactionHash: buyHash, logIndex: 1 })];
      }
      if (filter.topics?.[1]) {
        return [transferLog({ direction: 'outgoing', transactionHash: sellHash, logIndex: 2 })];
      }
      return [];
    },
    async getTransactionsByHashes(hashes) {
      return hashes.map((transactionHash) => ({
        hash: transactionHash,
        from: wallet,
        to: router,
        value: '0x0',
        input: '0x1234'
      }));
    },
    async getTransactionReceipts(hashes) {
      return hashes.map((transactionHash) => ({
        transactionHash,
        status: '0x1',
        logs: [{ topics: [V2_SWAP_TOPIC] }]
      }));
    },
    async getBlocksByNumbers(numbers, { includeTransactions = false, signal } = {}) {
      if (includeTransactions && fullBlocks) return fullBlocks(numbers, signal);
      return numbers.map((blockNumber) => block(blockNumber, {
        transactions: includeTransactions ? [] : undefined
      }));
    },
    async getBlockByNumber(blockNumber, { includeTransactions = false, signal } = {}) {
      if (includeTransactions && fullBlocks) {
        const rows = await fullBlocks([blockNumber], signal);
        return rows[0];
      }
      return block(blockNumber, { transactions: includeTransactions ? [] : undefined });
    }
  };
}

function readGaps(store) {
  const value = JSON.parse(store.getMeta('robinhood:monitor:deep-gaps') || '[]');
  assert.ok(Array.isArray(value), 'deep gaps must be persisted as a JSON array');
  return value.map((range) => ({
    fromBlock: Number(range.fromBlock ?? range.from),
    toBlock: Number(range.toBlock ?? range.to)
  }));
}

function rangeBlockCount(ranges) {
  return ranges.reduce((total, range) => total + range.toBlock - range.fromBlock + 1, 0);
}

test('a permanently pending deep RPC cannot delay fast buy and sell events', {
  timeout: TEST_TIMEOUT_MS
}, async (t) => {
  const store = createRobinhoodStore(':memory:');
  const monitorStartedDeep = deferred();
  seedWallet(store, {
    buy: { enabled: true },
    sell: { enabled: true },
    transfer: { enabled: true },
    token_create: { enabled: false }
  });
  seedCursors(store);
  const monitor = new RobinhoodWalletMonitor({
    store,
    rpcClient: fastBuySellRpc({
      fullBlocks: (_numbers, signal) => {
        monitorStartedDeep.resolve();
        return pendingUntilAbort(signal);
      }
    }),
    deepLiveBlockSpan: 3
  });
  t.after(() => {
    monitor.close();
    store.close();
  });
  const emitted = [];
  monitor.subscribe((message) => {
    if (message.type === 'event') emitted.push(message.data);
  });

  let deepSettled = false;
  const deepPoll = monitor.pollDeepOnce().then(
    (value) => {
      deepSettled = true;
      return value;
    },
    (error) => {
      deepSettled = true;
      throw error;
    }
  );
  void deepPoll.catch(() => {});
  await within(monitorStartedDeep.promise, 'deep full-block RPC start');

  await within(monitor.pollOnce(), 'fast poll while deep RPC is pending');
  assert.equal(deepSettled, false, 'pollOnce must not join or await the deep promise');
  assert.equal(store.getMeta('robinhood:monitor:cursor'), '101');
  assert.deepEqual(emitted.map((event) => event.eventType).sort(), ['buy', 'sell']);
  assert.equal(monitor.getSnapshot().health.fastBacklogBlocks, 0);
  assert.ok(Number.isFinite(monitor.getSnapshot().health.fastLastRangeDurationMs));
});

test('deep-lane errors do not activate fast RPC protection', {
  timeout: TEST_TIMEOUT_MS
}, async (t) => {
  const store = createRobinhoodStore(':memory:');
  seedWallet(store, {
    buy: { enabled: true },
    sell: { enabled: false },
    transfer: { enabled: true },
    token_create: { enabled: false }
  });
  seedCursors(store);
  const deepError = new Error('RPC failed with HTTP 429 in deep lane');
  deepError.status = 429;
  const rpcClient = {
    async getBlockNumber() {
      return 101;
    },
    async getLogs() {
      return [];
    },
    async getBlocksByNumbers() {
      throw deepError;
    }
  };
  const monitor = new RobinhoodWalletMonitor({ store, rpcClient, deepLiveBlockSpan: 3 });
  t.after(() => {
    monitor.close();
    store.close();
  });

  await assert.rejects(
    within(monitor.pollDeepOnce(), 'deep error propagation'),
    /429 in deep lane/
  );
  assert.equal(monitor.getSnapshot().health.rpcProtection.active, false);
  assert.equal(monitor.getSnapshot().health.consecutiveErrors, 0);

  await within(monitor.pollOnce(), 'fast poll after a deep error');
  assert.equal(store.getMeta('robinhood:monitor:cursor'), '101');
  assert.equal(monitor.getSnapshot().health.rpcProtection.active, false);
});

test('deep live backlog scans the newest window first and persists the older gap', {
  timeout: TEST_TIMEOUT_MS
}, async (t) => {
  const store = createRobinhoodStore(':memory:');
  seedWallet(store, {
    buy: { enabled: false },
    transfer: { enabled: true },
    token_create: { enabled: false }
  });
  seedCursors(store, { fast: 100, deep: 90 });
  const fullBlockRanges = [];
  const monitor = new RobinhoodWalletMonitor({
    store,
    deepLiveBlockSpan: 3,
    deepGapBlockSpan: 2,
    rpcClient: {
      async getBlockNumber() {
        return 100;
      },
      async getLogs() {
        return [];
      },
      async getBlocksByNumbers(numbers, { includeTransactions }) {
        assert.equal(includeTransactions, true);
        fullBlockRanges.push([...numbers]);
        return numbers.map((blockNumber) => block(blockNumber, { transactions: [] }));
      }
    }
  });
  t.after(() => {
    monitor.close();
    store.close();
  });

  await within(monitor.pollDeepOnce(), 'deep newest-window poll');
  assert.deepEqual(fullBlockRanges, [[98, 99, 100]]);
  assert.equal(store.getMeta('robinhood:monitor:deep-live-cursor'), '100');
  assert.deepEqual(readGaps(store), [{ fromBlock: 91, toBlock: 97 }]);
  assert.deepEqual(
    {
      deepLiveCursor: monitor.getSnapshot().health.deepLiveCursor,
      deepLiveBacklogBlocks: monitor.getSnapshot().health.deepLiveBacklogBlocks,
      deepGapBlocks: monitor.getSnapshot().health.deepGapBlocks,
      deepStatus: monitor.getSnapshot().health.deepStatus
    },
    {
      deepLiveCursor: 100,
      deepLiveBacklogBlocks: 0,
      deepGapBlocks: 7,
      deepStatus: 'backfilling'
    }
  );
  assert.ok(Number.isFinite(monitor.getSnapshot().health.deepLastRangeDurationMs));
});

test('a restarted monitor restores and advances a persisted deep gap', {
  timeout: TEST_TIMEOUT_MS
}, async (t) => {
  const store = createRobinhoodStore(':memory:');
  seedWallet(store, {
    buy: { enabled: false },
    transfer: { enabled: true },
    token_create: { enabled: false }
  });
  seedCursors(store, { fast: 100, deep: 90 });
  const first = new RobinhoodWalletMonitor({
    store,
    deepLiveBlockSpan: 3,
    deepGapBlockSpan: 2,
    rpcClient: {
      async getBlockNumber() {
        return 100;
      },
      async getLogs() {
        return [];
      },
      async getBlocksByNumbers(numbers) {
        return numbers.map((blockNumber) => block(blockNumber, { transactions: [] }));
      }
    }
  });
  await within(first.pollDeepOnce(), 'initial deep poll that creates a gap');
  const savedGaps = readGaps(store);
  assert.deepEqual(savedGaps, [{ fromBlock: 91, toBlock: 97 }]);
  first.close();

  const restoredRanges = [];
  const restarted = new RobinhoodWalletMonitor({
    store,
    deepLiveBlockSpan: 3,
    deepGapBlockSpan: 2,
    rpcClient: {
      async getBlockNumber() {
        return 100;
      },
      async getLogs() {
        return [];
      },
      async getBlocksByNumbers(numbers, { includeTransactions }) {
        assert.equal(includeTransactions, true);
        restoredRanges.push([...numbers]);
        return numbers.map((blockNumber) => block(blockNumber, { transactions: [] }));
      }
    }
  });
  t.after(() => {
    restarted.close();
    store.close();
  });

  await within(restarted.pollGapOnce(), 'restored gap poll');
  assert.deepEqual(restoredRanges, [[91, 92]]);
  assert.equal(store.getMeta('robinhood:monitor:deep-live-cursor'), '100');
  assert.ok(rangeBlockCount(readGaps(store)) < rangeBlockCount(savedGaps));
});

test('a pending gap scan cannot block the fast lane', {
  timeout: TEST_TIMEOUT_MS
}, async (t) => {
  const store = createRobinhoodStore(':memory:');
  const gapStarted = deferred();
  seedWallet(store, {
    buy: { enabled: true },
    sell: { enabled: false },
    transfer: { enabled: true },
    token_create: { enabled: false }
  });
  seedCursors(store, {
    fast: 100,
    deep: 101,
    gaps: [{ fromBlock: 90, toBlock: 99 }]
  });
  const monitor = new RobinhoodWalletMonitor({
    store,
    deepLiveBlockSpan: 3,
    deepGapBlockSpan: 2,
    rpcClient: fastBuySellRpc({
      fullBlocks: (_numbers, signal) => {
        gapStarted.resolve();
        return pendingUntilAbort(signal);
      }
    })
  });
  t.after(() => {
    monitor.close();
    store.close();
  });
  const emitted = [];
  monitor.subscribe((message) => {
    if (message.type === 'event') emitted.push(message.data);
  });

  let gapSettled = false;
  const gapPoll = monitor.pollGapOnce().then(
    (value) => {
      gapSettled = true;
      return value;
    },
    (error) => {
      gapSettled = true;
      throw error;
    }
  );
  void gapPoll.catch(() => {});
  await within(gapStarted.promise, 'gap full-block RPC start');

  await within(monitor.pollOnce(), 'fast poll while a gap scan is pending');
  assert.equal(gapSettled, false, 'pollOnce must not join or await the gap promise');
  assert.equal(store.getMeta('robinhood:monitor:cursor'), '101');
  assert.deepEqual(emitted.map((event) => event.eventType), ['buy']);
});

test('deep polling skips full blocks when transfer and token-create rules are disabled', {
  timeout: TEST_TIMEOUT_MS
}, async (t) => {
  const store = createRobinhoodStore(':memory:');
  seedWallet(store, {
    buy: { enabled: true },
    sell: { enabled: true },
    transfer: { enabled: false },
    token_create: { enabled: false }
  });
  seedCursors(store);
  let fullBlockReads = 0;
  const monitor = new RobinhoodWalletMonitor({
    store,
    deepLiveBlockSpan: 3,
    rpcClient: {
      async getBlockNumber() {
        return 101;
      },
      async getLogs() {
        return [];
      },
      async getBlocksByNumbers(_numbers, { includeTransactions }) {
        if (includeTransactions) fullBlockReads += 1;
        return [];
      }
    }
  });
  t.after(() => {
    monitor.close();
    store.close();
  });

  await within(monitor.pollDeepOnce(), 'deep poll with all deep rules disabled');
  assert.equal(fullBlockReads, 0);
  assert.equal(store.getMeta('robinhood:monitor:deep-live-cursor'), '101');
});

test('a newly enabled deep wallet never replays an older persisted gap', {
  timeout: TEST_TIMEOUT_MS
}, async (t) => {
  const store = createRobinhoodStore(':memory:');
  seedWallet(store, {
    buy: { enabled: false },
    transfer: { enabled: true },
    token_create: { enabled: false }
  });
  seedCursors(store, {
    fast: 101,
    deep: 101,
    gaps: [{ fromBlock: 90, toBlock: 99 }]
  });
  const oldHash = hash('2f');
  const monitor = new RobinhoodWalletMonitor({
    store,
    deepGapBlockSpan: 2,
    rpcClient: {
      async getBlockNumber() {
        return 101;
      },
      async getLogs() {
        return [];
      },
      async getBlocksByNumbers(numbers) {
        return numbers.map((blockNumber) => block(blockNumber, {
          transactions: blockNumber === 90 ? [{
            hash: oldHash,
            from: wallet,
            to: recipient,
            value: quantity(1n),
            input: '0x'
          }] : []
        }));
      },
      async getTransactionReceipts() {
        throw new Error('old transactions must be filtered before receipt lookup');
      }
    }
  });
  t.after(() => {
    monitor.close();
    store.close();
  });

  await within(monitor.pollGapOnce(), 'new-wallet gap guard');
  assert.equal(store.listMonitorEvents().length, 0);
  assert.equal(JSON.parse(store.getMeta('robinhood:monitor:deep-wallet-starts'))[wallet], 101);
});

test('buy, sell, ERC-20 transfer, native transfer, Noxa launch, and direct deployment emit within five seconds', {
  timeout: EVENT_DEADLINE_MS * 2 + 1_000
}, async (t) => {
  const store = createRobinhoodStore(':memory:');
  seedWallet(store, {
    buy: { enabled: true },
    sell: { enabled: true },
    transfer: { enabled: true },
    token_create: { enabled: true }
  });
  seedCursors(store);
  const hashes = {
    buy: hash('31'),
    sell: hash('32'),
    erc20Transfer: hash('33'),
    noxa: hash('34'),
    native: hash('35'),
    direct: hash('36')
  };
  const rpcDelayMs = 75;
  const monitor = new RobinhoodWalletMonitor({
    store,
    tokenMetadataBudgetMs: 1_500,
    rpcClient: {
      async getBlockNumber() {
        await delay(rpcDelayMs);
        return 101;
      },
      async getLogs(filter) {
        await delay(rpcDelayMs);
        if (filter.address === NOXA_LAUNCH_FACTORY) {
          return [{
            address: NOXA_LAUNCH_FACTORY,
            topics: [NOXA_TOKEN_LAUNCHED_TOPIC, topic(token), topic(wallet), topic(pool)],
            data: '0x',
            blockNumber: quantity(101),
            transactionHash: hashes.noxa,
            logIndex: quantity(4),
            removed: false
          }];
        }
        if (filter.topics?.[2]) {
          return [transferLog({ direction: 'incoming', transactionHash: hashes.buy, logIndex: 1 })];
        }
        if (filter.topics?.[1]) {
          return [
            transferLog({ direction: 'outgoing', transactionHash: hashes.sell, logIndex: 2 }),
            transferLog({ direction: 'outgoing', transactionHash: hashes.erc20Transfer, logIndex: 3 })
          ];
        }
        return [];
      },
      async getTransactionsByHashes(transactionHashes) {
        await delay(rpcDelayMs);
        return transactionHashes.map((transactionHash) => ({ hash: transactionHash, from: wallet, to: router }));
      },
      async getTransactionReceipts(transactionHashes) {
        await delay(rpcDelayMs);
        return transactionHashes.map((transactionHash) => {
          if (transactionHash === hashes.direct) {
            return { transactionHash, status: '0x1', contractAddress: directToken, logs: [] };
          }
          if (transactionHash === hashes.native) {
            return { transactionHash, status: '0x1', contractAddress: null, logs: [] };
          }
          return {
            transactionHash,
            status: '0x1',
            logs: transactionHash === hashes.erc20Transfer
              ? [{ topics: [ERC20_TRANSFER_TOPIC] }]
              : [{ topics: [V2_SWAP_TOPIC] }]
          };
        });
      },
      async getBlocksByNumbers(numbers, { includeTransactions }) {
        await delay(rpcDelayMs);
        return numbers.map((blockNumber) => block(blockNumber, {
          transactions: includeTransactions ? [
            {
              hash: hashes.native,
              from: wallet,
              to: recipient,
              value: quantity(10n ** 18n),
              input: '0x'
            },
            {
              hash: hashes.direct,
              from: wallet,
              to: null,
              value: '0x0',
              input: '0x6000'
            }
          ] : undefined
        }));
      },
      async ethCall({ data }) {
        await delay(rpcDelayMs);
        if (data === '0x95d89b41') return abiString('NEW');
        if (data === '0x06fdde03') return abiString('New token');
        return `0x${'12'.padStart(64, '0')}`;
      }
    }
  });
  t.after(() => {
    monitor.close();
    store.close();
  });

  const latencies = new Map();
  let laneStartedAt = performance.now();
  monitor.subscribe((message) => {
    if (message.type !== 'event') return;
    const event = message.data;
    const key = event.eventType === 'token_create'
      ? `${event.eventType}:${event.platform}`
      : event.eventType === 'transfer'
        ? `${event.eventType}:${event.assetType}`
        : event.eventType;
    latencies.set(key, performance.now() - laneStartedAt);
  });

  await within(monitor.pollOnce(), 'four fast-lane event types', EVENT_DEADLINE_MS);
  for (const key of ['buy', 'sell', 'transfer:erc20', 'token_create:noxa']) {
    assert.ok(latencies.has(key), `${key} must be emitted by the fast lane`);
    assert.ok(latencies.get(key) < EVENT_DEADLINE_MS, `${key} exceeded the five-second deadline`);
  }

  laneStartedAt = performance.now();
  await within(monitor.pollDeepOnce(), 'two deep-lane event types', EVENT_DEADLINE_MS);
  for (const key of ['transfer:native', 'token_create:direct']) {
    assert.ok(latencies.has(key), `${key} must be emitted by the deep lane`);
    assert.ok(latencies.get(key) < EVENT_DEADLINE_MS, `${key} exceeded the five-second deadline`);
  }
});
