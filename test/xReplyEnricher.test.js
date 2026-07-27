import test from 'node:test';
import assert from 'node:assert/strict';

import {
  createXReplyEnricher,
  fetchXQuoteContext,
  fetchXReplyContext,
  quoteContextNeedsEnrichment,
  replyContextNeedsEnrichment,
  translateXReplyToChinese
} from '../src/social/xReplyEnricher.js';

const REPLY_ID = '2081700497174733126';
const PARENT_ID = '2081696375595524505';
const QUOTE_ID = '2081749735858442749';
const QUOTED_ID = '2081481106281390183';

function conversationHtml() {
  return `<!doctype html><html><body>
    <article data-tweet-id="${PARENT_ID}">
      <meta content="2026-07-27T11:01:06.000Z" itemProp="datePublished" />
      <meta content="https://x.com/iruletrenches/status/${PARENT_ID}" itemProp="url" />
      <meta content="It's a dogs world" itemProp="articleBody" />
      <meta content="iruletrenches" itemProp="alternateName" />
    </article>
    <article data-tweet-id="${REPLY_ID}">
      <meta content="2026-07-27T11:17:29.000Z" itemProp="datePublished" />
      <meta content="https://x.com/Fixture_Cat/status/${REPLY_ID}" itemProp="url" />
      <meta content="You use cat as pfp" itemProp="articleBody" />
      <meta content="https://x.com/iruletrenches/status/${PARENT_ID}" itemProp="isPartOf" />
    </article>
  </body></html>`;
}

function replyPost() {
  return {
    source: 'twitter',
    externalId: REPLY_ID,
    kind: 'reply',
    author: { handle: 'Fixture_Cat' },
    content: 'You use cat as pfp',
    url: `https://x.com/Fixture_Cat/status/${REPLY_ID}`,
    replyToExternalId: 'iruletrenches',
    publishedAt: Date.parse('2026-07-27T11:17:29.000Z'),
    sourceUpdatedAt: Date.parse('2026-07-27T11:17:29.000Z')
  };
}

function quotePost(overrides = {}) {
  return {
    source: 'twitter',
    externalId: QUOTE_ID,
    kind: 'quote',
    author: { handle: 'radar_fixture' },
    content: '他天天',
    url: `https://x.com/radar_fixture/status/${QUOTE_ID}`,
    publishedAt: Date.parse('2026-07-27T14:33:08.000Z'),
    sourceUpdatedAt: Date.parse('2026-07-27T14:33:08.000Z'),
    ...overrides
  };
}

function fxTwitterQuotePayload(quoteId = QUOTED_ID) {
  return {
    tweet: {
      id: QUOTE_ID,
      quote: {
        id: quoteId,
        text: 'at the beginning of every bull run',
        url: `https://x.com/theunipcs/status/${quoteId}`,
        created_timestamp: 1_785_098_742,
        author: {
          id: '1755899659040555009',
          screen_name: 'theunipcs',
          name: "Unipcs (aka 'Bonk Guy')",
          avatar_url: 'https://pbs.twimg.com/profile_images/unipcs.jpg'
        }
      }
    }
  };
}

test('fetches a reply conversation without blocking the original event and returns parent text plus translation', async () => {
  const enriched = await fetchXReplyContext(replyPost(), {
    fetchImpl: async () => new Response(conversationHtml()),
    translateImpl: async (content) => content === "It's a dogs world" ? '这是狗狗的世界' : ''
  });
  assert.equal(enriched.externalId, REPLY_ID);
  assert.equal(enriched.replyToExternalId, PARENT_ID);
  assert.equal(enriched.target.handle, 'iruletrenches');
  assert.deepEqual(enriched.replyContext, {
    externalId: PARENT_ID,
    author: { id: '', handle: 'iruletrenches', name: '', avatarUrl: '' },
    content: "It's a dogs world",
    translatedContent: '这是狗狗的世界',
    url: `https://x.com/iruletrenches/status/${PARENT_ID}`,
    publishedAt: Date.parse('2026-07-27T11:01:06.000Z')
  });
});

test('reply enrichment queue deduplicates inflight work and skips already complete context', async () => {
  const updates = [];
  const enricher = createXReplyEnricher({
    fetchImpl: async () => new Response(conversationHtml()),
    translateImpl: async () => '这是狗狗的世界',
    onEnriched: (post) => updates.push(post)
  });
  assert.equal(enricher.enqueue([replyPost(), replyPost()]), 1);
  const complete = {
    ...replyPost(),
    replyToExternalId: PARENT_ID,
    replyContext: {
      externalId: PARENT_ID,
      author: { handle: 'iruletrenches' },
      content: 'already complete',
      translatedContent: '已经完整',
      url: `https://x.com/iruletrenches/status/${PARENT_ID}`
    }
  };
  assert.equal(replyContextNeedsEnrichment(complete), false);
  assert.equal(enricher.enqueue(complete), 0);
  await new Promise((resolve) => setTimeout(resolve, 20));
  assert.equal(updates.length, 1);
  assert.equal(updates[0].replyContext.externalId, PARENT_ID);
  enricher.close();
});

