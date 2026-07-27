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
import { createPostOutbox } from '../bridge/debot-social-bridge/post-outbox.js';
import {
  POST_UPLOAD_RETRY_DELAYS_MS,
  postUploadRetryDelay
} from '../bridge/debot-social-bridge/post-retry-policy.js';

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
    this.sent = [];
  }

  addEventListener(type, listener) {
    if (!this.listeners.has(type)) this.listeners.set(type, []);
    this.listeners.get(type).push(listener);
  }

  open() {
    for (const listener of this.listeners.get('open') || []) listener({ type: 'open' });
  }

  receive(data) {
    for (const listener of this.listeners.get('message') || []) listener({ data });
  }

  send(data) {
    this.sent.push(data);
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

function timelinePost(id, text = `timeline post ${id}`) {
  return {
    doc_id: String(id),
    platform: 0,
    user: { id: 'timeline-author', username: 'timeline_user', name: 'Timeline User' },
    tweet: { tweet_id: String(id), text, date: 1_784_300_000 }
  };
}

function personalTwitterWatchlist(handle, configId = 42) {
  return {
    list: [{
      platform: 0,
      monitor_object: handle,
      config_name: handle,
      config_id: configId
    }],
    total: 1
  };
}

function createTimelineBridgeHarness(initialHandler, {
  now = 1_784_300_100_000,
  initialWatchlistHandler = async () => ({ list: [], total: 0 }),
  autoAcknowledge = false
} = {}) {
  const window = new FakeWindow('https://debot.ai');
  window.WebSocket = FakeWebSocket;
  const calls = [];
  const watchlistCalls = [];
  const intervals = [];
  const acknowledgedDeliveries = new Set();
  let handler = initialHandler;
  let watchlistHandler = initialWatchlistHandler;
  let clock = now;
  let forcePollSequence = 0;
  let timerSequence = 0;
  const acknowledgeDelivery = (deliveryId, {
    durable = true,
    backpressured = false
  } = {}) => {
    const resolvedDeliveryId = String(deliveryId || '');
    if (!resolvedDeliveryId) return;
    if (durable) acknowledgedDeliveries.add(resolvedDeliveryId);
    window.dispatchMessage({
      source: 'debot-social-relay',
      type: 'posts-delivery-result',
      payload: {
        deliveryId: resolvedDeliveryId,
        ok: durable,
        durable,
        backpressured
      }
    });
  };
  if (autoAcknowledge) {
    window.addEventListener('message', (event) => {
      const message = event.data;
      if (!message || message.source !== 'debot-social-page' || message.type !== 'posts') return;
      const deliveryId = String(message.payload?.deliveryId || '');
      if (!deliveryId || acknowledgedDeliveries.has(deliveryId)) return;
      acknowledgeDelivery(deliveryId);
    });
  }
  const NativeDate = Date;
  class HarnessDate extends NativeDate {
    constructor(...args) {
      super(...(args.length ? args : [clock]));
    }

    static now() {
      return clock;
    }

    static parse(value) {
      return NativeDate.parse(value);
    }
  }

  const fetchImpl = async (url, options = {}) => {
    const requestUrl = String(url);
    if (requestUrl.startsWith('/api/social/twitter/timeline?')) {
      const parsed = new URL(requestUrl, 'https://debot.ai');
      const call = {
        url: requestUrl,
        cursor: parsed.searchParams.get('cursor') || '',
        configIds: parsed.searchParams.get('config_ids') || '',
        options
      };
      calls.push(call);
      return jsonResponse(await handler(call));
    }
    if (requestUrl.startsWith('/api/social/subscribe/list?')) {
      const parsed = new URL(requestUrl, 'https://debot.ai');
      const call = {
        url: requestUrl,
        page: Number(parsed.searchParams.get('page')),
        options
      };
      watchlistCalls.push(call);
      return jsonResponse(await watchlistHandler(call));
    }
    throw new Error(`Unexpected DeBot endpoint: ${requestUrl}`);
  };

  vm.runInNewContext(bridgeSource('debot-page.js'), {
    window,
    document: { visibilityState: 'hidden', addEventListener() {} },
    fetch: fetchImpl,
    setInterval(callback, delay) {
      intervals.push({ callback, delay });
      return intervals.length;
    },
    setTimeout() {
      timerSequence += 1;
      return timerSequence;
    },
    clearTimeout() {},
    Blob,
    ArrayBuffer,
    Uint8Array,
    TextDecoder,
    URLSearchParams,
    URL,
    Date: HarnessDate,
    console
  }, { filename: 'debot-page.js' });

  return {
    window,
    calls,
    intervals,
    timelineCalls() {
      return calls.slice();
    },
    watchlistCalls() {
      return watchlistCalls.slice();
    },
    setHandler(value) {
      handler = value;
    },
    setWatchlistHandler(value) {
      watchlistHandler = value;
    },
    advance(milliseconds) {
      clock += milliseconds;
    },
    acknowledgeDelivery,
    acknowledgeAll() {
      for (const message of window.messages.filter((entry) => entry.type === 'posts')) {
        const deliveryId = String(message.payload?.deliveryId || '');
        if (!deliveryId || acknowledgedDeliveries.has(deliveryId)) continue;
        acknowledgeDelivery(deliveryId);
      }
    },
    async forcePoll(label = 'timeline') {
      forcePollSequence += 1;
      const requestId = `${label}-${forcePollSequence}`;
      window.dispatchMessage({ source: 'debot-social-relay', type: 'force-poll', requestId });
      await eventually(() => assert.ok(window.messages.some((message) =>
        message.type === 'force-poll-result' && message.payload.requestId === requestId)));
      return window.messages.findLast((message) =>
        message.type === 'force-poll-result' && message.payload.requestId === requestId).payload;
    }
  };
}

test('extension manifest, configuration and scripts are valid and narrowly scoped', async () => {
  const manifest = JSON.parse(bridgeSource('manifest.json'));
  assert.equal(manifest.manifest_version, 3);
  assert.equal(manifest.version, '1.6.0');
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
  const pageSource = bridgeSource('debot-page.js');
  const backgroundSource = bridgeSource('background.js');
  assert.match(pageSource, /const PRIMARY_POLL_INTERVAL_MS = 1_000/);
  assert.match(pageSource, /const PRIMARY_API_TIMEOUT_MS = 1_500/);
  assert.match(pageSource, /const TIMELINE_PAGE_SIZE = 50/);
  assert.match(pageSource, /const TIMELINE_CATCHUP_PAGES_PER_POLL = 3/);
  assert.match(pageSource, /const TIMELINE_CATCHUP_MAX_PAGES = 100/);
  assert.match(pageSource, /const WATCHLIST_PAGE_SIZE = 500/);
  assert.match(pageSource, /const WATCHLIST_MAX_PAGES = 10/);
  assert.match(pageSource, /const DELIVERY_TIMEOUT_MS = 2_000/);
  assert.match(pageSource, /async function fetchPersonalTimelinePage\(configIds = \[\], cursor = ''\)/);
  assert.match(pageSource, /timeoutMs: PRIMARY_API_TIMEOUT_MS/);
  assert.doesNotMatch(pageSource, /social\/twitter\/(?:hot|all)\/timeline/);
  assert.match(backgroundSource, /const POST_UPLOAD_REQUEST_TIMEOUT_MS = 2_000/);
  assert.match(backgroundSource, /timeoutMs: POST_UPLOAD_REQUEST_TIMEOUT_MS/);

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

test('social post outbox accepts validated social activity and preserves first discovery time', async () => {
  const stored = {};
  const storage = {
    async get(key) {
      return { [key]: structuredClone(stored[key]) };
    },
    async set(value) {
      Object.assign(stored, structuredClone(value));
    }
  };
  const outbox = createPostOutbox({ storage, now: () => 5_000 });
  const first = await outbox.enqueue({
    source: 'twitter',
    externalId: 'tweet-one',
    kind: 'post',
    content: 'real tweet',
    discoveredAt: 1_000,
    receivedAt: 1_000,
    sourceUpdatedAt: 900
  });
  assert.equal(first.added, 1);
  const duplicate = await outbox.enqueue({
    source: 'twitter',
    externalId: 'tweet-one',
    kind: 'post',
    content: 'real tweet',
    discoveredAt: 9_000,
    receivedAt: 9_000,
    sourceUpdatedAt: 900
  });
  assert.equal(duplicate.duplicates, 1);
  assert.equal((await outbox.readBatch()).records[0].post.discoveredAt, 1_000);

  const activity = await outbox.enqueue([
    {
      source: 'twitter',
      externalId: 'follow:alice:bob',
      kind: 'follow',
      author: { handle: 'alice' },
      target: { handle: 'bob' },
      sourceUpdatedAt: 1_100
    },
    {
      source: 'twitter',
      externalId: 'unfollow:alice:bob',
      kind: 'unfollow',
      author: { handle: 'alice' },
      target: { handle: 'bob' },
      sourceUpdatedAt: 1_200
    },
    {
      source: 'twitter',
      externalId: 'profile:alice:1300',
      kind: 'profile',
      author: { handle: 'alice' },
      profileChanges: ['name', 'avatar', 'bio'],
      profileDetail: {
        name: { before: 'Alice', after: 'Alice 2' },
        avatar: { before: 'old.png', after: 'new.png' },
        bio: { before: 'old', after: 'new' }
      },
      sourceUpdatedAt: 1_300
    },
    { source: 'twitter', externalId: 'follow-incomplete', kind: 'follow', author: { handle: 'alice' } },
    { source: 'twitter', externalId: 'profile-incomplete', kind: 'profile', author: { handle: 'alice' } },
    { source: 'twitter', externalId: 'unknown-one', kind: '' }
  ]);
  assert.equal(activity.added, 3);
  assert.equal(activity.rejected, 3);
  assert.equal(activity.queued, 4);
  assert.deepEqual(
    (await outbox.readBatch()).records.map((record) => record.post.kind),
    ['post', 'follow', 'unfollow', 'profile']
  );
  assert.deepEqual(POST_UPLOAD_RETRY_DELAYS_MS, [2_000, 4_000, 8_000]);
  assert.deepEqual([0, 1, 2, 3].map(postUploadRetryDelay), [2_000, 4_000, 8_000, null]);

  stored.debotSocialPostOutboxV1.records.push({
    key: 'invalid-legacy-follow',
    source: 'twitter',
    externalId: 'follow:alice:bob',
    fingerprint: 'legacy',
    enqueuedAt: 1,
    sequence: 5,
    post: { source: 'twitter', externalId: 'follow:alice:bob', kind: 'follow' }
  });
  stored.debotSocialPostOutboxV1.nextSequence = 6;
  assert.equal((await outbox.stats()).queued, 4);
  assert.equal(stored.debotSocialPostOutboxV1.schemaVersion, 2);
  assert.equal(stored.debotSocialPostOutboxV1.records.some((record) => record.key === 'invalid-legacy-follow'), false);
});

test('DeBot page bridge polls while hidden, consumes the expected channels and uses the observed API payloads', async () => {
  const window = new FakeWindow('https://debot.ai');
  window.WebSocket = FakeWebSocket;
  const documentListeners = new Map();
  const document = {
    visibilityState: 'hidden',
    addEventListener(type, listener) {
      if (!documentListeners.has(type)) documentListeners.set(type, []);
      documentListeners.get(type).push(listener);
    },
    dispatch(type) {
      for (const listener of documentListeners.get(type) || []) listener({ type });
    }
  };
  const calls = [];
  const timers = new Map();
  const intervals = [];
  let nextTimerId = 1;
  const setPageTimeout = (callback, delay) => {
    const id = nextTimerId;
    nextTimerId += 1;
    timers.set(id, { callback, delay });
    return id;
  };
  const clearPageTimeout = (id) => timers.delete(id);
  const runPageTimer = (delay) => {
    const match = [...timers.entries()].findLast(([, timer]) => timer.delay === delay);
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
  const starAccount = {
    platform: 0,
    monitor_object: 'star_okx',
    config_name: 'Star OKX',
    config_id: 45
  };
  const personalPollPost = {
    doc_id: '1900000000000000001',
    platform: 0,
    user: { id: 'personal-author', username: 'personal_author', name: 'Personal Author', followers_count: 10 },
    tweet: { tweet_id: '1900000000000000001', text: 'Personal timeline survived', date: 1_784_300_001 }
  };
  let subscribedAccounts = [account, starAccount];
  let preserveRemovedAccounts = false;
  let resolveDeferredPrimary = null;
  let fetchMode = 'ok';
  const fetchImpl = async (url, options = {}) => {
    calls.push({ url: String(url), options });
    if (fetchMode === 'network') throw new TypeError('DeBot network unavailable');
    if (fetchMode === 'timeout') {
      const error = new Error('DeBot request timed out');
      error.name = 'AbortError';
      throw error;
    }
    if (fetchMode === 'auth') {
      return {
        ok: false,
        status: 401,
        async json() {
          return { code: 401, message: 'authorization: Bearer must-not-leave-the-page' };
        }
      };
    }
    if (fetchMode === 'deferred-primary'
      && String(url).startsWith('/api/social/twitter/timeline?')) {
      return new Promise((resolve) => {
        resolveDeferredPrimary = () => resolve(jsonResponse({ feeds: [] }));
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
      if (!preserveRemovedAccounts) {
        subscribedAccounts = subscribedAccounts.filter((value) => !ids.has(value.config_id));
      }
      return jsonResponse({ success: true });
    }
    if (fetchMode === 'personal-post'
      && String(url).startsWith('/api/social/twitter/timeline?')) {
      return jsonResponse({ feeds: [personalPollPost] });
    }
    if (String(url).startsWith('/api/social/twitter/')) return jsonResponse({ feeds: [] });
    throw new Error(`Unexpected DeBot endpoint: ${url}`);
  };
  vm.runInNewContext(bridgeSource('debot-page.js'), {
    window,
    document,
    fetch: fetchImpl,
    setInterval(callback, delay) {
      intervals.push({ callback, delay });
      return intervals.length;
    },
    setTimeout: setPageTimeout,
    clearTimeout: clearPageTimeout,
    Blob,
    ArrayBuffer,
    Uint8Array,
    TextDecoder,
    URLSearchParams,
    URL,
    console
  }, { filename: 'debot-page.js' });

  await eventually(() => assert.ok(window.messages.some((message) => message.type === 'heartbeat')));
  assert.ok(calls.some((call) => call.url.startsWith('/api/social/subscribe/list?keyword=&page=1&page_size=500')));
  assert.ok(calls.some((call) => call.url.startsWith('/api/social/twitter/timeline?')));
  assert.equal(calls.some((call) => call.url.startsWith('/api/social/twitter/hot/timeline?')), false);
  assert.equal(calls.some((call) => call.url.startsWith('/api/social/twitter/all/timeline?')), false);
  assert.equal(calls
    .filter((call) => call.url.startsWith('/api/social/twitter/'))
    .every((call) => new URL(call.url, 'https://debot.ai').searchParams.get('tw_types')
      === 'tweet|reply|retweet|quote|delTweet|reName|reImage|reDescription|follow|unfollow'), true);
  assert.deepEqual(intervals.map((interval) => interval.delay), [1_000, 30_000]);
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

  fetchMode = 'personal-post';
  window.messages.length = 0;
  window.dispatchMessage({
    source: 'debot-social-relay',
    type: 'force-poll',
    requestId: 'page-personal-probe'
  });
  await eventually(() => assert.ok(window.messages.some((message) =>
    message.type === 'posts'
      && message.payload.posts.some((post) => post.externalId === '1900000000000000001'))));
  await eventually(() => assert.ok(window.messages.some((message) =>
    message.type === 'force-poll-result'
      && message.payload.requestId === 'page-personal-probe'
      && message.payload.ok === true)));
  const personalHeartbeat = window.messages.findLast((message) => message.type === 'heartbeat');
  assert.equal(personalHeartbeat.payload.version, '1.6.0');
  assert.deepEqual(Array.from(personalHeartbeat.payload.capabilities), [
    'posts', 'watchlist', 'commands', 'debot-session', 'debot-analysis-v1'
  ]);
  assert.equal(personalHeartbeat.payload.error, undefined);
  const personalDelivery = window.messages.find((message) =>
    message.type === 'posts'
      && message.payload.posts.some((post) => post.externalId === '1900000000000000001'));
  window.dispatchMessage({
    source: 'debot-social-relay',
    type: 'posts-delivery-result',
    payload: { deliveryId: personalDelivery.payload.deliveryId, ok: true }
  });
  fetchMode = 'ok';

  calls.length = 0;
  fetchMode = 'deferred-primary';
  intervals.find((interval) => interval.delay === 1_000).callback();
  await eventually(() => assert.equal(typeof resolveDeferredPrimary, 'function'));
  intervals.find((interval) => interval.delay === 1_000).callback();
  assert.equal(calls.filter((call) => call.url.startsWith('/api/social/twitter/timeline?')).length, 1);
  fetchMode = 'ok';
  resolveDeferredPrimary();
  await eventually(() => assert.equal(
    calls.filter((call) => call.url.startsWith('/api/social/twitter/timeline?')).length,
    2
  ));

  calls.length = 0;
  let expectedTimelineCalls = 0;
  for (const type of ['online', 'pageshow', 'focus']) {
    const heartbeatCount = window.messages.filter((message) => message.type === 'heartbeat').length;
    for (const listener of window.listeners.get(type) || []) listener({ type });
    expectedTimelineCalls += 1;
    await eventually(() => assert.equal(
      calls.filter((call) => call.url.startsWith('/api/social/twitter/')).length,
      expectedTimelineCalls
    ));
    await eventually(() => assert.equal(
      window.messages.filter((message) => message.type === 'heartbeat').length,
      heartbeatCount + 1
    ));
  }
  const heartbeatCount = window.messages.filter((message) => message.type === 'heartbeat').length;
  document.visibilityState = 'visible';
  document.dispatch('visibilitychange');
  expectedTimelineCalls += 1;
  await eventually(() => assert.equal(
    calls.filter((call) => call.url.startsWith('/api/social/twitter/')).length,
    expectedTimelineCalls
  ));
  await eventually(() => assert.equal(
    window.messages.filter((message) => message.type === 'heartbeat').length,
    heartbeatCount + 1
  ));

  calls.length = 0;
  window.messages.length = 0;
  const socket = new window.WebSocket('wss://debot.ai/social');
  const incoming = {
    doc_id: '1900000000000000100',
    platform: 0,
    sub_token: 'must-not-leave-the-page',
    authorization: 'Bearer must-not-leave-the-page',
    cookie: 'session=must-not-leave-the-page',
    user: { id: 'user-1', username: 'alice', name: 'Alice', followers_count: 123 },
    tweet: { tweet_id: '1900000000000000100', text: 'Robinhood CA', date: 1_784_300_000 },
    mentioned_ca: [{ ca_address: '0x1111111111111111111111111111111111111111', chain: 'robinhood' }]
  };
  socket.receive(`42${JSON.stringify([
    'social-user-twitter',
    {
      Channel: 'twitter_user_subscribe',
      Payload: JSON.stringify({
        user_id: 1,
        event_type: 'twitter_user_subscribe',
        data: incoming
      })
    }
  ])}`);
  const myPosts = window.messages.find((message) => message.type === 'posts');
  assert.equal(myPosts.payload.posts[0].externalId, '1900000000000000100');
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
    {
      Channel: 'twitter_user_subscribe',
      Payload: JSON.stringify({
        user_id: 1,
        event_type: 'twitter_user_subscribe',
        data: incoming
      })
    }
  ])}`);
  assert.equal(window.messages.filter((message) => message.type === 'posts').length, acknowledgedCount);

  const firstDiscoveredAt = myPosts.payload.posts[0].discoveredAt;
  assert.equal(Number.isSafeInteger(firstDiscoveredAt), true);
  await new Promise((resolve) => setTimeout(resolve, 5));
  const beforeHotChannel = window.messages.filter((message) => message.type === 'posts').length;
  socket.receive(`42${JSON.stringify([
    'social-hot-twitter',
    { Payload: JSON.stringify({ data: incoming }) }
  ])}`);
  assert.equal(window.messages.filter((message) => message.type === 'posts').length, beforeHotChannel);
  assert.equal(myPosts.payload.posts[0].discoveredAt, firstDiscoveredAt);

  const sendPersonalActivity = (data, channel = 'twitter_user_subscribe') => socket.receive(`42${JSON.stringify([
    'social-user-twitter',
    {
      Channel: channel,
      Payload: JSON.stringify({
        user_id: 1,
        event_type: channel,
        data
      })
    }
  ])}`);
  const deliveryFor = (externalId) => window.messages
    .filter((message) => message.type === 'posts')
    .findLast((message) => message.payload.posts.some((post) => post.externalId === externalId));
  const acknowledge = (delivery) => window.dispatchMessage({
    source: 'debot-social-relay',
    type: 'posts-delivery-result',
    payload: { deliveryId: delivery.payload.deliveryId, ok: true }
  });

  const translatedSocketId = '1900000000000000104';
  sendPersonalActivity({
    ...incoming,
    doc_id: translatedSocketId,
    tweet: { ...incoming.tweet, tweet_id: translatedSocketId, text_translate: 'Robinhood contract' }
  }, 'twitter_translate_user_subscribe');
  const translatedDelivery = deliveryFor(translatedSocketId);
  assert.ok(translatedDelivery);
  acknowledge(translatedDelivery);

  const replySocketId = '1900000000000000106';
  const replyParentId = '1900000000000000006';
  sendPersonalActivity({
    ...incoming,
    doc_id: replySocketId,
    tweet: {
      ...incoming.tweet,
      tweet_id: replySocketId,
      is_reply: true,
      reply_to: ['parent_user'],
      quoted_post: {
        tweet_id: replyParentId,
        text: 'Parent post in English',
        text_translate: '父帖中文翻译',
        link: `https://x.com/parent_user/status/${replyParentId}`,
        date: 1_784_299_900,
        user: {
          id: 'parent-1',
          username: 'parent_user',
          name: 'Parent User',
          avatar: 'https://pbs.twimg.com/profile_images/parent.jpg'
        }
      }
    }
  });
  const replyDelivery = deliveryFor(replySocketId);
  assert.ok(replyDelivery);
  const replyPost = replyDelivery.payload.posts[0];
  assert.equal(replyPost.kind, 'reply');
  assert.equal(replyPost.target.handle, 'parent_user');
  assert.equal(replyPost.replyToExternalId, replyParentId);
  assert.deepEqual(JSON.parse(JSON.stringify(replyPost.replyContext)), {
    externalId: replyParentId,
    author: {
      id: 'parent-1',
      handle: 'parent_user',
      name: 'Parent User',
      avatarUrl: 'https://pbs.twimg.com/profile_images/parent.jpg'
    },
    content: 'Parent post in English',
    translatedContent: '父帖中文翻译',
    url: `https://x.com/parent_user/status/${replyParentId}`,
    publishedAt: 1_784_299_900_000
  });
  acknowledge(replyDelivery);

  const explicitParentSocketId = '1900000000000000107';
  const explicitParentId = '1900000000000000007';
  sendPersonalActivity({
    ...incoming,
    doc_id: explicitParentSocketId,
    tweet: {
      ...incoming.tweet,
      tweet_id: explicitParentSocketId,
      is_reply: true,
      reply_to: ['parent_user'],
      reply_to_post: {},
      parent_post: { user: { username: 'parent_user' } },
      ori_tweet: {
        tweet_id: explicitParentId,
        text: 'Explicit original parent',
        user: { username: 'parent_user', name: 'Explicit Parent' }
      },
      quoted_post: {
        tweet_id: '1900000000000000907',
        text: 'Unrelated quoted post',
        user: { username: 'other_user', name: 'Other User' }
      }
    }
  });
  const explicitParentDelivery = deliveryFor(explicitParentSocketId);
  assert.ok(explicitParentDelivery);
  const explicitParentPost = explicitParentDelivery.payload.posts[0];
  assert.equal(explicitParentPost.replyToExternalId, explicitParentId);
  assert.equal(explicitParentPost.replyContext.externalId, explicitParentId);
  assert.equal(explicitParentPost.replyContext.content, 'Explicit original parent');
  assert.equal(explicitParentPost.replyContext.author.handle, 'parent_user');
  acknowledge(explicitParentDelivery);

  const unrelatedQuoteSocketId = '1900000000000000108';
  sendPersonalActivity({
    ...incoming,
    doc_id: unrelatedQuoteSocketId,
    tweet: {
      ...incoming.tweet,
      tweet_id: unrelatedQuoteSocketId,
      is_reply: true,
      reply_to: ['12345'],
      quoted_post: {
        tweet_id: '1900000000000000908',
        text: 'This quote is not the reply parent',
        user: { username: 'other_user' }
      }
    }
  });
  const unrelatedQuoteDelivery = deliveryFor(unrelatedQuoteSocketId);
  assert.ok(unrelatedQuoteDelivery);
  const unrelatedQuotePost = unrelatedQuoteDelivery.payload.posts[0];
  assert.equal(unrelatedQuotePost.target.handle, '12345');
  assert.equal(unrelatedQuotePost.replyToExternalId, '');
  assert.equal(Object.hasOwn(unrelatedQuotePost, 'replyContext'), false);
  acknowledge(unrelatedQuoteDelivery);

  const mergedReplySocketId = '1900000000000000109';
  const mergedParentId = '1900000000000000009';
  sendPersonalActivity({
    ...incoming,
    doc_id: mergedReplySocketId,
    tweet: {
      ...incoming.tweet,
      tweet_id: mergedReplySocketId,
      is_reply: true,
      reply_to: ['merge_parent'],
      ori_tweet: {
        tweet_id: mergedParentId,
        text: 'Parent text retained across observations',
        user: { username: 'merge_parent', name: 'Merge Parent' }
      }
    }
  });
  sendPersonalActivity({
    ...incoming,
    doc_id: mergedReplySocketId,
    tweet: {
      ...incoming.tweet,
      tweet_id: mergedReplySocketId,
      is_reply: true,
      reply_to: ['merge_parent'],
      ori_tweet: {
        tweet_id: mergedParentId,
        text_translate: '合并后的父帖翻译',
        user: {
          username: 'merge_parent',
          avatar: 'https://pbs.twimg.com/profile_images/merged-parent.jpg'
        }
      }
    }
  });
  const mergedReplyDelivery = deliveryFor(mergedReplySocketId);
  assert.ok(mergedReplyDelivery);
  const mergedReplyPost = mergedReplyDelivery.payload.posts[0];
  assert.equal(mergedReplyPost.replyToExternalId, mergedParentId);
  assert.equal(mergedReplyPost.replyContext.content, 'Parent text retained across observations');
  assert.equal(mergedReplyPost.replyContext.translatedContent, '合并后的父帖翻译');
  assert.equal(mergedReplyPost.replyContext.author.name, 'Merge Parent');
  assert.equal(
    mergedReplyPost.replyContext.author.avatarUrl,
    'https://pbs.twimg.com/profile_images/merged-parent.jpg'
  );

  const replacementParentId = '1900000000000000019';
  sendPersonalActivity({
    ...incoming,
    doc_id: mergedReplySocketId,
    tweet: {
      ...incoming.tweet,
      tweet_id: mergedReplySocketId,
      is_reply: true,
      reply_to: ['new_parent'],
      parent_post: {
        tweet_id: replacementParentId,
        text: 'Replacement parent text',
        user: { username: 'new_parent' }
      }
    }
  });
  const replacementDelivery = deliveryFor(mergedReplySocketId);
  assert.ok(replacementDelivery);
  const replacementPost = replacementDelivery.payload.posts[0];
  assert.equal(replacementPost.replyToExternalId, replacementParentId);
  assert.equal(replacementPost.target.handle, 'new_parent');
  assert.equal(replacementPost.target.name, '');
  assert.equal(replacementPost.replyContext.externalId, replacementParentId);
  assert.equal(replacementPost.replyContext.content, 'Replacement parent text');
  assert.equal(replacementPost.replyContext.translatedContent, '');
  assert.equal(replacementPost.replyContext.author.name, '');
  assert.equal(replacementPost.replyContext.url, `https://x.com/new_parent/status/${replacementParentId}`);
  acknowledge(replacementDelivery);

  const rejectedInnerChannelId = '1900000000000000105';
  const beforeRejectedInnerChannel = window.messages.filter((message) => message.type === 'posts').length;
  sendPersonalActivity({
    ...incoming,
    doc_id: rejectedInnerChannelId,
    tweet: { ...incoming.tweet, tweet_id: rejectedInnerChannelId }
  }, 'twitter_hot_subscribe');
  assert.equal(window.messages.filter((message) => message.type === 'posts').length, beforeRejectedInnerChannel);
  assert.equal(deliveryFor(rejectedInnerChannelId), undefined);

  const versionedSocketId = '1900000000000000101';
  socket.receive(`42${JSON.stringify([
    'social-user-twitter-v2',
    {
      payload: {
        data: {
          ...incoming,
          doc_id: versionedSocketId,
          tweet: { ...incoming.tweet, tweet_id: versionedSocketId }
        }
      }
    }
  ])}`);
  const versionedDelivery = deliveryFor(versionedSocketId);
  assert.ok(versionedDelivery);
  acknowledge(versionedDelivery);

  const objectEnvelopeSocketId = '1900000000000000102';
  socket.receive(JSON.stringify({
    channel: 'social-twitter-user-v2',
    data: JSON.stringify({
      data: {
        ...incoming,
        doc_id: objectEnvelopeSocketId,
        tweet: { ...incoming.tweet, tweet_id: objectEnvelopeSocketId }
      }
    })
  }));
  const objectEnvelopeDelivery = deliveryFor(objectEnvelopeSocketId);
  assert.ok(objectEnvelopeDelivery);
  acknowledge(objectEnvelopeDelivery);

  const beforeUnmonitoredSocketAuthor = window.messages.filter((message) => message.type === 'posts').length;
  socket.receive(`42${JSON.stringify([
    'social-user-twitter-v2',
    {
      Payload: JSON.stringify({
        data: {
          ...incoming,
          doc_id: '1900000000000000103',
          user: { ...incoming.user, username: 'not_watched' },
          tweet: { ...incoming.tweet, tweet_id: '1900000000000000103' }
        }
      })
    }
  ])}`);
  assert.equal(window.messages.filter((message) => message.type === 'posts').length, beforeUnmonitoredSocketAuthor);

  const portalSocket = new window.WebSocket('wss://debot.ai/portal-ws/?EIO=4&transport=websocket');
  portalSocket.open();
  portalSocket.receive('42["authorization","denied"]');
  assert.deepEqual(Array.from(portalSocket.sent), []);
  portalSocket.receive('42["authorization","success"]');
  assert.deepEqual(Array.from(portalSocket.sent), ['42["subscribe","social-user-twitter"]']);
  portalSocket.receive('42["authorization","success"]');
  assert.equal(portalSocket.sent.length, 1);
  window.dispatchMessage({
    source: 'debot-social-relay',
    type: 'force-poll',
    requestId: 'portal-diagnostics'
  });
  await eventually(() => assert.ok(window.messages.some((message) => (
    message.type === 'force-poll-result'
      && message.payload.requestId === 'portal-diagnostics'
      && message.payload.ok === true
  ))));
  const portalHeartbeat = window.messages.findLast((message) => message.type === 'heartbeat');
  assert.equal(portalHeartbeat.payload.diagnostics.ws.connectionOpens, 1);
  assert.equal(portalHeartbeat.payload.diagnostics.ws.authorizationSuccesses, 2);
  assert.equal(portalHeartbeat.payload.diagnostics.ws.subscribeAttempts, 1);
  assert.equal(portalHeartbeat.payload.diagnostics.ws.subscribeFailures, 0);
  assert.equal(portalHeartbeat.payload.diagnostics.ws.lastSubscribeAt > 0, true);

  const nonPortalSocket = new window.WebSocket('wss://debot.ai/socket.io/?EIO=4&transport=websocket');
  nonPortalSocket.receive('42["authorization","success"]');
  assert.equal(nonPortalSocket.sent.length, 0);

  const followPayload = {
    doc_id: 'Zm9sbG93OnN0YXJfb2t4OmVuem9pbnNpZGVlOjE3ODQzMDAwMDIwMDA',
    platform: 0,
    event_type: 'tweet_user_follow',
    save_time: 1_784_300_002,
    user: { id: 'star-id', username: 'star_okx', followers_count: 234_880 },
    follow: {
      id: 'enzo-id',
      profile_info: {
        Username: 'enzoinsidee',
        Name: 'Enzo',
        Stats: { Followers: 88 }
      },
      cookie: 'target-secret-must-not-leave'
    },
    tweet: { tweet_id: 'stale-tweet-must-not-change-follow-kind', text: 'stale content' }
  };
  sendPersonalActivity(followPayload);
  const followExternalId = 'follow:star_okx:enzoinsidee:1784300002000';
  const followDelivery = deliveryFor(followExternalId);
  assert.ok(followDelivery);
  const follow = followDelivery.payload.posts[0];
  assert.equal(follow.kind, 'follow');
  assert.equal(follow.author.handle, 'star_okx');
  assert.equal(follow.target.handle, 'enzoinsidee');
  assert.equal(follow.target.name, 'Enzo');
  assert.equal(follow.target.followersCount, 88);
  assert.equal(JSON.stringify(follow).includes('target-secret-must-not-leave'), false);
  acknowledge(followDelivery);

  const unfollowPayload = {
    doc_id: 'dW5mb2xsb3c6c3Rhcl9va3g6YmFua3Jib3Q6MTc4NDMwMDAwMzAwMA',
    platform: 0,
    event_type: 'tweet_user_unfollow',
    save_time: 1_784_300_003,
    user: { username: 'star_okx' },
    follow: { username: 'bankrbot', name: 'BankrBot' }
  };
  sendPersonalActivity(unfollowPayload);
  const unfollowDelivery = deliveryFor('unfollow:star_okx:bankrbot:1784300003000');
  assert.ok(unfollowDelivery);
  assert.equal(unfollowDelivery.payload.posts[0].kind, 'unfollow');
  assert.equal(unfollowDelivery.payload.posts[0].target.handle, 'bankrbot');
  acknowledge(unfollowDelivery);

  const profilePayload = {
    doc_id: 'profile-event-one',
    platform: 0,
    event_type: 'tweet_user_profile',
    save_time: 1_784_300_004,
    user: { username: 'alice' },
    profile: {
      is_name_changed: true,
      is_image_changed: 1,
      is_bio_changed: 'true',
      old_name: 'Alice',
      new_name: 'Alice 2',
      old_image: 'https://old.example/alice.png',
      new_image: 'https://new.example/alice.png',
      old_bio: 'old bio',
      new_bio: 'new bio'
    }
  };
  sendPersonalActivity(profilePayload);
  const profileDelivery = deliveryFor('profile:alice:1784300004000');
  assert.ok(profileDelivery);
  const profile = profileDelivery.payload.posts[0];
  assert.equal(profile.kind, 'profile');
  assert.deepEqual(Array.from(profile.profileChanges), ['name', 'avatar', 'bio']);
  assert.equal(profile.profileDetail.name.before, 'Alice');
  assert.equal(profile.profileDetail.name.after, 'Alice 2');
  assert.equal(profile.profileDetail.avatar.after, 'https://new.example/alice.png');
  assert.equal(profile.profileDetail.bio.after, 'new bio');
  acknowledge(profileDelivery);

  const firstFollowOccurrenceCount = window.messages.filter((message) =>
    message.type === 'posts'
      && message.payload.posts.some((post) => post.externalId.startsWith('follow:star_okx:enzoinsidee:'))).length;
  sendPersonalActivity({
    ...followPayload,
    doc_id: 'Zm9sbG93OnN0YXJfb2t4OmVuem9pbnNpZGVlOjE3ODQzMDAwMDUwMDA',
    save_time: 1_784_300_005
  });
  assert.equal(window.messages.filter((message) =>
    message.type === 'posts'
      && message.payload.posts.some((post) => post.externalId.startsWith('follow:star_okx:enzoinsidee:'))).length,
    firstFollowOccurrenceCount + 1);
  const secondFollowDelivery = deliveryFor('follow:star_okx:enzoinsidee:1784300005000');
  assert.equal(secondFollowDelivery.payload.posts[0].sourceUpdatedAt, 1_784_300_005_000);
  acknowledge(secondFollowDelivery);

  const rejectedActivityCount = window.messages.filter((message) => message.type === 'posts').length;
  const rejectedActivities = [
    {
      doc_id: 'follow-missing-target',
      platform: 0,
      event_type: 'tweet_user_follow',
      save_time: 1_784_300_010,
      user: { username: 'alice' }
    },
    {
      doc_id: 'unfollow-missing-author',
      platform: 0,
      event_type: 'tweet_user_unfollow',
      save_time: 1_784_300_011,
      follow: { username: 'bob' }
    },
    {
      doc_id: 'follow:bob:carol',
      platform: 0,
      event_type: 'tweet_user_follow',
      save_time: 1_784_300_012,
      user: { username: 'alice' },
      follow: { username: 'carol' }
    },
    {
      doc_id: 'follow:alice:bob',
      platform: 0,
      event_type: 'tweet_user_follow',
      save_time: 1_784_300_013,
      user: { username: 'alice' },
      follow: { username: 'carol' }
    },
    {
      doc_id: 'profile-without-change',
      platform: 0,
      event_type: 'tweet_user_profile',
      save_time: 1_784_300_014,
      user: { username: 'alice' },
      profile: { old_name: 'Alice', new_name: 'Alice' }
    },
    { doc_id: 'rename-without-values', tw_type: 'reName', save_time: 1_784_300_015, user: { username: 'alice' } },
    { doc_id: 'avatar-without-values', tw_type: 'reImage', save_time: 1_784_300_016, user: { username: 'alice' } },
    { doc_id: 'bio-without-values', tw_type: 'reDescription', save_time: 1_784_300_017, user: { username: 'alice' } },
    {
      doc_id: 'post-without-tweet-id!',
      user: { username: 'alice' },
      tweet: { text: 'missing tweet id', date: 1_784_300_018 }
    },
    {
      doc_id: '1900000000000000190',
      user: { username: 'alice' },
      tweet: { tweet_id: '1900000000000000190', text: 'missing published evidence' }
    },
    { doc_id: 'unknown-activity', event_type: 'list_update', user: { username: 'alice' } },
    {
      doc_id: 'unknown-stale-text',
      event_type: 'list_update',
      user: { username: 'alice' },
      tweet: { text: 'cached text is not a strong tweet identity' }
    },
    {
      doc_id: 'unknown-target-with-stale-tweet',
      event_type: 'list_update',
      user: { username: 'alice' },
      target_user: { username: 'bob' },
      tweet: { tweet_id: '1900000000000000191', text: 'cached text', date: 1_784_300_000 }
    },
    {
      ...incoming,
      doc_id: '1900000000000000192',
      event_type: 'list_update',
      tweet: { ...incoming.tweet, tweet_id: '1900000000000000192' }
    }
  ];
  for (const event of rejectedActivities) sendPersonalActivity(event);
  assert.equal(window.messages.filter((message) => message.type === 'posts').length, rejectedActivityCount);

  const unstableActivities = [
    {
      doc_id: 'relationship-without-stable-time!',
      event_type: 'tweet_user_follow',
      user: { username: 'alice' },
      follow: { username: 'bob' }
    },
    {
      doc_id: 'profile-without-stable-time!',
      event_type: 'tweet_user_profile',
      user: { username: 'alice' },
      profile: { is_name_changed: true, old_name: 'Alice', new_name: 'Alice 2' }
    }
  ];
  const beforeUnstableActivities = window.messages.filter((message) => message.type === 'posts').length;
  for (const event of unstableActivities) {
    sendPersonalActivity(event);
    sendPersonalActivity(event);
  }
  assert.equal(window.messages.filter((message) => message.type === 'posts').length, beforeUnstableActivities);

  const statusUrlOnlyId = '1900000000000000193';
  sendPersonalActivity({
    doc_id: statusUrlOnlyId,
    user: { username: 'alice' },
    tweet: {
      tweet_id: statusUrlOnlyId,
      text: 'status URL is valid publication evidence',
      link: `https://x.com/alice/status/${statusUrlOnlyId}`
    }
  });
  assert.equal(deliveryFor(statusUrlOnlyId).payload.posts[0].kind, 'post');
  acknowledge(deliveryFor(statusUrlOnlyId));

  for (const [externalId, tweetOverrides, expectedKind, expectedDeleted] of [
    ['1900000000000000201', { is_reply: true }, 'reply', false],
    ['1900000000000000202', { is_quote: true }, 'quote', false],
    ['1900000000000000203', { is_retweet: true }, 'repost', false],
    ['1900000000000000204', { tweet_type: 'delete_post' }, 'delete', true]
  ]) {
    socket.receive(`42${JSON.stringify([
      'social-user-twitter',
      {
        Payload: JSON.stringify({
          data: {
            ...incoming,
            doc_id: externalId,
            tw_type: 'tweet',
            tweet: { ...incoming.tweet, tweet_id: externalId, ...tweetOverrides }
          }
        })
      }
    ])}`);
    const normalized = window.messages
      .filter((message) => message.type === 'posts')
      .find((message) => message.payload.posts[0].externalId === externalId)
      .payload.posts[0];
    assert.equal(normalized.kind, expectedKind);
    assert.equal(normalized.deleted, expectedDeleted);
    acknowledge(deliveryFor(externalId));
  }

  const beforeSecondHotChannel = window.messages.filter((message) => message.type === 'posts').length;
  socket.receive(`42${JSON.stringify([
    'social-hot-twitter',
    {
      Payload: JSON.stringify({
        data: {
          ...incoming,
          doc_id: '1900000000000000300',
          tweet: { ...incoming.tweet, tweet_id: '1900000000000000300' }
        }
      })
    }
  ])}`);
  assert.equal(window.messages.filter((message) => message.type === 'posts').length, beforeSecondHotChannel);
  assert.equal(deliveryFor('1900000000000000300'), undefined);

  const binaryPackets = [
    ['1900000000000000401', (text) => new Blob([text])],
    ['1900000000000000402', (text) => new TextEncoder().encode(text).buffer],
    ['1900000000000000403', (text) => new TextEncoder().encode(text)]
  ];
  for (const [externalId, encode] of binaryPackets) {
    const payload = {
      ...incoming,
      doc_id: externalId,
      tweet: { ...incoming.tweet, tweet_id: externalId }
    };
    socket.receive(encode(`42${JSON.stringify([
      'social-user-twitter',
      { Payload: JSON.stringify({ data: payload }) }
    ])}`));
    await eventually(() => assert.ok(window.messages.some((message) =>
      message.type === 'posts'
        && message.payload.posts.some((post) => post.externalId === externalId))));
    acknowledge(deliveryFor(externalId));
  }

  const retryExternalId = '1900000000000000500';
  const retryPayload = {
    ...incoming,
    doc_id: retryExternalId,
    tweet: { ...incoming.tweet, tweet_id: retryExternalId }
  };
  socket.receive(`42${JSON.stringify([
    'social-user-twitter',
    { Payload: JSON.stringify({ data: retryPayload }) }
  ])}`);
  const firstRetry = window.messages
    .filter((message) => message.type === 'posts')
    .find((message) => message.payload.posts[0].externalId === retryExternalId);
  window.dispatchMessage({
    source: 'debot-social-relay',
    type: 'posts-delivery-result',
    payload: { deliveryId: firstRetry.payload.deliveryId, ok: false }
  });
  const beforeRetry = window.messages.filter((message) =>
    message.type === 'posts' && message.payload.posts[0].externalId === retryExternalId).length;
  runPageTimer(2_000);
  assert.equal(window.messages.filter((message) =>
    message.type === 'posts' && message.payload.posts[0].externalId === retryExternalId).length, beforeRetry + 1);
  const secondRetry = deliveryFor(retryExternalId);
  window.dispatchMessage({
    source: 'debot-social-relay',
    type: 'posts-delivery-result',
    payload: { deliveryId: secondRetry.payload.deliveryId, ok: false }
  });
  runPageTimer(4_000);
  assert.equal(window.messages.filter((message) =>
    message.type === 'posts' && message.payload.posts[0].externalId === retryExternalId).length, beforeRetry + 2);
  const thirdRetry = deliveryFor(retryExternalId);
  window.dispatchMessage({
    source: 'debot-social-relay',
    type: 'posts-delivery-result',
    payload: { deliveryId: thirdRetry.payload.deliveryId, ok: false }
  });
  runPageTimer(8_000);
  assert.equal(window.messages.filter((message) =>
    message.type === 'posts' && message.payload.posts[0].externalId === retryExternalId).length, beforeRetry + 3);
  acknowledge(deliveryFor(retryExternalId));

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
  assert.equal(window.messages.find((message) =>
    message.type === 'command-result' && message.payload.commandId === 8).payload.verifiedAbsent, true);
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

  subscribedAccounts.push({
    platform: 0,
    monitor_object: 'stubborn',
    config_name: 'Stubborn',
    config_id: 44
  });
  preserveRemovedAccounts = true;
  window.dispatchMessage({
    source: 'debot-social-relay',
    type: 'command',
    command: { id: 12, type: 'watchlist.delete', payload: { platform: 'twitter', handle: 'stubborn', remoteId: '44' } }
  });
  await eventually(() => assert.ok(window.messages.some((message) =>
    message.type === 'command-result'
      && message.payload.commandId === 12
      && message.payload.success === false)));
  const rejectedRemoval = window.messages.find((message) =>
    message.type === 'command-result' && message.payload.commandId === 12);
  assert.match(rejectedRemoval.payload.error, /still contains the deleted account/);
  preserveRemovedAccounts = false;

  for (const [mode, errorType] of [['network', 'NETWORK'], ['timeout', 'TIMEOUT'], ['auth', 'AUTH']]) {
    fetchMode = mode;
    window.messages.length = 0;
    window.dispatchMessage({
      source: 'debot-social-relay',
      type: 'force-poll',
      requestId: `page-${mode}-probe`
    });
    await eventually(() => assert.ok(window.messages.some((message) =>
      message.type === 'force-poll-result'
        && message.payload.requestId === `page-${mode}-probe`
        && message.payload.ok === false
        && message.payload.errorType === errorType)));
    const errorHeartbeat = window.messages.findLast((message) => message.type === 'heartbeat');
    assert.deepEqual(Array.from(errorHeartbeat.payload.capabilities), ['debot-analysis-v1', 'error']);
    assert.equal(errorHeartbeat.payload.error, errorType);
    assert.equal(JSON.stringify(errorHeartbeat).includes('must-not-leave-the-page'), false);
  }

  fetchMode = 'ok';
  window.messages.length = 0;
  window.dispatchMessage({
    source: 'debot-social-relay',
    type: 'force-poll',
    requestId: 'page-recovery-probe'
  });
  await eventually(() => assert.ok(window.messages.some((message) =>
    message.type === 'force-poll-result'
      && message.payload.requestId === 'page-recovery-probe'
      && message.payload.ok === true)));
  const recoveredHeartbeat = window.messages.findLast((message) => message.type === 'heartbeat');
  assert.equal(recoveredHeartbeat.payload.capabilities.includes('error'), false);
  assert.equal(Object.hasOwn(recoveredHeartbeat.payload, 'error'), false);
  assert.equal(recoveredHeartbeat.payload.version, '1.6.0');
  assert.equal(recoveredHeartbeat.payload.diagnostics.poll.accountCount >= 0, true);
  assert.equal(recoveredHeartbeat.payload.diagnostics.poll.rawRows >= 0, true);
  assert.equal(recoveredHeartbeat.payload.diagnostics.poll.normalizedRows >= 0, true);
  assert.equal(recoveredHeartbeat.payload.diagnostics.poll.droppedRows >= 0, true);
  assert.equal(recoveredHeartbeat.payload.diagnostics.ws.framesSeen > 0, true);
  assert.equal(recoveredHeartbeat.payload.diagnostics.ws.accepted > 0, true);
  assert.equal(recoveredHeartbeat.payload.diagnostics.ws.unmonitoredAuthor > 0, true);
  assert.equal(JSON.stringify(recoveredHeartbeat.payload.diagnostics).includes('must-not-leave-the-page'), false);
});

