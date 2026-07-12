import test from 'node:test';
import assert from 'node:assert/strict';

import {
  normalizeBlockscoutHolder,
  RobinhoodHolderClient
} from '../src/robinhood/holderClient.js';

const token = '0x1111111111111111111111111111111111111111';
const walletA = '0xaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa';
const walletB = '0xbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb';
const walletC = '0xcccccccccccccccccccccccccccccccccccccccc';
const walletD = '0xdddddddddddddddddddddddddddddddddddddddd';
const dead = '0x000000000000000000000000000000000000dead';

function rawHolder(address, tokens, addressPatch = {}) {
  return {
    address: {
      hash: address,
      is_contract: false,
      is_verified: false,
      name: null,
      proxy_type: null,
      ...addressPatch
    },
    value: (BigInt(tokens) * 10n ** 18n).toString()
  };
}

test('normalizes Blockscout holder balances, USD value, share and infrastructure flags', () => {
  const snapshotAt = '2026-07-11T00:00:00.000Z';
  const holder = normalizeBlockscoutHolder(rawHolder(walletA.toUpperCase().replace('0X', '0x'), 250), {
    rank: 3,
    decimals: 18,
    totalSupply: (1_000n * 10n ** 18n).toString(),
    priceUsd: 2,
    snapshotAt
  });
  const delegatedAccount = normalizeBlockscoutHolder(
    rawHolder(walletB, 10, { is_contract: true, proxy_type: 'EIP7702' }),
    { rank: 4, decimals: 18, totalSupply: (1_000n * 10n ** 18n).toString(), priceUsd: 2, snapshotAt }
  );
  const poolContract = normalizeBlockscoutHolder(
    rawHolder(walletC, 10, { is_contract: true, name: 'Main Liquidity Pool' }),
    { rank: 5, decimals: 18, totalSupply: (1_000n * 10n ** 18n).toString(), priceUsd: 2, snapshotAt }
  );

  assert.equal(holder.address, walletA);
  assert.equal(holder.holderRank, 3);
  assert.equal(holder.holdingTokenAmount, 250);
  assert.equal(holder.holdingValueUsd, 500);
  assert.equal(holder.holdingSharePercent, 25);
  assert.equal(holder.excluded, false);
  assert.equal(delegatedAccount.excluded, false);
  assert.equal(delegatedAccount.proxyType, 'eip7702');
  assert.equal(poolContract.excluded, true);
  assert.deepEqual(poolContract.exclusionReasons, ['contract_holder', 'named_infrastructure']);
});

test('fetches paginated top holders in rank order and preserves exclusion evidence', async () => {
  const requests = [];
  const fetchImpl = async (input) => {
    const url = new URL(input);
    requests.push(url);
    if (!url.pathname.endsWith('/holders')) {
      return Response.json({
        decimals: '18',
        exchange_rate: '2',
        holders_count: '900',
        symbol: 'DOG',
        name: 'Gold Dog',
        total_supply: (1_000n * 10n ** 18n).toString(),
        icon_url: 'https://example.com/dog.png'
      });
    }
    if (!url.searchParams.has('items_count')) {
      return Response.json({
        items: [rawHolder(walletA, 300), rawHolder(dead, 200)],
        next_page_params: { items_count: 2, value: '200000000000000000000' }
      });
    }
    return Response.json({
      items: [
        rawHolder(walletB, 150, { is_contract: true, proxy_type: 'eip7702' }),
        rawHolder(walletC, 100, { is_contract: true, name: 'Router Contract' }),
        rawHolder(walletD, 50, { name: 'Community Treasury' })
      ],
      next_page_params: null
    });
  };
  const client = new RobinhoodHolderClient({ baseUrl: 'https://blockscout.test/api/v2', fetchImpl });

  const result = await client.fetchTopHolders(token, { limit: 5 });

  assert.equal(requests.length, 3);
  assert.equal(requests[2].searchParams.get('items_count'), '2');
  assert.equal(requests[2].searchParams.get('value'), '200000000000000000000');
  assert.equal(result.reachedEnd, true);
  assert.equal(result.token.totalSupply, 1_000);
  assert.equal(result.token.priceUsd, 2);
  assert.deepEqual(result.holders.map((holder) => holder.holderRank), [1, 2, 3, 4, 5]);
  assert.deepEqual(result.holders.map((holder) => holder.holdingValueUsd), [600, 400, 300, 200, 100]);
  assert.deepEqual(result.holders[1].exclusionReasons, ['burn_address']);
  assert.equal(result.holders[2].excluded, false);
  assert.deepEqual(result.holders[3].exclusionReasons, ['contract_holder', 'named_infrastructure']);
  assert.deepEqual(result.holders[4].exclusionReasons, ['named_infrastructure']);
});

