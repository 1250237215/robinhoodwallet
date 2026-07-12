import {
  parseBankrLaunchApi,
  parseBankrLaunchMarkdown,
  parseXInitialStateHtml,
  parseXProfileMarkdown
} from './profileBuilder.js';

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

function asArray(value) {
  return Array.isArray(value) ? value : [];
}

function unique(items) {
  return [...new Set(items.filter(Boolean))];
}

function jinaUrl(url) {
  const text = normalizeText(url).trim();
  return `https://r.jina.ai/http://${text.replace(/^https?:\/\//i, '')}`;
}

async function fetchText(url, headers = {}) {
  const response = await fetch(url, {
    headers: {
      accept: 'text/plain, text/html, application/json',
      'user-agent':
        'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/148 Safari/537.36',
      ...headers
    },
    signal: AbortSignal.timeout(15000)
  });

  if (!response.ok) {
    throw new Error(`Request failed with HTTP ${response.status}`);
  }

  return response.text();
}

async function fetchJson(url) {
  const response = await fetch(url, {
    headers: {
      accept: 'application/json',
      'user-agent':
        'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/148 Safari/537.36'
    },
    signal: AbortSignal.timeout(15000)
  });

  if (!response.ok) {
    throw new Error(`Request failed with HTTP ${response.status}`);
  }

  return response.json();
}

function extractHandles(text) {
  return unique(
    [...normalizeText(text).matchAll(/@[A-Za-z0-9_]{2,20}/g)]
      .map((match) => match[0])
      .filter((handle) => handle !== '@x' && handle !== '@X')
  );
}

