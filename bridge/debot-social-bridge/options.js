import { migrateLocalSettings } from './options-config.js';
import {
  hostPermissionForServerBase,
  normalizeServerBase,
  serverOriginForBase
} from './server-config.js';

const form = document.querySelector('#settings-form');
const serverBase = document.querySelector('#server-base');
const bridgeToken = document.querySelector('#bridge-token');
const status = document.querySelector('#status');
let pendingLocalSettings = null;

async function hasHostPermission(value) {
  try {
    return await chrome.permissions.contains({
      origins: [hostPermissionForServerBase(value)]
    });
  } catch {
    return false;
  }
}

async function load() {
  const result = await chrome.runtime.sendMessage({ source: 'bridge-options', type: 'get-settings' });
  if (!result?.ok) throw new Error(result?.error || '无法读取设置');
  const settings = await migrateLocalSettings({
    current: result.payload,
    loadLocalConfig: async () => (await import('./config.local.js')).default,
    sendMessage: (message) => chrome.runtime.sendMessage(message),
    canMigrate: hasHostPermission,
    onPermissionRequired(value) {
      pendingLocalSettings = value;
    }
  });
  serverBase.value = settings.serverBase || '';
  bridgeToken.placeholder = settings.bridgeToken ? '已配置，留空则保持不变' : '输入 VPS 设备配对密钥';
  if (pendingLocalSettings) {
    status.textContent = '已读取旧版 config.local.js；点击保存并授权该站点即可完成迁移。';
  } else if (settings.serverBase && !settings.hostPermissionGranted) {
    status.textContent = '需要点击保存，授权扩展访问这个 Radar 站点。';
  }
}

form.addEventListener('submit', async (event) => {
  event.preventDefault();
  try {
    const normalizedServerBase = normalizeServerBase(serverBase.value);
    const permissionOrigin = hostPermissionForServerBase(normalizedServerBase);
    status.textContent = '正在请求站点访问权限...';
    const granted = await chrome.permissions.request({ origins: [permissionOrigin] });
    if (!granted) throw new Error('未授予该 Radar 站点的访问权限，设置没有保存');

    status.textContent = '正在保存...';
    const payload = { serverBase: normalizedServerBase };
    const enteredToken = bridgeToken.value.trim();
    const pendingTokenMatches = !enteredToken
      && pendingLocalSettings?.bridgeToken
      && serverOriginForBase(pendingLocalSettings.serverBase) === serverOriginForBase(normalizedServerBase);
    if (enteredToken) payload.bridgeToken = enteredToken;
    else if (pendingTokenMatches) payload.bridgeToken = pendingLocalSettings.bridgeToken;
    const result = await chrome.runtime.sendMessage({
      source: 'bridge-options',
      type: 'save-settings',
      payload
    });
    if (!result?.ok) throw new Error(result?.error || '保存失败');
    pendingLocalSettings = null;
    serverBase.value = result.payload.serverBase || normalizedServerBase;
    bridgeToken.value = '';
    bridgeToken.placeholder = result.payload.bridgeToken ? '已配置，留空则保持不变' : '输入 VPS 设备配对密钥';
    status.textContent = '已保存。请刷新已打开的 Radar 页面。';
  } catch (error) {
    status.textContent = error instanceof Error ? error.message : String(error);
  }
});

void load().catch((error) => {
  status.textContent = error instanceof Error ? error.message : String(error);
});
