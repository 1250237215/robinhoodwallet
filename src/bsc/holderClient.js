import { BSC_CHAIN, isBscAddress, normalizeBscAddress } from './config.js';

export const ERC20_TRANSFER_TOPIC = '0xddf252ad1be2c89b69c2b068fc378daa952ba7f163c4a11628f55a4df523b3ef';

const ZERO_ADDRESS = '0x0000000000000000000000000000000000000000';
const DEAD_ADDRESSES = new Set([
  ZERO_ADDRESS,
  '0x000000000000000000000000000000000000dead'
]);
const DECIMALS_CALL = '0x313ce567';
const TOTAL_SUPPLY_CALL = '0x18160ddd';
const BALANCE_OF_CALL = '0x70a08231';
const RANGE_ERROR_PATTERN =
  /(?:too many|more than)\s+(?:results?|logs?)|query returned (?:more than|\d+)|(?:result|response) (?:size|limit).*(?:exceed|too large)|block range|range (?:is )?too (?:large|wide)|limit exceeded|exceed(?:s|ed)? (?:the )?(?:maximum|max)(?: (?:block )?range)?|(?:eth_getlogs|logs?) (?:is|are) limited to .*?(?:block )?range|please limit (?:the )?(?:query|block range)/i;

function boundedInteger(value, fallback, minimum, maximum) {
  const number = Number(value);
  if (!Number.isFinite(number)) return fallback;
  return Math.max(minimum, Math.min(maximum, Math.floor(number)));
}

function blockTag(value) {
  const number = Number(value);
  if (!Number.isSafeInteger(number) || number < 0) throw new TypeError('Invalid BSC block number');
  return `0x${number.toString(16)}`;
}

function rpcInteger(value, label) {
  if (typeof value !== 'string' || !/^0x[0-9a-f]+$/i.test(value)) {
    throw new BscHolderIntegrityError(`BSC RPC returned an invalid ${label}`, { code: 'INVALID_RPC_VALUE' });
  }
  const number = Number(BigInt(value));
  if (!Number.isSafeInteger(number) || number < 0) {
    throw new BscHolderIntegrityError(`BSC RPC returned an unsafe ${label}`, { code: 'INVALID_RPC_VALUE' });
  }
  return number;
}

function uint256(value, label) {
  if (typeof value !== 'string' || !/^0x[0-9a-f]{1,64}$/i.test(value)) {
    throw new BscHolderIntegrityError(`BSC RPC returned an invalid ${label}`, { code: 'INVALID_RPC_VALUE' });
  }
  return BigInt(value);
}

function emptyCode(value) {
  return typeof value === 'string' && /^0x0*$/i.test(value);
}

function delegatedAccountCode(value) {
  return typeof value === 'string' && /^0xef0100[0-9a-f]{40}$/i.test(value);
}

function addressFromTopic(value) {
  const topic = String(value || '').toLowerCase();
  if (!/^0x[0-9a-f]{64}$/.test(topic)) return null;
  const address = `0x${topic.slice(-40)}`;
  return isBscAddress(address) ? address : null;
}

function rawTransferAmount(value) {
  const data = String(value || '').toLowerCase();
  if (!/^0x[0-9a-f]{64}$/.test(data)) return null;
  return BigInt(data);
}

function formatTokenAmount(rawAmount, decimals) {
  const places = boundedInteger(decimals, 0, 0, 255);
  if (places === 0) return rawAmount.toString();
  const digits = rawAmount.toString().padStart(places + 1, '0');
  const whole = digits.slice(0, -places);
  const fraction = digits.slice(-places).replace(/0+$/, '');
  return fraction ? `${whole}.${fraction}` : whole;
}

function holdingSharePercent(amount, supply) {
  if (!(supply > 0n)) return null;
  const scaled = amount * 1_000_000n / supply;
  return Number(scaled) / 10_000;
}

function abortError(signal) {
  if (!signal?.aborted) return null;
  if (signal.reason instanceof Error) return signal.reason;
  const error = new Error('BSC Holder scan was aborted');
  error.name = 'AbortError';
  return error;
}

