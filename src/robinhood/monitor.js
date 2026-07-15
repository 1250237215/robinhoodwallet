import { ROBINHOOD_CHAIN } from './config.js';
import { BARK_SOUNDS } from './bark.js';
import { WALLET_MONITOR_EVENT_TYPES } from './monitorRules.js';

export const ERC20_TRANSFER_TOPIC = '0xddf252ad1be2c89b69c2b068fc378daa952ba7f163c4a11628f55a4df523b3ef';
export const V2_SWAP_TOPIC = '0xd78ad95fa46c994b6551d0da85fc275fe613ce37657fb8d5e3d130840159d822';
export const V3_SWAP_TOPIC = '0xc42079f94a6350d7e6235f29174924f928cc2ac818eb64fed8004e115fbcca67';
export const NOXA_TOKEN_LAUNCHED_TOPIC = '0xdb51ea9ad51ab453a65a4cb7e60c3cb378c9501bb002609f8f97778fb6c4235a';
export const NOXA_LAUNCH_FACTORY = '0xd9ec2db5f3d1b236843925949fe5bd8a3836fccb';

export const WALLET_EVENT_TYPES = WALLET_MONITOR_EVENT_TYPES;

const ADDRESS_PATTERN = /^0x[0-9a-f]{40}$/;
const HASH_PATTERN = /^0x[0-9a-f]{64}$/;
const MONITOR_CURSOR_KEY = 'robinhood:monitor:cursor';
const MONITOR_FAST_GAPS_KEY = 'robinhood:monitor:fast-gaps';
const MONITOR_FAST_WALLET_STARTS_KEY = 'robinhood:monitor:fast-wallet-starts';
const MONITOR_DEEP_LIVE_CURSOR_KEY = 'robinhood:monitor:deep-live-cursor';
const MONITOR_DEEP_GAPS_KEY = 'robinhood:monitor:deep-gaps';
const MONITOR_DEEP_WALLET_STARTS_KEY = 'robinhood:monitor:deep-wallet-starts';
const MONITOR_ENABLED_KEY = 'robinhood:monitor:enabled';
const MONITOR_THRESHOLD_KEY = 'robinhood:monitor:threshold';
const MONITOR_WINDOW_SECONDS_KEY = 'robinhood:monitor:window-seconds';
const MONITOR_SOUND_KEY = 'robinhood:monitor:sound';
const MONITOR_VOLUME_KEY = 'robinhood:monitor:volume';
const MONITOR_BARK_SOUND_KEY = 'robinhood:monitor:bark-sound';
const MONITOR_BARK_VOLUME_KEY = 'robinhood:monitor:bark-volume';
const MONITOR_SOUNDS = new Set(['alarm', 'bell', 'electronic', 'glass']);
const TOKEN_METADATA_RETRY_SECONDS = 15 * 60;
const MARKET_DATA_CACHE_SECONDS = 12;
const MARKET_DATA_RETRY_BASE_MS = 30_000;
const MARKET_DATA_RETRY_MAX_MS = 5 * 60_000;
const MARKET_DATA_MAX_FAILURES = 6;
const DEBOT_TOKEN_ROOT = 'https://debot.ai/token/robinhood/308574_';
const DECIMALS_SELECTOR = '0x313ce567';
const SYMBOL_SELECTOR = '0x95d89b41';
const NAME_SELECTOR = '0x06fdde03';

function normalizeAddress(value) {
  return String(value || '').toLowerCase();
}

function unixSeconds(now) {
  return Math.floor(now() / 1000);
}

function isoFromSeconds(value) {
  const number = Number(value);
  return Number.isFinite(number) ? new Date(number * 1000).toISOString() : null;
}

function parseInteger(value, fallback = null) {
  if (value === null || value === undefined || value === '') return fallback;
  const number = Number(value);
  return Number.isSafeInteger(number) && number >= 0 ? number : fallback;
}

function rpcInteger(value, fallback = null) {
  if (typeof value === 'number') return parseInteger(value, fallback);
  if (typeof value !== 'string' || !/^(?:0x[0-9a-f]+|[0-9]+)$/i.test(value)) return fallback;
  try {
    const number = Number(BigInt(value));
    return Number.isSafeInteger(number) && number >= 0 ? number : fallback;
  } catch {
    return fallback;
  }
}

function normalizeText(value, fallback, maximum) {
  const text = String(value || '')
    .replace(/[\u0000-\u001f\u007f]/g, '')
    .trim()
    .slice(0, maximum);
  return text || fallback;
}

function fallbackSymbol(address) {
  return `${address.slice(0, 6)}...${address.slice(-4)}`;
}

function topicForAddress(address) {
  return `0x${'0'.repeat(24)}${normalizeAddress(address).slice(2)}`;
}

function addressFromTopic(topic) {
  const normalized = String(topic || '').toLowerCase();
  if (!/^0x[0-9a-f]{64}$/.test(normalized)) return null;
  const address = `0x${normalized.slice(-40)}`;
  return ADDRESS_PATTERN.test(address) ? address : null;
}

function rawAmountFromLog(log) {
  const data = String(log?.data || '').toLowerCase();
  if (!/^0x[0-9a-f]{64,}$/.test(data)) return null;
  try {
    return BigInt(`0x${data.slice(2, 66)}`);
  } catch {
    return null;
  }
}

export function formatTokenAmount(rawAmount, decimals = 18) {
  const value = typeof rawAmount === 'bigint' ? rawAmount : BigInt(rawAmount);
  const places = Math.max(0, Math.min(255, Math.floor(Number(decimals) || 0)));
  if (places === 0) return value.toString();
  const digits = value.toString().padStart(places + 1, '0');
  const whole = digits.slice(0, -places);
  const fraction = digits.slice(-places).replace(/0+$/, '');
  return fraction ? `${whole}.${fraction}` : whole;
}

function decodeAbiString(value) {
  const hex = String(value || '').replace(/^0x/i, '');
  if (!hex || !/^[0-9a-f]+$/i.test(hex) || hex.length % 2 !== 0) return null;
  let payload = hex;
  if (hex.length >= 128) {
    try {
      const offset = Number(BigInt(`0x${hex.slice(0, 64)}`));
      const lengthOffset = offset * 2;
      if (Number.isSafeInteger(offset) && lengthOffset + 64 <= hex.length) {
        const length = Number(BigInt(`0x${hex.slice(lengthOffset, lengthOffset + 64)}`));
        const start = lengthOffset + 64;
        const end = start + length * 2;
        if (Number.isSafeInteger(length) && length >= 0 && end <= hex.length) payload = hex.slice(start, end);
      }
    } catch {
      return null;
    }
  } else if (hex.length >= 64) {
    payload = hex.slice(0, 64).replace(/(?:00)+$/, '');
  }
  if (!payload) return null;
  try {
    return new TextDecoder('utf-8', { fatal: false }).decode(Buffer.from(payload, 'hex'));
  } catch {
    return null;
  }
}

function decodeDecimals(value) {
  const hex = String(value || '').replace(/^0x/i, '');
  if (!hex || !/^[0-9a-f]+$/i.test(hex)) return null;
  try {
    const decimals = Number(BigInt(`0x${hex}`));
    return Number.isInteger(decimals) && decimals >= 0 && decimals <= 255 ? decimals : null;
  } catch {
    return null;
  }
}

function receiptHasSwap(receipt) {
  if (!receiptSucceeded(receipt)) return false;
  return (Array.isArray(receipt?.logs) ? receipt.logs : []).some((log) => {
    const topic = String(log?.topics?.[0] || '').toLowerCase();
    return topic === V2_SWAP_TOPIC || topic === V3_SWAP_TOPIC;
  });
}

function receiptSucceeded(receipt) {
  return Boolean(receipt) && rpcInteger(receipt.status, 1) !== 0;
}

function ruleFor(annotation, eventType) {
  const configured = annotation?.monitorRules?.[eventType];
  return {
    enabled: typeof configured?.enabled === 'boolean' ? configured.enabled : eventType === 'buy',
    sound: configured?.sound === true,
    bark: configured?.bark === true
  };
}

function hasEnabledRule(annotation, eventType) {
  return annotation?.status !== 'excluded' && ruleFor(annotation, eventType).enabled;
}

function rpcBigInt(value, fallback = null) {
  if (typeof value === 'bigint') return value >= 0n ? value : fallback;
  if (typeof value === 'number' && Number.isSafeInteger(value) && value >= 0) return BigInt(value);
  if (typeof value !== 'string' || !/^(?:0x[0-9a-f]+|[0-9]+)$/i.test(value)) return fallback;
  try {
    const parsed = BigInt(value);
    return parsed >= 0n ? parsed : fallback;
  } catch {
    return fallback;
  }
}

function emptyInput(value) {
  return value === undefined || value === null || /^(?:0x0*)?$/i.test(String(value));
}

function eventLinks(event) {
  return {
    ...event,
    debotAddressUrl: `https://debot.ai/address/robinhood/${event.walletAddress}`,
    debotTokenUrl: ADDRESS_PATTERN.test(event.tokenAddress) ? `${DEBOT_TOKEN_ROOT}${event.tokenAddress}` : '',
    explorerTxUrl: `${ROBINHOOD_CHAIN.explorerUrl}/tx/${event.txHash}`
  };
}

function publicEvent(event) {
  return eventLinks({
    ...event,
    blockTimestampUnix: Number(event.blockTimestamp),
    blockTimestamp: isoFromSeconds(event.blockTimestamp),
    detectedAtUnix: Number(event.detectedAt),
    detectedAt: isoFromSeconds(event.detectedAt)
  });
}

function eventKey(log) {
  return `${String(log?.transactionHash || '').toLowerCase()}:${rpcInteger(log?.logIndex, -1)}`;
}

function errorMessage(error) {
  return error instanceof Error ? error.message : String(error);
}

function boundedInteger(value, fallback, minimum, maximum) {
  const number = Number(value);
  if (!Number.isFinite(number)) return fallback;
  return Math.max(minimum, Math.min(maximum, Math.floor(number)));
}

function parseJson(value, fallback) {
  if (typeof value !== 'string' || !value.trim()) return fallback;
  try {
    return JSON.parse(value);
  } catch {
    return fallback;
  }
}

function normalizeBlockRanges(value) {
  if (!Array.isArray(value)) return [];
  const ranges = value
    .map((range) => ({
      fromBlock: parseInteger(range?.fromBlock ?? range?.from),
      toBlock: parseInteger(range?.toBlock ?? range?.to)
    }))
    .filter((range) => range.fromBlock !== null && range.toBlock !== null && range.fromBlock <= range.toBlock)
    .sort((left, right) => left.fromBlock - right.fromBlock || left.toBlock - right.toBlock);
  const merged = [];
  for (const range of ranges) {
    const previous = merged.at(-1);
    if (previous && range.fromBlock <= previous.toBlock + 1) {
      previous.toBlock = Math.max(previous.toBlock, range.toBlock);
    } else {
      merged.push({ ...range });
    }
  }
  return merged;
}

