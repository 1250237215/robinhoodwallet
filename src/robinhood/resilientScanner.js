import { ROBINHOOD_CHAIN } from './config.js';
import { scanTokenHolders } from './holderScanner.js';
import { onchainHolderFallbackError, scanTokenHoldersOnchainFallback } from './onchainHolderFallback.js';
import { scanToken } from './scanner.js';

const ADDRESS_PATTERN = /^0x[0-9a-f]{40}$/;
const DEBOT_BLOCKED_STATUSES = new Set([401, 403]);
const DEFAULT_DEBOT_BLOCK_COOLDOWN_MS = 5 * 60 * 1_000;

function normalizeAddress(value) {
  return String(value || '').trim().toLowerCase();
}

function number(value) {
  const parsed = Number(value);
  return Number.isFinite(parsed) ? parsed : null;
}

function timestampSeconds(value) {
  const parsed = number(value);
  if (!(parsed > 0)) return null;
  return Math.floor(parsed > 10_000_000_000 ? parsed / 1_000 : parsed);
}

function requestErrorMessage(error) {
  return error instanceof Error ? error.message : String(error || 'DeBot request failed');
}

export function isDebotAccessBlocked(error) {
  const status = Number(error?.status);
  if (DEBOT_BLOCKED_STATUSES.has(status)) return true;
  return /DeBot request failed with HTTP (401|403)/i.test(requestErrorMessage(error));
}

export function dexScreenerTokenMetadata(pairs, tokenAddress) {
  const address = normalizeAddress(tokenAddress);
  const candidate = (Array.isArray(pairs) ? pairs : [])
    .filter((pair) => normalizeAddress(pair?.baseToken?.address) === address)
    .sort((left, right) => (number(right?.liquidity?.usd) ?? -1) - (number(left?.liquidity?.usd) ?? -1))[0];
  if (!candidate) return {};

  return {
    symbol: String(candidate?.baseToken?.symbol || '').trim() || undefined,
    name: String(candidate?.baseToken?.name || candidate?.baseToken?.symbol || '').trim() || undefined,
    priceUsd: number(candidate?.priceUsd),
    liquidityUsd: number(candidate?.liquidity?.usd),
    marketCapUsd: number(candidate?.marketCap ?? candidate?.fdv),
    creationTimestamp: timestampSeconds(candidate?.pairCreatedAt),
    source: 'dexscreener_robinhood'
  };
}

function compactMetadata(metadata) {
  return Object.fromEntries(Object.entries(metadata).filter(([, value]) => value !== null && value !== undefined && value !== ''));
}

function unavailableHolderAnalysis({ reason, onchainComplete, config }) {
  return {
    strategy: 'holder_first_onchain_fallback',
    holderSource: 'unavailable',
    profitSource: 'unavailable',
    complete: false,
    partial: true,
    onchainComplete: onchainComplete === true,
    fetchedHolders: 0,
    analyzedWallets: 0,
    eligibleWallets: 0,
    ignoredBelowEntry: 0,
    failedWallets: 0,
    minimumEntryUsd: Math.max(0, number(config?.minEntryUsd) ?? 500),
    candidates: [],
    failures: [{ stage: 'holder_snapshot', error: reason }],
    limitations: [
      'Holder candidates were not available from Blockscout.',
      'No wallet has been admitted from the onchain fallback path.'
    ],
    error: reason
  };
}

function fullyBlockedHolderAnalysis(result) {
  const analysis = result?.holderAnalysis || result?.tokenPatch?.holderAnalysis;
  const failures = Array.isArray(analysis?.failures) ? analysis.failures : [];
  const candidates = Array.isArray(analysis?.candidates) ? analysis.candidates : [];
  if (!failures.length || candidates.some((candidate) => candidate?.profitState === 'complete')) return null;
  const blockedFailures = failures.filter((failure) => {
    const error = new Error(String(failure?.error || ''));
    error.status = Number(failure?.status) || undefined;
    return isDebotAccessBlocked(error);
  });
  if (blockedFailures.length !== failures.length) return null;
  return blockedFailures[0]?.error || 'DeBot wallet-profit requests were blocked';
}

/**
 * Uses the holder-first DeBot path when it is reachable, and switches to the
 * verified pool/RPC scanner only when DeBot explicitly blocks server traffic.
 */
