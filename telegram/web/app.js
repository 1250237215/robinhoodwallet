(function () {
  "use strict";

  const list = document.getElementById("message-list");
  const emptyState = document.getElementById("empty-state");
  const errorState = document.getElementById("error-state");
  const sourceName = document.getElementById("source-name");
  const sourceKind = document.getElementById("source-kind");
  const sourceAvatar = document.getElementById("source-avatar");
  const readOnlyAvatar = document.querySelector(".read-only-avatar");
  const messageCount = document.getElementById("message-count");
  const lastUpdated = document.getElementById("last-updated");
  const connectionState = document.getElementById("connection-state");
  const syncStrip = document.querySelector(".sync-strip");
  const refreshButton = document.getElementById("refresh-button");

  let firstRender = true;
  let lastMessageId = null;
  let lastRenderedVersion = null;
  let renderedMessages = [];

  function formatDate(value) {
    if (!value) return "时间未知";
    const date = new Date(value);
    if (Number.isNaN(date.getTime())) return value;
    return date.toLocaleString("zh-CN", {
      year: "numeric",
      month: "2-digit",
      day: "2-digit",
      hour: "2-digit",
      minute: "2-digit",
      second: "2-digit",
      hour12: false,
    });
  }

  function formatTime(value) {
    if (!value) return "等待同步";
    const date = new Date(value);
    if (Number.isNaN(date.getTime())) return value;
    return date.toLocaleTimeString("zh-CN", {
      hour: "2-digit",
      minute: "2-digit",
      second: "2-digit",
      hour12: false,
    });
  }

  function formatSize(size) {
    if (!size) return "";
    if (size < 1024) return `${size} B`;
    if (size < 1024 * 1024) return `${(size / 1024).toFixed(1)} KB`;
    return `${(size / (1024 * 1024)).toFixed(1)} MB`;
  }

  function makeTag(label, className) {
    const tag = document.createElement("span");
    tag.className = `message-tag${className ? ` ${className}` : ""}`;
    tag.textContent = label;
    return tag;
  }

  function normalizeId(value) {
    if (value === null || value === undefined || value === "") return "";
    return String(value);
  }

  function isChineseMajoritySocialText(value) {
    const meaningful = String(value || "")
      .replace(/https?:\/\/\S+/giu, " ")
      .replace(/\b0x[a-f0-9]{40}\b/giu, " ")
      .replace(/\b[1-9A-HJ-NP-Za-km-z]{32,44}\b/gu, " ")
      .replace(/[@#$][\p{L}\p{N}_-]+/gu, " ");
    const letters = meaningful.match(/\p{L}/gu) || [];
    if (!letters.length) return false;
    const hanCount = letters.reduce(
      (count, character) => count + (/\p{Script=Han}/u.test(character) ? 1 : 0),
      0,
    );
    return hanCount * 2 >= letters.length;
  }

  function translationForDisplay(source, translated) {
    const original = String(source || "").trim();
    const translation = String(translated || "").trim();
    if (
      !translation ||
      translation === original ||
      isChineseMajoritySocialText(original)
    ) {
      return "";
    }
    return translation;
  }

  function payloadVersion(payload) {
    const messages = Array.isArray(payload.messages) ? payload.messages : [];
    const firstId = messages.length ? normalizeId(messages[0].id) : "";
    const finalId = messages.length
      ? normalizeId(messages[messages.length - 1].id)
      : "";
    return [
      payload.updated_at || "",
      payload.count ?? messages.length,
      firstId,
      finalId,
    ].join(":");
  }

  function mediaPreviewMode(media) {
    if (!media || !media.preview_url) return null;
    const declaredType = String(media.preview_type || "").toLowerCase();
    const previewUrl = String(media.preview_url).split("?", 1)[0].toLowerCase();
    if (
      declaredType.includes("video") ||
      declaredType.includes("webm") ||
      declaredType.includes("mp4") ||
      /\.(?:webm|mp4|mov|m4v)$/.test(previewUrl)
    ) {
      return "video";
    }
    return "image";
  }

  function createMediaPreview(media, compact) {
    const mode = mediaPreviewMode(media);
    if (!mode) return null;

    const isSticker = String(media.kind || "").includes("贴纸") || media.sticker;
    const isPhoto = String(media.kind || "").includes("图片");
    const preview = document.createElement("div");
    preview.className = [
      "media-preview",
      isSticker ? "sticker-preview" : "",
      isPhoto ? "photo-preview" : "",
      compact ? "compact-preview" : "",
    ].filter(Boolean).join(" ");
    preview.setAttribute("aria-label", media.kind || "媒体预览");

    const mediaWidth = Number(media.width);
    const mediaHeight = Number(media.height);
    if (mediaWidth > 0 && mediaHeight > 0) {
      preview.style.setProperty("--media-aspect", `${mediaWidth} / ${mediaHeight}`);
    }

    const source = String(media.preview_url);
    if (mode === "video") {
      const video = document.createElement("video");
      video.autoplay = true;
      video.loop = true;
      video.muted = true;
      video.playsInline = true;
      video.preload = "metadata";
      video.setAttribute("aria-label", media.kind || "视频预览");
      video.src = source;
      preview.appendChild(video);
    } else {
      const image = document.createElement("img");
      image.loading = compact ? "eager" : "lazy";
      image.decoding = "async";
      image.alt = media.kind || "媒体预览";
      if (mediaWidth > 0 && mediaHeight > 0) {
        image.width = mediaWidth;
        image.height = mediaHeight;
      }
      image.src = source;
      preview.appendChild(image);
    }

    // A missing local preview should not leave a broken media frame in a bubble.
    preview.addEventListener("error", () => preview.remove(), true);
    return preview;
  }

  function isGeneratedMediaPlaceholder(text, media) {
    if (!media || !text) return false;
    return /^\[(?:媒体|图片|视频|语音|音频|贴纸|文件|投票|联系人|位置|无文字内容)\]$/.test(
      String(text).trim(),
    );
  }

  function getReplyPreview(message) {
    const rawPreview = message.reply_preview || message.replyPreview;
    const preview = rawPreview && typeof rawPreview === "object"
      ? rawPreview
      : {};
    const id = normalizeId(
      preview.id ?? preview.message_id ?? preview.messageId ?? message.reply_to,
    );
    if (!id) return null;

    const media = preview.media && typeof preview.media === "object"
      ? preview.media
      : null;
    let text = preview.text || preview.raw_text || preview.caption || "";
    if (!text && media && media.kind) text = `[${media.kind}]`;
    if (!text) text = "原消息";

    return {
      id,
      available: preview.available !== false,
      sender: preview.sender || preview.author || "原消息",
      avatar: preview.avatar || null,
      text: String(text),
      translatedText: String(preview.translated_text || preview.translatedText || ""),
      media,
    };
  }

  function focusMessage(messageId) {
    const normalizedId = normalizeId(messageId);
    if (!normalizedId) return false;
    const target = Array.from(list.querySelectorAll(".message-row")).find(
      (row) => normalizeId(row.dataset.messageId) === normalizedId,
    );
    if (!target) return false;

    target.scrollIntoView({ behavior: "smooth", block: "center" });
    target.classList.remove("target-message");
    // Force a fresh animation when the same reply is opened repeatedly.
    void target.offsetWidth;
    target.classList.add("target-message");
    window.setTimeout(() => target.classList.remove("target-message"), 1400);
    return true;
  }

  function createReplyPreview(message, availableMessageIds) {
    const reply = getReplyPreview(message);
    if (!reply) return null;

    const locatable = reply.available && availableMessageIds.has(reply.id);
    const preview = document.createElement("div");
    preview.className = `reply-preview${locatable ? "" : " unavailable"}`;
    preview.title = locatable
      ? "点击查看原消息"
      : (reply.available ? "原消息不在当前缓存中" : "原消息不可用");
    if (locatable) {
      preview.setAttribute("role", "button");
      preview.tabIndex = 0;
      const activate = () => focusMessage(reply.id);
      preview.addEventListener("click", activate);
      preview.addEventListener("keydown", (event) => {
        if (event.key === "Enter" || event.key === " ") {
          event.preventDefault();
          activate();
        }
      });
    }

    const bar = document.createElement("span");
    bar.className = "reply-preview-bar";
    bar.setAttribute("aria-hidden", "true");
    preview.appendChild(bar);

    const avatar = document.createElement("span");
    avatar.className = "avatar reply-preview-avatar";
    renderAvatar(avatar, reply.avatar, reply.sender);
    preview.appendChild(avatar);

    const copy = document.createElement("span");
    copy.className = "reply-preview-copy";
    const sender = document.createElement("strong");
    sender.className = "reply-preview-sender";
    sender.textContent = reply.sender;
    copy.appendChild(sender);

    const text = document.createElement("span");
    text.className = "reply-preview-text";
    text.textContent = reply.text;
    copy.appendChild(text);

    const translatedText = translationForDisplay(reply.text, reply.translatedText);
    if (translatedText) {
      const translated = document.createElement("span");
      translated.className = "reply-preview-translation";
      translated.textContent = `中文：${translatedText}`;
      copy.appendChild(translated);
    }

    const mediaPreview = createMediaPreview(reply.media, true);
    if (mediaPreview) copy.appendChild(mediaPreview);
    preview.appendChild(copy);
    return preview;
  }

  function renderAvatar(container, avatar, label) {
    const avatarKey = [
      avatar && avatar.url,
      avatar && avatar.initials,
      avatar && avatar.color,
      label,
    ].join("|");
    if (container.dataset.avatarKey === avatarKey && container.childNodes.length) {
      return;
    }
    container.dataset.avatarKey = avatarKey;
    container.replaceChildren();
    container.style.background = (avatar && avatar.color) || "#84a8bd";
    container.textContent =
      (avatar && avatar.initials) ||
      (label || "TG").replace(/^@/, "").slice(0, 2).toUpperCase();

    if (!avatar || !avatar.url) return;

    const image = document.createElement("img");
    image.alt = `${label || "聊天"}头像`;
    image.addEventListener("load", () => {
      container.replaceChildren(image);
    }, { once: true });
    image.addEventListener("error", () => {
      image.remove();
    }, { once: true });
    image.src = avatar.url;
  }

  function dayKey(value) {
    if (!value) return "unknown";
    const date = new Date(value);
    if (Number.isNaN(date.getTime())) return value.slice(0, 10);
    return date.toLocaleDateString("zh-CN", {
      year: "numeric",
      month: "long",
      day: "numeric",
    });
  }

  function updateHeader(payload, messages) {
    const source = payload.source || {};
    sourceName.textContent = source.name || "未命名聊天";
    sourceKind.textContent = source.kind || "实时消息";
    messageCount.textContent = `${String(payload.count || messages.length).padStart(3, "0")} 条消息`;
    lastUpdated.textContent = payload.updated_at
      ? `同步于 ${formatTime(payload.updated_at)}`
      : "等待同步";
    renderAvatar(sourceAvatar, source.avatar, source.name);
    renderAvatar(readOnlyAvatar, source.avatar, source.name);
  }

  function senderKey(message) {
    return `${message.sender_id || ""}:${message.sender || ""}`;
  }

  function createDateSeparator(label) {
    const separator = document.createElement("li");
    separator.className = "date-separator";
    separator.dataset.dayKey = label;
    const separatorLabel = document.createElement("span");
    separatorLabel.textContent = label;
    separator.appendChild(separatorLabel);
    return separator;
  }

  function createMessageRow(message, sameSender, isNew, availableMessageIds) {
    const row = document.createElement("li");
    row.className = `message-row ${message.outgoing ? "outgoing" : "incoming"}`;
    row.dataset.messageId = normalizeId(message.id);
    row.dataset.dayKey = dayKey(message.date);
    if (isNew) row.classList.add("new-message");

    if (!message.outgoing) {
      const avatarColumn = document.createElement("div");
      avatarColumn.className = "avatar-column";
      if (sameSender) {
        const spacer = document.createElement("div");
        spacer.className = "avatar-spacer";
        avatarColumn.appendChild(spacer);
      } else {
        const avatar = document.createElement("div");
        avatar.className = "avatar";
        renderAvatar(avatar, message.avatar, message.sender);
        avatarColumn.appendChild(avatar);
      }
      row.appendChild(avatarColumn);
    }

    const bubble = document.createElement("article");
    bubble.className = "message-bubble";

    if (!message.outgoing && !sameSender) {
      const sender = document.createElement("p");
      sender.className = "message-sender";
      sender.textContent = message.sender || "未知发送者";
      bubble.appendChild(sender);
    }

    const replyPreview = createReplyPreview(message, availableMessageIds);
    if (replyPreview) bubble.appendChild(replyPreview);

    const mediaPreview = createMediaPreview(message.media, false);
    if (mediaPreview) bubble.appendChild(mediaPreview);

    const messageText = message.text || "[无文字内容]";
    const generatedMediaPlaceholder = isGeneratedMediaPlaceholder(
      messageText,
      message.media,
    );
    const mediaKind = String(message.media && message.media.kind || "");
    const stickerOnly = Boolean(
      mediaPreview &&
      !replyPreview &&
      mediaKind.includes("贴纸") &&
      generatedMediaPlaceholder
    );
    const photoOnly = Boolean(
      mediaPreview &&
      !replyPreview &&
      mediaKind.includes("图片") &&
      generatedMediaPlaceholder
    );
    if (stickerOnly) bubble.classList.add("sticker-only");
    if (photoOnly) bubble.classList.add("photo-only");

    if (!mediaPreview || !generatedMediaPlaceholder) {
      const text = document.createElement("p");
      text.className = "message-text";
      text.textContent = messageText;
      bubble.appendChild(text);
    }

    const translatedText = translationForDisplay(
      messageText,
      message.translated_text || message.translatedText,
    );
    if (translatedText) {
      const translation = document.createElement("div");
      translation.className = "message-translation";
      const label = document.createElement("b");
      label.textContent = "中文翻译";
      const copy = document.createElement("p");
      copy.textContent = translatedText;
      translation.append(label, copy);
      bubble.appendChild(translation);
    }

    const tags = document.createElement("div");
    if (message.media && !mediaPreview) {
      const mediaLabel = message.media.name
        ? `${message.media.kind} · ${message.media.name}`
        : message.media.kind;
      const sizeLabel = formatSize(message.media.size);
      tags.appendChild(makeTag(
        sizeLabel ? `${mediaLabel} · ${sizeLabel}` : mediaLabel,
        "media",
      ));
    }
    if (message.forwarded) tags.appendChild(makeTag("转发消息", "forwarded"));
    if (message.reply_to && !replyPreview) {
      tags.appendChild(makeTag(`回复 #${message.reply_to}`));
    }
    if (message.views) tags.appendChild(makeTag(`${message.views} 次查看`));
    if (tags.children.length) bubble.appendChild(tags);

    const meta = document.createElement("time");
    meta.className = "message-meta";
    meta.dateTime = message.date || "";
    meta.textContent = formatTime(message.date);
    bubble.appendChild(meta);

    row.appendChild(bubble);
    return row;
  }

  function fullRenderMessages(messages, previousLastId) {
    const availableMessageIds = new Set(
      messages.map((message) => normalizeId(message.id)).filter(Boolean),
    );
    const fragment = document.createDocumentFragment();
    let previousSender = null;
    let renderedDay = null;

    messages.forEach((message) => {
      const messageDay = dayKey(message.date);
      if (messageDay !== renderedDay) {
        fragment.appendChild(createDateSeparator(messageDay));
        renderedDay = messageDay;
        previousSender = null;
      }
      const currentSender = senderKey(message);
      const sameSender = !message.outgoing && currentSender === previousSender;
      const isNew = Boolean(
        !firstRender &&
        previousLastId !== message.id &&
        message.id === lastMessageId
      );
      fragment.appendChild(
        createMessageRow(message, sameSender, isNew, availableMessageIds),
      );
      previousSender = currentSender;
    });

    list.replaceChildren(fragment);
  }

  function removeEmptyDateSeparators() {
    Array.from(list.querySelectorAll(".date-separator")).forEach((separator) => {
      const next = separator.nextElementSibling;
      if (!next || next.classList.contains("date-separator")) separator.remove();
    });
  }

  function incrementallyRenderMessages(messages) {
    if (!renderedMessages.length || !messages.length) return false;

    const currentIds = renderedMessages.map((message) => normalizeId(message.id));
    const nextIds = messages.map((message) => normalizeId(message.id));
    const retainedStart = currentIds.indexOf(nextIds[0]);
    if (retainedStart < 0) return false;

    let overlap = 0;
    while (
      retainedStart + overlap < currentIds.length &&
      overlap < nextIds.length &&
      currentIds[retainedStart + overlap] === nextIds[overlap]
    ) {
      overlap += 1;
    }
    if (overlap !== currentIds.length - retainedStart) return false;

    const visibleAnchor = Array.from(list.querySelectorAll(".message-row")).find(
      (row) => row.getBoundingClientRect().bottom > 90,
    );
    const anchorTop = visibleAnchor ? visibleAnchor.getBoundingClientRect().top : null;

    currentIds.slice(0, retainedStart).forEach((messageId) => {
      const row = list.querySelector(`[data-message-id="${messageId}"]`);
      if (row) row.remove();
    });
    removeEmptyDateSeparators();

    const availableMessageIds = new Set(nextIds.filter(Boolean));
    const firstRetainedRow = list.querySelector(".message-row");
    if (firstRetainedRow && firstRetainedRow.querySelector(".avatar-spacer")) {
      firstRetainedRow.replaceWith(
        createMessageRow(messages[0], false, false, availableMessageIds),
      );
    }

    let previousMessage = overlap ? messages[overlap - 1] : null;
    let previousSender = previousMessage ? senderKey(previousMessage) : null;
    let renderedDay = previousMessage ? dayKey(previousMessage.date) : null;
    for (let index = overlap; index < messages.length; index += 1) {
      const message = messages[index];
      const messageDay = dayKey(message.date);
      if (messageDay !== renderedDay) {
        list.appendChild(createDateSeparator(messageDay));
        renderedDay = messageDay;
        previousSender = null;
      }
      const currentSender = senderKey(message);
      const sameSender = !message.outgoing && currentSender === previousSender;
      list.appendChild(
        createMessageRow(message, sameSender, true, availableMessageIds),
      );
      previousSender = currentSender;
    }

    if (visibleAnchor && anchorTop !== null && document.body.contains(visibleAnchor)) {
      const offset = visibleAnchor.getBoundingClientRect().top - anchorTop;
      if (Math.abs(offset) > 0.5) window.scrollBy(0, offset);
    }
    return true;
  }

  function renderMessages(payload) {
    const messages = Array.isArray(payload.messages) ? payload.messages : [];
    const previousLastId = lastMessageId;
    lastMessageId = messages.length ? messages[messages.length - 1].id : null;
    updateHeader(payload, messages);
    emptyState.hidden = messages.length !== 0;

    if (firstRender || !incrementallyRenderMessages(messages)) {
      fullRenderMessages(messages, previousLastId);
    }

    renderedMessages = messages.slice();
    firstRender = false;
  }

  function setOnline() {
    connectionState.textContent = "实时连接";
    syncStrip.className = "sync-strip online";
  }

  function setError(error) {
    connectionState.textContent = "连接异常";
    syncStrip.className = "sync-strip error";
    errorState.hidden = false;
    errorState.textContent = `无法读取消息：${error.message || error}`;
  }

  async function refresh() {
    try {
      const response = await fetch("/api/messages?limit=1000", {
        cache: "no-store",
      });
      if (!response.ok) throw new Error(`HTTP ${response.status}`);
      const payload = await response.json();
      errorState.hidden = true;
      setOnline();
      const version = payloadVersion(payload);
      if (firstRender || version !== lastRenderedVersion) {
        renderMessages(payload);
        lastRenderedVersion = version;
      }
    } catch (error) {
      setError(error);
    }
  }

  refreshButton.addEventListener("click", refresh);
  refresh();
  window.setInterval(refresh, 2000);
})();
