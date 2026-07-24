import path from 'node:path';
import { randomUUID } from 'node:crypto';
import { access, mkdir, rename, unlink, writeFile } from 'node:fs/promises';
import { renderThumbnailInProcess } from './parser-process.mjs';

const activeRenders = new Map();

async function exists(filePath) {
  try { await access(filePath); return true; }
  catch { return false; }
}

export function supportsAttachmentThumbnail(mimeType) {
  return String(mimeType || '').startsWith('image/') || mimeType === 'application/pdf';
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
      const output = await renderThumbnailInProcess(sourcePath, attachment.mime_type);
      await writeFile(temporary, output, { flag: 'wx', mode: 0o600 });
      await rename(temporary, destination);
      return { path: destination, contentType: 'image/webp', fileName };
    } finally { await unlink(temporary).catch(() => {}); }
  })();
  activeRenders.set(destination, rendering);
  try { return await rendering; }
  finally { activeRenders.delete(destination); }
}
