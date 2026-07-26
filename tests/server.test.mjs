import test from 'node:test';
import assert from 'node:assert/strict';
import http from 'node:http';
import { mkdir, mkdtemp, readFile, rm, stat, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { createCanvas } from '@napi-rs/canvas';
import yauzl from 'yauzl';
import { ReaderDatabase } from '../src/server/db.mjs';
import { createReaderServer } from '../src/server/server.mjs';
import { SCHEMA_VERSION } from '../src/server/schema.mjs';
import { APP_VERSION } from '../src/server/version.mjs';

async function json(url, init) {
  const response = await fetch(url, init);
  const body = await response.json();
  return { response, body };
}

async function rawJSON(url, { method = 'GET', headers = {}, body = '' } = {}) {
  return await new Promise((resolve, reject) => {
    const request = http.request(url, { method, headers }, (response) => {
      const chunks = [];
      response.on('data', (chunk) => chunks.push(chunk));
      response.on('error', reject);
      response.on('end', () => {
        try {
          resolve({ status: response.statusCode, body: JSON.parse(Buffer.concat(chunks).toString('utf8')) });
        } catch (error) { reject(error); }
      });
    });
    request.on('error', reject);
    request.end(body);
  });
}

async function readZipEntries(bytes) {
  return await new Promise((resolve, reject) => {
    yauzl.fromBuffer(Buffer.from(bytes), { lazyEntries: true }, (openError, zip) => {
      if (openError) return reject(openError);
      const entries = new Map();
      zip.on('error', reject);
      zip.on('end', () => resolve(entries));
      zip.on('entry', (entry) => {
        if (/\/$/.test(entry.fileName)) return zip.readEntry();
        zip.openReadStream(entry, (streamError, stream) => {
          if (streamError) return reject(streamError);
          const chunks = [];
          stream.on('data', (chunk) => chunks.push(chunk));
          stream.on('error', reject);
          stream.on('end', () => { entries.set(entry.fileName, Buffer.concat(chunks)); zip.readEntry(); });
        });
      });
      zip.readEntry();
    });
  });
}

test('HTTP API covers health, articles, updates, search and local AI', async (t) => {
  const dir = await mkdtemp(path.join(os.tmpdir(), 'reader-server-'));
  let app;
  t.after(async () => { await app?.close(); await rm(dir, { recursive: true, force: true }); });
  app = await createReaderServer({ rootDir: dir, dbPath: path.join(dir, 'reader.sqlite3'), port: 0 });
  const address = await app.listen();
  const base = `http://127.0.0.1:${address.port}`;
  assert.equal((await stat(path.join(dir, 'data'))).mode & 0o777, 0o700);

  const health = await json(`${base}/api/health`);
  assert.equal(health.response.status, 200);
  assert.equal(health.body.storage, 'sqlite');
  assert.equal(health.body.version, APP_VERSION);
  assert.equal(health.body.schemaVersion, SCHEMA_VERSION);
  assert.deepEqual(health.body.background, {
    suspended: false,
    online: true,
    lowBattery: false,
    powerConstrained: false,
    restoreLocked: false,
    importUserPaused: false,
    importsPaused: false,
    sourceSyncPaused: false,
    semanticSearchPaused: false,
    automaticBackupsPaused: false,
    importPauseReasons: [],
    sourceSyncPauseReasons: [],
    semanticSearchPauseReasons: [],
    automaticBackupPauseReasons: []
  });
  await app.setBackgroundWorkState({ online: false, lowBattery: true });
  const constrainedHealth = await json(`${base}/api/health`);
  assert.equal(constrainedHealth.body.background.importsPaused, false);
  assert.equal(constrainedHealth.body.background.sourceSyncPaused, true);
  assert.equal(constrainedHealth.body.background.semanticSearchPaused, true);
  assert.equal(constrainedHealth.body.background.automaticBackupsPaused, true);
  assert.deepEqual(constrainedHealth.body.background.sourceSyncPauseReasons, ['offline', 'low-battery']);
  assert.deepEqual(constrainedHealth.body.background.semanticSearchPauseReasons, ['low-battery']);
  assert.deepEqual(constrainedHealth.body.background.automaticBackupPauseReasons, ['low-battery']);
  await app.setBackgroundWorkState({ online: true, lowBattery: false });
  const packageMetadata = JSON.parse(await readFile(new URL('../package.json', import.meta.url), 'utf8'));
  assert.equal(APP_VERSION, '0.54.0');
  assert.equal(packageMetadata.version, APP_VERSION);

  const dataHealth = await json(`${base}/api/data-health`, { method: 'POST' });
  assert.equal(dataHealth.response.status, 200);
  assert.equal(dataHealth.body.health.status, 'healthy');
  assert.equal(dataHealth.body.health.database.migration_history_verified, true);
  assert.equal(dataHealth.body.health.checks.length, 6);
  assert.equal('path' in dataHealth.body.health.database, false);
  assert.doesNotMatch(JSON.stringify(dataHealth.body), new RegExp(dir.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')));
  const blockedFilesDir = path.join(dir, 'data', 'files');
  await mkdir(path.dirname(blockedFilesDir), { recursive: true });
  await writeFile(blockedFilesDir, 'not a directory');
  const failedDataHealth = await json(`${base}/api/data-health`, { method: 'POST' });
  assert.equal(failedDataHealth.response.status, 500);
  assert.deepEqual(failedDataHealth.body, { error: '无法完成资料库检查' });
  assert.doesNotMatch(JSON.stringify(failedDataHealth.body), new RegExp(dir.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')));
  await rm(blockedFilesDir);

  const created = await json(`${base}/api/articles`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ mode: 'markdown', title: '成熟产品测试', content: 'Reader 使用本地 SQLite 保存内容，并提供全文搜索、收藏和摘要功能。' }) });
  assert.equal(created.response.status, 201);
  assert.equal(created.body.article.title, '成熟产品测试');

  const patched = await json(`${base}/api/articles/${created.body.article.id}`, { method: 'PATCH', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ is_favorite: true, reading_progress: 0.5 }) });
  assert.equal(patched.body.article.is_favorite, true);

  const edited = await json(`${base}/api/articles/${created.body.article.id}`, { method: 'PATCH', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ title: '成熟产品测试 v2', content: '第二个可以恢复的内容版本。' }) });
  assert.equal(edited.body.article.revision_count, 2);
  const revisions = await json(`${base}/api/articles/${created.body.article.id}/revisions`);
  assert.deepEqual(revisions.body.revisions.map((item) => item.version), [2, 1]);
  const restored = await json(`${base}/api/articles/${created.body.article.id}/revisions/1/restore`, { method: 'POST' });
  assert.equal(restored.body.article.title, '成熟产品测试');
  assert.equal(restored.body.article.revision_count, 3);

  const editorCanvas = createCanvas(240, 140);
  const editorContext = editorCanvas.getContext('2d');
  editorContext.fillStyle = '#b96745'; editorContext.fillRect(0, 0, 240, 140);
  const editorImageBytes = editorCanvas.toBuffer('image/png');
  const editorImageUpload = await json(`${base}/api/articles/${created.body.article.id}/attachments`, { method: 'POST', headers: { 'content-type': 'image/png', 'x-reader-filename': encodeURIComponent('文章配图.png') }, body: editorImageBytes });
  assert.equal(editorImageUpload.response.status, 201);
  assert.equal(editorImageUpload.body.article.id, created.body.article.id);
  assert.equal(editorImageUpload.body.article.attachments.length, 1);
  const editorImage = editorImageUpload.body.attachment;
  assert.equal(Buffer.compare(Buffer.from(await (await fetch(`${base}${editorImage.url}`)).arrayBuffer()), editorImageBytes), 0);
  const editorImageDuplicate = await json(`${base}/api/articles/${created.body.article.id}/attachments`, { method: 'POST', headers: { 'content-type': 'image/png', 'x-reader-filename': encodeURIComponent('文章配图副本.png') }, body: editorImageBytes });
  assert.equal(editorImageDuplicate.response.status, 200);
  assert.equal(editorImageDuplicate.body.duplicate, true);
  const imageMarkdown = `\n\n![文章配图](${editorImage.url})`;
  const articleWithImage = await json(`${base}/api/articles/${created.body.article.id}`, { method: 'PATCH', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ content: `${restored.body.article.content}${imageMarkdown}` }) });
  assert.match(articleWithImage.body.article.content, /!\[文章配图\]\(\/api\/attachments\//);
  assert.equal(articleWithImage.body.article.revision_count, 4);
  const spoofedImage = await json(`${base}/api/articles/${created.body.article.id}/attachments`, { method: 'POST', headers: { 'content-type': 'image/png', 'x-reader-filename': encodeURIComponent('spoof.png') }, body: Buffer.from('not a png') });
  assert.equal(spoofedImage.response.status, 415);

  const search = await json(`${base}/api/articles?q=成熟`);
  assert.ok(search.body.articles.some((article) => article.id === created.body.article.id));
  assert.equal(search.body.total, 1);
  assert.equal(search.body.hasMore, false);
  assert.equal(search.body.nextCursor, null);
  assert.equal(Object.hasOwn(search.body.articles[0], 'content'), false);
  const articleDetail = await json(`${base}/api/articles/${created.body.article.id}`);
  assert.match(articleDetail.body.article.content, /Reader 使用本地 SQLite 保存内容/);
  const firstPage = await json(`${base}/api/articles?limit=2`);
  assert.equal(firstPage.body.articles.length, 2);
  assert.equal(firstPage.body.total, 4);
  assert.equal(firstPage.body.hasMore, true);
  const secondPage = await json(`${base}/api/articles?limit=2&cursor=${encodeURIComponent(firstPage.body.nextCursor)}`);
  assert.equal(secondPage.body.articles.length, 2);
  assert.ok(secondPage.body.articles.every((article) => !firstPage.body.articles.some((first) => first.id === article.id)));
  const invalidCursor = await json(`${base}/api/articles?cursor=not-a-cursor`);
  assert.equal(invalidCursor.response.status, 400);
  assert.deepEqual(invalidCursor.body, { error: '分页游标无效' });

  const summary = await json(`${base}/api/articles/${created.body.article.id}/ai/summary`, { method: 'POST' });
  assert.equal(summary.response.status, 200);
  assert.equal(summary.body.provider, 'local-extractive');
  assert.ok(summary.body.summary.length > 10);

  const stats = await json(`${base}/api/stats`);
  assert.equal(stats.body.stats.total, 4);
  assert.equal(stats.body.stats.favorites, 1);

  const aiStatus = await json(`${base}/api/ai/status`);
  assert.equal(aiStatus.body.remoteConfigured, false);
  assert.equal(aiStatus.body.capabilities.translate, false);
  assert.equal(aiStatus.body.capabilities.rag, true);
  assert.equal(aiStatus.body.index.pendingArticles, 0);
  assert.ok(aiStatus.body.index.chunkCount >= 4);
  const ragSearch = await json(`${base}/api/ai/search`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ query: 'SQLite 保存内容', scope: 'article', article_id: created.body.article.id }) });
  assert.equal(ragSearch.response.status, 200);
  assert.equal(ragSearch.body.citations[0].articleId, created.body.article.id);
  assert.match(ragSearch.body.citations[0].quote, /SQLite/);
  const ragChat = await json(`${base}/api/articles/${created.body.article.id}/ai/chat`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ prompt: '内容保存在哪里', scope: 'article' }) });
  assert.equal(ragChat.body.provider, 'local-rag');
  assert.equal(ragChat.body.scope, 'article');
  assert.ok(ragChat.body.citations.length > 0);
  assert.match(ragChat.body.answer, /\[1\]/);
  const libraryChat = await json(`${base}/api/articles/${created.body.article.id}/ai/chat`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ prompt: 'RSS 为什么更安静', scope: 'library' }) });
  assert.equal(libraryChat.body.scope, 'library');
  assert.ok(libraryChat.body.citations.some((citation) => citation.articleId === 'rss-quiet-web'));
  const unavailableTranslation = await json(`${base}/api/ai/translate`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ article_id: created.body.article.id, target_language: 'en' }) });
  assert.equal(unavailableTranslation.response.status, 503);
  const composed = await json(`${base}/api/ai/compose`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ article_ids: [created.body.article.id], format: 'brief', language: 'zh-CN', prompt: '只整理明确事实' }) });
  assert.equal(composed.response.status, 201);
  assert.equal(composed.body.article.metadata.aiProvenance.task, 'compose');
  assert.equal(composed.body.article.metadata.aiProvenance.provider, 'local-structured');
  assert.equal(composed.body.article.metadata.aiProvenance.sourceArticles[0].id, created.body.article.id);
  assert.ok(composed.body.article.tags.includes('二次创作'));
  assert.match(composed.body.article.content, new RegExp(created.body.article.id));

  const exportResponse = await fetch(`${base}/api/exports/markdown`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ ids: [created.body.article.id], include_attachments: false }) });
  assert.equal(exportResponse.status, 200);
  assert.equal(exportResponse.headers.get('content-type'), 'application/zip');
  assert.match(exportResponse.headers.get('content-disposition') || '', /Reader-Markdown/);
  const exportEntries = await readZipEntries(await exportResponse.arrayBuffer());
  const exportedArticleName = [...exportEntries.keys()].find((name) => name.startsWith('articles/') && name.endsWith('.md'));
  assert.ok(exportedArticleName);
  assert.match(exportEntries.get(exportedArticleName).toString('utf8'), /reader_id:/);
  const exportManifest = JSON.parse(exportEntries.get('manifest.json').toString('utf8'));
  assert.equal(exportManifest.appVersion, APP_VERSION);
  assert.equal(exportManifest.counts.articles, 1);
  assert.equal(exportManifest.options.includeAttachments, false);

  const parentFolder = await json(`${base}/api/collections`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ name: 'API 研究' }) });
  const childFolder = await json(`${base}/api/collections`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ name: '子主题', parent_id: parentFolder.body.collection.id }) });
  assert.equal(childFolder.body.collection.parent_id, parentFolder.body.collection.id);
  const renamedFolder = await json(`${base}/api/collections/${childFolder.body.collection.id}`, { method: 'PATCH', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ name: '子主题 v2' }) });
  assert.equal(renamedFolder.body.collection.name, '子主题 v2');
  const batch = await json(`${base}/api/articles/batch`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ ids: [created.body.article.id], collection_id: childFolder.body.collection.id, tags_add: ['批量 API'], is_read: true }) });
  assert.equal(batch.body.updated, 1);
  const filteredByTag = await json(`${base}/api/articles?tag=${encodeURIComponent('批量 API')}`);
  assert.equal(filteredByTag.body.articles[0].id, created.body.article.id);
  const tags = await json(`${base}/api/tags`);
  assert.equal(tags.body.tags.find((tag) => tag.name === '批量 API').article_count, 1);
  const archivedBatch = await json(`${base}/api/articles/batch`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ ids: [created.body.article.id], archived: true }) });
  assert.equal(archivedBatch.body.updated, 1);
  assert.equal((await json(`${base}/api/articles?view=archive`)).body.articles[0].id, created.body.article.id);
  await json(`${base}/api/articles/batch`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ ids: [created.body.article.id], archived: false }) });
  const deletedFolder = await json(`${base}/api/collections/${parentFolder.body.collection.id}?move_to=inbox`, { method: 'DELETE' });
  assert.equal(deletedFolder.body.deleted, true);
  assert.equal((await json(`${base}/api/articles/${created.body.article.id}`)).body.article.collection_id, 'inbox');

  const duplicateContent = 'Local-first 产品需要让内容和附件始终由用户掌控，并提供可验证导出、可逆整理与透明的数据来源。'.repeat(4);
  const duplicateA = await json(`${base}/api/articles`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ mode: 'markdown', title: '重复检测 A', content: duplicateContent }) });
  const duplicateB = await json(`${base}/api/articles`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ mode: 'markdown', title: '重复检测 B', content: duplicateContent }) });
  const duplicateGroups = await json(`${base}/api/duplicates`);
  const duplicateGroup = duplicateGroups.body.groups.find((group) => group.articles.some((article) => article.id === duplicateA.body.article.id));
  assert.ok(duplicateGroup);
  assert.equal(duplicateGroup.confidence, 'exact');
  const resolvedDuplicates = await json(`${base}/api/duplicates/resolve`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ keep_id: duplicateA.body.article.id, duplicate_ids: [duplicateB.body.article.id] }) });
  assert.equal(resolvedDuplicates.response.status, 200);
  assert.deepEqual(resolvedDuplicates.body.archivedIds, [duplicateB.body.article.id]);
  const archivedDuplicate = (await json(`${base}/api/articles/${duplicateB.body.article.id}`)).body.article;
  assert.equal(archivedDuplicate.archived, true);
  assert.equal(archivedDuplicate.metadata.mergedInto, duplicateA.body.article.id);

  await app.setBackgroundWorkState({ online: false });
  const source = await app.database.createSource({ kind: 'rss', title: 'Reader 测试订阅', url: 'https://example.com/feed.xml', syncIntervalMinutes: 60 });
  await app.database.updateSource(source.id, { next_fetch_at: '2099-01-01T00:00:00.000Z', last_status: 'ok' });
  const sources = await json(`${base}/api/sources`);
  assert.equal(sources.body.sources[0].sync_interval_minutes, 60);
  assert.equal(sources.body.sources[0].last_status, 'ok');
  const sourceUpdate = await json(`${base}/api/sources/${source.id}`, { method: 'PATCH', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ sync_interval_minutes: 360, enabled: false }) });
  assert.equal(sourceUpdate.body.source.sync_interval_minutes, 360);
  assert.equal(sourceUpdate.body.source.enabled, false);
  const opml = await fetch(`${base}/api/sources/opml`);
  assert.equal(opml.status, 200);
  assert.match(opml.headers.get('content-type') || '', /opml/);
  assert.match(await opml.text(), /Reader 测试订阅/);
  const malformedOPML = await json(`${base}/api/sources/opml`, { method: 'POST', headers: { 'content-type': 'text/x-opml' }, body: '<html></html>' });
  assert.equal(malformedOPML.response.status, 400);
  const sourceDelete = await json(`${base}/api/sources/${source.id}`, { method: 'DELETE' });
  assert.equal(sourceDelete.body.deleted, true);
  assert.equal((await json(`${base}/api/sources`)).body.sources.length, 0);
  await app.setBackgroundWorkState({ online: true });

  const initialBackups = await json(`${base}/api/backups`);
  assert.equal(initialBackups.body.automaticBackup.enabled, false);
  assert.equal(initialBackups.body.automaticBackup.retention, 3);
  const invalidAutomatic = await json(`${base}/api/settings/automatic-backups`, { method: 'PUT', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ enabled: 'true' }) });
  assert.equal(invalidAutomatic.response.status, 400);
  const enabledAutomatic = await json(`${base}/api/settings/automatic-backups`, { method: 'PUT', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ enabled: true }) });
  assert.equal(enabledAutomatic.response.status, 200);
  assert.equal(enabledAutomatic.body.automaticBackup.enabled, true);
  assert.ok(enabledAutomatic.body.automaticBackup.last_backup_at);
  const automaticList = await json(`${base}/api/backups`);
  assert.equal(automaticList.body.backups.filter((item) => item.automatic).length, 1);
  assert.match(automaticList.body.backups.find((item) => item.automatic).verified_at, /^\d{4}-\d{2}-\d{2}T/);
  const disabledAutomatic = await json(`${base}/api/settings/automatic-backups`, { method: 'PUT', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ enabled: false }) });
  assert.equal(disabledAutomatic.body.automaticBackup.enabled, false);
  assert.equal((await json(`${base}/api/backups`)).body.backups.filter((item) => item.automatic).length, 1);

  const backup = await json(`${base}/api/backups`, { method: 'POST' });
  assert.equal(backup.response.status, 201);
  assert.match(backup.body.backup.file_name, /\.readerbackup\.zip$/);
  assert.match(backup.body.backup.verified_at, /^\d{4}-\d{2}-\d{2}T/);
  const download = await fetch(`${base}/api/backups/${backup.body.backup.id}/download`, { method: 'HEAD' });
  assert.equal(download.status, 200);
  assert.equal(download.headers.get('content-type'), 'application/zip');

  const passphrase = 'server contract passphrase';
  const encryptedBackup = await json(`${base}/api/backups`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ encrypted: true, passphrase }) });
  assert.equal(encryptedBackup.response.status, 201);
  assert.equal(encryptedBackup.body.backup.encrypted, true);
  assert.match(encryptedBackup.body.backup.verified_at, /^\d{4}-\d{2}-\d{2}T/);
  assert.match(encryptedBackup.body.backup.file_name, /\.readerbackup\.enc$/);
  const encryptedDownload = await fetch(`${base}/api/backups/${encryptedBackup.body.backup.id}/download`);
  assert.equal(encryptedDownload.headers.get('content-type'), 'application/vnd.reader.backup+encrypted');
  const encryptedBytes = Buffer.from(await encryptedDownload.arrayBuffer());
  const wrongRestore = await json(`${base}/api/backups/restore`, { method: 'POST', headers: { 'content-type': 'application/octet-stream', 'x-reader-backup-passphrase': Buffer.from('wrong server passphrase').toString('base64') }, body: encryptedBytes });
  assert.equal(wrongRestore.response.status, 400);
  assert.match(wrongRestore.body.error, /口令错误/);
  const correctRestore = await json(`${base}/api/backups/restore`, { method: 'POST', headers: { 'content-type': 'application/octet-stream', 'x-reader-backup-passphrase': Buffer.from(passphrase).toString('base64') }, body: encryptedBytes });
  assert.equal(correctRestore.response.status, 202);
  assert.equal(correctRestore.body.pendingRestore.encrypted, true);
  const cancelledRestore = await json(`${base}/api/backups/restore`, { method: 'DELETE' });
  assert.equal(cancelledRestore.body.cancelled, true);
  const invalidRestore = await json(`${base}/api/backups/restore`, { method: 'POST', headers: { 'content-type': 'application/octet-stream' }, body: Buffer.from('not a Reader backup') });
  assert.equal(invalidRestore.response.status, 400);
});

