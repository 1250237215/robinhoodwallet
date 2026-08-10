import { createReadStream } from 'node:fs';
import { open, realpath, stat } from 'node:fs/promises';
import { createServer } from 'node:http';
import { dirname, extname, resolve, sep } from 'node:path';
import { fileURLToPath } from 'node:url';

import { createLarkClient } from './lark-client.js';
import { FeishuCaWatch } from './ca-watch.js';
import { PEOPLE } from './config.js';
import { PeopleMonitor } from './monitor.js';

const MODULE_DIR = dirname(fileURLToPath(import.meta.url));
const PUBLIC_DIR = resolve(MODULE_DIR, '../public');
const PORT = Number(process.env.PORT || 4186);
const HOST = process.env.HOST || '127.0.0.1';
const POLL_MS = Number(process.env.POLL_MS || 2_000);
const MIME_TYPES = new Map([
  ['.html', 'text/html; charset=utf-8'],
  ['.css', 'text/css; charset=utf-8'],
  ['.js', 'text/javascript; charset=utf-8'],
  ['.json', 'application/json; charset=utf-8']
]);

function headers(extra = {}) {
  return {
    'cache-control': 'no-store',
    'content-security-policy': "default-src 'self'; connect-src 'self'; img-src 'self' data:; style-src 'self'; script-src 'self'; base-uri 'none'; frame-ancestors 'none'",
    'referrer-policy': 'no-referrer',
    'x-content-type-options': 'nosniff',
    'x-frame-options': 'DENY',
    ...extra
  };
}

function sendJson(response, status, body) {
  const payload = JSON.stringify(body);
  response.writeHead(status, headers({
    'content-type': 'application/json; charset=utf-8',
    'content-length': Buffer.byteLength(payload)
  }));
  response.end(payload);
}

async function readJson(request, maximum = 32 * 1024) {
  const chunks = [];
  let size = 0;
  for await (const chunk of request) {
    size += chunk.length;
    if (size > maximum) throw Object.assign(new Error('request_too_large'), { status: 413 });
    chunks.push(chunk);
  }
  try {
    return JSON.parse(Buffer.concat(chunks).toString('utf8') || '{}');
  } catch {
    throw Object.assign(new Error('invalid_json'), { status: 400 });
  }
}

function writeSse(response, event, body) {
  response.write(`event: ${event}\ndata: ${JSON.stringify(body)}\n\n`);
}

async function imageMimeType(file) {
  const handle = await open(file, 'r');
  try {
    const bytes = Buffer.alloc(12);
    const { bytesRead } = await handle.read(bytes, 0, bytes.length, 0);
    const header = bytes.subarray(0, bytesRead);
    if (header.subarray(0, 8).equals(Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]))) return 'image/png';
    if (header[0] === 0xff && header[1] === 0xd8 && header[2] === 0xff) return 'image/jpeg';
    if (header.subarray(0, 6).toString('ascii') === 'GIF87a' || header.subarray(0, 6).toString('ascii') === 'GIF89a') return 'image/gif';
    if (header.subarray(0, 4).toString('ascii') === 'RIFF' && header.subarray(8, 12).toString('ascii') === 'WEBP') return 'image/webp';
    return 'application/octet-stream';
  } finally {
    await handle.close();
  }
}

async function serveStatic(request, response, pathname) {
  const root = await realpath(PUBLIC_DIR);
  const relative = pathname === '/' ? 'index.html' : decodeURIComponent(pathname).replace(/^\/+/, '');
  const candidate = resolve(root, relative);
  if (candidate !== root && !candidate.startsWith(`${root}${sep}`)) throw Object.assign(new Error('forbidden'), { status: 403 });
  const file = await realpath(candidate).catch(() => null);
  if (!file || (file !== root && !file.startsWith(`${root}${sep}`))) throw Object.assign(new Error('not found'), { status: 404 });
  const info = await stat(file);
  if (!info.isFile()) throw Object.assign(new Error('not found'), { status: 404 });
  response.writeHead(200, headers({
    'content-type': MIME_TYPES.get(extname(file)) || 'application/octet-stream',
    'content-length': info.size
  }));
  if (request.method === 'HEAD') response.end();
  else createReadStream(file).pipe(response);
}

