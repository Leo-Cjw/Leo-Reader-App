import assert from 'node:assert/strict';
import path from 'node:path';
import { extractDouyinAwemeId } from '../src/server/douyin.mjs';
import { launchPackagedReader, packagedReaderApp, waitFor } from './lib/packaged-reader-qa.mjs';

const appPath = packagedReaderApp(process.argv[2]);
const input = process.env.READER_DOUYIN_NOTE_INPUT || 'https://www.douyin.com/note/7601918621245662073';
const awemeId = extractDouyinAwemeId(input);
const articleId = `douyin-${awemeId}`;
const readerRoot = process.env.READER_DOUYIN_NOTE_QA_ROOT
  ? path.resolve(process.env.READER_DOUYIN_NOTE_QA_ROOT)
  : undefined;
const terminalStatuses = new Set(['completed', 'awaiting_user', 'failed', 'cancelled']);

assert.ok(awemeId, '图文 QA 输入必须包含有效抖音作品 ID');

async function request(client, pathname, { method = 'GET', body, allowFailure = false } = {}) {
  const result = await client.value(`(async () => {
    const response = await fetch(${JSON.stringify(pathname)}, {
      method: ${JSON.stringify(method)},
      headers: ${body === undefined ? '{}' : "{ 'content-type': 'application/json' }"},
      body: ${body === undefined ? 'undefined' : JSON.stringify(JSON.stringify(body))}
    });
    let payload = null;
    try { payload = await response.json(); }
    catch { payload = { error: '响应不是 JSON' }; }
    return { status: response.status, ok: response.ok, payload };
  })()`);
  if (!allowFailure) assert.equal(result.ok, true, `${method} ${pathname} 失败：${JSON.stringify(result.payload)}`);
  return result;
}

let session;
try {
  session = await launchPackagedReader({ appPath, readerRoot, prefix: 'reader-packaged-douyin-note-' });
  const queued = await request(session.client, '/api/import-jobs', {
    method: 'POST',
    body: { kind: 'url', input }
  });
  assert.equal(queued.status, 202);
  const terminal = await waitFor('真实抖音图文任务', async () => {
    const result = await request(session.client, `/api/import-jobs/${queued.payload.job.id}`);
    return terminalStatuses.has(result.payload.job.status) ? result.payload.job : null;
  }, 240_000);
  assert.notEqual(terminal.status, 'failed', `真实抖音图文导入失败：${terminal.error || '未知错误'}`);
  assert.notEqual(terminal.status, 'cancelled');

  const article = await waitFor('真实抖音图文文章', async () => {
    const result = await request(session.client, `/api/articles/${articleId}`, { allowFailure: true });
    return result.ok ? result.payload.article : null;
  }, 20_000);
  const images = article.attachments.filter((attachment) => attachment.mime_type.startsWith('image/'));
  const audio = article.attachments.find((attachment) => attachment.mime_type.startsWith('audio/'));
  assert.equal(article.type, 'douyin');
  assert.equal(article.metadata.mediaKind, 'images');
  assert.ok(images.length >= 1 && images.length <= 30, '图文应离线保存 1–30 张图片');
  assert.equal(article.metadata.imageCount, images.length);
  assert.ok(audio && audio.byte_size > 0, '图文背景音乐应保存为独立音频附件');
  assert.equal(article.metadata.backgroundMusicSaved, true);

  console.log('Reader 真实抖音图文与背景音乐回归通过');
  console.log(`work=${awemeId}`);
  console.log(`images=${images.length}`);
  console.log(`audioMime=${audio.mime_type}`);
  console.log(`audioBytes=${audio.byte_size}`);
  console.log(`offline=${article.metadata.offlineResourceStatus}`);
  if (readerRoot) console.log(`readerRoot=${readerRoot}`);
} finally {
  await session?.close().catch(() => {});
}
