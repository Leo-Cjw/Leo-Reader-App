import path from 'node:path';
import { createHash, randomUUID } from 'node:crypto';
import { constants as fsConstants, createReadStream, createWriteStream } from 'node:fs';
import { access, chmod, copyFile, mkdir, open, readFile, readdir, rm, stat, unlink, writeFile } from 'node:fs/promises';
import { once } from 'node:events';
import { pipeline } from 'node:stream/promises';
import yauzl from 'yauzl';
import { sanitizeFileName } from './attachments.mjs';
import { sqlValue } from './db.mjs';

export const MAX_PORTABLE_IMPORT_BYTES = 2 * 1024 * 1024 * 1024;
const MAX_EXTRACTED_BYTES = 5 * 1024 * 1024 * 1024;
const MAX_ARCHIVE_ENTRIES = 20_000;
const MAX_ARTICLES = 500;
const MAX_MANIFEST_BYTES = 4 * 1024 * 1024;
const MAX_ARTICLE_BYTES = 5 * 1024 * 1024;
const MAX_ATTACHMENT_BYTES = 100 * 1024 * 1024;
const IMPORT_TTL_MS = 24 * 60 * 60 * 1000;
const UUID_PATTERN = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;
const HIGHLIGHT_COLORS = new Set(['amber', 'green', 'blue', 'pink']);

function httpError(status, message) {
  return Object.assign(new Error(message), { status });
}

async function exists(filePath) {
  try { await access(filePath); return true; }
  catch { return false; }
}

async function hashFile(filePath) {
  const hash = createHash('sha256');
  for await (const chunk of createReadStream(filePath)) hash.update(chunk);
  return hash.digest('hex');
}

function plainObject(value) {
  return value !== null && typeof value === 'object' && !Array.isArray(value);
}

function limitedString(value, label, max, { optional = false } = {}) {
  if (value === null && optional) return null;
  const result = String(value ?? '');
  if (!optional && !result.trim()) throw new Error(`${label}不能为空`);
  if (result.length > max) throw new Error(`${label}长度超过限制`);
  return result;
}

function optionalDate(value, label) {
  if (value === null || value === undefined || value === '') return null;
  const result = limitedString(value, label, 64);
  if (!Number.isFinite(Date.parse(result))) throw new Error(`${label}无效`);
  return result;
}

export function validatePortableEntryPath(name) {
  if (!name || name.includes('\\') || name.includes('\0') || name.startsWith('/') || /^[A-Za-z]:/.test(name)) throw new Error('导入包包含不安全路径');
  const directory = name.endsWith('/');
  const normalized = path.posix.normalize(directory ? name.slice(0, -1) : name);
  if (normalized === '..' || normalized.startsWith('../') || (directory ? `${normalized}/` : normalized) !== name) throw new Error('导入包包含不安全路径');
  const allowedDirectory = normalized === 'articles' || normalized === 'attachments' || normalized === 'records' || normalized.startsWith('attachments/');
  const allowedFile = normalized === 'manifest.json' || normalized === 'README.md'
    || /^articles\/[^/]+\.md$/i.test(normalized)
    || /^records\/[^/]+\.json$/i.test(normalized)
    || normalized.startsWith('attachments/');
  if (!(directory ? allowedDirectory : allowedFile)) throw new Error('导入包包含未知文件');
  return normalized;
}

function entryLimit(relative) {
  if (relative === 'manifest.json') return MAX_MANIFEST_BYTES;
  if (relative.startsWith('articles/') || relative.startsWith('records/')) return MAX_ARTICLE_BYTES;
  if (relative.startsWith('attachments/')) return MAX_ATTACHMENT_BYTES;
  return 1024 * 1024;
}

function openZip(filePath) {
  return new Promise((resolve, reject) => yauzl.open(filePath, {
    lazyEntries: true, autoClose: true, decodeStrings: true, validateEntrySizes: true
  }, (error, zip) => error ? reject(error) : resolve(zip)));
}

