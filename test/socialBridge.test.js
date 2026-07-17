import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import vm from 'node:vm';
import { spawnSync } from 'node:child_process';
import { pathToFileURL } from 'node:url';
import { build } from 'esbuild';
import { migrateLocalSettings } from '../bridge/debot-social-bridge/options-config.js';

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
    requests.push({ url: String(url), options });
    const isPostRequest = /\/bridge\/posts$/.test(String(url));
    if (failPostRequests && isPostRequest) {
      throw new TypeError('temporary network failure');
    }
    return {
      ok: true,
      status: 200,
      async text() {
        if (isPostRequest && postResponseMode === 'negative') return JSON.stringify({ ok: false });
        if (isPostRequest && postResponseMode === 'invalid') return '<html>temporary proxy page</html>';
        if (isPostRequest && postResponseMode === 'deferred') {
          return new Promise((resolve) => {
            resolveDeferredPost = () => resolve(JSON.stringify({ ok: true }));
          });
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
  const send = (message) => new Promise((resolve) => {
    assert.equal(listener(message, {}, resolve), true);
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
