import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

import {
  createDeepSeekSocialTranslator,
  shouldTranslateSocialText
} from '../src/social/deepseekTranslator.js';
import { createSocialConfig } from '../src/social/config.js';
import { createSocialService } from '../src/social/service.js';
import { createXReplyEnricher } from '../src/social/xReplyEnricher.js';

async function eventually(assertion, timeoutMs = 1_000) {
  const deadline = Date.now() + timeoutMs;
  let lastError;
  while (Date.now() < deadline) {
    try {
      assertion();
      return;
    } catch (error) {
      lastError = error;
      await new Promise((resolve) => setTimeout(resolve, 5));
    }
  }
  throw lastError;
}

function deepSeekResponse(content) {
  return new Response(JSON.stringify({ choices: [{ message: { content } }] }), {
    status: 200,
    headers: { 'content-type': 'application/json' }
  });
}

test('social translation uses only the dedicated DeepSeek key and the chat model by default', () => {
  assert.equal(createSocialConfig({ DEEPSEEK_API_KEY: 'unrelated-key' }).translationApiKey, '');
  assert.equal(createSocialConfig({}).translationTimeoutMs, 8_000);
  const config = createSocialConfig({
    DEEPSEEK_TRANSLATION_API_KEY: ' dedicated-key ',
    DEEPSEEK_TRANSLATION_TIMEOUT_MS: '10',
    DEEPSEEK_TRANSLATION_CONCURRENCY: '99'
  });
  assert.equal(config.translationApiKey, 'dedicated-key');
  assert.equal(config.translationModel, 'deepseek-chat');
  assert.equal(config.translationTimeoutMs, 500);
  assert.equal(config.translationConcurrency, 8);
});

test('DeepSeek social translator sends raw text to the chat model with natural-chat guidance', async (t) => {
  const requests = [];
  const translator = createDeepSeekSocialTranslator({
    apiKey: 'translation-test-key',
    maxAttempts: 1,
    fetchImpl: async (url, options) => {
      requests.push({ url: String(url), options, body: JSON.parse(options.body) });
      return deepSeekResponse('你会说英语吗？');
    }
  });
  t.after(() => translator.close());

  assert.equal(await translator.translate('u can speak English'), '你会说英语吗？');
  assert.equal(requests.length, 1);
  assert.equal(requests[0].url, 'https://api.deepseek.com/chat/completions');
  assert.equal(requests[0].body.model, 'deepseek-chat');
  assert.deepEqual(requests[0].body.thinking, { type: 'disabled' });
  assert.equal(requests[0].body.temperature, 0);
  assert.equal(requests[0].body.max_tokens, 4_096);
  assert.equal(requests[0].body.messages[1].content, 'u can speak English');
  assert.match(requests[0].body.messages[0].content, /u can speak English/);
  assert.match(requests[0].body.messages[0].content, /你会说英语吗/);
  assert.equal(requests[0].options.headers.authorization, 'Bearer translation-test-key');

  assert.equal(await translator.translate('u can speak English'), '你会说英语吗？');
  assert.equal(requests.length, 1, 'only a successful result may be served from cache');
});

test('translation eligibility skips Chinese, media placeholders, addresses, links and emoji-only messages', () => {
  assert.equal(shouldTranslateSocialText('hello trader'), true);
  assert.equal(shouldTranslateSocialText('你好 hello'), true);
  assert.equal(shouldTranslateSocialText('中文ab'), false);
  assert.equal(shouldTranslateSocialText('主要内容已经是中文，只夹一个 bullish'), false);
  assert.equal(shouldTranslateSocialText('你好 this sentence is mostly English'), true);
  assert.equal(shouldTranslateSocialText(
    '这是中文主体 @an_extremely_long_foreign_handle $VERYLONGTOKEN #foreignhashtag '
      + 'https://example.com/a-very-long-english-path '
      + '0x1111111111111111111111111111111111111111',
  ), false);
  assert.equal(shouldTranslateSocialText('你好，今天怎么样？'), false);
  assert.equal(shouldTranslateSocialText('[图片]'), false);
  assert.equal(shouldTranslateSocialText('0x1111111111111111111111111111111111111111'), false);
  assert.equal(shouldTranslateSocialText('https://example.com/token'), false);
  assert.equal(shouldTranslateSocialText('🚀🚀 123'), false);
  assert.equal(shouldTranslateSocialText('Μιλάς αγγλικά;'), true);
  assert.equal(shouldTranslateSocialText('Դու խոսո՞ւմ ես անգլերեն։'), true);
  assert.equal(shouldTranslateSocialText('ინგლისურად ლაპარაკობ?'), true);
  assert.equal(shouldTranslateSocialText('a'.repeat(30_001)), false);
});

