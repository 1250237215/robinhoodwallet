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
  return keys.length === expected.length && expected.every((key) => keys.filter((candidate) => candidate === key).length === 1);
}

export function debotBridgeRequest(input, init = {}) {
  let url;
  try {
    url = requestUrl(input);
  } catch {
    return null;
  }
  if (requestMethod(input, init) !== 'GET' || url.origin !== DEBOT_ORIGIN) return null;
  const chain = String(url.searchParams.get('chain') || '').trim().toLowerCase();
  const token = String(url.searchParams.get('token') || '').trim().toLowerCase();
  if (!['robinhood', 'base', 'bsc'].includes(chain) || !ADDRESS_PATTERN.test(token)) return null;

  if (url.pathname === TOKEN_DETAIL_PATH && hasOnlyParameters(url, ['chain', 'token'])) {
    return {
      type: 'debot.token_detail.v1',
      payload: { chain, token },
      cacheTtlMs: 60_000
    };
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
      cacheTtlMs: 30_000
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
    return { type: 'debot.token_holders.v1', payload: { chain, token, pageSize }, cacheTtlMs: 30_000 };
  }
  return null;
}

function responseData(result) {
  if (!result || typeof result !== 'object') throw new Error('DeBot browser bridge returned an invalid result');
  const data = result.data ?? result.result?.data ?? result.result ?? null;
  if (!data || typeof data !== 'object' || Array.isArray(data)) {
    throw new Error('DeBot browser bridge returned an invalid data object');
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

export function createDebotBridgeFetch({
  socialService,
  fetchImpl = globalThis.fetch,
  timeoutMs = 30_000,
  bridgeUrl = 'http://127.0.0.1:18118/internal/debot/request',
  bridgeRequired = false
} = {}) {
  if (typeof fetchImpl !== 'function') throw new TypeError('fetchImpl is required');
  const bridgeRequest = socialService?.requestDeBot;

  return async function debotBridgeFetch(input, init = {}) {
    const request = debotBridgeRequest(input, init);
    // Standalone chain services use bridgeUrl instead of an in-process
    // socialService. Only bypass the bridge for requests we do not recognize.
    if (!request) return fetchImpl(input, init);

    try {
      let result;
      if (typeof bridgeRequest === 'function') {
        result = await bridgeRequest.call(socialService, request.type, request.payload, {
          signal: init?.signal,
          timeoutMs,
          cacheTtlMs: request.cacheTtlMs
        });
      } else {
        const signal = init?.signal ? AbortSignal.any([init.signal, AbortSignal.timeout(timeoutMs)]) : AbortSignal.timeout(timeoutMs);
        const response = await fetchImpl(bridgeUrl, {
          method: 'POST', signal,
          headers: { accept: 'application/json', 'content-type': 'application/json' },
          body: JSON.stringify({ type: request.type, payload: request.payload })
        });
        if (!response.ok) throw new Error(`DeBot bridge failed with HTTP ${response.status}`);
        result = await response.json();
      }
      return jsonResponse(responseData(result));
    } catch (bridgeError) {
      if (init?.signal?.aborted || bridgeError?.name === 'AbortError') throw bridgeError;
      if (bridgeRequired) throw bridgeError;
      return fetchImpl(input, init);
    }
  };
}
