import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

import { createRobinhoodStandaloneServer } from '../src/robinhoodServer.js';
import { createSocialService } from '../src/social/service.js';

async function withSocialServer(t, { token = '' } = {}) {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'robinhood-social-api-'));
  const socialService = createSocialService({
    config: {
      dataFile: path.join(directory, 'social.sqlite'),
      bridgeToken: token,
      retentionDays: 7,
      bridgeOfflineMs: 15_000,
      cleanupIntervalMs: 3_600_000,
      commandLeaseMs: 30_000
    }
  });
  const server = createRobinhoodStandaloneServer({
    service: {},
    socialService,
    socialBridgeToken: token,
    servePublic: false
  });
  await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
  const baseUrl = `http://127.0.0.1:${server.address().port}`;
  t.after(async () => {
    if (server.listening) await new Promise((resolve) => server.close(resolve));
    socialService.close();
    fs.rmSync(directory, { recursive: true, force: true });
  });
  return { baseUrl, server, socialService };
}

function auth(token) {
  return { authorization: `Bearer ${token}`, 'content-type': 'application/json' };
}

test('unpaired social API stays publicly readable but rejects every write', async (t) => {
  const { baseUrl } = await withSocialServer(t);
  const snapshotResponse = await fetch(`${baseUrl}/api/social`);
  const snapshot = await snapshotResponse.json();
  assert.equal(snapshotResponse.status, 200);
  assert.equal(snapshot.bridge.state, 'unpaired');
  assert.equal(snapshot.bridge.readOnly, true);

  const mutation = await fetch(`${baseUrl}/api/social/watchlist`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ account: '@alice' })
  });
  assert.equal(mutation.status, 503);
  assert.equal((await mutation.json()).code, 'SOCIAL_UNPAIRED');
});

test('paired bridge authenticates heartbeat, ingestion, watchlist commands and acknowledgements', async (t) => {
  const token = 'test-device-token';
  const { baseUrl } = await withSocialServer(t, { token });
  const unauthorized = await fetch(`${baseUrl}/api/social/bridge/heartbeat`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: '{}'
  });
  assert.equal(unauthorized.status, 401);

  const heartbeat = await fetch(`${baseUrl}/api/social/bridge/heartbeat`, {
    method: 'POST',
    headers: auth(token),
    body: JSON.stringify({ bridgeId: 'chrome-main', version: '1.0.0', capabilities: ['posts', 'watchlist'] })
  });
  assert.equal(heartbeat.status, 200);
  assert.equal((await heartbeat.json()).bridge.state, 'online');

  const failedHeartbeat = await fetch(`${baseUrl}/api/social/bridge/heartbeat`, {
    method: 'POST',
    headers: auth(token),
    body: JSON.stringify({ bridgeId: 'chrome-main', version: '1.0.0', capabilities: ['error'] })
  });
  const failedBridge = (await failedHeartbeat.json()).bridge;
  assert.equal(failedHeartbeat.status, 200);
  assert.equal(failedBridge.state, 'error');
  assert.equal(failedBridge.online, false);
  assert.equal((await (await fetch(`${baseUrl}/api/social/status`)).json()).bridge.state, 'error');

  const recoveredHeartbeat = await fetch(`${baseUrl}/api/social/bridge/heartbeat`, {
    method: 'POST',
    headers: auth(token),
    body: JSON.stringify({ bridgeId: 'chrome-main', version: '1.0.0', capabilities: ['posts', 'watchlist'] })
  });
  assert.equal((await recoveredHeartbeat.json()).bridge.state, 'online');

  const ingested = await fetch(`${baseUrl}/api/social/bridge/posts`, {
    method: 'POST',
    headers: auth(token),
    body: JSON.stringify({ posts: [{ source: 'x', id: '100', authorHandle: 'alice', text: 'hello' }] })
  });
  assert.equal(ingested.status, 200);
  assert.equal((await ingested.json()).summary.created, 1);
  const posts = await (await fetch(`${baseUrl}/api/social/posts?source=twitter`)).json();
  assert.equal(posts.posts[0].externalId, '100');

  const watchlist = await fetch(`${baseUrl}/api/social/watchlist/batch`, {
    method: 'POST',
    headers: auth(token),
    body: JSON.stringify({ accounts: ['alice', { platform: 'binance', handle: 'bob' }] })
  });
  assert.equal(watchlist.status, 202);
  assert.equal((await watchlist.json()).commands.length, 2);
  const commands = await (await fetch(`${baseUrl}/api/social/bridge/commands`, {
    headers: { authorization: `Bearer ${token}` }
  })).json();
  assert.equal(commands.commands.length, 2);

  const acknowledgement = await fetch(
    `${baseUrl}/api/social/bridge/commands/${commands.commands[0].id}/ack`,
    {
      method: 'POST',
      headers: auth(token),
      body: JSON.stringify({ success: true, remoteId: 'remote-1' })
    }
  );
  assert.equal(acknowledgement.status, 200);
  assert.equal((await acknowledgement.json()).command.status, 'completed');
});

