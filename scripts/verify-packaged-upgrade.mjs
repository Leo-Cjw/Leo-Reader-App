import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { cp, mkdtemp, readFile, readdir, rm } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { launchPackagedReader, packagedReaderApp, projectRoot } from './lib/packaged-reader-qa.mjs';

const appPath = packagedReaderApp(process.argv[2]);
const fixtureRoot = path.resolve(process.argv[3] || path.join(projectRoot, 'tests', 'fixtures', 'upgrade-0.43'));
const manifest = JSON.parse(await readFile(path.join(fixtureRoot, 'manifest.json'), 'utf8'));
const packageMetadata = JSON.parse(await readFile(path.join(projectRoot, 'package.json'), 'utf8'));
const temporaryRoot = await mkdtemp(path.join(os.tmpdir(), 'reader-packaged-upgrade-'));
const readerRoot = path.join(temporaryRoot, 'reader');
const dataRoot = path.join(readerRoot, 'data');
const expected = manifest.expected;

function sha256(bytes) {
  return createHash('sha256').update(bytes).digest('hex');
}

function versionParts(version) {
  return String(version).split('.').map((part) => Number(part) || 0);
}

function compareVersions(left, right) {
  const a = versionParts(left);
  const b = versionParts(right);
  for (let index = 0; index < Math.max(a.length, b.length); index += 1) {
    if ((a[index] || 0) !== (b[index] || 0)) return (a[index] || 0) - (b[index] || 0);
  }
  return 0;
}

async function request(client, pathname, { method = 'GET', body } = {}) {
  const result = await client.value(`(async () => {
    const response = await fetch(${JSON.stringify(pathname)}, {
      method: ${JSON.stringify(method)},
      headers: ${body === undefined ? '{}' : "{ 'content-type': 'application/json' }"},
      body: ${body === undefined ? 'undefined' : JSON.stringify(JSON.stringify(body))}
    });
    const payload = await response.json();
    return { status: response.status, ok: response.ok, payload };
  })()`);
  assert.equal(result.ok, true, `${method} ${pathname} 失败（${result.status}）：${JSON.stringify(result.payload)}`);
  return result.payload;
}

async function verifyFixtureFiles() {
  async function listFiles(directory = fixtureRoot) {
    const files = [];
    for (const entry of await readdir(directory, { withFileTypes: true })) {
      const absolute = path.join(directory, entry.name);
      if (entry.isDirectory()) files.push(...await listFiles(absolute));
      else if (entry.isFile()) files.push(path.relative(fixtureRoot, absolute).split(path.sep).join('/'));
    }
    return files;
  }
  assert.deepEqual(
    (await listFiles()).filter((file) => file !== 'manifest.json').sort(),
    manifest.fixtureFiles.map((file) => file.path).sort(),
    '升级基准不能包含 manifest 未声明的文件'
  );
  for (const file of manifest.fixtureFiles) {
    const bytes = await readFile(path.join(fixtureRoot, file.path));
    assert.equal(bytes.length, file.byteSize, `升级基准文件大小变化：${file.path}`);
    assert.equal(sha256(bytes), file.sha256, `升级基准文件哈希变化：${file.path}`);
  }
}

