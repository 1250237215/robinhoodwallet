const STORAGE_KEY = 'debotWalletEventOutboxV1';
const ADDRESS = /^0x[0-9a-f]{40}$/;
const HASH = /^0x[0-9a-f]{64}$/;

function normalize(value) {
  const event = value && typeof value === 'object' ? value : {};
  const chain = String(event.chain || '').toLowerCase();
  const walletAddress = String(event.walletAddress || '').toLowerCase();
  const tokenAddress = String(event.tokenAddress || '').toLowerCase();
  const txHash = String(event.txHash || '').toLowerCase();
  if (!['robinhood', 'base', 'bsc'].includes(chain)
    || !ADDRESS.test(walletAddress) || !ADDRESS.test(tokenAddress) || !HASH.test(txHash)) return null;
  return {
    chain,
    walletAddress,
    tokenAddress,
    txHash,
    operation: 'buy',
    tokenSymbol: String(event.tokenSymbol || '').slice(0, 80),
    tokenName: String(event.tokenName || '').slice(0, 160),
    rawTokenAmount: String(event.rawTokenAmount || '').slice(0, 120),
    tokenAmount: String(event.tokenAmount || '').slice(0, 120),
    tokenDecimals: Math.max(0, Math.min(255, Number(event.tokenDecimals) || 18)),
    blockNumber: Math.max(0, Number(event.blockNumber) || 0),
    blockTimestamp: Math.max(0, Number(event.blockTimestamp) || 0),
    logIndex: Math.max(0, Number(event.logIndex) || 0),
    source: 'debot-wallet-track',
    discoveredAt: Math.max(0, Number(event.discoveredAt) || Date.now())
  };
}

export function createWalletEventOutbox({ storage, maxRecords = 1000 } = {}) {
  let queue = Promise.resolve();
  const serialize = (operation) => {
    const result = queue.then(operation, operation);
    queue = result.catch(() => {});
    return result;
  };
  const load = async () => {
    const saved = await storage.get(STORAGE_KEY);
    return Array.isArray(saved?.[STORAGE_KEY]) ? saved[STORAGE_KEY] : [];
  };
  const save = (records) => storage.set({ [STORAGE_KEY]: records });
  return Object.freeze({
    enqueue(values) {
      return serialize(async () => {
        const records = await load();
        const keys = new Set(records.map((record) => record.key));
        let added = 0;
        for (const candidate of Array.isArray(values) ? values : [values]) {
          const event = normalize(candidate);
          if (!event) continue;
          const key = `${event.chain}:${event.txHash}:${event.walletAddress}:${event.tokenAddress}`;
          if (keys.has(key) || records.length >= maxRecords) continue;
          keys.add(key);
          records.push({ key, event, enqueuedAt: Date.now() });
          added += 1;
        }
        if (added) await save(records);
        return { added, queued: records.length, durable: true };
      });
    },
    readBatch(limit = 100) {
      return serialize(async () => (await load()).slice(0, Math.max(1, limit)));
    },
    acknowledge(keys) {
      return serialize(async () => {
        const remove = new Set(keys);
        const records = (await load()).filter((record) => !remove.has(record.key));
        await save(records);
        return { queued: records.length };
      });
    }
  });
}