test('Chinese-majority text bypasses both DeepSeek and the persistent translation cache', async (t) => {
  let requests = 0;
  let cacheReads = 0;
  const translator = createDeepSeekSocialTranslator({
    apiKey: 'translation-test-key',
    readCache: () => {
      cacheReads += 1;
      return '不应读取的历史译文';
    },
    fetchImpl: async () => {
      requests += 1;
      return deepSeekResponse('不应请求的新译文');
    }
  });
  t.after(() => translator.close());

  assert.equal(await translator.translate('主要内容已经是中文，只夹一个 bullish'), '');
  assert.equal(cacheReads, 0);
  assert.equal(requests, 0);
});

test('X Premium long posts above twenty thousand characters are translated in bounded chunks', async (t) => {
  const requested = [];
  const translator = createDeepSeekSocialTranslator({
    apiKey: 'translation-test-key',
    maxAttempts: 1,
    fetchImpl: async (url, options) => {
      const source = JSON.parse(options.body).messages[1].content;
      requested.push(source);
      return deepSeekResponse(`中文片段 ${requested.length}`);
    }
  });
  t.after(() => translator.close());

  const source = `${'alpha '.repeat(2_200)}\n${'beta '.repeat(2_200)}`;
  assert.ok(source.length > 20_000);
  const translated = await translator.translate(source);
  assert.equal(translated.split('\n\n').length, requested.length);
  assert.ok(requested.length >= 5);
  assert.equal(requested.join('').replace(/\s/g, ''), source.replace(/\s/g, ''));
  assert.ok(requested.every((chunk) => chunk.length <= 4_500));
});

test('failed translations are retried only within the configured bound and are never cached', async (t) => {
  let requests = 0;
  const translator = createDeepSeekSocialTranslator({
    apiKey: 'translation-test-key',
    maxAttempts: 2,
    retryDelayMs: 0,
    fetchImpl: async () => {
      requests += 1;
      return new Response('temporary failure', { status: 503 });
    }
  });
  t.after(() => translator.close());

  assert.equal(await translator.translate('first attempt fails'), '');
  assert.equal(requests, 2);
  assert.equal(await translator.translate('first attempt fails'), '');
  assert.equal(requests, 4, 'an empty failure must not enter the success cache');
});

test('queued translation reports a terminal failure for service-level recovery', async (t) => {
  let failures = 0;
  const translator = createDeepSeekSocialTranslator({
    apiKey: 'translation-test-key',
    maxAttempts: 1,
    fetchImpl: async () => new Response('temporary failure', { status: 503 })
  });
  t.after(() => translator.close());

  assert.equal(translator.enqueue('translate this FOMO thesis', {
    onTranslated: () => assert.fail('failed translation must not publish text'),
    onFailed: () => { failures += 1; }
  }), true);
  await eventually(() => assert.equal(failures, 1));
});

test('bounded translation queue runs realtime work ahead of queued history', async (t) => {
  const requested = [];
  const releases = [];
  const translator = createDeepSeekSocialTranslator({
    apiKey: 'translation-test-key',
    concurrency: 1,
    maxAttempts: 1,
    fetchImpl: async (url, options) => {
      const source = JSON.parse(options.body).messages[1].content;
      requested.push(source);
      return new Promise((resolve) => releases.push(() => resolve(deepSeekResponse(`中文：${source}`))));
    }
  });
  t.after(() => translator.close());

  const first = translator.translate('history one', { priority: 'background' });
  await eventually(() => assert.deepEqual(requested, ['history one']));
  const second = translator.translate('history two', { priority: 'background' });
  const live = translator.translate('live alert', { priority: 'realtime' });

  releases.shift()();
  await eventually(() => assert.deepEqual(requested, ['history one', 'live alert']));
  releases.shift()();
  await eventually(() => assert.deepEqual(requested, ['history one', 'live alert', 'history two']));
  releases.shift()();

  assert.equal(await first, '中文：history one');
  assert.equal(await live, '中文：live alert');
  assert.equal(await second, '中文：history two');
});

