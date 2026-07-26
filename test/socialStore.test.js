import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { DatabaseSync } from 'node:sqlite';

import { createSocialConfig } from '../src/social/config.js';
import {
  normalizeFeedSources,
  normalizeSocialPost,
  parseSocialActivityIdentity
} from '../src/social/normalize.js';
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
  assert.equal(createSocialConfig({}).debotJobLeaseMs, 120_000);
  const config = createSocialConfig({
    SOCIAL_DATA_FILE: '/tmp/independent-social.sqlite',
    SOCIAL_BRIDGE_TOKEN: ' device-secret ',
    SOCIAL_RETENTION_DAYS: '14',
    SOCIAL_BRIDGE_OFFLINE_MS: '25000',
    SOCIAL_COMMAND_LEASE_MS: '45000',
    SOCIAL_DEBOT_JOB_LEASE_MS: '95000',
    SOCIAL_DEBOT_REQUEST_TIMEOUT_MS: '35000',
    SOCIAL_DEBOT_TOKEN_CACHE_TTL_MS: '65000',
    SOCIAL_DEBOT_WALLET_CACHE_TTL_MS: '32000',
    SOCIAL_DEBOT_PENDING_CAP: '300'
  });
  assert.equal(config.dataFile, '/tmp/independent-social.sqlite');
  assert.equal(config.bridgeToken, 'device-secret');
  assert.equal(config.retentionDays, 14);
  assert.equal(config.bridgeOfflineMs, 25_000);
  assert.equal(config.commandLeaseMs, 45_000);
  assert.equal(config.debotJobLeaseMs, 95_000);
  assert.equal(config.debotRequestTimeoutMs, 35_000);
  assert.equal(config.debotTokenCacheTtlMs, 65_000);
  assert.equal(config.debotWalletCacheTtlMs, 32_000);
  assert.equal(config.debotPendingCap, 300);
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

test('follow and unfollow activity IDs normalize without splitting underscored handles', () => {
  const encodedUnfollow = Buffer.from('unfollow:star_okx:bankrbot').toString('base64url');
  assert.deepEqual(parseSocialActivityIdentity(encodedUnfollow, '@Star_OKX'), {
    kind: 'unfollow',
    actorHandle: 'star_okx',
    targetHandle: 'bankrbot',
    canonicalId: 'unfollow:star_okx:bankrbot'
  });

  const unfollow = normalizeSocialPost({
    source: 'twitter',
    id: encodedUnfollow,
    authorHandle: 'Star_OKX'
  });
  assert.equal(unfollow.externalId, 'unfollow:star_okx:bankrbot');
  assert.equal(unfollow.kind, 'unfollow');
  assert.equal(unfollow.target.handle, 'bankrbot');
  assert.equal(unfollow.target.name, '');

  const plainFollow = normalizeSocialPost({
    source: 'twitter',
    id: 'follow_crypto_cat888_robinhood_cn',
    authorHandle: 'crypto_cat888'
  });
  assert.equal(plainFollow.externalId, 'follow:crypto_cat888:robinhood_cn');
  assert.equal(plainFollow.kind, 'follow');
  assert.equal(plainFollow.target.handle, 'robinhood_cn');

  const explicitRelationship = normalizeSocialPost({
    source: 'twitter',
    id: 'opaque-relationship-id',
    kind: 'follow',
    author: { handle: 'alice', followers: 123 },
    target: { handle: 'bob' }
  });
  assert.equal(explicitRelationship.externalId, 'follow:alice:bob');
  assert.equal(explicitRelationship.authorFollowers, 123);
  assert.throws(() => normalizeSocialPost({
    source: 'twitter',
    id: 'missing-actor',
    kind: 'follow',
    target: { handle: 'bob' }
  }), /requires valid actor and target/);
  assert.throws(() => normalizeSocialPost({
    source: 'twitter',
    id: 'missing-target',
    kind: 'unfollow',
    author: { handle: 'alice' }
  }), /requires valid actor and target/);
});

