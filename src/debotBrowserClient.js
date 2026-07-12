import { chromium } from 'playwright';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

import { loadDebotCookies } from './cookieStore.js';
import { transformSignalResponse } from './transform.js';

const DEFAULT_API_URL = 'https://debot.ai/api/community/signal/channel/list?chain=base&page_size=24';
const DEFAULT_HOME_URL = 'https://debot.ai/?chain=base';

function parseJsonBody(text) {
  try {
    return JSON.parse(text);
  } catch {
    throw new Error('Debot returned a non-JSON response. The browser session may need to pass Cloudflare again.');
  }
}

function isClosedBrowserError(error) {
  const message = error instanceof Error ? error.message : String(error);
  return /Target page, context or browser has been closed|browser has been closed|page has been closed/i.test(message);
}

export class DebotBrowserClient {
  constructor(options = {}) {
    this.apiUrl = options.apiUrl || DEFAULT_API_URL;
    this.homeUrl = options.homeUrl || DEFAULT_HOME_URL;
    this.limit = options.limit || 10;
    this.profileDir =
      options.profileDir || path.join(os.tmpdir(), 'debot-signal-monitor-chrome-profile');
    this.channel = options.channel ?? process.env.DEBOT_BROWSER_CHANNEL ?? (options.headless ? undefined : 'chrome');
    this.headless = options.headless ?? false;
    this.context = null;
    this.page = null;
    this.startPromise = null;
    this.fetchPromise = null;
    this.lastGood = null;
  }

  async start() {
    if (this.context && this.page && !this.page.isClosed()) {
      return;
    }
    if (this.startPromise) {
      return this.startPromise;
    }

    this.startPromise = (async () => {
      await this.close();
      fs.mkdirSync(this.profileDir, { recursive: true });
      const launchOptions = {
        headless: this.headless,
        viewport: { width: 1180, height: 860 },
        args: [
          '--disable-blink-features=AutomationControlled',
          '--window-size=1180,860',
          '--window-position=-1800,80'
        ]
      };
      if (this.channel) {
        launchOptions.channel = this.channel;
      }
      this.context = await chromium.launchPersistentContext(this.profileDir, launchOptions);
      await this.refreshCookies();
      this.page = this.context.pages()[0] || (await this.context.newPage());
      await this.warmUp();
    })();

    try {
      await this.startPromise;
    } finally {
      this.startPromise = null;
    }
  }

  async refreshCookies() {
    if (!this.context) {
      return;
    }
    await this.context.addCookies(loadDebotCookies());
  }

  async warmUp() {
    if (!this.page) {
      return;
    }
    await this.refreshCookies();
    await this.page.goto(this.homeUrl, { waitUntil: 'domcontentloaded', timeout: 30000 });
    await this.page.waitForTimeout(6000);
  }

  async fetchSignals(limit = this.limit) {
    if (this.fetchPromise) {
      return this.fetchPromise;
    }

    this.fetchPromise = this.fetchSignalsOnce(limit).finally(() => {
      this.fetchPromise = null;
    });

    return this.fetchPromise;
  }

  async fetchSignalsOnce(limit) {
    await this.start();

    let lastError;
    for (let attempt = 0; attempt < 3; attempt += 1) {
      try {
        await this.refreshCookies();
        const response = await this.page.goto(this.apiUrl, {
          waitUntil: 'domcontentloaded',
          timeout: 30000
        });
        const text = await this.page.locator('body').textContent({ timeout: 5000 });
        if (!response?.ok()) {
          throw new Error(`Debot API returned HTTP ${response?.status() || 'unknown'}`);
        }

        const payload = parseJsonBody(text || '{}');
        if (payload.code !== 0) {
          throw new Error(payload.description || 'Debot API returned an unsuccessful response.');
        }

        const rows = transformSignalResponse(payload, { limit });
        const result = {
          ok: true,
          rows,
          updatedAt: new Date().toISOString(),
          sourceUrl: this.apiUrl,
          stale: false
        };
        this.lastGood = result;
        return result;
      } catch (error) {
        lastError = error;
        if (isClosedBrowserError(error)) {
          await this.close();
          await this.start();
          continue;
        }
        await this.warmUp();
      }
    }

    if (this.lastGood) {
      return {
        ...this.lastGood,
        ok: false,
        stale: true,
        error: lastError instanceof Error ? lastError.message : String(lastError)
      };
    }

    throw lastError;
  }

  async close() {
    await this.context?.close();
    this.context = null;
    this.page = null;
  }
}
