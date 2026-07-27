import test from 'node:test';
import assert from 'node:assert/strict';
import { EventEmitter } from 'node:events';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

import { createRobinhoodStandaloneServer } from '../src/robinhoodServer.js';
import { createSocialApiHandler } from '../src/social/http.js';
import { createSocialService } from '../src/social/service.js';

async function withSocialServer(t, { token = '' } = {}) {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'robinhood-social-api-'));
  const socialService = createSocialService({
    config: {
      dataFile: path.join(directory, 'social.sqlite'),
      bridgeToken: token,
      retentionDays: 7,
      bridgeOfflineMs: 15_000,
      cleanupIntervalMs: 3_600_000,
      commandLeaseMs: 30_000
    }
  });
  const server = createRobinhoodStandaloneServer({
    service: {},
    socialService,
    socialBridgeToken: token,
    servePublic: false
  });
  await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
  const baseUrl = `http://127.0.0.1:${server.address().port}`;
  t.after(async () => {
    if (server.listening) await new Promise((resolve) => server.close(resolve));
    socialService.close();
    fs.rmSync(directory, { recursive: true, force: true });
  });
  return { baseUrl, server, socialService };
}

function auth(token) {
  return { authorization: `Bearer ${token}`, 'content-type': 'application/json' };
}

class ControlledSseRequest extends EventEmitter {
  constructor({ remoteAddress = '127.0.0.1', headers = {} } = {}) {
    super();
    this.method = 'GET';
    this.headers = { ...headers };
    this.socket = { remoteAddress };
  }
}

class ControlledSseResponse extends EventEmitter {
  constructor() {
    super();
    this.destroyed = false;
    this.writableEnded = false;
    this.statusCode = null;
    this.headers = {};
    this.chunks = [];
    this.backpressured = false;
  }

  setHeader(name, value) {
    this.headers[String(name).toLowerCase()] = String(value);
  }

  writeHead(statusCode, headers = {}) {
    this.statusCode = statusCode;
    for (const [name, value] of Object.entries(headers)) this.setHeader(name, value);
  }

  write(chunk) {
    if (this.destroyed || this.writableEnded) throw new Error('response is closed');
    this.chunks.push(String(chunk));
    return !this.backpressured;
  }

  end(chunk = '') {
    if (chunk) this.chunks.push(String(chunk));
    this.writableEnded = true;
  }

  destroy() {
    if (this.destroyed) return;
    this.destroyed = true;
    this.emit('close');
  }

  text() {
    return this.chunks.join('');
  }
}

function createControlledSocialService() {
  const changes = [];
  const subscribers = new Set();
  let latestChangeId = 0;
  return {
    store: {
      getLatestChangeId() {
        return latestChangeId;
      }
    },
    getSnapshot() {
      return { ok: true, posts: [], watchlist: [], latestChangeId };
    },
    listChanges({ after, limit }) {
      return changes.filter((change) => change.id > after).slice(0, limit);
    },
    subscribe(listener) {
      subscribers.add(listener);
      return () => subscribers.delete(listener);
    },
    publish(type = 'post.created') {
      latestChangeId += 1;
      const change = { id: latestChangeId, type, post: { externalId: `event-${latestChangeId}` } };
      changes.push(change);
      for (const subscriber of [...subscribers]) subscriber(change);
      return change;
    },
    get subscriberCount() {
      return subscribers.size;
    }
  };
}

async function openControlledStream(handler, response = new ControlledSseResponse(), requestOptions = {}) {
  const request = new ControlledSseRequest(requestOptions);
  const handled = await handler(
    request,
    response,
    new URL('http://127.0.0.1/api/social/stream')
  );
  assert.equal(handled, true);
  return { request, response };
}

test('unpaired social API stays publicly readable but rejects every write', async (t) => {
  const { baseUrl } = await withSocialServer(t);
  const snapshotResponse = await fetch(`${baseUrl}/api/social`);
  const snapshot = await snapshotResponse.json();
  assert.equal(snapshotResponse.status, 200);
  assert.equal(snapshot.bridge.state, 'unpaired');
  assert.equal(snapshot.bridge.readOnly, true);

  const mutation = await fetch(`${baseUrl}/api/social/watchlist`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ account: '@alice' })
  });
  assert.equal(mutation.status, 503);
  assert.equal((await mutation.json()).code, 'SOCIAL_UNPAIRED');
});

