import { execFileSync } from 'node:child_process';
import { access } from 'node:fs/promises';
import path from 'node:path';
import { signAsync } from '@electron/osx-sign';
import { makeUniversalApp } from '@electron/universal';

const projectRoot = path.resolve(import.meta.dirname, '..');
const lipoCommand = path.join(projectRoot, 'scripts', 'toolchain', 'lipo');
const x64AppPath = path.resolve(process.env.READER_X64_APP || path.join(projectRoot, 'release', 'mac', 'Reader.app'));
const arm64AppPath = path.resolve(process.env.READER_ARM64_APP || path.join(projectRoot, 'release', 'mac-arm64', 'Reader.app'));
const outAppPath = path.resolve(process.env.READER_UNIVERSAL_APP || path.join(projectRoot, 'release', 'mac-universal', 'Reader.app'));

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
  await signAsync({
    app: outAppPath,
    identity: developerIdentity,
    platform: 'darwin',
    strictVerify: true
  });
  signature = 'Developer ID';
} else if (process.env.READER_SKIP_ADHOC_SIGN !== '1') {
  execFileSync('/usr/bin/codesign', ['--force', '--deep', '--sign', '-', outAppPath], { stdio: 'inherit' });
  signature = 'ad-hoc';
}
if (signature !== 'unsigned') {
  execFileSync('/usr/bin/codesign', ['--verify', '--deep', '--strict', '--verbose=1', outAppPath], { stdio: 'inherit' });
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

console.log(outAppPath);
console.log(`architectures=${architectures.join(',')}`);
console.log(`signature=${signature}`);
