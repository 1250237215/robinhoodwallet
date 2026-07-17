(() => {
  const PAGE_SOURCE = 'debot-social-page';
  const RELAY_SOURCE = 'debot-social-relay';
  const DEFAULT_TYPES = 'tweet|retweet|quote|reName|reImage|reDescription|delTweet|follow|unfollow|reply';
  const API_TIMEOUT_MS = 12_000;
  const DELIVERY_TIMEOUT_MS = 20_000;
  const DELIVERY_RETRY_BASE_MS = 2_000;
  const DELIVERY_RETRY_MAX_MS = 30_000;
  const ERROR_TYPES = new Set(['AUTH', 'TIMEOUT', 'NETWORK', 'DEBOT']);
  const seen = new Map();
  const pendingPosts = new Map();
  const pendingDeliveries = new Map();
  let lastWatchlistAt = 0;
  let pollInFlight = null;
  let deliverySequence = 0;
  let commandQueue = Promise.resolve();
  let cachedAccounts = [];

  function emit(type, payload) {
    window.postMessage({ source: PAGE_SOURCE, type, payload }, window.location.origin);
  }

  function timestamp(value, fallback = Date.now()) {
    if (value === null || value === undefined || value === '') return fallback;
    if (typeof value === 'number' || /^\d+(?:\.\d+)?$/.test(String(value))) {
      const numeric = Number(value);
      return Number.isFinite(numeric) ? (numeric < 10_000_000_000 ? numeric * 1_000 : numeric) : fallback;
    }
    const parsed = Date.parse(String(value));
    return Number.isFinite(parsed) ? parsed : fallback;
  }

  function translation(tweet) {
    const values = tweet?.text_translate || tweet?.translations || {};
    return values['zh-CN'] || values['zh-CHS'] || values.zh || values.ch || '';
  }

  function mediaItems(tweet) {
    const items = tweet?.media || tweet?.medias || tweet?.attachments || tweet?.images || [];
    if (!Array.isArray(items)) return [];
    return items.slice(0, 12).map((item) => {
      if (typeof item === 'string') return { type: 'image', url: item };
      const url = item?.url || item?.media_url_https || item?.media_url || item?.src || '';
      const previewUrl = item?.preview_url || item?.thumbnail_url || item?.poster || '';
      const type = String(item?.type || item?.media_type || 'image').toLowerCase();
      return { type: type === 'video' ? 'video' : type === 'gif' ? 'gif' : 'image', url, previewUrl };
    }).filter((item) => item.url || item.previewUrl);
  }

  function postKind(payload) {
    const tweet = payload?.tweet || {};
    if (tweet.is_reply) return 'reply';
    if (tweet.is_quote) return 'quote';
    if (tweet.is_retweet) return 'repost';
    return 'post';
  }

  function normalizePost(payload, feedSource = 'my') {
    if (!payload || typeof payload !== 'object') return null;
    const tweet = payload.tweet || {};
    const user = payload.user || tweet.user || {};
    const externalId = String(payload.doc_id || tweet.tweet_id || payload.id || '').trim();
    if (!externalId) return null;
    const handle = String(user.username || payload.screen_name || '').replace(/^@/, '');
    const platform = Number(payload.platform ?? 0);
    const content = String(tweet.text || payload.text || payload.profile?.new_description || '').trim();
    const mentioned = Array.isArray(payload.mentioned_ca) ? payload.mentioned_ca : [];
    const deleted = tweet.tweet_type === 'delete_post' || payload.is_deleted === true;
    const publishedAt = timestamp(payload.publish_timestamp || payload.index_time || tweet.date || payload.date);
    return {
      source: platform === 1 ? 'binance' : 'twitter',
      externalId,
      kind: postKind(payload),
      author: {
        id: String(user.id || user.user_id || ''),
        handle,
        name: String(user.name || handle),
        avatarUrl: String(user.avatar || user.profile_image_url_https || ''),
        followersCount: Number(user.followers_count || user.profile_info?.Stats?.Followers || 0)
      },
      content,
      translatedContent: String(translation(tweet) || payload.translated_text || ''),
      url: String(tweet.link || payload.link || (handle && tweet.tweet_id ? `https://x.com/${handle}/status/${tweet.tweet_id}` : '')),
      media: mediaItems(tweet),
      contractAddresses: mentioned.map((item) => ({
        address: item.ca_address || item.address || item.ca || '',
        chain: String(item.chain || '').toLowerCase()
      })),
      chainTags: mentioned.map((item) => String(item.chain || '').toLowerCase()).filter(Boolean),
      replyToExternalId: String(tweet.reply_to?.[0] || ''),
      quotedExternalId: String(tweet.quoted_post?.tweet_id || ''),
      repostExternalId: String(tweet.retweeted_post?.tweet_id || ''),
      publishedAt,
      receivedAt: Date.now(),
      sourceUpdatedAt: timestamp(payload.save_time || payload.index_time, publishedAt),
      deleted,
      deletedAt: deleted ? Date.now() : null,
      feedSources: [feedSource]
    };
  }

  function postIdentity(post) {
    return `${post.source}:${post.externalId}`;
  }

  function postFingerprint(post) {
    return JSON.stringify([post.sourceUpdatedAt, post.deleted, post.content, post.translatedContent, post.feedSources]);
  }

  function clearDeliveryTimers(delivery) {
    if (typeof clearTimeout !== 'function') return;
    if (delivery.timeoutId !== null) clearTimeout(delivery.timeoutId);
    if (delivery.retryTimerId !== null) clearTimeout(delivery.retryTimerId);
  }

  function detachPendingPost(key, pending) {
    if (pendingPosts.get(key)?.deliveryId !== pending.deliveryId) return;
    pendingPosts.delete(key);
    const delivery = pendingDeliveries.get(pending.deliveryId);
    if (!delivery) return;
    delivery.items = delivery.items.filter((item) => item.key !== key);
    if (delivery.items.length) return;
    clearDeliveryTimers(delivery);
    pendingDeliveries.delete(pending.deliveryId);
  }

  function acknowledgeDelivery(deliveryId) {
    const delivery = pendingDeliveries.get(deliveryId);
    if (!delivery) return;
    clearDeliveryTimers(delivery);
    const now = Date.now();
    for (const item of delivery.items) {
      const pending = pendingPosts.get(item.key);
      if (pending?.deliveryId !== deliveryId) continue;
      pendingPosts.delete(item.key);
      seen.set(item.key, {
        fingerprint: item.fingerprint,
        feedSources: item.feedSources,
        post: item.post,
        sourceUpdatedAt: item.post.sourceUpdatedAt,
        at: now
      });
    }
    pendingDeliveries.delete(deliveryId);
  }

  function retryDelivery(deliveryId) {
    const delivery = pendingDeliveries.get(deliveryId);
    if (!delivery || delivery.retryTimerId !== null) return;
    if (delivery.timeoutId !== null && typeof clearTimeout === 'function') clearTimeout(delivery.timeoutId);
    delivery.timeoutId = null;

    const release = () => {
      const current = pendingDeliveries.get(deliveryId);
      if (current !== delivery) return;
      const posts = [];
      for (const item of delivery.items) {
        const pending = pendingPosts.get(item.key);
        if (pending?.deliveryId !== deliveryId) continue;
        pendingPosts.delete(item.key);
        const acknowledged = seen.get(item.key);
        const acknowledgedAt = Number(acknowledged?.sourceUpdatedAt || 0);
        const itemUpdatedAt = Number(item.post.sourceUpdatedAt || item.post.publishedAt || 0);
        if (acknowledged?.fingerprint === item.fingerprint) continue;
        if (acknowledged && acknowledgedAt >= itemUpdatedAt) continue;
        posts.push(item.post);
      }
      pendingDeliveries.delete(deliveryId);
      if (posts.length) deliverPosts(posts, delivery.attempt + 1);
    };

    if (typeof setTimeout !== 'function') {
      for (const item of delivery.items) {
        if (pendingPosts.get(item.key)?.deliveryId === deliveryId) pendingPosts.delete(item.key);
      }
      pendingDeliveries.delete(deliveryId);
      return;
    }
    const delay = Math.min(
      DELIVERY_RETRY_BASE_MS * (2 ** Math.min(delivery.attempt, 4)),
      DELIVERY_RETRY_MAX_MS
    );
    delivery.retryTimerId = setTimeout(release, delay);
  }

  function deliverPosts(posts, attempt = 0) {
    const now = Date.now();
    const candidates = new Map();
    for (const post of posts) {
      if (!post) continue;
      const key = postIdentity(post);
      const previous = candidates.get(key);
      const previousUpdatedAt = Number(previous?.sourceUpdatedAt || previous?.publishedAt || 0);
      const nextUpdatedAt = Number(post.sourceUpdatedAt || post.publishedAt || 0);
      const newest = !previous || nextUpdatedAt >= previousUpdatedAt ? post : previous;
      candidates.set(key, {
        ...newest,
        feedSources: Array.from(new Set([
          ...(previous?.feedSources || []),
          ...(post.feedSources || [])
        ])).sort()
      });
    }

    const fresh = [];
    for (const [key, candidate] of candidates) {
      const acknowledged = seen.get(key);
      const pending = pendingPosts.get(key);
      const pendingUpdatedAt = Number(pending?.post?.sourceUpdatedAt || pending?.post?.publishedAt || 0);
      const candidateUpdatedAt = Number(candidate.sourceUpdatedAt || candidate.publishedAt || 0);
      const acknowledgedUpdatedAt = Number(acknowledged?.post?.sourceUpdatedAt || acknowledged?.post?.publishedAt || 0);
      let newest = candidate;
      if (pending?.post && pendingUpdatedAt >= candidateUpdatedAt) newest = pending.post;
      else if (acknowledged?.post && acknowledgedUpdatedAt > candidateUpdatedAt) newest = acknowledged.post;
      const post = {
        ...newest,
        feedSources: Array.from(new Set([
          ...(acknowledged?.feedSources || []),
          ...(pending?.feedSources || []),
          ...(candidate.feedSources || [])
        ])).sort()
      };
      const fingerprint = postFingerprint(post);
      if (acknowledged?.fingerprint === fingerprint) continue;
      if (pending?.fingerprint === fingerprint && now - pending.at < DELIVERY_TIMEOUT_MS) continue;
      if (pending) detachPendingPost(key, pending);
      fresh.push({ post, key, fingerprint });
    }
    for (const [key, value] of seen) if (now - value.at > 24 * 60 * 60 * 1_000) seen.delete(key);
    for (const [deliveryId, delivery] of pendingDeliveries) {
      if (delivery.timeoutId === null && delivery.retryTimerId === null && now - delivery.at >= DELIVERY_TIMEOUT_MS) {
        retryDelivery(deliveryId);
      }
    }
    if (!fresh.length) return 0;

    deliverySequence += 1;
    const deliveryId = `${now.toString(36)}-${deliverySequence.toString(36)}`;
    const items = fresh.map(({ post, key, fingerprint }) => ({ post, key, fingerprint, feedSources: post.feedSources }));
    for (const item of items) {
      pendingPosts.set(item.key, { ...item, deliveryId, at: now });
    }
    const timeoutId = typeof setTimeout === 'function'
      ? setTimeout(() => retryDelivery(deliveryId), DELIVERY_TIMEOUT_MS)
      : null;
    pendingDeliveries.set(deliveryId, { items, at: now, timeoutId, retryTimerId: null, attempt });
    emit('posts', { posts: fresh.map(({ post }) => post), deliveryId });
    return fresh.length;
  }

  class DeBotRequestError extends Error {
    constructor(errorType) {
      super(errorType);
      this.name = 'DeBotRequestError';
      this.errorType = errorType;
    }
  }

  function coarseErrorType(error) {
    if (ERROR_TYPES.has(error?.errorType)) return error.errorType;
    if (error?.name === 'AbortError') return 'TIMEOUT';
    if (error?.name === 'TypeError') return 'NETWORK';
    return 'DEBOT';
  }

  function isAuthFailure(response, body) {
    if ([401, 403, 419, 440].includes(Number(response?.status))) return true;
    if ([401, 403, 419, 440, -401, -403, -419, -440].includes(Number(body?.code))) return true;
    const hint = [body?.description, body?.message_en, body?.message, body?.message_cn]
      .filter((value) => typeof value === 'string')
      .join(' ');
    return /(?:unauthori[sz]ed|not[ -]?logged[ -]?in|sign[ -]?in[ -]?required|log[ -]?in.{0,20}(?:required|expired|invalid)|(?:required|expired|invalid).{0,20}log[ -]?in|token.{0,20}(?:expired|invalid)|(?:expired|invalid).{0,20}token|\u672a\u767b\u5f55|\u8bf7\u767b\u5f55|\u767b\u5f55(?:\u8fc7\u671f|\u8d85\u65f6|\u5931\u6548|\u5df2\u5931\u6548))/i.test(hint);
  }

  async function api(path, options = {}) {
    const controller = typeof AbortController === 'function' ? new AbortController() : null;
    const timeoutId = controller && typeof setTimeout === 'function'
      ? setTimeout(() => controller.abort(), API_TIMEOUT_MS)
      : null;
    let response;
    let body;
    try {
      response = await fetch(`/api/${String(path).replace(/^\/+/, '')}`, {
        credentials: 'include',
        headers: { accept: 'application/json', ...(options.body ? { 'content-type': 'application/json' } : {}) },
        ...options,
        ...(controller ? { signal: controller.signal } : {})
      });
      try {
        body = await response.json();
      } catch (error) {
        if (controller?.signal.aborted || error?.name === 'AbortError') throw new DeBotRequestError('TIMEOUT');
        throw new DeBotRequestError(response.ok ? 'DEBOT' : ([401, 403, 419, 440].includes(Number(response.status)) ? 'AUTH' : 'DEBOT'));
      }
    } catch (error) {
      if (ERROR_TYPES.has(error?.errorType)) throw error;
      if (controller?.signal.aborted || error?.name === 'AbortError') throw new DeBotRequestError('TIMEOUT');
      throw new DeBotRequestError('NETWORK');
    } finally {
      if (timeoutId !== null && typeof clearTimeout === 'function') clearTimeout(timeoutId);
    }
    if (!response.ok || (body?.code !== undefined && Number(body.code) !== 0)) {
      throw new DeBotRequestError(isAuthFailure(response, body) ? 'AUTH' : 'DEBOT');
    }
    return body.data ?? body;
  }

  function watchlistRows(data) {
    const rows = data?.list || data?.records || data?.items || data || [];
    return Array.isArray(rows) ? rows : [];
  }

  function normalizeWatchlist(data) {
    return watchlistRows(data).map((item) => ({
      platform: Number(item.platform || 0) === 1 ? 'binance' : 'twitter',
      accountKey: String(item.monitor_object || item.tweet_username || item.username || '').toLowerCase(),
      handle: String(item.monitor_object || item.tweet_username || item.username || ''),
      name: String(item.config_name || item.tweet_name || item.name || ''),
      url: String(item.url || ''),
      remoteId: String(item.config_id || item.id || ''),
      metadata: { hotSubscribeId: item.hot_subscribe_id || null, monitorLevel: item.monitor_level || '' }
    })).filter((item) => item.handle);
  }

  async function fetchWatchlist() {
    const data = await api('social/subscribe/list?keyword=&page=1&page_size=500');
    const accounts = normalizeWatchlist(data);
    cachedAccounts = accounts;
    emit('watchlist', { accounts });
    lastWatchlistAt = Date.now();
    return accounts;
  }

  async function fetchTimeline(feedSource, configIds = []) {
    const params = new URLSearchParams({ cursor: '', limit: '50', tw_types: DEFAULT_TYPES });
    let path;
    if (feedSource === 'featured') path = `social/twitter/hot/timeline?${params}`;
    else {
      params.set('config_ids', configIds.join('|'));
      path = `${feedSource === 'my' ? 'social/twitter/timeline' : 'social/twitter/all/timeline'}?${params}`;
    }
    const data = await api(path);
    const feeds = Array.isArray(data?.feeds) ? data.feeds : [];
    return feeds.map((item) => normalizePost(item, feedSource)).filter(Boolean);
  }

  async function runPoll() {
    const configIds = cachedAccounts.map((account) => account.remoteId).filter(Boolean);
    const configKey = [...configIds].sort().join('|');
    const refreshWatchlist = Date.now() - lastWatchlistAt > 30_000;
    let followUp = false;
    try {
      const deliverTimeline = (promise) => promise.then((posts) => {
        deliverPosts(posts);
        return posts;
      });
      const results = await Promise.allSettled([
        refreshWatchlist ? fetchWatchlist() : Promise.resolve(null),
        deliverTimeline(fetchTimeline('my', configIds)),
        deliverTimeline(fetchTimeline('featured')),
        deliverTimeline(fetchTimeline('all', configIds))
      ]);
      followUp = refreshWatchlist
        && cachedAccounts.map((account) => account.remoteId).filter(Boolean).sort().join('|') !== configKey;
      const errorTypes = results
        .filter((result) => result.status === 'rejected')
        .map((result) => coarseErrorType(result.reason));
      if (errorTypes.length) {
        const errorType = ['AUTH', 'TIMEOUT', 'NETWORK', 'DEBOT'].find((type) => errorTypes.includes(type)) || 'DEBOT';
        throw new DeBotRequestError(errorType);
      }
      emit('heartbeat', {
        bridgeId: 'debot-browser-extension',
        version: '1.0.0',
        sessionId: String(Date.now()),
        capabilities: ['posts', 'watchlist', 'commands', 'debot-session']
      });
      return { ok: true, followUp };
    } catch (error) {
      const errorType = coarseErrorType(error);
      emit('heartbeat', {
        bridgeId: 'debot-browser-extension',
        version: '1.0.0',
        capabilities: ['error'],
        error: errorType
      });
      return { ok: false, errorType, followUp };
    }
  }

  function fallbackPoll() {
    if (pollInFlight) return pollInFlight;
    let followUp = false;
    const operation = runPoll().then((result) => {
      followUp = result?.followUp === true;
      return result;
    }).finally(() => {
      if (pollInFlight !== operation) return;
      pollInFlight = null;
      if (followUp) void fallbackPoll();
    });
    pollInFlight = operation;
    return operation;
  }

  async function executeCommand(command) {
    const payload = command?.payload || {};
    const handle = String(payload.handle || payload.accountKey || '').replace(/^@/, '');
    const platform = payload.platform === 'binance' ? 1 : 0;
    const platformName = platform === 1 ? 'binance' : 'twitter';
    if (!handle.trim()) throw new Error('Watchlist handle is required');
    if (command.type === 'watchlist.add') {
      const before = await fetchWatchlist();
      const existing = before.find((item) => item.platform === platformName
        && item.accountKey === handle.toLowerCase());
      if (existing) return { remoteId: String(existing.remoteId || '') };
      const result = await api('social/subscribe/custom/add', {
        method: 'POST',
        body: JSON.stringify({ tweet_username: handle, platform })
      });
      const accounts = await fetchWatchlist();
      const synced = accounts.find((item) => item.platform === platformName
        && item.accountKey === handle.toLowerCase());
      return { remoteId: String(synced?.remoteId || result?.config_id || result?.id || '') };
    }
    if (command.type === 'watchlist.delete') {
      const accounts = await fetchWatchlist();
      const remoteIds = accounts
        .filter((item) => item.platform === platformName && item.accountKey === handle.toLowerCase())
        .map((item) => Number(item.remoteId))
        .filter((id) => Number.isSafeInteger(id) && id > 0);
      const knownRemoteIds = new Set(accounts
        .map((item) => Number(item.remoteId))
        .filter((id) => Number.isSafeInteger(id) && id > 0));
      const explicitText = String(payload.remoteId ?? '').trim();
      const explicitId = explicitText ? Number(explicitText) : null;
      if (Number.isSafeInteger(explicitId) && explicitId > 0
        && knownRemoteIds.has(explicitId) && !remoteIds.includes(explicitId)) {
        remoteIds.push(explicitId);
      }
      if (remoteIds.length) {
        await api('social/subscribe/remove', {
          method: 'POST',
          body: JSON.stringify({ config_ids: remoteIds })
        });
      }
      await fetchWatchlist();
      return { remoteId: String(remoteIds[0] || '') };
    }
    throw new Error(`Unsupported command: ${command.type}`);
  }

  function observeSocketFrame(frame) {
    if (typeof frame !== 'string' || !frame.includes('social-') || !frame.includes('-twitter')) return;
    const arrayStart = frame.indexOf('[');
    if (arrayStart < 0) return;
    try {
      const packet = JSON.parse(frame.slice(arrayStart));
      const channel = String(packet[0] || '');
      if (!['social-user-twitter', 'social-hot-twitter'].includes(channel)) return;
      const envelope = packet[1] || {};
      const parsed = typeof envelope.Payload === 'string' ? JSON.parse(envelope.Payload) : envelope.Payload || envelope;
      const payload = parsed?.data || parsed;
      const post = normalizePost(payload, channel === 'social-user-twitter' ? 'my' : 'featured');
      deliverPosts([post]);
    } catch {
      // Fallback polling covers socket frames from an unknown protocol version.
    }
  }

  const NativeWebSocket = window.WebSocket;
  if (typeof NativeWebSocket === 'function') {
    window.WebSocket = new Proxy(NativeWebSocket, {
      construct(target, args) {
        const socket = Reflect.construct(target, args);
        socket.addEventListener('message', (event) => observeSocketFrame(event.data));
        return socket;
      }
    });
  }

  window.addEventListener('message', (event) => {
    if (event.source !== window || event.origin !== window.location.origin) return;
    const message = event.data;
    if (!message || message.source !== RELAY_SOURCE) return;
    if (message.type === 'force-poll') {
      const requestId = typeof message.requestId === 'string' ? message.requestId : '';
      if (!requestId.trim()) return;
      void fallbackPoll().then((result) => {
        emit('force-poll-result', {
          requestId,
          ok: result?.ok === true,
          ...(result?.ok === true ? {} : { errorType: coarseErrorType(result) })
        });
      });
      return;
    }
    if (message.type === 'posts-delivery-result') {
      const deliveryId = String(message.payload?.deliveryId || '');
      if (deliveryId && message.payload?.ok === true) acknowledgeDelivery(deliveryId);
      else if (deliveryId) retryDelivery(deliveryId);
      return;
    }
    if (message.type !== 'command') return;
    const operation = commandQueue.then(() => executeCommand(message.command));
    commandQueue = operation.catch(() => {});
    void operation.then((result) => {
      emit('command-result', { commandId: message.command.id, success: true, remoteId: result.remoteId || '' });
    }).catch((error) => {
      emit('command-result', {
        commandId: message.command.id,
        success: false,
        error: error instanceof Error ? error.message : String(error)
      });
    });
  });

  void fallbackPoll();
  setInterval(() => void fallbackPoll(), 5_000);
})();