test('paired bridge authenticates heartbeat, ingestion, watchlist commands and acknowledgements', async (t) => {
  const token = 'test-device-token';
  const { baseUrl, socialService } = await withSocialServer(t, { token });
  const unauthorized = await fetch(`${baseUrl}/api/social/bridge/heartbeat`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: '{}'
  });
  assert.equal(unauthorized.status, 401);

  const heartbeat = await fetch(`${baseUrl}/api/social/bridge/heartbeat`, {
    method: 'POST',
    headers: auth(token),
    body: JSON.stringify({ bridgeId: 'chrome-main', version: '1.0.0', capabilities: ['posts', 'watchlist'] })
  });
  assert.equal(heartbeat.status, 200);
  assert.equal((await heartbeat.json()).bridge.state, 'online');

  const incompleteHeartbeat = await fetch(`${baseUrl}/api/social/bridge/heartbeat`, {
    method: 'POST',
    headers: auth(token),
    body: JSON.stringify({
      bridgeId: 'chrome-main',
      version: '1.1.0',
      capabilities: ['debot-analysis-v1']
    })
  });
  const incompleteBridge = (await incompleteHeartbeat.json()).bridge;
  assert.equal(incompleteBridge.state, 'error');
  assert.equal(incompleteBridge.online, false);
  assert.equal(incompleteBridge.analysisOnline, true);
  assert.ok(incompleteBridge.heartbeatAgeMs >= 0 && incompleteBridge.heartbeatAgeMs < 1_000);

  const failedHeartbeat = await fetch(`${baseUrl}/api/social/bridge/heartbeat`, {
    method: 'POST',
    headers: auth(token),
    body: JSON.stringify({
      bridgeId: 'chrome-main',
      version: '1.1.1',
      capabilities: ['debot-analysis-v1', 'error']
    })
  });
  const failedBridge = (await failedHeartbeat.json()).bridge;
  assert.equal(failedHeartbeat.status, 200);
  assert.equal(failedBridge.state, 'error');
  assert.equal(failedBridge.online, false);
  assert.equal(failedBridge.analysisOnline, true);
  assert.deepEqual(socialService.claimDeBotJobs({ limit: 1 }).jobs, []);
  assert.equal((await (await fetch(`${baseUrl}/api/social/status`)).json()).bridge.state, 'error');

  const recoveredHeartbeat = await fetch(`${baseUrl}/api/social/bridge/heartbeat`, {
    method: 'POST',
    headers: auth(token),
    body: JSON.stringify({ bridgeId: 'chrome-main', version: '1.0.0', capabilities: ['posts', 'watchlist'] })
  });
  assert.equal((await recoveredHeartbeat.json()).bridge.state, 'online');

  const ingested = await fetch(`${baseUrl}/api/social/bridge/posts`, {
    method: 'POST',
    headers: auth(token),
    body: JSON.stringify({ posts: [{ source: 'x', id: '100', authorHandle: 'alice', text: 'hello' }] })
  });
  assert.equal(ingested.status, 200);
  assert.equal((await ingested.json()).summary.created, 1);
  const posts = await (await fetch(`${baseUrl}/api/social/posts?source=twitter`)).json();
  assert.equal(posts.posts[0].externalId, '100');

  const watchlist = await fetch(`${baseUrl}/api/social/watchlist/batch`, {
    method: 'POST',
    headers: auth(token),
    body: JSON.stringify({ accounts: ['alice', { platform: 'binance', handle: 'bob' }] })
  });
  assert.equal(watchlist.status, 202);
  assert.equal((await watchlist.json()).commands.length, 2);
  const commands = await (await fetch(`${baseUrl}/api/social/bridge/commands`, {
    headers: { authorization: `Bearer ${token}` }
  })).json();
  assert.equal(commands.commands.length, 2);

  const acknowledgement = await fetch(
    `${baseUrl}/api/social/bridge/commands/${commands.commands[0].id}/ack`,
    {
      method: 'POST',
      headers: auth(token),
      body: JSON.stringify({ success: true, remoteId: 'remote-1' })
    }
  );
  assert.equal(acknowledgement.status, 200);
  assert.equal((await acknowledgement.json()).command.status, 'completed');
});

test('bridge diagnostics are sanitized and available in social snapshot and status', async (t) => {
  const token = 'bridge-diagnostics-token';
  const { baseUrl } = await withSocialServer(t, { token });
  const heartbeat = await fetch(`${baseUrl}/api/social/bridge/heartbeat`, {
    method: 'POST',
    headers: auth(token),
    body: JSON.stringify({
      bridgeId: 'chrome-main',
      version: '1.3.0',
      capabilities: ['posts', 'watchlist'],
      diagnostics: {
        ws: {
          connectionOpens: 5,
          authorizationSuccesses: 4,
          subscribeAttempts: 4,
          subscribeFailures: 1,
          lastSubscribeAt: 1_782_000_123_456,
          framesSeen: 12,
          accepted: 3,
          rawFrame: 'debot-session=must-not-return'
        },
        poll: {
          rawRows: 4,
          normalizedRows: 3,
          accountCount: 22,
          configHash: 'A1B2C3D4',
          lastErrorCategory: 'NETWORK',
          rawResponse: { token: 'must-not-return' }
        },
        forcePoll: {
          successes: 2,
          failures: 1,
          lastErrorCategory: 'not-an-allowed-category'
        }
      }
    })
  });
  assert.equal(heartbeat.status, 200);
  const heartbeatBody = await heartbeat.json();
  assert.deepEqual(heartbeatBody.bridge.diagnostics.ws, {
    connectionOpens: 5,
    authorizationSuccesses: 4,
    subscribeAttempts: 4,
    subscribeFailures: 1,
    lastSubscribeAt: 1_782_000_123_456,
    framesSeen: 12,
    accepted: 3,
    rejected: 0,
    unmatchedChannel: 0,
    invalidPacket: 0,
    invalidEnvelope: 0,
    unmonitoredAuthor: 0,
    invalidEvent: 0,
    unreadable: 0,
    lastEventAt: null
  });
  assert.equal(heartbeatBody.bridge.diagnostics.poll.configHash, 'a1b2c3d4');
  assert.equal(heartbeatBody.bridge.diagnostics.poll.lastErrorCategory, 'NETWORK');
  assert.equal(heartbeatBody.bridge.diagnostics.forcePoll.lastErrorCategory, '');
  assert.equal(JSON.stringify(heartbeatBody).includes('must-not-return'), false);

  const snapshot = await (await fetch(`${baseUrl}/api/social/snapshot`)).json();
  const status = await (await fetch(`${baseUrl}/api/social/status`)).json();
  assert.deepEqual(snapshot.bridge.diagnostics, heartbeatBody.bridge.diagnostics);
  assert.deepEqual(status.bridge.diagnostics, heartbeatBody.bridge.diagnostics);
});

