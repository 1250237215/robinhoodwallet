import test from 'node:test';
import assert from 'node:assert/strict';

import { TokenAnalysisService } from '../src/analysisService.js';

function deferred() {
  let resolve;
  let reject;
  const promise = new Promise((promiseResolve, promiseReject) => {
    resolve = promiseResolve;
    reject = promiseReject;
  });
  return { promise, resolve, reject };
}

async function waitFor(condition, message = 'condition was not met') {
  const startedAt = Date.now();
  while (Date.now() - startedAt < 200) {
    const value = condition();
    if (value) {
      return value;
    }
    await new Promise((resolve) => setTimeout(resolve, 5));
  }
  throw new Error(message);
}

test('marks a token as new only on its first appearance', () => {
  const service = new TokenAnalysisService();

  const [firstSeen] = service.decorateRows([{ address: '0xabc', symbol: 'AAA' }]);
  const [secondSeen] = service.decorateRows([{ address: '0xabc', symbol: 'AAA' }]);

  assert.equal(firstSeen.isNew, true);
  assert.equal(secondSeen.isNew, false);
});

test('adds cached analysis summaries to list rows', () => {
  const service = new TokenAnalysisService();

  service.cache.set('0xabc', {
    cachedAt: Date.now(),
    data: {
      narrative: { label: 'AI工具路由', category: 'AI' },
      dev: { identityStatus: '部分确认', publicHandle: '@demo' }
    }
  });

  const [row] = service.decorateRows([{ address: '0xabc', symbol: 'AAA' }]);

  assert.deepEqual(row.analysisSummary, {
    narrativeLabel: 'AI工具路由',
    narrativeCategory: 'AI',
    devStatus: '部分确认',
    devHandle: '@demo'
  });
});

test('prefetches only newly discovered rows and skips old visible rows', () => {
  const service = new TokenAnalysisService();
  const started = [];

  service.getAnalysis = async (address, row, options) => {
    started.push({ address, priority: options?.priority });
    return {};
  };

  service.prefetchRows([
    { address: '0xnew', symbol: 'NEW', isNew: true },
    { address: '0xold', symbol: 'OLD', isNew: false }
  ]);

  assert.deepEqual(started, [{ address: '0xnew', priority: 'background' }]);
});

test('passes foreground priority to direct analysis generation', async () => {
  const priorities = [];
  const service = new TokenAnalysisService({
    fetchMarketSnapshot: async () => ({
      address: '0xabc',
      websites: [],
      socials: []
    }),
    resolveTokenSources: async () => ({}),
    buildCoinProfile: () => ({
      address: '0xabc',
      symbol: 'AAA',
      name: 'AAA',
      narrative: { label: 'Meme', category: 'Meme', details: [] },
      dev: { identityStatus: '未确认' },
      evidence: [],
      sourceLinks: []
    }),
    narrativeGenerator: {
      provider: 'grok',
      model: 'grok-4.3',
      async generate(input) {
        priorities.push(input.priority);
        return {
          coinIdentity: '这个 CA 是 Base 链上的 $AAA，前台优先测试。',
          communityNarrative: '社区主推版本：前台请求应该用 foreground priority。',
          productOrMemeOrigin: '产品/梗来源：测试。',
          whyItCanMove: '为什么有人会炒：测试。',
          devIdentity: 'Dev 身份：测试。',
          devAiReputation: 'AI 圈水平：未确认。',
          devCryptoReputation: '币圈水平：未确认。',
          evidenceStrength: '证据强度：测试。',
          redFlags: '风险：测试。',
          oneLineSummary: '一句话：测试。'
        };
      }
    }
  });

  await service.getAnalysis('0xabc', { address: '0xabc', symbol: 'AAA' });

  assert.deepEqual(priorities, ['foreground']);
});

