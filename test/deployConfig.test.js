import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';
import assert from 'node:assert/strict';

import { loadDebotCookies } from '../src/cookieStore.js';
import { DebotBrowserClient } from '../src/debotBrowserClient.js';
import { createAnalysisServiceFromEnv, fetchSignalPayloadWithDeps, sanitizeAnalysisForPublic } from '../src/server.js';

test('loads Debot cookies from a JSON file for Linux deployment', () => {
  const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), 'debot-cookie-test-'));
  const cookiePath = path.join(tempDir, 'cookies.json');
  const cookies = [
    {
      name: 'session',
      value: 'secret',
      domain: '.debot.ai',
      path: '/',
      expires: -1,
      httpOnly: true,
      secure: true,
      sameSite: 'None'
    }
  ];
  fs.writeFileSync(cookiePath, JSON.stringify(cookies));

  try {
    assert.deepEqual(
      loadDebotCookies({
        cookiesPath: cookiePath,
        sourcePath: path.join(tempDir, 'missing-codex-cookies.sqlite')
      }),
      cookies
    );
  } finally {
    fs.rmSync(tempDir, { recursive: true, force: true });
  }
});

test('uses Playwright bundled Chromium in headless deployment unless a browser channel is set', () => {
  const previous = process.env.DEBOT_BROWSER_CHANNEL;
  delete process.env.DEBOT_BROWSER_CHANNEL;

  try {
    const client = new DebotBrowserClient({ headless: true });
    assert.equal(client.channel, undefined);
  } finally {
    if (previous === undefined) {
      delete process.env.DEBOT_BROWSER_CHANNEL;
    } else {
      process.env.DEBOT_BROWSER_CHANNEL = previous;
    }
  }
});

test('server enables DeepSeek pro narrative generator from environment', () => {
  const service = createAnalysisServiceFromEnv({
    NARRATIVE_PROVIDER: 'deepseek',
    DEEPSEEK_API_KEY: 'test-key',
    DEEPSEEK_MODEL: 'deepseek-v4-pro',
    ANALYSIS_CACHE_TTL_MS: '3600000'
  });

  assert.equal(service.ttlMs, 3600000);
  assert.equal(service.narrativeGenerator.model, 'deepseek-v4-pro');
  assert.equal(service.narrativeGenerator.baseUrl, 'https://api.deepseek.com');
});

test('server enables Grok primary narrative generator with DeepSeek fallback', () => {
  const service = createAnalysisServiceFromEnv({
    NARRATIVE_PROVIDER: 'grok',
    GROK_API_KEY: 'grok-key',
    GROK_BASE_URL: 'https://api.vip.crond.dev/v1',
    GROK_MODEL: 'grok-4.3',
    GROK_REASONING_EFFORT: 'expert',
    DEEPSEEK_API_KEY: 'deepseek-key',
    DEEPSEEK_MODEL: 'deepseek-v4-pro',
    ANALYSIS_CACHE_TTL_MS: '3600000'
  });

  assert.equal(service.ttlMs, 3600000);
  assert.equal(service.narrativeGenerator.provider, 'grok');
  assert.equal(service.narrativeGenerator.model, 'grok-4.3');
  assert.equal(service.narrativeGenerator.primary.baseUrl, 'https://api.vip.crond.dev/v1');
  assert.equal(service.narrativeGenerator.primary.reasoningEffort, 'expert');
  assert.equal(service.narrativeGenerator.primary.rawFormatter.model, 'deepseek-v4-flash');
  assert.equal(service.narrativeGenerator.fallback.provider, 'deepseek');
  assert.equal(service.narrativeGenerator.fallback.model, 'deepseek-v4-pro');
  assert.equal(service.devTweetAttitudeAnalyzer.model, 'deepseek-v4-flash');
  assert.equal(service.devTweetAttitudeAnalyzer.searchPostFetcher.baseUrl, 'https://api.vip.crond.dev/v1');
  assert.equal(service.devTweetAttitudeAnalyzer.searchPostFetcher.model, 'grok-4.3');
});