function countRangeBlocks(ranges) {
  return ranges.reduce((total, range) => total + range.toBlock - range.fromBlock + 1, 0);
}

function normalizeWalletStarts(value) {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return new Map();
  return new Map(Object.entries(value)
    .map(([address, blockNumber]) => [normalizeAddress(address), parseInteger(blockNumber)])
    .filter(([address, blockNumber]) => ADDRESS_PATTERN.test(address) && blockNumber !== null));
}

function isRpcPressureError(error) {
  const message = errorMessage(error);
  return Number(error?.status) === 429 || error?.kind === 'timeout' || error?.name === 'TimeoutError' ||
    /(?:^|\D)429(?:\D|$)|too many requests|rate.?limit|timed?\s*out|timeout/i.test(message);
}

function canFallbackFromTopicOr(error) {
  const message = errorMessage(error);
  return Number(error?.code) === -32602 || /invalid.{0,30}topics?|topics?.{0,30}(?:array|limit|unsupported)/i.test(message);
}

function throwIfAborted(signal) {
  if (!signal?.aborted) return;
  throw signal.reason instanceof Error ? signal.reason : new Error('Robinhood wallet monitor stopped');
}

export class RobinhoodWalletMonitor {
  constructor({
    store,
    rpcClient,
    pollIntervalMs = 500,
    degradedPollIntervalMs = 1_000,
    maxBlockSpan = 500,
    walletTopicChunkSize = 100,
    walletLogConcurrency = 2,
    recoverySuccesses = 20,
    fastLiveBlockSpan = 50,
    fastGapBlockSpan = 100,
    fastGapPollIntervalMs = 5_000,
    deepPollIntervalMs = 500,
    deepDegradedPollIntervalMs = 1_500,
    deepLiveBlockSpan = 20,
    deepGapBlockSpan = 20,
    deepGapPollIntervalMs = 5_000,
    tokenMetadataBudgetMs = 1_500,
    now = Date.now,
    monotonicNow = () => performance.now(),
    setTimer = setTimeout,
    clearTimer = clearTimeout,
    barkNotifier = null,
    debotClient = null,
    marketDataCacheSeconds = MARKET_DATA_CACHE_SECONDS,
    marketDataConcurrency = 2,
    marketDataRetryBaseMs = MARKET_DATA_RETRY_BASE_MS,
    marketDataRetryMaxMs = MARKET_DATA_RETRY_MAX_MS,
    quoteTokenAddresses = [ROBINHOOD_CHAIN.weth, ROBINHOOD_CHAIN.usdg],
    noxaLaunchFactory = NOXA_LAUNCH_FACTORY
  } = {}) {
    if (!store?.getMeta || !store?.setMeta || !store?.insertMonitorEvent) {
      throw new TypeError('A Robinhood monitor store is required');
    }
    if (!rpcClient?.getBlockNumber || !rpcClient?.getLogs) {
      throw new TypeError('A Robinhood RPC client is required');
    }
    this.store = store;
    this.rpcClient = rpcClient;
    this.pollIntervalMs = boundedInteger(pollIntervalMs, 500, 250, 60_000);
    this.degradedPollIntervalMs = Math.max(
      this.pollIntervalMs,
      boundedInteger(degradedPollIntervalMs, 1_000, 250, 60_000)
    );
    this.maxBlockSpan = boundedInteger(maxBlockSpan, 500, 1, 10_000);
    this.walletTopicChunkSize = boundedInteger(walletTopicChunkSize, 100, 1, 100);
    this.walletLogConcurrency = boundedInteger(walletLogConcurrency, 2, 1, 2);
    this.recoverySuccesses = boundedInteger(recoverySuccesses, 20, 1, 1_000);
    this.fastLiveBlockSpan = boundedInteger(fastLiveBlockSpan, 50, 1, 500);
    this.fastGapBlockSpan = boundedInteger(fastGapBlockSpan, 100, 1, 500);
    this.fastGapPollIntervalMs = boundedInteger(fastGapPollIntervalMs, 5_000, 1_000, 60_000);
    this.deepPollIntervalMs = boundedInteger(deepPollIntervalMs, 500, 250, 60_000);
    this.deepDegradedPollIntervalMs = Math.max(
      this.deepPollIntervalMs,
      boundedInteger(deepDegradedPollIntervalMs, 1_500, 250, 60_000)
    );
    this.deepLiveBlockSpan = boundedInteger(deepLiveBlockSpan, 20, 1, 100);
    this.deepGapBlockSpan = boundedInteger(deepGapBlockSpan, 20, 1, 100);
    this.deepGapPollIntervalMs = boundedInteger(deepGapPollIntervalMs, 5_000, 1_000, 60_000);
    this.tokenMetadataBudgetMs = boundedInteger(tokenMetadataBudgetMs, 1_500, 250, 4_000);
    this.now = now;
    this.monotonicNow = monotonicNow;
    this.setTimer = setTimer;
    this.clearTimer = clearTimer;
    this.barkNotifier = barkNotifier;
    if (debotClient !== null && typeof debotClient?.fetchTokenMetrics !== 'function') {
      throw new TypeError('A DeBot token metrics client is required');
    }
    this.debotClient = debotClient;
    this.marketDataCacheSeconds = boundedInteger(marketDataCacheSeconds, MARKET_DATA_CACHE_SECONDS, 10, 15);
    this.marketDataConcurrency = boundedInteger(marketDataConcurrency, 2, 1, 4);
    this.marketDataRetryBaseMs = boundedInteger(
      marketDataRetryBaseMs,
      MARKET_DATA_RETRY_BASE_MS,
      10,
      MARKET_DATA_RETRY_MAX_MS
    );
    this.marketDataRetryMaxMs = Math.max(
      this.marketDataRetryBaseMs,
      boundedInteger(marketDataRetryMaxMs, MARKET_DATA_RETRY_MAX_MS, 10, 60 * 60_000)
    );
    this.marketDataAbortController = new AbortController();
    this.marketDataQueue = [];
    this.marketDataQueued = new Map();
    this.marketDataLookups = new Map();
    this.marketDataRetryTimers = new Map();
    this.marketDataFailures = new Map();
    this.marketDataPendingEventIds = new Map();
    this.marketDataActive = 0;
    this.quoteTokenAddresses = new Set(quoteTokenAddresses.map(normalizeAddress).filter((value) => ADDRESS_PATTERN.test(value)));
    this.noxaLaunchFactory = normalizeAddress(noxaLaunchFactory);
    if (!ADDRESS_PATTERN.test(this.noxaLaunchFactory)) {
      throw new TypeError('A valid Noxa launch factory address is required');
    }
    this.settings = {
      enabled: this.store.getMeta(MONITOR_ENABLED_KEY) !== 'false',
      threshold: Math.max(1, Math.min(1_000, parseInteger(this.store.getMeta(MONITOR_THRESHOLD_KEY), 3))),
      windowSeconds: Math.max(5, Math.min(3_600, parseInteger(this.store.getMeta(MONITOR_WINDOW_SECONDS_KEY), 60))),
      sound: MONITOR_SOUNDS.has(this.store.getMeta(MONITOR_SOUND_KEY))
        ? this.store.getMeta(MONITOR_SOUND_KEY)
        : 'alarm',
      volume: Math.max(0, Math.min(100, parseInteger(this.store.getMeta(MONITOR_VOLUME_KEY), 70))),
      barkSound: BARK_SOUNDS.has(this.store.getMeta(MONITOR_BARK_SOUND_KEY))
        ? this.store.getMeta(MONITOR_BARK_SOUND_KEY)
        : 'alarm',
      barkVolume: Math.max(0, Math.min(10, parseInteger(this.store.getMeta(MONITOR_BARK_VOLUME_KEY), 5)))
    };
    this.cursor = parseInteger(this.store.getMeta(MONITOR_CURSOR_KEY));
    this.fastGaps = normalizeBlockRanges(parseJson(this.store.getMeta(MONITOR_FAST_GAPS_KEY), []));
    const fastWalletStarts = this.store.getMeta(MONITOR_FAST_WALLET_STARTS_KEY);
    this.fastWalletStartsInitialized = fastWalletStarts !== null;
    this.fastWalletStarts = normalizeWalletStarts(parseJson(fastWalletStarts, {}));
    this.deepCursor = parseInteger(this.store.getMeta(MONITOR_DEEP_LIVE_CURSOR_KEY));
    this.deepGaps = normalizeBlockRanges(parseJson(this.store.getMeta(MONITOR_DEEP_GAPS_KEY), []));
    this.deepWalletStarts = normalizeWalletStarts(
      parseJson(this.store.getMeta(MONITOR_DEEP_WALLET_STARTS_KEY), {})
    );
    this.started = false;
    this.closed = false;
    this.timer = null;
    this.pollPromise = null;
    this.abortController = null;
    this.fastGapTimer = null;
    this.fastGapPollPromise = null;
    this.fastGapAbortController = null;
    this.deepTimer = null;
    this.deepPollPromise = null;
    this.deepAbortController = null;
    this.gapTimer = null;
    this.gapPollPromise = null;
    this.gapAbortController = null;
    this.listeners = new Set();
    this.rpcProtection = {
      active: false,
      activeSince: null,
      reason: '',
      healthyPolls: 0,
      lastRecoveredAt: null
    };
    this.alertedTokens = new Set(
      (this.store.listMonitorTokenAlerts?.() || [])
        .map((alert) => normalizeAddress(alert.tokenAddress))
        .filter((address) => ADDRESS_PATTERN.test(address))
    );
    this.health = {
      chainHead: null,
      lastProcessedBlock: this.cursor,
      lagBlocks: null,
      monitoredWallets: 0,
      lastPollAt: null,
      lastSuccessAt: null,
      lastErrorAt: null,
      lastError: '',
      consecutiveErrors: 0,
      eventsDetected: 0,
      fastEventsDetected: 0,
      fastBacklogBlocks: null,
      fastLastRangeDurationMs: null,
      fastGapBlocks: countRangeBlocks(this.fastGaps),
      fastGapLastRangeDurationMs: null,
      fastGapLastSuccessAt: null,
      fastGapLastErrorAt: null,
      fastGapLastError: '',
      fastGapConsecutiveErrors: 0,
      deepChainHead: null,
      deepLiveCursor: this.deepCursor,
      deepLiveBacklogBlocks: null,
      deepLastRangeDurationMs: null,
      deepGapBlocks: countRangeBlocks(this.deepGaps),
      deepMonitoredWallets: 0,
      deepLastPollAt: null,
      deepLastSuccessAt: null,
      deepLastErrorAt: null,
      deepLastError: '',
      deepConsecutiveErrors: 0,
      deepEventsDetected: 0,
      deepGapLastRangeDurationMs: null,
      deepGapLastSuccessAt: null,
      deepGapLastErrorAt: null,
      deepGapLastError: '',
      deepGapConsecutiveErrors: 0
    };
    this.#reconcileBarkAlerts(false);
  }