async function extractZipSafely(archivePath, destination) {
  await mkdir(destination, { recursive: true, mode: 0o700 });
  const zip = await openZip(archivePath);
  const seen = new Set();
  let total = 0;
  let entries = 0;
  await new Promise((resolve, reject) => {
    zip.once('error', reject);
    zip.once('end', resolve);
    zip.on('entry', async (entry) => {
      try {
        entries += 1;
        if (entries > MAX_ARCHIVE_ENTRIES) throw new Error('导入包文件数量超过限制');
        if (entry.generalPurposeBitFlag & 1) throw new Error('导入包不能包含加密条目');
        const relative = validatePortableEntryPath(entry.fileName);
        if (seen.has(relative)) throw new Error('导入包包含重复路径');
        seen.add(relative);
        const unixMode = (entry.externalFileAttributes >>> 16) & 0xffff;
        if ((unixMode & 0o170000) === 0o120000) throw new Error('导入包不允许包含符号链接');
        if (entry.uncompressedSize > entryLimit(relative)) throw new Error(`导入包中的 ${relative} 超过大小限制`);
        total += entry.uncompressedSize;
        if (total > MAX_EXTRACTED_BYTES) throw new Error('导入包解压后超过 5 GB 限制');
        const target = path.join(destination, ...relative.split('/'));
        if (entry.fileName.endsWith('/')) await mkdir(target, { recursive: true, mode: 0o700 });
        else {
          await mkdir(path.dirname(target), { recursive: true, mode: 0o700 });
          const stream = await new Promise((res, rej) => zip.openReadStream(entry, (error, value) => error ? rej(error) : res(value)));
          await pipeline(stream, createWriteStream(target, { flags: 'wx', mode: 0o600 }));
        }
        zip.readEntry();
      } catch (error) {
        zip.close();
        reject(error);
      }
    });
    zip.readEntry();
  });
  return seen;
}

async function stageRequest(request, destination) {
  const declared = Number(request.headers['content-length'] || 0);
  if (declared > MAX_PORTABLE_IMPORT_BYTES) throw httpError(413, 'Markdown 导入包不能超过 2 GB');
  const handle = await open(destination, 'wx', 0o600);
  let total = 0;
  try {
    for await (const chunk of request) {
      total += chunk.length;
      if (total > MAX_PORTABLE_IMPORT_BYTES) throw httpError(413, 'Markdown 导入包不能超过 2 GB');
      await handle.write(chunk);
    }
  } catch (error) {
    await handle.close().catch(() => {});
    await unlink(destination).catch(() => {});
    throw error;
  }
  await handle.close();
  if (!total) {
    await unlink(destination).catch(() => {});
    throw httpError(400, 'Markdown 导入包为空');
  }
}

function normalizeHighlight(value) {
  if (!plainObject(value)) throw new Error('高亮记录无效');
  const startOffset = Number(value.startOffset);
  const endOffset = Number(value.endOffset);
  if (!Number.isSafeInteger(startOffset) || !Number.isSafeInteger(endOffset) || startOffset < 0 || endOffset <= startOffset || endOffset > 10_000_000) throw new Error('高亮位置无效');
  const color = String(value.color || '');
  if (!HIGHLIGHT_COLORS.has(color)) throw new Error('高亮颜色无效');
  return {
    quote: limitedString(value.quote, '高亮原文', 5_000),
    note: limitedString(value.note || '', '批注', 20_000, { optional: true }) || '',
    color, startOffset, endOffset
  };
}

function normalizeAttachment(value) {
  if (!plainObject(value)) throw new Error('附件记录无效');
  const archivePath = validatePortableEntryPath(limitedString(value.path, '附件路径', 500));
  if (!archivePath.startsWith('attachments/') || archivePath.endsWith('/')) throw new Error('附件路径无效');
  const byteSize = Number(value.byteSize);
  if (!Number.isSafeInteger(byteSize) || byteSize < 0 || byteSize > MAX_ATTACHMENT_BYTES) throw new Error('附件大小无效');
  const sha256 = String(value.sha256 || '').toLowerCase();
  if (!/^[0-9a-f]{64}$/.test(sha256)) throw new Error('附件校验值无效');
  return {
    originalId: stableId(value.id, '附件 ID'),
    path: archivePath,
    fileName: sanitizeFileName(limitedString(value.fileName, '附件名称', 300)),
    mimeType: limitedString(value.mimeType || 'application/octet-stream', '附件类型', 200),
    byteSize, sha256
  };
}

