const DEBOT_ORIGIN = 'https://debot.ai';
const ADDRESS_PATTERN = /^0x[0-9a-f]{40}$/;
const TOKEN_DETAIL_PATH = '/api/dashboard/token/detail';
const WALLET_TOKEN_ANALYSIS_PATH = '/api/dex/profit/wallet_token_analysis';

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
  if (chain !== 'robinhood' || !ADDRESS_PATTERN.test(token)) return null;

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
  timeoutMs = 30_000
} = {}) {
  if (typeof fetchImpl !== 'function') throw new TypeError('fetchImpl is required');
  const bridgeRequest = socialService?.requestDeBot;

  return async function debotBridgeFetch(input, init = {}) {
    const request = debotBridgeRequest(input, init);
    if (!request || typeof bridgeRequest !== 'function') return fetchImpl(input, init);

    try {
      const result = await bridgeRequest.call(socialService, request.type, request.payload, {
        signal: init?.signal,
        timeoutMs,
        cacheTtlMs: request.cacheTtlMs
      });
      return jsonResponse(responseData(result));
    } catch (bridgeError) {
      if (init?.signal?.aborted || bridgeError?.name === 'AbortError') throw bridgeError;
      return fetchImpl(input, init);
    }
  };
}