test('loopback API rejects DNS rebinding and cross-site browser requests before any write', async (t) => {
  const dir = await mkdtemp(path.join(os.tmpdir(), 'reader-loopback-boundary-'));
  let app;
  t.after(async () => { await app?.close(); await rm(dir, { recursive: true, force: true }); });
  app = await createReaderServer({ rootDir: dir, dbPath: path.join(dir, 'reader.sqlite3'), port: 0 });
  const address = await app.listen();
  const authority = `127.0.0.1:${address.port}`;
  const base = `http://${authority}`;
  const payload = JSON.stringify({ mode: 'markdown', title: 'Cross-site write', content: 'This must never be saved.' });
  const initialTotal = (await app.database.stats()).total;

  const rebinding = await rawJSON(`${base}/api/health`, {
    headers: { host: 'reader.attacker.invalid' }
  });
  assert.equal(rebinding.status, 403);
  assert.match(rebinding.body.error, /本机来源/);

  const crossOrigin = await rawJSON(`${base}/api/articles`, {
    method: 'POST',
    headers: { host: authority, origin: 'https://attacker.invalid', 'content-type': 'application/json' },
    body: payload
  });
  assert.equal(crossOrigin.status, 403);
  assert.match(crossOrigin.body.error, /跨站/);

  const crossSite = await rawJSON(`${base}/api/articles`, {
    headers: { host: authority, 'sec-fetch-site': 'cross-site' }
  });
  assert.equal(crossSite.status, 403);
  assert.equal((await app.database.stats()).total, initialTotal);

  const trusted = await json(`${base}/api/articles`, {
    method: 'POST',
    headers: { origin: base, 'sec-fetch-site': 'same-origin', 'content-type': 'application/json' },
    body: JSON.stringify({ mode: 'markdown', title: 'Trusted local write', content: 'The exact Reader origin remains usable.' })
  });
  assert.equal(trusted.response.status, 201);
  assert.equal((await app.database.stats()).total, initialTotal + 1);
});

