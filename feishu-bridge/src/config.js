const CRAZYSEN_GROUP_ID = 'oc_884bb58e6b0b07d56c610364cab40a03';
const SEN_CHANNEL_ID = 'oc_a1ff43aca201bc05ee024e0238345d02';
const LASERCAT_GROUP_ID = 'oc_f624316b25a32ab66af618989b2c2aec';
const JINWA_GROUP_ID = 'oc_215ff685ff278ad855288a3d640d7b32';
const GROUP_OWNERS_ID = 'oc_e14c9de830ac46862a0dd1ca764819c3';

function prefixMatcher(prefix) {
  return {
    matches(message) {
      return String(message.content || '').startsWith(prefix);
    },
    clean(content) {
      return String(content || '').slice(prefix.length).replace(/^】?[：:]?\s*/, '');
    }
  };
}

function quotedSpeakerMatcher(name) {
  const escapedName = name.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
  const pattern = new RegExp(
    `引用\\s*${escapedName}\\s*(?:[：:]|的消息\\s*[：:])\\s*([\\s\\S]*)`,
    'i'
  );
  return {
    matches(message) {
      return pattern.test(String(message.content || ''));
    },
    clean(content) {
      return pattern.exec(String(content || ''))?.[1] || '';
    }
  };
}

const daqi = prefixMatcher('【大齐');
const luck = prefixMatcher('【luck(发财版');
const lu = prefixMatcher('【LU');
const mrdq = prefixMatcher('【#144 MrDQ 🐒🦄🔥');
const cryptoD = quotedSpeakerMatcher('CryptoD');
const wangXiaoer = quotedSpeakerMatcher('王小二');
const zeroXSun = quotedSpeakerMatcher('孙嘉良0xSun');
const chenpepe = {
  matches(message) {
    const content = String(message.content || '').trim();
    return Boolean(content) && !content.startsWith('【');
  },
  clean(content) {
    return String(content || '');
  }
};

export const PEOPLE = Object.freeze([
  {
    id: 'sen',
    name: 'Sen',
    shortName: 'S',
    source: 'crazySen个人发言',
    chatId: SEN_CHANNEL_ID,
    accent: 'coral',
    matches: () => true,
    clean: (content) => String(content || '')
  },
  {
    id: 'lasercat',
    name: 'Lasercat',
    shortName: 'LC',
    source: 'Lasercat全员群',
    chatId: LASERCAT_GROUP_ID,
    accent: 'cyan',
    matches: (message) => message.sender?.tenant_key === '12fa9ae1ea0f5740',
    clean: (content) => String(content || '')
  },
  {
    id: 'mrdq',
    name: 'MrDQ',
    shortName: 'DQ',
    source: 'Lasercat全员群',
    chatId: LASERCAT_GROUP_ID,
    accent: 'gold',
    matches: mrdq.matches,
    clean: mrdq.clean
  },
  {
    id: 'daqi',
    name: '大齐',
    shortName: '齐',
    source: 'crazysen全员群',
    chatId: CRAZYSEN_GROUP_ID,
    accent: 'green',
    matches: daqi.matches,
    clean: daqi.clean
  },
  {
    id: 'luck',
    name: 'luck(发财版',
    shortName: 'LUCK',
    source: 'crazysen全员群',
    chatId: CRAZYSEN_GROUP_ID,
    accent: 'violet',
    matches: luck.matches,
    clean: luck.clean
  },
  {
    id: 'lu',
    name: 'LU',
    shortName: 'LU',
    source: 'crazysen全员群',
    chatId: CRAZYSEN_GROUP_ID,
    accent: 'blue',
    matches: lu.matches,
    clean: lu.clean
  },
  {
    id: 'chenpepe',
    name: 'Chenpepe',
    shortName: 'CP',
    source: '金蛙聊天群',
    chatId: JINWA_GROUP_ID,
    accent: 'coral',
    matches: chenpepe.matches,
    clean: chenpepe.clean
  },
  {
    id: 'cryptod',
    name: 'CryptoD',
    shortName: 'CD',
    source: '各大群主发言',
    chatId: GROUP_OWNERS_ID,
    accent: 'cyan',
    matches: cryptoD.matches,
    clean: cryptoD.clean
  },
  {
    id: 'wangxiaoer',
    name: '王小二',
    shortName: '王',
    source: '各大群主发言',
    chatId: GROUP_OWNERS_ID,
    accent: 'gold',
    matches: wangXiaoer.matches,
    clean: wangXiaoer.clean
  },
  {
    id: '0xsun',
    name: '0xSun',
    shortName: '0X',
    source: '各大群主发言',
    chatId: GROUP_OWNERS_ID,
    accent: 'green',
    matches: zeroXSun.matches,
    clean: zeroXSun.clean
  }
]);

export const CHATS = Object.freeze([
  { id: SEN_CHANNEL_ID, name: 'crazySen个人发言' },
  { id: LASERCAT_GROUP_ID, name: 'Lasercat全员群（新）｜erwaNFT' },
  { id: CRAZYSEN_GROUP_ID, name: 'crazysen全员群' },
  { id: JINWA_GROUP_ID, name: '金蛙聊天群｜erwanft' },
  { id: GROUP_OWNERS_ID, name: '各大群主发言（一级）' }
]);

export const DEFAULT_POLL_MS = 2_000;
export const MAX_MESSAGES_PER_PERSON = 10;
export const BOOTSTRAP_PAGE_LIMIT = 20;
