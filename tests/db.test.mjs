import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, rm } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { legacyWeChatTarget, ReaderDatabase, sqlValue } from '../src/server/db.mjs';

test('sqlValue safely quotes text and primitive values', () => {
  assert.equal(sqlValue("O'Reilly"), "'O''Reilly'");
  assert.equal(sqlValue(true), '1');
  assert.equal(sqlValue(null), 'NULL');
  assert.throws(() => sqlValue(Number.NaN));
});

test('SQLite data layer supports create, search, tags and durable flags', async (t) => {
  const dir = await mkdtemp(path.join(os.tmpdir(), 'reader-db-'));
  t.after(() => rm(dir, { recursive: true, force: true }));
  const db = await new ReaderDatabase(path.join(dir, 'reader.sqlite3')).initialize();
  const initial = await db.stats();
  assert.equal(initial.total, 3);

  const article = await db.createArticle({ title: '本地知识工作流', source: '测试', author: 'Reader', type: 'markdown', language: 'zh', content: '这是一篇关于本地优先、全文搜索和知识整理的测试文章。', excerpt: '本地优先知识整理。', collection_id: 'notes' });
  assert.equal(article.title, '本地知识工作流');
  assert.equal(article.is_favorite, false);

  const found = await db.listArticles({ query: '知识' });
  assert.ok(found.some((item) => item.id === article.id));
  const updated = await db.updateArticle(article.id, { is_favorite: true, reading_progress: 0.75 });
  assert.equal(updated.is_favorite, true);
  assert.equal(updated.reading_progress, 0.75);
  const tagged = await db.addTags(article.id, ['本地优先', '研究']);
  assert.deepEqual(tagged.tags.sort(), ['本地优先', '研究'].sort());
  await db.createAttachment({ articleId: article.id, fileName: 'cover.png', storageName: `${'a'.repeat(64)}.png`, mimeType: 'image/png', byteSize: 128, sha256: 'a'.repeat(64) });
  assert.match((await db.getArticle(article.id)).attachments[0].thumbnail_url, /\/thumbnail$/);
  await assert.rejects(db.createAttachment({ articleId: article.id, fileName: 'bad.png', storageName: '../outside.png', mimeType: 'image/png', byteSize: 1, sha256: 'b'.repeat(64) }), /存储名无效/);
  await assert.rejects(db.createAttachment({ articleId: article.id, fileName: 'bad.png', storageName: 'bad.png', mimeType: 'image/png', byteSize: 1, sha256: '../outside' }), /哈希无效/);
  const stats = await db.stats();
  assert.equal(stats.total, 4);
  assert.equal(stats.favorites, 1);
});

test('import jobs persist state, results and retry transitions', async (t) => {
  const dir = await mkdtemp(path.join(os.tmpdir(), 'reader-jobs-'));
  t.after(() => rm(dir, { recursive: true, force: true }));
  const db = await new ReaderDatabase(path.join(dir, 'reader.sqlite3')).initialize();
  const job = await db.createImportJob('url', { url: 'https://example.com/article', collectionId: 'inbox' });
  assert.equal(job.status, 'pending');
  const claimed = await db.claimImportJob();
  assert.equal(claimed.id, job.id);
  assert.equal(claimed.status, 'running');
  assert.equal(claimed.attempts, 1);
  const reopened = await new ReaderDatabase(path.join(dir, 'reader.sqlite3')).initialize();
  assert.equal((await reopened.getImportJob(job.id)).status, 'pending');
  const reclaimed = await reopened.claimImportJob();
  assert.equal(reclaimed.attempts, 2);
  const failed = await reopened.failImportJob(job.id, 'network unavailable');
  assert.equal(failed.status, 'failed');
  assert.match(failed.error, /network/);
  const retried = await db.retryImportJob(job.id);
  assert.equal(retried.status, 'pending');
  const article = await db.createArticle({ title: 'Queue result', content: 'durable local result' });
  const completed = await db.completeImportJob(job.id, article.id);
  assert.equal(completed.status, 'completed');
  assert.equal(completed.result_article_id, article.id);
});

test('article revisions preserve edits and make restores reversible', async (t) => {
  const dir = await mkdtemp(path.join(os.tmpdir(), 'reader-revisions-'));
  t.after(() => rm(dir, { recursive: true, force: true }));
  const db = await new ReaderDatabase(path.join(dir, 'reader.sqlite3')).initialize();
  const article = await db.createArticle({ title: 'Version one', excerpt: 'Initial', content: '# First\n\nOriginal content.' });
  assert.equal(article.revision_count, 1);
  const edited = await db.updateArticle(article.id, { title: 'Version two', content: '# Second\n\nEdited content.' });
  assert.equal(edited.revision_count, 2);
  await db.updateArticle(article.id, { is_favorite: true });
  assert.equal((await db.getArticle(article.id)).revision_count, 2);
  const revisions = await db.listArticleRevisions(article.id);
  assert.deepEqual(revisions.map((item) => item.version), [2, 1]);
  const restored = await db.restoreArticleRevision(article.id, 1);
  assert.equal(restored.title, 'Version one');
  assert.match(restored.content, /Original content/);
  assert.equal(restored.revision_count, 3);
  assert.equal((await db.listArticleRevisions(article.id))[0].reason, 'restore:1');
});

