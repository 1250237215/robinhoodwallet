import { createHash } from 'node:crypto';

import { normalizeSolanaAddress } from './address.js';

const HELIUS_WEBHOOK_ROOT = 'https://mainnet.helius-rpc.com/v0/webhooks';
const WEBHOOK_ID_KEY = 'solana:helius:webhook-id';
const WEBHOOK_HASH_KEY = 'solana:helius:webhook-address-hash';
const WEBHOOK_ID_PATTERN = /^[A-Za-z0-9_-]{1,200}$/;

function cleanWebhookId(value) {
  const id = String(value || '').trim();
  return WEBHOOK_ID_PATTERN.test(id) ? id : '';
}

function normalizedAddresses(values) {
  const addresses = [];
  for (const value of values || []) {
    try {
      addresses.push(normalizeSolanaAddress(value?.address || value));
    } catch {
      // Invalid annotations stay out of the provider subscription.
    }
  }
  return [...new Set(addresses)].sort();
}

function normalizedTransactionTypes(value) {
  const types = Array.isArray(value) ? value.map(String).sort() : [];
  return types.length === 0 || types.includes('ANY') ? [] : types;
}

function sameAddresses(left, right) {
  const a = normalizedAddresses(left);
  const b = normalizedAddresses(right);
  return a.length === b.length && a.every((address, index) => address === b[index]);
}

function desiredHash({ webhookUrl, authHeader, addresses }) {
  return createHash('sha256').update(JSON.stringify({
    webhookUrl,
    authHeader,
    addresses
  })).digest('hex');
}

function redact(value, secrets) {
  let message = String(value || 'Helius webhook request failed');
  for (const secret of secrets) {
    if (!secret) continue;
    message = message.split(secret).join('[redacted]');
    try {
      message = message.split(encodeURIComponent(secret)).join('[redacted]');
    } catch {
      // The unencoded replacement above still applies.
    }
  }
  return message
    .replace(/([?&]api-key=)[^\s&]+/gi, '$1[redacted]')
    .replace(/(authorization\s*[:=]\s*)[^\s,;]+/gi, '$1[redacted]')
    .slice(0, 300);
}

export class HeliusWebhookManagerError extends Error {
  constructor(message, { operation = 'sync', status = null } = {}) {
    super(message);
    this.name = 'HeliusWebhookManagerError';
    this.operation = operation;
    this.status = status;
  }
}

export class HeliusWebhookManager {
  constructor({
    store,
    apiKey = '',
    webhookUrl = '',
    authHeader = '',
    addressProvider = () => [],
    fetchImpl = globalThis.fetch,
    timeoutMs = 15_000,
    syncIntervalMs = 30_000,
    setIntervalImpl = setInterval,
    clearIntervalImpl = clearInterval,
    now = Date.now
  } = {}) {
    if (!store?.getMeta || !store?.setMeta) throw new TypeError('A metadata store is required');
    if (typeof addressProvider !== 'function') throw new TypeError('addressProvider must be a function');
    if (typeof fetchImpl !== 'function') throw new TypeError('fetchImpl must be a function');
    this.store = store;
    this.apiKey = String(apiKey || '');
    this.webhookUrl = String(webhookUrl || '');
    this.authHeader = String(authHeader || '');
    this.addressProvider = addressProvider;
    this.fetch = fetchImpl;
    this.timeoutMs = Math.max(1_000, Math.min(60_000, Number(timeoutMs) || 15_000));
    this.syncIntervalMs = Math.max(1_000, Math.min(10 * 60_000, Number(syncIntervalMs) || 30_000));
    this.setInterval = setIntervalImpl;
    this.clearInterval = clearIntervalImpl;
    this.now = now;
    this.started = false;
    this.timer = null;
    this.syncPromise = null;
    this.synced = false;
    this.lastError = '';
    this.lastSyncedAt = null;
    this.syncedAddressHash = '';
    this.syncedAddressCount = 0;
    this.webhookId = cleanWebhookId(store.getMeta(WEBHOOK_ID_KEY));
  }

  getHealth() {
    const addresses = normalizedAddresses(this.addressProvider());
    const hash = desiredHash({
      webhookUrl: this.webhookUrl,
      authHeader: this.authHeader,
      addresses
    });
    const reasons = [];
    if (!this.apiKey) reasons.push('helius_api_key_missing');
    if (!/^https:\/\//i.test(this.webhookUrl)) reasons.push('https_webhook_url_missing');
    if (!this.authHeader) reasons.push('webhook_auth_header_missing');
    if (this.lastError) reasons.push('helius_webhook_sync_error');
    if (!this.synced) reasons.push('helius_webhook_not_synced');
    else if (hash !== this.syncedAddressHash) reasons.push('helius_wallet_addresses_pending_sync');
    const realtimeReady = reasons.length === 0;
    return {
      configured: Boolean(this.apiKey && /^https:\/\//i.test(this.webhookUrl) && this.authHeader),
      synced: this.synced && hash === this.syncedAddressHash,
      syncing: Boolean(this.syncPromise),
      realtimeReady,
      status: realtimeReady ? 'healthy' : 'degraded',
      reasons,
      webhookIdPresent: Boolean(this.webhookId),
      desiredAddressCount: addresses.length,
      syncedAddressCount: this.syncedAddressCount,
      lastSyncedAt: this.lastSyncedAt,
      lastError: this.lastError
    };
  }

  async start() {
    if (this.started) return this.syncPromise || this.getHealth();
    this.started = true;
    this.timer = this.setInterval(() => {
      void this.syncNow().catch(() => {});
    }, this.syncIntervalMs);
    this.timer?.unref?.();
    await this.syncNow({ force: true });
    return this.getHealth();
  }

  close() {
    this.started = false;
    if (this.timer) this.clearInterval(this.timer);
    this.timer = null;
  }

  syncNow({ force = false } = {}) {
    if (this.syncPromise) return this.syncPromise;
    this.syncPromise = this.#sync(force).finally(() => {
      this.syncPromise = null;
    });
    return this.syncPromise;
  }

