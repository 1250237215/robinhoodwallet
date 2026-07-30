import test from 'node:test';
import assert from 'node:assert/strict';
import { EventEmitter } from 'node:events';

import { createSocialApiHandler } from '../src/social/http.js';

const token = '0x1111111111111111111111111111111111111111';

class InternalRequest extends EventEmitter {
  constructor({
    body = { type: 'debot.token_holders.v1', payload: { chain: 'bsc', token, pageSize: 100 } },
    headers = {},
    remoteAddress = '127.0.0.1'
  } = {}) {
    super();
    this.method = 'POST';
    this.headers = { host: '127.0.0.1:18118', ...headers };
    this.socket = { remoteAddress };
    this.body = body;
  }

  async *[Symbol.asyncIterator]() {
    yield Buffer.from(JSON.stringify(this.body));
  }
}

class InternalResponse extends EventEmitter {
  constructor() {
    super();
    this.statusCode = null;
    this.headers = {};
    this.body = '';
    this.writableEnded = false;
  }

  setHeader(name, value) {
    this.headers[String(name).toLowerCase()] = String(value);
  }

  writeHead(statusCode, headers = {}) {
    this.statusCode = statusCode;
    for (const [name, value] of Object.entries(headers)) this.setHeader(name, value);
  }

  end(chunk = '') {
    this.body += String(chunk);
    this.writableEnded = true;
  }

  json() {
    return JSON.parse(this.body);
  }
}

const internalUrl = new URL('http://127.0.0.1:18118/internal/debot/request');

test('internal DeBot endpoint accepts only a direct loopback request and returns its result', async () => {
  const calls = [];
  const handler = createSocialApiHandler({
    service: {
      async requestDeBot(type, payload, options) {
        calls.push({ type, payload, signal: options.signal });
        return { schema: 'debot.token_holders.raw.v1', data: { chain: 'bsc', token, list: [] } };
      }
    }
  });
  const req = new InternalRequest();
  const res = new InternalResponse();

  assert.equal(await handler(req, res, internalUrl), true);
  assert.equal(res.statusCode, 200);
  assert.equal(calls.length, 1);
  assert.equal(calls[0].type, 'debot.token_holders.v1');
  assert.deepEqual(calls[0].payload, { chain: 'bsc', token, pageSize: 100 });
  assert.equal(calls[0].signal.aborted, false);
  assert.deepEqual(res.json(), {
    ok: true,
    result: { schema: 'debot.token_holders.raw.v1', data: { chain: 'bsc', token, list: [] } }
  });
});

test('internal DeBot endpoint hides itself from forwarded, wrong-Host, and non-loopback requests', async () => {
  let calls = 0;
  const handler = createSocialApiHandler({
    service: {
      async requestDeBot() {
        calls += 1;
        return {};
      }
    }
  });
  const requests = [
    new InternalRequest({ headers: { forwarded: 'for=203.0.113.1' } }),
    new InternalRequest({ headers: { 'x-forwarded-for': '203.0.113.1' } }),
    new InternalRequest({ headers: { host: 'radar.example.com' } }),
    new InternalRequest({ remoteAddress: '203.0.113.1' })
  ];
  for (const req of requests) {
    const res = new InternalResponse();
    assert.equal(await handler(req, res, internalUrl), true);
    assert.equal(res.statusCode, 404);
    assert.equal(res.json().code, 'NOT_FOUND');
  }
  assert.equal(calls, 0);
});

test('internal DeBot endpoint aborts its waiter and writes no response after the client disconnects', async () => {
  let signal;
  let started;
  const requestStarted = new Promise((resolve) => { started = resolve; });
  const handler = createSocialApiHandler({
    service: {
      requestDeBot(_type, _payload, options) {
        signal = options.signal;
        started();
        return new Promise((resolve, reject) => {
          options.signal.addEventListener('abort', () => {
            const error = new Error('request aborted');
            error.name = 'AbortError';
            reject(error);
          }, { once: true });
        });
      }
    }
  });
  const req = new InternalRequest();
  const res = new InternalResponse();
  const pending = handler(req, res, internalUrl);
  await requestStarted;

  res.emit('close');

  assert.equal(await pending, true);
  assert.equal(signal.aborted, true);
  assert.equal(res.statusCode, null);
  assert.equal(res.body, '');
});
