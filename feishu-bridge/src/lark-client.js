import { execFile } from 'node:child_process';
import { mkdir, stat } from 'node:fs/promises';
import { resolve } from 'node:path';
import { promisify } from 'node:util';

const execFileAsync = promisify(execFile);

export class LarkCliError extends Error {
  constructor(message, details = {}) {
    super(message);
    this.name = 'LarkCliError';
    this.details = details;
  }
}

export function createLarkClient(options = {}) {
  const command = options.command || process.env.LARK_CLI || 'lark-cli';
  const timeout = Number(options.timeout || 30_000);

  async function fetchChatPage(chatId, { pageSize = 50, pageToken = '' } = {}) {
    const args = [
      'im', '+chat-messages-list',
      '--as', 'user',
      '--chat-id', chatId,
      '--page-size', String(pageSize),
      '--sort', 'desc',
      '--format', 'json'
    ];
    if (pageToken) args.push('--page-token', pageToken);

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
      messages: Array.isArray(payload.data?.messages) ? payload.data.messages : [],
      hasMore: Boolean(payload.data?.has_more),
      pageToken: payload.data?.page_token || ''
    };
  }

  async function downloadMessageResource({ messageId, resourceKey, outputDirectory }) {
    if (!/^om_[A-Za-z0-9_-]+$/.test(messageId)) throw new TypeError('invalid message id');
    if (!/^img_[A-Za-z0-9_-]+$/.test(resourceKey)) throw new TypeError('invalid image resource key');
    await mkdir(outputDirectory, { recursive: true, mode: 0o700 });
    const outputName = `${messageId}-${resourceKey}`;
    const outputPath = resolve(outputDirectory, outputName);
    const cached = await stat(outputPath).catch(() => null);
    if (cached?.isFile() && cached.size > 0) return outputPath;
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
    return outputPath;
  }

  return { fetchChatPage, downloadMessageResource };
}
