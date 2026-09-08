import assert from 'node:assert/strict';
import test from 'node:test';

import { PEOPLE } from '../src/config.js';
import { extractBotName, extractImageResources, extractMessages, mergeMessages, PeopleMonitor } from '../src/monitor.js';
import { createLarkClient, normalizeRawMessage, normalizeSenderAvatarUrl } from '../src/lark-client.js';
import { GROUP_OWNERS_ID } from '../src/config.js';

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
    [byId.get('daqi'), byId.get('luck'), byId.get('lu'), byId.get('sencrazy_wuwei'), byId.get('gule')],
    [
      raw({ message_id: 'daqi', content: '【大齐】：\n看懂了' }),
      raw({ message_id: 'daqi-follower', content: '【大齐的小跟班】：\n不应出现' }),
      raw({ message_id: 'luck', content: '【luck(发财版】：\n就对了' }),
      raw({ message_id: 'lu', content: '【LU】：\n奶蛙更纯粹一点' }),
      raw({ message_id: 'sencrazy-wuwei', content: '【Sencrazy💎👋（無為版】：\n出个小本' }),
      raw({ message_id: 'gule', content: '【古乐(投降认输退出bsc版)】：\n太狠了  2m' }),
      raw({ message_id: 'gule-follower', content: '【古乐的小跟班】：\n不应出现' }),
      raw({ message_id: 'other', content: '【其他人】：\n不应出现' })
    ]
  );
  assert.equal(crazyMessages.get('daqi')[0].content, '看懂了');
  assert.equal(crazyMessages.get('daqi').length, 1);
  assert.equal(crazyMessages.get('luck')[0].content, '就对了');
  assert.equal(crazyMessages.get('lu')[0].content, '奶蛙更纯粹一点');
  assert.deepEqual(crazyMessages.get('sencrazy_wuwei').map((message) => message.content), ['出个小本']);
  assert.deepEqual(crazyMessages.get('gule').map((message) => message.content), ['太狠了  2m']);

  const laserMessages = extractMessages(
    [byId.get('lasercat'), byId.get('mrdq')],
    [
      raw({ message_id: 'laser', content: '奥德赛', sender: { tenant_key: '12fa9ae1ea0f5740' } }),
      raw({ message_id: 'mrdq', content: '【#144 MrDQ 🐒🦄🔥】：\n有孩哥真好', sender: { tenant_key: 'other' } })
    ]
  );
  assert.equal(laserMessages.get('lasercat')[0].content, '奥德赛');
  assert.equal(laserMessages.get('mrdq')[0].content, '有孩哥真好');

  const jinwaMessages = extractMessages(
    [byId.get('chenpepe'), byId.get('0xace')],
    [
      raw({ message_id: 'chenpepe', content: '0x1cd9dc24e2d2becfe09aa326fea14319f6a47777' }),
      raw({ message_id: '0xace', content: '【0xace（尊师陈皮皮）】：\n这个好歹是个专有词' }),
      raw({ message_id: '0xace-quoted', content: '这是应用啊\n\n引用 0xace（尊师陈皮皮）：xstocks' }),
      raw({ message_id: 'jinwa-other', content: '【其他人】：\n不应出现' })
    ]
  );
  assert.deepEqual(jinwaMessages.get('chenpepe').map((message) => message.content), [
    '0x1cd9dc24e2d2becfe09aa326fea14319f6a47777',
    '这是应用啊\n\n引用 0xace（尊师陈皮皮）：xstocks'
  ]);
  assert.deepEqual(jinwaMessages.get('0xace').map((message) => message.content), [
    '这个好歹是个专有词'
  ]);

  const ownerMessages = extractMessages(
    [byId.get('cryptod'), byId.get('wangxiaoer'), byId.get('0xsun')],
    [
      raw({ message_id: 'cryptod', content: '群主引用 CryptoD ：睡一下 半夜起床' }),
      raw({ message_id: 'wangxiaoer', content: '不骂没人买课引用 王小二 的消息 : 徐冲浪这傻逼之前骂所有币圈的' }),
      raw({ message_id: '0xsun', content: '龟龟引用 孙嘉良0xSun 的消息 : 我这iPhone充电的时候太烫了' }),
      raw({ message_id: 'crypto-d-caicai', content: '【Crypto D财财】：\n不应出现' }),
      raw({ message_id: 'cryptodog', content: '引用 CryptoDog ：不应出现' }),
      raw({ message_id: 'study-0xsun', content: '【Study 0xsun】：\n不应出现' })
    ]
  );
  assert.deepEqual(ownerMessages.get('cryptod').map((message) => message.content), ['睡一下 半夜起床']);
  assert.deepEqual(ownerMessages.get('wangxiaoer').map((message) => message.content), ['徐冲浪这傻逼之前骂所有币圈的']);
  assert.deepEqual(ownerMessages.get('0xsun').map((message) => message.content), ['我这iPhone充电的时候太烫了']);
});

test('the first-tier owner radar captures every bot message without mixing ordinary members', () => {
  const byId = new Map(PEOPLE.map((person) => [person.id, person]));
  const botMessages = extractMessages(
    [byId.get('group_owners_bots')],
    [
      raw({
        message_id: 'bot-1',
        content: '【JAMES】：4stock',
        sender: { sender_type: 'app', id: 'cli_c08abc1da138d00f' }
      }),
      raw({
        message_id: 'bot-2',
        content: '引用 机器猫：$STRATTON',
        sender: { sender_type: 'app', id: 'cli_forwarder' }
      }),
      raw({
        message_id: 'member-1',
        content: '普通成员发言，不应进入机器人总览',
        sender: { sender_type: 'user', id: 'ou_member' }
      })
    ]
  );
  assert.deepEqual(botMessages.get('group_owners_bots').map((message) => message.content), [
    '【JAMES】：4stock',
    '引用 机器猫：$STRATTON'
  ]);
});

