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
const MONITOR_TOKEN_RISK_STATUS_SET = new Set(['pending', 'partial', 'ready', 'unavailable', 'error']);
const WALLET_ALIAS_SOURCE_SET = new Set(['none', 'generated', 'manual', 'unknown']);
const DEFAULT_MONITOR_RULES_JSON = JSON.stringify(defaultWalletMonitorRules());
const LEGACY_PROFIT_RANK_ALIAS_PATTERN = /^(.+?) 盈利榜第 ([1-9][0-9]*|待定) 名$/;
const COMPACT_PROFIT_RANK_ALIAS_PATTERN = /^.+?\s+[1-9][0-9]*$/;
const BUY_FREQUENCY_TIMEZONE = 'Asia/Shanghai';
const BUY_FREQUENCY_UTC_OFFSET_SECONDS = 8 * 60 * 60;

const defaultAddressNormalizer = (value) => String(value || '').toLowerCase();
const defaultAddressValidator = (value) => ADDRESS_PATTERN.test(defaultAddressNormalizer(value));
const defaultTransactionNormalizer = (value) => String(value || '').toLowerCase();

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

function optionalFiniteNumber(value, { minimum = -Infinity, maximum = Infinity } = {}) {
  if (value === null || value === undefined || value === '') return null;
  const number = Number(value);
  return Number.isFinite(number) && number >= minimum && number <= maximum ? number : null;
}

function optionalBoolean(value) {
  return value === true ? true : value === false ? false : null;
}

function normalizeMonitorTokenRisk(value = {}) {
  const source = value && typeof value === 'object' && !Array.isArray(value) ? value : {};
  const status = String(source.tokenRiskStatus || '').trim().toLowerCase();
  const flags = Array.isArray(source.tokenRiskFlags)
    ? [...new Set(source.tokenRiskFlags
      .map((flag) => String(flag || '').trim().toLowerCase())
      .filter(Boolean))].slice(0, 20)
    : [];
  return {
    tokenRiskStatus: MONITOR_TOKEN_RISK_STATUS_SET.has(status) ? status : '',
    sellable: optionalBoolean(source.sellable),
    top10HolderPercent: optionalFiniteNumber(source.top10HolderPercent, { minimum: 0, maximum: 100 }),
    top10HolderCount: optionalFiniteNumber(source.top10HolderCount, { minimum: 0 }),
    top10HolderPartial: optionalBoolean(source.top10HolderPartial),
    creatorAddress: String(source.creatorAddress || '').trim().toLowerCase().slice(0, 80),
    creatorAddressSource: String(source.creatorAddressSource || '').trim().slice(0, 80),
    creatorHoldingPercent: optionalFiniteNumber(source.creatorHoldingPercent, { minimum: 0, maximum: 100 }),
    canMintMore: optionalBoolean(source.canMintMore),
    creatorTokenCount: optionalFiniteNumber(source.creatorTokenCount, { minimum: 0 }),
    creatorDeadTokenCount: optionalFiniteNumber(source.creatorDeadTokenCount, { minimum: 0 }),
    creatorHistoryPartial: optionalBoolean(source.creatorHistoryPartial),
    deadDefinition: String(source.deadDefinition || '').trim().slice(0, 240),
    tokenRiskError: String(source.tokenRiskError || '').trim().slice(0, 500),
    tokenRiskFlags: flags,
    tokenRiskSource: String(source.tokenRiskSource || '').trim().slice(0, 240)
  };
}

function monitorTokenRiskFromRow(row) {
  if (row?.risk_payload === null && row?.liquidity_usd === null && row?.risk_data_at === null) return null;
  const risk = normalizeMonitorTokenRisk(parseJson(row?.risk_payload, {}));
  return {
    ...risk,
    liquidityUsd: row?.liquidity_usd === null || row?.liquidity_usd === undefined
      ? null
      : Number(row.liquidity_usd),
    tokenRiskDataAt: row?.risk_data_at === null || row?.risk_data_at === undefined
      ? null
      : Number(row.risk_data_at)
  };
}

