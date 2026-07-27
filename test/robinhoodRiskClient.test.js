import test from 'node:test';
import assert from 'node:assert/strict';

import {
  ROBINHOOD_DEAD_TOKEN_DEFINITION,
  ROBINHOOD_LAUNCH_FACTORIES,
  ROBINHOOD_TOKEN_LAUNCHED_TOPIC,
  ROBINHOOD_TOKEN_RISK_THRESHOLDS,
  RobinhoodTokenRiskClient
} from '../src/robinhood/riskClient.js';

const token = '0x1111111111111111111111111111111111111111';
const tokenB = '0x2222222222222222222222222222222222222222';
const tokenC = '0x3333333333333333333333333333333333333333';
const nonTokenContract = '0x4444444444444444444444444444444444444444';
const pool = '0xbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb';
const creator = '0xaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa';
const unnamedContract = '0xcccccccccccccccccccccccccccccccccccccccc';
const router = '0xdddddddddddddddddddddddddddddddddddddddd';
const dead = '0x000000000000000000000000000000000000dead';
const creationHash = `0x${'9'.repeat(64)}`;

const completeSafeSafety = Object.freeze({
  honeypot: false,
  cannotSellAll: false,
  inDex: true,
  mintable: false,
  openSource: true,
  isProxy: false
});

function address(index) {
  return `0x${index.toString(16).padStart(40, '0')}`;
}

function holder(holderAddress, share, { name = null, isContract = false } = {}) {
  return {
    address: holderAddress,
    holdingSharePercent: share,
    contractName: name,
    isContract
  };
}

function topicForAddress(value) {
  return `0x${'0'.repeat(24)}${value.slice(2)}`;
}

function launchedLog(tokenAddress, creatorAddress, timestamp, factory = ROBINHOOD_LAUNCH_FACTORIES[0]) {
  return {
    address: factory,
    topics: [
      ROBINHOOD_TOKEN_LAUNCHED_TOPIC,
      topicForAddress(tokenAddress),
      topicForAddress(creatorAddress)
    ],
    timeStamp: `0x${timestamp.toString(16)}`,
    transactionHash: `0x${tokenAddress.slice(2).padStart(64, '0')}`
  };
}

function readyHolderResult() {
  return {
    source: 'blockscout',
    reachedEnd: false,
    holders: [
      holder(pool, 30, { name: 'UniswapV2Pair', isContract: true }),
      holder(dead, 20),
      holder(router, 9, { name: 'UniversalRouter', isContract: true }),
      // An unnamed contract is concentration risk and must remain in the top ten.
      holder(unnamedContract, 10, { isContract: true }),
      holder(address(1), 8),
      holder(address(2), 7),
      holder(address(3), 6),
      holder(address(4), 5),
      holder(address(5), 4),
      holder(address(6), 3),
      holder(address(7), 2),
      holder(address(8), 1),
      holder(address(9), 0.5)
    ]
  };
}

function summaryBlockscoutFetch({ calls = [] } = {}) {
  return async (input) => {
    const url = new URL(input);
    calls.push(url);
    if (url.pathname === `/api/v2/addresses/${token}`) {
      return Response.json({
        creator_address_hash: pool,
        creation_transaction_hash: creationHash
      });
    }
    if (url.pathname === `/api/v2/transactions/${creationHash}`) {
      return Response.json({
        hash: creationHash,
        from: { hash: creator },
        to: null,
        created_contract: { hash: token },
        status: 'ok',
        timestamp: '2026-07-25T00:00:00.000Z'
      });
    }
    if (url.pathname === `/api/v2/addresses/${creator}/token-balances`) {
      return Response.json([{
        token: { address_hash: token, total_supply: '1000000', type: 'ERC-20' },
        value: '25000'
      }]);
    }
    return new Response('{}', { status: 404 });
  };
}

function summaryFetchWithGoPlus(body, { calls = [] } = {}) {
  const blockscoutFetch = summaryBlockscoutFetch({ calls });
  return async (input) => {
    const url = new URL(input);
    if (url.hostname === 'goplus.test') {
      calls.push(url);
      return Response.json(body);
    }
    return blockscoutFetch(input);
  };
}

function goPlusSafetyBody(row = {}, addressKey = token) {
  return {
    code: 1,
    message: 'OK',
    result: {
      [addressKey]: {
        is_honeypot: '0',
        cannot_sell_all: '0',
        is_in_dex: '1',
        is_mintable: '0',
        is_open_source: '1',
        is_proxy: '0',
        ...row
      }
    }
  };
}

async function riskForSafety(safety, options = {}) {
  const client = new RobinhoodTokenRiskClient({
    debotClient: { async fetchTokenSafety() { return safety; } },
    marketClient: {
      async fetchTokenMetrics() {
        return {
          source: 'dexscreener_robinhood',
          liquidityUsd: options.liquidityUsd ?? 42_000,
          primaryPoolAddress: pool,
          pairCount: 1,
          ...(options.marketMetrics || {})
        };
      }
    },
    holderClient: {
      async fetchTopHolders() {
        return options.holderResult || readyHolderResult();
      }
    },
    blockscoutBaseUrl: 'https://blockscout.test/api/v2',
    fetchImpl: summaryBlockscoutFetch(),
    ...(options.clientOptions || {})
  });
  return client.fetchTokenRiskSummary(token);
}

test('keeps partial-sell evidence unknown without excluding an unnamed contract holder', async () => {
  const holderCalls = [];
  const blockscoutCalls = [];
  const client = new RobinhoodTokenRiskClient({
    debotClient: {
      async fetchTokenSafety() {
        return {
          honeypot: false,
          cannotSellAll: true,
          inDex: true,
          mintable: false,
          openSource: true,
          isProxy: false
        };
      }
    },
    marketClient: {
      async fetchTokenMetrics() {
        return {
          source: 'dexscreener_robinhood',
          liquidityUsd: 42_000,
          primaryPoolAddress: pool,
          creationTimestamp: 1_785_000_000,
          pairCount: 1
        };
      }
    },
    holderClient: {
      async fetchTopHolders(requested, options) {
        holderCalls.push({ requested, options });
        return readyHolderResult();
      }
    },
    blockscoutBaseUrl: 'https://blockscout.test/api/v2',
    fetchImpl: summaryBlockscoutFetch({ calls: blockscoutCalls }),
    now: () => Date.parse('2026-07-28T00:00:00.000Z')
  });

  const risk = await client.fetchTokenRiskSummary(token);

  assert.equal(risk.sellable, null);
  assert.equal(risk.canMintMore, false);
  assert.equal(risk.liquidityUsd, 42_000);
  assert.equal(risk.top10HolderCount, 10);
  assert.equal(risk.top10HolderPercent, 46.5);
  assert.equal(risk.top10HolderPartial, false);
  assert.equal(risk.creatorAddress, creator);
  assert.equal(risk.creatorHoldingPercent, 2.5);
  assert.equal(risk.creatorContext.creatorAddressSource, 'blockscout_creation_transaction_sender');
  assert.equal(risk.creatorContext.contractCreatorAddress, pool);
  assert.equal(risk.tokenRiskStatus, 'partial');
  assert.equal(risk.tokenRiskError, null);
  assert.ok(risk.tokenRiskFlags.includes('sellability_unknown'));
  assert.ok(risk.tokenRiskFlags.includes('cannot_sell_all'));
  assert.equal(risk.tokenRiskSources.sellable, null);
  assert.equal(risk.tokenRiskSources.canMintMore, 'debot_goplus_mintability_composite');
  assert.equal(holderCalls.length, 1);
  assert.equal(holderCalls[0].requested, token);
  assert.equal(holderCalls[0].options.limit, 50);
  assert.deepEqual(blockscoutCalls
    .filter((url) => url.hostname === 'blockscout.test')
    .map((url) => url.pathname), [
    `/api/v2/addresses/${token}`,
    `/api/v2/transactions/${creationHash}`,
    `/api/v2/addresses/${creator}/token-balances`
  ]);
});

