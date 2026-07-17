import assert from 'node:assert/strict';
import test from 'node:test';

import {
  decodeBase58,
  encodeBase58,
  isSolanaAddress,
  normalizeSolanaAddress,
  normalizeSolanaSignature
} from '../src/solana/address.js';
import {
  SolanaHolderClient,
  SolanaHolderScanLimitError,
  SOLANA_SYSTEM_PROGRAM_ID,
  SPL_TOKEN_2022_PROGRAM_ID,
  SPL_TOKEN_PROGRAM_ID
} from '../src/solana/holderClient.js';
import { SolanaRpcClient, SolanaRpcError } from '../src/solana/rpcClient.js';
import { SolanaCompositeMarketClient, SolanaDexScreenerClient } from '../src/solana/marketClient.js';
import {
  MemorySolanaSignatureStore,
  SolanaHeliusWebhookMonitor,
  SolanaWebhookAuthenticationError,
  normalizeHeliusTransaction
} from '../src/solana/webhookMonitor.js';

const wallet = 'EgsaH8Voe7KRkZwheXFF6vWKjV5VRZGyQ6CaLeqe5KmP';
const otherWallet = '34QBSvWGEWpcz45ZfUGFGGSfK6j6P8rRnTaK7uufyVJw';
const recipient = 'DPVQxpRX9hPqJYMYcfw5XBwxhKjqMqw8DuNTGgAGtbKa';
const mint = 'DGmn9wHxiPLPUgS5Ni7dje8RVtiKNaMiDzbYtZs9pump';
const signatures = [
  '25fzwvU3bzEc14ApdVNy7ybqKqUooy7st18qeUhMSixyRLK2gD4r5eGTBXCkuhq81h6vQzWFYw33PF2p1UiExvyM',
  '3z1AYcMW8rifA9puytVq3DALoMnq2DF89Z7BN5kLU6YMyz3SF3B3TstYFhUoXpZZfJptDs1GZ5fY8uqrw4E4Sr6D',
  '65fhDMnZ5mwwTP4D23bnNWWMP6z1FaJAvU2KhVa2JRJgkuBUdytQJCBKEQVkJ7SXMmDEAGGyct5rB4Am6KX731jT',
  '2DKhHZjUefF8GDevu2hXEFQLTuc4Cfk3C4rLMouQqibQ393fxHxqtbGjwaNBxxMJohTP4Bkhg1UVAW83sMFi1oUc'
];

function programAccount(owner, amount) {
  const data = Buffer.alloc(40);
  Buffer.from(decodeBase58(owner)).copy(data, 0);
  data.writeBigUInt64LE(BigInt(amount), 32);
  return { account: { data: [data.toString('base64'), 'base64'] } };
}

function monitoredWallets() {
  return [{
    address: wallet,
    alias: 'Core Solana',
    monitorRules: Object.fromEntries(['buy', 'sell', 'transfer', 'token_create'].map((eventType) => [
      eventType,
      { enabled: true, sound: true, bark: eventType === 'buy' }
    ]))
  }];
}

function tokenChange(amount, decimals = 6) {
  return {
    userAccount: wallet,
    mint,
    rawTokenAmount: { tokenAmount: String(amount), decimals }
  };
}

test('Solana addresses use canonical 32-byte Base58 and preserve case', () => {
  const system = '11111111111111111111111111111111';
  assert.equal(decodeBase58(system).length, 32);
  assert.equal(encodeBase58(decodeBase58(system)), system);
  assert.equal(normalizeSolanaAddress(wallet), wallet);
  assert.equal(isSolanaAddress(wallet), true);
  assert.equal(isSolanaAddress(wallet.toLowerCase()), false);
  assert.throws(() => normalizeSolanaAddress('0x1234'), /Base58|32 bytes/);
  assert.throws(() => normalizeSolanaAddress(`${wallet}1`), /32 bytes/);
  for (const signature of signatures) assert.equal(normalizeSolanaSignature(signature), signature);
});

