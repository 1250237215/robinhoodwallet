const TELEGRAM_SOCIAL_APP_BASE = /^\/robinhood-radar(?:\/|$)/.test(window.location.pathname)
  ? '/robinhood-radar'
  : '';
const TELEGRAM_SOCIAL_API_ROOT = `${TELEGRAM_SOCIAL_APP_BASE}/telegram/api`;
const TELEGRAM_SOCIAL_POLL_MS = 2_000;
const TELEGRAM_SOCIAL_CATALOG_MS = 30_000;
const TELEGRAM_SOCIAL_MESSAGE_LIMIT = 300;
const TELEGRAM_SOCIAL_PINNED_NAME = 'LazyCat FNF';

const telegramSocialElements = {
  monitorPage: document.querySelector('#monitor-page'),
  socialManager: document.querySelector('#social-watchlist-manager'),
  globalRefresh: document.querySelector('#social-refresh-button'),
  refresh: document.querySelector('#telegram-social-refresh'),
  summary: document.querySelector('#telegram-social-manager-summary'),
  search: document.querySelector('#telegram-social-search'),
  selectAll: document.querySelector('#telegram-social-select-all'),
  chatList: document.querySelector('#telegram-social-chat-list'),
  selectedCount: document.querySelector('#telegram-social-selected-count'),
  save: document.querySelector('#telegram-social-save')
};

const telegramSocialState = {
  active: false,
  busy: false,
  catalogBusy: false,
  selectionBusy: false,
  timer: null,
  messagesController: null,
  catalogController: null,
  selectionController: null,
  catalogCheckedAt: 0,
  chats: [],
  selectedChatIds: new Set(),
  draftChatIds: new Set(),
  caBarkChatIds: new Set(),
  draftCaBarkChatIds: new Set(),
  // Keep local edits authoritative until the user explicitly saves them.
  // The catalog/messages endpoints are polled independently and may return a
  // response that was started before the latest selection write completed.
  draftDirty: false,
  draftRevision: 0,
  selectionEpoch: 0,
  pinnedChatId: null,
  searchQuery: '',
  error: '',
  version: ''
};

function telegramSocialNumericId(value) {
  const id = Number(value);
  return Number.isSafeInteger(id) ? id : null;
}

function telegramSocialMessageKey(message) {
  const streamId = message?.stream_id ?? message?.streamId;
  if (streamId !== null && streamId !== undefined && streamId !== '') return String(streamId);
  const chatId = message?.chat_id ?? message?.chat?.id;
  const messageId = message?.id;
  return chatId !== null && chatId !== undefined && messageId !== null && messageId !== undefined
    ? `${chatId}:${messageId}`
    : String(messageId ?? '');
}

function telegramSocialNormalizeChat(chat) {
  const id = telegramSocialNumericId(chat?.id);
  if (id === null) return null;
  return {
    id,
    name: String(chat?.name || chat?.title || `聊天 ${id}`),
    kind: String(chat?.kind || chat?.type || '聊天'),
    username: chat?.username ? String(chat.username).replace(/^@/, '') : '',
    unreadCount: Number(chat?.unread_count) || 0,
    avatar: chat?.avatar && typeof chat.avatar === 'object' ? chat.avatar : null,
    selected: Boolean(chat?.selected),
    caBarkEnabled: Boolean(chat?.ca_bark_enabled ?? chat?.caBarkEnabled),
    blocked: chat?.blocked === true || chat?.adult === true || chat?.sensitive === true
  };
}

function telegramSocialPinnedId() {
  return telegramSocialState.pinnedChatId
    ?? telegramSocialNumericId(window.__telegramPinnedChatId);
}

