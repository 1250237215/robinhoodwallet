import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import test from 'node:test';
import { fileURLToPath } from 'node:url';
import { build } from 'esbuild';

const packageJson = JSON.parse(fs.readFileSync(new URL('../package.json', import.meta.url), 'utf8'));
const caddy = fs.readFileSync(new URL('../deploy/Caddyfile.example', import.meta.url), 'utf8');
const installer = fs.readFileSync(new URL('../deploy/install-remote.sh', import.meta.url), 'utf8');
const robinhoodUnit = fs.readFileSync(new URL('../deploy/robinhood-radar.service', import.meta.url), 'utf8');
const baseUnit = fs.readFileSync(new URL('../deploy/base-radar.service', import.meta.url), 'utf8');
const solanaUnit = fs.readFileSync(new URL('../deploy/solana-radar.service', import.meta.url), 'utf8');
const installerPath = fileURLToPath(new URL('../deploy/install-remote.sh', import.meta.url));

function runInstallerHelper(helper, ...args) {
  const result = spawnSync(
    'bash',
    [
      '-c',
      'source "$1"; shift; "$@"',
      'installer-test',
      installerPath,
      helper,
      ...args
    ],
    { encoding: 'utf8' }
  );
  assert.equal(
    result.status,
    0,
    `installer helper ${helper} failed:\n${result.stdout}${result.stderr}`
  );
}

test('builds one standalone bundle for every isolated chain runtime', () => {
  assert.match(packageJson.scripts['build:all'], /build:robinhood.*build:base.*build:solana/);
  assert.match(packageJson.scripts['build:robinhood'], /src\/robinhood\/main\.js.*dist\/robinhood-server\.mjs/);
  assert.match(packageJson.scripts['build:base'], /src\/base\/server\.js.*dist\/base-server\.mjs/);
  assert.match(packageJson.scripts['build:solana'], /src\/solana\/server\.js.*dist\/solana-server\.mjs/);
});

test('Base and Solana production bundles cannot execute the Robinhood entrypoint', async () => {
  const robinhoodServer = fs.readFileSync(new URL('../src/robinhoodServer.js', import.meta.url), 'utf8');
  assert.doesNotMatch(robinhoodServer, /Robinhood smart money radar:/);
  assert.doesNotMatch(robinhoodServer, /pathToFileURL/);

  for (const [entryPoint, ownBanner] of [
    ['src/base/server.js', 'Base smart money radar API:'],
    ['src/solana/server.js', 'Solana smart money API:']
  ]) {
    const result = await build({
      entryPoints: [entryPoint],
      absWorkingDir: fileURLToPath(new URL('..', import.meta.url)),
      bundle: true,
      platform: 'node',
      format: 'esm',
      minify: true,
      write: false
    });
    const bundle = result.outputFiles[0].text;
    assert.match(bundle, new RegExp(ownBanner));
    assert.doesNotMatch(bundle, /Robinhood smart money radar:/);
  }
});

test('reverse proxy routes each chain API to its own process', () => {
  assert.match(caddy, /\/api\/robinhood\/\*[\s\S]*127\.0\.0\.1:18118/);
  assert.match(caddy, /\/api\/base\/\*[\s\S]*127\.0\.0\.1:18119/);
  assert.match(caddy, /\/api\/solana\/\*[\s\S]*127\.0\.0\.1:18120/);
  assert.match(caddy, /@solanaWebhook[\s\S]*monitor\/webhook[\s\S]*127\.0\.0\.1:18120/);
  assert.doesNotMatch(caddy, /basic_?auth|basicauth|RADAR_BASIC_AUTH_HASH/);
});

test('Base and Solana systemd units bind independent ports and databases', () => {
  assert.match(baseUnit, /Environment=BASE_PORT=18119/);
  assert.match(baseUnit, /Environment=BASE_DATA_FILE=\/var\/lib\/robinhood-radar\/base\.sqlite/);
  assert.match(baseUnit, /ExecStart=.*base-server\.mjs/);
  assert.match(solanaUnit, /Environment=SOLANA_PORT=18120/);
  assert.match(solanaUnit, /Environment=SOLANA_DATA_FILE=\/var\/lib\/robinhood-radar\/solana\.sqlite/);
  assert.match(solanaUnit, /EnvironmentFile=-\/etc\/robinhood-radar\/solana\.env/);
  assert.match(solanaUnit, /ExecStart=.*solana-server\.mjs/);
  assert.doesNotMatch(solanaUnit, /HELIUS_API_KEY=/);
  assert.doesNotMatch(solanaUnit, /SOLANA_HELIUS_AUTH_HEADER=/);
});

