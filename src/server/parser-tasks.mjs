import path from 'node:path';
import { readFile, stat } from 'node:fs/promises';
import { fileURLToPath } from 'node:url';

const THUMBNAIL_WIDTH = 640;
const THUMBNAIL_HEIGHT = 360;
const MAX_SOURCE_BYTES = 100 * 1024 * 1024;

async function checkedSource(sourcePath) {
  if (typeof sourcePath !== 'string' || !path.isAbsolute(sourcePath) || sourcePath.length > 4096) {
    throw Object.assign(new Error('解析文件路径无效'), { status: 400 });
  }
  const info = await stat(sourcePath);
  if (!info.isFile() || info.size > MAX_SOURCE_BYTES) throw Object.assign(new Error('附件超过解析安全限制'), { status: 413 });
  return info;
}

export async function extractPDFText(sourcePath) {
  await checkedSource(sourcePath);
  const bytes = await readFile(sourcePath);
  const pdfjs = await import('pdfjs-dist/legacy/build/pdf.mjs');
  const document = await pdfjs.getDocument({ data: new Uint8Array(bytes), isEvalSupported: false, useSystemFonts: true }).promise;
  const pages = [];
  let length = 0;
  try {
    const maxPages = Math.min(document.numPages, 250);
    for (let pageNumber = 1; pageNumber <= maxPages; pageNumber += 1) {
      const page = await document.getPage(pageNumber);
      const content = await page.getTextContent();
      const text = content.items.map((item) => 'str' in item ? item.str : '').join(' ').replace(/\s+/g, ' ').trim();
      if (text) {
        pages.push(text);
        length += text.length + 2;
      }
      if (length > 1_000_000) break;
    }
    return pages.join('\n\n').slice(0, 1_000_000);
  } finally { await document.destroy(); }
}

function paintBackground(context) {
  context.fillStyle = '#ebe9e2';
  context.fillRect(0, 0, THUMBNAIL_WIDTH, THUMBNAIL_HEIGHT);
}

async function renderImage(sourcePath) {
  const { createCanvas, loadImage } = await import('@napi-rs/canvas');
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
  const [{ createCanvas }, pdfjs] = await Promise.all([
    import('@napi-rs/canvas'),
    import('pdfjs-dist/legacy/build/pdf.mjs')
  ]);
  const bytes = await readFile(sourcePath);
  const standardFontDataUrl = `${fileURLToPath(new URL('../../node_modules/pdfjs-dist/standard_fonts/', import.meta.url))}${path.sep}`;
  const document = await pdfjs.getDocument({ data: new Uint8Array(bytes), isEvalSupported: false, useSystemFonts: true, standardFontDataUrl }).promise;
  try {
    const page = await document.getPage(1);
    const natural = page.getViewport({ scale: 1 });
    if (!Number.isFinite(natural.width) || !Number.isFinite(natural.height) || natural.width <= 0 || natural.height <= 0 || natural.width > 100_000 || natural.height > 100_000) {
      throw new Error('PDF 页面尺寸超过缩略图安全限制');
    }
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

export async function renderThumbnail(sourcePath, mimeType) {
  await checkedSource(sourcePath);
  if (mimeType === 'application/pdf') return await renderPDF(sourcePath);
  if (String(mimeType).startsWith('image/')) return await renderImage(sourcePath);
  throw Object.assign(new Error('该附件不支持静态缩略图'), { status: 415 });
}
