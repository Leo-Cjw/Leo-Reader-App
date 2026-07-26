import path from 'node:path';
import { app, autoUpdater, BrowserWindow, dialog, ipcMain, Menu, net, Notification, powerMonitor, session, shell } from 'electron';
import { createReaderServer } from '../src/server/server.mjs';
import { DESKTOP_COMMANDS, extractReaderAddDeepLink, extractReaderOpenDeepLink, isAllowedAppURL, isSafeExternalURL, normalizeArticleWindowId, parseReaderAddDeepLink, parseReaderOpenDeepLink, READER_PROTOCOL_SCHEME, resolveDesktopDataRoot } from './security.mjs';
import { createDesktopBackgroundCoordinator } from './background-state.mjs';
import { createRendererRecoveryController } from './renderer-recovery.mjs';
import { createImportNotificationController, createSourceSyncNotificationController } from './notifications.mjs';
import { createSharedFileManager, standardShareStagingRoot } from './shared-files.mjs';
import { createUpdateController } from './updates.mjs';

app.enableSandbox();
app.setName('Reader');

const lockAcquired = app.requestSingleInstanceLock();
if (!lockAcquired) app.quit();

let mainWindow = null;
let readerServer = null;
let backgroundCoordinator = null;
let updateController = null;
let sharedFileManager = null;
let appOrigin = '';
let shutdownStarted = false;
let rendererReady = false;
const pendingAddRequests = [];
const pendingArticleIDs = [];
const articleWindows = new Map();
const rendererRecoveryController = createRendererRecoveryController({
  app,
  dialog,
  getWindow: () => mainWindow,
  isShuttingDown: () => shutdownStarted,
  recordDiagnostic: (event, details) => readerServer?.diagnostics.record(event, details)
});
const importNotificationController = createImportNotificationController({
  Notification,
  shouldNotify: () => !shutdownStarted && !BrowserWindow.getAllWindows().some((window) => !window.isDestroyed() && window.isFocused()),
  onClick: () => { void openImportQueue().catch(() => {}); }
});
const sourceSyncNotificationController = createSourceSyncNotificationController({
  Notification,
  shouldNotify: () => !shutdownStarted && !BrowserWindow.getAllWindows().some((window) => !window.isDestroyed() && window.isFocused()),
  onClick: () => { void openSources().catch(() => {}); }
});

async function closeReader() {
  backgroundCoordinator?.stop();
  backgroundCoordinator = null;
  const server = readerServer;
  if (server) await server.close();
  if (readerServer === server) readerServer = null;
  updateController?.stop();
  updateController = null;
}

function sendCommand(command) {
  if (!DESKTOP_COMMANDS.has(command) || !mainWindow || mainWindow.isDestroyed()) return;
  mainWindow.webContents.send('reader:command', command);
}

function focusMainWindow() {
  if (!mainWindow || mainWindow.isDestroyed()) return;
  if (mainWindow.isMinimized()) mainWindow.restore();
  mainWindow.show();
  mainWindow.focus();
}

async function openImportQueue() {
  if ((!mainWindow || mainWindow.isDestroyed()) && appOrigin) await createWindow();
  focusMainWindow();
  sendCommand('import-queue');
}

async function openSources() {
  if ((!mainWindow || mainWindow.isDestroyed()) && appOrigin) await createWindow();
  focusMainWindow();
  sendCommand('sources');
}

function flushPendingAddRequests() {
  if (!rendererReady || !mainWindow || mainWindow.isDestroyed()) return;
  for (const request of pendingAddRequests.splice(0)) mainWindow.webContents.send('reader:add-request', request);
}

function queueAddRequest(request) {
  if (!request || pendingAddRequests.length >= 20) return;
  const duplicate = pendingAddRequests.some((item) => item.kind === request.kind
    && (item.kind === 'url' ? item.url === request.url : item.kind === 'text' ? item.text === request.text : item.token === request.token));
  if (!duplicate) pendingAddRequests.push(request);
  flushPendingAddRequests();
}

