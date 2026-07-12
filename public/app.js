const APP_BASE = window.location.pathname.startsWith('/robinhood-radar/') ? '/robinhood-radar' : '';
const API_ROOT = `${APP_BASE}/api/robinhood`;
const EXPLORER_ROOT = 'https://robinhoodchain.blockscout.com';
const DEBOT_ADDRESS_ROOT = 'https://debot.ai/address/robinhood';
const DEBOT_TOKEN_ROOT = 'https://debot.ai/token/robinhood/308574_';
const DEBOT_WALLET_MANAGER_URL = 'https://debot.ai/track?chain=robinhood&tab=manager';
const ADDRESS_PATTERN = /^0x[0-9a-fA-F]{40}$/;
const HASH_PATTERN = /^0x[0-9a-fA-F]{64}$/;
const ACTIVE_JOB_STATES = new Set(['queued', 'pending', 'running', 'scanning', 'refreshing', 'fetching', 'analyzing']);
const REVIEW_SCAN_BATCH_GAP_MS = 5 * 60 * 1000;
const MONITOR_POLL_INTERVAL_MS = 2_000;
const MONITOR_THRESHOLD_STORAGE_KEY = 'robinhood-monitor-threshold';
const MONITOR_SOUNDS = new Set(['alarm', 'bell', 'electronic', 'glass']);
const MONITOR_EVENT_TYPES = Object.freeze(['buy', 'sell', 'transfer', 'token_create']);

const MONITOR_EVENT_LABELS = Object.freeze({
  buy: '买入',
  sell: '卖出',
  transfer: '转账',
  token_create: '创建代币'
});

const MONITOR_TIER_LABELS = Object.freeze({
  core: '核心钱包',
  watch: '普通观察钱包',
  high_frequency: '高频钱包'
});

const TAB_LABELS = Object.freeze({
  monitor: '实时监控',
  candidates: '最近重扫候选',
  all_round: '已确认地址库',
  winners: '金狗队列'
});

const CLASSIFICATION_LABELS = Object.freeze({
  candidates: '智能候选',
  all_round: '全能高手',
  realized: '兑现高手',
  unrealized: '潜伏高手',
  single_hit: '单次神单',
  dev: 'Dev',
  router: '路由',
  pool: '池子',
  bundler: '捆绑',
  sniper: '狙击',
  wash: '对敲',
  high_frequency: '高频撒网'
});

const SORT_LABELS = Object.freeze({
  name: '名称 A-Z',
  smart_score: '智能评分',
  total_profit: '总盈利',
  holding_value: '持仓市值',
  holder_rank: 'Holder 排名',
  realized_profit: '已实现盈利',
  unrealized_profit: '未实现盈利',
  best_multiple: '最高倍数',
  hits: '命中次数'
});

const elements = {
  candidateCount: document.querySelector('#candidate-count'),
  minHits: document.querySelector('#min-hits'),
  walletCount: document.querySelector('#wallet-count'),
  winnerCount: document.querySelector('#winner-count'),
  updatedAt: document.querySelector('#updated-at'),
  minEntrySummary: document.querySelector('#min-entry-summary'),
  minEntryInput: document.querySelector('#min-entry-input'),
  status: document.querySelector('#system-status'),
  statusTitle: document.querySelector('#status-title'),
  statusMessage: document.querySelector('#status-message'),
  statusProgress: document.querySelector('#status-progress'),
  refreshButton: document.querySelector('#refresh-button'),
  scanButton: document.querySelector('#scan-button'),
  submissionDock: document.querySelector('#submission-dock'),
  tabs: document.querySelector('#view-tabs'),
  filterForm: document.querySelector('#filter-form'),
  manualForm: document.querySelector('#manual-token-form'),
  manualInput: document.querySelector('#manual-token-address'),
  manualFeedback: document.querySelector('#manual-token-feedback'),
  libraryForm: document.querySelector('#library-filter-form'),
  walletSearch: document.querySelector('#wallet-search'),
  walletStatus: document.querySelector('#wallet-status'),
  walletMonitorTierField: document.querySelector('#wallet-monitor-tier-field'),
  walletMonitorTier: document.querySelector('#wallet-monitor-tier'),
  walletTag: document.querySelector('#wallet-tag'),
  libraryFilterClear: document.querySelector('#library-filter-clear'),
  debotExportButton: document.querySelector('#debot-export-button'),
  manualWalletForm: document.querySelector('#manual-wallet-form'),
  manualWalletLines: document.querySelector('#manual-wallet-lines'),
  manualWalletFeedback: document.querySelector('#manual-wallet-feedback'),
  manualWalletAddButton: document.querySelector('#manual-wallet-add-button'),
  resultsTitle: document.querySelector('#results-title'),
  resultsSummary: document.querySelector('#results-summary'),
  results: document.querySelector('#results-container'),
  detail: document.querySelector('#detail-panel'),
  sort: document.querySelector('#sort-select'),
  candidateActions: document.querySelector('#candidate-actions'),
  selectPageCandidates: document.querySelector('#select-page-candidates'),
  confirmSelectedButton: document.querySelector('#confirm-selected-button'),
  confirmSelectedLabel: document.querySelector('#confirm-selected-label'),
  deleteSelectedButton: document.querySelector('#delete-selected-button'),
  deleteSelectedLabel: document.querySelector('#delete-selected-label'),
  toast: document.querySelector('#toast'),
  walletEditor: document.querySelector('#wallet-editor'),
  walletEditorForm: document.querySelector('#wallet-editor-form'),
  walletEditorClose: document.querySelector('#wallet-editor-close'),
  walletEditorExclude: document.querySelector('#wallet-editor-exclude'),
  walletEditorTitle: document.querySelector('#wallet-editor-title'),
  walletEditorAddress: document.querySelector('#wallet-editor-address'),
  walletEditorAlias: document.querySelector('#wallet-editor-alias'),
  walletEditorTags: document.querySelector('#wallet-editor-tags'),
  walletEditorStatus: document.querySelector('#wallet-editor-status'),
  walletEditorMonitorTier: document.querySelector('#wallet-editor-monitor-tier'),
  walletEditorClassification: document.querySelector('#wallet-editor-classification'),
  walletMonitorRules: document.querySelector('#wallet-monitor-rules'),
  walletEditorNote: document.querySelector('#wallet-editor-note'),
  researchBoard: document.querySelector('#research-board'),
  monitorPage: document.querySelector('#monitor-page'),
  monitorSettingsForm: document.querySelector('#monitor-settings-form'),
  monitorWindowDescription: document.querySelector('#monitor-window-description'),
  monitorThreshold: document.querySelector('#monitor-threshold'),
  monitorThresholdLabel: document.querySelector('#monitor-threshold-label'),
  monitorWindowSeconds: document.querySelector('#monitor-window-seconds'),
  monitorEnabled: document.querySelector('#monitor-enabled'),
  monitorSaveButton: document.querySelector('#monitor-save-button'),
  monitorSoundSettingsForm: document.querySelector('#monitor-sound-settings-form'),
  monitorSoundSelect: document.querySelector('#monitor-sound-select'),
  monitorVolume: document.querySelector('#monitor-volume'),
  monitorVolumeOutput: document.querySelector('#monitor-volume-output'),
  monitorSoundSaveButton: document.querySelector('#monitor-sound-save-button'),
  monitorSoundButton: document.querySelector('#monitor-sound-button'),
  monitorMuteButton: document.querySelector('#monitor-mute-button'),
  monitorSoundStatus: document.querySelector('#monitor-sound-status'),
  monitorConnectionBadge: document.querySelector('#monitor-connection-badge'),
  monitorConnectionText: document.querySelector('#monitor-connection-text'),
  monitorHealthStatus: document.querySelector('#monitor-health-status'),
  monitorHealthDetail: document.querySelector('#monitor-health-detail'),
  monitorWalletCount: document.querySelector('#monitor-wallet-count'),
  monitorLatestBlock: document.querySelector('#monitor-latest-block'),
  monitorLastBlockTime: document.querySelector('#monitor-last-block-time'),
  monitorBlockLag: document.querySelector('#monitor-block-lag'),
  monitorTransportLabel: document.querySelector('#monitor-transport-label'),
  monitorClusterTitle: document.querySelector('#monitor-cluster-title'),
  monitorClusterSummary: document.querySelector('#monitor-cluster-summary'),
  monitorWindowChipLabel: document.querySelector('#monitor-window-chip-label'),
  monitorClusterList: document.querySelector('#monitor-cluster-list'),
  monitorFeedSummary: document.querySelector('#monitor-feed-summary'),
  monitorEventFeed: document.querySelector('#monitor-event-feed'),
  monitorRefreshButton: document.querySelector('#monitor-refresh-button'),
  monitorBarkForm: document.querySelector('#monitor-bark-form'),
  monitorBarkSettingsForm: document.querySelector('#monitor-bark-settings-form'),
  monitorBarkSoundSelect: document.querySelector('#monitor-bark-sound-select'),
  monitorBarkVolume: document.querySelector('#monitor-bark-volume'),
  monitorBarkVolumeOutput: document.querySelector('#monitor-bark-volume-output'),
  monitorBarkSettingsSaveButton: document.querySelector('#monitor-bark-settings-save-button'),
  monitorBarkEndpoint: document.querySelector('#monitor-bark-endpoint'),
  monitorBarkLabel: document.querySelector('#monitor-bark-label'),
  monitorBarkAddButton: document.querySelector('#monitor-bark-add-button'),
  monitorBarkCount: document.querySelector('#monitor-bark-count'),
  monitorBarkList: document.querySelector('#monitor-bark-list')
};

const state = {
  activeTab: 'candidates',
  strategy: 'smart',
  multiple: 10,
  data: null,
  visibleWallets: [],
  selectedAddress: '',
  selectedWinnerAddress: '',
  selectedCandidates: new Set(),
  rescanningWinnerAddresses: new Set(),
  detailCache: new Map(),
  requestSequence: 0,
  detailSequence: 0,
  pollTimer: null,
  toastTimer: null,
  librarySearchTimer: null,
  monitorPollTimer: null,
  monitorTickTimer: null,
  monitorEventSource: null,
  monitorStreamSnapshotReceived: false,
  monitorPollBusy: false,
  monitorSequence: 0,
  monitorStarted: false,
  monitorTransport: 'idle',
  monitorConnected: false,
  monitorEnabled: true,
  monitorThreshold: 3,
  monitorWindowSeconds: 60,
  monitorHealth: {},
  monitorEvents: [],
  monitorServerClusters: [],
  monitorEventKeys: new Set(),
  monitorLastEventId: '',
  monitorAlertedTokens: new Set(),
  monitorSoundEnabled: false,
  monitorAudioContext: null,
  monitorSound: 'alarm',
  monitorVolume: 70,
  monitorBarkSound: 'alarm',
  monitorBarkVolume: 5,
  monitorBarkTargets: [],
  monitorBarkBusy: new Set(),
  detailView: 'placeholder',
  detailAddress: '',
  loading: false
};

const numberFormatter = new Intl.NumberFormat('zh-CN', { maximumFractionDigits: 2 });
const compactNumberFormatter = new Intl.NumberFormat('en-US', {
  notation: 'compact',
  maximumFractionDigits: 2
});

class ApiError extends Error {
  constructor(message, status, payload = null) {
    super(message);
    this.name = 'ApiError';
    this.status = status;
    this.payload = payload;
  }
}

function escapeHtml(value) {
  return String(value ?? '').replace(/[&<>"']/g, (character) => ({
    '&': '&amp;',
    '<': '&lt;',
    '>': '&gt;',
    '"': '&quot;',
    "'": '&#39;'
  })[character]);
}

function safeHttpUrl(value) {
  if (!value) return '';
  try {
    const url = new URL(String(value));
    return url.protocol === 'http:' || url.protocol === 'https:' ? url.href : '';
  } catch {
    return '';
  }
}

function finiteNumber(...values) {
  for (const value of values) {
    if (value === null || value === undefined || value === '') continue;
    const number = Number(value);
    if (Number.isFinite(number)) return number;
  }
  return null;
}

function firstValue(source, keys, fallback = null) {
  if (!source || typeof source !== 'object') return fallback;
  for (const key of keys) {
    const value = source[key];
    if (value !== null && value !== undefined && value !== '') return value;
  }
  return fallback;
}

function normalizeAddress(value) {
  const address = String(value || '').trim();
  return ADDRESS_PATTERN.test(address) ? address.toLowerCase() : '';
}

function shortAddress(value) {
  const address = String(value || '');
  if (address.length < 14) return address || '--';
  return `${address.slice(0, 6)}...${address.slice(-4)}`;
}

function normalizeMonitorRules(source) {
  const record = source && typeof source === 'object' && !Array.isArray(source) ? source : {};
  return Object.fromEntries(MONITOR_EVENT_TYPES.map((eventType) => {
    const candidate = record[eventType] && typeof record[eventType] === 'object' ? record[eventType] : {};
    const sound = candidate.sound === true;
    const bark = candidate.bark === true;
    const defaultEnabled = eventType === 'buy';
    const enabled = (typeof candidate.enabled === 'boolean' ? candidate.enabled : defaultEnabled) || sound || bark;
    return [eventType, { enabled, sound, bark }];
  }));
}

function renderWalletMonitorRules(rules) {
  const normalized = normalizeMonitorRules(rules);
  for (const eventType of MONITOR_EVENT_TYPES) {
    const row = elements.walletMonitorRules.querySelector(`[data-monitor-rule="${eventType}"]`);
    if (!row) continue;
    for (const field of ['enabled', 'sound', 'bark']) {
      const checkbox = row.querySelector(`[data-rule-field="${field}"]`);
      if (checkbox) checkbox.checked = normalized[eventType][field];
    }
  }
}

function readWalletMonitorRules() {
  const rules = {};
  for (const eventType of MONITOR_EVENT_TYPES) {
    const row = elements.walletMonitorRules.querySelector(`[data-monitor-rule="${eventType}"]`);
    const sound = row?.querySelector('[data-rule-field="sound"]')?.checked === true;
    const bark = row?.querySelector('[data-rule-field="bark"]')?.checked === true;
    const enabled = row?.querySelector('[data-rule-field="enabled"]')?.checked === true || sound || bark;
    rules[eventType] = { enabled, sound, bark };
  }
  renderWalletMonitorRules(rules);
  return rules;
}

function enforceWalletMonitorRuleDependency(event) {
  const checkbox = event.target.closest('input[type="checkbox"][data-rule-field]');
  const row = checkbox?.closest('[data-monitor-rule]');
  if (!checkbox || !row) return;
  const enabled = row.querySelector('[data-rule-field="enabled"]');
  const sound = row.querySelector('[data-rule-field="sound"]');
  const bark = row.querySelector('[data-rule-field="bark"]');
  if ((sound.checked || bark.checked) && !enabled.checked) enabled.checked = true;
}

function formatNumber(value, fallback = '--') {
  const number = finiteNumber(value);
  return number === null ? fallback : numberFormatter.format(number);
}

function formatInteger(value, fallback = '--') {
  const number = finiteNumber(value);
  return number === null ? fallback : Math.round(number).toLocaleString('en-US');
}

function formatCompact(value, { currency = false } = {}) {
  const number = finiteNumber(value);
  if (number === null) return '--';
  const sign = number < 0 ? '-' : '';
  const formatted = compactNumberFormatter.format(Math.abs(number));
  return currency ? `${sign}$${formatted}` : `${sign}${formatted}`;
}

function formatMoney(value, currency = 'USD') {
  const number = finiteNumber(value);
  if (number === null) return '--';
  if (String(currency).toUpperCase() === 'USD') return formatCompact(number, { currency: true });
  const absolute = Math.abs(number);
  const formatted = number !== 0 && absolute < 0.000001
    ? number.toExponential(4)
    : number.toLocaleString('en-US', {
        maximumFractionDigits: absolute < 0.01 ? 12 : absolute < 1 ? 8 : 4,
        maximumSignificantDigits: 8
      });
  return `${formatted} ${String(currency || '').toUpperCase()}`.trim();
}

function formatSignedMoney(value) {
  const number = finiteNumber(value);
  if (number === null) return '--';
  if (number > 0) return `+${formatMoney(number)}`;
  return formatMoney(number);
}

function profitTone(value) {
  const number = finiteNumber(value);
  if (number === null || number === 0) return 'neutral';
  return number > 0 ? 'positive' : 'negative';
}

function formatMultiple(value) {
  const number = finiteNumber(value);
  if (number === null) return '--';
  if (Math.abs(number) >= 1000) return `${compactNumberFormatter.format(number)}x`;
  return `${number.toLocaleString('en-US', { maximumFractionDigits: number >= 10 ? 1 : 2 })}x`;
}

function formatPercent(value) {
  const number = finiteNumber(value);
  if (number === null) return '--';
  const percent = Math.abs(number) <= 1 ? number * 100 : number;
  return `${percent.toLocaleString('zh-CN', { maximumFractionDigits: 1 })}%`;
}

function formatDateTime(value, fallback = '--') {
  if (value === null || value === undefined || value === '') return fallback;
  const numeric = Number(value);
  const date = Number.isFinite(numeric)
    ? new Date(numeric < 10_000_000_000 ? numeric * 1000 : numeric)
    : new Date(String(value));
  if (Number.isNaN(date.getTime())) return fallback;
  return date.toLocaleString('zh-CN', {
    month: '2-digit',
    day: '2-digit',
    hour: '2-digit',
    minute: '2-digit',
    hour12: false
  });
}

function formatRelativeEntry(value) {
  const number = finiteNumber(value);
  if (number === null) return '--';
  const normalized = Math.abs(number) <= 1 ? number * 100 : number;
  return `行情前 ${Math.max(0, normalized).toLocaleString('zh-CN', { maximumFractionDigits: 1 })}% 入场`;
}

function tokenInitials(symbol) {
  return String(symbol || '?').trim().slice(0, 2).toUpperCase() || '?';
}

function renderTokenLogo(token, size = 'normal') {
  const symbol = firstValue(token, ['symbol', 'ticker'], '?');
  const url = safeHttpUrl(firstValue(token, ['logo', 'logoUrl', 'image', 'imageUrl']));
  return `
    <span class="token-logo ${escapeHtml(size)}">
      ${url ? `<img src="${escapeHtml(url)}" alt="" loading="lazy" referrerpolicy="no-referrer" />` : ''}
      <span class="token-fallback"${url ? ' hidden' : ''}>${escapeHtml(tokenInitials(symbol))}</span>
    </span>
  `;
}

function refreshIcons(root = document) {
  if (window.lucide?.createIcons) window.lucide.createIcons({ root });
}

function getCollection(payload, keys, depth = 0) {
  if (Array.isArray(payload)) return payload;
  if (!payload || typeof payload !== 'object' || depth > 3) return null;
  for (const key of keys) {
    if (Array.isArray(payload[key])) return payload[key];
  }
  for (const wrapper of ['data', 'result', 'payload', 'response']) {
    const nested = getCollection(payload[wrapper], keys, depth + 1);
    if (nested) return nested;
  }
  return null;
}

function getObject(payload, keys, depth = 0) {
  if (!payload || typeof payload !== 'object' || Array.isArray(payload) || depth > 3) return null;
  for (const key of keys) {
    if (payload[key] && typeof payload[key] === 'object' && !Array.isArray(payload[key])) return payload[key];
  }
  for (const wrapper of ['data', 'result', 'payload', 'response']) {
    const nested = getObject(payload[wrapper], keys, depth + 1);
    if (nested) return nested;
  }
  return null;
}

function unwrapRecord(payload) {
  let current = payload;
  for (let depth = 0; depth < 3; depth += 1) {
    if (!current || typeof current !== 'object' || Array.isArray(current)) break;
    const nested = current.data || current.result || current.payload;
    if (!nested || typeof nested !== 'object' || Array.isArray(nested)) break;
    current = nested;
  }
  return current && typeof current === 'object' ? current : {};
}

async function fetchJson(path, options = {}) {
  const { acceptStatuses = [], ...requestOptions } = options;
  const response = await fetch(path, {
    ...requestOptions,
    headers: {
      accept: 'application/json',
      ...(requestOptions.body ? { 'content-type': 'application/json' } : {}),
      ...(requestOptions.headers || {})
    }
  });
  const text = await response.text();
  let payload = null;
  if (text) {
    try {
      payload = JSON.parse(text);
    } catch {
      payload = { message: text };
    }
  }
  if (!response.ok && !acceptStatuses.includes(response.status)) {
    const message = firstValue(payload, ['message', 'error'], `请求失败（HTTP ${response.status}）`);
    throw new ApiError(String(message), response.status, payload);
  }
  return payload ?? {};
}

function clampMonitorThreshold(value, fallback = 3) {
  const number = finiteNumber(value);
  if (number === null) return fallback;
  return Math.min(1000, Math.max(1, Math.floor(number)));
}

function clampMonitorWindowSeconds(value, fallback = 60) {
  const number = finiteNumber(value);
  if (number === null) return fallback;
  return Math.min(3600, Math.max(5, Math.floor(number)));
}

function formatMonitorWindowDuration(value = state.monitorWindowSeconds) {
  const seconds = clampMonitorWindowSeconds(value);
  if (seconds % 60 === 0) return `${formatInteger(seconds / 60)} 分钟`;
  return `${formatInteger(seconds)} 秒`;
}

function readStoredMonitorThreshold() {
  try {
    return clampMonitorThreshold(window.localStorage.getItem(MONITOR_THRESHOLD_STORAGE_KEY), 3);
  } catch {
    return 3;
  }
}

function storeMonitorThreshold(value) {
  try {
    window.localStorage.setItem(MONITOR_THRESHOLD_STORAGE_KEY, String(clampMonitorThreshold(value)));
  } catch {
    // The backend remains the source of truth when local storage is unavailable.
  }
}

function monitorTimestampMs(value) {
  if (value === null || value === undefined || value === '') return null;
  const numeric = Number(value);
  const timestamp = Number.isFinite(numeric)
    ? (numeric < 10_000_000_000 ? numeric * 1000 : numeric)
    : new Date(String(value)).getTime();
  return Number.isFinite(timestamp) ? timestamp : null;
}

function formatMonitorAge(value) {
  const timestamp = monitorTimestampMs(value);
  if (timestamp === null) return '刚刚检测';
  const seconds = Math.max(0, Math.floor((Date.now() - timestamp) / 1000));
  if (seconds < 5) return '刚刚';
  if (seconds < 60) return `${seconds} 秒前`;
  const minutes = Math.floor(seconds / 60);
  if (minutes < 60) return `${minutes} 分钟前`;
  return formatDateTime(timestamp);
}

function normalizeTransactionHash(value) {
  const hash = String(value || '').trim();
  return HASH_PATTERN.test(hash) ? hash.toLowerCase() : '';
}

