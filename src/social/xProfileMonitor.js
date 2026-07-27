const DEFAULT_USER_AGENT = [
  'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7)',
  'AppleWebKit/537.36 (KHTML, like Gecko)',
  'Chrome/130.0 Safari/537.36'
].join(' ');

const VOID_ELEMENTS = new Set([
  'area', 'base', 'br', 'col', 'embed', 'hr', 'img', 'input', 'link', 'meta',
  'param', 'source', 'track', 'wbr'
]);
const RAW_TEXT_ELEMENTS = new Set(['script', 'style']);
const BLOCK_ELEMENTS = new Set([
  'article', 'blockquote', 'br', 'div', 'figcaption', 'figure', 'footer', 'h1',
  'h2', 'h3', 'h4', 'h5', 'h6', 'header', 'li', 'p', 'section', 'time'
]);
const NAMED_ENTITIES = Object.freeze({
  amp: '&', apos: "'", gt: '>', lt: '<', nbsp: ' ', quot: '"'
});

function boundedInteger(value, fallback, minimum, maximum) {
  const number = Number(value);
  if (!Number.isFinite(number)) return fallback;
  return Math.min(maximum, Math.max(minimum, Math.floor(number)));
}

function normalizedHandle(value) {
  const handle = String(value || '').trim().replace(/^@/, '').toLowerCase();
  if (!/^[a-z0-9_]{1,15}$/.test(handle)) {
    throw new TypeError(`Invalid X handle: ${String(value || '')}`);
  }
  return handle;
}

function decodeHtmlEntities(value) {
  return String(value || '').replace(/&(#x[0-9a-f]+|#\d+|[a-z]+);/gi, (match, entity) => {
    const lower = entity.toLowerCase();
    if (lower.startsWith('#x')) {
      const codePoint = Number.parseInt(lower.slice(2), 16);
      return Number.isInteger(codePoint) && codePoint >= 0 && codePoint <= 0x10ffff
        ? String.fromCodePoint(codePoint)
        : match;
    }
    if (lower.startsWith('#')) {
      const codePoint = Number.parseInt(lower.slice(1), 10);
      return Number.isInteger(codePoint) && codePoint >= 0 && codePoint <= 0x10ffff
        ? String.fromCodePoint(codePoint)
        : match;
    }
    return NAMED_ENTITIES[lower] ?? match;
  });
}

function normalizeText(value) {
  return decodeHtmlEntities(value)
    .replace(/\r/g, '')
    .split('\n')
    .map((line) => line.replace(/[\t\f\v ]+/g, ' ').trim())
    .join('\n')
    .replace(/\n{3,}/g, '\n\n')
    .trim();
}

function tagEnd(html, start) {
  let quote = '';
  for (let index = start + 1; index < html.length; index += 1) {
    const character = html[index];
    if (quote) {
      if (character === quote) quote = '';
      continue;
    }
    if (character === '"' || character === "'") {
      quote = character;
      continue;
    }
    if (character === '>') return index + 1;
  }
  return -1;
}

