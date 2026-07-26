import { createHash, randomUUID } from 'node:crypto';
import { spawnSync } from 'node:child_process';
import { createReadStream } from 'node:fs';
import { chmod, readFile, rename, rm, stat, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { releaseBundleMetadata } from './bundle-metadata.mjs';

export const RELEASE_MANIFEST_FORMAT = 'reader-macos-release';
export const RELEASE_MANIFEST_FORMAT_VERSION = 1;
export const RELEASE_SIGNATURES = Object.freeze({
  AD_HOC: 'ad-hoc',
  NOTARIZED: 'developer-id-notarized'
});

function assert(condition, message) {
  if (!condition) throw new Error(message);
}

function assertExactKeys(value, expectedKeys, label) {
  const actual = Object.keys(value).sort();
  const expected = [...expectedKeys].sort();
  assert(
    actual.length === expected.length && actual.every((key, index) => key === expected[index]),
    `${label}字段无效`
  );
}

async function fileExists(filePath) {
  try {
    return (await stat(filePath)).isFile();
  } catch (error) {
    if (error?.code === 'ENOENT') return false;
    throw error;
  }
}

export async function sha256File(filePath) {
  const hash = createHash('sha256');
  for await (const chunk of createReadStream(filePath)) hash.update(chunk);
  return hash.digest('hex');
}

export function readGitSourceState(projectRoot) {
  const revision = spawnSync('git', ['rev-parse', 'HEAD'], {
    cwd: projectRoot,
    encoding: 'utf8'
  });
  if (revision.status !== 0) {
    throw new Error(`无法读取发行源码提交：${revision.stderr.trim() || 'git rev-parse 失败'}`);
  }
  const commit = revision.stdout.trim();
  assert(/^[0-9a-f]{40}$/.test(commit), '发行源码提交必须是 40 位小写 Git SHA');

  const diff = spawnSync('git', ['diff', '--quiet', 'HEAD', '--'], {
    cwd: projectRoot,
    encoding: 'utf8'
  });
  if (diff.status !== 0 && diff.status !== 1) {
    throw new Error(`无法检查发行源码状态：${diff.stderr.trim() || 'git diff 失败'}`);
  }
  return { commit, trackedChanges: diff.status === 1 };
}

function assertSource(source) {
  assert(source && typeof source === 'object' && !Array.isArray(source), '发行源码状态必须是对象');
  assertExactKeys(source, ['commit', 'trackedChanges'], '发行源码状态');
  assert(/^[0-9a-f]{40}$/.test(source?.commit || ''), '发行源码提交必须是 40 位小写 Git SHA');
  assert(typeof source?.trackedChanges === 'boolean', '发行源码 trackedChanges 必须是布尔值');
}

function expectedArtifactNames(version) {
  return {
    dmg: `Reader-${version}-universal.dmg`,
    update: `Reader-${version}-darwin-universal.zip`
  };
}

function assertArtifact(artifact, expectedName) {
  assert(artifact && typeof artifact === 'object' && !Array.isArray(artifact), '发行产物条目必须是对象');
  assertExactKeys(artifact, ['kind', 'fileName', 'byteSize', 'sha256'], '发行产物条目');
  assert(artifact.fileName === expectedName, `发行产物文件名不一致：期望 ${expectedName}`);
  assert(path.basename(artifact.fileName) === artifact.fileName, '发行产物不得包含路径');
  assert(Number.isSafeInteger(artifact.byteSize) && artifact.byteSize > 0, `${expectedName} 字节数无效`);
  assert(/^[0-9a-f]{64}$/.test(artifact.sha256 || ''), `${expectedName} SHA-256 无效`);
}

export function assertReleaseManifest(manifest) {
  assert(manifest && typeof manifest === 'object' && !Array.isArray(manifest), '发行清单必须是对象');
  assertExactKeys(manifest, [
    'format',
    'formatVersion',
    'product',
    'version',
    'buildVersion',
    'schemaVersion',
    'appId',
    'platform',
    'architecture',
    'electronVersion',
    'signature',
    'source',
    'artifacts'
  ], '发行清单');
  assert(manifest.format === RELEASE_MANIFEST_FORMAT, '发行清单格式无效');
  assert(manifest.formatVersion === RELEASE_MANIFEST_FORMAT_VERSION, '发行清单格式版本无效');
  assert(manifest.product === 'Reader', '发行产品名无效');
  assert(/^\d+\.\d+\.\d+$/.test(manifest.version || ''), '发行版本必须是三段数字');
  assert(/^[1-9]\d*$/.test(manifest.buildVersion || ''), '发行构建号必须是正整数');
  assert(Number.isSafeInteger(manifest.schemaVersion) && manifest.schemaVersion > 0, '发行 schemaVersion 无效');
  assert(manifest.appId === 'com.reader.localfirst', '发行 appId 无效');
  assert(manifest.platform === 'darwin', '发行平台无效');
  assert(manifest.architecture === 'universal', '发行架构无效');
  assert(/^\d+\.\d+\.\d+(?:[-+][0-9A-Za-z.-]+)?$/.test(manifest.electronVersion || ''), 'Electron 版本无效');
  assert(Object.values(RELEASE_SIGNATURES).includes(manifest.signature), '发行签名等级无效');
  assertSource(manifest.source);
  assert(Array.isArray(manifest.artifacts), '发行产物列表无效');

  const expectedNames = expectedArtifactNames(manifest.version);
  const expectedKinds = manifest.signature === RELEASE_SIGNATURES.NOTARIZED
    ? ['dmg', 'update']
    : ['dmg'];
  assert(manifest.artifacts.length === expectedKinds.length, '发行产物数量与签名等级不一致');
  for (let index = 0; index < expectedKinds.length; index += 1) {
    const kind = expectedKinds[index];
    const artifact = manifest.artifacts[index];
    assert(artifact?.kind === kind, `发行产物顺序无效：期望 ${kind}`);
    assertArtifact(artifact, expectedNames[kind]);
  }
  if (manifest.signature === RELEASE_SIGNATURES.NOTARIZED) {
    assert(!manifest.source.trackedChanges, 'Developer ID 公证发行禁止包含未提交的已跟踪改动');
  }
  return manifest;
}

async function artifactIdentity(kind, filePath) {
  const info = await stat(filePath);
  assert(info.isFile() && info.size > 0, `${path.basename(filePath)} 不是有效发行文件`);
  return {
    kind,
    fileName: path.basename(filePath),
    byteSize: info.size,
    sha256: await sha256File(filePath)
  };
}

export async function verifyReleaseManifest({ manifestPath, releaseRoot }) {
  const manifest = assertReleaseManifest(JSON.parse(await readFile(manifestPath, 'utf8')));
  for (const artifact of manifest.artifacts) {
    const artifactPath = path.join(releaseRoot, artifact.fileName);
    const actual = await artifactIdentity(artifact.kind, artifactPath);
    assert(actual.byteSize === artifact.byteSize, `${artifact.fileName} 字节数与发行清单不一致`);
    assert(actual.sha256 === artifact.sha256, `${artifact.fileName} SHA-256 与发行清单不一致`);
    const checksumPath = `${artifactPath}.sha256`;
    const checksum = await readFile(checksumPath, 'utf8');
    assert(checksum === `${artifact.sha256}  ${artifact.fileName}\n`, `${path.basename(checksumPath)} 内容无效`);
  }
  return manifest;
}

async function atomicWrite(filePath, content) {
  const temporary = `${filePath}.tmp-${process.pid}-${randomUUID()}`;
  try {
    await writeFile(temporary, content, { flag: 'wx', mode: 0o644 });
    await chmod(temporary, 0o644);
    await rename(temporary, filePath);
  } finally {
    await rm(temporary, { force: true });
  }
}

export async function writeMacReleaseManifest({
  projectRoot,
  releaseRoot,
  packageMetadata,
  schemaVersion,
  electronVersion,
  signature = RELEASE_SIGNATURES.AD_HOC,
  source = readGitSourceState(projectRoot)
}) {
  const { version, buildVersion } = releaseBundleMetadata(packageMetadata);
  assert(packageMetadata?.build?.productName === 'Reader', '发行 productName 必须是 Reader');
  assert(packageMetadata?.build?.appId === 'com.reader.localfirst', '发行 appId 必须是 com.reader.localfirst');
  assertSource(source);
  assert(Object.values(RELEASE_SIGNATURES).includes(signature), '发行签名等级无效');
  if (signature === RELEASE_SIGNATURES.NOTARIZED && source.trackedChanges) {
    throw new Error('Developer ID 公证发行禁止包含未提交的已跟踪改动');
  }

  const names = expectedArtifactNames(version);
  const dmgPath = path.join(releaseRoot, names.dmg);
  const updatePath = path.join(releaseRoot, names.update);
  const updateExists = await fileExists(updatePath);
  if (signature === RELEASE_SIGNATURES.NOTARIZED && !updateExists) {
    throw new Error('Developer ID 公证发行缺少 universal 更新 ZIP');
  }
  if (signature === RELEASE_SIGNATURES.AD_HOC && updateExists) {
    throw new Error('ad-hoc 发行目录仍含同版本更新 ZIP，拒绝生成含混清单');
  }

  const artifacts = [await artifactIdentity('dmg', dmgPath)];
  if (signature === RELEASE_SIGNATURES.NOTARIZED) {
    artifacts.push(await artifactIdentity('update', updatePath));
  }
  const manifest = assertReleaseManifest({
    format: RELEASE_MANIFEST_FORMAT,
    formatVersion: RELEASE_MANIFEST_FORMAT_VERSION,
    product: 'Reader',
    version,
    buildVersion,
    schemaVersion,
    appId: packageMetadata.build.appId,
    platform: 'darwin',
    architecture: 'universal',
    electronVersion,
    signature,
    source,
    artifacts
  });
  const manifestPath = path.join(releaseRoot, `Reader-${version}-release.json`);

  for (const artifact of artifacts) {
    await atomicWrite(
      path.join(releaseRoot, `${artifact.fileName}.sha256`),
      `${artifact.sha256}  ${artifact.fileName}\n`
    );
  }
  if (signature === RELEASE_SIGNATURES.AD_HOC) {
    await rm(`${updatePath}.sha256`, { force: true });
  }
  await atomicWrite(manifestPath, `${JSON.stringify(manifest, null, 2)}\n`);

  const verified = await verifyReleaseManifest({ manifestPath, releaseRoot });
  assert(JSON.stringify(verified) === JSON.stringify(manifest), '发行清单写入后内容发生变化');
  return { manifest, manifestPath };
}
