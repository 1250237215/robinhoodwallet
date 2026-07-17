import path from 'node:path';
import { pathToFileURL } from 'node:url';

import { BARK_SOUNDS, createRobinhoodBarkNotifier } from '../robinhood/bark.js';
import { createRobinhoodConfig } from '../robinhood/config.js';
import { RobinhoodDebotClient } from '../robinhood/debotClient.js';
import { scanTokenHolders } from '../robinhood/holderScanner.js';
import { createRobinhoodService } from '../robinhood/service.js';
import { createRobinhoodStore } from '../robinhood/store.js';
import { createRobinhoodStandaloneServer } from '../robinhoodServer.js';
import {
  isSolanaAddress,
  normalizeSolanaAddress,
  normalizeSolanaSignature
} from './address.js';
import { SolanaHolderClient, SPL_TOKEN_2022_PROGRAM_ID, SPL_TOKEN_PROGRAM_ID } from './holderClient.js';
import { HeliusWebhookManager } from './heliusWebhookManager.js';
import { SolanaCompositeMarketClient, SolanaDexScreenerClient } from './marketClient.js';
import { SOLANA_PUBLIC_RPC_URL, SolanaRpcClient } from './rpcClient.js';
import {
  SOLANA_USDC_MINT,
  SOLANA_USDT_MINT,
  SolanaHeliusWebhookMonitor,
  SolanaWebhookAuthenticationError,
  WRAPPED_SOL_MINT
} from './webhookMonitor.js';

const MONITOR_SOUNDS = new Set(['alarm', 'bell', 'electronic', 'glass']);
const SETTINGS_KEYS = Object.freeze({
  enabled: 'solana:monitor:enabled',
  threshold: 'solana:monitor:threshold',
  windowSeconds: 'solana:monitor:window-seconds',
  sound: 'solana:monitor:sound',
  volume: 'solana:monitor:volume',
  barkSound: 'solana:monitor:bark-sound',
  barkVolume: 'solana:monitor:bark-volume'
});

function normalizeOptionalAddress(value) {
  const text = String(value || '').trim();
  return text ? normalizeSolanaAddress(text) : '';
}

function normalizeInputAddress(value) {
  return String(value || '').trim();
}

function normalizeTransaction(value) {
  const text = String(value || '').trim();
  return text ? normalizeSolanaSignature(text) : '';
}

export const SOLANA_CHAIN = Object.freeze({
  id: 'solana',
  key: 'solana',
  name: 'Solana',
  chainId: 'solana',
  debotChain: 'solana',
  rpcUrl: SOLANA_PUBLIC_RPC_URL,
  explorerUrl: 'https://solscan.io',
  debotAddressRoot: 'https://debot.ai/address/solana',
  debotTokenRoot: 'https://debot.ai/token/solana/',
  holderSource: 'solana_rpc_program_accounts',
  nativeSymbol: 'SOL',
  nativeName: 'Solana',
  nativeDecimals: 9,
  wrappedNative: WRAPPED_SOL_MINT,
  usdc: SOLANA_USDC_MINT,
  usdt: SOLANA_USDT_MINT,
  tokenProgram: SPL_TOKEN_PROGRAM_ID,
  token2022Program: SPL_TOKEN_2022_PROGRAM_ID,
  quoteTokens: Object.freeze([WRAPPED_SOL_MINT, SOLANA_USDC_MINT, SOLANA_USDT_MINT]),
  infrastructureAddresses: Object.freeze([
    SPL_TOKEN_PROGRAM_ID,
    SPL_TOKEN_2022_PROGRAM_ID,
    WRAPPED_SOL_MINT,
    SOLANA_USDC_MINT,
    SOLANA_USDT_MINT
  ]),
  addressNormalizer: normalizeOptionalAddress,
  addressValidator: isSolanaAddress,
  transactionNormalizer: normalizeTransaction
});

export const SOLANA_ADDRESS_CODEC = Object.freeze({
  chainId: 'solana',
  label: 'Solana',
  normalize: normalizeInputAddress,
  validate: isSolanaAddress
});

function boundedNumber(value, fallback, minimum, maximum) {
  const number = Number(value);
  if (!Number.isFinite(number)) return fallback;
  return Math.min(maximum, Math.max(minimum, number));
}

