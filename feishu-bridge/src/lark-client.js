import { execFile } from 'node:child_process';
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

  return { fetchChatPage };
}
