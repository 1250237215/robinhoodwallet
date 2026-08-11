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
  normalizeWatchEventTypes,
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
    SOCIAL_DEBOT_PENDING_CAP: '300',
    SOCIAL_X_FAST_HANDLES: '@radar_fixture, Fixture_Cat invalid-handle!',
    SOCIAL_X_FAST_POLL_INTERVAL_MS: '100',
    SOCIAL_X_FAST_MAX_IN_FLIGHT: '99',
    SOCIAL_X_FAST_REQUEST_TIMEOUT_MS: '4200',
    SOCIAL_X_REPLY_ENRICHMENT: 'off'
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
  assert.deepEqual(config.xFastHandles, ['radar_fixture', 'fixture_cat']);
  assert.equal(config.xFastPollIntervalMs, 250);
  assert.equal(config.xFastMaxInFlight, 3);
  assert.equal(config.xFastRequestTimeoutMs, 4_200);
  assert.equal(config.xReplyEnrichmentEnabled, false);
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

test('post kinds normalize known aliases and reject explicitly unknown values', () => {
  for (const [kind, expected] of [
    ['tweet', 'post'],
    ['retweet', 'repost'],
    ['quote_tweet', 'quote'],
    ['delTweet', 'delete']
  ]) {
    assert.equal(normalizeSocialPost({ source: 'x', id: `kind-${kind}`, kind }).kind, expected);
  }
  assert.equal(normalizeSocialPost({ source: 'x', id: 'kind-default' }).kind, 'post');
  assert.throws(
    () => normalizeSocialPost({ source: 'x', id: 'kind-unknown', kind: 'list_update' }),
    /Unsupported social post kind/
  );
  assert.throws(
    () => normalizeSocialPost({ source: 'x', id: 'kind-empty', kind: '' }),
    /Unsupported social post kind/
  );
});

test('translation backfill includes watched deleted posts', (t) => {
  const { store } = fixture(t);
  store.addWatchAccounts([{ platform: 'twitter', handle: 'deleted_fixture' }]);
  store.upsertPosts([{
    source: 'twitter',
    externalId: 'tweet_delete:2081700497174734777',
    kind: 'delete',
    author: { handle: 'deleted_fixture' },
    content: 'this deleted post still needs translation',
    deleted: true,
    deletedAt: Date.parse('2026-07-17T12:01:00Z'),
    publishedAt: Date.parse('2026-07-17T12:00:00Z')
  }]);

  assert.deepEqual(
    store.listPostsForTranslation().map((post) => post.externalId),
    ['tweet_delete:2081700497174734777']
  );
});

test('follow and unfollow activity IDs normalize without splitting underscored handles', () => {
  const encodedUnfollow = Buffer.from('unfollow:fixture_star:bankrbot').toString('base64url');
  assert.deepEqual(parseSocialActivityIdentity(encodedUnfollow, '@Fixture_Star'), {
    kind: 'unfollow',
    actorHandle: 'fixture_star',
    targetHandle: 'bankrbot',
    canonicalId: 'unfollow:fixture_star:bankrbot',
    occurrenceAt: null,
    occurrenceId: 'unfollow:fixture_star:bankrbot'
  });

  const unfollow = normalizeSocialPost({
    source: 'twitter',
    id: encodedUnfollow,
    authorHandle: 'Fixture_Star'
  });
  assert.equal(unfollow.externalId, 'unfollow:fixture_star:bankrbot');
  assert.equal(unfollow.kind, 'unfollow');
  assert.equal(unfollow.target.handle, 'bankrbot');
  assert.equal(unfollow.target.name, '');

  const plainFollow = normalizeSocialPost({
    source: 'twitter',
    id: 'follow_fixture_cat_robinhood_cn',
    authorHandle: 'fixture_cat'
  });
  assert.equal(plainFollow.externalId, 'follow:fixture_cat:robinhood_cn');
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
  }), /valid actor and target handles/);
  assert.throws(() => normalizeSocialPost({
    source: 'twitter',
    id: 'missing-target',
    kind: 'unfollow',
    author: { handle: 'alice' }
  }), /valid actor and target handles/);
});

test('activity inference rejects conflicting relationship identities', () => {
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

test('repeated relationship occurrences keep exact identities across database reopen', (t) => {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'robinhood-social-relationship-occurrences-'));
  const filename = path.join(directory, 'social.sqlite');
  t.after(() => fs.rmSync(directory, { recursive: true, force: true }));
  const firstAt = Date.parse('2026-07-17T12:00:00.000Z');
  const secondAt = Date.parse('2026-07-18T12:00:00.123Z');

  let store = createSocialStore(filename);
  const first = store.upsertPosts([{
    source: 'twitter',
    id: 'first-follow-observation',
    kind: 'follow',
    authorHandle: 'alice',
    targetHandle: 'bob',
    publishedAt: firstAt,
    sourceUpdatedAt: firstAt
  }])[0];
  const second = store.upsertPosts([{
    source: 'twitter',
    id: 'second-follow-observation',
    kind: 'follow',
    authorHandle: 'alice',
    targetHandle: 'bob',
    publishedAt: secondAt,
    sourceUpdatedAt: secondAt
  }])[0];
  assert.equal(first.post.externalId, 'follow:alice:bob');
  assert.equal(second.post.externalId, `follow:alice:bob:${secondAt}`);

  const repeated = store.upsertPosts([{
    source: 'twitter',
    id: `follow:alice:bob:${secondAt}`,
    authorHandle: 'alice',
    targetHandle: 'bob',
    publishedAt: secondAt,
    sourceUpdatedAt: secondAt
  }])[0];
  assert.equal(repeated.action, 'unchanged');
  assert.equal(store.listPosts().length, 2);
  assert.deepEqual(
    store.listPosts().map((post) => post.externalId).sort(),
    ['follow:alice:bob', `follow:alice:bob:${secondAt}`].sort()
  );
  store.close();

  store = createSocialStore(filename);
  assert.deepEqual(
    store.listPosts().map((post) => post.externalId).sort(),
    ['follow:alice:bob', `follow:alice:bob:${secondAt}`].sort()
  );
  store.close();
});