export function createSolanaConfig(env = process.env) {
  const defaults = createRobinhoodConfig({});
  return {
    ...defaults,
    chain: SOLANA_CHAIN,
    chainId: SOLANA_CHAIN.id,
    chainLabel: SOLANA_CHAIN.name,
    addressNormalizer: normalizeOptionalAddress,
    addressValidator: isSolanaAddress,
    transactionNormalizer: normalizeTransaction,
    debotAddressRoot: SOLANA_CHAIN.debotAddressRoot,
    rpcUrl: env.SOLANA_RPC_URL || SOLANA_CHAIN.rpcUrl,
    dataFile: env.SOLANA_DATA_FILE || new URL('../../data/solana.sqlite', import.meta.url).pathname,
    requestTimeoutMs: boundedNumber(env.SOLANA_REQUEST_TIMEOUT_MS, 20_000, 1_000, 120_000),
    rpcMaxRetries: boundedNumber(env.SOLANA_RPC_MAX_RETRIES, 3, 0, 12),
    rpcRetryDelayMs: boundedNumber(env.SOLANA_RPC_RETRY_DELAY_MS, 500, 0, 60_000),
    rpcMaxRetryDelayMs: boundedNumber(env.SOLANA_RPC_MAX_RETRY_DELAY_MS, 8_000, 100, 120_000),
    rpcMaxResponseBytes: boundedNumber(
      env.SOLANA_RPC_MAX_RESPONSE_BYTES,
      24 * 1024 * 1024,
      64 * 1024,
      256 * 1024 * 1024
    ),
    holderMaxAccounts: boundedNumber(env.SOLANA_HOLDER_MAX_ACCOUNTS, 50_000, 20, 1_000_000),
    holderCandidateLimit: boundedNumber(env.SOLANA_HOLDER_CANDIDATE_LIMIT, 100, 10, 500),
    holderFetchLimit: boundedNumber(env.SOLANA_HOLDER_FETCH_LIMIT, 150, 10, 1_000),
    holderProfitConcurrency: boundedNumber(env.SOLANA_HOLDER_PROFIT_CONCURRENCY, 6, 1, 20),
    minEntryUsd: boundedNumber(env.SOLANA_MIN_ENTRY_USD, 500, 0, 10_000_000),
    defaultWinnerMultiple: boundedNumber(env.SOLANA_WINNER_MULTIPLE, 10, 1, 1_000),
    scanConcurrency: boundedNumber(env.SOLANA_SCAN_CONCURRENCY, 1, 1, 4),
    webhookBodyLimit: boundedNumber(env.SOLANA_WEBHOOK_BODY_LIMIT, 4 * 1024 * 1024, 64 * 1024, 16 * 1024 * 1024),
    signatureMaximum: boundedNumber(env.SOLANA_SIGNATURE_MAXIMUM, 100_000, 1_000, 1_000_000),
    signatureTtlSeconds: boundedNumber(
      env.SOLANA_SIGNATURE_TTL_SECONDS,
      7 * 24 * 60 * 60,
      3_600,
      90 * 24 * 60 * 60
    ),
    heliusApiKey: String(env.HELIUS_API_KEY || env.SOLANA_HELIUS_API_KEY || ''),
    heliusWebhookUrl: String(env.SOLANA_HELIUS_WEBHOOK_URL || ''),
    heliusAuthHeader: String(env.SOLANA_HELIUS_AUTH_HEADER || ''),
    heliusSyncIntervalMs: boundedNumber(env.SOLANA_HELIUS_SYNC_INTERVAL_MS, 30_000, 1_000, 10 * 60_000),
    host: String(env.SOLANA_HOST || env.HOST || '127.0.0.1'),
    port: boundedNumber(env.SOLANA_PORT, 18_120, 1, 65_535)
  };
}

function integerSetting(store, key, fallback, minimum, maximum) {
  const value = Number(store.getMeta(key));
  return Number.isInteger(value) && value >= minimum && value <= maximum ? value : fallback;
}

function stringSetting(store, key, fallback, allowed) {
  const value = String(store.getMeta(key) || '');
  return allowed.has(value) ? value : fallback;
}

function isoFromSeconds(value) {
  const seconds = Number(value);
  return Number.isFinite(seconds) ? new Date(seconds * 1_000).toISOString() : null;
}

function publicEvent(event) {
  return {
    ...event,
    chain: 'solana',
    blockTimestampUnix: Number(event.blockTimestamp),
    blockTimestamp: isoFromSeconds(event.blockTimestamp),
    detectedAtUnix: Number(event.detectedAt),
    detectedAt: isoFromSeconds(event.detectedAt),
    debotAddressUrl: `${SOLANA_CHAIN.debotAddressRoot}/${event.walletAddress}`,
    debotTokenUrl: event.tokenAddress ? `${SOLANA_CHAIN.debotTokenRoot}${event.tokenAddress}` : '',
    explorerTxUrl: `${SOLANA_CHAIN.explorerUrl}/tx/${event.txHash}`
  };
}

