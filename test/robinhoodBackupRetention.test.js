import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';
import { fileURLToPath } from 'node:url';

const scriptUrl = new URL('../deploy/robinhood-backup-retention.sh', import.meta.url);
const serviceUrl = new URL('../deploy/robinhood-backup-retention.service', import.meta.url);
const timerUrl = new URL('../deploy/robinhood-backup-retention.timer', import.meta.url);
const script = fs.readFileSync(scriptUrl, 'utf8');
const service = fs.readFileSync(serviceUrl, 'utf8');
const timer = fs.readFileSync(timerUrl, 'utf8');

test('Robinhood retention deletes only expired top-level entries and preserves stable backups', (t) => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'robinhood-retention-'));
  const lockFile = path.join(root, 'retention.lock');
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));

  const recent = path.join(root, 'robinhood-recent.sqlite');
  const expired = path.join(root, 'robinhood-expired.sqlite');
  const expiredRelease = path.join(root, 'release-expired');
  const stable = path.join(root, 'stable-feishu-launch');
  fs.writeFileSync(recent, 'recent');
  fs.writeFileSync(expired, 'expired');
  fs.mkdirSync(expiredRelease);
  fs.writeFileSync(path.join(expiredRelease, 'REVISION'), 'old');
  fs.mkdirSync(stable);
  fs.writeFileSync(path.join(stable, 'evm-wallets.sqlite'), 'stable');
  const old = new Date(Date.now() - 5 * 60_000);
  fs.utimesSync(expired, old, old);
  fs.utimesSync(expiredRelease, old, old);
  fs.utimesSync(stable, old, old);

  const result = spawnSync(fileURLToPath(scriptUrl), [], {
    encoding: 'utf8',
    env: {
      ...process.env,
      ROBINHOOD_BACKUP_ROOT: root,
      ROBINHOOD_BACKUP_RETENTION_MINUTES: '1',
      ROBINHOOD_BACKUP_RETENTION_LOCK_FILE: lockFile
    }
  });
  assert.equal(result.status, 0, `${result.stdout}${result.stderr}`);
  assert.equal(fs.existsSync(recent), true);
  assert.equal(fs.existsSync(expired), false);
  assert.equal(fs.existsSync(expiredRelease), false);
  assert.equal(fs.existsSync(stable), true);
  assert.match(result.stdout, /deleted=2/);
});

test('Robinhood retention is bounded, syntax-valid, and scheduled hourly', () => {
  const syntax = spawnSync('bash', ['-n', fileURLToPath(scriptUrl)], { encoding: 'utf8' });
  assert.equal(syntax.status, 0, `${syntax.stdout}${syntax.stderr}`);
  assert.match(script, /ROBINHOOD_BACKUP_RETENTION_MINUTES:-2880/);
  assert.match(script, /-mindepth 1 -maxdepth 1 -xdev/);
  assert.match(script, /! -name 'stable-\*'/);
  assert.match(script, /Refusing unsafe backup root/);
  assert.match(script, /mkdir "\$lock_file"/);
  assert.match(service, /ExecStart=\/usr\/local\/sbin\/robinhood-backup-retention/);
  assert.match(service, /IOSchedulingClass=idle/);
  assert.match(timer, /OnCalendar=hourly/);
  assert.match(timer, /Persistent=true/);
});
