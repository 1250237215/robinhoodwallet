const TELEGRAM_APP_BASE = /^\/robinhood-radar(?:\/|$)/.test(window.location.pathname)
  ? '/robinhood-radar'
  : '';
const TELEGRAM_API_ROOT = `${TELEGRAM_APP_BASE}/telegram/api`;
const TELEGRAM_POLL_INTERVAL_MS = 2_000;
const TELEGRAM_STATUS_INTERVAL_MS = 10_000;
const TELEGRAM_CA_WATCH_REFRESH_INTERVAL_MS = 10_000;
const TELEGRAM_MESSAGE_LIMIT = 300;
const TELEGRAM_PINNED_SOURCE_NAME = 'LazyCat FNF';

const telegramElements = {
  monitorPage: document.querySelector('#monitor-page'),
  panel: document.querySelector('#telegram-monitor-panel'),
  badge: document.querySelector('#telegram-connection-badge'),
  badgeLabel: document.querySelector('#telegram-connection-label'),
  summary: document.querySelector('#telegram-monitor-summary'),
  caWatchButton: document.querySelector('#telegram-ca-watch-button'),
  latestButton: document.querySelector('#telegram-latest-button'),
  refreshButton: document.querySelector('#telegram-refresh-button'),
  sourceAvatar: document.querySelector('#telegram-source-avatar'),
  sourceName: document.querySelector('#telegram-source-name'),
  sourceKind: document.querySelector('#telegram-source-kind'),
  messageCount: document.querySelector('#telegram-message-count'),
  updatedAt: document.querySelector('#telegram-last-updated'),
  caWatchPanel: document.querySelector('#telegram-ca-watch'),
  caWatchStatus: document.querySelector('#telegram-ca-watch-status'),
  caWatchSummary: document.querySelector('#telegram-ca-watch-summary'),
  caWatchEnabled: document.querySelector('#telegram-ca-watch-enabled'),
  caWatchSearch: document.querySelector('#telegram-ca-watch-search'),
  caWatchSelectAll: document.querySelector('#telegram-ca-watch-select-all'),
  caWatchList: document.querySelector('#telegram-ca-watch-list'),
  caWatchCount: document.querySelector('#telegram-ca-watch-count'),
  caWatchSave: document.querySelector('#telegram-ca-watch-save'),
  feed: document.querySelector('#telegram-message-feed')
};

const telegramState = {
  active: false,
  busy: false,
  timer: null,
  caWatchTimer: null,
  controller: null,
  statusCheckedAt: 0,
  firstRender: true,
  version: '',
  renderedMessages: [],
  sourceId: null,
  source: null,
  caWatch: {
    loaded: false,
    busy: false,
    refreshing: false,
    requestEpoch: 0,
    enabled: false,
    draftEnabled: false,
    deliveryConfigured: false,
    senders: [],
    selectedSenderIds: new Set(),
    draftSenderIds: new Set(),
    searchQuery: '',
    error: '',
    latestDelivery: null,
    directory: null
  }
};

function telegramNormalizeId(value) {
  return value === null || value === undefined || value === '' ? '' : String(value);
}

function telegramFormatTime(value) {
  if (!value) return '等待同步';
  const date = new Date(value);
  if (Number.isNaN(date.getTime())) return String(value);
  return date.toLocaleTimeString('zh-CN', {
    hour: '2-digit',
    minute: '2-digit',
    second: '2-digit',
    hour12: false
  });
}

function telegramDayLabel(value) {
  const date = new Date(value);
  if (Number.isNaN(date.getTime())) return String(value || '日期未知').slice(0, 10);
  return date.toLocaleDateString('zh-CN', {
    year: 'numeric',
    month: 'long',
    day: 'numeric'
  });
}

function telegramPayloadVersion(payload) {
  const messages = Array.isArray(payload?.messages) ? payload.messages : [];
  return [
    payload?.updated_at || '',
    payload?.count ?? messages.length,
    telegramNormalizeId(messages[0]?.id),
    telegramNormalizeId(messages[messages.length - 1]?.id)
  ].join(':');
}

function setTelegramConnection(state, label, summary) {
  telegramElements.badge.dataset.state = state;
  telegramElements.badgeLabel.textContent = label;
  telegramElements.summary.textContent = summary;
}

function telegramCaWatchSetsEqual(left, right) {
  if (left.size !== right.size) return false;
  for (const value of left) if (!right.has(value)) return false;
  return true;
}

