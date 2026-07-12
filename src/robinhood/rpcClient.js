export const ROBINHOOD_RPC_URL = 'https://rpc.mainnet.chain.robinhood.com';

const BLOCK_TAGS = new Set(['latest', 'earliest', 'pending', 'safe', 'finalized']);
const RESULT_LIMIT_PATTERN =
  /too many|more than|result(?:s)? (?:size|limit|window)|response (?:size|limit)|block range|range (?:is )?too (?:large|wide)|limit exceeded|exceed(?:s|ed)? (?:the )?(?:maximum|max)|please limit|query returned/i;

function asPositiveInteger(value, fallback, minimum = 1) {
  const number = Number(value);
  if (!Number.isFinite(number)) return fallback;
  return Math.max(minimum, Math.floor(number));
}

function throwIfAborted(signal, method) {
  if (!signal?.aborted) return;
  throw new RobinhoodRpcError(`RPC ${method} was aborted`, {
    kind: 'aborted',
    method,
    retryable: false,
    cause: signal.reason instanceof Error ? signal.reason : undefined
  });
}

function toBlockTag(value, label = 'block') {
  if (typeof value === 'string') {
    const normalized = value.toLowerCase();
    if (BLOCK_TAGS.has(normalized)) return normalized;
    if (/^0x[0-9a-f]+$/i.test(value)) return `0x${BigInt(value).toString(16)}`;
    if (/^\d+$/.test(value)) return `0x${BigInt(value).toString(16)}`;
  }
  if (typeof value === 'number' && Number.isSafeInteger(value) && value >= 0) {
    return `0x${value.toString(16)}`;
  }
  if (typeof value === 'bigint' && value >= 0n) return `0x${value.toString(16)}`;
  throw new TypeError(`${label} must be a non-negative block number or a valid block tag`);
}

function fromRpcQuantity(value, label) {
  if (typeof value !== 'string' || !/^0x[0-9a-f]+$/i.test(value)) {
    throw new RobinhoodRpcError(`RPC returned an invalid ${label}`, {
      kind: 'invalid-response',
      retryable: false
    });
  }
  const number = Number(BigInt(value));
  if (!Number.isSafeInteger(number)) {
    throw new RobinhoodRpcError(`RPC returned an unsafe ${label}`, {
      kind: 'invalid-response',
      retryable: false
    });
  }
  return number;
}

function normalizeTimestamp(value) {
  const number = value instanceof Date ? value.getTime() / 1000 : Number(value);
  if (!Number.isFinite(number) || number < 0) throw new TypeError('timestamp must be a non-negative Unix timestamp');
  return Math.floor(number > 10_000_000_000 ? number / 1000 : number);
}

function retryAfterMs(response) {
  const value = response?.headers?.get?.('retry-after');
  if (!value) return null;
  const seconds = Number(value);
  if (Number.isFinite(seconds) && seconds >= 0) return Math.round(seconds * 1000);
  const date = Date.parse(value);
  return Number.isFinite(date) ? Math.max(0, date - Date.now()) : null;
}

function rpcMessage(body, fallback) {
  if (typeof body?.error?.message === 'string') return body.error.message;
  if (typeof body?.message === 'string') return body.message;
  if (typeof body === 'string' && body.trim()) return body.trim();
  return fallback;
}

function isTimeoutLike(error) {
  return error?.name === 'TimeoutError' || /timed? ?out|timeout/i.test(String(error?.message || ''));
}

function logKey(log) {
  return [
    log?.blockHash || log?.blockNumber || '',
    log?.transactionHash || log?.transactionIndex || '',
    log?.logIndex ?? '',
    log?.address || '',
    log?.data || ''
  ]
    .map((part) => String(part).toLowerCase())
    .join(':');
}

async function readResponseBody(response) {
  if (typeof response?.text === 'function') {
    const text = await response.text();
    if (!text) return null;
    try {
      return JSON.parse(text);
    } catch {
      return text;
    }
  }
  if (typeof response?.json === 'function') return response.json();
  return null;
}

function defaultSleep(ms, { signal } = {}) {
  if (ms <= 0) return Promise.resolve();
  return new Promise((resolve, reject) => {
    const timer = setTimeout(done, ms);
    function done() {
      signal?.removeEventListener('abort', aborted);
      resolve();
    }
    function aborted() {
      clearTimeout(timer);
      signal?.removeEventListener('abort', aborted);
      reject(signal.reason instanceof Error ? signal.reason : new Error('Aborted'));
    }
    if (signal?.aborted) aborted();
    else signal?.addEventListener('abort', aborted, { once: true });
  });
}

