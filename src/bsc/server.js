import { pathToFileURL } from 'node:url';

import { createRobinhoodStandaloneServer } from '../robinhoodServer.js';
import { createRobinhoodBarkNotifier } from '../robinhood/bark.js';
import { createRobinhoodConfig } from '../robinhood/config.js';
import { RobinhoodDebotClient } from '../robinhood/debotClient.js';
import { scanTokenHolders } from '../robinhood/holderScanner.js';
import { createRobinhoodWalletMonitor } from '../robinhood/monitor.js';
import { RobinhoodRpcClient } from '../robinhood/rpcClient.js';
import { createRobinhoodService } from '../robinhood/service.js';
import { createRobinhoodStore } from '../robinhood/store.js';
import {
  BSC_CHAIN,
  createBscConfig,
  isBscAddress,
  normalizeBscAddress
} from './config.js';
import { BscHolderClient } from './holderClient.js';
import { createBscDebotBridgeFetch } from './debotBridgeFetch.js';
import { BscDebotHolderClient } from './debotHolderClient.js';
import { createBscMarketClient } from './marketClient.js';

export const BSC_API_PREFIX = '/api/bsc';
export const BSC_MONITOR_PROFILE = Object.freeze({
  ...BSC_CHAIN,
  id: 'bsc',
  debotAddressRoot: 'https://debot.ai/address/bsc',
  debotTokenRoot: 'https://debot.ai/token/bsc/289942_'
});

export const BSC_ADDRESS_CODEC = Object.freeze({
  chainId: 'bsc',
  label: 'BSC',
  normalize: normalizeBscAddress,
  validate: isBscAddress
});

const RPC_HASH_PATTERN = /^0x[0-9a-f]{64}$/i;
const RPC_ADDRESS_PATTERN = /^0x[0-9a-f]{40}$/i;

function rpcQuantity(value, label) {
  if (typeof value !== 'string' || !/^0x[0-9a-f]+$/i.test(value)) {
    throw new TypeError(`${label} must be an RPC quantity`);
  }
  const number = Number(BigInt(value));
  if (!Number.isSafeInteger(number) || number < 0) {
    throw new TypeError(`${label} is outside the safe integer range`);
  }
  return number;
}

function rpcBlockTag(value) {
  return `0x${BigInt(value).toString(16)}`;
}

function bscMonitorCapabilityError(cause) {
  const error = new Error(
    'BSC monitor RPC must return recent blocks, batched transactions, and transaction receipts; configure a full BSC mainnet endpoint in BSC_RPC_URL',
    cause instanceof Error ? { cause } : undefined
  );
  error.code = 'BSC_MONITOR_RPC_CAPABILITY_MISMATCH';
  return error;
}

function rpcEndpointIdentity(client, fallback = '') {
  const value = String(client?.rpcUrl || fallback || '').trim();
  if (!value) return '';
  try {
    const url = new URL(value);
    url.hash = '';
    url.searchParams.sort();
    if (url.pathname !== '/') url.pathname = url.pathname.replace(/\/+$/, '');
    return url.href.replace(/\/$/, '');
  } catch {
    return value.replace(/\/+$/, '');
  }
}

function bscTuningEnvironment(env) {
  const mapped = {};
  for (const [key, value] of Object.entries(env || {})) {
    if (key === 'BARK_DATA_FILE') {
      mapped[key] = value;
      continue;
    }
    if (!key.startsWith('BSC_')) continue;
    mapped[`ROBINHOOD_${key.slice('BSC_'.length)}`] = value;
  }
  return mapped;
}

function boundedNumber(value, fallback, minimum, maximum) {
  const number = Number(value);
  if (!Number.isFinite(number)) return fallback;
  return Math.min(maximum, Math.max(minimum, number));
}

function boundedPort(value, fallback = 18122) {
  const number = Number(value);
  if (!Number.isInteger(number) || number < 0 || number > 65_535) return fallback;
  return number;
}

function createBscRpcClient(config, rpcUrl, fetchImpl) {
  return new RobinhoodRpcClient({
    rpcUrl,
    timeoutMs: config.requestTimeoutMs,
    maxRetries: config.rpcMaxRetries,
    retryDelayMs: config.rpcRetryDelayMs,
    maxRetryDelayMs: config.rpcMaxRetryDelayMs,
    logWindow: config.logWindow,
    batchSize: config.rpcBatchSize,
    batchDelayMs: config.rpcBatchDelayMs,
    fetchImpl
  });
}

