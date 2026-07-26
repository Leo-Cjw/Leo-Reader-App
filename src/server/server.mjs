import http from 'node:http';
import path from 'node:path';
import { access, chmod, mkdir, readFile, stat } from 'node:fs/promises';
import { constants as fsConstants, createReadStream } from 'node:fs';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { listMigrationSnapshots, normalizeSmartCollectionRule, ReaderDatabase, resolveMigrationSnapshot } from './db.mjs';
import { assertPublicURL } from './importers.mjs';
import { AIService } from './ai.mjs';
import { AISettingsManager } from './ai-settings.mjs';
import { MacOSKeychainCredentialStore } from './credentials.mjs';
import { defaultSettingsPath, SettingsStore } from './settings.mjs';
import { attachStagedImage, MAX_EDITOR_IMAGE_BYTES, MAX_UPLOAD_BYTES, stageAttachment } from './attachments.mjs';
import { createImportWorker, processImportJob } from './import-worker.mjs';
import { applyPendingRestore, cancelPendingRestore, createBackup, getPendingRestore, listBackups, resolveBackup, scheduleMigrationSnapshotRestore, scheduleRestore } from './backup.mjs';
import { getAttachmentThumbnail } from './thumbnails.mjs';
import { createSourceScheduler, createSourceSyncService, normalizeSourceURL } from './source-sync.mjs';
import { SocialConnectorManager } from './social-connectors.mjs';
import { exportOPML, parseOPML } from './opml.mjs';
import { prepareMarkdownExport, streamMarkdownExport } from './export.mjs';
import { APP_VERSION } from './version.mjs';
import { inspectDataHealth } from './data-health.mjs';
import { cancelPortableImport, commitPortableImport, stagePortableImport } from './portable-import.mjs';
import { repairDerivedData } from './data-repair.mjs';
import { diagnosticErrorCategory, diagnosticRoute, LocalDiagnosticsStore } from './diagnostics.mjs';
import { SCHEMA_VERSION } from './schema.mjs';
import { createBackgroundWorkPolicy } from './background-work.mjs';
import { createSpotlightService } from './spotlight.mjs';
import { createSemanticSearchService } from './semantic-search.mjs';
import { createAutomaticBackupService } from './automatic-backups.mjs';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const DEFAULT_ROOT = path.resolve(__dirname, '../..');

class HTTPError extends Error {
  constructor(status, message, details) {
    super(message);
    this.status = status;
    this.details = details;
  }
}

function sendJSON(response, status, payload) {
  const body = JSON.stringify(payload);
  response.writeHead(status, {
    'content-type': 'application/json; charset=utf-8',
    'content-length': Buffer.byteLength(body),
    'cache-control': 'no-store',
    'x-content-type-options': 'nosniff',
    'referrer-policy': 'no-referrer'
  });
  response.end(body);
}

async function readJSON(request, maxBytes = 2 * 1024 * 1024) {
  const chunks = [];
  let total = 0;
  for await (const chunk of request) {
    total += chunk.length;
    if (total > maxBytes) throw new HTTPError(413, '请求内容过大');
    chunks.push(chunk);
  }
  if (!total) return {};
  try { return JSON.parse(Buffer.concat(chunks).toString('utf8')); }
  catch { throw new HTTPError(400, 'JSON 格式不正确'); }
}

async function readText(request, maxBytes = 2 * 1024 * 1024) {
  const chunks = [];
  let total = 0;
  for await (const chunk of request) {
    total += chunk.length;
    if (total > maxBytes) throw new HTTPError(413, '请求内容过大');
    chunks.push(chunk);
  }
  return Buffer.concat(chunks).toString('utf8');
}

function sourceInterval(value) {
  const interval = Number(value ?? 60);
  if (!Number.isInteger(interval) || interval < 15 || interval > 10080) throw new HTTPError(400, '同步间隔必须在 15 分钟到 7 天之间');
  return interval;
}

function requiredString(value, name, max = 20_000) {
  const result = String(value || '').trim();
  if (!result) throw new HTTPError(400, `${name}不能为空`);
  if (result.length > max) throw new HTTPError(400, `${name}长度超过限制`);
  return result;
}

const AI_LANGUAGES = new Set(['zh-CN', 'zh-TW', 'en', 'ja', 'ko', 'es', 'fr', 'de']);
const AI_FORMATS = new Set(['brief', 'outline', 'essay', 'social']);
const HIGHLIGHT_COLORS = new Set(['amber', 'green', 'blue', 'pink']);

function aiLanguage(value, fallback = 'zh-CN') {
  const language = String(value || fallback).trim();
  if (!AI_LANGUAGES.has(language)) throw new HTTPError(400, '不支持这个目标语言');
  return language;
}

function highlightColor(value) {
  const color = String(value || 'amber');
  if (!HIGHLIGHT_COLORS.has(color)) throw new HTTPError(400, '不支持这个高亮颜色');
  return color;
}

function highlightOffset(value, name) {
  const offset = Number(value);
  if (!Number.isSafeInteger(offset) || offset < 0 || offset > 10_000_000) throw new HTTPError(400, `${name}无效`);
  return offset;
}

function smartCollectionRule(value) {
  try { return normalizeSmartCollectionRule(value); }
  catch (error) { throw new HTTPError(400, error.message || '智能资料夹规则无效'); }
}

function sourceSnapshot(article) {
  return { id: article.id, title: article.title, source: article.source || '', url: article.url || null };
}

async function createAIDraft(database, result, provenance, input = {}) {
  const article = await database.createArticle({
    title: result.title,
    content: result.content,
    excerpt: result.excerpt || `由 Reader AI 基于 ${provenance.sourceArticles.length} 篇资料生成`,
    source: result.provider === 'local-structured' ? 'Reader 本地创作' : 'Reader AI',
    author: 'Reader AI',
    type: 'markdown',
    language: result.language || provenance.language || provenance.targetLanguage || 'zh-CN',
    collection_id: input.collectionId || 'notes',
    metadata: { aiProvenance: provenance }
  });
  await database.addTags(article.id, ['AI 生成', provenance.task === 'translate' ? '翻译' : '二次创作']);
  return await database.getArticle(article.id);
}

function decodeBase64SecretHeader(request, name) {
  const value = String(request.headers[name] || '');
  if (!value) return '';
  if (value.length > 2048 || !/^[A-Za-z0-9+/]*={0,2}$/.test(value)) throw new HTTPError(400, '备份口令编码无效');
  const decoded = Buffer.from(value, 'base64');
  if (decoded.toString('base64').replace(/=+$/, '') !== value.replace(/=+$/, '')) throw new HTTPError(400, '备份口令编码无效');
  return decoded.toString('utf8');
}

function publicImportJob(job) {
  if (!job) return job;
  const payload = { ...(job.payload || {}) };
  delete payload.tempPath;
  return { ...job, payload };
}

function publicPendingRestore(marker) {
  if (!marker) return null;
  const { pendingDir: _privatePath, databaseSha256: _privateHash, ...safe } = marker;
  return safe;
}

function assertTrustedLoopbackRequest(request, server, host, configuredPort) {
  if (host !== '127.0.0.1') return;
  const address = server.address();
  const activePort = address && typeof address === 'object' ? address.port : configuredPort;
  const authority = `127.0.0.1:${activePort}`;
  if (String(request.headers.host || '').toLowerCase() !== authority) {
    throw new HTTPError(403, '拒绝非 Reader 本机来源');
  }
  const origin = String(request.headers.origin || '');
  if (origin && origin !== `http://${authority}`) throw new HTTPError(403, '拒绝跨站请求');
  const fetchSite = String(request.headers['sec-fetch-site'] || '').toLowerCase();
  if (fetchSite && fetchSite !== 'same-origin' && fetchSite !== 'none') {
    throw new HTTPError(403, '拒绝跨站请求');
  }
}

function mimeType(filePath) {
  const extension = path.extname(filePath).toLowerCase();
  return ({ '.html': 'text/html; charset=utf-8', '.js': 'text/javascript; charset=utf-8', '.css': 'text/css; charset=utf-8', '.json': 'application/json; charset=utf-8', '.svg': 'image/svg+xml', '.png': 'image/png', '.ico': 'image/x-icon' })[extension] || 'application/octet-stream';
}