export class RobinhoodRpcError extends Error {
  constructor(
    message,
    {
      kind = 'rpc',
      code = null,
      status = null,
      method = null,
      data = null,
      retryable = false,
      retryAfterMs: retryDelay = null,
      cause
    } = {}
  ) {
    super(message, cause ? { cause } : undefined);
    this.name = 'RobinhoodRpcError';
    this.kind = kind;
    this.code = code;
    this.status = status;
    this.method = method;
    this.data = data;
    this.retryable = Boolean(retryable);
    this.retryAfterMs = retryDelay;
  }
}

export function isLogRangeError(error) {
  if (!(error instanceof RobinhoodRpcError)) return false;
  return error.code === -32000 || error.code === -32005 || RESULT_LIMIT_PATTERN.test(error.message);
}

export function isRetryableRpcError(error) {
  return error instanceof RobinhoodRpcError && error.retryable;
}

export class RobinhoodRpcClient {
  constructor({
    rpcUrl = ROBINHOOD_RPC_URL,
    timeoutMs = 20_000,
    maxRetries = 3,
    retryDelayMs = 250,
    maxRetryDelayMs = 4_000,
    logWindow = 20_000,
    minLogWindow = 10,
    maxLogWindow = 100_000,
    batchSize = 50,
    batchDelayMs = 0,
    fetchImpl = globalThis.fetch,
    sleep = defaultSleep
  } = {}) {
    if (typeof fetchImpl !== 'function') throw new TypeError('fetchImpl must be a function');
    if (typeof sleep !== 'function') throw new TypeError('sleep must be a function');
    this.rpcUrl = String(rpcUrl || ROBINHOOD_RPC_URL);
    this.timeoutMs = Math.max(0, Number(timeoutMs) || 0);
    this.maxRetries = Math.max(0, Math.floor(Number(maxRetries) || 0));
    this.retryDelayMs = Math.max(0, Number(retryDelayMs) || 0);
    this.maxRetryDelayMs = Math.max(this.retryDelayMs, Number(maxRetryDelayMs) || 0);
    this.logWindow = asPositiveInteger(logWindow, 20_000);
    this.minLogWindow = asPositiveInteger(minLogWindow, 10);
    this.maxLogWindow = Math.max(this.logWindow, asPositiveInteger(maxLogWindow, 100_000));
    this.batchSize = asPositiveInteger(batchSize, 50);
    this.batchDelayMs = Math.max(0, Number(batchDelayMs) || 0);
    this.fetchImpl = fetchImpl;
    this.sleep = sleep;
    this.nextId = 1;
  }

  async request(method, params = [], { signal, maxRetries = this.maxRetries, retryPredicate, timeoutMs } = {}) {
    if (typeof method !== 'string' || !method) throw new TypeError('method is required');
    const id = this.nextId++;
    const payload = { jsonrpc: '2.0', id, method, params };
    return this._withRetries(
      async () => {
        const body = await this._post(payload, { method, signal, timeoutMs });
        if (!body || Array.isArray(body) || typeof body !== 'object') {
          throw new RobinhoodRpcError(`RPC ${method} returned an invalid response`, {
            kind: 'invalid-response',
            method,
            retryable: true
          });
        }
        if (body.error) throw this._rpcError(body.error, method);
        if (String(body.id) !== String(id) || !Object.hasOwn(body, 'result')) {
          throw new RobinhoodRpcError(`RPC ${method} returned a mismatched response`, {
            kind: 'invalid-response',
            method,
            retryable: true
          });
        }
        return body.result;
      },
      { method, signal, maxRetries, retryPredicate }
    );
  }

  async batchRequest(calls, { signal, maxRetries = this.maxRetries, retryPredicate, timeoutMs } = {}) {
    if (!Array.isArray(calls) || calls.length === 0) return [];
    const payload = calls.map((call) => {
      if (typeof call?.method !== 'string' || !call.method) throw new TypeError('Each batch call requires a method');
      return { jsonrpc: '2.0', id: this.nextId++, method: call.method, params: call.params || [] };
    });
    const method = `batch:${[...new Set(payload.map((item) => item.method))].join(',')}`;
    return this._withRetries(
      async () => {
        const body = await this._post(payload, { method, signal, timeoutMs });
        if (!Array.isArray(body)) {
          throw new RobinhoodRpcError('RPC batch returned an invalid response', {
            kind: 'invalid-response',
            method,
            retryable: true
          });
        }
        const byId = new Map(body.map((item) => [String(item?.id), item]));
        return payload.map((call, index) => {
          const item = byId.get(String(call.id));
          if (!item) {
            throw new RobinhoodRpcError(`RPC batch response is missing item ${index}`, {
              kind: 'invalid-response',
              method: call.method,
              retryable: true
            });
          }
          if (item.error) {
            const error = this._rpcError(item.error, call.method);
            error.batchIndex = index;
            throw error;
          }
          if (!Object.hasOwn(item, 'result')) {
            throw new RobinhoodRpcError(`RPC batch item ${index} has no result`, {
              kind: 'invalid-response',
              method: call.method,
              retryable: true
            });
          }
          return item.result;
        });
      },
      { method, signal, maxRetries, retryPredicate }
    );
  }

