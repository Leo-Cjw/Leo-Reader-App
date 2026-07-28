import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, readdir, rm, stat } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { canonicalDouyinURL, extractDouyinAwemeId, extractDouyinURL, normalizeDouyinDetail, selectDouyinVideoCandidates } from '../src/server/douyin.mjs';
import { DouyinImportService, parsePlatformCaption } from '../desktop/douyin-service.mjs';
import { ReaderDatabase } from '../src/server/db.mjs';
import { createReaderServer } from '../src/server/server.mjs';

const referenceShareText = '1.02 复制打开抖音，看看【Kiven大汉堡的作品】别再瞎折腾，Obsidian更适合这类人！ AI ... https://v.douyin.com/S4IhgLtZs00/ :0pm e@O.Kj fOX:/ 04/29';
const awemeId = '7644608213127646518';

async function temporaryRoot(t, prefix) {
  const root = await mkdtemp(path.join(os.tmpdir(), prefix));
  t.after(() => rm(root, { recursive: true, force: true }));
  return root;
}

async function json(url, init) {
  const response = await fetch(url, {
    ...init,
    headers: { 'content-type': 'application/json', ...(init?.headers || {}) }
  });
  return { response, body: await response.json() };
}

test('Douyin share text extracts one trusted HTTPS URL and canonicalizes stable work ids', () => {
  assert.equal(extractDouyinURL(referenceShareText), 'https://v.douyin.com/S4IhgLtZs00/');
  assert.equal(extractDouyinAwemeId(`https://www.douyin.com/video/${awemeId}?previous_page=web_code_link`), awemeId);
  assert.equal(canonicalDouyinURL(awemeId), `https://www.douyin.com/video/${awemeId}`);
  assert.throws(() => extractDouyinURL(`${referenceShareText} https://www.douyin.com/video/${awemeId}`), /多个抖音链接/);
  assert.throws(() => extractDouyinURL(`https://example.com/video/${awemeId}`), /可信的抖音/);
  assert.throws(() => extractDouyinURL(`http://www.douyin.com/video/${awemeId}`), /HTTPS/);
});

test('Douyin detail normalization preserves metadata, 05:44 duration, 30-image cap and quality order', () => {
  const detail = normalizeDouyinDetail({
    aweme_detail: {
      aweme_id: awemeId,
      desc: '别再瞎折腾，Obsidian更适合这类人！',
      create_time: 1_801_089_840,
      author: { nickname: 'Kiven大汉堡', sec_uid: 'author-secretless-id' },
      text_extra: [{ hashtag_name: 'Obsidian' }],
      video: {
        duration: 344_026,
        width: 3840,
        height: 2160,
        cover: { url_list: ['https://cdn.example/cover.jpg'] },
        bit_rate: [
          { bit_rate: 9_000_000, play_addr: { height: 2160, width: 3840, url_list: ['https://cdn.example/4k.mp4'] } },
          { bit_rate: 4_000_000, play_addr: { height: 1080, width: 1920, url_list: ['https://cdn.example/1080.mp4'] } },
          { bit_rate: 2_000_000, play_addr: { height: 720, width: 1280, url_list: ['https://cdn.example/720.mp4'] } }
        ]
      },
      chapter_list: [{ start_time_ms: 0, end_time_ms: 10_000, title: '为什么别瞎折腾' }]
    }
  });
  assert.equal(detail.durationMs, 344_026);
  assert.equal(detail.author, 'Kiven大汉堡');
  assert.equal(detail.publishedAt, new Date(1_801_089_840_000).toISOString());
  assert.deepEqual(detail.topics, ['Obsidian']);
  assert.equal(detail.chapters[0].text, '为什么别瞎折腾');
  assert.equal(selectDouyinVideoCandidates(detail.videoCandidates)[0].height, 1080);

  const imageDetail = normalizeDouyinDetail({
    aweme_id: awemeId,
    desc: '长图文',
    images: Array.from({ length: 31 }, (_, index) => ({ width: 1080, height: 1440, url_list: [`https://cdn.example/${index}.jpg`] }))
  });
  assert.equal(imageDetail.images.length, 30);
  assert.equal(imageDetail.rawHasMoreImages, true);
});

