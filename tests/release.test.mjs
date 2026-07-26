import assert from 'node:assert/strict';
import { execFileSync, spawnSync } from 'node:child_process';
import { chmod, mkdtemp, readFile, stat, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';
import { assertBundleMetadata, releaseBundleMetadata } from '../scripts/lib/bundle-metadata.mjs';
import {
  RELEASE_SIGNATURES,
  verifyReleaseManifest,
  writeMacReleaseManifest
} from '../scripts/lib/release-manifest.mjs';

const projectRoot = path.resolve(import.meta.dirname, '..');
const lipo = path.join(projectRoot, 'scripts', 'toolchain', 'lipo');

test('macOS release metadata requires one numeric version and build identity for every bundle', () => {
  const metadata = releaseBundleMetadata({ version: '0.57.0', build: { buildVersion: '57' } });
  assert.deepEqual(metadata, { version: '0.57.0', buildVersion: '57' });
  assert.doesNotThrow(() => assertBundleMetadata({
    CFBundleShortVersionString: '0.57.0',
    CFBundleVersion: '57'
  }, 'Reader Share Extension', metadata));
  assert.throws(() => releaseBundleMetadata({ version: '0.56', build: { buildVersion: '56' } }), /三段数字/);
  assert.throws(() => releaseBundleMetadata({ version: '0.57.0', build: { buildVersion: '0' } }), /正整数/);
  assert.throws(() => assertBundleMetadata({
    CFBundleShortVersionString: '0.57.0',
    CFBundleVersion: '56'
  }, 'Reader Spotlight Helper', metadata), /构建号不一致/);
});

test('native bundle templates match the canonical package release identity', async () => {
  const packageMetadata = JSON.parse(await readFile(path.join(projectRoot, 'package.json'), 'utf8'));
  const metadata = releaseBundleMetadata(packageMetadata);
  for (const [plistPath, label] of [
    [path.join(projectRoot, 'native', 'share-extension', 'Info.plist'), 'Reader Share Extension'],
    [path.join(projectRoot, 'native', 'spotlight-helper', 'Info.plist'), 'Reader Spotlight Helper']
  ]) {
    const plist = JSON.parse(execFileSync('/usr/bin/plutil', ['-convert', 'json', '-o', '-', plistPath], { encoding: 'utf8' }));
    assert.doesNotThrow(() => assertBundleMetadata(plist, label, metadata));
  }
});

function fakeReleaseMetadata(version = '0.57.0', buildVersion = '57') {
  return {
    version,
    build: {
      buildVersion,
      productName: 'Reader',
      appId: 'com.reader.localfirst'
    }
  };
}

const cleanSource = {
  commit: '0123456789abcdef0123456789abcdef01234567',
  trackedChanges: false
};

test('ad-hoc release manifest atomically records and verifies only the DMG identity', async () => {
  const temporary = await mkdtemp(path.join(os.tmpdir(), 'reader-release-manifest-'));
  const dmgName = 'Reader-0.57.0-universal.dmg';
  await writeFile(path.join(temporary, dmgName), 'reader-dmg-fixture');

  const { manifest, manifestPath } = await writeMacReleaseManifest({
    projectRoot,
    releaseRoot: temporary,
    packageMetadata: fakeReleaseMetadata(),
    schemaVersion: 12,
    electronVersion: '41.7.1',
    signature: RELEASE_SIGNATURES.AD_HOC,
    source: { ...cleanSource, trackedChanges: true }
  });

  assert.equal(manifest.signature, 'ad-hoc');
  assert.deepEqual(manifest.source, { ...cleanSource, trackedChanges: true });
  assert.deepEqual(manifest.artifacts.map(({ kind, fileName }) => ({ kind, fileName })), [
    { kind: 'dmg', fileName: dmgName }
  ]);
  const serialized = await readFile(manifestPath, 'utf8');
  assert.equal(serialized.endsWith('\n'), true);
  assert.equal(serialized.includes(temporary), false);
  assert.equal(serialized.includes(os.userInfo().username), false);
  assert.equal(
    await readFile(path.join(temporary, `${dmgName}.sha256`), 'utf8'),
    `${manifest.artifacts[0].sha256}  ${dmgName}\n`
  );
  assert.deepEqual(await verifyReleaseManifest({ manifestPath, releaseRoot: temporary }), manifest);
  await writeFile(manifestPath, JSON.stringify({ ...manifest, localPath: temporary }));
  await assert.rejects(
    verifyReleaseManifest({ manifestPath, releaseRoot: temporary }),
    /发行清单字段无效/
  );
});

test('release manifest verification rejects artifact tampering', async () => {
  const temporary = await mkdtemp(path.join(os.tmpdir(), 'reader-release-tamper-'));
  const dmgPath = path.join(temporary, 'Reader-0.57.0-universal.dmg');
  await writeFile(dmgPath, 'original-reader-dmg');
  const { manifestPath } = await writeMacReleaseManifest({
    projectRoot,
    releaseRoot: temporary,
    packageMetadata: fakeReleaseMetadata(),
    schemaVersion: 12,
    electronVersion: '41.7.1',
    source: cleanSource
  });
  await writeFile(dmgPath, 'tampered-reader-dmg');
  await assert.rejects(
    verifyReleaseManifest({ manifestPath, releaseRoot: temporary }),
    /SHA-256 与发行清单不一致|字节数与发行清单不一致/
  );
});

test('notarized release manifest requires a clean source and both distributable artifacts', async () => {
  const dirtyRoot = await mkdtemp(path.join(os.tmpdir(), 'reader-release-dirty-'));
  await assert.rejects(
    writeMacReleaseManifest({
      projectRoot,
      releaseRoot: dirtyRoot,
      packageMetadata: fakeReleaseMetadata(),
      schemaVersion: 12,
      electronVersion: '41.7.1',
      signature: RELEASE_SIGNATURES.NOTARIZED,
      source: { ...cleanSource, trackedChanges: true }
    }),
    /禁止包含未提交/
  );

  const temporary = await mkdtemp(path.join(os.tmpdir(), 'reader-release-notarized-'));
  await writeFile(path.join(temporary, 'Reader-0.57.0-universal.dmg'), 'notarized-reader-dmg');
  await writeFile(path.join(temporary, 'Reader-0.57.0-darwin-universal.zip'), 'notarized-reader-update');
  const { manifest } = await writeMacReleaseManifest({
    projectRoot,
    releaseRoot: temporary,
    packageMetadata: fakeReleaseMetadata(),
    schemaVersion: 12,
    electronVersion: '41.7.1',
    signature: RELEASE_SIGNATURES.NOTARIZED,
    source: cleanSource
  });
  assert.deepEqual(manifest.artifacts.map(({ kind }) => kind), ['dmg', 'update']);
  assert.equal(manifest.signature, 'developer-id-notarized');
});

function thinMachO(cputype, cpusubtype, marker) {
  const binary = Buffer.alloc(96, marker);
  binary.writeUInt32LE(0xfeedfacf, 0);
  binary.writeInt32LE(cputype, 4);
  binary.writeInt32LE(cpusubtype, 8);
  return binary;
}

test('自带 lipo 能无尾部填充地合并并检查 x64/arm64 Mach-O', async () => {
  const temporary = await mkdtemp(path.join(os.tmpdir(), 'reader-lipo-test-'));
  const x64Path = path.join(temporary, 'x64');
  const arm64Path = path.join(temporary, 'arm64');
  const universalPath = path.join(temporary, 'universal');
  const x64 = thinMachO(0x01000007, 3, 0x78);
  const arm64 = thinMachO(0x0100000c, 0, 0x61);
  await writeFile(x64Path, x64);
  await writeFile(arm64Path, arm64);
  await chmod(x64Path, 0o755);

  execFileSync(lipo, [x64Path, arm64Path, '-create', '-output', universalPath]);
  assert.equal(execFileSync(lipo, ['-archs', universalPath], { encoding: 'utf8' }).trim(), 'x86_64 arm64');

  const output = await readFile(universalPath);
  assert.equal(output.readUInt32BE(0), 0xcafebabe);
  assert.equal(output.readUInt32BE(4), 2);
  const firstOffset = output.readUInt32BE(16);
  const firstSize = output.readUInt32BE(20);
  const secondOffset = output.readUInt32BE(36);
  const secondSize = output.readUInt32BE(40);
  assert.equal(firstOffset % 16384, 0);
  assert.equal(secondOffset % 16384, 0);
  assert.deepEqual(output.subarray(firstOffset, firstOffset + firstSize), x64);
  assert.deepEqual(output.subarray(secondOffset, secondOffset + secondSize), arm64);
  assert.equal(output.length, secondOffset + secondSize);
  assert.equal((await stat(universalPath)).mode & 0o777, 0o755);
});

test('自带 lipo 拒绝重复架构', async () => {
  const temporary = await mkdtemp(path.join(os.tmpdir(), 'reader-lipo-duplicate-'));
  const first = path.join(temporary, 'first');
  const second = path.join(temporary, 'second');
  await writeFile(first, thinMachO(0x01000007, 3, 0x31));
  await writeFile(second, thinMachO(0x01000007, 3, 0x32));
  const result = spawnSync(lipo, [first, second, '-create', '-output', path.join(temporary, 'out')], {
    encoding: 'utf8'
  });
  assert.notEqual(result.status, 0);
  assert.match(result.stderr, /重复的 Mach-O 架构/);
});
