import path from 'node:path';
import { app, BrowserWindow, dialog, Menu, net, powerMonitor, session, shell } from 'electron';
import { createReaderServer } from '../src/server/server.mjs';
import { DESKTOP_COMMANDS, isAllowedAppURL, isSafeExternalURL, resolveDesktopDataRoot } from './security.mjs';
import { createDesktopBackgroundCoordinator } from './background-state.mjs';

app.enableSandbox();
app.setName('Reader');

const lockAcquired = app.requestSingleInstanceLock();
if (!lockAcquired) app.quit();

let mainWindow = null;
let readerServer = null;
let backgroundCoordinator = null;
let appOrigin = '';
let shutdownStarted = false;

function sendCommand(command) {
  if (!DESKTOP_COMMANDS.has(command) || !mainWindow || mainWindow.isDestroyed()) return;
  mainWindow.webContents.send('reader:command', command);
}

function installMenu() {
  const template = [
    {
      label: 'Reader',
      submenu: [
        { role: 'about' },
        { type: 'separator' },
        { label: '设置…', accelerator: 'CommandOrControl+,', click: () => sendCommand('settings') },
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
  window.once('ready-to-show', () => window.show());
  window.on('closed', () => {
    if (mainWindow === window) mainWindow = null;
  });
  await window.loadURL(`${appOrigin}/?desktop=1`);
}

async function startReader() {
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
  appOrigin = `http://127.0.0.1:${address.port}`;
  installMenu();
  configureSession();
  await createWindow();
}

if (lockAcquired) {
  app.on('second-instance', () => {
    if (!mainWindow) {
      void createWindow();
      return;
    }
    if (mainWindow.isMinimized()) mainWindow.restore();
    mainWindow.show();
    mainWindow.focus();
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
    backgroundCoordinator?.stop();
    backgroundCoordinator = null;
    readerServer.close()
      .catch((error) => console.error('Reader shutdown failed', error))
      .finally(() => {
        readerServer = null;
        app.quit();
      });
  });
}