async function flushPendingArticleIDs() {
  if (!readerServer || !appOrigin) return;
  for (const articleID of pendingArticleIDs.splice(0)) {
    try {
      if (await readerServer.database.getArticle(articleID)) await createArticleWindow(articleID);
    } catch {
      // Invalid or temporarily unavailable Spotlight handoffs never block Reader startup.
    }
  }
}

function queueArticleOpen(articleID) {
  if (!pendingArticleIDs.includes(articleID) && pendingArticleIDs.length < 20) pendingArticleIDs.push(articleID);
  void flushPendingArticleIDs().catch(() => {});
}

function handleDeepLink(candidate) {
  const articleID = parseReaderOpenDeepLink(candidate);
  if (articleID) {
    queueArticleOpen(articleID);
    return true;
  }
  const request = parseReaderAddDeepLink(candidate);
  if (!request) return false;
  queueAddRequest(request);
  focusMainWindow();
  return true;
}

function installMenu() {
  const template = [
    {
      label: 'Reader',
      submenu: [
        { role: 'about' },
        { type: 'separator' },
        { label: '设置…', accelerator: 'CommandOrControl+,', click: () => sendCommand('settings') },
        { label: '检查更新…', click: () => { void updateController?.check(true); } },
        { type: 'separator' },
        { role: 'services' },
        { type: 'separator' },
        { role: 'hide' },
        { role: 'hideOthers' },
        { role: 'unhide' },
        { type: 'separator' },
        { role: 'quit' }
      ]
    },
    {
      label: '文件',
      submenu: [
        { label: '添加内容…', accelerator: 'CommandOrControl+N', click: () => sendCommand('new') },
        { label: '数据安全中心…', accelerator: 'CommandOrControl+Shift+B', click: () => sendCommand('data-safety') },
        { type: 'separator' },
        { role: 'close' }
      ]
    },
    {
      label: '编辑',
      submenu: [
        { role: 'undo' },
        { role: 'redo' },
        { type: 'separator' },
        { role: 'cut' },
        { role: 'copy' },
        { role: 'paste' },
        { role: 'selectAll' },
        { type: 'separator' },
        { label: '搜索资料库', accelerator: 'CommandOrControl+K', click: () => sendCommand('search') },
        { label: '编辑当前内容', accelerator: 'CommandOrControl+E', click: () => sendCommand('edit') }
      ]
    },
    {
      label: '显示',
      submenu: [
        { label: '显示/隐藏文章助手', accelerator: 'CommandOrControl+Shift+A', click: () => sendCommand('toggle-ai') },
        { type: 'separator' },
        { role: 'resetZoom' },
        { role: 'zoomIn' },
        { role: 'zoomOut' },
        { type: 'separator' },
        { role: 'togglefullscreen' },
        ...(!app.isPackaged ? [{ type: 'separator' }, { role: 'toggleDevTools' }] : [])
      ]
    },
    { role: 'windowMenu' },
    { role: 'help', submenu: [] }
  ];
  Menu.setApplicationMenu(Menu.buildFromTemplate(template));
}

function configureSession() {
  const currentSession = session.defaultSession;
  currentSession.setPermissionCheckHandler(() => false);
  currentSession.setPermissionRequestHandler((_webContents, _permission, callback) => callback(false));
  currentSession.on('will-download', (event, item) => {
    const sourceURL = item.getURL();
    if (!isAllowedAppURL(sourceURL, appOrigin) && !sourceURL.startsWith(`blob:${appOrigin}`)) {
      event.preventDefault();
      return;
    }
    const savePath = dialog.showSaveDialogSync(mainWindow || undefined, { defaultPath: item.getFilename() });
    if (!savePath) {
      event.preventDefault();
      return;
    }
    item.setSavePath(savePath);
  });
}

function configureNavigation(window) {
  window.webContents.setWindowOpenHandler(({ url }) => {
    if (isSafeExternalURL(url)) void shell.openExternal(url);
    return { action: 'deny' };
  });
  window.webContents.on('will-navigate', (event, url) => {
    if (isAllowedAppURL(url, appOrigin)) return;
    event.preventDefault();
    if (isSafeExternalURL(url)) void shell.openExternal(url);
  });
  window.webContents.on('will-attach-webview', (event) => event.preventDefault());
}