test('personal timeline delivers the newest page without waiting for encoded cursor recovery', async () => {
  const newestId = '1910000000000000001';
  const recoveredId = '1910000000000000002';
  const encodedCursor = 'cursor with /+?=&%';
  let rejectHistory = null;
  const harness = createTimelineBridgeHarness(async ({ cursor }) => {
    if (!cursor) {
      return { feeds: [timelinePost(newestId)], has_more: true, next_cursor: encodedCursor };
    }
    if (cursor === encodedCursor) {
      return new Promise((_resolve, reject) => {
        rejectHistory = reject;
      });
    }
    throw new Error(`Unexpected cursor: ${cursor}`);
  }, { autoAcknowledge: true });

  await eventually(() => assert.equal(typeof rejectHistory, 'function'));
  const firstDeliveryIndex = harness.window.messages.findIndex((message) =>
    message.type === 'posts' && message.payload.posts.some((post) => post.externalId === newestId));
  const firstHeartbeatIndex = harness.window.messages.findIndex((message) => message.type === 'heartbeat');
  assert.ok(firstDeliveryIndex >= 0);
  assert.ok(firstHeartbeatIndex > firstDeliveryIndex);
  assert.equal(harness.window.messages.some((message) =>
    message.type === 'heartbeat' && message.payload.capabilities.includes('error')), false);

  const encodedCall = harness.timelineCalls().find((call) => call.cursor === encodedCursor);
  assert.ok(encodedCall.url.includes('cursor=cursor+with+%2F%2B%3F%3D%26%25'));
  const resultWhileHistoryPending = await harness.forcePoll('history-pending');
  assert.equal(resultWhileHistoryPending.ok, true);
  assert.equal(typeof rejectHistory, 'function');

  rejectHistory(new TypeError('older page network failure'));
  await new Promise((resolve) => setTimeout(resolve, 0));
  assert.equal(harness.window.messages.some((message) =>
    message.type === 'heartbeat' && message.payload.capabilities.includes('error')), false);

  harness.setHandler(async ({ cursor }) => {
    if (!cursor) {
      return { feeds: [timelinePost(newestId)], has_more: true, next_cursor: encodedCursor };
    }
    if (cursor === encodedCursor) {
      return { feeds: [timelinePost(recoveredId)], has_more: false, next_cursor: '' };
    }
    throw new Error(`Unexpected cursor: ${cursor}`);
  });
  assert.equal((await harness.forcePoll('history-recovery')).ok, true);
  await eventually(() => assert.ok(harness.window.messages.some((message) =>
    message.type === 'posts' && message.payload.posts.some((post) => post.externalId === recoveredId))));
  assert.equal(harness.timelineCalls().filter((call) => call.cursor === encodedCursor).length, 2);
  assert.equal(harness.window.messages.filter((message) =>
    message.type === 'heartbeat' && message.payload.capabilities.includes('error')).length, 0);
});

