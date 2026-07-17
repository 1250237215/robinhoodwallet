import http from 'node:http';
import fs from 'node:fs/promises';
import path from 'node:path';

import { createRobinhoodConfig } from './robinhood/config.js';
import { BARK_SOUNDS, createRobinhoodBarkNotifier } from './robinhood/bark.js';
import { RobinhoodDebotClient } from './robinhood/debotClient.js';
import { RobinhoodHolderClient } from './robinhood/holderClient.js';
import { scanTokenHolders } from './robinhood/holderScanner.js';
import { RobinhoodDexScreenerClient, RobinhoodMarketDataClient } from './robinhood/marketClient.js';
import { createRobinhoodWalletMonitor } from './robinhood/monitor.js';
import { validateWalletMonitorRulesPatch } from './robinhood/monitorRules.js';
import { RobinhoodRpcClient } from './robinhood/rpcClient.js';
import { createRobinhoodService, MAX_WALLET_BATCH_LINES } from './robinhood/service.js';
import { createRobinhoodStore } from './robinhood/store.js';
import { WALLET_MONITOR_TIERS } from './robinhood/tiering.js';
import { createSocialConfig } from './social/config.js';
import { createSocialApiHandler } from './social/http.js';
import { createSocialService } from './social/service.js';

const ADDRESS_PATTERN = /^0x[0-9a-f]{40}$/;
const TABS = new Set(['all_round', 'realized', 'unrealized', 'single_hit', 'all']);
const WALLET_STATUSES = new Set(['active', 'excluded', 'watch', 'all']);
const WALLET_CLASSIFICATIONS = new Set(['all_round', 'realized', 'unrealized', 'single_hit', 'all']);
const WALLET_REVIEW_STATES = new Set(['pending', 'confirmed', 'excluded', 'all']);
const MONITOR_SOUNDS = new Set(['alarm', 'bell', 'electronic', 'glass']);
const contentTypes = {
  '.html': 'text/html; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.js': 'text/javascript; charset=utf-8',
  '.json': 'application/json; charset=utf-8',
  '.svg': 'image/svg+xml',
  '.png': 'image/png',
  '.webp': 'image/webp'
};

class HttpError extends Error {
  constructor(statusCode, message, code, details = {}) {
    super(message);
    this.statusCode = statusCode;
    this.code = code;
    Object.assign(this, details);
  }
}

function sendJson(res, statusCode, body) {
  res.writeHead(statusCode, {
    'content-type': 'application/json; charset=utf-8',
    'cache-control': 'no-store'
  });
  res.end(JSON.stringify(body));
}

function methodNotAllowed(methods) {
  throw new HttpError(405, 'Method not allowed', 'METHOD_NOT_ALLOWED', { allow: methods.join(', ') });
}

function boundedNumber(params, name, { minimum, maximum, integer = false } = {}) {
  if (!params.has(name)) return undefined;
  const raw = params.get(name);
  const value = Number(raw);
  if (raw === null || raw.trim() === '' || !Number.isFinite(value) || value < minimum || value > maximum) {
    throw new HttpError(400, `${name} is outside the allowed range`, 'INVALID_FILTER');
  }
  if (integer && !Number.isInteger(value)) {
    throw new HttpError(400, `${name} must be an integer`, 'INVALID_FILTER');
  }
  return value;
}

export function parseDashboardFilters(params) {
  const tab = params.get('tab') || undefined;
  if (tab && !TABS.has(tab)) throw new HttpError(400, 'tab is not supported', 'INVALID_FILTER');
  const strategy = params.get('strategy') || undefined;
  if (strategy && !['smart', 'multiple'].includes(strategy)) {
    throw new HttpError(400, 'strategy is not supported', 'INVALID_FILTER');
  }
  const minEntryUsd = boundedNumber(params, 'minEntryUsd', { minimum: 0, maximum: 1_000_000_000 });
  return {
    multiple: boundedNumber(params, 'multiple', { minimum: 1, maximum: 1000 }),
    minLiquidityUsd: boundedNumber(params, 'minLiquidityUsd', { minimum: 0, maximum: 1_000_000_000 }),
    minWallets: boundedNumber(params, 'minWallets', { minimum: 1, maximum: 1_000_000, integer: true }),
    tab,
    ...(minEntryUsd === undefined ? {} : { minEntryUsd }),
    ...(strategy ? { strategy } : {})
  };
}

