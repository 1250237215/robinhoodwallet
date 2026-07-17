import assert from 'node:assert/strict';
import fs from 'node:fs';
import test from 'node:test';
import { fileURLToPath } from 'node:url';
import { build } from 'esbuild';

const packageJson = JSON.parse(fs.readFileSync(new URL('../package.json', import.meta.url), 'utf8'));
const caddy = fs.readFileSync(new URL('../deploy/Caddyfile.example', import.meta.url), 'utf8');
const installer = fs.readFileSync(new URL('../deploy/install-remote.sh', import.meta.url), 'utf8');
const baseUnit = fs.readFileSync(new URL('../deploy/base-radar.service', import.meta.url), 'utf8');
const solanaUnit = fs.readFileSync(new URL('../deploy/solana-radar.service', import.meta.url), 'utf8');

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

test('remote installer backs up, checks, deploys, and validates all three databases', () => {
  assert.match(installer, /readonly chains=\("robinhood" "base" "solana"\)/);
  assert.match(installer, /PRAGMA quick_check/);
  assert.match(installer, /database_backup_path/);
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