  async getBlockNumber({ signal } = {}) {
    return fromRpcQuantity(await this.request('eth_blockNumber', [], { signal }), 'block number');
  }

  async getBlockByNumber(blockNumber, { includeTransactions = false, signal } = {}) {
    return this.request('eth_getBlockByNumber', [toBlockTag(blockNumber), Boolean(includeTransactions)], { signal });
  }

  async getBlocksByNumbers(blockNumbers, { includeTransactions = false, batchSize = this.batchSize, signal } = {}) {
    if (!Array.isArray(blockNumbers)) throw new TypeError('blockNumbers must be an array');
    const size = asPositiveInteger(batchSize, this.batchSize);
    const results = [];
    for (let index = 0; index < blockNumbers.length; index += size) {
      throwIfAborted(signal, 'eth_getBlockByNumber');
      const chunk = blockNumbers.slice(index, index + size);
      const values = await this.batchRequest(chunk.map((blockNumber) => ({
        method: 'eth_getBlockByNumber',
        params: [toBlockTag(blockNumber), Boolean(includeTransactions)]
      })), { signal });
      results.push(...values);
      if (index + size < blockNumbers.length && this.batchDelayMs > 0) {
        await this.sleep(this.batchDelayMs, { signal });
      }
    }
    return results;
  }

  async findBlockByTimestamp(timestamp, { lowBlock = 0, highBlock, signal } = {}) {
    const target = normalizeTimestamp(timestamp);
    let low = fromBlockInput(lowBlock, 'lowBlock');
    let high = highBlock === undefined ? await this.getBlockNumber({ signal }) : fromBlockInput(highBlock, 'highBlock');
    if (low > high) throw new RangeError('lowBlock cannot be greater than highBlock');

    const [lowData, highData] = await Promise.all([
      this.getBlockByNumber(low, { signal }),
      low === high ? Promise.resolve(null) : this.getBlockByNumber(high, { signal })
    ]);
    const lowTimestamp = blockTimestamp(lowData);
    if (target <= lowTimestamp || low === high) return low;
    const highTimestamp = blockTimestamp(highData);
    if (target > highTimestamp) return high;

    while (low < high) {
      throwIfAborted(signal, 'eth_getBlockByNumber');
      const middle = low + Math.floor((high - low) / 2);
      const block = await this.getBlockByNumber(middle, { signal });
      if (blockTimestamp(block) < target) low = middle + 1;
      else high = middle;
    }
    return low;
  }

  async findBlockNumberByTimestamp(timestamp, options) {
    return this.findBlockByTimestamp(timestamp, options);
  }

  async getLogs(
    filter,
    {
      signal,
      initialWindow = this.logWindow,
      minWindow = this.minLogWindow,
      maxWindow = this.maxLogWindow,
      maxLogs = Infinity,
      maxRetries = this.maxRetries
    } = {}
  ) {
    if (!filter || typeof filter !== 'object') throw new TypeError('filter is required');
    throwIfAborted(signal, 'eth_getLogs');
    const limit = maxLogs === Infinity ? Infinity : Math.max(0, Math.floor(Number(maxLogs) || 0));
    if (limit === 0) return [];
    const { fromBlock = 0, toBlock = 'latest', blockHash, ...baseFilter } = filter;

    if (blockHash) {
      const rows = await this.request('eth_getLogs', [{ ...baseFilter, blockHash }], { signal, maxRetries });
      if (!Array.isArray(rows)) throw invalidLogsResponse();
      return dedupeLogs(rows).slice(0, limit);
    }

    let cursor = await this._resolveBlockNumber(fromBlock, { signal, label: 'fromBlock' });
    const finalBlock = await this._resolveBlockNumber(toBlock, { signal, label: 'toBlock' });
    if (cursor > finalBlock) return [];

    const smallestWindow = asPositiveInteger(minWindow, this.minLogWindow);
    const largestWindow = Math.max(smallestWindow, asPositiveInteger(maxWindow, this.maxLogWindow));
    let window = Math.min(largestWindow, Math.max(smallestWindow, asPositiveInteger(initialWindow, this.logWindow)));
    const logs = [];
    const seen = new Set();

    while (cursor <= finalBlock) {
      throwIfAborted(signal, 'eth_getLogs');
      const end = Math.min(finalBlock, cursor + window - 1);
      let rows;
      try {
        rows = await this.request(
          'eth_getLogs',
          [{ ...baseFilter, fromBlock: toBlockTag(cursor), toBlock: toBlockTag(end) }],
          {
            signal,
            maxRetries,
            retryPredicate: (error) =>
              error.retryable && (!isLogRangeError(error) || window <= smallestWindow)
          }
        );
        if (!Array.isArray(rows)) throw invalidLogsResponse();
      } catch (error) {
        if ((isRetryableRpcError(error) || isLogRangeError(error)) && window > smallestWindow) {
          window = Math.max(smallestWindow, Math.floor(window / 2));
          continue;
        }
        throw error;
      }

      for (const log of rows) {
        const key = logKey(log);
        if (seen.has(key)) continue;
        seen.add(key);
        logs.push(log);
        if (logs.length >= limit) return logs;
      }
      cursor = end + 1;
      window = Math.min(largestWindow, window * 2);
    }
    return logs;
  }

