#!/usr/bin/env node

import { spawnSync } from 'node:child_process';
import crypto from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import process from 'node:process';
import { fileURLToPath } from 'node:url';
import zlib from 'node:zlib';

const repoRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const defaultOutput = path.join(repoRoot, 'dist', 'release');

function fail(message) {
  console.error(`prepare-release: ${message}`);
  process.exit(1);
}

function usage() {
  console.log(`Usage: node scripts/prepare-release.mjs [options]

Options:
  --output <directory>  Staging directory (default: dist/release)
  --caddy <file>        Include a rendered production Caddyfile
  --skip-build          Reuse existing dist/*-server.mjs bundles
  --allow-dirty         Permit a dirty checkout and mark REVISION as dirty
  --help                Show this help`);
}

function parseArguments(argv) {
  const options = {
    output: defaultOutput,
    caddy: '',
    skipBuild: false,
    allowDirty: false
  };
  for (let index = 0; index < argv.length; index += 1) {
    const argument = argv[index];
    if (argument === '--output') {
      options.output = path.resolve(argv[++index] || fail('--output requires a directory'));
    } else if (argument === '--caddy') {
      options.caddy = path.resolve(argv[++index] || fail('--caddy requires a file'));
    } else if (argument === '--skip-build') {
      options.skipBuild = true;
    } else if (argument === '--allow-dirty') {
      options.allowDirty = true;
    } else if (argument === '--help' || argument === '-h') {
      usage();
      process.exit(0);
    } else {
      fail(`unknown argument: ${argument}`);
    }
  }
  return options;
}

function run(command, args, { capture = false } = {}) {
  const result = spawnSync(command, args, {
    cwd: repoRoot,
    encoding: 'utf8',
    stdio: capture ? ['ignore', 'pipe', 'pipe'] : 'inherit'
  });
  if (result.error) fail(`${command} failed: ${result.error.message}`);
  if (result.status !== 0) {
    const details = capture ? `${result.stdout || ''}${result.stderr || ''}`.trim() : '';
    fail(`${command} exited with status ${result.status}${details ? `: ${details}` : ''}`);
  }
  return capture ? String(result.stdout || '').trim() : '';
}

function compareNames(left, right) {
  return left < right ? -1 : left > right ? 1 : 0;
}

function splitTarPath(name) {
  if (Buffer.byteLength(name) <= 100) return { name, prefix: '' };
  const directoryMarker = name.endsWith('/');
  const candidate = directoryMarker ? name.slice(0, -1) : name;
  const separators = [];
  for (let index = 0; index < candidate.length; index += 1) {
    if (candidate[index] === '/') separators.push(index);
  }
  for (let index = separators.length - 1; index >= 0; index -= 1) {
    const prefix = candidate.slice(0, separators[index]);
    const suffix = `${candidate.slice(separators[index] + 1)}${directoryMarker ? '/' : ''}`;
    if (Buffer.byteLength(prefix) <= 155 && Buffer.byteLength(suffix) <= 100) {
      return { name: suffix, prefix };
    }
  }
  throw new Error(`public asset path is too long for a portable tar archive: ${name}`);
}

function writeString(buffer, offset, length, value) {
  const source = Buffer.from(String(value));
  if (source.length > length) throw new Error(`tar field exceeds ${length} bytes: ${value}`);
  source.copy(buffer, offset);
}

function octal(value, length) {
  const digits = Math.max(0, Number(value)).toString(8);
  if (digits.length > length - 1) throw new Error(`tar numeric value is too large: ${value}`);
  return `${digits.padStart(length - 1, '0')}\0`;
}

