(() => {
  const PAGE_SOURCE = 'debot-social-page';
  const RELAY_SOURCE = 'debot-social-relay';
  const BRIDGE_VERSION = '1.7.0';
  const DEFAULT_TYPES = 'tweet|reply|retweet|quote|delTweet|reName|reImage|reDescription|follow|unfollow';
  const SOCIAL_EVENT_KINDS = new Set(['post', 'reply', 'repost', 'quote', 'delete', 'follow', 'unfollow', 'profile']);
  // The WebSocket is the primary lane. This short, coalesced REST poll only
  // covers frames DeBot does not expose or cannot be decoded in the page.
  const PRIMARY_POLL_INTERVAL_MS = 1_000;
  const PRIMARY_API_TIMEOUT_MS = 1_500;
  const TIMELINE_PAGE_SIZE = 50;
  const TIMELINE_CATCHUP_PAGES_PER_POLL = 3;
  const TIMELINE_CATCHUP_MAX_PAGES = 100;
  const TIMELINE_CATCHUP_MAX_POSTS = TIMELINE_PAGE_SIZE * TIMELINE_CATCHUP_MAX_PAGES;
  const WATCHLIST_POLL_INTERVAL_MS = 30_000;
  const API_TIMEOUT_MS = 20_000;
  const DELIVERY_TIMEOUT_MS = 2_000;
  const DELIVERY_RETRY_BASE_MS = 2_000;
  const DELIVERY_RETRY_MAX_MS = 30_000;
  const PAGE_PENDING_MAX_POSTS = 100;
  const PAGE_PENDING_MAX_BYTES = 2 * 1024 * 1024;
  const ERROR_TYPES = new Set(['AUTH', 'TIMEOUT', 'NETWORK', 'DEBOT']);
  const ANALYSIS_JOB_TYPES = new Set(['debot.token_detail.v1', 'debot.wallet_token_analysis.v1']);
  const ANALYSIS_CONCURRENCY = 4;
  const ANALYSIS_QUEUE_LIMIT = 32;
  const MAX_ANALYSIS_RESULT_BYTES = 256 * 1024;
  const WATCHLIST_PAGE_SIZE = 500;
  const WATCHLIST_MAX_PAGES = 10;
  const EVM_ADDRESS_PATTERN = /^0x[0-9a-f]{40}$/;
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
    const { ws, poll, forcePoll } = bridgeDiagnostics;
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
    const items = tweet?.media || tweet?.medias || tweet?.attachments || tweet?.images || [];
    if (!Array.isArray(items)) return [];
    return items.slice(0, 12).map((item) => {
      if (typeof item === 'string') return { type: 'image', url: limitedText(item, 2_000) };
      const url = limitedText(item?.url || item?.media_url_https || item?.media_url || item?.src || '', 2_000);
      const previewUrl = limitedText(item?.preview_url || item?.thumbnail_url || item?.poster || '', 2_000);
      const type = String(item?.type || item?.media_type || 'image').toLowerCase();
      return { type: type === 'video' ? 'video' : type === 'gif' ? 'gif' : 'image', url, previewUrl };
    }).filter((item) => item.url || item.previewUrl);
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
    if (!externalId && !content && !translatedContent && !url) return null;
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
      publishedAt
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
      publishedAt: 0
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
        : Math.max(0, Number(older.publishedAt || 0))
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
      ...(timelineCatchUpTruncated ? ['catchup-truncated'] : [])
    ];
  }

  function emitHealthyHeartbeat() {
    emit('heartbeat', {
      bridgeId: 'debot-browser-extension',
      version: BRIDGE_VERSION,
      sessionId: String(Date.now()),
      capabilities: healthyHeartbeatCapabilities(),
      diagnostics: bridgeDiagnosticsSnapshot()
    });
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
          chain: 'robinhood',
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
        chain: 'robinhood',
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
    const result = { chain: 'robinhood', wallet, token };
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

  function validatedAnalysisPayload(job) {
    if (!ANALYSIS_JOB_TYPES.has(job.type)) throw new AnalysisJobError('INVALID_JOB');
    const chain = String(job.payload.chain || '').trim().toLowerCase();
    const token = normalizeEvmAddress(job.payload.token);
    if (chain !== 'robinhood' || !token) throw new AnalysisJobError('INVALID_JOB');
    if (job.type === 'debot.token_detail.v1') return { chain, token };
    const wallet = normalizeEvmAddress(job.payload.wallet);
    if (!wallet) throw new AnalysisJobError('INVALID_JOB');
    return { chain, token, wallet };
  }

  async function executeAnalysisJob(job) {
    const payload = validatedAnalysisPayload(job);
    const params = new URLSearchParams({ chain: payload.chain, token: payload.token });
    let result;
    if (job.type === 'debot.token_detail.v1') {
      result = sanitizeTokenDetail(await api(`dashboard/token/detail?${params}`), payload);
    } else {
      params.set('wallet', payload.wallet);
      result = sanitizeWalletTokenAnalysis(
        await api(`dex/profit/wallet_token_analysis?${params}`),
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
      completePrimaryPollDiagnostics(firstPage);
      emitHealthyHeartbeat();
      scheduleTimelineCatchUp(configIds, firstPage, firstPageDelivery);
      return { ok: true };
    } catch (error) {
      requestTimelineCatchUp();
      const errorType = coarseErrorType(error);
      failPrimaryPollDiagnostics(errorType);
      emit('heartbeat', {
        bridgeId: 'debot-browser-extension',
        version: BRIDGE_VERSION,
        capabilities: ['debot-analysis-v1', 'error'],
        error: errorType,
        diagnostics: bridgeDiagnosticsSnapshot()
      });
      return { ok: false, errorType };
    }
  }

  function fallbackPoll() {
    if (pollInFlight) return pollInFlight;
    const operation = runPoll().finally(() => {
      if (pollInFlight !== operation) return;
      pollInFlight = null;
      if (primaryFollowUpRequested) {
        primaryFollowUpRequested = false;
        void fallbackPoll();
      }
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

  function socketChannelKey(value) {
    return String(value || '')
      .trim()
      .toLowerCase()
      .replace(/[^a-z0-9]+/g, '-')
      .replace(/^-+|-+$/g, '');
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
        }
        socket.addEventListener('message', (event) => {
          if (portalSocket) subscribePortalTwitter(socket, event.data);
          observeSocketFrame(event.data);
        });
        return socket;
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
  setInterval(() => requestPrimaryFollowUp(), PRIMARY_POLL_INTERVAL_MS);
  setInterval(() => void refreshWatchlistIfNeeded(), WATCHLIST_POLL_INTERVAL_MS);
})();
