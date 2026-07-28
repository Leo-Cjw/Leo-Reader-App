import test from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import path from 'node:path';
import { APP_VERSION } from '../src/server/version.mjs';
import { SCHEMA_VERSION } from '../src/server/schema.mjs';

const root = path.resolve(import.meta.dirname, '..');

test('Reader 1.1.0 version, build, schema and four bundle identities stay consistent', async () => {
  const packageJSON = JSON.parse(await readFile(path.join(root, 'package.json'), 'utf8'));
  assert.equal(packageJSON.version, '1.1.0');
  assert.equal(packageJSON.build.buildVersion, '110');
  assert.equal(APP_VERSION, packageJSON.version);
  assert.equal(SCHEMA_VERSION, 13);
  for (const relative of [
    'native/share-extension/Info.plist',
    'native/spotlight-helper/Info.plist',
    'native/transcription-helper/Info.plist'
  ]) {
    const plist = await readFile(path.join(root, relative), 'utf8');
    assert.match(plist, /<key>CFBundleShortVersionString<\/key>\s*<string>1\.1\.0<\/string>/);
    assert.match(plist, /<key>CFBundleVersion<\/key>\s*<string>110<\/string>/);
  }
  assert.ok(packageJSON.build.extraResources.some((entry) => entry.to === 'Reader Transcription Helper.app'));
  const universal = await readFile(path.join(root, 'scripts/build-universal-mac.mjs'), 'utf8');
  assert.match(universal, /Reader Transcription Helper/);
  assert.match(universal, /transcriptionArchitectures/);
});

test('README and import SOP link the canonical platform matrix without promoting best-effort platforms', async () => {
  const [readme, platforms, importSOP, roadmap, releaseNotes] = await Promise.all([
    readFile(path.join(root, 'README.md'), 'utf8'),
    readFile(path.join(root, 'docs/PLATFORM_SUPPORT.md'), 'utf8'),
    readFile(path.join(root, 'docs/IMPORT_SOP.md'), 'utf8'),
    readFile(path.join(root, 'docs/PRODUCT_ROADMAP.md'), 'utf8'),
    readFile(path.join(root, 'docs/RELEASE_NOTES_1.1.0.md'), 'utf8')
  ]);
  assert.match(readme, /\[平台支持矩阵\]\(docs\/PLATFORM_SUPPORT\.md\)/);
  assert.match(readme, /\[平台导入 SOP\]\(docs\/IMPORT_SOP\.md\)/);
  assert.match(importSOP, /\[PLATFORM_SUPPORT\.md\]\(PLATFORM_SUPPORT\.md\)/);
  assert.match(platforms, /\| 抖音 \| 完整支持 \|/);
  assert.match(platforms, /\| 微信公众号 \| 专用部分支持 \|/);
  for (const platform of ['CSDN', '掘金', '知乎', '今日头条', 'B站', '小宇宙']) {
    assert.match(platforms, new RegExp(`\\| ${platform} \\| 通用网页尽力导入 \\|`));
    assert.match(importSOP, new RegExp(platform));
  }
  for (const platform of ['RSS / Atom', 'YouTube', 'X', '微博']) assert.match(importSOP, new RegExp(platform.replace(' / ', ' \\/ ')));
  assert.match(platforms, /\| 小红书 \| 不支持 \|/);
  assert.match(importSOP, /小红书当前明确不支持/);
  assert.match(roadmap, /1\.1\.0（build 110、schema v13）/);
  assert.match(releaseNotes, /Reader 1\.1\.0（build 110，SQLite schema v13）/);
  assert.doesNotMatch(`${readme}\n${importSOP}`, /(?:CSDN|掘金|知乎|今日头条|B站|小宇宙)[^\n|]*\|\s*完整支持/);
});