class StoreSolanaSignatureStore {
  constructor(store, { maximum = 100_000, ttlSeconds = 7 * 24 * 60 * 60, now = Date.now } = {}) {
    this.store = store;
    this.maximum = Math.max(1_000, Math.min(1_000_000, Math.floor(Number(maximum) || 100_000)));
    this.ttlSeconds = Math.max(
      3_600,
      Math.min(90 * 24 * 60 * 60, Math.floor(Number(ttlSeconds) || 7 * 24 * 60 * 60))
    );
    this.now = now;
    this.claims = 0;
    this.durable = true;
    this.store.db.exec(`
      CREATE TABLE IF NOT EXISTS solana_webhook_signatures (
        signature TEXT PRIMARY KEY,
        claimed_at INTEGER NOT NULL
      );
      CREATE INDEX IF NOT EXISTS solana_webhook_signatures_claimed_at_idx
        ON solana_webhook_signatures(claimed_at);
    `);
  }

  async claim(signature) {
    const normalized = normalizeSolanaSignature(signature);
    const now = Math.floor(this.now() / 1_000);
    const cutoff = now - this.ttlSeconds;
    this.store.db.prepare(
      'DELETE FROM solana_webhook_signatures WHERE signature = ? AND claimed_at < ?'
    ).run(normalized, cutoff);
    const result = this.store.db.prepare(
      'INSERT OR IGNORE INTO solana_webhook_signatures(signature, claimed_at) VALUES (?, ?)'
    ).run(normalized, now);
    this.claims += 1;
    if (this.claims === 1 || this.claims % 100 === 0) {
      this.store.db.prepare('DELETE FROM solana_webhook_signatures WHERE claimed_at < ?').run(cutoff);
      const count = Number(
        this.store.db.prepare('SELECT COUNT(*) AS count FROM solana_webhook_signatures').get().count
      );
      if (count > this.maximum) {
        this.store.db.prepare(`
          DELETE FROM solana_webhook_signatures
          WHERE signature IN (
            SELECT signature FROM solana_webhook_signatures
            ORDER BY claimed_at, signature
            LIMIT ?
          )
        `).run(count - this.maximum);
      }
    }
    return Number(result.changes) > 0;
  }

  async release(signature) {
    const normalized = normalizeSolanaSignature(signature);
    return Number(
      this.store.db.prepare('DELETE FROM solana_webhook_signatures WHERE signature = ?').run(normalized).changes
    ) > 0;
  }
}

export class SolanaRuntimeMonitor {
  constructor({
    store,
    webhookMonitor,
    barkNotifier = null,
    marketDataClient = null,
    debotClient = null,
    heliusWebhookManager = null,
    now = Date.now
  } = {}) {
    if (!store?.insertMonitorEvent || !store?.listMonitorEvents || !store?.listWalletAnnotations) {
      throw new TypeError('A Solana monitor store is required');
    }
    if (!webhookMonitor?.ingest || !webhookMonitor?.getHealth) {
      throw new TypeError('A Solana webhook monitor is required');
    }
    this.store = store;
    this.webhookMonitor = webhookMonitor;
    this.barkNotifier = barkNotifier;
    this.marketDataClient = marketDataClient || debotClient;
    this.heliusWebhookManager = heliusWebhookManager;
    this.now = now;
    this.listeners = new Set();
    this.closed = false;
    this.lastWebhookAt = null;
    this.lastWebhookError = '';
    this.lastEnrichmentError = '';
    this.ingestQueue = Promise.resolve();
    this.enrichmentJobs = new Map();
    this.settings = {
      enabled: store.getMeta(SETTINGS_KEYS.enabled) !== 'false',
      threshold: integerSetting(store, SETTINGS_KEYS.threshold, 6, 1, 1_000),
      windowSeconds: integerSetting(store, SETTINGS_KEYS.windowSeconds, 120, 5, 3_600),
      sound: stringSetting(store, SETTINGS_KEYS.sound, 'alarm', MONITOR_SOUNDS),
      volume: integerSetting(store, SETTINGS_KEYS.volume, 80, 0, 100),
      barkSound: stringSetting(store, SETTINGS_KEYS.barkSound, 'alarm', BARK_SOUNDS),
      barkVolume: integerSetting(store, SETTINGS_KEYS.barkVolume, 5, 0, 10)
    };
  }

