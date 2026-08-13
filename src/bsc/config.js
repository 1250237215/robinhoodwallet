const ADDRESS_PATTERN = /^0x[0-9a-f]{40}$/;

export const FOUR_MEME_TOKEN_CREATE_TOPIC =
  '0x396d5e902b675b032348d3d2e9517ee8f0c4a926603fbc075d3d282ff00cad20';
export const FOUR_MEME_BUY_TOPIC =
  '0x7db52723a3b2cdd6164364b3b766e65e540d7be48ffa89582956d8eaebe62942';
export const FOUR_MEME_SELL_TOPIC =
  '0x0a5575b3648bae2210cee56bf33254cc1ddfbc7bf637c0af2ac18b14fb1bae19';

export function normalizeBscAddress(value) {
  return String(value || '').trim().toLowerCase();
}

export function isBscAddress(value) {
  return ADDRESS_PATTERN.test(normalizeBscAddress(value));
}

const addresses = Object.freeze({
  wbnb: normalizeBscAddress('0xbb4CdB9CBd36B01bD1cBaEBF2De08d9173bc095c'),
  usdt: normalizeBscAddress('0x55d398326f99059fF775485246999027B3197955'),
  usdc: normalizeBscAddress('0x8AC76a51cc950d9822D68b83fE1Ad97B32Cd580d'),
  fdusd: normalizeBscAddress('0xc5f0f7b66764f6eC8C8dff7BA683102295E16409'),
  busd: normalizeBscAddress('0xe9e7CEA3DedcA5984780Bafc599bD69ADd087D56'),
  dai: normalizeBscAddress('0x1AF3F329e8BE154074D8769D1FFa4eE058B1DBc3'),
  tusd: normalizeBscAddress('0x14016E85a25aeb13065688cAFB43044C2ef86784'),
  usdd: normalizeBscAddress('0xd17479997F34dd9156Deef8F95A52D81D265be9c'),
  fourMemeTokenManager: normalizeBscAddress('0x5c952063c7fc8610ffdb798152d69f0b9550762b'),
  v3Factory: normalizeBscAddress('0x0BFbCF9fa4f9C56B0F40aF0941e9070F871F980'),
  v3Router: normalizeBscAddress('0x13f4EA83D0bd40E75C8222255bc855a974568Dd4'),
  v2Factory: normalizeBscAddress('0xca143ce32fe78f1f7019d7d551a6402fc5350c73'),
  v2Router: normalizeBscAddress('0x10ED43C718714eb63d5aA57B78B54704E256024E')
});

export const BSC_CHAIN = Object.freeze({
  key: 'bsc',
  name: 'BSC',
  id: 56,
  chainId: 56,
  hexId: '0x38',
  debotChain: 'bsc',
  // The BNB Chain public seed supports the transaction receipts required by
  // the live scan without requiring an API key.
  rpcUrl: 'https://bsc-dataseed1.bnbchain.org',
  explorerUrl: 'https://bscscan.com',
  dexScreenerPairsUrl: 'https://api.dexscreener.com/token-pairs/v1/bsc',
  dexScreenerTokensUrl: 'https://api.dexscreener.com/tokens/v1/bsc',
  holderSource: 'debot_token_holder_profile',
  nativeSymbol: 'BNB',
  nativeName: 'BNB',
  nativeDecimals: 18,
  ...addresses,
  quoteTokens: Object.freeze([
    addresses.wbnb,
    addresses.usdt,
    addresses.usdc,
    addresses.busd,
    addresses.fdusd,
    addresses.dai,
    addresses.tusd,
    addresses.usdd
  ]),
  swapTopics: Object.freeze([FOUR_MEME_BUY_TOPIC, FOUR_MEME_SELL_TOPIC]),
  launchProfiles: Object.freeze([
    Object.freeze({
      address: addresses.fourMemeTokenManager,
      topic: FOUR_MEME_TOKEN_CREATE_TOPIC,
      platform: 'four_meme',
      walletDataWord: 0,
      tokenDataWord: 1
    })
  ]),
  infrastructureAddresses: Object.freeze(Object.values(addresses)),
  addressNormalizer: normalizeBscAddress,
  addressValidator: isBscAddress
});

function boundedNumber(value, fallback, minimum, maximum) {
  const number = Number(value);
  if (!Number.isFinite(number)) return fallback;
  return Math.min(maximum, Math.max(minimum, number));
}

export function createBscConfig(env = process.env) {
  const debotBridgeTimeoutMs = boundedNumber(env.BSC_DEBOT_BRIDGE_TIMEOUT_MS, 90_000, 5_000, 110_000);
  return {
    chain: BSC_CHAIN,
    rpcUrl: env.BSC_RPC_URL || BSC_CHAIN.rpcUrl,
    holderRpcUrl: String(env.BSC_HOLDER_RPC_URL || '').trim(),
    holderLogRpcUrl: String(env.BSC_HOLDER_LOG_RPC_URL || '').trim(),
    debotBridgeUrl: String(
      env.BSC_DEBOT_BRIDGE_URL || 'http://127.0.0.1:18118/internal/debot/request'
    ).trim(),
    debotBridgeTimeoutMs,
    debotRequestTimeoutMs: boundedNumber(
      env.BSC_DEBOT_REQUEST_TIMEOUT_MS,
      Math.min(120_000, debotBridgeTimeoutMs + 5_000),
      debotBridgeTimeoutMs + 1_000,
      120_000
    ),
    dataFile: env.BSC_DATA_FILE || new URL('../../data/bsc.sqlite', import.meta.url).pathname,
    walletDataFile: String(env.EVM_WALLET_DATA_FILE || '').trim(),
    requestTimeoutMs: boundedNumber(env.BSC_REQUEST_TIMEOUT_MS, 20_000, 1_000, 60_000)
  };
}
