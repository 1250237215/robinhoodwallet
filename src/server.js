import http from 'node:http';
import fs from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

import { TokenAnalysisService } from './analysisService.js';
import { DebotBrowserClient } from './debotBrowserClient.js';
import { createNarrativeGeneratorFromEnv } from './deepseekNarrative.js';
import { createDevTweetAttitudeAnalyzerFromEnv } from './devTweetAttitude.js';
import { createRobinhoodConfig } from './robinhood/config.js';
import { RobinhoodDebotClient } from './robinhood/debotClient.js';
import { RobinhoodHolderClient } from './robinhood/holderClient.js';
import { RobinhoodPoolClient } from './robinhood/poolClient.js';
import { validateWalletMonitorRulesPatch } from './robinhood/monitorRules.js';
import { createRobinhoodResilientScanner } from './robinhood/resilientScanner.js';
import { RobinhoodRpcClient } from './robinhood/rpcClient.js';
import { createRobinhoodService, MAX_WALLET_BATCH_LINES } from './robinhood/service.js';
import { createRobinhoodStore } from './robinhood/store.js';
import { WALLET_MONITOR_TIERS } from './robinhood/tiering.js';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const publicDir = path.resolve(__dirname, '../public');
const lucideVendorFile = path.resolve(__dirname, '../node_modules/lucide/dist/umd/lucide.min.js');
const defaultPort = Number(process.env.PORT || 63464);
const host = process.env.HOST || '127.0.0.1';

const client = new DebotBrowserClient({
  limit: 10,
  headless: process.env.DEBOT_HEADLESS === '1'
});
const analysisService = createAnalysisServiceFromEnv();
let defaultRobinhoodService = null;
let defaultRobinhoodStore = null;

const contentTypes = {
  '.html': 'text/html; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.js': 'text/javascript; charset=utf-8',
  '.json': 'application/json; charset=utf-8',
  '.svg': 'image/svg+xml'
};

const robinhoodTabs = new Set(['all_round', 'realized', 'unrealized', 'single_hit', 'all']);
const robinhoodWalletStatuses = new Set(['active', 'excluded', 'watch', 'all']);
const robinhoodWalletClassifications = new Set(['all_round', 'realized', 'unrealized', 'single_hit', 'all']);
const robinhoodWalletReviewStates = new Set(['pending', 'confirmed', 'excluded', 'all']);

class HttpError extends Error {
  constructor(statusCode, message, code, details = {}) {
    super(message);
    this.statusCode = statusCode;
    this.code = code;
    Object.assign(this, details);
  }
}

export function createAnalysisServiceFromEnv(env = process.env) {
  return new TokenAnalysisService({
    ttlMs: Number(env.ANALYSIS_CACHE_TTL_MS || 6 * 60 * 60 * 1000),
    narrativeGenerator: createNarrativeGeneratorFromEnv(env),
    devTweetAttitudeAnalyzer: createDevTweetAttitudeAnalyzerFromEnv(env)
  });
}

function sendJson(res, statusCode, body) {
  res.writeHead(statusCode, {
    'content-type': 'application/json; charset=utf-8',
    'cache-control': 'no-store'
  });
  res.end(JSON.stringify(body));
}

export function createDefaultRobinhoodService(env = process.env, overrides = {}) {
  const config = overrides.config || createRobinhoodConfig(env);
  const store = overrides.store || createRobinhoodStore(config.dataFile);
  const activeDebotClient = overrides.debotClient || new RobinhoodDebotClient({ timeoutMs: config.requestTimeoutMs });
  const activeHolderClient = overrides.holderClient || new RobinhoodHolderClient({
    baseUrl: config.blockscoutApiUrl,
    timeoutMs: config.requestTimeoutMs
  });
  const activePoolClient = overrides.poolClient || new RobinhoodPoolClient({ timeoutMs: config.requestTimeoutMs });
  const activeRpcClient = overrides.rpc || new RobinhoodRpcClient({
    rpcUrl: config.rpcUrl,
    timeoutMs: config.requestTimeoutMs,
    maxRetries: config.rpcMaxRetries,
    retryDelayMs: config.rpcRetryDelayMs,
    maxRetryDelayMs: config.rpcMaxRetryDelayMs,
    logWindow: config.logWindow,
    batchSize: config.rpcBatchSize,
    batchDelayMs: config.rpcBatchDelayMs
  });
  const service = createRobinhoodService({
    config,
    store,
    debotClient: activeDebotClient,
    holderClient: activeHolderClient,
    poolClient: activePoolClient,
    scanToken: Object.hasOwn(overrides, 'scanToken')
      ? overrides.scanToken
      : createRobinhoodResilientScanner({ poolClient: activePoolClient, rpc: activeRpcClient, config }),
    scanConcurrency: Number(env.ROBINHOOD_SCAN_CONCURRENCY || 1)
  });
  service.start();
  return { service, store };
}