  async start() {
    await this.heliusWebhookManager?.start?.();
    const snapshot = this.getSnapshot();
    this.#emit('health', snapshot.health);
    return snapshot;
  }

  close() {
    if (this.closed) return;
    this.closed = true;
    this.heliusWebhookManager?.close?.();
    this.#emit('close', { stoppedAt: new Date(this.now()).toISOString() });
    this.listeners.clear();
  }

  subscribe(listener) {
    if (typeof listener !== 'function') throw new TypeError('Monitor listener must be a function');
    this.listeners.add(listener);
    return () => this.listeners.delete(listener);
  }

  #emit(type, data) {
    for (const listener of this.listeners) {
      try {
        listener({ type, data });
      } catch {
        // A disconnected SSE listener must not interrupt webhook persistence.
      }
    }
  }

  getHealth() {
    const ingest = this.webhookMonitor.getHealth();
    const provider = this.heliusWebhookManager?.getHealth?.() || {
      status: 'degraded',
      realtimeReady: false,
      reasons: ['helius_webhook_manager_missing'],
      synced: false,
      syncing: false,
      lastError: ''
    };
    const reasons = [...new Set([...(ingest.reasons || []), ...(provider.reasons || [])])];
    const realtimeReady = ingest.reasons?.length === 0 && provider.realtimeReady === true;
    const monitoredWallets = this.store.listMonitoredWalletAnnotations().length;
    return {
      ...ingest,
      status: realtimeReady ? 'healthy' : 'degraded',
      realtimeReady,
      reasons,
      providerSynced: provider.synced === true,
      providerSyncing: provider.syncing === true,
      providerWebhookIdPresent: provider.webhookIdPresent === true,
      providerDesiredAddressCount: provider.desiredAddressCount ?? monitoredWallets,
      providerSyncedAddressCount: provider.syncedAddressCount ?? 0,
      providerLastSyncedAt: provider.lastSyncedAt || null,
      providerLastError: provider.lastError || '',
      monitoredWallets,
      lastWebhookAt: this.lastWebhookAt,
      lastWebhookError: this.lastWebhookError,
      lastEnrichmentError: this.lastEnrichmentError,
      source: 'helius_enhanced_webhook',
      latencyTargetMs: 5_000
    };
  }

  scheduleProviderSync() {
    if (!this.heliusWebhookManager?.syncNow) return Promise.resolve(this.getHealth());
    return this.heliusWebhookManager.syncNow().then(() => {
      const health = this.getHealth();
      this.#emit('health', health);
      return health;
    });
  }

  getEvents({ after = 0, limit = 100 } = {}) {
    return this.store.listMonitorEvents({ after, limit }).map(publicEvent);
  }

  getClusters() {
    const cutoff = Math.floor(this.now() / 1_000) - this.settings.windowSeconds;
    const grouped = new Map();
    for (const event of this.store.listRecentMonitorEvents(cutoff, { limit: 50_000 })) {
      if (event.eventType !== 'buy' || !event.tokenAddress) continue;
      const cluster = grouped.get(event.tokenAddress) || {
        tokenAddress: event.tokenAddress,
        tokenSymbol: event.tokenSymbol,
        tokenName: event.tokenName,
        eventCount: 0,
        firstSeenAt: event.blockTimestamp,
        lastSeenAt: event.blockTimestamp,
        wallets: new Map()
      };
      cluster.eventCount += 1;
      cluster.firstSeenAt = Math.min(cluster.firstSeenAt, event.blockTimestamp);
      cluster.lastSeenAt = Math.max(cluster.lastSeenAt, event.blockTimestamp);
      cluster.wallets.set(event.walletAddress, { address: event.walletAddress, alias: event.walletAlias || '' });
      grouped.set(event.tokenAddress, cluster);
    }
    return [...grouped.values()].map((cluster) => {
      const wallets = [...cluster.wallets.values()];
      return {
        tokenAddress: cluster.tokenAddress,
        tokenSymbol: cluster.tokenSymbol,
        tokenName: cluster.tokenName,
        eventCount: cluster.eventCount,
        distinctWallets: wallets.length,
        walletCount: wallets.length,
        wallets,
        firstSeenAt: isoFromSeconds(cluster.firstSeenAt),
        lastSeenAt: isoFromSeconds(cluster.lastSeenAt),
        threshold: this.settings.threshold,
        windowSeconds: this.settings.windowSeconds,
        triggered: wallets.length >= this.settings.threshold,
        chain: 'solana',
        debotTokenUrl: `${SOLANA_CHAIN.debotTokenRoot}${cluster.tokenAddress}`
      };
    }).sort((left, right) => Number(right.triggered) - Number(left.triggered) ||
      right.distinctWallets - left.distinctWallets || Date.parse(right.lastSeenAt) - Date.parse(left.lastSeenAt));
  }

  getSnapshot({ eventLimit = 100 } = {}) {
    const health = this.getHealth();
    const status = this.closed
      ? 'stopped'
      : !this.settings.enabled
        ? 'disabled'
        : health.status === 'healthy'
          ? health.monitoredWallets > 0 ? 'live' : 'waiting_for_wallets'
          : 'degraded';
    return {
      ok: status !== 'degraded' && status !== 'stopped',
      chain: 'solana',
      status,
      settings: { ...this.settings },
      health,
      clusters: this.getClusters(),
      alertedTokenAddresses: this.store.listMonitorTokenAlerts().map((item) => item.tokenAddress),
      barkTargets: this.listBarkTargets(),
      events: eventLimit > 0 ? this.getEvents({ limit: eventLimit }) : [],
      updatedAt: new Date(this.now()).toISOString()
    };
  }

  updateSettings(patch = {}) {
    if (Object.hasOwn(patch, 'enabled')) {
      if (typeof patch.enabled !== 'boolean') throw new TypeError('enabled must be a boolean');
      this.settings.enabled = patch.enabled;
      this.store.setMeta(SETTINGS_KEYS.enabled, String(patch.enabled));
    }
    for (const [field, minimum, maximum] of [
      ['threshold', 1, 1_000],
      ['windowSeconds', 5, 3_600],
      ['volume', 0, 100],
      ['barkVolume', 0, 10]
    ]) {
      if (!Object.hasOwn(patch, field)) continue;
      const value = Number(patch[field]);
      if (!Number.isInteger(value) || value < minimum || value > maximum) {
        throw new RangeError(`${field} is outside the allowed range`);
      }
      this.settings[field] = value;
      this.store.setMeta(SETTINGS_KEYS[field], String(value));
    }
    if (Object.hasOwn(patch, 'sound')) {
      if (!MONITOR_SOUNDS.has(patch.sound)) throw new RangeError('sound is not supported');
      this.settings.sound = patch.sound;
      this.store.setMeta(SETTINGS_KEYS.sound, patch.sound);
    }
    if (Object.hasOwn(patch, 'barkSound')) {
      if (!BARK_SOUNDS.has(patch.barkSound)) throw new RangeError('barkSound is not supported');
      this.settings.barkSound = patch.barkSound;
      this.store.setMeta(SETTINGS_KEYS.barkSound, patch.barkSound);
    }
    const snapshot = this.getSnapshot();
    this.#emit('snapshot', snapshot);
    return snapshot;
  }

  listBarkTargets() {
    return this.barkNotifier?.listTargets?.() || [];
  }

  createBarkTarget(payload) {
    if (!this.barkNotifier?.createTarget) throw new Error('Bark notifications are unavailable');
    return this.barkNotifier.createTarget(payload);
  }

  updateBarkTarget(id, patch) {
    if (!this.barkNotifier?.updateTarget) throw new Error('Bark notifications are unavailable');
    return this.barkNotifier.updateTarget(id, patch);
  }

  deleteBarkTarget(id) {
    if (!this.barkNotifier?.deleteTarget) throw new Error('Bark notifications are unavailable');
    return this.barkNotifier.deleteTarget(id);
  }

  testBarkTarget(id) {
    if (!this.barkNotifier?.testTarget) throw new Error('Bark notifications are unavailable');
    return this.barkNotifier.testTarget(id, {
      sound: this.settings.barkSound,
      volume: this.settings.barkVolume
    });
  }

  ingestWebhook(payload, { authorization = '' } = {}) {
    const run = () => this.#ingestWebhook(payload, { authorization });
    const pending = this.ingestQueue.then(run, run);
    this.ingestQueue = pending.catch(() => {});
    return pending;
  }

  async #ingestWebhook(payload, { authorization }) {
    if (!this.webhookMonitor.authHeader) {
      const error = new Error('Solana webhook authorization is not configured');
      error.code = 'WEBHOOK_NOT_CONFIGURED';
      throw error;
    }
    if (!this.settings.enabled) {
      return { acceptedTransactions: 0, duplicateSignatures: [], invalidTransactions: [], events: [], disabled: true };
    }
    let result = null;
    try {
      result = await this.webhookMonitor.ingest(payload, {
        authorization,
        monitoredWallets: this.store.listMonitoredWalletAnnotations()
      });
      const insertedEvents = [];
      for (const candidate of result.events) {
        const cached = candidate.tokenAddress ? this.store.getMonitorTokenMetadata(candidate.tokenAddress) : null;
        const enriched = cached ? {
          ...candidate,
          tokenSymbol: cached.symbol || candidate.tokenSymbol,
          tokenName: cached.name || candidate.tokenName,
          tokenDecimals: cached.decimals ?? candidate.tokenDecimals,
          marketCapUsd: cached.marketCapUsd,
          tokenCreationTimestamp: cached.tokenCreationTimestamp,
          marketDataAt: cached.marketDataAt
        } : candidate;
        const stored = this.store.insertMonitorEvent(enriched);
        if (!stored.inserted) continue;
        const event = publicEvent(stored.event);
        insertedEvents.push(event);
        this.#emit('event', event);
        if (event.barkAlert) {
          void this.barkNotifier?.notifyWalletEvent?.({
            event,
            sound: this.settings.barkSound,
            volume: this.settings.barkVolume
          }).catch(() => {});
        }
        if (event.tokenAddress) this.#queueEnrichment(event.tokenAddress, event.id, event);
      }
      this.lastWebhookAt = new Date(this.now()).toISOString();
      this.lastWebhookError = '';
      this.#reconcileClusterAlerts();
      if (insertedEvents.length) this.#emit('snapshot', this.getSnapshot());
      return { ...result, events: insertedEvents };
    } catch (error) {
      if (result?.acceptedSignatures?.length) {
        await Promise.allSettled(
          result.acceptedSignatures.map((signature) => this.webhookMonitor.signatureStore.release(signature))
        );
      }
      this.lastWebhookError = error instanceof Error ? error.message : String(error);
      throw error;
    }
  }

  #reconcileClusterAlerts() {
    for (const cluster of this.getClusters()) {
      if (!cluster.triggered) continue;
      const alert = this.store.recordMonitorTokenAlert(cluster.tokenAddress, Math.floor(this.now() / 1_000));
      if (!alert.inserted) continue;
      void this.barkNotifier?.notifyAlert?.({
        cluster,
        threshold: this.settings.threshold,
        windowSeconds: this.settings.windowSeconds,
        sound: this.settings.barkSound,
        volume: this.settings.barkVolume
      }).catch(() => {});
    }
  }

  #queueEnrichment(tokenAddress, eventId, event) {
    if (!this.marketDataClient?.fetchTokenMetrics) return;
    const existing = this.enrichmentJobs.get(tokenAddress);
    if (existing) {
      existing.eventIds.add(eventId);
      return;
    }
    const state = {
      eventIds: new Set([eventId]),
      decimals: Number.isInteger(event?.tokenDecimals) ? event.tokenDecimals : null,
      promise: null
    };
    state.promise = (async () => {
      try {
        const metrics = await this.marketDataClient.fetchTokenMetrics(tokenAddress);
        this.store.upsertMonitorTokenMetadata({
          address: tokenAddress,
          symbol: metrics.symbol,
          name: metrics.name,
          decimals: metrics.decimals ?? state.decimals ?? 0,
          complete: true,
          updatedAt: metrics.updatedAt
        });
        const marketData = {
          address: tokenAddress,
          marketCapUsd: metrics.marketCapUsd,
          tokenCreationTimestamp: metrics.creationTimestamp,
          marketDataAt: metrics.updatedAt
        };
        this.store.upsertMonitorTokenMarketData(marketData);
        const updated = this.store.updateMonitorEventsTokenMarketData(tokenAddress, marketData, {
          eventIds: [...state.eventIds]
        });
        for (const event of updated) {
          this.#emit('event_update', publicEvent({
            ...event,
            tokenSymbol: metrics.symbol || event.tokenSymbol,
            tokenName: metrics.name || event.tokenName,
            tokenDecimals: metrics.decimals ?? state.decimals ?? event.tokenDecimals
          }));
        }
        this.lastEnrichmentError = '';
      } catch (error) {
        this.lastEnrichmentError = error instanceof Error ? error.message : String(error);
      } finally {
        this.enrichmentJobs.delete(tokenAddress);
      }
    })();
    this.enrichmentJobs.set(tokenAddress, state);
  }
}

