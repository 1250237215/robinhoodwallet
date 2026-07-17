import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { DatabaseSync } from 'node:sqlite';

import { createSocialConfig } from '../src/social/config.js';
import { normalizeFeedSources, normalizeSocialPost } from '../src/social/normalize.js';
import { createSocialStore } from '../src/social/store.js';

function fixture(t, initialNow = Date.parse('2026-07-17T12:00:00Z')) {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'robinhood-social-store-'));
  let timestamp = initialNow;
  const store = createSocialStore(path.join(directory, 'social.sqlite'), { now: () => timestamp });
  t.after(() => {
    store.close();
    fs.rmSync(directory, { recursive: true, force: true });
  });
  return {
    store,
    setNow(value) {
      timestamp = value;
    }
  };
}

test('social config uses an independent database and bounded bridge settings', () => {
  assert.equal(createSocialConfig({}).bridgeOfflineMs, 90_000);
  const config = createSocialConfig({
    SOCIAL_DATA_FILE: '/tmp/independent-social.sqlite',
    SOCIAL_BRIDGE_TOKEN: ' device-secret ',
    SOCIAL_RETENTION_DAYS: '14',
    SOCIAL_BRIDGE_OFFLINE_MS: '25000',
    SOCIAL_COMMAND_LEASE_MS: '45000'
  });
  assert.equal(config.dataFile, '/tmp/independent-social.sqlite');
  assert.equal(config.bridgeToken, 'device-secret');
  assert.equal(config.retentionDays, 14);
  assert.equal(config.bridgeOfflineMs, 25_000);
  assert.equal(config.commandLeaseMs, 45_000);
});

test('social feed sources normalize aliases, flags, ordering and missing values', () => {
  assert.deepEqual(normalizeFeedSources(['mine', 'HOT', 'all', 'unknown', 'featured']), [
    'all',
    'featured',
    'my'
  ]);
  assert.deepEqual(normalizeFeedSources({ all: true, featured: false, my: true }), ['all', 'my']);
  assert.deepEqual(normalizeSocialPost({ source: 'x', id: 'default-feed' }).feedSources, ['all']);
  assert.deepEqual(normalizeSocialPost({
    source: 'x',
    id: 'aliased-feeds',
    feed_source: 'mine',
    isFeatured: true
  }).feedSources, ['featured', 'my']);
});

test('social posts are normalized, deduplicated, updated and tombstoned in place', (t) => {
  const { store, setNow } = fixture(t);
  const created = store.upsertPosts([{
    source: 'x',
    tweetId: 'tweet-42',
    author: { id: 'user-1', username: 'alice', name: 'Alice', followersCount: 12_345 },
    text: 'New CA 0x1111111111111111111111111111111111111111',
    createdAt: '2026-07-17T11:59:00Z',
    url: 'https://x.com/alice/status/tweet-42'
  }])[0];
  assert.equal(created.action, 'created');
  assert.equal(created.post.source, 'twitter');
  assert.equal(created.post.author.handle, 'alice');
  assert.equal(created.post.contractAddresses[0].address, '0x1111111111111111111111111111111111111111');

  setNow(Date.parse('2026-07-17T12:01:00Z'));
  const duplicate = store.upsertPosts([{
    source: 'twitter',
    id: 'tweet-42',
    text: 'New CA 0x1111111111111111111111111111111111111111',
    createdAt: '2026-07-17T11:59:00Z'
  }])[0];
  assert.equal(duplicate.action, 'unchanged');
  assert.equal(store.getCounts().posts, 1);

  const updated = store.upsertPosts([{
    source: 'twitter',
    id: 'tweet-42',
    translatedText: '新的合约地址',
    updatedAt: '2026-07-17T12:01:00Z'
  }])[0];
  assert.equal(updated.action, 'updated');
  assert.equal(updated.post.translatedContent, '新的合约地址');
  assert.equal(updated.post.content.startsWith('New CA'), true);

  setNow(Date.parse('2026-07-17T12:02:00Z'));
  const deletion = store.deletePost('x', 'tweet-42');
  assert.equal(deletion.action, 'deleted');
  assert.equal(deletion.post.id, created.post.id);
  assert.equal(deletion.post.deleted, true);
  assert.equal(deletion.post.content.startsWith('New CA'), true);
  assert.deepEqual(
    store.listChanges().map((change) => change.type),
    ['post.created', 'post.updated', 'post.deleted']
  );
});

