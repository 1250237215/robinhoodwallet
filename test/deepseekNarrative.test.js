import test from 'node:test';
import assert from 'node:assert/strict';

import {
  applyDeepSeekEnhancement,
  buildDeepSeekFactPack,
  createNarrativeGeneratorFromEnv,
  DeepSeekNarrativeGenerator,
  DeepSeekRawTextFormatter,
  FallbackNarrativeGenerator,
  getNarrativeMetadata,
  GrokNarrativeGenerator
} from '../src/deepseekNarrative.js';

function delay(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

test('DeepSeek narrative generator uses pro model with thinking disabled by default', async () => {
  const requests = [];
  const generator = new DeepSeekNarrativeGenerator({
    apiKey: 'test-key',
    fetchImpl: async (url, options) => {
      requests.push({ url, options });
      return new Response(
        JSON.stringify({
          choices: [
            {
              message: {
                content: JSON.stringify({
                  coinIdentity: '这个 CA 是 Base 链上的 $ORION，Virtuals 体系里的 Physical AI 项目币。',
                  communityNarrative: '社区主推的是 Physical AI + 机器人执行层叙事。',
                  productOrMemeOrigin: '项目公开资料指向 OrionX Robotics 和 ARES 机器人系统。',
                  whyItCanMove: 'Virtuals 官方项目页、团队成员和 video pitch 能互相印证。',
                  devIdentity: 'Victor Rowan / OrionX Robotics 团队。',
                  devAiReputation: 'AI 圈水平：Physical AI 早期偏强 builder，但不是顶级模型研究员。',
                  devCryptoReputation: '币圈水平：Virtuals/Base 早期项目团队，币圈履历仍早。',
                  evidenceStrength: '证据强度：Virtuals 官方链接和团队成员较强。',
                  redFlags: '风险：未看到 fee delegation，仍是早期盘。',
                  oneLineSummary: '一句话：Physical AI 早期团队盘，强在项目资料，不是纯 meme。'
                })
              }
            }
          ]
        }),
        { status: 200, headers: { 'content-type': 'application/json' } }
      );
    }
  });

  const result = await generator.generate({
    row: { address: '0xabc', symbol: 'ORION', name: 'OrionX Robotics' },
    market: { pairName: 'ORION/VIRTUAL' },
    sources: {
      virtuals: {
        projectTwitterHandle: '@OrionX_Robotics',
        projectWebsiteUrl: 'https://orionxrobotics.xyz/',
        projectMembers: [{ displayName: 'Victor Rowan', twitterHandle: '@VictorRowanAi' }]
      }
    },
    profile: {
      narrative: { category: 'AI', label: 'Virtuals AI Agent', details: [] },
      dev: { identityStatus: 'Virtuals Team确认', publicHandle: '@VictorRowanAi' },
      sourceLinks: ['https://app.virtuals.io/virtuals/76475']
    }
  });

  assert.equal(requests.length, 1);
  assert.equal(requests[0].url, 'https://api.deepseek.com/chat/completions');
  const body = JSON.parse(requests[0].options.body);
  assert.equal(body.model, 'deepseek-v4-pro');
  assert.deepEqual(body.thinking, { type: 'disabled' });
  assert.equal(Object.hasOwn(body, 'reasoning_effort'), false);
  assert.match(body.messages[0].content, /coinIdentity|communityNarrative|devAiReputation|devCryptoReputation/);
  assert.doesNotMatch(body.messages[0].content, /字段必须是 narrativeCore、devBacking、risk、aiLevel、cryptoLevel/);
  assert.equal(generator.timeoutMs, 25000);
  assert.equal(generator.maxAttempts, 1);
  assert.equal(requests[0].options.headers.authorization, 'Bearer test-key');
  assert.match(result.communityNarrative, /Physical AI/);
});

test('Grok narrative generator returns raw CA narrative and raw dev background without final writing', async () => {
  const requests = [];
  const generator = new GrokNarrativeGenerator({
    apiKey: 'test-grok-key',
    baseUrl: 'https://api.vip.crond.dev/v1',
    model: 'grok-4.3',
    reasoningEffort: 'expert',
    fetchImpl: async (url, options) => {
      requests.push({ url, options });
      const body = JSON.parse(options.body);
      const userPrompt = body.input?.[1]?.content || '';
      if (body.tools && /这个ca是什么叙事/i.test(userPrompt)) {
        return new Response(
          JSON.stringify({
            output: [
              {
                content: [
                  {
                    type: 'output_text',
                    text:
                      '这个 CA 是 Base 链上的 $BioNote，社区主推 Bankr AI Agent tokenization + bio-notebook 自融资 fee 飞轮；@bobdontfun 和 scanner 帖提到 cabal/smart money 早期进入。'
                  }
                ]
              }
            ]
          }),
          { status: 200, headers: { 'content-type': 'application/json' } }
        );
      }
      if (body.tools && /这个 dev 是谁/.test(userPrompt)) {
        return new Response(
          JSON.stringify({
            output: [
              {
                content: [
                  {
                    type: 'output_text',
                    text:
                      '@liamzebedee 是 BioNote 的 Bankr Fee Recipient 线索。\nAI 圈水平：偏技术 builder，方向是 bio-notebook / agent notebook，未确认一线模型研究员。\n币圈水平：Bankr/Base 新晋被社区发现的 builder/fee recipient，不是老牌协议创始人。\n可看链接：https://x.com/liamzebedee 和 https://github.com/liamzebedee/bio-notebook'
                  }
                ]
              }
            ]
          }),
          { status: 200, headers: { 'content-type': 'application/json' } }
        );
      }
      throw new Error('Grok raw mode must not call a final synthesis request');
    }
  });

  const result = await generator.generate({
    row: {
      address: '0x646d2abcce7f0dddbd86a8a2f0f98f59f861fba3',
      symbol: 'BioNote',
      name: 'BioNote'
    },
    market: {},
    sources: {
      bankr: {
        url: 'https://bankr.bot/launches/0x646d2abcce7f0dddbd86a8a2f0f98f59f861fba3',
        tokenName: 'BioNote',
        tokenSymbol: 'BioNote',
        feeRecipientHandle: '@liamzebedee',
        feeRecipientUrl: 'https://x.com/liamzebedee',
        deployerHandle: '@memeking_soldro',
        websiteUrl: 'https://github.com/liamzebedee/bio-notebook'
      }
    },
    profile: {
      narrative: { category: 'Meme', label: 'Meme', details: [] },
      dev: { identityStatus: 'Fee Recipient确认', publicHandle: '@liamzebedee' },
      sourceLinks: ['https://bankr.bot/launches/0x646d2abcce7f0dddbd86a8a2f0f98f59f861fba3']
    }
  });

  assert.equal(requests.length, 2);
  assert.equal(requests[0].url, 'https://api.vip.crond.dev/v1/responses');
  assert.equal(requests[1].url, 'https://api.vip.crond.dev/v1/responses');
  const narrativeSearchBody = JSON.parse(requests[0].options.body);
  const devSearchBody = JSON.parse(requests[1].options.body);
  assert.equal(narrativeSearchBody.model, 'grok-4.3');
  assert.equal(narrativeSearchBody.store, false);
  assert.equal(Object.hasOwn(narrativeSearchBody, 'thinking'), false);
  assert.equal(Object.hasOwn(narrativeSearchBody, 'response_format'), false);
  assert.deepEqual(
    narrativeSearchBody.tools.map((tool) => tool.type),
    ['x_search', 'web_search']
  );
  assert.deepEqual(
    devSearchBody.tools.map((tool) => tool.type),
    ['x_search', 'web_search']
  );
  assert.ok(narrativeSearchBody.tools[1].filters.allowed_domains.length <= 5);
  assert.equal(narrativeSearchBody.tools[1].filters.allowed_domains.includes('x.com'), false);
  assert.match(narrativeSearchBody.input[0].content, /像用户在 Grok 网页里问一样|不要输出 JSON/i);
  assert.equal(
    narrativeSearchBody.input[1].content,
    '0x646d2abcce7f0dddbd86a8a2f0f98f59f861fba3 这个ca是什么叙事'
  );
  assert.doesNotMatch(
    narrativeSearchBody.input[1].content,
    /Bankr|Virtuals|scanner|KOL|Fee Recipient|deployer|factPack|BioNote/i
  );
  assert.match(devSearchBody.input[0].content, /dev.*背景|AI 圈|币圈/i);
  assert.match(devSearchBody.input[1].content, /这个 dev 是谁/);
  assert.match(devSearchBody.input[1].content, /@liamzebedee|@memeking_soldro|Fee Recipient|deployer/i);
  assert.match(devSearchBody.input[1].content, /AI 圈|币圈|第几梯队|出不出名/i);
  assert.match(devSearchBody.input[1].content, /钱包地址.*X 搜索|X handle/i);
  assert.match(devSearchBody.input[0].content, /不要输出 JSON|直接回答/i);
  assert.doesNotMatch(devSearchBody.input[0].content, /返回 JSON/i);
  assert.doesNotMatch(devSearchBody.input[1].content, /返回 JSON/i);
  assert.ok(narrativeSearchBody.input[1].content.length < 80);
  assert.ok(devSearchBody.input[1].content.length < 1600);
  assert.equal(requests[0].options.headers.authorization, 'Bearer test-grok-key');
  assert.equal(requests[1].options.headers.authorization, 'Bearer test-grok-key');
  assert.equal(result.rawNarrative, '这个 CA 是 Base 链上的 $BioNote，社区主推 Bankr AI Agent tokenization + bio-notebook 自融资 fee 飞轮；@bobdontfun 和 scanner 帖提到 cabal/smart money 早期进入。');
  assert.match(result.rawDev, /@liamzebedee 是 BioNote 的 Bankr Fee Recipient 线索/);
  assert.match(result.rawDev, /AI 圈水平：偏技术 builder/);
  assert.match(result.communityNarrative, /自融资飞轮|fee 飞轮|tokenization/);
  assert.deepEqual(getNarrativeMetadata(result), {
    provider: 'grok',
    model: 'grok-4.3'
  });
});

test('Grok narrative generator formats raw Grok text with DeepSeek for readability only', async () => {
  const grokRequests = [];
  const formatRequests = [];
  const formatter = new DeepSeekRawTextFormatter({
    apiKey: 'deepseek-key',
    model: 'deepseek-v4-pro',
    fetchImpl: async (url, options) => {
      formatRequests.push({ url, options });
      const body = JSON.parse(options.body);
      assert.equal(body.model, 'deepseek-v4-pro');
      assert.deepEqual(body.thinking, { type: 'disabled' });
      assert.deepEqual(body.response_format, { type: 'json_object' });
      assert.match(body.messages[0].content, /只做排版|不要改意思|不要新增事实|不要删除事实/);
      assert.doesNotMatch(body.messages[0].content, /coinIdentity|communityNarrative|devAiReputation|证据强度/);
      assert.match(body.messages[1].content, /rawNarrative|rawDev|BioNote|@liamzebedee/);
      return new Response(
        JSON.stringify({
          choices: [
            {
              message: {
                content: JSON.stringify({
                  rawNarrative:
                    '这个 CA 是 Base 链上的 $BioNote。\n\n叙事核心：社区主推 Bankr AI Agent tokenization + bio-notebook 自融资 fee 飞轮。\n\n- @bobdontfun 和 scanner 帖提到 cabal/smart money 早期进入。',
                  rawDev:
                    '@liamzebedee 是 BioNote 的 Bankr Fee Recipient 线索。\n\n- AI 圈水平：偏技术 builder，方向是 bio-notebook / agent notebook，未确认一线模型研究员。\n- 币圈水平：Bankr/Base 新晋被社区发现的 builder/fee recipient，不是老牌协议创始人。\n\n可看链接：https://x.com/liamzebedee 和 https://github.com/liamzebedee/bio-notebook'
                })
              }
            }
          ]
        }),
        { status: 200, headers: { 'content-type': 'application/json' } }
      );
    }
  });
  const generator = new GrokNarrativeGenerator({
    apiKey: 'test-grok-key',
    baseUrl: 'https://api.vip.crond.dev/v1',
    model: 'grok-4.3',
    rawFormatter: formatter,
    fetchImpl: async (url, options) => {
      grokRequests.push({ url, options });
      const body = JSON.parse(options.body);
      const userPrompt = body.input?.[1]?.content || '';
      if (body.tools && /这个ca是什么叙事/i.test(userPrompt)) {
        return new Response(
          JSON.stringify({
            output_text:
              '这个 CA 是 Base 链上的 $BioNote。叙事核心：社区主推 Bankr AI Agent tokenization + bio-notebook 自融资 fee 飞轮。@bobdontfun 和 scanner 帖提到 cabal/smart money 早期进入。'
          }),
          { status: 200, headers: { 'content-type': 'application/json' } }
        );
      }
      if (body.tools && /这个 dev 是谁/.test(userPrompt)) {
        return new Response(
          JSON.stringify({
            output_text:
              '@liamzebedee 是 BioNote 的 Bankr Fee Recipient 线索。AI 圈水平：偏技术 builder，方向是 bio-notebook / agent notebook，未确认一线模型研究员。币圈水平：Bankr/Base 新晋被社区发现的 builder/fee recipient，不是老牌协议创始人。可看链接：https://x.com/liamzebedee 和 https://github.com/liamzebedee/bio-notebook'
          }),
          { status: 200, headers: { 'content-type': 'application/json' } }
        );
      }
      throw new Error('Grok raw mode must not call a final synthesis request');
    }
  });

  const result = await generator.generate({
    row: {
      address: '0x646d2abcce7f0dddbd86a8a2f0f98f59f861fba3',
      symbol: 'BioNote',
      name: 'BioNote'
    },
    market: {},
    sources: {
      bankr: {
        feeRecipientHandle: '@liamzebedee',
        feeRecipientUrl: 'https://x.com/liamzebedee',
        websiteUrl: 'https://github.com/liamzebedee/bio-notebook'
      }
    },
    profile: {
      narrative: { category: 'Meme', label: 'Meme', details: [] },
      dev: { identityStatus: 'Fee Recipient确认', publicHandle: '@liamzebedee' },
      sourceLinks: []
    }
  });

  assert.equal(grokRequests.length, 2);
  assert.equal(formatRequests.length, 1);
  assert.match(result.rawNarrative, /\n\n叙事核心/);
  assert.match(result.rawDev, /\n- AI 圈水平/);
  assert.equal(result.rawFormatted, true);
  assert.deepEqual(getNarrativeMetadata(result), {
    provider: 'grok',
    model: 'grok-4.3'
  });
});

test('DeepSeek raw text formatter falls back to original text when formatting drops facts', async () => {
  const formatter = new DeepSeekRawTextFormatter({
    apiKey: 'deepseek-key',
    fetchImpl: async () =>
      new Response(
        JSON.stringify({
          choices: [
            {
              message: {
                content: JSON.stringify({
                  rawNarrative: '总结：这是一个 Bankr AI Agent 叙事。',
                  rawDev: '总结：dev 是早期 builder。'
                })
              }
            }
          ]
        }),
        { status: 200, headers: { 'content-type': 'application/json' } }
      )
  });

  const input = {
    rawNarrative:
      '这个 CA 是 Base 链上的 $BioNote，社区主推 Bankr AI Agent tokenization。@bobdontfun 提到 https://x.com/bobdontfun/status/123。',
    rawDev:
      '@liamzebedee 是 BioNote 的 Bankr Fee Recipient。钱包 0x1234567890abcdef1234567890abcdef12345678。可看 https://x.com/liamzebedee。'
  };

  const result = await formatter.format(input);

  assert.equal(result.rawNarrative, input.rawNarrative);
  assert.equal(result.rawDev, input.rawDev);
  assert.equal(result.rawFormatted, false);
});

test('DeepSeek raw text formatter falls back when formatting adds new URLs or handles', async () => {
  const formatter = new DeepSeekRawTextFormatter({
    apiKey: 'deepseek-key',
    fetchImpl: async () =>
      new Response(
        JSON.stringify({
          choices: [
            {
              message: {
                content: JSON.stringify({
                  rawNarrative:
                    '这个 CA 是 Base 链上的 $ORBIT。\n\n社区主推 Base MCP + AI Agent 叙事。\n\n参考：https://x.com/newsource/status/1',
                  rawDev:
                    '@0xEricBrown 是 dev。\n\nFee Recipient 钱包 0xde769d7cf68d1cd1b4a3156dfe97666976842726。\n\n另见 @bankrbot。'
                })
              }
            }
          ]
        }),
        { status: 200, headers: { 'content-type': 'application/json' } }
      )
  });

  const input = {
    rawNarrative:
      '这个 CA 是 Base 链上的 $ORBIT。社区主推 Base MCP + AI Agent 叙事。',
    rawDev:
      '@0xEricBrown 是 dev。Fee Recipient 钱包 0xde769d7cf68d1cd1b4a3156dfe97666976842726。'
  };

  const result = await formatter.format(input);

  assert.equal(result.rawNarrative, input.rawNarrative);
  assert.equal(result.rawDev, input.rawDev);
  assert.equal(result.rawFormatted, false);
});

test('Grok narrative generator rejects when raw search returns no usable text', async () => {
  const requests = [];
  const generator = new GrokNarrativeGenerator({
    apiKey: 'test-grok-key',
    baseUrl: 'https://api.vip.crond.dev/v1',
    model: 'grok-4.3',
    reasoningEffort: 'expert',
    fetchImpl: async (url, options) => {
      requests.push({ url, options });
      const body = JSON.parse(options.body);
      if (body.tools) {
        return new Response(JSON.stringify({ error: 'temporary search outage' }), {
          status: 503,
          headers: { 'content-type': 'application/json' }
        });
      }
      throw new Error('Grok raw mode must not call a final synthesis request after search failure');
    }
  });

  await assert.rejects(
    () =>
      generator.generate({
        row: { address: '0xabc', symbol: 'AAA', name: 'AAA' },
        market: {},
        sources: {},
        profile: {
          narrative: { category: 'Meme', label: 'Meme', details: [] },
          dev: { identityStatus: '未确认' },
          sourceLinks: []
        }
      }),
    /Grok raw search did not return usable narrative or dev text/
  );

  assert.equal(requests.length, 2);
  const narrativeSearchBody = JSON.parse(requests[0].options.body);
  const devSearchBody = JSON.parse(requests[1].options.body);
  assert.deepEqual(
    narrativeSearchBody.tools.map((tool) => tool.type),
    ['x_search', 'web_search']
  );
  assert.deepEqual(
    devSearchBody.tools.map((tool) => tool.type),
    ['x_search', 'web_search']
  );
});

test('Grok narrative generator uses longer search timeout for foreground than background', async () => {
  const timeouts = [];
  const generator = new GrokNarrativeGenerator({
    apiKey: 'test-grok-key',
    baseUrl: 'https://api.vip.crond.dev/v1',
    model: 'grok-4.3',
    timeoutMs: 45000,
    foregroundSearchTimeoutMs: 31000,
    backgroundSearchTimeoutMs: 7000,
    abortSignalTimeout: (ms) => {
      timeouts.push(ms);
      return new AbortController().signal;
    },
    fetchImpl: async (url, options) => {
      const body = JSON.parse(options.body);
      if (body.tools) {
        return new Response(
          JSON.stringify({
            output_text: JSON.stringify({
              summary: '社区搜索摘要：Bankr fee flywheel / scanner context。',
              links: []
            })
          }),
          { status: 200, headers: { 'content-type': 'application/json' } }
        );
      }
      return new Response(
        JSON.stringify({
          output_text: JSON.stringify({
            coinIdentity: '这个 CA 是 Base 链上的 $AAA，Bankr 发射的新币。',
            communityNarrative: '社区主推版本：Bankr fee flywheel。',
            productOrMemeOrigin: '产品/梗来源：测试。',
            whyItCanMove: '为什么有人会炒：测试。',
            devIdentity: 'Dev 身份：测试。',
            devAiReputation: 'AI 圈水平：未确认。',
            devCryptoReputation: '币圈水平：未确认。',
            evidenceStrength: '证据强度：测试。',
            redFlags: '风险：测试。',
            oneLineSummary: '一句话：测试。'
          })
        }),
        { status: 200, headers: { 'content-type': 'application/json' } }
      );
    }
  });

  await generator.generate({
    row: { address: '0xbg', symbol: 'BG', name: 'BG' },
    market: {},
    sources: {},
    profile: { narrative: { details: [] }, dev: {}, sourceLinks: [] },
    priority: 'background'
  });
  await generator.generate({
    row: { address: '0xfg', symbol: 'FG', name: 'FG' },
    market: {},
    sources: {},
    profile: { narrative: { details: [] }, dev: {}, sourceLinks: [] },
    priority: 'foreground'
  });

  assert.deepEqual(timeouts, [7000, 7000, 31000, 31000]);
});

test('Grok narrative generator gives foreground community search the full request window by default', () => {
  const generator = new GrokNarrativeGenerator({
    apiKey: 'test-grok-key',
    timeoutMs: 45000
  });

  assert.equal(generator.searchTimeoutFor('foreground'), 45000);
  assert.equal(generator.searchTimeoutFor('background'), 45000);
});

test('Grok narrative generator runs background jobs with configurable concurrency', async () => {
  let inFlight = 0;
  let maxInFlight = 0;
  let releaseRequests;
  let resolveSecondStarted;
  const releaseGate = new Promise((resolve) => {
    releaseRequests = resolve;
  });
  const secondStarted = new Promise((resolve) => {
    resolveSecondStarted = resolve;
  });
  const generator = new GrokNarrativeGenerator({
    apiKey: 'test-grok-key',
    baseUrl: 'https://api.vip.crond.dev/v1',
    model: 'grok-4.3',
    backgroundConcurrency: 2,
    fetchImpl: async (url, options) => {
      const body = JSON.parse(options.body);
      const prompt = body.input[1].content;
      inFlight += 1;
      maxInFlight = Math.max(maxInFlight, inFlight);
      if (/0xtwo/i.test(prompt)) {
        resolveSecondStarted();
      }
      await releaseGate;
      inFlight -= 1;
      return new Response(
        JSON.stringify({
          output_text: `${prompt} 后台并发测试。`
        }),
        { status: 200, headers: { 'content-type': 'application/json' } }
      );
    }
  });

  const jobs = Promise.all([
    generator.generate({
      row: { address: '0xone', symbol: 'ONE', name: 'ONE' },
      market: {},
      sources: {},
      profile: { narrative: { details: [] }, dev: {}, sourceLinks: [] },
      priority: 'background'
    }),
    generator.generate({
      row: { address: '0xtwo', symbol: 'TWO', name: 'TWO' },
      market: {},
      sources: {},
      profile: { narrative: { details: [] }, dev: {}, sourceLinks: [] },
      priority: 'background'
    })
  ]);

  let observedConcurrency = true;
  try {
    await Promise.race([
      secondStarted,
      delay(30).then(() => {
        throw new Error('second background Grok job waited behind the first one');
      })
    ]);
  } catch {
    observedConcurrency = false;
  } finally {
    releaseRequests();
    await jobs;
  }

  assert.equal(observedConcurrency, true);
  assert.ok(maxInFlight >= 3);
});

test('Grok narrative generator rejects when raw search network errors leave no usable text', async () => {
  const requests = [];
  const generator = new GrokNarrativeGenerator({
    apiKey: 'test-grok-key',
    baseUrl: 'https://api.vip.crond.dev/v1',
    model: 'grok-4.3',
    reasoningEffort: 'expert',
    fetchImpl: async (url, options) => {
      requests.push({ url, options });
      const body = JSON.parse(options.body);
      if (body.tools) {
        throw new TypeError('fetch failed');
      }
      throw new Error('Grok raw mode must not call a final synthesis request after network errors');
    }
  });

  await assert.rejects(
    () =>
      generator.generate({
        row: { address: '0xnet', symbol: 'NET', name: 'NET' },
        market: {},
        sources: {},
        profile: {
          narrative: { category: 'Meme', label: 'Meme', details: [] },
          dev: { identityStatus: '未确认' },
          sourceLinks: []
        }
      }),
    /Grok raw search did not return usable narrative or dev text/
  );

  assert.equal(requests.length, 2);
});

test('fallback narrative generator uses DeepSeek only when Grok fails', async () => {
  const calls = [];
  const generator = new FallbackNarrativeGenerator({
    primary: {
      provider: 'grok',
      model: 'grok-4.3',
      async generate() {
        calls.push('grok');
        throw new Error('grok timeout');
      }
    },
    fallback: {
      provider: 'deepseek',
      model: 'deepseek-v4-pro',
      async generate() {
        calls.push('deepseek');
        return {
          coinIdentity: '这个 CA 是 Base 链上的 $AAA，fallback 生成。',
          communityNarrative: 'fallback 叙事核心具体说明社区在炒什么。',
          productOrMemeOrigin: 'fallback 产品/梗来源。',
          whyItCanMove: 'fallback 买盘原因。',
          devIdentity: 'fallback dev 身份。',
          devAiReputation: 'fallback AI 圈水平。',
          devCryptoReputation: 'fallback 币圈水平。',
          evidenceStrength: 'fallback 证据强度。',
          redFlags: 'fallback 风险。',
          oneLineSummary: 'fallback 一句话总结。'
        };
      }
    }
  });

  const result = await generator.generate({
    row: { address: '0xabc', symbol: 'AAA', name: 'AAA' },
    market: {},
    sources: {},
    profile: { narrative: { details: [] }, dev: {}, sourceLinks: [] }
  });

  assert.deepEqual(calls, ['grok', 'deepseek']);
  assert.deepEqual(getNarrativeMetadata(result), {
    provider: 'deepseek',
    model: 'deepseek-v4-pro',
    fallbackFrom: 'grok'
  });
});

test('fallback narrative generator uses DeepSeek when Grok raw search has no usable text', async () => {
  const calls = [];
  const primary = new GrokNarrativeGenerator({
    apiKey: 'test-grok-key',
    baseUrl: 'https://api.vip.crond.dev/v1',
    model: 'grok-4.3',
    fetchImpl: async (url, options) => {
      const body = JSON.parse(options.body);
      if (body.tools) {
        calls.push('grok-search');
        return new Response(JSON.stringify({ error: 'temporary search outage' }), {
          status: 503,
          headers: { 'content-type': 'application/json' }
        });
      }
      throw new Error('Grok raw mode must not call a final synthesis request');
    }
  });
  const generator = new FallbackNarrativeGenerator({
    primary,
    fallback: {
      provider: 'deepseek',
      model: 'deepseek-v4-pro',
      async generate() {
        calls.push('deepseek');
        return {
          coinIdentity: '这个 CA 是 Base 链上的 $AAA，DeepSeek 兜底生成。',
          communityNarrative: 'DeepSeek 兜底叙事核心。',
          productOrMemeOrigin: 'DeepSeek 兜底来源。',
          whyItCanMove: 'DeepSeek 兜底买盘原因。',
          devIdentity: 'DeepSeek 兜底 dev 身份。',
          devAiReputation: 'DeepSeek 兜底 AI 圈水平。',
          devCryptoReputation: 'DeepSeek 兜底币圈水平。',
          evidenceStrength: 'DeepSeek 兜底证据强度。',
          redFlags: 'DeepSeek 兜底风险。',
          oneLineSummary: 'DeepSeek 兜底一句话。'
        };
      }
    }
  });

  const result = await generator.generate({
    row: { address: '0xabc', symbol: 'AAA', name: 'AAA' },
    market: {},
    sources: {},
    profile: { narrative: { details: [] }, dev: {}, sourceLinks: [] }
  });

  assert.deepEqual(calls, ['grok-search', 'grok-search', 'deepseek']);
  assert.deepEqual(getNarrativeMetadata(result), {
    provider: 'deepseek',
    model: 'deepseek-v4-pro',
    fallbackFrom: 'grok'
  });
});

test('fallback narrative generator forwards split part generation to Grok primary', async () => {
  const calls = [];
  const generator = new FallbackNarrativeGenerator({
    primary: {
      provider: 'grok',
      model: 'grok-4.3',
      async generatePart(input) {
        calls.push(`grok-${input.part}`);
        return input.part === 'narrative'
          ? { rawNarrative: '这个 CA 是 Base 链上的 $AAA，叙事核心是 AI agent meme。' }
          : { rawDev: '@builder 是 Fee Recipient，AI 圈中上，币圈新晋。' };
      }
    },
    fallback: {
      provider: 'deepseek',
      model: 'deepseek-v4-pro',
      async generate() {
        calls.push('deepseek');
        return {};
      }
    }
  });

  const narrative = await generator.generatePart({
    part: 'narrative',
    row: { address: '0xabc', symbol: 'AAA', name: 'AAA' },
    market: {},
    sources: {},
    profile: { narrative: { details: [] }, dev: {}, sourceLinks: [] }
  });
  const dev = await generator.generatePart({
    part: 'dev',
    row: { address: '0xabc', symbol: 'AAA', name: 'AAA' },
    market: {},
    sources: {},
    profile: { narrative: { details: [] }, dev: {}, sourceLinks: [] }
  });

  assert.deepEqual(calls, ['grok-narrative', 'grok-dev']);
  assert.match(narrative.rawNarrative, /AI agent meme/);
  assert.match(dev.rawDev, /@builder/);
  assert.deepEqual(getNarrativeMetadata(narrative), {
    provider: 'grok',
    model: 'grok-4.3',
    part: 'narrative'
  });
  assert.deepEqual(getNarrativeMetadata(dev), {
    provider: 'grok',
    model: 'grok-4.3',
    part: 'dev'
  });
});

test('fallback narrative generator uses DeepSeek whole fallback when Grok split part fails', async () => {
  const calls = [];
  const generator = new FallbackNarrativeGenerator({
    primary: {
      provider: 'grok',
      model: 'grok-4.3',
      async generatePart(input) {
        calls.push(`grok-${input.part}`);
        throw new Error('grok split failed');
      }
    },
    fallback: {
      provider: 'deepseek',
      model: 'deepseek-v4-pro',
      async generate(input) {
        calls.push(`deepseek-${input.priority}`);
        return {
          rawNarrative: '这个 CA 是 Base 链上的 $AAA，DeepSeek 兜底叙事。',
          rawDev: 'DeepSeek 兜底 dev 背景。'
        };
      }
    }
  });

  const narrative = await generator.generatePart({
    part: 'narrative',
    priority: 'background',
    row: { address: '0xabc', symbol: 'AAA', name: 'AAA' },
    market: {},
    sources: {},
    profile: { narrative: { details: [] }, dev: {}, sourceLinks: [] }
  });

  assert.deepEqual(calls, ['grok-narrative', 'deepseek-background']);
  assert.equal(narrative.rawDev, undefined);
  assert.match(narrative.rawNarrative, /DeepSeek 兜底叙事/);
  assert.deepEqual(getNarrativeMetadata(narrative), {
    provider: 'deepseek',
    model: 'deepseek-v4-pro',
    fallbackFrom: 'grok',
    part: 'narrative'
  });
});

test('fallback narrative generator preserves metadata when fallback generator already tagged the result', async () => {
  const fallback = new DeepSeekNarrativeGenerator({
    apiKey: 'test-key',
    fetchImpl: async () =>
      new Response(
        JSON.stringify({
          choices: [
            {
              message: {
                content: JSON.stringify({
                  coinIdentity: '这个 CA 是 Base 链上的 $RAIN，Bankr 发射的 AI 工具币。',
                  communityNarrative: '社区主推版本：AI agent monitoring + MCP 工具路由。',
                  productOrMemeOrigin: '产品/梗来源：Raindrop Triage 跑在 Slack/Web，调查其他 AI agents。',
                  whyItCanMove: '为什么有人会炒：Bankr Fee Recipient、官网、X 账号和 MCP 线索能互相印证。',
                  devIdentity: 'Dev 身份：Fee Recipient 指向公开 X 账号。',
                  devAiReputation: 'AI 圈水平：中上 AI devtools builder。',
                  devCryptoReputation: '币圈水平：新晋关注。',
                  evidenceStrength: '证据强度：Bankr、官网、X 证据中等偏强。',
                  redFlags: '风险：采用量未确认。',
                  oneLineSummary: '一句话：AI devtools 叙事清楚但仍早期。'
                })
              }
            }
          ]
        }),
        { status: 200, headers: { 'content-type': 'application/json' } }
      )
  });
  const generator = new FallbackNarrativeGenerator({
    primary: {
      provider: 'grok',
      model: 'grok-4.3',
      async generate() {
        throw new Error('grok timeout');
      }
    },
    fallback
  });

  const result = await generator.generate({
    row: { address: '0xabc', symbol: 'RAIN', name: 'Raindrop' },
    market: {},
    sources: {},
    profile: { narrative: { details: [] }, dev: {}, sourceLinks: [] }
  });

  assert.match(result.communityNarrative, /AI agent monitoring/);
  assert.deepEqual(getNarrativeMetadata(result), {
    provider: 'deepseek',
    model: 'deepseek-v4-pro',
    fallbackFrom: 'grok'
  });
});

test('environment narrative generator prefers Grok and keeps DeepSeek fallback', () => {
  const generator = createNarrativeGeneratorFromEnv({
    NARRATIVE_PROVIDER: 'grok',
    GROK_API_KEY: 'grok-key',
    GROK_BASE_URL: 'https://api.vip.crond.dev/v1',
    GROK_MODEL: 'grok-4.3',
    GROK_REASONING_EFFORT: 'expert',
    GROK_BACKGROUND_CONCURRENCY: '4',
    DEEPSEEK_API_KEY: 'deepseek-key',
    DEEPSEEK_MODEL: 'deepseek-v4-pro'
  });

  assert.equal(generator.provider, 'grok');
  assert.equal(generator.model, 'grok-4.3');
  assert.equal(generator.primary.provider, 'grok');
  assert.equal(generator.primary.reasoningEffort, 'expert');
  assert.equal(generator.primary.backgroundConcurrency, 4);
  assert.equal(generator.fallback.provider, 'deepseek');
});

test('DeepSeek narrative generator retries transient fetch failures', async () => {
  const requests = [];
  const generator = new DeepSeekNarrativeGenerator({
    apiKey: 'test-key',
    maxAttempts: 2,
    retryDelayMs: 1,
    fetchImpl: async (url, options) => {
      requests.push({ url, options });
      if (requests.length === 1) {
        throw new TypeError('fetch failed');
      }
      return new Response(
        JSON.stringify({
          choices: [
            {
              message: {
                content: JSON.stringify({
                  narrativeCore: '重试后生成的叙事核心',
                  devBacking: '重试后生成的 dev 背书',
                  risk: '重试后生成的风险',
                  aiLevel: '重试后生成的 AI 水平',
                  cryptoLevel: '重试后生成的币圈水平'
                })
              }
            }
          ]
        }),
        { status: 200, headers: { 'content-type': 'application/json' } }
      );
    }
  });

  const result = await generator.generate({
    row: { address: '0xabc', symbol: 'AAA', name: 'AAA' },
    market: {},
    sources: {},
    profile: {
      narrative: { category: 'AI', label: 'AI', details: [] },
      dev: { identityStatus: '未确认' },
      sourceLinks: []
    }
  });

  assert.equal(requests.length, 2);
  assert.equal(result.narrativeCore, '重试后生成的叙事核心');
});

test('DeepSeek narrative generator serializes concurrent API calls', async () => {
  const events = [];
  let inFlight = 0;
  const generator = new DeepSeekNarrativeGenerator({
    apiKey: 'test-key',
    fetchImpl: async () => {
      inFlight += 1;
      events.push(`start-${inFlight}`);
      assert.equal(inFlight, 1);
      await new Promise((resolve) => setTimeout(resolve, 5));
      inFlight -= 1;
      events.push(`end-${inFlight}`);
      return new Response(
        JSON.stringify({
          choices: [
            {
              message: {
                content: JSON.stringify({
                  narrativeCore: '串行生成的叙事核心',
                  devBacking: '串行生成的 dev 背书',
                  risk: '串行生成的风险',
                  aiLevel: '串行生成的 AI 水平',
                  cryptoLevel: '串行生成的币圈水平'
                })
              }
            }
          ]
        }),
        { status: 200, headers: { 'content-type': 'application/json' } }
      );
    }
  });

  await Promise.all([
    generator.generate({
      row: { address: '0xabc1', symbol: 'AAA', name: 'AAA' },
      market: {},
      sources: {},
      profile: { narrative: { category: 'AI', label: 'AI', details: [] }, dev: {}, sourceLinks: [] }
    }),
    generator.generate({
      row: { address: '0xabc2', symbol: 'BBB', name: 'BBB' },
      market: {},
      sources: {},
      profile: { narrative: { category: 'AI', label: 'AI', details: [] }, dev: {}, sourceLinks: [] }
    })
  ]);

  assert.deepEqual(events, ['start-1', 'end-0', 'start-1', 'end-0']);
});

test('DeepSeek narrative generator lets foreground calls bypass queued background work', async () => {
  let releaseBackground;
  let backgroundStarted;
  const backgroundGate = new Promise((resolve) => {
    releaseBackground = resolve;
  });
  const backgroundStartedGate = new Promise((resolve) => {
    backgroundStarted = resolve;
  });
  const requests = [];
  const generator = new DeepSeekNarrativeGenerator({
    apiKey: 'test-key',
    fetchImpl: async (url, options) => {
      const body = JSON.parse(options.body);
      const factPack = JSON.parse(body.messages[1].content);
      requests.push(factPack.token.address);
      if (factPack.token.address === '0xslow') {
        backgroundStarted();
        await backgroundGate;
      }
      return new Response(
        JSON.stringify({
          choices: [
            {
              message: {
                content: JSON.stringify({
                  coinIdentity: `这个 CA 是 Base 链上的 $${factPack.token.symbol}，前台优先测试。`,
                  communityNarrative: `${factPack.token.symbol} 的具体社区叙事。`,
                  productOrMemeOrigin: `${factPack.token.symbol} 的产品/梗来源。`,
                  whyItCanMove: `${factPack.token.symbol} 的买盘原因。`,
                  devIdentity: `${factPack.token.symbol} 的 dev 身份。`,
                  devAiReputation: `${factPack.token.symbol} 的 AI 圈水平。`,
                  devCryptoReputation: `${factPack.token.symbol} 的币圈水平。`,
                  evidenceStrength: `${factPack.token.symbol} 的证据强度。`,
                  redFlags: `${factPack.token.symbol} 的风险。`,
                  oneLineSummary: `${factPack.token.symbol} 的一句话总结。`
                })
              }
            }
          ]
        }),
        { status: 200, headers: { 'content-type': 'application/json' } }
      );
    }
  });

  const background = generator.generate({
    row: { address: '0xslow', symbol: 'SLOW', name: 'SLOW' },
    market: {},
    sources: {},
    profile: { narrative: { details: [] }, dev: {}, sourceLinks: [] },
    priority: 'background'
  });
  await backgroundStartedGate;

  const foreground = await Promise.race([
    generator.generate({
      row: { address: '0xfast', symbol: 'FAST', name: 'FAST' },
      market: {},
      sources: {},
      profile: { narrative: { details: [] }, dev: {}, sourceLinks: [] },
      priority: 'foreground'
    }),
    delay(30).then(() => {
      throw new Error('foreground call waited behind background queue');
    })
  ]);

  releaseBackground();
  await background;

  assert.deepEqual(requests.slice(0, 2), ['0xslow', '0xfast']);
  assert.match(foreground.communityNarrative, /FAST/);
});

test('DeepSeek fact pack keeps source facts but not raw scrape payloads or secrets', () => {
  const factPack = buildDeepSeekFactPack({
    row: { address: '0xabc', symbol: 'AAA', name: 'AAA' },
    market: { pairName: 'AAA/VIRTUAL', marketCapUsd: 12345 },
    sources: {
      website: {
        url: 'https://example.com',
        markdown: 'very long raw scrape text should not be copied into the prompt '.repeat(60)
      },
      virtuals: {
        projectTwitterHandle: '@project',
        projectWebsiteUrl: 'https://project.example',
        projectMembers: [{ displayName: 'Dev One', twitterHandle: '@devone', bio: 'builder bio '.repeat(80) }]
      }
    },
    profile: {
      narrative: { category: 'AI', label: 'Virtuals AI Agent', details: [] },
      dev: { identityStatus: 'Virtuals Team确认', publicHandle: '@devone', virtualsWalletAddress: '0xabc' },
      sourceLinks: ['https://project.example']
    }
  });
  const serialized = JSON.stringify(factPack);

  assert.match(serialized, /@project|@devone|https:\/\/project\.example/);
  assert.doesNotMatch(serialized, /very long raw scrape text should not be copied/);
  assert.ok(serialized.length < 9000);
});

test('DeepSeek fact pack tolerates null optional source buckets from resolver', () => {
  const factPack = buildDeepSeekFactPack({
    row: { address: '0xde6e0fe372727db236573bf8b9f32126ea141ba3', symbol: 'zBase', name: 'zBase' },
    market: { pairName: 'zBase/WETH', marketCapUsd: 281327 },
    sources: {
      bankr: {
        url: 'https://bankr.bot/launches/0xde6e0fe372727db236573bf8b9f32126ea141ba3',
        feeRecipientHandle: '@zbase__',
        feeRecipientWallet: '0x7018a26d05b9be6b8d33abb9efc09bf38c7249cf'
      },
      virtuals: null,
      projectXProfile: null,
      github: null,
      walletOwnerSearch: null,
      website: {
        url: 'https://zbase.app/',
        title: 'Private payments for AI agents'
      }
    },
    profile: {
      narrative: { category: 'AI', label: 'ZK agent payment', details: [] },
      dev: { identityStatus: 'Fee Recipient确认', publicHandle: '@zbase__' },
      sourceLinks: ['https://zbase.app/']
    }
  });

  assert.equal(factPack.sources.bankr.feeRecipientHandle, '@zbase__');
  assert.match(factPack.sources.bankr.mechanism, /Fee Recipient|交易费用|自融资|fee.*飞轮/i);
  assert.equal(factPack.sources.virtuals, undefined);
  assert.equal(factPack.sources.github, undefined);
});

test('applies DeepSeek text without overwriting hard identity facts', () => {
  const profile = {
    narrative: {
      category: 'AI',
      label: 'Virtuals AI Agent',
      thesis: 'old thesis',
      origin: 'old origin',
      details: [
        { label: '叙事核心（社区主推版本）', value: 'old core' },
        { label: 'Dev 背书 + 社区期待', value: 'old backing' },
        { label: '风险/未确认', value: 'old risk' }
      ]
    },
    dev: {
      publicHandle: '@VictorRowanAi',
      identityStatus: 'Virtuals Team确认',
      feeRecipientWallet: null,
      virtualsWalletAddress: '0x9ba60e0acb75a730b9830fa74836e800e47a1580',
      aiLevel: 'old ai',
      cryptoLevel: 'old crypto'
    }
  };

  const next = applyDeepSeekEnhancement(profile, {
    coinIdentity: '这个 CA 是 Base 链上的 $ORION，Virtuals 体系里的 Physical AI 项目币。',
    communityNarrative: '社区主推版本：Physical AI + humanoid robotics，不是泛泛 AI 应用。',
    productOrMemeOrigin: '产品来源：OrionX Robotics 的 ARES 机器人和 video pitch。',
    whyItCanMove: '为什么有人炒：Virtuals 官方页面、团队成员和官网能互相印证。',
    devIdentity: 'Dev 身份：Victor Rowan / OrionX Robotics 项目团队。',
    devAiReputation: 'AI 圈水平：早期偏强 Physical AI builder，但不是一线模型研究员。',
    devCryptoReputation: '币圈水平：Virtuals/Base 新盘团队，crypto 履历仍早。',
    evidenceStrength: '证据强度：官方链接强，但 fee delegation 未确认。',
    redFlags: '风险：未看到 fee delegation，top holders 集中。',
    oneLineSummary: '一句话：Physical AI 早期团队盘，有资料但仍高风险。'
  });

  assert.deepEqual(
    next.narrative.details.map((item) => item.label),
    [
      '这是什么币',
      '叙事核心（社区主推版本）',
      '产品/梗来源',
      '为什么有人会炒',
      'Dev 身份',
      'Dev 在 AI 圈水平',
      'Dev 在币圈水平',
      '证据强度',
      '风险/未确认',
      '一句话总结'
    ]
  );
  assert.match(next.narrative.details[0].value, /Base 链上的 \$ORION/);
  assert.match(next.narrative.details[3].value, /为什么有人炒/);
  assert.match(next.narrative.details[5].value, /Physical AI builder/);
  assert.match(next.narrative.details[6].value, /Virtuals\/Base 新盘团队/);
  assert.equal(next.dev.aiLevel, 'AI 圈水平：早期偏强 Physical AI builder，但不是一线模型研究员。');
  assert.equal(next.dev.cryptoLevel, '币圈水平：Virtuals/Base 新盘团队，crypto 履历仍早。');
  assert.equal(next.dev.background, 'Dev 身份：Victor Rowan / OrionX Robotics 项目团队。');
  assert.equal(next.dev.publicHandle, '@VictorRowanAi');
  assert.equal(next.dev.identityStatus, 'Virtuals Team确认');
  assert.equal(next.dev.feeRecipientWallet, null);
  assert.equal(next.dev.virtualsWalletAddress, '0x9ba60e0acb75a730b9830fa74836e800e47a1580');
});

test('applies raw Grok text as original narrative and dev detail blocks', () => {
  const profile = {
    narrative: {
      category: 'Meme',
      label: 'Bankr',
      thesis: 'old thesis',
      origin: 'old origin',
      details: [{ label: '旧叙事', value: 'old core' }]
    },
    dev: {
      publicHandle: '@liamzebedee',
      identityStatus: 'Fee Recipient确认',
      aiLevel: 'old ai',
      cryptoLevel: 'old crypto'
    }
  };

  const next = applyDeepSeekEnhancement(
    profile,
    {
      rawNarrative:
        '这个 CA 是 Base 链上的 $BioNote。\n\n叙事核心：Bankr AI Agent tokenization + bio-notebook 自融资 fee 飞轮。',
      rawDev:
        '@liamzebedee 是 BioNote 的 Bankr Fee Recipient。\nAI 圈水平：偏技术 builder。\n币圈水平：Bankr/Base 新晋。'
    },
    { provider: 'grok', model: 'grok-4.3' }
  );

  assert.deepEqual(
    next.narrative.details.map((item) => item.label),
    ['叙事原文', 'Dev 背景原文']
  );
  assert.match(next.narrative.details[0].value, /Bankr AI Agent tokenization/);
  assert.match(next.narrative.details[1].value, /AI 圈水平：偏技术 builder/);
  assert.equal(next.narrative.thesis, '原文已整理，完整内容在下方。');
  assert.doesNotMatch(next.narrative.thesis, /Grok/i);
  assert.ok(next.narrative.details.every((item) => !/Grok/i.test(item.label)));
  assert.equal(next.narrative.llmProvider, 'grok');
  assert.equal(next.narrative.llmModel, 'grok-4.3');
  assert.match(next.dev.background, /@liamzebedee 是 BioNote/);
  assert.equal(next.dev.aiLevel, 'old ai');
  assert.equal(next.dev.cryptoLevel, 'old crypto');
});

test('cleans markdown emphasis and evidence-only paragraphs from raw detail blocks', () => {
  const profile = {
    narrative: {
      category: 'AI',
      label: 'Bankr',
      thesis: 'old thesis',
      origin: 'old origin',
      details: [{ label: '旧叙事', value: 'old core' }]
    },
    dev: {
      publicHandle: '@Ruemic',
      identityStatus: 'Fee Recipient确认',
      aiLevel: 'old ai',
      cryptoLevel: 'old crypto'
    }
  };

  const next = applyDeepSeekEnhancement(
    profile,
    {
      rawNarrative:
        '**这个 CA 是 Base 链上的 $BITTER。**\n\n叙事核心：社区主推 **bitter.sh / Bankr AI agent**，把匿名反馈和 AI 自动化工作流包装成 Base 上的 dev-backed 叙事。\n\n依据是 **Bankr Fee Recipient @Ruemic**（Fee Recipient URL 直接指向 https://x.com/Ruemic）和 **项目成员/创始人**（bitter.sh 项目、Bankr.bot 关联、GitHub ruemic/* 仓库）。\n\n产品来源：bitter.sh 是围绕匿名反馈、团队协作和 AI 自动化做的产品，不是纯名字 meme。',
      rawDev:
        '**dev 真实身份/handle 是 @Ruemic。**\n\n依据主要是 **Bankr Fee Recipient @Ruemic**、项目成员/创始人资料和 bitter.sh 公开入口。\n\nAI 圈：中上，偏产品型 AI builder，能把 AI 工作流接到实际协作工具里。\n\n币圈：Base/Bankr 新晋 builder，有公开 Fee Recipient 绑定，强于只有钱包的钱包盘。\n\nDeployer @hyporliquid 仅负责部署 Token（已发过 49 个 token），不是核心 dev；两个钱包（0xc2a0b33358ed101d6b4f2ab5b40d5c1f7a97c1c0 和 0x0c7e483f60163cbd9aa24e85a7ab9cd9fe1b82e0）在 X 上未搜索到明确归属线索，无法直接关联为 dev 身份。'
    },
    { provider: 'grok', model: 'grok-4.3' }
  );

  const narrative = next.narrative.details.find((item) => item.label === '叙事原文')?.value || '';
  const dev = next.narrative.details.find((item) => item.label === 'Dev 背景原文')?.value || '';
  const combined = `${narrative}\n${dev}`;

  assert.doesNotMatch(combined, /\*\*/);
  assert.doesNotMatch(combined, /依据是/);
  assert.doesNotMatch(combined, /依据主要是/);
  assert.doesNotMatch(combined, /Deployer @hyporliquid/);
  assert.doesNotMatch(combined, /两个钱包/);
  assert.match(narrative, /这个 CA 是 Base 链上的 \$BITTER/);
  assert.match(narrative, /叙事核心：社区主推 bitter\.sh \/ Bankr AI agent/);
  assert.match(dev, /dev 真实身份\/handle 是 @Ruemic/);
  assert.match(dev, /AI 圈：中上/);
  assert.match(dev, /币圈：Base\/Bankr 新晋 builder/);
});

test('cleans inline evidence noise without removing dev reputation sections', () => {
  const profile = {
    narrative: {
      category: 'AI',
      label: 'Bankr',
      thesis: 'old thesis',
      origin: 'old origin',
      details: []
    },
    dev: {
      publicHandle: '@Ruemic',
      identityStatus: 'Fee Recipient确认'
    }
  };

  const next = applyDeepSeekEnhancement(
    profile,
    {
      rawDev:
        'dev 真实身份/handle 是 @Ruemic（Ruemic）。 依据是 Bankr Fee Recipient @Ruemic（Fee Recipient URL 直接指向 https://x.com/Ruemic）和项目成员/创始人资料，同时 GitHub ruemic 仓库也能对应。两个钱包（0xc2a0b33358ed101d6b4f2ab5b40d5c1f7a97c1c0 和 0x0c7e483f60163cbd9aa24e85a7ab9cd9fe1b82e0）在 X 搜索中未找到明确公开归属线索，无法直接等同 dev 名字。 AI 圈：小众但活跃的独立 builder，属于三线/新兴梯队。 币圈：新晋 builder，不是 KOL。'
    },
    { provider: 'grok', model: 'grok-4.3' }
  );

  const dev = next.narrative.details.find((item) => item.label === 'Dev 背景原文')?.value || '';

  assert.match(dev, /dev 真实身份\/handle 是 @Ruemic/);
  assert.match(dev, /AI 圈：小众但活跃的独立 builder/);
  assert.match(dev, /币圈：新晋 builder/);
  assert.doesNotMatch(dev, /依据是/);
  assert.doesNotMatch(dev, /两个钱包/);
  assert.doesNotMatch(dev, /未找到明确公开归属线索/);
});

test('merges raw narrative and dev text when they arrive in separate partial updates', () => {
  const profile = {
    narrative: {
      category: 'Meme',
      label: 'Bankr',
      thesis: 'old thesis',
      origin: 'old origin',
      details: [{ label: '旧叙事', value: 'old core' }]
    },
    dev: {
      publicHandle: null,
      identityStatus: '未确认',
      background: 'old dev background'
    }
  };

  const withNarrative = applyDeepSeekEnhancement(
    profile,
    {
      rawNarrative:
        '这个 CA 是 Base 链上的 $AAA。\n\n叙事核心：社区主推 Bankr AI Agent tokenization + fee 自融资飞轮。'
    },
    { provider: 'grok', model: 'grok-4.3' }
  );
  const withBoth = applyDeepSeekEnhancement(
    withNarrative,
    {
      rawDev:
        '没有找到 Bankr Fee Recipient、Virtuals delegate 或接收钱包线索，暂时不能确认 dev。\n\nAI 圈水平：未确认。\n币圈水平：未确认。'
    },
    { provider: 'grok', model: 'grok-4.3' }
  );

  assert.deepEqual(
    withBoth.narrative.details.map((item) => item.label),
    ['叙事原文', 'Dev 背景原文']
  );
  assert.match(withBoth.narrative.details[0].value, /Bankr AI Agent tokenization/);
  assert.match(withBoth.narrative.details[1].value, /没有找到 Bankr Fee Recipient、Virtuals delegate 或接收钱包线索/);
  assert.match(withBoth.narrative.origin, /Bankr AI Agent tokenization/);
  assert.match(withBoth.narrative.origin, /暂时不能确认 dev/);
});

test('merges raw dev and narrative text when dev arrives before narrative', () => {
  const profile = {
    narrative: {
      category: 'Meme',
      label: 'Bankr',
      thesis: 'old thesis',
      origin: 'old origin',
      details: [{ label: '旧叙事', value: 'old core' }]
    },
    dev: {
      publicHandle: '@builder',
      identityStatus: 'Fee Recipient确认'
    }
  };

  const withDev = applyDeepSeekEnhancement(
    profile,
    {
      rawDev:
        '@builder 是 Bankr Fee Recipient。\n\nAI 圈水平：中上开源 builder。\n币圈水平：Base 新晋关注对象。'
    },
    { provider: 'grok', model: 'grok-4.3' }
  );
  const withBoth = applyDeepSeekEnhancement(
    withDev,
    {
      rawNarrative:
        '这个 CA 是 Base 链上的 $AAA。\n\n叙事核心：社区主推 AI coding agent + Bankr fee flywheel。'
    },
    { provider: 'grok', model: 'grok-4.3' }
  );

  assert.deepEqual(
    withBoth.narrative.details.map((item) => item.label),
    ['叙事原文', 'Dev 背景原文']
  );
  assert.match(withBoth.narrative.details[0].value, /AI coding agent/);
  assert.match(withBoth.narrative.details[1].value, /@builder 是 Bankr Fee Recipient/);
  assert.match(withBoth.dev.background, /@builder 是 Bankr Fee Recipient/);
});

test('Grok narrative generator can generate narrative and dev parts independently', async () => {
  const requests = [];
  const formatInputs = [];
  const formatter = {
    enabled: true,
    async format(input) {
      formatInputs.push(input);
      return {
        ...input,
        rawNarrative: input.rawNarrative ? `${input.rawNarrative}\n\n排版完成。` : null,
        rawDev: input.rawDev ? `${input.rawDev}\n\n排版完成。` : null,
        rawFormatted: true
      };
    }
  };
  const generator = new GrokNarrativeGenerator({
    apiKey: 'test-grok-key',
    baseUrl: 'https://api.vip.crond.dev/v1',
    model: 'grok-4.3',
    rawFormatter: formatter,
    fetchImpl: async (url, options) => {
      requests.push({ url, options });
      const body = JSON.parse(options.body);
      const prompt = body.input?.[1]?.content || '';
      if (/这个ca是什么叙事/i.test(prompt)) {
        return new Response(JSON.stringify({ output_text: '这个 CA 是 Base 链上的 $AAA，社区主推 AI agent meme。' }), {
          status: 200,
          headers: { 'content-type': 'application/json' }
        });
      }
      if (/这个 dev 是谁/i.test(prompt)) {
        return new Response(JSON.stringify({ output_text: '@builder 是 Fee Recipient，AI 圈中上，币圈新晋。' }), {
          status: 200,
          headers: { 'content-type': 'application/json' }
        });
      }
      throw new Error('unexpected prompt');
    }
  });

  const input = {
    row: { address: '0xabc', symbol: 'AAA', name: 'AAA' },
    market: {},
    sources: {
      bankr: {
        feeRecipientHandle: '@builder',
        feeRecipientWallet: '0x1111111111111111111111111111111111111111'
      }
    },
    profile: { narrative: { details: [] }, dev: { publicHandle: '@builder' }, sourceLinks: [] }
  };

  const narrative = await generator.generatePart({ ...input, part: 'narrative' });
  const dev = await generator.generatePart({ ...input, part: 'dev' });

  assert.equal(requests.length, 2);
  assert.match(JSON.parse(requests[0].options.body).input[1].content, /这个ca是什么叙事/);
  assert.match(JSON.parse(requests[1].options.body).input[1].content, /这个 dev 是谁/);
  assert.equal(formatInputs.length, 2);
  assert.equal(formatInputs[0].rawDev, undefined);
  assert.equal(formatInputs[1].rawNarrative, undefined);
  assert.match(narrative.rawNarrative, /排版完成/);
  assert.equal(narrative.rawDev, undefined);
  assert.match(dev.rawDev, /排版完成/);
  assert.equal(dev.rawNarrative, undefined);
  assert.deepEqual(getNarrativeMetadata(narrative), {
    provider: 'grok',
    model: 'grok-4.3',
    part: 'narrative'
  });
  assert.deepEqual(getNarrativeMetadata(dev), {
    provider: 'grok',
    model: 'grok-4.3',
    part: 'dev'
  });
});

test('Grok dev part reports missing Bankr or Virtuals receiver when code finds no recipient signal', async () => {
  const requests = [];
  const generator = new GrokNarrativeGenerator({
    apiKey: 'test-grok-key',
    baseUrl: 'https://api.vip.crond.dev/v1',
    model: 'grok-4.3',
    fetchImpl: async (url, options) => {
      requests.push({ url, options });
      return new Response(JSON.stringify({ output_text: 'dev search failed with HTTP 503; 搜索失败，只能使用 factPack。' }), {
        status: 200,
        headers: { 'content-type': 'application/json' }
      });
    }
  });

  const result = await generator.generatePart({
    part: 'dev',
    row: { address: '0xabc', symbol: 'AAA', name: 'AAA' },
    market: {},
    sources: {},
    profile: { narrative: { details: [] }, dev: { identityStatus: '未确认' }, sourceLinks: [] }
  });

  assert.equal(requests.length, 1);
  assert.match(result.rawDev, /没有找到 Bankr Fee Recipient、Virtuals delegate 或接收钱包线索/);
  assert.match(result.rawDev, /暂时不能确认 dev/);
});

test('Grok dev fallback uses confirmed Fee Recipient instead of saying dev is missing', async () => {
  const generator = new GrokNarrativeGenerator({
    apiKey: 'test-grok-key',
    baseUrl: 'https://api.vip.crond.dev/v1',
    model: 'grok-4.3',
    fetchImpl: async () =>
      new Response(JSON.stringify({ output_text: 'dev search failed with HTTP 503; 搜索失败，只能使用 factPack。' }), {
        status: 200,
        headers: { 'content-type': 'application/json' }
      })
  });

  const result = await generator.generatePart({
    part: 'dev',
    row: { address: '0xhalo', symbol: 'HALO', name: 'Halo' },
    market: {},
    sources: {
      bankr: {
        feeRecipientHandle: '@HireHalo',
        feeRecipientWallet: '0x9b5f690bc146e557ed8f2eb64ca991de8cc05da9'
      }
    },
    profile: {
      narrative: { details: [] },
      dev: {
        identityStatus: 'Fee Recipient确认',
        publicHandle: '@HireHalo',
        feeRecipientHandle: '@HireHalo',
        feeRecipientWallet: '0x9b5f690bc146e557ed8f2eb64ca991de8cc05da9',
        who:
          'Bankr launch 的 Fee Recipient 直接指向 @HireHalo，这是当前最硬的 dev/收益接收方线索。对应收款钱包是 0x9b5f690bc146e557ed8f2eb64ca991de8cc05da9。',
        aiLevel: '小号/新号：项目资料有 AI 产品线索，但账号只有约 80粉，dev 本人在 AI 圈知名度和履历未确认，先按早期项目号看。',
        cryptoLevel: '三线/早期：Bankr Fee Recipient 绑定 @HireHalo，比只有钱包地址清楚。'
      },
      sourceLinks: []
    }
  });

  assert.match(result.rawDev, /@HireHalo/);
  assert.match(result.rawDev, /Fee Recipient 直接指向 @HireHalo/);
  assert.match(result.rawDev, /AI 圈水平：小号\/新号/);
  assert.match(result.rawDev, /币圈水平：三线\/早期/);
  assert.doesNotMatch(result.rawDev, /没有找到 Bankr Fee Recipient、Virtuals delegate 或接收钱包线索/);
  assert.doesNotMatch(result.rawDev, /因此暂时不能确认 dev 是谁/);
});

test('Grok dev part keeps missing receiver notice even when search returns only a project account', async () => {
  const formatInputs = [];
  const formatter = {
    enabled: true,
    async format(input) {
      formatInputs.push(input);
      return {
        rawDev: '@ProjectAccount 是项目号，公开资料里没看到个人 dev 背景。',
        rawFormatted: true
      };
    }
  };
  const generator = new GrokNarrativeGenerator({
    apiKey: 'test-grok-key',
    baseUrl: 'https://api.vip.crond.dev/v1',
    model: 'grok-4.3',
    rawFormatter: formatter,
    fetchImpl: async () =>
      new Response(
        JSON.stringify({
          output_text: '@ProjectAccount 是项目号，公开资料里没看到个人 dev 背景。'
        }),
        {
          status: 200,
          headers: { 'content-type': 'application/json' }
        }
      )
  });

  const result = await generator.generatePart({
    part: 'dev',
    row: { address: '0xabc', symbol: 'AAA', name: 'AAA' },
    market: {},
    sources: {
      xProfile: {
        handle: '@ProjectAccount'
      }
    },
    profile: {
      narrative: { details: [] },
      dev: { identityStatus: '项目账号确认', publicHandle: '@ProjectAccount' },
      sourceLinks: []
    }
  });

  assert.equal(formatInputs.length, 1);
  assert.match(formatInputs[0].rawDev, /没有找到 Bankr Fee Recipient、Virtuals delegate 或接收钱包线索/);
  assert.match(result.rawDev, /没有找到 Bankr Fee Recipient、Virtuals delegate 或接收钱包线索/);
  assert.match(result.rawDev, /@ProjectAccount 是项目号/);
});

test('rejects generic DeepSeek narratives that do not explain the coin clearly', () => {
  const profile = {
    narrative: {
      category: 'AI',
      label: 'AI 应用',
      thesis: 'old thesis',
      origin: 'old origin',
      details: [{ label: '叙事核心（社区主推版本）', value: 'specific rule core' }]
    },
    dev: {
      aiLevel: 'specific ai reputation',
      cryptoLevel: 'specific crypto reputation'
    }
  };

  const next = applyDeepSeekEnhancement(profile, {
    coinIdentity: '$openagent 是 Base 链上的 AI 应用代币。',
    communityNarrative:
      '$openagent 的叙事核心是 AI 应用/agent 工作流：公开资料指向 agent、automation、research、inference、workflow 或 model routing。',
    productOrMemeOrigin: '公开资料显示其涉及 automation/research/inference。',
    whyItCanMove: '具有一定潜力，值得关注。',
    devAiReputation: '高。项目直接聚焦 AI agent 工作流。',
    devCryptoReputation: '高。项目部署在 Base 链上。',
    redFlags: '仍需关注风险。'
  });

  assert.equal(next.narrative.details[0].value, 'specific rule core');
  assert.equal(next.dev.aiLevel, 'specific ai reputation');
  assert.equal(next.dev.cryptoLevel, 'specific crypto reputation');
});

test('rejects Grok narratives that leak community search failures into the core story', () => {
  const profile = {
    narrative: {
      category: 'Meme',
      label: 'Meme',
      thesis: 'old thesis',
      origin: 'old origin',
      details: [{ label: '叙事核心（社区主推版本）', value: 'specific cached community narrative' }]
    },
    dev: {
      aiLevel: 'specific ai reputation',
      cryptoLevel: 'specific crypto reputation'
    }
  };

  const next = applyDeepSeekEnhancement(profile, {
    coinIdentity: '这个 CA 是 Base 链上的 $BioNote，Bankr 发射盘。',
    communityNarrative:
      '社区主推 Bankr tokenization 的 bio-notebook，但 communityContext 搜索失败，只能使用 factPack。',
    productOrMemeOrigin: '产品/梗来源：community search failed，缺少 X/scanner 实时语境。',
    whyItCanMove: '为什么有人会炒：搜索失败所以没有 KOL 背书。',
    devIdentity: 'Dev 身份：Fee Recipient 指向公开钱包。',
    devAiReputation: 'AI 圈水平：早期 builder。',
    devCryptoReputation: '币圈水平：早期 builder。',
    evidenceStrength: '证据强度：搜索失败，只有 factPack。',
    redFlags: '风险：缺少实时社区语境。',
    oneLineSummary: '一句话：搜索失败的 Bankr meme。'
  });

  assert.equal(next.narrative.details[0].value, 'specific cached community narrative');
  assert.equal(next.dev.aiLevel, 'specific ai reputation');
  assert.equal(next.dev.cryptoLevel, 'specific crypto reputation');
});

test('rejects Grok narratives that leak rewritten internal context names', () => {
  const profile = {
    narrative: {
      category: 'Meme',
      label: 'Meme',
      thesis: 'old thesis',
      origin: 'old origin',
      details: [{ label: '叙事核心（社区主推版本）', value: 'specific cached community narrative' }]
    },
    dev: {
      aiLevel: 'specific ai reputation',
      cryptoLevel: 'specific crypto reputation'
    }
  };

  const next = applyDeepSeekEnhancement(profile, {
    coinIdentity: '这个 CA 是 Base 链上的 $ORBIT，是 Bankr 发射的 meme 盘。',
    communityNarrative:
      '社区主推版本是名字、图标与社群情绪驱动，但 社区搜索上下文 叙事搜索失败，硬证据 也没有抓到明确产品锚点。',
    productOrMemeOrigin:
      '硬证据 显示公开资料里没找到足够明确的原梗、原人物、首发推文或稳定传播源头。',
    whyItCanMove: '为什么有人会炒：Bankr 发射机制和当前成交量提供情绪传播基础。',
    devIdentity: 'Dev 身份：硬证据 明确公开身份背景未确认。',
    devAiReputation: '未确认',
    devCryptoReputation: '未确认',
    evidenceStrength: '硬证据较弱。',
    redFlags: '风险：dev 身份完全未确认。',
    oneLineSummary: '$ORBIT 是 Bankr 上的名字情绪驱动 meme。'
  });

  assert.equal(next.narrative.details[0].value, 'specific cached community narrative');
  assert.equal(next.dev.aiLevel, 'specific ai reputation');
  assert.equal(next.dev.cryptoLevel, 'specific crypto reputation');
});