test('social posts API persists merged feed membership and filters featured and my feeds', async (t) => {
  const token = 'feed-device-token';
  const { baseUrl } = await withSocialServer(t, { token });
  const ingest = async (post) => fetch(`${baseUrl}/api/social/bridge/posts`, {
    method: 'POST',
    headers: auth(token),
    body: JSON.stringify({ posts: [post] })
  });

  assert.equal((await ingest({
    source: 'twitter',
    id: 'shared',
    text: 'shared post',
    feedSource: 'all',
    sourceUpdatedAt: '2026-07-17T12:00:00Z'
  })).status, 200);
  assert.equal((await ingest({
    source: 'twitter',
    id: 'shared',
    feed_source: 'featured',
    sourceUpdatedAt: '2026-07-17T11:59:00Z'
  })).status, 200);
  assert.equal((await ingest({
    source: 'twitter',
    id: 'mine-only',
    text: 'mine',
    feedSources: ['my']
  })).status, 200);

  const featured = await (await fetch(`${baseUrl}/api/social/posts?feedSource=featured`)).json();
  assert.deepEqual(featured.posts.map((post) => post.externalId), ['shared']);
  assert.deepEqual(featured.posts[0].feedSources, ['all', 'featured']);

  const mine = await (await fetch(`${baseUrl}/api/social/posts?feed_source=mine`)).json();
  assert.deepEqual(mine.posts.map((post) => post.externalId), ['mine-only']);

  const all = await (await fetch(`${baseUrl}/api/social/posts?feedSource=all`)).json();
  assert.equal(all.posts.length, 2);
  const invalid = await fetch(`${baseUrl}/api/social/posts?feedSource=unknown`);
  assert.equal(invalid.status, 400);
  assert.equal((await invalid.json()).code, 'INVALID_SOCIAL_DATA');
});