function throwIfAborted(signal) {
  const error = abortError(signal);
  if (error) throw error;
}

async function allWithSiblingCancellation(loaders, parentSignal) {
  const controller = new AbortController();
  const signal = parentSignal
    ? AbortSignal.any([parentSignal, controller.signal])
    : controller.signal;
  try {
    return await Promise.all(loaders.map((load) => load(signal)));
  } catch (error) {
    if (!controller.signal.aborted) controller.abort(error);
    throw error;
  }
}

function errorMessage(error) {
  return error instanceof Error ? error.message : String(error || 'unknown error');
}

function rangeLimited(error) {
  return error?.code === -32005 || error?.status === 413 || RANGE_ERROR_PATTERN.test(errorMessage(error));
}

export class BscHolderIntegrityError extends Error {
  constructor(message, { code = 'BSC_HOLDER_INTEGRITY', cause } = {}) {
    super(message, cause ? { cause } : undefined);
    this.name = 'BscHolderIntegrityError';
    this.code = code;
  }
}

export class BscHolderScanLimitError extends BscHolderIntegrityError {
  constructor(message, { code = 'BSC_HOLDER_SCAN_LIMIT', cause } = {}) {
    super(message, { code, cause });
    this.name = 'BscHolderScanLimitError';
  }
}

function normalizeTransferLog(log, tokenAddress) {
  if (normalizeBscAddress(log?.address) !== tokenAddress) {
    throw new BscHolderIntegrityError('BSC RPC returned a Transfer log for a different token', {
      code: 'INVALID_TRANSFER_LOG'
    });
  }
  const topics = Array.isArray(log?.topics) ? log.topics : [];
  if (String(topics[0] || '').toLowerCase() !== ERC20_TRANSFER_TOPIC || topics.length !== 3) {
    throw new BscHolderIntegrityError('BSC RPC returned a malformed ERC-20 Transfer topic set', {
      code: 'INVALID_TRANSFER_LOG'
    });
  }
  const from = addressFromTopic(topics[1]);
  const to = addressFromTopic(topics[2]);
  const amount = rawTransferAmount(log?.data);
  const txHash = String(log?.transactionHash || '').toLowerCase();
  const blockNumber = rpcInteger(String(log?.blockNumber || ''), 'Transfer block number');
  if (!from || !to || amount === null || !/^0x[0-9a-f]{64}$/.test(txHash) || log?.removed === true) {
    throw new BscHolderIntegrityError('BSC RPC returned a malformed ERC-20 Transfer log', {
      code: 'INVALID_TRANSFER_LOG'
    });
  }
  const transactionIndex = rpcInteger(String(log?.transactionIndex ?? ''), 'Transfer transaction index');
  const logIndex = rpcInteger(String(log?.logIndex ?? ''), 'Transfer log index');
  return {
    from,
    to,
    amount,
    txHash,
    blockNumber,
    transactionIndex,
    logIndex,
    key: `${txHash}:${logIndex}`
  };
}

function replayTransfers(logs) {
  const balances = new Map();
  for (const transfer of logs) {
    if (transfer.from !== ZERO_ADDRESS) {
      const current = balances.get(transfer.from) || 0n;
      if (current < transfer.amount) {
        throw new BscHolderIntegrityError(
          `BSC Transfer history starts too late or is incomplete at block ${transfer.blockNumber}`,
          { code: 'INCOMPLETE_TRANSFER_HISTORY' }
        );
      }
      const next = current - transfer.amount;
      if (next === 0n) balances.delete(transfer.from);
      else balances.set(transfer.from, next);
    }
    if (transfer.to !== ZERO_ADDRESS && transfer.amount > 0n) {
      balances.set(transfer.to, (balances.get(transfer.to) || 0n) + transfer.amount);
    }
  }
  return balances;
}