export async function assertBscRpcChain(rpcClient, label = 'BSC RPC') {
  if (typeof rpcClient?.request !== 'function') {
    throw new TypeError(`${label} must support eth_chainId`);
  }
  const value = await rpcClient.request('eth_chainId', [], { maxRetries: 0 });
  if (String(value || '').toLowerCase() !== BSC_CHAIN.hexId) {
    const error = new Error(
      `${label} must return BSC mainnet eth_chainId ${BSC_CHAIN.hexId}; received ${String(value)}`
    );
    error.code = 'BSC_RPC_CHAIN_MISMATCH';
    error.expectedChainId = BSC_CHAIN.hexId;
    error.actualChainId = value;
    throw error;
  }
  return value;
}

export async function assertBscMonitorRpcCapabilities(
  rpcClient,
  { confirmationDepth = 5, blockSearchLimit = 8 } = {}
) {
  if (typeof rpcClient?.request !== 'function' || typeof rpcClient?.batchRequest !== 'function') {
    throw bscMonitorCapabilityError();
  }

  try {
    const rawHead = await rpcClient.request('eth_blockNumber', [], { maxRetries: 1 });
    const headBlock = rpcQuantity(rawHead, 'BSC head block');
    const depth = Math.max(1, Math.floor(Number(confirmationDepth) || 5));
    const limit = Math.max(1, Math.min(32, Math.floor(Number(blockSearchLimit) || 8)));
    const firstBlock = Math.max(0, headBlock - depth);

    for (let offset = 0; offset < limit && firstBlock - offset >= 0; offset += 1) {
      const probeBlock = firstBlock - offset;
      const block = await rpcClient.request(
        'eth_getBlockByNumber',
        [rpcBlockTag(probeBlock), false],
        { maxRetries: 1 }
      );
      const txHash = (Array.isArray(block?.transactions) ? block.transactions : [])
        .map((transaction) => typeof transaction === 'string' ? transaction : transaction?.hash)
        .find((hash) => RPC_HASH_PATTERN.test(String(hash || '')));
      if (!txHash) continue;

      const [transaction, receipt] = await rpcClient.batchRequest([
        { method: 'eth_getTransactionByHash', params: [txHash] },
        { method: 'eth_getTransactionReceipt', params: [txHash] }
      ], { maxRetries: 1 });
      const transactionValid = transaction && typeof transaction === 'object' &&
        String(transaction.hash || '').toLowerCase() === txHash.toLowerCase() &&
        RPC_ADDRESS_PATTERN.test(String(transaction.from || ''));
      const receiptValid = receipt && typeof receipt === 'object' &&
        String(receipt.transactionHash || '').toLowerCase() === txHash.toLowerCase() &&
        /^0x[0-9a-f]+$/i.test(String(receipt.status || '')) &&
        Array.isArray(receipt.logs);
      if (transactionValid && receiptValid) {
        return { headBlock, probeBlock, transactionHash: txHash };
      }
    }
  } catch (error) {
    throw bscMonitorCapabilityError(error);
  }

  throw bscMonitorCapabilityError();
}

