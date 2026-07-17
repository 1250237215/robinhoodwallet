import crypto from 'node:crypto';

class SocialHttpError extends Error {
  constructor(statusCode, message, code, { allow = '' } = {}) {
    super(message);
    this.statusCode = statusCode;
    this.code = code;
    this.allow = allow;
  }
}

function sendJson(res, statusCode, body) {
  res.writeHead(statusCode, {
    'content-type': 'application/json; charset=utf-8',
    'cache-control': 'no-store'
  });
  res.end(JSON.stringify(body));
}

async function readJson(req, maxBytes = 4 * 1024 * 1024) {
  const chunks = [];
  let bytes = 0;
  for await (const chunk of req) {
    bytes += chunk.length;
    if (bytes > maxBytes) throw new SocialHttpError(413, 'Request body is too large', 'BODY_TOO_LARGE');
    chunks.push(chunk);
  }
  if (!chunks.length) return {};
  try {
    const body = JSON.parse(Buffer.concat(chunks).toString('utf8'));
    if (!body || typeof body !== 'object' || Array.isArray(body)) throw new Error('object required');
    return body;
  } catch {
    throw new SocialHttpError(400, 'Request body must be a JSON object', 'INVALID_JSON');
  }
}

function integerParam(params, name, fallback, minimum, maximum) {
  if (!params.has(name)) return fallback;
  const value = Number(params.get(name));
  if (!Number.isSafeInteger(value) || value < minimum || value > maximum) {
    throw new SocialHttpError(400, `${name} is outside the allowed range`, 'INVALID_FILTER');
  }
  return value;
}

function booleanParam(params, name, fallback) {
  if (!params.has(name)) return fallback;
  const value = params.get(name);
  if (value === 'true' || value === '1') return true;
  if (value === 'false' || value === '0') return false;
  throw new SocialHttpError(400, `${name} must be true or false`, 'INVALID_FILTER');
}

function method(req, allowed) {
  if (allowed.includes(req.method)) return;
  throw new SocialHttpError(405, 'Method not allowed', 'METHOD_NOT_ALLOWED', { allow: allowed.join(', ') });
}

function suppliedToken(req) {
  const authorization = String(req.headers.authorization || '');
  if (/^Bearer\s+/i.test(authorization)) return authorization.replace(/^Bearer\s+/i, '').trim();
  return String(
    req.headers['x-social-bridge-token'] || req.headers['x-social-device-token'] || ''
  ).trim();
}

function constantTimeEqual(left, right) {
  const leftBuffer = Buffer.from(String(left));
  const rightBuffer = Buffer.from(String(right));
  if (leftBuffer.length !== rightBuffer.length) return false;
  return crypto.timingSafeEqual(leftBuffer, rightBuffer);
}

function requireDevice(req, token) {
  if (!token) {
    throw new SocialHttpError(
      503,
      'The DeBot bridge has not been paired; social monitoring is read-only',
      'SOCIAL_UNPAIRED'
    );
  }
  if (!constantTimeEqual(suppliedToken(req), token)) {
    throw new SocialHttpError(401, 'A valid social device token is required', 'SOCIAL_UNAUTHORIZED');
  }
}

function writeEvent(res, change) {
  res.write(`id: ${change.id}\nevent: ${change.type}\ndata: ${JSON.stringify(change)}\n\n`);
}

function openStream(req, res, service, after) {
  res.writeHead(200, {
    'content-type': 'text/event-stream; charset=utf-8',
    'cache-control': 'no-store',
    connection: 'keep-alive',
    'x-accel-buffering': 'no'
  });
  res.write(`event: snapshot\ndata: ${JSON.stringify(service.getSnapshot({ postLimit: 50 }))}\n\n`);
  let latestId = after;
  const unsubscribe = service.subscribe((change) => {
    if (change.id <= latestId || res.destroyed) return;
    latestId = change.id;
    writeEvent(res, change);
  });
  for (const change of service.listChanges({ after, limit: 1_000 })) {
    if (change.id <= latestId) continue;
    latestId = change.id;
    writeEvent(res, change);
  }
  const heartbeat = setInterval(() => {
    if (!res.destroyed) res.write(`: keepalive ${Date.now()}\n\n`);
  }, 15_000);
  heartbeat.unref?.();
  let closed = false;
  const close = () => {
    if (closed) return;
    closed = true;
    clearInterval(heartbeat);
    unsubscribe();
  };
  req.on('close', close);
  res.on('close', close);
  res.on('error', close);
}