test('activity inference rejects a Base64URL ID whose actor differs from the author', () => {
  const mismatched = Buffer.from('follow:alice:bob').toString('base64url');
  assert.equal(parseSocialActivityIdentity(mismatched, 'charlie'), null);

  assert.throws(() => normalizeSocialPost({
    source: 'twitter',
    id: mismatched,
    authorHandle: 'charlie',
    kind: 'follow',
    target: { handle: 'bob' }
  }), /identity conflicts/);

  const targetMismatch = Buffer.from('follow:alice:bob').toString('base64url');
  assert.throws(() => normalizeSocialPost({
    source: 'twitter',
    id: targetMismatch,
    authorHandle: 'alice',
    kind: 'follow',
    target: { handle: 'charlie' }
  }), /target conflicts/);
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

test('relationship targets survive database reopen with complete metadata', (t) => {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'robinhood-social-target-persistence-'));
  const filename = path.join(directory, 'social.sqlite');
  t.after(() => fs.rmSync(directory, { recursive: true, force: true }));

  const encoded = Buffer.from('unfollow:star_okx:bankrbot').toString('base64url');
  let store = createSocialStore(filename);
  const created = store.upsertPosts([{
    source: 'twitter',
    id: encoded,
    author: {
      id: 'actor-1',
      handle: 'star_okx',
      name: 'Star_OKX',
      avatarUrl: 'https://cdn.example.test/star.png',
      followersCount: 234_880
    },
    target: {
      id: 'target-1',
      handle: 'bankrbot',
      name: 'Bankr',
      avatarUrl: 'https://cdn.example.test/bankr.png',
      followersCount: 98_765,
      url: 'https://x.com/bankrbot'
    },
    publishedAt: '2026-07-17T11:59:00Z'
  }])[0].post;
  assert.equal(created.externalId, 'unfollow:star_okx:bankrbot');
  assert.equal(created.kind, 'unfollow');
  const sparseUpdate = store.upsertPosts([{
    source: 'twitter',
    id: 'unfollow:star_okx:bankrbot',
    author: {
      id: '',
      handle: 'star_okx',
      name: '',
      avatarUrl: '',
      followersCount: 0
    },
    target: { handle: 'bankrbot' },
    sourceUpdatedAt: '2026-07-17T11:59:00Z'
  }])[0].post;
  assert.equal(sparseUpdate.target.name, 'Bankr');
  assert.equal(sparseUpdate.target.avatarUrl, 'https://cdn.example.test/bankr.png');
  assert.equal(sparseUpdate.target.followers, 98_765);
  assert.deepEqual(sparseUpdate.author, {
    id: 'actor-1',
    handle: 'star_okx',
    name: 'Star_OKX',
    avatarUrl: 'https://cdn.example.test/star.png',
    followers: 234_880
  });
  store.close();

  store = createSocialStore(filename);
  const reopened = store.getPost('twitter', 'unfollow:star_okx:bankrbot');
  assert.deepEqual(reopened.target, {
    id: 'target-1',
    handle: 'bankrbot',
    name: 'Bankr',
    avatarUrl: 'https://cdn.example.test/bankr.png',
    followers: 98_765,
    url: 'https://x.com/bankrbot'
  });
  assert.equal(reopened.author.name, 'Star_OKX');
  assert.equal(reopened.author.avatarUrl, 'https://cdn.example.test/star.png');
  assert.equal(reopened.author.followers, 234_880);
  assert.deepEqual(store.listPosts({ query: 'bankrbot' }).map((post) => post.id), [reopened.id]);
  store.close();
});

