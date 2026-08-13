import fs from 'node:fs';
import path from 'node:path';
import { DatabaseSync } from 'node:sqlite';

import {
  normalizeFeedSources,
  normalizeProfileChanges,
  normalizeSocialPost,
  normalizeSocialSource,
  normalizeTimestamp,
  normalizeWatchEventTypes,
  normalizeWatchAccount,
  parseSocialActivityIdentity,
  SOCIAL_PROFILE_CHANGES,
  SOCIAL_WATCH_EVENT_TYPES
} from './normalize.js';
import { shouldTranslateSocialText } from './deepseekTranslator.js';

function json(value) {
  try {
    return JSON.stringify(value ?? null);
  } catch {
    return 'null';
  }
}

function parseJson(value, fallback) {
  try {
    return value === null || value === undefined || value === '' ? fallback : JSON.parse(value);
  } catch {
    return fallback;
  }
}

function boolean(value) {
  return Boolean(Number(value));
}

// The bridge reports only a compact health summary. Do not expand this into a
// generic telemetry object: heartbeat data originates in a signed-in browser
// tab and must never retain raw DeBot frames, post text, account identifiers,
// or credentials.
const BRIDGE_DIAGNOSTIC_COUNTER_MAX = 1_000_000_000;
const BRIDGE_DIAGNOSTIC_DURATION_MAX_MS = 10 * 60 * 1_000;
const BRIDGE_DIAGNOSTIC_ERROR_CATEGORIES = new Set([
  '', 'AUTH', 'TIMEOUT', 'NETWORK', 'DEBOT', 'UNKNOWN'
]);

function diagnosticCounter(value) {
  const number = Number(value);
  return Number.isSafeInteger(number) && number >= 0 && number <= BRIDGE_DIAGNOSTIC_COUNTER_MAX
    ? number
    : 0;
}

function diagnosticTimestamp(value) {
  const number = Number(value);
  return Number.isSafeInteger(number) && number > 0 ? number : null;
}

function diagnosticDuration(value) {
  if (value === null || value === undefined || value === '') return null;
  const number = Number(value);
  return Number.isSafeInteger(number) && number >= 0 && number <= BRIDGE_DIAGNOSTIC_DURATION_MAX_MS
    ? number
    : null;
}

function diagnosticErrorCategory(value) {
  const category = String(value || '').trim().toUpperCase();
  return BRIDGE_DIAGNOSTIC_ERROR_CATEGORIES.has(category) ? category : '';
}

function bridgeDiagnosticsDefaults() {
  return {
    ws: {
      connectionOpens: 0,
      authorizationSuccesses: 0,
      subscribeAttempts: 0,
      subscribeFailures: 0,
      lastSubscribeAt: null,
      framesSeen: 0,
      accepted: 0,
      rejected: 0,
      unmatchedChannel: 0,
      invalidPacket: 0,
      invalidEnvelope: 0,
      unmonitoredAuthor: 0,
      invalidEvent: 0,
      unreadable: 0,
      lastEventAt: null
    },
    wallet: {
      frames: 0,
      rows: 0,
      accepted: 0,
      rejected: 0,
      lastEventAt: null
    },
    poll: {
      startedAt: null,
      finishedAt: null,
      elapsedMs: null,
      rawRows: 0,
      normalizedRows: 0,
      droppedRows: 0,
      accountCount: 0,
      configHash: '',
      latestSourceAt: null,
      lastErrorCategory: '',
      attempts: 0,
      successes: 0,
      failures: 0
    },
    forcePoll: {
      successes: 0,
      failures: 0,
      lastAt: null,
      elapsedMs: null,
      lastErrorCategory: ''
    }
  };
}

function bridgeDiagnosticsFromInput(value) {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return null;
  const ws = value.ws && typeof value.ws === 'object' && !Array.isArray(value.ws) ? value.ws : {};
  const wallet = value.wallet && typeof value.wallet === 'object' && !Array.isArray(value.wallet)
    ? value.wallet
    : {};
  const poll = value.poll && typeof value.poll === 'object' && !Array.isArray(value.poll) ? value.poll : {};
  const forcePoll = value.forcePoll && typeof value.forcePoll === 'object' && !Array.isArray(value.forcePoll)
    ? value.forcePoll
    : {};
  const defaults = bridgeDiagnosticsDefaults();
  return {
    ws: {
      connectionOpens: diagnosticCounter(ws.connectionOpens),
      authorizationSuccesses: diagnosticCounter(ws.authorizationSuccesses),
      subscribeAttempts: diagnosticCounter(ws.subscribeAttempts),
      subscribeFailures: diagnosticCounter(ws.subscribeFailures),
      lastSubscribeAt: diagnosticTimestamp(ws.lastSubscribeAt),
      framesSeen: diagnosticCounter(ws.framesSeen),
      accepted: diagnosticCounter(ws.accepted),
      rejected: diagnosticCounter(ws.rejected),
      unmatchedChannel: diagnosticCounter(ws.unmatchedChannel),
      invalidPacket: diagnosticCounter(ws.invalidPacket),
      invalidEnvelope: diagnosticCounter(ws.invalidEnvelope),
      unmonitoredAuthor: diagnosticCounter(ws.unmonitoredAuthor),
      invalidEvent: diagnosticCounter(ws.invalidEvent),
      unreadable: diagnosticCounter(ws.unreadable),
      lastEventAt: diagnosticTimestamp(ws.lastEventAt)
    },
    wallet: {
      frames: diagnosticCounter(wallet.frames),
      rows: diagnosticCounter(wallet.rows),
      accepted: diagnosticCounter(wallet.accepted),
      rejected: diagnosticCounter(wallet.rejected),
      lastEventAt: diagnosticTimestamp(wallet.lastEventAt)
    },
    poll: {
      startedAt: diagnosticTimestamp(poll.startedAt),
      finishedAt: diagnosticTimestamp(poll.finishedAt),
      elapsedMs: diagnosticDuration(poll.elapsedMs),
      rawRows: diagnosticCounter(poll.rawRows),
      normalizedRows: diagnosticCounter(poll.normalizedRows),
      droppedRows: diagnosticCounter(poll.droppedRows),
      accountCount: diagnosticCounter(poll.accountCount),
      configHash: /^[a-f0-9]{8}$/i.test(String(poll.configHash || ''))
        ? String(poll.configHash).toLowerCase()
        : defaults.poll.configHash,
      latestSourceAt: diagnosticTimestamp(poll.latestSourceAt),
      lastErrorCategory: diagnosticErrorCategory(poll.lastErrorCategory),
      attempts: diagnosticCounter(poll.attempts),
      successes: diagnosticCounter(poll.successes),
      failures: diagnosticCounter(poll.failures)
    },
    forcePoll: {
      successes: diagnosticCounter(forcePoll.successes),
      failures: diagnosticCounter(forcePoll.failures),
      lastAt: diagnosticTimestamp(forcePoll.lastAt),
      elapsedMs: diagnosticDuration(forcePoll.elapsedMs),
      lastErrorCategory: diagnosticErrorCategory(forcePoll.lastErrorCategory)
    }
  };
}

function normalizeWatchlistSnapshotVersion(value) {
  const input = value && typeof value === 'object' ? value : {};
  const sessionId = String(input.snapshotSessionId ?? '').trim().slice(0, 240);
  const startedRaw = input.snapshotSessionStartedAt;
  const revisionRaw = input.snapshotRevision;
  const hasAnyVersion = Boolean(sessionId)
    || (startedRaw !== null && startedRaw !== undefined && startedRaw !== '')
    || (revisionRaw !== null && revisionRaw !== undefined && revisionRaw !== '');
  if (!hasAnyVersion) return null;
  const sessionStartedAt = Number(startedRaw);
  const revision = Number(revisionRaw);
  if (!sessionId
    || !Number.isSafeInteger(sessionStartedAt) || sessionStartedAt <= 0
    || !Number.isSafeInteger(revision) || revision <= 0) {
    throw new TypeError('Invalid watchlist snapshot version');
  }
  return { sessionId, sessionStartedAt, revision };
}

function watchEventTypesFromJson(value) {
  try {
    return normalizeWatchEventTypes(parseJson(value, SOCIAL_WATCH_EVENT_TYPES));
  } catch {
    return [...SOCIAL_WATCH_EVENT_TYPES];
  }
}

const SOCIAL_WATCH_NOTE_MAX_CODE_POINTS = 500;

function normalizeWatchNote(value) {
  if (typeof value !== 'string') throw new TypeError('note must be a string');
  const normalized = value.trim();
  if ([...normalized].length > SOCIAL_WATCH_NOTE_MAX_CODE_POINTS) {
    throw new RangeError(`note must not exceed ${SOCIAL_WATCH_NOTE_MAX_CODE_POINTS} characters`);
  }
  return normalized;
}

function normalizeWatchAccountPatch(value) {
  if (!value || typeof value !== 'object' || Array.isArray(value)) {
    throw new TypeError('Watchlist patch must be an object');
  }
  const supported = new Set(['eventTypes', 'note', 'caBark']);
  const keys = Object.keys(value);
  const unknown = keys.find((key) => !supported.has(key));
  if (unknown) throw new TypeError(`Unsupported watchlist patch field: ${unknown}`);
  const eventTypesProvided = Object.hasOwn(value, 'eventTypes');
  const noteProvided = Object.hasOwn(value, 'note');
  const caBarkProvided = Object.hasOwn(value, 'caBark');
  if (caBarkProvided && typeof value.caBark !== 'boolean') throw new TypeError('caBark must be a boolean');
  if (!eventTypesProvided && !noteProvided && !caBarkProvided) {
    throw new TypeError('Watchlist patch must include eventTypes, note or caBark');
  }
  return {
    eventTypesProvided,
    eventTypes: eventTypesProvided ? normalizeWatchEventTypes(value.eventTypes) : null,
    noteProvided,
    note: noteProvided ? normalizeWatchNote(value.note) : null,
    caBarkProvided,
    caBark: caBarkProvided ? value.caBark : null
  };
}

function profileFromJson(value) {
  const profile = parseJson(value, {});
  let changes = [];
  try {
    changes = normalizeProfileChanges(profile?.changes || []);
  } catch {
    changes = [];
  }
  const sourceDetail = profile?.detail && typeof profile.detail === 'object' && !Array.isArray(profile.detail)
    ? profile.detail
    : {};
  const detail = {};
  for (const change of changes) {
    const item = sourceDetail[change] && typeof sourceDetail[change] === 'object'
      ? sourceDetail[change]
      : {};
    detail[change] = {
      before: String(item.before || ''),
      after: String(item.after || '')
    };
  }
  return { changes, detail };
}

function hideUnneededContextTranslation(value) {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return value;
  if (!Object.hasOwn(value, 'translatedContent')) return value;
  if (shouldTranslateSocialText(value.content)) return value;
  return { ...value, translatedContent: '' };
}

function hideUnneededPostTranslations(post) {
  if (!post || typeof post !== 'object' || Array.isArray(post)) return post;
  return {
    ...post,
    translatedContent: shouldTranslateSocialText(post.content) ? post.translatedContent : '',
    replyContext: hideUnneededContextTranslation(post.replyContext),
    quoteContext: hideUnneededContextTranslation(post.quoteContext)
  };
}

function postFromRow(row, { hideUnneededTranslations = true } = {}) {
  if (!row) return null;
  const debotDiscoveredAt = Number(row.discovered_at || row.received_at);
  const vpsIngestedAt = Number(row.ingested_at || row.stored_at);
  const profile = profileFromJson(row.profile_json);
  const post = {
    id: Number(row.id),
    source: row.source,
    externalId: row.external_id,
    kind: row.kind,
    author: {
      id: row.author_id,
      handle: row.author_handle,
      name: row.author_name,
      avatarUrl: row.author_avatar_url,
      followers: Number(row.author_followers || 0)
    },
    content: row.content,
    translatedContent: row.translated_content,
    url: row.url,
    media: parseJson(row.media_json, []),
    contractAddresses: parseJson(row.contract_addresses_json, []),
    chainTags: parseJson(row.chain_tags_json, []),
    feedSources: normalizeFeedSources(parseJson(row.feed_sources_json, [])),
    replyToExternalId: row.reply_to_external_id,
    quotedExternalId: row.quoted_external_id,
    repostExternalId: row.repost_external_id,
    target: parseJson(row.target_json, {}),
    replyContext: parseJson(row.reply_context_json, {}),
    quoteContext: parseJson(row.quote_context_json, {}),
    profileChanges: profile.changes,
    profileDetail: profile.detail,
    publishedAt: Number(row.published_at),
    debotDiscoveredAt,
    vpsIngestedAt,
    discoveredAt: debotDiscoveredAt,
    ingestedAt: vpsIngestedAt,
    receivedAt: Number(row.received_at),
    sourceUpdatedAt: Number(row.source_updated_at),
    deleted: row.deleted_at !== null,
    deletedAt: row.deleted_at === null ? null : Number(row.deleted_at),
    raw: row.source === 'fomo' ? parseJson(row.raw_json, {}) : undefined,
    storedAt: Number(row.stored_at),
    updatedAt: Number(row.updated_at)
  };
  return hideUnneededTranslations ? hideUnneededPostTranslations(post) : post;
}

function watchlistFromRow(row) {
  if (!row) return null;
  return {
    id: Number(row.id),
    platform: row.platform,
    accountKey: row.account_key,
    handle: row.handle,
    name: row.name,
    url: row.url,
    remoteId: row.remote_id,
    metadata: parseJson(row.metadata_json, {}),
    eventTypes: watchEventTypesFromJson(row.event_types_json),
    note: row.local_note,
    caBark: Boolean(row.ca_bark_enabled),
    desiredState: row.desired_state,
    syncStatus: row.sync_status,
    origin: row.origin,
    lastSyncedAt: row.last_synced_at === null ? null : Number(row.last_synced_at),
    lastError: row.last_error,
    createdAt: Number(row.created_at),
    updatedAt: Number(row.updated_at)
  };
}

