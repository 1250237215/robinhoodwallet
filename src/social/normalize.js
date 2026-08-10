import { Buffer } from 'node:buffer';

const SOURCE_ALIASES = new Map([
  ['x', 'twitter'],
  ['twitter', 'twitter'],
  ['tweet', 'twitter'],
  ['binance', 'binance'],
  ['binance-square', 'binance'],
  ['binance_square', 'binance'],
  ['binance square', 'binance'],
  ['debot', 'debot'],
  ['fomo', 'fomo']
]);

export const SOCIAL_WATCH_EVENT_TYPES = Object.freeze([
  'post',
  'reply',
  'quote',
  'repost',
  'delete',
  'follow',
  'unfollow',
  'profile_name',
  'profile_avatar',
  'profile_bio'
]);
export const FOMO_WATCH_EVENT_TYPES = Object.freeze([
  'fomo_buy',
  'fomo_sell',
  'fomo_swap',
  'fomo_thesis',
  'fomo_consensus',
  'fomo_cash',
  'fomo_verified'
]);
export const SOCIAL_PROFILE_CHANGES = Object.freeze(['name', 'avatar', 'bio']);

const ALL_WATCH_EVENT_TYPES = Object.freeze([...SOCIAL_WATCH_EVENT_TYPES, ...FOMO_WATCH_EVENT_TYPES]);
const WATCH_EVENT_TYPE_SET = new Set(ALL_WATCH_EVENT_TYPES);
const PROFILE_CHANGE_SET = new Set(SOCIAL_PROFILE_CHANGES);
const POST_KIND_ALIASES = new Map([
  ['post', 'post'],
  ['tweet', 'post'],
  ['reply', 'reply'],
  ['quote', 'quote'],
  ['quotetweet', 'quote'],
  ['repost', 'repost'],
  ['retweet', 'repost'],
  ['delete', 'delete'],
  ['deleted', 'delete'],
  ['deltweet', 'delete'],
  ['deletepost', 'delete'],
  ['follow', 'follow'],
  ['tweetuserfollow', 'follow'],
  ['unfollow', 'unfollow'],
  ['tweetuserunfollow', 'unfollow'],
  ['fomobuy', 'fomo_buy'],
  ['fomosell', 'fomo_sell'],
  ['fomoswap', 'fomo_swap'],
  ['fomothesis', 'fomo_thesis'],
  ['fomoconsensus', 'fomo_consensus'],
  ['fomocash', 'fomo_cash'],
  ['fomoverified', 'fomo_verified']
]);
const SOCIAL_ACTIVITY_KINDS = new Set(['follow', 'unfollow']);
const PROFILE_KIND_ALIASES = new Map([
  ['profile', ''],
  ['profilechange', ''],
  ['profileupdate', ''],
  ['tweetuserprofile', ''],
  ['rename', 'name'],
  ['namechange', 'name'],
  ['reimage', 'avatar'],
  ['reavatar', 'avatar'],
  ['avatarchange', 'avatar'],
  ['imagechange', 'avatar'],
  ['redescription', 'bio'],
  ['descriptionchange', 'bio'],
  ['biochange', 'bio']
]);
const CHAIN_TAGS = new Set(['robinhood', 'base', 'solana']);
const FEED_SOURCE_ORDER = Object.freeze(['all', 'featured', 'my']);
const FEED_SOURCE_ALIASES = new Map([
  ['all', 'all'],
  ['global', 'all'],
  ['public', 'all'],
  ['featured', 'featured'],
  ['feature', 'featured'],
  ['selected', 'featured'],
  ['hot', 'featured'],
  ['curated', 'featured'],
  ['my', 'my'],
  ['mine', 'my'],
  ['following', 'my'],
  ['watchlist', 'my'],
  ['monitored', 'my']
]);

function hasOwn(object, keys) {
  return keys.some((key) => Object.hasOwn(object, key));
}

function firstValue(object, keys, fallback = undefined) {
  for (const key of keys) {
    if (Object.hasOwn(object, key)) return object[key];
  }
  return fallback;
}

function text(value, maximum = 100_000) {
  if (value === null || value === undefined) return '';
  return String(value).trim().slice(0, maximum);
}

function integer(value, fallback = 0) {
  const number = Number(value);
  return Number.isFinite(number) ? Math.max(0, Math.floor(number)) : fallback;
}

