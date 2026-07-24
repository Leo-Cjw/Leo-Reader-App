import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, rm } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { normalizeSmartCollectionRule, ReaderDatabase } from '../src/server/db.mjs';
import { createReaderServer } from '../src/server/server.mjs';

async function json(url, init) {
  const response = await fetch(url, init);
  const body = await response.json();
  return { response, body };
}

function rule(patch = {}) {
  return normalizeSmartCollectionRule({
    match: 'all',
    query: '',
    types: [],
    tags: [],
    tag_match: 'any',
    source: '',
    collection_id: null,
    unread: null,
    favorite: null,
    has_highlights: null,
    has_attachments: null,
    created_within_days: null,
    ...patch
  });
}

test('smart collections persist rules, count live matches and keep manual folders independent', async (t) => {
  const dir = await mkdtemp(path.join(os.tmpdir(), 'reader-smart-db-'));
  t.after(() => rm(dir, { recursive: true, force: true }));
  const db = await new ReaderDatabase(path.join(dir, 'reader.sqlite3')).initialize();
  const project = await db.createCollection({ name: '智能整理测试' });
  const first = await db.createArticle({
    title: '本地优先研究',
    content: '高亮、收藏和标签共同构成一条规则。',
    source: '产品研究',
    collection_id: project.id,
    is_favorite: true
  });
  await db.addTags(first.id, ['重点', '本地优先']);
  await db.createHighlight({
    articleId: first.id,
    quote: '高亮',
    note: '关键证据',
    color: 'green',
    startOffset: 0,
    endOffset: 2
  });
  const second = await db.createArticle({
    title: '普通附件',
    content: '只包含一个本地附件。',
    source: '资料库',
    collection_id: project.id,
    is_read: true
  });
  await db.createAttachment({
    articleId: second.id,
    fileName: 'note.txt',
    storageName: `${'c'.repeat(64)}.txt`,
    mimeType: 'text/plain',
    byteSize: 12,
    sha256: 'c'.repeat(64)
  });

  const focused = await db.createSmartCollection({
    name: '重点高亮',
    rule: rule({ tags: ['重点'], favorite: true, has_highlights: true })
  });
  assert.equal(focused.article_count, 1);
  assert.deepEqual((await db.listArticles({ smartCollectionId: focused.id })).map((article) => article.id), [first.id]);

  const broad = await db.createSmartCollection({
    name: '最近要处理',
    rule: rule({ match: 'any', query: '普通附件', unread: true, has_attachments: true })
  });
  assert.ok(broad.article_count >= 2);
  assert.ok((await db.listArticles({ smartCollectionId: broad.id })).some((article) => article.id === second.id));

  await assert.rejects(db.createSmartCollection({ name: '空规则', rule: {} }), /至少需要一条规则/);
  await assert.rejects(db.createSmartCollection({ name: '重点高亮', rule: rule({ unread: true }) }), /已存在/);
  const updated = await db.updateSmartCollection(focused.id, { name: '收藏且未读', rule: rule({ favorite: true, unread: true }) });
  assert.equal(updated.name, '收藏且未读');
  assert.equal(updated.article_count, 1);

  const reordered = await db.reorderSmartCollections([broad.id, focused.id]);
  assert.deepEqual(reordered.map((item) => item.id), [broad.id, focused.id]);

  const childA = await db.createCollection({ name: '第一', parentId: project.id });
  const childB = await db.createCollection({ name: '第二', parentId: project.id });
  await db.reorderCollections(project.id, [childB.id, childA.id]);
  const childOrder = (await db.listCollections()).filter((item) => item.parent_id === project.id).map((item) => item.id);
  assert.deepEqual(childOrder, [childB.id, childA.id]);

  const reopened = await new ReaderDatabase(db.path).initialize();
  assert.equal(reopened.lastMigrationSnapshot, null);
  assert.equal((await reopened.one('SELECT max(version) AS version FROM schema_migrations;')).version, 10);
  assert.deepEqual((await reopened.listSmartCollections()).map((item) => item.name), ['最近要处理', '收藏且未读']);
  assert.equal((await reopened.deleteSmartCollection(broad.id)).name, '最近要处理');
  assert.equal((await reopened.listSmartCollections()).length, 1);
});

test('smart collection HTTP API validates rules, filters articles and supports ordering', async (t) => {
  const dir = await mkdtemp(path.join(os.tmpdir(), 'reader-smart-api-'));
  t.after(() => rm(dir, { recursive: true, force: true }));
  const app = await createReaderServer({ rootDir: dir, dbPath: path.join(dir, 'reader.sqlite3'), port: 0 });
  const address = await app.listen();
  t.after(() => app.close());
  const base = `http://127.0.0.1:${address.port}`;

  const article = (await json(`${base}/api/articles`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ mode: 'markdown', title: '智能资料夹 API', content: '这条未读笔记应该自动出现。' })
  })).body.article;

  const invalid = await json(`${base}/api/smart-collections`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ name: '没有规则', rule: {} })
  });
  assert.equal(invalid.response.status, 400);

  const created = await json(`${base}/api/smart-collections`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ name: '未读笔记', rule: rule({ types: ['markdown'], unread: true }) })
  });
  assert.equal(created.response.status, 201);
  assert.equal(created.body.smartCollection.article_count, 1);
  const id = created.body.smartCollection.id;

  const matches = await json(`${base}/api/articles?smart=${encodeURIComponent(id)}`);
  assert.ok(matches.body.articles.some((item) => item.id === article.id));

  const second = await json(`${base}/api/smart-collections`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ name: '最近内容', rule: rule({ created_within_days: 7 }) })
  });
  const reordered = await json(`${base}/api/smart-collections/reorder`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ ordered_ids: [second.body.smartCollection.id, id] })
  });
  assert.deepEqual(reordered.body.smartCollections.map((item) => item.id), [second.body.smartCollection.id, id]);

  const patched = await json(`${base}/api/smart-collections/${id}`, {
    method: 'PATCH',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ name: '全部笔记', rule: rule({ types: ['markdown'] }) })
  });
  assert.equal(patched.body.smartCollection.name, '全部笔记');
  assert.equal((await json(`${base}/api/smart-collections`)).body.smartCollections.length, 2);
  assert.equal((await json(`${base}/api/smart-collections/${id}`, { method: 'DELETE' })).body.deleted, true);
});
