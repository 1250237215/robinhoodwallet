const DEFAULT_STORAGE_KEY = 'debotAnalysisResultOutboxV1';
const DEFAULT_MAX_RECORDS = 200;
const DEFAULT_MAX_BYTES = 2 * 1024 * 1024;
const DEFAULT_BATCH_LIMIT = 20;
const SCHEMA_VERSION = 1;

function text(value, maximum) {
  return String(value ?? '').slice(0, maximum);
}

function number(value) {
  const result = Number(value);
  return Number.isFinite(result) ? result : 0;
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

function cloneJson(value) {
  try {
    return JSON.parse(JSON.stringify(value ?? null));
  } catch {
    return null;
  }
}

function persistedResult(value) {
  const candidate = value && typeof value === 'object' ? value : {};
  const jobId = Number(candidate.jobId);
  const claimToken = text(candidate.claimToken, 240);
  const success = candidate.success === true;
  return {
    jobId: Number.isSafeInteger(jobId) && jobId > 0 ? jobId : 0,
    claimToken,
    success,
    result: success ? cloneJson(candidate.result) : null,
    error: success ? '' : text(candidate.error, 2_000),
    errorType: success ? '' : text(candidate.errorType, 40)
  };
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
    const payload = persistedResult(candidate.payload);
    if (!payload.jobId || !payload.claimToken) continue;
    const key = `${payload.jobId}:${payload.claimToken}`;
    if (seenKeys.has(key)) continue;
    seenKeys.add(key);
    records.push({
      key,
      jobId: payload.jobId,
      claimToken: payload.claimToken,
      sequence: Math.max(1, Math.trunc(number(candidate.sequence))),
      enqueuedAt: Math.max(0, number(candidate.enqueuedAt)),
      payload
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

export function createAnalysisResultOutbox({
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

  return Object.freeze({
    enqueue(value) {
      return serialize(async () => {
        const payload = persistedResult(value);
        if (!payload.jobId || !payload.claimToken || (payload.success && payload.result === null)) {
          return { added: 0, duplicates: 0, rejected: 1, overflow: 0, queued: (await load()).records.length };
        }
        const state = await load();
        const key = `${payload.jobId}:${payload.claimToken}`;
        const duplicate = state.records.some((record) => record.key === key);
        if (duplicate) {
          return { added: 0, duplicates: 1, rejected: 0, overflow: 0, queued: state.records.length, key };
        }

        // A newer lease for the same job supersedes an undelivered stale result.
        const persistedRecordCount = state.records.length;
        const persistedBytes = stateBytes(state);
        state.records = state.records.filter((record) => record.jobId !== payload.jobId);
        const record = {
          key,
          jobId: payload.jobId,
          claimToken: payload.claimToken,
          sequence: state.nextSequence,
          enqueuedAt: Math.max(0, number(now())),
          payload
        };
        state.records.push(record);
        if (state.records.length > resolvedMaxRecords || stateBytes(state) > resolvedMaxBytes) {
          state.records.pop();
          return {
            added: 0,
            duplicates: 0,
            rejected: 0,
            overflow: 1,
            queued: persistedRecordCount,
            bytes: persistedBytes
          };
        }
        state.nextSequence += 1;
        await persist(state);
        return {
          added: 1,
          duplicates: 0,
          rejected: 0,
          overflow: 0,
          queued: state.records.length,
          bytes: stateBytes(state),
          key
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
          payload: record.payload
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
        const requested = new Set((Array.isArray(keys) ? keys : [keys]).map((key) => text(key, 500)).filter(Boolean));
        const state = await load();
        const previousCount = state.records.length;
        state.records = state.records.filter((record) => !requested.has(record.key));
        const acknowledged = previousCount - state.records.length;
        if (acknowledged) await persist(state);
        return { acknowledged, queued: state.records.length, bytes: stateBytes(state) };
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

export const ANALYSIS_RESULT_OUTBOX_LIMITS = Object.freeze({
  maxRecords: DEFAULT_MAX_RECORDS,
  maxBytes: DEFAULT_MAX_BYTES,
  defaultBatchLimit: DEFAULT_BATCH_LIMIT
});