  start() {
    if (this.closed || this.started) return this.getSnapshot();
    this.started = true;
    this.#queueRecentMarketData();
    this.#scheduleFast(0);
    this.#scheduleFastGap(this.fastGapPollIntervalMs);
    this.#scheduleDeep(0);
    this.#scheduleGap(this.deepGapPollIntervalMs);
    return this.getSnapshot();
  }

  close() {
    this.closed = true;
    this.started = false;
    if (this.timer) this.clearTimer(this.timer);
    if (this.fastGapTimer) this.clearTimer(this.fastGapTimer);
    if (this.deepTimer) this.clearTimer(this.deepTimer);
    if (this.gapTimer) this.clearTimer(this.gapTimer);
    this.timer = null;
    this.fastGapTimer = null;
    this.deepTimer = null;
    this.gapTimer = null;
    this.abortController?.abort(new Error('Robinhood wallet monitor stopped'));
    this.fastGapAbortController?.abort(new Error('Robinhood wallet fast-gap monitor stopped'));
    this.deepAbortController?.abort(new Error('Robinhood wallet deep monitor stopped'));
    this.gapAbortController?.abort(new Error('Robinhood wallet gap monitor stopped'));
    this.marketDataAbortController.abort(new Error('Robinhood wallet monitor stopped'));
    for (const timer of this.marketDataRetryTimers.values()) this.clearTimer(timer);
    this.marketDataRetryTimers.clear();
    this.marketDataQueue.length = 0;
    this.marketDataQueued.clear();
    this.marketDataPendingEventIds.clear();
    this.marketDataFailures.clear();
    this.abortController = null;
    this.fastGapAbortController = null;
    this.deepAbortController = null;
    this.gapAbortController = null;
    this.#emit('close', { stoppedAt: new Date(this.now()).toISOString() });
    this.listeners.clear();
  }

  subscribe(listener) {
    if (typeof listener !== 'function') throw new TypeError('Monitor listener must be a function');
    this.listeners.add(listener);
    return () => this.listeners.delete(listener);
  }

  updateSettings(patch = {}) {
    if (!patch || typeof patch !== 'object' || Array.isArray(patch)) {
      throw new TypeError('Monitor settings must be an object');
    }
    if (Object.hasOwn(patch, 'enabled')) {
      if (typeof patch.enabled !== 'boolean') throw new TypeError('enabled must be a boolean');
      this.settings.enabled = patch.enabled;
      this.store.setMeta(MONITOR_ENABLED_KEY, String(patch.enabled));
    }
    if (Object.hasOwn(patch, 'threshold')) {
      const threshold = Number(patch.threshold);
      if (!Number.isInteger(threshold) || threshold < 1 || threshold > 1_000) {
        throw new RangeError('threshold must be an integer from 1 to 1000');
      }
      this.settings.threshold = threshold;
      this.store.setMeta(MONITOR_THRESHOLD_KEY, String(threshold));
    }
    if (Object.hasOwn(patch, 'windowSeconds')) {
      const windowSeconds = Number(patch.windowSeconds);
      if (!Number.isInteger(windowSeconds) || windowSeconds < 5 || windowSeconds > 3_600) {
        throw new RangeError('windowSeconds must be an integer from 5 to 3600');
      }
      this.settings.windowSeconds = windowSeconds;
      this.store.setMeta(MONITOR_WINDOW_SECONDS_KEY, String(windowSeconds));
    }
    if (Object.hasOwn(patch, 'sound')) {
      if (!MONITOR_SOUNDS.has(patch.sound)) throw new RangeError('sound is not supported');
      this.settings.sound = patch.sound;
      this.store.setMeta(MONITOR_SOUND_KEY, patch.sound);
    }
    if (Object.hasOwn(patch, 'volume')) {
      const volume = Number(patch.volume);
      if (!Number.isInteger(volume) || volume < 0 || volume > 100) {
        throw new RangeError('volume must be an integer from 0 to 100');
      }
      this.settings.volume = volume;
      this.store.setMeta(MONITOR_VOLUME_KEY, String(volume));
    }
    if (Object.hasOwn(patch, 'barkSound')) {
      if (!BARK_SOUNDS.has(patch.barkSound)) throw new RangeError('barkSound is not supported');
      this.settings.barkSound = patch.barkSound;
      this.store.setMeta(MONITOR_BARK_SOUND_KEY, patch.barkSound);
    }
    if (Object.hasOwn(patch, 'barkVolume')) {
      const volume = Number(patch.barkVolume);
      if (!Number.isInteger(volume) || volume < 0 || volume > 10) {
        throw new RangeError('barkVolume must be an integer from 0 to 10');
      }
      this.settings.barkVolume = volume;
      this.store.setMeta(MONITOR_BARK_VOLUME_KEY, String(volume));
    }
    this.#reconcileBarkAlerts(false);
    this.#emit('snapshot', this.getSnapshot());
    if (this.started && !this.closed) {
      this.#scheduleFast(0, true);
      this.#scheduleDeep(0, true);
    }
    return this.getSnapshot();
  }

  getEvents({ after = 0, limit = 100 } = {}) {
    return this.store.listMonitorEvents({ after, limit }).map(publicEvent);
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

  getClusters() {
    const cutoff = unixSeconds(this.now) - this.settings.windowSeconds;
    const grouped = new Map();
    for (const event of this.store.listRecentMonitorEvents(cutoff, { limit: 50_000 })) {
      if ((event.eventType || 'buy') !== 'buy') continue;
      let cluster = grouped.get(event.tokenAddress);
      if (!cluster) {
        cluster = {
          tokenAddress: event.tokenAddress,
          tokenSymbol: event.tokenSymbol,
          tokenName: event.tokenName,
          eventCount: 0,
          firstSeenAt: event.blockTimestamp,
          lastSeenAt: event.blockTimestamp,
          walletMap: new Map()
        };
        grouped.set(event.tokenAddress, cluster);
      }
      cluster.eventCount += 1;
      cluster.firstSeenAt = Math.min(cluster.firstSeenAt, event.blockTimestamp);
      cluster.lastSeenAt = Math.max(cluster.lastSeenAt, event.blockTimestamp);
      cluster.walletMap.set(event.walletAddress, {
        address: event.walletAddress,
        alias: event.walletAlias || ''
      });
    }
    return [...grouped.values()]
      .map((cluster) => {
        const wallets = [...cluster.walletMap.values()];
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
          debotTokenUrl: `${DEBOT_TOKEN_ROOT}${cluster.tokenAddress}`
        };
      })
      .sort((a, b) => Number(b.triggered) - Number(a.triggered) || b.distinctWallets - a.distinctWallets ||
        Date.parse(b.lastSeenAt) - Date.parse(a.lastSeenAt));
  }

  getSnapshot({ eventLimit = 100 } = {}) {
    const deepStatus = this.#deepStatus();
    const status = this.closed
      ? 'stopped'
      : !this.settings.enabled
        ? 'disabled'
        : this.health.consecutiveErrors > 0 || this.rpcProtection.active
          ? 'degraded'
          : this.health.monitoredWallets === 0
            ? 'waiting_for_wallets'
            : this.pollPromise
              ? 'syncing'
              : 'live';
    return {
      ok: this.health.consecutiveErrors === 0,
      status,
      settings: { ...this.settings },
      barkTargets: this.listBarkTargets(),
      health: {
        ...this.health,
        deepStatus,
        started: this.started,
        running: this.started && !this.closed,
        syncing: Boolean(this.pollPromise),
        fastGapSyncing: Boolean(this.fastGapPollPromise),
        deepSyncing: Boolean(this.deepPollPromise),
        deepGapSyncing: Boolean(this.gapPollPromise),
        pollIntervalMs: this.#effectivePollIntervalMs(),
        fastPollIntervalMs: this.pollIntervalMs,
        degradedPollIntervalMs: this.degradedPollIntervalMs,
        fastLiveBlockSpan: this.fastLiveBlockSpan,
        fastGapBlockSpan: this.fastGapBlockSpan,
        fastGapPollIntervalMs: this.fastGapPollIntervalMs,
        deepPollIntervalMs: this.deepPollIntervalMs,
        deepEffectivePollIntervalMs: this.#effectiveDeepPollIntervalMs(),
        deepDegradedPollIntervalMs: this.deepDegradedPollIntervalMs,
        deepLiveBlockSpan: this.deepLiveBlockSpan,
        deepGapBlockSpan: this.deepGapBlockSpan,
        deepGapPollIntervalMs: this.deepGapPollIntervalMs,
        tokenMetadataBudgetMs: this.tokenMetadataBudgetMs,
        walletTopicChunkSize: this.walletTopicChunkSize,
        logConcurrency: this.#effectiveLogConcurrency(),
        maxLogConcurrency: this.walletLogConcurrency,
        rpcProtection: {
          ...this.rpcProtection,
          recoverySuccessesRequired: this.recoverySuccesses
        }
      },
      events: eventLimit > 0 ? this.getEvents({ limit: eventLimit }) : [],
      clusters: this.getClusters(),
      alertedTokenAddresses: [...this.alertedTokens].sort()
    };
  }