function parseAttributes(source) {
  const attributes = Object.create(null);
  let index = 0;
  while (index < source.length) {
    while (index < source.length && /\s|\//.test(source[index])) index += 1;
    if (index >= source.length) break;
    const nameStart = index;
    while (index < source.length && !/[\s=/>]/.test(source[index])) index += 1;
    const name = source.slice(nameStart, index).toLowerCase();
    if (!name) {
      index += 1;
      continue;
    }
    while (index < source.length && /\s/.test(source[index])) index += 1;
    let value = '';
    if (source[index] === '=') {
      index += 1;
      while (index < source.length && /\s/.test(source[index])) index += 1;
      const quote = source[index] === '"' || source[index] === "'" ? source[index] : '';
      if (quote) {
        index += 1;
        const valueStart = index;
        while (index < source.length && source[index] !== quote) index += 1;
        value = source.slice(valueStart, index);
        if (source[index] === quote) index += 1;
      } else {
        const valueStart = index;
        while (index < source.length && !/[\s>]/.test(source[index])) index += 1;
        value = source.slice(valueStart, index);
      }
    }
    attributes[name] = decodeHtmlEntities(value);
  }
  return attributes;
}

function scanHtmlTags(value) {
  const html = String(value || '');
  const lowerHtml = html.toLowerCase();
  const tags = [];
  let cursor = 0;
  while (cursor < html.length) {
    const start = html.indexOf('<', cursor);
    if (start < 0) break;
    if (html.startsWith('<!--', start)) {
      const commentEnd = html.indexOf('-->', start + 4);
      cursor = commentEnd < 0 ? html.length : commentEnd + 3;
      continue;
    }
    const end = tagEnd(html, start);
    if (end < 0) break;
    const source = html.slice(start + 1, end - 1).trim();
    const match = /^(\/)?\s*([a-z][a-z0-9:-]*)\b([\s\S]*)$/i.exec(source);
    if (!match) {
      cursor = end;
      continue;
    }
    const closing = Boolean(match[1]);
    const name = match[2].toLowerCase();
    const selfClosing = !closing && (VOID_ELEMENTS.has(name) || /\/\s*$/.test(match[3]));
    tags.push({
      name,
      closing,
      selfClosing,
      start,
      end,
      attributes: closing ? Object.create(null) : parseAttributes(match[3])
    });
    if (!closing && RAW_TEXT_ELEMENTS.has(name)) {
      const closeStart = lowerHtml.indexOf(`</${name}`, end);
      if (closeStart >= 0) {
        const closeEnd = tagEnd(html, closeStart);
        if (closeEnd >= 0) {
          tags.push({
            name,
            closing: true,
            selfClosing: false,
            start: closeStart,
            end: closeEnd,
            attributes: Object.create(null)
          });
          cursor = closeEnd;
          continue;
        }
      }
    }
    cursor = end;
  }
  return tags;
}

function innerRange(tags, openingIndex, htmlLength) {
  const opening = tags[openingIndex];
  if (!opening || opening.closing || opening.selfClosing) return null;
  let depth = 1;
  for (let index = openingIndex + 1; index < tags.length; index += 1) {
    const tag = tags[index];
    if (tag.name !== opening.name || tag.selfClosing) continue;
    depth += tag.closing ? -1 : 1;
    if (depth === 0) return { start: opening.end, end: tag.start };
  }
  return { start: opening.end, end: htmlLength };
}

function htmlToText(value) {
  const html = String(value || '');
  const tags = scanHtmlTags(html);
  let cursor = 0;
  let raw = '';
  let rawTextDepth = 0;
  for (const tag of tags) {
    if (rawTextDepth === 0 && tag.start >= cursor) raw += html.slice(cursor, tag.start);
    if (!tag.closing && RAW_TEXT_ELEMENTS.has(tag.name)) rawTextDepth += 1;
    else if (tag.closing && RAW_TEXT_ELEMENTS.has(tag.name)) rawTextDepth = Math.max(0, rawTextDepth - 1);
    if (rawTextDepth === 0 && (tag.name === 'br' || (tag.closing && BLOCK_ELEMENTS.has(tag.name)))) raw += '\n';
    cursor = tag.end;
  }
  if (rawTextDepth === 0) raw += html.slice(cursor);
  return normalizeText(raw);
}

function attributeTokens(value) {
  return String(value || '').trim().toLowerCase().split(/\s+/).filter(Boolean);
}

function elementValues(html, predicate) {
  const tags = scanHtmlTags(html);
  const values = [];
  for (let index = 0; index < tags.length; index += 1) {
    const tag = tags[index];
    if (tag.closing || !predicate(tag)) continue;
    const attributeValue = tag.attributes.content
      ?? tag.attributes.datetime
      ?? tag.attributes.value;
    if (attributeValue !== undefined && String(attributeValue).trim()) {
      values.push(normalizeText(attributeValue));
      continue;
    }
    const range = innerRange(tags, index, html.length);
    if (range) {
      const text = htmlToText(html.slice(range.start, range.end));
      if (text) values.push(text);
    }
  }
  return values;
}

function articleBlocks(html) {
  const tags = scanHtmlTags(html);
  const stack = [];
  const blocks = [];
  for (const tag of tags) {
    if (tag.name !== 'article' || tag.selfClosing) continue;
    if (!tag.closing) {
      stack.push(tag);
      continue;
    }
    const opening = stack.pop();
    if (!opening) continue;
    blocks.push({
      html: html.slice(opening.end, tag.start),
      attributes: opening.attributes,
      position: opening.start
    });
  }
  while (stack.length) {
    const opening = stack.pop();
    blocks.push({
      html: html.slice(opening.end),
      attributes: opening.attributes,
      position: opening.start
    });
  }
  return blocks.sort((left, right) => left.position - right.position);
}

function jsonLdObjects(html) {
  const tags = scanHtmlTags(html);
  const values = [];
  for (let index = 0; index < tags.length; index += 1) {
    const tag = tags[index];
    if (tag.closing || tag.name !== 'script') continue;
    if (String(tag.attributes.type || '').toLowerCase() !== 'application/ld+json') continue;
    const range = innerRange(tags, index, html.length);
    if (!range) continue;
    try {
      const parsed = JSON.parse(html.slice(range.start, range.end).trim());
      const pending = [parsed];
      let visited = 0;
      while (pending.length && visited < 1_000) {
        const item = pending.shift();
        visited += 1;
        if (Array.isArray(item)) {
          pending.push(...item);
          continue;
        }
        if (!item || typeof item !== 'object') continue;
        values.push(item);
        for (const child of Object.values(item)) {
          if (child && typeof child === 'object') pending.push(child);
        }
      }
    } catch {
      // An invalid JSON-LD block must not hide other valid article elements.
    }
  }
  return values;
}

function timestampMilliseconds(value) {
  if (value === null || value === undefined || value === '') return null;
  if (typeof value === 'number' || /^\d+(?:\.\d+)?$/.test(String(value).trim())) {
    const number = Number(value);
    if (!Number.isFinite(number) || number <= 0) return null;
    const milliseconds = number >= 100_000_000_000 ? number : number * 1_000;
    return Number.isSafeInteger(Math.trunc(milliseconds)) ? Math.trunc(milliseconds) : null;
  }
  const parsed = Date.parse(String(value));
  return Number.isFinite(parsed) && parsed > 0 ? parsed : null;
}

function statusReference(value) {
  const decoded = decodeHtmlEntities(value);
  const match = /(?:https?:\/\/(?:www\.)?(?:x\.com|twitter\.com))?\/([a-z0-9_]{1,15})\/status(?:es)?\/(\d{5,25})(?:\b|[/?#])/i.exec(decoded);
  if (!match) return null;
  const handle = match[1].toLowerCase();
  const tweetId = match[2];
  return {
    handle,
    tweetId,
    url: `https://x.com/${handle}/status/${tweetId}`
  };
}

function statusReferences(html, openingAttributes = {}) {
  const references = [];
  for (const candidate of Object.values(openingAttributes)) {
    const reference = statusReference(candidate);
    if (reference) references.push(reference);
  }
  for (const tag of scanHtmlTags(html)) {
    if (tag.closing) continue;
    for (const key of ['href', 'data-permalink-path', 'data-url', 'content']) {
      const reference = statusReference(tag.attributes[key]);
      if (reference) references.push(reference);
    }
  }
  return references;
}

function statusReferencesFromValue(value, { maximumNodes = 100 } = {}) {
  const references = [];
  const pending = [value];
  const visited = new Set();
  while (pending.length && visited.size < maximumNodes) {
    const current = pending.shift();
    if (current === null || current === undefined) continue;
    if (typeof current === 'string' || typeof current === 'number') {
      const reference = statusReference(current);
      if (reference) references.push(reference);
      continue;
    }
    if (typeof current !== 'object' || visited.has(current)) continue;
    visited.add(current);
    if (Array.isArray(current)) {
      pending.push(...current);
      continue;
    }
    for (const key of ['url', '@id', 'sameAs', 'identifier', 'content', 'href']) {
      if (Object.hasOwn(current, key)) pending.push(current[key]);
    }
  }
  return references;
}

function firstDifferentStatusReference(values, tweetId = '') {
  for (const value of values) {
    const reference = statusReferencesFromValue(value)
      .find((candidate) => candidate.tweetId !== String(tweetId || ''));
    if (reference) return reference;
  }
  return null;
}

function tagHasReplyContext(tag) {
  const itemprops = attributeTokens(tag.attributes.itemprop);
  const rels = attributeTokens(tag.attributes.rel);
  return itemprops.some((value) => value === 'inreplyto' || value === 'parentitem')
    || rels.some((value) => value === 'in-reply-to' || value === 'reply-to' || value === 'parent');
}

function taggedStatusReferences(html, predicate) {
  const references = [];
  const tags = scanHtmlTags(html);
  for (let index = 0; index < tags.length; index += 1) {
    const tag = tags[index];
    if (tag.closing || !predicate(tag)) continue;
    const candidates = [
      tag.attributes.href,
      tag.attributes.content,
      tag.attributes.itemid,
      tag.attributes.resource,
      tag.attributes['data-url'],
      tag.attributes['data-in-reply-to'],
      tag.attributes['data-in-reply-to-url'],
      tag.attributes['data-reply-to-url'],
      tag.attributes['data-parent-url']
    ];
    const range = innerRange(tags, index, html.length);
    if (range) candidates.push(html.slice(range.start, range.end));
    for (const candidate of candidates) {
      const reference = statusReference(candidate);
      if (reference) references.push(reference);
    }
  }
  return references;
}

function htmlReplyReferences(html, openingAttributes = {}) {
  const references = [];
  for (const key of [
    'data-in-reply-to',
    'data-in-reply-to-url',
    'data-reply-to-url',
    'data-parent-url'
  ]) {
    const reference = statusReference(openingAttributes[key]);
    if (reference) references.push(reference);
  }
  references.push(...taggedStatusReferences(html, tagHasReplyContext));
  return references;
}

function htmlIsPartOf(html, openingAttributes = {}) {
  const openingValue = openingAttributes['data-is-part-of'] || openingAttributes['data-conversation-url'];
  if (openingValue) return normalizeText(openingValue);
  const tags = scanHtmlTags(html);
  for (let index = 0; index < tags.length; index += 1) {
    const tag = tags[index];
    if (tag.closing || !attributeTokens(tag.attributes.itemprop).includes('ispartof')) continue;
    const attributeValue = tag.attributes.href
      || tag.attributes.content
      || tag.attributes.itemid
      || tag.attributes.resource
      || tag.attributes['data-url'];
    if (attributeValue) return normalizeText(attributeValue);
    const range = innerRange(tags, index, html.length);
    if (!range) continue;
    const text = htmlToText(html.slice(range.start, range.end));
    if (text) return text;
  }
  return null;
}

function handleFromValue(value) {
  if (!value) return '';
  if (typeof value === 'object') {
    for (const key of ['alternateName', 'identifier', 'username', 'screen_name', 'handle', 'url', 'sameAs']) {
      const handle = handleFromValue(value[key]);
      if (handle) return handle;
    }
    return '';
  }
  const text = String(value).trim();
  const urlMatch = /(?:https?:\/\/(?:www\.)?(?:x\.com|twitter\.com))?\/([a-z0-9_]{1,15})(?:\/|$)/i.exec(text);
  const candidate = (urlMatch?.[1] || text.replace(/^@/, '')).toLowerCase();
  return /^[a-z0-9_]{1,15}$/.test(candidate) ? candidate : '';
}

function structuredArticleCandidate(item) {
  if (!item || typeof item !== 'object' || Array.isArray(item)) return null;
  const publishedAt = timestampMilliseconds(item.datePublished ?? item.dateCreated ?? item.uploadDate);
  const reference = [item.url, item.mainEntityOfPage, item['@id']]
    .map((value) => typeof value === 'object' ? value?.['@id'] || value?.url : value)
    .map(statusReference)
    .find(Boolean);
  const tweetId = String(item.tweet_id || item.tweetId || item.identifier || reference?.tweetId || '').trim();
  if (!publishedAt || !/^\d{5,25}$/.test(tweetId)) return null;
  const authorValue = Array.isArray(item.author) ? item.author[0] : item.author;
  const authorHandle = reference?.handle || handleFromValue(authorValue);
  const authorName = authorValue && typeof authorValue === 'object'
    ? normalizeText(authorValue.name || '')
    : '';
  const isPartOf = item.isPartOf ?? null;
  const replyReference = firstDifferentStatusReference([
    item.inReplyTo,
    item.parentItem,
    isPartOf
  ], tweetId);
  return {
    tweetId,
    publishedAt,
    body: htmlToText(item.articleBody ?? item.text ?? item.description ?? item.headline ?? ''),
    authorHandle,
    authorName,
    url: reference?.url || '',
    isPartOf,
    replyParentUrl: replyReference?.url || '',
    replyToExternalId: replyReference?.tweetId || ''
  };
}

function htmlArticleCandidate(block, requestedHandle) {
  const references = statusReferences(block.html, block.attributes);
  const tags = scanHtmlTags(block.html);
  const tweetIdAttribute = [block.attributes, ...tags.filter((tag) => !tag.closing).map((tag) => tag.attributes)]
    .map((attributes) => attributes['data-tweet-id'] || attributes['data-status-id'] || attributes['data-item-id'])
    .find((value) => /^\d{5,25}$/.test(String(value || '').trim()));
  const explicitReplyReferences = htmlReplyReferences(block.html, block.attributes);
  const explicitReplyIds = new Set(explicitReplyReferences.map((item) => item.tweetId));
  const reference = references.find((item) => (
    item.handle !== 'i'
      && (!tweetIdAttribute || item.tweetId === String(tweetIdAttribute).trim())
      && !explicitReplyIds.has(item.tweetId)
  )) || references.find((item) => item.handle !== 'i' && !explicitReplyIds.has(item.tweetId))
    || references.find((item) => item.handle !== 'i')
    || references[0]
    || null;
  const tweetId = String(reference?.tweetId || tweetIdAttribute || '').trim();
  const dateValues = [
    ...elementValues(block.html, (tag) => attributeTokens(tag.attributes.itemprop).includes('datepublished')),
    ...elementValues(block.html, (tag) => tag.name === 'time' && Boolean(tag.attributes.datetime)),
    block.attributes['data-date-published'],
    block.attributes.datetime
  ];
  const publishedAt = dateValues.map(timestampMilliseconds).find((value) => value !== null) ?? null;
  if (!publishedAt || !/^\d{5,25}$/.test(tweetId)) return null;
  const body = [
    ...elementValues(block.html, (tag) => attributeTokens(tag.attributes.itemprop).includes('articlebody')),
    ...elementValues(block.html, (tag) => String(tag.attributes['data-testid'] || '').toLowerCase() === 'tweettext'),
    ...elementValues(block.html, (tag) => Object.hasOwn(tag.attributes, 'data-tweet-text'))
  ].find((value) => value !== undefined) || '';
  const authorHandle = (reference?.handle === 'i' ? '' : reference?.handle)
    || [block.attributes, ...tags.filter((tag) => !tag.closing).map((tag) => tag.attributes)]
      .map((attributes) => attributes['data-screen-name'] || attributes['data-username'] || attributes['data-author'])
      .map(handleFromValue)
      .find(Boolean)
    || requestedHandle;
  const authorName = elementValues(block.html, (tag) => (
    attributeTokens(tag.attributes.itemprop).includes('author')
      || String(tag.attributes['data-testid'] || '').toLowerCase() === 'user-name'
  ))[0] || '';
  const isPartOf = htmlIsPartOf(block.html, block.attributes);
  const replyReference = explicitReplyReferences.find((item) => item.tweetId !== tweetId)
    || firstDifferentStatusReference([isPartOf], tweetId);
  return {
    tweetId,
    publishedAt,
    body,
    authorHandle,
    authorName,
    url: reference?.handle && reference.handle !== 'i'
      ? reference.url
      : (authorHandle ? `https://x.com/${authorHandle}/status/${tweetId}` : ''),
    isPartOf,
    replyParentUrl: replyReference?.url || '',
    replyToExternalId: replyReference?.tweetId || ''
  };
}

function publicPost(candidate, requestedHandle, articleIndex) {
  if (!candidate) return null;
  const authorHandle = handleFromValue(candidate.authorHandle) || requestedHandle;
  if (!authorHandle) return null;
  const publishedAt = Number(candidate.publishedAt);
  if (!Number.isSafeInteger(publishedAt) || publishedAt <= 0) return null;
  return {
    source: 'twitter',
    kind: candidate.replyToExternalId ? 'reply' : 'post',
    externalId: candidate.tweetId,
    tweetId: candidate.tweetId,
    body: normalizeText(candidate.body),
    content: normalizeText(candidate.body),
    publishedAt,
    datePublished: new Date(publishedAt).toISOString(),
    author: {
      handle: authorHandle,
      name: normalizeText(candidate.authorName)
    },
    url: candidate.url || `https://x.com/${authorHandle}/status/${candidate.tweetId}`,
    isPartOf: candidate.isPartOf ?? null,
    replyParentUrl: candidate.replyParentUrl || '',
    replyToExternalId: candidate.replyToExternalId || '',
    articleIndex
  };
}

function mergeDuplicatePosts(previous, next) {
  const nextWins = next.publishedAt > previous.publishedAt
    || (next.publishedAt === previous.publishedAt && next.body.length > previous.body.length);
  const winner = nextWins ? next : previous;
  const other = nextWins ? previous : next;
  const richerContent = next.body.length > previous.body.length ? next.body : previous.body;
  const replyToExternalId = winner.replyToExternalId || other.replyToExternalId;
  return {
    ...other,
    ...winner,
    kind: replyToExternalId ? 'reply' : winner.kind,
    body: richerContent,
    content: richerContent,
    author: {
      handle: winner.author.handle || other.author.handle,
      name: winner.author.name || other.author.name
    },
    url: winner.url || other.url,
    isPartOf: winner.isPartOf ?? other.isPartOf ?? null,
    replyParentUrl: winner.replyParentUrl || other.replyParentUrl,
    replyToExternalId
  };
}

export function parseXProfileArticles(value, { requestedHandle = '' } = {}) {
  const html = String(value || '');
  const fallbackHandle = requestedHandle ? normalizedHandle(requestedHandle) : '';
  const posts = [];
  const byTweetId = new Map();
  for (const [articleIndex, block] of articleBlocks(html).entries()) {
    const structured = jsonLdObjects(block.html)
      .map(structuredArticleCandidate)
      .filter(Boolean)
      .sort((left, right) => right.publishedAt - left.publishedAt)[0];
    const candidate = structured || htmlArticleCandidate(block, fallbackHandle);
    const post = publicPost(candidate, fallbackHandle, articleIndex);
    if (!post) continue;
    const previous = byTweetId.get(post.tweetId);
    byTweetId.set(post.tweetId, previous ? mergeDuplicatePosts(previous, post) : post);
  }
  posts.push(...byTweetId.values());
  return posts.sort((left, right) => (
    right.publishedAt - left.publishedAt || left.articleIndex - right.articleIndex
  ));
}

export function parseXProfileHtml(value, options = {}) {
  return parseXProfileArticles(value, options);
}

export function parseLatestXProfilePost(value, options = {}) {
  return parseXProfileHtml(value, options)[0] || null;
}

export class XProfileMonitorError extends Error {
  constructor(message, { code = 'X_PROFILE_ERROR', status = null, retryable = false, retryAfterMs = null, cause } = {}) {
    super(message, cause === undefined ? undefined : { cause });
    this.name = 'XProfileMonitorError';
    this.code = code;
    this.status = status;
    this.retryable = retryable;
    this.retryAfterMs = retryAfterMs;
  }
}

function retryAfterMilliseconds(response, now) {
  const value = response?.headers?.get?.('retry-after');
  if (value === null || value === undefined || String(value).trim() === '') return null;
  const seconds = Number(value);
  if (Number.isFinite(seconds) && seconds >= 0) return Math.ceil(seconds * 1_000);
  const date = Date.parse(String(value));
  return Number.isFinite(date) ? Math.max(0, date - now) : null;
}

function abortReason(signal) {
  if (signal?.reason instanceof Error) return signal.reason;
  const error = new Error('X profile monitor was aborted');
  error.name = 'AbortError';
  return error;
}

function publicError(error) {
  return {
    code: String(error?.code || 'X_PROFILE_ERROR'),
    message: String(error?.message || 'X profile request failed'),
    status: Number.isInteger(error?.status) ? error.status : null,
    retryable: error?.retryable === true
  };
}

export class XProfileMonitor {
  constructor({
    accounts = [],
    fetchImpl = globalThis.fetch,
    concurrency = 2,
    timeoutMs = 3_000,
    backoffBaseMs = 2_000,
    backoffMaxMs = 60_000,
    maxHtmlBytes = 2 * 1024 * 1024,
    maxSeenPerAccount = 128,
    now = Date.now,
    setTimeoutImpl = setTimeout,
    clearTimeoutImpl = clearTimeout,
    userAgent = DEFAULT_USER_AGENT
  } = {}) {
    if (typeof fetchImpl !== 'function') throw new TypeError('fetchImpl is required');
    if (typeof now !== 'function') throw new TypeError('now must be a function');
    if (typeof setTimeoutImpl !== 'function' || typeof clearTimeoutImpl !== 'function') {
      throw new TypeError('timer implementations must be functions');
    }
    this.fetchImpl = fetchImpl;
    this.concurrency = boundedInteger(concurrency, 2, 1, 8);
    this.timeoutMs = boundedInteger(timeoutMs, 3_000, 10, 60_000);
    this.backoffBaseMs = boundedInteger(backoffBaseMs, 2_000, 10, 10 * 60_000);
    this.backoffMaxMs = boundedInteger(backoffMaxMs, 60_000, this.backoffBaseMs, 60 * 60_000);
    this.maxHtmlBytes = boundedInteger(maxHtmlBytes, 2 * 1024 * 1024, 1_024, 10 * 1024 * 1024);
    this.maxSeenPerAccount = boundedInteger(maxSeenPerAccount, 128, 1, 10_000);
    this.now = now;
    this.setTimeoutImpl = setTimeoutImpl;
    this.clearTimeoutImpl = clearTimeoutImpl;
    this.userAgent = String(userAgent || DEFAULT_USER_AGENT).slice(0, 500);
    this.states = new Map();
    this.activeRequests = 0;
    this.requestWaiters = [];
    this.accounts = [];
    this.setAccounts(accounts);
  }

  setAccounts(accounts) {
    const unique = new Set();
    this.accounts = (Array.isArray(accounts) ? accounts : [])
      .map((account) => normalizedHandle(typeof account === 'string' ? account : account?.handle))
      .filter((handle) => {
        if (unique.has(handle)) return false;
        unique.add(handle);
        return true;
      });
    return [...this.accounts];
  }

  accountState(handle) {
    const key = normalizedHandle(handle);
    const state = this.states.get(key);
    return {
      handle: key,
      consecutiveFailures: state?.consecutiveFailures || 0,
      nextAttemptAt: state?.nextAttemptAt || 0,
      seenCount: state?.seen?.size || 0,
      pendingCount: state?.pending?.size || 0,
      inFlight: state?.inFlight === true
    };
  }

  remember(handle, tweetId) {
    const state = this.#state(normalizedHandle(handle));
    this.#remember(state, String(tweetId || '').trim());
  }

  confirm(handle, tweetIds) {
    const state = this.#state(normalizedHandle(handle));
    const values = Array.isArray(tweetIds) ? tweetIds : [tweetIds];
    let confirmed = 0;
    for (const value of values) {
      const tweetId = String(value || '').trim();
      if (!/^\d{5,25}$/.test(tweetId)) continue;
      this.#remember(state, tweetId);
      confirmed += 1;
    }
    return confirmed;
  }

  clearDedupe(handle = null) {
    if (handle === null || handle === undefined) {
      for (const state of this.states.values()) state.seen.clear();
      return;
    }
    this.#state(normalizedHandle(handle)).seen.clear();
  }

  async pollOnce(accounts = this.accounts, { signal = null, onResult = null } = {}) {
    if (signal?.aborted) throw abortReason(signal);
    if (onResult !== null && typeof onResult !== 'function') {
      throw new TypeError('onResult must be a function');
    }
    const handles = [];
    const unique = new Set();
    for (const account of Array.isArray(accounts) ? accounts : []) {
      const handle = normalizedHandle(typeof account === 'string' ? account : account?.handle);
      if (unique.has(handle)) continue;
      unique.add(handle);
      handles.push(handle);
    }
    const results = new Array(handles.length);
    await Promise.all(handles.map(async (handle, index) => {
      const state = this.#state(handle);
      if (state.inFlight) {
        results[index] = {
          handle,
          status: 'inflight',
          checkedAt: this.now(),
          posts: [],
          requestMade: false
        };
        return;
      }
      state.inFlight = true;
      try {
        const result = await this.#pollAccount(handle, { signal });
        results[index] = result;
        if (onResult) {
          try {
            await onResult(result);
          } catch (error) {
            result.deliveryError = publicError(error);
          }
        }
      } finally {
        state.inFlight = false;
      }
    }));
    return {
      checkedAt: this.now(),
      posts: results
        .filter((result) => result?.status === 'new')
        .flatMap((result) => result.posts || (result.post ? [result.post] : [])),
      results
    };
  }

  poll(accounts = this.accounts, options = {}) {
    return this.pollOnce(accounts, options);
  }

  #state(handle) {
    let state = this.states.get(handle);
    if (!state) {
      state = {
        consecutiveFailures: 0,
        nextAttemptAt: 0,
        seen: new Map(),
        pending: new Map(),
        inFlight: false
      };
      this.states.set(handle, state);
    }
    return state;
  }

  #remember(state, tweetId) {
    if (!/^\d{5,25}$/.test(tweetId)) return;
    state.pending.delete(tweetId);
    state.seen.delete(tweetId);
    state.seen.set(tweetId, this.now());
    while (state.seen.size > this.maxSeenPerAccount) {
      state.seen.delete(state.seen.keys().next().value);
    }
  }

  #pendingPosts(state) {
    return [...state.pending.values()].sort((left, right) => (
      right.publishedAt - left.publishedAt || left.articleIndex - right.articleIndex
    ));
  }

  #retainPendingPosts(state, posts) {
    for (const post of [...posts].reverse()) {
      if (state.seen.has(post.tweetId)) continue;
      state.pending.delete(post.tweetId);
      state.pending.set(post.tweetId, post);
    }
    while (state.pending.size > this.maxSeenPerAccount) {
      state.pending.delete(state.pending.keys().next().value);
    }
    return this.#pendingPosts(state);
  }

  #acquireRequestSlot(signal) {
    if (signal?.aborted) return Promise.reject(abortReason(signal));
    if (this.activeRequests < this.concurrency) {
      this.activeRequests += 1;
      return Promise.resolve();
    }
    return new Promise((resolve, reject) => {
      const waiter = { resolve, reject, signal, onAbort: null };
      if (signal) {
        waiter.onAbort = () => {
          const index = this.requestWaiters.indexOf(waiter);
          if (index >= 0) this.requestWaiters.splice(index, 1);
          reject(abortReason(signal));
        };
        signal.addEventListener('abort', waiter.onAbort, { once: true });
      }
      this.requestWaiters.push(waiter);
      if (signal?.aborted) waiter.onAbort();
    });
  }

  #releaseRequestSlot() {
    this.activeRequests = Math.max(0, this.activeRequests - 1);
    while (this.requestWaiters.length) {
      const waiter = this.requestWaiters.shift();
      if (waiter.signal?.aborted) {
        waiter.signal?.removeEventListener('abort', waiter.onAbort);
        waiter.reject(abortReason(waiter.signal));
        continue;
      }
      waiter.signal?.removeEventListener('abort', waiter.onAbort);
      this.activeRequests += 1;
      waiter.resolve();
      break;
    }
  }

  async #withRequestSlot(operation, signal) {
    await this.#acquireRequestSlot(signal);
    try {
      return await operation();
    } finally {
      this.#releaseRequestSlot();
    }
  }

  #retryDelay(state, retryAfterMs = null) {
    const exponent = Math.min(30, Math.max(0, state.consecutiveFailures - 1));
    const exponential = Math.min(this.backoffMaxMs, this.backoffBaseMs * (2 ** exponent));
    const requested = Number(retryAfterMs);
    return Number.isFinite(requested) && requested >= 0
      ? Math.min(this.backoffMaxMs, Math.max(exponential, Math.ceil(requested)))
      : exponential;
  }

  #scheduleBackoff(state, retryAfterMs = null) {
    state.consecutiveFailures += 1;
    const retryAt = this.now() + this.#retryDelay(state, retryAfterMs);
    state.nextAttemptAt = retryAt;
    return retryAt;
  }

  async #pollAccount(handle, { signal }) {
    const state = this.#state(handle);
    const startedAt = this.now();
    const pendingPosts = this.#pendingPosts(state);
    if (pendingPosts.length) {
      return {
        handle,
        status: 'new',
        checkedAt: startedAt,
        post: pendingPosts[0],
        posts: pendingPosts,
        requestMade: false
      };
    }
    if (state.nextAttemptAt > startedAt) {
      return {
        handle,
        status: 'backoff',
        checkedAt: startedAt,
        posts: [],
        requestMade: false,
        retryAt: state.nextAttemptAt,
        waitMs: state.nextAttemptAt - startedAt,
        consecutiveFailures: state.consecutiveFailures
      };
    }
    try {
      const html = await this.#withRequestSlot(
        () => this.#fetchProfileHtml(handle, { signal }),
        signal
      );
      const profilePosts = parseXProfileHtml(html, { requestedHandle: handle })
        .filter((item) => item.author.handle.toLowerCase() === handle);
      if (!profilePosts.length) {
        const retryAt = this.#scheduleBackoff(state);
        return {
          handle,
          status: 'empty',
          checkedAt: this.now(),
          post: null,
          posts: [],
          requestMade: true,
          retryAt,
          consecutiveFailures: state.consecutiveFailures
        };
      }
      state.consecutiveFailures = 0;
      state.nextAttemptAt = 0;
      const posts = this.#retainPendingPosts(state, profilePosts);
      if (!posts.length) {
        return {
          handle,
          status: 'duplicate',
          checkedAt: this.now(),
          post: profilePosts[0],
          posts: [],
          requestMade: true
        };
      }
      return {
        handle,
        status: 'new',
        checkedAt: this.now(),
        post: posts[0],
        posts,
        requestMade: true
      };
    } catch (rawError) {
      if (signal?.aborted) throw abortReason(signal);
      const error = rawError instanceof XProfileMonitorError
        ? rawError
        : new XProfileMonitorError(`X profile request failed: ${rawError?.message || 'network error'}`, {
            code: 'NETWORK',
            retryable: true,
            cause: rawError instanceof Error ? rawError : undefined
          });
      let retryAt = 0;
      if (error.retryable) {
        retryAt = this.#scheduleBackoff(state, error.retryAfterMs);
      } else {
        state.consecutiveFailures = 0;
        state.nextAttemptAt = 0;
      }
      return {
        handle,
        status: 'error',
        checkedAt: this.now(),
        error: publicError(error),
        posts: [],
        requestMade: true,
        retryAt,
        consecutiveFailures: state.consecutiveFailures
      };
    }
  }

  async #fetchProfileHtml(handle, { signal }) {
    if (signal?.aborted) throw abortReason(signal);
    const controller = new AbortController();
    let timedOut = false;
    let timeoutId = null;
    let removeAbortListener = () => {};
    const timeoutPromise = new Promise((resolve, reject) => {
      timeoutId = this.setTimeoutImpl(() => {
        timedOut = true;
        const error = new XProfileMonitorError(`X profile request timed out after ${this.timeoutMs}ms`, {
          code: 'TIMEOUT',
          retryable: true
        });
        controller.abort(error);
        reject(error);
      }, this.timeoutMs);
    });
    const parentAbortPromise = signal
      ? new Promise((resolve, reject) => {
          const onAbort = () => {
            const error = abortReason(signal);
            controller.abort(error);
            reject(error);
          };
          signal.addEventListener('abort', onAbort, { once: true });
          removeAbortListener = () => signal.removeEventListener('abort', onAbort);
        })
      : null;
    const requestPromise = Promise.resolve().then(() => this.fetchImpl(`https://x.com/${encodeURIComponent(handle)}`, {
      method: 'GET',
      redirect: 'follow',
      signal: controller.signal,
      headers: {
        accept: 'text/html,application/xhtml+xml',
        'accept-language': 'en-US,en;q=0.8',
        'cache-control': 'no-cache',
        pragma: 'no-cache',
        'user-agent': this.userAgent
      }
    }));
    const raceRequest = (promise) => Promise.race([
      promise,
      timeoutPromise,
      ...(parentAbortPromise ? [parentAbortPromise] : [])
    ]);
    try {
      const response = await raceRequest(requestPromise);
      const status = Number(response?.status || 0);
      if (!response?.ok) {
        const retryable = status === 403 || status === 408 || status === 425 || status === 429 || status >= 500;
        throw new XProfileMonitorError(`X profile request failed with HTTP ${status || 'unknown'}`, {
          code: status ? `HTTP_${status}` : 'INVALID_RESPONSE',
          status: status || null,
          retryable,
          retryAfterMs: retryAfterMilliseconds(response, this.now())
        });
      }
      const contentLength = Number(response.headers?.get?.('content-length'));
      if (Number.isFinite(contentLength) && contentLength > this.maxHtmlBytes) {
        throw new XProfileMonitorError('X profile response is too large', {
          code: 'RESPONSE_TOO_LARGE',
          retryable: false
        });
      }
      if (typeof response.text !== 'function') {
        throw new XProfileMonitorError('X profile response does not contain HTML', {
          code: 'INVALID_RESPONSE',
          retryable: false
        });
      }
      const html = await raceRequest(Promise.resolve().then(() => response.text()));
      if (Buffer.byteLength(html, 'utf8') > this.maxHtmlBytes) {
        throw new XProfileMonitorError('X profile response is too large', {
          code: 'RESPONSE_TOO_LARGE',
          retryable: false
        });
      }
      return html;
    } catch (error) {
      if (signal?.aborted) throw abortReason(signal);
      if (timedOut || error?.code === 'TIMEOUT') {
        throw error instanceof XProfileMonitorError
          ? error
          : new XProfileMonitorError(`X profile request timed out after ${this.timeoutMs}ms`, {
              code: 'TIMEOUT', retryable: true, cause: error
            });
      }
      if (error instanceof XProfileMonitorError) throw error;
      throw new XProfileMonitorError(`X profile request failed: ${error?.message || 'network error'}`, {
        code: 'NETWORK',
        retryable: true,
        cause: error instanceof Error ? error : undefined
      });
    } finally {
      if (timeoutId !== null) this.clearTimeoutImpl(timeoutId);
      removeAbortListener();
    }
  }
}

export function createXProfileMonitor(options = {}) {
  return new XProfileMonitor(options);
}
