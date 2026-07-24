import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, rm } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { ReaderDatabase } from '../src/server/db.mjs';
import { prepareMarkdownExport } from '../src/server/export.mjs';
import { createReaderServer } from '../src/server/server.mjs';

async function json(url, init) {
  const response = await fetch(url, init);
  const body = await response.json();
  return { response, body };
}

test('highlights persist locally, update notes and follow article deletion', async (t) => {
  const dir = await mkdtemp(path.join(os.tmpdir(), 'reader-highlights-db-'));
  t.after(() => rm(dir, { recursive: true, force: true }));
  const db = await new ReaderDatabase(path.join(dir, 'reader.sqlite3')).initialize();
  const article = await db.createArticle({ title: '高亮测试', content: '本地高亮应该可以持续保存，并随完整备份迁移。' });
  const created = await db.createHighlight({
    articleId: article.id,
    quote: '本地高亮应该可以持续保存',
    note: '这是关键结论',
    color: 'amber',
    startOffset: 0,
    endOffset: 13
  });
  assert.equal((await db.listHighlights(article.id))[0].note, '这是关键结论');
  const updated = await db.updateHighlight(created.id, { note: '更新后的批注', color: 'blue' });
  assert.equal(updated.color, 'blue');
  const reopened = await new ReaderDatabase(db.path).initialize();
  assert.equal((await reopened.listHighlights(article.id))[0].note, '更新后的批注');
  const exported = await prepareMarkdownExport({ database: reopened, filesDir: path.join(dir, 'files'), ids: [article.id], includeAttachments: false });
  const markdown = exported.entries.find((entry) => entry.archivePath.startsWith('articles/')).content;
  assert.equal(exported.manifest.counts.highlights, 1);
  assert.equal(exported.manifest.articles[0].highlights[0].note, '更新后的批注');
  assert.match(markdown, /## 高亮与批注/);
  assert.match(markdown, /> 本地高亮应该可以持续保存/);
  await db.execute(`DELETE FROM articles WHERE id='${article.id}';`);
  assert.deepEqual(await db.listHighlights(article.id), []);
});

test('highlight HTTP API validates anchors and supports the full local CRUD flow', async (t) => {
  const dir = await mkdtemp(path.join(os.tmpdir(), 'reader-highlights-api-'));
  t.after(() => rm(dir, { recursive: true, force: true }));
  const app = await createReaderServer({ rootDir: dir, dbPath: path.join(dir, 'reader.sqlite3'), port: 0 });
  const address = await app.listen();
  t.after(() => app.close());
  const base = `http://127.0.0.1:${address.port}`;
  const article = (await json(`${base}/api/articles`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ mode: 'markdown', title: 'API 高亮', content: '选中一句话，然后写下自己的理解。' })
  })).body.article;

  const invalid = await json(`${base}/api/articles/${article.id}/highlights`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ quote: '错误范围', color: 'violet', start_offset: 8, end_offset: 2 })
  });
  assert.equal(invalid.response.status, 400);

  const created = await json(`${base}/api/articles/${article.id}/highlights`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ quote: '写下自己的理解', note: '形成知识，而不只是收藏', color: 'green', start_offset: 8, end_offset: 15 })
  });
  assert.equal(created.response.status, 201);
  assert.equal(created.body.highlight.color, 'green');
  const id = created.body.highlight.id;
  assert.equal((await json(`${base}/api/articles/${article.id}/highlights`)).body.highlights.length, 1);

  const patched = await json(`${base}/api/highlights/${id}`, {
    method: 'PATCH',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ note: '重新组织后的理解', color: 'pink' })
  });
  assert.equal(patched.body.highlight.note, '重新组织后的理解');
  assert.equal(patched.body.highlight.color, 'pink');
  assert.equal((await json(`${base}/api/highlights/${id}`, { method: 'DELETE' })).body.deleted, true);
  assert.deepEqual((await json(`${base}/api/articles/${article.id}/highlights`)).body.highlights, []);
});