test('social posts are normalized, deduplicated, updated and tombstoned in place', (t) => {
  const { store, setNow } = fixture(t);
  const discoveredAt = Date.parse('2026-07-17T11:59:30.123Z');
  const ingestedAt = Date.parse('2026-07-17T12:00:00Z');
  const created = store.upsertPosts([{
    source: 'x',
    tweetId: 'tweet-42',
    author: { id: 'user-1', username: 'alice', name: 'Alice', followersCount: 12_345 },
    text: 'New CA 0x1111111111111111111111111111111111111111',
    createdAt: '2026-07-17T11:59:00Z',
    debotDiscoveredAt: discoveredAt,
    url: 'https://x.com/alice/status/tweet-42'
  }])[0];
  assert.equal(created.action, 'created');
  assert.equal(created.post.source, 'twitter');
  assert.equal(created.post.author.handle, 'alice');
  assert.equal(created.post.contractAddresses[0].address, '0x1111111111111111111111111111111111111111');
  assert.equal(created.post.debotDiscoveredAt, discoveredAt);
  assert.equal(created.post.discoveredAt, discoveredAt);
  assert.equal(created.post.receivedAt, discoveredAt);
  assert.equal(created.post.vpsIngestedAt, ingestedAt);
  assert.equal(created.post.ingestedAt, ingestedAt);
  assert.equal(created.post.storedAt, ingestedAt);

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

test('social read APIs hide legacy Chinese-majority translations without changing stored data', (t) => {
  const { store } = fixture(t);
  const chineseLegacy = {
    source: 'twitter',
    id: 'legacy-chinese-majority',
    authorHandle: 'alice',
    text: '主要内容已经是中文，只夹一个 bullish',
    translatedText: '这是一条不应继续展示的历史翻译',
    replyContext: {
      externalId: '2081696375595524505',
      content: '回复原文主要也是中文 alpha',
      translatedContent: '这条回复翻译也不应展示'
    },
    quoteContext: {
      externalId: '2081481106281390183',
      content: '引用原文主要仍然是中文 beta',
      translatedContent: '这条引用翻译也不应展示'
    }
  };
  const foreignLegacy = {
    source: 'twitter',
    id: 'legacy-foreign-majority',
    authorHandle: 'bob',
    text: '你好 this sentence is mostly English',
    translatedText: '你好，这句话大部分是英文',
    replyContext: {
      externalId: '2081696375595524506',
      content: '回复 this reply is mostly English',
      translatedContent: '这条回复大部分是英文'
    },
    quoteContext: {
      externalId: '2081481106281390184',
      content: '引用 this quote is mostly English',
      translatedContent: '这条引用大部分是英文'
    }
  };

  const chineseResult = store.upsertPosts([chineseLegacy])[0];
  const foreignResult = store.upsertPosts([foreignLegacy])[0];
  const rawChineseChange = {
    ...chineseResult.post,
    content: chineseLegacy.text,
    translatedContent: chineseLegacy.translatedText,
    replyContext: chineseLegacy.replyContext,
    quoteContext: chineseLegacy.quoteContext
  };
  const rawForeignChange = {
    ...foreignResult.post,
    content: foreignLegacy.text,
    translatedContent: foreignLegacy.translatedText,
    replyContext: foreignLegacy.replyContext,
    quoteContext: foreignLegacy.quoteContext
  };
  store.db.prepare(`
    UPDATE social_changes SET payload_json = ?
    WHERE entity_type = 'post' AND entity_id = ?
  `).run(JSON.stringify(rawChineseChange), String(chineseResult.post.id));
  store.db.prepare(`
    UPDATE social_changes SET payload_json = ?
    WHERE entity_type = 'post' AND entity_id = ?
  `).run(JSON.stringify(rawForeignChange), String(foreignResult.post.id));

  const assertChineseTranslationsHidden = (post) => {
    assert.equal(post.translatedContent, '');
    assert.equal(post.replyContext.translatedContent, '');
    assert.equal(post.quoteContext.translatedContent, '');
  };
  const assertForeignTranslationsPreserved = (post) => {
    assert.equal(post.translatedContent, foreignLegacy.translatedText);
    assert.equal(post.replyContext.translatedContent, foreignLegacy.replyContext.translatedContent);
    assert.equal(post.quoteContext.translatedContent, foreignLegacy.quoteContext.translatedContent);
  };

  assertChineseTranslationsHidden(store.getPost('twitter', chineseLegacy.id));
  assertForeignTranslationsPreserved(store.getPost('twitter', foreignLegacy.id));

  const listedPosts = new Map(store.listPosts().map((post) => [post.externalId, post]));
  assertChineseTranslationsHidden(listedPosts.get(chineseLegacy.id));
  assertForeignTranslationsPreserved(listedPosts.get(foreignLegacy.id));

  const changes = new Map(store.listChanges().map((change) => [change.entityId, change.data]));
  assertChineseTranslationsHidden(changes.get(String(chineseResult.post.id)));
  assertForeignTranslationsPreserved(changes.get(String(foreignResult.post.id)));

  const storedChinese = store.db.prepare(`
    SELECT translated_content, reply_context_json, quote_context_json
    FROM social_posts WHERE id = ?
  `).get(chineseResult.post.id);
  assert.equal(storedChinese.translated_content, chineseLegacy.translatedText);
  assert.equal(JSON.parse(storedChinese.reply_context_json).translatedContent, chineseLegacy.replyContext.translatedContent);
  assert.equal(JSON.parse(storedChinese.quote_context_json).translatedContent, chineseLegacy.quoteContext.translatedContent);
});

test('older bridge retries cannot restore a newer deletion tombstone', (t) => {
  const { store } = fixture(t);
  const publishedAt = Date.parse('2026-07-17T11:59:00Z');
  const deletedAt = Date.parse('2026-07-17T12:02:00Z');
  const restoredAt = Date.parse('2026-07-17T12:03:00Z');
  store.upsertPosts([{
    source: 'twitter',
    id: 'deleted-retry',
    authorHandle: 'alice',
    text: 'original',
    publishedAt,
    sourceUpdatedAt: publishedAt,
    deleted: false,
    deletedAt: null
  }]);
  const deleted = store.upsertPosts([{
    source: 'twitter',
    id: 'deleted-retry',
    kind: 'delete',
    authorHandle: 'alice',
    publishedAt,
    sourceUpdatedAt: deletedAt,
    deleted: true,
    deletedAt
  }])[0];
  assert.equal(deleted.action, 'deleted');

  const staleRetry = store.upsertPosts([{
    source: 'twitter',
    id: 'deleted-retry',
    kind: 'post',
    authorHandle: 'alice',
    text: 'original',
    publishedAt,
    sourceUpdatedAt: publishedAt,
    deleted: false,
    deletedAt: null
  }])[0];
  assert.equal(staleRetry.action, 'unchanged');
  assert.equal(staleRetry.post.deleted, true);
  assert.equal(staleRetry.post.kind, 'delete');

  const restored = store.upsertPosts([{
    source: 'twitter',
    id: 'deleted-retry',
    kind: 'post',
    authorHandle: 'alice',
    text: 'restored',
    publishedAt,
    sourceUpdatedAt: restoredAt,
    deleted: false,
    deletedAt: null
  }])[0];
  assert.equal(restored.action, 'restored');
  assert.equal(restored.post.deleted, false);
});

test('sparse later observations cannot clear persisted post media', (t) => {
  const { store, setNow } = fixture(t);
  const publishedAt = Date.parse('2026-07-17T11:59:00Z');
  const expectedMedia = [
    { type: 'image', url: 'https://pbs.twimg.com/media/post-image.jpg', previewUrl: '' },
    { type: 'video', url: 'https://video.twimg.com/post-video.mp4', previewUrl: '' }
  ];
  const created = store.upsertPosts([{
    source: 'twitter',
    id: 'media-preserved',
    authorHandle: 'alice',
    text: 'post with media',
    media: expectedMedia,
    publishedAt,
    sourceUpdatedAt: publishedAt
  }])[0];
  assert.deepEqual(created.post.media, expectedMedia);

  setNow(Date.parse('2026-07-17T12:00:01Z'));
  const translated = store.upsertPosts([{
    source: 'twitter',
    id: 'media-preserved',
    translatedText: '后续翻译',
    media: [],
    publishedAt,
    sourceUpdatedAt: publishedAt
  }])[0];
  assert.equal(translated.action, 'updated');
  assert.equal(translated.post.translatedContent, '后续翻译');
  assert.deepEqual(translated.post.media, expectedMedia);

  setNow(Date.parse('2026-07-17T12:00:02Z'));
  const newerSparse = store.upsertPosts([{
    source: 'twitter',
    id: 'media-preserved',
    text: 'newer sparse observation',
    media: [],
    publishedAt,
    sourceUpdatedAt: publishedAt + 1_000
  }])[0];
  assert.equal(newerSparse.action, 'updated');
  assert.equal(newerSparse.post.content, 'newer sparse observation');
  assert.deepEqual(newerSparse.post.media, expectedMedia);
});

test('video enrichment replaces its matching preview-only media item', (t) => {
  const { store } = fixture(t);
  const sourceUpdatedAt = Date.parse('2026-07-17T12:00:00Z');
  const previewUrl = 'https://pbs.twimg.com/ext_tw_video_thumb/123/poster.jpg';
  const videoUrl = 'https://video.twimg.com/ext_tw_video/123/video.mp4';
  store.upsertPosts([{
    source: 'twitter',
    id: 'video-preview-enrichment',
    authorHandle: 'alice',
    media: [{ type: 'video', previewUrl }],
    sourceUpdatedAt
  }]);

  const enriched = store.upsertPosts([{
    source: 'twitter',
    id: 'video-preview-enrichment',
    media: [{ type: 'video', url: videoUrl, previewUrl }],
    sourceUpdatedAt
  }])[0];

  assert.equal(enriched.action, 'updated');
  assert.deepEqual(enriched.post.media, [{ type: 'video', url: videoUrl, previewUrl }]);
});

test('reply targets and parent post context persist and merge without clearing richer data', (t) => {
  const { store, setNow } = fixture(t);
  const replyId = '2081700497174733126';
  const parentId = '2081696375595524505';
  const created = store.upsertPosts([{
    source: 'twitter',
    id: replyId,
    kind: 'reply',
    authorHandle: 'Fixture_Cat',
    text: 'You use cat as pfp',
    replyToExternalId: 'iruletrenches',
    publishedAt: 1_785_151_049_000
  }])[0];
  assert.equal(created.post.target.handle, 'iruletrenches');
  assert.deepEqual(created.post.replyContext, {});

  setNow(1_785_151_051_000);
  const enriched = store.upsertPosts([{
    source: 'twitter',
    id: replyId,
    kind: 'reply',
    target: { handle: 'iruletrenches', name: 'Miyamoto' },
    replyToExternalId: parentId,
    replyContext: {
      externalId: parentId,
      author: { handle: 'iruletrenches', name: 'Miyamoto' },
      content: "It's a dogs world",
      translatedContent: '这是狗狗的世界',
      url: `https://x.com/iruletrenches/status/${parentId}`,
      media: [{ type: 'image', url: 'https://pbs.twimg.com/media/reply-parent.jpg' }],
      publishedAt: 1_785_150_066_000
    },
    sourceUpdatedAt: 1_785_151_049_000
  }])[0];
  assert.equal(enriched.action, 'updated');
  assert.equal(enriched.post.replyToExternalId, parentId);
  assert.equal(enriched.post.target.name, 'Miyamoto');
  assert.equal(enriched.post.replyContext.content, "It's a dogs world");
  assert.equal(enriched.post.replyContext.translatedContent, '这是狗狗的世界');
  assert.deepEqual(enriched.post.replyContext.media, [{
    type: 'image',
    url: 'https://pbs.twimg.com/media/reply-parent.jpg',
    previewUrl: ''
  }]);

  const partial = store.upsertPosts([{
    source: 'twitter',
    id: replyId,
    kind: 'reply',
    replyContext: { externalId: parentId, author: { handle: 'iruletrenches' }, media: [] },
    sourceUpdatedAt: 1_785_151_049_000
  }])[0];
  assert.equal(partial.action, 'unchanged');
  assert.equal(partial.post.replyContext.content, "It's a dogs world");
  assert.equal(partial.post.replyContext.translatedContent, '这是狗狗的世界');
  assert.deepEqual(partial.post.replyContext.media, [{
    type: 'image',
    url: 'https://pbs.twimg.com/media/reply-parent.jpg',
    previewUrl: ''
  }]);
});

test('reply context never mixes different parent tweets and stale enrichment still updates its sidecar', (t) => {
  const { store, setNow } = fixture(t);
  const replyId = '2081700497174733126';
  const firstParentId = '2081696375595524505';
  const correctedParentId = '2081697000000000000';
  store.upsertPosts([{
    source: 'twitter',
    id: replyId,
    kind: 'reply',
    authorHandle: 'Fixture_Cat',
    text: 'newest reply text',
    sourceUpdatedAt: 1_785_151_052_000,
    replyToExternalId: firstParentId,
    replyContext: {
      externalId: firstParentId,
      author: { handle: 'wrong_parent' },
      content: 'old parent content',
      translatedContent: '旧父帖',
      url: `https://x.com/wrong_parent/status/${firstParentId}`
    }
  }]);

  setNow(1_785_151_053_000);
  const corrected = store.upsertPosts([{
    source: 'twitter',
    id: replyId,
    kind: 'reply',
    target: { handle: 'real_parent', name: 'Real Parent' },
    replyToExternalId: correctedParentId,
    replyContext: {
      externalId: correctedParentId,
      author: { handle: 'real_parent' },
      content: 'correct parent content',
      url: `https://x.com/real_parent/status/${correctedParentId}`
    },
    sourceUpdatedAt: 1_785_151_050_000
  }])[0];

  assert.equal(corrected.action, 'updated');
  assert.equal(corrected.post.content, 'newest reply text');
  assert.equal(corrected.post.sourceUpdatedAt, 1_785_151_052_000);
  assert.equal(corrected.post.replyToExternalId, correctedParentId);
  assert.equal(corrected.post.replyContext.externalId, correctedParentId);
  assert.equal(corrected.post.replyContext.content, 'correct parent content');
  assert.equal(corrected.post.replyContext.translatedContent, '');
  assert.equal(corrected.post.replyContext.url, `https://x.com/real_parent/status/${correctedParentId}`);
  assert.equal(corrected.post.target.handle, 'real_parent');
});

test('quote context persists, merges partial observations and replaces conflicting quoted identities atomically', (t) => {
  const { store, setNow } = fixture(t);
  const quoteId = '2081749735858442749';
  const firstQuotedId = '2081481106281390183';
  const correctedQuotedId = '2081481106281390999';
  const created = store.upsertPosts([{
    source: 'twitter',
    id: quoteId,
    kind: 'quote',
    authorHandle: 'radar_fixture',
    text: '他天天',
    quoteContext: {
      externalId: firstQuotedId,
      author: { handle: 'theunipcs', name: 'Unipcs' },
      content: 'Original quote text',
      media: [{ type: 'image', url: 'https://pbs.twimg.com/media/quoted-post.jpg' }],
      url: `https://x.com/theunipcs/status/${firstQuotedId}`
    },
    publishedAt: 1_785_162_788_000,
    sourceUpdatedAt: 1_785_162_788_000
  }])[0];
  assert.equal(created.post.quotedExternalId, firstQuotedId);
  assert.equal(created.post.quoteContext.content, 'Original quote text');
  assert.deepEqual(created.post.quoteContext.media, [{
    type: 'image',
    url: 'https://pbs.twimg.com/media/quoted-post.jpg',
    previewUrl: ''
  }]);

  setNow(1_785_162_789_000);
  const translated = store.upsertPosts([{
    source: 'twitter',
    id: quoteId,
    kind: 'quote',
    quoteContext: {
      url: `https://x.com/theunipcs/status/${firstQuotedId}`,
      translatedContent: '被引用原文翻译',
      media: []
    },
    sourceUpdatedAt: 1_785_162_788_000
  }])[0];
  assert.equal(translated.post.quoteContext.content, 'Original quote text');
  assert.equal(translated.post.quoteContext.translatedContent, '被引用原文翻译');
  assert.deepEqual(translated.post.quoteContext.media, [{
    type: 'image',
    url: 'https://pbs.twimg.com/media/quoted-post.jpg',
    previewUrl: ''
  }]);

  setNow(1_785_162_790_000);
  const corrected = store.upsertPosts([{
    source: 'twitter',
    id: quoteId,
    kind: 'quote',
    quoteContext: {
      externalId: correctedQuotedId,
      author: { handle: 'correct_source' },
      content: 'Correct quoted post',
      url: `https://x.com/correct_source/status/${correctedQuotedId}`
    },
    sourceUpdatedAt: 1_785_162_787_000
  }])[0];
  assert.equal(corrected.action, 'updated');
  assert.equal(corrected.post.content, '他天天');
  assert.equal(corrected.post.quotedExternalId, correctedQuotedId);
  assert.equal(corrected.post.quoteContext.externalId, correctedQuotedId);
  assert.equal(corrected.post.quoteContext.content, 'Correct quoted post');
  assert.equal(corrected.post.quoteContext.translatedContent, '');
  assert.equal(corrected.post.quoteContext.author.handle, 'correct_source');
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
  legacy.exec('ALTER TABLE social_posts DROP COLUMN reply_context_json');
  legacy.exec('ALTER TABLE social_posts DROP COLUMN discovered_at');
  legacy.exec('ALTER TABLE social_posts DROP COLUMN ingested_at');
  legacy.close();

  store = createSocialStore(filename);
  const migrated = store.getPost('twitter', 'persisted-feed');
  assert.deepEqual(migrated.feedSources, ['all']);
  assert.equal(migrated.debotDiscoveredAt, migrated.receivedAt);
  assert.equal(migrated.vpsIngestedAt, migrated.storedAt);
  const column = store.db.prepare('PRAGMA table_info(social_posts)').all()
    .find((item) => item.name === 'feed_sources_json');
  assert.equal(Boolean(column), true);
  const replyContextColumn = store.db.prepare('PRAGMA table_info(social_posts)').all()
    .find((item) => item.name === 'reply_context_json');
  assert.equal(Boolean(replyContextColumn), true);
  const timestampColumns = store.db.prepare('PRAGMA table_info(social_posts)').all()
    .filter((item) => ['discovered_at', 'ingested_at'].includes(item.name));
  assert.equal(timestampColumns.length, 2);
  store.close();
});

test('ingestion stores validated relationship and profile activity with exact profile details', (t) => {
  const { store } = fixture(t);
  const encoded = Buffer.from('unfollow:fixture_star:bankrbot').toString('base64url');
  const results = store.upsertPosts([
    {
      source: 'twitter',
      id: encoded,
      authorHandle: 'fixture_star',
      targetHandle: 'bankrbot'
    },
    {
      source: 'twitter',
      id: 'rename-event',
      kind: 'reName',
      authorHandle: 'fixture_star',
      oldName: 'Star',
      newName: 'Fixture_Star'
    },
    {
      source: 'twitter',
      id: 'avatar-event',
      type: 'reImage',
      authorHandle: 'fixture_star',
      oldAvatarUrl: 'https://pbs.twimg.com/profile_images/old.jpg',
      newAvatarUrl: 'https://pbs.twimg.com/profile_images/new.jpg'
    },
    {
      source: 'twitter',
      id: 'profile:fixture_star:1785048000000',
      kind: 'profile',
      authorHandle: 'fixture_star',
      profileChanges: ['bio'],
      profileDetail: { bio: { before: 'old bio', after: 'new bio' } }
    },
    {
      source: 'twitter',
      id: 'tweet-allowed',
      kind: 'post',
      authorHandle: 'fixture_star',
      text: 'A real tweet'
    }
  ]);

  assert.deepEqual(results.map((result) => result.action), Array(results.length).fill('created'));
  assert.equal(results[0].post.kind, 'unfollow');
  assert.equal(results[0].post.target.handle, 'bankrbot');
  assert.deepEqual(results[1].post.profileChanges, ['name']);
  assert.deepEqual(results[1].post.profileDetail.name, { before: 'Star', after: 'Fixture_Star' });
  assert.deepEqual(results[2].post.profileChanges, ['avatar']);
  assert.deepEqual(results[2].post.profileDetail.avatar, {
    before: 'https://pbs.twimg.com/profile_images/old.jpg',
    after: 'https://pbs.twimg.com/profile_images/new.jpg'
  });
  assert.deepEqual(results[3].post.profileChanges, ['bio']);
  assert.deepEqual(results[3].post.profileDetail.bio, { before: 'old bio', after: 'new bio' });
  assert.throws(() => store.upsertPosts([{
    source: 'twitter',
    id: 'profile-without-change',
    kind: 'profile',
    authorHandle: 'fixture_star'
  }]), /at least one verified profile change/);
  assert.equal(store.listPosts().length, 5);
  assert.deepEqual(store.listChanges().map((change) => change.type), Array(5).fill('post.created'));
});

test('partial duplicates preserve every verified change from one profile occurrence', (t) => {
  const { store } = fixture(t);
  const occurrenceAt = Date.parse('2026-07-25T12:00:00Z');
  const externalId = `profile:fixture_star:${occurrenceAt}`;
  store.upsertPosts([{
    source: 'twitter',
    id: externalId,
    kind: 'profile',
    authorHandle: 'fixture_star',
    profileChanges: ['name'],
    profileDetail: { name: { before: 'Star', after: 'Star OKX' } },
    sourceUpdatedAt: occurrenceAt
  }]);
  const expanded = store.upsertPosts([{
    source: 'twitter',
    id: externalId,
    kind: 'profile',
    authorHandle: 'fixture_star',
    profileChanges: ['avatar', 'bio'],
    profileDetail: {
      avatar: { before: 'https://example.test/old.png', after: 'https://example.test/new.png' },
      bio: { before: 'old bio', after: 'new bio' }
    },
    sourceUpdatedAt: occurrenceAt
  }])[0];
  assert.deepEqual(expanded.post.profileChanges, ['name', 'avatar', 'bio']);

  const partialRetry = store.upsertPosts([{
    source: 'twitter',
    id: externalId,
    kind: 'profile',
    authorHandle: 'fixture_star',
    profileChanges: ['name'],
    profileDetail: { name: { before: 'Star', after: 'Star OKX' } },
    sourceUpdatedAt: occurrenceAt
  }])[0];
  assert.equal(partialRetry.action, 'unchanged');
  assert.deepEqual(partialRetry.post.profileChanges, ['name', 'avatar', 'bio']);
  assert.deepEqual(partialRetry.post.profileDetail.bio, { before: 'old bio', after: 'new bio' });
});

test('legacy relationship and profile activity migration is safe, durable and non-destructive', (t) => {
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
    '@Fixture_Cat_https://pbs.twimg.com/profile_images/old_https://pbs.twimg.com/profile_images/new_LazyCat'
  ).toString('base64url');
  const firstProfile = insert.run(
    'profile_fixture_cat_LazyCat_profile_payload',
    'actor-profile-1',
    'fixture_cat',
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
  const profileAlias = insert.run(encodedCrypto, '', 'Fixture_Cat', '', '', 0, '["all","my"]', cryptoAt, cryptoAt, cryptoAt, cryptoAt, cryptoAt + 1);
  const relationshipAt = Date.parse('2026-07-23T17:24:14.249Z');
  const relationship = insert.run('follow_fixture_star_bankrbot', '', 'fixture_star', '', '', 0, '["my"]', relationshipAt, relationshipAt, relationshipAt, relationshipAt, relationshipAt);
  const avatarChange = insert.run('opaque-avatar-change', '', 'fixture_star', '', '', 0, '["my"]', relationshipAt + 1, relationshipAt + 1, relationshipAt + 1, relationshipAt + 1, relationshipAt + 1);
  legacy.prepare('UPDATE social_posts SET raw_json = ? WHERE id = ?').run(
    JSON.stringify({ tw_type: 'reAvatar' }),
    avatarChange.lastInsertRowid
  );
  const postAt = Date.parse('2026-07-24T02:08:10.211Z');
  const realPost = insert.run('1900000000000000000', '', 'fixture_star', 'Star', '', 100, '["my"]', postAt, postAt, postAt, postAt, postAt);
  const insertChange = legacy.prepare(`
    INSERT INTO social_changes(event_type, entity_type, entity_id, payload_json, created_at)
    VALUES ('post.created', 'post', ?, '{}', ?)
  `);
  insertChange.run(String(firstProfile.lastInsertRowid), cryptoAt);
  insertChange.run(String(profileAlias.lastInsertRowid), cryptoAt + 1);
  insertChange.run(String(relationship.lastInsertRowid), relationshipAt);
  insertChange.run(String(avatarChange.lastInsertRowid), relationshipAt + 1);
  insertChange.run(String(realPost.lastInsertRowid), postAt);
  insertChange.run('999001', relationshipAt);
  legacy.prepare('UPDATE social_changes SET payload_json = ? WHERE entity_id = ?').run(
    JSON.stringify({
      source: 'twitter',
      externalId: 'follow:fixture_star:bankrbot',
      kind: 'post',
      author: { handle: 'fixture_star' }
    }),
    '999001'
  );
  insertChange.run('999002', postAt);
  legacy.prepare('UPDATE social_changes SET payload_json = ? WHERE entity_id = ?').run(
    JSON.stringify({
      source: 'twitter',
      externalId: '1900000000000000001',
      kind: 'post',
      author: { handle: 'fixture_star' },
      content: 'A retained orphaned tweet change'
    }),
    '999002'
  );
  legacy.close();

  store = createSocialStore(filename);
  let posts = store.listPosts();
  assert.equal(posts.length, 4);
  assert.equal(posts.some((post) => post.externalId === '1900000000000000000' && post.kind === 'post'), true);
  const migratedFollow = posts.find((post) => post.kind === 'follow');
  assert.equal(migratedFollow.externalId, 'follow:fixture_star:bankrbot');
  assert.equal(migratedFollow.target.handle, 'bankrbot');
  const profiles = posts.filter((post) => post.kind === 'profile');
  assert.equal(profiles.length, 2);
  assert.equal(profiles.every((post) => post.profileChanges.includes('avatar')), true);
  store.close();

  store = createSocialStore(filename);
  posts = store.listPosts();
  assert.equal(posts.length, 4);
  assert.equal(posts.filter((post) => post.kind === 'profile').every((post) =>
    post.profileChanges.includes('avatar')), true);
  store.close();
});

test('watchlist intents create authenticated bridge commands and acknowledgements update sync state', (t) => {
  const { store, setNow } = fixture(t);
  const added = store.addWatchAccounts([
    '@alice',
    {
      platform: 'binance-square',
      handle: 'Bob',
      name: 'Bob Square',
      eventTypes: ['unfollow', 'post', 'post']
    }
  ]);
  assert.equal(added.length, 2);
  assert.equal(added[0].entry.syncStatus, 'pending');
  assert.deepEqual(
    added[0].entry.eventTypes,
    normalizeWatchEventTypes(undefined, { defaultAll: true })
  );
  assert.deepEqual(added[1].entry.eventTypes, ['post', 'unfollow']);
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

  const pendingBeforeUpdate = store.getCounts().pendingCommands;
  const latestBeforeUpdate = store.getLatestChangeId();
  const updated = store.updateWatchAccountEventTypes(alice.id, ['profile_bio', 'reply', 'reply']);
  assert.equal(updated.changed, true);
  assert.deepEqual(updated.entry.eventTypes, ['reply', 'profile_bio']);
  assert.equal(updated.entry.syncStatus, 'synced');
  assert.equal(store.getCounts().pendingCommands, pendingBeforeUpdate);
  assert.equal(store.getLatestChangeId(), latestBeforeUpdate + 1);
  const idempotent = store.updateWatchAccountEventTypes(alice.id, ['reply', 'profile_bio']);
  assert.equal(idempotent.changed, false);
  assert.equal(idempotent.change, null);
  assert.equal(store.getLatestChangeId(), latestBeforeUpdate + 1);
  const empty = store.updateWatchAccountEventTypes(alice.id, []);
  assert.deepEqual(empty.entry.eventTypes, []);
  assert.throws(() => store.updateWatchAccountEventTypes(alice.id, 'post'), /must be an array/);
  assert.throws(() => store.updateWatchAccountEventTypes(alice.id, ['unknown']), /Unsupported social watch event type/);

  const removed = store.removeWatchAccount(alice.id);
  assert.equal(removed.entry.desiredState, 'removed');
  assert.equal(removed.command.type, 'watchlist.delete');
  assert.equal(store.listWatchlist().some((entry) => entry.id === alice.id), false);
  assert.equal(store.listWatchlist({ includeRemoved: true }).some((entry) => entry.id === alice.id), true);
});

test('watchlist additions persist initial preferences and keep their insertion order', (t) => {
  const { store, setNow } = fixture(t);
  const added = store.addWatchAccounts([
    {
      handle: 'zulu',
      note: '  第一批重点账号  ',
      eventTypes: ['quote', 'post', 'quote']
    },
    {
      handle: 'alpha',
      note: '第二个账号',
      eventTypes: ['reply']
    },
    {
      handle: 'middle',
      note: '',
      eventTypes: []
    }
  ]);

  assert.deepEqual(added.map((result) => result.entry.handle), ['zulu', 'alpha', 'middle']);
  assert.deepEqual(store.listWatchlist().map((entry) => entry.handle), ['zulu', 'alpha', 'middle']);
  assert.equal(added[0].entry.note, '第一批重点账号');
  assert.deepEqual(added[0].entry.eventTypes, ['post', 'quote']);
  assert.equal(added[1].entry.note, '第二个账号');
  assert.deepEqual(added[1].entry.eventTypes, ['reply']);
  assert.deepEqual(added[2].entry.eventTypes, []);

  const commands = store.claimCommands({ limit: 10 });
  assert.deepEqual(commands.map((command) => command.payload.handle), ['zulu', 'alpha', 'middle']);
  assert.equal(commands.every((command) => !Object.hasOwn(command.payload, 'note')), true);
  assert.throws(
    () => store.addWatchAccounts([{ handle: 'oversized', note: '猫'.repeat(501) }]),
    /must not exceed 500 characters/
  );
  assert.throws(
    () => store.addWatchAccounts([{ handle: 'invalid-note', note: null }]),
    /note must be a string/
  );

  setNow(1_900_000_001_000);
  store.removeWatchAccount(added[0].entry.id);
  setNow(1_900_000_002_000);
  const mixedBatch = store.addWatchAccounts([
    { handle: 'new-first', note: '本批第一个' },
    { handle: 'zulu', note: '本批第二个，重新加入' }
  ]).map((result) => result.entry);
  assert.equal(mixedBatch[1].createdAt, mixedBatch[0].createdAt + 1);
  assert.deepEqual(
    store.listWatchlist().map((entry) => entry.handle),
    ['alpha', 'middle', 'new-first', 'zulu']
  );
});

test('watchlist notes are local atomic preferences with Unicode limits and idempotent changes', (t) => {
  const { store, setNow } = fixture(t);
  const added = store.addWatchAccounts(['alice'])[0];
  const addCommand = store.claimCommands()[0];
  store.acknowledgeCommand(addCommand.id, { success: true, remoteId: 'debot-alice' });
  const before = store.listWatchlist()[0];
  const countsBefore = store.getCounts();
  const cursorBefore = store.getLatestChangeId();

  setNow(Date.parse('2026-07-17T12:00:10Z'));
  const noteOnly = store.updateWatchAccountPreferences(added.entry.id, { note: '  早期发现，重点观察  ' });
  assert.equal(noteOnly.changed, true);
  assert.equal(noteOnly.entry.note, '早期发现，重点观察');
  assert.deepEqual(noteOnly.entry.eventTypes, before.eventTypes);
  assert.equal(noteOnly.entry.syncStatus, before.syncStatus);
  assert.equal(noteOnly.entry.lastSyncedAt, before.lastSyncedAt);
  assert.equal(store.getCounts().pendingCommands, countsBefore.pendingCommands);
  assert.equal(store.getLatestChangeId(), cursorBefore + 1);
  assert.equal(noteOnly.change.data.note, '早期发现，重点观察');

  const idempotent = store.updateWatchAccountPreferences(added.entry.id, { note: '早期发现，重点观察' });
  assert.equal(idempotent.changed, false);
  assert.equal(idempotent.change, null);
  assert.equal(store.getLatestChangeId(), cursorBefore + 1);

  const combined = store.updateWatchAccountPreferences(added.entry.id, {
    note: '核心观察',
    eventTypes: ['reply', 'post', 'reply']
  });
  assert.equal(combined.changed, true);
  assert.equal(combined.entry.note, '核心观察');
  assert.deepEqual(combined.entry.eventTypes, ['post', 'reply']);
  assert.equal(store.getLatestChangeId(), cursorBefore + 2);

  const maximumNote = '🚀'.repeat(500);
  assert.equal(
    store.updateWatchAccountPreferences(added.entry.id, { note: maximumNote }).entry.note,
    maximumNote
  );
  assert.throws(
    () => store.updateWatchAccountPreferences(added.entry.id, { note: '🚀'.repeat(501) }),
    /must not exceed 500 characters/
  );
  assert.throws(() => store.updateWatchAccountPreferences(added.entry.id, {}), /must include/);
  assert.throws(
    () => store.updateWatchAccountPreferences(added.entry.id, { note: 'valid', unexpected: true }),
    /Unsupported watchlist patch field/
  );
  assert.throws(() => store.updateWatchAccountPreferences(added.entry.id, { note: null }), /must be a string/);

  const cleared = store.updateWatchAccountPreferences(added.entry.id, { note: '' });
  assert.equal(cleared.entry.note, '');
  assert.equal(store.claimCommands().length, 0);
});

test('watchlist notes survive database reopen without entering DeBot commands', (t) => {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'robinhood-social-note-persistence-'));
  const filename = path.join(directory, 'social.sqlite');
  t.after(() => fs.rmSync(directory, { recursive: true, force: true }));

  let store = createSocialStore(filename);
  const added = store.addWatchAccounts(['alice'])[0];
  store.updateWatchAccountPreferences(added.entry.id, { note: '本地长期备注' });
  const command = store.claimCommands()[0];
  assert.equal(Object.hasOwn(command.payload, 'note'), false);
  assert.equal(JSON.stringify(command.payload).includes('本地长期备注'), false);
  store.close();

  store = createSocialStore(filename);
  assert.equal(store.listWatchlist()[0].note, '本地长期备注');
  store.close();
});