test('watchlist preferences patch notes and events atomically and publish only real changes', async (t) => {
  const token = 'watch-event-device-token';
  const { baseUrl, socialService } = await withSocialServer(t, { token });
  const addedResponse = await fetch(`${baseUrl}/api/social/watchlist`, {
    method: 'POST',
    headers: auth(token),
    body: JSON.stringify({ account: '@alice' })
  });
  const added = await addedResponse.json();
  const entry = added.entries[0];
  assert.equal(addedResponse.status, 202);
  assert.deepEqual(entry.eventTypes, [
    'post', 'reply', 'quote', 'repost', 'delete', 'follow', 'unfollow',
    'profile_name', 'profile_avatar', 'profile_bio'
  ]);
  const command = socialService.claimCommands({ limit: 1 }).commands[0];
  socialService.acknowledgeCommand(command.id, { success: true, remoteId: 'debot-alice' });
  const before = socialService.store.listWatchlist()[0];
  const cursorBefore = socialService.store.getLatestChangeId();
  const published = [];
  const unsubscribe = socialService.subscribe((change) => published.push(change));
  t.after(unsubscribe);

  const patchedResponse = await fetch(`${baseUrl}/api/social/watchlist/${entry.id}`, {
    method: 'PATCH',
    headers: auth(token),
    body: JSON.stringify({
      eventTypes: ['profile_bio', 'post', 'post'],
      note: '  重点账号  '
    })
  });
  const patched = await patchedResponse.json();
  assert.equal(patchedResponse.status, 200);
  assert.equal(patched.changed, true);
  assert.deepEqual(patched.entry.eventTypes, ['post', 'profile_bio']);
  assert.equal(patched.entry.note, '重点账号');
  assert.equal(patched.entry.syncStatus, before.syncStatus);
  assert.equal(patched.entry.lastSyncedAt, before.lastSyncedAt);
  assert.equal(patched.counts.pendingCommands, 0);
  assert.equal(socialService.store.getLatestChangeId(), cursorBefore + 1);
  assert.equal(published.length, 1);
  assert.equal(published[0].type, 'watchlist.updated');
  assert.equal(published[0].data.note, '重点账号');

  const snapshot = await (await fetch(`${baseUrl}/api/social/snapshot`)).json();
  assert.equal(snapshot.watchlist.find((item) => item.id === entry.id).note, '重点账号');

  const idempotentResponse = await fetch(`${baseUrl}/api/social/watchlist/${entry.id}`, {
    method: 'PATCH',
    headers: auth(token),
    body: JSON.stringify({ eventTypes: ['post', 'profile_bio'], note: '重点账号' })
  });
  const idempotent = await idempotentResponse.json();
  assert.equal(idempotent.changed, false);
  assert.equal(idempotent.change, null);
  assert.equal(socialService.store.getLatestChangeId(), cursorBefore + 1);
  assert.equal(published.length, 1);

  const emptyResponse = await fetch(`${baseUrl}/api/social/watchlist/${entry.id}`, {
    method: 'PATCH',
    headers: auth(token),
    body: JSON.stringify({ note: '' })
  });
  const empty = await emptyResponse.json();
  assert.equal(empty.entry.note, '');
  assert.deepEqual(empty.entry.eventTypes, ['post', 'profile_bio']);
  assert.equal(empty.entry.syncStatus, before.syncStatus);
  assert.equal(empty.counts.pendingCommands, 0);

  const legacyEventResponse = await fetch(`${baseUrl}/api/social/watchlist/${entry.id}`, {
    method: 'PATCH',
    headers: auth(token),
    body: JSON.stringify({ eventTypes: [] })
  });
  assert.deepEqual((await legacyEventResponse.json()).entry.eventTypes, []);

  for (const eventTypes of ['post', ['unknown']]) {
    const invalid = await fetch(`${baseUrl}/api/social/watchlist/${entry.id}`, {
      method: 'PATCH',
      headers: auth(token),
      body: JSON.stringify({ eventTypes })
    });
    assert.equal(invalid.status, 400);
    assert.equal((await invalid.json()).code, 'INVALID_SOCIAL_DATA');
  }
  for (const body of [
    {},
    { note: null },
    { note: 'valid', unexpected: true },
    { note: '猫'.repeat(501) }
  ]) {
    const invalid = await fetch(`${baseUrl}/api/social/watchlist/${entry.id}`, {
      method: 'PATCH',
      headers: auth(token),
      body: JSON.stringify(body)
    });
    assert.equal(invalid.status, 400);
    assert.equal((await invalid.json()).code, 'INVALID_SOCIAL_DATA');
  }
  const missing = await fetch(`${baseUrl}/api/social/watchlist/999999`, {
    method: 'PATCH',
    headers: auth(token),
    body: JSON.stringify({ eventTypes: ['post'] })
  });
  assert.equal(missing.status, 404);
  assert.equal((await missing.json()).code, 'WATCHLIST_NOT_FOUND');
});

test('large watchlist reconciliation publishes every change beyond the store page limit', async (t) => {
  const { socialService } = await withSocialServer(t, { token: 'large-watchlist-device-token' });
  const published = [];
  const unsubscribe = socialService.subscribe((change) => published.push(change));
  t.after(unsubscribe);
  const accounts = Array.from({ length: 1_005 }, (_, index) => ({
    platform: 'twitter',
    handle: `account_${String(index).padStart(4, '0')}`,
    remoteId: String(index + 1)
  }));

  const result = socialService.reconcileWatchlist(accounts);

  assert.equal(result.changes.length, accounts.length);
  assert.equal(published.length, accounts.length);
  assert.deepEqual(published.map((change) => change.id), result.changes.map((change) => change.id));
  assert.equal(published.at(-1).id, socialService.store.getLatestChangeId());
});

test('watchlist snapshot API rejects legacy snapshots after a versioned bridge session', async (t) => {
  const token = 'versioned-watchlist-device-token';
  const { baseUrl } = await withSocialServer(t, { token });
  const snapshotUrl = `${baseUrl}/api/social/bridge/watchlist/snapshot`;
  const session = {
    complete: true,
    snapshotSessionId: 'chrome-session-current',
    snapshotSessionStartedAt: Date.parse('2026-07-17T12:00:00Z')
  };
  const sendSnapshot = (body) => fetch(snapshotUrl, {
    method: 'POST',
    headers: auth(token),
    body: JSON.stringify(body)
  });

  const first = await sendSnapshot({
    ...session,
    snapshotRevision: 1,
    accounts: [{ handle: 'alice' }]
  });
  assert.equal(first.status, 200);
  assert.equal((await first.json()).snapshot.accepted, true);

  const second = await sendSnapshot({
    ...session,
    snapshotRevision: 2,
    accounts: [{ handle: 'alice' }, { handle: 'bob' }]
  });
  assert.equal(second.status, 200);
  assert.equal((await second.json()).snapshot.accepted, true);

  const lateLegacy = await sendSnapshot({
    complete: true,
    accounts: [{ handle: 'alice' }]
  });
  assert.equal(lateLegacy.status, 200);
  assert.deepEqual((await lateLegacy.json()).snapshot, {
    accepted: false,
    versioned: false,
    reason: 'legacy-snapshot-after-versioned-session'
  });

  const watchlist = await (await fetch(`${baseUrl}/api/social/watchlist`)).json();
  assert.deepEqual(watchlist.entries.map((entry) => entry.handle), ['alice', 'bob']);
});

