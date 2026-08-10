import assert from 'node:assert/strict';
import test from 'node:test';

import { PEOPLE } from '../src/config.js';
import { extractImageResources, extractMessages, mergeMessages, PeopleMonitor } from '../src/monitor.js';
import { normalizeRawMessage } from '../src/lark-client.js';

function raw(overrides = {}) {
  return {
    message_id: overrides.message_id || `om_${Math.random()}`,
    message_position: overrides.message_position || '100',
    create_time: overrides.create_time || '2026-08-10 10:00',
    content: overrides.content || 'hello',
    msg_type: overrides.msg_type || 'text',
    message_app_link: overrides.message_app_link || 'https://applink.feishu.cn/example',
    sender: overrides.sender || {},
    ...overrides
  };
}

test('extracts each monitored speaker with the correct source rule', () => {
  const byId = new Map(PEOPLE.map((person) => [person.id, person]));

  const crazyMessages = extractMessages(
    [byId.get('daqi'), byId.get('luck'), byId.get('lu')],
    [
      raw({ message_id: 'daqi', content: '【大齐】：\n看懂了' }),
      raw({ message_id: 'luck', content: '【luck(发财版】：\n就对了' }),
      raw({ message_id: 'lu', content: '【LU】：\n奶蛙更纯粹一点' }),
      raw({ message_id: 'other', content: '【其他人】：\n不应出现' })
    ]
  );
  assert.equal(crazyMessages.get('daqi')[0].content, '看懂了');
  assert.equal(crazyMessages.get('luck')[0].content, '就对了');
  assert.equal(crazyMessages.get('lu')[0].content, '奶蛙更纯粹一点');

  const laserMessages = extractMessages(
    [byId.get('lasercat'), byId.get('mrdq')],
    [
      raw({ message_id: 'laser', content: '奥德赛', sender: { tenant_key: '12fa9ae1ea0f5740' } }),
      raw({ message_id: 'mrdq', content: '【#144 MrDQ 🐒🦄🔥】：\n有孩哥真好', sender: { tenant_key: 'other' } })
    ]
  );
  assert.equal(laserMessages.get('lasercat')[0].content, '奥德赛');
  assert.equal(laserMessages.get('mrdq')[0].content, '有孩哥真好');
});

test('mergeMessages deduplicates, sorts newest first, and applies the limit', () => {
  const messages = Array.from({ length: 12 }, (_, index) => ({
    id: `m${index}`,
    createdAt: `2026-08-10 10:${String(index).padStart(2, '0')}`,
    position: String(index)
  }));
  const merged = mergeMessages([messages[0]], [...messages, messages[0]], 10);
  assert.equal(merged.length, 10);
  assert.equal(merged[0].id, 'm11');
  assert.equal(merged.at(-1).id, 'm2');
});

test('extracts image and image-sticker resources while keeping surrounding text', () => {
  assert.deepEqual(extractImageResources('[Image: img_v3_first]\n![Image](img_v3_second)'), [
    { type: 'image', resourceKey: 'img_v3_first' },
    { type: 'image', resourceKey: 'img_v3_second' }
  ]);
  const person = { id: 'one', name: 'One', source: 'test', matches: () => true, clean: String };
  const [message] = extractMessages([person], [raw({
    message_id: 'media',
    msg_type: 'post',
    content: '图片说明\n![Image](img_v3_sticker)'
  })]).get('one');
  assert.equal(message.content, '图片说明');
  assert.deepEqual(message.media, [{ type: 'image', resourceKey: 'img_v3_sticker' }]);
});

test('normalizes Feishu raw millisecond timestamps without a twelve-hour drift', () => {
  const message = normalizeRawMessage({
    message_id: 'om_mrdq',
    chat_id: 'oc_chat',
    message_position: '123',
    create_time: '1786326730082',
    body: { content: JSON.stringify({ text: '这risk你妈' }) },
    msg_type: 'text'
  });
  assert.equal(message.create_time, '2026-08-10T01:52:10.082Z');
  assert.match(message.message_app_link, /position=123/);
});

test('PeopleMonitor prevents overlapping refreshes', async () => {
  let resolvePage;
  let calls = 0;
  const client = {
    fetchChatPage() {
      calls += 1;
      return new Promise((resolve) => { resolvePage = resolve; });
    }
  };
  const person = {
    id: 'one', name: 'One', shortName: 'O', source: 'test', accent: 'blue', chatId: 'chat',
    matches: () => true, clean: String
  };
  const monitor = new PeopleMonitor({ client, people: [person], chats: [{ id: 'chat', name: 'Test' }] });
  const first = monitor.refresh();
  const second = monitor.refresh();
  assert.equal(calls, 1);
  resolvePage({ messages: [], hasMore: false, pageToken: '' });
  await Promise.all([first, second]);
  assert.equal(calls, 1);
});