test('server can disable dev tweet attitude analysis separately', () => {
  const service = createAnalysisServiceFromEnv({
    NARRATIVE_PROVIDER: 'grok',
    GROK_API_KEY: 'grok-key',
    GROK_MODEL: 'grok-4.3',
    DEEPSEEK_API_KEY: 'deepseek-key',
    DEEPSEEK_MODEL: 'deepseek-v4-pro',
    DEV_TWEET_ATTITUDE_ENABLED: '0'
  });

  assert.equal(service.narrativeGenerator.provider, 'grok');
  assert.equal(service.devTweetAttitudeAnalyzer, null);
});

test('server can override the fast DeepSeek model used only for raw text formatting', () => {
  const service = createAnalysisServiceFromEnv({
    NARRATIVE_PROVIDER: 'grok',
    GROK_API_KEY: 'grok-key',
    GROK_MODEL: 'grok-4.3',
    DEEPSEEK_API_KEY: 'deepseek-key',
    DEEPSEEK_MODEL: 'deepseek-v4-pro',
    DEEPSEEK_FORMAT_MODEL: 'deepseek-v4-flash'
  });

  assert.equal(service.narrativeGenerator.primary.rawFormatter.model, 'deepseek-v4-flash');
  assert.equal(service.narrativeGenerator.fallback.model, 'deepseek-v4-pro');
});

test('analysis route can refresh signal rows without starting background prefetch', async () => {
  let prefetchCalls = 0;
  const result = await fetchSignalPayloadWithDeps({
    limit: 10,
    prefetch: false,
    client: {
      async fetchSignals() {
        return {
          ok: true,
          rows: [{ address: '0xabc', symbol: 'AAA' }]
        };
      }
    },
    analysisService: {
      async enrichRowsWithRealtime(rows) {
        return rows;
      },
      decorateRows(rows) {
        return rows;
      },
      prefetchRows() {
        prefetchCalls += 1;
      }
    }
  });

  assert.equal(prefetchCalls, 0);
  assert.deepEqual(result.rows, [{ address: '0xabc', symbol: 'AAA' }]);
});

test('signal list refresh starts background analysis prefetch by default', async () => {
  let prefetchCalls = 0;
  const result = await fetchSignalPayloadWithDeps({
    limit: 10,
    client: {
      async fetchSignals() {
        return {
          ok: true,
          rows: [{ address: '0xabc', symbol: 'AAA' }]
        };
      }
    },
    analysisService: {
      async enrichRowsWithRealtime(rows) {
        return rows;
      },
      decorateRows(rows) {
        return rows;
      },
      prefetchRows() {
        prefetchCalls += 1;
      }
    }
  });

  assert.equal(prefetchCalls, 1);
  assert.deepEqual(result.rows, [{ address: '0xabc', symbol: 'AAA' }]);
});

test('public analysis payload hides internal narrative provider metadata', () => {
  const analysis = {
    address: '0xabc',
    symbol: 'AAA',
    narrative: {
      thesis: '原文已整理，完整内容在下方。',
      details: [{ label: '叙事原文', value: '这个 CA 是 Base 链上的 $AAA。' }],
      llmProvider: 'grok',
      llmModel: 'grok-4.3',
      llmFallbackFrom: 'deepseek',
      llmUpdatedAt: '2026-05-27T00:00:00.000Z'
    }
  };

  const result = sanitizeAnalysisForPublic(analysis);
  const serialized = JSON.stringify(result);

  assert.equal(result.narrative.llmProvider, undefined);
  assert.equal(result.narrative.llmModel, undefined);
  assert.equal(result.narrative.llmFallbackFrom, undefined);
  assert.equal(result.narrative.llmUpdatedAt, undefined);
  assert.equal(analysis.narrative.llmProvider, 'grok');
  assert.doesNotMatch(serialized, /llmProvider|llmModel|llmFallbackFrom|llmUpdatedAt|grok-4\.3/i);
});
