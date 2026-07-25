import test from 'node:test';
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { once } from 'node:events';
import { PassThrough } from 'node:stream';
import { mkdir, mkdtemp, readFile, rm, stat, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { ZipArchive } from 'archiver';
import { ReaderDatabase } from '../src/server/db.mjs';
import { cleanupPortableImports, validatePortableEntryPath } from '../src/server/portable-import.mjs';
import { createReaderServer } from '../src/server/server.mjs';

async function json(url, init) {
  const response = await fetch(url, init);
  const body = await response.json();
  return { response, body };
}

async function zipBuffer(entries) {
  const output = new PassThrough();
  const chunks = [];
  output.on('data', (chunk) => chunks.push(chunk));
  const ended = once(output, 'end');
  const archive = new ZipArchive({ zlib: { level: 9 } });
  archive.pipe(output);
  for (const [name, content] of entries) archive.append(content, { name });
  await archive.finalize();
  await ended;
  return Buffer.concat(chunks);
}

async function startReader(rootDir) {
  const app = await createReaderServer({ rootDir, dbPath: path.join(rootDir, 'reader.sqlite3'), port: 0 });
  const address = await app.listen();
  return { app, base: `http://127.0.0.1:${address.port}` };
}

test('portable import entry paths reject traversal, absolute paths and unknown files', () => {
  assert.equal(validatePortableEntryPath('articles/note.md'), 'articles/note.md');
  assert.equal(validatePortableEntryPath('attachments/note/image.png'), 'attachments/note/image.png');
  assert.equal(validatePortableEntryPath('records/note.json'), 'records/note.json');
  assert.throws(() => validatePortableEntryPath('../reader.sqlite3'), /不安全路径/);
  assert.throws(() => validatePortableEntryPath('/tmp/private'), /不安全路径/);
  assert.throws(() => validatePortableEntryPath('articles\\note.md'), /不安全路径/);
  assert.throws(() => validatePortableEntryPath('reader.sqlite3'), /未知文件/);
  assert.throws(() => validatePortableEntryPath('scripts/run.sh'), /未知文件/);
});

test('Reader v3 Markdown ZIP previews, selectively imports and remains idempotent', async (t) => {
  const sourceRoot = await mkdtemp(path.join(os.tmpdir(), 'reader-portable-source-'));
  const targetRoot = await mkdtemp(path.join(os.tmpdir(), 'reader-portable-target-'));
  t.after(() => Promise.all([rm(sourceRoot, { recursive: true, force: true }), rm(targetRoot, { recursive: true, force: true })]));
  const source = await startReader(sourceRoot);
  const target = await startReader(targetRoot);
  t.after(() => Promise.all([source.app.close(), target.app.close()]));

  const filesDir = path.join(sourceRoot, 'data', 'files');
  await mkdir(filesDir, { recursive: true });
  const attachmentBytes = Buffer.from('portable attachment bytes');
  const sha256 = createHash('sha256').update(attachmentBytes).digest('hex');
  const storageName = `${sha256}.txt`;
  await writeFile(path.join(filesDir, storageName), attachmentBytes);
  const first = await source.app.database.createArticle({
    id: 'portable-one',
    url: 'https://portable.example/one',
    title: '可携带文章一',
    source: 'Reader 测试',
    author: '本地作者',
    type: 'article',
    language: 'zh',
    published_at: '2026-07-20T08:00:00.000Z',
    excerpt: '用于选择性导入的第一篇文章。',
    content: '附件将在下一步加入。',
    summary: '保留本地摘要',
    is_favorite: true,
    is_read: true,
    reading_progress: 0.7,
    collection_id: 'development',
    metadata: { custom: 'preserved' }
  });
  const attachment = await source.app.database.createAttachment({
    articleId: first.id,
    fileName: '证据.txt',
    storageName,
    mimeType: 'text/plain',
    byteSize: attachmentBytes.length,
    sha256
  });
  const originalContent = `# 正文\n\nportable 内容与 [本地附件](/api/attachments/${attachment.id}/content) 一起迁移。`;
  await source.app.database.updateArticle(first.id, { content: originalContent });
  await source.app.database.addTags(first.id, ['迁移', '长期资料']);
  await source.app.database.createHighlight({ articleId: first.id, quote: 'portable 内容', note: '保留这条批注', color: 'green', startOffset: 6, endOffset: 17 });
  const second = await source.app.database.createArticle({
    id: 'portable-two',
    url: 'https://portable.example/two',
    title: '可携带文章二',
    source: 'Reader 测试',
    content: '第二篇只在用户明确选择后导入。'
  });

  const exported = await fetch(`${source.base}/api/exports/markdown`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ ids: [first.id, second.id], include_attachments: true })
  });
  assert.equal(exported.status, 200);
  const archive = Buffer.from(await exported.arrayBuffer());

  const preview = await json(`${target.base}/api/imports/markdown/preview`, {
    method: 'POST', headers: { 'content-type': 'application/zip' }, body: archive
  });
  assert.equal(preview.response.status, 201);
  assert.equal(preview.body.preview.formatVersion, 3);
  assert.equal(preview.body.preview.compatibilityMode, false);
  assert.deepEqual(preview.body.preview.counts, { articles: 2, highlights: 1, attachments: 1 });
  assert.equal(preview.body.preview.articles.every((article) => article.selectable), true);
  assert.doesNotMatch(JSON.stringify(preview.body), new RegExp(targetRoot.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')));

  const firstImport = await json(`${target.base}/api/imports/markdown/${preview.body.preview.id}`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ article_ids: [first.id], collection_id: 'notes' })
  });
  assert.deepEqual({ imported: firstImport.body.result.imported, skipped: firstImport.body.result.skipped, failed: firstImport.body.result.failed }, { imported: 1, skipped: 0, failed: 0 });
  const imported = await target.app.database.getArticle(first.id);
  assert.equal(imported.collection_id, 'notes');
  assert.equal(imported.url, 'https://portable.example/one');
  assert.equal(imported.summary, '保留本地摘要');
  assert.equal(imported.is_favorite, true);
  assert.equal(imported.is_read, true);
  assert.equal(imported.reading_progress, 0.7);
  assert.equal(imported.metadata.custom, 'preserved');
  assert.equal(imported.metadata.portableImport.formatVersion, 3);
  assert.deepEqual(imported.tags.sort(), ['迁移', '长期资料'].sort());
  assert.equal(imported.attachments.length, 1);
  assert.equal(imported.content, originalContent.replace(attachment.id, imported.attachments[0].id));
  assert.deepEqual(await readFile(path.join(targetRoot, 'data', 'files', `${sha256}.txt`)), attachmentBytes);
  const importedHighlights = await target.app.database.listHighlights(first.id);
  assert.equal(importedHighlights.length, 1);
  assert.equal(importedHighlights[0].note, '保留这条批注');

  await target.app.database.createArticle({
    id: 'existing-second-url',
    url: 'https://portable.example/two',
    title: '本机已有相同原链接',
    content: '不应被导入包覆盖。'
  });
  const secondPreview = await json(`${target.base}/api/imports/markdown/preview`, { method: 'POST', body: archive });
  assert.equal(secondPreview.body.preview.articles.find((article) => article.id === first.id).conflict, 'duplicate_id');
  assert.equal(secondPreview.body.preview.articles.find((article) => article.id === second.id).conflict, 'duplicate_url');
  const mixedImport = await json(`${target.base}/api/imports/markdown/${secondPreview.body.preview.id}`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ article_ids: [first.id, second.id], collection_id: 'inbox' })
  });
  assert.deepEqual({ imported: mixedImport.body.result.imported, skipped: mixedImport.body.result.skipped, failed: mixedImport.body.result.failed }, { imported: 0, skipped: 2, failed: 0 });
  assert.equal(await target.app.database.getArticle(second.id), null);
  assert.equal((await target.app.database.getArticle('existing-second-url')).content, '不应被导入包覆盖。');

  const cancelPreview = await json(`${target.base}/api/imports/markdown/preview`, { method: 'POST', body: archive });
  const importDirectory = path.join(targetRoot, 'data', 'portable-imports', `import-${cancelPreview.body.preview.id}`);
  assert.equal((await stat(importDirectory)).mode & 0o777, 0o700);
  assert.equal((await stat(path.join(importDirectory, 'state.json'))).mode & 0o777, 0o600);
  assert.equal(await cleanupPortableImports(targetRoot, Date.now() + 2 * 24 * 60 * 60 * 1000), 1);
  const expired = await json(`${target.base}/api/imports/markdown/${cancelPreview.body.preview.id}`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ article_ids: [first.id], collection_id: 'inbox' })
  });
  assert.equal(expired.response.status, 404);
});