function commandFromRow(row) {
  if (!row) return null;
  return {
    id: Number(row.id),
    type: row.command_type,
    watchlistId: row.watchlist_id === null ? null : Number(row.watchlist_id),
    payload: parseJson(row.payload_json, {}),
    status: row.status,
    attempts: Number(row.attempts),
    createdAt: Number(row.created_at),
    claimedAt: row.claimed_at === null ? null : Number(row.claimed_at),
    completedAt: row.completed_at === null ? null : Number(row.completed_at),
    lastError: row.last_error
  };
}

function deBotWalletSyncFromRow(row) {
  if (!row) return null;
  return {
    address: row.address,
    note: row.note,
    desiredState: row.desired_state,
    syncStatus: row.sync_status,
    lastSyncedAt: row.last_synced_at,
    lastError: row.last_error,
    updatedAt: row.updated_at
  };
}

function debotJobFromRow(row) {
  if (!row) return null;
  return {
    id: Number(row.id),
    requestKey: row.request_key,
    type: row.job_type,
    payload: parseJson(row.payload_json, {}),
    status: row.status,
    attempts: Number(row.attempts || 0),
    claimToken: row.claim_token,
    result: parseJson(row.result_json, null),
    errorCode: row.error_code,
    errorMessage: row.error_message,
    createdAt: Number(row.created_at),
    updatedAt: Number(row.updated_at),
    deadlineAt: Number(row.deadline_at),
    claimedAt: row.claimed_at === null ? null : Number(row.claimed_at),
    leaseExpiresAt: row.lease_expires_at === null ? null : Number(row.lease_expires_at),
    completedAt: row.completed_at === null ? null : Number(row.completed_at),
    cacheExpiresAt: row.cache_expires_at === null ? null : Number(row.cache_expires_at)
  };
}

function changeFromRow(row) {
  if (!row) return null;
  const data = parseJson(row.payload_json, {});
  return {
    id: Number(row.id),
    type: row.event_type,
    entityType: row.entity_type,
    entityId: row.entity_id,
    data: row.entity_type === 'post' ? hideUnneededPostTranslations(data) : data,
    createdAt: Number(row.created_at)
  };
}

function transaction(db, operation) {
  db.exec('BEGIN IMMEDIATE');
  try {
    const result = operation();
    db.exec('COMMIT');
    return result;
  } catch (error) {
    db.exec('ROLLBACK');
    throw error;
  }
}

function activityTargetFromRows(rows, activity) {
  const targets = rows.map((row) => parseJson(row.target_json, {}));
  const stringValue = (name) => {
    for (const target of targets) {
      const value = String(target?.[name] || '').trim();
      if (value) return value;
    }
    return '';
  };
  const storedHandle = stringValue('handle');
  const handle = storedHandle.toLowerCase() === activity.targetHandle.toLowerCase()
    ? storedHandle
    : activity.targetHandle;
  return {
    id: stringValue('id'),
    handle,
    name: stringValue('name'),
    avatarUrl: stringValue('avatarUrl'),
    followers: Math.max(0, ...targets.map((target) => Number(target?.followers || 0)).filter(Number.isFinite)),
    url: stringValue('url') || `https://x.com/${encodeURIComponent(handle)}`
  };
}

function activityAuthorFromRows(rows, fallbackHandle = '') {
  const stringValue = (name) => {
    for (const row of rows) {
      const value = String(row?.[name] || '').trim();
      if (value) return value;
    }
    return '';
  };
  const storedHandle = stringValue('author_handle');
  const canonicalHandle = String(fallbackHandle || '').trim();
  const handle = canonicalHandle && storedHandle.toLowerCase() !== canonicalHandle.toLowerCase()
    ? canonicalHandle
    : storedHandle || canonicalHandle;
  const followers = rows
    .map((row) => Number(row?.author_followers || 0))
    .find((value) => Number.isFinite(value) && value > 0) || 0;
  return {
    id: stringValue('author_id'),
    handle,
    name: stringValue('author_name'),
    avatarUrl: stringValue('author_avatar_url'),
    followers
  };
}

function mergeSocialTarget(current, incoming) {
  const existing = current && typeof current === 'object' ? current : {};
  const next = incoming && typeof incoming === 'object' ? incoming : {};
  const preferText = (name) => String(next[name] || '').trim() || String(existing[name] || '').trim();
  const nextFollowers = Number(next.followers || 0);
  const existingFollowers = Number(existing.followers || 0);
  return {
    id: preferText('id'),
    handle: preferText('handle'),
    name: preferText('name'),
    avatarUrl: preferText('avatarUrl'),
    followers: nextFollowers > 0 ? nextFollowers : Math.max(0, existingFollowers),
    url: preferText('url')
  };
}

function mergeSocialAuthor(current, incoming) {
  const existing = current && typeof current === 'object' ? current : {};
  const next = incoming && typeof incoming === 'object' ? incoming : {};
  const preferText = (name) => String(next[name] || '').trim() || String(existing[name] || '').trim();
  const nextFollowers = Number(next.followers || 0);
  const existingFollowers = Number(existing.followers || 0);
  return {
    id: preferText('id'),
    handle: preferText('handle'),
    name: preferText('name'),
    avatarUrl: preferText('avatarUrl'),
    followers: nextFollowers > 0 ? nextFollowers : Math.max(0, existingFollowers)
  };
}

