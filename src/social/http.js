import crypto from 'node:crypto';

class SocialHttpError extends Error {
  constructor(statusCode, message, code, { allow = '', retryable = null } = {}) {
    super(message);
    this.statusCode = statusCode;
    this.code = code;
    this.allow = allow;
    this.retryable = retryable;
  }
}

export const SOCIAL_SSE_MAX_CONNECTIONS = 128;
export const SOCIAL_SSE_MAX_CONNECTIONS_PER_CLIENT = 8;
const SOCIAL_SSE_MAX_PENDING_EVENTS = 256;
const SOCIAL_SSE_MAX_PENDING_BYTES = 2 * 1024 * 1024;

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

function suppliedBearerToken(req) {
  const authorization = String(req.headers.authorization || '');
  if (!/^Bearer\s+/i.test(authorization)) return '';
  return authorization.replace(/^Bearer\s+/i, '').trim();
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

function requireBridgeBearer(req, token) {
  if (!token) {
    throw new SocialHttpError(
      503,
      'The DeBot bridge has not been paired',
      'SOCIAL_UNPAIRED'
    );
  }
  if (!constantTimeEqual(suppliedBearerToken(req), token)) {
    throw new SocialHttpError(401, 'A valid bearer token is required', 'SOCIAL_UNAUTHORIZED');
  }
}

function eventPayload(change) {
  return `id: ${change.id}\nevent: ${change.type}\ndata: ${JSON.stringify(change)}\n\n`;
}

function heartbeatPayload(latestChangeId, streamEpoch) {
  return `event: heartbeat\ndata: ${JSON.stringify({
    serverTime: Date.now(),
    latestChangeId,
    streamEpoch
  })}\n\n`;
}

function positiveInteger(value, fallback) {
  const number = Number(value);
  return Number.isSafeInteger(number) && number > 0 ? number : fallback;
}

function loopbackAddress(value) {
  const normalized = String(value || '').trim().toLowerCase().replace(/^\[|\]$/g, '');
  return ['127.0.0.1', 'localhost', '::1', '::ffff:127.0.0.1'].includes(normalized);
}

function directLoopbackRequest(req) {
  if (!loopbackAddress(req.socket?.remoteAddress)) return false;
  for (const name of ['forwarded', 'x-forwarded-for', 'x-forwarded-host', 'x-forwarded-proto', 'x-real-ip']) {
    if (req.headers[name] !== undefined) return false;
  }
  try {
    return loopbackAddress(new URL(`http://${String(req.headers.host || '')}`).hostname);
  } catch {
    return false;
  }
}

function exactObjectKeys(value, expected) {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return false;
  const actual = Object.keys(value).sort();
  const wanted = [...expected].sort();
  return actual.length === wanted.length && actual.every((key, index) => key === wanted[index]);
}

function streamClientKey(req) {
  const remoteAddress = String(req.socket?.remoteAddress || '').trim();
  if (loopbackAddress(remoteAddress)) {
    const forwarded = Array.isArray(req.headers['x-forwarded-for'])
      ? req.headers['x-forwarded-for'].join(',')
      : String(req.headers['x-forwarded-for'] || '');
    const forwardedAddress = forwarded.split(',').at(-1)?.trim().slice(0, 200);
    if (forwardedAddress) return `forwarded:${forwardedAddress}`;
  }
  return `remote:${remoteAddress.slice(0, 200) || 'unknown'}`;
}

function createStreamWriter(res, { maxPendingEvents, maxPendingBytes, onFailure }) {
  const queue = [];
  const waiters = new Set();
  let queuedBytes = 0;
  let blocked = false;
  let closed = false;

  const settleWaiters = (ready) => {
    for (const resolve of waiters) resolve(ready);
    waiters.clear();
  };
  const close = () => {
    if (closed) return;
    closed = true;
    queue.length = 0;
    queuedBytes = 0;
    res.off('drain', onDrain);
    settleWaiters(false);
  };
  const fail = () => {
    if (closed) return;
    close();
    onFailure();
  };
  const writeDirect = (payload) => {
    if (closed || res.destroyed || res.writableEnded) return false;
    try {
      blocked = !res.write(payload);
      return true;
    } catch {
      fail();
      return false;
    }
  };
  const flush = () => {
    if (closed || res.destroyed || res.writableEnded) {
      close();
      return;
    }
    blocked = false;
    while (queue.length) {
      const entry = queue.shift();
      queuedBytes -= entry.bytes;
      if (!writeDirect(entry.payload) || blocked) break;
    }
    if (!blocked && !closed) settleWaiters(true);
  };
  function onDrain() {
    flush();
  }
  const waitUntilWritable = () => {
    if (closed || res.destroyed || res.writableEnded) return Promise.resolve(false);
    if (!blocked) return Promise.resolve(true);
    return new Promise((resolve) => waiters.add(resolve));
  };
  const enqueue = (payload) => {
    const bytes = Buffer.byteLength(payload);
    if (queue.length >= maxPendingEvents || queuedBytes + bytes > maxPendingBytes) {
      fail();
      return false;
    }
    queue.push({ payload, bytes });
    queuedBytes += bytes;
    return true;
  };

  res.on('drain', onDrain);
  return {
    close,
    async writeReplay(payload) {
      if (!(await waitUntilWritable())) return false;
      if (!writeDirect(payload)) return false;
      return blocked ? waitUntilWritable() : true;
    },
    writeLive(payload) {
      if (closed || res.destroyed || res.writableEnded) return false;
      if (blocked || queue.length) return enqueue(payload);
      return writeDirect(payload);
    },
    writeHeartbeat(payload) {
      // Heartbeats are disposable and must never enlarge a slow client's backlog.
      if (closed || blocked || queue.length || res.destroyed || res.writableEnded) return false;
      return writeDirect(payload);
    }
  };
}

function openStream(
  req,
  res,
  service,
  after,
  clientEpoch,
  streamEpoch,
  onClose,
  { maxPendingEvents, maxPendingBytes }
) {
  res.writeHead(200, {
    'content-type': 'text/event-stream; charset=utf-8',
    'cache-control': 'no-store',
    connection: 'keep-alive',
    'x-accel-buffering': 'no'
  });
  let closed = false;
  let heartbeat = null;
  let unsubscribe = () => {};
  let writer = null;
  let bufferedBytes = 0;
  const bufferedChanges = [];
  const cleanup = () => {
    if (closed) return;
    closed = true;
    if (heartbeat) clearInterval(heartbeat);
    unsubscribe();
    writer?.close();
    bufferedChanges.length = 0;
    bufferedBytes = 0;
    onClose();
  };
  const disconnect = () => {
    cleanup();
    if (!res.destroyed) res.destroy();
  };
  const close = () => {
    cleanup();
    if (res.destroyed || res.writableEnded) return;
    try {
      // Ending a valid SSE response lets EventSource reconnect after the process restarts.
      res.end('retry: 1000\n\n');
    } catch {
      res.destroy();
    }
  };
  const controller = {
    close,
    get closed() {
      return closed;
    }
  };
  writer = createStreamWriter(res, {
    maxPendingEvents,
    maxPendingBytes,
    onFailure: disconnect
  });
  req.on('close', cleanup);
  res.on('close', cleanup);
  res.on('error', cleanup);

  const serverLatestId = service.store.getLatestChangeId();
  const resetRequired = after > serverLatestId
    || (after > 0 && clientEpoch && clientEpoch !== streamEpoch);
  let latestId = resetRequired ? 0 : after;
  if (after === 0 || resetRequired) {
    const snapshot = { ...service.getSnapshot({ postLimit: 100 }), streamEpoch };
    latestId = Math.max(latestId, Number(snapshot.latestChangeId) || 0);
    const eventName = resetRequired ? 'reset' : 'snapshot';
    if (!writer.writeLive(`event: ${eventName}\ndata: ${JSON.stringify(snapshot)}\n\n`)) {
      return controller;
    }
  }
  let replaying = after > 0 && !resetRequired;
  const stopSubscription = service.subscribe((change) => {
    if (change.id <= latestId || closed || res.destroyed) return;
    const payload = eventPayload(change);
    if (replaying) {
      const bytes = Buffer.byteLength(payload);
      if (bufferedChanges.length >= maxPendingEvents || bufferedBytes + bytes > maxPendingBytes) {
        disconnect();
        return;
      }
      bufferedChanges.push({ change, payload, bytes });
      bufferedBytes += bytes;
      return;
    }
    latestId = change.id;
    writer.writeLive(payload);
  });
  unsubscribe = stopSubscription;
  if (closed) {
    unsubscribe();
    return controller;
  }
  const replayChanges = async () => {
    while (!closed && !res.destroyed) {
      const changes = service.listChanges({ after: latestId, limit: 1_000 });
      if (!changes.length) break;
      for (const change of changes) {
        if (change.id <= latestId) continue;
        latestId = change.id;
        if (!(await writer.writeReplay(eventPayload(change)))) return;
      }
      if (changes.length < 1_000) break;
    }
    while (!closed && !res.destroyed && bufferedChanges.length) {
      const pending = bufferedChanges.splice(0)
        .sort((left, right) => left.change.id - right.change.id);
      bufferedBytes = 0;
      for (const { change, payload } of pending) {
        if (change.id <= latestId) continue;
        latestId = change.id;
        if (!(await writer.writeReplay(payload))) return;
      }
    }
    replaying = false;
    if (!closed && !res.destroyed) {
      writer.writeHeartbeat(heartbeatPayload(service.store.getLatestChangeId(), streamEpoch));
    }
  };
  if (replaying) void replayChanges().catch(disconnect);
  else writer.writeHeartbeat(heartbeatPayload(service.store.getLatestChangeId(), streamEpoch));
  if (closed) return controller;
  heartbeat = setInterval(() => {
    if (!closed && !res.destroyed && !replaying) {
      writer.writeHeartbeat(heartbeatPayload(service.store.getLatestChangeId(), streamEpoch));
    }
  }, 15_000);
  heartbeat.unref?.();
  return controller;
}

export function createSocialApiHandler({
  service,
  bridgeToken = '',
  maxStreams = SOCIAL_SSE_MAX_CONNECTIONS,
  maxStreamsPerClient = SOCIAL_SSE_MAX_CONNECTIONS_PER_CLIENT,
  maxPendingEvents = SOCIAL_SSE_MAX_PENDING_EVENTS,
  maxPendingBytes = SOCIAL_SSE_MAX_PENDING_BYTES
}) {
  if (!service) throw new TypeError('Social service is required');
  const token = String(bridgeToken || '').trim();
  const streamEpoch = crypto.randomUUID();
  const streams = new Set();
  const streamCountsByClient = new Map();
  const streamLimit = positiveInteger(maxStreams, SOCIAL_SSE_MAX_CONNECTIONS);
  const perClientStreamLimit = positiveInteger(
    maxStreamsPerClient,
    SOCIAL_SSE_MAX_CONNECTIONS_PER_CLIENT
  );
  const pendingEventLimit = positiveInteger(maxPendingEvents, SOCIAL_SSE_MAX_PENDING_EVENTS);
  const pendingByteLimit = positiveInteger(maxPendingBytes, SOCIAL_SSE_MAX_PENDING_BYTES);
  async function handleSocialApi(req, res, url) {
    const internalDeBotRequest = url.pathname === '/internal/debot/request';
    if (!internalDeBotRequest && url.pathname !== '/api/social' && !url.pathname.startsWith('/api/social/')) {
      return false;
    }
    try {
      if (internalDeBotRequest) {
        method(req, ['POST']);
        if (!directLoopbackRequest(req)) {
          throw new SocialHttpError(404, 'Route not found', 'NOT_FOUND');
        }
        const body = await readJson(req, 64 * 1024);
        if (!exactObjectKeys(body, ['payload', 'type'])) {
          throw new SocialHttpError(400, 'Invalid internal DeBot request', 'INVALID_DEBOT_REQUEST');
        }
        const controller = new AbortController();
        const abort = () => {
          if (!controller.signal.aborted) controller.abort();
        };
        const abortOnClose = () => {
          if (!res.writableEnded) abort();
        };
        req.once('aborted', abort);
        res.once('close', abortOnClose);
        try {
          const result = await service.requestDeBot(body.type, body.payload, {
            signal: controller.signal
          });
          if (!controller.signal.aborted) sendJson(res, 200, { ok: true, result });
        } catch (error) {
          if (controller.signal.aborted) return true;
          throw error;
        } finally {
          req.off('aborted', abort);
          res.off('close', abortOnClose);
        }
        return true;
      }

      if (url.pathname === '/api/social' || url.pathname === '/api/social/snapshot') {
        method(req, ['GET']);
        const postLimit = integerParam(url.searchParams, 'postLimit', 50, 1, 100);
        sendJson(res, 200, { ...service.getSnapshot({ postLimit }), streamEpoch });
        return true;
      }

      if (url.pathname === '/api/social/status') {
        method(req, ['GET']);
        sendJson(res, 200, {
          ok: true,
          bridge: service.getConnection(),
          fastX: service.getFastXStatus?.() || { enabled: false },
          counts: service.store.getCounts(),
          latestChangeId: service.store.getLatestChangeId(),
          streamEpoch,
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
        const { account: accountValue, accounts: ignoredAccounts, ...accountOptions } = body;
        const wrappedAccount = Object.hasOwn(body, 'account')
          ? typeof accountValue === 'object' && accountValue !== null && !Array.isArray(accountValue)
            ? { ...accountOptions, ...accountValue }
            : { ...accountOptions, handle: accountValue }
          : null;
        const accounts = Array.isArray(body.accounts)
          ? body.accounts
          : wrappedAccount
            ? [wrappedAccount]
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
        method(req, ['PATCH', 'DELETE']);
        requireDevice(req, token);
        const result = req.method === 'PATCH'
          ? service.updateWatchAccountPreferences(
            Number(watchlistMatch[1]),
            await readJson(req, 64 * 1024)
          )
          : service.removeWatchAccount(Number(watchlistMatch[1]));
        if (!result) throw new SocialHttpError(404, 'Watchlist account was not found', 'WATCHLIST_NOT_FOUND');
        sendJson(res, req.method === 'PATCH' ? 200 : 202, result);
        return true;
      }

      if (url.pathname === '/api/social/stream') {
        method(req, ['GET']);
        const headerAfter = Number(req.headers['last-event-id'] || 0);
        const after = url.searchParams.has('after')
          ? integerParam(url.searchParams, 'after', 0, 0, Number.MAX_SAFE_INTEGER)
          : Number.isSafeInteger(headerAfter) && headerAfter > 0 ? headerAfter : 0;
        const clientEpoch = String(url.searchParams.get('epoch') || '').slice(0, 100);
        const clientKey = streamClientKey(req);
        if ((streamCountsByClient.get(clientKey) || 0) >= perClientStreamLimit) {
          res.setHeader('retry-after', '1');
          throw new SocialHttpError(
            503,
            'Too many active social streams for this client; reconnect shortly',
            'SOCIAL_STREAM_CLIENT_CAPACITY',
            { retryable: true }
          );
        }
        if (streams.size >= streamLimit) {
          res.setHeader('retry-after', '1');
          throw new SocialHttpError(
            503,
            'Too many active social streams; reconnect shortly',
            'SOCIAL_STREAM_CAPACITY',
            { retryable: true }
          );
        }
        let stream = null;
        const releaseStream = () => {
          if (!stream || !streams.delete(stream)) return;
          const remaining = (streamCountsByClient.get(clientKey) || 1) - 1;
          if (remaining > 0) streamCountsByClient.set(clientKey, remaining);
          else streamCountsByClient.delete(clientKey);
        };
        stream = openStream(
          req,
          res,
          service,
          after,
          clientEpoch,
          streamEpoch,
          releaseStream,
          { maxPendingEvents: pendingEventLimit, maxPendingBytes: pendingByteLimit }
        );
        if (!stream.closed) {
          streams.add(stream);
          streamCountsByClient.set(clientKey, (streamCountsByClient.get(clientKey) || 0) + 1);
        }
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
        sendJson(res, 200, service.reconcileWatchlist(body.accounts, {
          snapshotSessionId: body.snapshotSessionId,
          snapshotSessionStartedAt: body.snapshotSessionStartedAt,
          snapshotRevision: body.snapshotRevision
        }));
        return true;
      }

      if (url.pathname === '/api/social/bridge/commands') {
        method(req, ['GET']);
        requireDevice(req, token);
        const limit = integerParam(url.searchParams, 'limit', 50, 1, 200);
        sendJson(res, 200, service.claimCommands({ limit }));
        return true;
      }

      if (url.pathname === '/api/social/bridge/debot/jobs') {
        method(req, ['GET']);
        requireBridgeBearer(req, token);
        const limit = integerParam(url.searchParams, 'limit', 4, 1, 32);
        sendJson(res, 200, service.claimDeBotJobs({ limit }));
        return true;
      }

      const debotResultMatch = url.pathname.match(/^\/api\/social\/bridge\/debot\/jobs\/(\d+)\/result$/);
      if (debotResultMatch) {
        method(req, ['POST']);
        requireBridgeBearer(req, token);
        const body = await readJson(req, 512 * 1024);
        sendJson(res, 200, service.submitDeBotResult(Number(debotResultMatch[1]), body));
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
      const serviceStatus = Number(error?.statusCode);
      const knownServiceError = Number.isSafeInteger(serviceStatus) && serviceStatus >= 400 && serviceStatus <= 599;
      const known = error instanceof SocialHttpError || knownServiceError;
      const invalidInput = error instanceof TypeError || error instanceof RangeError;
      const statusCode = known ? Number(error.statusCode) : invalidInput ? 400 : 500;
      if (known && error.allow) res.setHeader('allow', error.allow);
      sendJson(res, statusCode, {
        ok: false,
        error: error instanceof Error ? error.message : String(error),
        code: known ? error.code : invalidInput ? 'INVALID_SOCIAL_DATA' : 'SOCIAL_INTERNAL_ERROR',
        retryable: error?.retryable ?? (statusCode >= 500 && statusCode !== 503)
      });
      return true;
    }
  }
  handleSocialApi.closeStreams = () => {
    for (const stream of [...streams]) stream.close();
    streamCountsByClient.clear();
  };
  return handleSocialApi;
}
