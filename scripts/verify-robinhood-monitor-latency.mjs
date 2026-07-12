import { performance } from 'node:perf_hooks';

import { RobinhoodWalletMonitor } from '../src/robinhood/monitor.js';
import { RobinhoodRpcClient } from '../src/robinhood/rpcClient.js';
import { createRobinhoodStore } from '../src/robinhood/store.js';

const DEADLINE_MS = 5_000;

const FIXTURES = [
  {
    name: 'buy',
    lane: 'fast',
    blockNumber: 7_839_037,
    walletAddress: '0xb989f1807064813d8c7197c224aabc8129b50d40',
    txHash: '0x190aaf7f9e77c4e448bdee902e89681e54e4cd2c80fed778cccd53f55058912b',
    eventType: 'buy',
    assetType: 'erc20'
  },
  {
    name: 'sell',
    lane: 'fast',
    blockNumber: 7_839_065,
    walletAddress: '0xb989f1807064813d8c7197c224aabc8129b50d40',
    txHash: '0xd04a3d0b4ae804644bdb0e81683963d4a72f8dab7f87d297949f9ce019103f7e',
    eventType: 'sell',
    assetType: 'erc20'
  },
  {
    name: 'erc20_transfer',
    lane: 'fast',
    blockNumber: 7_861_959,
    walletAddress: '0x98117495f7685703bf97ee95a31fcd212993936f',
    txHash: '0xe1dbf8e4e9950832abd8d1ded8f823d200111c1bc91080080f7435b068247403',
    eventType: 'transfer',
    assetType: 'erc20'
  },
  {
    name: 'noxa_token_create',
    lane: 'fast',
    blockNumber: 0x68fd86,
    walletAddress: '0x4ba04830e5f615dc0e7d80a7dc4352c241ccbdc2',
    txHash: '0xc62997c2607d579233b552fad71faae7e392a4c13bc92b9d20c57425b9ffe418',
    eventType: 'token_create',
    assetType: 'erc20',
    platform: 'noxa'
  },
  {
    name: 'native_transfer',
    lane: 'deep',
    blockNumber: 7_861_642,
    walletAddress: '0x8401bb681370e684ece3c2e561e8f7e1c9eca012',
    txHash: '0x85d4673ae76c0158ff22d9ff779517214b331fca864961ebb02adf2786a1158d',
    eventType: 'transfer',
    assetType: 'native'
  },
  {
    name: 'direct_token_create',
    lane: 'deep',
    blockNumber: 7_853_972,
    walletAddress: '0xa1a26129eafa3b4da901e51f9e91d591ceb4c404',
    txHash: '0xd1bc38994cfe57ba8944666420a33b1c697061b4a86ad7b6dd74ac494c05ddb6',
    eventType: 'token_create',
    assetType: 'erc20',
    platform: 'direct'
  }
];

function rulesFor(fixture) {
  return {
    buy: { enabled: fixture.eventType === 'buy', sound: false, bark: false },
    sell: { enabled: fixture.eventType === 'sell', sound: false, bark: false },
    transfer: { enabled: fixture.eventType === 'transfer', sound: false, bark: false },
    token_create: { enabled: fixture.eventType === 'token_create', sound: false, bark: false }
  };
}

function fixedHeadRpc(rpcClient, blockNumber) {
  return {
    getBlockNumber: async () => blockNumber,
    getLogs: (...args) => rpcClient.getLogs(...args),
    getBlockByNumber: (...args) => rpcClient.getBlockByNumber(...args),
    getBlocksByNumbers: (...args) => rpcClient.getBlocksByNumbers(...args),
    getTransactionsByHashes: (...args) => rpcClient.getTransactionsByHashes(...args),
    getTransactionReceipts: (...args) => rpcClient.getTransactionReceipts(...args),
    ethCall: (...args) => rpcClient.ethCall(...args)
  };
}

async function withinDeadline(promise, label) {
  let timer;
  try {
    return await Promise.race([
      promise,
      new Promise((_, reject) => {
        timer = setTimeout(() => reject(new Error(`${label} exceeded ${DEADLINE_MS}ms`)), DEADLINE_MS);
      })
    ]);
  } finally {
    clearTimeout(timer);
  }
}

function matchingEvent(events, fixture) {
  return events.find((event) =>
    event.txHash === fixture.txHash &&
    event.eventType === fixture.eventType &&
    event.assetType === fixture.assetType &&
    (!fixture.platform || event.platform === fixture.platform));
}

async function replayFixture(rpcClient, fixture) {
  const store = createRobinhoodStore(':memory:');
  store.upsertWalletAnnotation({
    address: fixture.walletAddress,
    alias: `RPC ${fixture.name}`,
    status: 'active',
    monitorRules: rulesFor(fixture),
    createdAt: 1,
    updatedAt: 1
  });
  store.setMeta('robinhood:monitor:cursor', String(fixture.blockNumber - 1));
  store.setMeta('robinhood:monitor:deep-live-cursor', String(fixture.blockNumber - 1));
  const monitor = new RobinhoodWalletMonitor({
    store,
    rpcClient: fixedHeadRpc(rpcClient, fixture.blockNumber),
    deepLiveBlockSpan: 20,
    tokenMetadataBudgetMs: 1_500
  });
  let emittedAt = null;
  const startedAt = performance.now();
  monitor.subscribe((message) => {
    if (message.type !== 'event' || !matchingEvent([message.data], fixture)) return;
    emittedAt ??= performance.now();
  });
  try {
    const operation = fixture.lane === 'deep' ? monitor.pollDeepOnce() : monitor.pollOnce();
    await withinDeadline(operation, fixture.name);
    const event = matchingEvent(monitor.getEvents({ limit: 100 }), fixture);
    if (!event || emittedAt === null) throw new Error(`${fixture.name} did not emit the expected event`);
    const latencyMs = Math.round(emittedAt - startedAt);
    if (latencyMs >= DEADLINE_MS) throw new Error(`${fixture.name} emitted after ${latencyMs}ms`);
    return {
      event: fixture.name,
      lane: fixture.lane,
      latencyMs,
      txHash: fixture.txHash,
      blockNumber: fixture.blockNumber
    };
  } finally {
    monitor.close();
    store.close();
  }
}

async function main() {
  const rpcClient = new RobinhoodRpcClient({
    timeoutMs: 4_000,
    maxRetries: 0,
    batchSize: 20,
    batchDelayMs: 0
  });
  const results = [];
  for (const fixture of FIXTURES) results.push(await replayFixture(rpcClient, fixture));
  console.table(results.map(({ event, lane, latencyMs, blockNumber }) => ({ event, lane, latencyMs, blockNumber })));
  console.log(`PASS: all ${results.length} event paths emitted within ${DEADLINE_MS}ms using the public RPC.`);
}

main().catch((error) => {
  console.error(`FAIL: ${error instanceof Error ? error.message : String(error)}`);
  process.exitCode = 1;
});
