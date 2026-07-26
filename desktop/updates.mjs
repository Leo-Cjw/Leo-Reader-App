import { execFile } from 'node:child_process';
import path from 'node:path';

const UPDATE_OWNER = 'Leo-Cjw';
const UPDATE_REPOSITORY = 'Leo-Reader-App';
const INITIAL_CHECK_DELAY_MS = 60_000;
const CHECK_INTERVAL_MS = 6 * 60 * 60 * 1000;

export function isDeveloperIDSignature(output) {
  const text = String(output || '');
  return /Authority=Developer ID Application:/.test(text)
    && /TeamIdentifier=(?!not set\b)[A-Z0-9]+/.test(text);
}

export function inspectDeveloperIDSignature(appPath, execFileImpl = execFile) {
  return new Promise((resolve) => {
    const options = { timeout: 10_000, maxBuffer: 256 * 1024 };
    execFileImpl('/usr/bin/codesign', ['--verify', '--deep', '--strict', '--verbose=4', appPath], options, (verifyError) => {
      if (verifyError) {
        resolve(false);
        return;
      }
      execFileImpl('/usr/bin/codesign', ['--display', '--verbose=4', appPath], options, (error, stdout, stderr) => {
        resolve(!error && isDeveloperIDSignature(`${stdout || ''}\n${stderr || ''}`));
      });
    });
  });
}

export function readerUpdateFeed(version) {
  return `https://update.electronjs.org/${UPDATE_OWNER}/${UPDATE_REPOSITORY}/darwin-universal/${encodeURIComponent(version)}`;
}

export function macAppPath(executablePath) {
  return path.resolve(path.dirname(executablePath), '../..');
}

