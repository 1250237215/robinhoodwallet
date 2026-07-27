import test from 'node:test';
import assert from 'node:assert/strict';

import {
  createXProfileMonitor,
  parseLatestXProfilePost,
  parseXProfileArticles,
  parseXProfileHtml,
  XProfileMonitor
} from '../src/social/xProfileMonitor.js';

function article({
  handle = 'alice',
  id,
  date,
  body,
  authorName = 'Alice',
  structured = false
}) {
  if (structured) {
    return `<article data-testid="tweet">
      <script type="application/ld+json">${JSON.stringify({
        '@type': 'SocialMediaPosting',
        datePublished: date,
        articleBody: body,
        author: { name: authorName, alternateName: `@${handle}` },
        url: `https://x.com/${handle}/status/${id}`
      })}</script>
    </article>`;
  }
  return `<article data-testid="tweet" data-screen-name="${handle}">
    <a href="/${handle}/status/${id}"><time itemprop="datePublished" datetime="${date}">${date}</time></a>
    <div data-testid="User-Name">${authorName}</div>
    <div itemprop="articleBody" data-testid="tweetText">${body}</div>
  </article>`;
}

function html(...articles) {
  return `<!doctype html><html><body>${articles.join('\n')}</body></html>`;
}

function response(body, { status = 200, headers = {} } = {}) {
  return new Response(body, { status, headers });
}

test('parses every article and chooses the newest valid datePublished rather than DOM order', () => {
  const source = html(
    article({
      id: '2080000000000000001',
      date: '2026-07-27T09:00:00.000Z',
      body: 'older &amp; first'
    }),
    '<article><div>promoted content without a status or date</div></article>',
    article({
      handle: 'bob',
      id: '2080000000000000003',
      date: '2026-07-27T09:02:00.000Z',
      body: 'newest <strong>structured</strong>',
      authorName: 'Bob',
      structured: true
    }),
    article({
      id: '2080000000000000002',
      date: '2026-07-27T09:01:00.000Z',
      body: 'middle<br>line two'
    })
  );

  const posts = parseXProfileArticles(source, { requestedHandle: 'alice' });
  assert.deepEqual(posts.map((post) => post.tweetId), [
    '2080000000000000003',
    '2080000000000000002',
    '2080000000000000001'
  ]);
  assert.equal(posts[1].body, 'middle\nline two');
  assert.equal(posts[2].body, 'older & first');

  const latest = parseLatestXProfilePost(source, { requestedHandle: 'alice' });
  assert.deepEqual(latest, {
    source: 'twitter',
    kind: 'post',
    externalId: '2080000000000000003',
    tweetId: '2080000000000000003',
    body: 'newest structured',
    content: 'newest structured',
    publishedAt: Date.parse('2026-07-27T09:02:00.000Z'),
    datePublished: '2026-07-27T09:02:00.000Z',
    author: { handle: 'bob', name: 'Bob' },
    url: 'https://x.com/bob/status/2080000000000000003',
    isPartOf: null,
    replyParentUrl: '',
    replyToExternalId: '',
    articleIndex: 2
  });
});

test('parseXProfileHtml preserves JSON-LD reply context and canonical parent identity', () => {
  const parentUrl = 'https://twitter.com/parent_user/status/2080000000000000300?ref=profile';
  const isPartOf = {
    '@type': 'Conversation',
    url: parentUrl
  };
  const source = html(`<article data-testid="tweet">
    <script type="application/ld+json">${JSON.stringify({
      '@type': 'SocialMediaPosting',
      datePublished: '2026-07-27T10:30:00.000Z',
      articleBody: 'This is a reply',
      author: { name: 'Alice', alternateName: '@alice' },
      url: 'https://x.com/alice/status/2080000000000000301',
      isPartOf,
      inReplyTo: { '@id': parentUrl }
    })}</script>
  </article>`);

  const [post] = parseXProfileHtml(source, { requestedHandle: 'alice' });
  assert.equal(post.externalId, '2080000000000000301');
  assert.deepEqual(post.author, { handle: 'alice', name: 'Alice' });
  assert.equal(post.content, 'This is a reply');
  assert.equal(post.url, 'https://x.com/alice/status/2080000000000000301');
  assert.equal(post.publishedAt, Date.parse('2026-07-27T10:30:00.000Z'));
  assert.deepEqual(post.isPartOf, isPartOf);
  assert.equal(post.kind, 'reply');
  assert.equal(post.replyParentUrl, 'https://x.com/parent_user/status/2080000000000000300');
  assert.equal(post.replyToExternalId, '2080000000000000300');
});

test('extracts explicitly marked HTML reply parents without mistaking quoted status links for parents', () => {
  const reply = `<article data-testid="tweet" data-screen-name="alice" data-tweet-id="2080000000000000401">
    <a rel="in-reply-to" href="/parent/status/2080000000000000400">Replying to @parent</a>
    <a href="/quoted/status/2080000000000000399">quoted post</a>
    <a href="/alice/status/2080000000000000401">
      <time datetime="2026-07-27T10:40:00.000Z"></time>
    </a>
    <link itemprop="isPartOf" href="https://x.com/parent/status/2080000000000000400">
    <div data-testid="tweetText">HTML reply</div>
  </article>`;
  const standalone = `<article data-testid="tweet" data-screen-name="alice" data-tweet-id="2080000000000000402">
    <a href="/quoted/status/2080000000000000399">quoted post</a>
    <a href="/alice/status/2080000000000000402">
      <time datetime="2026-07-27T10:41:00.000Z"></time>
    </a>
    <div data-testid="tweetText">Standalone with a quote link</div>
  </article>`;

  const posts = parseXProfileHtml(html(reply, standalone), { requestedHandle: 'alice' });
  const replyPost = posts.find((post) => post.externalId === '2080000000000000401');
  assert.equal(replyPost.kind, 'reply');
  assert.equal(replyPost.isPartOf, 'https://x.com/parent/status/2080000000000000400');
  assert.equal(replyPost.replyParentUrl, 'https://x.com/parent/status/2080000000000000400');
  assert.equal(replyPost.replyToExternalId, '2080000000000000400');

  const standalonePost = posts.find((post) => post.externalId === '2080000000000000402');
  assert.equal(standalonePost.url, 'https://x.com/alice/status/2080000000000000402');
  assert.equal(standalonePost.kind, 'post');
  assert.equal(standalonePost.replyParentUrl, '');
  assert.equal(standalonePost.replyToExternalId, '');
});

test('keeps reply metadata when duplicate article copies are merged', () => {
  const id = '2080000000000000501';
  const date = '2026-07-27T10:50:00.000Z';
  const withReply = `<article data-screen-name="alice" data-tweet-id="${id}">
    <a rel="in-reply-to" href="/parent/status/2080000000000000500">parent</a>
    <a href="/alice/status/${id}"><time datetime="${date}"></time></a>
    <div data-testid="tweetText">short</div>
  </article>`;
  const richerCopy = article({ id, date, body: 'a richer reply body' });
  const [post] = parseXProfileHtml(html(withReply, richerCopy), { requestedHandle: 'alice' });
  assert.equal(post.content, 'a richer reply body');
  assert.equal(post.kind, 'reply');
  assert.equal(post.replyParentUrl, 'https://x.com/parent/status/2080000000000000500');
  assert.equal(post.replyToExternalId, '2080000000000000500');
});

test('deduplicates repeated article copies and falls back to the requested profile author', () => {
  const repeated = article({
    id: '2080000000000000010',
    date: '2026-07-27T09:10:00.000Z',
    body: 'short'
  }).replace(' data-screen-name="alice"', '').replace('/alice/status/', '/i/status/');
  const richer = repeated.replace('short', 'a richer body');
  const posts = parseXProfileArticles(html(repeated, richer), { requestedHandle: '@Alice' });
  assert.equal(posts.length, 1);
  assert.equal(posts[0].author.handle, 'alice');
  assert.equal(posts[0].body, 'a richer body');
});

test('polls accounts with bounded concurrency, preserves order, and emits each latest tweet once', async () => {
  const active = new Set();
  let maximumActive = 0;
  const resolvers = [];
  const fetchImpl = (url) => new Promise((resolve) => {
    const handle = new URL(url).pathname.slice(1);
    active.add(handle);
    maximumActive = Math.max(maximumActive, active.size);
    resolvers.push(() => {
      active.delete(handle);
      resolve(response(html(article({
        handle,
        id: `20800000000000000${handle.charCodeAt(0)}`,
        date: '2026-07-27T10:00:00.000Z',
        body: `${handle} post`
      }))));
    });
  });
  const monitor = createXProfileMonitor({
    accounts: ['alice', 'bob', 'carol'],
    concurrency: 2,
    fetchImpl
  });

  const firstPoll = monitor.pollOnce();
  await new Promise((resolve) => setImmediate(resolve));
  assert.equal(active.size, 2);
  resolvers.shift()();
  await new Promise((resolve) => setImmediate(resolve));
  assert.equal(active.size, 2);
  while (resolvers.length) {
    resolvers.shift()();
    await new Promise((resolve) => setImmediate(resolve));
  }
  const first = await firstPoll;
  assert.equal(maximumActive, 2);
  assert.deepEqual(first.results.map((result) => result.handle), ['alice', 'bob', 'carol']);
  assert.deepEqual(first.results.map((result) => result.status), ['new', 'new', 'new']);
  assert.equal(first.posts.length, 3);
  for (const result of first.results) {
    monitor.confirm(result.handle, result.posts.map((post) => post.tweetId));
  }

  const secondPoll = monitor.pollOnce();
  await new Promise((resolve) => setImmediate(resolve));
  while (resolvers.length) {
    resolvers.shift()();
    await new Promise((resolve) => setImmediate(resolve));
  }
  const second = await secondPoll;
  assert.deepEqual(second.results.map((result) => result.status), ['duplicate', 'duplicate', 'duplicate']);
  assert.deepEqual(second.posts, []);
});

test('does not overlap the same handle and delivers a completed account before the batch finishes', async () => {
  const resolvers = new Map();
  const calls = new Map();
  const fetchImpl = (url) => new Promise((resolve) => {
    const handle = new URL(url).pathname.slice(1);
    calls.set(handle, (calls.get(handle) || 0) + 1);
    resolvers.set(handle, () => resolve(response(html(article({
      handle,
      id: handle === 'fast' ? '2080000000000000601' : '2080000000000000602',
      date: '2026-07-27T11:00:00.000Z',
      body: `${handle} post`
    })))));
  });
  const delivered = [];
  let batchFinished = false;
  const monitor = new XProfileMonitor({ fetchImpl, concurrency: 2 });
  const firstPoll = monitor.pollOnce(['fast', 'slow'], {
    onResult: (result) => delivered.push(result.handle)
  }).finally(() => {
    batchFinished = true;
  });
  await new Promise((resolve) => setImmediate(resolve));

  const overlap = await monitor.pollOnce(['fast', 'slow']);
  assert.deepEqual(overlap.results.map((result) => result.status), ['inflight', 'inflight']);
  assert.deepEqual([...calls.entries()], [['fast', 1], ['slow', 1]]);

  resolvers.get('fast')();
  await new Promise((resolve) => setImmediate(resolve));
  assert.deepEqual(delivered, ['fast']);
  assert.equal(batchFinished, false);

  resolvers.get('slow')();
  await firstPoll;
  assert.deepEqual(delivered, ['fast', 'slow']);
  assert.equal(batchFinished, true);
});

test('keeps request concurrency bounded across overlapping poll cycles', async () => {
  const pending = new Map();
  const calls = new Map();
  let active = 0;
  let maximumActive = 0;
  const fetchImpl = (url) => new Promise((resolve) => {
    const handle = new URL(url).pathname.slice(1);
    calls.set(handle, (calls.get(handle) || 0) + 1);
    active += 1;
    maximumActive = Math.max(maximumActive, active);
    const releases = pending.get(handle) || [];
    releases.push(() => {
      active -= 1;
      resolve(response(html(article({
        handle,
        id: `20800000000000008${handle.charCodeAt(0)}`,
        date: '2026-07-27T11:10:00.000Z',
        body: `${handle} post`
      }))));
    });
    pending.set(handle, releases);
  });
  const release = (handle) => pending.get(handle).shift()();
  const monitor = new XProfileMonitor({ fetchImpl, concurrency: 2 });

  const firstPoll = monitor.pollOnce(['alpha', 'bravo', 'charlie'], {
    onResult: (result) => monitor.confirm(result.handle, result.posts.map((post) => post.tweetId))
  });
  await new Promise((resolve) => setImmediate(resolve));
  assert.equal(active, 2);
  release('alpha');
  await new Promise((resolve) => setImmediate(resolve));
  assert.equal(calls.get('charlie'), 1);
  assert.equal(active, 2);

  const overlappingPoll = monitor.pollOnce(['alpha']);
  await new Promise((resolve) => setImmediate(resolve));
  assert.equal(calls.get('alpha'), 1);
  assert.equal(active, 2);

  release('bravo');
  await new Promise((resolve) => setImmediate(resolve));
  assert.equal(calls.get('alpha'), 2);
  assert.equal(active, 2);
  assert.equal(maximumActive, 2);

  release('charlie');
  release('alpha');
  await Promise.all([firstPoll, overlappingPoll]);
  assert.equal(maximumActive, 2);
});

test('returns every unconfirmed profile post and retries until the caller confirms persistence', async () => {
  const source = html(
    article({ id: '2080000000000000703', date: '2026-07-27T11:03:00.000Z', body: 'newest' }),
    article({ id: '2080000000000000701', date: '2026-07-27T11:01:00.000Z', body: 'oldest' }),
    article({ id: '2080000000000000702', date: '2026-07-27T11:02:00.000Z', body: 'middle' })
  );
  let fetches = 0;
  const monitor = new XProfileMonitor({
    fetchImpl: async () => {
      fetches += 1;
      return response(source);
    }
  });

  const first = await monitor.pollOnce(['alice']);
  assert.deepEqual(first.posts.map((post) => post.externalId), [
    '2080000000000000703',
    '2080000000000000702',
    '2080000000000000701'
  ]);
  const unconfirmedRetry = await monitor.pollOnce(['alice']);
  assert.deepEqual(unconfirmedRetry.posts.map((post) => post.externalId), first.posts.map((post) => post.externalId));
  assert.equal(unconfirmedRetry.results[0].requestMade, false);
  assert.equal(fetches, 1);

  monitor.confirm('alice', ['2080000000000000703', '2080000000000000702']);
  const partialRetry = await monitor.pollOnce(['alice']);
  assert.deepEqual(partialRetry.posts.map((post) => post.externalId), ['2080000000000000701']);
  assert.equal(fetches, 1);
  monitor.confirm('alice', '2080000000000000701');
  assert.equal((await monitor.pollOnce(['alice'])).results[0].status, 'duplicate');
  assert.equal(fetches, 2);
});

test('applies per-account exponential backoff for 403 and 429 without blocking healthy accounts', async () => {
  let now = 1_000;
  const calls = new Map();
  const fetchImpl = async (url) => {
    const handle = new URL(url).pathname.slice(1);
    calls.set(handle, (calls.get(handle) || 0) + 1);
    if (handle === 'blocked') {
      const attempt = calls.get(handle);
      if (attempt === 1) return response('', { status: 403 });
      if (attempt === 2) return response('', { status: 429 });
    }
    return response(html(article({
      handle,
      id: handle === 'blocked' ? '2080000000000000200' : '2080000000000000201',
      date: '2026-07-27T10:20:00.000Z',
      body: `${handle} post`
    })));
  };
  const monitor = new XProfileMonitor({
    fetchImpl,
    now: () => now,
    backoffBaseMs: 2_000,
    backoffMaxMs: 10_000
  });

  const first = await monitor.pollOnce(['blocked', 'healthy']);
  assert.equal(first.results[0].error.code, 'HTTP_403');
  assert.equal(first.results[0].retryAt, 3_000);
  assert.equal(first.results[1].status, 'new');
  monitor.confirm('healthy', first.results[1].posts.map((post) => post.tweetId));

  now = 2_999;
  const skipped = await monitor.pollOnce(['blocked', 'healthy']);
  assert.equal(skipped.results[0].status, 'backoff');
  assert.equal(calls.get('blocked'), 1);
  assert.equal(skipped.results[1].status, 'duplicate');

  now = 3_000;
  const secondFailure = await monitor.pollOnce(['blocked']);
  assert.equal(secondFailure.results[0].error.code, 'HTTP_429');
  assert.equal(secondFailure.results[0].consecutiveFailures, 2);
  assert.equal(secondFailure.results[0].retryAt, 7_000);

  now = 7_000;
  const recovered = await monitor.pollOnce(['blocked']);
  assert.equal(recovered.results[0].status, 'new');
  assert.equal(monitor.accountState('blocked').consecutiveFailures, 0);
  assert.equal(monitor.accountState('blocked').nextAttemptAt, 0);
});

test('times out an unresponsive profile and exponentially backs off subsequent timeouts', async () => {
  let now = 5_000;
  let calls = 0;
  const monitor = new XProfileMonitor({
    timeoutMs: 20,
    backoffBaseMs: 100,
    backoffMaxMs: 1_000,
    now: () => now,
    fetchImpl: async (url, options) => {
      calls += 1;
      return new Promise((resolve, reject) => {
        options.signal.addEventListener('abort', () => reject(options.signal.reason), { once: true });
      });
    }
  });

  const first = await monitor.pollOnce(['slow']);
  assert.equal(first.results[0].error.code, 'TIMEOUT');
  assert.equal(first.results[0].retryAt, 5_100);
  now = 5_099;
  assert.equal((await monitor.pollOnce(['slow'])).results[0].status, 'backoff');
  assert.equal(calls, 1);

  now = 5_100;
  const second = await monitor.pollOnce(['slow']);
  assert.equal(second.results[0].error.code, 'TIMEOUT');
  assert.equal(second.results[0].retryAt, 5_300);
  assert.equal(calls, 2);
});

test('request timeout also bounds an HTML response body that never completes', async () => {
  const monitor = new XProfileMonitor({
    timeoutMs: 20,
    backoffBaseMs: 100,
    fetchImpl: async () => ({
      ok: true,
      status: 200,
      headers: new Headers(),
      text: async () => new Promise(() => {})
    })
  });

  const startedAt = Date.now();
  const result = await monitor.pollOnce(['slow_body']);
  assert.equal(result.results[0].status, 'error');
  assert.equal(result.results[0].error.code, 'TIMEOUT');
  assert.ok(Date.now() - startedAt < 500);
});

test('honors Retry-After, backs off empty HTTP 200 profiles, validates handles, and propagates caller aborts', async () => {
  let now = 10_000;
  let mode = 'rate-limit';
  const monitor = new XProfileMonitor({
    now: () => now,
    backoffBaseMs: 100,
    backoffMaxMs: 10_000,
    fetchImpl: async () => {
      if (mode === 'rate-limit') return response('', { status: 429, headers: { 'retry-after': '3' } });
      return response('<html><body>No server-rendered articles</body></html>');
    }
  });
  const limited = await monitor.pollOnce(['alice']);
  assert.equal(limited.results[0].retryAt, 13_000);
  now = 13_000;
  mode = 'empty';
  const empty = await monitor.pollOnce(['alice']);
  assert.equal(empty.results[0].status, 'empty');
  assert.equal(empty.results[0].retryAt, 13_200);
  now = 13_199;
  assert.equal((await monitor.pollOnce(['alice'])).results[0].status, 'backoff');
  assert.throws(() => monitor.setAccounts(['not-valid!']), /Invalid X handle/);

  const controller = new AbortController();
  controller.abort(new Error('caller stopped'));
  await assert.rejects(monitor.pollOnce(['alice'], { signal: controller.signal }), /caller stopped/);
});
