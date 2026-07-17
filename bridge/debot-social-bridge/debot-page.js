(() => {
  const PAGE_SOURCE = 'debot-social-page';
  const RELAY_SOURCE = 'debot-social-relay';
  const DEFAULT_TYPES = 'tweet|retweet|quote|reName|reImage|reDescription|delTweet|follow|unfollow|reply';
  const seen = new Map();
  let lastWatchlistAt = 0;
  let requestBusy = false;
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

  function dedupe(posts) {
    const now = Date.now();
    const fresh = [];
    for (const post of posts) {
      if (!post) continue;
      const key = `${post.source}:${post.externalId}`;
      const fingerprint = JSON.stringify([post.sourceUpdatedAt, post.deleted, post.content, post.translatedContent, post.feedSources]);
      if (seen.get(key)?.fingerprint === fingerprint) continue;
      seen.set(key, { fingerprint, at: now });
      fresh.push(post);
    }
    for (const [key, value] of seen) if (now - value.at > 24 * 60 * 60 * 1_000) seen.delete(key);
    return fresh;
  }

  async function api(path, options = {}) {
    const response = await fetch(`/api/${String(path).replace(/^\/+/, '')}`, {
      credentials: 'include',
      headers: { accept: 'application/json', ...(options.body ? { 'content-type': 'application/json' } : {}) },
      ...options
    });
    const body = await response.json().catch(() => ({}));
    if (!response.ok || (body.code !== undefined && body.code !== 0)) {
      throw new Error(body.description || body.message_en || body.message || `DeBot HTTP ${response.status}`);
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

  async function fallbackPoll() {
    if (requestBusy) return;
    requestBusy = true;
    try {
      const accounts = Date.now() - lastWatchlistAt > 30_000 ? await fetchWatchlist() : null;
      const current = accounts || cachedAccounts;
      const configIds = current.map((account) => account.remoteId).filter(Boolean);
      const batches = await Promise.all([
        fetchTimeline('my', configIds),
        fetchTimeline('featured'),
        fetchTimeline('all', configIds)
      ]);
      const posts = dedupe(batches.flat());
      if (posts.length) emit('posts', { posts });
      emit('heartbeat', {
        bridgeId: 'debot-browser-extension',
        version: '1.0.0',
        sessionId: String(Date.now()),
        capabilities: ['posts', 'watchlist', 'commands', 'debot-session']
      });
    } catch (error) {
      emit('heartbeat', {
        bridgeId: 'debot-browser-extension',
        version: '1.0.0',
        capabilities: ['error'],
        error: error instanceof Error ? error.message : String(error)
      });
    } finally {
      requestBusy = false;
    }
  }

  async function executeCommand(command) {
    const payload = command?.payload || {};
    const handle = String(payload.handle || payload.accountKey || '').replace(/^@/, '');
    const platform = payload.platform === 'binance' ? 1 : 0;
    if (command.type === 'watchlist.add') {
      const result = await api('social/subscribe/custom/add', {
        method: 'POST',
        body: JSON.stringify({ tweet_username: handle, platform })
      });
      const accounts = await fetchWatchlist();
      const synced = accounts.find((item) => item.platform === payload.platform && item.accountKey === handle.toLowerCase());
      return { remoteId: String(synced?.remoteId || result?.config_id || result?.id || '') };
    }
    if (command.type === 'watchlist.delete') {
      const accounts = await fetchWatchlist();
      const remoteIds = accounts
        .filter((item) => item.platform === payload.platform && item.accountKey === handle.toLowerCase())
        .map((item) => Number(item.remoteId))
        .filter((id) => Number.isFinite(id));
      const explicitId = Number(payload.remoteId);
      if (Number.isFinite(explicitId) && !remoteIds.includes(explicitId)) remoteIds.push(explicitId);
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
      const posts = dedupe([post]);
      if (posts.length) emit('posts', { posts });
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
    if (!message || message.source !== RELAY_SOURCE || message.type !== 'command') return;
    void executeCommand(message.command).then((result) => {
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
