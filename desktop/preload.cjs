const { contextBridge, ipcRenderer } = require('electron');

const allowedCommands = new Set(['new', 'search', 'edit', 'settings', 'import-queue', 'sources', 'data-safety', 'toggle-ai']);
const pendingAddRequests = [];
const addRequestListeners = new Set();
const validArticleId = (value) => typeof value === 'string' && Boolean(value) && value.length <= 200 && !/[\u0000-\u001f\u007f]/.test(value);
const validSharedFileToken = (value) => typeof value === 'string' && /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/.test(value);
const validCollectionId = (value) => typeof value === 'string' && Boolean(value) && value.length <= 200 && !/[\u0000-\u001f\u007f]/.test(value);
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
  if (value.kind === 'file'
    && Object.keys(value).length === 2
    && validSharedFileToken(value.token)) return Object.freeze({ kind: 'file', token: value.token });
  return null;
};
const normalizeSharedFileInfo = (value) => {
  if (!value || typeof value !== 'object' || Array.isArray(value)
    || Object.keys(value).sort().join(',') !== 'mimeType,name,size,token'
    || !validSharedFileToken(value.token)
    || typeof value.name !== 'string'
    || !value.name
    || value.name.length > 180
    || /[\u0000-\u001f\u007f/\\]/.test(value.name)
    || !Number.isSafeInteger(value.size)
    || value.size <= 0
    || value.size > 100 * 1024 * 1024
    || typeof value.mimeType !== 'string'
    || !value.mimeType
    || value.mimeType.length > 100) return null;
  return Object.freeze({ token: value.token, name: value.name, size: value.size, mimeType: value.mimeType });
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
  },
  inspectSharedFile(token) {
    if (!validSharedFileToken(token)) return Promise.resolve(null);
    return ipcRenderer.invoke('reader:inspect-shared-file', token).then(normalizeSharedFileInfo);
  },
  importSharedFile(token, collectionId) {
    if (!validSharedFileToken(token) || !validCollectionId(collectionId)) return Promise.reject(new Error('分享文件参数无效'));
    return ipcRenderer.invoke('reader:import-shared-file', token, collectionId);
  },
  discardSharedFile(token) {
    if (!validSharedFileToken(token)) return Promise.resolve(false);
    return ipcRenderer.invoke('reader:discard-shared-file', token).then(Boolean);
  }
}));