export function createBscRuntimeConfig(env = process.env) {
  const shared = createRobinhoodConfig(bscTuningEnvironment(env));
  const bsc = createBscConfig(env);
  return {
    ...shared,
    ...bsc,
    chainId: 'bsc',
    chainLabel: 'BSC',
    chainProfile: BSC_MONITOR_PROFILE,
    addressNormalizer: normalizeBscAddress,
    addressValidator: isBscAddress,
    transactionNormalizer: normalizeBscAddress,
    debotAddressRoot: BSC_MONITOR_PROFILE.debotAddressRoot,
    quoteTokenAddresses: BSC_CHAIN.quoteTokens,
    noxaLaunchFactory: null,
    allowSharedRpcEndpoint: /^(?:1|true|yes)$/i.test(String(env.BSC_ALLOW_SHARED_RPC_ENDPOINT || '').trim()),
    monitorMaxBlockSpan: Math.floor(boundedNumber(env.BSC_MONITOR_MAX_BLOCK_SPAN, 10, 1, 10_000)),
    scanConcurrency: Math.floor(boundedNumber(env.BSC_SCAN_CONCURRENCY, 1, 1, 8)),
    holderLogWindow: Math.floor(boundedNumber(env.BSC_HOLDER_LOG_WINDOW, 2_000, 1, 20_000)),
    holderLogConcurrency: Math.floor(boundedNumber(env.BSC_HOLDER_LOG_CONCURRENCY, 2, 1, 4)),
    holderLogResultGuard: Math.floor(boundedNumber(env.BSC_HOLDER_LOG_RESULT_GUARD, 1_000, 100, 10_000)),
    holderMaxTransferLogs: Math.floor(boundedNumber(env.BSC_HOLDER_MAX_TRANSFER_LOGS, 100_000, 1_000, 1_000_000)),
    holderMaxBlockSpan: Math.floor(boundedNumber(env.BSC_HOLDER_MAX_BLOCK_SPAN, 5_000_000, 1_000, 50_000_000)),
    holderCreationSafetySeconds: Math.floor(boundedNumber(
      env.BSC_HOLDER_CREATION_SAFETY_SECONDS,
      86_400,
      60,
      2_592_000
    )),
    holderRpcBatchSize: Math.floor(boundedNumber(env.BSC_HOLDER_RPC_BATCH_SIZE, 20, 1, 50)),
    holderMaxBalanceChecks: Math.floor(boundedNumber(env.BSC_HOLDER_MAX_BALANCE_CHECKS, 20_000, 100, 100_000)),
    holderMaxContractChecks: Math.floor(boundedNumber(env.BSC_HOLDER_MAX_CONTRACT_CHECKS, 1_000, 100, 10_000)),
    marketDebotBudgetMs: Math.floor(boundedNumber(env.BSC_MARKET_DEBOT_BUDGET_MS, 1_500, 250, 10_000)),
    marketRequestTimeoutMs: Math.floor(boundedNumber(env.BSC_MARKET_REQUEST_TIMEOUT_MS, 5_000, 1_000, 20_000)),
    host: String(env.BSC_HOST || env.HOST || '127.0.0.1'),
    port: boundedPort(env.BSC_PORT ?? env.PORT, 18122)
  };
}

export function scanBscTokenHolders(options = {}) {
  return scanTokenHolders({
    ...options,
    chainProfile: BSC_CHAIN,
    addressNormalizer: normalizeBscAddress,
    addressValidator: isBscAddress
  });
}