test('migration snapshots are listed without private paths and can be exported safely', async (t) => {
  const dir = await mkdtemp(path.join(os.tmpdir(), 'reader-migration-snapshot-api-'));
  let app;
  t.after(async () => { await app?.close(); await rm(dir, { recursive: true, force: true }); });
  const dbPath = path.join(dir, 'reader.sqlite3');
  const legacy = new ReaderDatabase(dbPath);
  await legacy.execute(`CREATE TABLE schema_migrations (version INTEGER PRIMARY KEY, applied_at TEXT NOT NULL);
  INSERT INTO schema_migrations(version,applied_at) VALUES (7,'2026-01-01');
  CREATE TABLE sources (
    id TEXT PRIMARY KEY, kind TEXT NOT NULL, title TEXT NOT NULL, url TEXT NOT NULL,
    enabled INTEGER NOT NULL DEFAULT 1, last_fetched_at TEXT, last_error TEXT,
    created_at TEXT NOT NULL, updated_at TEXT NOT NULL
  );
  INSERT INTO sources(id,kind,title,url,created_at,updated_at)
  VALUES ('legacy','rss','升级前订阅','https://example.com/feed.xml','2026-01-01','2026-01-01');`);

  app = await createReaderServer({ rootDir: dir, dbPath, port: 0 });
  const address = await app.listen();
  const base = `http://127.0.0.1:${address.port}`;

  const listed = await json(`${base}/api/migration-snapshots`);
  assert.equal(listed.response.status, 200);
  assert.equal(listed.body.snapshots.length, 1);
  const snapshot = listed.body.snapshots[0];
  assert.deepEqual(
    { from: snapshot.from_schema_version, to: snapshot.to_schema_version, privatePath: snapshot.path },
    { from: 7, to: 12, privatePath: undefined }
  );
  const download = await fetch(`${base}/api/migration-snapshots/${snapshot.id}/download`);
  assert.equal(download.status, 200);
  assert.equal(download.headers.get('content-type'), 'application/vnd.sqlite3');
  assert.match(download.headers.get('content-disposition') || '', /reader-before-schema-v7-to-v12/);
  assert.equal(Buffer.from(await download.arrayBuffer()).subarray(0, 16).toString(), 'SQLite format 3\u0000');
  assert.equal((await fetch(`${base}/api/migration-snapshots/00000000-0000-4000-8000-000000000000/download`)).status, 404);

  const missingRestore = await json(`${base}/api/migration-snapshots/00000000-0000-4000-8000-000000000000/restore`, { method: 'POST' });
  assert.equal(missingRestore.response.status, 404);
  const scheduled = await json(`${base}/api/migration-snapshots/${snapshot.id}/restore`, { method: 'POST' });
  assert.equal(scheduled.response.status, 202);
  assert.deepEqual(
    {
      kind: scheduled.body.pendingRestore.kind,
      snapshotId: scheduled.body.pendingRestore.snapshotId,
      from: scheduled.body.pendingRestore.fromSchemaVersion,
      to: scheduled.body.pendingRestore.toSchemaVersion,
      restartRequired: scheduled.body.restartRequired,
      privatePath: scheduled.body.pendingRestore.pendingDir,
      privateHash: scheduled.body.pendingRestore.databaseSha256
    },
    { kind: 'migration_snapshot', snapshotId: snapshot.id, from: 7, to: 12, restartRequired: true, privatePath: undefined, privateHash: undefined }
  );
  const safety = await json(`${base}/api/backups`);
  assert.equal(safety.body.pendingRestore.kind, 'migration_snapshot');
  assert.equal(safety.body.backups.length, 1);
  const blockedWrite = await json(`${base}/api/articles`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ mode: 'markdown', title: '不应写入', content: '恢复等待期间必须冻结写入。' }) });
  assert.equal(blockedWrite.response.status, 409);
  assert.match(blockedWrite.body.error, /写入和后台同步已暂停/);
  assert.equal((await json(`${base}/api/data-health`, { method: 'POST' })).response.status, 200);
  const cancelled = await json(`${base}/api/backups/restore`, { method: 'DELETE' });
  assert.equal(cancelled.body.cancelled, true);
  const resumedWrite = await json(`${base}/api/articles`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ mode: 'markdown', title: '取消后恢复写入', content: '取消恢复后资料库继续正常工作。' }) });
  assert.equal(resumedWrite.response.status, 201);
});