function normalizeMonitorEvent(raw) {
  const source = raw && typeof raw === 'object' ? raw : {};
  const id = firstValue(source, ['id', 'eventId', 'event_id', 'sequence'], '');
  const candidateType = String(firstValue(source, ['eventType', 'event_type', 'type'], 'buy')).toLowerCase();
  const eventType = MONITOR_EVENT_TYPES.includes(candidateType) ? candidateType : 'buy';
  return {
    ...source,
    id: String(id ?? ''),
    eventType,
    assetType: String(firstValue(source, ['assetType', 'asset_type'], 'token') || 'token').toLowerCase(),
    walletAddress: normalizeAddress(firstValue(source, ['walletAddress', 'wallet_address', 'wallet', 'address'])),
    walletAlias: String(firstValue(source, ['walletAlias', 'wallet_alias', 'alias', 'walletName'], '') || ''),
    tokenAddress: normalizeAddress(firstValue(source, ['tokenAddress', 'token_address', 'token', 'contractAddress'])),
    tokenSymbol: String(firstValue(source, ['tokenSymbol', 'token_symbol', 'symbol', 'ticker'], 'TOKEN') || 'TOKEN'),
    tokenName: String(firstValue(source, ['tokenName', 'token_name', 'name'], '') || ''),
    recipient: normalizeAddress(firstValue(source, [
      'recipient',
      'recipientAddress',
      'recipient_address',
      'counterpartyAddress',
      'counterparty_address',
      'to'
    ])),
    platform: String(firstValue(source, ['platform', 'protocol', 'dex', 'source'], '') || ''),
    soundAlert: source.soundAlert === true || source.sound_alert === true,
    amount: firstValue(source, ['amount', 'tokenAmount', 'token_amount', 'amountIn', 'amount_in', 'spendAmount', 'value'], null),
    amountUsd: finiteNumber(source.amountUsd, source.amount_usd, source.spendUsd, source.valueUsd),
    amountSymbol: String(firstValue(source, ['amountSymbol', 'amount_symbol', 'spendSymbol', 'currency'], source.tokenAmount ? firstValue(source, ['tokenSymbol', 'token_symbol'], '') : '') || ''),
    txHash: normalizeTransactionHash(firstValue(source, ['txHash', 'tx_hash', 'transactionHash', 'hash'])),
    blockNumber: finiteNumber(source.blockNumber, source.block_number, source.block),
    blockTimestamp: firstValue(source, ['blockTimestamp', 'block_timestamp', 'timestamp'], null),
    detectedAt: firstValue(source, ['detectedAt', 'detected_at', 'createdAt', 'created_at'], null)
  };
}

function monitorEventTimestamp(event) {
  return monitorTimestampMs(event?.blockTimestamp)
    ?? monitorTimestampMs(event?.detectedAt)
    ?? 0;
}

function monitorEventKey(event) {
  if (event.id) return `id:${event.id}`;
  return [event.eventType, event.txHash, event.walletAddress, event.tokenAddress, event.recipient, monitorEventTimestamp(event), event.blockNumber]
    .map((value) => String(value || ''))
    .join(':');
}

function monitorTokenKey(source) {
  const address = normalizeAddress(firstValue(source, ['tokenAddress', 'token_address', 'address']));
  if (address) return address;
  return String(firstValue(source, ['tokenSymbol', 'token_symbol', 'symbol'], 'unknown')).trim().toLowerCase();
}

function advanceMonitorCursor(events) {
  const ids = events.map((event) => event.id).filter(Boolean);
  if (!ids.length) return;
  const numericIds = ids.map(Number);
  if (numericIds.every(Number.isFinite)) {
    const previous = Number(state.monitorLastEventId);
    state.monitorLastEventId = String(Math.max(Number.isFinite(previous) ? previous : 0, ...numericIds));
    return;
  }
  state.monitorLastEventId = ids[0];
}

function mergeMonitorEvents(rawEvents) {
  const added = [];
  for (const rawEvent of Array.isArray(rawEvents) ? rawEvents : []) {
    const event = normalizeMonitorEvent(rawEvent);
    if (!event.walletAddress) continue;
    const key = monitorEventKey(event);
    if (state.monitorEventKeys.has(key)) continue;
    state.monitorEventKeys.add(key);
    state.monitorEvents.push(event);
    added.push(event);
  }
  state.monitorEvents.sort((left, right) => monitorEventTimestamp(right) - monitorEventTimestamp(left));
  state.monitorEvents = state.monitorEvents.slice(0, 200);
  state.monitorEventKeys = new Set(state.monitorEvents.map(monitorEventKey));
  advanceMonitorCursor(added.length ? added : state.monitorEvents);
  return added;
}

function computedMonitorClusters(now = Date.now()) {
  const windowMs = Math.max(1, state.monitorWindowSeconds) * 1000;
  const groups = new Map();
  for (const event of state.monitorEvents) {
    if (event.eventType !== 'buy') continue;
    const timestamp = monitorEventTimestamp(event);
    if (!timestamp || timestamp < now - windowMs || timestamp > now + 30_000) continue;
    const key = monitorTokenKey(event);
    if (!groups.has(key)) {
      groups.set(key, {
        key,
        tokenAddress: event.tokenAddress,
        tokenSymbol: event.tokenSymbol,
        tokenName: event.tokenName,
        debotTokenUrl: safeHttpUrl(event.debotTokenUrl),
        wallets: new Map(),
        events: [],
        latestAt: timestamp
      });
    }
    const cluster = groups.get(key);
    cluster.events.push(event);
    cluster.latestAt = Math.max(cluster.latestAt, timestamp);
    if (!cluster.wallets.has(event.walletAddress)) cluster.wallets.set(event.walletAddress, event.walletAlias || shortAddress(event.walletAddress));
  }
  return [...groups.values()]
    .map((cluster) => ({ ...cluster, walletCount: cluster.wallets.size }))
    .sort((left, right) => right.walletCount - left.walletCount || right.latestAt - left.latestAt);
}

function normalizeServerMonitorCluster(raw) {
  const source = raw && typeof raw === 'object' ? raw : {};
  const walletValues = firstValue(source, ['wallets', 'walletAddresses', 'addresses'], []);
  const wallets = new Map();
  for (const value of Array.isArray(walletValues) ? walletValues : []) {
    if (value && typeof value === 'object') {
      const address = normalizeAddress(firstValue(value, ['address', 'walletAddress', 'wallet']));
      if (address) wallets.set(address, String(firstValue(value, ['alias', 'walletAlias', 'name'], shortAddress(address))));
    } else {
      const address = normalizeAddress(value);
      if (address) wallets.set(address, shortAddress(address));
    }
  }
  const events = (getCollection(source, ['events', 'buys', 'items']) || []).map(normalizeMonitorEvent);
  for (const event of events) {
    if (event.walletAddress && !wallets.has(event.walletAddress)) wallets.set(event.walletAddress, event.walletAlias || shortAddress(event.walletAddress));
  }
  return {
    key: monitorTokenKey(source),
    tokenAddress: normalizeAddress(firstValue(source, ['tokenAddress', 'token_address', 'address'])),
    tokenSymbol: String(firstValue(source, ['tokenSymbol', 'token_symbol', 'symbol'], 'TOKEN')),
    tokenName: String(firstValue(source, ['tokenName', 'token_name', 'name'], '')),
    debotTokenUrl: safeHttpUrl(firstValue(source, ['debotTokenUrl', 'debot_token_url'])),
    wallets,
    events,
    walletCount: Math.max(wallets.size, finiteNumber(source.walletCount, source.wallet_count, source.count) ?? 0),
    latestAt: monitorTimestampMs(firstValue(source, ['latestAt', 'latest_at', 'lastSeenAt', 'last_seen_at', 'lastBuyAt', 'updatedAt'])) ?? 0
  };
}

function currentMonitorClusters() {
  const computed = computedMonitorClusters();
  const byKey = new Map(computed.map((cluster) => [cluster.key, cluster]));
  const cutoff = Date.now() - Math.max(1, state.monitorWindowSeconds) * 1000;
  for (const source of state.monitorServerClusters) {
    const cluster = normalizeServerMonitorCluster(source);
    if (cluster.latestAt && cluster.latestAt < cutoff) continue;
    const existing = byKey.get(cluster.key);
    if (!existing || cluster.walletCount > existing.walletCount) byKey.set(cluster.key, cluster);
  }
  return [...byKey.values()]
    .filter((cluster) => cluster.walletCount > 0)
    .sort((left, right) => right.walletCount - left.walletCount || right.latestAt - left.latestAt);
}

function formatMonitorAmount(event) {
  if (event.eventType === 'token_create') return event.platform === 'noxa' ? 'Noxa 发币' : '直接部署';
  if (event.amountUsd !== null) return formatMoney(event.amountUsd);
  const amount = finiteNumber(event.amount);
  if (amount !== null) {
    const absolute = Math.abs(amount);
    const formatted = amount.toLocaleString('en-US', {
      maximumFractionDigits: absolute < 1 ? 8 : 4,
      maximumSignificantDigits: 8
    });
    return `${formatted}${event.amountSymbol ? ` ${event.amountSymbol}` : ''}`;
  }
  const raw = String(event.amount ?? '').trim();
  return raw || '金额待解析';
}

function monitorPlatformLabel(value) {
  if (value === 'noxa') return 'Noxa';
  if (value === 'direct') return '直接部署';
  return String(value || '');
}

function monitorHealthValues() {
  const health = state.monitorHealth || {};
  const latestBlock = finiteNumber(
    health.latestBlock,
    health.latest_block,
    health.processedBlock,
    health.processed_block,
    health.lastProcessedBlock,
    health.blockNumber
  );
  const chainHead = finiteNumber(health.chainHead, health.chain_head, health.headBlock, health.head_block);
  const explicitLag = finiteNumber(health.lag, health.blockLag, health.block_lag, health.lagBlocks);
  return {
    status: String(firstValue(health, ['status', 'state'], state.monitorEnabled ? 'running' : 'disabled')).toLowerCase(),
    walletCount: finiteNumber(
      health.monitoredWalletCount,
      health.monitored_wallet_count,
      health.confirmedWalletCount,
      health.confirmed_wallet_count,
      health.monitoredWallets,
      health.monitored_wallets,
      health.walletCount,
      health.addressCount
    ),
    latestBlock,
    lag: explicitLag ?? (chainHead !== null && latestBlock !== null ? Math.max(0, chainHead - latestBlock) : null),
    lastBlockAt: firstValue(health, ['lastBlockAt', 'last_block_at', 'updatedAt', 'updated_at', 'lastPollAt'], null),
    error: String(firstValue(health, ['error', 'lastError', 'message'], '') || '')
  };
}

function renderMonitorSoundStatus() {
  const enabled = state.monitorSoundEnabled;
  elements.monitorSoundStatus.dataset.enabled = String(enabled);
  elements.monitorSoundStatus.innerHTML = enabled
    ? '<i data-lucide="volume-2" aria-hidden="true"></i><span>已开启</span>'
    : '<i data-lucide="volume-x" aria-hidden="true"></i><span>未开启</span>';
  elements.monitorSoundButton.querySelector('span').textContent = enabled ? '试听' : '开启 / 试听';
  elements.monitorMuteButton.hidden = !enabled;
  refreshIcons(elements.monitorSoundStatus);
}

function clampMonitorVolume(value, fallback = 70) {
  const number = finiteNumber(value);
  if (number === null) return fallback;
  return Math.min(100, Math.max(0, Math.round(number)));
}

function normalizeMonitorSound(value) {
  const sound = String(value || '');
  return MONITOR_SOUNDS.has(sound) ? sound : 'alarm';
}

function clampBarkVolume(value, fallback = 5) {
  const number = finiteNumber(value);
  if (number === null) return fallback;
  return Math.min(10, Math.max(0, Math.round(number)));
}

function normalizeBarkTarget(raw) {
  const source = raw && typeof raw === 'object' ? raw : {};
  return {
    id: Number(source.id),
    label: String(source.label || 'Bark'),
    endpointMasked: String(source.endpointMasked || ''),
    enabled: source.enabled !== false,
    lastSuccessAt: source.lastSuccessAt ?? null,
    lastErrorAt: source.lastErrorAt ?? null,
    lastError: String(source.lastError || '')
  };
}

function applyBarkTargets(payload) {
  const record = unwrapRecord(payload || {});
  if (!Array.isArray(record.barkTargets)) return;
  state.monitorBarkTargets = record.barkTargets
    .map(normalizeBarkTarget)
    .filter((target) => Number.isSafeInteger(target.id) && target.id > 0);
}

function renderMonitorBarkTargets() {
  const targets = state.monitorBarkTargets;
  elements.monitorBarkCount.textContent = `${targets.length} 个 API`;
  if (!targets.length) {
    elements.monitorBarkList.innerHTML = `
      <div class="monitor-bark-empty">
        <i data-lucide="smartphone" aria-hidden="true"></i>
        <span>还没有 Bark API</span>
      </div>
    `;
    refreshIcons(elements.monitorBarkList);
    return;
  }
  elements.monitorBarkList.innerHTML = targets.map((target) => {
    const busy = state.monitorBarkBusy.has(target.id);
    const status = target.lastError
      ? `<span class="monitor-bark-delivery is-error" title="${escapeHtml(target.lastError)}"><i data-lucide="circle-alert" aria-hidden="true"></i>${escapeHtml(formatDateTime(target.lastErrorAt, '推送失败'))}</span>`
      : target.lastSuccessAt
        ? `<span class="monitor-bark-delivery"><i data-lucide="circle-check" aria-hidden="true"></i>${escapeHtml(formatDateTime(target.lastSuccessAt))}</span>`
        : '<span class="monitor-bark-delivery is-idle">尚未测试</span>';
    return `
      <article class="monitor-bark-item${target.enabled ? '' : ' is-paused'}" data-bark-id="${target.id}">
        <span class="monitor-bark-state" aria-hidden="true"></span>
        <div class="monitor-bark-copy">
          <div><strong>${escapeHtml(target.label)}</strong>${target.enabled ? '' : '<span class="monitor-bark-paused-chip">已暂停</span>'}</div>
          <code>${escapeHtml(target.endpointMasked)}</code>
        </div>
        ${status}
        <div class="monitor-bark-actions">
          <button class="inline-icon-button" type="button" data-bark-action="test" title="发送测试推送" aria-label="测试 ${escapeHtml(target.label)}"${busy ? ' disabled' : ''}><i data-lucide="send" aria-hidden="true"></i></button>
          <button class="inline-icon-button" type="button" data-bark-action="toggle" title="${target.enabled ? '暂停推送' : '恢复推送'}" aria-label="${target.enabled ? '暂停' : '恢复'} ${escapeHtml(target.label)}"${busy ? ' disabled' : ''}><i data-lucide="${target.enabled ? 'pause' : 'play'}" aria-hidden="true"></i></button>
          <button class="inline-icon-button is-danger" type="button" data-bark-action="delete" title="删除 API" aria-label="删除 ${escapeHtml(target.label)}"${busy ? ' disabled' : ''}><i data-lucide="trash-2" aria-hidden="true"></i></button>
        </div>
      </article>
    `;
  }).join('');
  refreshIcons(elements.monitorBarkList);
}

function monitorConnectionState() {
  const health = monitorHealthValues();
  if (!state.monitorEnabled) return { state: 'disabled', label: '监控已暂停' };
  if (health.error && !state.monitorConnected) return { state: 'error', label: '连接异常' };
  if (!state.monitorConnected) return { state: 'loading', label: '正在连接' };
  if (health.walletCount === 0) return { state: 'warning', label: '等待确认地址' };
  if (health.lag !== null && health.lag > 10) return { state: 'warning', label: '同步追赶中' };
  return { state: 'ready', label: '实时在线' };
}

function renderMonitorHealth() {
  const health = monitorHealthValues();
  const connection = monitorConnectionState();
  const waitingForWallets = state.monitorEnabled && health.walletCount === 0;
  elements.monitorConnectionBadge.dataset.state = connection.state;
  elements.monitorConnectionText.textContent = connection.label;
  elements.monitorHealthStatus.textContent = state.monitorEnabled
    ? health.error ? '需要检查' : waitingForWallets ? '等待地址' : '运行中'
    : '已暂停';
  elements.monitorHealthDetail.textContent = health.error || (state.monitorEnabled
    ? waitingForWallets ? '确认地址入库后自动开始' : '按钱包规则记录链上事件'
    : '保存设置可重新开启');
  elements.monitorWalletCount.textContent = formatInteger(health.walletCount);
  elements.monitorLatestBlock.textContent = health.latestBlock === null ? '--' : `#${formatInteger(health.latestBlock)}`;
  elements.monitorLastBlockTime.textContent = health.lastBlockAt ? `更新于 ${formatMonitorAge(health.lastBlockAt)}` : '等待新区块';
  elements.monitorBlockLag.textContent = health.lag === null ? '--' : `${formatInteger(health.lag)} 块`;
  elements.monitorTransportLabel.textContent = state.monitorTransport === 'sse'
    ? 'SSE 实时推送'
    : state.monitorTransport === 'polling'
      ? '每 2 秒轮询'
      : '正在建立连接';
}

function renderMonitorClusters() {
  const clusters = currentMonitorClusters();
  const threshold = state.monitorThreshold;
  const windowLabel = formatMonitorWindowDuration();
  elements.monitorClusterSummary.textContent = `滚动 ${windowLabel} · ${clusters.length} 个代币 · ${threshold} 个地址触发提醒`;
  if (!clusters.length) {
    elements.monitorClusterList.innerHTML = `
      <div class="monitor-empty-state">
        <i data-lucide="activity" aria-hidden="true"></i>
        <strong>暂时没有同币聚合买入</strong>
        <span>有已确认地址买入后会立即出现。</span>
      </div>
    `;
    refreshIcons(elements.monitorClusterList);
    return;
  }
  elements.monitorClusterList.innerHTML = clusters.map((cluster) => {
    const alerted = cluster.walletCount >= threshold;
    const tokenAddress = normalizeAddress(cluster.tokenAddress);
    const symbol = String(cluster.tokenSymbol || 'TOKEN');
    const tokenUrl = safeHttpUrl(cluster.debotTokenUrl) || (tokenAddress ? `${DEBOT_TOKEN_ROOT}${tokenAddress}` : '');
    const wallets = [...(cluster.wallets instanceof Map ? cluster.wallets : new Map()).entries()];
    const walletCopy = wallets.slice(0, 3).map(([, alias]) => alias).join('、');
    const extraWallets = Math.max(0, cluster.walletCount - Math.min(wallets.length, 3));
    return `
      <article class="monitor-cluster-item${alerted ? ' is-alert' : ''}" data-token="${escapeHtml(cluster.key)}">
        <div class="monitor-token-mark" aria-hidden="true">${escapeHtml(tokenInitials(symbol))}</div>
        <div class="monitor-cluster-copy">
          <div class="monitor-cluster-title">
            ${tokenUrl ? `<a href="${escapeHtml(tokenUrl)}" target="_blank" rel="noopener noreferrer">${escapeHtml(symbol)}<i data-lucide="external-link" aria-hidden="true"></i></a>` : `<strong>${escapeHtml(symbol)}</strong>`}
            ${alerted ? '<span class="monitor-alert-chip"><i data-lucide="bell-ring" aria-hidden="true"></i>已触发</span>' : ''}
          </div>
          <p>${escapeHtml(walletCopy || `${cluster.walletCount} 个已确认地址`)}${extraWallets ? ` 等 ${formatInteger(cluster.walletCount)} 个地址` : ''}</p>
          <span>${escapeHtml(formatMonitorAge(cluster.latestAt))}有新买入</span>
        </div>
        <div class="monitor-cluster-count">
          <strong>${formatInteger(cluster.walletCount)}</strong>
          <span>/ ${formatInteger(threshold)} 地址</span>
        </div>
      </article>
    `;
  }).join('');
  refreshIcons(elements.monitorClusterList);
}

function renderMonitorWindowLabels() {
  const windowLabel = formatMonitorWindowDuration();
  elements.monitorWindowDescription.textContent = `已确认地址 · 金额不限 · ${windowLabel}滚动窗口`;
  elements.monitorThresholdLabel.textContent = `${windowLabel}同币提醒人数`;
  elements.monitorClusterTitle.textContent = `${windowLabel}同币聚合`;
  elements.monitorWindowChipLabel.textContent = windowLabel;
}

function renderMonitorEvents() {
  const events = state.monitorEvents;
  elements.monitorFeedSummary.textContent = `${events.length} 条记录 · 按检测时间倒序 · 金额不限`;
  if (!events.length) {
    elements.monitorEventFeed.innerHTML = `
      <div class="monitor-empty-state">
        <i data-lucide="radio-tower" aria-hidden="true"></i>
        <strong>等待钱包动态</strong>
        <span>符合钱包规则的新事件会显示在这里。</span>
      </div>
    `;
    refreshIcons(elements.monitorEventFeed);
    return;
  }
  elements.monitorEventFeed.innerHTML = events.map((event) => {
    const walletLabel = event.walletAlias || shortAddress(event.walletAddress);
    const eventType = MONITOR_EVENT_TYPES.includes(event.eventType) ? event.eventType : 'buy';
    const symbol = event.tokenSymbol || (event.assetType === 'native' ? 'ETH' : 'TOKEN');
    const eventTime = event.blockTimestamp || event.detectedAt;
    const walletUrl = safeHttpUrl(event.debotAddressUrl) || `${DEBOT_ADDRESS_ROOT}/${event.walletAddress}`;
    const tokenUrl = event.tokenAddress
      ? safeHttpUrl(event.debotTokenUrl) || `${DEBOT_TOKEN_ROOT}${event.tokenAddress}`
      : '';
    const transactionUrl = safeHttpUrl(event.explorerTxUrl) || (event.txHash ? `${EXPLORER_ROOT}/tx/${event.txHash}` : '');
    const recipientLabel = event.recipient ? shortAddress(event.recipient) : '';
    const target = tokenUrl
      ? `<a href="${escapeHtml(tokenUrl)}" target="_blank" rel="noopener noreferrer" title="在 DeBot 查看代币">${escapeHtml(symbol)}</a>`
      : event.recipient
        ? `<strong class="monitor-event-recipient-target" title="${escapeHtml(event.recipient)}">${escapeHtml(recipientLabel)}</strong>`
        : `<strong class="monitor-event-recipient-target">${escapeHtml(symbol)}</strong>`;
    return `
      <article class="monitor-event-item" data-event-id="${escapeHtml(event.id)}" data-event-type="${eventType}">
        <time datetime="${escapeHtml(String(eventTime || ''))}">${escapeHtml(formatMonitorAge(eventTime))}</time>
        <div class="monitor-event-main">
          <div class="monitor-event-title">
            <span class="monitor-event-type ${eventType}">${MONITOR_EVENT_LABELS[eventType]}</span>
            <a href="${escapeHtml(walletUrl)}" target="_blank" rel="noopener noreferrer" title="在 DeBot 查看地址">${escapeHtml(walletLabel)}</a>
            <i data-lucide="arrow-right" aria-hidden="true"></i>
            ${target}
          </div>
          <div class="monitor-event-meta">
            <span>${escapeHtml(event.tokenName || (event.tokenAddress ? shortAddress(event.tokenAddress) : symbol))}</span>
            ${event.recipient ? `<span title="${escapeHtml(event.recipient)}">接收方 ${escapeHtml(recipientLabel)}</span>` : ''}
            ${event.platform ? `<span title="${escapeHtml(event.platform)}">平台 ${escapeHtml(monitorPlatformLabel(event.platform))}</span>` : ''}
          </div>
        </div>
        <strong class="monitor-event-amount">${escapeHtml(formatMonitorAmount(event))}</strong>
        <div class="monitor-event-links">
          <a class="inline-icon-button" href="${escapeHtml(walletUrl)}" target="_blank" rel="noopener noreferrer" title="DeBot 地址" aria-label="在 DeBot 查看地址"><i data-lucide="wallet" aria-hidden="true"></i></a>
          ${tokenUrl ? `<a class="inline-icon-button" href="${escapeHtml(tokenUrl)}" target="_blank" rel="noopener noreferrer" title="DeBot 代币" aria-label="在 DeBot 查看代币"><i data-lucide="coins" aria-hidden="true"></i></a>` : ''}
          ${transactionUrl ? `<a class="inline-icon-button" href="${escapeHtml(transactionUrl)}" target="_blank" rel="noopener noreferrer" title="Blockscout 交易" aria-label="在 Blockscout 查看交易"><i data-lucide="square-arrow-out-up-right" aria-hidden="true"></i></a>` : ''}
        </div>
      </article>
    `;
  }).join('');
  refreshIcons(elements.monitorEventFeed);
}

