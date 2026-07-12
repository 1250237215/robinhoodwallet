function normalizeText(value) {
  return String(value || '');
}

function safeNumber(value) {
  if (value === null || value === undefined || value === '') {
    return null;
  }
  const number = Number(String(value).replace(/,/g, ''));
  return Number.isFinite(number) ? number : null;
}

function snippet(value, maxLength = 700) {
  const text = normalizeText(value).replace(/\s+/g, ' ').trim();
  return text.length > maxLength ? `${text.slice(0, maxLength - 1)}…` : text;
}

function rawSnippet(value, maxLength = 5000) {
  const text = normalizeText(value)
    .replace(/\r\n/g, '\n')
    .replace(/[ \t]+\n/g, '\n')
    .replace(/\n{4,}/g, '\n\n\n')
    .trim();
  return text.length > maxLength ? `${text.slice(0, maxLength - 1)}…` : text;
}

function stripMarkdownEmphasis(value) {
  return normalizeText(value)
    .replace(/\*\*([^*\n]+)\*\*/g, '$1')
    .replace(/__([^_\n]+)__/g, '$1');
}

function removeInlineEvidenceNoise(value) {
  const sectionLookahead =
    '(?=\\s*(?:AI\\s*[圈方向水平：:]|币圈|Crypto\\s*[圈方向水平：:]|Dev\\s*在|产品(?:\\/梗)?来源[：:]|叙事(?:核心)?[：:]|为什么|风险|一句话|$))';
  return normalizeText(value)
    .replace(new RegExp(`\\s*依据(?:主要)?是[\\s\\S]*?${sectionLookahead}`, 'gi'), ' ')
    .replace(
      /\s*(?:Deployer|deployer|部署者)\b[\s\S]*?(?:仅负责部署\s*Token|不是核心\s*dev|不是核心开发者|无法直接关联为\s*dev\s*身份)[^。\n]*(?:。|$)/gi,
      ' '
    )
    .replace(
      /\s*(?:两个|这些|以上)?钱包[（(][\s\S]*?(?:无法直接|无法关联|未搜索到|没有搜到|没有明确归属|未确认归属)[^。\n]*(?:。|$)/gi,
      ' '
    )
    .replace(/[ \t]{2,}/g, ' ')
    .replace(/[ \t]+\n/g, '\n')
    .replace(/\n[ \t]+/g, '\n')
    .trim();
}

function isEvidenceOnlyParagraph(value) {
  const text = normalizeText(value).trim();
  if (!text) {
    return true;
  }
  return (
    /^依据(?:主要)?是[：:\s]/i.test(text) ||
    /^(?:Deployer|deployer|部署者)\b/i.test(text) ||
    /^(?:两个|这些|以上)?钱包[（(]?[\s\S]*0x[a-fA-F0-9]{40}[\s\S]*(?:无法直接|无法关联|未搜索到|没有搜到|没有明确归属|未确认归属)/i.test(
      text
    )
  );
}

function cleanRawGrokText(value) {
  return removeInlineEvidenceNoise(stripMarkdownEmphasis(value))
    .split(/\n{2,}/)
    .map((paragraph) => paragraph.trim())
    .filter((paragraph) => paragraph && !isEvidenceOnlyParagraph(paragraph))
    .join('\n\n')
    .trim();
}

function asArray(value) {
  return Array.isArray(value) ? value : [];
}

function unique(items) {
  return [...new Set(items.filter(Boolean))];
}

function compactObject(value) {
  if (Array.isArray(value)) {
    return value.map(compactObject).filter((item) => item !== null && item !== undefined);
  }
  if (value && typeof value === 'object') {
    const result = {};
    for (const [key, item] of Object.entries(value)) {
      const compacted = compactObject(item);
      if (compacted === null || compacted === undefined || compacted === '') {
        continue;
      }
      if (Array.isArray(compacted) && !compacted.length) {
        continue;
      }
      result[key] = compacted;
    }
    return result;
  }
  return value;
}

function sourceType(sources = {}, market = {}) {
  if (sources.bankr?.url) {
    return 'bankr';
  }
  if (sources.virtuals?.prototypeAddress) {
    return 'virtuals-prototype';
  }
  if (
    sources.virtuals?.id ||
    sources.gecko?.categoryIds?.includes?.('virtuals-protocol') ||
    normalizeText(market.quoteTokenSymbol).toUpperCase() === 'VIRTUAL'
  ) {
    return 'virtuals';
  }
  return 'unknown';
}

function limitedEvidence(profile) {
  return asArray(profile?.evidence)
    .filter((item) => !/raw scrape|cursor text|dirty source/i.test(item))
    .map((item) => snippet(item, 320))
    .slice(0, 18);
}

function virtualsFacts(virtuals = {}) {
  if (!virtuals) {
    return null;
  }

  return compactObject({
    url: virtuals.url,
    id: virtuals.id,
    prototypeAddress: virtuals.prototypeAddress,
    category: virtuals.category,
    factory: virtuals.factory,
    launchedAt: virtuals.launchedAt,
    projectTwitterHandle: virtuals.projectTwitterHandle,
    projectTwitterUrl: virtuals.projectTwitterUrl,
    projectWebsiteUrl: virtuals.projectWebsiteUrl,
    videoPitchTweetUrl: virtuals.videoPitchTweetUrl,
    creatorTwitterHandle: virtuals.creatorTwitterHandle,
    creatorTwitterUrl: virtuals.creatorTwitterUrl,
    virtualsWalletAddress: virtuals.virtualsWalletAddress,
    feeDelegationType: virtuals.feeDelegationType,
    feeDelegatedRecipient: virtuals.feeDelegatedRecipient,
    feeDelegationClaimed: virtuals.feeDelegationClaimed,
    feeDelegationVaultAddress: virtuals.feeDelegationVaultAddress,
    isVerified: virtuals.isVerified,
    isDevCommitted: virtuals.isDevCommitted,
    holderCount: safeNumber(virtuals.holderCount),
    top10HolderPercentage: safeNumber(virtuals.top10HolderPercentage),
    description: snippet(virtuals.description, 900),
    overview: snippet(virtuals.overview, 700),
    tokenUtility: snippet(virtuals.tokenUtility, 700),
    roadmap: snippet(virtuals.roadmap, 700),
    additionalDetails: snippet(virtuals.additionalDetails, 900),
    projectMembers: asArray(virtuals.projectMembers)
      .map((member) =>
        compactObject({
          name: member.displayName,
          title: member.title,
          x: member.twitterHandle,
          xUrl: member.twitterUrl,
          github: member.githubUsername,
          githubUrl: member.githubUrl,
          telegram: member.telegramHandle,
          bio: snippet(member.bio, 500)
        })
      )
      .slice(0, 6)
  });
}

function bankrFacts(bankr = {}) {
  if (!bankr) {
    return null;
  }

  return compactObject({
    url: bankr.url,
    tokenName: bankr.tokenName,
    tokenSymbol: bankr.tokenSymbol,
    mechanism:
      'Bankr 发射盘要重点核对 Fee Recipient 和 deployer。Fee Recipient 是交易手续费/收益接收方；社区经常把公开 Fee Recipient + 产品/agent/开源项目解释成 dev-backed、agent tokenization 或 fee 自融资飞轮，但这仍需用 X/官网/GitHub 证据校验。',
    feeRecipientHandle: bankr.feeRecipientHandle,
    feeRecipientUrl: bankr.feeRecipientUrl,
    feeRecipientWallet: bankr.feeRecipientWallet,
    deployerHandle: bankr.deployerHandle,
    deployerWallet: bankr.deployerWallet,
    tweetUrl: bankr.tweetUrl,
    websiteUrl: bankr.websiteUrl,
    launchType: bankr.launchType,
    timestamp: bankr.timestamp
  });
}

function githubFacts(github = {}) {
  if (!github) {
    return null;
  }

  return compactObject({
    user: github.user
      ? {
          login: github.user.login,
          name: github.user.name,
          bio: snippet(github.user.bio, 320),
          company: github.user.company,
          followers: github.user.followers,
          publicRepos: github.user.publicRepos,
          url: github.user.url
        }
      : null,
    repos: asArray(github.repos)
      .slice(0, 5)
      .map((repo) => ({
        fullName: repo.fullName,
        description: snippet(repo.description, 220),
        stars: repo.stars,
        forks: repo.forks,
        language: repo.language,
        url: repo.url,
        homepage: repo.homepage
      }))
  });
}

function cleanMarkdownLines(value, limit = 8) {
  return normalizeText(value)
    .split(/\r?\n/)
    .map((line) => line.replace(/^#+\s*/, '').replace(/^\*\s+/, '').trim())
    .filter(Boolean)
    .filter((line) => !/^(title|url source|published time|markdown content):/i.test(line))
    .filter((line) => !/^!\[/.test(line))
    .filter((line) => !/^(production|beta|prototype)$/i.test(line))
    .filter((line) => line.length >= 24 && line.length <= 220)
    .slice(0, limit);
}

function markdownSummary(source = {}, maxLength = 700) {
  const lines = unique([
    source.title,
    source.description,
    ...cleanMarkdownLines(source.markdown, 5)
  ]);
  return snippet(lines.join('\n'), maxLength);
}

export function buildDeepSeekFactPack({ row, market = {}, sources = {}, profile = {} }) {
  const details = asArray(profile.narrative?.details).map((item) => ({
    label: item.label,
    value: snippet(item.value, 800)
  }));

  return compactObject({
    task:
      '用中文输出 Base 链新币投研叙事，只能使用 facts 里的证据。目标是让交易员一眼知道这个币在炒什么、dev 是谁、dev 在 AI/币圈分别什么水平。不要投资建议，不要编造 dev，不要把 Virtuals walletAddress 写成 Bankr Fee Recipient。',
    token: {
      chain: 'base',
      address: normalizeText(row?.address).toLowerCase(),
      symbol: row?.symbol,
      name: row?.name
    },
    market: {
      pairName: market.pairName,
      pairUrl: market.pairUrl,
      priceUsd: market.priceUsd,
      marketCapUsd: market.marketCapUsd,
      liquidityUsd: market.liquidityUsd,
      volume24h: market.volume24h,
      quoteTokenSymbol: market.quoteTokenSymbol,
      quoteTokenName: market.quoteTokenName
    },
    sourceType: sourceType(sources, market),
    hardIdentity: {
      identityStatus: profile.dev?.identityStatus,
      publicName: profile.dev?.publicName,
      publicHandle: profile.dev?.publicHandle,
      feeRecipientHandle: profile.dev?.feeRecipientHandle,
      feeRecipientWallet: profile.dev?.feeRecipientWallet,
      virtualsWalletAddress: profile.dev?.virtualsWalletAddress,
      who: snippet(profile.dev?.who, 800),
      background: snippet(profile.dev?.background, 800),
      aiLevel: snippet(profile.dev?.aiLevel, 800),
      cryptoLevel: snippet(profile.dev?.cryptoLevel, 800)
    },
    currentRuleAnalysis: {
      narrativeCategory: profile.narrative?.category,
      narrativeLabel: profile.narrative?.label,
      thesis: snippet(profile.narrative?.thesis, 500),
      details
    },
    sources: {
      bankr: bankrFacts(sources.bankr),
      virtuals: virtualsFacts(sources.virtuals),
      website: sources.website
        ? {
            url: sources.website.url,
            title: sources.website.title,
            summary: markdownSummary(sources.website)
          }
        : null,
      xProfile: sources.xProfile
        ? {
            url: sources.xProfile.url,
            displayName: sources.xProfile.displayName,
            handle: sources.xProfile.handle,
            bio: snippet(sources.xProfile.bio, 360),
            followers: sources.xProfile.followers,
            joined: sources.xProfile.joined
          }
        : null,
      projectXProfile: sources.projectXProfile
        ? {
            url: sources.projectXProfile.url,
            displayName: sources.projectXProfile.displayName,
            handle: sources.projectXProfile.handle,
            bio: snippet(sources.projectXProfile.bio, 360),
            followers: sources.projectXProfile.followers
          }
        : null,
      github: githubFacts(sources.github),
      gecko: sources.gecko
        ? {
            categories: sources.gecko.categories,
            categoryIds: sources.gecko.categoryIds,
            holderCount: sources.gecko.holderCount,
            top10HolderPercentage: sources.gecko.top10HolderPercentage,
            gtVerified: sources.gecko.gtVerified,
            virtualsUrl: sources.gecko.virtualsUrl
          }
        : null
    },
    evidence: limitedEvidence(profile),
    sourceLinks: unique(asArray(profile.sourceLinks).slice(0, 14))
  });
}

function parseJsonContent(content) {
  const raw = normalizeText(content).trim();
  const fenced = raw.match(/```(?:json)?\s*([\s\S]*?)```/i)?.[1];
  const text = (fenced || raw).trim().replace(/^```json\s*/i, '').replace(/^```\s*/i, '').replace(/```$/i, '').trim();
  return JSON.parse(text);
}

function extractResponseText(payload, provider = 'LLM') {
  const content =
    payload?.output_text ||
    asArray(payload?.output)
      .flatMap((item) => asArray(item?.content))
      .filter((part) => part?.type === 'output_text')
      .map((part) => part.text)
      .join('\n') ||
    payload?.choices?.[0]?.message?.content;
  if (!content) {
    throw new Error(`${provider} response did not include message content`);
  }
  return content;
}

function tryParseJsonContent(content) {
  try {
    return parseJsonContent(content);
  } catch {
    return null;
  }
}

function pickCleanText(value, maxLength = 1800) {
  const text = snippet(value, maxLength);
  return text || null;
}

function userFacingText(value) {
  const text = pickCleanText(value);
  if (!text) {
    return null;
  }
  return text;
}

function includesGenericNarrative(text) {
  return /AI 应用\/agent 工作流|agent、automation、research、inference、workflow 或 model routing|公开资料指向 agent、automation、research、inference、workflow|公开资料显示其涉及 automation\/research\/inference|具有一定潜力|值得关注/i.test(
    normalizeText(text)
  );
}

function includesSearchFailureLeak(text) {
  return /communityContext\s*搜索失败|community search failed|community search disabled|搜索失败，只能使用 factPack|只(?:能|使用) factPack|缺少 X\/scanner 实时语境|search failed|叙事搜索失败|dev 背景搜索失败|搜索请求异常|搜索请求失败|实时语境未确认/i.test(
    normalizeText(text)
  );
}

function includesInternalContextLeak(text) {
  return /\bfactPack\b|\bcommunityContext\b|\bnarrativeSearch\b|\bdevSearch\b|社区搜索上下文|搜索上下文|硬证据/i.test(
    normalizeText(text)
  );
}

function looksLikeProjectLevelInsteadOfDevLevel(text) {
  return /^高[。：:]?项目|^极高[。：:]?项目|项目直接聚焦|项目部署在|叙事与 AI|技术实现复杂度/i.test(
    normalizeText(text).trim()
  );
}

function validRawGrokText(value) {
  const text = rawSnippet(cleanRawGrokText(value));
  if (!text) {
    return null;
  }
  if (includesSearchFailureLeak(text) || includesInternalContextLeak(text)) {
    return null;
  }
  return text;
}

function extractCriticalTokens(value) {
  const text = normalizeText(value);
  return unique([
    ...(text.match(/https?:\/\/[^\s<>"')，。]+/gi) || []),
    ...(text.match(/@[A-Za-z0-9_]{2,20}/g) || []),
    ...(text.match(/0x[a-fA-F0-9]{40}/g) || []),
    ...(text.match(/\$[A-Za-z0-9_]{2,20}/g) || [])
  ]);
}

function preservesCriticalTokens(original, formatted) {
  const next = normalizeText(formatted);
  return extractCriticalTokens(original).every((token) => next.includes(token));
}

function addsCriticalTokens(original, formatted) {
  const originalTokens = new Set(extractCriticalTokens(original));
  return extractCriticalTokens(formatted).some((token) => !originalTokens.has(token));
}

function validFormattedRawText(original, formatted) {
  const before = validRawGrokText(original);
  if (!before) {
    return null;
  }
  const after = validRawGrokText(formatted);
  if (!after) {
    return before;
  }
  if (!preservesCriticalTokens(before, after) || addsCriticalTokens(before, after)) {
    return before;
  }
  if (after.length < before.length * 0.65) {
    return before;
  }
  return after;
}

function firstMeaningfulLine(value, maxLength = 220) {
  const line = normalizeText(value)
    .split(/\r?\n/)
    .map((item) => item.trim())
    .find((item) => item && !/^#+\s*$/.test(item));
  return snippet(line || value, maxLength);
}

function validEnhancedNarrative(values) {
  const joined = values.filter(Boolean).join('\n');
  if (!joined || includesGenericNarrative(joined)) {
    return false;
  }
  if (includesSearchFailureLeak(joined) || includesInternalContextLeak(joined)) {
    return false;
  }
  if (values.some((value) => normalizeText(value).length > 2400)) {
    return false;
  }
  return true;
}

function factPackHasReceiverSignal(factPack = {}) {
  const hardIdentity = factPack.hardIdentity || {};
  const bankr = factPack.sources?.bankr || {};
  const virtuals = factPack.sources?.virtuals || {};
  return Boolean(
    hardIdentity.feeRecipientHandle ||
      hardIdentity.feeRecipientWallet ||
      bankr.feeRecipientHandle ||
      bankr.feeRecipientWallet ||
      virtuals.feeDelegatedRecipient ||
      virtuals.feeDelegationVaultAddress ||
      virtuals.taxRecipient
  );
}

function factPackPublicAccount(factPack = {}) {
  const hardIdentity = factPack.hardIdentity || {};
  const sources = factPack.sources || {};
  return (
    hardIdentity.publicHandle ||
    sources.xProfile?.handle ||
    sources.projectXProfile?.handle ||
    sources.virtuals?.creatorTwitterHandle ||
    sources.virtuals?.projectTwitterHandle ||
    null
  );
}

function missingReceiverNotice(factPack = {}) {
  const token = factPack.token || {};
  return `这个 CA（${token.address || 'unknown'}）暂时没有找到 Bankr Fee Recipient、Virtuals delegate 或接收钱包线索。`;
}

function appendMissingReceiverNotice(rawDev, factPack = {}) {
  const text = validRawGrokText(rawDev);
  if (!text || factPackHasReceiverSignal(factPack)) {
    return text;
  }
  const notice = missingReceiverNotice(factPack);
  if (text.includes(notice) || /没有找到 Bankr (?:Fee Recipient|或 Virtuals)|没有找到.*Virtuals.*接收钱包/i.test(text)) {
    return text;
  }
  return rawSnippet([notice, '', text].join('\n'));
}

function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

const narrativeMetadata = Symbol('narrativeMetadata');

function withNarrativeMetadata(enhancement, metadata = {}) {
  if (enhancement && typeof enhancement === 'object') {
    const existing = enhancement[narrativeMetadata] || {};
    Object.defineProperty(enhancement, narrativeMetadata, {
      value: compactObject({ ...existing, ...metadata }),
      enumerable: false,
      configurable: true
    });
  }
  return enhancement;
}

export function getNarrativeMetadata(enhancement) {
  return enhancement?.[narrativeMetadata] || {};
}

function narrativeSystemPrompt({ provider = 'deepseek' } = {}) {
  const grokLines =
    provider === 'grok'
      ? [
          '你是 Grok 风格的 crypto/X 叙事研究员，擅长从 X/meme/币圈语境判断社区到底在炒什么。',
          '重点写出 dev 在 AI 圈和币圈分别什么水平：出不出名、几线、身份背景、产品/开源/社区影响力。',
          '如果是 meme，要讲梗来源、人物、社区传播路径；如果是 AI 产品，要讲具体产品、创新、技术含量和差异，不要官网复读。',
          '你可以使用 factPack 以及 x_search 和 web_search 搜到的公开结果；必须主动搜索 CA、ticker、token name、Bankr Fee Recipient、deployer 和核心 X 账号。',
          '社区主推版本优先参考最近 X/scanner/KOL/Bankr 社区的公开说法，但要把未确认内容标成“社区说法/未确认”。'
        ]
      : [
          '你是一个谨慎但敏锐的 Base 链新币投研分析员，写给短线交易员看。'
        ];
  const evidenceLine =
    provider === 'grok'
      ? '只能使用 factPack 或 x_search/web_search 搜到的公开证据，不要编造事实；没证据就写“未确认”。'
      : '只使用用户提供的 facts，不要编造事实；没证据就写“未确认”。';

  return [
    ...grokLines,
    evidenceLine,
    '必须区分 Bankr Fee Recipient、Virtuals creator、Virtuals projectMembers、Virtuals walletAddress。Virtuals walletAddress 不是 Bankr Fee Recipient。',
    '输出 JSON，字段必须且只能是：coinIdentity、communityNarrative、productOrMemeOrigin、whyItCanMove、devIdentity、devAiReputation、devCryptoReputation、evidenceStrength、redFlags、oneLineSummary。',
    'coinIdentity：用“这个 CA 是 Base 链上的 $SYMBOL ……”开头，说明它属于 Bankr、Virtuals、AI 产品、infra、meme 还是未知盘。',
    'communityNarrative：写清楚社区在炒哪条线，像 Grok 风格，不要写成官网摘要。',
    'productOrMemeOrigin：如果是 AI 产品，说产品具体做什么、创新/技术含量/差异；如果是 meme，说梗从哪里来、人物是谁；如果是 Bankr 把项目/agent/repo token 化的 meme，要先讲社区包装出来的产品/agent 故事，再说明硬证据是否足够。',
    'whyItCanMove：只写可能推动买盘的证据链，例如 dev-backed、官方链接、Base/Virtuals/Bankr 生态、开源影响力、scanner/KOL/社区预期；没有就写弱。',
    'devIdentity：写 dev 是谁，依据是什么。Bankr 以 Fee Recipient 为核心，Virtuals 以 delegate/projectMembers/creator 为核心。',
    'devAiReputation：只评价 dev/团队在 AI 圈的水平和身份背景：顶流/二线偏强/中上/早期 builder/非 AI 圈/未确认。不要写“项目 AI 含量高”。',
    'devCryptoReputation：只评价 dev/团队在币圈的水平和身份背景：老牌协议/KOL/crypto-native builder/新晋关注/早期/未确认。不要写“项目部署在 Base 所以高”。',
    'evidenceStrength：判断证据强弱，点名 Bankr、Virtuals、官网、X、GitHub、Gecko 等证据。',
    'redFlags：列出未确认、持仓集中、无官网/无 dev、token utility 不清、伪 AI 词盘等风险。',
    'oneLineSummary：一句话给交易员结论，分清强/弱，不默认吹。',
    '禁止空话：不要写“AI 应用/agent 工作流”“公开资料指向 agent、automation、research、inference、workflow 或 model routing”“具有一定潜力”“值得关注”。'
  ].join('\n');
}

function collectSearchTerms(items) {
  return unique(
    items
      .flatMap((item) => (Array.isArray(item) ? item : [item]))
      .map((item) => normalizeText(item).trim())
      .filter(Boolean)
  );
}

function compactSearchTerm(value) {
  const text = normalizeText(value).trim();
  if (!text) {
    return null;
  }
  try {
    const url = new URL(text);
    if (url.hostname === 'x.com' || url.hostname === 'twitter.com') {
      const handle = url.pathname.split('/').filter(Boolean)[0];
      return handle ? `@${handle}` : null;
    }
    if (url.hostname === 'github.com') {
      return url.pathname.split('/').filter(Boolean).slice(0, 2).join('/');
    }
    return url.hostname.replace(/^www\./, '');
  } catch {
    return text;
  }
}

function buildGrokNarrativeSearchQuery(factPack) {
  const token = factPack?.token || {};
  return `${token.address || token.symbol || token.name || 'unknown'} 这个ca是什么叙事`;
}

function buildGrokDevSearchQuery(factPack) {
  const bankr = factPack?.sources?.bankr || {};
  const virtuals = factPack?.sources?.virtuals || {};
  const token = factPack?.token || {};
  const projectMembers = asArray(virtuals.projectMembers)
    .map((member) => [member.name, member.x, member.github].filter(Boolean).join(' '))
    .slice(0, 4);
  const tokenTerms = collectSearchTerms([
    token.address,
    token.symbol,
    token.name,
    bankr.tokenSymbol,
    bankr.tokenName
  ]).slice(0, 5);
  const devTerms = collectSearchTerms([
    bankr.feeRecipientHandle,
    bankr.feeRecipientUrl,
    bankr.deployerHandle,
    virtuals.creatorTwitterHandle,
    virtuals.projectTwitterHandle,
    virtuals.feeDelegatedRecipient,
    factPack?.sources?.xProfile?.handle,
    factPack?.sources?.xProfile?.url,
    factPack?.sources?.projectXProfile?.handle,
    factPack?.sources?.projectXProfile?.url,
    factPack?.sources?.github?.user?.login,
    factPack?.sources?.github?.user?.url,
    projectMembers
  ]).map(compactSearchTerm).filter(Boolean).slice(0, 8);
  const walletTerms = collectSearchTerms([
    bankr.feeRecipientWallet,
    bankr.deployerWallet,
    virtuals.virtualsWalletAddress
  ]).slice(0, 4);
  const projectTerms = collectSearchTerms([
    bankr.websiteUrl,
    bankr.tweetUrl,
    virtuals.url,
    virtuals.projectWebsiteUrl,
    virtuals.prototypeAddress,
    asArray(factPack?.sources?.github?.repos).map((repo) => repo.fullName),
    asArray(factPack?.sourceLinks).slice(0, 4)
  ]).map(compactSearchTerm).filter(Boolean).slice(0, 8);

  return [
    '这个 dev 是谁？请基于下面代码挖到的线索快速搜索，判断 dev 在 AI 圈和币圈分别什么水平。',
    `Token clues: ${tokenTerms.join(' | ')}`,
    factPack?.sourceType === 'bankr'
      ? `Bankr dev clues: Fee Recipient ${bankr.feeRecipientHandle || bankr.feeRecipientWallet || 'unknown'}; Fee Recipient URL ${bankr.feeRecipientUrl || 'unknown'}; deployer ${bankr.deployerHandle || bankr.deployerWallet || 'unknown'}.`
      : null,
    factPack?.sourceType?.startsWith?.('virtuals')
      ? `Virtuals dev clues: Delegate to / creator ${virtuals.feeDelegatedRecipient || virtuals.creatorTwitterHandle || 'unknown'}; project members ${projectMembers.join(' | ') || 'unknown'}; wallet ${virtuals.virtualsWalletAddress || 'unknown'}.`
      : null,
    `X handle / GitHub / project clues: ${devTerms.join(' | ') || 'unknown'}; project ${projectTerms.join(', ') || 'unknown'}.`,
    walletTerms.length
      ? `钱包地址也要去 X 搜索归属，不要直接把钱包当成 dev 名字: ${walletTerms.join(' | ')}`
      : '如果没有明确 X handle，要用 CA/ticker/项目名在 X 搜索 dev 归属。',
    '必须回答：dev 真实身份/handle 是谁；依据是 Fee Recipient、deployer、Virtuals delegate/creator 还是项目成员；AI 圈出不出名、几线/第几梯队、做过什么产品/开源/公司；币圈是不是 KOL/老 builder/新晋/未确认。',
    '直接用中文回答，像用户在 Grok 网页里问出来的原文结果；不要输出 JSON，不要解释系统搜索过程。'
  ].filter(Boolean).join('\n');
}

function normalizeCommunityContext(value) {
  if (!value) {
    return null;
  }
  if (typeof value === 'string') {
    return { summary: rawSnippet(value, 5000), links: [] };
  }
  if (typeof value !== 'object') {
    return null;
  }
  const summary = snippet(
    [
      value.summary,
      asArray(value.narrativeSignals).join('\n'),
      asArray(value.devCandidates).join('\n'),
      value.aiReputation,
      value.cryptoReputation,
      asArray(value.uncertainClaims).join('\n')
    ]
      .filter(Boolean)
      .join('\n'),
    3000
  );
  return compactObject({
    summary,
    devCandidates: asArray(value.devCandidates).map((item) => snippet(item, 400)).slice(0, 8),
    narrativeSignals: asArray(value.narrativeSignals).map((item) => snippet(item, 400)).slice(0, 8),
    aiReputation: pickCleanText(value.aiReputation, 800),
    cryptoReputation: pickCleanText(value.cryptoReputation, 800),
    links: asArray(value.links).map((item) => snippet(item, 280)).slice(0, 10),
    uncertainClaims: asArray(value.uncertainClaims).map((item) => snippet(item, 400)).slice(0, 8)
  });
}

function combineCommunityContext({ narrativeSearch, devSearch } = {}) {
  const narrative = normalizeCommunityContext(narrativeSearch);
  const dev = normalizeCommunityContext(devSearch);
  if (!narrative && !dev) {
    return null;
  }

  return compactObject({
    summary: snippet(
      [
        narrative?.summary ? `CA 叙事搜索：${narrative.summary}` : null,
        dev?.summary ? `dev 背景搜索：${dev.summary}` : null
      ]
        .filter(Boolean)
        .join('\n\n'),
      4200
    ),
    narrativeSearch: narrative,
    devSearch: dev,
    devCandidates: unique([...(narrative?.devCandidates || []), ...(dev?.devCandidates || [])]).slice(0, 10),
    narrativeSignals: unique([...(narrative?.narrativeSignals || []), ...(dev?.narrativeSignals || [])]).slice(0, 10),
    links: unique([...(narrative?.links || []), ...(dev?.links || [])]).slice(0, 14),
    uncertainClaims: unique([...(narrative?.uncertainClaims || []), ...(dev?.uncertainClaims || [])]).slice(0, 10)
  });
}

function buildRawGrokEnhancement(communityContext) {
  const rawNarrative = validRawGrokText(communityContext?.narrativeSearch?.summary);
  const rawDev = validRawGrokText(communityContext?.devSearch?.summary);
  if (!rawNarrative && !rawDev) {
    return {};
  }

  return compactObject({
    rawNarrative,
    rawDev,
    communityNarrative: rawNarrative,
    devIdentity: rawDev,
    oneLineSummary: firstMeaningfulLine(rawNarrative || rawDev)
  });
}

export class DeepSeekRawTextFormatter {
  constructor(options = {}) {
    this.provider = 'deepseek';
    this.apiKey = options.apiKey || '';
    this.baseUrl = (options.baseUrl || 'https://api.deepseek.com').replace(/\/+$/, '');
    this.model = options.model || 'deepseek-v4-pro';
    this.fetchImpl = options.fetchImpl || fetch;
    this.timeoutMs = options.timeoutMs ?? 20000;
    this.abortSignalTimeout = options.abortSignalTimeout || AbortSignal.timeout;
  }

  get enabled() {
    return Boolean(this.apiKey);
  }

  async format(input = {}) {
    const originalNarrative = validRawGrokText(input.rawNarrative);
    const originalDev = validRawGrokText(input.rawDev);
    if (!this.enabled || (!originalNarrative && !originalDev)) {
      return this.buildResult({ ...input, rawNarrative: originalNarrative, rawDev: originalDev }, false);
    }

    try {
      const response = await this.fetchImpl(`${this.baseUrl}/chat/completions`, {
        method: 'POST',
        headers: {
          authorization: `Bearer ${this.apiKey}`,
          'content-type': 'application/json',
          accept: 'application/json'
        },
        body: JSON.stringify({
          model: this.model,
          response_format: { type: 'json_object' },
          thinking: { type: 'disabled' },
          temperature: 0,
          messages: [
            {
              role: 'system',
              content: [
                '你是中文排版编辑，只做排版，不做投研分析。',
                '任务：把 Grok 原文整理得更好读，只能拆段、加空行、把明显并列信息改成列表、清理 Markdown 挤在一起的问题。',
                '不要改意思，不要新增事实，不要删除事实，不要换 dev，不要改 CA、ticker、@handle、URL、钱包地址。',
                '不要添加引用编号、脚注、来源链接、Markdown 链接或原文没有的新账号/新网址。',
                '不要总结，不要压缩，不要改写成结构化投研模板。',
                '输出 JSON，字段只能是 rawNarrative、rawDev。字段值是排版后的原文。'
              ].join('\n')
            },
            {
              role: 'user',
              content: JSON.stringify({
                rawNarrative: originalNarrative,
                rawDev: originalDev
              })
            }
          ]
        }),
        signal: this.abortSignalTimeout(this.timeoutMs)
      });

      if (!response.ok) {
        return this.buildResult({ ...input, rawNarrative: originalNarrative, rawDev: originalDev }, false);
      }

      const payload = await response.json();
      const parsed = parseJsonContent(extractResponseText(payload, 'DeepSeek raw formatter'));
      const rawNarrative = originalNarrative
        ? validFormattedRawText(originalNarrative, parsed.rawNarrative)
        : null;
      const rawDev = originalDev ? validFormattedRawText(originalDev, parsed.rawDev) : null;
      const formatted =
        Boolean(rawNarrative && originalNarrative && rawNarrative !== originalNarrative) ||
        Boolean(rawDev && originalDev && rawDev !== originalDev);
      return this.buildResult({ ...input, rawNarrative, rawDev }, formatted);
    } catch {
      return this.buildResult({ ...input, rawNarrative: originalNarrative, rawDev: originalDev }, false);
    }
  }

  buildResult(input = {}, rawFormatted = false) {
    const rawNarrative = validRawGrokText(input.rawNarrative);
    const rawDev = validRawGrokText(input.rawDev);
    return compactObject({
      ...input,
      rawNarrative,
      rawDev,
      rawFormatted,
      communityNarrative: rawNarrative,
      devIdentity: rawDev,
      oneLineSummary: firstMeaningfulLine(rawNarrative || rawDev)
    });
  }
}

export function applyDeepSeekEnhancement(profile, enhancement, metadata = {}) {
  if (!enhancement || typeof enhancement !== 'object') {
    return profile;
  }

  const rawNarrative = validRawGrokText(enhancement.rawNarrative);
  const rawDev = validRawGrokText(enhancement.rawDev);
  if (rawNarrative || rawDev) {
    const next = structuredClone(profile);
    const existingDetails = asArray(next.narrative?.details);
    const existingRawNarrative = existingDetails.find((item) => item?.label === '叙事原文')?.value || null;
    const existingRawDev = existingDetails.find((item) => item?.label === 'Dev 背景原文')?.value || null;
    const mergedRawNarrative = rawNarrative || validRawGrokText(existingRawNarrative);
    const mergedRawDev = rawDev || validRawGrokText(existingRawDev);
    const details = [
      { label: '叙事原文', value: mergedRawNarrative },
      { label: 'Dev 背景原文', value: mergedRawDev }
    ].filter((item) => item.value);

    next.narrative = {
      ...next.narrative,
      origin: unique([mergedRawNarrative, mergedRawDev]).join('\n\n') || next.narrative?.origin,
      thesis: '原文已整理，完整内容在下方。',
      details,
      llmProvider: metadata.provider || 'grok',
      llmModel: metadata.model || null,
      llmFallbackFrom: metadata.fallbackFrom || null,
      llmUpdatedAt: metadata.updatedAt || new Date().toISOString()
    };

    next.dev = {
      ...next.dev,
      background: rawDev || next.dev?.background
    };

    return next;
  }

  const coinIdentity = userFacingText(enhancement.coinIdentity);
  const communityNarrative = userFacingText(enhancement.communityNarrative || enhancement.narrativeCore);
  const productOrMemeOrigin = userFacingText(enhancement.productOrMemeOrigin);
  const whyItCanMove = userFacingText(enhancement.whyItCanMove);
  const devIdentity = userFacingText(enhancement.devIdentity || enhancement.devBacking);
  const devAiReputation = userFacingText(enhancement.devAiReputation || enhancement.aiLevel);
  const devCryptoReputation = userFacingText(enhancement.devCryptoReputation || enhancement.cryptoLevel);
  const evidenceStrength = userFacingText(enhancement.evidenceStrength);
  const redFlags = userFacingText(enhancement.redFlags || enhancement.risk);
  const oneLineSummary = userFacingText(enhancement.oneLineSummary);

  const values = [
    coinIdentity,
    communityNarrative,
    productOrMemeOrigin,
    whyItCanMove,
    devIdentity,
    devAiReputation,
    devCryptoReputation,
    evidenceStrength,
    redFlags,
    oneLineSummary
  ];

  if (!validEnhancedNarrative(values)) {
    return profile;
  }
  if (includesSearchFailureLeak([coinIdentity, communityNarrative, productOrMemeOrigin, whyItCanMove, oneLineSummary].join('\n'))) {
    return profile;
  }

  const next = structuredClone(profile);
  const fallbackDetails = asArray(next.narrative?.details);
  const details = [
    { label: '这是什么币', value: coinIdentity },
    { label: '叙事核心（社区主推版本）', value: communityNarrative },
    { label: '产品/梗来源', value: productOrMemeOrigin },
    { label: '为什么有人会炒', value: whyItCanMove },
    { label: 'Dev 身份', value: devIdentity },
    { label: 'Dev 在 AI 圈水平', value: devAiReputation },
    { label: 'Dev 在币圈水平', value: devCryptoReputation },
    { label: '证据强度', value: evidenceStrength },
    { label: '风险/未确认', value: redFlags },
    { label: '一句话总结', value: oneLineSummary }
  ]
    .filter((item) => item.value)
    .map((item, index) => ({
      label: item.label || fallbackDetails[index]?.label || '叙事细节',
      value: item.value || fallbackDetails[index]?.value || ''
    }));

  next.narrative = {
    ...next.narrative,
    origin: unique([coinIdentity, communityNarrative, productOrMemeOrigin, whyItCanMove, redFlags, oneLineSummary]).join('\n\n') || next.narrative?.origin,
    thesis: oneLineSummary || communityNarrative || next.narrative?.thesis,
    details,
    llmProvider: metadata.provider || 'deepseek',
    llmModel: metadata.model || null,
    llmFallbackFrom: metadata.fallbackFrom || null,
    llmUpdatedAt: metadata.updatedAt || new Date().toISOString()
  };

  next.dev = {
    ...next.dev,
    background: devIdentity || next.dev?.background,
    aiLevel:
      devAiReputation && !looksLikeProjectLevelInsteadOfDevLevel(devAiReputation)
        ? devAiReputation
        : next.dev?.aiLevel,
    cryptoLevel:
      devCryptoReputation && !looksLikeProjectLevelInsteadOfDevLevel(devCryptoReputation)
        ? devCryptoReputation
        : next.dev?.cryptoLevel
  };

  return next;
}

export class DeepSeekNarrativeGenerator {
  constructor(options = {}) {
    this.provider = 'deepseek';
    this.apiKey = options.apiKey || '';
    this.baseUrl = (options.baseUrl || 'https://api.deepseek.com').replace(/\/+$/, '');
    this.model = options.model || 'deepseek-v4-pro';
    this.fetchImpl = options.fetchImpl || fetch;
    this.timeoutMs = options.timeoutMs ?? 25000;
    this.maxAttempts = options.maxAttempts ?? 1;
    this.retryDelayMs = options.retryDelayMs ?? 1200;
    this.abortSignalTimeout = options.abortSignalTimeout || AbortSignal.timeout;
    this.foregroundConcurrency = Math.max(1, Number(options.foregroundConcurrency || 1));
    this.backgroundConcurrency = Math.max(1, Number(options.backgroundConcurrency || 1));
    this.queues = {
      foreground: {
        concurrency: this.foregroundConcurrency,
        active: 0,
        pending: []
      },
      background: {
        concurrency: this.backgroundConcurrency,
        active: 0,
        pending: []
      }
    };
  }

  get enabled() {
    return Boolean(this.apiKey);
  }

  async generate({ row, market, sources, profile, priority = 'foreground' }) {
    if (!this.enabled) {
      return null;
    }

    const factPack = buildDeepSeekFactPack({ row, market, sources, profile });
    const enhancement = await this.enqueue(() => this.requestWithRetries(factPack, { priority }), priority);
    return withNarrativeMetadata(enhancement, {
      provider: this.provider,
      model: this.model
    });
  }

  enqueue(job, priority = 'foreground') {
    const queueName = priority === 'background' ? 'background' : 'foreground';
    const queue = this.queues[queueName] || this.queues.foreground;
    return new Promise((resolve, reject) => {
      queue.pending.push({ job, resolve, reject });
      this.drainQueue(queueName);
    });
  }

  drainQueue(queueName = 'foreground') {
    const queue = this.queues[queueName] || this.queues.foreground;
    while (queue.active < queue.concurrency && queue.pending.length) {
      const item = queue.pending.shift();
      queue.active += 1;
      Promise.resolve()
        .then(item.job)
        .then(item.resolve, item.reject)
        .finally(() => {
          queue.active -= 1;
          this.drainQueue(queueName);
        });
    }
  }

  async requestWithRetries(factPack, options = {}) {
    let lastError;
    for (let attempt = 1; attempt <= this.maxAttempts; attempt += 1) {
      try {
        return await this.request(factPack, options);
      } catch (error) {
        lastError = error;
        if (attempt >= this.maxAttempts || !this.isRetryable(error)) {
          throw error;
        }
        await sleep(this.retryDelayMs * attempt);
      }
    }
    throw lastError;
  }

  isRetryable(error) {
    if (error?.retryable) {
      return true;
    }
    return /fetch failed|network|timeout|terminated|socket|ECONNRESET|ETIMEDOUT/i.test(
      `${error?.name || ''} ${error?.message || ''} ${error?.cause?.code || ''} ${error?.cause?.message || ''}`
    );
  }

  async request(factPack) {
    const response = await this.fetchImpl(`${this.baseUrl}/chat/completions`, {
      method: 'POST',
      headers: {
        authorization: `Bearer ${this.apiKey}`,
        'content-type': 'application/json',
        accept: 'application/json'
      },
      body: JSON.stringify({
        model: this.model,
        response_format: { type: 'json_object' },
        thinking: { type: 'disabled' },
        temperature: 0.2,
        messages: [
          {
            role: 'system',
            content: narrativeSystemPrompt({ provider: this.provider })
          },
          {
            role: 'user',
            content: JSON.stringify(factPack)
          }
        ]
      }),
      signal: this.abortSignalTimeout(this.timeoutMs)
    });

    if (!response.ok) {
      const error = new Error(`DeepSeek request failed with HTTP ${response.status}`);
      error.retryable = response.status === 429 || response.status >= 500;
      throw error;
    }

    const payload = await response.json();
    const content = payload?.choices?.[0]?.message?.content;
    if (!content) {
      throw new Error('DeepSeek response did not include message content');
    }

    return parseJsonContent(content);
  }
}

export class GrokNarrativeGenerator extends DeepSeekNarrativeGenerator {
  constructor(options = {}) {
    super({
      ...options,
      baseUrl: options.baseUrl || 'https://api.x.ai/v1',
      model: options.model || 'grok-4.3',
      timeoutMs: options.timeoutMs ?? 45000
    });
    this.provider = 'grok';
    this.reasoningEffort = options.reasoningEffort || 'expert';
    this.enableSearch = options.enableSearch ?? true;
    this.rawFormatter = options.rawFormatter || null;
    this.backgroundConcurrency = Math.max(1, Number(options.backgroundConcurrency || 3));
    this.queues.background.concurrency = this.backgroundConcurrency;
    this.foregroundSearchTimeoutMs =
      options.foregroundSearchTimeoutMs ?? options.searchTimeoutMs ?? this.timeoutMs;
    this.backgroundSearchTimeoutMs =
      options.backgroundSearchTimeoutMs ?? options.searchTimeoutMs ?? this.timeoutMs;
  }

  async request(factPack, options = {}) {
    const communityContext = this.enableSearch
      ? await this.requestCommunityContext(factPack, options.priority || 'foreground')
      : null;
    const enhancement = buildRawGrokEnhancement(communityContext);
    if (!enhancement.rawNarrative && !enhancement.rawDev) {
      throw new Error('Grok raw search did not return usable narrative or dev text');
    }
    if (!this.rawFormatter?.enabled) {
      return enhancement;
    }
    return compactObject(await this.rawFormatter.format(enhancement));
  }

  async generatePart({ row, market, sources, profile, priority = 'foreground', part } = {}) {
    if (!this.enabled) {
      return null;
    }
    if (part !== 'narrative' && part !== 'dev') {
      throw new Error(`Unsupported Grok narrative part: ${part || 'unknown'}`);
    }

    const factPack = buildDeepSeekFactPack({ row, market, sources, profile });
    const enhancement = await this.enqueue(
      () => this.requestPart(factPack, { priority, part }),
      priority
    );
    return withNarrativeMetadata(enhancement, {
      provider: this.provider,
      model: this.model,
      part
    });
  }

  async requestPart(factPack, { priority = 'foreground', part } = {}) {
    if (!this.enableSearch && part === 'dev') {
      return this.devMissingReceiverEnhancement(factPack);
    }
    if (!this.enableSearch) {
      throw new Error('Grok raw search is disabled');
    }

    const search =
      part === 'narrative'
        ? await this.requestNarrativeSearch(factPack, priority)
        : await this.requestDevSearch(factPack, priority);
    let enhancement = buildRawGrokEnhancement(
      part === 'narrative'
        ? combineCommunityContext({ narrativeSearch: search })
        : combineCommunityContext({ devSearch: search })
    );

    if (part === 'dev') {
      enhancement = enhancement.rawDev
        ? {
            ...enhancement,
            rawDev: appendMissingReceiverNotice(enhancement.rawDev, factPack)
          }
        : this.devFallbackEnhancement(factPack);
    }

    if (
      (part === 'narrative' && !enhancement.rawNarrative) ||
      (part === 'dev' && !enhancement.rawDev)
    ) {
      throw new Error(`Grok raw ${part} search did not return usable text`);
    }

    if (!this.rawFormatter?.enabled) {
      return enhancement;
    }
    const formatted = compactObject(await this.rawFormatter.format(enhancement));
    if (part === 'dev') {
      return {
        ...formatted,
        rawDev: appendMissingReceiverNotice(formatted.rawDev || enhancement.rawDev, factPack)
      };
    }
    return formatted;
  }

  searchTimeoutFor(priority = 'foreground') {
    return priority === 'background' ? this.backgroundSearchTimeoutMs : this.foregroundSearchTimeoutMs;
  }

  grokHeaders() {
    return {
      authorization: `Bearer ${this.apiKey}`,
      'content-type': 'application/json',
      accept: 'application/json'
    };
  }

  searchTools() {
    return [
      { type: 'x_search' },
      {
        type: 'web_search',
        filters: {
          allowed_domains: [
            'bankr.bot',
            'dexscreener.com',
            'geckoterminal.com',
            'github.com',
            'virtuals.io'
          ]
        }
      }
    ];
  }

  async requestSearchContext({ systemContent, userContent, priority = 'foreground', label = 'community' } = {}) {
    let response;
    try {
      response = await this.fetchImpl(`${this.baseUrl}/responses`, {
        method: 'POST',
        headers: this.grokHeaders(),
        body: JSON.stringify({
          model: this.model,
          store: false,
          temperature: 0.1,
          tools: this.searchTools(),
          input: [
            {
              role: 'system',
              content: systemContent
            },
            {
              role: 'user',
              content: userContent
            }
          ]
        }),
        signal: this.abortSignalTimeout(this.searchTimeoutFor(priority))
      });
    } catch (error) {
      return {
        summary: `${label} search failed: ${snippet(error?.message || error?.name || 'network error', 240)}; 搜索失败，只能使用 factPack。`,
        links: [],
        uncertainClaims: [`${label} 搜索请求异常，本次缺少对应实时语境。`]
      };
    }

    if (!response.ok) {
      return {
        summary: `${label} search failed with HTTP ${response.status}; 搜索失败，只能使用 factPack。`,
        links: [],
        uncertainClaims: [`${label} 搜索请求失败，本次缺少对应实时语境。`]
      };
    }

    const payload = await response.json();
    const content = extractResponseText(payload, `Grok ${label} search`);
    const parsed = tryParseJsonContent(content);
    return normalizeCommunityContext(parsed || content);
  }

  requestNarrativeSearch(factPack, priority = 'foreground') {
    return this.requestSearchContext({
      priority,
      label: 'narrative',
      systemContent: [
        '你是 Grok 风格的 crypto/X 叙事搜索助手。',
        '像用户在 Grok 网页里问一样，用中文直接回答这个 CA 的社区主推叙事。',
        '不要输出 JSON，不要解释系统搜索过程。'
      ].join('\n'),
      userContent: buildGrokNarrativeSearchQuery(factPack)
    });
  }

  requestDevSearch(factPack, priority = 'foreground') {
    return this.requestSearchContext({
      priority,
      label: 'dev',
      systemContent: [
        '你是 Grok 风格的 crypto/X dev 背景搜索助手。',
        '像用户在 Grok 网页里问一样，用中文直接回答 dev 是谁、依据是什么、在 AI 圈和币圈分别什么水平。',
        '根据代码挖到的 Fee Recipient、deployer、Virtuals delegate/creator、X handle、GitHub、钱包快速搜索归纳。',
        '如果代码线索里没有 Bankr Fee Recipient、Virtuals delegate 或接收钱包，就必须明确写：没有找到 Bankr 或 Virtuals 上的接收钱包/归属线索，暂时不能确认 dev。',
        '不要输出 JSON，不要解释系统搜索过程。'
      ].join('\n'),
      userContent: buildGrokDevSearchQuery(factPack)
    });
  }

  devFallbackEnhancement(factPack) {
    const hardIdentity = factPack?.hardIdentity || {};
    if (factPackHasReceiverSignal(factPack) || factPackPublicAccount(factPack)) {
      const account = factPackPublicAccount(factPack);
      const identityText = hardIdentity.who || (account ? `当前能确认的公开账号是 ${account}。` : null);
      const lines = [
        identityText,
        '',
        hardIdentity.aiLevel ? `AI 圈水平：${hardIdentity.aiLevel.replace(/^AI 圈水平[：:]\s*/, '')}` : 'AI 圈水平：未确认。',
        hardIdentity.cryptoLevel
          ? `币圈水平：${hardIdentity.cryptoLevel.replace(/^币圈水平[：:]\s*/, '')}`
          : '币圈水平：未确认。'
      ];
      const rawDev = appendMissingReceiverNotice(lines.filter(Boolean).join('\n'), factPack);
      return {
        rawDev,
        devIdentity: rawDev,
        oneLineSummary: firstMeaningfulLine(rawDev)
      };
    }
    return this.devMissingReceiverEnhancement(factPack);
  }

  devMissingReceiverEnhancement(factPack) {
    const token = factPack?.token || {};
    const text = [
      `这个 CA（${token.address || 'unknown'}）暂时没有找到 Bankr Fee Recipient、Virtuals delegate 或接收钱包线索。`,
      '',
      '因此暂时不能确认 dev 是谁，也不能把某个钱包、项目账号或社区转发者直接当成 dev。',
      '',
      'AI 圈水平：未确认，因为没有抓到可归属的 dev 身份、X 账号、官网团队页或 GitHub 线索。',
      '',
      '币圈水平：未确认，因为没有找到 Bankr 或 Virtuals 上的收益接收方 / delegate 归属，链上发行归属不清楚。'
    ].join('\n');
    return {
      rawDev: text,
      devIdentity: text,
      oneLineSummary: '没有找到 Bankr 或 Virtuals 上的接收钱包/归属线索，暂时不能确认 dev。'
    };
  }

  async requestCommunityContext(factPack, priority = 'foreground') {
    const [narrativeSearch, devSearch] = await Promise.all([
      this.requestNarrativeSearch(factPack, priority),
      this.requestDevSearch(factPack, priority)
    ]);

    return combineCommunityContext({ narrativeSearch, devSearch });
  }

}

export class FallbackNarrativeGenerator {
  constructor({ primary, fallback } = {}) {
    this.primary = primary || null;
    this.fallback = fallback || null;
    this.provider = this.primary?.provider || this.fallback?.provider || null;
    this.model = this.primary?.model || this.fallback?.model || null;
  }

  get enabled() {
    return Boolean(this.primary?.enabled || this.primary || this.fallback?.enabled || this.fallback);
  }

  async generate(input) {
    try {
      return await this.primary.generate(input);
    } catch (error) {
      if (!this.fallback) {
        throw error;
      }
      const enhancement = await this.fallback.generate(input);
      const metadata = getNarrativeMetadata(enhancement);
      return withNarrativeMetadata(enhancement, {
        provider: metadata.provider || this.fallback.provider,
        model: metadata.model || this.fallback.model,
        fallbackFrom: this.primary.provider
      });
    }
  }

  async generatePart(input = {}) {
    const part = input.part;
    if (part !== 'narrative' && part !== 'dev') {
      throw new Error(`Unsupported fallback narrative part: ${part || 'unknown'}`);
    }

    if (typeof this.primary?.generatePart === 'function') {
      try {
        const enhancement = await this.primary.generatePart(input);
        const metadata = getNarrativeMetadata(enhancement);
        return withNarrativeMetadata(enhancement, {
          provider: metadata.provider || this.primary.provider,
          model: metadata.model || this.primary.model,
          fallbackFrom: metadata.fallbackFrom,
          part
        });
      } catch (error) {
        if (!this.fallback) {
          throw error;
        }
      }
    }

    if (!this.fallback) {
      throw new Error('No fallback narrative generator is configured');
    }

    const enhancement = await this.fallback.generate(input);
    const metadata = getNarrativeMetadata(enhancement);
    const partialEnhancement =
      part === 'narrative'
        ? { rawNarrative: enhancement?.rawNarrative || enhancement?.communityNarrative || enhancement?.narrativeCore }
        : { rawDev: enhancement?.rawDev || enhancement?.devIdentity || enhancement?.devBacking };

    return withNarrativeMetadata(compactObject(partialEnhancement), {
      provider: metadata.provider || this.fallback.provider,
      model: metadata.model || this.fallback.model,
      fallbackFrom: this.primary?.provider,
      part
    });
  }
}

export function createDeepSeekNarrativeGeneratorFromEnv(env = process.env) {
  if (env.NARRATIVE_PROVIDER !== 'deepseek') {
    return null;
  }
  if (!env.DEEPSEEK_API_KEY) {
    return null;
  }

  return new DeepSeekNarrativeGenerator({
    apiKey: env.DEEPSEEK_API_KEY,
    baseUrl: env.DEEPSEEK_BASE_URL || 'https://api.deepseek.com',
    model: env.DEEPSEEK_MODEL || 'deepseek-v4-pro',
    timeoutMs: env.DEEPSEEK_TIMEOUT_MS ? Number(env.DEEPSEEK_TIMEOUT_MS) : undefined
  });
}

function createDeepSeekFallbackFromEnv(env = process.env) {
  if (!env.DEEPSEEK_API_KEY) {
    return null;
  }

  return new DeepSeekNarrativeGenerator({
    apiKey: env.DEEPSEEK_API_KEY,
    baseUrl: env.DEEPSEEK_BASE_URL || 'https://api.deepseek.com',
    model: env.DEEPSEEK_MODEL || 'deepseek-v4-pro',
    timeoutMs: env.DEEPSEEK_TIMEOUT_MS ? Number(env.DEEPSEEK_TIMEOUT_MS) : undefined
  });
}

function createDeepSeekRawTextFormatterFromEnv(env = process.env) {
  if (!env.DEEPSEEK_API_KEY) {
    return null;
  }

  return new DeepSeekRawTextFormatter({
    apiKey: env.DEEPSEEK_API_KEY,
    baseUrl: env.DEEPSEEK_BASE_URL || 'https://api.deepseek.com',
    model: env.DEEPSEEK_FORMAT_MODEL || 'deepseek-v4-flash',
    timeoutMs: env.DEEPSEEK_FORMAT_TIMEOUT_MS
      ? Number(env.DEEPSEEK_FORMAT_TIMEOUT_MS)
      : env.DEEPSEEK_TIMEOUT_MS
        ? Number(env.DEEPSEEK_TIMEOUT_MS)
        : undefined
  });
}

function createGrokNarrativeGeneratorFromEnv(env = process.env) {
  if (!env.GROK_API_KEY) {
    return null;
  }

  return new GrokNarrativeGenerator({
    apiKey: env.GROK_API_KEY,
    baseUrl: env.GROK_BASE_URL || 'https://api.x.ai/v1',
    model: env.GROK_MODEL || 'grok-4.3',
    reasoningEffort: env.GROK_REASONING_EFFORT || 'expert',
    timeoutMs: env.GROK_TIMEOUT_MS ? Number(env.GROK_TIMEOUT_MS) : undefined,
    foregroundSearchTimeoutMs: env.GROK_FOREGROUND_SEARCH_TIMEOUT_MS
      ? Number(env.GROK_FOREGROUND_SEARCH_TIMEOUT_MS)
      : undefined,
    backgroundSearchTimeoutMs: env.GROK_BACKGROUND_SEARCH_TIMEOUT_MS
      ? Number(env.GROK_BACKGROUND_SEARCH_TIMEOUT_MS)
      : undefined,
    backgroundConcurrency: env.GROK_BACKGROUND_CONCURRENCY
      ? Number(env.GROK_BACKGROUND_CONCURRENCY)
      : undefined,
    rawFormatter: createDeepSeekRawTextFormatterFromEnv(env)
  });
}

export function createNarrativeGeneratorFromEnv(env = process.env) {
  if (env.NARRATIVE_PROVIDER === 'grok') {
    const primary = createGrokNarrativeGeneratorFromEnv(env);
    if (!primary) {
      return createDeepSeekFallbackFromEnv(env);
    }
    const fallback = createDeepSeekFallbackFromEnv(env);
    return fallback
      ? new FallbackNarrativeGenerator({ primary, fallback })
      : primary;
  }

  return createDeepSeekNarrativeGeneratorFromEnv(env);
}