function telegramCaWatchNormalizeSender(sender) {
  const id = Number(sender?.id);
  if (!Number.isSafeInteger(id)) return null;
  return {
    id,
    name: String(sender?.name || `用户 ${id}`),
    avatar: sender?.avatar && typeof sender.avatar === 'object' ? sender.avatar : {},
    lastSeenAt: sender?.last_seen_at ?? null,
    selected: Boolean(sender?.selected)
  };
}

function telegramCaWatchVisibleSenders() {
  const query = telegramState.caWatch.searchQuery.trim().toLocaleLowerCase('zh-CN');
  if (!query) return telegramState.caWatch.senders;
  return telegramState.caWatch.senders.filter((sender) => (
    sender.name.toLocaleLowerCase('zh-CN').includes(query)
  ));
}

function telegramCaWatchDirty() {
  const state = telegramState.caWatch;
  return state.enabled !== state.draftEnabled
    || !telegramCaWatchSetsEqual(state.selectedSenderIds, state.draftSenderIds);
}

function telegramCaWatchSignature(state) {
  return JSON.stringify({
    loaded: state.loaded,
    enabled: state.enabled,
    draftEnabled: state.draftEnabled,
    deliveryConfigured: state.deliveryConfigured,
    selectedSenderIds: [...state.selectedSenderIds].sort((a, b) => a - b),
    draftSenderIds: [...state.draftSenderIds].sort((a, b) => a - b),
    searchQuery: state.searchQuery,
    senders: state.senders.map((sender) => ({
      id: sender.id,
      name: sender.name,
      avatar: sender.avatar,
      lastSeenAt: sender.lastSeenAt,
      selected: sender.selected
    })),
    latestStatus: state.latestDelivery?.status || '',
    directory: state.directory,
    error: state.error
  });
}

function renderTelegramCaWatch() {
  const state = telegramState.caWatch;
  const previousScrollTop = telegramElements.caWatchList.scrollTop;
  const visibleSenders = telegramCaWatchVisibleSenders();
  telegramElements.caWatchList.replaceChildren();

  if (state.busy && !state.loaded) {
    const loading = document.createElement('p');
    loading.className = 'telegram-ca-watch-state';
    loading.textContent = '正在读取近期发言人...';
    telegramElements.caWatchList.appendChild(loading);
  } else if (!visibleSenders.length) {
    const empty = document.createElement('p');
    empty.className = 'telegram-ca-watch-state';
    empty.textContent = state.senders.length ? '没有匹配的发言人' : '暂无可选择的发言人';
    telegramElements.caWatchList.appendChild(empty);
  } else {
    const fragment = document.createDocumentFragment();
    for (const sender of visibleSenders) {
      const option = document.createElement('label');
      option.className = 'telegram-ca-watch-option';

      const checkbox = document.createElement('input');
      checkbox.type = 'checkbox';
      checkbox.checked = state.draftSenderIds.has(sender.id);
      checkbox.disabled = state.busy;
      checkbox.addEventListener('change', () => {
        if (checkbox.checked) state.draftSenderIds.add(sender.id);
        else state.draftSenderIds.delete(sender.id);
        renderTelegramCaWatch();
      });

      const avatar = document.createElement('span');
      avatar.className = 'telegram-avatar telegram-ca-watch-avatar';
      renderTelegramAvatar(avatar, sender.avatar, sender.name);

      const copy = document.createElement('span');
      copy.className = 'telegram-ca-watch-copy';
      const name = document.createElement('strong');
      name.textContent = sender.name;
      const detail = document.createElement('span');
      detail.textContent = `Telegram ID ${sender.id}`;
      copy.append(name, detail);

      const selected = document.createElement('span');
      selected.className = 'telegram-ca-watch-chip';
      selected.dataset.state = state.draftSenderIds.has(sender.id) ? 'selected' : 'idle';
      selected.textContent = state.draftSenderIds.has(sender.id) ? '已选择' : '未选择';
      option.append(checkbox, avatar, copy, selected);
      fragment.appendChild(option);
    }
    telegramElements.caWatchList.appendChild(fragment);
  }

  const selectedCount = state.draftSenderIds.size;
  const allVisibleSelected = visibleSenders.length > 0
    && visibleSenders.every((sender) => state.draftSenderIds.has(sender.id));
  telegramElements.caWatchEnabled.checked = state.draftEnabled;
  telegramElements.caWatchEnabled.disabled = state.busy || !state.loaded;
  telegramElements.caWatchSelectAll.checked = allVisibleSelected;
  telegramElements.caWatchSelectAll.indeterminate = !allVisibleSelected
    && visibleSenders.some((sender) => state.draftSenderIds.has(sender.id));
  telegramElements.caWatchSelectAll.disabled = state.busy || !visibleSenders.length;
  telegramElements.caWatchCount.textContent = `已选 ${selectedCount} 人`;
  telegramElements.caWatchSave.disabled = state.busy
    || !state.loaded
    || !telegramCaWatchDirty()
    || (state.draftEnabled && selectedCount === 0);

  const latest = state.latestDelivery;
  const latestStatus = String(latest?.status || '');
  const latestFailed = ['failed', 'interrupted'].includes(latestStatus);
  if (state.error) {
    telegramElements.caWatchSummary.textContent = state.error;
  } else if (latestStatus === 'no-targets') {
    telegramElements.caWatchSummary.textContent = '没有启用的 Bark API';
  } else if (latestFailed) {
    telegramElements.caWatchSummary.textContent = `最近推送失败 · ${latest?.sender_name || 'Telegram'}`;
  } else {
    telegramElements.caWatchSummary.textContent = `${state.senders.length} 位已发现发言人 · 新发言人自动记录 · EVM / Solana 地址`;
  }

  const status = state.busy
    ? { value: 'loading', label: '保存中' }
    : state.draftEnabled && !state.deliveryConfigured
      ? { value: 'warning', label: 'Bark 未配置' }
      : state.draftEnabled
        ? { value: 'enabled', label: '监控中' }
        : { value: 'disabled', label: '已关闭' };
  telegramElements.caWatchStatus.dataset.state = status.value;
  telegramElements.caWatchStatus.textContent = status.label;
  telegramElements.caWatchButton.classList.toggle('is-active', state.enabled);
  telegramElements.caWatchList.scrollTop = previousScrollTop;
}