test('legacy plain and Base64URL relationship rows migrate to one canonical record', (t) => {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'robinhood-social-activity-migration-'));
  const filename = path.join(directory, 'social.sqlite');
  t.after(() => fs.rmSync(directory, { recursive: true, force: true }));

  let store = createSocialStore(filename);
  store.close();

  const legacy = new DatabaseSync(filename);
  const insert = legacy.prepare(`
    INSERT INTO social_posts(
      source, external_id, kind, author_id, author_handle, author_name, author_avatar_url,
      author_followers, content, feed_sources_json, target_json,
      published_at, received_at, source_updated_at, raw_json, stored_at, updated_at
    ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
  `);
  const encoded = Buffer.from('unfollow:crypto_cat888:robinhood_cn').toString('base64url');
  insert.run(
    'twitter',
    encoded,
    'post',
    'actor-1',
    'crypto_cat888',
    'Crypto Cat',
    'https://cdn.example.test/crypto-cat.png',
    12_345,
    'older encoded activity',
    '["all"]',
    '{}',
    100,
    110,
    120,
    '{}',
    130,
    140
  );
  insert.run(
    'twitter',
    'unfollow_crypto_cat888_robinhood_cn',
    'post',
    '',
    'crypto_cat888',
    '',
    '',
    0,
    'newer plain activity',
    '["featured","my"]',
    '{"id":"target-2","handle":"robinhood_cn","name":"Robinhood CN","avatarUrl":"","followers":321,"url":"https://x.com/robinhood_cn"}',
    100,
    110,
    120,
    '{}',
    230,
    240
  );
  legacy.close();

  store = createSocialStore(filename);
  const posts = store.listPosts({ includeDeleted: true });
  assert.equal(posts.length, 1);
  assert.equal(posts[0].externalId, 'unfollow:crypto_cat888:robinhood_cn');
  assert.equal(posts[0].kind, 'unfollow');
  assert.equal(posts[0].content, 'newer plain activity');
  assert.deepEqual(posts[0].author, {
    id: 'actor-1',
    handle: 'crypto_cat888',
    name: 'Crypto Cat',
    avatarUrl: 'https://cdn.example.test/crypto-cat.png',
    followers: 12_345
  });
  assert.deepEqual(posts[0].feedSources, ['all', 'featured', 'my']);
  assert.deepEqual(posts[0].target, {
    id: 'target-2',
    handle: 'robinhood_cn',
    name: 'Robinhood CN',
    avatarUrl: '',
    followers: 321,
    url: 'https://x.com/robinhood_cn'
  });
  assert.equal(
    store.db.prepare('SELECT COUNT(*) AS count FROM social_posts').get().count,
    1
  );
  store.close();

  store = createSocialStore(filename);
  assert.equal(store.getCounts().posts, 1);
  assert.equal(store.listPosts()[0].author.name, 'Crypto Cat');
  assert.equal(store.listPosts()[0].author.followers, 12_345);
  store.close();
});

test('legacy relationship migration preserves distinct source occurrences and is idempotent', (t) => {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'robinhood-social-activity-occurrences-'));
  const filename = path.join(directory, 'social.sqlite');
  t.after(() => fs.rmSync(directory, { recursive: true, force: true }));

  let store = createSocialStore(filename);
  store.close();
  const legacy = new DatabaseSync(filename);
  const insert = legacy.prepare(`
    INSERT INTO social_posts(
      source, external_id, kind, author_handle, feed_sources_json, target_json,
      published_at, received_at, source_updated_at, raw_json, stored_at, updated_at
    ) VALUES (?, ?, 'post', ?, ?, '{}', ?, ?, ?, '{}', ?, ?)
  `);
  const encoded = Buffer.from('unfollow:connectfarm1:fartcoinofsol').toString('base64url');
  const firstOccurrence = Date.parse('2026-07-24T06:57:57.016Z');
  const secondOccurrence = Date.parse('2026-07-26T05:32:48.182Z');
  insert.run(
    'twitter',
    'unfollow_connectfarm1_fartcoinofsol',
    'connectfarm1',
    '["my"]',
    firstOccurrence - 16,
    firstOccurrence,
    firstOccurrence,
    firstOccurrence,
    firstOccurrence
  );
  insert.run(
    'twitter',
    encoded,
    'connectfarm1',
    '["all"]',
    secondOccurrence - 182,
    secondOccurrence,
    secondOccurrence,
    secondOccurrence,
    secondOccurrence
  );
  legacy.close();

  store = createSocialStore(filename);
  const expectedIds = [
    'unfollow:connectfarm1:fartcoinofsol',
    `unfollow:connectfarm1:fartcoinofsol:${secondOccurrence}`
  ];
  assert.deepEqual(store.listPosts().map((post) => post.externalId).sort(), expectedIds.sort());
  store.close();

  store = createSocialStore(filename);
  assert.deepEqual(store.listPosts().map((post) => post.externalId).sort(), expectedIds.sort());
  assert.equal(store.getCounts().posts, 2);
  store.close();
});