function renderMonitorPage() {
  elements.monitorThreshold.value = String(state.monitorThreshold);
  elements.monitorWindowSeconds.value = String(state.monitorWindowSeconds);
  elements.monitorEnabled.checked = state.monitorEnabled;
  elements.monitorSoundSelect.value = state.monitorSound;
  elements.monitorVolume.value = String(state.monitorVolume);
  elements.monitorVolumeOutput.textContent = `${state.monitorVolume}%`;
  elements.monitorBarkSoundSelect.value = state.monitorBarkSound;
  elements.monitorBarkVolume.value = String(state.monitorBarkVolume);
  elements.monitorBarkVolumeOutput.textContent = `${state.monitorBarkVolume} / 10`;
  renderMonitorSoundStatus();
  renderMonitorBarkTargets();
  renderMonitorHealth();
  renderMonitorWindowLabels();
  renderMonitorClusters();
  renderMonitorEvents();
  refreshIcons(elements.monitorPage);
}

function applyMonitorPayload(payload, { initial = false } = {}) {
  const record = unwrapRecord(payload || {});
  const settings = record.settings && typeof record.settings === 'object' ? record.settings : {};
  const serverThreshold = finiteNumber(settings.threshold, record.threshold);
  if (serverThreshold !== null) {
    state.monitorThreshold = clampMonitorThreshold(serverThreshold);
    storeMonitorThreshold(state.monitorThreshold);
  }
  if (typeof settings.enabled === 'boolean') state.monitorEnabled = settings.enabled;
  else if (typeof record.enabled === 'boolean') state.monitorEnabled = record.enabled;
  state.monitorSound = normalizeMonitorSound(settings.sound ?? record.sound ?? state.monitorSound);
  state.monitorVolume = clampMonitorVolume(settings.volume ?? record.volume, state.monitorVolume);
  state.monitorBarkSound = String(settings.barkSound ?? record.barkSound ?? state.monitorBarkSound);
  state.monitorBarkVolume = clampBarkVolume(settings.barkVolume ?? record.barkVolume, state.monitorBarkVolume);
  applyBarkTargets(record);
  const serverWindowSeconds = finiteNumber(
    settings.windowSeconds,
    settings.window_seconds,
    record.windowSeconds,
    record.window_seconds
  );
  if (serverWindowSeconds !== null) {
    state.monitorWindowSeconds = clampMonitorWindowSeconds(serverWindowSeconds, state.monitorWindowSeconds);
  }
  if (record.health && typeof record.health === 'object') state.monitorHealth = { ...state.monitorHealth, status: record.status, ...record.health };
  else if (record.status) state.monitorHealth = { ...state.monitorHealth, status: record.status };
  if (record.ok === true && !record.health?.lastError) state.monitorHealth.lastError = '';
  if (Array.isArray(record.clusters)) state.monitorServerClusters = record.clusters;
  const alertedTokenAddresses = Array.isArray(record.alertedTokenAddresses)
    ? record.alertedTokenAddresses
    : Array.isArray(record.alerted_token_addresses)
      ? record.alerted_token_addresses
      : [];
  const events = getCollection(record, ['events', 'buys', 'items']) || [];
  const added = mergeMonitorEvents(events);
  state.monitorConnected = record.ok !== false;
  if (!initial) playMonitorEventSounds(added);
  synchronizeMonitorAlerts({ playNew: !initial && added.length > 0 });
  for (const tokenAddress of alertedTokenAddresses) {
    const normalized = normalizeAddress(tokenAddress);
    if (normalized) state.monitorAlertedTokens.add(normalized);
  }
  renderMonitorPage();
}

function synchronizeMonitorAlerts({ playNew = false } = {}) {
  for (const cluster of currentMonitorClusters()) {
    if (cluster.walletCount < state.monitorThreshold) continue;
    if (!state.monitorAlertedTokens.has(cluster.key)) {
      state.monitorAlertedTokens.add(cluster.key);
      if (playNew && state.monitorSoundEnabled) {
        void playMonitorAlertSound().catch((error) => {
          state.monitorSoundEnabled = false;
          renderMonitorSoundStatus();
          showToast(`声音提醒播放失败：${error.message}`, 'error');
        });
      }
    }
  }
}

function playMonitorEventSounds(events) {
  if (!state.monitorSoundEnabled) return;
  if (!events.some((event) => event.soundAlert === true)) return;
  void playMonitorAlertSound().catch((error) => {
    state.monitorSoundEnabled = false;
    renderMonitorSoundStatus();
    showToast(`声音提醒播放失败：${error.message}`, 'error');
  });
}

async function playMonitorAlertSound() {
  const AudioContextClass = window.AudioContext || window.webkitAudioContext;
  if (!AudioContextClass) throw new Error('当前浏览器不支持声音提醒');
  if (state.monitorVolume <= 0) return;
  const context = state.monitorAudioContext || new AudioContextClass();
  state.monitorAudioContext = context;
  if (context.state === 'suspended') await context.resume();
  if (state.monitorVolume === 0) return;
  const startAt = context.currentTime;
  const patterns = {
    alarm: [
      { offset: 0, duration: 0.16, frequency: 880, type: 'sine' },
      { offset: 0.18, duration: 0.16, frequency: 1175, type: 'sine' }
    ],
    bell: [
      { offset: 0, duration: 0.34, frequency: 659, type: 'triangle' },
      { offset: 0.12, duration: 0.42, frequency: 988, type: 'sine' }
    ],
    electronic: [
      { offset: 0, duration: 0.1, frequency: 523, type: 'square' },
      { offset: 0.11, duration: 0.1, frequency: 784, type: 'square' },
      { offset: 0.22, duration: 0.14, frequency: 1047, type: 'square' }
    ],
    glass: [
      { offset: 0, duration: 0.38, frequency: 1319, type: 'sine' },
      { offset: 0.08, duration: 0.46, frequency: 1760, type: 'sine' }
    ]
  };
  const peakGain = (state.monitorVolume / 100) * 0.2;
  patterns[state.monitorSound].forEach(({ offset, duration, frequency, type }) => {
    const oscillator = context.createOscillator();
    const gain = context.createGain();
    oscillator.type = type;
    oscillator.frequency.setValueAtTime(frequency, startAt + offset);
    gain.gain.setValueAtTime(0.0001, startAt + offset);
    gain.gain.exponentialRampToValueAtTime(peakGain, startAt + offset + 0.018);
    gain.gain.exponentialRampToValueAtTime(0.0001, startAt + offset + duration);
    oscillator.connect(gain);
    gain.connect(context.destination);
    oscillator.start(startAt + offset);
    oscillator.stop(startAt + offset + duration + 0.01);
  });
}

async function enableAndPreviewMonitorSound() {
  try {
    state.monitorSoundEnabled = true;
    await playMonitorAlertSound();
    renderMonitorSoundStatus();
    showToast('声音提醒已开启');
  } catch (error) {
    state.monitorSoundEnabled = false;
    renderMonitorSoundStatus();
    showToast(`无法播放提醒：${error.message}`, 'error');
  }
}

function muteMonitorSound() {
  state.monitorSoundEnabled = false;
  renderMonitorSoundStatus();
  showToast('声音提醒已关闭');
}

async function saveMonitorSoundSettings(event) {
  event.preventDefault();
  const sound = normalizeMonitorSound(elements.monitorSoundSelect.value);
  const volume = clampMonitorVolume(elements.monitorVolume.value, state.monitorVolume);
  state.monitorSound = sound;
  state.monitorVolume = volume;
  elements.monitorVolumeOutput.textContent = `${volume}%`;
  elements.monitorSoundSaveButton.disabled = true;
  try {
    const payload = await fetchJson(`${API_ROOT}/monitor/settings`, {
      method: 'PATCH',
      body: JSON.stringify({ sound, volume })
    });
    applyMonitorPayload(payload, { initial: true });
    showToast('声音设置已保存');
  } catch (error) {
    showToast(`声音设置保存失败：${error.message}`, 'error');
  } finally {
    elements.monitorSoundSaveButton.disabled = false;
  }
}

async function saveBarkSoundSettings(event) {
  event.preventDefault();
  const barkSound = elements.monitorBarkSoundSelect.value;
  const barkVolume = clampBarkVolume(elements.monitorBarkVolume.value, state.monitorBarkVolume);
  state.monitorBarkSound = barkSound;
  state.monitorBarkVolume = barkVolume;
  elements.monitorBarkVolumeOutput.textContent = `${barkVolume} / 10`;
  elements.monitorBarkSettingsSaveButton.disabled = true;
  try {
    const payload = await fetchJson(`${API_ROOT}/monitor/settings`, {
      method: 'PATCH',
      body: JSON.stringify({ barkSound, barkVolume })
    });
    applyMonitorPayload(payload, { initial: true });
    showToast('Bark 声音设置已保存');
  } catch (error) {
    showToast(`Bark 声音设置保存失败：${error.message}`, 'error');
  } finally {
    elements.monitorBarkSettingsSaveButton.disabled = false;
  }
}

async function createBarkTarget(event) {
  event.preventDefault();
  const endpoint = elements.monitorBarkEndpoint.value.trim();
  const label = elements.monitorBarkLabel.value.trim();
  if (!endpoint) return;
  elements.monitorBarkAddButton.disabled = true;
  try {
    const payload = await fetchJson(`${API_ROOT}/monitor/bark`, {
      method: 'POST',
      body: JSON.stringify({ endpoint, label, enabled: true })
    });
    applyBarkTargets(payload);
    elements.monitorBarkEndpoint.value = '';
    elements.monitorBarkLabel.value = '';
    renderMonitorBarkTargets();
    showToast('Bark API 已添加');
  } catch (error) {
    showToast(`Bark API 添加失败：${error.message}`, 'error');
  } finally {
    elements.monitorBarkAddButton.disabled = false;
  }
}

async function runBarkAction(button) {
  const item = button.closest('[data-bark-id]');
  const id = Number(item?.dataset.barkId);
  const action = button.dataset.barkAction;
  const target = state.monitorBarkTargets.find((entry) => entry.id === id);
  if (!target || state.monitorBarkBusy.has(id)) return;
  if (action === 'delete' && !window.confirm(`删除 Bark API“${target.label}”？`)) return;
  state.monitorBarkBusy.add(id);
  renderMonitorBarkTargets();
  try {
    let payload;
    if (action === 'test') {
      payload = await fetchJson(`${API_ROOT}/monitor/bark/${id}/test`, { method: 'POST' });
      showToast(`测试推送已发送至 ${target.label}`);
    } else if (action === 'toggle') {
      payload = await fetchJson(`${API_ROOT}/monitor/bark/${id}`, {
        method: 'PATCH',
        body: JSON.stringify({ enabled: !target.enabled })
      });
      showToast(target.enabled ? 'Bark API 已暂停' : 'Bark API 已恢复');
    } else if (action === 'delete') {
      payload = await fetchJson(`${API_ROOT}/monitor/bark/${id}`, { method: 'DELETE' });
      showToast('Bark API 已删除');
    } else {
      return;
    }
    applyBarkTargets(payload);
  } catch (error) {
    try {
      applyBarkTargets(await fetchJson(`${API_ROOT}/monitor/bark`));
    } catch {
      // Keep the current list when the follow-up status request is also unavailable.
    }
    showToast(`Bark 操作失败：${error.message}`, 'error');
  } finally {
    state.monitorBarkBusy.delete(id);
    renderMonitorBarkTargets();
  }
}

async function refreshBarkTargets() {
  try {
    applyBarkTargets(await fetchJson(`${API_ROOT}/monitor/bark`));
    renderMonitorBarkTargets();
  } catch {
    // The next monitor snapshot or manual refresh will retry status loading.
  }
}

function parseMonitorStreamPayload(event) {
  try {
    return JSON.parse(event.data || '{}');
  } catch {
    return {};
  }
}

function applyMonitorStreamEvent(event) {
  const payload = parseMonitorStreamPayload(event);
  const rawEvent = payload.event || payload.buy || payload.sell || payload.transfer || payload.token_create || payload;
  const added = mergeMonitorEvents([rawEvent]);
  state.monitorConnected = true;
  state.monitorTransport = 'sse';
  playMonitorEventSounds(added);
  synchronizeMonitorAlerts({ playNew: added.length > 0 });
  renderMonitorPage();
}

function stopMonitorTransport() {
  state.monitorSequence += 1;
  clearTimeout(state.monitorPollTimer);
  state.monitorPollTimer = null;
  clearInterval(state.monitorTickTimer);
  state.monitorTickTimer = null;
  if (state.monitorEventSource) state.monitorEventSource.close();
  state.monitorEventSource = null;
  state.monitorStreamSnapshotReceived = false;
  state.monitorPollBusy = false;
  state.monitorStarted = false;
  state.monitorTransport = 'idle';
  state.monitorConnected = false;
}

function scheduleMonitorPoll(delay = MONITOR_POLL_INTERVAL_MS) {
  clearTimeout(state.monitorPollTimer);
  if (!state.monitorStarted || state.activeTab !== 'monitor' || state.monitorTransport === 'sse') return;
  state.monitorPollTimer = setTimeout(() => void pollMonitorEvents(), delay);
}

async function fetchIncrementalMonitorEvents() {
  const after = encodeURIComponent(state.monitorLastEventId || '0');
  try {
    return await fetchJson(`${API_ROOT}/monitor/events?after=${after}&limit=200`);
  } catch (error) {
    if (![404, 405].includes(error.status)) throw error;
    return fetchJson(`${API_ROOT}/monitor?since=${after}&limit=200`);
  }
}

async function pollMonitorEvents() {
  if (!state.monitorStarted || state.activeTab !== 'monitor' || state.monitorPollBusy) return;
  state.monitorPollBusy = true;
  state.monitorTransport = 'polling';
  try {
    const payload = await fetchIncrementalMonitorEvents();
    if (!state.monitorStarted || state.activeTab !== 'monitor') return;
    applyMonitorPayload(payload);
  } catch (error) {
    state.monitorConnected = false;
    state.monitorHealth = { ...state.monitorHealth, lastError: error.message };
    renderMonitorHealth();
  } finally {
    state.monitorPollBusy = false;
    scheduleMonitorPoll();
  }
}

function connectMonitorStream() {
  if (!state.monitorStarted || state.activeTab !== 'monitor') return;
  if (!('EventSource' in window)) {
    state.monitorTransport = 'polling';
    scheduleMonitorPoll(0);
    return;
  }
  const source = new EventSource(`${API_ROOT}/monitor/stream`);
  state.monitorEventSource = source;
  source.addEventListener('open', () => {
    if (state.monitorEventSource !== source) return;
    state.monitorConnected = true;
    state.monitorTransport = 'sse';
    renderMonitorHealth();
  });
  source.addEventListener('snapshot', (event) => {
    const initial = !state.monitorStreamSnapshotReceived;
    state.monitorStreamSnapshotReceived = true;
    applyMonitorPayload(parseMonitorStreamPayload(event), { initial });
  });
  source.addEventListener('event', applyMonitorStreamEvent);
  source.addEventListener('buy', applyMonitorStreamEvent);
  source.addEventListener('sell', applyMonitorStreamEvent);
  source.addEventListener('transfer', applyMonitorStreamEvent);
  source.addEventListener('token_create', applyMonitorStreamEvent);
  source.addEventListener('health', (event) => {
    const payload = parseMonitorStreamPayload(event);
    state.monitorHealth = { ...state.monitorHealth, ...(payload.health || payload) };
    state.monitorConnected = true;
    renderMonitorHealth();
  });
  source.addEventListener('bark', () => void refreshBarkTargets());
  source.addEventListener('message', (event) => {
    const payload = parseMonitorStreamPayload(event);
    if (payload.event || payload.buy || payload.sell || payload.transfer || payload.token_create || payload.walletAddress) applyMonitorStreamEvent(event);
    else applyMonitorPayload(payload);
  });
  source.addEventListener('error', () => {
    if (state.monitorEventSource !== source || state.activeTab !== 'monitor') return;
    source.close();
    state.monitorEventSource = null;
    state.monitorConnected = false;
    state.monitorTransport = 'polling';
    renderMonitorHealth();
    scheduleMonitorPoll(0);
  });
}

async function startMonitorPage({ manual = false } = {}) {
  stopMonitorTransport();
  const sequence = state.monitorSequence;
  state.monitorStarted = true;
  state.monitorThreshold = readStoredMonitorThreshold();
  state.monitorTransport = 'loading';
  state.monitorHealth = manual ? {} : state.monitorHealth;
  renderMonitorPage();
  elements.monitorRefreshButton.disabled = true;
  try {
    const payload = await fetchJson(`${API_ROOT}/monitor?limit=200`);
    if (sequence !== state.monitorSequence || !state.monitorStarted || state.activeTab !== 'monitor') return;
    applyMonitorPayload(payload, { initial: true });
    if (manual) showToast('实时监控已刷新');
  } catch (error) {
    state.monitorConnected = false;
    state.monitorHealth = { ...state.monitorHealth, lastError: error.message };
    renderMonitorHealth();
    if (manual) showToast(`刷新失败：${error.message}`, 'error');
  } finally {
    elements.monitorRefreshButton.disabled = false;
  }
  if (sequence !== state.monitorSequence || !state.monitorStarted || state.activeTab !== 'monitor') return;
  state.monitorTickTimer = setInterval(() => {
    synchronizeMonitorAlerts();
    renderMonitorClusters();
  }, 1_000);
  connectMonitorStream();
}

async function saveMonitorSettings(event) {
  event.preventDefault();
  const threshold = clampMonitorThreshold(elements.monitorThreshold.value, state.monitorThreshold);
  const windowSeconds = clampMonitorWindowSeconds(elements.monitorWindowSeconds.value, state.monitorWindowSeconds);
  const enabled = elements.monitorEnabled.checked;
  state.monitorThreshold = threshold;
  state.monitorWindowSeconds = windowSeconds;
  state.monitorEnabled = enabled;
  elements.monitorThreshold.value = String(threshold);
  elements.monitorWindowSeconds.value = String(windowSeconds);
  storeMonitorThreshold(threshold);
  synchronizeMonitorAlerts();
  renderMonitorPage();
  elements.monitorSaveButton.disabled = true;
  try {
    const payload = await fetchJson(`${API_ROOT}/monitor/settings`, {
      method: 'PATCH',
      body: JSON.stringify({ threshold, windowSeconds, enabled })
    });
    applyMonitorPayload(payload, { initial: true });
    showToast(`提醒设置已保存：${formatMonitorWindowDuration(windowSeconds)}内 ${threshold} 个地址`);
  } catch (error) {
    showToast(`服务端保存失败，已保存在本机：${error.message}`, 'error');
  } finally {
    elements.monitorSaveButton.disabled = false;
  }
}

function currentMinimumEntryUsd() {
  return Math.min(1_000_000_000, Math.max(0, finiteNumber(elements.minEntryInput?.value) ?? 500));
}

function syncMinimumEntryDisplay({ normalizeInput = false } = {}) {
  const minimumEntryUsd = currentMinimumEntryUsd();
  if (normalizeInput) elements.minEntryInput.value = String(minimumEntryUsd);
  elements.minEntrySummary.textContent = `${formatMoney(minimumEntryUsd)} 起`;
  return minimumEntryUsd;
}

function readFilters() {
  const form = new FormData(elements.filterForm);
  return {
    windowDays: form.get('windowDays') || '30',
    minHits: Math.max(0, Math.floor(finiteNumber(form.get('minHits')) ?? 1)),
    minEntryUsd: currentMinimumEntryUsd(),
    strategy: state.strategy,
    multiple: state.multiple,
    minLiquidityUsd: Math.max(0, finiteNumber(form.get('minLiquidityUsd')) ?? 50_000),
    minWallets: Math.max(1, Math.floor(finiteNumber(form.get('minWallets')) ?? 100)),
    mode: form.get('mode') || 'both',
    confidence: form.get('confidence') || 'all',
    excludeNoise: form.get('excludeNoise') === 'on',
    search: elements.walletSearch.value.trim(),
    status: elements.walletStatus.value,
    monitorTier: elements.walletMonitorTier.value,
    tag: elements.walletTag.value.trim()
  };
}

function buildQuery(filters, classification = state.activeTab) {
  const params = new URLSearchParams({
    tab: ['winners', 'candidates', 'all_round'].includes(classification) ? 'all' : classification,
    window: String(filters.windowDays),
    minHits: String(filters.minHits),
    minEntryUsd: String(filters.minEntryUsd),
    strategy: filters.strategy,
    multiple: String(filters.multiple),
    minLiquidityUsd: String(filters.minLiquidityUsd),
    minWallets: String(filters.minWallets),
    minEffectiveWallets: String(filters.minWallets),
    mode: filters.mode,
    confidence: filters.confidence,
    exclude: filters.excludeNoise ? 'noise' : 'none'
  });
  if (filters.search) params.set('search', filters.search);
  if (filters.tag) params.set('tag', filters.tag);
  if (filters.status) params.set('status', filters.status);
  return params.toString();
}

function buildCurationQuery(filters) {
  const params = new URLSearchParams(buildQuery(filters, 'all_round'));
  params.set('tab', 'all');
  params.set('review', filters.status === 'excluded' ? 'excluded' : filters.status === 'all' ? 'all' : 'confirmed');
  if (filters.monitorTier && filters.monitorTier !== 'all') params.set('monitorTier', filters.monitorTier);
  return params.toString();
}

function buildPendingReviewQuery(filters) {
  const params = new URLSearchParams({
    tab: 'all',
    review: 'pending'
  });
  if (filters.search) params.set('search', filters.search);
  if (filters.tag) params.set('tag', filters.tag);
  return params.toString();
}

function mergeWalletCollections(...collections) {
  const merged = new Map();
  for (const collection of collections) {
    for (const wallet of Array.isArray(collection) ? collection : []) {
      const address = normalizeAddress(wallet?.address);
      if (!address) continue;
      merged.set(address, { ...(merged.get(address) || {}), ...wallet, address });
    }
  }
  return [...merged.values()];
}

function walletLibraryRecords(collection) {
  return (Array.isArray(collection) ? collection : []).filter((wallet) => {
    const reviewState = String(wallet?.reviewState || '').toLowerCase();
    return wallet?.curated === true || reviewState === 'confirmed' || reviewState === 'excluded';
  });
}

function latestReviewBatchTokenAddresses(jobs) {
  const scans = (Array.isArray(jobs) ? jobs : [])
    .filter((job) => String(firstValue(job, ['type', 'jobType'], '')).toLowerCase() === 'token_scan')
    .filter((job) => String(firstValue(job, ['status', 'state'], '')).toLowerCase() === 'complete')
    .map((job) => {
      const tokenAddress = normalizeAddress(firstValue(job, ['tokenAddress', 'address', 'token'], ''));
      const completedAtMs = Date.parse(firstValue(job, ['completedAt', 'finishedAt', 'updatedAt'], ''));
      const startedAtMs = Date.parse(firstValue(job, ['startedAt', 'createdAt'], ''));
      return {
        tokenAddress,
        completedAtMs,
        startedAtMs: Number.isFinite(startedAtMs) ? startedAtMs : completedAtMs
      };
    })
    .filter((scan) => ADDRESS_PATTERN.test(scan.tokenAddress) && Number.isFinite(scan.completedAtMs))
    .sort((left, right) => right.completedAtMs - left.completedAtMs);
  if (!scans.length) return [];

  const batch = [scans[0]];
  let batchStartedAtMs = scans[0].startedAtMs;
  for (const scan of scans.slice(1)) {
    if (batchStartedAtMs - scan.completedAtMs > REVIEW_SCAN_BATCH_GAP_MS) break;
    batch.push(scan);
    batchStartedAtMs = Math.min(batchStartedAtMs, scan.startedAtMs);
  }
  return [...new Set(batch.map((scan) => scan.tokenAddress))];
}