test('foreground analysis bypasses a pending background analysis for the same token', async () => {
  let releaseBackground;
  let backgroundStarted;
  const backgroundGate = new Promise((resolve) => {
    releaseBackground = resolve;
  });
  const backgroundStartedGate = new Promise((resolve) => {
    backgroundStarted = resolve;
  });
  const priorities = [];
  const service = new TokenAnalysisService({
    fetchMarketSnapshot: async () => ({
      address: '0xabc',
      websites: [],
      socials: []
    }),
    resolveTokenSources: async () => ({}),
    buildCoinProfile: () => ({
      address: '0xabc',
      symbol: 'AAA',
      name: 'AAA',
      narrative: { label: 'Meme', category: 'Meme', details: [] },
      dev: { identityStatus: '未确认' },
      evidence: [],
      sourceLinks: []
    }),
    narrativeGenerator: {
      provider: 'grok',
      model: 'grok-4.3',
      async generate(input) {
        priorities.push(input.priority);
        if (input.priority === 'background') {
          backgroundStarted();
          await backgroundGate;
        }
        return {
          coinIdentity: `这个 CA 是 Base 链上的 $AAA，${input.priority} 分析。`,
          communityNarrative: `社区主推版本：${input.priority} 叙事。`,
          productOrMemeOrigin: '产品/梗来源：测试。',
          whyItCanMove: '为什么有人会炒：测试。',
          devIdentity: 'Dev 身份：测试。',
          devAiReputation: 'AI 圈水平：未确认。',
          devCryptoReputation: '币圈水平：未确认。',
          evidenceStrength: '证据强度：测试。',
          redFlags: '风险：测试。',
          oneLineSummary: `一句话：${input.priority}。`
        };
      }
    }
  });

  const background = service.getAnalysis(
    '0xabc',
    { address: '0xabc', symbol: 'AAA' },
    { priority: 'background' }
  );
  await backgroundStartedGate;

  const foreground = await Promise.race([
    service.getAnalysis('0xabc', { address: '0xabc', symbol: 'AAA' }),
    new Promise((_, reject) =>
      setTimeout(() => reject(new Error('foreground waited for background pending analysis')), 30)
    )
  ]);

  releaseBackground();
  await background;

  assert.deepEqual(priorities.slice(0, 2), ['background', 'foreground']);
  assert.match(foreground.narrative.details[0].value, /foreground/);
});

test('public analysis results do not expose raw scrape payloads', async () => {
  const service = new TokenAnalysisService({
    fetchMarketSnapshot: async () => ({
      address: '0xabc',
      websites: [],
      socials: []
    }),
    resolveTokenSources: async () => ({
      website: {
        url: 'https://example.com',
        markdown: 'large raw scrape payload with unrelated css cursor text and dirty source fragments'
      }
    }),
    buildCoinProfile: () => ({
      address: '0xabc',
      symbol: 'AAA',
      name: 'AAA',
      narrative: { label: 'AI工具路由', category: 'AI', details: [] },
      dev: { identityStatus: '部分确认', publicHandle: '@demo' },
      evidence: [],
      sourceLinks: ['https://example.com']
    })
  });

  const result = await service.getAnalysis('0xabc', { address: '0xabc', symbol: 'AAA' });
  const serialized = JSON.stringify(result);

  assert.equal(Object.hasOwn(result, 'rawSources'), false);
  assert.doesNotMatch(serialized, /large raw scrape payload|cursor text|dirty source fragments/i);
});

test('uses narrative generator once per cached token analysis', async () => {
  let calls = 0;
  const service = new TokenAnalysisService({
    fetchMarketSnapshot: async () => ({
      address: '0xabc',
      websites: [],
      socials: []
    }),
    resolveTokenSources: async () => ({}),
    buildCoinProfile: () => ({
      address: '0xabc',
      symbol: 'AAA',
      name: 'AAA',
      narrative: {
        label: 'Virtuals AI Agent',
        category: 'AI',
        details: [
          { label: '叙事核心（社区主推版本）', value: 'old core' },
          { label: 'Dev 背书 + 社区期待', value: 'old backing' },
          { label: '风险/未确认', value: 'old risk' }
        ]
      },
      dev: {
        identityStatus: 'Virtuals Team确认',
        publicHandle: '@demo',
        aiLevel: 'old ai',
        cryptoLevel: 'old crypto'
      },
      evidence: [],
      sourceLinks: []
    }),
    narrativeGenerator: {
      model: 'deepseek-v4-pro',
      async generate() {
        calls += 1;
        return {
          narrativeCore: 'deepseek core',
          devBacking: 'deepseek backing',
          risk: 'deepseek risk',
          aiLevel: 'deepseek ai',
          cryptoLevel: 'deepseek crypto'
        };
      }
    }
  });

  const first = await service.getAnalysis('0xabc', { address: '0xabc', symbol: 'AAA' });
  const second = await service.getAnalysis('0xabc', { address: '0xabc', symbol: 'AAA' });

  assert.equal(calls, 1);
  assert.equal(first.narrative.details[0].value, 'deepseek core');
  assert.equal(first.narrative.llmProvider, 'deepseek');
  assert.equal(first.narrative.llmModel, 'deepseek-v4-pro');
  assert.equal(second.narrative.details[0].value, 'deepseek core');
});