test('snapshot includes only active personal watchlist posts before applying its limit', async (t) => {
  const token = 'personal-snapshot-device-token';
  const { baseUrl } = await withSocialServer(t, { token });
  const addedResponse = await fetch(`${baseUrl}/api/social/watchlist`, {
    method: 'POST',
    headers: auth(token),
    body: JSON.stringify({ account: { accountKey: 'alice-key', handle: 'alice' } })
  });
  const added = await addedResponse.json();
  const watchlistId = added.entries[0].id;
  const ingested = await fetch(`${baseUrl}/api/social/bridge/posts`, {
    method: 'POST',
    headers: auth(token),
    body: JSON.stringify({
      posts: [
        {
          source: 'twitter',
          id: 'watched-older-post',
          authorHandle: 'Alice',
          text: 'personal monitored account',
          publishedAt: '2026-07-17T12:00:00Z'
        },
        {
          source: 'twitter',
          id: 'noise-newer-post',
          authorHandle: 'noise_account',
          text: 'unrelated historical feed record',
          publishedAt: '2026-07-17T12:01:00Z'
        }
      ]
    })
  });
  assert.equal(ingested.status, 200);

  let snapshot = await (await fetch(`${baseUrl}/api/social?postLimit=1`)).json();
  assert.deepEqual(snapshot.posts.map((post) => post.externalId), ['watched-older-post']);

  const emptyPreferences = await fetch(`${baseUrl}/api/social/watchlist/${watchlistId}`, {
    method: 'PATCH',
    headers: auth(token),
    body: JSON.stringify({ eventTypes: [] })
  });
  assert.equal(emptyPreferences.status, 200);
  snapshot = await (await fetch(`${baseUrl}/api/social?postLimit=1`)).json();
  assert.deepEqual(snapshot.posts, []);

  const postPreferences = await fetch(`${baseUrl}/api/social/watchlist/${watchlistId}`, {
    method: 'PATCH',
    headers: auth(token),
    body: JSON.stringify({ eventTypes: ['post'] })
  });
  assert.equal(postPreferences.status, 200);
  snapshot = await (await fetch(`${baseUrl}/api/social?postLimit=1`)).json();
  assert.deepEqual(snapshot.posts.map((post) => post.externalId), ['watched-older-post']);

  const removed = await fetch(`${baseUrl}/api/social/watchlist/${watchlistId}`, {
    method: 'DELETE',
    headers: auth(token)
  });
  assert.equal(removed.status, 202);
  snapshot = await (await fetch(`${baseUrl}/api/social?postLimit=1`)).json();
  assert.deepEqual(snapshot.posts, []);

  const readded = await fetch(`${baseUrl}/api/social/watchlist`, {
    method: 'POST',
    headers: auth(token),
    body: JSON.stringify({ account: { accountKey: 'alice-key', handle: 'alice' } })
  });
  assert.equal(readded.status, 202);
  snapshot = await (await fetch(`${baseUrl}/api/social?postLimit=1`)).json();
  assert.deepEqual(snapshot.posts.map((post) => post.externalId), ['watched-older-post']);

  const fullHistory = await (await fetch(`${baseUrl}/api/social/posts?limit=10`)).json();
  assert.deepEqual(
    fullHistory.posts.map((post) => post.externalId).sort(),
    ['noise-newer-post', 'watched-older-post'].sort()
  );
});

test('social posts API persists merged feed membership and filters featured and my feeds', async (t) => {
  const token = 'feed-device-token';
  const { baseUrl } = await withSocialServer(t, { token });
  const ingest = async (post) => fetch(`${baseUrl}/api/social/bridge/posts`, {
    method: 'POST',
    headers: auth(token),
    body: JSON.stringify({ posts: [post] })
  });

  assert.equal((await ingest({
    source: 'twitter',
    id: 'shared',
    text: 'shared post',
    feedSource: 'all',
    sourceUpdatedAt: '2026-07-17T12:00:00Z'
  })).status, 200);
  assert.equal((await ingest({
    source: 'twitter',
    id: 'shared',
    feed_source: 'featured',
    sourceUpdatedAt: '2026-07-17T11:59:00Z'
  })).status, 200);
  assert.equal((await ingest({
    source: 'twitter',
    id: 'mine-only',
    text: 'mine',
    feedSources: ['my']
  })).status, 200);

  const featured = await (await fetch(`${baseUrl}/api/social/posts?feedSource=featured`)).json();
  assert.deepEqual(featured.posts.map((post) => post.externalId), ['shared']);
  assert.deepEqual(featured.posts[0].feedSources, ['all', 'featured']);

  const mine = await (await fetch(`${baseUrl}/api/social/posts?feed_source=mine`)).json();
  assert.deepEqual(mine.posts.map((post) => post.externalId), ['mine-only']);

  const all = await (await fetch(`${baseUrl}/api/social/posts?feedSource=all`)).json();
  assert.equal(all.posts.length, 2);
  const invalid = await fetch(`${baseUrl}/api/social/posts?feedSource=unknown`);
  assert.equal(invalid.status, 400);
  assert.equal((await invalid.json()).code, 'INVALID_SOCIAL_DATA');
});