test('Solana RPC retries HTTP 429 and preserves the JSON-RPC result', async () => {
  const waits = [];
  let attempts = 0;
  const client = new SolanaRpcClient({
    maxRetries: 2,
    retryDelayMs: 25,
    sleep: async (ms) => waits.push(ms),
    fetchImpl: async (_url, options) => {
      attempts += 1;
      const request = JSON.parse(options.body);
      if (attempts === 1) {
        return new Response(JSON.stringify({ error: { message: 'rate limited' } }), {
          status: 429,
          headers: { 'content-type': 'application/json', 'retry-after': '0' }
        });
      }
      return new Response(JSON.stringify({ jsonrpc: '2.0', id: request.id, result: 42 }), {
        status: 200,
        headers: { 'content-type': 'application/json' }
      });
    }
  });
  assert.equal(await client.request('getSlot'), 42);
  assert.equal(attempts, 2);
  assert.deepEqual(waits, [0]);
});

test('Solana RPC rejects an oversized response before parsing it', async () => {
  const client = new SolanaRpcClient({
    maxRetries: 0,
    maxResponseBytes: 1_024,
    fetchImpl: async () => new Response('{}', {
      status: 200,
      headers: { 'content-length': '2048' }
    })
  });
  await assert.rejects(
    client.request('getProgramAccounts'),
    (error) => error instanceof SolanaRpcError && error.kind === 'response-too-large'
  );
});

test('Solana market data falls back from DeBot to the deepest DexScreener base-token pair', async () => {
  const dexScreener = new SolanaDexScreenerClient({
    fetchImpl: async (url) => {
      assert.equal(url, `https://api.dexscreener.com/token-pairs/v1/solana/${mint}`);
      return new Response(JSON.stringify([
        {
          chainId: 'solana',
          dexId: 'small',
          pairAddress: recipient,
          baseToken: { address: mint, symbol: 'RUMP', name: 'Official Rump Coin' },
          liquidity: { usd: 10_000 },
          marketCap: 50_000,
          pairCreatedAt: 2_000_000_000_000
        },
        {
          chainId: 'solana',
          dexId: 'pumpswap',
          pairAddress: otherWallet,
          baseToken: { address: mint, symbol: 'RUMP', name: 'Official Rump Coin' },
          liquidity: { usd: 25_000 },
          marketCap: 75_000,
          pairCreatedAt: 2_000_000_100_000
        },
        {
          chainId: 'solana',
          dexId: 'wrong-side',
          baseToken: { address: otherWallet, symbol: 'SOL', name: 'Wrapped SOL' },
          quoteToken: { address: mint },
          liquidity: { usd: 1_000_000 },
          marketCap: 999_999
        }
      ]), { status: 200, headers: { 'content-type': 'application/json' } });
    }
  });
  const composite = new SolanaCompositeMarketClient({
    primary: { async fetchTokenMetrics() { throw new Error('DeBot HTTP 403'); } },
    fallback: dexScreener
  });
  const metrics = await composite.fetchTokenMetrics(mint);
  assert.equal(metrics.source, 'dexscreener');
  assert.equal(metrics.marketCapUsd, 75_000);
  assert.equal(metrics.creationTimestamp, 2_000_000_100);
  assert.equal(metrics.primaryDex, 'pumpswap');
  assert.equal(metrics.primaryPoolAddress, otherWallet);
});

test('Solana holder scan merges owners across legacy and Token-2022 accounts', async () => {
  const calls = [];
  const client = new SolanaHolderClient({
    rpcClient: {
      async getTokenSupply() {
        return { amount: '1000000000', decimals: 6 };
      },
      async getProgramAccountsForMint(program) {
        calls.push(program);
        if (program === SPL_TOKEN_PROGRAM_ID) {
          return [programAccount(wallet, 200_000_000n), programAccount(otherWallet, 300_000_000n)];
        }
        return [programAccount(wallet, 250_000_000n)];
      },
      async getTokenLargestAccounts() {
        throw new Error('fallback must not run');
      },
      async getMultipleAccounts(addresses, { encoding }) {
        assert.equal(encoding, 'base64');
        return addresses.map(() => ({ owner: SOLANA_SYSTEM_PROGRAM_ID, executable: false }));
      }
    }
  });
  const result = await client.fetchTopHolders(mint, { limit: 10 });
  assert.deepEqual(calls, [SPL_TOKEN_PROGRAM_ID, SPL_TOKEN_2022_PROGRAM_ID]);
  assert.equal(result.source, 'solana_rpc_program_accounts');
  assert.equal(result.partial, false);
  assert.equal(result.scannedAccounts, 3);
  assert.deepEqual(result.holders.map((row) => row.address), [wallet, otherWallet]);
  assert.equal(result.holders[0].rawHoldingTokenAmount, '450000000');
  assert.equal(result.holders[0].holdingTokenAmount, '450');
  assert.equal(result.holders[0].holdingSharePercent, 45);
});

