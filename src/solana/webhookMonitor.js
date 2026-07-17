import {
  decodeBase58,
  normalizeSolanaAddress,
  normalizeSolanaSignature
} from './address.js';
import { formatSolanaTokenAmount, SPL_TOKEN_2022_PROGRAM_ID, SPL_TOKEN_PROGRAM_ID } from './holderClient.js';

export const WRAPPED_SOL_MINT = 'So11111111111111111111111111111111111111112';
export const SOLANA_USDC_MINT = 'EPjFWdd5AufqSSqeM2qN1xzybapC8G4wEGGkZwyTDt1v';
export const SOLANA_USDT_MINT = 'Es9vMFrzaCERmJfrF4H2FYD4KCoNkY11McCe8BenwNYB';

const SWAP_TYPES = new Set(['SWAP', 'BUY', 'SELL', 'INIT_SWAP', 'TOKEN_SWAP']);
const EVENT_TYPES = new Set(['buy', 'sell', 'transfer', 'token_create']);
const TOKEN_PROGRAMS = new Set([SPL_TOKEN_PROGRAM_ID, SPL_TOKEN_2022_PROGRAM_ID]);

function asInteger(value, fallback = null) {
  const number = Number(value);
  return Number.isSafeInteger(number) && number >= 0 ? number : fallback;
}

function rawInteger(value) {
  try {
    return BigInt(String(value ?? ''));
  } catch {
    return null;
  }
}