test('only confirms sellability when all required safety signals agree', async (t) => {
  const cases = [
    {
      name: 'confirmed sellable',
      safety: { honeypot: false, cannotSellAll: false, inDex: true },
      expected: true
    },
    {
      name: 'confirmed honeypot',
      safety: { honeypot: true, cannotSellAll: false, inDex: true },
      expected: false
    },
    {
      name: 'partial selling only',
      safety: { honeypot: false, cannotSellAll: true, inDex: true },
      expected: null
    },
    {
      name: 'not found on a DEX',
      safety: { honeypot: false, cannotSellAll: false, inDex: false },
      expected: null
    },
    {
      name: 'required signal missing',
      safety: { honeypot: false, inDex: true },
      expected: null
    }
  ];
  for (const scenario of cases) {
    await t.test(scenario.name, async () => {
      const risk = await riskForSafety(scenario.safety);
      assert.equal(risk.sellable, scenario.expected);
      assert.equal(risk.tokenRiskFlags.includes('unsellable'), scenario.expected === false);
      assert.equal(risk.tokenRiskFlags.includes('sellability_unknown'), scenario.expected === null);
    });
  }
});

test('fills missing DeBot safety fields from GoPlus chain 4663', async () => {
  const calls = [];
  const risk = await riskForSafety({ honeypot: false }, {
    clientOptions: {
      goplusBaseUrl: 'https://goplus.test/api/v1/token_security',
      fetchImpl: summaryFetchWithGoPlus(goPlusSafetyBody(), { calls })
    }
  });

  assert.equal(risk.sellable, true);
  assert.equal(risk.canMintMore, false);
  assert.equal(risk.tokenRiskError, null);
  const request = calls.find((url) => url.hostname === 'goplus.test');
  assert.ok(request);
  assert.equal(request.pathname, '/api/v1/token_security/4663');
  assert.equal(request.searchParams.get('contract_addresses'), token);
});

test('never lets favorable DeBot values mask adverse GoPlus safety signals', async () => {
  const risk = await riskForSafety({
    honeypot: false,
    cannotSellAll: false,
    inDex: true,
    mintable: false,
    openSource: true
  }, {
    clientOptions: {
      goplusBaseUrl: 'https://goplus.test/api/v1/token_security',
      fetchImpl: summaryFetchWithGoPlus(goPlusSafetyBody({
        is_honeypot: '1',
        is_in_dex: '0',
        is_mintable: '1',
        is_open_source: '0',
        is_proxy: '1'
      }))
    }
  });

  assert.equal(risk.sellable, false);
  assert.equal(risk.canMintMore, true);
  assert.ok(risk.tokenRiskFlags.includes('unsellable'));
  assert.ok(risk.tokenRiskFlags.includes('not_in_dex'));
  assert.ok(risk.tokenRiskFlags.includes('mintable'));
});

test('rejects malformed or mismatched GoPlus token-security payloads', async (t) => {
  const cases = [
    {
      name: 'non-success code',
      body: { code: 0, result: { [token]: {} } },
      error: /invalid token-security response/
    },
    {
      name: 'non-object result',
      body: { code: 1, result: [] },
      error: /invalid token-security response/
    },
    {
      name: 'missing requested address',
      body: { code: 1, result: {} },
      error: /did not match the requested address/
    },
    {
      name: 'mismatched address',
      body: goPlusSafetyBody({}, tokenB),
      error: /did not match the requested address/
    },
    {
      name: 'duplicate normalized address keys',
      body: {
        code: 1,
        result: { [token]: {}, [token.toUpperCase()]: {} }
      },
      error: /did not match the requested address/
    },
    {
      name: 'non-object token row',
      body: { code: 1, result: { [token]: null } },
      error: /invalid token-security data/
    }
  ];

  for (const scenario of cases) {
    await t.test(scenario.name, async () => {
      const risk = await riskForSafety({ honeypot: false, mintable: true }, {
        clientOptions: {
          goplusBaseUrl: 'https://goplus.test/api/v1/token_security',
          fetchImpl: summaryFetchWithGoPlus(scenario.body)
        }
      });
      assert.equal(risk.canMintMore, true);
      assert.match(risk.tokenRiskError, scenario.error);
    });
  }
});

test('keeps usable DeBot fields when GoPlus is temporarily unavailable', async () => {
  const blockscoutFetch = summaryBlockscoutFetch();
  const risk = await riskForSafety({ honeypot: false, mintable: true }, {
    clientOptions: {
      goplusBaseUrl: 'https://goplus.test/api/v1/token_security',
      fetchImpl: async (input) => {
        if (new URL(input).hostname === 'goplus.test') throw new Error('GoPlus offline');
        return blockscoutFetch(input);
      }
    }
  });

  assert.equal(risk.canMintMore, true);
  assert.equal(risk.sellable, null);
  assert.match(risk.tokenRiskError, /goplus_safety: GoPlus offline/);
});

