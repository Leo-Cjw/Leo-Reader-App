import { execFileSync } from 'node:child_process';
import { copyFile, mkdir, readFile, rm } from 'node:fs/promises';
import path from 'node:path';
import { releaseBundleMetadata, stampBundleMetadata } from './lib/bundle-metadata.mjs';

const projectRoot = path.resolve(import.meta.dirname, '..');
const sourceRoot = path.join(projectRoot, 'native', 'share-extension');
const buildRoot = path.join(projectRoot, 'build', 'share-extension');
const extensionPath = path.join(projectRoot, 'build', 'Reader Share Extension.appex');
const macOSDirectory = path.join(extensionPath, 'Contents', 'MacOS');
const executable = path.join(macOSDirectory, 'Reader Share Extension');
const entitlements = path.join(sourceRoot, 'entitlements.plist');
const lipo = path.join(projectRoot, 'scripts', 'toolchain', 'lipo');
const packageMetadata = JSON.parse(await readFile(path.join(projectRoot, 'package.json'), 'utf8'));
const releaseMetadata = releaseBundleMetadata(packageMetadata);

function run(command, args) {
  execFileSync(command, args, { cwd: projectRoot, stdio: 'inherit' });
}

await rm(buildRoot, { recursive: true, force: true });
await rm(extensionPath, { recursive: true, force: true });
await mkdir(buildRoot, { recursive: true });
await mkdir(macOSDirectory, { recursive: true });

const architectures = [
  ['x86_64', path.join(buildRoot, 'Reader Share Extension-x64')],
  ['arm64', path.join(buildRoot, 'Reader Share Extension-arm64')]
];
for (const [architecture, output] of architectures) {
  run('/usr/bin/swiftc', [
    '-O', '-whole-module-optimization', '-parse-as-library', '-application-extension',
    '-target', `${architecture}-apple-macos12.0`,
    '-framework', 'AppKit',
    '-framework', 'CryptoKit',
    '-framework', 'UniformTypeIdentifiers',
    path.join(sourceRoot, 'ShareURL.swift'),
    path.join(sourceRoot, 'ShareFile.swift'),
    path.join(sourceRoot, 'ShareViewController.swift'),
    '-Xlinker', '-e', '-Xlinker', '_NSExtensionMain',
    '-o', output
  ]);
}
run(lipo, [...architectures.map(([, output]) => output), '-create', '-output', executable]);
const outputPlist = path.join(extensionPath, 'Contents', 'Info.plist');
await copyFile(path.join(sourceRoot, 'Info.plist'), outputPlist);
stampBundleMetadata(outputPlist, releaseMetadata, 'Reader Share Extension');
run('/usr/bin/codesign', ['--force', '--sign', '-', '--entitlements', entitlements, extensionPath]);
run('/usr/bin/codesign', ['--verify', '--strict', '--verbose=1', extensionPath]);

const actual = execFileSync(lipo, ['-archs', executable], { encoding: 'utf8' }).trim().split(/\s+/).sort();
if (actual.join(',') !== 'arm64,x86_64') throw new Error(`Share Extension 不是 Universal：${actual.join(', ')}`);
const signedEntitlements = execFileSync('/usr/bin/codesign', ['-d', '--entitlements', ':-', extensionPath], {
  encoding: 'utf8',
  stdio: ['ignore', 'pipe', 'pipe']
});
if (!signedEntitlements.includes('<key>com.apple.security.app-sandbox</key>')) {
  throw new Error('Share Extension 缺少 App Sandbox entitlement');
}
console.log(extensionPath);
console.log(`architectures=${actual.join(',')}`);
