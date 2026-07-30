import test from 'node:test';
import assert from 'node:assert/strict';

import {
  BscHolderClient,
  BscHolderIntegrityError,
  BscHolderScanLimitError,
  ERC20_TRANSFER_TOPIC
} from '../src/bsc/holderClient.js';

const token = '0x1111111111111111111111111111111111111111';
const walletA = '0xaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa';
const walletB = '0xbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb';
const walletC = '0xcacacacacacacacacacacacacacacacacacacaca';
const walletD = '0xdadadadadadadadadadadadadadadadadadadada';
const contract = '0xcccccccccccccccccccccccccccccccccccccccc';
const infrastructure = '0xdddddddddddddddddddddddddddddddddddddddd';
const delegated = '0xeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeee';
const dead = '0x000000000000000000000000000000000000dead';
const zero = '0x0000000000000000000000000000000000000000';

function quantity(value) {
  return `0x${BigInt(value).toString(16)}`;
}

function topic(address) {
  return `0x${address.slice(2).padStart(64, '0')}`;
}

function transfer({ from, to, amount, block, index }) {
  return {
    address: token,
    topics: [ERC20_TRANSFER_TOPIC, topic(from), topic(to)],
    data: `0x${BigInt(amount).toString(16).padStart(64, '0')}`,
    blockNumber: quantity(block),
    transactionIndex: '0x0',
    logIndex: quantity(index),
    transactionHash: `0x${String(index + 1).padStart(64, '0')}`,
    removed: false
  };
}

function completeTransfers() {
  return [
    transfer({ from: zero, to: walletA, amount: 1_000, block: 100, index: 0 }),
    transfer({ from: walletA, to: walletB, amount: 300, block: 110, index: 1 }),
    transfer({ from: walletA, to: infrastructure, amount: 100, block: 120, index: 2 }),
    transfer({ from: walletB, to: dead, amount: 50, block: 130, index: 3 }),
    transfer({ from: walletA, to: contract, amount: 200, block: 140, index: 4 })
  ];
}

const completeBalances = new Map([
  [walletA, 400n],
  [walletB, 250n],
  [contract, 200n],
  [infrastructure, 100n],
  [dead, 50n]
]);

class FakeBscRpc {
  constructor({
    latestBlock = 200,
    deploymentBlock = 100,
    logs = completeTransfers(),
    balances = completeBalances,
    totalSupply = 1_000n,
    decimals = 0,
    failHistoricalCode = false,
    fallbackBlock = 90,
    maxLogRange = Infinity,
    logOverride = null,
    addressCode = new Map([[contract, '0x6000']]),
    latestTimestamp = 1_700_000_000,
    secondsPerBlock = 3
  } = {}) {
    this.latestBlock = latestBlock;
    this.deploymentBlock = deploymentBlock;
    this.logs = logs;
    this.balances = new Map(balances);
    this.totalSupply = totalSupply;
    this.decimals = decimals;
    this.failHistoricalCode = failHistoricalCode;
    this.fallbackBlock = fallbackBlock;
    this.maxLogRange = maxLogRange;
    this.logOverride = logOverride;
    this.addressCode = new Map(addressCode);
    this.latestTimestamp = latestTimestamp;
    this.secondsPerBlock = secondsPerBlock;
    this.logRequests = [];
    this.balanceChecks = [];
    this.findBlockCalls = [];
    this.codeRequests = [];
    this.blockSampleRequests = [];
  }

  async getBlockNumber() {
    return this.latestBlock;
  }

  async findBlockByTimestamp(timestamp, options) {
    this.findBlockCalls.push({ timestamp, options });
    return this.fallbackBlock;
  }

  async call(transaction) {
    if (transaction.data === '0x313ce567') return quantity(this.decimals);
    if (transaction.data === '0x18160ddd') return quantity(this.totalSupply);
    throw new Error(`unexpected call ${transaction.data}`);
  }