function latestReviewBatch(wallets, jobs, winners = [], minimumEntryUsd = 500) {
  const tokenAddresses = latestReviewBatchTokenAddresses(jobs);
  const tokenSet = new Set(tokenAddresses);
  const entryFloor = Math.min(1_000_000_000, Math.max(0, finiteNumber(minimumEntryUsd) ?? 500));
  const snapshots = new Map(
    (Array.isArray(winners) ? winners : [])
      .map((winner) => [
        normalizeAddress(winner?.address),
        String(firstValue(winner?.holderAnalysis || {}, ['snapshotAt'], ''))
      ])
      .filter(([address, snapshotAt]) => tokenSet.has(address) && snapshotAt)
  );
  const scopedWallets = [];
  for (const wallet of Array.isArray(wallets) ? wallets : []) {
    const batchPerformances = (Array.isArray(wallet?.performances) ? wallet.performances : [])
      .filter((performance) => {
        const tokenAddress = normalizeAddress(performance?.tokenAddress);
        if (!tokenSet.has(tokenAddress)) return false;
        const snapshotAt = snapshots.get(tokenAddress);
        if (snapshotAt && String(performance?.holderSnapshotAt || '') !== snapshotAt) return false;
        const entryCostUsd = finiteNumber(
          performance?.entryCostUsd,
          performance?.buyVolumeUsd,
          performance?.buy_volume_usd,
          performance?.buy_volume
        );
        return entryCostUsd !== null && entryCostUsd >= entryFloor;
      });
    if (!batchPerformances.length) continue;
    const batchHits = batchPerformances.filter((performance) => performance?.hit === true).length;
    scopedWallets.push({
      ...wallet,
      aggregateHits: walletHits(wallet),
      aggregateEntries: walletEntries(wallet),
      hits: batchHits,
      entries: batchPerformances.length,
      reviewBatchHits: batchHits,
      reviewBatchEntries: batchPerformances.length
    });
  }
  return { wallets: scopedWallets, tokenAddresses };
}

async function loadCurationWallets(filters) {
  try {
    const payload = await fetchJson(`${API_ROOT}/wallets?${buildCurationQuery(filters)}`);
    return getCollection(payload, ['wallets', 'items', 'addresses']) || [];
  } catch {
    return [];
  }
}

async function loadPendingWallets(filters) {
  try {
    const payload = await fetchJson(`${API_ROOT}/wallets?${buildPendingReviewQuery(filters)}`);
    return getCollection(payload, ['wallets', 'items', 'addresses']) || [];
  } catch (error) {
    if (![404, 405].includes(error.status)) throw error;
    return [];
  }
}

function debotImportAlias(wallet) {
  return String(wallet?.alias || wallet?.suggestedAlias || wallet?.suggested_alias || '')
    .replace(/[\r\n\t]+/g, ' ')
    .replace(/\s+/g, ' ')
    .trim()
    .slice(0, 120);
}

function debotImportText(wallets) {
  const rows = new Map();
  for (const wallet of Array.isArray(wallets) ? wallets : []) {
    if (!walletIsConfirmed(wallet)) continue;
    const address = normalizeAddress(wallet.address);
    if (!address) continue;
    const alias = debotImportAlias(wallet);
    rows.set(address, alias ? `${address} ${alias}` : address);
  }
  return [...rows.values()].sort((left, right) => left.localeCompare(right)).join('\n');
}

function downloadDebotImport(text) {
  const blob = new Blob([text], { type: 'text/plain;charset=utf-8' });
  const url = URL.createObjectURL(blob);
  const link = document.createElement('a');
  link.href = url;
  link.download = 'robinhood-debot-wallets.txt';
  document.body.append(link);
  link.click();
  link.remove();
  setTimeout(() => URL.revokeObjectURL(url), 1_000);
}

async function exportConfirmedWalletsToDebot() {
  const managerLink = document.createElement('a');
  managerLink.href = DEBOT_WALLET_MANAGER_URL;
  managerLink.target = '_blank';
  managerLink.rel = 'noopener noreferrer';
  document.body.append(managerLink);
  managerLink.click();
  managerLink.remove();
  elements.debotExportButton.disabled = true;
  try {
    const params = new URLSearchParams({
      tab: 'all',
      strategy: 'smart',
      multiple: '10',
      review: 'confirmed',
      status: 'all'
    });
    const payload = await fetchJson(`${API_ROOT}/wallets?${params}`);
    const wallets = getCollection(payload, ['wallets', 'items', 'addresses']) || [];
    const text = debotImportText(wallets);
    if (!text) throw new Error('地址库还没有已确认钱包');
    const copied = await copyText(text);
    if (!copied) downloadDebotImport(text);
    const count = text.split('\n').length;
    showToast(copied
      ? `已复制 ${count} 个地址，粘贴到 DeBot 的“导入钱包”`
      : `已导出 ${count} 个地址，请在 DeBot 导入钱包`);
  } catch (error) {
    showToast(`导出失败：${error.message}`, 'error');
  } finally {
    elements.debotExportButton.disabled = false;
  }
}

async function loadApiData(filters) {
  const query = buildQuery(filters);
  try {
    const dashboard = await fetchJson(`${API_ROOT}/dashboard?${query}`, { acceptStatuses: [503] });
    const record = unwrapRecord(dashboard);
    const curationWalletsPromise = loadCurationWallets(filters);
    const pendingWalletsPromise = loadPendingWallets(filters);
    let walletPayload = null;
    try {
      walletPayload = await fetchJson(`${API_ROOT}/wallets?${query}`);
    } catch (error) {
      if (![404, 405].includes(error.status)) throw error;
    }
    const curationWallets = await curationWalletsPromise;
    const pendingWallets = await pendingWalletsPromise;
    const jobs = getCollection(record, ['jobs', 'scans', 'items']) || [];
    const winners = getCollection(record, ['winners', 'tokens', 'items']) || [];
    const reviewBatch = latestReviewBatch(pendingWallets, jobs, winners, filters.minEntryUsd);
    return {
      overview: record,
      wallets: mergeWalletCollections(
        walletLibraryRecords(getCollection(record, ['wallets', 'items', 'addresses']) || []),
        walletLibraryRecords(getCollection(walletPayload, ['wallets', 'items', 'addresses']) || []),
        walletLibraryRecords(curationWallets),
        reviewBatch.wallets
      ),
      winners,
      jobs,
      reviewBatchTokenAddresses: reviewBatch.tokenAddresses,
      warnings: Array.isArray(record.warnings) ? record.warnings : []
    };
  } catch (error) {
    if (![404, 405].includes(error.status)) throw error;
  }

  const paths = [
    `${API_ROOT}/overview?${query}`,
    `${API_ROOT}/wallets?${query}`,
    `${API_ROOT}/winners?${query}`,
    `${API_ROOT}/jobs`
  ];
  const settled = await Promise.allSettled(paths.map((path) => fetchJson(path)));
  const values = settled.map((result) => result.status === 'fulfilled' ? result.value : null);
  const splitEndpointAvailable = settled.some((result) => result.status === 'fulfilled');
  if (!splitEndpointAvailable) throw settled.find((result) => result.status === 'rejected')?.reason || new Error('Robinhood API 不可用');

  const [overviewPayload, walletsPayload, winnersPayload, jobsPayload] = values;
  const overview = unwrapRecord(overviewPayload || {});
  const [curationWallets, pendingWallets] = await Promise.all([
    loadCurationWallets(filters),
    loadPendingWallets(filters)
  ]);
  const jobs = getCollection(jobsPayload, ['jobs', 'scans', 'items'])
    || getCollection(overview, ['jobs', 'scans'])
    || [];
  const winners = getCollection(winnersPayload, ['winners', 'tokens', 'items'])
    || getCollection(overview, ['winners', 'tokens'])
    || [];
  const reviewBatch = latestReviewBatch(pendingWallets, jobs, winners, filters.minEntryUsd);
  const warnings = settled
    .filter((result) => result.status === 'rejected' && ![404, 405].includes(result.reason?.status))
    .map((result) => result.reason?.message)
    .filter(Boolean);

  return {
    overview,
    wallets: mergeWalletCollections(
      walletLibraryRecords(getCollection(overview, ['wallets', 'addresses']) || []),
      walletLibraryRecords(getCollection(walletsPayload, ['wallets', 'items', 'addresses']) || []),
      walletLibraryRecords(curationWallets),
      reviewBatch.wallets
    ),
    winners,
    jobs,
    reviewBatchTokenAddresses: reviewBatch.tokenAddresses,
    warnings: [
      ...(Array.isArray(overview.warnings) ? overview.warnings : []),
      ...warnings
    ]
  };
}

function activeJobs(jobs) {
  return (Array.isArray(jobs) ? jobs : []).filter((job) => {
    const status = String(firstValue(job, ['status', 'state'], '')).toLowerCase();
    return ACTIVE_JOB_STATES.has(status);
  });
}

function statusFromData(data) {
  const overview = data?.overview || {};
  const sourceStatus = String(firstValue(overview, ['status', 'state'], '')).toLowerCase();
  if (activeJobs(data?.jobs).length || ['scanning', 'refreshing', 'running', 'fetching', 'analyzing'].includes(sourceStatus)) return 'scanning';
  if (overview.stale === true || sourceStatus === 'stale') return 'stale';
  if (overview.partial === true || sourceStatus === 'partial') return 'partial';
  if (sourceStatus === 'error' || overview.ok === false && !data?.wallets?.length && !data?.winners?.length) return 'error';
  if (!data?.wallets?.length && !data?.winners?.length) return 'empty';
  return 'ready';
}

function jobProgress(jobs) {
  const jobsInProgress = activeJobs(jobs);
  for (const job of jobsInProgress) {
    const progress = job.progress || job.result || {};
    const completed = finiteNumber(progress.completed, progress.scanned, progress.current);
    const total = finiteNumber(progress.total, progress.target);
    if (completed !== null && total) return `${Math.min(100, Math.round(completed / total * 100))}%`;
    const percent = finiteNumber(progress.percent, job.percent);
    if (percent !== null) return `${Math.round(Math.abs(percent) <= 1 ? percent * 100 : percent)}%`;
  }
  return jobsInProgress.length ? `${jobsInProgress.length} 项进行中` : '';
}

function holderPipelineCounts(source) {
  const nested = getObject(source, [
    'holderAnalysis', 'holderPipeline', 'holderStats', 'candidateProgress', 'candidateCounts',
    'holderCounts', 'scan', 'progress', 'result'
  ]) || {};
  const from = (keys) => finiteNumber(
    ...keys.map((key) => nested[key]),
    ...keys.map((key) => source?.[key])
  );
  return {
    fetched: from([
      'fetched', 'fetchedCount', 'fetchedHolders', 'candidatesFetched', 'fetchedCandidates',
      'holderCandidatesFetched', 'holders', 'total'
    ]),
    analyzed: from([
      'analyzed', 'analyzedCount', 'analyzedWallets', 'holderCandidates', 'candidatesAnalyzed',
      'analyzedCandidates', 'holderCandidatesAnalyzed', 'completed'
    ]),
    eligible: from(['eligible', 'eligibleCount', 'eligibleWallets', 'eligibleCandidates', 'qualifiedCandidates']),
    filtered: from([
      'filteredBelowEntry', 'belowEntryCount', 'belowMinEntryCount', 'filteredUnder500',
      'ignoredBelowEntry', 'ineligibleEntryCount'
    ])
  };
}

function hasPipelineCounts(counts) {
  return Object.values(counts).some((value) => value !== null);
}

function matchingWinnerJob(winner) {
  const address = normalizeAddress(winner?.address);
  if (!address) return null;
  return state.data?.jobs.find((job) => normalizeAddress(firstValue(job, [
    'tokenAddress', 'address', 'token'
  ])) === address) || null;
}

function winnerRescanActive(winner) {
  const address = normalizeAddress(winner?.address);
  if (!address) return false;
  if (state.rescanningWinnerAddresses.has(address)) return true;
  const status = String(firstValue(matchingWinnerJob(winner), ['status', 'state'], '')).toLowerCase();
  return ACTIVE_JOB_STATES.has(status);
}

function syncWinnerRescanButtons(winner) {
  const address = normalizeAddress(winner?.address);
  if (!address) return;
  const active = winnerRescanActive(winner);
  const title = active ? 'Holder 正在重新分析' : '重新分析 Holder';
  const label = active ? title : '重新分析这个 CA 的 Holder';
  for (const button of document.querySelectorAll('[data-rescan-winner]')) {
    if (normalizeAddress(button.dataset.rescanWinner) !== address) continue;
    button.disabled = active;
    button.classList.toggle('is-spinning', active);
    button.title = title;
    button.setAttribute('aria-label', label);
  }
}

function syncWinnerRescanButtonsByAddress(address) {
  const normalized = normalizeAddress(address);
  if (!normalized) return;
  const winner = state.data?.winners?.find((candidate) => normalizeAddress(candidate.address) === normalized);
  syncWinnerRescanButtons(winner || { address: normalized });
}

function winnerPipelineCounts(winner) {
  const snapshot = holderPipelineCounts(winner);
  const current = holderPipelineCounts(matchingWinnerJob(winner) || {});
  return Object.fromEntries(Object.keys(snapshot).map((key) => [key, current[key] ?? snapshot[key]]));
}

function winnerPipelineStage(winner) {
  return pipelineStage(matchingWinnerJob(winner) || {}) || pipelineStage(winner);
}

function aggregateHolderPipeline(data) {
  const direct = holderPipelineCounts(data?.overview || {});
  const sums = { fetched: null, analyzed: null, eligible: null, filtered: null };
  for (const winner of data?.winners || []) {
    const counts = winnerPipelineCounts(winner);
    for (const key of Object.keys(sums)) {
      if (counts[key] === null) continue;
      sums[key] = (sums[key] ?? 0) + counts[key];
    }
  }
  return Object.fromEntries(Object.keys(sums).map((key) => [key, direct[key] ?? sums[key]]));
}

function pipelineSummary(counts, { placeholders = false } = {}) {
  const value = (number) => placeholders || number !== null ? formatInteger(number) : '';
  const parts = [
    [value(counts.fetched), '已抓取'],
    [value(counts.analyzed), '已核算'],
    [value(counts.eligible), '可入库'],
    [value(counts.filtered), '低于门槛已过滤']
  ].filter(([number]) => number);
  return parts.map(([number, label]) => `${number} ${label}`).join(' · ');
}

function pipelineStage(source) {
  const nested = getObject(source, [
    'holderAnalysis', 'scan', 'holderPipeline', 'candidateProgress', 'progress', 'result'
  ]) || {};
  if (nested.complete === true) return 'complete';
  if (nested.complete === false && hasPipelineCounts(holderPipelineCounts(source))) return 'partial';
  return String(firstValue(nested, ['stage', 'status', 'state'], firstValue(source, [
    'holderStage', 'candidateStage', 'analysisStage', 'stage', 'status', 'state'
  ], ''))).toLowerCase();
}

function pipelineStageLabel(stage) {
  const value = String(stage || '').toLowerCase();
  if (/(analy|profit)/.test(value)) return '核算地址收益';
  if (/(fetch|holder|candidate)/.test(value)) return '抓取持仓候选';
  if (/(complete|ready|eligible)/.test(value)) return 'Holder 分析完成';
  if (/(partial|incomplete)/.test(value)) return '部分收益可用';
  if (/(fail|error)/.test(value)) return 'Holder 分析失败';
  if (/(queue|pending|running)/.test(value)) return '等待 Holder 分析';
  return '逐地址核算';
}

function activePipelineStage(data) {
  for (const source of [...activeJobs(data?.jobs), ...(data?.winners || [])]) {
    const stage = pipelineStage(source);
    if (stage) return stage;
  }
  return '';
}

function setSystemStatus(kind, title, message = '', progress = '') {
  elements.status.dataset.state = kind;
  elements.statusTitle.textContent = title;
  elements.statusMessage.textContent = message;
  elements.statusProgress.textContent = progress;
  elements.scanButton.classList.toggle('is-spinning', kind === 'scanning');
  elements.scanButton.disabled = state.loading || kind === 'scanning';
}

function renderStatus(data) {
  const status = statusFromData(data);
  const warning = (data.warnings || []).find(Boolean);
  const progress = jobProgress(data.jobs);
  const counts = aggregateHolderPipeline(data);
  const countMessage = hasPipelineCounts(counts) ? pipelineSummary(counts) : '';
  const stage = activePipelineStage(data);
  const scanningTitle = /(fetch|holder|candidate)/.test(stage) && !/(analy|profit)/.test(stage)
    ? '正在抓取持仓候选'
    : '正在核算候选地址收益';
  const minimumEntryUsd = readFilters().minEntryUsd;
  const messages = {
    ready: ['候选与地址库已就绪', warning || countMessage || '自动分析结果先进入待审核候选，确认后才进入地址库。'],
    scanning: [scanningTitle, warning || countMessage || '已缓存收益仍可查看，未完成地址暂不参与盈利排序。'],
    stale: ['正在显示缓存持仓', warning || countMessage || '持仓快照或收益数据可能不是最新。'],
    partial: ['Holder 数据部分可用', warning || countMessage || '未完成地址暂不参与盈利排序。'],
    error: ['Holder 分析暂不可用', warning || '无法读取持仓候选或收益数据，请稍后重试。'],
    empty: ['地址库暂为空', warning || `提交金狗 CA 后会抓取持仓候选，并过滤累计买入低于 ${formatMoney(minimumEntryUsd)} 的地址。`]
  };
  const [title, message] = messages[status];
  setSystemStatus(status, title, message, progress);
}

function renderHeader(data) {
  const overview = data.overview || {};
  elements.candidateCount.textContent = formatInteger(data.wallets.filter(walletIsCandidate).length);
  elements.walletCount.textContent = formatInteger(data.wallets.filter(walletIsConfirmed).length);
  elements.winnerCount.textContent = formatInteger(
    data.winners.filter((winner) => winner.manual === true).length
  );
  elements.updatedAt.textContent = formatDateTime(firstValue(overview, [
    'updatedAt', 'lastUpdatedAt', 'lastSuccessAt', 'indexedAt'
  ]));
  syncMinimumEntryDisplay();
}

function walletHits(wallet) {
  return finiteNumber(wallet.hits, wallet.winnerHits, wallet.qualifiedWinnerHits, wallet.hitCount) ?? 0;
}

function walletEntries(wallet) {
  return finiteNumber(
    wallet.entries,
    wallet.tokenEntries,
    wallet.sampleEntries,
    wallet.entryCount,
    wallet.eligibleEntries,
    wallet.eligible_entries
  ) ?? walletHits(wallet);
}

function walletSmartRecord(wallet) {
  for (const key of ['smartAnalysis', 'smartMetrics', 'scoring', 'analysis', 'metrics']) {
    if (wallet?.[key] && typeof wallet[key] === 'object' && !Array.isArray(wallet[key])) return wallet[key];
  }
  return {};
}

function walletSmartMetric(wallet, keys) {
  const smart = walletSmartRecord(wallet);
  return finiteNumber(firstValue(wallet, keys), firstValue(smart, keys));
}

function walletSmartScore(wallet) {
  return walletSmartMetric(wallet, ['smartScore', 'smart_score']);
}

function walletEligibleEntries(wallet) {
  return walletSmartMetric(wallet, ['eligibleEntries', 'eligible_entries', 'eligibleEntryCount']);
}

function walletWinningEntries(wallet) {
  const explicit = walletSmartMetric(wallet, ['winningEntries', 'winning_entries', 'winnerEntries']);
  return explicit ?? finiteNumber(wallet.winnerHits, wallet.hits, wallet.qualifiedWinnerHits, wallet.hitCount);
}

function walletAdjustedWinRate(wallet) {
  return walletSmartMetric(wallet, ['adjustedWinRate', 'adjusted_win_rate']);
}

function walletTotalTradeCount(wallet) {
  return walletSmartMetric(wallet, ['totalTradeCount', 'total_trade_count', 'tradeCount']);
}

function walletTradesPerEntry(wallet) {
  const explicit = walletSmartMetric(wallet, ['tradesPerEntry', 'trades_per_entry']);
  if (explicit !== null) return explicit;
  const trades = walletTotalTradeCount(wallet);
  const entries = walletEligibleEntries(wallet);
  return trades !== null && entries !== null && entries > 0 ? trades / entries : null;
}

function walletNormalizedProfitScore(wallet) {
  return walletSmartMetric(wallet, ['normalizedProfitScore', 'normalized_profit_score']);
}

function walletProfitToPeakMarketCapRatio(wallet) {
  return walletSmartMetric(wallet, [
    'profitToPeakMarketCapRatio',
    'profit_to_peak_market_cap_ratio'
  ]);
}

function formatRequiredNumber(value, options = {}) {
  const number = finiteNumber(value);
  if (number === null) return '待补全';
  return number.toLocaleString('zh-CN', {
    minimumFractionDigits: options.minimumFractionDigits ?? 0,
    maximumFractionDigits: options.maximumFractionDigits ?? 2
  });
}

function formatRatio(value) {
  const number = finiteNumber(value);
  if (number === null) return '待补全';
  return `${(number * 100).toLocaleString('zh-CN', { maximumFractionDigits: 2 })}%`;
}

const SMART_REASON_RULES = Object.freeze([
  { pattern: /10x|high[\s_-]*multiple|高倍/i, label: '10x 高倍' },
  { pattern: /heavy.*5x|5x.*heavy|large.*holding|holding.*5x|position.*5x|重仓/i, label: '重仓 5x' },
  { pattern: /realized.*5x|5x.*realized|large.*realized|cash.*5x|兑现/i, label: '大额兑现 5x' },
  { pattern: /repeat.*5x|5x.*repeat|multi.*token|recurr|多币|重复/i, label: '多币重复 5x' },
  { pattern: /low.*frequency|selective|few.*trade|低频/i, label: '低频高手' },
  { pattern: /cluster|related|linked|关联|集群/i, label: '关联集群' }
]);

function walletSmartReasonSource(wallet) {
  const smart = walletSmartRecord(wallet);
  const source = firstValue(wallet, ['smartReasons', 'smart_reasons'], firstValue(smart, [
    'smartReasons', 'smart_reasons', 'reasons'
  ], []));
  return Array.isArray(source) ? source : source ? [source] : [];
}

function walletSmartReasons(wallet) {
  const labels = [];
  for (const reason of walletSmartReasonSource(wallet)) {
    const candidate = reason && typeof reason === 'object'
      ? [reason.code, reason.reason, reason.label, reason.type].filter(Boolean).join(' ')
      : String(reason || '');
    const match = SMART_REASON_RULES.find(({ pattern }) => pattern.test(candidate));
    if (match && !labels.includes(match.label)) labels.push(match.label);
  }
  return labels;
}

function walletIsSmartEligible(wallet) {
  const smart = walletSmartRecord(wallet);
  const explicit = firstValue(wallet, ['smartEligible', 'smart_eligible'], firstValue(smart, [
    'smartEligible', 'smart_eligible', 'eligible'
  ], null));
  if (typeof explicit === 'boolean') return explicit;
  return walletSmartReasons(wallet).length > 0;
}

function walletHasSmartFields(wallet) {
  return walletSmartReasonSource(wallet).length > 0
    || [
      walletSmartScore(wallet),
      walletEligibleEntries(wallet),
      walletAdjustedWinRate(wallet),
      walletTotalTradeCount(wallet),
      walletNormalizedProfitScore(wallet),
      walletProfitToPeakMarketCapRatio(wallet)
    ].some((value) => value !== null);
}

function walletIsConfirmed(wallet) {
  return wallet?.curated === true && String(wallet.status || 'active').toLowerCase() !== 'excluded';
}

function isCandidateReviewTab(tab = state.activeTab) {
  return tab === 'candidates';
}

function isWalletSelectionTab(tab = state.activeTab) {
  return isCandidateReviewTab(tab) || tab === 'all_round';
}

function walletIsSelectable(wallet, tab = state.activeTab) {
  if (!wallet) return false;
  if (tab === 'all_round') {
    return walletIsConfirmed(wallet) && String(wallet.status || 'active').toLowerCase() !== 'excluded';
  }
  return isCandidateReviewTab(tab) && walletIsCandidate(wallet);
}