function getDefaultRobinhoodService() {
  if (!defaultRobinhoodService) {
    const created = createDefaultRobinhoodService();
    defaultRobinhoodService = created.service;
    defaultRobinhoodStore = created.store;
  }
  return defaultRobinhoodService;
}

export function sanitizeAnalysisForPublic(analysis) {
  if (!analysis || typeof analysis !== 'object') {
    return analysis;
  }

  const next = structuredClone(analysis);
  if (next.narrative && typeof next.narrative === 'object') {
    delete next.narrative.llmProvider;
    delete next.narrative.llmModel;
    delete next.narrative.llmFallbackFrom;
    delete next.narrative.llmUpdatedAt;
  }
  return next;
}

export async function fetchSignalPayloadWithDeps({
  limit = 10,
  prefetch = true,
  client: signalClient = client,
  analysisService: tokenAnalysisService = analysisService
} = {}) {
  const result = await signalClient.fetchSignals(limit);
  const liveRows = await tokenAnalysisService.enrichRowsWithRealtime(result.rows || []).catch(() => result.rows || []);
  const rows = tokenAnalysisService.decorateRows(liveRows);
  if (prefetch) {
    tokenAnalysisService.prefetchRows(rows);
  }
  return {
    ...result,
    rows
  };
}

async function fetchSignalPayload(limit = 10, options = {}) {
  return fetchSignalPayloadWithDeps({
    limit,
    ...options
  });
}

async function serveStatic(req, res) {
  const url = new URL(req.url, `http://${req.headers.host || `${host}:${defaultPort}`}`);
  if (url.pathname === '/vendor/lucide.js') {
    try {
      const data = await fs.readFile(lucideVendorFile);
      res.writeHead(200, {
        'content-type': contentTypes['.js'],
        'cache-control': 'no-store'
      });
      res.end(data);
    } catch {
      res.writeHead(404);
      res.end('Not found');
    }
    return;
  }
  const pathname = decodeURIComponent(url.pathname === '/' ? '/index.html' : url.pathname);
  const resolved = path.resolve(publicDir, `.${pathname}`);

  if (!resolved.startsWith(publicDir)) {
    res.writeHead(403);
    res.end('Forbidden');
    return;
  }

  try {
    const data = await fs.readFile(resolved);
    res.writeHead(200, {
      'content-type': contentTypes[path.extname(resolved)] || 'application/octet-stream',
      'cache-control': 'no-store'
    });
    res.end(data);
  } catch {
    res.writeHead(404);
    res.end('Not found');
  }
}

function methodNotAllowed(methods) {
  throw new HttpError(405, 'Method not allowed', 'METHOD_NOT_ALLOWED', { allow: methods.join(', ') });
}

function parseBoundedNumber(searchParams, name, { minimum, maximum, integer = false } = {}) {
  if (!searchParams.has(name)) return undefined;
  const raw = searchParams.get(name);
  if (raw === null || raw.trim() === '') {
    throw new HttpError(400, `${name} must be a number`, 'INVALID_FILTER');
  }
  const value = Number(raw);
  if (!Number.isFinite(value) || value < minimum || value > maximum || (integer && !Number.isInteger(value))) {
    throw new HttpError(400, `${name} is outside the allowed range`, 'INVALID_FILTER');
  }
  return value;
}

export function parseRobinhoodDashboardFilters(searchParams) {
  const tab = searchParams.get('tab') || undefined;
  if (tab && !robinhoodTabs.has(tab)) {
    throw new HttpError(400, 'tab is not supported', 'INVALID_FILTER');
  }
  const strategy = searchParams.get('strategy') || undefined;
  if (strategy && !['smart', 'multiple'].includes(strategy)) {
    throw new HttpError(400, 'strategy is not supported', 'INVALID_FILTER');
  }
  const minEntryUsd = parseBoundedNumber(searchParams, 'minEntryUsd', { minimum: 0, maximum: 1_000_000_000 });
  return {
    multiple: parseBoundedNumber(searchParams, 'multiple', { minimum: 1, maximum: 1000 }),
    minLiquidityUsd: parseBoundedNumber(searchParams, 'minLiquidityUsd', { minimum: 0, maximum: 1_000_000_000 }),
    minWallets: parseBoundedNumber(searchParams, 'minWallets', { minimum: 1, maximum: 1_000_000, integer: true }),
    tab,
    ...(minEntryUsd === undefined ? {} : { minEntryUsd }),
    ...(strategy ? { strategy } : {})
  };
}