test('uses recent primary-pool sells only as explicitly qualified sellability evidence', async (t) => {
  await t.test('strict safety confirmation remains definitive', async () => {
    const risk = await riskForSafety(completeSafeSafety, {
      marketMetrics: { recentSellCount: 8 }
    });
    assert.equal(risk.sellable, true);
    assert.equal(risk.tokenRiskFlags.includes('sellability_recent_sales_only'), false);
    assert.equal(risk.tokenRiskSources.sellable, 'debot_goplus_sellability_composite');
  });

  await t.test('honeypot evidence wins even when recent sells exist', async () => {
    const risk = await riskForSafety({ ...completeSafeSafety, honeypot: true }, {
      marketMetrics: { recentSellCount: 8 }
    });
    assert.equal(risk.sellable, false);
    assert.ok(risk.tokenRiskFlags.includes('unsellable'));
    assert.equal(risk.tokenRiskFlags.includes('sellability_recent_sales_only'), false);
  });

  await t.test('positive recent sells produce a qualified signal when strict data is incomplete', async () => {
    const risk = await riskForSafety({
      ...completeSafeSafety,
      cannotSellAll: null
    }, {
      marketMetrics: { recentSellCount: 8 },
      clientOptions: {
        goplusBaseUrl: 'https://goplus.test/api/v1/token_security',
        fetchImpl: summaryFetchWithGoPlus(goPlusSafetyBody({ cannot_sell_all: undefined }))
      }
    });
    assert.equal(risk.sellable, true);
    assert.ok(risk.tokenRiskFlags.includes('sellability_recent_sales_only'));
    assert.equal(risk.tokenRiskFlags.includes('sellability_unknown'), false);
    assert.equal(risk.tokenRiskSources.sellable, 'dexscreener_recent_sales');
  });

  await t.test('zero recent sells remain unknown', async () => {
    const risk = await riskForSafety({
      ...completeSafeSafety,
      cannotSellAll: null
    }, {
      marketMetrics: { recentSellCount: 0 },
      clientOptions: {
        goplusBaseUrl: 'https://goplus.test/api/v1/token_security',
        fetchImpl: summaryFetchWithGoPlus(goPlusSafetyBody({ cannot_sell_all: undefined }))
      }
    });
    assert.equal(risk.sellable, null);
    assert.ok(risk.tokenRiskFlags.includes('sellability_unknown'));
  });

  await t.test('cannot-sell-all evidence blocks the recent-sales fallback', async () => {
    const risk = await riskForSafety({ ...completeSafeSafety, cannotSellAll: true }, {
      marketMetrics: { recentSellCount: 8 }
    });
    assert.equal(risk.sellable, null);
    assert.ok(risk.tokenRiskFlags.includes('cannot_sell_all'));
    assert.ok(risk.tokenRiskFlags.includes('sellability_unknown'));
    assert.equal(risk.tokenRiskFlags.includes('sellability_recent_sales_only'), false);
  });

  await t.test('an explicit not-in-DEX signal blocks contradictory recent-sale evidence', async () => {
    const risk = await riskForSafety({ ...completeSafeSafety, inDex: false }, {
      marketMetrics: { recentSellCount: 8 }
    });
    assert.equal(risk.sellable, null);
    assert.ok(risk.tokenRiskFlags.includes('not_in_dex'));
    assert.ok(risk.tokenRiskFlags.includes('sellability_unknown'));
    assert.equal(risk.tokenRiskFlags.includes('sellability_recent_sales_only'), false);
  });

  for (const invalidCount of [true, [1], ' 1 ', '0x1']) {
    await t.test(`rejects non-decimal recent sell count ${JSON.stringify(invalidCount)}`, async () => {
      const risk = await riskForSafety({
        ...completeSafeSafety,
        cannotSellAll: null
      }, {
        marketMetrics: { recentSellCount: invalidCount },
        clientOptions: {
          goplusBaseUrl: 'https://goplus.test/api/v1/token_security',
          fetchImpl: summaryFetchWithGoPlus(goPlusSafetyBody({ cannot_sell_all: undefined }))
        }
      });
      assert.equal(risk.sellable, null);
      assert.equal(risk.tokenRiskFlags.includes('sellability_recent_sales_only'), false);
    });
  }
});

test('only confirms non-mintability for verified open-source non-proxy code', async (t) => {
  const sellableSignals = { honeypot: false, cannotSellAll: false, inDex: true };
  const cases = [
    {
      name: 'minting capability detected',
      safety: { mintable: true },
      expected: true
    },
    {
      name: 'non-mintable open-source implementation',
      safety: { mintable: false, openSource: true, isProxy: false },
      expected: false
    },
    {
      name: 'closed-source code',
      safety: { mintable: false, openSource: false, isProxy: false },
      expected: null
    },
    {
      name: 'proxy implementation',
      safety: { mintable: false, openSource: true, isProxy: true },
      expected: null
    },
    {
      name: 'proxy status missing',
      safety: { mintable: false, openSource: true },
      expected: null
    }
  ];
  for (const scenario of cases) {
    await t.test(scenario.name, async () => {
      const risk = await riskForSafety({ ...sellableSignals, ...scenario.safety });
      assert.equal(risk.canMintMore, scenario.expected);
      assert.equal(risk.tokenRiskFlags.includes('mintable'), scenario.expected === true);
      assert.equal(risk.tokenRiskFlags.includes('mintability_unknown'), scenario.expected === null);
    });
  }
});

test('uses explicit inclusive concentration and exclusive low-liquidity boundaries', async () => {
  const concentrationHolders = {
    source: 'blockscout',
    reachedEnd: true,
    holders: [
      holder(creator, 5),
      holder(address(1), 5),
      holder(address(2), 5),
      holder(address(3), 5),
      holder(address(4), 5),
      holder(address(5), 5),
      holder(address(6), 5),
      holder(address(7), 5),
      holder(address(8), 5),
      holder(address(9), 5)
    ]
  };
  const atBoundary = await riskForSafety({
    honeypot: false,
    cannotSellAll: false,
    inDex: true,
    mintable: true
  }, {
    liquidityUsd: ROBINHOOD_TOKEN_RISK_THRESHOLDS.lowLiquidityUsd,
    holderResult: concentrationHolders
  });
  assert.equal(atBoundary.top10HolderPercent, ROBINHOOD_TOKEN_RISK_THRESHOLDS.holderConcentrationPercent);
  assert.equal(atBoundary.creatorHoldingPercent, ROBINHOOD_TOKEN_RISK_THRESHOLDS.creatorConcentrationPercent);
  assert.equal(atBoundary.tokenRiskFlags.includes('low_liquidity'), false);
  assert.equal(atBoundary.tokenRiskFlags.includes('holder_concentration'), true);
  assert.equal(atBoundary.tokenRiskFlags.includes('creator_concentration'), true);

  const belowLiquidity = await riskForSafety({
    honeypot: false,
    cannotSellAll: false,
    inDex: true,
    mintable: true
  }, {
    liquidityUsd: ROBINHOOD_TOKEN_RISK_THRESHOLDS.lowLiquidityUsd - 1
  });
  assert.equal(belowLiquidity.tokenRiskFlags.includes('low_liquidity'), true);
});