export function createUpdateController({
  app,
  autoUpdater,
  dialog,
  getWindow,
  beforeInstall = async () => {},
  platform = process.platform,
  inspectSignature = inspectDeveloperIDSignature,
  setTimeoutImpl = setTimeout,
  clearTimeoutImpl = clearTimeout,
  setIntervalImpl = setInterval,
  clearIntervalImpl = clearInterval
}) {
  let eligible = false;
  let checking = false;
  let interactiveCheck = false;
  let downloadedRelease = '';
  let installPrompt = null;
  let installStarted = false;
  let initialTimer = null;
  let intervalTimer = null;
  let listenersInstalled = false;

  function showMessage(options) {
    const window = getWindow();
    return window && !window.isDestroyed() ? dialog.showMessageBox(window, options) : dialog.showMessageBox(options);
  }

  function promptToInstall(releaseName = downloadedRelease || '新版本') {
    if (installPrompt) return installPrompt;
    if (installStarted) return Promise.resolve(true);
    installPrompt = (async () => {
      const result = await showMessage({
        type: 'info',
        buttons: ['重启并安装', '稍后'],
        defaultId: 0,
        cancelId: 1,
        title: 'Reader 更新已就绪',
        message: `${releaseName} 已安全下载`,
        detail: '重启 Reader 后安装更新。资料库仍保存在原来的本机目录中。'
      });
      if (result.response !== 0) return false;
      let cleanupCompleted = false;
      try {
        installStarted = true;
        await beforeInstall();
        cleanupCompleted = true;
        autoUpdater.quitAndInstall();
        return true;
      } catch {
        if (cleanupCompleted) {
          console.warn('Reader 更新安装启动失败；正在安全退出');
          app.quit();
          return false;
        }
        installStarted = false;
        console.warn('Reader 无法安全停止以安装更新');
        await showMessage({
          type: 'warning',
          buttons: ['好'],
          title: '暂时无法安装更新',
          message: 'Reader 无法安全停止后台任务，请退出应用后重新打开再试。'
        });
        return false;
      }
    })().finally(() => { installPrompt = null; });
    return installPrompt;
  }

  const onChecking = () => { checking = true; };
  const onUpdateAvailable = () => {
    if (!interactiveCheck) return;
    void showMessage({
      type: 'info',
      buttons: ['好'],
      title: '发现 Reader 更新',
      message: 'Reader 新版本正在下载',
      detail: '下载完成后 Reader 会再次提示，不会自动中断当前工作。'
    });
  };
  const onUpdateNotAvailable = () => {
    checking = false;
    if (interactiveCheck) {
      void showMessage({
        type: 'info',
        buttons: ['好'],
        title: 'Reader 已是最新版本',
        message: `当前版本 ${app.getVersion()} 已是最新版本`
      });
    }
    interactiveCheck = false;
  };
  const onError = () => {
    checking = false;
    console.warn('Reader 自动更新检查失败');
    if (interactiveCheck) {
      void showMessage({
        type: 'warning',
        buttons: ['好'],
        title: '暂时无法检查更新',
        message: 'Reader 无法连接更新服务，请稍后重试。'
      });
    }
    interactiveCheck = false;
  };
  const onUpdateDownloaded = (_event, releaseNotes, releaseName) => {
    checking = false;
    interactiveCheck = false;
    downloadedRelease = releaseName || '新版本';
    void promptToInstall(downloadedRelease);
  };

  function installListeners() {
    if (listenersInstalled) return;
    listenersInstalled = true;
    autoUpdater.on('checking-for-update', onChecking);
    autoUpdater.on('update-available', onUpdateAvailable);
    autoUpdater.on('update-not-available', onUpdateNotAvailable);
    autoUpdater.on('error', onError);
    autoUpdater.on('update-downloaded', onUpdateDownloaded);
  }

  async function check(interactive = true) {
    if (!eligible) {
      if (interactive) {
        await showMessage({
          type: 'info',
          buttons: ['好'],
          title: '自动更新尚未启用',
          message: '当前 Reader 包未使用 Apple Developer ID 正式签名。',
          detail: '为避免安装无法验证的代码，只有正式签名发行包才会连接更新服务。'
        });
      }
      return false;
    }
    if (downloadedRelease) {
      if (interactive) await promptToInstall(downloadedRelease);
      return true;
    }
    if (checking) {
      if (interactive) {
        await showMessage({
          type: 'info',
          buttons: ['好'],
          title: '正在检查更新',
          message: 'Reader 正在检查或下载新版本。'
        });
      }
      return true;
    }
    interactiveCheck = interactive;
    checking = true;
    try {
      autoUpdater.checkForUpdates();
      return true;
    } catch {
      onError();
      return false;
    }
  }

  async function start() {
    if (!app.isPackaged || platform !== 'darwin') return false;
    eligible = await inspectSignature(macAppPath(app.getPath('exe')));
    if (!eligible) return false;
    installListeners();
    try {
      autoUpdater.setFeedURL({ url: readerUpdateFeed(app.getVersion()) });
      initialTimer = setTimeoutImpl(() => { void check(false); }, INITIAL_CHECK_DELAY_MS);
      intervalTimer = setIntervalImpl(() => { void check(false); }, CHECK_INTERVAL_MS);
      initialTimer?.unref?.();
      intervalTimer?.unref?.();
      return true;
    } catch {
      console.warn('Reader 自动更新初始化失败');
      stop();
      eligible = false;
      return false;
    }
  }

  function stop() {
    if (initialTimer) clearTimeoutImpl(initialTimer);
    if (intervalTimer) clearIntervalImpl(intervalTimer);
    initialTimer = null;
    intervalTimer = null;
    if (!listenersInstalled) return;
    autoUpdater.off('checking-for-update', onChecking);
    autoUpdater.off('update-available', onUpdateAvailable);
    autoUpdater.off('update-not-available', onUpdateNotAvailable);
    autoUpdater.off('error', onError);
    autoUpdater.off('update-downloaded', onUpdateDownloaded);
    listenersInstalled = false;
  }

  return { start, stop, check, isEligible: () => eligible };
}