test('legacy WeChat challenge captures are normalized without deleting duplicates', async (t) => {
  const dir = await mkdtemp(path.join(os.tmpdir(), 'reader-wechat-repair-'));
  t.after(() => rm(dir, { recursive: true, force: true }));
  const db = await new ReaderDatabase(path.join(dir, 'reader.sqlite3')).initialize();
  const target = 'https://mp.weixin.qq.com/s/wechat-token';
  const firstCapture = `https://mp.weixin.qq.com/mp/wappoc_appmsgcaptcha?poc_token=one&target_url=${encodeURIComponent(target)}`;
  const secondCapture = `https://mp.weixin.qq.com/mp/wappoc_appmsgcaptcha?poc_token=two&target_url=${encodeURIComponent(`${target}?`)}`;
  assert.equal(legacyWeChatTarget(secondCapture), target);
  const first = await db.createArticle({ url: firstCapture, title: 'mp.weixin.qq.com', source: 'mp.weixin.qq.com', content: '环境异常，完成验证后即可继续访问。去验证。' });
  const second = await db.createArticle({ url: secondCapture, title: 'mp.weixin.qq.com', source: 'mp.weixin.qq.com', content: '环境异常，完成验证后即可继续访问。去验证。' });
  const result = await db.repairLegacyWeChatCaptures();
  assert.deepEqual(result, { normalized: 1, archived: 1 });
  const normalized = await db.getArticleByURL(target);
  assert.ok(normalized);
  assert.equal(normalized.metadata.importState, 'needs-reimport');
  const archived = [await db.getArticle(first.id), await db.getArticle(second.id)].find((article) => article.id !== normalized.id);
  assert.equal(archived.archived, true);
  assert.equal(archived.metadata.importState, 'legacy-duplicate-archived');
});

test('nested collections count descendants, prevent cycles and move content safely on delete', async (t) => {
  const dir = await mkdtemp(path.join(os.tmpdir(), 'reader-collections-'));
  t.after(() => rm(dir, { recursive: true, force: true }));
  const db = await new ReaderDatabase(path.join(dir, 'reader.sqlite3')).initialize();
  const parent = await db.createCollection({ name: '研究主题' });
  const child = await db.createCollection({ name: '本地优先', parentId: parent.id });
  const article = await db.createArticle({ title: '层级资料', content: '保存在子资料夹。', collection_id: child.id });
  const collections = await db.listCollections();
  assert.equal(collections.find((item) => item.id === parent.id).article_count, 1);
  assert.equal(collections.find((item) => item.id === parent.id).child_count, 1);
  assert.equal((await db.listArticles({ collectionId: parent.id })).some((item) => item.id === article.id), true);
  await assert.rejects(db.updateCollection(parent.id, { parent_id: child.id }), /子资料夹/);
  await assert.rejects(db.createCollection({ name: '本地优先', parentId: parent.id }), /已存在/);
  await db.deleteCollection(parent.id, { moveTo: 'inbox' });
  assert.equal((await db.getArticle(article.id)).collection_id, 'inbox');
  assert.equal((await db.listCollections()).some((item) => item.id === child.id), false);
  await assert.rejects(db.deleteCollection('inbox'), /系统资料夹/);
});

test('batch organization updates flags, tags and archive filters atomically', async (t) => {
  const dir = await mkdtemp(path.join(os.tmpdir(), 'reader-batch-'));
  t.after(() => rm(dir, { recursive: true, force: true }));
  const db = await new ReaderDatabase(path.join(dir, 'reader.sqlite3')).initialize();
  const first = await db.createArticle({ title: '批量一', content: '第一条内容。' });
  const second = await db.createArticle({ title: '批量二', content: '第二条内容。' });
  const result = await db.batchUpdateArticles([first.id, second.id], { collection_id: 'design', is_favorite: true, is_read: true, tags_add: ['待研究', '产品'] });
  assert.equal(result.updated, 2);
  assert.equal((await db.getArticle(first.id)).is_favorite, true);
  assert.deepEqual((await db.getArticle(second.id)).tags.sort(), ['产品', '待研究'].sort());
  assert.equal((await db.listTags()).find((tag) => tag.name === '待研究').article_count, 2);
  await db.batchUpdateArticles([first.id], { archived: true, tags_remove: ['产品'] });
  assert.equal((await db.listArticles({ view: 'archive' })).some((item) => item.id === first.id), true);
  assert.equal((await db.listArticles()).some((item) => item.id === first.id), false);
  assert.deepEqual((await db.getArticle(first.id)).tags, ['待研究']);
});
