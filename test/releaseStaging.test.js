import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import crypto from 'node:crypto';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';
import { fileURLToPath } from 'node:url';

const repository = fileURLToPath(new URL('..', import.meta.url));
const preparer = fileURLToPath(new URL('../scripts/prepare-release.mjs', import.meta.url));

function runPreparer(output, extraArguments = []) {
  const result = spawnSync(
    process.execPath,
    [preparer, '--output', output, '--allow-dirty', ...extraArguments],
    {
      cwd: repository,
      encoding: 'utf8',
      maxBuffer: 10 * 1024 * 1024
    }
  );
  assert.equal(
    result.status,
    0,
    `release preparer failed:\n${result.stdout}${result.stderr}`
  );
  assert.match(result.stdout, /prepare-release: staged [0-9a-f]{12}/);
}

function digest(file) {
  return crypto.createHash('sha256').update(fs.readFileSync(file)).digest('hex');
}

function artifactDigests(directory) {
  return Object.fromEntries(
    fs.readdirSync(directory)
      .sort()
      .map((name) => [name, digest(path.join(directory, name))])
  );
}

function verifyManifest(directory) {
  const lines = fs.readFileSync(path.join(directory, 'SHA256SUMS'), 'utf8').trim().split('\n');
  for (const line of lines) {
    const match = /^([0-9a-f]{64})  ([A-Za-z0-9][A-Za-z0-9._-]*)$/.exec(line);
    assert.ok(match, `unsafe checksum entry: ${line}`);
    const file = path.join(directory, match[2]);
    assert.ok(fs.statSync(file).isFile(), `missing checksummed artifact: ${match[2]}`);
    assert.equal(digest(file), match[1], `checksum mismatch: ${match[2]}`);
  }
}

test('release staging is complete, checksummed, and reproducible', (t) => {
  const temporaryRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'robinhood-release-'));
  const first = path.join(temporaryRoot, 'first');
  const second = path.join(temporaryRoot, 'second');
  t.after(() => fs.rmSync(temporaryRoot, { recursive: true, force: true }));

  runPreparer(first);
  runPreparer(second, ['--skip-build']);

  const required = [
    'REVISION',
    'SHA256SUMS',
    'base-radar.service',
    'base-server.mjs',
    'base.env.example',
    'bsc-radar.service',
    'bsc-server.mjs',
    'bsc.env.example',
    'bootstrap-host.sh',
    'Caddyfile.example',
    'feishu-monitor.service',
    'feishu.env.example',
    'feishu.tar.gz',
    'install-remote.sh',
    'public.tar.gz',
    'robinhood-radar.service',
    'robinhood-server.mjs',
    'robinhood.env.example',
    'social.env.example',
    'solana-radar.service',
    'solana-server.mjs',
    'solana.env.example',
    'telegram-viewer.service',
    'telegram.env.example',
    'telegram.tar.gz',
    'translation.env.example'
  ];
  for (const name of required) {
    assert.ok(fs.statSync(path.join(first, name)).isFile(), `release is missing ${name}`);
  }
  assert.equal(fs.existsSync(path.join(first, 'Caddyfile')), false);
  assert.match(fs.readFileSync(path.join(first, 'REVISION'), 'utf8'), /^[0-9a-f]{40}(?:-dirty)?\n$/);
  assert.notEqual(fs.statSync(path.join(first, 'bootstrap-host.sh')).mode & 0o111, 0);
  assert.notEqual(fs.statSync(path.join(first, 'install-remote.sh')).mode & 0o111, 0);

  verifyManifest(first);
  assert.deepEqual(artifactDigests(second), artifactDigests(first));

  const archive = spawnSync('tar', ['-tzf', path.join(first, 'public.tar.gz')], {
    encoding: 'utf8'
  });
  assert.equal(archive.status, 0, archive.stderr);
  const archiveEntries = archive.stdout.trim().split('\n');
  assert.ok(archiveEntries.includes('index.html'));
  assert.ok(archiveEntries.includes('app.js'));
  assert.equal(archiveEntries.some((name) => name.startsWith('public/')), false);

  const telegramArchive = spawnSync('tar', ['-tzf', path.join(first, 'telegram.tar.gz')], {
    encoding: 'utf8'
  });
  assert.equal(telegramArchive.status, 0, telegramArchive.stderr);
  const telegramEntries = telegramArchive.stdout.trim().split('\n');
  assert.ok(telegramEntries.includes('viewer.py'));
  assert.ok(telegramEntries.includes('forwarder.py'));
  assert.ok(telegramEntries.includes('web/app.js'));
  assert.equal(telegramEntries.includes('test_viewer.py'), false);
  assert.equal(telegramEntries.some((name) => /(?:__pycache__|\.py[co]$|\.session|config\.json|proxy\.json|\.venv|\.sqlite)/.test(name)), false);
  assert.equal(telegramEntries.every((name) => (
    ['README.md', 'forwarder.py', 'requirements.txt', 'viewer.py', 'web/'].includes(name)
      || name.startsWith('web/')
  )), true);

  const feishuArchive = spawnSync('tar', ['-tzf', path.join(first, 'feishu.tar.gz')], {
    encoding: 'utf8'
  });
  assert.equal(feishuArchive.status, 0, feishuArchive.stderr);
  const feishuEntries = feishuArchive.stdout.trim().split('\n');
  assert.ok(feishuEntries.includes('package.json'));
  assert.ok(feishuEntries.includes('src/server.js'));
  assert.ok(feishuEntries.includes('src/ca-watch.js'));
  assert.equal(feishuEntries.some((name) => /(?:test\/|public\/|node_modules|\.lark-cli|config\.json|\.sqlite|ca-watch\.json)/.test(name)), false);
  assert.equal(feishuEntries.every((name) => (
    ['README.md', 'package.json', 'src/'].includes(name) || name.startsWith('src/')
  )), true);
});
