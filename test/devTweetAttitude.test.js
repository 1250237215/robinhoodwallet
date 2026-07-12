import test from 'node:test';
import assert from 'node:assert/strict';

import {
  DeepSeekDevTweetAttitudeAnalyzer,
  parseXRecentPostsFromInitialStateHtml
} from '../src/devTweetAttitude.js';

test('parses recent tweets and replies from X initial state html', () => {
  const state = {
    entities: {
      users: {
        '1': {
          id_str: '1',
          screen_name: 'builder',
          name: 'Builder'
        }
      },
      tweets: {
        entities: {
          '2050000000000000002': {
            id_str: '2050000000000000002',
            user: '1',
            full_text: 'Noetic token fees are live, thanks for the support.',
            created_at: '2026-05-27T10:00:00.000Z'
          },
          '2050000000000000001': {
            id_str: '2050000000000000001',
            user: '1',
            full_text: '@alice yes I claimed the fee recipient.',
            created_at: '2026-05-27T09:00:00.000Z',
            in_reply_to_screen_name: 'alice'
          }
        }
      }
    }
  };
  const html = `<script>window.__INITIAL_STATE__=${JSON.stringify(state)};window.__META_DATA__={}</script>`;

  const posts = parseXRecentPostsFromInitialStateHtml(html, '@builder');

  assert.deepEqual(
    posts.map((item) => ({
      text: item.text,
      url: item.url,
      type: item.type
    })),
    [
      {
        text: 'Noetic token fees are live, thanks for the support.',
        url: 'https://x.com/builder/status/2050000000000000002',
        type: 'tweet'
      },
      {
        text: '@alice yes I claimed the fee recipient.',
        url: 'https://x.com/builder/status/2050000000000000001',
        type: 'reply'
      }
    ]
  );
});

test('DeepSeek dev tweet attitude analyzer returns bilingual items and support summary', async () => {
  const requests = [];
  const analyzer = new DeepSeekDevTweetAttitudeAnalyzer({
    apiKey: 'deepseek-key',
    model: 'deepseek-v4-flash',
    xPostFetcher: async () => [
      {
        text: 'I claimed fees for $AAA and will keep building.',
        url: 'https://x.com/builder/status/2050000000000000002',
        publishedAt: '2026-05-27T10:00:00.000Z',
        type: 'tweet'
      }
    ],
    fetchImpl: async (url, options) => {
      requests.push({ url, body: JSON.parse(options.body) });
      return {
        ok: true,
        async json() {
          return {
            choices: [
              {
                message: {
                  content: JSON.stringify({
                    summary: '明确支持：dev 已提到 claimed fees，并表示会继续 build。',
                    supportLevel: '明确支持',
                    items: [
                      {
                        textOriginal: 'I claimed fees for $AAA and will keep building.',
                        textZh: '我已经认领 $AAA 的手续费，并会继续建设。',
                        textEn: 'I claimed fees for $AAA and will keep building.',
                        url: 'https://x.com/builder/status/2050000000000000002',
                        publishedAt: '2026-05-27T10:00:00.000Z',
                        type: 'tweet'
                      }
                    ]
                  })
                }
              }
            ]
          };
        }
      };
    }
  });

  const result = await analyzer.analyze({
    row: { address: '0xabc', symbol: 'AAA', name: 'AAA' },
    dev: { publicHandle: '@builder' },
    sources: {}
  });

  assert.equal(requests.length, 1);
  assert.equal(requests[0].body.model, 'deepseek-v4-flash');
  assert.match(JSON.stringify(requests[0].body), /claimed fees/);
  assert.equal(result.handle, '@builder');
  assert.equal(result.supportLevel, '明确支持');
  assert.match(result.summary, /继续 build/);
  assert.deepEqual(result.items[0], {
    textOriginal: 'I claimed fees for $AAA and will keep building.',
    textZh: '我已经认领 $AAA 的手续费，并会继续建设。',
    textEn: 'I claimed fees for $AAA and will keep building.',
    url: 'https://x.com/builder/status/2050000000000000002',
    publishedAt: '2026-05-27T10:00:00.000Z',
    type: 'tweet'
  });
});

test('dev tweet attitude uses Grok/search posts before public X scraping', async () => {
  const calls = [];
  const searchPosts = Array.from({ length: 5 }, (_, index) => ({
    text: `Grok post ${index + 1} for $AAA`,
    url: `https://x.com/builder/status/20500000000000000${index}`,
    publishedAt: `2026-05-27T10:0${index}:00.000Z`,
    type: index % 2 ? 'reply' : 'tweet'
  }));
  const analyzer = new DeepSeekDevTweetAttitudeAnalyzer({
    apiKey: 'deepseek-key',
    model: 'deepseek-v4-flash',
    searchPostFetcher: async () => {
      calls.push('search');
      return searchPosts;
    },
    xPostFetcher: async () => {
      calls.push('public-x');
      return [];
    },
    fetchImpl: async (url, options) => {
      calls.push('deepseek');
      const body = JSON.parse(options.body);
      assert.deepEqual(
        body.messages[1].content.includes('Grok post 1 for $AAA'),
        true
      );
      return {
        ok: true,
        async json() {
          return {
            choices: [
              {
                message: {
                  content: JSON.stringify({
                    summary: '未确认：最近内容没有明确支持 token。',
                    supportLevel: '未确认',
                    items: searchPosts.map((item) => ({
                      textOriginal: item.text,
                      textZh: item.text,
                      textEn: item.text,
                      url: item.url
                    }))
                  })
                }
              }
            ]
          };
        }
      };
    }
  });

  const result = await analyzer.analyze({
    row: { address: '0xabc', symbol: 'AAA', name: 'AAA' },
    dev: { publicHandle: '@builder' },
    sources: {}
  });

  assert.deepEqual(calls, ['search', 'deepseek']);
  assert.equal(result.items.length, 5);
  assert.equal(result.items[0].textOriginal, 'Grok post 1 for $AAA');
});

test('dev tweet attitude keeps fetched posts when DeepSeek attitude formatting fails', async () => {
  const analyzer = new DeepSeekDevTweetAttitudeAnalyzer({
    apiKey: 'deepseek-key',
    model: 'deepseek-v4-flash',
    searchPostFetcher: async () => [
      {
        text: 'I am building with Bankr today.',
        url: 'https://x.com/builder/status/2050000000000000002',
        publishedAt: '2026-05-27T10:00:00.000Z',
        type: 'tweet'
      }
    ],
    xPostFetcher: async () => [],
    fetchImpl: async () => {
      throw new Error('fetch failed');
    }
  });

  const result = await analyzer.analyze({
    row: { address: '0xabc', symbol: 'AAA', name: 'AAA' },
    dev: { publicHandle: '@builder' },
    sources: {}
  });

  assert.equal(result.handle, '@builder');
  assert.equal(result.supportLevel, '待判断');
  assert.match(result.summary, /已抓到 dev 最近内容/);
  assert.match(result.summary, /整理失败/);
  assert.equal(result.items.length, 1);
  assert.equal(result.items[0].textOriginal, 'I am building with Bankr today.');
  assert.equal(result.items[0].textZh, 'I am building with Bankr today.');
  assert.equal(result.items[0].textEn, 'I am building with Bankr today.');
});