function sortedBalances(balances) {
  return [...balances.entries()]
    .filter(([address, amount]) => isBscAddress(address) && amount > 0n && address !== ZERO_ADDRESS)
    .sort((left, right) => left[1] === right[1]
      ? left[0].localeCompare(right[0])
      : left[1] > right[1] ? -1 : 1);
}

export class BscHolderClient {
  constructor({
    rpcClient,
    debotClient = null,
    creationTimeClient = null,
    infrastructureAddresses = BSC_CHAIN.infrastructureAddresses,
    logWindow = 2_000,
    logConcurrency = 2,
    logResultGuard = 1_000,
    maxTransferLogs = 100_000,
    maxBlockSpan = 5_000_000,
    creationSafetySeconds = 86_400,
    rpcBatchSize = 20,
    maxBalanceChecks = 20_000,
    maxContractChecks = 1_000,
    now = Date.now
  } = {}) {
    if (!rpcClient?.request || !rpcClient?.batchRequest || !rpcClient?.getBlockNumber ||
      !rpcClient?.findBlockByTimestamp || !rpcClient?.call) {
      throw new TypeError('A complete BSC RPC client is required');
    }
    if (debotClient !== null && typeof debotClient?.fetchTokenDetail !== 'function') {
      throw new TypeError('A DeBot token detail client is required');
    }
    if (creationTimeClient !== null && typeof creationTimeClient?.fetchTokenMetrics !== 'function') {
      throw new TypeError('A BSC token creation-time client is required');
    }
    if (typeof now !== 'function') throw new TypeError('A clock function is required');
    this.rpcClient = rpcClient;
    this.debotClient = debotClient;
    this.creationTimeClient = creationTimeClient;
    this.now = now;
    this.infrastructureAddresses = new Set(
      (Array.isArray(infrastructureAddresses) ? infrastructureAddresses : [])
        .map(normalizeBscAddress)
        .filter(isBscAddress)
    );
    this.logWindow = boundedInteger(logWindow, 2_000, 1, 20_000);
    this.logConcurrency = boundedInteger(logConcurrency, 2, 1, 4);
    this.logResultGuard = boundedInteger(logResultGuard, 1_000, 100, 10_000);
    this.maxTransferLogs = boundedInteger(maxTransferLogs, 100_000, 1_000, 1_000_000);
    this.maxBlockSpan = boundedInteger(maxBlockSpan, 5_000_000, 1_000, 50_000_000);
    this.creationSafetySeconds = boundedInteger(creationSafetySeconds, 86_400, 60, 2_592_000);
    this.rpcBatchSize = boundedInteger(rpcBatchSize, 20, 1, 50);
    this.maxBalanceChecks = boundedInteger(maxBalanceChecks, 20_000, 100, 100_000);
    this.maxContractChecks = boundedInteger(maxContractChecks, 1_000, 100, 10_000);
  }