function applyTelegramCaWatch(payload, { preserveDraft = false, draftEnabled, draftSenderIds } = {}) {
  const state = telegramState.caWatch;
  const wasLoaded = state.loaded;
  const beforeSignature = telegramCaWatchSignature(state);
  const senders = (Array.isArray(payload?.senders) ? payload.senders : [])
    .map(telegramCaWatchNormalizeSender)
    .filter(Boolean);
  const selectedIds = new Set(
    (Array.isArray(payload?.selected_sender_ids) ? payload.selected_sender_ids : [])
      .map(Number)
      .filter(Number.isSafeInteger)
  );
  state.loaded = true;
  state.enabled = Boolean(payload?.enabled);
  state.draftEnabled = preserveDraft ? Boolean(draftEnabled) : state.enabled;
  state.deliveryConfigured = Boolean(payload?.delivery_configured);
  state.senders = senders;
  state.selectedSenderIds = selectedIds;
  state.draftSenderIds = preserveDraft
    ? new Set(draftSenderIds || [])
    : new Set(selectedIds);
  state.latestDelivery = payload?.latest_delivery && typeof payload.latest_delivery === 'object'
    ? payload.latest_delivery
    : null;
  state.directory = payload?.directory && typeof payload.directory === 'object'
    ? payload.directory
    : null;
  state.error = '';
  if (!wasLoaded || beforeSignature !== telegramCaWatchSignature(state)) {
    renderTelegramCaWatch();
  }
}

async function loadTelegramCaWatch({ silent = false } = {}) {
  const state = telegramState.caWatch;
  if (state.busy || state.refreshing) return;
  const requestEpoch = ++state.requestEpoch;
  const hadError = Boolean(state.error);
  state.refreshing = true;
  state.busy = !silent;
  state.error = '';
  if (!silent) renderTelegramCaWatch();
  try {
    const payload = await fetchTelegramJson('/ca-watch');
    if (requestEpoch !== state.requestEpoch) return;
    const preserveDraft = state.loaded && telegramCaWatchDirty();
    applyTelegramCaWatch(payload, {
      preserveDraft,
      draftEnabled: state.draftEnabled,
      draftSenderIds: state.draftSenderIds
    });
  } catch (error) {
    if (requestEpoch === state.requestEpoch) {
      state.error = `CA Bark：${error.message}`;
    }
  } finally {
    if (requestEpoch !== state.requestEpoch) return;
    state.refreshing = false;
    state.busy = false;
    if (!silent || state.error || hadError) renderTelegramCaWatch();
  }
}

function stopTelegramCaWatchRefresh() {
  clearInterval(telegramState.caWatchTimer);
  telegramState.caWatchTimer = null;
}

function scheduleTelegramCaWatchRefresh() {
  stopTelegramCaWatchRefresh();
  if (telegramElements.caWatchPanel.hidden || !telegramState.active) return;
  telegramState.caWatchTimer = window.setInterval(
    () => void loadTelegramCaWatch({ silent: true }),
    TELEGRAM_CA_WATCH_REFRESH_INTERVAL_MS
  );
}

