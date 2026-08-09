const els = {
  peopleNav: document.querySelector('#peopleNav'),
  peopleCount: document.querySelector('#peopleCount'),
  feed: document.querySelector('#feed'),
  feedTitle: document.querySelector('#feedTitle'),
  feedSource: document.querySelector('#feedSource'),
  messageCount: document.querySelector('#messageCount'),
  connection: document.querySelector('#connection'),
  connectionText: document.querySelector('#connectionText'),
  lastSync: document.querySelector('#lastSync'),
  pollInterval: document.querySelector('#pollInterval'),
  autoRefresh: document.querySelector('#autoRefresh'),
  refreshButton: document.querySelector('#refreshButton'),
  errorBanner: document.querySelector('#errorBanner'),
  toast: document.querySelector('#toast')
};

const state = {
  snapshot: null,
  selected: 'all',
  stream: null,
  autoRefresh: true,
  toastTimer: null,
  dataSignature: ''
};

function escapeHtml(value) {
  return String(value ?? '')
    .replaceAll('&', '&amp;')
    .replaceAll('<', '&lt;')
    .replaceAll('>', '&gt;')
    .replaceAll('"', '&quot;')
    .replaceAll("'", '&#039;');
}

function formatTime(value, withSeconds = false) {
  if (!value) return '--:--:--';
  const date = new Date(value.includes('T') ? value : value.replace(' ', 'T') + '+08:00');
  if (Number.isNaN(date.getTime())) return value;
  const now = new Date();
  const sameDay = date.toDateString() === now.toDateString();
  const options = sameDay
    ? { hour: '2-digit', minute: '2-digit', ...(withSeconds ? { second: '2-digit' } : {}), hour12: false }
    : { month: '2-digit', day: '2-digit', hour: '2-digit', minute: '2-digit', hour12: false };
  return new Intl.DateTimeFormat('zh-CN', options).format(date);
}

function showToast(message) {
  clearTimeout(state.toastTimer);
  els.toast.textContent = message;
  els.toast.classList.add('show');
  state.toastTimer = setTimeout(() => els.toast.classList.remove('show'), 1800);
}

function selectedPerson() {
  return state.snapshot?.people.find((person) => person.id === state.selected) || null;
}

function visibleMessages() {
  if (!state.snapshot) return [];
  const person = selectedPerson();
  const messages = person ? person.messages : state.snapshot.people.flatMap((item) => item.messages);
  return [...messages].sort((a, b) => b.createdAt.localeCompare(a.createdAt) || b.position.localeCompare(a.position));
}

function renderPeople() {
  if (!state.snapshot) return;
  const total = state.snapshot.people.reduce((sum, person) => sum + person.messages.length, 0);
  const buttons = [{ id: 'all', name: '全部动态', shortName: '∷', source: '所有来源', accent: '', count: total }, ...state.snapshot.people.map((person) => ({ ...person, count: person.messages.length }))];
  els.peopleCount.textContent = state.snapshot.people.length;
  els.peopleNav.innerHTML = buttons.map((person) => `
    <button class="person-button ${person.id === 'all' ? 'all' : ''} ${state.selected === person.id ? 'is-active' : ''}" data-person="${escapeHtml(person.id)}" data-accent="${escapeHtml(person.accent || '')}" type="button">
      <span class="person-avatar">${escapeHtml(person.shortName)}</span>
      <span class="person-copy"><strong>${escapeHtml(person.name)}</strong><small>${escapeHtml(person.source)}</small></span>
      <span class="person-count">${person.count}</span>
    </button>
  `).join('');
}