test('can force refresh a cached token analysis', async () => {
  let calls = 0;
  const service = new TokenAnalysisService({
    fetchMarketSnapshot: async () => ({
      address: '0xabc',
      websites: [],
      socials: []
    }),
    resolveTokenSources: async () => ({}),
    buildCoinProfile: () => ({
      address: '0xabc',
      symbol: 'AAA',
      name: 'AAA',
      narrative: {
        label: 'Meme',
        category: 'Meme',
        details: [{ label: '旧叙事', value: 'old core' }]
      },
      dev: {
        identityStatus: '部分确认',
        publicHandle: '@demo',
        aiLevel: 'old ai',
        cryptoLevel: 'old crypto'
      },
      evidence: [],
      sourceLinks: []
    }),
    narrativeGenerator: {
      provider: 'grok',
      model: 'grok-4.3',
      async generate() {
        calls += 1;
        return {
          coinIdentity: `这个 CA 是 Base 链上的 $AAA，第 ${calls} 次 Grok 生成。`,
          communityNarrative: `社区主推版本：第 ${calls} 次重新分析后的具体叙事。`,
          productOrMemeOrigin: `产品/梗来源：第 ${calls} 次来源说明。`,
          whyItCanMove: `为什么有人会炒：第 ${calls} 次买盘证据。`,
          devIdentity: `Dev 身份：第 ${calls} 次身份确认。`,
          devAiReputation: `AI 圈水平：第 ${calls} 次 AI 背景判断。`,
          devCryptoReputation: `币圈水平：第 ${calls} 次币圈背景判断。`,
          evidenceStrength: `证据强度：第 ${calls} 次证据判断。`,
          redFlags: `风险：第 ${calls} 次风险判断。`,
          oneLineSummary: `一句话：第 ${calls} 次总结。`
        };
      }
    }
  });

  const first = await service.getAnalysis('0xabc', { address: '0xabc', symbol: 'AAA' });
  const second = await service.getAnalysis('0xabc', { address: '0xabc', symbol: 'AAA' });
  const refreshed = await service.getAnalysis('0xabc', { address: '0xabc', symbol: 'AAA' }, { force: true });

  assert.equal(calls, 2);
  assert.match(first.narrative.details[0].value, /第 1 次/);
  assert.match(second.narrative.details[0].value, /第 1 次/);
  assert.match(refreshed.narrative.details[0].value, /第 2 次/);
});

