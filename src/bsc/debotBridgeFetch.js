const DEBOT_ORIGIN = 'https://debot.ai';
const ADDRESS_PATTERN = /^0x[0-9a-f]{40}$/;
const TOKEN_DETAIL_PATH = '/api/dashboard/token/detail';
const WALLET_TOKEN_ANALYSIS_PATH = '/api/dex/profit/wallet_token_analysis';
const TOKEN_HOLDER_PROFILE_PATH = '/api/token/profiler/tokenHolderList';

function requestUrl(input) {
  if (input instanceof URL) return input;
  if (typeof Request === 'function' && input instanceof Request) return new URL(input.url);
  return new URL(String(input));
}

function requestMethod(input, init) {
  return String(init?.method || (typeof Request === 'function' && input instanceof Request ? input.method : 'GET'))
    .trim()
    .toUpperCase();
}

function hasOnlyParameters(url, expected) {
  const keys = [...url.searchParams.keys()];
  return keys.length === expected.length &&
    expected.every((key) => keys.filter((candidate) => candidate === key).length === 1);
}

function loopbackBridgeUrl(value) {
  const url = new URL(String(value || 'http://127.0.0.1:18118/internal/debot/request'));
  const hostname = url.hostname.toLowerCase().replace(/^\[|\]$/g, '');
  if (url.protocol !== 'http:' || !['127.0.0.1', 'localhost', '::1'].includes(hostname)) {
    throw new TypeError('BSC DeBot bridge URL must be a loopback HTTP endpoint');
  }
  if (url.username || url.password || url.search || url.hash || url.pathname !== '/internal/debot/request') {
    throw new TypeError('BSC DeBot bridge URL must use the fixed internal request path');
  }
  return url.href;
}

export function bscDebotBridgeRequest(input, init = {}) {
  let url;
  try {
    url = requestUrl(input);
  } catch {
    return null;
  }
  if (requestMethod(input, init) !== 'GET' || url.origin !== DEBOT_ORIGIN) return null;
  const chain = String(url.searchParams.get('chain') || '').trim().toLowerCase();
  const token = String(url.searchParams.get('token') || '').trim().toLowerCase();
  if (chain !== 'bsc' || !ADDRESS_PATTERN.test(token)) return null;

  if (url.pathname === TOKEN_DETAIL_PATH && hasOnlyParameters(url, ['chain', 'token'])) {
    return { type: 'debot.token_detail.v1', payload: { chain, token }, bridgeRequired: false };
  }

  const wallet = String(url.searchParams.get('wallet') || '').trim().toLowerCase();
  if (
    url.pathname === WALLET_TOKEN_ANALYSIS_PATH &&
    hasOnlyParameters(url, ['chain', 'token', 'wallet']) &&
    ADDRESS_PATTERN.test(wallet)
  ) {
    return {
      type: 'debot.wallet_token_analysis.v1',
      payload: { chain, token, wallet },
      bridgeRequired: false
    };
  }

  const pageSize = Number(url.searchParams.get('page_size'));
  if (
    url.pathname === TOKEN_HOLDER_PROFILE_PATH &&
    hasOnlyParameters(url, ['chain', 'token', 'page_size', 'sort_field', 'sort_order']) &&
    url.searchParams.get('sort_field') === 'position' &&
    url.searchParams.get('sort_order') === 'desc' &&
    Number.isInteger(pageSize) && pageSize >= 1 && pageSize <= 100
  ) {
    return {
      type: 'debot.token_holders.v1',
      payload: { chain, token, pageSize },
      bridgeRequired: true
    };
  }
  return null;
}

const RESULT_SCHEMAS = Object.freeze({
  'debot.token_holders.v1': 'debot.token_holders.raw.v1',
  'debot.token_detail.v1': 'debot.token_detail.raw.v1',
  'debot.wallet_token_analysis.v1': 'debot.wallet_token_analysis.raw.v1'
});

export function validateBscDebotBridgeResponse(body, request) {
  const result = body?.result;
  const expectedSchema = RESULT_SCHEMAS[request?.type];
  if (!expectedSchema) throw new Error('BSC DeBot bridge returned a result for an unsupported request type');
  if (body?.ok !== true || result?.schema !== expectedSchema) {
    throw new Error('BSC DeBot bridge returned an unexpected result schema');
  }
  const data = result.data;
  if (!data || typeof data !== 'object' || Array.isArray(data)) {
    throw new Error('BSC DeBot bridge returned an invalid data object');
  }
  const chain = String(data.chain || data.token?.meta?.chain || data.pair?.chain || '').trim().toLowerCase();
  const token = String(data.token?.meta?.address || data.pair?.tokenAddress || data.token || '').trim().toLowerCase();
  if (chain !== request.payload.chain || token !== request.payload.token) {
    throw new Error('BSC DeBot bridge returned data for another chain or token');
  }
  if (request.payload.wallet) {
    const wallet = String(data.wallet || '').trim().toLowerCase();
    if (wallet !== request.payload.wallet) {
      throw new Error('BSC DeBot bridge returned data for another wallet');
    }
  }
  return data;
}

function jsonResponse(data) {
  return new Response(JSON.stringify({ code: 0, data }), {
    status: 200,
    headers: {
      'content-type': 'application/json; charset=utf-8',
      'cache-control': 'no-store',
      'x-debot-source': 'browser-bridge'
    }
  });
}

export function createBscDebotBridgeFetch({
  bridgeUrl = 'http://127.0.0.1:18118/internal/debot/request',
  fetchImpl = globalThis.fetch,
  timeoutMs = 90_000
} = {}) {
  if (typeof fetchImpl !== 'function') throw new TypeError('fetchImpl is required');
  const endpoint = loopbackBridgeUrl(bridgeUrl);
  const waitMs = Math.max(5_000, Math.min(110_000, Number(timeoutMs) || 90_000));

  return async function bscDebotBridgeFetch(input, init = {}) {
    const request = bscDebotBridgeRequest(input, init);
    if (!request) return fetchImpl(input, init);
    if (!request.bridgeRequired) return fetchImpl(input, init);

    try {
      const timeoutSignal = AbortSignal.timeout(waitMs);
      const signal = init?.signal ? AbortSignal.any([init.signal, timeoutSignal]) : timeoutSignal;
      const response = await fetchImpl(endpoint, {
        method: 'POST',
        signal,
        headers: {
          accept: 'application/json',
          'content-type': 'application/json'
        },
        body: JSON.stringify({ type: request.type, payload: request.payload })
      });
      if (!response.ok) throw new Error(`BSC DeBot bridge failed with HTTP ${response.status}`);
      return jsonResponse(validateBscDebotBridgeResponse(await response.json(), request));
    } catch (bridgeError) {
      if (init?.signal?.aborted || bridgeError?.name === 'AbortError') throw bridgeError;
      const error = new Error(
        'BSC Holder analysis requires the signed-in DeBot browser bridge to be online',
        bridgeError instanceof Error ? { cause: bridgeError } : undefined
      );
      error.code = 'BSC_DEBOT_HOLDER_BRIDGE_UNAVAILABLE';
      error.retryable = false;
      throw error;
    }
  };
}