test('background translation leaves a concurrency slot immediately available for realtime work', async (t) => {
  const requested = [];
  const releases = new Map();
  const translator = createDeepSeekSocialTranslator({
    apiKey: 'translation-test-key',
    concurrency: 2,
    maxAttempts: 1,
    fetchImpl: async (url, options) => {
      const source = JSON.parse(options.body).messages[1].content;
      requested.push(source);
      return new Promise((resolve) => {
        releases.set(source, () => resolve(deepSeekResponse(`中文：${source}`)));
      });
    }
  });
  t.after(() => translator.close());

  const first = translator.translate('history reserved one', { priority: 'background' });
  await eventually(() => assert.deepEqual(requested, ['history reserved one']));
  const second = translator.translate('history reserved two', { priority: 'background' });
  await new Promise((resolve) => setTimeout(resolve, 10));
  assert.deepEqual(requested, ['history reserved one']);

  const live = translator.translate('live reserved alert', { priority: 'realtime' });
  await eventually(() => assert.deepEqual(requested, [
    'history reserved one',
    'live reserved alert'
  ]));
  assert.equal(translator.status.active, 2);
  assert.equal(translator.status.activeRealtime, 1);
  assert.equal(translator.status.activeBackground, 1);
  assert.equal(translator.status.queued, 1);

  releases.get('history reserved one')();
  await eventually(() => assert.deepEqual(requested, [
    'history reserved one',
    'live reserved alert',
    'history reserved two'
  ]));
  releases.get('live reserved alert')();
  releases.get('history reserved two')();

  assert.equal(await first, '中文：history reserved one');
  assert.equal(await live, '中文：live reserved alert');
  assert.equal(await second, '中文：history reserved two');
});

test('a provider that ignores abort still cannot occupy the translation worker forever', async (t) => {
  const requested = [];
  const translator = createDeepSeekSocialTranslator({
    apiKey: 'translation-test-key',
    concurrency: 1,
    timeoutMs: 500,
    maxAttempts: 1,
    fetchImpl: async (url, options) => {
      const source = JSON.parse(options.body).messages[1].content;
      requested.push(source);
      if (source === 'stuck history') return new Promise(() => {});
      return deepSeekResponse(`中文：${source}`);
    }
  });
  t.after(() => translator.close());

  const stuck = translator.translate('stuck history', { priority: 'background' });
  await eventually(() => assert.deepEqual(requested, ['stuck history']));
  const live = translator.translate('live after stuck request');
  await eventually(() => assert.deepEqual(requested, ['stuck history', 'live after stuck request']), 3_000);
  assert.equal(await live, '中文：live after stuck request');
  assert.equal(await stuck, '');
  assert.equal(translator.status.active, 0);
  assert.equal(translator.status.queued, 0);
});

test('single-slot translation eventually runs background work during a sustained realtime burst', async (t) => {
  const requested = [];
  const releases = [];
  const translator = createDeepSeekSocialTranslator({
    apiKey: 'translation-test-key',
    concurrency: 1,
    maxAttempts: 1,
    fetchImpl: async (url, options) => {
      const source = JSON.parse(options.body).messages[1].content;
      requested.push(source);
      return new Promise((resolve) => releases.push(() => resolve(deepSeekResponse(`中文：${source}`))));
    }
  });
  t.after(() => translator.close());

  const first = translator.translate('live burst zero');
  await eventually(() => assert.equal(requested.length, 1));
  const background = translator.translate('history burst item', { priority: 'background' });
  const realtime = Array.from({ length: 12 }, (_, index) => (
    translator.translate(`live burst ${index + 1}`)
  ));

  for (let index = 0; index < 9; index += 1) {
    releases.shift()();
    await eventually(() => assert.equal(requested.length, index + 2));
  }
  assert.equal(requested[9], 'history burst item');

  while (releases.length || requested.length < 14) {
    if (releases.length) releases.shift()();
    await new Promise((resolve) => setTimeout(resolve, 0));
  }
  await Promise.all([first, background, ...realtime]);
});