function canonicalAddress(value) {
  try {
    return normalizeSolanaAddress(value);
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

function walletMap(input) {
  const result = new Map();
  let entries;
  if (input instanceof Map) entries = [...input.entries()];
  else if (input instanceof Set) entries = [...input].map((address) => [address, {}]);
  else if (Array.isArray(input)) entries = input.map((item) => [typeof item === 'string' ? item : item?.address, item]);
  else if (input && typeof input === 'object') entries = Object.entries(input);
  else entries = [];

  for (const [key, raw] of entries) {
    const address = canonicalAddress(raw?.address || key);
    if (!address) continue;
    result.set(address, {
      address,
      alias: String(raw?.alias || ''),
      monitorRules: raw?.monitorRules && typeof raw.monitorRules === 'object' ? raw.monitorRules : {}
    });
  }
  return result;
}

function platformFor(source) {
  const normalized = String(source || '').toUpperCase();
  if (normalized.includes('PUMP')) return 'pump';
  if (normalized.includes('BONK') || normalized.includes('LAUNCHLAB')) return 'letsbonk';
  if (normalized.includes('METEORA')) return 'meteora';
  if (normalized.includes('RAYDIUM')) return 'raydium';
  if (normalized.includes('JUPITER')) return 'jupiter';
  if (normalized.includes('ORCA')) return 'orca';
  return normalized ? normalized.toLowerCase() : '';
}

function transactionInstructions(transaction) {
  const flattened = [];
  const visit = (instruction) => {
    if (!instruction || typeof instruction !== 'object') return;
    flattened.push(instruction);
    for (const inner of Array.isArray(instruction.innerInstructions) ? instruction.innerInstructions : []) visit(inner);
  };
  for (const instruction of Array.isArray(transaction?.instructions) ? transaction.instructions : []) visit(instruction);
  return flattened;
}

function createdMints(transaction, monitoredWallets) {
  const feePayer = canonicalAddress(transaction?.feePayer);
  if (!feePayer || !monitoredWallets.has(feePayer)) return [];
  const mints = new Set();
  for (const instruction of transactionInstructions(transaction)) {
    if (!TOKEN_PROGRAMS.has(String(instruction.programId || ''))) continue;
    let data;
    try {
      data = decodeBase58(instruction.data);
    } catch {
      continue;
    }
    if (data[0] !== 0 && data[0] !== 20) continue;
    const mint = canonicalAddress(instruction.accounts?.[0]);
    if (mint) mints.add(mint);
  }
  return [...mints].map((mint) => ({ mint, walletAddress: feePayer }));
}

function walletTokenChanges(transaction, walletAddress) {
  const changes = new Map();
  for (const account of Array.isArray(transaction?.accountData) ? transaction.accountData : []) {
    const accountAddress = canonicalAddress(account?.account);
    for (const change of Array.isArray(account?.tokenBalanceChanges) ? account.tokenBalanceChanges : []) {
      const userAddress = canonicalAddress(change?.userAccount);
      if (userAddress !== walletAddress && accountAddress !== walletAddress) continue;
      const mint = canonicalAddress(change?.mint);
      const amount = rawInteger(change?.rawTokenAmount?.tokenAmount);
      if (!mint || amount === null || amount === 0n) continue;
      const decimals = asInteger(change?.rawTokenAmount?.decimals, 0);
      const previous = changes.get(mint) || { amount: 0n, decimals };
      previous.amount += amount;
      previous.decimals = decimals;
      changes.set(mint, previous);
    }
  }
  return changes;
}

function isSwapTransaction(transaction) {
  return SWAP_TYPES.has(String(transaction?.type || '').toUpperCase()) ||
    Boolean(transaction?.events?.swap);
}

function transferCounterparty(transaction, walletAddress, mint = null) {
  for (const transfer of Array.isArray(transaction?.tokenTransfers) ? transaction.tokenTransfers : []) {
    if (canonicalAddress(transfer?.fromUserAccount) !== walletAddress) continue;
    if (mint && canonicalAddress(transfer?.mint) !== mint) continue;
    return canonicalAddress(transfer?.toUserAccount) || '';
  }
  for (const transfer of Array.isArray(transaction?.nativeTransfers) ? transaction.nativeTransfers : []) {
    if (canonicalAddress(transfer?.fromUserAccount) === walletAddress) {
      return canonicalAddress(transfer?.toUserAccount) || '';
    }
  }
  return '';
}

function baseEvent(transaction, annotation, eventType, now) {
  const rule = ruleFor(annotation, eventType);
  return {
    chain: 'solana',
    eventType,
    walletAddress: annotation.address,
    walletAlias: annotation.alias,
    platform: platformFor(transaction.source),
    txHash: normalizeSolanaSignature(transaction.signature),
    blockNumber: asInteger(transaction.slot, 0),
    blockTimestamp: asInteger(transaction.timestamp, Math.floor(now() / 1_000)),
    detectedAt: Math.floor(now() / 1_000),
    soundAlert: rule.sound,
    barkAlert: rule.bark,
    provider: 'helius'
  };
}

function swapEvents(transaction, wallets, quoteMints, now) {
  if (!isSwapTransaction(transaction)) return [];
  const events = [];
  for (const annotation of wallets.values()) {
    const changes = walletTokenChanges(transaction, annotation.address);
    for (const [mint, change] of changes) {
      if (quoteMints.has(mint)) continue;
      const eventType = change.amount > 0n ? 'buy' : 'sell';
      const rule = ruleFor(annotation, eventType);
      if (!rule.enabled) continue;
      const amount = change.amount < 0n ? -change.amount : change.amount;
      events.push({
        ...baseEvent(transaction, annotation, eventType, now),
        assetType: 'spl',
        counterpartyAddress: transferCounterparty(transaction, annotation.address, mint),
        tokenAddress: mint,
        tokenSymbol: mint,
        tokenName: mint,
        tokenAmount: formatSolanaTokenAmount(amount, change.decimals),
        rawTokenAmount: amount.toString(),
        tokenDecimals: change.decimals
      });
    }
  }
  return events;
}

function directTransferEvents(transaction, wallets, now) {
  if (String(transaction?.type || '').toUpperCase() !== 'TRANSFER') return [];
  const events = [];
  for (const annotation of wallets.values()) {
    const rule = ruleFor(annotation, 'transfer');
    if (!rule.enabled) continue;
    const changes = walletTokenChanges(transaction, annotation.address);
    for (const [mint, change] of changes) {
      if (change.amount >= 0n) continue;
      const amount = -change.amount;
      events.push({
        ...baseEvent(transaction, annotation, 'transfer', now),
        assetType: 'spl',
        counterpartyAddress: transferCounterparty(transaction, annotation.address, mint),
        tokenAddress: mint,
        tokenSymbol: mint,
        tokenName: mint,
        tokenAmount: formatSolanaTokenAmount(amount, change.decimals),
        rawTokenAmount: amount.toString(),
        tokenDecimals: change.decimals
      });
    }
    for (const transfer of Array.isArray(transaction?.nativeTransfers) ? transaction.nativeTransfers : []) {
      if (canonicalAddress(transfer?.fromUserAccount) !== annotation.address) continue;
      const lamports = rawInteger(transfer?.amount);
      if (lamports === null || lamports <= 0n) continue;
      events.push({
        ...baseEvent(transaction, annotation, 'transfer', now),
        assetType: 'native',
        counterpartyAddress: canonicalAddress(transfer?.toUserAccount) || '',
        tokenAddress: '',
        tokenSymbol: 'SOL',
        tokenName: 'Solana',
        tokenAmount: formatSolanaTokenAmount(lamports, 9),
        rawTokenAmount: lamports.toString(),
        tokenDecimals: 9
      });
    }
  }
  return events;
}

function tokenCreateEvents(transaction, wallets, now) {
  const events = [];
  for (const { mint, walletAddress } of createdMints(transaction, wallets)) {
    const annotation = wallets.get(walletAddress);
    const rule = ruleFor(annotation, 'token_create');
    if (!rule.enabled) continue;
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
      platform: platformFor(transaction.source) || 'spl'
    });
  }
  return events;
}

