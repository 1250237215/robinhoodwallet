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
    { externalId: 'missing-source' }
  ]);
  assert.equal(result.rejected, 3);
  assert.equal(result.queued, 0);
  assert.equal(storage.setCalls, 0);
  assert.deepEqual(POST_OUTBOX_LIMITS, {
    maxRecords: 1_000,
    maxBytes: 4 * 1024 * 1024,
    defaultBatchLimit: 200
  });
});
