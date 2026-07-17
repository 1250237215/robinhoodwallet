import { encodeBase58, normalizeSolanaAddress } from './address.js';
import { SolanaRpcError } from './rpcClient.js';

export const SPL_TOKEN_PROGRAM_ID = 'TokenkegQfeZyiNwAJbNbGKPFXCWuBvf9Ss623VQ5DA';
export const SPL_TOKEN_2022_PROGRAM_ID = 'TokenzQdBNbLqP5VEhdkAS6EPFLC1PHnBqCXEpPxuEb';
export const SOLANA_SYSTEM_PROGRAM_ID = '11111111111111111111111111111111';

function boundedInteger(value, fallback, minimum, maximum) {
  const number = Number(value);
  if (!Number.isFinite(number)) return fallback;
  return Math.max(minimum, Math.min(maximum, Math.floor(number)));
}

function parseRawAmount(value) {
  try {
    const amount = BigInt(String(value ?? ''));
    return amount >= 0n ? amount : null;
  } catch {
    return null;
  }
}

export function formatSolanaTokenAmount(rawAmount, decimals = 0) {
  const amount = typeof rawAmount === 'bigint' ? rawAmount : BigInt(rawAmount);
  const places = boundedInteger(decimals, 0, 0, 255);
  if (places === 0) return amount.toString();
  const digits = amount.toString().padStart(places + 1, '0');
  const whole = digits.slice(0, -places);
  const fraction = digits.slice(-places).replace(/0+$/, '');
  return fraction ? `${whole}.${fraction}` : whole;
}

function holderDataFromProgramAccount(row) {
  const encoded = Array.isArray(row?.account?.data) ? row.account.data[0] : null;
  if (typeof encoded !== 'string') return null;
  let data;
  try {
    data = Buffer.from(encoded, 'base64');
  } catch {
    return null;
  }
  if (data.length !== 40) return null;
  const address = encodeBase58(data.subarray(0, 32));
  const amount = data.readBigUInt64LE(32);
  return { address, amount };
}

function holderOwnerFromParsedAccount(row) {
  const info = row?.data?.parsed?.info;
  if (!info || typeof info !== 'object') return null;
  let address;
  try {
    address = normalizeSolanaAddress(info.owner);
  } catch {
    return null;
  }
  const amount = parseRawAmount(info.tokenAmount?.amount ?? info.amount);
  return amount === null ? null : { address, amount };
}

function addAmount(holders, address, amount) {
  if (amount <= 0n) return;
  holders.set(address, (holders.get(address) || 0n) + amount);
}

function isScanLimitError(error) {
  return error instanceof SolanaHolderScanLimitError ||
    error instanceof SolanaRpcError && (
      error.kind === 'response-too-large' ||
      error.code === -32005 ||
      /too (?:many|large)|limit|response size|scan/i.test(error.message)
    );
}

function sharePercent(amount, supply) {
  if (!(supply > 0n)) return null;
  const scaled = amount * 1_000_000n / supply;
  return Number(scaled) / 10_000;
}

function publicHolderRows(holders, {
  limit,
  decimals,
  supply,
  snapshotAt,
  source
}) {
  return [...holders.entries()]
    .sort((left, right) => left[1] === right[1] ? left[0].localeCompare(right[0]) : left[1] > right[1] ? -1 : 1)
    .slice(0, limit)
    .map(([address, amount], index) => ({
      address,
      holderRank: index + 1,
      holdingTokenAmount: formatSolanaTokenAmount(amount, decimals),
      rawHoldingTokenAmount: amount.toString(),
      holdingSharePercent: sharePercent(amount, supply),
      holdingValueUsd: null,
      holderSnapshotAt: snapshotAt,
      holderSource: source,
      isContract: false,
      proxyType: null,
      contractName: null,
      verifiedContract: false,
      excluded: false,
      exclusionReasons: []
    }));
}

export class SolanaHolderScanLimitError extends Error {
  constructor(message, { accountCount = null, maximum = null, cause } = {}) {
    super(message, cause ? { cause } : undefined);
    this.name = 'SolanaHolderScanLimitError';
    this.accountCount = accountCount;
    this.maximum = maximum;
  }
}

export class SolanaHolderClient {
  constructor({
    rpcClient,
    maxAccounts = 50_000,
    maxResponseBytes = 24 * 1024 * 1024,
    fallbackLimit = 20
  } = {}) {
    if (!rpcClient?.getProgramAccountsForMint || !rpcClient?.getTokenLargestAccounts ||
      !rpcClient?.getMultipleAccounts) {
      throw new TypeError('A Solana RPC client is required');
    }
    this.rpcClient = rpcClient;
    this.maxAccounts = boundedInteger(maxAccounts, 50_000, 1, 1_000_000);
    this.maxResponseBytes = boundedInteger(maxResponseBytes, 24 * 1024 * 1024, 64 * 1024, 256 * 1024 * 1024);
    this.fallbackLimit = boundedInteger(fallbackLimit, 20, 1, 20);
  }

