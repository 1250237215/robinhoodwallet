import fs from 'node:fs';
import path from 'node:path';
import { DatabaseSync } from 'node:sqlite';

import {
  defaultWalletMonitorRules,
  normalizeWalletMonitorRules,
  WALLET_MONITOR_EVENT_TYPES
} from './monitorRules.js';
import { WALLET_MONITOR_TIERS } from './tiering.js';

const ADDRESS_PATTERN = /^0x[0-9a-f]{40}$/;
const MONITOR_EVENT_TYPE_SET = new Set(WALLET_MONITOR_EVENT_TYPES);
const DEFAULT_MONITOR_RULES_JSON = JSON.stringify(defaultWalletMonitorRules());
const COMPACT_PROFIT_RANK_ALIAS_MIGRATION = 'robinhood:compact_profit_rank_aliases_v1';
const LEGACY_PROFIT_RANK_ALIAS_PATTERN = /^(.+?) 盈利榜第 ([1-9][0-9]*|待定) 名$/;
const BUY_FREQUENCY_TIMEZONE = 'Asia/Shanghai';
const BUY_FREQUENCY_UTC_OFFSET_SECONDS = 8 * 60 * 60;

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

function compactLegacyProfitRankAlias(value) {
  const alias = String(value ?? '');
  const match = alias.match(LEGACY_PROFIT_RANK_ALIAS_PATTERN);
  return match ? `${match[1]} ${match[2]}` : alias;
}