function walletIsCandidate(wallet) {
  if (!wallet || walletIsConfirmed(wallet) || String(wallet.status || 'active').toLowerCase() === 'excluded') return false;
  if (!walletIsSmartEligible(wallet)) return false;
  return walletCandidateEligible(wallet) || walletHasPerformance(wallet);
}

function renderSmartReasonBadges(wallet, limit = Number.POSITIVE_INFINITY) {
  const reasons = walletSmartReasons(wallet);
  if (!reasons.length) return '';
  return reasons.slice(0, limit).map((reason) => (
    `<span class="smart-reason-badge">${escapeHtml(reason)}</span>`
  )).join('');
}

function walletRealized(wallet) {
  return finiteNumber(wallet.maxRealizedMultiple, wallet.realizedMultiple, wallet.bestRealizedMultiple);
}

function walletUnrealized(wallet) {
  return finiteNumber(wallet.maxUnrealizedMultiple, wallet.unrealizedMultiple, wallet.bestUnrealizedMultiple);
}

function walletPeak(wallet) {
  return finiteNumber(wallet.maxPeakMultiple, wallet.peakPotentialMultiple, wallet.athPotentialMultiple);
}

function walletBestMultiple(wallet) {
  const values = [
    finiteNumber(wallet.bestMultiple, wallet.maxMultiple, wallet.profitMultiple, wallet.maxTotalMultiple, wallet.totalMultiple),
    walletRealized(wallet),
    walletUnrealized(wallet),
    walletPeak(wallet)
  ].filter((value) => value !== null);
  return values.length ? Math.max(...values) : null;
}

function walletProfitRecord(wallet) {
  return getObject(wallet, ['profitSummary', 'profitMetrics', 'profitAnalysis'])
    || (wallet?.profit && typeof wallet.profit === 'object' ? wallet.profit : {});
}

function walletRealizedProfit(wallet) {
  const profit = walletProfitRecord(wallet);
  return finiteNumber(
    wallet.realizedProfitUsd,
    wallet.totalRealizedProfitUsd,
    wallet.realized_profit,
    profit.realizedProfitUsd,
    profit.realized_profit,
    profit.realized
  );
}

function walletUnrealizedProfit(wallet) {
  const profit = walletProfitRecord(wallet);
  return finiteNumber(
    wallet.unrealizedProfitUsd,
    wallet.totalUnrealizedProfitUsd,
    wallet.unrealized_profit,
    profit.unrealizedProfitUsd,
    profit.unrealized_profit,
    profit.unrealized
  );
}

function walletTotalProfit(wallet) {
  const profit = walletProfitRecord(wallet);
  const explicit = finiteNumber(
    wallet.totalProfitUsd,
    wallet.profitUsd,
    typeof wallet.profit === 'number' ? wallet.profit : null,
    wallet.total_profit,
    profit.totalProfitUsd,
    profit.total_profit,
    profit.total
  );
  if (explicit !== null) return explicit;
  const realized = walletRealizedProfit(wallet);
  const unrealized = walletUnrealizedProfit(wallet);
  return realized !== null && unrealized !== null ? realized + unrealized : null;
}

function walletHolderRecord(wallet) {
  return getObject(wallet, ['holderSnapshot', 'holder', 'holding', 'positionSnapshot']) || {};
}

function walletHolderRank(wallet) {
  const holder = walletHolderRecord(wallet);
  const rank = finiteNumber(
    wallet.bestHolderRank,
    wallet.holderRank,
    wallet.topHolderRank,
    wallet.holder_rank,
    holder.rank,
    holder.holderRank,
    holder.holder_rank
  );
  return rank === null || rank < 1 ? null : Math.floor(rank);
}

function walletHoldingValue(wallet) {
  const holder = walletHolderRecord(wallet);
  return finiteNumber(
    wallet.totalHoldingValueUsd,
    wallet.holdingValueUsd,
    wallet.currentHoldingValueUsd,
    wallet.balanceUsd,
    wallet.balance,
    holder.valueUsd,
    holder.holdingValueUsd,
    holder.balanceUsd,
    holder.balance,
    wallet.unrealizedValueUsd,
    wallet.openPositionValueUsd
  );
}

function walletHoldingSharePercent(wallet) {
  const holder = walletHolderRecord(wallet);
  const explicit = finiteNumber(
    wallet.holdingSharePercent,
    wallet.bestHoldingSharePercent,
    wallet.holderSharePercent,
    wallet.positionPercent,
    wallet.holding_percent,
    holder.sharePercent,
    holder.holdingSharePercent
  );
  if (explicit !== null) return explicit;
  const ratio = finiteNumber(wallet.holdingShare, wallet.positionRate, holder.share, holder.positionRate);
  if (ratio !== null) return ratio * 100;
  const positions = Array.isArray(wallet.performances) ? wallet.performances : [];
  const bestRank = walletHolderRank(wallet);
  const bestPosition = positions.find((position) => finiteNumber(position?.holderRank) === bestRank) || positions[0];
  return finiteNumber(bestPosition?.holdingSharePercent);
}

function walletTopHolderCount(wallet) {
  return finiteNumber(wallet.topHolderCount, wallet.top100Count, wallet.topHolderHits);
}

function walletHolderSnapshotAt(wallet) {
  const holder = walletHolderRecord(wallet);
  const direct = firstValue(wallet, [
    'holderSnapshotAt', 'holdingSnapshotAt', 'positionUpdatedAt', 'snapshotAt'
  ], firstValue(holder, ['observedAt', 'updatedAt', 'snapshotAt']));
  if (direct) return direct;
  const positions = Array.isArray(wallet.performances) ? wallet.performances : [];
  return firstValue(positions.find((position) => position?.holderSnapshotAt), ['holderSnapshotAt']);
}

function walletCandidateEligible(wallet) {
  if (wallet.eligible === true || wallet.candidateEligible === true || wallet.holderEligible === true) return true;
  const status = String(firstValue(wallet, ['profitState', 'analysisStatus', 'candidateStatus', 'dataStatus'], '')).toLowerCase();
  return /eligible/.test(status) || (status === 'complete' && walletHolderRank(wallet) !== null);
}

function walletDataStatus(wallet) {
  const status = String(firstValue(wallet, ['profitState', 'analysisStatus', 'candidateStatus', 'dataStatus'], '')).toLowerCase();
  if (/(fail|error)/.test(status)) return { tone: 'failed', label: '核算失败' };
  if (/(below|filtered|ignored|ineligible)/.test(status)) {
    return { tone: 'below', label: `< ${formatMoney(readFilters().minEntryUsd)} 已过滤` };
  }
  if (/(partial|incomplete)/.test(status)) return { tone: 'partial', label: '数据不完整' };
  if (/(fetch|candidate|pending|queue|analyz|running)/.test(status)) return { tone: 'pending', label: '收益核算中' };
  if (/(complete|eligible|ready)/.test(status)) return { tone: 'qualified', label: '收益已核算' };
  if (!walletHasPerformance(wallet) && walletHoldingValue(wallet) === null) return { tone: 'unknown', label: '仅地址库' };
  if (walletTotalProfit(wallet) === null) return { tone: 'pending', label: '收益待核算' };
  return { tone: 'qualified', label: '收益已核算' };
}

function walletHasPerformance(wallet) {
  return walletEntries(wallet) > 0
    || walletHits(wallet) > 0
    || walletRealizedProfit(wallet) !== null
    || walletUnrealizedProfit(wallet) !== null
    || walletRealized(wallet) !== null
    || walletUnrealized(wallet) !== null
    || walletPeak(wallet) !== null
    || walletHasSmartFields(wallet);
}

function walletConfidence(wallet) {
  const raw = firstValue(wallet, ['confidence', 'attributionConfidence', 'confidenceScore'], wallet.attribution?.confidence);
  const numeric = finiteNumber(raw);
  if (numeric !== null) return { value: Math.abs(numeric) <= 1 ? numeric : numeric / 100, label: formatPercent(numeric) };
  const text = String(raw || '').toLowerCase();
  if (['high', 'verified', '高', '高置信'].includes(text)) return { value: 0.9, label: '高' };
  if (['medium', '中', '中等'].includes(text)) return { value: 0.6, label: '中' };
  if (['low', '低', '低置信'].includes(text)) return { value: 0.3, label: '低' };
  return { value: null, label: '待确认' };
}

function walletClassification(wallet) {
  return String(firstValue(wallet, ['classification', 'category', 'type'], '')).toLowerCase();
}

function walletMonitorTier(wallet) {
  const tier = String(firstValue(wallet, ['monitorTier', 'monitor_tier'], '')).toLowerCase();
  return Object.hasOwn(MONITOR_TIER_LABELS, tier) ? tier : '';
}

function exclusionReasons(wallet) {
  const candidates = [
    ...(Array.isArray(wallet.exclusionReasons) ? wallet.exclusionReasons : []),
    ...(Array.isArray(wallet.flags) ? wallet.flags : []),
    ...(Array.isArray(wallet.risks) ? wallet.risks : []),
    firstValue(wallet, ['role', 'walletType'], '')
  ].filter(Boolean).map(String);
  const combined = candidates.join(' ').toLowerCase();
  const noisePattern = /\b(dev|developer|router|pool|pair|bundler|sniper|wash|high.?frequency|spray)\b|开发者|路由|池子|捆绑|狙击|对敲|高频|撒网/;
  return wallet.excluded === true || wallet.isNoise === true || noisePattern.test(combined) ? candidates : [];
}

function matchesClassification(wallet, tab) {
  const classification = walletClassification(wallet);
  const classificationOverride = String(wallet.classificationOverride || '').toLowerCase();
  const hits = walletHits(wallet);
  if (tab === 'all_round') return wallet?.curated === true;
  if (tab === 'candidates') return walletIsCandidate(wallet);
  if (!walletIsCandidate(wallet)) return false;
  if (classificationOverride) return classificationOverride === tab;
  if (!walletHasPerformance(wallet)) return classification === tab;
  if (tab === 'single_hit') {
    return hits === 1 && Math.max(walletRealized(wallet) ?? 0, walletUnrealized(wallet) ?? 0) >= state.multiple;
  }
  if (hits < 2) return false;
  if (tab === 'realized') return (walletRealized(wallet) ?? 0) >= state.multiple;
  if (tab === 'unrealized') return (walletUnrealized(wallet) ?? 0) >= state.multiple;
  return false;
}

function filterWallets(wallets, filters) {
  return wallets.filter((wallet) => {
    if (!walletIsConfirmed(wallet) && !walletIsSmartEligible(wallet)) return false;
    const hits = walletHits(wallet);
    const entries = walletEntries(wallet);
    const confidence = walletConfidence(wallet).value;
    if (!matchesClassification(wallet, state.activeTab)) return false;
    const hasPerformance = walletHasPerformance(wallet);
    if (hasPerformance && state.activeTab === 'single_hit' && hits !== 1) return false;
    if (hasPerformance && isCandidateReviewTab() && hits < filters.minHits) return false;
    if (filters.mode === 'realized' && walletRealizedProfit(wallet) === null) return false;
    if (filters.mode === 'unrealized' && walletUnrealizedProfit(wallet) === null) return false;
    if (filters.confidence === 'high' && confidence !== null && confidence < 0.75) return false;
    if (filters.confidence === 'medium' && confidence !== null && confidence < 0.5) return false;
    if (filters.excludeNoise && exclusionReasons(wallet).length) return false;
    if (filters.status && filters.status !== 'all' && String(wallet.status || 'active') !== filters.status) return false;
    if (state.activeTab === 'all_round' && filters.monitorTier !== 'all' && walletMonitorTier(wallet) !== filters.monitorTier) return false;
    if (filters.tag && !(Array.isArray(wallet.tags) ? wallet.tags : []).some((tag) => String(tag).toLowerCase().includes(filters.tag.toLowerCase()))) return false;
    if (filters.search) {
      const haystack = [wallet.address, wallet.alias, wallet.note, wallet.classification, ...(wallet.tags || [])]
        .join(' ')
        .toLowerCase();
      if (!haystack.includes(filters.search.toLowerCase())) return false;
    }
    return true;
  });
}

function sortWallets(wallets) {
  const sort = elements.sort.value;
  const compareNullable = (left, right, getter, ascending = false) => {
    const leftValue = finiteNumber(getter(left));
    const rightValue = finiteNumber(getter(right));
    if (leftValue === null && rightValue === null) return 0;
    if (leftValue === null) return 1;
    if (rightValue === null) return -1;
    return ascending ? leftValue - rightValue : rightValue - leftValue;
  };
  return [...wallets].sort((left, right) => {
    let result = 0;
    if (sort === 'name') {
      const leftName = String(left.alias || '').trim();
      const rightName = String(right.alias || '').trim();
      if (!leftName && !rightName) result = 0;
      else if (!leftName) result = 1;
      else if (!rightName) result = -1;
      else result = leftName.localeCompare(rightName, 'zh-CN', { numeric: true, sensitivity: 'base' });
      return result || String(left.address || '').localeCompare(String(right.address || ''));
    }
    if (sort === 'smart_score') result = compareNullable(left, right, walletSmartScore);
    else if (sort === 'holding_value') result = compareNullable(left, right, walletHoldingValue);
    else if (sort === 'holder_rank') result = compareNullable(left, right, walletHolderRank, true);
    else if (sort === 'realized_profit') result = compareNullable(left, right, walletRealizedProfit);
    else if (sort === 'unrealized_profit') result = compareNullable(left, right, walletUnrealizedProfit);
    else if (sort === 'best_multiple') result = compareNullable(left, right, walletBestMultiple);
    else if (sort === 'hits') result = walletHits(right) - walletHits(left);
    else result = compareNullable(left, right, walletTotalProfit);
    return result
      || walletHits(right) - walletHits(left)
      || walletEntries(left) - walletEntries(right)
      || String(left.address || '').localeCompare(String(right.address || ''));
  });
}

function classificationBadge(wallet) {
  const computed = walletClassification(wallet);
  if (!computed && !walletHasPerformance(wallet)) {
    return '<span class="classification-badge unscored">待分析</span>';
  }
  const classification = computed || state.activeTab;
  const label = CLASSIFICATION_LABELS[classification] || classification || '未分类';
  return `<span class="classification-badge ${escapeHtml(classification)}">${escapeHtml(label)}</span>`;
}

function walletStatusBadge(wallet) {
  const status = String(wallet.status || 'active').toLowerCase();
  if (status === 'active') return '';
  const label = status === 'watch' ? '观察' : status === 'excluded' ? '已排除' : status;
  return `<span class="status-badge wallet-status-badge ${escapeHtml(status)}">${escapeHtml(label)}</span>`;
}

function monitorTierBadge(wallet) {
  const reviewState = String(firstValue(wallet, ['reviewState', 'review_state'], '')).toLowerCase();
  if (wallet?.curated !== true || reviewState === 'pending') return '';
  const tier = walletMonitorTier(wallet);
  if (!tier) return '';
  return `<span class="monitor-tier-badge ${escapeHtml(tier)}">${escapeHtml(MONITOR_TIER_LABELS[tier])}</span>`;
}

function walletTagBadges(wallet, limit = 2) {
  const tags = Array.isArray(wallet.tags) ? wallet.tags : [];
  return tags.slice(0, limit).map((tag) => `<span class="wallet-tag">${escapeHtml(tag)}</span>`).join('');
}

function formatHoldingShare(value) {
  const number = finiteNumber(value);
  return number === null ? '占比 --' : `${number.toLocaleString('zh-CN', { maximumFractionDigits: 2 })}%`;
}

function holderRankLabel(value) {
  const rank = finiteNumber(value);
  return rank === null ? 'Top --' : `Top #${formatInteger(rank)}`;
}

function holderRankBadge(wallet) {
  const rank = walletHolderRank(wallet);
  if (rank === null) return '';
  return `<span class="holder-rank-badge">${escapeHtml(holderRankLabel(rank))}</span>`;
}

function renderWalletTable(wallets) {
  const reviewMode = isCandidateReviewTab();
  const selectionMode = isWalletSelectionTab();
  if (!wallets.length) {
    return renderEmpty(
      reviewMode ? '没有待审核候选' : '已确认地址库为空',
      reviewMode ? '可调整智能条件或等待已提交金狗完成分析。' : '从待审核候选中确认地址后会显示在这里。'
    );
  }
  return `
    <table class="research-table wallet-table${reviewMode ? ' candidate-review-table' : ''}${selectionMode ? ' wallet-selection-table' : ''}">
      <thead>
        <tr>
          <th class="rank-column">${selectionMode ? '<span class="sr-only">选择</span>' : '#'}</th>
          <th>地址</th>
          <th>当前持仓</th>
          <th>已实现利润</th>
          <th>未实现利润</th>
          <th>总利润</th>
          <th>相对评分</th>
          <th>胜场 / 有效</th>
          <th>交易频率</th>
          <th>数据状态</th>
        </tr>
      </thead>
      <tbody>
        ${wallets.map((wallet, index) => {
          const address = normalizeAddress(wallet.address) || String(wallet.address || '');
          const selected = normalizeAddress(address) === state.selectedAddress;
          const confidence = walletConfidence(wallet);
          const alias = String(wallet.alias || '').trim();
          const hasPerformance = walletHasPerformance(wallet);
          const holderRank = walletHolderRank(wallet);
          const holdingValue = walletHoldingValue(wallet);
          const holdingShare = walletHoldingSharePercent(wallet);
          const realizedProfit = walletRealizedProfit(wallet);
          const unrealizedProfit = walletUnrealizedProfit(wallet);
          const totalProfit = walletTotalProfit(wallet);
          const bestMultiple = walletBestMultiple(wallet);
          const smartScore = walletSmartScore(wallet);
          const eligibleEntries = walletEligibleEntries(wallet);
          const winningEntries = walletWinningEntries(wallet);
          const adjustedWinRate = walletAdjustedWinRate(wallet);
          const totalTradeCount = walletTotalTradeCount(wallet);
          const tradesPerEntry = walletTradesPerEntry(wallet);
          const normalizedProfitScore = walletNormalizedProfitScore(wallet);
          const profitToPeakMarketCapRatio = walletProfitToPeakMarketCapRatio(wallet);
          const dataStatus = walletDataStatus(wallet);
          const snapshotAt = walletHolderSnapshotAt(wallet);
          const topHolderCount = walletTopHolderCount(wallet);
          const selectable = walletIsSelectable(wallet);
          const candidateChecked = selectable && state.selectedCandidates.has(normalizeAddress(address));
          return `
            <tr class="result-row${reviewMode ? ' candidate-row' : ''}${selected ? ' is-selected' : ''}${hasPerformance ? '' : ' is-annotation-only'}" data-address="${escapeHtml(address)}">
              <td class="rank-cell${selectionMode ? ' candidate-select-cell' : ''}" data-label="${selectionMode ? '选择' : '排名'}">${selectionMode ? (selectable ? `<input type="checkbox" data-candidate-select="${escapeHtml(address)}" aria-label="选择地址 ${escapeHtml(shortAddress(address))}"${candidateChecked ? ' checked' : ''} />` : '<span class="selection-unavailable" aria-hidden="true"></span>') : index + 1}</td>
              <td class="wallet-cell" data-label="地址">
                <button class="address-select" type="button" data-select-wallet="${escapeHtml(address)}">
                  <span class="wallet-identicon" aria-hidden="true">${escapeHtml(address.slice(2, 4).toUpperCase() || '??')}</span>
                  <span class="address-copy">
                    <strong class="${alias ? 'wallet-alias' : ''}">${escapeHtml(alias || shortAddress(address))}</strong>
                    ${alias ? `<span class="wallet-address-secondary">${escapeHtml(shortAddress(address))}</span>` : ''}
                    <span class="wallet-badges">
                      ${classificationBadge(wallet)}
                      ${holderRankBadge(wallet)}
                      ${monitorTierBadge(wallet)}
                      ${walletStatusBadge(wallet)}
                      ${walletTagBadges(wallet)}
                      ${renderSmartReasonBadges(wallet, 3)}
                    </span>
                  </span>
                </button>
                <button class="inline-icon-button" type="button" data-copy="${escapeHtml(address)}" title="复制地址" aria-label="复制地址">
                  <i data-lucide="copy" aria-hidden="true"></i>
                </button>
                <a class="inline-icon-button debot-link" href="${escapeHtml(`${DEBOT_ADDRESS_ROOT}/${address}`)}" target="_blank" rel="noopener noreferrer" title="在 DeBot 查看持仓" aria-label="在 DeBot 查看持仓"><i data-lucide="external-link" aria-hidden="true"></i></a>
                ${reviewMode ? `
                  <button class="inline-icon-button confirm-candidate-button" type="button" data-confirm-candidate="${escapeHtml(address)}" title="确认入库" aria-label="确认候选入库"><i data-lucide="badge-check" aria-hidden="true"></i></button>
                  <button class="inline-icon-button exclude-candidate-button" type="button" data-exclude-candidate="${escapeHtml(address)}" title="剔除候选" aria-label="剔除候选"><i data-lucide="circle-x" aria-hidden="true"></i></button>
                ` : `
                  <button class="inline-icon-button" type="button" data-edit-wallet="${escapeHtml(address)}" title="编辑名称、标签与备注" aria-label="编辑地址库记录"><i data-lucide="square-pen" aria-hidden="true"></i></button>
                  ${String(wallet.status || 'active').toLowerCase() === 'excluded' ? '' : `<button class="inline-icon-button disable-wallet-button" type="button" data-disable-wallet="${escapeHtml(address)}" title="删除并禁用地址" aria-label="删除并禁用 ${escapeHtml(alias || shortAddress(address))}"><i data-lucide="trash-2" aria-hidden="true"></i></button>`}
                `}
              </td>
              <td class="holding-cell" data-label="当前持仓"><strong>${formatMoney(holdingValue)}</strong><span>${escapeHtml(holderRankLabel(holderRank))} · ${escapeHtml(formatHoldingShare(holdingShare))}</span></td>
              <td class="profit-cell realized-profit-cell" data-label="已实现利润"><strong class="profit-value ${profitTone(realizedProfit)}">${formatSignedMoney(realizedProfit)}</strong><span>${formatMultiple(walletRealized(wallet))}</span></td>
              <td class="profit-cell unrealized-profit-cell" data-label="未实现利润"><strong class="profit-value ${profitTone(unrealizedProfit)}">${formatSignedMoney(unrealizedProfit)}</strong><span>${formatMultiple(walletUnrealized(wallet))}</span></td>
              <td class="profit-cell total-profit-cell" data-label="总利润"><strong class="profit-value ${profitTone(totalProfit)}">${formatSignedMoney(totalProfit)}</strong><span>${formatMultiple(bestMultiple)} 最高${topHolderCount === null ? '' : ` · ${formatInteger(topHolderCount)} 个 Top Holder`}</span></td>
              <td class="smart-score-cell" data-label="相对评分"><strong>${formatRequiredNumber(smartScore, { maximumFractionDigits: 1 })}</strong><span>${normalizedProfitScore !== null ? `利润百分位 ${formatPercent(normalizedProfitScore)}` : profitToPeakMarketCapRatio !== null ? `利润 / 峰值市值 ${formatRatio(profitToPeakMarketCapRatio)}` : '利润百分位待补全'}</span></td>
              <td class="smart-win-cell" data-label="胜场 / 有效"><strong>${winningEntries === null && eligibleEntries === null ? '待补全' : `${formatRequiredNumber(winningEntries, { maximumFractionDigits: 0 })} / ${formatRequiredNumber(eligibleEntries, { maximumFractionDigits: 0 })}`}</strong><span>加权账面胜率 ${adjustedWinRate === null ? '待补全' : formatPercent(adjustedWinRate)}</span></td>
              <td class="smart-frequency-cell" data-label="交易频率"><strong>${totalTradeCount === null ? '待补全' : `${formatRequiredNumber(totalTradeCount, { maximumFractionDigits: 0 })} 笔`}</strong><span>每次入场 ${formatRequiredNumber(tradesPerEntry)}</span></td>
              <td class="data-status-cell" data-label="数据状态"><span class="status-badge ${escapeHtml(dataStatus.tone)}">${escapeHtml(dataStatus.label)}</span><span>${escapeHtml(snapshotAt ? formatDateTime(snapshotAt) : `${confidence.label}置信`)}</span></td>
            </tr>
          `;
        }).join('')}
      </tbody>
    </table>
  `;
}