export function parseRobinhoodWalletFilters(searchParams) {
  const filters = parseRobinhoodDashboardFilters(searchParams);
  const status = searchParams.get('status') || undefined;
  if (status && !robinhoodWalletStatuses.has(status)) {
    throw new HttpError(400, 'status is not supported', 'INVALID_FILTER');
  }
  const classification = searchParams.get('classification') || undefined;
  if (classification && !robinhoodWalletClassifications.has(classification)) {
    throw new HttpError(400, 'classification is not supported', 'INVALID_FILTER');
  }
  const review = searchParams.get('review') || undefined;
  if (review && !robinhoodWalletReviewStates.has(review)) {
    throw new HttpError(400, 'review is not supported', 'INVALID_FILTER');
  }
  const monitorTier = searchParams.get('monitorTier') || undefined;
  if (monitorTier && !WALLET_MONITOR_TIERS.has(monitorTier)) {
    throw new HttpError(400, 'monitorTier is not supported', 'INVALID_FILTER');
  }
  const search = (searchParams.get('search') || searchParams.get('q') || '').trim() || undefined;
  if (search && search.length > 200) throw new HttpError(400, 'search is too long', 'INVALID_FILTER');
  const tags = [...searchParams.getAll('tag'), ...(searchParams.get('tags') || '').split(',')]
    .map((tag) => tag.trim())
    .filter(Boolean);
  if (tags.length > 32 || tags.some((tag) => tag.length > 64)) {
    throw new HttpError(400, 'tag filter is too large', 'INVALID_FILTER');
  }
  return {
    ...filters,
    ...(status ? { status } : {}),
    ...(classification ? { classification } : {}),
    ...(review ? { review } : {}),
    ...(monitorTier ? { monitorTier } : {}),
    ...(search ? { search } : {}),
    ...(tags.length ? { tags: [...new Set(tags)] } : {})
  };
}

async function readJsonBody(req, { maxBytes = 32 * 1024 } = {}) {
  const chunks = [];
  let bytes = 0;
  for await (const chunk of req) {
    bytes += chunk.length;
    if (bytes > maxBytes) throw new HttpError(413, 'Request body is too large', 'BODY_TOO_LARGE');
    chunks.push(chunk);
  }
  if (!chunks.length) return {};
  let body;
  try {
    body = JSON.parse(Buffer.concat(chunks).toString('utf8'));
  } catch {
    throw new HttpError(400, 'Request body must be valid JSON', 'INVALID_JSON');
  }
  if (!body || typeof body !== 'object' || Array.isArray(body)) {
    throw new HttpError(400, 'Request body must be a JSON object', 'INVALID_JSON');
  }
  return body;
}

function validatedScanOptions(body = {}) {
  if (!Object.hasOwn(body, 'minEntryUsd')) return {};
  if (
    typeof body.minEntryUsd !== 'number' ||
    !Number.isFinite(body.minEntryUsd) ||
    body.minEntryUsd < 0 ||
    body.minEntryUsd > 1_000_000_000
  ) {
    throw new HttpError(
      400,
      'minEntryUsd must be a number from 0 to 1000000000',
      'INVALID_SCAN_OPTIONS'
    );
  }
  return { minEntryUsd: body.minEntryUsd };
}