async function saveTelegramCaWatch() {
  const state = telegramState.caWatch;
  if (state.busy || !state.loaded || !telegramCaWatchDirty()) return;
  const requestEpoch = ++state.requestEpoch;
  state.refreshing = false;
  state.busy = true;
  state.error = '';
  renderTelegramCaWatch();
  try {
    const payload = await fetchTelegramJson('/ca-watch', {
      method: 'PUT',
      body: {
        enabled: state.draftEnabled,
        sender_ids: [...state.draftSenderIds]
      }
    });
    if (requestEpoch !== state.requestEpoch) return;
    applyTelegramCaWatch(payload);
  } catch (error) {
    if (requestEpoch === state.requestEpoch) {
      state.error = `保存失败：${error.message}`;
    }
  } finally {
    if (requestEpoch !== state.requestEpoch) return;
    state.busy = false;
    renderTelegramCaWatch();
  }
}

function toggleTelegramCaWatch() {
  const opening = telegramElements.caWatchPanel.hidden;
  telegramElements.caWatchPanel.hidden = !opening;
  telegramElements.caWatchButton.setAttribute('aria-expanded', String(opening));
  if (opening) {
    void loadTelegramCaWatch();
    scheduleTelegramCaWatchRefresh();
  } else {
    stopTelegramCaWatchRefresh();
  }
}

function renderTelegramAvatar(container, avatar, label) {
  const key = [avatar?.url, avatar?.initials, avatar?.color, label].join('|');
  if (container.dataset.avatarKey === key && container.childNodes.length) return;
  container.dataset.avatarKey = key;
  container.replaceChildren();
  container.style.background = avatar?.color || '#7294aa';
  container.textContent = avatar?.initials
    || String(label || 'TG').replace(/^@/, '').slice(0, 2).toUpperCase();
  if (!avatar?.url) return;

  const image = document.createElement('img');
  image.alt = `${label || 'Telegram'}头像`;
  image.decoding = 'async';
  image.addEventListener('load', () => container.replaceChildren(image), { once: true });
  image.addEventListener('error', () => image.remove(), { once: true });
  image.src = avatar.url;
}

function telegramMediaMode(media) {
  if (!media?.preview_url) return null;
  const declared = String(media.preview_type || '').toLowerCase();
  const source = String(media.preview_url).split('?', 1)[0].toLowerCase();
  return declared.includes('video') || /\.(?:webm|mp4|mov|m4v)$/.test(source)
    ? 'video'
    : 'image';
}

function telegramIsSticker(media) {
  return media?.sticker === true || /(?:贴纸|表情包|sticker)/i.test(String(media?.kind || ''));
}

function createTelegramMedia(media, compact = false) {
  const mode = telegramMediaMode(media);
  if (!mode) return null;
  const kind = String(media.kind || '媒体');
  const preview = document.createElement('div');
  preview.className = [
    'telegram-media',
    telegramIsSticker(media) ? 'is-sticker' : '',
    kind.includes('图片') ? 'is-photo' : '',
    compact ? 'is-compact' : ''
  ].filter(Boolean).join(' ');
  preview.setAttribute('aria-label', kind);

  const width = Number(media.width);
  const height = Number(media.height);
  if (width > 0 && height > 0) {
    preview.style.setProperty('--telegram-media-aspect', `${width} / ${height}`);
  }

  const node = mode === 'video' ? document.createElement('video') : document.createElement('img');
  if (mode === 'video') {
    node.autoplay = true;
    node.loop = true;
    node.muted = true;
    node.playsInline = true;
    node.preload = 'metadata';
  } else {
    node.alt = kind;
    node.loading = compact ? 'eager' : 'lazy';
    node.decoding = 'async';
    if (width > 0 && height > 0) {
      node.width = width;
      node.height = height;
    }
  }
  node.src = String(media.preview_url);
  node.addEventListener('error', () => preview.remove(), { once: true });
  preview.appendChild(node);
  return preview;
}

function telegramReply(message) {
  const raw = message?.reply_preview || message?.replyPreview;
  const value = raw && typeof raw === 'object' ? raw : {};
  const id = telegramNormalizeId(
    value.id
      ?? value.message_id
      ?? message?.reply_to
      ?? message?.replyTo
      ?? message?.reply_to_msg_id
  );
  if (!id) return null;
  const media = value.media && typeof value.media === 'object' ? value.media : null;
  return {
    id,
    available: value.available !== false,
    sender: String(value.sender || value.author || '回复消息'),
    avatar: value.avatar || null,
    text: String(value.text || value.raw_text || (media?.kind ? `[${media.kind}]` : `消息 #${id}`)),
    translatedText: String(value.translated_text || value.translatedText || ''),
    media
  };
}