test('force refresh keeps cached LLM analysis when refreshed narrative degrades to rule analysis', async () => {
  let calls = 0;
  const cachedGood = {
    address: '0xabc',
    symbol: 'AAA',
    narrative: {
      label: 'Meme',
      category: 'Meme',
      thesis: 'cached good Grok narrative',
      llmProvider: 'grok',
      llmModel: 'grok-4.3',
      details: [
        {
          label: '叙事核心（社区主推版本）',
          value: 'X/scanner 社区主推 Bankr agent tokenization + fee 自融资飞轮。'
        }
      ]
    },
    dev: {
      identityStatus: 'Fee Recipient确认',
      publicHandle: '@demo',
      aiLevel: 'cached AI level',
      cryptoLevel: 'cached crypto level'
    },
    sourceLinks: ['https://bankr.bot/launches/0xabc']
  };
  const service = new TokenAnalysisService({
    fetchMarketSnapshot: async () => ({
      address: '0xabc',
      websites: [],
      socials: []
    }),
    resolveTokenSources: async () => ({}),
    buildCoinProfile: () => ({
      address: '0xabc',
      symbol: 'AAA',
      name: 'AAA',
      narrative: {
        label: 'Meme',
        category: 'Meme',
        thesis: 'rule fallback narrative',
        details: [{ label: '叙事核心（社区主推版本）', value: 'rule fallback core' }]
      },
      dev: {
        identityStatus: '未确认',
        aiLevel: 'rule ai',
        cryptoLevel: 'rule crypto'
      },
      evidence: [],
      sourceLinks: []
    }),
    narrativeGenerator: {
      provider: 'grok',
      model: 'grok-4.3',
      async generate() {
        calls += 1;
        return {
          coinIdentity: '这个 CA 是 Base 链上的 $AAA，Bankr 发射盘。',
          communityNarrative: 'communityContext 搜索失败，只能使用 factPack。',
          productOrMemeOrigin: '产品/梗来源：community search failed。',
          whyItCanMove: '为什么有人会炒：搜索失败所以没有社区语境。',
          devIdentity: 'Dev 身份：未确认。',
          devAiReputation: 'AI 圈水平：未确认。',
          devCryptoReputation: '币圈水平：未确认。',
          evidenceStrength: '证据强度：搜索失败。',
          redFlags: '风险：缺少 X/scanner 实时语境。',
          oneLineSummary: '一句话：搜索失败。'
        };
      }
    }
  });
  service.cache.set('0xabc', {
    cachedAt: Date.now(),
    data: cachedGood
  });

  const refreshed = await service.getAnalysis('0xabc', { address: '0xabc', symbol: 'AAA' }, { force: true });

  assert.equal(calls, 1);
  assert.equal(refreshed, cachedGood);
  assert.equal(service.peek('0xabc'), cachedGood);
});

test('marks Grok as the primary narrative provider when configured', async () => {
  const service = new TokenAnalysisService({
    fetchMarketSnapshot: async () => ({
      address: '0xabc',
      websites: [],
      socials: []
    }),
    resolveTokenSources: async () => ({}),
    buildCoinProfile: () => ({
      address: '0xabc',
      symbol: 'AAA',
      name: 'AAA',
      narrative: {
        label: 'Meme',
        category: 'Meme',
        details: [{ label: '旧叙事', value: 'old core' }]
      },
      dev: {
        identityStatus: '部分确认',
        aiLevel: 'old ai',
        cryptoLevel: 'old crypto'
      },
      evidence: [],
      sourceLinks: []
    }),
    narrativeGenerator: {
      provider: 'grok',
      model: 'grok-4.3',
      async generate() {
        return {
          coinIdentity: '这个 CA 是 Base 链上的 $AAA，Bankr 发射的新币。',
          communityNarrative: '社区主推版本：围绕 dev-backed 和 X 传播的清晰 meme 叙事。',
          productOrMemeOrigin: '产品/梗来源：来自 X 社区传播，不是泛泛 AI 应用。',
          whyItCanMove: '为什么有人会炒：Fee Recipient 和公开账号能形成社区预期。',
          devIdentity: 'Dev 身份：公开账号已部分确认。',
          devAiReputation: 'AI 圈水平：非一线模型研究员，偏早期产品 builder。',
          devCryptoReputation: '币圈水平：Base 生态新晋关注对象。',
          evidenceStrength: '证据强度：Bankr 和 X 证据中等。',
          redFlags: '风险：token utility 和官方承诺未确认。',
          oneLineSummary: '一句话：叙事清楚但仍是高风险早期盘。'
        };
      }
    }
  });

  const result = await service.getAnalysis('0xabc', { address: '0xabc', symbol: 'AAA' });

  assert.equal(result.narrative.llmProvider, 'grok');
  assert.equal(result.narrative.llmModel, 'grok-4.3');
  assert.equal(result.narrative.llmFallbackFrom, null);
  assert.match(result.dev.aiLevel, /早期产品 builder/);
  assert.match(result.dev.cryptoLevel, /Base 生态新晋/);
});

