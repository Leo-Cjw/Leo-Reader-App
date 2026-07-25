import { execFileSync } from 'node:child_process';
import { copyFile, mkdir, rm } from 'node:fs/promises';
import path from 'node:path';

const projectRoot = path.resolve(import.meta.dirname, '..');
const source = path.join(projectRoot, 'native', 'spotlight-helper', 'main.swift');
const plist = path.join(projectRoot, 'native', 'spotlight-helper', 'Info.plist');
const buildRoot = path.join(projectRoot, 'build', 'spotlight-helper');
const appPath = path.join(projectRoot, 'build', 'Reader Spotlight Helper.app');
const macOSDirectory = path.join(appPath, 'Contents', 'MacOS');
const executable = path.join(macOSDirectory, 'Reader Spotlight Helper');
const lipo = path.join(projectRoot, 'scripts', 'toolchain', 'lipo');

function run(command, args) {
  execFileSync(command, args, { cwd: projectRoot, stdio: 'inherit' });
}

await rm(buildRoot, { recursive: true, force: true });
await rm(appPath, { recursive: true, force: true });
await mkdir(buildRoot, { recursive: true });
await mkdir(macOSDirectory, { recursive: true });

const architectures = [
  ['x86_64', path.join(buildRoot, 'Reader Spotlight Helper-x64')],
  ['arm64', path.join(buildRoot, 'Reader Spotlight Helper-arm64')]
];
for (const [architecture, output] of architectures) {
  run('/usr/bin/swiftc', [
    '-O', '-whole-module-optimization',
    '-target', `${architecture}-apple-macos12.0`,
    '-framework', 'AppKit',
    '-framework', 'CoreSpotlight',
    '-framework', 'UniformTypeIdentifiers',
    source, '-o', output
  ]);
}
run(lipo, [...architectures.map(([, output]) => output), '-create', '-output', executable]);
await copyFile(plist, path.join(appPath, 'Contents', 'Info.plist'));
run('/usr/bin/codesign', ['--force', '--sign', '-', appPath]);
run('/usr/bin/codesign', ['--verify', '--strict', '--verbose=1', appPath]);
const actual = execFileSync(lipo, ['-archs', executable], { encoding: 'utf8' }).trim().split(/\s+/).sort();
if (actual.join(',') !== 'arm64,x86_64') throw new Error(`Spotlight helper 不是 Universal：${actual.join(', ')}`);
console.log(appPath);
console.log(`architectures=${actual.join(',')}`);
