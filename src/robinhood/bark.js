const OFFICIAL_BARK_ORIGIN = 'https://api.day.app';
const DEVICE_KEY_PATTERN = /^[A-Za-z0-9_-]{4,256}$/;
export const BARK_SOUNDS = new Set([
  'alarm', 'anticipate', 'bell', 'birdsong', 'bloom', 'calypso', 'chime',
  'choo', 'descent', 'electronic', 'fanfare', 'glass', 'gotosleep', 'healthnotification',
  'horn', 'ladder', 'mailsent', 'minuet', 'multiwayinvitation', 'newmail', 'newsflash',
  'noir', 'paymentsuccess', 'shake', 'sherwoodforest', 'silence', 'spell', 'suspense',
  'telegraph', 'tiptoes', 'typewriters', 'update'
]);

export const BARK_FEATURES = Object.freeze([
  { id: 'wallet_buy', group: '链上流水', label: '钱包买入' },
  { id: 'wallet_sell', group: '链上流水', label: '钱包卖出' },
  { id: 'wallet_transfer', group: '链上流水', label: '钱包转出' },
  { id: 'token_create', group: '链上流水', label: '钱包发币' },
  { id: 'cluster_buy', group: '链上流水', label: '集合买入' },
  { id: 'telegram_ca', group: '群聊监控', label: 'Telegram CA' },
  { id: 'feishu_ca', group: '群聊监控', label: '飞书 CA' },
  { id: 'twitter_ca', group: '社媒监控', label: 'X 账号 CA' },
  { id: 'telegram_social_ca', group: '社媒监控', label: 'Telegram 频道 CA' },
  { id: 'fomo_ca', group: '社媒监控', label: 'FOMO CA' },
  { id: 'other_social_ca', group: '社媒监控', label: '其他社媒 CA' }
]);

const BARK_FEATURE_IDS = new Set(BARK_FEATURES.map((feature) => feature.id));

function unixSeconds(now) {
  return Math.floor(now() / 1000);
}

function cleanLabel(value, fallback = 'Bark') {
  return String(value || '')
    .replace(/[\u0000-\u001f\u007f]/g, '')
    .trim()
    .slice(0, 40) || fallback;
}

function errorMessage(error) {
  return error instanceof Error ? error.message : String(error);
}

function targetId(value) {
  const id = Number(value);
  if (!Number.isSafeInteger(id) || id < 1) throw new TypeError('Invalid Bark target id');
  return id;
}

export function normalizeBarkEndpoint(value) {
  const input = String(value || '').trim();
  if (!input || input.length > 500) throw new TypeError('Bark API is required');
  let key = input;
  if (/^https?:\/\//i.test(input)) {
    let url;
    try {
      url = new URL(input);
    } catch {
      throw new TypeError('Invalid Bark API URL');
    }
    if (url.protocol !== 'https:' || url.hostname !== 'api.day.app' || (url.port && url.port !== '443')) {
      throw new TypeError('Only the official https://api.day.app Bark API is supported');
    }
    if (url.username || url.password || url.hash) throw new TypeError('Invalid Bark API URL');
    const segments = url.pathname.split('/').filter(Boolean);
    key = segments[0] || '';
  }
  try {
    key = decodeURIComponent(key);
  } catch {
    throw new TypeError('Invalid Bark device key');
  }
  if (!DEVICE_KEY_PATTERN.test(key)) throw new TypeError('Invalid Bark device key');
  return `${OFFICIAL_BARK_ORIGIN}/${encodeURIComponent(key)}`;
}

export function maskBarkEndpoint(endpoint) {
  const normalized = normalizeBarkEndpoint(endpoint);
  const key = decodeURIComponent(new URL(normalized).pathname.slice(1));
  const visible = key.length <= 8
    ? `${key.slice(0, 2)}***${key.slice(-2)}`
    : `${key.slice(0, 4)}***${key.slice(-4)}`;
  return `${OFFICIAL_BARK_ORIGIN}/${visible}`;
}

function publicTarget(target) {
  if (!target) return null;
  return {
    id: Number(target.id),
    label: cleanLabel(target.label),
    endpointMasked: maskBarkEndpoint(target.endpoint),
    enabled: target.enabled !== false,
    createdAt: target.createdAt,
    updatedAt: target.updatedAt,
    lastSuccessAt: target.lastSuccessAt,
    lastErrorAt: target.lastErrorAt,
    lastError: String(target.lastError || '')
  };
}

