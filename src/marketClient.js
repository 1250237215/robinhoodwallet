function safeNumber(value) {
  if (value === null || value === undefined || value === '') {
    return null;
  }
  const number = Number(value);
  return Number.isFinite(number) ? number : null;
}

function asArray(value) {
  return Array.isArray(value) ? value : [];
}

function normalizeLinks(items) {
  return asArray(items)
    .map((item) => ({
      label: item?.label || item?.type || '',
      type: item?.type || '',
      url: item?.url || ''
    }))
    .filter((item) => item.url);
}

function tokenAddress(token) {
  return token?.address?.toLowerCase() || '';
}

function tokenName(token) {
  return token?.name || '';
}

function tokenSymbol(token) {
  return token?.symbol || '';
}

function pairName(pair) {
  const base = tokenSymbol(pair.baseToken);
  const quote = tokenSymbol(pair.quoteToken);
  return base && quote ? `${base}/${quote}` : '';
}

function choosePrimaryPair(pairs) {
  return asArray(pairs)
    .filter((pair) => pair?.chainId === 'base')
    .map((pair) => ({
      pairAddress: pair.pairAddress || '',
      pairUrl: pair.url || '',
      dexId: pair.dexId || '',
      labels: asArray(pair.labels),
      baseTokenAddress: tokenAddress(pair.baseToken),
      baseTokenName: tokenName(pair.baseToken),
      baseTokenSymbol: tokenSymbol(pair.baseToken),
      quoteTokenAddress: tokenAddress(pair.quoteToken),
      quoteTokenName: tokenName(pair.quoteToken),
      quoteTokenSymbol: tokenSymbol(pair.quoteToken),
      pairName: pairName(pair),
      priceUsd: safeNumber(pair.priceUsd),
      marketCapUsd: safeNumber(pair.marketCap),
      fdvUsd: safeNumber(pair.fdv),
      liquidityUsd: safeNumber(pair.liquidity?.usd),
      volume24h: safeNumber(pair.volume?.h24),
      volume6h: safeNumber(pair.volume?.h6),
      volume1h: safeNumber(pair.volume?.h1),
      priceChange24h: safeNumber(pair.priceChange?.h24),
      priceChange6h: safeNumber(pair.priceChange?.h6),
      priceChange1h: safeNumber(pair.priceChange?.h1),
      buys24h: safeNumber(pair.txns?.h24?.buys),
      sells24h: safeNumber(pair.txns?.h24?.sells),
      pairCreatedAt: safeNumber(pair.pairCreatedAt),
      imageUrl: pair.info?.imageUrl || '',
      websites: normalizeLinks(pair.info?.websites),
      socials: normalizeLinks(pair.info?.socials)
    }))
    .filter((pair) => pair.liquidityUsd === null || pair.liquidityUsd > 0)
    .filter((pair) => pair.priceUsd === null || pair.priceUsd < 1000000)
    .sort((left, right) => {
      const liqDiff = (right.liquidityUsd || 0) - (left.liquidityUsd || 0);
      if (liqDiff !== 0) {
        return liqDiff;
      }
      return (right.volume24h || 0) - (left.volume24h || 0);
    })[0];
}

function normalizePair(pair) {
  return {
    address: tokenAddress(pair.baseToken),
    pairAddress: pair.pairAddress || '',
    pairUrl: pair.url || '',
    dexId: pair.dexId || '',
    labels: asArray(pair.labels),
    baseTokenAddress: tokenAddress(pair.baseToken),
    baseTokenName: tokenName(pair.baseToken),
    baseTokenSymbol: tokenSymbol(pair.baseToken),
    quoteTokenAddress: tokenAddress(pair.quoteToken),
    quoteTokenName: tokenName(pair.quoteToken),
    quoteTokenSymbol: tokenSymbol(pair.quoteToken),
    pairName: pairName(pair),
    priceUsd: safeNumber(pair.priceUsd),
    marketCapUsd: safeNumber(pair.marketCap),
    fdvUsd: safeNumber(pair.fdv),
    liquidityUsd: safeNumber(pair.liquidity?.usd),
    volume24h: safeNumber(pair.volume?.h24),
    volume6h: safeNumber(pair.volume?.h6),
    volume1h: safeNumber(pair.volume?.h1),
    priceChange24h: safeNumber(pair.priceChange?.h24),
    priceChange6h: safeNumber(pair.priceChange?.h6),
    priceChange1h: safeNumber(pair.priceChange?.h1),
    buys24h: safeNumber(pair.txns?.h24?.buys),
    sells24h: safeNumber(pair.txns?.h24?.sells),
    pairCreatedAt: safeNumber(pair.pairCreatedAt),
    imageUrl: pair.info?.imageUrl || '',
    websites: normalizeLinks(pair.info?.websites),
    socials: normalizeLinks(pair.info?.socials)
  };
}

function pickBestPairsByAddress(pairs) {
  const grouped = new Map();

  for (const pair of asArray(pairs).filter((item) => item?.chainId === 'base')) {
    const normalized = normalizePair(pair);
    if (!normalized.address) {
      continue;
    }
    if (!grouped.has(normalized.address)) {
      grouped.set(normalized.address, []);
    }
    grouped.get(normalized.address).push(normalized);
  }

  const result = new Map();
  for (const [address, candidates] of grouped.entries()) {
    result.set(
      address,
      candidates
        .filter((pair) => pair.liquidityUsd === null || pair.liquidityUsd > 0)
        .filter((pair) => pair.priceUsd === null || pair.priceUsd < 1000000)
        .sort((left, right) => {
          const liqDiff = (right.liquidityUsd || 0) - (left.liquidityUsd || 0);
          if (liqDiff !== 0) {
            return liqDiff;
          }
          return (right.volume24h || 0) - (left.volume24h || 0);
        })[0] || null
    );
  }

  return result;
}

export async function fetchMarketSnapshot(address) {
  const response = await fetch(`https://api.dexscreener.com/latest/dex/tokens/${address}`, {
    headers: {
      accept: 'application/json'
    }
  });

  if (!response.ok) {
    throw new Error(`DexScreener returned HTTP ${response.status}`);
  }

  const payload = await response.json();
  const primaryPair = choosePrimaryPair(payload.pairs);

  if (!primaryPair) {
    return {
      address,
      pairCount: 0,
      websites: [],
      socials: []
    };
  }

  return {
    address,
    pairCount: asArray(payload.pairs).length,
    ...primaryPair
  };
}

export async function fetchMarketSnapshots(addresses) {
  const normalizedAddresses = [...new Set(asArray(addresses).map((item) => String(item || '').toLowerCase()).filter(Boolean))];
  if (normalizedAddresses.length === 0) {
    return new Map();
  }

  const response = await fetch(`https://api.dexscreener.com/latest/dex/tokens/${normalizedAddresses.join(',')}`, {
    headers: {
      accept: 'application/json'
    }
  });

  if (!response.ok) {
    throw new Error(`DexScreener batch returned HTTP ${response.status}`);
  }

  const payload = await response.json();
  const bestByAddress = pickBestPairsByAddress(payload.pairs);

  for (const address of normalizedAddresses) {
    if (!bestByAddress.has(address)) {
      bestByAddress.set(address, null);
    }
  }

  return bestByAddress;
}