  async fetchTopHolders(tokenAddress, { limit = 150, signal } = {}) {
    const mint = normalizeSolanaAddress(tokenAddress);
    const target = boundedInteger(limit, 150, 1, 1_000);
    const supply = await this.#fetchSupply(mint, { signal });
    try {
      return await this.#fetchAllTokenAccounts(mint, target, supply, { signal });
    } catch (error) {
      if (!isScanLimitError(error)) throw error;
      return this.#fetchLargestAccounts(mint, target, supply, error, { signal });
    }
  }

  async #fetchSupply(mint, { signal }) {
    if (typeof this.rpcClient.getTokenSupply !== 'function') return { amount: null, decimals: 0 };
    try {
      const value = await this.rpcClient.getTokenSupply(mint, { signal });
      return {
        amount: parseRawAmount(value.amount),
        decimals: boundedInteger(value.decimals, 0, 0, 255)
      };
    } catch (error) {
      if (signal?.aborted) throw error;
      return { amount: null, decimals: 0 };
    }
  }

  async #fetchAllTokenAccounts(mint, target, supply, { signal }) {
    const holders = new Map();
    let scannedAccounts = 0;
    for (const program of [SPL_TOKEN_PROGRAM_ID, SPL_TOKEN_2022_PROGRAM_ID]) {
      const rows = await this.rpcClient.getProgramAccountsForMint(program, mint, {
        signal,
        maxResponseBytes: this.maxResponseBytes
      });
      scannedAccounts += rows.length;
      if (scannedAccounts > this.maxAccounts) {
        throw new SolanaHolderScanLimitError(
          `Solana holder scan returned ${scannedAccounts} accounts; maximum is ${this.maxAccounts}`,
          { accountCount: scannedAccounts, maximum: this.maxAccounts }
        );
      }
      for (const row of rows) {
        const holder = holderDataFromProgramAccount(row);
        if (holder) addAmount(holders, holder.address, holder.amount);
      }
    }

    const verified = await this.#verifiedWalletOwners(holders, target, { signal });
    const snapshotAt = new Date().toISOString();
    const source = 'solana_rpc_program_accounts';
    return {
      token: {
        address: mint,
        decimals: supply.decimals,
        totalSupply: supply.amount === null ? null : formatSolanaTokenAmount(supply.amount, supply.decimals)
      },
      holders: publicHolderRows(verified, {
        limit: target,
        decimals: supply.decimals,
        supply: supply.amount,
        snapshotAt,
        source
      }),
      requested: target,
      reachedEnd: true,
      partial: false,
      scannedAccounts,
      snapshotAt,
      source
    };
  }

  async #fetchLargestAccounts(mint, target, supply, originalError, { signal }) {
    const rows = await this.rpcClient.getTokenLargestAccounts(mint, { signal });
    const selected = rows.slice(0, Math.min(target, this.fallbackLimit));
    const accounts = selected.map((row) => normalizeSolanaAddress(row.address));
    const parsed = accounts.length
      ? await this.rpcClient.getMultipleAccounts(accounts, { signal, encoding: 'jsonParsed' })
      : [];
    const holders = new Map();
    for (let index = 0; index < parsed.length; index += 1) {
      const owner = holderOwnerFromParsedAccount(parsed[index]);
      const fallbackAmount = parseRawAmount(selected[index]?.amount);
      if (!owner) continue;
      addAmount(holders, owner.address, fallbackAmount ?? owner.amount);
    }

    const verified = await this.#verifiedWalletOwners(holders, Math.min(target, this.fallbackLimit), {
      signal,
      multiplier: 1
    });
    const snapshotAt = new Date().toISOString();
    const source = 'solana_rpc_largest_accounts';
    return {
      token: {
        address: mint,
        decimals: supply.decimals,
        totalSupply: supply.amount === null ? null : formatSolanaTokenAmount(supply.amount, supply.decimals)
      },
      holders: publicHolderRows(verified, {
        limit: Math.min(target, this.fallbackLimit),
        decimals: supply.decimals,
        supply: supply.amount,
        snapshotAt,
        source
      }),
      requested: target,
      reachedEnd: false,
      partial: true,
      scannedAccounts: null,
      fallbackReason: originalError instanceof Error ? originalError.message : String(originalError),
      snapshotAt,
      source
    };
  }

  async #verifiedWalletOwners(holders, target, { signal, multiplier = 3 } = {}) {
    const candidates = [...holders.entries()]
      .sort((left, right) => left[1] === right[1]
        ? left[0].localeCompare(right[0])
        : left[1] > right[1] ? -1 : 1)
      .slice(0, Math.min(holders.size, Math.max(target, target * multiplier)));
    const verified = new Map();
    for (let index = 0; index < candidates.length && verified.size < target; index += 100) {
      const chunk = candidates.slice(index, index + 100);
      const accounts = await this.rpcClient.getMultipleAccounts(
        chunk.map(([address]) => address),
        { signal, encoding: 'base64' }
      );
      for (let offset = 0; offset < accounts.length && verified.size < target; offset += 1) {
        const account = accounts[offset];
        if (!account || account.executable === true || account.owner !== SOLANA_SYSTEM_PROGRAM_ID) continue;
        const [address, amount] = chunk[offset];
        verified.set(address, amount);
      }
    }
    return verified;
  }
}
