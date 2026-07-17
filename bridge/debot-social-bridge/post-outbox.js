const DEFAULT_STORAGE_KEY = 'debotSocialPostOutboxV1';
const DEFAULT_MAX_RECORDS = 1_000;
const DEFAULT_MAX_BYTES = 4 * 1024 * 1024;
const DEFAULT_BATCH_LIMIT = 200;
const SCHEMA_VERSION = 1;

function text(value, maximum) {
  return String(value ?? '').slice(0, maximum);
}

function number(value) {
  const result = Number(value);
  return Number.isFinite(result) ? result : 0;
}

// The outbox accepts sanitized posts, then projects them onto the same narrow
// schema before persistence so credentials, raw responses and future private
// fields can never be copied into extension storage by accident.
function persistedPost(value) {
  const post = value && typeof value === 'object' ? value : {};
  const author = post.author && typeof post.author === 'object' ? post.author : {};
  return {
    source: text(post.source, 40),
    externalId: text(post.externalId, 240),
    kind: text(post.kind, 20),
    author: {
      id: text(author.id, 240),
      handle: text(author.handle, 240),
      name: text(author.name, 500),
      avatarUrl: text(author.avatarUrl, 2_000),
      followersCount: number(author.followersCount)
    },
    content: text(post.content, 100_000),
    translatedContent: text(post.translatedContent, 100_000),
    url: text(post.url, 2_000),
    media: (Array.isArray(post.media) ? post.media : []).slice(0, 12).map((item) => ({
      type: text(item?.type, 20),
      url: text(item?.url, 2_000),
      previewUrl: text(item?.previewUrl, 2_000)
    })),
    contractAddresses: (Array.isArray(post.contractAddresses) ? post.contractAddresses : [])
      .slice(0, 32)
      .map((item) => ({
        address: text(item?.address, 100),
        chain: text(item?.chain, 20)
      })),
    chainTags: (Array.isArray(post.chainTags) ? post.chainTags : [])
      .slice(0, 20)
      .map((item) => text(item, 20)),
    replyToExternalId: text(post.replyToExternalId, 240),
    quotedExternalId: text(post.quotedExternalId, 240),
    repostExternalId: text(post.repostExternalId, 240),
    publishedAt: number(post.publishedAt),
    receivedAt: number(post.receivedAt),
    sourceUpdatedAt: number(post.sourceUpdatedAt),
    deleted: post.deleted === true,
    deletedAt: post.deletedAt === null || post.deletedAt === undefined
      ? null
      : number(post.deletedAt),
    feedSources: (Array.isArray(post.feedSources) ? post.feedSources : [])
      .slice(0, 3)
      .map((item) => text(item, 20))
  };
}

function stableStringify(value) {
  if (value === null || typeof value !== 'object') return JSON.stringify(value);
  if (Array.isArray(value)) return `[${value.map(stableStringify).join(',')}]`;
  const keys = Object.keys(value).sort();
  return `{${keys.map((key) => `${JSON.stringify(key)}:${stableStringify(value[key])}`).join(',')}}`;
}

function versionValue(post) {
  // receivedAt describes when this browser observed a post, not a source
  // revision. Excluding it prevents every polling pass from creating a copy.
  const { receivedAt: _receivedAt, ...sourceVersion } = post;
  return sourceVersion;
}

// Two seeded FNV-1a passes provide a deterministic, dependency-free 64-bit-ish
// fingerprint. It is used for local identity only, never for security.
function lightweightHash(value) {
  const input = String(value);
  let first = 0x811c9dc5;
  let second = 0x9e3779b9;
  for (let index = 0; index < input.length; index += 1) {
    const code = input.charCodeAt(index);
    first ^= code;
    first = Math.imul(first, 0x01000193);
    second ^= code;
    second = Math.imul(second, 0x85ebca6b);
  }
  return `${(first >>> 0).toString(16).padStart(8, '0')}${(second >>> 0).toString(16).padStart(8, '0')}`;
}

function utf8Bytes(value) {
  let bytes = 0;
  for (let index = 0; index < value.length; index += 1) {
    const code = value.charCodeAt(index);
    if (code < 0x80) {
      bytes += 1;
    } else if (code < 0x800) {
      bytes += 2;
    } else if (code >= 0xd800 && code <= 0xdbff
      && value.charCodeAt(index + 1) >= 0xdc00
      && value.charCodeAt(index + 1) <= 0xdfff) {
      bytes += 4;
      index += 1;
    } else {
      bytes += 3;
    }
  }
  return bytes;
}

function emptyState() {
  return { schemaVersion: SCHEMA_VERSION, nextSequence: 1, records: [] };
}

function normalizeState(value) {
  if (!value || typeof value !== 'object' || !Array.isArray(value.records)) return emptyState();
  const records = [];
  const seenKeys = new Set();
  for (const candidate of value.records) {
    if (!candidate || typeof candidate !== 'object') continue;
    const post = persistedPost(candidate.post);
    if (!post.source || !post.externalId) continue;
    const key = text(candidate.key, 160);
    if (!key || seenKeys.has(key)) continue;
    seenKeys.add(key);
    records.push({
      key,
      source: post.source,
      externalId: post.externalId,
      fingerprint: lightweightHash(stableStringify(versionValue(post))),
      enqueuedAt: Math.max(0, number(candidate.enqueuedAt)),
      sequence: Math.max(1, Math.trunc(number(candidate.sequence))),
      post
    });
  }
  records.sort((left, right) => left.sequence - right.sequence
    || left.enqueuedAt - right.enqueuedAt
    || left.key.localeCompare(right.key));
  const highestSequence = records.reduce((maximum, record) => Math.max(maximum, record.sequence), 0);
  return {
    schemaVersion: SCHEMA_VERSION,
    nextSequence: Math.max(highestSequence + 1, Math.trunc(number(value.nextSequence)) || 1),
    records
  };
}

