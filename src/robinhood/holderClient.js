import { formatUnits } from 'viem';

const ADDRESS_PATTERN = /^0x[0-9a-f]{40}$/;
const DEFAULT_BASE_URL = 'https://robinhoodchain.blockscout.com/api/v2';
const INFRASTRUCTURE_NAME_PATTERN = /pool|router|factory|multicall|bridge|vesting|locker|airdrop|treasury/i;

function normalizeAddress(value) {
  return String(value || '').toLowerCase();
}

function asNumber(value) {
  if (value === null || value === undefined || value === '') return null;
  const number = Number(value);
  return Number.isFinite(number) ? number : null;
}

function tokenAmount(value, decimals) {
  try {
    return Number(formatUnits(BigInt(String(value || '0')), Number(decimals) || 0));
  } catch {
    return null;
  }
}

function retryDelay(response, attempt) {
  const retryAfterHeader = response?.headers?.get?.('retry-after');
  const retryAfter = retryAfterHeader === null || retryAfterHeader === undefined
    ? NaN
    : Number(retryAfterHeader);
  if (Number.isFinite(retryAfter) && retryAfter >= 0) return Math.min(5_000, retryAfter * 1_000);
  return 250 * (2 ** attempt);
}

async function requestObject(url, { fetchImpl, timeoutMs, signal } = {}) {
  let lastError;
  for (let attempt = 0; attempt < 4; attempt += 1) {
    try {
      const timeoutSignal = AbortSignal.timeout(timeoutMs);
      const combined = signal ? AbortSignal.any([signal, timeoutSignal]) : timeoutSignal;
      const response = await fetchImpl(url, {
        signal: combined,
        headers: { accept: 'application/json' }
      });
      if (!response.ok) {
        const retryable = response.status === 429 || response.status >= 500;
        if (retryable && attempt < 3) {
          await new Promise((resolve) => setTimeout(resolve, retryDelay(response, attempt)));
          continue;
        }
        const error = new Error(`Blockscout request failed with HTTP ${response.status}`);
        error.retryable = false;
        throw error;
      }
      const body = await response.json();
      if (!body || typeof body !== 'object' || Array.isArray(body)) {
        const error = new Error('Blockscout returned an invalid response');
        error.retryable = false;
        throw error;
      }
      return body;
    } catch (error) {
      lastError = error;
      if (signal?.aborted || error?.name === 'AbortError' || error?.retryable === false || attempt >= 3) break;
      await new Promise((resolve) => setTimeout(resolve, 250 * (2 ** attempt)));
    }
  }
  throw lastError || new Error('Blockscout request failed');
}

function nextUrl(base, cursor) {
  const url = new URL(base);
  for (const [key, value] of Object.entries(cursor || {})) {
    if (value !== null && value !== undefined) url.searchParams.set(key, String(value));
  }
  return url;
}

function blockscoutAddress(raw) {
  const value = typeof raw === 'string' ? { hash: raw } : raw || {};
  const address = normalizeAddress(value.hash);
  return {
    address,
    valid: ADDRESS_PATTERN.test(address),
    isContract: value.is_contract === true,
    proxyType: String(value.proxy_type || '').toLowerCase() || null,
    contractName: String(value.name || '') || null,
    verifiedContract: value.is_verified === true
  };
}

export function normalizeBlockscoutTokenTransfer(raw = {}) {
  const token = raw.token || {};
  const tokenAddress = normalizeAddress(token.address_hash || token.address);
  const from = blockscoutAddress(raw.from);
  const to = blockscoutAddress(raw.to);
  const parsedTimestamp = raw.timestamp ? Date.parse(raw.timestamp) : NaN;
  return {
    tokenAddress,
    tokenType: String(raw.token_type || token.type || ''),
    tokenSymbol: String(token.symbol || 'UNKNOWN'),
    tokenName: String(token.name || token.symbol || 'Unknown'),
    tokenDecimals: asNumber(token.decimals),
    from,
    to,
    txHash: normalizeAddress(raw.transaction_hash),
    logIndex: asNumber(raw.log_index),
    blockNumber: asNumber(raw.block_number),
    blockTimestamp: Number.isFinite(parsedTimestamp) ? Math.floor(parsedTimestamp / 1_000) : null,
    method: String(raw.method || ''),
    valid: ADDRESS_PATTERN.test(tokenAddress)
  };
}

function normalizeTransferPage(body) {
  const nextPageParams = body.next_page_params || null;
  return {
    items: (Array.isArray(body.items) ? body.items : []).map(normalizeBlockscoutTokenTransfer),
    nextPageParams,
    complete: !nextPageParams,
    source: 'blockscout'
  };
}

export function normalizeBlockscoutHolder(raw, {
  rank,
  decimals,
  totalSupply,
  priceUsd,
  snapshotAt
} = {}) {
  const addressInfo = typeof raw?.address === 'string' ? { hash: raw.address } : raw?.address || {};
  const address = normalizeAddress(addressInfo.hash);
  const amount = tokenAmount(raw?.value, decimals);
  const supply = tokenAmount(totalSupply, decimals);
  const valueUsd = amount !== null && Number(priceUsd) > 0 ? amount * Number(priceUsd) : null;
  const sharePercent = amount !== null && supply > 0 ? (amount / supply) * 100 : null;
  const proxyType = String(addressInfo.proxy_type || '').toLowerCase();
  const name = String(addressInfo.name || '');
  const contractInfrastructure = addressInfo.is_contract === true && proxyType !== 'eip7702';
  const namedInfrastructure = INFRASTRUCTURE_NAME_PATTERN.test(name);
  const invalid = !ADDRESS_PATTERN.test(address);
  const dead = address === '0x0000000000000000000000000000000000000000' ||
    address === '0x000000000000000000000000000000000000dead';
  const exclusionReasons = [
    invalid ? 'invalid_address' : '',
    dead ? 'burn_address' : '',
    contractInfrastructure ? 'contract_holder' : '',
    namedInfrastructure ? 'named_infrastructure' : ''
  ].filter(Boolean);

  return {
    address,
    holderRank: Number(rank) || null,
    holdingTokenAmount: amount,
    holdingSharePercent: sharePercent,
    holdingValueUsd: valueUsd,
    holderSnapshotAt: snapshotAt,
    holderSource: 'blockscout',
    isContract: addressInfo.is_contract === true,
    proxyType: proxyType || null,
    contractName: name || null,
    verifiedContract: addressInfo.is_verified === true,
    excluded: exclusionReasons.length > 0,
    exclusionReasons
  };
}

