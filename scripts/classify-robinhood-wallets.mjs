#!/usr/bin/env node

import path from 'node:path';
import { pathToFileURL } from 'node:url';

import {
  classifyWalletMonitorTier,
  WALLET_MONITOR_TIERS,
  WALLET_TIER_THRESHOLDS
} from '../src/robinhood/tiering.js';

const ADDRESS_PATTERN = /^0x[0-9a-f]{40}$/;
const DEFAULT_API_ROOT = 'http://127.0.0.1:18118/api/robinhood';
const DEFAULT_CONCURRENCY = 6;
const DEFAULT_TIMEOUT_MS = 20_000;
const MAX_CONCURRENCY = 20;
const MAX_TIMEOUT_MS = 120_000;

function finiteNumber(...values) {
  for (const value of values) {
    if (value === null || value === undefined || value === '') continue;
    const number = Number(value);
    if (Number.isFinite(number)) return number;
  }
  return null;
}

function maximum(values) {
  const numbers = values.map((value) => finiteNumber(value)).filter((value) => value !== null);
  return numbers.length ? Math.max(...numbers) : null;
}

function integerOption(value, name, minimum, maximum) {
  const number = Number(value);
  if (!Number.isInteger(number) || number < minimum || number > maximum) {
    throw new TypeError(`${name} must be an integer from ${minimum} to ${maximum}`);
  }
  return number;
}

export function normalizeApiRoot(value) {
  let url;
  try {
    url = new URL(String(value || ''));
  } catch {
    throw new TypeError('--api-root must be an absolute HTTP(S) URL');
  }
  if (!['http:', 'https:'].includes(url.protocol) || url.username || url.password) {
    throw new TypeError('--api-root must be an absolute HTTP(S) URL without embedded credentials');
  }
  if (url.search || url.hash) throw new TypeError('--api-root must not contain a query string or fragment');
  url.pathname = url.pathname.replace(/\/+$/, '');
  return url.toString().replace(/\/$/, '');
}

function optionValue(argv, index, name) {
  const argument = argv[index];
  const prefix = `${name}=`;
  if (argument.startsWith(prefix)) return { value: argument.slice(prefix.length), consumed: 0 };
  if (argument !== name) return null;
  if (index + 1 >= argv.length || argv[index + 1].startsWith('--')) {
    throw new TypeError(`${name} requires a value`);
  }
  return { value: argv[index + 1], consumed: 1 };
}

export function parseCliArgs(argv = [], env = process.env) {
  const options = {
    apply: false,
    apiRoot: normalizeApiRoot(env.ROBINHOOD_API_ROOT || DEFAULT_API_ROOT),
    concurrency: integerOption(
      env.ROBINHOOD_CLASSIFY_CONCURRENCY || DEFAULT_CONCURRENCY,
      '--concurrency',
      1,
      MAX_CONCURRENCY
    ),
    timeoutMs: integerOption(
      env.ROBINHOOD_CLASSIFY_TIMEOUT_MS || DEFAULT_TIMEOUT_MS,
      '--timeout-ms',
      1_000,
      MAX_TIMEOUT_MS
    ),
    help: false
  };

  for (let index = 0; index < argv.length; index += 1) {
    const argument = argv[index];
    if (argument === '--apply') {
      options.apply = true;
      continue;
    }
    if (argument === '--dry-run') {
      options.apply = false;
      continue;
    }
    if (argument === '--help' || argument === '-h') {
      options.help = true;
      continue;
    }

    const apiRoot = optionValue(argv, index, '--api-root');
    if (apiRoot) {
      options.apiRoot = normalizeApiRoot(apiRoot.value);
      index += apiRoot.consumed;
      continue;
    }
    const concurrency = optionValue(argv, index, '--concurrency');
    if (concurrency) {
      options.concurrency = integerOption(concurrency.value, '--concurrency', 1, MAX_CONCURRENCY);
      index += concurrency.consumed;
      continue;
    }
    const timeout = optionValue(argv, index, '--timeout-ms');
    if (timeout) {
      options.timeoutMs = integerOption(timeout.value, '--timeout-ms', 1_000, MAX_TIMEOUT_MS);
      index += timeout.consumed;
      continue;
    }
    throw new TypeError(`Unknown option: ${argument}`);
  }
  return options;
}