test('personal timeline advances catch-up only after each page is durably queued', async () => {
  const ids = [
    '1910000000000000051',
    '1910000000000000052',
    '1910000000000000053'
  ];
  const harness = createTimelineBridgeHarness(async ({ cursor }) => {
    if (!cursor) return { feeds: [timelinePost(ids[0])], has_more: true, next_cursor: 'durable-older-1' };
    if (cursor === 'durable-older-1') {
      return { feeds: [timelinePost(ids[1])], has_more: true, next_cursor: 'durable-older-2' };
    }
    if (cursor === 'durable-older-2') {
      return { feeds: [timelinePost(ids[2])], has_more: false, next_cursor: '' };
    }
    throw new Error(`Unexpected durable-gate cursor: ${cursor}`);
  });
  const deliveryFor = (externalId) => harness.window.messages.find((message) =>
    message.type === 'posts' && message.payload.posts.some((post) => post.externalId === externalId));

  await eventually(() => assert.ok(deliveryFor(ids[0])));
  await new Promise((resolve) => setTimeout(resolve, 0));
  assert.deepEqual(harness.timelineCalls().map((call) => call.cursor), ['']);

  const firstDeliveryId = deliveryFor(ids[0]).payload.deliveryId;
  harness.acknowledgeDelivery(firstDeliveryId, { durable: false, backpressured: true });
  await new Promise((resolve) => setTimeout(resolve, 0));
  assert.deepEqual(harness.timelineCalls().map((call) => call.cursor), ['']);

  harness.acknowledgeDelivery(firstDeliveryId);
  await eventually(() => assert.ok(deliveryFor(ids[1])));
  assert.deepEqual(harness.timelineCalls().map((call) => call.cursor), ['', 'durable-older-1']);
  await new Promise((resolve) => setTimeout(resolve, 0));
  assert.equal(harness.timelineCalls().some((call) => call.cursor === 'durable-older-2'), false);

  const historicalDeliveryId = deliveryFor(ids[1]).payload.deliveryId;
  harness.acknowledgeDelivery(historicalDeliveryId, { durable: false, backpressured: true });
  await new Promise((resolve) => setTimeout(resolve, 0));
  assert.equal(harness.timelineCalls().some((call) => call.cursor === 'durable-older-2'), false);

  harness.acknowledgeDelivery(historicalDeliveryId);
  await eventually(() => assert.ok(deliveryFor(ids[2])));
  assert.deepEqual(harness.timelineCalls().map((call) => call.cursor), [
    '', 'durable-older-1', 'durable-older-2'
  ]);
  harness.acknowledgeDelivery(deliveryFor(ids[2]).payload.deliveryId);
});

