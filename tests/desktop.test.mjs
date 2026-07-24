import test from 'node:test';
import assert from 'node:assert/strict';
import { access, mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { createReaderServer } from '../src/server/server.mjs';
import { isAllowedAppURL, isSafeExternalURL, resolveDesktopDataRoot } from '../desktop/security.mjs';

const projectRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');

test('desktop navigation only trusts the exact local app origin', () => {
  const origin = 'http://127.0.0.1:43129';
  assert.equal(isAllowedAppURL(`${origin}/?desktop=1`, origin), true);
  assert.equal(isAllowedAppURL(`${origin}/api/health`, origin), true);
  assert.equal(isAllowedAppURL('http://127.0.0.1:43128/', origin), false);
  assert.equal(isAllowedAppURL('http://127.0.0.1:43129.evil.example/', origin), false);
  assert.equal(isAllowedAppURL('http://127.0.0.1:43129@evil.example/', origin), false);
  assert.equal(isAllowedAppURL('javascript:alert(1)', origin), false);

  assert.equal(isSafeExternalURL('https://example.com/article'), true);
  assert.equal(isSafeExternalURL('http://example.com/article'), true);
  assert.equal(isSafeExternalURL('file:///tmp/private'), false);
  assert.equal(isSafeExternalURL('data:text/html,hello'), false);
  assert.equal(isSafeExternalURL('javascript:alert(1)'), false);
});

test('desktop data root is isolated and overrides must be absolute', () => {
  assert.equal(resolveDesktopDataRoot('/Users/test/Library/Application Support/Reader'), '/Users/test/Library/Application Support/Reader/ReaderData');
  assert.equal(resolveDesktopDataRoot('/ignored', '/tmp/reader-desktop-test'), '/tmp/reader-desktop-test');
  assert.throws(() => resolveDesktopDataRoot('/ignored', 'relative/path'), /必须是绝对路径/);
});

test('server can serve packaged web assets while writing only to the user data root', async (t) => {
  const tempRoot = await mkdtemp(path.join(os.tmpdir(), 'reader-desktop-'));
  t.after(() => rm(tempRoot, { recursive: true, force: true }));
  const dataRoot = path.join(tempRoot, 'user-data');
  const webRoot = path.join(tempRoot, 'read-only-app', 'dist');
  await mkdir(webRoot, { recursive: true });
  await writeFile(path.join(webRoot, 'index.html'), '<!doctype html><title>Packaged Reader</title>');

  const dbPath = path.join(dataRoot, 'data', 'reader.sqlite3');
  const app = await createReaderServer({ rootDir: dataRoot, webRoot, dbPath, port: 0 });
  const address = await app.listen();
  t.after(() => app.close());

  const response = await fetch(`http://127.0.0.1:${address.port}/`);
  assert.equal(response.status, 200);
  assert.match(await response.text(), /Packaged Reader/);
  await access(dbPath);
  await assert.rejects(access(path.join(webRoot, 'reader.sqlite3')));
});

test('desktop package keeps Electron sandbox boundaries and a restrictive CSP', async () => {
  const packageJSON = JSON.parse(await readFile(path.join(projectRoot, 'package.json'), 'utf8'));
  assert.equal(packageJSON.main, 'desktop/main.mjs');
  assert.equal(packageJSON.build.appId, 'com.reader.localfirst');
  assert.equal(packageJSON.build.mac.identity, null);
  assert.equal(packageJSON.build.afterPack, 'scripts/after-pack.cjs');

  const main = await readFile(path.join(projectRoot, 'desktop', 'main.mjs'), 'utf8');
  assert.match(main, /app\.enableSandbox\(\)/);
  assert.match(main, /nodeIntegration:\s*false/);
  assert.match(main, /contextIsolation:\s*true/);
  assert.match(main, /sandbox:\s*true/);
  assert.match(main, /setPermissionRequestHandler/);

  const html = await readFile(path.join(projectRoot, 'index.html'), 'utf8');
  assert.match(html, /Content-Security-Policy/);
  assert.match(html, /frame-src 'none'/);
  assert.match(html, /base-uri 'none'/);

  const afterPack = await readFile(path.join(projectRoot, 'scripts', 'after-pack.cjs'), 'utf8');
  assert.match(afterPack, /NSAllowsArbitraryLoads bool false/);
  assert.match(afterPack, /NSCameraUsageDescription/);
  assert.match(afterPack, /NSMicrophoneUsageDescription/);
});

test('sidebar collections keep their declared keyboard tree contract', async () => {
  const app = await readFile(path.join(projectRoot, 'src', 'web', 'App.tsx'), 'utf8');
  const styles = await readFile(path.join(projectRoot, 'src', 'web', 'styles.css'), 'utf8');

  assert.match(app, /role="tree"/);
  assert.match(app, /role="treeitem"/);
  for (const attribute of ['aria-level', 'aria-posinset', 'aria-setsize', 'aria-expanded', 'aria-selected']) {
    assert.match(app, new RegExp(attribute));
  }
  for (const key of ['ArrowDown', 'ArrowUp', 'ArrowRight', 'ArrowLeft', 'Home', 'End', 'Enter']) {
    assert.match(app, new RegExp(`event\\.key === '${key}'`));
  }
  assert.match(app, /event\.key === ' '/);
  assert.match(app, /event\.currentTarget\.click\(\)/);
  assert.match(styles, /\.collection-nav \[role="treeitem"\]:focus-visible/);
});

test('editor and highlights keep their declared keyboard and announcement contract', async () => {
  const app = await readFile(path.join(projectRoot, 'src', 'web', 'App.tsx'), 'utf8');
  const styles = await readFile(path.join(projectRoot, 'src', 'web', 'styles.css'), 'utf8');

  assert.match(app, /handleEditorKeyDown/);
  assert.match(app, /event\.key\.toLowerCase\(\) !== 's'/);
  assert.match(app, /aria-label="上传文章图片"/);
  assert.match(app, /aria-labelledby="editor-source-title"/);
  assert.match(app, /aria-labelledby="editor-preview-title"/);
  assert.match(app, /role="status" aria-live="polite"/);
  assert.match(app, /aria-describedby="selection-popover-quote"/);
  assert.match(app, /handleSelectionEscape/);
  assert.match(app, /document\.addEventListener\('keydown', handleSelectionEscape, true\)/);
  assert.match(app, /aria-pressed=/);
  assert.match(app, /role="region" tabIndex=\{0\} aria-label="文章正文，可选择文字创建高亮"/);
  assert.match(app, /tabIndex=\{-1\} aria-label="高亮与批注"/);
  assert.match(styles, /\.editor-image-upload:focus-within/);
  assert.match(styles, /\.annotations:focus-visible/);
});