test('personal watchlist filtering applies account event preferences before its result limit', (t) => {
  const { store } = fixture(t);
  const watched = store.addWatchAccounts(['alice'])[0].entry;
  store.upsertPosts([
    {
      source: 'twitter',
      id: 'plain-post',
      kind: 'post',
      authorHandle: 'alice',
      text: 'plain monitored post'
    },
    {
      source: 'twitter',
      id: 'profile:alice:1784289600000',
      kind: 'profile',
      authorHandle: 'alice',
      profileChanges: ['avatar', 'name'],
      profileDetail: {
        name: { before: 'Alice', after: 'Alice 2' },
        avatar: { before: 'https://example.test/old.png', after: 'https://example.test/new.png' }
      }
    },
    {
      source: 'twitter',
      id: 'deleted-post',
      kind: 'post',
      authorHandle: 'alice',
      text: 'deleted monitored post',
      deleted: true,
      deletedAt: 1784289601000
    },
    {
      source: 'twitter',
      id: 'follow-observation',
      kind: 'follow',
      authorHandle: 'alice',
      targetHandle: 'bob'
    },
    {
      source: 'twitter',
      id: 'unwatched-noise',
      kind: 'post',
      authorHandle: 'charlie',
      text: 'not in the personal watchlist'
    }
  ]);

  const visibleIds = () => store.listPosts({ watchlistOnly: true, limit: 100 })
    .map((post) => post.externalId)
    .sort();
  assert.deepEqual(visibleIds(), [
    'deleted-post',
    'follow:alice:bob',
    'plain-post',
    'profile:alice:1784289600000'
  ]);

  store.updateWatchAccountEventTypes(watched.id, ['post']);
  assert.deepEqual(visibleIds(), ['plain-post']);
  assert.deepEqual(
    store.listPosts({ watchlistOnly: true, limit: 1 }).map((post) => post.externalId),
    ['plain-post']
  );
  store.updateWatchAccountEventTypes(watched.id, ['delete']);
  assert.deepEqual(visibleIds(), ['deleted-post']);
  store.updateWatchAccountEventTypes(watched.id, ['profile_avatar']);
  assert.deepEqual(visibleIds(), ['profile:alice:1784289600000']);
  store.updateWatchAccountEventTypes(watched.id, ['profile_bio']);
  assert.deepEqual(visibleIds(), []);
  store.updateWatchAccountEventTypes(watched.id, ['follow']);
  assert.deepEqual(visibleIds(), ['follow:alice:bob']);
  store.updateWatchAccountEventTypes(watched.id, []);
  assert.deepEqual(visibleIds(), []);
});

