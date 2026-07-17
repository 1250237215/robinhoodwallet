import path from 'node:path';

function boundedInteger(value, fallback, minimum, maximum) {
  const number = Number(value);
  if (!Number.isFinite(number)) return fallback;
  return Math.min(maximum, Math.max(minimum, Math.floor(number)));
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
    commandLeaseMs: boundedInteger(env.SOCIAL_COMMAND_LEASE_MS, 30_000, 5_000, 10 * 60_000)
  };
}