test('social posts API persists validated relationship and profile activity', async (t) => {
  const token = 'relationship-device-token';
  const { baseUrl } = await withSocialServer(t, { token });
  const encodedUnfollow = Buffer.from('unfollow:star_okx:bankrbot').toString('base64url');
  const discoveredAt = Date.parse('2026-07-17T12:00:00.123Z');
  const response = await fetch(`${baseUrl}/api/social/bridge/posts`, {
    method: 'POST',
    headers: auth(token),
    body: JSON.stringify({
      posts: [
        {
          source: 'twitter',
          id: encodedUnfollow,
          author: { handle: 'star_okx', name: 'Star_OKX', followersCount: 234_880 },
          target: {
            id: 'bankr-user',
            handle: 'bankrbot',
            name: 'Bankr',
            followersCount: 12_345,
            url: 'https://x.com/bankrbot'
          },
          feedSource: 'my',
          publishedAt: '2026-07-17T12:00:00Z'
        },
        {
          source: 'twitter',
          id: 'follow_star_okx_enzoinsidee',
          authorHandle: 'star_okx',
          authorName: 'Star_OKX',
          targetHandle: 'enzoinsidee',
          feedSource: 'my',
          publishedAt: '2026-07-17T12:01:00Z'
        },
        {
          source: 'twitter',
          id: 'profile:star_okx:1785048000000',
          kind: 'profile',
          authorHandle: 'star_okx',
          profileChanges: ['avatar', 'name'],
          profileDetail: {
            name: { before: 'Star', after: 'Star_OKX' },
            avatar: {
              before: 'https://pbs.twimg.com/profile_images/old.jpg',
              after: 'https://pbs.twimg.com/profile_images/new.jpg'
            }
          },
          feedSource: 'my',
          publishedAt: '2026-07-17T12:01:30Z'
        },
        {
          source: 'twitter',
          id: '1900000000000000000',
          kind: 'post',
          authorHandle: 'star_okx',
          text: 'A real tweet',
          feedSource: 'my',
          debotDiscoveredAt: discoveredAt,
          publishedAt: '2026-07-17T12:02:00Z'
        }
      ]
    })
  });
  assert.equal(response.status, 200);
  const ingestion = await response.json();
  assert.deepEqual(ingestion.summary, {
    created: 4,
    updated: 0,
    deleted: 0,
    restored: 0,
    unchanged: 0,
    filtered: 0
  });
  assert.deepEqual(ingestion.filtered, []);

  const payload = await (await fetch(`${baseUrl}/api/social/posts?feedSource=my`)).json();
  assert.deepEqual(payload.posts.map((post) => post.kind), ['post', 'profile', 'follow', 'unfollow']);
  const tweet = payload.posts.find((post) => post.kind === 'post');
  assert.equal(tweet.debotDiscoveredAt, discoveredAt);
  assert.equal(tweet.discoveredAt, discoveredAt);
  assert.equal(tweet.receivedAt, discoveredAt);
  assert.equal(tweet.vpsIngestedAt >= discoveredAt, true);
  assert.equal(tweet.ingestedAt, tweet.vpsIngestedAt);
  assert.equal(tweet.storedAt, tweet.vpsIngestedAt);
  const profile = payload.posts.find((post) => post.kind === 'profile');
  assert.deepEqual(profile.profileChanges, ['name', 'avatar']);
  assert.deepEqual(profile.profileDetail.name, { before: 'Star', after: 'Star_OKX' });
  assert.deepEqual(profile.profileDetail.avatar, {
    before: 'https://pbs.twimg.com/profile_images/old.jpg',
    after: 'https://pbs.twimg.com/profile_images/new.jpg'
  });

  const searched = await (await fetch(`${baseUrl}/api/social/posts?q=bankrbot`)).json();
  assert.deepEqual(searched.posts.map((post) => post.kind), ['unfollow']);

  const unverifiedProfile = await fetch(`${baseUrl}/api/social/bridge/posts`, {
    method: 'POST',
    headers: auth(token),
    body: JSON.stringify({
      posts: [{
        source: 'twitter',
        id: 'profile:star_okx:1785049000000',
        kind: 'profile',
        authorHandle: 'star_okx'
      }]
    })
  });
  assert.equal(unverifiedProfile.status, 400);
  assert.equal((await unverifiedProfile.json()).code, 'INVALID_SOCIAL_DATA');
});

