import { execFile } from 'node:child_process';
import { mkdir, readdir, stat } from 'node:fs/promises';
import { basename, resolve, sep } from 'node:path';
import { promisify } from 'node:util';

const execFileAsync = promisify(execFile);

export class LarkCliError extends Error {
  constructor(message, details = {}) {
    super(message);
    this.name = 'LarkCliError';
    this.details = details;
  }
}

function contentText(value) {
  if (Array.isArray(value)) return value.map(contentText).filter(Boolean).join('');
  if (!value || typeof value !== 'object') return String(value || '');
  if (value.tag === 'img' && value.image_key) return `[Image: ${value.image_key}]`;
  if (value.tag === 'at') return `@${value.user_name || value.user_id || ''}`;
  if (value.tag === 'text' || value.tag === 'a') return String(value.text || value.href || '');
  return contentText(value.text || value.content || value.content_v2 || '');
}

export function normalizeRawMessage(message) {
  let body = message.body?.content ?? message.content ?? '';
  if (typeof body === 'string') {
    try { body = JSON.parse(body); } catch { /* keep plain text */ }
  }
  const content = contentText(body);
  const timestamp = Number(message.create_time);
  const createdAt = Number.isFinite(timestamp) && timestamp > 0
    ? new Date(timestamp).toISOString()
    : String(message.create_time || '');
  return {
    ...message,
    content,
    create_time: createdAt,
    message_app_link: message.message_app_link || (message.chat_id && message.message_position
      ? `https://applink.feishu.cn/client/chat/open?openChatId=${encodeURIComponent(message.chat_id)}&position=${encodeURIComponent(message.message_position)}`
      : '')
  };
}

export function createLarkClient(options = {}) {
  const command = options.command || process.env.LARK_CLI || 'lark-cli';
  const timeout = Number(options.timeout || 30_000);

  async function fetchChatPage(chatId, { pageSize = 50, pageToken = '' } = {}) {
    const params = {
      container_id_type: 'chat',
      container_id: chatId,
      page_size: String(pageSize),
      sort_type: 'ByCreateTimeDesc'
    };
    if (pageToken) params.page_token = pageToken;
    const args = [
      'api', 'GET', '/open-apis/im/v1/messages',
      '--as', 'user',
      '--params', JSON.stringify(params),
      '--format', 'json'
    ];

    let stdout;
    try {
      ({ stdout } = await execFileAsync(command, args, {
        timeout,
        maxBuffer: 12 * 1024 * 1024,
        encoding: 'utf8'
      }));
    } catch (error) {
      throw new LarkCliError(error.stderr?.trim() || error.message, {
        code: error.code,
        chatId
      });
    }

    let payload;
    try {
      payload = JSON.parse(stdout);
    } catch {
      throw new LarkCliError('lark-cli returned invalid JSON', { chatId });
    }
    if (!payload.ok) {
      throw new LarkCliError(payload.error?.message || 'lark-cli request failed', {
        chatId,
        type: payload.error?.type,
        hint: payload.error?.hint
      });
    }

    return {
      messages: (Array.isArray(payload.data?.items) ? payload.data.items : []).map(normalizeRawMessage),
      hasMore: Boolean(payload.data?.has_more),
      pageToken: payload.data?.page_token || ''
    };
  }

  async function downloadMessageResource({ messageId, resourceKey, outputDirectory }) {
    if (!/^om_[A-Za-z0-9_-]+$/.test(messageId)) throw new TypeError('invalid message id');
    if (!/^img_[A-Za-z0-9_-]+$/.test(resourceKey)) throw new TypeError('invalid image resource key');
    await mkdir(outputDirectory, { recursive: true, mode: 0o700 });
    const outputName = `${messageId}-${resourceKey}`;
    const outputRoot = resolve(outputDirectory);
    const cachedNames = await readdir(outputRoot).catch(() => []);
    for (const name of cachedNames) {
      if (name !== outputName && !name.startsWith(`${outputName}.`)) continue;
      const cachedPath = resolve(outputRoot, name);
      const cached = await stat(cachedPath).catch(() => null);
      if (cached?.isFile() && cached.size > 0) return cachedPath;
    }
    let stdout;
    try {
      ({ stdout } = await execFileAsync(command, [
        'im', '+messages-resources-download',
        '--as', 'user',
        '--message-id', messageId,
        '--file-key', resourceKey,
        '--type', 'image',
        '--output', outputName,
        '--format', 'json'
      ], {
        cwd: outputDirectory,
        timeout,
        maxBuffer: 2 * 1024 * 1024,
        encoding: 'utf8'
      }));
    } catch (error) {
      throw new LarkCliError(error.stderr?.trim() || error.message, { code: error.code, messageId, resourceKey });
    }
    let payload;
    try {
      payload = JSON.parse(stdout);
    } catch {
      throw new LarkCliError('lark-cli returned invalid resource JSON', { messageId, resourceKey });
    }
    if (!payload.ok) throw new LarkCliError(payload.error?.message || 'lark-cli resource download failed', { messageId, resourceKey });
    const savedPath = resolve(String(payload.data?.saved_path || ''));
    const savedName = basename(savedPath);
    if (!savedPath.startsWith(`${outputRoot}${sep}`) || (savedName !== outputName && !savedName.startsWith(`${outputName}.`))) {
      throw new LarkCliError('lark-cli returned an unsafe resource path', { messageId, resourceKey });
    }
    const saved = await stat(savedPath).catch(() => null);
    if (!saved?.isFile() || saved.size <= 0) {
      throw new LarkCliError('lark-cli resource file is missing', { messageId, resourceKey });
    }
    return savedPath;
  }

  return { fetchChatPage, downloadMessageResource };
}