test('personal timeline recovers when has_more omits its required cursor', async () => {
  const recoveredId = '1910000000000000101';
  const harness = createTimelineBridgeHarness(async () => ({
    feeds: [timelinePost(recoveredId)],
    has_more: true,
    next_cursor: ''
  }));

  await eventually(() => assert.ok(harness.window.messages.some((message) =>
    message.type === 'heartbeat'
      && message.payload.capabilities.includes('error')
      && message.payload.error === 'DEBOT')));
  assert.equal(harness.window.messages.some((message) => message.type === 'posts'), false);

  harness.setHandler(async () => ({ feeds: [timelinePost(recoveredId)], has_more: false, next_cursor: '' }));
  const recovered = await harness.forcePoll('missing-cursor-recovery');
  assert.equal(recovered.ok, true);
  assert.ok(harness.window.messages.some((message) =>
    message.type === 'posts' && message.payload.posts.some((post) => post.externalId === recoveredId)));
  const latestHeartbeat = harness.window.messages.findLast((message) => message.type === 'heartbeat');
  assert.equal(latestHeartbeat.payload.capabilities.includes('error'), false);
});

test('personal timeline recovery does not let a newer WebSocket event hide an older missed page', async () => {
  const baselineId = '1910000000000000150';
  const socketId = '1910000000000000151';
  const missedId = '1910000000000000152';
  const harness = createTimelineBridgeHarness(async () => ({
    feeds: [timelinePost(baselineId)],
    has_more: false,
    next_cursor: ''
  }), {
    autoAcknowledge: true,
    initialWatchlistHandler: async () => personalTwitterWatchlist('timeline_user')
  });

  await eventually(() => assert.ok(harness.window.messages.some((message) =>
    message.type === 'posts' && message.payload.posts.some((post) => post.externalId === baselineId))));
  harness.acknowledgeAll();
  harness.advance(1_000);

  let rejectFailedPoll = null;
  harness.setHandler(async ({ cursor }) => {
    assert.equal(cursor, '');
    return new Promise((_resolve, reject) => {
      rejectFailedPoll = reject;
    });
  });
  const failedPoll = harness.forcePoll('outage-race');
  await eventually(() => assert.equal(typeof rejectFailedPoll, 'function'));

  const socket = new harness.window.WebSocket('wss://debot.ai/social');
  socket.receive(`42${JSON.stringify([
    'social-user-twitter',
    { Payload: JSON.stringify({ data: timelinePost(socketId) }) }
  ])}`);
  await eventually(() => assert.ok(harness.window.messages.some((message) =>
    message.type === 'posts' && message.payload.posts.some((post) => post.externalId === socketId))));
  harness.acknowledgeAll();

  rejectFailedPoll(new TypeError('primary timeline outage'));
  assert.equal((await failedPoll).ok, false);
  harness.setHandler(async ({ cursor }) => {
    if (!cursor) {
      return { feeds: [timelinePost(socketId)], has_more: true, next_cursor: 'outage-older-1' };
    }
    if (cursor === 'outage-older-1') {
      return { feeds: [timelinePost(missedId)], has_more: true, next_cursor: 'outage-older-2' };
    }
    if (cursor === 'outage-older-2') {
      return { feeds: [timelinePost(baselineId)], has_more: false, next_cursor: '' };
    }
    throw new Error(`Unexpected cursor: ${cursor}`);
  });

  assert.equal((await harness.forcePoll('outage-recovery')).ok, true);
  await eventually(() => assert.ok(harness.window.messages.some((message) =>
    message.type === 'posts' && message.payload.posts.some((post) => post.externalId === missedId))));
  assert.deepEqual(harness.timelineCalls().slice(-3).map((call) => call.cursor), [
    '', 'outage-older-1', 'outage-older-2'
  ]);
});

