import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { DatabaseSync } from 'node:sqlite';

import { createRobinhoodStore } from '../src/robinhood/store.js';

const safeMonitorRules = {
  buy: { enabled: true, sound: false, bark: false },
  sell: { enabled: false, sound: false, bark: false },
  transfer: { enabled: false, sound: false, bark: false },
  token_create: { enabled: false, sound: false, bark: false }
};

test('persists tokens, actions, wallet summaries and metadata idempotently', () => {
  const store = createRobinhoodStore(':memory:');
  store.upsertToken({
    address: '0x0000000000000000000000000000000000000001',
    symbol: 'ONE',
    name: 'One',
    updatedAt: 1
  });
  store.replaceTokenActions('0x0000000000000000000000000000000000000001', [
    {
      txHash: '0xabc',
      logIndex: 1,
      wallet: '0x0000000000000000000000000000000000000002',
      side: 'buy',
      tokenAmount: 10,
      quoteAmount: 1,
      priceNative: 0.1,
      blockNumber: 1,
      blockTimestamp: 2,
      poolAddress: '0x0000000000000000000000000000000000000003'
    }
  ]);
  store.replaceTokenActions('0x0000000000000000000000000000000000000001', []);
  store.setMeta('last_refresh', '123');

  assert.equal(store.listTokens().length, 1);
  assert.equal(store.listActionsForToken('0x0000000000000000000000000000000000000001').length, 0);
  assert.equal(store.getMeta('last_refresh'), '123');
  store.close();
});

test('persists wallet curation independently and deletes annotations idempotently', (t) => {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'robinhood-store-'));
  const filename = path.join(directory, 'radar.sqlite');
  t.after(() => fs.rmSync(directory, { recursive: true, force: true }));

  let store = createRobinhoodStore(filename);
  store.upsertWalletAnnotation({
    address: '0x0000000000000000000000000000000000000002',
    alias: 'Desk alpha',
    note: 'Review before following',
    tags: ['repeat-hit', 'Repeat-Hit', 'swing'],
    status: 'watch',
    classificationOverride: 'realized',
    monitorTier: 'high_frequency',
    monitorRules: {
      buy: { sound: true },
      sell: { enabled: true, bark: true }
    },
    createdAt: 100,
    updatedAt: 101
  });
  store.upsertWalletAnnotation({
    address: '0x0000000000000000000000000000000000000002',
    note: 'Updated note',
    updatedAt: 102
  });
  store.close();

  store = createRobinhoodStore(filename);
  const annotation = store.getWalletAnnotation('0x0000000000000000000000000000000000000002');
  assert.equal(annotation.alias, 'Desk alpha');
  assert.equal(annotation.note, 'Updated note');
  assert.deepEqual(annotation.tags, ['repeat-hit', 'Repeat-Hit', 'swing']);
  assert.equal(annotation.status, 'watch');
  assert.equal(annotation.classificationOverride, 'realized');
  assert.equal(annotation.monitorTier, 'high_frequency');
  assert.deepEqual(annotation.monitorRules, {
    ...safeMonitorRules,
    buy: { enabled: true, sound: true, bark: false },
    sell: { enabled: true, sound: false, bark: true }
  });
  assert.equal(annotation.createdAt, 100);
  assert.equal(annotation.updatedAt, 102);
  assert.equal(store.listWalletAnnotations().length, 1);
  assert.equal(store.deleteWalletAnnotation(annotation.address), true);
  assert.equal(store.deleteWalletAnnotation(annotation.address), false);
  store.close();
});

