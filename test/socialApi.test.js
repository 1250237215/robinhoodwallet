import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

import { createRobinhoodStandaloneServer } from '../src/robinhoodServer.js';
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
    await new Promise((resolve) => server.close(resolve));
    fs.rmSync(directory, { recursive: true, force: true });
  });
  return { baseUrl, socialService };
}

function auth(token) {
  return { authorization: `Bearer ${token}`, 'content-type': 'application/json' };
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
  const { baseUrl } = await withSocialServer(t, { token });
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

  const failedHeartbeat = await fetch(`${baseUrl}/api/social/bridge/heartbeat`, {
    method: 'POST',
    headers: auth(token),
    body: JSON.stringify({ bridgeId: 'chrome-main', version: '1.0.0', capabilities: ['error'] })
  });
  const failedBridge = (await failedHeartbeat.json()).bridge;
  assert.equal(failedHeartbeat.status, 200);
  assert.equal(failedBridge.state, 'error');
  assert.equal(failedBridge.online, false);
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

test('social SSE sends an initial snapshot and live normalized changes', async (t) => {
  const token = 'stream-device-token';
  const { baseUrl } = await withSocialServer(t, { token });
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

  await fetch(`${baseUrl}/api/social/bridge/posts`, {
    method: 'POST',
    headers: auth(token),
    body: JSON.stringify({ posts: [{ source: 'twitter', id: 'stream-1', text: 'live' }] })
  });
  while (!received.includes('event: post.created')) {
    const chunk = await reader.read();
    if (chunk.done) break;
    received += decoder.decode(chunk.value, { stream: true });
  }
  assert.match(received, /event: post\.created/);
  assert.match(received, /"externalId":"stream-1"/);
  controller.abort();
});