function compactLegacyProfitRankAlias(value) {
  const alias = String(value ?? '');
  const match = alias.match(LEGACY_PROFIT_RANK_ALIAS_PATTERN);
  return match ? `${match[1]} ${match[2]}` : alias;
}

function normalizeWalletAliasSource(value, fallback = 'unknown') {
  const source = String(value || '').trim().toLowerCase();
  return WALLET_ALIAS_SOURCE_SET.has(source) ? source : fallback;
}

function migrateWalletAliasSources(db, migrationKey) {
  const migrated = db.prepare('SELECT 1 FROM metadata WHERE key = ?').get(migrationKey);
  if (migrated) return;

  const update = db.prepare('UPDATE wallet_annotations SET alias_source = ? WHERE address = ?');
  db.exec('BEGIN');
  try {
    for (const row of db.prepare('SELECT address, alias, alias_source FROM wallet_annotations').all()) {
      const current = normalizeWalletAliasSource(row.alias_source);
      const alias = String(row.alias || '').trim();
      const generated = LEGACY_PROFIT_RANK_ALIAS_PATTERN.test(alias) ||
        COMPACT_PROFIT_RANK_ALIAS_PATTERN.test(alias);
      const source = !alias
        ? 'none'
        : generated || current === 'generated'
          ? 'generated'
          : 'manual';
      if (source !== current) update.run(source, row.address);
    }
    db.prepare('INSERT OR REPLACE INTO metadata(key, value) VALUES (?, ?)').run(migrationKey, '1');
    db.exec('COMMIT');
  } catch (error) {
    db.exec('ROLLBACK');
    throw error;
  }
}

function migrateLegacyProfitRankAliases(db, migrationKey) {
  const migrated = db.prepare('SELECT 1 FROM metadata WHERE key = ?').get(migrationKey);
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
    db.prepare('INSERT INTO metadata(key, value) VALUES (?, ?)').run(migrationKey, '1');
    db.exec('COMMIT');
  } catch (error) {
    db.exec('ROLLBACK');
    throw error;
  }
}