test('labels first-tier bot messages from their embedded bot headers', () => {
  assert.equal(extractBotName('【JAMES】：4stock'), 'JAMES');
  assert.equal(extractBotName('引用 #356 机器猫：$STRATTON'), '机器猫');
  assert.equal(extractBotName('这句话\n\n引用 Mabon.：依稀记得'), '');
  assert.equal(extractBotName('没有来源名称的机器人短消息'), '');

  const person = PEOPLE.find((entry) => entry.id === 'group_owners_bots');
  const [message] = extractMessages([person], [raw({
    message_id: 'named-bot',
    content: '【JAMES】：4stock',
    sender: {
      sender_type: 'app',
      id: 'cli_forwarder',
      name: '猴哥James',
      avatar_url: 'https://s16-imfile-sg.feishucdn.com/james.jpg'
    }
  })]).get(person.id);
  assert.equal(message.personName, '猴哥James');
  assert.equal(message.personShortName, '猴哥');
  assert.equal(message.personAvatarUrl, 'https://s16-imfile-sg.feishucdn.com/james.jpg');
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

test('normalizes standalone Feishu image messages into downloadable media markers', () => {
  const message = normalizeRawMessage({
    message_id: 'om_image',
    create_time: '1786326730082',
    body: { content: JSON.stringify({ image_key: 'img_v3_0214m_example' }) },
    msg_type: 'image'
  });
  assert.equal(message.content, '[Image: img_v3_0214m_example]');

  const person = { id: 'one', name: 'One', source: 'test', matches: () => true, clean: String };
  const [normalized] = extractMessages([person], [message]).get('one');
  assert.equal(normalized.content, '');
  assert.deepEqual(normalized.media, [{ type: 'image', resourceKey: 'img_v3_0214m_example' }]);
});

test('keeps only original Feishu CDN avatar URLs', () => {
  assert.match(
    normalizeSenderAvatarUrl('https://s16-imfile-sg.feishucdn.com/static-resource/avatar.jpg'),
    /^https:\/\//
  );
  assert.equal(normalizeSenderAvatarUrl('https://example.com/avatar.jpg'), '');
  assert.equal(normalizeSenderAvatarUrl('http://s16-imfile-sg.feishucdn.com/avatar.jpg'), '');
});

test('enriches first-tier bot messages with sender names and caches old message details', async () => {
  const calls = [];
  const rawItems = [
    {
      message_id: 'om_bot_one',
      message_position: '1',
      create_time: '1786326730082',
      body: { content: JSON.stringify({ text: 'first' }) },
      msg_type: 'text',
      sender: { id: 'cli_forwarder', sender_type: 'app' }
    },
    {
      message_id: 'om_bot_two',
      message_position: '2',
      create_time: '1786326730083',
      body: { content: JSON.stringify({ text: 'second' }) },
      msg_type: 'text',
      sender: { id: 'cli_forwarder', sender_type: 'app' }
    }
  ];
  const client = createLarkClient({
    command: 'fake-lark-cli',
    execFileImpl: async (_command, args) => {
      const requestPath = args[2];
      const params = JSON.parse(args[args.indexOf('--params') + 1]);
      calls.push({ requestPath, params });
      if (requestPath.endsWith('/mget')) {
        return {
          stdout: JSON.stringify({
            ok: true,
            data: {
              items: [
                { message_id: 'om_bot_one', sender: { name: 'LaserCat', sender_type: 'app', avatar_url: 'https://s16-imfile-sg.feishucdn.com/laser.jpg' } },
                { message_id: 'om_bot_two', sender: { name: '猴哥James', sender_type: 'app', avatar_url: 'https://s16-imfile-sg.feishucdn.com/james.jpg' } }
              ]
            }
          })
        };
      }
      return stdout({ ok: true, data: { items: rawItems, has_more: false, page_token: '' } });
    }
  });

  const first = await client.fetchChatPage(GROUP_OWNERS_ID, { pageSize: 2 });
  assert.deepEqual(first.messages.map((message) => message.sender.name), ['LaserCat', '猴哥James']);
  assert.deepEqual(first.messages.map((message) => message.sender.avatar_url), [
    'https://s16-imfile-sg.feishucdn.com/laser.jpg',
    'https://s16-imfile-sg.feishucdn.com/james.jpg'
  ]);
  assert.equal(calls.length, 2);
  assert.deepEqual(calls[1].params.message_ids, ['om_bot_one', 'om_bot_two']);

  rawItems[0].body = { content: JSON.stringify({ text: 'edited locally' }) };
  const second = await client.fetchChatPage(GROUP_OWNERS_ID, { pageSize: 2 });
  assert.equal(calls.filter((call) => call.requestPath.endsWith('/mget')).length, 1, 'cached sender details avoid repeating mget for old messages');
  assert.equal(second.messages[0].content, 'edited locally', 'sender cache must not overwrite fresh content');
  assert.equal(second.messages[0].sender.name, 'LaserCat');
});

function stdout(value) {
  return { stdout: JSON.stringify(value) };
}

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