  async #sync(force) {
    const addresses = normalizedAddresses(await this.addressProvider());
    const hash = desiredHash({
      webhookUrl: this.webhookUrl,
      authHeader: this.authHeader,
      addresses
    });
    if (!this.apiKey || !/^https:\/\//i.test(this.webhookUrl) || !this.authHeader) {
      this.synced = false;
      this.lastError = '';
      return this.getHealth();
    }
    if (!force && this.synced && hash === this.syncedAddressHash) return this.getHealth();

    try {
      const listed = await this.#request('', { operation: 'list' });
      if (!Array.isArray(listed)) throw new HeliusWebhookManagerError('Helius webhook list returned invalid data');
      const matching = listed.filter((item) => item?.webhookURL === this.webhookUrl &&
        String(item?.webhookType || '').toLowerCase() === 'enhanced');

      if (addresses.length === 0) {
        const ids = new Set(matching.map((item) => cleanWebhookId(item?.webhookID)).filter(Boolean));
        for (const id of ids) await this.#request(`/${id}`, { method: 'DELETE', operation: 'delete' });
        this.webhookId = '';
        this.store.setMeta(WEBHOOK_ID_KEY, '');
        this.#markSynced(hash, 0);
        return this.getHealth();
      }

      let selected = matching.find((item) => cleanWebhookId(item?.webhookID) === this.webhookId) || matching[0] || null;
      let id = cleanWebhookId(selected?.webhookID);
      const definition = this.#definition(addresses);
      if (!id) {
        selected = await this.#request('', { method: 'POST', body: definition, operation: 'create' });
        id = cleanWebhookId(selected?.webhookID);
        if (!id) throw new HeliusWebhookManagerError('Helius webhook create returned no webhook id');
      } else if (!this.#matches(selected, definition)) {
        selected = await this.#request(`/${id}`, { method: 'PUT', body: definition, operation: 'update' });
      }
      if (selected?.active === false) {
        await this.#request(`/${id}`, { method: 'PATCH', body: { active: true }, operation: 'enable' });
      }
      for (const duplicate of matching) {
        const duplicateId = cleanWebhookId(duplicate?.webhookID);
        if (duplicateId && duplicateId !== id) {
          await this.#request(`/${duplicateId}`, { method: 'DELETE', operation: 'delete_duplicate' });
        }
      }
      this.webhookId = id;
      this.store.setMeta(WEBHOOK_ID_KEY, id);
      this.#markSynced(hash, addresses.length);
      return this.getHealth();
    } catch (error) {
      this.synced = false;
      this.lastError = redact(error instanceof Error ? error.message : String(error), [this.apiKey, this.authHeader]);
      return this.getHealth();
    }
  }

  #definition(addresses) {
    return {
      webhookURL: this.webhookUrl,
      webhookType: 'enhanced',
      accountAddresses: addresses,
      transactionTypes: [],
      authHeader: this.authHeader,
      txnStatus: 'success'
    };
  }

  #matches(actual, desired) {
    return Boolean(actual) && actual.webhookURL === desired.webhookURL &&
      String(actual.webhookType || '').toLowerCase() === 'enhanced' &&
      actual.authHeader === desired.authHeader &&
      sameAddresses(actual.accountAddresses, desired.accountAddresses) &&
      normalizedTransactionTypes(actual.transactionTypes).length === 0;
  }

  #markSynced(hash, addressCount) {
    this.synced = true;
    this.lastError = '';
    this.lastSyncedAt = new Date(this.now()).toISOString();
    this.syncedAddressHash = hash;
    this.syncedAddressCount = addressCount;
    this.store.setMeta(WEBHOOK_HASH_KEY, hash);
  }

  async #request(pathname, { method = 'GET', body, operation } = {}) {
    const url = new URL(`${HELIUS_WEBHOOK_ROOT}${pathname}`);
    url.searchParams.set('api-key', this.apiKey);
    let response;
    try {
      response = await this.fetch(url, {
        method,
        headers: body ? { accept: 'application/json', 'content-type': 'application/json' } : { accept: 'application/json' },
        body: body ? JSON.stringify(body) : undefined,
        signal: AbortSignal.timeout(this.timeoutMs)
      });
    } catch (error) {
      throw new HeliusWebhookManagerError(
        redact(`Helius webhook ${operation} network failure: ${error instanceof Error ? error.message : String(error)}`, [
          this.apiKey,
          this.authHeader
        ]),
        { operation }
      );
    }
    const text = await response.text();
    if (!response.ok) {
      throw new HeliusWebhookManagerError(
        `Helius webhook ${operation} failed with HTTP ${response.status}`,
        { operation, status: response.status }
      );
    }
    if (method === 'DELETE' && !text) return null;
    if (!text) return null;
    try {
      return JSON.parse(text);
    } catch {
      throw new HeliusWebhookManagerError(`Helius webhook ${operation} returned invalid JSON`, { operation });
    }
  }
}