function normalizeBarkVolume(value, fallback = 5) {
  const volume = Number(value);
  return Number.isFinite(volume) && volume >= 0 && volume <= 10 ? volume : fallback;
}

function formatAlertWindow(value) {
  const seconds = Number(value);
  const normalized = Number.isInteger(seconds) && seconds >= 5 && seconds <= 3_600 ? seconds : 60;
  return normalized % 60 === 0 ? `${normalized / 60} 分钟` : `${normalized} 秒`;
}

function shortAddress(value) {
  const address = String(value || '');
  return /^0x[0-9a-f]{40}$/i.test(address)
    ? `${address.slice(0, 6)}...${address.slice(-4)}`
    : address;
}

function walletEventMessage(event) {
  const labels = {
    buy: '买入',
    sell: '卖出',
    transfer: '转出',
    token_create: '发币'
  };
  const eventType = labels[event?.eventType] ? event.eventType : 'buy';
  const label = labels[eventType];
  const wallet = String(event?.walletAlias || '').trim() || shortAddress(event?.walletAddress);
  const symbol = String(event?.tokenSymbol || (event?.assetType === 'native' ? 'ETH' : 'TOKEN'));
  if (eventType === 'token_create') {
    const platform = {
      noxa: 'Noxa',
      four_meme: 'Four.meme',
      direct: '直接部署'
    }[event?.platform] || '发币平台';
    return {
      title: `${wallet} 发币`,
      body: `${wallet} 通过${platform}创建 ${symbol}（${shortAddress(event?.tokenAddress)}）`
    };
  }
  const amount = String(event?.tokenAmount || '0');
  const recipient = eventType === 'transfer' && event?.counterpartyAddress
    ? `，接收方 ${shortAddress(event.counterpartyAddress)}`
    : '';
  return {
    title: `${wallet} ${label} ${symbol}`,
    body: `${wallet} ${label} ${amount} ${symbol}${recipient}`
  };
}

function notificationUrl(
  endpoint,
  { title, body, sound = 'alarm', volume = 5, url = '', group = 'Robinhood 聪明钱' } = {}
) {
  const base = normalizeBarkEndpoint(endpoint);
  const request = new URL(`${base}/${encodeURIComponent(String(title || 'Robinhood 聪明钱提醒'))}/${encodeURIComponent(String(body || '监控地址出现集合买入'))}`);
  request.searchParams.set('group', String(group || 'Robinhood 聪明钱'));
  request.searchParams.set('sound', BARK_SOUNDS.has(sound) ? sound : 'alarm');
  const barkVolume = normalizeBarkVolume(volume);
  request.searchParams.set('level', 'critical');
  request.searchParams.set('volume', String(barkVolume));
  if (url) request.searchParams.set('url', String(url));
  return request;
}

export class RobinhoodBarkNotifier {
  constructor({
    store,
    fetchImpl = fetch,
    timeoutMs = 10_000,
    now = Date.now,
    brand = 'Robinhood'
  } = {}) {
    if (!store?.listMonitorBarkTargets || !store?.createMonitorBarkTarget) {
      throw new TypeError('A Bark target store is required');
    }
    if (typeof fetchImpl !== 'function') throw new TypeError('A fetch implementation is required');
    this.store = store;
    this.fetch = fetchImpl;
    this.timeoutMs = Math.max(1_000, Math.min(30_000, Number(timeoutMs) || 10_000));
    this.now = now;
    this.brand = cleanLabel(brand, 'Robinhood');
  }

  listTargets() {
    return this.store.listMonitorBarkTargets().map(publicTarget);
  }

  listFeatures() {
    const states = this.store.listMonitorBarkFeatureStates?.() || {};
    return BARK_FEATURES.map((feature) => ({
      ...feature,
      enabled: states[feature.id] !== false
    }));
  }

  updateFeature(featureId, enabled) {
    const id = String(featureId || '').trim();
    if (!BARK_FEATURE_IDS.has(id)) throw new TypeError('Unknown Bark feature');
    if (typeof enabled !== 'boolean') throw new TypeError('enabled must be a boolean');
    if (!this.store.setMonitorBarkFeatureState) throw new Error('Bark feature settings are unavailable');
    this.store.setMonitorBarkFeatureState(id, enabled);
    return this.listFeatures().find((feature) => feature.id === id);
  }

