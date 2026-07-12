import test from 'node:test';
import assert from 'node:assert/strict';

import { buildTokenAnalysis } from '../src/analyzeToken.js';

test('rates a healthy AI-model signal as 偏强 and explains the strength', () => {
  const analysis = buildTokenAnalysis({
    row: {
      address: '0x572c4fa77623652411574c51b5ddb7e1b750aba3',
      symbol: 'SUPERGEMMA',
      name: 'Supergemma4-26b-multimodal',
      groupName: 'SmartMoney#700金额5分钟3钱包#150K',
      walletCount: 3,
      avgWalletVolume: 798.14,
      priceUsd: 0.00002429,
      marketCapUsd: 2429477,
      holders: 1672,
      liquidityUsd: 619177.84,
      volume24h: 3470388.83,
      priceChange24h: 48.24
    },
    market: {
      websites: [{ url: 'https://x.com/jun_song/status/2043264230464618545' }],
      socials: [{ type: 'twitter', url: 'https://x.com/jun_song/status/2057688480025813065' }],
      buys24h: 4293,
      sells24h: 7486
    }
  });

  assert.equal(analysis.verdict, '偏强');
  assert.equal(analysis.narrative.label, 'AI模型');
  assert.ok(analysis.score >= 72);
  assert.match(analysis.summary, /AI|模型|Gemma/i);
  assert.ok(analysis.strengths.some((item) => /聪明钱|钱包/.test(item)));
  assert.ok(analysis.strengths.some((item) => /流动性|成交/.test(item)));
  assert.ok(analysis.risks.some((item) => /卖盘|换手|拥挤/.test(item)));
});

test('marks thin unsupported tokens as 高风险 instead of writing a bullish story', () => {
  const analysis = buildTokenAnalysis({
    row: {
      address: '0xdead',
      symbol: 'MOONCAT',
      name: 'Moon Cat',
      groupName: 'Fresh token',
      walletCount: 1,
      avgWalletVolume: 28,
      priceUsd: 0.0000012,
      marketCapUsd: 4200000,
      holders: 54,
      liquidityUsd: 7800,
      volume24h: 1900,
      priceChange24h: 163
    },
    market: {
      websites: [],
      socials: [],
      buys24h: 18,
      sells24h: 43
    }
  });

  assert.equal(analysis.verdict, '高风险');
  assert.equal(analysis.narrative.label, 'Meme');
  assert.ok(analysis.score < 40);
  assert.ok(analysis.risks.some((item) => /流动性|退出/.test(item)));
  assert.ok(analysis.risks.some((item) => /没有独立站|社媒|公开入口/.test(item)));
  assert.ok(!/偏强/.test(analysis.summary));
});
