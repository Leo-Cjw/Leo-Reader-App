import test from 'node:test';
import assert from 'node:assert/strict';
import { chmod, mkdtemp, rm, stat } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { inspectDataHealth } from '../src/server/data-health.mjs';
import { ReaderDatabase } from '../src/server/db.mjs';

async function fixture(t) {
  const root = await mkdtemp(path.join(os.tmpdir(), 'reader-data-health-'));
  t.after(() => rm(root, { recursive: true, force: true }));
  const dbPath = path.join(root, 'data', 'reader.sqlite3');
  const database = await new ReaderDatabase(dbPath).initialize();
  return { root, database, filesDir: path.join(root, 'data', 'files') };
}

test('data health verifies a private current database without exposing local paths', async (t) => {
  const { root, database, filesDir } = await fixture(t);
  assert.equal((await stat(path.dirname(database.path))).mode & 0o777, 0o700);
  assert.equal((await stat(database.path)).mode & 0o777, 0o600);
  const before = await stat(database.path);

  const health = await inspectDataHealth({ database, filesDir });

  assert.equal(health.status, 'healthy');
  assert.equal(health.database.integrity, true);
  assert.equal(health.database.foreign_key_violations, 0);
  assert.equal(health.database.migration_history_verified, true);
  assert.equal(health.database.private_permissions, true);
  assert.equal(health.attachments.missing_files, 0);
  assert.equal(health.search.pendingArticles, 0);
  assert.ok(health.checks.every((item) => item.status === 'pass'));
  assert.doesNotMatch(JSON.stringify(health), new RegExp(root.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')));
  assert.equal((await stat(database.path)).mtimeMs, before.mtimeMs);
});

test('data health reports broken relations and unavailable attachments without returning record identifiers', async (t) => {
  const { database, filesDir } = await fixture(t);
  const article = await database.createArticle({ title: '健康检查私有文章', content: '不应出现在检查结果中。' });
  await database.createAttachment({
    articleId: article.id,
    fileName: 'private-name.txt',
    storageName: `${'d'.repeat(64)}.txt`,
    mimeType: 'text/plain',
    byteSize: 18,
    sha256: 'd'.repeat(64)
  });
  await database.execute(`PRAGMA foreign_keys=OFF;
    INSERT INTO highlights(id,article_id,quote,note,color,created_at,updated_at)
    VALUES ('broken-health-link','missing-article','private quote','','amber','2026-01-01','2026-01-01');`);

  const health = await inspectDataHealth({ database, filesDir });
  const serialized = JSON.stringify(health);

  assert.equal(health.status, 'error');
  assert.equal(health.database.foreign_key_violations, 1);
  assert.equal(health.attachments.missing_files, 1);
  assert.equal(health.checks.find((item) => item.id === 'foreign_keys').status, 'fail');
  assert.equal(health.checks.find((item) => item.id === 'attachment_files').status, 'fail');
  assert.doesNotMatch(serialized, /健康检查私有文章|private-name|broken-health-link|missing-article|private quote/);
});

test('data health detects database permissions that allow other local users', async (t) => {
  const { database, filesDir } = await fixture(t);
  await chmod(database.path, 0o644);

  const health = await inspectDataHealth({ database, filesDir });

  assert.equal(health.status, 'error');
  assert.equal(health.database.private_permissions, false);
  assert.equal(health.checks.find((item) => item.id === 'storage_permissions').status, 'fail');
});
