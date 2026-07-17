import { migrateLocalSettings } from './options-config.js';

const form = document.querySelector('#settings-form');
const serverBase = document.querySelector('#server-base');
const bridgeToken = document.querySelector('#bridge-token');
const status = document.querySelector('#status');

async function load() {
  const result = await chrome.runtime.sendMessage({ source: 'bridge-options', type: 'get-settings' });
  if (!result?.ok) throw new Error(result?.error || '无法读取设置');
  const settings = await migrateLocalSettings({
    current: result.payload,
    loadLocalConfig: async () => (await import('./config.local.js')).default,
    sendMessage: (message) => chrome.runtime.sendMessage(message)
  });
  serverBase.value = settings.serverBase || '';
  bridgeToken.placeholder = settings.bridgeToken ? '已配置，留空则保持不变' : '输入 VPS 设备配对密钥';
}

form.addEventListener('submit', (event) => {
  event.preventDefault();
  status.textContent = '正在保存...';
  const payload = { serverBase: serverBase.value.trim() };
  if (bridgeToken.value.trim()) payload.bridgeToken = bridgeToken.value.trim();
  chrome.runtime.sendMessage({ source: 'bridge-options', type: 'save-settings', payload }).then((result) => {
    if (!result?.ok) throw new Error(result?.error || '保存失败');
    bridgeToken.value = '';
    bridgeToken.placeholder = result.payload.bridgeToken ? '已配置，留空则保持不变' : '输入 VPS 设备配对密钥';
    status.textContent = '已保存';
  }).catch((error) => {
    status.textContent = error instanceof Error ? error.message : String(error);
  });
});

void load().catch((error) => {
  status.textContent = error instanceof Error ? error.message : String(error);
});
