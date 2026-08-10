import { EventEmitter } from 'node:events';

import {
  BOOTSTRAP_PAGE_LIMIT,
  CHATS,
  DEFAULT_POLL_MS,
  MAX_MESSAGES_PER_PERSON,
  PEOPLE
} from './config.js';

const IMAGE_RESOURCE_PATTERN = /(?:!\[Image\]\(|\[Image:\s*)(img_[A-Za-z0-9_-]+)\)?\]?/gi;

export function extractImageResources(content) {
  const resources = [];
  const seen = new Set();
  for (const match of String(content || '').matchAll(IMAGE_RESOURCE_PATTERN)) {
    const resourceKey = match[1];
    if (seen.has(resourceKey)) continue;
    seen.add(resourceKey);
    resources.push({ type: 'image', resourceKey });
  }
  return resources;
}

function cleanMediaMarkers(content) {
  return String(content || '')
    .replace(IMAGE_RESOURCE_PATTERN, '')
    .replace(/\n{3,}/g, '\n\n')
    .trim();
}

function normalizeMessage(person, message) {
  const rawContent = person.clean(message.content).trim();
  const media = extractImageResources(rawContent);
  const content = cleanMediaMarkers(rawContent);
  return {
    id: message.message_id || `${person.id}:${message.message_position || message.create_time}:${content}`,
    personId: person.id,
    personName: person.name,
    source: person.source,
    content,
    type: message.msg_type || 'text',
    media,
    createdAt: message.create_time || '',
    position: message.message_position || '',
    url: message.message_app_link || ''
  };
}

export function extractMessages(people, messages) {
  const extracted = new Map(people.map((person) => [person.id, []]));
  for (const message of messages) {
    for (const person of people) {
      if (!person.matches(message)) continue;
      extracted.get(person.id).push(normalizeMessage(person, message));
    }
  }
  return extracted;
}

export function mergeMessages(current, incoming, limit = MAX_MESSAGES_PER_PERSON) {
  const byId = new Map();
  for (const message of [...current, ...incoming]) byId.set(message.id, message);
  return [...byId.values()]
    .sort((a, b) => b.createdAt.localeCompare(a.createdAt) || b.position.localeCompare(a.position))
    .slice(0, limit);
}

export class PeopleMonitor extends EventEmitter {
  constructor(options = {}) {
    super();
    if (!options.client) throw new TypeError('client is required');
    this.client = options.client;
    this.people = options.people || PEOPLE;
    this.chats = options.chats || CHATS;
    this.pollMs = Number(options.pollMs || DEFAULT_POLL_MS);
    this.pageLimit = Number(options.pageLimit || BOOTSTRAP_PAGE_LIMIT);
    this.limit = Number(options.limit || MAX_MESSAGES_PER_PERSON);
    this.messages = new Map(this.people.map((person) => [person.id, []]));
    this.status = 'starting';
    this.lastSyncAt = null;
    this.error = null;
    this.refreshing = false;
    this.timer = null;
  }

  snapshot() {
    const people = this.people.map((person) => ({
      id: person.id,
      name: person.name,
      shortName: person.shortName,
      source: person.source,
      accent: person.accent,
      messages: this.messages.get(person.id) || []
    }));
    return {
      status: this.status,
      pollMs: this.pollMs,
      lastSyncAt: this.lastSyncAt,
      error: this.error,
      people,
      totalMessages: people.reduce((total, person) => total + person.messages.length, 0)
    };
  }

  apply(chatId, rawMessages) {
    const people = this.people.filter((person) => person.chatId === chatId);
    const extracted = extractMessages(people, rawMessages);
    for (const person of people) {
      const current = this.messages.get(person.id) || [];
      this.messages.set(person.id, mergeMessages(current, extracted.get(person.id) || [], this.limit));
    }
  }

  findMediaResource(messageId, resourceKey) {
    for (const messages of this.messages.values()) {
      const message = messages.find((candidate) => candidate.id === messageId);
      const media = message?.media?.find((candidate) => candidate.resourceKey === resourceKey);
      if (media) return { messageId, ...media };
    }
    return null;
  }

  async bootstrapChat(chat) {
    const targetPeople = this.people.filter((person) => person.chatId === chat.id);
    let pageToken = '';
    for (let page = 0; page < this.pageLimit; page += 1) {
      const result = await this.client.fetchChatPage(chat.id, { pageSize: 50, pageToken });
      this.apply(chat.id, result.messages);
      const complete = targetPeople.every((person) => (this.messages.get(person.id)?.length || 0) >= this.limit);
      if (complete || !result.hasMore || !result.pageToken) break;
      pageToken = result.pageToken;
    }
  }

  async start() {
    try {
      await Promise.all(this.chats.map((chat) => this.bootstrapChat(chat)));
      this.status = 'live';
      this.error = null;
      this.lastSyncAt = new Date().toISOString();
    } catch (error) {
      this.status = 'degraded';
      this.error = error.message;
    }
    this.emit('snapshot', this.snapshot());
    this.timer = setInterval(() => this.refresh().catch(() => {}), this.pollMs);
    this.timer.unref?.();
    return this.snapshot();
  }

  async refresh() {
    if (this.refreshing) return this.snapshot();
    this.refreshing = true;
    try {
      const pages = await Promise.all(this.chats.map(async (chat) => ({
        chat,
        page: await this.client.fetchChatPage(chat.id, { pageSize: 50 })
      })));
      for (const { chat, page } of pages) this.apply(chat.id, page.messages);
      this.status = 'live';
      this.error = null;
      this.lastSyncAt = new Date().toISOString();
    } catch (error) {
      this.status = 'degraded';
      this.error = error.message;
    } finally {
      this.refreshing = false;
    }
    const snapshot = this.snapshot();
    this.emit('snapshot', snapshot);
    return snapshot;
  }

  stop() {
    if (this.timer) clearInterval(this.timer);
    this.timer = null;
  }
}
