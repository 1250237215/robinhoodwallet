import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import crypto from 'node:crypto';
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
const bscUnit = fs.readFileSync(new URL('../deploy/bsc-radar.service', import.meta.url), 'utf8');
const solanaUnit = fs.readFileSync(new URL('../deploy/solana-radar.service', import.meta.url), 'utf8');
const robinhoodEnv = fs.readFileSync(new URL('../deploy/robinhood.env.example', import.meta.url), 'utf8');
const baseEnv = fs.readFileSync(new URL('../deploy/base.env.example', import.meta.url), 'utf8');
const bscEnv = fs.readFileSync(new URL('../deploy/bsc.env.example', import.meta.url), 'utf8');
const solanaEnv = fs.readFileSync(new URL('../deploy/solana.env.example', import.meta.url), 'utf8');
const socialEnv = fs.readFileSync(new URL('../deploy/social.env.example', import.meta.url), 'utf8');
const bootstrap = fs.readFileSync(new URL('../deploy/bootstrap-host.sh', import.meta.url), 'utf8');
const releasePreparer = fs.readFileSync(new URL('../scripts/prepare-release.mjs', import.meta.url), 'utf8');
const installerPath = fileURLToPath(new URL('../deploy/install-remote.sh', import.meta.url));

function runInstallerHelper(helper, ...args) {
  const result = runInstallerHelperRaw(helper, ...args);
  assert.equal(
    result.status,
    0,
    `installer helper ${helper} failed:\n${result.stdout}${result.stderr}`
  );
}

