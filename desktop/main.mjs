import path from 'node:path';
import { app, autoUpdater, BrowserWindow, dialog, Menu, net, powerMonitor, session, shell } from 'electron';
import { createReaderServer } from '../src/server/server.mjs';
import { DESKTOP_COMMANDS, extractReaderDeepLink, isAllowedAppURL, isSafeExternalURL, parseReaderDeepLink, READER_PROTOCOL_SCHEME, resolveDesktopDataRoot } from './security.mjs';
import { createDesktopBackgroundCoordinator } from './background-state.mjs';
import { createRendererRecoveryController } from './renderer-recovery.mjs';
import { createUpdateController } from './updates.mjs';

app.enableSandbox();
app.setName('Reader');

const lockAcquired = app.requestSingleInstanceLock();
if (!lockAcquired) app.quit();

let mainWindow = null;
let readerServer = null;
let backgroundCoordinator = null;
let updateController = null;
let appOrigin = '';
let shutdownStarted = false;
let rendererReady = false;
const pendingAddURLs = [];
const rendererRecoveryController = createRendererRecoveryController({
  app,
  dialog,
  getWindow: () => mainWindow,
  isShuttingDown: () => shutdownStarted,
  recordDiagnostic: (event, details) => readerServer?.diagnostics.record(event, details)
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

function flushPendingAddURLs() {
  if (!rendererReady || !mainWindow || mainWindow.isDestroyed()) return;
  for (const url of pendingAddURLs.splice(0)) mainWindow.webContents.send('reader:add-url', url);
}

function queueAddURL(url) {
  if (!pendingAddURLs.includes(url) && pendingAddURLs.length < 20) pendingAddURLs.push(url);
  flushPendingAddURLs();
}

function handleDeepLink(candidate) {
  const url = parseReaderDeepLink(candidate);
  if (!url) return false;
  queueAddURL(url);
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

async function createWindow() {
  rendererReady = false;
  let initialLoadCompleted = false;
  const window = new BrowserWindow({
    width: 1440,
    height: 900,
    minWidth: 1080,
    minHeight: 680,
    show: false,
    backgroundColor: '#f8f7f3',
    title: 'Reader',
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
  });
  mainWindow = window;
  configureNavigation(window);
  window.webContents.on('did-finish-load', () => {
    initialLoadCompleted = true;
    if (mainWindow !== window || window.isDestroyed()) return;
    rendererReady = true;
    flushPendingAddURLs();
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
  if (app.isPackaged) app.setAsDefaultProtocolClient(READER_PROTOCOL_SCHEME);
  const dataRoot = resolveDesktopDataRoot(app.getPath('userData'), process.env.READER_DESKTOP_DATA_ROOT || '');
  readerServer = await createReaderServer({
    rootDir: dataRoot,
    webRoot: path.join(app.getAppPath(), 'dist'),
    dbPath: path.join(dataRoot, 'data', 'reader.sqlite3'),
    host: '127.0.0.1',
    port: 0
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
  installMenu();
  configureSession();
  await createWindow();
}

if (lockAcquired) {
  const initialAddURL = extractReaderDeepLink(process.argv);
  if (initialAddURL) queueAddURL(initialAddURL);

  app.on('open-url', (event, url) => {
    event.preventDefault();
    handleDeepLink(url);
  });

  app.on('second-instance', (_event, commandLine) => {
    const addURL = extractReaderDeepLink(commandLine);
    if (addURL) queueAddURL(addURL);
    if (!mainWindow) {
      if (appOrigin) void createWindow();
      return;
    }
    focusMainWindow();
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
