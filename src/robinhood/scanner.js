import {
  decodeEventLog,
  decodeFunctionResult,
  encodeFunctionData,
  formatUnits,
  parseAbi,
  parseAbiItem
} from 'viem';

import { ROBINHOOD_CHAIN, createRobinhoodConfig } from './config.js';
import { chooseMainPool } from './poolClient.js';
import { deriveTokenQualification } from './qualification.js';
import { RobinhoodRpcClient } from './rpcClient.js';

export const V3_SWAP_EVENT = parseAbiItem(
  'event Swap(address indexed sender, address indexed recipient, int256 amount0, int256 amount1, uint160 sqrtPriceX96, uint128 liquidity, int24 tick)'
);
export const V2_SWAP_EVENT = parseAbiItem(
  'event Swap(address indexed sender, uint256 amount0In, uint256 amount1In, uint256 amount0Out, uint256 amount1Out, address indexed to)'
);

const POOL_READ_ABI = parseAbi([
  'function token0() view returns (address)',
  'function token1() view returns (address)',
  'function factory() view returns (address)',
  'function fee() view returns (uint24)',
  'function getReserves() view returns (uint112 reserve0, uint112 reserve1, uint32 blockTimestampLast)'
]);

const ERC20_READ_ABI = parseAbi(['function decimals() view returns (uint8)']);

function normalizeAddress(value) {
  return String(value || '').toLowerCase();
}

function hexNumber(value) {
  if (typeof value === 'number') return value;
  if (typeof value === 'bigint') return Number(value);
  return Number.parseInt(String(value || '0'), 16);
}

function validAddress(value) {
  return /^0x[0-9a-f]{40}$/.test(normalizeAddress(value));
}

function toUnixSeconds(value) {
  const number = Number(value);
  if (!Number.isFinite(number) || number <= 0) return null;
  return Math.floor(number > 10_000_000_000 ? number / 1000 : number);
}

function blockTag(value) {
  return `0x${Number(value).toString(16)}`;
}

async function readFunction(rpc, address, functionName, args = [], { signal } = {}) {
  const data = encodeFunctionData({ abi: POOL_READ_ABI, functionName, args });
  const result = await rpc.ethCall({ to: address, data }, { signal });
  return decodeFunctionResult({ abi: POOL_READ_ABI, functionName, data: result });
}

async function readDecimals(rpc, address, fallback, { signal } = {}) {
  if (Number.isInteger(Number(fallback)) && Number(fallback) >= 0 && Number(fallback) <= 255) {
    return Number(fallback);
  }
  const data = encodeFunctionData({ abi: ERC20_READ_ABI, functionName: 'decimals' });
  const result = await rpc.ethCall({ to: address, data }, { signal });
  return Number(decodeFunctionResult({ abi: ERC20_READ_ABI, functionName: 'decimals', data: result }));
}

export async function verifyPoolOnchain({ pool, targetToken, rpc, signal }) {
  if (!pool || !validAddress(pool.address)) throw new Error('A valid pool address is required');
  const address = normalizeAddress(pool.address);
  const code = await rpc.request('eth_getCode', [address, 'latest'], { signal });
  if (!code || code === '0x' || code === '0x0') throw new Error('Pool hint has no onchain bytecode');
  const [token0, token1, factory] = await Promise.all([
    readFunction(rpc, address, 'token0', [], { signal }),
    readFunction(rpc, address, 'token1', [], { signal }),
    readFunction(rpc, address, 'factory', [], { signal })
  ]);
  const normalizedToken0 = normalizeAddress(token0);
  const normalizedToken1 = normalizeAddress(token1);
  const normalizedFactory = normalizeAddress(factory);
  const target = normalizeAddress(targetToken);
  if (![normalizedToken0, normalizedToken1].includes(target)) {
    throw new Error('Pool hint does not contain the target token');
  }
  const expectedFactory = pool.version === 'v2' ? ROBINHOOD_CHAIN.v2Factory : ROBINHOOD_CHAIN.v3Factory;
  if (normalizedFactory !== expectedFactory) {
    throw new Error(`Pool factory is not the verified Robinhood ${String(pool.version).toUpperCase()} factory`);
  }
  let feeBps = 30;
  if (pool.version === 'v3') {
    const fee = Number(await readFunction(rpc, address, 'fee', [], { signal }));
    feeBps = Number.isFinite(fee) ? fee / 100 : null;
  }
  return {
    ...pool,
    address,
    token0: normalizedToken0,
    token1: normalizedToken1,
    factory: normalizedFactory,
    feeBps,
    verified: true,
    verificationSource: 'robinhood_rpc'
  };
}

