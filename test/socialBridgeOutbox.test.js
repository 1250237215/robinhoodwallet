import test from 'node:test';
import assert from 'node:assert/strict';
import {
  createPostOutbox,
  POST_OUTBOX_LIMITS
} from '../bridge/debot-social-bridge/post-outbox.js';

class FakeStorage {
  constructor(initial = {}) {
    this.value = structuredClone(initial);
    this.setCalls = 0;
  }

  async get(key) {
    return { [key]: structuredClone(this.value[key]) };
  }

  async set(next) {
    Object.assign(this.value, structuredClone(next));
    this.setCalls += 1;
  }
}

function post(externalId, overrides = {}) {
  return {
    source: 'debot',
    externalId,
    kind: 'post',
    author: {
      id: 'author-1',
      handle: 'alice',
      name: 'Alice',
      avatarUrl: 'https://example.test/alice.png',
      followersCount: 42
    },
    content: `post ${externalId}`,
    translatedContent: '',
    url: `https://example.test/posts/${externalId}`,
    media: [],
    contractAddresses: [],
    chainTags: ['robinhood'],
    replyToExternalId: '',
    quotedExternalId: '',
    repostExternalId: '',
    publishedAt: 100,
    receivedAt: 200,
    sourceUpdatedAt: 100,
    deleted: false,
    deletedAt: null,
    feedSources: ['my'],
    ...overrides
  };
}

test('outbox deduplicates an observed version but queues real source updates', async () => {
  const storage = new FakeStorage();
  let clock = 1_000;
  const outbox = createPostOutbox({ storage, now: () => clock++ });

  const first = await outbox.enqueue([
    post('same'),
    post('same'),
    post('same', { receivedAt: 999 })
  ]);
  assert.deepEqual(
    { added: first.added, duplicates: first.duplicates, rejected: first.rejected, queued: first.queued },
    { added: 1, duplicates: 2, rejected: 0, queued: 1 }
  );

  const updated = await outbox.enqueue(post('same', {
    content: 'edited at source',
    sourceUpdatedAt: 101,
    receivedAt: 1_000
  }));
  assert.equal(updated.added, 1);
  assert.equal(updated.queued, 2);

  const otherSource = await outbox.enqueue(post('same', { source: 'another-feed' }));
  assert.equal(otherSource.added, 1);
  const batch = await outbox.readBatch(10);
  assert.equal(batch.count, 3);
  assert.equal(batch.queued, 3);
  assert.equal(batch.remaining, 0);
  assert.equal(new Set(batch.records.map(({ key }) => key)).size, 3);
  assert.equal(batch.records[1].post.content, 'edited at source');
});

test('outbox persists only the post allowlist and never raw or credential fields', async () => {
  const storage = new FakeStorage();
  const outbox = createPostOutbox({ storage });
  await outbox.enqueue(post('safe', {
    bridgeToken: 'private-bridge-token',
    cookie: 'private-cookie',
    raw: { response: 'private-raw-response' },
    author: {
      id: 'author-1',
      handle: 'alice',
      name: 'Alice',
      accessToken: 'private-author-token',
      raw: { private: true }
    },
    media: [{
      type: 'image',
      url: 'https://example.test/image.png',
      previewUrl: 'https://example.test/preview.png',
      cookie: 'private-media-cookie'
    }]
  }));

  const serialized = JSON.stringify(storage.value);
  for (const secret of [
    'private-bridge-token',
    'private-cookie',
    'private-raw-response',
    'private-author-token',
    'private-media-cookie'
  ]) {
    assert.equal(serialized.includes(secret), false);
  }
  const [{ post: stored }] = (await outbox.readBatch()).records;
  assert.deepEqual(Object.keys(stored.author).sort(), [
    'avatarUrl', 'followersCount', 'handle', 'id', 'name'
  ]);
  assert.deepEqual(Object.keys(stored.media[0]).sort(), ['previewUrl', 'type', 'url']);
});