function focusTelegramMessage(id) {
  const feed = telegramElements.feed;
  const row = Array.from(feed.querySelectorAll('.telegram-message-row'))
    .find((item) => item.dataset.messageId === telegramNormalizeId(id));
  if (!row) return;
  const desiredTop = feed.scrollTop
    + row.getBoundingClientRect().top
    - feed.getBoundingClientRect().top
    - ((feed.clientHeight - row.offsetHeight) / 2);
  feed.scrollTo({ top: Math.max(0, desiredTop), behavior: 'smooth' });
  row.classList.remove('is-target');
  void row.offsetWidth;
  row.classList.add('is-target');
  window.setTimeout(() => row.classList.remove('is-target'), 1_400);
}

function scrollTelegramToLatest({ behavior = 'smooth' } = {}) {
  const feed = telegramElements.feed;
  feed.scrollTo({ top: feed.scrollHeight, behavior });
}

function createTelegramReply(message, availableIds) {
  const reply = telegramReply(message);
  if (!reply) return null;
  const locatable = reply.available && availableIds.has(reply.id);
  const element = document.createElement(locatable ? 'button' : 'div');
  element.className = `telegram-reply${locatable ? '' : ' is-unavailable'}`;
  element.title = locatable
    ? '查看原消息'
    : (reply.available ? '原消息不在当前列表' : '原消息不可用');
  if (locatable) {
    element.type = 'button';
    element.addEventListener('click', () => focusTelegramMessage(reply.id));
  }

  const bar = document.createElement('span');
  bar.className = 'telegram-reply-bar';
  bar.setAttribute('aria-hidden', 'true');
  element.appendChild(bar);

  const avatar = document.createElement('span');
  avatar.className = 'telegram-avatar telegram-reply-avatar';
  renderTelegramAvatar(avatar, reply.avatar, reply.sender);
  element.appendChild(avatar);

  const copy = document.createElement('span');
  copy.className = 'telegram-reply-copy';
  const sender = document.createElement('strong');
  sender.textContent = reply.sender;
  const text = document.createElement('span');
  text.textContent = reply.text;
  copy.append(sender, text);
  if (reply.translatedText && reply.translatedText !== reply.text) {
    const translated = document.createElement('span');
    translated.className = 'telegram-reply-translation';
    translated.textContent = `中文：${reply.translatedText}`;
    copy.appendChild(translated);
  }
  const media = createTelegramMedia(reply.media, true);
  if (media) copy.appendChild(media);
  element.appendChild(copy);
  return element;
}

function telegramGeneratedPlaceholder(text, media) {
  return Boolean(media) && /^\[(?:媒体|图片|视频|语音|音频|贴纸|文件|投票|联系人|位置|无文字内容)\]$/
    .test(String(text || '').trim());
}

function telegramSenderKey(message) {
  return `${message?.sender_id || ''}:${message?.sender || ''}`;
}

function createTelegramMessage(message, sameSender, availableIds) {
  const row = document.createElement('li');
  row.className = `telegram-message-row ${message.outgoing ? 'is-outgoing' : 'is-incoming'}`;
  row.dataset.messageId = telegramNormalizeId(message.id);
  row.dataset.day = telegramDayLabel(message.date);

  if (!message.outgoing) {
    const avatarColumn = document.createElement('div');
    avatarColumn.className = 'telegram-avatar-column';
    if (sameSender) {
      avatarColumn.classList.add('is-spacer');
    } else {
      const avatar = document.createElement('div');
      avatar.className = 'telegram-avatar';
      renderTelegramAvatar(avatar, message.avatar, message.sender);
      avatarColumn.appendChild(avatar);
    }
    row.appendChild(avatarColumn);
  }

  const bubble = document.createElement('article');
  bubble.className = 'telegram-message-bubble';
  if (!message.outgoing && !sameSender) {
    const sender = document.createElement('strong');
    sender.className = 'telegram-message-sender';
    sender.textContent = message.sender || '未知发送者';
    bubble.appendChild(sender);
  }

  const reply = createTelegramReply(message, availableIds);
  if (reply) bubble.appendChild(reply);
  const media = createTelegramMedia(message.media);
  if (media) bubble.appendChild(media);

  const textValue = String(message.text || '[无文字内容]');
  const generated = telegramGeneratedPlaceholder(textValue, message.media);
  const kind = String(message.media?.kind || '');
  if (media && generated && telegramIsSticker(message.media) && !reply) bubble.classList.add('is-sticker-only');
  if (media && generated && kind.includes('图片') && !reply) bubble.classList.add('is-photo-only');
  if (!media || !generated) {
    const text = document.createElement('p');
    text.className = 'telegram-message-text';
    text.textContent = textValue;
    bubble.appendChild(text);
  }

  const translatedValue = String(message.translated_text || message.translatedText || '').trim();
  if (translatedValue && translatedValue !== textValue) {
    const translated = document.createElement('div');
    translated.className = 'telegram-message-translation';
    const label = document.createElement('b');
    label.textContent = '中文翻译';
    const copy = document.createElement('p');
    copy.textContent = translatedValue;
    translated.append(label, copy);
    bubble.appendChild(translated);
  }

  if (message.media && !media) {
    const fallback = document.createElement('span');
    fallback.className = 'telegram-media-fallback';
    fallback.textContent = message.media.name
      ? `${message.media.kind} · ${message.media.name}`
      : String(message.media.kind || '媒体');
    bubble.appendChild(fallback);
  }

  const time = document.createElement('time');
  time.className = 'telegram-message-time';
  time.dateTime = message.date || '';
  time.textContent = telegramFormatTime(message.date);
  bubble.appendChild(time);
  row.appendChild(bubble);
  return row;
}

