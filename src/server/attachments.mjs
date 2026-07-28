import path from 'node:path';
import { createHash, randomUUID } from 'node:crypto';
import { access, mkdir, open, readFile, rename, unlink } from 'node:fs/promises';
import { safeFetchImage, validateImageSignature } from './importers.mjs';
import { extractPDFTextInProcess } from './parser-process.mjs';

export const MAX_UPLOAD_BYTES = 100 * 1024 * 1024;
export const MAX_EDITOR_IMAGE_BYTES = 20 * 1024 * 1024;

const textTypes = new Set(['text/plain', 'text/markdown', 'text/x-markdown']);
const supportedExtensions = new Set(['.pdf', '.png', '.jpg', '.jpeg', '.gif', '.webp', '.avif', '.heic', '.mp4', '.mov', '.m4v', '.webm', '.mp3', '.m4a', '.aac', '.wav', '.txt', '.md', '.markdown']);
const supportedImageTypes = /^image\/(png|jpe?g|webp|gif|avif|heic)$/;
const supportedAudioTypes = new Set(['audio/mpeg', 'audio/mp3', 'audio/mp4', 'audio/x-m4a', 'audio/aac', 'audio/wav', 'audio/x-wav']);
const imageExtensions = { 'image/png': '.png', 'image/jpeg': '.jpg', 'image/jpg': '.jpg', 'image/webp': '.webp', 'image/gif': '.gif', 'image/avif': '.avif', 'image/heic': '.heic' };
const imageTypesByExtension = { '.png': 'image/png', '.jpg': 'image/jpeg', '.jpeg': 'image/jpeg', '.webp': 'image/webp', '.gif': 'image/gif', '.avif': 'image/avif', '.heic': 'image/heic' };
const audioTypesByExtension = { '.mp3': 'audio/mpeg', '.m4a': 'audio/mp4', '.aac': 'audio/aac', '.wav': 'audio/wav' };

export function sanitizeFileName(value) {
  const cleaned = path.basename(String(value || 'attachment'))
    .replace(/[\u0000-\u001f\u007f/\\:]/g, '-')
    .replace(/\s+/g, ' ')
    .trim();
  return (cleaned || 'attachment').slice(0, 180);
}

export function validateAttachmentType(fileName, mimeType) {
  const extension = path.extname(fileName).toLowerCase();
  const declared = String(mimeType || 'application/octet-stream').split(';')[0].trim().toLowerCase();
  const normalized = declared === 'application/octet-stream' && audioTypesByExtension[extension] ? audioTypesByExtension[extension] : declared;
  const supported = normalized === 'application/pdf' || supportedImageTypes.test(normalized) || normalized.startsWith('video/') || supportedAudioTypes.has(normalized) || textTypes.has(normalized) || (normalized === 'application/octet-stream' && supportedExtensions.has(extension));
  if (!supported) throw Object.assign(new Error('暂不支持该附件格式'), { status: 415 });
  return normalized;
}

export function validateAudioSignature(bytes, mimeType) {
  const data = Buffer.from(bytes || []);
  if (mimeType === 'audio/mpeg' || mimeType === 'audio/mp3') {
    return data.subarray(0, 3).toString('ascii') === 'ID3' || (data[0] === 0xff && (data[1] & 0xe0) === 0xe0);
  }
  if (mimeType === 'audio/mp4' || mimeType === 'audio/x-m4a') return data.length >= 12 && data.subarray(4, 8).toString('ascii') === 'ftyp';
  if (mimeType === 'audio/aac') return data.length >= 2 && data[0] === 0xff && (data[1] & 0xf6) === 0xf0;
  if (mimeType === 'audio/wav' || mimeType === 'audio/x-wav') return data.length >= 12 && data.subarray(0, 4).toString('ascii') === 'RIFF' && data.subarray(8, 12).toString('ascii') === 'WAVE';
  return false;
}

async function validateStagedMediaSignature(filePath, mimeType) {
  if (!supportedAudioTypes.has(mimeType)) return;
  const handle = await open(filePath, 'r');
  try {
    const header = Buffer.alloc(16);
    const { bytesRead } = await handle.read(header, 0, header.length, 0);
    if (!validateAudioSignature(header.subarray(0, bytesRead), mimeType)) {
      throw Object.assign(new Error('音频内容与 MIME 类型不一致'), { status: 415 });
    }
  } finally {
    await handle.close();
  }
}

