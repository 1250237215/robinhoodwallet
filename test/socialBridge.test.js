import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import vm from 'node:vm';
import { spawnSync } from 'node:child_process';
import { pathToFileURL } from 'node:url';
import { build } from 'esbuild';
import { migrateLocalSettings } from '../bridge/debot-social-bridge/options-config.js';
import {
  ANALYSIS_RESULT_OUTBOX_LIMITS,
  createAnalysisResultOutbox
} from '../bridge/debot-social-bridge/analysis-result-outbox.js';

const root = path.resolve(import.meta.dirname, '..');
const bridgeDirectory = path.join(root, 'bridge', 'debot-social-bridge');

function bridgeSource(filename) {
  return fs.readFileSync(path.join(bridgeDirectory, filename), 'utf8');
}

async function eventually(assertion, timeoutMs = 1_000) {
  const deadline = Date.now() + timeoutMs;
  while (true) {
    try {
      return assertion();
    } catch (error) {
      if (Date.now() >= deadline) throw error;
      await new Promise((resolve) => setTimeout(resolve, 5));
    }
  }
}

class FakeWindow {
  constructor(origin) {
    this.location = { origin };
    this.listeners = new Map();
    this.messages = [];
  }

  addEventListener(type, listener) {
    if (!this.listeners.has(type)) this.listeners.set(type, []);
    this.listeners.get(type).push(listener);
  }

  dispatchMessage(data) {
    const event = { source: this, origin: this.location.origin, data };
    for (const listener of this.listeners.get('message') || []) listener(event);
  }

  postMessage(data, targetOrigin) {
    assert.equal(targetOrigin, this.location.origin);
    this.messages.push(data);
    this.dispatchMessage(data);
  }
}

class FakeWebSocket {
  constructor(url) {
    this.url = url;
    this.listeners = new Map();
  }

  addEventListener(type, listener) {
    if (!this.listeners.has(type)) this.listeners.set(type, []);
    this.listeners.get(type).push(listener);
  }

  receive(data) {
    for (const listener of this.listeners.get('message') || []) listener({ data });
  }
}

function jsonResponse(data) {
  return {
    ok: true,
    status: 200,
    async json() {
      return { code: 0, data };
    }
  };
}

test('extension manifest, configuration and scripts are valid and narrowly scoped', async () => {
  const manifest = JSON.parse(bridgeSource('manifest.json'));
  assert.equal(manifest.manifest_version, 3);
  assert.equal(manifest.version, '1.1.0');
  assert.equal(manifest.background.type, 'module');
  assert.deepEqual(manifest.permissions, ['storage', 'alarms']);
  assert.equal(manifest.host_permissions.includes('<all_urls>'), false);
  assert.deepEqual(manifest.host_permissions, [
    'https://debot.ai/*',
    'http://217.116.171.250/*',
    'https://radar.217-116-171-250.sslip.io/*'
  ]);
  const pageScript = manifest.content_scripts.find((entry) => entry.js.includes('debot-page.js'));
  const relayScript = manifest.content_scripts.find((entry) => entry.js.includes('debot-relay.js'));
  assert.equal(pageScript.world, 'MAIN');
  assert.equal(pageScript.run_at, 'document_start');
  assert.equal(relayScript.world, undefined);
  assert.equal(relayScript.run_at, 'document_start');

  const exampleUrl = `${pathToFileURL(path.join(bridgeDirectory, 'config.example.js')).href}?test=${Date.now()}`;
  const example = (await import(exampleUrl)).default;
  assert.equal(example.bridgeToken, '');
  assert.match(example.serverBase, /^https:\/\/radar\./);
  assert.match(fs.readFileSync(path.join(root, '.gitignore'), 'utf8'), /bridge\/debot-social-bridge\/config\.local\.js/);

  for (const filename of fs.readdirSync(bridgeDirectory).filter((name) => name.endsWith('.js'))) {
    const checked = spawnSync(process.execPath, ['--check', path.join(bridgeDirectory, filename)], {
      encoding: 'utf8'
    });
    assert.equal(checked.status, 0, `${filename}: ${checked.stderr}`);
  }
});

test('extension service worker has no unsupported async module loading', async () => {
  const manifest = JSON.parse(bridgeSource('manifest.json'));
  await build({
    entryPoints: [path.join(bridgeDirectory, manifest.background.service_worker)],
    bundle: true,
    platform: 'browser',
    format: 'iife',
    target: ['chrome120'],
    write: false,
    logLevel: 'silent',
    plugins: [{
      name: 'reject-service-worker-dynamic-imports',
      setup(builder) {
        builder.onResolve({ filter: /.*/ }, (args) => {
          if (args.kind !== 'dynamic-import') return undefined;
          return {
            errors: [{
              text: `Dynamic import is not supported in extension service workers: ${args.path}`
            }]
          };
        });
      }
    }]
  });
});

test('extension options migrate a local token once without exposing or overwriting it', async () => {
  let loadCalls = 0;
  let sendCalls = 0;
  const configured = { serverBase: 'https://radar.example/api/social', bridgeToken: 'configured' };
  const unchanged = await migrateLocalSettings({
    current: configured,
    loadLocalConfig: async () => {
      loadCalls += 1;
      throw new Error('must not load');
    },
    sendMessage: async () => {
      sendCalls += 1;
      throw new Error('must not send');
    }
  });
  assert.equal(unchanged, configured);
  assert.equal(loadCalls, 0);
  assert.equal(sendCalls, 0);

  const secret = 'test-only-local-token';
  const migrated = await migrateLocalSettings({
    current: { serverBase: '', bridgeToken: '' },
    loadLocalConfig: async () => ({
      serverBase: 'https://radar.217-116-171-250.sslip.io/robinhood-radar/api/social',
      bridgeToken: `  ${secret}  `
    }),
    sendMessage: async (message) => {
      sendCalls += 1;
      assert.equal(message.source, 'bridge-options');
      assert.equal(message.type, 'migrate-local-settings');
      assert.equal(message.payload.bridgeToken, secret);
      return {
        ok: true,
        payload: { serverBase: message.payload.serverBase, bridgeToken: 'configured' }
      };
    }
  });
  assert.equal(migrated.bridgeToken, 'configured');
  assert.equal(JSON.stringify(migrated).includes(secret), false);
  assert.equal(sendCalls, 1);

  const missing = { serverBase: 'https://radar.example/api/social', bridgeToken: '' };
  assert.equal(await migrateLocalSettings({
    current: missing,
    loadLocalConfig: async () => {
      throw new Error('not installed');
    },
    sendMessage: async () => {
      throw new Error('must not send');
    }
  }), missing);
});

test('analysis result outbox durably deduplicates claims and removes only acknowledged results', async () => {
  const stored = {};
  const storage = {
    async get(key) {
      return { [key]: structuredClone(stored[key]) };
    },
    async set(value) {
      Object.assign(stored, structuredClone(value));
    }
  };
  const outbox = createAnalysisResultOutbox({ storage });
  const first = await outbox.enqueue({
    jobId: 7,
    claimToken: 'claim-one',
    success: true,
    result: { chain: 'robinhood', wallet: '0xaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa' }
  });
  assert.equal(first.added, 1);
  assert.equal((await outbox.enqueue({
    jobId: 7,
    claimToken: 'claim-one',
    success: true,
    result: { duplicate: true }
  })).duplicates, 1);

  await outbox.enqueue({
    jobId: 7,
    claimToken: 'claim-two',
    success: false,
    error: 'TIMEOUT',
    errorType: 'TIMEOUT'
  });
  await outbox.enqueue({
    jobId: 8,
    claimToken: 'claim-three',
    success: false,
    error: 'NETWORK',
    errorType: 'NETWORK'
  });
  const batch = await outbox.readBatch();
  assert.deepEqual(batch.records.map((record) => record.payload.claimToken), ['claim-two', 'claim-three']);
  assert.equal(batch.records[0].payload.errorType, 'TIMEOUT');
  await outbox.acknowledge(batch.records[0].key);
  assert.deepEqual((await outbox.readBatch()).records.map((record) => record.payload.jobId), [8]);
  assert.deepEqual(ANALYSIS_RESULT_OUTBOX_LIMITS, {
    maxRecords: 200,
    maxBytes: 2 * 1024 * 1024,
    defaultBatchLimit: 20
  });

  const overflowStored = {};
  const overflowStorage = {
    async get(key) {
      return { [key]: structuredClone(overflowStored[key]) };
    },
    async set(value) {
      Object.assign(overflowStored, structuredClone(value));
    }
  };
  const tightOutbox = createAnalysisResultOutbox({ storage: overflowStorage, maxBytes: 1_024 });
  assert.equal((await tightOutbox.enqueue({
    jobId: 11,
    claimToken: 'persisted-claim',
    success: true,
    result: { chain: 'robinhood', token: '0x1111111111111111111111111111111111111111' }
  })).added, 1);
  const overflow = await tightOutbox.enqueue({
    jobId: 11,
    claimToken: 'oversized-replacement',
    success: true,
    result: { payload: 'x'.repeat(2_048) }
  });
  assert.equal(overflow.overflow, 1);
  assert.equal(overflow.queued, 1);
  assert.deepEqual((await tightOutbox.readBatch()).records.map((record) => record.payload.claimToken), [
    'persisted-claim'
  ]);
});