test('complete remote watchlist snapshots reconcile direct DeBot additions and removals', (t) => {
  const { store } = fixture(t);
  const local = store.addWatchAccounts(['alice'])[0];
  const command = store.claimCommands()[0];
  store.acknowledgeCommand(command.id, { success: true });

  const reconciled = store.reconcileRemoteWatchlist([
    { handle: 'bob', remoteId: 'debot-bob', eventTypes: ['post'] }
  ]);
  const byHandle = new Map(reconciled.entries.map((entry) => [entry.handle, entry]));
  assert.equal(byHandle.get('alice').desiredState, 'removed');
  assert.equal(byHandle.get('alice').syncStatus, 'synced');
  assert.equal(byHandle.get('bob').desiredState, 'active');
  assert.equal(byHandle.get('bob').syncStatus, 'synced');
  assert.deepEqual(
    byHandle.get('bob').eventTypes,
    normalizeWatchEventTypes(undefined, { defaultAll: true })
  );
  store.updateWatchAccountPreferences(byHandle.get('bob').id, {
    eventTypes: ['follow', 'profile_avatar'],
    note: '只保存在 VPS 的备注'
  });
  const repeated = store.reconcileRemoteWatchlist([{
    handle: 'bob',
    remoteId: 'debot-bob',
    metadata: { monitorLevel: 'important' },
    eventTypes: ['post'],
    note: { invalid: '远端备注字段也不得影响本地偏好' }
  }]);
  const repeatedBob = repeated.entries.find((entry) => entry.handle === 'bob');
  assert.deepEqual(repeatedBob.eventTypes, ['follow', 'profile_avatar']);
  assert.equal(repeatedBob.note, '只保存在 VPS 的备注');
  assert.equal(local.entry.id > 0, true);
});