test('partial reply context is translated directly and temporary failures retry with the latest post', async () => {
  const updates = [];
  let translationAttempts = 0;
  const partial = {
    ...replyPost(),
    replyToExternalId: PARENT_ID,
    replyContext: {
      externalId: PARENT_ID,
      author: { handle: 'iruletrenches' },
      content: "It's a dogs world",
      url: `https://x.com/iruletrenches/status/${PARENT_ID}`,
      publishedAt: Date.parse('2026-07-27T11:01:06.000Z')
    }
  };
  const enricher = createXReplyEnricher({
    retryDelaysMs: [10],
    fetchImpl: async () => { throw new Error('not used for complete parent data'); },
    translateImpl: async () => {
      translationAttempts += 1;
      return translationAttempts === 1 ? '' : '这是狗狗的世界';
    },
    onEnriched: (post) => updates.push(post)
  });
  assert.equal(enricher.enqueue(partial), 1);
  for (let index = 0; index < 20 && updates.length < 2; index += 1) {
    await new Promise((resolve) => setTimeout(resolve, 10));
  }
  assert.equal(updates.length, 2);
  assert.equal(updates.at(-1).replyContext.translatedContent, '这是狗狗的世界');
  assert.equal(enricher.status.enriched, 1);
  enricher.close();
});

test('fetches the parent status separately when the reply page only identifies it', async () => {
  const replyOnly = conversationHtml().replace(
    /<article data-tweet-id="2081696375595524505">[\s\S]*?<\/article>/,
    ''
  );
  const parentOnly = conversationHtml().replace(
    /<article data-tweet-id="2081700497174733126">[\s\S]*?<\/article>/,
    ''
  );
  const urls = [];
  const enriched = await fetchXReplyContext({
    ...replyPost(),
    target: { handle: 'iruletrenches' }
  }, {
    fetchImpl: async (url) => {
      urls.push(String(url));
      return new Response(urls.length === 1 ? replyOnly : parentOnly);
    },
    translateImpl: async () => '这是狗狗的世界'
  });
  assert.equal(urls.length, 2);
  assert.match(urls[1], new RegExp(`${PARENT_ID}$`));
  assert.equal(enriched.replyContext.content, "It's a dogs world");
});

test('fetches and translates the quoted original without delaying the outer quote event', async () => {
  const requested = [];
  const enriched = await fetchXQuoteContext(quotePost(), {
    fetchImpl: async (url) => {
      requested.push(String(url));
      return new Response(JSON.stringify(fxTwitterQuotePayload()));
    },
    translateImpl: async () => '每轮牛市开始时'
  });
  assert.deepEqual(requested, [`https://api.fxtwitter.com/status/${QUOTE_ID}`]);
  assert.equal(enriched.quotedExternalId, QUOTED_ID);
  assert.deepEqual(enriched.quoteContext, {
    externalId: QUOTED_ID,
    author: {
      id: '1755899659040555009',
      handle: 'theunipcs',
      name: "Unipcs (aka 'Bonk Guy')",
      avatarUrl: 'https://pbs.twimg.com/profile_images/unipcs.jpg'
    },
    content: 'at the beginning of every bull run',
    translatedContent: '每轮牛市开始时',
    url: `https://x.com/theunipcs/status/${QUOTED_ID}`,
    publishedAt: 1_785_098_742_000
  });
  assert.equal(quoteContextNeedsEnrichment(enriched), false);
});

test('quote enrichment rejects a third-party quote identity that conflicts with a known quoted id', async () => {
  const enriched = await fetchXQuoteContext(quotePost({
    quotedExternalId: QUOTED_ID,
    quoteContext: { externalId: QUOTED_ID }
  }), {
    fetchImpl: async () => new Response(JSON.stringify(fxTwitterQuotePayload('2081481106281390999'))),
    translateImpl: async () => '不应使用'
  });
  assert.equal(enriched, null);
});

test('quote enrichment rejects missing quotes and responses for a different outer post', async () => {
  for (const tweet of [{ id: QUOTE_ID }, { id: '2081749735858442000', quote: fxTwitterQuotePayload().tweet.quote }]) {
    const enriched = await fetchXQuoteContext(quotePost(), {
      fetchImpl: async () => new Response(JSON.stringify({ tweet })),
      translateImpl: async () => '不应使用'
    });
    assert.equal(enriched, null);
  }
});

test('Google translation response is flattened and translation failures stay non-fatal', async () => {
  const translated = await translateXReplyToChinese('hello world', {
    fetchImpl: async () => new Response(JSON.stringify([
      [['你好', 'hello'], ['世界', ' world']]
    ]), { headers: { 'content-type': 'application/json' } })
  });
  assert.equal(translated, '你好世界');
  assert.equal(await translateXReplyToChinese('hello', {
    fetchImpl: async () => { throw new Error('offline'); }
  }), '');
});

test('reply HTML timeout bounds a response body that never finishes', async () => {
  const startedAt = Date.now();
  await assert.rejects(fetchXReplyContext(replyPost(), {
    timeoutMs: 20,
    fetchImpl: async () => ({
      ok: true,
      status: 200,
      headers: new Headers(),
      text: async () => new Promise(() => {})
    })
  }), /timed out|aborted/i);
  assert.ok(Date.now() - startedAt < 500);
});