test('personal timeline catch-up continues three pages at a time and stops at a reconnect boundary', async () => {
  const ids = Array.from({ length: 6 }, (_, index) => (1910000000000000200n + BigInt(index)).toString());
  const harness = createTimelineBridgeHarness(async ({ cursor }) => {
    if (!cursor) return { feeds: [timelinePost(ids[0])], has_more: true, next_cursor: 'older-1' };
    const page = Number(cursor.replace('older-', ''));
    if (page >= 1 && page <= 4) {
      return { feeds: [timelinePost(ids[page])], has_more: true, next_cursor: `older-${page + 1}` };
    }
    if (page === 5) return { feeds: [timelinePost(ids[5])], has_more: false, next_cursor: '' };
    throw new Error(`Unexpected cursor: ${cursor}`);
  }, { autoAcknowledge: true });

  await eventually(() => assert.equal(harness.timelineCalls().length, 4));
  assert.deepEqual(harness.timelineCalls().map((call) => call.cursor), ['', 'older-1', 'older-2', 'older-3']);
  assert.equal(harness.window.messages.some((message) =>
    message.type === 'posts' && message.payload.posts.some((post) => post.externalId === ids[0])), true);
  harness.acknowledgeAll();
  await new Promise((resolve) => setTimeout(resolve, 0));

  assert.equal((await harness.forcePoll('continue-cursor')).ok, true);
  await eventually(() => assert.equal(harness.timelineCalls().length, 7));
  assert.deepEqual(harness.timelineCalls().map((call) => call.cursor), [
    '', 'older-1', 'older-2', 'older-3', '', 'older-4', 'older-5'
  ]);
  await new Promise((resolve) => setTimeout(resolve, 0));
  harness.acknowledgeAll();

  const stableCallCount = harness.timelineCalls().length;
  const stablePostCount = harness.window.messages.filter((message) => message.type === 'posts').length;
  assert.equal((await harness.forcePoll('stable-first-page')).ok, true);
  assert.deepEqual(harness.timelineCalls().slice(stableCallCount).map((call) => call.cursor), ['']);
  assert.equal(harness.window.messages.filter((message) => message.type === 'posts').length, stablePostCount);

  harness.acknowledgeAll();
  const reconnectCallCount = harness.timelineCalls().length;
  const reconnectHeartbeatCount = harness.window.messages.filter((message) => message.type === 'heartbeat').length;
  const reconnectPostCount = harness.window.messages.filter((message) => message.type === 'posts').length;
  harness.advance(7_000);
  for (const listener of harness.window.listeners.get('online') || []) listener({ type: 'online' });
  await eventually(() => assert.equal(harness.timelineCalls().length, reconnectCallCount + 1));
  await eventually(() => assert.equal(
    harness.window.messages.filter((message) => message.type === 'heartbeat').length,
    reconnectHeartbeatCount + 1
  ));
  await new Promise((resolve) => setTimeout(resolve, 0));
  assert.deepEqual(harness.timelineCalls().slice(reconnectCallCount).map((call) => call.cursor), ['']);
  assert.equal(harness.window.messages.filter((message) => message.type === 'posts').length, reconnectPostCount);

  const deliveredIds = harness.window.messages
    .filter((message) => message.type === 'posts')
    .flatMap((message) => message.payload.posts.map((post) => post.externalId));
  for (const id of ids) assert.equal(deliveredIds.filter((value) => value === id).length, 1);
});

test('personal timeline freezes its healthy boundary before outage WebSocket deliveries', async () => {
  const boundaryId = '1910000000000000301';
  const socketId = '1910000000000000302';
  const gapId = '1910000000000000303';
  let phase = 'healthy';
  const harness = createTimelineBridgeHarness(async ({ cursor }) => {
    if (phase === 'offline') throw new TypeError('timeline offline');
    if (phase === 'healthy') {
      if (cursor) throw new Error(`Unexpected healthy cursor: ${cursor}`);
      return { feeds: [timelinePost(boundaryId)], has_more: false, next_cursor: '' };
    }
    if (!cursor) {
      return { feeds: [timelinePost(socketId)], has_more: true, next_cursor: 'outage-gap-2' };
    }
    if (cursor === 'outage-gap-2') {
      return {
        feeds: [timelinePost(gapId), timelinePost(boundaryId)],
        has_more: true,
        next_cursor: 'outage-gap-3'
      };
    }
    if (cursor === 'outage-gap-3') {
      throw new Error('Catch-up continued after reaching the frozen healthy boundary');
    }
    throw new Error(`Unexpected recovery cursor: ${cursor}`);
  }, {
    initialWatchlistHandler: async () => personalTwitterWatchlist('timeline_user')
  });

  await eventually(() => assert.equal(harness.timelineCalls().length, 1));
  await new Promise((resolve) => setTimeout(resolve, 0));
  harness.acknowledgeAll();
  await new Promise((resolve) => setTimeout(resolve, 0));

  phase = 'offline';
  harness.advance(7_000);
  const outage = await harness.forcePoll('freeze-healthy-boundary');
  assert.equal(outage.ok, false);
  assert.equal(outage.errorType, 'NETWORK');

  harness.advance(1_000);
  const socket = new harness.window.WebSocket('wss://debot.ai/social');
  socket.receive(`42${JSON.stringify([
    'social-user-twitter',
    { Payload: JSON.stringify({ data: timelinePost(socketId) }) }
  ])}`);
  await eventually(() => assert.ok(harness.window.messages.some((message) =>
    message.type === 'posts'
      && message.payload.posts.some((post) => post.externalId === socketId))));
  harness.acknowledgeAll();
  await new Promise((resolve) => setTimeout(resolve, 0));

  const callsBeforeFocus = harness.timelineCalls().length;
  const heartbeatsBeforeFocus = harness.window.messages.filter((message) => message.type === 'heartbeat').length;
  harness.advance(7_000);
  for (const listener of harness.window.listeners.get('focus') || []) listener({ type: 'focus' });
  await eventually(() => assert.equal(harness.timelineCalls().length, callsBeforeFocus + 1));
  await eventually(() => assert.equal(
    harness.window.messages.filter((message) => message.type === 'heartbeat').length,
    heartbeatsBeforeFocus + 1
  ));
  assert.equal(harness.window.messages.findLast((message) => message.type === 'heartbeat').payload.error, 'NETWORK');

  phase = 'recovered';
  const recoveryCallIndex = harness.timelineCalls().length;
  assert.equal((await harness.forcePoll('recover-past-websocket-item')).ok, true);
  await eventually(() => assert.ok(harness.timelineCalls().some((call) => call.cursor === 'outage-gap-2')));
  await new Promise((resolve) => setTimeout(resolve, 0));
  assert.deepEqual(
    harness.timelineCalls().slice(recoveryCallIndex).map((call) => call.cursor),
    ['', 'outage-gap-2']
  );
  assert.equal(harness.timelineCalls().some((call) => call.cursor === 'outage-gap-3'), false);

  const deliveredIds = harness.window.messages
    .filter((message) => message.type === 'posts')
    .flatMap((message) => message.payload.posts.map((post) => post.externalId));
  for (const id of [boundaryId, socketId, gapId]) {
    assert.equal(deliveredIds.filter((value) => value === id).length, 1, id);
  }
});

test('a changed personal watchlist forces catch-up with an empty prior-account boundary', async () => {
  const oldBoundaryId = '1910000000000000401';
  const newAccountHistoryId = '1910000000000000402';
  let timelinePhase = 'healthy';
  let watchlistPhase = 'empty';
  const harness = createTimelineBridgeHarness(async ({ cursor }) => {
    if (timelinePhase === 'offline') throw new TypeError('timeline offline');
    if (timelinePhase === 'healthy') {
      return { feeds: [timelinePost(oldBoundaryId)], has_more: false, next_cursor: '' };
    }
    if (!cursor) {
      return { feeds: [timelinePost(oldBoundaryId)], has_more: true, next_cursor: 'new-account-2' };
    }
    if (cursor === 'new-account-2') {
      return { feeds: [timelinePost(newAccountHistoryId)], has_more: false, next_cursor: '' };
    }
    throw new Error(`Unexpected changed-watchlist cursor: ${cursor}`);
  }, {
    initialWatchlistHandler: async () => watchlistPhase === 'empty'
      ? { list: [], total: 0 }
      : {
          list: [{
            platform: 0,
            monitor_object: 'new_account',
            config_name: 'New Account',
            config_id: 42
          }],
          total: 1
        },
    autoAcknowledge: true
  });

  await eventually(() => assert.equal(harness.timelineCalls().length, 1));
  await eventually(() => assert.equal(harness.watchlistCalls().length, 2));
  await new Promise((resolve) => setTimeout(resolve, 0));
  harness.acknowledgeAll();

  timelinePhase = 'offline';
  harness.advance(7_000);
  assert.equal((await harness.forcePoll('old-account-outage')).ok, false);

  const callsBeforeRefresh = harness.timelineCalls().length;
  const errorHeartbeatsBeforeRefresh = harness.window.messages.filter((message) =>
    message.type === 'heartbeat' && message.payload.capabilities.includes('error')).length;
  watchlistPhase = 'changed';
  harness.advance(31_000);
  harness.intervals.find((interval) => interval.delay === 30_000).callback();
  await eventually(() => assert.ok(harness.window.messages.some((message) =>
    message.type === 'watchlist'
      && message.payload.accounts.some((account) => account.remoteId === '42'))));
  await eventually(() => assert.equal(harness.timelineCalls().length, callsBeforeRefresh + 1));
  await eventually(() => assert.equal(
    harness.window.messages.filter((message) =>
      message.type === 'heartbeat' && message.payload.capabilities.includes('error')).length,
    errorHeartbeatsBeforeRefresh + 1
  ));

  timelinePhase = 'recovered';
  const recoveryCallIndex = harness.timelineCalls().length;
  assert.equal((await harness.forcePoll('new-account-empty-boundary')).ok, true);
  await eventually(() => assert.ok(harness.timelineCalls().some((call) => call.cursor === 'new-account-2')));
  await new Promise((resolve) => setTimeout(resolve, 0));
  const recoveryCalls = harness.timelineCalls().slice(recoveryCallIndex);
  assert.deepEqual(recoveryCalls.map((call) => call.cursor), ['', 'new-account-2']);
  assert.equal(recoveryCalls.every((call) => call.configIds === '42'), true);
  assert.ok(harness.window.messages.some((message) =>
    message.type === 'posts'
      && message.payload.posts.some((post) => post.externalId === newAccountHistoryId)));
});