test('DeBot page bridge polls while hidden, consumes the expected channels and uses the observed API payloads', async () => {
  const window = new FakeWindow('https://debot.ai');
  window.WebSocket = FakeWebSocket;
  const calls = [];
  const timers = new Map();
  let nextTimerId = 1;
  const setPageTimeout = (callback, delay) => {
    const id = nextTimerId;
    nextTimerId += 1;
    timers.set(id, { callback, delay });
    return id;
  };
  const clearPageTimeout = (id) => timers.delete(id);
  const runPageTimer = (delay) => {
    const match = [...timers.entries()].find(([, timer]) => timer.delay === delay);
    assert.ok(match, `Expected a ${delay}ms page timer`);
    timers.delete(match[0]);
    match[1].callback();
  };
  const account = {
    platform: 0,
    monitor_object: 'alice',
    config_name: 'Alice',
    config_id: 42,
    hot_subscribe_id: 7,
    monitor_level: 'high'
  };
  const partialPollPost = {
    doc_id: 'partial-poll-document',
    platform: 0,
    user: { id: 'partial-author', username: 'partial_author', name: 'Partial Author', followers_count: 10 },
    tweet: { tweet_id: 'partial-poll-tweet', text: 'Main timeline survived', date: 1_784_300_001 }
  };
  const immediatePollPost = {
    ...partialPollPost,
    doc_id: 'immediate-poll-document',
    tweet: { ...partialPollPost.tweet, tweet_id: 'immediate-poll-tweet', text: 'Optional feed cannot delay this' }
  };
  let subscribedAccounts = [account];
  let resolveDeferredFeatured = null;
  let fetchMode = 'ok';
  const fetchImpl = async (url, options = {}) => {
    calls.push({ url: String(url), options });
    if (fetchMode === 'auth') {
      return {
        ok: false,
        status: 401,
        async json() {
          return { code: 401, message: 'authorization: Bearer must-not-leave-the-page' };
        }
      };
    }
    if (fetchMode === 'partial'
      && String(url).startsWith('/api/social/twitter/hot/timeline?')) {
      return {
        ok: false,
        status: 503,
        async json() {
          return { code: 503, message: 'featured timeline unavailable' };
        }
      };
    }
    if (fetchMode === 'deferred-featured'
      && String(url).startsWith('/api/social/twitter/hot/timeline?')) {
      return new Promise((resolve) => {
        resolveDeferredFeatured = () => resolve(jsonResponse({ feeds: [] }));
      });
    }
    if (String(url).startsWith('/api/social/subscribe/list?')) {
      return jsonResponse({ list: subscribedAccounts.map((value) => ({ ...value })) });
    }
    if (url === '/api/social/subscribe/custom/add') {
      const body = JSON.parse(options.body);
      if (!subscribedAccounts.some((value) => value.monitor_object === body.tweet_username
        && Number(value.platform || 0) === Number(body.platform || 0))) {
        subscribedAccounts.push({
          platform: body.platform,
          monitor_object: body.tweet_username,
          config_name: body.tweet_username,
          config_id: 43
        });
      }
      return jsonResponse({ config_id: 43 });
    }
    if (url === '/api/social/subscribe/remove') {
      const ids = new Set(JSON.parse(options.body).config_ids);
      subscribedAccounts = subscribedAccounts.filter((value) => !ids.has(value.config_id));
      return jsonResponse({ success: true });
    }
    if (['partial', 'deferred-featured'].includes(fetchMode)
      && String(url).startsWith('/api/social/twitter/timeline?')) {
      return jsonResponse({ feeds: [fetchMode === 'partial' ? partialPollPost : immediatePollPost] });
    }
    if (String(url).startsWith('/api/social/twitter/')) return jsonResponse({ feeds: [] });
    throw new Error(`Unexpected DeBot endpoint: ${url}`);
  };
  vm.runInNewContext(bridgeSource('debot-page.js'), {
    window,
    document: { visibilityState: 'hidden' },
    fetch: fetchImpl,
    setInterval: () => 1,
    setTimeout: setPageTimeout,
    clearTimeout: clearPageTimeout,
    URLSearchParams,
    URL,
    console
  }, { filename: 'debot-page.js' });

  await eventually(() => assert.ok(window.messages.some((message) => message.type === 'heartbeat')));
  assert.ok(calls.some((call) => call.url.startsWith('/api/social/subscribe/list?keyword=&page=1&page_size=500')));
  assert.ok(calls.some((call) => call.url.startsWith('/api/social/twitter/timeline?')));
  assert.ok(calls.some((call) => call.url.startsWith('/api/social/twitter/hot/timeline?')));
  assert.ok(calls.some((call) => call.url.startsWith('/api/social/twitter/all/timeline?')));
  assert.equal(calls.every((call) => call.options.credentials === 'include'), true);

  window.dispatchMessage({
    source: 'debot-social-relay',
    type: 'force-poll',
    requestId: 'page-probe-1'
  });
  await eventually(() => assert.ok(window.messages.some((message) =>
    message.type === 'force-poll-result'
      && message.payload.requestId === 'page-probe-1'
      && message.payload.ok === true)));

  fetchMode = 'partial';
  window.messages.length = 0;
  window.dispatchMessage({
    source: 'debot-social-relay',
    type: 'force-poll',
    requestId: 'page-partial-probe'
  });
  await eventually(() => assert.ok(window.messages.some((message) =>
    message.type === 'posts'
      && message.payload.posts.some((post) => post.externalId === 'partial-poll-document'))));
  await eventually(() => assert.ok(window.messages.some((message) =>
    message.type === 'force-poll-result'
      && message.payload.requestId === 'page-partial-probe'
      && message.payload.ok === false
      && message.payload.errorType === 'DEBOT')));
  const partialHeartbeat = window.messages.findLast((message) => message.type === 'heartbeat');
  assert.deepEqual(Array.from(partialHeartbeat.payload.capabilities), ['debot-analysis-v1']);
  assert.equal(Object.hasOwn(partialHeartbeat.payload, 'error'), false);
  const partialDelivery = window.messages.find((message) =>
    message.type === 'posts'
      && message.payload.posts.some((post) => post.externalId === 'partial-poll-document'));
  window.dispatchMessage({
    source: 'debot-social-relay',
    type: 'posts-delivery-result',
    payload: { deliveryId: partialDelivery.payload.deliveryId, ok: true }
  });
  fetchMode = 'ok';

  fetchMode = 'deferred-featured';
  window.messages.length = 0;
  window.dispatchMessage({
    source: 'debot-social-relay',
    type: 'force-poll',
    requestId: 'page-deferred-featured-probe'
  });
  await eventually(() => assert.ok(window.messages.some((message) =>
    message.type === 'posts'
      && message.payload.posts.some((post) => post.externalId === 'immediate-poll-document'))));
  assert.equal(window.messages.some((message) =>
    message.type === 'force-poll-result'
      && message.payload.requestId === 'page-deferred-featured-probe'), false);
  assert.equal(typeof resolveDeferredFeatured, 'function');
  resolveDeferredFeatured();
  await eventually(() => assert.ok(window.messages.some((message) =>
    message.type === 'force-poll-result'
      && message.payload.requestId === 'page-deferred-featured-probe'
      && message.payload.ok === true)));
  const immediateDelivery = window.messages.find((message) =>
    message.type === 'posts'
      && message.payload.posts.some((post) => post.externalId === 'immediate-poll-document'));
  window.dispatchMessage({
    source: 'debot-social-relay',
    type: 'posts-delivery-result',
    payload: { deliveryId: immediateDelivery.payload.deliveryId, ok: true }
  });
  fetchMode = 'ok';

  calls.length = 0;
  window.messages.length = 0;
  const socket = new window.WebSocket('wss://debot.ai/social');
  const incoming = {
    doc_id: 'document-1',
    platform: 0,
    sub_token: 'must-not-leave-the-page',
    authorization: 'Bearer must-not-leave-the-page',
    cookie: 'session=must-not-leave-the-page',
    user: { id: 'user-1', username: 'alice', name: 'Alice', followers_count: 123 },
    tweet: { tweet_id: 'tweet-1', text: 'Robinhood CA', date: 1_784_300_000 },
    mentioned_ca: [{ ca_address: '0x1111111111111111111111111111111111111111', chain: 'robinhood' }]
  };
  socket.receive(`42${JSON.stringify([
    'social-user-twitter',
    { Payload: JSON.stringify({ data: incoming }) }
  ])}`);
  const myPosts = window.messages.find((message) => message.type === 'posts');
  assert.equal(myPosts.payload.posts[0].externalId, 'document-1');
  assert.deepEqual(Array.from(myPosts.payload.posts[0].feedSources), ['my']);
  assert.equal(Object.hasOwn(myPosts.payload.posts[0], 'raw'), false);
  assert.equal(JSON.stringify(myPosts).includes('must-not-leave-the-page'), false);
  assert.ok(myPosts.payload.deliveryId);
  window.dispatchMessage({
    source: 'debot-social-relay',
    type: 'posts-delivery-result',
    payload: { deliveryId: myPosts.payload.deliveryId, ok: true }
  });
  const acknowledgedCount = window.messages.filter((message) => message.type === 'posts').length;
  socket.receive(`42${JSON.stringify([
    'social-user-twitter',
    { Payload: JSON.stringify({ data: incoming }) }
  ])}`);
  assert.equal(window.messages.filter((message) => message.type === 'posts').length, acknowledgedCount);

  socket.receive(`42${JSON.stringify([
    'social-hot-twitter',
    { Payload: JSON.stringify({ data: { ...incoming, doc_id: 'document-2' } }) }
  ])}`);
  const featured = window.messages
    .filter((message) => message.type === 'posts')
    .find((message) => message.payload.posts[0].externalId === 'document-2');
  assert.deepEqual(Array.from(featured.payload.posts[0].feedSources), ['featured']);

  const retryPayload = { ...incoming, doc_id: 'document-retry', tweet: { ...incoming.tweet, tweet_id: 'tweet-retry' } };
  socket.receive(`42${JSON.stringify([
    'social-user-twitter',
    { Payload: JSON.stringify({ data: retryPayload }) }
  ])}`);
  const firstRetry = window.messages
    .filter((message) => message.type === 'posts')
    .find((message) => message.payload.posts[0].externalId === 'document-retry');
  window.dispatchMessage({
    source: 'debot-social-relay',
    type: 'posts-delivery-result',
    payload: { deliveryId: firstRetry.payload.deliveryId, ok: false }
  });
  const beforeRetry = window.messages.filter((message) =>
    message.type === 'posts' && message.payload.posts[0].externalId === 'document-retry').length;
  runPageTimer(2_000);
  assert.equal(window.messages.filter((message) =>
    message.type === 'posts' && message.payload.posts[0].externalId === 'document-retry').length, beforeRetry + 1);

  calls.length = 0;
  window.dispatchMessage({
    source: 'debot-social-relay',
    type: 'command',
    command: { id: 7, type: 'watchlist.add', payload: { platform: 'twitter', handle: '@bob' } }
  });
  await eventually(() => assert.ok(window.messages.some((message) =>
    message.type === 'command-result' && message.payload.commandId === 7)));
  const add = calls.find((call) => call.url === '/api/social/subscribe/custom/add');
  assert.equal(add.options.method, 'POST');
  assert.deepEqual(JSON.parse(add.options.body), { tweet_username: 'bob', platform: 0 });

  calls.length = 0;
  window.dispatchMessage({
    source: 'debot-social-relay',
    type: 'command',
    command: { id: 9, type: 'watchlist.add', payload: { platform: 'twitter', handle: '@bob' } }
  });
  await eventually(() => assert.ok(window.messages.some((message) =>
    message.type === 'command-result' && message.payload.commandId === 9)));
  assert.equal(calls.some((call) => call.url === '/api/social/subscribe/custom/add'), false);

  calls.length = 0;
  window.dispatchMessage({
    source: 'debot-social-relay',
    type: 'command',
    command: { id: 8, type: 'watchlist.delete', payload: { platform: 'twitter', handle: 'alice', remoteId: '42' } }
  });
  await eventually(() => assert.ok(window.messages.some((message) =>
    message.type === 'command-result' && message.payload.commandId === 8)));
  const remove = calls.find((call) => call.url === '/api/social/subscribe/remove');
  assert.deepEqual(JSON.parse(remove.options.body), { config_ids: [42] });

  calls.length = 0;
  window.dispatchMessage({
    source: 'debot-social-relay',
    type: 'command',
    command: { id: 10, type: 'watchlist.delete', payload: { platform: 'twitter', handle: 'alice', remoteId: '42' } }
  });
  await eventually(() => assert.ok(window.messages.some((message) =>
    message.type === 'command-result' && message.payload.commandId === 10)));
  assert.equal(calls.some((call) => call.url === '/api/social/subscribe/remove'), false);

  calls.length = 0;
  window.dispatchMessage({
    source: 'debot-social-relay',
    type: 'command',
    command: { id: 11, type: 'watchlist.delete', payload: { platform: 'twitter', handle: 'alice', remoteId: '' } }
  });
  await eventually(() => assert.ok(window.messages.some((message) =>
    message.type === 'command-result' && message.payload.commandId === 11)));
  assert.equal(calls.some((call) => call.url === '/api/social/subscribe/remove'), false);

  fetchMode = 'auth';
  window.dispatchMessage({
    source: 'debot-social-relay',
    type: 'force-poll',
    requestId: 'page-auth-probe'
  });
  await eventually(() => assert.ok(window.messages.some((message) =>
    message.type === 'force-poll-result'
      && message.payload.requestId === 'page-auth-probe'
      && message.payload.ok === false
      && message.payload.errorType === 'AUTH')));
  const errorHeartbeat = window.messages.findLast((message) =>
    message.type === 'heartbeat' && message.payload.capabilities.includes('error'));
  assert.equal(errorHeartbeat.payload.error, 'AUTH');
  assert.equal(JSON.stringify(errorHeartbeat).includes('must-not-leave-the-page'), false);
});

