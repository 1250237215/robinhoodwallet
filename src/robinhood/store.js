import fs from 'node:fs';
import path from 'node:path';
import { DatabaseSync } from 'node:sqlite';

import { WALLET_MONITOR_TIERS } from './tiering.js';

const ADDRESS_PATTERN = /^0x[0-9a-f]{40}$/;

function json(value) {
  return JSON.stringify(value ?? null);
}

function parseJson(value, fallback = null) {
  if (value === null || value === undefined || value === '') return fallback;
  try {
    return JSON.parse(value);
  } catch {
    return fallback;
  }
}

export function createRobinhoodStore(filename) {
  if (filename !== ':memory:') fs.mkdirSync(path.dirname(filename), { recursive: true });
  const db = new DatabaseSync(filename);
  db.exec(`
    PRAGMA foreign_keys = ON;
    CREATE TABLE IF NOT EXISTS metadata (
      key TEXT PRIMARY KEY,
      value TEXT NOT NULL
    );
    CREATE TABLE IF NOT EXISTS tokens (
      address TEXT PRIMARY KEY,
      symbol TEXT NOT NULL,
      name TEXT NOT NULL,
      logo TEXT NOT NULL DEFAULT '',
      payload TEXT NOT NULL,
      updated_at INTEGER NOT NULL
    );
    CREATE TABLE IF NOT EXISTS actions (
      token_address TEXT NOT NULL,
      tx_hash TEXT NOT NULL,
      log_index INTEGER NOT NULL,
      wallet TEXT NOT NULL,
      side TEXT NOT NULL,
      token_amount REAL NOT NULL,
      quote_amount REAL NOT NULL,
      price_native REAL NOT NULL,
      block_number INTEGER NOT NULL,
      block_timestamp INTEGER,
      pool_address TEXT NOT NULL,
      payload TEXT NOT NULL,
      PRIMARY KEY (token_address, tx_hash, log_index)
    );
    CREATE TABLE IF NOT EXISTS wallet_summaries (
      address TEXT PRIMARY KEY,
      payload TEXT NOT NULL,
      score REAL NOT NULL,
      updated_at INTEGER NOT NULL
    );
    CREATE TABLE IF NOT EXISTS wallet_annotations (
      address TEXT PRIMARY KEY,
      alias TEXT NOT NULL DEFAULT '',
      note TEXT NOT NULL DEFAULT '',
      tags TEXT NOT NULL DEFAULT '[]',
      status TEXT NOT NULL DEFAULT 'active',
      classification_override TEXT,
      monitor_tier TEXT NOT NULL DEFAULT 'watch' CHECK (monitor_tier IN ('core', 'watch', 'high_frequency')),
      created_at INTEGER NOT NULL,
      updated_at INTEGER NOT NULL
    );
    CREATE TABLE IF NOT EXISTS jobs (
      id TEXT PRIMARY KEY,
      payload TEXT NOT NULL,
      updated_at INTEGER NOT NULL
    );
    CREATE TABLE IF NOT EXISTS monitor_token_metadata (
      address TEXT PRIMARY KEY,
      symbol TEXT NOT NULL,
      name TEXT NOT NULL,
      decimals INTEGER NOT NULL,
      complete INTEGER NOT NULL DEFAULT 0,
      updated_at INTEGER NOT NULL
    );
    CREATE TABLE IF NOT EXISTS monitor_events (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      wallet_address TEXT NOT NULL,
      wallet_alias TEXT NOT NULL DEFAULT '',
      token_address TEXT NOT NULL,
      token_symbol TEXT NOT NULL,
      token_name TEXT NOT NULL,
      token_amount TEXT NOT NULL,
      raw_token_amount TEXT NOT NULL,
      token_decimals INTEGER NOT NULL,
      tx_hash TEXT NOT NULL,
      log_index INTEGER NOT NULL,
      block_number INTEGER NOT NULL,
      block_timestamp INTEGER NOT NULL,
      detected_at INTEGER NOT NULL,
      UNIQUE(tx_hash, log_index)
    );
    CREATE TABLE IF NOT EXISTS monitor_bark_targets (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      label TEXT NOT NULL DEFAULT '',
      endpoint TEXT NOT NULL UNIQUE,
      enabled INTEGER NOT NULL DEFAULT 1,
      created_at INTEGER NOT NULL,
      updated_at INTEGER NOT NULL,
      last_success_at INTEGER,
      last_error_at INTEGER,
      last_error TEXT NOT NULL DEFAULT ''
    );
    CREATE TABLE IF NOT EXISTS monitor_token_alerts (
      token_address TEXT PRIMARY KEY,
      alerted_at INTEGER NOT NULL
    );
    CREATE INDEX IF NOT EXISTS monitor_events_detected_at_idx
      ON monitor_events(detected_at DESC);
    CREATE INDEX IF NOT EXISTS monitor_events_block_timestamp_idx
      ON monitor_events(block_timestamp DESC);
    CREATE INDEX IF NOT EXISTS monitor_events_token_timestamp_idx
      ON monitor_events(token_address, block_timestamp DESC);
  `);

  const walletAnnotationColumns = new Set(
    db.prepare('PRAGMA table_info(wallet_annotations)').all().map((column) => column.name)
  );
  if (!walletAnnotationColumns.has('monitor_tier')) {
    db.exec("ALTER TABLE wallet_annotations ADD COLUMN monitor_tier TEXT NOT NULL DEFAULT 'watch'");
  }
  db.exec(`
    UPDATE wallet_annotations
    SET monitor_tier = 'watch'
    WHERE monitor_tier IS NULL OR monitor_tier NOT IN ('core', 'watch', 'high_frequency')
  `);
  const upsertTokenStatement = db.prepare(`
    INSERT INTO tokens(address, symbol, name, logo, payload, updated_at)
    VALUES (?, ?, ?, ?, ?, ?)
    ON CONFLICT(address) DO UPDATE SET
      symbol = excluded.symbol,
      name = excluded.name,
      logo = excluded.logo,
      payload = excluded.payload,
      updated_at = excluded.updated_at
  `);
  const insertActionStatement = db.prepare(`
    INSERT OR REPLACE INTO actions(
      token_address, tx_hash, log_index, wallet, side, token_amount,
      quote_amount, price_native, block_number, block_timestamp, pool_address, payload
    ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
  `);
  const upsertWalletAnnotationStatement = db.prepare(`
    INSERT INTO wallet_annotations(
      address, alias, note, tags, status, classification_override, monitor_tier, created_at, updated_at
    ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)
    ON CONFLICT(address) DO UPDATE SET
      alias = excluded.alias,
      note = excluded.note,
      tags = excluded.tags,
      status = excluded.status,
      classification_override = excluded.classification_override,
      monitor_tier = excluded.monitor_tier,
      updated_at = excluded.updated_at
  `);

  function walletAnnotationFromRow(row) {
    if (!row) return null;
    return {
      address: row.address,
      alias: row.alias,
      note: row.note,
      tags: parseJson(row.tags, []),
      status: row.status,
      classificationOverride: row.classification_override,
      monitorTier: WALLET_MONITOR_TIERS.has(row.monitor_tier) ? row.monitor_tier : 'watch',
      createdAt: Number(row.created_at),
      updatedAt: Number(row.updated_at)
    };
  }

  function monitorTokenMetadataFromRow(row) {
    if (!row) return null;
    return {
      address: row.address,
      symbol: row.symbol,
      name: row.name,
      decimals: Number(row.decimals),
      complete: Boolean(row.complete),
      updatedAt: Number(row.updated_at)
    };
  }

  function monitorEventFromRow(row) {
    if (!row) return null;
    return {
      id: Number(row.id),
      walletAddress: row.wallet_address,
      walletAlias: row.wallet_alias,
      tokenAddress: row.token_address,
      tokenSymbol: row.token_symbol,
      tokenName: row.token_name,
      tokenAmount: row.token_amount,
      rawTokenAmount: row.raw_token_amount,
      tokenDecimals: Number(row.token_decimals),
      txHash: row.tx_hash,
      logIndex: Number(row.log_index),
      blockNumber: Number(row.block_number),
      blockTimestamp: Number(row.block_timestamp),
      detectedAt: Number(row.detected_at)
    };
  }

  function monitorBarkTargetFromRow(row) {
    if (!row) return null;
    return {
      id: Number(row.id),
      label: row.label,
      endpoint: row.endpoint,
      enabled: Boolean(row.enabled),
      createdAt: Number(row.created_at),
      updatedAt: Number(row.updated_at),
      lastSuccessAt: row.last_success_at === null ? null : Number(row.last_success_at),
      lastErrorAt: row.last_error_at === null ? null : Number(row.last_error_at),
      lastError: row.last_error
    };
  }

  return {
    db,
    setMeta(key, value) {
      db.prepare('INSERT OR REPLACE INTO metadata(key, value) VALUES (?, ?)').run(key, String(value));
    },
    getMeta(key) {
      return db.prepare('SELECT value FROM metadata WHERE key = ?').get(key)?.value ?? null;
    },
    recordMonitorTokenAlert(tokenAddress, alertedAt = Math.floor(Date.now() / 1000)) {
      const address = String(tokenAddress || '').toLowerCase();
      if (!ADDRESS_PATTERN.test(address)) throw new TypeError('Invalid monitor token address');
      const timestamp = Math.max(0, Math.floor(Number(alertedAt) || 0));
      const result = db.prepare(`
        INSERT OR IGNORE INTO monitor_token_alerts(token_address, alerted_at)
        VALUES (?, ?)
      `).run(address, timestamp);
      const row = db.prepare('SELECT token_address, alerted_at FROM monitor_token_alerts WHERE token_address = ?').get(address);
      return {
        inserted: Number(result.changes) > 0,
        tokenAddress: row.token_address,
        alertedAt: Number(row.alerted_at)
      };
    },
    listMonitorTokenAlerts() {
      return db
        .prepare('SELECT token_address, alerted_at FROM monitor_token_alerts ORDER BY alerted_at, token_address')
        .all()
        .map((row) => ({ tokenAddress: row.token_address, alertedAt: Number(row.alerted_at) }));
    },
    upsertToken(token) {
      const address = String(token.address).toLowerCase();
      upsertTokenStatement.run(
        address,
        String(token.symbol || 'UNKNOWN'),
        String(token.name || token.symbol || 'Unknown'),
        String(token.logo || ''),
        json({ ...token, address }),
        Number(token.updatedAt || Math.floor(Date.now() / 1000))
      );
    },
    listTokens() {
      return db.prepare('SELECT payload FROM tokens ORDER BY updated_at DESC').all().map((row) => parseJson(row.payload, {}));
    },
    getToken(address) {
      const row = db.prepare('SELECT payload FROM tokens WHERE address = ?').get(String(address).toLowerCase());
      return row ? parseJson(row.payload, null) : null;
    },
    replaceTokenActions(tokenAddress, actions) {
      const normalized = String(tokenAddress).toLowerCase();
      db.exec('BEGIN');
      try {
        db.prepare('DELETE FROM actions WHERE token_address = ?').run(normalized);
        for (const action of actions) {
          insertActionStatement.run(
            normalized,
            action.txHash,
            Number(action.logIndex),
            String(action.wallet).toLowerCase(),
            action.side,
            Number(action.tokenAmount),
            Number(action.quoteAmount),
            Number(action.priceNative),
            Number(action.blockNumber),
            action.blockTimestamp === null || action.blockTimestamp === undefined ? null : Number(action.blockTimestamp),
            String(action.poolAddress).toLowerCase(),
            json(action)
          );
        }
        db.exec('COMMIT');
      } catch (error) {
        db.exec('ROLLBACK');
        throw error;
      }
    },
    listActionsForToken(tokenAddress) {
      return db
        .prepare('SELECT payload FROM actions WHERE token_address = ? ORDER BY block_number, log_index')
        .all(String(tokenAddress).toLowerCase())
        .map((row) => parseJson(row.payload, {}));
    },
    replaceWalletSummaries(summaries) {
      db.exec('BEGIN');
      try {
        db.exec('DELETE FROM wallet_summaries');
        const statement = db.prepare(
          'INSERT INTO wallet_summaries(address, payload, score, updated_at) VALUES (?, ?, ?, ?)'
        );
        const updatedAt = Math.floor(Date.now() / 1000);
        for (const summary of summaries) {
          statement.run(String(summary.address).toLowerCase(), json(summary), Number(summary.score || 0), updatedAt);
        }
        db.exec('COMMIT');
      } catch (error) {
        db.exec('ROLLBACK');
        throw error;
      }
    },
    listWalletSummaries() {
      return db.prepare('SELECT payload FROM wallet_summaries ORDER BY score DESC, address').all().map((row) => parseJson(row.payload, {}));
    },
    upsertWalletAnnotation(annotation) {
      const address = String(annotation.address).toLowerCase();
      const existing = db.prepare('SELECT * FROM wallet_annotations WHERE address = ?').get(address);
      const createdAt = Number(annotation.createdAt ?? existing?.created_at ?? Math.floor(Date.now() / 1000));
      const updatedAt = Number(annotation.updatedAt ?? Math.floor(Date.now() / 1000));
      const monitorTier = String(annotation.monitorTier ?? existing?.monitor_tier ?? 'watch').toLowerCase();
      if (!WALLET_MONITOR_TIERS.has(monitorTier)) throw new TypeError('Unsupported wallet monitor tier');
      const tags = Array.isArray(annotation.tags)
        ? [...new Set(annotation.tags.map((tag) => String(tag).trim()).filter(Boolean))]
        : parseJson(existing?.tags, []);
      upsertWalletAnnotationStatement.run(
        address,
        String(annotation.alias ?? existing?.alias ?? ''),
        String(annotation.note ?? existing?.note ?? ''),
        json(tags),
        String(annotation.status ?? existing?.status ?? 'active'),
        annotation.classificationOverride === undefined
          ? existing?.classification_override ?? null
          : annotation.classificationOverride,
        monitorTier,
        createdAt,
        updatedAt
      );
      return walletAnnotationFromRow(db.prepare('SELECT * FROM wallet_annotations WHERE address = ?').get(address));
    },
    getWalletAnnotation(address) {
      return walletAnnotationFromRow(
        db.prepare('SELECT * FROM wallet_annotations WHERE address = ?').get(String(address).toLowerCase())
      );
    },
    listWalletAnnotations() {
      return db
        .prepare('SELECT * FROM wallet_annotations ORDER BY updated_at DESC, address')
        .all()
        .map(walletAnnotationFromRow);
    },
    listMonitoredWalletAnnotations() {
      return db
        .prepare("SELECT * FROM wallet_annotations WHERE status != 'excluded' ORDER BY updated_at DESC, address")
        .all()
        .map(walletAnnotationFromRow);
    },
    deleteWalletAnnotation(address) {
      return db.prepare('DELETE FROM wallet_annotations WHERE address = ?').run(String(address).toLowerCase()).changes > 0;
    },
    upsertMonitorTokenMetadata(metadata) {
      const address = String(metadata.address || '').toLowerCase();
      db.prepare(`
        INSERT INTO monitor_token_metadata(address, symbol, name, decimals, complete, updated_at)
        VALUES (?, ?, ?, ?, ?, ?)
        ON CONFLICT(address) DO UPDATE SET
          symbol = excluded.symbol,
          name = excluded.name,
          decimals = excluded.decimals,
          complete = excluded.complete,
          updated_at = excluded.updated_at
      `).run(
        address,
        String(metadata.symbol || address),
        String(metadata.name || metadata.symbol || address),
        Number(metadata.decimals ?? 18),
        metadata.complete ? 1 : 0,
        Number(metadata.updatedAt || Math.floor(Date.now() / 1000))
      );
      return monitorTokenMetadataFromRow(
        db.prepare('SELECT * FROM monitor_token_metadata WHERE address = ?').get(address)
      );
    },
    getMonitorTokenMetadata(address) {
      return monitorTokenMetadataFromRow(
        db.prepare('SELECT * FROM monitor_token_metadata WHERE address = ?').get(String(address).toLowerCase())
      );
    },
    insertMonitorEvent(event) {
      const result = db.prepare(`
        INSERT OR IGNORE INTO monitor_events(
          wallet_address, wallet_alias, token_address, token_symbol, token_name,
          token_amount, raw_token_amount, token_decimals, tx_hash, log_index,
          block_number, block_timestamp, detected_at
        ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
      `).run(
        String(event.walletAddress || '').toLowerCase(),
        String(event.walletAlias || ''),
        String(event.tokenAddress || '').toLowerCase(),
        String(event.tokenSymbol || event.tokenAddress || ''),
        String(event.tokenName || event.tokenSymbol || event.tokenAddress || ''),
        String(event.tokenAmount ?? '0'),
        String(event.rawTokenAmount ?? '0'),
        Number(event.tokenDecimals ?? 18),
        String(event.txHash || '').toLowerCase(),
        Number(event.logIndex),
        Number(event.blockNumber),
        Number(event.blockTimestamp),
        Number(event.detectedAt || Math.floor(Date.now() / 1000))
      );
      const row = db.prepare('SELECT * FROM monitor_events WHERE tx_hash = ? AND log_index = ?').get(
        String(event.txHash || '').toLowerCase(),
        Number(event.logIndex)
      );
      return { inserted: Number(result.changes) > 0, event: monitorEventFromRow(row) };
    },
    listMonitorEvents({ after = 0, limit = 100 } = {}) {
      const normalizedAfter = Math.max(0, Math.floor(Number(after) || 0));
      const normalizedLimit = Math.max(1, Math.min(500, Math.floor(Number(limit) || 100)));
      const rows = normalizedAfter > 0
        ? db.prepare('SELECT * FROM monitor_events WHERE id > ? ORDER BY id ASC LIMIT ?').all(
            normalizedAfter,
            normalizedLimit
          )
        : db.prepare('SELECT * FROM monitor_events ORDER BY id DESC LIMIT ?').all(normalizedLimit);
      return rows.map(monitorEventFromRow);
    },
    listRecentMonitorEvents(sinceTimestamp, { limit = 5000 } = {}) {
      const normalizedLimit = Math.max(1, Math.min(50_000, Math.floor(Number(limit) || 5000)));
      return db
        .prepare('SELECT * FROM monitor_events WHERE block_timestamp >= ? ORDER BY id ASC LIMIT ?')
        .all(Number(sinceTimestamp), normalizedLimit)
        .map(monitorEventFromRow);
    },
    createMonitorBarkTarget(target) {
      const now = Number(target.updatedAt || Math.floor(Date.now() / 1000));
      const result = db.prepare(`
        INSERT INTO monitor_bark_targets(label, endpoint, enabled, created_at, updated_at)
        VALUES (?, ?, ?, ?, ?)
      `).run(
        String(target.label || ''),
        String(target.endpoint || ''),
        target.enabled === false ? 0 : 1,
        Number(target.createdAt || now),
        now
      );
      return monitorBarkTargetFromRow(
        db.prepare('SELECT * FROM monitor_bark_targets WHERE id = ?').get(Number(result.lastInsertRowid))
      );
    },
    listMonitorBarkTargets() {
      return db
        .prepare('SELECT * FROM monitor_bark_targets ORDER BY created_at, id')
        .all()
        .map(monitorBarkTargetFromRow);
    },
    getMonitorBarkTarget(id) {
      return monitorBarkTargetFromRow(
        db.prepare('SELECT * FROM monitor_bark_targets WHERE id = ?').get(Number(id))
      );
    },
    updateMonitorBarkTarget(id, patch = {}) {
      const existing = db.prepare('SELECT * FROM monitor_bark_targets WHERE id = ?').get(Number(id));
      if (!existing) return null;
      db.prepare(`
        UPDATE monitor_bark_targets
        SET label = ?, endpoint = ?, enabled = ?, updated_at = ?,
            last_success_at = ?, last_error_at = ?, last_error = ?
        WHERE id = ?
      `).run(
        String(patch.label ?? existing.label),
        String(patch.endpoint ?? existing.endpoint),
        Object.hasOwn(patch, 'enabled') ? (patch.enabled ? 1 : 0) : existing.enabled,
        Number(patch.updatedAt || Math.floor(Date.now() / 1000)),
        Object.hasOwn(patch, 'lastSuccessAt') ? patch.lastSuccessAt : existing.last_success_at,
        Object.hasOwn(patch, 'lastErrorAt') ? patch.lastErrorAt : existing.last_error_at,
        String(patch.lastError ?? existing.last_error),
        Number(id)
      );
      return monitorBarkTargetFromRow(
        db.prepare('SELECT * FROM monitor_bark_targets WHERE id = ?').get(Number(id))
      );
    },
    deleteMonitorBarkTarget(id) {
      return db.prepare('DELETE FROM monitor_bark_targets WHERE id = ?').run(Number(id)).changes > 0;
    },
    upsertJob(job) {
      const updatedAt = Number(job.updatedAt || Math.floor(Date.now() / 1000));
      db.prepare('INSERT OR REPLACE INTO jobs(id, payload, updated_at) VALUES (?, ?, ?)').run(job.id, json(job), updatedAt);
    },
    listJobs() {
      return db.prepare('SELECT payload FROM jobs ORDER BY updated_at DESC').all().map((row) => parseJson(row.payload, {}));
    },
    close() {
      db.close();
    }
  };
}