test('keeps failed risk fields null and reports an error instead of false safety', async () => {
  const client = new RobinhoodTokenRiskClient({
    debotClient: { async fetchTokenSafety() { throw new Error('DeBot safety unavailable'); } },
    marketClient: { async fetchTokenMetrics() { return { liquidityUsd: null }; } },
    holderClient: { async fetchTopHolders() { throw new Error('holders unavailable'); } },
    blockscoutBaseUrl: 'https://blockscout.test/api/v2',
    maxResponseBytes: 128,
    fetchImpl: async () => new Response('', {
      status: 200,
      headers: { 'content-length': '1000' }
    })
  });

  const risk = await client.fetchTokenRiskSummary(token);

  assert.equal(risk.sellable, null);
  assert.equal(risk.canMintMore, null);
  assert.equal(risk.liquidityUsd, null);
  assert.equal(risk.top10HolderPercent, null);
  assert.equal(risk.creatorAddress, null);
  assert.equal(risk.creatorHoldingPercent, null);
  assert.equal(risk.tokenRiskStatus, 'error');
  assert.match(risk.tokenRiskError, /DeBot safety unavailable/);
  assert.match(risk.tokenRiskError, /holders unavailable/);
  assert.match(risk.tokenRiskError, /response is too large/);
});

test('stops reading and cancels a chunked response as soon as the byte limit is exceeded', async () => {
  const streams = [];
  const client = new RobinhoodTokenRiskClient({
    debotClient: { async fetchTokenSafety() { return completeSafeSafety; } },
    blockscoutBaseUrl: 'https://blockscout.test/api/v2',
    maxResponseBytes: 128,
    fetchImpl: async () => {
      const state = { chunks: 0, cancelled: false };
      streams.push(state);
      return new Response(new ReadableStream({
        pull(controller) {
          state.chunks += 1;
          controller.enqueue(new Uint8Array(96));
        },
        cancel() {
          state.cancelled = true;
          return new Promise(() => {});
        }
      }), { status: 200 });
    }
  });

  const risk = await client.fetchTokenRiskSummary(token);

  assert.match(risk.tokenRiskError, /Blockscout response is too large/);
  assert.equal(streams.every((state) => state.cancelled), true);
  assert.equal(
    streams.every((state) => state.chunks <= 3),
    true,
    `expected an early streaming stop, got ${streams.map((state) => state.chunks).join(',')} chunks`
  );
});

test('deduplicates in-flight summaries and serves the short-lived token cache', async () => {
  let releaseSafety;
  const safetyGate = new Promise((resolve) => { releaseSafety = resolve; });
  const calls = { safety: 0, market: 0, holders: 0, blockscout: 0 };
  const client = new RobinhoodTokenRiskClient({
    debotClient: {
      async fetchTokenSafety() {
        calls.safety += 1;
        await safetyGate;
        return completeSafeSafety;
      }
    },
    marketClient: {
      async fetchTokenMetrics() {
        calls.market += 1;
        return { liquidityUsd: 10_000, primaryPoolAddress: pool, pairCount: 1 };
      }
    },
    holderClient: {
      async fetchTopHolders() {
        calls.holders += 1;
        return { source: 'blockscout', holders: [], reachedEnd: true };
      }
    },
    blockscoutBaseUrl: 'https://blockscout.test/api/v2',
    fetchImpl: async (input) => {
      calls.blockscout += 1;
      const url = new URL(input);
      if (url.pathname.includes('/transactions/')) {
        return Response.json({ from: { hash: creator }, to: null, timestamp: 1_785_000_000 });
      }
      if (url.pathname.endsWith('/token-balances')) return Response.json([]);
      return Response.json({ creation_transaction_hash: creationHash });
    },
    tokenCacheTtlMs: 10_000
  });

  const first = client.fetchTokenRiskSummary(token);
  const second = client.fetchTokenRiskSummary(token);
  await new Promise((resolve) => setImmediate(resolve));
  assert.equal(calls.safety, 1);
  releaseSafety();
  assert.deepEqual(await first, await second);

  await client.fetchTokenRiskSummary(token);
  assert.deepEqual(calls, { safety: 1, market: 1, holders: 1, blockscout: 6 });
});

test('keeps a shared lookup alive when only one concurrent caller cancels', async () => {
  let releaseSafety;
  let safetyCalls = 0;
  const safetyGate = new Promise((resolve) => { releaseSafety = resolve; });
  const client = new RobinhoodTokenRiskClient({
    debotClient: {
      async fetchTokenSafety() {
        safetyCalls += 1;
        await safetyGate;
        return completeSafeSafety;
      }
    },
    blockscoutBaseUrl: 'https://blockscout.test/api/v2',
    fetchImpl: async () => Response.json({})
  });
  const controller = new AbortController();

  const cancelledCaller = client.fetchTokenRiskSummary(token, { signal: controller.signal });
  const survivingCaller = client.fetchTokenRiskSummary(token);
  await new Promise((resolve) => setImmediate(resolve));
  controller.abort(new Error('cancel only this caller'));
  releaseSafety();

  await assert.rejects(cancelledCaller, /cancel only this caller/);
  assert.equal((await survivingCaller).tokenAddress, token);
  assert.equal(safetyCalls, 1);
});

test('starts a fresh shared lookup for a caller arriving while an abandoned request is aborting', async () => {
  let safetyCalls = 0;
  const client = new RobinhoodTokenRiskClient({
    debotClient: {
      async fetchTokenSafety(_requested, { signal }) {
        safetyCalls += 1;
        if (safetyCalls > 1) return completeSafeSafety;
        return new Promise((_resolve, reject) => {
          signal.addEventListener('abort', () => {
            setTimeout(() => reject(signal.reason), 30);
          }, { once: true });
        });
      }
    },
    blockscoutBaseUrl: 'https://blockscout.test/api/v2',
    fetchImpl: async () => Response.json({})
  });
  const controller = new AbortController();
  const abandoned = client.fetchTokenRiskSummary(token, { signal: controller.signal });
  await new Promise((resolve) => setImmediate(resolve));
  controller.abort(new Error('first caller cancelled'));
  await assert.rejects(abandoned, /first caller cancelled/);

  const replacement = await client.fetchTokenRiskSummary(token);
  assert.equal(replacement.tokenAddress, token);
  assert.equal(safetyCalls, 2);
});

