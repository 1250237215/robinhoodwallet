export const WALLET_MONITOR_EVENT_TYPES = Object.freeze([
  'buy',
  'sell',
  'transfer',
  'token_create'
]);

const EVENT_TYPE_SET = new Set(WALLET_MONITOR_EVENT_TYPES);
const RULE_FIELDS = Object.freeze(['enabled', 'sound', 'bark']);
const RULE_FIELD_SET = new Set(RULE_FIELDS);

export const DEFAULT_WALLET_MONITOR_RULES = Object.freeze({
  buy: Object.freeze({ enabled: true, sound: false, bark: false }),
  sell: Object.freeze({ enabled: false, sound: false, bark: false }),
  transfer: Object.freeze({ enabled: false, sound: false, bark: false }),
  token_create: Object.freeze({ enabled: false, sound: false, bark: false })
});

function isObject(value) {
  return Boolean(value) && typeof value === 'object' && !Array.isArray(value);
}

export function defaultWalletMonitorRules() {
  return Object.fromEntries(
    WALLET_MONITOR_EVENT_TYPES.map((eventType) => [eventType, { ...DEFAULT_WALLET_MONITOR_RULES[eventType] }])
  );
}

export function normalizeWalletMonitorRules(value, fallback = DEFAULT_WALLET_MONITOR_RULES) {
  const source = isObject(value) ? value : {};
  const base = isObject(fallback) ? fallback : DEFAULT_WALLET_MONITOR_RULES;
  const normalized = {};
  for (const eventType of WALLET_MONITOR_EVENT_TYPES) {
    const sourceRule = isObject(source[eventType]) ? source[eventType] : {};
    const fallbackRule = isObject(base[eventType]) ? base[eventType] : DEFAULT_WALLET_MONITOR_RULES[eventType];
    normalized[eventType] = {};
    for (const field of RULE_FIELDS) {
      normalized[eventType][field] = typeof sourceRule[field] === 'boolean'
        ? sourceRule[field]
        : typeof fallbackRule[field] === 'boolean'
          ? fallbackRule[field]
          : DEFAULT_WALLET_MONITOR_RULES[eventType][field];
    }
  }
  return normalized;
}

export function validateWalletMonitorRulesPatch(value) {
  if (!isObject(value)) throw new TypeError('monitorRules must be an object');
  if (!Object.keys(value).length) throw new TypeError('monitorRules must include at least one event');
  const patch = {};
  for (const [eventType, rule] of Object.entries(value)) {
    if (!EVENT_TYPE_SET.has(eventType)) {
      throw new TypeError(`Unsupported monitorRules event: ${eventType}`);
    }
    if (!isObject(rule)) {
      throw new TypeError(`monitorRules.${eventType} must be an object`);
    }
    if (!Object.keys(rule).length) {
      throw new TypeError(`monitorRules.${eventType} must include at least one setting`);
    }
    patch[eventType] = {};
    for (const [field, setting] of Object.entries(rule)) {
      if (!RULE_FIELD_SET.has(field)) {
        throw new TypeError(`Unsupported monitorRules field: ${eventType}.${field}`);
      }
      if (typeof setting !== 'boolean') {
        throw new TypeError(`monitorRules.${eventType}.${field} must be a boolean`);
      }
      patch[eventType][field] = setting;
    }
  }
  return patch;
}

export function applyWalletMonitorRulesPatch(current, patch) {
  const normalized = normalizeWalletMonitorRules(current);
  const validated = validateWalletMonitorRulesPatch(patch);
  for (const [eventType, rule] of Object.entries(validated)) {
    Object.assign(normalized[eventType], rule);
  }
  return normalized;
}
