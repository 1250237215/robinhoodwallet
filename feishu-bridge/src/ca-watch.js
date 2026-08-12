import fs from 'node:fs';
import path from 'node:path';

const EVM_PATTERN = /\b0x[0-9a-fA-F]{40}\b/g;
const SOLANA_PATTERN = /\b[1-9A-HJ-NP-Za-km-z]{32,44}\b/g;
const BASE58 = '123456789ABCDEFGHJKLMNPQRSTUVWXYZabcdefghijkmnopqrstuvwxyz';
const MAX_TRACKED_MESSAGES = 2_000;
const LINK_CACHE_TTL_MS = 10 * 60 * 1_000;
const LINK_CACHE_LIMIT = 1_000;

function isSolanaAddress(value) {
  let number = 0n;
  for (const character of value) {
    const index = BASE58.indexOf(character);
    if (index < 0) return false;
    number = number * 58n + BigInt(index);
  }
  let bytes = 0;
  while (number > 0n) {
    bytes += 1;
    number >>= 8n;
  }
  return value.length - value.replace(/^1+/, '').length + bytes === 32;
}

export function extractContractAddresses(value, limit = 8) {
  const text = String(value || '');
  const found = [];
  const seen = new Set();
  for (const match of text.matchAll(EVM_PATTERN)) {
    const address = match[0].toLowerCase();
    if (address === `0x${'0'.repeat(40)}` || seen.has(address)) continue;
    seen.add(address);
    found.push({ index: match.index, address });
  }
  for (const match of text.matchAll(SOLANA_PATTERN)) {
    const address = match[0];
    if (seen.has(address) || !isSolanaAddress(address)) continue;
    seen.add(address);
    found.push({ index: match.index, address });
  }
  return found.sort((a, b) => a.index - b.index).slice(0, limit).map((item) => item.address);
}

async function contractExists(fetchImpl, rpcUrl, address) {
  try {
    const response = await fetchImpl(rpcUrl, {
      method: 'POST',
      headers: { 'content-type': 'application/json', accept: 'application/json' },
      body: JSON.stringify({ jsonrpc: '2.0', id: 1, method: 'eth_getCode', params: [address, 'latest'] }),
      signal: AbortSignal.timeout(2_000)
    });
    if (!response.ok) return null;
    const payload = await response.json();
    if (typeof payload?.result !== 'string') return null;
    return !['0x', '0x0', '0x00'].includes(payload.result.toLowerCase());
  } catch {
    return null;
  }
}

export async function resolveContractChains(addresses, profiles, fetchImpl = globalThis.fetch) {
  const contractChains = [];
  const debotUrls = [];
  for (const address of addresses) {
    if (!address.startsWith('0x')) {
      contractChains.push('solana');
      debotUrls.push(`https://debot.ai/token/solana/289942_${address}`);
      continue;
    }
    const checks = await Promise.all(profiles.map(async (profile) => ({
      chain: profile.chain,
      exists: await contractExists(fetchImpl, profile.rpcUrl, address)
    })));
    const matches = checks.filter((item) => item.exists === true);
    if (matches.length === 1) {
      contractChains.push(matches[0].chain);
      debotUrls.push(`https://debot.ai/token/${matches[0].chain}/289942_${address}`);
    } else {
      contractChains.push(matches.length > 1 ? 'multiple' : 'unknown');
    }
  }
  return { contractChains, debotUrls };
}

export class FeishuCaWatch {
  constructor({ people = [], dataFile, internalUrl, internalToken, rpcProfiles = [], fetchImpl = globalThis.fetch, now = Date.now } = {}) {
    this.people = people.map(({ id, name, shortName, source }) => ({ id, name, shortName, source }));
    this.dataFile = String(dataFile || '');
    this.internalUrl = String(internalUrl || '');
    this.internalToken = String(internalToken || '');
    this.rpcProfiles = rpcProfiles;
    this.fetchImpl = fetchImpl;
    this.now = now;
    this.enabled = false;
    this.selectedPersonIds = new Set();
    this.seenMessageIds = [];
    this.latestDelivery = null;
    this.queue = Promise.resolve();
    this.linkCache = new Map();
    this.load();
  }

  load() {
    try {
      const value = JSON.parse(fs.readFileSync(this.dataFile, 'utf8'));
      this.enabled = value.enabled === true;
      this.selectedPersonIds = new Set(Array.isArray(value.selectedPersonIds) ? value.selectedPersonIds.map(String) : []);
      this.seenMessageIds = (Array.isArray(value.seenMessageIds) ? value.seenMessageIds : []).map(String).slice(-MAX_TRACKED_MESSAGES);
      this.latestDelivery = value.latestDelivery && typeof value.latestDelivery === 'object' ? value.latestDelivery : null;
    } catch {
      // First start has no persisted rules or delivery cursor.
    }
  }