test('bounds the token cache with LRU eviction and sweeps expired entries', async () => {
  let now = Date.parse('2026-07-28T00:00:00.000Z');
  const safetyCalls = new Map();
  const client = new RobinhoodTokenRiskClient({
    debotClient: {
      async fetchTokenSafety(requested) {
        safetyCalls.set(requested, (safetyCalls.get(requested) || 0) + 1);
        return completeSafeSafety;
      }
    },
    marketClient: {
      async fetchTokenMetrics() {
        return {
          source: 'dexscreener_robinhood',
          liquidityUsd: 42_000,
          primaryPoolAddress: pool,
          pairCount: 1
        };
      }
    },
    holderClient: {
      async fetchTopHolders() {
        return { source: 'blockscout', holders: [], reachedEnd: true };
      }
    },
    blockscoutBaseUrl: 'https://blockscout.test/api/v2',
    fetchImpl: async () => Response.json({}),
    now: () => now,
    tokenCacheMaxEntries: 2,
    tokenCacheTtlMs: 10_000,
    cacheSweepIntervalMs: 100
  });

  await client.fetchTokenRiskSummary(token);
  await client.fetchTokenRiskSummary(tokenB);
  await client.fetchTokenRiskSummary(token); // Refresh token so tokenB is the LRU entry.
  await client.fetchTokenRiskSummary(tokenC);
  await client.fetchTokenRiskSummary(tokenB);

  assert.equal(client.tokenCache.size, 2);
  assert.deepEqual(Object.fromEntries(safetyCalls), {
    [token]: 1,
    [tokenB]: 2,
    [tokenC]: 1
  });

  now += 10_200;
  const freshToken = address(555);
  await client.fetchTokenRiskSummary(freshToken);
  assert.equal(client.tokenCache.size, 1);
  assert.equal(client.tokenCache.has(freshToken), true);
});

test('force bypasses a settled token summary cache while preserving normal cache hits', async () => {
  let safetyCalls = 0;
  const client = new RobinhoodTokenRiskClient({
    debotClient: {
      async fetchTokenSafety() {
        safetyCalls += 1;
        return completeSafeSafety;
      }
    },
    blockscoutBaseUrl: 'https://blockscout.test/api/v2',
    fetchImpl: async () => Response.json({}),
    tokenCacheTtlMs: 10_000
  });

  await client.fetchTokenRiskSummary(token);
  await client.fetchTokenRiskSummary(token);
  await client.fetchTokenRiskSummary(token, { force: true });

  assert.equal(safetyCalls, 2);
});

test('propagates caller cancellation to active Blockscout requests', async () => {
  const controller = new AbortController();
  const client = new RobinhoodTokenRiskClient({
    blockscoutBaseUrl: 'https://blockscout.test/api/v2',
    fetchImpl: async (_input, { signal }) => new Promise((_resolve, reject) => {
      const onAbort = () => reject(signal.reason);
      if (signal.aborted) onAbort();
      else signal.addEventListener('abort', onAbort, { once: true });
    })
  });

  const pending = client.fetchTokenRiskSummary(token, { signal: controller.signal });
  controller.abort(new Error('stop risk lookup'));

  await assert.rejects(pending, /stop risk lookup/);
});

test('resolves a known factory creator from one fast RPC log before Blockscout', async () => {
  const createdAt = Math.floor(Date.parse('2026-07-28T00:00:00.000Z') / 1_000);
  const rpcCalls = [];
  const explorerCalls = [];
  const client = new RobinhoodTokenRiskClient({
    debotClient: { async fetchTokenSafety() { return completeSafeSafety; } },
    marketClient: {
      async fetchTokenMetrics() {
        return { source: 'dexscreener_robinhood', liquidityUsd: 42_000, pairCount: 1 };
      }
    },
    holderClient: {
      async fetchTopHolders() {
        return {
          source: 'blockscout',
          reachedEnd: true,
          holders: []
        };
      }
    },
    rpcUrl: 'https://rpc.test',
    blockscoutBaseUrl: 'https://blockscout.test/api/v2',
    fetchImpl: async (input, init = {}) => {
      const url = new URL(input);
      if (url.hostname === 'rpc.test') {
        const request = JSON.parse(init.body);
        rpcCalls.push(request);
        if (request.method === 'eth_getLogs') {
          const log = launchedLog(token, creator, createdAt, ROBINHOOD_LAUNCH_FACTORIES[0]);
          log.blockNumber = '0x123';
          log.logIndex = '0x0';
          return Response.json({ jsonrpc: '2.0', id: request.id, result: [log] });
        }
        if (request.method === 'eth_call') {
          const value = request.params[0].data === '0x18160ddd' ? 1_000n : 25n;
          return Response.json({
            jsonrpc: '2.0',
            id: request.id,
            result: `0x${value.toString(16).padStart(64, '0')}`
          });
        }
        return Response.json({
          jsonrpc: '2.0',
          id: request.id,
          result: { number: '0x123', timestamp: `0x${createdAt.toString(16)}` }
        });
      }
      explorerCalls.push(url);
      return new Response('{}', { status: 404 });
    }
  });

  const risk = await client.fetchTokenRiskSummary(token);

  assert.equal(risk.creatorAddress, creator);
  assert.equal(risk.creatorHoldingPercent, 2.5);
  assert.equal(risk.creatorContext.creatorAddressSource, 'robinhood_rpc_token_launched_log');
  assert.equal(risk.creatorContext.factoryAddress, ROBINHOOD_LAUNCH_FACTORIES[0]);
  assert.equal(risk.creatorContext.tokenCreationTimestamp, createdAt);
  assert.equal(risk.tokenRiskSources.creatorHolding, 'robinhood_rpc_balance_of_total_supply');
  assert.equal(explorerCalls.length, 0);
  assert.deepEqual(rpcCalls[0].params[0].address, [...ROBINHOOD_LAUNCH_FACTORIES]);
  assert.deepEqual(rpcCalls[0].params[0].topics, [
    ROBINHOOD_TOKEN_LAUNCHED_TOPIC,
    topicForAddress(token)
  ]);
  assert.equal(rpcCalls.filter((call) => call.method === 'eth_call').length, 2);
});

test('falls back to Blockscout when creator balance RPC values are malformed', async () => {
  const blockscoutFetch = summaryBlockscoutFetch();
  const rpcCalls = [];
  const client = new RobinhoodTokenRiskClient({
    debotClient: { async fetchTokenSafety() { return completeSafeSafety; } },
    marketClient: {
      async fetchTokenMetrics() {
        return { source: 'dexscreener_robinhood', liquidityUsd: 42_000, pairCount: 1 };
      }
    },
    holderClient: {
      async fetchTopHolders() {
        return { source: 'blockscout', reachedEnd: true, holders: [] };
      }
    },
    rpcUrl: 'https://rpc.test',
    blockscoutBaseUrl: 'https://blockscout.test/api/v2',
    fetchImpl: async (input, init = {}) => {
      const url = new URL(input);
      if (url.hostname !== 'rpc.test') return blockscoutFetch(input, init);
      const request = JSON.parse(init.body);
      rpcCalls.push(request);
      return Response.json({
        jsonrpc: '2.0',
        id: request.id,
        result: request.method === 'eth_getLogs' ? [] : '0xnot-a-uint256'
      });
    }
  });

  const risk = await client.fetchTokenRiskSummary(token);

  assert.equal(risk.creatorHoldingPercent, 2.5);
  assert.equal(risk.tokenRiskSources.creatorHolding, 'blockscout_address_token_balances');
  assert.equal(rpcCalls.filter((call) => call.method === 'eth_call').length, 2);
});