test('falls back to rule analysis when narrative generator fails', async () => {
  const warnings = [];
  const service = new TokenAnalysisService({
    logger: {
      warn(message) {
        warnings.push(message);
      }
    },
    fetchMarketSnapshot: async () => ({
      address: '0xabc',
      websites: [],
      socials: []
    }),
    resolveTokenSources: async () => ({}),
    buildCoinProfile: () => ({
      address: '0xabc',
      symbol: 'AAA',
      name: 'AAA',
      narrative: {
        label: 'Meme',
        category: 'Meme',
        details: [{ label: '叙事核心（社区主推版本）', value: 'rule core' }]
      },
      dev: { identityStatus: '未确认', publicHandle: null },
      evidence: [],
      sourceLinks: []
    }),
    narrativeGenerator: {
      model: 'deepseek-v4-pro',
      async generate() {
        throw new Error('DeepSeek is temporarily unavailable for sk-secret');
      }
    }
  });

  const result = await service.getAnalysis('0xabc', { address: '0xabc', symbol: 'AAA' });

  assert.equal(result.narrative.details[0].value, 'rule core');
  assert.equal(result.narrative.llmProvider, undefined);
  assert.equal(result.llmError, undefined);
  assert.equal(warnings.length, 1);
  assert.match(warnings[0], /Narrative generation failed/);
  assert.match(warnings[0], /AAA|0xabc/);
  assert.doesNotMatch(warnings[0], /sk-secret/);
});

test('partial narrative analysis returns base profile first and publishes each finished part independently', async () => {
  const narrativeGate = deferred();
  const devGate = deferred();
  const calls = [];
  const service = new TokenAnalysisService({
    fetchMarketSnapshot: async () => ({
      address: '0xabc',
      websites: [],
      socials: []
    }),
    resolveTokenSources: async () => ({}),
    buildCoinProfile: () => ({
      address: '0xabc',
      symbol: 'AAA',
      name: 'AAA',
      narrative: {
        label: 'Meme',
        category: 'Meme',
        thesis: 'rule thesis should not be shown while split analysis is loading',
        details: [{ label: '旧规则叙事', value: 'old rule detail' }]
      },
      dev: { identityStatus: '未确认', publicHandle: null },
      evidence: [],
      sourceLinks: []
    }),
    narrativeGenerator: {
      provider: 'grok',
      model: 'grok-4.3',
      async generatePart(input) {
        calls.push(input.part);
        if (input.part === 'narrative') {
          return narrativeGate.promise;
        }
        return devGate.promise;
      }
    }
  });

  const first = await service.getAnalysis('0xabc', { address: '0xabc', symbol: 'AAA' });

  assert.deepEqual(calls.sort(), ['dev', 'narrative']);
  assert.equal(first.analysisStatus.narrative, 'loading');
  assert.equal(first.analysisStatus.dev, 'loading');
  assert.equal(first.analysisStatus.complete, false);
  assert.equal(first.narrative.details.length, 0);
  assert.doesNotMatch(JSON.stringify(first), /old rule detail|rule thesis should not be shown/);

  narrativeGate.resolve({
    rawNarrative:
      '这个 CA 是 Base 链上的 $AAA。\n\n叙事核心：社区主推 AI Agent + Bankr fee 自融资飞轮。'
  });

  const afterNarrative = await waitFor(() => {
    const current = service.peek('0xabc');
    return current?.analysisStatus?.narrative === 'ready' ? current : null;
  }, 'narrative part was not published');

  assert.equal(afterNarrative.analysisStatus.dev, 'loading');
  assert.equal(afterNarrative.analysisStatus.complete, false);
  assert.deepEqual(
    afterNarrative.narrative.details.map((item) => item.label),
    ['叙事原文']
  );
  assert.match(afterNarrative.narrative.details[0].value, /AI Agent \+ Bankr fee/);

  devGate.resolve({
    rawDev:
      '没有找到 Bankr Fee Recipient、Virtuals delegate 或接收钱包线索，暂时不能确认 dev。\n\nAI 圈水平：未确认。\n币圈水平：未确认。'
  });

  const complete = await waitFor(() => {
    const current = service.peek('0xabc');
    return current?.analysisStatus?.complete ? current : null;
  }, 'dev part was not published');

  assert.equal(complete.analysisStatus.narrative, 'ready');
  assert.equal(complete.analysisStatus.dev, 'ready');
  assert.deepEqual(
    complete.narrative.details.map((item) => item.label),
    ['叙事原文', 'Dev 背景原文']
  );
  assert.match(complete.narrative.details[1].value, /暂时不能确认 dev/);
});