test('DeBot social timestamps normalize seconds through nanoseconds to epoch milliseconds', async () => {
  const expected = 1_784_300_123_456;
  const samples = [
    ['1910000000000000501', '1784300123.456'],
    ['1910000000000000502', '1784300123456'],
    ['1910000000000000503', '1784300123456000'],
    ['1910000000000000504', '1784300123456000000']
  ];
  const harness = createTimelineBridgeHarness(async () => ({ feeds: [], has_more: false, next_cursor: '' }), {
    initialWatchlistHandler: async () => personalTwitterWatchlist('timestamp_user')
  });
  await eventually(() => assert.equal(harness.timelineCalls().length, 1));
  await new Promise((resolve) => setTimeout(resolve, 0));

  const socket = new harness.window.WebSocket('wss://debot.ai/social');
  for (const [externalId, sourceTime] of samples) {
    socket.receive(`42${JSON.stringify([
      'social-user-twitter',
      {
        Payload: JSON.stringify({
          data: {
            doc_id: externalId,
            platform: 0,
            user: { id: 'timestamp-user', username: 'timestamp_user' },
            tweet: { tweet_id: externalId, text: sourceTime, date: sourceTime }
          }
        })
      }
    ])}`);
    await eventually(() => assert.ok(harness.window.messages.some((message) =>
      message.type === 'posts'
        && message.payload.posts.some((post) => post.externalId === externalId))));
    const post = harness.window.messages
      .filter((message) => message.type === 'posts')
      .flatMap((message) => message.payload.posts)
      .find((item) => item.externalId === externalId);
    assert.equal(post.publishedAt, expected, sourceTime);
    assert.equal(post.sourceUpdatedAt, expected, sourceTime);
    harness.acknowledgeAll();
  }
});

test('a REST timeline observation enriches an acknowledged WebSocket post with URL and media', async () => {
  const externalId = '1910000000000000601';
  const publishedAt = 1_784_300_123;
  let restEnrichment = false;
  const enrichedUrl = `https://x.com/enriched_user/status/${externalId}`;
  const imageUrl = 'https://cdn.example/enriched-post.jpg';
  const harness = createTimelineBridgeHarness(async () => ({
    feeds: restEnrichment
      ? [{
          doc_id: externalId,
          platform: 0,
          user: {
            id: 'enriched-user-id',
            username: 'enriched_user',
            name: 'Enriched User',
            avatar: 'https://cdn.example/enriched-avatar.jpg'
          },
          tweet: {
            tweet_id: externalId,
            text: 'same post content',
            date: publishedAt,
            link: enrichedUrl,
            media: [{ type: 'image', url: imageUrl }]
          }
        }]
      : [],
    has_more: false,
    next_cursor: ''
  }), {
    initialWatchlistHandler: async () => personalTwitterWatchlist('enriched_user')
  });
  await eventually(() => assert.equal(harness.timelineCalls().length, 1));
  await new Promise((resolve) => setTimeout(resolve, 0));

  const socket = new harness.window.WebSocket('wss://debot.ai/social');
  socket.receive(`42${JSON.stringify([
    'social-user-twitter',
    {
      Payload: JSON.stringify({
        data: {
          doc_id: externalId,
          platform: 0,
          user: { id: 'enriched-user-id', username: 'enriched_user' },
          tweet: {
            tweet_id: externalId,
            text: 'same post content',
            date: publishedAt,
            link: 'https://t.co/pending-enrichment'
          }
        }
      })
    }
  ])}`);
  await eventually(() => assert.equal(harness.window.messages.filter((message) =>
    message.type === 'posts'
      && message.payload.posts.some((post) => post.externalId === externalId)).length, 1));
  const simplePost = harness.window.messages
    .find((message) => message.type === 'posts'
      && message.payload.posts.some((post) => post.externalId === externalId))
    .payload.posts.find((post) => post.externalId === externalId);
  assert.equal(simplePost.url, 'https://t.co/pending-enrichment');
  assert.equal(simplePost.media.length, 0);
  harness.acknowledgeAll();
  await new Promise((resolve) => setTimeout(resolve, 0));

  restEnrichment = true;
  assert.equal((await harness.forcePoll('rest-enrichment')).ok, true);
  await eventually(() => assert.equal(harness.window.messages.filter((message) =>
    message.type === 'posts'
      && message.payload.posts.some((post) => post.externalId === externalId)).length, 2));
  const enrichedPost = harness.window.messages
    .filter((message) => message.type === 'posts'
      && message.payload.posts.some((post) => post.externalId === externalId))
    .at(-1).payload.posts.find((post) => post.externalId === externalId);
  assert.equal(enrichedPost.author.handle, 'enriched_user');
  assert.equal(enrichedPost.author.name, 'Enriched User');
  assert.equal(enrichedPost.url, enrichedUrl);
  assert.deepEqual(Array.from(enrichedPost.media, (item) => ({ type: item.type, url: item.url })), [
    { type: 'image', url: imageUrl }
  ]);
  assert.equal(enrichedPost.discoveredAt, simplePost.discoveredAt);
});

test('personal timeline catch-up stops after one hundred historical pages', async () => {
  const firstId = 1910000000000001000n;
  let phase = 'infinite';
  const harness = createTimelineBridgeHarness(async ({ cursor }) => {
    if (phase === 'offline') throw new TypeError('timeline offline after truncation');
    if (phase === 'finite') {
      if (cursor) throw new Error(`Unexpected finite cursor: ${cursor}`);
      return {
        feeds: [timelinePost((firstId + 1_000n).toString())],
        has_more: false,
        next_cursor: ''
      };
    }
    if (!cursor) {
      return { feeds: [timelinePost(firstId.toString())], has_more: true, next_cursor: 'cap-1' };
    }
    const page = Number(cursor.replace('cap-', ''));
    return {
      feeds: [timelinePost((firstId + BigInt(page)).toString())],
      has_more: true,
      next_cursor: `cap-${page + 1}`
    };
  }, { autoAcknowledge: true });

  await eventually(() => assert.equal(harness.timelineCalls().filter((call) => call.cursor).length, 3));
  await new Promise((resolve) => setTimeout(resolve, 0));
  let poll = 0;
  while (harness.timelineCalls().filter((call) => call.cursor).length < 100) {
    const before = harness.timelineCalls().filter((call) => call.cursor).length;
    assert.equal((await harness.forcePoll(`page-cap-${poll}`)).ok, true);
    const expected = Math.min(100, before + 3);
    await eventually(() => assert.equal(
      harness.timelineCalls().filter((call) => call.cursor).length,
      expected
    ));
    await new Promise((resolve) => setTimeout(resolve, 0));
    poll += 1;
    assert.ok(poll <= 34);
  }

  const historicalCalls = harness.timelineCalls().filter((call) => call.cursor);
  assert.equal(historicalCalls.length, 100);
  assert.equal(historicalCalls.at(-1).cursor, 'cap-100');
  assert.equal(historicalCalls.some((call) => call.cursor === 'cap-101'), false);
  assert.equal(harness.timelineCalls().filter((call) => !call.cursor).length, 34);
  await eventually(() => assert.ok(harness.window.messages.some((message) =>
    message.type === 'heartbeat' && message.payload.capabilities.includes('catchup-truncated'))));
  const truncatedHeartbeat = harness.window.messages.findLast((message) =>
    message.type === 'heartbeat' && message.payload.capabilities.includes('catchup-truncated'));
  assert.equal(truncatedHeartbeat.payload.capabilities.includes('posts'), true);
  assert.equal(truncatedHeartbeat.payload.capabilities.includes('error'), false);
  assert.equal(Object.hasOwn(truncatedHeartbeat.payload, 'error'), false);

  const beforeStablePoll = harness.timelineCalls().length;
  assert.equal((await harness.forcePoll('after-page-cap')).ok, true);
  await new Promise((resolve) => setTimeout(resolve, 0));
  assert.deepEqual(harness.timelineCalls().slice(beforeStablePoll).map((call) => call.cursor), ['']);
  const persistentWarningHeartbeat = harness.window.messages.findLast((message) => message.type === 'heartbeat');
  assert.equal(persistentWarningHeartbeat.payload.capabilities.includes('catchup-truncated'), true);
  assert.equal(persistentWarningHeartbeat.payload.capabilities.includes('error'), false);

  phase = 'offline';
  assert.equal((await harness.forcePoll('truncated-reconnect-failure')).ok, false);
  phase = 'finite';
  assert.equal((await harness.forcePoll('complete-truncated-recovery')).ok, true);
  await new Promise((resolve) => setTimeout(resolve, 0));
  assert.equal((await harness.forcePoll('after-complete-recovery')).ok, true);
  const clearedHeartbeat = harness.window.messages.findLast((message) => message.type === 'heartbeat');
  assert.equal(clearedHeartbeat.payload.capabilities.includes('catchup-truncated'), false);
  assert.equal(clearedHeartbeat.payload.capabilities.includes('error'), false);
  assert.equal(Object.hasOwn(clearedHeartbeat.payload, 'error'), false);
});

test('DeBot page bridge fully paginates personal watchlists and refuses a truncated ten-page snapshot', async () => {
  const accountRow = (index, overrides = {}) => ({
    platform: 0,
    monitor_object: `account_${index}`,
    config_name: `Account ${index}`,
    config_id: index + 1,
    ...overrides
  });

  async function runScenario({ truncated }) {
    const window = new FakeWindow('https://debot.ai');
    const calls = [];
    const firstPage = Array.from({ length: 500 }, (_, index) => accountRow(index));
    const secondPage = [accountRow(500)];
    const fetchImpl = async (url, options = {}) => {
      const requestUrl = String(url);
      calls.push({ url: requestUrl, options });
      if (requestUrl.startsWith('/api/social/twitter/timeline?')) return jsonResponse({ feeds: [] });
      if (requestUrl.startsWith('/api/social/subscribe/list?')) {
        const page = Number(new URL(requestUrl, 'https://debot.ai').searchParams.get('page'));
        if (truncated) {
          const offset = (page - 1) * 500;
          return jsonResponse({
            list: Array.from({ length: 500 }, (_, index) => accountRow(offset + index)),
            total: 5_001
          });
        }
        return jsonResponse({ list: page === 1 ? firstPage : secondPage, total: 501 });
      }
      throw new Error(`Unexpected DeBot endpoint: ${requestUrl}`);
    };

    vm.runInNewContext(bridgeSource('debot-page.js'), {
      window,
      document: { visibilityState: 'hidden', addEventListener() {} },
      fetch: fetchImpl,
      setInterval: () => 1,
      setTimeout,
      clearTimeout,
      Blob,
      ArrayBuffer,
      Uint8Array,
      TextDecoder,
      URLSearchParams,
      URL,
      console
    }, { filename: 'debot-page.js' });
    return { window, calls };
  }

  const complete = await runScenario({ truncated: false });
  await eventually(() => assert.ok(
    complete.window.messages.some((message) => message.type === 'watchlist'),
    JSON.stringify(complete.calls.map((call) => call.url))
  ));
  const completePages = complete.calls
    .filter((call) => call.url.startsWith('/api/social/subscribe/list?'))
    .map((call) => Number(new URL(call.url, 'https://debot.ai').searchParams.get('page')));
  assert.deepEqual(completePages, [1, 2]);
  const snapshot = complete.window.messages.find((message) => message.type === 'watchlist').payload.accounts;
  assert.equal(snapshot.length, 501);
  assert.equal(snapshot.find((account) => account.accountKey === 'account_499').name, 'Account 499');
  assert.equal(snapshot.find((account) => account.accountKey === 'account_500').remoteId, '501');
  await eventually(() => assert.ok(complete.calls.some((call) => {
    if (!call.url.startsWith('/api/social/twitter/timeline?')) return false;
    const configIds = new URL(call.url, 'https://debot.ai').searchParams.get('config_ids') || '';
    return configIds.split('|').length === 501 && configIds.startsWith('1|') && configIds.endsWith('|501');
  })));

  const truncated = await runScenario({ truncated: true });
  await eventually(() => assert.equal(
    truncated.calls.filter((call) => call.url.startsWith('/api/social/subscribe/list?')).length,
    10
  ), 3_000);
  const truncatedPages = truncated.calls
    .filter((call) => call.url.startsWith('/api/social/subscribe/list?'))
    .map((call) => Number(new URL(call.url, 'https://debot.ai').searchParams.get('page')));
  assert.deepEqual(truncatedPages, [1, 2, 3, 4, 5, 6, 7, 8, 9, 10]);
  assert.equal(truncated.calls.some((call) => call.url.includes('page=11')), false);
  assert.equal(truncated.window.messages.some((message) => message.type === 'watchlist'), false);
});

test('DeBot page bridge confirms an empty personal watchlist twice before publishing it', async () => {
  const account = {
    platform: 0,
    monitor_object: 'recovered_account',
    config_name: 'Recovered Account',
    config_id: 42
  };

  async function runScenario(responses) {
    const window = new FakeWindow('https://debot.ai');
    const watchlistCalls = [];
    let responseIndex = 0;
    const fetchImpl = async (url) => {
      const requestUrl = String(url);
      if (requestUrl.startsWith('/api/social/twitter/timeline?')) {
        return jsonResponse({ feeds: [] });
      }
      if (requestUrl.startsWith('/api/social/subscribe/list?')) {
        watchlistCalls.push(requestUrl);
        const response = responses[Math.min(responseIndex, responses.length - 1)];
        responseIndex += 1;
        return jsonResponse(response);
      }
      throw new Error(`Unexpected DeBot endpoint: ${requestUrl}`);
    };

    vm.runInNewContext(bridgeSource('debot-page.js'), {
      window,
      document: { visibilityState: 'hidden', addEventListener() {} },
      fetch: fetchImpl,
      setInterval: () => 1,
      setTimeout,
      clearTimeout,
      Blob,
      ArrayBuffer,
      Uint8Array,
      TextDecoder,
      URLSearchParams,
      URL,
      console
    }, { filename: 'debot-page.js' });

    await eventually(() => assert.equal(watchlistCalls.length, 2));
    await new Promise((resolve) => setTimeout(resolve, 0));
    assert.equal(watchlistCalls[0], watchlistCalls[1]);
    assert.equal(new URL(watchlistCalls[0], 'https://debot.ai').searchParams.get('page'), '1');
    return { window, watchlistCalls };
  }

  const recovered = await runScenario([
    { list: [], total: 0 },
    { list: [account], total: 1 }
  ]);
  assert.equal(recovered.window.messages.some((message) => message.type === 'watchlist'), false);

  const inconsistentTotal = await runScenario([
    { list: [], total: 0 },
    { list: [], total: 1 }
  ]);
  assert.equal(inconsistentTotal.window.messages.some((message) => message.type === 'watchlist'), false);

  const confirmedEmpty = await runScenario([
    { list: [], total: 0 },
    { list: [], total: 0 }
  ]);
  const snapshots = confirmedEmpty.window.messages.filter((message) => message.type === 'watchlist');
  assert.equal(snapshots.length, 1);
  assert.ok(Array.isArray(snapshots[0].payload.accounts));
  assert.equal(snapshots[0].payload.accounts.length, 0);
});

