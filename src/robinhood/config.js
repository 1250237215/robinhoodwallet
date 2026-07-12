const normalizeAddress = (value) => String(value || '').toLowerCase();

export const DEFAULT_SMART_SCORE_WEIGHTS = Object.freeze({
  lowFrequency: 25,
  winRate: 25,
  normalizedProfit: 20,
  repeatability: 15,
  multipleQuality: 10,
  holderEvidence: 5
});

export const ROBINHOOD_CHAIN = Object.freeze({
  id: 4663,
  hexId: '0x1237',
  rpcUrl: 'https://rpc.mainnet.chain.robinhood.com',
  explorerUrl: 'https://robinhoodchain.blockscout.com',
  blockscoutApiUrl: 'https://robinhoodchain.blockscout.com/api/v2',
  weth: normalizeAddress('0x0Bd7D308f8E1639FAb988df18A8011f41EAcAD73'),
  usdg: normalizeAddress('0x5fc5360D0400a0Fd4f2af552ADD042D716F1d168'),
  v3Factory: normalizeAddress('0x1f7d7550b1b028f7571e69a784071f0205fd2efa'),
  v3Router: normalizeAddress('0xcaf681a66d020601342297493863e78c959e5cb2'),
  v2Factory: normalizeAddress('0x8bceaa40b9acdfaedf85adf4ff01f5ad6517937f'),
  v2Router: normalizeAddress('0x89e5db8b5aa49aa85ac63f691524311aeb649eba')
});

function boundedNumber(value, fallback, minimum, maximum) {
  const number = Number(value);
  if (!Number.isFinite(number)) return fallback;
  return Math.min(maximum, Math.max(minimum, number));
}