test('compacts legacy generated profit-rank aliases across stored wallet data', (t) => {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'robinhood-wallet-alias-migration-'));
  const filename = path.join(directory, 'radar.sqlite');
  t.after(() => fs.rmSync(directory, { recursive: true, force: true }));
  const rankedWallet = '0x0000000000000000000000000000000000000002';
  const customWallet = '0x0000000000000000000000000000000000000003';
  const token = '0x0000000000000000000000000000000000000004';

  let store = createRobinhoodStore(filename);
  store.upsertWalletAnnotation({
    address: rankedWallet,
    alias: 'HOODIE 盈利榜第 2 名',
    createdAt: 100,
    updatedAt: 100
  });
  store.upsertWalletAnnotation({
    address: customWallet,
    alias: '我手工填写的名字',
    createdAt: 100,
    updatedAt: 100
  });
  store.replaceWalletSummaries([
    { address: rankedWallet, score: 10, suggestedAlias: 'HOODIE 盈利榜第 2 名' }
  ]);
  store.insertMonitorEvent({
    walletAddress: rankedWallet,
    walletAlias: 'HOODIE 盈利榜第 2 名',
    tokenAddress: token,
    tokenSymbol: 'HOODIE',
    tokenName: 'Hoodie',
    tokenAmount: '1',
    rawTokenAmount: '1',
    tokenDecimals: 18,
    txHash: '0xabc',
    logIndex: 1,
    blockNumber: 10,
    blockTimestamp: 100,
    detectedAt: 101
  });
  store.db.prepare('DELETE FROM metadata WHERE key = ?').run('robinhood:compact_profit_rank_aliases_v1');
  store.close();

  store = createRobinhoodStore(filename);
  assert.equal(store.getWalletAnnotation(rankedWallet).alias, 'HOODIE 2');
  assert.equal(store.getWalletAnnotation(customWallet).alias, '我手工填写的名字');
  assert.equal(store.listWalletSummaries()[0].suggestedAlias, 'HOODIE 2');
  assert.equal(store.listMonitorEvents()[0].walletAlias, 'HOODIE 2');
  assert.equal(store.getMeta('robinhood:compact_profit_rank_aliases_v1'), '1');
  store.close();
});

test('migrates legacy wallet annotations with a persistent watch tier', (t) => {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'robinhood-wallet-tier-migration-'));
  const filename = path.join(directory, 'radar.sqlite');
  t.after(() => fs.rmSync(directory, { recursive: true, force: true }));
  const address = '0x0000000000000000000000000000000000000002';
  const unprofiledAddress = '0x0000000000000000000000000000000000000003';

  const legacy = new DatabaseSync(filename);
  legacy.exec(`
    CREATE TABLE wallet_annotations (
      address TEXT PRIMARY KEY,
      alias TEXT NOT NULL DEFAULT '',
      note TEXT NOT NULL DEFAULT '',
      tags TEXT NOT NULL DEFAULT '[]',
      status TEXT NOT NULL DEFAULT 'active',
      classification_override TEXT,
      created_at INTEGER NOT NULL,
      updated_at INTEGER NOT NULL
    )
  `);
  legacy.prepare(`
    INSERT INTO wallet_annotations(
      address, alias, note, tags, status, classification_override, created_at, updated_at
    ) VALUES (?, ?, ?, ?, ?, ?, ?, ?)
  `).run(address, 'Legacy', '', '[]', 'active', null, 100, 100);
  legacy.prepare(`
    INSERT INTO wallet_annotations(
      address, alias, note, tags, status, classification_override, created_at, updated_at
    ) VALUES (?, ?, ?, ?, ?, ?, ?, ?)
  `).run(unprofiledAddress, 'No summary', '', '[]', 'active', null, 100, 100);
  legacy.close();

  let store = createRobinhoodStore(filename);
  assert.equal(
    store.db.prepare('PRAGMA table_info(wallet_annotations)').all().some((column) => column.name === 'monitor_tier'),
    true
  );
  assert.equal(
    store.db.prepare('PRAGMA table_info(wallet_annotations)').all().some((column) => column.name === 'monitor_rules'),
    true
  );
  assert.equal(store.getWalletAnnotation(address).monitorTier, 'watch');
  assert.equal(store.getWalletAnnotation(unprofiledAddress).monitorTier, 'watch');
  assert.deepEqual(store.getWalletAnnotation(address).monitorRules, safeMonitorRules);
  store.upsertWalletAnnotation({ address, monitorTier: 'high_frequency', updatedAt: 101 });
  store.db.prepare('UPDATE wallet_annotations SET monitor_rules = ? WHERE address = ?').run('{bad', address);
  store.close();

  store = createRobinhoodStore(filename);
  assert.equal(store.getWalletAnnotation(address).monitorTier, 'high_frequency');
  assert.deepEqual(store.getWalletAnnotation(address).monitorRules, safeMonitorRules);
  assert.throws(
    () => store.upsertWalletAnnotation({ address, monitorTier: 'vip', updatedAt: 102 }),
    /Unsupported wallet monitor tier/
  );
  store.close();
});