test('legacy watchlist rows migrate to all event types and profile details survive database reopen', (t) => {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'robinhood-social-watch-migration-'));
  const filename = path.join(directory, 'social.sqlite');
  t.after(() => fs.rmSync(directory, { recursive: true, force: true }));

  let store = createSocialStore(filename);
  store.addWatchAccounts(['alice']);
  const profile = store.upsertPosts([{
    source: 'twitter',
    id: 'profile-persisted',
    kind: 'profile',
    authorHandle: 'alice',
    profileChanges: ['bio', 'name'],
    profileDetail: {
      name: { before: 'Alice', after: 'Alice 2' },
      bio: { before: 'before bio', after: 'after bio' }
    }
  }])[0].post;
  assert.deepEqual(profile.profileChanges, ['name', 'bio']);
  store.close();

  const legacy = new DatabaseSync(filename);
  legacy.exec('ALTER TABLE social_watchlist DROP COLUMN event_types_json');
  legacy.exec('ALTER TABLE social_watchlist DROP COLUMN local_note');
  legacy.close();

  store = createSocialStore(filename);
  assert.deepEqual(
    store.listWatchlist()[0].eventTypes,
    normalizeWatchEventTypes(undefined, { defaultAll: true })
  );
  assert.equal(store.listWatchlist()[0].note, '');
  const reopenedProfile = store.getPost('twitter', 'profile-persisted');
  assert.deepEqual(reopenedProfile.profileChanges, ['name', 'bio']);
  assert.deepEqual(reopenedProfile.profileDetail, {
    name: { before: 'Alice', after: 'Alice 2' },
    bio: { before: 'before bio', after: 'after bio' }
  });
  store.close();
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