export function classificationInput(wallet = {}) {
  const entries = finiteNumber(
    wallet.entries,
    wallet.eligibleEntries,
    wallet.manualTokenParticipationCount
  );
  const hits = finiteNumber(wallet.hits, wallet.winnerHits, wallet.qualifiedWinnerHits);
  const totalTradeCount = finiteNumber(wallet.totalTradeCount, wallet.tradeCount);
  const explicitTradeFrequency = finiteNumber(
    wallet.tradeFrequency,
    wallet.tradesPerToken,
    wallet.averageTradesPerToken
  );
  const tradeFrequency = explicitTradeFrequency ?? (
    entries !== null && entries > 0 && totalTradeCount !== null
      ? totalTradeCount / entries
      : null
  );
  const totalProfitUsd = finiteNumber(
    wallet.totalProfitUsd,
    wallet.netProfitUsd,
    wallet.profitUsd
  );
  const bestMultiple = maximum([
    wallet.bestMultiple,
    wallet.maxMultiple,
    wallet.maxPeakMultiple,
    wallet.maxTotalMultiple,
    wallet.maxRealizedMultiple,
    wallet.maxUnrealizedMultiple
  ]);
  return { entries, hits, tradeFrequency, totalTradeCount, totalProfitUsd, bestMultiple };
}

function currentMonitorTier(wallet) {
  const value = String(wallet?.monitorTier || '').toLowerCase();
  return WALLET_MONITOR_TIERS.has(value) ? value : null;
}

function walletRows(payload) {
  if (Array.isArray(payload)) return payload;
  if (!payload || typeof payload !== 'object') throw new TypeError('Wallet API response must be a JSON object');
  const rows = payload.wallets ?? payload.data?.wallets;
  if (!Array.isArray(rows)) throw new TypeError('Wallet API response did not contain a wallets array');
  return rows;
}

function reportedCounts(payload) {
  if (!payload || typeof payload !== 'object' || Array.isArray(payload)) return [];
  return [
    ['count', payload.count],
    ['walletCount', payload.walletCount],
    ['counts.wallets', payload.counts?.wallets]
  ].filter(([, value]) => value !== undefined && value !== null);
}

export function validateConfirmedWallets(payload) {
  const rows = walletRows(payload);
  for (const [name, rawValue] of reportedCounts(payload)) {
    const value = Number(rawValue);
    if (!Number.isInteger(value) || value < 0 || value !== rows.length) {
      throw new Error(`Wallet API ${name}=${rawValue} does not match wallets.length=${rows.length}`);
    }
  }

  const seen = new Set();
  return rows.map((wallet, index) => {
    if (!wallet || typeof wallet !== 'object' || Array.isArray(wallet)) {
      throw new TypeError(`wallets[${index}] must be an object`);
    }
    const address = String(wallet.address || '').toLowerCase();
    if (!ADDRESS_PATTERN.test(address)) throw new Error(`wallets[${index}] has an invalid address`);
    if (seen.has(address)) throw new Error(`Wallet API returned a duplicate address: ${address}`);
    seen.add(address);

    const reviewState = String(wallet.reviewState || '').toLowerCase();
    if (wallet.confirmed !== true && reviewState !== 'confirmed') {
      throw new Error(`Wallet API returned a non-confirmed address: ${address}`);
    }
    if (String(wallet.status || '').toLowerCase() === 'excluded') {
      throw new Error(`Wallet API returned an excluded address as confirmed: ${address}`);
    }
    return { ...wallet, address };
  });
}

function tierCounts(evidence, selector) {
  const counts = { core: 0, watch: 0, high_frequency: 0, unassigned: 0 };
  for (const row of evidence) {
    const tier = selector(row);
    if (tier && Object.hasOwn(counts, tier)) counts[tier] += 1;
    else counts.unassigned += 1;
  }
  return counts;
}