function telegramSocialUpdatePinnedChat() {
  const pinned = telegramSocialState.chats.find((chat) => chat.name.startsWith(TELEGRAM_SOCIAL_PINNED_NAME));
  if (!pinned) return;
  telegramSocialState.pinnedChatId = pinned.id;
  window.__telegramPinnedChatId = pinned.id;
  telegramSocialState.selectedChatIds.delete(pinned.id);
  telegramSocialState.draftChatIds.delete(pinned.id);
  telegramSocialState.caBarkChatIds.delete(pinned.id);
  telegramSocialState.draftCaBarkChatIds.delete(pinned.id);
}

function telegramSocialIsPinnedMessage(message) {
  const pinnedId = telegramSocialPinnedId();
  return pinnedId !== null
    && telegramSocialNumericId(message?.chat_id ?? message?.chat?.id) === pinnedId;
}

function telegramSocialMergeChats(chats, { replace = false } = {}) {
  if (!Array.isArray(chats)) return;
  const normalized = chats.map(telegramSocialNormalizeChat).filter(Boolean);
  if (replace) {
    telegramSocialState.chats = [...new Map(normalized.map((chat) => [chat.id, chat])).values()];
    telegramSocialUpdatePinnedChat();
    return;
  }
  const byId = new Map(telegramSocialState.chats.map((chat) => [chat.id, chat]));
  for (const chat of normalized) byId.set(chat.id, { ...byId.get(chat.id), ...chat });
  telegramSocialState.chats = [...byId.values()];
  telegramSocialUpdatePinnedChat();
}

function telegramSocialSelectedIds(payload) {
  const raw = Array.isArray(payload?.selected_chat_ids)
    ? payload.selected_chat_ids
    : Array.isArray(payload?.sources)
      ? payload.sources.map((source) => source?.id)
      : Array.isArray(payload?.chats)
        ? payload.chats.filter((chat) => chat?.selected).map((chat) => chat.id)
        : null;
  if (!raw) return null;
  const pinnedId = telegramSocialPinnedId();
  const blockedIds = new Set(telegramSocialState.chats.filter((chat) => chat.blocked).map((chat) => chat.id));
  return new Set(raw
    .map(telegramSocialNumericId)
    .filter((id) => id !== null && id !== pinnedId && !blockedIds.has(id)));
}

function telegramSocialCaBarkIds(payload) {
  const raw = Array.isArray(payload?.social_ca_bark_chat_ids)
    ? payload.social_ca_bark_chat_ids
    : Array.isArray(payload?.ca_bark_chat_ids)
      ? payload.ca_bark_chat_ids
      : Array.isArray(payload?.chats)
        ? payload.chats.filter((chat) => chat?.ca_bark_enabled === true).map((chat) => chat.id)
        : null;
  if (!raw) return null;
  const pinnedId = telegramSocialPinnedId();
  const blockedIds = new Set(telegramSocialState.chats.filter((chat) => chat.blocked).map((chat) => chat.id));
  return new Set(raw
    .map(telegramSocialNumericId)
    .filter((id) => id !== null && id !== pinnedId && !blockedIds.has(id)));
}

function telegramSocialSyncCatalog(payload, { replace = false, ignoreSelection = false } = {}) {
  if (Array.isArray(payload?.chats)) telegramSocialMergeChats(payload.chats, { replace });
  if (Array.isArray(payload?.sources)) telegramSocialMergeChats(payload.sources);
  const selected = telegramSocialSelectedIds(payload);
  const caBark = telegramSocialCaBarkIds(payload);
  if (selected && !ignoreSelection && !telegramSocialState.selectionBusy) {
    telegramSocialState.selectedChatIds = selected;
    // A 2-second message poll or 30-second catalog refresh must not erase an
    // unchecked/checked box that the user has not saved yet.  This was the
    // source of the intermittent "channel unchecks itself" behavior.
    if (!telegramSocialState.draftDirty) {
      telegramSocialState.draftChatIds = new Set(selected);
    }
  }
  if (caBark && !ignoreSelection && !telegramSocialState.selectionBusy) {
    telegramSocialState.caBarkChatIds = caBark;
    if (!telegramSocialState.draftDirty) {
      telegramSocialState.draftCaBarkChatIds = new Set(caBark);
    }
  }
  telegramSocialRenderManager();
}

