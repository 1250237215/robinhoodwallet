const FEISHU_APP_BASE = /^\/robinhood-radar(?:\/|$)/.test(window.location.pathname)
  ? '/robinhood-radar'
  : '';
const FEISHU_API_ROOT = `${FEISHU_APP_BASE}/feishu/api`;

const elements = {
  panel: document.querySelector('#feishu-monitor-panel'),
  badge: document.querySelector('#feishu-connection-badge'),
  badgeLabel: document.querySelector('#feishu-connection-label'),
  summary: document.querySelector('#feishu-monitor-summary'),
  refresh: document.querySelector('#feishu-refresh-button'),
  filter: document.querySelector('#feishu-person-filter'),
  sourceKind: document.querySelector('#feishu-source-kind'),
  count: document.querySelector('#feishu-message-count'),
  updated: document.querySelector('#feishu-last-updated'),
  feed: document.querySelector('#feishu-message-feed'),
  latest: document.querySelector('#feishu-latest-button'),
  watchButton: document.querySelector('#feishu-ca-watch-button'),
  watchPanel: document.querySelector('#feishu-ca-watch'),
  watchStatus: document.querySelector('#feishu-ca-watch-status'),
  watchSummary: document.querySelector('#feishu-ca-watch-summary'),
  watchEnabled: document.querySelector('#feishu-ca-watch-enabled'),
  watchSearch: document.querySelector('#feishu-ca-watch-search'),
  watchSelectAll: document.querySelector('#feishu-ca-watch-select-all'),
  watchList: document.querySelector('#feishu-ca-watch-list'),
  watchCount: document.querySelector('#feishu-ca-watch-count'),
  watchSave: document.querySelector('#feishu-ca-watch-save')
};

const state = {
  snapshot: null,
  stream: null,
  selectedPersonId: 'all',
  firstRender: true,
  rules: null,
  draftEnabled: false,
  draftIds: new Set(),
  search: '',
  rulesBusy: false
};

function icon(name) {
  const value = document.createElement('i');
  value.dataset.lucide = name;
  value.setAttribute('aria-hidden', 'true');
  return value;
}

function refreshIcons() {
  window.lucide?.createIcons?.({ nodes: [elements.panel] });
}

async function fetchJson(path, options = {}) {
  const response = await fetch(`${FEISHU_API_ROOT}${path}`, {
    ...options,
    headers: { accept: 'application/json', ...(options.body ? { 'content-type': 'application/json' } : {}), ...options.headers },
    credentials: 'same-origin'
  });
  const payload = await response.json().catch(() => ({}));
  if (!response.ok) throw new Error(payload.error || `请求失败 (${response.status})`);
  return payload;
}

function messageDate(value) {
  if (!value) return null;
  const source = String(value);
  const date = new Date(source.includes('T') ? source : `${source.replace(' ', 'T')}+08:00`);
  return Number.isNaN(date.getTime()) ? null : date;
}

function timeLabel(value) {
  const date = messageDate(value);
  if (!date) return String(value || '');
  return date.toLocaleTimeString('zh-CN', { hour: '2-digit', minute: '2-digit', second: '2-digit', hour12: false });
}

function dayLabel(value) {
  const date = messageDate(value);
  if (!date) return '日期未知';
  return date.toLocaleDateString('zh-CN', { year: 'numeric', month: 'long', day: 'numeric' });
}

function updateLatestButton() {
  const distance = elements.feed.scrollHeight - elements.feed.scrollTop - elements.feed.clientHeight;
  elements.latest.hidden = !state.snapshot || visibleMessages().length === 0 || distance <= 24;
}

function scrollToLatest({ behavior = 'smooth' } = {}) {
  elements.feed.scrollTo({ top: elements.feed.scrollHeight, behavior });
  updateLatestButton();
}