test('DeBot page bridge executes fixed analysis jobs with sanitized results and four-worker concurrency', async () => {
  const window = new FakeWindow('https://debot.ai');
  const calls = [];
  const token = '0x1111111111111111111111111111111111111111';
  const wallet = '0x2222222222222222222222222222222222222222';
  const pairAddress = '0x3333333333333333333333333333333333333333';
  let deferWalletJobs = false;
  let tokenDetailMode = 'ok';
  let walletAnalysisMode = 'ok';
  let activeWalletRequests = 0;
  let maximumActiveWalletRequests = 0;
  const deferredWalletRequests = [];
  const tokenDetail = {
    token: {
      meta: {
        chain: 'robinhood',
        address: token,
        creator_address: wallet,
        symbol: 'SAFE',
        name: 'Safe Token',
        decimals: 18,
        creation_timestamp: 1_780_000_000,
        cookie: 'analysis-cookie-must-not-leave'
      },
      social: {
        logo_cache: 'https://cdn.example/token.png',
        authorization: 'analysis-auth-must-not-leave'
      }
    },
    pair: {
      chain: 'robinhood',
      tokenAddress: token,
      tokenPairAddress: pairAddress,
      tokenSymbol: 'SAFE',
      market_cap: 123_456,
      dex: { dex_name: 'Noxa', sub_token: 'analysis-session-must-not-leave' },
      arbitraryRaw: { private: true }
    },
    market_metrics: { price: 0.001, mkt_cap: 123_456, holders: 789, unknown: 'drop-me' },
    pools: {
      list: [{
        pair: pairAddress,
        dex_name: 'Noxa',
        liquidity: 50_000,
        base_token: { symbol: 'WETH', address: wallet, cookie: 'drop-me' },
        arbitraryRaw: true
      }]
    },
    cookie: 'analysis-cookie-must-not-leave',
    authorization: 'analysis-auth-must-not-leave',
    sub_token: 'analysis-session-must-not-leave',
    arbitraryRaw: { private: true }
  };
  const walletAnalysis = {
    chain: 'robinhood',
    wallet,
    token,
    buy_amount: '12.5',
    realized_profit: '44.25',
    profit_rate: '1.75',
    first_funding: {
      from: pairAddress,
      tx_hash: '0xfeed',
      cookie: 'analysis-cookie-must-not-leave'
    },
    cookie: 'analysis-cookie-must-not-leave',
    authorization: 'analysis-auth-must-not-leave',
    sub_token: 'analysis-session-must-not-leave',
    arbitraryRaw: { private: true }
  };

  const fetchImpl = async (url, options = {}) => {
    const requestUrl = String(url);
    calls.push({ url: requestUrl, options });
    if (requestUrl.startsWith('/api/social/subscribe/list?')) return jsonResponse({ list: [] });
    if (requestUrl.startsWith('/api/social/twitter/')) return jsonResponse({ feeds: [] });
    if (requestUrl === `/api/dashboard/token/detail?chain=robinhood&token=${token}`) {
      if (tokenDetailMode === 'null') return jsonResponse(null);
      if (tokenDetailMode === 'mismatch') {
        return jsonResponse({
          ...tokenDetail,
          token: { ...tokenDetail.token, meta: { ...tokenDetail.token.meta, address: pairAddress } },
          pair: { ...tokenDetail.pair, tokenAddress: pairAddress }
        });
      }
      return jsonResponse(tokenDetail);
    }
    if (requestUrl === `/api/dex/profit/wallet_token_analysis?chain=robinhood&token=${token}&wallet=${wallet}`) {
      if (walletAnalysisMode === 'array') return jsonResponse([]);
      if (walletAnalysisMode === 'mismatch') return jsonResponse({ ...walletAnalysis, wallet: pairAddress });
      if (!deferWalletJobs) return jsonResponse(walletAnalysis);
      activeWalletRequests += 1;
      maximumActiveWalletRequests = Math.max(maximumActiveWalletRequests, activeWalletRequests);
      return new Promise((resolve) => {
        deferredWalletRequests.push(() => {
          activeWalletRequests -= 1;
          resolve(jsonResponse(walletAnalysis));
        });
      });
    }
    throw new Error(`Unexpected DeBot endpoint: ${requestUrl}`);
  };
  vm.runInNewContext(bridgeSource('debot-page.js'), {
    window,
    document: { visibilityState: 'hidden' },
    fetch: fetchImpl,
    setInterval: () => 1,
    setTimeout,
    clearTimeout,
    URLSearchParams,
    URL,
    console
  }, { filename: 'debot-page.js' });

  await eventually(() => assert.ok(window.messages.some((message) => message.type === 'heartbeat')));
  window.messages.length = 0;
  calls.length = 0;

  window.dispatchMessage({
    source: 'debot-social-relay',
    type: 'analysis-job',
    job: {
      id: 101,
      type: 'debot.token_detail.v1',
      claimToken: 'token-claim',
      payload: { chain: 'robinhood', token }
    }
  });
  await eventually(() => assert.ok(window.messages.some((message) =>
    message.type === 'analysis-result' && message.payload.jobId === 101)));
  const tokenCall = calls.find((call) => call.url.startsWith('/api/dashboard/token/detail?'));
  assert.equal(tokenCall.url, `/api/dashboard/token/detail?chain=robinhood&token=${token}`);
  assert.equal(tokenCall.options.credentials, 'include');
  assert.equal(tokenCall.options.method ?? 'GET', 'GET');
  const tokenResult = window.messages.find((message) =>
    message.type === 'analysis-result' && message.payload.jobId === 101);
  assert.equal(tokenResult.payload.success, true);
  assert.equal(tokenResult.payload.result.token.meta.address, token);
  assert.equal(tokenResult.payload.result.pair.market_cap, 123_456);
  assert.equal(/analysis-(?:cookie|auth|session)-must-not-leave/.test(JSON.stringify(tokenResult)), false);
  assert.equal(JSON.stringify(tokenResult).includes('arbitraryRaw'), false);

  window.dispatchMessage({
    source: 'debot-social-relay',
    type: 'analysis-job',
    job: {
      id: 102,
      type: 'debot.wallet_token_analysis.v1',
      claimToken: 'wallet-claim',
      payload: { chain: 'robinhood', token, wallet }
    }
  });
  await eventually(() => assert.ok(window.messages.some((message) =>
    message.type === 'analysis-result' && message.payload.jobId === 102)));
  const walletCall = calls.find((call) => call.url.startsWith('/api/dex/profit/wallet_token_analysis?'));
  assert.equal(
    walletCall.url,
    `/api/dex/profit/wallet_token_analysis?chain=robinhood&token=${token}&wallet=${wallet}`
  );
  assert.equal(walletCall.options.credentials, 'include');
  assert.equal(walletCall.options.method ?? 'GET', 'GET');
  const walletResult = window.messages.find((message) =>
    message.type === 'analysis-result' && message.payload.jobId === 102);
  assert.equal(walletResult.payload.success, true);
  assert.equal(walletResult.payload.result.realized_profit, 44.25);
  assert.equal(/analysis-(?:cookie|auth|session)-must-not-leave/.test(JSON.stringify(walletResult)), false);
  assert.equal(JSON.stringify(walletResult).includes('arbitraryRaw'), false);

  tokenDetailMode = 'mismatch';
  walletAnalysisMode = 'array';
  window.dispatchMessage({
    source: 'debot-social-relay',
    type: 'analysis-job',
    job: {
      id: 105,
      type: 'debot.token_detail.v1',
      claimToken: 'mismatched-token-result',
      payload: { chain: 'robinhood', token }
    }
  });
  window.dispatchMessage({
    source: 'debot-social-relay',
    type: 'analysis-job',
    job: {
      id: 106,
      type: 'debot.wallet_token_analysis.v1',
      claimToken: 'array-wallet-result',
      payload: { chain: 'robinhood', token, wallet }
    }
  });
  await eventually(() => {
    const failures = window.messages.filter((message) =>
      message.type === 'analysis-result' && [105, 106].includes(message.payload.jobId));
    assert.equal(failures.length, 2);
    assert.equal(failures.every((message) => message.payload.errorType === 'DEBOT'), true);
  });
  tokenDetailMode = 'null';
  walletAnalysisMode = 'mismatch';
  window.dispatchMessage({
    source: 'debot-social-relay',
    type: 'analysis-job',
    job: {
      id: 107,
      type: 'debot.token_detail.v1',
      claimToken: 'null-token-result',
      payload: { chain: 'robinhood', token }
    }
  });
  window.dispatchMessage({
    source: 'debot-social-relay',
    type: 'analysis-job',
    job: {
      id: 108,
      type: 'debot.wallet_token_analysis.v1',
      claimToken: 'mismatched-wallet-result',
      payload: { chain: 'robinhood', token, wallet }
    }
  });
  await eventually(() => {
    const failures = window.messages.filter((message) =>
      message.type === 'analysis-result' && [107, 108].includes(message.payload.jobId));
    assert.equal(failures.length, 2);
    assert.equal(failures.every((message) => message.payload.errorType === 'DEBOT'), true);
  });
  tokenDetailMode = 'ok';
  walletAnalysisMode = 'ok';

  const analysisFetchCount = calls.filter((call) => !call.url.startsWith('/api/social/')).length;
  window.dispatchMessage({
    source: 'debot-social-relay',
    type: 'analysis-job',
    job: {
      id: 103,
      type: 'debot.token_detail.v1',
      claimToken: 'invalid-chain',
      payload: { chain: 'base', token }
    }
  });
  window.dispatchMessage({
    source: 'debot-social-relay',
    type: 'analysis-job',
    job: {
      id: 104,
      type: 'debot.wallet_token_analysis.v1',
      claimToken: 'invalid-wallet',
      payload: { chain: 'robinhood', token, wallet: '0x1234' }
    }
  });
  await eventually(() => {
    const failures = window.messages.filter((message) =>
      message.type === 'analysis-result' && [103, 104].includes(message.payload.jobId));
    assert.equal(failures.length, 2);
    assert.equal(failures.every((message) => message.payload.errorType === 'INVALID_JOB'), true);
  });
  assert.equal(calls.filter((call) => !call.url.startsWith('/api/social/')).length, analysisFetchCount);

  deferWalletJobs = true;
  window.messages.length = 0;
  for (let index = 0; index < 5; index += 1) {
    window.dispatchMessage({
      source: 'debot-social-relay',
      type: 'analysis-job',
      job: {
        id: 200 + index,
        type: 'debot.wallet_token_analysis.v1',
        claimToken: `parallel-claim-${index}`,
        payload: { chain: 'robinhood', token, wallet }
      }
    });
  }
  await eventually(() => assert.equal(deferredWalletRequests.length, 4));
  assert.equal(activeWalletRequests, 4);
  assert.equal(maximumActiveWalletRequests, 4);
  assert.equal(window.messages.some((message) =>
    message.type === 'analysis-result' && message.payload.jobId === 204), false);
  deferredWalletRequests[0]();
  await eventually(() => assert.equal(deferredWalletRequests.length, 5));
  assert.equal(activeWalletRequests, 4);
  assert.equal(maximumActiveWalletRequests, 4);
  for (const resolveRequest of deferredWalletRequests.slice(1)) resolveRequest();
  await eventually(() => assert.equal(window.messages.filter((message) =>
    message.type === 'analysis-result' && message.payload.jobId >= 200 && message.payload.jobId <= 204).length, 5));
});