function decimal(value, decimals) {
  return Number(formatUnits(value < 0n ? -value : value, decimals));
}

export function decodePoolSwap({
  version,
  log,
  token0,
  token1,
  targetToken,
  quoteToken,
  targetDecimals,
  quoteDecimals
}) {
  const target = normalizeAddress(targetToken);
  const quote = normalizeAddress(quoteToken);
  const token0Address = normalizeAddress(token0);
  const token1Address = normalizeAddress(token1);
  if (!([token0Address, token1Address].includes(target) && [token0Address, token1Address].includes(quote))) {
    throw new Error('Pool tokens do not match the requested target and quote');
  }

  const abi = version === 'v2' ? [V2_SWAP_EVENT] : [V3_SWAP_EVENT];
  const decoded = decodeEventLog({ abi, data: log.data, topics: log.topics, strict: true });
  let side;
  let tokenAmountRaw;
  let quoteAmountRaw;
  const targetIs0 = token0Address === target;

  if (version === 'v3') {
    const targetDelta = targetIs0 ? decoded.args.amount0 : decoded.args.amount1;
    const quoteDelta = targetIs0 ? decoded.args.amount1 : decoded.args.amount0;
    side = targetDelta < 0n ? 'buy' : 'sell';
    tokenAmountRaw = targetDelta;
    quoteAmountRaw = quoteDelta;
  } else {
    const targetIn = targetIs0 ? decoded.args.amount0In : decoded.args.amount1In;
    const targetOut = targetIs0 ? decoded.args.amount0Out : decoded.args.amount1Out;
    const quoteIn = targetIs0 ? decoded.args.amount1In : decoded.args.amount0In;
    const quoteOut = targetIs0 ? decoded.args.amount1Out : decoded.args.amount0Out;
    side = targetOut > 0n ? 'buy' : 'sell';
    tokenAmountRaw = targetOut > 0n ? targetOut : targetIn;
    quoteAmountRaw = targetOut > 0n ? quoteIn : quoteOut;
  }

  const tokenAmount = decimal(tokenAmountRaw, targetDecimals);
  const quoteAmount = decimal(quoteAmountRaw, quoteDecimals);
  return {
    txHash: String(log.transactionHash || '').toLowerCase(),
    logIndex: hexNumber(log.logIndex),
    blockNumber: hexNumber(log.blockNumber),
    poolAddress: normalizeAddress(log.address),
    sender: normalizeAddress(decoded.args.sender),
    recipient: normalizeAddress(decoded.args.recipient ?? decoded.args.to),
    side,
    tokenAmount,
    quoteAmount,
    priceNative: tokenAmount > 0 ? quoteAmount / tokenAmount : 0
  };
}

export const SWAP_TOPICS = Object.freeze({
  v2: '0xd78ad95fa46c994b6551d0da85fc275fe613ce37657fb8d5e3d130840159d822',
  v3: '0xc42079f94a6350d7e6235f29174924f928cc2ac818eb64fed8004e115fbcca67'
});

async function fetchBlockTimestamps(rpc, blockNumbers, { signal } = {}) {
  const unique = [...new Set(blockNumbers.map(Number).filter(Number.isFinite))];
  const timestamps = new Map();
  const size = Math.max(1, Number(rpc.batchSize) || 50);
  for (let index = 0; index < unique.length; index += size) {
    const chunk = unique.slice(index, index + size);
    const blocks = await rpc.batchRequest(
      chunk.map((blockNumber) => ({ method: 'eth_getBlockByNumber', params: [blockTag(blockNumber), false] })),
      { signal }
    );
    blocks.forEach((block, offset) => {
      const timestamp = block?.timestamp ? hexNumber(block.timestamp) : null;
      timestamps.set(chunk[offset], timestamp);
    });
    if (index + size < unique.length && rpc.batchDelayMs > 0) {
      await rpc.sleep(rpc.batchDelayMs, { signal });
    }
  }
  return timestamps;
}

function actionWallet(action, transaction) {
  const txSender = normalizeAddress(transaction?.from);
  if (validAddress(txSender)) {
    const direct = normalizeAddress(transaction?.to) === action.poolAddress;
    return { wallet: txSender, txSender, attributionConfidence: direct ? 'high' : 'medium' };
  }
  const fallback = validAddress(action.recipient) ? action.recipient : action.sender;
  return { wallet: fallback, txSender: null, attributionConfidence: 'low' };
}