test('an older watchlist request cannot overwrite a newer completed snapshot or timeline cache', async () => {
  let resolveOlderRequest = null;
  let watchlistRequest = 0;
  const harness = createTimelineBridgeHarness(async () => ({ feeds: [], has_more: false, next_cursor: '' }), {
    initialWatchlistHandler: async () => {
      watchlistRequest += 1;
      if (watchlistRequest === 1) {
        return new Promise((resolve) => {
          resolveOlderRequest = resolve;
        });
      }
      if (watchlistRequest === 2) {
        return {
          list: [{
            platform: 0,
            monitor_object: 'newer_account',
            config_name: 'Newer Account',
            config_id: 202
          }],
          total: 1
        };
      }
      throw new Error(`Unexpected watchlist request ${watchlistRequest}`);
    }
  });

  await eventually(() => assert.equal(typeof resolveOlderRequest, 'function'));
  harness.window.dispatchMessage({
    source: 'debot-social-relay',
    type: 'command',
    command: {
      id: 702,
      type: 'watchlist.add',
      payload: { platform: 'twitter', handle: 'newer_account' }
    }
  });
  await eventually(() => assert.ok(harness.window.messages.some((message) =>
    message.type === 'command-result'
      && message.payload.commandId === 702
      && message.payload.success === true
      && message.payload.remoteId === '202')));
  const currentSnapshot = harness.window.messages.find((message) => message.type === 'watchlist');
  assert.deepEqual(Array.from(currentSnapshot.payload.accounts, (account) => account.accountKey), ['newer_account']);

  resolveOlderRequest({
    list: [{
      platform: 0,
      monitor_object: 'older_account',
      config_name: 'Older Account',
      config_id: 101
    }],
    total: 1
  });
  await new Promise((resolve) => setTimeout(resolve, 0));
  assert.equal((await harness.forcePoll('verify-newer-watchlist-cache')).ok, true);

  const snapshots = harness.window.messages.filter((message) => message.type === 'watchlist');
  assert.equal(snapshots.length, 1);
  assert.deepEqual(Array.from(snapshots[0].payload.accounts, (account) => account.accountKey), ['newer_account']);
  assert.equal(harness.timelineCalls().at(-1).configIds, '202');
  assert.equal(harness.timelineCalls().some((call) => call.configIds === '101'), false);
});

test('watchlist snapshots reject accounts with missing or invalid remote IDs', async () => {
  const invalidRows = [
    {
      platform: 0,
      monitor_object: 'missing_remote_id',
      config_name: 'Missing Remote ID'
    },
    {
      platform: 0,
      monitor_object: 'text_remote_id',
      config_name: 'Text Remote ID',
      config_id: 'not-a-positive-id'
    },
    {
      platform: 0,
      monitor_object: 'zero_remote_id',
      config_name: 'Zero Remote ID',
      config_id: 0
    }
  ];

  for (const row of invalidRows) {
    const harness = createTimelineBridgeHarness(
      async () => ({ feeds: [], has_more: false, next_cursor: '' }),
      { initialWatchlistHandler: async () => ({ list: [row], total: 1 }) }
    );
    await eventually(() => assert.equal(harness.watchlistCalls().length, 1));
    await new Promise((resolve) => setTimeout(resolve, 0));
    assert.equal(
      harness.window.messages.some((message) => message.type === 'watchlist'),
      false,
      row.monitor_object
    );
    assert.equal(
      harness.timelineCalls().some((call) => call.configIds && call.configIds !== ''),
      false,
      row.monitor_object
    );
  }
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
          return { ok: true, payload: { durable: false, backpressured: true } };
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
      && message.payload.ok === true
      && message.payload.durable === true
      && message.payload.backpressured === false)));

  window.dispatchMessage({
    source: 'debot-social-page',
    type: 'posts',
    payload: { posts: [{ externalId: 'not-durable' }], deliveryId: 'delivery-not-durable' }
  });
  await eventually(() => assert.ok(window.messages.some((message) =>
    message.source === 'debot-social-relay'
      && message.type === 'posts-delivery-result'
      && message.payload.deliveryId === 'delivery-not-durable'
      && message.payload.ok === false
      && message.payload.durable === false
      && message.payload.backpressured === true)));

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
  const window = new FakeWindow('https://radar.217-116-171-250.sslip.io');
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
  assert.equal(window.messages.find((message) => message.type === 'ready').writable, true);

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

