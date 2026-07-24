import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, rm } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { ReaderDatabase } from '../src/server/db.mjs';
import { localizeImportedResources } from '../src/server/import-worker.mjs';

test('URL import finalization rewrites local images, preserves failures as links and keeps one baseline revision', async (t) => {
  const root = await mkdtemp(path.join(os.tmpdir(), 'reader-import-resources-'));
  t.after(() => rm(root, { recursive: true, force: true }));
  const filesDir = path.join(root, 'files');
  const db = await new ReaderDatabase(path.join(root, 'reader.sqlite3')).initialize();
  const imported = {
    title: 'Offline resource article',
    content: 'Lead paragraph.\n\n![本地图](__READER_LOCAL_IMAGE_0__)\n\n![失败图](__READER_LOCAL_IMAGE_1__)',
    metadata: {
      extractor: 'mozilla-readability-v1',
      leadImage: 'https://example.com/lead.png',
      inlineImageCount: 2,
      inlineImages: [
        { token: '__READER_LOCAL_IMAGE_0__', url: 'https://example.com/body.png', alt: '本地图' },
        { token: '__READER_LOCAL_IMAGE_1__', url: 'https://example.com/fail.png', alt: '失败图' }
      ]
    }
  };
  const article = await db.createArticle(imported);
  const png = Buffer.from([0x89,0x50,0x4e,0x47,0x0d,0x0a,0x1a,0x0a,1]);
  const fetchImage = async (url) => {
    if (url.endsWith('/fail.png')) throw new Error('image unavailable');
    return { bytes: Buffer.concat([png, Buffer.from(url)]), contentType: 'image/png', url };
  };
  const finalized = await localizeImportedResources(db, article, imported, { filesDir, fetchImage });
  const saved = await db.finalizeImportedArticle(article.id, finalized);
  assert.match(saved.content, /!\[本地图\]\(\/api\/attachments\//);
  assert.match(saved.content, /\[失败图 · 未离线保存\]\(<https:\/\/example\.com\/fail\.png>\)/);
  assert.doesNotMatch(saved.content, /__READER_LOCAL_IMAGE_/);
  assert.equal(saved.metadata.offlineResourceStatus, 'partial');
  assert.equal(saved.metadata.embeddedAttachmentIds.length, 1);
  assert.equal(typeof saved.metadata.leadAttachmentId, 'string');
  assert.equal(saved.attachments.length, 2);
  assert.equal(saved.revision_count, 1);
  const revision = await db.getArticleRevision(article.id, 1);
  assert.equal(revision.content, saved.content);
});