async function verifyPreservedState(client, { afterRestart = false } = {}) {
  const health = await request(client, '/api/health');
  assert.equal(health.version, packageMetadata.version);
  assert.equal(health.schemaVersion, 12);
  assert.equal(health.background.importUserPaused, true);
  assert.equal(health.background.importsPaused, true);

  const article = (await request(client, `/api/articles/${expected.article.id}`)).article;
  assert.equal(article.title, expected.article.title);
  assert.equal(article.excerpt, expected.article.excerpt);
  assert.equal(article.content, expected.article.content);
  assert.equal(article.collection_id, expected.article.collectionId);
  assert.deepEqual([...article.tags].sort(), afterRestart
    ? [...expected.article.tags, '0.44-write-check'].sort()
    : expected.article.tags);
  assert.equal(article.is_favorite, expected.article.isFavorite);
  assert.equal(article.is_read, expected.article.isRead);
  assert.equal(article.reading_progress, afterRestart ? 0.75 : expected.article.readingProgress);
  assert.equal(article.attachments.length, 1);
  assert.deepEqual({
    id: article.attachments[0].id,
    fileName: article.attachments[0].file_name,
    mimeType: article.attachments[0].mime_type,
    byteSize: article.attachments[0].byte_size,
    sha256: article.attachments[0].sha256
  }, {
    id: expected.attachment.id,
    fileName: expected.attachment.fileName,
    mimeType: expected.attachment.mimeType,
    byteSize: expected.attachment.byteSize,
    sha256: expected.attachment.sha256
  });

  const collections = (await request(client, '/api/collections')).collections;
  const parent = collections.find((collection) => collection.id === expected.collections.parent.id);
  const child = collections.find((collection) => collection.id === expected.collections.child.id);
  assert.deepEqual({ name: parent?.name, parentId: parent?.parent_id || null }, {
    name: expected.collections.parent.name,
    parentId: null
  });
  assert.deepEqual({ name: child?.name, parentId: child?.parent_id }, {
    name: expected.collections.child.name,
    parentId: expected.collections.child.parentId
  });

  const highlights = (await request(client, `/api/articles/${expected.article.id}/highlights`)).highlights;
  assert.deepEqual(highlights.map((highlight) => ({
    id: highlight.id,
    quote: highlight.quote,
    note: highlight.note,
    color: highlight.color,
    startOffset: highlight.start_offset,
    endOffset: highlight.end_offset
  })), [expected.highlight]);

  const revisions = (await request(client, `/api/articles/${expected.article.id}/revisions`)).revisions;
  assert.deepEqual(revisions.map((revision) => ({
    version: revision.version,
    title: revision.title
  })), expected.revisions.map(({ version, title }) => ({ version, title })));
  for (const revision of expected.revisions) {
    const detail = (await request(client, `/api/articles/${expected.article.id}/revisions/${revision.version}`)).revision;
    assert.equal(detail.content, revision.content);
  }

  const smartCollections = (await request(client, '/api/smart-collections')).smartCollections;
  const smartCollection = smartCollections.find((collection) => collection.id === expected.smartCollection.id);
  assert.deepEqual({
    name: smartCollection?.name,
    rule: smartCollection?.rule,
    articleCount: smartCollection?.article_count
  }, {
    name: expected.smartCollection.name,
    rule: expected.smartCollection.rule,
    articleCount: expected.smartCollection.articleCount
  });

  const importJob = (await request(client, `/api/import-jobs/${expected.importQueue.jobId}`)).job;
  assert.equal(importJob.status, expected.importQueue.jobStatus);
  assert.equal(importJob.payload.url, expected.importQueue.url);
  const notifications = (await request(client, '/api/settings/notifications')).settings;
  assert.equal(notifications.enabled, expected.notifications.enabled);
  assert.equal(notifications.sourceSyncEnabled, expected.notifications.sourceSyncEnabled);
  const semanticSearch = (await request(client, '/api/settings/semantic-search')).settings;
  assert.equal(semanticSearch.enabled, false);
  assert.equal(semanticSearch.model, 'embeddinggemma');
  assert.equal(semanticSearch.embeddedChunks, 0);
  assert.ok(semanticSearch.totalChunks > 0);
  const dataHealth = (await request(client, '/api/data-health', { method: 'POST' })).health;
  assert.equal(dataHealth.status, 'healthy');
  assert.equal(dataHealth.database.integrity, true);
  assert.equal(dataHealth.database.foreign_key_violations, 0);
  assert.equal(dataHealth.attachments.missing_files, 0);

  const attachmentBytes = await client.value(`fetch(${JSON.stringify(`/api/attachments/${expected.attachment.id}/content`)})
    .then((response) => {
      if (!response.ok) throw new Error('附件读取失败：' + response.status);
      return response.arrayBuffer();
    })
    .then((buffer) => Array.from(new Uint8Array(buffer)))`);
  assert.equal(sha256(Buffer.from(attachmentBytes)), expected.attachment.sha256);
}

let session;
try {
  assert.equal(manifest.format, 'reader-packaged-upgrade-fixture');
  assert.equal(manifest.formatVersion, 1);
  assert.ok(
    compareVersions(packageMetadata.version, manifest.createdBy.appVersion) > 0,
    `候选版本 ${packageMetadata.version} 必须高于升级基准 ${manifest.createdBy.appVersion}`
  );
  await verifyFixtureFiles();
  await cp(path.join(fixtureRoot, 'data'), dataRoot, { recursive: true });

  session = await launchPackagedReader({
    appPath,
    readerRoot,
    prefix: 'reader-packaged-upgrade-app-'
  });
  await verifyPreservedState(session.client);
  await request(session.client, `/api/articles/${expected.article.id}/tags`, {
    method: 'PATCH',
    body: { add: ['0.44-write-check'], remove: [] }
  });
  await request(session.client, `/api/articles/${expected.article.id}`, {
    method: 'PATCH',
    body: { reading_progress: 0.75 }
  });
  await session.close();
  session = null;

  session = await launchPackagedReader({
    appPath,
    readerRoot,
    prefix: 'reader-packaged-upgrade-restart-'
  });
  await verifyPreservedState(session.client, { afterRestart: true });
  await session.close();
  session = null;

  const databasePath = path.join(dataRoot, 'reader.sqlite3');
  const sqliteCheck = execFileSync('/usr/bin/sqlite3', [
    databasePath,
    'PRAGMA integrity_check; PRAGMA foreign_key_check;'
  ], { encoding: 'utf8' }).trim();
  assert.equal(sqliteCheck, 'ok');
  const attachmentPath = path.join(dataRoot, 'files', expected.attachment.storageName);
  assert.equal(sha256(await readFile(attachmentPath)), expected.attachment.sha256);

  console.log(`Reader ${packageMetadata.version} 最终包跨版本升级门禁通过`);
  console.log(`source=${manifest.createdBy.appVersion} schema v${manifest.createdBy.schemaVersion}`);
  console.log(`target=${packageMetadata.version} schema v12`);
  console.log('preserved=article, folders, tags, highlight, revisions, smart folder, pending import, settings, attachment');
  console.log('post-upgrade write and restart=true');
  console.log('semantic index=default-off, derived vectors=0');
  console.log('sqlite integrity=ok');
  console.log('attachment sha256=unchanged');
} finally {
  await session?.close().catch(() => {});
  await rm(temporaryRoot, { recursive: true, force: true });
}