  createTarget({ endpoint, label, enabled = true } = {}) {
    if (typeof enabled !== 'boolean') throw new TypeError('enabled must be a boolean');
    const normalizedEndpoint = normalizeBarkEndpoint(endpoint);
    const duplicate = this.store.listMonitorBarkTargets().find((target) => target.endpoint === normalizedEndpoint);
    if (duplicate) throw new TypeError('This Bark API has already been added');
    return publicTarget(this.store.createMonitorBarkTarget({
      endpoint: normalizedEndpoint,
      label: cleanLabel(label),
      enabled,
      createdAt: unixSeconds(this.now),
      updatedAt: unixSeconds(this.now)
    }));
  }

  updateTarget(id, patch = {}) {
    const normalizedId = targetId(id);
    const existing = this.store.getMonitorBarkTarget(normalizedId);
    if (!existing) return null;
    const next = {};
    if (Object.hasOwn(patch, 'enabled')) {
      if (typeof patch.enabled !== 'boolean') throw new TypeError('enabled must be a boolean');
      next.enabled = patch.enabled;
    }
    if (Object.hasOwn(patch, 'label')) next.label = cleanLabel(patch.label);
    next.updatedAt = unixSeconds(this.now);
    return publicTarget(this.store.updateMonitorBarkTarget(normalizedId, next));
  }

  deleteTarget(id) {
    return this.store.deleteMonitorBarkTarget(targetId(id));
  }

