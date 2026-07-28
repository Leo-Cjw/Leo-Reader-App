import { execFileSync } from 'node:child_process';
import { copyFile, cp, mkdir, readFile, rm } from 'node:fs/promises';
import path from 'node:path';
import { releaseBundleMetadata, stampBundleMetadata } from './lib/bundle-metadata.mjs';

const projectRoot = path.resolve(import.meta.dirname, '..');
const framework = path.join(projectRoot, 'vendor', 'whisper-v1.9.1', 'whisper.xcframework');
const frameworkSlice = path.join(framework, 'macos-arm64_x86_64');
const sourceFramework = path.join(frameworkSlice, 'whisper.framework');
const source = path.join(projectRoot, 'native', 'transcription-helper', 'main.swift');
const plist = path.join(projectRoot, 'native', 'transcription-helper', 'Info.plist');
const buildRoot = path.join(projectRoot, 'build', 'transcription-helper');
const appPath = path.join(projectRoot, 'build', 'Reader Transcription Helper.app');
const macOSDirectory = path.join(appPath, 'Contents', 'MacOS');
const frameworksDirectory = path.join(appPath, 'Contents', 'Frameworks');
const executable = path.join(macOSDirectory, 'Reader Transcription Helper');
const lipo = path.join(projectRoot, 'scripts', 'toolchain', 'lipo');
const packageMetadata = JSON.parse(await readFile(path.join(projectRoot, 'package.json'), 'utf8'));
const releaseMetadata = releaseBundleMetadata(packageMetadata);

function run(command, args) {
  execFileSync(command, args, { cwd: projectRoot, stdio: 'inherit' });
}

await readFile(path.join(framework, 'Info.plist')).catch(() => {
  throw new Error('缺少固定 whisper.cpp v1.9.1 XCFramework；先运行 npm run transcription:dependency');
});
await rm(buildRoot, { recursive: true, force: true });
await rm(appPath, { recursive: true, force: true });
await mkdir(buildRoot, { recursive: true });
await mkdir(macOSDirectory, { recursive: true });
await mkdir(frameworksDirectory, { recursive: true });

const architectures = [
  ['x86_64', path.join(buildRoot, 'Reader Transcription Helper-x64')],
  ['arm64', path.join(buildRoot, 'Reader Transcription Helper-arm64')]
];
for (const [architecture, output] of architectures) {
  run('/usr/bin/swiftc', [
    '-O', '-whole-module-optimization',
    '-target', `${architecture}-apple-macos13.3`,
    '-framework', 'AVFoundation',
    '-framework', 'CoreMedia',
    '-framework', 'Accelerate',
    '-F', frameworkSlice,
    '-framework', 'whisper',
    '-Xlinker', '-rpath', '-Xlinker', '@executable_path/../Frameworks',
    source, '-o', output
  ]);
}
run(lipo, [...architectures.map(([, output]) => output), '-create', '-output', executable]);
await cp(sourceFramework, path.join(frameworksDirectory, 'whisper.framework'), { recursive: true, verbatimSymlinks: true });
const outputPlist = path.join(appPath, 'Contents', 'Info.plist');
await copyFile(plist, outputPlist);
stampBundleMetadata(outputPlist, releaseMetadata, 'Reader Transcription Helper');
run('/usr/bin/codesign', ['--force', '--sign', '-', path.join(frameworksDirectory, 'whisper.framework')]);
run('/usr/bin/codesign', ['--force', '--sign', '-', '--deep', appPath]);
run('/usr/bin/codesign', ['--verify', '--strict', '--verbose=1', appPath]);
const actual = execFileSync(lipo, ['-archs', executable], { encoding: 'utf8' }).trim().split(/\s+/).sort();
if (actual.join(',') !== 'arm64,x86_64') throw new Error(`Transcription helper 不是 Universal：${actual.join(', ')}`);
console.log(appPath);
console.log(`architectures=${actual.join(',')}`);