function desktopWindowOptions({ focusedReader = false } = {}) {
  return {
    width: focusedReader ? 920 : 1440,
    height: focusedReader ? 860 : 900,
    minWidth: focusedReader ? 640 : 1080,
    minHeight: focusedReader ? 520 : 680,
    show: false,
    backgroundColor: '#f8f7f3',
    title: focusedReader ? '专注阅读 — Reader' : 'Reader',
    titleBarStyle: process.platform === 'darwin' ? 'hiddenInset' : 'default',
    trafficLightPosition: process.platform === 'darwin' ? { x: 18, y: 17 } : undefined,
    webPreferences: {
      preload: path.join(app.getAppPath(), 'desktop', 'preload.cjs'),
      nodeIntegration: false,
      contextIsolation: true,
      sandbox: true,
      webSecurity: true,
      allowRunningInsecureContent: false,
      devTools: !app.isPackaged
    }
  };
}

async function createArticleWindow(articleId) {
  const existing = articleWindows.get(articleId);
  if (existing && !existing.isDestroyed()) {
    if (existing.isMinimized()) existing.restore();
    existing.show();
    existing.focus();
    return existing;
  }
  const window = new BrowserWindow(desktopWindowOptions({ focusedReader: true }));
  articleWindows.set(articleId, window);
  configureNavigation(window);
  window.on('closed', () => {
    if (articleWindows.get(articleId) === window) articleWindows.delete(articleId);
  });
  const params = new URLSearchParams({ desktop: '1', readerWindow: '1', article: articleId });
  try {
    await window.loadURL(`${appOrigin}/?${params}`);
    if (!window.isDestroyed()) window.show();
  } catch (error) {
    if (!window.isDestroyed()) window.destroy();
    throw error;
  }
  return window;
}

function installIPCHandlers() {
  const isTrustedSender = (event) => isAllowedAppURL(event.senderFrame?.url || event.sender.getURL(), appOrigin);
  ipcMain.handle('reader:open-article-window', async (event, candidate) => {
    if (!isTrustedSender(event)) return false;
    const articleId = normalizeArticleWindowId(candidate);
    if (!articleId || !(await readerServer?.database.getArticle(articleId))) return false;
    await createArticleWindow(articleId);
    return true;
  });
  ipcMain.handle('reader:focus-library', async (event) => {
    if (!isTrustedSender(event)) return false;
    if ((!mainWindow || mainWindow.isDestroyed()) && appOrigin) await createWindow();
    focusMainWindow();
    return Boolean(mainWindow && !mainWindow.isDestroyed());
  });
  ipcMain.handle('reader:inspect-shared-file', async (event, token) => {
    if (!isTrustedSender(event) || !sharedFileManager) return null;
    return await sharedFileManager.inspect(token);
  });
  ipcMain.handle('reader:import-shared-file', async (event, token, collectionId) => {
    if (!isTrustedSender(event) || !sharedFileManager) throw new Error('分享文件不可用');
    return await sharedFileManager.upload(token, collectionId);
  });
  ipcMain.handle('reader:discard-shared-file', async (event, token) => {
    if (!isTrustedSender(event) || !sharedFileManager) return false;
    return await sharedFileManager.discard(token);
  });
}

async function createWindow() {
  rendererReady = false;
  let initialLoadCompleted = false;
  const window = new BrowserWindow(desktopWindowOptions());
  mainWindow = window;
  configureNavigation(window);
  window.webContents.on('did-finish-load', () => {
    initialLoadCompleted = true;
    if (mainWindow !== window || window.isDestroyed()) return;
    rendererReady = true;
    flushPendingAddRequests();
  });
  window.webContents.on('render-process-gone', (_event, details) => {
    if (!initialLoadCompleted || mainWindow !== window) return;
    rendererReady = false;
    void rendererRecoveryController.handle(window, details);
  });
  window.on('closed', () => {
    if (mainWindow === window) {
      mainWindow = null;
      rendererReady = false;
    }
  });
  await window.loadURL(`${appOrigin}/?desktop=1`);
  if (!window.isDestroyed()) {
    window.show();
  }
}