test('partial analysis can publish dev before narrative without waiting for narrative', async () => {
  const narrativeGate = deferred();
  const devGate = deferred();
  const service = new TokenAnalysisService({
    fetchMarketSnapshot: async () => ({
      address: '0xdef',
      websites: [],
      socials: []
    }),
    resolveTokenSources: async () => ({}),
    buildCoinProfile: () => ({
      address: '0xdef',
      symbol: 'BBB',
      name: 'BBB',
      narrative: { label: 'Meme', category: 'Meme', details: [{ label: '旧规则叙事', value: 'old' }] },
      dev: { identityStatus: 'Fee Recipient确认', publicHandle: '@builder' },
      evidence: [],
      sourceLinks: []
    }),
    narrativeGenerator: {
      provider: 'grok',
      model: 'grok-4.3',
      async generatePart(input) {
        return input.part === 'dev' ? devGate.promise : narrativeGate.promise;
      }
    }
  });

  await service.getAnalysis('0xdef', { address: '0xdef', symbol: 'BBB' });

  devGate.resolve({
    rawDev:
      '@builder 是 Bankr Fee Recipient。\n\nAI 圈水平：中上开源 builder。\n币圈水平：Base 新晋关注对象。'
  });

  const afterDev = await waitFor(() => {
    const current = service.peek('0xdef');
    return current?.analysisStatus?.dev === 'ready' ? current : null;
  }, 'dev part was not published first');

  assert.equal(afterDev.analysisStatus.narrative, 'loading');
  assert.deepEqual(
    afterDev.narrative.details.map((item) => item.label),
    ['Dev 背景原文']
  );
  assert.match(afterDev.narrative.details[0].value, /@builder 是 Bankr Fee Recipient/);

  narrativeGate.resolve({
    rawNarrative:
      '这个 CA 是 Base 链上的 $BBB。\n\n叙事核心：社区主推产品型 AI meme。'
  });

  const complete = await waitFor(() => {
    const current = service.peek('0xdef');
    return current?.analysisStatus?.complete ? current : null;
  }, 'narrative part was not published second');

  assert.deepEqual(
    complete.narrative.details.map((item) => item.label),
    ['叙事原文', 'Dev 背景原文']
  );
  assert.match(complete.narrative.details[0].value, /产品型 AI meme/);
  assert.match(complete.narrative.details[1].value, /@builder 是 Bankr Fee Recipient/);
});

test('partial analysis does not overwrite a very fast part with the initial base profile', async () => {
  const service = new TokenAnalysisService({
    fetchMarketSnapshot: async () => ({
      address: '0xfastpart',
      websites: [],
      socials: []
    }),
    resolveTokenSources: async () => ({}),
    buildCoinProfile: () => ({
      address: '0xfastpart',
      symbol: 'FAST',
      name: 'FAST',
      narrative: { label: 'Meme', category: 'Meme', details: [{ label: '旧规则叙事', value: 'old' }] },
      dev: { identityStatus: '未确认' },
      evidence: [],
      sourceLinks: []
    }),
    narrativeGenerator: {
      provider: 'grok',
      model: 'grok-4.3',
      async generatePart(input) {
        if (input.part === 'narrative') {
          return {
            rawNarrative:
              '这个 CA 是 Base 链上的 $FAST。\n\n叙事核心：这一段完成得非常快，不能被基础资料覆盖。'
          };
        }
        return {
          rawDev:
            '没有找到 Bankr Fee Recipient、Virtuals delegate 或接收钱包线索，暂时不能确认 dev。'
        };
      }
    }
  });

  const first = await service.getAnalysis('0xfastpart', { address: '0xfastpart', symbol: 'FAST' });
  const complete = await waitFor(() => {
    const current = service.peek('0xfastpart');
    return current?.analysisStatus?.complete ? current : null;
  }, 'fast parts were not published');

  assert.equal(first.analysisStatus.complete, false);
  assert.equal(complete.analysisStatus.complete, true);
  assert.match(
    complete.narrative.details.map((item) => item.value).join('\n'),
    /完成得非常快，不能被基础资料覆盖/
  );
});