  async getTransactionByHash(hash, { signal } = {}) {
    return this.request('eth_getTransactionByHash', [hash], { signal });
  }

  async getTransactionReceipt(hash, { signal } = {}) {
    return this.request('eth_getTransactionReceipt', [hash], { signal });
  }

  async getTransactionsByHashes(hashes, options = {}) {
    return this._batchByHash('eth_getTransactionByHash', hashes, options);
  }

  async getTransactionReceipts(hashes, options = {}) {
    return this._batchByHash('eth_getTransactionReceipt', hashes, options);
  }

  async batchGetTransactions(hashes, options = {}) {
    return this.getTransactionsByHashes(hashes, options);
  }

  async batchGetReceipts(hashes, options = {}) {
    return this.getTransactionReceipts(hashes, options);
  }

  async call(transaction, { block = 'latest', stateOverride, signal } = {}) {
    const params = [transaction, toBlockTag(block)];
    if (stateOverride !== undefined) params.push(stateOverride);
    return this.request('eth_call', params, { signal });
  }

  async ethCall(transaction, options = {}) {
    return this.call(transaction, options);
  }

  async _batchByHash(method, hashes, { batchSize = this.batchSize, signal } = {}) {
    if (!Array.isArray(hashes)) throw new TypeError('hashes must be an array');
    const size = asPositiveInteger(batchSize, this.batchSize);
    const results = [];
    for (let index = 0; index < hashes.length; index += size) {
      throwIfAborted(signal, method);
      const chunk = hashes.slice(index, index + size);
      const values = await this.batchRequest(
        chunk.map((hash) => ({ method, params: [hash] })),
        { signal }
      );
      results.push(...values);
      if (index + size < hashes.length && this.batchDelayMs > 0) {
        await this.sleep(this.batchDelayMs, { signal });
      }
    }
    return results;
  }

  async _resolveBlockNumber(value, { signal, label }) {
    const tag = toBlockTag(value, label);
    if (tag === 'earliest') return 0;
    if (tag === 'latest') return this.getBlockNumber({ signal });
    if (/^0x/i.test(tag)) return fromRpcQuantity(tag, label);
    const block = await this.getBlockByNumber(tag, { signal });
    if (!block) throw new RobinhoodRpcError(`RPC could not resolve ${label} tag ${tag}`, { kind: 'rpc', retryable: true });
    return fromRpcQuantity(block.number, label);
  }

  async _withRetries(operation, { method, signal, maxRetries, retryPredicate } = {}) {
    const retries = Math.max(0, Math.floor(Number(maxRetries) || 0));
    let attempt = 0;
    while (true) {
      throwIfAborted(signal, method);
      try {
        return await operation();
      } catch (rawError) {
        const error =
          rawError instanceof RobinhoodRpcError
            ? rawError
            : new RobinhoodRpcError(`RPC ${method} failed: ${rawError?.message || 'unknown error'}`, {
                kind: 'network',
                method,
                retryable: true,
                cause: rawError instanceof Error ? rawError : undefined
              });
        const canRetry = retryPredicate ? retryPredicate(error) : error.retryable;
        if (!canRetry || attempt >= retries) throw error;
        const exponentialDelay = Math.min(this.maxRetryDelayMs, this.retryDelayMs * 2 ** attempt);
        const delay = error.retryAfterMs ?? exponentialDelay;
        try {
          await this.sleep(delay, { signal });
        } catch (sleepError) {
          if (signal?.aborted) throwIfAborted(signal, method);
          throw sleepError;
        }
        attempt += 1;
      }
    }
  }