test('rejects ambiguous factory creation logs without guessing or falling back', async () => {
  let explorerCalls = 0;
  const client = new RobinhoodTokenRiskClient({
    debotClient: { async fetchTokenSafety() { return completeSafeSafety; } },
    rpcUrl: 'https://rpc.test',
    blockscoutBaseUrl: 'https://blockscout.test/api/v2',
    fetchImpl: async (input, init = {}) => {
      const url = new URL(input);
      if (url.hostname !== 'rpc.test') {
        explorerCalls += 1;
        return Response.json({});
      }
      const request = JSON.parse(init.body);
      const first = launchedLog(token, creator, 1_785_000_000, ROBINHOOD_LAUNCH_FACTORIES[0]);
      first.blockNumber = '0x123';
      first.logIndex = '0x0';
      const second = launchedLog(token, creator, 1_785_000_000, ROBINHOOD_LAUNCH_FACTORIES[1]);
      second.blockNumber = '0x124';
      second.logIndex = '0x1';
      return Response.json({ jsonrpc: '2.0', id: request.id, result: [first, second] });
    }
  });

  const risk = await client.fetchTokenRiskSummary(token);

  assert.equal(risk.creatorAddress, null);
  assert.match(risk.tokenRiskError, /multiple token creation logs/);
  assert.equal(explorerCalls, 0);
});

test('uses serial Robinhood RPC factory logs and bounded block timestamp enrichment first', async () => {
  const now = Date.parse('2026-07-28T00:00:00.000Z');
  const twoDaysAgo = Math.floor(now / 1_000) - 2 * 86_400;
  const rpcCalls = [];
  const explorerCalls = [];
  let activeLogRequests = 0;
  let maxActiveLogRequests = 0;
  const client = new RobinhoodTokenRiskClient({
    marketClient: {
      async fetchTokenMetricsBatch(addresses) {
        return new Map(addresses.map((requested) => [requested, {
          source: 'dexscreener_robinhood',
          noPair: true,
          pairCount: 0,
          primaryPoolAddress: null,
          liquidityUsd: null
        }]));
      }
    },
    rpcUrl: 'https://rpc.test',
    blockscoutBaseUrl: 'https://blockscout.test/api/v2',
    fetchImpl: async (input, init = {}) => {
      const url = new URL(input);
      if (url.hostname === 'rpc.test') {
        const request = JSON.parse(init.body);
        rpcCalls.push(request);
        if (request.method === 'eth_getLogs') {
          activeLogRequests += 1;
          maxActiveLogRequests = Math.max(maxActiveLogRequests, activeLogRequests);
          await new Promise((resolve) => setImmediate(resolve));
          activeLogRequests -= 1;
          const factory = request.params[0].address;
          const log = launchedLog(token, creator, twoDaysAgo, factory);
          delete log.timeStamp;
          log.blockTimestamp = '0x0';
          log.blockNumber = '0x123';
          return Response.json({
            jsonrpc: '2.0',
            id: request.id,
            result: factory === ROBINHOOD_LAUNCH_FACTORIES[0] ? [log] : []
          });
        }
        if (request.method === 'eth_getBlockByNumber') {
          return Response.json({
            jsonrpc: '2.0',
            id: request.id,
            result: { number: request.params[0], timestamp: `0x${twoDaysAgo.toString(16)}` }
          });
        }
      }
      explorerCalls.push(url);
      if (url.pathname === `/api/v2/addresses/${creator}/transactions`) {
        return Response.json({ items: [], next_page_params: null });
      }
      return new Response('{}', { status: 404 });
    },
    now: () => now
  });

  const history = await client.fetchCreatorHistory(token, {
    creatorContext: { tokenAddress: token, creatorAddress: creator }
  });

  assert.equal(history.creatorTokenCount, 1);
  assert.equal(history.creatorDeadTokenCount, 1);
  assert.match(history.creatorHistorySource, /robinhood_rpc_token_launched_logs/);
  assert.equal(maxActiveLogRequests, 1);
  assert.equal(rpcCalls.filter((call) => call.method === 'eth_getLogs').length, 2);
  assert.equal(rpcCalls.filter((call) => call.method === 'eth_getBlockByNumber').length, 1);
  for (const call of rpcCalls.filter((entry) => entry.method === 'eth_getLogs')) {
    assert.deepEqual(call.params[0].topics, [
      ROBINHOOD_TOKEN_LAUNCHED_TOPIC,
      null,
      topicForAddress(creator)
    ]);
  }
  assert.equal(explorerCalls.some((url) => url.pathname === '/api'), false);
});

test('does not long-cache partial creator sources and force bypasses a healthy creator cache', async () => {
  const now = Date.parse('2026-07-28T00:00:00.000Z');
  let round = 1;
  let directCalls = 0;
  let legacyCalls = 0;
  const client = new RobinhoodTokenRiskClient({
    rpcUrl: 'https://rpc.test',
    blockscoutBaseUrl: 'https://blockscout.test/api/v2',
    creatorFactoryRetryCount: 0,
    fetchImpl: async (input) => {
      const url = new URL(input);
      if (url.hostname === 'rpc.test') return new Response('{}', { status: 503 });
      if (url.pathname === '/api') {
        legacyCalls += 1;
        if (round === 1 && url.searchParams.get('address') === ROBINHOOD_LAUNCH_FACTORIES[0]) {
          return new Response('{}', { status: 500 });
        }
        return Response.json({ status: '1', message: 'OK', result: [] });
      }
      if (url.pathname === `/api/v2/addresses/${creator}/transactions`) {
        directCalls += 1;
        return Response.json({ items: [], next_page_params: null });
      }
      return new Response('{}', { status: 404 });
    },
    now: () => now
  });
  const contextFor = (requested) => ({
    tokenAddress: requested,
    creatorAddress: creator,
    tokenCreationTimestamp: Math.floor(now / 1_000)
  });

  const partial = await client.fetchCreatorHistory(token, { creatorContext: contextFor(token) });
  assert.match(partial.creatorHistoryError, /factory_/);
  assert.ok(partial.creatorHistoryFlags.includes('history_source_failed'));
  assert.equal(client.creatorCache.size, 0);

  round = 2;
  const recovered = await client.fetchCreatorHistory(tokenB, { creatorContext: contextFor(tokenB) });
  assert.equal(recovered.creatorHistoryError, null);
  assert.equal(client.creatorCache.size, 1);
  await client.fetchCreatorHistory(tokenB, { creatorContext: contextFor(tokenB) });
  assert.equal(directCalls, 2);

  await client.fetchCreatorHistory(tokenB, {
    creatorContext: contextFor(tokenB),
    force: true
  });
  assert.equal(directCalls, 3);
  assert.equal(legacyCalls, 6);
});

