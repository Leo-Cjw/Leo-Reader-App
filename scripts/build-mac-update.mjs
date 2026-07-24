import { execFileSync } from 'node:child_process';
import { mkdtemp, readFile, rm } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { inspectDeveloperIDSignature } from '../desktop/updates.mjs';

const projectRoot = path.resolve(import.meta.dirname, '..');
const packageMetadata = JSON.parse(await readFile(path.join(projectRoot, 'package.json'), 'utf8'));
const appPath = path.resolve(
  process.env.READER_UPDATE_APP || path.join(projectRoot, 'release', 'mac-universal', 'Reader.app')
);
const outputPath = path.resolve(
  process.env.READER_UPDATE_OUTPUT
    || path.join(projectRoot, 'release', `Reader-${packageMetadata.version}-darwin-universal.zip`)
);
const temporaryRoot = await mkdtemp(path.join(os.tmpdir(), 'reader-update-'));
const extractedApp = path.join(temporaryRoot, 'Reader.app');

try {
  if (!await inspectDeveloperIDSignature(appPath)) {
    throw new Error('更新 ZIP 只允许从 Apple Developer ID 正式签名的 Reader.app 生成');
  }
  execFileSync('/usr/bin/xcrun', ['stapler', 'validate', appPath], { stdio: 'inherit' });
  await rm(outputPath, { force: true });
  execFileSync('/usr/bin/ditto', [
    '-c', '-k', '--sequesterRsrc', '--keepParent', appPath, outputPath
  ], { stdio: 'inherit' });
  execFileSync('/usr/bin/ditto', ['-x', '-k', outputPath, temporaryRoot], { stdio: 'inherit' });
  execFileSync('/usr/bin/codesign', [
    '--verify', '--deep', '--strict', '--verbose=1', extractedApp
  ], { stdio: 'inherit' });
  execFileSync('/usr/bin/xcrun', ['stapler', 'validate', extractedApp], { stdio: 'inherit' });
  console.log(outputPath);
} finally {
  await rm(temporaryRoot, { recursive: true, force: true });
}
