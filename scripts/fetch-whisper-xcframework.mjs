import { createHash } from 'node:crypto';
import { execFileSync } from 'node:child_process';
import { access, mkdir, mkdtemp, open, readFile, rename, rm, stat, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';

const VERSION = 'v1.9.1';
const ARCHIVE_URL = `https://github.com/ggml-org/whisper.cpp/releases/download/${VERSION}/whisper-${VERSION}-xcframework.zip`;
const ARCHIVE_SHA256 = '8c3ecbe73f48b0cb9318fc3058264f951ab336fd530e82c4ccdd2298d1311a4c';
const ARCHIVE_BYTES = 50_438_515;
const MACOS_BINARY_SHA256 = '50e9a18e22098bb673032ccb7205038de2cbd009fb67f969622bb939d0e89497';
const projectRoot = path.resolve(import.meta.dirname, '..');
const installRoot = path.join(projectRoot, 'vendor', `whisper-${VERSION}`);
const frameworkPath = path.join(installRoot, 'whisper.xcframework');
const receiptPath = path.join(installRoot, 'receipt.json');
const macOSBinaryPath = path.join(frameworkPath, 'macos-arm64_x86_64', 'whisper.framework', 'Versions', 'A', 'whisper');

async function hashFile(filePath) {
  const handle = await open(filePath, 'r');
  const hash = createHash('sha256');
  try {
    for await (const chunk of handle.createReadStream({ autoClose: false })) hash.update(chunk);
  } finally {
    await handle.close();
  }
  return hash.digest('hex');
}

async function validInstall() {
  try {
    const receipt = JSON.parse(await readFile(receiptPath, 'utf8'));
    return receipt.version === VERSION
      && receipt.archiveSha256 === ARCHIVE_SHA256
      && receipt.macOSBinarySha256 === MACOS_BINARY_SHA256
      && await hashFile(macOSBinaryPath) === MACOS_BINARY_SHA256;
  } catch {
    return false;
  }
}

async function downloadArchive(destination) {
  const response = await fetch(ARCHIVE_URL, {
    redirect: 'follow',
    credentials: 'omit',
    referrerPolicy: 'no-referrer',
    headers: { accept: 'application/zip' }
  });
  if (!response.ok || !response.body) throw new Error(`whisper.cpp XCFramework 下载失败 (${response.status})`);
  const declared = Number(response.headers.get('content-length') || 0);
  if (declared && declared !== ARCHIVE_BYTES) throw new Error('whisper.cpp XCFramework 固定大小不一致');
  const handle = await open(destination, 'wx', 0o600);
  let total = 0;
  try {
    for await (const chunk of response.body) {
      total += chunk.length;
      if (total > ARCHIVE_BYTES) throw new Error('whisper.cpp XCFramework 超过固定大小');
      await handle.write(chunk);
    }
    await handle.sync();
  } finally {
    await handle.close();
  }
  if (total !== ARCHIVE_BYTES) throw new Error('whisper.cpp XCFramework 下载不完整');
}

if (await validInstall()) {
  console.log(`whisper.cpp ${VERSION} XCFramework 已验证`);
  process.exit(0);
}

await mkdir(path.dirname(installRoot), { recursive: true, mode: 0o700 });
const workRoot = await mkdtemp(path.join(os.tmpdir(), 'reader-whisper-xcframework-'));
const archivePath = path.join(workRoot, 'whisper.xcframework.zip');
try {
  const localArchive = String(process.env.READER_WHISPER_XCFRAMEWORK_ARCHIVE || '').trim();
  if (localArchive) {
    const source = path.resolve(localArchive);
    const info = await stat(source);
    if (!info.isFile() || info.size !== ARCHIVE_BYTES) throw new Error('本地 whisper.cpp XCFramework 归档大小不一致');
    execFileSync('/bin/cp', [source, archivePath]);
  } else {
    await downloadArchive(archivePath);
  }
  if (await hashFile(archivePath) !== ARCHIVE_SHA256) throw new Error('whisper.cpp XCFramework SHA-256 校验失败');
  const entries = execFileSync('/usr/bin/unzip', ['-Z1', archivePath], { encoding: 'utf8', maxBuffer: 4 * 1024 * 1024 })
    .split(/\r?\n/).filter(Boolean);
  if (!entries.length || entries.some((entry) => !entry.startsWith('build-apple/whisper.xcframework/')
    || entry.startsWith('/') || entry.includes('\\') || entry.split('/').includes('..'))) {
    throw new Error('whisper.cpp XCFramework 归档路径无效');
  }
  execFileSync('/usr/bin/unzip', ['-q', archivePath, '-d', workRoot]);
  const extracted = path.join(workRoot, 'build-apple', 'whisper.xcframework');
  await access(path.join(extracted, 'Info.plist'));
  if (await hashFile(path.join(extracted, 'macos-arm64_x86_64', 'whisper.framework', 'Versions', 'A', 'whisper')) !== MACOS_BINARY_SHA256) {
    throw new Error('whisper.cpp macOS framework 二次校验失败');
  }
  await rm(installRoot, { recursive: true, force: true });
  await mkdir(installRoot, { recursive: true, mode: 0o700 });
  await rename(extracted, frameworkPath);
  await writeFile(receiptPath, `${JSON.stringify({
    version: VERSION,
    source: ARCHIVE_URL,
    archiveBytes: ARCHIVE_BYTES,
    archiveSha256: ARCHIVE_SHA256,
    macOSBinarySha256: MACOS_BINARY_SHA256
  }, null, 2)}\n`, { mode: 0o600 });
  console.log(`whisper.cpp ${VERSION} XCFramework 已安装并验证`);
} finally {
  await rm(workRoot, { recursive: true, force: true });
}
