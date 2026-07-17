import { normalizeSolanaAddress } from './address.js';

export const SOLANA_PUBLIC_RPC_URL = 'https://api.mainnet-beta.solana.com';

function boundedInteger(value, fallback, minimum, maximum) {
  const number = Number(value);
  if (!Number.isFinite(number)) return fallback;
  return Math.max(minimum, Math.min(maximum, Math.floor(number)));
}

function retryAfterMs(response) {
  const value = response?.headers?.get?.('retry-after');
  if (!value) return null;
  const seconds = Number(value);
  if (Number.isFinite(seconds) && seconds >= 0) return Math.round(seconds * 1_000);
  const date = Date.parse(value);
  return Number.isFinite(date) ? Math.max(0, date - Date.now()) : null;
}

function throwIfAborted(signal, method) {
  if (!signal?.aborted) return;
  throw new SolanaRpcError(`Solana RPC ${method} was aborted`, {
    kind: 'aborted',
    method,
    retryable: false,
    cause: signal.reason instanceof Error ? signal.reason : undefined
  });
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

async function readTextWithLimit(response, maximumBytes, method) {
  const declared = Number(response?.headers?.get?.('content-length'));
  if (Number.isFinite(declared) && declared > maximumBytes) {
    throw new SolanaRpcError(`Solana RPC ${method} response exceeds ${maximumBytes} bytes`, {
      kind: 'response-too-large',
      method,
      retryable: false
    });
  }

  if (!response?.body?.getReader) {
    const text = await response.text();
    if (Buffer.byteLength(text) > maximumBytes) {
      throw new SolanaRpcError(`Solana RPC ${method} response exceeds ${maximumBytes} bytes`, {
        kind: 'response-too-large',
        method,
        retryable: false
      });
    }
    return text;
  }

  const reader = response.body.getReader();
  const decoder = new TextDecoder();
  let size = 0;
  let text = '';
  while (true) {
    const { done, value } = await reader.read();
    if (done) break;
    size += value.byteLength;
    if (size > maximumBytes) {
      await reader.cancel().catch(() => {});
      throw new SolanaRpcError(`Solana RPC ${method} response exceeds ${maximumBytes} bytes`, {
        kind: 'response-too-large',
        method,
        retryable: false
      });
    }
    text += decoder.decode(value, { stream: true });
  }
  return text + decoder.decode();
}

export class SolanaRpcError extends Error {
  constructor(message, {
    kind = 'rpc',
    code = null,
    status = null,
    method = null,
    data = null,
    retryable = false,
    retryAfterMs: retryDelay = null,
    cause
  } = {}) {
    super(message, cause ? { cause } : undefined);
    this.name = 'SolanaRpcError';
    this.kind = kind;
    this.code = code;
    this.status = status;
    this.method = method;
    this.data = data;
    this.retryable = Boolean(retryable);
    this.retryAfterMs = retryDelay;
  }
}

export class SolanaRpcClient {
  constructor({
    rpcUrl = SOLANA_PUBLIC_RPC_URL,
    timeoutMs = 20_000,
    maxRetries = 3,
    retryDelayMs = 500,
    maxRetryDelayMs = 8_000,
    maxResponseBytes = 16 * 1024 * 1024,
    fetchImpl = globalThis.fetch,
    sleep = defaultSleep
  } = {}) {
    if (typeof fetchImpl !== 'function') throw new TypeError('fetchImpl must be a function');
    if (typeof sleep !== 'function') throw new TypeError('sleep must be a function');
    this.rpcUrl = String(rpcUrl || SOLANA_PUBLIC_RPC_URL);
    this.timeoutMs = boundedInteger(timeoutMs, 20_000, 250, 120_000);
    this.maxRetries = boundedInteger(maxRetries, 3, 0, 12);
    this.retryDelayMs = boundedInteger(retryDelayMs, 500, 0, 60_000);
    this.maxRetryDelayMs = boundedInteger(maxRetryDelayMs, 8_000, this.retryDelayMs, 120_000);
    this.maxResponseBytes = boundedInteger(maxResponseBytes, 16 * 1024 * 1024, 1_024, 256 * 1024 * 1024);
    this.fetchImpl = fetchImpl;
    this.sleep = sleep;
    this.nextId = 1;
  }

  async request(method, params = [], {
    signal,
    maxRetries = this.maxRetries,
    timeoutMs = this.timeoutMs,
    maxResponseBytes = this.maxResponseBytes
  } = {}) {
    if (typeof method !== 'string' || !method) throw new TypeError('method is required');
    const id = this.nextId++;
    let lastError;
    for (let attempt = 0; attempt <= maxRetries; attempt += 1) {
      throwIfAborted(signal, method);
      try {
        const timeoutSignal = AbortSignal.timeout(timeoutMs);
        const combined = signal ? AbortSignal.any([signal, timeoutSignal]) : timeoutSignal;
        const response = await this.fetchImpl(this.rpcUrl, {
          method: 'POST',
          signal: combined,
          headers: { accept: 'application/json', 'content-type': 'application/json' },
          body: JSON.stringify({ jsonrpc: '2.0', id, method, params })
        });
        const text = await readTextWithLimit(response, maxResponseBytes, method);
        let body;
        try {
          body = text ? JSON.parse(text) : null;
        } catch (cause) {
          throw new SolanaRpcError(`Solana RPC ${method} returned invalid JSON`, {
            kind: 'invalid-response', method, retryable: response.status >= 500, cause
          });
        }
        if (!response.ok) {
          const delay = retryAfterMs(response);
          throw new SolanaRpcError(
            body?.error?.message || `Solana RPC ${method} failed with HTTP ${response.status}`,
            {
              kind: response.status === 429 ? 'rate-limit' : 'http',
              status: response.status,
              method,
              retryable: response.status === 429 || response.status >= 500,
              retryAfterMs: delay
            }
          );
        }
        if (!body || typeof body !== 'object' || Array.isArray(body) || String(body.id) !== String(id)) {
          throw new SolanaRpcError(`Solana RPC ${method} returned a mismatched response`, {
            kind: 'invalid-response', method, retryable: true
          });
        }
        if (body.error) {
          const code = Number(body.error.code);
          throw new SolanaRpcError(body.error.message || `Solana RPC ${method} failed`, {
            kind: code === -32005 ? 'rate-limit' : 'rpc',
            code: Number.isFinite(code) ? code : null,
            data: body.error.data,
            method,
            retryable: code === -32005 || code === -32004 || code === -32603
          });
        }
        if (!Object.hasOwn(body, 'result')) {
          throw new SolanaRpcError(`Solana RPC ${method} response has no result`, {
            kind: 'invalid-response', method, retryable: true
          });
        }
        return body.result;
      } catch (error) {
        lastError = error instanceof SolanaRpcError ? error : new SolanaRpcError(
          `Solana RPC ${method} request failed: ${error instanceof Error ? error.message : String(error)}`,
          {
            kind: error?.name === 'TimeoutError' ? 'timeout' : 'network',
            method,
            retryable: error?.name !== 'AbortError',
            cause: error instanceof Error ? error : undefined
          }
        );
        if (signal?.aborted || !lastError.retryable || attempt >= maxRetries) throw lastError;
        const exponential = Math.min(this.maxRetryDelayMs, this.retryDelayMs * (2 ** attempt));
        await this.sleep(lastError.retryAfterMs ?? exponential, { signal });
      }
    }
    throw lastError || new SolanaRpcError(`Solana RPC ${method} failed`, { method });
  }

  async getProgramAccountsForMint(programAddress, mintAddress, { signal, maxResponseBytes } = {}) {
    const program = normalizeSolanaAddress(programAddress);
    const mint = normalizeSolanaAddress(mintAddress);
    const rows = await this.request('getProgramAccounts', [program, {
      commitment: 'confirmed',
      encoding: 'base64',
      filters: [{ memcmp: { offset: 0, bytes: mint } }],
      dataSlice: { offset: 32, length: 40 }
    }], { signal, maxResponseBytes });
    if (!Array.isArray(rows)) {
      throw new SolanaRpcError('Solana RPC getProgramAccounts returned a non-array result', {
        kind: 'invalid-response', method: 'getProgramAccounts', retryable: false
      });
    }
    return rows;
  }

  async getTokenLargestAccounts(mintAddress, { signal } = {}) {
    const result = await this.request('getTokenLargestAccounts', [
      normalizeSolanaAddress(mintAddress),
      { commitment: 'confirmed' }
    ], { signal });
    if (!result || !Array.isArray(result.value)) {
      throw new SolanaRpcError('Solana RPC getTokenLargestAccounts returned an invalid result', {
        kind: 'invalid-response', method: 'getTokenLargestAccounts', retryable: false
      });
    }
    return result.value;
  }

  async getTokenSupply(mintAddress, { signal } = {}) {
    const result = await this.request('getTokenSupply', [
      normalizeSolanaAddress(mintAddress),
      { commitment: 'confirmed' }
    ], { signal });
    if (!result?.value || typeof result.value.amount !== 'string') {
      throw new SolanaRpcError('Solana RPC getTokenSupply returned an invalid result', {
        kind: 'invalid-response', method: 'getTokenSupply', retryable: false
      });
    }
    return result.value;
  }

  async getMultipleAccounts(addresses, { signal, encoding = 'jsonParsed' } = {}) {
    if (!Array.isArray(addresses) || addresses.length > 100) {
      throw new TypeError('getMultipleAccounts accepts at most 100 addresses');
    }
    const normalized = addresses.map(normalizeSolanaAddress);
    const result = await this.request('getMultipleAccounts', [normalized, {
      commitment: 'confirmed',
      encoding
    }], { signal });
    if (!result || !Array.isArray(result.value) || result.value.length !== normalized.length) {
      throw new SolanaRpcError('Solana RPC getMultipleAccounts returned an invalid result', {
        kind: 'invalid-response', method: 'getMultipleAccounts', retryable: false
      });
    }
    return result.value;
  }
}
