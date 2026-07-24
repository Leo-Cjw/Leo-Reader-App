import path from 'node:path';
import { randomUUID } from 'node:crypto';
import { access, mkdir, readFile, rename, stat, unlink, writeFile } from 'node:fs/promises';
import { fileURLToPath } from 'node:url';
import { createCanvas, loadImage } from '@napi-rs/canvas';

const THUMBNAIL_WIDTH = 640;
const THUMBNAIL_HEIGHT = 360;
const MAX_THUMBNAIL_SOURCE_BYTES = 100 * 1024 * 1024;
const activeRenders = new Map();

async function exists(filePath) {
  try { await access(filePath); return true; }
  catch { return false; }
}

export function supportsAttachmentThumbnail(mimeType) {
  return String(mimeType || '').startsWith('image/') || mimeType === 'application/pdf';
}

function paintBackground(context) {
  context.fillStyle = '#ebe9e2';
  context.fillRect(0, 0, THUMBNAIL_WIDTH, THUMBNAIL_HEIGHT);
}

async function renderImage(sourcePath) {
  const image = await loadImage(sourcePath);
  if (!image.width || !image.height || image.width * image.height > 160_000_000) throw new Error('图片尺寸超过缩略图安全限制');
  const canvas = createCanvas(THUMBNAIL_WIDTH, THUMBNAIL_HEIGHT);
  const context = canvas.getContext('2d');
  paintBackground(context);
  const sourceRatio = image.width / image.height;
  const targetRatio = THUMBNAIL_WIDTH / THUMBNAIL_HEIGHT;
  let sourceX = 0; let sourceY = 0; let sourceWidth = image.width; let sourceHeight = image.height;
  if (sourceRatio > targetRatio) {
    sourceWidth = image.height * targetRatio;
    sourceX = (image.width - sourceWidth) / 2;
  } else {
    sourceHeight = image.width / targetRatio;
    sourceY = (image.height - sourceHeight) / 2;
  }
  context.drawImage(image, sourceX, sourceY, sourceWidth, sourceHeight, 0, 0, THUMBNAIL_WIDTH, THUMBNAIL_HEIGHT);
  return canvas.toBuffer('image/webp', 84);
}

async function renderPDF(sourcePath) {
  const bytes = await readFile(sourcePath);
  const pdfjs = await import('pdfjs-dist/legacy/build/pdf.mjs');
  const standardFontDataUrl = `${fileURLToPath(new URL('../../node_modules/pdfjs-dist/standard_fonts/', import.meta.url))}${path.sep}`;
  const document = await pdfjs.getDocument({ data: new Uint8Array(bytes), isEvalSupported: false, useSystemFonts: true, standardFontDataUrl }).promise;
  try {
    const page = await document.getPage(1);
    const natural = page.getViewport({ scale: 1 });
    const availableWidth = THUMBNAIL_WIDTH - 56;
    const availableHeight = THUMBNAIL_HEIGHT - 36;
    const scale = Math.min(availableWidth / natural.width, availableHeight / natural.height);
    const viewport = page.getViewport({ scale });
    const canvas = createCanvas(THUMBNAIL_WIDTH, THUMBNAIL_HEIGHT);
    const context = canvas.getContext('2d');
    paintBackground(context);
    context.fillStyle = '#ffffff';
    const x = Math.round((THUMBNAIL_WIDTH - viewport.width) / 2);
    const y = Math.round((THUMBNAIL_HEIGHT - viewport.height) / 2);
    context.fillRect(x, y, Math.ceil(viewport.width), Math.ceil(viewport.height));
    await page.render({ canvasContext: context, viewport, transform: [1, 0, 0, 1, x, y] }).promise;
    return canvas.toBuffer('image/webp', 88);
  } finally { await document.destroy(); }
}

async function renderThumbnail(sourcePath, mimeType) {
  const info = await stat(sourcePath);
  if (!info.isFile() || info.size > MAX_THUMBNAIL_SOURCE_BYTES) throw Object.assign(new Error('附件超过缩略图处理限制'), { status: 413 });
  if (mimeType === 'application/pdf') return await renderPDF(sourcePath);
  if (String(mimeType).startsWith('image/')) return await renderImage(sourcePath);
  throw Object.assign(new Error('该附件不支持静态缩略图'), { status: 415 });
}

export async function getAttachmentThumbnail({ attachment, sourcePath, thumbnailsDir }) {
  if (!supportsAttachmentThumbnail(attachment.mime_type)) throw Object.assign(new Error('该附件不支持静态缩略图'), { status: 415 });
  if (!/^[0-9a-f]{64}$/i.test(String(attachment.sha256 || ''))) throw Object.assign(new Error('附件哈希无效'), { status: 400 });
  await mkdir(thumbnailsDir, { recursive: true });
  const fileName = `${attachment.sha256}.reader-thumb-v2.webp`;
  const destination = path.join(thumbnailsDir, fileName);
  if (await exists(destination)) return { path: destination, contentType: 'image/webp', fileName };
  const current = activeRenders.get(destination);
  if (current) return await current;
  const rendering = (async () => {
    const temporary = path.join(thumbnailsDir, `${randomUUID()}.thumbnail`);
    try {
      const output = await renderThumbnail(sourcePath, attachment.mime_type);
      await writeFile(temporary, output, { flag: 'wx', mode: 0o600 });
      await rename(temporary, destination);
      return { path: destination, contentType: 'image/webp', fileName };
    } finally { await unlink(temporary).catch(() => {}); }
  })();
  activeRenders.set(destination, rendering);
  try { return await rendering; }
  finally { activeRenders.delete(destination); }
}