test('DeBot analysis bridge uses bearer-only claims, inflight dedupe and short result caching', async (t) => {
  const token = 'analysis-device-token';
  const tokenAddress = '0x1111111111111111111111111111111111111111';
  const { baseUrl, socialService } = await withSocialServer(t, { token });

  await assert.rejects(
    socialService.requestDeBot('debot.token_detail.v1', {
      chain: 'robinhood',
      token: tokenAddress
    }),
    { code: 'DEBOT_BRIDGE_UNAVAILABLE' }
  );
  await fetch(`${baseUrl}/api/social/bridge/heartbeat`, {
    method: 'POST',
    headers: auth(token),
    body: JSON.stringify({ capabilities: ['posts', 'watchlist'] })
  });
  await assert.rejects(
    socialService.requestDeBot('debot.token_detail.v1', {
      chain: 'robinhood',
      token: tokenAddress
    }),
    { code: 'DEBOT_BRIDGE_UNAVAILABLE' }
  );
  await fetch(`${baseUrl}/api/social/bridge/heartbeat`, {
    method: 'POST',
    headers: auth(token),
    body: JSON.stringify({
      bridgeId: 'chrome-analysis',
      version: '1.1.0',
      capabilities: ['posts', 'debot-analysis-v1']
    })
  });

  assert.throws(() => socialService.requestDeBot('debot.token_detail.v1', {
    chain: 'base',
    token: tokenAddress
  }), /Robinhood chain/);
  assert.throws(() => socialService.requestDeBot('debot.token_detail.v1', {
    chain: 'robinhood',
    token: '0x1234'
  }), /valid non-zero EVM address/);

  const first = socialService.requestDeBot('debot.token_detail.v1', {
    chain: 'robinhood',
    token: tokenAddress
  });
  const duplicate = socialService.requestDeBot('debot.token_detail.v1', {
    token: tokenAddress.toUpperCase().replace('0X', '0x'),
    chain: 'ROBINHOOD'
  });
  const headerFallback = await fetch(`${baseUrl}/api/social/bridge/debot/jobs`, {
    headers: { 'x-social-bridge-token': token }
  });
  assert.equal(headerFallback.status, 401);
  const publicEnqueue = await fetch(`${baseUrl}/api/social/bridge/debot/jobs`, {
    method: 'POST',
    headers: auth(token),
    body: JSON.stringify({ type: 'debot.token_detail.v1', payload: { chain: 'robinhood', token: tokenAddress } })
  });
  assert.equal(publicEnqueue.status, 405);

  const claimedResponse = await fetch(`${baseUrl}/api/social/bridge/debot/jobs?limit=4`, {
    headers: { authorization: `Bearer ${token}` }
  });
  const claimed = await claimedResponse.json();
  assert.equal(claimedResponse.status, 200);
  assert.equal(claimed.jobs.length, 1);
  assert.equal(claimed.jobs[0].type, 'debot.token_detail.v1');
  assert.deepEqual(claimed.jobs[0].payload, { chain: 'robinhood', token: tokenAddress });
  assert.match(claimed.jobs[0].claimToken, /^[A-Za-z0-9_-]{32}$/);

  const rejectedClaim = await fetch(
    `${baseUrl}/api/social/bridge/debot/jobs/${claimed.jobs[0].id}/result`,
    {
      method: 'POST',
      headers: auth(token),
      body: JSON.stringify({ claimToken: 'wrong-claim-token', success: true, result: { token: {} } })
    }
  );
  assert.equal(rejectedClaim.status, 409);
  assert.equal((await rejectedClaim.json()).code, 'DEBOT_JOB_CLAIM_INVALID');

  const mismatchedResult = await fetch(
    `${baseUrl}/api/social/bridge/debot/jobs/${claimed.jobs[0].id}/result`,
    {
      method: 'POST',
      headers: auth(token),
      body: JSON.stringify({
        claimToken: claimed.jobs[0].claimToken,
        success: true,
        result: {
          token: {
            meta: {
              chain: 'robinhood',
              address: '0x9999999999999999999999999999999999999999'
            }
          }
        }
      })
    }
  );
  assert.equal(mismatchedResult.status, 400);

  const rawResult = {
    token: { meta: { chain: 'robinhood', address: tokenAddress, symbol: 'TEST' } }
  };
  const completedResponse = await fetch(
    `${baseUrl}/api/social/bridge/debot/jobs/${claimed.jobs[0].id}/result`,
    {
      method: 'POST',
      headers: auth(token),
      body: JSON.stringify({ claimToken: claimed.jobs[0].claimToken, success: true, result: rawResult })
    }
  );
  assert.equal(completedResponse.status, 200);
  assert.deepEqual(await completedResponse.json(), { ok: true });
  const expected = { schema: 'debot.token_detail.raw.v1', data: rawResult };
  assert.deepEqual(await first, expected);
  assert.deepEqual(await duplicate, expected);

  const repeatedAck = await fetch(
    `${baseUrl}/api/social/bridge/debot/jobs/${claimed.jobs[0].id}/result`,
    {
      method: 'POST',
      headers: auth(token),
      body: JSON.stringify({ claimToken: claimed.jobs[0].claimToken, success: true, result: rawResult })
    }
  );
  assert.equal(repeatedAck.status, 200);
  assert.deepEqual(await socialService.requestDeBot('debot.token_detail.v1', {
    chain: 'robinhood',
    token: tokenAddress
  }), expected);
  const empty = await (await fetch(`${baseUrl}/api/social/bridge/debot/jobs`, {
    headers: { authorization: `Bearer ${token}` }
  })).json();
  assert.deepEqual(empty.jobs, []);
});