test('X context enrichment publishes the fetched original before waiting for DeepSeek', async (t) => {
  const updates = [];
  let releaseTranslation;
  const externalId = '2081700497174734888';
  const parentId = '2081696375595524888';
  const enricher = createXReplyEnricher({
    emitOriginalFirst: true,
    translationRequired: true,
    translateImpl: async () => new Promise((resolve) => { releaseTranslation = resolve; }),
    onEnriched: (post) => updates.push(post)
  });
  t.after(() => enricher.close());

  enricher.enqueue({
    source: 'twitter',
    externalId,
    kind: 'reply',
    author: { handle: 'fixture_cat' },
    content: 'reply body',
    url: `https://x.com/fixture_cat/status/${externalId}`,
    replyToExternalId: parentId,
    replyContext: {
      externalId: parentId,
      author: { handle: 'parent_user' },
      content: 'parent says hello',
      url: `https://x.com/parent_user/status/${parentId}`
    }
  });

  await eventually(() => assert.equal(updates.length, 1));
  assert.equal(updates[0].replyContext.content, 'parent says hello');
  assert.equal(updates[0].replyContext.translatedContent, '');
  assert.equal(typeof releaseTranslation, 'function');
  releaseTranslation('父帖说你好');
  await eventually(() => assert.equal(updates.length, 2));
  assert.equal(updates[1].replyContext.translatedContent, '父帖说你好');
});

test('social service ignores client translations, persists originals first, then incrementally upserts DeepSeek results', async (t) => {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'robinhood-deepseek-social-'));
  const calls = [];
  const pending = [];
  const translations = new Map([
    ['u can speak English', '你会说英语吗？'],
    ['parent says hello', '父帖说你好'],
    ['quoted alpha call', '引用的 Alpha 喊单']
  ]);
  const service = createSocialService({
    config: {
      dataFile: path.join(directory, 'social.sqlite'),
      bridgeToken: '',
      retentionDays: 7,
      bridgeOfflineMs: 90_000,
      cleanupIntervalMs: 60_000,
      commandLeaseMs: 30_000,
      xFastHandles: [],
      xReplyEnrichmentEnabled: true,
      translationApiKey: 'translation-test-key',
      translationBaseUrl: 'https://api.deepseek.com',
      translationModel: 'deepseek-chat',
      translationTimeoutMs: 8_000,
      translationMaxAttempts: 1,
      translationRetryDelayMs: 0,
      translationConcurrency: 3,
      translationMaxQueue: 100,
      translationCacheSize: 100
    },
    fetchImpl: async (url, options) => {
      calls.push(String(url));
      assert.equal(String(url), 'https://api.deepseek.com/chat/completions');
      const source = JSON.parse(options.body).messages[1].content;
      return new Promise((resolve) => pending.push(() => resolve(deepSeekResponse(translations.get(source)))));
    }
  });
  t.after(() => {
    service.close();
    fs.rmSync(directory, { recursive: true, force: true });
  });

  const externalId = '2081700497174733999';
  const replyId = '2081696375595524999';
  const quoteId = '2081481106281390999';
  service.ingestPosts([{
    source: 'twitter',
    externalId,
    kind: 'reply',
    author: { handle: 'fixture_cat' },
    content: 'u can speak English',
    translatedContent: 'untrusted main translation',
    url: `https://x.com/fixture_cat/status/${externalId}`,
    replyToExternalId: replyId,
    replyContext: {
      externalId: replyId,
      author: { handle: 'parent_user' },
      content: 'parent says hello',
      translatedContent: 'untrusted parent translation',
      url: `https://x.com/parent_user/status/${replyId}`
    },
    quoteContext: {
      externalId: quoteId,
      author: { handle: 'quote_user' },
      content: 'quoted alpha call',
      translatedContent: 'untrusted quote translation',
      url: `https://x.com/quote_user/status/${quoteId}`
    },
    publishedAt: Date.now()
  }]);

  const original = service.store.getPost('twitter', externalId);
  assert.equal(original.content, 'u can speak English');
  assert.equal(original.translatedContent, '');
  assert.equal(original.replyContext.translatedContent, '');
  assert.equal(original.quoteContext.translatedContent, '');

  await eventually(() => assert.equal(pending.length, 3));
  for (const release of pending.splice(0)) release();
  await eventually(() => {
    const translated = service.store.getPost('twitter', externalId);
    assert.equal(translated.translatedContent, '你会说英语吗？');
    assert.equal(translated.replyContext.translatedContent, '父帖说你好');
    assert.equal(translated.quoteContext.translatedContent, '引用的 Alpha 喊单');
  });
  assert.equal(service.getTranslationStatus().model, 'deepseek-chat');

  service.close();
  let restartRequests = 0;
  const restarted = createSocialService({
    config: {
      ...service.config,
      dataFile: path.join(directory, 'social.sqlite'),
      bridgeToken: '',
      retentionDays: 7,
      bridgeOfflineMs: 90_000,
      cleanupIntervalMs: 60_000,
      commandLeaseMs: 30_000,
      xFastHandles: [],
      xReplyEnrichmentEnabled: false,
      translationApiKey: 'translation-test-key',
      translationBaseUrl: 'https://api.deepseek.com',
      translationModel: 'deepseek-chat',
      translationTimeoutMs: 8_000,
      translationMaxAttempts: 1,
      translationRetryDelayMs: 0,
      translationConcurrency: 3,
      translationMaxQueue: 100,
      translationCacheSize: 100
    },
    fetchImpl: async () => {
      restartRequests += 1;
      throw new Error('persistent DeepSeek translations must avoid a second API request');
    }
  });
  t.after(() => restarted.close());
  restarted.ingestPosts([{
    source: 'twitter',
    externalId,
    content: 'u can speak English',
    translatedContent: 'another untrusted translation',
    replyContext: {
      externalId: replyId,
      author: { handle: 'parent_user' },
      content: 'parent says hello',
      translatedContent: 'another untrusted translation',
      url: `https://x.com/parent_user/status/${replyId}`
    },
    quoteContext: {
      externalId: quoteId,
      author: { handle: 'quote_user' },
      content: 'quoted alpha call',
      translatedContent: 'another untrusted translation',
      url: `https://x.com/quote_user/status/${quoteId}`
    }
  }]);
  await eventually(() => assert.ok(restarted.getTranslationStatus().persistentCacheHits >= 3));
  assert.equal(restartRequests, 0);
  const afterRestart = restarted.store.getPost('twitter', externalId);
  assert.equal(afterRestart.translatedContent, '你会说英语吗？');
  assert.equal(afterRestart.replyContext.translatedContent, '父帖说你好');
  assert.equal(afterRestart.quoteContext.translatedContent, '引用的 Alpha 喊单');
});