test('rejects malformed token addresses before contacting Blockscout', async () => {
  let requests = 0;
  const client = new RobinhoodHolderClient({ fetchImpl: async () => { requests += 1; } });
  await assert.rejects(client.fetchTopHolders('0x1234'), /Invalid Robinhood token address/);
  assert.equal(requests, 0);
});

test('retries a transient Blockscout holder failure without duplicating the page', async () => {
  let holderAttempts = 0;
  const client = new RobinhoodHolderClient({
    baseUrl: 'https://blockscout.test/api/v2',
    fetchImpl: async (input) => {
      const url = new URL(input);
      if (!url.pathname.endsWith('/holders')) {
        return Response.json({
          decimals: '18',
          exchange_rate: '1',
          total_supply: (1_000n * 10n ** 18n).toString()
        });
      }
      holderAttempts += 1;
      if (holderAttempts === 1) {
        return new Response('{}', { status: 503, headers: { 'retry-after': '0' } });
      }
      return Response.json({ items: [rawHolder(walletA, 100)], next_page_params: null });
    }
  });

  const result = await client.fetchTopHolders(token, { limit: 1 });

  assert.equal(holderAttempts, 2);
  assert.deepEqual(result.holders.map((holder) => holder.address), [walletA]);
});

test('does not retry a non-retryable Blockscout client error', async () => {
  let tokenAttempts = 0;
  const client = new RobinhoodHolderClient({
    baseUrl: 'https://blockscout.test/api/v2',
    fetchImpl: async (input) => {
      const url = new URL(input);
      if (url.pathname.endsWith('/holders')) {
        return Response.json({ items: [], next_page_params: null });
      }
      tokenAttempts += 1;
      return new Response('{}', { status: 404 });
    }
  });

  await assert.rejects(client.fetchTopHolders(token), /Blockscout request failed with HTTP 404/);
  assert.equal(tokenAttempts, 1);
});

test('fetches resumable token and wallet ERC-20 transfer pages', async () => {
  const requests = [];
  const transfer = {
    token: { address_hash: token, symbol: 'DOG', name: 'Gold Dog', decimals: '18', type: 'ERC-20' },
    from: { hash: walletA, is_contract: false, proxy_type: null },
    to: { hash: walletC, is_contract: true, proxy_type: null, name: 'Pool' },
    transaction_hash: `0x${'1'.repeat(64)}`,
    log_index: 4,
    block_number: 123,
    timestamp: '2026-07-11T00:00:00.000Z',
    token_type: 'ERC-20'
  };
  const client = new RobinhoodHolderClient({
    baseUrl: 'https://blockscout.test/api/v2',
    fetchImpl: async (input) => {
      const url = new URL(input);
      requests.push(url);
      return Response.json({
        items: [transfer],
        next_page_params: url.pathname.includes('/addresses/') ? null : { index: 4, block_number: 123 }
      });
    }
  });

  const tokenPage = await client.fetchTokenTransfers(token, { cursor: { index: 8, block_number: 456 } });
  const walletPage = await client.fetchAddressTokenTransfers(walletA, { cursor: { index: 4, block_number: 123 } });

  assert.equal(requests[0].searchParams.get('index'), '8');
  assert.equal(requests[0].searchParams.get('block_number'), '456');
  assert.equal(requests[1].searchParams.get('type'), 'ERC-20');
  assert.equal(requests[1].searchParams.get('index'), '4');
  assert.equal(tokenPage.items[0].from.address, walletA);
  assert.equal(tokenPage.items[0].to.isContract, true);
  assert.equal(tokenPage.complete, false);
  assert.equal(walletPage.complete, true);
});