test('Robinhood owns the independent social store and loads its private bridge token from an environment file', () => {
  assert.match(robinhoodUnit, /Environment=SOCIAL_DATA_FILE=\/var\/lib\/robinhood-radar\/social\.sqlite/);
  assert.match(robinhoodUnit, /Environment=SOCIAL_RETENTION_DAYS=7/);
  assert.match(robinhoodUnit, /Environment=SOCIAL_BRIDGE_OFFLINE_MS=90000/);
  assert.match(robinhoodUnit, /EnvironmentFile=-\/etc\/robinhood-radar\/social\.env/);
  assert.doesNotMatch(robinhoodUnit, /SOCIAL_BRIDGE_TOKEN=/);
});

test('remote installer backs up, checks, deploys, and validates all four databases', () => {
  assert.match(installer, /readonly chains=\("robinhood" "base" "solana"\)/);
  assert.match(installer, /PRAGMA quick_check/);
  assert.match(installer, /database_backup_path/);
  assert.match(installer, /social_database_backup_path/);
  assert.match(installer, /PRAGMA wal_checkpoint\(TRUNCATE\)/);
  assert.match(installer, /backup_database_file "\$database" "\$database_backup"/);
  assert.match(installer, /backup_database_file "\$social_database" "\$social_database_backup"/);
  assert.match(installer, /restore_database_file "\$backup" "\$database" robinhood-radar robinhood-radar/);
  assert.match(installer, /restore_database_file "\$social_backup" "\$social_database" robinhood-radar robinhood-radar/);
  assert.match(installer, /rm -f "\$database-wal" "\$database-shm"/);
  assert.match(installer, /api\/social\?postLimit=1/);
  assert.match(installer, /quick_check_database "\$\(social_database_path\)"/);
  assert.match(installer, /restore_optional_file/);
  assert.match(installer, /api\/\$chain\/dashboard/);
  assert.match(installer, /dashboard\.chain !== expectedChain/);
  assert.match(installer, /api\/\$chain\/monitor/);
  assert.match(installer, /monitor\.chain !== expectedChain/);
  assert.match(installer, /history:wallets/);
  assert.match(installer, /systemctl enable "\$service\.service"/);
  assert.match(installer, /caddy validate --config/);
  assert.match(installer, /systemctl reload caddy\.service/);
  assert.match(installer, /RADAR_PUBLIC_BASE_URL/);
  assert.match(installer, /ALLOW_SOLANA_DEGRADED/);
  assert.match(installer, /Solana real-time provider is not ready/);
  assert.doesNotMatch(installer, /DROP TABLE IF EXISTS wallet_token_performance/);
  assert.doesNotMatch(installer, /DELETE FROM wallet_summaries/);
  assert.match(installer, /systemctl is-active --quiet "\$service\.service"/);
  assert.match(installer, /backup_optional_file "\$app_dir\/REVISION"/);
  assert.match(installer, /install -m 0644 "\$staging_dir\/REVISION" "\$app_dir\/REVISION"/);
  assert.match(installer, /restore_optional_file "\$release_backup\/REVISION"/);
  assert.doesNotMatch(installer, /staging_dir\/robinhood-server\.mjs\.LEGAL\.txt" \\\n/);
});

test('SQLite deployment backup and restore preserve committed WAL rows for every database', (t) => {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'robinhood-deploy-wal-'));
  const openDatabases = [];
  t.after(() => {
    for (const database of openDatabases) {
      try {
        database.close();
      } catch {}
    }
    fs.rmSync(directory, { recursive: true, force: true });
  });

  for (const name of ['robinhood', 'base', 'solana', 'social']) {
    const livePath = path.join(directory, `${name}.sqlite`);
    const mainFileOnlyPath = path.join(directory, `${name}-main-only.sqlite`);
    const backupPath = path.join(directory, `${name}-backup.sqlite`);
    const restorePath = path.join(directory, `${name}-restore.sqlite`);
    const live = new DatabaseSync(livePath);
    openDatabases.push(live);
    live.exec(`
      CREATE TABLE deployment_probe (value TEXT NOT NULL);
      INSERT INTO deployment_probe VALUES ('main-file-row');
      PRAGMA journal_mode = WAL;
      PRAGMA wal_autocheckpoint = 0;
      INSERT INTO deployment_probe VALUES ('committed-wal-row');
    `);

    assert.ok(fs.statSync(`${livePath}-wal`).size > 0, `${name} did not produce a WAL`);
    fs.copyFileSync(livePath, mainFileOnlyPath);
    const mainFileOnly = new DatabaseSync(mainFileOnlyPath, { readOnly: true });
    assert.deepEqual(
      mainFileOnly.prepare('SELECT value FROM deployment_probe ORDER BY rowid').all().map((row) => row.value),
      ['main-file-row'],
      `${name} fixture did not isolate the committed WAL row`
    );
    mainFileOnly.close();

    runInstallerHelper('backup_database_file', livePath, backupPath);
    const backup = new DatabaseSync(backupPath, { readOnly: true });
    assert.deepEqual(
      backup.prepare('SELECT value FROM deployment_probe ORDER BY rowid').all().map((row) => row.value),
      ['main-file-row', 'committed-wal-row'],
      `${name} backup lost committed WAL data`
    );
    backup.close();

    const staleWriter = spawnSync(
      process.execPath,
      [
        '--input-type=module',
        '-e',
        `
          import { DatabaseSync } from 'node:sqlite';
          const db = new DatabaseSync(process.argv[1]);
          db.exec(\`CREATE TABLE stale (value TEXT); PRAGMA journal_mode = WAL; PRAGMA wal_autocheckpoint = 0; INSERT INTO stale VALUES ('stale-wal-row')\`);
          process.kill(process.pid, 'SIGKILL');
        `,
        restorePath
      ],
      { encoding: 'utf8' }
    );
    assert.equal(staleWriter.signal, 'SIGKILL');
    assert.ok(fs.existsSync(`${restorePath}-wal`));
    assert.ok(fs.existsSync(`${restorePath}-shm`));

    runInstallerHelper('restore_database_file', backupPath, restorePath);
    assert.equal(fs.existsSync(`${restorePath}-wal`), false, `${name} stale WAL survived restore`);
    assert.equal(fs.existsSync(`${restorePath}-shm`), false, `${name} stale SHM survived restore`);
    const restored = new DatabaseSync(restorePath, { readOnly: true });
    assert.deepEqual(
      restored.prepare('SELECT value FROM deployment_probe ORDER BY rowid').all().map((row) => row.value),
      ['main-file-row', 'committed-wal-row'],
      `${name} restore lost backup rows`
    );
    assert.equal(
      restored.prepare("SELECT count(*) AS count FROM sqlite_master WHERE name = 'stale'").get().count,
      0,
      `${name} restore was polluted by the previous WAL`
    );
    restored.close();
  }
});

test('SQLite deployment restore preserves missing-database semantics and removes sidecars', (t) => {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'robinhood-deploy-missing-'));
  t.after(() => fs.rmSync(directory, { recursive: true, force: true }));

  const backupPath = path.join(directory, 'missing-backup.sqlite');
  const restorePath = path.join(directory, 'existing.sqlite');
  fs.writeFileSync(`${backupPath}.missing`, '');
  fs.writeFileSync(restorePath, 'old database');
  fs.writeFileSync(`${restorePath}-wal`, 'old wal');
  fs.writeFileSync(`${restorePath}-shm`, 'old shm');

  runInstallerHelper('restore_database_file', backupPath, restorePath);
  assert.equal(fs.existsSync(restorePath), false);
  assert.equal(fs.existsSync(`${restorePath}-wal`), false);
  assert.equal(fs.existsSync(`${restorePath}-shm`), false);
});