test('missing DeepSeek configuration never restores untrusted DeBot translations', (t) => {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'robinhood-deepseek-disabled-'));
  const service = createSocialService({
    config: createSocialConfig({}, { fallbackDirectory: directory })
  });
  t.after(() => {
    service.close();
    fs.rmSync(directory, { recursive: true, force: true });
  });

  service.ingestPosts([{
    source: 'twitter',
    externalId: '2081700497174734889',
    author: { handle: 'fixture_cat' },
    content: 'hello world',
    translatedContent: 'DeBot 旧译文',
    publishedAt: Date.now()
  }]);

  assert.equal(service.store.getPost('twitter', '2081700497174734889').translatedContent, '');
  assert.deepEqual(service.getTranslationStatus(), {
    enabled: false,
    model: '',
    backfill: { scanned: 0, scheduled: 0, complete: true }
  });
});

test('deleted posts are translated from both realtime events and the delete endpoint', async (t) => {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'robinhood-deepseek-deleted-'));
  const translations = new Map([
    ['deleted realtime text', '实时删推译文'],
    ['deleted endpoint text', '删除接口译文']
  ]);
  const service = createSocialService({
    config: {
      ...createSocialConfig({
        DEEPSEEK_TRANSLATION_API_KEY: 'translation-test-key',
        DEEPSEEK_TRANSLATION_MAX_ATTEMPTS: '1'
      }, { fallbackDirectory: directory }),
      dataFile: path.join(directory, 'social.sqlite')
    },
    fetchImpl: async (_url, options) => {
      const source = JSON.parse(options.body).messages[1].content;
      return deepSeekResponse(translations.get(source));
    }
  });
  t.after(() => {
    service.close();
    fs.rmSync(directory, { recursive: true, force: true });
  });

  service.ingestPosts([{
    source: 'twitter',
    externalId: 'tweet_delete:2081700497174734881',
    kind: 'delete',
    author: { handle: 'deleted_fixture' },
    content: 'deleted realtime text',
    deleted: true,
    deletedAt: Date.now(),
    publishedAt: Date.now()
  }]);
  await eventually(() => assert.equal(
    service.store.getPost('twitter', 'tweet_delete:2081700497174734881').translatedContent,
    '实时删推译文'
  ));

  service.ingestPosts([{
    source: 'twitter',
    externalId: '2081700497174734882',
    kind: 'post',
    author: { handle: 'deleted_fixture' },
    content: 'deleted endpoint text',
    publishedAt: Date.now()
  }], { skipTranslation: true });
  service.deletePost('twitter', '2081700497174734882', Date.now());
  await eventually(() => assert.equal(
    service.store.getPost('twitter', '2081700497174734882').translatedContent,
    '删除接口译文'
  ));
});