function normalizedURL(value) {
  if (value === null || value === undefined || value === '') return null;
  const input = limitedString(value, '原始链接', 2_048);
  let parsed;
  try { parsed = new URL(input); }
  catch { throw new Error('原始链接无效'); }
  if (!['http:', 'https:'].includes(parsed.protocol)) throw new Error('原始链接协议不受支持');
  return parsed.toString();
}

function stableId(value, label) {
  const id = limitedString(value, label, 200);
  if (!/^[A-Za-z0-9][A-Za-z0-9._:-]{0,199}$/.test(id)) throw new Error(`${label}无效`);
  return id;
}

function parseFrontmatter(markdown) {
  const match = String(markdown).match(/^---\n([\s\S]*?)\n---\n([\s\S]*)$/);
  if (!match) throw new Error('旧版 Markdown 缺少 Reader 元数据');
  const fields = {};
  const tags = [];
  let readingTags = false;
  for (const line of match[1].split('\n')) {
    const tag = line.match(/^\s+-\s+(.+)$/);
    if (readingTags && tag) {
      try { tags.push(String(JSON.parse(tag[1]))); } catch { throw new Error('旧版 Markdown 标签无效'); }
      continue;
    }
    readingTags = false;
    const field = line.match(/^([a-z_]+):\s*(.*)$/);
    if (!field) continue;
    if (field[1] === 'tags') {
      readingTags = field[2] !== '[]';
      continue;
    }
    try { fields[field[1]] = JSON.parse(field[2]); }
    catch { throw new Error('旧版 Markdown 元数据无效'); }
  }
  return { fields, tags, body: match[2] };
}

function legacyArticle(markdown, item) {
  const parsed = parseFrontmatter(markdown);
  let body = parsed.body.replace(/^\n/, '');
  const titleLine = `# ${item.title}\n`;
  if (body.startsWith(titleLine)) body = body.slice(titleLine.length).replace(/^\n/, '');
  let excerpt = '';
  if (body.startsWith('> ')) {
    const lines = body.split('\n');
    const quote = [];
    while (lines[0]?.startsWith('> ')) quote.push(lines.shift().slice(2));
    if (lines[0] === '') lines.shift();
    excerpt = quote.join('\n');
    body = lines.join('\n');
  }
  if (item.highlights.length) {
    const marker = body.lastIndexOf('\n\n## 高亮与批注\n\n');
    if (marker >= 0) body = body.slice(0, marker);
  }
  if (item.attachments.length) {
    const marker = body.lastIndexOf('\n\n## 附件\n\n');
    if (marker >= 0) body = body.slice(0, marker);
  }
  return {
    id: item.id,
    url: normalizedURL(item.originalURL),
    title: item.title,
    source: limitedString(parsed.fields.source || '', '来源', 500, { optional: true }) || '',
    author: limitedString(parsed.fields.author || '', '作者', 500, { optional: true }) || '',
    type: limitedString(item.type || parsed.fields.type || 'article', '类型', 100),
    language: limitedString(item.language || parsed.fields.language || 'zh', '语言', 100),
    publishedAt: optionalDate(parsed.fields.published_at, '发布时间'),
    createdAt: optionalDate(parsed.fields.created_at, '创建时间'),
    excerpt: limitedString(excerpt, '摘要', 20_000, { optional: true }) || '',
    content: limitedString(body.trimEnd(), '正文', MAX_ARTICLE_BYTES, { optional: true }) || '',
    summary: '',
    isFavorite: false,
    isRead: false,
    readingProgress: 0,
    metadata: {},
    tags: item.tags.length ? item.tags : parsed.tags,
    compatibilityMode: true
  };
}