export function normalizeTimestamp(value, fallback = null) {
  if (value === null || value === undefined || value === '') return fallback;
  if (value instanceof Date) return Number.isFinite(value.getTime()) ? value.getTime() : fallback;
  if (typeof value === 'number' || /^\d+(?:\.\d+)?$/.test(String(value).trim())) {
    const number = Number(value);
    if (!Number.isFinite(number) || number < 0) return fallback;
    return Math.floor(number < 10_000_000_000 ? number * 1_000 : number);
  }
  const parsed = Date.parse(String(value));
  return Number.isFinite(parsed) ? parsed : fallback;
}

export function normalizeSocialSource(value, fallback = 'debot') {
  const normalized = text(value, 40).toLowerCase();
  if (!normalized) return fallback;
  return SOURCE_ALIASES.get(normalized) || normalized.replace(/[^a-z0-9_-]+/g, '-').slice(0, 40);
}

function normalizeUrl(value) {
  const candidate = text(value, 2_000);
  if (!candidate) return '';
  try {
    const url = new URL(candidate);
    return ['http:', 'https:'].includes(url.protocol) ? url.toString() : '';
  } catch {
    return '';
  }
}

function activityCandidate(value) {
  const candidate = text(value, 240);
  if (!candidate) return '';
  if (/^(?:follow|unfollow)[:_]/i.test(candidate)) return candidate;
  if (!/^[a-z0-9_-]{12,}$/i.test(candidate)) return '';
  try {
    const bytes = Buffer.from(candidate, 'base64url');
    if (bytes.toString('base64url') !== candidate.replace(/=+$/, '')) return '';
    const decoded = bytes.toString('utf8');
    return decoded.includes('\ufffd') || !/^(?:follow|unfollow):/i.test(decoded) ? '' : decoded;
  } catch {
    return '';
  }
}

function compactKind(value) {
  return text(value, 80).toLowerCase().replace(/[-_\s]+/g, '');
}

export function normalizeWatchEventTypes(value, { defaultAll = false } = {}) {
  if (value === undefined && defaultAll) return [...SOCIAL_WATCH_EVENT_TYPES];
  if (!Array.isArray(value)) throw new TypeError('eventTypes must be an array');
  const requested = new Set();
  for (const eventType of value) {
    if (typeof eventType !== 'string' || !WATCH_EVENT_TYPE_SET.has(eventType)) {
      throw new TypeError(`Unsupported social watch event type: ${String(eventType)}`);
    }
    requested.add(eventType);
  }
  return ALL_WATCH_EVENT_TYPES.filter((eventType) => requested.has(eventType));
}

export function normalizeProfileChanges(value) {
  if (!Array.isArray(value)) throw new TypeError('profileChanges must be an array');
  const requested = new Set();
  for (const change of value) {
    if (typeof change !== 'string' || !PROFILE_CHANGE_SET.has(change)) {
      throw new TypeError(`Unsupported social profile change: ${String(change)}`);
    }
    requested.add(change);
  }
  return SOCIAL_PROFILE_CHANGES.filter((change) => requested.has(change));
}

function profileKindChange(value) {
  const candidate = compactKind(value);
  return PROFILE_KIND_ALIASES.has(candidate) ? PROFILE_KIND_ALIASES.get(candidate) : null;
}

function profileDetailValue(input, profileInput, change, side) {
  const nested = profileInput[change] && typeof profileInput[change] === 'object'
    ? profileInput[change]
    : {};
  const sideAliases = side === 'before'
    ? ['before', 'old', 'previous', 'from']
    : ['after', 'new', 'current', 'to'];
  const prefix = side === 'before' ? ['before', 'old', 'previous'] : ['after', 'new', 'current'];
  const suffix = change === 'avatar' ? ['AvatarUrl', 'Avatar', 'ImageUrl', 'Image']
    : change === 'bio' ? ['Bio', 'Description']
      : ['Name'];
  const directAliases = prefix.flatMap((left) => suffix.map((right) => `${left}${right}`));
  return text(firstValue(input, directAliases, firstValue(nested, sideAliases)), 10_000);
}