test('dev tweet attitude analysis is published as an independent bottom detail block', async () => {
  const narrativeGate = deferred();
  const devGate = deferred();
  const tweetAttitudeGate = deferred();
  const calls = [];
  const service = new TokenAnalysisService({
    fetchMarketSnapshot: async () => ({
      address: '0xtweetpart',
      websites: [],
      socials: []
    }),
    resolveTokenSources: async () => ({}),
    buildCoinProfile: () => ({
      address: '0xtweetpart',
      symbol: 'TWT',
      name: 'TWT',
      narrative: { label: 'Meme', category: 'Meme', details: [] },
      dev: { identityStatus: 'Fee Recipient确认', publicHandle: '@builder' },
      evidence: [],
      sourceLinks: []
    }),
    narrativeGenerator: {
      provider: 'grok',
      model: 'grok-4.3',
      async generatePart(input) {
        calls.push(`narrative:${input.part}`);
        return input.part === 'narrative' ? narrativeGate.promise : devGate.promise;
      }
    },
    devTweetAttitudeAnalyzer: {
      async analyze(input) {
        calls.push(`tweet:${input.dev.publicHandle}`);
        return tweetAttitudeGate.promise;
      }
    }
  });

  const first = await service.getAnalysis('0xtweetpart', { address: '0xtweetpart', symbol: 'TWT' });

  assert.equal(first.analysisStatus.tweetAttitude, 'loading');
  assert.equal(first.analysisStatus.complete, false);
  assert.deepEqual(calls.sort(), ['narrative:dev', 'narrative:narrative', 'tweet:@builder']);

  narrativeGate.resolve({
    rawNarrative: '这个 CA 是 Base 链上的 $TWT。\n\n叙事核心：dev-backed meme。'
  });
  devGate.resolve({
    rawDev: '@builder 是 Bankr Fee Recipient。\n\nAI 圈水平：早期 builder。\n币圈水平：新晋关注。'
  });

  const afterNarrativeAndDev = await waitFor(() => {
    const current = service.peek('0xtweetpart');
    return current?.analysisStatus?.dev === 'ready' && current?.analysisStatus?.narrative === 'ready' ? current : null;
  }, 'narrative and dev parts were not published');

  assert.equal(afterNarrativeAndDev.analysisStatus.tweetAttitude, 'loading');
  assert.equal(afterNarrativeAndDev.analysisStatus.complete, false);
  assert.equal(afterNarrativeAndDev.devTweetAttitude, undefined);

  tweetAttitudeGate.resolve({
    handle: '@builder',
    supportLevel: '明确支持',
    summary: 'dev 最近明确提到认领手续费，并表示会继续 build。',
    items: [
      {
        textOriginal: 'I claimed fees and will keep building.',
        textZh: '我已认领手续费，并会继续建设。',
        textEn: 'I claimed fees and will keep building.',
        url: 'https://x.com/builder/status/2050000000000000002',
        publishedAt: '2026-05-27T10:00:00.000Z',
        type: 'tweet'
      }
    ]
  });

  const complete = await waitFor(() => {
    const current = service.peek('0xtweetpart');
    return current?.analysisStatus?.complete ? current : null;
  }, 'tweet attitude part was not published');

  assert.equal(complete.analysisStatus.tweetAttitude, 'ready');
  assert.equal(complete.devTweetAttitude.supportLevel, '明确支持');
  assert.match(complete.devTweetAttitude.summary, /继续 build/);
  assert.match(complete.devTweetAttitude.items[0].textZh, /认领手续费/);
});

