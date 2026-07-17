const ADDRESS_PATTERN = /^0x[0-9a-f]{40}$/;

export function normalizeBaseAddress(value) {
  return String(value || '').trim().toLowerCase();
}

export function isBaseAddress(value) {
  return ADDRESS_PATTERN.test(normalizeBaseAddress(value));
}

const addresses = Object.freeze({
  weth: normalizeBaseAddress('0x4200000000000000000000000000000000000006'),
  usdc: normalizeBaseAddress('0x833589fCD6eDb6E08f4c7C32D4f71b54bDa02913'),
  v3Factory: normalizeBaseAddress('0x33128a8fC17869897dcE68Ed026d694621f6FDfD'),
  v3Router: normalizeBaseAddress('0x2626664c2603336E57B271c5C0b26F421741e481'),
  v2Factory: normalizeBaseAddress('0x8909Dc15e40173fF4699343b6eB8132c65e18eC6'),
  v2Router: normalizeBaseAddress('0x4752ba5dbc23f44d87826276bf6fd6b1c372ad24')
});

export const BASE_CHAIN = Object.freeze({
  key: 'base',
  name: 'Base',
  id: 8453,
  chainId: 8453,
  hexId: '0x2105',
  debotChain: 'base',
  rpcUrl: 'https://mainnet.base.org',
  explorerUrl: 'https://base.blockscout.com',
  blockscoutApiUrl: 'https://base.blockscout.com/api/v2',
  dexScreenerPairsUrl: 'https://api.dexscreener.com/token-pairs/v1/base',
  holderSource: 'blockscout',
  nativeSymbol: 'ETH',
  nativeName: 'Ether',
  nativeDecimals: 18,
  ...addresses,
  quoteTokens: Object.freeze([addresses.weth, addresses.usdc]),
  infrastructureAddresses: Object.freeze(Object.values(addresses)),
  addressNormalizer: normalizeBaseAddress,
  addressValidator: isBaseAddress
});

function boundedNumber(value, fallback, minimum, maximum) {
  const number = Number(value);
  if (!Number.isFinite(number)) return fallback;
  return Math.min(maximum, Math.max(minimum, number));
}

export function createBaseConfig(env = process.env) {
  return {
    chain: BASE_CHAIN,
    rpcUrl: env.BASE_RPC_URL || BASE_CHAIN.rpcUrl,
    blockscoutApiUrl: env.BASE_BLOCKSCOUT_API_URL || BASE_CHAIN.blockscoutApiUrl,
    dataFile: env.BASE_DATA_FILE || new URL('../../data/base.sqlite', import.meta.url).pathname,
    requestTimeoutMs: boundedNumber(env.BASE_REQUEST_TIMEOUT_MS, 20_000, 1_000, 60_000)
  };
}