export function createRobinhoodConfig(env = process.env) {
  const smartBaseMultiple = boundedNumber(env.ROBINHOOD_SMART_BASE_MULTIPLE, 5, 1, 1000);
  const strictMultiple = Math.max(
    smartBaseMultiple,
    boundedNumber(env.ROBINHOOD_STRICT_MULTIPLE, 10, 1, 1000)
  );
  return {
    rpcUrl: env.ROBINHOOD_RPC_URL || ROBINHOOD_CHAIN.rpcUrl,
    blockscoutApiUrl: env.ROBINHOOD_BLOCKSCOUT_API_URL || ROBINHOOD_CHAIN.blockscoutApiUrl,
    dataFile: env.ROBINHOOD_DATA_FILE || new URL('../../data/robinhood.sqlite', import.meta.url).pathname,
    defaultWinnerMultiple: boundedNumber(env.ROBINHOOD_WINNER_MULTIPLE, 10, 1, 1000),
    minLiquidityUsd: boundedNumber(env.ROBINHOOD_MIN_LIQUIDITY_USD, 50_000, 0, 1_000_000_000),
    minEffectiveWallets: boundedNumber(env.ROBINHOOD_MIN_WALLETS, 100, 1, 1_000_000),
    minEntryUsd: boundedNumber(env.ROBINHOOD_MIN_ENTRY_USD, 500, 0, 10_000_000),
    significantProfitRate: boundedNumber(env.ROBINHOOD_SIGNIFICANT_PROFIT_RATE, 0.002, 0.000001, 1),
    smartBaseMultiple,
    strictMultiple,
    repeatMinHits: Math.floor(boundedNumber(env.ROBINHOOD_REPEAT_MIN_HITS, 2, 2, 100)),
    strongHolderRank: Math.floor(boundedNumber(env.ROBINHOOD_STRONG_HOLDER_RANK, 30, 1, 500)),
    relatedClusterPenalty: boundedNumber(env.ROBINHOOD_RELATED_CLUSTER_PENALTY, 0.9, 0.5, 1),
    lowFrequencyReasonThreshold: boundedNumber(
      env.ROBINHOOD_LOW_FREQUENCY_REASON_THRESHOLD,
      0.8,
      0,
      1
    ),
    smartScoreWeights: {
      lowFrequency: boundedNumber(
        env.ROBINHOOD_SCORE_LOW_FREQUENCY_WEIGHT,
        DEFAULT_SMART_SCORE_WEIGHTS.lowFrequency,
        0,
        1000
      ),
      winRate: boundedNumber(
        env.ROBINHOOD_SCORE_WIN_RATE_WEIGHT,
        DEFAULT_SMART_SCORE_WEIGHTS.winRate,
        0,
        1000
      ),
      normalizedProfit: boundedNumber(
        env.ROBINHOOD_SCORE_NORMALIZED_PROFIT_WEIGHT,
        DEFAULT_SMART_SCORE_WEIGHTS.normalizedProfit,
        0,
        1000
      ),
      repeatability: boundedNumber(
        env.ROBINHOOD_SCORE_REPEATABILITY_WEIGHT,
        DEFAULT_SMART_SCORE_WEIGHTS.repeatability,
        0,
        1000
      ),
      multipleQuality: boundedNumber(
        env.ROBINHOOD_SCORE_MULTIPLE_QUALITY_WEIGHT,
        DEFAULT_SMART_SCORE_WEIGHTS.multipleQuality,
        0,
        1000
      ),
      holderEvidence: boundedNumber(
        env.ROBINHOOD_SCORE_HOLDER_EVIDENCE_WEIGHT,
        DEFAULT_SMART_SCORE_WEIGHTS.holderEvidence,
        0,
        1000
      )
    },
    holderCandidateLimit: boundedNumber(env.ROBINHOOD_HOLDER_CANDIDATE_LIMIT, 100, 10, 500),
    holderFetchLimit: boundedNumber(env.ROBINHOOD_HOLDER_FETCH_LIMIT, 150, 10, 1_000),
    holderProfitConcurrency: boundedNumber(env.ROBINHOOD_HOLDER_PROFIT_CONCURRENCY, 6, 1, 20),
    logWindow: boundedNumber(env.ROBINHOOD_LOG_WINDOW, 20_000, 100, 100_000),
    maxSwapsPerToken: boundedNumber(env.ROBINHOOD_MAX_SWAPS, 8_000, 100, 20_000),
    autoScanLimit: boundedNumber(env.ROBINHOOD_AUTO_SCAN_LIMIT, 8, 0, 20),
    discoveryLimit: boundedNumber(env.ROBINHOOD_DISCOVERY_LIMIT, 50, 5, 100),
    requestTimeoutMs: boundedNumber(env.ROBINHOOD_REQUEST_TIMEOUT_MS, 20_000, 1_000, 60_000),
    rpcMaxRetries: boundedNumber(env.ROBINHOOD_RPC_MAX_RETRIES, 6, 0, 12),
    rpcRetryDelayMs: boundedNumber(env.ROBINHOOD_RPC_RETRY_DELAY_MS, 500, 0, 10_000),
    rpcMaxRetryDelayMs: boundedNumber(env.ROBINHOOD_RPC_MAX_RETRY_DELAY_MS, 15_000, 100, 60_000),
    rpcBatchSize: boundedNumber(env.ROBINHOOD_RPC_BATCH_SIZE, 50, 1, 100),
    rpcBatchDelayMs: boundedNumber(env.ROBINHOOD_RPC_BATCH_DELAY_MS, 350, 0, 5_000),
    monitorPollIntervalMs: boundedNumber(env.ROBINHOOD_MONITOR_POLL_INTERVAL_MS, 500, 250, 60_000),
    monitorDegradedPollIntervalMs: boundedNumber(
      env.ROBINHOOD_MONITOR_DEGRADED_POLL_INTERVAL_MS,
      1_000,
      250,
      60_000
    ),
    monitorMaxBlockSpan: boundedNumber(env.ROBINHOOD_MONITOR_MAX_BLOCK_SPAN, 500, 1, 10_000),
    monitorWalletTopicChunkSize: boundedNumber(env.ROBINHOOD_MONITOR_WALLET_TOPIC_CHUNK_SIZE, 100, 1, 100),
    monitorLogConcurrency: Math.floor(boundedNumber(env.ROBINHOOD_MONITOR_LOG_CONCURRENCY, 2, 1, 2)),
    monitorRecoverySuccesses: Math.floor(boundedNumber(env.ROBINHOOD_MONITOR_RECOVERY_SUCCESSES, 20, 1, 1_000))
  };
}