test('outbox persists complete relationship, reference and profile activity through a strict allowlist', async () => {
  const storage = new FakeStorage();
  const outbox = createPostOutbox({ storage });
  const result = await outbox.enqueue([
    post('follow:alice:bob', {
      kind: 'follow',
      target: {
        id: 'target-1',
        handle: 'bob',
        name: 'Bob',
        avatarUrl: 'https://example.test/bob.png',
        followersCount: 73,
        url: 'https://x.com/bob',
        cookie: 'private-target-cookie'
      }
    }),
    post('unfollow:alice:carol', {
      kind: 'unfollow',
      target: {
        id: 'target-2',
        handle: 'carol',
        name: 'Carol',
        avatarUrl: 'https://example.test/carol.png',
        followersCount: 19,
        url: 'https://x.com/carol',
        authorization: 'private-target-authorization'
      }
    }),
    post('profile:alice:100', {
      kind: 'profile',
      profileChanges: ['name', 'avatar', 'bio', 'unknown', 'name'],
      profileDetail: {
        name: { before: 'Alice', after: 'Alice 2', cookie: 'private-profile-cookie' },
        avatar: { before: 'https://old.example/a.png', after: 'https://new.example/a.png' },
        bio: { before: 'old bio', after: 'new bio' },
        unknown: { before: 'private-profile-before', after: 'private-profile-after' }
      }
    }),
    post('reply-1', {
      kind: 'reply',
      target: { handle: 'parent_user', name: 'Parent User', cookie: 'private-reply-target' },
      replyToExternalId: 'parent-1',
      replyContext: {
        externalId: 'parent-1',
        author: { handle: 'parent_user', name: 'Parent User', cookie: 'private-parent-cookie' },
        content: 'Parent text',
        translatedContent: '父帖翻译',
        url: 'https://x.com/parent_user/status/parent-1',
        publishedAt: 90,
        raw: 'private-reply-raw'
      }
    }),
    post('quote-1', {
      kind: 'quote',
      quotedExternalId: 'quoted-1',
      quoteContext: {
        externalId: 'quoted-1',
        author: {
          id: 'quoted-author-1',
          handle: 'quoted_author',
          name: 'Quoted Author',
          avatarUrl: 'https://example.test/quoted-author.png',
          followersCount: 81,
          cookie: 'private-quote-author-cookie',
          raw: { credential: 'private-quote-author-raw' }
        },
        content: 'Quoted text',
        translatedContent: '引用翻译',
        url: 'https://x.com/quoted_author/status/quoted-1',
        publishedAt: 80,
        cookie: 'private-quote-cookie',
        raw: { response: 'private-quote-raw' }
      }
    }),
    post('ordinary-tweet', {
      target: { handle: 'must-not-be-persisted' }
    })
  ]);

  const records = (await outbox.readBatch()).records.map((record) => record.post);
  assert.equal(result.rejected, 0);
  assert.equal(result.added, 6);
  assert.deepEqual(records.map((record) => record.externalId), [
    'follow:alice:bob',
    'unfollow:alice:carol',
    'profile:alice:100',
    'reply-1',
    'quote-1',
    'ordinary-tweet'
  ]);
  assert.deepEqual(Object.keys(records[0].target).sort(), [
    'avatarUrl', 'followersCount', 'handle', 'id', 'name', 'url'
  ]);
  assert.deepEqual(records[2].profileChanges, ['name', 'avatar', 'bio']);
  assert.deepEqual(records[2].profileDetail, {
    name: { before: 'Alice', after: 'Alice 2' },
    avatar: { before: 'https://old.example/a.png', after: 'https://new.example/a.png' },
    bio: { before: 'old bio', after: 'new bio' }
  });
  assert.equal(records[3].target.handle, 'parent_user');
  assert.equal(records[3].replyContext.content, 'Parent text');
  assert.equal(records[3].replyContext.translatedContent, '父帖翻译');
  assert.equal(Object.hasOwn(records[3].replyContext, 'raw'), false);
  assert.deepEqual(Object.keys(records[4].quoteContext).sort(), [
    'author', 'content', 'externalId', 'publishedAt', 'translatedContent', 'url'
  ]);
  assert.deepEqual(Object.keys(records[4].quoteContext.author).sort(), [
    'avatarUrl', 'followersCount', 'handle', 'id', 'name'
  ]);
  assert.equal(records[4].quoteContext.content, 'Quoted text');
  assert.equal(records[4].quoteContext.translatedContent, '引用翻译');
  assert.equal(Object.hasOwn(records[5], 'target'), false);
  assert.equal(JSON.stringify(storage.value).includes('private-target-cookie'), false);
  assert.equal(JSON.stringify(storage.value).includes('private-target-authorization'), false);
  assert.equal(JSON.stringify(storage.value).includes('private-profile-cookie'), false);
  assert.equal(JSON.stringify(storage.value).includes('private-profile-before'), false);
  assert.equal(JSON.stringify(storage.value).includes('private-reply-target'), false);
  assert.equal(JSON.stringify(storage.value).includes('private-parent-cookie'), false);
  assert.equal(JSON.stringify(storage.value).includes('private-reply-raw'), false);
  assert.equal(JSON.stringify(storage.value).includes('private-quote-cookie'), false);
  assert.equal(JSON.stringify(storage.value).includes('private-quote-raw'), false);
  assert.equal(JSON.stringify(storage.value).includes('private-quote-author-cookie'), false);
  assert.equal(JSON.stringify(storage.value).includes('private-quote-author-raw'), false);
  assert.equal(storage.value.debotSocialPostOutboxV1.schemaVersion, 2);
});

