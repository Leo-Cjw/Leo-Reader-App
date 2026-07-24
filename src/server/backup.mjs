import path from 'node:path';
import { createCipheriv, createDecipheriv, createHash, randomBytes, randomUUID, scrypt } from 'node:crypto';
import { createReadStream, createWriteStream } from 'node:fs';
import { access, cp, mkdir, mkdtemp, open, readFile, readdir, rename, rm, stat, unlink, writeFile } from 'node:fs/promises';
import { once } from 'node:events';
import { pipeline } from 'node:stream/promises';
import { spawn } from 'node:child_process';
import archiver from 'archiver';
import yauzl from 'yauzl';
import { SCHEMA_VERSION } from './schema.mjs';
import { sqlValue } from './db.mjs';

const SQLITE_BINARY = process.env.READER_SQLITE_BINARY || '/usr/bin/sqlite3';
export const MAX_BACKUP_BYTES = 2 * 1024 * 1024 * 1024;
const MAX_EXTRACTED_BYTES = 5 * 1024 * 1024 * 1024;
const MAX_ARCHIVE_ENTRIES = 100_000;
const ENCRYPTED_MAGIC = Buffer.from('RDRBKENC');
const ENCRYPTED_VERSION = 1;
const ENCRYPTED_HEADER_BYTES = 40;
const ENCRYPTED_TAG_BYTES = 16;
const SCRYPT_LOG_N = 16;
const SCRYPT_R = 8;
const SCRYPT_P = 1;
const SCRYPT_MAXMEM = 128 * 1024 * 1024;

async function exists(filePath) {
  try { await access(filePath); return true; }
  catch { return false; }
}

async function hashFile(filePath) {
  const hash = createHash('sha256');
  for await (const chunk of createReadStream(filePath)) hash.update(chunk);
  return hash.digest('hex');
}

async function collectFiles(root, prefix = '') {
  if (!(await exists(root))) return [];
  const results = [];
  for (const entry of await readdir(root, { withFileTypes: true })) {
    const absolute = path.join(root, entry.name);
    const relative = path.posix.join(prefix, entry.name);
    if (entry.isSymbolicLink()) throw new Error('附件目录包含不支持的符号链接');
    if (entry.isDirectory()) results.push(...await collectFiles(absolute, relative));
    else if (entry.isFile()) {
      const info = await stat(absolute);
      results.push({ path: relative, byteSize: info.size, sha256: await hashFile(absolute) });
    }
  }
  return results.sort((a, b) => a.path.localeCompare(b.path));
}

function timestampSlug() {
  return new Date().toISOString().replace(/[:.]/g, '-');
}

export function validateBackupPassphrase(value) {
  const passphrase = String(value || '');
  const characters = Array.from(passphrase).length;
  const bytes = Buffer.byteLength(passphrase, 'utf8');
  if (characters < 12) throw Object.assign(new Error('备份口令至少需要 12 个字符'), { status: 400 });
  if (bytes > 1024) throw Object.assign(new Error('备份口令过长'), { status: 400 });
  return passphrase;
}

function deriveBackupKey(passphrase, salt, { logN = SCRYPT_LOG_N, r = SCRYPT_R, p = SCRYPT_P } = {}) {
  const N = 2 ** logN;
  if (!Number.isInteger(logN) || logN < 14 || logN > 20 || !Number.isInteger(r) || r < 1 || r > 32 || !Number.isInteger(p) || p < 1 || p > 16) {
    throw new Error('加密备份参数不受支持');
  }
  return new Promise((resolve, reject) => scrypt(passphrase, salt, 32, { N, r, p, maxmem: Math.max(SCRYPT_MAXMEM, 256 * N * r) }, (error, key) => error ? reject(error) : resolve(key)));
}

function createEncryptedHeader(salt, iv) {
  const header = Buffer.alloc(ENCRYPTED_HEADER_BYTES);
  ENCRYPTED_MAGIC.copy(header, 0);
  header[8] = ENCRYPTED_VERSION;
  header[9] = SCRYPT_LOG_N;
  header[10] = SCRYPT_R;
  header[11] = SCRYPT_P;
  salt.copy(header, 12);
  iv.copy(header, 28);
  return header;
}