export function createRobinhoodResilientScanner({
  holderScanner = scanTokenHolders,
  onchainHolderScanner = scanTokenHoldersOnchainFallback,
  onchainScanner = scanToken,
  poolClient,
  rpc,
  config = {},
  now = Date.now,
  debotBlockCooldownMs = DEFAULT_DEBOT_BLOCK_COOLDOWN_MS
} = {}) {
  if (typeof holderScanner !== 'function') throw new TypeError('holderScanner is required');
  if (typeof onchainHolderScanner !== 'function') throw new TypeError('onchainHolderScanner is required');
  if (typeof onchainScanner !== 'function') throw new TypeError('onchainScanner is required');
  if (!poolClient?.fetchPools) throw new TypeError('poolClient.fetchPools is required');
  if (typeof now !== 'function') throw new TypeError('now is required');

  let debotBlockedUntil = 0;

  return async function resilientScan(options = {}) {
    const onProgress = typeof options.onProgress === 'function' ? options.onProgress : () => {};
    const tokenAddress = normalizeAddress(options.token?.address);
    if (!ADDRESS_PATTERN.test(tokenAddress)) throw new TypeError('Invalid Robinhood token address');

    let fallbackReason = '';
    let fallbackStatus = null;
    if (now() >= debotBlockedUntil) {
      try {
        const primaryResult = await holderScanner(options);
        const blockedReason = fullyBlockedHolderAnalysis(primaryResult);
        if (!blockedReason) return primaryResult;
        fallbackReason = String(blockedReason);
        fallbackStatus = /HTTP 401/i.test(fallbackReason) ? 401 : 403;
        debotBlockedUntil = now() + Math.max(0, Number(debotBlockCooldownMs) || 0);
      } catch (error) {
        if (!isDebotAccessBlocked(error)) throw error;
        fallbackReason = requestErrorMessage(error);
        fallbackStatus = Number(error?.status) || 403;
        debotBlockedUntil = now() + Math.max(0, Number(debotBlockCooldownMs) || 0);
      }
    } else {
      fallbackReason = 'DeBot server access is temporarily blocked; using verified onchain data.';
      fallbackStatus = 403;
    }

    onProgress({
      stage: 'onchain_fallback',
      percent: 5,
      source: 'robinhood_rpc',
      fallbackFrom: 'debot',
      fallbackReason
    });

    const pools = await poolClient.fetchPools(tokenAddress, { signal: options.signal });
    const metadata = compactMetadata(dexScreenerTokenMetadata(pools, tokenAddress));
    const result = await onchainScanner({
      ...options,
      token: {
        ...options.token,
        ...metadata,
        address: tokenAddress,
        chain: options.token?.chain || 'robinhood'
      },
      pools,
      poolClient,
      rpc: options.rpc || rpc,
      config: { ...config, ...(options.config || {}) },
      onProgress: (progress) => onProgress({
        ...progress,
        source: 'robinhood_rpc',
        fallbackFrom: 'debot',
        fallbackReason
      })
    });

    const effectiveConfig = { ...config, ...(options.config || {}) };
    let holderResult = null;
    let holderFallbackError = '';
    if (options.holderClient?.fetchTopHolders) {
      try {
        holderResult = await onchainHolderScanner({
          token: {
            ...options.token,
            ...metadata,
            ...(result?.tokenPatch || {}),
            address: tokenAddress,
            chain: options.token?.chain || 'robinhood'
          },
          onchainResult: result,
          holderClient: options.holderClient,
          config: effectiveConfig,
          signal: options.signal,
          onProgress: (progress) => onProgress({
            ...progress,
            source: 'robinhood_rpc',
            fallbackFrom: 'debot',
            fallbackReason,
            analysisSource: 'onchain_holder_fallback'
          })
        });
      } catch (error) {
        if (error?.name === 'AbortError') throw error;
        holderFallbackError = onchainHolderFallbackError(error);
        onProgress({
          stage: 'holder_analysis_partial',
          percent: 100,
          source: 'robinhood_rpc',
          fallbackFrom: 'debot',
          fallbackReason,
          error: holderFallbackError
        });
      }
    } else {
      holderFallbackError = 'Blockscout Holder client is unavailable';
    }

    const holderAnalysis = holderResult?.holderAnalysis || unavailableHolderAnalysis({
      reason: holderFallbackError || 'Blockscout Holder analysis did not return a result',
      onchainComplete: result?.scan?.historyComplete,
      config: effectiveConfig
    });
    const holderScan = holderResult?.scan || {
      complete: false,
      partial: true,
      onchainComplete: result?.scan?.historyComplete === true,
      strategy: holderAnalysis.strategy,
      source: 'robinhood_rpc',
      holderSource: holderAnalysis.holderSource,
      profitSource: holderAnalysis.profitSource,
      fetchedHolders: holderAnalysis.fetchedHolders,
      analyzedWallets: holderAnalysis.analyzedWallets,
      eligibleWallets: holderAnalysis.eligibleWallets,
      ignoredBelowEntry: holderAnalysis.ignoredBelowEntry,
      failedWallets: holderAnalysis.failedWallets,
      minimumEntryUsd: holderAnalysis.minimumEntryUsd
    };

    return {
      ...result,
      actions: Array.isArray(result?.actions) ? result.actions : [],
      tokenPatch: {
        ...metadata,
        ...(result?.tokenPatch || {}),
        ...(holderResult?.tokenPatch || {}),
        holderAnalysis,
        analysisSource: 'onchain_holder_fallback',
        analysisFallback: {
          from: 'debot',
          status: fallbackStatus,
          reason: fallbackReason,
          holderFallbackError: holderFallbackError || null,
          at: new Date(now()).toISOString()
        }
      },
      holderAnalysis,
      qualification: holderResult?.qualification || result?.qualification || null,
      scan: {
        ...(result?.scan || {}),
        ...holderScan,
        source: 'robinhood_rpc',
        analysisSource: 'onchain_holder_fallback',
        fallbackFrom: 'debot',
        fallbackStatus,
        fallbackReason,
        holderFallbackError: holderFallbackError || null
      },
      pool: {
        ...(result?.pool || {}),
        source: result?.pool?.source || 'dexscreener_verified_onchain'
      }
    };
  };
}

export const ROBINHOOD_ONCHAIN_QUOTES = Object.freeze([ROBINHOOD_CHAIN.weth, ROBINHOOD_CHAIN.usdg]);