export function createSocialApiHandler({ service, bridgeToken = '' }) {
  if (!service) throw new TypeError('Social service is required');
  const token = String(bridgeToken || '').trim();
  return async function handleSocialApi(req, res, url) {
    if (url.pathname !== '/api/social' && !url.pathname.startsWith('/api/social/')) return false;
    try {
      if (url.pathname === '/api/social' || url.pathname === '/api/social/snapshot') {
        method(req, ['GET']);
        const postLimit = integerParam(url.searchParams, 'postLimit', 50, 1, 100);
        sendJson(res, 200, service.getSnapshot({ postLimit }));
        return true;
      }

      if (url.pathname === '/api/social/status') {
        method(req, ['GET']);
        sendJson(res, 200, {
          ok: true,
          bridge: service.getConnection(),
          counts: service.store.getCounts(),
          serverTime: Date.now()
        });
        return true;
      }

      if (url.pathname === '/api/social/posts') {
        method(req, ['GET']);
        const limit = integerParam(url.searchParams, 'limit', 50, 1, 500);
        const before = url.searchParams.has('before')
          ? integerParam(url.searchParams, 'before', null, 0, Number.MAX_SAFE_INTEGER)
          : null;
        const afterUpdatedAt = url.searchParams.has('afterUpdatedAt')
          ? integerParam(url.searchParams, 'afterUpdatedAt', null, 0, Number.MAX_SAFE_INTEGER)
          : null;
        const sources = [
          ...url.searchParams.getAll('source'),
          ...(url.searchParams.get('sources') || '').split(',')
        ].map((value) => value.trim()).filter(Boolean);
        const posts = service.listPosts({
          limit,
          before,
          afterUpdatedAt,
          sources,
          feedSource: url.searchParams.get('feedSource') || url.searchParams.get('feed_source') || null,
          query: String(url.searchParams.get('q') || '').slice(0, 200),
          includeDeleted: booleanParam(url.searchParams, 'includeDeleted', true)
        });
        sendJson(res, 200, { ok: true, posts, count: posts.length });
        return true;
      }

      if (url.pathname === '/api/social/watchlist') {
        if (req.method === 'GET') {
          const entries = service.listWatchlist({
            includeRemoved: booleanParam(url.searchParams, 'includeRemoved', false),
            platform: url.searchParams.get('platform') || null
          });
          sendJson(res, 200, {
            ok: true,
            bridge: service.getConnection(),
            entries,
            counts: service.store.getCounts()
          });
          return true;
        }
        method(req, ['POST']);
        requireDevice(req, token);
        const body = await readJson(req);
        const accounts = Array.isArray(body.accounts)
          ? body.accounts
          : Object.hasOwn(body, 'account')
            ? [body.account]
            : [body];
        if (!accounts.length || accounts.length > 500) {
          throw new SocialHttpError(400, 'accounts must contain 1 to 500 entries', 'INVALID_WATCHLIST');
        }
        sendJson(res, 202, service.addWatchAccounts(accounts));
        return true;
      }

      if (url.pathname === '/api/social/watchlist/batch') {
        method(req, ['POST']);
        requireDevice(req, token);
        const body = await readJson(req);
        if (!Array.isArray(body.accounts) || !body.accounts.length || body.accounts.length > 500) {
          throw new SocialHttpError(400, 'accounts must contain 1 to 500 entries', 'INVALID_WATCHLIST');
        }
        sendJson(res, 202, service.addWatchAccounts(body.accounts));
        return true;
      }

      const watchlistMatch = url.pathname.match(/^\/api\/social\/watchlist\/(\d+)$/);
      if (watchlistMatch) {
        method(req, ['DELETE']);
        requireDevice(req, token);
        const result = service.removeWatchAccount(Number(watchlistMatch[1]));
        if (!result) throw new SocialHttpError(404, 'Watchlist account was not found', 'WATCHLIST_NOT_FOUND');
        sendJson(res, 202, result);
        return true;
      }

      if (url.pathname === '/api/social/stream') {
        method(req, ['GET']);
        const headerAfter = Number(req.headers['last-event-id'] || 0);
        const after = url.searchParams.has('after')
          ? integerParam(url.searchParams, 'after', 0, 0, Number.MAX_SAFE_INTEGER)
          : Number.isSafeInteger(headerAfter) && headerAfter > 0 ? headerAfter : 0;
        openStream(req, res, service, after);
        return true;
      }

      if (url.pathname === '/api/social/bridge/heartbeat') {
        method(req, ['POST']);
        requireDevice(req, token);
        sendJson(res, 200, service.heartbeat(await readJson(req, 64 * 1024)));
        return true;
      }

      if (url.pathname === '/api/social/bridge/posts') {
        method(req, ['POST']);
        requireDevice(req, token);
        const body = await readJson(req);
        const posts = Array.isArray(body.posts) ? body.posts : Object.hasOwn(body, 'post') ? [body.post] : [];
        if (!posts.length || posts.length > 200) {
          throw new SocialHttpError(400, 'posts must contain 1 to 200 entries', 'INVALID_POST_BATCH');
        }
        sendJson(res, 200, service.ingestPosts(posts));
        return true;
      }

      const deletePostMatch = url.pathname.match(/^\/api\/social\/bridge\/posts\/([^/]+)\/([^/]+)\/delete$/);
      if (deletePostMatch) {
        method(req, ['POST']);
        requireDevice(req, token);
        const body = await readJson(req, 64 * 1024);
        sendJson(res, 200, service.deletePost(
          decodeURIComponent(deletePostMatch[1]),
          decodeURIComponent(deletePostMatch[2]),
          body.deletedAt
        ));
        return true;
      }

      if (url.pathname === '/api/social/bridge/watchlist/snapshot') {
        method(req, ['POST']);
        requireDevice(req, token);
        const body = await readJson(req);
        if (body.complete !== true || !Array.isArray(body.accounts) || body.accounts.length > 5_000) {
          throw new SocialHttpError(
            400,
            'A complete watchlist snapshot with at most 5000 accounts is required',
            'INVALID_WATCHLIST_SNAPSHOT'
          );
        }
        sendJson(res, 200, service.reconcileWatchlist(body.accounts));
        return true;
      }

      if (url.pathname === '/api/social/bridge/commands') {
        method(req, ['GET']);
        requireDevice(req, token);
        const limit = integerParam(url.searchParams, 'limit', 50, 1, 200);
        sendJson(res, 200, service.claimCommands({ limit }));
        return true;
      }

      const commandAckMatch = url.pathname.match(/^\/api\/social\/bridge\/commands\/(\d+)\/ack$/);
      if (commandAckMatch) {
        method(req, ['POST']);
        requireDevice(req, token);
        const body = await readJson(req, 64 * 1024);
        const result = service.acknowledgeCommand(Number(commandAckMatch[1]), body);
        if (!result) throw new SocialHttpError(404, 'Bridge command was not found', 'COMMAND_NOT_FOUND');
        sendJson(res, 200, result);
        return true;
      }

      throw new SocialHttpError(404, 'Social API route not found', 'NOT_FOUND');
    } catch (error) {
      const known = error instanceof SocialHttpError;
      const invalidInput = error instanceof TypeError || error instanceof RangeError;
      const statusCode = known ? error.statusCode : invalidInput ? 400 : 500;
      if (known && error.allow) res.setHeader('allow', error.allow);
      sendJson(res, statusCode, {
        ok: false,
        error: error instanceof Error ? error.message : String(error),
        code: known ? error.code : invalidInput ? 'INVALID_SOCIAL_DATA' : 'SOCIAL_INTERNAL_ERROR',
        retryable: statusCode >= 500 && statusCode !== 503
      });
      return true;
    }
  };
}