async function readEncryptedHeader(filePath) {
  const info = await stat(filePath);
  if (info.size < ENCRYPTED_HEADER_BYTES + ENCRYPTED_TAG_BYTES + 1) throw Object.assign(new Error('加密备份文件不完整'), { status: 400 });
  const handle = await open(filePath, 'r');
  try {
    const header = Buffer.alloc(ENCRYPTED_HEADER_BYTES);
    const tag = Buffer.alloc(ENCRYPTED_TAG_BYTES);
    const headerRead = await handle.read(header, 0, header.length, 0);
    const tagRead = await handle.read(tag, 0, tag.length, info.size - tag.length);
    if (headerRead.bytesRead !== header.length || tagRead.bytesRead !== tag.length || !header.subarray(0, 8).equals(ENCRYPTED_MAGIC)) throw Object.assign(new Error('不是受支持的加密 Reader 备份'), { status: 400 });
    if (header[8] !== ENCRYPTED_VERSION) throw Object.assign(new Error('该加密备份来自更新版本的 Reader'), { status: 400 });
    return { info, header, tag, logN: header[9], r: header[10], p: header[11], salt: header.subarray(12, 28), iv: header.subarray(28, 40) };
  } finally { await handle.close(); }
}

async function encryptBackupFile(sourcePath, destinationPath, passphrase) {
  const salt = randomBytes(16);
  const iv = randomBytes(12);
  const header = createEncryptedHeader(salt, iv);
  const key = await deriveBackupKey(validateBackupPassphrase(passphrase), salt);
  const cipher = createCipheriv('aes-256-gcm', key, iv, { authTagLength: ENCRYPTED_TAG_BYTES });
  cipher.setAAD(header);
  const output = createWriteStream(destinationPath, { flags: 'wx', mode: 0o600 });
  try {
    if (!output.write(header)) await once(output, 'drain');
    await pipeline(createReadStream(sourcePath), cipher, output, { end: false });
    const closed = once(output, 'close');
    output.end(cipher.getAuthTag());
    await closed;
  } catch (error) {
    output.destroy();
    await unlink(destinationPath).catch(() => {});
    throw error;
  } finally { key.fill(0); }
}

async function decryptBackupFile(sourcePath, destinationPath, passphrase) {
  const parsed = await readEncryptedHeader(sourcePath);
  const key = await deriveBackupKey(validateBackupPassphrase(passphrase), parsed.salt, parsed);
  const decipher = createDecipheriv('aes-256-gcm', key, parsed.iv, { authTagLength: ENCRYPTED_TAG_BYTES });
  decipher.setAAD(parsed.header);
  decipher.setAuthTag(parsed.tag);
  try {
    await pipeline(
      createReadStream(sourcePath, { start: ENCRYPTED_HEADER_BYTES, end: parsed.info.size - ENCRYPTED_TAG_BYTES - 1 }),
      decipher,
      createWriteStream(destinationPath, { flags: 'wx', mode: 0o600 })
    );
  } catch {
    await unlink(destinationPath).catch(() => {});
    throw Object.assign(new Error('备份口令错误或加密文件已损坏'), { status: 400 });
  } finally { key.fill(0); }
}

async function hasEncryptedMagic(filePath) {
  const handle = await open(filePath, 'r');
  try {
    const prefix = Buffer.alloc(ENCRYPTED_MAGIC.length);
    const result = await handle.read(prefix, 0, prefix.length, 0);
    return result.bytesRead === prefix.length && prefix.equals(ENCRYPTED_MAGIC);
  } finally { await handle.close(); }
}

async function writeZip({ snapshot, manifestPath, stagedFiles, archivePath }) {
  const output = createWriteStream(archivePath, { flags: 'wx', mode: 0o600 });
  const archive = archiver('zip', { zlib: { level: 9 } });
  archive.on('warning', (error) => { if (error.code !== 'ENOENT') output.destroy(error); });
  archive.on('error', (error) => output.destroy(error));
  archive.pipe(output);
  archive.file(snapshot, { name: 'reader.sqlite3' });
  archive.file(manifestPath, { name: 'manifest.json' });
  if (await exists(stagedFiles)) archive.directory(stagedFiles, 'files');
  const closed = once(output, 'close');
  await archive.finalize();
  await closed;
}