test('translation backfill pages through more than five hundred watched posts', async (t) => {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'robinhood-deepseek-backfill-'));
  const dataFile = path.join(directory, 'social.sqlite');
  const seed = createSocialService({
    config: { ...createSocialConfig({}, { fallbackDirectory: directory }), dataFile }
  });
  seed.addWatchAccounts([{ platform: 'twitter', handle: 'bulk_user' }]);
  seed.ingestPosts(Array.from({ length: 550 }, (_, index) => ({
    source: 'twitter',
    externalId: String(2081700497174000000n + BigInt(index)),
    author: { handle: 'bulk_user' },
    content: 'same historical English text',
    publishedAt: Date.now() - index
  })));
  seed.close();

  let requests = 0;
  const service = createSocialService({
    config: {
      ...createSocialConfig({
        DEEPSEEK_TRANSLATION_API_KEY: 'translation-test-key',
        DEEPSEEK_TRANSLATION_MAX_ATTEMPTS: '1'
      }, { fallbackDirectory: directory }),
      dataFile
    },
    fetchImpl: async () => {
      requests += 1;
      return deepSeekResponse('相同的历史英文文本');
    }
  });
  t.after(() => {
    service.close();
    fs.rmSync(directory, { recursive: true, force: true });
  });

  service.start();
  await eventually(() => {
    const status = service.getTranslationStatus();
    assert.equal(status.backfill.complete, true);
    assert.equal(status.backfill.scanned, 550);
  }, 3_000);
  await eventually(() => assert.equal(
    service.store.listPosts({ limit: 500, watchlistOnly: true })[0].translatedContent,
    '相同的历史英文文本'
  ));
  assert.equal(requests, 1);
});

test('translation backfill retries rows rejected by a small background queue before completing', async (t) => {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'robinhood-deepseek-small-queue-'));
  const dataFile = path.join(directory, 'social.sqlite');
  const seed = createSocialService({
    config: { ...createSocialConfig({}, { fallbackDirectory: directory }), dataFile }
  });
  seed.addWatchAccounts([{ platform: 'twitter', handle: 'queue_user' }]);
  seed.ingestPosts(Array.from({ length: 25 }, (_, index) => ({
    source: 'twitter',
    externalId: String(2081700497175000000n + BigInt(index)),
    author: { handle: 'queue_user' },
    content: `historical queue message ${index}`,
    publishedAt: Date.now() - index
  })));
  seed.close();

  const requested = [];
  const service = createSocialService({
    config: {
      ...createSocialConfig({
        DEEPSEEK_TRANSLATION_API_KEY: 'translation-test-key',
        DEEPSEEK_TRANSLATION_MAX_ATTEMPTS: '1',
        DEEPSEEK_TRANSLATION_CONCURRENCY: '2',
        DEEPSEEK_TRANSLATION_MAX_QUEUE: '10'
      }, { fallbackDirectory: directory }),
      dataFile
    },
    fetchImpl: async (url, options) => {
      const source = JSON.parse(options.body).messages[1].content;
      requested.push(source);
      return deepSeekResponse(`历史翻译：${source}`);
    }
  });
  t.after(() => {
    service.close();
    fs.rmSync(directory, { recursive: true, force: true });
  });

  service.start();
  await eventually(() => assert.ok(service.getTranslationStatus().dropped > 0), 3_000);
  await eventually(() => {
    const posts = service.store.listPosts({ limit: 100, watchlistOnly: true });
    assert.equal(posts.length, 25);
    assert.ok(posts.every((post) => post.translatedContent));
    const status = service.getTranslationStatus();
    assert.equal(status.backfill.complete, true);
    assert.equal(status.backfill.scanned, 25);
    assert.equal(status.backfill.scheduled, 25);
  }, 5_000);
  assert.equal(new Set(requested).size, 25);
});