test('relay transports only supported page events and delivers claimed commands to the page world', async () => {
  const window = new FakeWindow('https://debot.ai');
  const runtimeMessages = [];
  let runtimeListener = null;
  const chrome = {
    runtime: {
      id: 'extension-test-id',
      async sendMessage(message) {
        runtimeMessages.push(message);
        if (message.type === 'poll-commands') {
          return { ok: true, payload: { commands: [{ id: 9, type: 'watchlist.add', payload: { handle: 'bob' } }] } };
        }
        if (message.type === 'posts' && message.payload?.deliveryId === 'delivery-not-durable') {
          return { ok: true, payload: {} };
        }
        return { ok: true, payload: { durable: true } };
      },
      onMessage: {
        addListener(value) {
          runtimeListener = value;
        }
      }
    }
  };
  vm.runInNewContext(bridgeSource('debot-relay.js'), {
    window,
    chrome,
    setInterval: () => 1,
    setTimeout,
    clearTimeout
  }, { filename: 'debot-relay.js' });

  await eventually(() => assert.ok(window.messages.some((message) =>
    message.source === 'debot-social-relay' && message.type === 'command')));
  window.dispatchMessage({
    source: 'debot-social-page',
    type: 'posts',
    payload: { posts: [{ externalId: 'relay-post' }], deliveryId: 'delivery-1' }
  });
  await eventually(() => assert.ok(runtimeMessages.some((message) =>
    message.source === 'debot-social-relay' && message.type === 'posts')));
  await eventually(() => assert.ok(window.messages.some((message) =>
    message.source === 'debot-social-relay'
      && message.type === 'posts-delivery-result'
      && message.payload.deliveryId === 'delivery-1'
      && message.payload.ok === true)));

  window.dispatchMessage({
    source: 'debot-social-page',
    type: 'posts',
    payload: { posts: [{ externalId: 'not-durable' }], deliveryId: 'delivery-not-durable' }
  });
  await eventually(() => assert.ok(window.messages.some((message) =>
    message.source === 'debot-social-relay'
      && message.type === 'posts-delivery-result'
      && message.payload.deliveryId === 'delivery-not-durable'
      && message.payload.ok === false)));

  assert.equal(typeof runtimeListener, 'function');
  const forced = new Promise((resolve) => {
    assert.equal(runtimeListener({
      source: 'debot-social-background',
      type: 'force-poll',
      requestId: 'relay-probe-1'
    }, { id: 'extension-test-id' }, resolve), true);
  });
  await eventually(() => assert.ok(window.messages.some((message) =>
    message.source === 'debot-social-relay'
      && message.type === 'force-poll'
      && message.requestId === 'relay-probe-1')));
  window.dispatchMessage({
    source: 'debot-social-page',
    type: 'force-poll-result',
    payload: { requestId: 'relay-probe-1', ok: true }
  });
  const forcedResult = await forced;
  assert.equal(forcedResult.ok, true);
  assert.equal(forcedResult.requestId, 'relay-probe-1');

  const before = runtimeMessages.length;
  window.dispatchMessage({ source: 'unknown-page', type: 'posts', payload: {} });
  assert.equal(runtimeMessages.length, before);
});