export async function createBackup({ database, rootDir, appVersion = '0.12.0', reason = 'manual', passphrase = '' }) {
  const backupsDir = path.join(rootDir, 'data', 'backups');
  const filesDir = path.join(rootDir, 'data', 'files');
  await mkdir(backupsDir, { recursive: true });
  const staging = await mkdtemp(path.join(backupsDir, '.build-'));
  const snapshot = path.join(staging, 'reader.sqlite3');
  try {
    await database.execute(`VACUUM INTO ${sqlValue(snapshot)};`);
    const stagedFiles = path.join(staging, 'files');
    if (await exists(filesDir)) await cp(filesDir, stagedFiles, { recursive: true, errorOnExist: false });
    const inventory = await collectFiles(stagedFiles);
    const stats = await database.stats();
    const manifest = {
      format: 'reader-local-backup', formatVersion: 1, appVersion, schemaVersion: SCHEMA_VERSION,
      createdAt: new Date().toISOString(), reason, databaseSha256: await hashFile(snapshot),
      counts: { articles: Number(stats?.total || 0), files: inventory.length }, files: inventory
    };
    const manifestPath = path.join(staging, 'manifest.json');
    await writeFile(manifestPath, JSON.stringify(manifest, null, 2), { mode: 0o600 });
    const id = randomUUID();
    const encrypted = Boolean(passphrase);
    const fileName = `reader-backup-${timestampSlug()}-${id}.readerbackup.${encrypted ? 'enc' : 'zip'}`;
    const archivePath = path.join(backupsDir, fileName);
    if (encrypted) {
      const plainArchive = path.join(staging, 'payload.readerbackup.zip');
      await writeZip({ snapshot, manifestPath, stagedFiles, archivePath: plainArchive });
      await encryptBackupFile(plainArchive, archivePath, passphrase);
      await unlink(plainArchive);
    } else await writeZip({ snapshot, manifestPath, stagedFiles, archivePath });
    const info = await stat(archivePath);
    return { id, file_name: fileName, byte_size: info.size, sha256: await hashFile(archivePath), created_at: manifest.createdAt, reason, encrypted, manifest };
  } finally {
    await rm(staging, { recursive: true, force: true });
  }
}

export async function listBackups(rootDir) {
  const backupsDir = path.join(rootDir, 'data', 'backups');
  if (!(await exists(backupsDir))) return [];
  const rows = [];
  for (const entry of await readdir(backupsDir, { withFileTypes: true })) {
    const match = entry.isFile() && entry.name.match(/^reader-backup-(.+)-([0-9a-f-]{36})\.readerbackup\.(zip|enc)$/i);
    if (!match) continue;
    const info = await stat(path.join(backupsDir, entry.name));
    rows.push({ id: match[2], file_name: entry.name, byte_size: info.size, created_at: info.birthtime.toISOString(), encrypted: match[3].toLowerCase() === 'enc' });
  }
  return rows.sort((a, b) => b.created_at.localeCompare(a.created_at));
}

export async function resolveBackup(rootDir, id) {
  if (!/^[0-9a-f-]{36}$/i.test(String(id || ''))) return null;
  const backup = (await listBackups(rootDir)).find((item) => item.id === id);
  if (!backup) return null;
  return { ...backup, path: path.join(rootDir, 'data', 'backups', backup.file_name) };
}

async function stageRequest(request, destination, maxBytes = MAX_BACKUP_BYTES) {
  const declared = Number(request.headers['content-length'] || 0);
  if (declared > maxBytes) throw Object.assign(new Error('备份文件超过 2 GB 限制'), { status: 413 });
  const output = createWriteStream(destination, { flags: 'wx', mode: 0o600 });
  let total = 0;
  try {
    for await (const chunk of request) {
      total += chunk.length;
      if (total > maxBytes) throw Object.assign(new Error('备份文件超过 2 GB 限制'), { status: 413 });
      if (!output.write(chunk)) await once(output, 'drain');
    }
    const closed = once(output, 'close');
    output.end();
    await closed;
  } catch (error) {
    output.destroy();
    await unlink(destination).catch(() => {});
    throw error;
  }
  if (!total) { await unlink(destination).catch(() => {}); throw Object.assign(new Error('备份文件为空'), { status: 400 }); }
  return total;
}

function openZip(filePath) {
  return new Promise((resolve, reject) => yauzl.open(filePath, { lazyEntries: true, autoClose: true, decodeStrings: true, validateEntrySizes: true }, (error, zip) => error ? reject(error) : resolve(zip)));
}

