import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';

import { createBaseRuntimeConfig } from '../src/base/server.js';
import { createBscRuntimeConfig } from '../src/bsc/server.js';
import { RobinhoodWalletMonitor } from '../src/robinhood/monitor.js';
import { createRobinhoodConfig } from '../src/robinhood/config.js';
import { createRobinhoodStore } from '../src/robinhood/store.js';
import { createSolanaConfig, SolanaRuntimeMonitor } from '../src/solana/server.js';

function testFiles(t) {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'shared-bark-'));
  t.after(() => fs.rmSync(directory, { recursive: true, force: true }));
  return {
    bark: path.join(directory, 'bark.sqlite'),
    robinhood: path.join(directory, 'robinhood.sqlite'),
    base: path.join(directory, 'base.sqlite'),
    bsc: path.join(directory, 'bsc.sqlite'),
    solana: path.join(directory, 'solana.sqlite')
  };
}

function openStore(filename, chainId, barkLibraryFile = null) {
  return createRobinhoodStore(filename, {
    chainId,
    chainLabel: chainId,
    barkLibraryFile
  });
}

function fakeEvmRpc() {
  return {
    async getBlockNumber() {
      return 0;
    },
    async getLogs() {
      return [];
    }
  };
}

function seedLegacyBark(filename, chainId, {
  endpoint,
  label,
  enabled = true,
  updatedAt,
  sound,
  volume,
  metadataPrefix = chainId
}) {
  const store = openStore(filename, chainId);
  store.createMonitorBarkTarget({
    endpoint,
    label,
    enabled,
    createdAt: updatedAt - 10,
    updatedAt
  });
  store.setMeta(`${metadataPrefix}:monitor:bark-sound`, sound);
  store.setMeta(`${metadataPrefix}:monitor:bark-volume`, String(volume));
  store.close();
}

function runConcurrentWriter({ chainFile, barkFile, chainId, prefix, count }) {
  const storeModule = new URL('../src/robinhood/store.js', import.meta.url).href;
  const source = `
    import { createRobinhoodStore } from ${JSON.stringify(storeModule)};
    const store = createRobinhoodStore(process.env.CHAIN_FILE, {
      chainId: process.env.CHAIN_ID,
      barkLibraryFile: process.env.BARK_FILE
    });
    for (let index = 0; index < Number(process.env.TARGET_COUNT); index += 1) {
      store.createMonitorBarkTarget({
        endpoint: \`https://api.day.app/\${process.env.TARGET_PREFIX}_\${String(index).padStart(3, '0')}_device\`,
        label: \`\${process.env.TARGET_PREFIX} \${index}\`,
        enabled: true,
        createdAt: 1_800_000_000 + index,
        updatedAt: 1_800_000_000 + index
      });
    }
    store.close();
  `;
  return new Promise((resolve, reject) => {
    const child = spawn(process.execPath, ['--input-type=module', '-e', source], {
      cwd: path.resolve('.'),
      env: {
        ...process.env,
        CHAIN_FILE: chainFile,
        BARK_FILE: barkFile,
        CHAIN_ID: chainId,
        TARGET_PREFIX: prefix,
        TARGET_COUNT: String(count)
      },
      stdio: ['ignore', 'pipe', 'pipe']
    });
    let stdout = '';
    let stderr = '';
    child.stdout.setEncoding('utf8');
    child.stderr.setEncoding('utf8');
    child.stdout.on('data', (chunk) => { stdout += chunk; });
    child.stderr.on('data', (chunk) => { stderr += chunk; });
    child.once('error', reject);
    child.once('close', (code) => {
      if (code === 0) resolve();
      else reject(new Error(`Bark writer exited ${code}: ${stdout}${stderr}`));
    });
  });
}

test('stores Bark test audits in the shared database without exposing them through the UI API', (t) => {
  const files = testFiles(t);
  const store = openStore(files.robinhood, 'robinhood', files.bark);
  t.after(() => store.close());

  store.recordBarkTestAudit({
    requestId: 'audit-request-1',
    targetId: 7,
    targetLabel: 'My iPhone',
    clientIp: '203.0.113.24',
    userAgent: 'Mobile Safari',
    deviceType: 'mobile',
    startedAtMs: 1_723_456_789_000,
    completedAtMs: 1_723_456_789_125,
    success: true
  });

  const row = store.db.prepare('SELECT * FROM bark_library.bark_test_audit').get();
  assert.equal(row.request_id, 'audit-request-1');
  assert.equal(row.chain_id, 'robinhood');
  assert.equal(row.target_id, 7);
  assert.equal(row.target_label, 'My iPhone');
  assert.equal(row.client_ip, '203.0.113.24');
  assert.equal(row.device_type, 'mobile');
  assert.equal(row.completed_at_ms - row.started_at_ms, 125);
  assert.equal(row.success, 1);
});

