import fs from 'node:fs';
import path from 'node:path';
import { DatabaseSync } from 'node:sqlite';

import {
  normalizeFeedSources,
  normalizeSocialPost,
  normalizeSocialSource,
  normalizeWatchAccount
} from './normalize.js';

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

function postFromRow(row) {
  if (!row) return null;
  return {
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
    publishedAt: Number(row.published_at),
    receivedAt: Number(row.received_at),
    sourceUpdatedAt: Number(row.source_updated_at),
    deleted: row.deleted_at !== null,
    deletedAt: row.deleted_at === null ? null : Number(row.deleted_at),
    storedAt: Number(row.stored_at),
    updatedAt: Number(row.updated_at)
  };
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

function changeFromRow(row) {
  if (!row) return null;
  return {
    id: Number(row.id),
    type: row.event_type,
    entityType: row.entity_type,
    entityId: row.entity_id,
    data: parseJson(row.payload_json, {}),
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
    post.publishedAt,
    post.receivedAt,
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
      published_at INTEGER NOT NULL,
      received_at INTEGER NOT NULL,
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

    CREATE TABLE IF NOT EXISTS social_changes (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      event_type TEXT NOT NULL,
      entity_type TEXT NOT NULL,
      entity_id TEXT NOT NULL,
      payload_json TEXT NOT NULL,
      created_at INTEGER NOT NULL
    );
    CREATE INDEX IF NOT EXISTS social_changes_created_idx ON social_changes(created_at, id);

    CREATE TABLE IF NOT EXISTS social_bridge_state (
      singleton INTEGER PRIMARY KEY CHECK(singleton = 1),
      bridge_id TEXT NOT NULL DEFAULT '',
      version TEXT NOT NULL DEFAULT '',
      capabilities_json TEXT NOT NULL DEFAULT '[]',
      session_id TEXT NOT NULL DEFAULT '',
      last_seen_at INTEGER,
      updated_at INTEGER NOT NULL
    );
  `);

  const socialPostColumns = new Set(db.prepare('PRAGMA table_info(social_posts)').all().map((column) => column.name));
  if (!socialPostColumns.has('feed_sources_json')) {
    db.exec("ALTER TABLE social_posts ADD COLUMN feed_sources_json TEXT NOT NULL DEFAULT '[\"all\"]'");
  }

  const insertPost = db.prepare(`
    INSERT INTO social_posts(
      source, external_id, kind, author_id, author_handle, author_name, author_avatar_url,
      author_followers, content, translated_content, url, media_json, contract_addresses_json,
      chain_tags_json, feed_sources_json, reply_to_external_id, quoted_external_id, repost_external_id,
      published_at, received_at, source_updated_at, deleted_at, raw_json, stored_at, updated_at
    ) VALUES (${Array(25).fill('?').join(', ')})
  `);
  const updatePost = db.prepare(`
    UPDATE social_posts SET
      kind = ?, author_id = ?, author_handle = ?, author_name = ?, author_avatar_url = ?,
      author_followers = ?, content = ?, translated_content = ?, url = ?, media_json = ?,
      contract_addresses_json = ?, chain_tags_json = ?, feed_sources_json = ?, reply_to_external_id = ?,
      quoted_external_id = ?, repost_external_id = ?, published_at = ?, received_at = ?,
      source_updated_at = ?, deleted_at = ?, raw_json = ?, updated_at = ?
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
    const normalized = normalizeSocialPost(input, { now: timestamp });
    const existingRow = db.prepare('SELECT * FROM social_posts WHERE source = ? AND external_id = ?')
      .get(normalized.source, normalized.externalId);
    if (!existingRow) {
      const result = insertPost.run(...postValues(normalized, normalized.raw, timestamp));
      const post = postFromRow(db.prepare('SELECT * FROM social_posts WHERE id = ?').get(Number(result.lastInsertRowid)));
      const type = post.deleted ? 'post.deleted' : 'post.created';
      return { action: post.deleted ? 'deleted' : 'created', post, change: recordChange(type, 'post', post.id, post, timestamp) };
    }

    const existing = postFromRow(existingRow);
    const provided = normalized._provided;
    const mergedFeedSources = provided.has('feedSources')
      ? normalizeFeedSources([existing.feedSources, normalized.feedSources])
      : existing.feedSources;
    const feedSourcesChanged = json(mergedFeedSources) !== json(existing.feedSources);
    if (normalized.sourceUpdatedAt < existing.sourceUpdatedAt && !provided.has('deletedAt')) {
      if (!feedSourcesChanged) return { action: 'unchanged', post: existing, change: null };
      db.prepare(`
        UPDATE social_posts SET feed_sources_json = ?, updated_at = ? WHERE id = ?
      `).run(json(mergedFeedSources), timestamp, existing.id);
      const post = postFromRow(db.prepare('SELECT * FROM social_posts WHERE id = ?').get(existing.id));
      return {
        action: 'updated',
        post,
        change: recordChange('post.updated', 'post', post.id, post, timestamp)
      };
    }
    const choose = (name, current) => provided.has(name) ? normalized[name] : current;
    const merged = {
      ...normalized,
      kind: choose('kind', existing.kind),
      authorId: choose('authorId', existing.author.id),
      authorHandle: choose('authorHandle', existing.author.handle),
      authorName: choose('authorName', existing.author.name),
      authorAvatarUrl: choose('authorAvatarUrl', existing.author.avatarUrl),
      authorFollowers: choose('authorFollowers', existing.author.followers),
      content: choose('content', existing.content),
      translatedContent: choose('translatedContent', existing.translatedContent),
      url: choose('url', existing.url),
      media: choose('media', existing.media),
      contractAddresses: choose('contractAddresses', existing.contractAddresses),
      chainTags: choose('chainTags', existing.chainTags),
      feedSources: mergedFeedSources,
      replyToExternalId: choose('replyToExternalId', existing.replyToExternalId),
      quotedExternalId: choose('quotedExternalId', existing.quotedExternalId),
      repostExternalId: choose('repostExternalId', existing.repostExternalId),
      publishedAt: choose('publishedAt', existing.publishedAt),
      receivedAt: Math.min(existing.receivedAt, normalized.receivedAt),
      sourceUpdatedAt: Math.max(existing.sourceUpdatedAt, normalized.sourceUpdatedAt),
      deletedAt: choose('deletedAt', existing.deletedAt)
    };
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
      publishedAt: merged.publishedAt,
      receivedAt: merged.receivedAt,
      sourceUpdatedAt: merged.sourceUpdatedAt,
      deleted: merged.deletedAt !== null,
      deletedAt: merged.deletedAt
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
      merged.publishedAt,
      merged.receivedAt,
      merged.sourceUpdatedAt,
      merged.deletedAt,
      json(normalized.raw),
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
      remoteId: row.remote_id
    };
    const result = db.prepare(`
      INSERT INTO social_commands(command_type, watchlist_id, payload_json, status, created_at)
      VALUES (?, ?, ?, 'pending', ?)
    `).run(type, row.id, json(payload), timestamp);
    return commandFromRow(db.prepare('SELECT * FROM social_commands WHERE id = ?').get(Number(result.lastInsertRowid)));
  }

  function addWatchAccount(input, timestamp, { origin = 'local', synced = false } = {}) {
    const account = normalizeWatchAccount(input);
    const existing = db.prepare('SELECT * FROM social_watchlist WHERE platform = ? AND account_key = ?')
      .get(account.platform, account.accountKey);
    let id;
    let changed = false;
    if (!existing) {
      const result = db.prepare(`
        INSERT INTO social_watchlist(
          platform, account_key, handle, name, url, remote_id, metadata_json, desired_state,
          sync_status, origin, last_synced_at, created_at, updated_at
        ) VALUES (?, ?, ?, ?, ?, ?, ?, 'active', ?, ?, ?, ?, ?)
      `).run(
        account.platform,
        account.accountKey,
        account.handle,
        account.name,
        account.url,
        account.remoteId,
        json(account.metadata),
        synced ? 'synced' : 'pending',
        origin,
        synced ? timestamp : null,
        timestamp,
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
      const nextStatus = synced ? 'synced' : existing.desired_state === 'active' && existing.sync_status === 'synced'
        ? 'synced'
        : 'pending';
      changed = existing.desired_state !== 'active' || existing.handle !== account.handle ||
        existing.name !== nextName || existing.url !== nextUrl || existing.remote_id !== nextRemoteId ||
        existing.metadata_json !== json(nextMetadata) ||
        existing.sync_status !== nextStatus;
      if (changed) {
        db.prepare(`
          UPDATE social_watchlist SET
            handle = ?, name = ?, url = ?, remote_id = ?, metadata_json = ?, desired_state = 'active',
            sync_status = ?, origin = ?, last_synced_at = ?, last_error = '', updated_at = ?
          WHERE id = ?
        `).run(
          account.handle,
          nextName,
          nextUrl,
          nextRemoteId,
          json(nextMetadata),
          nextStatus,
          origin === 'remote' ? 'remote' : existing.origin,
          synced ? timestamp : existing.last_synced_at,
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

  return {
    db,
    upsertPosts(inputs) {
      if (!Array.isArray(inputs)) throw new TypeError('posts must be an array');
      const timestamp = now();
      return transaction(db, () => inputs.map((input) => applyPost(input, timestamp)));
    },
    deletePost(source, externalId, deletedAt = now()) {
      return transaction(db, () => applyPost({
        source: normalizeSocialSource(source),
        externalId,
        deleted: true,
        deletedAt,
        sourceUpdatedAt: deletedAt
      }, now()));
    },
    listPosts({
      limit = 50,
      before = null,
      afterUpdatedAt = null,
      sources = [],
      feedSource = null,
      query = '',
      includeDeleted = true
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
      if (!includeDeleted) where.push('deleted_at IS NULL');
      if (query) {
        where.push('(content LIKE ? OR translated_content LIKE ? OR author_handle LIKE ? OR author_name LIKE ?)');
        const pattern = `%${String(query).slice(0, 200)}%`;
        params.push(pattern, pattern, pattern, pattern);
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
    addWatchAccounts(inputs) {
      if (!Array.isArray(inputs)) throw new TypeError('accounts must be an array');
      const timestamp = now();
      return transaction(db, () => inputs.map((input) => addWatchAccount(input, timestamp)));
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
        db.prepare(`
          UPDATE social_watchlist
          SET desired_state = 'removed', sync_status = 'pending', last_error = '', updated_at = ?
          WHERE id = ?
        `).run(timestamp, numericId);
        const row = db.prepare('SELECT * FROM social_watchlist WHERE id = ?').get(numericId);
        const entry = watchlistFromRow(row);
        const command = queueWatchlistCommand(row, 'watchlist.delete', timestamp);
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
        ORDER BY desired_state, lower(handle), id
      `).all(...params).map(watchlistFromRow);
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
              WHERE earlier.watchlist_id = candidate.watchlist_id
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
    acknowledgeCommand(id, { success, error = '', remoteId = '' } = {}) {
      const numericId = Number(id);
      if (!Number.isSafeInteger(numericId) || numericId < 1) throw new TypeError('Invalid command id');
      if (typeof success !== 'boolean') throw new TypeError('success must be a boolean');
      const timestamp = now();
      return transaction(db, () => {
        const row = db.prepare('SELECT * FROM social_commands WHERE id = ?').get(numericId);
        if (!row) return null;
        if (['completed', 'failed', 'cancelled'].includes(row.status)) return commandFromRow(row);
        db.prepare(`
          UPDATE social_commands SET status = ?, completed_at = ?, last_error = ? WHERE id = ?
        `).run(success ? 'completed' : 'failed', timestamp, String(error || '').slice(0, 2_000), numericId);
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
              success ? 'synced' : 'failed',
              success ? timestamp : watch.last_synced_at,
              success ? '' : String(error || 'Bridge rejected the command').slice(0, 2_000),
              String(remoteId || ''),
              String(remoteId || ''),
              timestamp,
              row.watchlist_id
            );
            const entry = watchlistFromRow(db.prepare('SELECT * FROM social_watchlist WHERE id = ?').get(row.watchlist_id));
            recordChange('watchlist.updated', 'watchlist', row.watchlist_id, entry, timestamp);
          }
        }
        return commandFromRow(db.prepare('SELECT * FROM social_commands WHERE id = ?').get(numericId));
      });
    },
    reconcileRemoteWatchlist(inputs) {
      if (!Array.isArray(inputs)) throw new TypeError('accounts must be an array');
      const timestamp = now();
      return transaction(db, () => {
        const normalized = inputs.map((input) => normalizeWatchAccount(input));
        const remoteKeys = new Set(normalized.map((account) => `${account.platform}:${account.accountKey}`));
        const changes = [];
        for (const account of normalized) {
          const existing = db.prepare('SELECT * FROM social_watchlist WHERE platform = ? AND account_key = ?')
            .get(account.platform, account.accountKey);
          if (existing?.desired_state === 'removed' && existing.sync_status !== 'synced') {
            continue;
          }
          const result = addWatchAccount(account, timestamp, { origin: 'remote', synced: true });
          if (result.change) changes.push(result.change);
        }
        const activeRows = db.prepare("SELECT * FROM social_watchlist WHERE desired_state = 'active'").all();
        for (const row of activeRows) {
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
          entries: db.prepare('SELECT * FROM social_watchlist ORDER BY desired_state, lower(handle), id')
            .all()
            .map(watchlistFromRow),
          changes
        };
      });
    },
    recordBridgeHeartbeat({ bridgeId = '', version = '', capabilities = [], sessionId = '' } = {}) {
      const timestamp = now();
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
      `).run(
        String(bridgeId || '').slice(0, 240),
        String(version || '').slice(0, 120),
        json(Array.isArray(capabilities) ? capabilities.slice(0, 50).map(String) : []),
        String(sessionId || '').slice(0, 240),
        timestamp,
        timestamp
      );
      return this.getBridgeState();
    },
    getBridgeState() {
      const row = db.prepare('SELECT * FROM social_bridge_state WHERE singleton = 1').get();
      if (!row) return { bridgeId: '', version: '', capabilities: [], sessionId: '', lastSeenAt: null };
      return {
        bridgeId: row.bridge_id,
        version: row.version,
        capabilities: parseJson(row.capabilities_json, []),
        sessionId: row.session_id,
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
    cleanup({ retentionDays = 7 } = {}) {
      const timestamp = now();
      const cutoff = timestamp - Math.max(1, Number(retentionDays) || 7) * 24 * 60 * 60 * 1_000;
      return transaction(db, () => {
        const posts = db.prepare('DELETE FROM social_posts WHERE published_at < ? AND updated_at < ?').run(cutoff, cutoff);
        const changes = db.prepare('DELETE FROM social_changes WHERE created_at < ?').run(cutoff);
        const commands = db.prepare(`
          DELETE FROM social_commands
          WHERE completed_at < ? AND status IN ('completed', 'failed', 'cancelled')
        `).run(cutoff);
        return {
          cutoff,
          postsDeleted: Number(posts.changes),
          changesDeleted: Number(changes.changes),
          commandsDeleted: Number(commands.changes)
        };
      });
    },
    close() {
      db.close();
    }
  };
}
