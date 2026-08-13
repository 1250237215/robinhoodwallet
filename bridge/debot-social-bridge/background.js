import { createPostOutbox } from './post-outbox.js';
import { createAnalysisResultOutbox } from './analysis-result-outbox.js';
import { createWalletEventOutbox } from './wallet-event-outbox.js';
import { postUploadRetryDelay } from './post-retry-policy.js';
import {
  hostPermissionForServerBase,
  isRadarPageUrl,
  normalizeServerBase,
  radarContentMatchesForServerBase,
  serverOriginForBase
} from './server-config.js';

const DEBOT_URL = 'https://debot.ai/';
const DEBOT_URL_PATTERN = 'https://debot.ai/*';
const RADAR_CONTENT_SCRIPT_ID = 'configured-radar-content';
const RECOVERY_ALARM = 'debot-social-bridge-recovery';
const RECOVERY_STATE_KEY = 'debotSocialBridgeRecoveryV1';
const RECOVERY_PERIOD_MINUTES = 0.5;
const RECOVERY_LOAD_GRACE_MS = 45_000;
const RECOVERY_PROBE_TIMEOUT_MS = 25_000;
const RECOVERY_RELOAD_BACKOFF_MS = [60_000, 5 * 60_000, 15 * 60_000, 30 * 60_000];
const SOCIAL_REQUEST_TIMEOUT_MS = 15_000;
const POST_UPLOAD_REQUEST_TIMEOUT_MS = 2_000;
const MAX_ANALYSIS_CONCURRENCY = 4;
const MAX_ANALYSIS_RESULT_BYTES = 256 * 1024;
const ANALYSIS_RESULT_BATCH_SIZE = 20;
const ANALYSIS_RESULT_UPLOAD_CONCURRENCY = 4;
const SNAPSHOT_SESSION_STARTED_AT = Date.now();
const SNAPSHOT_SESSION_ID = `${SNAPSHOT_SESSION_STARTED_AT.toString(36)}-${Math.random().toString(36).slice(2, 12)}`;
const SOCIAL_EVENT_KINDS = new Set(['post', 'reply', 'repost', 'quote', 'delete', 'follow', 'unfollow', 'profile']);
const PROFILE_CHANGE_TYPES = new Set(['name', 'avatar', 'bio']);
const SOCIAL_HANDLE_PATTERN = /^[a-z0-9_]{1,15}$/i;
const DIAGNOSTIC_COUNTER_MAX = 1_000_000_000;
const DIAGNOSTIC_DURATION_MAX_MS = 10 * 60_000;
const DIAGNOSTIC_ERROR_TYPES = new Set(['', 'AUTH', 'TIMEOUT', 'NETWORK', 'DEBOT', 'UNKNOWN']);
const ANALYSIS_ERROR_TYPES = new Set([
  'AUTH',
  'TIMEOUT',
  'NETWORK',
  'DEBOT',
  'INVALID_JOB',
  'RESULT_TOO_LARGE'
]);
const storageReady = Promise.all([
  chrome.storage.local.setAccessLevel({ accessLevel: 'TRUSTED_CONTEXTS' }),
  chrome.storage.session.setAccessLevel({ accessLevel: 'TRUSTED_CONTEXTS' })
]);
const postOutbox = createPostOutbox({ storage: chrome.storage.local });
const analysisResultOutbox = createAnalysisResultOutbox({ storage: chrome.storage.local });
const walletEventOutbox = createWalletEventOutbox({ storage: chrome.storage.local });
let settingsWriteQueue = Promise.resolve();
let postFlushInFlight = null;
let postFlushRequested = false;
let postFlushRetryTimer = null;
let postFlushRetryAttempt = 0;
let analysisResultFlushInFlight = null;
let analysisResultFlushRequested = false;
let bridgeMaintenanceInFlight = null;
let snapshotRevision = 0;
let watchlistUploadQueue = Promise.resolve();
let walletEventFlushInFlight = null;
let walletEventRetryTimer = null;
let walletEventRetryAttempt = 0;

function text(value, maximum = 100_000) {
  return String(value ?? '').slice(0, maximum);
}

function number(value) {
  const result = Number(value);
  return Number.isFinite(result) ? result : 0;
}

function safeMedia(value) {
  return (Array.isArray(value) ? value : []).slice(0, 12).map((item) => ({
    type: text(item?.type, 20),
    url: text(item?.url, 2_000),
    previewUrl: text(item?.previewUrl, 2_000)
  }));
}

function safeContracts(value) {
  return (Array.isArray(value) ? value : []).slice(0, 32).map((item) => ({
    address: text(item?.address, 100),
    chain: text(item?.chain, 20)
  }));
}

function safeSocialAccount(value, { includeUrl = false } = {}) {
  const account = value && typeof value === 'object' ? value : {};
  return {
    id: text(account.id, 240),
    handle: text(account.handle, 240),
    name: text(account.name, 500),
    avatarUrl: text(account.avatarUrl, 2_000),
    followersCount: number(account.followersCount),
    ...(includeUrl ? { url: text(account.url, 2_000) } : {})
  };
}

function safeProfileChanges(value) {
  return [...new Set((Array.isArray(value) ? value : [])
    .map((item) => text(item, 20).toLowerCase())
    .filter((item) => PROFILE_CHANGE_TYPES.has(item)))];
}

function safeProfileDetail(value, changes) {
  const detail = value && typeof value === 'object' && !Array.isArray(value) ? value : {};
  const normalized = {};
  for (const change of changes) {
    const maximum = change === 'bio' ? 10_000 : change === 'avatar' ? 2_000 : 500;
    const item = detail[change] && typeof detail[change] === 'object' ? detail[change] : {};
    normalized[change] = {
      before: text(item.before, maximum),
      after: text(item.after, maximum)
    };
  }
  return normalized;
}

function safeReplyContext(value) {
  const context = value && typeof value === 'object' && !Array.isArray(value) ? value : {};
  const normalized = {
    externalId: text(context.externalId, 240),
    author: safeSocialAccount(context.author),
    content: text(context.content),
    translatedContent: text(context.translatedContent),
    url: text(context.url, 2_000),
    publishedAt: number(context.publishedAt),
    media: safeMedia(context.media)
  };
  return normalized.externalId || normalized.author.handle || normalized.content || normalized.media.length
    ? normalized
    : null;
}