function createTelegramDateSeparator(label) {
  const item = document.createElement('li');
  item.className = 'telegram-date-separator';
  item.dataset.day = label;
  const text = document.createElement('span');
  text.textContent = label;
  item.appendChild(text);
  return item;
}

function fullRenderTelegramMessages(messages) {
  const fragment = document.createDocumentFragment();
  const availableIds = new Set(messages.map((message) => telegramNormalizeId(message.id)).filter(Boolean));
  let previousSender = '';
  let previousDay = '';
  for (const message of messages) {
    const day = telegramDayLabel(message.date);
    if (day !== previousDay) {
      fragment.appendChild(createTelegramDateSeparator(day));
      previousDay = day;
      previousSender = '';
    }
    const sender = telegramSenderKey(message);
    const sameSender = !message.outgoing && sender === previousSender;
    fragment.appendChild(createTelegramMessage(message, sameSender, availableIds));
    previousSender = sender;
  }
  telegramElements.feed.replaceChildren(fragment);
}

function removeEmptyTelegramDates() {
  telegramElements.feed.querySelectorAll('.telegram-date-separator').forEach((separator) => {
    const next = separator.nextElementSibling;
    if (!next || next.classList.contains('telegram-date-separator')) separator.remove();
  });
}

function incrementTelegramMessages(messages) {
  const previous = telegramState.renderedMessages;
  if (!previous.length || !messages.length) return false;
  const previousIds = previous.map((message) => telegramNormalizeId(message.id));
  const nextIds = messages.map((message) => telegramNormalizeId(message.id));
  const retainedStart = previousIds.indexOf(nextIds[0]);
  if (retainedStart < 0) return false;

  let overlap = 0;
  while (retainedStart + overlap < previousIds.length
    && overlap < nextIds.length
    && previousIds[retainedStart + overlap] === nextIds[overlap]) overlap += 1;
  if (overlap !== previousIds.length - retainedStart) return false;

  const feed = telegramElements.feed;
  const keepAtBottom = feed.scrollHeight - feed.scrollTop - feed.clientHeight < 90;
  for (const id of previousIds.slice(0, retainedStart)) {
    Array.from(feed.querySelectorAll('.telegram-message-row'))
      .find((row) => row.dataset.messageId === id)?.remove();
  }
  removeEmptyTelegramDates();

  const availableIds = new Set(nextIds.filter(Boolean));
  let previousMessage = overlap ? messages[overlap - 1] : null;
  let previousSender = previousMessage ? telegramSenderKey(previousMessage) : '';
  let previousDay = previousMessage ? telegramDayLabel(previousMessage.date) : '';
  for (let index = overlap; index < messages.length; index += 1) {
    const message = messages[index];
    const day = telegramDayLabel(message.date);
    if (day !== previousDay) {
      feed.appendChild(createTelegramDateSeparator(day));
      previousDay = day;
      previousSender = '';
    }
    const sender = telegramSenderKey(message);
    feed.appendChild(createTelegramMessage(
      message,
      !message.outgoing && sender === previousSender,
      availableIds
    ));
    previousSender = sender;
  }
  if (keepAtBottom) feed.scrollTop = feed.scrollHeight;
  return true;
}