test('platform WebVTT and JSON captions normalize to timestamped searchable segments', () => {
  assert.deepEqual(parsePlatformCaption('WEBVTT\n\n00:00:01.000 --> 00:00:03.250\n第一段字幕\n'), [
    { startMs: 1000, endMs: 3250, text: '第一段字幕' }
  ]);
  assert.deepEqual(parsePlatformCaption(JSON.stringify({
    utterances: [{ start_time: 2.5, end_time: 4, text: '第二段字幕' }]
  }), 'application/json'), [
    { startMs: 2500, endMs: 4000, text: '第二段字幕' }
  ]);
});

test('isolated Douyin windows use the Chromium branch without exposing the Electron product token', () => {
  let configuredUserAgent = '';
  const isolatedSession = {
    getUserAgent: () => 'Mozilla/5.0 Chrome/142.0.0.0 Electron/41.7.1 Reader/1.1.0',
    setPermissionRequestHandler() {}
  };
  class BrowserWindow {
    constructor(options) {
      assert.equal(options.webPreferences.session, isolatedSession);
      this.webContents = {
        setUserAgent(value) { configuredUserAgent = value; },
        setWindowOpenHandler() {},
        session: isolatedSession,
        on() {}
      };
    }
  }
  const service = new DouyinImportService({
    BrowserWindow,
    session: { fromPartition: () => isolatedSession }
  });
  service.createWindow();
  assert.equal(configuredUserAgent, 'Mozilla/5.0 Chrome/142.0.0.0');
});

test('desktop adapter refreshes expired 1080p details, falls back to playable 720p and atomically saves cover', async (t) => {
  const root = await temporaryRoot(t, 'reader-douyin-media-');
  const database = await new ReaderDatabase(path.join(root, 'reader.sqlite3')).initialize();
  const detailPayload = {
    aweme_detail: {
      aweme_id: awemeId,
      desc: '可离线播放的抖音视频',
      create_time: 1_801_089_840,
      author: { nickname: 'Kiven大汉堡' },
      chapter_list: [{ start_time_ms: 0, end_time_ms: 2_000, text: '平台章节' }],
      video: {
        duration: 344_026,
        width: 1920,
        height: 1080,
        cover: { url_list: ['https://cdn.example/cover.jpg'] },
        bit_rate: [
          { bit_rate: 4_000_000, video_codec: 'h264', play_addr: { height: 1080, width: 1920, url_list: ['https://cdn.example/1080.mp4'] } },
          { bit_rate: 2_000_000, video_codec: 'h264', play_addr: { height: 720, width: 1280, url_list: ['https://cdn.example/720.mp4'] } }
        ]
      }
    }
  };
  const mp4 = Buffer.alloc(128);
  mp4.write('ftyp', 4, 'ascii');
  mp4.write('avc1', 24, 'ascii');
  mp4.write('soun', 48, 'ascii');
  const calls = [];
  const service = new DouyinImportService({
    BrowserWindow: class {},
    session: {},
    fetchMedia: async (url) => {
      calls.push(url);
      if (url.endsWith('/1080.mp4')) throw new Error('媒体文件超过 100 MB 限制');
      if (url.endsWith('/720.mp4')) return { bytes: mp4, contentType: 'video/mp4' };
      return { bytes: Buffer.from([0xff, 0xd8, 0xff, 0xd9]), contentType: 'image/jpeg' };
    }
  });
  let captures = 0;
  service.captureDetail = async () => { captures += 1; return detailPayload; };
  const article = await service.importWork({
    id: 'job-media',
    payload: { url: canonicalDouyinURL(awemeId), awemeId, collectionId: 'inbox' }
  }, {
    database,
    paths: { stagingDir: path.join(root, 'imports'), filesDir: path.join(root, 'files') },
    updateProgress: async () => {},
    isCancelled: async () => false
  });
  assert.equal(captures, 2);
  assert.deepEqual(calls, [
    'https://cdn.example/1080.mp4',
    'https://cdn.example/720.mp4',
    'https://cdn.example/cover.jpg'
  ]);
  assert.equal(article.metadata.actualQuality, '720p');
  assert.equal(article.metadata.width, 1280);
  assert.equal(article.metadata.height, 720);
  assert.equal(article.metadata.transcriptSource, 'platform-chapters');
  assert.equal(article.attachments.filter((item) => item.mime_type === 'video/mp4').length, 1);
  assert.equal(article.attachments.filter((item) => item.mime_type === 'image/jpeg').length, 1);
  for (const attachment of article.attachments) {
    const stored = await database.getAttachment(attachment.id);
    assert.equal((await stat(path.join(root, 'files', stored.storage_name))).mode & 0o777, 0o600);
  }
  assert.deepEqual(await readdir(path.join(root, 'imports')), []);
});