function normalizedProfileData(input, inferredChange) {
  const changesSpecified = hasOwn(input, ['profileChanges', 'profile_changes']);
  const detailSpecified = hasOwn(input, ['profileDetail', 'profile_detail', 'profile']);
  const rawDetail = firstValue(input, ['profileDetail', 'profile_detail', 'profile'], {});
  if (detailSpecified && (!rawDetail || typeof rawDetail !== 'object' || Array.isArray(rawDetail))) {
    throw new TypeError('profileDetail must be an object');
  }
  const detailInput = rawDetail && typeof rawDetail === 'object' && !Array.isArray(rawDetail) ? rawDetail : {};
  let profileChanges;
  if (changesSpecified) {
    profileChanges = normalizeProfileChanges(firstValue(input, ['profileChanges', 'profile_changes']));
  } else {
    const inferred = new Set();
    if (inferredChange) inferred.add(inferredChange);
    for (const change of SOCIAL_PROFILE_CHANGES) {
      if (Object.hasOwn(detailInput, change)) inferred.add(change);
    }
    profileChanges = SOCIAL_PROFILE_CHANGES.filter((change) => inferred.has(change));
  }
  const profileDetail = {};
  for (const change of profileChanges) {
    profileDetail[change] = {
      before: profileDetailValue(input, detailInput, change, 'before'),
      after: profileDetailValue(input, detailInput, change, 'after')
    };
  }
  return { profileChanges, profileDetail, changesSpecified, detailSpecified };
}

export function parseSocialActivityIdentity(externalId, authorHandle = '') {
  const candidate = activityCandidate(externalId);
  if (!candidate) return null;
  const expectedActor = text(authorHandle, 240).replace(/^@/, '');
  const handlePattern = '[a-z0-9_]{1,15}';
  const colon = candidate.match(new RegExp(`^(follow|unfollow):(${handlePattern}):(${handlePattern})(?::(\\d{10,16}))?$`, 'i'));
  if (colon) {
    const kind = colon[1].toLowerCase();
    const actorHandle = text(colon[2], 240).replace(/^@/, '');
    const targetHandle = text(colon[3], 240).replace(/^@/, '');
    if (!actorHandle || !targetHandle || (expectedActor && actorHandle.toLowerCase() !== expectedActor.toLowerCase())) {
      return null;
    }
    const occurrenceAt = colon[4] ? Number(colon[4]) : null;
    const canonicalId = `${kind}:${actorHandle.toLowerCase()}:${targetHandle.toLowerCase()}`;
    return {
      kind,
      actorHandle,
      targetHandle,
      canonicalId,
      occurrenceAt,
      occurrenceId: occurrenceAt === null ? canonicalId : `${canonicalId}:${occurrenceAt}`
    };
  }

  const kind = candidate.match(/^(follow|unfollow)_/i)?.[1]?.toLowerCase();
  const actorHandle = expectedActor;
  if (!kind || !actorHandle || !new RegExp(`^${handlePattern}$`, 'i').test(actorHandle)) return null;
  const prefix = `${kind}_${actorHandle}_`;
  if (!candidate.toLowerCase().startsWith(prefix.toLowerCase())) return null;
  const targetHandle = text(candidate.slice(prefix.length), 240).replace(/^@/, '');
  if (!new RegExp(`^${handlePattern}$`, 'i').test(targetHandle)) return null;
  const canonicalId = `${kind}:${actorHandle.toLowerCase()}:${targetHandle.toLowerCase()}`;
  return {
    kind,
    actorHandle,
    targetHandle,
    canonicalId,
    occurrenceAt: null,
    occurrenceId: canonicalId
  };
}

function normalizeSocialTarget(input, inferredTargetHandle = '') {
  const targetInput = input.target && typeof input.target === 'object' && !Array.isArray(input.target)
    ? input.target
    : input.activityTarget && typeof input.activityTarget === 'object' && !Array.isArray(input.activityTarget)
      ? input.activityTarget
      : {};
  const handle = text(
    firstValue(input, ['targetHandle', 'targetUsername'], targetInput.handle || targetInput.username || inferredTargetHandle),
    240
  ).replace(/^@/, '');
  return {
    id: text(firstValue(input, ['targetId', 'targetUserId'], targetInput.id || targetInput.userId), 240),
    handle,
    name: text(firstValue(input, ['targetName'], targetInput.name || targetInput.displayName), 500),
    avatarUrl: normalizeUrl(firstValue(
      input,
      ['targetAvatarUrl'],
      targetInput.avatarUrl || targetInput.avatar || targetInput.profileImageUrl
    )),
    followers: integer(firstValue(
      input,
      ['targetFollowers', 'targetFollowersCount'],
      targetInput.followers ?? targetInput.followersCount
    )),
    url: normalizeUrl(firstValue(input, ['targetUrl'], targetInput.url || targetInput.profileUrl))
  };
}

