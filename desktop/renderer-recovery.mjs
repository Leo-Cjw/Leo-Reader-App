const RENDERER_EXIT_REASONS = new Set([
  'clean-exit',
  'abnormal-exit',
  'killed',
  'crashed',
  'oom',
  'launch-failed',
  'integrity-failure',
  'memory-eviction'
]);

function rendererExitReason(value) {
  return RENDERER_EXIT_REASONS.has(value) ? value : 'unknown';
}

export function createRendererRecoveryController({
  app,
  dialog,
  getWindow,
  isShuttingDown,
  recordDiagnostic = () => false
}) {
  let promptPending = false;

  async function handle(window, details = {}) {
    if (promptPending || isShuttingDown() || !window || window.isDestroyed() || getWindow() !== window) return false;
    promptPending = true;
    void Promise.resolve(recordDiagnostic('renderer_gone', {
      reason: rendererExitReason(details.reason)
    })).catch(() => {});

    try {
      const result = await dialog.showMessageBox(window, {
        type: 'error',
        buttons: ['重新载入界面', '退出 Reader'],
        defaultId: 0,
        cancelId: 1,
        title: 'Reader',
        message: 'Reader 界面意外停止',
        detail: '已经写入的文章、附件和资料库仍安全保存在本机；尚未自动保存的界面输入可能丢失。重新载入只重建界面，本地服务和导入队列会继续运行。'
      });
      if (isShuttingDown() || window.isDestroyed() || getWindow() !== window) return false;
      if (result.response !== 0) {
        app.quit();
        return false;
      }
      window.webContents.reload();
      return true;
    } catch {
      app.quit();
      return false;
    } finally {
      promptPending = false;
    }
  }

  return { handle, isPromptPending: () => promptPending };
}