test('DeBot analysis bridge uses bearer-only claims, inflight dedupe and short result caching', async (t) => {
  const token = 'analysis-device-token';
  const tokenAddress = '0x1111111111111111111111111111111111111111';
  const { baseUrl, socialService } = await withSocialServer(t, { token });

  await assert.rejects(
    socialService.requestDeBot('debot.token_detail.v1', {
      chain: 'robinhood',
      token: tokenAddress
    }),
    { code: 'DEBOT_BRIDGE_UNAVAILABLE' }
  );
  await fetch(`${baseUrl}/api/social/bridge/heartbeat`, {
    method: 'POST',
    headers: auth(token),
    body: JSON.stringify({ capabilities: ['posts', 'watchlist'] })
  });
  await assert.rejects(
    socialService.requestDeBot('debot.token_detail.v1', {
      chain: 'robinhood',
      token: tokenAddress
    }),
    { code: 'DEBOT_BRIDGE_UNAVAILABLE' }
  );
  await fetch(`${baseUrl}/api/social/bridge/heartbeat`, {
    method: 'POST',
    headers: auth(token),
    body: JSON.stringify({
      bridgeId: 'chrome-analysis',
      version: '1.1.0',
      capabilities: ['posts', 'debot-analysis-v1']
    })
  });

  assert.throws(() => socialService.requestDeBot('debot.token_detail.v1', {
    chain: 'base',
    token: tokenAddress
  }), /Robinhood chain/);
  assert.throws(() => socialService.requestDeBot('debot.token_detail.v1', {
    chain: 'robinhood',
    token: '0x1234'
  }), /valid non-zero EVM address/);

  const first = socialService.requestDeBot('debot.token_detail.v1', {
    chain: 'robinhood',
    token: tokenAddress
  });
  const duplicate = socialService.requestDeBot('debot.token_detail.v1', {
    token: tokenAddress.toUpperCase().replace('0X', '0x'),
    chain: 'ROBINHOOD'
  });
  const headerFallback = await fetch(`${baseUrl}/api/social/bridge/debot/jobs`, {
    headers: { 'x-social-bridge-token': token }
  });
  assert.equal(headerFallback.status, 401);
  const publicEnqueue = await fetch(`${baseUrl}/api/social/bridge/debot/jobs`, {
    method: 'POST',
    headers: auth(token),
    body: JSON.stringify({ type: 'debot.token_detail.v1', payload: { chain: 'robinhood', token: tokenAddress } })
  });
  assert.equal(publicEnqueue.status, 405);

  const claimedResponse = await fetch(`${baseUrl}/api/social/bridge/debot/jobs?limit=4`, {
    headers: { authorization: `Bearer ${token}` }
  });
  const claimed = await claimedResponse.json();
  assert.equal(claimedResponse.status, 200);
  assert.equal(claimed.jobs.length, 1);
  assert.equal(claimed.jobs[0].type, 'debot.token_detail.v1');
  assert.deepEqual(claimed.jobs[0].payload, { chain: 'robinhood', token: tokenAddress });
  assert.match(claimed.jobs[0].claimToken, /^[A-Za-z0-9_-]{32}$/);

  const rejectedClaim = await fetch(
    `${baseUrl}/api/social/bridge/debot/jobs/${claimed.jobs[0].id}/result`,
    {
      method: 'POST',
      headers: auth(token),
      body: JSON.stringify({ claimToken: 'wrong-claim-token', success: true, result: { token: {} } })
    }
  );
  assert.equal(rejectedClaim.status, 409);
  assert.equal((await rejectedClaim.json()).code, 'DEBOT_JOB_CLAIM_INVALID');

  const mismatchedResult = await fetch(
    `${baseUrl}/api/social/bridge/debot/jobs/${claimed.jobs[0].id}/result`,
    {
      method: 'POST',
      headers: auth(token),
      body: JSON.stringify({
        claimToken: claimed.jobs[0].claimToken,
        success: true,
        result: {
          token: {
            meta: {
              chain: 'robinhood',
              address: '0x9999999999999999999999999999999999999999'
            }
          }
        }
      })
    }
  );
  assert.equal(mismatchedResult.status, 400);

  const rawResult = {
    token: { meta: { chain: 'robinhood', address: tokenAddress, symbol: 'TEST' } }
  };
  const completedResponse = await fetch(
    `${baseUrl}/api/social/bridge/debot/jobs/${claimed.jobs[0].id}/result`,
    {
      method: 'POST',
      headers: auth(token),
      body: JSON.stringify({ claimToken: claimed.jobs[0].claimToken, success: true, result: rawResult })
    }
  );
  assert.equal(completedResponse.status, 200);
  assert.deepEqual(await completedResponse.json(), { ok: true });
  const expected = { schema: 'debot.token_detail.raw.v1', data: rawResult };
  assert.deepEqual(await first, expected);
  assert.deepEqual(await duplicate, expected);

  const repeatedAck = await fetch(
    `${baseUrl}/api/social/bridge/debot/jobs/${claimed.jobs[0].id}/result`,
    {
      method: 'POST',
      headers: auth(token),
      body: JSON.stringify({ claimToken: claimed.jobs[0].claimToken, success: true, result: rawResult })
    }
  );
  assert.equal(repeatedAck.status, 200);
  assert.deepEqual(await socialService.requestDeBot('debot.token_detail.v1', {
    chain: 'robinhood',
    token: tokenAddress
  }), expected);
  const empty = await (await fetch(`${baseUrl}/api/social/bridge/debot/jobs`, {
    headers: { authorization: `Bearer ${token}` }
  })).json();
  assert.deepEqual(empty.jobs, []);
});

test('DeBot result endpoint enforces payload limits and stores only coarse remote errors', async (t) => {
  const token = 'analysis-limits-token';
  const tokenAddress = '0x2222222222222222222222222222222222222222';
  const wallet = '0xaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa';
  const { baseUrl, socialService } = await withSocialServer(t, { token });
  await fetch(`${baseUrl}/api/social/bridge/heartbeat`, {
    method: 'POST',
    headers: auth(token),
    body: JSON.stringify({ capabilities: ['posts', 'debot-analysis-v1'] })
  });

  const pending = socialService.requestDeBot('debot.wallet_token_analysis.v1', {
    chain: 'robinhood',
    token: tokenAddress,
    wallet
  });
  const pendingFailure = assert.rejects(pending, (error) => {
    assert.equal(error.code, 'DEBOT_BRIDGE_REQUEST_FAILED');
    assert.equal(error.message.includes('authorization Bearer should-never-be-stored'), false);
    return true;
  });
  const job = (await (await fetch(`${baseUrl}/api/social/bridge/debot/jobs`, {
    headers: { authorization: `Bearer ${token}` }
  })).json()).jobs[0];
  const tooLarge = await fetch(`${baseUrl}/api/social/bridge/debot/jobs/${job.id}/result`, {
    method: 'POST',
    headers: auth(token),
    body: JSON.stringify({
      claimToken: job.claimToken,
      success: true,
      result: {
        chain: 'robinhood',
        token: tokenAddress,
        wallet,
        payload: 'x'.repeat(260 * 1024)
      }
    })
  });
  assert.equal(tooLarge.status, 413);
  assert.equal((await tooLarge.json()).code, 'DEBOT_RESULT_TOO_LARGE');

  const secret = 'authorization Bearer should-never-be-stored';
  const failed = await fetch(`${baseUrl}/api/social/bridge/debot/jobs/${job.id}/result`, {
    method: 'POST',
    headers: auth(token),
    body: JSON.stringify({
      claimToken: job.claimToken,
      success: false,
      error: secret,
      errorType: 'NETWORK'
    })
  });
  assert.equal(failed.status, 200);
  await pendingFailure;
  const stored = socialService.store.getDeBotJob(job.id);
  assert.equal(stored.errorCode, 'NETWORK');
  assert.equal(stored.errorMessage.includes(secret), false);

  const bodyLimit = await fetch(`${baseUrl}/api/social/bridge/debot/jobs/${job.id}/result`, {
    method: 'POST',
    headers: auth(token),
    body: JSON.stringify({ padding: 'x'.repeat(513 * 1024) })
  });
  assert.equal(bodyLimit.status, 413);
  assert.equal((await bodyLimit.json()).code, 'BODY_TOO_LARGE');
});

