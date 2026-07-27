export async function migrateLocalSettings({
  current,
  loadLocalConfig,
  sendMessage,
  canMigrate = async () => true,
  onPermissionRequired = () => {}
}) {
  if (current?.bridgeToken) return current;

  let localConfig;
  try {
    localConfig = await loadLocalConfig();
  } catch {
    return current;
  }

  const bridgeToken = String(localConfig?.bridgeToken || '').trim();
  if (!bridgeToken) return current;

  const serverBase = String(localConfig?.serverBase || '').trim();
  if (!(await canMigrate(serverBase))) {
    onPermissionRequired({ serverBase, bridgeToken });
    return { ...current, ...(serverBase ? { serverBase } : {}) };
  }
  const result = await sendMessage({
    source: 'bridge-options',
    type: 'migrate-local-settings',
    payload: {
      ...(serverBase ? { serverBase } : {}),
      bridgeToken
    }
  });
  if (!result?.ok) throw new Error(result?.error || '无法迁移本地设置');
  return result.payload;
}