test('legacy profile changes migrate without becoming posts or collapsing later updates', (t) => {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'robinhood-social-profile-migration-'));
  const filename = path.join(directory, 'social.sqlite');
  t.after(() => fs.rmSync(directory, { recursive: true, force: true }));

  let store = createSocialStore(filename);
  store.close();
  const legacy = new DatabaseSync(filename);
  const insert = legacy.prepare(`
    INSERT INTO social_posts(
      source, external_id, kind, author_id, author_handle, author_name, author_avatar_url,
      author_followers, feed_sources_json, target_json,
      published_at, received_at, source_updated_at, raw_json, stored_at, updated_at
    ) VALUES ('twitter', ?, 'post', ?, ?, ?, ?, ?, ?, '{}', ?, ?, ?, '{}', ?, ?)
  `);
  const cryptoAt = Date.parse('2026-07-22T03:54:13.548Z');
  const encodedCrypto = Buffer.from(
    '@Crypto_Cat888_https://pbs.twimg.com/profile_images/old_https://pbs.twimg.com/profile_images/new_LazyCat'
  ).toString('base64url');
  insert.run(
    'profile_crypto_cat888_LazyCat_profile_payload',
    'actor-profile-1',
    'crypto_cat888',
    'Crypto Cat',
    'https://cdn.example.test/crypto-profile.png',
    54_321,
    '["my"]',
    cryptoAt,
    cryptoAt,
    cryptoAt,
    cryptoAt,
    cryptoAt
  );
  insert.run(encodedCrypto, '', 'Crypto_Cat888', '', '', 0, '["all","my"]', cryptoAt, cryptoAt, cryptoAt, cryptoAt, cryptoAt + 1);
  const vladFirstAt = Date.parse('2026-07-23T17:24:14.249Z');
  const vladSecondAt = Date.parse('2026-07-24T02:08:10.211Z');
  insert.run('profile_vladtenev_first_payload', '', 'vladtenev', '', '', 0, '["my"]', vladFirstAt, vladFirstAt, vladFirstAt, vladFirstAt, vladFirstAt);
  insert.run('profile_vladtenev_second_payload', '', 'vladtenev', '', '', 0, '["my"]', vladSecondAt, vladSecondAt, vladSecondAt, vladSecondAt, vladSecondAt);
  legacy.close();

  const expectedIds = [
    `profile:crypto_cat888:${cryptoAt}`,
    `profile:vladtenev:${vladFirstAt}`,
    `profile:vladtenev:${vladSecondAt}`
  ].sort();
  store = createSocialStore(filename);
  const migrated = store.listPosts();
  assert.deepEqual(migrated.map((post) => post.externalId).sort(), expectedIds);
  assert.equal(migrated.every((post) => post.kind === 'profile'), true);
  assert.deepEqual(
    migrated.find((post) => post.externalId === `profile:crypto_cat888:${cryptoAt}`).feedSources,
    ['all', 'my']
  );
  assert.deepEqual(
    migrated.find((post) => post.externalId === `profile:crypto_cat888:${cryptoAt}`).author,
    {
      id: 'actor-profile-1',
      handle: 'Crypto_Cat888',
      name: 'Crypto Cat',
      avatarUrl: 'https://cdn.example.test/crypto-profile.png',
      followers: 54_321
    }
  );
  store.close();

  store = createSocialStore(filename);
  assert.deepEqual(store.listPosts().map((post) => post.externalId).sort(), expectedIds);
  assert.equal(store.getCounts().posts, 3);
  assert.equal(
    store.getPost('twitter', `profile:crypto_cat888:${cryptoAt}`).author.name,
    'Crypto Cat'
  );
  store.close();
});