test('social SSE caps public connections and releases capacity after cleanup', async () => {
  const socialService = createControlledSocialService();
  const handler = createSocialApiHandler({ service: socialService, maxStreams: 2 });
  const first = await openControlledStream(handler);
  const second = await openControlledStream(handler);
  assert.equal(first.response.statusCode, 200);
  assert.equal(second.response.statusCode, 200);
  assert.equal(socialService.subscriberCount, 2);

  const rejected = await openControlledStream(handler);
  assert.equal(rejected.response.statusCode, 503);
  assert.equal(rejected.response.headers['retry-after'], '1');
  assert.deepEqual(JSON.parse(rejected.response.text()), {
    ok: false,
    error: 'Too many active social streams; reconnect shortly',
    code: 'SOCIAL_STREAM_CAPACITY',
    retryable: true
  });
  assert.equal(socialService.subscriberCount, 2);

  first.request.emit('close');
  assert.equal(socialService.subscriberCount, 1);
  const replacement = await openControlledStream(handler);
  assert.equal(replacement.response.statusCode, 200);
  assert.match(replacement.response.text(), /event: heartbeat/);
  assert.equal(socialService.subscriberCount, 2);

  handler.closeStreams();
  assert.equal(socialService.subscriberCount, 0);
  assert.match(second.response.text(), /retry: 1000/);
  assert.match(replacement.response.text(), /retry: 1000/);
});

test('social SSE limits each proxy client without consuming capacity for other clients', async () => {
  const socialService = createControlledSocialService();
  const handler = createSocialApiHandler({
    service: socialService,
    maxStreams: 6,
    maxStreamsPerClient: 2
  });
  const fromClient = (address) => ({ headers: { 'x-forwarded-for': address } });
  const first = await openControlledStream(handler, new ControlledSseResponse(), fromClient('198.51.100.10'));
  const second = await openControlledStream(handler, new ControlledSseResponse(), fromClient('198.51.100.10'));
  const rejected = await openControlledStream(
    handler,
    new ControlledSseResponse(),
    fromClient('203.0.113.99, 198.51.100.10')
  );
  assert.equal(rejected.response.statusCode, 503);
  assert.equal(JSON.parse(rejected.response.text()).code, 'SOCIAL_STREAM_CLIENT_CAPACITY');

  const otherClient = await openControlledStream(
    handler,
    new ControlledSseResponse(),
    fromClient('198.51.100.11')
  );
  assert.equal(otherClient.response.statusCode, 200);

  first.request.emit('close');
  const replacement = await openControlledStream(
    handler,
    new ControlledSseResponse(),
    fromClient('198.51.100.10')
  );
  assert.equal(replacement.response.statusCode, 200);
  handler.closeStreams();
  assert.equal(socialService.subscriberCount, 0);
  assert.equal(second.response.writableEnded, true);
});

test('social SSE bounds each slow client without delaying healthy clients', async () => {
  const socialService = createControlledSocialService();
  const handler = createSocialApiHandler({
    service: socialService,
    maxStreams: 3,
    maxPendingEvents: 2,
    maxPendingBytes: 10_000
  });
  const slow = await openControlledStream(handler);
  const fast = await openControlledStream(handler);

  slow.response.backpressured = true;
  socialService.publish();
  socialService.publish();
  socialService.publish();
  assert.equal(slow.response.destroyed, false);
  assert.equal((slow.response.text().match(/event: post\.created/g) || []).length, 1);
  assert.equal((fast.response.text().match(/event: post\.created/g) || []).length, 3);

  slow.response.backpressured = false;
  slow.response.emit('drain');
  assert.equal((slow.response.text().match(/event: post\.created/g) || []).length, 3);

  slow.response.backpressured = true;
  socialService.publish();
  socialService.publish();
  socialService.publish();
  socialService.publish();
  assert.equal(slow.response.destroyed, true);
  assert.equal(socialService.subscriberCount, 1);
  assert.equal((fast.response.text().match(/event: post\.created/g) || []).length, 7);
  assert.match(fast.response.text(), /"externalId":"event-7"/);

  const replacement = await openControlledStream(handler);
  assert.equal(replacement.response.statusCode, 200);
  assert.equal(socialService.subscriberCount, 2);
  handler.closeStreams();
  assert.equal(socialService.subscriberCount, 0);
});

test('social SSE sends an initial snapshot and live normalized changes', async (t) => {
  const token = 'stream-device-token';
  const { baseUrl } = await withSocialServer(t, { token });
  const discoveredAt = Date.parse('2026-07-17T12:00:00.456Z');
  const added = await (await fetch(`${baseUrl}/api/social/watchlist`, {
    method: 'POST',
    headers: auth(token),
    body: JSON.stringify({ account: '@alice' })
  })).json();
  const watchlistId = added.entries[0].id;
  const controller = new AbortController();
  const response = await fetch(`${baseUrl}/api/social/stream`, { signal: controller.signal });
  assert.equal(response.status, 200);
  assert.match(response.headers.get('content-type'), /text\/event-stream/);
  const reader = response.body.getReader();
  const decoder = new TextDecoder();
  let received = '';
  const first = await reader.read();
  received += decoder.decode(first.value, { stream: true });
  assert.match(received, /event: snapshot/);

  await fetch(`${baseUrl}/api/social/watchlist/${watchlistId}`, {
    method: 'PATCH',
    headers: auth(token),
    body: JSON.stringify({ note: 'SSE 实时备注' })
  });
  while (!received.includes('event: watchlist.updated')) {
    const chunk = await reader.read();
    if (chunk.done) break;
    received += decoder.decode(chunk.value, { stream: true });
  }
  assert.match(received, /event: watchlist\.updated/);
  assert.match(received, /"note":"SSE 实时备注"/);

  await fetch(`${baseUrl}/api/social/bridge/posts`, {
    method: 'POST',
    headers: auth(token),
    body: JSON.stringify({
      posts: [{ source: 'twitter', id: 'stream-1', text: 'live', debotDiscoveredAt: discoveredAt }]
    })
  });
  while (!received.includes('event: post.created')) {
    const chunk = await reader.read();
    if (chunk.done) break;
    received += decoder.decode(chunk.value, { stream: true });
  }
  assert.match(received, /event: post\.created/);
  assert.match(received, /"externalId":"stream-1"/);
  assert.match(received, new RegExp(`"debotDiscoveredAt":${discoveredAt}`));
  assert.match(received, /"vpsIngestedAt":\d+/);
  controller.abort();
});