  persist() {
    if (!this.dataFile) return;
    fs.mkdirSync(path.dirname(this.dataFile), { recursive: true });
    const temporary = `${this.dataFile}.${process.pid}.tmp`;
    fs.writeFileSync(temporary, JSON.stringify({
      enabled: this.enabled,
      selectedPersonIds: [...this.selectedPersonIds],
      seenMessageIds: this.seenMessageIds.slice(-MAX_TRACKED_MESSAGES),
      latestDelivery: this.latestDelivery
    }), { mode: 0o600 });
    fs.renameSync(temporary, this.dataFile);
  }

  snapshot() {
    return {
      enabled: this.enabled,
      selected_person_ids: [...this.selectedPersonIds],
      people: this.people.map((person) => ({ ...person, selected: this.selectedPersonIds.has(person.id) })),
      delivery_configured: this.internalToken.length >= 32 && Boolean(this.internalUrl),
      latest_delivery: this.latestDelivery
    };
  }

  async resolveLinks(value) {
    const contractAddresses = extractContractAddresses(value);
    if (!contractAddresses.length) return { contractAddresses: [], contractChains: [], debotUrls: [] };
    const key = contractAddresses.join('|');
    const cached = this.linkCache.get(key);
    if (cached && cached.expiresAt > this.now()) return cached.value;
    const { contractChains, debotUrls } = await resolveContractChains(
      contractAddresses,
      this.rpcProfiles,
      this.fetchImpl
    );
    const result = { contractAddresses, contractChains, debotUrls };
    this.linkCache.set(key, { expiresAt: this.now() + LINK_CACHE_TTL_MS, value: result });
    while (this.linkCache.size > LINK_CACHE_LIMIT) this.linkCache.delete(this.linkCache.keys().next().value);
    return result;
  }

  update({ enabled, person_ids: personIds }) {
    if (!Array.isArray(personIds)) throw new TypeError('person_ids must be an array');
    const known = new Set(this.people.map((person) => person.id));
    const selected = [...new Set(personIds.map(String))];
    if (selected.some((id) => !known.has(id))) throw new TypeError('选择中包含未知飞书人物');
    if (enabled && selected.length === 0) throw new TypeError('启用 CA Bark 时至少选择一人');
    this.enabled = Boolean(enabled);
    this.selectedPersonIds = new Set(selected);
    this.persist();
    return this.snapshot();
  }

  observe(snapshot) {
    const seen = new Set(this.seenMessageIds);
    const messages = (snapshot?.people || []).flatMap((person) => person.messages || []);
    const firstObservation = seen.size === 0;
    const fresh = messages.filter((message) => message?.id && !seen.has(String(message.id)));
    for (const message of messages) if (message?.id) seen.add(String(message.id));
    this.seenMessageIds = [...seen].slice(-MAX_TRACKED_MESSAGES);
    this.persist();
    if (firstObservation) return;
    for (const message of fresh) {
      if (!this.enabled || !this.selectedPersonIds.has(String(message.personId))) continue;
      const addresses = extractContractAddresses(message.content);
      if (!addresses.length) continue;
      this.queue = this.queue.then(() => this.deliver(message, addresses)).catch(() => {});
    }
  }

  async deliver(message, contractAddresses) {
    const attemptedAt = new Date(this.now()).toISOString();
    const { contractChains, debotUrls } = await resolveContractChains(contractAddresses, this.rpcProfiles, this.fetchImpl);
    const payload = {
      personName: String(message.personName || '飞书'),
      sourceName: String(message.source || '飞书实时群聊'),
      text: String(message.content || ''),
      contractAddresses,
      contractChains,
      debotUrls,
      messageUrl: String(message.url || '')
    };
    try {
      const response = await this.fetchImpl(this.internalUrl, {
        method: 'POST',
        headers: {
          authorization: `Bearer ${this.internalToken}`,
          'content-type': 'application/json',
          accept: 'application/json'
        },
        body: JSON.stringify(payload),
        signal: AbortSignal.timeout(15_000)
      });
      if (!response.ok) throw new Error(`Bark 服务返回 ${response.status}`);
      const result = await response.json();
      this.latestDelivery = {
        status: result?.delivery?.sent > 0 ? 'sent' : 'no-targets',
        person_name: payload.personName,
        contract_addresses: contractAddresses,
        attempted_at: attemptedAt,
        completed_at: new Date(this.now()).toISOString(),
        delivery: result.delivery || null,
        last_error: ''
      };
    } catch (error) {
      this.latestDelivery = {
        status: 'failed',
        person_name: payload.personName,
        contract_addresses: contractAddresses,
        attempted_at: attemptedAt,
        completed_at: new Date(this.now()).toISOString(),
        delivery: null,
        last_error: error.message
      };
    }
    this.persist();
  }
}