test('versioned and legacy stale snapshots cannot revive a confirmed removal tombstone', (t) => {
  const initialNow = Date.parse('2026-07-17T12:00:00Z');
  const { store, setNow } = fixture(t, initialNow);
  const alice = store.addWatchAccounts(['alice'])[0].entry;
  const addCommand = store.claimCommands()[0];
  store.acknowledgeCommand(addCommand.id, { success: true, remoteId: '42' });

  setNow(initialNow + 2_000);
  store.removeWatchAccount(alice.id);
  const unverifiedDelete = store.claimCommands()[0];
  const rejectedAck = store.acknowledgeCommand(unverifiedDelete.id, { success: true });
  assert.equal(rejectedAck.status, 'failed');
  assert.match(rejectedAck.lastError, /did not verify/i);

  setNow(initialNow + 3_000);
  store.removeWatchAccount(alice.id);
  const verifiedDelete = store.claimCommands()[0];
  const completedAck = store.acknowledgeCommand(verifiedDelete.id, {
    success: true,
    verifiedAbsent: true
  });
  assert.equal(completedAck.status, 'completed');
  assert.equal(
    store.listWatchlist({ includeRemoved: true }).find((entry) => entry.id === alice.id).syncStatus,
    'synced'
  );

  const session = {
    snapshotSessionId: 'bridge-session-a',
    snapshotSessionStartedAt: initialNow + 1_000,
    snapshotRevision: 2
  };
  const accepted = store.reconcileRemoteWatchlist([], session);
  assert.equal(accepted.snapshot.accepted, true);
  assert.equal(store.getBridgeState().snapshotRevision, 2);

  const staleRevision = store.reconcileRemoteWatchlist([{
    handle: 'alice',
    remoteId: '42'
  }], { ...session, snapshotRevision: 1 });
  assert.equal(staleRevision.snapshot.accepted, false);
  assert.equal(staleRevision.snapshot.reason, 'stale-snapshot-revision');

  const olderSession = store.reconcileRemoteWatchlist([{
    handle: 'alice',
    remoteId: '42'
  }], {
    snapshotSessionId: 'bridge-session-older',
    snapshotSessionStartedAt: initialNow,
    snapshotRevision: 99
  });
  assert.equal(olderSession.snapshot.accepted, false);
  assert.equal(olderSession.snapshot.reason, 'older-snapshot-session');

  const legacy = store.reconcileRemoteWatchlist([{ handle: 'alice', remoteId: '42' }]);
  assert.equal(legacy.snapshot.accepted, false);
  assert.equal(legacy.snapshot.versioned, false);
  assert.equal(legacy.snapshot.reason, 'legacy-snapshot-after-versioned-session');

  const sameSessionNewerRevision = store.reconcileRemoteWatchlist([{
    handle: 'alice',
    remoteId: '42'
  }], { ...session, snapshotRevision: 3 });
  assert.equal(sameSessionNewerRevision.snapshot.accepted, true);
  const tombstone = store.listWatchlist({ includeRemoved: true }).find((entry) => entry.id === alice.id);
  assert.equal(tombstone.desiredState, 'removed');
  assert.equal(tombstone.syncStatus, 'synced');
  assert.equal(store.listWatchlist().some((entry) => entry.handle === 'alice'), false);
  const { diagnostics, ...bridgeState } = store.getBridgeState();
  assert.deepEqual(bridgeState, {
    bridgeId: '',
    version: '',
    capabilities: [],
    sessionId: '',
    snapshotSessionId: 'bridge-session-a',
    snapshotSessionStartedAt: initialNow + 1_000,
    snapshotRevision: 3,
    lastSeenAt: null
  });
  assert.deepEqual(diagnostics, {
    ws: {
      connectionOpens: 0,
      authorizationSuccesses: 0,
      subscribeAttempts: 0,
      subscribeFailures: 0,
      lastSubscribeAt: null,
      framesSeen: 0,
      accepted: 0,
      rejected: 0,
      unmatchedChannel: 0,
      invalidPacket: 0,
      invalidEnvelope: 0,
      unmonitoredAuthor: 0,
      invalidEvent: 0,
      unreadable: 0,
      lastEventAt: null
    },
    poll: {
      startedAt: null,
      finishedAt: null,
      elapsedMs: null,
      rawRows: 0,
      normalizedRows: 0,
      droppedRows: 0,
      accountCount: 0,
      configHash: '',
      latestSourceAt: null,
      lastErrorCategory: '',
      attempts: 0,
      successes: 0,
      failures: 0
    },
    forcePoll: {
      successes: 0,
      failures: 0,
      lastAt: null,
      elapsedMs: null,
      lastErrorCategory: ''
    }
  });
});