function safePost(value) {
  const post = value && typeof value === 'object' ? value : {};
  const kind = text(post.kind, 20).toLowerCase();
  if (!SOCIAL_EVENT_KINDS.has(kind)) return null;
  const author = post.author && typeof post.author === 'object' ? post.author : {};
  const safeAuthor = safeSocialAccount(author);
  const target = ['follow', 'unfollow', 'reply'].includes(kind)
    ? safeSocialAccount(post.target, { includeUrl: true })
    : null;
  const replyContext = kind === 'reply' ? safeReplyContext(post.replyContext) : null;
  const quoteContext = kind === 'quote' ? safeReplyContext(post.quoteContext) : null;
  const profileChanges = kind === 'profile' ? safeProfileChanges(post.profileChanges) : [];
  if (['follow', 'unfollow'].includes(kind)
    && (!SOCIAL_HANDLE_PATTERN.test(safeAuthor.handle) || !SOCIAL_HANDLE_PATTERN.test(target.handle))) return null;
  if (kind === 'profile' && (!SOCIAL_HANDLE_PATTERN.test(safeAuthor.handle) || !profileChanges.length)) return null;
  return {
    source: text(post.source, 40),
    externalId: text(post.externalId, 240),
    kind,
    author: safeAuthor,
    ...(target ? { target } : {}),
    ...(replyContext ? { replyContext } : {}),
    ...(quoteContext ? { quoteContext } : {}),
    ...(kind === 'profile' ? {
      profileChanges,
      profileDetail: safeProfileDetail(post.profileDetail, profileChanges)
    } : {}),
    content: text(post.content),
    translatedContent: text(post.translatedContent),
    url: text(post.url, 2_000),
    media: safeMedia(post.media),
    contractAddresses: safeContracts(post.contractAddresses),
    chainTags: (Array.isArray(post.chainTags) ? post.chainTags : []).slice(0, 20).map((item) => text(item, 20)),
    replyToExternalId: text(post.replyToExternalId, 240),
    quotedExternalId: text(post.quotedExternalId, 240),
    repostExternalId: text(post.repostExternalId, 240),
    publishedAt: number(post.publishedAt),
    discoveredAt: number(post.discoveredAt || post.receivedAt),
    receivedAt: number(post.receivedAt),
    sourceUpdatedAt: number(post.sourceUpdatedAt),
    deleted: post.deleted === true,
    deletedAt: post.deletedAt === null || post.deletedAt === undefined ? null : number(post.deletedAt),
    feedSources: (Array.isArray(post.feedSources) ? post.feedSources : []).slice(0, 3).map((item) => text(item, 20))
  };
}

function safeWatchAccount(value) {
  const account = value && typeof value === 'object' ? value : {};
  const metadata = account.metadata && typeof account.metadata === 'object' ? account.metadata : {};
  return {
    platform: text(account.platform, 40),
    accountKey: text(account.accountKey, 240),
    handle: text(account.handle, 240),
    name: text(account.name, 500),
    url: text(account.url, 2_000),
    remoteId: text(account.remoteId, 240),
    metadata: {
      hotSubscribeId: metadata.hotSubscribeId === null || metadata.hotSubscribeId === undefined
        ? null
        : text(metadata.hotSubscribeId, 240),
      monitorLevel: text(metadata.monitorLevel, 120)
    }
  };
}

function safeWalletLibraryEntry(value) {
  const address = String(value?.address || '').trim().toLowerCase();
  if (!/^0x[0-9a-f]{40}$/.test(address)) return null;
  return { address, note: String(value?.note || '').trim().slice(0, 500) };
}

function safeHeartbeat(value) {
  const heartbeat = value && typeof value === 'object' ? value : {};
  return {
    bridgeId: text(heartbeat.bridgeId, 240),
    version: text(heartbeat.version, 120),
    sessionId: text(heartbeat.sessionId, 240),
    capabilities: (Array.isArray(heartbeat.capabilities) ? heartbeat.capabilities : [])
      .slice(0, 50)
      .map((item) => text(item, 120)),
    error: redactSensitiveText(heartbeat.error),
    diagnostics: safeBridgeDiagnostics(heartbeat.diagnostics)
  };
}

function diagnosticCounter(value) {
  const number = Number(value);
  return Number.isSafeInteger(number) && number >= 0 && number <= DIAGNOSTIC_COUNTER_MAX ? number : 0;
}

function diagnosticTimestamp(value) {
  const number = Number(value);
  return Number.isSafeInteger(number) && number > 0 ? number : 0;
}

function diagnosticDuration(value) {
  const number = Number(value);
  return Number.isSafeInteger(number) && number >= 0 && number <= DIAGNOSTIC_DURATION_MAX_MS ? number : 0;
}

function diagnosticErrorType(value) {
  const type = text(value, 40).toUpperCase();
  return DIAGNOSTIC_ERROR_TYPES.has(type) ? type : '';
}

function safeBridgeDiagnostics(value) {
  const input = value && typeof value === 'object' && !Array.isArray(value) ? value : {};
  const ws = input.ws && typeof input.ws === 'object' && !Array.isArray(input.ws) ? input.ws : {};
  const wallet = input.wallet && typeof input.wallet === 'object' && !Array.isArray(input.wallet)
    ? input.wallet
    : {};
  const poll = input.poll && typeof input.poll === 'object' && !Array.isArray(input.poll) ? input.poll : {};
  const forcePoll = input.forcePoll && typeof input.forcePoll === 'object' && !Array.isArray(input.forcePoll)
    ? input.forcePoll
    : {};
  const hash = text(poll.configHash, 8).toLowerCase();
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
      configHash: /^[a-f0-9]{8}$/.test(hash) ? hash : '',
      latestSourceAt: diagnosticTimestamp(poll.latestSourceAt),
      lastErrorCategory: diagnosticErrorType(poll.lastErrorCategory),
      attempts: diagnosticCounter(poll.attempts),
      successes: diagnosticCounter(poll.successes),
      failures: diagnosticCounter(poll.failures)
    },
    forcePoll: {
      successes: diagnosticCounter(forcePoll.successes),
      failures: diagnosticCounter(forcePoll.failures),
      lastAt: diagnosticTimestamp(forcePoll.lastAt),
      elapsedMs: diagnosticDuration(forcePoll.elapsedMs),
      lastErrorCategory: diagnosticErrorType(forcePoll.lastErrorCategory)
    }
  };
}

function redactSensitiveText(value) {
  return text(value, 2_000)
    .replace(/\b(Bearer)\s+[^\s,;]+/gi, '$1 [redacted]')
    .replace(/\b(sub_token|access_token|refresh_token|auth_token|session_token|authorization|cookie|password|secret)\b\s*[:=]\s*[^\s,;]+/gi, '$1=[redacted]');
}

function optionalNumber(value) {
  if (value === null || value === undefined || value === '') return undefined;
  const result = Number(value);
  return Number.isFinite(result) ? result : undefined;
}