export class RobinhoodHolderClient {
  constructor({
    baseUrl = DEFAULT_BASE_URL,
    timeoutMs = 20_000,
    fetchImpl = globalThis.fetch
  } = {}) {
    if (typeof fetchImpl !== 'function') throw new TypeError('fetchImpl is required');
    this.baseUrl = String(baseUrl || DEFAULT_BASE_URL).replace(/\/$/, '');
    this.timeoutMs = Math.max(1_000, Number(timeoutMs) || 20_000);
    this.fetchImpl = fetchImpl;
  }

  async fetchTopHolders(tokenAddress, { limit = 150, signal } = {}) {
    const address = normalizeAddress(tokenAddress);
    if (!ADDRESS_PATTERN.test(address)) throw new TypeError('Invalid Robinhood token address');
    const target = Math.max(1, Math.min(1_000, Math.floor(Number(limit) || 150)));
    const tokenUrl = `${this.baseUrl}/tokens/${encodeURIComponent(address)}`;
    const holdersUrl = `${tokenUrl}/holders`;
    const [token, firstPage] = await Promise.all([
      requestObject(tokenUrl, {
        fetchImpl: this.fetchImpl,
        timeoutMs: this.timeoutMs,
        signal
      }),
      requestObject(holdersUrl, {
        fetchImpl: this.fetchImpl,
        timeoutMs: this.timeoutMs,
        signal
      })
    ]);
    const rows = [];
    let page = firstPage;
    let cursor = null;
    let reachedEnd = false;
    while (page) {
      for (const item of Array.isArray(page.items) ? page.items : []) {
        rows.push(item);
        if (rows.length >= target) break;
      }
      cursor = page.next_page_params || null;
      if (rows.length >= target || !cursor) {
        reachedEnd = !cursor;
        break;
      }
      page = await requestObject(nextUrl(holdersUrl, cursor), {
        fetchImpl: this.fetchImpl,
        timeoutMs: this.timeoutMs,
        signal
      });
    }
    const snapshotAt = new Date().toISOString();
    const decimals = asNumber(token.decimals) ?? 18;
    const totalSupply = token.total_supply;
    const priceUsd = asNumber(token.exchange_rate);
    return {
      token: {
        address,
        symbol: String(token.symbol || 'UNKNOWN'),
        name: String(token.name || token.symbol || 'Unknown'),
        decimals,
        totalSupply: tokenAmount(totalSupply, decimals),
        priceUsd,
        holders: asNumber(token.holders_count),
        logo: typeof token.icon_url === 'string' ? token.icon_url : ''
      },
      holders: rows.slice(0, target).map((row, index) => normalizeBlockscoutHolder(row, {
        rank: index + 1,
        decimals,
        totalSupply,
        priceUsd,
        snapshotAt
      })),
      requested: target,
      reachedEnd,
      nextPageParams: cursor,
      snapshotAt,
      source: 'blockscout'
    };
  }

  async fetchTokenTransfers(tokenAddress, { cursor = null, signal } = {}) {
    const address = normalizeAddress(tokenAddress);
    if (!ADDRESS_PATTERN.test(address)) throw new TypeError('Invalid Robinhood token address');
    const base = `${this.baseUrl}/tokens/${encodeURIComponent(address)}/transfers`;
    const body = await requestObject(nextUrl(base, cursor), {
      fetchImpl: this.fetchImpl,
      timeoutMs: this.timeoutMs,
      signal
    });
    return normalizeTransferPage(body);
  }

  async fetchAddressTokenTransfers(walletAddress, { cursor = null, signal } = {}) {
    const address = normalizeAddress(walletAddress);
    if (!ADDRESS_PATTERN.test(address)) throw new TypeError('Invalid Robinhood wallet address');
    const base = new URL(`${this.baseUrl}/addresses/${encodeURIComponent(address)}/token-transfers`);
    base.searchParams.set('type', 'ERC-20');
    const body = await requestObject(nextUrl(base, cursor), {
      fetchImpl: this.fetchImpl,
      timeoutMs: this.timeoutMs,
      signal
    });
    return normalizeTransferPage(body);
  }

  async fetchAddressCounters(walletAddress, { signal } = {}) {
    const address = normalizeAddress(walletAddress);
    if (!ADDRESS_PATTERN.test(address)) throw new TypeError('Invalid Robinhood wallet address');
    const body = await requestObject(`${this.baseUrl}/addresses/${encodeURIComponent(address)}/counters`, {
      fetchImpl: this.fetchImpl,
      timeoutMs: this.timeoutMs,
      signal
    });
    return {
      tokenTransfers: Math.max(0, asNumber(body.token_transfers_count) ?? 0),
      transactions: Math.max(0, asNumber(body.transactions_count) ?? 0)
    };
  }
}