test('outbox rejects incomplete relationship, profile and unknown activity', async () => {
  const storage = new FakeStorage();
  const outbox = createPostOutbox({ storage });
  const result = await outbox.enqueue([
    post('follow-missing-author', {
      kind: 'follow',
      author: { handle: '' },
      target: { handle: 'bob' }
    }),
    post('follow-missing-target', {
      kind: 'follow',
      target: { handle: '' }
    }),
    post('unfollow-invalid-target', {
      kind: 'unfollow',
      target: { handle: 'not-valid-handle-too-long' }
    }),
    post('profile-missing-author', {
      kind: 'profile',
      author: { handle: '' },
      profileChanges: ['name']
    }),
    post('profile-missing-change', {
      kind: 'profile',
      profileChanges: []
    }),
    post('unknown-kind', { kind: 'list_update' })
  ]);

  assert.deepEqual(
    { added: result.added, rejected: result.rejected, queued: result.queued },
    { added: 0, rejected: 6, queued: 0 }
  );
  assert.equal(storage.setCalls, 0);
});

test('outbox preserves separate occurrences of repeated relationship activity', async () => {
  const storage = new FakeStorage();
  const outbox = createPostOutbox({ storage });
  const relationship = post('follow:alice:bob', {
    kind: 'follow',
    target: { handle: 'bob' },
    publishedAt: 100,
    sourceUpdatedAt: 100
  });

  assert.equal((await outbox.enqueue(relationship)).added, 1);
  assert.equal((await outbox.enqueue({
    ...relationship,
    publishedAt: 200,
    sourceUpdatedAt: 200,
    receivedAt: 250
  })).added, 1);
  assert.equal((await outbox.enqueue({ ...relationship, receivedAt: 999 })).duplicates, 1);

  const records = (await outbox.readBatch()).records;
  assert.deepEqual(records.map(({ post: value }) => value.sourceUpdatedAt), [100, 200]);
  assert.equal(new Set(records.map(({ key }) => key)).size, 2);
});

test('outbox preserves accepted records and rejects new records when its record limit overflows', async () => {
  const storage = new FakeStorage();
  const outbox = createPostOutbox({ storage, maxRecords: 3 });
  const result = await outbox.enqueue(Array.from({ length: 7 }, (_, index) => post(`item-${index + 1}`)));

  assert.equal(result.added, 3);
  assert.equal(result.overflow, 4);
  assert.equal(result.queued, 3);
  assert.deepEqual(
    (await outbox.readBatch(10)).records.map(({ post: value }) => value.externalId),
    ['item-1', 'item-2', 'item-3']
  );

  const [oldest] = (await outbox.readBatch(1)).records;
  await outbox.acknowledge(oldest.key);
  const retried = await outbox.enqueue([
    post('item-4'),
    post('item-5')
  ]);
  assert.equal(retried.added, 1);
  assert.equal(retried.overflow, 1);
  assert.deepEqual(
    (await outbox.readBatch(10)).records.map(({ post: value }) => value.externalId),
    ['item-2', 'item-3', 'item-4']
  );
});

