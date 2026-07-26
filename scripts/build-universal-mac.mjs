import { execFileSync } from 'node:child_process';
import { access } from 'node:fs/promises';
import path from 'node:path';
import { signAsync } from '@electron/osx-sign';
import { makeUniversalApp } from '@electron/universal';

const projectRoot = path.resolve(import.meta.dirname, '..');
const lipoCommand = path.join(projectRoot, 'scripts', 'toolchain', 'lipo');
const mainEntitlements = path.join(projectRoot, 'native', 'entitlements.mac.plist');
const emptyEntitlements = path.join(projectRoot, 'native', 'entitlements.empty.plist');
const shareEntitlements = path.join(projectRoot, 'native', 'share-extension', 'entitlements.plist');
const x64AppPath = path.resolve(process.env.READER_X64_APP || path.join(projectRoot, 'release', 'mac', 'Reader.app'));
const arm64AppPath = path.resolve(process.env.READER_ARM64_APP || path.join(projectRoot, 'release', 'mac-arm64', 'Reader.app'));
const outAppPath = path.resolve(process.env.READER_UNIVERSAL_APP || path.join(projectRoot, 'release', 'mac-universal', 'Reader.app'));
const spotlightHelperApp = path.join(outAppPath, 'Contents', 'Resources', 'Reader Spotlight Helper.app');

function signedEntitlements(codePath) {
  const xml = execFileSync('/usr/bin/codesign', ['-d', '--entitlements', ':-', codePath], {
    encoding: 'utf8',
    stdio: ['ignore', 'pipe', 'pipe']
  });
  if (!xml.trim()) return {};
  return JSON.parse(execFileSync('/usr/bin/plutil', ['-convert', 'json', '-o', '-', '-'], {
    encoding: 'utf8',
    input: xml
  }));
}

for (const appPath of [x64AppPath, arm64AppPath]) {
  await access(path.join(appPath, 'Contents', 'Info.plist'));
}
await access(lipoCommand);
process.env.PATH = `${path.dirname(lipoCommand)}${path.delimiter}${process.env.PATH || '/usr/bin:/bin'}`;

await makeUniversalApp({
  x64AppPath,
  arm64AppPath,
  outAppPath,
  force: true,
  mergeASARs: true,
  x64ArchFiles: '**/node_modules/@napi-rs/canvas-darwin-*/skia.*.node'
});

const developerIdentity = process.env.READER_MAC_SIGN_IDENTITY?.trim();
let signature = 'unsigned';
if (developerIdentity) {
  execFileSync('/usr/bin/codesign', [
    '--force', '--sign', developerIdentity, '--options', 'runtime', '--timestamp',
    '--entitlements', emptyEntitlements, spotlightHelperApp
  ], { stdio: 'inherit' });
  await signAsync({
    app: outAppPath,
    identity: developerIdentity,
    platform: 'darwin',
    strictVerify: true,
    preAutoEntitlements: false,
    optionsForFile(filePath) {
      if (filePath.endsWith(`${path.sep}Reader Share Extension.appex`)) {
        return { entitlements: shareEntitlements };
      }
      if (filePath.endsWith(`${path.sep}Reader Spotlight Helper.app`)) {
        return { entitlements: emptyEntitlements };
      }
      if (path.resolve(filePath) === outAppPath) {
        return { entitlements: mainEntitlements };
      }
      return {};
    }
  });
  signature = 'Developer ID';
} else if (process.env.READER_SKIP_ADHOC_SIGN !== '1') {
  execFileSync('/usr/bin/codesign', [
    '--force', '--sign', '-', '--entitlements', emptyEntitlements, spotlightHelperApp
  ], { stdio: 'inherit' });
  execFileSync('/usr/bin/codesign', ['--force', '--deep', '--sign', '-', outAppPath], { stdio: 'inherit' });
  execFileSync('/usr/bin/codesign', [
    '--force', '--sign', '-', '--entitlements', shareEntitlements,
    path.join(outAppPath, 'Contents', 'PlugIns', 'Reader Share Extension.appex')
  ], { stdio: 'inherit' });
  execFileSync('/usr/bin/codesign', [
    '--force', '--sign', '-', '--entitlements', mainEntitlements, outAppPath
  ], { stdio: 'inherit' });
  signature = 'ad-hoc';
}
if (signature !== 'unsigned') {
  execFileSync('/usr/bin/codesign', ['--verify', '--deep', '--strict', '--verbose=1', outAppPath], { stdio: 'inherit' });
  execFileSync('/usr/bin/codesign', ['--verify', '--strict', '--verbose=1', spotlightHelperApp], { stdio: 'inherit' });
}

