import { createHash } from 'node:crypto';
import { execFileSync } from 'node:child_process';
import { createReadStream, createWriteStream } from 'node:fs';
import { access, copyFile, mkdir, readFile, rename, rm, stat } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { Readable } from 'node:stream';
import { pipeline } from 'node:stream/promises';
import { notarize } from '@electron/notarize';

const projectRoot = path.resolve(import.meta.dirname, '..');
const releaseRoot = path.join(projectRoot, 'release');
const cacheRoot = path.resolve(
  process.env.READER_BUILD_CACHE || path.join(os.homedir(), 'Library', 'Caches', 'ReaderBuild')
);
const mirror = (process.env.READER_ELECTRON_MIRROR || 'https://npmmirror.com/mirrors/electron').replace(/\/+$/, '');
const electronMetadata = JSON.parse(await readFile(path.join(projectRoot, 'node_modules', 'electron', 'package.json'), 'utf8'));
const electronVersion = electronMetadata.version;
const checksums = JSON.parse(await readFile(path.join(projectRoot, 'node_modules', 'electron', 'checksums.json'), 'utf8'));

function run(command, args, options = {}) {
  console.log(`\n> ${path.basename(command)} ${args.join(' ')}`);
  execFileSync(command, args, { cwd: projectRoot, stdio: 'inherit', ...options });
}

async function sha256(filePath) {
  const hash = createHash('sha256');
  const file = createReadStream(filePath);
  for await (const chunk of file) hash.update(chunk);
  return hash.digest('hex');
}

async function ensureElectronZip(architecture) {
  const filename = `electron-v${electronVersion}-darwin-${architecture}.zip`;
  const expected = checksums[filename];
  if (!expected) throw new Error(`Electron 官方校验清单缺少 ${filename}`);
  const destination = path.join(cacheRoot, 'electron', filename);
  await mkdir(path.dirname(destination), { recursive: true });

  try {
    if ((await sha256(destination)) === expected) return destination;
  } catch {
    // 缓存不存在或不可读时重新下载。
  }

  const temporary = `${destination}.download-${process.pid}`;
  await rm(temporary, { force: true });
  const response = await fetch(`${mirror}/v${electronVersion}/${filename}`, {
    redirect: 'follow',
    signal: AbortSignal.timeout(5 * 60 * 1000)
  });
  if (!response.ok || !response.body) throw new Error(`下载 ${filename} 失败：HTTP ${response.status}`);
  await pipeline(Readable.fromWeb(response.body), createWriteStream(temporary, { flags: 'wx' }));
  const actual = await sha256(temporary);
  if (actual !== expected) {
    await rm(temporary, { force: true });
    throw new Error(`${filename} 校验失败：期望 ${expected}，实际 ${actual}`);
  }
  await rename(temporary, destination);
  return destination;
}

async function ensureCanvasArchitecture(architecture) {
  const canvasMetadata = JSON.parse(
    await readFile(path.join(projectRoot, 'node_modules', '@napi-rs', 'canvas', 'package.json'), 'utf8')
  );
  const packageName = `@napi-rs/canvas-darwin-${architecture}`;
  const version = canvasMetadata.optionalDependencies?.[packageName];
  if (!version) throw new Error(`${packageName} 未在 Canvas 可选依赖中声明`);

  const binaryName = architecture === 'x64' ? 'skia.darwin-x64.node' : 'skia.darwin-arm64.node';
  const packageDir = path.join(projectRoot, 'node_modules', '@napi-rs', `canvas-darwin-${architecture}`);
  try {
    await access(path.join(packageDir, binaryName));
    return;
  } catch {
    // npm 在 Intel 主机上会省略 arm64 可选依赖，因此按固定版本补装。
  }

  const packDir = path.join(cacheRoot, 'npm');
  await mkdir(packDir, { recursive: true });
  run('npm', ['pack', `${packageName}@${version}`, '--pack-destination', packDir]);
  const archive = path.join(packDir, `napi-rs-canvas-darwin-${architecture}-${version}.tgz`);
  await access(archive);
  run('npm', ['install', archive, '--no-save', '--ignore-scripts', '--force']);
  await access(path.join(packageDir, binaryName));
}

