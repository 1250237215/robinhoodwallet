import assert from 'node:assert/strict';
import test from 'node:test';

import { SolanaRpcPollingMonitor, normalizeSolanaRpcTransaction } from '../src/solana/rpcPollingMonitor.js';
import { WRAPPED_SOL_MINT } from '../src/solana/webhookMonitor.js';

const wallet = 'EgsaH8Voe7KRkZwheXFF6vWKjV5VRZGyQ6CaLeqe5KmP';
const mint = 'DGmn9wHxiPLPUgS5Ni7dje8RVtiKNaMiDzbYtZs9pump';
const signature1 = '25fzwvU3bzEc14ApdVNy7ybqKqUooy7st18qeUhMSixyRLK2gD4r5eGTBXCkuhq81h6vQzWFYw33PF2p1UiExvyM';
const signature2 = '3z1AYcMW8rifA9puytVq3DALoMnq2DF89Z7BN5kLU6YMyz3SF3B3TstYFhUoXpZZfJptDs1GZ5fY8uqrw4E4Sr6D';

function annotation() {
  return {
    address: wallet,
    alias: 'Sol wallet',
    monitorRules: Object.fromEntries(['buy', 'sell', 'transfer', 'token_create'].map((type) => [
      type, { enabled: true, sound: false, bark: type === 'buy' }
    ]))
  };
}

function transaction({ signature = signature2, tokenDelta = 1_000_000n, solDelta = -1_000_000_000n } = {}) {
  const beforeSol = 5_000_000_000n;
  const fee = 5_000n;
  return {
    slot: 123,
    blockTime: 2_000_000_000,
    transaction: {
      signatures: [signature],
      message: { accountKeys: [{ pubkey: wallet }], instructions: [] }
    },
    meta: {
      err: null,
      fee: Number(fee),
      preBalances: [Number(beforeSol)],
      postBalances: [Number(beforeSol + solDelta - fee)],
      preTokenBalances: [
        { owner: wallet, mint, uiTokenAmount: { amount: '0', decimals: 6 } },
        { owner: wallet, mint: WRAPPED_SOL_MINT, uiTokenAmount: { amount: '0', decimals: 9 } }
      ],
      postTokenBalances: [
        { owner: wallet, mint, uiTokenAmount: { amount: String(tokenDelta), decimals: 6 } },
        { owner: wallet, mint: WRAPPED_SOL_MINT, uiTokenAmount: { amount: '0', decimals: 9 } }
      ],
      innerInstructions: []
    }
  };
}

test('public RPC normalization identifies buys but ignores fee-only incoming transfers', () => {
  const buy = normalizeSolanaRpcTransaction(transaction(), { monitoredWallets: [annotation()] });
  assert.equal(buy.length, 1);
  assert.equal(buy[0].eventType, 'buy');
  assert.equal(buy[0].provider, 'solana_public_rpc_polling');

  const incomingTransfer = normalizeSolanaRpcTransaction(transaction({ solDelta: 0n }), {
    monitoredWallets: [annotation()]
  });
  assert.deepEqual(incomingTransfer, []);
});

test('public RPC poller establishes a baseline and only ingests newer signatures', async () => {
  const metadata = new Map();
  const ingested = [];
  let rows = [{ signature: signature1, err: null }];
  const poller = new SolanaRpcPollingMonitor({
    store: {
      getMeta(key) { return metadata.get(key) || ''; },
      setMeta(key, value) { metadata.set(key, value); }
    },
    rpcClient: {
      async getSignaturesForAddress(_address, options) {
        assert.equal(options.limit, 10);
        assert.equal(options.before, '');
        return rows;
      },
      async getTransaction(signature) { return transaction({ signature }); }
    },
    walletProvider: () => [annotation()],
    onTransaction: async (value) => ingested.push(value.transaction.signatures[0]),
    intervalMs: 60_000
  });
  await poller.pollNow();
  assert.deepEqual(ingested, []);
  rows = [{ signature: signature2, err: null }];
  await poller.pollNow();
  assert.deepEqual(ingested, [signature2]);
  poller.close();
});

test('public RPC poller reports ready with zero wallets and degrades after repeated failures', async () => {
  const poller = new SolanaRpcPollingMonitor({
    store: { getMeta() { return ''; }, setMeta() {} },
    rpcClient: {
      async getSignaturesForAddress() { throw new Error('429 rate limited'); },
      async getTransaction() { return null; }
    },
    walletProvider: () => [],
    onTransaction: async () => {},
    intervalMs: 60_000
  });
  assert.equal(poller.getHealth().realtimeReady, true);
  assert.equal((await poller.pollNow()).realtimeReady, true);
  poller.walletProvider = () => [annotation()];
  await poller.pollNow();
  await poller.pollNow();
  const health = await poller.pollNow();
  assert.equal(health.realtimeReady, false);
  assert.deepEqual(health.reasons, ['public_rpc_poll_failed']);
  poller.close();
});
