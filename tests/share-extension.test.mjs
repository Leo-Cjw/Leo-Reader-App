import test from 'node:test';
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { mkdtemp, readFile, rm } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const projectRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const nativeRoot = path.join(projectRoot, 'native', 'share-extension');

test('Share Extension validation and handoff accept one bounded web URL, selected text or supported file', {
  skip: process.platform !== 'darwin'
}, async (t) => {
  const tempRoot = await mkdtemp(path.join(os.tmpdir(), 'reader-share-url-'));
  t.after(() => rm(tempRoot, { recursive: true, force: true }));
  const executable = path.join(tempRoot, 'share-url-self-test');
  const architecture = process.arch === 'arm64' ? 'arm64' : 'x86_64';
  execFileSync('/usr/bin/swiftc', [
    '-parse-as-library',
    '-target', `${architecture}-apple-macos12.0`,
    path.join(nativeRoot, 'ShareURL.swift'),
    path.join(nativeRoot, 'ShareURLSelfTest.swift'),
    '-o', executable
  ]);
  execFileSync(executable);

  const source = await readFile(path.join(nativeRoot, 'ShareViewController.swift'), 'utf8');
  assert.match(source, /hasItemConformingToTypeIdentifier\(UTType\.url\.identifier\)/);
  assert.match(source, /loadItem\(forTypeIdentifier: UTType\.url\.identifier/);
  assert.match(source, /hasItemConformingToTypeIdentifier\(UTType\.plainText\.identifier\)/);
  assert.match(source, /loadDataRepresentation\(forTypeIdentifier: UTType\.plainText\.identifier\)/);
  assert.match(source, /preferredTypeIdentifier\(for: provider\)/);
  assert.match(source, /loadFileRepresentation\(forTypeIdentifier: typeIdentifier\)/);
  assert.match(source, /ReaderShareFile\.stage/);
  assert.match(source, /deepLink\(forFileToken:/);
  assert.match(source, /deepLink\(forText: data\)/);
  assert.match(source, /NSWorkspace\.shared\.open\(deepLink\)/);
  assert.match(source, /completeRequest\(returningItems: nil\)/);
  assert.match(source, /cancelRequest\(withError: error\)/);
  assert.doesNotMatch(source, /URLSession|FileManager|UserDefaults|containerURL|reader\.sqlite/);
});

test('Share Extension stages one bounded file with private permissions, digest and expiry', {
  skip: process.platform !== 'darwin'
}, async (t) => {
  const tempRoot = await mkdtemp(path.join(os.tmpdir(), 'reader-share-file-'));
  t.after(() => rm(tempRoot, { recursive: true, force: true }));
  const executable = path.join(tempRoot, 'share-file-self-test');
  const architecture = process.arch === 'arm64' ? 'arm64' : 'x86_64';
  execFileSync('/usr/bin/swiftc', [
    '-parse-as-library',
    '-target', `${architecture}-apple-macos12.0`,
    '-framework', 'CryptoKit',
    path.join(nativeRoot, 'ShareURL.swift'),
    path.join(nativeRoot, 'ShareFile.swift'),
    path.join(nativeRoot, 'ShareFileSelfTest.swift'),
    '-o', executable
  ]);
  execFileSync(executable);

  const source = await readFile(path.join(nativeRoot, 'ShareFile.swift'), 'utf8');
  assert.match(source, /maximumBytes = 100 \* 1024 \* 1024/);
  assert.match(source, /ReaderShareStaging/);
  assert.match(source, /\.posixPermissions: 0o700/);
  assert.match(source, /\.posixPermissions: 0o600/);
  assert.match(source, /SHA256\(\)/);
  assert.match(source, /timeToLive: TimeInterval = 24 \* 60 \* 60/);
  assert.doesNotMatch(source, /URLSession|UserDefaults|containerURL|reader\.sqlite/);
});

test('Share Extension declares strict single URL, text or file activation and sandbox-only entitlement', async () => {
  const plist = JSON.parse(execFileSync('/usr/bin/plutil', [
    '-convert', 'json', '-o', '-', path.join(nativeRoot, 'Info.plist')
  ], { encoding: 'utf8' }));
  assert.equal(plist.CFBundleIdentifier, 'com.reader.localfirst.share-extension');
  assert.equal(plist.CFBundlePackageType, 'XPC!');
  assert.equal(plist.CFBundleShortVersionString, '0.47.0');
  assert.equal(plist.CFBundleVersion, '47');
  assert.equal(plist.LSMinimumSystemVersion, '12.0');
  assert.equal(plist.NSExtension.NSExtensionPointIdentifier, 'com.apple.share-services');
  assert.equal(plist.NSExtension.NSExtensionPrincipalClass, 'ReaderShareViewController');
  assert.deepEqual(plist.NSExtension.NSExtensionAttributes.NSExtensionActivationRule, {
    NSExtensionActivationSupportsFileWithMaxCount: 1,
    NSExtensionActivationSupportsText: true,
    NSExtensionActivationSupportsWebURLWithMaxCount: 1
  });
  assert.equal(plist.NSExtension.NSExtensionAttributes.NSExtensionActivationUsesStrictMatching, true);

  const entitlements = JSON.parse(execFileSync('/usr/bin/plutil', [
    '-convert', 'json', '-o', '-', path.join(nativeRoot, 'entitlements.plist')
  ], { encoding: 'utf8' }));
  assert.deepEqual(entitlements, { 'com.apple.security.app-sandbox': true });
});

test('mac packaging embeds, signs and verifies a Universal Share Extension without unused app capabilities', async () => {
  const packageJSON = JSON.parse(await readFile(path.join(projectRoot, 'package.json'), 'utf8'));
  const build = await readFile(path.join(projectRoot, 'scripts', 'build-share-extension.mjs'), 'utf8');
  const afterPack = await readFile(path.join(projectRoot, 'scripts', 'after-pack.cjs'), 'utf8');
  const universal = await readFile(path.join(projectRoot, 'scripts', 'build-universal-mac.mjs'), 'utf8');
  const release = await readFile(path.join(projectRoot, 'scripts', 'build-mac-release.mjs'), 'utf8');
  const appEntitlements = JSON.parse(execFileSync('/usr/bin/plutil', [
    '-convert', 'json', '-o', '-', path.join(projectRoot, 'native', 'entitlements.mac.plist')
  ], { encoding: 'utf8' }));

  assert.equal(packageJSON.version, '0.47.0');
  assert.equal(packageJSON.scripts['share:mac'], 'node scripts/build-share-extension.mjs');
  assert.match(packageJSON.scripts['desktop:pack:x64'], /share:mac/);
  assert.deepEqual(appEntitlements, { 'com.apple.security.cs.allow-jit': true });
  assert.match(build, /'x86_64'/);
  assert.match(build, /'arm64'/);
  assert.match(build, /'-application-extension'/);
  assert.match(build, /'-framework', 'CryptoKit'/);
  assert.match(build, /ShareFile\.swift/);
  assert.match(build, /'_NSExtensionMain'/);
  assert.match(build, /--entitlements/);
  assert.match(afterPack, /Contents'\)/);
  assert.match(afterPack, /'PlugIns', 'Reader Share Extension\.appex'/);
  assert.match(release, /share:mac/);
  assert.match(universal, /Reader Share Extension\.appex/);
  assert.match(universal, /Share Extension 不是通用架构/);
  assert.match(universal, /preAutoEntitlements: false/);
  assert.match(universal, /Share Extension 签名 entitlement 不是精确的 App Sandbox/);
  assert.match(universal, /Reader 主程序签名 entitlement 不是精确的 allow-jit/);
  assert.match(universal, /Spotlight helper 不应包含 entitlement/);
  assert.match(universal, /'--entitlements', emptyEntitlements, spotlightHelperApp/);
  assert.match(universal, /'--verify', '--strict', '--verbose=1', spotlightHelperApp/);
  for (const capability of ['audio-input', 'bluetooth', 'camera', 'location', 'print', 'usb']) {
    assert.equal(JSON.stringify(appEntitlements).includes(capability), false);
  }
});