test('migrates legacy monitor events to buy/token and persists generic event fields', (t) => {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'robinhood-monitor-event-migration-'));
  const filename = path.join(directory, 'radar.sqlite');
  t.after(() => fs.rmSync(directory, { recursive: true, force: true }));
  const wallet = '0x0000000000000000000000000000000000000002';
  const token = '0x0000000000000000000000000000000000000003';
  const counterparty = '0x0000000000000000000000000000000000000004';

  const legacy = new DatabaseSync(filename);
  legacy.exec(`
    CREATE TABLE monitor_token_metadata (
      address TEXT PRIMARY KEY,
      symbol TEXT NOT NULL,
      name TEXT NOT NULL,
      decimals INTEGER NOT NULL,
      complete INTEGER NOT NULL DEFAULT 0,
      updated_at INTEGER NOT NULL
    );
    INSERT INTO monitor_token_metadata(address, symbol, name, decimals, complete, updated_at)
    VALUES ('${token}', 'OLD', 'Old token', 18, 1, 99);
    CREATE TABLE monitor_events (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      wallet_address TEXT NOT NULL,
      wallet_alias TEXT NOT NULL DEFAULT '',
      token_address TEXT NOT NULL,
      token_symbol TEXT NOT NULL,
      token_name TEXT NOT NULL,
      token_amount TEXT NOT NULL,
      raw_token_amount TEXT NOT NULL,
      token_decimals INTEGER NOT NULL,
      tx_hash TEXT NOT NULL,
      log_index INTEGER NOT NULL,
      block_number INTEGER NOT NULL,
      block_timestamp INTEGER NOT NULL,
      detected_at INTEGER NOT NULL,
      UNIQUE(tx_hash, log_index)
    )
  `);
  legacy.prepare(`
    INSERT INTO monitor_events(
      wallet_address, wallet_alias, token_address, token_symbol, token_name,
      token_amount, raw_token_amount, token_decimals, tx_hash, log_index,
      block_number, block_timestamp, detected_at
    ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
  `).run(wallet, 'Legacy', token, 'OLD', 'Old token', '1', '1', 18, '0xaaa', 1, 10, 100, 101);
  legacy.close();

  const store = createRobinhoodStore(filename);
  const [oldEvent] = store.listMonitorEvents();
  assert.equal(oldEvent.eventType, 'buy');
  assert.equal(oldEvent.assetType, 'token');
  assert.equal(oldEvent.counterpartyAddress, '');
  assert.equal(oldEvent.platform, '');
  assert.equal(oldEvent.soundAlert, false);
  assert.equal(oldEvent.barkAlert, false);
  assert.equal(oldEvent.marketCapUsd, null);
  assert.equal(oldEvent.tokenCreationTimestamp, null);
  assert.equal(oldEvent.marketDataAt, null);
  assert.deepEqual(store.getMonitorTokenMetadata(token), {
    address: token,
    symbol: 'OLD',
    name: 'Old token',
    decimals: 18,
    complete: true,
    marketCapUsd: null,
    tokenCreationTimestamp: null,
    marketDataAt: null,
    updatedAt: 99
  });

  const inserted = store.insertMonitorEvent({
    eventType: 'sell',
    assetType: 'erc20',
    walletAddress: wallet,
    walletAlias: 'Desk',
    counterpartyAddress: counterparty.toUpperCase().replace('0X', '0x'),
    platform: 'RobinSwap',
    tokenAddress: token,
    tokenSymbol: 'NEW',
    tokenName: 'New token',
    tokenAmount: '2',
    rawTokenAmount: '2',
    tokenDecimals: 18,
    txHash: '0xbbb',
    logIndex: 2,
    blockNumber: 11,
    blockTimestamp: 102,
    detectedAt: 103,
    soundAlert: true,
    barkAlert: true
  });
  assert.equal(inserted.inserted, true);
  assert.deepEqual(
    {
      eventType: inserted.event.eventType,
      assetType: inserted.event.assetType,
      counterpartyAddress: inserted.event.counterpartyAddress,
      platform: inserted.event.platform,
      soundAlert: inserted.event.soundAlert,
      barkAlert: inserted.event.barkAlert
    },
    {
      eventType: 'sell',
      assetType: 'erc20',
      counterpartyAddress: counterparty,
      platform: 'RobinSwap',
      soundAlert: true,
      barkAlert: true
    }
  );
  assert.throws(() => store.insertMonitorEvent({ eventType: 'mint' }), /Unsupported monitor event type/);
  store.close();
});

