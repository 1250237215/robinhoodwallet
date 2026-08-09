const CRAZYSEN_GROUP_ID = 'oc_884bb58e6b0b07d56c610364cab40a03';
const SEN_CHANNEL_ID = 'oc_a1ff43aca201bc05ee024e0238345d02';
const LASERCAT_GROUP_ID = 'oc_f624316b25a32ab66af618989b2c2aec';

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

const daqi = prefixMatcher('【大齐');
const luck = prefixMatcher('【luck(发财版');
const lu = prefixMatcher('【LU');
const mrdq = prefixMatcher('【#144 MrDQ 🐒🦄🔥');

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
  }
]);

export const CHATS = Object.freeze([
  { id: SEN_CHANNEL_ID, name: 'crazySen个人发言' },
  { id: LASERCAT_GROUP_ID, name: 'Lasercat全员群（新）｜erwaNFT' },
  { id: CRAZYSEN_GROUP_ID, name: 'crazysen全员群' }
]);

export const DEFAULT_POLL_MS = 2_000;
export const MAX_MESSAGES_PER_PERSON = 10;
export const BOOTSTRAP_PAGE_LIMIT = 20;
