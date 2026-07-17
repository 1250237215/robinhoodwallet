const BASE58_ALPHABET = '123456789ABCDEFGHJKLMNPQRSTUVWXYZabcdefghijkmnopqrstuvwxyz';
const BASE58_INDEX = new Map([...BASE58_ALPHABET].map((character, index) => [character, index]));

export function decodeBase58(value) {
  const text = String(value || '');
  if (!text) throw new TypeError('Base58 value is required');

  let number = 0n;
  for (const character of text) {
    const digit = BASE58_INDEX.get(character);
    if (digit === undefined) throw new TypeError('Invalid Base58 character');
    number = number * 58n + BigInt(digit);
  }

  const bytes = [];
  while (number > 0n) {
    bytes.push(Number(number & 0xffn));
    number >>= 8n;
  }
  bytes.reverse();

  let leadingZeroes = 0;
  while (leadingZeroes < text.length && text[leadingZeroes] === '1') leadingZeroes += 1;
  return Uint8Array.from([
    ...new Array(leadingZeroes).fill(0),
    ...bytes
  ]);
}

export function encodeBase58(value) {
  const bytes = value instanceof Uint8Array ? value : Uint8Array.from(value || []);
  if (bytes.length === 0) throw new TypeError('Base58 bytes are required');

  let leadingZeroes = 0;
  while (leadingZeroes < bytes.length && bytes[leadingZeroes] === 0) leadingZeroes += 1;

  let number = 0n;
  for (const byte of bytes) number = (number << 8n) + BigInt(byte);
  let encoded = '';
  while (number > 0n) {
    const digit = Number(number % 58n);
    encoded = BASE58_ALPHABET[digit] + encoded;
    number /= 58n;
  }
  return `${'1'.repeat(leadingZeroes)}${encoded}`;
}

function normalizeFixedBase58(value, byteLength, label) {
  const text = String(value || '').trim();
  const decoded = decodeBase58(text);
  if (decoded.length !== byteLength || encodeBase58(decoded) !== text) {
    throw new TypeError(`${label} must be canonical Base58 encoding of ${byteLength} bytes`);
  }
  return text;
}

export function normalizeSolanaAddress(value) {
  return normalizeFixedBase58(value, 32, 'Solana address');
}

export function isSolanaAddress(value) {
  try {
    normalizeSolanaAddress(value);
    return true;
  } catch {
    return false;
  }
}

export function normalizeSolanaSignature(value) {
  return normalizeFixedBase58(value, 64, 'Solana signature');
}

export function isSolanaSignature(value) {
  try {
    normalizeSolanaSignature(value);
    return true;
  } catch {
    return false;
  }
}
