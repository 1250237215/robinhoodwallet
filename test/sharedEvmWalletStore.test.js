import test from 'node:test';
import assert from 'node:assert/strict';
import { execFile } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import { promisify } from 'node:util';

import { createRobinhoodService } from '../src/robinhood/service.js';
import { createRobinhoodStore } from '../src/robinhood/store.js';

const walletA = '0xaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa';
const walletB = '0xbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb';
const walletC = '0xcccccccccccccccccccccccccccccccccccccccc';
const walletD = '0xdddddddddddddddddddddddddddddddddddddddd';
const walletE = '0xeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeee';
const walletF = '0xffffffffffffffffffffffffffffffffffffffff';
const tokenA = '0x1111111111111111111111111111111111111111';
const tokenB = '0x2222222222222222222222222222222222222222';
const tokenC = '0x3333333333333333333333333333333333333333';
const execFileAsync = promisify(execFile);

const defaultRules = {
  buy: { enabled: true, sound: false, bark: false },
  sell: { enabled: false, sound: false, bark: false },
  transfer: { enabled: false, sound: false, bark: false },
  token_create: { enabled: false, sound: false, bark: false }
};

function createFiles(t, prefix) {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), prefix));
  t.after(() => fs.rmSync(directory, { recursive: true, force: true }));
  return {
    directory,
    robinhood: path.join(directory, 'robinhood.sqlite'),
    bsc: path.join(directory, 'bsc.sqlite'),
    shared: path.join(directory, 'evm-wallets.sqlite')
  };
}

function openStore(filename, chainId, chainLabel, walletAnnotationFile) {
  return createRobinhoodStore(filename, { chainId, chainLabel, walletAnnotationFile });
}

function serviceFor(store, nowSeconds = 1_800_000_000) {
  return createRobinhoodService({
    store,
    chainId: store.chainId,
    chainLabel: store.chainLabel,
    now: () => nowSeconds * 1000,
    config: { autoScanLimit: 0 }
  });
}

function insertBuy(store, {
  walletAddress = walletA,
  tokenAddress = tokenA,
  timestamp,
  sequence
}) {
  return store.insertMonitorEvent({
    eventType: 'buy',
    assetType: 'erc20',
    walletAddress,
    walletAlias: 'Shared wallet',
    tokenAddress,
    tokenSymbol: 'TOKEN',
    tokenName: 'Token',
    tokenAmount: '1',
    rawTokenAmount: '1000000000000000000',
    tokenDecimals: 18,
    txHash: `0x${sequence.toString(16).padStart(64, '0')}`,
    logIndex: sequence,
    blockNumber: sequence,
    blockTimestamp: timestamp,
    detectedAt: timestamp
  });
}