function normalizeRecord(value, item) {
  if (!plainObject(value) || value.format !== 'reader-article-record' || value.formatVersion !== 1 || !plainObject(value.article)) throw new Error('Reader 文章记录无效');
  const article = value.article;
  if (String(article.id) !== item.id) throw new Error('文章记录 ID 与清单不一致');
  const progress = Number(article.readingProgress || 0);
  if (!Number.isFinite(progress) || progress < 0 || progress > 1) throw new Error('阅读进度无效');
  const metadata = plainObject(article.metadata) ? article.metadata : {};
  if (JSON.stringify(metadata).length > 500_000) throw new Error('文章扩展信息超过限制');
  return {
    id: item.id,
    url: normalizedURL(article.url),
    title: limitedString(article.title, '标题', 500),
    source: limitedString(article.source || '', '来源', 500, { optional: true }) || '',
    author: limitedString(article.author || '', '作者', 500, { optional: true }) || '',
    type: limitedString(article.type || 'article', '类型', 100),
    language: limitedString(article.language || 'zh', '语言', 100),
    publishedAt: optionalDate(article.publishedAt, '发布时间'),
    createdAt: optionalDate(article.createdAt, '创建时间'),
    excerpt: limitedString(article.excerpt || '', '摘要', 20_000, { optional: true }) || '',
    content: limitedString(article.content || '', '正文', MAX_ARTICLE_BYTES, { optional: true }) || '',
    summary: limitedString(article.summary || '', '摘要结果', 100_000, { optional: true }) || '',
    isFavorite: Boolean(article.isFavorite),
    isRead: Boolean(article.isRead),
    readingProgress: progress,
    metadata,
    tags: item.tags,
    compatibilityMode: false
  };
}

async function validatePackage(contentDir, extractedEntries = null) {
  let manifest;
  try { manifest = JSON.parse(await readFile(path.join(contentDir, 'manifest.json'), 'utf8')); }
  catch { throw new Error('无法读取 Reader 导出清单'); }
  if (!plainObject(manifest) || manifest.format !== 'reader-markdown-export' || ![2, 3].includes(manifest.formatVersion)) throw new Error('不是受支持的 Reader Markdown 导出包');
  if (!Array.isArray(manifest.articles) || !manifest.articles.length || manifest.articles.length > MAX_ARTICLES) throw new Error(`导入包必须包含 1–${MAX_ARTICLES} 篇文章`);
  const ids = new Set();
  const urls = new Set();
  const expectedFiles = new Set(['manifest.json']);
  const addExpectedFile = (filePath) => {
    if (expectedFiles.has(filePath)) throw new Error('导入包清单包含重复路径');
    expectedFiles.add(filePath);
  };
  if (await exists(path.join(contentDir, 'README.md'))) expectedFiles.add('README.md');
  const normalized = [];
  for (const value of manifest.articles) {
    if (!plainObject(value)) throw new Error('文章清单无效');
    const id = stableId(value.id, '文章 ID');
    if (ids.has(id)) throw new Error('文章清单包含重复 ID');
    ids.add(id);
    const markdownPath = validatePortableEntryPath(limitedString(value.path, 'Markdown 路径', 500));
    if (!markdownPath.startsWith('articles/') || !markdownPath.endsWith('.md')) throw new Error('Markdown 路径无效');
    addExpectedFile(markdownPath);
    const tags = [...new Set((Array.isArray(value.tags) ? value.tags : []).map((tag) => limitedString(tag, '标签', 200)).filter(Boolean))].slice(0, 20);
    const highlights = (Array.isArray(value.highlights) ? value.highlights : []).map(normalizeHighlight);
    if (highlights.length > 500) throw new Error('单篇文章高亮数量超过限制');
    const attachments = (Array.isArray(value.attachments) ? value.attachments : []).map(normalizeAttachment);
    const attachmentIds = new Set();
    for (const attachment of attachments) {
      if (attachmentIds.has(attachment.originalId)) throw new Error('文章包含重复附件 ID');
      attachmentIds.add(attachment.originalId);
      addExpectedFile(attachment.path);
    }
    const item = {
      id,
      title: limitedString(value.title, '标题', 500),
      type: limitedString(value.type || 'article', '类型', 100),
      language: limitedString(value.language || 'zh', '语言', 100),
      originalURL: normalizedURL(value.originalURL),
      originalCollection: value.collection ? limitedString(value.collection, '原资料夹', 500) : null,
      tags, highlights, attachments,
      markdownPath,
      recordPath: null
    };
    if (manifest.formatVersion === 3) {
      item.recordPath = validatePortableEntryPath(limitedString(value.recordPath, '文章记录路径', 500));
      if (!item.recordPath.startsWith('records/') || !item.recordPath.endsWith('.json')) throw new Error('文章记录路径无效');
      addExpectedFile(item.recordPath);
    }
    normalized.push(item);
  }
  const expectedCounts = {
    articles: normalized.length,
    highlights: normalized.reduce((sum, item) => sum + item.highlights.length, 0),
    attachments: normalized.reduce((sum, item) => sum + item.attachments.length, 0),
    attachmentBytes: normalized.reduce((sum, item) => sum + item.attachments.reduce((itemSum, attachment) => itemSum + attachment.byteSize, 0), 0)
  };
  if (!plainObject(manifest.counts) || Object.entries(expectedCounts).some(([key, value]) => Number(manifest.counts[key]) !== value)) throw new Error('导入包统计与文章清单不一致');
  if (extractedEntries) {
    const actualFiles = new Set([...extractedEntries].filter((entry) => !entry.endsWith('/')));
    if (actualFiles.size !== expectedFiles.size || [...actualFiles].some((entry) => !expectedFiles.has(entry))) throw new Error('导入包文件与清单不一致');
  }
  for (const item of normalized) {
    const markdownPath = path.join(contentDir, ...item.markdownPath.split('/'));
    const markdown = await readFile(markdownPath, 'utf8');
    item.article = item.recordPath
      ? normalizeRecord(JSON.parse(await readFile(path.join(contentDir, ...item.recordPath.split('/')), 'utf8')), item)
      : legacyArticle(markdown, item);
    if (item.article.url) {
      if (urls.has(item.article.url)) throw new Error('导入包包含重复原始链接');
      urls.add(item.article.url);
    }
    for (const attachment of item.attachments) {
      const filePath = path.join(contentDir, ...attachment.path.split('/'));
      const info = await stat(filePath);
      if (!info.isFile() || info.size !== attachment.byteSize || await hashFile(filePath) !== attachment.sha256) throw new Error(`附件校验失败：${attachment.fileName}`);
    }
  }
  return { manifest, articles: normalized };
}