test('explicit contract metadata wins over duplicate addresses detected in post text', (t) => {
  const { store } = fixture(t);
  const address = '0x1111111111111111111111111111111111111111';
  const created = store.upsertPosts([{
    source: 'twitter',
    id: 'contract-chain',
    text: `Robinhood launch ${address}`,
    contractAddresses: [{ address, chain: 'robinhood' }]
  }])[0].post;

  assert.deepEqual(created.contractAddresses, [{ address, chain: 'robinhood' }]);
  assert.deepEqual(created.chainTags, ['robinhood']);
});

test('post upserts union all, featured and my membership without accepting stale content', (t) => {
  const { store, setNow } = fixture(t);
  const newestAt = Date.parse('2026-07-17T12:00:00Z');
  const olderAt = Date.parse('2026-07-17T11:55:00Z');
  store.upsertPosts([{
    source: 'twitter',
    id: 'multi-feed',
    text: 'newest content',
    feedSource: 'all',
    sourceUpdatedAt: newestAt,
    publishedAt: olderAt
  }]);

  setNow(Date.parse('2026-07-17T12:01:00Z'));
  const staleFeatured = store.upsertPosts([{
    source: 'twitter',
    id: 'multi-feed',
    text: 'stale content must not replace newest content',
    feed_sources: ['featured'],
    sourceUpdatedAt: olderAt,
    publishedAt: olderAt
  }])[0];
  assert.equal(staleFeatured.action, 'updated');
  assert.equal(staleFeatured.post.content, 'newest content');
  assert.equal(staleFeatured.post.sourceUpdatedAt, newestAt);
  assert.deepEqual(staleFeatured.post.feedSources, ['all', 'featured']);

  const myFeed = store.upsertPosts([{
    source: 'twitter',
    id: 'multi-feed',
    feedSource: 'watchlist',
    sourceUpdatedAt: newestAt
  }])[0];
  assert.equal(myFeed.action, 'updated');
  assert.deepEqual(myFeed.post.feedSources, ['all', 'featured', 'my']);

  const duplicateMembership = store.upsertPosts([{
    source: 'twitter',
    id: 'multi-feed',
    feedSources: ['my', 'all', 'featured'],
    sourceUpdatedAt: newestAt
  }])[0];
  assert.equal(duplicateMembership.action, 'unchanged');

  assert.deepEqual(store.listPosts({ feedSource: 'featured' }).map((post) => post.externalId), ['multi-feed']);
  assert.deepEqual(store.listPosts({ feedSource: 'mine' }).map((post) => post.externalId), ['multi-feed']);
  assert.deepEqual(store.listPosts({ feedSource: 'all' }).map((post) => post.externalId), ['multi-feed']);
  assert.throws(() => store.listPosts({ feedSource: 'unsupported' }), /Unsupported social feed source/);

  const deleted = store.deletePost('twitter', 'multi-feed');
  assert.deepEqual(deleted.post.feedSources, ['all', 'featured', 'my']);
});

test('feed membership survives database reopen and legacy schema migration', (t) => {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'robinhood-social-feed-migration-'));
  const filename = path.join(directory, 'social.sqlite');
  t.after(() => fs.rmSync(directory, { recursive: true, force: true }));

  let store = createSocialStore(filename);
  store.upsertPosts([{
    source: 'twitter',
    id: 'persisted-feed',
    text: 'persisted',
    feedSources: ['featured', 'my']
  }]);
  store.close();

  store = createSocialStore(filename);
  assert.deepEqual(store.getPost('twitter', 'persisted-feed').feedSources, ['featured', 'my']);
  store.close();

  const legacy = new DatabaseSync(filename);
  legacy.exec('ALTER TABLE social_posts DROP COLUMN feed_sources_json');
  legacy.close();

  store = createSocialStore(filename);
  assert.deepEqual(store.getPost('twitter', 'persisted-feed').feedSources, ['all']);
  const column = store.db.prepare('PRAGMA table_info(social_posts)').all()
    .find((item) => item.name === 'feed_sources_json');
  assert.equal(Boolean(column), true);
  store.close();
});