test('attachment upload runs through the durable queue and supports byte ranges', async (t) => {
  const dir = await mkdtemp(path.join(os.tmpdir(), 'reader-upload-'));
  let app;
  t.after(async () => { await app?.close(); await rm(dir, { recursive: true, force: true }); });
  app = await createReaderServer({ rootDir: dir, dbPath: path.join(dir, 'reader.sqlite3'), port: 0 });
  const address = await app.listen();
  const base = `http://127.0.0.1:${address.port}`;
  const content = Buffer.from('# Offline attachment\n\nThis file stays on the local device.');
  const upload = await json(`${base}/api/import-jobs/upload?collection=notes`, { method: 'POST', headers: { 'content-type': 'text/markdown', 'x-reader-filename': encodeURIComponent('Offline Notes.md') }, body: content });
  assert.equal(upload.response.status, 202);
  assert.equal(upload.body.job.status, 'pending');
  assert.equal(upload.body.job.payload.tempPath, undefined);

  let job = upload.body.job;
  const deadline = Date.now() + 5000;
  while (job.status !== 'completed' && job.status !== 'failed' && Date.now() < deadline) {
    await new Promise((resolve) => setTimeout(resolve, 80));
    job = (await json(`${base}/api/import-jobs/${job.id}`)).body.job;
  }
  assert.equal(job.status, 'completed', job.error || 'job did not complete');
  const article = (await json(`${base}/api/articles/${job.result_article_id}`)).body.article;
  assert.equal(article.type, 'markdown');
  assert.match(article.content, /Offline attachment/);
  assert.doesNotMatch(article.excerpt, /^#/);
  assert.equal(article.attachments.length, 1);

  const rangeResponse = await fetch(`${base}${article.attachments[0].url}`, { headers: { range: 'bytes=0-8' } });
  assert.equal(rangeResponse.status, 206);
  assert.equal(rangeResponse.headers.get('accept-ranges'), 'bytes');
  assert.equal(Buffer.from(await rangeResponse.arrayBuffer()).toString(), '# Offline');

  const rejected = await json(`${base}/api/import-jobs/upload`, { method: 'POST', headers: { 'content-type': 'application/octet-stream', 'x-reader-filename': encodeURIComponent('unsafe.app') }, body: Buffer.from('not an app') });
  assert.equal(rejected.response.status, 415);

  const canvas = createCanvas(1000, 600);
  const canvasContext = canvas.getContext('2d');
  canvasContext.fillStyle = '#2b3945'; canvasContext.fillRect(0, 0, 1000, 600);
  canvasContext.fillStyle = '#d18b5c'; canvasContext.fillRect(180, 110, 640, 380);
  const imageUpload = await json(`${base}/api/import-jobs/upload`, { method: 'POST', headers: { 'content-type': 'image/png', 'x-reader-filename': encodeURIComponent('Reader Cover.png') }, body: canvas.toBuffer('image/png') });
  let imageJob = imageUpload.body.job;
  const imageDeadline = Date.now() + 5000;
  while (imageJob.status !== 'completed' && imageJob.status !== 'failed' && Date.now() < imageDeadline) {
    await new Promise((resolve) => setTimeout(resolve, 80));
    imageJob = (await json(`${base}/api/import-jobs/${imageJob.id}`)).body.job;
  }
  assert.equal(imageJob.status, 'completed', imageJob.error || 'image job did not complete');
  const imageArticle = (await json(`${base}/api/articles/${imageJob.result_article_id}`)).body.article;
  assert.match(imageArticle.attachments[0].thumbnail_url, /\/thumbnail$/);
  const thumbnail = await fetch(`${base}${imageArticle.attachments[0].thumbnail_url}`);
  assert.equal(thumbnail.status, 200);
  assert.equal(thumbnail.headers.get('content-type'), 'image/webp');
  const thumbnailBytes = Buffer.from(await thumbnail.arrayBuffer());
  assert.equal(thumbnailBytes.subarray(0, 4).toString('ascii'), 'RIFF');
  assert.equal(thumbnailBytes.subarray(8, 12).toString('ascii'), 'WEBP');

  const imageExport = await fetch(`${base}/api/exports/markdown`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ ids: [imageArticle.id], include_attachments: true }) });
  assert.equal(imageExport.status, 200);
  const imageExportEntries = await readZipEntries(await imageExport.arrayBuffer());
  const exportedAttachmentName = [...imageExportEntries.keys()].find((name) => name.startsWith('attachments/') && name.endsWith('.png'));
  assert.ok(exportedAttachmentName);
  assert.deepEqual(imageExportEntries.get(exportedAttachmentName), canvas.toBuffer('image/png'));
  const exportedImageMarkdown = imageExportEntries.get([...imageExportEntries.keys()].find((name) => name.startsWith('articles/'))).toString('utf8');
  assert.match(exportedImageMarkdown, /\.\.\/attachments\//);
});