test('social status exposes its cursor and SSE replays a backlog larger than one page', async (t) => {
  const { baseUrl, socialService } = await withSocialServer(t, { token: 'replay-device-token' });
  socialService.ingestPosts([{ source: 'twitter', id: 'replay-seed', text: 'seed' }]);
  const after = socialService.store.getLatestChangeId();
  const backlogSize = 1_005;
  for (let offset = 0; offset < backlogSize; offset += 200) {
    socialService.ingestPosts(Array.from(
      { length: Math.min(200, backlogSize - offset) },
      (_, index) => ({
        source: 'twitter',
        id: `replay-${offset + index}`,
        text: `backlog ${offset + index}`
      })
    ));
  }
  const backlogLatest = socialService.store.getLatestChangeId();
  assert.equal(backlogLatest, after + backlogSize);

  const statusResponse = await fetch(`${baseUrl}/api/social/status`);
  const status = await statusResponse.json();
  assert.equal(statusResponse.status, 200);
  assert.equal(status.latestChangeId, backlogLatest);
  assert.match(status.streamEpoch, /^[0-9a-f-]{36}$/i);

  const controller = new AbortController();
  const response = await fetch(`${baseUrl}/api/social/stream?after=${after}`, { signal: controller.signal });
  assert.equal(response.status, 200);
  socialService.ingestPosts([{ source: 'twitter', id: 'replay-live', text: 'arrived during replay' }]);
  const expectedLatest = socialService.store.getLatestChangeId();
  assert.equal(expectedLatest, backlogLatest + 1);
  const reader = response.body.getReader();
  const decoder = new TextDecoder();
  let received = '';
  const timeout = setTimeout(() => controller.abort(), 5_000);
  try {
    while (!received.includes('event: heartbeat')) {
      const chunk = await reader.read();
      if (chunk.done) break;
      received += decoder.decode(chunk.value, { stream: true });
    }
  } finally {
    clearTimeout(timeout);
    controller.abort();
    await reader.cancel().catch(() => {});
  }
  const replayedIds = [...received.matchAll(/^id: (\d+)$/gm)].map((match) => Number(match[1]));
  assert.equal(received.includes('event: snapshot'), false);
  assert.equal(replayedIds.length, backlogSize + 1);
  assert.equal(replayedIds[0], after + 1);
  assert.equal(replayedIds.at(-1), expectedLatest);
  assert.equal(new Set(replayedIds).size, backlogSize + 1);
  assert.match(received, new RegExp(`"latestChangeId":${expectedLatest}`));

  const resetController = new AbortController();
  const resetResponse = await fetch(
    `${baseUrl}/api/social/stream?after=${expectedLatest + 10}&epoch=${status.streamEpoch}`,
    { signal: resetController.signal }
  );
  const resetReader = resetResponse.body.getReader();
  const resetDecoder = new TextDecoder();
  let resetText = '';
  const resetTimeout = setTimeout(() => resetController.abort(), 2_000);
  while (!resetText.includes('event: heartbeat')) {
    const resetChunk = await resetReader.read();
    if (resetChunk.done) break;
    resetText += resetDecoder.decode(resetChunk.value, { stream: true });
  }
  clearTimeout(resetTimeout);
  resetController.abort();
  await resetReader.cancel().catch(() => {});
  assert.match(resetText, /event: reset/);
  assert.match(resetText, new RegExp(`"latestChangeId":${expectedLatest}`));
  assert.match(resetText, new RegExp(`"streamEpoch":"${status.streamEpoch}"`));
});

test('server shutdown drains active social SSE before closing its store', async (t) => {
  const { baseUrl, server, socialService } = await withSocialServer(t, {
    token: 'shutdown-device-token'
  });
  const closeStore = socialService.store.close.bind(socialService.store);
  let storeCloseCalls = 0;
  socialService.store.close = () => {
    storeCloseCalls += 1;
    closeStore();
  };

  const response = await fetch(`${baseUrl}/api/social/stream`);
  const reader = response.body.getReader();
  const decoder = new TextDecoder();
  const first = await reader.read();
  assert.match(decoder.decode(first.value, { stream: true }), /event: snapshot/);

  let timeout;
  await Promise.race([
    new Promise((resolve, reject) => {
      server.close((error) => error ? reject(error) : resolve());
    }),
    new Promise((_, reject) => {
      timeout = setTimeout(() => reject(new Error('server.close timed out with an active social SSE client')), 1_000);
      timeout.unref?.();
    })
  ]).finally(() => clearTimeout(timeout));

  let remainder = '';
  while (true) {
    const chunk = await reader.read();
    if (chunk.done) break;
    remainder += decoder.decode(chunk.value, { stream: true });
  }
  remainder += decoder.decode();
  assert.match(remainder, /retry: 1000/);
  assert.equal(server.listening, false);
  server.closeSocialStreams();
  socialService.close();
  assert.equal(storeCloseCalls, 1);
});