function mergeSocialMedia(current, incoming) {
  const merged = [];
  for (const item of [...(Array.isArray(incoming) ? incoming : []), ...(Array.isArray(current) ? current : [])]) {
    if (!item || typeof item !== 'object') continue;
    const url = String(item.url || '').trim();
    const previewUrl = String(item.previewUrl || '').trim();
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

function mergeReplyContext(current, incoming, { allowIdentityReplacement = true } = {}) {
  const existing = current && typeof current === 'object' ? current : {};
  const next = incoming && typeof incoming === 'object' ? incoming : {};
  const existingAuthor = existing.author && typeof existing.author === 'object' ? existing.author : {};
  const nextAuthor = next.author && typeof next.author === 'object' ? next.author : {};
  const preferText = (newValue, oldValue) => String(newValue || '').trim() || String(oldValue || '').trim();
  const existingId = String(existing.externalId || '').trim();
  const nextId = String(next.externalId || '').trim();

  // A parent tweet is one entity. Never combine the text or URL from one
  // parent with the identity of another when DeBot later corrects its data.
  if (existingId && nextId && existingId !== nextId) {
    if (!allowIdentityReplacement) return existing;
    return {
      externalId: nextId,
      author: {
        id: String(nextAuthor.id || '').trim(),
        handle: String(nextAuthor.handle || '').trim(),
        name: String(nextAuthor.name || '').trim(),
        avatarUrl: String(nextAuthor.avatarUrl || '').trim()
      },
      content: String(next.content || '').trim(),
      translatedContent: String(next.translatedContent || '').trim(),
      url: String(next.url || '').trim(),
      publishedAt: Math.max(0, Number(next.publishedAt || 0)),
      media: mergeSocialMedia([], next.media)
    };
  }
  return {
    externalId: preferText(nextId, existingId),
    author: {
      id: preferText(nextAuthor.id, existingAuthor.id),
      handle: preferText(nextAuthor.handle, existingAuthor.handle),
      name: preferText(nextAuthor.name, existingAuthor.name),
      avatarUrl: preferText(nextAuthor.avatarUrl, existingAuthor.avatarUrl)
    },
    content: preferText(next.content, existing.content),
    translatedContent: preferText(next.translatedContent, existing.translatedContent),
    url: preferText(next.url, existing.url),
    publishedAt: Number(next.publishedAt || 0) > 0
      ? Number(next.publishedAt)
      : Math.max(0, Number(existing.publishedAt || 0)),
    media: mergeSocialMedia(existing.media, next.media)
  };
}

function mergeSocialProfile(currentChanges, currentDetail, incomingChanges, incomingDetail) {
  const selected = new Set([
    ...(Array.isArray(currentChanges) ? currentChanges : []),
    ...(Array.isArray(incomingChanges) ? incomingChanges : [])
  ]);
  const existing = currentDetail && typeof currentDetail === 'object' ? currentDetail : {};
  const next = incomingDetail && typeof incomingDetail === 'object' ? incomingDetail : {};
  const changes = SOCIAL_PROFILE_CHANGES.filter((change) => selected.has(change));
  const detail = {};
  for (const change of changes) {
    const previousValues = existing[change] && typeof existing[change] === 'object' ? existing[change] : {};
    const nextValues = next[change] && typeof next[change] === 'object' ? next[change] : {};
    detail[change] = {
      before: String(nextValues.before || previousValues.before || ''),
      after: String(nextValues.after || previousValues.after || '')
    };
  }
  return { changes, detail };
}

function activityClusters(rows) {
  const byOccurrence = new Map();
  for (const row of rows) {
    const occurrenceAt = Number(row.source_updated_at) || Number(row.published_at);
    const cluster = byOccurrence.get(occurrenceAt) || [];
    cluster.push(row);
    byOccurrence.set(occurrenceAt, cluster);
  }
  return [...byOccurrence.entries()]
    .sort(([left], [right]) => left - right)
    .map(([occurrenceAt, clusterRows]) => ({ occurrenceAt, rows: clusterRows }));
}

function migrateSocialActivities(db) {
  const rows = db.prepare(`
    SELECT id, source, external_id, kind, author_id, author_handle, author_name,
           author_avatar_url, author_followers, target_json, feed_sources_json,
           published_at, received_at, source_updated_at, stored_at, updated_at
    FROM social_posts
    WHERE source = 'twitter' AND kind IN ('post', 'follow', 'unfollow')
  `).all();
  const groups = new Map();
  for (const row of rows) {
    const activity = parseSocialActivityIdentity(row.external_id, row.author_handle);
    if (!activity) continue;
    const key = `${row.source}\u0000${activity.canonicalId}`;
    const group = groups.get(key) || { activity, rows: [] };
    group.rows.push(row);
    groups.set(key, group);
  }
  if (!groups.size) return;

  const plans = [];
  for (const { activity, rows: groupRows } of groups.values()) {
    const clusters = activityClusters(groupRows);
    for (const [occurrenceIndex, cluster] of clusters.entries()) {
      const clusterRows = cluster.rows;
      const newestFirst = [...clusterRows].sort((left, right) =>
        Number(right.source_updated_at) - Number(left.source_updated_at)
        || Number(right.updated_at) - Number(left.updated_at)
        || Number(right.id) - Number(left.id));
      const winner = newestFirst[0];
      const exactBase = clusterRows.find((row) =>
        String(row.external_id).toLowerCase() === activity.canonicalId.toLowerCase());
      const exactOccurrence = clusterRows
        .map((row) => parseSocialActivityIdentity(row.external_id, row.author_handle))
        .find((identity) => identity?.occurrenceAt !== null && identity?.occurrenceAt !== undefined);
      const externalId = exactBase
        ? activity.canonicalId
        : exactOccurrence?.occurrenceId || (occurrenceIndex === 0
          ? activity.canonicalId
          : `${activity.canonicalId}:${cluster.occurrenceAt}`);
      const author = activityAuthorFromRows(newestFirst, activity.actorHandle);
      const target = activityTargetFromRows(newestFirst, activity);
      const feedSources = normalizeFeedSources(
        newestFirst.map((row) => parseJson(row.feed_sources_json, []))
      );
      const receivedAt = Math.min(...clusterRows.map((row) => Number(row.received_at)));
      const storedAt = Math.min(...clusterRows.map((row) => Number(row.stored_at)));
      const updatedAt = Math.max(...clusterRows.map((row) => Number(row.updated_at)));
      plans.push({
        activity,
        winner,
        duplicates: newestFirst.slice(1),
        externalId,
        author,
        target,
        feedSources,
        receivedAt,
        storedAt,
        updatedAt,
        temporaryId: groupRows.length > 1 ? `social-activity-migration:${winner.id}` : '',
        needsUpdate: winner.external_id !== externalId
          || winner.kind !== activity.kind
          || winner.author_id !== author.id
          || winner.author_handle !== author.handle
          || winner.author_name !== author.name
          || winner.author_avatar_url !== author.avatarUrl
          || Number(winner.author_followers) !== author.followers
          || winner.target_json !== json(target)
          || winner.feed_sources_json !== json(feedSources)
          || Number(winner.received_at) !== receivedAt
          || Number(winner.stored_at) !== storedAt
          || Number(winner.updated_at) !== updatedAt
      });
    }
  }

  const deleteRow = db.prepare('DELETE FROM social_posts WHERE id = ?');
  const setTemporaryId = db.prepare('UPDATE social_posts SET external_id = ? WHERE id = ?');
  const updateWinner = db.prepare(`
    UPDATE social_posts
    SET external_id = ?, kind = ?, author_id = ?, author_handle = ?, author_name = ?,
        author_avatar_url = ?, author_followers = ?, target_json = ?, feed_sources_json = ?,
        received_at = ?, stored_at = ?, updated_at = ?
    WHERE id = ?
  `);
  transaction(db, () => {
    for (const plan of plans) {
      for (const duplicate of plan.duplicates) deleteRow.run(duplicate.id);
    }
    for (const plan of plans) {
      if (plan.temporaryId) setTemporaryId.run(plan.temporaryId, plan.winner.id);
    }
    for (const plan of plans) {
      if (!plan.temporaryId && !plan.needsUpdate) continue;
      updateWinner.run(
        plan.externalId,
        plan.activity.kind,
        plan.author.id,
        plan.author.handle,
        plan.author.name,
        plan.author.avatarUrl,
        plan.author.followers,
        json(plan.target),
        json(plan.feedSources),
        plan.receivedAt,
        plan.storedAt,
        plan.updatedAt,
        plan.winner.id
      );
    }
  });
}

function legacyProfileChange(row) {
  const aliases = new Map([
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
  const raw = parseJson(row.raw_json, {});
  const rawTweet = raw?.tweet && typeof raw.tweet === 'object' ? raw.tweet : {};
  for (const value of [
    raw?.kind,
    raw?.postType,
    raw?.tw_type,
    raw?.twType,
    raw?.twitter_type,
    raw?.event_type,
    raw?.eventType,
    raw?.action,
    raw?.type,
    raw?.tweet_type,
    rawTweet?.tweet_type
  ]) {
    const change = aliases.get(String(value || '').trim().toLowerCase().replace(/[-_\s]+/g, ''));
    if (change) return change;
  }
  return '';
}

function legacyProfileIdentity(row) {
  const authorHandle = String(row.author_handle || '').replace(/^@/, '').trim();
  if (!/^[a-z0-9_]{1,15}$/i.test(authorHandle)) return null;
  const occurrenceAt = Number(row.source_updated_at) || Number(row.published_at);
  const canonicalId = `profile:${authorHandle.toLowerCase()}:${occurrenceAt}`;
  const canonical = /^profile:([a-z0-9_]{1,15}):(\d{10,16})$/i.exec(String(row.external_id || ''));
  if (canonical) {
    if (canonical[1].toLowerCase() !== authorHandle.toLowerCase()) return null;
    return { authorHandle, canonicalId: `profile:${authorHandle.toLowerCase()}:${canonical[2]}` };
  }
  if (row.kind !== 'post' || row.content || row.url) return null;
  if (legacyProfileChange(row)) return { authorHandle, canonicalId };
  const externalId = String(row.external_id || '');
  const plainPrefix = `profile_${authorHandle}_`;
  if (externalId.toLowerCase().startsWith(plainPrefix.toLowerCase())) {
    return { authorHandle, canonicalId };
  }
  if (!/^[a-z0-9_-]{12,}$/i.test(externalId)) return null;
  let decoded = '';
  try {
    decoded = Buffer.from(externalId, 'base64url').toString('utf8');
  } catch {
    return null;
  }
  const decodedLower = decoded.toLowerCase();
  if (!decodedLower.startsWith(`@${authorHandle.toLowerCase()}_`)
    || !decodedLower.includes('https://pbs.twimg.com/profile_images/')) return null;
  return { authorHandle, canonicalId };
}

function legacyProfileData(rows) {
  const changes = new Set();
  const detail = {};
  for (const row of rows) {
    const stored = profileFromJson(row.profile_json);
    for (const change of stored.changes) {
      changes.add(change);
      detail[change] = stored.detail[change];
    }
    const rawChange = legacyProfileChange(row);
    if (rawChange) changes.add(rawChange);
    if (String(row.external_id || '').includes('profile_images')) changes.add('avatar');
    try {
      const decoded = Buffer.from(String(row.external_id || ''), 'base64url').toString('utf8');
      if (decoded.includes('profile_images')) changes.add('avatar');
    } catch {
      // The external id is not a legacy base64 profile identity.
    }
  }
  const ordered = SOCIAL_PROFILE_CHANGES.filter((change) => changes.has(change));
  for (const change of ordered) {
    if (!detail[change]) detail[change] = { before: '', after: '' };
  }
  return { changes: ordered, detail };
}

function migrateProfileActivities(db) {
  const groups = new Map();
  for (const row of db.prepare(`
    SELECT id, external_id, kind, author_id, author_handle, author_name,
           author_avatar_url, author_followers, content, url, feed_sources_json,
           profile_json, raw_json, published_at, received_at, source_updated_at, stored_at, updated_at
    FROM social_posts
    WHERE source = 'twitter' AND kind IN ('post', 'profile')
  `).all()) {
    const identity = legacyProfileIdentity(row);
    if (!identity) continue;
    const group = groups.get(identity.canonicalId) || [];
    group.push({ ...row, identity });
    groups.set(identity.canonicalId, group);
  }
  if (!groups.size) return;

  const deleteRow = db.prepare('DELETE FROM social_posts WHERE id = ?');
  const setTemporaryId = db.prepare('UPDATE social_posts SET external_id = ? WHERE id = ?');
  const updateWinner = db.prepare(`
    UPDATE social_posts
    SET external_id = ?, kind = 'profile', author_id = ?, author_handle = ?, author_name = ?,
        author_avatar_url = ?, author_followers = ?, feed_sources_json = ?, profile_json = ?,
        received_at = ?, stored_at = ?, updated_at = ?
    WHERE id = ?
  `);
  transaction(db, () => {
    for (const [canonicalId, groupRows] of groups) {
      const ordered = [...groupRows].sort((left, right) =>
        Number(right.updated_at) - Number(left.updated_at)
        || Number(right.id) - Number(left.id));
      const winner = ordered[0];
      const author = activityAuthorFromRows(ordered, winner.identity.authorHandle);
      const feedSources = normalizeFeedSources(
        ordered.map((row) => parseJson(row.feed_sources_json, []))
      );
      const profile = legacyProfileData(ordered);
      for (const duplicate of ordered.slice(1)) deleteRow.run(duplicate.id);
      if (ordered.length > 1) setTemporaryId.run(`social-profile-migration:${winner.id}`, winner.id);
      const receivedAt = Math.min(...ordered.map((row) => Number(row.received_at)));
      const storedAt = Math.min(...ordered.map((row) => Number(row.stored_at)));
      const updatedAt = Math.max(...ordered.map((row) => Number(row.updated_at)));
      const needsUpdate = ordered.length > 1
        || winner.external_id !== canonicalId
        || winner.kind !== 'profile'
        || winner.author_id !== author.id
        || winner.author_handle !== author.handle
        || winner.author_name !== author.name
        || winner.author_avatar_url !== author.avatarUrl
        || Number(winner.author_followers) !== author.followers
        || winner.feed_sources_json !== json(feedSources)
        || winner.profile_json !== json(profile)
        || Number(winner.received_at) !== receivedAt
        || Number(winner.stored_at) !== storedAt
        || Number(winner.updated_at) !== updatedAt;
      if (needsUpdate) {
        updateWinner.run(
          canonicalId,
          author.id,
          author.handle,
          author.name,
          author.avatarUrl,
          author.followers,
          json(feedSources),
          json(profile),
          receivedAt,
          storedAt,
          updatedAt,
          winner.id
        );
      }
    }
  });
}

function resolveActivityOccurrence(db, normalized) {
  const activity = parseSocialActivityIdentity(normalized.externalId, normalized.authorHandle);
  if (!activity || normalized.source !== 'twitter') return normalized;
  if (normalized._activityOccurrenceId) {
    return { ...normalized, externalId: normalized._activityOccurrenceId };
  }
  const candidates = db.prepare(`
    SELECT external_id, published_at, source_updated_at, id
    FROM social_posts
    WHERE source = ? AND (external_id = ? OR external_id GLOB ?)
  `).all(normalized.source, activity.canonicalId, `${activity.canonicalId}:*`);
  if (!candidates.length) return normalized;

  const occurrenceTimestampProvided = normalized._provided.has('sourceUpdatedAt')
    || normalized._provided.has('publishedAt');
  let existing;
  if (!occurrenceTimestampProvided) {
    existing = [...candidates].sort((left, right) =>
      Number(right.source_updated_at) - Number(left.source_updated_at)
      || Number(right.published_at) - Number(left.published_at)
      || Number(right.id) - Number(left.id))[0];
  } else {
    existing = candidates
      .filter((row) => Number(row.source_updated_at) === normalized.sourceUpdatedAt)
      .sort((left, right) =>
        Number(right.published_at) - Number(left.published_at)
        || Number(right.id) - Number(left.id))[0];
  }
  return {
    ...normalized,
    externalId: existing?.external_id || `${activity.canonicalId}:${normalized.sourceUpdatedAt}`
  };
}

function postValues(post, raw, now) {
  return [
    post.source,
    post.externalId,
    post.kind,
    post.authorId,
    post.authorHandle,
    post.authorName,
    post.authorAvatarUrl,
    post.authorFollowers,
    post.content,
    post.translatedContent,
    post.url,
    json(post.media),
    json(post.contractAddresses),
    json(post.chainTags),
    json(post.feedSources),
    post.replyToExternalId,
    post.quotedExternalId,
    post.repostExternalId,
    json(post.target),
    json(post.replyContext),
    json(post.quoteContext),
    json({ changes: post.profileChanges, detail: post.profileDetail }),
    post.publishedAt,
    post.receivedAt,
    post.discoveredAt,
    now,
    post.sourceUpdatedAt,
    post.deletedAt,
    json(raw),
    now,
    now
  ];
}

export function createSocialStore(filename, { now = () => Date.now() } = {}) {
  fs.mkdirSync(path.dirname(filename), { recursive: true });
  const db = new DatabaseSync(filename);
  db.exec(`
    PRAGMA journal_mode = WAL;
    PRAGMA synchronous = NORMAL;
    PRAGMA busy_timeout = 5000;
    PRAGMA foreign_keys = ON;

    CREATE TABLE IF NOT EXISTS social_posts (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      source TEXT NOT NULL,
      external_id TEXT NOT NULL,
      kind TEXT NOT NULL DEFAULT 'post',
      author_id TEXT NOT NULL DEFAULT '',
      author_handle TEXT NOT NULL DEFAULT '',
      author_name TEXT NOT NULL DEFAULT '',
      author_avatar_url TEXT NOT NULL DEFAULT '',
      author_followers INTEGER NOT NULL DEFAULT 0,
      content TEXT NOT NULL DEFAULT '',
      translated_content TEXT NOT NULL DEFAULT '',
      url TEXT NOT NULL DEFAULT '',
      media_json TEXT NOT NULL DEFAULT '[]',
      contract_addresses_json TEXT NOT NULL DEFAULT '[]',
      chain_tags_json TEXT NOT NULL DEFAULT '[]',
      feed_sources_json TEXT NOT NULL DEFAULT '["all"]',
      reply_to_external_id TEXT NOT NULL DEFAULT '',
      quoted_external_id TEXT NOT NULL DEFAULT '',
      repost_external_id TEXT NOT NULL DEFAULT '',
      target_json TEXT NOT NULL DEFAULT '{}',
      reply_context_json TEXT NOT NULL DEFAULT '{}',
      quote_context_json TEXT NOT NULL DEFAULT '{}',
      profile_json TEXT NOT NULL DEFAULT '{}',
      published_at INTEGER NOT NULL,
      received_at INTEGER NOT NULL,
      discovered_at INTEGER NOT NULL DEFAULT 0,
      ingested_at INTEGER NOT NULL DEFAULT 0,
      source_updated_at INTEGER NOT NULL,
      deleted_at INTEGER,
      raw_json TEXT NOT NULL DEFAULT '{}',
      stored_at INTEGER NOT NULL,
      updated_at INTEGER NOT NULL,
      UNIQUE(source, external_id)
    );
    CREATE INDEX IF NOT EXISTS social_posts_published_at_idx
      ON social_posts(published_at DESC, id DESC);
    CREATE INDEX IF NOT EXISTS social_posts_updated_at_idx
      ON social_posts(updated_at DESC, id DESC);

    CREATE TABLE IF NOT EXISTS social_watchlist (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      platform TEXT NOT NULL,
      account_key TEXT NOT NULL,
      handle TEXT NOT NULL,
      name TEXT NOT NULL DEFAULT '',
      url TEXT NOT NULL DEFAULT '',
      remote_id TEXT NOT NULL DEFAULT '',
      metadata_json TEXT NOT NULL DEFAULT '{}',
      event_types_json TEXT NOT NULL DEFAULT '["post","reply","quote","repost","delete","follow","unfollow","profile_name","profile_avatar","profile_bio"]',
      local_note TEXT NOT NULL DEFAULT '',
      desired_state TEXT NOT NULL DEFAULT 'active',
      sync_status TEXT NOT NULL DEFAULT 'pending',
      origin TEXT NOT NULL DEFAULT 'local',
      last_synced_at INTEGER,
      last_error TEXT NOT NULL DEFAULT '',
      created_at INTEGER NOT NULL,
      updated_at INTEGER NOT NULL,
      UNIQUE(platform, account_key)
    );
    CREATE INDEX IF NOT EXISTS social_watchlist_state_idx
      ON social_watchlist(desired_state, sync_status, updated_at DESC);

    CREATE TABLE IF NOT EXISTS social_commands (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      command_type TEXT NOT NULL,
      watchlist_id INTEGER,
      payload_json TEXT NOT NULL DEFAULT '{}',
      status TEXT NOT NULL DEFAULT 'pending',
      attempts INTEGER NOT NULL DEFAULT 0,
      created_at INTEGER NOT NULL,
      claimed_at INTEGER,
      completed_at INTEGER,
      last_error TEXT NOT NULL DEFAULT '',
      FOREIGN KEY(watchlist_id) REFERENCES social_watchlist(id)
    );
    CREATE INDEX IF NOT EXISTS social_commands_pending_idx
      ON social_commands(status, id);

    CREATE TABLE IF NOT EXISTS debot_wallet_sync (
      address TEXT PRIMARY KEY,
      note TEXT NOT NULL DEFAULT '',
      desired_state TEXT NOT NULL DEFAULT 'active',
      sync_status TEXT NOT NULL DEFAULT 'pending',
      last_synced_at INTEGER,
      last_error TEXT NOT NULL DEFAULT '',
      updated_at INTEGER NOT NULL
    );

    CREATE TABLE IF NOT EXISTS social_changes (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      event_type TEXT NOT NULL,
      entity_type TEXT NOT NULL,
      entity_id TEXT NOT NULL,
      payload_json TEXT NOT NULL,
      created_at INTEGER NOT NULL
    );
    CREATE INDEX IF NOT EXISTS social_changes_created_idx ON social_changes(created_at, id);

    CREATE TABLE IF NOT EXISTS social_translation_cache (
      source_hash TEXT NOT NULL,
      source_length INTEGER NOT NULL,
      model TEXT NOT NULL,
      translated_content TEXT NOT NULL,
      created_at INTEGER NOT NULL,
      updated_at INTEGER NOT NULL,
      PRIMARY KEY(source_hash, model)
    );
    CREATE INDEX IF NOT EXISTS social_translation_cache_updated_idx
      ON social_translation_cache(updated_at DESC);

    CREATE TABLE IF NOT EXISTS social_bridge_state (
      singleton INTEGER PRIMARY KEY CHECK(singleton = 1),
      bridge_id TEXT NOT NULL DEFAULT '',
      version TEXT NOT NULL DEFAULT '',
      capabilities_json TEXT NOT NULL DEFAULT '[]',
      session_id TEXT NOT NULL DEFAULT '',
      diagnostics_json TEXT NOT NULL DEFAULT '{}',
      snapshot_session_id TEXT NOT NULL DEFAULT '',
      snapshot_session_started_at INTEGER NOT NULL DEFAULT 0,
      snapshot_revision INTEGER NOT NULL DEFAULT 0,
      last_seen_at INTEGER,
      updated_at INTEGER NOT NULL
    );

    CREATE TABLE IF NOT EXISTS debot_bridge_jobs (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      request_key TEXT NOT NULL,
      job_type TEXT NOT NULL,
      payload_json TEXT NOT NULL,
      status TEXT NOT NULL DEFAULT 'pending',
      attempts INTEGER NOT NULL DEFAULT 0,
      claim_token TEXT NOT NULL DEFAULT '',
      result_json TEXT,
      error_code TEXT NOT NULL DEFAULT '',
      error_message TEXT NOT NULL DEFAULT '',
      created_at INTEGER NOT NULL,
      updated_at INTEGER NOT NULL,
      deadline_at INTEGER NOT NULL,
      claimed_at INTEGER,
      lease_expires_at INTEGER,
      completed_at INTEGER,
      cache_expires_at INTEGER
    );
    CREATE INDEX IF NOT EXISTS debot_bridge_jobs_queue_idx
      ON debot_bridge_jobs(status, id);
    CREATE INDEX IF NOT EXISTS debot_bridge_jobs_request_idx
      ON debot_bridge_jobs(request_key, status, id DESC);
    CREATE INDEX IF NOT EXISTS debot_bridge_jobs_cache_idx
      ON debot_bridge_jobs(request_key, cache_expires_at DESC);
  `);

  const socialPostColumns = new Set(db.prepare('PRAGMA table_info(social_posts)').all().map((column) => column.name));
  if (!socialPostColumns.has('feed_sources_json')) {
    db.exec("ALTER TABLE social_posts ADD COLUMN feed_sources_json TEXT NOT NULL DEFAULT '[\"all\"]'");
  }
  if (!socialPostColumns.has('target_json')) {
    db.exec("ALTER TABLE social_posts ADD COLUMN target_json TEXT NOT NULL DEFAULT '{}'");
  }
  if (!socialPostColumns.has('reply_context_json')) {
    db.exec("ALTER TABLE social_posts ADD COLUMN reply_context_json TEXT NOT NULL DEFAULT '{}'");
  }
  if (!socialPostColumns.has('quote_context_json')) {
    db.exec("ALTER TABLE social_posts ADD COLUMN quote_context_json TEXT NOT NULL DEFAULT '{}'");
  }
  if (!socialPostColumns.has('profile_json')) {
    db.exec("ALTER TABLE social_posts ADD COLUMN profile_json TEXT NOT NULL DEFAULT '{}'");
  }
  if (!socialPostColumns.has('discovered_at')) {
    db.exec('ALTER TABLE social_posts ADD COLUMN discovered_at INTEGER NOT NULL DEFAULT 0');
    db.exec('UPDATE social_posts SET discovered_at = received_at WHERE discovered_at = 0');
  }
  if (!socialPostColumns.has('ingested_at')) {
    db.exec('ALTER TABLE social_posts ADD COLUMN ingested_at INTEGER NOT NULL DEFAULT 0');
    db.exec('UPDATE social_posts SET ingested_at = stored_at WHERE ingested_at = 0');
  }

  const socialWatchlistColumns = new Set(
    db.prepare('PRAGMA table_info(social_watchlist)').all().map((column) => column.name)
  );
  if (!socialWatchlistColumns.has('event_types_json')) {
    db.exec(`ALTER TABLE social_watchlist ADD COLUMN event_types_json TEXT NOT NULL DEFAULT '${json(SOCIAL_WATCH_EVENT_TYPES)}'`);
  }
  if (!socialWatchlistColumns.has('local_note')) {
    db.exec("ALTER TABLE social_watchlist ADD COLUMN local_note TEXT NOT NULL DEFAULT ''");
  }
  if (!socialWatchlistColumns.has('ca_bark_enabled')) {
    db.exec('ALTER TABLE social_watchlist ADD COLUMN ca_bark_enabled INTEGER NOT NULL DEFAULT 0');
  }

  const socialBridgeStateColumns = new Set(
    db.prepare('PRAGMA table_info(social_bridge_state)').all().map((column) => column.name)
  );
  if (!socialBridgeStateColumns.has('snapshot_session_id')) {
    db.exec("ALTER TABLE social_bridge_state ADD COLUMN snapshot_session_id TEXT NOT NULL DEFAULT ''");
  }
  if (!socialBridgeStateColumns.has('diagnostics_json')) {
    db.exec("ALTER TABLE social_bridge_state ADD COLUMN diagnostics_json TEXT NOT NULL DEFAULT '{}'");
  }
  if (!socialBridgeStateColumns.has('snapshot_session_started_at')) {
    db.exec('ALTER TABLE social_bridge_state ADD COLUMN snapshot_session_started_at INTEGER NOT NULL DEFAULT 0');
  }
  if (!socialBridgeStateColumns.has('snapshot_revision')) {
    db.exec('ALTER TABLE social_bridge_state ADD COLUMN snapshot_revision INTEGER NOT NULL DEFAULT 0');
  }

  migrateSocialActivities(db);
  migrateProfileActivities(db);

  const insertPost = db.prepare(`
    INSERT INTO social_posts(
      source, external_id, kind, author_id, author_handle, author_name, author_avatar_url,
      author_followers, content, translated_content, url, media_json, contract_addresses_json,
      chain_tags_json, feed_sources_json, reply_to_external_id, quoted_external_id, repost_external_id,
      target_json, reply_context_json, quote_context_json, profile_json, published_at, received_at, discovered_at, ingested_at, source_updated_at,
      deleted_at, raw_json, stored_at, updated_at
    ) VALUES (${Array(31).fill('?').join(', ')})
  `);
  const updatePost = db.prepare(`
    UPDATE social_posts SET
      kind = ?, author_id = ?, author_handle = ?, author_name = ?, author_avatar_url = ?,
      author_followers = ?, content = ?, translated_content = ?, url = ?, media_json = ?,
      contract_addresses_json = ?, chain_tags_json = ?, feed_sources_json = ?, reply_to_external_id = ?,
      quoted_external_id = ?, repost_external_id = ?, target_json = ?, reply_context_json = ?, quote_context_json = ?, profile_json = ?, published_at = ?, received_at = ?,
      discovered_at = ?, source_updated_at = ?, deleted_at = ?, raw_json = ?, updated_at = ?
    WHERE id = ?
  `);
  const insertChange = db.prepare(`
    INSERT INTO social_changes(event_type, entity_type, entity_id, payload_json, created_at)
    VALUES (?, ?, ?, ?, ?)
  `);

  function recordChange(type, entityType, entityId, data, timestamp) {
    const result = insertChange.run(type, entityType, String(entityId), json(data), timestamp);
    return changeFromRow(db.prepare('SELECT * FROM social_changes WHERE id = ?').get(Number(result.lastInsertRowid)));
  }

  function applyPost(input, timestamp) {
    const normalized = resolveActivityOccurrence(db, normalizeSocialPost(input, { now: timestamp }));
    const existingRow = db.prepare('SELECT * FROM social_posts WHERE source = ? AND external_id = ?')
      .get(normalized.source, normalized.externalId);
    if (!existingRow) {
      const result = insertPost.run(...postValues(normalized, normalized.raw, timestamp));
      const post = postFromRow(db.prepare('SELECT * FROM social_posts WHERE id = ?').get(Number(result.lastInsertRowid)));
      const type = post.deleted ? 'post.deleted' : 'post.created';
      return { action: post.deleted ? 'deleted' : 'created', post, change: recordChange(type, 'post', post.id, post, timestamp) };
    }

    const existing = postFromRow(existingRow, { hideUnneededTranslations: false });
    const provided = normalized._provided;
    const mergedFeedSources = provided.has('feedSources')
      ? normalizeFeedSources([existing.feedSources, normalized.feedSources])
      : existing.feedSources;
    const feedSourcesChanged = json(mergedFeedSources) !== json(existing.feedSources);
    const staleRestore = existing.deleted
      && provided.has('deletedAt')
      && normalized.deletedAt === null
      && normalized.sourceUpdatedAt <= existing.sourceUpdatedAt;
    if ((normalized.sourceUpdatedAt < existing.sourceUpdatedAt && !provided.has('deletedAt')) || staleRestore) {
      const mergedMedia = provided.has('media')
        ? mergeSocialMedia(existing.media, normalized.media)
        : existing.media;
      const mergedReplyContext = provided.has('replyContext')
        ? mergeReplyContext(existing.replyContext, normalized.replyContext)
        : existing.replyContext;
      const contextParentId = /^\d{5,25}$/.test(String(mergedReplyContext.externalId || ''))
        ? String(mergedReplyContext.externalId)
        : '';
      const incomingReplyId = /^\d{5,25}$/.test(String(normalized.replyToExternalId || ''))
        ? String(normalized.replyToExternalId)
        : '';
      const mergedReplyId = contextParentId || incomingReplyId || existing.replyToExternalId;
      const mergedTarget = provided.has('target')
        ? mergeSocialTarget(existing.target, normalized.target)
        : existing.target;
      const mergedQuoteContext = provided.has('quoteContext')
        ? mergeReplyContext(existing.quoteContext, normalized.quoteContext)
        : existing.quoteContext;
      const contextQuoteId = /^\d{5,25}$/.test(String(mergedQuoteContext.externalId || ''))
        ? String(mergedQuoteContext.externalId)
        : '';
      const incomingQuoteId = /^\d{5,25}$/.test(String(normalized.quotedExternalId || ''))
        ? String(normalized.quotedExternalId)
        : '';
      const mergedQuoteId = contextQuoteId || incomingQuoteId || existing.quotedExternalId;
      const replySidecarChanged = json(mergedReplyContext) !== json(existing.replyContext)
        || mergedReplyId !== existing.replyToExternalId
        || json(mergedTarget) !== json(existing.target);
      const quoteSidecarChanged = json(mergedQuoteContext) !== json(existing.quoteContext)
        || mergedQuoteId !== existing.quotedExternalId;
      const mediaChanged = json(mergedMedia) !== json(existing.media);
      if (!feedSourcesChanged && !replySidecarChanged && !quoteSidecarChanged && !mediaChanged) {
        return { action: 'unchanged', post: existing, change: null };
      }
      db.prepare(`
        UPDATE social_posts SET
          media_json = ?, feed_sources_json = ?, reply_to_external_id = ?, quoted_external_id = ?, target_json = ?,
          reply_context_json = ?, quote_context_json = ?, updated_at = ?
        WHERE id = ?
      `).run(
        json(mergedMedia),
        json(mergedFeedSources),
        mergedReplyId,
        mergedQuoteId,
        json(mergedTarget),
        json(mergedReplyContext),
        json(mergedQuoteContext),
        timestamp,
        existing.id
      );
      const post = postFromRow(db.prepare('SELECT * FROM social_posts WHERE id = ?').get(existing.id));
      return {
        action: 'updated',
        post,
        change: recordChange('post.updated', 'post', post.id, post, timestamp)
      };
    }
    const choose = (name, current) => provided.has(name) ? normalized[name] : current;
    const mergedAuthor = mergeSocialAuthor(existing.author, {
      id: choose('authorId', existing.author.id),
      handle: choose('authorHandle', existing.author.handle),
      name: choose('authorName', existing.author.name),
      avatarUrl: choose('authorAvatarUrl', existing.author.avatarUrl),
      followers: choose('authorFollowers', existing.author.followers)
    });
    const mergedProfile = provided.has('profileChanges') || provided.has('profileDetail')
      ? mergeSocialProfile(
        existing.profileChanges,
        existing.profileDetail,
        normalized.profileChanges,
        normalized.profileDetail
      )
      : { changes: existing.profileChanges, detail: existing.profileDetail };
    const merged = {
      ...normalized,
      kind: choose('kind', existing.kind),
      authorId: mergedAuthor.id,
      authorHandle: mergedAuthor.handle,
      authorName: mergedAuthor.name,
      authorAvatarUrl: mergedAuthor.avatarUrl,
      authorFollowers: mergedAuthor.followers,
      content: choose('content', existing.content),
      translatedContent: choose('translatedContent', existing.translatedContent),
      url: choose('url', existing.url),
      media: provided.has('media')
        ? mergeSocialMedia(existing.media, normalized.media)
        : existing.media,
      contractAddresses: choose('contractAddresses', existing.contractAddresses),
      chainTags: choose('chainTags', existing.chainTags),
      feedSources: mergedFeedSources,
      replyToExternalId: choose('replyToExternalId', existing.replyToExternalId),
      quotedExternalId: choose('quotedExternalId', existing.quotedExternalId),
      repostExternalId: choose('repostExternalId', existing.repostExternalId),
      target: provided.has('target') ? mergeSocialTarget(existing.target, normalized.target) : existing.target,
      replyContext: provided.has('replyContext')
        ? mergeReplyContext(existing.replyContext, normalized.replyContext)
        : existing.replyContext,
      quoteContext: provided.has('quoteContext')
        ? mergeReplyContext(existing.quoteContext, normalized.quoteContext)
        : existing.quoteContext,
      profileChanges: mergedProfile.changes,
      profileDetail: mergedProfile.detail,
      publishedAt: choose('publishedAt', existing.publishedAt),
      discoveredAt: Math.min(existing.debotDiscoveredAt, normalized.discoveredAt),
      receivedAt: Math.min(existing.receivedAt, normalized.receivedAt),
      sourceUpdatedAt: Math.max(existing.sourceUpdatedAt, normalized.sourceUpdatedAt),
      deletedAt: choose('deletedAt', existing.deletedAt),
      raw: choose('raw', existing.raw)
    };
    if (/^\d{5,25}$/.test(String(merged.replyContext?.externalId || ''))) {
      merged.replyToExternalId = String(merged.replyContext.externalId);
    }
    if (/^\d{5,25}$/.test(String(merged.quoteContext?.externalId || ''))) {
      merged.quotedExternalId = String(merged.quoteContext.externalId);
    }
    const visibleBefore = json(existing);
    const preview = {
      ...existing,
      kind: merged.kind,
      author: {
        id: merged.authorId,
        handle: merged.authorHandle,
        name: merged.authorName,
        avatarUrl: merged.authorAvatarUrl,
        followers: merged.authorFollowers
      },
      content: merged.content,
      translatedContent: merged.translatedContent,
      url: merged.url,
      media: merged.media,
      contractAddresses: merged.contractAddresses,
      chainTags: merged.chainTags,
      feedSources: merged.feedSources,
      replyToExternalId: merged.replyToExternalId,
      quotedExternalId: merged.quotedExternalId,
      repostExternalId: merged.repostExternalId,
      target: merged.target,
      replyContext: merged.replyContext,
      quoteContext: merged.quoteContext,
      profileChanges: merged.profileChanges,
      profileDetail: merged.profileDetail,
      publishedAt: merged.publishedAt,
      debotDiscoveredAt: merged.discoveredAt,
      discoveredAt: merged.discoveredAt,
      receivedAt: merged.receivedAt,
      sourceUpdatedAt: merged.sourceUpdatedAt,
      deleted: merged.deletedAt !== null,
      deletedAt: merged.deletedAt,
      raw: merged.raw
    };
    delete preview.updatedAt;
    delete preview.storedAt;
    const beforeComparable = { ...existing };
    delete beforeComparable.updatedAt;
    delete beforeComparable.storedAt;
    if (visibleBefore === json(existing) && json(beforeComparable) === json(preview)) {
      return { action: 'unchanged', post: existing, change: null };
    }
    updatePost.run(
      merged.kind,
      merged.authorId,
      merged.authorHandle,
      merged.authorName,
      merged.authorAvatarUrl,
      merged.authorFollowers,
      merged.content,
      merged.translatedContent,
      merged.url,
      json(merged.media),
      json(merged.contractAddresses),
      json(merged.chainTags),
      json(merged.feedSources),
      merged.replyToExternalId,
      merged.quotedExternalId,
      merged.repostExternalId,
      json(merged.target),
      json(merged.replyContext),
      json(merged.quoteContext),
      json({ changes: merged.profileChanges, detail: merged.profileDetail }),
      merged.publishedAt,
      merged.receivedAt,
      merged.discoveredAt,
      merged.sourceUpdatedAt,
      merged.deletedAt,
      json(merged.raw),
      timestamp,
      existing.id
    );
    const post = postFromRow(db.prepare('SELECT * FROM social_posts WHERE id = ?').get(existing.id));
    const newlyDeleted = !existing.deleted && post.deleted;
    const restored = existing.deleted && !post.deleted;
    const type = newlyDeleted ? 'post.deleted' : restored ? 'post.restored' : 'post.updated';
    return { action: newlyDeleted ? 'deleted' : restored ? 'restored' : 'updated', post, change: recordChange(type, 'post', post.id, post, timestamp) };
  }

  function cancelPendingOppositeCommand(watchlistId, type, timestamp) {
    const opposite = type === 'watchlist.add' ? 'watchlist.delete' : 'watchlist.add';
    db.prepare(`
      UPDATE social_commands
      SET status = 'cancelled', completed_at = ?, last_error = 'Superseded by newer local intent'
      WHERE watchlist_id = ? AND command_type = ? AND status = 'pending'
    `).run(timestamp, watchlistId, opposite);
  }

  function queueWatchlistCommand(row, type, timestamp) {
    cancelPendingOppositeCommand(row.id, type, timestamp);
    const existing = db.prepare(`
      SELECT * FROM social_commands
      WHERE watchlist_id = ? AND command_type = ? AND status IN ('pending', 'claimed')
      ORDER BY id DESC LIMIT 1
    `).get(row.id, type);
    if (existing) return commandFromRow(existing);
    const payload = {
      watchlistId: Number(row.id),
      platform: row.platform,
      accountKey: row.account_key,
      handle: row.handle,
      name: row.name,
      url: row.url,
      remoteId: row.remote_id,
      eventTypes: watchEventTypesFromJson(row.event_types_json)
    };
    const result = db.prepare(`
      INSERT INTO social_commands(command_type, watchlist_id, payload_json, status, created_at)
      VALUES (?, ?, ?, 'pending', ?)
    `).run(type, row.id, json(payload), timestamp);
    return commandFromRow(db.prepare('SELECT * FROM social_commands WHERE id = ?').get(Number(result.lastInsertRowid)));
  }

  function queueDeBotWalletCommand(row, type, timestamp) {
    const opposite = type === 'wallet.watch.upsert' ? 'wallet.watch.delete' : 'wallet.watch.upsert';
    const address = String(row.address || '').toLowerCase();
    db.prepare(`
      UPDATE social_commands
      SET status = 'cancelled', completed_at = ?, last_error = 'Superseded by newer local wallet intent'
      WHERE watchlist_id IS NULL AND command_type = ? AND status IN ('pending', 'claimed')
        AND lower(json_extract(payload_json, '$.address')) = ?
    `).run(timestamp, opposite, address);
    const payload = {
      chain: 'bsc',
      address,
      note: String(row.note || ''),
      desiredState: String(row.desired_state || 'active')
    };
    const serialized = json(payload);
    const existing = db.prepare(`
      SELECT * FROM social_commands
      WHERE watchlist_id IS NULL AND command_type = ? AND payload_json = ?
        AND status IN ('pending', 'claimed')
      ORDER BY id DESC LIMIT 1
    `).get(type, serialized);
    if (existing) return commandFromRow(existing);
    db.prepare(`
      UPDATE social_commands
      SET status = 'cancelled', completed_at = ?, last_error = 'Superseded by newer wallet details'
      WHERE watchlist_id IS NULL AND command_type = ? AND status IN ('pending', 'claimed')
        AND lower(json_extract(payload_json, '$.address')) = ?
    `).run(timestamp, type, address);
    const result = db.prepare(`
      INSERT INTO social_commands(command_type, watchlist_id, payload_json, status, created_at)
      VALUES (?, NULL, ?, 'pending', ?)
    `).run(type, serialized, timestamp);
    return commandFromRow(db.prepare('SELECT * FROM social_commands WHERE id = ?').get(Number(result.lastInsertRowid)));
  }

  function addWatchAccount(input, timestamp, {
    origin = 'local',
    synced = false,
    preserveLocalPreferences = false
  } = {}) {
    const account = normalizeWatchAccount(input);
    if (account.platform === 'fomo') synced = true;
    const suppliedNote = !preserveLocalPreferences && account._noteProvided
      ? normalizeWatchNote(account.note)
      : '';
    const existing = db.prepare('SELECT * FROM social_watchlist WHERE platform = ? AND account_key = ?')
      .get(account.platform, account.accountKey);
    const nextCreatedAt = !existing || existing.desired_state === 'removed'
      ? Math.max(
        timestamp,
        Number(db.prepare('SELECT COALESCE(MAX(created_at), 0) AS latest FROM social_watchlist').get().latest) + 1
      )
      : existing.created_at;
    let id;
    let changed = false;
    if (!existing) {
      const initialEventTypes = preserveLocalPreferences
        ? SOCIAL_WATCH_EVENT_TYPES
        : account.eventTypes;
      const initialNote = preserveLocalPreferences ? '' : suppliedNote;
      const result = db.prepare(`
        INSERT INTO social_watchlist(
          platform, account_key, handle, name, url, remote_id, metadata_json, event_types_json, local_note, ca_bark_enabled, desired_state,
          sync_status, origin, last_synced_at, created_at, updated_at
        ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 'active', ?, ?, ?, ?, ?)
      `).run(
        account.platform,
        account.accountKey,
        account.handle,
        account.name,
        account.url,
        account.remoteId,
        json(account.metadata),
        json(initialEventTypes),
        initialNote,
        preserveLocalPreferences ? 0 : (account.caBark ? 1 : 0),
        synced ? 'synced' : 'pending',
        origin,
        synced ? timestamp : null,
        nextCreatedAt,
        timestamp
      );
      id = Number(result.lastInsertRowid);
      changed = true;
    } else {
      id = Number(existing.id);
      const nextName = account.name || existing.name;
      const nextUrl = account.url || existing.url;
      const nextRemoteId = account.remoteId || existing.remote_id;
      const nextMetadata = Object.keys(account.metadata).length ? account.metadata : parseJson(existing.metadata_json, {});
      const nextEventTypes = preserveLocalPreferences || !account._eventTypesProvided
        ? watchEventTypesFromJson(existing.event_types_json)
        : account.eventTypes;
      const nextNote = preserveLocalPreferences || !account._noteProvided
        ? existing.local_note
        : suppliedNote;
      const nextCaBark = preserveLocalPreferences || !account._caBarkProvided
        ? Boolean(existing.ca_bark_enabled)
        : account.caBark;
      const nextStatus = synced ? 'synced' : existing.desired_state === 'active' && existing.sync_status === 'synced'
        ? 'synced'
        : 'pending';
      changed = existing.desired_state !== 'active' || existing.handle !== account.handle ||
        existing.name !== nextName || existing.url !== nextUrl || existing.remote_id !== nextRemoteId ||
        existing.metadata_json !== json(nextMetadata) ||
        existing.event_types_json !== json(nextEventTypes) ||
        existing.local_note !== nextNote ||
        Boolean(existing.ca_bark_enabled) !== nextCaBark ||
        existing.sync_status !== nextStatus;
      if (changed) {
        db.prepare(`
          UPDATE social_watchlist SET
            handle = ?, name = ?, url = ?, remote_id = ?, metadata_json = ?, event_types_json = ?, local_note = ?, ca_bark_enabled = ?, desired_state = 'active',
            sync_status = ?, origin = ?, last_synced_at = ?, last_error = '', created_at = ?, updated_at = ?
          WHERE id = ?
        `).run(
          account.handle,
          nextName,
          nextUrl,
          nextRemoteId,
          json(nextMetadata),
          json(nextEventTypes),
          nextNote,
          nextCaBark ? 1 : 0,
          nextStatus,
          origin === 'remote' ? 'remote' : existing.origin,
          synced ? timestamp : existing.last_synced_at,
          nextCreatedAt,
          timestamp,
          id
        );
      }
    }
    const row = db.prepare('SELECT * FROM social_watchlist WHERE id = ?').get(id);
    const entry = watchlistFromRow(row);
    if (synced) {
      db.prepare(`
        UPDATE social_commands
        SET status = 'completed', completed_at = ?, last_error = ''
        WHERE watchlist_id = ? AND command_type = 'watchlist.add' AND status IN ('pending', 'claimed')
      `).run(timestamp, id);
    }
    const command = !synced && entry.syncStatus !== 'synced'
      ? queueWatchlistCommand(row, 'watchlist.add', timestamp)
      : null;
    const change = changed ? recordChange('watchlist.updated', 'watchlist', id, entry, timestamp) : null;
    return { entry, command, change, changed };
  }

  function updateWatchAccountPreferences(id, patch) {
    const numericId = Number(id);
    if (!Number.isSafeInteger(numericId) || numericId < 1) throw new TypeError('Invalid watchlist id');
    const normalized = normalizeWatchAccountPatch(patch);
    const timestamp = now();
    return transaction(db, () => {
      const existing = db.prepare('SELECT * FROM social_watchlist WHERE id = ?').get(numericId);
      if (!existing) return null;
      const currentEventTypes = watchEventTypesFromJson(existing.event_types_json);
      const nextEventTypes = normalized.eventTypesProvided ? normalized.eventTypes : currentEventTypes;
      const nextNote = normalized.noteProvided ? normalized.note : existing.local_note;
      const nextCaBark = normalized.caBarkProvided ? normalized.caBark : Boolean(existing.ca_bark_enabled);
      if (json(currentEventTypes) === json(nextEventTypes) && existing.local_note === nextNote
        && Boolean(existing.ca_bark_enabled) === nextCaBark) {
        return {
          entry: watchlistFromRow(existing),
          change: null,
          changed: false
        };
      }
      db.prepare(`
        UPDATE social_watchlist SET event_types_json = ?, local_note = ?, ca_bark_enabled = ?, updated_at = ? WHERE id = ?
      `).run(json(nextEventTypes), nextNote, nextCaBark ? 1 : 0, timestamp, numericId);
      const entry = watchlistFromRow(db.prepare('SELECT * FROM social_watchlist WHERE id = ?').get(numericId));
      return {
        entry,
        change: recordChange('watchlist.updated', 'watchlist', numericId, entry, timestamp),
        changed: true
      };
    });
  }

  return {
    db,
    upsertPosts(inputs) {
      if (!Array.isArray(inputs)) throw new TypeError('posts must be an array');
      const timestamp = now();
      return transaction(db, () => inputs.map((input) => applyPost(input, timestamp)));
    },
    deletePost(source, externalId, deletedAt = now()) {
      return transaction(db, () => {
        const timestamp = now();
        const normalizedSource = normalizeSocialSource(source);
        const normalizedExternalId = String(externalId || '').trim().slice(0, 240);
        if (!normalizedExternalId) throw new TypeError('Social post externalId is required');
        const deletionTimestamp = normalizeTimestamp(deletedAt, timestamp);
        const existingRow = db.prepare('SELECT * FROM social_posts WHERE source = ? AND external_id = ?')
          .get(normalizedSource, normalizedExternalId);
        if (!existingRow) {
          return applyPost({
            source: normalizedSource,
            externalId: normalizedExternalId,
            deleted: true,
            deletedAt: deletionTimestamp,
            sourceUpdatedAt: deletionTimestamp
          }, timestamp);
        }

        const existing = postFromRow(existingRow);
        const nextDeletedAt = Math.max(Number(existing.deletedAt || 0), deletionTimestamp);
        const nextSourceUpdatedAt = Math.max(existing.sourceUpdatedAt, deletionTimestamp);
        if (existing.deleted
          && existing.deletedAt === nextDeletedAt
          && existing.sourceUpdatedAt === nextSourceUpdatedAt) {
          return { action: 'unchanged', post: existing, change: null };
        }
        db.prepare(`
          UPDATE social_posts
          SET deleted_at = ?, source_updated_at = ?, updated_at = ?
          WHERE id = ?
        `).run(nextDeletedAt, nextSourceUpdatedAt, timestamp, existing.id);
        const post = postFromRow(db.prepare('SELECT * FROM social_posts WHERE id = ?').get(existing.id));
        const newlyDeleted = !existing.deleted;
        const type = newlyDeleted ? 'post.deleted' : 'post.updated';
        return {
          action: newlyDeleted ? 'deleted' : 'updated',
          post,
          change: recordChange(type, 'post', post.id, post, timestamp)
        };
      });
    },
    listPosts({
      limit = 50,
      before = null,
      afterUpdatedAt = null,
      sources = [],
      feedSource = null,
      query = '',
      includeDeleted = true,
      watchlistOnly = false
    } = {}) {
      const where = [];
      const params = [];
      if (before !== null) {
        where.push('published_at < ?');
        params.push(Number(before));
      }
      if (afterUpdatedAt !== null) {
        where.push('updated_at > ?');
        params.push(Number(afterUpdatedAt));
      }
      const normalizedSources = [...new Set(sources.map((source) => normalizeSocialSource(source)).filter(Boolean))];
      if (normalizedSources.length) {
        where.push(`source IN (${normalizedSources.map(() => '?').join(', ')})`);
        params.push(...normalizedSources);
      }
      if (feedSource) {
        const [normalizedFeedSource] = normalizeFeedSources(feedSource, { defaultSource: null });
        if (!normalizedFeedSource) throw new TypeError('Unsupported social feed source');
        if (normalizedFeedSource !== 'all') {
          where.push(`EXISTS (
            SELECT 1 FROM json_each(social_posts.feed_sources_json)
            WHERE json_each.value = ?
          )`);
          params.push(normalizedFeedSource);
        }
      }
      if (watchlistOnly) {
        where.push(`EXISTS (
          SELECT 1 FROM social_watchlist AS watched
          WHERE watched.desired_state = 'active'
            AND watched.platform = social_posts.source
            AND (
              lower(watched.account_key) = lower(social_posts.author_handle)
              OR lower(watched.handle) = lower(social_posts.author_handle)
            )
            AND EXISTS (
              SELECT 1
              FROM json_each(
                CASE
                  WHEN json_valid(watched.event_types_json) THEN watched.event_types_json
                  ELSE ?
                END
              ) AS selected_event
              WHERE selected_event.value = CASE
                WHEN social_posts.deleted_at IS NOT NULL THEN 'delete'
                WHEN social_posts.kind != 'profile' THEN social_posts.kind
                ELSE NULL
              END
              OR (
                social_posts.deleted_at IS NULL
                AND social_posts.kind = 'profile'
                AND selected_event.value IN (
                  SELECT 'profile_' || profile_change.value
                  FROM json_each(
                    CASE
                      WHEN json_valid(social_posts.profile_json) THEN social_posts.profile_json
                      ELSE '{"changes":[]}'
                    END,
                    '$.changes'
                  ) AS profile_change
                  WHERE profile_change.value IN ('name', 'avatar', 'bio')
                )
              )
            )
        )`);
        params.push(json(SOCIAL_WATCH_EVENT_TYPES));
      }
      if (!includeDeleted) where.push('deleted_at IS NULL');
      if (query) {
        where.push('(content LIKE ? OR translated_content LIKE ? OR author_handle LIKE ? OR author_name LIKE ? OR target_json LIKE ?)');
        const pattern = `%${String(query).slice(0, 200)}%`;
        params.push(pattern, pattern, pattern, pattern, pattern);
      }
      params.push(Math.min(500, Math.max(1, Math.floor(Number(limit) || 50))));
      return db.prepare(`
        SELECT * FROM social_posts
        ${where.length ? `WHERE ${where.join(' AND ')}` : ''}
        ORDER BY published_at DESC, id DESC
        LIMIT ?
      `).all(...params).map(postFromRow);
    },
    getPost(source, externalId) {
      return postFromRow(db.prepare('SELECT * FROM social_posts WHERE source = ? AND external_id = ?')
        .get(normalizeSocialSource(source), String(externalId)));
    },
    listPostsForTranslation({ beforeId = null, limit = 100 } = {}) {
      const numericBeforeId = beforeId === null ? null : Number(beforeId);
      if (numericBeforeId !== null && (!Number.isSafeInteger(numericBeforeId) || numericBeforeId < 1)) {
        throw new TypeError('Invalid social translation cursor');
      }
      const boundedLimit = Math.min(250, Math.max(1, Math.floor(Number(limit) || 100)));
      return db.prepare(`
        SELECT *
        FROM social_posts
        WHERE (? IS NULL OR id < ?)
          AND EXISTS (
            SELECT 1
            FROM social_watchlist AS watched
            WHERE watched.desired_state = 'active'
              AND watched.platform = social_posts.source
              AND (
                lower(watched.account_key) = lower(social_posts.author_handle)
                OR lower(watched.handle) = lower(social_posts.author_handle)
              )
          )
        ORDER BY id DESC
        LIMIT ?
      `).all(numericBeforeId, numericBeforeId, boundedLimit).map(postFromRow);
    },
    getSocialTranslation(sourceHash, sourceLength, model) {
      const hash = String(sourceHash || '').trim().toLowerCase();
      const length = Number(sourceLength);
      const selectedModel = String(model || '').trim();
      if (!/^[a-f0-9]{64}$/.test(hash)
        || !Number.isSafeInteger(length) || length < 1
        || !selectedModel) return '';
      const row = db.prepare(`
        SELECT translated_content
        FROM social_translation_cache
        WHERE source_hash = ? AND source_length = ? AND model = ?
      `).get(hash, length, selectedModel);
      if (!row?.translated_content) return '';
      db.prepare(`
        UPDATE social_translation_cache SET updated_at = ?
        WHERE source_hash = ? AND model = ?
      `).run(now(), hash, selectedModel);
      return String(row.translated_content);
    },
    putSocialTranslation(sourceHash, sourceLength, model, translatedContent) {
      const hash = String(sourceHash || '').trim().toLowerCase();
      const length = Number(sourceLength);
      const selectedModel = String(model || '').trim().slice(0, 120);
      const translated = String(translatedContent || '').trim().slice(0, 100_000);
      if (!/^[a-f0-9]{64}$/.test(hash)
        || !Number.isSafeInteger(length) || length < 1
        || !selectedModel || !translated) return false;
      const timestamp = now();
      db.prepare(`
        INSERT INTO social_translation_cache(
          source_hash, source_length, model, translated_content, created_at, updated_at
        ) VALUES (?, ?, ?, ?, ?, ?)
        ON CONFLICT(source_hash, model) DO UPDATE SET
          source_length = excluded.source_length,
          translated_content = excluded.translated_content,
          updated_at = excluded.updated_at
      `).run(hash, length, selectedModel, translated, timestamp, timestamp);
      return true;
    },
    addWatchAccounts(inputs) {
      if (!Array.isArray(inputs)) throw new TypeError('accounts must be an array');
      const timestamp = now();
      return transaction(db, () => inputs.map((input) => addWatchAccount(input, timestamp)));
    },
    updateWatchAccountPreferences,
    updateWatchAccountEventTypes(id, eventTypes) {
      return updateWatchAccountPreferences(id, { eventTypes });
    },
    removeWatchAccount(id) {
      const numericId = Number(id);
      if (!Number.isSafeInteger(numericId) || numericId < 1) throw new TypeError('Invalid watchlist id');
      const timestamp = now();
      return transaction(db, () => {
        const existing = db.prepare('SELECT * FROM social_watchlist WHERE id = ?').get(numericId);
        if (!existing) return null;
        if (existing.desired_state === 'removed' && existing.sync_status === 'synced') {
          return { entry: watchlistFromRow(existing), command: null, change: null, changed: false };
        }
        const localOnly = existing.platform === 'fomo';
        db.prepare(`
          UPDATE social_watchlist
          SET desired_state = 'removed', sync_status = ?, last_synced_at = ?, last_error = '', updated_at = ?
          WHERE id = ?
        `).run(localOnly ? 'synced' : 'pending', localOnly ? timestamp : existing.last_synced_at, timestamp, numericId);
        const row = db.prepare('SELECT * FROM social_watchlist WHERE id = ?').get(numericId);
        const entry = watchlistFromRow(row);
        const command = localOnly ? null : queueWatchlistCommand(row, 'watchlist.delete', timestamp);
        const change = recordChange('watchlist.updated', 'watchlist', numericId, entry, timestamp);
        return { entry, command, change, changed: true };
      });
    },
    listWatchlist({ includeRemoved = false, platform = null } = {}) {
      const where = [];
      const params = [];
      if (!includeRemoved) where.push("desired_state = 'active'");
      if (platform) {
        where.push('platform = ?');
        params.push(normalizeSocialSource(platform));
      }
      return db.prepare(`
        SELECT * FROM social_watchlist
        ${where.length ? `WHERE ${where.join(' AND ')}` : ''}
        ORDER BY desired_state, created_at, id
      `).all(...params).map(watchlistFromRow);
    },
    upsertDeBotWalletSync(address, note = '', { force = false } = {}) {
      const normalized = String(address || '').trim().toLowerCase();
      if (!/^0x[0-9a-f]{40}$/.test(normalized)) throw new TypeError('Invalid DeBot wallet address');
      const normalizedNote = String(note || '').trim().slice(0, 500);
      const timestamp = now();
      return transaction(db, () => {
        const existing = db.prepare('SELECT * FROM debot_wallet_sync WHERE address = ?').get(normalized);
        if (!force && existing && existing.desired_state === 'active' && existing.note === normalizedNote
          && ['pending', 'synced'].includes(existing.sync_status)) {
          return { entry: deBotWalletSyncFromRow(existing), command: null, changed: false };
        }
        db.prepare(`
          INSERT INTO debot_wallet_sync(address, note, desired_state, sync_status, last_error, updated_at)
          VALUES (?, ?, 'active', 'pending', '', ?)
          ON CONFLICT(address) DO UPDATE SET note = excluded.note, desired_state = 'active',
            sync_status = 'pending', last_error = '', updated_at = excluded.updated_at
        `).run(normalized, normalizedNote, timestamp);
        const row = db.prepare('SELECT * FROM debot_wallet_sync WHERE address = ?').get(normalized);
        return {
          entry: deBotWalletSyncFromRow(row),
          command: queueDeBotWalletCommand(row, 'wallet.watch.upsert', timestamp),
          changed: true
        };
      });
    },
    removeDeBotWalletSync(address) {
      const normalized = String(address || '').trim().toLowerCase();
      if (!/^0x[0-9a-f]{40}$/.test(normalized)) throw new TypeError('Invalid DeBot wallet address');
      const timestamp = now();
      return transaction(db, () => {
        const existing = db.prepare('SELECT * FROM debot_wallet_sync WHERE address = ?').get(normalized);
        if (existing?.desired_state === 'removed' && ['pending', 'synced'].includes(existing.sync_status)) {
          return { entry: deBotWalletSyncFromRow(existing), command: null, changed: false };
        }
        db.prepare(`
          INSERT INTO debot_wallet_sync(address, note, desired_state, sync_status, last_error, updated_at)
          VALUES (?, '', 'removed', 'pending', '', ?)
          ON CONFLICT(address) DO UPDATE SET desired_state = 'removed', sync_status = 'pending',
            last_error = '', updated_at = excluded.updated_at
        `).run(normalized, timestamp);
        const row = db.prepare('SELECT * FROM debot_wallet_sync WHERE address = ?').get(normalized);
        return {
          entry: deBotWalletSyncFromRow(row),
          command: queueDeBotWalletCommand(row, 'wallet.watch.delete', timestamp),
          changed: true
        };
      });
    },
    recordRemoteDeBotWallet(address, note = '', expectedNote = '') {
      const normalized = String(address || '').trim().toLowerCase();
      if (!/^0x[0-9a-f]{40}$/.test(normalized)) throw new TypeError('Invalid DeBot wallet address');
      const normalizedNote = String(note || '').trim().slice(0, 500);
      const normalizedExpectedNote = String(expectedNote || '').trim().slice(0, 500);
      const timestamp = now();
      return transaction(db, () => {
        const existing = db.prepare('SELECT * FROM debot_wallet_sync WHERE address = ?').get(normalized);
        if (existing?.desired_state === 'removed') return deBotWalletSyncFromRow(existing);
        const effectiveNote = normalizedExpectedNote
          || normalizedNote
          || String(existing?.note || '').trim().slice(0, 500);
        const remoteMatches = !normalizedExpectedNote || normalizedNote === normalizedExpectedNote;
        db.prepare(`
          INSERT INTO debot_wallet_sync(
            address, note, desired_state, sync_status, last_error, last_synced_at, updated_at
          ) VALUES (?, ?, 'active', ?, '', ?, ?)
          ON CONFLICT(address) DO UPDATE SET note = excluded.note, desired_state = 'active',
            sync_status = excluded.sync_status, last_error = '', last_synced_at = excluded.last_synced_at,
            updated_at = excluded.updated_at
        `).run(
          normalized,
          effectiveNote,
          remoteMatches ? 'synced' : 'pending',
          remoteMatches ? timestamp : existing?.last_synced_at || 0,
          timestamp
        );
        const row = db.prepare('SELECT * FROM debot_wallet_sync WHERE address = ?').get(normalized);
        if (!remoteMatches) queueDeBotWalletCommand(row, 'wallet.watch.upsert', timestamp);
        return deBotWalletSyncFromRow(row);
      });
    },
    listDeBotWalletSync({ includeRemoved = true } = {}) {
      return db.prepare(`
        SELECT * FROM debot_wallet_sync
        ${includeRemoved ? '' : "WHERE desired_state = 'active'"}
        ORDER BY updated_at, address
      `).all().map(deBotWalletSyncFromRow);
    },
    claimCommands({ limit = 50, leaseMs = 30_000 } = {}) {
      const timestamp = now();
      return transaction(db, () => {
        db.prepare(`
          UPDATE social_commands SET status = 'pending', claimed_at = NULL
          WHERE status = 'claimed' AND claimed_at < ?
        `).run(timestamp - leaseMs);
        const rows = db.prepare(`
          SELECT candidate.*
          FROM social_commands AS candidate
          WHERE candidate.status = 'pending'
            AND NOT EXISTS (
              SELECT 1
              FROM social_commands AS earlier
              WHERE (
                  (earlier.watchlist_id = candidate.watchlist_id)
                  OR (
                    earlier.watchlist_id IS NULL AND candidate.watchlist_id IS NULL
                    AND lower(json_extract(earlier.payload_json, '$.address')) = lower(json_extract(candidate.payload_json, '$.address'))
                  )
                )
                AND earlier.id < candidate.id
                AND earlier.status = 'claimed'
            )
          ORDER BY candidate.id
          LIMIT ?
        `).all(Math.min(200, Math.max(1, Number(limit) || 50)));
        const claim = db.prepare(`
          UPDATE social_commands SET status = 'claimed', claimed_at = ?, attempts = attempts + 1
          WHERE id = ? AND status = 'pending'
        `);
        const claimed = [];
        for (const row of rows) {
          const result = claim.run(timestamp, row.id);
          if (Number(result.changes) > 0) {
            claimed.push(commandFromRow(db.prepare('SELECT * FROM social_commands WHERE id = ?').get(row.id)));
          }
        }
        return claimed;
      });
    },
    acknowledgeCommand(id, {
      success,
      error = '',
      remoteId = '',
      verifiedAbsent = false
    } = {}) {
      const numericId = Number(id);
      if (!Number.isSafeInteger(numericId) || numericId < 1) throw new TypeError('Invalid command id');
      if (typeof success !== 'boolean') throw new TypeError('success must be a boolean');
      const timestamp = now();
      return transaction(db, () => {
        const row = db.prepare('SELECT * FROM social_commands WHERE id = ?').get(numericId);
        if (!row) return null;
        if (['completed', 'failed', 'cancelled'].includes(row.status)) return commandFromRow(row);
        const confirmedSuccess = success
          && (row.command_type !== 'watchlist.delete' || verifiedAbsent === true);
        const resolvedError = success && !confirmedSuccess
          ? 'Bridge did not verify that the deleted account is absent'
          : String(error || '');
        db.prepare(`
          UPDATE social_commands SET status = ?, completed_at = ?, last_error = ? WHERE id = ?
        `).run(
          confirmedSuccess ? 'completed' : 'failed',
          timestamp,
          resolvedError.slice(0, 2_000),
          numericId
        );
        if (row.watchlist_id !== null) {
          const watch = db.prepare('SELECT * FROM social_watchlist WHERE id = ?').get(row.watchlist_id);
          const expectedState = row.command_type === 'watchlist.add' ? 'active' : 'removed';
          if (watch && watch.desired_state === expectedState) {
            db.prepare(`
              UPDATE social_watchlist SET
                sync_status = ?, last_synced_at = ?, last_error = ?, remote_id = CASE WHEN ? != '' THEN ? ELSE remote_id END,
                updated_at = ?
              WHERE id = ?
            `).run(
              confirmedSuccess ? 'synced' : 'failed',
              confirmedSuccess ? timestamp : watch.last_synced_at,
              confirmedSuccess ? '' : String(resolvedError || 'Bridge rejected the command').slice(0, 2_000),
              String(remoteId || ''),
              String(remoteId || ''),
              timestamp,
              row.watchlist_id
            );
            const entry = watchlistFromRow(db.prepare('SELECT * FROM social_watchlist WHERE id = ?').get(row.watchlist_id));
            recordChange('watchlist.updated', 'watchlist', row.watchlist_id, entry, timestamp);
          }
        } else if (['wallet.watch.upsert', 'wallet.watch.delete'].includes(row.command_type)) {
          const payload = parseJson(row.payload_json, {});
          const address = String(payload.address || '').toLowerCase();
          const wallet = db.prepare('SELECT * FROM debot_wallet_sync WHERE address = ?').get(address);
          const expectedState = row.command_type === 'wallet.watch.upsert' ? 'active' : 'removed';
          const walletConfirmed = confirmedSuccess
            && (row.command_type !== 'wallet.watch.delete' || verifiedAbsent === true);
          if (wallet && wallet.desired_state === expectedState) {
            db.prepare(`
              UPDATE debot_wallet_sync SET sync_status = ?, last_synced_at = ?, last_error = ?, updated_at = ?
              WHERE address = ?
            `).run(
              walletConfirmed ? 'synced' : 'failed',
              walletConfirmed ? timestamp : wallet.last_synced_at,
              walletConfirmed ? '' : String(resolvedError || 'Bridge rejected the wallet command').slice(0, 2_000),
              timestamp,
              address
            );
          }
        }
        return commandFromRow(db.prepare('SELECT * FROM social_commands WHERE id = ?').get(numericId));
      });
    },
    getDeBotJob(id) {
      const numericId = Number(id);
      if (!Number.isSafeInteger(numericId) || numericId < 1) throw new TypeError('Invalid DeBot job id');
      return debotJobFromRow(db.prepare('SELECT * FROM debot_bridge_jobs WHERE id = ?').get(numericId));
    },
    getCachedDeBotResult(requestKey) {
      const key = String(requestKey || '');
      if (!key) throw new TypeError('A DeBot request key is required');
      const timestamp = now();
      const row = db.prepare(`
        SELECT * FROM debot_bridge_jobs
        WHERE request_key = ? AND status = 'completed' AND cache_expires_at > ?
        ORDER BY cache_expires_at DESC, id DESC
        LIMIT 1
      `).get(key, timestamp);
      return debotJobFromRow(row);
    },
    enqueueDeBotJob({
      requestKey,
      type,
      payload,
      deadlineAt,
      cacheTtlMs,
      pendingCap = 256
    } = {}) {
      const key = String(requestKey || '');
      if (!key) throw new TypeError('A DeBot request key is required');
      const jobType = String(type || '');
      if (!jobType) throw new TypeError('A DeBot job type is required');
      const deadline = Number(deadlineAt);
      if (!Number.isSafeInteger(deadline)) throw new TypeError('A valid DeBot deadline is required');
      const ttl = Math.max(0, Math.floor(Number(cacheTtlMs) || 0));
      const cap = Math.max(1, Math.floor(Number(pendingCap) || 256));
      const timestamp = now();
      return transaction(db, () => {
        db.prepare(`
          UPDATE debot_bridge_jobs
          SET status = 'expired', completed_at = ?, updated_at = ?, claim_token = '',
              error_code = 'DEADLINE', error_message = 'DeBot bridge request expired'
          WHERE status IN ('pending', 'claimed') AND deadline_at <= ?
        `).run(timestamp, timestamp, timestamp);

        const cached = db.prepare(`
          SELECT * FROM debot_bridge_jobs
          WHERE request_key = ? AND status = 'completed' AND cache_expires_at > ?
          ORDER BY cache_expires_at DESC, id DESC
          LIMIT 1
        `).get(key, timestamp);
        if (cached) return { state: 'cached', job: debotJobFromRow(cached) };

        const inflight = db.prepare(`
          SELECT * FROM debot_bridge_jobs
          WHERE request_key = ? AND status IN ('pending', 'claimed') AND deadline_at > ?
          ORDER BY id DESC
          LIMIT 1
        `).get(key, timestamp);
        if (inflight) {
          if (deadline > Number(inflight.deadline_at) || ttl > Number(inflight.cache_expires_at || 0)) {
            db.prepare(`
              UPDATE debot_bridge_jobs
              SET deadline_at = MAX(deadline_at, ?), cache_expires_at = MAX(cache_expires_at, ?), updated_at = ?
              WHERE id = ?
            `).run(deadline, ttl, timestamp, inflight.id);
          }
          return {
            state: 'inflight',
            job: debotJobFromRow(db.prepare('SELECT * FROM debot_bridge_jobs WHERE id = ?').get(inflight.id))
          };
        }

        const pending = Number(db.prepare(`
          SELECT COUNT(*) AS count FROM debot_bridge_jobs WHERE status IN ('pending', 'claimed')
        `).get().count || 0);
        if (pending >= cap) return { state: 'full', job: null };

        const result = db.prepare(`
          INSERT INTO debot_bridge_jobs(
            request_key, job_type, payload_json, status, created_at, updated_at,
            deadline_at, cache_expires_at
          ) VALUES (?, ?, ?, 'pending', ?, ?, ?, ?)
        `).run(key, jobType, json(payload), timestamp, timestamp, deadline, ttl);
        const job = debotJobFromRow(
          db.prepare('SELECT * FROM debot_bridge_jobs WHERE id = ?').get(Number(result.lastInsertRowid))
        );
        return { state: 'created', job };
      });
    },
    claimDeBotJobs({ limit = 4, leaseMs = 120_000, createClaimToken, types = null } = {}) {
      if (typeof createClaimToken !== 'function') throw new TypeError('A DeBot claim-token factory is required');
      const timestamp = now();
      const boundedLimit = Math.min(32, Math.max(1, Math.floor(Number(limit) || 4)));
      const lease = Math.max(1_000, Math.floor(Number(leaseMs) || 120_000));
      const allowedTypes = types === null
        ? null
        : [...new Set((Array.isArray(types) ? types : []).map((type) => String(type || '').trim()).filter(Boolean))];
      if (allowedTypes !== null && !allowedTypes.length) return [];
      return transaction(db, () => {
        db.prepare(`
          UPDATE debot_bridge_jobs
          SET status = 'expired', completed_at = ?, updated_at = ?, claim_token = '',
              error_code = 'DEADLINE', error_message = 'DeBot bridge request expired'
          WHERE status IN ('pending', 'claimed') AND deadline_at <= ?
        `).run(timestamp, timestamp, timestamp);
        db.prepare(`
          UPDATE debot_bridge_jobs
          SET status = 'pending', claimed_at = NULL, lease_expires_at = NULL,
              claim_token = '', updated_at = ?
          WHERE status = 'claimed' AND lease_expires_at <= ? AND deadline_at > ?
        `).run(timestamp, timestamp, timestamp);
        const typeFilter = allowedTypes === null
          ? ''
          : ` AND job_type IN (${allowedTypes.map(() => '?').join(', ')})`;
        const rows = db.prepare(`
          SELECT * FROM debot_bridge_jobs
          WHERE status = 'pending' AND deadline_at > ?${typeFilter}
          ORDER BY id
          LIMIT ?
        `).all(timestamp, ...(allowedTypes || []), boundedLimit);
        const claimed = [];
        const claim = db.prepare(`
          UPDATE debot_bridge_jobs
          SET status = 'claimed', attempts = attempts + 1, claim_token = ?, claimed_at = ?,
              lease_expires_at = ?, updated_at = ?
          WHERE id = ? AND status = 'pending'
        `);
        for (const row of rows) {
          const claimToken = String(createClaimToken() || '');
          if (!claimToken || claimToken.length > 240) throw new TypeError('Invalid DeBot claim token');
          const result = claim.run(claimToken, timestamp, timestamp + lease, timestamp, row.id);
          if (Number(result.changes) > 0) {
            claimed.push(debotJobFromRow(db.prepare('SELECT * FROM debot_bridge_jobs WHERE id = ?').get(row.id)));
          }
        }
        return claimed;
      });
    },
    acknowledgeDeBotJob(id, {
      claimToken,
      success,
      result = null,
      errorCode = '',
      errorMessage = ''
    } = {}) {
      const numericId = Number(id);
      if (!Number.isSafeInteger(numericId) || numericId < 1) throw new TypeError('Invalid DeBot job id');
      if (typeof success !== 'boolean') throw new TypeError('success must be a boolean');
      const token = String(claimToken || '');
      if (!token) throw new TypeError('A DeBot claim token is required');
      const timestamp = now();
      return transaction(db, () => {
        const row = db.prepare('SELECT * FROM debot_bridge_jobs WHERE id = ?').get(numericId);
        if (!row) return { state: 'not_found', job: null };
        if (row.claim_token !== token) return { state: 'claim_mismatch', job: debotJobFromRow(row) };
        if (['completed', 'failed'].includes(row.status)) {
          return { state: 'terminal', job: debotJobFromRow(row) };
        }
        if (
          row.status !== 'claimed' ||
          Number(row.lease_expires_at || 0) <= timestamp ||
          Number(row.deadline_at) <= timestamp
        ) {
          return { state: 'claim_expired', job: debotJobFromRow(row) };
        }
        const cacheTtlMs = Math.max(0, Number(row.cache_expires_at || 0));
        db.prepare(`
          UPDATE debot_bridge_jobs SET
            status = ?, result_json = ?, error_code = ?, error_message = ?, completed_at = ?,
            cache_expires_at = ?, updated_at = ?
          WHERE id = ? AND status = 'claimed' AND claim_token = ?
        `).run(
          success ? 'completed' : 'failed',
          success ? json(result) : null,
          success ? '' : String(errorCode || 'DEBOT').slice(0, 80),
          success ? '' : String(errorMessage || 'DeBot browser bridge request failed').slice(0, 240),
          timestamp,
          success && cacheTtlMs > 0 ? timestamp + cacheTtlMs : null,
          timestamp,
          numericId,
          token
        );
        return {
          state: success ? 'completed' : 'failed',
          job: debotJobFromRow(db.prepare('SELECT * FROM debot_bridge_jobs WHERE id = ?').get(numericId))
        };
      });
    },
    reconcileRemoteWatchlist(inputs, snapshotMetadata = {}) {
      if (!Array.isArray(inputs)) throw new TypeError('accounts must be an array');
      const snapshotVersion = normalizeWatchlistSnapshotVersion(snapshotMetadata);
      const timestamp = now();
      return transaction(db, () => {
        const currentBridgeState = db.prepare('SELECT * FROM social_bridge_state WHERE singleton = 1').get();
        const currentSessionId = String(currentBridgeState?.snapshot_session_id || '');
        const currentSessionStartedAt = Number(currentBridgeState?.snapshot_session_started_at || 0);
        const currentRevision = Number(currentBridgeState?.snapshot_revision || 0);
        if (!snapshotVersion && currentSessionId && currentSessionStartedAt > 0 && currentRevision > 0) {
          return {
            entries: db.prepare('SELECT * FROM social_watchlist ORDER BY desired_state, created_at, id')
              .all()
              .map(watchlistFromRow),
            changes: [],
            snapshot: {
              accepted: false,
              versioned: false,
              reason: 'legacy-snapshot-after-versioned-session'
            }
          };
        }
        if (snapshotVersion) {
          let rejectionReason = '';
          if (currentSessionStartedAt > snapshotVersion.sessionStartedAt) {
            rejectionReason = 'older-snapshot-session';
          } else if (currentSessionStartedAt === snapshotVersion.sessionStartedAt && currentSessionId) {
            if (currentSessionId !== snapshotVersion.sessionId) rejectionReason = 'snapshot-session-conflict';
            else if (currentRevision >= snapshotVersion.revision) rejectionReason = 'stale-snapshot-revision';
          }
          if (rejectionReason) {
            return {
              entries: db.prepare('SELECT * FROM social_watchlist ORDER BY desired_state, created_at, id')
                .all()
                .map(watchlistFromRow),
              changes: [],
              snapshot: {
                accepted: false,
                versioned: true,
                reason: rejectionReason,
                sessionId: snapshotVersion.sessionId,
                sessionStartedAt: snapshotVersion.sessionStartedAt,
                revision: snapshotVersion.revision
              }
            };
          }
          db.prepare(`
            INSERT INTO social_bridge_state(
              singleton, snapshot_session_id, snapshot_session_started_at, snapshot_revision, updated_at
            ) VALUES (1, ?, ?, ?, ?)
            ON CONFLICT(singleton) DO UPDATE SET
              snapshot_session_id = excluded.snapshot_session_id,
              snapshot_session_started_at = excluded.snapshot_session_started_at,
              snapshot_revision = excluded.snapshot_revision,
              updated_at = excluded.updated_at
          `).run(
            snapshotVersion.sessionId,
            snapshotVersion.sessionStartedAt,
            snapshotVersion.revision,
            timestamp
          );
        }
        // DeBot owns the remote X watchlist only. Local FOMO entries must never
        // be created, removed, or acknowledged by an X snapshot reconciliation.
        const normalized = inputs.map((input) => normalizeWatchAccount(input))
          .filter((account) => account.platform !== 'fomo');
        const remoteKeys = new Set(normalized.map((account) => `${account.platform}:${account.accountKey}`));
        const changes = [];
        for (const account of normalized) {
          const existing = db.prepare('SELECT * FROM social_watchlist WHERE platform = ? AND account_key = ?')
            .get(account.platform, account.accountKey);
          if (existing?.desired_state === 'removed') {
            const removedAt = Number(existing.last_synced_at || existing.updated_at || 0);
            if (existing.sync_status !== 'synced'
              || !snapshotVersion
              || removedAt >= snapshotVersion.sessionStartedAt) {
              continue;
            }
          }
          const result = addWatchAccount(account, timestamp, {
            origin: 'remote',
            synced: true,
            preserveLocalPreferences: true
          });
          if (result.change) changes.push(result.change);
        }
        const activeRows = db.prepare("SELECT * FROM social_watchlist WHERE desired_state = 'active'").all();
        for (const row of activeRows) {
          if (row.platform === 'fomo') continue;
          if (remoteKeys.has(`${row.platform}:${row.account_key}`)) continue;
          if (row.sync_status !== 'synced') continue;
          const pendingAdd = db.prepare(`
            SELECT id FROM social_commands
            WHERE watchlist_id = ? AND command_type = 'watchlist.add' AND status IN ('pending', 'claimed')
            LIMIT 1
          `).get(row.id);
          if (pendingAdd) continue;
          db.prepare(`
            UPDATE social_watchlist
            SET desired_state = 'removed', sync_status = 'synced', last_synced_at = ?, last_error = '',
                origin = 'remote', updated_at = ?
            WHERE id = ?
          `).run(timestamp, timestamp, row.id);
          const entry = watchlistFromRow(db.prepare('SELECT * FROM social_watchlist WHERE id = ?').get(row.id));
          changes.push(recordChange('watchlist.updated', 'watchlist', row.id, entry, timestamp));
        }
        const removedRows = db.prepare("SELECT * FROM social_watchlist WHERE desired_state = 'removed'").all();
        for (const row of removedRows) {
          if (row.platform === 'fomo') continue;
          if (remoteKeys.has(`${row.platform}:${row.account_key}`)) continue;
          if (row.sync_status === 'synced') continue;
          db.prepare(`
            UPDATE social_watchlist
            SET sync_status = 'synced', last_synced_at = ?, last_error = '', updated_at = ?
            WHERE id = ?
          `).run(timestamp, timestamp, row.id);
          db.prepare(`
            UPDATE social_commands
            SET status = 'completed', completed_at = ?, last_error = ''
            WHERE watchlist_id = ? AND command_type = 'watchlist.delete' AND status IN ('pending', 'claimed')
          `).run(timestamp, row.id);
          const entry = watchlistFromRow(db.prepare('SELECT * FROM social_watchlist WHERE id = ?').get(row.id));
          changes.push(recordChange('watchlist.updated', 'watchlist', row.id, entry, timestamp));
        }
        return {
          entries: db.prepare('SELECT * FROM social_watchlist ORDER BY desired_state, created_at, id')
            .all()
            .map(watchlistFromRow),
          changes,
          snapshot: snapshotVersion
            ? {
                accepted: true,
                versioned: true,
                reason: '',
                sessionId: snapshotVersion.sessionId,
                sessionStartedAt: snapshotVersion.sessionStartedAt,
                revision: snapshotVersion.revision
              }
            : { accepted: true, versioned: false, reason: 'legacy-unversioned' }
        };
      });
    },
    recordBridgeHeartbeat({ bridgeId = '', version = '', capabilities = [], sessionId = '', diagnostics } = {}) {
      const timestamp = now();
      const sanitizedDiagnostics = bridgeDiagnosticsFromInput(diagnostics);
      const heartbeatValues = [
        String(bridgeId || '').slice(0, 240),
        String(version || '').slice(0, 120),
        json(Array.isArray(capabilities) ? capabilities.slice(0, 50).map(String) : []),
        String(sessionId || '').slice(0, 240),
        timestamp,
        timestamp
      ];
      if (sanitizedDiagnostics) {
        db.prepare(`
          INSERT INTO social_bridge_state(
            singleton, bridge_id, version, capabilities_json, session_id, diagnostics_json, last_seen_at, updated_at
          ) VALUES (1, ?, ?, ?, ?, ?, ?, ?)
          ON CONFLICT(singleton) DO UPDATE SET
            bridge_id = excluded.bridge_id,
            version = excluded.version,
            capabilities_json = excluded.capabilities_json,
            session_id = excluded.session_id,
            diagnostics_json = excluded.diagnostics_json,
            last_seen_at = excluded.last_seen_at,
            updated_at = excluded.updated_at
        `).run(
          ...heartbeatValues.slice(0, 4),
          json(sanitizedDiagnostics),
          ...heartbeatValues.slice(4)
        );
      } else {
        db.prepare(`
          INSERT INTO social_bridge_state(
            singleton, bridge_id, version, capabilities_json, session_id, last_seen_at, updated_at
          ) VALUES (1, ?, ?, ?, ?, ?, ?)
          ON CONFLICT(singleton) DO UPDATE SET
            bridge_id = excluded.bridge_id,
            version = excluded.version,
            capabilities_json = excluded.capabilities_json,
            session_id = excluded.session_id,
            last_seen_at = excluded.last_seen_at,
            updated_at = excluded.updated_at
        `).run(...heartbeatValues);
      }
      return this.getBridgeState();
    },
    getBridgeState() {
      const row = db.prepare('SELECT * FROM social_bridge_state WHERE singleton = 1').get();
      if (!row) {
        return {
          bridgeId: '',
          version: '',
          capabilities: [],
          sessionId: '',
          snapshotSessionId: '',
          snapshotSessionStartedAt: 0,
          snapshotRevision: 0,
          diagnostics: bridgeDiagnosticsDefaults(),
          lastSeenAt: null
        };
      }
      return {
        bridgeId: row.bridge_id,
        version: row.version,
        capabilities: parseJson(row.capabilities_json, []),
        sessionId: row.session_id,
        snapshotSessionId: row.snapshot_session_id,
        snapshotSessionStartedAt: Number(row.snapshot_session_started_at || 0),
        snapshotRevision: Number(row.snapshot_revision || 0),
        diagnostics: bridgeDiagnosticsFromInput(parseJson(row.diagnostics_json, null)) || bridgeDiagnosticsDefaults(),
        lastSeenAt: row.last_seen_at === null ? null : Number(row.last_seen_at)
      };
    },
    listChanges({ after = 0, limit = 500 } = {}) {
      return db.prepare(`
        SELECT * FROM social_changes WHERE id > ? ORDER BY id LIMIT ?
      `).all(Math.max(0, Number(after) || 0), Math.min(1_000, Math.max(1, Number(limit) || 500))).map(changeFromRow);
    },
    getLatestChangeId() {
      return Number(db.prepare('SELECT COALESCE(MAX(id), 0) AS id FROM social_changes').get().id);
    },
    getCounts() {
      const posts = db.prepare(`
        SELECT COUNT(*) AS total, SUM(CASE WHEN deleted_at IS NOT NULL THEN 1 ELSE 0 END) AS deleted
        FROM social_posts
      `).get();
      const watchlist = db.prepare(`
        SELECT
          SUM(CASE WHEN desired_state = 'active' THEN 1 ELSE 0 END) AS active,
          SUM(CASE WHEN desired_state = 'active' AND sync_status != 'synced' THEN 1 ELSE 0 END) AS unsynced
        FROM social_watchlist
      `).get();
      const commands = db.prepare(`
        SELECT COUNT(*) AS pending FROM social_commands WHERE status IN ('pending', 'claimed')
      `).get();
      return {
        posts: Number(posts.total || 0),
        deletedPosts: Number(posts.deleted || 0),
        watchlist: Number(watchlist.active || 0),
        unsyncedWatchlist: Number(watchlist.unsynced || 0),
        pendingCommands: Number(commands.pending || 0)
      };
    },
    cleanup({ retentionDays = 7, debotTerminalRetentionMs = 60 * 60 * 1_000 } = {}) {
      const timestamp = now();
      const cutoff = timestamp - Math.max(1, Number(retentionDays) || 7) * 24 * 60 * 60 * 1_000;
      const debotCutoff = timestamp - Math.max(60_000, Number(debotTerminalRetentionMs) || 60 * 60 * 1_000);
      return transaction(db, () => {
        const posts = db.prepare('DELETE FROM social_posts WHERE published_at < ? AND updated_at < ?').run(cutoff, cutoff);
        const changes = db.prepare('DELETE FROM social_changes WHERE created_at < ?').run(cutoff);
        const commands = db.prepare(`
          DELETE FROM social_commands
          WHERE completed_at < ? AND status IN ('completed', 'failed', 'cancelled')
        `).run(cutoff);
        db.prepare(`
          UPDATE debot_bridge_jobs
          SET status = 'expired', completed_at = ?, updated_at = ?, claim_token = '',
              error_code = 'DEADLINE', error_message = 'DeBot bridge request expired'
          WHERE status IN ('pending', 'claimed') AND deadline_at <= ?
        `).run(timestamp, timestamp, timestamp);
        const debotJobs = db.prepare(`
          DELETE FROM debot_bridge_jobs
          WHERE status IN ('completed', 'failed', 'expired')
            AND completed_at < ?
            AND (cache_expires_at IS NULL OR cache_expires_at <= ?)
        `).run(debotCutoff, timestamp);
        const translations = db.prepare(`
          DELETE FROM social_translation_cache WHERE updated_at < ?
        `).run(timestamp - 90 * 24 * 60 * 60 * 1_000);
        return {
          cutoff,
          postsDeleted: Number(posts.changes),
          changesDeleted: Number(changes.changes),
          commandsDeleted: Number(commands.changes),
          debotJobsDeleted: Number(debotJobs.changes),
          translationsDeleted: Number(translations.changes)
        };
      });
    },
    close() {
      db.close();
    }
  };
}
