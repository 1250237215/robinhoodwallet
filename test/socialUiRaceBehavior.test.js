import fs from 'node:fs';
import vm from 'node:vm';
import test from 'node:test';
import assert from 'node:assert/strict';

const appJs = fs.readFileSync(new URL('../public/app.js', import.meta.url), 'utf8');
const listenerBoundary = appJs.indexOf("elements.chainSwitcher.addEventListener('click'");

assert.notEqual(listenerBoundary, -1, 'social behavior harness could not find the UI listener boundary');

function createElementStub() {
  return {
    checked: false,
    classList: {
      add() {},
      remove() {},
      toggle() {},
      contains() { return false; }
    },
    close() {},
    dataset: {},
    disabled: false,
    hidden: false,
    innerHTML: '',
    querySelector() { return null; },
    querySelectorAll() { return []; },
    removeAttribute() {},
    setAttribute() {},
    showModal() {},
    style: { setProperty() {} },
    textContent: '',
    value: ''
  };
}

function createTimerHarness() {
  let nextId = 1;
  const timers = [];
  return {
    clear() {
      timers.length = 0;
    },
    clearTimeout(id) {
      const timer = timers.find((candidate) => candidate.id === id);
      if (timer) timer.cancelled = true;
    },
    pendingDelays() {
      return timers.filter((timer) => !timer.cancelled).map((timer) => timer.delay);
    },
    async runNext() {
      const timer = timers.find((candidate) => !candidate.cancelled);
      assert.ok(timer, 'expected a pending timer');
      timer.cancelled = true;
      timer.callback();
      await Promise.resolve();
      await Promise.resolve();
    },
    setTimeout(callback, delay = 0) {
      const id = nextId;
      nextId += 1;
      timers.push({ id, callback, delay: Number(delay), cancelled: false });
      return id;
    }
  };
}

function createSocialBehaviorHarness({
  origin = 'http://radar.test',
  protocol = 'http:',
  hostname = 'radar.test',
  pathname = '/robinhood-radar/',
  search = '',
  hash = '',
  localStorage = null
} = {}) {
  const timers = createTimerHarness();
  const redirects = [];
  const elements = new Map();
  const eventSources = [];
  class EventSourceStub {
    constructor(url) {
      this.url = url;
      this.listeners = new Map();
      this.closed = false;
      eventSources.push(this);
    }

    addEventListener(type, listener) {
      const listeners = this.listeners.get(type) || [];
      listeners.push(listener);
      this.listeners.set(type, listeners);
    }

    close() {
      this.closed = true;
    }

    emit(type, payload = {}) {
      for (const listener of this.listeners.get(type) || []) {
        listener({ data: JSON.stringify(payload) });
      }
    }
  }
  const document = {
    querySelector(selector) {
      if (!elements.has(selector)) elements.set(selector, createElementStub());
      return elements.get(selector);
    },
    querySelectorAll() { return []; },
    visibilityState: 'visible'
  };
  const window = {
    history: { replaceState() {} },
    localStorage: localStorage || {
      getItem() { return null; },
      removeItem() {},
      setItem() {}
    },
    location: {
      hash,
      hostname,
      origin,
      pathname,
      protocol,
      search,
      replace(value) { redirects.push(String(value)); }
    },
    postMessage() {},
    EventSource: EventSourceStub
  };
  window.window = window;

  const context = vm.createContext({
    AbortController,
    EventSource: EventSourceStub,
    URL,
    URLSearchParams,
    atob,
    btoa,
    clearInterval() {},
    clearTimeout: timers.clearTimeout,
    console,
    document,
    fetch: async () => { throw new Error('unexpected fetch'); },
    performance,
    setInterval() { return 1; },
    setTimeout: timers.setTimeout,
    window
  });

  const exposure = `
    renderSocialMonitor = () => {};
    renderSocialBridgeStatus = () => {};
    globalThis.__socialBehavior = {
      state,
      applySocialChange,
      applySocialSnapshot,
      startSocialMonitor,
      setSnapshotLoader(loader) { loadSocialSnapshot = loader; },
      reset() {
        state.activeTab = 'monitor';
        state.socialStarted = true;
        state.socialConnected = true;
        state.socialSequence = 1;
        state.socialLatestChangeId = 0;
        state.socialStreamEpoch = 'test-epoch';
        state.socialReconnectAttempt = 0;
        state.socialPosts = [];
        state.socialDeferredPosts = new Map();
        state.socialWatchlist = [];
        state.socialCounts = {};
        state.socialBridge = {};
        state.socialWatchlistSnapshotTimer = null;
        state.socialRecoveryBusy = false;
        state.socialRecoveryStartedAt = null;
        state.socialRecoveryTargetId = 0;
      }
    };
  `;
  vm.runInContext(`${appJs.slice(0, listenerBoundary)}\n${exposure}`, context, {
    filename: 'public/app.js'
  });

  const api = context.__socialBehavior;
  const reset = () => {
    timers.clear();
    api.reset();
    eventSources.length = 0;
  };
  reset();
  return { api, eventSources, redirects, reset, timers };
}