function tarHeader({ archivePath, mode, size, mtime, type }) {
  const header = Buffer.alloc(512, 0);
  const names = splitTarPath(archivePath);
  writeString(header, 0, 100, names.name);
  writeString(header, 100, 8, octal(mode, 8));
  writeString(header, 108, 8, octal(0, 8));
  writeString(header, 116, 8, octal(0, 8));
  writeString(header, 124, 12, octal(size, 12));
  writeString(header, 136, 12, octal(mtime, 12));
  header.fill(0x20, 148, 156);
  writeString(header, 156, 1, type);
  writeString(header, 257, 6, 'ustar\0');
  writeString(header, 263, 2, '00');
  writeString(header, 265, 32, 'root');
  writeString(header, 297, 32, 'root');
  writeString(header, 329, 8, octal(0, 8));
  writeString(header, 337, 8, octal(0, 8));
  writeString(header, 345, 155, names.prefix);
  const checksum = [...header].reduce((sum, byte) => sum + byte, 0);
  writeString(header, 148, 8, `${checksum.toString(8).padStart(6, '0')}\0 `);
  return header;
}

function publicEntries(directory, prefix = '') {
  const entries = [];
  for (const name of fs.readdirSync(directory).sort(compareNames)) {
    const absolutePath = path.join(directory, name);
    const archivePath = prefix ? `${prefix}/${name}` : name;
    const stats = fs.lstatSync(absolutePath);
    if (stats.isSymbolicLink()) {
      throw new Error(`symbolic links are not allowed in public assets: ${archivePath}`);
    }
    if (stats.isDirectory()) {
      entries.push({ absolutePath, archivePath: `${archivePath}/`, directory: true });
      entries.push(...publicEntries(absolutePath, archivePath));
    } else if (stats.isFile()) {
      entries.push({ absolutePath, archivePath, directory: false });
    } else {
      throw new Error(`unsupported public asset type: ${archivePath}`);
    }
  }
  return entries;
}

function createPublicArchive(sourceDirectory, destination, mtime) {
  const parts = [];
  for (const entry of publicEntries(sourceDirectory)) {
    const contents = entry.directory ? Buffer.alloc(0) : fs.readFileSync(entry.absolutePath);
    parts.push(tarHeader({
      archivePath: entry.archivePath,
      mode: entry.directory ? 0o755 : 0o644,
      size: contents.length,
      mtime,
      type: entry.directory ? '5' : '0'
    }));
    if (contents.length > 0) {
      parts.push(contents);
      const padding = (512 - (contents.length % 512)) % 512;
      if (padding > 0) parts.push(Buffer.alloc(padding, 0));
    }
  }
  parts.push(Buffer.alloc(1024, 0));
  const compressed = zlib.gzipSync(Buffer.concat(parts), { level: 9 });
  compressed.writeUInt32LE(0, 4);
  compressed[9] = 255;
  fs.writeFileSync(destination, compressed, { mode: 0o644 });
}

function copyFile(source, destination, mode = 0o644) {
  if (!fs.existsSync(source) || !fs.statSync(source).isFile()) {
    throw new Error(`required release source is missing: ${path.relative(repoRoot, source)}`);
  }
  fs.copyFileSync(source, destination);
  fs.chmodSync(destination, mode);
}

function sha256(file) {
  return crypto.createHash('sha256').update(fs.readFileSync(file)).digest('hex');
}

function safeOutputPath(output) {
  const resolved = path.resolve(output);
  const filesystemRoot = path.parse(resolved).root;
  const outputToRepository = path.relative(resolved, repoRoot);
  if (resolved === filesystemRoot || outputToRepository === '' || !outputToRepository.startsWith('..')) {
    fail(`refusing to replace unsafe output directory: ${resolved}`);
  }
  const repositoryToOutput = path.relative(repoRoot, resolved);
  if (!repositoryToOutput.startsWith('..') && repositoryToOutput !== '' &&
      repositoryToOutput.split(path.sep)[0] !== 'dist') {
    fail(`output inside the repository must be below dist/: ${resolved}`);
  }
  return resolved;
}

const options = parseArguments(process.argv.slice(2));
const outputDirectory = safeOutputPath(options.output);
const revision = run('git', ['rev-parse', 'HEAD'], { capture: true });
const dirty = run('git', ['status', '--porcelain', '--untracked-files=normal'], { capture: true }) !== '';
if (dirty && !options.allowDirty) {
  fail('the Git worktree is dirty; commit the release or pass --allow-dirty for a local-only build');
}
if (options.caddy && (!fs.existsSync(options.caddy) || !fs.statSync(options.caddy).isFile())) {
  fail(`Caddyfile does not exist: ${options.caddy}`);
}