test('AI translation persists an editable local article with provenance', async (t) => {
  const dir = await mkdtemp(path.join(os.tmpdir(), 'reader-ai-route-'));
  let app;
  t.after(async () => { await app?.close(); await rm(dir, { recursive: true, force: true }); });
  const aiService = {
    status: () => ({ provider: 'configured', remoteConfigured: true, capabilities: { summary: true, chat: true, compose: true, translate: true } }),
    translate: async (_article, targetLanguage) => ({ provider: 'configured', model: 'contract-model', language: targetLanguage, title: 'Reader in English', excerpt: 'An editable translation.', content: '# Reader in English\n\nAll content remains locally editable.' }),
    compose: async () => { throw new Error('not used'); }, summarize: async () => { throw new Error('not used'); }, chat: async () => { throw new Error('not used'); }
  };
  app = await createReaderServer({ rootDir: dir, dbPath: path.join(dir, 'reader.sqlite3'), port: 0, aiService });
  const address = await app.listen();
  const base = `http://127.0.0.1:${address.port}`;
  const source = await json(`${base}/api/articles`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ mode: 'markdown', title: 'Reader 中文原稿', content: '所有资料都保存在本机。' }) });
  const translated = await json(`${base}/api/ai/translate`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ article_id: source.body.article.id, target_language: 'en' }) });
  assert.equal(translated.response.status, 201);
  assert.equal(translated.body.article.type, 'markdown');
  assert.equal(translated.body.article.language, 'en');
  assert.equal(translated.body.article.metadata.aiProvenance.task, 'translate');
  assert.equal(translated.body.article.metadata.aiProvenance.model, 'contract-model');
  assert.equal(translated.body.article.metadata.aiProvenance.sourceArticles[0].id, source.body.article.id);
  assert.ok(translated.body.article.tags.includes('翻译'));
  const edited = await json(`${base}/api/articles/${translated.body.article.id}`, { method: 'PATCH', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ content: `${translated.body.article.content}\n\nEdited locally.` }) });
  assert.equal(edited.body.article.revision_count, 2);
});
