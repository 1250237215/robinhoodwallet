import { normalizeSolanaAddress, normalizeSolanaSignature } from './address.js';
import { formatSolanaTokenAmount } from './holderClient.js';
import { SOLANA_USDC_MINT, SOLANA_USDT_MINT, WRAPPED_SOL_MINT } from './webhookMonitor.js';

const CURSOR_PREFIX = 'solana:poll:cursor:';
const EVENT_TYPES = new Set(['buy', 'sell', 'transfer', 'token_create']);

function boundedInteger(value, fallback, minimum, maximum) {
  const number = Number(value);
  if (!Number.isFinite(number)) return fallback;
  return Math.max(minimum, Math.min(maximum, Math.floor(number)));
}

function canonicalAddress(value) {
  try {
    return normalizeSolanaAddress(value);
  } catch {
    return null;
  }
}

function rawInteger(value) {
  try {
    return BigInt(String(value ?? ''));
  } catch {
    return null;
  }
}

function ruleFor(annotation, eventType) {
  const configured = annotation?.monitorRules?.[eventType];
  return {
    enabled: typeof configured?.enabled === 'boolean' ? configured.enabled : eventType === 'buy',
    sound: configured?.sound === true,
    bark: configured?.bark === true
  };
}

function annotationsMap(input) {
  const result = new Map();
  for (const raw of Array.isArray(input) ? input : []) {
    const address = canonicalAddress(raw?.address);
    if (!address) continue;
    result.set(address, {
      address,
      alias: String(raw?.alias || ''),
      monitorRules: raw?.monitorRules && typeof raw.monitorRules === 'object' ? raw.monitorRules : {}
    });
  }
  return result;
}

function accountKeys(transaction) {
  return (transaction?.transaction?.message?.accountKeys || []).map((entry) =>
    canonicalAddress(typeof entry === 'string' ? entry : entry?.pubkey)
  );
}

function tokenBalancesByOwner(transaction) {
  const result = new Map();
  const apply = (rows, direction) => {
    for (const row of Array.isArray(rows) ? rows : []) {
      const owner = canonicalAddress(row?.owner);
      const mint = canonicalAddress(row?.mint);
      const amount = rawInteger(row?.uiTokenAmount?.amount);
      if (!owner || !mint || amount === null) continue;
      const decimals = boundedInteger(row?.uiTokenAmount?.decimals, 0, 0, 255);
      const key = `${owner}:${mint}`;
      const current = result.get(key) || { owner, mint, amount: 0n, decimals };
      current.amount += direction * amount;
      current.decimals = decimals;
      result.set(key, current);
    }
  };
  apply(transaction?.meta?.preTokenBalances, -1n);
  apply(transaction?.meta?.postTokenBalances, 1n);
  return [...result.values()].filter((row) => row.amount !== 0n);
}

function nativeDelta(transaction, walletAddress) {
  const keys = accountKeys(transaction);
  const index = keys.indexOf(walletAddress);
  if (index < 0) return 0n;
  const before = rawInteger(transaction?.meta?.preBalances?.[index]);
  const after = rawInteger(transaction?.meta?.postBalances?.[index]);
  if (before === null || after === null) return 0n;
  let delta = after - before;
  if (index === 0) {
    const fee = rawInteger(transaction?.meta?.fee);
    if (fee !== null && fee > 0n) delta += fee;
  }
  return delta;
}

function parsedInstructions(transaction) {
  const outer = transaction?.transaction?.message?.instructions || [];
  const inner = (transaction?.meta?.innerInstructions || []).flatMap((group) => group?.instructions || []);
  return [...outer, ...inner];
}

function tokenCreateMints(transaction, monitoredWallets) {
  const feePayer = accountKeys(transaction)[0];
  if (!feePayer || !monitoredWallets.has(feePayer)) return [];
  const result = [];
  for (const instruction of parsedInstructions(transaction)) {
    const type = String(instruction?.parsed?.type || '').toLowerCase();
    if (type !== 'initializemint' && type !== 'initializemint2') continue;
    const mint = canonicalAddress(instruction?.parsed?.info?.mint);
    if (mint) result.push({ mint, walletAddress: feePayer });
  }
  return result;
}