function renderFeed() {
  if (!state.snapshot) return;
  const person = selectedPerson();
  const messages = visibleMessages();
  const personById = new Map(state.snapshot.people.map((item) => [item.id, item]));
  els.feedTitle.textContent = person?.name || '全部动态';
  els.feedSource.textContent = person?.source || '全部来源';
  els.messageCount.textContent = messages.length;

  if (!messages.length) {
    els.feed.innerHTML = '<div class="empty-state"><p>暂无消息</p></div>';
    return;
  }

  els.feed.innerHTML = messages.map((message) => {
    const owner = personById.get(message.personId) || {};
    const isImage = message.type === 'image' || /^\[Image:/.test(message.content);
    const content = isImage ? '图片消息' : message.content || '空消息';
    return `
      <article class="message" data-accent="${escapeHtml(owner.accent || '')}">
        <span class="message-avatar" aria-hidden="true">${escapeHtml(owner.shortName || '?')}</span>
        <div class="message-main">
          <div class="message-meta">
            <strong>${escapeHtml(message.personName)}</strong>
            <time datetime="${escapeHtml(message.createdAt)}">${escapeHtml(formatTime(message.createdAt))}</time>
            <span class="source-tag">${escapeHtml(message.source)}</span>
          </div>
          <p class="message-content ${isImage ? 'is-image' : ''}">${escapeHtml(content)}</p>
        </div>
        ${message.url ? `<a class="message-link" href="${escapeHtml(message.url)}" target="_blank" rel="noreferrer" title="打开飞书原消息" aria-label="打开飞书原消息">↗</a>` : ''}
      </article>
    `;
  }).join('');
}

function renderStatus() {
  if (!state.snapshot) return;
  const live = state.snapshot.status === 'live';
  els.connection.dataset.state = live ? 'live' : 'error';
  els.connectionText.textContent = live ? '实时同步中' : '同步异常';
  els.lastSync.textContent = formatTime(state.snapshot.lastSyncAt, true);
  els.pollInterval.textContent = `${Math.round(state.snapshot.pollMs / 1000)}s`;
  els.errorBanner.hidden = !state.snapshot.error;
  els.errorBanner.textContent = state.snapshot.error || '';
}

function render() {
  renderPeople();
  renderFeed();
  renderStatus();
}

function applySnapshot(snapshot) {
  const signature = snapshot.people
    .map((person) => `${person.id}:${person.messages.map((message) => message.id).join(',')}`)
    .join('|');
  const messagesChanged = signature !== state.dataSignature;
  state.snapshot = snapshot;
  state.dataSignature = signature;
  if (messagesChanged) render();
  else renderStatus();
}

async function loadSnapshot() {
  const response = await fetch('/api/snapshot');
  if (!response.ok) throw new Error('无法读取监控数据');
  applySnapshot(await response.json());
}

async function refreshNow() {
  els.refreshButton.disabled = true;
  els.refreshButton.classList.add('is-spinning');
  try {
    const response = await fetch('/api/refresh', { method: 'POST' });
    if (!response.ok) throw new Error('刷新失败');
    applySnapshot(await response.json());
    showToast('已同步最新消息');
  } catch (error) {
    showToast(error.message);
  } finally {
    els.refreshButton.disabled = false;
    els.refreshButton.classList.remove('is-spinning');
  }
}

function connectStream() {
  state.stream?.close();
  if (!state.autoRefresh) {
    els.connection.dataset.state = 'loading';
    els.connectionText.textContent = '自动刷新已暂停';
    return;
  }
  const stream = new EventSource('/api/stream');
  state.stream = stream;
  stream.addEventListener('snapshot', (event) => applySnapshot(JSON.parse(event.data)));
  stream.addEventListener('open', () => {
    if (!state.snapshot) return;
    renderStatus();
  });
  stream.addEventListener('error', () => {
    els.connection.dataset.state = 'error';
    els.connectionText.textContent = '正在重连';
  });
}

els.peopleNav.addEventListener('click', (event) => {
  const button = event.target.closest('[data-person]');
  if (!button) return;
  state.selected = button.dataset.person;
  renderPeople();
  renderFeed();
});

els.autoRefresh.addEventListener('change', () => {
  state.autoRefresh = els.autoRefresh.checked;
  connectStream();
  showToast(state.autoRefresh ? '自动刷新已开启' : '自动刷新已暂停');
});

els.refreshButton.addEventListener('click', refreshNow);

loadSnapshot()
  .then(connectStream)
  .catch((error) => {
    els.connection.dataset.state = 'error';
    els.connectionText.textContent = '连接失败';
    els.feed.innerHTML = `<div class="empty-state"><p>${escapeHtml(error.message)}</p></div>`;
  });