export function classifyConfirmedWallets(wallets) {
  const evidence = wallets.map((wallet) => {
    const input = classificationInput(wallet);
    const classification = classifyWalletMonitorTier(input);
    if (!WALLET_MONITOR_TIERS.has(classification.monitorTier)) {
      throw new Error(`Classifier returned an unsupported tier for ${wallet.address}`);
    }
    const previous = currentMonitorTier(wallet);
    return {
      address: wallet.address,
      currentMonitorTier: previous,
      proposedMonitorTier: classification.monitorTier,
      changed: previous !== classification.monitorTier,
      reasons: [...classification.reasons],
      metrics: { ...classification.metrics }
    };
  }).sort((left, right) => left.address.localeCompare(right.address));

  const addresses = new Set(evidence.map((row) => row.address));
  const proposedTiers = tierCounts(evidence, (row) => row.proposedMonitorTier);
  const classifiedTierCount = proposedTiers.core + proposedTiers.watch + proposedTiers.high_frequency;
  const changesPlanned = evidence.filter((row) => row.changed).length;
  if (addresses.size !== wallets.length || evidence.length !== wallets.length) {
    throw new Error('Classification address counts are inconsistent');
  }
  if (classifiedTierCount !== evidence.length || proposedTiers.unassigned !== 0) {
    throw new Error('Classification tier counts are inconsistent');
  }
  if (changesPlanned + evidence.filter((row) => !row.changed).length !== evidence.length) {
    throw new Error('Classification change counts are inconsistent');
  }
  return evidence;
}

async function fetchJson(url, options, { fetchImpl, timeoutMs }) {
  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(new Error(`Request timed out after ${timeoutMs}ms`)), timeoutMs);
  try {
    const response = await fetchImpl(url, { ...options, signal: controller.signal });
    const text = await response.text();
    let body = null;
    if (text) {
      try {
        body = JSON.parse(text);
      } catch {
        throw new Error(`HTTP ${response.status} returned invalid JSON`);
      }
    }
    if (!response.ok) {
      const message = body?.error || body?.message || `HTTP ${response.status}`;
      const error = new Error(message);
      error.status = response.status;
      throw error;
    }
    return body;
  } finally {
    clearTimeout(timeout);
  }
}

function confirmedWalletsUrl(apiRoot) {
  const url = new URL(`${apiRoot}/wallets`);
  url.searchParams.set('tab', 'all');
  url.searchParams.set('review', 'confirmed');
  url.searchParams.set('status', 'all');
  return url.toString();
}

async function mapLimit(items, concurrency, mapper) {
  const results = new Array(items.length);
  let cursor = 0;
  const workers = Array.from({ length: Math.min(items.length, concurrency) }, async () => {
    while (cursor < items.length) {
      const index = cursor;
      cursor += 1;
      results[index] = await mapper(items[index], index);
    }
  });
  await Promise.all(workers);
  return results;
}

function responseMonitorTier(payload) {
  const value = payload?.wallet?.monitorTier ?? payload?.monitorTier;
  if (value === null || value === undefined || value === '') return null;
  return String(value).toLowerCase();
}

async function applyTierChanges(changes, options, dependencies) {
  return mapLimit(changes, options.concurrency, async (evidence) => {
    const url = `${options.apiRoot}/wallets/${encodeURIComponent(evidence.address)}`;
    try {
      const payload = await fetchJson(url, {
        method: 'PATCH',
        headers: {
          accept: 'application/json',
          'content-type': 'application/json'
        },
        body: JSON.stringify({ monitorTier: evidence.proposedMonitorTier })
      }, dependencies);
      const returnedTier = responseMonitorTier(payload);
      if (returnedTier !== null && returnedTier !== evidence.proposedMonitorTier) {
        throw new Error(`PATCH returned monitorTier=${returnedTier}`);
      }
      return {
        address: evidence.address,
        monitorTier: evidence.proposedMonitorTier,
        ok: true,
        responseVerified: returnedTier !== null
      };
    } catch (error) {
      return {
        address: evidence.address,
        monitorTier: evidence.proposedMonitorTier,
        ok: false,
        status: Number.isInteger(error?.status) ? error.status : null,
        error: error instanceof Error ? error.message : String(error)
      };
    }
  });
}