function runInstallerHelperRaw(helper, ...args) {
  return spawnSync(
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
}

test('builds one standalone bundle for every isolated chain runtime', () => {
  assert.match(packageJson.scripts['build:all'], /build:robinhood.*build:base.*build:bsc.*build:solana/);
  assert.match(packageJson.scripts['build:robinhood'], /src\/robinhood\/main\.js.*dist\/robinhood-server\.mjs/);
  assert.match(packageJson.scripts['build:base'], /src\/base\/server\.js.*dist\/base-server\.mjs/);
  assert.match(packageJson.scripts['build:bsc'], /src\/bsc\/server\.js.*dist\/bsc-server\.mjs/);
  assert.match(packageJson.scripts['build:solana'], /src\/solana\/server\.js.*dist\/solana-server\.mjs/);
  assert.equal(packageJson.scripts.start, 'node src/robinhood/main.js');
  assert.equal(packageJson.scripts['start:legacy'], 'node src/server.js');
  assert.equal(packageJson.scripts['start:robinhood'], 'node src/robinhood/main.js');
  assert.equal(packageJson.scripts['start:base'], 'node src/base/server.js');
  assert.equal(packageJson.scripts['start:bsc'], 'node src/bsc/server.js');
  assert.equal(packageJson.scripts['start:solana'], 'node src/solana/server.js');
  assert.equal(packageJson.scripts['release:prepare'], 'node scripts/prepare-release.mjs');
});

test('Base, BSC, and Solana production bundles cannot execute the Robinhood entrypoint', async () => {
  const robinhoodServer = fs.readFileSync(new URL('../src/robinhoodServer.js', import.meta.url), 'utf8');
  assert.doesNotMatch(robinhoodServer, /Robinhood smart money radar:/);
  assert.doesNotMatch(robinhoodServer, /pathToFileURL/);

  for (const [entryPoint, ownBanner] of [
    ['src/base/server.js', 'Base smart money radar API:'],
    ['src/bsc/server.js', 'BSC smart money radar API:'],
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
  assert.match(caddy, /\{\$RADAR_LEGACY_SITE_ADDRESS:http:\/\/localhost:8080\}[\s\S]*@legacyRadarPage path \/robinhood-radar \/robinhood-radar\/\*[\s\S]*redir @legacyRadarPage \{\$RADAR_CANONICAL_ORIGIN:http:\/\/localhost\}\{uri\} 308/);
  assert.match(caddy, /\{\$RADAR_SITE_ADDRESS:http:\/\/localhost\}/);
  assert.match(caddy, /\/api\/robinhood\/\*[\s\S]*127\.0\.0\.1:18118/);
  assert.match(caddy, /\/api\/base\/\*[\s\S]*127\.0\.0\.1:18119/);
  assert.match(caddy, /\/api\/bsc\/\*[\s\S]*127\.0\.0\.1:18122/);
  assert.match(caddy, /\/api\/solana\/\*[\s\S]*127\.0\.0\.1:18120/);
  assert.match(caddy, /\/api\/social\/stream[\s\S]*127\.0\.0\.1:18118[\s\S]*flush_interval -1/);
  assert.match(caddy, /\/api\/bsc\/monitor\/stream[\s\S]*127\.0\.0\.1:18122[\s\S]*flush_interval -1/);
  assert.match(caddy, /handle \/robinhood-radar\/internal\/\*[\s\S]*respond "Not found" 404/);
  assert.match(caddy, /@solanaWebhook[\s\S]*monitor\/webhook[\s\S]*127\.0\.0\.1:18120/);
  assert.doesNotMatch(caddy, /basic_?auth|basicauth|RADAR_BASIC_AUTH_HASH/);
  assert.doesNotMatch(caddy, /217\.116\.171\.250|sslip\.io/);
});

test('chain systemd units bind independent ports, chain databases, and private environment files', () => {
  assert.match(robinhoodUnit, /EnvironmentFile=-\/etc\/robinhood-radar\/robinhood\.env/);
  assert.match(robinhoodUnit, /Environment=EVM_WALLET_DATA_FILE=\/var\/lib\/robinhood-radar\/evm-wallets\.sqlite/);
  assert.match(baseUnit, /Environment=BASE_PORT=18119/);
  assert.match(baseUnit, /Environment=BASE_DATA_FILE=\/var\/lib\/robinhood-radar\/base\.sqlite/);
  assert.match(baseUnit, /EnvironmentFile=-\/etc\/robinhood-radar\/base\.env/);
  assert.match(baseUnit, /ExecStart=.*base-server\.mjs/);
  assert.match(bscUnit, /Environment=BSC_PORT=18122/);
  assert.match(bscUnit, /Environment=BSC_DATA_FILE=\/var\/lib\/robinhood-radar\/bsc\.sqlite/);
  assert.match(bscUnit, /Environment=EVM_WALLET_DATA_FILE=\/var\/lib\/robinhood-radar\/evm-wallets\.sqlite/);
  assert.match(bscUnit, /EnvironmentFile=-\/etc\/robinhood-radar\/bsc\.env/);
  assert.match(bscUnit, /^Environment=BSC_MONITOR_MAX_BLOCK_SPAN=10$/m);
  assert.match(bscUnit, /ExecStart=.*bsc-server\.mjs/);
  assert.doesNotMatch(bscUnit, /SOCIAL_|HELIUS_|(?:KEY|TOKEN|SECRET|PASSWORD)=/);
  assert.match(solanaUnit, /Environment=SOLANA_PORT=18120/);
  assert.match(solanaUnit, /Environment=SOLANA_DATA_FILE=\/var\/lib\/robinhood-radar\/solana\.sqlite/);
  assert.match(solanaUnit, /EnvironmentFile=-\/etc\/robinhood-radar\/solana\.env/);
  assert.match(solanaUnit, /ExecStart=.*solana-server\.mjs/);
  assert.doesNotMatch(baseUnit, /EVM_WALLET_DATA_FILE/);
  assert.doesNotMatch(solanaUnit, /EVM_WALLET_DATA_FILE/);
  assert.doesNotMatch(solanaUnit, /HELIUS_API_KEY=/);
  assert.doesNotMatch(solanaUnit, /SOLANA_HELIUS_AUTH_HEADER=/);
  for (const unit of [robinhoodUnit, baseUnit, bscUnit, solanaUnit]) {
    assert.match(unit, /ExecStart=\/usr\/bin\/env node /);
    assert.doesNotMatch(unit, /ExecStart=\/usr\/local\/bin\/node/);
  }
});

test('Robinhood owns the independent social store and loads its private bridge token from an environment file', () => {
  assert.match(robinhoodUnit, /Environment=SOCIAL_DATA_FILE=\/var\/lib\/robinhood-radar\/social\.sqlite/);
  assert.match(robinhoodUnit, /Environment=SOCIAL_RETENTION_DAYS=7/);
  assert.match(robinhoodUnit, /Environment=SOCIAL_BRIDGE_OFFLINE_MS=90000/);
  assert.match(robinhoodUnit, /EnvironmentFile=-\/etc\/robinhood-radar\/social\.env/);
  assert.doesNotMatch(robinhoodUnit, /SOCIAL_BRIDGE_TOKEN=/);
  assert.doesNotMatch(robinhoodUnit, /SOCIAL_X_FAST_HANDLES=/);
});

test('environment templates expose production overrides without embedding credentials or operator hosts', () => {
  assert.match(robinhoodEnv, /^ROBINHOOD_RPC_URL=$/m);
  assert.match(robinhoodEnv, /^ROBINHOOD_BLOCKSCOUT_API_URL=$/m);
  assert.match(baseEnv, /^BASE_RPC_URL=$/m);
  assert.match(baseEnv, /^BASE_BLOCKSCOUT_API_URL=$/m);
  assert.match(bscEnv, /^BSC_RPC_URL=$/m);
  assert.match(bscEnv, /^BSC_HOLDER_RPC_URL=$/m);
  assert.match(bscEnv, /^BSC_MONITOR_MAX_BLOCK_SPAN=10$/m);
  assert.doesNotMatch(bscEnv, /BSC_BLOCKSCOUT_API_URL/);
  assert.match(bscEnv, /^BSC_HOLDER_LOG_WINDOW=2000$/m);
  assert.match(bscEnv, /^BSC_HOLDER_MAX_TRANSFER_LOGS=100000$/m);
  assert.match(solanaEnv, /^SOLANA_RPC_URL=$/m);
  assert.match(solanaEnv, /^HELIUS_API_KEY=$/m);
  assert.match(solanaEnv, /^SOLANA_HELIUS_WEBHOOK_URL=$/m);
  assert.match(solanaEnv, /^SOLANA_HELIUS_AUTH_HEADER=$/m);
  assert.match(socialEnv, /^SOCIAL_BRIDGE_TOKEN=$/m);
  assert.match(socialEnv, /^SOCIAL_X_FAST_HANDLES=$/m);
  for (const example of [robinhoodEnv, baseEnv, bscEnv, solanaEnv, socialEnv]) {
    assert.doesNotMatch(example, /217\.116\.171\.250|sslip\.io|api\.day\.app/);
    assert.doesNotMatch(example, /^\s*[A-Z0-9_]*(?:KEY|TOKEN|SECRET|PASSWORD)=.+$/m);
  }
});

test('fresh-host bootstrap is idempotent and never overwrites operator environment files', () => {
  assert.match(bootstrap, /getent group/);
  assert.match(bootstrap, /if id "\$service_user"/);
  assert.match(bootstrap, /if \[\[ ! -e "\$destination" \]\]/);
  assert.match(bootstrap, /install -o root -g root -m 0600 "\$example" "\$destination"/);
  assert.match(bootstrap, /for name in robinhood base bsc solana social/);
  assert.match(bootstrap, /Node\.js 22\.13\.0 or newer is required/);
  assert.doesNotMatch(bootstrap, /apt(?:-get)? install|dnf install|yum install|curl[^\n]*\|[^\n]*(?:sh|bash)/);
});

test('release preparer builds a complete checksummed installer staging directory', () => {
  assert.match(releasePreparer, /npm[\s\S]*run[\s\S]*build:all/);
  assert.match(releasePreparer, /\['robinhood', 'base', 'bsc', 'solana'\]/);
  assert.match(releasePreparer, /\['robinhood', 'base', 'bsc', 'solana', 'social'\]/);
  assert.match(releasePreparer, /public\.tar\.gz/);
  assert.match(releasePreparer, /REVISION/);
  assert.match(releasePreparer, /SHA256SUMS/);
  assert.match(releasePreparer, /bootstrap-host\.sh/);
  assert.match(releasePreparer, /install-remote\.sh/);
  assert.match(releasePreparer, /the Git worktree is dirty/);
});

test('remote installer backs up, checks, deploys, and validates all six databases', () => {
  assert.match(installer, /readonly services=\("robinhood-radar" "base-radar" "bsc-radar" "solana-radar"\)/);
  assert.match(installer, /readonly chains=\("robinhood" "base" "bsc" "solana"\)/);
  assert.match(installer, /declare -A ports=\(\[robinhood\]=18118 \[base\]=18119 \[bsc\]=18122 \[solana\]=18120\)/);
  assert.match(installer, /PRAGMA quick_check/);
  assert.match(installer, /database_backup_path/);
  assert.match(installer, /social_database_backup_path/);
  assert.match(installer, /evm_wallet_database_backup_path/);
  assert.match(installer, /PRAGMA wal_checkpoint\(TRUNCATE\)/);
  assert.match(installer, /backup_database_file "\$database" "\$database_backup"/);
  assert.match(installer, /backup_database_file "\$social_database" "\$social_database_backup"/);
  assert.match(installer, /backup_database_file "\$evm_wallet_database" "\$evm_wallet_database_backup"/);
  assert.match(installer, /restore_database_file "\$backup" "\$database" robinhood-radar robinhood-radar/);
  assert.match(installer, /restore_database_file "\$social_backup" "\$social_database" robinhood-radar robinhood-radar/);
  assert.match(installer, /restore_database_file "\$evm_wallet_backup" "\$evm_wallet_database" robinhood-radar robinhood-radar/);
  assert.match(installer, /rm -f "\$database-wal" "\$database-shm"/);
  assert.match(installer, /api\/social\?postLimit=1/);
  assert.match(installer, /quick_check_database "\$\(social_database_path\)"/);
  assert.match(installer, /quick_check_database "\$\(evm_wallet_database_path\)"/);
  assert.match(installer, /evm_wallet_database_backup=\$\(evm_wallet_database_backup_path\)/);
  assert.match(installer, /restore_optional_file/);
  assert.match(installer, /verify_release_manifest "\$staging_dir"/);
  assert.match(installer, /sha256sum --check --strict SHA256SUMS/);
  assert.match(installer, /Checksum manifest does not cover required file/);
  assert.match(installer, /api\/\$chain\/dashboard/);
  assert.match(installer, /dashboard\.chain !== expectedChain/);
  assert.match(installer, /api\/\$chain\/monitor/);
  assert.match(installer, /monitor\.chain !== expectedChain/);
  assert.match(installer, /SOLANA_MONITOR_READY_TIMEOUT_SECONDS:-120/);
  assert.match(installer, /DEPLOY_MONITOR_READY_TIMEOUT_SECONDS:-30/);
  assert.match(installer, /monitor_ready_deadline=\$\(\(SECONDS \+ chain_monitor_ready_timeout_seconds\)\)/);
  assert.match(installer, /while \(\( SECONDS < monitor_ready_deadline \)\)/);
  assert.match(installer, /--connect-timeout "\$monitor_connect_timeout_seconds"/);
  assert.match(installer, /--max-time "\$monitor_request_timeout_seconds"/);
  assert.match(installer, /monitor health check did not become ready within/);
  assert.doesNotMatch(installer, /for monitor_attempt in \$\(seq 1 30\)/);
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

test('remote installer gives Solana a conservative readiness window and rejects invalid timeout settings', () => {
  const defaultSettings = spawnSync(
    'bash',
    [
      '-c',
      'source "$1"; printf "%s %s %s %s\\n" "$health_connect_timeout_seconds" "$health_request_timeout_seconds" "$monitor_ready_timeout_seconds" "$solana_monitor_ready_timeout_seconds"',
      'installer-test',
      installerPath
    ],
    {
      encoding: 'utf8',
      env: {
        ...process.env,
        ALLOW_SOLANA_DEGRADED: '0',
        DEPLOY_HEALTH_CONNECT_TIMEOUT_SECONDS: '',
        DEPLOY_HEALTH_REQUEST_TIMEOUT_SECONDS: '',
        DEPLOY_MONITOR_READY_TIMEOUT_SECONDS: '',
        SOLANA_MONITOR_READY_TIMEOUT_SECONDS: ''
      }
    }
  );
  assert.equal(defaultSettings.status, 0, defaultSettings.stderr);
  const [connectTimeout, requestTimeout, monitorTimeout, solanaTimeout] = defaultSettings.stdout
    .trim()
    .split(/\s+/)
    .map(Number);
  assert.equal(connectTimeout, 2);
  assert.equal(requestTimeout, 5);
  assert.equal(monitorTimeout, 30);
  assert.ok(solanaTimeout >= 90, `Solana readiness window was only ${solanaTimeout}s`);

  for (const [name, value] of [
    ['DEPLOY_HEALTH_CONNECT_TIMEOUT_SECONDS', '0'],
    ['DEPLOY_HEALTH_REQUEST_TIMEOUT_SECONDS', 'slow'],
    ['DEPLOY_MONITOR_READY_TIMEOUT_SECONDS', '-1'],
    ['SOLANA_MONITOR_READY_TIMEOUT_SECONDS', '1.5']
  ]) {
    const invalid = spawnSync('bash', ['-c', 'source "$1"', 'installer-test', installerPath], {
      encoding: 'utf8',
      env: { ...process.env, [name]: value }
    });
    assert.notEqual(invalid.status, 0, `${name} unexpectedly accepted ${value}`);
    assert.match(invalid.stderr, new RegExp(`${name} must be a positive integer`));
  }
});

test('remote installer accepts a complete manifest and rejects a changed release artifact', (t) => {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'robinhood-release-manifest-'));
  t.after(() => fs.rmSync(directory, { recursive: true, force: true }));
  const required = [
    'REVISION',
    'robinhood-server.mjs',
    'base-server.mjs',
    'bsc-server.mjs',
    'solana-server.mjs',
    'robinhood-radar.service',
    'base-radar.service',
    'bsc-radar.service',
    'solana-radar.service',
    'public.tar.gz'
  ];
  const checksums = [];
  for (const name of required) {
    const file = path.join(directory, name);
    fs.writeFileSync(file, `fixture:${name}\n`);
    const hash = crypto.createHash('sha256').update(fs.readFileSync(file)).digest('hex');
    checksums.push(`${hash}  ${name}`);
  }
  fs.writeFileSync(path.join(directory, 'SHA256SUMS'), `${checksums.join('\n')}\n`);

  runInstallerHelper('verify_release_manifest', directory);
  fs.appendFileSync(path.join(directory, 'base-server.mjs'), 'tampered\n');
  const rejected = runInstallerHelperRaw('verify_release_manifest', directory);
  assert.notEqual(rejected.status, 0);
  assert.match(`${rejected.stdout}${rejected.stderr}`, /base-server\.mjs: FAILED/);
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

  for (const name of ['robinhood', 'base', 'bsc', 'solana', 'social', 'evm-wallets']) {
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
