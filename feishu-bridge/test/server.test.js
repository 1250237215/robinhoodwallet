import assert from 'node:assert/strict';
import { EventEmitter } from 'node:events';
import test from 'node:test';

import { createMonitorServer } from '../src/server.js';

class StubMonitor extends EventEmitter {
  constructor() {
    super();
    this.refreshCount = 0;
    this.stopped = false;
  }

  snapshot() {
    return {
      status: 'live',
      people: [{ id: 'sen', name: 'Sen', messages: [] }],
      refreshCount: this.refreshCount
    };
  }

  async refresh() {
    this.refreshCount += 1;
    return this.snapshot();
  }

  stop() {
    this.stopped = true;
  }
}

async function startServer(t, options = {}) {
  const monitor = new StubMonitor();
  const server = createMonitorServer(monitor, options);
  await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
  t.after(async () => {
    await new Promise((resolve) => server.close(resolve));
    assert.equal(monitor.stopped, true);
  });
  const { port } = server.address();
  return { monitor, baseUrl: `http://127.0.0.1:${port}` };
}

test('snapshot and manual refresh expose the current Feishu monitor state', async (t) => {
  const { baseUrl } = await startServer(t);
  const snapshot = await fetch(`${baseUrl}/api/snapshot`);
  assert.equal(snapshot.status, 200);
  assert.deepEqual(await snapshot.json(), {
    status: 'live',
    people: [{ id: 'sen', name: 'Sen', messages: [] }],
    refreshCount: 0
  });

  const refreshed = await fetch(`${baseUrl}/api/refresh`, { method: 'POST' });
  assert.equal(refreshed.status, 200);
  assert.equal((await refreshed.json()).refreshCount, 1);
});

test('CA watch rules are readable, writable, and reject invalid methods', async (t) => {
  let enabled = false;
  let selectedPersonIds = [];
  const caWatch = {
    snapshot() {
      return { enabled, selected_person_ids: selectedPersonIds };
    },
    update(value) {
      enabled = value.enabled === true;
      selectedPersonIds = value.person_ids;
      return this.snapshot();
    }
  };
  const { baseUrl } = await startServer(t, { caWatch });

  const saved = await fetch(`${baseUrl}/api/ca-watch`, {
    method: 'PUT',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ enabled: true, person_ids: ['sen'] })
  });
  assert.equal(saved.status, 200);
  assert.deepEqual(await saved.json(), { enabled: true, selected_person_ids: ['sen'] });

  const read = await fetch(`${baseUrl}/api/ca-watch`);
  assert.deepEqual(await read.json(), { enabled: true, selected_person_ids: ['sen'] });

  const rejected = await fetch(`${baseUrl}/api/ca-watch`, { method: 'POST' });
  assert.equal(rejected.status, 405);
});