test('relay claims at most four analysis jobs, validates claim tokens and refills immediately', async () => {
  const window = new FakeWindow('https://debot.ai');
  const runtimeMessages = [];
  const jobs = Array.from({ length: 5 }, (_, index) => ({
    id: 300 + index,
    type: 'debot.wallet_token_analysis.v1',
    claimToken: `relay-claim-${index}`,
    payload: {
      chain: 'robinhood',
      token: '0x1111111111111111111111111111111111111111',
      wallet: '0x2222222222222222222222222222222222222222'
    },
    leaseExpiresAt: Date.now() + 60_000
  }));
  const staleJob = {
    ...jobs[0],
    id: 299,
    claimToken: 'expired-relay-claim',
    deadlineAt: Date.now() + 60_000,
    leaseExpiresAt: Date.now() - 1
  };
  let claimCount = 0;
  const chrome = {
    runtime: {
      id: 'extension-test-id',
      async sendMessage(message) {
        runtimeMessages.push(message);
        if (message.type === 'poll-commands') return { ok: true, payload: { commands: [] } };
        if (message.type === 'poll-analysis-jobs') {
          claimCount += 1;
          if (claimCount === 1) return { ok: true, payload: { jobs: [staleJob, ...jobs.slice(0, 4)] } };
          if (claimCount === 2) return { ok: true, payload: { jobs: [jobs[4]] } };
          return { ok: true, payload: { jobs: [] } };
        }
        if (message.type === 'analysis-result') return { ok: true, payload: { durable: true } };
        return { ok: true, payload: {} };
      },
      onMessage: { addListener() {} }
    }
  };
  vm.runInNewContext(bridgeSource('debot-relay.js'), {
    window,
    chrome,
    setInterval: () => 1,
    setTimeout,
    clearTimeout
  }, { filename: 'debot-relay.js' });

  await eventually(() => assert.equal(window.messages.filter((message) => message.type === 'analysis-job').length, 4));
  const firstClaim = runtimeMessages.find((message) => message.type === 'poll-analysis-jobs');
  assert.equal(firstClaim.payload.limit, 4);
  assert.equal(window.messages.some((message) => message.type === 'analysis-job' && message.job.id === staleJob.id), false);
  assert.equal(window.messages.some((message) => message.type === 'analysis-job' && message.job.id === 304), false);

  const resultCount = runtimeMessages.filter((message) => message.type === 'analysis-result').length;
  window.dispatchMessage({
    source: 'debot-social-page',
    type: 'analysis-result',
    payload: {
      jobId: jobs[0].id,
      claimToken: 'wrong-claim-token',
      success: false,
      result: null,
      error: 'DEBOT',
      errorType: 'DEBOT'
    }
  });
  await new Promise((resolve) => setTimeout(resolve, 0));
  assert.equal(runtimeMessages.filter((message) => message.type === 'analysis-result').length, resultCount);

  window.dispatchMessage({
    source: 'debot-social-page',
    type: 'analysis-result',
    payload: {
      jobId: jobs[0].id,
      claimToken: jobs[0].claimToken,
      success: true,
      result: {
        chain: 'robinhood',
        token: jobs[0].payload.token,
        wallet: jobs[0].payload.wallet,
        realized_profit: 12
      },
      error: '',
      errorType: ''
    }
  });
  await eventually(() => assert.ok(runtimeMessages.some((message) =>
    message.type === 'analysis-result'
      && message.payload.jobId === jobs[0].id
      && message.payload.claimToken === jobs[0].claimToken)));
  await eventually(() => assert.ok(window.messages.some((message) =>
    message.type === 'analysis-job' && message.job.id === jobs[4].id)));
  const claims = runtimeMessages.filter((message) => message.type === 'poll-analysis-jobs');
  assert.equal(claims.length >= 2, true);
  assert.equal(claims[1].payload.limit, 1);
});