if (!options.skipBuild) run('npm', ['run', 'build:all']);

const commitEpoch = Number(run('git', ['show', '-s', '--format=%ct', 'HEAD'], { capture: true }));
const requestedEpoch = Number(process.env.SOURCE_DATE_EPOCH);
const sourceDateEpoch = Number.isSafeInteger(requestedEpoch) && requestedEpoch >= 0
  ? requestedEpoch
  : commitEpoch;
if (!Number.isSafeInteger(sourceDateEpoch) || sourceDateEpoch < 0) {
  fail('SOURCE_DATE_EPOCH must be a non-negative integer');
}

const parentDirectory = path.dirname(outputDirectory);
const temporaryDirectory = path.join(
  parentDirectory,
  `.${path.basename(outputDirectory)}.tmp-${process.pid}`
);
fs.mkdirSync(parentDirectory, { recursive: true });
fs.rmSync(temporaryDirectory, { recursive: true, force: true });
fs.mkdirSync(temporaryDirectory, { recursive: true, mode: 0o755 });

try {
  for (const chain of ['robinhood', 'base', 'solana']) {
    copyFile(
      path.join(repoRoot, 'dist', `${chain}-server.mjs`),
      path.join(temporaryDirectory, `${chain}-server.mjs`)
    );
    const legalSource = path.join(repoRoot, 'dist', `${chain}-server.mjs.LEGAL.txt`);
    if (fs.existsSync(legalSource)) {
      copyFile(legalSource, path.join(temporaryDirectory, `${chain}-server.mjs.LEGAL.txt`));
    }
    copyFile(
      path.join(repoRoot, 'deploy', `${chain}-radar.service`),
      path.join(temporaryDirectory, `${chain}-radar.service`)
    );
  }

  for (const name of ['robinhood', 'base', 'solana', 'social']) {
    copyFile(
      path.join(repoRoot, 'deploy', `${name}.env.example`),
      path.join(temporaryDirectory, `${name}.env.example`)
    );
  }
  copyFile(
    path.join(repoRoot, 'deploy', 'Caddyfile.example'),
    path.join(temporaryDirectory, 'Caddyfile.example')
  );
  copyFile(
    path.join(repoRoot, 'deploy', 'bootstrap-host.sh'),
    path.join(temporaryDirectory, 'bootstrap-host.sh'),
    0o755
  );
  copyFile(
    path.join(repoRoot, 'deploy', 'install-remote.sh'),
    path.join(temporaryDirectory, 'install-remote.sh'),
    0o755
  );
  if (options.caddy) {
    copyFile(options.caddy, path.join(temporaryDirectory, 'Caddyfile'));
  }

  createPublicArchive(
    path.join(repoRoot, 'public'),
    path.join(temporaryDirectory, 'public.tar.gz'),
    sourceDateEpoch
  );
  fs.writeFileSync(
    path.join(temporaryDirectory, 'REVISION'),
    `${revision}${dirty ? '-dirty' : ''}\n`,
    { mode: 0o644 }
  );

  const artifactNames = fs.readdirSync(temporaryDirectory)
    .filter((name) => fs.statSync(path.join(temporaryDirectory, name)).isFile())
    .sort(compareNames);
  const checksums = artifactNames
    .map((name) => `${sha256(path.join(temporaryDirectory, name))}  ${name}`)
    .join('\n');
  fs.writeFileSync(path.join(temporaryDirectory, 'SHA256SUMS'), `${checksums}\n`, { mode: 0o644 });

  fs.rmSync(outputDirectory, { recursive: true, force: true });
  fs.renameSync(temporaryDirectory, outputDirectory);
} catch (error) {
  fs.rmSync(temporaryDirectory, { recursive: true, force: true });
  fail(error instanceof Error ? error.message : String(error));
}

console.log(`prepare-release: staged ${revision.slice(0, 12)}${dirty ? '-dirty' : ''} at ${outputDirectory}`);
