function normalizeText(value) {
  return String(value || '');
}

function asArray(value) {
  return Array.isArray(value) ? value : [];
}

function unique(items) {
  return [...new Set(items.filter(Boolean))];
}

function compactObject(value) {
  if (Array.isArray(value)) {
    return value.map(compactObject).filter((item) => item !== null && item !== undefined);
  }
  if (value && typeof value === 'object') {
    const result = {};
    for (const [key, item] of Object.entries(value)) {
      const compacted = compactObject(item);
      if (compacted === null || compacted === undefined || compacted === '') {
        continue;
      }
      if (Array.isArray(compacted) && !compacted.length) {
        continue;
      }
      result[key] = compacted;
    }
    return result;
  }
  return value;
}

function snippet(value, maxLength = 2000) {
  const text = normalizeText(value).replace(/\s+/g, ' ').trim();
  return text.length > maxLength ? `${text.slice(0, maxLength - 1)}…` : text;
}

function normalizeHandle(value) {
  const raw = normalizeText(value).trim().replace(/^@/, '');
  return /^[A-Za-z0-9_]{2,20}$/.test(raw) ? `@${raw}` : null;
}

function xUrlForHandle(handle) {
  const normalized = normalizeHandle(handle);
  return normalized ? `https://x.com/${normalized.slice(1)}` : null;
}