test('shares Bark targets and settings immediately across all chain stores', (t) => {
  const files = testFiles(t);
  const stores = [
    openStore(files.robinhood, 'robinhood', files.bark),
    openStore(files.base, 'base', files.bark),
    openStore(files.bsc, 'bsc', files.bark),
    openStore(files.solana, 'solana', files.bark)
  ];
  t.after(() => stores.forEach((store) => store.close()));
  const [robinhood, base, bsc, solana] = stores;

  const target = robinhood.createMonitorBarkTarget({
    endpoint: 'https://api.day.app/device_key_123456',
    label: '1874',
    enabled: true,
    createdAt: 1_800_000_000,
    updatedAt: 1_800_000_000
  });
  assert.equal(base.getMonitorBarkTarget(target.id)?.label, '1874');
  assert.equal(bsc.listMonitorBarkTargets().length, 1);
  assert.equal(solana.listMonitorBarkTargets().length, 1);

  bsc.updateMonitorBarkTarget(target.id, { enabled: false, updatedAt: 1_800_000_001 });
  assert.equal(robinhood.getMonitorBarkTarget(target.id)?.enabled, false);
  assert.equal(base.getMonitorBarkTarget(target.id)?.enabled, false);

  robinhood.setMeta('robinhood:monitor:bark-sound', 'typewriters');
  robinhood.setMeta('robinhood:monitor:bark-volume', '7');
  assert.equal(base.getMeta('robinhood:monitor:bark-sound'), 'typewriters');
  assert.equal(bsc.getMeta('robinhood:monitor:bark-volume'), '7');
  assert.equal(solana.getMeta('solana:monitor:bark-sound'), 'typewriters');
  assert.equal(solana.getMeta('solana:monitor:bark-volume'), '7');

  base.setMonitorBarkFeatureState('fomo_ca', false);
  assert.equal(robinhood.listMonitorBarkFeatureStates().fomo_ca, false);
  assert.equal(bsc.listMonitorBarkFeatureStates().fomo_ca, false);
  assert.equal(solana.listMonitorBarkFeatureStates().fomo_ca, false);
  solana.setMonitorBarkFeatureState('fomo_ca', true);
  assert.equal(robinhood.listMonitorBarkFeatureStates().fomo_ca, true);

  solana.deleteMonitorBarkTarget(target.id);
  assert.deepEqual(robinhood.listMonitorBarkTargets(), []);
  assert.deepEqual(base.listMonitorBarkTargets(), []);
  assert.deepEqual(bsc.listMonitorBarkTargets(), []);
});

test('migrates legacy per-chain Bark data once and never resurrects a deleted target', (t) => {
  const files = testFiles(t);
  const legacyRobinhood = openStore(files.robinhood, 'robinhood');
  legacyRobinhood.createMonitorBarkTarget({
    endpoint: 'https://api.day.app/robinhood_device_key',
    label: 'Robinhood phone',
    enabled: true,
    createdAt: 100,
    updatedAt: 200
  });
  legacyRobinhood.setMeta('robinhood:monitor:bark-sound', 'typewriters');
  legacyRobinhood.setMeta('robinhood:monitor:bark-volume', '7');
  legacyRobinhood.close();

  const legacySolana = openStore(files.solana, 'solana');
  legacySolana.createMonitorBarkTarget({
    endpoint: 'https://api.day.app/solana_device_key',
    label: 'Solana phone',
    enabled: false,
    createdAt: 110,
    updatedAt: 210
  });
  legacySolana.setMeta('solana:monitor:bark-sound', 'bell');
  legacySolana.setMeta('solana:monitor:bark-volume', '3');
  legacySolana.close();

  const solana = openStore(files.solana, 'solana', files.bark);
  assert.equal(solana.listMonitorBarkTargets().length, 1);
  assert.equal(solana.getMeta('solana:monitor:bark-sound'), 'bell');
  const robinhood = openStore(files.robinhood, 'robinhood', files.bark);
  assert.equal(robinhood.listMonitorBarkTargets().length, 2);
  assert.equal(robinhood.getMeta('robinhood:monitor:bark-sound'), 'typewriters');
  assert.equal(robinhood.getMeta('robinhood:monitor:bark-volume'), '7');

  const migratedRobinhoodTarget = robinhood.listMonitorBarkTargets()
    .find((target) => target.endpoint.includes('robinhood_device_key'));
  assert.ok(migratedRobinhoodTarget);
  assert.equal(robinhood.deleteMonitorBarkTarget(migratedRobinhoodTarget.id), true);
  robinhood.close();
  const reopened = openStore(files.robinhood, 'robinhood', files.bark);
  assert.equal(
    reopened.listMonitorBarkTargets().some((target) => target.endpoint.includes('robinhood_device_key')),
    false
  );
  reopened.close();
  solana.close();
});