  async request(method, params) {
    if (method === 'eth_getCode') {
      const [address, tag] = params;
      const block = Number(BigInt(tag));
      this.codeRequests.push([address, block]);
      if (address === token) {
        if (this.failHistoricalCode && block < this.latestBlock) throw new Error('missing trie node');
        return block >= this.deploymentBlock ? '0x6000' : '0x';
      }
      return this.addressCode.get(address) || '0x';
    }
    if (method === 'eth_getLogs') {
      const [filter] = params;
      const from = Number(BigInt(filter.fromBlock));
      const to = Number(BigInt(filter.toBlock));
      this.logRequests.push([from, to]);
      if (to - from + 1 > this.maxLogRange) throw new Error('block range limit exceeded');
      if (this.logOverride) return this.logOverride({ from, to });
      return this.logs.filter((row) => {
        const block = Number(BigInt(row.blockNumber));
        return block >= from && block <= to;
      });
    }
    if (method === 'eth_getBlockByNumber') {
      const block = Number(BigInt(params[0]));
      this.blockSampleRequests.push(block);
      return {
        number: quantity(block),
        timestamp: quantity(this.latestTimestamp - ((this.latestBlock - block) * this.secondsPerBlock))
      };
    }
    throw new Error(`unexpected RPC method ${method}`);
  }

  async batchRequest(calls) {
    return Promise.all(calls.map(async (call) => {
      if (call.method === 'eth_getCode') return this.request(call.method, call.params);
      if (call.method === 'eth_getBlockByNumber') return this.request(call.method, call.params);
      if (call.method !== 'eth_call') throw new Error(`unexpected batch method ${call.method}`);
      const data = call.params[0].data;
      const address = `0x${data.slice(-40)}`;
      this.balanceChecks.push(address);
      return quantity(this.balances.get(address) || 0n);
    }));
  }
}

test('replays a complete BSC Transfer ledger and returns only verified wallet holders', async () => {
  const rpc = new FakeBscRpc({ maxLogRange: 50 });
  rpc.findBlockByTimestamp = undefined;
  const client = new BscHolderClient({
    rpcClient: rpc,
    infrastructureAddresses: [infrastructure],
    logWindow: 101,
    logConcurrency: 2,
    rpcBatchSize: 10
  });

  const result = await client.fetchTopHolders(token, { limit: 10 });

  assert.equal(result.source, 'bsc_rpc_transfer_ledger');
  assert.equal(result.complete, true);
  assert.equal(result.partial, false);
  assert.equal(result.deploymentBlock, 100);
  assert.equal(result.deploymentBlockSource, 'bsc_rpc_historical_code');
  assert.equal(result.historyStartReliable, true);
  assert.equal(result.firstTransferBlock, 100);
  assert.equal(result.latestBlock, 200);
  assert.equal(result.scannedLogs, 5);
  assert.equal(result.token.totalSupply, '1000');
  assert.equal(result.token.rawTotalSupply, '1000');
  assert.equal(result.token.holders, 5);
  assert.deepEqual(result.holders.map((row) => row.address), [walletA, walletB]);
  assert.deepEqual(result.holders.map((row) => row.holderRank), [1, 2]);
  assert.deepEqual(result.holders.map((row) => row.holdingTokenAmount), ['400', '250']);
  assert.deepEqual(result.holders.map((row) => row.holdingSharePercent), [40, 25]);
  assert.equal(rpc.logRequests.some(([from, to]) => from === 100 && to === 200), true);
  assert.equal(rpc.logRequests.some(([from, to]) => to - from + 1 <= 50), true);
  assert.deepEqual(rpc.balanceChecks.sort(), [...completeBalances.keys()].sort());
  assert.deepEqual(rpc.blockSampleRequests, []);
  assert.equal(rpc.codeRequests.filter(([address]) => address === token).length > 1, true);
});

