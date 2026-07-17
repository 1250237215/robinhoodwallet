import { createSocialStore } from './store.js';

function connectionState(config, bridge, now) {
  const paired = Boolean(config.bridgeToken);
  const lastSeenAt = bridge.lastSeenAt;
  const fresh = lastSeenAt !== null && now - lastSeenAt <= config.bridgeOfflineMs;
  const reportedError = fresh && Array.isArray(bridge.capabilities) &&
    bridge.capabilities.some((capability) => String(capability).trim().toLowerCase() === 'error');
  const online = paired && fresh && !reportedError;
  return {
    state: !paired ? 'unpaired' : reportedError ? 'error' : online ? 'online' : 'offline',
    paired,
    online,
    readOnly: !paired,
    lastSeenAt,
    bridgeId: bridge.bridgeId,
    version: bridge.version,
    capabilities: bridge.capabilities
  };
}

export function createSocialService({ config, store = null, now = () => Date.now() }) {
  if (!config) throw new TypeError('Social config is required');
  const activeStore = store || createSocialStore(config.dataFile, { now });
  const subscribers = new Set();
  let cleanupTimer = null;
  let closed = false;

  function publish(change) {
    for (const subscriber of subscribers) {
      try {
        subscriber(change);
      } catch {
        // One disconnected SSE client must not interrupt ingestion.
      }
    }
  }

  function publishAfter(latestBefore) {
    const changes = activeStore.listChanges({ after: latestBefore, limit: 1_000 });
    for (const change of changes) publish(change);
    return changes;
  }

  const service = {
    config: {
      dataFile: config.dataFile,
      retentionDays: config.retentionDays,
      bridgeOfflineMs: config.bridgeOfflineMs,
      commandLeaseMs: config.commandLeaseMs
    },
    store: activeStore,
    get paired() {
      return Boolean(config.bridgeToken);
    },
    getConnection() {
      return connectionState(config, activeStore.getBridgeState(), now());
    },
    getSnapshot({ postLimit = 50 } = {}) {
      return {
        ok: true,
        status: 'ready',
        bridge: service.getConnection(),
        counts: activeStore.getCounts(),
        posts: activeStore.listPosts({ limit: postLimit }),
        watchlist: activeStore.listWatchlist(),
        latestChangeId: activeStore.getLatestChangeId(),
        retention: { days: config.retentionDays },
        serverTime: now()
      };
    },
    listPosts(filters) {
      return activeStore.listPosts(filters);
    },
    listWatchlist(filters) {
      return activeStore.listWatchlist(filters);
    },
    addWatchAccounts(accounts) {
      const latestBefore = activeStore.getLatestChangeId();
      const results = activeStore.addWatchAccounts(accounts);
      publishAfter(latestBefore);
      return {
        ok: true,
        entries: results.map((result) => result.entry),
        commands: results.map((result) => result.command).filter(Boolean),
        counts: activeStore.getCounts()
      };
    },
    removeWatchAccount(id) {
      const latestBefore = activeStore.getLatestChangeId();
      const result = activeStore.removeWatchAccount(id);
      publishAfter(latestBefore);
      return result ? { ok: true, ...result, counts: activeStore.getCounts() } : null;
    },
    ingestPosts(posts) {
      const latestBefore = activeStore.getLatestChangeId();
      const results = activeStore.upsertPosts(posts);
      const changes = publishAfter(latestBefore);
      const summary = { created: 0, updated: 0, deleted: 0, restored: 0, unchanged: 0 };
      for (const result of results) summary[result.action] += 1;
      return {
        ok: true,
        summary,
        posts: results.map((result) => result.post),
        changes,
        counts: activeStore.getCounts()
      };
    },
    deletePost(source, externalId, deletedAt) {
      const latestBefore = activeStore.getLatestChangeId();
      const result = activeStore.deletePost(source, externalId, deletedAt);
      publishAfter(latestBefore);
      return { ok: true, ...result, counts: activeStore.getCounts() };
    },
    heartbeat(body) {
      const bridge = activeStore.recordBridgeHeartbeat(body);
      return {
        ok: true,
        bridge: connectionState(config, bridge, now()),
        counts: activeStore.getCounts(),
        serverTime: now()
      };
    },
    reconcileWatchlist(accounts) {
      const latestBefore = activeStore.getLatestChangeId();
      const result = activeStore.reconcileRemoteWatchlist(accounts);
      publishAfter(latestBefore);
      return { ok: true, ...result, counts: activeStore.getCounts() };
    },
    claimCommands(options = {}) {
      return {
        ok: true,
        commands: activeStore.claimCommands({
          ...options,
          leaseMs: config.commandLeaseMs
        }),
        serverTime: now()
      };
    },
    acknowledgeCommand(id, result) {
      const latestBefore = activeStore.getLatestChangeId();
      const command = activeStore.acknowledgeCommand(id, result);
      publishAfter(latestBefore);
      return command ? { ok: true, command, counts: activeStore.getCounts() } : null;
    },
    listChanges(options) {
      return activeStore.listChanges(options);
    },
    subscribe(listener) {
      if (typeof listener !== 'function') throw new TypeError('Social subscriber must be a function');
      subscribers.add(listener);
      return () => subscribers.delete(listener);
    },
    cleanup() {
      return activeStore.cleanup({ retentionDays: config.retentionDays });
    },
    start() {
      if (cleanupTimer || closed) return;
      service.cleanup();
      cleanupTimer = setInterval(() => service.cleanup(), config.cleanupIntervalMs);
      cleanupTimer.unref?.();
    },
    close() {
      if (closed) return;
      closed = true;
      if (cleanupTimer) clearInterval(cleanupTimer);
      cleanupTimer = null;
      subscribers.clear();
      activeStore.close();
    }
  };
  return service;
}