test('dev tweet attitude is skipped when no dev handle is available', async () => {
  const service = new TokenAnalysisService({
    fetchMarketSnapshot: async () => ({
      address: '0xnodev',
      websites: [],
      socials: []
    }),
    resolveTokenSources: async () => ({}),
    buildCoinProfile: () => ({
      address: '0xnodev',
      symbol: 'NODEV',
      name: 'NODEV',
      narrative: { label: 'Meme', category: 'Meme', details: [] },
      dev: { identityStatus: '未确认', publicHandle: null },
      evidence: [],
      sourceLinks: []
    }),
    narrativeGenerator: {
      provider: 'grok',
      model: 'grok-4.3',
      async generatePart(input) {
        return input.part === 'narrative'
          ? { rawNarrative: '这个 CA 是 Base 链上的 $NODEV。\n\n叙事核心：未知。' }
          : { rawDev: '没有找到 Bankr 或 Virtuals 上的接收钱包/归属线索，暂时不能确认 dev。' };
      }
    },
    devTweetAttitudeAnalyzer: {
      async analyze() {
        throw new Error('should not analyze tweets without a dev handle');
      }
    }
  });

  await service.getAnalysis('0xnodev', { address: '0xnodev', symbol: 'NODEV' });
  const complete = await waitFor(() => {
    const current = service.peek('0xnodev');
    return current?.analysisStatus?.complete ? current : null;
  }, 'analysis did not complete');

  assert.equal(complete.analysisStatus.tweetAttitude, 'skipped');
  assert.equal(complete.devTweetAttitude.supportLevel, '未确认');
  assert.match(complete.devTweetAttitude.summary, /没有确认到 dev X 账号/);
  assert.deepEqual(complete.devTweetAttitude.items, []);
});

test('dev tweet attitude uses Bankr or Virtuals source handles when profile dev handle is not populated yet', async () => {
  const calls = [];
  const service = new TokenAnalysisService({
    fetchMarketSnapshot: async () => ({
      address: '0xsourcehandle',
      websites: [],
      socials: []
    }),
    resolveTokenSources: async () => ({
      bankr: {
        feeRecipientHandle: '@source_dev'
      }
    }),
    buildCoinProfile: () => ({
      address: '0xsourcehandle',
      symbol: 'SRC',
      name: 'SRC',
      narrative: { label: 'Meme', category: 'Meme', details: [] },
      dev: { identityStatus: '部分确认', publicHandle: null, feeRecipientHandle: null },
      evidence: [],
      sourceLinks: []
    }),
    narrativeGenerator: {
      provider: 'grok',
      model: 'grok-4.3',
      async generatePart(input) {
        return input.part === 'narrative'
          ? { rawNarrative: '这个 CA 是 Base 链上的 $SRC。\n\n叙事核心：测试 source handle。' }
          : { rawDev: 'Bankr Fee Recipient 指向 @source_dev。' };
      }
    },
    devTweetAttitudeAnalyzer: {
      async analyze(input) {
        calls.push(input.sources.bankr.feeRecipientHandle);
        return {
          handle: '@source_dev',
          supportLevel: '中性',
          summary: '已根据 Bankr source handle 抓取 dev 最近内容，但没有明确支持 token。',
          items: []
        };
      }
    }
  });

  const first = await service.getAnalysis('0xsourcehandle', { address: '0xsourcehandle', symbol: 'SRC' });
  assert.equal(first.analysisStatus.tweetAttitude, 'loading');

  const complete = await waitFor(() => {
    const current = service.peek('0xsourcehandle');
    return current?.analysisStatus?.complete ? current : null;
  }, 'source handle tweet attitude did not complete');

  assert.deepEqual(calls, ['@source_dev']);
  assert.equal(complete.analysisStatus.tweetAttitude, 'ready');
  assert.equal(complete.devTweetAttitude.handle, '@source_dev');
});
