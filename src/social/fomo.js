const FOMO_ACTIONS = new Set([
  'fomo_buy', 'fomo_sell', 'fomo_swap', 'fomo_thesis',
  'fomo_consensus', 'fomo_cash', 'fomo_verified'
]);

function absoluteUrl(value, baseUrl) {
  if (!String(value || '').trim()) return '';
  try { return new URL(String(value), baseUrl).href; } catch { return ''; }
}

function finiteNumber(...values) {
  for (const value of values) {
    const number = Number(value);
    if (value !== null && value !== '' && Number.isFinite(number)) return number;
  }
  return null;
}

function normalizedChain(value) {
  const chain = String(value || '').trim().toLowerCase();
  if (['bnb', 'bsc', 'binance', 'binance-smart-chain'].includes(chain)) return 'bsc';
  if (['sol', 'solana'].includes(chain)) return 'solana';
  if (['rh', 'robinhood', 'robinhood-chain'].includes(chain)) return 'robinhood';
  return chain;
}

export function normalizeFomoCatalog(payload, baseUrl = 'https://wind.jokkimon.club') {
  return (Array.isArray(payload?.accounts) ? payload.accounts : []).map((account) => ({
    platform: 'fomo',
    handle: String(account.handle || '').replace(/^@/, '').toLowerCase(),
    name: String(account.display_name || account.handle || ''),
    avatarUrl: absoluteUrl(account.avatar_url, baseUrl),
    followers: Number.isFinite(Number(account.follower_count)) ? Number(account.follower_count) : null,
    active: account.phys_state === 'active'
  })).filter((account) => account.handle);
}

export function normalizeFomoEvent(event, baseUrl = 'https://wind.jokkimon.club') {
  const payload = event?.payload && typeof event.payload === 'object' ? event.payload : {};
  const action = String(event?.action || payload.action || '').toLowerCase();
  if (!FOMO_ACTIONS.has(action)) return null;
  const sourceFomo = payload?.extra?.fomo && typeof payload.extra.fomo === 'object' ? payload.extra.fomo : {};
  const caInfo = Array.isArray(payload.ca_info) ? payload.ca_info : [];
  const handle = String(event.handle || payload.handle || '').replace(/^@/, '').toLowerCase();
  const ca = String(sourceFomo.ca || caInfo[0]?.address || '').trim();
  const tokenInfo = caInfo.find((item) => String(item?.address || '').toLowerCase() === ca.toLowerCase()) || caInfo[0] || {};
  const chain = normalizedChain(sourceFomo.chain || tokenInfo.resolved_chain || tokenInfo.chain);
  const fomo = {
    ...sourceFomo,
    symbol: String(sourceFomo.symbol || tokenInfo.symbol || '').trim(),
    ca,
    chain,
    usd: finiteNumber(sourceFomo.usd),
    amount: finiteNumber(sourceFomo.amount),
    price: finiteNumber(sourceFomo.price, tokenInfo.price),
    mcap: finiteNumber(sourceFomo.mcap, sourceFomo.mc, tokenInfo.mc, tokenInfo.market_cap),
    volume24h: finiteNumber(sourceFomo.volume24h, sourceFomo.vol24h, tokenInfo.vol24h),
    createdTs: finiteNumber(sourceFomo.createdTs, sourceFomo.created_ts, tokenInfo.created_ts)
  };
  const avatar = absoluteUrl(payload.avatar_url, baseUrl);
  return {
    source: 'fomo',
    externalId: String(payload.tweet_id || event.tweet_id || `fomo:${event.seq}`),
    kind: action,
    authorHandle: handle,
    authorName: String(payload.author_name || handle),
    authorAvatarUrl: avatar,
    authorFollowers: Number.isFinite(Number(fomo.followers)) ? Number(fomo.followers) : null,
    content: String(payload.content_text || ''),
    url: absoluteUrl(fomo.tx_url || payload.tweet_url || `https://fomo.family/profile/${handle}`),
    contractAddresses: ca ? [{ address: ca, chain }] : [],
    chainTags: chain ? [chain] : [],
    publishedAt: Number(event.ts || payload.timestamp || Date.now()),
    sourceUpdatedAt: Number(event.ts || payload.timestamp || Date.now()),
    raw: { fomo, caInfo, action, seq: event.seq || null }
  };
}

export function dedupeFomoEvents(events) {
  const chosen = new Map();
  for (const event of events || []) {
    const normalized = normalizeFomoEvent(event);
    if (!normalized) continue;
    const f = normalized.raw.fomo;
    const tx = String(f.tx_url || normalized.url || '').split('/').at(-1);
    const key = tx && tx !== normalized.authorHandle
      ? `${normalized.authorHandle}:${normalized.kind}:${tx}:${f.ca || ''}`
      : normalized.externalId;
    const current = chosen.get(key);
    if (!current || String(f.status) === 'final' || f.closed === true) chosen.set(key, normalized);
  }
  return [...chosen.values()];
}

export function createFomoClient({ fetchImpl = globalThis.fetch, baseUrl = 'https://wind.jokkimon.club' } = {}) {
  async function json(path) {
    const response = await fetchImpl(new URL(path, baseUrl), { signal: AbortSignal.timeout(10_000) });
    if (!response.ok) throw new Error(`FOMO upstream returned ${response.status}`);
    return response.json();
  }
  return {
    async catalog(query = '', limit = 100) {
      const params = new URLSearchParams({ platform: 'fomo', q: query, limit: String(limit) });
      return normalizeFomoCatalog(await json(`/api/catalog?${params}`), baseUrl);
    },
    async feed(handles, limit = 100) {
      if (!handles?.length) return [];
      const params = new URLSearchParams({
        handles: handles.map((handle) => `fomo:${handle}`).join(','),
        actions: [...FOMO_ACTIONS].join(','),
        limit: String(limit)
      });
      const payload = await json(`/api/feed?${params}`);
      return dedupeFomoEvents(payload.events || []);
    }
  };
}