  async testTarget(id, { sound = 'alarm', volume = 5 } = {}) {
    const target = this.store.getMonitorBarkTarget(targetId(id));
    if (!target) return null;
    await this.#send(target, {
      title: `${this.brand} 聪明钱雷达`,
      body: 'Bark 推送测试成功',
      sound,
      volume
    });
    return publicTarget(this.store.getMonitorBarkTarget(target.id));
  }

  async notifyAlert({ cluster, threshold, windowSeconds = 60, sound = 'alarm', volume = 5 } = {}) {
    if (!this.#featureEnabled('cluster_buy')) return { attempted: 0, sent: 0, failed: 0 };
    const targets = this.store.listMonitorBarkTargets().filter((target) => target.enabled);
    if (!targets.length) return { attempted: 0, sent: 0, failed: 0 };
    const symbol = String(cluster?.tokenSymbol || 'TOKEN');
    const walletCount = Number(cluster?.distinctWallets ?? cluster?.walletCount ?? 0);
    const aliases = (Array.isArray(cluster?.wallets) ? cluster.wallets : [])
      .slice(0, 3)
      .map((wallet) => wallet.alias || `${wallet.address.slice(0, 6)}...${wallet.address.slice(-4)}`)
      .join('、');
    const body = `${walletCount} 个监控地址在 ${formatAlertWindow(windowSeconds)}内买入 ${symbol}${aliases ? `：${aliases}` : ''}（阈值 ${threshold}）`;
    const results = await Promise.allSettled(targets.map((target) => this.#send(target, {
      title: `集合买入：${symbol}`,
      body,
      sound,
      volume,
      url: cluster?.debotTokenUrl || ''
    })));
    return {
      attempted: targets.length,
      sent: results.filter((result) => result.status === 'fulfilled').length,
      failed: results.filter((result) => result.status === 'rejected').length
    };
  }

  async notifyWalletEvent({ event, sound = 'alarm', volume = 5 } = {}) {
    const featureId = {
      buy: 'wallet_buy',
      sell: 'wallet_sell',
      transfer: 'wallet_transfer',
      token_create: 'token_create'
    }[event?.eventType] || 'wallet_buy';
    if (!this.#featureEnabled(featureId)) return { attempted: 0, sent: 0, failed: 0 };
    const targets = this.store.listMonitorBarkTargets().filter((target) => target.enabled);
    if (!targets.length) return { attempted: 0, sent: 0, failed: 0 };
    const message = walletEventMessage(event);
    const eventUrl = event?.eventType === 'buy'
      ? event?.debotTokenUrl || event?.explorerTxUrl || ''
      : event?.explorerTxUrl || '';
    const results = await Promise.allSettled(targets.map((target) => this.#send(target, {
      ...message,
      sound,
      volume,
      url: eventUrl
    })));
    return {
      attempted: targets.length,
      sent: results.filter((result) => result.status === 'fulfilled').length,
      failed: results.filter((result) => result.status === 'rejected').length
    };
  }

  async notifyTelegramMessage({
    senderName = 'Telegram',
    chatName = 'Telegram',
    text = '',
    contractAddresses = [],
    contractChains = [],
    debotUrls = [],
    messageUrl = '',
    sound = 'alarm',
    volume = 5
  } = {}) {
    if (!this.#featureEnabled('telegram_ca')) return { attempted: 0, sent: 0, failed: 0 };
    const targets = this.store.listMonitorBarkTargets().filter((target) => target.enabled);
    if (!targets.length) return { attempted: 0, sent: 0, failed: 0 };
    const addresses = [...new Set(
      (Array.isArray(contractAddresses) ? contractAddresses : [])
        .map((address) => String(address || '').trim())
        .filter(Boolean)
    )].slice(0, 8);
    const normalizedSender = cleanLabel(senderName, 'Telegram');
    const normalizedChat = cleanLabel(chatName, 'Telegram');
    const normalizedText = String(text || '').replace(/\s+/g, ' ').trim();
    const chainLabels = {
      robinhood: 'Robinhood',
      bsc: 'BSC',
      base: 'Base',
      solana: 'Solana',
      multiple: '多链待确认',
      unknown: '链待确认'
    };
    const normalizedChains = addresses.map((_, index) => {
      const value = Array.isArray(contractChains) ? contractChains[index] : '';
      const chain = String(value || '').toLowerCase();
      return chainLabels[chain] ? chain : 'unknown';
    });
    const addressSummary = addresses.map((address, index) => (
      `${chainLabels[normalizedChains[index]]}：${address}`
    )).join('\n');
    const normalizedDebotUrls = [...new Set(
      (Array.isArray(debotUrls) ? debotUrls : [])
        .map((url) => String(url || '').trim())
        .filter((url) => /^https:\/\/debot\.ai\/token\//i.test(url))
    )].slice(0, 8);
    const textSummary = normalizedText.length > 220
      ? `${normalizedText.slice(0, 219).trimEnd()}...`
      : normalizedText;
    const sourceLink = messageUrl ? `来源：${String(messageUrl).trim()}` : '';
    const body = [normalizedChat, addressSummary, ...normalizedDebotUrls, sourceLink, textSummary]
      .filter(Boolean)
      .join('\n');
    const results = await Promise.allSettled(targets.map((target) => this.#send(target, {
      title: `Telegram CA：${normalizedSender}`,
      body: body || '检测到新的合约地址',
      sound,
      volume,
      url: normalizedDebotUrls[0] || String(messageUrl || ''),
      group: 'Telegram CA 监控'
    })));
    return {
      attempted: targets.length,
      sent: results.filter((result) => result.status === 'fulfilled').length,
      failed: results.filter((result) => result.status === 'rejected').length
    };
  }

  async notifyFeishuMessage({
    personName = '飞书',
    sourceName = '飞书实时群聊',
    text = '',
    contractAddresses = [],
    contractChains = [],
    debotUrls = [],
    messageUrl = '',
    sound = 'alarm',
    volume = 5
  } = {}) {
    if (!this.#featureEnabled('feishu_ca')) return { attempted: 0, sent: 0, failed: 0 };
    const targets = this.store.listMonitorBarkTargets().filter((target) => target.enabled);
    if (!targets.length) return { attempted: 0, sent: 0, failed: 0 };
    const addresses = [...new Set(
      (Array.isArray(contractAddresses) ? contractAddresses : [])
        .map((address) => String(address || '').trim())
        .filter(Boolean)
    )].slice(0, 8);
    if (!addresses.length) return { attempted: 0, sent: 0, failed: 0 };
    const chainLabels = {
      robinhood: 'Robinhood',
      bsc: 'BSC',
      base: 'Base',
      solana: 'Solana',
      multiple: '多链待确认',
      unknown: '链待确认'
    };
    const normalizedChains = addresses.map((_, index) => {
      const chain = String(Array.isArray(contractChains) ? contractChains[index] : '').toLowerCase();
      return chainLabels[chain] ? chain : 'unknown';
    });
    const addressSummary = addresses.map((address, index) => (
      `${chainLabels[normalizedChains[index]]}：${address}`
    )).join('\n');
    const normalizedDebotUrls = [...new Set(
      (Array.isArray(debotUrls) ? debotUrls : [])
        .map((url) => String(url || '').trim())
        .filter((url) => /^https:\/\/debot\.ai\/token\//i.test(url))
    )].slice(0, 8);
    const normalizedText = String(text || '').replace(/\s+/g, ' ').trim();
    const textSummary = normalizedText.length > 220
      ? `${normalizedText.slice(0, 219).trimEnd()}...`
      : normalizedText;
    const source = cleanLabel(sourceName, '飞书实时群聊');
    const person = cleanLabel(personName, '飞书');
    const sourceLink = messageUrl ? `来源：${String(messageUrl).trim()}` : '';
    const body = [source, addressSummary, ...normalizedDebotUrls, sourceLink, textSummary]
      .filter(Boolean)
      .join('\n');
    const results = await Promise.allSettled(targets.map((target) => this.#send(target, {
      title: `飞书 CA：${person}`,
      body,
      sound,
      volume,
      url: normalizedDebotUrls[0] || String(messageUrl || ''),
      group: '飞书 CA 监控'
    })));
    return {
      attempted: targets.length,
      sent: results.filter((result) => result.status === 'fulfilled').length,
      failed: results.filter((result) => result.status === 'rejected').length
    };
  }

  // Social sources (Twitter/X and Telegram) share the same Bark target
  // library, but use a distinct notification group so they can be filtered
  // independently in Bark clients.
  async notifySocialContract({
    platform = '社媒',
    authorName = '',
    authorHandle = '',
    sourceName = '',
    text = '',
    contractAddresses = [],
    messageUrl = '',
    sound = 'alarm',
    volume = 5
  } = {}) {
    const normalizedPlatform = String(platform || '').trim().toLowerCase();
    const featureId = normalizedPlatform === 'fomo'
      ? 'fomo_ca'
      : ['twitter', 'x'].includes(normalizedPlatform)
        ? 'twitter_ca'
        : normalizedPlatform === 'telegram'
          ? 'telegram_social_ca'
          : 'other_social_ca';
    if (!this.#featureEnabled(featureId)) return { attempted: 0, sent: 0, failed: 0 };
    const targets = this.store.listMonitorBarkTargets().filter((target) => target.enabled);
    if (!targets.length) return { attempted: 0, sent: 0, failed: 0 };
    const addresses = [...new Set(
      (Array.isArray(contractAddresses) ? contractAddresses : [])
        .map((item) => typeof item === 'object' ? item.address : item)
        .map((address) => String(address || '').trim())
        .filter(Boolean)
    )].slice(0, 8);
    if (!addresses.length) return { attempted: 0, sent: 0, failed: 0 };
    const source = cleanLabel(sourceName || platform, platform);
    const author = cleanLabel(authorName || (authorHandle ? `@${authorHandle}` : platform), platform);
    const normalizedText = String(text || '').replace(/\s+/g, ' ').trim();
    const textSummary = normalizedText.length > 220
      ? `${normalizedText.slice(0, 219).trimEnd()}...`
      : normalizedText;
    const body = [source, addresses.join(' · '), textSummary].filter(Boolean).join('\n');
    const results = await Promise.allSettled(targets.map((target) => this.#send(target, {
      title: `${source} CA：${author}`,
      body: body || '检测到新的合约地址',
      sound,
      volume,
      url: String(messageUrl || ''),
      group: '社媒 CA 监控'
    })));
    return {
      attempted: targets.length,
      sent: results.filter((result) => result.status === 'fulfilled').length,
      failed: results.filter((result) => result.status === 'rejected').length
    };
  }

  async #send(target, payload) {
    try {
      const response = await this.fetch(notificationUrl(target.endpoint, {
        ...payload,
        group: payload.group || `${this.brand} 聪明钱`
      }), {
        method: 'GET',
        headers: { accept: 'application/json' },
        signal: AbortSignal.timeout(this.timeoutMs)
      });
      const text = await response.text();
      let parsed = null;
      try {
        parsed = text ? JSON.parse(text) : null;
      } catch {
        parsed = null;
      }
      if (!response.ok || parsed?.code !== undefined && Number(parsed.code) !== 200) {
        throw new Error(`Bark request failed (${response.status})`);
      }
      this.store.updateMonitorBarkTarget(target.id, {
        lastSuccessAt: unixSeconds(this.now),
        lastErrorAt: null,
        lastError: '',
        updatedAt: unixSeconds(this.now)
      });
      return true;
    } catch (error) {
      this.store.updateMonitorBarkTarget(target.id, {
        lastErrorAt: unixSeconds(this.now),
        lastError: errorMessage(error).slice(0, 300),
        updatedAt: unixSeconds(this.now)
      });
      throw error;
    }
  }

  #featureEnabled(featureId) {
    return (this.store.listMonitorBarkFeatureStates?.() || {})[featureId] !== false;
  }
}

export function createRobinhoodBarkNotifier(options) {
  return new RobinhoodBarkNotifier(options);
}