function validatePositiveInteger(value, fallback, name) {
  const resolved = value === undefined ? fallback : Number(value);
  if (!Number.isSafeInteger(resolved) || resolved <= 0) {
    throw new TypeError(`${name} must be a positive integer`);
  }
  return resolved;
}

export function createPostOutbox({
  storage,
  storageKey = DEFAULT_STORAGE_KEY,
  maxRecords = DEFAULT_MAX_RECORDS,
  maxBytes = DEFAULT_MAX_BYTES,
  now = Date.now
} = {}) {
  if (!storage || typeof storage.get !== 'function' || typeof storage.set !== 'function') {
    throw new TypeError('storage must provide asynchronous get and set methods');
  }
  const resolvedStorageKey = text(storageKey, 160);
  if (!resolvedStorageKey) throw new TypeError('storageKey is required');
  const resolvedMaxRecords = validatePositiveInteger(maxRecords, DEFAULT_MAX_RECORDS, 'maxRecords');
  const resolvedMaxBytes = validatePositiveInteger(maxBytes, DEFAULT_MAX_BYTES, 'maxBytes');
  if (typeof now !== 'function') throw new TypeError('now must be a function');

  let operationQueue = Promise.resolve();

  function serialize(operation) {
    const result = operationQueue.then(operation, operation);
    operationQueue = result.catch(() => {});
    return result;
  }

  async function load() {
    const stored = await storage.get(resolvedStorageKey);
    return normalizeState(stored?.[resolvedStorageKey]);
  }

  function stateBytes(state) {
    return utf8Bytes(JSON.stringify({ [resolvedStorageKey]: state }));
  }

  async function persist(state) {
    await storage.set({ [resolvedStorageKey]: state });
  }

  function uniqueRecordKey(state, post, fingerprint) {
    const identity = lightweightHash(`${post.source}\u001f${post.externalId}`);
    const base = `p1_${identity}_${fingerprint}`;
    if (!state.records.some((record) => record.key === base)) return base;
    let suffix = 2;
    while (state.records.some((record) => record.key === `${base}_${suffix}`)) suffix += 1;
    return `${base}_${suffix}`;
  }

  return Object.freeze({
    enqueue(posts) {
      return serialize(async () => {
        const input = Array.isArray(posts) ? posts : [posts];
        const state = await load();
        let added = 0;
        let duplicates = 0;
        let rejected = 0;
        let overflow = 0;
        const acceptedKeys = [];

        for (const value of input) {
          const post = persistedPost(value);
          if (!post.source || !post.externalId) {
            rejected += 1;
            continue;
          }
          const fingerprint = lightweightHash(stableStringify(versionValue(post)));
          const duplicate = state.records.some((record) => record.source === post.source
            && record.externalId === post.externalId
            && record.fingerprint === fingerprint);
          if (duplicate) {
            duplicates += 1;
            continue;
          }
          const key = uniqueRecordKey(state, post, fingerprint);
          const record = {
            key,
            source: post.source,
            externalId: post.externalId,
            fingerprint,
            enqueuedAt: Math.max(0, number(now())),
            sequence: state.nextSequence,
            post
          };
          state.records.push(record);
          if (state.records.length > resolvedMaxRecords || stateBytes(state) > resolvedMaxBytes) {
            state.records.pop();
            overflow += 1;
            continue;
          }
          state.nextSequence += 1;
          acceptedKeys.push(key);
          added += 1;
        }

        const bytes = stateBytes(state);
        if (added) await persist(state);
        return {
          added,
          duplicates,
          rejected,
          overflow,
          queued: state.records.length,
          bytes,
          keys: acceptedKeys
        };
      });
    },

    readBatch(limit = DEFAULT_BATCH_LIMIT) {
      return serialize(async () => {
        const resolvedLimit = validatePositiveInteger(limit, DEFAULT_BATCH_LIMIT, 'limit');
        const state = await load();
        const records = state.records.slice(0, Math.min(resolvedLimit, resolvedMaxRecords)).map((record) => ({
          key: record.key,
          enqueuedAt: record.enqueuedAt,
          post: record.post
        }));
        return {
          records,
          count: records.length,
          queued: state.records.length,
          remaining: state.records.length - records.length
        };
      });
    },

    acknowledge(keys) {
      return serialize(async () => {
        const requested = new Set((Array.isArray(keys) ? keys : [keys])
          .map((key) => text(key, 160))
          .filter(Boolean));
        const state = await load();
        const previousCount = state.records.length;
        state.records = state.records.filter((record) => !requested.has(record.key));
        const acknowledged = previousCount - state.records.length;
        if (acknowledged) await persist(state);
        return {
          acknowledged,
          queued: state.records.length,
          bytes: stateBytes(state)
        };
      });
    },

    stats() {
      return serialize(async () => {
        const state = await load();
        return { queued: state.records.length, bytes: stateBytes(state) };
      });
    }
  });
}

export const POST_OUTBOX_LIMITS = Object.freeze({
  maxRecords: DEFAULT_MAX_RECORDS,
  maxBytes: DEFAULT_MAX_BYTES,
  defaultBatchLimit: DEFAULT_BATCH_LIMIT
});
