(() => {
  const PAGE_SOURCE = 'debot-social-page';
  const RELAY_SOURCE = 'debot-social-relay';
  const BRIDGE_VERSION = '1.10.10';
  const BRIDGE_SESSION_ID = `${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 12)}`;
  const DEFAULT_TYPES = 'tweet|reply|retweet|quote|delTweet|reName|reImage|reDescription|follow|unfollow';
  const SOCIAL_EVENT_KINDS = new Set(['post', 'reply', 'repost', 'quote', 'delete', 'follow', 'unfollow', 'profile']);
  // The WebSocket is the primary lane. This short, coalesced REST poll only
  // covers frames DeBot does not expose or cannot be decoded in the page.
  const PRIMARY_POLL_INTERVAL_MS = 1_000;
  const PRIMARY_API_TIMEOUT_MS = 1_500;
  const PRIMARY_TRANSIENT_ERROR_MIN_FAILURES = 3;
  const PRIMARY_TRANSIENT_ERROR_MIN_DURATION_MS = 8_000;
  const TIMELINE_PAGE_SIZE = 50;
  const TIMELINE_CATCHUP_PAGES_PER_POLL = 3;
  const TIMELINE_CATCHUP_MAX_PAGES = 100;
  const TIMELINE_CATCHUP_MAX_POSTS = TIMELINE_PAGE_SIZE * TIMELINE_CATCHUP_MAX_PAGES;
  const WATCHLIST_POLL_INTERVAL_MS = 30_000;
  const WALLET_LIBRARY_POLL_INTERVAL_MS = 60_000;
  const WALLET_ACTIVITY_POLL_INTERVAL_MS = 1_200;
  const WALLET_ACTIVITY_API_TIMEOUT_MS = 2_000;
  const WALLET_ACTIVITY_SEEN_LIMIT = 5_000;
  const API_TIMEOUT_MS = 20_000;
  const DELIVERY_TIMEOUT_MS = 2_000;
  const DELIVERY_RETRY_BASE_MS = 2_000;
  const DELIVERY_RETRY_MAX_MS = 30_000;
  const PAGE_PENDING_MAX_POSTS = 100;
  const PAGE_PENDING_MAX_BYTES = 2 * 1024 * 1024;
  const ERROR_TYPES = new Set(['AUTH', 'TIMEOUT', 'NETWORK', 'DEBOT']);
  const ANALYSIS_JOB_TYPES = new Set([
    'debot.token_detail.v1',
    'debot.wallet_token_analysis.v1',
    'debot.token_holders.v1'
  ]);
  const ANALYSIS_CONCURRENCY = 4;
  const ANALYSIS_QUEUE_LIMIT = 32;
  const MAX_ANALYSIS_RESULT_BYTES = 256 * 1024;
  const WATCHLIST_PAGE_SIZE = 500;
  const WATCHLIST_MAX_PAGES = 10;
  const EVM_ADDRESS_PATTERN = /^0x[0-9a-f]{40}$/;
  const ZERO_EVM_ADDRESS = '0x0000000000000000000000000000000000000000';
  const MAX_DIAGNOSTIC_COUNTER = 1_000_000_000;
  const MAX_SOCKET_PAYLOADS_PER_FRAME = 24;
  const PERSONAL_TWITTER_PAYLOAD_CHANNELS = new Set([
    'twitter_user_subscribe',
    'twitter_translate_user_subscribe'
  ]);
  const seen = new Map();
  const pendingPosts = new Map();
  const pendingDeliveries = new Map();
  const pendingCapacityWaiters = new Set();
  let pendingPostBytes = 0;
  let pendingPostBackpressured = false;
  let lastWatchlistAt = 0;
  let pollInFlight = null;
  let deliverySequence = 0;
  let commandQueue = Promise.resolve();
  let cachedAccounts = [];
  let activeAnalysisJobs = 0;
  const analysisQueue = [];
  const analysisKeys = new Set();
  let watchlistInFlight = null;
  let walletLibraryInFlight = null;
  let walletActivityInFlight = null;
  let walletActivityBootstrapped = false;
  const walletActivitySeen = new Set();
  let watchlistFetchGeneration = 0;
  let primaryFollowUpRequested = false;
  let timelineCatchUpRequired = true;
  let timelineCatchUpCursor = '';
  let timelineCatchUpPages = 0;
  let timelineCatchUpPosts = 0;
  let timelineCatchUpBoundary = new Set();
  let timelineCatchUpGeneration = 0;
  let timelineCatchUpInFlight = null;
  let timelineCatchUpTruncated = false;
  let lastPrimarySuccessAt = 0;
  let transientPrimaryFailures = 0;
  let firstTransientPrimaryFailureAt = 0;
  // This summary is deliberately bounded and contains no DeBot response data,
  // credentials, account names, or raw WebSocket frames.
  const bridgeDiagnostics = {
    ws: {
      connectionOpens: 0,
      authorizationSuccesses: 0,
      subscribeAttempts: 0,
      subscribeFailures: 0,
      lastSubscribeAt: 0,
      framesSeen: 0,
      accepted: 0,
      rejected: 0,
      unmatchedChannel: 0,
      invalidPacket: 0,
      invalidEnvelope: 0,
      unmonitoredAuthor: 0,
      invalidEvent: 0,
      unreadable: 0,
      lastEventAt: 0
    },
    wallet: {
      frames: 0,
      rows: 0,
      accepted: 0,
      rejected: 0,
      lastEventAt: 0
    },
    poll: {
      attempts: 0,
      successes: 0,
      failures: 0,
      startedAt: 0,
      finishedAt: 0,
      elapsedMs: 0,
      rawRows: 0,
      normalizedRows: 0,
      droppedRows: 0,
      accountCount: 0,
      configHash: '00000000',
      latestSourceAt: 0,
      lastErrorCategory: ''
    },
    forcePoll: {
      successes: 0,
      failures: 0,
      lastAt: 0,
      elapsedMs: 0,
      lastErrorCategory: ''
    }
  };
  const portalSubscribedSockets = new WeakSet();
  const portalAuthorizedSockets = new WeakSet();
  let portalAuthorizedSocketCount = 0;

  function emit(type, payload) {
    window.postMessage({ source: PAGE_SOURCE, type, payload }, window.location.origin);
  }

  function incrementDiagnosticCounter(target, key, amount = 1) {
    const current = Number(target?.[key] || 0);
    const increment = Number(amount);
    const next = Number.isFinite(current) && Number.isFinite(increment)
      ? current + increment
      : MAX_DIAGNOSTIC_COUNTER;
    target[key] = Math.max(0, Math.min(MAX_DIAGNOSTIC_COUNTER, Math.trunc(next)));
  }

  function diagnosticConfigHash(configIds) {
    const values = (Array.isArray(configIds) ? configIds : [])
      .map((value) => String(value || '').slice(0, 120))
      .filter(Boolean)
      .sort();
    let hash = 0x811c9dc5;
    for (const character of values.join('|')) {
      hash ^= character.charCodeAt(0);
      hash = Math.imul(hash, 0x01000193);
    }
    return (hash >>> 0).toString(16).padStart(8, '0');
  }

  function bridgeDiagnosticsSnapshot() {
    const { ws, wallet, poll, forcePoll } = bridgeDiagnostics;
    return {
      ws: {
        connectionOpens: ws.connectionOpens,
        authorizationSuccesses: ws.authorizationSuccesses,
        subscribeAttempts: ws.subscribeAttempts,
        subscribeFailures: ws.subscribeFailures,
        lastSubscribeAt: ws.lastSubscribeAt,
        framesSeen: ws.framesSeen,
        accepted: ws.accepted,
        rejected: ws.rejected,
        unmatchedChannel: ws.unmatchedChannel,
        invalidPacket: ws.invalidPacket,
        invalidEnvelope: ws.invalidEnvelope,
        unmonitoredAuthor: ws.unmonitoredAuthor,
        invalidEvent: ws.invalidEvent,
        unreadable: ws.unreadable,
        lastEventAt: ws.lastEventAt
      },
      wallet: {
        frames: wallet.frames,
        rows: wallet.rows,
        accepted: wallet.accepted,
        rejected: wallet.rejected,
        lastEventAt: wallet.lastEventAt
      },
      poll: {
        attempts: poll.attempts,
        successes: poll.successes,
        failures: poll.failures,
        startedAt: poll.startedAt,
        finishedAt: poll.finishedAt,
        elapsedMs: poll.elapsedMs,
        rawRows: poll.rawRows,
        normalizedRows: poll.normalizedRows,
        droppedRows: poll.droppedRows,
        accountCount: poll.accountCount,
        configHash: poll.configHash,
        latestSourceAt: poll.latestSourceAt,
        lastErrorCategory: poll.lastErrorCategory
      },
      forcePoll: {
        successes: forcePoll.successes,
        failures: forcePoll.failures,
        lastAt: forcePoll.lastAt,
        elapsedMs: forcePoll.elapsedMs,
        lastErrorCategory: forcePoll.lastErrorCategory
      }
    };
  }

  function rejectSocketFrame(reason) {
    incrementDiagnosticCounter(bridgeDiagnostics.ws, 'rejected');
    if (Object.hasOwn(bridgeDiagnostics.ws, reason)) {
      incrementDiagnosticCounter(bridgeDiagnostics.ws, reason);
    }
  }

  function beginPrimaryPollDiagnostics(configIds) {
    const poll = bridgeDiagnostics.poll;
    incrementDiagnosticCounter(poll, 'attempts');
    poll.startedAt = Date.now();
    poll.accountCount = Math.min(10_000, (Array.isArray(configIds) ? configIds.length : 0));
    poll.configHash = diagnosticConfigHash(configIds);
    poll.lastErrorCategory = '';
  }

  function completePrimaryPollDiagnostics(page) {
    const poll = bridgeDiagnostics.poll;
    incrementDiagnosticCounter(poll, 'successes');
    poll.finishedAt = Date.now();
    poll.elapsedMs = Math.max(0, Math.min(MAX_DIAGNOSTIC_COUNTER, poll.finishedAt - poll.startedAt));
    const boundedCount = (value) => {
      const number = Number(value);
      return Number.isFinite(number) ? Math.max(0, Math.min(MAX_DIAGNOSTIC_COUNTER, Math.trunc(number))) : 0;
    };
    const sourceAt = Number(page?.latestSourceAt);
    poll.rawRows = boundedCount(page?.rawRows);
    poll.normalizedRows = boundedCount(page?.normalizedRows);
    poll.droppedRows = boundedCount(page?.droppedRows);
    poll.latestSourceAt = Number.isSafeInteger(sourceAt) && sourceAt > 0 ? sourceAt : 0;
    poll.lastErrorCategory = '';
  }

  function failPrimaryPollDiagnostics(errorType) {
    const poll = bridgeDiagnostics.poll;
    incrementDiagnosticCounter(poll, 'failures');
    poll.finishedAt = Date.now();
    poll.elapsedMs = Math.max(0, Math.min(MAX_DIAGNOSTIC_COUNTER, poll.finishedAt - poll.startedAt));
    poll.lastErrorCategory = ERROR_TYPES.has(errorType) ? errorType : 'DEBOT';
  }

  function completeForcePollDiagnostics(result, startedAt) {
    const forcePoll = bridgeDiagnostics.forcePoll;
    forcePoll.lastAt = Date.now();
    forcePoll.elapsedMs = Math.max(0, Math.min(MAX_DIAGNOSTIC_COUNTER, forcePoll.lastAt - startedAt));
    if (result?.ok === true) {
      incrementDiagnosticCounter(forcePoll, 'successes');
      forcePoll.lastErrorCategory = '';
      return;
    }
    incrementDiagnosticCounter(forcePoll, 'failures');
    forcePoll.lastErrorCategory = ERROR_TYPES.has(result?.errorType) ? result.errorType : 'DEBOT';
  }

  function numericTimestamp(value) {
    const raw = String(value ?? '').trim();
    if (!raw) return null;
    if (/^[+-]?\d+$/.test(raw) && typeof BigInt === 'function') {
      try {
        const integer = BigInt(raw);
        const absolute = integer < 0n ? -integer : integer;
        let milliseconds;
        if (absolute >= 100_000_000_000_000_000n) milliseconds = integer / 1_000_000n;
        else if (absolute >= 100_000_000_000_000n) milliseconds = integer / 1_000n;
        else if (absolute >= 100_000_000_000n) milliseconds = integer;
        else milliseconds = integer * 1_000n;
        const normalized = Number(milliseconds);
        return Number.isSafeInteger(normalized) ? normalized : null;
      } catch {
        return null;
      }
    }
    if (!/^[+-]?\d+(?:\.\d+)?(?:e[+-]?\d+)?$/i.test(raw)) return null;
    const numeric = Number(raw);
    if (!Number.isFinite(numeric)) return null;
    const absolute = Math.abs(numeric);
    const milliseconds = absolute >= 100_000_000_000_000_000
      ? numeric / 1_000_000
      : absolute >= 100_000_000_000_000
        ? numeric / 1_000
        : absolute >= 100_000_000_000
          ? numeric
          : numeric * 1_000;
    const normalized = Math.trunc(milliseconds);
    return Number.isSafeInteger(normalized) ? normalized : null;
  }

  function timestamp(value, fallback = Date.now()) {
    if (value === null || value === undefined || value === '') return fallback;
    const numeric = numericTimestamp(value);
    if (numeric !== null) return numeric;
    const parsed = Date.parse(String(value));
    return Number.isFinite(parsed) ? parsed : fallback;
  }

  function firstTimestamp(values) {
    for (const value of values) {
      const normalized = timestamp(value, null);
      if (normalized !== null) return normalized;
    }
    return null;
  }

  function stableEventTimestamp(identityOccurrence, sourceValues) {
    const occurrenceAt = timestamp(identityOccurrence, null);
    const sourceTimes = sourceValues
      .map((value) => timestamp(value, null))
      .filter((value) => value !== null);
    const sourceAt = sourceTimes[0] ?? null;
    if (occurrenceAt === null) return sourceAt;
    if (sourceAt === null) return occurrenceAt;

    const earliestSocialAt = Date.UTC(2006, 0, 1);
    const latestReasonableAt = Date.now() + 7 * 24 * 60 * 60 * 1_000;
    const occurrenceIsPlausible = occurrenceAt >= earliestSocialAt && occurrenceAt <= latestReasonableAt;
    const plausibleSourceTimes = sourceTimes.filter((value) => (
      value >= earliestSocialAt && value <= latestReasonableAt
    ));
    if (!occurrenceIsPlausible && plausibleSourceTimes.length) return plausibleSourceTimes[0];
    if (occurrenceIsPlausible && !plausibleSourceTimes.length) return occurrenceAt;

    const sevenDays = 7 * 24 * 60 * 60 * 1_000;
    const agreesWithSource = plausibleSourceTimes.some((value) => Math.abs(value - occurrenceAt) <= sevenDays);
    const precedesIngestion = plausibleSourceTimes.some((value) => occurrenceAt <= value);
    return agreesWithSource || precedesIngestion ? occurrenceAt : plausibleSourceTimes[0] ?? sourceAt;
  }

  function translation(tweet) {
    const values = tweet?.text_translate || tweet?.translations || {};
    if (typeof values === 'string') return values;
    return values['zh-CN'] || values['zh-CHS'] || values.zh || values.ch || '';
  }

  function mediaItems(tweet) {
    if (!tweet || typeof tweet !== 'object') return [];
    const collected = [];
    const seen = new Set();
    const add = (item, forcedType = '') => {
      if (collected.length >= 12 || item === null || item === undefined) return;
      if (Array.isArray(item)) {
        for (const child of item) add(child, forcedType);
        return;
      }
      if (typeof item === 'string') {
        const url = limitedText(item, 2_000).trim();
        if (!url || seen.has(url)) return;
        seen.add(url);
        collected.push({ type: forcedType === 'video' ? 'video' : 'image', url, previewUrl: '' });
        return;
      }
      if (typeof item !== 'object') return;

      const rawType = String(forcedType || item.type || item.media_type || item.mediaType || '').toLowerCase();
      const variants = [
        ...(Array.isArray(item.variants) ? item.variants : []),
        ...(Array.isArray(item.video_info?.variants) ? item.video_info.variants : [])
      ];
      const videoVariant = variants
        .filter((variant) => variant && typeof variant === 'object')
        .filter((variant) => {
          const contentType = String(variant.content_type || variant.contentType || '').toLowerCase();
          const url = String(variant.url || '');
          return contentType === 'video/mp4' || /\.mp4(?:[?#]|$)/i.test(url);
        })
        .sort((left, right) => Number(right.bitrate || 0) - Number(left.bitrate || 0))[0];
      const isVideo = rawType === 'video'
        || rawType === 'animated_gif'
        || Boolean(videoVariant)
        || Boolean(item.video_url || item.videoUrl || item.play_url || item.playback_url);
      const url = limitedText(
        (isVideo && (
          item.video_url
          || item.videoUrl
          || item.play_url
          || item.playback_url
          || videoVariant?.url
        ))
          || item.url
          || item.media_url_https
          || item.media_url
          || item.src
          || '',
        2_000
      ).trim();
      const previewUrl = limitedText(
        item.preview_url
          || item.previewUrl
          || item.thumbnail_url
          || item.thumbnailUrl
          || item.poster
          || item.poster_url
          || (isVideo ? item.media_url_https || item.media_url || '' : ''),
        2_000
      ).trim();
      const identity = url || previewUrl;
      if (identity && !seen.has(identity)) {
        seen.add(identity);
        collected.push({
          type: isVideo ? 'video' : rawType === 'gif' ? 'gif' : 'image',
          url,
          previewUrl
        });
      }

      for (const nested of ['media', 'medias', 'items', 'attachments']) add(item[nested], forcedType);
      for (const nested of ['pictures', 'picture', 'images', 'photos']) add(item[nested], 'image');
      for (const nested of ['videos', 'video']) add(item[nested], 'video');
    };

    add(tweet.pictures, 'image');
    add(tweet.picture, 'image');
    add(tweet.images, 'image');
    add(tweet.videos, 'video');
    add(tweet.video, 'video');
    add(tweet.media);
    add(tweet.medias);
    add(tweet.attachments);
    add(tweet.extended_entities?.media);
    add(tweet.entities?.media);
    return collected.slice(0, 12);
  }

  function mergeMediaItems(previous, incoming) {
    const merged = [];
    for (const item of [...(Array.isArray(incoming) ? incoming : []), ...(Array.isArray(previous) ? previous : [])]) {
      if (!item || typeof item !== 'object') continue;
      const url = limitedText(item.url, 2_000).trim();
      const previewUrl = limitedText(item.previewUrl, 2_000).trim();
      if (!url && !previewUrl) continue;
      const rawType = String(item.type || '').toLowerCase();
      const type = ['video', 'gif'].includes(rawType) ? rawType : 'image';
      const matchingIndex = merged.findIndex((candidate) => (
        [candidate.url, candidate.previewUrl]
          .filter(Boolean)
          .some((value) => value === url || value === previewUrl)
      ));
      if (matchingIndex >= 0) {
        const existing = merged[matchingIndex];
        const mergedType = existing.type === 'video' || type === 'video'
          ? 'video'
          : existing.type === 'gif' || type === 'gif' ? 'gif' : 'image';
        merged[matchingIndex] = {
          type: mergedType,
          url: mergedType === 'video'
            ? (existing.type === 'video' ? existing.url : '') || (type === 'video' ? url : '')
            : existing.url || url,
          previewUrl: existing.previewUrl
            || previewUrl
            || (existing.type !== 'video' ? existing.url : '')
            || (type !== 'video' ? url : '')
        };
        continue;
      }
      merged.push({ type, url, previewUrl });
      if (merged.length >= 12) break;
    }
    return merged;
  }

  function handleText(value) {
    return String(value || '').trim().replace(/^@/, '');
  }

  function normalizedEventType(value) {
    const type = String(value || '').trim().toLowerCase().replace(/[-_\s]/g, '');
    if (['tweet', 'post'].includes(type)) return 'post';
    if (['retweet', 'repost'].includes(type)) return 'repost';
    if (type === 'quote') return 'quote';
    if (type === 'reply') return 'reply';
    if (['follow', 'tweetuserfollow'].includes(type)) return 'follow';
    if (['unfollow', 'tweetuserunfollow'].includes(type)) return 'unfollow';
    if (['rename', 'reimage', 'reavatar', 'redescription', 'profile', 'profileupdate', 'tweetuserprofile'].includes(type)) {
      return 'profile';
    }
    if (['delete', 'deleted', 'deltweet', 'deletepost'].includes(type)) return 'delete';
    return '';
  }

  function explicitEventTypes(payload) {
    const tweet = payload?.tweet || {};
    return [
      payload?.tw_type,
      payload?.twType,
      payload?.twitter_type,
      payload?.event_type,
      payload?.eventType,
      payload?.action,
      payload?.type,
      payload?.tweet_type,
      tweet.tweet_type
    ].filter((value) => value !== null && value !== undefined && String(value).trim() !== '');
  }

  function changedFlag(value) {
    return value === true || value === 1 || value === '1' || String(value || '').toLowerCase() === 'true';
  }

  function profileChangeData(payload) {
    const profile = payload?.profile && typeof payload.profile === 'object' ? payload.profile : {};
    const hasChangedPair = (beforeKey, afterKey) => Object.hasOwn(profile, beforeKey)
      && Object.hasOwn(profile, afterKey)
      && String(profile[beforeKey] ?? '') !== String(profile[afterKey] ?? '');
    const definitions = [
      {
        type: 'name',
        flag: profile.is_name_changed ?? profile.isNameChanged,
        beforeKey: 'old_name',
        afterKey: 'new_name',
        maximum: 500
      },
      {
        type: 'avatar',
        flag: profile.is_image_changed ?? profile.isImageChanged,
        beforeKey: 'old_image',
        afterKey: 'new_image',
        maximum: 2_000
      },
      {
        type: 'bio',
        flag: profile.is_bio_changed ?? profile.isBioChanged,
        beforeKey: 'old_bio',
        afterKey: 'new_bio',
        maximum: 10_000
      }
    ];
    const changes = [];
    const detail = {};
    for (const definition of definitions) {
      if (!changedFlag(definition.flag)
        && !hasChangedPair(definition.beforeKey, definition.afterKey)) continue;
      changes.push(definition.type);
      detail[definition.type] = {
        before: String(profile[definition.beforeKey] ?? '').slice(0, definition.maximum),
        after: String(profile[definition.afterKey] ?? '').slice(0, definition.maximum)
      };
    }
    return { changes, detail };
  }

  function decodeBase64Url(value) {
    const input = String(value || '').trim();
    if (!input || !/^[A-Za-z0-9_-]+$/.test(input) || input.length % 4 === 1) return '';
    const encoded = input.replace(/-/g, '+').replace(/_/g, '/');
    try {
      if (typeof atob === 'function') return atob(encoded.padEnd(Math.ceil(encoded.length / 4) * 4, '='));
    } catch {
      return '';
    }
    const alphabet = 'ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789+/';
    let bits = 0;
    let bitCount = 0;
    let decoded = '';
    for (const character of encoded) {
      const digit = alphabet.indexOf(character);
      if (digit < 0) return '';
      bits = (bits << 6) | digit;
      bitCount += 6;
      if (bitCount < 8) continue;
      bitCount -= 8;
      decoded += String.fromCharCode((bits >> bitCount) & 0xff);
    }
    return decoded;
  }

  function eventIdentity(value, knownAuthor = '') {
    const raw = String(value || '').trim();
    const author = handleText(knownAuthor).toLowerCase();
    for (const candidate of [raw, decodeBase64Url(raw)]) {
      const colon = /^(follow|unfollow):([a-z0-9_]{1,15}):([a-z0-9_]{1,15})(?::(\d{9,19}))?$/i.exec(candidate);
      if (colon) {
        if (author && colon[2].toLowerCase() !== author) return { invalid: true };
        return {
          kind: colon[1].toLowerCase(),
          author: colon[2],
          target: colon[3],
          occurrenceAt: colon[4] || null
        };
      }
      if (/^(?:follow|unfollow):/i.test(candidate)) return { invalid: true };
      const prefixKind = /^(follow|unfollow)_/i.exec(candidate)?.[1]?.toLowerCase();
      if (!prefixKind) continue;
      if (!author) return { invalid: true };
      const prefix = `${prefixKind}_${author}_`;
      if (!candidate.toLowerCase().startsWith(prefix)) return { invalid: true };
      const target = candidate.slice(prefix.length);
      if (/^[a-z0-9_]{1,15}$/i.test(target)) return { kind: prefixKind, author, target };
      return { invalid: true };
    }
    return null;
  }

  function eventType(payload, identity) {
    const tweet = payload?.tweet || {};
    if (identity?.kind) return identity.kind;
    const rawExplicitTypes = explicitEventTypes(payload);
    const explicitTypes = rawExplicitTypes.map(normalizedEventType).filter(Boolean);
    const specific = explicitTypes.find((type) => type !== 'post');
    if (specific) return specific;
    if (payload?.is_deleted === true) return 'delete';
    if (tweet.is_reply) return 'reply';
    if (tweet.is_quote) return 'quote';
    if (tweet.is_retweet) return 'repost';
    if (explicitTypes.includes('post')) return 'post';
    if (payload?.profile && typeof payload.profile === 'object') return 'profile';
    const hasTweetPayload = tweet && typeof tweet === 'object' && Boolean(
      tweet.tweet_id
        || tweet.id
        || tweet.text
        || tweet.link
        || tweet.date
        || tweet.created_at
        || (Array.isArray(tweet.media) && tweet.media.length)
        || (Array.isArray(tweet.medias) && tweet.medias.length)
        || (Array.isArray(tweet.attachments) && tweet.attachments.length)
    );
    if (rawExplicitTypes.length) return '';
    return hasTweetPayload ? 'post' : '';
  }

  function targetValue(payload) {
    const candidates = [
      payload?.follow,
      payload?.target,
      payload?.target_user,
      payload?.targetUser,
      payload?.follow_user,
      payload?.followUser,
      payload?.followed_user,
      payload?.followedUser,
      payload?.unfollow_user,
      payload?.unfollowUser,
      payload?.to_user,
      payload?.toUser,
      payload?.object_user,
      payload?.objectUser
    ];
    return candidates.find((value) => value !== null && value !== undefined && value !== '') || {};
  }

  function normalizeTarget(payload, identity) {
    const raw = targetValue(payload);
    const target = raw && typeof raw === 'object' ? raw : {};
    const profile = target.profile_info && typeof target.profile_info === 'object' ? target.profile_info : {};
    const scalarHandle = typeof raw === 'string' ? raw : '';
    const handle = handleText(
      target.username
        || target.screen_name
        || target.screenName
        || target.handle
        || profile.Username
        || profile.username
        || profile.ScreenName
        || payload.target_username
        || payload.targetUsername
        || payload.target_screen_name
        || payload.follow_username
        || payload.unfollow_username
        || payload.to_username
        || scalarHandle
        || identity?.target
    );
    return {
      id: limitedText(target.id || target.user_id || target.userId || payload.target_user_id || '', 240),
      handle: limitedText(handle, 240),
      name: limitedText(target.name || target.display_name || target.displayName || profile.Name || profile.name || payload.target_name || '', 500),
      avatarUrl: limitedText(target.avatar || target.avatar_url || target.profile_image_url_https || profile.Avatar || profile.avatar || '', 2_000),
      followersCount: Number(target.followers_count || profile.Stats?.Followers || profile.followers_count || 0),
      url: limitedText(target.url || target.profile_url || (handle ? `https://x.com/${handle}` : ''), 2_000)
    };
  }

  function statusIdFromUrl(value) {
    return String(value || '').match(/\/status\/(\d{5,25})(?:[/?#]|$)/i)?.[1] || '';
  }

  function numericTweetId(value) {
    const candidate = String(value ?? '').trim();
    return /^\d{5,25}$/.test(candidate) ? candidate : '';
  }

  function replyHandleFromValue(value) {
    const candidate = Array.isArray(value) ? value[0] : value;
    const raw = candidate && typeof candidate === 'object'
      ? candidate.username
        || candidate.screen_name
        || candidate.screenName
        || candidate.handle
      : candidate;
    const handle = handleText(raw);
    return /^[a-z0-9_]{1,15}$/i.test(handle) ? handle : '';
  }

  function explicitReplyParentId(tweet) {
    const reply = Array.isArray(tweet?.reply_to) ? tweet.reply_to[0] : tweet?.reply_to;
    const candidates = [
      tweet?.reply_to_tweet_id,
      tweet?.replyToTweetId,
      tweet?.reply_tweet_id,
      tweet?.reply_to_status_id,
      tweet?.reply_to_status_id_str,
      tweet?.in_reply_to_status_id,
      tweet?.in_reply_to_status_id_str,
      tweet?.parent_tweet_id,
      tweet?.parent_post_id,
      reply?.tweet_id,
      reply?.post_id,
      reply?.status_id
    ];
    for (const value of candidates) {
      const id = numericTweetId(value);
      if (id) return id;
    }
    return '';
  }

  function replyContextCandidate(parent) {
    if (!parent || typeof parent !== 'object' || Array.isArray(parent)) return null;
    const parentUser = parent.user && typeof parent.user === 'object'
      ? parent.user
      : parent.author && typeof parent.author === 'object'
        ? parent.author
        : {};
    const parentProfile = parentUser.profile_info && typeof parentUser.profile_info === 'object'
      ? parentUser.profile_info
      : {};
    const handle = replyHandleFromValue(
      parentUser.username
        || parentUser.screen_name
        || parentUser.screenName
        || parentUser.handle
        || parentProfile.Username
        || parentProfile.username
    );
    const url = limitedText(parent.link || parent.url || '', 2_000);
    const externalId = numericTweetId(parent.tweet_id || parent.post_id || parent.status_id)
      || statusIdFromUrl(url)
      || numericTweetId(parent.id);
    const content = limitedText(parent.text || parent.content || '', 100_000).trim();
    const translatedContent = limitedText(translation(parent) || parent.translated_text || '', 100_000);
    const publishedAt = firstTimestamp([
      parent.date,
      parent.tweet_time,
      parent.created_at,
      parent.createdAt,
      parent.publish_timestamp,
      parent.publishTimestamp
    ]) || 0;
    const media = mediaItems(parent);
    if (!externalId && !content && !translatedContent && !url && !media.length) return null;
    return {
      externalId,
      author: {
        id: limitedText(parentUser.id || parentUser.user_id || parentUser.profile_id || '', 240),
        handle,
        name: limitedText(
          parentUser.name || parentUser.display_name || parentUser.displayName || parentProfile.Name || '',
          500
        ),
        avatarUrl: limitedText(
          parentUser.avatar || parentUser.profile_image_url_https || parentProfile.Avatar || '',
          2_000
        )
      },
      content,
      translatedContent,
      url: url || (handle && externalId ? `https://x.com/${handle}/status/${externalId}` : ''),
      publishedAt,
      media
    };
  }

  function normalizeReplyContext(tweet) {
    const currentTweetId = numericTweetId(tweet?.tweet_id || tweet?.id);
    const replyHandle = replyHandleFromValue(tweet?.reply_to);
    const referencedId = explicitReplyParentId(tweet);
    const normalizeCandidates = (values) => values
      .map(replyContextCandidate)
      .filter((candidate) => candidate && (!currentTweetId || candidate.externalId !== currentTweetId));
    const compatible = (candidate) => {
      const candidateHandle = replyHandleFromValue(candidate?.author?.handle);
      if (replyHandle && candidateHandle && replyHandle.toLowerCase() !== candidateHandle.toLowerCase()) return false;
      if (referencedId && candidate.externalId && referencedId !== candidate.externalId) return false;
      return true;
    };
    const explicitCandidates = normalizeCandidates([
      tweet?.reply_to_post,
      tweet?.reply_to_tweet,
      tweet?.parent_post,
      tweet?.parent_tweet,
      tweet?.ori_tweet,
      tweet?.original_post,
      tweet?.original_tweet
    ]);
    const explicitParent = explicitCandidates.find(compatible);
    if (explicitParent) return explicitParent;

    const quotedCandidates = normalizeCandidates([tweet?.quoted_post, tweet?.quoted_tweet]);
    return quotedCandidates.find((candidate) => {
      if (!compatible(candidate)) return false;
      const candidateHandle = replyHandleFromValue(candidate?.author?.handle);
      const handleVerified = Boolean(replyHandle && candidateHandle
        && replyHandle.toLowerCase() === candidateHandle.toLowerCase());
      const idVerified = Boolean(referencedId && candidate.externalId === referencedId);
      return handleVerified || idVerified;
    }) || null;
  }

  function normalizeQuoteContext(tweet, payload = {}) {
    const currentTweetId = numericTweetId(tweet?.tweet_id || tweet?.id);
    const explicitId = [
      tweet?.quoted_tweet_id,
      tweet?.quotedTweetId,
      tweet?.quoted_status_id,
      tweet?.quoted_status_id_str,
      payload?.quoted_tweet_id,
      payload?.quotedTweetId,
      payload?.quoted_status_id,
      payload?.quoted_status_id_str
    ].map(numericTweetId).find(Boolean) || '';
    const candidates = [
      tweet?.quoted_post,
      tweet?.quoted_tweet,
      tweet?.quote_post,
      tweet?.quote_tweet,
      payload?.quoted_post,
      payload?.quoted_tweet,
      payload?.quote_post,
      payload?.quote_tweet,
      // Some DeBot quote events expose the quoted post as the original tweet.
      tweet?.ori_tweet,
      payload?.ori_tweet
    ]
      .map(replyContextCandidate)
      .filter((candidate) => candidate && (!currentTweetId || candidate.externalId !== currentTweetId));
    const matching = explicitId
      ? candidates.find((candidate) => !candidate.externalId || candidate.externalId === explicitId)
      : candidates[0];
    if (matching) {
      return {
        ...matching,
        externalId: matching.externalId || explicitId
      };
    }
    return explicitId ? {
      externalId: explicitId,
      author: { id: '', handle: '', name: '', avatarUrl: '' },
      content: '',
      translatedContent: '',
      url: '',
      publishedAt: 0,
      media: []
    } : null;
  }

  function normalizePost(payload, feedSource = 'my') {
    if (!payload || typeof payload !== 'object') return null;
    const tweet = payload.tweet || {};
    const user = payload.user || tweet.user || {};
    const handle = handleText(
      user.username
        || user.screen_name
        || user.screenName
        || user.handle
        || user.profile_info?.Username
        || user.profile_info?.username
        || payload.screen_name
        || payload.screenName
        || payload.username
    );
    const rawExternalId = String(payload.doc_id || tweet.tweet_id || payload.id || '').trim();
    if (!rawExternalId) return null;
    const identity = eventIdentity(rawExternalId, handle);
    if (identity?.invalid) return null;
    const kind = eventType(payload, identity);
    if (!SOCIAL_EVENT_KINDS.has(kind)) return null;
    const tweetId = String(tweet.tweet_id || tweet.id || (/^\d{5,25}$/.test(rawExternalId) ? rawExternalId : '')).trim();
    const statusUrl = String(tweet.link || payload.link || '').trim();
    const publishedEvidenceAt = firstTimestamp([
      payload.publish_timestamp,
      payload.publishTimestamp,
      tweet.date,
      tweet.created_at,
      tweet.createdAt,
      payload.date,
      payload.created_at,
      payload.createdAt
    ]);
    const stableEventAt = stableEventTimestamp(identity?.occurrenceAt, [
      payload.save_time,
      payload.saveTime,
      payload.index_time,
      payload.indexTime,
      payload.publish_timestamp,
      payload.publishTimestamp,
      tweet.date,
      tweet.created_at,
      tweet.createdAt,
      payload.date,
      payload.created_at,
      payload.createdAt
    ]);
    if (['post', 'reply', 'quote', 'repost'].includes(kind)) {
      const validStatusUrl = /^https?:\/\/(?:www\.)?(?:x|twitter)\.com\/[^/]+\/status\/[^/?#]+/i.test(statusUrl);
      if (!/^\d{5,25}$/.test(tweetId) || (publishedEvidenceAt === null && !validStatusUrl)) return null;
    }
    if (kind === 'delete' && (!/^\d{5,25}$/.test(tweetId) || stableEventAt === null)) return null;
    if (['follow', 'unfollow', 'profile'].includes(kind) && stableEventAt === null) return null;
    const replyContext = kind === 'reply' ? normalizeReplyContext(tweet) : null;
    const quoteContext = kind === 'quote' ? normalizeQuoteContext(tweet, payload) : null;
    const replyTargetHandle = kind === 'reply'
      ? replyHandleFromValue(tweet.reply_to) || replyHandleFromValue(replyContext?.author?.handle)
      : '';
    const replyContextHandle = replyHandleFromValue(replyContext?.author?.handle);
    const replyContextMatchesTarget = Boolean(replyTargetHandle && replyContextHandle
      && replyTargetHandle.toLowerCase() === replyContextHandle.toLowerCase());
    const replyTargetAuthor = replyContextMatchesTarget ? replyContext.author : {};
    const target = ['follow', 'unfollow'].includes(kind)
      ? normalizeTarget(payload, identity)
      : kind === 'reply' && /^[a-z0-9_]{1,15}$/i.test(replyTargetHandle)
        ? {
            id: limitedText(replyTargetAuthor.id || '', 240),
            handle: limitedText(replyTargetHandle, 240),
            name: limitedText(replyTargetAuthor.name || '', 500),
            avatarUrl: limitedText(replyTargetAuthor.avatarUrl || '', 2_000),
            followersCount: 0,
            url: `https://x.com/${replyTargetHandle}`
          }
        : null;
    if (identity?.target && target?.handle
      && identity.target.toLowerCase() !== target.handle.toLowerCase()) return null;
    const identityAuthor = handleText(handle || identity?.author).toLowerCase();
    const identityTarget = handleText(target?.handle || identity?.target).toLowerCase();
    if (['follow', 'unfollow'].includes(kind)
      && (!/^[a-z0-9_]{1,15}$/i.test(identityAuthor) || !/^[a-z0-9_]{1,15}$/i.test(identityTarget))) {
      return null;
    }
    const profile = kind === 'profile' ? profileChangeData(payload) : { changes: [], detail: {} };
    if (kind === 'profile' && (!/^[a-z0-9_]{1,15}$/i.test(identityAuthor) || !profile.changes.length)) {
      return null;
    }
    const discoveredAt = Date.now();
    const isAccountActivity = ['follow', 'unfollow', 'profile'].includes(kind);
    const publishedAt = isAccountActivity
      ? stableEventAt
      : publishedEvidenceAt ?? stableEventAt ?? discoveredAt;
    const sourceUpdatedAt = stableEventAt ?? publishedAt;
    const platform = Number(payload.platform ?? 0);
    const content = isAccountActivity ? '' : limitedText(tweet.text || payload.text || '', 100_000).trim();
    const mentioned = !isAccountActivity && Array.isArray(payload.mentioned_ca)
      ? payload.mentioned_ca.slice(0, 32)
      : [];
    const deleted = kind === 'delete' || payload.is_deleted === true;
    const occurrenceAt = Number(stableEventAt);
    return {
      source: platform === 1 ? 'binance' : 'twitter',
      externalId: ['follow', 'unfollow'].includes(kind)
        ? `${kind}:${identityAuthor}:${identityTarget}:${occurrenceAt}`
        : kind === 'profile'
          ? `profile:${identityAuthor}:${sourceUpdatedAt}`
          : rawExternalId,
      kind,
      author: {
        id: limitedText(user.id || user.user_id || '', 240),
        handle: limitedText(handle || identity?.author || '', 240),
        name: limitedText(user.name || user.display_name || user.displayName || '', 500),
        avatarUrl: limitedText(user.avatar || user.profile_image_url_https || '', 2_000),
        followersCount: Number(user.followers_count || user.profile_info?.Stats?.Followers || 0)
      },
      ...(target ? { target } : {}),
      ...(replyContext ? { replyContext } : {}),
      ...(quoteContext ? { quoteContext } : {}),
      ...(kind === 'profile' ? { profileChanges: profile.changes, profileDetail: profile.detail } : {}),
      content,
      translatedContent: isAccountActivity ? '' : limitedText(translation(tweet) || payload.translated_text || '', 100_000),
      url: isAccountActivity ? '' : limitedText(statusUrl || (handle && tweetId ? `https://x.com/${handle}/status/${tweetId}` : ''), 2_000),
      media: isAccountActivity ? [] : mediaItems(tweet),
      contractAddresses: mentioned.map((item) => ({
        address: limitedText(item.ca_address || item.address || item.ca || '', 100),
        chain: limitedText(item.chain || '', 20).toLowerCase()
      })),
      chainTags: mentioned.map((item) => limitedText(item.chain || '', 20).toLowerCase()).filter(Boolean),
      replyToExternalId: kind === 'reply'
        ? numericTweetId(replyContext?.externalId) || explicitReplyParentId(tweet)
        : '',
      quotedExternalId: isAccountActivity ? '' : limitedText(
        quoteContext?.externalId
          || tweet.quoted_post?.tweet_id
          || tweet.quoted_tweet_id
          || tweet.quoted_status_id_str
          || '',
        240
      ),
      repostExternalId: isAccountActivity ? '' : limitedText(tweet.retweeted_post?.tweet_id || '', 240),
      publishedAt,
      discoveredAt,
      receivedAt: discoveredAt,
      sourceUpdatedAt,
      deleted,
      deletedAt: deleted ? stableEventAt ?? publishedAt : null,
      feedSources: [feedSource]
    };
  }

  function postIdentity(post) {
    return `${post.source}:${post.externalId}`;
  }

  function stableStringify(value) {
    if (value === null || typeof value !== 'object') return JSON.stringify(value);
    if (Array.isArray(value)) return `[${value.map(stableStringify).join(',')}]`;
    const keys = Object.keys(value).sort();
    return `{${keys.map((key) => `${JSON.stringify(key)}:${stableStringify(value[key])}`).join(',')}}`;
  }

  function postFingerprint(post) {
    // Browser observation times change on every poll and are not source
    // revisions. Every other normalized field is persisted or displayed.
    const { discoveredAt: _discoveredAt, receivedAt: _receivedAt, ...sourceVersion } = post;
    return stableStringify(sourceVersion);
  }

  function mergeSocialAccount(previous, incoming) {
    const older = previous && typeof previous === 'object' ? previous : {};
    const newer = incoming && typeof incoming === 'object' ? incoming : {};
    const merged = { ...older };
    for (const [name, value] of Object.entries(newer)) {
      if (value !== '' && value !== null && value !== undefined
        && !(name === 'followersCount' && Number(value) === 0)) {
        merged[name] = value;
      }
    }
    return merged;
  }

  function replyParentId(post) {
    return numericTweetId(post?.replyContext?.externalId) || numericTweetId(post?.replyToExternalId);
  }

  function replyContextsConflict(previousPost, incomingPost) {
    const previousId = replyParentId(previousPost);
    const incomingId = replyParentId(incomingPost);
    if (previousId && incomingId) return previousId !== incomingId;
    const previousHandle = replyHandleFromValue(previousPost?.replyContext?.author?.handle);
    const incomingHandle = replyHandleFromValue(incomingPost?.replyContext?.author?.handle);
    return Boolean(previousHandle && incomingHandle
      && previousHandle.toLowerCase() !== incomingHandle.toLowerCase());
  }

  function quoteParentId(post) {
    return numericTweetId(post?.quoteContext?.externalId) || numericTweetId(post?.quotedExternalId);
  }

  function quoteContextsConflict(previousPost, incomingPost) {
    const previousId = quoteParentId(previousPost);
    const incomingId = quoteParentId(incomingPost);
    if (previousId && incomingId) return previousId !== incomingId;
    const previousHandle = replyHandleFromValue(previousPost?.quoteContext?.author?.handle);
    const incomingHandle = replyHandleFromValue(incomingPost?.quoteContext?.author?.handle);
    return Boolean(previousHandle && incomingHandle
      && previousHandle.toLowerCase() !== incomingHandle.toLowerCase());
  }

  function mergeReplyContext(previous, incoming) {
    const older = previous && typeof previous === 'object' && !Array.isArray(previous) ? previous : null;
    const newer = incoming && typeof incoming === 'object' && !Array.isArray(incoming) ? incoming : null;
    if (!older) return newer;
    if (!newer) return older;
    const olderId = numericTweetId(older.externalId);
    const newerId = numericTweetId(newer.externalId);
    if (olderId && newerId && olderId !== newerId) return newer;
    const preferText = (next, current) => String(next || '').trim() || String(current || '').trim();
    return {
      externalId: newerId || olderId,
      author: mergeSocialAccount(older.author, newer.author),
      content: preferText(newer.content, older.content),
      translatedContent: preferText(newer.translatedContent, older.translatedContent),
      url: preferText(newer.url, older.url),
      publishedAt: Number(newer.publishedAt || 0) > 0
        ? Number(newer.publishedAt)
        : Math.max(0, Number(older.publishedAt || 0)),
      media: mergeMediaItems(older.media, newer.media)
    };
  }

  function mergeObservedPosts(previous, incoming) {
    if (!previous) return incoming;
    if (!incoming) return previous;
    const previousUpdatedAt = Number(previous.sourceUpdatedAt || previous.publishedAt || 0);
    const incomingUpdatedAt = Number(incoming.sourceUpdatedAt || incoming.publishedAt || 0);
    const older = incomingUpdatedAt >= previousUpdatedAt ? previous : incoming;
    const newer = incomingUpdatedAt >= previousUpdatedAt ? incoming : previous;
    const merged = {
      ...older,
      ...newer,
      author: mergeSocialAccount(older.author, newer.author),
      media: mergeMediaItems(older.media, newer.media),
      discoveredAt: Math.min(
        Number(older.discoveredAt || older.receivedAt || Number.MAX_SAFE_INTEGER),
        Number(newer.discoveredAt || newer.receivedAt || Number.MAX_SAFE_INTEGER)
      ),
      feedSources: Array.from(new Set([
        ...(older.feedSources || []),
        ...(newer.feedSources || [])
      ])).sort()
    };
    const replyConflict = replyContextsConflict(older, newer);
    if (replyConflict) {
      if (newer.replyContext) merged.replyContext = newer.replyContext;
      else delete merged.replyContext;
      merged.replyToExternalId = replyParentId(newer);
    } else if (older.replyContext || newer.replyContext) {
      merged.replyContext = mergeReplyContext(older.replyContext, newer.replyContext);
      merged.replyToExternalId = numericTweetId(merged.replyContext?.externalId)
        || replyParentId(newer)
        || replyParentId(older);
    } else if (older.kind === 'reply' || newer.kind === 'reply') {
      merged.replyToExternalId = replyParentId(newer) || replyParentId(older);
    }
    const quoteConflict = quoteContextsConflict(older, newer);
    if (quoteConflict) {
      if (newer.quoteContext) merged.quoteContext = newer.quoteContext;
      else delete merged.quoteContext;
      merged.quotedExternalId = quoteParentId(newer);
    } else if (older.quoteContext || newer.quoteContext) {
      merged.quoteContext = mergeReplyContext(older.quoteContext, newer.quoteContext);
      merged.quotedExternalId = numericTweetId(merged.quoteContext?.externalId)
        || quoteParentId(newer)
        || quoteParentId(older);
    } else if (older.kind === 'quote' || newer.kind === 'quote') {
      merged.quotedExternalId = quoteParentId(newer) || quoteParentId(older);
    }
    if (older.target || newer.target) {
      const olderTargetHandle = replyHandleFromValue(older.target?.handle);
      const newerTargetHandle = replyHandleFromValue(newer.target?.handle);
      merged.target = olderTargetHandle && newerTargetHandle
        && olderTargetHandle.toLowerCase() !== newerTargetHandle.toLowerCase()
        ? newer.target
        : mergeSocialAccount(older.target, newer.target);
    }
    if (older.profileChanges || newer.profileChanges) {
      merged.profileChanges = Array.from(new Set([
        ...(older.profileChanges || []),
        ...(newer.profileChanges || [])
      ]));
      merged.profileDetail = { ...(older.profileDetail || {}), ...(newer.profileDetail || {}) };
    }
    return merged;
  }

  function clearDeliveryTimers(delivery) {
    if (typeof clearTimeout !== 'function') return;
    if (delivery.timeoutId !== null) clearTimeout(delivery.timeoutId);
    if (delivery.retryTimerId !== null) clearTimeout(delivery.retryTimerId);
  }

  function utf8Bytes(value) {
    let bytes = 0;
    for (let index = 0; index < value.length; index += 1) {
      const code = value.charCodeAt(index);
      if (code < 0x80) bytes += 1;
      else if (code < 0x800) bytes += 2;
      else if (code >= 0xd800 && code <= 0xdbff
        && value.charCodeAt(index + 1) >= 0xdc00
        && value.charCodeAt(index + 1) <= 0xdfff) {
        bytes += 4;
        index += 1;
      } else bytes += 3;
    }
    return bytes;
  }

  function postPayloadBytes(post) {
    return utf8Bytes(JSON.stringify(post));
  }

  function durabilityReceipt() {
    let resolve;
    const promise = new Promise((complete) => {
      resolve = complete;
    });
    return { promise, resolve, settled: false };
  }

  function settleDurability(receipt) {
    if (!receipt || receipt.settled) return;
    receipt.settled = true;
    receipt.resolve();
  }

  function notifyPendingCapacity() {
    const waiters = [...pendingCapacityWaiters];
    pendingCapacityWaiters.clear();
    for (const resolve of waiters) resolve();
  }

  function waitForPendingCapacity() {
    return new Promise((resolve) => pendingCapacityWaiters.add(resolve));
  }

  function pendingPostFits(bytes, replacing = null) {
    const records = pendingPosts.size - (replacing ? 1 : 0) + 1;
    const totalBytes = pendingPostBytes - Number(replacing?.bytes || 0) + bytes;
    return records <= PAGE_PENDING_MAX_POSTS && totalBytes <= PAGE_PENDING_MAX_BYTES;
  }

  function detachPendingPost(key, pending) {
    if (pendingPosts.get(key)?.deliveryId !== pending.deliveryId) return null;
    pendingPosts.delete(key);
    pendingPostBytes = Math.max(0, pendingPostBytes - Number(pending.bytes || 0));
    const delivery = pendingDeliveries.get(pending.deliveryId);
    if (!delivery) return pending;
    delivery.items = delivery.items.filter((item) => item.key !== key);
    if (!delivery.items.length) {
      clearDeliveryTimers(delivery);
      pendingDeliveries.delete(pending.deliveryId);
    }
    return pending;
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
      pendingPostBytes = Math.max(0, pendingPostBytes - Number(item.bytes || 0));
      seen.set(item.key, {
        fingerprint: item.fingerprint,
        feedSources: item.feedSources,
        post: item.post,
        sourceUpdatedAt: item.post.sourceUpdatedAt,
        at: now
      });
      settleDurability(item.durability);
    }
    pendingDeliveries.delete(deliveryId);
    const resumeAfterBackpressure = pendingPostBackpressured;
    pendingPostBackpressured = false;
    notifyPendingCapacity();
    if (resumeAfterBackpressure) requestPrimaryFollowUp();
  }

  function retryDelivery(deliveryId) {
    const delivery = pendingDeliveries.get(deliveryId);
    if (!delivery || delivery.retryTimerId !== null) return;
    if (delivery.timeoutId !== null && typeof clearTimeout === 'function') clearTimeout(delivery.timeoutId);
    delivery.timeoutId = null;

    const resend = () => {
      const current = pendingDeliveries.get(deliveryId);
      if (current !== delivery) return;
      delivery.retryTimerId = null;
      delivery.attempt += 1;
      delivery.at = Date.now();
      const items = delivery.items.filter((item) => pendingPosts.get(item.key)?.deliveryId === deliveryId);
      if (!items.length) {
        pendingDeliveries.delete(deliveryId);
        return;
      }
      delivery.timeoutId = setTimeout(() => retryDelivery(deliveryId), DELIVERY_TIMEOUT_MS);
      emit('posts', { posts: items.map((item) => item.post), deliveryId });
    };

    if (typeof setTimeout !== 'function') return;
    const delay = Math.min(
      DELIVERY_RETRY_BASE_MS * (2 ** Math.min(delivery.attempt, 4)),
      DELIVERY_RETRY_MAX_MS
    );
    delivery.retryTimerId = setTimeout(resend, delay);
  }

  function deliverPosts(posts, attempt = 0) {
    const now = Date.now();
    const candidates = new Map();
    for (const post of posts) {
      if (!post) continue;
      const key = postIdentity(post);
      const previous = candidates.get(key);
      candidates.set(key, mergeObservedPosts(previous, post));
    }

    const fresh = [];
    const durability = new Set();
    const entries = [...candidates.entries()];
    let remaining = [];
    let deliveryId = '';
    for (let index = 0; index < entries.length; index += 1) {
      const [key, candidate] = entries[index];
      const acknowledged = seen.get(key);
      const pending = pendingPosts.get(key);
      let post = mergeObservedPosts(acknowledged?.post, pending?.post);
      post = mergeObservedPosts(post, candidate);
      const fingerprint = postFingerprint(post);
      if (acknowledged?.fingerprint === fingerprint) continue;
      if (pending?.fingerprint === fingerprint) {
        durability.add(pending.durability.promise);
        if (now - pending.at >= DELIVERY_TIMEOUT_MS) retryDelivery(pending.deliveryId);
        continue;
      }
      const bytes = postPayloadBytes(post);
      if (!pendingPostFits(bytes, pending)) {
        remaining = entries.slice(index).map(([, value]) => value);
        break;
      }
      const previous = pending ? detachPendingPost(key, pending) : null;
      if (!deliveryId) {
        deliverySequence += 1;
        deliveryId = `${now.toString(36)}-${deliverySequence.toString(36)}`;
      }
      const item = {
        post,
        key,
        fingerprint,
        feedSources: post.feedSources,
        bytes,
        deliveryId,
        at: now,
        durability: previous?.durability || durabilityReceipt()
      };
      pendingPosts.set(key, item);
      pendingPostBytes += bytes;
      durability.add(item.durability.promise);
      fresh.push(item);
    }
    for (const [key, value] of seen) if (now - value.at > 24 * 60 * 60 * 1_000) seen.delete(key);
    for (const [deliveryId, delivery] of pendingDeliveries) {
      if (delivery.timeoutId === null && delivery.retryTimerId === null && now - delivery.at >= DELIVERY_TIMEOUT_MS) {
        retryDelivery(deliveryId);
      }
    }
    if (fresh.length) {
      const timeoutId = typeof setTimeout === 'function'
        ? setTimeout(() => retryDelivery(deliveryId), DELIVERY_TIMEOUT_MS)
        : null;
      pendingDeliveries.set(deliveryId, { items: fresh, at: now, timeoutId, retryTimerId: null, attempt });
      emit('posts', { posts: fresh.map(({ post }) => post), deliveryId });
    }
    if (remaining.length) {
      pendingPostBackpressured = true;
      requestTimelineCatchUp();
    }
    return {
      queued: fresh.length,
      waiting: durability.size,
      remaining,
      backpressured: remaining.length > 0,
      durable: Promise.all([...durability])
    };
  }

  async function deliverPostsDurably(posts) {
    let remaining = (Array.isArray(posts) ? posts : [posts]).filter(Boolean);
    while (remaining.length) {
      const result = deliverPosts(remaining);
      if (result.waiting) await result.durable;
      remaining = result.remaining;
      if (remaining.length && !result.waiting) await waitForPendingCapacity();
    }
  }

  async function completeDeliveryDurably(delivery) {
    await delivery.durable;
    if (delivery.remaining.length) await deliverPostsDurably(delivery.remaining);
  }

  function healthyHeartbeatCapabilities() {
    return [
      'posts',
      'watchlist',
      'commands',
      'debot-session',
      'debot-analysis-v1',
      'debot-token-holders-v1',
      ...(timelineCatchUpTruncated ? ['catchup-truncated'] : [])
    ];
  }

  function emitHealthyHeartbeat() {
    emit('heartbeat', {
      bridgeId: 'debot-browser-extension',
      version: BRIDGE_VERSION,
      sessionId: BRIDGE_SESSION_ID,
      capabilities: healthyHeartbeatCapabilities(),
      diagnostics: bridgeDiagnosticsSnapshot()
    });
  }

  function resetTransientPrimaryFailures() {
    transientPrimaryFailures = 0;
    firstTransientPrimaryFailureAt = 0;
  }

  function hasAuthorizedPortalSocket() {
    return portalAuthorizedSocketCount > 0;
  }

  function shouldReportPrimaryError(errorType) {
    if (errorType === 'AUTH') {
      resetTransientPrimaryFailures();
      return true;
    }
    if (hasAuthorizedPortalSocket()) {
      resetTransientPrimaryFailures();
      return false;
    }
    const timestamp = Date.now();
    if (transientPrimaryFailures === 0) firstTransientPrimaryFailureAt = timestamp;
    transientPrimaryFailures += 1;
    return transientPrimaryFailures >= PRIMARY_TRANSIENT_ERROR_MIN_FAILURES
      && timestamp - firstTransientPrimaryFailureAt >= PRIMARY_TRANSIENT_ERROR_MIN_DURATION_MS;
  }

  function requestTimelineCatchUp({ force = false, boundaryCutoff = lastPrimarySuccessAt } = {}) {
    if (timelineCatchUpRequired && !force) return;
    timelineCatchUpGeneration += 1;
    timelineCatchUpRequired = true;
    timelineCatchUpCursor = '';
    timelineCatchUpPages = 0;
    timelineCatchUpPosts = 0;
    const observedBeforeOutage = [...seen.entries(), ...pendingPosts.entries()]
      .filter(([, value]) => Number(value?.post?.discoveredAt || value?.post?.receivedAt || 0) <= boundaryCutoff)
      .map(([key]) => key);
    timelineCatchUpBoundary = new Set(observedBeforeOutage);
  }

  function finishTimelineCatchUp(generation = timelineCatchUpGeneration, { truncated = false } = {}) {
    if (generation !== timelineCatchUpGeneration) return;
    const warningChanged = timelineCatchUpTruncated !== truncated;
    timelineCatchUpTruncated = truncated;
    timelineCatchUpRequired = false;
    timelineCatchUpCursor = '';
    timelineCatchUpPages = 0;
    timelineCatchUpPosts = 0;
    timelineCatchUpBoundary.clear();
    if (truncated || warningChanged) emitHealthyHeartbeat();
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
    const requestedTimeout = Number(options.timeoutMs);
    const timeoutMs = Number.isFinite(requestedTimeout) && requestedTimeout > 0
      ? requestedTimeout
      : API_TIMEOUT_MS;
    const { timeoutMs: _timeoutMs, ...requestOptions } = options;
    const controller = typeof AbortController === 'function' ? new AbortController() : null;
    const timeoutId = controller && typeof setTimeout === 'function'
      ? setTimeout(() => controller.abort(), timeoutMs)
      : null;
    let response;
    let body;
    try {
      response = await fetch(`/api/${String(path).replace(/^\/+/, '')}`, {
        credentials: 'include',
        headers: { accept: 'application/json', ...(requestOptions.body ? { 'content-type': 'application/json' } : {}) },
        ...requestOptions,
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

  class AnalysisJobError extends Error {
    constructor(errorType) {
      super(errorType);
      this.name = 'AnalysisJobError';
      this.errorType = errorType;
    }
  }

  function optionalNumber(value) {
    if (value === null || value === undefined || value === '') return undefined;
    const result = Number(value);
    return Number.isFinite(result) ? result : undefined;
  }

  function compact(value) {
    return Object.fromEntries(Object.entries(value).filter(([, item]) => item !== undefined && item !== ''));
  }

  function limitedText(value, maximum) {
    return String(value ?? '').slice(0, maximum);
  }

  function utf8Bytes(value) {
    let bytes = 0;
    for (let index = 0; index < value.length; index += 1) {
      const code = value.charCodeAt(index);
      if (code < 0x80) bytes += 1;
      else if (code < 0x800) bytes += 2;
      else if (code >= 0xd800 && code <= 0xdbff
        && value.charCodeAt(index + 1) >= 0xdc00
        && value.charCodeAt(index + 1) <= 0xdfff) {
        bytes += 4;
        index += 1;
      } else bytes += 3;
    }
    return bytes;
  }

  function normalizeEvmAddress(value) {
    const address = String(value || '').trim().toLowerCase();
    return EVM_ADDRESS_PATTERN.test(address) ? address : '';
  }

  function sanitizeTokenDetail(rawValue, payload) {
    if (!rawValue || typeof rawValue !== 'object' || Array.isArray(rawValue)) {
      throw new AnalysisJobError('DEBOT');
    }
    const raw = rawValue;
    const token = raw.token && typeof raw.token === 'object' ? raw.token : {};
    const meta = token.meta && typeof token.meta === 'object' ? token.meta : {};
    const social = token.social && typeof token.social === 'object' ? token.social : {};
    const pair = raw.pair && typeof raw.pair === 'object' ? raw.pair : {};
    const dex = pair.dex && typeof pair.dex === 'object' ? pair.dex : {};
    const market = raw.market_metrics && typeof raw.market_metrics === 'object' ? raw.market_metrics : {};
    const explicitChains = [meta.chain, pair.chain]
      .filter((value) => value !== null && value !== undefined && String(value).trim())
      .map((value) => String(value).trim().toLowerCase());
    const explicitAddresses = [meta.address, pair.tokenAddress]
      .filter((value) => value !== null && value !== undefined && String(value).trim())
      .map(normalizeEvmAddress);
    if (!explicitAddresses.length
      || explicitChains.some((chain) => chain !== payload.chain)
      || explicitAddresses.some((address) => !address || address !== payload.token)) {
      throw new AnalysisJobError('DEBOT');
    }
    const address = payload.token;
    const pools = (Array.isArray(raw.pools?.list) ? raw.pools.list : []).slice(0, 32).map((entry) => {
      const pool = entry && typeof entry === 'object' ? entry : {};
      const baseToken = pool.base_token && typeof pool.base_token === 'object' ? pool.base_token : {};
      return compact({
        pair: normalizeEvmAddress(pool.pair),
        dex_name: limitedText(pool.dex_name, 120),
        contract: limitedText(pool.contract, 120),
        liquidity: optionalNumber(pool.liquidity),
        base_token: compact({
          symbol: limitedText(baseToken.symbol, 120),
          address: normalizeEvmAddress(baseToken.address)
        })
      });
    });
    return {
      token: {
        meta: compact({
          chain: payload.chain,
          address,
          creator_address: normalizeEvmAddress(meta.creator_address),
          symbol: limitedText(meta.symbol, 120),
          name: limitedText(meta.name, 500),
          decimals: optionalNumber(meta.decimals),
          logo: limitedText(meta.logo, 2_000),
          creation_timestamp: optionalNumber(meta.creation_timestamp)
        }),
        social: compact({ logo_cache: limitedText(social.logo_cache, 2_000) })
      },
      pair: compact({
        chain: payload.chain,
        tokenPairAddress: normalizeEvmAddress(pair.tokenPairAddress),
        pair: normalizeEvmAddress(pair.pair),
        tokenAddress: normalizeEvmAddress(pair.tokenAddress) || address,
        tokenSymbol: limitedText(pair.tokenSymbol, 120),
        tokenName: limitedText(pair.tokenName, 500),
        decimals: optionalNumber(pair.decimals),
        createTimestamp: optionalNumber(pair.createTimestamp),
        price: optionalNumber(pair.price),
        market_cap: optionalNumber(pair.market_cap),
        liquidity: optionalNumber(pair.liquidity),
        totalSupply: optionalNumber(pair.totalSupply),
        lastUpdateTime: optionalNumber(pair.lastUpdateTime),
        dex_name: limitedText(pair.dex_name, 120),
        dex: compact({ dex_name: limitedText(dex.dex_name, 120) })
      }),
      market_metrics: compact({
        price: optionalNumber(market.price),
        mkt_cap: optionalNumber(market.mkt_cap),
        fdv: optionalNumber(market.fdv),
        total_liquidity: optionalNumber(market.total_liquidity),
        liquidity: optionalNumber(market.liquidity),
        holders: optionalNumber(market.holders),
        update_time: optionalNumber(market.update_time)
      }),
      pools: { list: pools }
    };
  }

  const WALLET_PROFIT_NUMERIC_FIELDS = [
    'price',
    'buy_amount',
    'sell_amount',
    'buy_volume',
    'sell_volume',
    'position',
    'hold_amount',
    'actual_buy_amount',
    'balance',
    'holding_value_usd',
    'position_value_usd',
    'balance_usd',
    'avg_buy_price',
    'actual_buy_cost',
    'realized_profit',
    'unrealized_profit',
    'realized_profit_rate',
    'unrealized_profit_rate',
    'profit_rate',
    'profit',
    'avg_cost_price',
    'buy_times',
    'buy_count',
    'sell_times',
    'sell_count',
    'fees_usd',
    'tx_fees_usd',
    'first_trade_time',
    'last_trade_time',
    'hold_duration'
  ];

  const FIRST_FUNDING_FIELDS = [
    'from',
    'from_address',
    'fromAddress',
    'source',
    'source_address',
    'address',
    'wallet',
    'first_tx_hash',
    'tx_hash',
    'txHash',
    'transaction_hash',
    'transactionHash',
    'hash'
  ];

  function sanitizeWalletTokenAnalysis(rawValue, payload) {
    if (!rawValue || typeof rawValue !== 'object' || Array.isArray(rawValue)) {
      throw new AnalysisJobError('DEBOT');
    }
    const raw = rawValue;
    const explicitChain = String(raw.chain || '').trim().toLowerCase();
    const explicitWallet = normalizeEvmAddress(raw.wallet);
    const explicitToken = normalizeEvmAddress(raw.token);
    if (explicitChain !== payload.chain || explicitWallet !== payload.wallet || explicitToken !== payload.token) {
      throw new AnalysisJobError('DEBOT');
    }
    const { wallet, token } = payload;
    const result = { chain: payload.chain, wallet, token };
    for (const field of WALLET_PROFIT_NUMERIC_FIELDS) {
      const parsed = optionalNumber(raw[field]);
      if (parsed !== undefined) result[field] = parsed;
    }
    if (raw.first_funding && typeof raw.first_funding === 'object') {
      result.first_funding = compact(Object.fromEntries(
        FIRST_FUNDING_FIELDS.map((field) => [field, limitedText(raw.first_funding[field], 200)])
      ));
    }
    return result;
  }

  const HOLDER_AMOUNT_FIELDS = [
    'position',
    'hold_amount',
    'holding_amount',
    'holder_amount',
    'token_amount',
    'current_amount',
    'amount'
  ];

  const HOLDER_VALUE_FIELDS = [
    'holding_value_usd',
    'position_value_usd',
    'balance_usd',
    'current_value_usd',
    'value_usd',
    'usd_value'
  ];

  const HOLDER_SHARE_FIELDS = [
    'percentage',
    'share',
    'share_percent',
    'holding_percentage',
    'holding_share_percent'
  ];

  const HOLDER_PROFIT_NUMERIC_FIELDS = [
    ...WALLET_PROFIT_NUMERIC_FIELDS,
    'total_profit',
    'total_profit_rate',
    'pnl',
    'pnl_rate',
    'win_rate',
    'token_count',
    'winning_token_count'
  ];

  function firstPresent(value, fields) {
    for (const field of fields) {
      if (value?.[field] !== null && value?.[field] !== undefined && value[field] !== '') {
        return value[field];
      }
    }
    return undefined;
  }

  function limitedNumericScalar(value) {
    if (typeof value === 'number') return Number.isFinite(value) ? value : undefined;
    if (typeof value !== 'string') return undefined;
    const candidate = value.trim();
    if (!candidate || candidate.length > 120
      || !/^[+-]?(?:\d+(?:\.\d*)?|\.\d+)(?:e[+-]?\d+)?$/i.test(candidate)) return undefined;
    return candidate;
  }

  function limitedNonNegativeNumericScalar(value) {
    const parsed = limitedNumericScalar(value);
    if (parsed === undefined) return undefined;
    return (typeof parsed === 'number' ? parsed < 0 : parsed.startsWith('-')) ? undefined : parsed;
  }

  function optionalBooleanFlag(value) {
    if (value === true || value === 1 || value === '1' || String(value || '').toLowerCase() === 'true') {
      return true;
    }
    if (value === false || value === 0 || value === '0' || String(value || '').toLowerCase() === 'false') {
      return false;
    }
    return undefined;
  }

  function sanitizeHolderTags(...values) {
    const tags = [];
    const seen = new Set();
    const add = (value) => {
      const tag = limitedText(value, 80).trim();
      const key = tag.toLowerCase();
      if (!tag || seen.has(key) || tags.length >= 12) return;
      seen.add(key);
      tags.push(tag);
    };
    const visit = (value, depth = 0) => {
      if (value === null || value === undefined || depth > 2 || tags.length >= 12) return;
      if (['string', 'number', 'boolean'].includes(typeof value)) {
        add(value);
        return;
      }
      if (Array.isArray(value)) {
        for (const item of value.slice(0, 24)) visit(item, depth + 1);
        return;
      }
      if (typeof value !== 'object') return;
      const named = value.name ?? value.label ?? value.tag ?? value.value;
      if (['string', 'number'].includes(typeof named)) {
        add(named);
        return;
      }
      for (const [key, item] of Object.entries(value).slice(0, 24)) {
        if (/(?:auth|cookie|password|secret|session|token)/i.test(key)) continue;
        if (item === true || item === 1) add(key);
        else if (typeof item === 'string') add(item);
      }
    };
    for (const value of values) visit(value);
    return tags;
  }

  function sanitizeHolderProfit(row) {
    const nested = [row.profit_info, row.profitInfo, row.wallet_profit, row.walletProfit, row.profit]
      .find((value) => value && typeof value === 'object' && !Array.isArray(value));
    const source = nested || row;
    const result = {};
    for (const field of HOLDER_PROFIT_NUMERIC_FIELDS) {
      const parsed = optionalNumber(source[field]);
      if (parsed !== undefined) result[field] = parsed;
    }
    return result;
  }

  function sanitizeTokenHolders(rawValue, payload) {
    if (!rawValue || typeof rawValue !== 'object' || Array.isArray(rawValue)) {
      throw new AnalysisJobError('DEBOT');
    }
    const raw = rawValue;
    const explicitChain = typeof raw.chain === 'string' ? raw.chain.trim().toLowerCase() : '';
    const explicitTokenValue = [raw.token, raw.token_address, raw.tokenAddress]
      .find((value) => typeof value === 'string' && value.trim());
    const explicitToken = explicitTokenValue ? normalizeEvmAddress(explicitTokenValue) : '';
    if ((explicitChain && explicitChain !== payload.chain)
      || (explicitTokenValue && (!explicitToken || explicitToken !== payload.token))) {
      throw new AnalysisJobError('DEBOT');
    }
    const rows = [raw.list, raw.holders, raw.wallets, raw.holder_list, raw.holderList]
      .find((value) => Array.isArray(value));
    if (!rows) throw new AnalysisJobError('DEBOT');

    const holders = [];
    const seen = new Set();
    for (const value of rows) {
      if (holders.length >= payload.pageSize) break;
      const row = value && typeof value === 'object' && !Array.isArray(value) ? value : {};
      const address = normalizeEvmAddress(
        row.address || row.wallet || row.wallet_address || row.walletAddress || row.holder || row.owner_address
      );
      if (!address || address === ZERO_EVM_ADDRESS || seen.has(address)) continue;
      seen.add(address);
      const rawRank = optionalNumber(firstPresent(row, ['rank', 'holder_rank', 'holderRank']));
      const rank = Number.isSafeInteger(rawRank) && rawRank > 0 ? rawRank : undefined;
      const holdAmount = limitedNonNegativeNumericScalar(firstPresent(row, HOLDER_AMOUNT_FIELDS));
      const holdingValueUsd = limitedNonNegativeNumericScalar(
        row.balance ?? firstPresent(row, HOLDER_VALUE_FIELDS)
      );
      const ratioPercent = optionalNumber(row.percent);
      const rawPercentage = ratioPercent === undefined
        ? optionalNumber(firstPresent(row, HOLDER_SHARE_FIELDS))
        : ratioPercent * 100;
      const percentage = rawPercentage !== undefined && rawPercentage >= 0 && rawPercentage <= 100
        ? rawPercentage
        : undefined;
      const tags = sanitizeHolderTags(row.tags, row.tag, row.tag_list, row.tagList, row.tag_map, row.tagMap, row.labels);
      const profit = sanitizeHolderProfit(row);
      holders.push(compact({
        address,
        rank,
        holding_amount: holdAmount,
        holding_value_usd: holdingValueUsd,
        holding_share_percent: percentage,
        is_contract: optionalBooleanFlag(row.is_contract ?? row.isContract),
        is_pair: optionalBooleanFlag(row.is_pair ?? row.isPair),
        is_pool: optionalBooleanFlag(row.is_pool ?? row.isPool),
        is_lp: optionalBooleanFlag(row.is_lp ?? row.isLp),
        is_burn: optionalBooleanFlag(row.is_burn ?? row.isBurn),
        type: limitedText(row.type, 120),
        wallet_type: limitedText(row.wallet_type ?? row.walletType, 120),
        label: limitedText(row.label, 120),
        name: limitedText(row.name, 120),
        tags: tags.length ? tags : undefined,
        profit: Object.keys(profit).length ? profit : undefined
      }));
    }

    const result = compact({
      chain: payload.chain,
      token: payload.token,
      total: optionalNumber(raw.total ?? raw.count ?? raw.holder_count ?? raw.holderCount),
      list: holders
    });
    while (holders.length && utf8Bytes(JSON.stringify(result)) > MAX_ANALYSIS_RESULT_BYTES) holders.pop();
    if (utf8Bytes(JSON.stringify(result)) > MAX_ANALYSIS_RESULT_BYTES) {
      throw new AnalysisJobError('RESULT_TOO_LARGE');
    }
    return result;
  }

  function normalizeAnalysisJob(value) {
    const job = value && typeof value === 'object' ? value : {};
    const id = Number(job.id);
    const claimToken = limitedText(job.claimToken, 240);
    if (!Number.isSafeInteger(id) || id <= 0 || !claimToken) return null;
    return {
      id,
      claimToken,
      type: limitedText(job.type, 80),
      payload: job.payload && typeof job.payload === 'object' ? job.payload : {}
    };
  }

  function exactAnalysisPayloadKeys(value, expected) {
    if (!value || typeof value !== 'object' || Array.isArray(value)) return false;
    const keys = Object.keys(value).sort();
    const allowed = [...expected].sort();
    return keys.length === allowed.length && keys.every((key, index) => key === allowed[index]);
  }

  function validatedAnalysisPayload(job) {
    if (!ANALYSIS_JOB_TYPES.has(job.type)) throw new AnalysisJobError('INVALID_JOB');
    const validShape = job.type === 'debot.wallet_token_analysis.v1'
      ? exactAnalysisPayloadKeys(job.payload, ['chain', 'token', 'wallet'])
      : job.type === 'debot.token_holders.v1'
        ? exactAnalysisPayloadKeys(job.payload, ['chain', 'token'])
          || exactAnalysisPayloadKeys(job.payload, ['chain', 'pageSize', 'token'])
        : exactAnalysisPayloadKeys(job.payload, ['chain', 'token']);
    if (!validShape) throw new AnalysisJobError('INVALID_JOB');
    const chain = String(job.payload.chain || '').trim().toLowerCase();
    const token = normalizeEvmAddress(job.payload.token);
    if (!['robinhood', 'base', 'bsc'].includes(chain) || !token || token === ZERO_EVM_ADDRESS) {
      throw new AnalysisJobError('INVALID_JOB');
    }
    if (job.type === 'debot.token_holders.v1') {
      const requestedPageSize = job.payload.pageSize ?? 100;
      const pageSize = Number(requestedPageSize);
      if (!Number.isSafeInteger(pageSize) || pageSize < 1 || pageSize > 100) {
        throw new AnalysisJobError('INVALID_JOB');
      }
      return { chain, token, pageSize };
    }
    if (job.type === 'debot.token_detail.v1') return { chain, token };
    const wallet = normalizeEvmAddress(job.payload.wallet);
    if (!wallet || wallet === ZERO_EVM_ADDRESS) throw new AnalysisJobError('INVALID_JOB');
    return { chain, token, wallet };
  }

  async function executeAnalysisJob(job) {
    const payload = validatedAnalysisPayload(job);
    const params = new URLSearchParams({ chain: payload.chain, token: payload.token });
    let result;
    if (job.type === 'debot.token_detail.v1') {
      result = sanitizeTokenDetail(await api(`dashboard/token/detail?${params}`), payload);
    } else if (job.type === 'debot.wallet_token_analysis.v1') {
      params.set('wallet', payload.wallet);
      result = sanitizeWalletTokenAnalysis(
        await api(`dex/profit/wallet_token_analysis?${params}`),
        payload
      );
    } else {
      params.set('page_size', String(payload.pageSize));
      params.set('sort_field', 'position');
      params.set('sort_order', 'desc');
      result = sanitizeTokenHolders(
        await api(`token/profiler/tokenHolderList?${params}`),
        payload
      );
    }
    if (utf8Bytes(JSON.stringify(result)) > MAX_ANALYSIS_RESULT_BYTES) {
      throw new AnalysisJobError('RESULT_TOO_LARGE');
    }
    return result;
  }

  function analysisErrorType(error) {
    if (['INVALID_JOB', 'RESULT_TOO_LARGE'].includes(error?.errorType)) return error.errorType;
    return coarseErrorType(error);
  }

  function pumpAnalysisQueue() {
    while (activeAnalysisJobs < ANALYSIS_CONCURRENCY && analysisQueue.length) {
      const job = analysisQueue.shift();
      const key = `${job.id}:${job.claimToken}`;
      activeAnalysisJobs += 1;
      void executeAnalysisJob(job).then((result) => {
        emit('analysis-result', {
          jobId: job.id,
          claimToken: job.claimToken,
          success: true,
          result,
          error: '',
          errorType: ''
        });
      }).catch((error) => {
        const errorType = analysisErrorType(error);
        emit('analysis-result', {
          jobId: job.id,
          claimToken: job.claimToken,
          success: false,
          result: null,
          error: errorType,
          errorType
        });
      }).finally(() => {
        activeAnalysisJobs -= 1;
        analysisKeys.delete(key);
        pumpAnalysisQueue();
      });
    }
  }

  function enqueueAnalysisJob(value) {
    const job = normalizeAnalysisJob(value);
    if (!job) return false;
    const key = `${job.id}:${job.claimToken}`;
    if (analysisKeys.has(key)) return false;
    if (analysisQueue.length >= ANALYSIS_QUEUE_LIMIT) {
      emit('analysis-result', {
        jobId: job.id,
        claimToken: job.claimToken,
        success: false,
        result: null,
        error: 'INVALID_JOB',
        errorType: 'INVALID_JOB'
      });
      return false;
    }
    analysisKeys.add(key);
    analysisQueue.push(job);
    pumpAnalysisQueue();
    return true;
  }

  function watchlistRows(data) {
    if (Array.isArray(data)) return data;
    if (!data || typeof data !== 'object') return null;
    for (const key of ['list', 'records', 'items']) {
      if (Object.hasOwn(data, key)) return Array.isArray(data[key]) ? data[key] : null;
    }
    return null;
  }

  function normalizeWatchlistRows(rows) {
    return rows.map((item) => {
      const handle = String(item?.monitor_object || item?.tweet_username || item?.username || '').trim();
      const remoteIdText = String(item?.config_id ?? item?.id ?? '').trim();
      const remoteId = /^\d+$/.test(remoteIdText) ? Number(remoteIdText) : 0;
      if (!handle || !Number.isSafeInteger(remoteId) || remoteId <= 0) return null;
      return {
        platform: Number(item?.platform || 0) === 1 ? 'binance' : 'twitter',
        accountKey: handle.toLowerCase(),
        handle,
        name: String(item?.config_name || item?.tweet_name || item?.name || ''),
        url: String(item?.url || ''),
        remoteId: String(remoteId),
        metadata: { hotSubscribeId: item?.hot_subscribe_id || null, monitorLevel: item?.monitor_level || '' }
      };
    }).filter(Boolean);
  }

  async function fetchWatchlist({ commitRequired = false } = {}) {
    const generation = ++watchlistFetchGeneration;
    const byKey = new Map();
    let complete = false;
    let fetchedRows = 0;
    let emptyFirstPageConfirmed = false;
    for (let page = 1; page <= WATCHLIST_MAX_PAGES; page += 1) {
      const data = await api(`social/subscribe/list?keyword=&page=${page}&page_size=${WATCHLIST_PAGE_SIZE}`);
      const rows = watchlistRows(data);
      if (!rows) throw new Error('DeBot returned an invalid watchlist page');
      const normalizedRows = normalizeWatchlistRows(rows);
      if (normalizedRows.length !== rows.length) throw new Error('DeBot returned an incomplete watchlist account');
      fetchedRows += rows.length;
      for (const account of normalizedRows) {
        byKey.set(`${account.platform}:${account.accountKey}`, account);
      }
      const total = Number(data?.total ?? data?.count ?? data?.pagination?.total ?? data?.page?.total);
      const hasTotal = Number.isFinite(total) && total >= 0;
      if (hasTotal && fetchedRows > total) throw new Error('DeBot watchlist total is inconsistent');
      if (page === 1 && rows.length === 0 && !emptyFirstPageConfirmed) {
        const confirmation = await api(`social/subscribe/list?keyword=&page=1&page_size=${WATCHLIST_PAGE_SIZE}`);
        const confirmationRows = watchlistRows(confirmation);
        const confirmationTotal = Number(
          confirmation?.total
            ?? confirmation?.count
            ?? confirmation?.pagination?.total
            ?? confirmation?.page?.total
        );
        const confirmationHasTotal = Number.isFinite(confirmationTotal) && confirmationTotal >= 0;
        if (!confirmationRows || confirmationRows.length !== 0
          || (confirmationHasTotal && confirmationTotal !== 0)) {
          throw new Error('DeBot returned an unstable empty watchlist');
        }
        emptyFirstPageConfirmed = true;
      }
      if (rows.length < WATCHLIST_PAGE_SIZE || (hasTotal && fetchedRows === total)) {
        if (hasTotal && fetchedRows !== total) throw new Error('DeBot watchlist page is incomplete');
        complete = true;
        break;
      }
    }
    if (!complete) throw new Error('DeBot watchlist exceeds the complete-sync limit');
    const accounts = [...byKey.values()];
    if (generation === watchlistFetchGeneration) {
      cachedAccounts = accounts;
      emit('watchlist', { accounts });
      lastWatchlistAt = Date.now();
    } else if (commitRequired) {
      // A command confirmation must publish the exact complete snapshot it
      // verified. Retry behind a newer concurrent fetch instead of returning
      // success with no committed snapshot.
      return fetchWatchlist({ commitRequired: true });
    }
    return accounts;
  }

  async function fetchPersonalTimelinePage(configIds = [], cursor = '') {
    const params = new URLSearchParams({
      cursor,
      limit: String(TIMELINE_PAGE_SIZE),
      tw_types: DEFAULT_TYPES
    });
    params.set('config_ids', configIds.join('|'));
    const data = await api(`social/twitter/timeline?${params}`, {
      timeoutMs: PRIMARY_API_TIMEOUT_MS
    });
    if (!data || typeof data !== 'object' || !Array.isArray(data.feeds)) {
      throw new Error('DeBot returned an invalid personal timeline page');
    }
    const nextCursor = String(data.next_cursor ?? data.nextCursor ?? '');
    const hasMoreField = data.has_more ?? data.hasMore;
    const hasMore = hasMoreField === true || hasMoreField === 1 || hasMoreField === '1'
      || String(hasMoreField || '').toLowerCase() === 'true'
      || (hasMoreField === undefined && Boolean(nextCursor));
    if (hasMore && !nextCursor) throw new Error('DeBot omitted the personal timeline cursor');
    const posts = data.feeds.map((item) => normalizePost(item, 'my')).filter(Boolean);
    const latestSourceAt = posts.reduce((latest, post) => {
      const sourceAt = Number(post?.sourceUpdatedAt || post?.publishedAt || 0);
      return Number.isSafeInteger(sourceAt) && sourceAt > latest ? sourceAt : latest;
    }, 0);
    return {
      posts,
      hasMore,
      nextCursor,
      rawRows: data.feeds.length,
      normalizedRows: posts.length,
      droppedRows: data.feeds.length - posts.length,
      latestSourceAt
    };
  }

  function accountConfigKey() {
    return cachedAccounts.map((account) => account.remoteId).filter(Boolean).sort().join('|');
  }

  function requestPrimaryFollowUp() {
    if (pollInFlight) {
      primaryFollowUpRequested = true;
      return;
    }
    void fallbackPoll();
  }

  function refreshWatchlistIfNeeded() {
    if (watchlistInFlight || Date.now() - lastWatchlistAt <= 30_000) return watchlistInFlight;
    const previousKey = accountConfigKey();
    const operation = fetchWatchlist().then(() => {
      if (accountConfigKey() !== previousKey) {
        // A changed account set needs a fresh bounded history pass; old-account
        // boundaries cannot prove that a newly added account has been covered.
        requestTimelineCatchUp({ force: true, boundaryCutoff: 0 });
        requestPrimaryFollowUp();
      }
    }).catch(() => {
      // The primary monitored-account timeline remains independent of watchlist refresh failures.
    }).finally(() => {
      if (watchlistInFlight === operation) watchlistInFlight = null;
    });
    watchlistInFlight = operation;
    return operation;
  }

  async function continueTimelineCatchUp(configIds, firstPage, firstPageDelivery, generation) {
    if (!timelineCatchUpRequired || generation !== timelineCatchUpGeneration) return;
    try {
      await completeDeliveryDurably(firstPageDelivery);
    } catch {
      return;
    }
    if (!timelineCatchUpRequired || generation !== timelineCatchUpGeneration) return;
    const firstPageReachedBoundary = !timelineCatchUpCursor
      && firstPage.posts.some((post) => timelineCatchUpBoundary.has(postIdentity(post)));
    if (firstPageReachedBoundary || (!timelineCatchUpCursor && !firstPage.hasMore)) {
      finishTimelineCatchUp(generation);
      return;
    }

    let cursor = timelineCatchUpCursor || firstPage.nextCursor;
    for (let page = 0; page < TIMELINE_CATCHUP_PAGES_PER_POLL; page += 1) {
      if (!timelineCatchUpRequired || generation !== timelineCatchUpGeneration) return;
      if (!cursor) {
        finishTimelineCatchUp(generation);
        return;
      }
      if (timelineCatchUpPages >= TIMELINE_CATCHUP_MAX_PAGES
        || timelineCatchUpPosts >= TIMELINE_CATCHUP_MAX_POSTS) {
        finishTimelineCatchUp(generation, { truncated: true });
        return;
      }

      let olderPage;
      try {
        olderPage = await fetchPersonalTimelinePage(configIds, cursor);
      } catch {
        // Keep the cursor so the next successful primary poll resumes this recovery page.
        return;
      }
      if (!timelineCatchUpRequired || generation !== timelineCatchUpGeneration) return;

      const reachedBoundary = olderPage.posts.some((post) => timelineCatchUpBoundary.has(postIdentity(post)));
      try {
        await deliverPostsDurably(olderPage.posts);
      } catch {
        return;
      }
      if (!timelineCatchUpRequired || generation !== timelineCatchUpGeneration) return;
      timelineCatchUpPages += 1;
      timelineCatchUpPosts += olderPage.posts.length;
      if (reachedBoundary || !olderPage.hasMore) {
        finishTimelineCatchUp(generation);
        return;
      }
      if (timelineCatchUpPages >= TIMELINE_CATCHUP_MAX_PAGES
        || timelineCatchUpPosts >= TIMELINE_CATCHUP_MAX_POSTS) {
        finishTimelineCatchUp(generation, { truncated: true });
        return;
      }
      cursor = olderPage.nextCursor;
      timelineCatchUpCursor = cursor;
    }
  }

  function scheduleTimelineCatchUp(configIds, firstPage, firstPageDelivery) {
    if (!timelineCatchUpRequired || timelineCatchUpInFlight) return;
    const generation = timelineCatchUpGeneration;
    const operation = continueTimelineCatchUp(configIds, firstPage, firstPageDelivery, generation).finally(() => {
      if (timelineCatchUpInFlight === operation) timelineCatchUpInFlight = null;
    });
    timelineCatchUpInFlight = operation;
  }

  async function runPoll() {
    const configIds = cachedAccounts.map((account) => account.remoteId).filter(Boolean);
    beginPrimaryPollDiagnostics(configIds);
    try {
      const firstPage = await fetchPersonalTimelinePage(configIds);
      const firstPageDelivery = deliverPosts(firstPage.posts);
      lastPrimarySuccessAt = Date.now();
      resetTransientPrimaryFailures();
      completePrimaryPollDiagnostics(firstPage);
      emitHealthyHeartbeat();
      scheduleTimelineCatchUp(configIds, firstPage, firstPageDelivery);
      return { ok: true };
    } catch (error) {
      requestTimelineCatchUp();
      const errorType = coarseErrorType(error);
      failPrimaryPollDiagnostics(errorType);
      if (shouldReportPrimaryError(errorType)) {
        emit('heartbeat', {
          bridgeId: 'debot-browser-extension',
          version: BRIDGE_VERSION,
          sessionId: BRIDGE_SESSION_ID,
          capabilities: ['debot-analysis-v1', 'debot-token-holders-v1', 'error'],
          error: errorType,
          diagnostics: bridgeDiagnosticsSnapshot()
        });
      } else emitHealthyHeartbeat();
      return { ok: false, errorType };
    }
  }

  function fallbackPoll() {
    if (pollInFlight) return pollInFlight;
    let succeeded = false;
    const operation = runPoll().then((result) => {
      succeeded = result?.ok === true;
      return result;
    }).finally(() => {
      if (pollInFlight !== operation) return;
      pollInFlight = null;
      if (primaryFollowUpRequested) {
        primaryFollowUpRequested = false;
        if (succeeded) void fallbackPoll();
      }
    });
    pollInFlight = operation;
    return operation;
  }

  async function executeCommand(command) {
    const payload = command?.payload || {};
    if (['wallet.watch.upsert', 'wallet.watch.delete'].includes(command.type)) {
      const address = String(payload.address || '').trim().toLowerCase();
      if (!/^0x[0-9a-f]{40}$/.test(address)) throw new Error('A valid EVM wallet address is required');
      const walletAddress = (item) => String(
        item?.wallet || item?.wallet_address || item?.address || item?.walletAddress || ''
      ).trim().toLowerCase();
      const responseWallets = (response) => {
        if (Array.isArray(response)) return response;
        for (const key of ['wallets', 'list', 'rows', 'items']) {
          if (Array.isArray(response?.[key])) return response[key];
        }
        return [];
      };
      const responseRemarks = (response) => {
        if (Array.isArray(response)) return response;
        for (const key of ['wallet_remarks', 'remarks', 'wallets', 'list', 'rows', 'items']) {
          if (Array.isArray(response?.[key])) return response[key];
        }
        return [];
      };
      const walletRemark = (item) => String(item?.remark || item?.wallet_remark || item?.note || '')
        .trim()
        .slice(0, 500);
      const fetchWalletRemark = async () => {
        const response = await api('wallet/remark/list');
        const match = responseRemarks(response).find((item) => walletAddress(item) === address);
        return match ? walletRemark(match) : '';
      };
      const fetchTrackedWallets = async ({ search = '' } = {}) => {
        const result = [];
        let next = '';
        const seenCursors = new Set();
        for (let page = 0; page < 50; page += 1) {
          const query = new URLSearchParams({
            chain: 'bsc',
            next,
            is_solana: '0',
            ...(search ? { search } : {}),
            filter: '{}'
          });
          const response = await api(`wallet/track/list?${query}`);
          const rows = responseWallets(response);
          result.push(...rows);
          const cursor = String(response?.next || '');
          if (!cursor || seenCursors.has(cursor)) break;
          seenCursors.add(cursor);
          next = cursor;
        }
        return result;
      };
      const findTrackedWallet = async () => {
        const matches = await fetchTrackedWallets({ search: address });
        return matches.find((item) => walletAddress(item) === address) || null;
      };
      const fetchWalletGroups = async () => {
        const response = await api('wallet/group/list');
        if (Array.isArray(response)) return response;
        for (const key of ['groups', 'list', 'rows', 'items']) {
          if (Array.isArray(response?.[key])) return response[key];
        }
        return [];
      };
      const validGroupId = (value) => {
        const id = Number(value);
        return Number.isSafeInteger(id) && id > 0 ? id : null;
      };
      if (command.type === 'wallet.watch.upsert') {
        const expectedNote = String(payload.note || '').trim().slice(0, 500);
        const before = await findTrackedWallet();
        if (!before) {
          const groups = await fetchWalletGroups();
          const defaultGroup = groups.find((group) => Number(group?.type) === 2)
            || groups.find((group) => validGroupId(group?.id ?? group?.group_id));
          const groupId = validGroupId(defaultGroup?.id ?? defaultGroup?.group_id);
          if (!groupId) throw new Error('DeBot default wallet group could not be resolved');
          await api('wallet/track/add', {
            method: 'POST',
            body: JSON.stringify({
              group_ids: [groupId],
              wallet_remarks: [{ wallet: address, remark: expectedNote, emoji: '' }]
            })
          });
        }
        await api('wallet/remark', {
          method: 'POST',
          body: JSON.stringify({
            wallet_remarks: [{
              wallet: address,
              remark: expectedNote,
              color: '',
              emoji: ''
            }]
          })
        });
        const after = await findTrackedWallet();
        if (!after) {
          throw new Error('DeBot wallet monitor did not contain the added address');
        }
        const savedNote = await fetchWalletRemark();
        if (savedNote !== expectedNote) {
          throw new Error('DeBot wallet remark did not match the website name');
        }
        return { remoteId: address };
      }
      const match = await findTrackedWallet();
      const matches = match ? [match] : [];
      if (matches.length) {
        const groupIds = [...new Set(matches.flatMap((item) => [
          item?.group_id,
          ...(Array.isArray(item?.group_ids) ? item.group_ids : [])
        ]).map(validGroupId).filter(Boolean))];
        if (!groupIds.length) throw new Error('DeBot wallet group could not be resolved for deletion');
        for (const groupId of groupIds) {
          await api('wallet/track/delete', {
            method: 'POST',
            body: JSON.stringify({ group_id: groupId, wallets: [address] })
          });
        }
      }
      const after = await findTrackedWallet();
      if (after) {
        throw new Error('DeBot wallet monitor still contains the removed address');
      }
      return { remoteId: address, verifiedAbsent: true };
    }
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
      const targetKey = handle.toLowerCase();
      const matchedAccounts = accounts
        .filter((item) => item.platform === platformName && item.accountKey === targetKey);
      const remoteIds = matchedAccounts
        .map((item) => Number(item.remoteId))
        .filter((id) => Number.isSafeInteger(id) && id > 0);
      if (remoteIds.length) {
        await api('social/subscribe/remove', {
          method: 'POST',
          body: JSON.stringify({ config_ids: remoteIds })
        });
      }
      const syncedAccounts = await fetchWatchlist({ commitRequired: true });
      const removedIds = new Set(remoteIds.map(String));
      const stillPresent = syncedAccounts.some((item) => (
        item.platform === platformName
        && (item.accountKey === targetKey || removedIds.has(String(item.remoteId)))
      ));
      if (stillPresent) throw new Error('DeBot watchlist still contains the deleted account');
      return { remoteId: String(remoteIds[0] || ''), verifiedAbsent: true };
    }
    throw new Error(`Unsupported command: ${command.type}`);
  }

  function trackedWalletAddress(item) {
    return String(item?.wallet || item?.wallet_address || item?.address || item?.walletAddress || '')
      .trim().toLowerCase();
  }

  function trackedWalletNote(item) {
    return String(item?.remark || item?.wallet_remark || item?.note || '').trim().slice(0, 500);
  }

  function trackedWalletRows(response) {
    if (Array.isArray(response)) return response;
    for (const key of ['wallets', 'list', 'rows', 'items']) {
      if (Array.isArray(response?.[key])) return response[key];
    }
    return [];
  }

  async function refreshWalletLibrary() {
    if (walletLibraryInFlight) return walletLibraryInFlight;
    const operation = (async () => {
      const wallets = new Map();
      const remarkResponse = await api('wallet/remark/list');
      const remarkRows = trackedWalletRows(remarkResponse);
      const remarksByAddress = new Map();
      for (const item of remarkRows) {
        const address = trackedWalletAddress(item);
        if (!/^0x[0-9a-f]{40}$/.test(address)) continue;
        remarksByAddress.set(address, trackedWalletNote(item));
      }
      const seenCursors = new Set();
      let next = '';
      let complete = false;
      for (let page = 0; page < 100; page += 1) {
        const query = new URLSearchParams({ chain: 'bsc', next, is_solana: '0', filter: '{}' });
        const response = await api(`wallet/track/list?${query}`);
        for (const item of trackedWalletRows(response)) {
          const address = trackedWalletAddress(item);
          if (!/^0x[0-9a-f]{40}$/.test(address)) continue;
          const note = remarksByAddress.get(address) || '';
          const previous = wallets.get(address);
          if (!previous || (!previous.note && note)) wallets.set(address, { address, note });
        }
        const cursor = String(response?.next || '');
        if (!cursor) {
          complete = true;
          break;
        }
        if (seenCursors.has(cursor)) break;
        seenCursors.add(cursor);
        next = cursor;
      }
      if (!complete) throw new Error('DeBot wallet snapshot pagination was incomplete');
      emit('wallet-library', { complete: true, wallets: [...wallets.values()] });
      return wallets.size;
    })().finally(() => {
      walletLibraryInFlight = null;
    });
    walletLibraryInFlight = operation;
    return operation;
  }

  function socketChannelKey(value) {
    return String(value || '')
      .trim()
      .toLowerCase()
      .replace(/[^a-z0-9]+/g, '-')
      .replace(/^-+|-+$/g, '');
  }

  function normalizedWalletChain(value) {
    const chain = String(value || '').trim().toLowerCase();
    if (['bsc', 'bnb', 'bnbchain', '56'].includes(chain)) return 'bsc';
    if (['base', '8453', 'base-mainnet'].includes(chain)) return 'base';
    if (['robinhood', 'robinhood-chain', 'rh', '4663'].includes(chain)) return 'robinhood';
    return '';
  }

  function walletMetaEntry(values, address) {
    if (!values || typeof values !== 'object' || Array.isArray(values)) return {};
    const normalized = String(address || '').toLowerCase();
    if (values[address]) return values[address];
    if (values[normalized]) return values[normalized];
    const match = Object.entries(values).find(([key]) => String(key).toLowerCase() === normalized);
    return match?.[1] && typeof match[1] === 'object' ? match[1] : {};
  }

  function normalizedWalletActivity(row, meta = {}) {
    if (!row || typeof row !== 'object' || Array.isArray(row)) return null;
    const chain = normalizedWalletChain(row.chain || row.chain_name || row.network);
    const walletAddress = String(row.trader || row.wallet || row.wallet_address || '').trim().toLowerCase();
    const tokenAddress = String(row.token || row.token_address || row.contract_address || '').trim().toLowerCase();
    const txHash = String(row.tx || row.tx_hash || row.transaction_hash || '').trim().toLowerCase();
    const operation = `${row.op || ''} ${row.position_action || ''}`.toLowerCase();
    if (!chain || !EVM_ADDRESS_PATTERN.test(walletAddress) || !EVM_ADDRESS_PATTERN.test(tokenAddress)
      || !/^0x[0-9a-f]{64}$/.test(txHash) || !/(?:buy|open|increase|add)/.test(operation)) return null;
    const tokenMeta = walletMetaEntry(meta?.token, tokenAddress);
    const blockTimestamp = Math.floor(timestamp(row.time ?? row.unix_time ?? row.timestamp, Date.now()) / 1_000);
    const creationTimestamp = Math.floor(timestamp(
      row.token_create_time ?? tokenMeta.creation_timestamp ?? tokenMeta.creationTimestamp,
      0
    ) / 1_000);
    return {
      chain,
      walletAddress,
      tokenAddress,
      txHash,
      operation: 'buy',
      tokenSymbol: String(row.token_symbol || row.symbol || tokenMeta.symbol || '').slice(0, 80),
      tokenName: String(row.token_name || row.name || tokenMeta.name || row.token_symbol || tokenMeta.symbol || '').slice(0, 160),
      rawTokenAmount: String(row.raw_token_amount || '').slice(0, 120),
      tokenAmount: String(row.amount ?? row.token_amount ?? '').slice(0, 120),
      tokenDecimals: Number(row.decimal ?? row.decimals ?? tokenMeta.decimals ?? 18),
      blockNumber: Number(row.block ?? row.block_number ?? 0),
      blockTimestamp,
      logIndex: Number(row.log_index ?? row.logIndex ?? 0),
      marketCapUsd: Number.isFinite(Number(row.mc)) ? Number(row.mc) : null,
      tokenCreationTimestamp: creationTimestamp > 0 ? creationTimestamp : null,
      source: 'debot-wallet-track-rest',
      discoveredAt: Date.now()
    };
  }

  function rememberWalletActivity(event) {
    const key = `${event.chain}:${event.txHash}:${event.walletAddress}:${event.tokenAddress}`;
    if (walletActivitySeen.has(key)) return false;
    walletActivitySeen.add(key);
    while (walletActivitySeen.size > WALLET_ACTIVITY_SEEN_LIMIT) {
      walletActivitySeen.delete(walletActivitySeen.values().next().value);
    }
    return true;
  }

  function pollWalletActivity() {
    if (walletActivityInFlight) return walletActivityInFlight;
    const operation = api('wallet/track/transactions', {
      timeoutMs: WALLET_ACTIVITY_API_TIMEOUT_MS
    }).then((payload) => {
      const rows = Array.isArray(payload?.transactions) ? payload.transactions.slice(0, 200) : [];
      incrementDiagnosticCounter(bridgeDiagnostics.wallet, 'frames');
      incrementDiagnosticCounter(bridgeDiagnostics.wallet, 'rows', rows.length);
      const events = [];
      for (const row of rows) {
        const event = normalizedWalletActivity(row, payload?.meta || {});
        if (!event) {
          incrementDiagnosticCounter(bridgeDiagnostics.wallet, 'rejected');
          continue;
        }
        if (!rememberWalletActivity(event) || !walletActivityBootstrapped) continue;
        events.push(event);
      }
      walletActivityBootstrapped = true;
      if (events.length) {
        incrementDiagnosticCounter(bridgeDiagnostics.wallet, 'accepted', events.length);
        bridgeDiagnostics.wallet.lastEventAt = Date.now();
        emit('wallet-events', { events });
      }
      if (events.length) emitHealthyHeartbeat();
      return { ok: true, events: events.length };
    }).catch((error) => ({ ok: false, errorType: coarseErrorType(error) })).finally(() => {
      if (walletActivityInFlight === operation) walletActivityInFlight = null;
    });
    walletActivityInFlight = operation;
    return operation;
  }

  function isSocialTwitterChannel(value) {
    const channel = socketChannelKey(value);
    return /^social(?:-[a-z0-9]+){0,6}-twitter(?:-|$)/.test(channel)
      || /^social-twitter(?:-|$)/.test(channel);
  }

  function isPersonalTwitterChannel(value) {
    const channel = socketChannelKey(value);
    return /^(?:social-(?:user|personal|my|watchlist|subscribed|monitor|monitored)-twitter|social-twitter-(?:user|personal|my|watchlist|subscribed|monitor|monitored))(?:-|$)/.test(channel);
  }

  function channelFromSocketObject(value) {
    if (!value || typeof value !== 'object' || Array.isArray(value)) return '';
    for (const key of ['channel', 'topic', 'event', 'name']) {
      if (typeof value[key] === 'string' && isSocialTwitterChannel(value[key])) return value[key];
    }
    return '';
  }

  function parseSocketPacket(frame) {
    const arrayStart = frame.indexOf('[');
    const objectStart = frame.indexOf('{');
    const jsonStart = arrayStart < 0
      ? objectStart
      : objectStart < 0
        ? arrayStart
        : Math.min(arrayStart, objectStart);
    if (jsonStart < 0) return { error: 'invalidPacket' };

    let packet;
    try {
      packet = JSON.parse(frame.slice(jsonStart));
    } catch {
      return { error: 'invalidPacket' };
    }
    if (Array.isArray(packet)) {
      for (let index = 0; index < Math.min(packet.length, 4); index += 1) {
        const value = packet[index];
        if (typeof value === 'string' && isSocialTwitterChannel(value)) {
          return { channel: value, envelope: packet[index + 1] ?? {} };
        }
        const channel = channelFromSocketObject(value);
        if (channel) return { channel, envelope: value };
      }
      return { error: 'unmatchedChannel' };
    }
    const channel = channelFromSocketObject(packet);
    return channel ? { channel, envelope: packet } : { error: 'unmatchedChannel' };
  }

  function isSocketActivityPayload(value) {
    if (!value || typeof value !== 'object' || Array.isArray(value)) return false;
    return ['doc_id', 'tweet', 'event_type', 'eventType', 'tw_type', 'twType', 'profile', 'follow']
      .some((key) => Object.hasOwn(value, key));
  }

  function socketActivityPayloads(value, depth = 0, payloads = []) {
    if (payloads.length >= MAX_SOCKET_PAYLOADS_PER_FRAME || depth > 5 || value === null || value === undefined) {
      return payloads;
    }
    if (typeof value === 'string') {
      const text = value.trim();
      if (!text || !/^[{[]/.test(text)) return payloads;
      try {
        return socketActivityPayloads(JSON.parse(text), depth + 1, payloads);
      } catch {
        return payloads;
      }
    }
    if (Array.isArray(value)) {
      for (const item of value.slice(0, MAX_SOCKET_PAYLOADS_PER_FRAME)) {
        socketActivityPayloads(item, depth + 1, payloads);
      }
      return payloads;
    }
    if (typeof value !== 'object') return payloads;
    if (isSocketActivityPayload(value)) {
      payloads.push(value);
      return payloads;
    }
    for (const key of ['Payload', 'payload', 'data', 'Data', 'message', 'body', 'result', 'items', 'events', 'feeds', 'records']) {
      if (!Object.hasOwn(value, key)) continue;
      socketActivityPayloads(value[key], depth + 1, payloads);
      if (payloads.length >= MAX_SOCKET_PAYLOADS_PER_FRAME) break;
    }
    return payloads;
  }

  function decodedSocketPayload(value) {
    if (typeof value !== 'string') return value;
    const text = value.trim();
    if (!text || !/^[{[]/.test(text)) return null;
    try {
      return JSON.parse(text);
    } catch {
      return null;
    }
  }

  function personalSocketEnvelopePayloads(envelope) {
    if (!envelope || typeof envelope !== 'object' || Array.isArray(envelope)) {
      return { payloads: socketActivityPayloads(envelope) };
    }

    if (Object.hasOwn(envelope, 'Channel')) {
      const payloadChannel = String(envelope.Channel || '').trim();
      if (!PERSONAL_TWITTER_PAYLOAD_CHANNELS.has(payloadChannel)) {
        return { error: 'unmatchedChannel', payloads: [] };
      }
    }

    const payloadKey = Object.hasOwn(envelope, 'Payload')
      ? 'Payload'
      : Object.hasOwn(envelope, 'payload')
        ? 'payload'
        : '';
    if (!payloadKey) return { payloads: socketActivityPayloads(envelope) };

    const decoded = decodedSocketPayload(envelope[payloadKey]);
    if (!decoded || typeof decoded !== 'object') {
      return { error: 'invalidEnvelope', payloads: [] };
    }

    const transportEvent = String(decoded.event_type || decoded.eventType || '').trim();
    const isTransportWrapper = isSocialTwitterChannel(transportEvent);
    if (isTransportWrapper && !isPersonalTwitterChannel(transportEvent)) {
      return { error: 'unmatchedChannel', payloads: [] };
    }
    // DeBot's official handler always consumes JSON.parse(Payload).data for
    // these two personal channels. The transport event name is not stable
    // enough to decide whether the wrapper must be unwrapped.
    const activityRoot = Object.hasOwn(decoded, 'data') ? decoded.data : decoded;
    return { payloads: socketActivityPayloads(activityRoot) };
  }

  function isCachedTwitterAuthor(post) {
    if (post?.source !== 'twitter') return false;
    const author = handleText(post?.author?.handle).toLowerCase();
    if (!author || !cachedAccounts.length) return false;
    return cachedAccounts.some((account) => (
      account?.platform === 'twitter'
        && handleText(account.accountKey || account.handle).toLowerCase() === author
    ));
  }

  function observeSocketText(frame) {
    if (typeof frame !== 'string') {
      rejectSocketFrame('unreadable');
      return;
    }
    const arrayStart = frame.indexOf('[');
    if (arrayStart >= 0) {
      try {
        const packet = JSON.parse(frame.slice(arrayStart));
        const walletRoots = [];
        const findWalletRoots = (value, depth = 0) => {
          if (depth > 6 || value === null || value === undefined || walletRoots.length >= 20) return;
          if (typeof value === 'string') {
            const text = value.trim();
            if (/^[\[{]/.test(text)) {
              try { findWalletRoots(JSON.parse(text), depth + 1); } catch { /* ignore */ }
            }
            return;
          }
          if (Array.isArray(value)) {
            for (let index = 0; index < value.length; index += 1) {
              const item = value[index];
              if (typeof item === 'string' && ['wallet-track', 'wallet-position-track'].includes(item.toLowerCase())) {
                walletRoots.push(value.slice(index + 1));
              }
              findWalletRoots(item, depth + 1);
            }
            return;
          }
          if (typeof value === 'object') {
            for (const item of Object.values(value)) findWalletRoots(item, depth + 1);
          }
        };
        findWalletRoots(packet);
        if (walletRoots.length) {
          incrementDiagnosticCounter(bridgeDiagnostics.wallet, 'frames');
          const walletRows = (value, depth = 0, rows = []) => {
            if (depth > 5 || rows.length >= 100 || value === null || value === undefined) return rows;
            if (Array.isArray(value)) {
              for (const item of value) walletRows(item, depth + 1, rows);
              return rows;
            }
            if (typeof value !== 'object') return rows;
            const candidate = value.data && typeof value.data === 'object' && !Array.isArray(value.data)
              ? value.data
              : value;
            const hasWallet = candidate.wallet || candidate.wallet_address || candidate.address;
            const hasToken = candidate.token || candidate.token_address || candidate.contract_address;
            if (hasWallet && hasToken) {
              rows.push(candidate);
              return rows;
            }
            for (const key of ['data', 'payload', 'result', 'items', 'events', 'rows', 'list']) {
              if (Object.hasOwn(value, key)) walletRows(value[key], depth + 1, rows);
            }
            return rows;
          };
          const rows = walletRoots.flatMap((root) => root.flatMap((item) => walletRows(item)));
          incrementDiagnosticCounter(bridgeDiagnostics.wallet, 'rows', rows.length);
          const events = [];
          for (const row of rows.slice(0, 100)) {
            const data = row;
            const chainValue = String(data?.chain || data?.chain_name || data?.network || '').toLowerCase();
            const chain = ['bsc', 'bnb', 'bnbchain', '56'].includes(chainValue)
              ? 'bsc'
              : ['base', '8453', 'base-mainnet'].includes(chainValue)
                ? 'base'
                : ['robinhood', 'robinhood-chain', 'rh'].includes(chainValue)
                  ? 'robinhood'
                  : '';
            const walletAddress = String(data?.wallet || data?.wallet_address || data?.address || '').toLowerCase();
            const tokenAddress = String(
              data?.token?.address || data?.token_address || data?.token || data?.contract_address || ''
            ).toLowerCase();
            const txHash = String(data?.tx_hash || data?.transaction_hash || data?.txHash || '').toLowerCase();
            const operation = String(data?.op || data?.operation || data?.position_action || '').toLowerCase();
            if (!chain || !/^0x[0-9a-f]{40}$/.test(walletAddress)
              || !/^0x[0-9a-f]{40}$/.test(tokenAddress) || !/^0x[0-9a-f]{64}$/.test(txHash)
              || !/(?:buy|open|increase|add)/.test(operation)) {
              incrementDiagnosticCounter(bridgeDiagnostics.wallet, 'rejected');
              continue;
            }
            events.push({
              chain,
              walletAddress,
              tokenAddress,
              txHash,
              operation: 'buy',
              tokenSymbol: String(data?.token_symbol || data?.symbol || data?.token?.symbol || '').slice(0, 80),
              tokenName: String(data?.token_name || data?.name || data?.token?.name || '').slice(0, 160),
              rawTokenAmount: String(data?.raw_token_amount || data?.token_amount_raw || '').slice(0, 120),
              tokenAmount: String(data?.token_amount || data?.amount || '').slice(0, 120),
              tokenDecimals: Number(data?.decimal ?? data?.decimals ?? data?.token?.decimals ?? 18),
              blockNumber: Number(data?.block_number || data?.blockNumber || 0),
              blockTimestamp: Number(data?.unix_time || data?.timestamp || 0),
              logIndex: Number(data?.log_index || data?.logIndex || 0),
              source: 'debot-wallet-track',
              discoveredAt: Date.now()
            });
          }
          if (events.length) {
            incrementDiagnosticCounter(bridgeDiagnostics.wallet, 'accepted', events.length);
            bridgeDiagnostics.wallet.lastEventAt = Date.now();
            emit('wallet-events', { events });
            emitHealthyHeartbeat();
          }
          return;
        }
      } catch {
        // Non-wallet frames continue through the existing social parser.
      }
    }
    const parsed = parseSocketPacket(frame);
    if (!parsed.channel) {
      rejectSocketFrame(parsed.error || 'invalidPacket');
      return;
    }
    if (!isPersonalTwitterChannel(parsed.channel)) {
      rejectSocketFrame('unmatchedChannel');
      return;
    }

    const extracted = personalSocketEnvelopePayloads(parsed.envelope);
    if (extracted.error) {
      rejectSocketFrame(extracted.error);
      return;
    }
    const { payloads } = extracted;
    if (!payloads.length) {
      rejectSocketFrame('invalidEnvelope');
      return;
    }
    const accepted = [];
    for (const payload of payloads) {
      const post = normalizePost(payload, 'my');
      if (!post) {
        rejectSocketFrame('invalidEvent');
        continue;
      }
      if (!isCachedTwitterAuthor(post)) {
        rejectSocketFrame('unmonitoredAuthor');
        continue;
      }
      accepted.push(post);
    }
    if (!accepted.length) return;
    incrementDiagnosticCounter(bridgeDiagnostics.ws, 'accepted', accepted.length);
    bridgeDiagnostics.ws.lastEventAt = Date.now();
    deliverPosts(accepted);
  }

  async function socketFrameText(frame) {
    const tag = Object.prototype.toString.call(frame);
    const isBlob = (typeof Blob === 'function' && frame instanceof Blob) || tag === '[object Blob]';
    if (isBlob && typeof frame?.text === 'function') return frame.text();

    const isArrayBuffer = (typeof ArrayBuffer === 'function' && frame instanceof ArrayBuffer)
      || tag === '[object ArrayBuffer]';
    const isView = typeof ArrayBuffer === 'function'
      && typeof ArrayBuffer.isView === 'function'
      && ArrayBuffer.isView(frame);
    if (!isArrayBuffer && !isView) return '';
    if (typeof TextDecoder !== 'function') return '';
    const bytes = isArrayBuffer
      ? new Uint8Array(frame)
      : new Uint8Array(frame.buffer, frame.byteOffset, frame.byteLength);
    return new TextDecoder().decode(bytes);
  }

  function observeSocketFrame(frame) {
    incrementDiagnosticCounter(bridgeDiagnostics.ws, 'framesSeen');
    if (typeof frame === 'string') {
      observeSocketText(frame);
      return;
    }
    void socketFrameText(frame).then((text) => {
      if (!text) rejectSocketFrame('unreadable');
      else observeSocketText(text);
    }).catch(() => rejectSocketFrame('unreadable'));
  }

  function observeSharedWorkerMessage(message) {
    if (!message || typeof message !== 'object' || Array.isArray(message)) return;
    if (message.type !== 'socket-event') return;
    const event = String(message.event || '').trim().toLowerCase();
    const args = Array.isArray(message.args) ? message.args : [];
    let walletPayloads = args;
    if (event === 'wallet-history-update') {
      walletPayloads = args.flatMap((root) => {
        if (!root || typeof root !== 'object' || !Array.isArray(root.txs)) return [];
        return root.txs.map((transaction) => ({
          data: {
            chain: root.chain,
            wallet: root.wallet || transaction?.trader,
            token: root.token,
            tx_hash: transaction?.tx,
            op: transaction?.op,
            token_symbol: root.token_symbol || root.symbol,
            token_name: root.token_name || root.name,
            token_amount: transaction?.amount,
            decimal: root.decimal ?? root.decimals,
            block_number: transaction?.block,
            unix_time: transaction?.unixTime ?? transaction?.time,
            log_index: transaction?.log_index ?? transaction?.logIndex
          }
        }));
      });
    } else if (!['wallet-track', 'wallet-position-track'].includes(event)) {
      return;
    }
    try {
      observeSocketText(JSON.stringify(['wallet-track', ...walletPayloads]));
    } catch {
      rejectSocketFrame('invalidPacket');
    }
  }

  function wrapSharedWorkerPort(port) {
    if (!port || typeof port !== 'object') return port;
    const wrapHandler = (handler) => typeof handler === 'function'
      ? (event) => {
          observeSharedWorkerMessage(event?.data);
          return handler.call(port, event);
        }
      : handler;
    return new Proxy(port, {
      get(target, property, receiver) {
        if (property === 'addEventListener') {
          return (type, listener, options) => target.addEventListener(
            type,
            type === 'message' ? wrapHandler(listener) : listener,
            options
          );
        }
        const value = Reflect.get(target, property, target);
        return typeof value === 'function' ? value.bind(target) : value;
      },
      set(target, property, value) {
        if (property === 'onmessage') return Reflect.set(target, property, wrapHandler(value), target);
        return Reflect.set(target, property, value, target);
      }
    });
  }

  function isDeBotPortalSocket(socket, constructorArgs) {
    const address = String(socket?.url || constructorArgs?.[0] || '').trim();
    if (!address) return false;
    try {
      const url = new URL(address, window.location.origin);
      const hostname = url.hostname.toLowerCase();
      return hostname === 'debot.ai'
        && (url.pathname === '/portal-ws' || url.pathname === '/portal-ws/');
    } catch {
      return false;
    }
  }

  function isPortalAuthorizationSuccess(frame) {
    if (typeof frame !== 'string') return false;
    const text = frame.trim();
    if (!text.startsWith('42')) return false;
    const arrayStart = text.indexOf('[');
    if (arrayStart < 0) return false;
    try {
      const packet = JSON.parse(text.slice(arrayStart));
      return Array.isArray(packet)
        && packet[0] === 'authorization'
        && packet[1] === 'success';
    } catch {
      return false;
    }
  }

  function subscribePortalTwitter(socket, frame) {
    if (!isPortalAuthorizationSuccess(frame)) return;
    incrementDiagnosticCounter(bridgeDiagnostics.ws, 'authorizationSuccesses');
    if (!portalAuthorizedSockets.has(socket)) {
      portalAuthorizedSockets.add(socket);
      portalAuthorizedSocketCount += 1;
      resetTransientPrimaryFailures();
    }
    if (portalSubscribedSockets.has(socket) || typeof socket?.send !== 'function') return;
    try {
      // DeBot's own social module sends this exact Socket.IO event after a
      // successful authorization. No session material is inspected or copied.
      incrementDiagnosticCounter(bridgeDiagnostics.ws, 'subscribeAttempts');
      bridgeDiagnostics.ws.lastSubscribeAt = Date.now();
      socket.send('42["subscribe","social-user-twitter"]');
      portalSubscribedSockets.add(socket);
    } catch {
      incrementDiagnosticCounter(bridgeDiagnostics.ws, 'subscribeFailures');
      // A normal one-second REST poll remains available if a socket closes here.
    }
  }

  function forgetPortalSocket(socket) {
    portalSubscribedSockets.delete(socket);
    if (!portalAuthorizedSockets.delete(socket)) return;
    portalAuthorizedSocketCount = Math.max(0, portalAuthorizedSocketCount - 1);
  }

  const NativeWebSocket = window.WebSocket;
  if (typeof NativeWebSocket === 'function') {
    window.WebSocket = new Proxy(NativeWebSocket, {
      construct(target, args) {
        const socket = Reflect.construct(target, args);
        const portalSocket = isDeBotPortalSocket(socket, args);
        if (portalSocket) {
          socket.addEventListener('open', () => {
            incrementDiagnosticCounter(bridgeDiagnostics.ws, 'connectionOpens');
          });
          socket.addEventListener('close', () => forgetPortalSocket(socket));
          socket.addEventListener('error', () => forgetPortalSocket(socket));
        }
        socket.addEventListener('message', (event) => {
          if (portalSocket) subscribePortalTwitter(socket, event.data);
          observeSocketFrame(event.data);
        });
        return socket;
      }
    });
  }

  const NativeSharedWorker = window.SharedWorker;
  if (typeof NativeSharedWorker === 'function') {
    window.SharedWorker = new Proxy(NativeSharedWorker, {
      construct(target, args) {
        const worker = Reflect.construct(target, args);
        const port = wrapSharedWorkerPort(worker?.port);
        return new Proxy(worker, {
          get(instance, property, receiver) {
            if (property === 'port') return port;
            const value = Reflect.get(instance, property, instance);
            return typeof value === 'function' ? value.bind(instance) : value;
          },
          set(instance, property, value) {
            return Reflect.set(instance, property, value, instance);
          }
        });
      }
    });
  }

  const requestRecoveryPoll = () => {
    if (Date.now() - lastPrimarySuccessAt > PRIMARY_POLL_INTERVAL_MS * 3) requestTimelineCatchUp();
    requestPrimaryFollowUp();
  };
  window.addEventListener('online', requestRecoveryPoll);
  window.addEventListener('pageshow', requestRecoveryPoll);
  window.addEventListener('focus', requestRecoveryPoll);
  if (typeof document !== 'undefined' && typeof document.addEventListener === 'function') {
    document.addEventListener('visibilitychange', () => {
      if (document.visibilityState === 'visible') requestRecoveryPoll();
    });
  }

  window.addEventListener('message', (event) => {
    if (event.source !== window || event.origin !== window.location.origin) return;
    const message = event.data;
    if (!message || message.source !== RELAY_SOURCE) return;
    if (message.type === 'force-poll') {
      const requestId = typeof message.requestId === 'string' ? message.requestId : '';
      if (!requestId.trim()) return;
      const startedAt = Date.now();
      void fallbackPoll().then((result) => {
        completeForcePollDiagnostics(result, startedAt);
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
      if (deliveryId && message.payload?.ok === true && message.payload?.durable === true) {
        acknowledgeDelivery(deliveryId);
      }
      else if (deliveryId) retryDelivery(deliveryId);
      return;
    }
    if (message.type === 'analysis-job') {
      enqueueAnalysisJob(message.job);
      return;
    }
    if (message.type !== 'command') return;
    const operation = commandQueue.then(() => executeCommand(message.command));
    commandQueue = operation.catch(() => {});
    void operation.then((result) => {
      emit('command-result', {
        commandId: message.command.id,
        success: true,
        remoteId: result.remoteId || '',
        verifiedAbsent: result.verifiedAbsent === true
      });
    }).catch((error) => {
      emit('command-result', {
        commandId: message.command.id,
        success: false,
        error: error instanceof Error ? error.message : String(error)
      });
    });
  });

  void fallbackPoll();
  void refreshWatchlistIfNeeded();
  void refreshWalletLibrary().catch(() => {});
  void pollWalletActivity();
  setInterval(() => requestPrimaryFollowUp(), PRIMARY_POLL_INTERVAL_MS);
  setInterval(() => void pollWalletActivity(), WALLET_ACTIVITY_POLL_INTERVAL_MS);
  setInterval(() => void refreshWatchlistIfNeeded(), WATCHLIST_POLL_INTERVAL_MS);
  setInterval(() => void refreshWalletLibrary().catch(() => {}), WALLET_LIBRARY_POLL_INTERVAL_MS);
})();