test('aggregates monitored daily distinct-token buys with Beijing-day and observation coverage', () => {
  const store = createRobinhoodStore(':memory:');
  const walletA = '0xaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa';
  const walletB = '0xbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb';
  const walletC = '0xcccccccccccccccccccccccccccccccccccccccc';
  const walletD = '0xdddddddddddddddddddddddddddddddddddddddd';
  const tokenA = '0x1111111111111111111111111111111111111111';
  const tokenB = '0x2222222222222222222222222222222222222222';
  const tokenC = '0x3333333333333333333333333333333333333333';
  const seconds = (value) => Math.floor(Date.parse(value) / 1000);
  const asOf = seconds('2026-07-13T04:00:00.000Z');
  let sequence = 0;
  const insert = ({ walletAddress, tokenAddress, at, eventType = 'buy' }) => {
    sequence += 1;
    store.insertMonitorEvent({
      eventType,
      walletAddress,
      walletAlias: walletAddress.slice(2, 6),
      tokenAddress,
      tokenSymbol: 'TOKEN',
      tokenName: 'Token',
      tokenAmount: '1',
      rawTokenAmount: '1',
      tokenDecimals: 18,
      txHash: `0x${sequence.toString(16).padStart(64, '0')}`,
      logIndex: sequence,
      blockNumber: sequence,
      blockTimestamp: seconds(at),
      detectedAt: seconds(at)
    });
  };

  store.upsertWalletAnnotation({
    address: walletA,
    createdAt: seconds('2026-07-10T00:00:00.000Z'),
    updatedAt: asOf
  });
  store.upsertWalletAnnotation({
    address: walletB,
    createdAt: seconds('2026-07-12T16:30:00.000Z'),
    updatedAt: asOf
  });
  store.upsertWalletAnnotation({
    address: walletC,
    createdAt: seconds('2026-07-10T00:00:00.000Z'),
    updatedAt: asOf
  });
  store.upsertWalletAnnotation({
    address: walletD,
    createdAt: seconds('2026-07-14T00:00:00.000Z'),
    updatedAt: asOf
  });

  insert({ walletAddress: walletA, tokenAddress: tokenA, at: '2026-07-10T16:05:00.000Z' });
  insert({ walletAddress: walletA, tokenAddress: tokenA, at: '2026-07-10T17:00:00.000Z' });
  insert({ walletAddress: walletA, tokenAddress: tokenB, at: '2026-07-10T18:00:00.000Z' });
  insert({ walletAddress: walletA, tokenAddress: tokenC, at: '2026-07-11T15:59:00.000Z' });
  insert({ walletAddress: walletA, tokenAddress: tokenC, at: '2026-07-11T16:01:00.000Z' });
  insert({ walletAddress: walletA, tokenAddress: tokenA, at: '2026-07-12T16:01:00.000Z' });
  insert({
    walletAddress: walletA,
    tokenAddress: tokenC,
    at: '2026-07-10T19:00:00.000Z',
    eventType: 'sell'
  });
  insert({
    walletAddress: walletA,
    tokenAddress: tokenC,
    at: '2026-07-10T20:00:00.000Z',
    eventType: 'transfer'
  });
  insert({ walletAddress: walletB, tokenAddress: tokenA, at: '2026-07-12T15:50:00.000Z' });
  insert({ walletAddress: walletB, tokenAddress: tokenB, at: '2026-07-12T17:00:00.000Z' });

  const stats = new Map(
    store.listWalletBuyFrequencyStats({ asOf }).map((record) => [record.address, record])
  );
  assert.deepEqual(
    {
      averageDailyDistinctTokens: stats.get(walletA).averageDailyDistinctTokens,
      distinctTokenDayCount: stats.get(walletA).distinctTokenDayCount,
      distinctTokens: stats.get(walletA).distinctTokens,
      activeBuyDays: stats.get(walletA).activeBuyDays,
      maxDailyDistinctTokens: stats.get(walletA).maxDailyDistinctTokens,
      observedDays: stats.get(walletA).observedDays
    },
    {
      averageDailyDistinctTokens: 5 / 3,
      distinctTokenDayCount: 5,
      distinctTokens: 3,
      activeBuyDays: 3,
      maxDailyDistinctTokens: 3,
      observedDays: 3
    }
  );
  assert.equal(stats.get(walletA).observedFrom, seconds('2026-07-10T16:05:00.000Z'));
  assert.equal(stats.get(walletA).timezone, 'Asia/Shanghai');
  assert.equal(stats.get(walletA).source, 'monitor_events');
  assert.equal(stats.get(walletA).partialHistory, true);
  assert.deepEqual(
    {
      averageDailyDistinctTokens: stats.get(walletB).averageDailyDistinctTokens,
      distinctTokenDayCount: stats.get(walletB).distinctTokenDayCount,
      observedDays: stats.get(walletB).observedDays,
      observedFrom: stats.get(walletB).observedFrom
    },
    {
      averageDailyDistinctTokens: 1,
      distinctTokenDayCount: 1,
      observedDays: 1,
      observedFrom: seconds('2026-07-12T16:30:00.000Z')
    }
  );
  assert.equal(stats.get(walletC).averageDailyDistinctTokens, 0);
  assert.equal(stats.get(walletC).observedDays, 3);
  assert.equal(stats.get(walletD).averageDailyDistinctTokens, 0);
  assert.equal(stats.get(walletD).observedDays, 1);
  assert.deepEqual(
    store.listWalletBuyFrequencyStats({ asOf, address: walletB }).map((record) => record.address),
    [walletB]
  );
  assert.throws(
    () => store.listWalletBuyFrequencyStats({ asOf, address: 'not-an-address' }),
    /Invalid wallet address/
  );
  store.close();
});