function validatedWalletPatch(body) {
  const patch = {};
  if (Object.hasOwn(body, 'alias')) {
    if (body.alias !== null && typeof body.alias !== 'string') {
      throw new HttpError(400, 'alias must be a string', 'INVALID_WALLET_UPDATE');
    }
    patch.alias = body.alias ?? '';
    if (patch.alias.length > 120) throw new HttpError(400, 'alias is too long', 'INVALID_WALLET_UPDATE');
  }
  if (Object.hasOwn(body, 'note')) {
    if (body.note !== null && typeof body.note !== 'string') {
      throw new HttpError(400, 'note must be a string', 'INVALID_WALLET_UPDATE');
    }
    patch.note = body.note ?? '';
    if (patch.note.length > 4000) throw new HttpError(400, 'note is too long', 'INVALID_WALLET_UPDATE');
  }
  if (Object.hasOwn(body, 'tags')) {
    if (!Array.isArray(body.tags) || body.tags.some((tag) => typeof tag !== 'string')) {
      throw new HttpError(400, 'tags must be an array of strings', 'INVALID_WALLET_UPDATE');
    }
    if (body.tags.length > 32 || body.tags.some((tag) => tag.length > 64)) {
      throw new HttpError(400, 'tags are too large', 'INVALID_WALLET_UPDATE');
    }
    patch.tags = body.tags;
  }
  if (Object.hasOwn(body, 'status')) {
    if (!robinhoodWalletStatuses.has(body.status) || body.status === 'all') {
      throw new HttpError(400, 'status is not supported', 'INVALID_WALLET_UPDATE');
    }
    patch.status = body.status;
  }
  const classificationKey = Object.hasOwn(body, 'classificationOverride')
    ? 'classificationOverride'
    : Object.hasOwn(body, 'classification')
      ? 'classification'
      : null;
  if (classificationKey) {
    const value = body[classificationKey];
    if (value !== null && value !== '' && (!robinhoodWalletClassifications.has(value) || value === 'all')) {
      throw new HttpError(400, 'classification override is not supported', 'INVALID_WALLET_UPDATE');
    }
    patch.classificationOverride = value || null;
  }
  if (Object.hasOwn(body, 'monitorTier')) {
    if (typeof body.monitorTier !== 'string' || !WALLET_MONITOR_TIERS.has(body.monitorTier)) {
      throw new HttpError(400, 'monitorTier is not supported', 'INVALID_WALLET_UPDATE');
    }
    patch.monitorTier = body.monitorTier;
  }
  if (Object.hasOwn(body, 'monitorRules')) {
    try {
      patch.monitorRules = validateWalletMonitorRulesPatch(body.monitorRules);
    } catch (error) {
      throw new HttpError(
        400,
        error instanceof Error ? error.message : 'monitorRules is invalid',
        'INVALID_WALLET_UPDATE'
      );
    }
  }
  if (!Object.keys(patch).length) {
    throw new HttpError(400, 'No supported wallet fields were provided', 'INVALID_WALLET_UPDATE');
  }
  return patch;
}

function validatedWalletBatchLines(body) {
  if (!Object.hasOwn(body, 'lines') || (typeof body.lines !== 'string' && !Array.isArray(body.lines))) {
    throw new HttpError(400, 'lines must be a string or an array', 'INVALID_WALLET_BATCH');
  }
  const count = typeof body.lines === 'string' ? body.lines.split(/\r\n?|\n/).length : body.lines.length;
  if (count > MAX_WALLET_BATCH_LINES) {
    throw new HttpError(
      400,
      `Wallet batch cannot exceed ${MAX_WALLET_BATCH_LINES} lines`,
      'INVALID_WALLET_BATCH'
    );
  }
  return body.lines;
}

function validatedAddress(value, kind) {
  const address = typeof value === 'string' ? value.toLowerCase() : '';
  if (!/^0x[0-9a-f]{40}$/.test(address)) {
    throw new HttpError(400, `Invalid Robinhood ${kind} address`, 'INVALID_ADDRESS');
  }
  return address;
}