export function parseWalletFilters(params) {
  const filters = parseDashboardFilters(params);
  const status = params.get('status') || undefined;
  if (status && !WALLET_STATUSES.has(status)) {
    throw new HttpError(400, 'status is not supported', 'INVALID_FILTER');
  }
  const classification = params.get('classification') || undefined;
  if (classification && !WALLET_CLASSIFICATIONS.has(classification)) {
    throw new HttpError(400, 'classification is not supported', 'INVALID_FILTER');
  }
  const review = params.get('review') || undefined;
  if (review && !WALLET_REVIEW_STATES.has(review)) {
    throw new HttpError(400, 'review is not supported', 'INVALID_FILTER');
  }
  const monitorTier = params.get('monitorTier') || undefined;
  if (monitorTier && !WALLET_MONITOR_TIERS.has(monitorTier)) {
    throw new HttpError(400, 'monitorTier is not supported', 'INVALID_FILTER');
  }
  const search = (params.get('search') || params.get('q') || '').trim() || undefined;
  if (search && search.length > 200) {
    throw new HttpError(400, 'search is too long', 'INVALID_FILTER');
  }
  const tags = [...params.getAll('tag'), ...(params.get('tags') || '').split(',')]
    .map((tag) => tag.trim())
    .filter(Boolean);
  if (tags.length > 32 || tags.some((tag) => tag.length > 64)) {
    throw new HttpError(400, 'tag filter is too large', 'INVALID_FILTER');
  }
  return {
    ...filters,
    ...(search ? { search } : {}),
    ...(tags.length ? { tags: [...new Set(tags)] } : {}),
    ...(status ? { status } : {}),
    ...(classification ? { classification } : {}),
    ...(review ? { review } : {}),
    ...(monitorTier ? { monitorTier } : {})
  };
}

async function readJson(req, maxBytes = 32 * 1024) {
  const chunks = [];
  let bytes = 0;
  for await (const chunk of req) {
    bytes += chunk.length;
    if (bytes > maxBytes) throw new HttpError(413, 'Request body is too large', 'BODY_TOO_LARGE');
    chunks.push(chunk);
  }
  if (!chunks.length) return {};
  try {
    const body = JSON.parse(Buffer.concat(chunks).toString('utf8'));
    if (!body || typeof body !== 'object' || Array.isArray(body)) throw new Error('object required');
    return body;
  } catch {
    throw new HttpError(400, 'Request body must be a JSON object', 'INVALID_JSON');
  }
}