test('watchlist intents create authenticated bridge commands and acknowledgements update sync state', (t) => {
  const { store, setNow } = fixture(t);
  const added = store.addWatchAccounts([
    '@alice',
    { platform: 'binance-square', handle: 'Bob', name: 'Bob Square' }
  ]);
  assert.equal(added.length, 2);
  assert.equal(added[0].entry.syncStatus, 'pending');
  assert.equal(store.getCounts().pendingCommands, 2);

  const claimed = store.claimCommands({ limit: 10, leaseMs: 30_000 });
  assert.equal(claimed.length, 2);
  assert.equal(claimed[0].type, 'watchlist.add');
  setNow(Date.parse('2026-07-17T12:00:05Z'));
  const acknowledged = store.acknowledgeCommand(claimed[0].id, { success: true, remoteId: 'remote-alice' });
  assert.equal(acknowledged.status, 'completed');
  const alice = store.listWatchlist().find((entry) => entry.handle === 'alice');
  assert.equal(alice.syncStatus, 'synced');
  assert.equal(alice.remoteId, 'remote-alice');

  const removed = store.removeWatchAccount(alice.id);
  assert.equal(removed.entry.desiredState, 'removed');
  assert.equal(removed.command.type, 'watchlist.delete');
  assert.equal(store.listWatchlist().some((entry) => entry.id === alice.id), false);
  assert.equal(store.listWatchlist({ includeRemoved: true }).some((entry) => entry.id === alice.id), true);
});

test('complete remote watchlist snapshots reconcile direct DeBot additions and removals', (t) => {
  const { store } = fixture(t);
  const local = store.addWatchAccounts(['alice'])[0];
  const command = store.claimCommands()[0];
  store.acknowledgeCommand(command.id, { success: true });

  const reconciled = store.reconcileRemoteWatchlist([
    { handle: 'bob', remoteId: 'debot-bob' }
  ]);
  const byHandle = new Map(reconciled.entries.map((entry) => [entry.handle, entry]));
  assert.equal(byHandle.get('alice').desiredState, 'removed');
  assert.equal(byHandle.get('alice').syncStatus, 'synced');
  assert.equal(byHandle.get('bob').desiredState, 'active');
  assert.equal(byHandle.get('bob').syncStatus, 'synced');
  assert.equal(local.entry.id > 0, true);
});

test('remote snapshots do not overwrite a newer pending local watchlist intent', (t) => {
  const { store } = fixture(t);
  const alice = store.addWatchAccounts(['alice'])[0];
  const addCommand = store.claimCommands()[0];
  store.acknowledgeCommand(addCommand.id, { success: true });
  store.removeWatchAccount(alice.entry.id);

  store.reconcileRemoteWatchlist(['alice']);
  const pendingRemoval = store.listWatchlist({ includeRemoved: true })[0];
  assert.equal(pendingRemoval.desiredState, 'removed');
  assert.equal(pendingRemoval.syncStatus, 'pending');

  const bob = store.addWatchAccounts(['bob'])[0];
  const bobCommand = store.claimCommands({ limit: 10 }).find((command) => command.watchlistId === bob.entry.id);
  store.acknowledgeCommand(bobCommand.id, { success: false, error: 'DeBot rejected add' });
  store.reconcileRemoteWatchlist([]);
  const failedAdd = store.listWatchlist({ includeRemoved: true }).find((entry) => entry.handle === 'bob');
  assert.equal(failedAdd.desiredState, 'active');
  assert.equal(failedAdd.syncStatus, 'failed');
});

test('retention removes only posts and terminal queue history older than the configured window', (t) => {
  const old = Date.parse('2026-07-01T00:00:00Z');
  const { store, setNow } = fixture(t, old);
  store.upsertPosts([{ source: 'twitter', id: 'old', text: 'old', createdAt: old }]);
  setNow(Date.parse('2026-07-17T00:00:00Z'));
  store.upsertPosts([{ source: 'twitter', id: 'new', text: 'new', createdAt: Date.parse('2026-07-17T00:00:00Z') }]);
  const result = store.cleanup({ retentionDays: 7 });
  assert.equal(result.postsDeleted, 1);
  assert.deepEqual(store.listPosts().map((post) => post.externalId), ['new']);
});
