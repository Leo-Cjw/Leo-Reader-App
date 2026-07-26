const { contextBridge, ipcRenderer } = require('electron');

const allowedCommands = new Set(['new', 'search', 'edit', 'settings', 'import-queue', 'sources', 'data-safety', 'toggle-ai']);
const pendingAddRequests = [];
const addRequestListeners = new Set();
const validArticleId = (value) => typeof value === 'string' && Boolean(value) && value.length <= 200 && !/[\u0000-\u001f\u007f]/.test(value);
const normalizeAddRequest = (value) => {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return null;
  if (value.kind === 'url'
    && Object.keys(value).length === 2
    && typeof value.url === 'string'
    && value.url.length <= 2048
    && /^https?:\/\//i.test(value.url)) return Object.freeze({ kind: 'url', url: value.url });
  if (value.kind === 'text'
    && Object.keys(value).length === 2
    && typeof value.text === 'string'
    && Boolean(value.text.trim())
    && Buffer.byteLength(value.text, 'utf8') <= 4096
    && !/[\u0000-\u0008\u000b\u000c\u000e-\u001f\u007f-\u009f]/.test(value.text)) {
    return Object.freeze({ kind: 'text', text: value.text });
  }
  return null;
};

ipcRenderer.on('reader:add-request', (_event, value) => {
  const request = normalizeAddRequest(value);
  if (!request) return;
  if (!addRequestListeners.size) {
    if (pendingAddRequests.length < 20) pendingAddRequests.push(request);
    return;
  }
  for (const callback of addRequestListeners) callback(request);
});

contextBridge.exposeInMainWorld('readerDesktop', Object.freeze({
  platform: process.platform,
  onCommand(callback) {
    if (typeof callback !== 'function') return () => {};
    const handler = (_event, command) => {
      if (allowedCommands.has(command)) callback(command);
    };
    ipcRenderer.on('reader:command', handler);
    return () => ipcRenderer.removeListener('reader:command', handler);
  },
  onAddRequest(callback) {
    if (typeof callback !== 'function') return () => {};
    addRequestListeners.add(callback);
    for (const request of pendingAddRequests.splice(0)) callback(request);
    return () => addRequestListeners.delete(callback);
  },
  openArticleWindow(articleId) {
    if (!validArticleId(articleId)) return Promise.resolve(false);
    return ipcRenderer.invoke('reader:open-article-window', articleId).then(Boolean);
  },
  focusLibrary() {
    return ipcRenderer.invoke('reader:focus-library').then(Boolean);
  }
}));