test('uses current token context to repair a timestamp-missing creator record', async () => {
  const now = Date.parse('2026-07-28T00:00:00.000Z');
  const twoDaysAgo = Math.floor(now / 1_000) - 2 * 86_400;
  const metricBatches = [];
  const client = new RobinhoodTokenRiskClient({
    marketClient: {
      async fetchTokenMetricsBatch(addresses) {
        metricBatches.push([...addresses]);
        return new Map(addresses.map((requested) => [requested, {
          source: 'dexscreener_robinhood',
          noPair: true,
          pairCount: 0,
          primaryPoolAddress: null,
          liquidityUsd: null
        }]));
      }
    },
    rpcUrl: 'https://rpc.test',
    blockscoutBaseUrl: 'https://blockscout.test/api/v2',
    creatorFactoryRetryCount: 0,
    fetchImpl: async (input) => {
      const url = new URL(input);
      if (url.hostname === 'rpc.test') return new Response('{}', { status: 503 });
      if (url.pathname === '/api') {
        const log = launchedLog(token, creator, twoDaysAgo, url.searchParams.get('address'));
        delete log.timeStamp;
        return Response.json({
          status: '1',
          message: 'OK',
          result: url.searchParams.get('address') === ROBINHOOD_LAUNCH_FACTORIES[0] ? [log] : []
        });
      }
      if (url.pathname === `/api/v2/addresses/${creator}/transactions`) {
        return Response.json({ items: [], next_page_params: null });
      }
      return new Response('{}', { status: 404 });
    },
    now: () => now
  });

  const history = await client.fetchCreatorHistory(token, {
    creatorContext: {
      tokenAddress: token,
      creatorAddress: creator,
      tokenCreationTimestamp: twoDaysAgo
    }
  });

  assert.equal(history.creatorTokenCount, 1);
  assert.equal(history.creatorDeadTokenCount, 1);
  assert.deepEqual(metricBatches, [[token]]);
});

test('counts indexed TokenLaunched events and only verified direct ERC-20 deployments', async () => {
  const now = Date.parse('2026-07-28T00:00:00.000Z');
  const twoDaysAgo = Math.floor(now / 1_000) - 2 * 86_400;
  const threeDaysAgo = Math.floor(now / 1_000) - 3 * 86_400;
  const fourDaysAgo = Math.floor(now / 1_000) - 4 * 86_400;
  const requests = [];
  const client = new RobinhoodTokenRiskClient({
    marketClient: {
      async fetchTokenMetricsBatch(addresses) {
        return new Map(addresses.map((requested) => [requested, {
          source: 'dexscreener_robinhood',
          pairCount: requested === tokenB ? 0 : 1,
          primaryPoolAddress: requested === tokenB ? null : pool,
          liquidityUsd: requested === token ? 500 : requested === tokenC ? 5_000 : null
        }]));
      }
    },
    blockscoutBaseUrl: 'https://blockscout.test/api/v2',
    fetchImpl: async (input) => {
      const url = new URL(input);
      requests.push(url);
      if (url.pathname === '/api' && url.searchParams.get('module') === 'logs') {
        const factory = url.searchParams.get('address');
        return Response.json({
          status: '1',
          message: 'OK',
          result: factory === ROBINHOOD_LAUNCH_FACTORIES[0]
            ? [
                launchedLog(token, creator, twoDaysAgo, factory),
                // A provider response must still be verified instead of trusting its query filter.
                launchedLog(nonTokenContract, creator, fourDaysAgo, address(999))
              ]
            : [launchedLog(tokenB, creator, threeDaysAgo, factory)]
        });
      }
      if (url.pathname === `/api/v2/addresses/${creator}/transactions`) {
        return Response.json({
          items: [
            {
              from: { hash: creator },
              created_contract: { hash: tokenC },
              status: 'ok',
              timestamp: new Date(fourDaysAgo * 1_000).toISOString(),
              hash: `0x${'c'.repeat(64)}`
            },
            {
              from: { hash: creator },
              created_contract: { hash: nonTokenContract },
              status: 'ok',
              timestamp: new Date(fourDaysAgo * 1_000).toISOString(),
              hash: `0x${'d'.repeat(64)}`
            }
          ],
          next_page_params: null
        });
      }
      if (url.pathname === `/api/v2/tokens/${tokenC}`) {
        return Response.json({ address_hash: tokenC, type: 'ERC-20' });
      }
      if (url.pathname === `/api/v2/tokens/${nonTokenContract}`) {
        return new Response('{}', { status: 404 });
      }
      return new Response('{}', { status: 404 });
    },
    now: () => now
  });

  const history = await client.fetchCreatorHistory(token, {
    creatorContext: {
      tokenAddress: token,
      creatorAddress: creator,
      tokenCreationTimestamp: twoDaysAgo,
      creationTransactionHash: creationHash
    }
  });

  assert.equal(history.creatorTokenCount, 3);
  assert.equal(history.creatorDeadTokenCount, 2);
  assert.equal(history.creatorHistoryPartial, true);
  assert.equal(history.deadDefinition, ROBINHOOD_DEAD_TOKEN_DEFINITION);
  assert.match(history.creatorHistorySource, /blockscout_token_launched_logs/);
  assert.match(history.creatorHistorySource, /verified_direct_erc20/);
  assert.ok(history.creatorHistoryFlags.includes('bad_creator_history'));
  assert.deepEqual(history.tokenRiskFlags, ['bad_creator_history']);
  const legacy = requests.filter((url) => url.pathname === '/api');
  assert.equal(legacy.length, ROBINHOOD_LAUNCH_FACTORIES.length);
  assert.deepEqual(
    legacy.map((url) => url.searchParams.get('address')).sort(),
    [...ROBINHOOD_LAUNCH_FACTORIES].sort()
  );
  for (const request of legacy) {
    assert.equal(request.searchParams.get('topic0'), ROBINHOOD_TOKEN_LAUNCHED_TOPIC);
    assert.equal(request.searchParams.get('topic2'), topicForAddress(creator));
    assert.equal(request.searchParams.get('topic0_2_opr'), 'and');
  }
});

