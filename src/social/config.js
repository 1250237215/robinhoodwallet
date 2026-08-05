import path from 'node:path';

function boundedInteger(value, fallback, minimum, maximum) {
  const number = Number(value);
  if (!Number.isFinite(number)) return fallback;
  return Math.min(maximum, Math.max(minimum, Math.floor(number)));
}

function xHandles(value) {
  const unique = new Set();
  for (const raw of String(value || '').split(/[\s,]+/)) {
    const handle = raw.trim().replace(/^@/, '').toLowerCase();
    if (/^[a-z0-9_]{1,15}$/.test(handle)) unique.add(handle);
  }
  return [...unique].slice(0, 5);
}

export function createSocialConfig(env = process.env, { fallbackDirectory = null } = {}) {
  const dataFile = env.SOCIAL_DATA_FILE || path.join(
    fallbackDirectory || new URL('../../data', import.meta.url).pathname,
    'social.sqlite'
  );
  return {
    dataFile,
    bridgeToken: String(env.SOCIAL_BRIDGE_TOKEN || '').trim(),
    retentionDays: boundedInteger(env.SOCIAL_RETENTION_DAYS, 7, 1, 90),
    bridgeOfflineMs: boundedInteger(env.SOCIAL_BRIDGE_OFFLINE_MS, 90_000, 3_000, 300_000),
    cleanupIntervalMs: boundedInteger(
      env.SOCIAL_CLEANUP_INTERVAL_MS,
      60 * 60 * 1_000,
      60_000,
      24 * 60 * 60 * 1_000
    ),
    commandLeaseMs: boundedInteger(env.SOCIAL_COMMAND_LEASE_MS, 30_000, 5_000, 10 * 60_000),
    debotJobLeaseMs: boundedInteger(env.SOCIAL_DEBOT_JOB_LEASE_MS, 120_000, 10_000, 5 * 60_000),
    debotRequestTimeoutMs: boundedInteger(env.SOCIAL_DEBOT_REQUEST_TIMEOUT_MS, 30_000, 1_000, 2 * 60_000),
    debotTokenCacheTtlMs: boundedInteger(env.SOCIAL_DEBOT_TOKEN_CACHE_TTL_MS, 60_000, 0, 10 * 60_000),
    debotWalletCacheTtlMs: boundedInteger(env.SOCIAL_DEBOT_WALLET_CACHE_TTL_MS, 30_000, 0, 10 * 60_000),
    debotPendingCap: boundedInteger(env.SOCIAL_DEBOT_PENDING_CAP, 256, 1, 1_024),
    debotTerminalRetentionMs: boundedInteger(
      env.SOCIAL_DEBOT_TERMINAL_RETENTION_MS,
      60 * 60 * 1_000,
      60_000,
      24 * 60 * 60 * 1_000
    ),
    xFastHandles: xHandles(env.SOCIAL_X_FAST_HANDLES),
    xFastPollIntervalMs: boundedInteger(env.SOCIAL_X_FAST_POLL_INTERVAL_MS, 500, 250, 10_000),
    xFastMaxInFlight: boundedInteger(env.SOCIAL_X_FAST_MAX_IN_FLIGHT, 3, 1, 3),
    xFastRequestTimeoutMs: boundedInteger(env.SOCIAL_X_FAST_REQUEST_TIMEOUT_MS, 3_500, 1_000, 15_000),
    xReplyEnrichmentEnabled: !['0', 'false', 'off', 'no'].includes(
      String(env.SOCIAL_X_REPLY_ENRICHMENT || 'true').trim().toLowerCase()
    ),
    translationApiKey: String(env.DEEPSEEK_TRANSLATION_API_KEY || '').trim(),
    translationBaseUrl: String(env.DEEPSEEK_TRANSLATION_BASE_URL || 'https://api.deepseek.com')
      .trim()
      .replace(/\/+$/, ''),
    translationModel: String(env.DEEPSEEK_TRANSLATION_MODEL || 'deepseek-v4-flash').trim(),
    translationTimeoutMs: boundedInteger(env.DEEPSEEK_TRANSLATION_TIMEOUT_MS, 8_000, 500, 15_000),
    translationMaxAttempts: boundedInteger(env.DEEPSEEK_TRANSLATION_MAX_ATTEMPTS, 2, 1, 3),
    translationRetryDelayMs: boundedInteger(env.DEEPSEEK_TRANSLATION_RETRY_DELAY_MS, 200, 0, 5_000),
    translationConcurrency: boundedInteger(env.DEEPSEEK_TRANSLATION_CONCURRENCY, 3, 1, 8),
    translationMaxQueue: boundedInteger(env.DEEPSEEK_TRANSLATION_MAX_QUEUE, 1_000, 10, 10_000),
    translationCacheSize: boundedInteger(env.DEEPSEEK_TRANSLATION_CACHE_SIZE, 2_000, 10, 20_000)
  };
}