test('a chain migrating late cannot resurrect a shared Bark target deleted earlier', (t) => {
  const files = testFiles(t);
  const endpoint = 'https://api.day.app/deleted_shared_device';
  seedLegacyBark(files.robinhood, 'robinhood', {
    endpoint,
    label: 'Robinhood legacy target',
    updatedAt: 200,
    sound: 'typewriters',
    volume: 7
  });
  seedLegacyBark(files.base, 'base', {
    endpoint,
    label: 'Base legacy target',
    updatedAt: 300,
    sound: 'bell',
    volume: 3,
    metadataPrefix: 'robinhood'
  });

  const robinhood = openStore(files.robinhood, 'robinhood', files.bark);
  t.after(() => robinhood.close());
  const migrated = robinhood.listMonitorBarkTargets()[0];
  assert.ok(migrated);
  assert.equal(robinhood.deleteMonitorBarkTarget(migrated.id), true);
  assert.deepEqual(robinhood.listMonitorBarkTargets(), []);

  const lateBase = openStore(files.base, 'base', files.bark);
  t.after(() => lateBase.close());
  assert.deepEqual(lateBase.listMonitorBarkTargets(), []);

  const restored = lateBase.createMonitorBarkTarget({
    endpoint,
    label: 'Explicitly restored by the user',
    enabled: true,
    createdAt: 400,
    updatedAt: 400
  });
  assert.equal(robinhood.getMonitorBarkTarget(restored.id)?.label, 'Explicitly restored by the user');
});

test('legacy migration resolves duplicates and id collisions deterministically in reverse startup order', (t) => {
  const files = testFiles(t);
  const sharedEndpoint = 'https://api.day.app/shared_device_key';
  seedLegacyBark(files.robinhood, 'robinhood', {
    endpoint: sharedEndpoint,
    label: 'Robinhood wins equal timestamp',
    updatedAt: 300,
    sound: 'typewriters',
    volume: 7
  });
  seedLegacyBark(files.base, 'base', {
    endpoint: 'https://api.day.app/base_device_key',
    label: 'Base target with colliding legacy id',
    updatedAt: 100,
    sound: 'chime',
    volume: 4,
    metadataPrefix: 'robinhood'
  });
  seedLegacyBark(files.bsc, 'bsc', {
    endpoint: sharedEndpoint,
    label: 'BSC duplicate',
    enabled: false,
    updatedAt: 300,
    sound: 'glass',
    volume: 5,
    metadataPrefix: 'robinhood'
  });
  seedLegacyBark(files.solana, 'solana', {
    endpoint: 'https://api.day.app/solana_device_key',
    label: 'Solana target with colliding legacy id',
    updatedAt: 200,
    sound: 'bell',
    volume: 3
  });

  const stores = [
    openStore(files.solana, 'solana', files.bark),
    openStore(files.base, 'base', files.bark),
    openStore(files.bsc, 'bsc', files.bark),
    openStore(files.robinhood, 'robinhood', files.bark)
  ];
  t.after(() => stores.forEach((store) => store.close()));

  const targets = stores[0].listMonitorBarkTargets();
  assert.equal(targets.length, 3);
  assert.equal(new Set(targets.map((target) => target.id)).size, 3);
  assert.equal(new Set(targets.map((target) => target.endpoint)).size, 3);
  const sharedTarget = targets.find((target) => target.endpoint === sharedEndpoint);
  assert.ok(sharedTarget);
  assert.equal(sharedTarget.label, 'Robinhood wins equal timestamp');
  assert.equal(sharedTarget.enabled, true);
  for (const store of stores) {
    assert.equal(store.getMeta('robinhood:monitor:bark-sound'), 'typewriters');
    assert.equal(store.getMeta('solana:monitor:bark-volume'), '7');
  }
});

test('delivery status updates do not turn a lower-priority legacy target into a user override', (t) => {
  const files = testFiles(t);
  const endpoint = 'https://api.day.app/delivery_status_device';
  seedLegacyBark(files.robinhood, 'robinhood', {
    endpoint,
    label: 'Robinhood authoritative label',
    updatedAt: 300,
    sound: 'typewriters',
    volume: 7
  });
  seedLegacyBark(files.bsc, 'bsc', {
    endpoint,
    label: 'BSC lower-priority label',
    updatedAt: 300,
    sound: 'bell',
    volume: 3,
    metadataPrefix: 'robinhood'
  });

  const bsc = openStore(files.bsc, 'bsc', files.bark);
  t.after(() => bsc.close());
  const target = bsc.listMonitorBarkTargets()[0];
  bsc.updateMonitorBarkTarget(target.id, {
    lastSuccessAt: 999,
    lastErrorAt: null,
    lastError: '',
    updatedAt: 999
  });
  assert.equal(bsc.getMonitorBarkTarget(target.id)?.updatedAt, 300);

  const robinhood = openStore(files.robinhood, 'robinhood', files.bark);
  t.after(() => robinhood.close());
  const migrated = robinhood.getMonitorBarkTarget(target.id);
  assert.equal(migrated?.label, 'Robinhood authoritative label');
  assert.equal(migrated?.lastSuccessAt, null);
});