const executable = path.join(outAppPath, 'Contents', 'MacOS', 'Reader');
const architectures = execFileSync(lipoCommand, ['-archs', executable], { encoding: 'utf8' }).trim().split(/\s+/).sort();
if (architectures.join(',') !== 'arm64,x86_64') throw new Error(`Reader 主程序不是通用架构：${architectures.join(', ')}`);

const unpacked = path.join(outAppPath, 'Contents', 'Resources', 'app.asar.unpacked', 'node_modules', '@napi-rs');
const canvasBinaries = [
  [path.join(unpacked, 'canvas-darwin-x64', 'skia.darwin-x64.node'), 'x86_64'],
  [path.join(unpacked, 'canvas-darwin-arm64', 'skia.darwin-arm64.node'), 'arm64']
];
for (const [binary, expectedArchitecture] of canvasBinaries) {
  await access(binary);
  const actualArchitecture = execFileSync(lipoCommand, ['-archs', binary], { encoding: 'utf8' }).trim();
  if (actualArchitecture !== expectedArchitecture) {
    throw new Error(`${path.basename(binary)} 架构错误：期望 ${expectedArchitecture}，实际 ${actualArchitecture}`);
  }
}

const spotlightHelper = path.join(
  spotlightHelperApp,
  'Contents',
  'MacOS',
  'Reader Spotlight Helper'
);
await access(spotlightHelper);
const spotlightArchitectures = execFileSync(lipoCommand, ['-archs', spotlightHelper], { encoding: 'utf8' }).trim().split(/\s+/).sort();
if (spotlightArchitectures.join(',') !== 'arm64,x86_64') {
  throw new Error(`Spotlight helper 不是通用架构：${spotlightArchitectures.join(', ')}`);
}

const shareExtension = path.join(
  outAppPath,
  'Contents',
  'PlugIns',
  'Reader Share Extension.appex'
);
const shareExecutable = path.join(shareExtension, 'Contents', 'MacOS', 'Reader Share Extension');
await access(shareExecutable);
const shareArchitectures = execFileSync(lipoCommand, ['-archs', shareExecutable], { encoding: 'utf8' }).trim().split(/\s+/).sort();
if (shareArchitectures.join(',') !== 'arm64,x86_64') {
  throw new Error(`Share Extension 不是通用架构：${shareArchitectures.join(', ')}`);
}
if (signature !== 'unsigned') {
  const extensionEntitlements = signedEntitlements(shareExtension);
  if (JSON.stringify(extensionEntitlements) !== JSON.stringify({ 'com.apple.security.app-sandbox': true })) {
    throw new Error('Share Extension 签名 entitlement 不是精确的 App Sandbox');
  }
  const appEntitlements = signedEntitlements(outAppPath);
  if (JSON.stringify(appEntitlements) !== JSON.stringify({ 'com.apple.security.cs.allow-jit': true })) {
    throw new Error('Reader 主程序签名 entitlement 不是精确的 allow-jit');
  }
  const spotlightEntitlements = signedEntitlements(path.dirname(path.dirname(path.dirname(spotlightHelper))));
  if (Object.keys(spotlightEntitlements).length) {
    throw new Error('Spotlight helper 不应包含 entitlement');
  }
}

console.log(outAppPath);
console.log(`architectures=${architectures.join(',')}`);
console.log(`spotlightArchitectures=${spotlightArchitectures.join(',')}`);
console.log(`shareArchitectures=${shareArchitectures.join(',')}`);
console.log(`signature=${signature}`);
