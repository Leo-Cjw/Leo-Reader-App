import path from 'node:path';
import { createHash } from 'node:crypto';
import { constants as fsConstants } from 'node:fs';
import { chmod, lstat, mkdir, open, readdir, unlink } from 'node:fs/promises';
import { MAX_UPLOAD_BYTES, sanitizeFileName, validateAttachmentType } from '../src/server/attachments.mjs';

export const SHARED_FILE_TOKEN_PATTERN = /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/;
export const SHARED_FILE_TTL_MS = 24 * 60 * 60 * 1_000;

export function standardShareStagingRoot(homeDirectory) {
  return path.join(
    path.resolve(homeDirectory),
    'Library',
    'Containers',
    'com.reader.localfirst.share-extension',
    'Data',
    'Library',
    'Caches',
    'ReaderShareStaging'
  );
}

export function normalizeSharedFileToken(value) {
  return typeof value === 'string' && SHARED_FILE_TOKEN_PATTERN.test(value) ? value : null;
}

function sharedFilePaths(stagingRoot, token) {
  return {
    manifest: path.join(stagingRoot, `${token}.json`),
    payload: path.join(stagingRoot, `${token}.payload`)
  };
}

async function hashHandle(handle) {
  const hash = createHash('sha256');
  for await (const chunk of handle.createReadStream({ autoClose: false, start: 0 })) hash.update(chunk);
  return hash.digest('hex');
}

function normalizeManifest(value, token) {
  if (!value || typeof value !== 'object' || Array.isArray(value)
    || Object.keys(value).sort().join(',') !== 'byteSize,createdAt,fileName,mimeType,sha256,token,version'
    || value.version !== 1
    || value.token !== token
    || typeof value.fileName !== 'string'
    || typeof value.mimeType !== 'string'
    || !Number.isSafeInteger(value.byteSize)
    || value.byteSize <= 0
    || value.byteSize > MAX_UPLOAD_BYTES
    || !/^[0-9a-f]{64}$/.test(value.sha256)
    || typeof value.createdAt !== 'string'
    || !Number.isFinite(Date.parse(value.createdAt))) {
    throw new Error('分享文件描述无效');
  }
  const fileName = sanitizeFileName(value.fileName);
  const mimeType = validateAttachmentType(fileName, value.mimeType);
  return { ...value, fileName, mimeType };
}

function publicSharedFileError(error, fallback) {
  const message = error instanceof Error ? error.message : '';
  return /^(分享文件|Reader 本地服务|目标资料夹|暂不支持)/.test(message)
    ? error
    : new Error(fallback);
}