test('Solana holder scan falls back to largest accounts when the full response exceeds limits', async () => {
  const client = new SolanaHolderClient({
    rpcClient: {
      async getTokenSupply() {
        return { amount: '1000000000', decimals: 6 };
      },
      async getProgramAccountsForMint() {
        throw new SolanaHolderScanLimitError('response too large');
      },
      async getTokenLargestAccounts() {
        return [
          { address: recipient, amount: '400000000' },
          { address: otherWallet, amount: '100000000' }
        ];
      },
      async getMultipleAccounts(addresses, { encoding }) {
        if (encoding === 'jsonParsed') {
          return [
            { data: { parsed: { info: { owner: wallet, tokenAmount: { amount: '400000000' } } } } },
            { data: { parsed: { info: { owner: otherWallet, tokenAmount: { amount: '100000000' } } } } }
          ];
        }
        return addresses.map(() => ({ owner: SOLANA_SYSTEM_PROGRAM_ID, executable: false }));
      }
    }
  });
  const result = await client.fetchTopHolders(mint, { limit: 150 });
  assert.equal(result.source, 'solana_rpc_largest_accounts');
  assert.equal(result.partial, true);
  assert.equal(result.reachedEnd, false);
  assert.deepEqual(result.holders.map((row) => row.address), [wallet, otherWallet]);
});

test('Solana holder scan removes pool PDAs, executable programs, and empty owner accounts', async () => {
  const pool = recipient;
  const client = new SolanaHolderClient({
    rpcClient: {
      async getTokenSupply() {
        return { amount: '1000000000', decimals: 6 };
      },
      async getProgramAccountsForMint(program) {
        return program === SPL_TOKEN_PROGRAM_ID ? [
          programAccount(pool, 500_000_000n),
          programAccount(wallet, 300_000_000n),
          programAccount(otherWallet, 200_000_000n)
        ] : [];
      },
      async getTokenLargestAccounts() {
        throw new Error('fallback must not run');
      },
      async getMultipleAccounts(addresses, { encoding }) {
        assert.equal(encoding, 'base64');
        return addresses.map((address) => {
          if (address === pool) return { owner: SPL_TOKEN_2022_PROGRAM_ID, executable: false };
          if (address === otherWallet) return null;
          return { owner: SOLANA_SYSTEM_PROGRAM_ID, executable: false };
        });
      }
    }
  });
  const result = await client.fetchTopHolders(mint, { limit: 2 });
  assert.deepEqual(result.holders.map((row) => row.address), [wallet]);
  assert.equal(result.holders[0].holderRank, 1);
});

test('Helius swap normalization creates buy and sell events from signed wallet balance deltas', () => {
  const buy = normalizeHeliusTransaction({
    signature: signatures[0],
    type: 'SWAP',
    source: 'PUMP_AMM',
    feePayer: wallet,
    slot: 100,
    timestamp: 2_000_000_000,
    accountData: [{ account: wallet, tokenBalanceChanges: [tokenChange('14535155000000')] }],
    tokenTransfers: [{ fromUserAccount: otherWallet, toUserAccount: wallet, mint }]
  }, { monitoredWallets: monitoredWallets(), now: () => 2_000_000_001_000 });
  assert.equal(buy.length, 1);
  assert.equal(buy[0].eventType, 'buy');
  assert.equal(buy[0].walletAddress, wallet);
  assert.equal(buy[0].tokenAddress, mint);
  assert.equal(buy[0].tokenAmount, '14535155');
  assert.equal(buy[0].platform, 'pump');
  assert.equal(buy[0].soundAlert, true);
  assert.equal(buy[0].barkAlert, true);

  const sell = normalizeHeliusTransaction({
    signature: signatures[1],
    type: 'SELL',
    source: 'PUMP_AMM',
    feePayer: wallet,
    slot: 101,
    timestamp: 2_000_000_002,
    accountData: [{ account: wallet, tokenBalanceChanges: [tokenChange('-1000000')] }]
  }, { monitoredWallets: monitoredWallets() });
  assert.equal(sell.length, 1);
  assert.equal(sell[0].eventType, 'sell');
  assert.equal(sell[0].tokenAmount, '1');
});

