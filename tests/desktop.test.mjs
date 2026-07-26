import test from 'node:test';
import assert from 'node:assert/strict';
import { access, mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { createReaderServer } from '../src/server/server.mjs';
import { extractReaderAddDeepLink, extractReaderDeepLink, extractReaderOpenDeepLink, isAllowedAppURL, isSafeExternalURL, MAX_READER_SHARED_TEXT_BYTES, normalizeArticleWindowId, parseReaderAddDeepLink, parseReaderDeepLink, parseReaderOpenDeepLink, READER_PROTOCOL_SCHEME, resolveDesktopDataRoot } from '../desktop/security.mjs';

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

test('focused reader window ids stay bounded without narrowing valid local article ids', () => {
  assert.equal(normalizeArticleWindowId('local-first-reading'), 'local-first-reading');
  assert.equal(normalizeArticleWindowId('导入文章 01'), '导入文章 01');
  for (const candidate of ['', 'a'.repeat(201), 'article\nother', 'article\u0000other', null, 42]) {
    assert.equal(normalizeArticleWindowId(candidate), null);
  }
});

test('desktop add deep links accept one bounded URL, base64url text or opaque shared-file token', () => {
  assert.equal(READER_PROTOCOL_SCHEME, 'reader-local');
  assert.equal(
    parseReaderDeepLink('reader-local://add?url=https%3A%2F%2Fexample.com%2Farticle%3Fpage%3D2%23notes'),
    'https://example.com/article?page=2#notes'
  );
  assert.equal(parseReaderDeepLink('reader-local://add/?url=http%3A%2F%2Fexample.com'), 'http://example.com/');
  assert.equal(extractReaderDeepLink(['Reader', '--flag', 'reader-local://add?url=https%3A%2F%2Fexample.com%2Ffrom-argv']), 'https://example.com/from-argv');
  const sharedText = 'Reader 选中文本\n只在用户确认后保存。';
  const encodedText = Buffer.from(sharedText).toString('base64url');
  assert.deepEqual(parseReaderAddDeepLink(`reader-local://add?text=${encodedText}`), { kind: 'text', text: sharedText });
  assert.deepEqual(extractReaderAddDeepLink(['Reader', `reader-local://add?text=${encodedText}`]), { kind: 'text', text: sharedText });
  assert.equal(parseReaderDeepLink(`reader-local://add?text=${encodedText}`), null);
  assert.equal(MAX_READER_SHARED_TEXT_BYTES, 4096);
  const fileToken = '123e4567-e89b-42d3-a456-426614174000';
  assert.deepEqual(parseReaderAddDeepLink(`reader-local://add?file=${fileToken}`), { kind: 'file', token: fileToken });
  assert.deepEqual(extractReaderAddDeepLink(['Reader', `reader-local://add?file=${fileToken}`]), { kind: 'file', token: fileToken });

  for (const candidate of [
    'reader-local://add',
    'reader-local://add?url=javascript%3Aalert(1)',
    'reader-local://add?url=file%3A%2F%2F%2Ftmp%2Fprivate',
    'reader-local://add?url=https%3A%2F%2Fuser%3Asecret%40example.com',
    'reader-local://add?url=https%3A%2F%2Fexample.com&url=https%3A%2F%2Fother.example',
    `reader-local://add?url=https%3A%2F%2Fexample.com&text=${encodedText}`,
    `reader-local://add?url=https%3A%2F%2Fexample.com&file=${fileToken}`,
    `reader-local://add?text=${encodedText}&file=${fileToken}`,
    `reader-local://add?text=${encodedText}&text=${encodedText}`,
    `reader-local://add?file=${fileToken}&file=${fileToken}`,
    'reader-local://add?file=../private',
    `reader-local://add?file=${fileToken.toUpperCase()}`,
    'reader-local://add?file=123e4567-e89b-12d3-a456-426614174000',
    'reader-local://add?text=not+base64url',
    `reader-local://add?text=${Buffer.from('Reader\u0000secret').toString('base64url')}`,
    `reader-local://add?text=${Buffer.from('中'.repeat(1366) + 'x').toString('base64url')}`,
    'reader-local://add?url=https%3A%2F%2Fexample.com&action=import',
    'reader-local://settings?url=https%3A%2F%2Fexample.com',
    'reader-local://user@add?url=https%3A%2F%2Fexample.com',
    'reader-local://add/path?url=https%3A%2F%2Fexample.com',
    'reader-local://add?url=https%3A%2F%2Fexample.com#fragment',
    'reader://add?url=https%3A%2F%2Fexample.com'
  ]) assert.equal(parseReaderAddDeepLink(candidate), null, candidate);
  assert.equal(parseReaderDeepLink(`reader-local://add?url=${encodeURIComponent(`https://example.com/${'a'.repeat(2049)}`)}`), null);
  assert.equal(extractReaderDeepLink(['Reader', '--flag']), null);
});

test('Spotlight deep links open exactly one bounded local article id', () => {
  assert.equal(parseReaderOpenDeepLink('reader-local://open?article=local-first-reading'), 'local-first-reading');
  assert.equal(parseReaderOpenDeepLink('reader-local://open/?article=%E6%9C%AC%E5%9C%B0%E6%96%87%E7%AB%A0'), '本地文章');
  assert.equal(extractReaderOpenDeepLink(['Reader', 'reader-local://open?article=from-spotlight']), 'from-spotlight');
  for (const candidate of [
    'reader-local://open',
    'reader-local://open?article=',
    'reader-local://open?article=one&article=two',
    'reader-local://open?article=one&url=https://example.com',
    'reader-local://open/path?article=one',
    'reader-local://user@open?article=one',
    'reader-local://open?article=one#fragment',
    `reader-local://open?article=${'a'.repeat(201)}`
  ]) assert.equal(parseReaderOpenDeepLink(candidate), null, candidate);
});

test('desktop URL, text and file handoffs wait for the renderer and still require add-dialog confirmation', async () => {
  const main = await readFile(path.join(projectRoot, 'desktop', 'main.mjs'), 'utf8');
  const preload = await readFile(path.join(projectRoot, 'desktop', 'preload.cjs'), 'utf8');
  const app = await readFile(path.join(projectRoot, 'src', 'web', 'App.tsx'), 'utf8');

  assert.match(main, /const pendingAddRequests = \[\]/);
  assert.match(main, /if \(!rendererReady .* return/);
  assert.match(main, /mainWindow\.webContents\.send\('reader:add-request', request\)/);
  assert.match(main, /rendererReady = true;\s+flushPendingAddRequests\(\)/);
  assert.match(preload, /if \(!addRequestListeners\.size\)/);
  assert.match(preload, /for \(const request of pendingAddRequests\.splice\(0\)\) callback\(request\)/);
  assert.match(preload, /Buffer\.byteLength\(value\.text, 'utf8'\) <= 4096/);
  assert.match(preload, /value\.kind === 'file'/);
  assert.match(preload, /ipcRenderer\.invoke\('reader:inspect-shared-file', token\)/);
  assert.match(preload, /ipcRenderer\.invoke\('reader:import-shared-file', token, collectionId\)/);
  assert.match(preload, /ipcRenderer\.invoke\('reader:discard-shared-file', token\)/);
  assert.match(main, /createSharedFileManager/);
  assert.match(main, /standardShareStagingRoot\(app\.getPath\('home'\)\)/);
  assert.match(main, /ipcMain\.handle\('reader:inspect-shared-file'/);
  assert.match(main, /ipcMain\.handle\('reader:import-shared-file'/);
  assert.match(main, /ipcMain\.handle\('reader:discard-shared-file'/);
  assert.match(app, /const \[externalAddRequests, setExternalAddRequests\] = useState<ExternalAddRequest\[\]>\(\[\]\)/);
  assert.match(app, /window\.readerDesktop\?\.onAddRequest/);
  assert.match(app, /initialRequest=\{externalAddRequests\[0\]\}/);
  assert.match(app, /initialRequest\?\.kind === 'file' \? 'attachment' : 'url'/);
  assert.match(app, /initialRequest\?\.kind === 'text' \? '分享的文本摘录' : ''/);
  assert.match(app, /initialRequest\?\.kind === 'text' \? initialRequest\.text : ''/);
  assert.match(app, /inspectSharedFile\(initialRequest\.token\)/);
  assert.match(app, /importSharedFile\(initialRequest\.token, collection\)/);
  assert.match(app, /discardSharedFile\(initialRequest\.token\)/);
  assert.match(app, /if \(tab === 'url'\) \{ const job = await api\.createURLImport\(url, collection\)/);
  assert.match(app, /if \(tab === 'markdown'\) onCreated\(await api\.createMarkdown\(title, content, collection\)\)/);
  assert.doesNotMatch(main, /createURLImport|api\/import-jobs/);
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
  assert.equal(response.headers.get('content-security-policy'), "frame-ancestors 'self'");
  assert.equal(response.headers.get('cross-origin-opener-policy'), 'same-origin');
  assert.equal(response.headers.get('cross-origin-resource-policy'), 'same-origin');
  assert.equal(response.headers.get('permissions-policy'), 'camera=(), geolocation=(), microphone=()');
  assert.equal(response.headers.get('referrer-policy'), 'no-referrer');
  assert.equal(response.headers.get('x-content-type-options'), 'nosniff');
  assert.equal(response.headers.get('x-frame-options'), 'SAMEORIGIN');
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
  assert.match(main, /createDesktopBackgroundCoordinator/);
  assert.match(main, /await backgroundCoordinator\.start\(\)/);
  assert.match(main, /createUpdateController/);
  assert.match(main, /createRendererRecoveryController/);
  assert.match(main, /createImportNotificationController/);
  assert.match(main, /createSourceSyncNotificationController/);
  assert.match(main, /onImportBatchFinished/);
  assert.match(main, /onSourceSyncBatchFinished/);
  assert.match(main, /BrowserWindow\.getAllWindows\(\)\.some/);
  assert.match(main, /sendCommand\('import-queue'\)/);
  assert.match(main, /sendCommand\('sources'\)/);
  assert.match(main, /window\.webContents\.on\('render-process-gone'/);
  assert.match(main, /window\.webContents\.on\('did-finish-load'/);
  assert.match(main, /检查更新…/);
  assert.match(main, /app\.on\('open-url'/);
  assert.match(main, /extractReaderAddDeepLink\(commandLine\)/);
  assert.match(main, /app\.setAsDefaultProtocolClient\(READER_PROTOCOL_SCHEME\)/);
  assert.match(main, /process\.env\.READER_RELEASE_QA !== '1'/);
  assert.match(main, /if \(!window\.isDestroyed\(\)\) \{/);
  assert.match(main, /window\.show\(\)/);
  assert.doesNotMatch(main, /once\('ready-to-show'/);

  const html = await readFile(path.join(projectRoot, 'index.html'), 'utf8');
  assert.match(html, /Content-Security-Policy/);
  assert.match(html, /frame-src 'none'/);
  assert.match(html, /base-uri 'none'/);

  const afterPack = await readFile(path.join(projectRoot, 'scripts', 'after-pack.cjs'), 'utf8');
  assert.match(afterPack, /NSAllowsArbitraryLoads bool false/);
  assert.match(afterPack, /NSCameraUsageDescription/);
  assert.match(afterPack, /NSMicrophoneUsageDescription/);

  const release = await readFile(path.join(projectRoot, 'scripts', 'build-mac-release.mjs'), 'utf8');
  assert.match(release, /notarize\(\{\s*appPath,/);
  assert.match(release, /build-mac-update\.mjs/);
  assert.match(release, /不生成自动更新 ZIP/);
  assert.match(release, /verify-packaged-accessibility\.mjs/);

  const accessibilityGate = await readFile(path.join(projectRoot, 'scripts', 'verify-packaged-accessibility.mjs'), 'utf8');
  const packagedQA = await readFile(path.join(projectRoot, 'scripts', 'lib', 'packaged-reader-qa.mjs'), 'utf8');
  assert.match(packagedQA, /--remote-debugging-address=127\.0\.0\.1/);
  assert.match(packagedQA, /--remote-debugging-port=0/);
  assert.match(packagedQA, /READER_RELEASE_QA: '1'/);
  assert.match(packagedQA, /Accessibility\.getFullAXTree/);
  assert.match(accessibilityGate, /assertNamedControls\(workspaceTree, '主工作区'\)/);
  assert.match(accessibilityGate, /temporary data isolated=true/);

  assert.deepEqual(packageJSON.build.protocols, [{ name: 'Reader URL', schemes: ['reader-local'], role: 'Viewer' }]);
  assert.deepEqual(packageJSON.build.extraResources, [{ from: 'build/Reader Spotlight Helper.app', to: 'Reader Spotlight Helper.app' }]);
  assert.match(packageJSON.scripts['desktop:pack:x64'], /spotlight:mac/);
  assert.match(release, /spotlight:mac/);
  assert.match(afterPack, /NSUserActivityTypes/);
  assert.match(afterPack, /com\.apple\.corespotlightitem/);

  const helper = await readFile(path.join(projectRoot, 'native', 'spotlight-helper', 'main.swift'), 'utf8');
  assert.match(helper, /completeUntilFirstUserAuthentication/);
  assert.match(helper, /reader-local/);
  assert.match(helper, /CSSearchableItemActionType/);
  assert.match(main, /spotlightHelperPath/);
  assert.match(main, /app\.on\('continue-activity'/);
});

test('focused reading windows use narrow trusted IPC, deduplicate by article and stay read-only', async () => {
  const main = await readFile(path.join(projectRoot, 'desktop', 'main.mjs'), 'utf8');
  const preload = await readFile(path.join(projectRoot, 'desktop', 'preload.cjs'), 'utf8');
  const app = await readFile(path.join(projectRoot, 'src', 'web', 'App.tsx'), 'utf8');
  const styles = await readFile(path.join(projectRoot, 'src', 'web', 'styles.css'), 'utf8');

  assert.match(main, /const articleWindows = new Map\(\)/);
  assert.match(main, /const existing = articleWindows\.get\(articleId\)/);
  assert.match(main, /new BrowserWindow\(desktopWindowOptions\(\{ focusedReader: true \}\)\)/);
  assert.match(main, /isAllowedAppURL\(event\.senderFrame\?\.url \|\| event\.sender\.getURL\(\), appOrigin\)/);
  assert.match(main, /readerServer\?\.database\.getArticle\(articleId\)/);
  assert.match(main, /new URLSearchParams\(\{ desktop: '1', readerWindow: '1', article: articleId \}\)/);
  assert.match(preload, /openArticleWindow\(articleId\)/);
  assert.match(preload, /ipcRenderer\.invoke\('reader:open-article-window', articleId\)/);
  assert.match(preload, /focusLibrary\(\)/);
  assert.match(main, /if \(\(!mainWindow \|\| mainWindow\.isDestroyed\(\)\) && appOrigin\) await createWindow\(\)/);
  assert.doesNotMatch(preload, /BrowserWindow|loadURL|database/);
  assert.match(app, /function FocusedReaderApp/);
  assert.match(app, /readOnly/);
  assert.match(app, /aria-label=\{readOnly \? '文章正文，只读'/);
  assert.match(app, /readOnly \? '返回资料库即可创建'/);
  assert.match(app, /!readOnly && selectionDraft/);
  assert.match(app, /!readOnly && <button type="button" className="annotation-delete"/);
  assert.match(styles, /\.focused-reader-stage \.reader-toolbar/);
  assert.match(styles, /-webkit-app-region: drag/);
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

test('screen reader state mirrors visual selection and article metadata', async () => {
  const app = await readFile(path.join(projectRoot, 'src', 'web', 'App.tsx'), 'utf8');

  assert.match(app, /aria-current=\{view === item\.view/);
  assert.match(app, /aria-current=\{smartCollectionId === collection\.id/);
  assert.match(app, /aria-current=\{tagFilter === tag\.name/);
  for (const label of ['内容类型', '文章助手功能', '检索范围', '添加内容类型', '规则匹配方式']) {
    assert.match(app, new RegExp(`role="group" aria-label="${label}"`));
  }
  assert.ok((app.match(/aria-pressed=/g) || []).length >= 10);
  assert.match(app, /const descriptionId = `article-description-\$\{article\.id\}`/);
  assert.equal((app.match(/aria-describedby=\{descriptionId\}/g) || []).length, 2);
  assert.match(app, /<span id=\{descriptionId\} hidden>/);
  assert.match(app, /aria-current=\{selectedId === article\.id/);
  assert.match(app, /article\.is_read \? '已读' : '未读'/);
  assert.match(app, /article\.is_favorite \? '，已收藏'/);
  assert.match(app, /article\.excerpt\.slice\(0, 180\)/);
  assert.match(app, /aria-pressed=\{background\.importUserPaused\}/);
  assert.match(app, /className="queue-summary" aria-live="polite"/);
  assert.match(app, /backgroundWork\.importsPaused \? `\$\{activeJobCount\} 个导入任务已暂停`/);
});

test('named panes announce asynchronous reading state and honor reduced motion', async () => {
  const app = await readFile(path.join(projectRoot, 'src', 'web', 'App.tsx'), 'utf8');
  const styles = await readFile(path.join(projectRoot, 'src', 'web', 'styles.css'), 'utf8');

  assert.match(app, /className="sidebar" aria-label="产品导航"/);
  assert.match(app, /className="ai-panel" aria-label="AI 文章助手"/);
  assert.match(app, /aria-labelledby="library-pane-title" aria-busy=\{loading \|\| loadingMore\}/);
  assert.match(app, /<h1 id="library-pane-title">/);
  assert.match(app, /const currentArticle = selected\?\.id === selectedId \? selected : null/);
  assert.match(app, /已载入文章：\$\{currentArticle\.title\}/);
  assert.match(app, /aria-busy=\{Boolean\(loadingTitle\)\}/);
  assert.match(app, /aria-label=\{`阅读器：\$\{article\.title\}`\}/);
  assert.match(app, /matchMedia\('\(prefers-reduced-motion: reduce\)'\)/);
  assert.equal((app.match(/behavior: preferredScrollBehavior\(\)/g) || []).length, 2);
  assert.match(styles, /@media \(prefers-reduced-motion: reduce\)/);
  assert.match(styles, /animation-duration: \.01ms !important/);
  assert.match(styles, /transition-duration: \.01ms !important/);
});

test('modal dialogs isolate background and lower dialog layers while preserving keyboard focus', async () => {
  const app = await readFile(path.join(projectRoot, 'src', 'web', 'App.tsx'), 'utf8');

  assert.match(app, /function DialogAccessibilityManager\(\) \{\s+useLayoutEffect\(\(\) => \{/);
  assert.match(app, /const dialogs = \[\.\.\.document\.querySelectorAll<HTMLElement>\('\[role="dialog"\]\[aria-modal="true"\]'\)\]/);
  assert.match(app, /appWindow\?\.toggleAttribute\('inert', Boolean\(dialog\)\)/);
  assert.match(app, /candidate\.toggleAttribute\('inert', candidate !== dialog\)/);
  assert.match(app, /const labelledElement = \(dialog: HTMLElement\)/);
  assert.match(app, /\(label \|\| focusableElements\(dialog\)\[0\] \|\| dialog\)\.focus\(\)/);
  assert.match(app, /if \(dialog && !dialog\.contains\(target\)\)/);
  assert.match(app, /\(focusableElements\(dialog\)\[0\] \|\| dialog\)\.focus\(\)/);
  assert.match(app, /target !== document\.body/);
  assert.match(app, /document\.addEventListener\('click', trackOutsideActivation, true\)/);
  assert.match(app, /const restoreTarget = opener\?\.isConnected/);
  assert.match(app, /event\.key === 'Escape'/);
  assert.match(app, /document\.querySelector<HTMLElement>\('\.app-window'\)\?\.removeAttribute\('inert'\)/);
  const packagedGate = await readFile(path.join(projectRoot, 'scripts', 'verify-packaged-accessibility.mjs'), 'utf8');
  assert.match(packagedGate, /dialogs\.length \+ additionalDialogs\.length \+ 4, 14/);
  for (const label of ['Markdown 编辑器', '版本历史', '从 3 篇资料开始创作', '导出资料包', '社交连接器', '本地运行日志']) {
    assert.match(packagedGate, new RegExp(label));
  }
});

test('editor and highlights keep their declared keyboard and announcement contract', async () => {
  const app = await readFile(path.join(projectRoot, 'src', 'web', 'App.tsx'), 'utf8');
  const styles = await readFile(path.join(projectRoot, 'src', 'web', 'styles.css'), 'utf8');

  assert.match(app, /handleEditorKeyDown/);
  assert.match(app, /event\.key\.toLowerCase\(\) !== 's'/);
  assert.match(app, /ariaLabel="上传文章图片"/);
  assert.match(app, /aria-labelledby="editor-source-title"/);
  assert.match(app, /aria-labelledby="editor-preview-title"/);
  assert.match(app, /role="status" aria-live="polite"/);
  assert.match(app, /aria-describedby="selection-popover-quote"/);
  assert.match(app, /handleSelectionEscape/);
  assert.match(app, /document\.addEventListener\('keydown', handleSelectionEscape, true\)/);
  assert.match(app, /startKeyboardSelection/);
  assert.match(app, /selection\.modify\(event\.shiftKey \? 'extend' : 'move'/);
  assert.match(app, /!\(event\.ctrlKey && event\.altKey\)/);
  assert.match(app, /reader-keyboard-caret/);
  assert.doesNotMatch(app, /contentEditable=\{keyboardSelectionMode\}/);
  assert.match(app, /按住 Shift 并配合方向键选择/);
  assert.match(app, /aria-pressed=/);
  assert.match(app, /role=\{keyboardSelectionMode \? 'document' : 'region'\}/);
  assert.match(app, /tabIndex=\{-1\} aria-label="高亮与批注"/);
  assert.match(styles, /\.editor-image-upload:focus-visible/);
  assert.match(styles, /\.article-body\.keyboard-selecting/);
  assert.match(styles, /\.annotations:focus-visible/);
});

test('file imports use visible keyboard buttons without exposing desktop paths', async () => {
  const app = await readFile(path.join(projectRoot, 'src', 'web', 'App.tsx'), 'utf8');
  const styles = await readFile(path.join(projectRoot, 'src', 'web', 'styles.css'), 'utf8');
  const preload = await readFile(path.join(projectRoot, 'desktop', 'preload.cjs'), 'utf8');

  assert.equal((app.match(/<FilePickerButton/g) || []).length, 5);
  assert.match(app, /inputRef\.current\?\.click\(\)/);
  assert.match(app, /className="native-file-input" type="file" hidden/);
  assert.match(app, /if \(files\.length\) onFiles\(files\);\s+event\.currentTarget\.value = '';/);
  for (const label of ['上传文章图片', '选择 PDF、图片、视频或文本', '选择 Reader Markdown ZIP', '导入 OPML 文件', '选择 Reader 备份']) {
    assert.match(app, new RegExp(label));
  }
  assert.doesNotMatch(app, /<label className="(?:file-drop|editor-image-upload|source-import|restore-file)"/);
  assert.match(styles, /\.file-drop:focus-visible/);
  assert.match(styles, /\.source-import:focus-visible/);
  assert.match(styles, /\.restore-file:focus-visible/);
  assert.doesNotMatch(preload, /showOpenDialog|readFile|filePath/);
  assert.match(preload, /onAddRequest\(callback\)/);
  assert.match(preload, /ipcRenderer\.on\('reader:add-request'/);
  assert.match(preload, /'import-queue'/);
  assert.match(app, /api\.updateNotificationSettings/);
  assert.match(app, /默认关闭；只显示成功\/失败数量/);
  assert.match(app, /command === 'import-queue'/);
});
