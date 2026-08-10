import assert from 'node:assert/strict';
import test from 'node:test';

import { dedupeFomoEvents, normalizeFomoCatalog, normalizeFomoEvent } from '../src/social/fomo.js';
import { createSocialStore } from '../src/social/store.js';
import { createSocialConfig } from '../src/social/config.js';

test('FOMO polling defaults to one second and remains bounded', () => {
  assert.equal(createSocialConfig({}).fomoPollIntervalMs, 1_000);
  assert.equal(createSocialConfig({ SOCIAL_FOMO_POLL_INTERVAL_MS: '100' }).fomoPollIntervalMs, 500);
});

test('FOMO catalog preserves source identity and resolves avatars', () => {
  const [account] = normalizeFomoCatalog({ accounts: [{
    handle: 'Binkieee', display_name: 'Binkieee', avatar_url: '/avatar.jpg', follower_count: 175, phys_state: 'active'
  }] });
  assert.deepEqual(account, {
    platform: 'fomo', handle: 'binkieee', name: 'Binkieee',
    avatarUrl: 'https://wind.jokkimon.club/avatar.jpg', followers: 175, active: true
  });
});

test('FOMO events expose structured trade fields and CA for Bark', () => {
  const post = normalizeFomoEvent({ seq: 7, handle: 'binkieee', action: 'fomo_buy', ts: 1_786_320_655_000, payload: {
    tweet_id: 'fomo:ws:buy-1', author_name: 'Binkieee', content_text: '买入 SD',
    extra: { fomo: { symbol: 'SD', ca: '3H7kMWRa7WfrpBGcyMpiAxkjBCc7k1pDShjQLDHJpump', chain: 'Solana', usd: 3088, followers: 128005 } },
    ca_info: [{ address: '3H7kMWRa7WfrpBGcyMpiAxkjBCc7k1pDShjQLDHJpump', resolved_chain: 'solana', symbol: 'SD', mc: 230000, vol24h: 271000, price: 0.0003235 }]
  } });
  assert.equal(post.kind, 'fomo_buy');
  assert.equal(post.authorFollowers, 128005);
  assert.equal(post.contractAddresses[0].address, '3H7kMWRa7WfrpBGcyMpiAxkjBCc7k1pDShjQLDHJpump');
  assert.equal(post.raw.fomo.usd, 3088);
  assert.equal(post.raw.fomo.mcap, 230000);
  assert.equal(post.raw.fomo.volume24h, 271000);
  assert.equal(post.raw.fomo.price, 0.0003235);
});

test('FOMO translation patches preserve structured buy and sell details', (t) => {
  const store = createSocialStore(':memory:');
  t.after(() => store.close());
  const original = normalizeFomoEvent({ seq: 8, handle: 'binkieee', action: 'fomo_sell', ts: 1_786_320_655_000, payload: {
    tweet_id: 'fomo:trade-8', content_text: '卖出 PIZZA',
    extra: { fomo: { symbol: 'PIZZA', ca: '0x8554d38b95e4f7ca11d391008627df30b2b07777', chain: 'BNB', usd: 2615, amount: 3425704, price: 0.000763, closed: true } },
    ca_info: [{ address: '0x8554d38b95e4f7ca11d391008627df30b2b07777', resolved_chain: 'bsc', mc: 748103, vol24h: 778304 }]
  } });
  store.upsertPosts([original]);
  store.upsertPosts([{ source: 'fomo', externalId: original.externalId, sourceUpdatedAt: original.sourceUpdatedAt, translatedContent: '卖出 PIZZA' }]);
  const stored = store.getPost('fomo', original.externalId);
  assert.equal(stored.raw.fomo.symbol, 'PIZZA');
  assert.equal(stored.raw.fomo.chain, 'bsc');
  assert.equal(stored.raw.fomo.mcap, 748103);
  assert.equal(stored.raw.fomo.closed, true);
});

test('duplicate firehose and on-chain trade frames collapse by transaction', () => {
  const event = (id, status, closed = false) => ({ handle: 'alice', action: 'fomo_sell', ts: 1000, payload: {
    tweet_id: id, tweet_url: 'https://bscscan.com/tx/0xabc', content_text: '卖出 TOKEN',
    extra: { fomo: { ca: '0x1111111111111111111111111111111111111111', chain: 'BNB', tx_url: 'https://bscscan.com/tx/0xabc', status, closed } }
  } });
  const posts = dedupeFomoEvents([event('fomo:fh:1', 'success'), event('fomo:oc:1', 'final', true)]);
  assert.equal(posts.length, 1);
  assert.equal(posts[0].raw.fomo.closed, true);
});

test('FOMO watch accounts are local and never create DeBot commands', (t) => {
  const store = createSocialStore(':memory:');
  t.after(() => store.close());
  const [added] = store.addWatchAccounts([{ platform: 'fomo', handle: 'binkieee', caBark: true }]);
  assert.equal(added.entry.syncStatus, 'synced');
  assert.equal(added.command, null);
  const removed = store.removeWatchAccount(added.entry.id);
  assert.equal(removed.entry.syncStatus, 'synced');
  assert.equal(removed.command, null);
});

test('DeBot X snapshots cannot remove or alter local FOMO accounts', (t) => {
  const store = createSocialStore(':memory:');
  t.after(() => store.close());
  store.addWatchAccounts([{
    platform: 'fomo', handle: 'binkieee', eventTypes: ['fomo_buy', 'fomo_thesis'], caBark: true
  }]);
  store.reconcileRemoteWatchlist([{ platform: 'twitter', handle: 'alice', remoteId: '1' }]);
  const fomo = store.listWatchlist({ platform: 'fomo' });
  assert.equal(fomo.length, 1);
  assert.equal(fomo[0].desiredState, 'active');
  assert.deepEqual(fomo[0].eventTypes, ['fomo_buy', 'fomo_thesis']);
  assert.equal(fomo[0].caBark, true);
});