function compact(value) {
  return Object.fromEntries(Object.entries(value).filter(([, item]) => item !== undefined));
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

function jsonBytes(value) {
  return utf8Bytes(JSON.stringify(value));
}

function validEvmAddress(value) {
  return /^0x[0-9a-f]{40}$/.test(String(value || '').toLowerCase());
}

function validWalletAddress(value) {
  const address = String(value || '').toLowerCase();
  return validEvmAddress(address) && address !== '0x0000000000000000000000000000000000000000';
}

function safeTokenDetailResult(value) {
  const raw = value && typeof value === 'object' ? value : {};
  const token = raw.token && typeof raw.token === 'object' ? raw.token : {};
  const meta = token.meta && typeof token.meta === 'object' ? token.meta : {};
  const social = token.social && typeof token.social === 'object' ? token.social : {};
  const pair = raw.pair && typeof raw.pair === 'object' ? raw.pair : {};
  const dex = pair.dex && typeof pair.dex === 'object' ? pair.dex : {};
  const market = raw.market_metrics && typeof raw.market_metrics === 'object' ? raw.market_metrics : {};
  const address = text(meta.address || pair.tokenAddress, 100).toLowerCase();
  const chain = text(meta.chain || pair.chain || 'robinhood', 20).toLowerCase();
  if (!['robinhood', 'bsc'].includes(chain) || !validWalletAddress(address)) {
    throw new Error('Invalid token detail result');
  }
  const pools = (Array.isArray(raw.pools?.list) ? raw.pools.list : []).slice(0, 32).map((entry) => {
    const pool = entry && typeof entry === 'object' ? entry : {};
    const baseToken = pool.base_token && typeof pool.base_token === 'object' ? pool.base_token : {};
    return compact({
      pair: text(pool.pair, 100).toLowerCase(),
      dex_name: text(pool.dex_name, 120),
      contract: text(pool.contract, 120),
      liquidity: optionalNumber(pool.liquidity),
      base_token: compact({
        symbol: text(baseToken.symbol, 120),
        address: text(baseToken.address, 100).toLowerCase()
      })
    });
  });
  return {
    token: {
      meta: compact({
        chain,
        address,
        creator_address: text(meta.creator_address, 100).toLowerCase(),
        symbol: text(meta.symbol, 120),
        name: text(meta.name, 500),
        decimals: optionalNumber(meta.decimals),
        logo: text(meta.logo, 2_000),
        creation_timestamp: optionalNumber(meta.creation_timestamp)
      }),
      social: compact({ logo_cache: text(social.logo_cache, 2_000) })
    },
    pair: compact({
      chain,
      tokenPairAddress: text(pair.tokenPairAddress, 100).toLowerCase(),
      pair: text(pair.pair, 100).toLowerCase(),
      tokenAddress: text(pair.tokenAddress || address, 100).toLowerCase(),
      tokenSymbol: text(pair.tokenSymbol, 120),
      tokenName: text(pair.tokenName, 500),
      decimals: optionalNumber(pair.decimals),
      createTimestamp: optionalNumber(pair.createTimestamp),
      price: optionalNumber(pair.price),
      market_cap: optionalNumber(pair.market_cap),
      liquidity: optionalNumber(pair.liquidity),
      totalSupply: optionalNumber(pair.totalSupply),
      lastUpdateTime: optionalNumber(pair.lastUpdateTime),
      dex_name: text(pair.dex_name, 120),
      dex: compact({ dex_name: text(dex.dex_name, 120) })
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

const WALLET_PROFIT_NUMERIC_FIELDS = Object.freeze([
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
]);

const FIRST_FUNDING_FIELDS = Object.freeze([
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
]);

function safeWalletProfitResult(value) {
  const raw = value && typeof value === 'object' ? value : {};
  const chain = text(raw.chain || 'robinhood', 20).toLowerCase();
  const wallet = text(raw.wallet, 100).toLowerCase();
  const token = text(raw.token, 100).toLowerCase();
  if (!['robinhood', 'bsc'].includes(chain) || !validWalletAddress(wallet) || !validWalletAddress(token)) {
    throw new Error('Invalid wallet profit result');
  }
  const result = { chain, wallet, token };
  for (const field of WALLET_PROFIT_NUMERIC_FIELDS) {
    const parsed = optionalNumber(raw[field]);
    if (parsed !== undefined) result[field] = parsed;
  }
  if (raw.first_funding && typeof raw.first_funding === 'object') {
    result.first_funding = compact(Object.fromEntries(
      FIRST_FUNDING_FIELDS.map((field) => [field, text(raw.first_funding[field], 200)])
    ));
  }
  return result;
}

const HOLDER_PROFIT_NUMERIC_FIELDS = Object.freeze([
  ...WALLET_PROFIT_NUMERIC_FIELDS,
  'total_profit',
  'total_profit_rate',
  'pnl',
  'pnl_rate',
  'win_rate',
  'token_count',
  'winning_token_count'
]);

function safeNumericScalar(value) {
  if (typeof value === 'number') return Number.isFinite(value) ? value : undefined;
  if (typeof value !== 'string') return undefined;
  const candidate = value.trim();
  if (!candidate || candidate.length > 120
    || !/^[+-]?(?:\d+(?:\.\d*)?|\.\d+)(?:e[+-]?\d+)?$/i.test(candidate)) return undefined;
  return candidate;
}

function safeNonNegativeNumericScalar(value) {
  const parsed = safeNumericScalar(value);
  if (parsed === undefined) return undefined;
  return (typeof parsed === 'number' ? parsed < 0 : parsed.startsWith('-')) ? undefined : parsed;
}

function safeHolderTags(value) {
  const tags = [];
  const seen = new Set();
  for (const item of (Array.isArray(value) ? value : []).slice(0, 12)) {
    if (!['string', 'number', 'boolean'].includes(typeof item)) continue;
    const tag = text(item, 80).trim();
    const key = tag.toLowerCase();
    if (!tag || seen.has(key)) continue;
    seen.add(key);
    tags.push(tag);
  }
  return tags;
}

function safeBooleanFlag(value) {
  if (value === true || value === 1 || value === '1' || String(value || '').toLowerCase() === 'true') {
    return true;
  }
  if (value === false || value === 0 || value === '0' || String(value || '').toLowerCase() === 'false') {
    return false;
  }
  return undefined;
}

function safeTokenHoldersResult(value) {
  const raw = value && typeof value === 'object' && !Array.isArray(value) ? value : {};
  const chain = text(raw.chain, 20).toLowerCase();
  const token = text(raw.token, 100).toLowerCase();
  if (chain !== 'bsc' || !validWalletAddress(token) || !Array.isArray(raw.list)) {
    throw new Error('Invalid token Holder result');
  }
  const list = [];
  const seen = new Set();
  for (const valueRow of raw.list) {
    if (list.length >= 100) break;
    const row = valueRow && typeof valueRow === 'object' && !Array.isArray(valueRow) ? valueRow : {};
    const address = text(row.address, 100).toLowerCase();
    if (!validWalletAddress(address) || seen.has(address)) continue;
    seen.add(address);
    const profitRaw = row.profit && typeof row.profit === 'object' && !Array.isArray(row.profit)
      ? row.profit
      : {};
    const profit = {};
    for (const field of HOLDER_PROFIT_NUMERIC_FIELDS) {
      const parsed = optionalNumber(profitRaw[field]);
      if (parsed !== undefined) profit[field] = parsed;
    }
    const tags = safeHolderTags(row.tags);
    const rawRank = optionalNumber(row.rank);
    const rank = Number.isSafeInteger(rawRank) && rawRank > 0 ? rawRank : undefined;
    const rawShare = optionalNumber(row.holding_share_percent);
    const holdingSharePercent = rawShare !== undefined && rawShare >= 0 && rawShare <= 100
      ? rawShare
      : undefined;
    list.push(compact({
      address,
      rank,
      holding_amount: safeNonNegativeNumericScalar(row.holding_amount),
      holding_value_usd: safeNonNegativeNumericScalar(row.holding_value_usd),
      holding_share_percent: holdingSharePercent,
      is_contract: safeBooleanFlag(row.is_contract),
      is_pair: safeBooleanFlag(row.is_pair),
      is_pool: safeBooleanFlag(row.is_pool),
      is_lp: safeBooleanFlag(row.is_lp),
      is_burn: safeBooleanFlag(row.is_burn),
      type: text(row.type, 120) || undefined,
      wallet_type: text(row.wallet_type, 120) || undefined,
      label: text(row.label, 120) || undefined,
      name: text(row.name, 120) || undefined,
      tags: tags.length ? tags : undefined,
      profit: Object.keys(profit).length ? profit : undefined
    }));
  }
  const result = compact({
    chain,
    token,
    total: optionalNumber(raw.total),
    list
  });
  while (list.length && jsonBytes(result) > MAX_ANALYSIS_RESULT_BYTES) list.pop();
  if (jsonBytes(result) > MAX_ANALYSIS_RESULT_BYTES) throw new Error('Analysis result is too large');
  return result;
}

function safeAnalysisResult(value) {
  if (!value || typeof value !== 'object' || Array.isArray(value)) {
    throw new Error('Analysis result must be an object');
  }
  const result = value.token && typeof value.token === 'object'
    ? safeTokenDetailResult(value)
    : Array.isArray(value.list)
      ? safeTokenHoldersResult(value)
      : safeWalletProfitResult(value);
  if (jsonBytes(result) > MAX_ANALYSIS_RESULT_BYTES) throw new Error('Analysis result is too large');
  return result;
}

function safeAnalysisResultPayload(value) {
  const payload = value && typeof value === 'object' ? value : {};
  const jobId = Number(payload.jobId);
  const claimToken = text(payload.claimToken, 240);
  if (!Number.isSafeInteger(jobId) || jobId <= 0) throw new Error('Invalid analysis job id');
  if (!claimToken) throw new Error('Analysis claim token is required');
  const success = payload.success === true;
  const errorType = success
    ? ''
    : ANALYSIS_ERROR_TYPES.has(text(payload.errorType || payload.error, 40).toUpperCase())
      ? text(payload.errorType || payload.error, 40).toUpperCase()
      : 'DEBOT';
  return {
    jobId,
    claimToken,
    success,
    result: success ? safeAnalysisResult(payload.result) : null,
    error: success ? '' : redactSensitiveText(payload.error || errorType),
    errorType
  };
}

async function settings() {
  await storageReady;
  const saved = await chrome.storage.local.get(['serverBase', 'bridgeToken', 'bridgeTokenOrigin']);
  let serverBase = '';
  try {
    if (saved.serverBase) serverBase = normalizeServerBase(saved.serverBase);
  } catch {
    // Invalid legacy settings remain inert until the user saves a valid address.
  }
  const storedToken = String(saved.bridgeToken || '').trim();
  const currentOrigin = serverBase ? serverOriginForBase(serverBase) : '';
  const bridgeTokenOrigin = String(saved.bridgeTokenOrigin || '').trim() || (storedToken ? currentOrigin : '');
  return {
    serverBase,
    bridgeToken: storedToken && bridgeTokenOrigin === currentOrigin ? storedToken : '',
    bridgeTokenOrigin
  };
}

async function hasServerHostPermission(serverBase) {
  if (!serverBase) return false;
  return chrome.permissions.contains({ origins: [hostPermissionForServerBase(serverBase)] });
}

async function registeredRadarContentScript() {
  const registrations = await chrome.scripting.getRegisteredContentScripts({
    ids: [RADAR_CONTENT_SCRIPT_ID]
  });
  return registrations.find((entry) => entry.id === RADAR_CONTENT_SCRIPT_ID) || null;
}

async function removeRadarContentScript() {
  const current = await registeredRadarContentScript();
  if (current) await chrome.scripting.unregisterContentScripts({ ids: [RADAR_CONTENT_SCRIPT_ID] });
}

async function syncRadarContentScript(value = null) {
  const config = value || await settings();
  if (!config.serverBase || !(await hasServerHostPermission(config.serverBase))) {
    await removeRadarContentScript();
    return { registered: false };
  }

  const matches = radarContentMatchesForServerBase(config.serverBase);
  const current = await registeredRadarContentScript();
  if (current && JSON.stringify(current.matches || []) === JSON.stringify(matches)) {
    return { registered: true, matches };
  }
  if (current) await chrome.scripting.unregisterContentScripts({ ids: [RADAR_CONTENT_SCRIPT_ID] });
  await chrome.scripting.registerContentScripts([{
    id: RADAR_CONTENT_SCRIPT_ID,
    matches,
    js: ['radar-content.js'],
    runAt: 'document_start',
    allFrames: false,
    persistAcrossSessions: true
  }]);
  return { registered: true, matches };
}

function serializeSettingsWrite(operation) {
  const result = settingsWriteQueue.then(operation, operation);
  settingsWriteQueue = result.catch(() => {});
  return result;
}

async function publicSettings(value) {
  const hostPermissionGranted = await hasServerHostPermission(value.serverBase);
  return {
    serverBase: value.serverBase,
    bridgeToken: value.bridgeToken ? 'configured' : '',
    hostPermissionGranted
  };
}

function saveSettings(next) {
  return serializeSettingsWrite(async () => {
    const current = await settings();
    const serverBase = normalizeServerBase(next.serverBase || current.serverBase);
    if (!(await hasServerHostPermission(serverBase))) {
      throw new Error('Grant access to the configured Radar host before saving');
    }
    const serverOrigin = serverOriginForBase(serverBase);
    const suppliedToken = Object.hasOwn(next, 'bridgeToken')
      ? String(next.bridgeToken || '').trim()
      : '';
    if (!suppliedToken && current.bridgeToken && current.bridgeTokenOrigin !== serverOrigin) {
      throw new Error('Enter the device token again when changing the Radar origin');
    }
    const bridgeToken = suppliedToken || current.bridgeToken;
    if (!bridgeToken) throw new Error('Device token is required');
    const value = {
      serverBase,
      bridgeToken,
      bridgeTokenOrigin: bridgeToken ? serverOrigin : ''
    };
    await chrome.storage.local.set(value);
    await syncRadarContentScript(value);
    await updateBadge(value.bridgeToken ? 'ON' : '?', value.bridgeToken ? '#16834b' : '#bd8121');
    return publicSettings(value);
  });
}

function migrateLocalSettings(next) {
  return serializeSettingsWrite(async () => {
    await storageReady;
    const saved = await chrome.storage.local.get(['serverBase', 'bridgeToken', 'bridgeTokenOrigin']);
    const existingToken = String(saved.bridgeToken || '').trim();
    let serverBase = '';
    try {
      serverBase = normalizeServerBase(saved.serverBase || next.serverBase);
    } catch {
      serverBase = normalizeServerBase(next.serverBase);
    }
    if (!(await hasServerHostPermission(serverBase))) {
      throw new Error('Grant access to the configured Radar host before migrating settings');
    }
    const serverOrigin = serverOriginForBase(serverBase);
    if (existingToken) {
      const existingOrigin = String(saved.bridgeTokenOrigin || '').trim() || serverOrigin;
      const value = {
        serverBase,
        bridgeToken: existingOrigin === serverOrigin ? existingToken : '',
        bridgeTokenOrigin: existingOrigin
      };
      if (!saved.bridgeTokenOrigin && value.bridgeToken) {
        await chrome.storage.local.set({ bridgeTokenOrigin: serverOrigin });
      }
      await syncRadarContentScript(value);
      return publicSettings(value);
    }
    const bridgeToken = String(next.bridgeToken || '').trim();
    if (!bridgeToken) throw new Error('Bridge token is required');
    const value = { serverBase, bridgeToken, bridgeTokenOrigin: serverOrigin };
    await chrome.storage.local.set(value);
    await syncRadarContentScript(value);
    await updateBadge('ON', '#16834b');
    return publicSettings(value);
  });
}

async function updateBadge(text, color) {
  try {
    await chrome.action.setBadgeText({ text });
    await chrome.action.setBadgeBackgroundColor({ color });
  } catch {
    // Badge support is not required for bridge operation.
  }
}

async function socialRequest(path, {
  method = 'GET',
  body = null,
  timeoutMs = SOCIAL_REQUEST_TIMEOUT_MS
} = {}) {
  const config = await settings();
  if (!config.serverBase) throw new Error('Radar social API is not configured');
  if (!config.bridgeToken) throw new Error('Bridge token is not configured');
  if (!(await hasServerHostPermission(config.serverBase))) {
    throw new Error('Radar host permission is not granted');
  }
  const normalizedPath = String(path || '').startsWith('/') ? String(path) : `/${path}`;
  const requestUrl = new URL(`${config.serverBase}${normalizedPath}`);
  if (requestUrl.origin !== config.bridgeTokenOrigin) {
    throw new Error('Bridge token is not bound to the requested Radar origin');
  }
  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), timeoutMs);
  let response;
  let responseText;
  try {
    response = await fetch(requestUrl.href, {
      method,
      signal: controller.signal,
      headers: {
        accept: 'application/json',
        authorization: `Bearer ${config.bridgeToken}`,
        ...(body === null ? {} : { 'content-type': 'application/json' })
      },
      ...(body === null ? {} : { body: JSON.stringify(body) })
    });
    responseText = await response.text();
  } catch (error) {
    if (error?.name === 'AbortError') throw new Error('Radar social API timed out');
    throw error;
  } finally {
    clearTimeout(timeout);
  }
  let payload = {};
  try {
    payload = responseText ? JSON.parse(responseText) : {};
  } catch {
    payload = { error: responseText || `HTTP ${response.status}` };
  }
  if (!response.ok) {
    const error = new Error(payload.error || payload.message || `HTTP ${response.status}`);
    error.status = response.status;
    error.code = payload.code || '';
    throw error;
  }
  await updateBadge('ON', '#16834b');
  return payload;
}

function clearPostFlushRetry({ resetAttempt = false } = {}) {
  if (postFlushRetryTimer !== null) clearTimeout(postFlushRetryTimer);
  postFlushRetryTimer = null;
  if (resetAttempt) postFlushRetryAttempt = 0;
}

function schedulePostFlushRetry() {
  if (postFlushRetryTimer !== null) return;
  const delay = postUploadRetryDelay(postFlushRetryAttempt);
  if (delay === null) return;
  postFlushRetryAttempt += 1;
  postFlushRetryTimer = setTimeout(() => {
    postFlushRetryTimer = null;
    void flushPostOutbox();
  }, delay);
}

async function uploadPostRecords(records) {
  try {
    const acknowledgement = await socialRequest('/bridge/posts', {
      method: 'POST',
      body: { posts: records.map((record) => record.post) },
      timeoutMs: POST_UPLOAD_REQUEST_TIMEOUT_MS
    });
    if (acknowledgement?.ok !== true) {
      throw new Error('Radar social API did not acknowledge the post batch');
    }
    await postOutbox.acknowledge(records.map((record) => record.key));
    return { sent: records.length, discarded: 0 };
  } catch (error) {
    if (error?.status !== 400) throw error;
    if (records.length === 1) {
      await postOutbox.acknowledge([records[0].key]);
      return { sent: 0, discarded: 1 };
    }
    const midpoint = Math.ceil(records.length / 2);
    const left = await uploadPostRecords(records.slice(0, midpoint));
    const right = await uploadPostRecords(records.slice(midpoint));
    return {
      sent: left.sent + right.sent,
      discarded: left.discarded + right.discarded
    };
  }
}

function flushPostOutbox() {
  if (postFlushInFlight) return postFlushInFlight;
  postFlushRequested = false;
  postFlushInFlight = (async () => {
    await storageReady;
    let sent = 0;
    let discarded = 0;
    for (let batchNumber = 0; batchNumber < 5; batchNumber += 1) {
      const batch = await postOutbox.readBatch(200);
      if (!batch.count) break;
      const uploaded = await uploadPostRecords(batch.records);
      sent += uploaded.sent;
      discarded += uploaded.discarded;
      if (!batch.remaining) break;
    }
    const result = { ok: true, sent, discarded, ...(await postOutbox.stats()) };
    clearPostFlushRetry({ resetAttempt: true });
    return result;
  })().catch(async (error) => {
    await updateBadge('!', '#b33a45');
    schedulePostFlushRetry();
    return { ok: false, error: redactSensitiveText(error instanceof Error ? error.message : String(error)) };
  }).finally(() => {
    postFlushInFlight = null;
    if (postFlushRequested) void flushPostOutbox();
  });
  return postFlushInFlight;
}

function requestPostFlush() {
  if (postFlushInFlight) {
    postFlushRequested = true;
    return postFlushInFlight;
  }
  clearPostFlushRetry();
  return flushPostOutbox();
}

async function queuePosts(value) {
  const posts = (Array.isArray(value) ? value : [])
    .map(safePost)
    .filter((post) => post?.source && post.externalId)
    .slice(0, 200)
    .sort((left, right) => (left.sourceUpdatedAt || left.publishedAt) - (right.sourceUpdatedAt || right.publishedAt));
  if (!posts.length) return { queued: 0, skipped: true };
  await storageReady;
  const result = await postOutbox.enqueue(posts, { requireAll: true });
  void requestPostFlush();
  return {
    queued: result.queued,
    bytes: result.bytes,
    added: result.added,
    duplicates: result.duplicates,
    rejected: result.rejected,
    overflow: result.overflow,
    durable: result.overflow === 0,
    backpressured: result.overflow > 0
  };
}

function flushWalletEventOutbox() {
  if (walletEventFlushInFlight) return walletEventFlushInFlight;
  walletEventFlushInFlight = (async () => {
    await storageReady;
    const records = await walletEventOutbox.readBatch(100);
    if (!records.length) return { ok: true, sent: 0 };
    const acknowledgement = await socialRequest('/bridge/wallet-events', {
      method: 'POST',
      body: { events: records.map((record) => record.event) },
      timeoutMs: 15_000
    });
    if (acknowledgement?.ok !== true) throw new Error('Radar did not acknowledge wallet events');
    await walletEventOutbox.acknowledge(records.map((record) => record.key));
    walletEventRetryAttempt = 0;
    return { ok: true, sent: records.length };
  })().catch((error) => {
    if (walletEventRetryTimer === null) {
      const delay = [2_000, 4_000, 8_000, 30_000][Math.min(walletEventRetryAttempt, 3)];
      walletEventRetryAttempt += 1;
      walletEventRetryTimer = setTimeout(() => {
        walletEventRetryTimer = null;
        void flushWalletEventOutbox();
      }, delay);
    }
    return { ok: false, error: redactSensitiveText(error instanceof Error ? error.message : String(error)) };
  }).finally(() => { walletEventFlushInFlight = null; });
  return walletEventFlushInFlight;
}

async function queueWalletEvents(value) {
  await storageReady;
  const result = await walletEventOutbox.enqueue(value);
  void flushWalletEventOutbox();
  return result;
}

async function uploadAnalysisResult(record) {
  const payload = record.payload;
  try {
    const acknowledgement = await socialRequest(`/bridge/debot/jobs/${payload.jobId}/result`, {
      method: 'POST',
      body: {
        claimToken: payload.claimToken,
        success: payload.success,
        result: payload.result,
        error: payload.error,
        errorType: payload.errorType
      }
    });
    if (acknowledgement?.ok !== true) {
      throw new Error('Radar API did not acknowledge the analysis result');
    }
    return { key: record.key, acknowledged: true };
  } catch (error) {
    // Validation, size and stale-claim failures can never accept this exact result.
    if ([400, 404, 409, 413, 422].includes(Number(error?.status))) {
      return { key: record.key, acknowledged: true, stale: true };
    }
    return { key: record.key, acknowledged: false };
  }
}

async function uploadAnalysisResultBatch(records) {
  const acknowledged = [];
  for (let index = 0; index < records.length; index += ANALYSIS_RESULT_UPLOAD_CONCURRENCY) {
    const chunk = records.slice(index, index + ANALYSIS_RESULT_UPLOAD_CONCURRENCY);
    const results = await Promise.all(chunk.map((record) => uploadAnalysisResult(record)));
    acknowledged.push(...results.filter((result) => result.acknowledged).map((result) => result.key));
  }
  return acknowledged;
}

function flushAnalysisResultOutbox() {
  if (analysisResultFlushInFlight) return analysisResultFlushInFlight;
  analysisResultFlushRequested = false;
  analysisResultFlushInFlight = (async () => {
    await storageReady;
    let sent = 0;
    for (let batchNumber = 0; batchNumber < 5; batchNumber += 1) {
      const batch = await analysisResultOutbox.readBatch(ANALYSIS_RESULT_BATCH_SIZE);
      if (!batch.count) break;
      const acknowledged = await uploadAnalysisResultBatch(batch.records);
      if (!acknowledged.length) break;
      await analysisResultOutbox.acknowledge(acknowledged);
      sent += acknowledged.length;
      if (!batch.remaining && acknowledged.length === batch.count) break;
    }
    return { ok: true, sent, ...(await analysisResultOutbox.stats()) };
  })().catch(async (error) => {
    await updateBadge('!', '#b33a45');
    return { ok: false, error: redactSensitiveText(error instanceof Error ? error.message : String(error)) };
  }).finally(() => {
    analysisResultFlushInFlight = null;
    if (analysisResultFlushRequested) void flushAnalysisResultOutbox();
  });
  return analysisResultFlushInFlight;
}

function requestAnalysisResultFlush() {
  if (analysisResultFlushInFlight) analysisResultFlushRequested = true;
  return flushAnalysisResultOutbox();
}

async function queueAnalysisResult(value) {
  const payload = safeAnalysisResultPayload(value);
  await storageReady;
  const result = await analysisResultOutbox.enqueue(payload);
  if (result.added || result.duplicates) void requestAnalysisResultFlush();
  return {
    queued: result.queued,
    added: result.added,
    duplicates: result.duplicates,
    overflow: result.overflow,
    durable: result.overflow === 0 && result.rejected === 0
  };
}

async function handleBridgePayload(message) {
  if (message.type === 'heartbeat') {
    return socialRequest('/bridge/heartbeat', { method: 'POST', body: safeHeartbeat(message.payload) });
  }
  if (message.type === 'posts') {
    return queuePosts(message.payload?.posts);
  }
  if (message.type === 'wallet-events') return queueWalletEvents(message.payload?.events);
  if (message.type === 'wallet-library') {
    const wallets = Array.isArray(message.payload?.wallets)
      ? message.payload.wallets.map(safeWalletLibraryEntry).filter(Boolean)
      : [];
    return socialRequest('/bridge/wallets/snapshot', {
      method: 'POST',
      body: { complete: message.payload?.complete === true, wallets: wallets.slice(0, 5_000) }
    });
  }
  if (message.type === 'watchlist') {
    const accounts = Array.isArray(message.payload?.accounts)
      ? message.payload.accounts.map(safeWatchAccount).filter((account) => account.handle)
      : [];
    snapshotRevision += 1;
    return socialRequest('/bridge/watchlist/snapshot', {
      method: 'POST',
      body: {
        accounts: accounts.slice(0, 5_000),
        complete: true,
        snapshotSessionId: SNAPSHOT_SESSION_ID,
        snapshotSessionStartedAt: SNAPSHOT_SESSION_STARTED_AT,
        snapshotRevision
      }
    });
  }
  throw new Error('Unsupported bridge payload');
}

function normalizedRecoveryState(value) {
  const state = value && typeof value === 'object' ? value : {};
  return {
    managedTabId: Number.isSafeInteger(Number(state.managedTabId)) ? Number(state.managedTabId) : null,
    createdAt: Math.max(0, number(state.createdAt)),
    lastHealthyAt: Math.max(0, number(state.lastHealthyAt)),
    lastProbeAt: Math.max(0, number(state.lastProbeAt)),
    structuralFailures: Math.max(0, Math.trunc(number(state.structuralFailures))),
    lastReloadAt: Math.max(0, number(state.lastReloadAt)),
    reloadLevel: Math.max(0, Math.trunc(number(state.reloadLevel))),
    lastErrorType: text(state.lastErrorType, 40)
  };
}

async function loadRecoveryState() {
  await storageReady;
  const stored = await chrome.storage.session.get(RECOVERY_STATE_KEY);
  return normalizedRecoveryState(stored?.[RECOVERY_STATE_KEY]);
}

async function saveRecoveryState(state) {
  await storageReady;
  await chrome.storage.session.set({ [RECOVERY_STATE_KEY]: normalizedRecoveryState(state) });
}

function ensureRecoveryAlarm() {
  chrome.alarms.create(RECOVERY_ALARM, { periodInMinutes: RECOVERY_PERIOD_MINUTES });
}

function chooseManagedTab(tabs, managedTabId) {
  return tabs.find((tab) => tab.id === managedTabId && !tab.discarded)
    || tabs.find((tab) => tab.pinned && !tab.discarded)
    || tabs.find((tab) => !tab.discarded)
    || tabs.find((tab) => tab.id === managedTabId)
    || tabs[0]
    || null;
}

async function findDeBotTabs() {
  const tabs = await chrome.tabs.query({ url: DEBOT_URL_PATTERN });
  return tabs.filter((tab) => Number.isSafeInteger(tab.id));
}

function isDeBotSenderUrl(value) {
  try {
    const url = new URL(String(value || ''));
    return url.protocol === 'https:' && url.hostname === 'debot.ai';
  } catch {
    return false;
  }
}

async function isRadarContentSender(sender) {
  if (!chrome.runtime.id || sender?.id !== chrome.runtime.id) return false;
  if (!Number.isSafeInteger(Number(sender?.tab?.id))) return false;
  const config = await settings();
  if (!config.serverBase || !(await hasServerHostPermission(config.serverBase))) return false;
  if (!isRadarPageUrl(sender?.url, config.serverBase)) return false;
  return !sender?.tab?.url || isRadarPageUrl(sender.tab.url, config.serverBase);
}

async function isManagedDeBotSender(sender) {
  if (!chrome.runtime.id || sender?.id !== chrome.runtime.id) return false;
  if (!isDeBotSenderUrl(sender?.url)) return false;
  if (sender?.tab?.url && !isDeBotSenderUrl(sender.tab.url)) return false;
  const tabId = Number(sender?.tab?.id);
  if (!Number.isSafeInteger(tabId)) return false;
  const state = await loadRecoveryState();
  if (state.managedTabId === tabId) return true;
  const tabs = await findDeBotTabs();
  const managed = chooseManagedTab(tabs, state.managedTabId);
  if (managed?.id !== tabId) return false;
  await saveRecoveryState({ ...state, managedTabId: tabId });
  return true;
}

async function probeDeBotTab(tabId, requestId) {
  let timeoutId;
  try {
    return await Promise.race([
      chrome.tabs.sendMessage(tabId, {
        source: 'debot-social-background',
        type: 'force-poll',
        requestId
      }),
      new Promise((resolve) => {
        timeoutId = setTimeout(() => {
          resolve({ ok: false, requestId, errorType: 'PAGE_TIMEOUT' });
        }, RECOVERY_PROBE_TIMEOUT_MS);
      })
    ]);
  } finally {
    clearTimeout(timeoutId);
  }
}

async function createManagedDeBotTab(state, now) {
  const existing = await findDeBotTabs();
  if (existing.length) return chooseManagedTab(existing, state.managedTabId);
  const created = await chrome.tabs.create({ url: DEBOT_URL, active: false, pinned: true });
  if (!Number.isSafeInteger(created?.id)) throw new Error('Chrome did not return the DeBot tab id');
  await chrome.tabs.update(created.id, { autoDiscardable: false }).catch(() => {});
  await saveRecoveryState({
    ...state,
    managedTabId: created.id,
    createdAt: now,
    structuralFailures: 0,
    lastProbeAt: now,
    lastErrorType: ''
  });
  return created;
}

async function reloadManagedTab(tab, state, now, errorType) {
  const reloadIndex = Math.min(state.reloadLevel, RECOVERY_RELOAD_BACKOFF_MS.length - 1);
  const cooldown = RECOVERY_RELOAD_BACKOFF_MS[reloadIndex];
  if (state.lastReloadAt && now - state.lastReloadAt < cooldown) {
    await saveRecoveryState({ ...state, lastProbeAt: now, lastErrorType: errorType });
    return { ok: false, action: 'reload-backoff', errorType };
  }
  await chrome.tabs.reload(tab.id);
  await saveRecoveryState({
    ...state,
    managedTabId: tab.id,
    createdAt: now,
    lastProbeAt: now,
    structuralFailures: 0,
    lastReloadAt: now,
    reloadLevel: Math.min(state.reloadLevel + 1, RECOVERY_RELOAD_BACKOFF_MS.length - 1),
    lastErrorType: errorType
  });
  return { ok: false, action: 'reloaded', errorType };
}

async function maintainDeBotConnection() {
  const config = await settings();
  if (!config.bridgeToken) return { ok: false, action: 'unconfigured' };

  const now = Date.now();
  let state = await loadRecoveryState();
  const tabs = await findDeBotTabs();
  const tab = tabs.length ? chooseManagedTab(tabs, state.managedTabId) : await createManagedDeBotTab(state, now);
  if (!tab) return { ok: false, action: 'missing-tab' };
  if (!tabs.length) state = await loadRecoveryState();
  await chrome.tabs.update(tab.id, { autoDiscardable: false }).catch(() => {});

  const requestId = `recovery-${now}-${Math.random().toString(36).slice(2, 10)}`;
  let result;
  try {
    result = await probeDeBotTab(tab.id, requestId);
  } catch {
    result = { ok: false, errorType: 'NO_RECEIVER' };
  }

  if (result?.ok === true && result.requestId === requestId) {
    await saveRecoveryState({
      ...state,
      managedTabId: tab.id,
      createdAt: state.managedTabId === tab.id ? state.createdAt : 0,
      lastHealthyAt: now,
      lastProbeAt: now,
      structuralFailures: 0,
      reloadLevel: 0,
      lastErrorType: ''
    });
    return { ok: true, action: 'healthy' };
  }

  const errorType = text(result?.errorType || 'PAGE_TIMEOUT', 40).toUpperCase();
  if (['AUTH', 'TIMEOUT', 'NETWORK', 'DEBOT'].includes(errorType)) {
    await saveRecoveryState({
      ...state,
      managedTabId: tab.id,
      lastProbeAt: now,
      structuralFailures: 0,
      lastErrorType: errorType
    });
    return { ok: false, action: 'retry', errorType };
  }

  const structuralFailures = state.structuralFailures + 1;
  const withinLoadGrace = state.createdAt > 0
    && now - state.createdAt < RECOVERY_LOAD_GRACE_MS;
  const nextState = {
    ...state,
    managedTabId: tab.id,
    lastProbeAt: now,
    structuralFailures,
    lastErrorType: errorType
  };
  if (!tab.discarded && (withinLoadGrace || structuralFailures < 2)) {
    await saveRecoveryState(nextState);
    return { ok: false, action: withinLoadGrace ? 'loading-grace' : 'probe-failed', errorType };
  }
  return reloadManagedTab(tab, nextState, now, errorType);
}

function runBridgeMaintenance() {
  if (bridgeMaintenanceInFlight) return bridgeMaintenanceInFlight;
  bridgeMaintenanceInFlight = Promise.allSettled([
    flushPostOutbox(),
    flushAnalysisResultOutbox(),
    flushWalletEventOutbox(),
    maintainDeBotConnection(),
    syncRadarContentScript()
  ]).finally(() => {
    bridgeMaintenanceInFlight = null;
  });
  return bridgeMaintenanceInFlight;
}

chrome.runtime.onMessage.addListener((message, sender, sendResponse) => {
  const run = async () => {
    if (!message || typeof message !== 'object') throw new Error('Invalid bridge message');
    if (message.source === 'debot-social-relay') {
      if (!(await isManagedDeBotSender(sender))) {
        if (message.type === 'poll-commands') return { ok: true, commands: [], managed: false };
        if (message.type === 'poll-analysis-jobs') return { ok: true, jobs: [], managed: false };
        if (['posts', 'analysis-result', 'wallet-events', 'wallet-library'].includes(message.type)) return { durable: false, managed: false };
        return { accepted: false, managed: false };
      }
      if (['heartbeat', 'posts', 'watchlist', 'wallet-events', 'wallet-library'].includes(message.type)) {
        return handleBridgePayload(message);
      }
      if (message.type === 'poll-commands') {
        return socialRequest('/bridge/commands?limit=50');
      }
      if (message.type === 'poll-analysis-jobs') {
        const requestedLimit = Number(message.payload?.limit);
        const limit = Number.isSafeInteger(requestedLimit)
          ? Math.min(MAX_ANALYSIS_CONCURRENCY, Math.max(1, requestedLimit))
          : MAX_ANALYSIS_CONCURRENCY;
        return socialRequest(`/bridge/debot/jobs?limit=${limit}`);
      }
      if (message.type === 'command-result') {
        const commandId = Number(message.payload?.commandId);
        if (!Number.isSafeInteger(commandId) || commandId <= 0) throw new Error('Invalid command id');
        return socialRequest(`/bridge/commands/${commandId}/ack`, {
          method: 'POST',
          body: {
            success: message.payload?.success === true,
            error: redactSensitiveText(message.payload?.error),
            remoteId: String(message.payload?.remoteId || ''),
            verifiedAbsent: message.payload?.verifiedAbsent === true
          }
        });
      }
      if (message.type === 'analysis-result') {
        return queueAnalysisResult(message.payload);
      }
      throw new Error('Unsupported DeBot relay message');
    }
    if (message.source === 'robinhood-radar-content' && message.type === 'status') {
      if (!(await isRadarContentSender(sender))) {
        throw new Error('Untrusted Radar status sender');
      }
      const value = await settings();
      return { configured: Boolean(value.bridgeToken), writable: true };
    }
    if (message.source === 'robinhood-radar-content' && message.type === 'api') {
      if (!(await isRadarContentSender(sender))) {
        throw new Error('Radar social writes require the configured page');
      }
      const path = String(message.command?.path || '');
      if (!/^\/watchlist(?:\/batch|\/\d+)?$/.test(path)) throw new Error('Radar requested a disallowed social route');
      const method = String(message.command?.method || 'GET').toUpperCase();
      if (!['POST', 'PATCH', 'DELETE'].includes(method)) throw new Error('Radar requested a disallowed method');
      return socialRequest(path, { method, body: message.command?.body ?? null });
    }
    if (message.source === 'bridge-options' && message.type === 'get-settings') {
      const value = await settings();
      return publicSettings(value);
    }
    if (message.source === 'bridge-options' && message.type === 'save-settings') {
      return saveSettings(message.payload || {});
    }
    if (message.source === 'bridge-options' && message.type === 'migrate-local-settings') {
      return migrateLocalSettings(message.payload || {});
    }
    throw new Error('Unsupported bridge message');
  };
  let operation;
  if (message?.source === 'debot-social-relay' && message.type === 'watchlist') {
    operation = watchlistUploadQueue.catch(() => {}).then(run);
    watchlistUploadQueue = operation;
  } else if (message?.source === 'debot-social-relay'
    && message.type === 'command-result'
    && message.payload?.success === true) {
    // The page emits its verified complete snapshot before the success result.
    // Keeping both on this queue prevents the command acknowledgement from
    // racing ahead of that snapshot at the VPS.
    operation = watchlistUploadQueue.then(run);
    watchlistUploadQueue = operation;
  } else {
    operation = run();
  }
  void operation.then((payload) => sendResponse({ ok: true, payload })).catch(async (error) => {
    await updateBadge('!', '#b33a45');
    sendResponse({ ok: false, error: error instanceof Error ? error.message : String(error) });
  });
  return true;
});

ensureRecoveryAlarm();
chrome.runtime.onInstalled.addListener(() => {
  ensureRecoveryAlarm();
  void runBridgeMaintenance();
});
chrome.runtime.onStartup.addListener(() => {
  ensureRecoveryAlarm();
  void runBridgeMaintenance();
});
chrome.alarms.onAlarm.addListener((alarm) => {
  if (alarm?.name === RECOVERY_ALARM) void runBridgeMaintenance();
});
chrome.permissions.onAdded.addListener(() => {
  void syncRadarContentScript();
});
chrome.permissions.onRemoved.addListener(() => {
  void syncRadarContentScript();
});

void settings().then(async (value) => {
  await updateBadge(value.bridgeToken ? 'ON' : '?', value.bridgeToken ? '#16834b' : '#bd8121');
  await syncRadarContentScript(value);
  await runBridgeMaintenance();
});
