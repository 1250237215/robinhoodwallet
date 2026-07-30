import test from 'node:test';
import assert from 'node:assert/strict';

import {
  bscDebotBridgeRequest,
  createBscDebotBridgeFetch,
  validateBscDebotBridgeResponse
} from '../src/bsc/debotBridgeFetch.js';

const token = '0x1111111111111111111111111111111111111111';
const otherToken = '0x2222222222222222222222222222222222222222';
const wallet = '0xaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa';
const otherWallet = '0xbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb';

function envelope(schema, data) {
  return { ok: true, result: { schema, data } };
}

test('recognizes only the exact sorted BSC Holder request as bridge-required', () => {
  const exact = `https://debot.ai/api/token/profiler/tokenHolderList?chain=bsc&token=${token}` +
    '&page_size=100&sort_field=position&sort_order=desc';
  assert.deepEqual(bscDebotBridgeRequest(exact), {
    type: 'debot.token_holders.v1',
    payload: { chain: 'bsc', token, pageSize: 100 },
    bridgeRequired: true
  });
  assert.equal(bscDebotBridgeRequest(exact.replace('sort_order=desc', 'sort_order=asc')), null);
  assert.equal(bscDebotBridgeRequest(exact.replace('chain=bsc', 'chain=base')), null);
  assert.equal(bscDebotBridgeRequest(`${exact}&unexpected=1`), null);
  assert.equal(bscDebotBridgeRequest(exact, { method: 'POST' }), null);

  const walletRequest = bscDebotBridgeRequest(
    `https://debot.ai/api/dex/profit/wallet_token_analysis?chain=bsc&token=${token}&wallet=${wallet}`
  );
  assert.deepEqual(walletRequest, {
    type: 'debot.wallet_token_analysis.v1',
    payload: { chain: 'bsc', token, wallet },
    bridgeRequired: false
  });
});

test('validates bridge schemas and exact chain, token, and wallet identities', () => {
  const holderRequest = {
    type: 'debot.token_holders.v1',
    payload: { chain: 'bsc', token, pageSize: 100 }
  };
  const holderData = { chain: 'bsc', token, list: [] };
  assert.equal(
    validateBscDebotBridgeResponse(envelope('debot.token_holders.raw.v1', holderData), holderRequest),
    holderData
  );

  const tokenRequest = { type: 'debot.token_detail.v1', payload: { chain: 'bsc', token } };
  const tokenData = { token: { meta: { chain: 'bsc', address: token } } };
  assert.equal(
    validateBscDebotBridgeResponse(envelope('debot.token_detail.raw.v1', tokenData), tokenRequest),
    tokenData
  );

  const walletRequest = {
    type: 'debot.wallet_token_analysis.v1',
    payload: { chain: 'bsc', token, wallet }
  };
  const walletData = { chain: 'bsc', token, wallet };
  assert.equal(
    validateBscDebotBridgeResponse(
      envelope('debot.wallet_token_analysis.raw.v1', walletData),
      walletRequest
    ),
    walletData
  );

  assert.throws(
    () => validateBscDebotBridgeResponse(
      envelope('debot.token_detail.raw.v1', holderData),
      holderRequest
    ),
    /unexpected result schema/
  );
  assert.throws(
    () => validateBscDebotBridgeResponse(
      envelope('debot.token_holders.raw.v1', { ...holderData, chain: 'base' }),
      holderRequest
    ),
    /another chain or token/
  );
  assert.throws(
    () => validateBscDebotBridgeResponse(
      envelope('debot.token_holders.raw.v1', { ...holderData, token: otherToken }),
      holderRequest
    ),
    /another chain or token/
  );
  assert.throws(
    () => validateBscDebotBridgeResponse(
      envelope('debot.wallet_token_analysis.raw.v1', { ...walletData, wallet: otherWallet }),
      walletRequest
    ),
    /another wallet/
  );
});

test('routes Holder requests through the loopback bridge while leaving direct DeBot requests direct', async () => {
  const calls = [];
  const fetchImpl = async (input, init = {}) => {
    calls.push({ url: String(input), init });
    if (String(input).startsWith('http://127.0.0.1:18118/internal/debot/request')) {
      return new Response(JSON.stringify(envelope('debot.token_holders.raw.v1', {
        chain: 'bsc',
        token,
        list: [{ wallet, position: 100 }]
      })), { status: 200, headers: { 'content-type': 'application/json' } });
    }
    return new Response(JSON.stringify({ code: 0, data: { direct: true } }), {
      status: 200,
      headers: { 'content-type': 'application/json' }
    });
  };
  const bridgeFetch = createBscDebotBridgeFetch({ fetchImpl, timeoutMs: 5_000 });
  const holderUrl = `https://debot.ai/api/token/profiler/tokenHolderList?chain=bsc&token=${token}` +
    '&page_size=100&sort_field=position&sort_order=desc';
  const holderResponse = await bridgeFetch(holderUrl);
  assert.deepEqual(await holderResponse.json(), {
    code: 0,
    data: { chain: 'bsc', token, list: [{ wallet, position: 100 }] }
  });
  assert.equal(calls[0].url, 'http://127.0.0.1:18118/internal/debot/request');
  assert.deepEqual(JSON.parse(calls[0].init.body), {
    type: 'debot.token_holders.v1',
    payload: { chain: 'bsc', token, pageSize: 100 }
  });

  const directUrl = `https://debot.ai/api/dashboard/token/detail?chain=bsc&token=${token}`;
  assert.deepEqual(await (await bridgeFetch(directUrl)).json(), { code: 0, data: { direct: true } });
  assert.equal(calls[1].url, directUrl);
});

test('fails closed on a mismatched Holder bridge response or a non-loopback bridge endpoint', async () => {
  const holderUrl = `https://debot.ai/api/token/profiler/tokenHolderList?chain=bsc&token=${token}` +
    '&page_size=100&sort_field=position&sort_order=desc';
  const bridgeFetch = createBscDebotBridgeFetch({
    fetchImpl: async () => new Response(JSON.stringify(envelope('debot.token_holders.raw.v1', {
      chain: 'bsc',
      token: otherToken,
      list: []
    })), { status: 200 })
  });
  await assert.rejects(bridgeFetch(holderUrl), (error) =>
    error?.code === 'BSC_DEBOT_HOLDER_BRIDGE_UNAVAILABLE' &&
    /another chain or token/.test(error?.cause?.message || '')
  );
  assert.throws(
    () => createBscDebotBridgeFetch({ bridgeUrl: 'https://radar.example/internal/debot/request' }),
    /loopback HTTP endpoint/
  );
});