function winnerStatus(winner) {
  const stage = winnerPipelineStage(winner);
  const counts = winnerPipelineCounts(winner);
  if (/(fail|error)/.test(stage)) return { tone: 'failed', label: 'Holder 分析失败' };
  if (/(partial|incomplete)/.test(stage)) return { tone: 'partial', label: 'Holder 数据部分可用' };
  if (/(queue|pending|running)/.test(stage)) return { tone: 'pending', label: '等待 Holder 分析' };
  if (/(analy|profit)/.test(stage)) return { tone: 'pending', label: '核算地址收益' };
  if (/(fetch|holder|candidate)/.test(stage)) return { tone: 'pending', label: '抓取持仓候选' };
  if (/(complete|ready|eligible)/.test(stage)) return { tone: 'qualified', label: 'Holder 分析完成' };
  if (counts.fetched !== null && (counts.analyzed === null || counts.analyzed < counts.fetched)) {
    return { tone: 'pending', label: '核算地址收益' };
  }
  if (counts.eligible !== null) return { tone: 'qualified', label: 'Holder 分析完成' };
  const scanStatus = String(firstValue(winner, ['scanStatus', 'status'], '')).toLowerCase();
  const taskStatus = String(firstValue(winner, ['qualificationStatus', 'status'], '')).toLowerCase();
  const combined = `${scanStatus} ${taskStatus}`;
  if (scanStatus === 'complete') return { tone: 'qualified', label: '扫描完成' };
  if (scanStatus.includes('partial')) return { tone: 'partial', label: '部分数据' };
  if (/(failed|error)/.test(scanStatus)) return { tone: 'failed', label: '扫描失败' };
  if (/(running|pending|queued|scanning)/.test(combined)) return { tone: 'pending', label: '扫描中' };
  if (/(failed|error)/.test(combined)) return { tone: 'failed', label: '扫描失败' };
  if (taskStatus === 'partial') return { tone: 'partial', label: '部分数据' };
  if (/(qualified|below)/.test(taskStatus)) return { tone: 'qualified', label: '扫描完成' };
  return { tone: 'unknown', label: '待扫描' };
}

function renderWinnerTable(winners) {
  if (!winners.length) return renderEmpty('还没有金狗任务', '提交 CA 后会在这里显示持仓候选抓取与收益核算状态。');
  return `
    <table class="research-table winner-table">
      <thead>
        <tr>
          <th class="rank-column">#</th>
          <th>代币</th>
          <th>已抓取</th>
          <th>已核算</th>
          <th>可入库 / 过滤</th>
          <th>状态</th>
          <th>提交 / 更新</th>
        </tr>
      </thead>
      <tbody>
        ${winners.map((winner, index) => {
          const address = normalizeAddress(winner.address) || String(winner.address || '');
          const symbol = firstValue(winner, ['symbol', 'ticker'], 'UNKNOWN');
          const name = firstValue(winner, ['name', 'tokenName'], symbol);
          const status = winnerStatus(winner);
          const counts = winnerPipelineCounts(winner);
          const stage = winnerPipelineStage(winner);
          const minimumEntryUsd = finiteNumber(
            matchingWinnerJob(winner)?.minimumEntryUsd,
            winner?.holderAnalysis?.minimumEntryUsd,
            winner?.minimumEntryUsd,
            currentMinimumEntryUsd()
          ) ?? 500;
          const rescanning = winnerRescanActive(winner);
          const selected = normalizeAddress(address) === state.selectedWinnerAddress;
          return `
            <tr class="result-row${selected ? ' is-selected' : ''}" data-token-address="${escapeHtml(address)}">
              <td class="rank-cell" data-label="排名">${index + 1}</td>
              <td class="token-cell" data-label="代币">
                <button class="token-select" type="button" data-select-token="${escapeHtml(address)}">
                  ${renderTokenLogo(winner)}
                  <span class="token-copy">
                    <strong>${escapeHtml(symbol)}</strong>
                    <span>${escapeHtml(name)} · ${escapeHtml(shortAddress(address))}</span>
                  </span>
                </button>
                <button class="inline-icon-button" type="button" data-copy="${escapeHtml(address)}" title="复制 CA" aria-label="复制代币 CA">
                  <i data-lucide="copy" aria-hidden="true"></i>
                </button>
                <button class="inline-icon-button rescan-winner-button${rescanning ? ' is-spinning' : ''}" type="button" data-rescan-winner="${escapeHtml(address)}" title="${rescanning ? 'Holder 正在重新分析' : '重新分析 Holder'}" aria-label="${rescanning ? 'Holder 正在重新分析' : '重新分析这个 CA 的 Holder'}"${rescanning ? ' disabled' : ''}>
                  <i data-lucide="refresh-cw" aria-hidden="true"></i>
                </button>
              </td>
              <td data-label="已抓取"><strong>${formatInteger(counts.fetched)}</strong><span>Holder 候选</span></td>
              <td data-label="已核算"><strong>${formatInteger(counts.analyzed)}</strong><span>${escapeHtml(stage ? pipelineStageLabel(stage) : '收益地址')}</span></td>
              <td data-label="可入库 / 过滤"><strong>${formatInteger(counts.eligible)}</strong><span>${formatInteger(counts.filtered)} 个 &lt; ${formatMoney(minimumEntryUsd)}</span></td>
              <td data-label="状态"><span class="status-badge ${escapeHtml(status.tone)}">${escapeHtml(status.label)}</span></td>
              <td data-label="提交 / 更新"><strong>手工提交</strong><span>${escapeHtml(formatDateTime(firstValue(winner, ['scannedAt', 'updatedAt', 'addedAt'])))}</span></td>
            </tr>
          `;
        }).join('')}
      </tbody>
    </table>
  `;
}

function renderEmpty(title, message) {
  return `
    <div class="empty-state">
      <i data-lucide="search-x" aria-hidden="true"></i>
      <strong>${escapeHtml(title)}</strong>
      <span>${escapeHtml(message)}</span>
    </div>
  `;
}

function renderLoading() {
  elements.results.innerHTML = `
    <div class="loading-state" role="status">
      <span class="loading-bar"></span>
      <span class="loading-bar short"></span>
      <span class="loading-bar"></span>
      <p>正在整理地址收益与命中记录...</p>
    </div>
  `;
}

function syncCandidateActions() {
  const selectionMode = isWalletSelectionTab() && state.activeTab !== 'winners';
  elements.candidateActions.hidden = !selectionMode;
  elements.confirmSelectedButton.hidden = !isCandidateReviewTab();
  elements.deleteSelectedButton.hidden = !selectionMode;
  if (!selectionMode) {
    elements.selectPageCandidates.checked = false;
    elements.selectPageCandidates.indeterminate = false;
    elements.confirmSelectedButton.disabled = true;
    elements.deleteSelectedButton.disabled = true;
    return;
  }
  const visibleAddresses = state.visibleWallets
    .filter((wallet) => walletIsSelectable(wallet))
    .map((wallet) => normalizeAddress(wallet.address))
    .filter(Boolean);
  const selectedCount = visibleAddresses.filter((address) => state.selectedCandidates.has(address)).length;
  elements.selectPageCandidates.disabled = visibleAddresses.length === 0;
  elements.selectPageCandidates.checked = visibleAddresses.length > 0 && selectedCount === visibleAddresses.length;
  elements.selectPageCandidates.indeterminate = selectedCount > 0 && selectedCount < visibleAddresses.length;
  elements.confirmSelectedButton.disabled = !isCandidateReviewTab() || selectedCount === 0;
  elements.deleteSelectedButton.disabled = selectedCount === 0;
  elements.confirmSelectedLabel.textContent = selectedCount
    ? `确认 ${selectedCount} 个入库`
    : '确认选中入库';
  elements.deleteSelectedLabel.textContent = selectedCount
    ? (isCandidateReviewTab() ? `删除 ${selectedCount} 个候选` : `删除 ${selectedCount} 个地址`)
    : '批量删除';
}

function renderResults() {
  if (!state.data) return;
  const filters = readFilters();
  syncToolbarVisibility();
  if (state.activeTab === 'winners') {
    elements.resultsTitle.textContent = '金狗队列';
    const scanning = activeJobs(state.data.jobs).length;
    const pipeline = aggregateHolderPipeline(state.data);
    const pipelineCopy = pipelineSummary(pipeline);
    elements.resultsSummary.textContent = `${state.data.winners.length} 个手工 CA${pipelineCopy ? ` · ${pipelineCopy}` : ''} · ${scanning} 个任务进行中`;
    elements.sort.closest('.sort-control').hidden = true;
    elements.results.innerHTML = renderWinnerTable(state.data.winners);
    syncCandidateActions();
    let selected = state.data.winners.find((winner) => normalizeAddress(winner.address) === state.selectedWinnerAddress);
    if (!selected && state.data.winners[0]) {
      state.selectedWinnerAddress = normalizeAddress(state.data.winners[0].address);
      selected = state.data.winners[0];
      renderResultsSelection();
    }
    if (selected && (state.detailView !== 'winner' || state.detailAddress !== normalizeAddress(selected.address))) {
      renderWinnerDetail(selected);
    }
    if (selected) syncWinnerRescanButtons(selected);
  } else {
    elements.resultsTitle.textContent = TAB_LABELS[state.activeTab];
    state.visibleWallets = sortWallets(filterWallets(state.data.wallets, filters));
    const minimumEntryUsd = filters.minEntryUsd;
    const sortLabel = SORT_LABELS[elements.sort.value] || SORT_LABELS.smart_score;
    const strategyLabel = filters.strategy === 'smart' ? '智能策略' : `${filters.multiple}x 起`;
    const reviewLabel = isCandidateReviewTab() ? '最近重扫待审核 Holder' : '已确认地址';
    const batchSize = Array.isArray(state.data.reviewBatchTokenAddresses)
      ? state.data.reviewBatchTokenAddresses.length
      : 0;
    const batchLabel = isCandidateReviewTab() && batchSize ? ` · ${batchSize} 个 CA` : '';
    elements.resultsSummary.textContent = `${state.visibleWallets.length} 个${reviewLabel}${batchLabel} · ${strategyLabel} · 按${sortLabel}排序 · 单币买入 ≥ ${formatMoney(minimumEntryUsd)}`;
    elements.sort.closest('.sort-control').hidden = false;
    elements.results.innerHTML = renderWalletTable(state.visibleWallets);
    syncCandidateActions();
    let selected = state.visibleWallets.find((wallet) => normalizeAddress(wallet.address) === state.selectedAddress);
    if (!selected && state.visibleWallets[0]) {
      state.selectedAddress = normalizeAddress(state.visibleWallets[0].address);
      selected = state.visibleWallets[0];
      renderResultsSelection();
    }
    if (selected && (state.detailView !== 'wallet' || state.detailAddress !== normalizeAddress(selected.address))) {
      void loadWalletDetail(selected, { preservePanel: false });
    }
    if (!state.visibleWallets.length) renderDetailPlaceholder('当前分类没有地址', '调整条件后，这里会显示逐币交易分析。');
  }
  refreshIcons(elements.results);
}

function renderDetailPlaceholder(title = '选择一个地址', message = '查看逐币收益、入场时间线和退出流动性。') {
  state.detailView = 'placeholder';
  state.detailAddress = '';
  elements.detail.innerHTML = `
    <div class="detail-placeholder">
      <i data-lucide="mouse-pointer-2" aria-hidden="true"></i>
      <strong>${escapeHtml(title)}</strong>
      <span>${escapeHtml(message)}</span>
    </div>
  `;
  refreshIcons(elements.detail);
}

function renderDetailLoading(address) {
  elements.detail.innerHTML = `
    <div class="detail-loading">
      <span class="loading-spinner" aria-hidden="true"></span>
      <strong>正在读取 ${escapeHtml(shortAddress(address))}</strong>
      <span>归集逐币买卖与当前持仓...</span>
    </div>
  `;
}

function renderMetric(label, value, note = '', tone = '') {
  return `
    <div class="detail-metric ${escapeHtml(tone)}">
      <span>${escapeHtml(label)}</span>
      <strong>${escapeHtml(value)}</strong>
      ${note ? `<small>${escapeHtml(note)}</small>` : ''}
    </div>
  `;
}

function positionMetric(position, keys) {
  const analysis = position.analysis || position.metrics || position.performance || {};
  return firstValue(position, keys, firstValue(analysis, keys));
}

function positionRealizedProfit(position) {
  const profit = position.profit && typeof position.profit === 'object' ? position.profit : {};
  return finiteNumber(
    positionMetric(position, ['realizedProfitUsd', 'realized_profit']),
    profit.realizedProfitUsd,
    profit.realized_profit
  );
}

function positionUnrealizedProfit(position) {
  const profit = position.profit && typeof position.profit === 'object' ? position.profit : {};
  return finiteNumber(
    positionMetric(position, ['unrealizedProfitUsd', 'unrealized_profit']),
    profit.unrealizedProfitUsd,
    profit.unrealized_profit
  );
}

function positionHoldingValue(position) {
  const holder = getObject(position, ['holderSnapshot', 'holder', 'holding']) || {};
  return finiteNumber(
    positionMetric(position, ['holdingValueUsd', 'balanceUsd', 'balance', 'currentValueUsd', 'openPositionValueUsd', 'unrealizedValueUsd']),
    holder.valueUsd,
    holder.balanceUsd,
    holder.balance
  );
}

function positionHolderRank(position) {
  const holder = getObject(position, ['holderSnapshot', 'holder', 'holding']) || {};
  const rank = finiteNumber(
    positionMetric(position, ['holderRank', 'topHolderRank', 'holder_rank']),
    holder.rank,
    holder.holderRank
  );
  return rank === null || rank < 1 ? null : Math.floor(rank);
}

function positionHoldingShare(position) {
  const holder = getObject(position, ['holderSnapshot', 'holder', 'holding']) || {};
  const explicit = finiteNumber(
    positionMetric(position, ['holdingSharePercent', 'holderSharePercent', 'positionPercent']),
    holder.sharePercent
  );
  if (explicit !== null) return explicit;
  const ratio = finiteNumber(positionMetric(position, ['holdingShare', 'positionRate']), holder.share);
  return ratio === null ? null : ratio * 100;
}

function positionPeakMarketCapUsd(position) {
  return finiteNumber(positionMetric(position, ['peakMarketCapUsd', 'peak_market_cap_usd']));
}

function positionSignificantProfitThresholdUsd(position) {
  return finiteNumber(positionMetric(position, [
    'significantProfitThresholdUsd',
    'significantProfitUsd',
    'significant_profit_threshold_usd'
  ]));
}

function positionProfitToPeakMarketCapRatio(position) {
  return finiteNumber(positionMetric(position, [
    'profitToPeakMarketCapRatio',
    'profit_to_peak_market_cap_ratio'
  ]));
}

function positionPeakMarketCapProvisional(position) {
  const value = positionMetric(position, ['peakMarketCapProvisional', 'peak_market_cap_provisional']);
  if (value === null || value === undefined || value === '') return null;
  if (value === true || value === 1 || String(value).toLowerCase() === 'true') return true;
  if (value === false || value === 0 || String(value).toLowerCase() === 'false') return false;
  return null;
}

function positionPeakMarketCapSource(position) {
  const value = positionMetric(position, ['peakMarketCapSource', 'peak_market_cap_source']);
  return value === null || value === undefined || value === '' ? '' : String(value);
}

function peakMarketCapSourceLabel(source) {
  const raw = String(source || '').trim();
  if (!raw) return '来源待补全';
  const normalized = raw.toLowerCase().replace(/[\s_-]+/g, '');
  if (normalized.includes('dexscreener')) return 'DexScreener';
  if (normalized.includes('debot')) return 'DeBot';
  if (normalized.includes('blockscout')) return 'Blockscout';
  if (/(onchain|rpc|chain)/.test(normalized)) return '链上数据';
  if (/(estimate|calculated)/.test(normalized)) return '收益估算';
  return raw;
}

function peakMarketCapMeta(position) {
  const provisional = positionPeakMarketCapProvisional(position);
  const status = provisional === true
    ? '暂估'
    : provisional === false
      ? '已核验'
      : '暂估状态待补全';
  return `${status} · ${peakMarketCapSourceLabel(positionPeakMarketCapSource(position))}`;
}

function renderPosition(position) {
  const token = position.token && typeof position.token === 'object' ? position.token : position;
  const symbol = firstValue(token, ['symbol', 'ticker'], 'UNKNOWN');
  const address = normalizeAddress(firstValue(token, ['address', 'tokenAddress'], position.tokenAddress)) || '';
  const realized = positionMetric(position, ['realizedMultiple', 'maxRealizedMultiple']);
  const unrealized = positionMetric(position, ['unrealizedMultiple', 'maxUnrealizedMultiple']);
  const peak = positionMetric(position, [
    'bestMultiple', 'totalMultiple', 'peakPotentialMultiple', 'athPotentialMultiple', 'maxPeakMultiple'
  ]);
  const realizedProfit = positionRealizedProfit(position);
  const unrealizedProfit = positionUnrealizedProfit(position);
  const holdingValue = positionHoldingValue(position);
  const holdingAmount = positionMetric(position, ['holdingTokenAmount', 'position', 'remainingTokenAmount', 'balanceToken']);
  const holderRank = positionHolderRank(position);
  const holdingShare = positionHoldingShare(position);
  const peakMarketCapUsd = positionPeakMarketCapUsd(position);
  const significantProfitThresholdUsd = positionSignificantProfitThresholdUsd(position);
  const profitToPeakMarketCapRatio = positionProfitToPeakMarketCapRatio(position);
  const warnings = [
    ...(Array.isArray(position.warnings) ? position.warnings : []),
    firstValue(position, ['exitWarning', 'liquidityWarning'], '')
  ].filter(Boolean);
  const actions = Array.isArray(position.actions) ? position.actions.slice(0, 12) : [];
  return `
    <article class="position-row">
      <div class="position-head">
        <div class="position-token">
          ${renderTokenLogo(token, 'small')}
          <div>
            <strong>${escapeHtml(symbol)}</strong>
            <span>${escapeHtml(shortAddress(address))}</span>
          </div>
        </div>
        ${address ? `<a class="inline-icon-button" href="${escapeHtml(`${EXPLORER_ROOT}/token/${address}`)}" target="_blank" rel="noopener noreferrer" title="在浏览器查看代币" aria-label="在浏览器查看代币"><i data-lucide="external-link" aria-hidden="true"></i></a>` : ''}
      </div>
      <dl class="position-metrics">
        <div><dt>当前持仓</dt><dd>${formatMoney(holdingValue)}</dd><small>${formatCompact(holdingAmount)} ${escapeHtml(symbol)} · ${escapeHtml(holderRankLabel(holderRank))} · ${escapeHtml(formatHoldingShare(holdingShare))}</small></div>
        <div><dt>已实现利润</dt><dd class="${profitTone(realizedProfit)}">${formatSignedMoney(realizedProfit)}</dd><small>${formatMultiple(realized)}</small></div>
        <div><dt>未实现利润</dt><dd class="${profitTone(unrealizedProfit)}">${formatSignedMoney(unrealizedProfit)}</dd><small>${formatMultiple(unrealized)}</small></div>
        <div><dt>最高倍数</dt><dd>${formatMultiple(peak)}</dd><small>首笔 ${escapeHtml(formatPrice(positionMetric(position, ['firstBuyPriceUsd', 'entryPriceUsd', 'firstBuyPriceNative'])))}</small></div>
        <div><dt>累计买入</dt><dd>${formatMoney(positionMetric(position, ['entryCostUsd', 'buyVolumeUsd', 'buy_volume']))}</dd><small>${escapeHtml(formatDateTime(positionMetric(position, ['firstBuyAt', 'entryAt', 'firstTradeTime'])))}</small></div>
        <div class="peak-market-cap-metric"><dt>历史最高市值估算</dt><dd>${peakMarketCapUsd === null ? '待补全' : formatMoney(peakMarketCapUsd)}</dd><small>${escapeHtml(peakMarketCapMeta(position))}</small></div>
        <div><dt>显著利润门槛</dt><dd>${significantProfitThresholdUsd === null ? '待补全' : formatMoney(significantProfitThresholdUsd)}</dd><small>逐币门槛</small></div>
        <div><dt>利润 / 峰值市值</dt><dd>${formatRatio(profitToPeakMarketCapRatio)}</dd><small>峰值市值归一化</small></div>
      </dl>
      ${warnings.length ? `<div class="liquidity-warning"><i data-lucide="triangle-alert" aria-hidden="true"></i><span>${warnings.map(escapeHtml).join(' · ')}</span></div>` : ''}
      ${actions.length ? `
        <div class="action-timeline">
          ${actions.map((action) => {
            const side = String(action.side || action.type || '').toLowerCase();
            const isBuy = side === 'buy';
            return `
              <div class="timeline-item">
                <span class="timeline-side ${isBuy ? 'buy' : 'sell'}">${isBuy ? '买' : '卖'}</span>
                <span><strong>${formatCompact(firstValue(action, ['tokenAmount', 'amount']))} ${escapeHtml(symbol)}</strong><small>${formatMoney(firstValue(action, ['quoteAmountUsd', 'valueUsd', 'quoteAmount']), firstValue(action, ['quoteSymbol', 'currency'], 'USD'))}</small></span>
                <time>${escapeHtml(formatDateTime(firstValue(action, ['blockTimestamp', 'timestamp', 'createdAt'])))}</time>
              </div>
            `;
          }).join('')}
        </div>
      ` : ''}
    </article>
  `;
}

function formatPrice(value) {
  const number = finiteNumber(value);
  if (number === null) return '--';
  if (number !== 0 && Math.abs(number) < 0.000001) return `$${number.toExponential(2)}`;
  return `$${number.toLocaleString('en-US', { maximumSignificantDigits: 6 })}`;
}

function normalizeWalletDetail(payload, summary) {
  const record = unwrapRecord(payload || {});
  const wallet = getObject(record, ['wallet', 'summary', 'addressSummary']) || record.wallet || record.summary || record;
  const directPositions = getCollection(record, ['tokens', 'positions', 'holdings', 'items']);
  const summaryPositions = getCollection(wallet, ['performances', 'positions', 'holdings', 'tokens'])
    || getCollection(summary, ['performances', 'positions', 'holdings', 'tokens']);
  const positions = directPositions?.length ? directPositions : summaryPositions || directPositions || [];
  return { wallet: { ...summary, ...(wallet || {}) }, positions };
}