  async pollOnce() {
    if (this.closed) return this.getSnapshot();
    if (this.pollPromise) return this.pollPromise;
    this.pollPromise = this.#pollFast().finally(() => {
      this.pollPromise = null;
    });
    return this.pollPromise;
  }

  async pollFastGapOnce() {
    if (this.closed) return this.getSnapshot();
    if (this.fastGapPollPromise) return this.fastGapPollPromise;
    this.fastGapPollPromise = this.#pollFastGap().finally(() => {
      this.fastGapPollPromise = null;
    });
    return this.fastGapPollPromise;
  }

  async pollDeepOnce() {
    if (this.closed) return this.getSnapshot();
    if (this.deepPollPromise) return this.deepPollPromise;
    this.deepPollPromise = this.#pollDeep().finally(() => {
      this.deepPollPromise = null;
    });
    return this.deepPollPromise;
  }

  async pollGapOnce() {
    if (this.closed) return this.getSnapshot();
    if (this.gapPollPromise) return this.gapPollPromise;
    this.gapPollPromise = this.#pollGap().finally(() => {
      this.gapPollPromise = null;
    });
    return this.gapPollPromise;
  }

  #scheduleFast(delay, replace = false) {
    if (!this.started || this.closed) return;
    if (replace && this.timer) this.clearTimer(this.timer);
    else if (this.timer) return;
    this.timer = this.setTimer(async () => {
      this.timer = null;
      try {
        await this.pollOnce();
      } catch {
        // Health is updated in #pollFast; the next pass retries from the same cursor.
      }
      const lag = Number(this.health.lagBlocks);
      const caughtUp = !Number.isFinite(lag) || lag <= 0;
      const pollIntervalMs = this.#effectivePollIntervalMs();
      const backoff = this.health.consecutiveErrors
        ? Math.min(15_000, pollIntervalMs * (2 ** Math.min(4, this.health.consecutiveErrors)))
        : caughtUp ? pollIntervalMs : 10;
      this.#scheduleFast(backoff);
    }, Math.max(0, delay));
    this.timer?.unref?.();
  }

  #scheduleFastGap(delay, replace = false) {
    if (!this.started || this.closed) return;
    if (replace && this.fastGapTimer) this.clearTimer(this.fastGapTimer);
    else if (this.fastGapTimer) return;
    this.fastGapTimer = this.setTimer(async () => {
      this.fastGapTimer = null;
      try {
        await this.pollFastGapOnce();
      } catch {
        // Historical log gaps are isolated from the live fast lane.
      }
      const backoff = this.health.fastGapConsecutiveErrors
        ? Math.min(30_000, this.fastGapPollIntervalMs * (2 ** Math.min(3, this.health.fastGapConsecutiveErrors)))
        : this.fastGapPollIntervalMs;
      this.#scheduleFastGap(backoff);
    }, Math.max(0, delay));
    this.fastGapTimer?.unref?.();
  }

  #scheduleDeep(delay, replace = false) {
    if (!this.started || this.closed) return;
    if (replace && this.deepTimer) this.clearTimer(this.deepTimer);
    else if (this.deepTimer) return;
    this.deepTimer = this.setTimer(async () => {
      this.deepTimer = null;
      try {
        await this.pollDeepOnce();
      } catch {
        // Deep health is isolated from the fast lane and retries independently.
      }
      const lag = Number(this.health.deepLiveBacklogBlocks);
      const caughtUp = !Number.isFinite(lag) || lag <= 0;
      const pollIntervalMs = this.#effectiveDeepPollIntervalMs();
      const backoff = this.health.deepConsecutiveErrors
        ? Math.min(15_000, pollIntervalMs * (2 ** Math.min(4, this.health.deepConsecutiveErrors)))
        : caughtUp ? pollIntervalMs : 10;
      this.#scheduleDeep(backoff);
    }, Math.max(0, delay));
    this.deepTimer?.unref?.();
  }

  #scheduleGap(delay, replace = false) {
    if (!this.started || this.closed) return;
    if (replace && this.gapTimer) this.clearTimer(this.gapTimer);
    else if (this.gapTimer) return;
    this.gapTimer = this.setTimer(async () => {
      this.gapTimer = null;
      try {
        await this.pollGapOnce();
      } catch {
        // Historical gaps are low priority and never slow either live lane.
      }
      const backoff = this.health.deepGapConsecutiveErrors
        ? Math.min(30_000, this.deepGapPollIntervalMs * (2 ** Math.min(3, this.health.deepGapConsecutiveErrors)))
        : this.deepGapPollIntervalMs;
      this.#scheduleGap(backoff);
    }, Math.max(0, delay));
    this.gapTimer?.unref?.();
  }

  async #pollFast() {
    const polledAt = new Date(this.now()).toISOString();
    this.health.lastPollAt = polledAt;
    this.abortController = new AbortController();
    const { signal } = this.abortController;
    let detectedEvents = [];
    try {
      const chainHead = await this.rpcClient.getBlockNumber({ signal });
      this.health.chainHead = chainHead;
      const annotations = this.store.listMonitoredWalletAnnotations();
      const wallets = new Map(
        annotations
          .map((annotation) => [normalizeAddress(annotation.address), annotation])
          .filter(([address]) => ADDRESS_PATTERN.test(address))
      );
      this.health.monitoredWallets = wallets.size;
      const fastWallets = this.#fastWalletAddresses(wallets);
      this.#synchronizeFastWalletStarts(fastWallets, chainHead);

      if (this.cursor === null || this.cursor > chainHead) {
        this.#clearFastGaps();
        this.#advanceCursor(chainHead);
      } else if (chainHead > this.cursor) {
        if (!this.settings.enabled || fastWallets.size === 0) {
          this.#clearFastGaps();
          this.#advanceCursor(chainHead);
        } else {
          // A large outage must not make current buys wait behind historical logs.
          const fromBlock = Math.max(this.cursor + 1, chainHead - this.fastLiveBlockSpan + 1);
          if (fromBlock > this.cursor + 1) this.#enqueueFastGap(this.cursor + 1, fromBlock - 1);
          const startedAt = this.monotonicNow();
          const events = await this.#scanFastRange(fromBlock, chainHead, wallets, signal);
          this.health.fastLastRangeDurationMs = Math.max(0, Math.round(this.monotonicNow() - startedAt));
          detectedEvents = events;
          this.#advanceCursor(chainHead);
          this.#publishEvents(events);
          if (events.length) this.#emit('snapshot', this.getSnapshot());
        }
      }

      this.#reconcileBarkAlerts(detectedEvents.length > 0);

      this.health.lastSuccessAt = new Date(this.now()).toISOString();
      this.health.lastError = '';
      this.health.consecutiveErrors = 0;
      this.health.lagBlocks = Math.max(0, chainHead - (this.cursor ?? chainHead));
      this.health.fastBacklogBlocks = this.health.lagBlocks;
      this.health.fastGapBlocks = countRangeBlocks(this.fastGaps);
      this.#recordHealthyPoll();
      this.#emit('health', this.getSnapshot({ eventLimit: 0 }).health);
      return this.getSnapshot();
    } catch (error) {
      if (this.closed || signal.aborted) return null;
      this.health.lastError = errorMessage(error);
      this.health.lastErrorAt = new Date(this.now()).toISOString();
      this.health.consecutiveErrors += 1;
      if (isRpcPressureError(error) || this.health.consecutiveErrors >= 2) {
        this.#activateRpcProtection(error);
      }
      this.health.lagBlocks = this.health.chainHead === null || this.cursor === null
        ? null
        : Math.max(0, this.health.chainHead - this.cursor);
      this.health.fastBacklogBlocks = this.health.lagBlocks;
      this.health.fastGapBlocks = countRangeBlocks(this.fastGaps);
      this.#emit('health', this.getSnapshot({ eventLimit: 0 }).health);
      throw error;
    } finally {
      this.abortController = null;
    }
  }

  async #pollFastGap() {
    if (!this.settings.enabled || this.fastGaps.length === 0) {
      this.health.fastGapLastError = '';
      this.health.fastGapConsecutiveErrors = 0;
      return this.getSnapshot();
    }
    const wallets = this.#monitoredWalletMap();
    const fastWallets = this.#fastWalletAddresses(wallets);
    if (fastWallets.size === 0) {
      this.#clearFastGaps();
      this.health.fastGapLastError = '';
      this.health.fastGapConsecutiveErrors = 0;
      return this.getSnapshot();
    }
    const liveEdge = Math.max(this.cursor ?? 0, this.health.chainHead ?? 0);
    this.#synchronizeFastWalletStarts(fastWallets, liveEdge);
    this.fastGapAbortController = new AbortController();
    const { signal } = this.fastGapAbortController;
    try {
      const range = this.fastGaps[0];
      const fromBlock = range.fromBlock;
      const toBlock = Math.min(range.toBlock, fromBlock + this.fastGapBlockSpan - 1);
      const startedAt = this.monotonicNow();
      const events = await this.#scanFastRange(fromBlock, toBlock, wallets, signal);
      this.health.fastGapLastRangeDurationMs = Math.max(0, Math.round(this.monotonicNow() - startedAt));
      this.#removeFastGap(fromBlock, toBlock);
      this.#publishEvents(events);
      if (events.length) this.#emit('snapshot', this.getSnapshot());
      this.#reconcileBarkAlerts(events.length > 0);
      this.health.fastGapLastSuccessAt = new Date(this.now()).toISOString();
      this.health.fastGapLastError = '';
      this.health.fastGapConsecutiveErrors = 0;
      this.health.fastGapBlocks = countRangeBlocks(this.fastGaps);
      this.#emit('health', this.getSnapshot({ eventLimit: 0 }).health);
      return this.getSnapshot();
    } catch (error) {
      if (this.closed || signal.aborted) return null;
      this.health.fastGapLastError = errorMessage(error);
      this.health.fastGapLastErrorAt = new Date(this.now()).toISOString();
      this.health.fastGapConsecutiveErrors += 1;
      this.health.fastGapBlocks = countRangeBlocks(this.fastGaps);
      this.#emit('health', this.getSnapshot({ eventLimit: 0 }).health);
      throw error;
    } finally {
      this.fastGapAbortController = null;
    }
  }

  async #pollDeep() {
    this.health.deepLastPollAt = new Date(this.now()).toISOString();
    this.deepAbortController = new AbortController();
    const { signal } = this.deepAbortController;
    try {
      const chainHead = await this.rpcClient.getBlockNumber({ signal });
      this.health.deepChainHead = chainHead;
      const wallets = this.#monitoredWalletMap();
      const deepWallets = this.#deepWalletAddresses(wallets);
      this.health.deepMonitoredWallets = deepWallets.size;
      this.#synchronizeDeepWalletStarts(deepWallets, chainHead);

      let detectedEvents = [];
      if (this.deepCursor === null || this.deepCursor > chainHead) {
        this.#clearDeepGaps();
        this.#advanceDeepCursor(chainHead);
      } else if (!this.settings.enabled || deepWallets.size === 0) {
        this.#clearDeepGaps();
        this.#advanceDeepCursor(chainHead);
      } else if (chainHead > this.deepCursor) {
        // Keep the live edge first; older blocks are persisted for the independent gap worker.
        const fromBlock = Math.max(this.deepCursor + 1, chainHead - this.deepLiveBlockSpan + 1);
        if (fromBlock > this.deepCursor + 1) this.#enqueueDeepGap(this.deepCursor + 1, fromBlock - 1);
        const startedAt = this.monotonicNow();
        const scan = await this.#scanDeepRange(fromBlock, chainHead, wallets, signal);
        detectedEvents = scan.events;
        this.health.deepLastRangeDurationMs = Math.max(0, Math.round(this.monotonicNow() - startedAt));
        this.#advanceDeepCursor(chainHead);
        for (const blockNumber of scan.retryBlocks) this.#enqueueDeepGap(blockNumber, blockNumber);
        this.#publishEvents(detectedEvents);
        if (detectedEvents.length) this.#emit('snapshot', this.getSnapshot());
      }

      this.health.deepLastSuccessAt = new Date(this.now()).toISOString();
      this.health.deepLastError = '';
      this.health.deepConsecutiveErrors = 0;
      this.health.deepLiveBacklogBlocks = Math.max(0, chainHead - (this.deepCursor ?? chainHead));
      this.health.deepGapBlocks = countRangeBlocks(this.deepGaps);
      this.#emit('health', this.getSnapshot({ eventLimit: 0 }).health);
      return this.getSnapshot();
    } catch (error) {
      if (this.closed || signal.aborted) return null;
      this.health.deepLastError = errorMessage(error);
      this.health.deepLastErrorAt = new Date(this.now()).toISOString();
      this.health.deepConsecutiveErrors += 1;
      this.health.deepLiveBacklogBlocks = this.health.deepChainHead === null || this.deepCursor === null
        ? null
        : Math.max(0, this.health.deepChainHead - this.deepCursor);
      this.health.deepGapBlocks = countRangeBlocks(this.deepGaps);
      this.#emit('health', this.getSnapshot({ eventLimit: 0 }).health);
      throw error;
    } finally {
      this.deepAbortController = null;
    }
  }

  async #pollGap() {
    if (!this.settings.enabled || this.deepGaps.length === 0) {
      this.health.deepGapLastError = '';
      this.health.deepGapConsecutiveErrors = 0;
      return this.getSnapshot();
    }
    const wallets = this.#monitoredWalletMap();
    const deepWallets = this.#deepWalletAddresses(wallets);
    if (deepWallets.size === 0) {
      this.#clearDeepGaps();
      this.health.deepGapLastError = '';
      this.health.deepGapConsecutiveErrors = 0;
      return this.getSnapshot();
    }
    const liveEdge = Math.max(this.deepCursor ?? 0, this.health.deepChainHead ?? 0);
    this.#synchronizeDeepWalletStarts(deepWallets, liveEdge);
    this.gapAbortController = new AbortController();
    const { signal } = this.gapAbortController;
    try {
      const range = this.deepGaps[0];
      const fromBlock = range.fromBlock;
      const toBlock = Math.min(range.toBlock, fromBlock + this.deepGapBlockSpan - 1);
      const startedAt = this.monotonicNow();
      const scan = await this.#scanDeepRange(fromBlock, toBlock, wallets, signal);
      this.health.deepGapLastRangeDurationMs = Math.max(0, Math.round(this.monotonicNow() - startedAt));
      this.#removeDeepGap(fromBlock, toBlock);
      for (const blockNumber of scan.retryBlocks) this.#enqueueDeepGap(blockNumber, blockNumber);
      this.#publishEvents(scan.events);
      if (scan.events.length) this.#emit('snapshot', this.getSnapshot());
      this.health.deepGapLastSuccessAt = new Date(this.now()).toISOString();
      this.health.deepGapLastError = '';
      this.health.deepGapConsecutiveErrors = 0;
      this.health.deepGapBlocks = countRangeBlocks(this.deepGaps);
      this.#emit('health', this.getSnapshot({ eventLimit: 0 }).health);
      return this.getSnapshot();
    } catch (error) {
      if (this.closed || signal.aborted) return null;
      this.health.deepGapLastError = errorMessage(error);
      this.health.deepGapLastErrorAt = new Date(this.now()).toISOString();
      this.health.deepGapConsecutiveErrors += 1;
      this.health.deepGapBlocks = countRangeBlocks(this.deepGaps);
      this.#emit('health', this.getSnapshot({ eventLimit: 0 }).health);
      throw error;
    } finally {
      this.gapAbortController = null;
    }
  }

  #advanceCursor(blockNumber) {
    this.cursor = Number(blockNumber);
    this.health.lastProcessedBlock = this.cursor;
    this.store.setMeta(MONITOR_CURSOR_KEY, String(this.cursor));
  }

  #enqueueFastGap(fromBlock, toBlock) {
    if (fromBlock > toBlock) return;
    this.fastGaps = normalizeBlockRanges([...this.fastGaps, { fromBlock, toBlock }]);
    this.#persistFastGaps();
  }

  #persistFastGaps() {
    this.health.fastGapBlocks = countRangeBlocks(this.fastGaps);
    this.store.setMeta(MONITOR_FAST_GAPS_KEY, JSON.stringify(this.fastGaps));
  }

  #removeFastGap(fromBlock, toBlock) {
    this.fastGaps = this.#subtractRange(this.fastGaps, fromBlock, toBlock);
    this.#persistFastGaps();
  }

  #clearFastGaps() {
    if (this.fastGaps.length === 0) return;
    this.fastGaps = [];
    this.#persistFastGaps();
  }

  #advanceDeepCursor(blockNumber) {
    this.deepCursor = Number(blockNumber);
    this.health.deepLiveCursor = this.deepCursor;
    this.store.setMeta(MONITOR_DEEP_LIVE_CURSOR_KEY, String(this.deepCursor));
  }

  #enqueueDeepGap(fromBlock, toBlock) {
    if (fromBlock > toBlock) return;
    this.deepGaps = normalizeBlockRanges([...this.deepGaps, { fromBlock, toBlock }]);
    this.#persistDeepGaps();
  }

  #persistDeepGaps() {
    this.health.deepGapBlocks = countRangeBlocks(this.deepGaps);
    this.store.setMeta(MONITOR_DEEP_GAPS_KEY, JSON.stringify(this.deepGaps));
  }

  #removeDeepGap(fromBlock, toBlock) {
    this.deepGaps = this.#subtractRange(this.deepGaps, fromBlock, toBlock);
    this.#persistDeepGaps();
  }

  #subtractRange(ranges, fromBlock, toBlock) {
    const remaining = [];
    for (const range of ranges) {
      if (range.toBlock < fromBlock || range.fromBlock > toBlock) {
        remaining.push(range);
        continue;
      }
      if (range.fromBlock < fromBlock) {
        remaining.push({ fromBlock: range.fromBlock, toBlock: fromBlock - 1 });
      }
      if (range.toBlock > toBlock) {
        remaining.push({ fromBlock: toBlock + 1, toBlock: range.toBlock });
      }
    }
    return normalizeBlockRanges(remaining);
  }

  #clearDeepGaps() {
    if (this.deepGaps.length === 0) return;
    this.deepGaps = [];
    this.#persistDeepGaps();
  }

  #monitoredWalletMap() {
    return new Map(this.store.listMonitoredWalletAnnotations()
      .map((annotation) => [normalizeAddress(annotation.address), annotation])
      .filter(([address]) => ADDRESS_PATTERN.test(address)));
  }

  #fastWalletAddresses(wallets) {
    return new Set(WALLET_EVENT_TYPES.flatMap((eventType) => [...this.#walletsForRule(wallets, eventType)]));
  }

  #synchronizeFastWalletStarts(wallets, chainHead) {
    let changed = false;
    const migrationStart = this.fastGaps[0]?.fromBlock ?? (this.cursor === null ? chainHead : this.cursor + 1);
    for (const address of this.fastWalletStarts.keys()) {
      if (wallets.has(address)) continue;
      this.fastWalletStarts.delete(address);
      changed = true;
    }
    for (const address of wallets) {
      if (this.fastWalletStarts.has(address)) continue;
      this.fastWalletStarts.set(address, this.fastWalletStartsInitialized ? chainHead : migrationStart);
      changed = true;
    }
    if (!changed && this.fastWalletStartsInitialized) return;
    this.fastWalletStartsInitialized = true;
    this.store.setMeta(MONITOR_FAST_WALLET_STARTS_KEY, JSON.stringify(Object.fromEntries(this.fastWalletStarts)));
  }

  #deepWalletAddresses(wallets) {
    return new Set([
      ...this.#walletsForRule(wallets, 'transfer'),
      ...this.#walletsForRule(wallets, 'token_create')
    ]);
  }

  #synchronizeDeepWalletStarts(wallets, chainHead) {
    let changed = false;
    for (const address of this.deepWalletStarts.keys()) {
      if (wallets.has(address)) continue;
      this.deepWalletStarts.delete(address);
      changed = true;
    }
    for (const address of wallets) {
      if (this.deepWalletStarts.has(address)) continue;
      this.deepWalletStarts.set(address, chainHead);
      changed = true;
    }
    if (!changed) return;
    this.store.setMeta(MONITOR_DEEP_WALLET_STARTS_KEY, JSON.stringify(Object.fromEntries(this.deepWalletStarts)));
  }

  #deepStatus() {
    if (!this.settings.enabled || this.health.deepMonitoredWallets === 0) return 'disabled';
    if (this.health.deepConsecutiveErrors > 0 || this.health.deepGapConsecutiveErrors > 0) {
      return this.health.deepLastSuccessAt ? 'degraded' : 'error';
    }
    if (this.deepGaps.length > 0) return 'backfilling';
    if (this.health.deepLiveBacklogBlocks === 0) return 'caught_up';
    return 'idle';
  }

  #effectivePollIntervalMs() {
    return this.rpcProtection.active ? this.degradedPollIntervalMs : this.pollIntervalMs;
  }

  #effectiveDeepPollIntervalMs() {
    return this.health.deepConsecutiveErrors > 0
      ? this.deepDegradedPollIntervalMs
      : this.deepPollIntervalMs;
  }

  #effectiveLogConcurrency() {
    return this.rpcProtection.active ? 1 : this.walletLogConcurrency;
  }

  #activateRpcProtection(error) {
    const now = new Date(this.now()).toISOString();
    if (!this.rpcProtection.active) this.rpcProtection.activeSince = now;
    this.rpcProtection.active = true;
    this.rpcProtection.reason = errorMessage(error);
    this.rpcProtection.healthyPolls = 0;
  }

  #recordHealthyPoll() {
    if (!this.rpcProtection.active) return;
    this.rpcProtection.healthyPolls += 1;
    if (this.rpcProtection.healthyPolls < this.recoverySuccesses) return;
    this.rpcProtection.active = false;
    this.rpcProtection.activeSince = null;
    this.rpcProtection.reason = '';
    this.rpcProtection.healthyPolls = 0;
    this.rpcProtection.lastRecoveredAt = new Date(this.now()).toISOString();
  }

  #reconcileBarkAlerts(notifyNew) {
    for (const cluster of this.getClusters()) {
      if (!cluster.triggered) continue;
      if (this.alertedTokens.has(cluster.tokenAddress)) continue;
      this.alertedTokens.add(cluster.tokenAddress);
      this.store.recordMonitorTokenAlert?.(cluster.tokenAddress, unixSeconds(this.now));
      if (!notifyNew || !this.barkNotifier?.notifyAlert) continue;
      void this.barkNotifier.notifyAlert({
        cluster,
        threshold: this.settings.threshold,
        windowSeconds: this.settings.windowSeconds,
        sound: this.settings.barkSound,
        volume: this.settings.barkVolume
      }).then((delivery) => {
        this.#emit('bark', {
          tokenAddress: cluster.tokenAddress,
          tokenSymbol: cluster.tokenSymbol,
          walletCount: cluster.walletCount,
          delivery,
          sentAt: new Date(this.now()).toISOString()
        });
      }).catch((error) => {
        this.#emit('bark', {
          tokenAddress: cluster.tokenAddress,
          tokenSymbol: cluster.tokenSymbol,
          walletCount: cluster.walletCount,
          delivery: { attempted: 0, sent: 0, failed: 1 },
          error: errorMessage(error),
          sentAt: new Date(this.now()).toISOString()
        });
      });
    }
  }

  async #scanFastRange(fromBlock, toBlock, wallets, signal) {
    const buyWallets = this.#walletsForRule(wallets, 'buy');
    const sellWallets = this.#walletsForRule(wallets, 'sell');
    const transferWallets = this.#walletsForRule(wallets, 'transfer');
    const tokenCreateWallets = this.#walletsForRule(wallets, 'token_create');
    const outboundWallets = new Set([...sellWallets, ...transferWallets]);
    const trackedLogs = await this.#getTrackedLogs(fromBlock, toBlock, {
      buyWallets: [...buyWallets],
      outboundWallets: [...outboundWallets],
      watchNoxa: tokenCreateWallets.size > 0
    }, signal);

    const transferCandidates = [
      ...trackedLogs.incoming.map((log) => this.#transferCandidateFromLog(log, 'incoming')),
      ...trackedLogs.outgoing.map((log) => this.#transferCandidateFromLog(log, 'outgoing'))
    ].filter((candidate) => candidate && wallets.has(candidate.walletAddress) &&
      candidate.blockNumber >= (this.fastWalletStarts.get(candidate.walletAddress) ?? fromBlock) &&
      !(candidate.direction === 'incoming' && this.quoteTokenAddresses.has(candidate.tokenAddress)));
    const noxaCandidates = trackedLogs.noxa
      .map((log) => this.#noxaCandidateFromLog(log))
      .filter((candidate) => candidate && tokenCreateWallets.has(candidate.walletAddress) &&
        candidate.blockNumber >= (this.fastWalletStarts.get(candidate.walletAddress) ?? fromBlock));
    const rawCandidates = [...transferCandidates, ...noxaCandidates];
    if (!rawCandidates.length) return [];

    const transactionHashes = [...new Set(transferCandidates.map((candidate) => candidate.txHash))];
    const [transactions, receipts] = await Promise.all([
      transactionHashes.length
        ? this.rpcClient.getTransactionsByHashes(transactionHashes, { signal })
        : Promise.resolve([]),
      transactionHashes.length
        ? this.rpcClient.getTransactionReceipts(transactionHashes, { signal })
        : Promise.resolve([])
    ]);
    const transactionByHash = new Map(transactionHashes.map((hash, index) => [hash, transactions[index]]));
    const receiptByHash = new Map(transactionHashes.map((hash, index) => [hash, receipts[index]]));

    const prepared = [];
    for (const candidate of rawCandidates) {
      const annotation = wallets.get(candidate.walletAddress);
      if (!annotation || annotation.status === 'excluded') continue;
      if (candidate.source === 'noxa') {
        if (hasEnabledRule(annotation, 'token_create')) {
          prepared.push({
            ...candidate,
            eventType: 'token_create',
            assetType: 'erc20',
            platform: 'noxa',
            requireCompleteMetadata: false
          });
        }
        continue;
      }
      const transaction = transactionByHash.get(candidate.txHash);
      const receipt = receiptByHash.get(candidate.txHash);
      if (!receiptSucceeded(receipt)) continue;
      if (normalizeAddress(transaction?.from) !== candidate.walletAddress) continue;
      const swap = receiptHasSwap(receipt);
      if (candidate.direction === 'incoming' && swap && !this.quoteTokenAddresses.has(candidate.tokenAddress) &&
        hasEnabledRule(annotation, 'buy')) {
        prepared.push({
          ...candidate,
          eventType: 'buy',
          assetType: 'erc20',
          counterpartyAddress: normalizeAddress(transaction?.to),
          platform: ''
        });
      } else if (candidate.direction === 'outgoing' && swap && !this.quoteTokenAddresses.has(candidate.tokenAddress) &&
        hasEnabledRule(annotation, 'sell')) {
        prepared.push({
          ...candidate,
          eventType: 'sell',
          assetType: 'erc20',
          counterpartyAddress: normalizeAddress(candidate.counterpartyAddress || transaction?.to),
          platform: ''
        });
      } else if (candidate.direction === 'outgoing' && !swap && hasEnabledRule(annotation, 'transfer')) {
        prepared.push({ ...candidate, eventType: 'transfer', assetType: 'erc20', platform: '' });
      }
    }
    return (await this.#persistCandidates(prepared, wallets, signal, { lane: 'fast' })).events;
  }

  async #scanDeepRange(fromBlock, toBlock, wallets, signal) {
    const transferWallets = this.#walletsForRule(wallets, 'transfer');
    const tokenCreateWallets = this.#walletsForRule(wallets, 'token_create');
    if (transferWallets.size === 0 && tokenCreateWallets.size === 0) return { events: [], retryBlocks: [] };
    const blocks = await this.#getBlocksInRange(fromBlock, toBlock, {
      includeTransactions: true,
      batchSize: Math.max(this.deepLiveBlockSpan, this.deepGapBlockSpan),
      signal
    });
    const candidates = this.#fullBlockCandidates(blocks, { transferWallets, tokenCreateWallets })
      .filter((candidate) => candidate.blockNumber >= (this.deepWalletStarts.get(candidate.walletAddress) ?? fromBlock));
    if (!candidates.length) return { events: [], retryBlocks: [] };
    const receiptHashes = [...new Set(candidates.map((candidate) => candidate.txHash))];
    const receipts = await this.rpcClient.getTransactionReceipts(receiptHashes, { signal });
    const receiptByHash = new Map(receiptHashes.map((hash, index) => [hash, receipts[index]]));
    const prepared = [];
    for (const candidate of candidates) {
      const annotation = wallets.get(candidate.walletAddress);
      const receipt = receiptByHash.get(candidate.txHash);
      if (!annotation || annotation.status === 'excluded' || !receiptSucceeded(receipt)) continue;
      if (candidate.source === 'direct_create') {
        const tokenAddress = normalizeAddress(receipt?.contractAddress);
        if (!hasEnabledRule(annotation, 'token_create') || !ADDRESS_PATTERN.test(tokenAddress)) continue;
        prepared.push({
          ...candidate,
          tokenAddress,
          rawTokenAmount: '0',
          eventType: 'token_create',
          assetType: 'erc20',
          platform: 'direct',
          requireCompleteMetadata: true
        });
      } else if (candidate.source === 'native' && hasEnabledRule(annotation, 'transfer')) {
        prepared.push({ ...candidate, eventType: 'transfer', assetType: 'native', platform: '' });
      }
    }
    const blockTimestampByNumber = new Map(blocks.map((block) => [
      rpcInteger(block?.number),
      rpcInteger(block?.timestamp, unixSeconds(this.now))
    ]));
    return this.#persistCandidates(prepared, wallets, signal, { lane: 'deep', blockTimestampByNumber });
  }

  async #persistCandidates(prepared, wallets, signal, { lane, blockTimestampByNumber = new Map() } = {}) {
    if (!prepared.length) return { events: [], retryBlocks: [] };

    const deduped = [...new Map(prepared.map((candidate) => [
      `${candidate.txHash}:${candidate.logIndex}`,
      candidate
    ])).values()];
    const missingBlockNumbers = [...new Set(deduped
      .map((candidate) => candidate.blockNumber)
      .filter((blockNumber) => !blockTimestampByNumber.has(blockNumber)))];
    if (missingBlockNumbers.length) {
      const blocks = await this.#getBlocksByNumbers(missingBlockNumbers, { signal });
      missingBlockNumbers.forEach((blockNumber, index) => {
        blockTimestampByNumber.set(blockNumber, rpcInteger(blocks[index]?.timestamp, unixSeconds(this.now)));
      });
    }

    const tokenAddresses = [...new Set(deduped
      .filter((candidate) => candidate.assetType === 'erc20')
      .map((candidate) => candidate.tokenAddress))];
    const metadataRows = await this.#getTokenMetadataRows(tokenAddresses, signal);
    const metadataByAddress = new Map(tokenAddresses.map((address, index) => [address, metadataRows[index]]));
    const detected = [];
    const retryBlocks = new Set();
    for (const candidate of deduped) {
      throwIfAborted(signal);
      if (!this.settings.enabled) continue;
      const annotation = this.store.getWalletAnnotation
        ? this.store.getWalletAnnotation(candidate.walletAddress)
        : wallets.get(candidate.walletAddress);
      if (!annotation || annotation.status === 'excluded') continue;
      const rule = ruleFor(annotation, candidate.eventType);
      if (!rule.enabled) continue;
      const metadata = candidate.assetType === 'native'
        ? { symbol: 'ETH', name: 'Ether', decimals: 18, complete: true }
        : metadataByAddress.get(candidate.tokenAddress);
      if (!metadata || candidate.requireCompleteMetadata && !metadata.complete) {
        if (lane === 'deep' && candidate.requireCompleteMetadata && metadata?.timedOut) {
          retryBlocks.add(candidate.blockNumber);
        }
        continue;
      }
      const marketData = candidate.assetType === 'erc20'
        ? this.#cachedMarketData(candidate.tokenAddress)
        : { marketCapUsd: null, tokenCreationTimestamp: null, marketDataAt: null };
      const result = this.store.insertMonitorEvent({
        ...candidate,
        walletAlias: annotation?.alias || '',
        tokenSymbol: metadata.symbol,
        tokenName: metadata.name,
        tokenDecimals: metadata.decimals,
        tokenAmount: formatTokenAmount(candidate.rawTokenAmount, metadata.decimals),
        blockTimestamp: blockTimestampByNumber.get(candidate.blockNumber) ?? unixSeconds(this.now),
        detectedAt: unixSeconds(this.now),
        soundAlert: rule.sound,
        barkAlert: rule.bark,
        ...marketData
      });
      if (!result.inserted) continue;
      const event = publicEvent(result.event);
      detected.push(event);
      this.health.eventsDetected += 1;
      if (lane === 'deep') this.health.deepEventsDetected += 1;
      else this.health.fastEventsDetected += 1;
      this.#notifyWalletEvent(event);
    }
    return { events: detected, retryBlocks: [...retryBlocks] };
  }

  #walletsForRule(wallets, eventType) {
    return new Set([...wallets]
      .filter(([, annotation]) => hasEnabledRule(annotation, eventType))
      .map(([address]) => address));
  }

  async #getTrackedLogs(fromBlock, toBlock, { buyWallets, outboundWallets, watchNoxa }, signal) {
    const tasks = [];
    for (const [kind, addresses] of [['incoming', buyWallets], ['outgoing', outboundWallets]]) {
      for (let index = 0; index < addresses.length; index += this.walletTopicChunkSize) {
        tasks.push({ kind, wallets: addresses.slice(index, index + this.walletTopicChunkSize) });
      }
    }
    if (watchNoxa) tasks.push({ kind: 'noxa', wallets: [] });
    const taskRows = new Array(tasks.length);
    let nextIndex = 0;
    let firstError = null;
    const worker = async () => {
      while (!firstError) {
        const index = nextIndex;
        nextIndex += 1;
        if (index >= tasks.length) return;
        try {
          const task = tasks[index];
          taskRows[index] = task.kind === 'noxa'
            ? await this.#getNoxaLaunchLogs(fromBlock, toBlock, signal)
            : await this.#getTransferChunk(fromBlock, toBlock, task.wallets, task.kind, signal);
        } catch (error) {
          firstError ||= error;
        }
      }
    };
    const concurrency = Math.min(this.#effectiveLogConcurrency(), tasks.length);
    await Promise.all(Array.from({ length: concurrency }, () => worker()));
    if (firstError) throw firstError;

    const result = { incoming: [], outgoing: [], noxa: [] };
    const seen = { incoming: new Set(), outgoing: new Set(), noxa: new Set() };
    tasks.forEach((task, index) => {
      for (const log of taskRows[index] || []) {
        const key = eventKey(log);
        if (seen[task.kind].has(key)) continue;
        seen[task.kind].add(key);
        result[task.kind].push(log);
      }
    });
    return result;
  }

  async #getTransferChunk(fromBlock, toBlock, chunk, direction, signal) {
    const topics = chunk.map(topicForAddress);
    const walletTopicIndex = direction === 'outgoing' ? 1 : 2;
    const filterTopics = [ERC20_TRANSFER_TOPIC, null, null];
    filterTopics[walletTopicIndex] = topics.length === 1 ? topics[0] : topics;
    const options = {
      signal,
      initialWindow: Math.max(1, toBlock - fromBlock + 1),
      minWindow: 1,
      maxWindow: this.maxBlockSpan
    };
    try {
      return await this.rpcClient.getLogs({
        fromBlock,
        toBlock,
        topics: filterTopics
      }, options);
    } catch (error) {
      if (chunk.length === 1 || !canFallbackFromTopicOr(error)) throw error;
      const rows = [];
      for (const wallet of chunk) {
        throwIfAborted(signal);
        rows.push(...await this.rpcClient.getLogs({
          fromBlock,
          toBlock,
          topics: walletTopicIndex === 1
            ? [ERC20_TRANSFER_TOPIC, topicForAddress(wallet), null]
            : [ERC20_TRANSFER_TOPIC, null, topicForAddress(wallet)]
        }, options));
      }
      return rows;
    }
  }

  #getNoxaLaunchLogs(fromBlock, toBlock, signal) {
    return this.rpcClient.getLogs({
      address: this.noxaLaunchFactory,
      fromBlock,
      toBlock,
      topics: [NOXA_TOKEN_LAUNCHED_TOPIC]
    }, {
      signal,
      initialWindow: Math.max(1, toBlock - fromBlock + 1),
      minWindow: 1,
      maxWindow: this.maxBlockSpan
    });
  }

  #transferCandidateFromLog(log, direction) {
    if (log?.removed) return null;
    const tokenAddress = normalizeAddress(log?.address);
    const walletAddress = addressFromTopic(log?.topics?.[direction === 'outgoing' ? 1 : 2]);
    const counterpartyAddress = addressFromTopic(log?.topics?.[direction === 'outgoing' ? 2 : 1]) || '';
    const txHash = String(log?.transactionHash || '').toLowerCase();
    const logIndex = rpcInteger(log?.logIndex);
    const blockNumber = rpcInteger(log?.blockNumber);
    const rawTokenAmount = rawAmountFromLog(log);
    if (!ADDRESS_PATTERN.test(tokenAddress) || !walletAddress || !HASH_PATTERN.test(txHash) ||
      logIndex === null || blockNumber === null || rawTokenAmount === null || rawTokenAmount <= 0n) {
      return null;
    }
    return {
      walletAddress,
      tokenAddress,
      counterpartyAddress,
      rawTokenAmount: rawTokenAmount.toString(),
      txHash,
      logIndex,
      blockNumber,
      source: 'transfer_log',
      direction
    };
  }

  #noxaCandidateFromLog(log) {
    if (log?.removed || normalizeAddress(log?.address) !== this.noxaLaunchFactory ||
      String(log?.topics?.[0] || '').toLowerCase() !== NOXA_TOKEN_LAUNCHED_TOPIC) return null;
    const tokenAddress = addressFromTopic(log?.topics?.[1]);
    const walletAddress = addressFromTopic(log?.topics?.[2]);
    const txHash = String(log?.transactionHash || '').toLowerCase();
    const logIndex = rpcInteger(log?.logIndex);
    const blockNumber = rpcInteger(log?.blockNumber);
    if (!tokenAddress || !walletAddress || !HASH_PATTERN.test(txHash) || logIndex === null || blockNumber === null) {
      return null;
    }
    return {
      walletAddress,
      tokenAddress,
      counterpartyAddress: this.noxaLaunchFactory,
      rawTokenAmount: '0',
      txHash,
      logIndex,
      blockNumber,
      source: 'noxa'
    };
  }

  #fullBlockCandidates(blocks, { transferWallets, tokenCreateWallets }) {
    const candidates = [];
    for (const block of blocks) {
      const blockNumber = rpcInteger(block?.number);
      if (blockNumber === null) continue;
      for (const transaction of Array.isArray(block?.transactions) ? block.transactions : []) {
        if (!transaction || typeof transaction !== 'object') continue;
        const walletAddress = normalizeAddress(transaction.from);
        const txHash = String(transaction.hash || '').toLowerCase();
        if (!HASH_PATTERN.test(txHash)) continue;
        if (transaction.to === null && tokenCreateWallets.has(walletAddress)) {
          candidates.push({
            walletAddress,
            tokenAddress: '',
            counterpartyAddress: '',
            txHash,
            logIndex: -2,
            blockNumber,
            transaction,
            source: 'direct_create'
          });
          continue;
        }
        const value = rpcBigInt(transaction.value, 0n);
        const counterpartyAddress = normalizeAddress(transaction.to);
        if (transferWallets.has(walletAddress) && value > 0n && ADDRESS_PATTERN.test(counterpartyAddress) &&
          emptyInput(transaction.input ?? transaction.data)) {
          candidates.push({
            walletAddress,
            tokenAddress: '',
            counterpartyAddress,
            rawTokenAmount: value.toString(),
            txHash,
            logIndex: -1,
            blockNumber,
            transaction,
            source: 'native'
          });
        }
      }
    }
    return candidates;
  }

  async #getBlocksInRange(fromBlock, toBlock, options) {
    return this.#getBlocksByNumbers(
      Array.from({ length: toBlock - fromBlock + 1 }, (_, index) => fromBlock + index),
      options
    );
  }

  async #getBlocksByNumbers(blockNumbers, { includeTransactions = false, batchSize, signal } = {}) {
    if (this.rpcClient.getBlocksByNumbers) {
      return this.rpcClient.getBlocksByNumbers(blockNumbers, { includeTransactions, batchSize, signal });
    }
    const blocks = [];
    for (let index = 0; index < blockNumbers.length; index += 25) {
      throwIfAborted(signal);
      blocks.push(...await Promise.all(blockNumbers.slice(index, index + 25).map((blockNumber) =>
        this.rpcClient.getBlockByNumber(blockNumber, { includeTransactions, signal }))));
    }
    return blocks;
  }

  async #getTokenMetadataRows(addresses, signal) {
    const rows = new Array(addresses.length);
    let nextIndex = 0;
    const worker = async () => {
      while (nextIndex < addresses.length) {
        const index = nextIndex;
        nextIndex += 1;
        rows[index] = await this.#getTokenMetadataWithinBudget(addresses[index], signal);
      }
    };
    await Promise.all(Array.from({ length: Math.min(8, addresses.length) }, () => worker()));
    return rows;
  }

  async #getTokenMetadataWithinBudget(address, signal) {
    let timer = null;
    const fallback = {
      address,
      symbol: fallbackSymbol(address),
      name: address,
      decimals: 18,
      complete: false,
      timedOut: true,
      updatedAt: unixSeconds(this.now)
    };
    const metadata = this.#getTokenMetadata(address, signal).catch(() => fallback);
    const timeout = new Promise((resolve) => {
      timer = this.setTimer(() => resolve(fallback), this.tokenMetadataBudgetMs);
      timer?.unref?.();
    });
    try {
      return await Promise.race([metadata, timeout]);
    } finally {
      if (timer) this.clearTimer(timer);
    }
  }

  #notifyWalletEvent(event) {
    if (!event.barkAlert || !this.barkNotifier?.notifyWalletEvent) return;
    void this.barkNotifier.notifyWalletEvent({
      event,
      sound: this.settings.barkSound,
      volume: this.settings.barkVolume
    }).then((delivery) => {
      this.#emit('bark', {
        eventId: event.id,
        eventType: event.eventType,
        walletAddress: event.walletAddress,
        tokenAddress: event.tokenAddress,
        delivery,
        sentAt: new Date(this.now()).toISOString()
      });
    }).catch((error) => {
      this.#emit('bark', {
        eventId: event.id,
        eventType: event.eventType,
        walletAddress: event.walletAddress,
        delivery: { attempted: 0, sent: 0, failed: 1 },
        error: errorMessage(error),
        sentAt: new Date(this.now()).toISOString()
      });
    });
  }

  #publishEvents(events) {
    for (const event of events) {
      this.#emit('event', event);
      if (event.assetType === 'erc20' && ADDRESS_PATTERN.test(event.tokenAddress)) {
        if (!this.#trackMarketDataEvent(event)) continue;
        const cached = this.#cachedMarketData(event.tokenAddress);
        if (cached.marketCapUsd !== null && cached.tokenCreationTimestamp !== null) {
          const updatedEvents = this.store.updateMonitorEventsTokenMarketData?.(
            event.tokenAddress,
            cached,
            { eventIds: [event.id] }
          ) || [];
          this.#removePendingMarketDataEvents(event.tokenAddress, [event.id]);
          this.#emitMarketDataPatches(updatedEvents);
          continue;
        }
        this.#queueTokenMarketData(event.tokenAddress, { priority: true });
      }
    }
  }

  #queueRecentMarketData() {
    if (!this.debotClient || !this.store.listMonitorEvents) return;
    const cutoff = unixSeconds(this.now) - Math.max(15, this.marketDataCacheSeconds);
    for (const event of this.store.listMonitorEvents({ limit: 100 })) {
      if (Number(event.detectedAt) < cutoff || !this.#trackMarketDataEvent(event)) continue;
      const cached = this.#cachedMarketData(event.tokenAddress);
      if (cached.marketCapUsd !== null && cached.tokenCreationTimestamp !== null) {
        this.store.updateMonitorEventsTokenMarketData?.(event.tokenAddress, cached, { eventIds: [event.id] });
        this.#removePendingMarketDataEvents(event.tokenAddress, [event.id]);
        continue;
      }
      this.#queueTokenMarketData(event.tokenAddress, { priority: false });
    }
  }

  #trackMarketDataEvent(event) {
    const address = normalizeAddress(event?.tokenAddress);
    const eventId = Number(event?.id);
    if (!ADDRESS_PATTERN.test(address) || !Number.isSafeInteger(eventId) || eventId <= 0) return false;
    const hasMarketCap = event.marketCapUsd !== null && event.marketCapUsd !== undefined &&
      Number.isFinite(Number(event.marketCapUsd));
    const creationTimestamp = Number(event.tokenCreationTimestamp);
    if (hasMarketCap && Number.isSafeInteger(creationTimestamp) && creationTimestamp > 0) return false;
    if (!this.marketDataPendingEventIds.has(address)) this.marketDataPendingEventIds.set(address, new Set());
    this.marketDataPendingEventIds.get(address).add(eventId);
    return true;
  }

  #removePendingMarketDataEvents(address, eventIds) {
    const pending = this.marketDataPendingEventIds.get(address);
    if (!pending) return;
    for (const eventId of eventIds) pending.delete(Number(eventId));
    if (pending.size === 0) this.marketDataPendingEventIds.delete(address);
  }

  #emitMarketDataPatches(events) {
    const patches = new Map();
    for (const event of events) {
      const key = JSON.stringify([
        event.marketCapUsd,
        event.tokenCreationTimestamp,
        event.marketDataAt
      ]);
      const patch = patches.get(key) || {
        eventIds: [],
        tokenAddress: event.tokenAddress,
        marketCapUsd: event.marketCapUsd,
        tokenCreationTimestamp: event.tokenCreationTimestamp,
        marketDataAt: event.marketDataAt
      };
      patch.eventIds.push(event.id);
      patches.set(key, patch);
    }
    for (const patch of patches.values()) this.#emit('event_update', patch);
  }

  #cachedMarketData(address) {
    const cached = this.store.getMonitorTokenMetadata?.(address);
    const tokenCreationTimestamp = Number.isSafeInteger(Number(cached?.tokenCreationTimestamp)) &&
      Number(cached.tokenCreationTimestamp) > 0
      ? Number(cached.tokenCreationTimestamp)
      : null;
    if (!this.#marketDataIsFresh(cached)) {
      return { marketCapUsd: null, tokenCreationTimestamp, marketDataAt: null };
    }
    return {
      marketCapUsd: Number(cached.marketCapUsd),
      tokenCreationTimestamp,
      marketDataAt: Number(cached.marketDataAt)
    };
  }

  #marketDataIsFresh(cached) {
    const marketCap = cached?.marketCapUsd;
    const marketDataAt = Number(cached?.marketDataAt);
    const creationTimestamp = Number(cached?.tokenCreationTimestamp);
    if (marketCap === null || marketCap === undefined || !Number.isFinite(Number(marketCap)) ||
      !Number.isSafeInteger(marketDataAt) || marketDataAt <= 0 ||
      !Number.isSafeInteger(creationTimestamp) || creationTimestamp <= 0) return false;
    const age = unixSeconds(this.now) - marketDataAt;
    return age >= 0 && age <= this.marketDataCacheSeconds;
  }

  #queueTokenMarketData(address, { priority = true, force = false } = {}) {
    const normalized = normalizeAddress(address);
    if (this.closed || !this.debotClient || !ADDRESS_PATTERN.test(normalized)) return;
    if (!force && this.#marketDataIsFresh(this.store.getMonitorTokenMetadata?.(normalized))) return;
    if (this.marketDataLookups.has(normalized) || this.marketDataRetryTimers.has(normalized)) return;
    const queued = this.marketDataQueued.get(normalized);
    if (queued) {
      queued.force ||= force;
      if (priority) {
        const index = this.marketDataQueue.indexOf(queued);
        if (index > 0) {
          this.marketDataQueue.splice(index, 1);
          this.marketDataQueue.unshift(queued);
        }
      }
      return;
    }
    const job = { address: normalized, force };
    this.marketDataQueued.set(normalized, job);
    if (priority) this.marketDataQueue.unshift(job);
    else this.marketDataQueue.push(job);
    this.#drainMarketDataQueue();
  }

  #drainMarketDataQueue() {
    if (this.closed || !this.debotClient) return;
    while (this.marketDataActive < this.marketDataConcurrency && this.marketDataQueue.length > 0) {
      const job = this.marketDataQueue.shift();
      this.marketDataQueued.delete(job.address);
      if (this.marketDataLookups.has(job.address) || this.marketDataRetryTimers.has(job.address)) continue;
      if (!job.force && this.#marketDataIsFresh(this.store.getMonitorTokenMetadata?.(job.address))) continue;
      this.marketDataActive += 1;
      const lookup = this.#fetchTokenMarketData(job.address);
      this.marketDataLookups.set(job.address, lookup);
      void lookup.finally(() => {
        this.marketDataLookups.delete(job.address);
        this.marketDataActive = Math.max(0, this.marketDataActive - 1);
        this.#drainMarketDataQueue();
      }).catch(() => {});
    }
  }

  async #fetchTokenMarketData(address) {
    try {
      const metrics = await this.debotClient.fetchTokenMetrics(address, {
        signal: this.marketDataAbortController.signal
      });
      if (this.closed || this.marketDataAbortController.signal.aborted) return;
      const marketCap = metrics?.marketCapUsd;
      const marketCapUsd = marketCap === null || marketCap === undefined || marketCap === ''
        ? null
        : Number(marketCap);
      const creation = Number(metrics?.creationTimestamp);
      const tokenCreationTimestamp = Number.isSafeInteger(creation) && creation > 0 ? creation : null;
      const normalizedMarketCap = Number.isFinite(marketCapUsd) && marketCapUsd >= 0 ? marketCapUsd : null;
      if (normalizedMarketCap === null && tokenCreationTimestamp === null) {
        throw new Error('DeBot token metrics did not include market cap or creation time');
      }
      const marketData = {
        address,
        marketCapUsd: normalizedMarketCap,
        tokenCreationTimestamp,
        marketDataAt: normalizedMarketCap === null ? null : unixSeconds(this.now)
      };
      this.store.upsertMonitorTokenMarketData?.(marketData);
      const eventIds = [...(this.marketDataPendingEventIds.get(address) || [])];
      const updatedEvents = this.store.updateMonitorEventsTokenMarketData?.(
        address,
        marketData,
        { eventIds }
      ) || [];
      this.#emitMarketDataPatches(updatedEvents);
      if (normalizedMarketCap === null || tokenCreationTimestamp === null) {
        const completedIds = new Set(updatedEvents
          .filter((event) => event.marketCapUsd !== null && event.tokenCreationTimestamp !== null)
          .map((event) => Number(event.id)));
        const unresolvedIds = eventIds.filter((eventId) => !completedIds.has(Number(eventId)));
        if (unresolvedIds.length) this.marketDataPendingEventIds.set(address, new Set(unresolvedIds));
        else this.marketDataPendingEventIds.delete(address);
        throw new Error('DeBot token metrics were incomplete');
      }
      this.marketDataFailures.delete(address);
      this.marketDataPendingEventIds.delete(address);
    } catch (error) {
      if (this.closed || this.marketDataAbortController.signal.aborted) return;
      this.#scheduleMarketDataRetry(address);
    }
  }

  #scheduleMarketDataRetry(address) {
    if (this.closed || this.marketDataRetryTimers.has(address)) return;
    const failures = (this.marketDataFailures.get(address) || 0) + 1;
    this.marketDataFailures.set(address, failures);
    if (failures >= MARKET_DATA_MAX_FAILURES) {
      this.marketDataFailures.delete(address);
      this.marketDataPendingEventIds.delete(address);
      return;
    }
    const delay = Math.min(
      this.marketDataRetryMaxMs,
      this.marketDataRetryBaseMs * (2 ** Math.min(10, failures - 1))
    );
    const timer = this.setTimer(() => {
      this.marketDataRetryTimers.delete(address);
      this.#queueTokenMarketData(address, { priority: true, force: true });
    }, delay);
    timer?.unref?.();
    this.marketDataRetryTimers.set(address, timer);
  }

  async #getTokenMetadata(address, signal) {
    const cached = this.store.getMonitorTokenMetadata(address);
    const now = unixSeconds(this.now);
    if (cached && (cached.complete || now - cached.updatedAt < TOKEN_METADATA_RETRY_SECONDS)) return cached;
    const known = this.store.getToken?.(address);
    if (known && Number.isInteger(Number(known.decimals)) && Number(known.decimals) >= 0) {
      return this.store.upsertMonitorTokenMetadata({
        address,
        symbol: normalizeText(known.symbol, fallbackSymbol(address), 80),
        name: normalizeText(known.name, known.symbol || address, 160),
        decimals: Math.min(255, Number(known.decimals)),
        complete: true,
        updatedAt: now
      });
    }

    const [symbolResult, nameResult, decimalsResult] = await Promise.allSettled([
      this.rpcClient.ethCall({ to: address, data: SYMBOL_SELECTOR }, { signal }),
      this.rpcClient.ethCall({ to: address, data: NAME_SELECTOR }, { signal }),
      this.rpcClient.ethCall({ to: address, data: DECIMALS_SELECTOR }, { signal })
    ]);
    throwIfAborted(signal);
    const symbol = symbolResult.status === 'fulfilled' ? decodeAbiString(symbolResult.value) : null;
    const name = nameResult.status === 'fulfilled' ? decodeAbiString(nameResult.value) : null;
    const decimals = decimalsResult.status === 'fulfilled' ? decodeDecimals(decimalsResult.value) : null;
    const complete = Boolean(symbol && name && decimals !== null);
    return this.store.upsertMonitorTokenMetadata({
      address,
      symbol: normalizeText(symbol, fallbackSymbol(address), 80),
      name: normalizeText(name, symbol || address, 160),
      decimals: decimals ?? 18,
      complete,
      updatedAt: now
    });
  }

  #emit(type, data) {
    for (const listener of this.listeners) {
      try {
        listener({ type, data });
      } catch {
        // A disconnected SSE client must not stop monitoring.
      }
    }
  }
}

export function createRobinhoodWalletMonitor(options) {
  return new RobinhoodWalletMonitor(options);
}