async function exists(filePath) {
  try { await access(filePath, fsConstants.R_OK); return true; }
  catch { return false; }
}

export async function createReaderServer({
  rootDir = DEFAULT_ROOT,
  webRoot = process.env.READER_WEB_ROOT || path.join(DEFAULT_ROOT, 'dist'),
  dbPath = process.env.READER_DB_PATH || path.join(rootDir, 'data', 'reader.sqlite3'),
  host = process.env.READER_HOST || '127.0.0.1',
  port = Number(process.env.READER_PORT || 4312),
  aiService = null,
  settingsStore = null,
  credentialStore = null,
  aiEnvironment = process.env,
  socialConnectors = null,
  socialEnvironment = process.env,
  diagnosticsStore = null,
  onImportBatchFinished = null,
  onSourceSyncBatchFinished = null,
  spotlightHelperPath = '',
  spotlightService = null,
  embeddingClient = null,
  semanticSearchService = null
} = {}) {
  const dataRoot = path.join(rootDir, 'data');
  await mkdir(dataRoot, { recursive: true, mode: 0o700 });
  await chmod(dataRoot, 0o700);
  const diagnostics = diagnosticsStore || await new LocalDiagnosticsStore(rootDir).initialize();
  let startupPhase = 'restore';
  let appliedRestore;
  let database;
  try {
    appliedRestore = await applyPendingRestore({ rootDir, dbPath });
    startupPhase = 'database';
    database = await new ReaderDatabase(dbPath).initialize();
  } catch (error) {
    await diagnostics.record('startup_failed', { phase: startupPhase, category: diagnosticErrorCategory(error) });
    await diagnostics.flush();
    throw error;
  }
  await diagnostics.record('app_started', { version: APP_VERSION, schemaVersion: SCHEMA_VERSION, restored: Boolean(appliedRestore) });
  const runtimeAIService = aiService || new AIService({ endpoint: '', apiKey: '' });
  const runtimeSettingsStore = settingsStore || await new SettingsStore(defaultSettingsPath(rootDir)).initialize();
  const runtimeSemanticSearch = semanticSearchService || createSemanticSearchService({
    database,
    settingsStore: runtimeSettingsStore,
    ...(embeddingClient ? { client: embeddingClient } : {})
  });
  await runtimeSemanticSearch.start();
  const runtimeSpotlight = spotlightService || createSpotlightService({
    database,
    settingsStore: runtimeSettingsStore,
    helperPath: spotlightHelperPath
  });
  await runtimeSpotlight.start();
  let aiSettingsManager = null;
  if (!aiService) {
    const runtimeCredentialStore = credentialStore || new MacOSKeychainCredentialStore();
    aiSettingsManager = await new AISettingsManager({ settingsStore: runtimeSettingsStore, credentialStore: runtimeCredentialStore, aiService: runtimeAIService, environment: aiEnvironment }).initialize();
  }
  const staticDir = path.resolve(webRoot);
  const stagingDir = path.join(rootDir, 'data', 'imports');
  const filesDir = path.join(rootDir, 'data', 'files');
  const thumbnailsDir = path.join(rootDir, 'data', 'thumbnails');
  const runtimeSocialConnectors = socialConnectors || new SocialConnectorManager({
    xCredentialStore: new MacOSKeychainCredentialStore({
      service: 'com.reader.local-first.social',
      account: 'x-bearer-token',
      label: 'Reader X Bearer Token',
      secretName: 'X Bearer Token'
    }),
    environment: socialEnvironment
  });
  const importQueueSettings = runtimeSettingsStore.getImportQueue();
  const importWorker = createImportWorker(database, { stagingDir, filesDir }, {
    initiallyPaused: importQueueSettings.paused,
    onBatchFinished: (summary) => {
      if (!runtimeSettingsStore.getNotifications().enabled || typeof onImportBatchFinished !== 'function') return;
      return onImportBatchFinished(summary);
    }
  });
  const sourceSync = createSourceSyncService(database, {
    socialConnectors: runtimeSocialConnectors,
    paths: { stagingDir, filesDir }
  });
  const sourceScheduler = createSourceScheduler(database, sourceSync, {
    onBatchFinished: (summary) => {
      if (!runtimeSettingsStore.getNotifications().sourceSyncEnabled || typeof onSourceSyncBatchFinished !== 'function') return;
      return onSourceSyncBatchFinished(summary);
    }
  });
  sourceScheduler.start();
  const automaticBackups = createAutomaticBackupService({
    database, rootDir, settingsStore: runtimeSettingsStore, diagnostics, appVersion: APP_VERSION
  });
  const backgroundWork = createBackgroundWorkPolicy(importWorker, sourceScheduler, runtimeSemanticSearch, automaticBackups);
  if (importQueueSettings.paused) await backgroundWork.update({ importUserPaused: true });
  automaticBackups.start();
  let dataRepairPromise = null;
  let restoreWriteLocked = false;
  let diagnosticsStopped = false;
  const ragIndexStatus = async () => {
    const lexical = await database.getChunkIndexStatus();
    const semantic = await runtimeSemanticSearch.status();
    return {
      ...lexical,
      mode: semantic.enabled ? 'local-hybrid' : 'local-lexical',
      semantic
    };
  };

  const server = http.createServer(async (request, response) => {
    let requestPath = '/';
    const requestMethod = request.method || 'GET';
    try {
      assertTrustedLoopbackRequest(request, server, host, port);
      const url = new URL(request.url || '/', `http://${request.headers.host || `${host}:${port}`}`);
      const method = requestMethod;
      const pathname = decodeURIComponent(url.pathname);
      requestPath = pathname;
      const restoreCancellation = pathname === '/api/backups/restore' && method === 'DELETE';
      const readOnlyDataHealth = pathname === '/api/data-health' && method === 'POST';
      if (restoreWriteLocked && !['GET', 'HEAD'].includes(method) && !restoreCancellation && !readOnlyDataHealth) {
        throw new HTTPError(409, '恢复任务等待重启；为保护安全备份，资料库写入和后台同步已暂停');
      }

      if (pathname === '/api/health' && method === 'GET') {
        return sendJSON(response, 200, {
          ok: true,
          version: APP_VERSION,
          schemaVersion: SCHEMA_VERSION,
          storage: 'sqlite',
          restoredOnStart: Boolean(appliedRestore),
          background: backgroundWork.snapshot(),
          time: new Date().toISOString()
        });
      }

      if (pathname === '/api/stats' && method === 'GET') {
        return sendJSON(response, 200, { stats: await database.stats() });
      }

      if (pathname === '/api/articles' && method === 'GET') {
        try {
          const page = await database.listArticlePage({
            view: url.searchParams.get('view') || 'inbox', query: url.searchParams.get('q') || '',
            collectionId: url.searchParams.get('collection') || null, types: url.searchParams.get('types') || '',
            smartCollectionId: url.searchParams.get('smart') || null,
            tag: url.searchParams.get('tag') || '', mediaOnly: url.searchParams.get('media') === '1',
            limit: url.searchParams.get('limit') || 100, cursor: url.searchParams.get('cursor') || null,
            includeContent: false
          });
          return sendJSON(response, 200, page);
        } catch (error) {
          if (error instanceof TypeError && /游标/.test(error.message || '')) throw new HTTPError(400, error.message);
          throw error;
        }
      }

      if (pathname === '/api/articles' && method === 'POST') {
        const body = await readJSON(request);
        let article;
        if (body.mode === 'url') {
          const publicURL = (await assertPublicURL(requiredString(body.url, 'URL', 2048))).toString();
          article = await processImportJob(database, { kind: 'url', payload: { url: publicURL, collectionId: body.collection_id || 'inbox' } }, { stagingDir, filesDir });
        } else if (body.mode === 'markdown') {
          const content = requiredString(body.content, '正文', 500_000);
          article = await database.createArticle({ title: requiredString(body.title, '标题', 500), content, excerpt: body.excerpt || content.slice(0, 180), source: '我的笔记', author: body.author || '我', type: 'markdown', language: body.language || 'zh', collection_id: body.collection_id || 'notes' });
        } else {
          throw new HTTPError(400, 'mode 必须是 url 或 markdown');
        }
        return sendJSON(response, 201, { article });
      }

      if (pathname === '/api/exports/markdown' && method === 'POST') {
        const body = await readJSON(request);
        const prepared = await prepareMarkdownExport({ database, filesDir, ids: body.ids, includeAttachments: body.include_attachments !== false });
        return await streamMarkdownExport(response, prepared);
      }

      if (pathname === '/api/imports/markdown/preview' && method === 'POST') {
        const preview = await stagePortableImport({ request, database, rootDir });
        return sendJSON(response, 201, { preview });
      }

      const portableImportMatch = pathname.match(/^\/api\/imports\/markdown\/([0-9a-f-]{36})$/i);
      if (portableImportMatch && method === 'POST') {
        const body = await readJSON(request);
        const result = await commitPortableImport({
          database,
          rootDir,
          filesDir,
          id: portableImportMatch[1],
          articleIds: body.article_ids,
          collectionId: body.collection_id || 'inbox'
        });
        return sendJSON(response, 200, { result });
      }
      if (portableImportMatch && method === 'DELETE') {
        return sendJSON(response, 200, { cancelled: await cancelPortableImport(rootDir, portableImportMatch[1]) });
      }

      if (pathname === '/api/duplicates' && method === 'GET') {
        return sendJSON(response, 200, { groups: await database.findDuplicateGroups(url.searchParams.get('limit') || 100) });
      }

      if (pathname === '/api/duplicates/resolve' && method === 'POST') {
        const body = await readJSON(request);
        if (!Array.isArray(body.duplicate_ids)) throw new HTTPError(400, 'duplicate_ids 必须是数组');
        try { return sendJSON(response, 200, await database.resolveDuplicates({ keepId: requiredString(body.keep_id, '保留内容 ID', 200), duplicateIds: body.duplicate_ids })); }
        catch (error) { throw new HTTPError(400, error.message || '重复内容合并失败'); }
      }

      if (pathname === '/api/import-jobs' && method === 'GET') {
        return sendJSON(response, 200, { jobs: (await database.listImportJobs(url.searchParams.get('limit') || 40)).map(publicImportJob) });
      }

      if (pathname === '/api/import-jobs/state' && method === 'PUT') {
        const body = await readJSON(request);
        if (typeof body.paused !== 'boolean') throw new HTTPError(400, 'paused 必须是布尔值');
        const previous = backgroundWork.snapshot().importUserPaused;
        try {
          await runtimeSettingsStore.saveImportQueue(body.paused);
          const state = await backgroundWork.update({ importUserPaused: body.paused });
          return sendJSON(response, 200, { background: state });
        } catch (error) {
          await runtimeSettingsStore.saveImportQueue(previous).catch(() => {});
          await backgroundWork.update({ importUserPaused: previous }).catch(() => {});
          throw error;
        }
      }

      if (pathname === '/api/articles/batch' && method === 'POST') {
        const body = await readJSON(request);
        if (!Array.isArray(body.ids) || !body.ids.length) throw new HTTPError(400, '请选择至少一条内容');
        if (body.ids.length > 500) throw new HTTPError(400, '一次最多整理 500 条内容');
        try {
          const result = await database.batchUpdateArticles(body.ids, {
            ...('collection_id' in body ? { collection_id: body.collection_id } : {}),
            ...('is_favorite' in body ? { is_favorite: body.is_favorite } : {}),
            ...('is_read' in body ? { is_read: body.is_read } : {}),
            ...('archived' in body ? { archived: body.archived } : {}),
            tags_add: Array.isArray(body.tags_add) ? body.tags_add : [],
            tags_remove: Array.isArray(body.tags_remove) ? body.tags_remove : []
          });
          return sendJSON(response, 200, result);
        } catch (error) { throw new HTTPError(400, error.message || '批量操作失败'); }
      }

      if (pathname === '/api/import-jobs' && method === 'POST') {
        const body = await readJSON(request);
        if (body.kind !== 'url') throw new HTTPError(400, '当前 JSON 导入任务仅支持 URL');
        const publicURL = (await assertPublicURL(requiredString(body.url, 'URL', 2048))).toString();
        const job = await database.createImportJob('url', { url: publicURL, collectionId: body.collection_id || 'inbox' });
        importWorker.poke();
        return sendJSON(response, 202, { job: publicImportJob(job) });
      }

      if (pathname === '/api/import-jobs/upload' && method === 'POST') {
        const declaredLength = Number(request.headers['content-length'] || 0);
        if (declaredLength > MAX_UPLOAD_BYTES) throw new HTTPError(413, '附件不能超过 100 MB');
        let encodedName = String(request.headers['x-reader-filename'] || 'attachment');
        try { encodedName = decodeURIComponent(encodedName); } catch { throw new HTTPError(400, '附件名称编码无效'); }
        const staged = await stageAttachment(request, { stagingDir, fileName: encodedName, mimeType: request.headers['content-type'] || 'application/octet-stream' });
        const job = await database.createImportJob('attachment', { ...staged, collectionId: url.searchParams.get('collection') || 'inbox' });
        importWorker.poke();
        return sendJSON(response, 202, { job: publicImportJob(job) });
      }

      const jobMatch = pathname.match(/^\/api\/import-jobs\/([^/]+)$/);
      if (jobMatch && method === 'GET') {
        const job = await database.getImportJob(jobMatch[1]);
        if (!job) throw new HTTPError(404, '导入任务不存在');
        return sendJSON(response, 200, { job: publicImportJob(job) });
      }

      const retryJobMatch = pathname.match(/^\/api\/import-jobs\/([^/]+)\/retry$/);
      if (retryJobMatch && method === 'POST') {
        const job = await database.retryImportJob(retryJobMatch[1]);
        if (!job) throw new HTTPError(404, '失败的导入任务不存在');
        importWorker.poke();
        return sendJSON(response, 202, { job: publicImportJob(job) });
      }

      const articleImageMatch = pathname.match(/^\/api\/articles\/([^/]+)\/attachments$/);
      if (articleImageMatch && method === 'POST') {
        const declaredLength = Number(request.headers['content-length'] || 0);
        if (declaredLength > MAX_EDITOR_IMAGE_BYTES) throw new HTTPError(413, '文章图片不能超过 20 MB');
        let encodedName = String(request.headers['x-reader-filename'] || 'article-image');
        try { encodedName = decodeURIComponent(encodedName); } catch { throw new HTTPError(400, '图片名称编码无效'); }
        const staged = await stageAttachment(request, { stagingDir, fileName: encodedName, mimeType: request.headers['content-type'] || 'application/octet-stream', maxBytes: MAX_EDITOR_IMAGE_BYTES });
        const result = await attachStagedImage(database, articleImageMatch[1], staged, { stagingDir, filesDir });
        return sendJSON(response, result.duplicate ? 200 : 201, result);
      }

      const articleHighlightsMatch = pathname.match(/^\/api\/articles\/([^/]+)\/highlights$/);
      if (articleHighlightsMatch && method === 'GET') {
        if (!(await database.getArticle(articleHighlightsMatch[1]))) throw new HTTPError(404, '内容不存在');
        return sendJSON(response, 200, { highlights: await database.listHighlights(articleHighlightsMatch[1]) });
      }
      if (articleHighlightsMatch && method === 'POST') {
        const body = await readJSON(request);
        const startOffset = highlightOffset(body.start_offset, '高亮起点');
        const endOffset = highlightOffset(body.end_offset, '高亮终点');
        if (endOffset <= startOffset) throw new HTTPError(400, '高亮终点必须大于起点');
        const note = String(body.note || '').trim();
        if (note.length > 20_000) throw new HTTPError(400, '批注长度超过限制');
        try {
          const highlight = await database.createHighlight({
            articleId: articleHighlightsMatch[1],
            quote: requiredString(body.quote, '高亮原文', 5000),
            note,
            color: highlightColor(body.color),
            startOffset,
            endOffset
          });
          return sendJSON(response, 201, { highlight });
        } catch (error) {
          if (error.message === '内容不存在') throw new HTTPError(404, error.message);
          throw error;
        }
      }

      const highlightMatch = pathname.match(/^\/api\/highlights\/([^/]+)$/);
      if (highlightMatch && method === 'PATCH') {
        const body = await readJSON(request);
        const patch = {};
        if ('note' in body) {
          patch.note = String(body.note || '').trim();
          if (patch.note.length > 20_000) throw new HTTPError(400, '批注长度超过限制');
        }
        if ('color' in body) patch.color = highlightColor(body.color);
        const highlight = await database.updateHighlight(highlightMatch[1], patch);
        if (!highlight) throw new HTTPError(404, '高亮不存在');
        return sendJSON(response, 200, { highlight });
      }
      if (highlightMatch && method === 'DELETE') {
        const highlight = await database.deleteHighlight(highlightMatch[1]);
        if (!highlight) throw new HTTPError(404, '高亮不存在');
        return sendJSON(response, 200, { deleted: true, highlight });
      }

      const articleMatch = pathname.match(/^\/api\/articles\/([^/]+)$/);
      if (articleMatch && method === 'GET') {
        const article = await database.getArticle(articleMatch[1]);
        if (!article) throw new HTTPError(404, '内容不存在');
        return sendJSON(response, 200, { article });
      }
      if (articleMatch && method === 'PATCH') {
        const article = await database.updateArticle(articleMatch[1], await readJSON(request));
        if (!article) throw new HTTPError(404, '内容不存在');
        return sendJSON(response, 200, { article });
      }

      const tagMatch = pathname.match(/^\/api\/articles\/([^/]+)\/tags$/);
      if (tagMatch && method === 'POST') {
        const body = await readJSON(request);
        if (!Array.isArray(body.tags)) throw new HTTPError(400, 'tags 必须是数组');
        const article = await database.addTags(tagMatch[1], body.tags);
        return sendJSON(response, 200, { article });
      }
      if (tagMatch && method === 'PATCH') {
        const body = await readJSON(request);
        if (!Array.isArray(body.add || []) || !Array.isArray(body.remove || [])) throw new HTTPError(400, 'add 和 remove 必须是数组');
        if (!(await database.getArticle(tagMatch[1]))) throw new HTTPError(404, '内容不存在');
        if (body.add?.length) await database.addTags(tagMatch[1], body.add);
        const article = body.remove?.length ? await database.removeTags(tagMatch[1], body.remove) : await database.getArticle(tagMatch[1]);
        return sendJSON(response, 200, { article });
      }

      const revisionsMatch = pathname.match(/^\/api\/articles\/([^/]+)\/revisions$/);
      if (revisionsMatch && method === 'GET') {
        if (!(await database.getArticle(revisionsMatch[1]))) throw new HTTPError(404, '内容不存在');
        return sendJSON(response, 200, { revisions: await database.listArticleRevisions(revisionsMatch[1]) });
      }

      const revisionMatch = pathname.match(/^\/api\/articles\/([^/]+)\/revisions\/(\d+)$/);
      if (revisionMatch && method === 'GET') {
        const revision = await database.getArticleRevision(revisionMatch[1], Number(revisionMatch[2]));
        if (!revision) throw new HTTPError(404, '历史版本不存在');
        return sendJSON(response, 200, { revision });
      }

      const restoreRevisionMatch = pathname.match(/^\/api\/articles\/([^/]+)\/revisions\/(\d+)\/restore$/);
      if (restoreRevisionMatch && method === 'POST') {
        const article = await database.restoreArticleRevision(restoreRevisionMatch[1], Number(restoreRevisionMatch[2]));
        if (!article) throw new HTTPError(404, '历史版本不存在');
        return sendJSON(response, 200, { article });
      }

      if (pathname === '/api/ai/status' && method === 'GET') {
        return sendJSON(response, 200, { ...await runtimeAIService.status(), index: await ragIndexStatus() });
      }

      if (pathname === '/api/ai/index' && method === 'GET') {
        return sendJSON(response, 200, { index: await ragIndexStatus() });
      }

      if (pathname === '/api/ai/search' && method === 'POST') {
        const body = await readJSON(request);
        const query = requiredString(body.query, '检索问题', 4000);
        const scope = body.scope === 'library' ? 'library' : 'article';
        const articleId = scope === 'article' ? requiredString(body.article_id, '内容 ID', 200) : null;
        if (articleId && !(await database.getArticle(articleId))) throw new HTTPError(404, '内容不存在');
        const retrieval = await runtimeSemanticSearch.search(query, {
          articleId,
          limit: Math.min(Math.max(Number(body.limit) || 6, 1), 12)
        });
        return sendJSON(response, 200, { query, scope, citations: retrieval.citations, retrievalMode: retrieval.mode, index: await ragIndexStatus() });
      }

      if (pathname === '/api/settings/ai' && method === 'GET') {
        if (!aiSettingsManager) throw new HTTPError(501, '当前运行模式不支持 AI 设置');
        return sendJSON(response, 200, { settings: await aiSettingsManager.publicSettings() });
      }

      if (pathname === '/api/settings/ai' && method === 'PUT') {
        if (!aiSettingsManager) throw new HTTPError(501, '当前运行模式不支持 AI 设置');
        const body = await readJSON(request);
        if (typeof body.enabled !== 'boolean') throw new HTTPError(400, 'enabled 必须是布尔值');
        if (typeof body.endpoint !== 'string') throw new HTTPError(400, 'endpoint 必须是字符串');
        if ('provider' in body && typeof body.provider !== 'string') throw new HTTPError(400, 'provider 必须是字符串');
        if ('model' in body && typeof body.model !== 'string') throw new HTTPError(400, 'model 必须是字符串');
        if ('api_key' in body && typeof body.api_key !== 'string') throw new HTTPError(400, 'api_key 必须是字符串');
        const settings = await aiSettingsManager.update({
          enabled: body.enabled, provider: body.provider, endpoint: body.endpoint, model: body.model,
          apiKey: typeof body.api_key === 'string' ? body.api_key : undefined,
          clearApiKey: body.clear_api_key
        });
        return sendJSON(response, 200, { settings, status: runtimeAIService.status() });
      }

      if (pathname === '/api/settings/ai' && method === 'DELETE') {
        if (!aiSettingsManager) throw new HTTPError(501, '当前运行模式不支持 AI 设置');
        return sendJSON(response, 200, { settings: await aiSettingsManager.reset(), status: runtimeAIService.status() });
      }

      if (pathname === '/api/settings/ai/test' && method === 'POST') {
        if (!aiSettingsManager) throw new HTTPError(501, '当前运行模式不支持 AI 设置');
        const body = await readJSON(request);
        if ('provider' in body && typeof body.provider !== 'string') throw new HTTPError(400, 'provider 必须是字符串');
        if ('endpoint' in body && typeof body.endpoint !== 'string') throw new HTTPError(400, 'endpoint 必须是字符串');
        if ('model' in body && typeof body.model !== 'string') throw new HTTPError(400, 'model 必须是字符串');
        if ('api_key' in body && typeof body.api_key !== 'string') throw new HTTPError(400, 'api_key 必须是字符串');
        return sendJSON(response, 200, {
          result: await aiSettingsManager.test({
            provider: body.provider, endpoint: body.endpoint, model: body.model,
            apiKey: typeof body.api_key === 'string' ? body.api_key : undefined
          })
        });
      }

      if (pathname === '/api/settings/ai/models' && method === 'POST') {
        if (!aiSettingsManager) throw new HTTPError(501, '当前运行模式不支持 AI 设置');
        const body = await readJSON(request);
        if ('provider' in body && typeof body.provider !== 'string') throw new HTTPError(400, 'provider 必须是字符串');
        if ('endpoint' in body && typeof body.endpoint !== 'string') throw new HTTPError(400, 'endpoint 必须是字符串');
        if ('model' in body && typeof body.model !== 'string') throw new HTTPError(400, 'model 必须是字符串');
        if ('api_key' in body && typeof body.api_key !== 'string') throw new HTTPError(400, 'api_key 必须是字符串');
        return sendJSON(response, 200, {
          models: await aiSettingsManager.models({
            provider: body.provider, endpoint: body.endpoint, model: body.model,
            apiKey: typeof body.api_key === 'string' ? body.api_key : undefined
          })
        });
      }

      if (pathname === '/api/settings/semantic-search' && method === 'GET') {
        return sendJSON(response, 200, { settings: await runtimeSemanticSearch.status() });
      }

      if (pathname === '/api/settings/semantic-search/test' && method === 'POST') {
        const body = await readJSON(request);
        if (typeof body.model !== 'string') throw new HTTPError(400, 'model 必须是字符串');
        return sendJSON(response, 200, { result: await runtimeSemanticSearch.test(body.model) });
      }

      if (pathname === '/api/settings/semantic-search' && method === 'PUT') {
        const body = await readJSON(request);
        if (typeof body.enabled !== 'boolean') throw new HTTPError(400, 'enabled 必须是布尔值');
        if (body.enabled && typeof body.model !== 'string') throw new HTTPError(400, 'model 必须是字符串');
        if ('model' in body && typeof body.model !== 'string') throw new HTTPError(400, 'model 必须是字符串');
        return sendJSON(response, 200, {
          settings: await runtimeSemanticSearch.update({ enabled: body.enabled, model: body.model })
        });
      }

      if (pathname === '/api/settings/notifications' && method === 'GET') {
        return sendJSON(response, 200, { settings: runtimeSettingsStore.getNotifications() });
      }

      if (pathname === '/api/settings/notifications' && method === 'PUT') {
        const body = await readJSON(request);
        const hasImportSetting = 'enabled' in body;
        const hasSourceSetting = 'sourceSyncEnabled' in body;
        if (!hasImportSetting && !hasSourceSetting) throw new HTTPError(400, '至少提供一个通知设置');
        if (hasImportSetting && typeof body.enabled !== 'boolean') throw new HTTPError(400, 'enabled 必须是布尔值');
        if (hasSourceSetting && typeof body.sourceSyncEnabled !== 'boolean') throw new HTTPError(400, 'sourceSyncEnabled 必须是布尔值');
        return sendJSON(response, 200, {
          settings: await runtimeSettingsStore.saveNotifications({
            ...(hasImportSetting ? { enabled: body.enabled } : {}),
            ...(hasSourceSetting ? { sourceSyncEnabled: body.sourceSyncEnabled } : {})
          })
        });
      }

      if (pathname === '/api/settings/spotlight' && method === 'GET') {
        return sendJSON(response, 200, { settings: await runtimeSpotlight.status() });
      }

      if (pathname === '/api/settings/spotlight' && method === 'PUT') {
        const body = await readJSON(request);
        if (typeof body.enabled !== 'boolean') throw new HTTPError(400, 'enabled 必须是布尔值');
        return sendJSON(response, 200, { settings: await runtimeSpotlight.update(body.enabled) });
      }

      if (pathname === '/api/settings/connectors' && method === 'GET') {
        return sendJSON(response, 200, { connectors: await runtimeSocialConnectors.publicStatus() });
      }

      if (pathname === '/api/settings/connectors/x' && method === 'PUT') {
        const body = await readJSON(request);
        if (typeof body.bearer_token !== 'string') throw new HTTPError(400, 'bearer_token 必须是字符串');
        return sendJSON(response, 200, { connectors: await runtimeSocialConnectors.saveXToken(body.bearer_token) });
      }

      if (pathname === '/api/settings/connectors/x' && method === 'DELETE') {
        return sendJSON(response, 200, { connectors: await runtimeSocialConnectors.clearXToken() });
      }

      if (pathname === '/api/settings/connectors/x/test' && method === 'POST') {
        const body = await readJSON(request);
        if ('bearer_token' in body && typeof body.bearer_token !== 'string') throw new HTTPError(400, 'bearer_token 必须是字符串');
        return sendJSON(response, 200, { result: await runtimeSocialConnectors.testX(body.bearer_token || '') });
      }

      if (pathname === '/api/settings/connectors/weibo/test' && method === 'POST') {
        return sendJSON(response, 200, { result: await runtimeSocialConnectors.testWeibo() });
      }

      if (pathname === '/api/settings/connectors/weibo' && method === 'DELETE') {
        return sendJSON(response, 200, { connectors: await runtimeSocialConnectors.logoutWeibo() });
      }

      if (pathname === '/api/ai/translate' && method === 'POST') {
        const body = await readJSON(request);
        const article = await database.getArticle(requiredString(body.article_id, '内容 ID', 200));
        if (!article) throw new HTTPError(404, '内容不存在');
        const targetLanguage = aiLanguage(body.target_language);
        const result = await runtimeAIService.translate(article, targetLanguage);
        const provenance = {
          version: 1, task: 'translate', provider: result.provider, model: result.model || null,
          sourceArticles: [sourceSnapshot(article)], targetLanguage,
          promptVersion: 'reader-translate-v1', createdAt: new Date().toISOString()
        };
        const derived = await createAIDraft(database, result, provenance, { collectionId: body.collection_id || article.collection_id || 'notes' });
        return sendJSON(response, 201, { article: derived, provenance });
      }

      if (pathname === '/api/ai/compose' && method === 'POST') {
        const body = await readJSON(request);
        if (!Array.isArray(body.article_ids) || !body.article_ids.length) throw new HTTPError(400, '请选择至少一篇来源');
        const articleIds = [...new Set(body.article_ids.map((id) => requiredString(id, '内容 ID', 200)))];
        if (articleIds.length > 20) throw new HTTPError(400, '一次最多使用 20 篇来源');
        const prompt = String(body.prompt || '').trim();
        if (prompt.length > 4000) throw new HTTPError(400, '写作要求长度超过限制');
        const format = String(body.format || 'brief');
        if (!AI_FORMATS.has(format)) throw new HTTPError(400, '不支持这个创作格式');
        const language = aiLanguage(body.language);
        const articles = await Promise.all(articleIds.map((id) => database.getArticle(id)));
        if (articles.some((article) => !article)) throw new HTTPError(404, '部分来源内容不存在');
        const result = await runtimeAIService.compose(articles, { prompt, format, language });
        const provenance = {
          version: 1, task: 'compose', provider: result.provider, model: result.model || null,
          sourceArticles: articles.map(sourceSnapshot), format, language, prompt,
          promptVersion: 'reader-compose-v1', createdAt: new Date().toISOString()
        };
        const derived = await createAIDraft(database, result, provenance, { collectionId: body.collection_id || 'notes' });
        return sendJSON(response, 201, { article: derived, provenance });
      }

      const summaryMatch = pathname.match(/^\/api\/articles\/([^/]+)\/ai\/summary$/);
      if (summaryMatch && method === 'POST') {
        const article = await database.getArticle(summaryMatch[1]);
        if (!article) throw new HTTPError(404, '内容不存在');
        const result = await runtimeAIService.summarize(article);
        if (result.summary) await database.updateArticle(article.id, { summary: result.summary });
        return sendJSON(response, 200, result);
      }

      const chatMatch = pathname.match(/^\/api\/articles\/([^/]+)\/ai\/chat$/);
      if (chatMatch && method === 'POST') {
        const article = await database.getArticle(chatMatch[1]);
        if (!article) throw new HTTPError(404, '内容不存在');
        const body = await readJSON(request);
        const prompt = requiredString(body.prompt, '问题', 4000);
        const scope = body.scope === 'library' ? 'library' : 'article';
        const retrieval = await runtimeSemanticSearch.search(prompt, { articleId: scope === 'article' ? article.id : null, limit: 6 });
        const matched = retrieval.citations;
        const result = await runtimeAIService.chat(article, prompt, { context: matched, scope });
        const selected = new Set(Array.isArray(result.citationIds) ? result.citationIds : matched.map((citation) => citation.id));
        const citations = matched.filter((citation) => selected.has(citation.id));
        return sendJSON(response, 200, {
          ...result,
          citationIds: undefined,
          scope,
          citations,
          retrieval: { mode: retrieval.mode, matchedChunks: matched.length, citedChunks: citations.length }
        });
      }

      if (pathname === '/api/tags' && method === 'GET') return sendJSON(response, 200, { tags: await database.listTags() });
      if (pathname === '/api/collections' && method === 'GET') return sendJSON(response, 200, { collections: await database.listCollections() });
      if (pathname === '/api/collections' && method === 'POST') {
        const body = await readJSON(request);
        try { return sendJSON(response, 201, { collection: await database.createCollection({ name: requiredString(body.name, '名称', 120), parentId: body.parent_id || null }) }); }
        catch (error) { throw new HTTPError(/已存在/.test(error.message || '') ? 409 : 400, error.message || '资料夹创建失败'); }
      }
      if (pathname === '/api/collections/reorder' && method === 'POST') {
        const body = await readJSON(request);
        if (!Array.isArray(body.ordered_ids) || body.ordered_ids.length > 1000) throw new HTTPError(400, '资料夹排序列表无效');
        try { return sendJSON(response, 200, { collections: await database.reorderCollections(body.parent_id || null, body.ordered_ids) }); }
        catch (error) { throw new HTTPError(400, error.message || '资料夹排序失败'); }
      }
      const collectionMatch = pathname.match(/^\/api\/collections\/([^/]+)$/);
      if (collectionMatch && method === 'PATCH') {
        const body = await readJSON(request);
        const patch = {};
        if ('name' in body) patch.name = requiredString(body.name, '名称', 120);
        if ('parent_id' in body) patch.parent_id = body.parent_id || null;
        if ('position' in body) patch.position = Number(body.position);
        try {
          const collection = await database.updateCollection(collectionMatch[1], patch);
          if (!collection) throw new HTTPError(404, '资料夹不存在');
          return sendJSON(response, 200, { collection });
        } catch (error) { if (error instanceof HTTPError) throw error; throw new HTTPError(/已存在/.test(error.message || '') ? 409 : 400, error.message || '资料夹更新失败'); }
      }
      if (collectionMatch && method === 'DELETE') {
        try {
          const collection = await database.deleteCollection(collectionMatch[1], { moveTo: url.searchParams.get('move_to') || 'inbox' });
          if (!collection) throw new HTTPError(404, '资料夹不存在');
          return sendJSON(response, 200, { deleted: true, collection });
        } catch (error) { if (error instanceof HTTPError) throw error; throw new HTTPError(400, error.message || '资料夹删除失败'); }
      }

      if (pathname === '/api/smart-collections' && method === 'GET') {
        return sendJSON(response, 200, { smartCollections: await database.listSmartCollections() });
      }
      if (pathname === '/api/smart-collections' && method === 'POST') {
        const body = await readJSON(request);
        try {
          return sendJSON(response, 201, {
            smartCollection: await database.createSmartCollection({
              name: requiredString(body.name, '名称', 120),
              rule: smartCollectionRule(body.rule)
            })
          });
        } catch (error) {
          if (error instanceof HTTPError) throw error;
          throw new HTTPError(/已存在/.test(error.message || '') ? 409 : 400, error.message || '智能资料夹创建失败');
        }
      }
      if (pathname === '/api/smart-collections/reorder' && method === 'POST') {
        const body = await readJSON(request);
        if (!Array.isArray(body.ordered_ids) || body.ordered_ids.length > 1000) throw new HTTPError(400, '智能资料夹排序列表无效');
        try { return sendJSON(response, 200, { smartCollections: await database.reorderSmartCollections(body.ordered_ids) }); }
        catch (error) { throw new HTTPError(400, error.message || '智能资料夹排序失败'); }
      }
      const smartCollectionMatch = pathname.match(/^\/api\/smart-collections\/([^/]+)$/);
      if (smartCollectionMatch && method === 'PATCH') {
        const body = await readJSON(request);
        const patch = {};
        if ('name' in body) patch.name = requiredString(body.name, '名称', 120);
        if ('rule' in body) patch.rule = smartCollectionRule(body.rule);
        if ('position' in body) patch.position = Number(body.position);
        try {
          const smartCollection = await database.updateSmartCollection(smartCollectionMatch[1], patch);
          if (!smartCollection) throw new HTTPError(404, '智能资料夹不存在');
          return sendJSON(response, 200, { smartCollection });
        } catch (error) {
          if (error instanceof HTTPError) throw error;
          throw new HTTPError(/已存在/.test(error.message || '') ? 409 : 400, error.message || '智能资料夹更新失败');
        }
      }
      if (smartCollectionMatch && method === 'DELETE') {
        const smartCollection = await database.deleteSmartCollection(smartCollectionMatch[1]);
        if (!smartCollection) throw new HTTPError(404, '智能资料夹不存在');
        return sendJSON(response, 200, { deleted: true, smartCollection });
      }

      if (pathname === '/api/sources' && method === 'GET') return sendJSON(response, 200, { sources: await database.listSources() });
      if (pathname === '/api/sources/opml' && method === 'GET') {
        const opml = exportOPML(await database.listSources());
        response.writeHead(200, {
          'content-type': 'text/x-opml; charset=utf-8',
          'content-length': Buffer.byteLength(opml),
          'content-disposition': `attachment; filename*=UTF-8''${encodeURIComponent('Reader-订阅.opml')}`,
          'cache-control': 'no-store',
          'x-content-type-options': 'nosniff'
        });
        return response.end(opml);
      }
      if (pathname === '/api/sources/opml' && method === 'POST') {
        let candidates;
        try { candidates = parseOPML(await readText(request)); }
        catch (error) { throw new HTTPError(400, error.message || 'OPML 格式不正确'); }
        let imported = 0;
        let duplicates = 0;
        const errors = [];
        for (const candidate of candidates) {
          try {
            const normalizedURL = await normalizeSourceURL(candidate.kind, candidate.url);
            if (candidate.kind === 'x' || candidate.kind === 'weibo') await runtimeSocialConnectors.assertReady(candidate.kind);
            const existing = await database.findSource(candidate.kind, normalizedURL);
            if (existing) { duplicates += 1; continue; }
            const source = await database.createSource({ kind: candidate.kind, title: candidate.title, url: normalizedURL, syncIntervalMinutes: candidate.syncIntervalMinutes });
            if (!candidate.enabled) await database.updateSource(source.id, { enabled: false, next_fetch_at: null });
            imported += 1;
          } catch (error) {
            errors.push({ title: candidate.title, error: error.message });
          }
        }
        return sendJSON(response, 200, { imported, duplicates, failed: errors.length, errors: errors.slice(0, 20), sources: await database.listSources() });
      }
      if (pathname === '/api/sources' && method === 'POST') {
        const body = await readJSON(request);
        const kind = requiredString(body.kind, '类型', 20);
        if (!['rss', 'x', 'weibo', 'youtube'].includes(kind)) throw new HTTPError(400, '暂不支持该订阅类型');
        let sourceURL;
        try { sourceURL = await normalizeSourceURL(kind, requiredString(body.url, 'URL', 2048)); }
        catch (error) { throw new HTTPError(400, error.message || '订阅地址不可用'); }
        if (kind === 'x' || kind === 'weibo') {
          try { await runtimeSocialConnectors.assertReady(kind); }
          catch (error) { throw new HTTPError(error.status || 412, error.message || '连接器尚未就绪'); }
        }
        const interval = sourceInterval(body.sync_interval_minutes);
        const existing = await database.findSource(kind, sourceURL);
        if (existing) return sendJSON(response, 200, { source: existing, duplicate: true });
        return sendJSON(response, 201, { source: await database.createSource({ kind, title: requiredString(body.title, '名称', 200), url: sourceURL, syncIntervalMinutes: interval }), duplicate: false });
      }

      const sourceMatch = pathname.match(/^\/api\/sources\/([^/]+)$/);
      if (sourceMatch && method === 'PATCH') {
        const source = await database.getSource(sourceMatch[1]);
        if (!source) throw new HTTPError(404, '订阅源不存在');
        const body = await readJSON(request);
        const patch = {};
        if ('title' in body) patch.title = requiredString(body.title, '名称', 200);
        if ('enabled' in body) {
          patch.enabled = Boolean(body.enabled);
          patch.next_fetch_at = patch.enabled ? new Date().toISOString() : null;
          if (patch.enabled) patch.last_status = 'idle';
        }
        if ('sync_interval_minutes' in body) {
          patch.sync_interval_minutes = sourceInterval(body.sync_interval_minutes);
          if (source.enabled) patch.next_fetch_at = new Date().toISOString();
        }
        return sendJSON(response, 200, { source: await database.updateSource(source.id, patch) });
      }
      if (sourceMatch && method === 'DELETE') {
        const deleted = await database.deleteSource(sourceMatch[1]);
        if (!deleted) throw new HTTPError(404, '订阅源不存在');
        return sendJSON(response, 200, { deleted: true, source: deleted });
      }

      if (pathname === '/api/backups' && method === 'GET') {
        const backups = await listBackups(rootDir);
        return sendJSON(response, 200, { backups, automaticBackup: await automaticBackups.status(backups), pendingRestore: publicPendingRestore(await getPendingRestore(rootDir)) });
      }

      if (pathname === '/api/settings/automatic-backups' && method === 'PUT') {
        const body = await readJSON(request);
        if (typeof body.enabled !== 'boolean') throw new HTTPError(400, '自动恢复点开关必须是布尔值');
        return sendJSON(response, 200, { automaticBackup: await automaticBackups.updateEnabled(body.enabled) });
      }

      if (pathname === '/api/backups' && method === 'POST') {
        const activeJobs = (await database.listImportJobs(200)).filter((job) => job.status === 'pending' || job.status === 'running');
        if (activeJobs.length) throw new HTTPError(409, '请等待导入任务完成后再创建备份');
        const body = await readJSON(request);
        const passphrase = body.encrypted ? requiredString(body.passphrase, '备份口令', 1024) : '';
        const backup = await createBackup({ database, rootDir, appVersion: APP_VERSION, passphrase });
        await diagnostics.record('backup_created', { encrypted: backup.encrypted, byteSize: backup.byte_size });
        return sendJSON(response, 201, { backup });
      }

      if (pathname === '/api/data-health' && method === 'POST') {
        try {
          return sendJSON(response, 200, { health: await inspectDataHealth({ database, filesDir }) });
        } catch {
          throw Object.assign(new HTTPError(500, '无法完成资料库检查'), { expected: true });
        }
      }

      if (pathname === '/api/data-health/repair' && method === 'POST') {
        if (dataRepairPromise) throw new HTTPError(409, '资料库修复正在进行');
        dataRepairPromise = (async () => {
          if (await getPendingRestore(rootDir)) throw new HTTPError(409, '请先完成或取消等待重启的恢复任务');
          const activeJobs = (await database.listImportJobs(200)).filter((job) => job.status === 'pending' || job.status === 'running');
          if (activeJobs.length) throw new HTTPError(409, '请等待导入任务完成后再修复资料库');
          return await repairDerivedData({ database, rootDir, filesDir, appVersion: APP_VERSION });
        })();
        try {
          const result = await dataRepairPromise;
          await diagnostics.record('data_repair_completed', { actions: result.actions, backupCreated: Boolean(result.backup) });
          return sendJSON(response, 200, { result });
        } catch (error) {
          if (error instanceof HTTPError) throw error;
          if (error.expected) throw Object.assign(new HTTPError(error.status || 500, error.message || '资料库修复失败'), { expected: true });
          throw Object.assign(new HTTPError(500, '无法完成资料库修复；现有安全备份不会删除'), { expected: true });
        } finally {
          dataRepairPromise = null;
        }
      }

      if (pathname === '/api/migration-snapshots' && method === 'GET') {
        return sendJSON(response, 200, { snapshots: await listMigrationSnapshots(database.path) });
      }

      const migrationSnapshotRestoreMatch = pathname.match(/^\/api\/migration-snapshots\/([0-9a-f-]{36})\/restore$/i);
      if (migrationSnapshotRestoreMatch && method === 'POST') {
        if (dataRepairPromise) throw new HTTPError(409, '请等待资料库修复完成后再恢复升级快照');
        restoreWriteLocked = true;
        try {
          await backgroundWork.update({ restoreLocked: true });
          const activeJobs = (await database.listImportJobs(200)).filter((job) => job.status === 'pending' || job.status === 'running');
          if (activeJobs.length) throw new HTTPError(409, '请等待导入任务完成后再恢复升级快照');
          const snapshot = await resolveMigrationSnapshot(database.path, migrationSnapshotRestoreMatch[1]);
          if (!snapshot) throw new HTTPError(404, '升级快照不存在');
          const pendingRestore = await scheduleMigrationSnapshotRestore({ database, snapshot, rootDir, appVersion: APP_VERSION });
          await diagnostics.record('restore_scheduled', { source: 'migration_snapshot', encrypted: false });
          return sendJSON(response, 202, { pendingRestore: publicPendingRestore(pendingRestore), restartRequired: true });
        } catch (error) {
          if (!(await getPendingRestore(rootDir))) {
            restoreWriteLocked = false;
            await backgroundWork.update({ restoreLocked: false });
          }
          throw error;
        }
      }

      if (pathname === '/api/diagnostics/logs' && method === 'GET') {
        return sendJSON(response, 200, { diagnostics: await diagnostics.list(250) });
      }

      if (pathname === '/api/diagnostics/logs' && method === 'DELETE') {
        await diagnostics.clear();
        return sendJSON(response, 200, { cleared: true });
      }

      if (pathname === '/api/diagnostics/logs/download' && (method === 'GET' || method === 'HEAD')) {
        const data = await diagnostics.exportJSONL();
        const fileName = `reader-diagnostics-${new Date().toISOString().slice(0, 10)}.jsonl`;
        response.writeHead(200, {
          'content-type': 'application/x-ndjson; charset=utf-8',
          'content-length': String(data.length),
          'content-disposition': `attachment; filename="${fileName}"`,
          'cache-control': 'private, no-store',
          'x-content-type-options': 'nosniff'
        });
        if (method === 'HEAD') return response.end();
        return response.end(data);
      }

      const migrationSnapshotDownloadMatch = pathname.match(/^\/api\/migration-snapshots\/([0-9a-f-]{36})\/download$/i);
      if (migrationSnapshotDownloadMatch && (method === 'GET' || method === 'HEAD')) {
        const snapshot = await resolveMigrationSnapshot(database.path, migrationSnapshotDownloadMatch[1]);
        if (!snapshot) throw new HTTPError(404, '升级快照不存在');
        const info = await stat(snapshot.path);
        response.writeHead(200, {
          'content-type': 'application/vnd.sqlite3',
          'content-length': String(info.size),
          'content-disposition': `attachment; filename*=UTF-8''${encodeURIComponent(snapshot.file_name)}`,
          'cache-control': 'private, no-store',
          'x-content-type-options': 'nosniff'
        });
        if (method === 'HEAD') return response.end();
        return createReadStream(snapshot.path).pipe(response);
      }

      const backupDownloadMatch = pathname.match(/^\/api\/backups\/([0-9a-f-]{36})\/download$/i);
      if (backupDownloadMatch && (method === 'GET' || method === 'HEAD')) {
        const backup = await resolveBackup(rootDir, backupDownloadMatch[1]);
        if (!backup) throw new HTTPError(404, '备份不存在');
        const info = await stat(backup.path);
        response.writeHead(200, { 'content-type': backup.encrypted ? 'application/vnd.reader.backup+encrypted' : 'application/zip', 'content-length': String(info.size), 'content-disposition': `attachment; filename*=UTF-8''${encodeURIComponent(backup.file_name)}`, 'cache-control': 'private, no-store', 'x-content-type-options': 'nosniff' });
        if (method === 'HEAD') return response.end();
        return createReadStream(backup.path).pipe(response);
      }

      if (pathname === '/api/backups/restore' && method === 'POST') {
        restoreWriteLocked = true;
        try {
          await backgroundWork.update({ restoreLocked: true });
          const activeJobs = (await database.listImportJobs(200)).filter((job) => job.status === 'pending' || job.status === 'running');
          if (activeJobs.length) throw new HTTPError(409, '请等待导入任务完成后再恢复数据');
          const passphrase = decodeBase64SecretHeader(request, 'x-reader-backup-passphrase');
          const pendingRestore = await scheduleRestore({ request, database, rootDir, appVersion: APP_VERSION, passphrase });
          await diagnostics.record('restore_scheduled', { source: 'backup', encrypted: pendingRestore.encrypted });
          return sendJSON(response, 202, { pendingRestore: publicPendingRestore(pendingRestore), restartRequired: true });
        } catch (error) {
          if (!(await getPendingRestore(rootDir))) {
            restoreWriteLocked = false;
            await backgroundWork.update({ restoreLocked: false });
          }
          throw error;
        }
      }

      if (pathname === '/api/backups/restore' && method === 'DELETE') {
        const cancelled = await cancelPendingRestore(rootDir);
        if (cancelled) {
          restoreWriteLocked = false;
          await backgroundWork.update({ restoreLocked: false });
          await diagnostics.record('restore_cancelled');
        }
        return sendJSON(response, 200, { cancelled });
      }

      const syncMatch = pathname.match(/^\/api\/sources\/([^/]+)\/sync$/);
      if (syncMatch && method === 'POST') {
        const source = await database.getSource(syncMatch[1]);
        if (!source) throw new HTTPError(404, '订阅源不存在');
        try { return sendJSON(response, 200, await sourceSync.syncSource(source)); }
        catch (error) { throw new HTTPError(error.status || 502, error.message || '订阅源同步失败'); }
      }

      const thumbnailMatch = pathname.match(/^\/api\/attachments\/([^/]+)\/thumbnail$/);
      if (thumbnailMatch && (method === 'GET' || method === 'HEAD')) {
        const attachment = await database.getAttachment(thumbnailMatch[1]);
        if (!attachment) throw new HTTPError(404, '附件不存在');
        const sourcePath = path.resolve(filesDir, attachment.storage_name);
        if (!sourcePath.startsWith(`${path.resolve(filesDir)}${path.sep}`)) throw new HTTPError(400, '附件路径无效');
        const thumbnail = await getAttachmentThumbnail({ attachment, sourcePath, thumbnailsDir });
        const thumbnailStats = await stat(thumbnail.path);
        response.writeHead(200, { 'content-type': thumbnail.contentType, 'content-length': String(thumbnailStats.size), 'cache-control': 'private, max-age=31536000, immutable', 'x-content-type-options': 'nosniff' });
        if (method === 'HEAD') return response.end();
        return createReadStream(thumbnail.path).pipe(response);
      }

      const attachmentMatch = pathname.match(/^\/api\/attachments\/([^/]+)\/content$/);
      if (attachmentMatch && (method === 'GET' || method === 'HEAD')) {
        const attachment = await database.getAttachment(attachmentMatch[1]);
        if (!attachment) throw new HTTPError(404, '附件不存在');
        const filePath = path.resolve(filesDir, attachment.storage_name);
        if (!filePath.startsWith(`${path.resolve(filesDir)}${path.sep}`)) throw new HTTPError(400, '附件路径无效');
        const fileStats = await stat(filePath);
        const range = String(request.headers.range || '').match(/^bytes=(\d*)-(\d*)$/);
        let start = 0;
        let end = fileStats.size - 1;
        let status = 200;
        if (range) {
          if (!range[1] && range[2]) {
            const suffixLength = Number(range[2]);
            start = Math.max(0, fileStats.size - suffixLength);
            end = fileStats.size - 1;
          } else {
            start = Number(range[1]);
            end = range[2] ? Math.min(Number(range[2]), fileStats.size - 1) : fileStats.size - 1;
          }
          if (!Number.isInteger(start) || !Number.isInteger(end) || start < 0 || start > end || start >= fileStats.size) {
            response.writeHead(416, { 'content-range': `bytes */${fileStats.size}` });
            return response.end();
          }
          status = 206;
        }
        const headers = {
          'content-type': attachment.mime_type,
          'content-length': String(end - start + 1),
          'content-disposition': `inline; filename*=UTF-8''${encodeURIComponent(attachment.file_name)}`,
          'accept-ranges': 'bytes',
          'cache-control': 'private, max-age=31536000, immutable',
          'x-content-type-options': 'nosniff'
        };
        if (status === 206) headers['content-range'] = `bytes ${start}-${end}/${fileStats.size}`;
        response.writeHead(status, headers);
        if (method === 'HEAD') return response.end();
        return createReadStream(filePath, { start, end }).pipe(response);
      }

      if (pathname.startsWith('/api/')) throw new HTTPError(404, 'API 路径不存在');

      if (method !== 'GET' && method !== 'HEAD') throw new HTTPError(405, '不支持该请求方法');
      if (!(await exists(path.join(staticDir, 'index.html')))) throw new HTTPError(503, '前端尚未构建，请先运行 npm run build');
      const requested = pathname === '/' ? 'index.html' : pathname.slice(1);
      let filePath = path.resolve(staticDir, requested);
      if (!filePath.startsWith(`${path.resolve(staticDir)}${path.sep}`) && filePath !== path.join(path.resolve(staticDir), 'index.html')) throw new HTTPError(400, '无效文件路径');
      if (!(await exists(filePath))) filePath = path.join(staticDir, 'index.html');
      const data = await readFile(filePath);
      response.writeHead(200, { 'content-type': mimeType(filePath), 'content-length': data.length, 'cache-control': filePath.endsWith('index.html') ? 'no-cache' : 'public, max-age=31536000, immutable', 'x-content-type-options': 'nosniff' });
      if (method === 'HEAD') return response.end();
      response.end(data);
    } catch (error) {
      if (response.headersSent) return response.destroy(error);
      const sqliteConflict = /UNIQUE constraint failed/.test(error.message || '');
      const status = error.status || (sqliteConflict ? 409 : 500);
      const unexpectedServerError = status >= 500 && !error.expected;
      if (unexpectedServerError) {
        const diagnostic = {
          method: requestMethod,
          route: diagnosticRoute(requestPath),
          status,
          category: diagnosticErrorCategory(error)
        };
        console.error(`Reader API error: ${diagnostic.method} ${diagnostic.route} ${diagnostic.status} ${diagnostic.category}`);
        await diagnostics.record('api_error', diagnostic);
      }
      sendJSON(response, status, unexpectedServerError
        ? { error: '无法完成请求' }
        : { error: error.message || '未知错误', ...(error.details ? { details: error.details } : {}) });
    }
  });

  return {
    server,
    database,
    diagnostics,
    spotlight: runtimeSpotlight,
    semanticSearch: runtimeSemanticSearch,
    host,
    port,
    setBackgroundWorkState(state) { return backgroundWork.update(state); },
    getBackgroundWorkState() { return backgroundWork.snapshot(); },
    async listen() { await new Promise((resolve, reject) => { server.once('error', reject); server.listen(port, host, resolve); }); return server.address(); },
    async close() {
      await Promise.all([importWorker.stop(), sourceScheduler.stop(), runtimeSpotlight.stop(), runtimeSemanticSearch.stop(), automaticBackups.stop()]);
      if (!diagnosticsStopped) {
        diagnosticsStopped = true;
        await diagnostics.record('app_stopped');
        await diagnostics.flush();
      }
      if (!server.listening) return;
      await new Promise((resolve, reject) => server.close((error) => error ? reject(error) : resolve()));
    }
  };
}

const invokedDirectly = process.argv[1] && import.meta.url === pathToFileURL(path.resolve(process.argv[1])).href;
if (invokedDirectly) {
  const app = await createReaderServer();
  await app.listen();
  console.log(`Reader server running at http://${app.host}:${app.port}`);
}