test('persists Bark targets and their delivery status across restarts', (t) => {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'robinhood-bark-store-'));
  const filename = path.join(directory, 'radar.sqlite');
  t.after(() => fs.rmSync(directory, { recursive: true, force: true }));

  let store = createRobinhoodStore(filename);
  const created = store.createMonitorBarkTarget({
    label: 'Phone',
    endpoint: 'https://api.day.app/device_key',
    enabled: true,
    createdAt: 100,
    updatedAt: 100
  });
  store.updateMonitorBarkTarget(created.id, {
    enabled: false,
    lastSuccessAt: 101,
    lastErrorAt: null,
    lastError: '',
    updatedAt: 102
  });
  store.close();

  store = createRobinhoodStore(filename);
  const [target] = store.listMonitorBarkTargets();
  assert.equal(target.endpoint, 'https://api.day.app/device_key');
  assert.equal(target.enabled, false);
  assert.equal(target.lastSuccessAt, 101);
  assert.equal(target.updatedAt, 102);
  assert.equal(store.deleteMonitorBarkTarget(target.id), true);
  assert.equal(store.deleteMonitorBarkTarget(target.id), false);
  store.close();
});

test('persists alerted token CAs idempotently across restarts', (t) => {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'robinhood-monitor-alert-store-'));
  const filename = path.join(directory, 'radar.sqlite');
  t.after(() => fs.rmSync(directory, { recursive: true, force: true }));
  const tokenAddress = '0x1111111111111111111111111111111111111111';

  let store = createRobinhoodStore(filename);
  assert.deepEqual(store.recordMonitorTokenAlert(tokenAddress, 100), {
    inserted: true,
    tokenAddress,
    alertedAt: 100
  });
  assert.deepEqual(store.recordMonitorTokenAlert(tokenAddress.toUpperCase(), 200), {
    inserted: false,
    tokenAddress,
    alertedAt: 100
  });
  store.close();

  store = createRobinhoodStore(filename);
  assert.deepEqual(store.listMonitorTokenAlerts(), [{ tokenAddress, alertedAt: 100 }]);
  assert.throws(() => store.recordMonitorTokenAlert('not-an-address'), /Invalid monitor token address/);
  store.close();
});