async function startReader() {
  if (app.isPackaged && process.env.READER_RELEASE_QA !== '1') app.setAsDefaultProtocolClient(READER_PROTOCOL_SCHEME);
  const dataRoot = resolveDesktopDataRoot(app.getPath('userData'), process.env.READER_DESKTOP_DATA_ROOT || '');
  readerServer = await createReaderServer({
    rootDir: dataRoot,
    webRoot: path.join(app.getAppPath(), 'dist'),
    dbPath: path.join(dataRoot, 'data', 'reader.sqlite3'),
    host: '127.0.0.1',
    port: 0,
    spotlightHelperPath: app.isPackaged
      ? path.join(process.resourcesPath, 'Reader Spotlight Helper.app', 'Contents', 'MacOS', 'Reader Spotlight Helper')
      : '',
    onImportBatchFinished: (summary) => importNotificationController.show(summary),
    onSourceSyncBatchFinished: (summary) => sourceSyncNotificationController.show(summary)
  });
  const address = await readerServer.listen();
  backgroundCoordinator = createDesktopBackgroundCoordinator({ powerMonitor, net, server: readerServer });
  await backgroundCoordinator.start();
  updateController = createUpdateController({
    app,
    autoUpdater,
    dialog,
    getWindow: () => mainWindow,
    beforeInstall: async () => {
      shutdownStarted = true;
      try {
        await closeReader();
      } catch (error) {
        shutdownStarted = false;
        throw error;
      }
    }
  });
  await updateController.start();
  appOrigin = `http://127.0.0.1:${address.port}`;
  const qaShareRoot = process.env.READER_RELEASE_QA === '1' && path.isAbsolute(process.env.READER_SHARE_STAGING_ROOT || '')
    ? path.resolve(process.env.READER_SHARE_STAGING_ROOT)
    : '';
  sharedFileManager = createSharedFileManager({
    stagingRoot: qaShareRoot || standardShareStagingRoot(app.getPath('home')),
    appOrigin
  });
  await sharedFileManager.cleanupExpired();
  installMenu();
  configureSession();
  installIPCHandlers();
  await createWindow();
  await flushPendingArticleIDs();
}

if (lockAcquired) {
  const initialAddRequest = extractReaderAddDeepLink(process.argv);
  if (initialAddRequest) queueAddRequest(initialAddRequest);
  const initialArticleID = extractReaderOpenDeepLink(process.argv);
  if (initialArticleID) queueArticleOpen(initialArticleID);

  app.on('open-url', (event, url) => {
    event.preventDefault();
    handleDeepLink(url);
  });

  app.on('second-instance', (_event, commandLine) => {
    const articleID = extractReaderOpenDeepLink(commandLine);
    if (articleID) queueArticleOpen(articleID);
    const addRequest = extractReaderAddDeepLink(commandLine);
    if (addRequest) queueAddRequest(addRequest);
    if (!mainWindow) {
      if (appOrigin) void createWindow();
      return;
    }
    focusMainWindow();
  });

  app.on('continue-activity', (event, type, userInfo) => {
    if (type !== 'com.apple.corespotlightitem') return;
    const identifier = typeof userInfo?.kCSSearchableItemActivityIdentifier === 'string'
      ? userInfo.kCSSearchableItemActivityIdentifier
      : '';
    const prefix = 'reader-article:';
    const articleID = identifier.startsWith(prefix) ? normalizeArticleWindowId(identifier.slice(prefix.length)) : null;
    if (!articleID) return;
    event.preventDefault();
    queueArticleOpen(articleID);
  });

  app.whenReady().then(startReader).catch((error) => {
    dialog.showErrorBox('Reader 无法启动', error instanceof Error ? error.message : String(error));
    app.exit(1);
  });

  app.on('activate', () => {
    if (!mainWindow && appOrigin) void createWindow();
  });

  app.on('window-all-closed', () => {
    if (process.platform !== 'darwin') app.quit();
  });

  app.on('before-quit', (event) => {
    if (!readerServer || shutdownStarted) return;
    event.preventDefault();
    shutdownStarted = true;
    closeReader()
      .catch((error) => console.error('Reader shutdown failed', error))
      .finally(() => {
        app.quit();
      });
  });
}
