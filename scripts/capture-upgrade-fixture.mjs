import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { cp, mkdir, mkdtemp, readFile, readdir, rm, stat, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { launchPackagedReader, packagedReaderApp, projectRoot } from './lib/packaged-reader-qa.mjs';

const appPath = packagedReaderApp(process.argv[2]);
const fixtureRoot = path.resolve(process.argv[3] || path.join(projectRoot, 'tests', 'fixtures', 'upgrade-0.43'));
const sourceCommit = 'c829243c41aec2910dcd1f01809ed65db1ef9ec0';
const temporaryRoot = await mkdtemp(path.join(os.tmpdir(), 'reader-upgrade-fixture-'));
const readerRoot = path.join(temporaryRoot, 'reader');
const dataRoot = path.join(readerRoot, 'data');
const fixtureDataRoot = path.join(fixtureRoot, 'data');
const pngBase64 = 'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mNk+A8AAQUBAScY42YAAAAASUVORK5CYII=';

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

function sha256(bytes) {
  return createHash('sha256').update(bytes).digest('hex');
}

async function fileManifest(root, directory = root) {
  const files = [];
  for (const entry of await readdir(directory, { withFileTypes: true })) {
    const absolute = path.join(directory, entry.name);
    if (entry.isDirectory()) files.push(...await fileManifest(root, absolute));
    else if (entry.isFile()) {
      const bytes = await readFile(absolute);
      files.push({
        path: path.relative(root, absolute).split(path.sep).join('/'),
        byteSize: bytes.length,
        sha256: sha256(bytes)
      });
    }
  }
  return files.sort((left, right) => left.path.localeCompare(right.path));
}

let session;
try {
  session = await launchPackagedReader({
    appPath,
    readerRoot,
    prefix: 'reader-upgrade-fixture-app-'
  });
  const { client } = session;
  const health = await request(client, '/api/health');
  assert.equal(health.version, '0.43.0', '升级基准必须由 Reader 0.43.0 候选包创建');
  assert.equal(health.schemaVersion, 11);

  const parent = (await request(client, '/api/collections', {
    method: 'POST',
    body: { name: '升级验证资料' }
  })).collection;
  const child = (await request(client, '/api/collections', {
    method: 'POST',
    body: { name: '0.43 原始资料', parent_id: parent.id }
  })).collection;

  const originalContent = '# 跨版本升级基准\n\nReader 必须原样保留这段关键结论，以及全部本地关系与附件。';
  const updatedContent = `${originalContent}\n\n这是由 0.43 最终候选包写入的第二版正文。`;
  const article = (await request(client, '/api/articles', {
    method: 'POST',
    body: {
      mode: 'markdown',
      title: 'Reader 0.43 升级兼容基准',
      content: originalContent,
      excerpt: '用于验证 Reader 最终包跨版本升级的数据兼容性。',
      collection_id: child.id
    }
  })).article;
  const updated = (await request(client, `/api/articles/${article.id}`, {
    method: 'PATCH',
    body: {
      title: 'Reader 0.43 升级兼容基准（已编辑）',
      content: updatedContent,
      excerpt: '0.43 候选包创建、后续正式包必须无损保留。',
      is_favorite: true,
      is_read: true,
      reading_progress: 0.625
    }
  })).article;
  const tagged = (await request(client, `/api/articles/${article.id}/tags`, {
    method: 'POST',
    body: { tags: ['升级验证', 'local-first'] }
  })).article;

  const quote = 'Reader 必须原样保留这段关键结论';
  const startOffset = updatedContent.indexOf(quote);
  const highlight = (await request(client, `/api/articles/${article.id}/highlights`, {
    method: 'POST',
    body: {
      quote,
      note: '跨版本后必须保留的批注',
      color: 'green',
      start_offset: startOffset,
      end_offset: startOffset + quote.length
    }
  })).highlight;

  const upload = await client.value(`(async () => {
    const bytes = Uint8Array.from(atob(${JSON.stringify(pngBase64)}), (value) => value.charCodeAt(0));
    const response = await fetch(${JSON.stringify(`/api/articles/${article.id}/attachments`)}, {
      method: 'POST',
      headers: { 'content-type': 'image/png', 'x-reader-filename': encodeURIComponent('0.43-upgrade-evidence.png') },
      body: bytes
    });
    const payload = await response.json();
    return { status: response.status, ok: response.ok, payload };
  })()`);
  assert.equal(upload.ok, true, `附件写入失败（${upload.status}）：${JSON.stringify(upload.payload)}`);
  const attachment = upload.payload.attachment;

  const smartCollection = (await request(client, '/api/smart-collections', {
    method: 'POST',
    body: {
      name: '完整升级证据',
      rule: {
        match: 'all',
        tags: ['升级验证'],
        favorite: true,
        has_highlights: true,
        has_attachments: true
      }
    }
  })).smartCollection;
  assert.equal(smartCollection.article_count, 1);

  const notifications = (await request(client, '/api/settings/notifications', {
    method: 'PUT',
    body: { enabled: true, sourceSyncEnabled: true }
  })).settings;
  const paused = (await request(client, '/api/import-jobs/state', {
    method: 'PUT',
    body: { paused: true }
  })).background;
  const importURL = 'https://1.1.1.1/reader-upgrade-fixture';
  const importJob = (await request(client, '/api/import-jobs', {
    method: 'POST',
    body: {
      kind: 'url',
      url: importURL,
      collection_id: child.id
    }
  })).job;
  assert.equal(importJob.status, 'pending');

  const revisions = (await request(client, `/api/articles/${article.id}/revisions`)).revisions;
  assert.deepEqual(revisions.map((item) => item.version), [2, 1]);
  await session.close();
  session = null;

  const dbPath = path.join(dataRoot, 'reader.sqlite3');
  const sqliteCheck = execFileSync('/usr/bin/sqlite3', [dbPath, 'PRAGMA wal_checkpoint(TRUNCATE); VACUUM; PRAGMA integrity_check;'], {
    encoding: 'utf8'
  }).trim().split(/\r?\n/).at(-1);
  assert.equal(sqliteCheck, 'ok');
  await rm(`${dbPath}-shm`, { force: true });
  await rm(`${dbPath}-wal`, { force: true });
  await rm(fixtureRoot, { recursive: true, force: true });
  await mkdir(fixtureRoot, { recursive: true });
  await mkdir(fixtureDataRoot, { recursive: true });
  await cp(dbPath, path.join(fixtureDataRoot, 'reader.sqlite3'));
  await cp(path.join(dataRoot, 'settings.json'), path.join(fixtureDataRoot, 'settings.json'));
  await cp(path.join(dataRoot, 'files'), path.join(fixtureDataRoot, 'files'), { recursive: true });

  const manifest = {
    format: 'reader-packaged-upgrade-fixture',
    formatVersion: 1,
    createdBy: {
      appVersion: health.version,
      schemaVersion: health.schemaVersion,
      sourceCommit
    },
    expected: {
      article: {
        id: article.id,
        title: updated.title,
        excerpt: updated.excerpt,
        content: updated.content,
        collectionId: child.id,
        tags: [...tagged.tags].sort(),
        isFavorite: true,
        isRead: true,
        readingProgress: 0.625
      },
      collections: {
        parent: { id: parent.id, name: parent.name },
        child: { id: child.id, name: child.name, parentId: parent.id }
      },
      highlight: {
        id: highlight.id,
        quote: highlight.quote,
        note: highlight.note,
        color: highlight.color,
        startOffset,
        endOffset: startOffset + quote.length
      },
      attachment: {
        id: attachment.id,
        fileName: attachment.file_name,
        storageName: `${attachment.sha256}.png`,
        mimeType: attachment.mime_type,
        byteSize: attachment.byte_size,
        sha256: attachment.sha256
      },
      revisions: revisions.map((revision) => ({
        version: revision.version,
        title: revision.title,
        content: revision.version === 1 ? originalContent : updatedContent
      })),
      smartCollection: {
        id: smartCollection.id,
        name: smartCollection.name,
        rule: smartCollection.rule,
        articleCount: 1
      },
      importQueue: {
        paused: paused.importUserPaused,
        jobId: importJob.id,
        jobStatus: importJob.status,
        url: importURL
      },
      notifications: {
        enabled: notifications.enabled,
        sourceSyncEnabled: notifications.sourceSyncEnabled
      }
    }
  };
  manifest.fixtureFiles = await fileManifest(fixtureRoot);
  await writeFile(path.join(fixtureRoot, 'manifest.json'), `${JSON.stringify(manifest, null, 2)}\n`, { mode: 0o600 });

  const databaseInfo = await stat(path.join(fixtureDataRoot, 'reader.sqlite3'));
  console.log(`Reader ${health.version} 升级基准已冻结`);
  console.log(`fixture=${path.relative(projectRoot, fixtureRoot)}`);
  console.log(`database=${databaseInfo.size} bytes`);
  console.log(`article=${article.id}`);
  console.log(`attachment sha256=${attachment.sha256}`);
} finally {
  await session?.close().catch(() => {});
  await rm(temporaryRoot, { recursive: true, force: true });
}