function telegramSocialSetsEqual(left, right) {
  if (left.size !== right.size) return false;
  for (const value of left) if (!right.has(value)) return false;
  return true;
}

function telegramSocialRecordDraftChange() {
  telegramSocialState.draftRevision += 1;
  telegramSocialState.draftDirty = !telegramSocialSetsEqual(
    telegramSocialState.draftChatIds,
    telegramSocialState.selectedChatIds
  ) || !telegramSocialSetsEqual(
    telegramSocialState.draftCaBarkChatIds,
    telegramSocialState.caBarkChatIds
  );
}

function telegramSocialVisibleChats() {
  const selectableChats = telegramSocialState.chats.filter((chat) => chat.id !== telegramSocialPinnedId())
    .filter((chat) => !chat.blocked);
  const query = telegramSocialState.searchQuery.trim().toLocaleLowerCase('zh-CN');
  if (!query) return selectableChats;
  return selectableChats.filter((chat) => (
    `${chat.name} ${chat.kind} ${chat.username}`.toLocaleLowerCase('zh-CN').includes(query)
  ));
}

function telegramSocialRenderAvatar(container, chat) {
  const avatar = chat.avatar || {};
  container.style.background = avatar.color || '#27332d';
  container.textContent = avatar.initials
    || String(chat.name || 'TG').replace(/^@/, '').slice(0, 2).toUpperCase();
  if (!avatar.url) return;
  const image = document.createElement('img');
  image.alt = '';
  image.decoding = 'async';
  image.addEventListener('load', () => container.replaceChildren(image), { once: true });
  image.addEventListener('error', () => image.remove(), { once: true });
  image.src = String(avatar.url);
}