test('DeBot result endpoint enforces payload limits and stores only coarse remote errors', async (t) => {
  const token = 'analysis-limits-token';
  const tokenAddress = '0x2222222222222222222222222222222222222222';
  const wallet = '0xaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa';
  const { baseUrl, socialService } = await withSocialServer(t, { token });
  await fetch(`${baseUrl}/api/social/bridge/heartbeat`, {
    method: 'POST',
    headers: auth(token),
    body: JSON.stringify({ capabilities: ['debot-analysis-v1'] })
  });

  const pending = socialService.requestDeBot('debot.wallet_token_analysis.v1', {
    chain: 'robinhood',
    token: tokenAddress,
    wallet
  });
  const pendingFailure = assert.rejects(pending, (error) => {
    assert.equal(error.code, 'DEBOT_BRIDGE_REQUEST_FAILED');
    assert.equal(error.message.includes('authorization Bearer should-never-be-stored'), false);
    return true;
  });
  const job = (await (await fetch(`${baseUrl}/api/social/bridge/debot/jobs`, {
    headers: { authorization: `Bearer ${token}` }
  })).json()).jobs[0];
  const tooLarge = await fetch(`${baseUrl}/api/social/bridge/debot/jobs/${job.id}/result`, {
    method: 'POST',
    headers: auth(token),
    body: JSON.stringify({
      claimToken: job.claimToken,
      success: true,
      result: {
        chain: 'robinhood',
        token: tokenAddress,
        wallet,
        payload: 'x'.repeat(260 * 1024)
      }
    })
  });
  assert.equal(tooLarge.status, 413);
  assert.equal((await tooLarge.json()).code, 'DEBOT_RESULT_TOO_LARGE');

  const secret = 'authorization Bearer should-never-be-stored';
  const failed = await fetch(`${baseUrl}/api/social/bridge/debot/jobs/${job.id}/result`, {
    method: 'POST',
    headers: auth(token),
    body: JSON.stringify({
      claimToken: job.claimToken,
      success: false,
      error: secret,
      errorType: 'NETWORK'
    })
  });
  assert.equal(failed.status, 200);
  await pendingFailure;
  const stored = socialService.store.getDeBotJob(job.id);
  assert.equal(stored.errorCode, 'NETWORK');
  assert.equal(stored.errorMessage.includes(secret), false);

  const bodyLimit = await fetch(`${baseUrl}/api/social/bridge/debot/jobs/${job.id}/result`, {
    method: 'POST',
    headers: auth(token),
    body: JSON.stringify({ padding: 'x'.repeat(513 * 1024) })
  });
  assert.equal(bodyLimit.status, 413);
  assert.equal((await bodyLimit.json()).code, 'BODY_TOO_LARGE');
});

test('social SSE sends an initial snapshot and live normalized changes', async (t) => {
  const token = 'stream-device-token';
  const { baseUrl } = await withSocialServer(t, { token });
  const controller = new AbortController();
  const response = await fetch(`${baseUrl}/api/social/stream`, { signal: controller.signal });
  assert.equal(response.status, 200);
  assert.match(response.headers.get('content-type'), /text\/event-stream/);
  const reader = response.body.getReader();
  const decoder = new TextDecoder();
  let received = '';
  const first = await reader.read();
  received += decoder.decode(first.value, { stream: true });
  assert.match(received, /event: snapshot/);

  await fetch(`${baseUrl}/api/social/bridge/posts`, {
    method: 'POST',
    headers: auth(token),
    body: JSON.stringify({ posts: [{ source: 'twitter', id: 'stream-1', text: 'live' }] })
  });
  while (!received.includes('event: post.created')) {
    const chunk = await reader.read();
    if (chunk.done) break;
    received += decoder.decode(chunk.value, { stream: true });
  }
  assert.match(received, /event: post\.created/);
  assert.match(received, /"externalId":"stream-1"/);
  controller.abort();
});

test('server shutdown drains active social SSE before closing its store', async (t) => {
  const { baseUrl, server, socialService } = await withSocialServer(t, {
    token: 'shutdown-device-token'
  });
  const closeStore = socialService.store.close.bind(socialService.store);
  let storeCloseCalls = 0;
  socialService.store.close = () => {
    storeCloseCalls += 1;
    closeStore();
  };

  const response = await fetch(`${baseUrl}/api/social/stream`);
  const reader = response.body.getReader();
  const decoder = new TextDecoder();
  const first = await reader.read();
  assert.match(decoder.decode(first.value, { stream: true }), /event: snapshot/);

  let timeout;
  await Promise.race([
    new Promise((resolve, reject) => {
      server.close((error) => error ? reject(error) : resolve());
    }),
    new Promise((_, reject) => {
      timeout = setTimeout(() => reject(new Error('server.close timed out with an active social SSE client')), 1_000);
      timeout.unref?.();
    })
  ]).finally(() => clearTimeout(timeout));

  let remainder = '';
  while (true) {
    const chunk = await reader.read();
    if (chunk.done) break;
    remainder += decoder.decode(chunk.value, { stream: true });
  }
  remainder += decoder.decode();
  assert.match(remainder, /retry: 1000/);
  assert.equal(server.listening, false);
  server.closeSocialStreams();
  socialService.close();
  assert.equal(storeCloseCalls, 1);
});
