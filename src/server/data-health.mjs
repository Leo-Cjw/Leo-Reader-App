import { readdir, stat } from 'node:fs/promises';
import path from 'node:path';
import { verifyMigrationHistory } from './migrations.mjs';
import { SCHEMA_VERSION } from './schema.mjs';

async function optionalStat(filePath) {
  try {
    return await stat(filePath);
  } catch (error) {
    if (error?.code === 'ENOENT') return null;
    throw error;
  }
}

function privateMode(info) {
  return Boolean(info) && (info.mode & 0o077) === 0;
}

function check(id, label, status, detail) {
  return { id, label, status, detail };
}

export async function inspectDataHealth({ database, filesDir }) {
  const startedAt = Date.now();
  const checks = [];

  let integrity = false;
  try {
    const rows = await database.query('PRAGMA integrity_check;');
    integrity = rows.length === 1 && rows[0].integrity_check === 'ok';
    checks.push(check(
      'database_integrity',
      'SQLite 完整性',
      integrity ? 'pass' : 'fail',
      integrity ? '数据库页结构完整' : `完整性检查发现 ${Math.max(rows.length, 1)} 项异常`
    ));
  } catch {
    checks.push(check('database_integrity', 'SQLite 完整性', 'fail', '无法完成数据库完整性检查'));
  }

  let foreignKeyViolations = null;
  try {
    const rows = await database.query('PRAGMA foreign_key_check;');
    foreignKeyViolations = rows.length;
    checks.push(check(
      'foreign_keys',
      '关联关系',
      rows.length === 0 ? 'pass' : 'fail',
      rows.length === 0 ? '所有外键关系有效' : `发现 ${rows.length} 条失效关联`
    ));
  } catch {
    checks.push(check('foreign_keys', '关联关系', 'fail', '无法完成外键检查'));
  }

  let migrationHistoryVerified = false;
  try {
    await verifyMigrationHistory(database);
    migrationHistoryVerified = true;
    checks.push(check('migration_history', '迁移历史', 'pass', `Schema v${SCHEMA_VERSION} 审计记录匹配`));
  } catch {
    checks.push(check('migration_history', '迁移历史', 'fail', '迁移版本或审计记录不匹配'));
  }

  const databaseInfo = await stat(database.path);
  const dataRootInfo = await optionalStat(path.dirname(filesDir));
  const sidecarInfo = await Promise.all([optionalStat(`${database.path}-wal`), optionalStat(`${database.path}-shm`)]);
  const permissionsPrivate = [databaseInfo, dataRootInfo, ...sidecarInfo.filter(Boolean)].filter(Boolean).every(privateMode);
  checks.push(check(
    'storage_permissions',
    '本地权限',
    permissionsPrivate ? 'pass' : 'fail',
    permissionsPrivate ? '数据库与运行目录仅当前用户可访问' : '数据库或运行目录允许其他本机用户访问'
  ));

  const attachmentRows = await database.query('SELECT storage_name,byte_size FROM attachments;');
  const referencedFiles = new Map();
  for (const row of attachmentRows) {
    if (!referencedFiles.has(row.storage_name)) referencedFiles.set(row.storage_name, Number(row.byte_size));
  }
  let fileEntries = [];
  try {
    fileEntries = (await readdir(filesDir, { withFileTypes: true })).filter((entry) => entry.isFile() && !entry.name.startsWith('.'));
  } catch (error) {
    if (error?.code !== 'ENOENT') throw error;
  }
  const storedFiles = new Map(await Promise.all(fileEntries.map(async (entry) => [
    entry.name,
    (await stat(path.join(filesDir, entry.name))).size
  ])));
  let missingFiles = 0;
  let sizeMismatches = 0;
  for (const [storageName, expectedSize] of referencedFiles) {
    if (!storedFiles.has(storageName)) missingFiles += 1;
    else if (storedFiles.get(storageName) !== expectedSize) sizeMismatches += 1;
  }
  const orphanFiles = [...storedFiles.keys()].filter((name) => !referencedFiles.has(name)).length;
  const attachmentStatus = missingFiles || sizeMismatches ? 'fail' : orphanFiles ? 'warning' : 'pass';
  const attachmentDetail = missingFiles || sizeMismatches
    ? `缺少 ${missingFiles} 个文件，${sizeMismatches} 个大小不符`
    : orphanFiles
      ? `附件均可用，另有 ${orphanFiles} 个未引用文件`
      : `${referencedFiles.size} 个附件文件均可用`;
  checks.push(check('attachment_files', '附件可用性', attachmentStatus, attachmentDetail));

  let searchIndex = null;
  try {
    searchIndex = await database.getChunkIndexStatus();
    checks.push(check(
      'search_index',
      '本地检索索引',
      searchIndex.pendingArticles === 0 ? 'pass' : 'warning',
      searchIndex.pendingArticles === 0
        ? `${searchIndex.indexedArticles} 篇内容已建立 ${searchIndex.chunkCount} 个片段`
        : `${searchIndex.pendingArticles} 篇内容等待重新索引`
    ));
  } catch {
    checks.push(check('search_index', '本地检索索引', 'fail', '无法读取本地检索索引'));
  }

  const status = checks.some((item) => item.status === 'fail')
    ? 'error'
    : checks.some((item) => item.status === 'warning') ? 'warning' : 'healthy';
  return {
    status,
    checked_at: new Date().toISOString(),
    duration_ms: Date.now() - startedAt,
    schema_version: SCHEMA_VERSION,
    database: {
      byte_size: databaseInfo.size,
      integrity,
      foreign_key_violations: foreignKeyViolations,
      migration_history_verified: migrationHistoryVerified,
      private_permissions: permissionsPrivate
    },
    attachments: {
      records: attachmentRows.length,
      referenced_files: referencedFiles.size,
      stored_files: storedFiles.size,
      missing_files: missingFiles,
      size_mismatches: sizeMismatches,
      orphan_files: orphanFiles
    },
    search: searchIndex,
    checks
  };
}