function discoverLinks(html) {
  return unique(
    [...normalizeText(html).matchAll(/https:\/\/[^"'`\s<>)\]}]+/g)].map((match) => match[0])
  );
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

function attributeValue(tag, name) {
  const match = normalizeText(tag).match(new RegExp(`${name}=["']([^"']+)["']`, 'i'));
  return match ? decodeHtmlEntities(match[1]).trim() : null;
}

export function parseHtmlMetadata(html) {
  const text = normalizeText(html);
  const title = decodeHtmlEntities(text.match(/<title[^>]*>([\s\S]*?)<\/title>/i)?.[1] || '').trim() || null;
  const metaTags = [...text.matchAll(/<meta\b[^>]*>/gi)].map((match) => match[0]);
  const descriptionTag = metaTags.find((tag) => {
    const name = attributeValue(tag, 'name') || attributeValue(tag, 'property');
    return /^(description|og:description|twitter:description)$/i.test(name || '');
  });
  const description = descriptionTag ? attributeValue(descriptionTag, 'content') : null;
  const markdown = [
    title ? `Title: ${title}` : null,
    description ? `Markdown Content:\n${description}` : null
  ]
    .filter(Boolean)
    .join('\n\n');

  return {
    title,
    description,
    markdown
  };
}

function parseJinaTitle(markdown) {
  return normalizeText(markdown).match(/^Title:\s+(.+)$/m)?.[1]?.trim() || null;
}

function parseJinaSourceUrl(markdown) {
  return normalizeText(markdown).match(/^URL Source:\s+(.+)$/m)?.[1]?.trim() || null;
}

function xUrlForHandle(handle) {
  const username = normalizeText(handle).trim().replace(/^@/, '');
  return /^[A-Za-z0-9_]{2,20}$/.test(username) ? `https://x.com/${username}` : null;
}

function normalizeHandle(value) {
  const raw = normalizeText(value).trim().replace(/^@/, '');
  return /^[A-Za-z0-9_]{2,20}$/.test(raw) ? `@${raw}` : null;
}

function normalizeAddress(value) {
  return normalizeText(value).match(/0x[a-fA-F0-9]{40}/)?.[0]?.toLowerCase() || null;
}

function normalizePublicHttpUrl(value) {
  const text = normalizeText(value).trim();
  if (!/^https?:\/\//i.test(text)) {
    return null;
  }

  try {
    const url = new URL(text);
    if (!['http:', 'https:'].includes(url.protocol)) {
      return null;
    }
    return url.toString();
  } catch {
    return null;
  }
}

export function normalizeXProfileUrl(value) {
  const reservedPaths = new Set([
    'compose',
    'explore',
    'hashtag',
    'home',
    'i',
    'intent',
    'messages',
    'notifications',
    'search',
    'settings',
    'share'
  ]);
  const text = normalizeText(value).trim();
  const handleUrl = xUrlForHandle(text);
  if (handleUrl) {
    return handleUrl;
  }

  let url;
  try {
    url = new URL(text);
  } catch {
    return null;
  }

  const host = url.hostname.replace(/^www\./i, '').toLowerCase();
  if (host !== 'x.com' && host !== 'twitter.com') {
    return null;
  }

  const username = url.pathname
    .split('/')
    .filter(Boolean)
    .find(Boolean);
  if (!username || reservedPaths.has(username.toLowerCase())) {
    return null;
  }
  return xUrlForHandle(username);
}

function extractXHandleFromUrl(value) {
  const url = normalizeXProfileUrl(value);
  if (!url) {
    return null;
  }
  try {
    return normalizeHandle(new URL(url).pathname.split('/').filter(Boolean)[0]);
  } catch {
    return null;
  }
}

function normalizeTelegramUrl(value) {
  const text = normalizeText(value).trim();
  const username = text.match(/(?:https?:\/\/)?(?:t\.me|telegram\.me)\/([A-Za-z0-9_]{2,32})(?:[/?#\s)]|$)/i)?.[1];
  return username ? `https://t.me/${username}` : null;
}

function normalizeTelegramHandle(value) {
  const raw =
    normalizeText(value)
      .trim()
      .match(/(?:https?:\/\/)?(?:t\.me|telegram\.me)\/([A-Za-z0-9_]{2,32})(?:[/?#\s)]|$)/i)?.[1] ||
    normalizeText(value).trim().replace(/^@/, '');
  return /^[A-Za-z0-9_]{2,32}$/.test(raw) ? `@${raw}` : null;
}

function extractVirtualsId(value) {
  const match = normalizeText(value).match(/app\.virtuals\.io\/virtuals\/(\d+)/i);
  return match ? safeNumber(match[1]) : null;
}

function extractVirtualsPrototypeAddress(value) {
  const match = normalizeText(value).match(/app\.virtuals\.io\/prototypes\/(0x[a-fA-F0-9]{40})/i);
  return match ? normalizeAddress(match[1]) : null;
}

function firstVirtualsUrl(items) {
  return asArray(items).find((url) => extractVirtualsId(url) || extractVirtualsPrototypeAddress(url)) || null;
}

function normalizedSlug(value) {
  return normalizeText(value).toLowerCase().replace(/[^a-z0-9]+/g, '');
}

function isAssetUrl(url) {
  const pathname = url.pathname.toLowerCase();
  return /\.(?:css|js|mjs|map|png|jpe?g|gif|svg|webp|ico|mp4|webm|mov|woff2?|ttf|otf)$/i.test(pathname);
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

export function extractProjectWebsiteCandidates(text) {
  const blockedHosts = new Set([
    'abs.twimg.com',
    'bankr.bot',
    'basescan.org',
    'dexscreener.com',
    'geckoterminal.com',
    'github.com',
    'pbs.twimg.com',
    'video.twimg.com',
    't.co',
    'twitter.com',
    'virtuals.io',
    'x.com'
  ]);

  const candidates = [
    ...normalizeText(text).matchAll(/https?:\/\/[^\s<>"')\]}]+/gi),
    ...normalizeText(text).matchAll(/(?:^|[\s([<{])([A-Za-z0-9-]+(?:\.[A-Za-z0-9-]+)+)(?:[/?#][^\s<>"')\]}]*)?/g)
  ]
    .map((match) => match[0].trim().replace(/^[\s([<{]+/, ''))
    .map((value) => (/^https?:\/\//i.test(value) ? value : `https://${value}`));

  return unique(
    candidates.filter((candidate) => {
      try {
        const url = new URL(candidate);
        const host = url.hostname.replace(/^www\./i, '').toLowerCase();
        if (!hasPlausiblePublicHostname(host)) {
          return false;
        }
        if (/^[a-z0-9_-]+\.(?:md|json|ya?ml|toml|txt|lock)$/i.test(host)) {
          return false;
        }
        if (blockedHosts.has(host)) {
          return false;
        }
        if ([...blockedHosts].some((blocked) => host.endsWith(`.${blocked}`))) {
          return false;
        }
        return !isAssetUrl(url);
      } catch {
        return false;
      }
    })
  );
}

export function extractProjectXHandles(row, text, primaryHandle = null) {
  const primary = normalizeHandle(primaryHandle);
  const projectSlugs = unique([row?.symbol, row?.name])
    .map(normalizedSlug)
    .filter((slug) => slug.length >= 3);

  return unique(
    extractHandles(text)
      .map(normalizeHandle)
      .filter(Boolean)
      .filter((handle) => handle !== primary)
      .filter((handle) => {
        const slug = normalizedSlug(handle);
        return projectSlugs.some((projectSlug) => slug === projectSlug || slug.startsWith(projectSlug));
      })
  );
}

export function parseGeckoTokenInfoPayload(payload) {
  const attributes = payload?.data?.attributes || null;
  if (!attributes || typeof attributes !== 'object') {
    return null;
  }

  const websites = asArray(attributes.websites).filter(Boolean);
  const virtualsUrl = firstVirtualsUrl(websites);

  return {
    tokenAddress: normalizeAddress(attributes.address),
    name: attributes.name || null,
    symbol: attributes.symbol || null,
    imageUrl: attributes.image_url || attributes.image?.large || attributes.image?.small || attributes.image?.thumb || null,
    websites,
    description: attributes.description || null,
    categories: asArray(attributes.categories).filter(Boolean),
    categoryIds: asArray(attributes.gt_category_ids).filter(Boolean),
    holderCount: safeNumber(attributes.holders?.count),
    top10HolderPercentage: safeNumber(attributes.holders?.distribution_percentage?.top_10),
    isHoneypot: attributes.is_honeypot ?? null,
    gtScore: safeNumber(attributes.gt_score),
    gtVerified: attributes.gt_verified ?? null,
    virtualsUrl,
    virtualsId: extractVirtualsId(virtualsUrl)
  };
}

export function parseVirtualsPayload(payload, address = null) {
  const candidates = Array.isArray(payload?.data) ? payload.data : [payload?.data || payload].filter(Boolean);
  const normalizedAddress = normalizeAddress(address);
  const item =
    candidates.find((candidate) => normalizeAddress(candidate?.tokenAddress) === normalizedAddress) ||
    candidates.find((candidate) => candidate?.id) ||
    null;

  if (!item || typeof item !== 'object') {
    return null;
  }

  const creatorTwitterUrl =
    normalizeXProfileUrl(item.creator?.socials?.VERIFIED_LINKS?.TWITTER) ||
    xUrlForHandle(item.creator?.socials?.VERIFIED_USERNAMES?.TWITTER);
  const creatorTwitterHandle =
    normalizeHandle(item.creator?.socials?.VERIFIED_USERNAMES?.TWITTER) ||
    normalizeHandle(item.creator?.socials?.VERIFIED_LINKS?.TWITTER);
  const projectTwitterUrl =
    normalizeXProfileUrl(item.socials?.VERIFIED_LINKS?.TWITTER) ||
    xUrlForHandle(item.socials?.VERIFIED_USERNAMES?.TWITTER);
  const projectTwitterHandle =
    normalizeHandle(item.socials?.VERIFIED_USERNAMES?.TWITTER) ||
    extractXHandleFromUrl(item.socials?.VERIFIED_LINKS?.TWITTER);

  return {
    url: item.id ? `https://app.virtuals.io/virtuals/${item.id}` : null,
    id: safeNumber(item.id),
    name: item.name || null,
    symbol: item.symbol || null,
    description: item.description || null,
    category: item.category || null,
    tokenAddress: normalizeAddress(item.tokenAddress),
    lpAddress: item.lpAddress || null,
    holderCount: safeNumber(item.holderCount),
    top10HolderPercentage: safeNumber(item.top10HolderPercentage),
    priceChangePercent24h: safeNumber(item.priceChangePercent24h),
    volume24h: safeNumber(item.volume24h),
    liquidityUsd: safeNumber(item.liquidityUsd),
    isVerified: item.isVerified ?? null,
    isDevCommitted: item.isDevCommitted ?? null,
    factory: item.factory || null,
    launchedAt: item.launchedAt || null,
    virtualsWalletAddress: normalizeAddress(item.walletAddress),
    taxRecipient: item.taxRecipient || null,
    overview: item.overview || null,
    tokenUtility: item.tokenUtility || null,
    roadmap: item.roadmap || null,
    additionalDetails: item.additionalDetails || null,
    projectTwitterUrl,
    projectTwitterHandle,
    projectWebsiteUrl: normalizePublicHttpUrl(item.socials?.VERIFIED_LINKS?.WEBSITE),
    videoPitchTweetUrl: normalizePublicHttpUrl(item.socials?.VIDEO_PITCH?.TWEET_URL),
    creatorTwitterUrl,
    creatorTwitterHandle,
    projectMembers: parseVirtualsProjectMembers(item.projectMembers),
    feeDelegationType: item.launchInfo?.feeDelegationType || null,
    feeDelegatedRecipient: item.launchInfo?.feeDelegatedRecipient || null,
    feeDelegationVaultAddress: normalizeAddress(item.launchInfo?.feeDelegationVaultAddress),
    feeDelegationClaimed: item.launchInfo?.feeDelegationClaimed ?? null
  };
}

function parseVirtualsProjectMembers(items) {
  return asArray(items)
    .map((member) => {
      const user = member?.user || {};
      const bio = normalizeText(user.bio).trim() || null;
      const title = normalizeText(member?.title).trim() || null;
      const socials = user.socials || {};
      const twitterUrl =
        normalizeXProfileUrl(socials.VERIFIED_LINKS?.TWITTER) ||
        xUrlForHandle(socials.VERIFIED_USERNAMES?.TWITTER);
      const twitterHandle =
        normalizeHandle(socials.VERIFIED_USERNAMES?.TWITTER) ||
        extractXHandleFromUrl(socials.VERIFIED_LINKS?.TWITTER);
      const telegramUrl = normalizeTelegramUrl(socials.VERIFIED_LINKS?.TELEGRAM);
      const telegramHandle =
        normalizeTelegramHandle(socials.VERIFIED_USERNAMES?.TELEGRAM) ||
        normalizeTelegramHandle(socials.VERIFIED_LINKS?.TELEGRAM);
      const githubUsername =
        extractGithubUsernames([bio, socials.VERIFIED_LINKS?.GITHUB, socials.VERIFIED_USERNAMES?.GITHUB].join(' '))[0] ||
        normalizeGithubUsername(socials.VERIFIED_USERNAMES?.GITHUB) ||
        null;
      const displayName = inferVirtualsMemberName({ title, bio });

      if (!title && !bio && !twitterHandle && !telegramHandle && !githubUsername) {
        return null;
      }

      return {
        title,
        displayName,
        bio,
        twitterUrl,
        twitterHandle,
        telegramUrl,
        telegramHandle,
        githubUrl: githubUsername ? `https://github.com/${githubUsername}` : null,
        githubUsername
      };
    })
    .filter(Boolean);
}

function inferVirtualsMemberName({ title, bio }) {
  const firstBioLine =
    normalizeText(bio)
      .split(/\r?\n/)
      .map((line) => line.trim())
      .find(Boolean) || null;
  const titlePrefix = normalizeText(title).split('(')[0].trim();
  const rolePattern = /\b(?:founder|co-founder|ceo|cto|cfo|coo|chief|lead|head|developer|engineer|partnerships|gtm)\b/i;

  if (firstBioLine && !rolePattern.test(firstBioLine)) {
    return firstBioLine;
  }
  if (titlePrefix && !rolePattern.test(titlePrefix)) {
    return titlePrefix;
  }
  return title || firstBioLine || null;
}

export function parseVirtualsPrototypeMarkdown(markdown, address = null) {
  const text = normalizeText(markdown);
  const normalizedAddress = normalizeAddress(address) || extractVirtualsPrototypeAddress(text);
  if (!normalizedAddress) {
    return null;
  }

  const sourceUrl = parseJinaSourceUrl(text);
  const prototypeAddress = extractVirtualsPrototypeAddress(sourceUrl || text) || normalizedAddress;
  if (prototypeAddress !== normalizedAddress) {
    return null;
  }

  const lines = text
    .split('\n')
    .map((line) => line.trim())
    .filter(Boolean);
  const title = parseJinaTitle(text) || '';
  const heading = lines.find((line) => /^#\s+/.test(line))?.replace(/^#+\s+/, '').trim() || title;
  const symbolFromTicker = lines
    .map((line) => line.match(/^\$([A-Za-z0-9_.$-]{2,32})$/)?.[1]?.replace(/^\$/, ''))
    .find(Boolean);
  const symbolFromHeading = heading.match(/^([A-Za-z0-9_.$-]{2,32})\s+\$/)?.[1] || null;
  const symbol = symbolFromTicker || symbolFromHeading || null;
  const name =
    lines.find((line) => {
      const cleaned = line.replace(/^#+\s+/, '').trim();
      return symbol && cleaned.toLowerCase() === symbol.toLowerCase();
    }) ||
    symbol ||
    null;
  const delegateIndex = lines.findIndex((line) => /^delegate to:?$/i.test(line));
  const delegateBlock = delegateIndex >= 0 ? lines.slice(delegateIndex + 1, delegateIndex + 7).join(' ') : '';
  const delegateUrlHandle = delegateBlock.match(/(?:https?:\/\/)?(?:www\.)?(?:x|twitter)\.com\/([A-Za-z0-9_]{2,20})(?:[/?#\s)]|$)/i)?.[1];
  const delegateHandle = normalizeHandle(delegateUrlHandle) || extractHandles(delegateBlock).map(normalizeHandle).find(Boolean);
  const delegateUrl = xUrlForHandle(delegateHandle);

  if (!delegateHandle && !symbol) {
    return null;
  }

  return {
    url: `https://app.virtuals.io/prototypes/${prototypeAddress}`,
    prototypeAddress,
    tokenAddress: prototypeAddress,
    name,
    symbol,
    description: heading || null,
    category: 'PROTOTYPE',
    creatorTwitterUrl: delegateUrl,
    creatorTwitterHandle: delegateHandle,
    feeDelegationType: delegateHandle ? 'twitter' : null,
    feeDelegatedRecipient: delegateHandle ? delegateHandle.slice(1) : null,
    feeDelegationVaultAddress: null,
    feeDelegationClaimed: null
  };
}

function normalizeGithubUsername(value) {
  const username = normalizeText(value).trim().replace(/^@/, '');
  if (!/^[A-Za-z0-9](?:[A-Za-z0-9-]{0,37}[A-Za-z0-9])?$/.test(username)) {
    return null;
  }
  return username;
}

export function extractGithubUsernames(text) {
  const reservedPaths = new Set([
    'about',
    'apps',
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
    'pricing',
    'pulls',
    'search',
    'settings',
    'sponsors',
    'topics',
    'trending',
    'users'
  ]);

  return unique(
    [...normalizeText(text).matchAll(/(?:https?:\/\/)?(?:www\.)?github\.com\/([A-Za-z0-9-]{1,39})(?=[/?#\s)]|$)/gi)]
      .map((match) => normalizeGithubUsername(match[1]))
      .filter((username) => username && !reservedPaths.has(username.toLowerCase()))
  );
}

function githubRepoPartsFromUrl(value) {
  const text = normalizeText(value).trim();
  let url;
  try {
    url = new URL(text);
  } catch {
    return [];
  }

  const host = url.hostname.replace(/^www\./i, '').toLowerCase();
  if (host !== 'github.com') {
    return [];
  }

  const parts = url.pathname.split('/').filter(Boolean);
  const owner = normalizeGithubUsername(parts[0]);
  const repo = parts[1]?.replace(/\.git$/i, '') || null;
  if (!owner || !repo || !/^[A-Za-z0-9._-]{1,100}$/.test(repo)) {
    return [];
  }
  return [owner, repo];
}

export function parseGithubRepoMarkdown(markdown) {
  const text = normalizeText(markdown);
  const sourceUrl = parseJinaSourceUrl(text);
  const [owner, repo] = githubRepoPartsFromUrl(sourceUrl || '');
  if (!owner || !repo) {
    return null;
  }

  const title = parseJinaTitle(text) || '';
  const titleDescription =
    title.match(/^GitHub\s+-\s+[^:]+:\s+(.+)$/i)?.[1]?.trim() ||
    title.match(/^([^:]+)$/)?.[1]?.trim() ||
    null;
  const fullName = `${owner}/${repo}`;

  return {
    user: {
      login: owner,
      name: null,
      bio: null,
      company: null,
      followers: null,
      publicRepos: null,
      url: `https://github.com/${owner}`
    },
    repos: [
      {
        name: repo,
        fullName,
        description: titleDescription,
        stars: null,
        forks: null,
        language: null,
        url: `https://github.com/${fullName}`,
        homepage: null,
        updatedAt: null
      }
    ],
    topRepoReadme: text
  };
}

function mergeDefined(...objects) {
  const result = {};
  for (const object of objects) {
    for (const [key, value] of Object.entries(object || {})) {
      if (value !== null && value !== undefined && value !== '') {
        result[key] = value;
      }
    }
  }
  return result;
}

export async function fetchWebsiteSource(url) {
  const [html, markdown] = await Promise.all([
    fetchText(url).catch(() => ''),
    fetchText(jinaUrl(url)).catch(() => '')
  ]);
  const htmlMetadata = parseHtmlMetadata(html);
  const resolvedMarkdown = markdown || htmlMetadata.markdown;

  return {
    url,
    title: parseJinaTitle(resolvedMarkdown) || htmlMetadata.title,
    markdown: resolvedMarkdown,
    discoveredLinks: discoverLinks(html)
  };
}

export async function fetchXProfileSource(url) {
  const [markdown, html] = await Promise.all([
    fetchText(jinaUrl(url)).catch(() => ''),
    fetchText(url).catch(() => '')
  ]);
  const markdownFacts = markdown ? parseXProfileMarkdown(markdown) : {};
  const htmlFacts = parseXInitialStateHtml(html);
  const combinedMarkdown = unique([markdown, htmlFacts.markdown]).join('\n\n');
  const mergedFacts = mergeDefined(markdownFacts, htmlFacts);

  if (htmlFacts.handle) {
    return {
      url,
      html,
      ...mergedFacts,
      markdown: combinedMarkdown
    };
  }

  if (!markdown) {
    return null;
  }

  return {
    url,
    markdown,
    ...markdownFacts
  };
}

export async function fetchBankrSource(address) {
  const url = `https://bankr.bot/launches/${address}`;
  const apiUrl = `https://api.bankr.bot/token-launches/${address}`;
  const [markdown, apiPayload] = await Promise.all([
    fetchText(jinaUrl(url)).catch(() => ''),
    fetchJson(apiUrl).catch(() => null)
  ]);

  const parsed = mergeDefined(parseBankrLaunchMarkdown(markdown), parseBankrLaunchApi(apiPayload));
  if (!parsed.feeRecipientWallet && !parsed.feeRecipientHandle && !parsed.tokenName) {
    return null;
  }

  return {
    url,
    apiUrl,
    markdown,
    api: apiPayload,
    ...parsed
  };
}

export async function fetchGeckoTokenInfo(address) {
  const normalizedAddress = normalizeAddress(address);
  if (!normalizedAddress) {
    return null;
  }

  const url = `https://api.geckoterminal.com/api/v2/networks/base/tokens/${normalizedAddress}/info`;
  const payload = await fetchJson(url).catch(() => null);
  const parsed = parseGeckoTokenInfoPayload(payload);
  if (!parsed?.tokenAddress && !parsed?.categories?.length && !parsed?.websites?.length) {
    return null;
  }

  return {
    url,
    ...parsed
  };
}

function primaryVirtualsMemberXUrl(virtuals) {
  const members = asArray(virtuals?.projectMembers);
  const founder =
    members.find((member) => member?.twitterUrl && /founder|co-founder|ceo|cto/i.test([member.title, member.bio].join(' '))) ||
    null;
  return founder?.twitterUrl || members.find((member) => member?.twitterUrl)?.twitterUrl || null;
}

async function fetchVirtualsSourceByToken(address) {
  const normalizedAddress = normalizeAddress(address);
  if (!normalizedAddress) {
    return null;
  }

  const apiUrl = `https://api2.virtuals.io/api/virtuals?filters%5BtokenAddress%5D%5B%24eqi%5D=${normalizedAddress}&populate=image,tags,framework,genesis,vibesInfo,launchInfo,creator,projectMembers,projectMembers.user`;
  const payload = await fetchJson(apiUrl).catch(() => null);
  const parsed = parseVirtualsPayload(payload, normalizedAddress);
  if (!parsed?.id) {
    return null;
  }

  return {
    apiUrl,
    ...parsed
  };
}

async function fetchVirtualsSourceById(id, address = null) {
  const virtualsId = safeNumber(id);
  if (!virtualsId) {
    return null;
  }

  const apiUrl = `https://api2.virtuals.io/api/virtuals/${virtualsId}?populate=genesis,vibesInfo,launchInfo,creator,image,tags,framework,projectMembers,projectMembers.user`;
  const payload = await fetchJson(apiUrl).catch(() => null);
  const parsed = parseVirtualsPayload(payload, address);
  if (!parsed?.id) {
    return null;
  }

  return {
    apiUrl,
    ...parsed
  };
}

async function fetchVirtualsPrototypeSource(address) {
  const normalizedAddress = normalizeAddress(address);
  if (!normalizedAddress) {
    return null;
  }

  const url = `https://app.virtuals.io/prototypes/${normalizedAddress}`;
  const markdown = await fetchText(jinaUrl(url)).catch(() => '');
  const parsed = parseVirtualsPrototypeMarkdown(markdown, normalizedAddress);
  if (!parsed?.prototypeAddress) {
    return null;
  }

  return {
    markdown,
    ...parsed
  };
}

function mergeVirtualsSources(primary, detail) {
  if (!primary) {
    return detail || null;
  }
  if (!detail) {
    return primary;
  }

  const merged = mergeDefined(primary, detail);
  const primaryMembers = asArray(primary.projectMembers);
  const detailMembers = asArray(detail.projectMembers);

  return {
    ...merged,
    projectMembers: detailMembers.length ? detailMembers : primaryMembers
  };
}

export async function fetchVirtualsSource(address, gecko = null) {
  const byToken = await fetchVirtualsSourceByToken(address);
  if (byToken) {
    const byTokenDetail = await fetchVirtualsSourceById(byToken.id, address).catch(() => null);
    return mergeVirtualsSources(byToken, byTokenDetail);
  }

  const byId = await fetchVirtualsSourceById(gecko?.virtualsId, address);
  if (byId) {
    return byId;
  }

  return fetchVirtualsPrototypeSource(address);
}

export async function fetchGithubSource(handleOrUsername) {
  const username = normalizeGithubUsername(handleOrUsername);
  if (!username) {
    return null;
  }

  const userPayload = await fetchJson(`https://api.github.com/users/${username}`).catch(() => null);
  if (!userPayload?.login) {
    return null;
  }

  const repoPayload = await fetchJson(
    `https://api.github.com/users/${userPayload.login}/repos?sort=updated&per_page=30`
  ).catch(() => []);
  const repos = (Array.isArray(repoPayload) ? repoPayload : [])
    .map((repo) => ({
      name: repo.name || null,
      fullName: repo.full_name || null,
      description: repo.description || null,
      stars: repo.stargazers_count ?? null,
      forks: repo.forks_count ?? null,
      language: repo.language || null,
      url: repo.html_url || null,
      homepage: repo.homepage || null,
      updatedAt: repo.updated_at || null
    }))
    .filter((repo) => repo.name && repo.fullName);

  const topRepo = [...repos].sort((left, right) => (right.stars || 0) - (left.stars || 0))[0] || null;
  const topRepoReadme = topRepo?.fullName
    ? await fetchText(`https://api.github.com/repos/${topRepo.fullName}/readme`, {
        accept: 'application/vnd.github.raw'
      }).catch(() => '')
    : '';

  return {
    user: {
      login: userPayload.login,
      name: userPayload.name || null,
      bio: userPayload.bio || null,
      company: userPayload.company || null,
      followers: userPayload.followers ?? null,
      publicRepos: userPayload.public_repos ?? null,
      url: userPayload.html_url || `https://github.com/${userPayload.login}`
    },
    repos,
    topRepoReadme
  };
}

async function fetchGithubRepoSource(url, markdown = '') {
  const [owner, repo] = githubRepoPartsFromUrl(url);
  if (!owner || !repo) {
    return null;
  }

  const sourceMarkdown = markdown || (await fetchText(jinaUrl(`https://github.com/${owner}/${repo}`)).catch(() => ''));
  return parseGithubRepoMarkdown(sourceMarkdown);
}

async function searchWalletOwner(wallet) {
  const queryUrl = `https://x.com/search?q=${encodeURIComponent(wallet)}&src=typed_query`;
  const markdown = await fetchText(jinaUrl(queryUrl)).catch(() => '');
  const handles = extractHandles(markdown);
  const matchedHandle = handles.length === 1 ? handles[0] : null;

  return {
    queryUrl,
    matchedHandle,
    status: matchedHandle ? 'matched' : 'unresolved'
  };
}

export async function resolveTokenSources(row, market) {
  const marketWebsiteUrl = market.websites?.[0]?.url || null;
  const marketXUrl = normalizeXProfileUrl(
    market.socials?.find((item) => item.type === 'twitter' || item.type === 'x')?.url || null
  );

  const [bankr, marketWebsite, gecko] = await Promise.all([
    fetchBankrSource(row.address).catch(() => null),
    marketWebsiteUrl ? fetchWebsiteSource(marketWebsiteUrl).catch(() => null) : Promise.resolve(null),
    fetchGeckoTokenInfo(row.address).catch(() => null)
  ]);

  const isVirtualsCandidate =
    gecko?.virtualsId ||
    gecko?.categoryIds?.includes('virtuals-protocol') ||
    extractVirtualsPrototypeAddress(gecko?.virtualsUrl) ||
    normalizeText(market.quoteTokenSymbol).toUpperCase() === 'VIRTUAL' ||
    normalizeText(market.quoteTokenName).toLowerCase().includes('virtual protocol');
  const virtuals = isVirtualsCandidate
    ? await fetchVirtualsSource(row.address, gecko).catch(() => null)
    : await fetchVirtualsPrototypeSource(row.address).catch(() => null);
  const bankrWebsiteUrl = bankr?.websiteUrl || null;
  const virtualsWebsiteUrl = virtuals?.projectWebsiteUrl || null;
  const bankrWebsite =
    bankrWebsiteUrl && bankrWebsiteUrl !== marketWebsiteUrl
      ? await fetchWebsiteSource(bankrWebsiteUrl).catch(() => null)
      : null;
  const virtualsWebsite =
    virtualsWebsiteUrl && virtualsWebsiteUrl !== bankrWebsiteUrl && virtualsWebsiteUrl !== marketWebsiteUrl
      ? await fetchWebsiteSource(virtualsWebsiteUrl).catch(() => null)
      : null;
  let website = bankrWebsite || marketWebsite || virtualsWebsite;
  const bankrXUrl = normalizeXProfileUrl(bankr?.feeRecipientUrl || xUrlForHandle(bankr?.feeRecipientHandle));
  const virtualsXUrl = normalizeXProfileUrl(
    virtuals?.creatorTwitterUrl || xUrlForHandle(virtuals?.feeDelegatedRecipient)
  );
  const virtualsTeamXUrl = primaryVirtualsMemberXUrl(virtuals);
  const virtualsProjectXUrl = normalizeXProfileUrl(virtuals?.projectTwitterUrl);
  const xProfileUrl = bankrXUrl || virtualsXUrl || virtualsTeamXUrl || virtualsProjectXUrl || marketXUrl;
  let xProfile = xProfileUrl ? await fetchXProfileSource(xProfileUrl).catch(() => null) : null;
  const resolvedXProfile =
    xProfile ||
    (bankr?.feeRecipientHandle ? { url: bankrXUrl, handle: bankr.feeRecipientHandle } : null) ||
    (virtuals?.creatorTwitterHandle
      ? { url: virtuals.creatorTwitterUrl, handle: virtuals.creatorTwitterHandle }
      : null) ||
    (virtuals?.feeDelegatedRecipient
      ? {
          url: xUrlForHandle(virtuals.feeDelegatedRecipient),
          handle: normalizeHandle(virtuals.feeDelegatedRecipient)
        }
      : null) ||
    (virtualsTeamXUrl
      ? {
          url: virtualsTeamXUrl,
          handle: extractXHandleFromUrl(virtualsTeamXUrl)
        }
      : null) ||
    (virtualsProjectXUrl
      ? {
          url: virtualsProjectXUrl,
          handle: extractXHandleFromUrl(virtualsProjectXUrl)
        }
      : null);
  const [projectXHandle] = resolvedXProfile
    ? extractProjectXHandles(
        row,
        [resolvedXProfile.markdown, resolvedXProfile.bio].filter(Boolean).join(' '),
        resolvedXProfile.handle
      )
    : [];
  const projectXProfile =
    virtualsProjectXUrl && virtualsProjectXUrl !== resolvedXProfile?.url
      ? await fetchXProfileSource(virtualsProjectXUrl).catch(() => null)
      : projectXHandle && xUrlForHandle(projectXHandle) !== resolvedXProfile?.url
        ? await fetchXProfileSource(xUrlForHandle(projectXHandle)).catch(() => null)
        : null;

  if (!website && resolvedXProfile) {
    const [projectWebsiteUrl] = extractProjectWebsiteCandidates(
      [projectXProfile?.markdown, projectXProfile?.bio, resolvedXProfile.markdown, resolvedXProfile.bio]
        .filter(Boolean)
        .join(' ')
    );
    website = projectWebsiteUrl ? await fetchWebsiteSource(projectWebsiteUrl).catch(() => null) : null;
  }

  const websiteUrl = website?.url || marketWebsiteUrl || bankrWebsiteUrl || virtualsWebsiteUrl || null;
  const walletOwnerSearch =
    bankr?.feeRecipientWallet && !bankr?.feeRecipientHandle
      ? await searchWalletOwner(bankr.feeRecipientWallet).catch(() => null)
      : null;

  const githubCandidates = unique([
    ...extractGithubUsernames(
      [
        resolvedXProfile?.markdown,
        resolvedXProfile?.bio,
        projectXProfile?.markdown,
        projectXProfile?.bio,
        website?.markdown,
        website?.title,
        virtuals?.projectWebsiteUrl,
        ...(virtuals?.projectMembers || []).map((member) =>
          [member.bio, member.githubUsername, member.githubUrl].filter(Boolean).join(' ')
        )
      ].join(' ')
    ),
    ...extractGithubUsernames((website?.discoveredLinks || []).join(' ')),
    ...(virtuals?.projectMembers || []).map((member) => member.githubUsername),
    resolvedXProfile?.handle,
    bankr?.feeRecipientHandle,
    walletOwnerSearch?.matchedHandle
  ]);
  let github = await fetchGithubRepoSource(website?.url, website?.markdown).catch(() => null);
  for (const githubCandidate of githubCandidates.slice(0, 3)) {
    if (github) {
      break;
    }
    github = await fetchGithubSource(githubCandidate).catch(() => null);
    if (github) {
      break;
    }
  }

  return {
    bankr,
    gecko,
    virtuals,
    website,
    xProfile: resolvedXProfile,
    projectXProfile,
    github,
    walletOwnerSearch,
    marketSourceUrl: parseJinaSourceUrl(website?.markdown || '') || websiteUrl || null
  };
}