test('routes only Transfer logs through an independently injected Holder log RPC', async () => {
  class StateOnlyRpc extends FakeBscRpc {
    constructor(options) {
      super(options);
      this.stateOperations = [];
    }

    async getBlockNumber(options) {
      this.stateOperations.push('getBlockNumber');
      return super.getBlockNumber(options);
    }

    async call(transaction, options) {
      this.stateOperations.push(`call:${transaction.data}`);
      return super.call(transaction, options);
    }

    async request(method, params, options) {
      assert.notEqual(method, 'eth_getLogs', 'the state RPC must never receive Holder log reads');
      this.stateOperations.push(method);
      return super.request(method, params, options);
    }

    async batchRequest(calls, options) {
      this.stateOperations.push(...calls.map((call) => `batch:${call.method}`));
      return super.batchRequest(calls, options);
    }
  }

  const rpc = new StateOnlyRpc();
  const logRequests = [];
  const logRpc = {
    async request(method, params) {
      assert.equal(method, 'eth_getLogs');
      const [filter] = params;
      const from = Number(BigInt(filter.fromBlock));
      const to = Number(BigInt(filter.toBlock));
      logRequests.push([from, to]);
      if (to - from + 1 > 50) throw new Error('block range limit exceeded');
      return completeTransfers().filter((row) => {
        const block = Number(BigInt(row.blockNumber));
        return block >= from && block <= to;
      });
    }
  };
  const client = new BscHolderClient({
    rpcClient: rpc,
    logRpcClient: logRpc,
    infrastructureAddresses: [infrastructure]
  });

  const result = await client.fetchTopHolders(token, { limit: 10 });

  assert.equal(result.complete, true);
  assert.deepEqual(result.holders.map((row) => row.address), [walletA, walletB]);
  assert.deepEqual(logRequests, [
    [100, 200],
    [100, 150],
    [100, 125],
    [126, 150],
    [151, 200]
  ]);
  assert.deepEqual(rpc.logRequests, []);
  assert.equal(rpc.stateOperations.includes('getBlockNumber'), true);
  assert.equal(rpc.stateOperations.includes('eth_getCode'), true);
  assert.equal(rpc.stateOperations.includes('call:0x313ce567'), true);
  assert.equal(rpc.stateOperations.includes('call:0x18160ddd'), true);
  assert.equal(rpc.stateOperations.includes('batch:eth_getCode'), true);
  assert.equal(rpc.stateOperations.includes('batch:eth_call'), true);
  assert.deepEqual(rpc.balanceChecks.sort(), [...completeBalances.keys()].sort());
});

test('defaults Holder log reads to the primary RPC and rejects an invalid override', async () => {
  const rpc = new FakeBscRpc();
  const client = new BscHolderClient({
    rpcClient: rpc,
    infrastructureAddresses: [infrastructure]
  });

  const result = await client.fetchTopHolders(token, { limit: 2 });

  assert.equal(client.logRpcClient, rpc);
  assert.equal(result.complete, true);
  assert.deepEqual(rpc.logRequests, [[100, 200]]);
  for (const logRpcClient of [{}, { request: true }]) {
    assert.throws(
      () => new BscHolderClient({ rpcClient: rpc, logRpcClient }),
      /BSC Holder log RPC client is required/
    );
  }
});

test('uses a buffered DeBot creation time without a historical code search and verifies every balance', async () => {
  const rpc = new FakeBscRpc({ failHistoricalCode: true, fallbackBlock: 90 });
  let detailCalls = 0;
  const client = new BscHolderClient({
    rpcClient: rpc,
    debotClient: {
      async fetchTokenDetail(address) {
        detailCalls += 1;
        assert.equal(address, token);
        return { creationTimestamp: 1_700_000_000 };
      }
    },
    infrastructureAddresses: [infrastructure],
    creationSafetySeconds: 3_600,
    logWindow: 1_000,
    rpcBatchSize: 10
  });

  const result = await client.fetchTopHolders(token, { limit: 2 });

  assert.equal(detailCalls, 1);
  assert.equal(result.deploymentBlock, 0);
  assert.equal(result.deploymentBlockSource, 'debot_creation_time_with_safety_buffer');
  assert.equal(result.historyStartReliable, false);
  assert.equal(result.historyStartValidation, 'supply_and_all_observed_balance_reconciliation');
  assert.deepEqual(rpc.findBlockCalls, []);
  assert.deepEqual(rpc.blockSampleRequests, [200, 0]);
  assert.deepEqual(
    rpc.codeRequests.filter(([address]) => address === token),
    [[token, 200]]
  );
  assert.equal(rpc.balanceChecks.length, completeBalances.size);
});

