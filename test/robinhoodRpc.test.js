import test from 'node:test';
import assert from 'node:assert/strict';

import { RobinhoodRpcClient, RobinhoodRpcError } from '../src/robinhood/rpcClient.js';

function jsonResponse(body, status = 200, headers = {}) {
  return new Response(JSON.stringify(body), {
    status,
    headers: { 'content-type': 'application/json', ...headers }
  });
}

function rpcResult(request, result) {
  return jsonResponse({ jsonrpc: '2.0', id: request.id, result });
}

test('standardizes HTTP 429 errors and retries after the server delay', async () => {
  const sleeps = [];
  let attempts = 0;
  const client = new RobinhoodRpcClient({
    maxRetries: 1,
    fetchImpl: async (_url, options) => {
      const request = JSON.parse(options.body);
      attempts += 1;
      if (attempts === 1) {
        return jsonResponse({ message: 'rate limited' }, 429, { 'retry-after': '0.01' });
      }
      return rpcResult(request, '0x2a');
    },
    sleep: async (ms) => sleeps.push(ms)
  });

  assert.equal(await client.getBlockNumber(), 42);
  assert.equal(attempts, 2);
  assert.deepEqual(sleeps, [10]);

  const failing = new RobinhoodRpcClient({
    maxRetries: 0,
    fetchImpl: async () => jsonResponse({ message: 'rate limited' }, 429)
  });
  await assert.rejects(failing.getBlockNumber(), (error) => {
    assert.ok(error instanceof RobinhoodRpcError);
    assert.equal(error.kind, 'http');
    assert.equal(error.status, 429);
    assert.equal(error.retryable, true);
    return true;
  });
});

test('retries retryable JSON-RPC -32000 and timeout failures', async () => {
  let rpcAttempts = 0;
  const rpcClient = new RobinhoodRpcClient({
    maxRetries: 1,
    retryDelayMs: 0,
    sleep: async () => {},
    fetchImpl: async (_url, options) => {
      const request = JSON.parse(options.body);
      rpcAttempts += 1;
      if (rpcAttempts === 1) {
        return jsonResponse({ jsonrpc: '2.0', id: request.id, error: { code: -32000, message: 'busy' } });
      }
      return rpcResult(request, '0x7');
    }
  });
  assert.equal(await rpcClient.getBlockNumber(), 7);
  assert.equal(rpcAttempts, 2);

  let timeoutAttempts = 0;
  const timeoutClient = new RobinhoodRpcClient({
    maxRetries: 1,
    retryDelayMs: 0,
    sleep: async () => {},
    fetchImpl: async (_url, options) => {
      const request = JSON.parse(options.body);
      timeoutAttempts += 1;
      if (timeoutAttempts === 1) throw new DOMException('request timed out', 'TimeoutError');
      return rpcResult(request, '0x8');
    }
  });
  assert.equal(await timeoutClient.getBlockNumber(), 8);
  assert.equal(timeoutAttempts, 2);
});

test('finds the first block at or after a timestamp with binary search', async () => {
  const requestedBlocks = [];
  const client = new RobinhoodRpcClient({
    fetchImpl: async (_url, options) => {
      const request = JSON.parse(options.body);
      assert.equal(request.method, 'eth_getBlockByNumber');
      const number = Number(BigInt(request.params[0]));
      requestedBlocks.push(number);
      return rpcResult(request, {
        number: request.params[0],
        timestamp: `0x${((number === 3 ? 4 : number) * 100).toString(16)}`
      });
    }
  });

  assert.equal(await client.findBlockByTimestamp(350, { lowBlock: 0, highBlock: 7 }), 3);
  assert.ok(requestedBlocks.length <= 5);
  assert.equal(await client.findBlockByTimestamp(400, { lowBlock: 0, highBlock: 7 }), 3);
  assert.equal(await client.findBlockNumberByTimestamp(9999, { lowBlock: 0, highBlock: 7 }), 7);
});

