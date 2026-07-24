import path from 'node:path';
import { chmod } from 'node:fs/promises';
import { createBackup } from './backup.mjs';
import { inspectDataHealth } from './data-health.mjs';

function repairError(status, message) {
  return Object.assign(new Error(message), { status, expected: true });
}

function publicBackup(backup) {
  const { manifest: _manifest, ...safe } = backup;
  return safe;
}

export async function repairDerivedData({ database, rootDir, filesDir, appVersion }) {
  const before = await inspectDataHealth({ database, filesDir });
  if (before.repair.blockers.length) {
    throw repairError(409, '资料库存在无法自动修复的问题，请先从可靠备份恢复或完成受控诊断');
  }
  if (!before.repair.actions.length) throw repairError(409, '当前没有需要修复的可重建项目');

  const actions = [...before.repair.actions];
  let backup = null;
  if (actions.includes('search_index')) {
    backup = await createBackup({ database, rootDir, appVersion, reason: 'pre-repair' });
    await database.rebuildDerivedSearchIndexes();
  }
  if (actions.includes('storage_permissions')) {
    await chmod(path.dirname(filesDir), 0o700);
    await database.hardenDatabasePermissions();
  }

  const health = await inspectDataHealth({ database, filesDir });
  const unresolved = actions.filter((action) => action === 'storage_permissions'
    ? !health.database.private_permissions
    : !health.search || health.search.pendingArticles > 0 || !health.search.consistent);
  if (unresolved.length) throw repairError(500, '可重建项目仍未通过检查；安全备份已保留，请不要继续修改资料库');

  return {
    repaired_at: new Date().toISOString(),
    actions,
    backup: backup ? publicBackup(backup) : null,
    health
  };
}