function baseEvent(transaction, annotation, eventType, now) {
  const rule = ruleFor(annotation, eventType);
  return {
    chain: 'solana',
    eventType,
    walletAddress: annotation.address,
    walletAlias: annotation.alias,
    platform: 'solana',
    txHash: normalizeSolanaSignature(transaction?.transaction?.signatures?.[0]),
    blockNumber: boundedInteger(transaction?.slot, 0, 0, Number.MAX_SAFE_INTEGER),
    blockTimestamp: boundedInteger(transaction?.blockTime, Math.floor(now() / 1_000), 0, Number.MAX_SAFE_INTEGER),
    detectedAt: Math.floor(now() / 1_000),
    soundAlert: rule.sound,
    barkAlert: rule.bark,
    provider: 'solana_public_rpc_polling'
  };
}

export function normalizeSolanaRpcTransaction(transaction, {
  monitoredWallets,
  quoteMints = [WRAPPED_SOL_MINT, SOLANA_USDC_MINT, SOLANA_USDT_MINT],
  now = Date.now
} = {}) {
  if (!transaction || typeof transaction !== 'object') return [];
  if (transaction.meta?.err) return [];
  const wallets = annotationsMap(monitoredWallets);
  const quotes = new Set(quoteMints.map(canonicalAddress).filter(Boolean));
  const balances = tokenBalancesByOwner(transaction);
  const events = [];

  for (const annotation of wallets.values()) {
    const changes = balances.filter((row) => row.owner === annotation.address);
    const quoteDelta = changes
      .filter((row) => quotes.has(row.mint))
      .reduce((sum, row) => sum + row.amount, 0n);
    const solDelta = nativeDelta(transaction, annotation.address);
    const paidQuote = quoteDelta < 0n || solDelta < 0n;
    const receivedQuote = quoteDelta > 0n || solDelta > 0n;

    for (const change of changes) {
      if (quotes.has(change.mint)) continue;
      let eventType = '';
      if (change.amount > 0n && paidQuote) eventType = 'buy';
      else if (change.amount < 0n && receivedQuote) eventType = 'sell';
      else if (change.amount < 0n) eventType = 'transfer';
      if (!EVENT_TYPES.has(eventType) || !ruleFor(annotation, eventType).enabled) continue;
      const amount = change.amount < 0n ? -change.amount : change.amount;
      events.push({
        ...baseEvent(transaction, annotation, eventType, now),
        assetType: 'spl',
        counterpartyAddress: '',
        tokenAddress: change.mint,
        tokenSymbol: change.mint,
        tokenName: change.mint,
        tokenAmount: formatSolanaTokenAmount(amount, change.decimals),
        rawTokenAmount: amount.toString(),
        tokenDecimals: change.decimals
      });
    }
  }

  for (const { mint, walletAddress } of tokenCreateMints(transaction, wallets)) {
    const annotation = wallets.get(walletAddress);
    if (!ruleFor(annotation, 'token_create').enabled) continue;
    events.push({
      ...baseEvent(transaction, annotation, 'token_create', now),
      assetType: 'spl',
      counterpartyAddress: '',
      tokenAddress: mint,
      tokenSymbol: mint,
      tokenName: mint,
      tokenAmount: '0',
      rawTokenAmount: '0',
      tokenDecimals: 0,
      platform: 'spl'
    });
  }

  const seen = new Set();
  return events.filter((event) => {
    const key = [event.eventType, event.walletAddress, event.tokenAddress].join(':');
    if (seen.has(key)) return false;
    seen.add(key);
    return true;
  }).map((event, eventIndex) => ({ ...event, eventIndex, logIndex: eventIndex }));
}