export async function startBscStandaloneServer(
  env = process.env,
  {
    monitorRpcClient = null,
    holderRpcClient = null,
    holderLogRpcClient = null,
    debotClient = null,
    marketDataClient = null,
    holderClient = null,
    store = null,
    barkNotifier = null,
    fetchImpl = globalThis.fetch
  } = {}
) {
  const config = createBscRuntimeConfig(env);
  const rpcClient = monitorRpcClient || createBscRpcClient(config, config.rpcUrl, fetchImpl);
  await assertBscRpcChain(rpcClient, 'BSC monitor RPC');
  if (holderClient && (holderRpcClient || holderLogRpcClient)) {
    throw new Error(
      'An injected BSC holderClient is authoritative; do not also inject holderRpcClient or holderLogRpcClient'
    );
  }
  let holderRpc = holderClient?.rpcClient || holderRpcClient;
  let holderLogRpc = null;
  if (!holderClient) {
    holderRpc ||= config.holderRpcUrl
      ? createBscRpcClient(config, config.holderRpcUrl, fetchImpl)
      : null;
    if (!holderRpc && (holderLogRpcClient || config.holderLogRpcUrl)) {
      throw new Error(
        'BSC Holder log RPC requires strict Holder state mode; configure BSC_HOLDER_RPC_URL or inject holderRpcClient'
      );
    }
    holderLogRpc = holderRpc
      ? (holderLogRpcClient || (config.holderLogRpcUrl
          ? createBscRpcClient(config, config.holderLogRpcUrl, fetchImpl)
          : holderRpc))
      : null;
    if (holderRpc === rpcClient) {
      throw new Error('BSC monitor and Holder analysis must use separate RPC client instances');
    }
    if (holderLogRpc === rpcClient) {
      throw new Error('BSC monitor and Holder log analysis must use separate RPC client instances');
    }
    if (holderRpc) await assertBscRpcChain(holderRpc, 'BSC Holder RPC');
    if (holderLogRpc && holderLogRpc !== holderRpc) {
      await assertBscRpcChain(holderLogRpc, 'BSC Holder log RPC');
    }
  } else if (holderClient?.rpcClient === rpcClient) {
    throw new Error('BSC monitor and Holder analysis must use separate RPC client instances');
  } else {
    holderLogRpc = holderClient?.logRpcClient || null;
    if (holderLogRpc === rpcClient) {
      throw new Error('BSC monitor and Holder log analysis must use separate RPC client instances');
    }
  }
  const holderEndpointClient = holderRpc || holderClient?.rpcClient || null;
  const monitorEndpoint = rpcEndpointIdentity(rpcClient, config.rpcUrl);
  const holderEndpoint = rpcEndpointIdentity(
    holderEndpointClient,
    holderClient ? '' : config.holderRpcUrl
  );
  const holderLogFallback = holderLogRpc === holderEndpointClient
    ? (holderClient ? '' : config.holderRpcUrl)
    : (holderClient ? '' : config.holderLogRpcUrl);
  const holderLogEndpoint = rpcEndpointIdentity(holderLogRpc, holderLogFallback);
  if (!config.allowSharedRpcEndpoint && monitorEndpoint && holderEndpoint && monitorEndpoint === holderEndpoint) {
    throw new Error(
      'BSC monitor and Holder analysis must use different RPC endpoints; set BSC_ALLOW_SHARED_RPC_ENDPOINT=true only when the shared state endpoint is intentional'
    );
  }
  if (
    monitorEndpoint &&
    holderLogEndpoint &&
    monitorEndpoint === holderLogEndpoint
  ) {
    throw new Error(
      'BSC monitor and Holder log analysis must use different RPC endpoints'
    );
  }
  await assertBscMonitorRpcCapabilities(rpcClient);
  const activeStore = store || createRobinhoodStore(config.dataFile, {
    chainId: config.chainId,
    chainLabel: config.chainLabel,
    addressNormalizer: config.addressNormalizer,
    addressValidator: config.addressValidator,
    transactionNormalizer: config.transactionNormalizer,
    walletLibraryFile: config.walletDataFile,
    barkLibraryFile: config.barkDataFile
  });
  const analysisBridgeFetch = createBscDebotBridgeFetch({
    bridgeUrl: config.debotBridgeUrl,
    fetchImpl,
    timeoutMs: config.debotBridgeTimeoutMs
  });
  const activeDebotClient = debotClient || new RobinhoodDebotClient({
    chain: 'bsc',
    timeoutMs: config.debotRequestTimeoutMs,
    fetchImpl: analysisBridgeFetch,
    addressNormalizer: config.addressNormalizer,
    addressValidator: config.addressValidator
  });
  const holderProfileDebotClient = typeof debotClient?.fetchTokenHolderProfile === 'function'
    ? debotClient
    : new RobinhoodDebotClient({
        chain: 'bsc',
        timeoutMs: config.debotRequestTimeoutMs,
        fetchImpl: analysisBridgeFetch,
        addressNormalizer: config.addressNormalizer,
        addressValidator: config.addressValidator
      });
  const metricDebotClient = typeof activeDebotClient?.fetchTokenMetrics === 'function'
    ? activeDebotClient
    : new RobinhoodDebotClient({
        chain: 'bsc',
        timeoutMs: config.requestTimeoutMs,
        fetchImpl,
        addressNormalizer: config.addressNormalizer,
        addressValidator: config.addressValidator
      });
  const activeMarketDataClient = marketDataClient || createBscMarketClient({
    debotClient: metricDebotClient,
    fetchImpl,
    debotBudgetMs: config.marketDebotBudgetMs,
    timeoutMs: config.marketRequestTimeoutMs
  });
  const activeHolderClient = holderClient || (holderRpc
    ? new BscHolderClient({
        rpcClient: holderRpc,
        logRpcClient: holderLogRpc,
        debotClient: activeDebotClient,
        creationTimeClient: activeMarketDataClient,
        infrastructureAddresses: BSC_CHAIN.infrastructureAddresses,
        logWindow: config.holderLogWindow,
        logConcurrency: config.holderLogConcurrency,
        logResultGuard: config.holderLogResultGuard,
        maxTransferLogs: config.holderMaxTransferLogs,
        maxBlockSpan: config.holderMaxBlockSpan,
        creationSafetySeconds: config.holderCreationSafetySeconds,
        rpcBatchSize: config.holderRpcBatchSize,
        maxBalanceChecks: config.holderMaxBalanceChecks,
        maxContractChecks: config.holderMaxContractChecks
      })
    : new BscDebotHolderClient({
        debotClient: holderProfileDebotClient,
        rpcClient,
        infrastructureAddresses: BSC_CHAIN.infrastructureAddresses,
        rpcBatchSize: config.holderRpcBatchSize
      }));
  const service = createRobinhoodService({
    config,
    store: activeStore,
    debotClient: activeDebotClient,
    holderClient: activeHolderClient,
    scanToken: scanBscTokenHolders,
    scanConcurrency: config.scanConcurrency,
    chainId: config.chainId,
    chainLabel: config.chainLabel,
    addressNormalizer: config.addressNormalizer,
    addressValidator: config.addressValidator,
    transactionNormalizer: config.transactionNormalizer,
    debotAddressRoot: config.debotAddressRoot
  });
  const activeBarkNotifier = barkNotifier || createRobinhoodBarkNotifier({
    store: activeStore,
    timeoutMs: Math.min(15_000, config.requestTimeoutMs),
    brand: 'BSC'
  });
  const monitor = createRobinhoodWalletMonitor({
    store: activeStore,
    rpcClient,
    pollIntervalMs: config.monitorPollIntervalMs,
    degradedPollIntervalMs: config.monitorDegradedPollIntervalMs,
    maxBlockSpan: config.monitorMaxBlockSpan,
    walletTopicChunkSize: config.monitorWalletTopicChunkSize,
    walletLogConcurrency: config.monitorLogConcurrency,
    recoverySuccesses: config.monitorRecoverySuccesses,
    fastLiveBlockSpan: config.monitorFastLiveBlockSpan,
    fastGapBlockSpan: config.monitorFastGapBlockSpan,
    fastGapPollIntervalMs: config.monitorFastGapPollIntervalMs,
    deepPollIntervalMs: config.monitorDeepPollIntervalMs,
    deepDegradedPollIntervalMs: config.monitorDeepDegradedPollIntervalMs,
    deepLiveBlockSpan: config.monitorDeepLiveBlockSpan,
    deepGapBlockSpan: config.monitorDeepGapBlockSpan,
    deepGapPollIntervalMs: config.monitorDeepGapPollIntervalMs,
    tokenMetadataBudgetMs: config.monitorTokenMetadataBudgetMs,
    quoteTokenAddresses: config.quoteTokenAddresses,
    noxaLaunchFactory: null,
    chainProfile: config.chainProfile,
    barkNotifier: activeBarkNotifier,
    debotClient: activeMarketDataClient
  });
  const server = createRobinhoodStandaloneServer({
    service,
    monitor,
    apiPrefix: BSC_API_PREFIX,
    addressCodec: BSC_ADDRESS_CODEC,
    servePublic: false
  });

  try {
    await new Promise((resolve, reject) => {
      server.once('error', reject);
      server.listen(config.port, config.host, resolve);
    });
  } catch (error) {
    service.close();
    monitor.close();
    if (!store) activeStore.close();
    throw error;
  }
  await service.start();
  monitor.start();
  const address = server.address();
  return {
    server,
    service,
    monitor,
    store: activeStore,
    barkNotifier: activeBarkNotifier,
    debotClient: activeDebotClient,
    holderProfileDebotClient,
    marketDataClient: activeMarketDataClient,
    holderClient: activeHolderClient,
    holderRpcClient: holderRpc,
    holderLogRpcClient: holderLogRpc,
    rpcClient,
    config,
    host: config.host,
    port: typeof address === 'object' && address ? address.port : config.port
  };
}

async function main() {
  const running = await startBscStandaloneServer();
  console.log(`BSC smart money radar API: http://${running.host}:${running.port}${BSC_API_PREFIX}/`);
  const shutdown = () => {
    running.service.close();
    running.monitor.close();
    running.server.close(() => {
      running.store.close();
      process.exit(0);
    });
  };
  process.on('SIGINT', shutdown);
  process.on('SIGTERM', shutdown);
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  main().catch((error) => {
    console.error(error);
    process.exit(1);
  });
}