test('prefers market creation time over DeBot and avoids timestamp and code binary searches', async () => {
  const rpc = new FakeBscRpc({ failHistoricalCode: true, fallbackBlock: 90 });
  let marketCalls = 0;
  let detailCalls = 0;
  const client = new BscHolderClient({
    rpcClient: rpc,
    debotClient: {
      async fetchTokenDetail() {
        detailCalls += 1;
        const error = new Error('DeBot request failed with HTTP 401');
        error.status = 401;
        throw error;
      }
    },
    creationTimeClient: {
      async fetchTokenMetrics(address) {
        marketCalls += 1;
        assert.equal(address, token);
        return { creationTimestamp: 1_700_000_000, source: 'dexscreener_bsc_pair' };
      }
    },
    infrastructureAddresses: [infrastructure],
    creationSafetySeconds: 3_600,
    logWindow: 1_000,
    rpcBatchSize: 10
  });

  const result = await client.fetchTopHolders(token, { limit: 2 });

  assert.equal(marketCalls, 1);
  assert.equal(detailCalls, 0);
  assert.equal(result.deploymentBlock, 0);
  assert.equal(result.deploymentBlockSource, 'market_creation_time_with_safety_buffer');
  assert.equal(result.historyStartReliable, false);
  assert.deepEqual(rpc.findBlockCalls, []);
  assert.deepEqual(rpc.blockSampleRequests, [200, 0]);
  assert.deepEqual(
    rpc.codeRequests.filter(([address]) => address === token),
    [[token, 200]]
  );
  assert.equal(rpc.balanceChecks.length, completeBalances.size);
});

test('uses the historical code boundary when market data has no creation timestamp', async () => {
  const rpc = new FakeBscRpc();
  const client = new BscHolderClient({
    rpcClient: rpc,
    creationTimeClient: {
      fetchTokenMetrics: async () => ({ creationTimestamp: null, source: 'dexscreener_bsc_pair' })
    }
  });

  const result = await client.fetchTopHolders(token, { limit: 2 });

  assert.equal(result.deploymentBlock, 100);
  assert.equal(result.deploymentBlockSource, 'bsc_rpc_historical_code');
  assert.equal(result.historyStartReliable, true);
  assert.deepEqual(rpc.blockSampleRequests, []);
  assert.equal(rpc.codeRequests.filter(([address]) => address === token).length > 1, true);
});

test('preserves the strict unreliable-history error when creation time and archive history both fail', async () => {
  const rpc = new FakeBscRpc({ failHistoricalCode: true });
  const client = new BscHolderClient({
    rpcClient: rpc,
    creationTimeClient: {
      fetchTokenMetrics: async () => ({ creationTimestamp: null })
    }
  });

  await assert.rejects(
    client.fetchTopHolders(token),
    (error) => error instanceof BscHolderIntegrityError &&
      error.code === 'UNRELIABLE_HISTORY_START' &&
      /creation-time fallbacks/.test(error.message)
  );
});

test('uses recent BSC block timestamps for a conservative fast start on a newly created token', async () => {
  const latestBlock = 1_000_000;
  const deploymentBlock = 999_900;
  const latestTimestamp = 1_700_000_000;
  const logs = [
    transfer({ from: zero, to: walletA, amount: 1_000, block: deploymentBlock, index: 30 }),
    transfer({ from: walletA, to: walletB, amount: 100, block: 999_950, index: 31 })
  ];
  const rpc = new FakeBscRpc({
    latestBlock,
    deploymentBlock,
    latestTimestamp,
    logs,
    balances: new Map([[walletA, 900n], [walletB, 100n]]),
    totalSupply: 1_000n
  });
  const client = new BscHolderClient({
    rpcClient: rpc,
    creationTimeClient: {
      fetchTokenMetrics: async () => ({ creationTimestamp: latestTimestamp - 300 })
    },
    creationSafetySeconds: 60,
    logWindow: 2_000
  });

  const result = await client.fetchTopHolders(token, { limit: 2 });

  assert.equal(result.deploymentBlock, 998_656);
  assert.equal(result.deploymentBlock < deploymentBlock, true);
  assert.equal(result.deploymentBlockSource, 'market_creation_time_with_safety_buffer');
  assert.equal(result.historyStartReliable, false);
  assert.deepEqual(rpc.blockSampleRequests, [1_000_000, 997_952, 991_808]);
  assert.deepEqual(
    rpc.codeRequests.filter(([address]) => address === token),
    [[token, latestBlock]]
  );
  assert.deepEqual(result.holders.map((row) => row.address), [walletA, walletB]);
});

