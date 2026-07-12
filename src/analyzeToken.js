function safeNumber(value) {
  if (value === null || value === undefined || value === '') {
    return null;
  }
  const number = Number(value);
  return Number.isFinite(number) ? number : null;
}

function normalizeText(value) {
  return String(value || '').toLowerCase();
}

function detectNarrative(row, market) {
  const text = [
    row.symbol,
    row.name,
    row.groupName,
    ...(market.websites || []).map((item) => item.url),
    ...(market.socials || []).map((item) => item.url)
  ]
    .map(normalizeText)
    .join(' ');

  const hasKeyword = (keywords) => keywords.some((keyword) => text.includes(keyword));

  if (hasKeyword(['ai', 'gpt', 'llm', 'agent', 'gemma', 'model', 'multimodal', 'huggingface', 'vision'])) {
    return {
      label: 'AI模型',
      description: '更像 AI 模型、Agent 或开源模型热点映射出来的叙事。'
    };
  }

  if (hasKeyword(['swap', 'dex', 'yield', 'vault', 'perp', 'stake', 'bridge', 'finance'])) {
    return {
      label: 'DeFi',
      description: '更像 DeFi 工具、交易或收益协议方向。'
    };
  }

  if (hasKeyword(['chain', 'layer', 'rollup', 'oracle', 'data', 'cloud', 'gpu', 'infra'])) {
    return {
      label: 'Infra',
      description: '更像链上基础设施、数据或算力题材。'
    };
  }

  return {
    label: 'Meme',
    description: '更像名字和情绪驱动的 meme 盘。'
  };
}

function formatMoney(value) {
  if (value === null) {
    return '-';
  }
  if (value >= 1000000) {
    return `$${(value / 1000000).toFixed(2)}M`;
  }
  if (value >= 1000) {
    return `$${(value / 1000).toFixed(0)}K`;
  }
  return `$${value.toFixed(0)}`;
}

function buildSummary({ verdict, narrative, strengths, risks }) {
  if (verdict === '偏强') {
    return `这枚币目前更像${narrative.label}叙事，短线资金承接和公开热度都不差，但依然是交易盘逻辑，后手要防拥挤回撤。`;
  }
  if (verdict === '中性') {
    return `这枚币有一定${narrative.label}故事，但强信号还不够集中，当前更适合观察而不是直接下结论。`;
  }
  if (verdict === '偏弱') {
    return `这枚币能讲一点${narrative.label}故事，不过支撑它继续走强的证据偏少，更多像普通轮动标的。`;
  }
  if (risks.length > strengths.length) {
    return `这枚币当前更偏高风险交易，${narrative.label}故事不算扎实，流动性和公开资料都不足，容易出现冲高回落。`;
  }
  return `这枚币现在更像高风险试错盘，虽然有${narrative.label}壳子，但暂时看不到足够强的持续性信号。`;
}

