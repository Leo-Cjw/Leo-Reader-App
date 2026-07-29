import assert from 'node:assert/strict';
import { chmod, copyFile, mkdir, stat } from 'node:fs/promises';
import path from 'node:path';
import { DouyinImportService } from '../desktop/douyin-service.mjs';
import { TranscriptionService } from '../desktop/transcription-service.mjs';
import { ReaderDatabase } from '../src/server/db.mjs';

const awemeId = '7644608213127646518';
const sourceRoot = path.resolve(process.env.READER_DOUYIN_QA_ROOT || '');
const qaRoot = path.resolve(process.env.READER_TRANSCRIPTION_QA_ROOT || '');
const helperPath = path.resolve(
  process.env.READER_TRANSCRIPTION_HELPER
    || path.join(import.meta.dirname, '..', 'build', 'Reader Transcription Helper.app', 'Contents', 'MacOS', 'Reader Transcription Helper')
);

assert.notEqual(sourceRoot, path.resolve(''), '请用 READER_DOUYIN_QA_ROOT 指向真实抖音 QA 资料');
assert.notEqual(qaRoot, path.resolve(''), '请用 READER_TRANSCRIPTION_QA_ROOT 指向隔离的本地转写 QA 目录');
assert.notEqual(sourceRoot, qaRoot, '抖音导入资料与转写 QA 目录必须隔离');

const sourceDatabase = await new ReaderDatabase(path.join(sourceRoot, 'data', 'reader.sqlite3')).initialize();
const sourceArticle = await sourceDatabase.getArticle(`douyin-${awemeId}`);
assert.ok(sourceArticle, '真实抖音 QA 文章不存在');
const publicVideo = sourceArticle.attachments.find((attachment) => attachment.mime_type === 'video/mp4');
assert.ok(publicVideo, '真实抖音 QA 没有 MP4 附件');
const storedVideo = await sourceDatabase.getAttachment(publicVideo.id);
assert.ok(storedVideo?.storage_name, '真实抖音 QA 的 MP4 存储记录不存在');

const filesDir = path.join(qaRoot, 'data', 'files');
const stagingDir = path.join(qaRoot, 'data', 'imports');
await mkdir(filesDir, { recursive: true, mode: 0o700 });
const destination = path.join(filesDir, storedVideo.storage_name);
await copyFile(path.join(sourceRoot, 'data', 'files', storedVideo.storage_name), destination);
await chmod(destination, 0o600);
assert.equal((await stat(destination)).size, storedVideo.byte_size);

const database = await new ReaderDatabase(path.join(qaRoot, 'data', 'reader.sqlite3')).initialize();
const runId = Date.now();
const articleId = `qa-local-whisper-${runId}`;
let article = await database.createArticle({
  id: articleId,
  url: `https://www.douyin.com/video/${awemeId}?reader-qa=${runId}`,
  title: 'Reader 真实本地 Whisper QA',
  source: '抖音',
  author: sourceArticle.author,
  type: 'douyin',
  language: 'zh',
  content: '真实抖音媒体已离线保存，等待本地 Whisper 转写。',
  metadata: { importState: 'waiting-transcription', transcriptSource: null }
});
await database.createAttachment({
  articleId,
  fileName: storedVideo.file_name,
  storageName: storedVideo.storage_name,
  mimeType: storedVideo.mime_type,
  byteSize: storedVideo.byte_size,
  sha256: storedVideo.sha256
});
article = await database.getArticle(articleId);

const transcriptionService = new TranscriptionService({ rootDir: qaRoot, helperPath });
let modelStatus = await transcriptionService.status();
if (!modelStatus.installed) {
  assert.equal(
    process.env.READER_QA_DOWNLOAD_WHISPER,
    '1',
    '模型未安装；只有显式设置 READER_QA_DOWNLOAD_WHISPER=1 才允许下载固定模型'
  );
  console.log(`transcription.qa=model-download:${modelStatus.byteSize}`);
  modelStatus = await transcriptionService.downloadModel();
}
assert.equal(modelStatus.installed, true);

const progress = [];
const service = new DouyinImportService({
  BrowserWindow: class {},
  session: {},
  transcriptionService
});
const startedAt = Date.now();
const updated = await service.finishTranscription(
  article,
  { payload: {} },
  {
    database,
    paths: { filesDir, stagingDir },
    updateProgress: async (value) => {
      progress.push(value);
      if (value.progress >= 78) console.log(`transcription.qa=progress:${value.phase}:${value.progress}`);
    }
  }
);

assert.match(updated.content, /## 转写/);
assert.equal(updated.metadata.importState, 'ready');
assert.equal(updated.metadata.transcriptSource, 'local-whisper-small');
assert.ok(updated.metadata.transcriptSegments > 0, '真实 Whisper 必须产生非空分段');
const vtt = updated.attachments.find((attachment) => attachment.mime_type === 'text/vtt');
assert.ok(vtt && vtt.byte_size > 20, '真实 Whisper 必须生成 WebVTT 附件');
assert.equal(progress[0]?.progress, 78);
assert.equal(progress.at(-1)?.progress, 94);
assert.ok(progress.some((item) => item.progress > 78 && item.progress < 94), '任务必须显示 Helper 的实时进度');

const transcriptText = updated.content.split('## 转写', 2)[1] || '';
const searchTerm = transcriptText.match(/[\u3400-\u9fff]{3,}/u)?.[0]?.slice(0, 3);
assert.ok(searchTerm, '真实转写中应存在可验证的中文搜索词');
const fullText = await database.listArticles({ query: searchTerm });
assert.ok(fullText.some((item) => item.id === articleId), '真实转写必须进入全文索引');
const citations = await database.searchArticleChunks(searchTerm, { articleId, limit: 3 });
assert.ok(citations.some((item) => item.articleId === articleId), '真实转写必须进入本地 RAG 分块索引');

console.log('Reader 真实本地 Whisper 闭环回归通过');
console.log(`article=${articleId}`);
console.log(`segments=${updated.metadata.transcriptSegments}`);
console.log(`searchTerm=${searchTerm}`);
console.log(`vttBytes=${vtt.byte_size}`);
console.log(`durationSeconds=${Math.round((Date.now() - startedAt) / 1000)}`);
console.log(`qaRoot=${qaRoot}`);
