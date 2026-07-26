import { execFileSync } from 'node:child_process';

const plistBuddy = '/usr/libexec/PlistBuddy';

export function releaseBundleMetadata(packageMetadata) {
  const version = String(packageMetadata?.version || '');
  const buildVersion = String(packageMetadata?.build?.buildVersion || '');
  if (!/^\d+\.\d+\.\d+$/.test(version)) throw new Error('Reader 发行版本必须是三段数字');
  if (!/^[1-9]\d*$/.test(buildVersion)) throw new Error('Reader buildVersion 必须是正整数');
  return { version, buildVersion };
}

export function assertBundleMetadata(plist, label, metadata) {
  if (plist?.CFBundleShortVersionString !== metadata.version) {
    throw new Error(`${label} 营销版本不一致：期望 ${metadata.version}，实际 ${plist?.CFBundleShortVersionString || '缺失'}`);
  }
  if (plist?.CFBundleVersion !== metadata.buildVersion) {
    throw new Error(`${label} 构建号不一致：期望 ${metadata.buildVersion}，实际 ${plist?.CFBundleVersion || '缺失'}`);
  }
}

export function readBundlePlist(plistPath) {
  return JSON.parse(execFileSync('/usr/bin/plutil', ['-convert', 'json', '-o', '-', plistPath], { encoding: 'utf8' }));
}

export function stampBundleMetadata(plistPath, metadata, label) {
  execFileSync(plistBuddy, ['-c', `Set :CFBundleShortVersionString ${metadata.version}`, plistPath]);
  execFileSync(plistBuddy, ['-c', `Set :CFBundleVersion ${metadata.buildVersion}`, plistPath]);
  assertBundleMetadata(readBundlePlist(plistPath), label, metadata);
}