export function buildTokenAnalysis({ row, market = {} }) {
  const snapshot = {
    avgWalletVolume: safeNumber(row.avgWalletVolume),
    walletCount: safeNumber(row.walletCount),
    liquidityUsd: safeNumber(market.liquidityUsd ?? row.liquidityUsd),
    volume24h: safeNumber(market.volume24h ?? row.volume24h),
    holders: safeNumber(market.holders ?? row.holders),
    priceChange24h: safeNumber(market.priceChange24h ?? row.priceChange24h),
    marketCapUsd: safeNumber(market.marketCapUsd ?? row.marketCapUsd),
    buys24h: safeNumber(market.buys24h),
    sells24h: safeNumber(market.sells24h)
  };

  const marketWebsites = Array.isArray(market.websites) ? market.websites : [];
  const marketSocials = Array.isArray(market.socials) ? market.socials : [];
  const narrative = detectNarrative(row, market);

  let score = 50;
  const strengths = [];
  const risks = [];
  const evidence = [];

  if (snapshot.walletCount !== null) {
    evidence.push(`信号钱包数 ${snapshot.walletCount}`);
    if (snapshot.walletCount >= 3) {
      score += 10;
      strengths.push(`短时间内出现 ${snapshot.walletCount} 个聪明钱包，说明不是单点拉盘。`);
    } else if (snapshot.walletCount === 2) {
      score += 5;
      strengths.push('出现了 2 个同步动作的钱包，至少说明这不是完全孤立的买单。');
    } else if (snapshot.walletCount <= 1) {
      score -= 4;
      risks.push('触发信号的钱包太少，更像单点试仓，跟风价值有限。');
    }
  }

  if (snapshot.avgWalletVolume !== null) {
    evidence.push(`平均聪明钱金额 ${formatMoney(snapshot.avgWalletVolume)}`);
    if (snapshot.avgWalletVolume >= 700) {
      score += 8;
      strengths.push(`聪明钱平均打进来的金额接近 ${formatMoney(snapshot.avgWalletVolume)}，不是很轻的测试单。`);
    } else if (snapshot.avgWalletVolume >= 300) {
      score += 4;
      strengths.push('聪明钱单笔规模还可以，说明买盘不是纯噪音。');
    } else if (snapshot.avgWalletVolume > 0 && snapshot.avgWalletVolume < 80) {
      score -= 5;
      risks.push('聪明钱单笔金额偏小，更像试单，不像强势主推。');
    }
  }

  if (snapshot.liquidityUsd !== null) {
    evidence.push(`流动性 ${formatMoney(snapshot.liquidityUsd)}`);
    if (snapshot.liquidityUsd >= 500000) {
      score += 12;
      strengths.push(`主池流动性约 ${formatMoney(snapshot.liquidityUsd)}，短线进出相对顺畅。`);
    } else if (snapshot.liquidityUsd >= 150000) {
      score += 8;
      strengths.push('流动性处在能承接短线交易的区间，不算太脆。');
    } else if (snapshot.liquidityUsd >= 50000) {
      score += 3;
    } else if (snapshot.liquidityUsd < 10000) {
      score -= 14;
      risks.push(`流动性只有 ${formatMoney(snapshot.liquidityUsd)} 左右，退出难度很高，容易被砸穿。`);
    } else {
      score -= 7;
      risks.push('流动性偏薄，承接能力一般，容易放大波动。');
    }
  }

  if (snapshot.volume24h !== null && snapshot.liquidityUsd !== null && snapshot.liquidityUsd > 0) {
    const turnover = snapshot.volume24h / snapshot.liquidityUsd;
    evidence.push(`24h成交 ${formatMoney(snapshot.volume24h)}`);
    if (turnover >= 3) {
      score += 8;
      strengths.push('成交额明显高于池子深度，说明这枚币当前有真实交易关注度。');
    } else if (turnover >= 1) {
      score += 4;
      strengths.push('成交和流动性匹配得还可以，说明不是死盘。');
    } else if (turnover < 0.25) {
      score -= 5;
      risks.push('成交和流动性都偏弱，更像没人接力的冷盘。');
    }
  }

  if (snapshot.holders !== null) {
    evidence.push(`持有人 ${snapshot.holders}`);
    if (snapshot.holders >= 1000) {
      score += 6;
      strengths.push(`持有人已经过千，至少说明它不是完全没人知道的新壳。`);
    } else if (snapshot.holders >= 300) {
      score += 3;
    } else if (snapshot.holders < 100) {
      score -= 8;
      risks.push('持有人太少，盘子更容易被少数人控制。');
    }
  }

  if (snapshot.priceChange24h !== null) {
    evidence.push(`24h涨跌 ${snapshot.priceChange24h.toFixed(2)}%`);
    if (snapshot.priceChange24h >= 8 && snapshot.priceChange24h <= 120) {
      score += 6;
      strengths.push('涨幅还在相对健康的扩散区间，说明热度在发酵。');
    } else if (snapshot.priceChange24h > 150) {
      score -= 6;
      risks.push('24 小时涨幅已经很夸张，后手追高容易接最后一棒。');
    } else if (snapshot.priceChange24h < -20) {
      score -= 8;
      risks.push('价格已经明显转弱，说明承接可能在下降。');
    }
  }

  const hasPublicLinks = marketWebsites.length > 0 || marketSocials.length > 0;
  if (hasPublicLinks) {
    score += 4;
    strengths.push('至少能找到公开入口，说明它不是完全黑盒子。');
  } else {
    score -= 8;
    risks.push('几乎没有独立站或社媒入口，公开资料太少，真假叙事都不好验证。');
  }

  const onlySocialLinks =
    hasPublicLinks &&
    marketWebsites.every((item) => /x\.com|twitter\.com/.test(normalizeText(item.url))) &&
    marketSocials.every((item) => /x\.com|twitter\.com/.test(normalizeText(item.url)));
  if (onlySocialLinks) {
    score -= 2;
    risks.push('公开入口主要还是社媒，没有独立站或完整项目资料，故事验证链比较短。');
  }

  if (narrative.label === 'AI模型') {
    score += 6;
    strengths.push('名字和公开入口都指向 AI 模型/Agent 题材，这类叙事在 Base 上更容易被市场理解。');
  } else if (narrative.label === 'Meme') {
    score -= 2;
    risks.push('它更像情绪和名字驱动，持续性通常比不上有明确热点锚点的币。');
  }

  if (snapshot.buys24h !== null && snapshot.sells24h !== null) {
    const totalTrades = snapshot.buys24h + snapshot.sells24h;
    evidence.push(`24h买卖笔数 ${snapshot.buys24h}/${snapshot.sells24h}`);
    if (totalTrades >= 40 && snapshot.sells24h > snapshot.buys24h * 1.4) {
      score -= 5;
      risks.push('卖盘和换手都很重，后手追涨容易遇到拥挤回撤。');
    } else if (totalTrades >= 40 && snapshot.buys24h >= snapshot.sells24h * 0.9) {
      score += 4;
      strengths.push('买卖笔数比较均衡，说明不是纯出货结构。');
    }
  }

  if (
    snapshot.marketCapUsd !== null &&
    snapshot.liquidityUsd !== null &&
    snapshot.liquidityUsd > 0 &&
    snapshot.marketCapUsd / snapshot.liquidityUsd > 20
  ) {
    score -= 4;
    risks.push('市值和流动性的比例偏高，稍微一波砸盘就会让价格很难看。');
  }

  score = Math.max(0, Math.min(100, Math.round(score)));

  let verdict = '中性';
  if (score >= 72) {
    verdict = '偏强';
  } else if (score >= 55) {
    verdict = '中性';
  } else if (score >= 40) {
    verdict = '偏弱';
  } else {
    verdict = '高风险';
  }

  const signalCount = [
    snapshot.walletCount,
    snapshot.avgWalletVolume,
    snapshot.liquidityUsd,
    snapshot.volume24h,
    snapshot.holders,
    snapshot.priceChange24h,
    snapshot.buys24h,
    snapshot.sells24h
  ].filter((value) => value !== null).length;
  const confidence = signalCount >= 7 ? '高' : signalCount >= 4 ? '中' : '低';

  return {
    address: row.address,
    verdict,
    score,
    confidence,
    narrative,
    summary: buildSummary({ verdict, narrative, strengths, risks }),
    strengths,
    risks,
    evidence
  };
}
