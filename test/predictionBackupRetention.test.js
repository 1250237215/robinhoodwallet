import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import fs from 'node:fs';
import test from 'node:test';
import { fileURLToPath } from 'node:url';

const scriptUrl = new URL('../deploy/dqdai-prediction-backup-retention.sh', import.meta.url);
const serviceUrl = new URL('../deploy/dqdai-prediction-backup-retention.service', import.meta.url);
const timerUrl = new URL('../deploy/dqdai-prediction-backup-retention.timer', import.meta.url);
const script = fs.readFileSync(scriptUrl, 'utf8');
const service = fs.readFileSync(serviceUrl, 'utf8');
const timer = fs.readFileSync(timerUrl, 'utf8');

test('prediction backup retention is syntax-valid and restricted to 48-hour JSON snapshots', () => {
  const syntax = spawnSync('bash', ['-n', fileURLToPath(scriptUrl)], { encoding: 'utf8' });
  assert.equal(syntax.status, 0, `${syntax.stdout}${syntax.stderr}`);

  assert.match(script, /readonly retention_minutes=2880/);
  assert.match(script, /\/opt\/dqdai-1\/site\/assets\/prediction_backups/);
  assert.match(script, /\/opt\/dqdai-2\/site\/assets\/prediction_backups/);
  assert.match(script, /\/opt\/dqdai-3\/site\/assets\/prediction_backups/);
  assert.match(script, /-type f[\s\S]*-name 'all_predictions-\*\.json'[\s\S]*-mmin "\+\$\{retention_minutes\}"/);
  assert.match(script, /-maxdepth 1/);
  assert.match(script, /flock -n/);
  assert.doesNotMatch(script, /rm\s+-rf/);
  assert.doesNotMatch(script, /-name 'all_predictions\.json'/);
});

test('prediction backup retention runs hourly as a low-priority persistent timer', () => {
  assert.match(service, /Type=oneshot/);
  assert.match(service, /ExecStart=\/usr\/local\/sbin\/dqdai-prediction-backup-retention/);
  assert.match(service, /Nice=10/);
  assert.match(service, /IOSchedulingClass=idle/);
  assert.match(timer, /OnUnitActiveSec=1h/);
  assert.match(timer, /Persistent=true/);
  assert.match(timer, /Unit=dqdai-prediction-backup-retention\.service/);
  assert.match(timer, /WantedBy=timers\.target/);
});
