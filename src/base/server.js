import { pathToFileURL } from 'node:url';

import { createRobinhoodStandaloneServer } from '../robinhoodServer.js';
import { createRobinhoodBarkNotifier } from '../robinhood/bark.js';
import { createRobinhoodConfig } from '../robinhood/config.js';
import { RobinhoodDebotClient } from '../robinhood/debotClient.js';
import { RobinhoodHolderClient } from '../robinhood/holderClient.js';
import { scanTokenHolders } from '../robinhood/holderScanner.js';
import { createRobinhoodWalletMonitor } from '../robinhood/monitor.js';
import { RobinhoodRpcClient } from '../robinhood/rpcClient.js';
import { createRobinhoodService } from '../robinhood/service.js';
import { createRobinhoodStore } from '../robinhood/store.js';
import {
  BASE_CHAIN,
  createBaseConfig,
  isBaseAddress,
  normalizeBaseAddress
} from './config.js';
import { createBaseMarketClient } from './marketClient.js';

export const BASE_API_PREFIX = '/api/base';
export const BASE_MONITOR_PROFILE = Object.freeze({
  ...BASE_CHAIN,
  id: 'base',
  debotAddressRoot: 'https://debot.ai/address/base',
  debotTokenRoot: 'https://debot.ai/token/base/'
});

export const BASE_ADDRESS_CODEC = Object.freeze({
  chainId: 'base',
  label: 'Base',
  normalize: normalizeBaseAddress,
  validate: isBaseAddress
});

function baseTuningEnvironment(env) {
  const mapped = {};
  for (const [key, value] of Object.entries(env || {})) {
    if (!key.startsWith('BASE_')) continue;
    mapped[`ROBINHOOD_${key.slice('BASE_'.length)}`] = value;
  }
  return mapped;
}

function boundedNumber(value, fallback, minimum, maximum) {
  const number = Number(value);
  if (!Number.isFinite(number)) return fallback;
  return Math.min(maximum, Math.max(minimum, number));
}

function boundedPort(value, fallback = 18119) {
  const number = Number(value);
  if (!Number.isInteger(number) || number < 0 || number > 65_535) return fallback;
  return number;
}

export function createBaseRuntimeConfig(env = process.env) {
  const shared = createRobinhoodConfig(baseTuningEnvironment(env));
  const base = createBaseConfig(env);
  return {
    ...shared,
    ...base,
    chainId: 'base',
    chainLabel: 'Base',
    chainProfile: BASE_MONITOR_PROFILE,
    addressNormalizer: normalizeBaseAddress,
    addressValidator: isBaseAddress,
    transactionNormalizer: normalizeBaseAddress,
    debotAddressRoot: BASE_MONITOR_PROFILE.debotAddressRoot,
    quoteTokenAddresses: BASE_CHAIN.quoteTokens,
    noxaLaunchFactory: null,
    scanConcurrency: Math.floor(boundedNumber(env.BASE_SCAN_CONCURRENCY, 1, 1, 8)),
    marketDebotBudgetMs: Math.floor(boundedNumber(env.BASE_MARKET_DEBOT_BUDGET_MS, 1_500, 250, 10_000)),
    marketRequestTimeoutMs: Math.floor(boundedNumber(env.BASE_MARKET_REQUEST_TIMEOUT_MS, 5_000, 1_000, 20_000)),
    host: String(env.BASE_HOST || env.HOST || '127.0.0.1'),
    port: boundedPort(env.BASE_PORT ?? env.PORT, 18119)
  };
}

export function scanBaseTokenHolders(options = {}) {
  return scanTokenHolders({
    ...options,
    chainProfile: BASE_CHAIN,
    holderSource: 'blockscout',
    addressNormalizer: normalizeBaseAddress,
    addressValidator: isBaseAddress
  });
}

export async function startBaseStandaloneServer(
  env = process.env,
  {
    monitorRpcClient = null,
    debotClient = null,
    marketDataClient = null,
    holderClient = null,
    store = null,
    barkNotifier = null,
    fetchImpl = globalThis.fetch
  } = {}
) {
  const config = createBaseRuntimeConfig(env);
  const activeStore = store || createRobinhoodStore(config.dataFile, {
    chainId: config.chainId,
    chainLabel: config.chainLabel,
    addressNormalizer: config.addressNormalizer,
    addressValidator: config.addressValidator,
    transactionNormalizer: config.transactionNormalizer
  });
  const activeDebotClient = debotClient || new RobinhoodDebotClient({
    chain: 'base',
    timeoutMs: config.requestTimeoutMs,
    fetchImpl,
    addressNormalizer: config.addressNormalizer,
    addressValidator: config.addressValidator
  });
  const metricDebotClient = typeof activeDebotClient?.fetchTokenMetrics === 'function'
    ? activeDebotClient
    : new RobinhoodDebotClient({
        chain: 'base',
        timeoutMs: config.requestTimeoutMs,
        fetchImpl,
        addressNormalizer: config.addressNormalizer,
        addressValidator: config.addressValidator
      });
  const activeMarketDataClient = marketDataClient || createBaseMarketClient({
    debotClient: metricDebotClient,
    fetchImpl,
    debotBudgetMs: config.marketDebotBudgetMs,
    timeoutMs: config.marketRequestTimeoutMs
  });
  const rpcClient = monitorRpcClient || new RobinhoodRpcClient({
    rpcUrl: config.rpcUrl,
    timeoutMs: config.requestTimeoutMs,
    maxRetries: config.rpcMaxRetries,
    retryDelayMs: config.rpcRetryDelayMs,
    maxRetryDelayMs: config.rpcMaxRetryDelayMs,
    logWindow: config.logWindow,
    batchSize: config.rpcBatchSize,
    batchDelayMs: config.rpcBatchDelayMs,
    fetchImpl
  });
  const activeHolderClient = holderClient || new RobinhoodHolderClient({
    baseUrl: config.blockscoutApiUrl,
    timeoutMs: config.requestTimeoutMs,
    fetchImpl
  });
  const service = createRobinhoodService({
    config,
    store: activeStore,
    debotClient: activeDebotClient,
    holderClient: activeHolderClient,
    scanToken: scanBaseTokenHolders,
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
    brand: 'Base'
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
    apiPrefix: BASE_API_PREFIX,
    addressCodec: BASE_ADDRESS_CODEC,
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
    marketDataClient: activeMarketDataClient,
    holderClient: activeHolderClient,
    rpcClient,
    config,
    host: config.host,
    port: typeof address === 'object' && address ? address.port : config.port
  };
}

async function main() {
  const running = await startBaseStandaloneServer();
  console.log(`Base smart money radar API: http://${running.host}:${running.port}${BASE_API_PREFIX}/`);
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