function normalizePostContext(input, aliases, fieldName) {
  const specified = hasOwn(input, aliases);
  if (!specified) return { specified, value: {} };
  const context = firstValue(input, aliases);
  if (!context || typeof context !== 'object' || Array.isArray(context)) {
    throw new TypeError(`${fieldName} must be an object`);
  }
  const authorInput = context.author && typeof context.author === 'object' && !Array.isArray(context.author)
    ? context.author
    : {};
  const externalId = text(firstValue(context, ['externalId', 'postId', 'tweetId', 'id']), 240);
  const normalizedExternalId = /^\d{5,25}$/.test(externalId) ? externalId : '';
  const rawUrl = normalizeUrl(firstValue(context, ['url', 'postUrl', 'permalink']));
  const urlIdentity = /^https:\/\/(?:www\.)?(?:x|twitter)\.com\/[a-z0-9_]{1,15}\/(?:status|statuses)\/(\d{5,25})(?:[/?#]|$)/i.exec(rawUrl);
  const urlStatusId = urlIdentity?.[1] || '';
  const url = urlIdentity && (!normalizedExternalId || urlStatusId === normalizedExternalId) ? rawUrl : '';
  const canonicalExternalId = normalizedExternalId || (url ? urlStatusId : '');
  const rawAuthorHandle = text(
    firstValue(context, ['authorHandle', 'username', 'handle'], authorInput.handle || authorInput.username),
    240
  ).replace(/^@/, '');
  return {
    specified,
    value: {
      externalId: canonicalExternalId,
      author: {
        id: text(firstValue(context, ['authorId'], authorInput.id || authorInput.userId), 240),
        handle: /^[a-z0-9_]{1,15}$/i.test(rawAuthorHandle) ? rawAuthorHandle : '',
        name: text(firstValue(context, ['authorName'], authorInput.name || authorInput.displayName), 500),
        avatarUrl: normalizeUrl(firstValue(
          context,
          ['authorAvatarUrl'],
          authorInput.avatarUrl || authorInput.avatar || authorInput.profileImageUrl
        ))
      },
      content: text(firstValue(context, ['content', 'text', 'body']), 100_000),
      translatedContent: text(
        firstValue(context, ['translatedContent', 'translatedText', 'translation']),
        100_000
      ),
      url,
      publishedAt: normalizeTimestamp(firstValue(context, ['publishedAt', 'createdAt', 'timestamp']), 0) || 0,
      media: normalizeMedia(firstValue(context, ['media', 'attachments'], []))
    }
  };
}

function normalizeReplyContext(input) {
  return normalizePostContext(input, ['replyContext', 'reply_context'], 'replyContext');
}

function normalizeQuoteContext(input) {
  return normalizePostContext(input, ['quoteContext', 'quote_context'], 'quoteContext');
}

function normalizeMedia(media) {
  if (!Array.isArray(media)) return [];
  const normalized = media.map((item) => {
    if (typeof item === 'string') return { type: 'image', url: normalizeUrl(item), previewUrl: '' };
    if (!item || typeof item !== 'object') return null;
    const type = text(item.type || item.mediaType || 'image', 20).toLowerCase();
    return {
      type: ['image', 'video', 'gif'].includes(type) ? type : 'image',
      url: normalizeUrl(item.url || item.src || item.mediaUrl),
      previewUrl: normalizeUrl(item.previewUrl || item.thumbnailUrl || item.poster)
    };
  }).filter((item) => item?.url || item?.previewUrl);
  const merged = [];
  for (const item of normalized) {
    const matchingIndex = merged.findIndex((candidate) => (
      [candidate.url, candidate.previewUrl]
        .filter(Boolean)
        .some((value) => value === item.url || value === item.previewUrl)
    ));
    if (matchingIndex < 0) {
      merged.push(item);
      if (merged.length >= 12) break;
      continue;
    }
    const existing = merged[matchingIndex];
    const type = existing.type === 'video' || item.type === 'video'
      ? 'video'
      : existing.type === 'gif' || item.type === 'gif' ? 'gif' : 'image';
    merged[matchingIndex] = {
      type,
      url: type === 'video'
        ? (existing.type === 'video' ? existing.url : '') || (item.type === 'video' ? item.url : '')
        : existing.url || item.url,
      previewUrl: existing.previewUrl
        || item.previewUrl
        || (existing.type !== 'video' ? existing.url : '')
        || (item.type !== 'video' ? item.url : '')
    };
  }
  return merged;
}

function normalizeContracts(contracts, content) {
  const normalized = [];
  const indexesByAddress = new Map();
  const add = (address, chain = '') => {
    const candidate = text(address, 100);
    if (!candidate) return;
    const normalizedAddress = /^0x[0-9a-f]{40}$/i.test(candidate) ? candidate.toLowerCase() : candidate;
    const normalizedChain = text(chain, 20).toLowerCase();
    const existingIndex = indexesByAddress.get(normalizedAddress);
    if (existingIndex !== undefined) {
      if (!normalized[existingIndex].chain && CHAIN_TAGS.has(normalizedChain)) {
        normalized[existingIndex].chain = normalizedChain;
      }
      return;
    }
    indexesByAddress.set(normalizedAddress, normalized.length);
    normalized.push({
      address: normalizedAddress,
      chain: CHAIN_TAGS.has(normalizedChain) ? normalizedChain : ''
    });
  };
  if (Array.isArray(contracts)) {
    for (const contract of contracts.slice(0, 32)) {
      if (typeof contract === 'string') add(contract);
      else if (contract && typeof contract === 'object') {
        add(contract.address || contract.contractAddress || contract.ca, text(contract.chain, 20).toLowerCase());
      }
    }
  }
  for (const match of String(content || '').matchAll(/\b0x[0-9a-fA-F]{40}\b/g)) add(match[0]);
  return normalized;
}

function normalizeChainTags(tags, contracts) {
  const values = new Set();
  for (const tag of Array.isArray(tags) ? tags : []) {
    const normalized = text(tag, 20).toLowerCase();
    if (CHAIN_TAGS.has(normalized)) values.add(normalized);
  }
  for (const contract of contracts) if (CHAIN_TAGS.has(contract.chain)) values.add(contract.chain);
  return [...values];
}

function collectFeedSources(values, normalized) {
  if (Array.isArray(values)) {
    for (const value of values) collectFeedSources(value, normalized);
    return;
  }
  if (values && typeof values === 'object') {
    for (const [key, enabled] of Object.entries(values)) {
      if (enabled) collectFeedSources(key, normalized);
    }
    return;
  }
  for (const value of String(values ?? '').split(/[\s,|]+/)) {
    const source = FEED_SOURCE_ALIASES.get(text(value, 20).toLowerCase());
    if (source) normalized.add(source);
  }
}

export function normalizeFeedSources(values, { defaultSource = 'all' } = {}) {
  const normalized = new Set();
  collectFeedSources(values, normalized);
  if (!normalized.size && defaultSource) {
    const fallback = FEED_SOURCE_ALIASES.get(text(defaultSource, 20).toLowerCase());
    if (fallback) normalized.add(fallback);
  }
  return FEED_SOURCE_ORDER.filter((source) => normalized.has(source));
}

function postFeedSources(input) {
  const keys = ['feedSources', 'feed_sources', 'feedSource', 'feed_source'];
  const values = hasOwn(input, keys) ? [firstValue(input, keys)] : [];
  if (input.featured === true || input.isFeatured === true || input.is_featured === true) {
    values.push('featured');
  }
  if (input.my === true || input.isMine === true || input.is_mine === true || input.inMyFeed === true) {
    values.push('my');
  }
  if (input.all === true || input.isAll === true || input.is_all === true) values.push('all');
  return normalizeFeedSources(values);
}

export function normalizeSocialPost(input, { now = Date.now() } = {}) {
  if (!input || typeof input !== 'object' || Array.isArray(input)) {
    throw new TypeError('Social post must be an object');
  }
  const authorInput = input.author && typeof input.author === 'object' ? input.author : {};
  const source = normalizeSocialSource(firstValue(input, ['source', 'platform']));
  const suppliedExternalId = text(firstValue(input, ['externalId', 'postId', 'tweetId', 'signalId', 'id']), 240);
  if (!suppliedExternalId) throw new TypeError('Social post externalId is required');
  const suppliedAuthorHandle = text(
    firstValue(input, ['authorHandle', 'username', 'handle'], authorInput.handle || authorInput.username),
    240
  ).replace(/^@/, '');
  const suppliedActivityCandidate = activityCandidate(suppliedExternalId);
  const activityIdentity = parseSocialActivityIdentity(suppliedExternalId, suppliedAuthorHandle);
  if (suppliedActivityCandidate && !activityIdentity) {
    throw new TypeError('Social activity identity conflicts with its author or target');
  }
  const authorHandle = suppliedAuthorHandle || activityIdentity?.actorHandle || '';
  let externalId = activityIdentity?.occurrenceId || suppliedExternalId;
  const content = text(firstValue(input, ['content', 'text', 'body']), 100_000);
  const translatedContent = text(
    firstValue(input, ['translatedContent', 'translatedText', 'translation']),
    100_000
  );
  const contracts = normalizeContracts(
    firstValue(input, ['contractAddresses', 'contracts', 'cas'], []),
    `${content}\n${translatedContent}`
  );
  const deletionSpecified = hasOwn(input, ['deleted', 'deletedAt']);
  const deletedAt = input.deleted === true || input.deletedAt
    ? normalizeTimestamp(input.deletedAt, now)
    : null;
  const kindSpecified = hasOwn(input, ['kind', 'postType', 'type']);
  const rawKind = firstValue(input, ['kind', 'postType', 'type'], 'post');
  const normalizedPostKind = POST_KIND_ALIASES.get(compactKind(rawKind)) || '';
  const inferredProfileChange = profileKindChange(rawKind);
  const profileFieldsSpecified = hasOwn(input, ['profileChanges', 'profile_changes', 'profileDetail', 'profile_detail', 'profile']);
  const isProfile = inferredProfileChange !== null || profileFieldsSpecified;
  if (kindSpecified && !normalizedPostKind && inferredProfileChange === null) {
    throw new TypeError(`Unsupported social post kind: ${String(rawKind)}`);
  }
  const kind = activityIdentity?.kind || (isProfile ? 'profile' : normalizedPostKind || 'post');
  const profileData = normalizedProfileData(input, inferredProfileChange);
  if (kind === 'profile' && !profileData.profileChanges.length) {
    throw new TypeError('Social profile activity requires at least one verified profile change');
  }
  if (kind === 'profile') {
    if (!/^[a-z0-9_]{1,15}$/i.test(authorHandle)) {
      throw new TypeError('Social profile activity requires a valid author handle');
    }
    const canonicalProfile = /^profile:([a-z0-9_]{1,15}):(\d{10,16})$/i.exec(suppliedExternalId);
    if (canonicalProfile && canonicalProfile[1].toLowerCase() !== authorHandle.toLowerCase()) {
      throw new TypeError('Social profile activity identity conflicts with its author');
    }
  }
  const rawReplyToExternalId = text(firstValue(input, ['replyToExternalId', 'replyToId']), 240);
  const inferredReplyTarget = kind === 'reply' && /^[a-z0-9_]{1,15}$/i.test(rawReplyToExternalId)
    ? rawReplyToExternalId
    : '';
  const replyToExternalId = /^\d{5,25}$/.test(rawReplyToExternalId) ? rawReplyToExternalId : '';
  const target = normalizeSocialTarget(
    input,
    SOCIAL_ACTIVITY_KINDS.has(kind) ? activityIdentity?.targetHandle : inferredReplyTarget
  );
  const replyContext = normalizeReplyContext(input);
  const quoteContext = normalizeQuoteContext(input);
  const quotedIdCandidate = text(firstValue(input, ['quotedExternalId', 'quotedId']), 240);
  const quotedExternalId = /^\d{5,25}$/.test(quotedIdCandidate) ? quotedIdCandidate : '';
  if (activityIdentity && target.handle
    && target.handle.toLowerCase() !== activityIdentity.targetHandle.toLowerCase()) {
    throw new TypeError('Social activity target conflicts with its externalId');
  }
  if (SOCIAL_ACTIVITY_KINDS.has(kind)) {
    const completeIdentity = /^[a-z0-9_]{1,15}$/i.test(authorHandle)
      && /^[a-z0-9_]{1,15}$/i.test(target.handle);
    if (!completeIdentity) {
      throw new TypeError('Social activity requires valid actor and target handles');
    }
    const canonicalId = `${kind}:${authorHandle.toLowerCase()}:${target.handle.toLowerCase()}`;
    externalId = activityIdentity?.occurrenceAt === null || activityIdentity?.occurrenceAt === undefined
      ? canonicalId
      : `${canonicalId}:${activityIdentity.occurrenceAt}`;
  }
  const publishedAt = normalizeTimestamp(
    firstValue(input, ['publishedAt', 'createdAt', 'postTimestamp', 'timestamp']),
    now
  );
  const discoveredAt = normalizeTimestamp(
    firstValue(input, ['debotDiscoveredAt', 'discoveredAt', 'receivedAt', 'detectedAt']),
    now
  );
  const sourceUpdatedAt = normalizeTimestamp(
    firstValue(input, ['sourceUpdatedAt', 'updatedAt', 'editedAt']),
    deletedAt || publishedAt
  );
  const provided = new Set();
  const aliases = {
    authorId: ['authorId', 'userId'],
    authorHandle: ['authorHandle', 'username', 'handle'],
    authorName: ['authorName', 'displayName'],
    authorAvatarUrl: ['authorAvatarUrl', 'avatarUrl'],
    authorFollowers: ['authorFollowers', 'followers', 'followersCount'],
    content: ['content', 'text', 'body'],
    translatedContent: ['translatedContent', 'translatedText', 'translation'],
    url: ['url', 'postUrl', 'permalink'],
    media: ['media', 'attachments'],
    contractAddresses: ['contractAddresses', 'contracts', 'cas'],
    chainTags: ['chainTags', 'chains'],
    feedSources: [
      'feedSources',
      'feed_sources',
      'feedSource',
      'feed_source',
      'featured',
      'isFeatured',
      'is_featured',
      'my',
      'isMine',
      'is_mine',
      'inMyFeed',
      'all',
      'isAll',
      'is_all'
    ],
    replyToExternalId: ['replyToExternalId', 'replyToId'],
    replyContext: ['replyContext', 'reply_context'],
    quoteContext: ['quoteContext', 'quote_context'],
    quotedExternalId: ['quotedExternalId', 'quotedId'],
    repostExternalId: ['repostExternalId', 'repostedId'],
    profileChanges: ['profileChanges', 'profile_changes'],
    profileDetail: ['profileDetail', 'profile_detail', 'profile'],
    target: [
      'target',
      'activityTarget',
      'targetId',
      'targetUserId',
      'targetHandle',
      'targetUsername',
      'targetName',
      'targetAvatarUrl',
      'targetFollowers',
      'targetFollowersCount',
      'targetUrl'
    ],
    raw: ['raw', 'payload']
  };
  for (const [name, keys] of Object.entries(aliases)) {
    if (hasOwn(input, keys)) provided.add(name);
  }
  const authorAliases = {
    authorId: ['id', 'userId'],
    authorHandle: ['handle', 'username'],
    authorName: ['name', 'displayName'],
    authorAvatarUrl: ['avatarUrl', 'avatar'],
    authorFollowers: ['followersCount', 'followers']
  };
  for (const [name, keys] of Object.entries(authorAliases)) {
    if (keys.some((key) => Object.hasOwn(authorInput, key))) provided.add(name);
  }
  if (hasOwn(input, ['kind', 'postType', 'type'])) provided.add('kind');
  if (isProfile) {
    provided.add('kind');
    provided.add('profileChanges');
    provided.add('profileDetail');
  }
  if (hasOwn(input, ['publishedAt', 'createdAt', 'postTimestamp', 'timestamp'])) provided.add('publishedAt');
  if (hasOwn(input, ['sourceUpdatedAt', 'updatedAt', 'editedAt'])) provided.add('sourceUpdatedAt');
  if (activityIdentity) {
    provided.add('kind');
    provided.add('target');
    if (!suppliedAuthorHandle) provided.add('authorHandle');
  }
  if (inferredReplyTarget) provided.add('target');
  if (deletionSpecified) provided.add('deletedAt');
  return {
    source,
    externalId,
    kind,
    authorId: text(firstValue(input, ['authorId', 'userId'], authorInput.id || authorInput.userId), 240),
    authorHandle,
    authorName: text(firstValue(input, ['authorName', 'displayName'], authorInput.name || authorInput.displayName), 500),
    authorAvatarUrl: normalizeUrl(
      firstValue(input, ['authorAvatarUrl', 'avatarUrl'], authorInput.avatarUrl || authorInput.avatar)
    ),
    authorFollowers: integer(
      firstValue(
        input,
        ['authorFollowers', 'followers', 'followersCount'],
        authorInput.followersCount ?? authorInput.followers
      )
    ),
    content,
    translatedContent,
    url: normalizeUrl(firstValue(input, ['url', 'postUrl', 'permalink'])),
    media: normalizeMedia(firstValue(input, ['media', 'attachments'], [])),
    contractAddresses: contracts,
    chainTags: normalizeChainTags(firstValue(input, ['chainTags', 'chains'], []), contracts),
    feedSources: postFeedSources(input),
    replyToExternalId,
    replyContext: replyContext.value,
    quoteContext: quoteContext.value,
    quotedExternalId: quoteContext.value.externalId || quotedExternalId,
    repostExternalId: text(firstValue(input, ['repostExternalId', 'repostedId']), 240),
    target,
    profileChanges: kind === 'profile' ? profileData.profileChanges : [],
    profileDetail: kind === 'profile' ? profileData.profileDetail : {},
    publishedAt,
    discoveredAt,
    receivedAt: discoveredAt,
    sourceUpdatedAt,
    deletedAt,
    raw: firstValue(input, ['raw', 'payload'], input),
    _provided: provided,
    _activityCanonicalId: activityIdentity?.canonicalId || '',
    _activityOccurrenceId: activityIdentity?.occurrenceAt === null || activityIdentity?.occurrenceAt === undefined
      ? ''
      : activityIdentity.occurrenceId
  };
}

export function normalizeWatchAccount(input, { defaultPlatform = 'twitter' } = {}) {
  const value = typeof input === 'string' ? { handle: input } : input;
  if (!value || typeof value !== 'object' || Array.isArray(value)) {
    throw new TypeError('Watchlist account must be a string or object');
  }
  let handle = text(firstValue(value, ['handle', 'username', 'account', 'accountKey']), 240);
  const suppliedUrl = normalizeUrl(firstValue(value, ['url', 'profileUrl']));
  if (/^https?:\/\//i.test(handle)) {
    try {
      const url = new URL(handle);
      handle = url.pathname.split('/').filter(Boolean).at(-1) || '';
    } catch {
      handle = '';
    }
  }
  handle = handle.replace(/^@/, '').trim();
  if (!handle || /[\u0000-\u001f\u007f]/.test(handle)) throw new TypeError('Watchlist account handle is required');
  const platform = normalizeSocialSource(firstValue(value, ['platform', 'source'], defaultPlatform), defaultPlatform);
  const accountKey = text(firstValue(value, ['accountKey'], handle), 240).toLowerCase();
  if (!accountKey) throw new TypeError('Watchlist account key is required');
  const eventTypesProvided = Object.hasOwn(value, 'eventTypes');
  const noteProvided = Object.hasOwn(value, 'note');
  const caBarkProvided = Object.hasOwn(value, 'caBark');
  if (caBarkProvided && typeof value.caBark !== 'boolean') throw new TypeError('caBark must be a boolean');
  return {
    platform,
    accountKey,
    handle,
    name: text(firstValue(value, ['name', 'displayName']), 500),
    url: suppliedUrl,
    remoteId: text(firstValue(value, ['remoteId', 'authorId']), 240),
    metadata: value.metadata && typeof value.metadata === 'object' ? value.metadata : {},
    eventTypes: eventTypesProvided
      ? normalizeWatchEventTypes(value.eventTypes)
      : platform === 'fomo' ? [...FOMO_WATCH_EVENT_TYPES] : [...SOCIAL_WATCH_EVENT_TYPES],
    note: noteProvided ? value.note : '',
    caBark: caBarkProvided ? value.caBark : false,
    _eventTypesProvided: eventTypesProvided,
    _noteProvided: noteProvided,
    _caBarkProvided: caBarkProvided
  };
}