function telegramSocialRenderManager() {
  const visibleChats = telegramSocialVisibleChats();
  telegramSocialElements.chatList.replaceChildren();

  if (telegramSocialState.catalogBusy && !telegramSocialState.chats.length) {
    const loading = document.createElement('p');
    loading.className = 'telegram-social-manager-state';
    loading.textContent = '正在读取可访问的群组和频道…';
    telegramSocialElements.chatList.appendChild(loading);
  } else if (!visibleChats.length) {
    const empty = document.createElement('p');
    empty.className = 'telegram-social-manager-state';
    empty.textContent = telegramSocialState.chats.length ? '没有匹配的聊天' : '没有可访问的群组或频道';
    telegramSocialElements.chatList.appendChild(empty);
  } else {
    const fragment = document.createDocumentFragment();
    for (const chat of visibleChats) {
      const option = document.createElement('label');
      option.className = 'telegram-social-chat-option';

      const checkbox = document.createElement('input');
      checkbox.type = 'checkbox';
      checkbox.checked = telegramSocialState.draftChatIds.has(chat.id);
      checkbox.disabled = telegramSocialState.selectionBusy;
      checkbox.title = '加入社媒监控';
      checkbox.setAttribute('aria-label', `${chat.name} 加入社媒监控`);
      checkbox.addEventListener('change', () => {
        if (checkbox.checked) telegramSocialState.draftChatIds.add(chat.id);
        else {
          telegramSocialState.draftChatIds.delete(chat.id);
          telegramSocialState.draftCaBarkChatIds.delete(chat.id);
        }
        telegramSocialRecordDraftChange();
        telegramSocialRenderManager();
      });

      const caBarkCheckbox = document.createElement('input');
      caBarkCheckbox.type = 'checkbox';
      caBarkCheckbox.className = 'telegram-social-ca-bark-checkbox';
      caBarkCheckbox.checked = telegramSocialState.draftCaBarkChatIds.has(chat.id);
      caBarkCheckbox.disabled = telegramSocialState.selectionBusy
        || !telegramSocialState.draftChatIds.has(chat.id);
      caBarkCheckbox.title = '发现 CA 时 Bark';
      caBarkCheckbox.setAttribute('aria-label', `${chat.name} 发现 CA 时 Bark`);
      caBarkCheckbox.addEventListener('change', () => {
        if (caBarkCheckbox.checked) telegramSocialState.draftCaBarkChatIds.add(chat.id);
        else telegramSocialState.draftCaBarkChatIds.delete(chat.id);
        telegramSocialState.draftDirty = true;
        telegramSocialRenderManager();
      });

      const avatar = document.createElement('span');
      avatar.className = 'social-watchlist-avatar';
      telegramSocialRenderAvatar(avatar, chat);

      const copy = document.createElement('span');
      copy.className = 'telegram-social-chat-copy';
      const name = document.createElement('strong');
      name.textContent = chat.name;
      const kind = document.createElement('span');
      kind.textContent = chat.username ? `${chat.kind} · @${chat.username}` : chat.kind;
      copy.append(name, kind);

      const status = document.createElement('span');
      status.className = 'social-sync-chip';
      status.dataset.state = telegramSocialState.selectedChatIds.has(chat.id) ? 'synced' : 'pending';
      status.textContent = telegramSocialState.selectedChatIds.has(chat.id)
        ? (telegramSocialState.caBarkChatIds.has(chat.id) ? '监控中 · CA Bark 已开' : '监控中 · CA Bark 未开')
        : '未选择';
      option.append(checkbox, avatar, copy, caBarkCheckbox, status);
      fragment.appendChild(option);
    }
    telegramSocialElements.chatList.appendChild(fragment);
  }

  const selectedCount = telegramSocialState.draftChatIds.size;
  telegramSocialElements.selectedCount.textContent = `已选 ${selectedCount} 个`;
  telegramSocialElements.summary.textContent = telegramSocialState.error
    || `${telegramSocialState.chats.filter((chat) => chat.id !== telegramSocialPinnedId() && !chat.blocked).length} 个可选聊天 · ${telegramSocialState.selectedChatIds.size} 个监控中 · 左侧监控 / 右侧 CA Bark`;
  const allSelected = visibleChats.length > 0
    && visibleChats.every((chat) => telegramSocialState.draftChatIds.has(chat.id));
  telegramSocialElements.selectAll.checked = allSelected;
  telegramSocialElements.selectAll.indeterminate = !allSelected
    && visibleChats.some((chat) => telegramSocialState.draftChatIds.has(chat.id));
  telegramSocialElements.selectAll.disabled = !visibleChats.length || telegramSocialState.selectionBusy;
  telegramSocialElements.save.disabled = telegramSocialState.selectionBusy
    || (telegramSocialSetsEqual(telegramSocialState.draftChatIds, telegramSocialState.selectedChatIds)
      && telegramSocialSetsEqual(telegramSocialState.draftCaBarkChatIds, telegramSocialState.caBarkChatIds));
}