export function normalizeHeliusTransaction(transaction, {
  monitoredWallets,
  quoteMints = [WRAPPED_SOL_MINT, SOLANA_USDC_MINT, SOLANA_USDT_MINT],
  now = Date.now
} = {}) {
  if (!transaction || typeof transaction !== 'object') throw new TypeError('Helius transaction is required');
  normalizeSolanaSignature(transaction.signature);
  const wallets = walletMap(monitoredWallets);
  const quotes = new Set(quoteMints.map(canonicalAddress).filter(Boolean));
  const candidates = [
    ...tokenCreateEvents(transaction, wallets, now),
    ...swapEvents(transaction, wallets, quotes, now),
    ...directTransferEvents(transaction, wallets, now)
  ];
  const seen = new Set();
  return candidates.filter((event) => {
    if (!EVENT_TYPES.has(event.eventType)) return false;
    const key = [event.eventType, event.walletAddress, event.tokenAddress, event.counterpartyAddress].join(':');
    if (seen.has(key)) return false;
    seen.add(key);
    return true;
  }).map((event, eventIndex) => ({ ...event, eventIndex, logIndex: eventIndex }));
}

export class MemorySolanaSignatureStore {
  constructor({ maximum = 20_000 } = {}) {
    this.maximum = Math.max(100, Math.floor(Number(maximum) || 20_000));
    this.signatures = new Map();
    this.durable = false;
  }

  async claim(signature) {
    const normalized = normalizeSolanaSignature(signature);
    if (this.signatures.has(normalized)) return false;
    this.signatures.set(normalized, true);
    while (this.signatures.size > this.maximum) this.signatures.delete(this.signatures.keys().next().value);
    return true;
  }

  async release(signature) {
    return this.signatures.delete(normalizeSolanaSignature(signature));
  }
}

export class SolanaWebhookAuthenticationError extends Error {
  constructor(message = 'Invalid Solana webhook authorization') {
    super(message);
    this.name = 'SolanaWebhookAuthenticationError';
  }
}