test('atomic enqueue preserves the existing queue and accepts the complete batch after capacity clears', async () => {
  const storage = new FakeStorage();
  const outbox = createPostOutbox({ storage, maxRecords: 3 });
  const existing = await outbox.enqueue([
    post('existing-1'),
    post('existing-2')
  ]);
  const existingBatch = await outbox.readBatch(10);
  const storedBeforeOverflow = structuredClone(storage.value);
  const setCallsBeforeOverflow = storage.setCalls;

  assert.equal(existing.added, 2);
  const overflowed = await outbox.enqueue([
    post('retry-1'),
    post('retry-2')
  ], { requireAll: true });

  assert.deepEqual(
    {
      added: overflowed.added,
      overflow: overflowed.overflow,
      queued: overflowed.queued,
      keys: overflowed.keys,
      atomic: overflowed.atomic
    },
    { added: 0, overflow: 2, queued: 2, keys: [], atomic: true }
  );
  assert.equal(storage.setCalls, setCallsBeforeOverflow);
  assert.deepEqual(storage.value, storedBeforeOverflow);
  assert.deepEqual(
    (await outbox.readBatch(10)).records.map(({ key, post: value }) => [key, value.externalId]),
    existingBatch.records.map(({ key, post: value }) => [key, value.externalId])
  );

  const cleared = await outbox.acknowledge(existingBatch.records.map(({ key }) => key));
  assert.deepEqual(
    { acknowledged: cleared.acknowledged, queued: cleared.queued },
    { acknowledged: 2, queued: 0 }
  );

  const retried = await outbox.enqueue([
    post('retry-1'),
    post('retry-2')
  ], { requireAll: true });
  assert.deepEqual(
    {
      added: retried.added,
      overflow: retried.overflow,
      queued: retried.queued,
      atomic: retried.atomic
    },
    { added: 2, overflow: 0, queued: 2, atomic: true }
  );
  assert.deepEqual(
    (await outbox.readBatch(10)).records.map(({ post: value }) => value.externalId),
    ['retry-1', 'retry-2']
  );
});

test('outbox stays below its byte budget without evicting an accepted record', async () => {
  const storage = new FakeStorage();
  const maxBytes = 1_600;
  const outbox = createPostOutbox({ storage, maxBytes });
  const values = Array.from({ length: 8 }, (_, index) => post(`large-${index + 1}`, {
    content: `${index + 1}:${'x'.repeat(500)}`
  }));
  const result = await outbox.enqueue(values);
  const batch = await outbox.readBatch(1_000);

  assert.ok(result.overflow > 0);
  assert.ok(result.queued > 0);
  assert.ok(result.bytes <= maxBytes);
  assert.equal((await outbox.stats()).bytes <= maxBytes, true);
  assert.equal(batch.records[0].post.externalId, 'large-1');
  assert.deepEqual(
    batch.records.map(({ post: value }) => Number(value.externalId.replace('large-', ''))),
    batch.records.map(({ post: value }) => Number(value.externalId.replace('large-', ''))).toSorted((a, b) => a - b)
  );
});

test('failed sends remain queued across reopen and acknowledgements remove exact keys only', async () => {
  const storage = new FakeStorage();
  const firstOutbox = createPostOutbox({ storage });
  await Promise.all([
    firstOutbox.enqueue(post('one')),
    firstOutbox.enqueue(post('two')),
    firstOutbox.enqueue(post('three'))
  ]);
  const attempted = await firstOutbox.readBatch(2);
  assert.equal(attempted.count, 2);
  assert.equal(attempted.remaining, 1);

  // A transport failure performs no acknowledgement. A new service-worker
  // instance must therefore find the exact same pending records.
  const reopened = createPostOutbox({ storage });
  const afterFailure = await reopened.readBatch(10);
  assert.deepEqual(
    afterFailure.records.map(({ key }) => key),
    (await firstOutbox.readBatch(10)).records.map(({ key }) => key)
  );

  const firstKey = attempted.records[0].key;
  const acknowledgement = await reopened.acknowledge([firstKey, 'not-a-real-record']);
  assert.equal(acknowledgement.acknowledged, 1);
  assert.equal(acknowledgement.queued, 2);
  assert.equal((await reopened.acknowledge(firstKey)).acknowledged, 0);

  const reopenedAgain = createPostOutbox({ storage });
  const remaining = await reopenedAgain.readBatch(10);
  assert.equal(remaining.queued, 2);
  assert.equal(remaining.records.some(({ key }) => key === firstKey), false);
});

test('outbox rejects incomplete posts and publishes conservative default limits', async () => {
  const storage = new FakeStorage();
  const outbox = createPostOutbox({ storage });
  const result = await outbox.enqueue([
    null,
    { source: 'debot' },
    { externalId: 'missing-source' },
    { source: 'debot', externalId: 'unknown', kind: 'unknown' },
    { source: 'debot', externalId: 'follow:alice:bob', kind: 'follow', author: { handle: 'alice' } },
    { source: 'debot', externalId: 'profile:alice:1', kind: 'profile', author: { handle: 'alice' } }
  ]);
  assert.equal(result.rejected, 6);
  assert.equal(result.queued, 0);
  assert.equal(storage.setCalls, 0);
  assert.deepEqual(POST_OUTBOX_LIMITS, {
    maxRecords: 1_000,
    maxBytes: 4 * 1024 * 1024,
    defaultBatchLimit: 200
  });
});