export class SolanaRpcPollingMonitor {
  constructor({
    store,
    rpcClient,
    walletProvider,
    onTransaction,
    intervalMs = 3_000,
    concurrency = 4,
    signatureLimit = 10,
    backoffMaxMs = 30_000,
    now = Date.now
  } = {}) {
    if (!store?.getMeta || !store?.setMeta) throw new TypeError('Polling store is required');
    if (!rpcClient?.getSignaturesForAddress || !rpcClient?.getTransaction) throw new TypeError('Polling RPC client is required');
    if (typeof walletProvider !== 'function') throw new TypeError('walletProvider is required');
    if (typeof onTransaction !== 'function') throw new TypeError('onTransaction is required');
    this.store = store;
    this.rpcClient = rpcClient;
    this.walletProvider = walletProvider;
    this.onTransaction = onTransaction;
    this.intervalMs = boundedInteger(intervalMs, 3_000, 1_000, 60_000);
    this.concurrency = boundedInteger(concurrency, 4, 1, 12);
    this.signatureLimit = boundedInteger(signatureLimit, 10, 1, 100);
    this.backoffMaxMs = boundedInteger(backoffMaxMs, 30_000, this.intervalMs, 300_000);
    this.now = now;
    this.timer = null;
    this.closed = false;
    this.running = false;
    this.failureCount = 0;
    this.lastPollAt = null;
    this.lastPollError = '';
  }

  async start() {
    this.closed = false;
    await this.pollNow();
    return this.getHealth();
  }

  close() {
    this.closed = true;
    if (this.timer) clearTimeout(this.timer);
    this.timer = null;
  }

  getHealth() {
    const monitoredWallets = this.walletProvider().length;
    const failed = this.failureCount >= 3;
    return {
      chain: 'solana',
      status: failed ? 'degraded' : 'healthy',
      mode: 'public_rpc_polling',
      realtimeReady: !failed,
      reasons: failed ? ['public_rpc_poll_failed'] : [],
      publicRpcFallback: true,
      source: 'solana_public_rpc_polling',
      latencyTargetMs: 8_000,
      pollIntervalMs: this.intervalMs,
      pollConcurrency: this.concurrency,
      monitoredWallets,
      lastPollAt: this.lastPollAt,
      lastPollError: this.lastPollError
    };
  }

  async pollNow() {
    if (this.closed || this.running) return this.getHealth();
    this.running = true;
    try {
      const wallets = this.walletProvider();
      let next = 0;
      const worker = async () => {
        while (next < wallets.length) {
          const annotation = wallets[next++];
          await this.#pollWallet(annotation.address);
        }
      };
      const results = await Promise.allSettled(
        Array.from({ length: Math.min(this.concurrency, wallets.length) }, worker)
      );
      const failed = results.find((result) => result.status === 'rejected');
      if (failed) throw failed.reason;
      this.failureCount = 0;
      this.lastPollError = '';
      this.lastPollAt = new Date(this.now()).toISOString();
    } catch (error) {
      this.failureCount += 1;
      this.lastPollError = error instanceof Error ? error.message : String(error);
    } finally {
      this.running = false;
      if (!this.closed) {
        const delay = this.failureCount
          ? Math.min(this.backoffMaxMs, this.intervalMs * (2 ** Math.min(6, this.failureCount)))
          : this.intervalMs;
        this.timer = setTimeout(() => void this.pollNow(), delay);
        this.timer.unref?.();
      }
    }
    return this.getHealth();
  }

  async #pollWallet(rawAddress) {
    const address = normalizeSolanaAddress(rawAddress);
    const key = `${CURSOR_PREFIX}${address}`;
    const cursor = String(this.store.getMeta(key) || '');
    const rows = [];
    let before = '';
    for (let page = 0; page < 5; page += 1) {
      const pageRows = await this.rpcClient.getSignaturesForAddress(address, {
        limit: this.signatureLimit,
        until: cursor,
        before
      });
      rows.push(...pageRows);
      if (!cursor || pageRows.length < this.signatureLimit) break;
      before = String(pageRows.at(-1)?.signature || '');
      if (!before || before === cursor) break;
    }
    const validRows = rows.filter((row) => row?.signature && !row.err);
    if (!cursor) {
      const newest = rows[0]?.signature;
      if (newest) this.store.setMeta(key, normalizeSolanaSignature(newest));
      return;
    }
    for (const row of [...validRows].reverse()) {
      const signature = normalizeSolanaSignature(row.signature);
      const transaction = await this.rpcClient.getTransaction(signature);
      if (!transaction) throw new Error(`Solana transaction ${signature} is not available yet`);
      await this.onTransaction(transaction);
      this.store.setMeta(key, signature);
    }
    if (!validRows.length && rows[0]?.signature) {
      this.store.setMeta(key, normalizeSolanaSignature(rows[0].signature));
    }
  }
}