test('the public HTTP page redirects to HTTPS and clears a legacy social token during initialization', () => {
  const insecureRemovals = [];
  const insecureHarness = createSocialBehaviorHarness({
    origin: 'http://217.116.171.250',
    protocol: 'http:',
    hostname: '217.116.171.250',
    search: '?chain=solana',
    hash: '#monitor',
    localStorage: {
      getItem() { return 'legacy-secret'; },
      removeItem(key) { insecureRemovals.push(key); },
      setItem() {}
    }
  });
  assert.deepEqual(insecureRemovals, ['robinhood-social-device-token']);
  assert.deepEqual(insecureHarness.redirects, [
    'https://radar.217-116-171-250.sslip.io/robinhood-radar/?chain=solana#monitor'
  ]);

  const secureRemovals = [];
  const secureHarness = createSocialBehaviorHarness({
    origin: 'https://radar.217-116-171-250.sslip.io',
    protocol: 'https:',
    hostname: 'radar.217-116-171-250.sslip.io',
    localStorage: {
      getItem() { return 'secure-secret'; },
      removeItem(key) { secureRemovals.push(key); },
      setItem() {}
    }
  });
  assert.deepEqual(secureRemovals, []);
  assert.deepEqual(secureHarness.redirects, []);
});

function watchEntry({ id = 7, handle = '1874a3', eventTypes = ['post'] } = {}) {
  return {
    id,
    platform: 'twitter',
    handle,
    accountKey: handle,
    desiredState: 'active',
    syncStatus: 'synced',
    eventTypes
  };
}

function socialPost({
  id = 101,
  externalId = 'tweet-101',
  handle = '1874a3',
  publishedAt = 1_753_567_890_000,
  content = 'new post'
} = {}) {
  return {
    id,
    externalId,
    source: 'twitter',
    kind: 'post',
    content,
    publishedAt,
    author: { handle, name: handle }
  };
}

function postIds(api) {
  return Array.from(api.state.socialPosts, (post) => String(post.externalId));
}

function watchHandles(api) {
  return Array.from(api.state.socialWatchlist, (entry) => String(entry.handle));
}

test('post.created before watchlist.updated survives a failed snapshot retry and remains deduplicated', async () => {
  const { api, timers } = createSocialBehaviorHarness();
  const entry = watchEntry();
  const post = socialPost();
  let snapshotCalls = 0;

  api.setSnapshotLoader(() => {
    snapshotCalls += 1;
    if (snapshotCalls === 1) return Promise.resolve(false);
    return Promise.resolve(api.applySocialSnapshot({
      latestChangeId: 2,
      streamEpoch: 'test-epoch',
      watchlist: [entry],
      posts: [post]
    }));
  });

  api.applySocialChange({ id: 1, entityType: 'post', data: post });
  assert.deepEqual(postIds(api), []);
  assert.equal(api.state.socialDeferredPosts.size, 1);

  api.applySocialChange({ id: 2, entityType: 'watchlist', data: entry });
  assert.deepEqual(postIds(api), ['tweet-101']);
  assert.equal(api.state.socialDeferredPosts.size, 0);
  assert.deepEqual(timers.pendingDelays(), [100]);

  await timers.runNext();
  assert.equal(snapshotCalls, 1);
  assert.deepEqual(postIds(api), ['tweet-101']);
  assert.deepEqual(timers.pendingDelays(), [2_000]);

  await timers.runNext();
  assert.equal(snapshotCalls, 2);
  assert.deepEqual(postIds(api), ['tweet-101']);
  assert.equal(api.state.socialPosts.length, 1);
});

test('an older HTTP snapshot cannot roll back a newer SSE watchlist, cursor, or post', () => {
  const { api } = createSocialBehaviorHarness();
  const liveEntry = watchEntry({ id: 9, handle: '1874a3' });
  const livePost = socialPost({ id: 201, externalId: 'tweet-live' });

  api.applySocialChange({ id: 10, entityType: 'watchlist', data: liveEntry });
  api.applySocialChange({ id: 11, entityType: 'post', data: livePost });

  const applied = api.applySocialSnapshot({
    latestChangeId: 9,
    streamEpoch: 'test-epoch',
    watchlist: [watchEntry({ id: 3, handle: 'stale_account' })],
    posts: [socialPost({ id: 99, externalId: 'tweet-stale', handle: 'stale_account' })]
  });

  assert.equal(applied, false);
  assert.equal(api.state.socialLatestChangeId, 11);
  assert.deepEqual(watchHandles(api), ['1874a3']);
  assert.deepEqual(postIds(api), ['tweet-live']);
});

