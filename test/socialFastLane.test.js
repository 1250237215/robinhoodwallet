import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

import { createSocialService } from '../src/social/service.js';

async function eventually(assertion, timeoutMs = 1_000) {
  const deadline = Date.now() + timeoutMs;
  let lastError;
  while (Date.now() < deadline) {
    try {
      assertion();
      return;
    } catch (error) {
      lastError = error;
      await new Promise((resolve) => setTimeout(resolve, 10));
    }
  }
  throw lastError;
}

test('service fast lane ingests configured X posts immediately and closes every worker', async (t) => {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'robinhood-social-fast-lane-'));
  const publishedAt = Date.parse('2026-07-27T10:05:09.000Z');
  let polls = 0;
  const confirmed = new Set();
  let replyEnricherClosed = false;
  const replyEnqueues = [];
  const fastPost = {
    source: 'twitter',
    kind: 'post',
    externalId: '2081682293836656926',
    author: { handle: '1874a3', name: '1874a3' },
    content: 'u u',
    url: 'https://x.com/1874a3/status/2081682293836656926',
    publishedAt
  };
  const service = createSocialService({
    config: {
      dataFile: path.join(directory, 'social.sqlite'),
      bridgeToken: '',
      retentionDays: 7,
      bridgeOfflineMs: 90_000,
      cleanupIntervalMs: 60_000,
      commandLeaseMs: 30_000,
      xFastHandles: ['1874a3'],
      xFastPollIntervalMs: 250,
      xFastMaxInFlight: 2,
      xFastRequestTimeoutMs: 3_500,
      xReplyEnrichmentEnabled: false
    },
    xProfileMonitor: {
      async pollOnce(accounts, { onResult } = {}) {
        polls += 1;
        assert.deepEqual(accounts, ['1874a3']);
        const isConfirmed = confirmed.has(fastPost.externalId);
        const result = {
          handle: '1874a3',
          status: isConfirmed ? 'duplicate' : 'new',
          checkedAt: Date.now(),
          post: fastPost,
          posts: isConfirmed ? [] : [fastPost]
        };
        await onResult?.(result);
        return {
          posts: result.posts,
          results: [result]
        };
      },
      confirm(handle, tweetIds) {
        assert.equal(handle, '1874a3');
        for (const tweetId of tweetIds) confirmed.add(tweetId);
      }
    },
    xReplyEnricher: {
      enqueue(posts) {
        replyEnqueues.push(...posts);
      },
      close() {
        replyEnricherClosed = true;
      }
    }
  });
  t.after(() => {
    service.close();
    fs.rmSync(directory, { recursive: true, force: true });
  });

  service.start();
  await eventually(() => assert.ok(service.store.getPost('twitter', '2081682293836656926')));
  const stored = service.store.getPost('twitter', '2081682293836656926');
  assert.equal(stored.content, 'u u');
  assert.equal(stored.author.handle, '1874a3');
  assert.deepEqual(stored.feedSources, ['my']);
  assert.ok(polls >= 1);
  assert.deepEqual([...confirmed], ['2081682293836656926']);
  assert.deepEqual(replyEnqueues, []);

  service.close();
  assert.equal(replyEnricherClosed, true);
});

test('service retries an X post after persistence fails and confirms it only after a successful write', async (t) => {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'robinhood-social-fast-retry-'));
  const externalId = '2081682293836656999';
  let attempts = 0;
  let confirmations = 0;
  let confirmed = false;
  const post = {
    source: 'twitter',
    kind: 'post',
    externalId,
    author: { handle: '1874a3', name: '1874a3' },
    content: 'persist me',
    url: `https://x.com/1874a3/status/${externalId}`,
    publishedAt: Date.parse('2026-07-27T10:06:00.000Z')
  };
  const monitor = {
    async pollOnce(accounts, { onResult } = {}) {
      attempts += 1;
      const result = {
        handle: accounts[0],
        status: confirmed ? 'duplicate' : 'new',
        checkedAt: Date.now(),
        post,
        posts: confirmed ? [] : [post]
      };
      try {
        await onResult?.(result);
      } catch {
        // The real monitor records deliveryError and leaves the post unconfirmed.
      }
      return { posts: result.posts, results: [result] };
    },
    confirm(handle, tweetIds) {
      assert.equal(handle, '1874a3');
      assert.deepEqual(tweetIds, [externalId]);
      confirmations += 1;
      confirmed = true;
    }
  };
  const service = createSocialService({
    config: {
      dataFile: path.join(directory, 'social.sqlite'),
      bridgeToken: '',
      retentionDays: 7,
      bridgeOfflineMs: 90_000,
      cleanupIntervalMs: 60_000,
      commandLeaseMs: 30_000,
      xFastHandles: ['1874a3'],
      xFastPollIntervalMs: 250,
      xFastMaxInFlight: 2,
      xFastRequestTimeoutMs: 3_500,
      xReplyEnrichmentEnabled: false
    },
    xProfileMonitor: monitor,
    xReplyEnricher: { enqueue() {}, close() {} }
  });
  const upsertPosts = service.store.upsertPosts.bind(service.store);
  let failFirstWrite = true;
  service.store.upsertPosts = (posts) => {
    if (failFirstWrite) {
      failFirstWrite = false;
      throw new Error('simulated SQLite failure');
    }
    return upsertPosts(posts);
  };
  t.after(() => {
    service.close();
    fs.rmSync(directory, { recursive: true, force: true });
  });

  service.start();
  await eventually(() => assert.ok(service.store.getPost('twitter', externalId)));
  assert.ok(attempts >= 2);
  assert.equal(confirmations, 1);
  assert.equal(service.getFastXStatus().lastErrorCode, 'Error');
});