function renderTelegramEmpty(message, detail) {
  const item = document.createElement('li');
  item.className = 'telegram-empty-state';
  const title = document.createElement('strong');
  title.textContent = message;
  const copy = document.createElement('span');
  copy.textContent = detail;
  item.append(title, copy);
  telegramElements.feed.replaceChildren(item);
}

function updateTelegramHeader(payload) {
  const sources = Array.isArray(payload?.sources) ? payload.sources : [];
  const source = sources.find((item) => Number(item?.id) === telegramState.sourceId)
    || sources.find((item) => String(item?.name || '').startsWith(TELEGRAM_PINNED_SOURCE_NAME))
    || telegramState.source
    || payload?.source
    || {};
  telegramState.source = source;
  telegramElements.sourceName.textContent = source.name || 'Telegram';
  telegramElements.sourceKind.textContent = source.kind || '实时消息';
  const visibleCount = Array.isArray(payload?.messages)
    ? payload.messages.filter((message) => (
      message?.adult !== true
      && message?.blocked !== true
      && message?.sensitive !== true
      && message?.chat?.adult !== true
      && message?.chat?.blocked !== true
      && message?.chat?.sensitive !== true
    )).length
    : Number(payload?.count || 0);
  telegramElements.messageCount.textContent = `${visibleCount} 条消息`;
  telegramElements.updatedAt.textContent = payload?.updated_at
    ? `同步于 ${telegramFormatTime(payload.updated_at)}`
    : '等待同步';
  renderTelegramAvatar(telegramElements.sourceAvatar, source.avatar, source.name);
}

function renderTelegramPayload(payload) {
  const messages = (Array.isArray(payload?.messages) ? payload.messages : [])
    .filter((message) => (
      message?.adult !== true
      && message?.blocked !== true
      && message?.sensitive !== true
      && message?.chat?.adult !== true
      && message?.chat?.blocked !== true
      && message?.chat?.sensitive !== true
    ));
  updateTelegramHeader({ ...payload, messages });
  const nextVersion = telegramPayloadVersion(payload);
  if (nextVersion === telegramState.version) return;

  const wasFirst = telegramState.firstRender;
  if (!messages.length) {
    renderTelegramEmpty('暂无 Telegram 消息', '新消息到达后会自动显示。');
  } else if (wasFirst || !incrementTelegramMessages(messages)) {
    fullRenderTelegramMessages(messages);
  }
  telegramState.renderedMessages = messages;
  telegramState.version = nextVersion;
  telegramState.firstRender = false;
  if (wasFirst && messages.length) telegramElements.feed.scrollTop = telegramElements.feed.scrollHeight;
}

async function fetchTelegramJson(path, { signal, method = 'GET', body = null } = {}) {
  const response = await fetch(`${TELEGRAM_API_ROOT}${path}`, {
    method,
    cache: 'no-store',
    credentials: 'same-origin',
    signal,
    headers: body ? { 'Content-Type': 'application/json' } : undefined,
    body: body ? JSON.stringify(body) : undefined
  });
  let payload = null;
  try {
    payload = await response.json();
  } catch {
    payload = null;
  }
  if (!response.ok) {
    const error = new Error(payload?.error || `HTTP ${response.status}`);
    error.status = response.status;
    throw error;
  }
  return payload || {};
}

async function ensureTelegramPinnedSource(signal) {
  if (telegramState.sourceId !== null) return telegramState.sourceId;
  const catalog = await fetchTelegramJson('/chats', { signal });
  const chats = Array.isArray(catalog?.chats) ? catalog.chats : [];
  const source = chats.find((chat) => String(chat?.name || chat?.title || '').startsWith(TELEGRAM_PINNED_SOURCE_NAME));
  const sourceId = Number(source?.id);
  if (!Number.isSafeInteger(sourceId)) throw new Error(`找不到 ${TELEGRAM_PINNED_SOURCE_NAME} 群组`);

  telegramState.sourceId = sourceId;
  telegramState.source = source;
  window.__telegramPinnedChatId = sourceId;
  window.dispatchEvent(new CustomEvent('telegram-pinned-source', { detail: { id: sourceId, source } }));
  if (!telegramState.caWatch.loaded) void loadTelegramCaWatch();

  const selectedIds = (Array.isArray(catalog?.selected_chat_ids) ? catalog.selected_chat_ids : [])
    .map(Number)
    .filter(Number.isSafeInteger);
  if (!selectedIds.includes(sourceId)) {
    await fetchTelegramJson('/selection', {
      method: 'POST',
      body: { chat_ids: [sourceId, ...selectedIds] },
      signal
    });
  }
  return sourceId;
}

