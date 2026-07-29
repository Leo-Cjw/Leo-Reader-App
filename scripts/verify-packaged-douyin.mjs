import assert from 'node:assert/strict';
import path from 'node:path';
import { launchPackagedReader, packagedReaderApp, waitFor } from './lib/packaged-reader-qa.mjs';

const appPath = packagedReaderApp(process.argv[2]);
const readerRoot = process.env.READER_DOUYIN_QA_ROOT
  ? path.resolve(process.env.READER_DOUYIN_QA_ROOT)
  : undefined;
const shareText = '1.02 复制打开抖音，看看【Kiven大汉堡的作品】别再瞎折腾，Obsidian更适合这类人！ AI ... https://v.douyin.com/S4IhgLtZs00/ :0pm e@O.Kj fOX:/ 04/29';
const awemeId = '7644608213127646518';
const articleId = `douyin-${awemeId}`;
const canonicalURL = `https://www.douyin.com/video/${awemeId}`;
const terminalStatuses = new Set(['completed', 'awaiting_user', 'failed', 'cancelled']);

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
  if (!allowFailure) {
    assert.equal(result.ok, true, `${method} ${pathname} 失败（${result.status}）：${JSON.stringify(result.payload)}`);
  }
  return result;
}

function assertPublicJob(job) {
  const serialized = JSON.stringify(job);
  assert.doesNotMatch(serialized, /cookie|set-cookie|signedurls?|mediaurls?|temppath|localmediapath|modelpath|storage_name/i);
  assert.equal(job.platform, 'douyin');
  assert.equal(job.payload.url, canonicalURL);
  assert.equal(job.payload.awemeId, awemeId);
}

let session;
try {
  session = await launchPackagedReader({
    appPath,
    readerRoot,
    prefix: 'reader-packaged-douyin-'
  });
  const queued = await request(session.client, '/api/import-jobs', {
    method: 'POST',
    body: { kind: 'url', input: shareText }
  });
  console.log('douyin.qa=queued');
  assert.equal(queued.status, 202);
  assertPublicJob(queued.payload.job);

  const terminal = await waitFor('真实抖音导入任务', async () => {
    const result = await request(session.client, `/api/import-jobs/${queued.payload.job.id}`);
    assertPublicJob(result.payload.job);
    return terminalStatuses.has(result.payload.job.status) ? result.payload.job : null;
  }, 240_000);
  console.log(`douyin.qa=terminal:${terminal.status}:${terminal.phase || ''}`);
  assert.notEqual(terminal.status, 'failed', `真实抖音导入失败：${terminal.error || '未知错误'}`);
  assert.notEqual(terminal.status, 'cancelled');

  const article = await waitFor('真实抖音离线文章', async () => {
    const result = await request(session.client, `/api/articles/${articleId}`, { allowFailure: true });
    return result.ok ? result.payload.article : null;
  }, 20_000);
  assert.equal(article.id, articleId);
  assert.equal(article.url, canonicalURL);
  assert.equal(article.type, 'douyin');
  assert.equal(article.source, '抖音');
  assert.equal(article.author, 'Kiven大汉堡');
  assert.match(article.title, /别再瞎折腾/);
  assert.ok(article.published_at, '应保存发布时间');
  assert.ok(Math.abs(Number(article.metadata.durationMs) - 344_000) < 2_000, '作品时长应为 05:44');
  assert.ok(['720p', '1080p'].includes(article.metadata.actualQuality), '实际画质应为 720p 或 1080p');

  const video = article.attachments.find((attachment) => attachment.mime_type === 'video/mp4');
  assert.ok(video, '应保存带声 MP4 视频附件');
  assert.ok(video.byte_size > 0 && video.byte_size <= 100 * 1024 * 1024, '视频应符合 100 MB 边界');
  const range = await session.client.value(`fetch(${JSON.stringify(video.url)}, {
    headers: { Range: 'bytes=0-31' }
  }).then(async (response) => ({
    status: response.status,
    contentRange: response.headers.get('content-range'),
    bytes: Array.from(new Uint8Array(await response.arrayBuffer()))
  }))`);
  assert.equal(range.status, 206);
  assert.match(range.contentRange || '', /^bytes 0-31\//);
  assert.equal(range.bytes.length, 32);

  let transcript = 'waiting-model';
  if (terminal.status === 'completed') {
    assert.equal(terminal.result_article_id, articleId);
    assert.match(article.content, /## 转写/);
    const search = await request(session.client, `/api/articles?q=${encodeURIComponent('笔记系统')}`);
    assert.ok(search.payload.articles.some((item) => item.id === articleId), '平台章节/字幕应进入全文索引');
    transcript = article.metadata.transcriptSource || 'platform';
  } else {
    assert.equal(terminal.status, 'awaiting_user');
    assert.equal(terminal.phase, 'waiting_model');
    assert.equal(terminal.action_required, 'install_transcription_model');
    assert.equal(article.metadata.importState, 'waiting-transcription');
  }

  console.log('Reader 真实抖音打包回归通过');
  console.log(`work=${awemeId}`);
  console.log(`author=${article.author}`);
  console.log(`published=${article.published_at}`);
  console.log(`durationMs=${article.metadata.durationMs}`);
  console.log(`quality=${article.metadata.actualQuality}`);
  console.log(`videoBytes=${video.byte_size}`);
  console.log(`offlineRange=${range.status}`);
  console.log(`transcript=${transcript}`);
  if (readerRoot) console.log(`readerRoot=${readerRoot}`);
} finally {
  await session?.close().catch(() => {});
}