test('Radar content bridge announces readiness only when the extension has a configured token', async () => {
  const window = new FakeWindow('http://217.116.171.250');
  const runtimeMessages = [];
  let configured = false;
  const chrome = {
    runtime: {
      async sendMessage(message) {
        runtimeMessages.push(message);
        if (message.type === 'status') {
          return { ok: true, payload: { configured } };
        }
        return { ok: true, payload: { accepted: true } };
      }
    }
  };
  vm.runInNewContext(bridgeSource('radar-content.js'), {
    window,
    chrome,
    setTimeout: () => 1
  }, { filename: 'radar-content.js' });

  await eventually(() => assert.ok(window.messages.some((message) =>
    message.source === 'robinhood-social-bridge' && message.type === 'ready')));
  assert.equal(window.messages.find((message) => message.type === 'ready').configured, false);

  configured = true;
  window.messages.length = 0;
  for (const listener of window.listeners.get('DOMContentLoaded') || []) listener();
  await eventually(() => assert.equal(window.messages.find((message) => message.type === 'ready')?.configured, true));

  window.dispatchMessage({
    source: 'robinhood-radar',
    type: 'social-command',
    requestId: 'request-1',
    command: { method: 'POST', path: '/watchlist/batch', body: { accounts: [] } }
  });
  await eventually(() => assert.ok(window.messages.some((message) =>
    message.source === 'robinhood-social-bridge' && message.type === 'response')));
  assert.ok(runtimeMessages.some((message) => message.type === 'status'));
  assert.ok(runtimeMessages.some((message) => message.type === 'api'));
});