test('schema v13 import jobs expose resumable phases, awaiting-user actions and cancellation', async (t) => {
  const root = await temporaryRoot(t, 'reader-douyin-jobs-');
  const database = await new ReaderDatabase(path.join(root, 'reader.sqlite3')).initialize();
  const job = await database.createImportJob('url', { url: canonicalDouyinURL(awemeId), awemeId }, { platform: 'douyin', phase: 'parsing' });
  assert.equal(job.platform, 'douyin');
  assert.equal(job.progress, 0);
  await database.claimImportJob();
  await database.updateImportJobProgress(job.id, { phase: 'downloading', progress: 42 });
  const waiting = await database.awaitImportJob(job.id, { phase: 'waiting_model', actionRequired: 'install_transcription_model', error: '媒体已保存' });
  assert.equal(waiting.status, 'awaiting_user');
  assert.equal(waiting.action_required, 'install_transcription_model');
  const resumed = await database.actOnImportJob(job.id, 'skip_transcription');
  assert.equal(resumed.status, 'pending');
  assert.equal(resumed.payload.skipTranscription, true);
  const claimed = await database.claimImportJob();
  assert.equal(claimed.phase, 'saving');
  const cancelled = await database.actOnImportJob(job.id, 'cancel');
  assert.equal(cancelled.status, 'cancelled');
  assert.equal((await database.completeImportJob(job.id, 'ignored')).status, 'cancelled');
});

test('source server rejects Douyin explicitly while an injected desktop adapter queues canonical ids', async (t) => {
  const sourceRoot = await temporaryRoot(t, 'reader-douyin-source-');
  const source = await createReaderServer({ rootDir: sourceRoot, dbPath: path.join(sourceRoot, 'data', 'reader.sqlite3'), port: 0 });
  t.after(() => source.close());
  const sourceAddress = await source.listen();
  const unsupported = await json(`http://127.0.0.1:${sourceAddress.port}/api/import-jobs`, {
    method: 'POST',
    body: JSON.stringify({ kind: 'url', input: referenceShareText })
  });
  assert.equal(unsupported.response.status, 501);
  assert.match(unsupported.body.error, /仅在 Reader 桌面版/);

  const desktopRoot = await temporaryRoot(t, 'reader-douyin-desktop-');
  const fakeDouyin = {
    async prepareInput() { return { awemeId, canonicalURL: canonicalDouyinURL(awemeId) }; },
    async status() { return { available: true, authenticated: false }; },
    async login() { return { available: true, authenticated: true }; },
    async clearSession() { return { available: true, authenticated: false }; },
    async importWork(job, { database, updateProgress }) {
      await updateProgress({ phase: 'saving', progress: 80 });
      return await database.createArticle({
        id: `douyin-${job.payload.awemeId}`,
        url: job.payload.url,
        title: '别再瞎折腾，Obsidian更适合这类人！',
        author: 'Kiven大汉堡',
        source: '抖音',
        type: 'douyin',
        content: '## 转写\n\n可全文搜索的本地转写'
      });
    }
  };
  const desktop = await createReaderServer({
    rootDir: desktopRoot,
    dbPath: path.join(desktopRoot, 'data', 'reader.sqlite3'),
    port: 0,
    douyinService: fakeDouyin
  });
  t.after(() => desktop.close());
  const desktopAddress = await desktop.listen();
  const queued = await json(`http://127.0.0.1:${desktopAddress.port}/api/import-jobs`, {
    method: 'POST',
    body: JSON.stringify({ kind: 'url', input: referenceShareText })
  });
  assert.equal(queued.response.status, 202);
  assert.equal(queued.body.job.platform, 'douyin');
  assert.equal(queued.body.job.payload.url, canonicalDouyinURL(awemeId));
  assert.doesNotMatch(JSON.stringify(queued.body.job), /cookie|signed|localMediaPath/i);
  let completed;
  for (let attempt = 0; attempt < 40; attempt += 1) {
    completed = await desktop.database.getImportJob(queued.body.job.id);
    if (completed.status === 'completed') break;
    await new Promise((resolve) => setTimeout(resolve, 25));
  }
  assert.equal(completed.status, 'completed');
  assert.equal((await desktop.database.searchArticleChunks('全文搜索'))[0].articleId, `douyin-${awemeId}`);
});
