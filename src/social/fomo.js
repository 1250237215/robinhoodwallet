const FOMO_ACTIONS = new Set([
  'fomo_buy', 'fomo_sell', 'fomo_swap', 'fomo_thesis',
  'fomo_consensus', 'fomo_cash', 'fomo_verified'
]);

function absoluteUrl(value, baseUrl) {
  if (!String(value || '').trim()) return '';
  try { return new URL(String(value), baseUrl).href; } catch { return ''; }
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
  const fomo = payload?.extra?.fomo && typeof payload.extra.fomo === 'object' ? payload.extra.fomo : {};
  const handle = String(event.handle || payload.handle || '').replace(/^@/, '').toLowerCase();
  const ca = String(fomo.ca || payload.ca_info?.[0]?.address || '').trim();
  const chain = String(fomo.chain || payload.ca_info?.[0]?.resolved_chain || '').trim();
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
    contractAddresses: ca ? [{ address: ca, chain: chain.toLowerCase() }] : [],
    chainTags: chain ? [chain.toLowerCase()] : [],
    publishedAt: Number(event.ts || payload.timestamp || Date.now()),
    sourceUpdatedAt: Number(event.ts || payload.timestamp || Date.now()),
    raw: { fomo, caInfo: payload.ca_info || [], action, seq: event.seq || null }
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