async function handleRobinhoodRequest(req, res, url, service) {
  if (!url.pathname.startsWith('/api/robinhood/')) return false;

  if (url.pathname === '/api/robinhood/overview') {
    if (req.method !== 'GET') methodNotAllowed(['GET']);
    const dashboard = await service.getDashboard(parseRobinhoodDashboardFilters(url.searchParams));
    const winnerCount = dashboard.winners?.length || 0;
    sendJson(res, dashboard.ok ? 200 : dashboard.stale ? 206 : 503, {
      ok: dashboard.ok,
      status: dashboard.status,
      mode: dashboard.mode,
      discoveryEnabled: dashboard.discoveryEnabled,
      counts: {
        wallets: dashboard.wallets?.length || 0,
        winners: winnerCount,
        candidates: winnerCount
      },
      walletCount: dashboard.wallets?.length || 0,
      winnerCount,
      updatedAt: dashboard.updatedAt,
      stale: dashboard.stale,
      partial: dashboard.partial,
      warnings: dashboard.warnings
    });
    return true;
  }

  if (url.pathname === '/api/robinhood/wallets') {
    if (req.method !== 'GET') methodNotAllowed(['GET']);
    const dashboard = await service.getDashboard(parseRobinhoodWalletFilters(url.searchParams));
    sendJson(res, dashboard.ok ? 200 : dashboard.stale && dashboard.wallets?.length ? 206 : 503, {
      ok: dashboard.ok,
      wallets: dashboard.wallets || [],
      filters: dashboard.filters,
      updatedAt: dashboard.updatedAt,
      stale: dashboard.stale
    });
    return true;
  }

  if (url.pathname === '/api/robinhood/jobs') {
    if (req.method !== 'GET') methodNotAllowed(['GET']);
    const dashboard = await service.getDashboard({ tab: 'all' });
    sendJson(res, 200, { ok: true, jobs: dashboard.jobs || [], updatedAt: dashboard.updatedAt });
    return true;
  }

  if (url.pathname === '/api/robinhood/jobs/scan') {
    if (req.method !== 'POST') methodNotAllowed(['POST']);
    const body = req.headers['content-length'] !== undefined || req.headers['transfer-encoding']
      ? await readJsonBody(req)
      : {};
    const options = validatedScanOptions(body);
    const result = typeof service.triggerScan === 'function'
      ? await service.triggerScan({ force: true, ...options })
      : await service.triggerRefresh();
    sendJson(res, result.accepted === false ? 200 : 202, result);
    return true;
  }

  if (url.pathname === '/api/robinhood/dashboard') {
    if (req.method !== 'GET') methodNotAllowed(['GET']);
    const dashboard = await service.getDashboard(parseRobinhoodWalletFilters(url.searchParams));
    const cachedRows = (dashboard.winners?.length || 0) + (dashboard.wallets?.length || 0);
    const statusCode = dashboard.ok ? 200 : dashboard.stale && cachedRows ? 206 : 503;
    sendJson(res, statusCode, dashboard);
    return true;
  }

  if (url.pathname === '/api/robinhood/refresh') {
    if (req.method !== 'POST') methodNotAllowed(['POST']);
    if (req.headers['content-length'] !== undefined || req.headers['transfer-encoding']) await readJsonBody(req);
    let result;
    if (typeof service.triggerRefresh === 'function') {
      result = await service.triggerRefresh();
    } else {
      void Promise.resolve(service.refresh?.());
      result = { ok: true, accepted: true, status: 'refreshing', updatedAt: new Date().toISOString() };
    }
    sendJson(res, result.accepted === false ? 200 : 202, result);
    return true;
  }

  if (url.pathname === '/api/robinhood/winners') {
    if (req.method === 'GET') {
      const dashboard = await service.getDashboard({
        ...parseRobinhoodDashboardFilters(url.searchParams),
        tab: 'all'
      });
      sendJson(res, dashboard.ok ? 200 : dashboard.stale && dashboard.winners?.length ? 206 : 503, {
        ok: dashboard.ok,
        winners: dashboard.winners || [],
        filters: dashboard.filters,
        updatedAt: dashboard.updatedAt,
        stale: dashboard.stale
      });
      return true;
    }
    if (req.method !== 'POST') methodNotAllowed(['GET', 'POST']);
    const body = await readJsonBody(req);
    const address = validatedAddress(body.address, 'token');
    const result = await service.addManualWinner(address, validatedScanOptions(body));
    sendJson(res, result.accepted === true || (result.accepted === undefined && !result.duplicate) ? 202 : 200, result);
    return true;
  }

  const winnerRescanMatch = url.pathname.match(/^\/api\/robinhood\/winners\/([^/]+)\/rescan$/);
  if (winnerRescanMatch) {
    if (req.method !== 'POST') methodNotAllowed(['POST']);
    let decoded;
    try {
      decoded = decodeURIComponent(winnerRescanMatch[1]);
    } catch {
      throw new HttpError(400, 'Invalid encoded token address', 'INVALID_ADDRESS');
    }
    const body = req.headers['content-length'] !== undefined || req.headers['transfer-encoding']
      ? await readJsonBody(req)
      : {};
    const result = await service.rescanManualWinner(
      validatedAddress(decoded, 'token'),
      validatedScanOptions(body)
    );
    if (!result) throw new HttpError(404, 'Manual token has not been submitted', 'WINNER_NOT_FOUND');
    sendJson(res, result.accepted ? 202 : 200, result);
    return true;
  }

  if (url.pathname === '/api/robinhood/wallets/batch') {
    if (req.method !== 'POST') methodNotAllowed(['POST']);
    const body = await readJsonBody(req, { maxBytes: 8 * 1024 * 1024 });
    sendJson(res, 200, await service.batchUpdateWallets(validatedWalletBatchLines(body)));
    return true;
  }

  const walletMatch = url.pathname.match(/^\/api\/robinhood\/wallets?\/([^/]+)$/);
  if (walletMatch) {
    let decoded;
    try {
      decoded = decodeURIComponent(walletMatch[1]);
    } catch {
      throw new HttpError(400, 'Invalid encoded wallet address', 'INVALID_ADDRESS');
    }
    const address = validatedAddress(decoded, 'wallet');
    if (req.method === 'GET') {
      const result = await service.getWallet(address);
      if (!result) throw new HttpError(404, 'Wallet has not been analyzed', 'WALLET_NOT_FOUND');
      sendJson(res, 200, result);
      return true;
    }
    if (req.method === 'PATCH') {
      sendJson(res, 200, await service.updateWallet(address, validatedWalletPatch(await readJsonBody(req))));
      return true;
    }
    if (req.method === 'DELETE') {
      sendJson(res, 200, await service.deleteWallet(address));
      return true;
    }
    methodNotAllowed(['GET', 'PATCH', 'DELETE']);
    return true;
  }

  throw new HttpError(404, 'Robinhood API route not found', 'NOT_FOUND');
}