function scanOptions(body = {}) {
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

function walletPatch(body) {
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
    if (!WALLET_STATUSES.has(body.status) || body.status === 'all') {
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
    if (value !== null && value !== '' && (!WALLET_CLASSIFICATIONS.has(value) || value === 'all')) {
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

function walletBatchLines(body) {
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

function monitorSettingsPatch(body) {
  const patch = {};
  if (Object.hasOwn(body, 'enabled')) {
    if (typeof body.enabled !== 'boolean') {
      throw new HttpError(400, 'enabled must be a boolean', 'INVALID_MONITOR_SETTINGS');
    }
    patch.enabled = body.enabled;
  }
  if (Object.hasOwn(body, 'threshold')) {
    if (!Number.isInteger(body.threshold) || body.threshold < 1 || body.threshold > 1_000) {
      throw new HttpError(400, 'threshold must be an integer from 1 to 1000', 'INVALID_MONITOR_SETTINGS');
    }
    patch.threshold = body.threshold;
  }
  if (Object.hasOwn(body, 'windowSeconds')) {
    if (!Number.isInteger(body.windowSeconds) || body.windowSeconds < 5 || body.windowSeconds > 3_600) {
      throw new HttpError(400, 'windowSeconds must be an integer from 5 to 3600', 'INVALID_MONITOR_SETTINGS');
    }
    patch.windowSeconds = body.windowSeconds;
  }
  if (Object.hasOwn(body, 'sound')) {
    if (!MONITOR_SOUNDS.has(body.sound)) {
      throw new HttpError(400, 'sound is not supported', 'INVALID_MONITOR_SETTINGS');
    }
    patch.sound = body.sound;
  }
  if (Object.hasOwn(body, 'volume')) {
    if (!Number.isInteger(body.volume) || body.volume < 0 || body.volume > 100) {
      throw new HttpError(400, 'volume must be an integer from 0 to 100', 'INVALID_MONITOR_SETTINGS');
    }
    patch.volume = body.volume;
  }
  if (Object.hasOwn(body, 'barkSound')) {
    if (!BARK_SOUNDS.has(body.barkSound)) {
      throw new HttpError(400, 'barkSound is not supported', 'INVALID_MONITOR_SETTINGS');
    }
    patch.barkSound = body.barkSound;
  }
  if (Object.hasOwn(body, 'barkVolume')) {
    if (!Number.isInteger(body.barkVolume) || body.barkVolume < 0 || body.barkVolume > 10) {
      throw new HttpError(400, 'barkVolume must be an integer from 0 to 10', 'INVALID_MONITOR_SETTINGS');
    }
    patch.barkVolume = body.barkVolume;
  }
  if (!Object.keys(patch).length) {
    throw new HttpError(400, 'No supported monitor settings were provided', 'INVALID_MONITOR_SETTINGS');
  }
  return patch;
}

function requireMonitor(monitor) {
  if (!monitor) throw new HttpError(503, 'Wallet monitoring is not configured', 'MONITOR_UNAVAILABLE');
  return monitor;
}

function openMonitorStream(req, res, monitor) {
  res.writeHead(200, {
    'content-type': 'text/event-stream; charset=utf-8',
    'cache-control': 'no-store, no-transform',
    connection: 'keep-alive',
    'x-accel-buffering': 'no'
  });
  res.write(`event: snapshot\ndata: ${JSON.stringify(monitor.getSnapshot())}\n\n`);
  const unsubscribe = monitor.subscribe(({ type, data }) => {
    if (type === 'close') {
      cleanup();
      res.end();
      return;
    }
    if (!res.destroyed) res.write(`event: ${type}\ndata: ${JSON.stringify(data)}\n\n`);
  });
  const heartbeat = setInterval(() => {
    if (!res.destroyed) res.write(': keepalive\n\n');
  }, 15_000);
  heartbeat.unref?.();
  let cleaned = false;
  function cleanup() {
    if (cleaned) return;
    cleaned = true;
    clearInterval(heartbeat);
    unsubscribe();
  }
  req.on('close', cleanup);
  res.on('close', cleanup);
  res.on('error', cleanup);
}

const DEFAULT_ADDRESS_CODEC = Object.freeze({
  chainId: 'robinhood',
  label: 'Robinhood',
  normalize(value) {
    return typeof value === 'string' ? value.toLowerCase() : '';
  },
  validate(value) {
    return ADDRESS_PATTERN.test(value);
  }
});

function address(value, kind, codec = DEFAULT_ADDRESS_CODEC) {
  const normalized = codec.normalize(value);
  if (!codec.validate(normalized, kind)) {
    throw new HttpError(400, `Invalid ${codec.label || 'chain'} ${kind} address`, 'INVALID_ADDRESS');
  }
  return normalized;
}

function dashboardStatus(dashboard, rows = 0) {
  if (dashboard.ok) return 200;
  if (dashboard.stale && rows > 0) return 206;
  return 503;
}

async function handleApi(req, res, url, service, monitor, addressCodec = DEFAULT_ADDRESS_CODEC) {
  if (!url.pathname.startsWith('/api/robinhood/')) return false;
  const chain = String(addressCodec.chainId || service?.chainId || 'robinhood');

  if (url.pathname === '/api/robinhood/monitor') {
    if (req.method !== 'GET') methodNotAllowed(['GET']);
    const limit = boundedNumber(url.searchParams, 'limit', { minimum: 1, maximum: 500, integer: true }) ?? 100;
    const activeMonitor = requireMonitor(monitor);
    sendJson(res, 200, {
      ...activeMonitor.getSnapshot({ eventLimit: limit }),
      barkTargets: activeMonitor.listBarkTargets()
    });
    return true;
  }

  if (url.pathname === '/api/robinhood/monitor/settings') {
    if (req.method !== 'PATCH') methodNotAllowed(['PATCH']);
    const result = requireMonitor(monitor).updateSettings(monitorSettingsPatch(await readJson(req)));
    sendJson(res, 200, result);
    return true;
  }

  if (url.pathname === '/api/robinhood/monitor/bark') {
    const activeMonitor = requireMonitor(monitor);
    if (req.method === 'GET') {
      sendJson(res, 200, { ok: true, barkTargets: activeMonitor.listBarkTargets() });
      return true;
    }
    if (req.method === 'POST') {
      let target;
      try {
        target = activeMonitor.createBarkTarget(await readJson(req));
      } catch (error) {
        throw new HttpError(400, error instanceof Error ? error.message : String(error), 'INVALID_BARK_TARGET');
      }
      sendJson(res, 201, { ok: true, target, barkTargets: activeMonitor.listBarkTargets() });
      return true;
    }
    methodNotAllowed(['GET', 'POST']);
  }

  const barkTargetMatch = url.pathname.match(/^\/api\/robinhood\/monitor\/bark\/(\d+)(?:\/(test))?$/);
  if (barkTargetMatch) {
    const activeMonitor = requireMonitor(monitor);
    const id = Number(barkTargetMatch[1]);
    if (barkTargetMatch[2] === 'test') {
      if (req.method !== 'POST') methodNotAllowed(['POST']);
      let target;
      try {
        target = await activeMonitor.testBarkTarget(id);
      } catch (error) {
        throw new HttpError(502, error instanceof Error ? error.message : String(error), 'BARK_TEST_FAILED');
      }
      if (!target) throw new HttpError(404, 'Bark target was not found', 'BARK_TARGET_NOT_FOUND');
      sendJson(res, 200, { ok: true, target, barkTargets: activeMonitor.listBarkTargets() });
      return true;
    }
    if (req.method === 'PATCH') {
      const body = await readJson(req);
      let target;
      try {
        target = activeMonitor.updateBarkTarget(id, body);
      } catch (error) {
        throw new HttpError(400, error instanceof Error ? error.message : String(error), 'INVALID_BARK_TARGET');
      }
      if (!target) throw new HttpError(404, 'Bark target was not found', 'BARK_TARGET_NOT_FOUND');
      sendJson(res, 200, { ok: true, target, barkTargets: activeMonitor.listBarkTargets() });
      return true;
    }
    if (req.method === 'DELETE') {
      if (!activeMonitor.deleteBarkTarget(id)) {
        throw new HttpError(404, 'Bark target was not found', 'BARK_TARGET_NOT_FOUND');
      }
      sendJson(res, 200, { ok: true, deleted: true, barkTargets: activeMonitor.listBarkTargets() });
      return true;
    }
    methodNotAllowed(['PATCH', 'DELETE']);
  }

  if (url.pathname === '/api/robinhood/monitor/events') {
    if (req.method !== 'GET') methodNotAllowed(['GET']);
    const after = boundedNumber(url.searchParams, 'after', {
      minimum: 0,
      maximum: Number.MAX_SAFE_INTEGER,
      integer: true
    }) ?? 0;
    const limit = boundedNumber(url.searchParams, 'limit', { minimum: 1, maximum: 500, integer: true }) ?? 100;
    const activeMonitor = requireMonitor(monitor);
    const events = activeMonitor.getEvents({ after, limit });
    const snapshot = activeMonitor.getSnapshot({ eventLimit: 0 });
    sendJson(res, 200, {
      ok: snapshot.ok,
      status: snapshot.status,
      settings: snapshot.settings,
      health: snapshot.health,
      clusters: snapshot.clusters,
      alertedTokenAddresses: snapshot.alertedTokenAddresses,
      barkTargets: activeMonitor.listBarkTargets(),
      events,
      after,
      latestId: events.reduce((latest, event) => Math.max(latest, Number(event.id) || 0), after)
    });
    return true;
  }

  if (url.pathname === '/api/robinhood/monitor/stream') {
    if (req.method !== 'GET') methodNotAllowed(['GET']);
    openMonitorStream(req, res, requireMonitor(monitor));
    return true;
  }

  if (url.pathname === '/api/robinhood/dashboard') {
    if (req.method !== 'GET') methodNotAllowed(['GET']);
    const result = service.getDashboard(parseWalletFilters(url.searchParams));
    sendJson(res, dashboardStatus(result, (result.wallets?.length || 0) + (result.winners?.length || 0)), result);
    return true;
  }

  if (url.pathname === '/api/robinhood/overview') {
    if (req.method !== 'GET') methodNotAllowed(['GET']);
    const result = service.getDashboard(parseDashboardFilters(url.searchParams));
    const winnerCount = result.winners?.length || 0;
    sendJson(res, dashboardStatus(result, result.winners?.length || 0), {
      ok: result.ok,
      chain: result.chain || chain,
      status: result.status,
      mode: result.mode,
      discoveryEnabled: result.discoveryEnabled,
      counts: { wallets: result.wallets?.length || 0, winners: winnerCount, candidates: winnerCount },
      walletCount: result.wallets?.length || 0,
      winnerCount,
      updatedAt: result.updatedAt,
      stale: result.stale,
      partial: result.partial,
      warnings: result.warnings
    });
    return true;
  }

  if (url.pathname === '/api/robinhood/wallets') {
    if (req.method !== 'GET') methodNotAllowed(['GET']);
    const result = service.getDashboard(parseWalletFilters(url.searchParams));
    sendJson(res, dashboardStatus(result, result.wallets?.length || 0), {
      ok: result.ok,
      chain: result.chain || chain,
      wallets: result.wallets || [],
      filters: result.filters,
      updatedAt: result.updatedAt,
      stale: result.stale
    });
    return true;
  }

  if (url.pathname === '/api/robinhood/winners') {
    if (req.method === 'GET') {
      const result = service.getDashboard({ ...parseDashboardFilters(url.searchParams), tab: 'all' });
      sendJson(res, dashboardStatus(result, result.winners?.length || 0), {
        ok: result.ok,
        chain: result.chain || chain,
        winners: result.winners || [],
        filters: result.filters,
        updatedAt: result.updatedAt,
        stale: result.stale
      });
      return true;
    }
    if (req.method !== 'POST') methodNotAllowed(['GET', 'POST']);
    const body = await readJson(req);
    const result = service.addManualWinner(address(body.address, 'token', addressCodec), scanOptions(body));
    sendJson(res, result.duplicate ? 200 : 202, result);
    return true;
  }

  const winnerRescanMatch = url.pathname.match(/^\/api\/robinhood\/winners\/([^/]+)\/rescan$/);
  if (winnerRescanMatch) {
    if (req.method !== 'POST') methodNotAllowed(['POST']);
    let value;
    try {
      value = decodeURIComponent(winnerRescanMatch[1]);
    } catch {
      throw new HttpError(400, 'Invalid encoded token address', 'INVALID_ADDRESS');
    }
    const body = req.headers['content-length'] || req.headers['transfer-encoding']
      ? await readJson(req)
      : {};
    const result = service.rescanManualWinner(address(value, 'token', addressCodec), scanOptions(body));
    if (!result) throw new HttpError(404, 'Manual token has not been submitted', 'WINNER_NOT_FOUND');
    sendJson(res, result.accepted ? 202 : 200, result);
    return true;
  }

  if (url.pathname === '/api/robinhood/jobs') {
    if (req.method !== 'GET') methodNotAllowed(['GET']);
    const result = service.getDashboard({ tab: 'all' });
    sendJson(res, 200, {
      ok: true,
      chain: result.chain || chain,
      jobs: result.jobs || [],
      updatedAt: result.updatedAt
    });
    return true;
  }

  if (url.pathname === '/api/robinhood/jobs/scan') {
    if (req.method !== 'POST') methodNotAllowed(['POST']);
    const body = req.headers['content-length'] || req.headers['transfer-encoding']
      ? await readJson(req)
      : {};
    sendJson(res, 202, service.triggerScan({ force: true, ...scanOptions(body) }));
    return true;
  }

  if (url.pathname === '/api/robinhood/refresh') {
    if (req.method !== 'POST') methodNotAllowed(['POST']);
    if (req.headers['content-length'] || req.headers['transfer-encoding']) await readJson(req);
    const result = service.triggerRefresh();
    sendJson(res, result.accepted === false ? 200 : 202, result);
    return true;
  }

  if (url.pathname === '/api/robinhood/wallets/batch') {
    if (req.method !== 'POST') methodNotAllowed(['POST']);
    const body = await readJson(req, 8 * 1024 * 1024);
    sendJson(res, 200, await service.batchUpdateWallets(walletBatchLines(body)));
    return true;
  }

  const walletMatch = url.pathname.match(/^\/api\/robinhood\/wallets?\/([^/]+)$/);
  if (walletMatch) {
    let value;
    try {
      value = decodeURIComponent(walletMatch[1]);
    } catch {
      throw new HttpError(400, 'Invalid encoded wallet address', 'INVALID_ADDRESS');
    }
    const normalized = address(value, 'wallet', addressCodec);
    if (req.method === 'GET') {
      const result = service.getWallet(normalized);
      if (!result) throw new HttpError(404, 'Wallet has not been analyzed', 'WALLET_NOT_FOUND');
      sendJson(res, 200, result);
      return true;
    }
    if (req.method === 'PATCH') {
      const result = service.updateWallet(normalized, walletPatch(await readJson(req)));
      sendJson(res, 200, result);
      return true;
    }
    if (req.method === 'DELETE') {
      sendJson(res, 200, service.deleteWallet(normalized));
      return true;
    }
    methodNotAllowed(['GET', 'PATCH', 'DELETE']);
    return true;
  }

  throw new HttpError(404, 'Robinhood API route not found', 'NOT_FOUND');
}

async function serveStatic(req, res, url, publicDir) {
  const pathname = decodeURIComponent(url.pathname === '/' ? '/index.html' : url.pathname);
  const resolved = path.resolve(publicDir, `.${pathname}`);
  if (!resolved.startsWith(`${publicDir}${path.sep}`) && resolved !== publicDir) {
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

export function createRobinhoodStandaloneServer({
  service,
  monitor = null,
  socialService = null,
  socialBridgeToken = '',
  publicDir = path.resolve('public'),
  apiPrefix = '/api/robinhood',
  addressCodec = DEFAULT_ADDRESS_CODEC,
  extraApiHandler = null,
  servePublic = true
}) {
  const normalizedApiPrefix = `/${String(apiPrefix || '/api/robinhood').replace(/^\/+|\/+$/g, '')}`;
  const socialApiHandler = socialService
    ? createSocialApiHandler({ service: socialService, bridgeToken: socialBridgeToken })
    : null;
  const server = http.createServer(async (req, res) => {
    try {
      const url = new URL(req.url, `http://${req.headers.host || '127.0.0.1'}`);
      if (typeof extraApiHandler === 'function' && await extraApiHandler(req, res, url)) return;
      if (socialApiHandler && await socialApiHandler(req, res, url)) return;
      if (url.pathname === normalizedApiPrefix || url.pathname.startsWith(`${normalizedApiPrefix}/`)) {
        const routedUrl = new URL(url);
        routedUrl.pathname = `/api/robinhood${url.pathname.slice(normalizedApiPrefix.length)}`;
        if (await handleApi(req, res, routedUrl, service, monitor, addressCodec)) return;
      }
      if (!servePublic) {
        sendJson(res, 404, {
          ok: false,
          error: 'API route not found',
          code: 'NOT_FOUND',
          retryable: false,
          staleDataAvailable: false
        });
        return;
      }
      await serveStatic(req, res, url, path.resolve(publicDir));
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
        error: error instanceof Error ? error.message : String(error),
        code: 'UPSTREAM_ERROR',
        retryable: true,
        staleDataAvailable: false
      });
    }
  });
  const closeSocialStreams = () => socialApiHandler?.closeStreams?.();
  const closeServer = server.close.bind(server);
  server.closeSocialStreams = closeSocialStreams;
  server.close = (...args) => {
    closeSocialStreams();
    return closeServer(...args);
  };
  if (monitor?.close) server.once('close', () => monitor.close());
  if (socialService?.close) server.once('close', () => socialService.close());
  return server;
}

export async function startRobinhoodStandaloneServer(
  env = process.env,
  {
    monitorRpcClient = null,
    debotClient = null,
    dexScreenerClient = null,
    marketDataClient = null,
    fetchImpl = globalThis.fetch
  } = {}
) {
  const config = createRobinhoodConfig(env);
  const store = createRobinhoodStore(config.dataFile);
  const socialConfig = createSocialConfig(env, { fallbackDirectory: path.dirname(config.dataFile) });
  const socialService = createSocialService({ config: socialConfig });
  const activeDebotClient = debotClient || new RobinhoodDebotClient({
    timeoutMs: config.requestTimeoutMs,
    fetchImpl
  });
  const activeDexScreenerClient = dexScreenerClient || new RobinhoodDexScreenerClient({
    timeoutMs: config.marketRequestTimeoutMs,
    fetchImpl
  });
  const activeMarketDataClient = marketDataClient || new RobinhoodMarketDataClient({
    primary: activeDexScreenerClient,
    fallback: activeDebotClient,
    fallbackTimeoutMs: config.marketDebotFallbackTimeoutMs,
    fallbackConcurrency: config.marketDebotFallbackConcurrency,
    fallbackBatchBudgetMs: config.marketDebotFallbackBatchBudgetMs
  });
  const rpcClient = monitorRpcClient || new RobinhoodRpcClient({
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
    holderClient: new RobinhoodHolderClient({
      baseUrl: config.blockscoutApiUrl,
      timeoutMs: config.requestTimeoutMs
    }),
    scanToken: scanTokenHolders,
    scanConcurrency: Number(env.ROBINHOOD_SCAN_CONCURRENCY || 1)
  });
  const barkNotifier = createRobinhoodBarkNotifier({
    store,
    timeoutMs: Math.min(15_000, config.requestTimeoutMs)
  });
  const monitor = createRobinhoodWalletMonitor({
    store,
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
    marketDataCacheSeconds: config.monitorMarketDataCacheSeconds,
    marketDataBatchSize: config.monitorMarketDataBatchSize,
    noxaLaunchFactory: config.noxaLaunchFactory,
    barkNotifier,
    debotClient: activeMarketDataClient
  });
  const server = createRobinhoodStandaloneServer({
    service,
    monitor,
    socialService,
    socialBridgeToken: socialConfig.bridgeToken,
    publicDir: env.ROBINHOOD_PUBLIC_DIR || path.resolve('public')
  });
  const host = env.HOST || '127.0.0.1';
  const port = Number(env.PORT || 18118);
  await new Promise((resolve, reject) => {
    server.once('error', reject);
    server.listen(port, host, resolve);
  });
  service.start();
  monitor.start();
  socialService.start();
  return {
    server,
    service,
    monitor,
    store,
    debotClient: activeDebotClient,
    dexScreenerClient: activeDexScreenerClient,
    marketDataClient: activeMarketDataClient,
    socialService,
    host,
    port
  };
}