export async function stageAttachment(request, { stagingDir, fileName, mimeType, maxBytes = MAX_UPLOAD_BYTES }) {
  await mkdir(stagingDir, { recursive: true });
  const safeName = sanitizeFileName(fileName);
  const safeType = validateAttachmentType(safeName, mimeType);
  const tempPath = path.join(stagingDir, `${randomUUID()}.upload`);
  const handle = await open(tempPath, 'wx', 0o600);
  const hash = createHash('sha256');
  let byteSize = 0;
  try {
    for await (const chunk of request) {
      byteSize += chunk.length;
      if (byteSize > maxBytes) throw Object.assign(new Error(`附件不能超过 ${Math.round(maxBytes / 1024 / 1024)} MB`), { status: 413 });
      hash.update(chunk);
      await handle.write(chunk);
    }
  } catch (error) {
    await handle.close().catch(() => {});
    await unlink(tempPath).catch(() => {});
    throw error;
  }
  await handle.close();
  if (!byteSize) {
    await unlink(tempPath).catch(() => {});
    throw Object.assign(new Error('附件为空'), { status: 400 });
  }
  try {
    await validateStagedMediaSignature(tempPath, safeType);
  } catch (error) {
    await unlink(tempPath).catch(() => {});
    throw error;
  }
  return { tempPath, fileName: safeName, mimeType: safeType, byteSize, sha256: hash.digest('hex') };
}

async function pathExists(filePath) {
  try { await access(filePath); return true; }
  catch { return false; }
}

async function extractText(filePath, mimeType) {
  if (mimeType === 'application/pdf') return await extractPDFTextInProcess(filePath);
  if (textTypes.has(mimeType)) return (await readFile(filePath, 'utf8')).slice(0, 1_000_000);
  return '';
}

function articleType(mimeType) {
  if (mimeType === 'application/pdf') return 'pdf';
  if (mimeType.startsWith('image/')) return 'image';
  if (mimeType.startsWith('video/')) return 'video';
  if (mimeType.startsWith('audio/')) return 'audio';
  if (textTypes.has(mimeType)) return 'markdown';
  return 'attachment';
}

