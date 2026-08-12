import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';

import { extractContractAddresses, FeishuCaWatch } from '../src/ca-watch.js';

test('extracts EVM and canonical Solana contract addresses in message order', () => {
  const evm = '0xaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa';
  const solana = '63zfjPfH4uaX3TQZoD35WqUrqiuCQQWndMTxQHsJpump';
  assert.deepEqual(extractContractAddresses(`${solana}\n${evm}\n${evm}`), [solana, evm]);
});

test('resolves message CA links independently from Bark watch selection', async () => {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'feishu-links-'));
  const watch = new FeishuCaWatch({
    dataFile: path.join(directory, 'watch.json'),
    rpcProfiles: [],
    fetchImpl: async () => { throw new Error('Solana does not require RPC'); }
  });
  const address = '63zfjPfH4uaX3TQZoD35WqUrqiuCQQWndMTxQHsJpump';
  assert.deepEqual(await watch.resolveLinks(`new CA ${address}`), {
    contractAddresses: [address],
    contractChains: ['solana'],
    debotUrls: [`https://debot.ai/token/solana/289942_${address}`]
  });
  fs.rmSync(directory, { recursive: true, force: true });
});

test('selected people trigger one CA Bark only for messages after bootstrap', async () => {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'feishu-watch-'));
  const requests = [];
  const watch = new FeishuCaWatch({
    people: [{ id: 'sen', name: 'Sen', shortName: 'S', source: 'Sen' }],
    dataFile: path.join(directory, 'watch.json'),
    internalUrl: 'http://127.0.0.1/internal/feishu-bark',
    internalToken: 'x'.repeat(48),
    rpcProfiles: [],
    async fetchImpl(url, options) {
      requests.push({ url, options });
      return { ok: true, async json() { return { delivery: { sent: 1 } }; } };
    }
  });
  watch.update({ enabled: true, person_ids: ['sen'] });
  const message = (id, content) => ({ id, personId: 'sen', personName: 'Sen', source: 'Sen', content, url: '' });
  watch.observe({ people: [{ messages: [message('old', '0xaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa')] }] });
  watch.observe({ people: [{ messages: [
    message('new', '63zfjPfH4uaX3TQZoD35WqUrqiuCQQWndMTxQHsJpump'),
    message('old', '0xaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa')
  ] }] });
  await watch.queue;
  assert.equal(requests.length, 1);
  assert.equal(requests[0].url, 'http://127.0.0.1/internal/feishu-bark');
  const payload = JSON.parse(requests[0].options.body);
  assert.deepEqual(payload.contractChains, ['solana']);
  assert.equal(payload.debotUrls[0], 'https://debot.ai/token/solana/289942_63zfjPfH4uaX3TQZoD35WqUrqiuCQQWndMTxQHsJpump');
  fs.rmSync(directory, { recursive: true, force: true });
});