test('Radar content bridge keeps the public HTTP page read-only', async () => {
  const window = new FakeWindow('http://217.116.171.250');
  const runtimeMessages = [];
  const chrome = {
    runtime: {
      async sendMessage(message) {
        runtimeMessages.push(message);
        return { ok: true, payload: { configured: true } };
      }
    }
  };
  vm.runInNewContext(bridgeSource('radar-content.js'), {
    window,
    chrome,
    setTimeout: () => 1
  }, { filename: 'radar-content.js' });

  await eventually(() => assert.ok(window.messages.some((message) => message.type === 'ready')));
  assert.equal(window.messages.find((message) => message.type === 'ready').writable, false);
  window.dispatchMessage({
    source: 'robinhood-radar',
    type: 'social-command',
    requestId: 'insecure-request',
    command: { method: 'DELETE', path: '/watchlist/27' }
  });
  await eventually(() => assert.ok(window.messages.some((message) =>
    message.type === 'response' && message.requestId === 'insecure-request')));
  const response = window.messages.find((message) => message.requestId === 'insecure-request');
  assert.equal(response.ok, false);
  assert.match(response.error, /HTTPS/);
  assert.equal(runtimeMessages.some((message) => message.type === 'api'), false);
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
  let watchlistResponseMode = 'ok';
  let resolveDeferredWatchlist = null;
  let hangingPostAbortedAt = 0;
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
      id: 'extension-test-id',
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
    const isWatchlistRequest = /\/bridge\/watchlist\/snapshot$/.test(requestUrl);
    const isAnalysisClaimRequest = /\/bridge\/debot\/jobs\?limit=\d+$/.test(requestUrl);
    const isAnalysisResultRequest = /\/bridge\/debot\/jobs\/\d+\/result$/.test(requestUrl);
    if (failPostRequests && isPostRequest) {
      throw new TypeError('temporary network failure');
    }
    if (isPostRequest && postResponseMode === 'hang') {
      return new Promise((resolve, reject) => {
        options.signal.addEventListener('abort', () => {
          hangingPostAbortedAt = Date.now();
          const error = new Error('aborted');
          error.name = 'AbortError';
          reject(error);
        }, { once: true });
      });
    }
    if (failAnalysisResultRequests && isAnalysisResultRequest) {
      throw new TypeError('temporary analysis network failure');
    }
    const rejectsInvalidPost = isPostRequest
      && postResponseMode === 'reject-invalid'
      && JSON.parse(options.body).posts.some((post) => post.externalId === 'poison-post');
    const responseStatus = isAnalysisResultRequest
      ? analysisResultResponseStatus
      : rejectsInvalidPost ? 400 : 200;
    return {
      ok: responseStatus >= 200 && responseStatus < 300,
      status: responseStatus,
      async text() {
        if (rejectsInvalidPost) return JSON.stringify({ error: 'invalid social post' });
        if (isPostRequest && postResponseMode === 'negative') return JSON.stringify({ ok: false });
        if (isPostRequest && postResponseMode === 'invalid') return '<html>temporary proxy page</html>';
        if (isPostRequest && postResponseMode === 'deferred') {
          return new Promise((resolve) => {
            resolveDeferredPost = () => resolve(JSON.stringify({ ok: true }));
          });
        }
        if (isWatchlistRequest && watchlistResponseMode === 'deferred') {
          return new Promise((resolve) => {
            resolveDeferredWatchlist = () => resolve(JSON.stringify({ ok: true }));
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
  const managedRelaySender = {
    id: 'extension-test-id',
    url: 'https://debot.ai/',
    tab: { id: 17, url: 'https://debot.ai/' }
  };
  const radarHttpsUrl = 'https://radar.217-116-171-250.sslip.io/robinhood-radar/';
  const radarHttpsSender = {
    id: 'extension-test-id',
    url: radarHttpsUrl,
    tab: { id: 27, url: radarHttpsUrl }
  };
  const radarHttpUrl = 'http://217.116.171.250/robinhood-radar/';
  const radarHttpSender = {
    id: 'extension-test-id',
    url: radarHttpUrl,
    tab: { id: 28, url: radarHttpUrl }
  };
  const send = (message, sender = null) => new Promise((resolve) => {
    const resolvedSender = message?.source === 'debot-social-relay'
      ? {
          ...managedRelaySender,
          ...(sender || {}),
          tab: { ...managedRelaySender.tab, ...(sender?.tab || {}) }
        }
      : sender || {};
    assert.equal(listener(message, resolvedSender, resolve), true);
  });

  const settings = await send({ source: 'bridge-options', type: 'get-settings' });
  assert.equal(settings.ok, true);
  assert.equal(settings.payload.bridgeToken, 'configured');
  assert.equal(JSON.stringify(settings).includes(saved.bridgeToken), false);

  const contentStatus = await send(
    { source: 'robinhood-radar-content', type: 'status' },
    radarHttpSender
  );
  assert.equal(contentStatus.ok, true);
  assert.deepEqual(contentStatus.payload, { configured: true });
  assert.equal(JSON.stringify(contentStatus).includes(saved.bridgeToken), false);

  const behaviorPreference = await send({
    source: 'robinhood-radar-content',
    type: 'api',
    command: {
      method: 'PATCH',
      path: '/watchlist/27',
      body: { eventTypes: ['post', 'follow', 'profile_avatar'] }
    }
  }, radarHttpsSender);
  assert.equal(behaviorPreference.ok, true);
  const behaviorPreferenceRequest = requests.findLast((request) => /\/watchlist\/27$/.test(request.url));
  assert.equal(behaviorPreferenceRequest.options.method, 'PATCH');
  assert.deepEqual(JSON.parse(behaviorPreferenceRequest.options.body), {
    eventTypes: ['post', 'follow', 'profile_avatar']
  });

  const requestCountBeforeInsecureWrite = requests.length;
  const insecureBehaviorPreference = await send({
    source: 'robinhood-radar-content',
    type: 'api',
    command: {
      method: 'PATCH',
      path: '/watchlist/27',
      body: { eventTypes: [] }
    }
  }, radarHttpSender);
  assert.equal(insecureBehaviorPreference.ok, false);
  assert.match(insecureBehaviorPreference.error, /HTTPS/);
  assert.equal(requests.length, requestCountBeforeInsecureWrite);

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

  const requestsBeforeInvalidActivities = requests.filter((request) => /\/bridge\/posts$/.test(request.url)).length;
  const invalidActivities = await send({
    source: 'debot-social-relay',
    type: 'posts',
    payload: {
      posts: [
        { source: 'twitter', externalId: 'follow:alice:bob', kind: 'follow' },
        { source: 'twitter', externalId: 'unfollow:alice:bob', kind: 'unfollow' },
        { source: 'twitter', externalId: 'profile:alice:1', kind: 'profile' },
        { source: 'twitter', externalId: 'unknown:alice:1', kind: 'list_update' }
      ]
    }
  });
  assert.equal(invalidActivities.ok, true);
  assert.equal(invalidActivities.payload.skipped, true);
  assert.equal(requests.filter((request) => /\/bridge\/posts$/.test(request.url)).length, requestsBeforeInvalidActivities);

  const requestsBeforeSocialActivities = requests.filter((request) => /\/bridge\/posts$/.test(request.url)).length;
  const socialActivities = await send({
    source: 'debot-social-relay',
    type: 'posts',
    payload: {
      posts: [
        {
          source: 'twitter',
          externalId: 'follow:alice:bob',
          kind: 'follow',
          author: { id: 'alice-id', handle: 'alice', followersCount: 42 },
          target: {
            id: 'bob-id',
            handle: 'bob',
            name: 'Bob',
            followersCount: 73,
            url: 'https://x.com/bob',
            cookie: 'private-target-cookie'
          },
          sourceUpdatedAt: 1_784_300_001_000
        },
        {
          source: 'twitter',
          externalId: 'unfollow:alice:carol',
          kind: 'unfollow',
          author: { handle: 'alice' },
          target: { handle: 'carol', url: 'https://x.com/carol' },
          sourceUpdatedAt: 1_784_300_002_000
        },
        {
          source: 'twitter',
          externalId: 'profile:alice:1784300003000',
          kind: 'profile',
          author: { handle: 'alice' },
          profileChanges: ['name', 'avatar', 'bio', 'unsupported'],
          profileDetail: {
            name: { before: 'Alice', after: 'Alice 2', cookie: 'private-profile-cookie' },
            avatar: { before: 'old.png', after: 'new.png' },
            bio: { before: 'old bio', after: 'new bio' },
            unsupported: { before: 'secret', after: 'secret' }
          },
          sourceUpdatedAt: 1_784_300_003_000
        }
      ]
    }
  });
  assert.equal(socialActivities.ok, true);
  assert.equal(socialActivities.payload.durable, true);
  await eventually(() => assert.ok(requests.filter((request) =>
    /\/bridge\/posts$/.test(request.url)).length > requestsBeforeSocialActivities));
  const socialActivityRequest = requests.findLast((request) => /\/bridge\/posts$/.test(request.url));
  const socialActivityPosts = JSON.parse(socialActivityRequest.options.body).posts;
  assert.deepEqual(socialActivityPosts.map((post) => post.kind), ['follow', 'unfollow', 'profile']);
  assert.equal(socialActivityPosts[0].target.handle, 'bob');
  assert.equal(socialActivityPosts[0].target.followersCount, 73);
  assert.deepEqual(socialActivityPosts[2].profileChanges, ['name', 'avatar', 'bio']);
  assert.equal(socialActivityPosts[2].profileDetail.name.after, 'Alice 2');
  assert.equal(/private-(?:target|profile)-cookie/.test(socialActivityRequest.options.body), false);
  assert.equal(socialActivityRequest.options.body.includes('unsupported'), false);
  await eventually(() => assert.equal(saved.debotSocialPostOutboxV1?.records?.length, 0));

  const requestsBeforeSafePost = requests.filter((request) => /\/bridge\/posts$/.test(request.url)).length;
  await send({
    source: 'debot-social-relay',
    type: 'posts',
    payload: {
      posts: [{
        source: 'twitter',
        externalId: 'safe-post',
        kind: 'post',
        content: 'public content',
        discoveredAt: 1_784_300_001_234,
        receivedAt: 1_784_300_001_234,
        author: { handle: 'alice', cookie: 'debot-cookie-value' },
        raw: { sub_token: 'debot-session-value' },
        authorization: 'Bearer debot-auth-value'
      }]
    }
  });
  await eventually(() => assert.ok(requests.filter((request) =>
    /\/bridge\/posts$/.test(request.url)).length > requestsBeforeSafePost));
  const postRequest = requests.findLast((request) => /\/bridge\/posts$/.test(request.url));
  assert.match(postRequest.url, /\/api\/social\/bridge\/posts$/);
  assert.equal(postRequest.options.headers.authorization, `Bearer ${saved.bridgeToken}`);
  assert.equal(postRequest.options.body.includes(saved.bridgeToken), false);
  assert.equal(/debot-(?:cookie|session|auth)-value/.test(postRequest.options.body), false);
  const postBody = JSON.parse(postRequest.options.body);
  assert.equal(Object.hasOwn(postBody.posts[0], 'raw'), false);
  assert.equal(Object.hasOwn(postBody.posts[0], 'authorization'), false);
  assert.equal(Object.hasOwn(postBody.posts[0], 'target'), false);
  assert.equal(postBody.posts[0].discoveredAt, 1_784_300_001_234);
  await eventually(() => assert.equal(saved.debotSocialPostOutboxV1?.records?.length, 0));

  postResponseMode = 'reject-invalid';
  const isolationRequestCount = requests.filter((request) => /\/bridge\/posts$/.test(request.url)).length;
  await send({
    source: 'debot-social-relay',
    type: 'posts',
    payload: {
      posts: [
        { source: 'twitter', externalId: 'valid-before-poison', kind: 'post', content: 'valid before' },
        { source: 'twitter', externalId: 'poison-post', kind: 'post', content: 'permanently invalid' },
        { source: 'twitter', externalId: 'valid-after-poison', kind: 'post', content: 'valid after' }
      ]
    }
  });
  await eventually(() => assert.equal(saved.debotSocialPostOutboxV1?.records?.length, 0));
  const isolationRequests = requests
    .filter((request) => /\/bridge\/posts$/.test(request.url))
    .slice(isolationRequestCount)
    .map((request) => JSON.parse(request.options.body).posts.map((post) => post.externalId));
  assert.equal(isolationRequests.some((ids) => ids.length === 1 && ids[0] === 'poison-post'), true);
  assert.equal(isolationRequests.some((ids) => ids.includes('valid-before-poison')), true);
  assert.equal(isolationRequests.some((ids) => ids.includes('valid-after-poison')), true);
  postResponseMode = 'ok';

  postResponseMode = 'deferred';
  let postRequestCount = requests.filter((request) => /\/bridge\/posts$/.test(request.url)).length;
  await send({
    source: 'debot-social-relay',
    type: 'posts',
    payload: { posts: [{ source: 'twitter', externalId: 'flush-race-one', kind: 'post', content: 'first durable post' }] }
  });
  await eventually(() => assert.equal(typeof resolveDeferredPost, 'function'));
  await send({
    source: 'debot-social-relay',
    type: 'posts',
    payload: { posts: [{ source: 'twitter', externalId: 'flush-race-two', kind: 'post', content: 'second durable post' }] }
  });
  assert.equal(requests.filter((request) => /\/bridge\/posts$/.test(request.url)).length, postRequestCount + 1);
  postResponseMode = 'ok';
  resolveDeferredPost();
  await eventually(() => assert.equal(
    requests.filter((request) => /\/bridge\/posts$/.test(request.url)).length,
    postRequestCount + 2
  ));
  await eventually(() => assert.equal(saved.debotSocialPostOutboxV1?.records?.length, 0));

  postResponseMode = 'hang';
  const hangingPostStartedAt = Date.now();
  await send({
    source: 'debot-social-relay',
    type: 'posts',
    payload: { posts: [{ source: 'twitter', externalId: 'hanging-upload', kind: 'post', content: 'durable while stalled' }] }
  });
  await eventually(() => assert.ok(hangingPostAbortedAt > 0), 3_000);
  assert.ok(hangingPostAbortedAt - hangingPostStartedAt >= 1_800);
  assert.ok(hangingPostAbortedAt - hangingPostStartedAt < 2_800);
  assert.equal(saved.debotSocialPostOutboxV1.records.some((record) =>
    record.post.externalId === 'hanging-upload'), true);
  postResponseMode = 'ok';
  alarmListener({ name: 'debot-social-bridge-recovery' });
  await eventually(() => assert.equal(saved.debotSocialPostOutboxV1?.records?.length, 0));

  await send({
    source: 'debot-social-relay',
    type: 'heartbeat',
    payload: {
      bridgeId: 'test',
      capabilities: ['posts'],
      cookie: 'debot-cookie-value',
      error: 'authorization: Bearer debot-auth-value; sub_token=debot-session-value',
      diagnostics: {
        ws: {
          connectionOpens: 2,
          authorizationSuccesses: 2,
          subscribeAttempts: 2,
          subscribeFailures: 0,
          lastSubscribeAt: 1_782_000_123_456,
          framesSeen: 20,
          accepted: 3,
          rawFrame: 'sub_token=must-not-leave-the-page'
        },
        poll: {
          rawRows: 8,
          normalizedRows: 5,
          accountCount: 22,
          configHash: 'A1B2C3D4',
          lastErrorCategory: 'NETWORK',
          rawResponse: 'cookie=must-not-leave-the-page'
        },
        forcePoll: {
          successes: 1,
          failures: 0,
          lastErrorCategory: 'not-an-allowed-error'
        }
      }
    }
  });
  const heartbeatBody = requests.at(-1).options.body;
  assert.equal(/debot-(?:cookie|session|auth)-value/.test(heartbeatBody), false);
  assert.equal(heartbeatBody.includes('must-not-leave-the-page'), false);
  assert.match(heartbeatBody, /\[redacted\]/);
  assert.deepEqual(JSON.parse(heartbeatBody).diagnostics, {
    ws: {
      connectionOpens: 2,
      authorizationSuccesses: 2,
      subscribeAttempts: 2,
      subscribeFailures: 0,
      lastSubscribeAt: 1_782_000_123_456,
      framesSeen: 20,
      accepted: 3,
      rejected: 0,
      unmatchedChannel: 0,
      invalidPacket: 0,
      invalidEnvelope: 0,
      unmonitoredAuthor: 0,
      invalidEvent: 0,
      unreadable: 0,
      lastEventAt: 0
    },
    poll: {
      startedAt: 0,
      finishedAt: 0,
      elapsedMs: 0,
      rawRows: 8,
      normalizedRows: 5,
      droppedRows: 0,
      accountCount: 22,
      configHash: 'a1b2c3d4',
      latestSourceAt: 0,
      lastErrorCategory: 'NETWORK',
      attempts: 0,
      successes: 0,
      failures: 0
    },
    forcePoll: {
      successes: 1,
      failures: 0,
      lastAt: 0,
      elapsedMs: 0,
      lastErrorCategory: ''
    }
  });

  await send({
    source: 'debot-social-relay',
    type: 'watchlist',
    payload: {
      accounts: [{
        platform: 'twitter',
        handle: 'alice',
        remoteId: '42',
        metadata: { hotSubscribeId: 4, monitorLevel: 'high', sub_token: 'debot-session-value' }
      }]
    }
  });
  const watchlistBody = requests.at(-1).options.body;
  assert.equal(watchlistBody.includes('debot-session-value'), false);
  const firstWatchlistBody = JSON.parse(watchlistBody);
  assert.equal(firstWatchlistBody.complete, true);
  assert.equal(typeof firstWatchlistBody.snapshotSessionId, 'string');
  assert.ok(firstWatchlistBody.snapshotSessionId.length > 8);
  assert.equal(Number.isSafeInteger(firstWatchlistBody.snapshotSessionStartedAt), true);
  assert.equal(firstWatchlistBody.snapshotRevision, 1);

  watchlistResponseMode = 'deferred';
  const serialRequestCount = requests.filter((request) => /\/bridge\/watchlist\/snapshot$/.test(request.url)).length;
  const firstSerialSnapshot = send({
    source: 'debot-social-relay',
    type: 'watchlist',
    payload: { accounts: [{ platform: 'twitter', handle: 'bob', remoteId: '43' }] }
  });
  await eventually(() => assert.equal(typeof resolveDeferredWatchlist, 'function'));
  const secondSerialSnapshot = send({
    source: 'debot-social-relay',
    type: 'watchlist',
    payload: { accounts: [{ platform: 'twitter', handle: 'carol', remoteId: '44' }] }
  });
  await new Promise((resolve) => setTimeout(resolve, 0));
  assert.equal(
    requests.filter((request) => /\/bridge\/watchlist\/snapshot$/.test(request.url)).length,
    serialRequestCount + 1
  );
  watchlistResponseMode = 'ok';
  resolveDeferredWatchlist();
  await firstSerialSnapshot;
  await secondSerialSnapshot;
  const serialBodies = requests
    .filter((request) => /\/bridge\/watchlist\/snapshot$/.test(request.url))
    .slice(-2)
    .map((request) => JSON.parse(request.options.body));
  assert.deepEqual(serialBodies.map((body) => body.snapshotRevision), [2, 3]);
  assert.equal(serialBodies.every((body) => body.snapshotSessionId === firstWatchlistBody.snapshotSessionId), true);
  assert.equal(serialBodies.every((body) => (
    body.snapshotSessionStartedAt === firstWatchlistBody.snapshotSessionStartedAt
  )), true);

  const commandAcknowledgement = await send({
    source: 'debot-social-relay',
    type: 'command-result',
    payload: {
      commandId: 77,
      success: true,
      remoteId: '42',
      verifiedAbsent: true
    }
  });
  assert.equal(commandAcknowledgement.ok, true);
  const commandAcknowledgementRequest = requests.findLast((request) => /\/bridge\/commands\/77\/ack$/.test(request.url));
  assert.deepEqual(JSON.parse(commandAcknowledgementRequest.options.body), {
    success: true,
    error: '',
    remoteId: '42',
    verifiedAbsent: true
  });

  const requestCountBeforeUnmanagedWrite = requests.length;
  const unmanagedHeartbeat = await send({
    source: 'debot-social-relay',
    type: 'heartbeat',
    payload: { bridgeId: 'must-not-upload' }
  }, {
    id: 'extension-test-id',
    url: 'https://example.test/',
    tab: { id: 17, url: 'https://example.test/' }
  });
  assert.equal(unmanagedHeartbeat.ok, true);
  assert.deepEqual(unmanagedHeartbeat.payload, { accepted: false, managed: false });
  assert.equal(requests.length, requestCountBeforeUnmanagedWrite);

  failPostRequests = true;
  const queuedDuringOutage = await send({
    source: 'debot-social-relay',
    type: 'posts',
    payload: {
      posts: [{ source: 'twitter', externalId: 'queued-during-outage', kind: 'post', content: 'public queued post' }]
    }
  });
  assert.equal(queuedDuringOutage.ok, true);
  assert.equal(queuedDuringOutage.payload.durable, true);
  await eventually(() => assert.ok(saved.debotSocialPostOutboxV1?.records?.some((record) =>
    record.post.externalId === 'queued-during-outage')));
  await new Promise((resolve) => setTimeout(resolve, 0));
  failPostRequests = false;
  const outageRequestCount = requests.filter((request) => /\/bridge\/posts$/.test(request.url)).length;
  await eventually(() => assert.ok(requests.filter((request) =>
    /\/bridge\/posts$/.test(request.url)).length > outageRequestCount), 3_000);
  await eventually(() => assert.equal(saved.debotSocialPostOutboxV1?.records?.some((record) =>
    record.post.externalId === 'queued-during-outage'), false), 3_000);

  postResponseMode = 'negative';
  postRequestCount = requests.filter((request) => /\/bridge\/posts$/.test(request.url)).length;
  await send({
    source: 'debot-social-relay',
    type: 'posts',
    payload: { posts: [{ source: 'twitter', externalId: 'negative-ack', kind: 'post', content: 'must remain queued' }] }
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
    payload: { posts: [{ source: 'twitter', externalId: 'invalid-ack', kind: 'post', content: 'must also remain queued' }] }
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
