const { contextBridge, ipcRenderer } = require('electron');

const allowedCommands = new Set(['new', 'search', 'edit', 'settings', 'import-queue', 'data-safety', 'toggle-ai']);
const pendingAddURLs = [];
const addURLListeners = new Set();

ipcRenderer.on('reader:add-url', (_event, url) => {
  if (typeof url !== 'string' || url.length > 2048 || !/^https?:\/\//i.test(url)) return;
  if (!addURLListeners.size) {
    if (pendingAddURLs.length < 20) pendingAddURLs.push(url);
    return;
  }
  for (const callback of addURLListeners) callback(url);
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
  onAddURL(callback) {
    if (typeof callback !== 'function') return () => {};
    addURLListeners.add(callback);
    for (const url of pendingAddURLs.splice(0)) callback(url);
    return () => addURLListeners.delete(callback);
  }
}));