test('post updates use their own VPS change time without replacing the first browser receipt', () => {
  const { api } = createSocialBehaviorHarness();
  const entry = watchEntry();
  const initialPost = socialPost({
    id: 401,
    externalId: 'tweet-latency',
    publishedAt: 1_753_567_890_000
  });
  initialPost.debotDiscoveredAt = 1_753_567_890_000;
  initialPost.vpsIngestedAt = 1_753_567_891_000;
  initialPost.updatedAt = 1_753_567_891_000;

  api.applySocialChange({ id: 1, entityType: 'watchlist', data: entry });
  api.applySocialChange({
    id: 2,
    type: 'post.created',
    entityType: 'post',
    createdAt: 1_753_567_891_100,
    data: initialPost
  });

  const created = api.state.socialPosts[0];
  const firstWebReceivedAt = created.firstWebReceivedAt;
  assert.equal(created.firstWebReceiptMode, 'created');
  assert.equal(created.firstWebLatencyBaseAt, initialPost.vpsIngestedAt);
  assert.equal(created.latestWebReceivedAt, firstWebReceivedAt);
  assert.equal(created.latestWebLatencyBaseAt, 1_753_567_891_100);
  assert.equal(created.webReceiptMode, 'created');

  const updatedPost = {
    ...initialPost,
    content: 'updated post',
    updatedAt: 1_753_567_893_000,
    sourceUpdatedAt: 1_753_567_893_000
  };
  api.applySocialChange({
    id: 3,
    type: 'post.updated',
    entityType: 'post',
    createdAt: 1_753_567_893_250,
    data: updatedPost
  });

  const updated = api.state.socialPosts[0];
  assert.equal(updated.firstWebReceivedAt, firstWebReceivedAt);
  assert.equal(updated.firstWebReceiptMode, 'created');
  assert.equal(updated.latestWebLatencyBaseAt, 1_753_567_893_250);
  assert.equal(updated.webLatencyBaseAt, 1_753_567_893_250);
  assert.equal(updated.webReceiptMode, 'updated');

  const fallbackPost = {
    ...updatedPost,
    content: 'updated again',
    updatedAt: 1_753_567_895_000,
    sourceUpdatedAt: 1_753_567_895_000
  };
  api.applySocialChange({
    id: 4,
    type: 'post.updated',
    entityType: 'post',
    data: fallbackPost
  });

  const fallback = api.state.socialPosts[0];
  assert.equal(fallback.firstWebReceivedAt, firstWebReceivedAt);
  assert.equal(fallback.latestWebLatencyBaseAt, fallbackPost.updatedAt);
  assert.equal(fallback.webReceiptMode, 'updated');
});

test('social SSE starts before the initial snapshot and reconnects at a capped rapid backoff', async () => {
  const { api, eventSources, timers } = createSocialBehaviorHarness();
  let snapshotStartedAfterSources = 0;
  api.setSnapshotLoader(() => {
    snapshotStartedAfterSources = eventSources.length;
    return Promise.resolve(false);
  });

  api.startSocialMonitor();
  assert.equal(snapshotStartedAfterSources, 1);
  assert.equal(eventSources.length, 1);

  const retryDelays = [];
  for (let attempt = 0; attempt < 5; attempt += 1) {
    eventSources.at(-1).emit('error');
    const [delay] = timers.pendingDelays();
    retryDelays.push(delay);
    await timers.runNext();
  }
  assert.deepEqual(retryDelays, [250, 500, 1_000, 2_000, 2_000]);
});

test('a failed optional snapshot does not mark an already-live social SSE offline', async () => {
  const { api, eventSources } = createSocialBehaviorHarness();
  api.startSocialMonitor();
  eventSources[0].emit('open');
  await Promise.resolve();
  await Promise.resolve();
  await Promise.resolve();

  assert.equal(api.state.socialTransport, 'sse');
  assert.equal(api.state.socialConnected, true);
});

test('reset applies its watchlist and posts before flushing deferred live posts', () => {
  const { api } = createSocialBehaviorHarness();
  const deferredPost = socialPost({ id: 301, externalId: 'tweet-deferred', publishedAt: 200 });
  const snapshotPost = socialPost({ id: 302, externalId: 'tweet-snapshot', publishedAt: 100 });
  const entry = watchEntry();

  api.applySocialChange({ id: 1, entityType: 'post', data: deferredPost });
  assert.equal(api.state.socialDeferredPosts.size, 1);
  assert.deepEqual(postIds(api), []);

  const applied = api.applySocialSnapshot({
    latestChangeId: 20,
    streamEpoch: 'reset-epoch',
    watchlist: [entry],
    posts: [snapshotPost]
  }, { resetCursor: true });

  assert.equal(applied, true);
  assert.equal(api.state.socialLatestChangeId, 20);
  assert.deepEqual(watchHandles(api), ['1874a3']);
  assert.deepEqual(postIds(api), ['tweet-deferred', 'tweet-snapshot']);
  assert.equal(api.state.socialPosts.length, 2);
  assert.equal(api.state.socialDeferredPosts.size, 0);
});