export function createMonitorServer(monitor, { caWatch = null, mediaClient = null, mediaCacheDirectory = '' } = {}) {
  const clients = new Set();
  const mediaDownloads = new Map();
  const broadcast = (snapshot) => {
    for (const response of [...clients]) {
      if (response.destroyed || response.writableEnded) clients.delete(response);
      else writeSse(response, 'snapshot', snapshot);
    }
  };
  monitor.on('snapshot', broadcast);

  const server = createServer(async (request, response) => {
    try {
      const url = new URL(request.url || '/', 'http://localhost');
      if (url.pathname === '/api/snapshot') {
        if (request.method !== 'GET') return sendJson(response, 405, { ok: false, error: 'method_not_allowed' });
        return sendJson(response, 200, monitor.snapshot());
      }
      if (url.pathname === '/api/refresh') {
        if (request.method !== 'POST') return sendJson(response, 405, { ok: false, error: 'method_not_allowed' });
        const snapshot = await monitor.refresh();
        return sendJson(response, 200, snapshot);
      }
      if (url.pathname === '/api/stream') {
        if (request.method !== 'GET') return sendJson(response, 405, { ok: false, error: 'method_not_allowed' });
        response.writeHead(200, headers({
          'content-type': 'text/event-stream; charset=utf-8',
          'cache-control': 'no-cache, no-transform',
          connection: 'keep-alive',
          'x-accel-buffering': 'no'
        }));
        response.write(': connected\n\n');
        clients.add(response);
        writeSse(response, 'snapshot', monitor.snapshot());
        request.on('close', () => clients.delete(response));
        return;
      }
      const mediaMatch = url.pathname.match(/^\/api\/media\/(om_[A-Za-z0-9_-]+)\/(img_[A-Za-z0-9_-]+)$/);
      if (mediaMatch) {
        if (!['GET', 'HEAD'].includes(request.method || 'GET')) return sendJson(response, 405, { ok: false, error: 'method_not_allowed' });
        const [, messageId, resourceKey] = mediaMatch;
        const resource = monitor.findMediaResource?.(messageId, resourceKey);
        if (!resource) return sendJson(response, 404, { ok: false, error: 'media_not_found' });
        if (!mediaClient?.downloadMessageResource || !mediaCacheDirectory) return sendJson(response, 503, { ok: false, error: 'media_unavailable' });
        const cacheKey = `${messageId}:${resourceKey}`;
        let pending = mediaDownloads.get(cacheKey);
        if (!pending) {
          pending = mediaClient.downloadMessageResource({ messageId, resourceKey, outputDirectory: mediaCacheDirectory });
          mediaDownloads.set(cacheKey, pending);
        }
        let file;
        try {
          file = await pending;
        } catch (error) {
          mediaDownloads.delete(cacheKey);
          throw error;
        }
        const info = await stat(file);
        response.writeHead(200, headers({
          'cache-control': 'private, max-age=86400',
          'content-type': await imageMimeType(file),
          'content-length': info.size
        }));
        if (request.method === 'HEAD') response.end();
        else createReadStream(file).pipe(response);
        return;
      }
      if (url.pathname === '/api/ca-watch') {
        if (!caWatch) return sendJson(response, 503, { ok: false, error: 'ca_watch_unavailable' });
        if (request.method === 'GET') return sendJson(response, 200, caWatch.snapshot());
        if (request.method === 'PUT') {
          try {
            return sendJson(response, 200, caWatch.update(await readJson(request)));
          } catch (error) {
            return sendJson(response, error.status || 400, { ok: false, error: error.message });
          }
        }
        return sendJson(response, 405, { ok: false, error: 'method_not_allowed' });
      }
      if (url.pathname === '/favicon.ico') {
        response.writeHead(204, headers());
        response.end();
        return;
      }
      if (!['GET', 'HEAD'].includes(request.method || 'GET')) return sendJson(response, 405, { ok: false, error: 'method_not_allowed' });
      await serveStatic(request, response, url.pathname);
    } catch (error) {
      sendJson(response, error.status || 500, { ok: false, error: error.status ? error.message : 'internal_server_error' });
    }
  });

  server.on('close', () => {
    monitor.off('snapshot', broadcast);
    monitor.stop();
    for (const response of clients) response.end();
    clients.clear();
  });
  return server;
}

if (process.argv[1] === fileURLToPath(import.meta.url)) {
  const runtimeDirectory = process.env.FEISHU_RUNTIME_DIR || '/var/lib/robinhood-radar/feishu';
  const client = createLarkClient();
  const monitor = new PeopleMonitor({ client, pollMs: POLL_MS });
  const caWatch = new FeishuCaWatch({
    people: PEOPLE,
    dataFile: resolve(runtimeDirectory, 'ca-watch.json'),
    internalUrl: process.env.FEISHU_BARK_INTERNAL_URL || 'http://127.0.0.1:18118/internal/feishu-bark',
    internalToken: process.env.FEISHU_BARK_INTERNAL_TOKEN || '',
    rpcProfiles: [
      { chain: 'robinhood', rpcUrl: process.env.FEISHU_CA_ROBINHOOD_RPC_URL || 'https://rpc.mainnet.chain.robinhood.com' },
      { chain: 'bsc', rpcUrl: process.env.FEISHU_CA_BSC_RPC_URL || 'https://bsc-mainnet.public.blastapi.io' },
      { chain: 'base', rpcUrl: process.env.FEISHU_CA_BASE_RPC_URL || 'https://mainnet.base.org' }
    ]
  });
  monitor.on('snapshot', (snapshot) => caWatch.observe(snapshot));
  const server = createMonitorServer(monitor, {
    caWatch,
    mediaClient: client,
    mediaCacheDirectory: resolve(runtimeDirectory, 'media')
  });
  server.listen(PORT, HOST, () => {
    console.log(`Feishu people monitor: http://${HOST}:${PORT}`);
    monitor.start().catch((error) => console.error(error));
  });
}