test('caps a conservative fast estimate and succeeds without archive history when the ledger is complete', async () => {
  const latestBlock = 1_000_000;
  const deploymentBlock = 999_100;
  const latestTimestamp = 1_700_000_000;
  const rpc = new FakeBscRpc({
    latestBlock,
    deploymentBlock,
    latestTimestamp,
    failHistoricalCode: true,
    logs: [transfer({ from: zero, to: walletA, amount: 1_000, block: deploymentBlock, index: 35 })],
    balances: new Map([[walletA, 1_000n]]),
    totalSupply: 1_000n
  });
  const client = new BscHolderClient({
    rpcClient: rpc,
    creationTimeClient: {
      fetchTokenMetrics: async () => ({ creationTimestamp: latestTimestamp - 3_600 })
    },
    creationSafetySeconds: 60,
    maxBlockSpan: 1_000,
    logWindow: 2_000
  });

  const result = await client.fetchTopHolders(token, { limit: 1 });

  assert.equal(result.deploymentBlock, 999_001);
  assert.equal(result.deploymentBlockSource, 'market_creation_time_with_safety_buffer');
  assert.equal(result.historyStartReliable, false);
  assert.equal(result.scannedBlocks, 1_000);
  assert.deepEqual(
    rpc.codeRequests.filter(([address]) => address === token),
    [[token, latestBlock]]
  );
  assert.deepEqual(result.holders.map((row) => row.address), [walletA]);
});

test('retries from the historical code boundary when the fast creation-time ledger is incomplete', async () => {
  const latestBlock = 1_000_000;
  const deploymentBlock = 990_000;
  const latestTimestamp = 1_700_000_000;
  const logs = [
    transfer({ from: zero, to: walletA, amount: 1_000, block: deploymentBlock, index: 40 }),
    transfer({ from: walletA, to: walletB, amount: 100, block: 999_900, index: 41 })
  ];
  const rpc = new FakeBscRpc({
    latestBlock,
    deploymentBlock,
    latestTimestamp,
    logs,
    balances: new Map([[walletA, 900n], [walletB, 100n]]),
    totalSupply: 1_000n
  });
  const client = new BscHolderClient({
    rpcClient: rpc,
    creationTimeClient: {
      fetchTokenMetrics: async () => ({ creationTimestamp: latestTimestamp - 300 })
    },
    creationSafetySeconds: 60,
    logWindow: 2_000
  });

  const result = await client.fetchTopHolders(token, { limit: 2 });

  assert.equal(result.deploymentBlock, deploymentBlock);
  assert.equal(result.deploymentBlockSource, 'bsc_rpc_historical_code');
  assert.equal(result.historyStartReliable, true);
  assert.equal(
    result.historyStartValidation,
    'historical_code_boundary_supply_and_all_observed_balance_reconciliation'
  );
  assert.equal(rpc.logRequests.some(([from]) => from === 998_656), true);
  assert.equal(rpc.logRequests.some(([from]) => from === deploymentBlock), true);
  assert.equal(rpc.codeRequests.filter(([address]) => address === token).length > 10, true);
  assert.deepEqual(result.holders.map((row) => row.address), [walletA, walletB]);
});

test('propagates an abort from creation-time block sampling without starting historical fallback', async () => {
  const controller = new AbortController();
  const reason = new Error('stop BSC Holder job');
  reason.name = 'AbortError';
  class AbortedSampleRpc extends FakeBscRpc {
    async batchRequest(calls, options) {
      if (calls.every((call) => call.method === 'eth_getBlockByNumber')) {
        controller.abort(reason);
        throw reason;
      }
      return super.batchRequest(calls, options);
    }
  }
  const rpc = new AbortedSampleRpc({ latestBlock: 1_000_000 });
  const client = new BscHolderClient({
    rpcClient: rpc,
    creationTimeClient: {
      fetchTokenMetrics: async () => ({ creationTimestamp: 1_699_999_700 })
    }
  });

  await assert.rejects(
    client.fetchTopHolders(token, { signal: controller.signal }),
    (error) => error === reason
  );
  assert.equal(
    rpc.codeRequests.some(([address, block]) => address === token && block < rpc.latestBlock),
    false
  );
  assert.deepEqual(rpc.logRequests, []);
});