test('shares confirmed EVM wallet curation immediately while chain data stays isolated', (t) => {
  const files = createFiles(t, 'shared-evm-wallets-');
  const robinhood = openStore(files.robinhood, 'robinhood', 'Robinhood', files.shared);
  const bsc = openStore(files.bsc, 'bsc', 'BSC', files.shared);
  t.after(() => {
    robinhood.close();
    bsc.close();
  });
  const robinhoodService = serviceFor(robinhood, 1_800_000_001);
  const bscService = serviceFor(bsc, 1_800_000_002);

  const batch = robinhoodService.batchUpdateWallets(`${walletA},Robinhood imported note`);
  assert.equal(batch.created, 1);
  assert.equal(bsc.getWalletAnnotation(walletA)?.note, 'Robinhood imported note');

  const bscBatch = bscService.batchUpdateWallets(`${walletB},BSC imported note`);
  assert.equal(bscBatch.created, 1);
  assert.equal(robinhood.getWalletAnnotation(walletB)?.note, 'BSC imported note');

  bscService.updateWallet(walletA, {
    alias: 'Shared alpha',
    aliasSource: 'manual',
    note: 'Edited from BSC',
    tags: ['core', 'manual'],
    monitorTier: 'core',
    monitorRules: {
      sell: { enabled: true, sound: true, bark: true },
      transfer: { enabled: true, bark: true }
    }
  });

  assert.deepEqual(robinhood.getWalletAnnotation(walletA), {
    address: walletA,
    alias: 'Shared alpha',
    aliasSource: 'manual',
    note: 'Edited from BSC',
    tags: ['core', 'manual'],
    status: 'active',
    classificationOverride: null,
    monitorTier: 'core',
    monitorRules: {
      ...defaultRules,
      sell: { enabled: true, sound: true, bark: true },
      transfer: { enabled: true, sound: false, bark: true }
    },
    createdAt: 1_800_000_001,
    updatedAt: 1_800_000_002
  });

  robinhoodService.deleteWallet(walletA);
  assert.equal(bsc.getWalletAnnotation(walletA)?.status, 'excluded');
  bscService.updateWallet(walletA, { status: 'active' });
  assert.equal(robinhood.getWalletAnnotation(walletA)?.status, 'active');

  robinhood.upsertToken({ address: tokenA, symbol: 'HOOD', name: 'Robinhood only', updatedAt: 10 });
  robinhood.replaceWalletSummaries([{ address: walletA, score: 99, chainMarker: 'robinhood' }]);
  insertBuy(robinhood, { timestamp: 1_800_000_010, sequence: 1 });

  assert.equal(bsc.getToken(tokenA), null);
  assert.deepEqual(bsc.listWalletSummaries(), []);
  assert.deepEqual(bsc.listMonitorEvents(), []);

  bsc.upsertToken({ address: tokenB, symbol: 'BSC', name: 'BSC only', updatedAt: 11 });
  bsc.replaceWalletSummaries([{ address: walletB, score: 77, chainMarker: 'bsc' }]);
  insertBuy(bsc, {
    walletAddress: walletB,
    tokenAddress: tokenB,
    timestamp: 1_800_000_011,
    sequence: 2
  });

  assert.equal(robinhood.getToken(tokenB), null);
  assert.deepEqual(robinhood.listWalletSummaries().map((row) => row.chainMarker), ['robinhood']);
  assert.deepEqual(robinhood.listMonitorEvents().map((row) => row.tokenAddress), [tokenA]);
});

test('keeps an unconfirmed candidate exclusion local to its chain', (t) => {
  const files = createFiles(t, 'shared-evm-candidate-');
  const robinhood = openStore(files.robinhood, 'robinhood', 'Robinhood', files.shared);
  const bsc = openStore(files.bsc, 'bsc', 'BSC', files.shared);
  t.after(() => {
    robinhood.close();
    bsc.close();
  });
  const robinhoodService = serviceFor(robinhood, 1_800_000_100);
  const bscService = serviceFor(bsc, 1_800_000_100);
  const candidate = { address: walletC, score: 50, hits: 1, entries: 1, maxTotalMultiple: 12 };

  robinhood.replaceWalletSummaries([candidate]);
  bsc.replaceWalletSummaries([candidate]);
  assert.equal(robinhood.getWalletAnnotation(walletC), null);
  assert.equal(bsc.getWalletAnnotation(walletC), null);

  const confirmedDelete = robinhoodService.deleteWallet(walletC);
  assert.equal(confirmedDelete.ok, true);
  assert.equal(confirmedDelete.candidateOnly, true);
  assert.equal(bsc.getWalletAnnotation(walletC), null);

  const exclusion = robinhoodService.excludeWalletCandidate(walletC);

  assert.equal(exclusion.ok, true);
  assert.equal(exclusion.candidateOnly, true);
  assert.equal(exclusion.alreadyExcluded, true);
  assert.equal(robinhood.getWalletAnnotation(walletC), null);
  assert.equal(bsc.getWalletAnnotation(walletC), null);
  assert.equal(robinhood.getWalletCandidateExclusion(walletC)?.address, walletC);
  assert.equal(bsc.getWalletCandidateExclusion(walletC), null);
  assert.deepEqual(
    robinhoodService.listWallets({ tab: 'all', review: 'excluded' }).map((wallet) => wallet.address),
    [walletC]
  );
  assert.deepEqual(
    bscService.listWallets({ tab: 'all', review: 'pending' }).map((wallet) => wallet.address),
    [walletC]
  );
});