async function telegramSocialFetchJson(path, { method = 'GET', body = null, signal } = {}) {
  const response = await fetch(`${TELEGRAM_SOCIAL_API_ROOT}${path}`, {
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
  if (!response.ok) throw new Error(payload?.error || `HTTP ${response.status}`);
  return payload || {};
}

function telegramSocialPublish(payload, error = '', { ignoreSelection = false } = {}) {
  const previous = window.__telegramSocialSnapshot || {};
  const catalog = new Map(telegramSocialState.chats.map((chat) => [chat.id, chat]));
  const messages = (Array.isArray(payload?.messages) ? payload.messages : previous.messages || [])
    .filter((message) => !telegramSocialIsPinnedMessage(message))
    .filter((message) => message?.blocked !== true
      && message?.adult !== true
      && message?.chat?.blocked !== true
      && message?.chat?.adult !== true)
    .map((message) => {
      const chatId = telegramSocialNumericId(message?.chat_id ?? message?.chat?.id);
      const catalogChat = chatId === null ? null : catalog.get(chatId);
      return catalogChat ? { ...message, chat: { ...catalogChat, ...(message.chat || {}) } } : message;
    });
  const selectedChatIds = ignoreSelection
    ? telegramSocialState.selectedChatIds
    : telegramSocialSelectedIds(payload) || telegramSocialState.selectedChatIds;
  const caBarkChatIds = ignoreSelection
    ? telegramSocialState.caBarkChatIds
    : telegramSocialCaBarkIds(payload) || telegramSocialState.caBarkChatIds;
  const snapshot = {
    messages,
    sources: (Array.isArray(payload?.sources) ? payload.sources : previous.sources || [])
      .filter((source) => telegramSocialNumericId(source?.id) !== telegramSocialPinnedId()
        && source?.blocked !== true
        && source?.adult !== true),
    selected_chat_ids: [...selectedChatIds],
    social_ca_bark_chat_ids: [...caBarkChatIds],
    updated_at: payload?.updated_at || previous.updated_at || null,
    received_at: Date.now(),
    connected: !error,
    error: error || ''
  };
  window.__telegramSocialSnapshot = snapshot;
  window.dispatchEvent(new CustomEvent('telegram-social-update', { detail: snapshot }));
}

async function telegramSocialLoadChats({ force = false } = {}) {
  if (!telegramSocialState.active || telegramSocialState.catalogBusy) return;
  if (!force && Date.now() - telegramSocialState.catalogCheckedAt < TELEGRAM_SOCIAL_CATALOG_MS) return;
  telegramSocialState.catalogBusy = true;
  telegramSocialState.error = '';
  telegramSocialRenderManager();
  const controller = new AbortController();
  const selectionEpoch = telegramSocialState.selectionEpoch;
  telegramSocialState.catalogController = controller;
  try {
    const payload = await telegramSocialFetchJson('/chats', { signal: controller.signal });
    // A request started before a save may legally finish after it.  Keep its
    // catalog metadata, but never let its stale selection state win.
    telegramSocialSyncCatalog(payload, {
      replace: true,
      ignoreSelection: selectionEpoch !== telegramSocialState.selectionEpoch
    });
    telegramSocialState.catalogCheckedAt = Date.now();
  } catch (error) {
    if (error.name !== 'AbortError') telegramSocialState.error = `Telegram：${error.message}`;
  } finally {
    if (telegramSocialState.catalogController === controller) telegramSocialState.catalogController = null;
    telegramSocialState.catalogBusy = false;
    telegramSocialRenderManager();
  }
}

function telegramSocialSchedule(delay = TELEGRAM_SOCIAL_POLL_MS) {
  clearTimeout(telegramSocialState.timer);
  if (!telegramSocialState.active) return;
  telegramSocialState.timer = window.setTimeout(() => void telegramSocialLoadMessages(), delay);
}

async function telegramSocialLoadMessages({ manual = false } = {}) {
  if (!telegramSocialState.active || telegramSocialState.busy) return;
  if (telegramSocialState.selectionBusy) {
    telegramSocialSchedule(250);
    return;
  }
  telegramSocialState.busy = true;
  telegramSocialElements.refresh.disabled = true;
  const controller = new AbortController();
  const selectionEpoch = telegramSocialState.selectionEpoch;
  telegramSocialState.messagesController = controller;
  try {
    const payload = await telegramSocialFetchJson(`/messages?limit=${TELEGRAM_SOCIAL_MESSAGE_LIMIT}`, {
      signal: controller.signal
    });
    const ignoreSelection = telegramSocialState.selectionBusy
      || selectionEpoch !== telegramSocialState.selectionEpoch;
    telegramSocialSyncCatalog(payload, {
      ignoreSelection
    });
    const messages = (Array.isArray(payload.messages) ? payload.messages : [])
      .filter((message) => !telegramSocialIsPinnedMessage(message)
        && message?.blocked !== true
        && message?.adult !== true
        && message?.chat?.blocked !== true
        && message?.chat?.adult !== true);
    const nextVersion = [
      payload.updated_at || '',
      ...messages.map(telegramSocialMessageKey)
    ].join('|');
    if (nextVersion !== telegramSocialState.version || window.__telegramSocialSnapshot?.error) {
      telegramSocialState.version = nextVersion;
      telegramSocialPublish(payload, '', { ignoreSelection });
    }
    if (manual || Date.now() - telegramSocialState.catalogCheckedAt >= TELEGRAM_SOCIAL_CATALOG_MS) {
      void telegramSocialLoadChats();
    }
  } catch (error) {
    if (error.name !== 'AbortError') {
      telegramSocialState.error = `Telegram：${error.message}`;
      telegramSocialPublish({}, telegramSocialState.error);
      telegramSocialRenderManager();
    }
  } finally {
    if (telegramSocialState.messagesController === controller) telegramSocialState.messagesController = null;
    telegramSocialState.busy = false;
    telegramSocialElements.refresh.disabled = false;
    telegramSocialSchedule(manual ? 300 : TELEGRAM_SOCIAL_POLL_MS);
  }
}

async function telegramSocialSaveSelection() {
  if (telegramSocialState.selectionBusy) return;
  const selectedChatIds = telegramSocialState.chats
    .filter((chat) => telegramSocialState.draftChatIds.has(chat.id))
    .map((chat) => chat.id);
  const caBarkChatIds = telegramSocialState.chats
    .filter((chat) => telegramSocialState.draftCaBarkChatIds.has(chat.id)
      && telegramSocialState.draftChatIds.has(chat.id))
    .map((chat) => chat.id);
  const pinnedId = telegramSocialPinnedId();
  if (pinnedId === null) {
    telegramSocialState.error = `正在定位 ${TELEGRAM_SOCIAL_PINNED_NAME} 群组，请稍后重试`;
    telegramSocialRenderManager();
    void telegramSocialLoadChats({ force: true });
    return;
  }
  const chatIds = [pinnedId, ...selectedChatIds.filter((id) => id !== pinnedId)];

  const saveRevision = telegramSocialState.draftRevision;
  const previousSelected = new Set(telegramSocialState.selectedChatIds);
  const previousCaBark = new Set(telegramSocialState.caBarkChatIds);
  telegramSocialState.selectionEpoch += 1;
  telegramSocialState.selectionBusy = true;
  telegramSocialState.error = '';
  // Optimistically reflect the pending selection in status chips while the
  // backend reloads history.  Poll responses are ignored during this write.
  telegramSocialState.selectedChatIds = new Set(selectedChatIds);
  telegramSocialRenderManager();
  telegramSocialState.messagesController?.abort();
  telegramSocialState.catalogController?.abort();
  const controller = new AbortController();
  telegramSocialState.selectionController = controller;
  try {
    const payload = await telegramSocialFetchJson('/selection', {
      method: 'POST',
      body: { chat_ids: chatIds, ca_bark_chat_ids: caBarkChatIds },
      signal: controller.signal
    });
    telegramSocialSyncCatalog(payload, { ignoreSelection: true });
    const acknowledged = telegramSocialSelectedIds(payload) || new Set(selectedChatIds);
    telegramSocialState.selectedChatIds = acknowledged;
    telegramSocialState.caBarkChatIds = new Set(
      (Array.isArray(payload.social_ca_bark_chat_ids) ? payload.social_ca_bark_chat_ids : caBarkChatIds)
        .map(telegramSocialNumericId)
        .filter((id) => id !== null)
    );
    if (telegramSocialState.draftRevision === saveRevision) {
      telegramSocialState.draftChatIds = new Set(acknowledged);
      telegramSocialState.draftCaBarkChatIds = new Set(telegramSocialState.caBarkChatIds);
      telegramSocialState.draftDirty = false;
    }
    telegramSocialState.catalogCheckedAt = 0;
    telegramSocialState.version = '';
    telegramSocialPublish({ messages: [], ...payload });
    telegramSocialState.messagesController?.abort();
    telegramSocialSchedule(0);
  } catch (error) {
    if (error.name !== 'AbortError') {
      telegramSocialState.error = `保存失败：${error.message}`;
      if (telegramSocialState.draftRevision === saveRevision) {
        telegramSocialState.selectedChatIds = previousSelected;
        telegramSocialState.caBarkChatIds = previousCaBark;
      }
    }
  } finally {
    if (telegramSocialState.selectionController === controller) telegramSocialState.selectionController = null;
    // Invalidate any read that managed to start while the selection request
    // was being dispatched.  The next scheduled poll starts from this epoch.
    telegramSocialState.selectionEpoch += 1;
    telegramSocialState.selectionBusy = false;
    telegramSocialRenderManager();
  }
}

function telegramSocialStart() {
  if (telegramSocialState.active) return;
  telegramSocialState.active = true;
  void telegramSocialLoadChats({ force: true });
  void telegramSocialLoadMessages();
}

function telegramSocialStop() {
  telegramSocialState.active = false;
  clearTimeout(telegramSocialState.timer);
  telegramSocialState.timer = null;
  telegramSocialState.messagesController?.abort();
  telegramSocialState.catalogController?.abort();
  telegramSocialState.selectionController?.abort();
  telegramSocialState.messagesController = null;
  telegramSocialState.catalogController = null;
  telegramSocialState.selectionController = null;
  telegramSocialState.busy = false;
}

function telegramSocialSynchronizeLifecycle() {
  const visible = !telegramSocialElements.monitorPage.hidden && document.visibilityState !== 'hidden';
  if (visible) telegramSocialStart();
  else telegramSocialStop();
}

if (Object.values(telegramSocialElements).every(Boolean)) {
  telegramSocialElements.search.addEventListener('input', (event) => {
    telegramSocialState.searchQuery = event.target.value;
    telegramSocialRenderManager();
  });
  telegramSocialElements.selectAll.addEventListener('change', (event) => {
    for (const chat of telegramSocialVisibleChats()) {
      if (event.target.checked) telegramSocialState.draftChatIds.add(chat.id);
      else telegramSocialState.draftChatIds.delete(chat.id);
    }
    telegramSocialRecordDraftChange();
    telegramSocialRenderManager();
  });
  telegramSocialElements.save.addEventListener('click', () => void telegramSocialSaveSelection());
  telegramSocialElements.refresh.addEventListener('click', () => {
    telegramSocialState.catalogCheckedAt = 0;
    void telegramSocialLoadChats({ force: true });
    void telegramSocialLoadMessages({ manual: true });
  });
  telegramSocialElements.globalRefresh.addEventListener('click', () => void telegramSocialLoadMessages({ manual: true }));
  new MutationObserver(() => {
    if (!telegramSocialElements.socialManager.hidden) {
      if (!telegramSocialState.selectionBusy) {
        telegramSocialState.draftChatIds = new Set(telegramSocialState.selectedChatIds);
        telegramSocialState.draftDirty = false;
        telegramSocialState.draftRevision += 1;
      }
      telegramSocialRenderManager();
      void telegramSocialLoadChats();
    }
  }).observe(telegramSocialElements.socialManager, { attributes: true, attributeFilter: ['hidden'] });
  new MutationObserver(telegramSocialSynchronizeLifecycle).observe(telegramSocialElements.monitorPage, {
    attributes: true,
    attributeFilter: ['hidden']
  });
  document.addEventListener('visibilitychange', telegramSocialSynchronizeLifecycle);
  window.addEventListener('telegram-pinned-source', (event) => {
    const pinnedId = telegramSocialNumericId(event.detail?.id);
    if (pinnedId === null) return;
    telegramSocialState.pinnedChatId = pinnedId;
    telegramSocialState.selectedChatIds.delete(pinnedId);
    telegramSocialState.draftChatIds.delete(pinnedId);
    telegramSocialPublish({});
    telegramSocialRenderManager();
  });
  telegramSocialRenderManager();
  telegramSocialSynchronizeLifecycle();
}