async function conflictRows(database, articles) {
  const ids = articles.map((item) => item.id);
  const urls = articles.map((item) => item.article.url).filter(Boolean);
  if (!ids.length) return [];
  const conditions = [`id IN (${ids.map(sqlValue).join(',')})`];
  if (urls.length) conditions.push(`url IN (${urls.map(sqlValue).join(',')})`);
  return await database.query(`SELECT id,url FROM articles WHERE ${conditions.join(' OR ')};`);
}

function publicPreview(id, verified, conflicts) {
  const byId = new Set(conflicts.map((row) => row.id));
  const byURL = new Map(conflicts.filter((row) => row.url).map((row) => [row.url, row.id]));
  return {
    id,
    formatVersion: verified.manifest.formatVersion,
    appVersion: limitedString(verified.manifest.appVersion || '', '导出版本', 100, { optional: true }) || '',
    createdAt: optionalDate(verified.manifest.createdAt, '导出时间'),
    compatibilityMode: verified.manifest.formatVersion === 2,
    counts: {
      articles: verified.articles.length,
      highlights: verified.articles.reduce((sum, item) => sum + item.highlights.length, 0),
      attachments: verified.articles.reduce((sum, item) => sum + item.attachments.length, 0)
    },
    articles: verified.articles.map((item) => {
      const conflict = byId.has(item.id) ? 'duplicate_id' : item.article.url && byURL.has(item.article.url) ? 'duplicate_url' : null;
      return {
        id: item.id,
        title: item.article.title,
        source: item.article.source,
        originalURL: item.article.url,
        originalCollection: item.originalCollection,
        tags: item.article.tags,
        highlights: item.highlights.length,
        attachments: item.attachments.length,
        selectable: !conflict,
        conflict
      };
    })
  };
}

function importsRoot(rootDir) {
  return path.join(rootDir, 'data', 'portable-imports');
}

function importDirectory(rootDir, id) {
  if (!UUID_PATTERN.test(String(id || ''))) throw httpError(404, '导入预览不存在或已过期');
  return path.join(importsRoot(rootDir), `import-${id}`);
}

export async function cleanupPortableImports(rootDir, now = Date.now()) {
  const root = importsRoot(rootDir);
  if (!(await exists(root))) return 0;
  let removed = 0;
  for (const entry of await readdir(root, { withFileTypes: true })) {
    if (!entry.isDirectory() || !/^import-[0-9a-f-]{36}$/i.test(entry.name)) continue;
    const directory = path.join(root, entry.name);
    const info = await stat(directory);
    if (now - info.mtimeMs <= IMPORT_TTL_MS) continue;
    await rm(directory, { recursive: true, force: true });
    removed += 1;
  }
  return removed;
}

