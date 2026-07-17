import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import vm from 'node:vm';
import { spawnSync } from 'node:child_process';
import { pathToFileURL } from 'node:url';

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
  assert.deepEqual(manifest.permissions, ['storage']);
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

test('DeBot page bridge polls while hidden, consumes the expected channels and uses the observed API payloads', async () => {
  const window = new FakeWindow('https://debot.ai');
  window.WebSocket = FakeWebSocket;
  const calls = [];
  const account = {
    platform: 0,
    monitor_object: 'alice',
    config_name: 'Alice',
    config_id: 42,
    hot_subscribe_id: 7,
    monitor_level: 'high'
  };
  const fetchImpl = async (url, options = {}) => {
    calls.push({ url: String(url), options });
    if (String(url).startsWith('/api/social/subscribe/list?')) return jsonResponse({ list: [account] });
    if (url === '/api/social/subscribe/custom/add') return jsonResponse({ config_id: 42 });
    if (url === '/api/social/subscribe/remove') return jsonResponse({ success: true });
    if (String(url).startsWith('/api/social/twitter/')) return jsonResponse({ feeds: [] });
    throw new Error(`Unexpected DeBot endpoint: ${url}`);
  };
  vm.runInNewContext(bridgeSource('debot-page.js'), {
    window,
    document: { visibilityState: 'hidden' },
    fetch: fetchImpl,
    setInterval: () => 1,
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

  socket.receive(`42${JSON.stringify([
    'social-hot-twitter',
    { Payload: JSON.stringify({ data: { ...incoming, doc_id: 'document-2' } }) }
  ])}`);
  const featured = window.messages
    .filter((message) => message.type === 'posts')
    .find((message) => message.payload.posts[0].externalId === 'document-2');
  assert.deepEqual(Array.from(featured.payload.posts[0].feedSources), ['featured']);

  calls.length = 0;
  window.dispatchMessage({
    source: 'debot-social-relay',
    type: 'command',
    command: { id: 7, type: 'watchlist.add', payload: { platform: 'twitter', handle: '@alice' } }
  });
  await eventually(() => assert.ok(window.messages.some((message) =>
    message.type === 'command-result' && message.payload.commandId === 7)));
  const add = calls.find((call) => call.url === '/api/social/subscribe/custom/add');
  assert.equal(add.options.method, 'POST');
  assert.deepEqual(JSON.parse(add.options.body), { tweet_username: 'alice', platform: 0 });

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
});

test('relay transports only supported page events and delivers claimed commands to the page world', async () => {
  const window = new FakeWindow('https://debot.ai');
  const runtimeMessages = [];
  const chrome = {
    runtime: {
      async sendMessage(message) {
        runtimeMessages.push(message);
        if (message.type === 'poll-commands') {
          return { ok: true, payload: { commands: [{ id: 9, type: 'watchlist.add', payload: { handle: 'bob' } }] } };
        }
        return { ok: true, payload: {} };
      }
    }
  };
  vm.runInNewContext(bridgeSource('debot-relay.js'), {
    window,
    chrome,
    setInterval: () => 1
  }, { filename: 'debot-relay.js' });

  await eventually(() => assert.ok(window.messages.some((message) =>
    message.source === 'debot-social-relay' && message.type === 'command')));
  window.dispatchMessage({
    source: 'debot-social-page',
    type: 'posts',
    payload: { posts: [{ externalId: 'relay-post' }] }
  });
  await eventually(() => assert.ok(runtimeMessages.some((message) =>
    message.source === 'debot-social-relay' && message.type === 'posts')));

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
  const previousChrome = globalThis.chrome;
  const previousFetch = globalThis.fetch;
  globalThis.chrome = {
    storage: {
      local: {
        async get(keys) {
          return Object.fromEntries(keys.filter((key) => Object.hasOwn(saved, key)).map((key) => [key, saved[key]]));
        },
        async set(value) {
          Object.assign(saved, value);
        }
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
      }
    }
  };
  globalThis.fetch = async (url, options) => {
    requests.push({ url: String(url), options });
    return {
      ok: true,
      status: 200,
      async text() {
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

  const originalSiteServer = await send({
    source: 'bridge-options',
    type: 'save-settings',
    payload: { serverBase: 'http://217.116.171.250/robinhood-radar/api/social/' }
  });
  assert.equal(originalSiteServer.ok, true);
  assert.equal(originalSiteServer.payload.serverBase, 'http://217.116.171.250/robinhood-radar/api/social');
  assert.equal(originalSiteServer.payload.bridgeToken, 'configured');

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
  const postRequest = requests.at(-1);
  assert.match(postRequest.url, /\/api\/social\/bridge\/posts$/);
  assert.equal(postRequest.options.headers.authorization, `Bearer ${saved.bridgeToken}`);
  assert.equal(postRequest.options.body.includes(saved.bridgeToken), false);
  assert.equal(/debot-(?:cookie|session|auth)-value/.test(postRequest.options.body), false);
  const postBody = JSON.parse(postRequest.options.body);
  assert.equal(Object.hasOwn(postBody.posts[0], 'raw'), false);
  assert.equal(Object.hasOwn(postBody.posts[0], 'authorization'), false);

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
});