test('bridge heartbeat diagnostics retain only bounded health counters and categories', (t) => {
  const initialNow = Date.parse('2026-07-17T12:00:00Z');
  const { store, setNow } = fixture(t, initialNow);
  const bridge = store.recordBridgeHeartbeat({
    bridgeId: 'chrome-main',
    version: '1.3.0',
    capabilities: ['posts', 'watchlist'],
    diagnostics: {
      ws: {
        connectionOpens: 4,
        authorizationSuccesses: 3,
        subscribeAttempts: 3,
        subscribeFailures: 1,
        lastSubscribeAt: initialNow - 75,
        framesSeen: 123,
        accepted: 17,
        rejected: 106,
        unmatchedChannel: 55,
        invalidPacket: 10,
        invalidEnvelope: 11,
        unmonitoredAuthor: 20,
        invalidEvent: 7,
        unreadable: 3,
        lastEventAt: initialNow - 50,
        rawFrame: '{"secret":"must-not-persist"}'
      },
      poll: {
        startedAt: initialNow - 1_000,
        finishedAt: initialNow - 850,
        elapsedMs: 150,
        rawRows: 12,
        normalizedRows: 10,
        droppedRows: 2,
        accountCount: 22,
        configHash: 'ABCDEF12',
        latestSourceAt: initialNow - 1_500,
        lastErrorCategory: 'network',
        attempts: 50,
        successes: 48,
        failures: 2,
        payload: 'debot-cookie-value'
      },
      forcePoll: {
        successes: 5,
        failures: 1,
        lastAt: initialNow - 500,
        elapsedMs: 321,
        lastErrorCategory: 'TIMEOUT',
        credential: 'Bearer bridge-secret'
      },
      rawDeBotPayload: { text: 'must-not-persist' }
    }
  });

  assert.deepEqual(bridge.diagnostics, {
    ws: {
      connectionOpens: 4,
      authorizationSuccesses: 3,
      subscribeAttempts: 3,
      subscribeFailures: 1,
      lastSubscribeAt: initialNow - 75,
      framesSeen: 123,
      accepted: 17,
      rejected: 106,
      unmatchedChannel: 55,
      invalidPacket: 10,
      invalidEnvelope: 11,
      unmonitoredAuthor: 20,
      invalidEvent: 7,
      unreadable: 3,
      lastEventAt: initialNow - 50
    },
    poll: {
      startedAt: initialNow - 1_000,
      finishedAt: initialNow - 850,
      elapsedMs: 150,
      rawRows: 12,
      normalizedRows: 10,
      droppedRows: 2,
      accountCount: 22,
      configHash: 'abcdef12',
      latestSourceAt: initialNow - 1_500,
      lastErrorCategory: 'NETWORK',
      attempts: 50,
      successes: 48,
      failures: 2
    },
    forcePoll: {
      successes: 5,
      failures: 1,
      lastAt: initialNow - 500,
      elapsedMs: 321,
      lastErrorCategory: 'TIMEOUT'
    }
  });
  const persisted = store.db.prepare('SELECT diagnostics_json FROM social_bridge_state WHERE singleton = 1').get();
  assert.equal(persisted.diagnostics_json.includes('must-not-persist'), false);
  assert.equal(persisted.diagnostics_json.includes('bridge-secret'), false);
  assert.equal(persisted.diagnostics_json.includes('debot-cookie-value'), false);

  setNow(initialNow + 1_000);
  const legacyHeartbeat = store.recordBridgeHeartbeat({
    bridgeId: 'chrome-main',
    version: '1.2.0',
    capabilities: ['posts']
  });
  assert.deepEqual(legacyHeartbeat.diagnostics, bridge.diagnostics);

  const invalid = store.recordBridgeHeartbeat({
    diagnostics: {
      ws: {
        connectionOpens: -1,
        authorizationSuccesses: Infinity,
        subscribeAttempts: 1_000_000_001,
        subscribeFailures: 'not-a-counter',
        lastSubscribeAt: 'not-a-timestamp',
        framesSeen: -1,
        accepted: Infinity,
        lastEventAt: 'not-a-timestamp'
      },
      poll: {
        elapsedMs: 600_001,
        configHash: 'account-identifiers-must-not-be-saved',
        lastErrorCategory: 'some-error-text-that-is-not-a-category'
      },
      forcePoll: { elapsedMs: -1, lastErrorCategory: 'AUTH' }
    }
  });
  assert.deepEqual(invalid.diagnostics.ws, {
    connectionOpens: 0,
    authorizationSuccesses: 0,
    subscribeAttempts: 0,
    subscribeFailures: 0,
    lastSubscribeAt: null,
    framesSeen: 0,
    accepted: 0,
    rejected: 0,
    unmatchedChannel: 0,
    invalidPacket: 0,
    invalidEnvelope: 0,
    unmonitoredAuthor: 0,
    invalidEvent: 0,
    unreadable: 0,
    lastEventAt: null
  });
  assert.equal(invalid.diagnostics.poll.elapsedMs, null);
  assert.equal(invalid.diagnostics.poll.configHash, '');
  assert.equal(invalid.diagnostics.poll.lastErrorCategory, '');
  assert.equal(invalid.diagnostics.forcePoll.elapsedMs, null);
  assert.equal(invalid.diagnostics.forcePoll.lastErrorCategory, 'AUTH');
});