test('merges legacy wallets once with deterministic conflicts and preserves global exclusions', (t) => {
  const files = createFiles(t, 'shared-evm-migration-');
  let legacyRobinhood = openStore(files.robinhood, 'robinhood', 'Robinhood');
  let legacyBsc = openStore(files.bsc, 'bsc', 'BSC');

  legacyRobinhood.upsertWalletAnnotation({
    address: walletA,
    alias: 'Robinhood only',
    status: 'watch',
    createdAt: 10,
    updatedAt: 100
  });
  legacyBsc.upsertWalletAnnotation({
    address: walletB,
    alias: 'BSC only',
    status: 'active',
    createdAt: 20,
    updatedAt: 110
  });
  legacyRobinhood.upsertWalletAnnotation({
    address: walletC,
    alias: 'Older Robinhood',
    note: 'must lose',
    createdAt: 5,
    updatedAt: 200
  });
  legacyBsc.upsertWalletAnnotation({
    address: walletC,
    alias: 'Newer BSC',
    note: 'must win',
    createdAt: 15,
    updatedAt: 300
  });
  legacyRobinhood.upsertWalletAnnotation({
    address: walletD,
    alias: 'Robinhood tie winner',
    createdAt: 30,
    updatedAt: 400
  });
  legacyBsc.upsertWalletAnnotation({
    address: walletD,
    alias: 'BSC tie loser',
    createdAt: 40,
    updatedAt: 400
  });
  legacyRobinhood.upsertWalletAnnotation({
    address: walletE,
    alias: 'Local rejected candidate',
    status: 'excluded',
    createdAt: 50,
    updatedAt: 500
  });
  legacyRobinhood.close();
  legacyBsc.close();
  legacyRobinhood = null;
  legacyBsc = null;

  // BSC opens first to prove that the later Robinhood import still wins an equal-timestamp conflict.
  let bsc = openStore(files.bsc, 'bsc', 'BSC', files.shared);
  let robinhood = openStore(files.robinhood, 'robinhood', 'Robinhood', files.shared);
  t.after(() => {
    robinhood?.close();
    bsc?.close();
  });

  assert.equal(robinhood.getWalletAnnotation(walletA)?.status, 'watch');
  assert.equal(bsc.getWalletAnnotation(walletA)?.alias, 'Robinhood only');
  assert.equal(robinhood.getWalletAnnotation(walletB)?.alias, 'BSC only');
  assert.equal(bsc.getWalletAnnotation(walletC)?.alias, 'Newer BSC');
  assert.equal(bsc.getWalletAnnotation(walletC)?.note, 'must win');
  assert.equal(bsc.getWalletAnnotation(walletC)?.createdAt, 5, 'the earliest creation time is retained');
  assert.equal(bsc.getWalletAnnotation(walletD)?.alias, 'Robinhood tie winner');

  assert.equal(robinhood.getWalletAnnotation(walletE)?.status, 'excluded');
  assert.equal(bsc.getWalletAnnotation(walletE)?.status, 'excluded', 'legacy exclusions remain blocked on both chains');
  assert.equal(robinhood.getWalletCandidateExclusion(walletE), null);
  assert.equal(bsc.getWalletCandidateExclusion(walletE), null);

  bsc.upsertWalletAnnotation({
    address: walletC,
    alias: 'Current shared value',
    note: 'must survive restart',
    updatedAt: 900
  });
  robinhood.close();
  bsc.close();
  robinhood = null;
  bsc = null;

  const local = new DatabaseSync(files.robinhood);
  local.prepare(`
    UPDATE wallet_annotations
    SET alias = ?, note = ?, updated_at = ?
    WHERE address = ?
  `).run('Stale local value', 'must never be reimported', 9_999, walletC);
  local.close();

  robinhood = openStore(files.robinhood, 'robinhood', 'Robinhood', files.shared);
  bsc = openStore(files.bsc, 'bsc', 'BSC', files.shared);
  assert.equal(robinhood.getWalletAnnotation(walletC)?.alias, 'Current shared value');
  assert.equal(bsc.getWalletAnnotation(walletC)?.note, 'must survive restart');
});

