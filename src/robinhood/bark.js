const OFFICIAL_BARK_ORIGIN = 'https://api.day.app';
const DEVICE_KEY_PATTERN = /^[A-Za-z0-9_-]{4,256}$/;
export const BARK_SOUNDS = new Set([
  'alarm', 'anticipate', 'bell', 'birdsong', 'bloom', 'calypso', 'chime',
  'choo', 'descent', 'electronic', 'fanfare', 'glass', 'gotosleep', 'healthnotification',
  'horn', 'ladder', 'mailsent', 'minuet', 'multiwayinvitation', 'newmail', 'newsflash',
  'noir', 'paymentsuccess', 'shake', 'sherwoodforest', 'silence', 'spell', 'suspense',
  'telegraph', 'tiptoes', 'typewriters', 'update'
]);

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
    const platform = event?.platform === 'noxa' ? 'Noxa' : '直接部署';
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

function notificationUrl(endpoint, { title, body, sound = 'alarm', volume = 5, url = '' } = {}) {
  const base = normalizeBarkEndpoint(endpoint);
  const request = new URL(`${base}/${encodeURIComponent(String(title || 'Robinhood 聪明钱提醒'))}/${encodeURIComponent(String(body || '监控地址出现集合买入'))}`);
  request.searchParams.set('group', 'Robinhood 聪明钱');
  request.searchParams.set('sound', BARK_SOUNDS.has(sound) ? sound : 'alarm');
  const barkVolume = normalizeBarkVolume(volume);
  request.searchParams.set('level', 'critical');
  request.searchParams.set('volume', String(barkVolume));
  if (url) request.searchParams.set('url', String(url));
  return request;
}

export class RobinhoodBarkNotifier {
  constructor({ store, fetchImpl = fetch, timeoutMs = 10_000, now = Date.now } = {}) {
    if (!store?.listMonitorBarkTargets || !store?.createMonitorBarkTarget) {
      throw new TypeError('A Bark target store is required');
    }
    if (typeof fetchImpl !== 'function') throw new TypeError('A fetch implementation is required');
    this.store = store;
    this.fetch = fetchImpl;
    this.timeoutMs = Math.max(1_000, Math.min(30_000, Number(timeoutMs) || 10_000));
    this.now = now;
  }

  listTargets() {
    return this.store.listMonitorBarkTargets().map(publicTarget);
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
      title: 'Robinhood 聪明钱雷达',
      body: 'Bark 推送测试成功',
      sound,
      volume
    });
    return publicTarget(this.store.getMonitorBarkTarget(target.id));
  }

  async notifyAlert({ cluster, threshold, windowSeconds = 60, sound = 'alarm', volume = 5 } = {}) {
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
    const targets = this.store.listMonitorBarkTargets().filter((target) => target.enabled);
    if (!targets.length) return { attempted: 0, sent: 0, failed: 0 };
    const message = walletEventMessage(event);
    const results = await Promise.allSettled(targets.map((target) => this.#send(target, {
      ...message,
      sound,
      volume,
      url: event?.explorerTxUrl || ''
    })));
    return {
      attempted: targets.length,
      sent: results.filter((result) => result.status === 'fulfilled').length,
      failed: results.filter((result) => result.status === 'rejected').length
    };
  }

  async #send(target, payload) {
    try {
      const response = await this.fetch(notificationUrl(target.endpoint, payload), {
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
}

export function createRobinhoodBarkNotifier(options) {
  return new RobinhoodBarkNotifier(options);
}