export function createSharedFileManager({ stagingRoot, appOrigin, fetchImpl = globalThis.fetch, now = Date.now }) {
  const root = path.resolve(stagingRoot);

  async function ensureRoot() {
    await mkdir(root, { recursive: true, mode: 0o700 });
    const info = await lstat(root);
    if (!info.isDirectory() || info.isSymbolicLink()) throw new Error('分享文件暂存目录无效');
    await chmod(root, 0o700);
  }

  async function openVerified(tokenValue) {
    const token = normalizeSharedFileToken(tokenValue);
    if (!token) throw new Error('分享文件标识无效');
    await ensureRoot();
    const paths = sharedFilePaths(root, token);
    const manifestHandle = await open(paths.manifest, fsConstants.O_RDONLY | fsConstants.O_NOFOLLOW);
    let decoded;
    try {
      const info = await manifestHandle.stat();
      if (!info.isFile() || info.size <= 0 || info.size > 4_096 || (info.mode & 0o077) !== 0) {
        throw new Error('分享文件暂存状态无效');
      }
      decoded = JSON.parse(await manifestHandle.readFile('utf8'));
    } catch {
      throw new Error('分享文件描述无效');
    } finally {
      await manifestHandle.close().catch(() => {});
    }
    const manifest = normalizeManifest(decoded, token);
    const age = now() - Date.parse(manifest.createdAt);
    if (age < -5 * 60 * 1_000 || age >= SHARED_FILE_TTL_MS) throw new Error('分享文件已过期');
    const handle = await open(paths.payload, fsConstants.O_RDONLY | fsConstants.O_NOFOLLOW);
    try {
      const info = await handle.stat();
      if (!info.isFile() || info.size !== manifest.byteSize || info.size > MAX_UPLOAD_BYTES || (info.mode & 0o077) !== 0) {
        throw new Error('分享文件暂存状态无效');
      }
      if (await hashHandle(handle) !== manifest.sha256) throw new Error('分享文件完整性校验失败');
      return { token, paths, manifest, handle };
    } catch (error) {
      await handle.close().catch(() => {});
      throw error;
    }
  }

  async function inspect(token) {
    try {
      const verified = await openVerified(token);
      await verified.handle.close();
      return {
        token: verified.token,
        name: verified.manifest.fileName,
        size: verified.manifest.byteSize,
        mimeType: verified.manifest.mimeType
      };
    } catch (error) {
      throw publicSharedFileError(error, '分享文件不可用或已经过期');
    }
  }

  async function discard(tokenValue) {
    const token = normalizeSharedFileToken(tokenValue);
    if (!token) return false;
    const paths = sharedFilePaths(root, token);
    const results = await Promise.allSettled([unlink(paths.payload), unlink(paths.manifest)]);
    return results.some((result) => result.status === 'fulfilled');
  }

  async function upload(token, collectionId = 'inbox') {
    try {
      if (typeof appOrigin !== 'string' || !/^http:\/\/127\.0\.0\.1:\d+$/.test(appOrigin)) throw new Error('Reader 本地服务尚未就绪');
      if (typeof collectionId !== 'string' || !collectionId || collectionId.length > 200 || /[\u0000-\u001f\u007f]/.test(collectionId)) {
        throw new Error('目标资料夹无效');
      }
      const verified = await openVerified(token);
      let response;
      try {
        const params = new URLSearchParams({ collection: collectionId });
        response = await fetchImpl(`${appOrigin}/api/import-jobs/upload?${params}`, {
          method: 'POST',
          body: verified.handle.createReadStream({ autoClose: false, start: 0 }),
          duplex: 'half',
          headers: {
            'content-length': String(verified.manifest.byteSize),
            'content-type': verified.manifest.mimeType,
            'x-reader-filename': encodeURIComponent(verified.manifest.fileName)
          }
        });
      } finally {
        await verified.handle.close().catch(() => {});
      }
      const payload = await response.json().catch(() => ({}));
      if (!response.ok || !payload?.job) throw new Error(`分享文件导入失败 (${response.status})`);
      await discard(verified.token);
      return payload.job;
    } catch (error) {
      throw publicSharedFileError(error, '分享文件导入失败，请重试');
    }
  }

  async function cleanupExpired() {
    await ensureRoot();
    const cutoff = now() - SHARED_FILE_TTL_MS;
    const tokens = new Set();
    for (const entry of await readdir(root, { withFileTypes: true })) {
      if (!entry.isFile() && !entry.isSymbolicLink()) continue;
      const match = entry.name.match(/^([0-9a-f-]{36})\.(?:json|payload)$/);
      if (match && normalizeSharedFileToken(match[1])) tokens.add(match[1]);
    }
    let removed = 0;
    for (const token of tokens) {
      const paths = sharedFilePaths(root, token);
      const ages = await Promise.allSettled([lstat(paths.manifest), lstat(paths.payload)]);
      const newest = Math.max(...ages.filter((item) => item.status === 'fulfilled').map((item) => item.value.mtimeMs));
      if (!Number.isFinite(newest) || newest > cutoff) continue;
      if (await discard(token)) removed += 1;
    }
    return removed;
  }

  return Object.freeze({ inspect, upload, discard, cleanupExpired });
}