test('keeps an EIP-7702 delegated EOA while excluding ordinary contracts', async () => {
  const logs = [transfer({ from: zero, to: delegated, amount: 100, block: 100, index: 20 })];
  const rpc = new FakeBscRpc({
    logs,
    balances: new Map([[delegated, 100n]]),
    totalSupply: 100n,
    addressCode: new Map([
      [delegated, `0xef0100${'12'.repeat(20)}`],
      [contract, '0x6000']
    ])
  });
  const client = new BscHolderClient({ rpcClient: rpc });

  const result = await client.fetchTopHolders(token);

  assert.equal(result.holders.length, 1);
  assert.equal(result.holders[0].address, delegated);
  assert.equal(result.holders[0].isContract, true);
  assert.equal(result.holders[0].proxyType, 'eip7702');
  assert.deepEqual(result.holders[0].exclusionReasons, []);
});

test('fails instead of publishing holders when a fallback start misses earlier Transfer history', async () => {
  const rpc = new FakeBscRpc({
    failHistoricalCode: true,
    fallbackBlock: 150,
    logs: [transfer({ from: walletA, to: walletB, amount: 10, block: 160, index: 9 })],
    balances: new Map([[walletA, 990n], [walletB, 10n]])
  });
  const client = new BscHolderClient({
    rpcClient: rpc,
    debotClient: { fetchTokenDetail: async () => ({ creationTimestamp: 1_700_000_000 }) }
  });

  await assert.rejects(
    client.fetchTopHolders(token),
    (error) => error instanceof BscHolderIntegrityError && error.code === 'INCOMPLETE_TRANSFER_HISTORY'
  );
});

test('fails on supply or balance reconciliation instead of returning a partial ranking', async () => {
  const supplyMismatch = new BscHolderClient({
    rpcClient: new FakeBscRpc({ totalSupply: 1_001n })
  });
  await assert.rejects(
    supplyMismatch.fetchTopHolders(token),
    (error) => error instanceof BscHolderIntegrityError && error.code === 'SUPPLY_RECONCILIATION_FAILED'
  );

  const wrongBalances = new Map(completeBalances);
  wrongBalances.set(walletA, 399n);
  const balanceMismatch = new BscHolderClient({
    rpcClient: new FakeBscRpc({ balances: wrongBalances }),
    infrastructureAddresses: [infrastructure]
  });
  await assert.rejects(
    balanceMismatch.fetchTopHolders(token),
    (error) => error instanceof BscHolderIntegrityError && error.code === 'BALANCE_RECONCILIATION_FAILED'
  );
});

test('rejects a log provider that silently omits a transfer between non-selected holders', async () => {
  const fullLogs = [
    transfer({ from: zero, to: walletA, amount: 1_000, block: 100, index: 60 }),
    transfer({ from: walletA, to: walletB, amount: 400, block: 110, index: 61 }),
    transfer({ from: walletA, to: walletC, amount: 200, block: 120, index: 62 }),
    transfer({ from: walletB, to: walletD, amount: 100, block: 130, index: 63 }),
    transfer({ from: walletC, to: walletD, amount: 150, block: 140, index: 64 })
  ];
  const actualBalances = new Map([
    [walletA, 400n],
    [walletB, 300n],
    [walletC, 50n],
    [walletD, 250n]
  ]);
  const rpc = new FakeBscRpc({
    logs: fullLogs,
    balances: actualBalances,
    totalSupply: 1_000n
  });
  const logRpc = {
    async request(method, params) {
      assert.equal(method, 'eth_getLogs');
      const [filter] = params;
      const from = Number(BigInt(filter.fromBlock));
      const to = Number(BigInt(filter.toBlock));
      return fullLogs
        .filter((row) => Number(BigInt(row.blockNumber)) >= from && Number(BigInt(row.blockNumber)) <= to)
        .filter((row) => Number(BigInt(row.logIndex)) !== 64);
    }
  };
  const client = new BscHolderClient({ rpcClient: rpc, logRpcClient: logRpc });

  await assert.rejects(
    client.fetchTopHolders(token, { limit: 2 }),
    (error) => error instanceof BscHolderIntegrityError &&
      error.code === 'BALANCE_RECONCILIATION_FAILED'
  );
});