export async function stagePortableImport({ request, database, rootDir }) {
  await cleanupPortableImports(rootDir);
  const root = importsRoot(rootDir);
  await mkdir(root, { recursive: true, mode: 0o700 });
  await chmod(root, 0o700);
  const id = randomUUID();
  const directory = importDirectory(rootDir, id);
  await mkdir(directory, { mode: 0o700 });
  try {
    const archivePath = path.join(directory, 'package.zip');
    await stageRequest(request, archivePath);
    const contentDir = path.join(directory, 'content');
    const entries = await extractZipSafely(archivePath, contentDir);
    const verified = await validatePackage(contentDir, entries);
    await writeFile(path.join(directory, 'state.json'), JSON.stringify({ id, createdAt: new Date().toISOString() }), { mode: 0o600 });
    return publicPreview(id, verified, await conflictRows(database, verified.articles));
  } catch (error) {
    await rm(directory, { recursive: true, force: true });
    if (error.code) throw httpError(400, '无法安全读取 Markdown 导入包');
    if (!error.status) error.status = 400;
    throw error;
  }
}

async function verifiedStage(rootDir, id) {
  const directory = importDirectory(rootDir, id);
  let state;
  try { state = JSON.parse(await readFile(path.join(directory, 'state.json'), 'utf8')); }
  catch { throw httpError(404, '导入预览不存在或已过期'); }
  if (state.id !== id || !Number.isFinite(Date.parse(state.createdAt)) || Date.now() - Date.parse(state.createdAt) > IMPORT_TTL_MS) {
    await rm(directory, { recursive: true, force: true });
    throw httpError(410, '导入预览已过期，请重新选择文件');
  }
  try {
    return { directory, verified: await validatePackage(path.join(directory, 'content')) };
  } catch (error) {
    if (error.code) throw httpError(400, 'Markdown 导入包暂存内容不完整，请重新选择文件');
    if (!error.status) error.status = 400;
    throw error;
  }
}

async function ensureStoredAttachment(source, attachment, filesDir) {
  await mkdir(filesDir, { recursive: true, mode: 0o700 });
  const extension = path.extname(attachment.fileName).toLowerCase().slice(0, 12);
  const storageName = `${attachment.sha256}${extension}`;
  const destination = path.join(filesDir, storageName);
  let created = false;
  try {
    await copyFile(source, destination, fsConstants.COPYFILE_EXCL);
    await chmod(destination, 0o600);
    created = true;
  } catch (error) {
    if (error.code !== 'EEXIST') throw error;
    const info = await stat(destination);
    if (info.size !== attachment.byteSize || await hashFile(destination) !== attachment.sha256) throw httpError(409, `本地附件校验冲突：${attachment.fileName}`);
  }
  return { storageName, created };
}

function rewriteAttachmentLinks(content, item, createdAttachments) {
  let result = String(content || '');
  for (let index = 0; index < item.attachments.length; index += 1) {
    const exported = item.attachments[index];
    const created = createdAttachments[index];
    const contentURL = `/api/attachments/${created.id}/content`;
    result = result.replaceAll(`/api/attachments/${exported.originalId}/content`, contentURL);
    result = result.replaceAll(`/api/attachments/${exported.originalId}/thumbnail`, contentURL);
    result = result.replaceAll(`../${exported.path}`, contentURL);
  }
  return result;
}