function scheduleTelegramLoad(delay = TELEGRAM_POLL_INTERVAL_MS) {
  clearTimeout(telegramState.timer);
  if (!telegramState.active) return;
  telegramState.timer = window.setTimeout(() => void loadTelegramMessages(), delay);
}

async function loadTelegramMessages({ manual = false } = {}) {
  if (!telegramState.active || telegramState.busy) return;
  telegramState.busy = true;
  telegramElements.refreshButton.disabled = true;
  const controller = new AbortController();
  telegramState.controller = controller;
  try {
    const sourceId = await ensureTelegramPinnedSource(controller.signal);
    const payload = await fetchTelegramJson(
      `/messages?limit=${TELEGRAM_MESSAGE_LIMIT}&chat_id=${encodeURIComponent(sourceId)}`,
      { signal: controller.signal }
    );
    renderTelegramPayload(payload);
    let status = null;
    if (manual || Date.now() - telegramState.statusCheckedAt >= TELEGRAM_STATUS_INTERVAL_MS) {
      status = await fetchTelegramJson('/status', { signal: controller.signal });
      telegramState.statusCheckedAt = Date.now();
    }
    if (status?.error) {
      setTelegramConnection('warning', '部分异常', String(status.error));
    } else {
      const sourceName = telegramState.source?.name || TELEGRAM_PINNED_SOURCE_NAME;
      setTelegramConnection('online', '实时连接', `${sourceName} · 每 2 秒同步`);
    }
  } catch (error) {
    if (error.name === 'AbortError') return;
    if (error.status === 401) {
      setTelegramConnection('auth', '需要登录', 'Telegram 私密消息需要访问凭据');
    } else {
      setTelegramConnection('error', '连接失败', `Telegram：${error.message}`);
    }
    if (telegramState.firstRender) {
      renderTelegramEmpty('Telegram 暂时不可用', error.status === 401
        ? '完成访问验证后会自动重连。'
        : '服务恢复后会自动重连。');
    }
  } finally {
    if (telegramState.controller === controller) telegramState.controller = null;
    telegramState.busy = false;
    telegramElements.refreshButton.disabled = false;
    scheduleTelegramLoad(manual ? 500 : TELEGRAM_POLL_INTERVAL_MS);
  }
}

function startTelegramMonitor() {
  if (telegramState.active) return;
  telegramState.active = true;
  setTelegramConnection('loading', '正在连接', `正在读取 ${TELEGRAM_PINNED_SOURCE_NAME} 群组消息`);
  void loadTelegramMessages();
}

function stopTelegramMonitor() {
  telegramState.active = false;
  clearTimeout(telegramState.timer);
  telegramState.timer = null;
  stopTelegramCaWatchRefresh();
  telegramState.controller?.abort();
  telegramState.controller = null;
  telegramState.busy = false;
}

function synchronizeTelegramLifecycle() {
  const visible = !telegramElements.monitorPage.hidden && document.visibilityState !== 'hidden';
  if (visible) {
    startTelegramMonitor();
    scheduleTelegramCaWatchRefresh();
  } else stopTelegramMonitor();
}

if (Object.values(telegramElements).every(Boolean)) {
  telegramElements.caWatchButton.addEventListener('click', toggleTelegramCaWatch);
  telegramElements.caWatchEnabled.addEventListener('change', () => {
    telegramState.caWatch.draftEnabled = telegramElements.caWatchEnabled.checked;
    renderTelegramCaWatch();
  });
  telegramElements.caWatchSearch.addEventListener('input', () => {
    telegramState.caWatch.searchQuery = telegramElements.caWatchSearch.value;
    renderTelegramCaWatch();
  });
  telegramElements.caWatchSelectAll.addEventListener('change', () => {
    const visibleSenders = telegramCaWatchVisibleSenders();
    if (telegramElements.caWatchSelectAll.checked) {
      for (const sender of visibleSenders) telegramState.caWatch.draftSenderIds.add(sender.id);
    } else {
      for (const sender of visibleSenders) telegramState.caWatch.draftSenderIds.delete(sender.id);
    }
    renderTelegramCaWatch();
  });
  telegramElements.caWatchSave.addEventListener('click', () => void saveTelegramCaWatch());
  telegramElements.latestButton.addEventListener('click', () => scrollTelegramToLatest());
  telegramElements.refreshButton.addEventListener('click', () => void loadTelegramMessages({ manual: true }));
  new MutationObserver(synchronizeTelegramLifecycle).observe(telegramElements.monitorPage, {
    attributes: true,
    attributeFilter: ['hidden']
  });
  document.addEventListener('visibilitychange', synchronizeTelegramLifecycle);
  synchronizeTelegramLifecycle();
}