async function readWebhookPayload(req, maximumBytes) {
  const chunks = [];
  let size = 0;
  for await (const chunk of req) {
    size += chunk.length;
    if (size > maximumBytes) {
      const error = new Error('Webhook body is too large');
      error.statusCode = 413;
      error.code = 'BODY_TOO_LARGE';
      throw error;
    }
    chunks.push(chunk);
  }
  let parsed;
  try {
    parsed = JSON.parse(Buffer.concat(chunks).toString('utf8'));
  } catch {
    const error = new Error('Webhook body must be valid JSON');
    error.statusCode = 400;
    error.code = 'INVALID_JSON';
    throw error;
  }
  if (!Array.isArray(parsed)) {
    const error = new Error('Helius webhook body must be an array');
    error.statusCode = 400;
    error.code = 'INVALID_WEBHOOK_BODY';
    throw error;
  }
  return parsed;
}

function sendJson(res, statusCode, body) {
  res.writeHead(statusCode, {
    'content-type': 'application/json; charset=utf-8',
    'cache-control': 'no-store'
  });
  res.end(JSON.stringify(body));
}

export function createSolanaExtraApiHandler({ monitor, maxBodyBytes = 4 * 1024 * 1024 } = {}) {
  if (!monitor?.ingestWebhook) throw new TypeError('A Solana runtime monitor is required');
  const maximum = boundedNumber(maxBodyBytes, 4 * 1024 * 1024, 1_024, 16 * 1024 * 1024);
  return async (req, res, url) => {
    if (/^\/api\/solana\/wallets?(?:\/|$)/.test(url.pathname) &&
      ['POST', 'PATCH', 'DELETE'].includes(req.method)) {
      res.once('finish', () => {
        if (res.statusCode < 400) void monitor.scheduleProviderSync?.().catch(() => {});
      });
    }
    if (url.pathname !== '/api/solana/monitor/webhook') return false;
    if (req.method !== 'POST') {
      res.setHeader('allow', 'POST');
      sendJson(res, 405, { ok: false, code: 'METHOD_NOT_ALLOWED', error: 'Method not allowed' });
      return true;
    }
    try {
      const payload = await readWebhookPayload(req, maximum);
      const result = await monitor.ingestWebhook(payload, {
        authorization: String(req.headers.authorization || '')
      });
      sendJson(res, 200, {
        ok: true,
        acceptedTransactions: result.acceptedTransactions,
        duplicateSignatures: result.duplicateSignatures.length,
        invalidTransactions: result.invalidTransactions,
        insertedEvents: result.events.length,
        disabled: result.disabled === true
      });
    } catch (error) {
      const authentication = error instanceof SolanaWebhookAuthenticationError;
      const notConfigured = error?.code === 'WEBHOOK_NOT_CONFIGURED';
      sendJson(res, authentication ? 401 : notConfigured ? 503 : error?.statusCode || 502, {
        ok: false,
        code: authentication ? 'INVALID_WEBHOOK_AUTH' : notConfigured
          ? 'WEBHOOK_NOT_CONFIGURED'
          : error?.code || 'WEBHOOK_INGEST_FAILED',
        error: authentication ? 'Invalid webhook authorization' : error instanceof Error ? error.message : String(error)
      });
    }
    return true;
  };
}