export async function commitPortableImport({ database, rootDir, filesDir, id, articleIds, collectionId = 'inbox' }) {
  const selected = [...new Set((Array.isArray(articleIds) ? articleIds : []).map((value) => String(value).trim()).filter(Boolean))];
  if (!selected.length || selected.length > MAX_ARTICLES) throw httpError(400, `请选择 1–${MAX_ARTICLES} 篇文章`);
  const collection = await database.one(`SELECT id FROM collections WHERE id=${sqlValue(collectionId)};`);
  if (!collection) throw httpError(400, '目标资料夹不存在');
  const { directory, verified } = await verifiedStage(rootDir, id);
  const articlesById = new Map(verified.articles.map((item) => [item.id, item]));
  if (selected.some((articleId) => !articlesById.has(articleId))) throw httpError(400, '选择中包含导入包以外的文章');
  const selectedArticles = selected.map((articleId) => articlesById.get(articleId));
  const conflicts = await conflictRows(database, selectedArticles);
  const conflictIds = new Set(conflicts.map((row) => row.id));
  const conflictURLs = new Set(conflicts.filter((row) => row.url).map((row) => row.url));
  const results = [];
  try {
    for (const item of selectedArticles) {
      if (conflictIds.has(item.id) || (item.article.url && conflictURLs.has(item.article.url))) {
        results.push({ id: item.id, title: item.article.title, status: 'skipped', reason: conflictIds.has(item.id) ? 'duplicate_id' : 'duplicate_url' });
        continue;
      }
      let articleCreated = false;
      const stored = [];
      try {
        const importedAt = new Date().toISOString();
        await database.createArticle({
          id: item.id,
          url: item.article.url,
          title: item.article.title,
          source: item.article.source,
          author: item.article.author,
          type: item.article.type,
          language: item.article.language,
          published_at: item.article.publishedAt,
          excerpt: item.article.excerpt,
          content: item.article.content,
          summary: item.article.summary,
          is_favorite: item.article.isFavorite,
          is_read: item.article.isRead,
          reading_progress: item.article.readingProgress,
          collection_id: collectionId,
          metadata: {
            ...item.article.metadata,
            portableImport: {
              formatVersion: verified.manifest.formatVersion,
              importedAt,
              originalCreatedAt: item.article.createdAt,
              compatibilityMode: item.article.compatibilityMode
            }
          }
        });
        articleCreated = true;
        const createdAttachments = [];
        for (const attachment of item.attachments) {
          const source = path.join(directory, 'content', ...attachment.path.split('/'));
          const storage = await ensureStoredAttachment(source, attachment, filesDir);
          stored.push(storage);
          createdAttachments.push(await database.createAttachment({
            articleId: item.id,
            fileName: attachment.fileName,
            storageName: storage.storageName,
            mimeType: attachment.mimeType,
            byteSize: attachment.byteSize,
            sha256: attachment.sha256
          }));
        }
        const rewritten = rewriteAttachmentLinks(item.article.content, item, createdAttachments);
        if (rewritten !== item.article.content) {
          await database.finalizeImportedArticle(item.id, {
            content: rewritten,
            metadata: {
              ...item.article.metadata,
              portableImport: {
                formatVersion: verified.manifest.formatVersion,
                importedAt,
                originalCreatedAt: item.article.createdAt,
                compatibilityMode: item.article.compatibilityMode
              }
            }
          });
        }
        if (item.article.tags.length) await database.addTags(item.id, item.article.tags);
        for (const highlight of item.highlights) await database.createHighlight({ articleId: item.id, ...highlight });
        results.push({ id: item.id, title: item.article.title, status: 'imported' });
      } catch (error) {
        if (articleCreated) await database.execute(`BEGIN IMMEDIATE;
          DELETE FROM articles WHERE id=${sqlValue(item.id)};
          DELETE FROM tags WHERE NOT EXISTS (SELECT 1 FROM article_tags at WHERE at.tag_id=tags.id);
          COMMIT;`).catch(() => {});
        for (const file of stored.filter((entry) => entry.created)) {
          const inUse = await database.one(`SELECT count(*) AS count FROM attachments WHERE storage_name=${sqlValue(file.storageName)};`).catch(() => ({ count: 1 }));
          if (!Number(inUse?.count || 0)) await unlink(path.join(filesDir, file.storageName)).catch(() => {});
        }
        results.push({ id: item.id, title: item.article.title, status: 'failed', reason: error.code ? '本地写入失败' : error.message || '导入失败' });
      }
    }
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
  return {
    imported: results.filter((item) => item.status === 'imported').length,
    skipped: results.filter((item) => item.status === 'skipped').length,
    failed: results.filter((item) => item.status === 'failed').length,
    results
  };
}

export async function cancelPortableImport(rootDir, id) {
  const directory = importDirectory(rootDir, id);
  if (!(await exists(directory))) return false;
  await rm(directory, { recursive: true, force: true });
  return true;
}