  async fetchTopHolders(tokenAddress, { limit = 150, signal } = {}) {
    const address = normalizeBscAddress(tokenAddress);
    if (!isBscAddress(address)) throw new TypeError('Invalid BSC token address');
    throwIfAborted(signal);
    const target = boundedInteger(limit, 150, 1, 1_000);
    const latestBlock = await this.rpcClient.getBlockNumber({ signal });
    const start = await this.#resolveHistoryStart(address, latestBlock, { signal });
    const scannedBlocks = latestBlock - start.block + 1;
    if (scannedBlocks > this.maxBlockSpan) {
      throw new BscHolderScanLimitError(
        `BSC Holder scan requires ${scannedBlocks} blocks; configured maximum is ${this.maxBlockSpan}`,
        { code: 'BLOCK_SPAN_LIMIT' }
      );
    }

    const [metadata, rawLogs] = await allWithSiblingCancellation([
      (sourceSignal) => this.#tokenMetadata(address, latestBlock, { signal: sourceSignal }),
      (sourceSignal) => this.#scanTransferLogs(address, start.block, latestBlock, { signal: sourceSignal })
    ], signal);
    const logs = this.#normalizeLogs(rawLogs, address);
    const balances = replayTransfers(logs);
    const entries = sortedBalances(balances);
    const ledgerSupply = entries.reduce((sum, [, amount]) => sum + amount, 0n);
    if (ledgerSupply !== metadata.totalSupplyRaw) {
      throw new BscHolderIntegrityError(
        `BSC Transfer ledger supply ${ledgerSupply} does not match totalSupply ${metadata.totalSupplyRaw}`,
        { code: 'SUPPLY_RECONCILIATION_FAILED' }
      );
    }

    if (!start.reliable) {
      if (entries.length > this.maxBalanceChecks) {
        throw new BscHolderScanLimitError(
          `BSC fallback start requires ${entries.length} balance checks; configured maximum is ${this.maxBalanceChecks}`,
          { code: 'BALANCE_CHECK_LIMIT' }
        );
      }
      await this.#verifyBalances(address, entries, latestBlock, { signal });
    }

    const selected = await this.#selectWalletHolders(address, entries, metadata, target, latestBlock, { signal });
    await this.#verifyBalances(
      address,
      selected.map((item) => [item.row.address, item.amount]),
      latestBlock,
      { signal }
    );
    const snapshotAt = new Date().toISOString();
    const source = 'bsc_rpc_transfer_ledger';
    return {
      token: {
        address,
        decimals: metadata.decimals,
        totalSupply: formatTokenAmount(metadata.totalSupplyRaw, metadata.decimals),
        rawTotalSupply: metadata.totalSupplyRaw.toString(),
        holders: entries.length
      },
      holders: selected.map(({ row }) => ({ ...row, holderSnapshotAt: snapshotAt, holderSource: source })),
      requested: target,
      reachedEnd: true,
      partial: false,
      complete: true,
      deploymentBlock: start.block,
      deploymentBlockSource: start.source,
      historyStartReliable: start.reliable,
      historyStartValidation: start.reliable
        ? 'historical_code_boundary_and_supply_reconciliation'
        : 'supply_and_all_observed_balance_reconciliation',
      firstTransferBlock: logs[0]?.blockNumber ?? null,
      latestBlock,
      scannedBlocks,
      scannedLogs: logs.length,
      snapshotAt,
      source
    };
  }

  async #resolveHistoryStart(address, latestBlock, { signal }) {
    let historicalError;
    try {
      return await this.#historicalCodeStart(address, latestBlock, { signal });
    } catch (error) {
      throwIfAborted(signal);
      if (error?.code === 'TOKEN_HAS_NO_CODE') throw error;
      historicalError = error;
    }

    if (!this.debotClient && !this.creationTimeClient) {
      throw new BscHolderIntegrityError(
        `BSC deployment block is unavailable and no creation-time fallback is configured: ${errorMessage(historicalError)}`,
        { code: 'UNRELIABLE_HISTORY_START', cause: historicalError }
      );
    }
    const fallbackErrors = [];
    const sources = [];
    if (this.debotClient) {
      sources.push({
        name: 'debot_creation_time_with_safety_buffer',
        load: () => this.debotClient.fetchTokenDetail(address, { signal })
      });
    }
    if (this.creationTimeClient) {
      sources.push({
        name: 'market_creation_time_with_safety_buffer',
        load: () => this.creationTimeClient.fetchTokenMetrics(address, { signal })
      });
    }
    for (const source of sources) {
      try {
        const detail = await source.load();
        const creationTimestamp = Number(detail?.creationTimestamp);
        if (!Number.isFinite(creationTimestamp) || creationTimestamp <= 0) {
          throw new Error('token detail has no creation timestamp');
        }
        const safeTimestamp = Math.max(0, Math.floor(creationTimestamp) - this.creationSafetySeconds);
        const ageSeconds = Math.max(0, Math.floor(this.now() / 1_000) - safeTimestamp);
        const estimatedLookback = Math.min(
          this.maxBlockSpan - 1,
          Math.max(1_000, Math.ceil(ageSeconds * 5) + 1_000)
        );
        const lowBlock = Math.max(0, latestBlock - estimatedLookback);
        const block = await this.rpcClient.findBlockByTimestamp(safeTimestamp, {
          lowBlock,
          highBlock: latestBlock,
          signal
        });
        return {
          block,
          source: source.name,
          reliable: false,
          creationTimestamp: Math.floor(creationTimestamp),
          fallbackSearchLowBlock: lowBlock,
          historicalCodeError: errorMessage(historicalError),
          fallbackErrors
        };
      } catch (fallbackError) {
        throwIfAborted(signal);
        fallbackErrors.push(`${source.name}: ${errorMessage(fallbackError)}`);
      }
    }
    const fallbackError = new Error(fallbackErrors.join('; ') || 'no creation timestamp source succeeded');
    throw new BscHolderIntegrityError(
      `BSC Holder history start is unverifiable: historical code ${errorMessage(historicalError)}; ` +
      `creation-time fallbacks ${errorMessage(fallbackError)}`,
      { code: 'UNRELIABLE_HISTORY_START', cause: fallbackError }
    );
  }

  async #historicalCodeStart(address, latestBlock, { signal }) {
    const latestCode = await this.#codeAt(address, latestBlock, { signal });
    if (emptyCode(latestCode)) {
      throw new BscHolderIntegrityError('BSC token address has no contract code at the snapshot block', {
        code: 'TOKEN_HAS_NO_CODE'
      });
    }
    let low = 0;
    let high = latestBlock;
    while (low < high) {
      throwIfAborted(signal);
      const middle = low + Math.floor((high - low) / 2);
      const code = await this.#codeAt(address, middle, { signal });
      if (emptyCode(code)) low = middle + 1;
      else high = middle;
    }
    const candidateCode = low === latestBlock ? latestCode : await this.#codeAt(address, low, { signal });
    if (emptyCode(candidateCode)) {
      throw new BscHolderIntegrityError('BSC historical code search did not find a deployment block', {
        code: 'UNRELIABLE_HISTORY_START'
      });
    }
    if (low > 0) {
      const previousCode = await this.#codeAt(address, low - 1, { signal });
      if (!emptyCode(previousCode)) {
        throw new BscHolderIntegrityError('BSC historical code boundary could not be verified', {
          code: 'UNRELIABLE_HISTORY_START'
        });
      }
    }
    return { block: low, source: 'bsc_rpc_historical_code', reliable: true };
  }

  async #codeAt(address, blockNumber, { signal }) {
    const value = await this.rpcClient.request(
      'eth_getCode',
      [address, blockTag(blockNumber)],
      { signal }
    );
    if (typeof value !== 'string' || !/^0x[0-9a-f]*$/i.test(value)) {
      throw new BscHolderIntegrityError('BSC RPC returned invalid contract code', {
        code: 'INVALID_RPC_VALUE'
      });
    }
    return value.toLowerCase();
  }

  async #tokenMetadata(address, blockNumber, { signal }) {
    const [decimalsValue, totalSupplyValue] = await Promise.all([
      this.rpcClient.call({ to: address, data: DECIMALS_CALL }, { block: blockNumber, signal }),
      this.rpcClient.call({ to: address, data: TOTAL_SUPPLY_CALL }, { block: blockNumber, signal })
    ]);
    const decimalsRaw = uint256(decimalsValue, 'token decimals');
    if (decimalsRaw > 255n) {
      throw new BscHolderIntegrityError('BSC token decimals exceed 255', { code: 'INVALID_TOKEN_METADATA' });
    }
    return {
      decimals: Number(decimalsRaw),
      totalSupplyRaw: uint256(totalSupplyValue, 'token totalSupply')
    };
  }

  async #scanTransferLogs(address, fromBlock, toBlock, { signal }) {
    const windows = [];
    for (let start = fromBlock; start <= toBlock; start += this.logWindow) {
      windows.push([start, Math.min(toBlock, start + this.logWindow - 1)]);
    }
    const controller = new AbortController();
    const abortFromParent = () => controller.abort(
      signal?.reason instanceof Error ? signal.reason : new Error('BSC Holder scan was aborted')
    );
    if (signal?.aborted) abortFromParent();
    else signal?.addEventListener('abort', abortFromParent, { once: true });

    const pages = new Array(windows.length);
    let cursor = 0;
    let observedLogs = 0;
    let firstError = null;
    const worker = async () => {
      while (!firstError) {
        throwIfAborted(controller.signal);
        const index = cursor;
        cursor += 1;
        if (index >= windows.length) return;
        const [start, end] = windows[index];
        try {
          const rows = await this.#fetchCompleteLogRange(address, start, end, {
            signal: controller.signal
          });
          if (firstError) return;
          observedLogs += rows.length;
          if (observedLogs > this.maxTransferLogs) {
            throw new BscHolderScanLimitError(
              `BSC Holder scan exceeded ${this.maxTransferLogs} Transfer logs`,
              { code: 'TRANSFER_LOG_LIMIT' }
            );
          }
          pages[index] = rows;
        } catch (error) {
          firstError ||= abortError(signal) || error;
          if (!controller.signal.aborted) controller.abort(firstError);
          return;
        }
      }
    };

    try {
      await Promise.all(Array.from(
        { length: Math.min(windows.length, this.logConcurrency) },
        () => worker()
      ));
    } finally {
      signal?.removeEventListener('abort', abortFromParent);
    }
    if (firstError) throw firstError;
    throwIfAborted(signal);
    return pages.flat();
  }

  async #fetchCompleteLogRange(address, fromBlock, toBlock, { signal }) {
    let rows;
    try {
      rows = await this.rpcClient.request('eth_getLogs', [{
        address,
        topics: [ERC20_TRANSFER_TOPIC],
        fromBlock: blockTag(fromBlock),
        toBlock: blockTag(toBlock)
      }], { signal, maxRetries: 2 });
    } catch (error) {
      throwIfAborted(signal);
      if (!rangeLimited(error)) throw error;
      if (fromBlock === toBlock) {
        throw new BscHolderScanLimitError(
          `BSC RPC cannot return a provably complete Transfer log set for block ${fromBlock}`,
          { code: 'UNVERIFIABLE_LOG_WINDOW', cause: error }
        );
      }
      return this.#splitLogRange(address, fromBlock, toBlock, { signal });
    }
    if (!Array.isArray(rows)) {
      throw new BscHolderIntegrityError('BSC RPC returned a non-array Transfer log response', {
        code: 'INVALID_LOG_RESPONSE'
      });
    }
    if (rows.length >= this.logResultGuard) {
      if (fromBlock === toBlock) {
        throw new BscHolderScanLimitError(
          `BSC block ${fromBlock} returned ${rows.length} Transfer logs at the truncation guard`,
          { code: 'UNVERIFIABLE_LOG_WINDOW' }
        );
      }
      return this.#splitLogRange(address, fromBlock, toBlock, { signal });
    }
    return rows;
  }

  async #splitLogRange(address, fromBlock, toBlock, { signal }) {
    const middle = fromBlock + Math.floor((toBlock - fromBlock) / 2);
    const left = await this.#fetchCompleteLogRange(address, fromBlock, middle, { signal });
    const right = await this.#fetchCompleteLogRange(address, middle + 1, toBlock, { signal });
    if (left.length + right.length > this.maxTransferLogs) {
      throw new BscHolderScanLimitError(
        `BSC Holder scan exceeded ${this.maxTransferLogs} Transfer logs`,
        { code: 'TRANSFER_LOG_LIMIT' }
      );
    }
    return [...left, ...right];
  }

  #normalizeLogs(rawLogs, address) {
    const seen = new Set();
    const logs = [];
    for (const raw of rawLogs) {
      const transfer = normalizeTransferLog(raw, address);
      if (seen.has(transfer.key)) continue;
      seen.add(transfer.key);
      logs.push(transfer);
    }
    logs.sort((left, right) =>
      left.blockNumber - right.blockNumber ||
      left.transactionIndex - right.transactionIndex ||
      left.logIndex - right.logIndex
    );
    if (logs.length > this.maxTransferLogs) {
      throw new BscHolderScanLimitError(
        `BSC Holder scan exceeded ${this.maxTransferLogs} unique Transfer logs`,
        { code: 'TRANSFER_LOG_LIMIT' }
      );
    }
    return logs;
  }

  async #selectWalletHolders(tokenAddress, entries, metadata, target, blockNumber, { signal }) {
    const selected = [];
    const knownInfrastructure = new Set([...this.infrastructureAddresses, tokenAddress]);
    let inspected = 0;
    for (let index = 0; index < entries.length && selected.length < target; index += this.rpcBatchSize) {
      throwIfAborted(signal);
      const chunk = entries.slice(index, index + this.rpcBatchSize);
      inspected += chunk.length;
      if (inspected > this.maxContractChecks) {
        throw new BscHolderScanLimitError(
          `BSC Holder scan requires more than ${this.maxContractChecks} contract checks`,
          { code: 'CONTRACT_CHECK_LIMIT' }
        );
      }
      const checks = chunk.map(([address]) => ({
        address,
        skipped: DEAD_ADDRESSES.has(address) || knownInfrastructure.has(address)
      }));
      const query = checks.filter((item) => !item.skipped);
      const codes = query.length
        ? await this.rpcClient.batchRequest(
            query.map((item) => ({ method: 'eth_getCode', params: [item.address, blockTag(blockNumber)] })),
            { signal }
          )
        : [];
      const codeByAddress = new Map(query.map((item, offset) => [item.address, codes[offset]]));
      for (let offset = 0; offset < chunk.length && selected.length < target; offset += 1) {
        const [address, amount] = chunk[offset];
        if (checks[offset].skipped) continue;
        const code = codeByAddress.get(address);
        if (typeof code !== 'string' || !/^0x[0-9a-f]*$/i.test(code)) {
          throw new BscHolderIntegrityError('BSC RPC returned invalid Holder contract code', {
            code: 'INVALID_RPC_VALUE'
          });
        }
        const delegated = delegatedAccountCode(code);
        if (!emptyCode(code) && !delegated) continue;
        selected.push({
          amount,
          row: {
            address,
            holderRank: index + offset + 1,
            holdingTokenAmount: formatTokenAmount(amount, metadata.decimals),
            rawHoldingTokenAmount: amount.toString(),
            holdingSharePercent: holdingSharePercent(amount, metadata.totalSupplyRaw),
            holdingValueUsd: null,
            isContract: delegated,
            proxyType: delegated ? 'eip7702' : null,
            contractName: null,
            verifiedContract: false,
            excluded: false,
            exclusionReasons: []
          }
        });
      }
    }
    return selected;
  }

  async #verifyBalances(tokenAddress, entries, blockNumber, { signal }) {
    for (let index = 0; index < entries.length; index += this.rpcBatchSize) {
      throwIfAborted(signal);
      const chunk = entries.slice(index, index + this.rpcBatchSize);
      const values = await this.rpcClient.batchRequest(
        chunk.map(([address]) => ({
          method: 'eth_call',
          params: [{
            to: tokenAddress,
            data: `${BALANCE_OF_CALL}${address.slice(2).padStart(64, '0')}`
          }, blockTag(blockNumber)]
        })),
        { signal }
      );
      for (let offset = 0; offset < chunk.length; offset += 1) {
        const [address, expected] = chunk[offset];
        const actual = uint256(values[offset], `balanceOf(${address})`);
        if (actual !== expected) {
          throw new BscHolderIntegrityError(
            `BSC Transfer ledger balance for ${address} does not match balanceOf`,
            { code: 'BALANCE_RECONCILIATION_FAILED' }
          );
        }
      }
    }
  }
}