function decodeHtmlEntities(value) {
  return normalizeText(value)
    .replace(/&#(\d+);/g, (_, code) => String.fromCharCode(Number(code)))
    .replace(/&#x([a-f0-9]+);/gi, (_, code) => String.fromCharCode(parseInt(code, 16)))
    .replace(/&quot;/g, '"')
    .replace(/&#39;/g, "'")
    .replace(/&amp;/g, '&')
    .replace(/&lt;/g, '<')
    .replace(/&gt;/g, '>');
}

function extractInitialStateJson(html) {
  const text = normalizeText(html);
  const marker = 'window.__INITIAL_STATE__=';
  const start = text.indexOf(marker);
  if (start < 0) {
    return null;
  }

  const jsonStart = start + marker.length;
  const candidates = [
    text.indexOf(';window.__META_DATA__', jsonStart),
    text.indexOf(';</script>', jsonStart)
  ].filter((index) => index > jsonStart);
  const jsonEnd = candidates.length ? Math.min(...candidates) : -1;
  return jsonEnd > jsonStart ? text.slice(jsonStart, jsonEnd) : null;
}

function parseJsonContent(content) {
  const raw = normalizeText(content).trim();
  const fenced = raw.match(/```(?:json)?\s*([\s\S]*?)```/i)?.[1];
  const text = (fenced || raw).trim().replace(/^```json\s*/i, '').replace(/^```\s*/i, '').replace(/```$/i, '').trim();
  return JSON.parse(text);
}

function extractResponseText(payload, provider = 'LLM') {
  const content =
    payload?.output_text ||
    asArray(payload?.output)
      .flatMap((item) => asArray(item?.content))
      .filter((part) => part?.type === 'output_text')
      .map((part) => part.text)
      .join('\n') ||
    payload?.choices?.[0]?.message?.content;
  if (!content) {
    throw new Error(`${provider} response did not include message content`);
  }
  return content;
}

function tweetSortValue(item) {
  const time = Date.parse(item?.publishedAt || '');
  if (Number.isFinite(time)) {
    return time;
  }
  try {
    return Number(BigInt(item?.id || '0') / 1000000n);
  } catch {
    return 0;
  }
}

function normalizePostItem(item, fallbackHandle = null) {
  const handle = normalizeHandle(item?.handle || fallbackHandle);
  const text = snippet(item?.text || item?.textOriginal || item?.full_text || item?.fullText, 1200);
  const textOriginal = snippet(item?.textOriginal || text, 1200);
  const textZh = snippet(item?.textZh || textOriginal, 1200);
  const textEn = snippet(item?.textEn || textOriginal, 1200);
  const id = normalizeText(item?.id || item?.id_str || item?.tweetId).trim();
  const url =
    normalizeText(item?.url).match(/^https?:\/\/(?:x|twitter)\.com\/[^/]+\/status\/\d+/i)?.[0] ||
    (handle && /^\d{8,30}$/.test(id) ? `https://x.com/${handle.slice(1)}/status/${id}` : null);

  if (!text) {
    return null;
  }

  return compactObject({
    id: id || null,
    handle,
    text,
    textOriginal,
    textZh,
    textEn,
    url,
    publishedAt: item?.publishedAt || item?.created_at || item?.createdAt || null,
    type: item?.type === 'reply' || item?.in_reply_to_screen_name ? 'reply' : 'tweet'
  });
}

function normalizePostItems(items, fallbackHandle = null) {
  const seen = new Set();
  return asArray(items)
    .map((item) => normalizePostItem(item, fallbackHandle))
    .filter(Boolean)
    .filter((item) => {
      const key = item.url || item.text;
      if (seen.has(key)) {
        return false;
      }
      seen.add(key);
      return true;
    })
    .sort((left, right) => tweetSortValue(right) - tweetSortValue(left))
    .slice(0, 5);
}

export function parseXRecentPostsFromInitialStateHtml(html, handle) {
  const normalizedHandle = normalizeHandle(handle);
  const jsonText = extractInitialStateJson(html);
  if (!normalizedHandle || !jsonText) {
    return [];
  }

  let state;
  try {
    state = JSON.parse(jsonText);
  } catch {
    return [];
  }

  const userEntities = state?.entities?.users?.entities || state?.entities?.users || {};
  const tweetEntities = state?.entities?.tweets?.entities || state?.entities?.tweets || {};
  const users = Object.entries(userEntities).map(([id, item]) => ({
    id_str: item?.id_str || id,
    ...item
  }));
  const target = users.find((item) => normalizeHandle(item?.screen_name) === normalizedHandle);
  const targetId = target?.id_str || null;
  if (!targetId) {
    return [];
  }

  return normalizePostItems(
    Object.values(tweetEntities)
      .filter((item) => item?.user === targetId || item?.user_id_str === targetId)
      .map((item) => ({
        id: item?.id_str,
        handle: normalizedHandle,
        text: decodeHtmlEntities(item?.full_text || item?.text || ''),
        url: `https://x.com/${normalizedHandle.slice(1)}/status/${item?.id_str}`,
        publishedAt: item?.created_at,
        type: item?.in_reply_to_screen_name ? 'reply' : 'tweet'
      })),
    normalizedHandle
  );
}

export async function fetchPublicXRecentPosts({
  handle,
  fetchImpl = fetch,
  abortSignalTimeout = AbortSignal.timeout,
  timeoutMs = 15000
} = {}) {
  const normalizedHandle = normalizeHandle(handle);
  if (!normalizedHandle) {
    return [];
  }

  const urls = [
    `https://x.com/${normalizedHandle.slice(1)}/with_replies`,
    `https://x.com/${normalizedHandle.slice(1)}`
  ];
  const pages = await Promise.all(
    urls.map((url) =>
      fetchImpl(url, {
        headers: {
          accept: 'text/html',
          'user-agent':
            'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/148 Safari/537.36'
        },
        signal: abortSignalTimeout(timeoutMs)
      })
        .then((response) => (response.ok ? response.text() : ''))
        .catch(() => '')
    )
  );

  return normalizePostItems(
    pages.flatMap((html) => parseXRecentPostsFromInitialStateHtml(html, normalizedHandle)),
    normalizedHandle
  );
}

export class GrokDevPostFetcher {
  constructor(options = {}) {
    this.apiKey = options.apiKey || '';
    this.baseUrl = (options.baseUrl || 'https://api.x.ai/v1').replace(/\/+$/, '');
    this.model = options.model || 'grok-4.3';
    this.fetchImpl = options.fetchImpl || fetch;
    this.timeoutMs = options.timeoutMs ?? 25000;
    this.abortSignalTimeout = options.abortSignalTimeout || AbortSignal.timeout;
  }

  get enabled() {
    return Boolean(this.apiKey);
  }

  async fetch({ handle, row = {}, dev = {} } = {}) {
    const normalizedHandle = normalizeHandle(handle || dev.publicHandle);
    if (!this.enabled || !normalizedHandle) {
      return [];
    }

    const response = await this.fetchImpl(`${this.baseUrl}/responses`, {
      method: 'POST',
      headers: {
        authorization: `Bearer ${this.apiKey}`,
        'content-type': 'application/json',
        accept: 'application/json'
      },
      body: JSON.stringify({
        model: this.model,
        store: false,
        temperature: 0,
        tools: [{ type: 'x_search' }],
        input: [
          {
            role: 'system',
            content: [
              '你是 X 搜索助手，只抓事实，不做投研结论。',
              '搜索指定账号最近 5 条自己发的推文或回复，优先最近 48 小时，其次最近一周。',
              '必须返回 JSON，字段只能是 items。items 每项字段：textOriginal、url、publishedAt、type。',
              'type 只能是 tweet 或 reply；url 必须是 x.com 的 status 链接；抓不到就 items: []。'
            ].join('\n')
          },
          {
            role: 'user',
            content: [
              `账号：${normalizedHandle}`,
              `Token：$${row.symbol || ''} ${row.name || ''} ${row.address || ''}`,
              '请找这个账号最近五条推文或者回复，尤其关注是否提到这个 token、CA、Bankr、Virtuals、fee recipient、claim、buy、support、build。'
            ].join('\n')
          }
        ]
      }),
      signal: this.abortSignalTimeout(this.timeoutMs)
    });

    if (!response.ok) {
      return [];
    }

    const payload = await response.json();
    const parsed = parseJsonContent(extractResponseText(payload, 'Grok dev post fetcher'));
    return normalizePostItems(parsed.items || [], normalizedHandle);
  }
}

function buildFallbackAttitude({ handle, summary, supportLevel = '未确认', items = [] }) {
  const normalizedHandle = normalizeHandle(handle);
  return compactObject({
    handle: normalizedHandle,
    url: xUrlForHandle(normalizedHandle),
    supportLevel,
    summary,
    items: normalizePostItems(items, normalizedHandle),
    updatedAt: new Date().toISOString()
  });
}

function validateDeepSeekAttitude(parsed, posts, handle) {
  const normalizedHandle = normalizeHandle(handle);
  const sourceByUrl = new Map(posts.map((item) => [item.url, item]));
  const items = asArray(parsed?.items)
    .map((item) => {
      const source = sourceByUrl.get(item?.url) || posts.find((post) => post.text === item?.textOriginal) || null;
      if (!source) {
        return null;
      }
      return compactObject({
        textOriginal: snippet(item.textOriginal || source.text, 1200),
        textZh: snippet(item.textZh || source.text, 1200),
        textEn: snippet(item.textEn || source.text, 1200),
        url: source.url,
        publishedAt: source.publishedAt,
        type: source.type
      });
    })
    .filter(Boolean)
    .slice(0, 5);

  return compactObject({
    handle: normalizedHandle,
    url: xUrlForHandle(normalizedHandle),
    supportLevel: snippet(parsed?.supportLevel || '未确认', 40),
    summary: snippet(parsed?.summary || '已抓取 dev 最近内容，但没有形成明确支持 token 的判断。', 800),
    items,
    updatedAt: new Date().toISOString()
  });
}

export class DeepSeekDevTweetAttitudeAnalyzer {
  constructor(options = {}) {
    this.apiKey = options.apiKey || '';
    this.baseUrl = (options.baseUrl || 'https://api.deepseek.com').replace(/\/+$/, '');
    this.model = options.model || 'deepseek-v4-flash';
    this.fetchImpl = options.fetchImpl || fetch;
    this.timeoutMs = options.timeoutMs ?? 20000;
    this.abortSignalTimeout = options.abortSignalTimeout || AbortSignal.timeout;
    this.xPostFetcher =
      options.xPostFetcher ||
      ((input) =>
        fetchPublicXRecentPosts({
          ...input,
          fetchImpl: this.fetchImpl,
          abortSignalTimeout: this.abortSignalTimeout,
          timeoutMs: Math.min(this.timeoutMs, 15000)
        }));
    this.searchPostFetcher = options.searchPostFetcher || null;
  }

  get enabled() {
    return Boolean(this.apiKey);
  }

  async analyze({ row = {}, dev = {}, sources = {} } = {}) {
    const handle = normalizeHandle(
      dev.publicHandle ||
        dev.feeRecipientHandle ||
        sources.bankr?.feeRecipientHandle ||
        sources.virtuals?.creatorTwitterHandle ||
        sources.virtuals?.projectTwitterHandle
    );
    if (!handle) {
      return buildFallbackAttitude({
        handle: null,
        summary: '没有确认到 dev X 账号，无法抓取最近推文或回复判断态度。',
        items: []
      });
    }

    const searchPosts = await Promise.resolve(
      typeof this.searchPostFetcher === 'function'
        ? this.searchPostFetcher({ handle, row, dev, sources })
        : this.searchPostFetcher?.fetch?.({ handle, row, dev, sources })
    ).catch(() => []);
    const sourcePosts =
      asArray(searchPosts).length >= 5
        ? []
        : await this.xPostFetcher({ handle, row, dev, sources }).catch(() => []);
    const posts = normalizePostItems([...sourcePosts, ...asArray(searchPosts)], handle);

    if (!posts.length) {
      return buildFallbackAttitude({
        handle,
        summary: '没有抓到 dev 最近五条推文或回复，暂时无法判断他是否支持这个 token。',
        items: []
      });
    }

    if (!this.enabled) {
      return buildFallbackAttitude({
        handle,
        supportLevel: '待判断',
        summary: '已抓到 dev 最近内容，但 DeepSeek 未启用，暂未做中英文整理和态度判断。',
        items: posts.map((item) => ({
          textOriginal: item.text,
          textZh: item.text,
          textEn: item.text,
          ...item
        }))
      });
    }

    try {
      const response = await this.fetchImpl(`${this.baseUrl}/chat/completions`, {
        method: 'POST',
        headers: {
          authorization: `Bearer ${this.apiKey}`,
          'content-type': 'application/json',
          accept: 'application/json'
        },
        body: JSON.stringify({
          model: this.model,
          response_format: { type: 'json_object' },
          thinking: { type: 'disabled' },
          temperature: 0,
          messages: [
            {
              role: 'system',
              content: [
                '你是 crypto X 动态整理员，只根据给定 posts 判断 dev 对 token 的态度。',
                '不要新增事实，不要猜测没出现的承诺，不要投资建议。',
                '输出 JSON，字段只能是 summary、supportLevel、items。',
                'supportLevel 只能选：明确支持、疑似支持、中性、否认或反对、未确认。',
                'summary 用中文一句话说明 dev 有没有支持 token 的意思，必须区分“明确说了”和“没提”。',
                'items 最多 5 条；每条保留原文 textOriginal，同时给 textZh 中文和 textEn 英文；url 必须沿用输入 URL。'
              ].join('\n')
            },
            {
              role: 'user',
              content: JSON.stringify({
                token: {
                  chain: 'base',
                  address: row.address,
                  symbol: row.symbol,
                  name: row.name
                },
                dev: {
                  handle,
                  identityStatus: dev.identityStatus,
                  publicName: dev.publicName
                },
                posts
              })
            }
          ]
        }),
        signal: this.abortSignalTimeout(this.timeoutMs)
      });

      if (!response.ok) {
        return buildFallbackAttitude({
          handle,
          supportLevel: '待判断',
          summary: `已抓到 dev 最近内容，但态度整理请求失败，HTTP ${response.status}。先展示原文，暂未判断是否支持这个 token。`,
          items: posts
        });
      }

      const payload = await response.json();
      const parsed = parseJsonContent(extractResponseText(payload, 'DeepSeek dev tweet attitude'));
      return validateDeepSeekAttitude(parsed, posts, handle);
    } catch {
      return buildFallbackAttitude({
        handle,
        supportLevel: '待判断',
        summary: '已抓到 dev 最近内容，但态度整理失败。先展示原文，暂未判断是否支持这个 token。',
        items: posts
      });
    }
  }
}

export function createDevTweetAttitudeAnalyzerFromEnv(env = process.env) {
  if (env.DEV_TWEET_ATTITUDE_ENABLED === '0') {
    return null;
  }
  if (!env.DEEPSEEK_API_KEY) {
    return null;
  }

  const searchPostFetcher = env.GROK_API_KEY
    ? new GrokDevPostFetcher({
        apiKey: env.GROK_API_KEY,
        baseUrl: env.GROK_BASE_URL || 'https://api.x.ai/v1',
        model: env.GROK_MODEL || 'grok-4.3',
        timeoutMs: env.DEV_TWEET_SEARCH_TIMEOUT_MS ? Number(env.DEV_TWEET_SEARCH_TIMEOUT_MS) : undefined
      })
    : null;

  return new DeepSeekDevTweetAttitudeAnalyzer({
    apiKey: env.DEEPSEEK_API_KEY,
    baseUrl: env.DEEPSEEK_BASE_URL || 'https://api.deepseek.com',
    model: env.DEEPSEEK_TWEET_MODEL || env.DEEPSEEK_FORMAT_MODEL || 'deepseek-v4-flash',
    timeoutMs: env.DEEPSEEK_TWEET_TIMEOUT_MS
      ? Number(env.DEEPSEEK_TWEET_TIMEOUT_MS)
      : env.DEEPSEEK_FORMAT_TIMEOUT_MS
        ? Number(env.DEEPSEEK_FORMAT_TIMEOUT_MS)
        : undefined,
    searchPostFetcher
  });
}
