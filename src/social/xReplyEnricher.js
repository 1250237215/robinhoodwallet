import { parseXProfileHtml } from './xProfileMonitor.js';
import { shouldTranslateSocialText } from './deepseekTranslator.js';

const X_STATUS_URL = /^https:\/\/(?:www\.)?(?:x|twitter)\.com\/[a-z0-9_]{1,15}\/status\/\d{5,25}(?:[/?#]|$)/i;
const X_RESPONSE_URL = /^https:\/\/(?:www\.)?(?:x|twitter)\.com(?:[/?#]|$)/i;
const FXTWITTER_RESPONSE_URL = /^https:\/\/api\.fxtwitter\.com(?:[/?#]|$)/i;
const STATUS_ID = /^\d{5,25}$/;

function statusIdFromUrl(value) {
  return /\/(?:status|statuses)\/(\d{5,25})(?:[/?#]|$)/i.exec(String(value || ''))?.[1] || '';
}

function statusHandleFromUrl(value) {
  return /^https:\/\/(?:www\.)?(?:x|twitter)\.com\/([a-z0-9_]{1,15})\/(?:status|statuses)\/\d{5,25}(?:[/?#]|$)/i
    .exec(String(value || ''))?.[1] || '';
}

export function replyContextNeedsEnrichment(post, { translationRequired = true } = {}) {
  if (!post || String(post.kind || '').toLowerCase() !== 'reply') return false;
  const context = post.replyContext && typeof post.replyContext === 'object' ? post.replyContext : {};
  const externalId = String(context.externalId || '').trim();
  const content = String(context.content || '').trim();
  const translatedContent = String(context.translatedContent || '').trim();
  const handle = String(context.author?.handle || '').replace(/^@/, '').trim();
  const url = String(context.url || '').trim();
  return !STATUS_ID.test(externalId)
    || !content
    || (translationRequired && shouldTranslateSocialText(content) && !translatedContent)
    || !/^[a-z0-9_]{1,15}$/i.test(handle)
    || !X_STATUS_URL.test(url)
    || statusIdFromUrl(url) !== externalId;
}

export function quoteContextNeedsEnrichment(post, { translationRequired = true } = {}) {
  if (!post || String(post.kind || '').toLowerCase() !== 'quote') return false;
  const context = post.quoteContext && typeof post.quoteContext === 'object' ? post.quoteContext : {};
  const externalId = String(context.externalId || post.quotedExternalId || '').trim();
  const content = String(context.content || '').trim();
  const translatedContent = String(context.translatedContent || '').trim();
  const handle = String(context.author?.handle || '').replace(/^@/, '').trim();
  const url = String(context.url || '').trim();
  return !STATUS_ID.test(externalId)
    || !content
    || (translationRequired && shouldTranslateSocialText(content) && !translatedContent)
    || !/^[a-z0-9_]{1,15}$/i.test(handle)
    || !X_STATUS_URL.test(url)
    || statusIdFromUrl(url) !== externalId;
}

export function referenceContextNeedsEnrichment(post, options = {}) {
  return replyContextNeedsEnrichment(post, options) || quoteContextNeedsEnrichment(post, options);
}

function boundedInteger(value, fallback, minimum, maximum) {
  const number = Number(value);
  if (!Number.isFinite(number)) return fallback;
  return Math.min(maximum, Math.max(minimum, Math.floor(number)));
}

function abortError(message = 'X reply enrichment was aborted') {
  const error = new Error(message);
  error.name = 'AbortError';
  return error;
}

async function withTimeout(operation, timeoutMs, parentSignal = null) {
  if (parentSignal?.aborted) throw parentSignal.reason instanceof Error ? parentSignal.reason : abortError();
  const controller = new AbortController();
  let timedOut = false;
  let rejectTimeout;
  let rejectParentAbort;
  const timeoutPromise = new Promise((resolve, reject) => {
    rejectTimeout = reject;
  });
  const parentAbortPromise = new Promise((resolve, reject) => {
    rejectParentAbort = reject;
  });
  const timer = setTimeout(() => {
    timedOut = true;
    const error = abortError(`X reply enrichment timed out after ${timeoutMs}ms`);
    controller.abort(error);
    rejectTimeout(error);
  }, timeoutMs);
  timer.unref?.();
  const onAbort = () => {
    const error = parentSignal.reason instanceof Error ? parentSignal.reason : abortError();
    controller.abort(error);
    rejectParentAbort(error);
  };
  parentSignal?.addEventListener('abort', onAbort, { once: true });
  try {
    return await Promise.race([
      Promise.resolve().then(() => operation(controller.signal)),
      timeoutPromise,
      ...(parentSignal ? [parentAbortPromise] : [])
    ]);
  } catch (error) {
    if (timedOut && error?.name !== 'AbortError') throw abortError(`X reply enrichment timed out after ${timeoutMs}ms`);
    throw error;
  } finally {
    clearTimeout(timer);
    parentSignal?.removeEventListener('abort', onAbort);
  }
}

async function responseTextWithinLimit(response, maximumBytes) {
  const contentLength = Number(response.headers?.get?.('content-length'));
  if (Number.isFinite(contentLength) && contentLength > maximumBytes) return '';
  if (response.body && typeof response.body.getReader === 'function') {
    const reader = response.body.getReader();
    const decoder = new TextDecoder();
    let bytes = 0;
    let result = '';
    try {
      while (true) {
        const { done, value } = await reader.read();
        if (done) break;
        bytes += value?.byteLength || 0;
        if (bytes > maximumBytes) {
          await reader.cancel().catch(() => {});
          return '';
        }
        result += decoder.decode(value, { stream: true });
      }
      return result + decoder.decode();
    } finally {
      reader.releaseLock?.();
    }
  }
  if (typeof response.text !== 'function') return '';
  const value = await response.text();
  return Buffer.byteLength(value, 'utf8') <= maximumBytes ? value : '';
}

async function fetchXHtml(url, { fetchImpl, timeoutMs, maxHtmlBytes, signal }) {
  return withTimeout(async (requestSignal) => {
    const response = await fetchImpl(url, {
      method: 'GET',
      redirect: 'follow',
      signal: requestSignal,
      headers: {
        accept: 'text/html,application/xhtml+xml',
        'accept-language': 'en-US,en;q=0.8',
        'cache-control': 'no-cache',
        'user-agent': 'Mozilla/5.0 AppleWebKit/537.36 Chrome/130.0 Safari/537.36'
      }
    });
    if (!response?.ok) return '';
    const finalUrl = String(response.url || '');
    if (finalUrl && !X_RESPONSE_URL.test(finalUrl)) return '';
    return responseTextWithinLimit(response, maxHtmlBytes);
  }, boundedInteger(timeoutMs, 4_000, 250, 30_000), signal);
}

async function fetchFxTwitterQuote(externalId, { fetchImpl, timeoutMs, maxJsonBytes, signal }) {
  const url = `https://api.fxtwitter.com/status/${externalId}`;
  return withTimeout(async (requestSignal) => {
    const response = await fetchImpl(url, {
      method: 'GET',
      redirect: 'follow',
      signal: requestSignal,
      headers: {
        accept: 'application/json',
        'accept-language': 'en-US,en;q=0.8',
        'user-agent': 'Mozilla/5.0 AppleWebKit/537.36 Chrome/130.0 Safari/537.36'
      }
    });
    if (!response?.ok) return null;
    const finalUrl = String(response.url || url);
    if (!FXTWITTER_RESPONSE_URL.test(finalUrl)) return null;
    const raw = await responseTextWithinLimit(response, maxJsonBytes);
    if (!raw) return null;
    let payload;
    try {
      payload = JSON.parse(raw);
    } catch {
      return null;
    }
    const outer = payload?.tweet;
    if (!outer || String(outer.id || '') !== externalId) return null;
    return outer.quote && typeof outer.quote === 'object' ? outer.quote : null;
  }, boundedInteger(timeoutMs, 4_000, 250, 30_000), signal);
}

export async function fetchXQuoteContext(post, {
  fetchImpl = globalThis.fetch,
  translateImpl = null,
  timeoutMs = 4_000,
  translationTimeoutMs = 2_000,
  maxJsonBytes = 2 * 1024 * 1024,
  onOriginal = null,
  signal = null
} = {}) {
  if (!post || String(post.kind || '').toLowerCase() !== 'quote') return null;
  const externalId = String(post.externalId || '').trim();
  const postUrl = String(post.url || '').trim();
  if (!STATUS_ID.test(externalId)
    || !X_STATUS_URL.test(postUrl)
    || statusIdFromUrl(postUrl) !== externalId
    || typeof fetchImpl !== 'function') return null;

  const existingContext = post.quoteContext && typeof post.quoteContext === 'object' ? post.quoteContext : {};
  const existingId = String(existingContext.externalId || post.quotedExternalId || '').trim();
  const existingUrl = String(existingContext.url || '').trim();
  const existingHandle = String(existingContext.author?.handle || statusHandleFromUrl(existingUrl) || '')
    .replace(/^@/, '')
    .trim();
  const existingIsUsable = STATUS_ID.test(existingId)
    && String(existingContext.content || '').trim()
    && /^[a-z0-9_]{1,15}$/i.test(existingHandle)
    && X_STATUS_URL.test(existingUrl)
    && statusIdFromUrl(existingUrl) === existingId;

  let quote = existingIsUsable ? {
    id: existingId,
    text: String(existingContext.content).trim(),
    author: {
      id: String(existingContext.author?.id || ''),
      screen_name: existingHandle,
      name: String(existingContext.author?.name || ''),
      avatar_url: String(existingContext.author?.avatarUrl || '')
    },
    url: existingUrl,
    created_timestamp: Math.floor(Number(existingContext.publishedAt || 0) / 1_000)
  } : null;
  if (!quote) {
    quote = await fetchFxTwitterQuote(externalId, {
      fetchImpl,
      timeoutMs,
      maxJsonBytes,
      signal
    });
  }

  const quoteId = String(quote?.id || '').trim();
  const quoteContent = String(quote?.text || '').trim();
  const quoteHandle = String(quote?.author?.screen_name || '').replace(/^@/, '').trim();
  if (!STATUS_ID.test(quoteId) || !quoteContent || !/^[a-z0-9_]{1,15}$/i.test(quoteHandle)) return null;
  if (STATUS_ID.test(existingId) && quoteId !== existingId) return null;
  const suppliedQuoteUrl = String(quote.url || '').trim();
  const quoteUrl = X_STATUS_URL.test(suppliedQuoteUrl) && statusIdFromUrl(suppliedQuoteUrl) === quoteId
    ? suppliedQuoteUrl
    : `https://x.com/${quoteHandle}/status/${quoteId}`;
  const createdTimestamp = Number(quote.created_timestamp || 0);
  const parsedCreatedAt = Date.parse(String(quote.created_at || ''));
  const publishedAt = Number.isFinite(createdTimestamp) && createdTimestamp > 0
    ? Math.trunc(createdTimestamp * 1_000)
    : Number.isFinite(parsedCreatedAt) ? parsedCreatedAt : 0;
  const original = {
    source: 'twitter',
    externalId,
    kind: 'quote',
    quotedExternalId: quoteId,
    quoteContext: {
      externalId: quoteId,
      author: {
        id: String(quote.author?.id || ''),
        handle: quoteHandle,
        name: String(quote.author?.name || ''),
        avatarUrl: String(quote.author?.avatar_url || '')
      },
      content: quoteContent,
      translatedContent: '',
      url: quoteUrl,
      publishedAt
    },
    sourceUpdatedAt: Number(post.sourceUpdatedAt || post.publishedAt || Date.now())
  };
  const existingTranslation = existingId === quoteId
    ? String(existingContext.translatedContent || '').trim()
    : '';
  if (!existingTranslation && typeof onOriginal === 'function') await onOriginal(original);
  const translatedContent = existingTranslation || (typeof translateImpl === 'function'
    ? await translateImpl(quoteContent, {
        fetchImpl,
        timeoutMs: translationTimeoutMs,
        signal
      })
    : '');
  return translatedContent
    ? { ...original, quoteContext: { ...original.quoteContext, translatedContent } }
    : original;
}

export async function fetchXReferenceContext(post, options = {}) {
  return String(post?.kind || '').toLowerCase() === 'quote'
    ? fetchXQuoteContext(post, options)
    : fetchXReplyContext(post, options);
}

export async function fetchXReplyContext(post, {
  fetchImpl = globalThis.fetch,
  translateImpl = null,
  timeoutMs = 4_000,
  translationTimeoutMs = 2_000,
  maxHtmlBytes = 2 * 1024 * 1024,
  onOriginal = null,
  signal = null
} = {}) {
  if (!post || String(post.kind || '').toLowerCase() !== 'reply') return null;
  const externalId = String(post.externalId || '').trim();
  const postUrl = String(post.url || '').trim();
  if (!STATUS_ID.test(externalId) || !X_STATUS_URL.test(postUrl) || typeof fetchImpl !== 'function') return null;

  const existingContext = post.replyContext && typeof post.replyContext === 'object' ? post.replyContext : {};
  const existingId = String(existingContext.externalId || '').trim();
  const existingUrl = String(existingContext.url || '').trim();
  const existingUrlHandle = statusHandleFromUrl(existingUrl);
  let parent = STATUS_ID.test(existingId)
    && String(existingContext.content || '').trim()
    && X_STATUS_URL.test(existingUrl)
    && statusIdFromUrl(existingUrl) === existingId
    ? {
        externalId: existingId,
        content: String(existingContext.content).trim(),
        translatedContent: String(existingContext.translatedContent || '').trim(),
        author: {
          ...(existingContext.author || {}),
          handle: String(existingContext.author?.handle || existingUrlHandle)
        },
        url: existingUrl,
        publishedAt: Number(existingContext.publishedAt || 0)
      }
    : null;

  const html = parent ? '' : await fetchXHtml(postUrl, {
    fetchImpl,
    timeoutMs,
    maxHtmlBytes,
    signal
  });
  if (!parent && !html) return null;

  const articles = parent ? [] : parseXProfileHtml(html, { requestedHandle: post.author?.handle || '' });
  const current = articles.find((item) => item.externalId === externalId);
  const suppliedReplyId = STATUS_ID.test(String(post.replyToExternalId || ''))
    ? String(post.replyToExternalId)
    : '';
  const parentId = parent?.externalId || current?.replyToExternalId || suppliedReplyId;
  parent ||= parentId ? articles.find((item) => item.externalId === parentId) : null;
  if (!parent?.content && parentId) {
    const targetHandle = String(
      post.replyContext?.author?.handle
      || post.target?.handle
      || ''
    ).replace(/^@/, '');
    const referencedUrl = current?.replyParentUrl && statusIdFromUrl(current.replyParentUrl) === parentId
      ? current.replyParentUrl
      : (/^[a-z0-9_]{1,15}$/i.test(targetHandle)
          ? `https://x.com/${targetHandle}/status/${parentId}`
          : '');
    if (X_STATUS_URL.test(referencedUrl)) {
      const parentHtml = await fetchXHtml(referencedUrl, {
        fetchImpl,
        timeoutMs,
        maxHtmlBytes,
        signal
      });
      parent = parseXProfileHtml(parentHtml, { requestedHandle: targetHandle })
        .find((item) => item.externalId === parentId) || null;
    }
  }
  if (!parent?.content) return null;

  const parentHandle = String(parent.author?.handle || post.target?.handle || '').replace(/^@/, '');
  const original = {
    source: 'twitter',
    externalId,
    kind: 'reply',
    target: {
      id: '',
      handle: parentHandle,
      name: String(parent.author?.name || post.target?.name || ''),
      avatarUrl: '',
      followers: 0,
      url: parentHandle ? `https://x.com/${parentHandle}` : ''
    },
    replyToExternalId: parent.externalId,
    replyContext: {
      externalId: parent.externalId,
      author: {
        id: '',
        handle: parentHandle,
        name: String(parent.author?.name || ''),
        avatarUrl: ''
      },
      content: parent.content,
      translatedContent: '',
      url: parent.url,
      publishedAt: parent.publishedAt
    },
    sourceUpdatedAt: Number(post.sourceUpdatedAt || post.publishedAt || Date.now())
  };
  const existingTranslation = String(parent.translatedContent || '').trim();
  if (!existingTranslation && typeof onOriginal === 'function') await onOriginal(original);
  const translatedContent = existingTranslation || (typeof translateImpl === 'function'
    ? await translateImpl(parent.content, {
        fetchImpl,
        timeoutMs: translationTimeoutMs,
        signal
      })
    : '');
  return translatedContent
    ? { ...original, replyContext: { ...original.replyContext, translatedContent } }
    : original;
}

export function createXReplyEnricher({
  fetchImpl = globalThis.fetch,
  translateImpl = null,
  onEnriched,
  concurrency = 2,
  maxQueue = 200,
  timeoutMs = 4_000,
  translationTimeoutMs = 2_000,
  retryDelaysMs = [2_000, 4_000, 8_000],
  emitOriginalFirst = false,
  translationRequired = true
} = {}) {
  if (typeof onEnriched !== 'function') throw new TypeError('onEnriched is required');
  const limit = boundedInteger(concurrency, 2, 1, 4);
  const queueLimit = boundedInteger(maxQueue, 200, 1, 1_000);
  const queue = new Map();
  const activeKeys = new Set();
  const pendingByKey = new Map();
  const retryTimers = new Map();
  const retryPosts = new Map();
  const retryAttempts = new Map();
  const controller = new AbortController();
  let active = 0;
  let closed = false;
  const stats = { enriched: 0, failures: 0, retries: 0, exhausted: 0 };
  const needsEnrichment = (post) => referenceContextNeedsEnrichment(post, { translationRequired });

  const normalizedRetryDelays = (Array.isArray(retryDelaysMs) ? retryDelaysMs : [])
    .map((value) => boundedInteger(value, 2_000, 10, 60_000))
    .slice(0, 8);

  const newerPost = (previous, next) => Number(next?.sourceUpdatedAt || next?.publishedAt || 0)
    >= Number(previous?.sourceUpdatedAt || previous?.publishedAt || 0) ? next : previous;

  const scheduleRetry = (key, post) => {
    if (closed || !normalizedRetryDelays.length) return;
    const attempt = (retryAttempts.get(key) || 0) + 1;
    if (attempt > normalizedRetryDelays.length) {
      stats.exhausted += 1;
      retryAttempts.delete(key);
      retryPosts.delete(key);
      return;
    }
    retryAttempts.set(key, attempt);
    retryPosts.set(key, newerPost(retryPosts.get(key), post));
    if (retryTimers.has(key)) return;
    stats.retries += 1;
    const timer = setTimeout(() => {
      retryTimers.delete(key);
      const latest = retryPosts.get(key);
      retryPosts.delete(key);
      if (!closed && latest && needsEnrichment(latest)) queue.set(key, latest);
      drain();
    }, normalizedRetryDelays[attempt - 1]);
    timer.unref?.();
    retryTimers.set(key, timer);
  };

  function drain() {
    while (!closed && active < limit && queue.size) {
      const [key, post] = queue.entries().next().value;
      queue.delete(key);
      if (activeKeys.has(key)) continue;
      activeKeys.add(key);
      active += 1;
      let completed = false;
      let retryPost = post;
      void fetchXReferenceContext(post, {
        fetchImpl,
        translateImpl,
        timeoutMs,
        translationTimeoutMs,
        onOriginal: emitOriginalFirst ? onEnriched : null,
        signal: controller.signal
      }).then(async (enriched) => {
        if (!enriched || closed) return;
        retryPost = {
          ...post,
          ...enriched,
          author: enriched.author || post.author,
          url: enriched.url || post.url,
          replyContext: enriched.replyContext || post.replyContext,
          quoteContext: enriched.quoteContext || post.quoteContext
        };
        await onEnriched(enriched);
        completed = !needsEnrichment(enriched);
        if (completed) {
          stats.enriched += 1;
          retryAttempts.delete(key);
        }
      }).catch(() => {
        if (!closed) stats.failures += 1;
      }).finally(() => {
        active -= 1;
        activeKeys.delete(key);
        const pending = pendingByKey.get(key);
        pendingByKey.delete(key);
        if (pending && needsEnrichment(pending)) {
          queue.set(key, pending);
        } else if (!completed && !closed) {
          scheduleRetry(key, retryPost);
        }
        drain();
      });
    }
  }

  return {
    enqueue(posts) {
      if (closed) return 0;
      let added = 0;
      for (const post of Array.isArray(posts) ? posts : [posts]) {
        if (!needsEnrichment(post)) continue;
        const key = `${String(post.source || 'twitter')}:${String(post.externalId || '')}`;
        if (key.endsWith(':')) continue;
        if (activeKeys.has(key)) {
          pendingByKey.set(key, newerPost(pendingByKey.get(key), post));
          continue;
        }
        if (retryTimers.has(key)) {
          retryPosts.set(key, newerPost(retryPosts.get(key), post));
          continue;
        }
        if (queue.has(key)) {
          queue.set(key, newerPost(queue.get(key), post));
          continue;
        }
        queue.set(key, post);
        added += 1;
        while (queue.size > queueLimit) queue.delete(queue.keys().next().value);
      }
      drain();
      return added;
    },
    close() {
      if (closed) return;
      closed = true;
      queue.clear();
      pendingByKey.clear();
      retryPosts.clear();
      for (const timer of retryTimers.values()) clearTimeout(timer);
      retryTimers.clear();
      controller.abort(abortError());
    },
    get active() {
      return active;
    },
    get queued() {
      return queue.size + retryTimers.size;
    },
    get status() {
      return {
        ...stats,
        active,
        queued: queue.size,
        retrying: retryTimers.size,
        closed
      };
    }
  };
}
