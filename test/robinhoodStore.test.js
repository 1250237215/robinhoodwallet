import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { DatabaseSync } from 'node:sqlite';

import { createRobinhoodStore } from '../src/robinhood/store.js';

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
  assert.equal(annotation.createdAt, 100);
  assert.equal(annotation.updatedAt, 102);
  assert.equal(store.listWalletAnnotations().length, 1);
  assert.equal(store.deleteWalletAnnotation(annotation.address), true);
  assert.equal(store.deleteWalletAnnotation(annotation.address), false);
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
  assert.equal(store.getWalletAnnotation(address).monitorTier, 'watch');
  assert.equal(store.getWalletAnnotation(unprofiledAddress).monitorTier, 'watch');
  store.upsertWalletAnnotation({ address, monitorTier: 'high_frequency', updatedAt: 101 });
  store.close();

  store = createRobinhoodStore(filename);
  assert.equal(store.getWalletAnnotation(address).monitorTier, 'high_frequency');
  assert.throws(
    () => store.upsertWalletAnnotation({ address, monitorTier: 'vip', updatedAt: 102 }),
    /Unsupported wallet monitor tier/
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
