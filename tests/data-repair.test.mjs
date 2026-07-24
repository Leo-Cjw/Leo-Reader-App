import test from 'node:test';
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { chmod, mkdir, mkdtemp, readFile, rm, stat, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { listBackups, resolveBackup } from '../src/server/backup.mjs';
import { inspectDataHealth } from '../src/server/data-health.mjs';
import { repairDerivedData } from '../src/server/data-repair.mjs';
import { ReaderDatabase, sqlValue } from '../src/server/db.mjs';
import { createReaderServer } from '../src/server/server.mjs';
import { APP_VERSION } from '../src/server/version.mjs';

async function fixture(t) {
  const root = await mkdtemp(path.join(os.tmpdir(), 'reader-data-repair-'));
  t.after(() => rm(root, { recursive: true, force: true }));
  const database = await new ReaderDatabase(path.join(root, 'data', 'reader.sqlite3')).initialize();
  return { root, database, filesDir: path.join(root, 'data', 'files') };
}

async function removeDerivedIndexRows(database, articleId) {
  await database.execute(`INSERT INTO article_search(article_search,rowid,title,excerpt,content,author,source)
    SELECT 'delete',rowid,title,excerpt,content,author,source FROM articles WHERE id=${sqlValue(articleId)};
    INSERT INTO article_search_trigram(article_search_trigram,rowid,title,excerpt,content,author,source)
    SELECT 'delete',rowid,title,excerpt,content,author,source FROM articles WHERE id=${sqlValue(articleId)};
    DELETE FROM article_chunks WHERE article_id=${sqlValue(articleId)};`);
}

test('controlled repair backs up before rebuilding indexes and preserves articles and attachments byte-for-byte', async (t) => {
  const { root, database, filesDir } = await fixture(t);
  const article = await database.createArticle({
    title: 'Controlled repair sentinel 性能修复标记',
    excerpt: 'Immutable repair evidence',
    content: '# Repair\n\nThe RepairSentinelToken must remain searchable and unchanged.',
    author: 'Local Reader',
    source: 'Private fixture'
  });
  const attachmentBytes = Buffer.from('attachment bytes must remain exactly unchanged');
  const attachmentHash = createHash('sha256').update(attachmentBytes).digest('hex');
  const storageName = `${attachmentHash}.txt`;
  await mkdir(filesDir, { recursive: true, mode: 0o700 });
  await writeFile(path.join(filesDir, storageName), attachmentBytes, { mode: 0o600 });
  await database.createAttachment({
    articleId: article.id,
    fileName: 'repair-evidence.txt',
    storageName,
    mimeType: 'text/plain',
    byteSize: attachmentBytes.length,
    sha256: attachmentHash
  });
  const articleBefore = await database.one(`SELECT * FROM articles WHERE id=${sqlValue(article.id)};`);
  const attachmentBefore = await database.one(`SELECT * FROM attachments WHERE article_id=${sqlValue(article.id)};`);

  await removeDerivedIndexRows(database, article.id);
  await chmod(database.path, 0o644);
  await chmod(path.dirname(filesDir), 0o755);
  const damaged = await inspectDataHealth({ database, filesDir });
  assert.equal(damaged.repair.available, true);
  assert.deepEqual(damaged.repair.actions.sort(), ['search_index', 'storage_permissions']);
  assert.equal(damaged.search.consistent, false);
  assert.equal(damaged.search.pendingArticles, 1);
  assert.equal((await database.listArticles({ query: 'RepairSentinelToken' })).length, 0);
  assert.equal((await database.listArticles({ query: '性能修复标记' })).length, 0);

  const result = await repairDerivedData({ database, rootDir: root, filesDir, appVersion: APP_VERSION });

  assert.deepEqual(result.actions.sort(), ['search_index', 'storage_permissions']);
  assert.equal(result.backup.reason, 'pre-repair');
  assert.equal('manifest' in result.backup, false);
  assert.equal(result.health.status, 'healthy');
  assert.equal(result.health.repair.available, false);
  assert.equal(result.health.search.consistent, true);
  assert.equal(result.health.search.pendingArticles, 0);
  assert.equal((await stat(database.path)).mode & 0o777, 0o600);
  assert.equal((await stat(path.dirname(filesDir))).mode & 0o777, 0o700);
  assert.deepEqual(await database.one(`SELECT * FROM articles WHERE id=${sqlValue(article.id)};`), articleBefore);
  assert.deepEqual(await database.one(`SELECT * FROM attachments WHERE article_id=${sqlValue(article.id)};`), attachmentBefore);
  assert.deepEqual(await readFile(path.join(filesDir, storageName)), attachmentBytes);
  assert.equal((await database.listArticles({ query: 'RepairSentinelToken' }))[0].id, article.id);
  assert.equal((await database.listArticles({ query: '性能修复标记' }))[0].id, article.id);
  assert.equal((await database.searchArticleChunks('RepairSentinelToken'))[0].articleId, article.id);

  const backup = await resolveBackup(root, result.backup.id);
  assert.ok(backup);
  assert.equal((await stat(backup.path)).mode & 0o777, 0o600);
});

test('controlled repair fails closed without a backup when a non-reconstructable attachment problem exists', async (t) => {
  const { root, database, filesDir } = await fixture(t);
  const article = await database.createArticle({ title: 'Blocked repair', content: 'BlockedRepairSentinel' });
  await database.createAttachment({
    articleId: article.id,
    fileName: 'missing.txt',
    storageName: `${'a'.repeat(64)}.txt`,
    mimeType: 'text/plain',
    byteSize: 7,
    sha256: 'a'.repeat(64)
  });
  await removeDerivedIndexRows(database, article.id);

  const health = await inspectDataHealth({ database, filesDir });
  assert.equal(health.repair.available, false);
  assert.ok(health.repair.blockers.includes('attachment_files'));
  await assert.rejects(
    repairDerivedData({ database, rootDir: root, filesDir, appVersion: APP_VERSION }),
    (error) => error.status === 409 && error.expected === true
  );
  assert.equal((await listBackups(root)).length, 0);
  assert.equal((await database.getChunkIndexStatus()).pendingArticles, 1);
});

test('a failed index rebuild leaves the repair safety backup and user content intact', async (t) => {
  const { root, database, filesDir } = await fixture(t);
  const article = await database.createArticle({ title: 'Failed rebuild', content: 'FailureSafetySentinel' });
  const articleBefore = await database.one(`SELECT * FROM articles WHERE id=${sqlValue(article.id)};`);
  await removeDerivedIndexRows(database, article.id);
  database.rebuildDerivedSearchIndexes = async () => { throw new Error('simulated rebuild failure'); };

  await assert.rejects(
    repairDerivedData({ database, rootDir: root, filesDir, appVersion: APP_VERSION }),
    /simulated rebuild failure/
  );

  const backups = await listBackups(root);
  assert.equal(backups.length, 1);
  assert.deepEqual(await database.one(`SELECT * FROM articles WHERE id=${sqlValue(article.id)};`), articleBefore);
  assert.equal((await database.getChunkIndexStatus()).pendingArticles, 1);
});

test('repair API returns only public backup metadata and its safety backup is downloadable', async (t) => {
  const root = await mkdtemp(path.join(os.tmpdir(), 'reader-data-repair-api-'));
  t.after(() => rm(root, { recursive: true, force: true }));
  const app = await createReaderServer({ rootDir: root, dbPath: path.join(root, 'data', 'reader.sqlite3'), port: 0 });
  const address = await app.listen();
  t.after(() => app.close());
  const article = await app.database.createArticle({ title: 'Repair API sentinel', content: 'RepairApiSentinelToken' });
  await removeDerivedIndexRows(app.database, article.id);
  const importJob = await app.database.createImportJob('attachment', { privatePath: '/must-not-leak' });
  const blockedResponse = await fetch(`http://127.0.0.1:${address.port}/api/data-health/repair`, { method: 'POST' });
  const blockedBody = await blockedResponse.json();
  assert.equal(blockedResponse.status, 409);
  assert.deepEqual(blockedBody, { error: '请等待导入任务完成后再修复资料库' });
  assert.doesNotMatch(JSON.stringify(blockedBody), /must-not-leak/);
  await app.database.completeImportJob(importJob.id, article.id);

  const response = await fetch(`http://127.0.0.1:${address.port}/api/data-health/repair`, { method: 'POST' });
  const body = await response.json();

  assert.equal(response.status, 200);
  assert.equal(body.result.health.status, 'healthy');
  assert.equal(body.result.backup.reason, 'pre-repair');
  assert.equal('manifest' in body.result.backup, false);
  assert.doesNotMatch(JSON.stringify(body), new RegExp(root.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')));
  const download = await fetch(`http://127.0.0.1:${address.port}/api/backups/${body.result.backup.id}/download`);
  assert.equal(download.status, 200);
  assert.ok((await download.arrayBuffer()).byteLength > 0);
});