  async _post(payload, { method, signal, timeoutMs = this.timeoutMs } = {}) {
    throwIfAborted(signal, method);
    const timeoutController = new AbortController();
    const duration = Math.max(0, Number(timeoutMs) || 0);
    const timer = duration
      ? setTimeout(() => timeoutController.abort(new DOMException(`RPC timed out after ${duration}ms`, 'TimeoutError')), duration)
      : null;
    const requestSignal = signal ? AbortSignal.any([signal, timeoutController.signal]) : timeoutController.signal;
    let response;
    try {
      response = await this.fetchImpl(this.rpcUrl, {
        method: 'POST',
        headers: { accept: 'application/json', 'content-type': 'application/json' },
        body: JSON.stringify(payload),
        signal: requestSignal
      });
    } catch (error) {
      if (timer) clearTimeout(timer);
      if (signal?.aborted) throwIfAborted(signal, method);
      if (timeoutController.signal.aborted || isTimeoutLike(error)) {
        throw new RobinhoodRpcError(`RPC ${method} timed out`, {
          kind: 'timeout',
          method,
          retryable: true,
          cause: error instanceof Error ? error : undefined
        });
      }
      throw new RobinhoodRpcError(`RPC ${method} network request failed: ${error?.message || 'unknown error'}`, {
        kind: 'network',
        method,
        retryable: true,
        cause: error instanceof Error ? error : undefined
      });
    }

    const status = Number(response?.status) || null;
    const failedHttp = response?.ok === false || (status !== null && status >= 400);
    let body;
    try {
      body = await readResponseBody(response);
    } catch (error) {
      if (timer) clearTimeout(timer);
      if (signal?.aborted) throwIfAborted(signal, method);
      if (timeoutController.signal.aborted || isTimeoutLike(error)) {
        throw new RobinhoodRpcError(`RPC ${method} timed out`, {
          kind: 'timeout',
          method,
          retryable: true,
          cause: error instanceof Error ? error : undefined
        });
      }
      if (!failedHttp) {
        throw new RobinhoodRpcError(`RPC ${method} returned unreadable JSON`, {
          kind: 'invalid-response',
          status,
          method,
          retryable: true,
          cause: error instanceof Error ? error : undefined
        });
      }
    }
    if (timer) clearTimeout(timer);
    if (failedHttp) {
      throw new RobinhoodRpcError(rpcMessage(body, `RPC ${method} failed with HTTP ${status}`), {
        kind: 'http',
        status,
        method,
        data: body,
        retryable: status === 408 || status === 425 || status === 429 || status >= 500,
        retryAfterMs: retryAfterMs(response)
      });
    }
    if (body === null || typeof body === 'string') {
      throw new RobinhoodRpcError(`RPC ${method} returned invalid JSON`, {
        kind: 'invalid-response',
        status,
        method,
        data: body,
        retryable: true
      });
    }
    return body;
  }

  _rpcError(raw, method) {
    const numericCode = Number(raw?.code);
    const code = Number.isFinite(numericCode) ? numericCode : raw?.code ?? null;
    const message = String(raw?.message || 'JSON-RPC request failed');
    const retryable =
      code === -32000 || code === -32005 || code === -32603 || RESULT_LIMIT_PATTERN.test(message);
    return new RobinhoodRpcError(`RPC ${method} failed: ${message}`, {
      kind: 'rpc',
      code,
      method,
      data: raw?.data ?? null,
      retryable
    });
  }
}

function fromBlockInput(value, label) {
  const tag = toBlockTag(value, label);
  if (!/^0x/i.test(tag)) throw new TypeError(`${label} must be an explicit block number`);
  return fromRpcQuantity(tag, label);
}

function blockTimestamp(block) {
  if (!block) {
    throw new RobinhoodRpcError('RPC returned no block while resolving a timestamp', {
      kind: 'invalid-response',
      retryable: true
    });
  }
  return fromRpcQuantity(block.timestamp, 'block timestamp');
}

function invalidLogsResponse() {
  return new RobinhoodRpcError('RPC eth_getLogs returned a non-array result', {
    kind: 'invalid-response',
    method: 'eth_getLogs',
    retryable: true
  });
}

function dedupeLogs(rows) {
  const seen = new Set();
  return rows.filter((log) => {
    const key = logKey(log);
    if (seen.has(key)) return false;
    seen.add(key);
    return true;
  });
}