test('translation backfill reopens after realtime evicts an accepted background job', async (t) => {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'robinhood-deepseek-dropped-backfill-'));
  const dataFile = path.join(directory, 'social.sqlite');
  const seed = createSocialService({
    config: { ...createSocialConfig({}, { fallbackDirectory: directory }), dataFile }
  });
  seed.addWatchAccounts([{ platform: 'twitter', handle: 'dropped_user' }]);
  seed.ingestPosts(Array.from({ length: 11 }, (_, index) => ({
    source: 'twitter',
    externalId: String(2081700497176000000n + BigInt(index)),
    author: { handle: 'dropped_user' },
    content: `history dropped message ${index}`,
    publishedAt: Date.now() - index
  })));
  seed.close();

  let releaseHistory;
  const historyGate = new Promise((resolve) => { releaseHistory = resolve; });
  let releaseLiveBlocker;
  const liveBlockerGate = new Promise((resolve) => { releaseLiveBlocker = resolve; });
  const requested = [];
  const service = createSocialService({
    config: {
      ...createSocialConfig({
        DEEPSEEK_TRANSLATION_API_KEY: 'translation-test-key',
        DEEPSEEK_TRANSLATION_MAX_ATTEMPTS: '1',
        DEEPSEEK_TRANSLATION_CONCURRENCY: '2',
        DEEPSEEK_TRANSLATION_MAX_QUEUE: '10'
      }, { fallbackDirectory: directory }),
      dataFile
    },
    fetchImpl: async (url, options) => {
      const source = JSON.parse(options.body).messages[1].content;
      requested.push(source);
      if (source.startsWith('history dropped')) await historyGate;
      if (source === 'live queue blocker') await liveBlockerGate;
      return deepSeekResponse(`历史翻译：${source}`);
    }
  });
  t.after(() => {
    releaseHistory();
    releaseLiveBlocker();
    service.close();
    fs.rmSync(directory, { recursive: true, force: true });
  });

  service.start();
  await eventually(() => {
    const status = service.getTranslationStatus();
    assert.equal(status.backfill.complete, true);
    assert.equal(status.activeBackground, 1);
    assert.equal(status.queued, 10);
  }, 3_000);

  service.ingestPosts([{
    source: 'twitter',
    externalId: '2081700497176999998',
    author: { handle: 'live_user' },
    content: 'live queue blocker',
    publishedAt: Date.now()
  }]);
  await eventually(() => {
    const status = service.getTranslationStatus();
    assert.ok(requested.includes('live queue blocker'));
    assert.equal(status.active, 2);
    assert.equal(status.queued, 10);
  });

  service.ingestPosts([{
    source: 'twitter',
    externalId: '2081700497176999999',
    author: { handle: 'live_user' },
    content: 'live queue priority alert',
    publishedAt: Date.now()
  }]);
  assert.equal(service.getTranslationStatus().backfill.complete, false);
  releaseLiveBlocker();
  await eventually(() => assert.ok(requested.includes('live queue priority alert')));

  releaseHistory();
  await eventually(() => {
    const posts = service.store.listPosts({ limit: 100, watchlistOnly: true });
    assert.equal(posts.length, 11);
    assert.ok(posts.every((post) => post.translatedContent));
    assert.equal(service.getTranslationStatus().backfill.complete, true);
  }, 5_000);
  assert.equal(new Set(requested.filter((source) => source.startsWith('history dropped'))).size, 11);
});