async function replaceWithKnownZip(source, architecture) {
  const destinationDir = path.join(cacheRoot, 'electron-dist', architecture);
  await rm(destinationDir, { recursive: true, force: true });
  await mkdir(destinationDir, { recursive: true });
  const destination = path.join(destinationDir, path.basename(source));
  await copyFile(source, destination);
  return destination;
}

await mkdir(releaseRoot, { recursive: true });
await ensureCanvasArchitecture('x64');
await ensureCanvasArchitecture('arm64');
const [x64Zip, arm64Zip] = await Promise.all([ensureElectronZip('x64'), ensureElectronZip('arm64')]);

run('npm', ['run', 'build']);
run('npm', ['run', 'icon:mac']);
run('npm', ['run', 'spotlight:mac']);
run('npm', ['run', 'share:mac']);

// electron-builder 会把同名 zip 所在目录当作 electronDist。每个目录只放一个已校验压缩包。
const x64Dist = await replaceWithKnownZip(x64Zip, 'x64');
const arm64Dist = await replaceWithKnownZip(arm64Zip, 'arm64');
run(path.join(projectRoot, 'node_modules', '.bin', 'electron-builder'), [
  '--mac', 'dir', '--x64', `--config.electronDist=${x64Dist}`
]);
run(path.join(projectRoot, 'node_modules', '.bin', 'electron-builder'), [
  '--mac', 'dir', '--arm64', `--config.electronDist=${arm64Dist}`
]);
run(process.execPath, [path.join(projectRoot, 'scripts', 'build-universal-mac.mjs')]);

const packageMetadata = JSON.parse(await readFile(path.join(projectRoot, 'package.json'), 'utf8'));
const appPath = path.join(releaseRoot, 'mac-universal', 'Reader.app');
const dmgPath = path.join(releaseRoot, `Reader-${packageMetadata.version}-universal.dmg`);
const updatePath = path.join(releaseRoot, `Reader-${packageMetadata.version}-darwin-universal.zip`);
const notaryProfile = process.env.READER_NOTARY_KEYCHAIN_PROFILE?.trim();
await rm(updatePath, { force: true });
if (notaryProfile) {
  if (!process.env.READER_MAC_SIGN_IDENTITY?.trim()) {
    throw new Error('公证要求同时设置 READER_MAC_SIGN_IDENTITY');
  }
  await notarize({
    appPath,
    keychainProfile: notaryProfile,
    keychain: process.env.READER_NOTARY_KEYCHAIN?.trim() || undefined
  });
  run('/usr/bin/xcrun', ['stapler', 'validate', appPath]);
} else {
  console.log('\n未设置 READER_NOTARY_KEYCHAIN_PROFILE；不生成自动更新 ZIP。');
}

run(process.execPath, [path.join(projectRoot, 'scripts', 'build-mac-dmg.mjs')]);
if (notaryProfile) {
  await notarize({
    appPath: dmgPath,
    keychainProfile: notaryProfile,
    keychain: process.env.READER_NOTARY_KEYCHAIN?.trim() || undefined
  });
  run('/usr/bin/xcrun', ['stapler', 'validate', dmgPath]);
  run(process.execPath, [path.join(projectRoot, 'scripts', 'build-mac-update.mjs')]);
} else {
  console.log('\n当前 DMG 未公证；仅用于本机验证，不作为自动更新源。');
}
const dmgInfo = await stat(dmgPath);
console.log('\nReader macOS 通用发行包已完成：');
console.log(appPath);
console.log(`${dmgPath} (${dmgInfo.size} bytes)`);
if (notaryProfile) {
  const updateInfo = await stat(updatePath);
  console.log(`${updatePath} (${updateInfo.size} bytes)`);
}