test('calculates buy frequency from shared addresses and chain-local monitor events', (t) => {
  const files = createFiles(t, 'shared-evm-frequency-');
  const robinhood = openStore(files.robinhood, 'robinhood', 'Robinhood', files.shared);
  const bsc = openStore(files.bsc, 'bsc', 'BSC', files.shared);
  t.after(() => {
    robinhood.close();
    bsc.close();
  });
  const day = Math.floor(Date.parse('2026-07-20T04:00:00.000Z') / 1000);
  const asOf = day + 3_600;

  robinhood.upsertWalletAnnotation({
    address: walletF,
    alias: 'Shared frequency wallet',
    createdAt: day - 86_400,
    updatedAt: day - 86_400
  });
  assert.equal(bsc.getWalletAnnotation(walletF)?.alias, 'Shared frequency wallet');

  insertBuy(robinhood, { walletAddress: walletF, tokenAddress: tokenA, timestamp: day + 10, sequence: 101 });
  insertBuy(robinhood, { walletAddress: walletF, tokenAddress: tokenB, timestamp: day + 20, sequence: 102 });
  insertBuy(bsc, { walletAddress: walletF, tokenAddress: tokenC, timestamp: day + 30, sequence: 201 });

  const robinhoodStats = robinhood.listWalletBuyFrequencyStats({ asOf, address: walletF })[0];
  const bscStats = bsc.listWalletBuyFrequencyStats({ asOf, address: walletF })[0];

  assert.equal(robinhoodStats.distinctTokenDayCount, 2);
  assert.equal(robinhoodStats.distinctTokens, 2);
  assert.equal(robinhoodStats.averageDailyDistinctTokens, 2);
  assert.equal(bscStats.distinctTokenDayCount, 1);
  assert.equal(bscStats.distinctTokens, 1);
  assert.equal(bscStats.averageDailyDistinctTokens, 1);
});

test('serializes concurrent Robinhood and BSC writes without losing shared addresses', async (t) => {
  const files = createFiles(t, 'shared-evm-concurrent-');
  const storeModule = new URL('../src/robinhood/store.js', import.meta.url).href;
  const script = `
    const { createRobinhoodStore } = await import(process.argv[1]);
    const [, , localFile, sharedFile, chainId, prefix] = process.argv;
    const store = createRobinhoodStore(localFile, {
      chainId,
      chainLabel: chainId,
      walletLibraryFile: sharedFile
    });
    for (let index = 0; index < 30; index += 1) {
      const value = BigInt(prefix) * 1000n + BigInt(index) + 1n;
      const address = '0x' + value.toString(16).padStart(40, '0');
      store.upsertWalletAnnotation({ address, note: chainId + '-' + index, updatedAt: 1000 + index });
    }
    store.close();
  `;

  await Promise.all([
    execFileAsync(process.execPath, [
      '--input-type=module',
      '-e',
      script,
      storeModule,
      files.robinhood,
      files.shared,
      'robinhood',
      '1'
    ]),
    execFileAsync(process.execPath, [
      '--input-type=module',
      '-e',
      script,
      storeModule,
      files.bsc,
      files.shared,
      'bsc',
      '2'
    ])
  ]);

  const verifier = openStore(path.join(files.directory, 'verify.sqlite'), 'robinhood', 'Robinhood', files.shared);
  t.after(() => verifier.close());
  const annotations = verifier.listWalletAnnotations();
  assert.equal(annotations.length, 60);
  assert.equal(new Set(annotations.map((annotation) => annotation.address)).size, 60);
  assert.equal(annotations.filter((annotation) => annotation.note.startsWith('robinhood-')).length, 30);
  assert.equal(annotations.filter((annotation) => annotation.note.startsWith('bsc-')).length, 30);
});