test('existing bridge state databases migrate diagnostics without resetting heartbeat state', (t) => {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'robinhood-social-bridge-diagnostics-migration-'));
  const filename = path.join(directory, 'social.sqlite');
  t.after(() => fs.rmSync(directory, { recursive: true, force: true }));

  let store = createSocialStore(filename);
  store.recordBridgeHeartbeat({
    bridgeId: 'legacy-browser',
    version: '1.2.0',
    capabilities: ['posts'],
    sessionId: 'legacy-session'
  });
  store.close();

  const legacy = new DatabaseSync(filename);
  legacy.exec('ALTER TABLE social_bridge_state DROP COLUMN diagnostics_json');
  legacy.close();

  store = createSocialStore(filename);
  t.after(() => store.close());
  const columns = store.db.prepare('PRAGMA table_info(social_bridge_state)').all().map((column) => column.name);
  assert.equal(columns.includes('diagnostics_json'), true);
  assert.equal(store.getBridgeState().bridgeId, 'legacy-browser');
  assert.equal(store.getBridgeState().sessionId, 'legacy-session');
  assert.equal(store.getBridgeState().diagnostics.poll.accountCount, 0);
});

test('legacy snapshots cannot remove accounts added by a newer versioned snapshot', (t) => {
  const initialNow = Date.parse('2026-07-17T12:00:00Z');
  const { store } = fixture(t, initialNow);
  const session = {
    snapshotSessionId: 'bridge-session-current',
    snapshotSessionStartedAt: initialNow,
    snapshotRevision: 1
  };

  store.reconcileRemoteWatchlist([{ handle: 'alice' }], session);
  const current = store.reconcileRemoteWatchlist([
    { handle: 'alice' },
    { handle: 'bob' }
  ], { ...session, snapshotRevision: 2 });
  assert.equal(current.snapshot.accepted, true);
  assert.deepEqual(store.listWatchlist().map((entry) => entry.handle), ['alice', 'bob']);

  const lateLegacy = store.reconcileRemoteWatchlist([{ handle: 'alice' }]);
  assert.deepEqual(lateLegacy.snapshot, {
    accepted: false,
    versioned: false,
    reason: 'legacy-snapshot-after-versioned-session'
  });
  assert.deepEqual(lateLegacy.changes, []);
  assert.deepEqual(store.listWatchlist().map((entry) => entry.handle), ['alice', 'bob']);
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