export function validateBackupEntryPath(name) {
  if (!name || name.includes('\\') || name.includes('\0') || name.startsWith('/') || /^[A-Za-z]:/.test(name)) throw new Error('备份包含不安全路径');
  const normalized = path.posix.normalize(name);
  if (normalized === '..' || normalized.startsWith('../') || normalized !== name.replace(/\/$/, '') && `${normalized}/` !== name) throw new Error('备份包含不安全路径');
  if (!(normalized === 'manifest.json' || normalized === 'reader.sqlite3' || normalized === 'files' || normalized.startsWith('files/'))) throw new Error('备份包含未知文件');
  return normalized;
}

async function extractZipSafely(archivePath, destination) {
  await mkdir(destination, { recursive: true });
  const zip = await openZip(archivePath);
  let total = 0;
  let entries = 0;
  await new Promise((resolve, reject) => {
    zip.once('error', reject);
    zip.once('end', resolve);
    zip.on('entry', async (entry) => {
      try {
        entries += 1;
        if (entries > MAX_ARCHIVE_ENTRIES) throw new Error('备份文件数量超过限制');
        const relative = validateBackupEntryPath(entry.fileName);
        const unixMode = (entry.externalFileAttributes >>> 16) & 0xffff;
        if ((unixMode & 0o170000) === 0o120000) throw new Error('备份不允许包含符号链接');
        total += entry.uncompressedSize;
        if (total > MAX_EXTRACTED_BYTES) throw new Error('备份解压后超过 5 GB 限制');
        const target = path.join(destination, ...relative.split('/'));
        if (entry.fileName.endsWith('/')) await mkdir(target, { recursive: true });
        else {
          await mkdir(path.dirname(target), { recursive: true });
          const stream = await new Promise((res, rej) => zip.openReadStream(entry, (error, value) => error ? rej(error) : res(value)));
          await pipeline(stream, createWriteStream(target, { flags: 'wx', mode: 0o600 }));
        }
        zip.readEntry();
      } catch (error) { zip.close(); reject(error); }
    });
    zip.readEntry();
  });
}

async function sqliteIntegrity(databasePath) {
  return await new Promise((resolve, reject) => {
    const child = spawn(SQLITE_BINARY, [databasePath, 'PRAGMA integrity_check;'], { stdio: ['ignore', 'pipe', 'pipe'] });
    let stdout = ''; let stderr = '';
    child.stdout.setEncoding('utf8'); child.stderr.setEncoding('utf8');
    child.stdout.on('data', (chunk) => { stdout += chunk; }); child.stderr.on('data', (chunk) => { stderr += chunk; });
    child.once('error', reject);
    child.once('close', (code) => code === 0 && stdout.trim() === 'ok' ? resolve(true) : reject(new Error(stderr.trim() || `SQLite 完整性检查失败：${stdout.trim()}`)));
  });
}

export async function validateExtractedBackup(extractedDir) {
  const manifestPath = path.join(extractedDir, 'manifest.json');
  const databasePath = path.join(extractedDir, 'reader.sqlite3');
  const manifest = JSON.parse(await readFile(manifestPath, 'utf8'));
  if (manifest.format !== 'reader-local-backup' || manifest.formatVersion !== 1) throw new Error('不是受支持的 Reader 备份');
  if (!Number.isInteger(manifest.schemaVersion) || manifest.schemaVersion > SCHEMA_VERSION) throw new Error('该备份来自更新版本的 Reader');
  if (await hashFile(databasePath) !== manifest.databaseSha256) throw new Error('数据库校验值不一致');
  await sqliteIntegrity(databasePath);
  const actualFiles = await collectFiles(path.join(extractedDir, 'files'));
  const expected = Array.isArray(manifest.files) ? manifest.files : [];
  if (JSON.stringify(actualFiles) !== JSON.stringify(expected)) throw new Error('附件清单或校验值不一致');
  return { manifest, databasePath, filesDir: path.join(extractedDir, 'files') };
}

export async function getPendingRestore(rootDir) {
  const markerPath = path.join(rootDir, 'data', 'pending-restore.json');
  if (!(await exists(markerPath))) return null;
  return JSON.parse(await readFile(markerPath, 'utf8'));
}