test('background uses the bridge secret only as authorization and submits allowlisted social data', async (t) => {
  const saved = {
    serverBase: 'https://radar.217-116-171-250.sslip.io/robinhood-radar/api/social',
    bridgeToken: 'unit-bridge-secret'
  };
  const requests = [];
  let listener = null;
  let alarmListener = null;
  let installedListener = null;
  let startupListener = null;
  const sessionSaved = {};
  const accessLevels = {};
  const alarms = [];
  const tabCalls = { query: 0, sendMessage: 0, reload: 0, create: 0, update: 0 };
  const fakeTabs = [{ id: 17, url: 'https://debot.ai/', pinned: true, discarded: false, status: 'complete' }];
  let tabSendMode = 'healthy';
  let failPostRequests = false;
  let postResponseMode = 'ok';
  let resolveDeferredPost = null;
  let failAnalysisResultRequests = false;
  let analysisResultResponseStatus = 200;
  const analysisJob = {
    id: 901,
    type: 'debot.token_detail.v1',
    claimToken: 'background-claim',
    payload: {
      chain: 'robinhood',
      token: '0x1111111111111111111111111111111111111111'
    },
    leaseExpiresAt: Date.now() + 60_000
  };
  const previousChrome = globalThis.chrome;
  const previousFetch = globalThis.fetch;
  globalThis.chrome = {
    storage: {
      local: {
        async setAccessLevel(value) {
          accessLevels.local = value.accessLevel;
        },
        async get(keys) {
          const names = Array.isArray(keys) ? keys : [keys];
          return Object.fromEntries(names.filter((key) => Object.hasOwn(saved, key)).map((key) => [key, saved[key]]));
        },
        async set(value) {
          Object.assign(saved, value);
        }
      },
      session: {
        async setAccessLevel(value) {
          accessLevels.session = value.accessLevel;
        },
        async get(keys) {
          const names = Array.isArray(keys) ? keys : [keys];
          return Object.fromEntries(names.filter((key) => Object.hasOwn(sessionSaved, key)).map((key) => [key, sessionSaved[key]]));
        },
        async set(value) {
          Object.assign(sessionSaved, value);
        }
      }
    },
    alarms: {
      create(name, options) {
        alarms.push({ name, options });
      },
      onAlarm: {
        addListener(value) {
          alarmListener = value;
        }
      }
    },
    tabs: {
      async query() {
        tabCalls.query += 1;
        return fakeTabs.map((tab) => ({ ...tab }));
      },
      async sendMessage(_tabId, message) {
        tabCalls.sendMessage += 1;
        if (tabSendMode === 'missing') throw new Error('Receiving end does not exist');
        if (tabSendMode === 'network') return { ok: false, requestId: message.requestId, errorType: 'NETWORK' };
        return { ok: true, requestId: message.requestId };
      },
      async reload(tabId) {
        tabCalls.reload += 1;
        const tab = fakeTabs.find((entry) => entry.id === tabId);
        if (tab) tab.status = 'loading';
      },
      async create(options) {
        tabCalls.create += 1;
        const created = { id: 18, url: options.url, pinned: options.pinned, discarded: false, status: 'loading' };
        fakeTabs.push(created);
        return { ...created };
      },
      async update() {
        tabCalls.update += 1;
        return {};
      }
    },
    action: {
      async setBadgeText() {},
      async setBadgeBackgroundColor() {}
    },
    runtime: {
      onMessage: {
        addListener(value) {
          listener = value;
        }
      },
      onInstalled: {
        addListener(value) {
          installedListener = value;
        }
      },
      onStartup: {
        addListener(value) {
          startupListener = value;
        }
      }
    }
  };
  globalThis.fetch = async (url, options) => {
    const requestUrl = String(url);
    requests.push({ url: requestUrl, options });
    const isPostRequest = /\/bridge\/posts$/.test(requestUrl);
    const isAnalysisClaimRequest = /\/bridge\/debot\/jobs\?limit=\d+$/.test(requestUrl);
    const isAnalysisResultRequest = /\/bridge\/debot\/jobs\/\d+\/result$/.test(requestUrl);
    if (failPostRequests && isPostRequest) {
      throw new TypeError('temporary network failure');
    }
    if (failAnalysisResultRequests && isAnalysisResultRequest) {
      throw new TypeError('temporary analysis network failure');
    }
    const responseStatus = isAnalysisResultRequest ? analysisResultResponseStatus : 200;
    return {
      ok: responseStatus >= 200 && responseStatus < 300,
      status: responseStatus,
      async text() {
        if (isPostRequest && postResponseMode === 'negative') return JSON.stringify({ ok: false });
        if (isPostRequest && postResponseMode === 'invalid') return '<html>temporary proxy page</html>';
        if (isPostRequest && postResponseMode === 'deferred') {
          return new Promise((resolve) => {
            resolveDeferredPost = () => resolve(JSON.stringify({ ok: true }));
          });
        }
        if (isAnalysisClaimRequest) return JSON.stringify({ ok: true, jobs: [analysisJob] });
        if (isAnalysisResultRequest && responseStatus >= 400) {
          return JSON.stringify({ error: 'analysis result is permanently invalid' });
        }
        return JSON.stringify({ ok: true, commands: [] });
      }
    };
  };
  t.after(() => {
    if (previousChrome === undefined) delete globalThis.chrome;
    else globalThis.chrome = previousChrome;
    globalThis.fetch = previousFetch;
  });

  const moduleUrl = `${pathToFileURL(path.join(bridgeDirectory, 'background.js')).href}?test=${Date.now()}`;
  await import(moduleUrl);
  assert.equal(typeof listener, 'function');
  assert.equal(accessLevels.local, 'TRUSTED_CONTEXTS');
  assert.equal(accessLevels.session, 'TRUSTED_CONTEXTS');
  assert.equal(typeof alarmListener, 'function');
  assert.equal(typeof installedListener, 'function');
  assert.equal(typeof startupListener, 'function');
  assert.ok(alarms.some((alarm) => alarm.name === 'debot-social-bridge-recovery'
    && alarm.options.periodInMinutes === 0.5));
  const alarmCount = alarms.length;
  installedListener();
  startupListener();
  assert.equal(alarms.length, alarmCount + 2);
  assert.equal(alarms.slice(-2).every((alarm) => alarm.name === 'debot-social-bridge-recovery'), true);
  const send = (message, sender = {}) => new Promise((resolve) => {
    assert.equal(listener(message, sender, resolve), true);
  });

  const settings = await send({ source: 'bridge-options', type: 'get-settings' });
  assert.equal(settings.ok, true);
  assert.equal(settings.payload.bridgeToken, 'configured');
  assert.equal(JSON.stringify(settings).includes(saved.bridgeToken), false);

  const contentStatus = await send({ source: 'robinhood-radar-content', type: 'status' });
  assert.equal(contentStatus.ok, true);
  assert.deepEqual(contentStatus.payload, { configured: true });
  assert.equal(JSON.stringify(contentStatus).includes(saved.bridgeToken), false);

  const invalidServer = await send({
    source: 'bridge-options',
    type: 'save-settings',
    payload: { serverBase: 'https://debot.ai/api/social' }
  });
  assert.equal(invalidServer.ok, false);
  assert.match(invalidServer.error, /Robinhood Radar API/);

  const insecureServer = await send({
    source: 'bridge-options',
    type: 'save-settings',
    payload: { serverBase: 'http://217.116.171.250/robinhood-radar/api/social/' }
  });
  assert.equal(insecureServer.ok, false);
  assert.match(insecureServer.error, /Robinhood Radar API/);
  assert.equal(saved.serverBase, 'https://radar.217-116-171-250.sslip.io/robinhood-radar/api/social');

  fakeTabs[0].discarded = true;
  fakeTabs.push({ id: 19, url: 'https://debot.ai/', pinned: false, discarded: false, status: 'complete' });
  sessionSaved.debotSocialBridgeRecoveryV1 = {
    managedTabId: 17,
    createdAt: 0,
    structuralFailures: 0,
    lastReloadAt: 0,
    reloadLevel: 0
  };
  const switchedManagedClaim = await send({
    source: 'debot-social-relay',
    type: 'poll-analysis-jobs',
    payload: { limit: 1 }
  }, { tab: { id: 19 } });
  assert.equal(switchedManagedClaim.ok, true);
  assert.equal(switchedManagedClaim.payload.jobs[0].id, analysisJob.id);
  assert.equal(sessionSaved.debotSocialBridgeRecoveryV1.managedTabId, 19);
  fakeTabs[0].discarded = false;
  fakeTabs.splice(1);
  sessionSaved.debotSocialBridgeRecoveryV1 = {
    ...sessionSaved.debotSocialBridgeRecoveryV1,
    managedTabId: 17
  };

  const claimRequestCount = requests.filter((request) => /\/bridge\/debot\/jobs\?limit=/.test(request.url)).length;
  const unmanagedClaim = await send({
    source: 'debot-social-relay',
    type: 'poll-analysis-jobs',
    payload: { limit: 99 }
  }, { tab: { id: 999 } });
  assert.equal(unmanagedClaim.ok, true);
  assert.deepEqual(unmanagedClaim.payload, { ok: true, jobs: [], managed: false });
  assert.equal(requests.filter((request) => /\/bridge\/debot\/jobs\?limit=/.test(request.url)).length, claimRequestCount);

  const managedClaim = await send({
    source: 'debot-social-relay',
    type: 'poll-analysis-jobs',
    payload: { limit: 99 }
  }, { tab: { id: 17 } });
  assert.equal(managedClaim.ok, true);
  assert.equal(managedClaim.payload.jobs[0].id, analysisJob.id);
  const claimRequest = requests.findLast((request) => /\/bridge\/debot\/jobs\?limit=/.test(request.url));
  assert.match(claimRequest.url, /\/bridge\/debot\/jobs\?limit=4$/);

  failAnalysisResultRequests = true;
  const queuedAnalysis = await send({
    source: 'debot-social-relay',
    type: 'analysis-result',
    payload: {
      jobId: analysisJob.id,
      claimToken: analysisJob.claimToken,
      success: true,
      result: {
        token: {
          meta: {
            chain: 'robinhood',
            address: analysisJob.payload.token,
            symbol: 'SAFE',
            cookie: 'analysis-cookie-must-not-leave'
          },
          social: {
            logo_cache: 'https://cdn.example/token.png',
            authorization: 'analysis-auth-must-not-leave'
          }
        },
        pair: {
          chain: 'robinhood',
          tokenAddress: analysisJob.payload.token,
          market_cap: 123_456,
          raw: { sub_token: 'analysis-session-must-not-leave' }
        },
        market_metrics: { price: 0.001, arbitraryRaw: true },
        pools: { list: [] },
        cookie: 'analysis-cookie-must-not-leave',
        authorization: 'analysis-auth-must-not-leave',
        sub_token: 'analysis-session-must-not-leave',
        arbitraryRaw: { private: true }
      },
      error: '',
      errorType: ''
    }
  }, { tab: { id: 17 } });
  assert.equal(queuedAnalysis.ok, true);
  assert.equal(queuedAnalysis.payload.durable, true);
  await eventually(() => assert.ok(requests.some((request) =>
    /\/bridge\/debot\/jobs\/901\/result$/.test(request.url))));
  await eventually(() => assert.equal(saved.debotAnalysisResultOutboxV1?.records?.length, 1));
  const persistedAnalysis = JSON.stringify(saved.debotAnalysisResultOutboxV1);
  assert.equal(/analysis-(?:cookie|auth|session)-must-not-leave/.test(persistedAnalysis), false);
  assert.equal(persistedAnalysis.includes('arbitraryRaw'), false);
  await new Promise((resolve) => setTimeout(resolve, 0));
  failAnalysisResultRequests = false;
  const resultRequestCount = requests.filter((request) => /\/bridge\/debot\/jobs\/901\/result$/.test(request.url)).length;
  alarmListener({ name: 'debot-social-bridge-recovery' });
  await eventually(() => assert.ok(requests.filter((request) =>
    /\/bridge\/debot\/jobs\/901\/result$/.test(request.url)).length > resultRequestCount));
  await eventually(() => assert.equal(saved.debotAnalysisResultOutboxV1?.records?.length, 0));
  const resultUpload = requests.findLast((request) => /\/bridge\/debot\/jobs\/901\/result$/.test(request.url));
  const resultBody = JSON.parse(resultUpload.options.body);
  assert.deepEqual(Object.keys(resultBody).sort(), ['claimToken', 'error', 'errorType', 'result', 'success']);
  assert.equal(resultBody.claimToken, analysisJob.claimToken);
  assert.equal(resultBody.result.token.meta.address, analysisJob.payload.token);
  assert.equal(/analysis-(?:cookie|auth|session)-must-not-leave/.test(resultUpload.options.body), false);
  assert.equal(resultUpload.options.body.includes('arbitraryRaw'), false);

  analysisResultResponseStatus = 400;
  const invalidResultRequestCount = requests.filter((request) =>
    /\/bridge\/debot\/jobs\/902\/result$/.test(request.url)).length;
  const terminalAnalysis = await send({
    source: 'debot-social-relay',
    type: 'analysis-result',
    payload: {
      jobId: 902,
      claimToken: 'permanently-invalid-claim',
      success: false,
      result: null,
      error: 'DEBOT',
      errorType: 'DEBOT'
    }
  }, { tab: { id: 17 } });
  assert.equal(terminalAnalysis.ok, true);
  assert.equal(terminalAnalysis.payload.durable, true);
  await eventually(() => assert.ok(requests.filter((request) =>
    /\/bridge\/debot\/jobs\/902\/result$/.test(request.url)).length > invalidResultRequestCount));
  await eventually(() => assert.equal(saved.debotAnalysisResultOutboxV1?.records?.length, 0));
  analysisResultResponseStatus = 200;

  await send({
    source: 'debot-social-relay',
    type: 'posts',
    payload: {
      posts: [{
        source: 'twitter',
        externalId: 'safe-post',
        content: 'public content',
        author: { handle: 'alice', cookie: 'debot-cookie-value' },
        raw: { sub_token: 'debot-session-value' },
        authorization: 'Bearer debot-auth-value'
      }]
    }
  });
  await eventually(() => assert.ok(requests.some((request) => /\/bridge\/posts$/.test(request.url))));
  const postRequest = requests.findLast((request) => /\/bridge\/posts$/.test(request.url));
  assert.match(postRequest.url, /\/api\/social\/bridge\/posts$/);
  assert.equal(postRequest.options.headers.authorization, `Bearer ${saved.bridgeToken}`);
  assert.equal(postRequest.options.body.includes(saved.bridgeToken), false);
  assert.equal(/debot-(?:cookie|session|auth)-value/.test(postRequest.options.body), false);
  const postBody = JSON.parse(postRequest.options.body);
  assert.equal(Object.hasOwn(postBody.posts[0], 'raw'), false);
  assert.equal(Object.hasOwn(postBody.posts[0], 'authorization'), false);
  await eventually(() => assert.equal(saved.debotSocialPostOutboxV1?.records?.length, 0));

  postResponseMode = 'deferred';
  let postRequestCount = requests.filter((request) => /\/bridge\/posts$/.test(request.url)).length;
  await send({
    source: 'debot-social-relay',
    type: 'posts',
    payload: { posts: [{ source: 'twitter', externalId: 'flush-race-one', content: 'first durable post' }] }
  });
  await eventually(() => assert.equal(typeof resolveDeferredPost, 'function'));
  await send({
    source: 'debot-social-relay',
    type: 'posts',
    payload: { posts: [{ source: 'twitter', externalId: 'flush-race-two', content: 'second durable post' }] }
  });
  assert.equal(requests.filter((request) => /\/bridge\/posts$/.test(request.url)).length, postRequestCount + 1);
  postResponseMode = 'ok';
  resolveDeferredPost();
  await eventually(() => assert.equal(
    requests.filter((request) => /\/bridge\/posts$/.test(request.url)).length,
    postRequestCount + 2
  ));
  await eventually(() => assert.equal(saved.debotSocialPostOutboxV1?.records?.length, 0));

  await send({
    source: 'debot-social-relay',
    type: 'heartbeat',
    payload: {
      bridgeId: 'test',
      capabilities: ['posts'],
      cookie: 'debot-cookie-value',
      error: 'authorization: Bearer debot-auth-value; sub_token=debot-session-value'
    }
  });
  const heartbeatBody = requests.at(-1).options.body;
  assert.equal(/debot-(?:cookie|session|auth)-value/.test(heartbeatBody), false);
  assert.match(heartbeatBody, /\[redacted\]/);

  await send({
    source: 'debot-social-relay',
    type: 'watchlist',
    payload: {
      accounts: [{
        platform: 'twitter',
        handle: 'alice',
        metadata: { hotSubscribeId: 4, monitorLevel: 'high', sub_token: 'debot-session-value' }
      }]
    }
  });
  const watchlistBody = requests.at(-1).options.body;
  assert.equal(watchlistBody.includes('debot-session-value'), false);
  assert.equal(JSON.parse(watchlistBody).complete, true);

  failPostRequests = true;
  const queuedDuringOutage = await send({
    source: 'debot-social-relay',
    type: 'posts',
    payload: {
      posts: [{ source: 'twitter', externalId: 'queued-during-outage', content: 'public queued post' }]
    }
  });
  assert.equal(queuedDuringOutage.ok, true);
  assert.equal(queuedDuringOutage.payload.durable, true);
  await eventually(() => assert.ok(saved.debotSocialPostOutboxV1?.records?.some((record) =>
    record.post.externalId === 'queued-during-outage')));
  await new Promise((resolve) => setTimeout(resolve, 0));
  failPostRequests = false;
  alarmListener({ name: 'debot-social-bridge-recovery' });
  await eventually(() => assert.equal(saved.debotSocialPostOutboxV1?.records?.some((record) =>
    record.post.externalId === 'queued-during-outage'), false));

  postResponseMode = 'negative';
  postRequestCount = requests.filter((request) => /\/bridge\/posts$/.test(request.url)).length;
  await send({
    source: 'debot-social-relay',
    type: 'posts',
    payload: { posts: [{ source: 'twitter', externalId: 'negative-ack', content: 'must remain queued' }] }
  });
  await eventually(() => assert.ok(requests.filter((request) => /\/bridge\/posts$/.test(request.url)).length > postRequestCount));
  await eventually(() => assert.equal(saved.debotSocialPostOutboxV1?.records?.some((record) =>
    record.post.externalId === 'negative-ack'), true));
  await new Promise((resolve) => setTimeout(resolve, 0));

  postResponseMode = 'invalid';
  postRequestCount = requests.filter((request) => /\/bridge\/posts$/.test(request.url)).length;
  await send({
    source: 'debot-social-relay',
    type: 'posts',
    payload: { posts: [{ source: 'twitter', externalId: 'invalid-ack', content: 'must also remain queued' }] }
  });
  await eventually(() => assert.ok(requests.filter((request) => /\/bridge\/posts$/.test(request.url)).length > postRequestCount));
  await eventually(() => assert.equal(saved.debotSocialPostOutboxV1?.records?.some((record) =>
    record.post.externalId === 'invalid-ack'), true));
  await new Promise((resolve) => setTimeout(resolve, 0));

  postResponseMode = 'ok';
  alarmListener({ name: 'debot-social-bridge-recovery' });
  await eventually(() => assert.equal(saved.debotSocialPostOutboxV1?.records?.length, 0));

  const tabMessagesBeforeAlarm = tabCalls.sendMessage;
  alarmListener({ name: 'debot-social-bridge-recovery' });
  await eventually(() => assert.ok(tabCalls.sendMessage > tabMessagesBeforeAlarm));
  assert.equal(tabCalls.reload, 0);
  assert.equal(tabCalls.create, 0);

  tabSendMode = 'network';
  const networkProbeCount = tabCalls.sendMessage;
  alarmListener({ name: 'debot-social-bridge-recovery' });
  await eventually(() => assert.ok(tabCalls.sendMessage > networkProbeCount));
  assert.equal(tabCalls.reload, 0);

  tabSendMode = 'missing';
  fakeTabs[0].status = 'loading';
  sessionSaved.debotSocialBridgeRecoveryV1 = {
    managedTabId: fakeTabs[0].id,
    createdAt: Date.now() - 60_000,
    structuralFailures: 0,
    lastReloadAt: 0,
    reloadLevel: 0
  };
  let queryCount = tabCalls.query;
  alarmListener({ name: 'debot-social-bridge-recovery' });
  await eventually(() => assert.equal(sessionSaved.debotSocialBridgeRecoveryV1?.structuralFailures, 1));
  assert.equal(tabCalls.reload, 0);
  queryCount = tabCalls.query;
  alarmListener({ name: 'debot-social-bridge-recovery' });
  await eventually(() => assert.ok(tabCalls.query > queryCount));
  assert.equal(tabCalls.reload, 1);
  await eventually(() => assert.ok(sessionSaved.debotSocialBridgeRecoveryV1?.lastReloadAt > 0));

  fakeTabs.length = 0;
  tabSendMode = 'healthy';
  queryCount = tabCalls.query;
  alarmListener({ name: 'debot-social-bridge-recovery' });
  alarmListener({ name: 'debot-social-bridge-recovery' });
  await eventually(() => assert.ok(tabCalls.query > queryCount && tabCalls.create === 1));
  assert.equal(fakeTabs[0].pinned, true);
  assert.equal(tabCalls.create, 1);

  const activeToken = saved.bridgeToken;
  const activeServer = saved.serverBase;
  const repeatedMigration = await send({
    source: 'bridge-options',
    type: 'migrate-local-settings',
    payload: {
      serverBase: 'https://radar.217-116-171-250.sslip.io/robinhood-radar/api/social',
      bridgeToken: 'stale-local-token'
    }
  });
  assert.equal(repeatedMigration.ok, true);
  assert.equal(repeatedMigration.payload.bridgeToken, 'configured');
  assert.equal(saved.bridgeToken, activeToken);
  assert.equal(saved.serverBase, activeServer);

  saved.bridgeToken = '';
  saved.serverBase = 'http://217.116.171.250/robinhood-radar/api/social';
  const migration = send({
    source: 'bridge-options',
    type: 'migrate-local-settings',
    payload: {
      serverBase: 'https://radar.217-116-171-250.sslip.io/robinhood-radar/api/social',
      bridgeToken: 'stale-local-token'
    }
  });
  const manualSave = send({
    source: 'bridge-options',
    type: 'save-settings',
    payload: { bridgeToken: 'new-manual-token' }
  });
  const [migrationResult, saveResult] = await Promise.all([migration, manualSave]);
  assert.equal(migrationResult.ok, true);
  assert.equal(saveResult.ok, true);
  assert.equal(saved.bridgeToken, 'new-manual-token');
  assert.equal(saved.serverBase, 'https://radar.217-116-171-250.sslip.io/robinhood-radar/api/social');
  assert.equal(JSON.stringify([migrationResult, saveResult]).includes('new-manual-token'), false);
});