export function createRobinhoodStore(filename, {
  chainId = 'robinhood',
  chainLabel = 'Robinhood',
  addressNormalizer = defaultAddressNormalizer,
  addressValidator = defaultAddressValidator,
  transactionNormalizer = defaultTransactionNormalizer
} = {}) {
  if (typeof addressNormalizer !== 'function') throw new TypeError('addressNormalizer must be a function');
  if (typeof addressValidator !== 'function') throw new TypeError('addressValidator must be a function');
  if (typeof transactionNormalizer !== 'function') throw new TypeError('transactionNormalizer must be a function');
  const normalizedChainId = String(chainId || 'robinhood').trim().toLowerCase() || 'robinhood';
  const normalizedChainLabel = String(chainLabel || normalizedChainId).trim() || normalizedChainId;
  const normalizeAddress = (value) => String(addressNormalizer(value) ?? '');
  const isValidAddress = (value) => addressValidator(normalizeAddress(value)) === true;
  const normalizeTransaction = (value) => String(transactionNormalizer(value) ?? '');
  const compactProfitRankAliasMigration = `${normalizedChainId}:compact_profit_rank_aliases_v1`;
  const walletAliasSourceMigration = `${normalizedChainId}:wallet_alias_sources_v1`;
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
      alias_source TEXT NOT NULL DEFAULT 'unknown',
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
      market_cap_usd REAL,
      liquidity_usd REAL,
      token_creation_timestamp INTEGER,
      market_data_at INTEGER,
      risk_payload TEXT,
      risk_data_at INTEGER,
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
      market_cap_usd REAL,
      liquidity_usd REAL,
      token_creation_timestamp INTEGER,
      market_data_at INTEGER,
      risk_payload TEXT,
      risk_data_at INTEGER,
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
  if (!walletAnnotationColumns.has('alias_source')) {
    db.exec("ALTER TABLE wallet_annotations ADD COLUMN alias_source TEXT NOT NULL DEFAULT 'unknown'");
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

  const monitorTokenMetadataColumns = new Set(
    db.prepare('PRAGMA table_info(monitor_token_metadata)').all().map((column) => column.name)
  );
  const monitorTokenMetadataMigrations = [
    ['market_cap_usd', 'REAL'],
    ['liquidity_usd', 'REAL'],
    ['token_creation_timestamp', 'INTEGER'],
    ['market_data_at', 'INTEGER'],
    ['risk_payload', 'TEXT'],
    ['risk_data_at', 'INTEGER']
  ];
  for (const [column, definition] of monitorTokenMetadataMigrations) {
    if (!monitorTokenMetadataColumns.has(column)) {
      db.exec(`ALTER TABLE monitor_token_metadata ADD COLUMN ${column} ${definition}`);
    }
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
    ['bark_alert', 'INTEGER NOT NULL DEFAULT 0'],
    ['market_cap_usd', 'REAL'],
    ['liquidity_usd', 'REAL'],
    ['token_creation_timestamp', 'INTEGER'],
    ['market_data_at', 'INTEGER'],
    ['risk_payload', 'TEXT'],
    ['risk_data_at', 'INTEGER']
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
  migrateWalletAliasSources(db, walletAliasSourceMigration);
  migrateLegacyProfitRankAliases(db, compactProfitRankAliasMigration);
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
      address, alias, alias_source, note, tags, status, classification_override, monitor_tier, monitor_rules,
      created_at, updated_at
    ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
    ON CONFLICT(address) DO UPDATE SET
      alias = excluded.alias,
      alias_source = excluded.alias_source,
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
      aliasSource: normalizeWalletAliasSource(row.alias_source, row.alias ? 'manual' : 'none'),
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
      marketCapUsd: row.market_cap_usd === null ? null : Number(row.market_cap_usd),
      tokenCreationTimestamp: row.token_creation_timestamp === null
        ? null
        : Number(row.token_creation_timestamp),
      marketDataAt: row.market_data_at === null ? null : Number(row.market_data_at),
      ...(normalizedChainId === 'robinhood' ? monitorTokenRiskFromRow(row) || {} : {}),
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
      barkAlert: Boolean(row.bark_alert),
      marketCapUsd: row.market_cap_usd === null ? null : Number(row.market_cap_usd),
      tokenCreationTimestamp: row.token_creation_timestamp === null
        ? null
        : Number(row.token_creation_timestamp),
      marketDataAt: row.market_data_at === null ? null : Number(row.market_data_at),
      ...(normalizedChainId === 'robinhood' ? monitorTokenRiskFromRow(row) || {} : {})
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
    chainId: normalizedChainId,
    chainLabel: normalizedChainLabel,
    normalizeAddress,
    isValidAddress,
    normalizeTransaction,
    setMeta(key, value) {
      db.prepare('INSERT OR REPLACE INTO metadata(key, value) VALUES (?, ?)').run(key, String(value));
    },
    getMeta(key) {
      return db.prepare('SELECT value FROM metadata WHERE key = ?').get(key)?.value ?? null;
    },
    recordMonitorTokenAlert(tokenAddress, alertedAt = Math.floor(Date.now() / 1000)) {
      const address = normalizeAddress(tokenAddress);
      if (!isValidAddress(address)) throw new TypeError('Invalid monitor token address');
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
        : normalizeAddress(address);
      if (normalizedAddress !== null && !isValidAddress(normalizedAddress)) {
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
      const address = normalizeAddress(token.address);
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
      const row = db.prepare('SELECT payload FROM tokens WHERE address = ?').get(normalizeAddress(address));
      return row ? parseJson(row.payload, null) : null;
    },
    replaceTokenActions(tokenAddress, actions) {
      const normalized = normalizeAddress(tokenAddress);
      db.exec('BEGIN');
      try {
        db.prepare('DELETE FROM actions WHERE token_address = ?').run(normalized);
        for (const action of actions) {
          insertActionStatement.run(
            normalized,
            normalizeTransaction(action.txHash),
            Number(action.logIndex),
            normalizeAddress(action.wallet),
            action.side,
            Number(action.tokenAmount),
            Number(action.quoteAmount),
            Number(action.priceNative),
            Number(action.blockNumber),
            action.blockTimestamp === null || action.blockTimestamp === undefined ? null : Number(action.blockTimestamp),
            normalizeAddress(action.poolAddress),
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
        .all(normalizeAddress(tokenAddress))
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
          statement.run(normalizeAddress(summary.address), json(summary), Number(summary.score || 0), updatedAt);
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
      const address = normalizeAddress(annotation.address);
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
      const alias = String(annotation.alias ?? existing?.alias ?? '');
      const requestedAliasSource = annotation.aliasSource === undefined
        ? existing?.alias_source
        : annotation.aliasSource;
      const aliasSource = alias
        ? normalizeWalletAliasSource(requestedAliasSource, 'manual')
        : 'none';
      upsertWalletAnnotationStatement.run(
        address,
        alias,
        aliasSource,
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
        db.prepare('SELECT * FROM wallet_annotations WHERE address = ?').get(normalizeAddress(address))
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
      return db.prepare('DELETE FROM wallet_annotations WHERE address = ?').run(normalizeAddress(address)).changes > 0;
    },
    upsertMonitorTokenMetadata(metadata) {
      const address = normalizeAddress(metadata.address);
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
        db.prepare('SELECT * FROM monitor_token_metadata WHERE address = ?').get(normalizeAddress(address))
      );
    },
    upsertMonitorTokenMarketData(marketData) {
      const address = normalizeAddress(marketData.address);
      if (!isValidAddress(address)) throw new TypeError('Invalid monitor token address');
      const marketCap = marketData.marketCapUsd === null || marketData.marketCapUsd === undefined ||
        marketData.marketCapUsd === '' ? NaN : Number(marketData.marketCapUsd);
      const marketCapUsd = Number.isFinite(marketCap) && marketCap >= 0 ? marketCap : null;
      const liquidity = marketData.liquidityUsd === null || marketData.liquidityUsd === undefined ||
        marketData.liquidityUsd === '' ? NaN : Number(marketData.liquidityUsd);
      const liquidityUsd = Number.isFinite(liquidity) && liquidity >= 0 ? liquidity : null;
      const creationTimestamp = Number(marketData.tokenCreationTimestamp);
      const tokenCreationTimestamp = Number.isSafeInteger(creationTimestamp) && creationTimestamp > 0
        ? creationTimestamp
        : null;
      const fetchedAt = Number(marketData.marketDataAt);
      const marketDataAt = (marketCapUsd !== null || liquidityUsd !== null) &&
        Number.isSafeInteger(fetchedAt) && fetchedAt > 0
        ? fetchedAt
        : null;
      db.prepare(`
        INSERT INTO monitor_token_metadata(
          address, symbol, name, decimals, complete, market_cap_usd, liquidity_usd,
          token_creation_timestamp, market_data_at, updated_at
        ) VALUES (?, ?, ?, 18, 0, ?, ?, ?, ?, 0)
        ON CONFLICT(address) DO UPDATE SET
          market_cap_usd = COALESCE(excluded.market_cap_usd, monitor_token_metadata.market_cap_usd),
          liquidity_usd = COALESCE(excluded.liquidity_usd, monitor_token_metadata.liquidity_usd),
          token_creation_timestamp = COALESCE(
            excluded.token_creation_timestamp,
            monitor_token_metadata.token_creation_timestamp
          ),
          market_data_at = COALESCE(excluded.market_data_at, monitor_token_metadata.market_data_at)
      `).run(
        address,
        address,
        address,
        marketCapUsd,
        liquidityUsd,
        tokenCreationTimestamp,
        marketDataAt
      );
      return monitorTokenMetadataFromRow(
        db.prepare('SELECT * FROM monitor_token_metadata WHERE address = ?').get(address)
      );
    },
    upsertMonitorTokenRiskData(riskData, { replace = false } = {}) {
      const address = normalizeAddress(riskData.address);
      if (!isValidAddress(address)) throw new TypeError('Invalid monitor token address');
      const existingRow = db.prepare('SELECT * FROM monitor_token_metadata WHERE address = ?').get(address);
      const existingPayload = parseJson(existingRow?.risk_payload, {});
      const patch = Object.fromEntries(Object.entries(riskData).filter(([, value]) => value !== undefined));
      const risk = normalizeMonitorTokenRisk(replace ? patch : { ...existingPayload, ...patch });
      const liquidityUsd = optionalFiniteNumber(riskData.liquidityUsd, { minimum: 0 });
      const replaceLiquidity = replace && Object.hasOwn(riskData, 'liquidityUsd');
      const riskDataAt = optionalFiniteNumber(riskData.tokenRiskDataAt, { minimum: 1 });
      db.prepare(`
        INSERT INTO monitor_token_metadata(
          address, symbol, name, decimals, complete, liquidity_usd,
          risk_payload, risk_data_at, updated_at
        ) VALUES (?, ?, ?, 18, 0, ?, ?, ?, 0)
        ON CONFLICT(address) DO UPDATE SET
          liquidity_usd = CASE
            WHEN ? = 1 THEN excluded.liquidity_usd
            ELSE COALESCE(excluded.liquidity_usd, monitor_token_metadata.liquidity_usd)
          END,
          risk_payload = excluded.risk_payload,
          risk_data_at = COALESCE(excluded.risk_data_at, monitor_token_metadata.risk_data_at)
      `).run(address, address, address, liquidityUsd, json(risk), riskDataAt, replaceLiquidity ? 1 : 0);
      return monitorTokenMetadataFromRow(
        db.prepare('SELECT * FROM monitor_token_metadata WHERE address = ?').get(address)
      );
    },
    insertMonitorEvent(event) {
      const eventType = String(event.eventType || 'buy').toLowerCase();
      if (!MONITOR_EVENT_TYPE_SET.has(eventType)) throw new TypeError('Unsupported monitor event type');
      const assetType = String(event.assetType || 'token').trim().toLowerCase() || 'token';
      const storesTokenRisk = normalizedChainId === 'robinhood' && assetType === 'erc20';
      const risk = storesTokenRisk ? normalizeMonitorTokenRisk(event) : null;
      const liquidityUsd = optionalFiniteNumber(event.liquidityUsd, { minimum: 0 });
      const riskDataAt = storesTokenRisk
        ? optionalFiniteNumber(event.tokenRiskDataAt, { minimum: 1 })
        : null;
      const result = db.prepare(`
        INSERT OR IGNORE INTO monitor_events(
          event_type, asset_type, wallet_address, wallet_alias, counterparty_address, platform,
          token_address, token_symbol, token_name,
          token_amount, raw_token_amount, token_decimals, tx_hash, log_index,
          block_number, block_timestamp, detected_at, sound_alert, bark_alert,
          market_cap_usd, liquidity_usd, token_creation_timestamp, market_data_at,
          risk_payload, risk_data_at
        ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
      `).run(
        eventType,
        assetType,
        normalizeAddress(event.walletAddress),
        String(event.walletAlias || ''),
        normalizeAddress(event.counterpartyAddress),
        String(event.platform || ''),
        normalizeAddress(event.tokenAddress),
        String(event.tokenSymbol || event.tokenAddress || ''),
        String(event.tokenName || event.tokenSymbol || event.tokenAddress || ''),
        String(event.tokenAmount ?? '0'),
        String(event.rawTokenAmount ?? '0'),
        Number(event.tokenDecimals ?? 18),
        normalizeTransaction(event.txHash),
        Number(event.logIndex),
        Number(event.blockNumber),
        Number(event.blockTimestamp),
        Number(event.detectedAt || Math.floor(Date.now() / 1000)),
        event.soundAlert === true ? 1 : 0,
        event.barkAlert === true ? 1 : 0,
        event.marketCapUsd !== null && event.marketCapUsd !== undefined && event.marketCapUsd !== '' &&
          Number.isFinite(Number(event.marketCapUsd)) && Number(event.marketCapUsd) >= 0
          ? Number(event.marketCapUsd)
          : null,
        liquidityUsd,
        Number.isSafeInteger(Number(event.tokenCreationTimestamp)) && Number(event.tokenCreationTimestamp) > 0
          ? Number(event.tokenCreationTimestamp)
          : null,
        Number.isSafeInteger(Number(event.marketDataAt)) && Number(event.marketDataAt) > 0
          ? Number(event.marketDataAt)
          : null,
        storesTokenRisk ? json(risk) : null,
        riskDataAt
      );
      const row = db.prepare('SELECT * FROM monitor_events WHERE tx_hash = ? AND log_index = ?').get(
        normalizeTransaction(event.txHash),
        Number(event.logIndex)
      );
      return { inserted: Number(result.changes) > 0, event: monitorEventFromRow(row) };
    },
    updateMonitorEventsTokenMarketData(tokenAddress, marketData, { eventIds } = {}) {
      const address = normalizeAddress(tokenAddress);
      if (!isValidAddress(address)) throw new TypeError('Invalid monitor token address');
      const marketCap = marketData.marketCapUsd === null || marketData.marketCapUsd === undefined ||
        marketData.marketCapUsd === '' ? NaN : Number(marketData.marketCapUsd);
      const marketCapUsd = Number.isFinite(marketCap) && marketCap >= 0 ? marketCap : null;
      const liquidity = marketData.liquidityUsd === null || marketData.liquidityUsd === undefined ||
        marketData.liquidityUsd === '' ? NaN : Number(marketData.liquidityUsd);
      const liquidityUsd = Number.isFinite(liquidity) && liquidity >= 0 ? liquidity : null;
      const creationTimestamp = Number(marketData.tokenCreationTimestamp);
      const tokenCreationTimestamp = Number.isSafeInteger(creationTimestamp) && creationTimestamp > 0
        ? creationTimestamp
        : null;
      const fetchedAt = Number(marketData.marketDataAt);
      const marketDataAt = (marketCapUsd !== null || liquidityUsd !== null) &&
        Number.isSafeInteger(fetchedAt) && fetchedAt > 0
        ? fetchedAt
        : null;
      if (marketCapUsd === null && liquidityUsd === null && tokenCreationTimestamp === null) return [];
      const hasEventFilter = Array.isArray(eventIds);
      const normalizedEventIds = hasEventFilter
        ? [...new Set(eventIds.map(Number).filter((id) => Number.isSafeInteger(id) && id > 0))]
        : [];
      if (hasEventFilter && normalizedEventIds.length === 0) return [];
      const eventFilter = hasEventFilter
        ? ` AND id IN (${normalizedEventIds.map(() => '?').join(', ')})`
        : '';
      const rows = db.prepare(`
        SELECT id
        FROM monitor_events
        WHERE token_address = ?
          AND ((? IS NOT NULL AND market_cap_usd IS NULL)
            OR (? IS NOT NULL AND liquidity_usd IS NULL)
            OR (? IS NOT NULL AND token_creation_timestamp IS NULL))
          ${eventFilter}
        ORDER BY id
      `).all(address, marketCapUsd, liquidityUsd, tokenCreationTimestamp, ...normalizedEventIds);
      if (!rows.length) return [];
      db.exec('BEGIN');
      try {
        db.prepare(`
          UPDATE monitor_events
          SET market_cap_usd = COALESCE(market_cap_usd, ?),
              liquidity_usd = COALESCE(liquidity_usd, ?),
              token_creation_timestamp = COALESCE(token_creation_timestamp, ?),
              market_data_at = COALESCE(market_data_at, ?)
          WHERE token_address = ?
            AND ((? IS NOT NULL AND market_cap_usd IS NULL)
              OR (? IS NOT NULL AND liquidity_usd IS NULL)
              OR (? IS NOT NULL AND token_creation_timestamp IS NULL))
            ${eventFilter}
        `).run(
          marketCapUsd,
          liquidityUsd,
          tokenCreationTimestamp,
          marketDataAt,
          address,
          marketCapUsd,
          liquidityUsd,
          tokenCreationTimestamp,
          ...normalizedEventIds
        );
        db.exec('COMMIT');
      } catch (error) {
        db.exec('ROLLBACK');
        throw error;
      }
      const select = db.prepare('SELECT * FROM monitor_events WHERE id = ?');
      return rows.map((row) => monitorEventFromRow(select.get(row.id)));
    },
    updateMonitorEventsTokenRiskData(tokenAddress, riskData, { eventIds, replace = false } = {}) {
      const address = normalizeAddress(tokenAddress);
      if (!isValidAddress(address)) throw new TypeError('Invalid monitor token address');
      const risk = normalizeMonitorTokenRisk(riskData);
      const liquidityUsd = optionalFiniteNumber(riskData.liquidityUsd, { minimum: 0 });
      const replaceLiquidity = replace && Object.hasOwn(riskData, 'liquidityUsd');
      const riskDataAt = optionalFiniteNumber(riskData.tokenRiskDataAt, { minimum: 1 });
      const hasEventFilter = Array.isArray(eventIds);
      const normalizedEventIds = hasEventFilter
        ? [...new Set(eventIds.map(Number).filter((id) => Number.isSafeInteger(id) && id > 0))]
        : [];
      if (hasEventFilter && normalizedEventIds.length === 0) return [];
      const eventFilter = hasEventFilter
        ? ` AND id IN (${normalizedEventIds.map(() => '?').join(', ')})`
        : '';
      const rows = db.prepare(`
        SELECT id
        FROM monitor_events
        WHERE token_address = ?${eventFilter}
        ORDER BY id
      `).all(address, ...normalizedEventIds);
      if (!rows.length) return [];
      db.prepare(`
        UPDATE monitor_events
        SET liquidity_usd = CASE
              WHEN ? = 1 THEN ?
              ELSE COALESCE(liquidity_usd, ?)
            END,
            risk_payload = ?,
            risk_data_at = COALESCE(?, risk_data_at)
        WHERE token_address = ?${eventFilter}
      `).run(
        replaceLiquidity ? 1 : 0,
        liquidityUsd,
        liquidityUsd,
        json(risk),
        riskDataAt,
        address,
        ...normalizedEventIds
      );
      const select = db.prepare('SELECT * FROM monitor_events WHERE id = ?');
      return rows.map((row) => monitorEventFromRow(select.get(row.id)));
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
    listMonitorEventsNeedingTokenRisk({ limit = 500 } = {}) {
      if (normalizedChainId !== 'robinhood') return [];
      const normalizedLimit = Math.max(1, Math.min(500, Math.floor(Number(limit) || 500)));
      const safePayload = "CASE WHEN json_valid(risk_payload) THEN risk_payload ELSE '{}' END";
      return db.prepare(`
        SELECT *
        FROM monitor_events
        WHERE asset_type = 'erc20'
          AND (
            json_extract(${safePayload}, '$.tokenRiskStatus') = 'pending'
            OR (
              json_extract(${safePayload}, '$.tokenRiskStatus') = 'partial'
              AND (
                json_extract(${safePayload}, '$.creatorTokenCount') IS NULL
                OR json_extract(${safePayload}, '$.creatorDeadTokenCount') IS NULL
              )
            )
          )
        ORDER BY id ASC
        LIMIT ?
      `).all(normalizedLimit).map(monitorEventFromRow);
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