function migrateLegacyProfitRankAliases(db) {
  const migrated = db.prepare('SELECT 1 FROM metadata WHERE key = ?').get(COMPACT_PROFIT_RANK_ALIAS_MIGRATION);
  if (migrated) return;

  const updateAnnotation = db.prepare('UPDATE wallet_annotations SET alias = ? WHERE address = ?');
  const updateSummary = db.prepare('UPDATE wallet_summaries SET payload = ? WHERE address = ?');
  const updateMonitorEvent = db.prepare('UPDATE monitor_events SET wallet_alias = ? WHERE id = ?');
  db.exec('BEGIN');
  try {
    for (const row of db.prepare("SELECT address, alias FROM wallet_annotations WHERE alias LIKE '% 盈利榜第 % 名'").all()) {
      const alias = compactLegacyProfitRankAlias(row.alias);
      if (alias !== row.alias) updateAnnotation.run(alias, row.address);
    }
    for (const row of db.prepare("SELECT address, payload FROM wallet_summaries WHERE payload LIKE '%盈利榜第%'").all()) {
      const summary = parseJson(row.payload, null);
      if (!summary || typeof summary !== 'object') continue;
      const suggestedAlias = compactLegacyProfitRankAlias(summary.suggestedAlias);
      if (suggestedAlias === summary.suggestedAlias) continue;
      updateSummary.run(json({ ...summary, suggestedAlias }), row.address);
    }
    for (const row of db.prepare("SELECT id, wallet_alias FROM monitor_events WHERE wallet_alias LIKE '% 盈利榜第 % 名'").all()) {
      const alias = compactLegacyProfitRankAlias(row.wallet_alias);
      if (alias !== row.wallet_alias) updateMonitorEvent.run(alias, row.id);
    }
    db.prepare('INSERT INTO metadata(key, value) VALUES (?, ?)').run(COMPACT_PROFIT_RANK_ALIAS_MIGRATION, '1');
    db.exec('COMMIT');
  } catch (error) {
    db.exec('ROLLBACK');
    throw error;
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
      monitor_rules TEXT NOT NULL DEFAULT '${DEFAULT_MONITOR_RULES_JSON}',
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
      event_type TEXT NOT NULL DEFAULT 'buy',
      asset_type TEXT NOT NULL DEFAULT 'token',
      wallet_address TEXT NOT NULL,
      wallet_alias TEXT NOT NULL DEFAULT '',
      counterparty_address TEXT NOT NULL DEFAULT '',
      platform TEXT NOT NULL DEFAULT '',
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
      sound_alert INTEGER NOT NULL DEFAULT 0,
      bark_alert INTEGER NOT NULL DEFAULT 0,
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
  if (!walletAnnotationColumns.has('monitor_rules')) {
    db.exec(`ALTER TABLE wallet_annotations ADD COLUMN monitor_rules TEXT NOT NULL DEFAULT '${DEFAULT_MONITOR_RULES_JSON}'`);
  }
  db.exec(`
    UPDATE wallet_annotations
    SET monitor_tier = 'watch'
    WHERE monitor_tier IS NULL OR monitor_tier NOT IN ('core', 'watch', 'high_frequency')
  `);
  const normalizeMonitorRulesStatement = db.prepare(
    'UPDATE wallet_annotations SET monitor_rules = ? WHERE address = ?'
  );
  for (const row of db.prepare('SELECT address, monitor_rules FROM wallet_annotations').all()) {
    const normalizedRules = json(normalizeWalletMonitorRules(parseJson(row.monitor_rules, null)));
    if (row.monitor_rules !== normalizedRules) normalizeMonitorRulesStatement.run(normalizedRules, row.address);
  }

  const monitorEventColumns = new Set(
    db.prepare('PRAGMA table_info(monitor_events)').all().map((column) => column.name)
  );
  const monitorEventMigrations = [
    ['event_type', "TEXT NOT NULL DEFAULT 'buy'"],
    ['asset_type', "TEXT NOT NULL DEFAULT 'token'"],
    ['counterparty_address', "TEXT NOT NULL DEFAULT ''"],
    ['platform', "TEXT NOT NULL DEFAULT ''"],
    ['sound_alert', 'INTEGER NOT NULL DEFAULT 0'],
    ['bark_alert', 'INTEGER NOT NULL DEFAULT 0']
  ];
  for (const [column, definition] of monitorEventMigrations) {
    if (!monitorEventColumns.has(column)) db.exec(`ALTER TABLE monitor_events ADD COLUMN ${column} ${definition}`);
  }
  db.exec(`
    UPDATE monitor_events
    SET event_type = 'buy'
    WHERE event_type IS NULL OR event_type NOT IN ('buy', 'sell', 'transfer', 'token_create');
    UPDATE monitor_events
    SET asset_type = 'token'
    WHERE asset_type IS NULL OR trim(asset_type) = '';
    UPDATE monitor_events
    SET counterparty_address = ''
    WHERE counterparty_address IS NULL;
    UPDATE monitor_events
    SET platform = ''
    WHERE platform IS NULL;
    UPDATE monitor_events
    SET sound_alert = CASE WHEN sound_alert = 1 THEN 1 ELSE 0 END,
        bark_alert = CASE WHEN bark_alert = 1 THEN 1 ELSE 0 END
    WHERE sound_alert NOT IN (0, 1) OR bark_alert NOT IN (0, 1);
    CREATE INDEX IF NOT EXISTS monitor_events_event_timestamp_idx
      ON monitor_events(event_type, block_timestamp DESC);
    CREATE INDEX IF NOT EXISTS monitor_events_wallet_buy_frequency_idx
      ON monitor_events(event_type, wallet_address, block_timestamp, token_address);
  `);
  migrateLegacyProfitRankAliases(db);
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
      address, alias, note, tags, status, classification_override, monitor_tier, monitor_rules,
      created_at, updated_at
    ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
    ON CONFLICT(address) DO UPDATE SET
      alias = excluded.alias,
      note = excluded.note,
      tags = excluded.tags,
      status = excluded.status,
      classification_override = excluded.classification_override,
      monitor_tier = excluded.monitor_tier,
      monitor_rules = excluded.monitor_rules,
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
      monitorRules: normalizeWalletMonitorRules(parseJson(row.monitor_rules, null)),
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
      eventType: MONITOR_EVENT_TYPE_SET.has(row.event_type) ? row.event_type : 'buy',
      assetType: String(row.asset_type || 'token'),
      walletAddress: row.wallet_address,
      walletAlias: row.wallet_alias,
      counterpartyAddress: String(row.counterparty_address || ''),
      platform: String(row.platform || ''),
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
      detectedAt: Number(row.detected_at),
      soundAlert: Boolean(row.sound_alert),
      barkAlert: Boolean(row.bark_alert)
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
    listWalletBuyFrequencyStats({
      asOf = Math.floor(Date.now() / 1000),
      utcOffsetSeconds = BUY_FREQUENCY_UTC_OFFSET_SECONDS,
      address = null
    } = {}) {
      const calculatedAt = Math.max(0, Math.floor(Number(asOf) || 0));
      const offset = Math.floor(Number(utcOffsetSeconds));
      if (!Number.isFinite(offset) || offset < -14 * 60 * 60 || offset > 14 * 60 * 60) {
        throw new RangeError('utcOffsetSeconds must be between -50400 and 50400');
      }
      const normalizedAddress = address === null || address === undefined || address === ''
        ? null
        : String(address).toLowerCase();
      if (normalizedAddress !== null && !ADDRESS_PATTERN.test(normalizedAddress)) {
        throw new TypeError('Invalid wallet address');
      }
      const rows = db.prepare(`
        WITH
        params(as_of, utc_offset, address_filter) AS (VALUES (?, ?, ?)),
        global_monitor_start AS (
          SELECT MIN(block_timestamp) AS started_at
          FROM monitor_events
          WHERE event_type = 'buy' AND token_address != ''
        ),
        observations AS (
          SELECT
            annotation.address,
            MIN(
              params.as_of,
              MAX(annotation.created_at, COALESCE(global_monitor_start.started_at, params.as_of))
            ) AS observed_from
          FROM wallet_annotations AS annotation
          CROSS JOIN params
          CROSS JOIN global_monitor_start
          WHERE params.address_filter IS NULL OR annotation.address = params.address_filter
        ),
        monitored_buys AS (
          SELECT
            observation.address,
            event.token_address,
            event.block_timestamp,
            CAST((event.block_timestamp + params.utc_offset) / 86400 AS INTEGER) AS local_day
          FROM observations AS observation
          CROSS JOIN params
          JOIN monitor_events AS event
            ON event.wallet_address = observation.address
           AND event.event_type = 'buy'
           AND event.token_address != ''
           AND event.block_timestamp >= observation.observed_from
           AND event.detected_at <= params.as_of
        ),
        daily AS (
          SELECT address, local_day, COUNT(DISTINCT token_address) AS distinct_tokens
          FROM monitored_buys
          GROUP BY address, local_day
        ),
        daily_totals AS (
          SELECT
            address,
            SUM(distinct_tokens) AS distinct_token_days,
            COUNT(*) AS active_buy_days,
            MAX(distinct_tokens) AS max_daily_distinct_tokens
          FROM daily
          GROUP BY address
        ),
        token_totals AS (
          SELECT
            address,
            COUNT(DISTINCT token_address) AS distinct_tokens,
            MIN(block_timestamp) AS first_buy_at,
            MAX(block_timestamp) AS last_buy_at
          FROM monitored_buys
          GROUP BY address
        )
        SELECT
          observation.address,
          observation.observed_from,
          MAX(params.as_of, COALESCE(token_totals.last_buy_at, params.as_of)) AS observed_through,
          CAST((MAX(params.as_of, COALESCE(token_totals.last_buy_at, params.as_of)) + params.utc_offset) / 86400 AS INTEGER)
            - CAST((observation.observed_from + params.utc_offset) / 86400 AS INTEGER) + 1 AS observed_days,
          COALESCE(daily_totals.distinct_token_days, 0) AS distinct_token_days,
          COALESCE(token_totals.distinct_tokens, 0) AS distinct_tokens,
          COALESCE(daily_totals.active_buy_days, 0) AS active_buy_days,
          COALESCE(daily_totals.max_daily_distinct_tokens, 0) AS max_daily_distinct_tokens,
          token_totals.first_buy_at,
          token_totals.last_buy_at
        FROM observations AS observation
        CROSS JOIN params
        LEFT JOIN daily_totals ON daily_totals.address = observation.address
        LEFT JOIN token_totals ON token_totals.address = observation.address
        ORDER BY observation.address
      `).all(calculatedAt, offset, normalizedAddress);
      return rows.map((row) => {
        const observedDays = Math.max(1, Number(row.observed_days) || 1);
        const distinctTokenDayCount = Math.max(0, Number(row.distinct_token_days) || 0);
        return {
          address: row.address,
          averageDailyDistinctTokens: distinctTokenDayCount / observedDays,
          distinctTokenDayCount,
          distinctTokens: Math.max(0, Number(row.distinct_tokens) || 0),
          activeBuyDays: Math.max(0, Number(row.active_buy_days) || 0),
          maxDailyDistinctTokens: Math.max(0, Number(row.max_daily_distinct_tokens) || 0),
          observedDays,
          observedFrom: Number(row.observed_from),
          observedThrough: Number(row.observed_through),
          firstBuyAt: row.first_buy_at === null ? null : Number(row.first_buy_at),
          lastBuyAt: row.last_buy_at === null ? null : Number(row.last_buy_at),
          calculatedAt,
          timezone: BUY_FREQUENCY_TIMEZONE,
          source: 'monitor_events',
          partialHistory: true
        };
      });
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
      const existingMonitorRules = normalizeWalletMonitorRules(parseJson(existing?.monitor_rules, null));
      const monitorRules = annotation.monitorRules === undefined
        ? existingMonitorRules
        : normalizeWalletMonitorRules(annotation.monitorRules, existingMonitorRules);
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
        json(monitorRules),
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
      const eventType = String(event.eventType || 'buy').toLowerCase();
      if (!MONITOR_EVENT_TYPE_SET.has(eventType)) throw new TypeError('Unsupported monitor event type');
      const result = db.prepare(`
        INSERT OR IGNORE INTO monitor_events(
          event_type, asset_type, wallet_address, wallet_alias, counterparty_address, platform,
          token_address, token_symbol, token_name,
          token_amount, raw_token_amount, token_decimals, tx_hash, log_index,
          block_number, block_timestamp, detected_at, sound_alert, bark_alert
        ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
      `).run(
        eventType,
        String(event.assetType || 'token').trim().toLowerCase() || 'token',
        String(event.walletAddress || '').toLowerCase(),
        String(event.walletAlias || ''),
        String(event.counterpartyAddress || '').toLowerCase(),
        String(event.platform || ''),
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
        Number(event.detectedAt || Math.floor(Date.now() / 1000)),
        event.soundAlert === true ? 1 : 0,
        event.barkAlert === true ? 1 : 0
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
