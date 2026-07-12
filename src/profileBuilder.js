function normalizeText(value) {
  return String(value || '');
}

function decodeHtmlEntities(value) {
  return normalizeText(value)
    .replace(/&#(\d+);/g, (_, code) => String.fromCharCode(Number(code)))
    .replace(/&#x([a-f0-9]+);/gi, (_, code) => String.fromCharCode(parseInt(code, 16)))
    .replace(/&quot;/g, '"')
    .replace(/&#39;/g, "'")
    .replace(/&amp;/g, '&')
    .replace(/&lt;/g, '<')
    .replace(/&gt;/g, '>');
}

function cleanPublicText(value) {
  return decodeHtmlEntities(value)
    .split(/\r?\n/)
    .map((line) => line.trim())
    .filter((line) => line && !/^(?:title|url source|published time|markdown content):/i.test(line))
    .join(' ')
    .replace(/\s+/g, ' ')
    .trim();
}

function normalizeLower(value) {
  return decodeHtmlEntities(value).toLowerCase();
}

function safeNumber(value) {
  if (value === null || value === undefined || value === '') {
    return null;
  }
  const number = Number(String(value).replace(/,/g, ''));
  return Number.isFinite(number) ? number : null;
}

function unique(items) {
  return [...new Set(items.filter(Boolean))];
}

function uniqueCleanText(items) {
  const seen = new Set();
  const results = [];

  for (const item of items) {
    const cleaned = cleanPublicText(item);
    const key = cleaned.toLowerCase();
    if (!cleaned || seen.has(key)) {
      continue;
    }
    seen.add(key);
    results.push(cleaned);
  }

  return results;
}

function normalizeHandle(value) {
  const raw = normalizeText(value).trim().replace(/^@/, '');
  if (!/^[A-Za-z0-9_]{2,20}$/.test(raw)) {
    return null;
  }
  return `@${raw}`;
}

function normalizeWallet(value) {
  return normalizeText(value).match(/0x[a-fA-F0-9]{40}/)?.[0]?.toLowerCase() || null;
}

function xUrlFromHandle(handle) {
  const normalized = normalizeHandle(handle);
  return normalized ? `https://x.com/${normalized.slice(1)}` : null;
}

function extractXHandle(value) {
  const text = normalizeText(value);
  const directHandle = text.match(/@([A-Za-z0-9_]{2,20})/)?.[1];
  if (directHandle) {
    return normalizeHandle(directHandle);
  }

  const urlHandle = text.match(/(?:https?:\/\/)?(?:www\.)?(?:x|twitter)\.com\/([A-Za-z0-9_]{2,20})(?:[/?#\s)]|$)/i)?.[1];
  return normalizeHandle(urlHandle);
}

function extractXProfileUrl(value) {
  const handle = extractXHandle(value);
  return xUrlFromHandle(handle);
}

function hasAny(text, keywords) {
  return keywords.some((keyword) => {
    if (keyword === 'ai') {
      return /(^|[^a-z0-9])ai([^a-z0-9]|$)/i.test(text);
    }
    return text.includes(keyword);
  });
}

function snippet(value, maxLength = 220) {
  const text = cleanPublicText(value);
  return text.length > maxLength ? `${text.slice(0, maxLength - 1)}…` : text;
}

function formatFollowers(value) {
  const number = safeNumber(value);
  if (number === null) {
    return null;
  }
  if (number >= 10000) {
    return `${(number / 10000).toFixed(2).replace(/\.?0+$/, '')}万`;
  }
  return `${number}`;
}

function formatCompactNumber(value) {
  const number = safeNumber(value);
  if (number === null) {
    return null;
  }
  if (number >= 1000000) {
    return `${(number / 1000000).toFixed(2).replace(/\.?0+$/, '')}m`;
  }
  if (number >= 1000) {
    return `${(number / 1000).toFixed(2).replace(/\.?0+$/, '')}k`;
  }
  return `${number}`;
}

function compactEvidenceText(value) {
  return normalizeLower(value).replace(/\s+/g, ' ');
}

function evidenceHas(text, keywords) {
  const normalized = compactEvidenceText(text);
  return keywords.some((keyword) => normalized.includes(normalizeLower(keyword)));
}

function describeMatchedSignals(text) {
  const items = [];
  if (evidenceHas(text, ['staff eng', 'staff engineer'])) {
    items.push('Staff Eng');
  }
  if (evidenceHas(text, ['@unity', ' unity'])) {
    items.push('Unity');
  }
  if (evidenceHas(text, ['repoprompt', 'repo prompt'])) {
    items.push('RepoPrompt');
  }
  if (evidenceHas(text, ['mcp'])) {
    items.push('MCP');
  }
  if (evidenceHas(text, ['codemaps', 'code maps'])) {
    items.push('codemaps');
  }
  if (evidenceHas(text, ['gpt', 'opus', 'model routing', 'coding models', 'prompt', 'orchestrate'])) {
    items.push('模型工作流/提示工程');
  }
  if (evidenceHas(text, ['credit layer', 'agentic economy', 'verifiable credit', 'underwritten credit'])) {
    items.push('AI 金融/agent 信用');
  }
  if (evidenceHas(text, ['router for tool calls', 'tool calls', 'endpoint'])) {
    items.push('工具调用路由');
  }
  if (evidenceHas(text, ['gladium', 'gladium ai'])) {
    items.push('Gladium AI');
  }
  if (evidenceHas(text, ['free-code', 'free code'])) {
    items.push('free-code');
  }
  if (evidenceHas(text, ['claude code'])) {
    items.push('Claude Code');
  }
  if (evidenceHas(text, ['github', 'stars', 'forks', 'readme'])) {
    items.push('GitHub 开源');
  }
  if (evidenceHas(text, ['solscan'])) {
    items.push('Solscan');
  }
  if (evidenceHas(text, ['goodheart labs', 'viewpoints'])) {
    items.push('Goodheart Labs/Viewpoints');
  }
  if (evidenceHas(text, ['community notes', 'note-writer'])) {
    items.push('AI-written Community Notes');
  }
  if (evidenceHas(text, ['eqtylab', 'eqty lab'])) {
    items.push('EQTYLab');
  }
  if (evidenceHas(text, ['plannotator'])) {
    items.push('plannotator');
  }
  if (evidenceHas(text, ['complex systems'])) {
    items.push('complex systems');
  }
  return unique(items);
}

export function parseBankrLaunchMarkdown(markdown) {
  const lines = normalizeText(markdown)
    .split('\n')
    .map((line) => line.trim())
    .filter(Boolean);
  const fieldNames = new Set(['launcher', 'fee recipient', 'chain', 'contract address', 'transaction']);

  const valueAfter = (needle) => {
    const index = lines.findIndex((line) => line.toLowerCase() === needle.toLowerCase());
    if (index < 0) {
      return null;
    }
    for (let cursor = index + 1; cursor < lines.length; cursor += 1) {
      const candidate = lines[cursor];
      if (!candidate || candidate.startsWith('## ')) {
        continue;
      }
      if (fieldNames.has(candidate.toLowerCase())) {
        return null;
      }
      return candidate;
    }
    return null;
  };

  const valueBlockAfter = (needle) => {
    const index = lines.findIndex((line) => line.toLowerCase() === needle.toLowerCase());
    if (index < 0) {
      return [];
    }
    const values = [];
    for (let cursor = index + 1; cursor < lines.length; cursor += 1) {
      const candidate = lines[cursor];
      if (!candidate || candidate.startsWith('## ')) {
        continue;
      }
      if (fieldNames.has(candidate.toLowerCase())) {
        break;
      }
      values.push(candidate);
    }
    return values;
  };

  const titleLine = lines.find((line) => line.startsWith('## ') && !/token info/i.test(line));
  const tokenName = titleLine ? titleLine.replace(/^##\s+/, '').trim() : null;
  const feeRecipientText = valueBlockAfter('Fee Recipient').join(' ');
  const feeRecipientWallet = normalizeWallet(feeRecipientText);
  const feeRecipientHandle = extractXHandle(feeRecipientText);
  const feeRecipientUrl = extractXProfileUrl(feeRecipientText);
  const chain = valueAfter('Chain');
  const launcher = valueAfter('Launcher');

  return {
    tokenName,
    feeRecipientWallet,
    feeRecipientHandle,
    feeRecipientUrl,
    chain: chain || null,
    launcher: launcher || null
  };
}

export function parseBankrLaunchApi(payload) {
  const launch = payload?.launch || payload?.exactMatch || payload || null;
  if (!launch || typeof launch !== 'object') {
    return {};
  }

  const feeRecipientHandle = normalizeHandle(launch.feeRecipient?.xUsername);
  const deployerHandle = normalizeHandle(launch.deployer?.xUsername);

  return {
    tokenName: launch.tokenName || null,
    tokenSymbol: launch.tokenSymbol || null,
    chain: launch.chain || null,
    tokenAddress: normalizeWallet(launch.tokenAddress),
    poolId: launch.poolId || null,
    txHash: launch.txHash || null,
    launchType: launch.launchType || null,
    timestamp: launch.timestamp || null,
    feeRecipientWallet: normalizeWallet(launch.feeRecipient?.walletAddress),
    feeRecipientHandle,
    feeRecipientUrl: xUrlFromHandle(feeRecipientHandle),
    feeRecipientProfileImageUrl: launch.feeRecipient?.xProfileImageUrl || null,
    deployerWallet: normalizeWallet(launch.deployer?.walletAddress),
    deployerHandle,
    deployerUrl: xUrlFromHandle(deployerHandle),
    deployerProfileImageUrl: launch.deployer?.xProfileImageUrl || null,
    tweetUrl: launch.tweetUrl || null,
    websiteUrl: launch.websiteUrl || null,
    metadataUri: launch.metadataUri || null
  };
}

export function parseXProfileMarkdown(markdown) {
  const text = normalizeText(markdown);
  const lines = text
    .split('\n')
    .map((line) => line.trim())
    .filter(Boolean);

  const handle = lines.find((line) => /^@\w/.test(line)) || null;
  const handleIndex = handle ? lines.findIndex((line) => line === handle) : -1;
  const linesBeforeHandle = handleIndex > 0 ? lines.slice(0, handleIndex) : lines;
  const headingName =
    linesBeforeHandle
      .map((line) => (line.startsWith('## ') ? line.replace(/^##\s+/, '').trim() : null))
      .reverse()
      .find((line) => line && !line.startsWith('[](')) || null;
  const displayName =
    headingName ||
    (handleIndex > 0
      ? [...linesBeforeHandle]
          .reverse()
          .find((line) => !/posts$/i.test(line) && !line.startsWith('[') && !line.startsWith('## '))
      : null);
  const bioIndex = handle ? lines.findIndex((line) => line === handle) + 1 : -1;
  const bio = bioIndex > 0 ? lines[bioIndex] || null : null;
  const joined = text.match(/\[Joined ([^\]]+)\]/)?.[1] || null;
  const followers = safeNumber(text.match(/\[([\d,]+) Followers\]/)?.[1] || null);
  const following = safeNumber(text.match(/\[([\d,]+) Following\]/)?.[1] || null);
  const posts = safeNumber(text.match(/\n([\d,]+) posts/i)?.[1] || null);

  return {
    displayName,
    handle,
    bio,
    joined,
    followers,
    following,
    posts
  };
}

export function parseXInitialStateHtml(html) {
  const text = normalizeText(html);
  const marker = 'window.__INITIAL_STATE__=';
  const start = text.indexOf(marker);
  if (start < 0) {
    return {};
  }
  const jsonStart = start + marker.length;
  const jsonEnd =
    text.indexOf(';window.__META_DATA__', jsonStart) >= 0
      ? text.indexOf(';window.__META_DATA__', jsonStart)
      : text.indexOf(';</script>', jsonStart);
  const jsonText = jsonEnd > jsonStart ? text.slice(jsonStart, jsonEnd) : '';

  let state;
  try {
    state = JSON.parse(jsonText);
  } catch {
    return {};
  }

  const users = Object.entries(state?.entities?.users?.entities || {}).map(([id, item]) => ({
    id_str: item?.id_str || id,
    ...item
  }));
  const tweets = Object.values(state?.entities?.tweets?.entities || {});
  const user =
    users.find((item) => item?.screen_name && (item?.description || item?.name)) ||
    users.find((item) => item?.screen_name) ||
    null;

  if (!user) {
    return {};
  }

  const handle = normalizeHandle(user.screen_name);
  const tweetTexts = tweets
    .filter((item) => !handle || item?.user === user.id_str || item?.in_reply_to_screen_name === handle.slice(1))
    .map((item) => item?.full_text || item?.text)
    .filter(Boolean);
  const markdown = unique([user.description, ...tweetTexts])
    .map((item) => normalizeText(item).trim().replace(/\s+/g, ' '))
    .filter(Boolean)
    .join(' ');

  return {
    displayName: user.name || null,
    handle,
    bio: user.description || null,
    joined: user.created_at || null,
    followers: safeNumber(user.followers_count),
    following: safeNumber(user.friends_count),
    posts: safeNumber(user.statuses_count),
    markdown: markdown || null
  };
}

function chainLabel(bankr) {
  const chain = normalizeLower(bankr?.chain || 'base');
  return chain === 'base' ? 'Base' : bankr?.chain || 'Base';
}

function tokenSymbol(row, bankr) {
  return bankr?.tokenSymbol || row.symbol || row.name || 'UNKNOWN';
}

function tokenName(row, bankr) {
  return bankr?.tokenName || row.name || row.symbol || tokenSymbol(row, bankr);
}

function caIntro({ row, bankr, kind }) {
  const symbol = tokenSymbol(row, bankr);
  const name = tokenName(row, bankr);
  return `这个 CA（${row.address}）是 ${chainLabel(bankr)} 链上的 ${kind} —— $${symbol}（${name}）。`;
}

function researchDetails(core, backing, risk) {
  return [
    {
      label: '叙事核心（社区主推版本）',
      value: core
    },
    {
      label: 'Dev 背书 + 社区期待',
      value: backing
    },
    {
      label: '风险/未确认',
      value: risk
    }
  ];
}

function researchOrigin(core, backing, risk) {
  return `叙事核心（社区主推版本）：${core} Dev 背书 + 社区期待：${backing} 风险/未确认：${risk}`;
}

function firstDefined(...values) {
  return values.find((value) => value !== null && value !== undefined && value !== '');
}

function formatPercent(value) {
  const number = safeNumber(value);
  return number === null ? null : `${number.toFixed(2).replace(/\.?0+$/, '')}%`;
}

function marketPairName(market) {
  if (market?.pairName) {
    return market.pairName;
  }
  if (market?.baseTokenSymbol && market?.quoteTokenSymbol) {
    return `${market.baseTokenSymbol}/${market.quoteTokenSymbol}`;
  }
  return null;
}

function sourceBacking({ bankr, xProfile, website, github }) {
  const parts = [];
  if (bankr?.feeRecipientHandle) {
    parts.push(`Bankr Fee Recipient 指向 ${bankr.feeRecipientHandle}`);
  } else if (bankr?.feeRecipientWallet) {
    parts.push(`Bankr Fee Recipient 只确认到钱包 ${bankr.feeRecipientWallet}`);
  }
  if (bankr?.deployerHandle) {
    parts.push(`deployer 是 ${bankr.deployerHandle}`);
  }
  if (xProfile?.handle) {
    parts.push(`公开 X 账号是 ${xProfile.handle}${xProfile?.followers ? `，粉丝约 ${formatFollowers(xProfile.followers)}` : ''}`);
  }
  if (github?.user?.login) {
    const repo = githubReposByStars(github)[0] || null;
    const stats = formatRepoStats(repo);
    parts.push(`GitHub 是 ${github.user.login}${repo ? `，代表 repo ${repo.fullName}${stats ? `（${stats}）` : ''}` : ''}`);
  }
  if (website?.url) {
    parts.push(`官网是 ${website.url}`);
  }
  return parts.length ? parts.join('；') : '目前没抓到足够强的 dev/官网/社区背书，只能先按公开资料和链上发行线索观察。';
}

function markdownLines(value) {
  return normalizeText(value)
    .split('\n')
    .map((line) => line.trim())
    .filter(Boolean);
}

function isNoiseMarkdownLine(line) {
  return (
    /^(title|url source|published time|markdown content):/i.test(line) ||
    /^!\[/.test(line) ||
    /^\[!\[/.test(line) ||
    /^#+\s*(key capabilities|project metrics)$/i.test(line) ||
    /^(production|beta|prototype)$/i.test(line) ||
    /^active since/i.test(line)
  );
}

function extractProductHighlights(markdown, limit = 4) {
  const lines = markdownLines(markdown);
  const highlights = [];

  for (let index = 0; index < lines.length; index += 1) {
    const heading = lines[index].match(/^###\s+(.+)$/)?.[1]?.trim();
    if (!heading || isNoiseMarkdownLine(heading)) {
      continue;
    }

    let description = null;
    for (let cursor = index + 1; cursor < lines.length; cursor += 1) {
      const candidate = lines[cursor];
      if (/^###\s+/.test(candidate)) {
        break;
      }
      if (isNoiseMarkdownLine(candidate) || /^\*\s+/.test(candidate) || /^####\s+/.test(candidate)) {
        continue;
      }
      description = candidate;
      break;
    }

    if (description) {
      highlights.push(`${heading}：${snippet(description, 170)}`);
    }
  }

  return unique(highlights).slice(0, limit);
}

function extractCapabilityHighlights(markdown, limit = 6) {
  const capabilities = markdownLines(markdown)
    .map((line) => line.match(/^\*\s+(.+)$/)?.[1]?.trim())
    .filter(Boolean)
    .filter((line) => !/^!\[/.test(line));
  return unique(capabilities).slice(0, limit);
}

function virtualsProjectMembers(virtuals) {
  return Array.isArray(virtuals?.projectMembers) ? virtuals.projectMembers.filter(Boolean) : [];
}

function virtualsMemberRoleText(member) {
  return [member?.title, member?.bio].filter(Boolean).join(' ');
}

function virtualsMemberLabel(member) {
  const name = member?.displayName || member?.title || member?.twitterHandle || member?.githubUsername || '未命名成员';
  const handles = [
    member?.twitterHandle,
    member?.githubUsername ? `GitHub ${member.githubUsername}` : null,
    member?.telegramHandle ? `Telegram ${member.telegramHandle}` : null
  ]
    .filter(Boolean)
    .join(' / ');
  const role = member?.title && member.title !== name ? member.title : null;
  return [name, role, handles].filter(Boolean).join('，');
}

function primaryVirtualsTeamMember(virtuals) {
  const members = virtualsProjectMembers(virtuals);
  return (
    members.find((member) => member?.twitterHandle && /founder|co-founder|ceo/i.test(virtualsMemberRoleText(member))) ||
    members.find((member) => member?.twitterHandle && /cto|chief|lead/i.test(virtualsMemberRoleText(member))) ||
    members.find((member) => member?.twitterHandle) ||
    members.find((member) => member?.githubUsername) ||
    members[0] ||
    null
  );
}

function virtualsTeamSummary(virtuals, limit = 4) {
  return virtualsProjectMembers(virtuals)
    .map((member) => {
      const bio = member?.bio ? `；${snippet(member.bio, 180)}` : '';
      return `${virtualsMemberLabel(member)}${bio}`;
    })
    .slice(0, limit)
    .join('；');
}

function virtualsTeamSourceLinks(virtuals) {
  return virtualsProjectMembers(virtuals).flatMap((member) => [member?.twitterUrl, member?.githubUrl, member?.telegramUrl]);
}

function virtualsProductText(virtuals) {
  return [
    virtuals?.overview,
    virtuals?.description,
    virtuals?.tokenUtility,
    virtuals?.roadmap,
    virtuals?.additionalDetails,
    virtuals?.projectWebsiteUrl,
    virtuals?.projectTwitterHandle,
    virtuals?.projectTwitterUrl,
    virtuals?.videoPitchTweetUrl,
    ...virtualsProjectMembers(virtuals).map((member) =>
      [member.title, member.displayName, member.twitterHandle, member.githubUsername, member.bio].filter(Boolean).join(' ')
    )
  ]
    .filter(Boolean)
    .join(' ');
}

function hasVirtualsPhysicalAiRobotics(text) {
  return evidenceHas(text, [
    'physical ai',
    'humanoid',
    'robotics',
    'ares',
    'vision-language-action',
    'vla',
    'defense',
    'battlefield',
    'hazardous',
    'unitree',
    'isaac sim',
    'nvidia groot',
    'openvla',
    'ros 2',
    'anduril'
  ]);
}

function describeNarrative({ row, websiteText, xBioText, market, sources = {} }) {
  const bankr = sources.bankr || null;
  const xProfile = sources.xProfile || null;
  const website = sources.website || null;
  const github = sources.github || null;
  const gecko = sources.gecko || null;
  const virtuals = sources.virtuals || null;
  const githubText = githubSourceText(github);
  const geckoText = [gecko?.description, ...(gecko?.categories || []), ...(gecko?.categoryIds || []), gecko?.virtualsUrl]
    .filter(Boolean)
    .join(' ');
  const virtualsText = [
    virtuals?.url,
    virtuals?.prototypeAddress,
    virtuals?.name,
    virtuals?.symbol,
    virtuals?.description,
    virtuals?.category,
    virtuals?.factory,
    virtuals?.feeDelegationType,
    virtuals?.feeDelegatedRecipient,
    virtualsProductText(virtuals)
  ]
    .filter(Boolean)
    .join(' ');
  const pair = marketPairName(market);
  const text = `${normalizeLower(row.symbol)} ${normalizeLower(row.name)} ${normalizeLower(websiteText)} ${normalizeLower(
    xBioText
  )} ${normalizeLower(bankr?.websiteUrl)} ${normalizeLower(githubText)} ${normalizeLower(geckoText)} ${normalizeLower(
    virtualsText
  )} ${normalizeLower(pair)} ${normalizeLower(market?.quoteTokenName)} ${normalizeLower(market?.quoteTokenSymbol)}`;
  const displayName = row.name || row.symbol || '这个币';
  const shortX = snippet(xBioText, 180);
  const symbol = tokenSymbol(row, bankr);
  const tokenTitleText = [symbol, row.name, bankr?.tokenName].filter(Boolean).join(' ');
  const topGithubRepo = githubReposByStars(github)[0] || null;
  const topRepoStats = formatRepoStats(topGithubRepo);
  const launchTweetHandle = extractXHandle(bankr?.tweetUrl || '');
  const productHighlights = extractProductHighlights(websiteText, 5);
  const capabilityHighlights = extractCapabilityHighlights(websiteText, 8);
  const freeCodeAnchorText = [
    symbol,
    row.name,
    bankr?.tokenName,
    bankr?.websiteUrl,
    xProfile?.handle,
    github?.user?.login,
    github?.user?.name,
    github?.user?.company,
    topGithubRepo?.fullName
  ]
    .filter(Boolean)
    .join(' ');
  const isFreeCodeNarrative =
    evidenceHas(freeCodeAnchorText, ['freecode', 'free-code', 'paoloanzn']) ||
    normalizeLower(row.address) === '0x67a7ca081dc79b45fd1fa059cd3b8dcca779aba3';
  const isPlannotatorNarrative =
    evidenceHas(text, ['plannotator']) ||
    normalizeLower(symbol) === 'plan' ||
    normalizeLower(row.address) === '0xe115314e331537ec8be34c8329639e1228520ba3';
  const isKatchNarrative =
    evidenceHas(text, ['katch_live', 'katch live', 'real life short video', 'world verified', 'world verification']) ||
    normalizeLower(symbol).includes('katch') ||
    normalizeLower(row.address) === '0xd570281a7595faa936acf7aa3e3eaae7f476eba3';
  const isRecordlyNarrative =
    evidenceHas(text, ['recordly']) &&
    evidenceHas(text, ['screen recorder', 'screen recordings', 'auto-zoom', 'timeline editing', 'screen studio']);
  const isLikwidNarrative =
    evidenceHas(text, ['likwid']) &&
    evidenceHas(text, [
      'oracle-free',
      'margin trading',
      'lending for any token',
      'swap, lending & margin',
      'long-tail leverage',
      'amm + lending'
    ]);
  const isPrintingPressNarrative =
    evidenceHas(text, ['cli-printing-press', 'printing press']) &&
    evidenceHas(text, ['ai agents', 'mcp server', 'claude code skill', 'token-efficient go cli', 'sqlite sync']);
  const isLibreChatNarrative =
    evidenceHas(text, ['librechat', 'danny-avila/librechat']) &&
    evidenceHas(text, [
      'enhanced chatgpt clone',
      'self-hosted ai chat platform',
      'ai model selection',
      'code interpreter api',
      'librechat agents',
      'open-source for self-hosting'
    ]);
  const isLocalAiNarrative =
    normalizeLower(row.address) === '0x905bc4f1e4ece2ff2d46e6d6e7934bc6610c0ba3' ||
    (evidenceHas(text, ['localai']) &&
      evidenceHas(text, [
        'openai-compatible',
        'openai compatible',
        'openai, anthropic alternative',
        'local inference',
        'local inferencing',
        'run powerful language models',
        'run llms',
        'embeddings',
        'image generation',
        'audio'
      ]));
  const isLazyCodexNarrative =
    normalizeLower(row.address) === '0x9175e6be4ca255ffb0b5f57454156514ce9e1ba3' ||
    (evidenceHas(text, ['lazycodex', 'lazy codex']) &&
      evidenceHas(text, ['codex for lazy people', 'omo in codex', 'opencode', 'ultrawork']));
  const isBlindCacheNarrative =
    normalizeLower(row.address) === '0xebfa52204be13672bc021102ad723e457b47cba3' ||
    (evidenceHas(text, ['blindcache']) &&
      evidenceHas(text, ['encrypted memory layer', 'nillion', 'blind computer', 'mcp server', 'vault sdk']));
  const isOpenAgentHarnessNarrative =
    !isLazyCodexNarrative &&
    !isBlindCacheNarrative &&
    evidenceHas(text, ['oh my openagent', 'openagent', 'sisyphus']) &&
    evidenceHas(text, [
      'agent harness',
      'batteries-included',
      'codes like you',
      'multi-model orchestration',
      'prompt-to-code',
      'tea integration'
    ]);
  const isEccAgentHarnessNarrative =
    !isLazyCodexNarrative &&
    !isBlindCacheNarrative &&
    (normalizeLower(row.address) === '0x9f5128cf058526c8480d1665ef5c63dc241b9ba3' ||
      (evidenceHas(text, ['ecc', 'agent harness', 'oss agent meta-harness']) &&
        evidenceHas(text, ['claude code', 'codex', 'opencode', 'cursor']) &&
        evidenceHas(text, ['skills', 'instincts', 'memory', 'security', 'mcp', 'codemaps'])));
  const isZbasePrivacyPaymentsNarrative =
    normalizeLower(row.address) === '0xde6e0fe372727db236573bf8b9f32126ea141ba3' ||
    (evidenceHas(text, ['zbase']) &&
      evidenceHas(text, ['x402', 'zero-knowledge', 'privacy pools', 'groth16']) &&
      evidenceHas(text, ['agent payments', 'private payments', 'privacy facilitator']));
  const isPhysicalAiAttestationNarrative =
    (evidenceHas(text, ['stargaze']) &&
      evidenceHas(text, ['physical ai', 'verifiable attestations', 'attestation', 'zero-knowledge', 'groth16', 'eas'])) ||
    normalizeLower(row.address) === '0xf10500ebdb281a73bc19979bfceb45b1a7a01b07';
  const isHumanCvNarrative =
    (evidenceHas(text, ['human.cv']) &&
      evidenceHas(text, ['proof that i made it', 'what you made is yours', 'on-chain résumé', 'on-chain resume', 'verified human'])) ||
    normalizeLower(row.address) === '0xc53f0bfb346ab19ecdcb540a4aa560448be85ba3';
  const isAuraDeFiAnalystNarrative =
    (evidenceHas(text, ['aurapay']) &&
      evidenceHas(text, ['onchain liquidity', 'retention analyst', 'defi educator', 'dune wizard'])) ||
    normalizeLower(row.address) === '0x4832698221091cc869cb9329dd0e5eb9f3796ba3';
  const hasHunchProjectSignals =
    normalizeLower(symbol) === 'hunch' ||
    evidenceHas(text, ['playhunch', 'back your hunch', 'social swipe feed', 'best-execution router']);
  const isHunchNarrative =
    evidenceHas(text, ['playhunch', 'back your hunch']) ||
    (hasHunchProjectSignals &&
      evidenceHas(text, ['prediction markets', 'yes or no', 'visible odds', 'best-execution router', 'social swipe feed']));
  const isBankrAgentNarrative =
    evidenceHas(text, ['bankr fund']) ||
    (evidenceHas(text, ['skills demo', 'agent executes', 'onchain payments']) &&
      evidenceHas(text, ['bankr', 'uniswap v3', 'rebalancing automations']));
  const isMoatNarrative =
    evidenceHas(text, ['laravel/moat', 'security posture', 'github organization']) &&
    evidenceHas(text, ['2fa enforcement', 'branch protection', 'secret scanning', 'dependabot alerts']);
  const isDmnNarrative =
    evidenceHas(text, ['deamon net', '@dmn_net', 'dmn-net.io']) &&
    evidenceHas(text, ['agents that never sleep', 'event-to-execution', 'live on base']);
  const isSecurityResearcherNarrative =
    evidenceHas(text, ['security researcher', 'reverse engineer']) &&
    evidenceHas(text, ['windows kernel', 'low-level programming', 'static program analysis', 'cryptography']);
  const isResearchAutomationNarrative =
    evidenceHas(text, ['research automation', 'scheduled reports']) &&
    evidenceHas(text, ['workflow automation', 'model routing', 'inference']);
  const isThinAgentPersonaNarrative =
    hasAny(normalizeLower(tokenTitleText), ['agent']) &&
    !website?.markdown &&
    !github?.user?.login &&
    !virtuals?.id &&
    !virtuals?.prototypeAddress &&
    !gecko?.virtualsId;
  const isCivicConsensusNarrative = hasAny(text, [
    'goodheart labs',
    'viewpoints',
    'community mediation',
    'ai-powered polling',
    'finding consensus',
    'community notes',
    'note-writer',
    'fact-checking',
    'fact checking'
  ]);
  const isVirtualsNarrative = Boolean(
    virtuals?.id ||
      virtuals?.prototypeAddress ||
      evidenceHas(virtuals?.url, ['app.virtuals.io/prototypes']) ||
      gecko?.virtualsId ||
      evidenceHas(geckoText, ['virtuals protocol', 'virtuals-protocol']) ||
      normalizeLower(market?.quoteTokenSymbol) === 'virtual' ||
      evidenceHas(market?.quoteTokenName, ['virtual protocol'])
  );

  if (isFreeCodeNarrative) {
    return {
      category: 'AI',
      label: 'AI dev meme',
      thesis: caIntro({ row, bankr, kind: 'AI dev meme coin' }),
      origin:
        '叙事核心（社区主推版本）：$FreeCode 炒的是代码自由 / 反限制 / 开源编码工具叙事，把 free-code 这个真实 GitHub 项目和 meme coin 绑定起来。Dev 背书 + 社区期待：Bankr Fee Recipient 指向 @paoloanzn，GitHub 上能看到 free-code 和 Gladium AI 背景，所以社区买点是“这个 dev 真能写、真能交付”。风险/未确认：token 与 free-code 项目的长期权益、收入或官方路线是否绑定还未确认。',
      details: researchDetails(
        '社区在推的是“代码自由 / 反限制 / 开源编码工具”的 AI dev 叙事：开发者围绕 Anthropic Claude Code 做出 free-code，把 Claude Code 的 telemetry、guardrails、experimental features、多模型 provider 等限制/隐藏能力改成更开放的 coding-agent 工具。它不是单纯喊 AI，而是把一个真实开源编码工具项目变成 $FreeCode meme 的故事核心。',
        `当前最硬的背书是 Bankr Fee Recipient 直接指向 ${bankr?.feeRecipientHandle || '@paoloanzn'}；GitHub 资料显示 ${
          github?.user?.name || 'Paolo Anzani'
        } / ${github?.user?.company || 'Gladium AI'}，代表 repo ${topGithubRepo?.fullName || 'paoloanzn/free-code'}${
          topRepoStats ? `（${topRepoStats}）` : '（8.38k stars / 1.99k forks）'
        }。社区期待点是：这不是空壳 meme，而是一个已经有开源产品、开发者声誉和 Base/Bankr 关注度的 AI builder 叙事。`,
        '风险是它仍然是 meme coin：还要确认 $FreeCode 与 free-code 项目后续功能、收入、治理或官方路线有没有真实绑定；如果只有社区情绪和 dev 名声，短线可以强，但长期价值仍取决于 dev 是否持续认领和交付。'
      )
    };
  }

  if (isKatchNarrative) {
    return {
      category: 'Meme',
      label: '社区产品 meme',
      thesis: `这个 CA（${row.address}）是 ${chainLabel(bankr)} 链上的 $${symbol}（${tokenName(row, bankr)}）社区 meme coin。`,
      origin:
        '叙事核心（社区主推版本）：$Katch 对应 @Katch_live 这个真实生活短视频赚钱 App，核心是“随手拍真实生活，完成日常行动就能 earn”。Dev 背书 + 社区期待：Bankr deployer / fee recipient / launch tweet 把 @DimaLoord、@Katch_live、@Flynnjamm 这些线索串起来，社区预期它可能被项目方持续支持。风险/未确认：目前仍要区分社区预期和正式 dev-backed 认领。',
      details: researchDetails(
        '社区在推的是 Katch_live 产品映射：定位为“真实生活短视频赚钱 App”，用户选择本来就要做的日常行动，拍 1 分钟视频并获得奖励；公开资料提到 World verification / World 验证和数千用户叙事。简单说就是 Web3 版生活记录 + 赚钱社交，买点是“真实、随手记录、能 earn”。',
        `Bankr 线索显示 deployer 是 ${bankr?.deployerHandle || '@DimaLoord'}，Fee Recipient 是 ${
          bankr?.feeRecipientHandle || '@Katch_live'
        }，launch tweet 指向 ${launchTweetHandle || '@Flynnjamm'}；社区叙事把它包装成可能被 dev-backed 的产品 meme，期待项目方继续更新、认领手续费或把 token 和 Katch_live 进展绑定。`,
        '风险是当前仍偏社区驱动 + 预期驱动：@Flynnjamm / @Katch_live 是否正式支持、是否认领手续费、token 和 App 增长之间有没有真实关系都需要继续确认；如果只是社区抢跑而没有官方持续动作，叙事会很容易回落。'
      )
    };
  }

  if (isPlannotatorNarrative) {
    const core =
      '$' +
      symbol +
      ' 的叙事核心是 plannotator：给 AI coding agents 的计划和代码审查做可视化标注。它围绕 plan review、code diff review、团队协作和把反馈一键送回 coding agent 的 AI devtools 展开。公开资料写到它能标注 plans、specs、folders、files、URLs 和 code diffs，并集成 Claude Code、Copilot CLI、Gemini CLI、OpenCode、Codex、Droid 等工具。';
    const backing = `${sourceBacking({ bankr, xProfile, website, github })}；社区期待点是：dev 的 X bio 直接写着 For fun: @plannotator，Bankr Fee Recipient 指向 @backnotprop，Bankr website 指到 GitHub repo，这些证据能把币和 plannotator 项目/开发者串起来。这个叙事的买点是“AI coding agent 生态里的人工审阅/协作层”，不是模型本身，也不是纯 meme 名字。`;
    const risk =
      '风险是目前看到的是开源/工具产品和 Bankr 发射绑定，token 与 plannotator 的收入、治理、使用权限或官方长期路线是否有真实关系还没确认；后续要继续看 GitHub 使用量、真实用户、团队协作场景和 dev 持续运营。';

    return {
      category: 'AI',
      label: 'AI代码审查/计划标注',
      thesis: `${caIntro({ row, bankr, kind: 'AI coding agents 计划/代码审查工具项目币' })} 核心是 plannotator：给 coding agent 的 plans 和 code diffs 做可视化标注、协作和反馈回传。`,
      origin: researchOrigin(core, backing, risk),
      details: researchDetails(core, backing, risk)
    };
  }

  if (isEccAgentHarnessNarrative) {
    const core =
      '$' +
      symbol +
      ' 的叙事核心是 ECC Tools：一个开源 OSS Agent Meta-Harness / agent harness performance optimization system。它不是机器验证或物理设备证明方向，也不是泛泛的 AI 应用，而是面向 Claude Code、Codex、Opencode、Cursor 这类 coding agents 的开发者工具框架。公开描述里的关键词很具体：skills、instincts、memory、security、MCP、codemaps 和 research-first development，意思是给 agent 补一层可复用技能、记忆/上下文组织、安全约束和研究优先工作流，让 agent 做代码和研究任务时更稳定、更少走偏。';
    const backing = `${sourceBacking({
      bankr,
      xProfile,
      website,
      github
    })}；社区期待点是：Bankr Fee Recipient 直接指向 @affaanmustafa，Bankr website 指到 affaan-m/ECC，dev 的 X 简介又写着 Creator of ECC: The OSS Agent Meta-Harness。GitHub 侧能看到 ${
      topGithubRepo?.fullName || 'affaan-m/ECC'
    }${topRepoStats ? `（${topRepoStats}）` : ''}，这类证据能把 CA、项目 repo 和 dev 身份串起来。买点是“AI coding agent 工具链 + 开源声誉 + Bankr 公开 dev 绑定”，不是只有名字的 meme。`;
    const risk =
      '风险是 token 与 ECC 工具本身的收入、治理、使用权限或官方路线是否绑定还未确认；GitHub 热度和 dev 背书是强叙事，但短线价格仍会受 Bankr/Base 社区情绪影响。还要继续看 dev 是否持续认领、是否把 agent harness 的实际用户、插件生态或商业化和 token 讲清楚。';

    return {
      category: 'AI',
      label: 'AI Agent工具框架',
      thesis: `${caIntro({ row, bankr, kind: 'AI agent harness / coding-agent 工具框架项目币' })} 核心是 ECC：给 Claude Code、Codex、Opencode、Cursor 等 coding agents 做 skills、memory、security 和 research workflow 的开源 meta-harness。`,
      origin: researchOrigin(core, backing, risk),
      details: researchDetails(core, backing, risk)
    };
  }

  if (isOpenAgentHarnessNarrative) {
    const core =
      '$' +
      symbol +
      ' 的叙事核心是 Oh My OpenAgent / Sisyphus：一个面向编程代理的 batteries-included agent harness。它不是泛泛的 AI 应用，而是把“让 agent 像你一样写代码”做成具体工作流：Sisyphus 负责承接 prompt-to-code 任务，multi-model orchestration 让不同模型参与编码流程，Tea integration / inference routing 这类线索说明它在做 coding-agent 执行层和模型编排层。简单说，社区讲的是“给 AI coding agent 配一套可直接干活的编程框架”，不是单纯喊 agent、automation 或 workflow。';
    const backing = `${sourceBacking({
      bankr,
      xProfile,
      website,
      github
    })}；社区期待点是：官网标题直接写 Oh My OpenAgent — The Best Agent Harness，正文出现 Sisyphus、batteries-included agent、codes like you、Multi-model orchestration 等明确产品词，说明它至少有一个清楚的 AI coding agent 产品方向。这个叙事的买点是“编程代理 harness + 多模型编排 + 从提示到代码的执行工作流”，比普通 AI app 贴词更具体。`;
    const risk =
      '风险是还要确认产品成熟度：是否有真实可用 demo、GitHub repo、安装量、用户案例、模型编排效果、Tea 集成到底做了什么，以及 token 与 OpenAgent/Sisyphus 的使用权、收入或治理是否有关系。如果只有 landing page 和 Bankr 发射，叙事清楚但仍是早期高波动盘。';

    return {
      category: 'AI',
      label: 'AI Agent编程框架',
      thesis: `${caIntro({
        row,
        bankr,
        kind: 'AI coding-agent harness / 多模型编程代理框架项目币'
      })} 核心是 OpenAgent / Sisyphus：让 coding agent 像用户一样写代码，并用 multi-model orchestration 做编程任务编排。`,
      origin: researchOrigin(core, backing, risk),
      details: researchDetails(core, backing, risk)
    };
  }

  if (isLazyCodexNarrative) {
    const core =
      '$' +
      symbol +
      ' 的叙事核心是 LazyCodex：把 OmO / oh-my-opencode 这套 coding-agent 工具思路搬到 Codex 语境里，官网直接写 “Codex for lazy people”、 “OmO in Codex”、 “Currently on OpenCode” 和 “Just prompt with ultrawork”。简单说，它不是空名字，而是“给懒人/不想细拆任务的人用的 AI coding agent 工作流”：用户少想步骤，直接用 ultrawork/prompt 驱动 Codex/OpenCode 类工具完成代码任务。社区同时在炒 “token lovers / token burners / token maxxxers”，所以它是 AI coding 工具预告 + token 社区情绪的混合叙事。';
    const backing = `${sourceBacking({
      bankr,
      xProfile,
      website,
      github
    })}；社区期待点是：Bankr Fee Recipient 直接指向 ${bankr?.feeRecipientHandle ||
      '@q_yeon_gyu_kim'}，dev 的 X bio 写着 “Building oh-my-opencode. 23y/o hacker.”，launch tweet 又说 “omo in codex soon lazycodex.ai” 和 “tool for token lovers, token burners, token maxxxers”。这说明当前买点不是成熟收入，而是年轻 coding-agent builder 把 OpenCode/OmO 玩法带到 Codex 的早期预期。`;
    const risk =
      '风险也很明确：官网写着 Coming June 2026，目前仍像 teaser/预告页，还要确认真实 demo、GitHub repo、安装方式、和 Codex/OpenCode 的具体集成、ultrawork 到底解决什么痛点，以及 token 与产品使用权、收入或社区权益有没有绑定。如果后续 dev 不持续交付，它会退回纯情绪盘。';

    return {
      category: 'AI',
      label: 'AI Coding懒人工具',
      thesis: `${caIntro({
        row,
        bankr,
        kind: 'AI coding-agent / Codex 懒人工具项目币'
      })} 核心是 LazyCodex：OmO in Codex，面向“不想拆任务、直接 prompt with ultrawork”的 coding-agent 工作流。`,
      origin: researchOrigin(core, backing, risk),
      details: researchDetails(core, backing, risk)
    };
  }

  if (isBlindCacheNarrative) {
    const core =
      '$' +
      symbol +
      " 的叙事核心是 BlindCache：给 AI agents 做加密、可迁移、隐私优先的 memory layer。GitHub/launch tweet 写得很具体：它 built on Nillion's Blind Computer，提供 MCP server + vault SDK，把记忆内容 sharded/encrypted 到 3 个或 4 个 nilDB / blind computer 节点，SDK 只在用户本机重组，目标是 “no operator can decrypt your content, not even me”。它服务的是 Claude Code、Cursor、Venice 和任何 MCP-compatible AI，用来替代或对标 Mem0、Letta、Zep、ChatGPT memory 这类中心化记忆层。简单说，这是“AI agent 私密长期记忆 + Nillion 加密计算基础设施”的 AI infra 叙事，不是预测市场或社交交易产品。";
    const backing = `${sourceBacking({
      bankr,
      xProfile,
      website,
      github
    })}；社区期待点是：Bankr Fee Recipient 直接指向 ${bankr?.feeRecipientHandle ||
      '@nikshepsvn'}，deployer 是 ${bankr?.deployerHandle || '@eeunqbla'}，Bankr website 指到 GitHub repo ${
      topGithubRepo?.fullName || 'nikshepsvn/blindcache'
    }${topRepoStats ? `（${topRepoStats}）` : ''}。dev 公开背景里有 Coinbase data/infra、Instacart ads tech-lead、PagerDuty、SeatGeek、Waterloo CS 这类工程履历，再叠加 Nillion / $NIL / nilAI / MCP 线索，所以这个叙事买的是“懂 infra 的工程 dev 做 AI 私密记忆层”。`;
    const risk =
      '风险是它仍然很早：BlindCache 工具本身和 token 的权益、收入、治理或使用费用是否绑定还未确认；生产环境需要 $NIL，安全性要看 Nillion/nilDB/Blindfold/NUC token 的实现、密钥管理、客户端明文暴露面、nilAI/TEE 选项和 metadata 泄漏风险。它比空 meme 强很多，但不能因为有 repo 和隐私叙事就默认 token 捕获价值。';

    return {
      category: 'AI',
      label: '加密AI记忆层',
      thesis: `${caIntro({
        row,
        bankr,
        kind: 'AI agent 加密记忆基础设施项目币'
      })} 核心是 BlindCache：基于 Nillion Blind Computer 的 encrypted memory layer，给 Claude Code、Cursor、Venice 等 MCP-compatible AI 保存私密记忆。`,
      origin: researchOrigin(core, backing, risk),
      details: researchDetails(core, backing, risk)
    };
  }

  if (isZbasePrivacyPaymentsNarrative) {
    const core =
      '$' +
      symbol +
      ' 的叙事核心是 zBase：给 AI agents 的 x402 支付做隐私层。公开资料不是泛泛的 agent app，而是写清楚 private payments for AI agents、zero-knowledge privacy facilitator、x402 agent payments，并且 fork 自 Vitalik Buterin 的 Privacy Pools；技术关键词包括 Base + Solana 部署、on-chain Groth16 verification、ASP-compliant by construction。简单说，它炒的是“AI agent 付款需要隐私保护，zBase 用 ZK/Privacy Pools 给 x402 支付做证明/隐私层”的支付隐私基础设施叙事。';
    const backing = `${sourceBacking({
      bankr,
      xProfile,
      website,
      github
    })}；社区期待点是：官网标题直接写 Private payments for AI agents，Bankr Fee Recipient 指向 ${bankr?.feeRecipientHandle ||
      '@zbase__'}，X bio 里还能看到 Base Batches 003 Finalist。它的强点不是“有 AI 词”，而是把 AI agent payment、x402、ZK/Privacy Pools 和 Base 生态早期项目身份串成一个具体方向。`;
    const risk =
      '风险是这个方向技术和合规门槛都高：还要确认 x402 集成是否真实可用、Privacy Pools fork 的实现质量、Groth16 电路/合约是否审计、ASP-compliant 机制怎么落地、真实支付量有多少，以及 token 和 zBase 协议费用、治理或使用权之间有没有明确关系。';

    return {
      category: 'AI',
      label: 'ZK Agent支付隐私',
      thesis: `${caIntro({ row, bankr, kind: 'ZK agent payment 隐私基础设施项目币' })} 核心是 zBase：给 x402 agent payments 做 zero-knowledge / Privacy Pools 隐私层。`,
      origin: researchOrigin(core, backing, risk),
      details: researchDetails(core, backing, risk)
    };
  }

  if (isLocalAiNarrative) {
    const core =
      '$' +
      symbol +
      ' 的叙事核心是 LocalAI：开源、本地/私有部署的 AI 推理栈和 OpenAI-compatible API。它不是泛泛的 agent 工作流，而是给开发者和企业一个“OpenAI / Anthropic 替代层”：可以在本地、on-prem、Docker/Kubernetes 环境里跑 LLM、图片生成、音频、embeddings 等能力，并用接近 OpenAI API 的接口接入已有应用。简单说，它炒的是“把 AI 推理和模型服务从云端黑盒拉回本地/私有基础设施”的 AI infra 叙事。';
    const backing = `${sourceBacking({
      bankr,
      xProfile,
      website,
      github
    })}；社区期待点是：Bankr Fee Recipient 指向 ${bankr?.feeRecipientHandle || '@mudler_it'}，官网/项目名是 LocalAI，GitHub 代表 repo ${
      topGithubRepo?.fullName || 'mudler/LocalAI'
    }${topRepoStats ? `（${topRepoStats}）` : ''}。这个叙事的买点是“成熟开源 AI infra + 本地推理/私有部署需求 + dev 公开绑定”，比只写 AI、agent、automation 的空泛叙事更具体。`;
    const risk =
      '风险是 token 与 LocalAI 项目的使用权、收入、治理、模型市场或商业服务是否绑定还没确认；LocalAI 本身是开源基础设施，项目强不等于 token 自动有价值。后续要继续看 dev 是否持续认领、社区是否把 token 和 LocalAI 路线讲清楚，以及本地推理生态的真实采用是否能转成链上买盘。';

    return {
      category: 'AI',
      label: '开源本地AI推理栈',
      thesis: `${caIntro({ row, bankr, kind: '开源本地 AI 推理/API 基础设施项目币' })} 核心是 LocalAI：OpenAI-compatible API，本地/私有部署 LLM、图片、音频和 embeddings 的 AI infra。`,
      origin: researchOrigin(core, backing, risk),
      details: researchDetails(core, backing, risk)
    };
  }

  if (isPhysicalAiAttestationNarrative) {
    const core =
      '$' +
      symbol +
      ' 的叙事核心是 Stargaze：给 Physical AI / 机器经济做隐私优先的验证基础设施。它不是普通 agent 聊天或自动化工具，而是让 drones、robots、vehicles、sensor fleets 这类真实世界机器证明“我确实做过某件事/满足某个条件”，同时不公开原始 telemetry、飞行路径、传感器流或控制策略。公开资料里的技术点很具体：Base 上的 Ethereum Attestation Service（EAS）做 tamper-evident attestation，Groth16 zero-knowledge proofs 做条件证明，secure-element signing 绑定设备侧真实采集数据，再用 reputation / staking 做经济约束。';
    const backing = `${sourceBacking({
      bankr,
      xProfile,
      website,
      github
    })}；社区期待点是：它瞄准 UAV/drone operators、robotics/autonomous logistics、DePIN networks、insurers/regulators 这些需要“证明物理行为但不能泄露数据”的场景，叙事是 Physical AI + ZK + Base/EAS 的基础设施组合，不是泛泛的 AI 应用贴词。`;
    const risk =
      '风险是项目非常早期：X 账号和 GitHub 都还小，公开 repo star/fork 很少；还要确认设备 secure element 接入、ZK 电路、EAS schema、staking/reputation 机制、真实客户或 DePIN 合作是否已经落地。token 和验证网络的费用、质押、治理或权益绑定也需要继续确认。';

    return {
      category: 'AI',
      label: 'Physical AI验证',
      thesis: `${caIntro({ row, bankr, kind: 'Physical AI 隐私验证/链上证明基础设施项目币' })} 核心是 Stargaze：用 EAS、ZK proofs 和设备签名，让机器证明真实世界行为而不暴露原始数据。`,
      origin: researchOrigin(core, backing, risk),
      details: researchDetails(core, backing, risk)
    };
  }

  if (isHumanCvNarrative) {
    const core =
      '$' +
      symbol +
      ' 的叙事核心是 human.cv：公开资料写的是 “proof that I made it”，也就是给人类创作者/开发者做长期、可验证的作品归属和身份履历证明。它想解决的不是 AI 模型能力，而是“我做过什么、这个东西是不是我做的、这个人的作品履历能不能永久验证”。官网把它描述成 protocol for proving, permanently and verifiably, that what you made is yours，以及 the on-chain résumé of a verified human。简单说，这是人类身份 + 创作归属 + 链上履历证明叙事。';
    const backing = `${sourceBacking({
      bankr,
      xProfile,
      website,
      github
    })}；社区期待点是：Bankr Fee Recipient 指向 @humandotcv，官网/项目号和 token 名称能对上，所以它不是“找不到锚点的 HUMAN 名字盘”，而是 human.cv 这个身份/作品证明产品的早期社区币。`;
    const risk =
      '风险是产品机制还需要继续核对：具体怎么验证“made it”、是否有去中心化身份或签名流程、证明对象是 repo/内容/项目还是个人履历、token 是否参与证明费用/声誉/治理，目前都不能脑补。账号粉丝也还小，短线传播要看 dev 是否持续公开认领和解释产品。';

    return {
      category: 'Product',
      label: '人类身份/创作证明',
      thesis: `${caIntro({ row, bankr, kind: '人类身份/创作归属证明产品币' })} 核心是 human.cv：证明作品归属和 verified human 的链上履历。`,
      origin: researchOrigin(core, backing, risk),
      details: researchDetails(core, backing, risk)
    };
  }

  if (isAuraDeFiAnalystNarrative) {
    const core =
      '$' +
      symbol +
      ' 目前更像“链上分析师/DeFi 教育者背书”的 Bankr 社区 meme，而不是已经确认有独立支付产品的 Aurapay 项目币。最硬线索是 Fee Recipient 指向 @0xSireal，其公开简介写着 Onchain Liquidity & Retention Analyst、DeFi Educator、Researcher、@dune wizard、Writer/Ghostwriter。简单说，社区买点不是 AI，也不是明确支付应用，而是“懂链上流动性、留存和 Dune 数据分析的 crypto 原生账号发/接收了这个 AURA”。';
    const backing = `${sourceBacking({
      bankr,
      xProfile,
      website,
      github
    })}；社区期待点是：Bankr Fee Recipient 直接绑定公开 X 账号，deployer 也有 Bankr 线索，dev 画像比随机钱包强；如果 @0xSireal 持续围绕 Aurapay/AURA 发内容、解释名字来源或做数据看板，这类“分析师背书 meme”会比纯名字 meme 更好讲。`;
    const risk =
      '风险是目前没确认 Aurapay 有真实支付产品、官网、用户、收入或 token 权益；@0xSireal 更像链上分析/DeFi 内容与研究背景，不等于他已经是头部协议创始人。它可以靠 dev 公开身份和 Bankr 热度走一波，但如果没有后续产品或持续运营，仍然是高波动早期 meme。';

    return {
      category: 'Meme',
      label: '链上分析师meme',
      thesis: `${caIntro({ row, bankr, kind: '链上分析师/DeFi 教育者背书社区 meme coin' })} 核心是 @0xSireal 的链上流动性、DeFi 教育和 Dune analyst 背景。`,
      origin: researchOrigin(core, backing, risk),
      details: researchDetails(core, backing, risk)
    };
  }

  if (isMoatNarrative) {
    const core =
      '$' +
      symbol +
      ' 的叙事核心是 Moat：Laravel 生态里的 GitHub 安全姿态审计工具。公开 repo 写得很明确，它会检查 GitHub organization 和 repositories 的安全控制项，包括 2FA enforcement、branch protection、signed commits、secret scanning、Dependabot alerts、workflow permissions、pinned actions、repository webhooks 等，然后给出需要考虑的安全建议。';
    const backing = `${sourceBacking({
      bankr,
      xProfile,
      website,
      github
    })}；社区期待点是：Fee Recipient 指向 @enunomaduro，公开身份是 Laravel staff software engineer / open-source contributor，项目链接指向 laravel/moat。这个叙事买的是“知名开源生态 + 真实安全工具 + dev 个人声誉”。`;
    const risk =
      '风险是 token 与 Moat 工具的收入、治理、使用权限或 Laravel 官方路线是否绑定还没确认；Moat 本身是 read-only security review tool，不会自动修复安全问题，链上买盘主要看 dev 是否持续认领、开源热度和社区传播。';

    return {
      category: 'Security',
      label: 'GitHub安全审计工具',
      thesis: `${caIntro({ row, bankr, kind: 'GitHub 安全姿态审计工具项目币' })} 核心是 Moat：审计 GitHub organization / repo 的安全配置并给出建议。`,
      origin: researchOrigin(core, backing, risk),
      details: researchDetails(core, backing, risk)
    };
  }

  if (isDmnNarrative) {
    const core =
      '$' +
      symbol +
      ' 的叙事核心是 Deamon Net：项目账号 @dmn_net 写的是 “Agents that never sleep. 350ms event-to-execution. Live on Base. By @bolls”。结合 dev @bolls 的简介 “I write exploits, patch them, then write better ones. if code runs, I can break it.”，这个故事更像链上 agent 执行网络 + 安全工程师 dev 叙事：重点是事件到执行的低延迟 agent、Base 上线和安全/漏洞利用背景。';
    const backing = `${sourceBacking({
      bankr,
      xProfile,
      website,
      github
    })}；社区期待点是：Bankr Fee Recipient 指向 @bolls，项目账号 @dmn_net 又直接写 By @bolls，dev 和项目号能互相印证。买点是“安全工程 dev + on-chain agent execution”，比单纯名字叙事更具体。`;
    const risk =
      '风险是目前公开资料还薄：350ms event-to-execution、agent 执行网络、具体产品 demo、用户、收入、合约能力和 token 权益都需要继续确认；安全工程背景是加分项，但如果没有可验证产品和持续更新，仍可能回到早期情绪盘。';

    return {
      category: 'AI',
      label: '链上agent执行网络',
      thesis: `${caIntro({ row, bankr, kind: '链上 agent 执行网络项目币' })} 叙事是 Deamon Net：Base 上的低延迟事件执行 agent 网络。`,
      origin: researchOrigin(core, backing, risk),
      details: researchDetails(core, backing, risk)
    };
  }

  if (isSecurityResearcherNarrative) {
    const core =
      '$' +
      symbol +
      ` 目前更像“安全研究者 dev 背书”的社区 meme，而不是已经能确认的 AI 产品币。最硬线索是 Fee Recipient 对应的 X 账号简介：${shortX ||
        'Security researcher and reverse engineer. Interested in Windows kernel development, low-level programming, static program analysis and cryptography.'} 这说明 dev 画像偏安全研究、逆向工程、Windows kernel、低层编程、程序分析和密码学，不是模型、agent 或 AI 应用创业者路线。`;
    const backing = `${sourceBacking({
      bankr,
      xProfile,
      website,
      github
    })}；社区期待点是：Bankr Fee Recipient 直接绑定公开安全研究者账号，deployer/发射线索也清楚，所以市场可能在买“技术型安全研究者 + Bankr 发射 + 早期社区 meme”的故事。`;
    const risk =
      '风险是目前没有抓到明确产品官网、原梗出处、AI 工具描述、token 权益或 dev 后续计划；如果只是把一个安全研究者身份做成 meme，短线传播可以有，但持续性要看 dev 是否公开认领、解释名字来源、持续更新或把技术能力转成可验证项目。';

    return {
      category: 'Meme',
      label: '安全研究者meme',
      thesis: `${caIntro({ row, bankr, kind: '安全研究者背书社区 meme coin' })} 核心不是 AI 应用，而是 fee recipient 指向安全研究/逆向工程背景的 dev。`,
      origin: researchOrigin(core, backing, risk),
      details: researchDetails(core, backing, risk)
    };
  }

  if (isRecordlyNarrative) {
    const core =
      '$' +
      symbol +
      ' 的叙事核心是 Recordly：一个开源跨平台录屏/产品演示工具，不是没有出处的名字 meme。公开资料写的是 MacOS/Windows/Linux 录屏，主打 auto-zoom、丝滑光标动画、漂亮背景、时间线编辑、麦克风/系统音频、MP4/GIF 导出和 .recordly 项目文件，定位接近免费开源版 Screen Studio。';
    const backing = `${sourceBacking({
      bankr,
      xProfile,
      website,
      github
    })}；社区期待点是：dev 的 X 简介直接写 building Recordly（10K+ stars），Bankr Fee Recipient 指向 dev 账号，官网能看到真实产品功能，所以它更像“开源产品 + 年轻独立开发者”的产品 meme，而不是纯梗。`;
    const risk =
      '风险是 token 与 Recordly 产品的收入、治理、下载量、开源贡献或未来路线是否绑定还未确认；录屏工具本身不是 crypto-native，也不是 AI 模型/agent 叙事，买盘更多依赖 dev 持续公开认领、开源热度和社区传播。';

    return {
      category: 'Product',
      label: '开源录屏工具',
      thesis: `${caIntro({ row, bankr, kind: '开源录屏/产品演示工具项目币' })} 叙事是 Recordly 这个真实开源录屏产品的社区映射。`,
      origin: researchOrigin(core, backing, risk),
      details: researchDetails(core, backing, risk)
    };
  }

  if (isLikwidNarrative) {
    const core =
      '$' +
      symbol +
      ' 的叙事核心是 Likwid：oracle-free 的 DeFi 杠杆/借贷协议。官网和 X 都在强调 Unified Swap · Margin · Lending · Borrow，允许任意 token 做 permissionless margin trading 和 lending；卖点是不用 oracle、不设准入、长尾资产从第一天就能做杠杆，并把 AMM + Lending 统一到一个流动性池里，LP 同时赚 swap fees、leverage fees 和 lending interest。';
    const backing = `${sourceBacking({
      bankr,
      xProfile,
      website,
      github
    })}；社区期待点是：@likwid_fi 是公开项目账号，X 粉丝体量较大，资料里还有 Uniswap / ETHDenver / MVB9 这类活动或生态背书字样，所以这不是 AI 贴词，而是 DeFi 产品发币/社区币叙事。`;
    const risk =
      '风险是 DeFi 协议要看真实 TVL、风控、清算机制、审计质量、坏账和长尾资产波动；oracle-free 和长尾杠杆听起来有差异化，但如果流动性薄、风控没验证或 token 与协议收入没有绑定，仍然会很脆。';

    return {
      category: 'DeFi',
      label: 'DeFi杠杆/借贷协议',
      thesis: `${caIntro({ row, bankr, kind: 'DeFi 杠杆/借贷协议项目币' })} 叙事是 oracle-free margin trading、lending 和长尾资产杠杆。`,
      origin: researchOrigin(core, backing, risk),
      details: researchDetails(core, backing, risk)
    };
  }

  if (isPrintingPressNarrative) {
    const core =
      '$' +
      symbol +
      ' 的叙事核心是 Printing Press：给 AI agents “打印”专用 CLI / MCP server / Claude Code skill 的生成器。公开 README 讲得很具体：它读取官方 API 文档、研究社区 CLI 和 MCP server、嗅探未公开网页 API，然后生成 token-efficient Go CLI、MCP server 和 Claude Code skill；技术点包括 SQLite sync、offline search、compound commands、agent-native flags，让 agent 调 API 时更省 token、更少走错路。';
    const backing = `${sourceBacking({
      bankr,
      xProfile,
      website,
      github
    })}；社区期待点是：Bankr Fee Recipient 指向 @trevin，Bankr website 指到 mvanhorn/cli-printing-press 这个 GitHub repo，deployer 是 @hyporliquid，链上发射和项目链接能对上。这个买点是“AI agent 工具基础设施 / API 操作层”：让 agent 更稳定、更省 token 地调用外部系统。`;
    const risk =
      '风险是 GitHub repo/工具和 token 之间的权益、收入、治理或官方长期绑定还没确认；此外这类工具面向开发者和 agent 工作流，传播面比大众 meme 窄，后续要看真实安装量、生成 CLI 的质量、MCP 使用量和 dev 是否持续认领。';

    return {
      category: 'AI',
      label: 'AI Agent CLI生成器',
      thesis: `${caIntro({ row, bankr, kind: 'AI agent CLI / MCP 生成器项目币' })} 核心是 Printing Press：为 AI agents 生成可用的 CLI、MCP server 和 Claude Code skills。`,
      origin: researchOrigin(core, backing, risk),
      details: researchDetails(core, backing, risk)
    };
  }

  if (isLibreChatNarrative) {
    const core =
      '$' +
      symbol +
      ' 的叙事核心是 LibreChat：一个开源、自托管的 AI 聊天平台，可以理解成“可自己部署、可接多模型、多工具、多用户权限的 ChatGPT 工作台”。公开 README 写得很清楚：它支持 OpenAI、Anthropic、Google/Vertex、Mistral、OpenRouter、DeepSeek 等多模型和自定义 endpoint，还内置 Agents、MCP support、Code Interpreter API、Web Search、Artifacts、图片生成、文件/多模态、Presets、会话搜索、导入导出和多用户安全登录。';
    const backing = `${sourceBacking({
      bankr,
      xProfile,
      website,
      github
    })}；社区期待点是：Bankr Fee Recipient 指向 @lgtm_hbu，X bio 写着 Owner & Maintainer of LibreChat，Bankr website 又直接指向 danny-avila/LibreChat，所以 dev、项目和发币线索能对上。这个买点是“成熟开源 AI chat/agent 平台 + maintainer 背书”，不是只有一个名字或一句 AI 口号。`;
    const risk =
      '风险是 LibreChat 本身是开源软件，token 与项目收入、治理、功能权限、官方路线或 sponsor 体系是否绑定还没确认；另外 dev 的 X 账号粉丝不算大，链上买盘更多依赖 Base/Bankr 社区是否持续认可，而不是产品天然等于 token 有价值。';

    return {
      category: 'AI',
      label: '开源AI聊天平台',
      thesis: `${caIntro({ row, bankr, kind: '开源 AI chat / agent 平台项目币' })} 核心是 LibreChat：自托管、多模型、带 Agents/MCP/Code Interpreter 的开源 AI 工作台。`,
      origin: researchOrigin(core, backing, risk),
      details: researchDetails(core, backing, risk)
    };
  }

  if (isHunchNarrative) {
    const core =
      '$' +
      symbol +
      ' 的叙事核心是 Hunch：把预测市场做成 social swipe feed。用户不是看复杂盘口，而是像刷卡一样对事件选 YES/NO，看可见 odds，然后由 agent 去 route、manage、explain 交易；官网还强调 best-execution router 会扫描多个 venue、展示赔率并在结算前路由 ticket，social signal layer 会把 Twitter/news 变成具体市场动量。';
    const backing = `${sourceBacking({
      bankr,
      xProfile,
      website,
      github
    })}；社区期待点是：这是 prediction market + agent routing + 社交玩法的产品叙事，公开入口 playhunch.xyz 能看到 Swipe、Stack、Ranks、Twitter agent 等功能，叙事落点在“把预测市场做得更像消费级社交交易”。`;
    const risk =
      '风险是预测市场产品要看真实交易量、可用市场、资金托管、合规风险、路由质量和用户留存；如果 agent 只是在前端解释而没有真实执行优势，叙事会比实际产品跑得快。';

    return {
      category: 'Product',
      label: '预测市场/社交交易',
      thesis: `${caIntro({ row, bankr, kind: '预测市场/社交交易产品币' })} 叙事是 swipe 式预测市场和 agent 路由交易。`,
      origin: researchOrigin(core, backing, risk),
      details: researchDetails(core, backing, risk)
    };
  }

  if (isBankrAgentNarrative) {
    const core =
      '$' +
      symbol +
      ' 的叙事核心是 Bankr 生态里的 agent 执行/资金池故事：@0xDeployer 的公开内容围绕 Bankr terminal、skills demo、agent executes it、onchain payments、Uniswap v3 liquidity、rebalancing automations、创建 reusable skill 和 PR 这些链上 agent 操作展开。简单说，它不是普通 AI app，而是“Bankr agent 能替用户执行链上动作 + 技能/自动化 + 资金或基金叙事”的组合。';
    const backing = `${sourceBacking({
      bankr,
      xProfile,
      website,
      github
    })}；社区期待点是：Fee Recipient 指向 @0xDeployer，这个账号本身就在 Bankr / onchain automation 语境里，粉丝体量也不小，所以 $BANKRFUND 更像 Bankr 生态内的 dev/agent 资金叙事。`;
    const risk =
      '风险是 “Fund/基金” 这个名字很容易让市场自动脑补资金管理或收益分配，但目前必须确认是否真的有基金结构、资金托管、收益规则、claim/holder 权益或官方说明；如果只有 Bankr 热度和 dev 账号背书，短线强但兑现风险很高。';

    return {
      category: 'AI',
      label: 'Bankr生态/agent执行',
      thesis: `${caIntro({ row, bankr, kind: 'Bankr 生态 agent 执行/资金叙事币' })} 核心是 Bankr/onchain agent 自动执行和 fund 预期。`,
      origin: researchOrigin(core, backing, risk),
      details: researchDetails(core, backing, risk)
    };
  }

  if (isVirtualsNarrative) {
    const isPrototype = Boolean(virtuals?.prototypeAddress || evidenceHas(virtuals?.url, ['app.virtuals.io/prototypes']));
    const geckoCategoryText = gecko?.categories?.length
      ? `GeckoTerminal 分类是 ${gecko.categories.join(' / ')}`
      : isPrototype
        ? 'GeckoTerminal 分类本次未返回，先用 Virtuals prototype 页面和 delegate 证据判断'
        : 'GeckoTerminal 分类本次未返回，先用 Virtuals API 和交易对证据判断';
    const virtualsCategoryText = virtuals?.category ? `Virtuals category 是 ${virtuals.category}` : 'Virtuals category 未确认';
    const virtualsId = firstDefined(virtuals?.id, gecko?.virtualsId);
    const virtualsPageText = virtuals?.url || (virtualsId ? `https://app.virtuals.io/virtuals/${virtualsId}` : gecko?.virtualsUrl);
    const pairText = pair || (market?.quoteTokenSymbol ? `$${symbol}/${market.quoteTokenSymbol}` : `$${symbol}/VIRTUAL`);
    const feeDelegationHandle = normalizeHandle(virtuals?.feeDelegatedRecipient);
    const devHandle = feeDelegationHandle || virtuals?.creatorTwitterHandle || xProfile?.handle;
    const holderCount = firstDefined(virtuals?.holderCount, gecko?.holderCount);
    const top10 = formatPercent(firstDefined(virtuals?.top10HolderPercentage, gecko?.top10HolderPercentage));
    const virtualsProduct = virtualsProductText(virtuals);
    const teamSummary = virtualsTeamSummary(virtuals);
    const hasPhysicalRobotics = hasVirtualsPhysicalAiRobotics([virtualsProduct, websiteText, xBioText].join(' '));
    const officialLinks = [
      virtuals?.projectTwitterHandle ? `官方 X ${virtuals.projectTwitterHandle}` : null,
      virtuals?.projectWebsiteUrl ? `官网 ${virtuals.projectWebsiteUrl}` : null,
      virtuals?.videoPitchTweetUrl ? `video pitch ${virtuals.videoPitchTweetUrl}` : null
    ]
      .filter(Boolean)
      .join('，');
    const hasVirtualsProductEvidence = hasPhysicalRobotics || evidenceHas([websiteText, virtualsProduct].join(' '), [
      'staffing',
      'recruiting',
      'recruitment',
      'sourcing',
      'automated matching',
      'candidate proposals',
      'predictive analytics',
      '70k arr',
      'token utility',
      'roadmap'
    ]);
    const hasVirtualsFounderOrProductEvidence =
      hasVirtualsProductEvidence ||
      Boolean(virtuals?.creatorTwitterHandle || virtuals?.projectTwitterHandle || virtualsProjectMembers(virtuals).length);
    const virtualsExpectation = hasVirtualsFounderOrProductEvidence
      ? '这不是单独一个无来源 CA，而是 Virtuals/Bonding 新盘 + 官方链接或团队线索；如果后续团队持续认领、发 demo 或更新路线，容易被包装成“team-visible + AI Agent meta”。'
      : '目前只能确认 Virtuals/Bonding 新盘和 fee delegation / 交易对线索，产品功能、founder 故事和官网证据仍然偏薄，不能直接包装成成熟 dev-backed 产品盘。';
    const productSentence = isPrototype
      ? `产品侧本次抓到的是 Virtuals prototype 页面，而不是完整官网：页面把 $${symbol} 放在 Virtuals Protocol / Society of AI Agents 体系里，并显示 Delegate to: ${
          devHandle || '未确认'
        }。这说明它更像 Virtuals 生态里的 prototype / AI Agent 发射页，当前最硬信息是“谁被委托/谁接收收益”，不是成熟产品说明；如果要判断真实 AI 产品能力，还需要继续点 prototype、X 和官网补证据。`
      : hasPhysicalRobotics
        ? '产品侧看，OrionX Robotics 讲的是 Physical AI / humanoid robotics / defense AI：核心产品 ARES（Autonomous Reasoning and Execution System）是给 humanoid robots 用的 Vision-Language-Action / VLA 大脑，目标场景包括 battlefield、防务、核设施、工业现场、数据中心和其他 hazardous sites。路线里出现 Unitree G1 EDU、NVIDIA Isaac Sim、ROS 2、OpenVLA/GR00T 等具体工程词，叙事更像“先用现有机器人身体跑 AI 大脑，再走自有 Orion X Mk-1 硬件”的机器人 AI 项目，不是普通 agent 贴词。'
        : evidenceHas([websiteText, virtualsProduct].join(' '), [
            'staffing',
            'recruiting',
            'recruitment',
            'sourcing',
            'automated matching',
            'candidate proposals',
            'predictive analytics'
          ])
          ? '产品侧看，PsView 官网写的是 AI 招聘/猎头自动化：用 AI 做 Intelligent Sourcing、Automated Matching、Talent Pool Management、Candidate Proposals、Predictive Analytics、Market Intelligence 等，卖点是帮 staffing firm 更快找人、匹配候选人、生成候选人方案和刷新人才池。'
          : evidenceHas(xBioText, ['future of recruiting', 'founder @ psview', '70k arr'])
            ? '产品侧从 founder X 资料能看到 PsView 是 recruiting / 招聘方向 AI 产品，并写到 70K ARR in 3 months；但官网或产品页如果本次没抓到，具体功能仍要继续点官网核对。'
            : '产品侧目前公开描述还比较薄，需要继续确认这个 Virtuals agent 背后是否有真实 AI 产品、用户和收入。';
    const storySentence = evidenceHas(xBioText, ['luke', 'yc rejected', 'yc 不信'])
      ? '社区主推故事里还出现 “The onchain story of Luke / YC rejected” 这类个人叙事：把 founder/builder 被主流 VC 或 YC 拒绝、转向 onchain 社区支持的故事包装成 AI Agent / IP Mirror。这个部分属于社区传播叙事，除非看到原推或项目方确认，我会标成“待确认故事线”，不当作硬证据。'
      : hasPhysicalRobotics
        ? '社区可讲的故事线是“Physical AI + 防务机器人 + Virtuals AI Agent/IP Mirror”：项目自己把 OrionX 形容成 humanoid age 的 Anduril，但真实 demo、客户、硬件采购、仿真训练成果和防务合作需要继续核验，不能只看宏大叙事。'
        : '社区层面通常会把这类 Virtuals IP Mirror 讲成“某个 builder/人物故事被做成 onchain AI Agent”，但具体原推、人物故事和社区 slogan 还需要继续查 X 才能确认。';
    const core = `硬证据显示 $${symbol} 属于 Virtuals Protocol / AI Agent 生态：${geckoCategoryText}，Virtuals 页面是 ${
      virtualsPageText || 'Virtuals app'
    }，主池是 ${pairText}，${virtualsCategoryText}。${productSentence}${storySentence}`;
    const backingSource = isPrototype ? 'Virtuals prototype 页面' : 'Virtuals API';
    const backing = `${backingSource}显示 ${
      isPrototype ? `Delegate to: ${devHandle || '未确认'}，` : ''
    }feeDelegationType=${virtuals?.feeDelegationType || '未确认'}，feeDelegatedRecipient=${
      feeDelegationHandle || virtuals?.feeDelegatedRecipient || '未确认'
    }，feeDelegationClaimed=${virtuals?.feeDelegationClaimed}; creator verified Twitter 是 ${
      virtuals?.creatorTwitterHandle || devHandle || '未确认'
    }${virtuals?.creatorTwitterUrl ? `（${virtuals.creatorTwitterUrl}）` : ''}。${
      officialLinks ? `官方入口：${officialLinks}。` : ''
    }${teamSummary ? `Virtuals projectMembers 显示团队：${teamSummary}。` : ''}holderCount ${
      holderCount || '未确认'
    }，factory=${virtuals?.factory || '未确认'}，launch time=${virtuals?.launchedAt || '未确认'}。社区期待点是：${virtualsExpectation}`;
    const risk = `高风险早期盘：${backingSource}显示 dev committed=${virtuals?.isDevCommitted ?? '未确认'}，${
      gecko ? `Gecko verified=${gecko.gtVerified}` : 'Gecko verified 本次未确认'
    }，metadata description 目前只是「${virtuals?.description || gecko?.description || '未确认'}」；top10 holders ${
      top10 || '未确认'
    }，集中度不低；fee delegation ${
      virtuals?.feeDelegationType || virtuals?.feeDelegatedRecipient ? '已有线索但仍要看是否持续认领' : '未确认'
    }。它更像 Virtuals 生态热点轮动里的早期 AI Agent / IP Mirror 叙事，产品收入、token 权益、agent 实际能力、团队履历和官方路线都要继续验证，不能因为涨了就当成稳项目。`;

    return {
      category: 'AI',
      label: 'Virtuals AI Agent',
      thesis: `这个 CA（${row.address}）是 Base 链上 Virtuals Protocol 的 AI Agent / IP Mirror 代币 —— $${symbol}（${tokenName(
        row,
        bankr
      )}）。`,
      origin: researchOrigin(core, backing, risk),
      details: researchDetails(core, backing, risk)
    };
  }

  if (isCivicConsensusNarrative) {
    const products = productHighlights.length
      ? productHighlights.join('；')
      : '公开资料指向社区调解、AI polling、事实核查、专家观点聚合和预测市场聚合。';
    const capabilities = capabilityHighlights.length ? `具体功能包括 ${capabilityHighlights.slice(0, 5).join('、')}。` : '';
    const communityNotes = evidenceHas(xBioText, ['community notes', 'note-writer'])
      ? 'Dev 的 X 资料/置顶还强调 AI-written Community Notes / note-writer，方向是用 AI 写或辅助公共事实核查。'
      : '';
    const core = `社区主推的是“AI + 社区治理/共识形成/事实核查”的产品叙事，不是泛泛的 agent 贴词。$${symbol} 对应 Goodheart Labs 这类工具矩阵：${products} ${capabilities}${communityNotes} 简单说，它炒的是用 AI 帮社区、政策讨论或公共议题更快收集观点、形成共识、核查信息，并把预测市场/专家观点这类信息源做成可视化工具。`;
    const backing = `${sourceBacking({
      bankr,
      xProfile,
      website,
      github
    })}；社区期待点是：Fee Recipient 直接绑定公开个人账号，官网能看到多个已上线/测试产品，不是只有一个空白 landing page，所以它比普通 AI meme 更像“真实 AI 产品实验室 + Base 社区发射”的叙事。`;
    const risk =
      '风险是 token 和 Goodheart Labs 产品之间的权益、收入、治理或使用场景还未确认；这些工具主要面向 civic tech / AI policy / 事实核查小圈层，传播力不一定等于链上买盘，后续要看 dev 是否持续认领、产品是否有真实用户和可量化增长。';

    return {
      category: 'AI',
      label: 'AI社区治理/共识工具',
      thesis: `${caIntro({ row, bankr, kind: 'AI 社区治理/共识工具项目币' })} 核心是 Goodheart Labs / Viewpoints 这类用 AI 做社区意见收集、共识形成和事实核查的产品。`,
      origin: researchOrigin(core, backing, risk),
      details: researchDetails(core, backing, risk)
    };
  }

  if (hasAny(text, ['credit layer', 'agentic economy', 'underwritten credit', 'verifiable credit', 'risk-adjusted leverage', 'erc-8004'])) {
    const core =
      '$' +
      symbol +
      ' 的叙事核心是 agentic economy 里的信用/融资层：给 AI agent 或 agent 策略提供 credit layer、underwritten credit lines、risk-adjusted leverage 和 verifiable credit，不是普通聊天机器人或模型名 meme。';
    const backing = `${sourceBacking({ bankr, xProfile, website, github })}；社区买点是 AI agent 如果真的能自主跑策略，就需要信用、担保、资金效率和链上履约记录，这个方向比泛泛 AI 口号更像基础设施。`;
    const risk =
      '需要继续确认是否已有真实放贷规模、承销模型、风控数据、协议收入和活跃用户；如果只有 credit / agent 关键词，没有真实链上信用业务，就仍然可能只是早期概念盘。';
    return {
      category: 'AI',
      label: 'Agent信用/AI金融',
      thesis: `${caIntro({ row, bankr, kind: 'AI金融/agent 信用项目币' })} 叙事是 agent 信用、承销和杠杆基础设施。`,
      origin: researchOrigin(core, backing, risk),
      details: researchDetails(core, backing, risk)
    };
  }

  if (hasAny(text, ['repoprompt', 'repo prompt', 'codemaps', 'coding models', 'selective context'])) {
    const core =
      '$' +
      symbol +
      ' 对应的是 RepoPrompt 这种 AI 编程工具叙事：帮 coding agents / coding models 理解 repositories，用 MCP server、codemaps、prompts、selective context 把大代码库整理成模型能吃进去的上下文。';
    const backing = `${sourceBacking({ bankr, xProfile, website, github })}；社区期待点是它不是单纯喊 agent，而是对应一个更具体的 AI devtools / 代码上下文产品，容易讲成“AI 编程工具基础设施”。`;
    const risk =
      '需要确认真实用户规模、和 Cursor / Claude Code / Copilot 类工具相比的差异、是否有收入，以及 token 和产品之间到底有什么关系；如果只是产品名映射，持续性会弱。';
    return {
      category: 'AI',
      label: 'AI工具/代码上下文',
      thesis: `${caIntro({ row, bankr, kind: 'AI devtools / 代码上下文项目币' })} 核心是让 AI coding agents 更好理解代码库。`,
      origin: researchOrigin(core, backing, risk),
      details: researchDetails(core, backing, risk)
    };
  }

  if (hasAny(text, ['router for tool calls', 'tool calls', 'one skill', 'every tool', 'endpoint', 'mcp'])) {
    const core =
      '$' +
      symbol +
      ' 的叙事核心是 AI agent 工具路由：让 agent 用一个入口发现 endpoint、选择工具、发起 tool calls，像 agent 工具市场 + API gateway / MCP 接入层。';
    const backing = `${sourceBacking({ bankr, xProfile, website, github })}；社区期待点是 agent 需要外部工具才能从聊天走向执行，工具路由如果真有调用量，会比纯 AI 名字 meme 更有基础设施想象力。`;
    const risk =
      '需要继续确认真实工具接入数、调用量、开发者采用情况、权限/计费能力和不可替代性；如果只有 landing page 或一句 router 文案，就仍然偏早期。';
    return {
      category: 'AI',
      label: 'AI工具路由',
      thesis: `${caIntro({ row, bankr, kind: 'AI agent 工具路由项目币' })} 叙事是 tool calls / endpoint 路由基础设施。`,
      origin: researchOrigin(core, backing, risk),
      details: researchDetails(core, backing, risk)
    };
  }

  if (isResearchAutomationNarrative) {
    const core =
      '$' +
      symbol +
      ' 的叙事核心是 AI 研究自动化工作台：把 web search、inference、scheduled reports、workflow automation 和 model routing 接到分析师研究流程里。它不是只喊 agent，而是更像“让分析师持续监控市场、生成研究、定时出报告”的 AI workflow 产品。创新点在于把搜索、推理、报告调度和模型路由合成一个可复用研究流水线；技术含量要看它是否真的有稳定数据源、任务编排、报告质量和可追踪工作流。';
    const backing = `${sourceBacking({ bankr, xProfile, website, github })}；社区期待点是：如果官网 demo 能跑、报告质量稳定、模型路由能降低成本或提高准确度，它可以讲成 AI research ops / analyst automation，而不是普通 AI 名字盘。`;
    const risk =
      '风险是还要确认真实可用产品、用户留存、自动化效果、独特数据源、收入，以及 token 是否真的参与产品使用或收益；如果只是 landing page 堆 research、automation、inference、workflow 这些词，强度仍然不够。';
    return {
      category: 'AI',
      label: 'AI研究自动化',
      thesis: `${caIntro({ row, bankr, kind: 'AI 研究自动化产品币' })} 核心是把搜索、推理、模型路由和定时报告接成分析师工作流。`,
      origin: researchOrigin(core, backing, risk),
      details: researchDetails(core, backing, risk)
    };
  }

  if (isThinAgentPersonaNarrative) {
    const devLine = xProfile?.handle
      ? `Bankr Fee Recipient 指向 ${xProfile.handle}`
      : bankr?.feeRecipientHandle
        ? `Bankr Fee Recipient 指向 ${bankr.feeRecipientHandle}`
        : bankr?.feeRecipientWallet
          ? `Bankr Fee Recipient 只确认到钱包 ${bankr.feeRecipientWallet}`
          : '当前没有抓到明确 Fee Recipient 身份';
    const profileLine = shortX ? `公开 bio 是「${shortX}」` : '公开 bio 本次没有抓到足够内容';
    const core =
      '$' +
      symbol +
      ` 目前更像“人物/身份包装 + Agent 名字”的早期 meme，而不是已经确认有真实 AI 产品的项目币。名字是 ${tokenName(
        row,
        bankr
      )}，但本次没有抓到官网、GitHub、Virtuals 页面或具体产品说明；最硬线索是 ${devLine}，${profileLine}。简单说，当前叙事不是“某个成熟 agent 产品”，而是市场把一个公开身份账号和 Mushrooms Agent 这个名字包装成 dev-backed/persona agent meme。`;
    const backing = `${sourceBacking({
      bankr,
      xProfile,
      website,
      github
    })}；社区期待点是：Fee Recipient 至少不是匿名空白钱包，公开身份里能看到 NYU / Crypto & Security 这类安全和密码学语境，技术人设比纯随机名字强。后续如果 dev 公开解释 Mushrooms Agent 的梗源、发产品 demo、接 Virtuals 或持续发推认领，叙事才会升级。`;
    const risk =
      '没有抓到官网，没有抓到 Virtuals 页面，没有抓到 GitHub/产品 demo，也没有确认 Mushrooms Agent 的原梗出处或真实 AI 能力；所以不能写成成熟 AI 项目、Virtuals 项目或商业化证据明确的盘。它目前更像高风险早期人物 meme，强弱取决于 dev 是否继续认领和社区传播。';

    return {
      category: 'Meme',
      label: 'AI Agent人物meme',
      thesis: `${caIntro({ row, bankr, kind: 'AI Agent 人物/身份包装 meme coin' })} 当前硬证据主要是 Bankr Fee Recipient 指向公开身份，产品证据仍薄。`,
      origin: researchOrigin(core, backing, risk),
      details: researchDetails(core, backing, risk)
    };
  }

  if (hasAny(text, ['multimodal', 'gemma', 'llm', 'huggingface', 'open source model'])) {
    const core =
      '$' +
      symbol +
      ' 的叙事核心是 LLM / 多模态 / 开源模型热点映射：市场买的是模型发布、模型能力、HuggingFace/开源社区或推理服务相关故事。';
    const backing = `${sourceBacking({ bankr, xProfile, website, github })}；社区期待点是如果能看到真实模型权重、benchmark、推理接口、开源仓库或下载量，这类模型叙事传播会很快。`;
    const risk =
      '模型币最容易蹭名，需要确认模型作者、代码仓库、论文/benchmark、下载量、推理服务和 token 关系；如果只是借模型名字，含金量很低。';
    return {
      category: 'AI',
      label: 'AI模型',
      thesis: `${caIntro({ row, bankr, kind: 'AI 模型热点项目币' })} 叙事偏 LLM / 多模态 / 开源模型映射。`,
      origin: researchOrigin(core, backing, risk),
      details: researchDetails(core, backing, risk)
    };
  }

  const memeCore = `$${symbol} 目前没有抓到明确产品锚点，更像名字、图标、社群情绪或某个梗驱动的 meme；当前公开资料里没找到足够明确的原梗、原人物、首发推文或稳定传播源头。`;
  const memeBacking = `${sourceBacking({ bankr, xProfile, website, github })}；社区期待通常来自早期 CA 传播、Bankr 发射、X 转发和二创速度，但目前还没有看到足够强的官方产品或名人背书。`;
  const memeRisk =
    '原梗出处、发起人、传播链路、核心社群、名人背书和 dev 持续运营都未确认；这种盘可以靠情绪冲，但如果故事由来讲不清，持续性会弱。';
  return {
    category: 'Meme',
    label: 'Meme',
    thesis: '目前更像情绪和名字驱动的 meme 盘，没看到足够强的产品锚点。',
    origin: researchOrigin(memeCore, memeBacking, memeRisk),
    details: researchDetails(memeCore, memeBacking, memeRisk)
  };
}

function githubReposByStars(github) {
  return [...(github?.repos || [])].sort((left, right) => (right.stars || 0) - (left.stars || 0));
}

function formatRepoStats(repo) {
  return [
    repo?.stars !== null && repo?.stars !== undefined ? `${formatCompactNumber(repo.stars)} stars` : null,
    repo?.forks !== null && repo?.forks !== undefined ? `${formatCompactNumber(repo.forks)} forks` : null
  ]
    .filter(Boolean)
    .join(' / ');
}

function githubSourceText(github) {
  const repoText = (github?.repos || [])
    .map((repo) =>
      [
        repo.name,
        repo.fullName,
        repo.description,
        repo.language,
        repo.stars !== null && repo.stars !== undefined ? `${repo.stars} stars` : null,
        repo.forks !== null && repo.forks !== undefined ? `${repo.forks} forks` : null
      ]
        .filter(Boolean)
        .join(' ')
    )
    .join(' ');

  return [
    github?.user?.login,
    github?.user?.name,
    github?.user?.bio,
    github?.user?.company,
    repoText,
    github?.topRepoReadme
  ]
    .filter(Boolean)
    .join(' ');
}

function isFreeCodeGithubAiBuilder(github) {
  const topRepo = githubReposByStars(github)[0] || null;
  const topRepoText = [
    topRepo?.name,
    topRepo?.fullName,
    topRepo?.description,
    github?.topRepoReadme,
    github?.user?.bio,
    github?.user?.company
  ].join(' ');
  const topStars = safeNumber(topRepo?.stars) || 0;
  const hasFreeCodeRepo =
    evidenceHas(topRepoText, ['free-code', 'free code', 'paoloanzn/free-code']) ||
    (evidenceHas(topRepoText, ['claude code']) &&
      evidenceHas(topRepoText, ['telemetry', 'guardrails', 'experimental features']));

  return topStars >= 3000 && hasFreeCodeRepo;
}

function describeDev({ row, market, sources, narrative }) {
  const bankr = sources.bankr || null;
  const gecko = sources.gecko || null;
  const virtuals = sources.virtuals || null;
  const xProfile = sources.xProfile || null;
  const website = sources.website || null;
  const github = sources.github || null;
  const githubRepos = githubReposByStars(github);
  const topGithubRepo = githubRepos[0] || null;
  const topRepoStats = formatRepoStats(topGithubRepo);
  const githubText = githubSourceText(github);
  const walletOwnerSearch = sources.walletOwnerSearch || null;
  const virtualsText = virtualsProductText(virtuals);
  const virtualsMembers = virtualsProjectMembers(virtuals);
  const primaryVirtualsMember = primaryVirtualsTeamMember(virtuals);
  const primaryVirtualsMemberHandle = primaryVirtualsMember?.twitterHandle || null;
  const primaryVirtualsMemberUrl = primaryVirtualsMember?.twitterUrl || xUrlFromHandle(primaryVirtualsMemberHandle);
  const primaryVirtualsMemberName =
    primaryVirtualsMember?.displayName || primaryVirtualsMember?.title || primaryVirtualsMemberHandle || null;
  const virtualsTeamText = virtualsTeamSummary(virtuals);
  const hasPhysicalRoboticsVirtuals = hasVirtualsPhysicalAiRobotics([virtualsText, website?.markdown, xProfile?.markdown].join(' '));
  const profileText = [xProfile?.bio, xProfile?.markdown, website?.markdown, website?.title, githubText, virtualsText]
    .filter(Boolean)
    .join(' ');
  const profileSignals = describeMatchedSignals(profileText);
  const followerText = formatFollowers(xProfile?.followers);
  const followerCount = safeNumber(xProfile?.followers);
  const accountLabel = [xProfile?.displayName, xProfile?.handle].filter(Boolean).join(' / ');
  const freeCodeGithubAiBuilder = isFreeCodeGithubAiBuilder(github);
  const virtualsFeeHandle = normalizeHandle(virtuals?.feeDelegatedRecipient);
  const virtualsCreatorHandle = virtuals?.creatorTwitterHandle || null;
  const virtualsHandle = virtualsFeeHandle || virtualsCreatorHandle || null;
  const virtualsFeeWallet = normalizeWallet(virtuals?.feeDelegationVaultAddress) || normalizeWallet(virtuals?.taxRecipient);
  const virtualsWalletAddress = normalizeWallet(virtuals?.virtualsWalletAddress);
  const isVirtualsPrototype = Boolean(virtuals?.prototypeAddress || evidenceHas(virtuals?.url, ['app.virtuals.io/prototypes']));
  const virtualsDelegationSource = isVirtualsPrototype ? 'Virtuals prototype 页面' : 'Virtuals launchInfo';

  let identityStatus = '未确认';
  let publicHandle =
    bankr?.feeRecipientHandle ||
    virtualsHandle ||
    primaryVirtualsMemberHandle ||
    walletOwnerSearch?.matchedHandle ||
    xProfile?.handle ||
    virtuals?.projectTwitterHandle ||
    null;
  let publicName =
    github?.user?.name ||
    xProfile?.displayName ||
    primaryVirtualsMemberName ||
    bankr?.feeRecipientHandle ||
    virtualsHandle ||
    virtuals?.name ||
    row.name ||
    row.symbol;
  let feeRecipientWallet = bankr?.feeRecipientWallet || virtualsFeeWallet || null;
  let feeRecipientHandle = bankr?.feeRecipientHandle || virtualsFeeHandle || null;
  let feeRecipientUrl = bankr?.feeRecipientUrl || xUrlFromHandle(virtualsFeeHandle) || virtuals?.creatorTwitterUrl || null;
  let who = '没找到足够硬的公开证据把 dev 锁定到具体个人。';
  let background = '公开身份背景未确认。';
  let aiLevel = 'AI 背景未确认。';
  let cryptoLevel = '币圈背景未确认。';
  const evidence = [];

  if (virtuals?.id) {
    evidence.push(
      `Virtuals agent：${virtuals.name || row.name || row.symbol}，id=${virtuals.id}，category=${virtuals.category || '未确认'}`
    );
  }
  if (virtuals?.prototypeAddress) {
    evidence.push(
      `Virtuals prototype：${virtuals.name || row.name || row.symbol}，address=${virtuals.prototypeAddress}，category=${
        virtuals.category || 'PROTOTYPE'
      }`
    );
  }

  if (gecko?.categories?.length) {
    evidence.push(`GeckoTerminal 分类：${gecko.categories.join(' / ')}`);
  }

  if (marketPairName(market)) {
    evidence.push(`DexScreener 主池：${marketPairName(market)}`);
  }

  if (virtuals?.feeDelegationType || virtuals?.feeDelegatedRecipient) {
    identityStatus = virtualsFeeHandle ? 'Virtuals Fee Delegation确认' : identityStatus;
    evidence.push(
      `Virtuals fee delegation：type=${virtuals.feeDelegationType || '未确认'}，recipient=${
        virtuals.feeDelegatedRecipient || '未确认'
      }，feeDelegationClaimed=${virtuals.feeDelegationClaimed}`
    );
  }

  if (virtuals?.creatorTwitterHandle || virtuals?.creatorTwitterUrl) {
    evidence.push(
      `Virtuals creator verified Twitter：${virtuals.creatorTwitterHandle || virtuals.creatorTwitterUrl}`
    );
  }

  if (virtuals?.projectTwitterHandle || virtuals?.projectTwitterUrl) {
    evidence.push(`Virtuals 官方 X：${virtuals.projectTwitterHandle || virtuals.projectTwitterUrl}`);
  }

  if (virtuals?.projectWebsiteUrl) {
    evidence.push(`Virtuals 官网：${virtuals.projectWebsiteUrl}`);
  }

  if (virtuals?.videoPitchTweetUrl) {
    evidence.push(`Virtuals video pitch：${virtuals.videoPitchTweetUrl}`);
  }

  if (virtualsWalletAddress) {
    evidence.push(`Virtuals 项目钱包：${virtualsWalletAddress}`);
  }

  if (virtualsTeamText) {
    evidence.push(`Virtuals projectMembers：${virtualsTeamText}`);
  }

  if (feeRecipientHandle) {
    identityStatus = identityStatus === 'Virtuals Fee Delegation确认' ? identityStatus : 'Fee Recipient确认';
    evidence.push(
      bankr?.feeRecipientHandle
        ? `Bankr launch 页面把 fee recipient 直接链接到：${feeRecipientHandle}`
        : `${virtualsDelegationSource}把 fee delegation recipient 指向：${feeRecipientHandle}`
    );
  }

  if (feeRecipientWallet) {
    identityStatus = feeRecipientHandle ? identityStatus : publicHandle ? '部分确认' : '仅钱包确认';
    evidence.push(
      bankr?.feeRecipientWallet
        ? `Bankr fee recipient 收款钱包：${feeRecipientWallet}`
        : `Virtuals fee delegation vault/tax recipient 钱包：${feeRecipientWallet}`
    );
  }

  if (bankr?.deployerHandle) {
    evidence.push(`Bankr deployer：${bankr.deployerHandle}`);
  } else if (bankr?.deployerWallet) {
    evidence.push(`Bankr deployer 钱包：${bankr.deployerWallet}`);
  }

  if (xProfile?.handle) {
    evidence.push(`公开 X 账号：${accountLabel || xProfile.handle}`);
  }

  if (followerText) {
    evidence.push(`X 粉丝约 ${followerText}`);
  }

  if (xProfile?.joined) {
    evidence.push(`X 加入时间：${xProfile.joined}`);
  }

  if (profileSignals.length) {
    evidence.push(`公开资料关键词：${profileSignals.join('、')}`);
  }

  if (walletOwnerSearch?.status === 'matched' && walletOwnerSearch.matchedHandle) {
    evidence.push(`按 fee recipient 地址搜索公开页面时匹配到：${walletOwnerSearch.matchedHandle}`);
  }

  if (website?.url) {
    evidence.push(`项目官网：${website.url}`);
  }

  if (xProfile?.bio) {
    evidence.push(`X 简介：${snippet(xProfile.bio)}`);
  }

  if (github?.user?.login) {
    const userBits = [
      github.user.login,
      github.user.name,
      github.user.bio,
      github.user.company,
      github.user.followers !== null && github.user.followers !== undefined
        ? `${formatCompactNumber(github.user.followers)} followers`
        : null,
      github.user.publicRepos !== null && github.user.publicRepos !== undefined
        ? `${github.user.publicRepos} repos`
        : null
    ];
    evidence.push(`GitHub：${userBits.filter(Boolean).join(' / ')}`);
  }

  for (const repo of githubRepos.slice(0, 3)) {
    const stats = formatRepoStats(repo);
    evidence.push(
      `GitHub repo：${repo.fullName}${stats ? `，${stats}` : ''}${
        repo.description ? `，${snippet(repo.description, 150)}` : ''
      }`
    );
  }

  const isRepoPromptDev =
    evidenceHas(profileText, ['repoprompt', 'repo prompt']) &&
    evidenceHas(profileText, ['staff eng', 'staff engineer', '@unity', ' unity', 'mcp', 'codemaps']);
  const isPlannotatorDev =
    narrative.label === 'AI代码审查/计划标注' ||
    evidenceHas(profileText, ['plannotator']) ||
    evidenceHas(profileText, ['eqtylab', 'eqty lab']);
  const isCivicAiBuilder =
    evidenceHas(profileText, [
      'goodheart labs',
      'viewpoints',
      'community notes',
      'note-writer',
      'fact-checking',
      'fact checking',
      'finding consensus',
      'forecast',
      'forecasting',
      'metaculus',
      'manifold',
      'kalshi'
    ]) || narrative.label === 'AI社区治理/共识工具';
  const isVirtualsBuilder = narrative.label === 'Virtuals AI Agent' || Boolean(virtuals?.id || virtuals?.prototypeAddress);
  const isRecordlyBuilder = narrative.label === '开源录屏工具';
  const isLikwidBuilder = narrative.label === 'DeFi杠杆/借贷协议';
  const isPrintingPressBuilder = narrative.label === 'AI Agent CLI生成器';
  const isHunchBuilder = narrative.label === '预测市场/社交交易';
  const isBankrAgentBuilder = narrative.label === 'Bankr生态/agent执行';
  const isMoatBuilder = narrative.label === 'GitHub安全审计工具';
  const isDmnBuilder = narrative.label === '链上agent执行网络';
  const isSecurityResearcherBuilder = narrative.label === '安全研究者meme';
  const isEccAgentHarnessBuilder = narrative.label === 'AI Agent工具框架';
  const isLocalAiBuilder = narrative.label === '开源本地AI推理栈';
  const isPhysicalAiAttestationBuilder = narrative.label === 'Physical AI验证';
  const isHumanCvBuilder = narrative.label === '人类身份/创作证明';
  const isAuraDeFiAnalystBuilder = narrative.label === '链上分析师meme';
  const isZbasePrivacyPaymentsBuilder = narrative.label === 'ZK Agent支付隐私';
  const isResearchAutomationBuilder = narrative.label === 'AI研究自动化';
  const isThinAgentPersonaBuilder = narrative.label === 'AI Agent人物meme';
  const isLazyCodexBuilder = narrative.label === 'AI Coding懒人工具';
  const isBlindCacheBuilder = narrative.label === '加密AI记忆层';
  const hasStrongAiBuilderSignals =
    freeCodeGithubAiBuilder ||
    evidenceHas(profileText, ['staff eng', 'staff engineer', 'mcp', 'codemaps', 'orchestrate', 'models', 'prompt']) ||
    profileSignals.some((item) => ['Staff Eng', 'MCP', 'codemaps', '模型工作流/提示工程'].includes(item));
  const hasAiProductSignals =
    narrative.category === 'AI' ||
    profileSignals.length > 0 ||
    evidenceHas(profileText, [
      'ai',
      'agent',
      'inference',
      'model routing',
      'mcp',
      'claude code',
      'coding agent',
      'automation'
    ]);

  if (
    accountLabel ||
    xProfile?.bio ||
    profileSignals.length ||
    github?.user?.login ||
    topGithubRepo ||
    virtuals?.id ||
    virtuals?.prototypeAddress
  ) {
    const parts = [];
    if (accountLabel) {
      parts.push(accountLabel);
    }
    if (xProfile?.bio) {
      parts.push(`X 简介写着「${snippet(xProfile.bio, 120)}」`);
    }
    if (github?.user?.login) {
      const githubIdentity = [
        github.user.name,
        github.user.company,
        github.user.bio && `GitHub bio「${snippet(github.user.bio, 80)}」`
      ]
        .filter(Boolean)
        .join(' / ');
      parts.push(`GitHub ${github.user.login}${githubIdentity ? `：${githubIdentity}` : ''}`);
    }
    if (topGithubRepo) {
      parts.push(
        `代表 repo 是 ${topGithubRepo.fullName}${topRepoStats ? `（${topRepoStats}）` : ''}${
          topGithubRepo.description ? `，描述为「${snippet(topGithubRepo.description, 120)}」` : ''
        }`
      );
    }
    if (profileSignals.length) {
      parts.push(`能看到 ${profileSignals.join('、')} 这些公开线索`);
    }
    if (virtuals?.id) {
      parts.push(
        `Virtuals 资料显示他关联 ${virtuals.name || row.symbol}（id ${virtuals.id}，category ${
          virtuals.category || '未确认'
        }，factory ${virtuals.factory || '未确认'}）`
      );
    } else if (virtuals?.prototypeAddress) {
      parts.push(
        `Virtuals prototype 页面显示他关联 ${virtuals.name || row.symbol}（prototype ${virtuals.prototypeAddress}，category ${
          virtuals.category || 'PROTOTYPE'
        }）`
      );
    }
    background = `${parts.join('；')}。`;
  }

  const hasVirtualsTeamIdentity = Boolean(
    isVirtualsBuilder &&
      virtualsMembers.length &&
      !bankr?.feeRecipientHandle &&
      !bankr?.feeRecipientWallet &&
      !virtualsFeeHandle &&
      !virtualsFeeWallet
  );

  if (hasVirtualsTeamIdentity) {
    publicHandle = primaryVirtualsMemberHandle || virtuals?.projectTwitterHandle || publicHandle;
    publicName = primaryVirtualsMemberName || virtuals?.name || publicName;
    feeRecipientWallet = null;
    feeRecipientHandle = null;
    feeRecipientUrl = primaryVirtualsMemberUrl || virtuals?.projectTwitterUrl || null;
    identityStatus = 'Virtuals Team确认';
    who = `Virtuals projectMembers 显示核心团队包括 ${virtualsTeamText || primaryVirtualsMemberName || '已公开成员'}；当前没有 fee delegation 绑定，所以不能把 ${
      virtualsWalletAddress || 'Virtuals walletAddress'
    } 当成 Fee Recipient。当前 dev 线索以团队成员 ${primaryVirtualsMemberName || publicName}${
      publicHandle ? `（${publicHandle}）` : ''
    } 和官方项目号 ${virtuals?.projectTwitterHandle || '未确认'} 为主。`;
    background = `Virtuals projectMembers 显示团队：${virtualsTeamText}。${
      virtuals?.projectTwitterHandle ? `官方 X 是 ${virtuals.projectTwitterHandle}。` : ''
    }${virtuals?.projectWebsiteUrl ? `官网是 ${virtuals.projectWebsiteUrl}。` : ''}`;
  }

  if (isLazyCodexBuilder) {
    aiLevel = `早期 coding-agent builder：${publicName || feeRecipientHandle || 'Q'} 的公开 X 简介写着 “Building oh-my-opencode. 23y/o hacker.”，LazyCodex 官网又写 “OmO in Codex / Currently on OpenCode / Codex for lazy people / prompt with ultrawork”，说明他至少在 OpenCode、Codex、coding agent 工作流这个细分方向做具体工具。AI 圈层级上不能吹成一线或二线强 KOL：X 约 ${followerText || '未知'}粉，还没看到稳定产品收入、真实用户数据、顶级实验室研究员或顶会论文证据；更合理是“年轻、能做产品预告的早期 AI coding 工具 builder”，有执行力线索，但仍要等 demo 和开源/用户验证。`;
  } else if (isBlindCacheBuilder) {
    aiLevel = `AI infra 技术型 builder：${publicName || feeRecipientHandle || 'nikshepsvn'} 关联的是 BlindCache 这种加密 AI 记忆层，公开 repo/推文能看到 Nillion Blind Computer、nilDB、Blindfold、NUC tokens、nilAI、MCP server、vault SDK、Claude Code、Cursor、Venice 等具体技术栈。这个方向有真实技术含量，解决的是 agent memory 被中心化 provider 读明文的问题，不是简单 AI 贴词。层级上我会放在“细分 infra 早期偏强”：有 Coinbase/Instacart/PagerDuty/SeatGeek/Waterloo 这类工程履历线索和真实 repo，但还不是 OpenAI/Anthropic 研究员、头部模型作者或 AI 圈顶流。`;
  } else if (freeCodeGithubAiBuilder) {
    aiLevel = `中上：${publicName} 更像开源实干派开发者 + AI 创业者，不是只会发 meme 的号。GitHub 上能看到 ${topGithubRepo.fullName}${topRepoStats ? `（${topRepoStats}）` : ''}，核心是 free-code / Claude Code 相关 coding-agent 工具，README/描述里有 telemetry、guardrails、experimental features、多模型 provider 等工程细节；再叠加 Gladium AI / agentic AI 背景和 X 约 ${followerText || '未知'}粉，在 AI coding agent / 开源工具这个细分赛道属于有影响力的 builder。短板是没看到顶级实验室研究员、顶会论文或 Karpathy 那种顶流公众影响力证据，所以不是一线学术/模型圈顶级，但明显强于普通项目号。`;
  } else if (isEccAgentHarnessBuilder) {
    aiLevel = `中上偏强：${publicName || 'Affaan Mustafa'} 是 ECC / OSS Agent Meta-Harness 的 creator，公开资料把 ECC 定位成 agent harness performance optimization system，服务 Claude Code、Codex、Opencode、Cursor 这类 coding agents，并围绕 skills、instincts、memory、security、MCP、codemaps 和 research-first development 做工具链。X 约 ${followerText || '3.11万'}粉，GitHub 代表 repo ${topGithubRepo?.fullName || 'affaan-m/ECC'}${topRepoStats ? `（${topRepoStats}）` : ''}，说明他在 AI coding agent / agent devtools 细分圈属于实干型强 builder。短板是没看到顶级模型实验室研究员或顶会学术身份，所以不是 Karpathy 那种 AI 顶流，但明显不是普通蹭 AI 的项目号。`;
  } else if (isLocalAiBuilder) {
    aiLevel = `中上偏强：${publicName || 'Ettore Di Giacinto'} 是 LocalAI 相关开源 AI infra builder，公开资料把 LocalAI 定位成 OpenAI-compatible 本地推理/API 栈，覆盖 LLM、图片生成、音频、embeddings、本地/on-prem、Docker/Kubernetes 部署。X 约 ${followerText || '1.46万'}粉，GitHub 代表 repo ${topGithubRepo?.fullName || 'mudler/LocalAI'}${topRepoStats ? `（${topRepoStats}）` : ''}，说明他在开源 AI 推理基础设施/本地模型服务这个细分圈有实打实影响力。短板是没看到顶级模型实验室研究员或顶会学术身份，所以不是模型研究顶流，但作为 AI infra 开源 builder 明显强于普通 AI 项目号。`;
  } else if (isZbasePrivacyPaymentsBuilder) {
    aiLevel = `早期技术型项目号：${publicName || feeRecipientHandle || 'zBase'} 不是泛 AI 应用创业者画像，而是 AI agent payments + ZK 隐私基础设施方向。公开资料能看到 x402 agent payments、zero-knowledge privacy facilitator、Privacy Pools fork、Base/Solana 部署和 Groth16 verification，这些是具体 infra 技术词，不是普通 AI 贴词。AI 圈层级上先按早期 AI x crypto infra builder 看：方向有技术含量，但还没看到头部 AI 模型公司、顶会论文、大规模开源 star 或成熟产品用户，所以不能拔成一线 AI 人物。`;
  } else if (isThinAgentPersonaBuilder) {
    aiLevel = `不是典型 AI 圈：${publicName || feeRecipientHandle || row.name} 当前公开资料更像 Crypto & Security / NYU 安全和密码学身份，而不是 AI 模型、agent 产品或 AI devtools builder。名字里有 Agent，但本次没有抓到官网、GitHub、Virtuals 页面或产品 demo，所以不能只凭 “Agent” 二字判断他在 AI 圈很强；更合理的判断是安全/密码学背景可能加分，AI 产品能力仍未确认。`;
  } else if (isResearchAutomationBuilder) {
    aiLevel = `早期/待验证：${publicName} 对应的是 AI 研究自动化产品线索，方向是 web search、inference、scheduled reports、workflow automation 和 model routing。这个方向有应用价值，但 dev 本人在 AI 圈的知名度、技术履历、开源影响力、真实用户和收入还需要继续确认，不能仅凭自动化关键词给高分。`;
  } else if (isPrintingPressBuilder) {
    aiLevel = `早期偏强/待确认：${publicName} 关联的是 Printing Press 这种 AI agent 工具链项目，公开资料能看到 CLI 生成、MCP server、Claude Code skill、SQLite sync、offline search 和 agent-native flags 等具体工程方向。它更像 AI agent 基础设施/开发者工具 builder 叙事，有技术含量，但目前还缺少 GitHub star、真实安装量、收入、头部 AI 圈背书或本人一线 AI KOL 影响力证据，所以先按细分赛道早期 builder 看。`;
  } else if (isBankrAgentBuilder) {
    aiLevel = `偏 AI agent 应用层/链上自动化：${publicName} 的公开内容围绕 Bankr terminal、skills demo、agent 执行链上操作、onchain payments、Uniswap v3 流动性和 rebalancing automations 展开。它不是模型研究员路线，更像把 agent 接到交易、技能和链上执行的产品/生态 builder；X 约 ${followerText || '未知'}粉，传播力不错，但技术深度和真实产品规模仍要看后续 demo、用户和资金流。`;
  } else if (isRecordlyBuilder) {
    aiLevel = `不是典型 AI 圈：${publicName} 更像开源产品/独立开发者，主项目是 Recordly 录屏工具，卖点是 auto-zoom、光标动画、时间线编辑、音频和导出能力。它的强项是能做真实工具和开源产品，X 写着 Recordly 10K+ stars；但目前没看到 AI 模型、agent、顶会论文或头部 AI 工具圈履历，所以 AI 圈水平不能硬拔高。`;
  } else if (isLikwidBuilder) {
    aiLevel = `不是典型 AI 圈：${publicName} 的公开资料主要是 DeFi 协议方向，强调 oracle-free margin trading、lending、Swap/Margin unified liquidity 和 long-tail leverage。这里应该按 DeFi 产品/协议能力看，不按 AI 圈人物打分；目前未看到明确 AI 履历或 AI 产品建设记录。`;
  } else if (isHunchBuilder) {
    aiLevel = `偏产品/agent 应用层：${publicName} 对应的是 Hunch 这种预测市场消费化产品，AI 相关点在 agent route/manage/explain trade 和社交信号层，不是模型研发或 AI 学术背景。我的判断是产品型 builder 叙事，有 prediction market + agent UX 的创新点，但 AI 圈知名度、技术论文、模型或开源 AI 工具影响力还未确认。`;
  } else if (isMoatBuilder) {
    aiLevel = `不是典型 AI 圈：${publicName} 的强项在 Laravel/PHP 开源工程和 GitHub 安全审计工具。公开资料显示他是 Laravel staff software engineer、open-source contributor，Moat 做的是 GitHub organization / repository 的安全姿态检查，覆盖 2FA、branch protection、secret scanning、Dependabot 等配置。这里应按开源工程和安全工具 builder 评价，暂未看到模型研发、AI agent 或头部 AI 圈身份。`;
  } else if (isDmnBuilder) {
    aiLevel = `早期偏强/安全工程取向：${publicName} 的公开简介强调 exploits、patch、break code，项目号 @dmn_net 又写着 Agents that never sleep / 350ms event-to-execution / Live on Base。我的判断是安全工程背景 + 链上 agent 执行网络的早期 builder 叙事，有技术味道，但产品 demo、用户和实际 agent 能力还需要继续验证。`;
  } else if (isSecurityResearcherBuilder) {
    aiLevel = `不是典型 AI 圈：${publicName} 的公开资料更偏安全研究和逆向工程，简介里明确写到 Security researcher、reverse engineer、Windows kernel development、low-level programming、static program analysis 和 cryptography。这里应按安全研究/底层工程能力评价，暂未看到模型研发、AI agent 产品或头部 AI 圈身份。`;
  } else if (isPhysicalAiAttestationBuilder) {
    aiLevel = `早期技术型项目号：${publicName} 做的是 Physical AI 验证基础设施，公开资料能看到 Base/EAS attestation、Groth16 ZK proofs、secure-element signing、reputation/staking、DePIN/无人机/机器人这些具体技术和场景线索。方向有技术含量，属于 AI x crypto x real-world machine verification 的早期 builder 叙事；但 X 约 ${followerText || '未知'}粉，GitHub star/fork 很少，还没有看到头部 AI 圈身份、真实客户或大规模开源采用，所以目前不能按一线 AI 圈人物评价。`;
  } else if (isHumanCvBuilder) {
    aiLevel = `不是典型 AI 圈：${publicName} 的公开资料更像身份/创作证明产品，不是模型、agent 或 AI coding 工具。human.cv 的重点是 proof that I made it、verified human、on-chain résumé 和作品归属证明；它有产品概念，但目前没有看到 dev 在 AI 研究、AI 工具开源或模型圈的知名履历。`;
  } else if (isAuraDeFiAnalystBuilder) {
    aiLevel = `不是典型 AI 圈：${publicName} 的公开简介偏链上流动性、留存分析、DeFi 教育、Research 和 Dune wizard。这里应该按 crypto 数据分析/DeFi 内容能力看，不按 AI 圈打分；目前没看到模型研发、AI agent 产品或头部 AI 工具履历。`;
  } else if (isVirtualsBuilder) {
    const productEvidence = evidenceHas(profileText, [
      'staffing',
      'recruiting',
      'recruitment',
      'sourcing',
      'automated matching',
      'candidate proposals',
      'predictive analytics',
      '70k arr'
    ]);
    aiLevel = hasPhysicalRoboticsVirtuals
      ? `早期偏强/中上潜力：${publicName} 所在 OrionX Robotics 团队做的是 Physical AI / 机器人方向，不是普通聊天 agent。Virtuals 资料和团队 bio 指向 humanoid robots、防务/危险场景、ARES、Vision-Language-Action / VLA、Unitree G1 EDU、NVIDIA Isaac Sim、OpenVLA/GR00T 和 ROS 2。这个方向技术含量高，团队里能看到 Defense Partnerships/GTM 和 ARES VLA System & Robotics 分工；但它还没有被验证成 Anduril 级别公司，也没看到大规模客户、硬件量产或顶级 AI 圈公开背书，所以我按“Physical AI 早期偏强 builder 团队”，不是一线已验证巨头。`
      : productEvidence
      ? `早期偏强/待验证：${publicName} 不是 AI 圈顶流，但公开资料能看到真实产品线索。X 简介写着 Founder @ Psview、70K ARR in 3 months，官网描述的是 AI 招聘/猎头产品，功能包括 Intelligent Sourcing、Automated Matching、Candidate Proposals、Predictive Analytics 等；Virtuals 侧又能确认他关联 $${row.symbol} 这个 Virtuals AI Agent / IP Mirror。我的判断是 AI 应用创业者/早期 builder，有产品和收入叙事，但粉丝约 ${followerText || '未知'}、缺少大厂研究员/顶会/头部 AI KOL 级证据，所以还不能给一线或强二线。`
      : `早期/未确认：能确认 ${publicName} 是这个 Virtuals AI Agent / IP Mirror 的 fee delegation 或 creator 线索，但公开 AI 产品、技术栈、用户和收入证据还不够；先按 Virtuals AI Agent 早期 builder 看，不直接拔高。`;
  } else if (isCivicAiBuilder && followerCount >= 10000) {
    aiLevel = `二线偏强：${publicName} 不是模型研究员或 coding-agent 顶流，但在 AI 社区治理/事实核查/预测工具这个细分方向有实打实项目。公开资料能看到 Goodheart Labs、Viewpoints、AI-written Community Notes / note-writer、Finding Consensus、fact-checking 或 forecasting 线索，X 约 ${followerText}粉，说明他更像 civic tech + AI policy 圈的实干型 builder。定位上强于普通 AI meme 项目号，但还没看到 OpenAI/Anthropic 核心研究员、头部模型公司创始人或顶级 AI KOL 那种一线影响力。`;
  } else if (isCivicAiBuilder) {
    aiLevel = `早期偏强：公开资料能看到 Goodheart Labs / Viewpoints / Community Notes / forecasting 这类 AI 社区治理和事实核查产品线索，说明 dev 不是只贴 AI 概念；但粉丝体量或外部背书还不够，先按小圈层 builder 判断。`;
  } else if (isPlannotatorDev) {
    aiLevel = `早期偏强/细分实干派：${publicName} 的公开 X 简介写着 Cofounder, AI @EQTYLab / complex systems / For fun: @plannotator，项目本身是 AI coding agents 的计划标注和代码审查协作工具。我的判断是 AI devtools 小圈层 builder，有真实产品方向和工程交付线索，但 X 粉丝约 ${followerText || '未知'}，暂未看到头部模型公司、顶级研究员、顶会论文或大规模开源 star 证据，所以不是一线 AI 圈人物。`;
  } else if (isRepoPromptDev && followerCount >= 10000) {
    aiLevel = `二线偏强：${publicName} 不是纯 meme 号，公开资料显示他在做 RepoPrompt，方向是 AI 工具/代码库上下文/MCP/codemaps；bio 里有 prev Staff Eng working on XR @unity，叠加 ${followerText}粉，在 AI 开发工具圈属于小有名气、工程履历比较硬的一档，但还不是 OpenAI/Anthropic 核心研究员或顶级 AI KOL 那种一线。`;
  } else if (hasStrongAiBuilderSignals && followerCount >= 10000) {
    aiLevel = `二线：公开资料能看到 Staff Eng/MCP/codemaps/模型工作流这类真实 AI 工程线索，X 粉丝约 ${followerText}，说明在 AI 工具或工程圈有一定影响力；暂未看到顶级实验室研究员、头部模型团队创始人级别证据。`;
  } else if (hasStrongAiBuilderSignals) {
    aiLevel = `早期偏强：公开资料能看到 ${profileSignals.join('、') || 'AI 工程'} 线索，像真实 AI 产品/工具开发者，不是单纯贴 AI 概念；但粉丝体量和外部背书还不够，暂按小圈层 builder 判断。`;
  } else if (hasAiProductSignals && followerCount !== null && followerCount < 1000) {
    aiLevel = `小号/新号：项目资料有 AI 产品线索，但账号只有约 ${followerText}粉，dev 本人在 AI 圈知名度和履历未确认，先按早期项目号看。`;
  } else if (hasAiProductSignals) {
    aiLevel = '早期/未确认：能看到 AI 产品或工具描述，但缺少能证明 dev 本人很出名或技术很强的公开履历，不能只因为项目叫 AI 就给高分。';
  } else {
    aiLevel = '未确认：没有抓到明确 AI 履历、AI 产品建设记录或 AI 圈影响力证据。';
  }

  if (feeRecipientHandle) {
    if (isLazyCodexBuilder) {
      cryptoLevel = `Base/Bankr 早期社区盘：Bankr Fee Recipient 直接绑定 ${feeRecipientHandle}，链上发行归属清楚；launch tweet 里明确喊 “tool for token lovers, token burners, token maxxxers”，说明 dev 至少懂 Bankr/Base 当前这套 token 社区玩法，并主动把产品预告和 token 情绪放在一起。但现在还不能按老牌币圈强号评价：没看到长期 DeFi 协议、链上交易员、投研 KOL、大规模链上产品或明确 token utility，属于“AI coding dev 切入 Base/Bankr 的早期关注对象”。`;
    } else if (isBlindCacheBuilder) {
      cryptoLevel = `早期偏强/crypto infra 相关：Bankr Fee Recipient 直接绑定 ${feeRecipientHandle}，链上发行归属清楚；公开背景有 Coinbase data/infra 线索，项目技术栈又直接使用 Nillion / $NIL / nilDB / Blind Computer，这比普通 AI 外行发币更 crypto-native。短板是还没看到成熟协议收入、审计、TVL、token 捕获设计或老牌 DeFi 创始人/KOL 履历，所以币圈层级应按“有强工程和 crypto infra 语境的新晋 builder”，不是一线币圈玩家。`;
    } else if (freeCodeGithubAiBuilder) {
      cryptoLevel = `新晋关注对象：Bankr Fee Recipient 直接绑定 ${feeRecipientHandle}，链上发行归属清楚；公开资料里能看到 Base/Bankr 语境和 AI dev 跨界迹象，再加上 GitHub 里有 free-solscan-api 这类链上数据工具，说明他不是完全不懂 crypto 的外行。当前更像“老用户/技术开发者被 Base 社区发现”的阶段，尚未看到成熟 crypto 协议、头部 DeFi 项目、长期币圈 KOL 或大规模链上产品履历，所以币圈层级不能按老牌一线 builder 算。`;
    } else if (isEccAgentHarnessBuilder) {
      cryptoLevel = `新晋偏强/crypto-native 迹象明确：Bankr Fee Recipient 直接绑定 ${feeRecipientHandle}，链上发行归属清楚；公开资料里又能看到 prediction markets / Ito 或 @ito_markets 线索，说明 ${publicName || feeRecipientHandle} 不只是纯 AI 外行跨界，而是已经在预测市场/链上金融语境里做事。当前还不能按老牌 DeFi 协议创始人或一线币圈 KOL 评价，但比随机 dev-backed meme 强，属于“AI agent 工具强 builder + prediction markets 背景 + Bankr/Base 新晋关注对象”的阶段。`;
    } else if (isLocalAiBuilder) {
      cryptoLevel = `早期/AI infra 跨界：Bankr Fee Recipient 直接绑定 ${feeRecipientHandle}，链上发行归属清楚；${publicName || feeRecipientHandle} 的硬背书主要在 LocalAI 这种开源 AI infra，而不是币圈原生协议。当前更像“成熟开源 AI builder 被 Bankr/Base 社区捕捉到”的阶段，强在技术和开源声誉，币圈侧还没看到长期 DeFi 协议、链上交易员、投研 KOL 或 token 经济落地证据。`;
    } else if (isZbasePrivacyPaymentsBuilder) {
      cryptoLevel = `早期 crypto infra 项目：Bankr Fee Recipient 直接绑定 ${feeRecipientHandle}，链上发行归属清楚；zBase 公开叙事是 Base/Solana、x402 agent payments、Privacy Pools、Groth16 和 Base Batches 003 Finalist，说明它比随机 AI 名字盘更 crypto-native。层级上仍是早期项目号，还没看到成熟协议收入、审计、真实支付量、头部 DeFi 背书或老牌币圈 KOL 影响力。`;
    } else if (isThinAgentPersonaBuilder) {
      cryptoLevel = `早期但比随机钱包强：Bankr Fee Recipient 直接绑定 ${feeRecipientHandle}，deployer/发射线索也在 Bankr 体系内；公开身份偏 Crypto & Security / NYU 语境，说明不是完全空白钱包。但还没看到他是头部协议创始人、链上交易员、一线币圈 KOL 或成熟项目方，所以币圈层级先按早期 dev-backed/persona meme 看。`;
    } else if (isVirtualsBuilder) {
      cryptoLevel = `Virtuals/Base 新盘早期：${virtualsDelegationSource}的 fee delegation 直接指向 ${feeRecipientHandle}，且 feeDelegationClaimed=${virtuals?.feeDelegationClaimed}，链上归属比只有钱包地址清楚；主池 ${
        marketPairName(market) || '$' + row.symbol + '/VIRTUAL'
      } 也说明它在 Virtuals 生态里交易。币圈水平目前更像“AI 应用 dev 被 Base/Virtuals 社区包装和发现”的阶段，不是老牌 DeFi 创始人、头部交易员或成熟币圈 KOL。`;
    } else if (isHumanCvBuilder) {
      cryptoLevel = `三线/早期：Bankr Fee Recipient 直接绑定 ${feeRecipientHandle}，链上发行归属清楚，官网和项目号能对上 human.cv。币圈方向目前是身份/作品证明产品切入 Base/Bankr 的早期阶段，还没看到成熟协议收入、长期链上声誉系统、头部 DeFi 项目或老牌币圈 KOL 履历。`;
    } else if (isAuraDeFiAnalystBuilder) {
      cryptoLevel = `早期但比随机钱包强：Bankr Fee Recipient 直接绑定 ${feeRecipientHandle}，公开简介显示他是 Onchain Liquidity & Retention Analyst、DeFi Educator、Researcher、Dune wizard，说明 dev 至少懂链上数据、流动性和 DeFi 叙事。层级上更像 crypto 数据分析/DeFi 内容型账号，不是顶级协议创始人或一线 KOL；后续要看他是否持续认领 $${row.symbol}、做数据看板或给出产品路线。`;
    } else if (hasStrongAiBuilderSignals) {
      cryptoLevel = `三线/早期：Bankr Fee Recipient 直接绑定 ${feeRecipientHandle}，说明这次链上发行归属清楚；但公开资料更像 AI/devtools builder，没有看到长期 DeFi 协议创始人、链上交易员、VC/投研或币圈原生顶级 KOL 的证据，所以币圈水平先按早期/非原生强号。`;
    } else if (isPlannotatorDev) {
      cryptoLevel = `三线/早期：Bankr Fee Recipient 直接绑定 ${feeRecipientHandle}，deployer/launch 线索也在 Bankr 体系内，链上发行归属清楚；但公开资料主要是 AI/devtools 和 EQTYLab 背景，暂未看到长期 DeFi 协议、链上交易员、投研 KOL 或币圈原生大项目履历。`;
    } else if (narrative.label === 'Agent信用/AI金融') {
      cryptoLevel = `三线/早期：Bankr Fee Recipient 绑定 ${feeRecipientHandle}，链上发行归属清楚；项目有 AI金融/agent 信用产品线索，但还未看到团队或个人在币圈已有头部协议、交易、投研影响力。`;
    } else {
      cryptoLevel = `三线/早期：Bankr Fee Recipient 绑定 ${feeRecipientHandle}，比只有钱包地址清楚；但未看到足够证据证明 dev 是币圈原生强号或头部玩家。`;
    }
  } else if (feeRecipientWallet) {
    cryptoLevel = '未确认偏早期：Bankr 只确认到 fee recipient 钱包，链上发行存在，但钱包背后是谁、是不是币圈强号还没查实。';
  } else if (hasVirtualsTeamIdentity) {
    cryptoLevel = `Virtuals/Base 项目团队可见但仍早期：Virtuals projectMembers、官方 X 和官网能把项目团队串起来，不过未看到 fee delegation 绑定或收益接收方认领；Virtuals tokenomics 里的 walletAddress ${
      virtualsWalletAddress || '未确认'
    } 更像项目/treasury 钱包线索，不等于 dev 收款身份。币圈侧目前属于“项目团队可见 + Virtuals/Base 新盘”，还没看到老牌 DeFi 协议、链上交易员、一线 KOL 或成熟 crypto 产品履历。`;
  } else if (isPhysicalAiAttestationBuilder) {
    cryptoLevel = `链上证明方向明确但发行归属未确认：项目公开资料强调 Base、EAS attestation、ZK proofs、reputation/staking 和 DePIN/physical work 证明，说明 crypto 叙事不是硬蹭；但本次没有抓到 Bankr Fee Recipient 或具体个人 dev，链上发行/收益归属还要继续核对。`;
  } else if (market.socials?.length || market.websites?.length) {
    cryptoLevel = '未确认：有公开项目入口，但没抓到明确 Bankr Fee Recipient 或链上发行归属，币圈履历不能硬判。';
  }

  if (feeRecipientHandle) {
    who =
      identityStatus === 'Virtuals Fee Delegation确认'
        ? `${virtualsDelegationSource}的 fee delegation 直接指向 ${feeRecipientHandle}，feeDelegationClaimed=${virtuals?.feeDelegationClaimed}，这是当前最硬的 dev/收益接收方线索。${
            feeRecipientWallet ? `对应 vault/tax recipient 钱包是 ${feeRecipientWallet}。` : ''
          }`
        : `Bankr launch 的 Fee Recipient 直接指向 ${feeRecipientHandle}，这是当前最硬的 dev/收益接收方线索。${feeRecipientWallet ? `对应收款钱包是 ${feeRecipientWallet}。` : ''}`;
  } else if (walletOwnerSearch?.status === 'matched' && publicHandle && feeRecipientWallet) {
    identityStatus = '较强确认';
    who = `Bankr fee recipient 钱包 ${feeRecipientWallet} 在公开搜索里能对应到 ${publicHandle}，这比只拿到项目账号更接近直接 dev 归属。`;
  } else if (publicHandle && feeRecipientWallet) {
    who = `当前能确认的公开操盘面是 ${publicHandle}，同时 Bankr fee recipient 钱包是 ${feeRecipientWallet}。我已按这个钱包做过公开搜索，但还没抓到把它直接绑定到具体个人身份的证据。`;
  } else if (hasVirtualsTeamIdentity) {
    identityStatus = 'Virtuals Team确认';
  } else if (publicHandle) {
    identityStatus = '项目账号确认';
    who = `当前能确认的公开项目方账号是 ${publicHandle}，但还没找到更具体的个人 dev 归属。`;
  } else if (feeRecipientWallet) {
    who = `目前只确认到 Bankr fee recipient 钱包 ${feeRecipientWallet}。我已按这个地址做过公开搜索，但钱包归属到哪位个人或团队仍未确认。`;
  }

  return {
    publicName,
    publicHandle,
    feeRecipientWallet,
    feeRecipientHandle,
    feeRecipientUrl,
    virtualsWalletAddress,
    identityStatus,
    who,
    background,
    aiLevel,
    cryptoLevel,
    evidence: unique(evidence)
  };
}

function buildEvidence({ sources, market }) {
  const items = [];

  if (sources.gecko?.categories?.length) {
    items.push(`GeckoTerminal 分类：${sources.gecko.categories.join(' / ')}`);
  }
  if (sources.gecko?.virtualsUrl) {
    items.push(`GeckoTerminal Virtuals 页面：${sources.gecko.virtualsUrl}`);
  }
  if (sources.gecko?.holderCount !== null && sources.gecko?.holderCount !== undefined) {
    items.push(`GeckoTerminal holders：${sources.gecko.holderCount}`);
  }
  if (sources.gecko?.top10HolderPercentage !== null && sources.gecko?.top10HolderPercentage !== undefined) {
    items.push(`GeckoTerminal top10 持仓：${formatPercent(sources.gecko.top10HolderPercentage)}`);
  }
  if (sources.virtuals?.id) {
    items.push(
      `Virtuals agent：id=${sources.virtuals.id}，category=${sources.virtuals.category || '未确认'}，factory=${
        sources.virtuals.factory || '未确认'
      }`
    );
  }
  if (sources.virtuals?.prototypeAddress) {
    items.push(
      `Virtuals prototype：${sources.virtuals.url || sources.virtuals.prototypeAddress}，category=${
        sources.virtuals.category || 'PROTOTYPE'
      }`
    );
  }
  if (sources.virtuals?.feeDelegationType || sources.virtuals?.feeDelegatedRecipient) {
    items.push(
      `Virtuals fee delegation：type=${sources.virtuals.feeDelegationType || '未确认'}，recipient=${
        sources.virtuals.feeDelegatedRecipient || '未确认'
      }，feeDelegationClaimed=${sources.virtuals.feeDelegationClaimed}`
    );
  }
  if (sources.virtuals?.projectTwitterHandle || sources.virtuals?.projectTwitterUrl) {
    items.push(`Virtuals 官方 X：${sources.virtuals.projectTwitterHandle || sources.virtuals.projectTwitterUrl}`);
  }
  if (sources.virtuals?.projectWebsiteUrl) {
    items.push(`Virtuals 官网：${sources.virtuals.projectWebsiteUrl}`);
  }
  if (sources.virtuals?.videoPitchTweetUrl) {
    items.push(`Virtuals video pitch：${sources.virtuals.videoPitchTweetUrl}`);
  }
  if (sources.virtuals?.virtualsWalletAddress) {
    items.push(`Virtuals 项目钱包：${sources.virtuals.virtualsWalletAddress}`);
  }
  if (sources.virtuals?.projectMembers?.length) {
    items.push(`Virtuals projectMembers：${virtualsTeamSummary(sources.virtuals)}`);
  }
  if (marketPairName(market)) {
    items.push(`DexScreener 主池：${marketPairName(market)}`);
  }
  if (sources.website?.title) {
    items.push(`官网标题：${sources.website.title}`);
  }
  if (sources.website?.markdown) {
    items.push(`官网摘要：${snippet(sources.website.markdown)}`);
  }
  if (sources.xProfile?.bio) {
    items.push(`X 简介：${sources.xProfile.bio}`);
  }
  if (sources.xProfile?.followers !== null && sources.xProfile?.followers !== undefined) {
    items.push(`X 粉丝：${sources.xProfile.followers}`);
  }
  if (sources.projectXProfile?.handle) {
    items.push(`项目 X 账号：${sources.projectXProfile.displayName || sources.projectXProfile.handle} / ${sources.projectXProfile.handle}`);
  }
  if (sources.projectXProfile?.bio) {
    items.push(`项目 X 简介：${sources.projectXProfile.bio}`);
  }
  if (sources.bankr?.feeRecipientHandle) {
    items.push(`Bankr fee recipient：${sources.bankr.feeRecipientHandle}`);
  }
  if (sources.bankr?.feeRecipientWallet) {
    items.push(`Bankr fee recipient 钱包：${sources.bankr.feeRecipientWallet}`);
  }
  if (sources.bankr?.deployerHandle) {
    items.push(`Bankr deployer：${sources.bankr.deployerHandle}`);
  }
  return unique(items);
}

function buildSourceLinks({ row, sources, market }) {
  const context = { row, sources, market };
  const githubRepos = relevantGithubRepos(context);
  const primaryLinks = [
    sources.bankr?.url,
    sources.bankr?.feeRecipientUrl,
    sources.bankr?.deployerUrl,
    sources.bankr?.tweetUrl,
    sources.bankr?.websiteUrl,
    sources.gecko?.url,
    sources.gecko?.virtualsUrl,
    sources.virtuals?.url,
    sources.virtuals?.apiUrl,
    sources.virtuals?.creatorTwitterUrl,
    sources.virtuals?.projectTwitterUrl,
    sources.virtuals?.projectWebsiteUrl,
    sources.virtuals?.videoPitchTweetUrl,
    ...virtualsTeamSourceLinks(sources.virtuals),
    sources.website?.url,
    sources.xProfile?.url,
    sources.projectXProfile?.url,
    sources.github?.user?.url,
    ...githubRepos.map((repo) => repo.url),
    ...githubRepos.map((repo) => repo.homepage),
    ...(market.websites || []).map((item) => item.url),
    ...(market.socials || []).map((item) => item.url),
    market.pairUrl
  ];
  const discoveredLinks = sources.website?.discoveredLinks || [];
  const primarySourceLinks = primaryLinks.map(normalizeSourceLink).filter((url) => isUsefulSourceLink(url, context));
  const discoveredSourceLinks = focusDiscoveredSourceLinks(
    discoveredLinks.map(normalizeSourceLink).filter((url) => isUsefulDiscoveredSourceLink(url, context)),
    context
  );

  return uniqueSourceLinks([...primarySourceLinks, ...discoveredSourceLinks]);
}

function focusDiscoveredSourceLinks(links, context) {
  const normalizedLinks = uniqueSourceLinks(links);
  const hasDocsRoot = normalizedLinks.some((link) => isDocsRootSourceLink(link, context));
  const focused = [];
  let keptDeepDocs = false;

  for (const link of normalizedLinks) {
    if (isProjectRootSourceLink(link, context) || isDocsRootSourceLink(link, context)) {
      focused.push(link);
      continue;
    }

    if (!hasDocsRoot && !keptDeepDocs && isProjectDocsSourceLink(link, context)) {
      focused.push(link);
      keptDeepDocs = true;
      continue;
    }

    if (isAlwaysUsefulDiscoveredLink(link, context)) {
      focused.push(link);
    }
  }

  return focused.slice(0, 5);
}

function uniqueSourceLinks(items) {
  const seen = new Set();
  const links = [];

  for (const item of items) {
    const link = normalizeSourceLink(item);
    const key = sourceLinkKey(link);
    if (!link || !key || seen.has(key)) {
      continue;
    }
    seen.add(key);
    links.push(link);
  }

  return links;
}

function sourceLinkKey(value) {
  const normalized = normalizeSourceLink(value);
  if (!normalized) {
    return null;
  }

  try {
    const url = new URL(normalized);
    url.hash = '';
    url.search = '';
    return url.toString().replace(/\/+$/, '').toLowerCase();
  } catch {
    return normalized.replace(/\/+$/, '').toLowerCase();
  }
}

function normalizeSourceLink(value) {
  const raw = normalizeText(value).trim();
  if (!raw || /["'<>\s]|&quot;|&#/.test(raw)) {
    return null;
  }

  try {
    const url = new URL(raw);
    if (!['http:', 'https:'].includes(url.protocol)) {
      return null;
    }
    url.hash = '';
    url.search = '';
    return url.toString().replace(/\/$/, '');
  } catch {
    return null;
  }
}

function isUsefulSourceLink(value, context = {}) {
  if (!value) {
    return false;
  }

  let url;
  try {
    url = new URL(value);
  } catch {
    return false;
  }

  const host = normalizedHost(url);
  const pathname = url.pathname.toLowerCase();
  const noisyHosts = new Set([
    'api.githubcopilot.com',
    'collector.github.com',
    'github-cloud.s3.amazonaws.com',
    'github.githubassets.com',
    'avatars.githubusercontent.com',
    'raw.githubusercontent.com',
    'objects.githubusercontent.com',
    'opengraph.githubassets.com',
    'fonts.googleapis.com',
    'fonts.gstatic.com',
    'storage.googleapis.com',
    'user-images.githubusercontent.com'
  ]);

  if (noisyHosts.has(host)) {
    return false;
  }
  if (!hasPlausiblePublicHostname(host)) {
    return false;
  }
  if (/^[a-z0-9_-]+\.(?:md|json|ya?ml|toml|txt|lock)$/i.test(host)) {
    return false;
  }
  if (/[\\]|["'<>\s]|&quot;|&#/.test(value)) {
    return false;
  }
  if (/\.(?:css|js|mjs|map|png|jpe?g|gif|svg|webp|ico|mp4|webm|mov|woff2?|ttf|otf|sh|ps1)$/i.test(pathname)) {
    return false;
  }
  if (/\/(?:opengraph-image|twitter-image)$/i.test(pathname)) {
    return false;
  }
  if (host === 'api.github.com' && pathname.startsWith('/_private/')) {
    return false;
  }
  if (host === 'github.com') {
    const parts = url.pathname.split('/').filter(Boolean);
    if (!isUsefulGithubPath(parts, context)) {
      return false;
    }
  }

  return true;
}

function hasPlausiblePublicHostname(host) {
  const labels = normalizeText(host).replace(/^www\./i, '').toLowerCase().split('.').filter(Boolean);
  const tld = labels[labels.length - 1] || '';
  return labels.length >= 2 && /^[a-z]{2,63}$/.test(tld) && !isExecutableLikeTld(tld);
}

function isExecutableLikeTld(tld) {
  return new Set(['exe', 'dll', 'bat', 'cmd', 'msi', 'scr', 'ps1', 'apk', 'dmg', 'pkg', 'deb', 'rpm']).has(
    normalizeText(tld).toLowerCase()
  );
}

function isUsefulDiscoveredSourceLink(value, context = {}) {
  if (!isUsefulSourceLink(value, context)) {
    return false;
  }

  const url = new URL(value);
  const host = normalizedHost(url);
  const pathname = url.pathname.toLowerCase();

  if (host === 'github.com') {
    const parts = url.pathname.split('/').filter(Boolean);
    return parts.length <= 2 && isKnownGithubPath(parts, context);
  }
  if (host === 'x.com' || host === 'twitter.com') {
    const first = pathname.split('/').filter(Boolean)[0];
    const handle = normalizeHandle(first);
    return Boolean(handle) && knownXHandles(context).has(handle.toLowerCase());
  }
  if (host === 'bankr.bot') {
    return pathname.startsWith('/launches/');
  }
  if (host === 'dexscreener.com' || host.endsWith('.dexscreener.com')) {
    return true;
  }
  if (host === 'geckoterminal.com' || host.endsWith('.geckoterminal.com')) {
    return true;
  }
  if (host === 'app.virtuals.io') {
    return pathname.startsWith('/virtuals/') || pathname.startsWith('/prototypes/');
  }

  return isProjectHost(host, context);
}

function isProjectRootSourceLink(value, context = {}) {
  let url;
  try {
    url = new URL(value);
  } catch {
    return false;
  }

  const host = normalizedHost(url);
  const pathname = url.pathname.replace(/\/+$/, '');
  return pathname === '' && isProjectHost(host, context);
}

function isDocsRootSourceLink(value, context = {}) {
  let url;
  try {
    url = new URL(value);
  } catch {
    return false;
  }

  const host = normalizedHost(url);
  const pathname = url.pathname.toLowerCase().replace(/\/+$/, '');
  return (
    isProjectHost(host, context) &&
    (host.startsWith('docs.') || pathname === '/docs' || pathname === '/documentation')
  );
}

function isProjectDocsSourceLink(value, context = {}) {
  let url;
  try {
    url = new URL(value);
  } catch {
    return false;
  }

  const host = normalizedHost(url);
  const pathname = url.pathname.toLowerCase();
  return isProjectHost(host, context) && (host.startsWith('docs.') || pathname.startsWith('/docs/'));
}

function isAlwaysUsefulDiscoveredLink(value, context = {}) {
  let url;
  try {
    url = new URL(value);
  } catch {
    return false;
  }

  const host = normalizedHost(url);
  const pathname = url.pathname.toLowerCase();
  if (host === 'x.com' || host === 'twitter.com') {
    const parts = pathname.split('/').filter(Boolean);
    if (parts.length !== 1) {
      return false;
    }
    const handle = normalizeHandle(parts[0]);
    return Boolean(handle) && knownXHandles(context).has(handle.toLowerCase());
  }
  if (host === 'bankr.bot' || host === 'dexscreener.com' || host.endsWith('.dexscreener.com')) {
    return true;
  }
  return false;
}

function knownXHandles(context = {}) {
  const sources = context.sources || {};
  const virtuals = sources.virtuals || {};
  const bankr = sources.bankr || {};
  const handles = [
    bankr.feeRecipientHandle,
    bankr.deployerHandle,
    extractXHandle(bankr.tweetUrl || ''),
    sources.xProfile?.handle,
    sources.projectXProfile?.handle,
    normalizeHandle(virtuals.feeDelegatedRecipient),
    virtuals.creatorTwitterHandle,
    extractXHandle(virtuals.creatorTwitterUrl || ''),
    virtuals.projectTwitterHandle,
    extractXHandle(virtuals.projectTwitterUrl || ''),
    ...virtualsProjectMembers(virtuals).map((member) => member?.twitterHandle),
    ...virtualsProjectMembers(virtuals).map((member) => extractXHandle(member?.twitterUrl || ''))
  ];

  return new Set(handles.map(normalizeHandle).filter(Boolean).map((handle) => handle.toLowerCase()));
}

function normalizedHost(url) {
  return url.hostname.toLowerCase().replace(/^www\./, '');
}

function normalizedSlug(value) {
  return normalizeLower(value).replace(/[^a-z0-9]+/g, '');
}

function projectSlugs(context) {
  const bankr = context.sources?.bankr || {};
  const row = context.row || {};
  return unique([row.symbol, row.name, bankr.tokenSymbol, bankr.tokenName])
    .map(normalizedSlug)
    .filter((slug) => slug.length >= 4);
}

function primaryProjectHosts(context) {
  const sources = context.sources || {};
  const market = context.market || {};
  return unique([
    sources.bankr?.websiteUrl,
    sources.website?.url,
    sources.virtuals?.url,
    sources.virtuals?.projectWebsiteUrl,
    sources.gecko?.virtualsUrl,
    ...relevantGithubRepos(context).map((repo) => repo.homepage),
    ...(market.websites || []).map((item) => item.url)
  ])
    .map(normalizeSourceLink)
    .filter(Boolean)
    .map((value) => normalizedHost(new URL(value)))
    .filter((host) => !isGenericHost(host));
}

function isProjectHost(host, context) {
  if (primaryProjectHosts(context).some((projectHost) => host === projectHost || host.endsWith(`.${projectHost}`))) {
    return true;
  }

  return projectSlugs(context).some((slug) => normalizedSlug(host).includes(slug));
}

function isGenericHost(host) {
  return new Set([
    'github.com',
    'docs.github.com',
    'github.blog',
    'github.community',
    'support.github.com',
    'youtube.com',
    'youtu.be',
    'privatebin.info',
    'schema.org',
    'slsa.dev'
  ]).has(host);
}

function isUsefulGithubPath(parts, context) {
  if (!parts.length) {
    return false;
  }
  if (parts[1]?.toLowerCase().endsWith('.git')) {
    return false;
  }
  if (isKnownGithubPath(parts, context)) {
    return true;
  }
  const reserved = new Set([
    'account',
    'apps',
    'assets',
    'blog',
    'business',
    'collections',
    'customer-stories',
    'enterprise',
    'events',
    'explore',
    'features',
    'gist',
    'github',
    'login',
    'marketplace',
    'new',
    'notifications',
    'organizations',
    'orgs',
    'partners',
    'pricing',
    'pulls',
    'resources',
    'search',
    'security',
    'settings',
    'sponsors',
    'topics',
    'trending',
    'users',
    'why-github'
  ]);
  return parts.length <= 2 && !reserved.has(parts[0].toLowerCase());
}

function relevantGithubRepos(context) {
  const sources = context.sources || {};
  return (sources.github?.repos || []).filter((repo) => isCurrentTokenGithubRepo(repo, context));
}

function isCurrentTokenGithubRepo(repo, context) {
  if (!repo) {
    return false;
  }

  const repoKey = githubRepoKeyFromRepo(repo);
  if (repoKey && knownGithubRepoKeys(context).includes(repoKey)) {
    return true;
  }

  const repoName = normalizedSlug(repo.name);
  return projectSlugs(context).some((slug) => repoName === slug);
}

function githubRepoKeyFromRepo(repo) {
  const fullName = normalizeText(repo?.fullName).split('/').filter(Boolean).slice(0, 2);
  if (fullName.length === 2) {
    return fullName.map(normalizedSlug).join('/');
  }

  const urlParts = extractGithubPathParts(repo?.url).slice(0, 2);
  return urlParts.length === 2 ? urlParts.map(normalizedSlug).join('/') : null;
}

function knownGithubRepoKeys(context) {
  const sources = context.sources || {};
  const market = context.market || {};
  return unique([
    extractGithubPathParts(sources.website?.url).slice(0, 2).join('/'),
    extractGithubPathParts(sources.bankr?.websiteUrl).slice(0, 2).join('/'),
    ...(market.websites || []).map((item) => extractGithubPathParts(item.url).slice(0, 2).join('/'))
  ])
    .filter((item) => item.split('/').filter(Boolean).length === 2)
    .map((item) => item.split('/').map(normalizedSlug).join('/'));
}

function isKnownGithubPath(parts, context) {
  if (!parts.length) {
    return false;
  }
  const sources = context.sources || {};
  const knownUsers = unique([
    sources.github?.user?.login,
    ...extractGithubPathParts(sources.website?.url).slice(0, 1),
    ...extractGithubPathParts(sources.bankr?.websiteUrl).slice(0, 1),
    ...virtualsProjectMembers(sources.virtuals).map((member) => member?.githubUsername),
    ...virtualsProjectMembers(sources.virtuals).flatMap((member) => extractGithubPathParts(member?.githubUrl).slice(0, 1))
  ]).map(normalizedSlug);
  const knownRepos = knownGithubRepoKeys(context);
  const user = normalizedSlug(parts[0]);
  const repo = parts[1] ? normalizedSlug(parts[1].replace(/\.git$/i, '')) : null;

  if (repo && knownRepos.includes(`${user}/${repo}`)) {
    return true;
  }
  return !repo && knownUsers.includes(user);
}

function extractGithubPathParts(value) {
  const normalized = normalizeSourceLink(value);
  if (!normalized) {
    return [];
  }
  try {
    const url = new URL(normalized);
    return normalizedHost(url) === 'github.com' ? url.pathname.split('/').filter(Boolean) : [];
  } catch {
    return [];
  }
}

export function buildCoinProfile({ row, market, sources = {} }) {
  const websiteText = sources.website?.markdown || '';
  const xBioText = uniqueCleanText([
    sources.xProfile?.bio,
    sources.xProfile?.markdown,
    sources.projectXProfile?.bio,
    sources.projectXProfile?.markdown
  ]).join(' ');
  const narrative = describeNarrative({ row, websiteText, xBioText, market, sources });
  const dev = describeDev({ row, market, sources, narrative });
  const sourceLinks = buildSourceLinks({ row, sources, market });
  const evidence = unique([...buildEvidence({ sources, market }), ...(dev.evidence || [])]);

  return {
    address: row.address,
    symbol: row.symbol,
    name: row.name,
    market: {
      priceUsd: market.priceUsd ?? row.priceUsd ?? null,
      marketCapUsd: market.marketCapUsd ?? row.marketCapUsd ?? null,
      liquidityUsd: market.liquidityUsd ?? row.liquidityUsd ?? null,
      volume24h: market.volume24h ?? row.volume24h ?? null,
      pairUrl: market.pairUrl || null
    },
    bankr: sources.bankr || null,
    narrative,
    dev,
    evidence,
    sourceLinks
  };
}