export function createRequestHandler({
  signalClient = client,
  tokenAnalysisService = analysisService,
  robinhoodService = null
} = {}) {
  return async (req, res) => {
    try {
      const url = new URL(req.url, `http://${req.headers.host || `${host}:${defaultPort}`}`);
      if (url.pathname.startsWith('/api/robinhood/')) {
        await handleRobinhoodRequest(req, res, url, robinhoodService || getDefaultRobinhoodService());
        return;
      }

      if (url.pathname === '/api/signals') {
        const result = await fetchSignalPayload(10, { client: signalClient, analysisService: tokenAnalysisService });
        sendJson(res, result.ok ? 200 : 206, result);
        return;
      }

      if (url.pathname.startsWith('/api/analysis/')) {
        const address = decodeURIComponent(url.pathname.slice('/api/analysis/'.length)).toLowerCase();
        if (!tokenAnalysisService.hasRow(address)) {
          await fetchSignalPayload(10, {
            prefetch: false,
            client: signalClient,
            analysisService: tokenAnalysisService
          });
        }
        const force = url.searchParams.get('force') === '1' || url.searchParams.get('refresh') === '1';
        const analysis = await tokenAnalysisService.getAnalysis(address, null, { force });
        sendJson(res, 200, sanitizeAnalysisForPublic(analysis));
        return;
      }

      await serveStatic(req, res);
    } catch (error) {
      if (error instanceof HttpError) {
        if (error.allow) res.setHeader('allow', error.allow);
        sendJson(res, error.statusCode, {
          ok: false,
          error: error.message,
          code: error.code,
          retryable: false,
          staleDataAvailable: false
        });
        return;
      }
      sendJson(res, 502, {
        ok: false,
        rows: [],
        updatedAt: new Date().toISOString(),
        error: error instanceof Error ? error.message : String(error)
      });
    }
  };
}

export function createServer(options = {}) {
  return http.createServer(createRequestHandler(options));
}

export const server = createServer();

async function listen(port) {
  await new Promise((resolve, reject) => {
    server.once('error', reject);
    server.listen(port, host, resolve);
  });
  return port;
}

async function main() {
  let port = defaultPort;
  for (;;) {
    try {
      await listen(port);
      break;
    } catch (error) {
      if (error?.code !== 'EADDRINUSE') {
        throw error;
      }
      port += 1;
    }
  }

  console.log(`Robinhood smart money radar: http://${host}:${port}/`);
  getDefaultRobinhoodService();
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  process.on('SIGINT', async () => {
    await client.close();
    defaultRobinhoodService?.close();
    defaultRobinhoodStore?.close();
    server.close(() => process.exit(0));
  });

  process.on('SIGTERM', async () => {
    await client.close();
    defaultRobinhoodService?.close();
    defaultRobinhoodStore?.close();
    server.close(() => process.exit(0));
  });

  main().catch((error) => {
    console.error(error);
    process.exit(1);
  });
}