export async function scheduleRestore({ request, database, rootDir, appVersion = '0.12.0', passphrase = '' }) {
  if (await getPendingRestore(rootDir)) throw Object.assign(new Error('已有等待重启的恢复任务'), { status: 409 });
  const restoreRoot = path.join(rootDir, 'data', 'restore');
  await mkdir(restoreRoot, { recursive: true });
  const pendingDir = path.join(restoreRoot, `pending-${randomUUID()}`);
  await mkdir(pendingDir, { recursive: true });
  const uploadedPath = path.join(pendingDir, 'uploaded.readerbackup');
  try {
    await stageRequest(request, uploadedPath);
    const encrypted = await hasEncryptedMagic(uploadedPath);
    let archivePath = uploadedPath;
    if (encrypted) {
      if (!passphrase) throw Object.assign(new Error('请输入该加密备份的口令'), { status: 400 });
      archivePath = path.join(pendingDir, 'decrypted.readerbackup.zip');
      await decryptBackupFile(uploadedPath, archivePath, passphrase);
    }
    const extractedDir = path.join(pendingDir, 'content');
    let manifest;
    try {
      await extractZipSafely(archivePath, extractedDir);
      if (encrypted) await unlink(archivePath);
      ({ manifest } = await validateExtractedBackup(extractedDir));
    } catch (error) {
      if (!error.status) error.status = 400;
      throw error;
    }
    const safetyBackup = await createBackup({ database, rootDir, appVersion, reason: 'pre-restore' });
    const marker = { id: path.basename(pendingDir), pendingDir, backupCreatedAt: manifest.createdAt, safetyBackupId: safetyBackup.id, scheduledAt: new Date().toISOString(), encrypted };
    await writeFile(path.join(rootDir, 'data', 'pending-restore.json'), JSON.stringify(marker, null, 2), { mode: 0o600 });
    return marker;
  } catch (error) {
    await rm(pendingDir, { recursive: true, force: true });
    throw error;
  }
}

export async function cancelPendingRestore(rootDir) {
  const marker = await getPendingRestore(rootDir);
  if (!marker) return false;
  const restoreRoot = `${path.resolve(rootDir, 'data', 'restore')}${path.sep}`;
  const pendingDir = path.resolve(marker.pendingDir || '');
  if (!pendingDir.startsWith(restoreRoot)) throw new Error('待恢复路径无效');
  await rm(pendingDir, { recursive: true, force: true });
  await unlink(path.join(rootDir, 'data', 'pending-restore.json')).catch(() => {});
  return true;
}

export async function applyPendingRestore({ rootDir, dbPath }) {
  const marker = await getPendingRestore(rootDir);
  if (!marker) return null;
  const restoreRoot = `${path.resolve(rootDir, 'data', 'restore')}${path.sep}`;
  const pendingDir = path.resolve(marker.pendingDir || '');
  if (!pendingDir.startsWith(restoreRoot)) throw new Error('待恢复路径无效');
  const extractedDir = path.join(pendingDir, 'content');
  const verified = await validateExtractedBackup(extractedDir);
  const dataDir = path.join(rootDir, 'data');
  const filesDir = path.join(dataDir, 'files');
  const thumbnailsDir = path.join(dataDir, 'thumbnails');
  const nextFiles = path.join(dataDir, 'files.restore-next');
  const oldFiles = path.join(dataDir, 'files.restore-old');
  await rm(nextFiles, { recursive: true, force: true });
  await rm(oldFiles, { recursive: true, force: true });
  if (await exists(verified.filesDir)) await cp(verified.filesDir, nextFiles, { recursive: true });
  else await mkdir(nextFiles, { recursive: true });
  const nextDatabase = `${dbPath}.restore-next`;
  await cp(verified.databasePath, nextDatabase);
  await unlink(`${dbPath}-wal`).catch(() => {});
  await unlink(`${dbPath}-shm`).catch(() => {});
  await rename(nextDatabase, dbPath);
  if (await exists(filesDir)) await rename(filesDir, oldFiles);
  await rename(nextFiles, filesDir);
  await rm(oldFiles, { recursive: true, force: true });
  await rm(thumbnailsDir, { recursive: true, force: true });
  await unlink(path.join(dataDir, 'pending-restore.json'));
  await rm(pendingDir, { recursive: true, force: true });
  return { manifest: verified.manifest, safetyBackupId: marker.safetyBackupId };
}