test('v2 compatibility mode rebuilds content and tampered attachments fail closed', async (t) => {
  const root = await mkdtemp(path.join(os.tmpdir(), 'reader-portable-v2-'));
  t.after(() => rm(root, { recursive: true, force: true }));
  const reader = await startReader(root);
  t.after(() => reader.app.close());
  const createdAt = '2026-07-20T08:00:00.000Z';
  const legacyMarkdown = `---\nreader_id: "portable-legacy"\ntitle: "旧版导入"\nsource: "旧版 Reader"\nauthor: "作者"\ntype: "article"\nlanguage: "zh"\ncollection: "研究"\noriginal_url: "https://portable.example/legacy"\npublished_at: ""\ncreated_at: "${createdAt}"\nexported_at: "${createdAt}"\ntags:\n  - "旧版"\n---\n\n# 旧版导入\n\n> 旧版摘要\n\n真正的旧版正文。\n\n## 高亮与批注\n\n### 高亮 1\n\n> 旧版正文\n\n批注：兼容保留\n\n_颜色：amber · 创建于 ${createdAt}_\n`;
  const legacyManifest = {
    format: 'reader-markdown-export',
    formatVersion: 2,
    appVersion: '0.18.1',
    createdAt,
    options: { includeAttachments: false },
    counts: { articles: 1, highlights: 1, attachments: 0, attachmentBytes: 0 },
    articles: [{
      id: 'portable-legacy',
      title: '旧版导入',
      path: 'articles/legacy.md',
      type: 'article',
      language: 'zh',
      originalURL: 'https://portable.example/legacy',
      collection: '研究',
      tags: ['旧版'],
      highlights: [{ id: 'legacy-highlight', quote: '旧版正文', note: '兼容保留', color: 'amber', startOffset: 3, endOffset: 7, createdAt, updatedAt: createdAt }],
      attachments: []
    }]
  };
  const legacyArchive = await zipBuffer([
    ['manifest.json', JSON.stringify(legacyManifest)],
    ['articles/legacy.md', legacyMarkdown]
  ]);
  const legacyPreview = await json(`${reader.base}/api/imports/markdown/preview`, { method: 'POST', body: legacyArchive });
  assert.equal(legacyPreview.response.status, 201);
  assert.equal(legacyPreview.body.preview.compatibilityMode, true);
  const legacyImport = await json(`${reader.base}/api/imports/markdown/${legacyPreview.body.preview.id}`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ article_ids: ['portable-legacy'], collection_id: 'notes' })
  });
  assert.equal(legacyImport.body.result.imported, 1);
  const legacy = await reader.app.database.getArticle('portable-legacy');
  assert.equal(legacy.content, '真正的旧版正文。');
  assert.equal(legacy.excerpt, '旧版摘要');
  assert.deepEqual(legacy.tags, ['旧版']);
  assert.equal((await reader.app.database.listHighlights(legacy.id))[0].note, '兼容保留');

  const attachmentBytes = Buffer.from('tampered bytes');
  const badManifest = {
    format: 'reader-markdown-export',
    formatVersion: 3,
    appVersion: '0.19.0',
    createdAt,
    options: { includeAttachments: true },
    counts: { articles: 1, highlights: 0, attachments: 1, attachmentBytes: attachmentBytes.length },
    articles: [{
      id: 'portable-tampered',
      title: '损坏附件',
      path: 'articles/tampered.md',
      recordPath: 'records/tampered.json',
      type: 'article',
      language: 'zh',
      originalURL: null,
      collection: null,
      tags: [],
      highlights: [],
      attachments: [{ id: 'tampered-attachment', path: 'attachments/tampered/evidence.txt', fileName: 'evidence.txt', mimeType: 'text/plain', byteSize: attachmentBytes.length, sha256: '0'.repeat(64) }]
    }]
  };
  const badRecord = {
    format: 'reader-article-record',
    formatVersion: 1,
    article: {
      id: 'portable-tampered',
      url: null,
      title: '损坏附件',
      source: '',
      author: '',
      type: 'article',
      language: 'zh',
      publishedAt: null,
      createdAt,
      updatedAt: createdAt,
      excerpt: '',
      content: '附件已损坏。',
      summary: '',
      readTimeMinutes: 1,
      isFavorite: false,
      isRead: false,
      readingProgress: 0,
      metadata: {}
    }
  };
  const badArchive = await zipBuffer([
    ['manifest.json', JSON.stringify(badManifest)],
    ['articles/tampered.md', '# 损坏附件'],
    ['records/tampered.json', JSON.stringify(badRecord)],
    ['attachments/tampered/evidence.txt', attachmentBytes]
  ]);
  const rejected = await json(`${reader.base}/api/imports/markdown/preview`, { method: 'POST', body: badArchive });
  assert.equal(rejected.response.status, 400);
  assert.match(rejected.body.error, /附件校验失败/);
  assert.doesNotMatch(JSON.stringify(rejected.body), new RegExp(root.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')));
  assert.equal(await reader.app.database.getArticle('portable-tampered'), null);
});