export function createSolanaRuntime(env = process.env, overrides = {}) {
  const config = overrides.config || createSolanaConfig(env);
  const store = overrides.store || createRobinhoodStore(config.dataFile, {
    chainId: 'solana',
    chainLabel: 'Solana',
    addressNormalizer: normalizeOptionalAddress,
    addressValidator: isSolanaAddress,
    transactionNormalizer: normalizeTransaction
  });
  const debotClient = overrides.debotClient || new RobinhoodDebotClient({
    chain: 'solana',
    timeoutMs: config.requestTimeoutMs,
    addressNormalizer: normalizeOptionalAddress,
    addressValidator: isSolanaAddress
  });
  const rpcClient = overrides.rpcClient || new SolanaRpcClient({
    rpcUrl: config.rpcUrl,
    timeoutMs: config.requestTimeoutMs,
    maxRetries: config.rpcMaxRetries,
    retryDelayMs: config.rpcRetryDelayMs,
    maxRetryDelayMs: config.rpcMaxRetryDelayMs,
    maxResponseBytes: config.rpcMaxResponseBytes
  });
  const holderClient = overrides.holderClient || new SolanaHolderClient({
    rpcClient,
    maxAccounts: config.holderMaxAccounts,
    maxResponseBytes: config.rpcMaxResponseBytes
  });
  const baseScanToken = overrides.scanToken || scanTokenHolders;
  const service = overrides.service || createRobinhoodService({
    config,
    store,
    debotClient,
    holderClient,
    scanToken: (options) => baseScanToken({
      ...options,
      chainProfile: SOLANA_CHAIN,
      holderSource: SOLANA_CHAIN.holderSource,
      addressNormalizer: normalizeOptionalAddress,
      addressValidator: isSolanaAddress
    }),
    scanConcurrency: config.scanConcurrency,
    chainId: 'solana',
    chainLabel: 'Solana',
    addressNormalizer: normalizeOptionalAddress,
    addressValidator: isSolanaAddress,
    transactionNormalizer: normalizeTransaction,
    debotAddressRoot: SOLANA_CHAIN.debotAddressRoot
  });
  const barkNotifier = overrides.barkNotifier || createRobinhoodBarkNotifier({
    store,
    timeoutMs: Math.min(15_000, config.requestTimeoutMs),
    brand: 'Solana'
  });
  const marketDataClient = overrides.marketDataClient || new SolanaCompositeMarketClient({
    primary: debotClient,
    fallback: overrides.dexScreenerClient || new SolanaDexScreenerClient({
      timeoutMs: Math.min(15_000, config.requestTimeoutMs)
    })
  });
  const signatureStore = overrides.signatureStore || new StoreSolanaSignatureStore(store, {
    maximum: config.signatureMaximum,
    ttlSeconds: config.signatureTtlSeconds
  });
  const webhookMonitor = overrides.webhookMonitor || new SolanaHeliusWebhookMonitor({
    apiKey: config.heliusApiKey,
    webhookUrl: config.heliusWebhookUrl,
    authHeader: config.heliusAuthHeader,
    signatureStore,
    quoteMints: SOLANA_CHAIN.quoteTokens
  });
  const heliusWebhookManager = overrides.heliusWebhookManager || new HeliusWebhookManager({
    store,
    apiKey: config.heliusApiKey,
    webhookUrl: config.heliusWebhookUrl,
    authHeader: config.heliusAuthHeader,
    addressProvider: () => store.listMonitoredWalletAnnotations(),
    fetchImpl: overrides.heliusFetchImpl || globalThis.fetch,
    timeoutMs: Math.min(15_000, config.requestTimeoutMs),
    syncIntervalMs: config.heliusSyncIntervalMs
  });
  const monitor = overrides.monitor || new SolanaRuntimeMonitor({
    store,
    webhookMonitor,
    barkNotifier,
    marketDataClient,
    heliusWebhookManager
  });
  return {
    config,
    store,
    service,
    monitor,
    webhookMonitor,
    heliusWebhookManager,
    barkNotifier,
    rpcClient,
    holderClient,
    debotClient,
    marketDataClient
  };
}

