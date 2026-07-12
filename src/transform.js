function asArray(value) {
  return Array.isArray(value) ? value : [];
}

function asObject(value) {
  return value && typeof value === 'object' && !Array.isArray(value) ? value : {};
}

function numberOrNull(value) {
  if (value === null || value === undefined || value === '') {
    return null;
  }
  const number = Number(value);
  return Number.isFinite(number) ? number : null;
}

function logoOrEmpty(value) {
  const logo = String(value || '').trim();
  if (/^(https?:\/\/|data:image\/)/i.test(logo)) {
    return logo;
  }
  return '';
}

export function transformSignalResponse(payload, options = {}) {
  const limit = Number.isInteger(options.limit) && options.limit > 0 ? options.limit : 10;
  const data = asObject(payload?.data);
  const meta = asObject(data.meta);
  const tokens = asObject(meta.tokens);

  return asArray(data.results)
    .slice(0, limit)
    .map((result, index) => {
      const item = asObject(result);
      const address = String(item.token || '');
      const token = asObject(tokens[address]);
      const trading = asObject(item.token_trading_stat);
      const walletStats = asArray(item.wallet_stats);
      const symbol = token.symbol || address;
      const name = token.name || symbol;

      return {
        rank: index + 1,
        id: String(item.id || address || index + 1),
        chain: item.chain || token.chain || '',
        address,
        symbol,
        name,
        logo: logoOrEmpty(token.logo),
        createTime: numberOrNull(item.create_time),
        creationTimestamp: numberOrNull(token.creation_timestamp),
        groupName: item.group_name || '',
        walletCount: walletStats.length > 0 ? walletStats.length : numberOrNull(item.wallet_count),
        avgWalletVolume: numberOrNull(item.avg_wallet_volume),
        priceUsd: numberOrNull(trading.price ?? trading.price_usd),
        marketCapUsd: numberOrNull(trading.mkt_cap ?? trading.market_cap_usd),
        holders: numberOrNull(trading.holders),
        liquidityUsd: numberOrNull(trading.liquidity ?? trading.liquidity_usd),
        volume24h: numberOrNull(trading.volume_24h ?? trading.volume24h),
        priceChange24h: numberOrNull(trading.percent24h ?? trading.percent_24h)
      };
    });
}
