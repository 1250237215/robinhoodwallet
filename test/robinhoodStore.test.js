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