test('splits dense log windows and fails explicitly when even one block reaches the truncation guard', async () => {
  const denseLogs = Array.from({ length: 100 }, (_, index) =>
    transfer({ from: zero, to: walletA, amount: 1, block: 100, index: index + 100 })
  );
  const rpc = new FakeBscRpc({
    latestBlock: 100,
    deploymentBlock: 100,
    totalSupply: 100n,
    balances: new Map([[walletA, 100n]]),
    logOverride: () => denseLogs
  });
  const client = new BscHolderClient({
    rpcClient: rpc,
    logResultGuard: 100,
    logWindow: 1
  });

  await assert.rejects(
    client.fetchTopHolders(token),
    (error) => error instanceof BscHolderScanLimitError && error.code === 'UNVERIFIABLE_LOG_WINDOW'
  );
});

test('enforces the configured historical block-span limit before requesting logs', async () => {
  const rpc = new FakeBscRpc({ latestBlock: 6_000, deploymentBlock: 0, logs: [] });
  const client = new BscHolderClient({ rpcClient: rpc, maxBlockSpan: 1_000 });

  await assert.rejects(
    client.fetchTopHolders(token),
    (error) => error instanceof BscHolderScanLimitError && error.code === 'BLOCK_SPAN_LIMIT'
  );
  assert.equal(rpc.logRequests.length, 0);
});

test('does not reinterpret a generic RPC response failure as a splittable log-range limit', async () => {
  const rpc = new FakeBscRpc({
    logOverride() {
      throw new Error('invalid response payload');
    }
  });
  const client = new BscHolderClient({
    rpcClient: rpc,
    logWindow: 1_000,
    logConcurrency: 1
  });

  await assert.rejects(client.fetchTopHolders(token), /invalid response payload/);
  assert.deepEqual(rpc.logRequests, [[100, 200]]);
});

test('aborts in-flight Holder log workers and starts no new windows after the first fatal error', async () => {
  class FatalWindowRpc extends FakeBscRpc {
    async request(method, params, { signal } = {}) {
      if (method !== 'eth_getLogs') return super.request(method, params);
      const [filter] = params;
      const from = Number(BigInt(filter.fromBlock));
      const to = Number(BigInt(filter.toBlock));
      this.logRequests.push([from, to]);
      if (from === 100) throw new Error('BSC Holder RPC unavailable');
      return new Promise((resolve, reject) => {
        const timer = setTimeout(() => resolve([]), 250);
        const aborted = () => {
          clearTimeout(timer);
          reject(signal.reason);
        };
        if (signal?.aborted) aborted();
        else signal?.addEventListener('abort', aborted, { once: true });
      });
    }
  }

  const rpc = new FatalWindowRpc({
    latestBlock: 104,
    deploymentBlock: 100,
    logs: [],
    balances: new Map(),
    totalSupply: 0n
  });
  const client = new BscHolderClient({
    rpcClient: rpc,
    logWindow: 1,
    logConcurrency: 2
  });

  await assert.rejects(client.fetchTopHolders(token), /BSC Holder RPC unavailable/);
  assert.deepEqual(rpc.logRequests, [[100, 100], [101, 101]]);
});

test('aborts in-flight Holder log workers when token metadata fails first', async () => {
  class MetadataFailureRpc extends FakeBscRpc {
    constructor(options) {
      super(options);
      this.abortedLogRequests = 0;
    }

    async call(transaction) {
      if (transaction.data === '0x313ce567') throw new Error('BSC metadata unavailable');
      return super.call(transaction);
    }

    async request(method, params, { signal } = {}) {
      if (method !== 'eth_getLogs') return super.request(method, params);
      const [filter] = params;
      this.logRequests.push([
        Number(BigInt(filter.fromBlock)),
        Number(BigInt(filter.toBlock))
      ]);
      return new Promise((resolve, reject) => {
        const aborted = () => {
          this.abortedLogRequests += 1;
          reject(signal.reason);
        };
        if (signal?.aborted) aborted();
        else signal?.addEventListener('abort', aborted, { once: true });
      });
    }
  }

  const rpc = new MetadataFailureRpc({
    latestBlock: 104,
    deploymentBlock: 100,
    logs: [],
    balances: new Map(),
    totalSupply: 0n
  });
  const client = new BscHolderClient({ rpcClient: rpc, logWindow: 1, logConcurrency: 2 });

  await assert.rejects(client.fetchTopHolders(token), /BSC metadata unavailable/);
  assert.deepEqual(rpc.logRequests, [[100, 100], [101, 101]]);
  assert.equal(rpc.abortedLogRequests, 2);
});