export class SolanaHeliusWebhookMonitor {
  constructor({
    apiKey = process.env.HELIUS_API_KEY || '',
    webhookUrl = process.env.SOLANA_HELIUS_WEBHOOK_URL || '',
    authHeader = process.env.SOLANA_HELIUS_AUTH_HEADER || '',
    signatureStore = new MemorySolanaSignatureStore(),
    walletProvider = null,
    monitoredWallets = [],
    quoteMints,
    now = Date.now,
    maxTransactions = 1_000
  } = {}) {
    if (!signatureStore?.claim) throw new TypeError('signatureStore.claim is required');
    if (!signatureStore?.release) throw new TypeError('signatureStore.release is required');
    if (walletProvider !== null && typeof walletProvider !== 'function') {
      throw new TypeError('walletProvider must be a function');
    }
    this.apiKey = String(apiKey || '');
    this.webhookUrl = String(webhookUrl || '');
    this.authHeader = String(authHeader || '');
    this.signatureStore = signatureStore;
    this.walletProvider = walletProvider;
    this.monitoredWallets = monitoredWallets;
    this.quoteMints = quoteMints;
    this.now = now;
    this.maxTransactions = Math.max(1, Math.min(10_000, Math.floor(Number(maxTransactions) || 1_000)));
  }

  getHealth() {
    const reasons = [];
    if (!this.apiKey) reasons.push('helius_api_key_missing');
    if (!/^https:\/\//i.test(this.webhookUrl)) reasons.push('https_webhook_url_missing');
    if (!this.authHeader) reasons.push('webhook_auth_header_missing');
    if (this.signatureStore.durable !== true) reasons.push('durable_signature_store_missing');
    return {
      chain: 'solana',
      status: reasons.length ? 'degraded' : 'healthy',
      mode: this.apiKey ? 'helius_enhanced_webhook' : 'unconfigured',
      realtimeReady: reasons.length === 0,
      reasons,
      publicRpcFallback: false,
      providerAddressCapacity: 100_000
    };
  }

  async ingest(payload, { authorization = '', monitoredWallets } = {}) {
    if (this.authHeader && authorization !== this.authHeader) {
      throw new SolanaWebhookAuthenticationError();
    }
    if (!Array.isArray(payload)) throw new TypeError('Helius webhook payload must be an array');
    if (payload.length > this.maxTransactions) throw new RangeError('Helius webhook payload is too large');
    const wallets = monitoredWallets ?? (this.walletProvider
      ? await this.walletProvider()
      : this.monitoredWallets);
    const events = [];
    const acceptedSignatures = [];
    const duplicateSignatures = [];
    const invalidTransactions = [];
    try {
      for (let index = 0; index < payload.length; index += 1) {
        const transaction = payload[index];
        let signature;
        try {
          signature = normalizeSolanaSignature(transaction?.signature);
        } catch {
          invalidTransactions.push(index);
          continue;
        }
        const normalized = normalizeHeliusTransaction(transaction, {
          monitoredWallets: wallets,
          quoteMints: this.quoteMints,
          now: this.now
        });
        if (!await this.signatureStore.claim(signature)) {
          duplicateSignatures.push(signature);
          continue;
        }
        acceptedSignatures.push(signature);
        events.push(...normalized);
      }
    } catch (error) {
      await Promise.allSettled(acceptedSignatures.map((signature) => this.signatureStore.release(signature)));
      throw error;
    }
    return {
      acceptedTransactions: payload.length - duplicateSignatures.length - invalidTransactions.length,
      acceptedSignatures,
      duplicateSignatures,
      invalidTransactions,
      events
    };
  }

  buildWebhookDefinition(monitoredWallets = this.monitoredWallets) {
    const addresses = [...walletMap(monitoredWallets).keys()];
    if (addresses.length > 100_000) throw new RangeError('Helius supports at most 100,000 addresses per webhook');
    return {
      webhookURL: this.webhookUrl,
      webhookType: 'enhanced',
      accountAddresses: addresses,
      transactionTypes: [],
      authHeader: this.authHeader,
      txnStatus: 'success'
    };
  }
}

export const SolanaWebhookMonitor = SolanaHeliusWebhookMonitor;