function renderWalletDetail(summary, payload = null) {
  state.detailView = 'wallet';
  const { wallet, positions } = normalizeWalletDetail(payload, summary);
  const address = normalizeAddress(wallet.address || summary.address) || String(wallet.address || summary.address || '');
  state.detailAddress = normalizeAddress(address);
  const explorerUrl = normalizeAddress(address) ? `${EXPLORER_ROOT}/address/${normalizeAddress(address)}` : '';
  const confidence = walletConfidence(wallet);
  const hasPerformance = walletHasPerformance(wallet);
  const confirmed = walletIsConfirmed(wallet);
  const reviewMode = !confirmed && walletIsCandidate(wallet);
  const alias = String(wallet.alias || '').trim();
  const note = String(wallet.note || '').trim();
  const reasons = exclusionReasons(wallet);
  const warnings = [
    ...(Array.isArray(wallet.warnings) ? wallet.warnings : []),
    firstValue(wallet, ['exitWarning', 'liquidityWarning'], '')
  ].filter(Boolean);
  const hitRate = finiteNumber(wallet.hitRate, wallet.winRate) ?? (walletEntries(wallet) ? walletHits(wallet) / walletEntries(wallet) : null);
  const holderRank = walletHolderRank(wallet);
  const holdingValue = walletHoldingValue(wallet);
  const holdingShare = walletHoldingSharePercent(wallet);
  const realizedProfit = walletRealizedProfit(wallet);
  const unrealizedProfit = walletUnrealizedProfit(wallet);
  const totalProfit = walletTotalProfit(wallet);
  const smartScore = walletSmartScore(wallet);
  const eligibleEntries = walletEligibleEntries(wallet);
  const winningEntries = walletWinningEntries(wallet);
  const adjustedWinRate = walletAdjustedWinRate(wallet);
  const totalTradeCount = walletTotalTradeCount(wallet);
  const tradesPerEntry = walletTradesPerEntry(wallet);
  const normalizedProfitScore = walletNormalizedProfitScore(wallet);
  const profitToPeakMarketCapRatio = walletProfitToPeakMarketCapRatio(wallet);
  const dataStatus = walletDataStatus(wallet);
  const snapshotAt = walletHolderSnapshotAt(wallet);
  const orderedPositions = [...positions].sort((left, right) => {
    const leftValue = positionHoldingValue(left);
    const rightValue = positionHoldingValue(right);
    if (leftValue === null && rightValue === null) return 0;
    if (leftValue === null) return 1;
    if (rightValue === null) return -1;
    return rightValue - leftValue;
  });

  elements.detail.innerHTML = `
    <div class="detail-header">
      <div class="detail-identity">
        <span>${reviewMode ? '候选审核' : hasPerformance ? '地址分析' : '地址档案'}</span>
        <h2>${escapeHtml(alias || shortAddress(address))}</h2>
        ${alias ? `<span class="detail-address-line">${escapeHtml(shortAddress(address))}</span>` : ''}
        <div>
          ${classificationBadge(wallet)}
          ${holderRankBadge(wallet)}
          ${monitorTierBadge(wallet)}
          ${hasPerformance ? `<span class="confidence-badge">${escapeHtml(confidence.label)}置信</span>` : ''}
          ${walletStatusBadge(wallet)}
          ${walletTagBadges(wallet, 4)}
          ${reviewMode ? '<span class="status-badge pending">待审核</span>' : confirmed ? '<span class="status-badge qualified">已确认</span>' : ''}
        </div>
      </div>
      <div class="detail-actions">
        ${confirmed ? `<button class="icon-button" type="button" data-edit-wallet="${escapeHtml(address)}" title="编辑名称、标签与备注" aria-label="编辑地址库记录"><i data-lucide="square-pen" aria-hidden="true"></i></button><button class="icon-button disable-wallet-button" type="button" data-disable-wallet="${escapeHtml(address)}" title="删除并禁用地址" aria-label="删除并禁用 ${escapeHtml(alias || shortAddress(address))}"><i data-lucide="trash-2" aria-hidden="true"></i></button>` : reviewMode ? `
          <button class="icon-button confirm-candidate-button" type="button" data-confirm-candidate="${escapeHtml(address)}" title="确认入库" aria-label="确认候选入库"><i data-lucide="badge-check" aria-hidden="true"></i></button>
          <button class="icon-button exclude-candidate-button" type="button" data-exclude-candidate="${escapeHtml(address)}" title="剔除候选" aria-label="剔除候选"><i data-lucide="circle-x" aria-hidden="true"></i></button>
        ` : ''}
        <a class="icon-button debot-link" href="${escapeHtml(`${DEBOT_ADDRESS_ROOT}/${address}`)}" target="_blank" rel="noopener noreferrer" title="在 DeBot 查看持仓" aria-label="在 DeBot 查看持仓"><i data-lucide="external-link" aria-hidden="true"></i></a>
        <button class="icon-button" type="button" data-copy="${escapeHtml(address)}" title="复制完整地址" aria-label="复制完整地址"><i data-lucide="copy" aria-hidden="true"></i></button>
        ${explorerUrl ? `<a class="icon-button" href="${escapeHtml(explorerUrl)}" target="_blank" rel="noopener noreferrer" title="在 Blockscout 查看" aria-label="在 Blockscout 查看"><i data-lucide="external-link" aria-hidden="true"></i></a>` : ''}
      </div>
    </div>

    <div class="detail-metric-grid">
      ${renderMetric('当前持仓市值', formatMoney(holdingValue), `${holderRankLabel(holderRank)} · ${formatHoldingShare(holdingShare)}`)}
      ${renderMetric('已实现利润', formatSignedMoney(realizedProfit), `${formatMultiple(walletRealized(wallet))} 最高`, profitTone(realizedProfit))}
      ${renderMetric('未实现利润', formatSignedMoney(unrealizedProfit), `${formatMultiple(walletUnrealized(wallet))} 最高`, profitTone(unrealizedProfit))}
      ${renderMetric('总利润', formatSignedMoney(totalProfit), dataStatus.label, profitTone(totalProfit))}
      ${renderMetric('最高倍数', formatMultiple(walletBestMultiple(wallet)), `${formatInteger(walletHits(wallet))} 命中 / ${formatInteger(walletEntries(wallet))} 出手`)}
      ${renderMetric('累计买入', formatMoney(wallet.totalEntryCostUsd), `单币 ≥ ${formatMoney(wallet.minimumEntryUsd ?? 500)}`)}
    </div>

    <section class="smart-analysis-band" aria-labelledby="smart-analysis-title">
      <div class="smart-analysis-head">
        <div>
          <span>Holder 收益模型</span>
          <h3 id="smart-analysis-title">智能分析</h3>
        </div>
        <div class="smart-reasons">${renderSmartReasonBadges(wallet)}</div>
      </div>
      <dl class="smart-analysis-grid">
        <div><dt>相对评分</dt><dd>${formatRequiredNumber(smartScore, { maximumFractionDigits: 1 })}</dd></div>
        <div><dt>胜场 / 有效</dt><dd>${winningEntries === null && eligibleEntries === null ? '待补全' : `${formatRequiredNumber(winningEntries, { maximumFractionDigits: 0 })} / ${formatRequiredNumber(eligibleEntries, { maximumFractionDigits: 0 })}`}</dd></div>
        <div><dt>加权账面胜率</dt><dd>${adjustedWinRate === null ? '待补全' : formatPercent(adjustedWinRate)}</dd></div>
        <div><dt>总交易 / 每次入场</dt><dd>${totalTradeCount === null && tradesPerEntry === null ? '待补全' : `${formatRequiredNumber(totalTradeCount, { maximumFractionDigits: 0 })} / ${formatRequiredNumber(tradesPerEntry)}`}</dd></div>
        <div><dt>利润百分位</dt><dd>${normalizedProfitScore === null ? '待补全' : formatPercent(normalizedProfitScore)}</dd></div>
        <div><dt>利润 / 峰值市值</dt><dd>${formatRatio(profitToPeakMarketCapRatio)}</dd></div>
      </dl>
    </section>

    ${note ? `<div class="liquidity-notice neutral"><i data-lucide="sticky-note" aria-hidden="true"></i><div><strong>地址备注</strong><span>${escapeHtml(note)}</span></div></div>` : ''}
    ${reasons.length ? `<div class="risk-notice"><i data-lucide="shield-alert" aria-hidden="true"></i><div><strong>噪声地址提示</strong><span>${reasons.map(escapeHtml).join(' · ')}</span></div></div>` : ''}
    <div class="holder-snapshot-line"><span class="status-badge ${escapeHtml(dataStatus.tone)}">${escapeHtml(dataStatus.label)}</span><span>${snapshotAt ? `持仓快照 ${escapeHtml(formatDateTime(snapshotAt))}` : '持仓快照时间待补全'}</span></div>
    ${!hasPerformance ? '<div class="liquidity-notice neutral"><i data-lucide="bookmark" aria-hidden="true"></i><div><strong>Holder 候选</strong><span>当前没有完整的交易动作；已有持仓与利润快照仍可用于候选比较。</span></div></div>' : warnings.length ? `<div class="liquidity-notice"><i data-lucide="waves" aria-hidden="true"></i><div><strong>退出与流动性</strong><span>${warnings.map(escapeHtml).join(' · ')}</span></div></div>` : `
      <div class="liquidity-notice neutral"><i data-lucide="waves" aria-hidden="true"></i><div><strong>退出与流动性</strong><span>账面倍数不等于可成交倍数；请结合当前池深、价格冲击和剩余仓位判断。</span></div></div>
    `}

    <section class="detail-section">
      <div class="detail-section-head"><h3>逐币持仓与收益</h3><span>${positions.length} 个有效投资样本</span></div>
      <div class="position-list">
        ${orderedPositions.length ? orderedPositions.map(renderPosition).join('') : `<div class="detail-empty">${holdingValue !== null || totalProfit !== null ? '逐币明细仍在归集，当前先显示 Holder 汇总快照。' : `暂无达到 ${formatMoney(wallet.minimumEntryUsd ?? currentMinimumEntryUsd())} 买入门槛的逐币候选。`}</div>`}
      </div>
    </section>
  `;
  refreshIcons(elements.detail);
}

function renderWinnerDetail(winner) {
  state.detailView = 'winner';
  const address = normalizeAddress(winner.address) || String(winner.address || '');
  state.detailAddress = normalizeAddress(address);
  const symbol = firstValue(winner, ['symbol', 'ticker'], 'UNKNOWN');
  const status = winnerStatus(winner);
  const provisional = winner.provisional === true;
  const effectiveWallets = firstValue(winner, ['effectiveWallets', 'effectiveWalletCount']);
  const pipeline = winnerPipelineCounts(winner);
  const stage = winnerPipelineStage(winner);
  const minimumEntryUsd = finiteNumber(
    matchingWinnerJob(winner)?.minimumEntryUsd,
    winner?.holderAnalysis?.minimumEntryUsd,
    winner?.minimumEntryUsd,
    currentMinimumEntryUsd()
  ) ?? 500;
  const rescanning = winnerRescanActive(winner);
  const explorerUrl = normalizeAddress(address) ? `${EXPLORER_ROOT}/token/${normalizeAddress(address)}` : '';
  elements.detail.innerHTML = `
    <div class="detail-header token-detail-header">
      <div class="detail-token-title">
        ${renderTokenLogo(winner, 'large')}
        <div>
          <span>手工金狗</span>
          <h2>${escapeHtml(symbol)}</h2>
          <p>${escapeHtml(firstValue(winner, ['name', 'tokenName'], symbol))} · ${escapeHtml(shortAddress(address))}</p>
        </div>
      </div>
      <div class="detail-actions">
        <button class="icon-button rescan-winner-button${rescanning ? ' is-spinning' : ''}" type="button" data-rescan-winner="${escapeHtml(address)}" title="${rescanning ? 'Holder 正在重新分析' : '重新分析 Holder'}" aria-label="${rescanning ? 'Holder 正在重新分析' : '重新分析这个 CA 的 Holder'}"${rescanning ? ' disabled' : ''}><i data-lucide="refresh-cw" aria-hidden="true"></i></button>
        <button class="icon-button" type="button" data-copy="${escapeHtml(address)}" title="复制 CA" aria-label="复制代币 CA"><i data-lucide="copy" aria-hidden="true"></i></button>
        ${explorerUrl ? `<a class="icon-button" href="${escapeHtml(explorerUrl)}" target="_blank" rel="noopener noreferrer" title="在 Blockscout 查看" aria-label="在 Blockscout 查看"><i data-lucide="external-link" aria-hidden="true"></i></a>` : ''}
      </div>
    </div>

    <div class="sample-status-line"><span class="status-badge ${escapeHtml(status.tone)}">${escapeHtml(status.label)}</span><span>手工提交</span></div>

    <div class="detail-metric-grid winner-metrics">
      ${renderMetric('已抓取候选', formatInteger(pipeline.fetched), 'Holder / 交易地址')}
      ${renderMetric('已核算收益', formatInteger(pipeline.analyzed), pipelineStageLabel(stage))}
      ${renderMetric('符合入库', formatInteger(pipeline.eligible), '进入聪明地址库')}
      ${renderMetric(`${formatMoney(minimumEntryUsd)} 以下已过滤`, formatInteger(pipeline.filtered), '不监控小额买入')}
    </div>

    <section class="detail-section">
      <div class="detail-section-head"><h3>扫描记录</h3><span>${escapeHtml(formatDateTime(firstValue(winner, ['scannedAt', 'updatedAt', 'addedAt'])))}</span></div>
      <dl class="qualification-list">
        <div><dt>提交方式</dt><dd>手工提交</dd></div>
        <div><dt>链上扫描</dt><dd class="${status.tone === 'failed' ? 'negative' : ''}">${escapeHtml(status.label)}</dd></div>
        <div><dt>Holder 候选</dt><dd>${pipeline.fetched === null ? '待抓取' : `${formatInteger(pipeline.fetched)} 个`}</dd></div>
      </dl>
    </section>

    <div class="liquidity-notice neutral"><i data-lucide="info" aria-hidden="true"></i><div><strong>Holder-first 口径</strong><span>${provisional ? `正在抓取持仓候选并核算逐地址收益；累计买入低于 ${formatMoney(minimumEntryUsd)} 的地址不会进入监控。` : `${formatInteger(effectiveWallets)} 个有效交易地址作为补充候选，最终按总盈利进入排行榜。`}</span></div></div>
  `;
  refreshIcons(elements.detail);
}

async function fetchWalletDetail(address) {
  try {
    return await fetchJson(`${API_ROOT}/wallets/${encodeURIComponent(address)}`);
  } catch (error) {
    if (![404, 405].includes(error.status)) throw error;
    return fetchJson(`${API_ROOT}/wallet/${encodeURIComponent(address)}`);
  }
}

async function loadWalletDetail(summary, { preservePanel = false } = {}) {
  const address = normalizeAddress(summary?.address);
  if (!address) {
    renderWalletDetail(summary || {});
    return;
  }
  state.selectedAddress = address;
  renderResultsSelection();
  if (state.detailCache.has(address)) {
    renderWalletDetail(summary, state.detailCache.get(address));
    return;
  }
  if (!preservePanel) renderDetailLoading(address);
  const sequence = ++state.detailSequence;
  try {
    const payload = await fetchWalletDetail(address);
    if (sequence !== state.detailSequence || state.selectedAddress !== address) return;
    state.detailCache.set(address, payload);
    renderWalletDetail(summary, payload);
  } catch (error) {
    if (sequence !== state.detailSequence || state.selectedAddress !== address) return;
    if (error.status === 404) {
      renderWalletDetail(summary);
      return;
    }
    renderWalletDetail(summary);
    showToast(`逐币明细暂时不可用：${error.message}`, 'error');
  }
}

function renderResultsSelection() {
  elements.results.querySelectorAll('[data-address], [data-token-address]').forEach((row) => {
    const address = normalizeAddress(row.dataset.address || row.dataset.tokenAddress);
    const selected = state.activeTab === 'winners'
      ? address === state.selectedWinnerAddress
      : address === state.selectedAddress;
    row.classList.toggle('is-selected', selected);
  });
}

function scrollDetailOnMobile() {
  if (window.matchMedia('(max-width: 760px)').matches) {
    requestAnimationFrame(() => elements.detail.scrollIntoView({ behavior: 'smooth', block: 'start' }));
  }
}

function syncToolbarVisibility() {
  const showingMonitor = state.activeTab === 'monitor';
  const showingWinnerQueue = state.activeTab === 'winners';
  const showingConfirmedLibrary = state.activeTab === 'all_round';
  elements.status.hidden = showingMonitor;
  elements.submissionDock.hidden = showingMonitor;
  elements.researchBoard.hidden = showingMonitor;
  elements.monitorPage.hidden = !showingMonitor;
  elements.filterForm.hidden = showingMonitor || showingWinnerQueue;
  elements.libraryForm.hidden = showingMonitor || showingWinnerQueue;
  elements.walletMonitorTierField.hidden = !showingConfirmedLibrary;
  elements.libraryForm.classList.toggle('shows-monitor-tier', showingConfirmedLibrary);
  elements.debotExportButton.hidden = state.activeTab !== 'all_round';
  elements.manualWalletForm.hidden = !showingConfirmedLibrary;
  elements.candidateActions.hidden = showingMonitor || showingWinnerQueue || !isWalletSelectionTab();
  elements.scanButton.hidden = showingMonitor;
  elements.refreshButton.title = showingMonitor ? '刷新实时监控' : '刷新数据';
  elements.refreshButton.setAttribute('aria-label', elements.refreshButton.title);
}

function schedulePoll(data) {
  clearTimeout(state.pollTimer);
  state.pollTimer = null;
  if (statusFromData(data) === 'scanning') {
    state.pollTimer = setTimeout(() => void loadData({ quiet: true }), 3500);
  }
}

async function loadData({ quiet = false } = {}) {
  const sequence = ++state.requestSequence;
  state.loading = true;
  if (!quiet && !state.data) renderLoading();
  if (!quiet) setSystemStatus('loading', '正在读取 Holder 地址库', '正在加载持仓快照、盈利排名与分析任务。');
  elements.refreshButton.disabled = true;
  try {
    const data = await loadApiData(readFilters());
    if (sequence !== state.requestSequence) return;
    state.data = data;
    renderHeader(data);
    renderStatus(data);
    renderResults();
    schedulePoll(data);
  } catch (error) {
    if (sequence !== state.requestSequence) return;
    const message = error instanceof Error ? error.message : String(error);
    if (state.data) {
      setSystemStatus('stale', '刷新失败，保留现有数据', message);
    } else {
      setSystemStatus('error', '无法读取分析数据', message);
      elements.results.innerHTML = `
        <div class="error-state">
          <i data-lucide="cloud-off" aria-hidden="true"></i>
          <strong>数据暂时不可用</strong>
          <span>${escapeHtml(message)}</span>
          <button class="command-button" type="button" data-retry><i data-lucide="refresh-cw" aria-hidden="true"></i>重新读取</button>
        </div>
      `;
      refreshIcons(elements.results);
    }
  } finally {
    if (sequence === state.requestSequence) {
      state.loading = false;
      elements.refreshButton.disabled = false;
      elements.scanButton.disabled = statusFromData(state.data) === 'scanning';
    }
  }
}

async function startScan() {
  elements.minHits.value = '1';
  syncMinimumEntryDisplay({ normalizeInput: true });
  const filters = readFilters();
  const body = JSON.stringify({ ...filters, classification: state.activeTab === 'winners' ? 'all' : state.activeTab });
  setSystemStatus('scanning', 'Holder-first 重扫已提交', '正在抓取手工金狗的持仓候选，并核算逐地址收益。');
  try {
    try {
      await fetchJson(`${API_ROOT}/jobs/scan`, { method: 'POST', body });
    } catch (error) {
      if (![404, 405].includes(error.status)) throw error;
      await fetchJson(`${API_ROOT}/refresh`, { method: 'POST', body });
    }
    showToast('手工金狗重扫已进入队列');
    window.setTimeout(() => void loadData({ quiet: true }), 350);
  } catch (error) {
    setSystemStatus('error', '扫描任务提交失败', error.message);
    showToast(`扫描失败：${error.message}`, 'error');
  }
}

async function rescanWinner(address) {
  const normalized = normalizeAddress(address);
  if (!normalized || state.rescanningWinnerAddresses.has(normalized)) return;
  elements.minHits.value = '1';
  state.rescanningWinnerAddresses.add(normalized);
  syncWinnerRescanButtonsByAddress(normalized);
  try {
    const minEntryUsd = syncMinimumEntryDisplay({ normalizeInput: true });
    const result = await fetchJson(`${API_ROOT}/winners/${encodeURIComponent(normalized)}/rescan`, {
      method: 'POST',
      body: JSON.stringify({ minEntryUsd })
    });
    showToast(result.alreadyRunning ? '这个 CA 正在分析中' : 'Holder 重新分析已进入队列');
    await loadData({ quiet: true });
  } catch (error) {
    showToast(`重新分析失败：${error.message}`, 'error');
  } finally {
    state.rescanningWinnerAddresses.delete(normalized);
    syncWinnerRescanButtonsByAddress(normalized);
  }
}

async function addManualWinner(event) {
  event.preventDefault();
  const parts = elements.manualInput.value.split(/[\s,;，；]+/).map((value) => value.trim()).filter(Boolean);
  const addresses = [...new Set(parts.map(normalizeAddress).filter(Boolean))];
  const invalid = parts.filter((value) => !normalizeAddress(value));
  elements.manualFeedback.className = 'field-feedback';
  if (!addresses.length || invalid.length) {
    elements.manualFeedback.textContent = invalid.length
      ? `${invalid.length} 个 CA 格式不正确。`
      : '请输入完整的 0x 开头、40 位十六进制 CA。';
    elements.manualFeedback.classList.add('error');
    elements.manualInput.focus();
    return;
  }
  if (addresses.length > 20) {
    elements.manualFeedback.textContent = '单次最多提交 20 个 CA。';
    elements.manualFeedback.classList.add('error');
    return;
  }
  elements.minHits.value = '1';
  const minEntryUsd = syncMinimumEntryDisplay({ normalizeInput: true });
  const submit = elements.manualForm.querySelector('button[type="submit"]');
  submit.disabled = true;
  elements.manualFeedback.textContent = `正在提交 ${addresses.length} 个 CA...`;
  try {
    const settled = await Promise.allSettled(addresses.map((address) => fetchJson(`${API_ROOT}/winners`, {
      method: 'POST',
      body: JSON.stringify({ address, minEntryUsd })
    })));
    const accepted = settled.filter((result) => result.status === 'fulfilled' && !result.value.duplicate).length;
    const duplicates = settled.filter((result) => result.status === 'fulfilled' && result.value.duplicate).length;
    const failed = settled.length - accepted - duplicates;
    elements.manualFeedback.textContent = `${accepted} 个已加入 · ${duplicates} 个已存在${failed ? ` · ${failed} 个失败` : ''}`;
    elements.manualFeedback.classList.add('success');
    elements.manualInput.value = '';
    window.setTimeout(() => void loadData({ quiet: true }), 350);
  } catch (error) {
    elements.manualFeedback.textContent = `加入失败：${error.message}`;
    elements.manualFeedback.classList.add('error');
  } finally {
    submit.disabled = false;
  }
}

function walletForAddress(address) {
  const normalized = normalizeAddress(address);
  return state.data?.wallets.find((wallet) => normalizeAddress(wallet.address) === normalized)
    || state.visibleWallets.find((wallet) => normalizeAddress(wallet.address) === normalized)
    || null;
}

function walletBestTokenSymbol(wallet) {
  const direct = firstValue(wallet, [
    'bestTokenSymbol', 'best_token_symbol', 'bestProfitTokenSymbol', 'topTokenSymbol', 'symbol'
  ]);
  if (direct) return String(direct).trim().slice(0, 32);
  const performances = Array.isArray(wallet?.performances) ? wallet.performances : [];
  const ranked = [...performances].sort((left, right) => {
    const leftProfit = (positionRealizedProfit(left) ?? 0) + (positionUnrealizedProfit(left) ?? 0);
    const rightProfit = (positionRealizedProfit(right) ?? 0) + (positionUnrealizedProfit(right) ?? 0);
    return rightProfit - leftProfit;
  });
  const best = ranked[0] || {};
  const token = best.token && typeof best.token === 'object' ? best.token : best;
  return String(firstValue(token, ['symbol', 'ticker'], '金狗')).trim().slice(0, 32) || '金狗';
}

