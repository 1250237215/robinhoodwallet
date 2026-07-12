import { execFileSync } from 'node:child_process';
import crypto from 'node:crypto';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

const CODEX_COOKIE_DB = path.join(
  os.homedir(),
  'Library/Application Support/Codex/Partitions/codex-browser-app/Cookies'
);

function chromeTimeToUnixSeconds(value) {
  const number = Number(value);
  if (!Number.isFinite(number) || number <= 0) {
    return -1;
  }
  return Math.floor(number / 1000000 - 11644473600);
}

function sameSiteFromChromium(value) {
  switch (Number(value)) {
    case 1:
      return 'Lax';
    case 2:
      return 'Strict';
    case 3:
      return 'None';
    default:
      return 'None';
  }
}

function readSafeStoragePassword() {
  return execFileSync(
    'security',
    ['find-generic-password', '-w', '-s', 'Codex Safe Storage', '-a', 'Codex'],
    { encoding: 'utf8', timeout: 5000 }
  ).trimEnd();
}

function decryptChromiumCookie(row, key) {
  const encrypted = Buffer.from(row.encrypted_hex, 'hex');
  if (!encrypted.subarray(0, 3).equals(Buffer.from('v10'))) {
    throw new Error(`Unsupported encrypted cookie format for ${row.name}`);
  }

  const iv = Buffer.alloc(16, ' ');
  const decipher = crypto.createDecipheriv('aes-128-cbc', key, iv);
  let plain = Buffer.concat([decipher.update(encrypted.subarray(3)), decipher.final()]);

  const hostDigest = crypto.createHash('sha256').update(row.host_key).digest();
  if (plain.length >= hostDigest.length && crypto.timingSafeEqual(plain.subarray(0, hostDigest.length), hostDigest)) {
    plain = plain.subarray(hostDigest.length);
  }

  return plain.toString('utf8');
}

function queryCookies(cookieDbPath) {
  const sql = [
    'select host_key,name,path,expires_utc,is_httponly,is_secure,samesite,hex(encrypted_value) as encrypted_hex',
    'from cookies',
    "where host_key in ('.debot.ai','debot.ai')",
    'order by host_key,name'
  ].join(' ');

  const output = execFileSync('sqlite3', ['-json', cookieDbPath, sql], { encoding: 'utf8', timeout: 5000 });
  return JSON.parse(output || '[]');
}

function parseCookieJson(value, sourceLabel) {
  let parsed;
  try {
    parsed = JSON.parse(value || '[]');
  } catch (error) {
    throw new Error(`Could not parse Debot cookies from ${sourceLabel}: ${error instanceof Error ? error.message : String(error)}`);
  }

  if (!Array.isArray(parsed) || parsed.length === 0) {
    throw new Error(`No Debot cookies were found in ${sourceLabel}.`);
  }

  return parsed;
}

export function loadDebotCookies(options = {}) {
  const cookiesJson = options.cookiesJson || process.env.DEBOT_COOKIES_JSON;
  if (cookiesJson) {
    return parseCookieJson(cookiesJson, 'DEBOT_COOKIES_JSON');
  }

  const cookiesPath = options.cookiesPath || process.env.DEBOT_COOKIES_PATH;
  if (cookiesPath) {
    return parseCookieJson(fs.readFileSync(cookiesPath, 'utf8'), cookiesPath);
  }

  const sourcePath = options.sourcePath || CODEX_COOKIE_DB;
  if (!fs.existsSync(sourcePath)) {
    throw new Error(`Codex browser cookie database was not found at ${sourcePath}`);
  }

  const tempPath = path.join(os.tmpdir(), `debot-cookies-${process.pid}-${Date.now()}.sqlite`);
  fs.copyFileSync(sourcePath, tempPath);

  try {
    const rows = queryCookies(tempPath);
    if (rows.length === 0) {
      throw new Error('No Debot cookies were found in the Codex browser profile.');
    }

    const password = readSafeStoragePassword();
    const key = crypto.pbkdf2Sync(password, 'saltysalt', 1003, 16, 'sha1');

    return rows.map((row) => ({
      name: row.name,
      value: decryptChromiumCookie(row, key),
      domain: row.host_key,
      path: row.path || '/',
      expires: chromeTimeToUnixSeconds(row.expires_utc),
      httpOnly: row.is_httponly === 1,
      secure: row.is_secure === 1,
      sameSite: sameSiteFromChromium(row.samesite)
    }));
  } finally {
    fs.rmSync(tempPath, { force: true });
  }
}