function plainTextExcerpt(content) {
  return content
    .replace(/^#{1,6}\s+/gm, '')
    .replace(/^\s*[-*+]\s+/gm, '')
    .replace(/^\s*\d+[.)]\s+/gm, '')
    .replace(/!\[([^\]]*)\]\([^)]*\)/g, '$1')
    .replace(/\[([^\]]+)\]\([^)]*\)/g, '$1')
    .replace(/[`*_~>|]/g, '')
    .replace(/\s+/g, ' ')
    .trim();
}

export async function importStagedAttachment(database, payload, { stagingDir, filesDir }) {
  const tempPath = path.resolve(String(payload.tempPath || ''));
  const safeStaging = `${path.resolve(stagingDir)}${path.sep}`;
  if (!tempPath.startsWith(safeStaging)) throw new Error('附件暂存路径无效');
  await mkdir(filesDir, { recursive: true });
  const extension = path.extname(payload.fileName).toLowerCase().slice(0, 12);
  const storageName = `${payload.sha256}${extension}`;
  const destination = path.join(filesDir, storageName);
  const stagedExists = await pathExists(tempPath);
  const storedExists = await pathExists(destination);
  if (!stagedExists && !storedExists) throw new Error('附件暂存文件不存在');
  if (stagedExists) await validateStagedMediaSignature(tempPath, payload.mimeType);
  const content = await extractText(stagedExists ? tempPath : destination, payload.mimeType);
  if (stagedExists) {
    if (storedExists) await unlink(tempPath);
    else await rename(tempPath, destination);
  }
  const fallbackExcerpt = payload.mimeType === 'application/pdf' ? '本地 PDF 文档' : payload.mimeType.startsWith('image/') ? '本地图片附件' : payload.mimeType.startsWith('video/') ? '本地视频附件' : payload.mimeType.startsWith('audio/') ? '本地音频附件' : '本地附件';
  const excerpt = plainTextExcerpt(content).slice(0, 220) || fallbackExcerpt;
  const articleId = `attachment-${payload.sha256}`;
  let article = await database.getArticle(articleId);
  if (!article) {
    article = await database.createArticle({
      id: articleId,
      title: path.basename(payload.fileName, path.extname(payload.fileName)) || payload.fileName,
      source: '本地附件',
      author: '我',
      type: articleType(payload.mimeType),
      language: /[\u3400-\u9fff]/.test(content.slice(0, 1000)) ? 'zh' : 'en',
      excerpt,
      content,
      collection_id: payload.collectionId || 'inbox',
      metadata: { originalFileName: payload.fileName, mimeType: payload.mimeType, byteSize: payload.byteSize, sha256: payload.sha256 }
    });
  }
  if (!article.attachments?.some((item) => item.sha256 === payload.sha256)) {
    await database.createAttachment({ articleId: article.id, fileName: payload.fileName, storageName, mimeType: payload.mimeType, byteSize: payload.byteSize, sha256: payload.sha256 });
  }
  return await database.getArticle(article.id);
}

export async function attachStagedImage(database, articleId, payload, { stagingDir, filesDir }) {
  const tempPath = path.resolve(String(payload.tempPath || ''));
  const safeStaging = `${path.resolve(stagingDir)}${path.sep}`;
  if (!tempPath.startsWith(safeStaging)) throw Object.assign(new Error('图片暂存路径无效'), { status: 400 });
  try {
    const article = await database.getArticle(articleId);
    if (!article) throw Object.assign(new Error('内容不存在'), { status: 404 });
    const mimeType = payload.mimeType === 'application/octet-stream' ? imageTypesByExtension[path.extname(payload.fileName).toLowerCase()] : payload.mimeType;
    if (!supportedImageTypes.test(mimeType) || !imageExtensions[mimeType]) throw Object.assign(new Error('编辑器只接受 PNG、JPEG、WebP、GIF、AVIF 或 HEIC 图片'), { status: 415 });
    const bytes = await readFile(tempPath);
    if (!validateImageSignature(bytes, mimeType)) throw Object.assign(new Error('图片内容与 MIME 类型不一致'), { status: 415 });
    await mkdir(filesDir, { recursive: true });
    const storageName = `${payload.sha256}${imageExtensions[mimeType]}`;
    const destination = path.join(filesDir, storageName);
    const existing = article.attachments?.find((attachment) => attachment.sha256 === payload.sha256);
    if (existing) {
      await unlink(tempPath).catch(() => {});
      return { article, attachment: existing, duplicate: true };
    }
    if (await pathExists(destination)) await unlink(tempPath);
    else await rename(tempPath, destination);
    const created = await database.createAttachment({ articleId, fileName: payload.fileName, storageName, mimeType, byteSize: payload.byteSize, sha256: payload.sha256 });
    const updated = await database.getArticle(articleId);
    return { article: updated, attachment: updated.attachments.find((attachment) => attachment.id === created.id), duplicate: false };
  } catch (error) {
    await unlink(tempPath).catch(() => {});
    throw error;
  }
}

export async function storeRemoteImage(database, article, remoteURL, { filesDir, fetchImage = safeFetchImage, fileName = '网页图片' } = {}) {
  if (!remoteURL) return null;
  const image = await fetchImage(remoteURL);
  const sha256 = createHash('sha256').update(image.bytes).digest('hex');
  const extension = imageExtensions[image.contentType];
  if (!extension) throw new Error('远程图片格式不受支持');
  await mkdir(filesDir, { recursive: true });
  const storageName = `${sha256}${extension}`;
  const destination = path.join(filesDir, storageName);
  if (!(await pathExists(destination))) {
    const temporary = path.join(filesDir, `${randomUUID()}.image`);
    const handle = await open(temporary, 'wx', 0o600);
    try { await handle.write(image.bytes); await handle.close(); await rename(temporary, destination); }
    catch (error) { await handle.close().catch(() => {}); await unlink(temporary).catch(() => {}); throw error; }
  }
  const current = await database.getArticle(article.id);
  const existing = current.attachments?.find((item) => item.sha256 === sha256);
  if (existing) return existing;
  const created = await database.createAttachment({ articleId: article.id, fileName: `${sanitizeFileName(fileName)}${extension}`, storageName, mimeType: image.contentType, byteSize: image.bytes.length, sha256 });
  return { ...created, url: `/api/attachments/${created.id}/content` };
}

export async function localizeRemoteImage(database, article, remoteURL, options = {}) {
  if (!remoteURL) return article;
  if (article.attachments?.some((item) => item.mime_type?.startsWith('image/'))) return article;
  await storeRemoteImage(database, article, remoteURL, { ...options, fileName: '网页主图' });
  return await database.getArticle(article.id);
}