function walletSuggestedAlias(wallet) {
  const smart = walletSmartRecord(wallet);
  const suggested = firstValue(wallet, ['suggestedAlias', 'suggested_alias'], firstValue(smart, [
    'suggestedAlias', 'suggested_alias'
  ]));
  if (String(suggested || '').trim()) return String(suggested).trim().slice(0, 120);
  const address = normalizeAddress(wallet?.address);
  const visibleRank = state.visibleWallets.findIndex((candidate) => normalizeAddress(candidate.address) === address) + 1;
  const explicitRank = finiteNumber(wallet?.profitRank, wallet?.profit_rank, wallet?.rankByProfit);
  const bestSymbol = walletBestTokenSymbol(wallet);
  const profitRank = formatInteger(explicitRank ?? (visibleRank > 0 ? visibleRank : null), '待定');
  return `${bestSymbol} 盈利榜第 ${profitRank} 名`;
}

async function requestCandidateConfirmation(wallet) {
  const address = normalizeAddress(wallet?.address);
  if (!address) throw new Error('候选地址无效');
  return fetchJson(`${API_ROOT}/wallets/${encodeURIComponent(address)}`, {
    method: 'PATCH',
    body: JSON.stringify({
      status: 'active',
      alias: walletSuggestedAlias(wallet)
    })
  });
}

async function confirmCandidate(address) {
  const wallet = walletForAddress(address);
  const normalized = normalizeAddress(address);
  if (!wallet || !normalized) return;
  if (!window.confirm(`确认将 ${shortAddress(normalized)} 加入已确认地址库？`)) return;
  try {
    await requestCandidateConfirmation(wallet);
    state.selectedCandidates.delete(normalized);
    showToast(`已确认入库：${walletSuggestedAlias(wallet)}`);
    await loadData({ quiet: true });
  } catch (error) {
    showToast(`确认失败：${error.message}`, 'error');
  }
}

async function confirmSelectedCandidates() {
  const selected = state.visibleWallets.filter((wallet) => (
    walletIsSelectable(wallet) && state.selectedCandidates.has(normalizeAddress(wallet.address))
  ));
  if (!selected.length) return;
  if (!window.confirm(`二次确认：将选中的 ${selected.length} 个候选加入已确认地址库？`)) return;
  elements.confirmSelectedButton.disabled = true;
  try {
    const settled = await Promise.allSettled(selected.map(requestCandidateConfirmation));
    const confirmed = [];
    settled.forEach((result, index) => {
      if (result.status === 'fulfilled') {
        const address = normalizeAddress(selected[index].address);
        confirmed.push(address);
        state.selectedCandidates.delete(address);
      }
    });
    const failed = settled.length - confirmed.length;
    showToast(`${confirmed.length} 个候选已确认${failed ? ` · ${failed} 个失败` : ''}`, failed ? 'error' : 'success');
    await loadData({ quiet: true });
  } catch (error) {
    showToast(`批量确认失败：${error.message}`, 'error');
  } finally {
    syncCandidateActions();
  }
}

async function deleteSelectedWallets() {
  const selected = state.visibleWallets.filter((wallet) => (
    walletIsSelectable(wallet) && state.selectedCandidates.has(normalizeAddress(wallet.address))
  ));
  if (!selected.length) return;
  const candidateMode = isCandidateReviewTab();
  const message = candidateMode
    ? `确认批量删除选中的 ${selected.length} 个候选？之后不会再出现在默认候选中。`
    : `确认从已确认地址库删除并禁用选中的 ${selected.length} 个地址？这些地址会立即停止实时监控，可在“已排除”筛选中恢复。`;
  if (!window.confirm(message)) return;
  elements.deleteSelectedButton.disabled = true;
  try {
    const settled = await Promise.allSettled(selected.map((wallet) => {
      const address = normalizeAddress(wallet.address);
      return fetchJson(`${API_ROOT}/wallets/${encodeURIComponent(address)}`, { method: 'DELETE' });
    }));
    const deleted = [];
    settled.forEach((result, index) => {
      if (result.status !== 'fulfilled') return;
      const address = normalizeAddress(selected[index].address);
      deleted.push(address);
      state.selectedCandidates.delete(address);
      state.detailCache.delete(address);
    });
    const failed = settled.length - deleted.length;
    showToast(`${deleted.length} 个${candidateMode ? '候选' : '地址'}已删除${failed ? ` · ${failed} 个失败` : ''}`, failed ? 'error' : 'success');
    await loadData({ quiet: true });
  } catch (error) {
    showToast(`批量删除失败：${error.message}`, 'error');
  } finally {
    syncCandidateActions();
  }
}

async function excludeCandidate(address) {
  const normalized = normalizeAddress(address);
  if (!normalized || !window.confirm(`确认剔除候选 ${shortAddress(normalized)}？之后不会再出现在默认候选中。`)) return;
  try {
    await fetchJson(`${API_ROOT}/wallets/${encodeURIComponent(normalized)}`, { method: 'DELETE' });
    state.selectedCandidates.delete(normalized);
    state.detailCache.delete(normalized);
    showToast('候选已剔除');
    await loadData({ quiet: true });
  } catch (error) {
    showToast(`剔除失败：${error.message}`, 'error');
  }
}

function walletBatchCount(record, key) {
  const count = finiteNumber(record?.[key], record?.counts?.[key], record?.summary?.[key]);
  return Math.max(0, Math.floor(count ?? 0));
}

function walletBatchInvalidRows(record) {
  for (const candidate of [record?.invalidLines, record?.invalid_lines, record?.errors, record?.invalid]) {
    if (Array.isArray(candidate)) return candidate;
  }
  return Array.isArray(record?.results)
    ? record.results.filter((item) => String(firstValue(item, ['result', 'status', 'outcome'], '')).toLowerCase() === 'invalid')
    : [];
}

function renderWalletBatchFeedback(record) {
  const counts = Object.fromEntries(
    ['created', 'restored', 'updated', 'duplicate', 'invalid'].map((key) => [key, walletBatchCount(record, key)])
  );
  const invalidRows = walletBatchInvalidRows(record);
  const labels = {
    created: '新增',
    restored: '恢复',
    updated: '更新',
    duplicate: '重复',
    invalid: '无效'
  };
  const details = invalidRows.map((item, index) => {
    if (typeof item === 'string') return `<li>${escapeHtml(item)}</li>`;
    const line = finiteNumber(item?.line, item?.lineNumber, item?.line_number) ?? index + 1;
    const value = String(firstValue(item, ['value', 'input', 'text', 'raw', 'address'], '') || '');
    const reason = String(firstValue(item, ['reason', 'message', 'error'], '地址格式无效') || '地址格式无效');
    return `<li><strong>第 ${formatInteger(line)} 行</strong>${value ? `<code>${escapeHtml(value)}</code>` : ''}<span>${escapeHtml(reason)}</span></li>`;
  }).join('');
  elements.manualWalletFeedback.dataset.tone = counts.invalid > 0 ? 'warning' : 'success';
  elements.manualWalletFeedback.hidden = false;
  elements.manualWalletFeedback.innerHTML = `
    <div class="manual-wallet-summary">
      ${Object.entries(labels).map(([key, label]) => `<span data-batch-count="${key}"><strong>${formatInteger(counts[key])}</strong>${label}</span>`).join('')}
    </div>
    ${details ? `<ol class="manual-wallet-invalid-list">${details}</ol>` : ''}
  `;
}

async function addManualWalletBatch(event) {
  event.preventDefault();
  const lines = elements.manualWalletLines.value;
  if (!lines.trim()) {
    elements.manualWalletLines.setCustomValidity('请至少输入一个钱包地址');
    elements.manualWalletLines.reportValidity();
    elements.manualWalletLines.focus();
    return;
  }

  elements.manualWalletLines.setCustomValidity('');
  elements.manualWalletAddButton.disabled = true;
  try {
    const payload = await fetchJson(`${API_ROOT}/wallets/batch`, {
      method: 'POST',
      body: JSON.stringify({ lines })
    });
    const record = unwrapRecord(payload);
    renderWalletBatchFeedback(record);
    elements.manualWalletLines.value = '';
    elements.walletSearch.value = '';
    elements.walletStatus.value = '';
    elements.walletMonitorTier.value = 'all';
    elements.walletTag.value = '';
    state.detailCache.clear();
    const processed = walletBatchCount(record, 'created') + walletBatchCount(record, 'restored') + walletBatchCount(record, 'updated');
    showToast(`批量处理完成：${processed} 个地址已写入`);
    await loadData({ quiet: true });
  } catch (error) {
    elements.manualWalletFeedback.dataset.tone = 'error';
    elements.manualWalletFeedback.textContent = `批量添加失败：${error.message}`;
    elements.manualWalletFeedback.hidden = false;
    showToast(`批量添加失败：${error.message}`, 'error');
  } finally {
    elements.manualWalletAddButton.disabled = false;
  }
}

function openWalletEditor(wallet) {
  const address = normalizeAddress(wallet?.address);
  if (!address) return;
  elements.walletEditorTitle.textContent = address;
  elements.walletEditorAddress.value = address;
  elements.walletEditorAlias.value = wallet.alias || '';
  elements.walletEditorTags.value = Array.isArray(wallet.tags) ? wallet.tags.join(', ') : '';
  elements.walletEditorStatus.value = wallet.status || 'active';
  elements.walletEditorMonitorTier.value = walletMonitorTier(wallet) || 'watch';
  elements.walletEditorClassification.value = wallet.classificationOverride || '';
  renderWalletMonitorRules(firstValue(wallet, ['monitorRules', 'monitor_rules'], {}));
  elements.walletEditorNote.value = wallet.note || '';
  elements.walletEditorExclude.hidden = wallet.status === 'excluded';
  elements.walletEditor.showModal();
  refreshIcons(elements.walletEditor);
}

async function saveWalletEditor(event) {
  event.preventDefault();
  const address = normalizeAddress(elements.walletEditorAddress.value);
  if (!address) return;
  const submit = elements.walletEditorForm.querySelector('button[type="submit"]');
  submit.disabled = true;
  try {
    const payload = await fetchJson(`${API_ROOT}/wallets/${encodeURIComponent(address)}`, {
      method: 'PATCH',
      body: JSON.stringify({
        alias: elements.walletEditorAlias.value.trim(),
        tags: [...new Set(elements.walletEditorTags.value.split(/[,，\n]+/).map((tag) => tag.trim()).filter(Boolean))],
        status: elements.walletEditorStatus.value,
        monitorTier: elements.walletEditorMonitorTier.value,
        classificationOverride: elements.walletEditorClassification.value || null,
        monitorRules: readWalletMonitorRules(),
        note: elements.walletEditorNote.value.trim()
      })
    });
    state.detailCache.set(address, payload);
    elements.walletEditor.close();
    showToast('地址库已更新');
    await loadData({ quiet: true });
    const updatedWallet = walletForAddress(address);
    if (updatedWallet && state.selectedAddress === address) renderWalletDetail(updatedWallet, payload);
  } catch (error) {
    showToast(`保存失败：${error.message}`, 'error');
  } finally {
    submit.disabled = false;
  }
}

async function disableConfirmedWallet(address, { fromEditor = false } = {}) {
  const normalized = normalizeAddress(address);
  if (!normalized) return;
  const wallet = walletForAddress(normalized);
  const label = String(wallet?.alias || shortAddress(normalized));
  if (!window.confirm(`确认从已确认地址库删除并禁用“${label}”？该地址会立即停止实时监控，可在“已排除”筛选中恢复。`)) return;
  if (fromEditor) elements.walletEditorExclude.disabled = true;
  try {
    await fetchJson(`${API_ROOT}/wallets/${encodeURIComponent(normalized)}`, { method: 'DELETE' });
    state.detailCache.delete(normalized);
    if (fromEditor) elements.walletEditor.close();
    showToast('地址已删除并停止监控');
    await loadData({ quiet: true });
  } catch (error) {
    showToast(`删除失败：${error.message}`, 'error');
  } finally {
    if (fromEditor) elements.walletEditorExclude.disabled = false;
  }
}

async function excludeEditedWallet() {
  await disableConfirmedWallet(elements.walletEditorAddress.value, { fromEditor: true });
}

async function copyText(value) {
  const text = String(value || '');
  if (!text) return false;
  try {
    await navigator.clipboard.writeText(text);
    return true;
  } catch {
    let input;
    try {
      input = document.createElement('textarea');
      input.value = text;
      input.setAttribute('readonly', '');
      input.style.position = 'fixed';
      input.style.left = '-9999px';
      document.body.append(input);
      input.select();
      if (typeof document.execCommand !== 'function') return false;
      return document.execCommand('copy') === true;
    } catch {
      return false;
    } finally {
      input?.remove();
    }
  }
}

function showToast(message, tone = 'success') {
  clearTimeout(state.toastTimer);
  elements.toast.textContent = message;
  elements.toast.dataset.tone = tone;
  elements.toast.hidden = false;
  state.toastTimer = setTimeout(() => {
    elements.toast.hidden = true;
  }, 2600);
}

elements.tabs.addEventListener('click', (event) => {
  const button = event.target.closest('[data-tab]');
  if (!button || button.dataset.tab === state.activeTab) return;
  const leavingMonitor = state.activeTab === 'monitor';
  state.activeTab = button.dataset.tab;
  state.selectedCandidates.clear();
  syncToolbarVisibility();
  if (state.activeTab === 'all_round') elements.sort.value = 'name';
  if (leavingMonitor) stopMonitorTransport();
  elements.tabs.querySelectorAll('[data-tab]').forEach((tabButton) => {
    const active = tabButton === button;
    tabButton.classList.toggle('is-active', active);
    tabButton.setAttribute('aria-selected', String(active));
  });
  if (state.activeTab === 'monitor') {
    clearTimeout(state.pollTimer);
    state.pollTimer = null;
    void startMonitorPage();
    return;
  }
  elements.detail.scrollTop = 0;
  void loadData();
});

document.querySelector('#multiple-control').addEventListener('click', (event) => {
  const button = event.target.closest('[data-strategy], [data-multiple]');
  if (!button) return;
  if (button.dataset.strategy === 'smart') {
    state.strategy = 'smart';
    state.multiple = 10;
  } else {
    state.strategy = 'multiple';
    state.multiple = Number(button.dataset.multiple);
  }
  document.querySelectorAll('[data-strategy], [data-multiple]').forEach((candidate) => {
    const active = state.strategy === 'smart'
      ? candidate.dataset.strategy === 'smart'
      : candidate === button;
    candidate.classList.toggle('is-active', active);
    candidate.setAttribute('aria-pressed', String(active));
  });
});

elements.filterForm.addEventListener('submit', (event) => {
  event.preventDefault();
  syncMinimumEntryDisplay({ normalizeInput: true });
  void loadData();
});

elements.minEntryInput.addEventListener('input', () => syncMinimumEntryDisplay());

elements.libraryForm.addEventListener('submit', (event) => {
  event.preventDefault();
  void loadData();
});

elements.walletSearch.addEventListener('input', () => {
  clearTimeout(state.librarySearchTimer);
  state.librarySearchTimer = setTimeout(() => void loadData({ quiet: true }), 260);
});

elements.walletStatus.addEventListener('change', () => void loadData());
elements.walletMonitorTier.addEventListener('change', () => void loadData());
elements.walletTag.addEventListener('change', () => void loadData());
elements.libraryFilterClear.addEventListener('click', () => {
  elements.walletSearch.value = '';
  elements.walletStatus.value = '';
  elements.walletMonitorTier.value = 'all';
  elements.walletTag.value = '';
  void loadData();
});
elements.debotExportButton.addEventListener('click', () => void exportConfirmedWalletsToDebot());
elements.manualWalletForm.addEventListener('submit', addManualWalletBatch);
elements.manualWalletLines.addEventListener('input', () => {
  elements.manualWalletLines.setCustomValidity('');
  elements.manualWalletFeedback.hidden = true;
});

elements.sort.addEventListener('change', () => renderResults());
elements.selectPageCandidates.addEventListener('change', () => {
  for (const wallet of state.visibleWallets) {
    if (!walletIsSelectable(wallet)) continue;
    const address = normalizeAddress(wallet.address);
    if (!address) continue;
    if (elements.selectPageCandidates.checked) state.selectedCandidates.add(address);
    else state.selectedCandidates.delete(address);
  }
  renderResults();
});
elements.confirmSelectedButton.addEventListener('click', () => void confirmSelectedCandidates());
elements.deleteSelectedButton.addEventListener('click', () => void deleteSelectedWallets());
elements.refreshButton.addEventListener('click', () => {
  if (state.activeTab === 'monitor') void startMonitorPage({ manual: true });
  else void loadData();
});
elements.scanButton.addEventListener('click', () => void startScan());
elements.manualForm.addEventListener('submit', addManualWinner);
elements.walletEditorForm.addEventListener('submit', saveWalletEditor);
elements.walletMonitorRules.addEventListener('change', enforceWalletMonitorRuleDependency);
elements.walletEditorClose.addEventListener('click', () => elements.walletEditor.close());
elements.walletEditorExclude.addEventListener('click', () => void excludeEditedWallet());
elements.monitorSettingsForm.addEventListener('submit', saveMonitorSettings);
elements.monitorSoundSettingsForm.addEventListener('submit', saveMonitorSoundSettings);
elements.monitorBarkSettingsForm.addEventListener('submit', saveBarkSoundSettings);
elements.monitorSoundSelect.addEventListener('change', () => {
  state.monitorSound = normalizeMonitorSound(elements.monitorSoundSelect.value);
});
elements.monitorVolume.addEventListener('input', () => {
  state.monitorVolume = clampMonitorVolume(elements.monitorVolume.value, state.monitorVolume);
  elements.monitorVolumeOutput.textContent = `${state.monitorVolume}%`;
});
elements.monitorBarkSoundSelect.addEventListener('change', () => {
  state.monitorBarkSound = elements.monitorBarkSoundSelect.value;
});
elements.monitorBarkVolume.addEventListener('input', () => {
  state.monitorBarkVolume = clampBarkVolume(elements.monitorBarkVolume.value, state.monitorBarkVolume);
  elements.monitorBarkVolumeOutput.textContent = `${state.monitorBarkVolume} / 10`;
});
elements.monitorSoundButton.addEventListener('click', () => void enableAndPreviewMonitorSound());
elements.monitorMuteButton.addEventListener('click', muteMonitorSound);
elements.monitorRefreshButton.addEventListener('click', () => void startMonitorPage({ manual: true }));
elements.monitorBarkForm.addEventListener('submit', createBarkTarget);
elements.monitorBarkList.addEventListener('click', (event) => {
  const button = event.target.closest('[data-bark-action]');
  if (button) void runBarkAction(button);
});

elements.results.addEventListener('click', (event) => {
  if (event.target.closest('[data-candidate-select], .debot-link')) return;
  const retry = event.target.closest('[data-retry]');
  if (retry) {
    void loadData();
    return;
  }
  const rescanButton = event.target.closest('[data-rescan-winner]');
  if (rescanButton) {
    event.stopPropagation();
    void rescanWinner(rescanButton.dataset.rescanWinner);
    return;
  }
  const confirmButton = event.target.closest('[data-confirm-candidate]');
  if (confirmButton) {
    event.stopPropagation();
    void confirmCandidate(confirmButton.dataset.confirmCandidate);
    return;
  }
  const excludeButton = event.target.closest('[data-exclude-candidate]');
  if (excludeButton) {
    event.stopPropagation();
    void excludeCandidate(excludeButton.dataset.excludeCandidate);
    return;
  }
  const disableButton = event.target.closest('[data-disable-wallet]');
  if (disableButton) {
    event.stopPropagation();
    void disableConfirmedWallet(disableButton.dataset.disableWallet);
    return;
  }
  const copyButton = event.target.closest('[data-copy]');
  if (copyButton) {
    event.stopPropagation();
    void copyText(copyButton.dataset.copy).then((copied) => showToast(copied ? '已复制' : '复制失败', copied ? 'success' : 'error'));
    return;
  }
  const editButton = event.target.closest('[data-edit-wallet]');
  if (editButton) {
    event.stopPropagation();
    const wallet = walletForAddress(editButton.dataset.editWallet);
    if (wallet) openWalletEditor(wallet);
    return;
  }
  const walletButton = event.target.closest('[data-select-wallet]');
  const walletRow = event.target.closest('[data-address]');
  const address = normalizeAddress(walletButton?.dataset.selectWallet || walletRow?.dataset.address);
  if (address) {
    const wallet = state.visibleWallets.find((candidate) => normalizeAddress(candidate.address) === address);
    if (wallet) {
      void loadWalletDetail(wallet);
      scrollDetailOnMobile();
    }
    return;
  }
  const tokenButton = event.target.closest('[data-select-token]');
  const tokenRow = event.target.closest('[data-token-address]');
  const tokenAddress = normalizeAddress(tokenButton?.dataset.selectToken || tokenRow?.dataset.tokenAddress);
  if (tokenAddress) {
    const winner = state.data?.winners.find((candidate) => normalizeAddress(candidate.address) === tokenAddress);
    if (winner) {
      state.selectedWinnerAddress = tokenAddress;
      renderResultsSelection();
      renderWinnerDetail(winner);
      scrollDetailOnMobile();
    }
  }
});

elements.results.addEventListener('change', (event) => {
  const checkbox = event.target.closest('[data-candidate-select]');
  if (!checkbox) return;
  const address = normalizeAddress(checkbox.dataset.candidateSelect);
  if (!address) return;
  if (checkbox.checked) state.selectedCandidates.add(address);
  else state.selectedCandidates.delete(address);
  syncCandidateActions();
});

elements.detail.addEventListener('click', (event) => {
  if (event.target.closest('.debot-link')) return;
  const rescanButton = event.target.closest('[data-rescan-winner]');
  if (rescanButton) {
    void rescanWinner(rescanButton.dataset.rescanWinner);
    return;
  }
  const confirmButton = event.target.closest('[data-confirm-candidate]');
  if (confirmButton) {
    void confirmCandidate(confirmButton.dataset.confirmCandidate);
    return;
  }
  const excludeButton = event.target.closest('[data-exclude-candidate]');
  if (excludeButton) {
    void excludeCandidate(excludeButton.dataset.excludeCandidate);
    return;
  }
  const disableButton = event.target.closest('[data-disable-wallet]');
  if (disableButton) {
    void disableConfirmedWallet(disableButton.dataset.disableWallet);
    return;
  }
  const editButton = event.target.closest('[data-edit-wallet]');
  if (editButton) {
    const wallet = walletForAddress(editButton.dataset.editWallet);
    if (wallet) openWalletEditor(wallet);
    return;
  }
  const copyButton = event.target.closest('[data-copy]');
  if (!copyButton) return;
  void copyText(copyButton.dataset.copy).then((copied) => showToast(copied ? '已复制' : '复制失败', copied ? 'success' : 'error'));
});

elements.results.addEventListener('error', (event) => {
  if (!(event.target instanceof HTMLImageElement)) return;
  event.target.hidden = true;
  const fallback = event.target.nextElementSibling;
  if (fallback) fallback.hidden = false;
}, true);

elements.detail.addEventListener('error', (event) => {
  if (!(event.target instanceof HTMLImageElement)) return;
  event.target.hidden = true;
  const fallback = event.target.nextElementSibling;
  if (fallback) fallback.hidden = false;
}, true);

window.addEventListener('hashchange', () => {
  const address = normalizeAddress(window.location.hash.slice(1));
  if (!address || ['winners', 'monitor'].includes(state.activeTab)) return;
  const wallet = state.visibleWallets.find((candidate) => normalizeAddress(candidate.address) === address);
  if (wallet) void loadWalletDetail(wallet);
});

window.addEventListener('pagehide', stopMonitorTransport);

const initialAddress = normalizeAddress(window.location.hash.slice(1));
if (initialAddress) state.selectedAddress = initialAddress;
state.monitorThreshold = readStoredMonitorThreshold();
syncToolbarVisibility();
refreshIcons();
void loadData();