test('two processes can write distinct Bark targets concurrently without losing rows', async (t) => {
  const files = testFiles(t);
  await Promise.all([
    runConcurrentWriter({
      chainFile: files.robinhood,
      barkFile: files.bark,
      chainId: 'robinhood',
      prefix: 'robinhood',
      count: 30
    }),
    runConcurrentWriter({
      chainFile: files.base,
      barkFile: files.bark,
      chainId: 'base',
      prefix: 'base',
      count: 30
    })
  ]);

  const reader = openStore(files.bsc, 'bsc', files.bark);
  t.after(() => reader.close());
  const targets = reader.listMonitorBarkTargets();
  assert.equal(targets.length, 60);
  assert.equal(new Set(targets.map((target) => target.endpoint)).size, 60);
});

test('rejects Bark database paths that alias a chain or wallet database', (t) => {
  const files = testFiles(t);
  assert.throws(
    () => openStore(files.robinhood, 'robinhood', files.robinhood),
    /different from the chain data file/
  );
  const walletLibraryFile = path.join(path.dirname(files.bark), 'evm-wallets.sqlite');
  assert.throws(
    () => createRobinhoodStore(files.robinhood, {
      chainId: 'robinhood',
      walletLibraryFile,
      barkLibraryFile: walletLibraryFile
    }),
    /different from walletLibraryFile/
  );
});

test('running monitors refresh shared Bark sound and volume without a restart', (t) => {
  const files = testFiles(t);
  const robinhoodStore = openStore(files.robinhood, 'robinhood', files.bark);
  const solanaStore = openStore(files.solana, 'solana', files.bark);
  t.after(() => {
    robinhoodStore.close();
    solanaStore.close();
  });
  const barkTestCalls = [];
  const barkNotifier = {
    listTargets() {
      return [];
    },
    testTarget(id, settings) {
      barkTestCalls.push({ id, ...settings });
      return { id };
    }
  };
  const robinhoodMonitor = new RobinhoodWalletMonitor({
    store: robinhoodStore,
    rpcClient: fakeEvmRpc(),
    barkNotifier,
    noxaLaunchFactory: ''
  });
  const solanaMonitor = new SolanaRuntimeMonitor({
    store: solanaStore,
    barkNotifier,
    webhookMonitor: {
      async ingest() {
        return { acceptedSignatures: [], events: [] };
      },
      getHealth() {
        return { status: 'healthy', reasons: [] };
      }
    },
    heliusWebhookManager: {
      getHealth() {
        return { status: 'healthy', realtimeReady: true, reasons: [], synced: true };
      }
    }
  });
  t.after(() => {
    robinhoodMonitor.close();
    solanaMonitor.close();
  });

  robinhoodMonitor.updateSettings({ barkSound: 'chime', barkVolume: 9 });
  assert.equal(solanaMonitor.getSnapshot({ eventLimit: 0 }).settings.barkSound, 'chime');
  assert.equal(solanaMonitor.getSnapshot({ eventLimit: 0 }).settings.barkVolume, 9);
  solanaMonitor.testBarkTarget(11);
  assert.deepEqual(barkTestCalls.at(-1), { id: 11, sound: 'chime', volume: 9 });

  solanaMonitor.updateSettings({ barkSound: 'glass', barkVolume: 4 });
  assert.equal(robinhoodMonitor.getSnapshot({ eventLimit: 0 }).settings.barkSound, 'glass');
  assert.equal(robinhoodMonitor.getSnapshot({ eventLimit: 0 }).settings.barkVolume, 4);
  robinhoodMonitor.testBarkTarget(12);
  assert.deepEqual(barkTestCalls.at(-1), { id: 12, sound: 'glass', volume: 4 });
});

test('all runtime configs accept the same BARK_DATA_FILE path', () => {
  const barkDataFile = '/var/lib/robinhood-radar/bark.sqlite';
  assert.equal(createRobinhoodConfig({ BARK_DATA_FILE: barkDataFile }).barkDataFile, barkDataFile);
  assert.equal(createBaseRuntimeConfig({ BARK_DATA_FILE: barkDataFile }).barkDataFile, barkDataFile);
  assert.equal(createBscRuntimeConfig({ BARK_DATA_FILE: barkDataFile }).barkDataFile, barkDataFile);
  assert.equal(createSolanaConfig({ BARK_DATA_FILE: barkDataFile }).barkDataFile, barkDataFile);
});