export function createSolanaStandaloneServer(runtime, { maxBodyBytes } = {}) {
  return createRobinhoodStandaloneServer({
    service: runtime.service,
    monitor: runtime.monitor,
    apiPrefix: '/api/solana',
    addressCodec: SOLANA_ADDRESS_CODEC,
    extraApiHandler: createSolanaExtraApiHandler({
      monitor: runtime.monitor,
      maxBodyBytes: maxBodyBytes ?? runtime.config.webhookBodyLimit
    }),
    servePublic: false
  });
}

export async function startSolanaStandaloneServer(env = process.env, overrides = {}) {
  const runtime = createSolanaRuntime(env, overrides);
  const server = createSolanaStandaloneServer(runtime, {
    maxBodyBytes: runtime.config.webhookBodyLimit
  });
  await new Promise((resolve, reject) => {
    server.once('error', reject);
    server.listen(runtime.config.port, runtime.config.host, resolve);
  });
  await runtime.service.start();
  await runtime.monitor.start();
  return {
    ...runtime,
    server,
    host: runtime.config.host,
    port: runtime.config.port
  };
}

async function main() {
  const running = await startSolanaStandaloneServer();
  console.log(`Solana smart money API: http://${running.host}:${running.port}/api/solana/`);
  const shutdown = () => {
    running.service.close();
    running.monitor.close();
    running.server.close(() => {
      running.store.close();
      process.exit(0);
    });
  };
  process.on('SIGINT', shutdown);
  process.on('SIGTERM', shutdown);
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  main().catch((error) => {
    console.error(error);
    process.exit(1);
  });
}