function visibleMessages() {
  const people = Array.isArray(state.snapshot?.people) ? state.snapshot.people : [];
  return people
    .filter((person) => state.selectedPersonId === 'all' || person.id === state.selectedPersonId)
    .flatMap((person) => (person.messages || []).map((message) => ({ ...message, person })))
    .sort((left, right) => {
      const leftTime = messageDate(left.createdAt)?.getTime() || 0;
      const rightTime = messageDate(right.createdAt)?.getTime() || 0;
      return leftTime - rightTime || String(left.position).localeCompare(String(right.position), undefined, { numeric: true });
    });
}

function renderFilter() {
  const people = Array.isArray(state.snapshot?.people) ? state.snapshot.people : [];
  const current = people.some((person) => person.id === state.selectedPersonId) ? state.selectedPersonId : 'all';
  elements.filter.replaceChildren();
  for (const person of [{ id: 'all', name: '全部动态' }, ...people]) {
    const option = document.createElement('option');
    option.value = person.id;
    option.textContent = person.name;
    option.selected = person.id === current;
    elements.filter.appendChild(option);
  }
  state.selectedPersonId = current;
  elements.sourceKind.textContent = `${people.length} 位监控对象`;
}

function messageRow(message) {
  const row = document.createElement('li');
  row.className = 'telegram-message-row is-incoming';
  row.dataset.messageId = message.id;

  const avatarColumn = document.createElement('div');
  avatarColumn.className = 'telegram-avatar-column';
  const avatar = document.createElement('span');
  avatar.className = 'telegram-avatar';
  avatar.dataset.accent = message.person?.accent || '';
  avatar.textContent = message.person?.shortName || String(message.personName || '?').slice(0, 2);
  avatarColumn.appendChild(avatar);

  const bubble = document.createElement('article');
  bubble.className = 'telegram-message-bubble';
  const sender = document.createElement('strong');
  sender.className = 'telegram-message-sender';
  sender.textContent = message.personName || message.person?.name || '飞书';
  const content = document.createElement('p');
  content.className = 'telegram-message-text';
  const image = message.type === 'image' || /^\[Image:/i.test(String(message.content || ''));
  content.textContent = image ? '图片消息' : String(message.content || '空消息');
  const footer = document.createElement('div');
  footer.className = 'feishu-message-footer';
  const source = document.createElement('span');
  source.textContent = message.source || message.person?.source || '飞书';
  const time = document.createElement('time');
  time.className = 'telegram-message-time';
  time.dateTime = message.createdAt || '';
  time.textContent = timeLabel(message.createdAt);
  footer.append(source, time);
  bubble.append(sender, content, footer);
  if (message.url) {
    const link = document.createElement('a');
    link.className = 'feishu-message-link';
    link.href = message.url;
    link.target = '_blank';
    link.rel = 'noopener noreferrer';
    link.title = '打开飞书原消息';
    link.setAttribute('aria-label', '打开飞书原消息');
    link.appendChild(icon('square-arrow-out-up-right'));
    bubble.appendChild(link);
  }
  row.append(avatarColumn, bubble);
  return row;
}

function renderFeed() {
  const nearLatest = elements.feed.scrollHeight - elements.feed.scrollTop - elements.feed.clientHeight <= 32;
  const messages = visibleMessages();
  elements.feed.replaceChildren();
  elements.count.textContent = `${messages.length} 条消息`;
  if (!messages.length) {
    const empty = document.createElement('li');
    empty.className = 'telegram-empty-state';
    empty.append(icon('messages-square'));
    const title = document.createElement('strong');
    title.textContent = state.snapshot ? '暂无飞书消息' : '等待飞书消息';
    const detail = document.createElement('span');
    detail.textContent = state.snapshot ? '当前人物还没有可显示的消息。' : '连接成功后，消息会显示在这里。';
    empty.append(title, detail);
    elements.feed.appendChild(empty);
  } else {
    let day = '';
    for (const message of messages) {
      const nextDay = dayLabel(message.createdAt);
      if (nextDay !== day) {
        const separator = document.createElement('li');
        separator.className = 'telegram-date-separator';
        const label = document.createElement('span');
        label.textContent = nextDay;
        separator.appendChild(label);
        elements.feed.appendChild(separator);
        day = nextDay;
      }
      elements.feed.appendChild(messageRow(message));
    }
  }
  refreshIcons();
  requestAnimationFrame(() => {
    if (state.firstRender || nearLatest) scrollToLatest({ behavior: 'auto' });
    else updateLatestButton();
    state.firstRender = false;
  });
}

function renderStatus() {
  const status = state.snapshot?.status || 'waiting';
  const live = status === 'live';
  elements.badge.dataset.state = live ? 'online' : status === 'waiting' ? 'loading' : 'error';
  elements.badgeLabel.textContent = live ? '实时连接' : status === 'waiting' ? '等待服务' : '同步异常';
  const people = Array.isArray(state.snapshot?.people) ? state.snapshot.people.length : 0;
  const interval = Math.max(1, Math.round((Number(state.snapshot?.pollMs) || 2_000) / 1_000));
  elements.summary.textContent = live
    ? `${people} 位人物 · 每 ${interval} 秒同步`
    : state.snapshot?.error || '正在连接飞书服务';
  elements.updated.textContent = state.snapshot?.lastSyncAt ? `同步于 ${timeLabel(state.snapshot.lastSyncAt)}` : '等待同步';
}

function applySnapshot(snapshot) {
  state.snapshot = snapshot;
  renderFilter();
  renderStatus();
  renderFeed();
}

function rulesDirty() {
  if (!state.rules) return false;
  const saved = new Set((state.rules.selected_person_ids || []).map(String));
  if (state.draftEnabled !== Boolean(state.rules.enabled) || saved.size !== state.draftIds.size) return true;
  for (const id of saved) if (!state.draftIds.has(id)) return true;
  return false;
}

function visibleRulePeople() {
  const query = state.search.trim().toLocaleLowerCase('zh-CN');
  const people = state.rules?.people || [];
  return query ? people.filter((person) => `${person.name} ${person.source}`.toLocaleLowerCase('zh-CN').includes(query)) : people;
}

function renderRules() {
  const people = visibleRulePeople();
  elements.watchList.replaceChildren();
  for (const person of people) {
    const option = document.createElement('label');
    option.className = 'telegram-ca-watch-option';
    const checkbox = document.createElement('input');
    checkbox.type = 'checkbox';
    checkbox.checked = state.draftIds.has(String(person.id));
    checkbox.disabled = state.rulesBusy;
    checkbox.addEventListener('change', () => {
      if (checkbox.checked) state.draftIds.add(String(person.id));
      else state.draftIds.delete(String(person.id));
      renderRules();
    });
    const avatar = document.createElement('span');
    avatar.className = 'telegram-avatar telegram-ca-watch-avatar';
    avatar.textContent = person.shortName || String(person.name || '?').slice(0, 2);
    const copy = document.createElement('span');
    copy.className = 'telegram-ca-watch-copy';
    const name = document.createElement('strong');
    name.textContent = person.name;
    const source = document.createElement('span');
    source.textContent = person.source;
    copy.append(name, source);
    const chip = document.createElement('span');
    chip.className = 'telegram-ca-watch-chip';
    chip.dataset.state = checkbox.checked ? 'selected' : 'idle';
    chip.textContent = checkbox.checked ? '已选择' : '未选择';
    option.append(checkbox, avatar, copy, chip);
    elements.watchList.appendChild(option);
  }
  if (!people.length) {
    const empty = document.createElement('p');
    empty.className = 'telegram-ca-watch-state';
    empty.textContent = state.rules ? '没有匹配的人物' : '正在读取人物';
    elements.watchList.appendChild(empty);
  }
  elements.watchEnabled.checked = state.draftEnabled;
  elements.watchEnabled.disabled = state.rulesBusy || !state.rules;
  const allSelected = people.length > 0 && people.every((person) => state.draftIds.has(String(person.id)));
  elements.watchSelectAll.checked = allSelected;
  elements.watchSelectAll.indeterminate = !allSelected && people.some((person) => state.draftIds.has(String(person.id)));
  elements.watchSelectAll.disabled = state.rulesBusy || !people.length;
  elements.watchCount.textContent = `已选 ${state.draftIds.size} 人`;
  elements.watchSave.disabled = state.rulesBusy || !rulesDirty() || (state.draftEnabled && !state.draftIds.size);
  const configured = state.rules?.delivery_configured !== false;
  elements.watchStatus.dataset.state = state.rulesBusy ? 'loading' : state.draftEnabled ? configured ? 'enabled' : 'warning' : 'disabled';
  elements.watchStatus.textContent = state.rulesBusy ? '保存中' : state.draftEnabled ? configured ? '监控中' : 'Bark 未配置' : '已关闭';
  elements.watchSummary.textContent = `${state.rules?.people?.length || 0} 位人物 · 检测 EVM / Solana 地址`;
  elements.watchButton.classList.toggle('is-active', Boolean(state.rules?.enabled));
}

async function loadRules({ preserveDraft = false } = {}) {
  const payload = await fetchJson('/ca-watch');
  state.rules = payload;
  if (!preserveDraft) {
    state.draftEnabled = Boolean(payload.enabled);
    state.draftIds = new Set((payload.selected_person_ids || []).map(String));
  }
  renderRules();
}

async function saveRules() {
  if (state.rulesBusy) return;
  state.rulesBusy = true;
  renderRules();
  try {
    const payload = await fetchJson('/ca-watch', {
      method: 'PUT',
      body: JSON.stringify({ enabled: state.draftEnabled, person_ids: [...state.draftIds] })
    });
    state.rules = payload;
    state.draftEnabled = Boolean(payload.enabled);
    state.draftIds = new Set((payload.selected_person_ids || []).map(String));
  } finally {
    state.rulesBusy = false;
    renderRules();
  }
}

function connectStream() {
  state.stream?.close();
  const stream = new EventSource(`${FEISHU_API_ROOT}/stream`);
  state.stream = stream;
  stream.addEventListener('snapshot', (event) => applySnapshot(JSON.parse(event.data)));
  stream.addEventListener('error', () => {
    elements.badge.dataset.state = 'error';
    elements.badgeLabel.textContent = '正在重连';
  });
}

async function refresh() {
  elements.refresh.disabled = true;
  try {
    applySnapshot(await fetchJson('/refresh', { method: 'POST' }));
    await loadRules({ preserveDraft: rulesDirty() });
  } finally {
    elements.refresh.disabled = false;
  }
}

elements.filter.addEventListener('change', () => {
  state.selectedPersonId = elements.filter.value;
  state.firstRender = true;
  renderFeed();
});
elements.refresh.addEventListener('click', () => void refresh());
elements.latest.addEventListener('click', () => scrollToLatest());
elements.feed.addEventListener('scroll', updateLatestButton, { passive: true });
elements.watchButton.addEventListener('click', () => {
  elements.watchPanel.hidden = !elements.watchPanel.hidden;
  elements.watchButton.setAttribute('aria-expanded', String(!elements.watchPanel.hidden));
  if (!elements.watchPanel.hidden && !state.rules) void loadRules();
});
elements.watchEnabled.addEventListener('change', () => {
  state.draftEnabled = elements.watchEnabled.checked;
  renderRules();
});
elements.watchSearch.addEventListener('input', () => {
  state.search = elements.watchSearch.value;
  renderRules();
});
elements.watchSelectAll.addEventListener('change', () => {
  for (const person of visibleRulePeople()) {
    if (elements.watchSelectAll.checked) state.draftIds.add(String(person.id));
    else state.draftIds.delete(String(person.id));
  }
  renderRules();
});
elements.watchSave.addEventListener('click', () => void saveRules());

refresh().catch(() => renderStatus()).finally(connectStream);
window.setInterval(() => {
  if (!elements.watchPanel.hidden && !state.rulesBusy) void loadRules({ preserveDraft: rulesDirty() });
}, 10_000);