function knownInfrastructure() {
  return new Set([
    '0x0000000000000000000000000000000000000000',
    ROBINHOOD_CHAIN.weth,
    ROBINHOOD_CHAIN.usdg,
    ROBINHOOD_CHAIN.v2Factory,
    ROBINHOOD_CHAIN.v2Router,
    ROBINHOOD_CHAIN.v3Factory,
    ROBINHOOD_CHAIN.v3Router
  ]);
}

async function readV2Reserves(rpc, pool, targetToken, targetDecimals, quoteDecimals, { signal } = {}) {
  if (pool.version !== 'v2') return null;
  const reserves = await readFunction(rpc, pool.address, 'getReserves', [], { signal });
  const reserve0 = Number(formatUnits(reserves[0], pool.token0 === normalizeAddress(targetToken) ? targetDecimals : quoteDecimals));
  const reserve1 = Number(formatUnits(reserves[1], pool.token1 === normalizeAddress(targetToken) ? targetDecimals : quoteDecimals));
  return pool.token0 === normalizeAddress(targetToken)
    ? { target: reserve0, quote: reserve1 }
    : { target: reserve1, quote: reserve0 };
}

let defaultRpc = null;

function getDefaultRpc(config) {
  if (!defaultRpc || defaultRpc.rpcUrl !== config.rpcUrl) {
    defaultRpc = new RobinhoodRpcClient({
      rpcUrl: config.rpcUrl,
      timeoutMs: config.requestTimeoutMs,
      logWindow: config.logWindow,
      maxRetries: config.rpcMaxRetries,
      retryDelayMs: config.rpcRetryDelayMs,
      maxRetryDelayMs: config.rpcMaxRetryDelayMs,
      batchSize: config.rpcBatchSize,
      batchDelayMs: config.rpcBatchDelayMs
    });
  }
  return defaultRpc;
}