test('Helius direct transfers and SPL mint initialization normalize independently', () => {
  const transfer = normalizeHeliusTransaction({
    signature: signatures[2],
    type: 'TRANSFER',
    source: 'SOLANA_PROGRAM_LIBRARY',
    feePayer: wallet,
    slot: 102,
    timestamp: 2_000_000_003,
    accountData: [{ account: wallet, tokenBalanceChanges: [tokenChange('-2500000')] }],
    tokenTransfers: [{ fromUserAccount: wallet, toUserAccount: recipient, mint, tokenAmount: 2.5 }]
  }, { monitoredWallets: monitoredWallets() });
  assert.equal(transfer.length, 1);
  assert.equal(transfer[0].eventType, 'transfer');
  assert.equal(transfer[0].counterpartyAddress, recipient);
  assert.equal(transfer[0].tokenAmount, '2.5');

  const create = normalizeHeliusTransaction({
    signature: signatures[3],
    type: 'UNKNOWN',
    source: 'PUMP_FUN',
    feePayer: wallet,
    slot: 103,
    timestamp: 2_000_000_004,
    instructions: [{
      programId: SPL_TOKEN_2022_PROGRAM_ID,
      accounts: [mint],
      data: encodeBase58(Uint8Array.of(20)),
      innerInstructions: []
    }]
  }, { monitoredWallets: monitoredWallets() });
  assert.equal(create.length, 1);
  assert.equal(create[0].eventType, 'token_create');
  assert.equal(create[0].tokenAddress, mint);
  assert.equal(create[0].platform, 'pump');
});

test('Helius monitor deduplicates signatures and reports missing production configuration', async () => {
  const monitor = new SolanaHeliusWebhookMonitor({
    monitoredWallets: monitoredWallets(),
    signatureStore: new MemorySolanaSignatureStore(),
    now: () => 2_000_000_010_000
  });
  assert.equal(monitor.getHealth().status, 'degraded');
  assert.deepEqual(monitor.getHealth().reasons, [
    'helius_api_key_missing',
    'https_webhook_url_missing',
    'webhook_auth_header_missing',
    'durable_signature_store_missing'
  ]);
  const payload = [{
    signature: signatures[0],
    type: 'SWAP',
    source: 'JUPITER',
    feePayer: wallet,
    slot: 104,
    timestamp: 2_000_000_005,
    accountData: [{ account: wallet, tokenBalanceChanges: [tokenChange('1000000')] }]
  }];
  const first = await monitor.ingest(payload);
  const second = await monitor.ingest(payload);
  assert.equal(first.events.length, 1);
  assert.deepEqual(first.acceptedSignatures, [signatures[0]]);
  assert.equal(second.events.length, 0);
  assert.deepEqual(second.duplicateSignatures, [signatures[0]]);
});

test('Helius monitor releases earlier claims when normalization aborts a webhook batch', async () => {
  const signatureStore = new MemorySolanaSignatureStore();
  const monitor = new SolanaHeliusWebhookMonitor({
    monitoredWallets: monitoredWallets(),
    signatureStore
  });
  const valid = {
    signature: signatures[0],
    type: 'SWAP',
    source: 'JUPITER',
    feePayer: wallet,
    accountData: [{ account: wallet, tokenBalanceChanges: [tokenChange('1000000')] }]
  };
  const fatal = {
    signature: signatures[1],
    type: 'SWAP',
    source: 'JUPITER',
    feePayer: wallet,
    get accountData() {
      throw new Error('synthetic normalization failure');
    }
  };

  await assert.rejects(
    monitor.ingest([valid, fatal]),
    /synthetic normalization failure/
  );
  const retry = await monitor.ingest([valid]);
  assert.deepEqual(retry.acceptedSignatures, [signatures[0]]);
  assert.equal(retry.events.length, 1);
});

test('Helius monitor enforces its configured authorization header', async () => {
  const monitor = new SolanaHeliusWebhookMonitor({
    authHeader: 'Bearer private-hook-secret',
    monitoredWallets: monitoredWallets()
  });
  await assert.rejects(
    monitor.ingest([], { authorization: 'Bearer wrong' }),
    SolanaWebhookAuthenticationError
  );
  const accepted = await monitor.ingest([], { authorization: 'Bearer private-hook-secret' });
  assert.equal(accepted.acceptedTransactions, 0);
});