export async function runWalletClassification(options, {
  fetchImpl = globalThis.fetch,
  now = () => new Date()
} = {}) {
  if (typeof fetchImpl !== 'function') throw new TypeError('fetchImpl is required');
  const normalizedOptions = {
    apply: options?.apply === true,
    apiRoot: normalizeApiRoot(options?.apiRoot || DEFAULT_API_ROOT),
    concurrency: integerOption(options?.concurrency ?? DEFAULT_CONCURRENCY, '--concurrency', 1, MAX_CONCURRENCY),
    timeoutMs: integerOption(options?.timeoutMs ?? DEFAULT_TIMEOUT_MS, '--timeout-ms', 1_000, MAX_TIMEOUT_MS)
  };
  const sourceUrl = confirmedWalletsUrl(normalizedOptions.apiRoot);
  const payload = await fetchJson(sourceUrl, {
    method: 'GET',
    headers: { accept: 'application/json' }
  }, { fetchImpl, timeoutMs: normalizedOptions.timeoutMs });
  const wallets = validateConfirmedWallets(payload);
  const evidence = classifyConfirmedWallets(wallets);
  const changes = evidence.filter((row) => row.changed);
  const applications = normalizedOptions.apply
    ? await applyTierChanges(changes, normalizedOptions, {
        fetchImpl,
        timeoutMs: normalizedOptions.timeoutMs
      })
    : [];
  const succeeded = applications.filter((row) => row.ok).length;
  const failed = applications.length - succeeded;
  if (applications.length !== (normalizedOptions.apply ? changes.length : 0) || succeeded + failed !== applications.length) {
    throw new Error('Application counts are inconsistent');
  }

  const proposedTiers = tierCounts(evidence, (row) => row.proposedMonitorTier);
  delete proposedTiers.unassigned;
  const currentTiers = tierCounts(evidence, (row) => row.currentMonitorTier);
  return {
    schemaVersion: 1,
    ok: failed === 0,
    generatedAt: now().toISOString(),
    mode: normalizedOptions.apply ? 'apply' : 'dry-run',
    source: {
      endpoint: sourceUrl,
      selection: { tab: 'all', review: 'confirmed', status: 'all' }
    },
    thresholds: { ...WALLET_TIER_THRESHOLDS },
    counts: {
      fetched: wallets.length,
      uniqueAddresses: new Set(wallets.map((wallet) => wallet.address)).size,
      classified: evidence.length,
      currentTiers,
      proposedTiers,
      changesPlanned: changes.length,
      unchanged: evidence.length - changes.length,
      apply: {
        attempted: applications.length,
        succeeded,
        failed
      }
    },
    evidence,
    applications
  };
}

export const USAGE = `Usage: node scripts/classify-robinhood-wallets.mjs [options]

Classify confirmed Robinhood wallets. The default mode is a read-only dry run.

Options:
  --api-root URL       Robinhood API root (default: ${DEFAULT_API_ROOT})
  --apply              PATCH changed wallets after validation
  --dry-run            Explicitly select read-only mode
  --concurrency N      PATCH concurrency, 1-${MAX_CONCURRENCY} (default: ${DEFAULT_CONCURRENCY})
  --timeout-ms N       Per-request timeout, 1000-${MAX_TIMEOUT_MS} (default: ${DEFAULT_TIMEOUT_MS})
  -h, --help           Show this help

Environment:
  ROBINHOOD_API_ROOT
  ROBINHOOD_CLASSIFY_CONCURRENCY
  ROBINHOOD_CLASSIFY_TIMEOUT_MS`;

export async function main(argv = process.argv.slice(2), dependencies = {}) {
  const options = parseCliArgs(argv, dependencies.env || process.env);
  if (options.help) {
    (dependencies.stdout || process.stdout).write(`${USAGE}\n`);
    return 0;
  }
  const report = await runWalletClassification(options, dependencies);
  (dependencies.stdout || process.stdout).write(`${JSON.stringify(report, null, 2)}\n`);
  return report.counts.apply.failed > 0 ? 2 : 0;
}

const isMain = Boolean(
  process.argv[1] && pathToFileURL(path.resolve(process.argv[1])).href === import.meta.url
);
if (isMain) {
  main().then((exitCode) => {
    process.exitCode = exitCode;
  }).catch((error) => {
    process.stderr.write(`${JSON.stringify({
      schemaVersion: 1,
      ok: false,
      mode: process.argv.includes('--apply') ? 'apply' : 'dry-run',
      error: error instanceof Error ? error.message : String(error)
    }, null, 2)}\n`);
    process.exitCode = 1;
  });
}