test('repeated relationship actions remain separate while source-identical aliases deduplicate', (t) => {
  const { store, setNow } = fixture(t);
  const firstOccurrence = Date.parse('2026-07-21T06:50:59Z');
  const secondOccurrence = Date.parse('2026-07-22T03:17:00Z');
  const encoded = Buffer.from('unfollow:crypto_cat888:rh67car').toString('base64url');

  store.upsertPosts([{
    source: 'twitter',
    id: 'unfollow_crypto_cat888_rh67car',
    authorHandle: 'crypto_cat888',
    publishedAt: firstOccurrence,
    sourceUpdatedAt: firstOccurrence,
    feedSource: 'my'
  }]);
  store.upsertPosts([{
    source: 'twitter',
    id: encoded,
    authorHandle: 'crypto_cat888',
    publishedAt: firstOccurrence + 52_000,
    sourceUpdatedAt: firstOccurrence,
    feedSource: 'all'
  }]);
  assert.equal(store.getCounts().posts, 1);
  assert.deepEqual(store.listPosts()[0].feedSources, ['all', 'my']);

  store.upsertPosts([{
    source: 'twitter',
    id: encoded,
    authorHandle: 'crypto_cat888',
    publishedAt: secondOccurrence,
    sourceUpdatedAt: secondOccurrence,
    feedSource: 'my'
  }]);
  const posts = store.listPosts();
  assert.equal(posts.length, 2);
  assert.equal(posts.some((post) => post.externalId === 'unfollow:crypto_cat888:rh67car'), true);
  assert.equal(posts.some((post) => post.externalId === `unfollow:crypto_cat888:rh67car:${secondOccurrence}`), true);

  setNow(secondOccurrence + 1_000);
  const deletedFirst = store.deletePost('twitter', 'unfollow:crypto_cat888:rh67car');
  assert.equal(deletedFirst.action, 'deleted');
  assert.equal(deletedFirst.post.externalId, 'unfollow:crypto_cat888:rh67car');
  assert.equal(store.getCounts().posts, 2);
  assert.equal(store.getPost('twitter', `unfollow:crypto_cat888:rh67car:${secondOccurrence}`).deleted, false);

  setNow(secondOccurrence + 2_000);
  const deletedSecond = store.deletePost(
    'twitter',
    `unfollow:crypto_cat888:rh67car:${secondOccurrence}`
  );
  assert.equal(deletedSecond.action, 'deleted');
  assert.equal(deletedSecond.post.externalId, `unfollow:crypto_cat888:rh67car:${secondOccurrence}`);
  assert.equal(store.getCounts().posts, 2);
  assert.equal(store.getCounts().deletedPosts, 2);
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

test('DeBot jobs dedupe inflight work, rotate expired leases and cache successful results', (t) => {
  const initialNow = Date.parse('2026-07-17T12:00:00Z');
  const { store, setNow } = fixture(t, initialNow);
  const input = {
    requestKey: 'token-detail-key',
    type: 'debot.token_detail.v1',
    payload: {
      chain: 'robinhood',
      token: '0x1111111111111111111111111111111111111111'
    },
    deadlineAt: initialNow + 180_000,
    cacheTtlMs: 60_000,
    pendingCap: 256
  };
  const created = store.enqueueDeBotJob(input);
  assert.equal(created.state, 'created');
  assert.equal(store.enqueueDeBotJob(input).state, 'inflight');

  const firstClaim = store.claimDeBotJobs({
    limit: 4,
    leaseMs: 90_000,
    createClaimToken: () => 'first-claim-token'
  });
  assert.equal(firstClaim.length, 1);
  assert.equal(firstClaim[0].claimToken, 'first-claim-token');
  assert.deepEqual(store.claimDeBotJobs({
    createClaimToken: () => 'unused-claim-token'
  }), []);
  assert.equal(store.acknowledgeDeBotJob(firstClaim[0].id, {
    claimToken: 'wrong-token',
    success: true,
    result: { data: {} }
  }).state, 'claim_mismatch');

  setNow(initialNow + 91_000);
  const reclaimed = store.claimDeBotJobs({
    leaseMs: 90_000,
    createClaimToken: () => 'second-claim-token'
  });
  assert.equal(reclaimed.length, 1);
  assert.equal(reclaimed[0].attempts, 2);
  assert.equal(reclaimed[0].claimToken, 'second-claim-token');
  assert.equal(store.acknowledgeDeBotJob(reclaimed[0].id, {
    claimToken: reclaimed[0].claimToken,
    success: true,
    result: { schema: 'debot.token_detail.raw.v1', data: { token: { symbol: 'TEST' } } }
  }).state, 'completed');
  assert.equal(store.getCachedDeBotResult(input.requestKey).result.data.token.symbol, 'TEST');

  setNow(initialNow + 152_000);
  assert.equal(store.getCachedDeBotResult(input.requestKey), null);
});

test('DeBot jobs enforce the independent pending cap and remove old terminal records', (t) => {
  const initialNow = Date.parse('2026-07-17T12:00:00Z');
  const { store, setNow } = fixture(t, initialNow);
  const enqueue = (requestKey, token) => store.enqueueDeBotJob({
    requestKey,
    type: 'debot.token_detail.v1',
    payload: { chain: 'robinhood', token },
    deadlineAt: initialNow + 30_000,
    cacheTtlMs: 0,
    pendingCap: 1
  });
  assert.equal(enqueue('first', '0x1111111111111111111111111111111111111111').state, 'created');
  assert.equal(enqueue('second', '0x2222222222222222222222222222222222222222').state, 'full');

  setNow(initialNow + 31_000);
  assert.deepEqual(store.claimDeBotJobs({
    createClaimToken: () => 'unused-expired-token'
  }), []);
  setNow(initialNow + 120_000);
  const cleanup = store.cleanup({ retentionDays: 7, debotTerminalRetentionMs: 60_000 });
  assert.equal(cleanup.debotJobsDeleted, 1);
  assert.equal(store.db.prepare('SELECT COUNT(*) AS count FROM debot_bridge_jobs').get().count, 0);
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