test('reuses creator-scoped history without leaking the first token context', async () => {
  const now = Date.parse('2026-07-28T00:00:00.000Z');
  const twoDaysAgo = Math.floor(now / 1_000) - 2 * 86_400;
  const requests = [];
  const metricBatches = [];
  const client = new RobinhoodTokenRiskClient({
    marketClient: {
      async fetchTokenMetricsBatch(addresses) {
        metricBatches.push([...addresses]);
        return new Map(addresses.map((requested) => [requested, {
          source: 'dexscreener_robinhood',
          pairCount: 1,
          primaryPoolAddress: pool,
          liquidityUsd: 5_000
        }]));
      }
    },
    blockscoutBaseUrl: 'https://blockscout.test/api/v2',
    fetchImpl: async (input) => {
      const url = new URL(input);
      requests.push(url);
      if (url.pathname === '/api') {
        return Response.json({
          status: '1',
          message: 'OK',
          result: url.searchParams.get('address') === ROBINHOOD_LAUNCH_FACTORIES[0]
            ? [launchedLog(token, creator, twoDaysAgo)]
            : []
        });
      }
      if (url.pathname === `/api/v2/addresses/${creator}/transactions`) {
        return Response.json({ items: [], next_page_params: null });
      }
      return new Response('{}', { status: 404 });
    },
    now: () => now
  });

  const first = await client.fetchCreatorHistory(token, {
    creatorContext: {
      tokenAddress: token,
      creatorAddress: creator,
      tokenCreationTimestamp: twoDaysAgo,
      creationTransactionHash: creationHash
    }
  });
  const second = await client.fetchCreatorHistory(tokenB, {
    creatorContext: {
      tokenAddress: tokenB,
      creatorAddress: creator,
      tokenCreationTimestamp: twoDaysAgo,
      creationTransactionHash: `0x${'8'.repeat(64)}`
    }
  });

  assert.equal(first.tokenAddress, token);
  assert.equal(first.creatorTokenCount, 1);
  assert.equal(second.tokenAddress, tokenB);
  assert.equal(second.creatorAddress, creator);
  assert.equal(second.creatorTokenCount, 2);
  assert.equal(second.creatorDeadTokenCount, 0);
  assert.equal(client.creatorCache.size, 1);
  assert.deepEqual(metricBatches, [[token], [tokenB]]);
  assert.equal(requests.filter((url) => url.pathname === '/api').length, ROBINHOOD_LAUNCH_FACTORIES.length);
  assert.equal(
    requests.filter((url) => url.pathname === `/api/v2/addresses/${creator}/transactions`).length,
    1
  );
});

test('accumulates creator tokens learned from trusted current-token contexts', async () => {
  const now = Date.parse('2026-07-28T00:00:00.000Z');
  let factoryRpcCalls = 0;
  let directCalls = 0;
  const client = new RobinhoodTokenRiskClient({
    rpcUrl: 'https://rpc.test',
    blockscoutBaseUrl: 'https://blockscout.test/api/v2',
    fetchImpl: async (input, init = {}) => {
      const url = new URL(input);
      if (url.hostname === 'rpc.test') {
        const request = JSON.parse(init.body);
        if (request.method === 'eth_getLogs') factoryRpcCalls += 1;
        return Response.json({ jsonrpc: '2.0', id: request.id, result: [] });
      }
      if (url.pathname === `/api/v2/addresses/${creator}/transactions`) {
        directCalls += 1;
        return Response.json({ items: [], next_page_params: null });
      }
      return new Response('{}', { status: 404 });
    },
    now: () => now
  });
  const contextFor = (requested) => ({
    tokenAddress: requested,
    creatorAddress: creator,
    tokenCreationTimestamp: Math.floor(now / 1_000)
  });

  const first = await client.fetchCreatorHistory(token, { creatorContext: contextFor(token) });
  const second = await client.fetchCreatorHistory(tokenB, { creatorContext: contextFor(tokenB) });

  assert.equal(first.creatorTokenCount, 1);
  assert.equal(second.creatorTokenCount, 2);
  assert.equal(second.creatorDeadTokenCount, 0);
  assert.match(second.creatorHistorySource, /current_token_context/);
  assert.ok(second.creatorHistoryFlags.includes('current_token_context_included'));
  assert.equal(factoryRpcCalls, ROBINHOOD_LAUNCH_FACTORIES.length);
  assert.equal(directCalls, 1);
});

test('keeps usable factory history but marks it partial when a known factory fails or reaches its limit', async () => {
  const now = Date.parse('2026-07-28T00:00:00.000Z');
  const twoDaysAgo = Math.floor(now / 1_000) - 2 * 86_400;
  const client = new RobinhoodTokenRiskClient({
    marketClient: {
      async fetchTokenMetricsBatch(addresses) {
        return new Map(addresses.map((requested) => [requested, {
          source: 'dexscreener_robinhood',
          pairCount: 1,
          primaryPoolAddress: pool,
          liquidityUsd: 5_000
        }]));
      }
    },
    blockscoutBaseUrl: 'https://blockscout.test/api/v2',
    creatorLaunchLogLimit: 1,
    creatorFactoryRetryCount: 0,
    fetchImpl: async (input) => {
      const url = new URL(input);
      if (url.pathname === '/api') {
        const factory = url.searchParams.get('address');
        if (factory === ROBINHOOD_LAUNCH_FACTORIES[0]) throw new Error('Pons query unavailable');
        return Response.json({
          status: '1',
          message: 'OK',
          result: [launchedLog(token, creator, twoDaysAgo, factory)]
        });
      }
      if (url.pathname === `/api/v2/addresses/${creator}/transactions`) {
        return Response.json({ items: [], next_page_params: null });
      }
      return new Response('{}', { status: 404 });
    },
    now: () => now
  });

  const history = await client.fetchCreatorHistory(token, {
    creatorContext: {
      tokenAddress: token,
      creatorAddress: creator,
      tokenCreationTimestamp: twoDaysAgo
    }
  });

  assert.equal(history.creatorTokenCount, 1);
  assert.equal(history.creatorDeadTokenCount, 0);
  assert.equal(history.creatorHistoryPartial, true);
  assert.ok(history.creatorHistoryFlags.includes('history_truncated_or_incomplete'));
  assert.ok(history.creatorHistoryFlags.includes('history_source_failed'));
  assert.match(history.creatorHistoryError, /Pons query unavailable/);
});

test('does not turn a complete creator-history outage into zero launches', async () => {
  const client = new RobinhoodTokenRiskClient({
    marketClient: { async fetchTokenMetrics() { return null; } },
    blockscoutBaseUrl: 'https://blockscout.test/api/v2',
    creatorFactoryRetryCount: 0,
    fetchImpl: async () => { throw new Error('Blockscout offline'); }
  });

  const history = await client.fetchCreatorHistory(token, {
    creatorContext: { tokenAddress: token, creatorAddress: creator }
  });

  assert.equal(history.creatorTokenCount, null);
  assert.equal(history.creatorDeadTokenCount, null);
  assert.equal(history.creatorHistoryPartial, true);
  assert.match(history.creatorHistoryError, /Blockscout offline/);
});