test('adapts log windows, expands after success, deduplicates, and stops at maxLogs', async () => {
  const spans = [];
  const client = new RobinhoodRpcClient({
    maxRetries: 2,
    sleep: async () => {
      assert.fail('range-limit retries should shrink without sleeping');
    },
    fetchImpl: async (_url, options) => {
      const request = JSON.parse(options.body);
      const filter = request.params[0];
      const from = Number(BigInt(filter.fromBlock));
      const to = Number(BigInt(filter.toBlock));
      const span = to - from + 1;
      spans.push(span);
      if (span === 8) return jsonResponse({ message: 'block range too large' }, 413);
      if (span > 2) {
        return jsonResponse({
          jsonrpc: '2.0',
          id: request.id,
          error: { code: -32000, message: 'query returned more than the allowed results' }
        });
      }
      const logs = [];
      for (let block = from; block <= to; block += 1) {
        logs.push({
          blockNumber: `0x${block.toString(16)}`,
          transactionHash: `0x${block.toString(16).padStart(64, '0')}`,
          logIndex: '0x0',
          address: '0x1111111111111111111111111111111111111111',
          data: '0x'
        });
      }
      if (from > 0) logs.push({ ...logs[0] });
      return rpcResult(request, logs);
    }
  });

  const logs = await client.getLogs(
    { address: '0x1111111111111111111111111111111111111111', fromBlock: 0, toBlock: 9 },
    { initialWindow: 8, minWindow: 2, maxWindow: 8, maxLogs: 5 }
  );

  assert.deepEqual(spans.slice(0, 3), [8, 4, 2]);
  assert.ok(spans.includes(4), 'a successful two-block request should expand back to four blocks');
  assert.equal(logs.length, 5);
  assert.deepEqual(
    logs.map((log) => Number(BigInt(log.blockNumber))),
    [0, 1, 2, 3, 4]
  );
});

test('retries -32000 normally after an adaptive scan reaches its minimum window', async () => {
  let attempts = 0;
  let sleeps = 0;
  const client = new RobinhoodRpcClient({
    maxRetries: 1,
    retryDelayMs: 0,
    sleep: async () => {
      sleeps += 1;
    },
    fetchImpl: async (_url, options) => {
      const request = JSON.parse(options.body);
      attempts += 1;
      if (attempts === 1) {
        return jsonResponse({ jsonrpc: '2.0', id: request.id, error: { code: -32000, message: 'busy' } });
      }
      return rpcResult(request, []);
    }
  });

  assert.deepEqual(
    await client.getLogs({ fromBlock: 5, toBlock: 5 }, { initialWindow: 1, minWindow: 1, maxWindow: 1 }),
    []
  );
  assert.equal(attempts, 2);
  assert.equal(sleeps, 1);
});

test('honors an aborted signal before fetching logs', async () => {
  const controller = new AbortController();
  controller.abort(new Error('stop'));
  let fetched = false;
  const client = new RobinhoodRpcClient({
    fetchImpl: async () => {
      fetched = true;
      throw new Error('should not fetch');
    }
  });

  await assert.rejects(
    client.getLogs({ fromBlock: 0, toBlock: 10 }, { signal: controller.signal }),
    (error) => error instanceof RobinhoodRpcError && error.kind === 'aborted' && error.retryable === false
  );
  assert.equal(fetched, false);
});

test('batch transaction and receipt lookups preserve input order across reversed responses', async () => {
  const batches = [];
  const client = new RobinhoodRpcClient({
    batchSize: 2,
    fetchImpl: async (_url, options) => {
      const requests = JSON.parse(options.body);
      batches.push(requests.map((request) => request.method));
      return jsonResponse(
        requests
          .map((request) => ({
            jsonrpc: '2.0',
            id: request.id,
            result:
              request.method === 'eth_getTransactionByHash'
                ? { hash: request.params[0] }
                : { transactionHash: request.params[0], status: '0x1' }
          }))
          .reverse()
      );
    }
  });
  const hashes = ['0xaaa', '0xbbb', '0xccc'];

  const transactions = await client.getTransactionsByHashes(hashes);
  const receipts = await client.getTransactionReceipts(hashes);

  assert.deepEqual(transactions.map((transaction) => transaction.hash), hashes);
  assert.deepEqual(receipts.map((receipt) => receipt.transactionHash), hashes);
  assert.deepEqual(batches.map((batch) => batch.length), [2, 1, 2, 1]);
});

test('eth_call supports a block tag and optional state override', async () => {
  const stateOverride = { '0x1111111111111111111111111111111111111111': { balance: '0x1' } };
  const client = new RobinhoodRpcClient({
    fetchImpl: async (_url, options) => {
      const request = JSON.parse(options.body);
      assert.equal(request.method, 'eth_call');
      assert.deepEqual(request.params, [{ to: '0x1', data: '0x1234' }, '0xa', stateOverride]);
      return rpcResult(request, '0xfeed');
    }
  });

  assert.equal(
    await client.ethCall({ to: '0x1', data: '0x1234' }, { block: 10, stateOverride }),
    '0xfeed'
  );
});
