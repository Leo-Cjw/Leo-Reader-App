import { execFileSync } from 'node:child_process';
import { cp, mkdtemp, mkdir, readFile, rm, symlink } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';

const projectRoot = path.resolve(import.meta.dirname, '..');
const packageMetadata = JSON.parse(await readFile(path.join(projectRoot, 'package.json'), 'utf8'));
const version = packageMetadata.version;
const appPath = path.resolve(process.env.READER_DMG_APP || path.join(projectRoot, 'release', 'mac-universal', 'Reader.app'));
const outputPath = path.resolve(process.env.READER_DMG_OUTPUT || path.join(projectRoot, 'release', `Reader-${version}-universal.dmg`));
const temporaryRoot = await mkdtemp(path.join(os.tmpdir(), 'reader-dmg-'));
const staging = path.join(temporaryRoot, 'Reader');

try {
  await mkdir(staging, { recursive: true });
  await cp(appPath, path.join(staging, 'Reader.app'), { recursive: true, preserveTimestamps: true, verbatimSymlinks: true });
  await symlink('/Applications', path.join(staging, 'Applications'));
  await rm(outputPath, { force: true });
  execFileSync('/usr/bin/hdiutil', [
    'create',
    '-volname', `Reader ${version}`,
    '-srcfolder', staging,
    '-format', 'UDZO',
    '-imagekey', 'zlib-level=9',
    '-ov',
    outputPath
  ], { stdio: 'inherit' });
  execFileSync('/usr/bin/hdiutil', ['verify', outputPath], { stdio: 'inherit' });
  console.log(outputPath);
} finally {
  await rm(temporaryRoot, { recursive: true, force: true });
}