export async function scanToken({
  token,
  pools,
  poolClient,
  rpc,
  config: providedConfig,
  signal,
  onProgress = () => {}
}) {
  const config = providedConfig || createRobinhoodConfig();
  const chainClient = rpc || getDefaultRpc(config);
  const targetToken = normalizeAddress(token?.address);
  if (!validAddress(targetToken)) throw new Error('Invalid Robinhood token address');
  onProgress({ stage: 'pool_discovery', percent: 5 });
  const pairRows = Array.isArray(pools)
    ? pools
    : poolClient?.fetchPools
      ? await poolClient.fetchPools(targetToken, { signal })
      : [];
  const hintedPool = chooseMainPool(pairRows, {
    targetToken,
    supportedQuotes: [ROBINHOOD_CHAIN.weth, ROBINHOOD_CHAIN.usdg]
  });
  if (!hintedPool) throw new Error('No supported WETH or USDG pool was found');
  const pool = await verifyPoolOnchain({ pool: hintedPool, targetToken, rpc: chainClient, signal });
  const quoteToken = pool.token0 === targetToken ? pool.token1 : pool.token0;
  if (![ROBINHOOD_CHAIN.weth, ROBINHOOD_CHAIN.usdg].includes(quoteToken)) {
    throw new Error('Verified pool quote token is not supported');
  }
  const [targetDecimals, quoteDecimals] = await Promise.all([
    readDecimals(chainClient, targetToken, token?.decimals, { signal }),
    readDecimals(chainClient, quoteToken, quoteToken === ROBINHOOD_CHAIN.usdg ? 6 : 18, { signal })
  ]);

  onProgress({ stage: 'block_range', percent: 15, pool: pool.address });
  const latestBlock = await chainClient.getBlockNumber({ signal });
  const startTimestamp = toUnixSeconds(pool.createdAt) || toUnixSeconds(token?.creationTimestamp);
  const fromBlock = startTimestamp
    ? await chainClient.findBlockByTimestamp(startTimestamp, { highBlock: latestBlock, signal })
    : Math.max(0, latestBlock - config.logWindow);
  const rawLogs = await chainClient.getLogs(
    {
      address: pool.address,
      topics: [SWAP_TOPICS[pool.version]],
      fromBlock,
      toBlock: latestBlock
    },
    {
      signal,
      initialWindow: config.logWindow,
      maxLogs: config.maxSwapsPerToken
    }
  );
  onProgress({ stage: 'transactions', percent: 55, logs: rawLogs.length, fromBlock, latestBlock });

  const decoded = [];
  const quarantined = [];
  for (const log of rawLogs) {
    if (log?.removed) continue;
    try {
      decoded.push(
        decodePoolSwap({
          version: pool.version,
          log,
          token0: pool.token0,
          token1: pool.token1,
          targetToken,
          quoteToken,
          targetDecimals,
          quoteDecimals
        })
      );
    } catch (error) {
      quarantined.push({
        txHash: normalizeAddress(log?.transactionHash),
        logIndex: hexNumber(log?.logIndex),
        reason: error instanceof Error ? error.message : String(error)
      });
    }
  }

  const hashes = [...new Set(decoded.map((action) => action.txHash).filter(Boolean))];
  const transactions = await chainClient.getTransactionsByHashes(hashes, { signal });
  const transactionByHash = new Map(hashes.map((hash, index) => [hash, transactions[index]]));
  const timestamps = await fetchBlockTimestamps(
    chainClient,
    decoded.map((action) => action.blockNumber),
    { signal }
  );
  const infrastructure = knownInfrastructure();
  infrastructure.add(pool.address);
  infrastructure.add(targetToken);
  const actions = decoded
    .map((action) => {
      const transaction = transactionByHash.get(action.txHash);
      const attribution = actionWallet(action, transaction);
      const wallet = normalizeAddress(attribution.wallet);
      return {
        ...action,
        tokenAddress: targetToken,
        quoteToken,
        quoteSymbol: quoteToken === ROBINHOOD_CHAIN.usdg ? 'USDG' : 'WETH',
        transactionIndex: hexNumber(transaction?.transactionIndex),
        blockTimestamp: timestamps.get(action.blockNumber) ?? null,
        wallet,
        txSender: attribution.txSender,
        executionContract: normalizeAddress(transaction?.to),
        attributionConfidence: attribution.attributionConfidence,
        excluded: !validAddress(wallet) || infrastructure.has(wallet),
        exclusionReasons: infrastructure.has(wallet) ? ['known_infrastructure'] : []
      };
    })
    .filter((action) => validAddress(action.wallet));

  const reserves = await readV2Reserves(
    chainClient,
    pool,
    targetToken,
    targetDecimals,
    quoteDecimals,
    { signal }
  );
  const currentPriceNative =
    reserves?.target > 0 && reserves?.quote > 0
      ? reserves.quote / reserves.target
      : actions.at(-1)?.priceNative ?? null;
  const directoryQuoteUsd =
    Number(hintedPool.currentPriceUsd) > 0 && Number(hintedPool.currentPriceNative) > 0
      ? Number(hintedPool.currentPriceUsd) / Number(hintedPool.currentPriceNative)
      : null;
  const tokenImpliedQuoteUsd =
    Number(token?.priceUsd) > 0 && Number(currentPriceNative) > 0
      ? Number(token.priceUsd) / Number(currentPriceNative)
      : null;
  const quoteUsd =
    quoteToken === ROBINHOOD_CHAIN.usdg
      ? 1
      : directoryQuoteUsd >= 100 && directoryQuoteUsd <= 100_000
        ? directoryQuoteUsd
        : tokenImpliedQuoteUsd;
  const verifiedLiquidityUsd =
    reserves?.quote > 0 && Number(quoteUsd) > 0 ? reserves.quote * Number(quoteUsd) * 2 : null;
  const complete = rawLogs.length < config.maxSwapsPerToken;
  const poolResult = {
    ...pool,
    quoteToken,
    quoteSymbol: quoteToken === ROBINHOOD_CHAIN.usdg ? 'USDG' : 'WETH',
    currentPriceNative,
    reserves,
    verifiedLiquidityUsd,
    quoteUsd,
    quoteUsdSource:
      quoteToken === ROBINHOOD_CHAIN.usdg
        ? 'stablecoin_parity'
        : directoryQuoteUsd === quoteUsd
          ? 'pool_directory_quote_conversion'
          : 'debot_implied_quote_conversion'
  };
  const qualification = deriveTokenQualification({
    token: { ...token, pool: poolResult, currentPriceNative },
    actions,
    scanComplete: complete,
    thresholds: {
      multiple: config.defaultWinnerMultiple,
      minLiquidityUsd: config.minLiquidityUsd,
      minWallets: config.minEffectiveWallets
    }
  });
  onProgress({ stage: 'complete', percent: 100, actions: actions.length, complete });
  return {
    tokenPatch: {
      currentPriceNative,
      quoteUsd,
      peakMultiple: qualification.peakMultiple,
      peakLiquidityUsd: qualification.peakLiquidityUsd,
      effectiveWallets: qualification.effectiveWallets,
      qualificationStatus: qualification.status
    },
    pool: poolResult,
    qualification,
    actions,
    scan: {
      complete,
      partial: !complete,
      fromBlock,
      toBlock: latestBlock,
      swapLogs: rawLogs.length,
      actions: actions.length,
      quarantined,
      parserConfidence: quarantined.length ? 'medium' : 'high'
    }
  };
}
